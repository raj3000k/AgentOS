const origin=location.origin;
let reading=false,account='';
export async function setBrowserAccount(email){const value=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(email));account=[...new Uint8Array(value)].map(n=>n.toString(16).padStart(2,'0')).join('');}
export function browserRequest(action,command){
 const id=crypto.randomUUID();
 return new Promise((resolve,reject)=>{
  const listener=event=>{if(event.source!==window||event.origin!==origin||event.data?.channel!=='agentos-hosted-response'||event.data.id!==id)return;clearTimeout(timer);window.removeEventListener('message',listener);const value=event.data.result;if(value?.error)reject(new Error(value.error));else resolve(value);};
  const timer=setTimeout(()=>{window.removeEventListener('message',listener);reject(new Error('Extension unavailable. Reload the extension, connect from LinkedIn, and use the workspace tab it opens.'));},action==='read'?35000:3000);
  window.addEventListener('message',listener);window.postMessage({channel:'agentos-hosted-request',id,action,command,account},origin);
 });
}
export async function connectedBrowser(){if(reading)return null;try{return (await browserRequest('status')).connected===true;}catch{return false;}}
export async function readBrowser(command){reading=true;try{return await browserRequest('read',{...command,id:command.readId,expires_at:Date.now()/1000+25});}finally{reading=false;}}
