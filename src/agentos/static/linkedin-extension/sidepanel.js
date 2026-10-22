const $=id=>document.getElementById(id);
const element=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
let state={}, settings={provider:'ollama',model:'qwen3:8b',base_url:'http://localhost:11434',api_key:''}, chatSignature='', sourceSignature='', refreshing=false, followAnswer=false, connectingLinkedIn=false;
async function message(type,extra={}) {
  const result=await chrome.runtime.sendMessage({type,...extra});
  if (!result || result.error) throw new Error(result?.error || 'Extension unavailable. Reload it in Chrome Extensions.');
  return result;
}
function notice(text) {
  const target=$('settings').open ? $('settings-notice') : $('notice');
  target.textContent=text;target.hidden=!text;
}
function showSettings(){ $('settings-notice').hidden=true;$('settings').showModal(); }
function updateProvider(){
  const local=$('provider').value==='ollama';
  $('key-row').hidden=local;$('api-key').required=!local;
  $('endpoint-row').hidden=!['ollama','custom'].includes($('provider').value);
  $('endpoint').required=!$('endpoint-row').hidden;
  $('provider-note').textContent=local?'Prompts and selected page text go to your local Ollama server.':'Prompts, selected page text and tool results go to your selected provider. API charges may apply.';
  for(const button of document.querySelectorAll('[data-provider]'))button.setAttribute('aria-pressed',String(button.dataset.provider===$('provider').value));
}
for(const button of document.querySelectorAll('[data-provider]'))button.addEventListener('click',()=>{
  if($('provider').value!==button.dataset.provider){
    $('provider').value=button.dataset.provider;$('api-key').value='';
    $('model').value=button.dataset.provider==='ollama'?'qwen3:8b':'';
    $('endpoint').value=button.dataset.provider==='ollama'?'http://localhost:11434':'';
  }
  updateProvider();
});
function renderSources(sources){
  const signature=JSON.stringify(sources);
  if(signature===sourceSignature)return;sourceSignature=signature;
  $('source-count').textContent=`${sources.length} / 4`;$('source-list').replaceChildren();
  for(const source of sources){
    const card=element('div',undefined,'source-card');card.append(element('span','▤','source-icon'));
    const info=element('div',undefined,'source-info'), details=element('details'),summary=element('summary');
    summary.append(element('strong',source.title || 'Untitled page'));details.append(summary);
    const stamp=new Date(source.checked_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const domain=new URL(source.url).hostname;
    info.append(details,element('small',`${domain} · ${stamp}${source.truncated?' · excerpt':''}`));
    const preview=element('div',source.text,'source-preview');
    for(const link of source.links||[]){const safe=AgentOSOutput.linkURL(link.url);if(!safe)continue;const anchor=element('a',link.text||link.url);anchor.href=safe;anchor.target='_blank';anchor.rel='noopener noreferrer';preview.append(element('br'),anchor);}
    details.append(preview);
    const remove=element('button','×','remove-source');remove.setAttribute('aria-label','Remove '+(source.title||'source'));remove.disabled=state.running;
    remove.addEventListener('click',()=>act('companion-remove',{tabId:source.tabId}));card.append(info,remove);$('source-list').append(card);
  }
  $('source-hint').textContent=sources.length?'Snapshots are fixed excerpts. Add the current tab again to refresh it. New chat clears earlier context.':'Click the AgentOS toolbar icon on a page, then add it here. Only pages you add are shared.';
}
function renderChat(turns){
  const signature=JSON.stringify(turns);if(signature===chatSignature)return;chatSignature=signature;
  const shouldScroll=followAnswer || document.documentElement.scrollHeight-window.scrollY-window.innerHeight<220;
  $('welcome').hidden=turns.length>0;$('conversation').replaceChildren();
  for(const turn of turns){
    const article=element('article',undefined,'turn');article.append(element('div',turn.prompt,'user-message'));
    if(turn.answer){
      article.append(element('div','AGENTOS','answer-label'));
      const answer=element('div',undefined,'answer');AgentOSOutput.render(answer,turn.answer);article.append(answer);
      if(turn.sources?.length){const sources=element('details',undefined,'source-references');sources.append(element('summary',`Used ${turn.sources.length} selected page snapshot${turn.sources.length===1?'':'s'}`));for(const source of turn.sources){const link=element('a',source.title||source.url);link.href=source.url;link.target='_blank';link.rel='noopener noreferrer';sources.append(link);}article.append(sources);}
      article.append(element('div',turn.metrics||'', 'metrics'));
      const actions=element('div',undefined,'turn-actions');
      const copy=element('button','Copy','text-button');copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(turn.answer);copy.textContent='Copied';}catch{notice('Copy unavailable. Select the answer to copy it.');}});
      const download=element('button','Save .md ↓','text-button');download.addEventListener('click',()=>AgentOSOutput.download(turn.answer,'agentos-answer.md','text/markdown'));
      actions.append(copy,download);article.append(actions);
    }
    $('conversation').append(article);
  }
  if(shouldScroll)requestAnimationFrame(()=>window.scrollTo({top:document.documentElement.scrollHeight,behavior:'smooth'}));
  if(turns.at(-1)?.answer)followAnswer=false;
}
async function refresh(){
  if(refreshing)return;refreshing=true;
  try{
    state=await message('companion-state');
    $('connection-dot').classList.toggle('connected',state.connected);
    $('connection-label').textContent=state.connected?'Connected to AgentOS':'Your local workspace';
    $('connection-description').textContent=state.connected?'Local connection · you choose the model':'Start AgentOS, then connect to begin.';
    $('connect-workspace').textContent=state.connected?'Connected':'Connect';$('connect-workspace').disabled=state.connected;
    $('send').disabled=!state.connected||state.running;
    $('new-chat').disabled=state.running;$('add-source').disabled=state.running;$('open-settings').disabled=state.running;$('model-button').disabled=state.running;
    const tab=state.linkedinTab||{}, linked=tab.connected;
    $('linkedin-badge').textContent=linked?'CONNECTED':tab.paired?'RECONNECT NEEDED':'NOT CONNECTED';
    $('linkedin-badge').classList.toggle('is-connected',!!linked);
    $('linkedin-title').textContent=linked?'LinkedIn is ready.':tab.eligible?'Your tab. Ready to work.':'Bring your LinkedIn tab.';
    $('linkedin-description').textContent=linked?'Your agent can research jobs in the connected tab. Keep it open and logged in.':tab.eligible?'Connect this tab directly to AgentOS. No codes, no switching windows.':'Open LinkedIn and click the AgentOS toolbar icon there, then return here to connect.';
    $('connect-linkedin').textContent=connectingLinkedIn?'Connecting…':linked&&tab.current?'Connected to this tab':linked?'Use this LinkedIn tab':'Connect this LinkedIn tab ↗';
    $('connect-linkedin').disabled=connectingLinkedIn||state.running||!tab.eligible||linked&&tab.current;
    $('disconnect-linkedin').hidden=!tab.paired;$('disconnect-linkedin').disabled=state.running||connectingLinkedIn;
    renderSources(state.sources||[]);renderChat(state.turns||[]);
    $('progress').hidden=!state.running&&!state.activity?.length;
    $('progress').classList.toggle('running',state.running);$('progress-label').textContent=state.status;
    $('stop-run').hidden=!state.running;
    $('activity').replaceChildren(...(state.activity||[]).map(text=>element('li',text)));
    $('plan').replaceChildren(...(state.plan?.steps||[]).map(step=>element('li',`${step.title} · ${step.status.replaceAll('_',' ')}`,step.status)));
    $('completion-note').textContent=state.plan?.checks ? (state.plan.checks.all_steps_marked_completed?'All steps marked complete by the model.':'Some plan steps remain unfinished.')+' These checks do not independently verify the answer.':'';
    if(state.error)notice(state.error);
  }catch(error){notice(error.message);}
  finally{refreshing=false;}
}
async function saveSafeSettings(){
  const {api_key,...safe}=settings;
  await chrome.storage.session.set({companionSettings:{...safe,web:$('web-research').checked,linkedin:$('linkedin-research').checked,plan:$('plan-task').checked}});
}
async function act(type,extra={}){try{notice('');await message(type,extra);await refresh();}catch(error){notice(error.message);}}
$('connect-workspace').addEventListener('click',()=>act('companion-connect'));
$('add-source').addEventListener('click',()=>act('companion-add'));
$('new-chat').addEventListener('click',()=>act('companion-new'));
$('stop-run').addEventListener('click',()=>act('companion-stop'));
$('open-settings').addEventListener('click',showSettings);$('model-button').addEventListener('click',showSettings);
$('close-settings').addEventListener('click',()=>$('settings').close());
$('settings-form').addEventListener('submit',async event=>{
  event.preventDefault();
  settings={provider:$('provider').value,model:$('model').value.trim(),base_url:['ollama','custom'].includes($('provider').value)?$('endpoint').value.trim():'',api_key:$('api-key').value.trim()};
  await saveSafeSettings();
  $('model-button').textContent='◈ '+settings.model;
  $('sharing-note').textContent=settings.provider==='ollama'?'Selected page snapshots go to your local model when you send.':'Selected page snapshots go to '+settings.provider+' when you send.';
  $('settings').close();notice(state.turns?.length?'Changed model or capabilities? Start a new chat before sending.':'');
});
$('connect-linkedin').addEventListener('click',async()=>{
  if(connectingLinkedIn)return;
  connectingLinkedIn=true;$('connect-linkedin').disabled=true;$('connect-linkedin').textContent='Connecting…';
  try{
    notice('');await message('companion-linkedin-connect');
    $('linkedin-research').checked=true;await saveSafeSettings();
    notice('LinkedIn connected. Job research is enabled for your next task.');
  }catch(error){notice(error.message);}
  finally{connectingLinkedIn=false;await refresh();}
});
$('disconnect-linkedin').addEventListener('click',async()=>{try{await message('disconnect');$('linkedin-research').checked=false;await saveSafeSettings();await refresh();notice('LinkedIn disconnected.');}catch(error){notice(error.message);}});
$('disconnect-workspace').addEventListener('click',()=>act('companion-disconnect'));
$('clear-session').addEventListener('click',()=>act('companion-clear'));
for(const button of document.querySelectorAll('[data-prompt]'))button.addEventListener('click',()=>{$('prompt').value=button.dataset.prompt;$('prompt').focus();});
$('chat-form').addEventListener('submit',async event=>{
  event.preventDefault();const prompt=$('prompt').value.trim();if(!prompt)return;
  if(settings.provider!=='ollama'&&!settings.api_key){showSettings();notice('Enter your API key for this panel session.');return;}
  try{notice('');await message('companion-run',{payload:{prompt,settings,web:$('web-research').checked,linkedin:$('linkedin-research').checked,plan:$('plan-task').checked}});$('prompt').value='';followAnswer=true;await refresh();}
  catch(error){notice(error.message);}
});
(async()=>{
  const stored=await chrome.storage.session.get('companionSettings');
  if(stored.companionSettings){const saved=stored.companionSettings;settings={...settings,...saved,api_key:''};$('provider').value=settings.provider;$('model').value=settings.model;$('endpoint').value=settings.base_url;$('web-research').checked=!!saved.web;$('plan-task').checked=!!saved.plan;$('linkedin-research').checked=!!saved.linkedin;$('model-button').textContent='◈ '+settings.model;}
  updateProvider();await refresh();setInterval(refresh,1000);
})();

async function refreshHosted(){try{const value=await message('hosted-status');$('hosted-status').textContent=value.connected?'Connected. Run your agent in the linked AgentOS website tab.':'Not connected. Open LinkedIn, click the extension icon, then connect.';$('hosted-disconnect').hidden=!value.connected;}catch(error){$('hosted-status').textContent=error.message;}}
$('hosted-connect').addEventListener('click',async()=>{$('hosted-connect').disabled=true;try{await message('hosted-connect');await refreshHosted();}catch(error){$('hosted-status').textContent=error.message;}finally{$('hosted-connect').disabled=false;}});
$('hosted-disconnect').addEventListener('click',async()=>{await message('hosted-disconnect');await refreshHosted();});
refreshHosted();setInterval(refreshHosted,4000);

$('toggle-local').addEventListener('click',()=>{const open=$('local-workspace').hidden;$('local-workspace').hidden=!open;$('local-composer').hidden=!open;$('open-settings').hidden=!open;$('new-chat').hidden=!open;$('toggle-local').setAttribute('aria-expanded',String(open));$('toggle-local').textContent=open?'Hide local companion':'Use local companion instead';});
