const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const listeners=[],store={},calls=[];
let active={id:1,url:'https://example.com/article'}, token='w'.repeat(32), runtimeSender,holdStream=false,pendingController,extractor;
global.chrome={
 runtime:{id:'test-extension',getURL:path=>'chrome-extension://test-extension/'+path,onMessage:{addListener:fn=>listeners.push(fn)}},
 storage:{session:{get:async keys=>{if(typeof keys==='string')return {[keys]:store[keys]};return Object.fromEntries(keys.map(key=>[key,store[key]]));},set:async values=>Object.assign(store,JSON.parse(JSON.stringify(values))),remove:async key=>{delete store[key];}}},
 tabs:{query:async()=>[active],onRemoved:{addListener:()=>{}}},scripting:{executeScript:async({func})=>{extractor=func;return [{result:{title:'Source '+active.id,url:active.url,text:'Visible article facts',checked_at:'2026-10-20T00:00:00Z',truncated:false}}];}},
 alarms:{create:async()=>{},onAlarm:{addListener:()=>{}}},
 action:{onClicked:{addListener:()=>{}}},sidePanel:{open:async()=>{}}
};
global.crypto=require('node:crypto').webcrypto;
global.fetch=async(url,options={})=>{
 calls.push({url,options});
 if(url.endsWith('/'))return {ok:true,text:async()=>`<meta name="agentos-token" content="${token}">`};
 if(url.endsWith('/api/run/stop')){if(pendingController){pendingController.enqueue(new TextEncoder().encode(JSON.stringify({type:'result',data:{content:'Stopped with collected context.',model_calls:1,tool_calls:0,elapsed:1,finish_reason:'cancelled',conversation:[]}})+'\n'));pendingController.close();pendingController=null;}return {ok:true};}
 assert.ok(url.endsWith('/api/run/stream'));
 assert.equal(options.headers['X-AgentOS-Token'],token);
 const events=[{type:'started',run_id:JSON.parse(options.body).run_id},{type:'model_start',step:1,max_steps:16},
 {type:'result',data:{content:'A clear answer.',model_calls:2,tool_calls:0,elapsed:1,finish_reason:'completed',conversation:[{prompt:'previous',answer:'A clear answer.',evidence:[],status:'completed'}]}}];
 return {ok:true,body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode((holdStream?events.slice(0,2):events).map(event=>JSON.stringify(event)).join('\n')+'\n'));if(holdStream)pendingController=controller;else controller.close();}})};
};
const realInterval=global.setInterval;global.setInterval=()=>0;
global.importScripts=path=>require('../src/agentos/static/linkedin-extension/'+path);
const background=require('../src/agentos/static/linkedin-extension/background.js');global.setInterval=realInterval;
const sender={id:'test-extension',url:'chrome-extension://test-extension/sidepanel.html'};
function message(type,extra={}){return new Promise(resolve=>{for(const listener of listeners)listener({type,...extra},sender,resolve);});}
async function idle(){for(let i=0;i<50;i++){const state=await message('companion-state');if(!state.running)return state;await new Promise(resolve=>setTimeout(resolve,2));}throw new Error('Run did not settle');}

