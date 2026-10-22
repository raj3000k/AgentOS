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

Hosted: writing, supplied-code review without execution, arithmetic, supplied-text links, public web/LinkedIn pages where accessible, Greenhouse/Lever feeds, explicitly connected LinkedIn job tab via companion 0.4.0, editable drafts, saved profiles, follow-ups, readable output/evidence.

Local-only: user-chosen providers/keys/Ollama, local companion chat/source tray, filesystem/data tools, browser renderer, SQLite run archives, Python execution isolation and richer planning/completion checks. The scoped hosted relay requires explicit extension connection and the bound workspace tab; merely opening LinkedIn grants no access.

## Before expanding the demo

Complete real Google two-account UAT; test production Blobs concurrency and cleanup; add profile deletion/export, privacy/terms/contact pages, persistent run recovery/history, abuse protection beyond per-account caps, monitoring/billing alerts and live cloud companion acceptance testing. Google access is open once configured, so global limits protect the shared key but do not stop deliberate allowance exhaustion. Test job relevance/experience/exact destinations independently; no verified-opening guarantee is made.


## Hosted companion 0.4.0 setup and boundary

Download `/browser-extension.zip` from the hosted run workspace, unzip and load the `agentos-browser-companion` directory in chrome://extensions (Developer mode → Load unpacked), or reload the existing updated installation. The new manifest adds an exact production-origin content script; review Chrome's permission prompt if shown. No wildcard LinkedIn host, cookies, tabs or debugger permissions are added.

On LinkedIn, click the AgentOS toolbar icon to grant activeTab, then choose **Connect LinkedIn to hosted AgentOS** in its side panel. This opens one linked AgentOS workspace tab. Sign in there, keep both tabs open and use its Run workspace. The connected-tab switch opts that run into the fixed LinkedIn job-search/posting readers. Other AgentOS tabs are not authorized by that binding. Reconnect to change workspace tabs. Local chat controls remain explicitly local and require the Python server; hosted runs happen in the website with its server-managed Gemini key.

The website's signed session, Origin and CSRF checks authorize model steps/results. The extension never receives those credentials. A top-frame isolated content script on the exact hosted origin transports fixed actions; the background also checks the bound workspace tab ID. The website is consequently trusted to request scoped job reads while connected; content-script isolation does not protect against compromise of that trusted origin. Page and client observations remain untrusted evidence. Logout/disconnect/tab closure/Chrome session expiry revokes the binding. The first signed-in website identity binds a session-only SHA-256 email marker in the extension; normal account changes are rejected until reconnect. This marker comes from the trusted website, not a separately verified Google token. Do not share browser sessions with other users.

Each browser read is bounded to roughly 25 seconds, at most four in a batch, with a 150-second batch expiry. Stop prevents future steps but an in-flight read may finish. Reload does not restore the run ID automatically. Google two-account UAT, Chrome live end-to-end reads and stale/disconnected session behavior must be tested before claiming full acceptance.
