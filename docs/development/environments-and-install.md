# Environments and installation

English | [中文](environments-and-install.zh.md)

## Sandbox and CI environments

For Host tests, type checking, and builds, keep the Team repository next to `../deepseek-harness`. A new worktree also needs its own gitignored dependencies and build outputs, and resolves Harness from its own parent directory. For a documentation-only change, see [Start and checks](start-and-checks.md#verification-gradient) instead.

Use Node and Corepack that satisfy the certified Harness manifest. From a fresh environment:

1. Clone Harness as the sibling `../deepseek-harness` at the latest certified tag (currently `dsh-v0.2.2-rc.2`). Enable the pnpm shim with `corepack enable pnpm`: Harness build scripts invoke bare `pnpm`. Corepack uses each repository's own `packageManager` pin; the two pins need not match.
2. In Harness, run `corepack pnpm install`, `corepack pnpm build:lib`, and `corepack pnpm build:native-system`. Team runs Vitest directly, so Harness's own test script will not build the native addon for Team. The native build uses `--host-addon-only` and skips unsupported platforms. For browser testing or either preview, also run `corepack pnpm build:web`.
3. In the Team repository, run `corepack pnpm install`. Do not run `npm install`; it can disrupt pnpm's links. For `ERR_PNPM_IGNORED_BUILDS`, review the dependency's build script and record approval or denial in the same dependency change under `allowBuilds` in `pnpm-workspace.yaml`.
4. Still in Team, run `node scripts/link-harness-packages.mjs` and `npm run build`. The links and built package exports are needed by preset resolution from the repository root, not just by TypeScript.
5. Run `node scripts/sync-paths.mjs`. This regenerates TypeScript path facades, including the locale source wildcard. `npm run check:facades` compares without writing; it does not repair drift.
6. To validate the full setup, run `npm run typecheck && npm test`. For an ordinary change, use the narrower checks in [Start and checks](start-and-checks.md#verification-gradient).

In a disposable sandbox, [`sh scripts/hoplite-setup.sh`](../../scripts/hoplite-setup.sh) automates steps 1–5 and builds Web. It force-checks out the certified tag in an existing sibling and may remove build residue; do not run it over a Harness checkout with work you need to keep. [Hoplite settings](../../.hoplite/settings.json) expose step 6 separately as `check`.

| Variable | When to set it |
| --- | --- |
| `DSH_HARNESS_DIR` | To select a different checkout, typically for [isolated certification](../dsh-release-compatibility.md). Leave unset for daily work. |
| `NODE_OPTIONS` | Override the sandbox setup's default `--max-old-space-size=4096` if needed. |
| `CHROME_PATH` | Set for browser runs when Chrome is not at `/usr/bin/google-chrome`. Sandbox setup can provision Playwright Chromium as a fallback. |
| `DEEPSEEK_API_KEY` | Only for live `npm run preview`, not for `preview:ui` or `test:browser`. |

**Diagnose setup failures before changing code.**

- **Wrong Harness checkout:** shared-resolver scripts use `DSH_HARNESS_DIR`, then the `.generated-harness` marker from `sync-paths`, then the default sibling. A missing checkout fails early. When returning from certification, unset the override, clear any marker pointing to the old checkout, then regenerate facades against the daily sibling.
- **Widespread Host/preset failures:** verify the certified tag, fresh Harness `lib/` and native addon where supported, then Team's links and built exports. Errors such as `Agent is not an active Team Member` or `UNLOADING` on an undefined value are clues, not diagnoses.
- **Missing `zod` or inexplicable React types:** check the pnpm install and links, or the [Typert staging step](generated-and-seams.md#generated-files) if the error is in generation. Look for stray ancestor `node_modules/@types` when the compiler sees types absent from the lockfile.

[CI](../../.github/workflows/ci.yml) runs static checks and lint without Harness on pull requests, pushes to `master`, and manual dispatches. The Linux and Windows jobs run on code changes or manual dispatch: they cache the pnpm store and certified Harness build, link and build Team, regenerate facades, typecheck, and run `test:ci`. Linux also checks the package artifact, stripped Desktop boot, and UI parity. CI does not run browser acceptance.

When certification advances, update the CI tag, documentation, peer ranges, and lockfile together; CI installs with `--frozen-lockfile`. If Vitest or `npm run duplication` fails at startup after a lockfile edit, check for the platform entries for `@rolldown/binding-*` or `jscpd-*`, respectively. A successful install alone does not prove those entries survived.

## External installation verification
The published layout is the root bundle:

```sh
dsh plugin --profile web add @contexera/dsh-agent-team
dsh web
```

For local linked development, build first and use a separate profile. Run these commands from the Harness checkout. Use the first command only to create a **new** `web-dev` profile; rerunning it replaces that profile’s dependencies and patches.

```sh
corepack pnpm dsh --profile web-dev --from-default-profile web --dump-default-config
corepack pnpm dsh plugin --profile web-dev add link:/absolute/path/to/dsh-agent-team
corepack pnpm dsh --profile web-dev
```

`cordis.patch.yml` is the bundle patch entry point. It adds Host, Client, and invariant rows to the opt-in profile and mounts the `team-member` and `team-manager` rosters in the isolated `agentPresets` scope. Ordinary shipped/user preset rosters must not be changed.

The plugin manager renders that scope container as a component row and shows it as off; this is expected and needs no action there. The container is a composition carrier rather than a feature plugin, so it has no live entry of its own to match, while the Loader treats a group entry as always enabled. The rows listed inside it are the ones that run, and the web and desktop builds render the same way.

Always verify the built publication layout. A source symlink can bypass profile peer fallback and differ from a real installation; the browser scripts copy built packages for this reason.

### One Host per DSH home

One `$DSH_HOME` must not be shared by two running Host processes. Timers, private subscription checkpoints and the ledger projection all live in that home, so two Hosts over the same home fire duplicate runs and race on sequence numbers. The bundle does not lock the home; this is an operator constraint, so give each simultaneously running profile its own `DSH_HOME`. See [host-authority.md](../architecture/host-authority.md) for the scheduling authority.

### Profiles and release cadence

Stable and development profiles are intentionally separate:

- **Stable (`--profile web`)** uses the npm release, with the lockfile selecting the installed version. After a release, install the published version by exact number — `dsh plugin --profile web add @contexera/dsh-agent-team@X.Y.Z` — because a plain `update` can report "Already up to date" while the lockfile still pins the old resolution. See [`release-runbook.md`](../release-runbook.md) §6.
- **Development (`--profile web-dev`)** uses a local `link:` checkout. Rebuild before restarting: the Host loads `packages/*/lib/`, so restarting without `npm run build` keeps old tools and behavior.

The runtime must match the installation form. Published `dsh` runs the stable profile from built artifacts; checkout `pnpm dsh` runs source through tsx and paths and should only start a linked profile. Mixing them can create two module instances whose scope Symbols differ and can produce `selected preset is not team-enabled`.

Release cadence is batched. Between releases, daily use of a local build is a lightweight acceptance channel; choose the narrowest check for each small change and batch a release after accumulated fixes are stable. The release procedure itself — pre-flight, the check ladder, release material, the tag and publish sequence, and post-publish verification — is [`release-runbook.md`](../release-runbook.md).

Profiles in the same `$DSH_HOME` share `storages/`. If a stable old version reads a ledger written by a newer version, schema validation can fail. The current Host adopts rules version 9 (`AGENT_TEAM_RULES_VERSION` in [`ledger.ts`](../../packages/agent-team/src/ledger.ts)); older builds that do not accept that version refuse a ledger once it adopts it.

Before opening Team on the new build, [back up `agent_team.sqlite`](../release-runbook.md#2-pre-flight) and upgrade every profile that shares it.

The minimum compatible DSH version is `0.2.2-rc.2`. DSH's JSONL Session persistence migrates released historical formats itself (v0/v1/v2 → V3 → V4); old-format Session data needs no manual disposal. Do not add Team ledger or Member Session migration, old-format reads, or silent fallbacks.

### Rewriting and pushing history

Local refs can be the only copy of what `master` does not contain: the `backup-pre-*` branches and the local-only tags that pin abandoned pre-rewrite commits are one such family, and deleting them is irreversible. Pushing them is irreversible in the other direction — this repository is public, and a published commit cannot be withdrawn.

Before rewriting history, give any commits you need to keep a durable local reference, or create a Git bundle if you intend to delete the references. Verify rewritten commits by their contents, not their position in a rebase list.

Before pushing, dry-run the exact refspec and check that it names only the branch or tag you intend to publish. Do not use `git push --all` or `git push --tags` for a release; follow the sequence in the [release runbook](../release-runbook.md).

## Unattended work in a container

Subscriptions and reminders run inside the Host process; no external scheduler is involved. Occurrences and due instants are durable facts, so a stopped container runs nothing and the next boot makes up at most one occurrence per reminder and one run per due subscription, from the persisted due instant rather than a fresh window. [host-authority.md](../architecture/host-authority.md) owns that scheduling authority.

- **Sandbox backend.** Every run is pinned to `workspace-write`, so the Host needs a backend that enforces it: `bwrap`, or Landlock where the kernel enforces it. The `bwrap` verdict is probed once by spawning it from the Host's own `PATH` and cached for the process, so a backend installed after boot needs a restart; without one, no subscription runs.
- **Shell executor.** A mounted executor must answer one shell family's probe (`bash` or `pwsh`), and that answer is cached for the process too. A snapshot recorded under the other family fails rather than running under a shell it was not written for.
- **Credentials.** Every declared reference must be configured in the `$DSH_HOME` credential store. The run environment is built from scratch — managed `DSH_TEAM_*` facts plus the resolved references — so a token exported in a shell profile never reaches a script. A subscription declaring no credential runs anonymously, and a provider that limits per egress IP will count a container's shared address against every client behind it, not just this script.
- **Workspace.** The Project Workspace directory from the Host registry must exist in the container, because the run starts there: a script carrying an absolute path from the previous host fails instead of reading the old tree ([host-authority.md](../architecture/host-authority.md)).
- **Webhook ingress.** The listener binds `127.0.0.1:$DSH_TEAM_WEBHOOK_PORT` behind a tunnel or reverse proxy, and `webhook.publicOrigin` must name that public origin. A moved origin invalidates every address already registered with a provider, so re-arm the subscription and register the new address.

## After a migration

The ledger moves with the Host, so the schedule itself needs no repair; the deployment facts around it do. Verify in this order:

1. **Reminder timing.** Create a `once` reminder two minutes out: its notice must arrive at that instant, and `list` must show the occurrence. This exercises the timer, the wake lane and the ledger without touching any subscription.
2. **Sandbox, executor and content.** Run a trial (`test`) on a paused subscription and read its category: `executor-missing`, `spawn-failed`, `shell-mismatch`, `workspace-missing` and `credentials-missing` each name one prerequisite above. A trial that reaches the script but dies on a path from the previous host is a script fix, not a Host fix.
3. **First real interval.** Resume only after a passing trial, then confirm the first scheduled run in `team_subscription logs`. An `empty` run counts as a pass only when the script exits non-zero on a failed read of its own inputs — otherwise a blind script is indistinguishable from a quiet one. A restored capability without a real run is not a restored subscription.
