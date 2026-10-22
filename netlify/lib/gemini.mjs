import {HTTPError} from './auth.mjs';
export async function chat(cfg,messages,tools=[],fetcher=fetch){
 if(!cfg.key)throw new HTTPError(503,'The demo model is not configured yet.');
 let response;
 try{response=await fetcher('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.key},body:JSON.stringify({model:cfg.model,messages,stream:false,...(tools.length?{tools}:{}),max_tokens:3500}),signal:AbortSignal.timeout(32000)});}catch{throw new HTTPError(502,'The model request timed out. Collected evidence is retained.');}
 if(!response.ok){const hints={400:'The provider rejected this request.',401:'The server model credential was rejected.',403:'The server model is not accessible.',404:'The configured model is unavailable.',429:'Gemini quota or rate limit reached. Collected evidence is retained.',503:'Gemini is temporarily unavailable. Collected evidence is retained.'};throw new HTTPError(response.status===429?429:502,hints[response.status]||'The model request failed. Collected evidence is retained.');}
 const bytes=await response.arrayBuffer();if(bytes.byteLength>2_000_000)throw new HTTPError(502,'The model response exceeded its size limit.');
 let payload;try{payload=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new HTTPError(502,'The model returned an unreadable response.');}
 const choice=payload.choices?.[0],message=choice?.message;
 if(!['stop','tool_calls'].includes(choice?.finish_reason)||message?.role!=='assistant'||!Array.isArray(message.tool_calls||[])||message.content!=null&&typeof message.content!=='string')throw new HTTPError(502,'The model did not return a complete response.');
 const ids=new Set();
 for(const call of message.tool_calls||[]){
  let args;try{args=JSON.parse(call.function?.arguments);}catch{throw new HTTPError(502,'The model returned an invalid tool call. No tools in that batch ran.');}
  if(call.type!=='function'||typeof call.id!=='string'||ids.has(call.id)||!call.id||typeof call.function?.name!=='string'||!args||typeof args!=='object'||Array.isArray(args))throw new HTTPError(502,'The model returned an invalid tool call.');
  ids.add(call.id);
 }
 return {...message,content:message.content||''};
}
