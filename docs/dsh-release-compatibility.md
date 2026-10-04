# DSH Release Compatibility Certification

English | [中文](dsh-release-compatibility.zh.md)

This document defines the fixed process for certifying an external `dsh-agent-team` bundle against new DeepSeek Harness (DSH) releases. A DSH version is supported only after installation, composition, and runtime have been proven. A DSH release triggers certification; it does not automatically trigger a Team release.

This is not a Team behavior specification. Team behavior is defined by `packages/` source and tests; the DSH interface is defined by the adjacent Harness checkout's source, tests, and published packages.

## 1. Triggers

Run certification when any of the following occurs:

- DSH publishes a stable or prerelease version.
- Team adds, changes, or removes a dependency on a DSH Host, Remote, Client, slot, preset, Session, Workspace, or Storage capability.
- A user reports installation, startup, or Team-mode failure on a DSH version.

Documentation-only DSH changes that do not alter the certified range do not require certification.

## 2. Version facts and support rules

### 2.1 Team and DSH versions

The Team bundle evolves independently according to Team changes. It does not mechanically follow DSH: existing peers may already cover a candidate; Team fixes may ship without a DSH release; and one DSH release may require several Team fixes or none.

DSH compatibility is expressed by peerDependencies in the root `package.json` and by the certified baseline here, not inferred from the Team bundle version. A compatibility-only range change still requires a new Team bundle because users obtain the new manifest from a published package.

### 2.2 The single version basis

Certify an immutable GitHub release tag, such as `dsh-v0.1.1-rc.2`, together with the same set of npm packages published by that tag. Record the tag, date and release notes, `@deepseek-ai/dsh` version, directly peered DSH packages, and whether installation resolves exactly one DSH dependency set at that version. Never use npm `latest` to identify the newest DSH; prereleases may be on `next`.

### 2.3 npm prerelease ranges

Prerelease ranges are not ordinary continuous intervals. For example, `>=0.1.0-rc.8 <0.2.0` does not match `0.1.1-rc.2`: a comparator containing `0.1.0-rc.8` enables prereleases on that same `0.1.0` baseline only.

Do not infer compatibility from a shared major version or hide unverified versions behind a broad range. Only when a candidate falls outside current peers and certification passes should all `@deepseek-ai/dsh-*` peerDependencies be moved together to the new version line and a new Team bundle be published. The result must resolve without nested old DSH packages.

## 3. Certification process

### 3.1 Discover and assess

1. Run `gh release list --repo deepseek-ai/deepseek-harness` to identify the latest release tag and notes.
2. Compare the previous certified tag's commits and changed files with the candidate.
3. Review the consumed surface first: Host (Agent, preset, Session, Workspace, Storage, Sandbox); Remote (Typert protocol and API remotes); Client (runtime, loader, slots, sidebar, layout, conversation, workspace, locale); and Team preset (tools and permissions).
4. Classify changes as unrelated, regression-required, or possibly incompatible. For suspected incompatibility, identify the upstream public interface and this repository's call site; release notes alone are insufficient.

### 3.2 Isolated certification environment

Use an independent checkout at the candidate tag, not the everyday `../deepseek-harness` checkout:

```text
Daily development
├── deepseek-harness/
└── dsh-agent-team/

Temporary certification
├── deepseek-harness-<tag>/
└── dsh-agent-team-compat-<tag>/
```

Build the certified Harness checkout first so Team TypeScript facades point at its declarations. Do not reuse old `lib/` or `node_modules`; that can conceal declaration or runtime incompatibility.

In that checkout run `pnpm install --frozen-lockfile` and build it: `pnpm run build:lib`, `pnpm run build:native-system` for the native system addon the tests load, and `pnpm run build:web` for the browser lane's `apps/web/dist`.

Mirror the daily repository's `node_modules/@deepseek-ai/*` link farm onto the candidate checkout, and point the bundle self-link at the copy: typecheck resolves through the facades, while the test suite and the browser lane resolve through those links.

