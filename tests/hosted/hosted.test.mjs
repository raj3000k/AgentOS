import test from 'node:test';
import assert from 'node:assert/strict';
import {settings,nonce,googleLogin,authenticate,sign,cookieName} from '../../netlify/lib/auth.mjs';
import {createRun,runStep,getRun,stopRun,reviewedAnswer} from '../../netlify/lib/engine.mjs';
import {reserveRequest} from '../../netlify/lib/limits.mjs';
import {publicGET,invoke,reviewJobs} from '../../netlify/lib/tools.mjs';
import {createHandler} from '../../netlify/functions/api.mjs';
import {chat} from '../../netlify/lib/gemini.mjs';
class Store {
 rows=new Map(); version=0;
 async setJSON(key,data,options={}){const old=this.rows.get(key);if(options.onlyIfNew&&old||options.onlyIfMatch&&old?.etag!==options.onlyIfMatch)return {modified:false};const etag=String(++this.version);this.rows.set(key,{data:structuredClone(data),etag,metadata:options.metadata||{}});return {modified:true,etag};}
 async get(key){return structuredClone(this.rows.get(key)?.data??null);}
 async getWithMetadata(key){return structuredClone(this.rows.get(key)??null);}
 async delete(key){this.rows.delete(key);}
 async list({prefix=''}={}){return {blobs:[...this.rows].filter(([key])=>key.startsWith(prefix)).map(([key,v])=>({key,etag:v.etag}))};}
}
const cfg=settings({AGENTOS_SITE_URL:'https://agentos.example',AGENTOS_SESSION_SECRET:'a'.repeat(48),GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',GEMINI_API_KEY:'server-only-test-key'});
const session={uid:'a'.repeat(64)};
const profile={name:'Test',purpose:'Test assistant',instructions:'Use only trusted tools.',capabilities:['calculator']};
test('Google nonce binding, session revocation and CSRF validation',async()=>{
 const store=new Store(),proof=await nonce(null,cfg),headers={origin:cfg.origin,cookie:`${cookieName(cfg)}_nonce=${proof.token}`};
 const request=new Request(cfg.origin+'/api/auth/google',{method:'POST',headers});
 const claims={sub:'123',email:'demo@example.com',email_verified:true,nonce:proof.value,name:'Demo'};
 await assert.rejects(googleLogin(request,cfg,store,'credential',async()=>({...claims,nonce:'wrong'})),e=>e.status===401);
 const login=await googleLogin(request,cfg,store,'credential',async()=>claims);
 const cookie=`${cookieName(cfg)}=${login.token}`;
 assert.equal((await authenticate(new Request(cfg.origin,{headers:{cookie}}),cfg,store)).email,claims.email);
 await assert.rejects(authenticate(new Request(cfg.origin,{method:'POST',headers:{cookie,origin:cfg.origin}}),cfg,store),e=>e.status===403);
 assert.equal((await authenticate(new Request(cfg.origin,{method:'POST',headers:{cookie,origin:cfg.origin,'x-agentos-csrf':login.session.csrf}}),cfg,store)).uid,login.session.uid);
 await store.delete('sessions/'+login.session.jti);
 await assert.rejects(authenticate(new Request(cfg.origin,{headers:{cookie}}),cfg,store),e=>e.status===401);
});
test('session tokens reject forged signatures and wrong audiences',async()=>{
 const store=new Store();const token=await sign({kind:'session',uid:session.uid,jti:'x',csrf:'x'},{...cfg,origin:'https://other.example'});
 await assert.rejects(authenticate(new Request(cfg.origin,{headers:{cookie:`${cookieName(cfg)}=${token}`}}),cfg,store),e=>e.status===401);
});
test('API gates data and never publishes server secrets',async()=>{
 const handler=createHandler({storeFactory:()=>new Store(),environment:{AGENTOS_SITE_URL:cfg.origin,GEMINI_API_KEY:cfg.key}});
 const config=await handler(new Request(cfg.origin+'/api/config'));assert.equal(config.status,200);assert.ok(!(await config.text()).includes(cfg.key));
 const response=await handler(new Request(cfg.origin+'/api/agents'));assert.equal(response.status,401);
});
test('per-user run storage and completed-step idempotence',async()=>{
 const store=new Store();const run=await createRun(store,session,{agent:profile,prompt:'Add two numbers.'});
 await assert.rejects(getRun(store,'b'.repeat(64),run.id),e=>e.status===404);
 let calls=0;const output=await runStep(store,session,cfg,run.id,{model:async()=>{calls++;return {role:'assistant',content:'4'};}});
 assert.equal(output.status,'completed');assert.equal((await runStep(store,session,cfg,run.id)).answer,'4');assert.equal(calls,1);
});
test('tool evidence survives provider failure on a later step',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent:profile,prompt:'Compute 2+2'}),now=Date.now();
 const first=await runStep(store,session,cfg,run.id,{now,model:async()=>({role:'assistant',content:'',tool_calls:[{id:'t1',type:'function',function:{name:'calculate',arguments:'{"a":2,"b":2,"operation":"add"}'}}]})});
 assert.equal(first.evidence[0].result.result,4);
 const final=await runStep(store,session,cfg,run.id,{now:now+7000,model:async()=>{throw new Error('private provider detail');}});
 assert.equal(final.status,'partial');assert.match(final.answer,/calculate/);assert.ok(!final.error.includes('private'));
});
test('stopped run prevents further model requests',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent:profile,prompt:'Hi'});await stopRun(store,session,run.id);
 assert.equal((await runStep(store,session,cfg,run.id,{model:()=>{throw new Error('must not run');}})).status,'cancelled');
});
test('crashed step becomes partial without repeating inference',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent:profile,prompt:'Hi'}),now=Date.now();await store.setJSON(`claims/${session.uid}/${run.id}/0`,{at:now-91000});
 const output=await runStep(store,session,cfg,run.id,{now,model:()=>{throw new Error('must not run');}});assert.equal(output.status,'partial');
});
test('atomic request pacing and daily caps hold under concurrency',async()=>{
 const store=new Store(),now=Date.now();const results=await Promise.allSettled(Array.from({length:10},()=>reserveRequest(store,session,{...cfg,userLimit:2},now)));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 await reserveRequest(store,session,{...cfg,userLimit:2},now+7000);
 await assert.rejects(reserveRequest(store,session,{...cfg,userLimit:2},now+14000),e=>e.status===429&&!e.retryAfter);
});
test('reader blocks private hosts and revalidates redirects',async()=>{
 let reads=0;const fetcher=async()=>{reads++;return new Response('',{status:302,headers:{location:'http://127.0.0.1:8765/api'}});};
 assert.equal((await publicGET('https://127.0.0.1/private',{fetcher})).status,'unsupported');assert.equal(reads,0);
 assert.equal((await publicGET('https://www.bing.com/search?q=test',{fetcher})).status,'unsupported');assert.equal(reads,1);
});
test('tools enforce enabled capability and observed source boundaries',async()=>{
 const state={observed:[],jobs:[]};assert.equal((await invoke('calculate',{a:1,b:2,operation:'add'},state,[])).ok,false);
 assert.equal((await invoke('read_web_page',{url:'https://www.google.com/'},state,['web_research'])).ok,false);
 assert.equal((await invoke('search_company_jobs',{provider:'lever',board:'invented',query:'engineer',location:'Bengaluru'},state,['job_boards'])).ok,false);
});
test('job review keeps unclear experience uncertain and senior roles excluded',()=>{
 const result=reviewJobs([{title:'Software Engineer',location:'Bengaluru',description:'2 years with bachelors or 0 years with masters',source_url:'a',feed_verified:true,application_url:'https://example.com/apply'},{title:'Senior Software Engineer',location:'Bengaluru',description:'6 years of experience',source_url:'b'}]);assert.equal(result.counts.confirmed_match,0);assert.equal(result.counts.uncertain,1);assert.equal(result.counts.excluded,1);
});
test('Gemini compatibility request stays server managed and rejects incomplete tool batches',async()=>{
 let captured;await assert.rejects(chat(cfg,[],[],async(url,options)=>{captured={url,options};return Response.json({choices:[{finish_reason:'length',message:{role:'assistant',content:'truncated'}}]});}));assert.equal(captured.options.headers.Authorization,'Bearer '+cfg.key);assert.equal(JSON.parse(captured.options.body).model,cfg.model);
 await assert.rejects(chat(cfg,[],[],async()=>Response.json({choices:[{finish_reason:'tool_calls',message:{role:'assistant',tool_calls:[{type:'function',id:'bad',function:{name:'calculate',arguments:'not json'}}]}}]})));
});

