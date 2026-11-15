# Typed Remote and Client boundaries

English | [中文](client-and-remote.zh.md)

## Typed Remote
`@Remote` annotations on the Team service are inputs to `scripts/generate-typert.mjs`, which uses Harness `WorkspaceAnalyzer` and `FaceModelEmitter` to emit Host and Client artifacts under `packages/agent-team/lib/`.

```text
Host face declaration → generate:typert → Typert Host + Remote client → ctx.remote.$mount(...) → Client remote service
```

`InvocationDescriptor` is local reflection metadata, not a wire message. Wire fields remain explicit typed values. Update declarations/tests, regenerate, and run typecheck/build; never hand-edit artifacts.

Read requests state their purpose instead of sharing one projection shape. `view` takes `includeCatalog` only when the caller wants the Task/Thread/Claim catalog of the whole request scope — the address book the model-facing `team_view` renders; the Client's reads never ask for it and render the page they requested.

`managerSession({})` resolves the Host-owned manager without a caller-selected identity. `newManagerSession({expectedSessionId})` replaces only the Session that caller currently sees; a stale id observes the current Session instead of creating another. Both return one union: `ready` with the Session and Workspace ids, `no-workspace` as an ordinary empty state, or `unavailable` with a structured Host diagnostic.

`sessionOwnership({sessionIds})` classifies current and retained Team Sessions as `manager` or `member`. Its authority is the private manager lineage and Member ledger, including archived and cold Sessions; id prefixes and preset labels are not ownership evidence.

## Remote failure vocabulary
Generated Remote methods resolve a `RemoteResult`: `{ ok: true, value }` carries the business result, `{ ok: false, error }` carries a failure whose stable `code` discriminates and whose `details` the code narrows without a cast.

- Business rejections — `unread_required`, `stale_revision` — stay result unions: they are the normal control flow the Client already models, not Remote errors. They are also the whole rejection vocabulary of a version-2 write: a mention or an answer delivers directly, so no write asks the caller to send it again.
- An expected cross-Remote failure that needs its own Client branch is thrown as a `RemoteError`; the owner declares its code by merging it into `RemoteErrorDetailsMap`, and Team merges its codes into the public types entry both faces compile against. Team's first code is `team/attachment-not-found`: only a confirmed absent cache entry uses it. Invalid UUIDs, out-of-cache paths, missing metadata or payload, malformed metadata, I/O, and payload read failures remain generic Host errors.
- Clients branch on `code`, never on message text — the message is a human diagnostic, not contract. Unknown codes and unclassified Host exceptions arrive as `gateway/internal`, so each branch keeps a generic fallback.
- The attachment preview caches successful image bytes. A confirmed miss shows the expired state for that mount without a negative cache, so a later mount can reread the same id. Other read failures and browser decode failures keep the file name, expose an explicit retry, and never open an empty preview.

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

The manager destination is a gate, not a Team conversation surface. While `manager: true` has no resolved id, the `main` conversation shadow renders a thin loading or error state. It calls `managerSession({})`; on `ready` it opens that Session through the shipped workspace controller, records the runtime id, and stands down so the shipped Conversation owns the main seat with its ordinary composer. A late resolution after the reader leaves is ignored.

`unavailable` keeps the gate with the Host diagnostic and a retry; no sendable Team composer appears. `no-workspace` leaves Team and invokes the shipped choose/create-Workspace flow. The manager destination itself persists only `manager: true`; the resolved `managerSessionId` and ordinary `returnToSessionId` stay runtime-only, so a cold restore resolves through the Host again.

The shipped session header replaces its preset label with a new-conversation action only while the current manager Session is displayed. It calls `newManagerSession({expectedSessionId})` with that Session id, opens the successor, and updates the runtime destination. Opening a Host-resolved id makes bounded catalog retries when reload joined an earlier pull that did not contain it.

Explicit Team navigation closes the manager destination; leaving restores the captured ordinary Session when it still exists. If cold restoration found the manager already seated, the return target is the newest visible ordinary, non-Team Session in the Host-returned Workspace. With no surviving target, leaving uses the shipped new-Session flow with its default preset and Workspace choice.

