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
export async function readBrowser(command){if(reading)throw new Error('Wait for the current browser read to finish.');reading=true;try{const raw=await browserRequest('read',{...command,id:command.readId,expires_at:Date.now()/1000+25});const text=(value,n)=>typeof value==='string'?value.slice(0,n):'';return {status:text(raw?.status,40),url:text(raw?.url,1800),title:text(raw?.title,180),company:text(raw?.company,180),location:text(raw?.location,200),description:text(raw?.description,6000),description_status:raw?.description?.length>6000?'partial':text(raw?.description_status,20),application_url:text(raw?.application_url,1800),links:new URL(command.url).pathname==='/jobs/search/'?(Array.isArray(raw?.links)?raw.links:[]).slice(0,12).map(row=>({url:text(row?.url,500),text:text(row?.text,180)})):[]};}finally{reading=false;}}
