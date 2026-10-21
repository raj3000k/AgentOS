# Live UAT — 2026-10-20

## Environment and scope

Local workspace at http://127.0.0.1:8765 with Ollama at http://127.0.0.1:11434, installed qwen3:8b, real isolated workers and public network reads. No mocked inference or research responses. Servers left running. Visible Chromium exercised the job-search workflow; saved-result and calculator smoke checks used Chromium automation.

Job run: web_research, job_boards and browser_reading selected, planning enabled, 16 model steps, 24 tool calls, 120-second request timeout, 300-second total deadline. Local history explicitly enabled. Task: five current SDE 1 / junior software engineering openings in Bangalore/Bengaluru, minimum required experience at most two years, exact company application links and evidence.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Server/model/browser capability availability | Pass | Workspace and provider endpoints ready; browser reader available |
| Live job-search outcome | Fail | Zero verified openings, no exact apply links |
| Honest final answer | Pass | Reported inability to verify; did not invent openings |
| Fallback and completion | Fail | Stopped after LinkedIn plus one web search; company-board/browser tools unused; job review absent |
| Visible incomplete plan | Pass | Blocked/unfinished steps shown explicitly |
| Saved result reopening | Pass | Answer and incomplete-plan review restored through library |
| Trusted tool execution smoke | Pass | 19 × 23 = 437; 2 model requests, 1 calculator call, 4.31 seconds |
| Frontend errors during job run | Pass | No JavaScript page errors observed |
| Offline regressions | Pass | 121 tests, 34.239 seconds |

## Job-search trace

Runtime reported 51.68 seconds, 6 model requests, 4 tool calls; finished normally rather than exhausting time or step limits. Tool sequence:

1. search_linkedin_jobs: HTTP 429, blocked, zero candidates.
2. update_task_plan: marked LinkedIn step blocked, citing collected evidence.
3. search_web: HTTP 200, but Bing RSS returned Claude-related pages unrelated to the requested jobs.
4. update_task_plan: marked web-search step blocked. Agent then produced a final answer.

No company feeds, browser reads, posting inspections, application verification or review_job_results calls occurred. Therefore this run does not validate job matching, deduplication or exact application-link quality against live openings. Existing deterministic tests cover those components separately. HTTP success alone did not establish useful search results.

## Follow-up defects, in priority order

1. Research recovery: one blocked discovery source and one irrelevant query should trigger bounded alternate queries/source strategies while budgets remain. Board slugs must still come from observed sources.
2. Search quality: detect low-relevance results and support a reliable alternative discovery source rather than treating Bing RSS availability as useful search coverage.
3. Finalization: explicitly report unmet job-review/completion criteria and recovery attempts. Preserve honest partial results and never promote unverified links to confirmed matches.

No runtime code changed in this UAT. Ignored work/uat-live-result.json, work/uat-saved-run.json, work/uat-live.png and work/uat-regression.log retain local diagnostic evidence. The live job run is also saved in the workspace library. Stop/deadline behavior was covered by regression tests, not separately exercised in this live UAT.


## Installed Browser Companion UAT — 2026-10-20

User installed the unpacked 0.2.0 extension. Verified it enabled in Chrome, invoked its toolbar action on a public HTTPS source, connected to the running local workspace and captured only that explicitly chosen page. The source appeared in the tray, and its contents were sent to local qwen3:8b through the real isolated-run endpoint.

- Initial mandatory-planning run: relevant source-cited answer, but 63.15 seconds, three model requests and six tool calls; the model reported repeated plan-update failures, all plan checkpoints stayed pending and internal error discussion polluted the answer. This fails the clean-response acceptance criterion. Exact rejected argument/error envelopes were not collected; underlying optional planner behavior remains an open issue.
- Fix: companion **Plan before running** is now explicit and off by default. General lifecycle progress/Stop remains available; the main workspace's planning default is unchanged. Updated only the three affected UI/controller files in the user-installed unpacked copy after verifying other extension assets matched the repository; reloaded it through Chrome UI.
- Real retest: two concise sentences correctly described the selected public page and cited its exact source URL. 6.35 seconds, one model request, zero tool calls; no internal planner failure commentary.
- Follow-up: correctly recalled the previous source URL in one line. 4.11 seconds, one model request, zero tool calls. This establishes retained context for the installed companion rather than only a fixture transport.
- No generic all-tabs access was granted and no private user page, form, application or message was submitted. This test does not establish live LinkedIn job search, exact employer-link verification or optional planning reliability. Live Stop behavior was not separately exercised here; existing process/controller tests cover it.


