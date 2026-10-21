const base = 'http://127.0.0.1:8765/api/linkedin/';
let working = false;
const allowed = url => {
  try {
    const u = new URL(url);
    if (u.origin !== 'https://www.linkedin.com' || u.hash) return false;
    if (/^\/jobs\/view\/\d+\/?$/.test(u.pathname) && !u.search) return true;
    return u.pathname === '/jobs/search/' && [...u.searchParams.keys()].every(k => ['keywords','location','start'].includes(k));
  } catch { return false; }
};
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only our own popup may choose a tab; page content has no connection controls.
  if (sender.id !== chrome.runtime.id || ![chrome.runtime.getURL('popup.html'),chrome.runtime.getURL('sidepanel.html')].includes(sender.url)) return;
  if (!['connect','disconnect'].includes(message.type)) return;
  (async () => {
    if (message.type === 'connect') {
      await chrome.storage.session.set({connection:{tabId:message.tabId,code:message.code}});
      await chrome.alarms.create('poll',{periodInMinutes:0.5});
      poll();
    } else if (message.type === 'disconnect') {
      const {connection} = await chrome.storage.session.get('connection');
      await chrome.storage.session.remove('connection');
      if (connection) await fetch(base+'disconnect',{method:'POST',headers:{'Content-Type':'application/json','X-AgentOS-Bridge':connection.code},body:'{}'}).catch(()=>{});
    }
    respond({ok:true});
  })();
  return true;
});
// This fixed function reads only job surfaces, excluding messaging/profile/account UI.
function readJobPage() {
  if (location.origin !== 'https://www.linkedin.com') return {status:'session_unavailable'};
  const visible = node => !!node && node.getClientRects().length > 0;
  const visibleChallenge=[...document.querySelectorAll('iframe[src*="captcha"]')].some(frame=>{
    const box=frame.getBoundingClientRect(),style=getComputedStyle(frame);
    return box.width>150 && box.height>100 && box.bottom>0 && box.right>0 && box.top<innerHeight && box.left<innerWidth
      && style.display!=='none' && style.visibility!=='hidden';
  });
  if (/authwall|checkpoint|login|challenge/.test(location.pathname) || visibleChallenge)
    return {status:'login_required',error:'Log in or complete verification yourself in the selected tab.'};
  const root = document.querySelector('main,[role="main"]') || document.querySelector('.jobs-search__job-details--container') || document.querySelector('.job-view-layout') || document.body;
  if (!root) return {status:'no_job_details',error:'LinkedIn job layout is unavailable. Open the Jobs page and reconnect.'};
  const text = selector => { const node=root.querySelector(selector); return visible(node) ? node.innerText.trim() : ''; };
  const links = [...root.querySelectorAll('a[href*="/jobs/view/"]')].filter(visible).slice(0,100)
    .map(a=>({text:a.innerText.trim().slice(0,180),url:a.href}));
  const apply = [...root.querySelectorAll('a[href]')].find(a=>{
    if(!visible(a))return false;
    const label=(a.innerText+' '+(a.getAttribute('aria-label')||'')).trim();
    return /apply.*company website/i.test(label) || /^apply$/i.test(label)
      || /apply/i.test(label) && (a.id==='jobs-apply-button-id' || /jobs-apply-button/.test(a.className));
  });
  // New LinkedIn job layouts use generic containers rather than the classic card classes.
  const pageTitle=(document.title||'').split(' | ');
  const titleParts=pageTitle.at(-1)==='LinkedIn'?pageTitle.slice(0,-1):[];
  const pageText=root.innerText||'';
  const about=pageText.indexOf('About the job');
  const header=about>=0?pageText.slice(0,about):'';
  let modernDescription='';
  if(about>=0){
    modernDescription=pageText.slice(about+'About the job'.length);
    const boundary=modernDescription.search(/\n(?:Job search faster with Premium|About the company|Similar jobs|Set alert for similar jobs)\b/i);
    // Without a known end boundary do not share an unscoped body suffix (messaging/account UI).
    if(boundary>=0)modernDescription=modernDescription.slice(0,boundary);else modernDescription='';
  }
  const description = text('#job-details') || text('.jobs-description') || text('.show-more-less-html__markup') || modernDescription.trim();
  const city=header.match(/(?:Bengaluru|Bangalore)[^\n]{0,120}/i)?.[0]||'';
  return {status:'read',url:location.href,links,
    title:text('h1') || (titleParts.length>=2?titleParts.slice(0,-1).join(' | '):''),company:text('.job-details-jobs-unified-top-card__company-name') || text('.topcard__org-name-link') || (titleParts.length>=2?titleParts.at(-1):''),
    location:text('.job-details-jobs-unified-top-card__primary-description-container') || text('.topcard__flavor--bullet') || city,
    description:description.slice(0,20000),application_url:apply?.href || '',
    easy_apply:[...root.querySelectorAll('button')].some(b=>visible(b)&&/easy apply/i.test(b.innerText+' '+b.getAttribute('aria-label')))};
}
async function readWhenReady(tabId, command) {
  const requested = new URL(command.url);
  let partial;
  while (Date.now()/1000 < command.expires_at - 2) {
    const {connection} = await chrome.storage.session.get('connection');
    if (!connection || connection.tabId !== tabId) return {status:'session_disconnected'};
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'loading' || tab.pendingUrl) { await new Promise(resolve=>setTimeout(resolve,700)); continue; }
    const current = new URL(tab.url || 'about:blank');
    if (current.origin !== 'https://www.linkedin.com' || /authwall|checkpoint|login|challenge/.test(current.pathname))
      return {status:'login_required',error:'Please sign in or finish verification yourself.'};
    if (current.pathname !== requested.pathname || (requested.pathname === '/jobs/search/' &&
        ['keywords','location','start'].some(k=>(current.searchParams.get(k)||'0')!==(requested.searchParams.get(k)||'0'))))
      return {status:'session_unavailable',error:'Selected tab navigated away from the requested job page.'};
    const results = await chrome.scripting.executeScript({target:{tabId},func:readJobPage});
    const result = results[0]?.result;
    if (result?.status === 'read' && result.title && requested.pathname !== '/jobs/search/') partial = result;
    if (result?.status === 'login_required' || result?.status === 'read' &&
        (requested.pathname === '/jobs/search/' ? result.links.length : result.title && result.description)) return result;
    await new Promise(resolve=>setTimeout(resolve,700));
  }
  if (partial) return {...partial,description_status:'partial',note:'Posting description did not load completely before the deadline. Available fields are partial evidence; do not infer missing requirements or confirmed availability.'};
  return {status:'no_job_details',error:'Job page did not finish loading within the read deadline.'};
}
async function poll() {
  if (working) {
    try {
      const {connection}=await chrome.storage.session.get('connection');
      if (!connection) return;
      const tab=await chrome.tabs.get(connection.tabId);
      if (!/^https:\/\/www\.linkedin\.com\//.test(tab.url||'')) return;
      await fetch(base+'heartbeat',{headers:{'X-AgentOS-Bridge':connection.code}});
    } catch { /* Unavailable tabs must not refresh connection status. */ }
    return;
  }
  working = true;
  let connection;
  try {
    ({connection} = await chrome.storage.session.get('connection'));
    if (!connection) return;
    const tab = await chrome.tabs.get(connection.tabId);
    if (!/^https:\/\/www\.linkedin\.com\//.test(tab.url || '')) throw new Error('Selected tab left LinkedIn');
    const response = await fetch(base+'poll',{headers:{'X-AgentOS-Bridge':connection.code}});
    if (!response.ok) { if (response.status===403) await chrome.storage.session.remove('connection'); return; }
    const {command} = await response.json();
    if (!command || command.expires_at <= Date.now()/1000 || !allowed(command.url)) return;
    let result;
    try {
      // Navigation only. Never run page-provided or model-provided JavaScript.
      await chrome.tabs.update(connection.tabId,{url:command.url});
      result = await readWhenReady(connection.tabId,command);
    } catch { result={status:'session_unavailable',error:'Cannot read the selected tab. Reconnect from the extension.'}; }
    await fetch(base+'reply',{method:'POST',headers:{'Content-Type':'application/json','X-AgentOS-Bridge':connection.code},body:JSON.stringify({id:command.id,...result})});
  } catch { /* A closed or inaccessible tab stops heartbeat; the UI shows disconnected. */ }
  finally { working = false; }
}
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='poll')poll();});
// A connected worker stays active through regular loopback requests; alarm restarts it if suspended.
setInterval(poll,1500);
chrome.tabs.onRemoved.addListener(async id=>{
  const {connection}=await chrome.storage.session.get('connection');
  if(connection?.tabId===id)await chrome.storage.session.remove('connection');
});

importScripts('companion.js');

if(typeof module!=='undefined' && module.exports)module.exports={readJobPage,readWhenReady};
