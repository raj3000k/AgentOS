import {HTTPError} from './auth.mjs';
export const EMBEDDING_MODEL='gemini-embedding-001';
export const EMBEDDING_DIMENSIONS=768;
export function normalizedVector(values){
 if(!Array.isArray(values)||values.length!==EMBEDDING_DIMENSIONS||values.some(n=>typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>1e6))throw new HTTPError(502,'Embedding response was invalid. Keyword search is still available.');
 const norm=Math.hypot(...values);if(!norm)throw new HTTPError(502,'Embedding response was empty. Keyword search is still available.');return values.map(n=>n/norm);
}
export function similarity(a,b){return a.reduce((sum,n,i)=>sum+n*b[i],0);}
export async function embedTexts(cfg,texts,taskType,{title='',fetcher=fetch}={}){
 if(!cfg?.key)throw new HTTPError(503,'Semantic search is not configured. Keyword search is still available.');
 if(!Array.isArray(texts)||!texts.length||texts.length>100||texts.some(t=>typeof t!=='string'||!t.trim()||t.length>8000)||texts.reduce((sum,t)=>sum+t.length,0)>50000||!['RETRIEVAL_DOCUMENT','RETRIEVAL_QUERY'].includes(taskType))throw new HTTPError(400,'Embedding input exceeded its bounds.');
 let response;try{response=await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':cfg.key},body:JSON.stringify({requests:texts.map(text=>({model:'models/'+EMBEDDING_MODEL,content:{parts:[{text}]},taskType,outputDimensionality:EMBEDDING_DIMENSIONS,...(taskType==='RETRIEVAL_DOCUMENT'?{title:title.slice(0,100)}:{})}))}),signal:AbortSignal.timeout(18000)});}catch{throw new HTTPError(502,'Embedding request timed out. Keyword search is still available.');}
 if(!response.ok)throw new HTTPError(response.status===429?429:502,response.status===429?'Gemini embedding quota reached. Try again later; keyword search still works.':'Embedding service is unavailable. Keyword search is still available.');
 const bytes=await response.arrayBuffer();if(bytes.byteLength>2_000_000)throw new HTTPError(502,'Embedding response exceeded its bounds.');let payload;try{payload=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HTTPError(502,'Embedding service returned unreadable data.');}
 if(!Array.isArray(payload.embeddings)||payload.embeddings.length!==texts.length)throw new HTTPError(502,'Embedding batch was incomplete.');return payload.embeddings.map(row=>normalizedVector(row.values));
}
