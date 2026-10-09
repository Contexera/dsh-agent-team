# Start and checks

English | [中文](start-and-checks.zh.md)

## Scope
This document records maintenance workflows for the repository. Exact command definitions remain authoritative in the root `package.json`, package manifests, and `scripts/`; update configuration first when a command changes, then update this document.

## Start developing
This repository is an independent external DSH bundle. End users install the published package; local development and real Web verification require the adjacent `../deepseek-harness` checkout.

```text
../
├── deepseek-harness/
└── dsh-agent-team/
```

Install dependencies with the command specified by the root README:

```sh
corepack pnpm install
```

`pnpm-workspace.yaml` does not declare `packages/*` as workspace members: the repository publishes one root npm package and its three `packages/*` directories are build targets of that one workspace, not independently installable packages. The file is still load-bearing — it disables automatic peer installation and carries the build-approval and release-age settings this repository relies on — so do not change or remove it because a directory lacks its own manifest. The root `node_modules` and adjacent Harness checkout provide the packages and source mappings needed for local development.

## Verification gradient
Run the smallest sufficient checks for the change:

```sh
npm run generate:typert
npm run typecheck
npm run check:docs
npm run check:core-skills
npm run check:boundaries
npm run check:versions
npm run check:facades
npm test
npm run build
npm run lint
npm run duplication
npm pack --dry-run
npm run check:artifact
npm run check:public-baseline
git diff --check HEAD
```

Their responsibilities are:

- `generate:typert` emits Typert Host/Remote artifacts from the Host face in `packages/agent-team/src/`.
- `typecheck` regenerates Typert and checks Host, tools, and Client sources.
- `check:docs` mechanically enforces the rules in [`AGENTS.md`](../AGENTS.md): bilingual pairing with a working switcher, a shared heading outline per pair (the same headings at the same levels), relative links, `#fragment` heading anchors, the per-file longest-block ceiling recorded in the script, and both indexes naming exactly the documents that exist. It covers the four README pairs as well — the repository root and one per package — plus the root contributing pair, each set with its own switcher wording. Run it on its own for a documentation-only change.
  - `node scripts/check-docs.mjs --budgets` prints the per-file longest-block table instead of deciding.
- `check:core-skills` mechanically enforces the shipped skill contract under `packages/agent-team/core-skills/`: the front matter names the skill after its directory and its description names real triggers, the whole skill stays inside the reviewed budget in `scripts/check-core-skills.mjs`, every relative link stays inside the skill directory (an installer copies that directory alone), and every file under `references/` is linked from `SKILL.md`.
- `check:boundaries` mechanically enforces the package seams described below: no file under `packages/*/src/` may reach another package by a relative specifier that escapes its own package directory. `import type` is exempt because it is erased before runtime, and test files are out of scope because they deliberately wire directories together. Declared subpaths such as `@contexera/dsh-agent-team/remote` are the supported way to cross a seam.
- `check:versions` mechanically enforces the certified-version consistency rule: the CI tag, the setup tag, the development guide, the READMEs, the architecture doc, the compatibility baseline, and the bug-report placeholder must all state the same DSH baseline (in both languages), and that baseline must be the lower bound of every `@deepseek-ai/dsh-*` peer range. It asserts mutual agreement, never a hardcoded version, so it passes unchanged on every release lane. Run it on its own after touching any version string.
- `check:facades` writes nothing: it recomputes the path facades from the adjacent Harness checkout and refuses a committed `tsconfig*.json` or `.generated-harness` marker that differs from the generated output, so a subpath added to `scripts/sync-paths.mjs` cannot land without its regenerated facades. `npm test` runs it, which is why a fresh clone regenerates the facades first (see [`environments-and-install.md`](./environments-and-install.md)).
- `test` regenerates Typert, runs `check:facades`, `check:docs`, `check:core-skills`, `check:boundaries`, and `check:versions`, then runs Vitest. `scripts/isolate-dsh-home.setup.ts` gives each test file an isolated `DSH_HOME`; tests needing a particular home must save and restore it. Startup does not prune ledger-unknown Member directories; explicit Member removal removes that Member's private memory.
- The Client bench (`packages/client-agent-team/tests/harness.tsx`) fails a spec whose rendered shipped slot entry crashed: the shipped error boundary contains the throw and reports it only through `console.error`, so an unguarded run stays green while the surface is gone. That bench also supplies what jsdom lacks (`ResizeObserver`, `document.fonts`) and the whole `conversation` service face — an absent observable member is not a missing method but a `WeakMap.set(undefined)` throw in the renderer's hook cache.
- `build` uses the restricted Node cleaner to clear package `lib/` directories, regenerates Typert, builds all three source trees, and uses Harness `tsdown` for the Client bundle. The published artifact remains one root npm package.
- `lint` runs oxlint.
- `duplication` runs jscpd over `packages` and `scripts` using `.jscpd.json`; treat its output as a place to look, never as a verdict, because it reports moved and restructured code as readily as copied code.
- `pack --dry-run` checks the root bundle's published contents; `prepack` runs the full build first, so it is a release prerequisite rather than an everyday check.
- `check:artifact` reads back what `npm pack` would actually ship and refuses an artifact that would ship broken: stray `.ts`/`.tsx` sources, a missing `cordis.patch.yml`, or a runtime relative import whose target is not inside the tarball. That last one is invisible to every local check, because the working tree has every file. Run it after `build` and before publishing.
- `check:public-baseline` compares the certified DSH baseline declared by the `@deepseek-ai/dsh-*` peers against every public surface that restates it by hand — both READMEs and the pinned compatibility discussion in the Harness repository. A surface it cannot parse is a failure, never a skip, so rewording a README cannot quietly drop it out of coverage. It needs `gh`; `--offline` skips the discussion read and is for local iteration only.

