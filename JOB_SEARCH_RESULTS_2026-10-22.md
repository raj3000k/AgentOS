# AgentOS job-search check — 22 October 2026

Real connected LinkedIn research using Gemini 3.5 Flash Lite. The broader run took 39.79 seconds, five model requests and twelve tool calls, with no 429. Posting extraction succeeded for all five inspected jobs. No applications were submitted.

## Matching candidates with observed destinations

| Candidate | Evidence from posting | Exact observed destination | Verification limitation |
| --- | --- | --- | --- |
| Cashfree — Frontend Engineer-1 | Bengaluru; 1–3 years of hands-on frontend development | [Cashfree Kula posting](https://careers.kula.ai/cashfree/64118-frontend-engineer-1) | HTTP 200 reachability only; active form/employer-feed identity not verified |
| Google — Software Engineer, Search | Bengaluru; 1 year of software development experience | [Google Careers posting](https://careers.google.com/jobs/results/122710813273137862-software-engineer/?src=Online/LinkedIn/linkedin_us&utm_source=linkedin&utm_medium=jobposting&utm_campaign=contract) | Observed on LinkedIn; destination check failed, so current availability not confirmed |

Sources: [Cashfree LinkedIn posting](https://www.linkedin.com/jobs/view/4481150240/) and [Google LinkedIn posting](https://www.linkedin.com/jobs/view/4463551100/). Requirements above are collected visible evidence, not complete candidate eligibility checks. Cashfree matches the requested minimum-experience-at-most-two criterion because its lower bound is one; its advertised range extends to three.

Cisco's [observed posting](https://www.linkedin.com/jobs/view/4437417252/) remains uncertain because role level and alternative degree/experience requirements are ambiguous. Its destination was reachable, but that does not resolve fit. Glean was excluded for a six-year minimum; Uber Applications Developer I was excluded by the current role filter. Neither should pad a junior shortlist.

Deterministic review: zero confirmed, three uncertain, two excluded. The model's summary incorrectly claimed all uncertain roles met the experience criteria; Cisco did not receive that classification. Five verified matching employer application links were not obtained. The reader's description_status=complete means visible text was returned, not that every collapsed paragraph on LinkedIn was expanded. Availability may change after this check.
