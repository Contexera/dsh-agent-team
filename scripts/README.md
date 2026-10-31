# scripts/

Maintenance scripts for this bundle. Nothing here ships to end users. The root `package.json`
`scripts` entries are the authority for how each job is invoked, and the responsibility narrative
for the gated checks lives in [`../docs/development/start-and-checks.md`](../docs/development/start-and-checks.md).
This page is only the directory map: what each file is, how it is triggered, and what imports it.
It is maintained by hand — update it whenever a script is added, removed, or renamed.

## Documentation and repository gates

Run through `npm run check:*`; several are also part of `npm test` (see `start-and-checks.md`).

| File | Does | Trigger |
| --- | --- | --- |
| `check-docs.mjs` | Maintained-doc gate: bilingual pairs with a working switcher, resolving relative links and `#fragment`s, agreeing indexes, equal heading outlines, and per-file longest-block ceilings. `--budgets` prints the ceiling table instead of deciding. | `npm run check:docs` |
| `check-core-skills.mjs` | Shipped `core-skills` contract: front matter names the directory, description is a real index entry, prompt budget, and every link stays inside the skill directory. `--root <dir>` checks another tree. | `npm run check:core-skills` |
| `check-package-boundaries.mjs` | Refuses a `packages/*/src` file reaching another package by a relative specifier that escapes its own directory. References are read from the TypeScript syntax tree, so an `export … from` re-export and a bare side-effect `import` count while text that merely quotes one does not, and a declaration that binds no value is exempt. `--root <dir>` checks another tree (fixture spec: `packages/agent-team/tests/check-package-boundaries.spec.ts`). | `npm run check:boundaries` |
| `check-version-consistency.mjs` | Every surface that states the certified DSH baseline must agree, and that baseline must be the lower bound of every `@deepseek-ai/dsh-*` peer range. `--root <dir>`. | `npm run check:versions` |
| `check-comments.mjs` | Per-scope comment-line budget and banned unresolvable references, over `packages/*/src` and this directory (`.ts`/`.tsx`/`.mjs` only). | `npm run check:comments` |
| `check-artifact.mjs` | What `npm pack` would actually ship: no stray `.ts`/`.tsx`, mandatory manifests present, every runtime relative import inside the tarball. Run after `build`. | `npm run check:artifact` |
| `check-public-baseline.mjs` | The certified baseline on public surfaces (both READMEs and the pinned `#4303` discussion); an unparseable surface is a failure, never a skip. Needs `gh`; `--offline` skips the discussion for local iteration. | `npm run check:public-baseline` |
| `sync-paths.mjs` | Regenerate the `tsconfig*.json` path facades from the sibling harness checkout; `--check` compares the committed facades and fails without writing. | `npm run check:facades` |
| `check-preview-credentials.mjs` | Refuses `npm run preview` when `DEEPSEEK_API_KEY` is unset, so the live lane never silently falls back to replay. | first step of `npm run preview` |

## Build

| File | Does | Trigger |
| --- | --- | --- |
| `generate-typert.mjs` | Analyze the Host face under `packages/agent-team/src/` and emit the Typert Host/Remote artifacts into `packages/agent-team/lib/`. | `npm run generate:typert` |
| `clean-build-outputs.mjs` | Remove the package `lib/` output directories. | `npm run clean:build-outputs` (first step of `build`) |
| `build-client.mjs` | Build the Client bundle with Harness `tsdown`. | last step of `npm run build` |

## Browser acceptance, previews, and dev tools

