# Security model

Model outputs and tool arguments are untrusted. AgentOS validates structure and scalar types and dispatches only to explicitly registered functions. It never evaluates model text as Python or shell code.

Registered functions and their annotations are trusted application code. They execute in the same process with the user's permissions. Register only functions you trust and expose only the minimum capability the task needs. Tool registration is not a sandbox or an approval system. A blocking or malicious function can still hang, allocate memory, access files, or use the network. Tool output size checks happen after invocation and serialization.

Step/call limits bound orchestration but are not hard wall-clock limits. HTTP timeouts apply to transport operations. The runtime does not roll back earlier tool side effects. Exceptions sent to the model omit arbitrary function exception messages; successful tool outputs and CLI JSON transcripts may still contain sensitive data.

The default Ollama endpoint is local. Selecting a remote endpoint or a remotely served model changes where inference happens. No proxy forwarding, HTTP redirects, telemetry, automatic disk logs, or cloud fallback are implemented.

Before exposing AgentOS to other users or untrusted tools, add process/container isolation, permission policies, hard deadlines, resource limits, and authentication at any network boundary. This MVP is intended for trusted local development.

A private vulnerability reporting channel must be configured before public release. Do not post credentials or sensitive transcripts in public reports.

## Local browser workspace and API credentials

The workspace listens exclusively on IPv4 loopback, validates the exact Host and browser Origin, and requires an unguessable per-server token on run requests. No CORS access is granted. Static assets are explicitly allowlisted, model output is rendered as plain text, and responses use no-store and a restrictive CSP. This is a trusted single-user local interface, not a remotely deployable authenticated service; other local processes can access it. Do not expose it through a public proxy.

User-selected API keys are passed in Authorization headers only to the selected API endpoint. Named providers have fixed endpoints; custom compatible endpoints are user configuration and must use HTTPS unless loopback. Proxy environment variables and redirects are disabled. Keys are not persisted, returned in results, or included in HTTP error bodies by AgentOS; Python/browser memory is not secure key storage. The page retains a key until cleared, provider changes, or reload. Cloud providers receive prompts and tool outputs and apply their own retention, access, and billing policies. There is no provider fallback or automatic discovery/import of tools.

Compatible APIs must support text Chat Completions and function tools when tools are enabled. Truncated/filtered responses and malformed tool batches fail before execution. Provider tool-call IDs and metadata are preserved for subsequent turns. The existing trusted in-process tool limitations remain unchanged. There is no hard run cancellation or concurrency/resource isolation; browser disconnects do not roll back a running request.

## Generated agent context

The prompt-to-context endpoint uses the same Host/Origin/token checks as task runs. It makes a single request to the user-selected provider with no registered tools. Generated output must match the bounded name/purpose/instructions/starter_prompts/assumptions schema; malformed output and tool calls are rejected without tool execution. The result is untrusted text rendered in editable controls. It is applied only by the user's Use this agent action and never imports code, registers tools, changes provider/key/model, or expands capabilities. Applying restores only capability flags chosen by the user before generation; the model does not choose them. Instructions guide model behavior rather than enforcing security policy. Context/assumptions may be inaccurate; review them. Descriptions and generated drafts use the selected provider's normal data handling and billing. No brief or active agent is automatically stored on disk.

## Optional public web tools

Web research is opt-in; only the explicitly registered search/read/inspect functions are dispatched. The UI and CLI append an accurate capability description to run instructions, and brief generation receives the selected flags without executing tools. This remains trusted Python code running in-process, not a sandbox. Page content is untrusted evidence rather than instructions or executable code.

The HTTP reader makes GET requests only, with no authenticated sessions, cookies, model/API credentials, environment proxies, script evaluation, form submissions or browser control. It allows only HTTPS port 443 without URL credentials, resolves all candidate addresses and rejects non-global/private/loopback destinations, pins a validated public address for the TLS connection while preserving hostname/certificate verification, and revalidates redirects. Each run has 20 HTTP requests including redirects, a 512 KB per-response cap, up to three followed redirects and 12-second network-operation timeouts. These do not provide a hard overall deadline or process/resource isolation. Rendered/script-only pages are unsupported. Providers can block automated reads; no bypass is attempted.

Queries and URLs go to LinkedIn/Bing/public destination sites; page evidence goes to the selected inference provider. The model should never put secrets into query strings. Application URLs are extracted evidence, not a guarantee of role identity or availability. Hidden links, Easy Apply, closed roles and unverified external URLs are reported separately. Source/application anchors are rendered as validated HTTPS links with noopener/noreferrer; all page/model text uses textContent. Page results are trimmed to fit tool-output budgets. Network request logs are not persisted by AgentOS.

## Budget finalization

Research runs reserve the last configured model request with no tool schemas and disallow tool execution during finalization even if a model requests it. A tool batch exceeding the remaining budget is skipped entirely; its assistant tool calls are not left unanswered in the summary transcript. No additional requests exceed the configured total model budget. Summary failure, invalid/empty content, or continued tool requests produce marked partial output using only collected tool results. This preserves evidence rather than granting execution permissions or retrying side effects. SDK callers retain strict RunLimitError behavior unless they explicitly enable finalize_on_limit. Completed summary text is still model-generated and may need review; budget_summary/partial metadata indicates potentially incomplete work.
