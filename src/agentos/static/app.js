const $ = id => document.getElementById(id);
let endpoints = {};
let previousProvider = 'ollama';
const selections = {};
let running = false;
const status = (text, error = false) => { $('status').textContent = text; $('status').className = error ? 'error' : ''; };
function changeProvider() {
  selections[previousProvider] = { model: $('model').value, endpoint: $('endpoint').value };
  const provider = $('provider').value;
  const local = provider === 'ollama';
  $('api-key').value = '';
  $('api-key').required = !local;
  $('key-fields').hidden = local;
  $('endpoint-fields').hidden = !(local || provider === 'custom');
  $('endpoint').required = local || provider === 'custom';
  $('endpoint').value = selections[provider]?.endpoint || (local ? 'http://localhost:11434' : endpoints[provider] || '');
  $('model').value = selections[provider]?.model || (local ? 'qwen3:8b' : '');
  $('model-help').textContent = local ? 'Enter a model installed in Ollama. Use ollama list to see yours.' : 'Enter the exact model ID available to your provider account.';
  $('privacy').textContent = local ? 'Requests go to your local Ollama server.' : 'Prompts and tool results go to the selected API provider. Provider charges may apply.';
  previousProvider = provider;
  status('Ready when you are.');
}
$('provider').addEventListener('change', changeProvider);
$('clear-key').addEventListener('click', () => { $('api-key').value = ''; });
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { if (!running) { $('prompt').value = button.dataset.prompt; $('prompt').focus(); } });
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('answer').textContent); status('Answer copied.'); } catch { status('Select the answer text to copy it.', true); } });
$('run-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (running) return;
  const provider = $('provider').value;
  const payload = { provider, model: $('model').value.trim(), api_key: provider === 'ollama' ? '' : $('api-key').value.trim(), base_url: (provider === 'ollama' || provider === 'custom') ? $('endpoint').value.trim() : '', prompt: $('prompt').value, instructions: $('instructions').value, calculator: $('calculator').checked, max_steps: Number($('steps').value), max_tool_calls: Number($('calls').value), timeout: Number($('timeout').value) };
  running = true;
  $('result').hidden = true;
  const controls = [...document.querySelectorAll('input,select,textarea,button')];
  controls.forEach(control => control.disabled = true);
  $('run').textContent = 'Running…';
  status(`Running with ${payload.model} · ${provider}. Waiting for the complete answer…`);
  try {
    const response = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AgentOS-Token': document.querySelector('meta[name="agentos-token"]').content }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Run failed');
    $('answer').textContent = result.content;
    $('metrics').textContent = `${result.provider} / ${result.model} · ${result.model_calls} model requests · ${result.tool_calls} tool calls · ${result.elapsed}s`;
    $('trace').textContent = JSON.stringify(result.messages, null, 2);
    $('result').hidden = false;
    status('Run complete.');
  } catch (error) { status(error.message || 'Could not reach the local workspace.', true); }
  finally { payload.api_key = ''; running = false; controls.forEach(control => control.disabled = false); $('run').textContent = 'Run agent ↗'; }
});
fetch('/api/providers').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(data => { endpoints = data.providers; }).catch(() => status('Could not load provider configuration. Reload the workspace.', true));
