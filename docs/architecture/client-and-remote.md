# Typed Remote and Client boundaries

English | [中文](client-and-remote.zh.md)

## Typed Remote
`@Remote` annotations on the Team service are inputs to `scripts/generate-typert.mjs`, which uses Harness `WorkspaceAnalyzer` and `FaceModelEmitter` to emit Host and Client artifacts under `packages/agent-team/lib/`.

```text
Host face declaration → generate:typert → Typert Host + Remote client → ctx.remote.$mount(...) → Client remote service
```

`InvocationDescriptor` is local reflection metadata, not a wire message. Wire fields remain explicit typed values. Update declarations/tests, regenerate, and run typecheck/build; never hand-edit artifacts.

Read requests state their purpose instead of sharing one projection shape. `view` takes `includeCatalog` only when the caller wants the Task/Thread/Claim catalog of the whole request scope — the address book the model-facing `team_view` renders; the Client's reads never ask for it and render the page they requested.

## Remote failure vocabulary
Generated Remote methods resolve a `RemoteResult`: `{ ok: true, value }` carries the business result, `{ ok: false, error }` carries a failure whose stable `code` discriminates and whose `details` the code narrows without a cast.

- Business rejections — `unread_required`, `stale_revision`, `confirmation_required` — stay result unions: they are the normal control flow the Client already models, not Remote errors.
- An expected cross-Remote failure that needs its own Client branch is thrown as a `RemoteError`; the owner declares its code by merging it into `RemoteErrorDetailsMap`, and Team merges its codes into the public types entry both faces compile against. Team's first code is `team/attachment-not-found`: the attachment read separates a gone cache entry from every other failure.
- Clients branch on `code`, never on message text — the message is a human diagnostic, not contract. Unknown codes and unclassified Host exceptions arrive as `gateway/internal`, so each branch keeps a generic fallback: the attachment preview settles a not-found into the expired chip, caches no other failure, and lets a later render retry the Host.

## Client plugin and slot composition
The external Client plugin leaves the shipped Shell as outer-layout owner. Team adds one global panel and shadows three seats:

```text
sidebar.panellist           additive Team row, order 20
main (key agent-team)       Team panel, priority -100
sidebar.workspaces          Team shadow, priority -100
main (key conversation)     Team shadow, priority -100
sidebar.settings            Team shadow, priority -100
```

Activation mounts `agentTeamRemote`, waits for `remote.agentTeam`, then registers the Team panel, its rail row, and the mode shadows. `dsh.client.inject` describes the module graph but does not guarantee apply order or service readiness; use `ctx.slots.inject()` when a declaration may appear later.

The panel row and Team mode are one fact: the row is the shell's own rail button, selecting it enters the mode, and another panel taking the column leaves it. A null selection is left alone — an embedded Member Session view clears the panel to own the column and the mode has to survive that — while the mode's own foot row clears the panel itself. A restored mode re-selects its panel unless a panel was already selected at mount, in which case that panel keeps the column and the mode stands down.

A slot parent's `children` declaration is both render site and authority. Team's `sidebar.workspaces` shadow must not redeclare shipped `sidebar.workspaces.directoryFlow`; Harness SlotCore rejects duplicate live declarations. Do not copy private WorkspaceBrowser, ConversationRoot, Shell, or private CSS. Use public Harness services and exports, such as `ctx.workspaces.pickDirectory()`, and record limitations rather than depending silently on private implementation.

## Client data and presentation boundary
Client components do not reach into `ctx`, the operation ledger, or Host classes. Data and callbacks arrive through slot owner props, runtime props, declared stores, or injected faces. Presentation consumes Host projections and local navigation state and does not invent durable facts.

New Channel composition defaults to taskless and exposes default-off 「作为任务」 for atomic Task creation. Taskless Threads retain reply/read/follow/Inbox behavior but gate status, Claims, and resolution controls until promotion. Promotion is non-optimistic and followed by rereading Thread and supplemental projections.

The Human Client consumes the Host's Inbox projection (the 「收件箱 / Inbox」 queue: the merged per-Workspace badge and page, covering each reader's whole unread slice — mentions are counted inside it, never its admission rule, plus a second 「最近活跃」 slice — the Threads that reader has written a Message in, so a Thread they replied to is theirs whether or not they follow it, newest activity first, each Workspace's own slice bounded to ten while the merged page shows at most five, which an Agent's Inbox never carries); it never keeps a parallel Inbox authority, and opening the page acknowledges nothing.

Team navigation mode, Workspace selection, the last Channel/Thread, and the Inbox page position are browser-persisted; unread and Attention are Host-owned.

The Team sidebar keeps Channels/Agents ordering as a browser-only `localStorage` preference, merged over Remote defaults.

An embedded Member Session uses the shipped composer unmodified: the Team registers no member-session composer surface — no seat shadow, no trigger sources, no dock strip. rc.1 moved the trigger-menu overlay into `conversation.composer.bar`'s children (a shadowing entry would inherit — and strand — the overlay), and the Team's own command/member reference entry points carried no irreplaceable value over the shipped vocabulary, so they were removed together.

Ordinary and member sessions share the same composer and vocabulary. Reuse public primitives and `--dsw-*` tokens, keep CSS in CSS Modules, and preserve Team mode restoration and narrow layouts.
