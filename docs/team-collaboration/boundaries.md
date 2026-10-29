# Mutation fences and boundaries

English | [中文](boundaries.zh.md)

## Mutation fences
Three states are separate: facts supplied in full in the current context, unread facts explicitly acknowledged by `team_thread read`, and a mutation committed by the Host. A notification, rejection, `history`/`message` lookup, or reply never advances a read watermark or consumes a direct marker.

Existing-Thread public mutations require the current next-write token in `baseRevision`. Copy the latest explicitly rendered value verbatim; never derive, increment, compare, or cite it as a Thread fact. A token comes from a fully drained `team_thread read`, your own committed public mutation, or an eligible complete Thread rejection. Browsing results, notices, and partial reads carry no token.

The Host checks unread facts before token freshness. Every pending Thread Message may instead be supplied in full in the writer's live Session: a Team notice or a `team_thread`, `team_message`, or `team_task` result must bind the exact Thread, Message, and body to the actual projected text. Retained metadata alone, summaries, truncated bodies, model paraphrases, a DM, or identical text from another Message do not qualify. Activity facts still require `read`.

This context check changes no durable state and keeps no second read database. One missing fact, a changed projection, or no live Session keeps the unread refusal. Even when all facts qualify, the Host still checks the current revision, permissions, and Task state; receiving a token never guarantees that the next write commits.

`unread_required` and `stale_revision` begin `Not committed` and render a bounded selection of pending facts. When every required fact is a complete, identified Message and the prior revision is recognized, the result supplies a current token: reconsider the proposed write using those facts, without a mandatory intervening read. Read if earlier discussion context is missing. New arrivals can refuse that reconsidered write again.

Partial or omitted facts, Activity facts, and an unknown or unrecognized revision baseline supply no retry token and route to `team_thread read`. An unrecognized token does not establish that the Thread changed concurrently. Main stream refusals still require `read` with `projectRef`. These are normal collaboration outcomes, not infrastructure failures; there is no force-send.

Closed Tasks reject replies, Claims, and new Attention. Taskless Threads have no Claim or Task-resolution mutation.

Close releases active Claims and ends Attention. Reopen restores an open Task, not previous Attention periods; a new reopen restores the accountable's current Thread follow unless the accountable is the actor or already follows. Older reopen records keep their marker-only replay semantics.

## Ownership and Task authority
A Project owner starts or promotes Threads; accountability is separate from execution and does not confer ownership. A Member can execute a Task without owning its Project.

| Action | Human | Agent |
| --- | --- | --- |
| Start or promote a Thread | Yes | Project owner |
| Accept | Any open Task | Project owner, only in `in_review`, and never held any Claim on the Task |
| Close or reopen | Yes | Current accountable |
| Transfer an open Task | Yes | Current accountable |
| Transfer a finished Task | Yes | No |

An accountable Agent who held any Claim cannot accept that Task. An uninvolved Project owner or the Human must verify it; the accountable may instead transfer responsibility. A transfer target is an enabled Project owner or the Human, and Claims stay with their executors. Removing an accountable Agent's ownership or Workspace participation, archiving, or removing that Agent returns their open Tasks to the Human in the same operation. Suspension keeps accountability.

## Human Remote boundary
The Human Client uses `readThread`, `threadHistory`, `threadObservations`, and `changes`, and it consumes the Host's Human Inbox slice as the 「收件箱 / Inbox」 queue. Attention has two entry points, neither of them model-facing: the Agent tool `team_attention` goes through `changeAttentionForAgent`, while `@Remote('changeAttention')` is the Human Remote — which both Thread faces wire to one shared follow control, so a Human subscribes to a Thread's ordinary updates from the Web surface.

Task responsibility moves through the Human `transferTask` Remote. The Client offers only the targets the Host `view` already projects as Project owners, plus the Human, and re-implements neither the transfer rules nor the accept/close/reopen authority, which stay on the Host. The control also stands on a closed Task, because only a Member actor is confined to open Tasks and a finished Task whose accountable is no longer a Project owner is mended from there.

A committed transfer is also stated where the control stands: the band prints the new accountable from the Host's own committed result, and retires that line once the projection stops agreeing with it. The Host's transfer activity row still records the move in the feed — the band's line is the same fact at the control, not a second authority over it.

That page renders the Host's two slices. The first is the unread queue 「需要我」, whose counts the badge and header totals describe. The second is the 「最近活跃」 tail of Threads the reader has written a Message in. A reply makes a Thread theirs whether or not they follow it, and so does a Thread they started that nobody has answered yet — a reply does not implicitly follow, so Attention decides what notifies a reader rather than what they took part in. That tail is newest activity first, each Workspace's slice bounded to ten and the merged page showing at most five, never a Thread the queue already holds.

Neither slice names an archived Project's Threads: archival ends participation as well as notification. An Agent's Inbox receives the queue alone. Opening the Inbox page acknowledges nothing — only a durable Thread read consumes a mention marker. `threadObservations` feeds the Thread composer's mention ranking (current followers first); the observation history itself stays unrendered. Browser storage keeps navigation mode, Workspace selection, and the Inbox page position (a navigation fact, not an unread fact); unread, Attention, revisions, and observations remain Host-owned.

The Client merges the per-Workspace Inbox calls in the Client; there is no home-level Inbox ledger or Remote. Each call asks for the whole unread slice — `directCount` per row and `totalUnreadCount` for the badge — and the merged result feeds both the badge and the Inbox page.

## Team Member context boundary
The explicit `team-member` preset contains coding tools, background jobs, the skill loader tool, compaction, all seven Team tools, Workspace instruction discovery, and private-memory context. Harness `agent-instructions` remains the sole loader for `AGENTS.md`/`CLAUDE.md`. Each Member private root has `memory.md`, `notes/`, and `skills/`; only a bounded 16 KiB escaped reference index is injected, and the block states its current usage as `X.X KiB / 16 KiB` with a percentage. Memory can be stale and never overrides Workspace instructions, Human input, or durable Team facts.

Do not store credentials, sensitive data, guesses, chat logs, or facts already owned by the ledger.

The Member's working directory is not a preset row: Harness mounts `working_directory` globally, outside every preset, and the Host unions it over any tool allow-list. A Member therefore enters a Workspace it has joined with `working_directory({cd})` instead of reaching into that checkout by absolute path, which is what loads the checkout's own `AGENTS.md`. Directory changes grant no participation, Claim, or write permission; each operation is authorized in the selected Workspace. [Memory and context](memory-and-context.md) describes category updates and memory baselines.

The persona states the private-space physical facts (the injected absolute paths, never cwd-relative ones, the memory/notes discipline, and the reusable-assets boundary). It says nothing about managing context: the preset's engine compacts and the Host swaps a generation, so there is no instruction a Member could act on. Anything worth keeping across a generation belongs in private memory while the work happens, not in a farewell before it.

All skill craft — what deserves to be a skill, directory-form layout, writing quality, credentials — lives in the bundled `member-skill-manager` meta skill, whose description routes skill-management work to itself. Loading any skill stays the Member's own judgment per task.
