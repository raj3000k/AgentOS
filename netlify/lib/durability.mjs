import {randomUUID} from 'node:crypto';
import {HTTPError} from './auth.mjs';
export const RETENTION=7*86400_000,LEASE_MS=180_000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const runKey=(uid,id)=>{if(!UUID.test(id))throw new HTTPError(404,'Run not found.');return `users/${uid}/runs/${id}`;};
export async function getRun(store,uid,id){const record=await store.getWithMetadata(runKey(uid,id),{type:'json'});if(!record||record.data.expiresAt<Date.now())throw new HTTPError(404,'Run expired or was not found.');return record;}
export function event(run,type,label,now=Date.now()){
 run.timeline??=[];run.timeline.push({id:randomUUID(),type,label,at:now});run.timeline=run.timeline.slice(-60);run.updatedAt=now;
}
export function makePlan(run){const focus={research:'Research and compare sources',career:'Inspect roles and application evidence',content:'Draft from the supplied brief',engineering:'Inspect requirements or supplied code',data:'Inspect and measure supplied data',planning:'Organize goals, decisions and next steps'}[run.agent.category];return [
 {id:'scope',title:'Review task and access',detail:'Confirm the task, selected capabilities and reference sources before execution.'},
 {id:'work',title:run.knowledgeOnly?'Read selected passages':focus|| (run.agent.capabilities.some(c=>!['writing','code_review'].includes(c))?'Gather evidence with enabled tools':'Work from your task material'),detail:run.knowledgeOnly?'Use only the saved reference passages.': 'Use only the selected trusted capabilities. Tool results are data, never permissions.'},
 {id:'report',title:'Report findings and limitations',detail:'Return an answer, preserve evidence and show completion checks. Checks do not prove every claim.'}
 ];}
