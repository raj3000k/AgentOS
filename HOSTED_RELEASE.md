# Hosted AgentOS demo

Site: https://agentos-workspace-raj.netlify.app

The hosted adapter is separate from the dependency-free Python runtime. Netlify cannot host the existing long-running loopback Python server unchanged. Node functions provide fixed Gemini inference, Google sign-in, per-user profiles and resumable bounded research steps. It is a small public demo, not full local feature parity.

## Branches and deployment

`main` is development. `prod` is the production snapshot. Build with `npm ci && npm run test:hosted && npm run build`. From the tested `prod` snapshot, deploy with `npx netlify-cli deploy --build --prod`. The linked site is recorded only in ignored `.netlify/state.json`. CLI/manual deployment is used; automatic Git deployments are not configured. Never deploy directly from an unreviewed development checkout.

## Google setup (required before sign-in works)

1. In Google Cloud → Google Auth Platform, configure app branding/audience (External). Basic sign-in only; no Gmail/Drive/LinkedIn permissions.
2. Create a Web application OAuth client at https://console.cloud.google.com/auth/clients.
3. Authorized JavaScript origin: `https://agentos-workspace-raj.netlify.app`. No redirect URI is required for the GIS JavaScript credential callback used here.
4. Set Netlify `GOOGLE_CLIENT_ID` to the public ID ending in `.apps.googleusercontent.com`, then redeploy. Do not send/store a client secret for this flow.
5. Complete any Google audience/publishing requirements for people outside test users. Verify sign-in/sign-out and isolation using two actual Google accounts before calling this a completed public release.

Google setup documentation: https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid

## Server configuration

Functions read `GEMINI_API_KEY`, `GEMINI_MODEL` (currently `gemini-3.5-flash-lite`), `AGENTOS_SESSION_SECRET` (random 32+ characters), `AGENTOS_SITE_URL`, `GOOGLE_CLIENT_ID`, `AGENTOS_USER_DAILY_LIMIT` (24) and `AGENTOS_GLOBAL_DAILY_LIMIT` (160). Secrets are server environment variables, never HTML/build substitutions, browser storage, API responses or Git files. Do not replace `.env.example` with real credentials. Rotate the session secret to revoke all existing session tokens.

Only the fixed Gemini endpoint/model is used. Immutable conditional claim keys conservatively count attempted model requests; one shared six-second time slot paces approximately ten RPM across users, beneath the previously observed 15 RPM project allowance. User/global daily budgets use Pacific calendar days. These are application caps, not a billing guarantee: direct API usage elsewhere, provider token quotas and Netlify usage are separate. No automatic paid upgrades.

## Data and trust boundaries

Google RS256 ID tokens are verified against Google keys with audience/issuer/expiry and cookie-bound nonce checks. Eight-hour signed HttpOnly Secure SameSite cookies have persisted revocation records. Mutating requests require exact Origin and CSRF headers. User storage keys derive from verified Google subject, never a client-supplied account ID.

Netlify Blobs stores saved profiles until deletion/site removal, session revocation records for eight hours, run prompts/model/tool evidence for one hour, pacing/usage ledgers for up to three days. An hourly scheduled cleanup removes expired records; cleanup timing is best effort. Browser follow-ups remain in page memory and clear on reload. Saved profiles are currently create/list only (maximum thirty); deletion/export and persistent run history are follow-up work. Do not use the demo for sensitive data. Prompt and tool evidence goes to Gemini; Google supplies basic identity, and Netlify stores the data above.

Only registered trusted read-only functions run. No model code, arbitrary imports, shell commands, form submission, cookies, private files or unrestricted browser access. Web search filters irrelevant results and tries one DuckDuckGo HTML fallback when Bing yields no relevant candidates; this does not guarantee discovery. Public HTTPS reads use a fixed host allowlist, bounded bodies/deadlines, and every redirect is revalidated; unsupported hosts return an explicit limitation. Employer board IDs must appear in observed source URLs. Completed job answers with a review are rendered from captured review records instead of model prose, preserving categories, experience quotes and missing apply destinations. Job matches use a conservative review; unknown experience or public-page-only publication stays uncertain. This hosted classifier is separate from the richer Python classifier and needs wider quality evaluation.

Each step makes at most one model request and four fixed tool calls. Maximum six model requests, then a tool-disabled summary. Stop blocks subsequent steps; an in-flight read/request may still finish. Claims prevent replay of an interrupted step; after ninety seconds it returns preserved partial evidence. A run expires after one hour. Reload does not currently restore its run ID automatically.

## Supported / local-only

Hosted: six work categories and twelve editable on-demand workflows, writing, supplied-code review without execution, arithmetic, supplied-text links, CSV quality/numeric summaries and JSON validation, public web/LinkedIn pages where accessible, Greenhouse/Lever feeds, explicitly connected LinkedIn job tab via companion 0.4.0, editable drafts, saved profiles, follow-ups, readable output/evidence.

Local-only: user-chosen providers/keys/Ollama, local companion chat/source tray, filesystem/data tools, browser renderer, SQLite run archives, Python execution isolation and richer planning/completion checks. The scoped hosted relay requires explicit extension connection and the bound workspace tab; merely opening LinkedIn grants no access.

## Before expanding the demo

Complete real Google two-account UAT; test production Blobs concurrency and cleanup; add profile deletion/export, privacy/terms/contact pages, persistent run recovery/history, abuse protection beyond per-account caps, monitoring/billing alerts and live cloud companion acceptance testing. Google access is open once configured, so global limits protect the shared key but do not stop deliberate allowance exhaustion. Test job relevance/experience/exact destinations independently; no verified-opening guarantee is made.