test('search rejects irrelevant RSS and falls back to bounded public HTML results',async()=>{
 const urls=[],state={observed:[],jobs:[]};
 const result=await invoke('search_web',{query:'junior software engineer jobs Bengaluru'},state,['web_research'],{fetcher:async url=>{urls.push(url);return new Response(url.includes('bing.com')?'<rss><item><title>Junior dictionary definition</title><link>https://example.com/dictionary</link><description>Meaning of junior</description></item></rss>':'<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2Fjobs.lever.co%2Fexample%2F123">Junior software engineer Bengaluru jobs</a><div class="result__snippet">Engineering careers</div></div>');}});
 assert.equal(urls.length,2);assert.equal(result.result.results.length,1);assert.equal(state.observed[0],'https://jobs.lever.co/example/123');
});
test('invalid search arguments explain the exact schema without making requests',async()=>{
 const result=await invoke('search_web',{queries:['jobs']},{observed:[],jobs:[]},['web_research'],{fetcher:()=>{throw new Error('must not fetch');}});assert.equal(result.ok,false);assert.match(result.error,/query \(string\)/);
});

test('LinkedIn text boundaries preserve zero-based ranges and experience requirements',async()=>{
 const url='https://www.linkedin.com/jobs/view/123456/';const state={observed:[url],jobs:[]};
 const result=await invoke('inspect_linkedin_job',{url},state,['web_research'],{fetcher:async()=>new Response('<h1>Junior Engineer</h1><span class="topcard__flavor--bullet">Bengaluru</span><div class="show-more-less-html__markup"><p>Must Have</p><p>0–2 years of professional experience</p></div>')});
 assert.equal(result.result.experience.minimum,0);assert.equal(result.result.experience.status,'stated');
});
test('reviewed final output cannot replace unknown experience with model assertions',async()=>{
 const store=new Store(),run=await createRun(store,session,{agent:profile,prompt:'Review jobs'}),record=await getRun(store,session.uid,run.id);
 record.data.review=reviewJobs([{title:'Software Engineer',location:'Bengaluru',description:'Experience unspecified',source_url:'https://www.linkedin.com/jobs/view/123456/',application_url:null}]);await store.setJSON(`users/${session.uid}/runs/${run.id}`,record.data);
 const result=await runStep(store,session,cfg,run.id,{model:async()=>({role:'assistant',content:'Confirmed match with 1 year of experience. Apply now.'})});
 assert.match(result.answer,/Unknown or ambiguous/);assert.match(result.answer,/destination: not established/);assert.ok(!result.answer.includes('Confirmed match with 1 year'));
});


