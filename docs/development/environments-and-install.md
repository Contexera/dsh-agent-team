# Environments and installation

English | [中文](environments-and-install.zh.md)

## Sandbox and CI environments
The test and type systems are not self-contained: they resolve 40+ `@deepseek-ai/dsh-*` packages from the adjacent Harness checkout (both `src/` and a built `lib/`). Sandboxed agents and CI runners must reproduce that layout instead of improvising their own.

This applies to any fresh environment: a new clone **or a `git worktree`**. A worktree does not carry the main checkout's gitignored `node_modules/` and `lib/`, so the setup below is required from scratch there too — skipping step 4 (linking and building) surfaces later as mass false preset-resolution failures in host tests, not as a missing-module error at startup.

**Checkout naming is the contract.** Clone the Harness as the sibling `../deepseek-harness` — the default directory name every script falls back to — and check out the latest certified release tag. Sibling checkouts with tag-suffixed names (`../deepseek-harness-<tag>/`) belong to isolated certification environments only (see [dsh-release-compatibility.md](../dsh-release-compatibility.md) §3.2); pointing tooling at one is the root cause of mass false test failures. A checkout with a non-default name must be selected explicitly with `DSH_HARNESS_DIR`.

**Setup, in order:**

1. Enable the corepack shims with `corepack enable pnpm`, then clone `../deepseek-harness`, check out the latest certified release tag (currently `dsh-v0.2.0-rc.2`; advance it per certification), and run `corepack pnpm install` (one workspace-wide install) followed by `corepack pnpm build:lib` and `corepack pnpm build:native-system`. The shim is required because the certified Harness invokes a bare `pnpm` from inside its own scripts (`build:lib`, `build:web`), while `corepack pnpm` resolves only within its own process; without the shim those steps fail as `pnpm: not found`.

   Both repositories pin `pnpm@11.7.0` through `packageManager`, so the shim resolves to that version rather than whatever the environment preinstalled. The native step is a separate build that nothing else performs for us: the host addon is gitignored, the Harness `test` script builds it itself via `build:native-system` before its own Vitest run, and this repository runs Vitest directly against that checkout — so a fresh clone without it fails host Team activation (`Agent is not an active Team Member`) rather than reporting a missing module.

   `--host-addon-only` exits without building off Linux/macOS, so the same step is safe on every platform. Do not reuse stale `lib/` or `node_modules/` from an earlier build — old artifacts can conceal declaration or runtime incompatibility.
2. Build the Harness `apps/web` dist with `corepack pnpm build:web` if the workflow needs `test:browser`; the workspace install already provisioned its dependencies.
3. Inside this repository, install with `corepack pnpm install`. Never run `npm install`: it silently breaks the workspace symlinks into the adjacent checkout's vendor packages, and the failure surfaces later as a misleading `Cannot find module 'zod'`.
4. Link the Harness workspace, its vendor packages, and — when the resolution is the sibling checkout — the context-continuity engine into this repository's `node_modules` with `node scripts/link-harness-packages.mjs`, then build the bundle with `npm run build`.

   The engine comes from wherever `scripts/continuity-dir.mjs` resolves it: a sibling `../dsh-context-continuity` checkout (development against an engine working tree, which must be built there first with `npm run build`) is linked into `node_modules`, while a clean checkout or CI uses the package the root `dependencies` installed from the registry and links nothing; `DSH_CONTEXT_CONTINUITY_DIR` points the resolution at another checkout.

   Host tests resolve preset rows and the bundle's own unpublished rows (for example `@contexera/dsh-agent-team/member-context`) through real `node_modules` lookups from this repository root, exactly as a profile install of the published bundle would.
5. Regenerate the TypeScript path facades against the fresh checkout with `node scripts/sync-paths.mjs`. A fresh clone must not trust the committed facades: no npm script rewrites them, and skipping this step leaves them pointing at the paths baked in at generation time — the read-only `check:facades` gate that `npm test` runs fails on exactly that mismatch. `sync-paths` also emits the `@deepseek-ai/dsh-client-locale/src/*` wildcard the test harness's locale-table import needs.
6. Smoke-check with `npm run typecheck && npm test`. Green means the environment is right; mass false failures (see below) mean it is not — fix the environment before debugging the diff.

