import {randomUUID} from 'node:crypto';
import {HTTPError} from './auth.mjs';
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stop=new Set('a an the is are was were be been to of in on at for with and or as by from it this that what which how does do please tell me about can you our your'.split(' '));
const words=text=>(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]).filter(w=>!stop.has(w));
const prefix=uid=>`users/${uid}/knowledge/`;
const key=(uid,id)=>{if(typeof id!=='string'||!ID.test(id))throw new HTTPError(400,'Choose a valid knowledge document.');return prefix(uid)+id;};
export function chunkText(text){const chunks=[];let start=0;while(start<text.length){let end=Math.min(start+1100,text.length);if(end<text.length){const boundary=text.lastIndexOf('\n',end);if(boundary>start+550)end=boundary;}chunks.push({index:chunks.length+1,start,end,text:text.slice(start,end)});if(end===text.length)break;start=end-120;}return chunks;}
export function documentInput(input){if(typeof input?.title!=='string'||!input.title.trim()||input.title.length>100||typeof input.text!=='string'||!input.text.trim()||input.text.length>30000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text))throw new HTTPError(400,'Add a title (up to 100 characters) and readable text (up to 30,000 characters).');return {title:input.title.trim(),text:input.text.replace(/\r\n?/g,'\n').trim()};}
const summary=d=>({id:d.id,title:d.title,characters:d.text.length,chunks:d.chunks.length,createdAt:d.createdAt});
export async function listDocuments(store,uid){const {blobs}=await store.list({prefix:prefix(uid)});const docs=await Promise.all(blobs.slice(0,12).map(row=>store.get(row.key,{type:'json'})));return docs.filter(Boolean).map(summary).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
export async function addDocument(store,uid,input){
 const value=documentInput(input),id=randomUUID();let slot;
 for(let i=0;i<12;i++){const slotKey=`knowledge-slots/${uid}/${i}`;const claim=await store.setJSON(slotKey,{id},{onlyIfNew:true});if(claim.modified){slot=slotKey;break;}}
 if(!slot)throw new HTTPError(400,'This demo supports up to 12 knowledge documents. Remove one before adding another.');
 const doc={id,...value,slot,createdAt:new Date().toISOString(),chunks:chunkText(value.text)};
 try{await store.setJSON(key(uid,id),doc);}catch(error){await store.delete(slot);throw error;}return summary(doc);
}
export async function removeDocument(store,uid,id){const target=key(uid,id),doc=await store.get(target,{type:'json'});if(!doc)throw new HTTPError(404,'Document not found.');await store.delete(target);if(doc.slot?.startsWith(`knowledge-slots/${uid}/`)){const claim=await store.get(doc.slot,{type:'json'});if(claim?.id===id)await store.delete(doc.slot);}}
export async function retrieveKnowledge(store,uid,ids,query){
 if(!Array.isArray(ids)||ids.length>4||new Set(ids).size!==ids.length)throw new HTTPError(400,'Choose up to four different knowledge documents.');
 if(typeof query!=='string'||!query.trim()||query.length>8000)throw new HTTPError(400,'Write a question of up to 8,000 characters.');
 const docs=await Promise.all(ids.map(async id=>{const doc=await store.get(key(uid,id),{type:'json'});if(!doc)throw new HTTPError(404,'A selected document was removed or is unavailable. Refresh your sources.');return doc;}));
 const terms=[...new Set(words(query))].slice(0,80),chunks=docs.flatMap(doc=>doc.chunks.map(chunk=>({...chunk,documentId:doc.id,title:doc.title,terms:words(chunk.text),titleTerms:words(doc.title)}))),n=chunks.length,average=chunks.reduce((sum,c)=>sum+c.terms.length,0)/(n||1);
 const ranked=chunks.map(chunk=>{let score=0;for(const term of terms){const tf=chunk.terms.filter(w=>w===term).length,df=chunks.filter(c=>c.terms.includes(term)).length;if(tf)score+=Math.log(1+(n-df+0.5)/(df+0.5))*(tf*2.2)/(tf+1.2*(0.25+0.75*chunk.terms.length/(average||1)));if(chunk.titleTerms.includes(term)&&tf)score+=0.3;}return {...chunk,score};}).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.documentId.localeCompare(b.documentId)||a.index-b.index);
 const selected=[];for(const c of ranked){if(selected.some(s=>s.documentId===c.documentId&&Math.abs(s.index-c.index)<2))continue;selected.push(c);if(selected.length===5)break;}
 return {method:'keyword-ranked chunks (BM25-style; no embeddings)',documents:docs.map(summary),sources:selected.map((c,i)=>({citation:'K'+(i+1),documentId:c.documentId,title:c.title,chunk:c.index,start:c.start,end:c.end,text:c.text})),note:selected.length?'Retrieved passages are evidence candidates, not a guarantee that the answer is present.':'No keyword matches. Try the terminology used in your documents, or select another source.'};
}
export function citationAudit(answer,sources){const mentions=[...new Set([...answer.matchAll(/\[(K\d+)\]/g)].map(m=>m[1]))],known=new Set(sources.map(s=>s.citation));return {cited:mentions.filter(id=>known.has(id)),unknown:mentions.filter(id=>!known.has(id)),note:'Citation presence is checked; factual support is not automatically verified.'};}