Both gates are publish-time checks rather than everyday ones; [`release-runbook.md`](../release-runbook.md) places them in the order a release runs them.

Changes affecting browser bundles, Client modules, slots, Remote activation, bundle manifests, or visible UI must also run:

```sh
npm run test:browser
```

Visible UI changes touching Team controls or surfaces additionally run the mechanical design-language audit (shipped-reference tripwires included):

```sh
node scripts/audit-ui-parity.mjs
```

The audit compares Team Client CSS/TSX against the design-language contract in `docs/frontend-design/principles-and-language.md`: focus visibility, control rhythm, icon semantics, hardcoded colors, and shipped-reference presence. Run it after any visible-UI change and after every DSH upgrade.

This builds first, copies built packages into a temporary profile, starts the official Harness Web scaffold, and runs the real journey with `/usr/bin/google-chrome` (override with `CHROME_PATH`). The sandbox setup provisions Playwright's own chromium at that path when the base image ships no browser. It cleans the temporary profile and Harness test files afterward.

There are three explicit preview/verification paths:

```sh
npm run preview:ui                         # keyless Team fixture
npm run test:browser                       # repeatable keyless browser acceptance
DEEPSEEK_API_KEY=... npm run preview       # real model interaction
```

`preview` and `preview:ui` use temporary profiles and storage and clean up on `Ctrl+C`. `preview` always uses the real DeepSeek adapter and fails when credentials are missing; it does not silently switch to replay. `preview:ui` uses a keyless route-only adapter whose fixture does not call a model; an accidental model request fails explicitly.

All three lanes stage this bundle and its declared dependency closure into a temporary profile, then name that staged copy as a profile package — the shape `dsh plugin add` leaves behind: a `file:` dependency, a link under the profile's own `node_modules`, and an entry in `dsh.profile.bundles`. The scaffold resolves plugin imports from a computed generation built out of `profile.layers`, so only a staged copy named there contributes the Team rows, and they come from the bundle's own `cordis.patch.yml`.

A command-line overlay is not an equivalent mount. The Host row's Human-profile form is written to the profile document, and the config editor rejects that write while a later layer (a home patch or a command-line overlay) declares the same row — `overridden by a home patch or command-line overlay` — so the form stays unwritable. A staged bundle the scaffold never names resolves neither its own rows nor its dependency closure: every Team row reports `failed to import` with no module-resolution error to read, and the keyless fixture then fails on an `undefined` `ctx.agentTeam`.

`test:browser` does not cover the two preview lanes, so boot them by hand after any change to scaffold composition or profile resolution.

The browser journey uses a deterministic keyless Host/Client driver. It covers Agent Inbox reading/replying, Human Channel and Thread navigation, persistence after reload, and restoration of the ordinary DSH surface after leaving Team mode.