## Authenticated LinkedIn job search — 2026-10-21

Verdict: **FAIL for five verified matching employer application links.** Browser navigation/read capability itself works on real postings.

With installed Chrome companion and local qwen3:8b (16,384 context), the full run completed in 355.69 seconds: 17 model requests, 16 tool calls, seven inspected postings. Review classified zero confirmed, five uncertain, two excluded. Model prose contradicted review by softening excluded roles and mislabeling Easy Apply links. A focused retry took 81.18 seconds, four tool calls, and returned missing details then disconnected-session errors without a shortlist.

Fixes from real traces: modern scoped job extraction, visible-challenge detection, observed safety redirect unwrapping, Easy Apply non-closure semantics, repeated experience-range handling and Ashby semantic query identity. A further bridge fix refreshes heartbeat on a validated nonexpired reply, avoiding false disconnection immediately after a long read. Offline coverage does not establish live success; the running Python server still needs restart/re-pair for that fix. Missing descriptions, during-read heartbeat status, model summary consistency, discovery coverage and automated form verification remain open.

Manual independent checks found two visible application forms, Kulfi and Avoca; see JOB_SEARCH_RESULTS_2026-10-21.md. No personal fields were filled and no applications submitted. These checks must not be counted as agent automation success. Glean's six-year minimum excludes it from the requested junior shortlist. Easy Apply does not imply a closed opening.


## Gemini API preflight — 2026-10-22

User configured Gemini / gemini-3.8-flash in the workspace. Used that same live tab without reading, exporting or persisting the API key. Calculator only, planning off, history off; prompt requested calculate(19,23,multiply). Both the initial attempt and one manual retry ended at the first inference request with “Provider returned HTTP 503. Request failed.” No model response/tool execution or successful key/model validation was established. Job-search UAT was not started. Google documents 503 as temporary unavailability/overload; this HTTP status alone does not establish the exact cause or quota/key validity. No provider/model switch, billing change or repeated retry loop was performed. Workspace remains open; LinkedIn connection currently Not connected.


### Gemini diagnosis follow-up — 2026-10-22

The same configured workspace successfully generated a valid Precision Calculator agent brief with gemini-3.8-flash. This live context request confirms the entered key/model/compatibility method worked for that request. Applied the generated draft and requested calculate(19,23,multiply); applying a draft restored planning on. That run failed at the initial planning request with HTTP 503, before any calculator tool execution. The updated adapter displayed the fixed temporary-unavailability hint; no allowlisted Google status label was present in that captured error. Therefore live Gemini access is intermittent; trusted tool roundtrip and job research remain unverified. No raw error body or API key was exposed. 133 offline tests pass (39.161 seconds).


### Explicit local key-file trial — 2026-10-22

One CLI run loaded GEMINI_API_KEY from ignored .env.local using --env-file, Gemini/gemini-3.8-flash, calculator enabled, no planning, max_steps 4, request timeout 45 seconds. Provider returned HTTP 503 before tool execution. Credential was not printed or archived and was cleared from the local file after this one-time trial. File loader is verified; live inference/key validity remains unconfirmed for this particular request. 135 offline tests pass.


### Replacement local-key verification — 2026-10-22

After user saved a replacement in ignored .env.local, one calculator inference attempt again returned HTTP 503 before tools. The official authenticated /v1beta/openai/models endpoint succeeded with the same local key. Model IDs in this response use a models/ prefix; after normalizing that prefix, gemini-3.8-flash is present (as are gemini-2.5-flash and gemini-3.5-flash). This confirms the credential is accepted for model listing and the selected ID is listed, but not generation quota or availability. No raw key/error body was displayed or archived, no model switch or billing changes were made, and the replacement remains only in the ignored local file.


