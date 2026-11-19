# Repository Guidelines

## Scope and authority

`dsh-agent-team` is an opt-in, externally installable Cordis bundle for DeepSeek Harness. It adds a single-host Agent Team without modifying the Harness repository, the agent loop, or shipped defaults.

## Start here

1. Read the [documentation index](docs/README.md#where-to-start) first and follow the route for your change.
2. For commands and setup, use [Start and checks](docs/development/start-and-checks.md). If your change relies on a Harness capability, use [Harness navigation](docs/harness-navigation.md).
3. For maintained docs, read [`docs/AGENTS.md`](docs/AGENTS.md) before editing and run `npm run check:docs`.

## Sources of truth

Use this authority order:

1. **Current behavior:** source and tests under `packages/`. When prose disagrees with code, code wins.
2. **Maintained engineering guidance:** `docs/`. Update it when a code or workflow change invalidates or extends it; it must not define behavior that the code does not implement.
3. **Harness contract:** `../deepseek-harness/docs/`, its applicable `AGENTS.md`, and the corresponding Harness source/tests.
4. **Work history:** `.scratch/` — active work items and archived design, research, tickets, prototypes, and validation evidence. It is not an implementation or API authority; its own [`AGENTS.md`](.scratch/AGENTS.md) governs how to work there, and the [`README.md`](.scratch/README.md) indexes it. Verify relevant history against code, tests, and the Harness contract.

For new cross-session work, use one `.scratch/active/<work>/` directory. Archive it only after moving durable conclusions to maintained docs. The [`.scratch/` rules](.scratch/AGENTS.md) cover work-item readiness, delegation, review, and acceptance. `.agents/skills/` is a one-way downstream copy of the skills source repository.

## Architecture guardrails

- `packages/agent-team` is the only Team authority. Its append-only operation ledger is the durable source of Team facts; projections, tools, commands, Remote, and UI do not maintain parallel authority.
- Expose model-facing Team tools only through the isolated `team-member` and `team-manager` presets. See the [tool and preset map](docs/architecture/tools-and-preset.md) and [bundle patch](cordis.patch.yml) for the rosters; `team_worker` is declared only while the Host Worker switch is on. Do not add Team tools or guidance to ordinary Sessions. The Web Client is the only Human Team control surface; do not restore a slash-command adapter.
- Team is an external plugin. Do not modify `../deepseek-harness`, its agent loop, or shipped defaults for ordinary Team work. If a public Harness extension point is insufficient, record the limitation and decide whether to implement a Team-owned plugin or change the design.
- Typed Remote declarations are the input; Typert artifacts are generated. Never hand-edit `packages/agent-team/lib/typert.*`.
- The Client uses public Harness plugin and slot APIs. Mount the generated Remote, wait for `remote.agentTeam`, and use `ctx.slots.inject()` when a declaration may not exist yet; `dsh.client.inject` is not an activation-order guarantee.
- A slot parent’s `children` declaration is its render authority. Do not copy private shipped UI or redeclare `sidebar.workspaces.directoryFlow` from the Team workspace shadow; live duplicate child declarations are rejected by Harness SlotCore, regardless of priority.
- Keep durable UI mutations non-optimistic. Authorization, membership, revisions, idempotency, and stable branded refs are enforced by the Host.

## Code and documentation conventions

- Use ESM, strict TypeScript, `.ts`/`.tsx` local imports, existing package names, and existing branded domain types.
- Keep one authoritative formatter/projection per domain concept. Do not add speculative registries, compatibility layers, fallback authorities, or duplicate stores.
- Keep code self-explanatory. Comments explain non-obvious constraints, ownership, or reasons; behavior must not depend on prose for its definition. See `check:comments` in [Start and checks](docs/development/start-and-checks.md#verification-gradient) for reference rules. Review comment quality by reading the comments, not by counting lines.
- For bulk comment deletion, verify each range in the current file, including ranges suggested by subagents. Remove whole comment blocks without merging ranges or normalizing whitespace elsewhere. Audit the diff: every removed line must be a comment or blank line. A passing test suite is not evidence for this audit.
- Do not hand-edit generated `tsconfig*.json` path facades. Change `scripts/sync-paths.mjs` and regenerate.
- Update the affected maintained document, package README, and tests when a non-trivial change alters a public contract or workflow. Do not update archived `.scratch/` material merely to make it agree with new code.
- Follow [`docs/AGENTS.md`](docs/AGENTS.md) when editing or adding maintained documents — routing branches and the maintenance discipline live there.
- Write each commit message as one Conventional Commits subject line: `type: lowercase imperative summary` (`feat`, `fix`, `chore`, `refactor`, `test`, `perf`, `docs`), with no body. Match the existing `git log` style.
- Land each work item as one commit: fix the original commit by amending it while the range is unpushed rather than adding a fixup, and squash a work item's several commits before pushing. Never rewrite history that is already pushed or merged.
- Do not commit credentials, temporary profiles, browser overlays, generated test files, browser artifacts, or build residue.

## Choose checks for the change

Run the narrowest applicable check, then escalate for the changed surface. The exact workflow is in [`docs/development/start-and-checks.md`](docs/development/start-and-checks.md).

- **Host, Ledger, Remote, permissions, persistence, subscriptions, Worker state:** run targeted Vitest (`npx vitest run --project unit` or the relevant integration spec) first, then `npm test` and `npm run typecheck`.
- **Client state machine, DOM interaction, error copy:** run the targeted `packages/client-agent-team/tests/*.client.spec.tsx` first.
- **Slot, preset, bundle manifest, ordinary DSH restore, real keyboard/layout, multi-page:** run the matching targeted browser lane (`npm run test:browser -- <lane>`) listed in [`docs/development/e2e-lanes.md`](docs/development/e2e-lanes.md).
- **Complete Team journey, broad shell/visual regression, or release:** add `--deep` (`npm run test:browser -- --deep`) to run the `team-journey-deep` profile; the default full run uses the shorter Team smoke.
- **Cross-surface flow or `scripts/run-browser-test.mjs` / `scripts/e2e/support.ts`:** run unfiltered `npm run test:browser` (with `CHROME_PATH` when `/usr/bin/google-chrome` is absent, e.g. macOS).
- Targeted lanes are development feedback; unfiltered `npm run test:browser` is the delivery gate for assembled-Web changes.

`npm run test:browser` is required for changes that can affect the assembled Web bundle, Client loading, slot takeover, Remote activation, or visible UI. It uses the adjacent Harness checkout and a temporary profile; it does not modify the Harness repository permanently.

For visible UI changes, also run the applicable component checks. Inspect new `artifacts/browser/` screenshots at desktop and 390×844; check keyboard and focus, dialog/menu accessibility, loading/error/empty states, and ordinary DSH restoration. Archive only a small, human-approved milestone set under `.scratch/archive/.../validation/`; routine screenshots stay ignored.

Report the changed surface, expected checks, checks run, and anything unverified with the reason. If Chrome, Harness, or another required dependency is unavailable, do not claim the browser check passed.

Releases are batched. Between releases, the operator uses the locally linked build for lightweight acceptance; choose the narrowest check that covers each change. Send operator preview or acceptance requests to the [development profile](docs/development/environments-and-install.md#profiles-and-release-cadence) (`dsh --profile web-dev`); the default `web` profile stays on the published stable release.
