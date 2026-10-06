# docs/ Work Rules

This directory holds the repository's maintained engineering documentation. The root `AGENTS.md` keeps rules every task must know; this file only governs how to work here — routing a change to the document that owns its facts, and the discipline that keeps the set truthful.

## Routing

A change that invalidates a documented fact updates the owning document in the same change:

| Change touches | Update |
| --- | --- |
| Domain vocabulary, concepts, or collaboration semantics | [`domain-model.md`](domain-model.md) |
| Package ownership, the published manifest, or import direction | [`architecture/package-ownership.md`](architecture/package-ownership.md) |
| Host authority: ledger, lifecycle, projections, Session persistence, Attention, context pressure, private memory, or member capabilities | [`architecture/host-authority.md`](architecture/host-authority.md) |
| The model-facing tool set, its defining modules, or the `team-member` preset | [`architecture/tools-and-preset.md`](architecture/tools-and-preset.md) |
| Typed Remote, Client plugin and slot composition, or the Client data/presentation boundary | [`architecture/client-and-remote.md`](architecture/client-and-remote.md) |
| Reuse of Harness Workspace, Session, or storage | [`architecture/workspace-session-storage.md`](architecture/workspace-session-storage.md) |
| The collaboration model, Thread/Task/Claim semantics, or Member time awareness | [`team-collaboration/model-and-time.md`](team-collaboration/model-and-time.md) |
| A model-facing tool contract, or a rule shared by every tool | [`team-collaboration/tools.md`](team-collaboration/tools.md) |
| Attention, Inbox, mentions, or how a Message is rendered | [`team-collaboration/attention-and-messaging.md`](team-collaboration/attention-and-messaging.md) |
| Mutation fences, the Human Remote boundary, or the Member context boundary | [`team-collaboration/boundaries.md`](team-collaboration/boundaries.md) |
| Member memory, context pressure ownership, Agent notifications, or assembled acceptance | [`team-collaboration/memory-and-context.md`](team-collaboration/memory-and-context.md) |
| Design principles or DSH design-language alignment | [`frontend-design/principles-and-language.md`](frontend-design/principles-and-language.md) |
| Layout, typography, colour, or identity | [`frontend-design/layout-and-typography.md`](frontend-design/layout-and-typography.md) |
| A Team component or its states | [`frontend-design/components.md`](frontend-design/components.md) |
| Timeline scrolling, the composer, entry rows, or status pills | [`frontend-design/thread-and-composer.md`](frontend-design/thread-and-composer.md) |
| The sidebar browser or the Inbox surface | [`frontend-design/sidebar-browser.md`](frontend-design/sidebar-browser.md) |
| Refresh semantics, copy, accessibility, or evolution | [`frontend-design/refresh-copy-accessibility.md`](frontend-design/refresh-copy-accessibility.md) |
| Setup, the verification gradient, or which check a change needs | [`development/start-and-checks.md`](development/start-and-checks.md) |
| Browser evidence, generated files, package seams, or adding a Host operation | [`development/generated-and-seams.md`](development/generated-and-seams.md) |
| Sandbox/CI environments, external installation, or release cadence | [`development/environments-and-install.md`](development/environments-and-install.md) |
| Ledger storage routing, notification regression, or a delivery checklist | [`development/storage-and-delivery.md`](development/storage-and-delivery.md) |
| Publishing a release, release gates, or release material | [`release-runbook.md`](release-runbook.md) |
| DSH certification, `peerDependencies`, or installation checks | [`dsh-release-compatibility.md`](dsh-release-compatibility.md) |
| Cross-repository lookup | [`harness-navigation.md`](harness-navigation.md) |
| User-visible behavior | [`../CHANGELOG.md`](../CHANGELOG.md) |

The full index and Where to start paths are in [`README.md`](README.md).

## Maintenance discipline

- Source and tests define implementation behavior. When prose conflicts with code, fix the documentation — never record behavior the code does not implement.
- One fact has one maintained home; cross-link between documents instead of duplicating the fact.
- Maintained docs ship as bilingual pairs: change `foo.zh.md` in the same change as `foo.md`, translating prose while keeping domain entity names in English (Agent, Member, Session, Workspace, Channel, Thread, Task, Claim, preset, Remote). A Chinese rendering is correct only when it names a different concept: `membership` renders as 成员关系, but a Member entity is always Member. Interface labels keep their natural Chinese — the `频道 · …` chip stays as-is.
- Both sides of a pair state the same rules and carry the same outline — the same headings at the same levels, in the same order, which `check:docs` decides. How a rule is rendered is the translator's call and is deliberately not compared: a list in one half and a table or prose in the other is legal. Implementation naming — a file, symbol, storage key, or CSS value — may appear on only one side.
- A new maintained document gets an index row and a Where to start path in both `README.md` and `README.zh.md` in the same change.
- Write uncertain facts as `> TODO:` instead of guessing.
- Keep a document readable block by block: no paragraph, single list item, table cell, heading, or code line may exceed the ceiling its file records in `scripts/check-docs.mjs`. Condensing a document lowers that ceiling in the same change; raising one is a deliberate decision, not a side effect.
- Run `npm run check:docs` after changing a document here, adding a maintained one, or editing any of the four README pairs (the repository root and one per package) or the root contributing pair; it decides the pairing, switcher, pair-outline, relative-link, heading-anchor, index, and longest-block rules above. `node scripts/check-docs.mjs --budgets` prints the per-file longest-block table instead of deciding. The shipped core skills under `packages/agent-team/core-skills/` have their own gate, `npm run check:core-skills`. Both commands are described in [`development/README.md`](development/README.md).
- Commit doc changes as one Conventional Commits subject line (`docs: ...`) over only your own staged paths — never `git add -A` in the shared worktree — and run `git diff --check HEAD` before committing: the bare form inspects only unstaged work, so it passes silently once your paths are staged.
- `.scratch/` is work history, not an authority; move conclusions into these documents only when durable, and never rewrite archives to match new code.

AGENTS.md files are single-language: this file and the root `AGENTS.md` are English, while maintained docs keep their `.zh.md` pairs.
