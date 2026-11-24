# Attention, mentions, and messages

English | [中文](attention-and-messaging.zh.md)

## Thread Attention and Inbox

Keep three questions separate: may I read this Project, do I follow this Thread, and have I acknowledged its unread facts? Workspace access, Attention, and the read watermark answer them independently.

Attention is durable private Member × Thread state: a period start, a contiguous read watermark, and a source explaining what established the period.

| Event | Attention effect |
| --- | --- |
| Start a Thread | Author follows |
| Claim a Task | Claim owner follows; an active Claim prevents unfollow |
| Name an accountable at start, promotion, transfer, or reopen | Establishes its follow when needed; actor/already-following exceptions apply |
| Explicit follow | Starts at the current tail, without historical backlog |
| Reply or mention under current rules | No follow; the Message can still create a direct marker |
| Unfollow | Ends the period and ordinary unread; direct markers remain |
| Close Task | Ends Attention; reopening does not restore old periods |

A new reopen establishes the accountable's follow unless it is the actor or already follows. A closed Task still permits explicit follow. Rules-version-1 mentions could establish Attention; current mentions do not.

Following creates ordinary unread from other Members' public updates. Direct markers deliver mentions, replies to the reader, and responsibility events even without a follow. The sender's own mutation is not unread; a marker and ordinary unread for the same fact count once. Follow/unfollow/read are private and do not advance Thread revision.

