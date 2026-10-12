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
