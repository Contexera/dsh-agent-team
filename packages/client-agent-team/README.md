# @contexera/dsh-agent-team/client

English | [中文](README.zh.md)

The optional Web Client for Agent Team. It adds Team mode through public Client slots and typed Host Remote methods; it does not own Team data or unread state.

## Human workflow

Team mode opens the Projects workspace by default. Human navigation follows Workspace → Project → Thread; a Task is an optional card/header overlay on a Thread, not a navigation level. A top-level Project Message defaults to a taskless Thread; the Human composer has a default-off **As task** control for atomic Task creation, and a taskless Thread can later be promoted by the Human through a durable Host mutation. Promotion rereads Host projections rather than synthesizing an optimistic Task. Taskless Threads retain reply, follow, mentions, Inbox, read, and history, while status, Claims, and Task-resolution controls appear only after a Task exists. The Client does not display, enter, or poll a Human Inbox. Opening a Thread performs a Host-owned `readThread` and shows the public Thread timeline, bounded history, any active Claims, and runtime risk for claimed Agents in an error state. The current Thread UI does not show follow/unfollow controls or Human follow/unfollow observations. Human messages render as literal text while Agent messages render through the shared Harness Markdown primitive; the timeline opens at the latest fact, follows new content only while the reader stays at the bottom, and keeps prepended history visually stable. Reading is fully automatic: a bounded read's remaining unread drains through continued Host reads (no manual read or continue-reading controls exist), and arrivals while the Thread is open are acknowledged durably regardless of scroll position — a reader away from the bottom sees only a pure “↓ N new update(s)” jump hint with no read semantics. Known branded Task refs in message bodies render in place as clickable `Task #N` links and resolve to their home Project and Thread, including inside Agent Markdown and across Projects; model-style doubled-colon or uppercase spellings are canonicalized before lookup, and a code span holding exactly one ref renders as its link too. Code blocks and code spans holding more than a ref stay literal; unknown refs remain non-navigable.

The sidebar rows carry their own controls: the ⋯ row menu opens per-row editors, `updateProject` renames a Project's name/description and `updateMember` edits an Agent's handle/description and pins an optional per-Member provider/model (an absent model clears the override back to Host-default inheritance; changing the model of an active Member updates its live model selection in place, preserving the Agent and Session identities so subsequent requests use the new choice). The model picker reads the Host catalog through the session-independent `llm.models` RPC. Clicking an Agent card temporarily shows that Member's Session inside Team mode without discarding the selected Project or Thread underneath. Both row menus also carry a danger **Archive** entry: `archiveMember` and `archiveProject` hide the entity from every surface (durable data kept, active Claims released) behind a destructive-confirm dialog that states the no-restore-entry-point contract; archived rows disappear with the workspace-scope refresh, and mention candidates and member pickers exclude archived Members. There is no sidebar archive list or restore entry this round.

The Client uses these Host projections and mutations:

- `readThread` acknowledges a Thread batch.
- `threadHistory` pages older facts without marking them read.
- `promoteThread` atomically attaches a real Task to a taskless Thread and records its structured `promote` Task activity.
- `resolveTaskRefs` resolves known branded Task refs to their display number and home Project/Thread for navigation.
- `updateProject` commits a Project rename (name/description display facts).
- `addProjectOwner` / `removeProjectOwner` edit a Project's Agent owners from the Project edit dialog; the section renders only when the Host `view` reports rules version 2 or later, and the Human is always listed as a fixed owner.
- `postMainMessage` / `startThread` / `readMainStream` / `mainStreamHistory` drive the Project's Main stream; the Project page uses them only when the Host `view` reports rules version 2 or later (the first tab becomes the Main stream, and the composer's `讨论/任务` toggle starts discussions and Tasks).
- `archiveProject` hides a Project from every surface with its facts kept (no restore entry point yet).
- `updateMember` commits Agent handle/description edits plus an optional per-Member model override.
- `archiveMember` hides an Agent from every surface with its session log and private memory kept (no restore entry point yet).
The Host Remote also exposes `threadObservations` and `changeAttention`; the current Human Thread surface does not render these controls or observations. `changes` is a scoped streaming Remote consumed through Harness `ctx.remote.$stream()`. Each page shares one logical subscription per scope and Harness multiplexes it over the page's shared WebSocket, so opening several Team pages does not reserve ordinary HTTP connections for notifications. Every opening/reconnection baseline triggers a Host reread, including unchanged versions; leaving the last subscriber cancels that scope. Opening a Thread performs parallel initial reads and may perform a baseline catch-up, but private read acknowledgments cause no shared notification loop. See [architecture](../../docs/architecture/host-authority.md) for the authoritative scope and recovery contract.

Team mode, selected Workspace, and the last selected Project or Thread are persisted in browser storage, so returning to Team restores the previous location. Attention, unread counts, revisions, observations, and Thread facts remain Host-owned. Durable mutations are refreshed from Host after commit or rejection.

## Composition boundary

The package contributes the Team workspace, conversation, and footer slots through the public Harness slot APIs. It does not modify Harness source, replace shipped stores, or read the operation ledger. The `team-member` preset remains the only place where model-facing Team tools and guidance are enabled.

## Development

Run package checks from the repository root:

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
npm run preview:ui
```

`test:browser` runs the deterministic, credential-free assembled Team journey. `preview:ui` loads isolated Host fixture state with model streaming disabled. Use the root `npm run preview` only for credentialed live Agent interaction.
