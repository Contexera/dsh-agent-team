# Repository Guidelines

## Scope and authority

`dsh-agent-team` is an opt-in, externally installable Cordis bundle for DeepSeek Harness. It adds a single-host Agent Team without modifying the Harness repository, the agent loop, or shipped defaults.

Read [`docs/README.md`](docs/README.md) first — it is the maintained documentation index.

Use this authority order:

1. **Current behavior:** source and tests under `packages/`. When prose disagrees with code, code wins.
2. **Maintained engineering guidance:** `docs/`. Update it when a code or workflow change invalidates it; it must not define behavior that the code does not implement.
3. **Harness contract:** `../deepseek-harness/docs/`, its applicable `AGENTS.md`, and the corresponding Harness source/tests.
4. **Work history:** `.scratch/` — active work items and archived design, research, tickets, prototypes, and validation evidence. It is not an implementation or API authority; its own [`AGENTS.md`](.scratch/AGENTS.md) governs how to work there, and the [`README.md`](.scratch/README.md) indexes it. Verify relevant history against code, tests, and the Harness contract.

Keep production code self-explanatory through clear names, types, and structure. Comments explain only non-obvious constraints, ownership, or reasons; they are not the sole definition of current behavior. The `check:comments` row in [`docs/development/start-and-checks.md`](docs/development/start-and-checks.md) holds the per-scope budget and the rules a comment's references must satisfy.

When deleting comments in bulk, a green test suite proves nothing about the change. Tests assert behavior; comments are text. Measure the edit itself instead: audit the diff so every removed line is a comment or a blank line, and treat any removed code line as a failure. Delete whole comment blocks rather than merged line ranges — a merged range swallows the code between two comments — and never normalize whitespace outside the lines you removed. This applies to any sweep over comments, including one driven by a subagent report: reports carry line numbers that drift, so verify each cited range against the current file before acting on it.

## Reading guidance

- Use the `docs/architecture/` pages for package ownership, Host authority, Remote, preset, and Client boundaries — not before every edit, only when a change crosses those boundaries: [`package-ownership.md`](docs/architecture/package-ownership.md), [`host-authority.md`](docs/architecture/host-authority.md), [`tools-and-preset.md`](docs/architecture/tools-and-preset.md), [`client-and-remote.md`](docs/architecture/client-and-remote.md), [`workspace-session-storage.md`](docs/architecture/workspace-session-storage.md).
- Use [`docs/harness-navigation.md`](docs/harness-navigation.md) for cross-repository routes when a change consumes a Harness capability.
- Treat `.scratch/` as background context, not as a specification to implement blindly. New cross-session work belongs in one `.scratch/active/<work>/` directory; close it into the archive only after durable conclusions have moved to maintained documents.

## Architecture guardrails

- `packages/agent-team` is the only Team authority. Its append-only operation ledger is the durable source of Team facts; projections, tools, commands, Remote, and UI do not maintain parallel authority.
- `packages/tool-agent-team` provides the seven model-facing Team tools only through the explicit `team-member` preset. The Web Client is the only Human Team control surface; do not restore a slash-command adapter.
- Team is an external plugin. Do not modify `../deepseek-harness`, its agent loop, or shipped defaults for ordinary Team work. If a public Harness extension point is insufficient, record the limitation and decide whether to implement a Team-owned plugin or change the design.
- Typed Remote declarations are the input; Typert artifacts are generated. Never hand-edit `packages/agent-team/lib/typert.*`.
- The Client uses public Harness plugin and slot APIs. Mount the generated Remote, wait for `remote.agentTeam`, and use `ctx.slots.inject()` when a declaration may not exist yet; `dsh.client.inject` is not an activation-order guarantee.
- A slot parent’s `children` declaration is its render authority. Do not copy private shipped UI or redeclare `sidebar.workspaces.directoryFlow` from the Team workspace shadow; live duplicate child declarations are rejected by Harness SlotCore, regardless of priority.
- Keep durable UI mutations non-optimistic. Authorization, membership, revisions, idempotency, and stable branded refs are enforced by the Host.
- Keep Team tools/guidance inside the isolated Team preset. Ordinary Sessions must not acquire Team behavior accidentally.

## Code and documentation conventions

- Use ESM, strict TypeScript, `.ts`/`.tsx` local imports, existing package names, and existing branded domain types.
- Keep one authoritative formatter/projection per domain concept. Do not add speculative registries, compatibility layers, fallback authorities, or duplicate stores.
- Do not hand-edit generated `tsconfig*.json` path facades. Change `scripts/sync-paths.mjs` and regenerate.
- Update the affected maintained document, package README, and tests when a non-trivial change alters a public contract or workflow. Do not update archived `.scratch/` material merely to make it agree with new code.
- Follow [`docs/AGENTS.md`](docs/AGENTS.md) when editing or adding maintained documents — routing branches and the maintenance discipline live there.
- For visible UI changes, run the applicable component checks and `npm run test:browser`, inspect the new `artifacts/browser/` screenshots at desktop and 390×844, and verify keyboard/focus, dialog/menu accessibility, loading/error/empty states, and ordinary DSH restoration. Keep only a small, human-approved milestone set under `.scratch/archive/.../validation/`; routine screenshots stay ignored.
- Write each commit message as one Conventional Commits subject line: `type: lowercase imperative summary` (`feat`, `fix`, `chore`, `refactor`, `test`, `perf`, `docs`), with no body. Match the existing `git log` style.
- Do not commit credentials, temporary profiles, browser overlays, generated test files, browser artifacts, or build residue.

## Checks

Run the narrowest applicable check, then escalate for the changed surface. The exact workflow is in [`docs/development/start-and-checks.md`](docs/development/start-and-checks.md).

`npm run test:browser` is required for changes that can affect the assembled Web bundle, Client loading, slot takeover, Remote activation, or visible UI. It uses the adjacent Harness checkout and a temporary profile; it does not modify the Harness repository permanently.

Release cadence is batched: between releases the operator daily-drives a locally linked build as a lightweight acceptance channel, so choose the narrowest applicable check per change instead of demanding full acceptance for every small fix. When asking the operator to preview or accept a change, point them at the dev profile (`dsh web --profile web-dev`); the default `web` profile stays on the published stable release. See "Profile 模式与发布节奏" in [`docs/development/environments-and-install.md`](docs/development/environments-and-install.md).

## Further reading

- Domain and Host behavior: `packages/agent-team/src/`, its tests, and `docs/architecture/README.md`.
- Tools and preset: `packages/tool-agent-team/`, `packages/agent-team/preset/`, and the matching Harness subsystem docs.
- Client or UI: `packages/client-agent-team/src/client/`, `docs/architecture/README.md`, and `docs/harness-navigation.md`; consult the relevant `.scratch/archive/` work history only when needed, and verify all behavior in code and tests.
