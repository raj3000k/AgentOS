import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {SignJWT,jwtVerify,createRemoteJWKSet} from 'jose';
const googleKeys=createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export class HTTPError extends Error {constructor(status,message,retryAfter){super(message);this.status=status;this.retryAfter=retryAfter;}}
export function settings(env=process.env){
 const origin=new URL(env.AGENTOS_SITE_URL||env.URL||'http://localhost:8888').origin;
 const local=new URL(origin).hostname==='localhost'||new URL(origin).hostname==='127.0.0.1';
 if(!origin.startsWith('https://')&&!local)throw new Error('Hosted origin must use HTTPS');
 return {origin,secure:!local,clientId:env.GOOGLE_CLIENT_ID||'',secret:env.AGENTOS_SESSION_SECRET||'',model:env.GEMINI_MODEL||'gemini-3.5-flash-lite',key:env.GEMINI_API_KEY||'',userLimit:Math.min(50,Math.max(1,Number(env.AGENTOS_USER_DAILY_LIMIT)||24)),globalLimit:Math.min(400,Math.max(1,Number(env.AGENTOS_GLOBAL_DAILY_LIMIT)||160))};
}
export const cookieName=cfg=>cfg.secure?'__Host-agentos':'agentos_dev';
export function cookies(request){return Object.fromEntries((request.headers.get('cookie')||'').split(';').map(part=>{const i=part.indexOf('=');return i<0?[]:[part.slice(0,i).trim(),part.slice(i+1)];}).filter(row=>row.length===2));}
export function cookie(name,value,cfg,maxAge){return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${cfg.secure?'; Secure':''}`;}
export function sameOrigin(request,cfg){if(request.headers.get('origin')!==cfg.origin)throw new HTTPError(403,'Request origin rejected. Reload the workspace.');}
const key=cfg=>{if(cfg.secret.length<32)throw new HTTPError(503,'Sign-in is not configured yet.');return new TextEncoder().encode(cfg.secret);};
export async function sign(value,cfg,lifetime='8h'){return new SignJWT(value).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime(lifetime).setIssuer('agentos').setAudience(cfg.origin).sign(key(cfg));}
export async function verify(value,cfg){try{return (await jwtVerify(value,key(cfg),{algorithms:['HS256'],issuer:'agentos',audience:cfg.origin})).payload;}catch{throw new HTTPError(401,'Sign in to continue.');}}
export async function nonce(request,cfg){const value=randomBytes(24).toString('base64url');return {value,token:await sign({nonce:value,kind:'login'},cfg,'10m')};}
export async function googleLogin(request,cfg,store,credential,verifyGoogle=async value=>(await jwtVerify(value,googleKeys,{issuer:['https://accounts.google.com','accounts.google.com'],audience:cfg.clientId,algorithms:['RS256']})).payload){
 sameOrigin(request,cfg);
 if(!cfg.clientId)throw new HTTPError(503,'Google sign-in is not configured yet.');
 if(typeof credential!=='string'||credential.length>16000)throw new HTTPError(400,'Invalid sign-in response.');
 let claims;try{claims=await verifyGoogle(credential);}catch{throw new HTTPError(401,'Google sign-in could not be verified. Please try again.');}
 const proof=await verify(cookies(request)[cookieName(cfg)+'_nonce'],cfg);
 if(proof.kind!=='login'||typeof claims.nonce!=='string'||typeof proof.nonce!=='string'||claims.nonce!==proof.nonce||claims.email_verified!==true||typeof claims.sub!=='string'||!claims.sub||typeof claims.email!=='string')throw new HTTPError(401,'Google sign-in could not be verified. Please try again.');
 const uid=createHash('sha256').update('google:'+claims.sub).digest('hex');
 const session={uid,name:String(claims.given_name||claims.name||'Your workspace').slice(0,80),email:claims.email.slice(0,254),csrf:randomBytes(24).toString('base64url'),jti:randomBytes(24).toString('base64url'),kind:'session'};
 const expiresAt=Date.now()+8*3600_000;
 await store.setJSON('sessions/'+session.jti,{uid,expiresAt},{metadata:{expiresAt}});
 return {session,token:await sign(session,cfg)};
}
export async function authenticate(request,cfg,store){
 const value=cookies(request)[cookieName(cfg)];
 if(!value)throw new HTTPError(401,'Sign in to continue.');
 const session=await verify(value,cfg);
 if(session.kind!=='session'||!/^\w{64}$/.test(session.uid||'')||typeof session.jti!=='string'||typeof session.csrf!=='string')throw new HTTPError(401,'Sign in to continue.');
 const record=await store.get('sessions/'+session.jti,{type:'json'});
 if(!record||record.uid!==session.uid||record.expiresAt<Date.now())throw new HTTPError(401,'Your session expired. Sign in again.');
 if(request.method!=='GET'){
  sameOrigin(request,cfg);
  const a=Buffer.from(request.headers.get('x-agentos-csrf')||''),b=Buffer.from(session.csrf);
  if(a.length!==b.length||!timingSafeEqual(a,b))throw new HTTPError(403,'Reload the workspace before trying again.');
 }
 return session;
}