Then run in the isolated Team copy:

```sh
node scripts/sync-paths.mjs
npm run generate:typert
npm run typecheck
```

Typert output must be stable. Review generator output and the Remote contract before changing Team source; never hand-edit `packages/agent-team/lib/typert.*`.

### 3.3 Automated verification

Run the narrow tests for the changed surface, then at least:

```sh
npm run build        # the suite's preset rows load each package's lib/, not src/
npm test
npm pack --dry-run
git diff --check
```

The following evidence is required:

| Capability | Required conclusion |
| --- | --- |
| Host recovery | Team ledger, Member creation, suspension, resume, and removal work under JSON and SQLite. |
| Preset isolation | `team-member` mounts; ordinary Sessions receive no Team tools or guidance. |
| Remote | Host face generates and Client mounts the generated Remote. |
| Client slots | Enter, leave, and restoration of the three Team shadows work; `sidebar.workspaces.directoryFlow` is not redeclared. |
| Publication layout | A packed root bundle installs through a real profile without source symlinks. |

### 3.4 Browser composition

Any bundle, Client module, Remote activation, slot, or DSH Client package change requires:

```sh
npm run test:browser
```

Run it against the candidate Harness checkout and verify ordinary DSH → Team mode → ordinary DSH restoration. Cover Remote mounting, Team entry/reload/exit, existing Channel/Thread/Member flows, 390×844 layout, keyboard focus/dialogs, and absence of Team tools, guidance, and UI in ordinary Sessions. Handle browser output as described in `development/generated-and-seams.md`; do not commit routine screenshots or temporary Harness tests.

### 3.5 Dependency graph installation

When the candidate is outside current peers, resolve an installation in an empty directory using the candidate DSH and updated packed Team bundle. Confirm there is no peer conflict, every Team DSH peer is satisfied, no second old DSH set is pulled in, and the real published-layout profile passes browser verification.

### 3.6 Upgrade viability

Sections 3.3–3.5 all build their evidence from **newly created** Sessions, which are written in the candidate's native format and never traverse a released-format migration.

Two failure classes are therefore invisible to them, and both have shipped: a Member preset row whose config no longer matches its plugin schema (runtime-only), and released artifact content that the candidate's migration audit refuses.

Add both checks whenever the candidate changes the Session format, the message-source vocabulary, or any shipped preset row:

- **Existing-history upgrade.** Take a profile that already holds Member Sessions written by the previous certified line — including at least one rolled-over generation — and open them under the candidate. Every one must load; a refusal is a release blocker, not a data problem, because the audit is fail-closed and leaves the source artifact unchanged. Record the artifact count checked and the result per artifact.
- **Published-bundle viability.** Determine whether the **currently published** Team bundle still functions on the candidate DSH, not just the candidate bundle. Install the published version against the candidate in an empty directory, boot it, and exercise Member creation. This decides release urgency: when `latest` has already moved to the candidate, an incompatible published bundle breaks new installs outright, which makes the round release-blocking rather than routine.

A custom Session message source kind is the durable trap behind the first check: `@deepseek-ai/dsh-llm` documents `MessageSourceMap` as merge-extensible, but the released-format migration audit admits a closed, build-static list of source kinds, so a plugin that adds one writes logs that a later format generation refuses wholesale.

The trap has a second half: the audit also pins a `plugin` source's members to `kind`, `plugin`, `form`, `sections`, and `summary`, so re-opening the same payload under the admitted kind still fails on any bespoke envelope field.

Both halves are fail-closed and report different errors, so certification evidence must exercise the sources the package actually produces, not just the kind they declare.

Encode plugin semantics in the admitted shape instead: structured payload as named `{ name, text }` sections under `form: 'snapshot'`, a human-readable one-liner as `summary` under `form: 'notice'`, and any further prose in the model-facing body, which is unconstrained.

