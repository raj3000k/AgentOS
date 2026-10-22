const hostedOrigin='https://agentos-workspace-raj.netlify.app';
let hostedWorking=false;
const hostedReads=new Map();
async function hostedState(){const {hostedConnection:c}=await chrome.storage.session.get('hostedConnection');if(!c||c.expiresAt<Date.now())return {connected:false};try{const tab=await chrome.tabs.get(c.tabId),workspace=await chrome.tabs.get(c.workspaceTabId);return {connected:isLinkedInTab(tab)&&workspace.id===c.workspaceTabId&&(!workspace.url||new URL(workspace.url).origin===hostedOrigin),workspaceTabId:c.workspaceTabId};}catch{return {connected:false};}}
async function connectHosted(){
 if(working||hostedWorking)throw new Error('Wait for the current tab read to finish.');
 const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
 if(!isLinkedInTab(tab))throw new Error('Open LinkedIn and click AgentOS there, then connect.');
 const check=await chrome.scripting.executeScript({target:{tabId:tab.id},func:checkLinkedInOrigin});if(check[0]?.result!==true)throw new Error('The tab is no longer on LinkedIn.');
 const workspace=await chrome.tabs.create({url:hostedOrigin+'/?companion=connected'});
 await chrome.storage.session.remove('connection');
 await chrome.storage.session.set({hostedConnection:{tabId:tab.id,workspaceTabId:workspace.id,expiresAt:Date.now()+8*3600000}});hostedReads.clear();return {connected:true};
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 const panel=sender.id===chrome.runtime.id&&sender.url===chrome.runtime.getURL('sidepanel.html');
 let page=false;try{page=sender.id===chrome.runtime.id&&sender.frameId===0&&new URL(sender.url).origin===hostedOrigin;}catch{}
 if(!message?.type?.startsWith('hosted-')||!panel&&!page)return;
 (async()=>{
  if(panel){if(message.type==='hosted-connect')return connectHosted();if(message.type==='hosted-status')return hostedState();if(message.type==='hosted-disconnect'){await chrome.storage.session.remove('hostedConnection');return {connected:false};}throw new Error('Unsupported hosted panel action.');}
  const {hostedConnection:c}=await chrome.storage.session.get('hostedConnection');
  if(!c||c.workspaceTabId!==sender.tab.id||c.expiresAt<Date.now())return {connected:false,error:'Connect LinkedIn from the extension to this workspace tab.'};
  if(!/^[a-f0-9]{64}$/.test(message.account||'')||c.account&&c.account!==message.account)return {connected:false,error:'Account changed. Reconnect LinkedIn from the extension.'};
  if(!c.account){c.account=message.account;await chrome.storage.session.set({hostedConnection:c});}
  if(message.type==='hosted-status')return hostedState();
  if(message.type==='hosted-disconnect'){await chrome.storage.session.remove('hostedConnection');return {connected:false};}
  const command=message.command;
  if(message.type!=='hosted-read'||!command||typeof command.id!=='string'||command.id.length>100||!allowed(command.url)||!Number.isFinite(command.expires_at)||command.expires_at<=Date.now()/1000||command.expires_at>Date.now()/1000+35)throw new Error('Unsupported or expired job read.');
  if(hostedReads.has(command.id)){const cached=hostedReads.get(command.id);if(cached.url!==command.url)throw new Error('Read ID mismatch.');return cached.result;}
  if(working||hostedWorking)throw new Error('Another job read is in progress.');
  hostedWorking=true;working=true;
  try{
   const tab=await chrome.tabs.get(c.tabId);if(!isLinkedInTab(tab))throw new Error('The connected tab left LinkedIn. Reconnect it.');
   await chrome.tabs.update(c.tabId,{url:command.url});
   const result=await readWhenReady(c.tabId,{...command,hosted:true});
   hostedReads.set(command.id,{url:command.url,result});if(hostedReads.size>30)hostedReads.delete(hostedReads.keys().next().value);return result;
  }finally{hostedWorking=false;working=false;}
 })().then(value=>respond(value)).catch(error=>respond({error:error.message}));return true;
});
chrome.tabs.onRemoved.addListener(async id=>{const {hostedConnection:c}=await chrome.storage.session.get('hostedConnection');if(c&&(c.tabId===id||c.workspaceTabId===id))await chrome.storage.session.remove('hostedConnection');});