test('review output preserves a stated zero-year minimum',()=>{
 const review=reviewJobs([{title:'Junior Software Engineer',location:'Bengaluru',description:'0–2 years experience',source_url:'https://www.linkedin.com/jobs/view/123456/'}]);assert.match(reviewedAnswer(review),/0 years minimum stated/);
});

test('hosted browser step pauses without replaying model or performing a server LinkedIn read',async()=>{
 const {browserReply}=await import('../../netlify/lib/engine.mjs');
 const store=new Store(),agent={...profile,capabilities:['web_research']},run=await createRun(store,session,{agent,prompt:'Find junior jobs',useBrowser:true});let models=0;
 const waiting=await runStep(store,session,cfg,run.id,{model:async()=>{models++;return {role:'assistant',content:'',tool_calls:[{id:'search',type:'function',function:{name:'search_linkedin_jobs',arguments:'{"keywords":"junior engineer","location":"Bengaluru"}'}}]};},tool:()=>{throw new Error('No server browser read');}});
 assert.equal(waiting.status,'waiting_browser');assert.equal(waiting.pendingBrowser.commands.length,1);assert.ok(waiting.pendingBrowser.commands[0].readId);
 assert.equal((await runStep(store,session,cfg,run.id)).status,'waiting_browser');assert.equal(models,1);
 await assert.rejects(browserReply(store,{uid:'b'.repeat(64)},run.id,{}),e=>e.status===404);
 await assert.rejects(browserReply(store,session,run.id,{batchId:'wrong',results:[]}),e=>e.status===400);
 const command=waiting.pendingBrowser.commands[0],body={batchId:waiting.pendingBrowser.batchId,results:[{id:command.id,result:{status:'read',url:command.url,links:[{url:'https://www.linkedin.com/jobs/view/123456/',text:'Junior Engineer'},{url:'http://127.0.0.1/private',text:'private'}]}}]};
 const ready=await browserReply(store,session,run.id,body);assert.equal(ready.status,'ready');assert.equal(ready.tool_calls,1);assert.equal(ready.evidence[0].result.result.jobs.length,1);
 assert.equal((await browserReply(store,session,run.id,body)).tool_calls,1);
});
test('browser reply cannot revive a stopped run',async()=>{
 const {browserReply}=await import('../../netlify/lib/engine.mjs');const store=new Store(),run=await createRun(store,session,{agent:{...profile,capabilities:['web_research']},prompt:'jobs',useBrowser:true});
 await runStep(store,session,cfg,run.id,{model:async()=>({role:'assistant',content:'',tool_calls:[{id:'s',function:{name:'search_linkedin_jobs',arguments:'{"keywords":"engineer","location":"Bengaluru"}'}}]})});await stopRun(store,session,run.id);assert.equal((await browserReply(store,session,run.id,{})).status,'cancelled');
});
test('browser normalization rejects mismatched surfaces and preserves unknown verification',async()=>{
 const {browserResult,browserCommand}=await import('../../netlify/lib/browser.mjs');const state={observed:[],jobs:[]},url='https://www.linkedin.com/jobs/view/123456/';
 assert.equal(browserCommand({id:'x',function:{name:'inspect_linkedin_job',arguments:JSON.stringify({url})}},state),null);
 assert.equal(browserResult({url},{status:'read',url:'https://evil.example/',description:'secret'},state).result.status,'browser_unavailable');
 const result=browserResult({url},{status:'read',url,title:'Junior Engineer',location:'Bengaluru',description:'0–2 years experience',application_url:'http://127.0.0.1/private'},state);assert.equal(result.result.application_url,null);assert.equal(result.result.feed_verified,false);assert.equal(state.jobs.length,1);
});

