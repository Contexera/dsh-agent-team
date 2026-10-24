# Mutation fences and boundaries

English | [中文](boundaries.zh.md)

## Mutation fences
Existing-Thread public mutations require the current next-write token in `baseRevision` — an opaque copy-through value, not a fact about the Thread. The model copies the latest explicitly rendered value verbatim and never increments, derives, compares, or cites it. The token appears on exactly two surfaces: a `team_thread read` that leaves no unread remaining, and a committed public mutation (`team_message` start/reply, `team_task` mutation) whose result returns the resulting Thread state.

It is absent from `team_view`, `team_inbox`, `team_thread status/follow/unfollow/history`, `team_task list`, partial reads, and every typed rejection — a fresh-looking token there would invite a blind retry.

Host checks: (1) relevant unread must be read, otherwise `unread_required`; (2) the token must match the current Thread revision, otherwise `stale_revision`; (3) closed Tasks reject replies, Claims, and new Attention. Taskless Threads have no Claim or Task-resolution mutation. These are normal collaboration outcomes, not infrastructure failures; there is no force-send or unread bypass.

An exemption sits inside check (1) and only there. When every unread fact is already on the writer's model-visible surface in full, the write is allowed without a read — the notice that carried the body is itself the reading.

The exemption persists nothing: no attention watermark advances, no direct marker is consumed, and the durable "has this been read" answer stays exactly what it was. One fact off the surface keeps the write refused, and a Member with no live Session is never exempt. A rejected mutation still renders no bypass: it carries the facts that gated the write and the current revision to retry with, and recovery is read the Thread and reconsider.

Human close releases active Claims and ends Attention. Reopen restores an open Task but not previous Attention periods.

## Human Remote boundary
The Human Client uses `readThread`, `threadHistory`, `threadObservations`, `changeAttention`, and `changes`, and it consumes the Host's Human Inbox slice as the 「收件箱 / Inbox」 queue. That is one Inbox call per visible Workspace — the whole unread slice, `directCount` per row and `totalUnreadCount` for the badge — merged across Workspaces into the badge and the Inbox page.

That page renders the Host's two slices. The first is the unread queue 「需要我」, whose counts the badge and header totals describe. The second is the 「最近活跃」 tail of Threads the reader has written a Message in. A reply makes a Thread theirs whether or not they follow it, and so does a Thread they started that nobody has answered yet — a reply does not implicitly follow, so Attention decides what notifies a reader rather than what they took part in. That tail is newest activity first, each Workspace's slice bounded to ten and the merged page showing at most five, never a Thread the queue already holds.

Neither slice names an archived Project's Threads: archival ends participation as well as notification. An Agent's Inbox receives the queue alone. Opening the Inbox page acknowledges nothing — only a durable Thread read consumes a mention marker. `threadObservations` feeds the Thread composer's mention ranking (current followers first); the observation history itself stays unrendered. Browser storage keeps navigation mode, Workspace selection, and the Inbox page position (a navigation fact, not an unread fact); unread, Attention, revisions, and observations remain Host-owned.

The Client merges the per-Workspace Inbox calls in the Client; there is no home-level Inbox ledger or Remote.

## Team Member context boundary
The explicit `team-member` preset contains coding tools, background jobs, the skill loader tool, compaction, all seven Team tools, Workspace instruction discovery, and private-memory context. Harness `agent-instructions` remains the sole loader for `AGENTS.md`/`CLAUDE.md`. Each Member private root has `memory.md`, `notes/`, and `skills/`; only a bounded 16 KiB escaped reference index is injected, and the block states its current usage as `X.X KiB / 16 KiB` with a percentage. Memory can be stale and never overrides Workspace instructions, Human input, or durable Team facts.

Do not store credentials, sensitive data, guesses, chat logs, or facts already owned by the ledger.

The Member's working directory is not a preset row: Harness mounts `working_directory` globally, outside every preset, and the Host unions it over any tool allow-list. A Member therefore enters a Workspace it has joined with `working_directory({cd})` instead of reaching into that checkout by absolute path, which is what loads the checkout's own `AGENTS.md`. Participation, Claims, and write permissions stay bound to the creation Workspace; only the directory moves.

The persona states the private-space physical facts (the injected absolute paths, never cwd-relative ones, the memory/notes discipline, and the reusable-assets boundary). It says nothing about managing context: the preset's engine compacts and the Host swaps a generation, so there is no instruction a Member could act on. Anything worth keeping across a generation belongs in private memory while the work happens, not in a farewell before it.

All skill craft — what deserves to be a skill, directory-form layout, writing quality, credentials — lives in the bundled `member-skill-manager` meta skill, whose description routes skill-management work to itself. Loading any skill stays the Member's own judgment per task.
