import {analyzeCSV,inspectJSON} from './data-tools.mjs';
import {load} from 'cheerio';
const HOSTS=new Set(['www.bing.com','html.duckduckgo.com','www.linkedin.com','in.linkedin.com','boards-api.greenhouse.io','job-boards.greenhouse.io','boards.greenhouse.io','api.lever.co','jobs.lever.co','careers.google.com','www.google.com','careers.cisco.com','careers.kula.ai','www.amazon.jobs','amazon.jobs']);
export const catalog=[{id:'web_research',label:'Public web research',description:'Search public pages and inspect supported job sources.'},{id:'job_boards',label:'Company job boards',description:'Read published Greenhouse and Lever openings.'},{id:'calculator',label:'Calculator',description:'Validated arithmetic through a trusted function.'},{id:'structured_extraction',label:'Text & JSON inspection',description:'Extract HTTPS links or validate supplied JSON.'},{id:'data_analysis',label:'CSV analysis',description:'Measure rows, missing values and numeric summaries from supplied CSV.'},{id:'writing',label:'Writing & summaries',description:'Draft and summarize supplied material.'},{id:'code_review',label:'Code review',description:'Review supplied code, without executing it.'}];
export const capabilityIds=new Set(catalog.map(row=>row.id));
export function validateCapabilities(ids){if(!Array.isArray(ids)||ids.length>catalog.length||ids.some(id=>!capabilityIds.has(id)))throw new Error('Choose supported hosted capabilities.');return [...new Set(ids)];}
export function safeURL(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&url.href.length<=1800?url.href:null;}catch{return null;}}
export function allowedURL(value){const safe=safeURL(value);if(!safe)return false;const u=new URL(safe);return HOSTS.has(u.hostname)&&(!u.hostname.endsWith('linkedin.com')||/^\/jobs\/(?:view\/(?:[\w-]+-)?\d+\/?|search\/?)$/.test(u.pathname));}
export async function publicGET(value,{fetcher=fetch,timeout=7000}={}){
 let url=value; const signal=AbortSignal.timeout(timeout);
 for(let i=0;i<4;i++){
  if(!allowedURL(url))return {status:'unsupported',error:'This hosted reader supports only its registered public source hosts.'};
  try{
   const response=await fetcher(url,{redirect:'manual',headers:{Accept:'text/html,application/json,application/xml;q=0.9','User-Agent':'AgentOS-Research/0.1'},signal});
   if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get('location'),url).href;continue;}
   if(!response.ok)return {status:'blocked',http_status:response.status,url};
   const reader=response.body.getReader();let size=0;const parts=[];
   try{for(;;){const {value:chunk,done}=await reader.read();if(done)break;size+=chunk.byteLength;if(size>1_000_000){await reader.cancel();return {status:'too_large',url};}parts.push(chunk);}}finally{reader.releaseLock();}
   const text=new TextDecoder().decode(Buffer.concat(parts));
   return {status:'read',http_status:response.status,url,text,checked_at:new Date().toISOString()};
  }catch{return {status:'unavailable',url,error:'Public source could not be read within the deadline.'};}
 }
 return {status:'blocked',error:'Redirect limit reached.'};
}
export function experience(text){
 const evidence=[];for(const match of String(text).matchAll(/\b(\d{1,2})\s*(?:(?:-|–|to)\s*(\d{1,2}))?\s*\+?\s*(?:years?|yrs?)\b/gi)){
  const quote=text.slice(Math.max(0,match.index-55),match.index+match[0].length+100).replace(/\s+/g,' ');
  if(/prefer|nice.to.have|company has|company with|founded/i.test(quote))continue;
  const n=Number(match[1]);if(n<=30)evidence.push({minimum:n,quote:quote.slice(0,190)});
 }
 if(!evidence.length)return {status:'unknown',minimum:null,evidence:[]};
 if(new Set(evidence.map(e=>e.minimum)).size>1&&/\bor\b/i.test(text))return {status:'ambiguous',minimum:null,evidence:evidence.slice(0,3)};
 return {status:'stated',minimum:Math.max(...evidence.map(e=>e.minimum)),evidence:evidence.slice(0,3)};
}
export function reviewJobs(observations,{location='Bengaluru',max_experience=2}={}){
 const jobs=[...new Map(observations.map(j=>[j.source_url,j])).values()].map(job=>{
  const role=job.title||'',senior=/senior|staff|principal|manager|\bII\b|\bIII\b|intern|\bSDE\s*[2-9]|test engineer/i.test(role),match=/software|frontend|backend|full.?stack|\bsde\b|developer/i.test(role),loc=job.location||'',city=/bangalore|bengaluru/i.test(location)?/bangalore|bengaluru/i.test(loc):loc.toLowerCase().includes(location.toLowerCase()),exp=job.experience||experience(job.description||'');
  let category='uncertain';const reasons=[];
  if(senior||exp.minimum!==null&&exp.minimum>max_experience){category='excluded';reasons.push(senior?'Role seniority does not match':'Minimum required experience exceeds criterion');}
  else if(loc&&!city){category='excluded';reasons.push('Location does not match');}
  else if(!match||!city||exp.status!=='stated'){reasons.push('Role, city or experience remains unknown/ambiguous');}
  else if(job.feed_verified&&job.application_url){category='confirmed_match';reasons.push('Matching collected criteria and exact published employer-feed record');}
  else reasons.push('Exact current employer-feed publication not established');
  if(/no longer accepting applications|this job is closed/i.test(job.description||'')){category='closed';reasons.push('Explicit closure notice');}
  return {...job,description:undefined,quality_category:category,reasons,experience:exp};
 });
 const counts=Object.fromEntries(['confirmed_match','uncertain','excluded','closed','blocked'].map(name=>[name,jobs.filter(j=>j.quality_category===name).length]));
 return {status:'reviewed',criteria:{location,max_experience},counts,jobs:jobs.slice(0,12),note:'Confirmed means exact feed publication plus collected matching criteria, not guaranteed hiring or independent employer identity. Unknown evidence stays uncertain.'};
}
const schema=(name,description,properties,required=Object.keys(properties))=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const str=description=>({type:'string',description});
const schemas={
 analyze_csv:schema('analyze_csv','Measure supplied CSV: up to 12000 characters, 200 rows and 30 columns. No formula evaluation.',{csv_text:str('CSV text including a unique header row')}),
 inspect_json:schema('inspect_json','Validate and describe supplied JSON without executing it.',{text:str('JSON text up to 12000 characters')}),
 calculate:schema('calculate','Perform validated arithmetic.',{a:{type:'number'},b:{type:'number'},operation:{type:'string',enum:['add','subtract','multiply','divide','power','modulo']}}),
 extract_links:schema('extract_links','Extract HTTPS links from supplied text.',{text:str('Text up to 12000 characters')}),
 search_web:schema('search_web','Search public web sources. Results are candidates; never assume job validity.',{query:str('Specific search query up to 180 characters')}),
 read_web_page:schema('read_web_page','Read an observed supported public source. No login, forms or general browser control.',{url:str('Exact HTTPS URL observed in current tool results')}),
 search_linkedin_jobs:schema('search_linkedin_jobs','Read public LinkedIn job candidates; may be blocked. No authenticated tab access in hosted mode.',{keywords:str('Role keywords'),location:str('City')}),
 inspect_linkedin_job:schema('inspect_linkedin_job','Inspect a numeric LinkedIn job posting and exposed apply anchors.',{url:str('Observed numeric LinkedIn job posting URL')}),
 search_company_jobs:schema('search_company_jobs','Read published employer Greenhouse/Lever feed. Board ID must come from an observed source; do not invent IDs.',{provider:{type:'string',enum:['greenhouse','lever']},board:str('Observed employer board identifier'),query:str('Role keywords'),location:str('City')}),
 review_job_results:schema('review_job_results','Review actual current-run captured postings. Always use before a final job-search answer.',{location:str('Requested city'),max_experience:{type:'number',minimum:0,maximum:20}})
};
export function toolSchemas(capabilities){const names=[];if(capabilities.includes('calculator'))names.push('calculate');if(capabilities.includes('structured_extraction'))names.push('extract_links','inspect_json');if(capabilities.includes('data_analysis'))names.push('analyze_csv');if(capabilities.includes('web_research'))names.push('search_web','read_web_page','search_linkedin_jobs','inspect_linkedin_job');if(capabilities.includes('job_boards'))names.push('search_company_jobs');if(capabilities.some(c=>['web_research','job_boards'].includes(c)))names.push('review_job_results');return names.map(n=>schemas[n]);}
function cleanText($,selector){const root=$(selector).first();return root.find('*').addBack().contents().filter((_,node)=>node.type==='text').map((_,node)=>$(node).text()).get().join(' ').replace(/\s+/g,' ').trim();}
function remember(state,value){for(const row of value.results||[])if(safeURL(row.url))state.observed.push(row.url);for(const row of value.jobs||[])if(safeURL(row.source_url))state.observed.push(row.source_url);state.observed=[...new Set(state.observed)].slice(-100);return value;}
export async function invoke(name,args,state,capabilities,options={}){
 if(!toolSchemas(capabilities).some(s=>s.function.name===name))return {ok:false,error:'Tool is not enabled.'};
 const spec=schemas[name].function.parameters;
 if(!args||typeof args!=='object'||Object.keys(args).some(k=>!(k in spec.properties))||spec.required.some(k=>!(k in args))||Object.entries(spec.properties).some(([k,s])=>typeof args[k]!==s.type))return {ok:false,error:'Invalid tool arguments. Expected: '+Object.entries(spec.properties).map(([key,value])=>key+' ('+value.type+')').join(', ')+'. No extra fields.'};
 try{
  if(name==='analyze_csv')return {ok:true,result:analyzeCSV(args.csv_text)};
  if(name==='inspect_json')return {ok:true,result:inspectJSON(args.text)};
  if(name==='calculate'){
   const {a,b,operation}=args;const operations={add:()=>a+b,subtract:()=>a-b,multiply:()=>a*b,divide:()=>a/b,power:()=>a**b,modulo:()=>a%b};
   if(!Number.isFinite(a)||!Number.isFinite(b)||Math.abs(a)>1e12||Math.abs(b)>1e12||!operations[operation])throw new Error('Unsupported arithmetic.');
   const result=operations[operation]();if(!Number.isFinite(result))throw new Error('Arithmetic result is not finite.');return {ok:true,result};
  }
  if(name==='extract_links'){if(args.text.length>12000)throw new Error('Text too long.');return {ok:true,result:{links:[...new Set((args.text.match(/https:\/\/[^\s<>"']+/g)||[]).map(safeURL).filter(Boolean))].slice(0,30)}};}
  if(name==='review_job_results'){if(!Number.isFinite(args.max_experience)||args.max_experience<0||args.max_experience>20||args.location.length>100)throw new Error('Invalid review criteria.');const result=reviewJobs(state.jobs,args);state.review=result;return {ok:true,result};}
  const get=url=>publicGET(url,options);
  if(name==='search_web'){
   if(!args.query.trim()||args.query.length>180)throw new Error('Use one query string up to 180 characters.');
   const query=args.query.trim(),tokens=query.toLowerCase().match(/[a-z0-9]{3,}/g)||[],terms=[...new Set(tokens.filter(t=>!['the','and','for','with','site','com','www','https','jobs','job','hiring','current'].includes(t)))];
   const relevant=row=>{const text=(row.title+' '+row.snippet+' '+row.url).toLowerCase();return terms.filter(term=>text.includes(term)).length>=Math.min(2,terms.length)&&(!/jobs?|hiring|openings?|careers?/i.test(query)||/jobs?|hiring|openings?|careers?|recruit|vacanc/i.test(text));};
   const bing=await get('https://www.bing.com/search?q='+encodeURIComponent(query)+'&format=rss');let results=[];const attempts=[{provider:'bing',status:bing.status}];
   if(bing.status==='read'){const $=load(bing.text,{xml:true});$('item').slice(0,15).each((_,node)=>{const url=safeURL($(node).find('link').text());if(url)results.push({title:$(node).find('title').text().slice(0,180),url,snippet:$(node).find('description').text().slice(0,300)});});results=results.filter(relevant);}
   if(!results.length){const fallback=await get('https://html.duckduckgo.com/html/?q='+encodeURIComponent(query));attempts.push({provider:'duckduckgo',status:fallback.status});if(fallback.status==='read'){const $=load(fallback.text);$('.result').slice(0,15).each((_,node)=>{const anchor=$(node).find('a.result__a').first();try{const link=new URL(anchor.attr('href'),'https://html.duckduckgo.com'),url=safeURL(link.searchParams.get('uddg')||link.href);const row={title:anchor.text().trim().slice(0,180),url,snippet:$(node).find('.result__snippet').text().trim().slice(0,300)};if(url&&relevant(row))results.push(row);}catch{}});}}
   return {ok:true,result:remember(state,{status:results.length?'read':'no_relevant_results',results:results.slice(0,8),attempts,checked_at:new Date().toISOString(),note:'Search snippets are unverified. Irrelevant candidates are discarded. No results means source/relevance limitations, not proof that no jobs exist. Try the dedicated public LinkedIn search tool for job discovery.'})};
  }
  if(name==='search_linkedin_jobs'){
   if(args.keywords.length>120||args.location.length>100)throw new Error('Search terms too long.');
   const page=await get('https://www.linkedin.com/jobs/search/?keywords='+encodeURIComponent(args.keywords)+'&location='+encodeURIComponent(args.location));if(page.status!=='read')return {ok:true,result:page};
   const $=load(page.text),jobs=[];
   $('a[href*="/jobs/view/"]').each((_,node)=>{const raw=$(node).attr('href'),match=raw?.match(/\/jobs\/view\/(?:[\w-]+-)?(\d+)/);if(match&&!jobs.some(j=>j.job_id===match[1]))jobs.push({job_id:match[1],title:$(node).text().replace(/\s+/g,' ').trim().slice(0,180),source_url:'https://www.linkedin.com/jobs/view/'+match[1]+'/',verification:'search_candidate'});});
   return {ok:true,result:remember(state,{status:jobs.length?'read':'no_results_or_login_required',jobs:jobs.slice(0,8),checked_at:page.checked_at})};
  }
  if(name==='read_web_page'||name==='inspect_linkedin_job'){
   const url=safeURL(args.url);if(!url||!state.observed.includes(url))throw new Error('Read an exact URL observed during this run first.');
   if(name==='inspect_linkedin_job'&&!/^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/?$/.test(url))throw new Error('Use a numeric LinkedIn job URL.');
   const page=await get(url);if(page.status!=='read')return {ok:true,result:page};const $=load(page.text);$('script,style,nav,header,footer,aside,form').remove();
   if(name==='read_web_page') { const results=[]; $('a[href]').each((_,node)=>{try{const target=safeURL(new URL($(node).attr('href'),page.url).href);if(target&&results.length<30)results.push({url:target,title:$(node).text().trim().slice(0,120)});}catch{}}); return {ok:true,result:remember(state,{status:'read',url:page.url,title:cleanText($,'title'),text:$('main').text().trim().slice(0,6000)||$('body').text().trim().slice(0,6000),results,checked_at:page.checked_at})}; }
   const description=cleanText($,'.show-more-less-html__markup')||cleanText($,'.description__text');let target='';
   $('a[href]').each((_,node)=>{const href=$(node).attr('href');if(!target&&/apply/i.test($(node).text())){try{const parsed=new URL(href,url);target=safeURL(parsed.searchParams.get('url')||parsed.href)||'';}catch{}}});
   const job={title:cleanText($,'h1'),company:cleanText($,'.topcard__org-name-link'),location:cleanText($,'.topcard__flavor--bullet'),description:description.slice(0,12000),experience:experience(description),source_url:url,application_url:target||null,checked_at:page.checked_at,feed_verified:false};
   if(job.title&&description)state.jobs.push(job);
   return {ok:true,result:{...job,status:description?'read':'login_required_or_unavailable'}};
  }
  if(name==='search_company_jobs'){
   if(!['greenhouse','lever'].includes(args.provider)||!/^[-\w]{1,64}$/.test(args.board)||args.query.length>100||args.location.length>100)throw new Error('Invalid board/query.');
   const boardSeen=state.observed.some(value=>{try{const u=new URL(value);return (args.provider==='greenhouse'?['boards.greenhouse.io','job-boards.greenhouse.io','boards-api.greenhouse.io']:['jobs.lever.co','api.lever.co']).includes(u.hostname)&&u.pathname.split('/').includes(args.board);}catch{return false;}});if(!boardSeen)throw new Error('First discover the employer board in search or page results.');
   const url=args.provider==='greenhouse'?`https://boards-api.greenhouse.io/v1/boards/${args.board}/jobs?content=true`:`https://api.lever.co/v0/postings/${args.board}?mode=json`;
   const page=await get(url);if(page.status!=='read')return {ok:true,result:page};const payload=JSON.parse(page.text),rows=args.provider==='greenhouse'?payload.jobs:payload;
   if(!Array.isArray(rows))throw new Error('Invalid feed.');const q=args.query.toLowerCase().split(/\W+/).filter(v=>v.length>1),city=args.location.toLowerCase();const jobs=[];
   for(const row of rows){const title=row.title||row.text||'',location=row.location?.name||row.categories?.location||'';if(q.length&&!q.some(term=>title.toLowerCase().includes(term)))continue;if(city&&!location.toLowerCase().includes(city)&&!(/bengaluru|bangalore/.test(city)&&/bengaluru|bangalore/i.test(location)))continue;const description=load(row.content||row.description||'').text();const source_url=safeURL(row.absolute_url||row.hostedUrl);if(!source_url)continue;jobs.push({title,company:args.board,location,description:description.slice(0,12000),experience:experience(description),source_url,application_url:safeURL(row.applyUrl||row.absolute_url),feed_verified:true,checked_at:page.checked_at});if(jobs.length>=8)break;}
   state.jobs.push(...jobs);state.jobs=state.jobs.slice(-30);return {ok:true,result:remember(state,{status:'read',jobs:jobs.map(j=>({...j,description:j.description.slice(0,2500)})),checked_at:page.checked_at,note:'Exact published API records; employer identity and application acceptance are not independently guaranteed.'})};
  }
  return {ok:false,error:'Unknown registered tool.'};
 }catch(error){return {ok:false,error:error.message.length<180?error.message:'Tool could not complete.'};}
}