### Minimal inference retry — 2026-10-22

At user request, retried a plain “Reply with only OK” call using the replacement key in .env.local. AgentOS OpenAI-compatible chat endpoint returned HTTP 503 with no tools/planning. A separate direct POST to Google's documented /v1beta/interactions endpoint using x-goog-api-key and the same model/prompt also returned HTTP 503. Thus this failure reproduces outside AgentOS's adapter; model-list authentication succeeded in the preceding check, while generation remains unavailable at this check. No raw provider response or key displayed; no retries/model/billing changes beyond these two explicit diagnostic requests.


### Older-model fallback success — 2026-10-22

User authorized an older/lighter model trial with the same ignored local key. gemini-2.5-flash-lite returned HTTP 404 on the compatibility chat endpoint despite appearing in the preceding model list. gemini-2.5-flash then successfully returned OK for a plain one-request call. A separate real calculator run completed with final 437, two model calls and one successful calculate(19,23,multiply) call. No planning, synthetic inference or key replacement was used. This establishes live text generation and trusted tool-result roundtrip for gemini-2.5-flash at this check; job search, free-tier quota and continued availability are not yet established. Keep model choice explicit; no runtime default or workspace key setting changed.


### Gemini job-agent UAT — 2026-10-22

Real isolated workspace run using gemini-2.5-flash and the ignored local key, public web/company boards/browser reader, planning off, 24 model steps/40 tool calls/90-second request timeout/600-second deadline. LinkedIn bridge was not paired, so authenticated session tools were not enabled. First run completed in 63.16 seconds (7 model calls, 17 tool calls): inspected five postings, nine web searches, one public LinkedIn search, one page read and one browser read. No verified employer application URLs; review/verification tools were skipped. Final prose called the candidates uncertain but overclaimed experience fit and included one inconsistent Cisco URL in prose. Employer-feed tools were not used; Bing relevance remained poor. Saved history ID 4d4c3380-7538-4905-8464-a7482649bb82.

Focused fresh-collector reread/review run completed in 23.57 seconds (7 model calls, 6 tool calls), including all five posting reads and review_job_results: zero confirmed, two uncertain (TalentRabbit, Cite AI), three blocked (two Amazon roles and Cisco), zero excluded/closed. Final counts/categories matched the review, with no exact application URLs promoted. Saved history ID 6601ca85-2ce6-461d-82dc-0fc9310cea64. Ignored diagnostic results are work/gemini-job-result.json and work/gemini-job-review-result.json; requests/keys were not archived. Five verified-opening acceptance remains FAILED. Gemini does execute research tools, but changing models alone does not resolve source access/recovery or review compliance.

User reported pairing code absent from extension. Confirmed workspace Connect LinkedIn generates a masked code with Copy code; extension Settings accepts this code rather than generating one. Generated/copied a fresh code through actual UI without displaying it in chat. Status Waiting for extension/tab; authenticated retry awaits user paste/connect. No permission expansion or cookie access.


### Authenticated Gemini run and quota failure — 2026-10-22

Confirmed bridge connected/paired. Actual gemini-2.5-flash run performed one search_linkedin_session, five inspect_linkedin_session_job, four verify_job_application and one review_job_results. HTTP 429 occurred on model step five before final prose. The pre-fix error path archived only an error, so observed tool completion does not establish result categories or valid links; those outputs cannot be recovered from this response. Implemented isolated-worker partial evidence retention for subsequent provider failures, with 136 offline tests passing (40.296 seconds). A bounded connected retry hit 429 at its first inference and produced no new evidence; stopped further requests. Evidence-retention live validation awaits available quota; five-opening acceptance remains unmet.


### 15-RPM Flash Lite trial — 2026-10-22

User authorized trying the dashboard's 15-RPM models. gemini-3.1-flash-lite returned HTTP 503 for a minimal request. gemini-3.5-flash-lite returned OK, then completed a calculator tool roundtrip (437, two model calls/one tool call) with preserved Google tool-call metadata. No key values printed or changed.

