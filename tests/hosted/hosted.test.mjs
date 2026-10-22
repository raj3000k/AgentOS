import test from 'node:test';
import assert from 'node:assert/strict';
import {settings,nonce,googleLogin,authenticate,sign,cookieName} from '../../netlify/lib/auth.mjs';
import {createRun,runStep,getRun,stopRun} from '../../netlify/lib/engine.mjs';
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