test('explicit sources, bounded permissions, source tray, stream and retained follow-up context',async()=>{
 assert.match((await message('companion-run',{payload:{prompt:'Hello',settings:{provider:'ollama',model:'fixture'}}})).error,/Connect/);
 active={id:1,url:'chrome://settings'};assert.match((await message('companion-add')).error,/HTTPS/);
 for(let i=1;i<=4;i++){active={id:i,url:`https://example.com/${i}`};assert.equal((await message('companion-add')).sources.length,i);}
 active={id:5,url:'https://example.com/5'};assert.match((await message('companion-add')).error,/four/);
 active={id:1,url:'https://example.com/refreshed'};assert.equal((await message('companion-add')).sources.length,4);
 assert.deepEqual(await message('companion-connect'),{connected:true});
 const payload={prompt:'Compare these pages',settings:{provider:'ollama',model:'fixture',base_url:'http://localhost:11434'}};
 assert.equal((await message('companion-run',{payload})).started,true);
 let state=await idle();assert.equal(state.turns[0].answer,'A clear answer.');
 const body=JSON.parse(calls.find(call=>call.url.endsWith('/api/run/stream')).options.body);
 assert.match(body.prompt,/USER-SELECTED PAGE SNAPSHOTS/);assert.match(body.prompt,/Visible article facts/);
 assert.equal(body.save_history,false);assert.equal(body.plan_task,false);assert.deepEqual(body.capabilities,['calculator']);assert.equal(body.history.length,0);
 assert.equal(state.turns[0].sources.length,4);assert.equal(state.history,undefined);
 assert.ok(!JSON.stringify(store).includes(token));
 await message('companion-remove',{tabId:1});assert.equal((await message('companion-state')).sources.length,3);
 assert.equal((await message('companion-run',{payload:{...payload,prompt:'Follow up'}})).started,true);await idle();
 const bodies=calls.filter(call=>call.url.endsWith('/api/run/stream')).map(call=>JSON.parse(call.options.body));
 assert.equal(bodies[1].history.length,1);
 assert.match((await message('companion-run',{payload:{...payload,settings:{provider:'ollama',model:'changed'}}})).error,/new conversation/);
 await message('companion-clear');state=await message('companion-state');assert.equal(state.sources.length,0);assert.equal(state.turns.length,0);
 let called=false;assert.equal(listeners[0]({type:'companion-state'},{id:'test-extension',url:'https://evil.test/'},()=>called=true),undefined);assert.equal(called,false);
});
test('fixed snapshot extractor excludes forms/hidden text and preserves bounded observed links',()=>{
 const parent=excluded=>({closest:()=>excluded,getClientRects:()=>excluded?[]:[{}]});
 const nodes=[{parentElement:parent(false),textContent:'Visible source facts.'},{parentElement:parent(true),textContent:'PRIVATE FORM SECRET'}];
 const anchors=[{href:'https://example.com/apply/123',innerText:'Exact observed link',closest:()=>false,getClientRects:()=>[{}]},
 {href:'javascript:alert(1)',innerText:'Unsafe',closest:()=>false,getClientRects:()=>[{}]}];
 const root={querySelectorAll:()=>anchors};let index=0;
 global.document={title:'Snapshot fixture',body:root,querySelector:()=>root,createTreeWalker:()=>({nextNode:()=>nodes[index++]||null})};
 global.location={href:'https://example.com/source'};global.NodeFilter={SHOW_TEXT:4};global.getComputedStyle=()=>({visibility:'visible',display:'block'});
 const snapshot=extractor();assert.match(snapshot.text,/Visible source facts/);assert.ok(!snapshot.text.includes('PRIVATE'));
 assert.equal(snapshot.links.length,1);assert.equal(snapshot.links[0].url,'https://example.com/apply/123');
 assert.ok(snapshot.text.length+JSON.stringify(snapshot.links).length<=3500);
 delete global.document;delete global.location;delete global.NodeFilter;delete global.getComputedStyle;
});
test('Stop reaches workspace and credentials never enter persisted chat state',async()=>{
 await message('companion-clear');holdStream=true;
 const payload={prompt:'Research this',plan:true,settings:{provider:'gemini',model:'fixture',api_key:'private-provider-key'}};
 assert.equal((await message('companion-run',{payload})).started,true);
 assert.match((await message('companion-clear')).error,/Stop/);
 await message('companion-stop');const state=await idle();holdStream=false;
 assert.equal(state.turns[0].finishReason,'cancelled');
 assert.ok(calls.some(call=>call.url.endsWith('/api/run/stop')));
 assert.equal(JSON.parse(calls.filter(call=>call.url.endsWith('/api/run/stream')).at(-1).options.body).plan_task,true);
 assert.ok(!JSON.stringify(store).includes('private-provider-key'));
 await message('companion-clear');
});
test('extension uses packaged inert renderer and minimal permission scope',()=>{
 const root='src/agentos/static/';
 assert.equal(fs.readFileSync(root+'output.js','utf8'),fs.readFileSync(root+'linkedin-extension/output.js','utf8'));
 const manifest=JSON.parse(fs.readFileSync(root+'linkedin-extension/manifest.json','utf8'));
 assert.ok(manifest.permissions.includes('sidePanel'));
 assert.deepEqual(manifest.host_permissions,['http://127.0.0.1:8765/*']);
 assert.ok(!manifest.permissions.includes('tabs'));assert.ok(!manifest.permissions.includes('cookies'));assert.ok(!manifest.action.default_popup);
 const html=fs.readFileSync(root+'linkedin-extension/sidepanel.html','utf8');
 assert.ok(!html.includes('<select'));assert.ok(html.includes('data-provider="ollama"'));
});

