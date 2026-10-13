# Security model

Model outputs and tool arguments are untrusted. AgentOS validates structure and scalar types and dispatches only to explicitly registered functions. It never evaluates model text as Python or shell code.

Registered functions and their annotations are trusted application code. They execute in the same process with the user's permissions. Register only functions you trust and expose only the minimum capability the task needs. Tool registration is not a sandbox or an approval system. A blocking or malicious function can still hang, allocate memory, access files, or use the network. Tool output size checks happen after invocation and serialization.

Step/call limits bound orchestration but are not hard wall-clock limits. HTTP timeouts apply to transport operations. The runtime does not roll back earlier tool side effects. Exceptions sent to the model omit arbitrary function exception messages; successful tool outputs and CLI JSON transcripts may still contain sensitive data.

The default Ollama endpoint is local. Selecting a remote endpoint or a remotely served model changes where inference happens. No proxy forwarding, HTTP redirects, telemetry, automatic disk logs, or cloud fallback are implemented.

Before exposing AgentOS to other users or untrusted tools, add process/container isolation, permission policies, hard deadlines, resource limits, and authentication at any network boundary. This MVP is intended for trusted local development.

A private vulnerability reporting channel must be configured before public release. Do not post credentials or sensitive transcripts in public reports.

## Local browser workspace and API credentials

The workspace listens exclusively on IPv4 loopback, validates the exact Host and browser Origin, and requires an unguessable per-server token on run requests. No CORS access is granted. Static assets are explicitly allowlisted, model output is rendered through DOM-built Markdown with raw HTML kept inert, and responses use no-store and a restrictive CSP. This is a trusted single-user local interface, not a remotely deployable authenticated service; other local processes can access it. Do not expose it through a public proxy.

User-selected API keys are passed in Authorization headers only to the selected API endpoint. Named providers have fixed endpoints; custom compatible endpoints are user configuration and must use HTTPS unless loopback. Proxy environment variables and redirects are disabled. Keys are not persisted, returned in results, or included in HTTP error bodies by AgentOS; Python/browser memory is not secure key storage. The page retains a key until cleared, provider changes, or reload. Cloud providers receive prompts and tool outputs and apply their own retention, access, and billing policies. There is no provider fallback or automatic discovery/import of tools.

Compatible APIs must support text Chat Completions and function tools when tools are enabled. Truncated/filtered responses and malformed tool batches fail before execution. Provider tool-call IDs and metadata are preserved for subsequent turns. The existing trusted in-process tool limitations remain unchanged. There is no hard run cancellation or concurrency/resource isolation; browser disconnects do not roll back a running request.

## Generated agent context

The prompt-to-context endpoint uses the same Host/Origin/token checks as task runs. It makes a single request to the user-selected provider with no registered tools. Generated output must match the bounded name/purpose/instructions/starter_prompts/assumptions schema; malformed output and tool calls are rejected without tool execution. The result is untrusted text rendered in editable controls. It is applied only by the user's Use this agent action and never imports code, registers tools, changes provider/key/model, or expands capabilities. With automatic selection, the model may recommend IDs only from the known available catalog, with reasons; these are reviewed/editable in the draft and are applied only by the user. Manual selections remain supported. The model cannot invent tools or select a file-access root. Instructions guide model behavior rather than enforcing security policy. Context/assumptions may be inaccurate; review them. Descriptions and generated drafts use the selected provider's normal data handling and billing. No brief or active agent is automatically stored on disk.

## Optional public web tools

Web research is opt-in; only the explicitly registered search/read/inspect functions are dispatched. The UI and CLI append an accurate capability description to run instructions, and brief generation receives the selected flags without executing tools. This remains trusted Python code running in-process, not a sandbox. Page content is untrusted evidence rather than instructions or executable code.

