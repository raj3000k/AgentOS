import {getStore} from '@netlify/blobs';
import {settings,HTTPError,cookieName,cookie,nonce,googleLogin,authenticate} from '../lib/auth.mjs';
import {catalog} from '../lib/tools.mjs';
import {dayKey,countClaims} from '../lib/limits.mjs';
import {agentProfile,createRun,getRun,publicRun,runStep,stopRun,generateBrief} from '../lib/engine.mjs';
import {randomUUID} from 'node:crypto';
const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const send=(data,status=200,extra={})=>new Response(JSON.stringify(data),{status,headers:{...headers,...extra}});
async function body(request){if(Number(request.headers.get('content-length')||0)>100000)throw new HTTPError(413,'Request too large.');if(!(request.headers.get('content-type')||'').startsWith('application/json'))throw new HTTPError(400,'Use a JSON request.');const text=await request.text();if(text.length>100000)throw new HTTPError(413,'Request too large.');try{return JSON.parse(text);}catch{throw new HTTPError(400,'Invalid JSON request.');}}
export function createHandler({storeFactory=()=>getStore({name:'agentos-demo',consistency:'strong'}),environment=process.env,verifyGoogle}={}){return async request=>{
 try{
  const cfg=settings(environment),path=new URL(request.url).pathname.replace(/^\/\.netlify\/functions\/api\/?/,'/api/');
  if(path==='/api/health')return send({status:'ok',version:'hosted-mvp-1'});
  if(path==='/api/config'&&request.method==='GET')return send({googleClientId:cfg.clientId,configured:!!cfg.clientId&&cfg.secret.length>=32&&!!cfg.key,model:cfg.model});
  if(path==='/api/auth/nonce'&&request.method==='GET'){const value=await nonce(request,cfg);return send({nonce:value.value},200,{'Set-Cookie':cookie(cookieName(cfg)+'_nonce',value.token,cfg,600)});}
  const store=storeFactory();
  if(path==='/api/auth/google'&&request.method==='POST'){
   const input=await body(request);const value=await googleLogin(request,cfg,store,input.credential,verifyGoogle);
   const response=send({user:{name:value.session.name,email:value.session.email},csrf:value.session.csrf,model:cfg.model});
   response.headers.append('Set-Cookie',cookie(cookieName(cfg),value.token,cfg,8*3600));response.headers.append('Set-Cookie',cookie(cookieName(cfg)+'_nonce','',cfg,0));return response;
  }
  const session=await authenticate(request,cfg,store);
  if(path==='/api/session'&&request.method==='GET')return send({user:{name:session.name,email:session.email},csrf:session.csrf,model:cfg.model,quota:{used:await countClaims(store,`limits/user/${session.uid}/${dayKey()}/`),limit:cfg.userLimit},capabilities:catalog});
  if(path==='/api/logout'&&request.method==='POST'){await store.delete('sessions/'+session.jti);return send({ok:true},200,{'Set-Cookie':cookie(cookieName(cfg),'',cfg,0)});}
  if(path==='/api/context'&&request.method==='POST')return send({agent:await generateBrief(store,session,cfg,(await body(request)).description)});
  if(path==='/api/agents'&&request.method==='GET'){
   const prefix=`users/${session.uid}/agents/`,{blobs}=await store.list({prefix});const items=await Promise.all(blobs.slice(0,30).map(row=>store.get(row.key,{type:'json'})));return send({items:items.filter(Boolean)});
  }
  if(path==='/api/agents'&&request.method==='POST'){
   const input=await body(request),profile=agentProfile(input.agent),id=randomUUID(),prefix=`users/${session.uid}/agents/`,{blobs}=await store.list({prefix});if(blobs.length>=30)throw new HTTPError(400,'This demo supports up to 30 saved agents per user.');const item={id,...profile,createdAt:new Date().toISOString()};await store.setJSON(prefix+id,item);return send({item});
  }
  if(path==='/api/runs'&&request.method==='POST')return send(await createRun(store,session,await body(request)));
  const match=path.match(/^\/api\/runs\/([\da-f-]+)(?:\/(step|stop))?$/);
  if(match){if(request.method==='GET'&&!match[2])return send(publicRun((await getRun(store,session.uid,match[1])).data));if(request.method==='POST'&&match[2]==='step')return send(await runStep(store,session,cfg,match[1]));if(request.method==='POST'&&match[2]==='stop')return send(await stopRun(store,session,match[1]));}
  return send({error:'Not found.'},404);
 }catch(error){if(error instanceof HTTPError)return send({error:error.message,retryAfter:error.retryAfter},error.status,error.retryAfter?{'Retry-After':String(error.retryAfter)}:{});return send({error:'The workspace could not complete this request. Please try again.'},500);}
};}
export default createHandler();
export const config={path:'/api/*'};