A section's `text` is the plugin's own string and is read back verbatim, so encode a list as JSON rather than as a delimiter-joined string: a path or name may itself contain the delimiter, and the split then recovers different values than were written.

There is no general slot for extra members — the upstream `compact` plugin obtained one only by special-casing its plugin id — so a plugin that needs bespoke members must request that upstream.

### 3.7 Competing Team implementations

The Harness ships an experimental Agent Teams feature as its own profile bundles (`@deepseek-ai/dsh-experimental-agent-team-profile`, `@deepseek-ai/dsh-experimental-agent-team-web-profile`).

It is a competing Team implementation, not an extension point this bundle builds on: it registers its own model-facing tool family (`spawn_teammate`, `send_message`, `list_agents`, `wait_agent`, `interrupt_agent`, `team_task_*`), disables the shipped global subagent rows in its profile patch to free those names, and carries its own members, tasks, store, and client panel.

This bundle's tools are `team_view`, `team_inbox`, `team_thread`, `team_message`, and `team_claim`, registered only inside its `team-member` preset.

Certification covers profiles that do not mount the experimental packages, and mounting both at once is **unsupported**: two Team authorities, two tool families, and two UI surfaces would be live with no shared authority or naming rule between them.

Choose one Team profile per profile.

This position is recorded rather than tested — a coexistence run has not been performed, and nothing in this bundle inspects or defers to the experimental implementation.

## 4. Results and release gates

| Result | Action |
| --- | --- |
| Candidate is within current peers and all checks pass | Record the certified baseline and evidence; do not change the manifest or publish Team. |
| Candidate is outside current peers and all checks pass | Atomically update all DSH peers, compatibility docs, and Team version; verify the dependency graph and publish. |
| Any check fails | Do not widen peers or publish; record and handle under section 5. |

A peer expansion requires source assessment, passing Typert generation, typecheck, tests, build, pack checks, real browser composition, a conflict-free dependency graph, consistent compatibility wording in `package.json`, architecture/development docs and README, and no temporary material committed. Never widen a range before verification.

## 5. Failure handling

- **Only npm peer conflict:** do not claim support; revise the peer-range strategy and resolve again.
- **Typecheck or Typert failure:** locate the upstream interface change and Team call site, change Team source/tests, and repeat certification.
- **Browser composition failure:** isolate Client module, Remote, slot, and ordinary DSH restoration boundaries; do not bypass with private shipped UI or compatibility fallbacks.
- **Session or Storage recovery failure:** check for an announced persistence-format change; do not add silent Team ledger compatibility reads or fallback.
- **Insufficient public upstream API:** choose a maintainable bundle-owned design or propose a separate Harness contract change; do not change Harness shipped defaults to accommodate Team.

Record candidate tag, symptom, affected interface, reproduction command, and next step. Do not turn an unverified inference into a compatibility claim.

## 6. Current baseline

The current certified baseline is DSH `0.2.0-rc.2`; the paragraphs below preserve the history that produced the preceding baselines.

The DSH peers state exactly that certified line, `>=0.2.0-rc.2 <0.2.1`, so a line this repository has not verified falls outside the declared range instead of installing under an unverified compatibility claim. The removed `@deepseek-ai/dsh-tool-todo` peer left with the preset row it named when the Team surface dropped the session-local todo tool; the remaining peers keep the one certified range.

The removed `@deepseek-ai/dsh-invariants` peer likewise left with the registry row it named when the invariant companion began validating on its own.

One dependency sits outside the DSH line and therefore outside this certification: `@wowyuarm/dsh-jev` ships with the bundle, because the Team Host mounts it as the long-gap relatedness judge from its own row's key. Its declared peers are Cordis and Schemastery alone, so it contributes no DSH peer declaration to the tree; the endpoint, model and key stay the deployment's to state.

