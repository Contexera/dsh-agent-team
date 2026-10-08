# @contexera/dsh-agent-team/client

English | [中文](README.zh.md)

The optional Web Client for Agent Team. It adds Team mode through public Client slots and typed Host Remote methods; it does not own Team data or unread state.

## Human workflow

Team mode opens the Channels workspace by default. Human navigation follows Workspace → Channel → Thread; a Task is an optional card/header overlay on a Thread, not a navigation level. A top-level Channel Message defaults to a taskless Thread; the Human composer has a default-off **As task** control for atomic Task creation, and a taskless Thread can later be promoted by the Human through a durable Host mutation. Promotion rereads Host projections rather than synthesizing an optimistic Task. Taskless Threads retain reply, follow, mentions, Inbox, read, and history, while status, Claims, and Task-resolution controls appear only after a Task exists. The Client does not display, enter, or poll a Human Inbox. Opening a Thread performs a Host-owned `readThread` and shows the public Thread timeline, bounded history, any active Claims, and runtime risk for claimed Agents in an error state. The current Thread UI does not show follow/unfollow controls or Human follow/unfollow observations. Human messages render as literal text while Agent messages render through the shared Harness Markdown primitive; the timeline opens at the latest fact, follows new content only while the reader stays at the bottom, and keeps prepended history visually stable. Reading is fully automatic: a bounded read's remaining unread drains through continued Host reads (no manual read or continue-reading controls exist), and arrivals while the Thread is open are acknowledged durably regardless of scroll position — a reader away from the bottom sees only a pure “↓ N new update(s)” jump hint with no read semantics. Known branded Task refs in message bodies render in place as clickable `Task #N` links and resolve to their home Channel and Thread, including inside Agent Markdown and across Channels; model-style doubled-colon or uppercase spellings are canonicalized before lookup, and a code span holding exactly one ref renders as its link too. Code blocks and code spans holding more than a ref stay literal; unknown refs remain non-navigable.

The sidebar rows carry their own controls: the ⋯ row menu opens per-row editors, `updateChannel` renames a Channel's name/description and `updateMember` edits an Agent's handle/description and pins an optional per-Member provider/model (an absent model clears the override back to Host-default inheritance; changing the model of an active Member updates its live model selection in place, preserving the Agent and Session identities so subsequent requests use the new choice). The model picker reads the Host catalog through the session-independent `llm.models` RPC. Clicking an Agent card temporarily shows that Member's Session inside Team mode without discarding the selected Channel or Thread underneath. Both row menus also carry a danger **Archive** entry: `archiveMember` and `archiveChannel` hide the entity from every surface (durable data kept, active Claims released) behind a destructive-confirm dialog that states the no-restore-entry-point contract; archived rows disappear with the workspace-scope refresh, and mention candidates, member pickers, and Channel member lists all exclude archived Members. There is no sidebar archive list or restore entry this round.

The Client uses these Host projections and mutations:

- `readThread` acknowledges a Thread batch.
- `threadHistory` pages older facts without marking them read.
- `promoteThread` atomically attaches a real Task to a taskless Thread and records its structured `promote` Task activity.
- `resolveTaskRefs` resolves known branded Task refs to their display number and home Channel/Thread for navigation.
- `updateChannel` commits a Channel rename (name/description display facts).
- `archiveChannel` hides a Channel from every surface with its facts kept (no restore entry point yet).
- `updateMember` commits Agent handle/description edits plus an optional per-Member model override.
- `archiveMember` hides an Agent from every surface with its session log and private memory kept (no restore entry point yet).
The Host Remote also exposes `threadObservations` and `changeAttention`; the current Human Thread surface does not render these controls or observations. `changes` is a scoped streaming Remote consumed through Harness `ctx.remote.$stream()`. Each page shares one logical subscription per scope and Harness multiplexes it over the page's shared WebSocket, so opening several Team pages does not reserve ordinary HTTP connections for notifications. Every opening/reconnection baseline triggers a Host reread, including unchanged versions; leaving the last subscriber cancels that scope. Opening a Thread performs parallel initial reads and may perform a baseline catch-up, but private read acknowledgments cause no shared notification loop. See [architecture](../../docs/architecture/host-authority.md) for the authoritative scope and recovery contract.

Team mode, selected Workspace, and the last selected Channel or Thread are persisted in browser storage, so returning to Team restores the previous location. Attention, unread counts, revisions, observations, and Thread facts remain Host-owned. Durable mutations are refreshed from Host after commit or rejection.

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