test('a review batched with browser inspection waits for the captured posting',async()=>{
 const {browserReply}=await import('../../netlify/lib/engine.mjs'),store=new Store(),url='https://www.linkedin.com/jobs/view/123456/',agent={...profile,capabilities:['web_research']};const run=await createRun(store,session,{agent,prompt:'inspect',useBrowser:true}),record=await getRun(store,session.uid,run.id);record.data.observed=[url];await store.setJSON(`users/${session.uid}/runs/${run.id}`,record.data);
 const waiting=await runStep(store,session,cfg,run.id,{model:async()=>({role:'assistant',content:'',tool_calls:[{id:'inspect',function:{name:'inspect_linkedin_job',arguments:JSON.stringify({url})}},{id:'review',function:{name:'review_job_results',arguments:'{"location":"Bengaluru","max_experience":2}'}}]})});
 assert.equal(waiting.status,'waiting_browser');const ready=await browserReply(store,session,run.id,{batchId:waiting.pendingBrowser.batchId,results:[{id:'inspect',result:{status:'read',url,title:'Junior Software Engineer',company:'Example',location:'Bengaluru',description:'0–2 years experience',application_url:'https://jobs.lever.co/example/123'}}]});assert.equal(ready.review.counts.uncertain,1);assert.equal(ready.evidence.length,2);assert.equal(ready.review.jobs[0].application_url,'https://jobs.lever.co/example/123');
});

test('saved workflow category persists through authenticated API without leaking to another account',async()=>{
 const {prepareWorkflow}=await import('../../netlify/lib/workflows.mjs'),store=new Store(),environment={AGENTOS_SITE_URL:cfg.origin,AGENTOS_SESSION_SECRET:cfg.secret,GOOGLE_CLIENT_ID:cfg.clientId,GEMINI_API_KEY:cfg.key},handler=createHandler({storeFactory:()=>store,environment});
 const user={kind:'session',uid:'a'.repeat(64),jti:'workflow-session',csrf:'csrf-value',name:'Test',email:'test@example.com'};await store.setJSON('sessions/'+user.jti,{uid:user.uid,expiresAt:Date.now()+60000});const token=await sign(user,cfg),cookie=`${cookieName(cfg)}=${token}`;
 const saved=await handler(new Request(cfg.origin+'/api/agents',{method:'POST',headers:{cookie,origin:cfg.origin,'content-type':'application/json','x-agentos-csrf':user.csrf},body:JSON.stringify({agent:prepareWorkflow('csv-audit','n\n1').agent})}));assert.equal(saved.status,200);const list=await handler(new Request(cfg.origin+'/api/agents',{headers:{cookie}}));const data=await list.json();assert.equal(data.items[0].category,'data');assert.equal(data.items[0].workflowId,'csv-audit');
 const other={...user,uid:'b'.repeat(64),jti:'other-session'};await store.setJSON('sessions/'+other.jti,{uid:other.uid,expiresAt:Date.now()+60000});const otherCookie=`${cookieName(cfg)}=${await sign(other,cfg)}`;const empty=await handler(new Request(cfg.origin+'/api/agents',{headers:{cookie:otherCookie}}));assert.deepEqual((await empty.json()).items,[]);
});