The routed sqlite backend is a vendored fork, not a dependency at all (GitHub issue #28): the upstream package stays a devDependency pinned at the fork source, 0.1.5-rc.2, as the byte-compatibility fixture reference, and every compat round diffs the fork against that version's file before anything else.

The `0.1.5-rc.1` baseline this replaced was certified over Typert generation, full typecheck, 499 tests (1 skipped), build, pack checks, lint, and real browser composition with published-layout installation, Remote mount, Team entry/exit, and ordinary DSH restoration, on peers `>=0.1.5-rc.1 <0.1.6`; `0.1.5-rc.2` was certified on those same peers with no manifest change.

The bundle's dependence on that line is structural rather than incidental. A candidate that changes any of the following is a peer-range change, not a patch:

- The root `main` slot is registered as a keyed entry (key `conversation`, priority `-100`) and rendered through `renderSlot('main', {}, { entryKey: 'conversation' })`.
- Sessions are reached through the handle API (`open(id, 'read')` + `read()` + `close()`, with `stat()` returning header snapshots).
- The member preset's `dsh-persona` row carries its config under `prefix`.
- The `team-member` preset is declared as a `@deepseek-ai/dsh-agent-preset` row beside its `@deepseek-ai/dsh-agent-preset-registry`, inside the Team's own `isolate` group.
- Every durable message source the bundle writes carries its producer's own kind; the retired `{ kind: 'plugin', plugin: … }` wrapper is refused at write time.

Preset composition has no compile-time or unit-test guard: the member specs compose a synthetic preset, so a row whose config no longer matches its plugin schema surfaces only in the real browser journey — every Member fails to activate with `preset "team-member" failed to mount: … $.prefix missing required value` while typecheck, unit tests, and build stay green.

Treat `npm run test:browser` as the certification gate for shipped preset rows.

Section 3.6 closes a blind spot in the checks above: they build their evidence from newly created Sessions, which never traverse a released-format migration.

A migration refusal is fail-closed and leaves the source artifact byte-identical, so the effect is unreadable Sessions rather than damaged data; an incompatible published bundle is equally invisible to installation checks, surfacing only when a Member is created.

Both classes are release-blocking while npm `latest` points at the candidate.

Existing-history upgrade viability was measured, not assumed: the `0.1.5` candidate's closed source-kind audit refused every Member artifact the released line wrote, and the startup repair pass the bundle then carried repaired 44 refused artifacts across this machine's full store, left 6 untouched for structural Session defects, wrote no byte into any pre-existing artifact, and published nothing on a second walk.

### DSH 0.1.7-rc.1

DSH `0.1.7-rc.1` is certified and moves the baseline. Every `@deepseek-ai/dsh-*` peer moved together from `>=0.1.5-rc.1 <0.1.6` to `>=0.1.7-rc.1 <0.1.8`, because a comparator enables prereleases only on its own base tuple and the old range reached no `0.1.6` or `0.1.7` cut. The removed `@deepseek-ai/dsh-agent-presets` peer left with the package it named.

Two upstream contract changes drove the round, and both required source adaptation:

- **The preset system was replaced.** Filesystem preset discovery through `@deepseek-ai/dsh-agent-presets` (`roots`/`trust`) is gone; presets are now rows — a host-level `@deepseek-ai/dsh-agent-preset-registry` plus one `@deepseek-ai/dsh-agent-preset` declaration row per preset (`config: { id, plugins }`).
- **The Team's rows moved with it.** `cordis.patch.yml` now declares the registry (`default: team-member`) and the `team-member` definition row inside one `isolate: { agentPresets: true }` group, with the retired roster's entry list inlined verbatim as `config.plugins` — including both `!!js` platform expressions, because a preset keeps child expressions deferred until their own plugins activate.
- **No Host call site moved.** The `agentPresets` service surface is unchanged; `preset-roster.ts` and the `preset/` directory were deleted rather than rewritten, and the browser-lane overlay carries the same rows.
- **Session format V4 requires producer-owned message sources.** The jsonl write path refuses `{ kind: 'plugin', plugin: … }` with `format v4 message requires a producer-owned source kind`, so the bundle's nine write sites now write their three producer ids as kinds.
- **Released V3 history needs no rewrite on disk.** The read-time conversion renames each wrapper to `plugin:<producer>` and preserves `form`/`sections`/`summary`; the read side recognizes both shapes for all three ids by exact identity, never by a `plugin:` prefix test, because the same log carries third-party rows.

The startup repair pass (`session-remediation.ts`) was removed in the same change, with Human approval: what it published was precisely the wrapper V4 refuses at write time, so keeping it would manufacture unreadable files, and the pre-0.1.5 kinds it targeted are refused by the released v2→v3 chain before the read-time conversion runs. A deterministic `session-refused` activation now reports the same failure on every restart instead of healing it.

One further change stopped at the test fixtures: rc.1 redrew `IconUserOutlineArtwork` onto a half-pixel grid without renaming the symbol or changing its wrapper, so the `settingsAction` icon's `data-content` fingerprint moved `612cfab9` → `68b4b343` and one committed snapshot line was refreshed. No bundle source changed.

### DSH 0.1.7-rc.2

DSH `0.1.7-rc.2` is certified on the same peers with no manifest change. The candidate falls inside `>=0.1.7-rc.1 <0.1.8`, so section 4 records a baseline instead of a peer move, and every version spot keeps naming the range's lower bound. Tag `477b4f42` (2026-09-24) was certified before npm carried it: at certification time `next` still pointed at `0.1.7-rc.1`.

No symbol this bundle imports was removed or renamed. Inside the peered packages the delta is 213 non-documentation files, concentrated in the shipped Client surface the bundle composes into (`ui-primitives` 55, `ui-conversation` 22, `ui-workspace` 15); `session-format-catalog`, `session-persistence`, and the Typert protocol changed only their manifests, so section 3.6 is not re-triggered.

Two upstream changes stopped at the test fixtures, and neither moved bundle source. The shipped layout and sidebar now inject a `shortcuts` service, so the takeover bench provides the empty catalog and no-op registrer both parents require.

The sidebar's own markup also moved: `data-window-drag` on the logo row, and the new-session icon and label rewrapped in a mask/content pair. The container snapshot folds those two details onto one shape, because a committed snapshot must hold on every cut inside the certified range, not on the newest one alone.

Evidence on the certified tree: `npm run typecheck`, `npm test` (741 passed, 1 skipped), `npm run lint`, `npm run build`, `npm pack --dry-run` (251 files), and `npm run test:browser` (4 journeys).

### DSH master 21638c5631 (0.2.0 pre-release sync)

This is a pre-certification, not a baseline. Upstream merged its unreleased plugin-ecosystem line into `master` without a tag: at the frozen commit `21638c5631` (2026-09-27, `Merge PR #5282`, 155 commits after `dsh-v0.1.7-rc.2`) `apps/cli` still declares `0.1.7-rc.2`, and no `dsh-v*` tag exists after rc.2.

Section 2.2's basis is an immutable tag together with the npm packages it published, and this candidate has neither, so nothing moved: the baseline stays `0.1.7-rc.1`, every version spot keeps naming its lower bound, the CI harness tag is unchanged, and the peer move waits for a tagged `0.2.0`.

Certification ran anyway, to learn early whether that line breaks the bundle. It does not: no imported symbol was removed or renamed, and no bundle source changed. The one required change is generated — `node scripts/sync-paths.mjs` against the candidate absorbs 13 new upstream path aliases (507 Harness mappings) — and it stays uncommitted, because the committed facades must keep matching the baseline tag that CI regenerates them from.

Confirmed ignorable:

- `SessionRow.displayTitle` semantics (the bundle renders no session row), and the optional `onCreated` on fork.
- Optional `focusDelayMs` and the new `pointerModality` export in `ui-primitives`; `submit(mode, source?)` in the input contract, which `TeamComposer` does not consume.
- The `productAnalytics` service, left disabled in the web composition.
- The `otel` row in `bundle/base` and the desktop-only telemetry rows in `bundle/web-app` that replace the disabled `time-context`/`schedule`/`ui-schedule` rows; the bundle mounts its own member time context instead.
- `ui-sidebar/SidebarRoot.tsx` is untouched, so the panelList anchor the bundle's pinning test holds on still exists.

Section 3.6 is not re-triggered: `session-persistence` and `session-format-catalog` source is unchanged (only `session-telemetry*` moved), no source-kind or write-path rule changed, and every shipped preset row the bundle mounts has zero source changes.

Evidence on the frozen tree: `npm run typecheck`, `npm test` (778 passed, 1 skipped), `npm run lint`, `npm run build`, `npm pack --dry-run` (260 files), `git diff --check`, and `npm run test:browser` (5 journeys).

At certification time npm `latest` and `next` both pointed at `0.1.7-rc.2`, and `alpha` at `0.1.7-alpha.2`.

### DSH 0.2.0-rc.1

DSH `0.2.0-rc.1` is certified and moves the baseline; it is the tagged release the pre-certification above was waiting for. Tag `4878cdab` (2026-09-28) sits 261 commits after `dsh-v0.1.7-rc.2` and carries `21638c5631` in its history, and the root and `apps/cli` manifests declare `0.2.0-rc.1`.

At certification time npm `next` already pointed at it while `latest` still pointed at `0.1.7-rc.2`, so the round was not release-blocking.

The candidate falls outside `>=0.1.7-rc.1 <0.1.8` — a comparator enables prereleases only on its own base tuple, so that range reaches no `0.2.0` cut — and section 4 therefore requires the atomic move: all 45 DSH peers to `>=0.2.0-rc.1 <0.2.1`, the CI harness tag to `dsh-v0.2.0-rc.1`, the Hoplite tag, and every wording spot that names the range.

The declared range decides whether the bundle mounts at all. `loadProfileDirectory` evaluates each bundle manifest through `evaluatePluginCompatibility`, and a bundle whose peers do not admit the running Host goes into `skippedBundles`.

Nothing is printed: the warning text surfaces only in the plugin manager and through `dsh plugin allow-version`. Under the old range the candidate mounted nothing — all five browser journeys failed on an absent Host service and an absent Client module — which is the range gate, not a source incompatibility.

No imported symbol was removed or renamed, and no bundle source changed. Inside the peered packages the delta is 680 non-documentation files, concentrated in the shipped Client surface this bundle composes into (`ui-chat` 34, `ui-primitives` 22, `ui-settings-account` 20, `ui-workspace` 17).

Section 3.6 is not re-triggered: `session-persistence` and `session-format-catalog` changed only their manifests, the Session-side source changes are `session-telemetry*` and `session-log-deepseek`, and every shipped preset row this bundle mounts has zero source changes.

The five slot seats the Client mounts (`sidebar.workspaces`, `main`, `sidebar.settings`, `sidebar.footer.action`, `settings.section`) appear in no changed line, and `ui-sidebar/SidebarRoot.tsx` is untouched, so the panelList anchor the pinning test holds on still exists.

One peer-move trap sits outside the version gate: `packages/agent-team/tests/shipping.spec.ts` pins the range literal five times and `check:versions` does not read it, so the first `npm test` on the moved tree failed exactly there while every version spot already agreed. A peer move updates that spec in the same commit.

Evidence on the certified tree: `npm run typecheck` (508 Harness mappings), `npm test` (778 passed, 1 skipped), `npm run lint`, `npm run build`, `npm pack --dry-run` (260 files), `git diff --check`, and `npm run test:browser` (5 journeys).

Section 3.5 resolves a single DSH generation: 278 `@deepseek-ai/dsh-*` copies, every one at `0.2.0-rc.1`, with no second set behind anything the bundle loads at runtime.

The trailing declared range is closed: `@wowyuarm/dsh-context-continuity@0.1.6` declares its seven `@deepseek-ai/dsh-*` peers as `>=0.2.0-rc.1 <0.2.1`, and this bundle requires `^0.1.6`, so a tree that resolves this manifest installs one DSH generation.

`0.1.5` still declared `>=0.1.7-rc.1 <0.1.8`, so npm satisfied that unsatisfiable declared peer by nesting `@deepseek-ai/dsh-session-projection@0.1.7-rc.2` (120 KB) under the bundle and printing `ERESOLVE overriding peer dependency`; the install still exited 0.

Nothing loaded that copy: the engine's only reference to the package is a type-only import, this bundle never names it, and the engine is a library rather than a profile bundle, so its peers never reach `evaluatePluginCompatibility`.

The dependency floor moves with the engine so a lockfile still holding `0.1.5` cannot keep the older declaration alive, and the engine's own range now admits the `0.2.0` line, so installing it at the root of a `0.2.0-rc.1` profile no longer meets a range that excludes the host. The engine's move ships in the same window as this line, because an engine naming `0.2.0-rc.1` puts a stray copy of that generation into trees still on `0.1.7-rc.2`.

### DSH 0.2.0-rc.2

DSH `0.2.0-rc.2` is certified on the same peers with no manifest change. The candidate falls inside `>=0.2.0-rc.1 <0.2.1`, so section 4 records a baseline instead of a peer move, and every version spot keeps naming the range's lower bound.

Tag `639ed01` (2026-09-29) sits 187 commits after `dsh-v0.2.0-rc.1`. At certification time npm `next` already pointed at it while `latest` still pointed at `0.1.7-rc.2`, so the round was not release-blocking.

No symbol this bundle imports was removed or renamed. Inside the 45 peered packages 86 files changed, 45 of them `package.json`: nine peers changed real source, and the other 35 changed nothing but their manifest.

Those nine are the shipped Client surface this bundle composes into — `ui-primitives` 9, `ui-conversation` 3, `ui-settings-general` 3, `ui-workspace` 2, `ui-sidebar`, `ui-renderer`, `api-remotes` — plus `tool-bash` and `tool-pwsh`, one file each.

Its two widest Client changes are additive. `ui-primitives` exports `MenuGroup` and `observeStickyMenuGroups` on top of its existing surface, and `api-remotes` adds a `@deepseek-ai/dsh-user-questions/remote` import to its Client entry.

Section 3.6 is not re-triggered: `session-format-catalog`, `session-persistence`, `session-telemetry`, and `agent-preset-registry` changed only their manifests, and `agent-preset`'s only non-manifest change is a shipped skill reference document.

`ui-sidebar/SidebarRoot.tsx` is touched — the non-darwin new-session button loses its `Tooltip` wrapper — but the `panelList` anchor the bundle's pinning test holds on still exists at line 280.

Evidence on the certified tree: `npm run typecheck` (509 Harness mappings), `npm test` (776 passed, 1 skipped), `npm run lint`, `npm run build`, `npm pack --dry-run` (263 files), `check:artifact`, `git diff --check`, and `npm run test:browser` (5 journeys).

Section 3.5 resolves a single DSH generation: 278 `@deepseek-ai/dsh-*` copies, every one at `0.2.0-rc.2`, with no nested copy and no peer-conflict warning.

The published `0.2.0` bundle was installed against the candidate and booted from a real profile: 278 DSH copies all at the candidate, 188 composed rows, no skipped bundle, and its Client module served at 654,554 bytes.

The certified baseline advanced to this candidate on 2026-09-29, after the certification rather than as part of it: the operator moved all 45 DSH peers to `>=0.2.0-rc.2 <0.2.1`, with the CI harness tag and the Hoplite tag to `dsh-v0.2.0-rc.2` and every wording spot that names the range.

The move narrows the declared line to `0.2.0-rc.2` and later. The published `0.2.0` tarball keeps its wider `>=0.2.0-rc.1 <0.2.1` declaration, so only a later release refuses a host still on `0.2.0-rc.1`.