## Hosted companion 0.4.0 setup and boundary

Download `/browser-extension.zip` from the hosted run workspace, unzip and load the `agentos-browser-companion` directory in chrome://extensions (Developer mode → Load unpacked), or reload the existing updated installation. The new manifest adds an exact production-origin content script; review Chrome's permission prompt if shown. No wildcard LinkedIn host, cookies, tabs or debugger permissions are added.

On LinkedIn, click the AgentOS toolbar icon to grant activeTab, then choose **Connect LinkedIn to hosted AgentOS** in its side panel. This opens one linked AgentOS workspace tab. Sign in there, keep both tabs open and use its Run workspace. The connected-tab switch opts that run into the fixed LinkedIn job-search/posting readers. Other AgentOS tabs are not authorized by that binding. Reconnect to change workspace tabs. Local chat controls remain explicitly local and require the Python server; hosted runs happen in the website with its server-managed Gemini key.

The website's signed session, Origin and CSRF checks authorize model steps/results. The extension never receives those credentials. A top-frame isolated content script on the exact hosted origin transports fixed actions; the background also checks the bound workspace tab ID. The website is consequently trusted to request scoped job reads while connected; content-script isolation does not protect against compromise of that trusted origin. Page and client observations remain untrusted evidence. Logout/disconnect/tab closure/Chrome session expiry revokes the binding. The first signed-in website identity binds a session-only SHA-256 email marker in the extension; normal account changes are rejected until reconnect. This marker comes from the trusted website, not a separately verified Google token. Do not share browser sessions with other users.

Each browser read is bounded to roughly 25 seconds, at most four in a batch, with a 150-second batch expiry. Stop prevents future steps but an in-flight read may finish. Reload does not restore the run ID automatically. Google two-account UAT, Chrome live end-to-end reads and stale/disconnected session behavior must be tested before claiming full acceptance.


Companion 0.4.1 tolerates Chrome withholding the workspace tab URL in tabs.get; actual requests still validate sender origin/frame/tab/account. The Run workspace includes **Test LinkedIn access**, a quota-free fixed job-search read. Its count is visible candidates only, not verified openings. Reload 0.4.1 and reconnect after updating; no new permissions are required.


Companion 0.4.2 configures Chrome's native toolbar-to-side-panel behavior and makes cosmetic icon drawing nonfatal. It adds no permissions. If Chrome still shows a warning, copy the exact error sentence: a displayed manifest by itself does not identify the failure. Native side-panel setup follows https://developer.chrome.com/docs/extensions/reference/api/sidePanel.


## Category-based creation and task workflows (2026-10-26)

The public homepage explains the platform and six categories: Research, Career, Content, Engineering, Data and Planning. A shared static catalog (`netlify/lib/workflows.mjs`, copied to the frontend at build time) supplies twelve ready-to-edit workflow agents. These are fixed trusted templates, not model-generated programs. Selection/preparation uses no model requests. Supply up to 6,000 characters, prepare the task, review it and explicitly start the existing bounded run engine. Category/workflow IDs are allowlisted and saved with agent profiles; older profiles default to General. The model can recommend one allowed category for custom agents, and users can edit it with category buttons.

Data adds registered `analyze_csv` and `inspect_json` functions in `netlify/lib/data-tools.mjs`. CSV inputs are bounded to 12,000 characters, 200 data rows and 30 columns, with unique nonempty headers and consistent row widths. Quoted commas/newlines/escaped quotes are parsed as data; formulas are never evaluated. Numeric summaries accept finite numeric cells within ±1e12, report missing values and do not infer causation. JSON parsing returns validity/type/keys/array length and executes no content. Neither tool reads files or accesses a network.

Automation in this milestone means repeatable user-started tasks with selected tools and reviewable outputs. No cron scheduling, background jobs, external writes, message sending, application submission or multi-agent orchestration is added. Prepared briefs remain in page memory; existing one-hour hosted run retention and unfinished persistent-history work are unchanged. The local Python UI/CLI keeps its existing capability catalog; the new category workflow hub is hosted-specific. The companion is explicitly optional/experimental and is unnecessary for these workflows.


### Hosted knowledge workspace

Add titled PDF/text/Markdown references in **Knowledge**, then choose up to four in **Run workspace**. Use **Preview relevant passages** to inspect retrieval without model calls. **Answer only from selected sources** disables external tools and excludes earlier answers; if no keyword matches are found, the run abstains without calling Gemini. **Ask your documents** prepares a reference-focused agent. Normal runs without selected documents remain available.

References are private to the authenticated account, stored on AgentOS hosting until removed (12 documents, 30,000 characters each). Adding text stores it; a run sends only its retrieved excerpts to Gemini. Existing runs retain their excerpt snapshots until their one-hour expiry even after the original is removed. No automatic private file access or external document sync exists. Import accepts PDF, text and Markdown. PDF.js extracts selectable text in a dedicated browser worker before saving; the original PDF is not uploaded. PDFs are limited to 15 MB, 60 pages and 30,000 extracted characters, with cancellation and a 30-second extraction timeout. Page markers and empty-page warnings are retained for review. Scanned/image-only PDFs need OCR (not included); password-protected PDFs need an unlocked copy. Import does not execute PDF scripts, forms, actions or attachments. Retrieval uses overlapping chunks and keyword ranking, not embeddings or semantic understanding; paraphrased questions may miss relevant passages. Source labels and exact excerpts are inspectable, and unknown/missing citation labels are flagged, but citation checks do not prove factual support. Source selections are per task, not attached to saved agents. Reference content is untrusted data and cannot grant tools or execute instructions. The local Python runtime is unchanged.
