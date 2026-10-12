# AgentOS

A lightweight local-first Python agent framework with a browser workspace, Ollama, and optional user-key API providers. Start with `qwen3:8b`, register trusted Python functions, and inspect a bounded tool-calling loop.

**Status:** early single-agent MVP. No runtime dependencies, telemetry, or automatic conversation storage. API providers require your own key and explicit selection. Custom tools run in-process and are not sandboxed.

## Quick start

Use **Python 3.11+** and [Ollama](https://ollama.com/download).

```sh
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
ollama pull qwen3:8b
agentos run "Use the calculator to compute 25 * 48"
```

Any Python 3.11+ executable can replace `python3.11`. Start `ollama serve` in another terminal if the Ollama app is not already serving. The model download is only needed once.

```sh
agentos run "Use the calculator to compute 25 * 48" --json
agentos run "Explain embeddings in two sentences" --no-tools
python -m agentos run "Hello" --model qwen3:8b
agentos run --help
python examples/custom_tool.py
python -m unittest discover -s tests -v
```

The CLI includes a calculator with `add`, `subtract`, `multiply`, and `divide`. It does not interpret expressions as code. `--json` prints the answer, message transcript, and call counts. Failures go to stderr with exit code 1; interruption returns 130. CLI syntax errors return 2.

## Browser workspace and provider control

```sh
agentos serve
```

Open `http://127.0.0.1:8765`. Select **Local · Ollama** and enter an installed model ID, or select **Gemini, OpenAI, Groq, DeepSeek**, or **Custom compatible endpoint** and supply your own API key and model ID. API models are never chosen automatically. Custom endpoints must expose OpenAI-compatible `/chat/completions`; enter the API base URL including its version path. HTTPS is required except for loopback endpoints. Native Anthropic and other incompatible APIs are not supported directly.

The workspace exposes instructions, calculator enablement, request timeout, model-step/tool-call limits, final answers, and completed execution transcripts. Runs are independent and non-streaming. Keys remain in page/request memory, clear on provider changes, and are never written to storage or logs by AgentOS. API prompts and tool results are sent to the selected provider and may incur its charges. There is no automatic fallback. The web server binds only to `127.0.0.1`, rejects other Host/Origin values, and requires a per-server request token. Use the printed URL rather than `localhost`.

CLI API runs read keys from an environment variable, avoiding keys in command arguments:

```sh
agentos run "Hello" --provider gemini --model YOUR_GEMINI_MODEL --api-key-env GEMINI_API_KEY
agentos run "Hello" --provider groq --model YOUR_GROQ_MODEL --api-key-env GROQ_API_KEY
```

Set the named environment variable privately before running. The default key variable is `AGENTOS_API_KEY`. `--host` selects the base URL for `custom` or the Ollama origin; named API providers use fixed endpoints. SDK callers can use `create_client("gemini", api_key=key)` and pass the resulting client to `Agent(model="your-model", client=client)`.

Provider references: [Gemini compatibility](https://ai.google.dev/gemini-api/docs/openai), [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat), [Groq compatibility](https://console.groq.com/docs/openai), [DeepSeek API](https://api-docs.deepseek.com/).

## Custom tools

```python
from agentos import Agent, tool

@tool
def word_count(text: str) -> int:
    """Count whitespace-separated words in text."""
    return len(text.split())

agent = Agent(
    name="WordCounter",
    model="qwen3:8b",
    instructions="Use word_count when asked to count words.",
    tools=[word_count],
)
result = agent.run("How many words are in 'local agents are useful'?")
print(result.content)
print(result.tool_calls)
```

Tools must have typed scalar parameters (`str`, `int`, `float`, `bool`) and JSON-serializable return values. Defaults and keyword-only parameters work. Optional/union, list, and nested-object parameter types are not yet supported. Only explicitly registered functions can execute. Argument validation happens before invocation; errors are returned to the model as `{"ok": false, "error": "..."}` so it can correct its call. Tool decorators return `Tool` objects; use `.invoke({...})` for direct validated calls.

## Execution model

1. Start a fresh system/user transcript.
2. Send messages and tool schemas to Ollama.
3. Validate the returned tool batch and budgets.
4. Execute registered tools sequentially and append their results.
5. Repeat until a final answer or an explicit limit/error.

Defaults: 8 model requests, 16 tool calls, 120 seconds per HTTP request. Configure via `Agent(max_steps=..., max_tool_calls=...)` or CLI flags. `OllamaClient(base_url=..., timeout=...)` configures the SDK transport. Budget failures raise `RunLimitError`; connection/protocol failures raise `ProviderError`. No tools execute on the final allowed model request. Prior tool side effects are not rolled back on a later error. Each `run` is independent; memory is not yet implemented.

The default endpoint is `http://localhost:11434`. `--host` explicitly selects another endpoint; prompts and tool results then go there. Proxy environment variables and redirects are disabled. Choose a locally installed model to keep inference local.

## Development and roadmap

See [detailed-context.md](detailed-context.md) for architecture, file map, design rationale, status, and chronological changes. **Every code change must update that document in the same change.** See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Next milestones: persistent SQLite sessions, streaming/events, isolated tool workers and hard deadlines, then planning and multi-agent workflows. Keep these separate from the minimal runtime.

This repository is being prepared for open sourcing. A license and final public/package name must be chosen before publication; no license grant is currently supplied. The local distribution name `agentos-local` is provisional.
