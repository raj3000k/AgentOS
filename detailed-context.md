# AgentOS — detailed project context

## Maintenance contract

Every code change must update this document in the same change. Add a dated chronological entry with what changed, why, impacted files, and validation. Update the codebase map, design decisions, setup, and current status when affected. This also applies to tests, examples, and automation. `AGENTS.md` repeats this rule for future contributors and coding agents.

## Goals and scope

Build a lightweight, understandable, local-first Python AI agent framework using Ollama, initially `qwen3:8b`. Provide an SDK, explicit custom tool registration/execution, a CLI, and deterministic offline tests. Prepare for eventual open sourcing without premature infrastructure. The first milestone is a synchronous single-agent runtime; persistent memory, planning, multi-agent coordination, streaming, a web UI, and sandboxed tools are future milestones, not implemented features.

## Architecture

`CLI / Python caller -> Agent.run -> ChatClient -> Ollama /api/chat -> assistant tool calls -> registered Tool.invoke -> tool result messages -> next model turn -> RunResult`.

Each run starts with system and user messages. The runtime preserves assistant messages, appends named tool results, and repeats until a nonempty final answer. All tools in a response execute sequentially. The full batch's wire structure and remaining budget are checked before execution. Tool argument/execution errors become JSON error results so the model can recover. Provider failures and budget exhaustion raise public exceptions. There is no retry of HTTP requests or failed tool functions, avoiding accidental duplicate side effects.

## Codebase map

| Path | Responsibility |
| --- | --- |
| `src/agentos/__init__.py` | Public SDK exports |
| `src/agentos/agent.py` | Agent configuration, bounded loop, RunResult transcript and counts |
| `src/agentos/ollama.py` | ChatClient protocol and non-streaming HTTP transport |
| `src/agentos/tools.py` | Decorator, schema generation, strict scalar argument validation, JSON result envelopes |
| `src/agentos/builtin_tools.py` | Safe two-operand calculator with an explicit operation allowlist |
| `src/agentos/errors.py` | Public provider, tool, and run-budget exceptions |
| `src/agentos/cli.py`, `__main__.py` | Console script and `python -m agentos` |
| `examples/custom_tool.py` | SDK tool registration example |
| `tests/test_tools.py` | Schema/argument validation, trusted-function errors, calculator behavior |
| `tests/test_agent.py` | Transcript flow, isolation, recovery, malformed batches, execution budgets |
| `tests/test_http_cli.py` | Loopback HTTP protocol and CLI integration; provider failures |
| `pyproject.toml` | Build metadata and console script; no runtime dependencies |
| `AGENTS.md`, `detailed-context.md` | Contributor rules and maintained project context |
| `README.md`, `CONTRIBUTING.md`, `SECURITY.md` | User/developer/release documentation and trust boundary |
| `.github/workflows/tests.yml` | Python 3.11–3.14 compatibility checks |

## Setup and execution

The repository now lives at `/Users/rajmotwani/Documents/Projects/AgentOS`. Open this entire folder in VS Code and use its integrated terminal.

Requires Python 3.11+ and a running Ollama instance with `qwen3:8b`. Create a virtual environment, install editable with `python -m pip install -e .`, and run `agentos run "Use the calculator to compute 25 * 48"`. If necessary use `ollama serve` and `ollama pull qwen3:8b`. Run tests with `python -m unittest discover -s tests -v`. `python examples/custom_tool.py` demonstrates the SDK. Use `agentos run --help` for model, host, timeout, budgets, and JSON transcript options.

On the initial development machine, system `python3` is 3.9.6; the available bundled Python is 3.12.14 at `/Users/rajmotwani/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3`. A local `.venv` has been created with this runtime and the project installed editable. From this repository, run `source .venv/bin/activate` before the commands above, or use `.venv/bin/agentos` directly. Ollama is installed and reports `qwen3:8b` already available. These machine-specific paths are setup observations, not application dependencies.

## Design decisions and trust boundary

- Python 3.11+ with only the standard library at runtime. Setuptools is required for packaging. A small HTTP adapter and injectable protocol keep tests independent of Ollama.
- Use Ollama's native `/api/chat` tool schema and `tool_name` responses, `stream: false`, `think: false`. Preserve assistant fields in the transcript. Reference: https://docs.ollama.com/capabilities/tool-calling and https://docs.ollama.com/api/chat (checked 2026-10-13).
- No `eval`, generated code execution, shell tool, filesystem tool, auto-discovery, or model-selected imports. Calculator dispatches only four known arithmetic operations.
- `@tool` accepts synchronous functions with explicit scalar `str`, `int`, `float`, `bool` parameter annotations, optional typed defaults, and JSON-serializable results. Reject variadic, positional-only, async, and generator functions. No coercion; booleans do not count as integers. Complex parameter schemas are deferred.
- Registered Python functions are trusted code running in-process with caller permissions. This is not a sandbox. A malicious or hanging custom tool can escape the intended workflow or block the process; no hard tool timeout, output-allocation cap, or process isolation is claimed. Add isolation before supporting untrusted tools.
- Default 8 model steps, 16 tool calls; final-step tool batches are not executed because no model step remains to consume their results. Tool count includes failed calls. Normal result envelopes are limited to 16,000 characters; oversized/non-JSON results become errors. HTTP reads cap responses at 2 MB; timeout defaults to 120 seconds per request, not a whole-run deadline.
- Default host is loopback. Explicit remote hosts are supported and send prompts/results there. Ignore environment proxies and reject redirects; no telemetry or hidden hosted API fallback. Model names are caller configuration, not validated as local-only model tags.
- Each run has fresh in-memory state. JSON CLI output contains the full transcript; callers are responsible for protecting it. No automatic disk logging or persistence.
- Distribution working name is `agentos-local`, import is `agentos`; registry availability/name conflicts and license selection must be checked before publishing. No package or repository has been published.