test('knowledge API requires auth and CSRF, scopes preview and removal by account',async()=>{
 const store=new Store(),environment={AGENTOS_SITE_URL:cfg.origin,AGENTOS_SESSION_SECRET:cfg.secret,GOOGLE_CLIENT_ID:cfg.clientId,GEMINI_API_KEY:cfg.key},handler=createHandler({storeFactory:()=>store,environment});
 const user={kind:'session',uid:'a'.repeat(64),jti:'knowledge-test',csrf:'csrf-test',name:'Test',email:'test@example.com'};await store.setJSON('sessions/'+user.jti,{uid:user.uid,expiresAt:Date.now()+60000});const cookie=`${cookieName(cfg)}=${await sign(user,cfg)}`;
 const post=(path,data,headers={})=>handler(new Request(cfg.origin+'/api/'+path,{method:'POST',headers:{cookie,origin:cfg.origin,'content-type':'application/json','x-agentos-csrf':user.csrf,...headers},body:JSON.stringify(data)}));
 assert.equal((await handler(new Request(cfg.origin+'/api/knowledge'))).status,401);
 assert.equal((await post('knowledge',{title:'Notes',text:'Annual allowance is 18 days.'},{'x-agentos-csrf':'wrong'})).status,403);
 const saved=await post('knowledge',{title:'Notes',text:'Annual allowance is 18 days.'});assert.equal(saved.status,200);const {item}=await saved.json();assert.ok(!('text' in item));
 const preview=await post('knowledge/preview',{ids:[item.id],query:'annual allowance'});assert.match((await preview.json()).sources[0].text,/18 days/);
 const foreign={...user,uid:'b'.repeat(64),jti:'knowledge-other'};await store.setJSON('sessions/'+foreign.jti,{uid:foreign.uid,expiresAt:Date.now()+60000});const foreignCookie=`${cookieName(cfg)}=${await sign(foreign,cfg)}`;
 assert.equal((await post('knowledge/preview',{ids:[item.id],query:'annual'},{cookie:foreignCookie})).status,404);
 assert.equal((await post('knowledge/remove',{id:item.id},{cookie:foreignCookie})).status,404);
 assert.equal((await post('knowledge/remove',{id:item.id})).status,200);
});

test('semantic API indexing is explicit, CSRF protected, owner scoped and does not expose vectors',async()=>{
 const {EMBEDDING_DIMENSIONS}=await import('../../netlify/lib/embeddings.mjs');const store=new Store(),environment={AGENTOS_SITE_URL:cfg.origin,AGENTOS_SESSION_SECRET:cfg.secret,GOOGLE_CLIENT_ID:cfg.clientId,GEMINI_API_KEY:cfg.key};let calls=0;
 const handler=createHandler({storeFactory:()=>store,environment,embeddingOptions:{reserve:async()=>{},embed:async(_cfg,texts)=>{calls++;return texts.map(()=>[1,...Array(EMBEDDING_DIMENSIONS-1).fill(0)]);}}});
 const user={kind:'session',uid:'a'.repeat(64),jti:'semantic-api',csrf:'csrf-semantic',name:'Test',email:'test@example.com'};await store.setJSON('sessions/'+user.jti,{uid:user.uid,expiresAt:Date.now()+60000});const cookie=`${cookieName(cfg)}=${await sign(user,cfg)}`;
 const post=(path,data,headers={})=>handler(new Request(cfg.origin+'/api/'+path,{method:'POST',headers:{cookie,origin:cfg.origin,'content-type':'application/json','x-agentos-csrf':user.csrf,...headers},body:JSON.stringify(data)}));
 const {item}=await (await post('knowledge',{title:'Returns policy',text:'Unwanted purchases may be sent back within thirty days.'})).json();assert.equal(calls,0);
 assert.equal((await post('knowledge/index',{id:item.id},{'x-agentos-csrf':'wrong'})).status,403);
 const other={...user,uid:'b'.repeat(64),jti:'semantic-other'};await store.setJSON('sessions/'+other.jti,{uid:other.uid,expiresAt:Date.now()+60000});const otherCookie=`${cookieName(cfg)}=${await sign(other,cfg)}`;
 assert.equal((await post('knowledge/index',{id:item.id},{cookie:otherCookie})).status,404);assert.equal(calls,0);
 const indexed=await post('knowledge/index',{id:item.id});assert.equal((await indexed.json()).item.semanticReady,true);assert.equal(calls,1);
 const preview=await (await post('knowledge/preview',{ids:[item.id],query:'When can customers return merchandise?',semantic:true})).json();assert.equal(preview.sources[0].match,'meaning');assert.ok(!JSON.stringify(preview).includes('vectors'));assert.equal(calls,2);
 const run=await (await post('runs',{agent:profile,prompt:'When can customers return merchandise?',knowledgeIds:[item.id],knowledgeOnly:true,useSemantic:true})).json();assert.equal(run.knowledge.queryCached,true);assert.equal(calls,2);
});
