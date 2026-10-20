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
