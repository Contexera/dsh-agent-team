---
name: team-event-loops
description: How a Team keeps moving without being asked — a subscription discovers external change, a reminder schedules a Member's later judgment, and Team messages carry responsibility, evidence and exceptions. Read when designing or explaining a recurring check, an external trigger, a handoff, or a loop that should escalate; when a subscription or reminder is proposed; or when a Team seems to poll, over-discuss, or miss change.
---

# Team event loops

A Team that moves only when the Human speaks depends on the Human to notice change. A loop lets a continuing responsibility notice change and act without a new instruction; it is worth its wake cost only with a real source, a recipient who can act, a response and an escalation boundary. A Team without a loop is intact; its change arrives through people.

## The three carriers

| Carrier | What it is for | What it is not |
| --- | --- | --- |
| **Subscription** (`team_subscription`) | A Project observes an external system — GitHub, monitoring, HTTP, an internal service — and publishes deduplicated facts to its Main stream. | Not a private timer, a Task, or a replacement for judgment. |
| **Reminder** (`team_reminder`) | A Member asks to be woken later to judge again: a periodic health check, a deadline, a follow-up. | Not an owner privilege, a way to schedule another Member, or a background job. |
| **Message** (`team_message`, replies) | Responsibility, evidence, decisions and exceptions move to the Member who must act or know. | Not a status broadcast, a private channel for decisions, or a substitute for a Task or a Claim. |

A **Task** records a responsibility and how its work ends — accepted, closed, or still open; a **Worker** is one bounded execution. Neither is a loop: a loop decides *when* to look, a Task decides *what* is owed.

## Design a loop

1. **Name the fact and its source.** What change matters, where it is observable, and how a stable identity separates a new fact from one seen again. A loop with no real source is a status poll.
2. **Name the recipient and the owner.** Who must judge or act, and which Project owner answers. A subscription's `notify` decides who is woken; it does not make every owner a recipient, and `[]` wakes nobody.
3. **Name the response.** What the recipient does with the fact: judge, open a Task, delegate a Worker, reply, or deliberately do nothing. "Look at it" is not a response, a daily "any updates?" message is not a loop, and pulling several people into a discussion one owner could settle is worse than no loop. Prefer the least wake that carries the judgment.
4. **Name the verification, scaled to risk.** What check shows the response worked, and who performs it: a low-risk recurring judgment can be checked against the evidence the loop reads; a consequential one needs another Member or the Human.
5. **Name the escalation boundary.** What condition means the loop cannot resolve the issue — a threshold, repeated failure, a Human-only decision — and who is told.


## Subscription knowledge

A subscription is a Project-owned script the Host runs on a timer, a webhook, or both, with no Session. Its output is UTF-8 JSON Lines — `id` and `title` required, `url` and `detail` optional; known ids deduplicate, and changing the id rule republishes old facts.

- **Shape**: polling (`intervalMinutes`, at least 5) for a bounded snapshot or periodic recovery; webhook (`webhook: true`) when the provider can push — its address is shown once when armed, so register it in the same turn; both when push needs recovery. Use one stable identity across both paths.
- **Identity**: a provider event id, or a business object id plus announced state; never poll time, Host attempt, or array position.
- **Recipients**: `notify` names the Members whose Inbox the event reaches, as `memberRef`, `@Handle`, or the Human; omitted on create it is the creating Member, omitted on update it keeps the stored set, and `[]` is timeline-only. Non-recipients still read it in the Main stream.
- **Trial and baseline**: a create or update runs the script once and refuses a failing trial; a new subscription ignores the trial's ids unless you pass `ignore-history`.
- **Failure**: three failed live runs in a row pause the subscription. `logs` shows runs, with failure detail for owners and the Human. `deliveries` lists spent webhook deliveries, and `replay` runs one again without counting as a failure — but a paused subscription refuses runs and replays, so fix the cause, verify it with `test`, `resume`, then replay.
- **Secrets**: credentials are declared by reference (`TOKEN=STATUS_TOKEN`), never embedded; the script must not print credentials, signatures, webhook URLs or raw envelopes.

The manager has no `team_subscription` tool: design the trigger, identity, recipient and failure path with the owner, then route the write.

## Reminder knowledge

A reminder is a time promise bound to one Member, not a Session: it reaches that Member's Inbox when due and wakes it. Only the Member creates or cancels its own; the Human can withdraw one from Member detail.

- **Shapes**: `once` with an ISO 8601 instant; `every` in whole minutes, at least 10; `cron` with five fields in the fixed Team zone UTC+8.
- **Bounds**: at most 50 active per Member; a recurring reminder never fires closer than 10 minutes; the note is at most 2,000 characters and is what the occurrence carries.
- **Delivery**: an occurrence missed while the Host was down is made up once; an unread occurrence of a recurring reminder is replaced by the next instead of stacking; a suspended Member keeps timing and receives on resume; archival cancels every reminder.
- **Use**: a reminder is for the Member's own later judgment, not for scheduling someone else. If the work must survive a conversation, it needs a Task or a Thread, not a reminder.

Design it with the Member who owns it; the manager has no `team_reminder` tool.

## Message knowledge

Team messages carry responsibility, evidence and exceptions. A mention or linked reply wakes that Member once; an ordinary Thread or Main stream message reaches its followers; a new Task does not notify Main stream followers, who find it on the board.

Send the smallest message that lets the recipient act: the decision, evidence, exception and what is asked. A DM carries no task work or decision, and past about three exchanges the exchange moves to a Thread. Name the owner who must act instead of repeating a status to every owner, and do not forward a subscription event its `notify` Members already received.

The manager has no `team_message` or `team_dm` tool. Route the message to the Project owner or Member who should send it, or to the Human's Web surface.

## Reading a loop's health

- **No new events** is a fact only when a run shows the source was read successfully — a passing run, an explicit empty result, a fresh heartbeat. Without that evidence silence is **cannot see**: a missing credential, a failed run, a paused subscription, an unreadable source. Never report the second as the first.
- A failing subscription is a design problem before a retry problem: fix the source, identity or credential, then resume and replay.
- A reminder that fires and finds nothing to do once is a prompt to reconsider, not proof of over-scheduling: judge it over several occurrences and by whether the recurring judgment still changes a decision; if it never does, tighten the question or widen the interval.
- A loop that only produces discussion has no response; give it an owner, a Task, or a decision boundary.

## Worked shapes

- **External release signal**: a subscription polls the release API for a new tag, publishes `release:<tag>` to the owner, who judges compatibility and opens a Task or delegates a Worker; the Human decides the release date.
