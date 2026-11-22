# Start and checks

English | [中文](start-and-checks.zh.md)

## Scope
This document records maintenance workflows for the repository. Exact command definitions remain authoritative in the root `package.json`, package manifests, and `scripts/`; update configuration first when a command changes, then update this document.

## Start developing

For a fresh clone or worktree, follow the [environment setup](environments-and-install.md#sandbox-and-ci-environments). Installing dependencies alone does not link the certified Harness or build the files the Host tests load. The documentation gates do not require a Harness checkout.

Install dependencies with `corepack pnpm install`, not `npm install`. The root publishes one npm bundle. The `packages/*` glob in `pnpm-workspace.yaml` does not make the three source directories independently installable: none has its own manifest. The workspace file still controls peer resolution, dependency build approval, and release-age exceptions.

## Verification gradient

Start with the closest check, then run the delivery checks for the affected surface:

| Change | Start here | Before delivery |
| --- | --- | --- |
| Maintained docs only | `npm run check:docs` | Also run `npm run check:e2e-docs` for the lane catalog or `npm run check:versions` for DSH baseline text. |
| Host, Ledger, permissions, persistence, or Worker | `npm run test:unit` or `npx vitest run <spec-path>` | `npm test` and `npm run typecheck`. |
| Client state, DOM interaction, or error copy | Run the matching `*.client.spec.tsx` under `packages/client-agent-team/tests/`. | Use the browser gate below if the change affects visible UI or assembly. |
| Bundle, presets, slots, Remote activation, or assembled Web | `npm run test:browser -- <lane>` | Unfiltered `npm run test:browser`; add `--deep` for a broad Team journey or release. |
| Published package | `npm run build` | Follow the [release runbook](../release-runbook.md). |

Run `git diff --check HEAD` before committing. Report the checks you actually ran and why any applicable check could not run.

### Command reference

- `generate:typert` emits Typert Host/Remote artifacts from the Host face in `packages/agent-team/src/`.
- `typecheck` regenerates Typert and checks Host, tools, Client, and the Node scripts listed in `tsconfig.scripts.json`, including Session trace and Team performance entry points.
- `check:docs` mechanically enforces the rules in [`AGENTS.md`](../AGENTS.md): bilingual pairing with a working switcher, a shared heading outline per pair (the same headings at the same levels), relative links, `#fragment` heading anchors, the per-file longest-block ceiling recorded in the script, and that the indexes cover the maintained docs. It covers the four README pairs as well — the repository root and one per package — plus the root contributing pair, each set with its own switcher wording.
  - `node scripts/check-docs.mjs --budgets` prints the per-file longest-block table instead of deciding.
- `check:e2e-docs` compares the lane catalog with the browser runner and scenario files.
- `check:core-skills` mechanically enforces the shipped skill contract: the front matter names the skill after its directory and its description names real triggers, the text a skill puts in front of a model stays inside the reviewed budget in `scripts/check-core-skills.mjs`, every relative link stays inside the skill directory (an installer copies that directory alone), and every file under `references/` is linked from `SKILL.md`.
  - It covers both shipped roots: `packages/agent-team/core-skills/` for Members and `packages/agent-team/manager-skills/` for the Team manager. The Member root must contain at least one skill; the manager root ships `team-management-guide`, `team-operations`, `team-event-loops`, `manager-domain-model`, `manager-memory` and `manager-session-evidence`, and the gate tolerates an empty one because content is not a build dependency.
- `check:boundaries` mechanically enforces the package seams in [Package seams](generated-and-seams.md#package-seams-and-module-layout): no file under `packages/*/src/` may reach another package by a relative specifier that escapes its own package directory. `import type` is exempt because it is erased before runtime, and test files are out of scope because they deliberately wire directories together. Declared subpaths such as `@contexera/dsh-agent-team/remote` are the supported way to cross a seam.
- `check:versions` mechanically enforces the certified-version consistency rule: the CI tag, the setup tag, the development guide, the READMEs, the architecture doc, the compatibility baseline, and the bug-report placeholder must all state the same DSH baseline (in both languages). That baseline must also be the lower bound of every `@deepseek-ai/dsh-*` peer range. It asserts mutual agreement, never a hardcoded version, so it passes unchanged on every release lane. Run it on its own after touching any version string.
- `check:comments` checks `packages/*/src` and `scripts/`, excluding `vendor/`: comments must not cite `.scratch/`, work-item numbers, or acceptance criteria, which cannot resolve for published-package readers. Bare `issue #<n>` and documented Team entities such as `Task #<n>` are fine.
  - Source and `packages/*/tests` comments reject uppercase work markers and commented-out statements. Lint suppressions require ` -- <reason>`; `@ts-ignore` and `@ts-nocheck` are banned, while `@ts-expect-error` needs an explanation.
  - Source-only standalone one-line comments with one to five non-stopwords must not merely repeat the next line's words, including camelCase identifiers and plurals.
  - `node scripts/check-comments.mjs --budgets` prints the per-scope comment water line instead of deciding.
  - There is deliberately no line budget: whether a comment earns its place is a judgement a count cannot make, so comment quality is reviewed periodically by reading the comments.
- `check:scratch` mechanically enforces the archived work area's rules: the index and work-item directories agree, every work item has an entry README, links written in archived READMEs resolve, a sealed ticket keeps an active status only behind a `> 已归档` note, and a month overview covers every work item of its month. Historical code citations in archived specs and materials are out of scope, and the check needs no Harness checkout. The CI `checks` job runs it on every PR and push; the Harness-backed lanes still skip work history.
- `check:facades` writes nothing: it recomputes the path facades from the adjacent Harness checkout and refuses a committed `tsconfig*.json` or `.generated-harness` marker that differs from the generated output, so a subpath added to `scripts/sync-paths.mjs` cannot land without its regenerated facades. `npm test` runs it, which is why a fresh clone regenerates the facades first (see [`environments-and-install.md`](./environments-and-install.md)).
- `test` regenerates Typert, runs `check:facades`, `check:docs`, `check:e2e-docs`, `check:core-skills`, `check:boundaries`, `check:versions`, `check:comments`, and `check:scratch`, then runs all Vitest projects. `scripts/isolate-dsh-home.setup.ts` gives each test file an isolated `DSH_HOME`; tests needing a particular home must save and restore it.
- `test:ci` checks Harness-dependent facades and runs all Vitest projects after the CI build and typecheck steps have generated Typert. The CI `checks` job runs the repository-wide static and hygiene checks once before the Linux and Windows lanes, so those lanes use this focused command without weakening the local `npm test` contract.
- `test:unit` (or `npx vitest run --project unit`) runs fast unit tests under a 5s budget. `vitest.config.ts` centralizes all timeout budgets across six mutually exclusive projects (`unit` 5s, `integration` 60s, `worker-composition` 60s test / 30s hook, `worker-long` 120s test / 30s hook, `benchmark` 900s gated by `DSH_BENCH_STORAGE=1`, and `shared-host` 30s test/hook); individual test files must not use `vi.setConfig` or inline timeout arguments.
- The Worker composition lane's wider hook budget lets a stuck native cleanup finish without hiding the test's own failure behind a 10-second fixture-hook timeout.
- The suite pins one time zone (`Asia/Shanghai`, in `vitest.config.ts`), because time rendering is zone-dependent by contract: a seat states the reader's own clock, so the same expectation otherwise reads as a different hour on every runner — UTC in CI, UTC+8 where this is maintained. The pinned zone is deliberately not UTC, which keeps the assertion sharp: a formatter that reaches for `getUTCHours` renders an hour that is not the reader's and fails here. A date-sensitive test may therefore assert a literal clock time rather than read the runner's zone for its expectation.
- The Client bench (`packages/client-agent-team/tests/harness.tsx`) fails a spec whose rendered shipped slot entry crashed: the shipped error boundary contains the throw and reports it only through `console.error`, so an unguarded run stays green while the surface is gone. That bench also supplies what jsdom lacks (`ResizeObserver`, `document.fonts`) and the whole `conversation` service face — an absent observable member is not a missing method but a `WeakMap.set(undefined)` throw in the renderer's hook cache.
- `build` uses the restricted Node cleaner to clear package `lib/` directories, regenerates Typert, builds all three source trees, and uses Harness `tsdown` for the Client bundle. `clean:build-outputs` runs that same cleaner alone, for a tree whose `lib/` is stale or half-built. The published artifact remains one root npm package.
- `lint` runs oxlint.
- `duplication` runs jscpd over `packages` and `scripts` using `.jscpd.json`; treat its output as a place to look, never as a verdict, because it reports moved and restructured code as readily as copied code.
- `pack --dry-run` checks the root bundle's published contents; `prepack` runs the full build first, so it is a release prerequisite rather than an everyday check.
- `check:artifact` reads back what `npm pack` would actually ship and refuses an artifact that would ship broken: stray `.ts`/`.tsx` sources, a missing `cordis.patch.yml`, or a runtime relative import whose target is not inside the tarball. That last one is invisible to every local check, because the working tree has every file. Run it after `build` and before publishing.
- `check:public-baseline` compares the certified DSH baseline declared by the `@deepseek-ai/dsh-*` peers against every public surface that restates it by hand — both READMEs and the pinned compatibility discussion in the Harness repository. A surface it cannot parse is a failure, never a skip, so rewording a README cannot quietly drop it out of coverage. It needs `gh`; `--offline` skips the discussion read and is for local iteration only.

Both gates are publish-time checks rather than everyday ones; [`release-runbook.md`](../release-runbook.md) places them in the order a release runs them.

### Browser gate and preview modes

Choose a [browser lane](e2e-lanes.md) for iteration. For example:

```sh
npm run test:browser -- team-manager team-inbox-and-recovery
```

A filtered run still builds and stages the bundle, but does not enforce the complete suite's screenshot evidence. Before delivery, run the full gate for changes affecting the assembled bundle, Client loading, slots, Remote activation, manifests, or visible UI. The default full run uses the short Team smoke; `npm run test:browser -- --deep` substitutes the full journey for that smoke.

For visible Team UI changes and every DSH upgrade, also run `node scripts/audit-ui-parity.mjs`. It checks shipped references and design-language rules such as focus visibility and control sizing. It does not replace [reviewing real-browser evidence](generated-and-seams.md#ui-changes-and-browser-evidence).

| Mode | Command | Use when |
| --- | --- | --- |
| UI fixture | `npm run preview:ui` | Exploring Team UI without credentials; an accidental model request fails. |
| Browser acceptance | `npm run test:browser` | Reproducing keyless checks on assembled Web in Chrome. |
| Live preview | `npm run preview` | Interacting with a real model. Export `DEEPSEEK_API_KEY` through your normal credential setup first; no replay fallback. |

All three commands build the bundle, stage it with its dependencies as a profile package, and launch the official Harness Web scaffold. A command-line overlay is not equivalent: it can shadow a profile row and make its Human settings form read-only. If the Team rows fail to import, check whether the staged package is actually registered in the profile and includes its dependencies.

The runners use temporary profiles and remove them on normal exit; the browser runner also removes the temporary Harness test files. Set `CHROME_PATH` if the browser executable is not at `/usr/bin/google-chrome`. The acceptance gate does not run either preview command: after editing shared scaffold or profile resolution, verify each affected preview mode separately.
