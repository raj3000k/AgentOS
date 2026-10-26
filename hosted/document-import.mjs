export const IMPORT_LIMITS={pdfBytes:15*1024*1024,textBytes:120000,pages:60,characters:30000,timeoutMs:30000};
export function importKind(file){
 const name=file?.name||'';
 if(/\.pdf$/i.test(name)){if(!file.size||file.size>IMPORT_LIMITS.pdfBytes)throw new Error('Choose a PDF up to 15 MB.');return 'pdf';}
 if(!/\.(txt|md|markdown)$/i.test(name)||!file.size||file.size>IMPORT_LIMITS.textBytes)throw new Error('Choose PDF (up to 15 MB), text or Markdown (up to 120 KB).');return 'text';
}
export function validateText(text){if(typeof text!=='string'||!text.trim()||text.length>IMPORT_LIMITS.characters||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new Error('Import readable text up to 30,000 characters. Split larger documents into sections.');return text;}
export function pageText(items){let text='';for(const item of items){if(typeof item.str!=='string')continue;text+=item.str+(item.hasEOL?'\n':' ');}return text.replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();}
export async function extractPDF(data,pdfjs,{worker,onProgress=()=>{},signal,resources='/vendor/pdfjs/',timeoutMs=IMPORT_LIMITS.timeoutMs}={}){
 if(!(data instanceof Uint8Array)||!data.length||data.length>IMPORT_LIMITS.pdfBytes||!new TextDecoder().decode(data.subarray(0,1024)).includes('%PDF-'))throw new Error('This file is not a readable PDF.');
 if(signal?.aborted)throw new Error('Import cancelled.');
 let task,timer,abortHandler;
 const cancelled=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('PDF extraction took too long. Try a smaller PDF or paste its text.')),timeoutMs);abortHandler=()=>reject(new Error('Import cancelled.'));signal?.addEventListener('abort',abortHandler,{once:true});});
 try{
  const extraction=(async()=>{
   task=pdfjs.getDocument({data,worker,cMapUrl:resources+'cmaps/',cMapPacked:true,standardFontDataUrl:resources+'standard_fonts/',useWasm:false,enableXfa:false,disableFontFace:true,useSystemFonts:false,stopAtErrors:true,verbosity:0});
   const pdf=await task.promise;
   if(pdf.numPages>IMPORT_LIMITS.pages)throw new Error('PDFs may contain up to 60 pages. Split this document into sections.');
   const pages=[],emptyPages=[];let length=0;
   for(let number=1;number<=pdf.numPages;number++){
    if(signal?.aborted)throw new Error('Import cancelled.');
    onProgress(number,pdf.numPages);const page=await pdf.getPage(number);
    const content=await page.getTextContent(),text=pageText(content.items);page.cleanup();
    if(!text){emptyPages.push(number);continue;}
    const section=`[PDF page ${number}]\n${text}`;length+=section.length+(pages.length?2:0);
    if(length>IMPORT_LIMITS.characters)throw new Error('Extracted text exceeds 30,000 characters. Split the PDF into smaller sections; nothing was truncated.');
    pages.push(section);
   }
   if(!pages.length)throw new Error('No selectable text found. This PDF may be scanned or image-only and needs OCR.');
   return {text:validateText(pages.join('\n\n')),pages:pdf.numPages,emptyPages};
  })();
  return await Promise.race([extraction,cancelled]);
 }catch(error){if(error?.name==='PasswordException')throw new Error('This PDF is password-protected. Import an unlocked copy.');if(error?.name==='InvalidPDFException'||error?.name==='UnknownErrorException')throw new Error('This PDF could not be read. Try exporting a new PDF or paste its text.');throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abortHandler);if(task)Promise.resolve(task.destroy()).catch(()=>{});}
}
async function abortable(promise,signal){
 if(!signal)return promise;if(signal.aborted)throw new Error('Import cancelled.');let rejectAbort;
 const cancelled=new Promise((_,reject)=>{rejectAbort=()=>reject(new Error('Import cancelled.'));signal.addEventListener('abort',rejectAbort,{once:true});});
 try{return await Promise.race([promise,cancelled]);}finally{signal.removeEventListener('abort',rejectAbort);}
}
export async function importDocument(file,{onProgress,signal}={}){
 if(importKind(file)==='text')return {text:validateText(await abortable(file.text(),signal)),kind:'text'};
 const bytes=new Uint8Array(await abortable(file.arrayBuffer(),signal));if(signal?.aborted)throw new Error('Import cancelled.');
 // A fixed bundled parser and dedicated worker; no PDF scripts, forms or attachments run.
 const pdfjs=await abortable(import('/vendor/pdfjs/pdf.min.mjs'),signal);
 if(signal?.aborted)throw new Error('Import cancelled.');
 const port=new Worker('/vendor/pdfjs/pdf.worker.min.mjs',{type:'module'});let worker;
 try{worker=pdfjs.PDFWorker.create({port});return {...await extractPDF(bytes,pdfjs,{worker,onProgress,signal}),kind:'pdf'};}
 finally{worker?.destroy();port.terminate();}
}
