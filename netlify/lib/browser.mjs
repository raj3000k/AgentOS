import {HTTPError} from './auth.mjs';
import {safeURL,experience,invoke} from './tools.mjs';
export function browserCommand(call,state){
 const args=JSON.parse(call.function.arguments),name=call.function.name;
 if(name==='search_linkedin_jobs'&&typeof args.keywords==='string'&&args.keywords.length<=120&&typeof args.location==='string'&&args.location.length<=100&&Object.keys(args).length===2)return {id:call.id,url:'https://www.linkedin.com/jobs/search/?keywords='+encodeURIComponent(args.keywords)+'&location='+encodeURIComponent(args.location)};
 if(name==='inspect_linkedin_job'&&Object.keys(args).length===1&&typeof args.url==='string'&&/^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/?$/.test(args.url)&&state.observed.includes(args.url))return {id:call.id,url:args.url};
 return null;
}
const text=(value,size)=>typeof value==='string'?value.slice(0,size):'';
export function browserResult(command,input,state){
 if(!input||typeof input!=='object'||input.url!==command.url||input.status!=='read')return {ok:true,result:{status:'browser_unavailable',error:'Connected tab was blocked, disconnected or did not return the requested job surface.'}};
 const checked_at=new Date().toISOString();
 if(new URL(command.url).pathname==='/jobs/search/'){
  const jobs=[];for(const row of (Array.isArray(input.links)?input.links:[]).slice(0,100)){const url=safeURL(row?.url);const match=url?.match(/^https:\/\/www\.linkedin\.com\/jobs\/view\/(?:[\w-]+-)?(\d+)/);if(match&&!jobs.some(j=>j.job_id===match[1]))jobs.push({job_id:match[1],title:text(row.text,180),source_url:'https://www.linkedin.com/jobs/view/'+match[1]+'/',verification:'connected_browser_candidate'});if(jobs.length>=8)break;}
  state.observed=[...new Set([...state.observed,...jobs.map(j=>j.source_url)])].slice(-100);return {ok:true,result:{status:jobs.length?'read':'no_visible_job_candidates',jobs,checked_at,source:'connected_browser'}};
 }
 const description=text(input.description,12000),job={title:text(input.title,180),company:text(input.company,180),location:text(input.location,200),description,experience:experience(description),source_url:command.url,application_url:safeURL(input.application_url)||null,feed_verified:false,checked_at,source:'connected_browser',description_status:input.description_status==='partial'?'partial':'captured'};
 if(job.title){state.jobs.push(job);state.jobs=state.jobs.slice(-30);state.review=null;}
 return {ok:true,result:{...job,status:description?'read':'partial',note:'User-connected browser observation; employer publication and application acceptance are not independently verified.'}};
}
export async function completeBrowser(store,session,id,input,{getRun,runKey,publicRun},now=Date.now()){
 const record=await getRun(store,session.uid,id),run=record.data;
 if(run.status!=='waiting_browser')return publicRun(run);
 const pending=run.pendingBrowser;
 if(pending.expiresAt<now)throw new HTTPError(410,'Browser step expired. Stop and start a new task.');
 if(input?.batchId!==pending.batchId||!Array.isArray(input.results)||input.results.length!==pending.commands.length||JSON.stringify(input.results).length>90000)throw new HTTPError(400,'Invalid browser reply.');
 const ids=input.results.map(row=>row?.id);if(new Set(ids).size!==ids.length||pending.commands.some(c=>!ids.includes(c.id)))throw new HTTPError(400,'Browser reply does not match this step.');
 for(const command of pending.commands)Object.defineProperty(pending.results,command.id,{value:browserResult(command,input.results.find(r=>r.id===command.id).result,run),enumerable:true,configurable:true});
 for(const call of pending.calls.filter(c=>c.function.name==='review_job_results'))pending.results[call.id]=await invoke(call.function.name,JSON.parse(call.function.arguments),run,run.agent.capabilities);
 for(const call of pending.calls){let envelope=pending.results[call.id],content=JSON.stringify(envelope);if(content.length>14000){envelope={ok:false,error:'Browser output exceeded the bounded size.'};content=JSON.stringify(envelope);}run.messages.push({role:'tool',tool_call_id:call.id,content});run.evidence.push({name:call.function.name,result:envelope});run.tool_calls++;}
 delete run.pendingBrowser;run.status='ready';run.activity.push('Connected browser results received.');
 const written=await store.setJSON(runKey(session.uid,id),run,{onlyIfMatch:record.etag,metadata:{expiresAt:run.expiresAt}});
 return publicRun(written.modified?run:(await getRun(store,session.uid,id)).data);
}