**Environment variables:**

| Variable | Required for | Notes |
| --- | --- | --- |
| `CHROME_PATH` | `test:browser` (optional) | Defaults to `/usr/bin/google-chrome`; set only when the sandbox Chrome lives elsewhere |
| `DSH_CONTEXT_CONTINUITY_DIR` | isolated-checkout runs only | Points the engine resolution at another `dsh-context-continuity` checkout; unset for everyday work — the sibling checkout is preferred, then the installed package |
| `DSH_HARNESS_DIR` | certification escapes only | Points at a tag-suffixed sibling checkout; unset for everyday work — the default name is the contract |
| `DEEPSEEK_API_KEY` | `npm run preview` | Real-model preview fails fast without it; test and browser paths never need it |

**Symptoms of a wrong environment, not wrong code:** mass `TypeError ... reading 'UNLOADING'` / `FiberState` undefined failures mean Vitest resolved a stale or missing Harness checkout; `Cannot find module 'zod'` means npm broke the pnpm links — unless it comes from `generate:typert`, which provisions its own link (see Generated files). Fix the environment before debugging the diff.

**No stray `node_modules` above the working tree.** TypeScript `typeRoots` and Node module resolution both walk ancestor directories, so a leftover `node_modules\@types` in a home directory (from an accidental `npm install` run there once) silently injects its types into every compile — observed as React-19-typed errors against a React-18 lockfile on the harness build. If a fresh checkout fails typecheck with type errors the lockfile cannot explain, check each ancestor directory for a stray `node_modules` before debugging the code.

**The checkout pointer is centralized and fails fast. ** `scripts/harness-dir.mjs` is the single source of truth every consumer (Vitest, `sync-paths`, `build-client`, `generate-typert`, the browser/preview runners) resolves through: `DSH_HARNESS_DIR` wins when set, then the `.generated-harness` marker that `sync-paths` writes (so tests follow the same checkout the facades were generated against — a forgotten env var after a cert-run generation cannot split them), then the default sibling name.

A resolved checkout that does not exist aborts immediately with the sibling Harness checkouts that do exist and pointers to the fix, instead of surfacing as the far-away symptoms above.

**The engine pointer resolves a checkout or the installed package. ** `scripts/continuity-dir.mjs` is the single source of truth for `@contexera/dsh-context-continuity`: `DSH_CONTEXT_CONTINUITY_DIR` wins when set, then the sibling `dsh-context-continuity` checkout (development against an engine working tree — `link-harness-packages.mjs` links it into `node_modules` and `generate-typert.mjs` provisions it into its analysis package), then the package the root `dependencies` entry installed under `node_modules/@contexera/dsh-context-continuity` (a clean checkout or CI — nothing to link there).

A resolution with no package layout aborts immediately with the candidates it tried and pointers to the fix.

**The engine's install contract. ** The engine is published as `@contexera/dsh-context-continuity`; the root manifest declares it as a regular dependency — the profile install brings it in alongside the bundle: profiles run pnpm with `autoInstallPeers: false`, so a peer nothing else provides resolves for nobody, and the boot-critical closure gate in `shipping.spec.ts` counts dependencies among the reachable roots. CI therefore needs no engine step: `pnpm install` brings the prebuilt package in, and the link script skips a link that would point the package name at itself.

Advancing the engine means updating that one entry and committing `pnpm-lock.yaml`; a local run that resolves the sibling checkout must have that checkout built (`npm run build` there).

**CI lanes. ** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs typecheck plus the full test suite on clean `ubuntu-latest` and `windows-latest` runners — on pull requests, pushes to `master`, and manual `workflow_dispatch`. Both lanes execute the same six-step environment contract above; the Windows lane runs every step through git bash (`shell: bash`) because the default pwsh breaks backslash line continuations, and links the harness packages through directory junctions so no symlink privilege is needed.

