---
name: codebase-ablation
description: Run ablation experiments on a codebase - delete or stub a module and run the test suite to measure its real load-bearing role, coupling, and blast radius. Use when the user asks which modules are safe to delete or refactor, whether to split packages, about hidden dependencies or module coupling, blast radius, 承重墙, 消融实验, 耦合分析, 拆包风险 - even if they never say "ablation".
---

# Codebase Ablation

Measure what each module actually contributes by removing it and observing what breaks. Ablation is a subtraction epistemology: a component's real role is not what its docs say but what the system loses without it.

Three instruments, each answering a different question:

| Instrument | Question | Cost |
| --- | --- | --- |
| Static coupling map (`scripts/couple-map.mjs`) | Who imports whom; predicted blast radius | seconds, no build |
| Deletion ablation (`scripts/ablate-delete.mjs`) | Which modules are structural load-bearing walls | ~1 suite run per target |
| Stub ablation (`scripts/ablate-stub.mjs`) | Which components are touched at runtime, beyond what imports show | ~1 suite run per target |

Two truths to keep in mind throughout:

- Ablation measures **coupling, not quality**. "Delete it and everything breaks" means load-bearing, not good. The correct structural decision after an ablation study is frequently "don't restructure" — say so when the evidence says so.
- **Negative results are conclusions.** "Zero hidden coupling across 16 deletions" is a headline finding, not a null result. It is exactly what static review alone can never prove.

## Ground rules

1. **Baseline first.** Run the project's full test suite before any intervention and record failures verbatim (name + why). Every later number is reported as "failures beyond baseline". A red baseline test that survives an ablation is not a new finding.
2. **Isolate every run in a fresh git worktree.** The scripts do this automatically — worktrees are created from `HEAD`, so commit the current tree (or re-run the baseline at `HEAD`) before ablating; otherwise the baseline and the ablation silently describe different code. Never run two builds against the same checkout: interleaved `clean → compile → copy-assets` steps can nest asset directories and produce collision failures that look like findings (real case: a nested `core-skills/core-skills/` triggered skill-name-collision diagnostics).
3. **Use the project's own build/test entrypoints** (`npm run build`, `npm test`, overridable via `ABLATION_BUILD_CMD` / `ABLATION_TEST_CMD`). Do not reassemble compiler invocations by hand — hand-built steps drift from the official build and manufacture failures that do not exist (real case: a missing exec-bit `chmod` from `npm run build`'s post-steps failed the CLI test in every ablation run). One asymmetry: ablation legitimately deletes source files, so build *post-steps* may reference artifacts that no longer exist. The deletion script therefore treats a failed build with surviving compiled output as `buildOk: "partial"` and measures anyway, recording the build error; only a missing compiled output is a real build failure. The stub script has no such tolerance — it barely edits the source, so the project's build must pass.
4. **An instrument artifact is not a finding.** For every failure, read the failure details, not just the count, and ask: is this the system's reaction, or my scalpel? Subtract "legitimate casualties" before counting real coupling — e.g. when a repo's CLI entry imports everything, the CLI dies with every module ablation; that is expected, not hidden coupling.
5. **Flakes need reproduction under the true experimental condition.** Parallel runs are fine *across isolated worktrees*. If something fails once under load: rerun solo, rerun under isolated parallel load, several times. One unreproduced event is a watch item, not a bug. Do not fix code based on it.

## Workflow

Requires: a git repo, a test suite that runs to completion unattended (each ablation costs one full suite run — with no runnable suite there is no instrument, so skip this skill), and a known build/test command. The bundled scripts assume TypeScript with `tsc`, `src/` layout, relative imports, and node:test-style summaries — see "Other languages" below for what to swap.