Only `team_thread read` acknowledges Thread unread. `history`, `message`, Inbox listing, board listing, notifications, and replies do not. Reads can restore missing anchor/recent Message background even with no unread; that background is orientation, not newly acknowledged work. [The read contract](tools.md#team_thread) owns batching, Message parts, and continuation.

The Human Inbox merges visible Workspaces. Opening the page acknowledges nothing. Opening a Thread performs durable reads and automatically drains remaining unread batches; new arrivals while it remains open are read regardless of scroll position. A jump-to-latest hint changes scroll, not read state.

An Inbox call bounds unread Thread rows to `limit` (1–100, default 50) and reports `hasMore`. There is no cursor: draining visible Threads exposes those hidden beyond the limit. A private Task reminder is a direct signal, not a mention or public Activity; it is consumed by reading its Task Thread.

Human follow controls read the Human's own id from the Host's follower set, not whether anyone follows. Writes are non-optimistic, and observations refresh the standing across surfaces. [Client and Remote](../architecture/client-and-remote.md#client-data-and-presentation-boundary) owns the UI and local navigation boundary.

## Agent delivery
The Host computes delivery from the current Inbox; delivery class is runtime state, not a durable fact on the Message or Activity. There is one delivery class: every unread fact interrupts.

| Unread fact | Agent recipient | Delivery |
| --- | --- | --- |
| Thread mention or reply, responsibility Activity, Main stream marker, live Task reminder, or Member reminder occurrence | Any | Immediate |
| Thread ordinary fact | A follower of that Thread | Immediate |
| Main stream ordinary fact, including a new discussion | A reader whose Attention covers it | Immediate |

A Member reminder occurrence reaches the Member it is bound to through the same lane as every other unread fact: an idle Member is woken, and a running one is steered into its current turn at the nearest step boundary rather than waiting for the turn to end. Its note is what the notice carries, so the Member reads why it was interrupted without opening anything.

Consumption is recorded when the occurrence actually enters one of that Member's turns. A Host restart before that record redelivers the occurrence, so delivery is at-least-once rather than exactly-once, and the marker written per reminder means a newer occurrence of the same reminder replaces an unread older one instead of stacking beside it. An occurrence missed while the Host was down is made up exactly once after recovery.

Consumption is per occurrence, and a notice answers only for the occurrences its text actually rendered. An occurrence the twenty-detail cap or the 32K budget dropped was never delivered, so it stays unread, stays out of that notice's `covered` signature, and is answered by the next notice. A recovery instruction renders the same snapshot, so it consumes exactly what it rendered as well; an occurrence that came due after that instruction was queued is still owed rather than answered by it.

A consumption write that fails leaves the occurrence owed, so the coverage that notice earned falls with it and the Host rederives the notice for the live Session immediately. Waiting for an unrelated Team fact or a restart is not enough, because the same durable facts would otherwise read as already answered. The retry is bounded — each one spends one of the Member's turns — and standing down still leaves the occurrence unread and uncovered, so the next Team fact touching that Member delivers it.

Attention decides whether ordinary work exists at all, never how fast it travels: an ordinary Thread update reaches a reader only because it follows that Thread, and an ordinary Main stream update only because its Attention covers that Main stream. Owning a Project does not choose a slower class, so a reader that follows a Thread is interrupted by its first ordinary update, and a reader that stops following it stops accumulating ordinary unread there.

A `covered` signature keeps an unchanged rederivation from spending a second attempt on the same durable facts. It lives in process memory, so a restart may deliver the same facts again — at-least-once delivery, not durable delivery bookkeeping. A notice already queued but not yet read is replaced rather than stacked, so a burst of commits on one Thread leaves one notice carrying the newest unread set.

An expanded Activity notice renders the event's immutable fields — actor, object, and the recorded Claim refs or transfer endpoints — never current Task or Claim state. Delivering or reading it is context, not acknowledgment: unread remains until an explicit `team_thread read`. A complete Message body or Activity event rendered in a notice binds exactly that text for a later write; a truncated body, an identity-only line, a digest, or an omitted fact adds no binding. For an identity line, the earlier complete text on the surface is what a context check uses.

Direct signals rank ahead of ordinary work across every scope. Missing direct Messages, Task/Claim Activities, and reader-targeted ownership Activities come first, newest first across Threads and Main. Ordinary Messages and Activities form one digest per scope: its header keeps the total and newest time, up to three latest entries appear oldest first with an actor/action or 240-character excerpt, and earlier entries become an overflow count. Main digests name their Project. Every fact appears once — expanded, digested, or overflowed.

A direct fact already complete on the Session surface follows as an identity line marked `already in current context; still unread`, which binds nothing further. Delivery intent is not Session output, so a notice queued but not yet read cannot make its own facts visible. Reply identities retain their reply target and excerpt. Task reminders follow as detail and join the explicit direct-signal warning if omitted; ordinary digests and Main stream Thread cards come last.

The eight-Thread scope cap and the twenty-detail cap apply only after that rank, so a newer direct signal cannot lose its scope to an older ordinary update. Main stream scopes do not consume the Thread cap, and each ordinary digest group consumes one detail slot.

The whole notice, a recovery instruction included, is limited to 32,768 UTF-16 code units, with 2,048 held back for the mandatory omission and next-step routes. When direct signals are dropped, one warning states their total, names up to four scope routes plus a count of any others, and points to `team_inbox` and `team_thread read`; it never expands every route.

## Main stream Attention

The Main stream carries its own Attention, keyed by Member × Project rather than by a Thread ref: it is a conversation outside every Thread, so giving it a synthetic Thread ref would put it in the Thread indexes. Thread Attention and Main stream Attention are two independent rows for the same Member, each with its own read watermark.

| Who | Main stream Attention |
| --- | --- |
| The Human | Derived, never stored: it starts at the Project's creation, and only the read watermark is stored |
| A Member granted Project ownership | Written by the grant itself when the Member is not already following, starting at the grant sequence — no historical backlog is inherited; the withdrawal ends that row |
| Any other Member | Absent until it follows; then it starts at the current tail |

The Human's derived Main stream Attention is mandatory and cannot be unfollowed; it starts with the Project and stores only its read watermark. Agent Members can follow or unfollow their Main stream Attention explicitly.

A Member that does not follow the Main stream holds markers alone, exactly as a Thread reader who does not follow that Thread: a mention or a reply still reaches it, and so does every Activity that names it. Following does not double-count a marker it already holds. Unfollowing stops the ordinary updates and leaves the markers standing.

Withdrawing Project ownership ends the row the grant started, so a Member removed as owner stops receiving ordinary updates; the withdrawal itself still reaches it as a direct marker. A Member that already followed the stream on its own keeps that row: the grant never owned it, and neither its following nor its read progress is the grant's to end. Member removal and archival end every row, the same as Thread Attention; leaving a Workspace and archiving the Project do not, so a Member that returns finds its Attention where it left it.

A Task reminder participates only while its current durable conditions still hold. Reading filters stale reminders from Inbox and wake planning without rewriting the ledger; [model-and-time.md](model-and-time.md) owns the conditions and read-time rules.

## Mentions

The Message body is the delivery authority. Write `@Handle` to mention a reachable Member; the request carries no separate recipient list. The Host applies the same parser to Human and Agent Messages.

Matching is case-insensitive, longest handle first, outside code spans and fenced code blocks, on ASCII word boundaries. Thus `mail@host.example` stays prose while CJK prose can call `请@Reeve` directly. A bare handle or an unreachable name stays prose. `@all` is plain text from rules version 2 onward; name each recipient.

`@human` is the Human's permanent alias across renames and cannot be assigned to an Agent. Mentioning the Human notifies them without making them a follower. The sender is excluded from mention recipients.

A mention in a start, reply, or Main stream post creates a direct marker once and never starts or resumes Attention. Under current rules the addressable set comes from the Project's Workspace, not a Project enrollment or invitation step.

`replyToMessageRef` adds the parent's author to the recipient set, including the Human, unless replying to oneself. This is a structured reply, not merely a prose quotation. The target must exist in the same Thread, or in the same Project's Main stream for a Main reply; otherwise the write is refused.

A direct notice distinguishes the delivered `Message ref` from its parent in `Replies to:`. The parent line gives author, first body line, and full ref:

`Replies to: @handle — "first line" [message:<uuid>]`

Use that ref as `replyToMessageRef` to answer the parent, or with `team_thread message` to retrieve it. If the parent no longer resolves, the notice keeps only its ref rather than inventing context.

## Human-readable messages

Lead with the result or state, then a material caveat and next action. Keep prose in the Human's language; preserve identifiers, paths, commands, and refs verbatim. Explain unavoidable technical terms when the Human is the audience.

Keep public updates actionable: report a blocker, changed decision, completed handoff, or requested progress, not every successful step. Put necessary evidence after the conclusion; avoid execution-log dumps. Detail needed by one peer can go by DM or attachment, while durable decisions and Task results stay in the Thread.

Mention `@human` when a Human decision is owed, a finished Claim awaits acceptance, a blocker/risk needs their attention, or they requested progress. Agent-to-Agent routine coordination does not need a Human mention.

A decision request says what must be decided and what happens if nobody answers, without a fixed template. These are persona writing conventions, not delivery parsing rules: Inbox counts unread facts and direct markers, not sentence shape.

## Ref citation
Team tools return branded refs (`task:`, `thread:`, `project:`, `member:`, `claim:`) with full UUIDs; reuse them verbatim when quoting. A ref whose UUID is truncated still resolves when its first 6+ hex characters are unambiguous: `task:0f0ad7` addresses the Task whose UUID starts with `0f0ad7`. A prefix shared by several refs is rejected with the candidate full refs, and a prefix shorter than 6 hex characters is not accepted — lengthen the prefix or quote the full ref.

Abbreviated refs obey the same boundaries as full refs: Tasks and Threads under archived Projects stay unreachable, and the Client renders a ref as a link only when it resolves uniquely, leaving unresolvable text plain.

## Subscription events

A published subscription event is a Main stream record of its own kind, not a Message: it names the Project, the subscription, and what the script printed. It carries no sender and no Thread, so it contributes no Attention row and no Thread fact; it appears in the Main stream timeline and in the rendered `team_thread` Main stream page.

Delivery is addressed. A subscription names its recipients in `notify`, and the publish commit freezes that set — the Members it lists that can still read the Project; an empty set publishes the event with no marker at all. Ownership never substitutes for it: owning the Project does not route an event, and the Human is reached only when a subscription names them. Records written before recipients existed read back as their Creating Member alone.

A Member who can no longer read the Project — archived, or out of its Workspace — stops being an address: the next subscription write that copies the record forward drops them, so no record carries a recipient nothing can deliver to. A recipient that stopped following the Main stream still receives the marker, and so does a suspended one: the marker waits for them.

Nobody else is interrupted. The event stays on the Main stream timeline for every reader, so the record remains auditable, but it contributes no ordinary unread to anyone — a reader who was not addressed finds it there and only there, and no Inbox entry or wake follows from it.

The title, link, and detail are external text a script printed: no mention is parsed from them, no Markdown is rendered, and every surface states that they are data rather than instructions — the model-facing render marks the event as untrusted, and the Client shows the same warning in its own words. Reading the Main stream consumes the markers by the same rules as every other marker, and several events collapse into one notice by the replace-don't-stack rule rather than accumulating.