Scope guard: no coverage matrix, no release automation, and no `test:browser` — browser acceptance stays a local step. The Windows lane is the regression fence for filesystem-identifier bugs (issues #7/#8). The only adjustable variable is `DSH_HARNESS_TAG`; when certification advances the tag, update the workflow env, this document, and [`.hoplite/settings.json`](../../.hoplite/settings.json) together — the three stay in sync by hand.

A tag advance that also moves the DSH peers must commit `pnpm-lock.yaml` in the same change: CI installs with `frozen-lockfile`, while a local install rewrites the lockfile in place and hides the mismatch until CI runs. The dev scripts (`build-client`, `run-browser-test`, `run-preview`, `run-ui-preview`) are Windows-hardened and run under git bash there, so local Windows development follows the same environment contract.

## External installation verification
The published layout is the root bundle:

```sh
dsh plugin --profile web add @contexera/dsh-agent-team
dsh web
```

A local directory can be installed with:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-agent-team
dsh web
```

`cordis.patch.yml` is the bundle patch entry point. It adds Host, Client, and invariant rows to the opt-in profile and mounts the `team-member` roster in the isolated `agentPresets` scope. Ordinary shipped/user preset rosters must not be changed.

The plugin manager renders that scope container as a component row and shows it as off; this is expected and needs no action there. The container is a composition carrier rather than a feature plugin, so it has no live entry of its own to match, while the Loader treats a group entry as always enabled. The rows listed inside it are the ones that run, and the web and desktop builds render the same way.

Always verify the built publication layout. A source symlink can bypass profile peer fallback and differ from a real installation; the browser scripts copy built packages for this reason.

### Profiles and release cadence

Stable and development profiles are intentionally separate:

- **Stable (`--profile web`)** uses the npm release (`^0.1.x`), with the lockfile selecting the installed version. After a release, install the published version by exact number — `dsh plugin --profile web add @contexera/dsh-agent-team@X.Y.Z` — because a plain `update` can report "Already up to date" while the lockfile still pins the old resolution. See [`release-runbook.md`](../release-runbook.md) §6.
- **Development (`--profile web-dev`)** uses a local `link:` checkout. Rebuild before restarting: the Host loads `packages/*/lib/`, so restarting without `npm run build` keeps old tools and behavior.

The runtime must match the installation form. Published `dsh` runs the stable profile from built artifacts; checkout `pnpm dsh` runs source through tsx and paths and should only start a linked profile. Mixing them can create two module instances whose scope Symbols differ and can produce `selected preset is not team-enabled`.

Release cadence is batched. Between releases, daily use of a local build is a lightweight acceptance channel; choose the narrowest check for each small change and batch a release after accumulated fixes are stable. The release procedure itself — pre-flight, the check ladder, release material, the tag and publish sequence, and post-publish verification — is [`release-runbook.md`](../release-runbook.md).

Stable and development profiles share `$DSH_HOME/storages/`. If a stable old version reads a ledger written by a newer version, schema validation can fail; update the stable profile after each release.

The minimum compatible DSH version is `0.2.0-rc.2`. DSH's JSONL Session persistence migrates released historical formats itself (v0/v1/v2 → V3 → V4); old-format Session data needs no manual disposal. Do not add Team ledger or Member Session migration, old-format reads, or silent fallbacks.

### Rewriting and pushing history

Local refs can be the only copy of what `master` does not contain: the `backup-pre-*` branches and the local-only tags that pin abandoned pre-rewrite commits are one such family, and deleting them is irreversible. Pushing them is irreversible in the other direction — this repository is public, and a published commit cannot be withdrawn.

Before rewriting history — `reset --hard` over committed work, `rebase`, or an amend that abandons commits with unique content — park the current tip in a `backup-pre-<what>-<YYYYMMDD>` branch, or in a `git bundle` file when the refs themselves are about to be deleted. Without one, `git reflog` is the only anchor for the abandoned commits and `git gc` prunes unreachable objects; the 2026-09-12 rewrite of the 0.1.11 round created no backup ref, so only the reflog held the replaced commits.

Before pushing, dry-run the exact refspec and require the output to name only the refs you intend to publish:

```sh
git push --dry-run origin master    # add the version tag when the push is a release
```

A third ref means a local-only ref would go public — stop and resolve it first. `git push --all` and `git push --tags` bypass this gate and are never the release command. A release push is this same fence with the version tag added; the sequence around it is in [`release-runbook.md`](../release-runbook.md) §5.
