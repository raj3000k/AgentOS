# Repository instructions

- Every code change must update `detailed-context.md` in the same change: explain what changed, why, and impacted files in the chronological log, and refresh affected architecture/setup/status sections.
- Keep the core small, modular, local-first, and free of runtime dependencies.
- Never evaluate model-generated code or dynamically import tools requested by a model. Only explicitly registered, trusted functions may execute.
- Run `python -m unittest discover -s tests -v` after meaningful changes. Tests must not require Ollama or network access outside loopback.
- Keep custom tool limitations and the trust boundary documented.
- For C++ DSA solutions, use `using namespace std;` and omit comments unless requested.
