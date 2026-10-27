import {HTTPError} from './auth.mjs';
export function dayKey(now=Date.now()){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));}
export async function countClaims(store,prefix){const {blobs}=await store.list({prefix});return blobs.length;}
async function claim(store,prefix,limit,now){
 const occupied=await countClaims(store,prefix);
 if(occupied>=limit)throw new HTTPError(429,'The demo’s daily model-request allowance is used. Try after midnight Pacific time.');
 for(let i=occupied;i<limit;i++){
  const result=await store.setJSON(prefix+String(i).padStart(4,'0'),{at:now},{onlyIfNew:true,metadata:{expiresAt:now+3*86400_000}});
  if(result.modified)return;
 }
 throw new HTTPError(429,'The demo’s daily model-request allowance is used. Try after midnight Pacific time.');
}
export async function reserveRequest(store,session,cfg,now=Date.now()){
 // Atomic claim-a-key ledger, not a read/modify/write counter. Conservatively charge attempts.
 const day=dayKey(now),userPrefix=`limits/user/${session.uid}/${day}/`,globalPrefix=`limits/global/${day}/`;
 if(await countClaims(store,userPrefix)>=cfg.userLimit||await countClaims(store,globalPrefix)>=cfg.globalLimit)throw new HTTPError(429,'The demo’s daily model-request allowance is used. Try after midnight Pacific time.');
 const slot=Math.floor(now/6000),retryAfter=Math.max(1,Math.ceil(((slot+1)*6000-now)/1000));
 const pace=await store.setJSON(`limits/pace/${slot}`,{at:now},{onlyIfNew:true,metadata:{expiresAt:now+86400_000}});
 if(!pace.modified)throw new HTTPError(429,'Another model request is in progress. Your task will resume shortly.',retryAfter);
 await claim(store,userPrefix,cfg.userLimit,now);
 await claim(store,globalPrefix,cfg.globalLimit,now);
}

export const EMBEDDING_USER_LIMIT=20,EMBEDDING_GLOBAL_LIMIT=100;
export async function reserveEmbedding(store,session,now=Date.now()){
 const day=dayKey(now),userPrefix=`limits/embedding-user/${session.uid}/${day}/`,globalPrefix=`limits/embedding-global/${day}/`;
 if(await countClaims(store,userPrefix)>=EMBEDDING_USER_LIMIT||await countClaims(store,globalPrefix)>=EMBEDDING_GLOBAL_LIMIT)throw new HTTPError(429,'The daily semantic-search allowance is used. Keyword search still works.');
 const slot=Math.floor(now/6000),retryAfter=Math.max(1,Math.ceil(((slot+1)*6000-now)/1000));
 if(!(await store.setJSON(`limits/embedding-pace/${slot}`,{at:now},{onlyIfNew:true,metadata:{expiresAt:now+86400_000}})).modified)throw new HTTPError(429,'Semantic search is busy. Try again shortly; keyword search still works.',retryAfter);
 await claim(store,userPrefix,EMBEDDING_USER_LIMIT,now);await claim(store,globalPrefix,EMBEDDING_GLOBAL_LIMIT,now);
}