The create-time guard wraps the public `ISessions.create` boundary. For an implicit-preset blank candidate it reads exact Host ownership; a Team-owned id is omitted before the shipped creation continues, while ordinary blanks and explicit-preset requests pass through unchanged. A failed ownership read does not retry the unsafe candidate. Disposal during the read rejects the pending creation; it neither creates a Session nor leaves the caller waiting forever.

This guard excludes only blank reuse. A successful replacement automatically archives the retired manager, so its retained history appears in the Workspace's archive view rather than its active Session list; an archival failure does not roll back the successor. A current manager viewed in the ordinary list still keeps its fixed composition.

While a manager is displayed, temporary slot replacements remove its hero preset picker, header preset label, and permission control. They release on every other Session so the shipped controls return. This is presentation only, not a grant or authorization lock; [Tools and preset](tools-and-preset.md#team-manager-preset) owns the Host composition and execution guard.

A slot parent's `children` declaration is both render site and authority. Team's `sidebar.workspaces` shadow must not redeclare shipped `sidebar.workspaces.directoryFlow`; Harness SlotCore rejects duplicate live declarations. Do not copy private WorkspaceBrowser, ConversationRoot, Shell, or private CSS. Use public Harness services and exports, such as `ctx.workspaces.pickDirectory()`, and record limitations rather than depending silently on private implementation.

## Client data and presentation boundary
Client components do not reach into `ctx`, the operation ledger, or Host classes. Data and callbacks arrive through slot owner props, runtime props, declared stores, or injected faces. Presentation consumes Host projections and local navigation state and does not invent durable facts.

New Project composition defaults to taskless and exposes default-off 「作为任务」 for atomic Task creation. Taskless Threads retain reply/read/follow/Inbox behavior but gate status, Claims, and resolution controls until promotion. Promotion is non-optimistic and followed by rereading Thread and supplemental projections.

The Human Client consumes the Host's Inbox projection, never keeps a parallel Inbox authority, and acknowledges nothing by opening the page. That projection is the 「收件箱 / Inbox」 queue: a merged per-Workspace badge and page covering each reader's whole unread slice, where mentions are counted inside it, never its admission rule.

It also carries a second 「最近活跃」 slice that an Agent's Inbox never does — the Threads that reader has written a Message in, so a Thread they replied to is theirs whether or not they follow it. That slice is newest activity first, each Workspace's own slice bounded to ten while the merged page shows at most five.

Team navigation mode, Workspace selection, the last Project/Thread, the Inbox page position, and the manager destination token are browser-persisted. Unread and Attention are Host-owned; resolved Session ids and return targets remain runtime-only and are re-resolved through the Host.

Thread reads belong to one opening of the page or discussion panel. Switching Threads discards late history, unread, and follower results from the earlier opening, including when the reader returns to the same Thread.

The Team sidebar keeps Projects/Agents ordering as a Host-row setting (`sidebarOrder`, beside the Human profile), merged over Remote defaults and cached per browser. A browser saves one list in drag order, keeping the latest queued order while a save is in flight. A browser that lost its cache reads the Host order back.

The Team settings grant editor consumes `toolCatalog` for discovery and injects `remote.settings` for the accepted list. It writes only `extraToolGrants` with the revision read at the start of the edit. It does not use the shared configuration form's mutation adapter because that adapter reduces every failure to a boolean; the editor must distinguish `settings/conflict`, `settings/rejected`, and transport failure.

Its accepted list, Human identity, and catalog have independent loading and failure states. A conflict keeps the local draft, rereads the latest committed list, and requires explicit review before another save; it never replays the stale draft. A failed accepted-list read cannot become `[]`.

An embedded Member Session uses the shipped composer unmodified: the Team registers no member-session composer surface — no seat shadow, no trigger sources, no dock strip. rc.1 moved the trigger-menu overlay into `conversation.composer.bar`'s children, where a shadowing entry would inherit — and strand — the overlay. The Team's own command/member reference entry points carried no irreplaceable value over the shipped vocabulary, so they were removed together.

Ordinary and member sessions share the same composer and vocabulary. Reuse public primitives and `--dsw-*` tokens, keep CSS in CSS Modules, and preserve Team mode restoration and narrow layouts.