Connected job-agent run with gemini-3.5-flash-lite completed in 161.65 seconds: seven model requests, twelve tool calls, no HTTP 429. Eight model-step cap, planning off, same public/company/browser/connected capabilities. Two LinkedIn session searches read candidate lists; all five posting detail reads returned no_job_details after their loading deadline. Four public searches and one review call followed. Deterministic review returned zero confirmed, four uncertain, one excluded, zero closed/blocked. Final answer reflected these counts and did not claim verified application URLs. Saved history ID f7200789-a3fc-4c72-b75d-84daea551c80; ignored diagnostic work/gemini-flash-lite-job-result.json.

This demonstrates useful Live API support is not required to exceed the previous 20-request daily constraint: the user's dashboard showed Flash Lite 15 RPM/500 RPD, and this bounded trial completed without rate limiting. It does not prove future quota availability, superior general model quality, or job-search acceptance. Current blocker is LinkedIn description extraction. CUA's Chrome inventory became unavailable during the test; the AgentOS extension nonetheless returned search results and timed-out detail responses, so browser closure is not established. Bridge connected status was stale during long reads, consistent with the previously documented heartbeat issue; installed extension update/live validation remain pending. No runtime default or active workspace UI model/key was silently changed.


### Posting deadline retention fix — 2026-10-22

Reader retains scoped partial posting fields at its deadline rather than discarding observed title/destination because description is missing. Explicit description_status=partial keeps missing experience unknown and review uncertain. Offline: 137 Python tests/7 Node tests pass. Installed background.js updated after other assets/manifest matched; Chrome UI control unavailable, so user must reload and re-pair before a live retry. This is fixture-verified behavior, not an authenticated extraction pass.


### Post-reload live reader and Flash Lite retry — 2026-10-22

User reloaded/re-paired the installed extension; backend confirmed connected/paired. Single Cashfree probe completed in 11.27 seconds (four model requests/three tools, budget_summary due to the explicit four-step cap): connected posting read returned visible description/1–3-year requirement and observed Kula destination, reachability check HTTP 200, deterministic uncertain review. No partial fallback triggered; this establishes successful normal extraction after reload, not live validation of the missing-description fallback. CUA Chrome inspection remained unavailable, so no unsupported root-cause claim about the prior description timeouts.

Broader connected gemini-3.5-flash-lite run completed in 39.79 seconds: five model requests, twelve tools, no 429. One connected search, five actual posting reads, five destination checks, one review. Review: zero confirmed, three uncertain (Google/Cisco/Cashfree), two excluded (Glean minimum six years; Uber title mismatch), zero closed/blocked. Cashfree/Cisco destinations returned HTTP 200 reachability only; Google destination check failed; Glean exact Greenhouse publication was confirmed but excluded for seniority. All five reads returned visible nonempty descriptions, labeled complete by the reader; that label does not guarantee all collapsed source content was expanded.

Final prose matched categories/counts but incorrectly said all three uncertain roles met experience criteria: Cisco's actual review has unknown role/ambiguous experience. Do not repeat that assertion. Five verified matching openings acceptance remains unmet; link extraction/tool use and quota behavior improved. Saved history IDs c191abcf-fd37-4e40-aa35-a0306c1dda9d (probe) and a37e715f-dd49-4385-9746-d4a278126c47 (broader run). Ignored evidence work/gemini-reader-probe-result.json and work/gemini-post-reload-job-result.json. See JOB_SEARCH_RESULTS_2026-10-22.md for conservative user-facing links. No code change in this live validation; prior offline counts remain 137 Python/seven Node.


### One-click connection UX — 2026-10-22

Version 0.3.0 moves LinkedIn connection to a top-level companion card. Explicit Connect this LinkedIn tab checks active origin/activeTab access, connects the local workspace, obtains/stores the bridge credential internally and enables job research. No visible code generation/copy/paste controls in workspace or panel. Real status and disconnect remain. No new extension permissions. Token-protected valid extension-origin pairing allowed; CRUD still denied. Offline validation: 137 Python tests, eight Node tests; running ZIP verified with nine assets/version 0.3.0. Installed copy updated and AgentOS restarted. Chrome UI control unavailable; one-time extension reload, live pairing and visual layout checks pending.
