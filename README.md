# AgentOS

A lightweight local-first Python agent framework with a browser workspace, Ollama, and optional user-key API providers. Start with `qwen3:8b`, register trusted Python functions, and inspect a bounded tool-calling loop.

**Status:** early single-agent MVP. No core runtime dependencies, telemetry, or automatic conversation storage. API providers require your own key and explicit selection. SDK custom tools run in-process and are not sandboxed. Production workspace agent runs use separate supervised workers with total deadlines; workers keep the same OS permissions.

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

Open `http://127.0.0.1:8765`. The **Agent studio** turns a short description into an editable agent brief. Open the model connection panel, choose **Run locally** and an installed Ollama model ID, or **Use an API** and **Gemini, OpenAI, Groq, DeepSeek**, or **Custom endpoint**, supplying your own key and model ID. For Gemini, [create a key in Google AI Studio](https://aistudio.google.com/apikey), paste it into the password-style API key field, and enter a model ID available to your account. Do not paste keys into chat or commit them. API models are never chosen automatically. Custom endpoints must expose OpenAI-compatible `/chat/completions`; enter the API base URL including its version path. HTTPS is required except for loopback endpoints. Native Anthropic and other incompatible APIs are not supported directly.

Describe an agent in one prompt, such as "An interview coach for backend engineering roles", then choose **Build agent context**. The selected model returns a name, purpose, instructions, starter tasks and assumptions. Review/edit the draft and click **Use this agent** to apply it in the run workspace. Generation uses one model request with no tool execution; the prompt includes the fixed capability catalog or your manual selections. Automatic capability selection is enabled by default and returns editable recommendations with reasons. Applying a draft uses the capability selection you reviewed and does not change your connection. Unsaved drafts and active contexts are in page memory only. Use Save agent to keep a profile locally; My library restores it after reload. You can also use the general assistant or write instructions manually. Generated assumptions may need correction. Web research is available only when explicitly enabled; filesystem access and authenticated browser actions are not implemented.

The workspace exposes instructions, a nine-entry capability catalog, request timeout, model-step/tool-call limits, final answers, and completed execution transcripts. The workspace retains context within the active conversation; New conversation clears it. The workspace streams step/tool activity while inference responses themselves remain non-streaming. Keys remain in page/request memory, clear on provider changes, and are never written to storage or logs by AgentOS. API prompts and tool results are sent to the selected provider and may incur its charges. There is no automatic fallback. The web server binds only to `127.0.0.1`, rejects other Host/Origin values, and requires a per-server request token. Use the printed URL rather than `localhost`.

CLI API runs read keys from an environment variable, avoiding keys in command arguments:

```sh
agentos run "Hello" --provider gemini --model YOUR_GEMINI_MODEL --api-key-env GEMINI_API_KEY
agentos run "Hello" --provider groq --model YOUR_GROQ_MODEL --api-key-env GROQ_API_KEY
```

Set the named environment variable privately before running. The default key variable is `AGENTOS_API_KEY`. `--host` selects the base URL for `custom` or the Ollama origin; named API providers use fixed endpoints. SDK callers can use `create_client("gemini", api_key=key)` and pass the resulting client to `Agent(model="your-model", client=client)`.

Provider references: [Gemini compatibility](https://ai.google.dev/gemini-api/docs/openai), [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat), [Groq compatibility](https://console.groq.com/docs/openai), [DeepSeek API](https://api-docs.deepseek.com/).

## Task planning and completion review

**Plan before running**, under **Tools & execution limits**, is on by default on a fresh workspace page and can be switched off. It produces 1–6 visible steps, each with a completion criterion, then executes the task with the capabilities you selected. Saved profiles remember the setting; older profiles default to planning off. SDK/HTTP callers opt in with `plan_task=True`; CLI behavior is unchanged.

The task-plan card shows pending, in-progress, completed and blocked steps, short progress notes and a final completion review. Planning consumes **one request within the configured model-step limit** (at least two steps required). The trusted `update_task_plan` control tool consumes ordinary tool-call budget. No hidden planning/judging requests, automatic retries or budget extensions are added. Invalid plan output becomes a clearly labeled single task checkpoint without executing any planning-response tool calls.

Actual task-tool results receive current-run references such as `e1`. Updates can cite only references that exist and whose tool execution returned successfully; invented/failed references are rejected. Click a reference in a finished plan to inspect the transcript. Referencing a tool result does **not** prove factual correctness, task relevance or that the criterion is met. Progress and completion are model-reported. Writing/reasoning steps can be completed with a note and no tool reference, clearly labeled as model-only assessments. A successful tool return may itself describe unavailable or unverified domain data.

The final review checks whether every step was marked completed, whether blocked work remains, and whether cited references are valid. An answer never automatically marks pending steps completed. Stop/deadline/budget limits leave unfinished work visible. No independent verifier or correctness guarantee is claimed. Plans do not grant tools, register generated code or expand file/network permissions.

Plans and completion reviews are saved with opted-in run snapshots and restored on **Open result**; worker checkpoints preserve the latest received plan on interruption. Follow-ups create a fresh plan for the new request and retain prior task evidence, excluding progress-control tool messages. Plan titles/notes may echo task data and are treated as sensitive content, displayed as inert text. Planning reserves 100 characters of the usual tool-envelope budget for evidence-reference metadata.

SDK example: `result = agent.run("Compare these options", plan_task=True)`; inspect `result.plan['steps']` and `result.plan['checks']`. Without `plan_task`, the existing direct execution path remains unchanged.

## Follow-up conversations

After a reply, ask a follow-up in the same composer. Earlier user prompts, answers and completed tool evidence are included in the next request. Expand any turn in the conversation panel to review its formatted answer. **New conversation** clears the active context; changing instructions, capabilities, provider, model or endpoint also starts fresh. Renaming an agent, adjusting limits or configuring credentials/file access does not erase context. Applying/loading another agent starts a new conversation.

Context lives in page memory until reload unless you enable **Save this turn and conversation to local history**. Saving a follow-up saves its whole retained conversation, including earlier unsaved turns. In **My library**, **Open result** views an archive without enabling follow-ups; **Continue conversation** explicitly restores its retained turns. Both are local reads and run no model. Loading still clears API keys and file-access folders: configure them again before sending another task. Old saved runs without conversation data remain viewable and cannot be continued. Each saved turn is a separate snapshot; deleting one does not delete copies included in later snapshots.

Each request has fresh model/tool budgets. Historical calls are never replayed: prior evidence is sent as labeled, potentially stale data. Tools available now come only from current reviewed settings. Earlier file/page contents may remain in retained evidence even when their tools are disabled. Follow-ups send that retained content to the displayed provider, so start a new conversation to exclude it.

Conversations are bounded to 20 replies and 256,000 bytes of serialized retained context. Context is never silently trimmed or summarized. A full context requires **New conversation**; if a new answer exceeds the retention limit, its answer/transcript remain available with an explicit context error. Provider errors preserve the existing conversation for retry. Cancelled/partial replies can be followed up without replaying unfinished tool batches. No automatic recovery of partially returned provider output, embeddings, global memory or server-side background session is implemented.

SDK usage is explicit; calls without `history` still start fresh:

```python
first = agent.run("Find matching roles")
if first.conversation is not None:
    followup = agent.run("Keep only direct application links", history=first.conversation)
```

`RunResult.conversation` is provider-neutral data; `context_error` explains an answer that cannot be retained. Web run endpoints accept the same validated `history` field. Context is not a security authority: it cannot register tools, restore credentials/folders or introduce system/developer/tool-call fields.

## Isolated workspace execution and total deadlines

`agentos serve` executes each agent task in a fresh Python worker process. Under **Tools & execution limits**, **Total run deadline (s)** defaults to 300 seconds and accepts 5–1800 seconds. This covers worker startup, inference and tool execution after configuration validation. It is separate from the per-request transport timeout. The deadline is saved with agent profiles and run snapshots; older profiles default to 300 seconds.

**Stop run** terminates the worker without waiting for its active model/tool operation. A separate watchdog enforces the deadline even if progress delivery is blocked. Completed tool messages received through private checkpoints remain in the answer’s source cards/transcript and can enter saved history and follow-ups. Deadline results are marked `timed_out` / `run_timeout`; user stops remain `cancelled` / `user_stop`. An interrupted operation may have done unreported work, so it is not claimed as complete. No final model call or automatic retry is made after termination.

The supervisor reaps each worker, closes private pipes, and on POSIX terminates its process group, including descendants still in that group. Windows cleanup terminates the direct worker; equivalent descendant cleanup is not guaranteed. Four isolated tasks maximum are active per workspace, including legacy JSON requests. Closing the server requests stop for active workers. Credentials/configuration go through stdin, never command arguments, temp files or worker logs. Worker stderr is discarded; private checkpoints are not exposed as public lifecycle events.

This is execution-lifetime isolation, **not an OS permission sandbox**: workers inherit the current user’s permissions/environment. Only fixed, trusted capabilities run. It does not undo side effects, restrict CPU/memory, or guarantee that Ollama/remote providers stop inference or billing when their client disconnects. Escaped process groups and external services are outside descendant cleanup. Context/brief generation remains a bounded single provider request in the server, with its transport timeout.

SDK `Agent.run` and CLI custom tools retain their trusted in-process behavior. `make_server(..., isolate_runs=True)` opts into the production worker path; the default SDK/test server remains in-process and reports this through `/api/workspace`. The UI hides hard-deadline controls on those servers, and explicit run-deadline requests are rejected there. SDK callbacks may observe trusted `on_checkpoint` snapshots; those contain sensitive messages and are not ordinary public activity events.

## Live activity and stopping

Run workspace shows model-step progress, tool start/completion and tool errors as they happen. Expand **Step by step** to review activity. **Stop run** terminates the production workspace worker. In-process SDK/test servers retain cooperative stopping, which waits for the active operation. Neither mode undoes side effects or avoids charges for a request already sent. Cancelled results expose collected sources and the execution transcript; pending tools in an interrupted batch were not run. Opted-in history saves them as `cancelled`.

The workspace uses token-protected `POST /api/run/stream` (newline-delimited JSON) and `/api/run/stop`; existing `/api/run` JSON clients still work. Up to four streaming runs may be active per server; isolated JSON runs share this same cap. Lifecycle activity contains operation metadata. When planning is enabled, separate plan events include bounded user-facing titles, criteria and progress notes, which may echo task data. Raw tool transcripts are not automatically forwarded as activity; hidden model reasoning is not requested. Failed writes request a stop when detected; tab closure may remain undetected until the next stream write, but the total deadline still applies to isolated runs. API credentials remain in request memory only.

SDK: `agent.run(prompt, on_event=callback, should_stop=stop_event.is_set)` provides the same lifecycle metadata and cooperative stop checks. Callbacks are trusted synchronous application functions; exceptions propagate. CLI runs retain their existing behavior. Token-by-token answers, true operation resumption and background run reconnection are separate future work.

## Saved agents and local run history

`agentos serve` creates `.agentos/workspace.sqlite3` in the working folder (ignored by Git, database permissions restricted to the current user on POSIX). No extra service or dependency is required.

- In Run workspace, **Save agent** creates a reusable profile, then updates that profile on subsequent saves; **Save as new** makes an independent copy. Instructions, purpose, selected capabilities, starter tasks, provider/model/endpoint and execution limits are saved. API keys and file-reading folders are excluded.
- Enable **Save this turn and conversation to local history** before starting a task to retain its prompt, output, full transcript, evidence, counts and completion/partial/error state. It is off by default. Failed provider/run records retain the prompt/profile/error message; an unfinished transcript may be unavailable. Errors are recorded when execution has started; invalid configuration is not archived. Storage failure never discards a completed answer.
- **My library** lists saved agents and run records in pages of 50. Load an agent or open a result without contacting a model. Opened results retain formatting/source cards. Loading resets API keys/file access; configure them again before another run. Optional capabilities missing on this machine are omitted from the loaded session with a notice.
- Delete individual saved agents or runs from the library after the confirmation. Agent deletion does not delete historical run snapshots. Archives enter active context only through Continue conversation; new conversations start empty.

Saved prompts, instructions and tool outputs may contain sensitive material you supplied or allowed the agent to read. The database is local, not encrypted by AgentOS; protect it like the original files. The request API key field is never stored, but content entered into prompts or returned by tools is not a secret-scanning boundary. To back up the archive, stop AgentOS and copy the database. Newer unsupported schema versions are rejected, not overwritten. SDK/test servers created with `make_server()` keep storage disabled unless `storage_path` is explicitly supplied.

## Readable, interactive answers

Answers render a safe Markdown subset: headings, paragraphs, bold/emphasis, inline/fenced code, nested lists, blockquotes, checklists and tables. HTTP(S) links are clickable; raw HTML/images remain inert and unsafe/credential-bearing link schemes are rejected. Rendering does not change the original answer or verify model-provided links.

Tables have filter/search, sortable column headings and **Download CSV** for visible filtered/sorted rows. Code blocks have **Copy code**; checklists can be ticked locally. **Formatted / Raw Markdown** toggles show either view; **Copy Markdown** and **Download .md** preserve the full original answer. Checklist/filter/sort changes are view-only and reset on new runs/reload. Collected tool sources and the execution transcript remain separate.

Preview limits are 100,000 characters/1000 blocks and 300 table rows; raw/download retain the full answer. CSV exports quote values and neutralize leading spreadsheet-formula markers. This is a buildless, dependency-free renderer, not a complete CommonMark parser or syntax highlighter.

## Capability catalog and automatic selection

**Pick capabilities from my description** is on by default. Describe the task, then generate the agent: the selected LLM chooses relevant IDs from the registered catalog and explains each choice. A fixed research recipe supplements web-based job recommendations with company job boards, and adds an available browser reader for LinkedIn/JavaScript/browser tasks; the draft labels these fallback reasons. Review/edit the capability cards in the draft before Use this agent. Selecting a studio capability manually turns automatic selection off; run-workspace cards can be adjusted later. Unknown IDs and unavailable browser selections are rejected. Recommendations never import tools, execute anything during generation, change the model/key, or choose a local folder.

| Capability | What actually runs |
| --- | --- |
| Web research | Public search, LinkedIn posting inspection and public page reads |
| Company job boards | Read-only published Greenhouse/Lever feeds and exact posting/apply URLs |
| Browser reader | Optional Chromium rendering of public JS pages; clean session and GET-only network |
| Read local files | List/read supported text/code/CSV/JSON under a user-chosen folder |
| CSV analysis | Counts, missing data, samples and numeric statistics from supplied CSV |
| Structured extraction | Deduplicate URLs/emails and inspect supplied JSON |
| Calculator | Validated two-number arithmetic |
| Writing & summaries | A model instruction skill, with no external action tools |
| Code review | A model instruction skill; no shell or code execution |

For file reading, open **Configure** and enter a specific folder. Reads use relative paths, reject traversal/hidden paths/symlinks and credential-like filenames, cap files at 64 KB and returned text at 6000 characters. These filters are not comprehensive secret detection; choose only a folder whose contents you want the selected model to receive. No writes, commands, tests or arbitrary generated code run.

For JavaScript pages, install the optional browser extra (the base package stays dependency-free):

```sh
python -m pip install -e '.[browser]'
python -m playwright install chromium
```

Restart AgentOS after installation so the catalog refreshes availability. Browser tools use a fresh unauthenticated Chromium context; they do not use your Chrome/LinkedIn session. Page scripts may run inside the browser, but all routed HTTP resources are fetched with the public DNS-pinned reader: GET only, no cookies/Authorization forwarded, no websocket/service-worker traffic, and no forms/clicks/downloads. Browser JS data endpoints that require POST may remain unreadable. Budgets: 40 resource requests/8 MB total per browser toolset/run, 2 MB/resource, 1 MB rendered HTML; a 25-second resource scheduling window plus operation timeouts, not a hard process deadline. Unsupported/blocked/login pages remain explicit limitations.

CLI: repeat `--capability` with catalog IDs, and use `--file-directory` for file_reading. `--web-research` remains an alias; `--no-tools` conflicts with explicitly requested capabilities. SDK: `tools, instructions = build_capabilities(["data_analysis", "structured_extraction"])`, importing the builder from `agentos`, then pass both to Agent. Only fixed registered functions may execute.

## Job matching and exact application evidence

Research-enabled agents built through `build_capabilities` (including the workspace/CLI) now have two additional registered tools:

- `review_job_results(role="SDE 1", location="Bengaluru", max_experience=2, category="all", limit=5, offset=0)` reviews only job records actually returned by trusted research tools in the current run. It cannot accept a model-supplied job list. It separates `confirmed_match`, `uncertain`, `excluded`, `closed` and `blocked`; categories and pagination expose the other collected results. Criteria are explicit in every review. `max_experience` compares the posting's **minimum required years**, not a guarantee of candidate eligibility.
- `verify_job_application(source_url)` checks an application destination already observed for that captured source. Greenhouse/Lever destinations are checked against the exact public API record. Other specific public destinations get a read-only reachability check, which never establishes role identity or an active application form by itself. Unknown/guessed sources and generic career pages are not fetched as verification. Eight additional public GET requests maximum per run, using the same DNS-pinned/private-address protections.

SDE-1 matching recognizes titles such as Software Engineer I, Software Development Engineer 1, junior/associate software roles and relevant explicit level-1 variants. Senior/II/L2/lead/staff/intern/testing roles are excluded for that target. Bangalore/Bengaluru are equivalent; generic Remote/India does not prove city eligibility. English experience ranges and required minimums are extracted with short source quotes; preferred-only or ambiguous alternatives stay unknown. Other role queries use literal normalized tokens, not universal occupational taxonomy. These are conservative rules with false positives/negatives possible; review the source.

Feed searches now use role aliases. Greenhouse requests descriptions through its documented [`content=true` option](https://docs.greenhouse.io/job-board.html); feed and LinkedIn/browser inspectors parse experience from the full available description **before** shortening display output. This avoids ignoring a later higher requirement. Explicit closure notices and unambiguous expired ISO application-deadline dates suppress application shortcuts. A missing/unavailable API response is not automatically called closed. Greenhouse prospect-pool posts are excluded as non-specific openings.

Deduplication uses stable employer/ATS/job identities and observed specific application destinations, retaining source URLs. Tracking-only URL differences collapse; distinct requisition IDs and unknown identity query parameters stay distinct. Same title/employer/city alone never merges jobs. Broken feeds reusing a career homepage do not collapse different record IDs. Generic/homepage/hidden destinations are withheld from the review's application URL; LinkedIn Easy Apply remains separately labeled.

**Confirmed match** means collected role/location/experience criteria agree and a known exact ATS destination matches a published employer-feed job identity at its check timestamp. It does not independently verify employer identity, guarantee hiring or prove applications are accepted. Unknown/conflicting evidence, blocked reads, failed later destination checks and unverified extracted links remain explicit. Review instructions tell the agent not to pad a requested count with unrelated candidates. Model compliance and answer truth are not guaranteed.

The answer's **Job match review** card shows criteria, check timestamps, experience quotes, source/application links and local category filters. Filters affect only the displayed review page; totals also show categories omitted from that page. Saved results reopen this report from tool messages with no new inference/network reads. If no review was produced, the UI says so instead of implying raw sources establish a matching open role. The model must use the review tool; the UI does not secretly perform searches or verifier calls. Follow-ups must fetch evidence again before a fresh review; old transcript data is not promoted to a current observation.

The collector is bounded to 100 observations/256,000 serialized characters in memory and reports capture/result truncation. It resets through an explicitly registered trusted `Tool.on_run_start` callback, even when an SDK caller reuses an Agent. The callback is application code, never a model-selected function; exceptions propagate. The callback field is optional and does not change schemas or permissions. Direct low-level `WebResearch().tools`/`JobBoards().tools` callers keep their original tool sets; use the capability builder for the combined review workflow.

Run the repeatable quality fixtures with `python -m unittest discover -s tests -p test_job_quality.py -v`. They cover aliases/levels, experience ambiguity, city matching, identity-preserving deduplication, closure/deadlines, full-description requirements, exact observed destination checks, limits and per-run evidence isolation without external network access.

## Read-only web research

Enable **Web research** in Agent studio, or choose **Job researcher** to fill an example description and enable it. Generate/edit the brief, click **Use this agent**, then ask for specific roles and exact application links. Existing agents can enable it under **Tools & execution limits**. Disabled web tools cannot execute, regardless of generated instructions.

Registered tools:

- `search_linkedin_jobs(keywords, location, limit=5, start=0)`: public LinkedIn search candidates, with title/company/location and canonical job URLs. Search results may include unrelated roles; the agent must inspect matching openings.
- `inspect_linkedin_job(url)`: read a specific posting and extract a public external application URL. Distinguish `external_link_found`, `linkedin_easy_apply`, `login_required`, `not_exposed`, `closed`, and unavailable pages. Never infer a hidden destination.
- `search_web(query, limit=5)`: public Bing RSS search for matching company postings when LinkedIn hides an apply URL. Results are unverified until inspected; this endpoint is best-effort, not a guaranteed search API.
- `read_web_page(url)`: public company/job page text, links and application anchors. This HTTP-only tool has no JavaScript rendering, sign-in, cookies, CAPTCHA bypass or form submissions. Use the separate optional Browser reader for rendering.

The workspace defaults to 16 total model requests and 24 tool calls; limits remain editable. Research reserves the final request for an answer instead of executing more tools. A batch exceeding the remaining tool budget is skipped as a whole, then summarized within the remaining model budget. If the model ignores the stop instruction or its summary fails, a deterministic partial answer retains collected sources/links and the transcript. The CLI/SDK keep their existing 8/16 defaults; pass `--max-steps 16 --max-tool-calls 24` for larger research runs.

The Company job boards capability adds `search_company_jobs(platform, board, keywords="", location="", limit=5)` and `inspect_company_job(url)`. Supported platforms are `greenhouse`, `lever`, `lever_eu`; derive the employer board slug from an observed career URL. Exact API publication and application links can avoid hidden LinkedIn destinations for employers using these platforms. This is not a universal job-search index and does not independently establish employer identity or role eligibility. LinkedIn → matching employer page/feed → browser rendering → explicit limitation is the evidence-first fallback path. References: [Greenhouse public job API](https://docs.greenhouse.io/job-board.html), [Lever posting API](https://github.com/lever/postings-api/blob/master/README.md), [Playwright network controls](https://playwright.dev/python/docs/network).

The UI displays clickable **Collected sources & application links** from actual tool messages, alongside the model's answer. Extracted URLs are not automatically declared verified/open; inspect the exact company role, location, requirements and closure notices. Login-hidden external URLs may remain unavailable. LinkedIn can block public HTTP requests and its HTML can change. Queries/page URLs go to LinkedIn, Bing and selected public sites; fetched text is also sent to your selected model provider. Use public, non-sensitive research queries.

```sh
agentos run "Find SDE 1 jobs in Bengaluru on LinkedIn and collect exact application links with sources" --web-research
```

SDK callers can explicitly register `WebResearch().tools`, importing `WebResearch` from `agentos`. Include `WEB_INSTRUCTIONS` from `agentos.web_research` in the agent's instructions to explain the evidence-first workflow. No model may register new tools. Each toolset has a 20-request budget (redirects count), 12-second network-operation timeout, 512 KB response cap and at most three followed redirects; result payloads fit below the existing 16,000-character tool envelope. Only public HTTPS on port 443 is permitted. Private/non-global DNS addresses are blocked, validated addresses are pinned for connection, TLS validation stays enabled, and proxies are not used. HTTP-operation timeouts are not hard whole-run deadlines.

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

1. Start with current system instructions, explicitly supplied prior turns (if any), and the new user task.
2. Send messages and tool schemas to Ollama.
3. Validate the returned tool batch and budgets.
4. Execute registered tools sequentially and append their results.
5. Repeat until a final answer or an explicit limit/error.

Defaults: 8 model requests, 16 tool calls, 120 seconds per HTTP request. Configure via `Agent(max_steps=..., max_tool_calls=...)` or CLI flags. `OllamaClient(base_url=..., timeout=...)` configures the SDK transport. By default SDK budget failures raise `RunLimitError`; opt-in `Agent(finalize_on_limit=True)` reserves the last allowed request for a tools-disabled summary and preserves collected evidence as a partial result if the summary fails. UI/CLI runs with registered tools enable this option. `RunResult.finish_reason` is `completed`, `budget_summary`, `partial`, `cancelled`, or `timed_out`, with `limit_reason` explaining the exhausted budget. Connection/protocol failures raise `ProviderError` outside the reserved final-summary fallback. No tools execute on the final allowed model request. Prior tool side effects are not rolled back on a later error. SDK calls start fresh unless `history` is supplied explicitly; the browser retains only its active conversation.

The default endpoint is `http://localhost:11434`. `--host` explicitly selects another endpoint; prompts and tool results then go there. Proxy environment variables and redirects are disabled. Choose a locally installed model to keep inference local.

## Development and roadmap

See [detailed-context.md](detailed-context.md) for architecture, file map, design rationale, status, and chronological changes. **Every code change must update that document in the same change.** See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Next milestones: token streaming, OS permission/resource sandboxing, and multi-agent workflows. Visible single-agent planning and completion review are implemented. Keep these separate from the minimal runtime.

This repository is being prepared for open sourcing. A license and final public/package name must be chosen before publication; no license grant is currently supplied. The local distribution name `agentos-local` is provisional.


### Connect a logged-in LinkedIn tab (optional)

Keeping LinkedIn open alone does **not** share its login with AgentOS. Connect it directly in the extension; no pairing code or workspace switching is needed:

1. Download the extension ZIP from the workspace and unzip it. In Chrome → Extensions → Developer mode → Load unpacked, select the `agentos-browser-companion` folder. For a source checkout, you can instead load `src/agentos/static/linkedin-extension` directly.
2. Open your logged-in `https://www.linkedin.com/` tab. Click the AgentOS toolbar icon, choose **Connect this LinkedIn tab** in the card at the top of the panel. The extension connects to the local workspace and pairs securely behind the scenes.
3. Wait for **CONNECTED**. The companion enables LinkedIn job research for its next task; in the full workspace select **Connected LinkedIn tab** in the agent capabilities, and run the agent. Keep LinkedIn logged in and that connected tab open beside AgentOS; the agent will navigate it during job research. Use a dedicated LinkedIn tab to avoid interrupting your own browsing.

This extension currently supports Chrome and the default workspace address `http://127.0.0.1:8765`. Custom workspace ports require adjusting the extension's fixed host permission and bridge address. The extension stores only the selected tab ID and a separate bridge credential in Chrome session memory. It never exports login cookies, passwords or a browser profile. Pairing/disconnect/restart rotates or revokes access; browser restart requires reconnecting. AgentOS status is based on the extension heartbeat, not independent proof that LinkedIn login is valid. Sign-in or verification walls require the user to take over.

Trusted registered `search_linkedin_session` and `inspect_linkedin_session_job` functions request only bounded LinkedIn job search/detail navigation. A fixed extension function extracts visible job fields, job links and exposed application anchors, excluding account/profile/messaging surfaces. There is no arbitrary browser-control/code tool, application submission, Apply click or CAPTCHA bypass. Hidden application destinations may remain unavailable. Job observations participate in the existing review/deduplication pipeline; authenticated reading alone does not confirm an opening is active or that an application URL matches it.

Visible job data goes to the selected model and, if enabled, local run history. The bridge credential is passed privately to isolated workers, never included in model messages or saved profiles. Disconnect prevents new requests and rejects pending replies; an already delivered page navigation may finish. Chrome loads pages normally using its own network/session, including site scripts, telemetry and resource requests: this path is **not** the pinned/public-GET-only transport used by the fresh Browser reader. The core still has no mandatory runtime dependencies; using this capability requires the separately installed extension. Local bridge fixtures verify protocol and worker transport, not live Chrome/LinkedIn compatibility; reconnect and run live UAT after installation.


### Browser Companion side panel

The bundled extension now opens a browser side panel (Chrome 116+) with a source tray, chat, task progress/Stop, source references, readable Markdown, interactive tables, Copy and Markdown/CSV export. Model settings use provider buttons and explicit model IDs: local Ollama, Gemini, OpenAI, Groq, DeepSeek or a compatible endpoint. It does not inherit model settings or API keys from an existing workspace tab.

1. Start `agentos serve` at the default `http://127.0.0.1:8765`. Download `/browser-extension.zip` from that workspace, unzip and Load unpacked in Chrome Extensions. Source checkouts can load `src/agentos/static/linkedin-extension` directly. Reload an older installed version to pick up the new sidePanel permission and UI.
2. Click the AgentOS toolbar icon on a page, then **Connect** in the panel to authorize the local workspace connection. Configure a model if needed; the default is local `qwen3:8b`.
3. Choose **Add current tab** to capture a visible text excerpt. For another tab, click the toolbar icon on that tab before adding it. Up to four pages, 3,500 characters of text and observed links each; click a source title to preview what will be sent. Adding the same tab refreshes its snapshot. The panel does not scan or automatically read every open tab.
4. Ask for a summary, extraction or comparison. Selected snapshots are sent to the chosen model on Send. Follow-ups retain prior context. Removing a source affects subsequent snapshots but cannot remove evidence from earlier conversation context; **New chat** clears that context, while **Clear sources & chat** clears both.

General source tabs are snapshots, not an autonomous navigation/click interface. Public web research is a separate opt-in setting; LinkedIn navigation uses the explicitly connected job-tab tools described above. The source reader excludes forms/inputs/editable areas and common navigation, not every possible sensitive statement in page text: preview and choose sources accordingly. No automatic application submission, arbitrary model scripts or all-site permission. Normal site scripts still run in the browser.

Sources, non-secret model preferences and bounded conversation state use Chrome session storage, cleared on browser exit; a panel close alone does not clear them. Workspace authorization remains in background memory; provider API keys stay in the panel and active request only and must be re-entered after panel close. Provider/model/capability changes require New chat before another run. Extension suspension can interrupt an active connection; restored state labels it interrupted rather than claiming completion. Runs use the normal isolated AgentOS stream, five-minute deadline and Stop endpoint, with workspace history off. General research snapshots may contain private page data and are shared with the selected model; public tool reads retain their existing restrictions.

Verification: `python -m unittest discover -s tests -v` covers origin/token restrictions and complete downloadable bundle; `node --test tests/browser_companion.test.cjs` exercises the actual controller with deterministic Chrome/transport fixtures (explicit access, source limits, streaming/follow-ups, Stop, key exclusion and rendering assets). A narrow UI preview checks source/task/settings/answer/table flow using fixture responses; it is not live extension or LinkedIn validation. Manual installation and real-tab UAT remain required.


Installed-extension UAT (2026-10-20): explicit activeTab capture, local workspace connection, qwen3:8b source-cited response and retained follow-up context passed in real Chrome. A simple two-sentence question took 6.35 seconds without planning, and its follow-up took 4.11 seconds. Planning is now an optional **Plan before running** setting, off by default in the companion; lifecycle progress and Stop remain available. The initial mandatory-plan run took 63.15 seconds and produced six rejected plan-update calls, polluting the final answer with internal errors. Making planning optional avoids that default path; it does not fix the model's optional planning-protocol failures. No live LinkedIn job-search pass is inferred from this public-page test.


For local research tasks, make sure Ollama has enough context for tool schemas and posting evidence. The live UAT initially used 4,096 tokens, which may constrain a multi-posting tool conversation; the UAT did not prove this was the sole cause of incomplete research. This machine's retry uses `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`; verify actual allocation with `ollama ps` or `/api/ps`. More context uses more memory, so choose a size your model/hardware can support; this remains a local runtime choice rather than an SDK-forced default. See [Ollama context documentation](https://docs.ollama.com/context-length).

LinkedIn reader compatibility now distinguishes hidden CAPTCHA widgets from visible challenges, supports the observed generic standalone-job layout, and decodes exposed safety/go application redirects through public-URL validation. Missing or Easy Apply destinations are not evidence of closure. Genuine login/verification challenges still require user action; no bypass was added. An unmatched modern description boundary stays unavailable rather than exposing unrelated account content.


### One-time Gemini run from a local key file

Copy `.env.example` to `.env.local` and enter `GEMINI_API_KEY=your_key` in the local file. `.env` and `.env.*` are ignored except the empty example. Then run:

```sh
.venv/bin/agentos run "Use calculate to compute 19 * 23" --provider gemini --model gemini-3.5-flash-lite --api-key-env GEMINI_API_KEY --env-file .env.local
```

The file is loaded only when explicitly selected, for that CLI call. It does not populate the workspace/extension or persist the key. File values take precedence over exported variables. Format: literal KEY=value lines, optional matching quotes, whole-line comments; no export statements, shell execution, escapes or variable interpolation. Other entries are not exported. Keep real keys out of the example. A model listing or key-file read does not establish free quota or successful inference.


Isolated workspace runs retain collected task-tool evidence if a later provider request fails (for example quota HTTP 429). These return `partial` with `limit_reason=provider_error`; no automatic retry or tool replay occurs. A failure before task-tool evidence still reports an error. SDK/CLI provider exception behavior is unchanged.


Connected posting reads can return explicitly labeled partial fields if the description misses its loading deadline. An observed title/application URL does not establish missing experience requirements or an open matching role; the full evidence review still applies.


## Hosted demo

A separate Netlify adapter provides a server-managed Gemini demo with Google sign-in, per-user agents and bounded public research. See [HOSTED_RELEASE.md](HOSTED_RELEASE.md) for setup, production deployment and local-only feature differences. Google client configuration and real sign-in UAT are required before public release.