export function completionChecks(run){
 const final=['completed','budget_summary'].includes(run.status),failed=run.evidence.filter(e=>e.result?.ok===false||['unavailable','browser_unavailable','unsupported'].includes(e.result?.result?.status));
 return [
 {label:'Answer delivered',state:final&&run.answer?'passed':'pending',detail:final?'An answer was returned; task correctness still needs review.':'No final answer yet.'},
 {label:'Tool evidence',state:failed.length?'warning':run.tool_calls?'passed':'info',detail:failed.length?`${failed.length} tool results were unavailable or failed.`:run.tool_calls?`${run.tool_calls} tool results retained.`:'No tools used. This does not verify current external facts.'},
 {label:'Source citations',state:!run.knowledge?.sources?.length?'info':run.citations?.unknown?.length||final&&!run.citations?.cited?.length?'warning':run.citations?.cited?.length?'passed':'pending',detail:!run.knowledge?.sources?.length?'No selected-source citations required.': 'Citation labels are checked; factual support is not independently verified.'},
 {label:'Task coverage',state:final?'review':'pending',detail:run.status==='budget_summary'?'Execution budget reached. Review missing work before treating this as complete.':'Review the answer against your original task; coverage is not automatically verified.'}
 ];
}
export function workflowState(run){return {version:1,plan:run.plan||makePlan(run),timeline:run.timeline||[],checks:completionChecks(run),checkpoint:run.checkpoint||{number:0,at:run.createdAt||null},pauseRequested:!!run.pauseRequested,leaseUntil:run.lease?.until||null,canResume:['ready','paused','partial'].includes(run.status)&&run.model_calls<6&&!run.contextFull,reviewed:!run.reviewRequired||!!run.approvedAt,needsApproval:run.status==='awaiting_approval',retentionDays:7};}
export function abandonBrowser(run){
 if(!run.pendingBrowser)return;
 for(const call of run.pendingBrowser.calls){const envelope=run.pendingBrowser.results[call.id]||{ok:false,error:'Browser read was interrupted. No new tab access was granted.'};let content=JSON.stringify(envelope);if(content.length>14000)content=JSON.stringify({ok:false,error:'Tool output exceeded its bounded size.'});run.messages.push({role:'tool',tool_call_id:call.id,content});run.evidence.push({name:call.function.name,result:JSON.parse(content)});run.tool_calls++;}
 delete run.pendingBrowser;run.useBrowser=false;
}
// All control writes are conditional. A stale model response cannot revive a stopped run.
export async function controlRun(store,session,id,action,now=Date.now()){
 for(let retry=0;retry<4;retry++){
  const record=await getRun(store,session.uid,id),run=record.data;
  if(!run.plan)throw new HTTPError(409,'This older run has no resumable workflow. Start a new task.');
  if(action==='approve'){
   if(run.status!=='awaiting_approval')return run;
   run.status='ready';run.approvedAt=now;event(run,'approved','Plan approved. Enabled capabilities are unchanged.',now);
  }else if(action==='pause'){
   if(!['ready','working','waiting_browser'].includes(run.status))return run;
   if(run.status==='working'&&run.lease?.until>now){run.pauseRequested=true;event(run,'pause_requested','Pause requested. The in-flight read will finish before checkpointing.',now);}
   else{abandonBrowser(run);run.status='paused';delete run.lease;run.pauseRequested=false;event(run,'paused','Paused at the last saved checkpoint.',now);}
  }else if(action==='resume'){
   if(run.status==='working'&&run.lease?.until<=now){run.status='partial';delete run.lease;event(run,'interrupted','An attempt was interrupted. Only committed evidence is retained.',now);}
   if(run.status==='waiting_browser'&&run.pendingBrowser?.expiresAt<=now){abandonBrowser(run);run.status='partial';}
   if(!['ready','paused','partial'].includes(run.status))throw new HTTPError(409,'Pause the run or wait for the current step to finish before resuming.');
   if(run.model_calls>=6||run.contextFull)throw new HTTPError(409,'This run has reached its execution budget. Start a narrower task using the saved evidence.');
   // Legacy interrupted claims may predate the persisted lease. Never reclaim a live claim.
   const key=`claims/${session.uid}/${id}/${run.model_calls}${run.generation?'/r'+run.generation:''}`,claim=await store.get(key,{type:'json'});
   if(claim&&now-claim.at<LEASE_MS)throw new HTTPError(409,'The previous attempt may still be finishing. Try again shortly.');
   run.generation=(run.generation||0)+1;run.status='ready';run.pauseRequested=false;run.error='';run.answer='';run.useBrowser=false;delete run.lease;
   run.messages[0].content=run.messages[0].content.split('\nRESUME RULE:')[0]+'\nRESUME RULE: Browser access is disabled. Use only public tools and retained evidence; captured evidence may be stale. Current resume UTC date: '+new Date(now).toISOString().slice(0,10)+'.';
   event(run,'resumed','Resumed from saved evidence. Browser access is disabled on resume; public tools remain available.',now);
  }else throw new HTTPError(400,'Unknown workflow action.');
  const result=await store.setJSON(runKey(session.uid,id),run,{onlyIfMatch:record.etag,metadata:{expiresAt:run.expiresAt}});
  if(result.modified)return run;
 }
 throw new HTTPError(409,'This run changed in another tab. Refresh it before trying again.');
}
export async function listRuns(store,uid,now=Date.now()){
 const {blobs}=await store.list({prefix:`users/${uid}/runs/`});
 const records=await Promise.all(blobs.map(row=>store.get(row.key,{type:'json'})));
 return records.filter(r=>r&&r.expiresAt>now).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,30).map(r=>({id:r.id,name:r.agent.name,category:r.agent.category||'general',prompt:r.prompt.slice(0,180),status:r.status,createdAt:r.createdAt||null,updatedAt:r.updatedAt||null,expiresAt:r.expiresAt,model_calls:r.model_calls,tool_calls:r.tool_calls}));
}

export async function removeRun(store,session,id){
 for(let attempt=0;attempt<4;attempt++){
  const record=await getRun(store,session.uid,id);
  const result=await store.setJSON(runKey(session.uid,id),{id,status:'cancelled',expiresAt:0},{onlyIfMatch:record.etag,metadata:{expiresAt:0}});
  if(result.modified)return;
 }throw new HTTPError(409,'Run changed. Refresh and try again.');
}