The HTTP reader makes GET requests only, with no authenticated sessions, cookies, model/API credentials, environment proxies, script evaluation, form submissions or browser control. It allows only HTTPS port 443 without URL credentials, resolves all candidate addresses and rejects non-global/private/loopback destinations, pins a validated public address for the TLS connection while preserving hostname/certificate verification, and revalidates redirects. Each run has 20 HTTP requests including redirects, a 512 KB per-response cap, up to three followed redirects and 12-second network-operation timeouts. These do not provide a hard overall deadline or process/resource isolation. Rendered/script-only pages are unsupported. Providers can block automated reads; no bypass is attempted.

Queries and URLs go to LinkedIn/Bing/public destination sites; page evidence goes to the selected inference provider. The model should never put secrets into query strings. Application URLs are extracted evidence, not a guarantee of role identity or availability. Hidden links, Easy Apply, closed roles and unverified external URLs are reported separately. Source/application anchors are rendered as validated HTTPS links with noopener/noreferrer; all page/model text uses textContent. Page results are trimmed to fit tool-output budgets. Network request logs are not persisted by AgentOS.

## Budget finalization

Research runs reserve the last configured model request with no tool schemas and disallow tool execution during finalization even if a model requests it. A tool batch exceeding the remaining budget is skipped entirely; its assistant tool calls are not left unanswered in the summary transcript. No additional requests exceed the configured total model budget. Summary failure, invalid/empty content, or continued tool requests produce marked partial output using only collected tool results. This preserves evidence rather than granting execution permissions or retrying side effects. SDK callers retain strict RunLimitError behavior unless they explicitly enable finalize_on_limit. Completed summary text is still model-generated and may need review; budget_summary/partial metadata indicates potentially incomplete work.

## Expanded capabilities and browser rendering

The catalog is a fixed ID allowlist. Automatic description-to-agent selection returns validated IDs and short reasons, not imports, executable code, URLs to install, or a permission-policy program. Applying the draft is the user action that enables reviewed choices. File-reading recommendations cannot grant access until the user configures a specific folder. Local file tools list/read only supported text types, block relative escapes/hidden paths/symlinks/credential-like names, cap read/output sizes, and never write or execute. Filters are not secret detection or OS isolation; user-selected file contents may go to the selected cloud model.

Data tools operate on supplied text using csv/json/regex/statistics, not eval or generated expressions. Writing/summarization and code review are instruction skills, clearly distinguished from registered action tools. Employer job tools GET published Greenhouse/Lever APIs only; no applications or personal details are submitted. URLs are still subject to public-network validation.

The optional Playwright/Chromium module is explicitly trusted, static application code, not dynamically loaded model code. Chromium executes third-party page JavaScript in a fresh context. No user browser profile/session is attached. Every routable HTTP resource is supplied through the DNS-pinned HTTPS reader; methods other than GET, private destinations, websockets, service workers and unnecessary media are blocked. Cookies and auth headers are never forwarded; response Set-Cookie is removed. A fixed init script disables WebRTC peer connections; no model-supplied JavaScript/evaluate input exists. There are no click, fill, login, screenshot-upload, form-submit or download tools. This is a bounded renderer, not an unrestricted browser agent or guaranteed anti-bot bypass. Browser budgets/operation timeouts do not provide a hard run deadline or complete system-level resource isolation.

## Answer formatting and downloads

The formatter uses createElement/createTextNode/textContent, never innerHTML, eval or model-controlled DOM/event code. Only a known Markdown subset produces predefined elements. Raw HTML and image markup never create active HTML/images; answer links accept HTTP(S) only with no credentials and open with noopener/noreferrer. Clicking a model-provided link is not evidence that it is verified; tool-source cards remain separately labeled. No remote assets, scripts or fonts are fetched for formatting.

Code blocks are display-only with user-initiated copy. Checklist changes, table filters and sorting affect the current display, not the agent or original answer. Markdown/CSV downloads are user-initiated local Blob artifacts and the temporary object URL is revoked. Markdown preserves model text exactly; CSV includes currently visible/sorted rows, quotes cells and prefixes cells with leading formula markers to reduce spreadsheet formula execution risk. Preview/table limits bound rendering; complete raw output remains available. No conversation persistence was added.
