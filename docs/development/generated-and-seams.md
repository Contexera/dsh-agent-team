# Generated files, seams, and operations

English | [中文](generated-and-seams.zh.md)

## UI changes and browser evidence
Visible UI, Client bundle, slot, Remote activation, or interaction changes must run `npm run test:browser`. Screenshots go to ignored `artifacts/browser/` and do not overwrite archived evidence. Review at least:

```text
1440×960: hierarchy, empty/loading/error states, density, and ordinary DSH restoration
390×844 : no horizontal overflow, visible key content, modal/menu inside the viewport
Keyboard: visible focus, Tab/Enter/Space/Escape behavior, accessible dialog/menu names
State: failed submits preserve input; durable mutations render Host projections
```

UI presentation preferences — the Team sidebar's Project/Agent row order is the Host row's `sidebarOrder` setting, cached in `dsh.agent-team.sidebar-order` — are not Team facts and never enter the ledger: when their shape changes, verify drag, the Host write, the cached read, and post-refresh reconcile against the review list above.

These screenshots are human review material, not pixel snapshots. Keep only a small set of milestone images under `.scratch/archive/YYYY-MM/<work>/validation/`, with filenames, acceptance points, and rerun commands. Keep debug screenshots, recordings, logs, and complete test-run image sets ignored.

## Generated files
Do not edit these directly:

- `packages/agent-team/lib/typert.host.*`
- `packages/agent-team/lib/typert.remote-client.*`
- `tsconfig.json`
- `tsconfig.types.json`
- `tsconfig.build-deps.json`
- `.generated-harness` (records the checkout used for the path facades)

Remote artifacts come from `scripts/generate-typert.mjs`; TypeScript path facades come from `scripts/sync-paths.mjs`:

```sh
npm run generate:typert
node scripts/sync-paths.mjs
```

The `tsconfig*.json` facades must not gain `include` or `files`; they must continue matching repository files and adjacent Harness source/declarations.

`generate:typert` analyses a copy of the Host face inside the Harness checkout, so it provisions that temp package's external dependencies itself. The script links `zod`, `yaml`, and `@botiverse/oar` from the Team root install — using symlinks on POSIX and directory junctions on Windows.

Keep `zod` a link. A copy puts zod's own declarations inside the analysed package, where the analyzer's reachable-files walk queues a declaration file the program never loaded and dies with a `TypeError` rather than a diagnostic. A link that does not resolve instead surfaces as `TS2307: Cannot find module 'zod'` in every importing file.

## Package seams and module layout
The published artifact is one root npm package, `@contexera/dsh-agent-team`, declared by the root `package.json` and its `exports` map. The three `packages/*` directories have no manifest of their own: they are the build and export seams of that single package, each with its own build target and its own entry in `exports`.

```text
@contexera/dsh-agent-team               root manifest, one published package
├── packages/agent-team         → ./host, ./types, ./typert, ./remote, …
├── packages/tool-agent-team    → ./tools
└── packages/client-agent-team  → . (the plugin entry) and ./client
```

Consumers therefore reach a package through a declared subpath (`@contexera/dsh-agent-team/host`, `/remote`, `/types`, `/tools`, `/client`), never through a relative path into another directory's `lib/`. The generated `tsconfig*.json` facades and the Client bundler both map those subpaths, so a source-level relative import across seams bypasses the contract that keeps generated artifacts swappable. `scripts/harness-dir.mjs` is the single pointer those mappings resolve the adjacent Harness checkout through.

Host source is deliberately flat. `packages/agent-team/src/` separates authority from seams by file, with three structural anchors — `index.ts` is the composition root and Remote adapter, `ledger.ts` is the durable authority, and `spec.ts` plus the `types.ts` barrel own the record schema and the public types. Each additional file is an earned seam; [`architecture/package-ownership.md`](../architecture/package-ownership.md) names them and what each owns.

## Adding a Host operation
A durable Team operation is one vertical slice through the authority layer, not a per-layer task list. Add the type, the record, the commit, the projection, and the read surface in the same change; the ledger rejects a record it cannot replay, so a partial slice fails loudly rather than silently.

```text
types/operations.ts   the operation record type
spec.ts               the record schema for that kind
ledger.ts             commit method + per-kind change scope + validation + projection application
index.ts              the @Remote(...) action that authorizes and dispatches
types/*-requests.ts   the public request and result shapes, one file per Remote surface
```

The six mechanical surfaces that must change together:

1. **Kind and record.** Add the operation kind as a `z.literal` in its record schema in `spec.ts`, and its typed record in `types/operations.ts`.
2. **Public shapes.** Add the request and result types to the `types/*-requests.ts` file of their surface; `types/requests-results.ts` and `types.ts` are barrels that re-export them, so neither needs a per-operation edit.
3. **Commit.** Add the ledger method that builds the record from `operationBase(...)` plus the next sequence, and the change scope it wakes.
4. **Validation and projection.** Extend the ledger's per-kind commit validation and its validation entry point, and add the case that applies the record to a projection. Replay correctness lives here — a projection that is not applied on load diverges from the durable table.
5. **Host and Remote.** Wire the caller through the Host. For a Client action, expose it with `@Remote('<action>')` in `index.ts`. Authorize the actor, dispatch to the ledger, and emit the committed receipt.
6. **Tests and docs.** Cover commit, replay, authorization, and the projection effect; then update the owning maintained document using the [docs routing table](../AGENTS.md#routing).

**The question those six surfaces do not ask: crash reconvergence.** For every in-process effect it drives — a wake, a disposal, an activation, an external file side effect — answer: if the process dies between commit and effect, which durable state re-derives it, and is that re-derivation idempotent? The effect is re-derived *after* replay, never instead of it; the step is a question, not a seventh surface. [`host-authority.md`](../architecture/host-authority.md) names the Host's own re-derivations.

The invariant companion is checked, not extended: `invariant.ts` checks the ledger at mount and coalesces post-commit checks into a replay after the response's I/O turn, so a new operation's durable record is covered automatically once it replays. That coverage stops at the durable table — the in-process effects the question above asks about have no invariant. Extend the invariant only when the new record shape needs a relationship the projection validator does not already assert.

Two boundaries this checklist depends on:

- Operation-kind semantics stay concentrated in `ledger.ts`. Do not split them across new modules to shorten the file, and do not factor the `spec.ts` record schemas into shared helpers — the per-kind shells are deliberate, and a kind's validation is only meaningful beside its projection.
- A new operation is not a new service. It enters through the existing ledger and the existing Remote adapter; it does not add a store, a parallel projection, or a second authority.

Verify with `npm run typecheck`, the narrowest Host test target, and `npm run test:browser` when the operation reaches the Client. `npm run check:boundaries` runs as part of `npm test` and fails if the change reaches another package by a relative path instead of a declared subpath.
