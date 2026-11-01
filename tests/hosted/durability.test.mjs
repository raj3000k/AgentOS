import test from 'node:test';
import assert from 'node:assert/strict';
import {settings,sign,cookieName} from '../../netlify/lib/auth.mjs';
import {createRun,runStep,getRun,stopRun,browserReply,publicRun} from '../../netlify/lib/engine.mjs';
import {controlRun,listRuns,removeRun,RETENTION,LEASE_MS} from '../../netlify/lib/durability.mjs';
import {createHandler} from '../../netlify/functions/api.mjs';
class Store{
 rows=new Map();version=0;
 async setJSON(key,data,options={}){const old=this.rows.get(key);if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};const etag=String(++this.version);this.rows.set(key,{data:structuredClone(data),etag,metadata:options.metadata||{}});return {modified:true,etag};}
 async get(key){return structuredClone(this.rows.get(key)?.data??null);}
 async getWithMetadata(key){return structuredClone(this.rows.get(key)??null);}
 async delete(key){this.rows.delete(key);}
 async list({prefix=''}){return {blobs:[...this.rows].filter(([key])=>key.startsWith(prefix)).map(([key])=>({key}))};}
}
const environment={AGENTOS_SITE_URL:'https://agentos.example',AGENTOS_SESSION_SECRET:'z'.repeat(48),GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',GEMINI_API_KEY:'test-server-secret'},cfg=settings(environment),session={uid:'a'.repeat(64)};
const agent={name:'Numbers',purpose:'Calculate carefully',instructions:'Use calculator.',capabilities:['calculator'],category:'data'};
const call={id:'calc',type:'function',function:{name:'calculate',arguments:'{"a":2,"b":2,"operation":"add"}'}};
const modelTool=async()=>({role:'assistant',content:'',tool_calls:[call]});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('plan review gates inference; owner approves without a model call',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2',reviewPlan:true});
 assert.equal(run.status,'awaiting_approval');assert.equal(run.workflow.plan.length,3);assert.equal(run.expiresAt-run.createdAt,RETENTION);
 let calls=0;assert.equal((await runStep(store,session,cfg,run.id,{model:()=>{calls++;}})).status,'awaiting_approval');assert.equal(calls,0);
 await assert.rejects(controlRun(store,{uid:'b'.repeat(64)},run.id,'approve'),e=>e.status===404);
 assert.equal((await controlRun(store,session,run.id,'approve')).status,'ready');assert.equal((await controlRun(store,session,run.id,'approve')).status,'ready');
});
test('checkpoint resume retains evidence and never repeats a committed tool batch',async()=>{
 const store=new Store(),created=await createRun(store,session,{agent,prompt:'2+2'}),now=Date.now();let tools=0;
 const first=await runStep(store,session,cfg,created.id,{now,model:modelTool,tool:async()=>{tools++;return {ok:true,result:4};}});
 assert.equal(first.workflow.checkpoint.number,1);assert.equal(first.evidence.length,1);
 await controlRun(store,session,created.id,'pause');await controlRun(store,session,created.id,'resume');
 let sawTool=false;const last=await runStep(store,session,cfg,created.id,{now:now+7000,model:async(_cfg,messages)=>{sawTool=messages.some(m=>m.role==='tool'&&m.content.includes('4'));return {role:'assistant',content:'4'};}});
 assert.equal(last.status,'completed');assert.equal(tools,1);assert.equal(sawTool,true);assert.equal(last.workflow.checks[0].state,'passed');assert.equal(last.workflow.checks[3].state,'review');
});
test('concurrent steps share one persisted lease and one provider request',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2'}),started=deferred(),finish=deferred();let calls=0;
 const first=runStep(store,session,cfg,run.id,{model:async()=>{calls++;started.resolve();return await finish.promise;}});await started.promise;
 const second=await runStep(store,session,cfg,run.id,{model:()=>{throw new Error('duplicate');}});assert.equal(second.status,'working');assert.equal(second.model_calls,1);
 finish.resolve({role:'assistant',content:'4'});await first;assert.equal(calls,1);
});
test('pause during inference defers an unstarted tool batch and saves a resumable checkpoint',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2'}),started=deferred(),finish=deferred();let tools=0;
 const step=runStep(store,session,cfg,run.id,{model:async()=>{started.resolve();return await finish.promise;},tool:async()=>{tools++;return {ok:true,result:4};}});await started.promise;
 const paused=await controlRun(store,session,run.id,'pause');assert.equal(paused.pauseRequested,true);
 finish.resolve(await modelTool());const result=await step;assert.equal(result.status,'paused');assert.equal(tools,0);assert.equal(result.model_calls,1);assert.ok(result.workflow.timeline.some(e=>e.type==='pause_requested'));assert.ok(result.workflow.timeline.findIndex(e=>e.type==='pause_requested')<result.workflow.timeline.findIndex(e=>e.type==='checkpoint_saved'));
 assert.equal((await getRun(store,session.uid,run.id)).data.messages.some(m=>m.role==='assistant'),false);
});
test('pause during a tool read commits its result and does not replay it on resume',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2'}),started=deferred(),finish=deferred();
 const step=runStep(store,session,cfg,run.id,{model:modelTool,tool:async()=>{started.resolve();return await finish.promise;}});await started.promise;await controlRun(store,session,run.id,'pause');finish.resolve({ok:true,result:4});const result=await step;
 assert.equal(result.status,'paused');assert.equal(result.evidence[0].result.result,4);assert.equal(result.tool_calls,1);
});
test('stop during inference prevents later tools and late completion cannot revive run',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2'}),started=deferred(),finish=deferred();let tools=0;
 const step=runStep(store,session,cfg,run.id,{model:async()=>{started.resolve();return await finish.promise;},tool:async()=>{tools++;}});await started.promise;await stopRun(store,session,run.id);finish.resolve(await modelTool());assert.equal((await step).status,'cancelled');assert.equal(tools,0);
 await assert.rejects(controlRun(store,session,run.id,'resume'),e=>e.status===409);
});
test('expired lease requires explicit resume and rejects late worker writes',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2'}),started=deferred(),finish=deferred(),now=Date.now();
 const step=runStep(store,session,cfg,run.id,{now,model:async()=>{started.resolve();return await finish.promise;}});await started.promise;
 await assert.rejects(controlRun(store,session,run.id,'resume',now+100),e=>e.status===409);
 const interrupted=await runStep(store,session,cfg,run.id,{now:now+LEASE_MS+1});assert.equal(interrupted.status,'partial');assert.equal(interrupted.workflow.canResume,true);
 await controlRun(store,session,run.id,'resume',now+LEASE_MS+2);finish.resolve({role:'assistant',content:'stale'});assert.equal((await step).answer,'');
 const last=await runStep(store,session,cfg,run.id,{now:now+LEASE_MS+7000,model:async()=>({role:'assistant',content:'fresh'})});assert.equal(last.answer,'fresh');assert.equal(last.model_calls,2);
});
test('provider failure resumes from valid tool transcript without extending model budget',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2'}),now=Date.now();
 const partial=await runStep(store,session,cfg,run.id,{now,model:async()=>{throw Error('secret provider text');}});assert.equal(partial.status,'partial');assert.equal(partial.model_calls,1);
 await controlRun(store,session,run.id,'resume');const record=await getRun(store,session.uid,run.id);record.data.model_calls=5;await store.setJSON(`users/${session.uid}/runs/${run.id}`,record.data);
 const final=await runStep(store,session,cfg,run.id,{now:now+7000,model:async(_cfg,_messages,tools)=>{assert.equal(tools.length,0);return {role:'assistant',content:'Partial answer'};}});assert.equal(final.status,'budget_summary');assert.equal(final.workflow.canResume,false);await assert.rejects(controlRun(store,session,run.id,'resume'),e=>e.status===409);
});
test('quota pacing restores ready checkpoint without consuming a model attempt',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2'}),other=await createRun(store,session,{agent,prompt:'2+2'}),now=Date.now();
 await runStep(store,session,cfg,other.id,{now,model:async()=>({role:'assistant',content:'4'})});
 await assert.rejects(runStep(store,session,cfg,run.id,{now,model:()=>{throw Error('must not run');}}),e=>e.status===429);
 const ready=(await getRun(store,session.uid,run.id)).data;assert.equal(ready.model_calls,0);assert.equal(ready.status,'ready');assert.equal(ready.lease,undefined);assert.equal(ready.timeline.at(-1).type,'pacing_wait');
 assert.equal((await runStep(store,session,cfg,run.id,{now:now+7000,model:async()=>({role:'assistant',content:'4'})})).status,'completed');
});
test('browser pause closes pending transcript safely; resume does not restore tab permission',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent:{...agent,capabilities:['web_research']},prompt:'jobs',useBrowser:true});
 const waiting=await runStep(store,session,cfg,run.id,{model:async()=>({role:'assistant',content:'',tool_calls:[{id:'s',function:{name:'search_linkedin_jobs',arguments:'{"keywords":"engineer","location":"Bengaluru"}'}}]})});assert.equal(waiting.status,'waiting_browser');
 const paused=await controlRun(store,session,run.id,'pause');assert.equal(paused.status,'paused');assert.equal(paused.messages.at(-1).role,'tool');assert.equal(paused.useBrowser,false);
 await controlRun(store,session,run.id,'resume');assert.equal((await browserReply(store,session,run.id,{batchId:waiting.pendingBrowser.batchId,results:[]})).status,'ready');
});
test('run history is owner scoped, omits transcript, expires, and removal blocks late writes',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'private task'}),started=deferred(),finish=deferred();
 assert.equal((await listRuns(store,'b'.repeat(64))).length,0);const list=await listRuns(store,session.uid);assert.equal(list.length,1);assert.equal(list[0].messages,undefined);assert.equal((await listRuns(store,session.uid,run.expiresAt+1)).length,0);
 const step=runStep(store,session,cfg,run.id,{model:async()=>{started.resolve();return await finish.promise;}});await started.promise;await removeRun(store,session,run.id);finish.resolve({role:'assistant',content:'late'});await assert.rejects(step,e=>e.status===404);assert.equal((await listRuns(store,session.uid)).length,0);
});
test('workflow routes enforce authentication, CSRF, ownership and read-only reopening',async()=>{
 const store=new Store(),handler=createHandler({storeFactory:()=>store,environment}),user={kind:'session',...session,jti:'durable',csrf:'csrf',name:'Test',email:'demo@example.com'};await store.setJSON('sessions/'+user.jti,{uid:user.uid,expiresAt:Date.now()+60000});const cookie=`${cookieName(cfg)}=${await sign(user,cfg)}`;
 const req=(path,body,extra={})=>handler(new Request(cfg.origin+'/api/'+path,{method:body?'POST':'GET',headers:{cookie,origin:cfg.origin,'content-type':'application/json','x-agentos-csrf':user.csrf,...extra},...(body?{body:JSON.stringify(body)}:{})}));
 const response=await req('runs',{agent,prompt:'2+2',reviewPlan:true}),run=await response.json();assert.equal(run.status,'awaiting_approval');assert.equal((await req(`runs/${run.id}/approve`,{}, {'x-agentos-csrf':'wrong'})).status,403);
 assert.equal((await req(`runs/${run.id}`)).status,200);assert.equal((await req(`runs/${run.id}`).then(r=>r.json())).model_calls,0);assert.equal((await req('runs').then(r=>r.json())).items.length,1);
 const foreign={...user,uid:'b'.repeat(64),jti:'other'};await store.setJSON('sessions/'+foreign.jti,{uid:foreign.uid,expiresAt:Date.now()+60000});const otherCookie=`${cookieName(cfg)}=${await sign(foreign,cfg)}`;
 assert.equal((await req(`runs/${run.id}/resume`,{},{cookie:otherCookie})).status,404);assert.equal((await req('runs',null,{cookie:otherCookie}).then(r=>r.json())).items.length,0);
 assert.equal((await req(`runs/${run.id}/approve`,{})).status,200);assert.equal((await req(`runs/${run.id}/pause`,{})).status,200);assert.equal((await req(`runs/${run.id}/resume`,{})).status,200);
 assert.equal((await req(`runs/${run.id}/remove`,{})).status,200);assert.equal((await req(`runs/${run.id}`)).status,404);
});
test('a ready run reopened after reload requires explicit continuation and preserves limits',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2'});
 assert.equal(publicRun((await getRun(store,session.uid,run.id)).data).workflow.canResume,true);
 const resumed=await controlRun(store,session,run.id,'resume');assert.equal(resumed.status,'ready');assert.equal(resumed.model_calls,0);assert.equal(resumed.useBrowser,false);
 assert.equal((await runStep(store,session,cfg,run.id,{model:async()=>({role:'assistant',content:'4'})})).status,'completed');
});
test('failed tool batch rolls back incomplete transcript and uncommitted discovery state',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2'}),now=Date.now();
 const partial=await runStep(store,session,cfg,run.id,{now,model:modelTool,tool:async(_name,_args,state)=>{state.observed.push('https://example.com/uncommitted');throw Error('interrupted');}});
 assert.equal(partial.status,'partial');const record=await getRun(store,session.uid,run.id);assert.deepEqual(record.data.observed,[]);assert.equal(record.data.messages.at(-1).role,'user');
 await controlRun(store,session,run.id,'resume');const final=await runStep(store,session,cfg,run.id,{now:now+7000,model:async(_cfg,messages)=>{assert.equal(messages.some(m=>m.tool_calls),false);return {role:'assistant',content:'4'};}});assert.equal(final.status,'completed');
});
test('concurrent removal and stale model result cannot recreate a saved run',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent,prompt:'2+2'});await removeRun(store,session,run.id);
 await assert.rejects(controlRun(store,session,run.id,'resume'),e=>e.status===404);await assert.rejects(runStep(store,session,cfg,run.id),e=>e.status===404);
});
