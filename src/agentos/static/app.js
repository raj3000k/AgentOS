const $ = id => document.getElementById(id);
let provider = 'ollama';
const selections = {};
let running = false;
let activeRunId = null;
let conversation = [];
let conversationSettings = null;
let conversationBlocked = false;
let draft = null;
let rawAnswer = '';
let activeSavedId = null;
let activeStarterPrompts = [];
let storageEnabled = false;
const libraryOffsets = {agents:0, runs:0};
let capabilityCatalog = [];
let catalogReady = false;
let activePurpose = 'A general assistant, ready for your task.';
const setStatus = (id, text, error = false) => { $(id).textContent = text; $(id).className = error ? 'status error' : 'status'; };
function showView(view) {
  $('studio-view').hidden = view !== 'studio';
  $('run-view').hidden = view !== 'run';
  $('library-view').hidden = view !== 'library';
  $('page-label').textContent = view === 'studio' ? 'Agent studio' : view === 'library' ? 'My library' : 'Run workspace';
  document.querySelectorAll('[data-view]').forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  if (view === 'library') { libraryOffsets.agents = 0; libraryOffsets.runs = 0; loadLibrary(); }
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function conversationSignature() {
  return JSON.stringify({provider, model:$('model').value.trim(), endpoint:(provider === 'ollama' || provider === 'custom') ? $('endpoint').value.trim() : '', instructions:$('instructions').value, capabilities:selectedCapabilities('run-capabilities')});
}
function updateConversation() {
  const count = conversation.length;
  $('conversation-label').textContent = count ? `Conversation · ${count} ${count === 1 ? 'reply' : 'replies'} retained` : 'New conversation';
  $('conversation-note').textContent = conversationBlocked ? 'Context is full. Start a new conversation to continue.' : count ? 'Your follow-up includes earlier replies and tool evidence. Saving this turn also saves that context.' : 'The first task starts a conversation. Context stays in this page unless you save a run.';
  $('prompt-label').textContent = count ? 'Follow up with your agent' : 'Give your agent a task';
  $('prompt').placeholder = count ? 'Refine the answer, ask a question, or request another step…' : 'What would you like your agent to work on?';
  $('conversation-turns').replaceChildren();
  // Keep all turns expandable; the latest reply also appears in the answer card.
  for (const [index, turn] of conversation.entries()) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${index + 1}. ${turn.prompt.slice(0, 100)}${turn.prompt.length > 100 ? '…' : ''}`;
    const prompt = document.createElement('p'); prompt.textContent = turn.prompt;
    const answer = document.createElement('div'); answer.className = 'formatted-answer';
    // Render on expansion so a long conversation does not block the workspace.
    details.addEventListener('toggle', () => { if (details.open && !answer.hasChildNodes()) AgentOSOutput.render(answer, turn.answer); });
    const note = document.createElement('p'); note.className = 'hint';
    note.textContent = `${turn.status.replaceAll('_',' ')} · ${turn.evidence.length} historical tool results · may be stale`;
    details.append(summary, prompt, answer, note);
    $('conversation-turns').append(details);
  }
  $('conversation-turns').hidden = count === 0;
}
function resetChangedConversation() {
  if (!conversation.length || conversationSettings === conversationSignature()) return;
  resetConversation(false);
  setStatus('status', 'Instructions, capabilities or model connection changed. The next task starts a new conversation.');
}
function resetConversation(clearPrompt = true) {
  conversation = [];
  conversationSettings = null;
  conversationBlocked = false;
  $('result').hidden = true;
  $('activity').hidden = true;
  if (clearPrompt) $('prompt').value = '';
  updateConversation();
}
$('new-conversation').addEventListener('click', () => {
  if (running) return;
  resetConversation();
  setStatus('status', 'New conversation started. Earlier context will not be sent. Saved runs remain in My library.');
  $('prompt').focus();
});
function updateConnectionLabel() {
  $('connection-label').textContent = `${provider === 'ollama' ? 'Ollama' : provider} / ${$('model').value.trim() || 'Choose a model'}`;
}
function chooseProvider(next) {
  if (provider !== next) {
    selections[provider] = { model: $('model').value, endpoint: $('endpoint').value };
    $('api-key').value = '';
    provider = next;
    $('model').value = selections[next]?.model || (next === 'ollama' ? 'qwen3:8b' : '');
    $('endpoint').value = selections[next]?.endpoint || (next === 'ollama' ? 'http://localhost:11434' : '');
  }
  const local = provider === 'ollama';
  $('key-fields').hidden = local;
  $('api-key').required = !local;
  $('endpoint-fields').hidden = !(local || provider === 'custom');
  $('endpoint').required = local || provider === 'custom';
  $('api-providers').hidden = local;
  $('model-help').textContent = local ? 'Enter an installed Ollama model. Use ollama list to see yours.' : 'Enter the exact model ID available to your provider account.';
  $('privacy').textContent = local ? 'Prompts go to your local Ollama server.' : 'Prompts and tool results go to your selected provider. API charges may apply.';
  document.querySelectorAll('[data-mode]').forEach(button => {
    const selected = button.dataset.mode === (local ? 'local' : 'api');
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('[data-provider]').forEach(button => {
    const selected = button.dataset.provider === provider;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  updateConnectionLabel();
  resetChangedConversation();
}
function validateConnection() {
  if (!$('connection-form').checkValidity()) {
    $('model-dialog').showModal();
    $('connection-form').reportValidity();
    return false;
  }
  return true;
}
function connectionPayload() {
  return { provider, model: $('model').value.trim(), api_key: provider === 'ollama' ? '' : $('api-key').value.trim(), base_url: (provider === 'ollama' || provider === 'custom') ? $('endpoint').value.trim() : '', timeout: Number($('timeout').value) };
}
async function request(path, payload, statusId, pending) {
  running = true;
  const controls = [...document.querySelectorAll('input,textarea,button')];
  const previouslyDisabled = new Set(controls.filter(control => control.disabled));
  controls.forEach(control => control.disabled = true);
  document.querySelectorAll('main').forEach(element => element.setAttribute('aria-busy', 'true'));
  setStatus(statusId, pending);
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AgentOS-Token': document.querySelector('meta[name="agentos-token"]').content }, body: JSON.stringify(payload) });
    const result = path === '/api/run/stream' && response.ok ? await readRunStream(response) : await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  } finally {
    payload.api_key = '';
    activeRunId = null;
    $('stop-run').hidden = true;
    running = false;
    controls.forEach(control => control.disabled = previouslyDisabled.has(control));
    document.querySelectorAll('main').forEach(element => element.setAttribute('aria-busy', 'false'));
  }
}
function recordActivity(text) {
  const item = document.createElement('li');
  item.textContent = text;
  $('activity-items').append(item);
  while ($('activity-items').children.length > 150) $('activity-items').firstChild.remove();
  $('activity-current').textContent = text;
}
async function readRunStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  try {
    while (true) {
      const {value, done} = await reader.read();
      buffer += decoder.decode(value, {stream: !done});
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'started') {
          activeRunId = event.run_id;
          $('stop-run').hidden = false;
          $('stop-run').disabled = false;
          $('stop-run').textContent = 'Stop run';
          recordActivity('Run started.');
        } else if (event.type === 'model_start') {
          recordActivity(`Model step ${event.step} of ${event.max_steps}${event.finalizing ? ' · preparing final summary' : ' · waiting for model'}`);
        } else if (event.type === 'tool_start') {
          recordActivity(`Using ${event.name}…`);
        } else if (event.type === 'tool_end') {
          recordActivity(`${event.name} ${event.ok ? 'finished' : 'returned an error'} · ${event.tool_calls} tool calls`);
        } else if (event.type === 'result') {
          result = event.data;
          recordActivity(result.finish_reason === 'cancelled' ? 'Run stopped. Collected evidence is available below.' : 'Run finished.');
        } else if (event.type === 'error') {
          throw new Error(event.data.error || 'Run failed');
        }
      }
      if (done) break;
    }
    if (!result) throw new Error('Connection ended before a final result. The run may have stopped; check local history if enabled.');
    return result;
  } finally { reader.releaseLock(); }
}
$('stop-run').addEventListener('click', async () => {
  if (!activeRunId) return;
  $('stop-run').disabled = true;
  try {
    const response = await fetch('/api/run/stop', {method: 'POST', headers: {'Content-Type':'application/json', 'X-AgentOS-Token':document.querySelector('meta[name="agentos-token"]').content}, body:JSON.stringify({run_id:activeRunId})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not stop the run');
    recordActivity(result.stopping ? 'Stop requested. Waiting for the current request or tool to finish; no further steps will start.' : 'Run already finished.');
  } catch (error) { recordActivity(error.message); $('stop-run').disabled = false; }
});
function selectedCapabilities(containerId) {
  return [...$(containerId).querySelectorAll('input:checked')].map(input => input.dataset.capability);
}
function renderCapabilities(containerId, selected = [], reasons = {}) {
  $(containerId).replaceChildren();
  for (const capability of capabilityCatalog) {
    const label = document.createElement('label');
    label.className = 'capability-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.capability = capability.id;
    input.checked = selected.includes(capability.id);
    input.disabled = !capability.available;
    input.addEventListener('change', () => {
      if (containerId === 'studio-capabilities') $('auto-capabilities').checked = false;
    });
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = capability.label;
    const detail = document.createElement('small');
    detail.textContent = reasons[capability.id] || capability.description;
    const kind = document.createElement('small');
    kind.className = 'capability-kind';
    kind.textContent = !capability.available ? capability.setup : capability.kind === 'skill' ? 'Model skill · no external action' : capability.requires_folder ? 'Tools · choose a folder before running' : 'Registered tools';
    copy.append(title, detail, kind);
    label.append(input, copy);
    $(containerId).append(label);
  }
}
function renderDraft(context, source) {
  draft = context;
  $('draft-name').value = draft.name;
  $('draft-purpose').value = draft.purpose;
  $('draft-instructions').value = draft.instructions;
  $('draft-source').textContent = `Generated with ${source}. Review before applying.`;
  $('draft-assumptions').replaceChildren();
  for (const assumption of draft.assumptions.length ? draft.assumptions : ['No additional assumptions supplied.']) {
    const item = document.createElement('li');
    item.textContent = assumption;
    $('draft-assumptions').append(item);
  }
  renderCapabilities('draft-capabilities', draft.selected_capabilities, draft.capability_reasons);
  $('draft').hidden = false;
  $('draft-name').focus({ preventScroll: true });
}
function renderStarters(prompts) {
  activeStarterPrompts = [...prompts];
  $('starter-prompts').replaceChildren();
  for (const prompt of prompts) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = prompt;
    button.addEventListener('click', () => { if (!running) { $('prompt').value = prompt; $('prompt').focus(); } });
    $('starter-prompts').append(button);
  }
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
$('back-studio').addEventListener('click', () => showView('studio'));
$('open-model').addEventListener('click', () => $('model-dialog').showModal());
$('close-model').addEventListener('click', () => $('model-dialog').close());
$('connection-form').addEventListener('submit', event => { event.preventDefault(); updateConnectionLabel(); $('model-dialog').close(); });
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => chooseProvider(button.dataset.mode === 'local' ? 'ollama' : (provider === 'ollama' ? 'gemini' : provider)));
for (const button of document.querySelectorAll('[data-provider]')) button.addEventListener('click', () => chooseProvider(button.dataset.provider));
$('model').addEventListener('input', updateConnectionLabel);
$('clear-key').addEventListener('click', () => { $('api-key').value = ''; });
for (const button of document.querySelectorAll('[data-description]')) button.addEventListener('click', () => { $('description').value = button.dataset.description; $('auto-capabilities').checked = true; $('description').focus(); });
$('context-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (running || !validateConnection()) return;
  if (!catalogReady) { setStatus('context-status', 'Wait for the capability catalog to load.', true); return; }
  $('generate').textContent = 'Building context…';
  try {
    const result = await request('/api/context', { ...connectionPayload(), description: $('description').value, auto_capabilities: $('auto-capabilities').checked, capabilities: selectedCapabilities('studio-capabilities') }, 'context-status', `Building your brief with ${$('model').value}…`);
    result.context.selected_capabilities = result.selected_capabilities;
    result.context.capability_reasons = result.capability_reasons;
    renderDraft(result.context, `${result.provider} / ${result.model}`);
    setStatus('context-status', 'Your draft is ready. Edit it, then use this agent when you are ready.');
  } catch (error) { setStatus('context-status', error.message || 'Could not reach the local workspace.', true); }
  finally { $('generate').textContent = 'Build agent context ✳'; }
});
$('apply-context').addEventListener('click', () => {
  const name = $('draft-name').value.trim();
  const instructions = $('draft-instructions').value.trim();
  const purpose = $('draft-purpose').value.trim();
  if (!draft || !name || !instructions || !purpose) {
    setStatus('context-status', 'Add a name, purpose and context before applying this draft.', true);
    return;
  }
  activeSavedId = null;
  resetConversation();
  renderCapabilities('run-capabilities', selectedCapabilities('draft-capabilities'));
  $('agent-name').value = name;
  $('active-name').textContent = name;
  $('instructions').value = instructions;
  activePurpose = purpose;
  $('active-purpose').textContent = activePurpose;
  $('prompt').value = '';
  $('result').hidden = true;
  renderStarters(draft.starter_prompts);
  setStatus('status', selectedCapabilities('run-capabilities').includes('file_reading') && !$('file-directory').value.trim() ? 'Agent applied. Set a file-reading folder in Configure before running.' : 'Agent context applied. Give it a task to start a fresh run.');
  showView('run');
});
$('agent-name').addEventListener('input', () => { $('active-name').textContent = $('agent-name').value.trim() || 'Assistant'; });
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(rawAnswer); setStatus('status', 'Answer copied.'); } catch { setStatus('status', 'Select the answer text to copy it.', true); } });
function safeLink(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}
function renderResearchEvidence(messages) {
  $('research-items').replaceChildren();
  let count = 0;
  const seen = new Set();
  for (const message of messages) {
    if (message.role !== 'tool' || !['inspect_linkedin_job', 'read_web_page', 'read_browser_page', 'inspect_browser_job', 'search_company_jobs', 'inspect_company_job'].includes(message.tool_name)) continue;
    let record;
    try { const envelope = JSON.parse(message.content); if (!envelope.ok) continue; record = envelope.result; } catch { continue; }
    const records = Array.isArray(record.jobs) ? record.jobs.map(job => ({...job, checked_at:record.checked_at})) : [record];
    for (const record of records) {
    const source = safeLink(record.source_url || record.url);
    if (!source || seen.has(source)) continue;
    seen.add(source);
    const card = document.createElement('div');
    card.className = 'research-item';
    const heading = document.createElement('strong');
    heading.textContent = record.title || 'Inspected page';
    card.append(heading);
    const detail = document.createElement('p');
    detail.textContent = [record.company || record.company_board, record.location, (record.apply_status || record.status || '').replaceAll('_', ' '), record.checked_at].filter(Boolean).join(' · ');
    card.append(detail);
    const targets = [{label:'Source posting ↗', url:source}, ...[record.application_url, ...(record.application_links || [])].filter(Boolean).map(url => ({label:record.apply_status === 'linkedin_easy_apply' ? 'LinkedIn application ↗' : 'Extracted application link ↗', url}))];
    for (const target of targets) {
      const url = safeLink(target.url);
      if (!url) continue;
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = target.label;
      card.append(anchor);
    }
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = record.note || '';
    card.append(note);
    $('research-items').append(card);
    count++;
    }
  }
  $('research-evidence').hidden = count === 0;
}
$('run-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (running || !validateConnection()) return;
  for (const id of ['agent-name', 'steps', 'calls', 'timeout']) {
    if (!$(id).checkValidity()) {
      $(id).closest('details').open = true;
      $(id).reportValidity();
      return;
    }
  }
  if (!$('agent-name').value.trim() || !$('instructions').value.trim()) {
    setStatus('status', 'Add an agent name and instructions before running.', true);
    return;
  }
  if (!catalogReady) { setStatus('status', 'Wait for the capability catalog.', true); return; }
  if (selectedCapabilities('run-capabilities').includes('file_reading') && !$('file-directory').value.trim()) { $('model-dialog').showModal(); $('file-directory').focus(); return; }
  if (conversation.length && conversationSettings !== conversationSignature()) {
    resetConversation(false);
    setStatus('status', 'Agent or connection settings changed. Starting a new conversation with your task.');
  }
  if (conversationBlocked || conversation.length >= 20) {
    setStatus('status', 'Conversation context is full. Choose New conversation before sending another task.', true);
    return;
  }
  const payload = { history:conversation, ...connectionPayload(), name: $('agent-name').value.trim(), prompt: $('prompt').value, instructions: $('instructions').value, capabilities: selectedCapabilities('run-capabilities'), file_directory: $('file-directory').value.trim(), purpose: activePurpose, starter_prompts: activeStarterPrompts, save_history: $('save-history').checked, max_steps: Number($('steps').value), max_tool_calls: Number($('calls').value) };
  $('run').textContent = 'Running…';
  $('result').hidden = true;
  try {
    $('activity').hidden = false;
    $('activity-items').replaceChildren();
    recordActivity('Connecting to the local workspace…');
    payload.run_id = crypto.randomUUID();
    const result = await request('/api/run/stream', payload, 'status', `Running with ${payload.model} / ${payload.provider}. Follow the activity below.`);
    if (result.conversation) conversation = result.conversation;
    conversationBlocked = Boolean(result.context_error) || conversation.length >= 20;
    conversationSettings = conversationSignature();
    updateConversation();
    $('prompt').value = '';
    showRunResult(result);
    setStatus('status', result.finish_reason === 'completed' || !result.finish_reason ? 'Run complete.' : 'Research budget reached. Showing collected results; the search may be incomplete.');
    if (result.finish_reason === 'cancelled') setStatus('status', 'Run stopped. Inspect collected evidence below.');
    if (result.history_id) setStatus('status', (result.finish_reason === 'cancelled' ? 'Run stopped and saved to local history.' : 'Run finished and saved to local history.') + (result.finish_reason !== 'completed' ? ' Results may be partial.' : ''));
    if (result.history_error) setStatus('status', result.history_error, true);
    if (result.context_error) setStatus('status', `Answer retained. ${result.context_error}`, true);
  } catch (error) { recordActivity('Run ended with an error.'); setStatus('status', error.message || 'Could not reach the local workspace.', true); }
  finally { $('run').textContent = 'Run agent →'; }
});
chooseProvider('ollama');
renderStarters(['Use the calculator to compute 25 * 48.', 'Explain embeddings in two simple sentences.']);

fetch('/api/capabilities').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(data => {
  capabilityCatalog = data.capabilities;
  catalogReady = true;
  renderCapabilities('studio-capabilities', ['calculator']);
  renderCapabilities('run-capabilities', ['calculator']);
  $('catalog-status').textContent = 'Automatic selection uses only this registered catalog. Review the chosen capabilities in your draft.';
}).catch(() => { $('catalog-status').textContent = 'Could not load capabilities. Reload the workspace.'; });

function setAnswerView(raw) {
  $('answer').hidden = raw;
  $('raw-answer').hidden = !raw;
  $('formatted-view').setAttribute('aria-pressed', String(!raw));
  $('raw-view').setAttribute('aria-pressed', String(raw));
}
$('formatted-view').addEventListener('click', () => setAnswerView(false));
$('raw-view').addEventListener('click', () => setAnswerView(true));
$('download-answer').addEventListener('click', () => AgentOSOutput.download(rawAnswer, 'agentos-answer.md', 'text/markdown;charset=utf-8'));

function showRunResult(result) {
    rawAnswer = result.content;
    AgentOSOutput.render($('answer'), rawAnswer);
    $('raw-answer').textContent = rawAnswer;
    setAnswerView(false);
    $('metrics').textContent = `${result.provider} / ${result.model} · ${result.model_calls} model requests · ${result.tool_calls} tool calls · ${result.elapsed}s`;
    $('trace').textContent = JSON.stringify(result.messages, null, 2);
    renderResearchEvidence(result.messages);
    $('result').hidden = false;
}
async function workspaceRequest(path, payload) {
  const headers = {'X-AgentOS-Token':document.querySelector('meta[name="agentos-token"]').content};
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {method:payload === undefined ? 'GET' : 'POST', headers, ...(payload === undefined ? {} : {body:JSON.stringify(payload)})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Workspace request failed');
  return result;
}
function currentProfile() {
  return {name:$('agent-name').value.trim(), purpose:activePurpose, instructions:$('instructions').value,
    capabilities:selectedCapabilities('run-capabilities'), starter_prompts:activeStarterPrompts,
    provider, model:$('model').value.trim(), base_url:(provider === 'ollama' || provider === 'custom') ? $('endpoint').value.trim() : '',
    max_steps:Number($('steps').value), max_tool_calls:Number($('calls').value), timeout:Number($('timeout').value)};
}
async function saveAgent(asNew = false) {
  if (running || !storageEnabled) return;
  const buttons = [$('save-agent'), $('save-agent-copy')];
  buttons.forEach(button => button.disabled = true);
  try {
    const result = await workspaceRequest('/api/agents/save', {profile:currentProfile(), id:asNew ? null : activeSavedId});
    activeSavedId = result.item.id;
    setStatus('status', 'Agent saved locally. API keys and file-access folders were not saved.');
  } catch (error) { setStatus('status', error.message, true); }
  finally { buttons.forEach(button => button.disabled = false); }
}
function loadProfile(profile, id = null) {
  if (!catalogReady) throw new Error('Wait for the capability catalog to load.');
  resetConversation();
  chooseProvider(profile.provider);
  $('api-key').value = '';
  $('file-directory').value = '';
  $('model').value = profile.model;
  $('endpoint').value = profile.base_url || (profile.provider === 'ollama' ? 'http://localhost:11434' : '');
  updateConnectionLabel();
  $('agent-name').value = profile.name;
  $('active-name').textContent = profile.name;
  $('instructions').value = profile.instructions;
  activePurpose = profile.purpose;
  $('active-purpose').textContent = activePurpose;
  for (const [key, field] of [['max_steps','steps'],['max_tool_calls','calls'],['timeout','timeout']]) $(field).value = profile[key];
  const available = profile.capabilities.filter(id => capabilityCatalog.some(entry => entry.id === id && entry.available));
  renderCapabilities('run-capabilities', available);
  renderStarters(profile.starter_prompts);
  activeSavedId = id;
  $('prompt').value = '';
  $('result').hidden = true;
  showView('run');
  setStatus('status', 'Saved profile loaded. Add an API key or file folder in Configure if required.' + (available.length !== profile.capabilities.length ? ' Unavailable optional capabilities were omitted from this session.' : ''));
}
function libraryNode(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
async function deleteItem(collection, id, name) {
  if (!window.confirm(`Delete ${name} from this machine? This cannot be undone.`)) return;
  try {
    await workspaceRequest(`/api/${collection}/delete`, {id});
    if (collection === 'agents' && activeSavedId === id) activeSavedId = null;
    await loadLibrary();
    setStatus('library-status', 'Deleted locally.');
  } catch (error) { setStatus('library-status', error.message, true); }
}
async function loadLibrary() {
  if (!storageEnabled) { setStatus('library-status', 'Local storage is not enabled on this server. Start with agentos serve.'); return; }
  setStatus('library-status', 'Loading your local library…');
  try {
    const [agents, runs] = await Promise.all([workspaceRequest(`/api/agents?offset=${libraryOffsets.agents}`), workspaceRequest(`/api/runs?offset=${libraryOffsets.runs}`)]);
    $('saved-agents').replaceChildren(); $('saved-runs').replaceChildren();
    for (const [kind, records] of [['agents',agents.items],['runs',runs.items]]) {
      $(`${kind}-newer`).disabled = libraryOffsets[kind] === 0;
      $(`${kind}-older`).disabled = records.length < 50;
    }
    for (const agent of agents.items) {
      const card = libraryNode('article', undefined, 'library-card');
      card.append(libraryNode('h3', agent.name), libraryNode('p', `Updated ${new Date(agent.updated_at).toLocaleString()}`, 'hint'));
      const actions = libraryNode('div', undefined, 'library-actions');
      const open = libraryNode('button', 'Load agent →', 'secondary'); open.type = 'button';
      open.addEventListener('click', async () => { try { const result = await workspaceRequest(`/api/agents/${agent.id}`); loadProfile(result.item.data, agent.id); } catch (error) { setStatus('library-status', error.message, true); } });
      const remove = libraryNode('button', 'Delete', 'text-button'); remove.type = 'button'; remove.addEventListener('click', () => deleteItem('agents', agent.id, 'this saved agent'));
      actions.append(open, remove); card.append(actions); $('saved-agents').append(card);
    }
    for (const run of runs.items) {
      const card = libraryNode('article', undefined, 'library-card');
      card.append(libraryNode('h3', run.agent_name), libraryNode('p', run.prompt), libraryNode('p', `${new Date(run.created_at).toLocaleString()} · ${run.status.replaceAll('_',' ')}`, 'hint'));
      const actions = libraryNode('div', undefined, 'library-actions');
      const open = libraryNode('button', 'Open result →', 'secondary'); open.type = 'button';
      const openRun = async (resume = false) => {
        try {
          const item = (await workspaceRequest(`/api/runs/${run.id}`)).item.data;
          loadProfile(item.profile);
          if (resume) {
            if (!item.result?.conversation?.length) throw new Error('This run has no retained conversation. Open its result to inspect it, or start a new task.');
            conversation = item.result.conversation;
            conversationSettings = conversationSignature();
            conversationBlocked = conversation.length >= 20;
            updateConversation();
          }
          if (item.result) { showRunResult(item.result); setStatus('status', resume ? 'Conversation loaded. Configure credentials/folder if required. Your next task sends retained context to the displayed model; nothing has run yet.' : 'Saved result reopened for viewing. Use Continue conversation in My library to follow up with retained context.'); }
          else setStatus('status', `Saved failed run: ${item.error}`, true);
        } catch (error) { setStatus('status', error.message, true); }
      };
      open.addEventListener('click', () => openRun());
      const resume = libraryNode('button', 'Continue conversation ↗', 'text-button'); resume.type = 'button';
      resume.addEventListener('click', () => openRun(true));
      const remove = libraryNode('button', 'Delete', 'text-button'); remove.type = 'button'; remove.addEventListener('click', () => deleteItem('runs', run.id, 'this saved run'));
      actions.append(open, resume, remove); card.append(actions); $('saved-runs').append(card);
    }
    if (!agents.items.length) $('saved-agents').append(libraryNode('p', 'No saved agents yet. Apply or configure an agent, then click Save agent.', 'hint'));
    if (!runs.items.length) $('saved-runs').append(libraryNode('p', 'No saved runs yet. Enable Save this run to local history before running a task.', 'hint'));
    setStatus('library-status', 'Stored only in this workspace’s local SQLite database. Browse items 50 at a time with Older/Newer controls.');
  } catch (error) { setStatus('library-status', error.message, true); }
}
$('save-agent').addEventListener('click', () => saveAgent());
$('save-agent-copy').addEventListener('click', () => saveAgent(true));
$('refresh-library').addEventListener('click', () => { libraryOffsets.agents = 0; libraryOffsets.runs = 0; loadLibrary(); });
for (const kind of ['agents','runs']) {
  $(`${kind}-older`).addEventListener('click', () => { libraryOffsets[kind] += 50; loadLibrary(); });
  $(`${kind}-newer`).addEventListener('click', () => { libraryOffsets[kind] = Math.max(0, libraryOffsets[kind] - 50); loadLibrary(); });
}
fetch('/api/workspace').then(response => response.json()).then(data => {
  storageEnabled = data.enabled;
  $('save-agent').disabled = !storageEnabled;
  $('save-agent-copy').disabled = !storageEnabled;
  $('save-history').disabled = !storageEnabled;
}).catch(() => setStatus('status', 'Local library could not be checked; task runs are still available.', true));

updateConversation();

for (const id of ['instructions','model','endpoint']) $(id).addEventListener('input', resetChangedConversation);
$('run-capabilities').addEventListener('change', resetChangedConversation);
