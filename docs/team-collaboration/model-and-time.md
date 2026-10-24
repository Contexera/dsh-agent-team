# Collaboration model and time

English | [中文](model-and-time.zh.md)

## Collaboration model
A top-level Project Message creates one Thread and anchor. New model-facing starts are taskless by default; explicit task intent creates a Task overlay atomically, while an omitted field remains taskful for released Clients. A Human can promote a taskless Thread with one atomic Task activity. Replies append immutable Messages. Public Thread chronology consists of Messages and, only with a Task overlay, Claim changes, Human resolution, and promotion.

Agents may read or mutate only Projects in Workspaces they participate in. Tools resolve the actor from the exact live Agent; the model cannot choose an actor. The `workspace` selector must name a participated Workspace — an exact id, or a unique prefix of at least 6 hex characters, the same tolerance the branded refs have. A prefix matching several Workspaces is refused by naming every candidate.

The selector can be omitted for a single participation. With multiple participations it is required on `team_view`, `team_thread`, `team_message`, and `team_task`, and rejection lists the available Workspace ids.

`team_inbox` instead merges all participations by default, with `workspace` as an optional filter applied before sorting and truncation. Inbox rows and notification details identify their source Workspace; `team_thread` renders Workspace/Project provenance before the outcome line. Multi-Workspace guidance supplies paths, the `working_directory` rule and per-checkout `AGENTS.md` pointers.

Joining does not change Session cwd; entering a joined Workspace does, through `working_directory({cd})`, and that change is what makes the checkout's instructions load.

## Member time awareness
Every agent-facing collaboration surface carries absolute event instants; sequence and revision — never wall-clock time — remain the sole ordering and concurrency authority. Ledger storage keeps UTC ISO `occurredAt` on every operation; rendering converts through one fixed-offset formatter into the Team coordination zone UTC+8 with an explicit offset (`2026-09-08T17:00:00+08:00`).

The fixed offset has no daylight-saving component, so the same stored instant renders byte-identically on every reread path (read, history paging, post-compaction rebuild, old-ledger replay) — the context-cache invariant. Only absolute timestamps are rendered; relative time text ("3 hours ago") never appears in durable facts. A future configuration layer may make the zone configurable; until then one deterministic formatter per stored instant is the contract, and the Web Client keeps its own browser-local rendering.

- `team_thread` read/history facts and the anchor carry their committing operation's instant on the fact envelope (message and activity alike — activities have no instant of their own). Fact lines render `sequence instant [sender] body`; the anchor renders `Anchor sequence instant [sender]`.
- `team_inbox` rows carry `newestOccurredAt` — the instant of the newest unread fact, taken from the same snapshot as `newestSequence`.
- `team_view` Thread rows carry `lastActivityAt`, projected from the Thread's tail fact.
- Automatic notifications state `Occurred at:` on direct mentions and activities, and the newest ordinary unread instant on body-free routes.
- DM relays state the sending instant; the prior-DM context line cites that DM's instant.
- Committed mutations (`team_message` start/reply/dm, `team_task`) render `Committed at:` from the operation receipt; optimistic Client merges read the same receipt instant.
- Ledgers written before fact-envelope instants existed normalize on replay: the instant is re-derived from the committing operation, never fabricated.

Besides event instants, the first model step of every eligible Team Member turn receives one durable clock snapshot (the `member-time-context` preset row): the current instant in UTC+8, the elapsed time since the preceding model-visible event, and the ordering-authority note.

Later steps of the same turn stay quiet unless the turn has run longer than the refresh interval since the last landed snapshot. When it has, one snapshot lands per elapsed interval — a tool-dense turn of quick steps produces exactly one line, while a turn that outlives the interval still shows its real span. Skipped steps never backfill, and their span folds into the next snapshot's elapsed. The default interval is 30 minutes, overridable through the preset row's plugin config for a future configuration layer to take over.

The baseline folds from the Member Session's own events, so restart, resume, and compaction derive identical values without a second store; a generation swap starts a fresh log and renders elapsed as `unavailable` rather than guessing across generations; a wall-clock rollback clamps elapsed to `0s` without rewriting history. The shipped `@deepseek-ai/dsh-time-context` stays unmounted because its browser-zone policy would ask background-woken Members to confirm dates with an absent user.

Time never drives automatic behavior: no deadlines, reminders, schedulers, SLAs, or staleness-driven state changes exist.
