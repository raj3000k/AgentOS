/* Exact-origin, top-frame transport. No cookies, auth tokens or API keys cross this channel. */
if(window===window.top&&location.origin==='https://agentos-workspace-raj.netlify.app'){
 let pending=false;
 window.addEventListener('message',async event=>{
  const input=event.data;
  if(event.source!==window||event.origin!==location.origin||input?.channel!=='agentos-hosted-request'||typeof input.id!=='string'||input.id.length>80||!['status','read','disconnect'].includes(input.action)||pending)return;
  pending=true;let result;
  try{result=await chrome.runtime.sendMessage({type:'hosted-'+input.action,command:input.command,account:input.account});}catch{result={error:'Reload the AgentOS extension and reconnect LinkedIn.'};}
  finally{pending=false;}
  window.postMessage({channel:'agentos-hosted-response',id:input.id,result},location.origin);
 });
}
