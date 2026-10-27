import {randomUUID,createHash} from 'node:crypto';
import {embedTexts,EMBEDDING_MODEL,EMBEDDING_DIMENSIONS,normalizedVector,similarity} from './embeddings.mjs';
import {reserveEmbedding} from './limits.mjs';
import {HTTPError} from './auth.mjs';
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const stop=new Set('a an the is are was were be been to of in on at for with and or as by from it this that what which how does do please tell me about can you our your'.split(' '));
const words=text=>(text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]).filter(w=>!stop.has(w));
const prefix=uid=>`users/${uid}/knowledge/`;
const key=(uid,id)=>{if(typeof id!=='string'||!ID.test(id))throw new HTTPError(400,'Choose a valid knowledge document.');return prefix(uid)+id;};
function pageMarkers(text){const markers=[...text.matchAll(/^\[PDF page ([1-9]\d?)\]\s*$/gm)];return markers.length<=60&&markers.every((m,i)=>Number(m[1])<=60&&(!i||Number(m[1])>Number(markers[i-1][1])))?markers:[];}
export function chunkText(text){
 const chunks=[],markers=pageMarkers(text),boundaries=[...new Set([0,...markers.map(m=>m.index),text.length])];
 for(let segment=0;segment<boundaries.length-1;segment++){let start=boundaries[segment];const stop=boundaries[segment+1];while(start<stop){let end=Math.min(start+1100,stop);if(end<stop){const boundary=text.lastIndexOf('\n',end);if(boundary>start+(markers.length?900:550))end=boundary;}chunks.push({index:chunks.length+1,start,end,text:text.slice(start,end)});if(end===stop)break;start=end-120;}}
 return chunks;
}
export function documentInput(input){if(typeof input?.title!=='string'||!input.title.trim()||input.title.length>100||typeof input.text!=='string'||!input.text.trim()||input.text.length>30000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(input.text))throw new HTTPError(400,'Add a title (up to 100 characters) and readable text (up to 30,000 characters).');return {title:input.title.trim(),text:input.text.replace(/\r\n?/g,'\n').trim()};}
const summary=d=>({id:d.id,title:d.title,characters:d.text.length,chunks:d.chunks.length,createdAt:d.createdAt,semanticReady:!!d.semantic&&d.semantic.model===EMBEDDING_MODEL&&d.semantic.dimensions===EMBEDDING_DIMENSIONS&&d.semantic.vectors?.length===d.chunks.length});
export async function listDocuments(store,uid){const {blobs}=await store.list({prefix:prefix(uid)});const docs=await Promise.all(blobs.slice(0,12).map(row=>store.get(row.key,{type:'json'})));return docs.filter(Boolean).map(summary).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
export async function addDocument(store,uid,input){
 const value=documentInput(input),id=randomUUID();let slot;
 for(let i=0;i<12;i++){const slotKey=`knowledge-slots/${uid}/${i}`;const claim=await store.setJSON(slotKey,{id},{onlyIfNew:true});if(claim.modified){slot=slotKey;break;}}
 if(!slot)throw new HTTPError(400,'This demo supports up to 12 knowledge documents. Remove one before adding another.');
 const doc={id,...value,slot,createdAt:new Date().toISOString(),chunks:chunkText(value.text)};
 try{await store.setJSON(key(uid,id),doc);}catch(error){await store.delete(slot);throw error;}return summary(doc);
}
export async function removeDocument(store,uid,id){const target=key(uid,id),doc=await store.get(target,{type:'json'});if(!doc)throw new HTTPError(404,'Document not found.');await store.delete(target);if(doc.slot?.startsWith(`knowledge-slots/${uid}/`)){const claim=await store.get(doc.slot,{type:'json'});if(claim?.id===id)await store.delete(doc.slot);}}
export async function indexDocument(store,session,cfg,id,{embed=embedTexts,reserve=reserveEmbedding,now=Date.now()}={}){
 const target=key(session.uid,id),record=await store.getWithMetadata(target,{type:'json'});
 if(!record)throw new HTTPError(404,'Document not found.');const doc=record.data;
 if(summary(doc).semanticReady)return summary(doc);
 doc.chunks=chunkText(doc.text);
 await reserve(store,session,now);const vectors=await embed(cfg,doc.chunks.map(c=>c.text),'RETRIEVAL_DOCUMENT',{title:doc.title});
 if(vectors.length!==doc.chunks.length)throw new HTTPError(502,'Embedding batch was incomplete.');
 doc.semantic={model:EMBEDDING_MODEL,dimensions:EMBEDDING_DIMENSIONS,vectors:vectors.map(normalizedVector),indexedAt:new Date(now).toISOString()};
 const written=await store.setJSON(target,doc,{onlyIfMatch:record.etag});if(!written.modified)throw new HTTPError(409,'Document changed or was removed during indexing. Refresh your documents.');return summary(doc);
}
export function sourcePages(text,start,end){
 const markers=pageMarkers(text);
 return [...new Set(markers.filter((m,i)=>m.index<end&&(markers[i+1]?.index??text.length)>start).map(m=>Number(m[1])))];
}
export async function retrieveKnowledge(store,uid,ids,query,{semantic=false,cfg,embed=embedTexts,reserve=reserveEmbedding,now=Date.now()}={}){
 if(!Array.isArray(ids)||ids.length>4||new Set(ids).size!==ids.length)throw new HTTPError(400,'Choose up to four different knowledge documents.');
 if(typeof query!=='string'||!query.trim()||query.length>8000)throw new HTTPError(400,'Write a question of up to 8,000 characters.');
 const docs=await Promise.all(ids.map(async id=>{const doc=await store.get(key(uid,id),{type:'json'});if(!doc)throw new HTTPError(404,'A selected document was removed or is unavailable. Refresh your sources.');return doc;}));
 const terms=[...new Set(words(query))].slice(0,80),chunks=docs.flatMap(doc=>doc.chunks.map((chunk,i)=>({...chunk,documentId:doc.id,title:doc.title,pages:sourcePages(doc.text,chunk.start,chunk.end),vector:summary(doc).semanticReady?doc.semantic.vectors[i]:null,terms:words(chunk.text),titleTerms:words(doc.title)}))),n=chunks.length,average=chunks.reduce((sum,c)=>sum+c.terms.length,0)/(n||1);
 const frequencies=new Map();for(const c of chunks)for(const term of new Set(c.terms))frequencies.set(term,(frequencies.get(term)||0)+1);
 for(const chunk of chunks){let score=0;const counts=new Map();for(const term of chunk.terms)counts.set(term,(counts.get(term)||0)+1);for(const term of terms){const tf=counts.get(term)||0,df=frequencies.get(term)||0;if(tf)score+=Math.log(1+(n-df+0.5)/(df+0.5))*(tf*2.2)/(tf+1.2*(0.25+0.75*chunk.terms.length/(average||1)));if(chunk.titleTerms.includes(term)&&tf)score+=0.3;}chunk.keywordScore=score;chunk.semanticScore=0;chunk.score=score;}
 const lexical=chunks.filter(c=>c.keywordScore>0).sort((a,b)=>b.keywordScore-a.keywordScore||a.documentId.localeCompare(b.documentId)||a.index-b.index);
 let method='Keyword search',fallback='',embeddingRequests=0,queryCached=false,semanticRanking=[];
 if(semantic&&chunks.some(c=>c.vector)){
  try{
   const digest=createHash('sha256').update(EMBEDDING_MODEL+'|'+EMBEDDING_DIMENSIONS+'|'+query.trim()).digest('hex'),cacheKey=`users/${uid}/embedding-queries/${digest}`;
   const cached=await store.get(cacheKey,{type:'json'});let queryVector;
   if(cached?.expiresAt>now){queryVector=normalizedVector(cached.vector);queryCached=true;}
   else{await reserve(store,{uid},now);embeddingRequests=1;[queryVector]=await embed(cfg,[query.trim()],'RETRIEVAL_QUERY');queryVector=normalizedVector(queryVector);await store.setJSON(cacheKey,{vector:queryVector,expiresAt:now+3600_000},{metadata:{expiresAt:now+3600_000}});}
   for(const chunk of chunks)if(chunk.vector)chunk.semanticScore=similarity(queryVector,normalizedVector(chunk.vector));
   const best=Math.max(...chunks.map(c=>c.semanticScore));semanticRanking=chunks.filter(c=>c.vector&&c.semanticScore>=0.6&&c.semanticScore>=best-0.12).sort((a,b)=>b.semanticScore-a.semanticScore||a.documentId.localeCompare(b.documentId)||a.index-b.index);
   method='Hybrid meaning + keyword search';for(const c of chunks)c.score=0;
   lexical.forEach((c,i)=>{c.score+=.35/(60+i+1);});semanticRanking.forEach((c,i)=>{c.score+=.65/(60+i+1);});
   if(docs.some(d=>!summary(d).semanticReady))fallback='Some selected documents are keyword-only. Enable semantic search for them in Knowledge.';
  }catch(error){fallback=error instanceof HTTPError?error.message:'Semantic search is unavailable. Keyword results are shown.';}
 }else if(semantic&&docs.length)fallback='Selected documents are keyword-only. Enable semantic search in Knowledge to match by meaning.';
 const ranked=chunks.filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.documentId.localeCompare(b.documentId)||a.index-b.index);
 const selected=[];for(const c of ranked){if(selected.some(s=>s.documentId===c.documentId&&Math.max(0,Math.min(s.end,c.end)-Math.max(s.start,c.start))>Math.min(s.end-s.start,c.end-c.start)*.5))continue;selected.push(c);if(selected.length===5)break;}
 return {method,documents:docs.map(summary),sources:selected.map((c,i)=>({citation:'K'+(i+1),documentId:c.documentId,title:c.title,chunk:c.index,start:c.start,end:c.end,pages:c.pages,text:c.text,match:semanticRanking.includes(c)?(c.keywordScore>0?'meaning + keywords':'meaning'):'keywords'})),embeddingRequests,queryCached,fallback,note:selected.length?'Retrieved passages are evidence candidates, not a guarantee that the answer is present.':'No relevant passages found. Try different wording or select another source.'};
}
export function citationAudit(answer,sources){const mentions=[...new Set([...answer.matchAll(/\[(K\d+)\]/g)].map(m=>m[1]))],known=new Set(sources.map(s=>s.citation));return {cited:mentions.filter(id=>known.has(id)),unknown:mentions.filter(id=>!known.has(id)),note:'Citation presence is checked; factual support is not automatically verified.'};}