## Current status

Single-agent MVP complete: SDK, registered tools, safe calculator, CLI, tests, CI configuration, and contributor documentation. All 23 offline tests pass on Python 3.12.14; compilation, editable installation, and wheel build pass. Live local `qwen3:8b` calculator verification produced 1200 using exactly one tool call and two model requests. The custom word-count example also returned the expected four words. Git repository initialized on `main`; no remote or commits created. CI is configured but has not run remotely; Python versions other than 3.12 have not been tested locally. License intentionally left undecided for owner selection before public release.

Next steps: add SQLite sessions with explicit persistence and migration tests, then streaming events. Sandbox/process isolation is a prerequisite for untrusted custom tools. Do not infer those future capabilities from the project name.

## Chronological change log

### 2026-10-13 — Step 1: core foundation

- What: initialized packaging, SDK, Ollama adapter, bounded agent loop, registered typed tools, safe calculator, CLI, custom-tool example, ignore rules, and contributor context contract.
- Why: establish a minimal independently testable single-agent path before memory, UI, or multi-agent work.
- Impacted files: `pyproject.toml`, `.gitignore`, `AGENTS.md`, `src/agentos/{__init__,__main__,errors,tools,ollama,agent,builtin_tools,cli}.py`, `examples/custom_tool.py`, `detailed-context.md`.
- Validation: checked official Ollama tool-calling documentation and local model availability. Automated checks and live inference pending in Step 2.

### 2026-10-13 — Step 2: tests and contributor documentation

- What: added deterministic tool/runtime tests, loopback HTTP/CLI integration tests, a Python 3.11–3.14 CI matrix, quick start, SDK examples, contribution instructions, and security/release limitations.
- Why: make behavior verifiable without downloading a model, document the exact trust boundary, and prepare a maintainable public repository.
- Impacted files: `tests/test_tools.py`, `tests/test_agent.py`, `tests/test_http_cli.py`, `.github/workflows/tests.yml`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `detailed-context.md`.
- Validation: test execution and live smoke test follow; no CI runs claimed until a remote is configured.

### 2026-10-13 — Step 3: boundary review

- What: reject extremely large integer inputs for float parameters without overflowing validation, reject async generator tools, validate URL ports at construction, and reject empty provider-prefixed model names.
- Why: close edge cases found during review so configuration/input mistakes fail predictably before executing tools or sending a request.
- Impacted files: `src/agentos/tools.py`, `src/agentos/agent.py`, `src/agentos/ollama.py`, `tests/test_tools.py`, `tests/test_agent.py`, `tests/test_http_cli.py`, `detailed-context.md`.
- Validation: initial editable installation and all 23 tests passed on Python 3.12.14 before this review; edge-case rerun and live model verification pending.

### 2026-10-13 — Step 4: verification and handoff

- What: completed local setup, verified the final code, and refreshed setup/status with observed outcomes. No runtime code changed in this step.
- Why: make the next development session start from verified facts and provide immediately usable run commands.
- Impacted tracked file: `detailed-context.md`. Ignored local artifacts: `.venv/`, `work/live-calculator.json`, `work/wheels/`, and `work/wheel-env/`.
- Validation: all 23 tests passed after Step 3, Python compilation passed, editable installation and distributable wheel build succeeded. Installed the wheel into a separate clean environment: all 23 tests and the console-script version check passed there too. `git diff --check` passed with all project files included. Live Ollama transcript confirmed `calculate(a=25, operation="multiply", b=48)` returned 1200, with one tool call and two model requests. The custom-tool example returned four words. Compatibility CI remains unexecuted until repository hosting is configured.

### 2026-10-13 — Step 5: relocate project to Projects

- What: moved the complete repository, including Git metadata, into `/Users/rajmotwani/Documents/Projects/AgentOS` and opened the folder in VS Code. Rebuilt `.venv` and reinstalled the editable package so executable and import paths point at the new location.
- Why: use the user's requested permanent project directory and keep local run commands working after relocation.
- Impacted files: repository location and `detailed-context.md`; regenerated ignored `.venv/` and packaging metadata. Application source is unchanged. The ignored `work/wheel-env/` is a historical verification environment with old paths; recreate it before reuse.
- Validation: all 23 tests passed from the new directory; `.venv/bin/agentos --version` returned `AgentOS 0.1.0`.