| File | Does | Trigger |
| --- | --- | --- |
| `run-browser-test.mjs` | Keyless browser acceptance: clears the run's screenshot directory once, renders `scripts/e2e/*` into a temporary harness, drives the real journey in Chromium, and afterwards refuses a run whose screenshots are missing or unreadable. | `npm run test:browser` |
| `run-preview.mjs` | Live-model preview lane: renders `team-ui.preview.ts` into the harness. | `npm run preview` |
| `run-ui-preview.mjs` | Keyless UI preview lane: renders `team-ui.ui-preview.ts` into the harness. | `npm run preview:ui` |
| `audit-ui-parity.mjs` | Static design-language audit of the Team Client CSS/TSX against `docs/frontend-design/principles-and-language.md`; run after visible-UI changes and DSH upgrades. | `node scripts/audit-ui-parity.mjs` |
| `verify-desktop-strip-boot.mjs` | Desktop-strip boot verification: simulates a stripped installer, then round-trips a record through the `agent_team` sqlite route. | `node scripts/verify-desktop-strip-boot.mjs` |
| `session-trace.ts` | Offline, read-only Session trace context provider for evaluation evidence (CLI: `list`, `timeline`, `read`, `event`). | `node --import tsx scripts/session-trace.ts …` |
| `team-trial-metrics.ts` | Aggregate trial metrics from an explicit SQLite **copy** of the ledger (CLI); it refuses the live ledger. | `node --import tsx scripts/team-trial-metrics.ts <ledger-copy.sqlite> [--json]` |
| `check-team-trial-metrics.ts` | Asserts the `calculateTrialMetrics` behaviour exported by `team-trial-metrics.ts`. | `node --import tsx scripts/check-team-trial-metrics.ts` |
| `team-performance/` | Team performance evaluation suite: bundle/Host/member-activation/member-activation-batch/member-resume/tool/read-reply/notification-retry/collaboration/session-fold/session-replay-jsonl/ledger baselines, real-profile usage summary, scale matrix, result comparison, Chromium loading, and ordered post-commit notification queue semantic probes. It writes manifests, JSONL samples, summaries, and semantic reports under `artifacts/team-perf/`; usage summary reads an explicit SQLite copy and prints counts only. | `DSH_BENCH_TEAM=1 npm run bench:team` / `npm run bench:team:matrix` / `npm run bench:team:compare -- <before> <after>` / `npm run bench:team:usage -- <ledger-copy.sqlite>` / `npm run bench:team:browser` / `DSH_BENCH_TEAM=1 npm run bench:team:semantics` |
| `hoplite-setup.sh` | Hoplite sandbox setup: steps 1–5 of `docs/development/environments-and-install.md` § sandbox; step 6 is the Hoplite `check` script. | run in the sandbox/CI environment |

## Browser journey templates (rendered into the harness by their runner)

| File | Does | Consumer |
| --- | --- | --- |
| `e2e/` (support.ts + 10 `*.e2e.ts`) | The keyless journey scenarios — `team-journey`, `team-main-stream`, `team-multi-page`, `team-page-identity`, `team-project-owners`, `team-thread-ref-chip`, `team-bundle-toggle`, `team-environment-check`, `team-board-task-focus`, `team-settings-nav-icon`; `support.ts` carries the shared staging/boot plumbing and never touches the run's screenshots. | read and rendered by `run-browser-test.mjs` |
| `team-ui.preview.ts` | Template for the live-preview lane. | read/rendered by `run-preview.mjs` |
| `team-ui.ui-preview.ts` | Template for the keyless UI-preview lane. | read/rendered by `run-ui-preview.mjs` |

## Internal helper modules (no npm entry; imported)

| File | Does | Imported by |
| --- | --- | --- |
| `harness-dir.mjs` (+ `.d.mts`) | Single source of truth for which sibling harness checkout scripts, tests, and facades resolve against (`DSH_HARNESS_DIR` → `.generated-harness` marker → default `deepseek-harness`). | build-client, generate-typert, sync-paths, run-browser-test, run-preview, run-ui-preview, audit-ui-parity, link-harness-packages, session-trace, `vitest.config.ts`, client `tsdown.config.ts`, and the specs `harness-dir.spec.ts` / `sidebar-panel-list.spec.ts` |
| `dsh-peers.mjs` (+ `.d.mts`) | The `@deepseek-ai/dsh-*` peer-range predicate: those ranges must reduce to exactly one DSH generation. | `check-public-baseline.mjs`, `packages/agent-team/tests/shipping.spec.ts` |
| `public-baseline-statement.mjs` (+ `.d.mts`) | Parses the certified-baseline token from one public surface. | `check-public-baseline.mjs` (+ `public-baseline-statement.spec.ts`) |
| `browser-evidence.mjs` (+ `.d.mts`) | Reads a finished browser run's screenshots and refuses missing, truncated, or empty-directory evidence, including a promised desktop or 390×844 viewport width with no screenshot. | `run-browser-test.mjs` (+ `browser-evidence.spec.ts`) |
| `standard-decorators.ts` | Vite pre-transform plugin for standard (TC39) decorators before esbuild sees them. | `vitest.config.ts` |
| `link-harness-packages.mjs` | Symlinks every sibling harness workspace package into `node_modules` so host tests resolve the on-disk layout a real profile install produces. | run manually for local host-test setup |
| `isolate-dsh-home.setup.ts` | Vitest setup that gives each test file its own throwaway `DSH_HOME`. | `vitest.config.ts` setup files |