test('LinkedIn ignores hidden CAPTCHA widgets but pauses for visible challenges',()=>{
 let challenge={width:0,height:0,top:0,left:0,bottom:0,right:0};
 global.location={origin:'https://www.linkedin.com',pathname:'/jobs/search/',href:'https://www.linkedin.com/jobs/search/'};
 global.innerWidth=1000;global.innerHeight=800;global.getComputedStyle=()=>({display:'block',visibility:'visible'});
 const root={querySelector:()=>null,querySelectorAll:()=>[]};
 global.document={querySelector:()=>root,querySelectorAll:()=>[{getBoundingClientRect:()=>challenge}]};
 assert.equal(background.readJobPage().status,'read');
 challenge={width:300,height:300,top:50,left:50,bottom:350,right:350};
 assert.equal(background.readJobPage().status,'login_required');
 challenge={...challenge,top:900,bottom:1200};assert.equal(background.readJobPage().status,'read');
 global.location.pathname='/checkpoint/challenge';assert.equal(background.readJobPage().status,'login_required');
 delete global.document;delete global.location;delete global.getComputedStyle;delete global.innerWidth;delete global.innerHeight;
});

test('modern LinkedIn job page extracts scoped details and visible company apply anchor',()=>{
 global.location={origin:'https://www.linkedin.com',pathname:'/jobs/view/123/',href:'https://www.linkedin.com/jobs/view/123/'};
 global.innerWidth=1000;global.innerHeight=800;global.getComputedStyle=()=>({display:'block',visibility:'visible'});
 const anchor={innerText:'Apply on company website',href:'https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fexample.com%2Fjobs%2F123',getClientRects:()=>[{}],getAttribute:()=>'',className:''};
 const root={innerText:'Software Engineer\nBengaluru, Karnataka, India · 4 days ago\nAbout the job\nRequired experience: 0-2 years. Build React software.\nAbout the company\nPRIVATE ACCOUNT CONTENT',querySelector:()=>null,querySelectorAll:selector=>selector==='a[href]'?[anchor]:[]};
 global.document={title:'Software Engineer | Example | LinkedIn',body:root,querySelector:()=>null,querySelectorAll:()=>[]};
 const result=background.readJobPage();
 assert.equal(result.title,'Software Engineer');assert.equal(result.company,'Example');assert.match(result.location,/Bengaluru/);
 assert.match(result.description,/Required experience/);assert.ok(!result.description.includes('PRIVATE'));assert.equal(result.application_url,anchor.href);
 root.innerText='About the job\nMissing a safe end boundary';assert.equal(background.readJobPage().description,'');
 delete global.document;delete global.location;delete global.getComputedStyle;delete global.innerWidth;delete global.innerHeight;
});


