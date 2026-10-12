# Security model

Model outputs and tool arguments are untrusted. AgentOS validates structure and scalar types and dispatches only to explicitly registered functions. It never evaluates model text as Python or shell code.

Registered functions and their annotations are trusted application code. They execute in the same process with the user's permissions. Register only functions you trust and expose only the minimum capability the task needs. Tool registration is not a sandbox or an approval system. A blocking or malicious function can still hang, allocate memory, access files, or use the network. Tool output size checks happen after invocation and serialization.

Step/call limits bound orchestration but are not hard wall-clock limits. HTTP timeouts apply to transport operations. The runtime does not roll back earlier tool side effects. Exceptions sent to the model omit arbitrary function exception messages; successful tool outputs and CLI JSON transcripts may still contain sensitive data.

The default Ollama endpoint is local. Selecting a remote endpoint or a remotely served model changes where inference happens. No proxy forwarding, HTTP redirects, telemetry, automatic disk logs, or cloud fallback are implemented.

Before exposing AgentOS to other users or untrusted tools, add process/container isolation, permission policies, hard deadlines, resource limits, and authentication at any network boundary. This MVP is intended for trusted local development.

A private vulnerability reporting channel must be configured before public release. Do not post credentials or sensitive transcripts in public reports.
