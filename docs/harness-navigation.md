# dsh-agent-team / deepseek-harness Navigation

English | [中文](harness-navigation.zh.md)

Date: 2026-09-18

This maintained engineering navigation records cross-repository routes verified against current source, tests, or Harness docs. Update it when packages, scripts, slots, or installation change. It is not a replacement for Harness documentation and does not change product decisions; source and tests define current behavior.

## 1. Responsibility boundary

| Question | Inspect this repository first | Then inspect `../deepseek-harness` | Authority |
| --- | --- | --- | --- |
| Team domain objects, permissions, ledger, Task/Claim/Attention/Inbox | `docs/domain-model.md`, `docs/team-collaboration/`, `packages/agent-team/src/`, tests | Only the consumed DSH service contract | This repository implementation |
| Host behavior | `packages/agent-team/src/{index,ledger,spec,types}.ts`, tests | Architecture and relevant subsystem docs for Agent/Session/Workspace/Storage/Typert | This repository behavior; Harness owns underlying capabilities |
| Model-facing tools and preset | `docs/team-collaboration/`, tool source, `team-member` preset | `docs/cookbook/adding-a-tool.md`, tools, permission-preset docs | Team tool semantics; Harness extension interface |
| Client plugin, Team mode, UI | `docs/architecture/README.md`, `docs/development/README.md`, Client source | Client modules, client loading notes, `packages/client/AGENTS.md`, shipped UI source | This repository UI rules; Harness loading/slot/React boundaries |
| Typed Remote | architecture, `@Remote` declarations, `scripts/generate-typert.mjs` | Typert docs/source and API remotes | Harness generation/assembly; Team methods |
| Publishing and bundle install | root READMEs, `cordis.patch.yml`, root manifest | Harness README, package cookbook, profile/bundle docs | Harness installer; this repository bundle layout |
| Real Web acceptance | development docs, browser scripts, ignored artifacts | Harness Web scaffold, testing docs, Client tests | The run's script output; archive only milestone evidence |

When Harness behavior is uncertain, read upstream docs, then implementation and tests. Do not treat `.scratch/` exploration as an API contract or rewrite Team semantics to match a guess. If public APIs cannot express an interaction, record the limitation and choose a bundle-owned plugin/design.

## 2. Routes by change type

### Host, ledger, or lifecycle

Read Team source/tests and `docs/domain-model.md`/`docs/team-collaboration/`; inspect `index.ts`, `ledger.ts`, `spec.ts`, and `types.ts` to ensure one authority and durable commit path. Then consult Harness architecture, storage, workspace, Typert, and defensive-pattern docs and the corresponding source packages. New model-visible inputs need session-log evidence; package tests and real composition should cover lifecycle.

### Model-facing tool or preset

Read the Team collaboration docs, tool source, and isolated preset. Consult Harness tool, permission-preset, and system-prompt docs and source. Schema, canonical output, execute, and presentation are separate layers; do not turn Host into a global tool. Ordinary Sessions must not receive Team tools or guidance.

### Client, browser bundle, or loading graph

Read architecture Client sections, development UI acceptance, and target components; use Harness client-module docs, client loading notes, `packages/client/AGENTS.md`, web styling, Cordis lifecycle tutorials, and the relevant slot/runtime/sidebar/conversation/workspace/theme/module sources. Mount the generated Remote before injecting dependent UI, and use `ctx.slots.inject()` when declarations can arrive later.

A slot parent's `children` declaration is render authority. Team's `sidebar.workspaces` shadow must not copy shipped `sidebar.workspaces.directoryFlow`; SlotCore rejects duplicate live child declarations. Reuse public exports and theme tokens, not private shipped components or CSS; components receive data through slot contracts rather than `ctx`.

### Typed Remote, RPC, or generated artifacts

Read the Team service declaration, types, and generator script; read Harness Typert generator/loader/protocol/registry and API-remote sources. `InvocationDescriptor` is reflection metadata, not wire data. Run `npm run generate:typert`, typecheck, build, and ensure output is stable. Never hand-edit `lib/typert.*`.

### Workspace, Session, or directory selection

Team reads `ctx.workspaces.list` and does not duplicate Workspace creation/browser state. Read Harness workspace, session, and storage docs/source, and preserve branded Workspace IDs and Host-owned cwd semantics. The current UI does not call `pickDirectory()` or `create()`; users use ordinary Session UI when creating a Workspace.

### Storage, persistence, replay, or Thread Inbox

Read Team ledger/projection/lifecycle source and JSON/SQLite tests, then Harness storage, persistence, session-persistence, and defensive-pattern docs/source. The ledger is the only durable authority; add failure-injection/recovery evidence instead of silent fallbacks.

### CSS, primitives, or responsive layout

Read the target component and CSS Module, then architecture/development and UI history only for context. Consult Harness web styling, primitives/theme source, and Client rules. Resolve layout and public primitive reuse before styling; preserve CSS Modules, `--dsw-*` tokens, focus, dialog/menu names, and 390×844 reflow.

## 3. External bundle installation and verification

Verified installation:

```sh
dsh plugin --profile team-demo add @contexera/dsh-agent-team
dsh --profile team-demo
```

Local development installation:

```sh
dsh plugin --profile team-demo add /absolute/path/to/dsh-agent-team
dsh --profile team-demo
```

`cordis.patch.yml` exposes `dsh.bundle.patch`, mounting Host, Client, and invariant rows in `wowyuarm-agent-team-scope` and declaring the Team preset registry and the `team-member` definition row inside `isolate.agentPresets`. Ordinary DSH rosters are unchanged.

Verification order is `npm run typecheck`, `npm test`, `npm run build`, `npm pack --dry-run`, and browser tests for browser/bundle changes. Manual preview uses `npm run preview`; check ordinary Sessions for absence of Team tools, guidance, and UI. Do not commit temporary overlays, browser tests, or generated files to Harness.

## 4. Development checkout dependencies

`npm run generate:typert` uses the adjacent checkout's `WorkspaceAnalyzer` and `FaceModelEmitter`. `scripts/sync-paths.mjs` generates root `tsconfig*.json` facades so tests use Harness source, typecheck uses declarations, and build uses built declarations. Do not edit these facades or add `include`/`files`.

Published bundle installation does not need a sibling checkout; only local Typert generation, typecheck, build, and real browser verification do.

## 5. Maintenance boundary

Harness paths and rules quoted here must be rechecked when Harness changes. Historical sessions and `.scratch/` remain context only. This document is a lookup route, not a duplicate manifest, command list, or domain specification; those facts belong in their authoritative files and `development/README.md`/`architecture/README.md`. When linking archive material, label it as design or history.
