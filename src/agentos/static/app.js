const $ = id => document.getElementById(id);
let provider = 'ollama';
const selections = {};
let running = false;
let draft = null;
let activePurpose = 'A general assistant, ready for your task.';
const setStatus = (id, text, error = false) => { $(id).textContent = text; $(id).className = error ? 'status error' : 'status'; };
function showView(view) {
  $('studio-view').hidden = view !== 'studio';
  $('run-view').hidden = view !== 'run';
  $('page-label').textContent = view === 'studio' ? 'Agent studio' : 'Run workspace';
  document.querySelectorAll('[data-view]').forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  window.scrollTo({ top: 0, behavior: 'instant' });
}
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
  controls.forEach(control => control.disabled = true);
  document.querySelectorAll('main').forEach(element => element.setAttribute('aria-busy', 'true'));
  setStatus(statusId, pending);
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AgentOS-Token': document.querySelector('meta[name="agentos-token"]').content }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  } finally {
    payload.api_key = '';
    running = false;
    controls.forEach(control => control.disabled = false);
    document.querySelectorAll('main').forEach(element => element.setAttribute('aria-busy', 'false'));
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
  $('draft').hidden = false;
  $('draft-name').focus({ preventScroll: true });
}
function renderStarters(prompts) {
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
for (const button of document.querySelectorAll('[data-description]')) button.addEventListener('click', () => { $('description').value = button.dataset.description; if (button.dataset.web === 'true') $('studio-web-research').checked = true; $('description').focus(); });
$('context-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (running || !validateConnection()) return;
  $('generate').textContent = 'Building context…';
  try {
    const result = await request('/api/context', { ...connectionPayload(), description: $('description').value, web_research: $('studio-web-research').checked, calculator: $('studio-calculator').checked }, 'context-status', `Building your brief with ${$('model').value}…`);
    result.context.capabilities = result.capabilities;
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
  $('web-research').checked = draft.capabilities.web_research;
  $('calculator').checked = draft.capabilities.calculator;
  $('agent-name').value = name;
  $('active-name').textContent = name;
  $('instructions').value = instructions;
  activePurpose = purpose;
  $('active-purpose').textContent = activePurpose;
  $('prompt').value = '';
  $('result').hidden = true;
  renderStarters(draft.starter_prompts);
  setStatus('status', 'Agent context applied. Give it a task to start a fresh run.');
  showView('run');
});
$('agent-name').addEventListener('input', () => { $('active-name').textContent = $('agent-name').value.trim() || 'Assistant'; });
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('answer').textContent); setStatus('status', 'Answer copied.'); } catch { setStatus('status', 'Select the answer text to copy it.', true); } });
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
    if (message.role !== 'tool' || !['inspect_linkedin_job', 'read_web_page'].includes(message.tool_name)) continue;
    let record;
    try { const envelope = JSON.parse(message.content); if (!envelope.ok) continue; record = envelope.result; } catch { continue; }
    const source = safeLink(record.source_url || record.url);
    if (!source || seen.has(source)) continue;
    seen.add(source);
    const card = document.createElement('div');
    card.className = 'research-item';
    const heading = document.createElement('strong');
    heading.textContent = record.title || 'Inspected page';
    card.append(heading);
    const detail = document.createElement('p');
    detail.textContent = [record.company, record.location, (record.apply_status || record.status || '').replaceAll('_', ' '), record.checked_at].filter(Boolean).join(' · ');
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
  const payload = { ...connectionPayload(), name: $('agent-name').value.trim(), prompt: $('prompt').value, instructions: $('instructions').value, calculator: $('calculator').checked, web_research: $('web-research').checked, max_steps: Number($('steps').value), max_tool_calls: Number($('calls').value) };
  $('run').textContent = 'Running…';
  $('result').hidden = true;
  try {
    const result = await request('/api/run', payload, 'status', `Running with ${payload.model} / ${payload.provider}. Waiting for the complete answer…`);
    $('answer').textContent = result.content;
    $('metrics').textContent = `${result.provider} / ${result.model} · ${result.model_calls} model requests · ${result.tool_calls} tool calls · ${result.elapsed}s`;
    $('trace').textContent = JSON.stringify(result.messages, null, 2);
    renderResearchEvidence(result.messages);
    $('result').hidden = false;
    setStatus('status', result.finish_reason === 'completed' || !result.finish_reason ? 'Run complete.' : 'Research budget reached. Showing collected results; the search may be incomplete.');
  } catch (error) { setStatus('status', error.message || 'Could not reach the local workspace.', true); }
  finally { $('run').textContent = 'Run agent →'; }
});
chooseProvider('ollama');
renderStarters(['Use the calculator to compute 25 * 48.', 'Explain embeddings in two simple sentences.']);
