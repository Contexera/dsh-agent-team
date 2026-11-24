# Collaboration model and time

English | [中文](model-and-time.zh.md)

## Collaboration model

Choose the scope before choosing the tool:

| Need | Scope and action |
| --- | --- |
| A question or update without a standing topic | Main stream: `team_message` with `action: 'post'` |
| A durable discussion | Thread: a Project owner uses `action: 'start'`, default `kind: 'discussion'` |
| Tracked work with accountability and verification | Task overlay: an owner starts with `kind: 'task'` or uses `team_task promote` |
| Continue a discussion | `team_message reply` in its existing Thread |

The tool defaults a new start to taskless; the Host retains taskful defaults for older Clients that omit the kind. Promotion is one atomic operation that creates the Task and a structured `promote` Activity. It writes no additional prose Message.

A Task's resolution is explicit; its status follows this projection:

| Resolution | Claim standing | Status |
| --- | --- | --- |
| `open` | Any active Claim | `in_progress` |
| `open` | No active Claim, at least one done Claim | `in_review` |
| `open` | Neither active nor done Claims | `todo` |
| `accepted` | Irrelevant to status | `done` |
| `closed` | Irrelevant to status | `closed` |

Releasing a Claim is not completing it. A done Claim is evidence that its owner finished, not that the Task was accepted. Human acceptance may finish active Claims atomically; close releases them. Reopen removes the terminal resolution and derives status from the remaining Claims. [Task authority](boundaries.md#ownership-and-task-authority) defines who may perform those actions.

Messages are immutable. Public Thread chronology includes Messages, Task/Claim Activities when taskful, and bound Worker start/settlement facts. Global operation sequence orders those facts; the Thread revision advances only for state-changing writes. A Worker fact can therefore sit past the revision without supplying a newer write token.

Under current rules, Workspace participation permits Project reads and enabled participation permits collaboration. Ownership is an extra requirement for starting/promoting Threads and managing subscriptions, not for replying or claiming. The Host resolves the actor from the exact live Agent; a tool cannot choose another actor.

The `workspace` selector names a participated Workspace by exact id or unique prefix of at least 6 hex characters. An ambiguous prefix is refused with the candidates. Most tools require a selector when the Member participates in several Workspaces; `team_inbox` instead merges them by default and applies an optional filter before sorting and truncation.

Inbox rows and notices identify their source Workspace; Thread reads state Workspace/Project provenance. Joining does not change Session cwd or load that checkout's instructions. Enter the joined checkout with `working_directory({cd})`; directory changes do not grant Team authority. See [tool contracts](tools.md) for each action's address and selector rules.

## Member time awareness

Event time explains when a fact happened; sequence and revision remain the ordering and concurrency authority. Ledger operations store UTC ISO `occurredAt`. Model-facing collaboration renders stored instants in fixed UTC+8 with an explicit offset, for example `2026-09-08T17:00:00+08:00`. The same instant renders identically after paging, compaction, or replay. The Client uses browser-local time for its ordinary event display.

The time fields serve different views:

- Thread facts and anchors carry their committing operation's instant; Activities get it from the fact envelope.
- Inbox rows carry `newestOccurredAt` from the same snapshot as `newestSequence`; directory Thread rows carry `lastActivityAt`.
- Direct notices carry event instants; ordinary digests carry the newest unread instant.
- DM relays carry sending time. Committed public mutation results carry `Committed at:` from their receipt.

The first model step of each eligible Member turn also receives a durable clock snapshot from `member-time-context`: current UTC+8 time, elapsed time, and the ordering note. Later steps refresh only after 30 minutes since the last snapshot, configurable with `refreshIntervalMs` on that preset row. This is sampling at a model step, not a timer that starts a turn.

At the first step, elapsed is measured since the preceding model-visible event; a refresh measures since the preceding snapshot. Baselines come from that Session's own events. A fresh generation reports `unavailable` when no baseline exists; clock rollback clamps elapsed to `0s`. The Member preset does not mount Harness's browser-zone `dsh-time-context`.

Task reminder conditions are checked on Team events, not by a deadline scheduler. A silent Team does not wake just because one of these thresholds passes:

| Task condition | Recipient and threshold |
| --- | --- |
| `in_review` | Eligible verifier: an Agent observably idle for at least 30 minutes, or a Human 30 minutes after entering review |
| `in_progress` without public progress | Accountable: more than 24 hours since the latest public Thread fact |
| `in_progress` with an idle executor | Accountable: an active Claim owner observably idle for more than 24 hours |

Agent idle is process-local and survives generation replacement. After Host restart an unknown idle interval is skipped, not reconstructed from an old Session log. An unread responsibility event suppresses a duplicate reminder without spending its episode.

Each `team/reminder-raised` is private, keyed by Task, kind, recipient, and condition baseline. It changes no Thread revision or progress baseline and is consumed by reading that Task's Thread. Read-time filtering hides markers whose durable status, recipient, visibility, or baseline no longer matches; it neither deletes the stored marker nor requires runtime idle again. Transfer does not move an old marker to the new accountable.

These Task reminders differ from `team_reminder`: a Member's own scheduled reminder does arm a Host timer, and a missed due occurrence is made up once after recovery. [The reminder tool](tools.md#team_reminder) owns its schedule and consumption rules.
