# Contributing

Use Python 3.11+ in a virtual environment and `python -m pip install -e .`.

Before submitting a change:

1. Update `detailed-context.md` in the same change with what changed, why, impacted files, and verification. Refresh affected architecture/setup/status sections.
2. Add tests for changed runtime behavior; avoid tests that require a running model or external network.
3. Run `python -m unittest discover -s tests -v`.
4. Run `python -m compileall -q src tests examples` and `git diff --check`.
5. Describe observable behavior and any compatibility/trust-boundary changes.

Keep transport, orchestration, and tool validation separate. Use explicit registration, small APIs, and the standard library unless a dependency has a concrete benefit. Do not add generated-code execution or automatic side-effect retries.

Before public release: choose a license, check naming availability, establish a private security-reporting channel, configure repository metadata, and run the CI matrix. Public contributions and package publishing are not configured yet.