test('posting deadline preserves partial observed fields but not empty or navigated pages',async()=>{
 const oldNow=Date.now,oldTimeout=global.setTimeout,oldGet=chrome.tabs.get,oldExecute=chrome.scripting.executeScript;
 let now=1000000;
 Date.now=()=>now+=1000;global.setTimeout=fn=>{fn();return 0;};
 store.connection={tabId:7,code:'test'};
 const url='https://www.linkedin.com/jobs/view/123/';
 chrome.tabs.get=async()=>({url,status:'complete'});
 let observed={status:'read',title:'Software Engineer I',description:'',application_url:'https://example.com/jobs/123',url};
 chrome.scripting.executeScript=async()=>[{result:observed}];
 try{
  const result=await background.readWhenReady(7,{url,expires_at:1004});
  assert.equal(result.description_status,'partial');assert.equal(result.application_url,observed.application_url);
  assert.equal(result.description,'');assert.match(result.note,/partial evidence/);
  now=1000000;observed={status:'read',title:'',description:''};
  assert.equal((await background.readWhenReady(7,{url,expires_at:1004})).status,'no_job_details');
  now=1000000;chrome.tabs.get=async()=>({url:'https://www.linkedin.com/feed/',status:'complete'});
  assert.equal((await background.readWhenReady(7,{url,expires_at:1004})).status,'session_unavailable');
 }finally{Date.now=oldNow;global.setTimeout=oldTimeout;chrome.tabs.get=oldGet;chrome.scripting.executeScript=oldExecute;delete store.connection;}
});


test('one-click LinkedIn pairing validates current tab permission and keeps credentials internal',async()=>{
 const oldFetch=global.fetch,oldExecute=chrome.scripting.executeScript,oldGet=chrome.tabs.get;
 let paired=false,pairCalls=0;
 const bridge='b'.repeat(43);
 global.fetch=async(url,options={})=>{
  if(url.endsWith('/api/linkedin/pair')){pairCalls++;assert.equal(options.headers['X-AgentOS-Token'],token);return {ok:true,json:async()=>({code:bridge})};}
  if(url.endsWith('/api/linkedin/heartbeat')){assert.equal(options.headers['X-AgentOS-Bridge'],bridge);paired=true;return {ok:true};}
  if(url.endsWith('/api/linkedin/status'))return {ok:true,json:async()=>({connected:paired,paired})};
  return oldFetch(url,options);
 };
 chrome.tabs.get=async()=>active;
 try{
  active={id:77,url:'https://example.com/'};
  assert.match((await message('companion-linkedin-connect')).error,/Open LinkedIn/);assert.equal(pairCalls,0);
  active={id:77,url:'https://www.linkedin.com/jobs/'};
  chrome.scripting.executeScript=async()=>{throw new Error('No activeTab grant');};
  assert.match((await message('companion-linkedin-connect')).error,/toolbar icon/);assert.equal(pairCalls,0);
  chrome.scripting.executeScript=async()=>[{result:true}];
  assert.deepEqual(await message('companion-linkedin-connect'),{connected:true});
  assert.equal(pairCalls,1);assert.equal(store.connection.tabId,77);assert.equal(store.connection.code,bridge);
  const state=await message('companion-state');
  assert.equal(state.linkedinTab.connected,true);assert.equal(state.linkedinTab.current,true);
  assert.ok(!JSON.stringify(state).includes(bridge));assert.ok(!JSON.stringify(store).includes(token));
  const html=fs.readFileSync('src/agentos/static/linkedin-extension/sidepanel.html','utf8');
  assert.ok(html.includes('Connect this LinkedIn tab'));assert.ok(!html.includes('id="linkedin-code"'));
  paired=false;assert.equal((await message('companion-state')).linkedinTab.connected,false);
 }finally{global.fetch=oldFetch;chrome.scripting.executeScript=oldExecute;chrome.tabs.get=oldGet;delete store.connection;}
});