1. **Baseline.** Run the full suite; record total/pass/fail and each failing test's name and reason.
2. **Static map.** `node scripts/couple-map.mjs <repoDir> <out.json>` — per-module and per-file direct fan-in and reverse-dependency closure. Completion check before moving on: the target list covers every top-level module, its meaningful submodules (e.g. `channels/raft`), and at least the top 10 files by `closureSize` and `fanInSrc` — write the list down. Also include conceptually-load-bearing files that lack a module home; they are often the biggest hidden hubs.
3. **Deletion round.** For each target: `node scripts/ablate-delete.mjs <repoDir> <targetRel> <out.json>` where `targetRel` is a directory or file under `src/`. Runs are 2-way parallelizable (worktrees isolate them). The script removes the target plus its reverse-dependency closure in src and test, builds the remainder, and runs surviving tests.
4. **Stub round.** For components whose runtime footprint matters — plugin factories, organ/session entry points, anything invoked through indirection: `node scripts/ablate-stub.mjs <repoDir> <srcFile.ts> <exportedFactoryName> <out.json>`. It replaces the factory body with a `throw`, so everything still compiles and every runtime touchpoint fails loudly. The scripted edit targets exported `function` declarations only; a `class` or `const` entry point needs the same one-line throw inserted by hand. Compare this footprint against static fan-in: divergence is the interesting finding (real case: a "lightweight" compactor with fan-in 2 broke 23 tests across 4 areas because it runs inline on every context assembly).
5. **Re-verify surprises.** Any anomaly: read failure details → rule out instrument artifacts → rerun solo → rerun under isolated parallel load. Only then consider it real.
6. **Record.** Write `results/` (one JSON per target), one short doc per round, and a README with conclusions. When something gets fixed later, append a postscript to the original record — never rewrite history; the record was true at its time.

## Reading results

- **Zero adjusted failures across all deletion targets** means the import graph fully explains test coupling: no shared hidden state, no fixture bridges. Strong architecture evidence; report it as the headline.
- **Stub footprint ≫ static fan-in** means runtime indirection hides coupling. This is where ablation beats static analysis.
- **Closure tiers** (bottom / middle / top of the dependency stack) price refactors: changes at the bottom propagate to ~2/3 of the repo; top-layer modules are nearly free to touch.
- For delete-code / split-package decisions: ablation evidence most often supports *not* acting. Dead weight shows up as a module whose ablation leaves the suite fully green — if that never happens, say "nothing to delete" plainly.

## Other languages and layouts

The methodology transfers; the scripts do not, as-is — see [references/other-languages.md](references/other-languages.md) for what to swap.

## Scripts

- `graph.mjs` — builds the static import graph over `src/` and `test/` (`.ts`/`.tsx`/`.mts`/`.cts`, relative imports, directory indexes), computes reverse closures. Used by `couple-map.mjs` and `ablate-delete.mjs`.
- `couple-map.mjs <repoDir> <out.json>` — static fan-in and closure map for every module and file. No build.
- `ablate-delete.mjs <repoDir> <targetRel> <outJson>` — deletion ablation in a throwaway git worktree created from `HEAD` (under the OS temp dir, path unique per repo and target). Env: `ABLATION_BUILD_CMD`, `ABLATION_TEST_CMD` (defaults `npm run build` / `npm test`). Result JSON carries `buildOk` (`"full"` / `"partial"` / `false` — `false` means the build died with no compiled output and the run failed), parsed node:test counters, failing test names, `failureDetails`, and a `rawTail` for non-node:test frameworks. `targetRel` is a directory or file relative to `src/`; the file form needs its extension (a bare stem is also tried against the TS extensions).
- `ABLATION_TEST_CMD` contract: it must run the suite against the current worktree state **without rebuilding**. On repos whose `npm test` embeds the build (common), the embedded build wipes the ablation-tolerated output and dies on its post-steps; the script detects this and fails with the fix. Set a buildless command, e.g. `ABLATION_TEST_CMD='node --test "dist/test/**/*.test.js"'` for tsc + node:test projects (glob form — the bare directory form is unreliable; matches the `dist/test` layout the scripts assume).
- `ablate-stub.mjs <repoDir> <srcRelFile> <fnName> <outJson>` — stub ablation; same env vars. Verifies the compiled output contains the throw marker before trusting results when the default `dist/src/` layout is present; otherwise records `markerVerified: false` with a warning.
