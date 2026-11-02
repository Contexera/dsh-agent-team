# Other Languages and Layouts

The ablation methodology transfers to any codebase; the bundled scripts do not, as-is. They assume TypeScript with `tsc`, a `src/` + `test/` layout, relative imports, and node:test-style summaries. To adapt:

- Swap the import-graph resolver (`scripts/graph.mjs` — relative-import TS) for the ecosystem's dependency source: a bundler graph, `go list`, `python -m modulefinder`, …
- Point `ABLATION_BUILD_CMD` / `ABLATION_TEST_CMD` at the real entrypoints. The scripts only parse node:test summaries; for other frameworks extend the summary regex or rely on the exit code plus the captured output tail (`rawTail` in the JSON).
- Without a static import graph, deletion ablation degenerates to removing the module plus whatever fails to compile — still informative, just noisier.
