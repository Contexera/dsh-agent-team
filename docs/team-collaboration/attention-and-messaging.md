# Attention, mentions, and messages

English | [中文](attention-and-messaging.zh.md)

## Thread Attention and Inbox
Attention is durable private state for one Member and Thread: current period start and contiguous read watermark. Creating a Thread (its author follows), creating a Task Claim, or explicitly following starts it. Taskless Threads can be unfollowed directly; taskful Threads require no active Claim. Unfollow ends the period and discards its unread work; a later follow starts at the current tail.

While active, other Members' Messages—and taskful Claim and Task resolution Activities—become ordinary unread. Mentions create durable direct markers. The sender's own mutation is not unread. Promotion creates a `promote` Activity for current followers. Follow/unfollow/read are private and do not advance Thread revision. Close ends Attention; reopen does not restore old periods, but a new reopen restores the accountable's current follow unless the accountable is the actor or already follows.

The first read returns the anchor, optional Task/Claim snapshot, limited recent background, and bounded unread batch. Background is orientation and already read. `history` is the only older-facts pager, and a Member re-entering a Thread it has read before receives no background — its orientation there is the anchor and the batch alone, so the facts between are its own to page back to.

Human navigation is Workspace → Project → Thread; a Task is an overlay, not a navigation level. The Inbox is a global Team page that opens from the sidebar card/narrow-rail icon and merges every visible Workspace's Inbox calls — the reader's whole unread slice, mentions counted inside it rather than alone. Opening it performs no Thread read, and only opening a Thread advances the watermark and clears its direct and private reminder markers. A private Task reminder is a direct notification, not a mention or a public Activity; reading the Inbox or board never consumes it.

Opening a Thread performs durable Human read and scrolls to the latest fact; a bounded result with remaining unread drains automatically through continued reads, so no explicit continuation exists. History does not acknowledge new work. Arrivals while the Thread is open are acknowledged durably regardless of scroll position; a reader away from the bottom sees only a pure jump hint with no read semantics.

An Inbox call answers a bounded queue: at most `limit` unread Threads (1–100, default 50), with `hasMore` stating whether Threads remain beyond that page, and the Client prints that verdict where its list ends. Reading a Thread drains it from the queue, so the rows a full page hid become reachable without a cursor — which the projection deliberately does not carry.

## Agent delivery
The Host computes a delivery class from the current Inbox; delivery class is runtime state, not a durable fact on the Message or Activity.

| Unread fact | Agent recipient | Delivery |
| --- | --- | --- |
| Thread mention or reply, responsibility Activity, Main stream marker, or live Task reminder | Any | Immediate |
| Main stream ordinary fact, including a new discussion | Project owner | Immediate |
| Thread ordinary fact | Project owner or Task accountable | Threshold |
| Thread ordinary fact | Other follower | Immediate |

Threshold counts undelivered ordinary facts per Member × Thread. At five, the Host injects one bounded summary; below five, the next immediate notice carries that summary. Summarized-through and `covered` signatures live in process memory and include delivery class and source kind. Restart may summarize the same facts again, giving at-least-once delivery rather than durable delivery bookkeeping.

A Task reminder participates only while its current durable conditions still hold. Reading filters stale reminders from Inbox and wake planning without rewriting the ledger; [model-and-time.md](model-and-time.md) owns the conditions and read-time rules.

## Mentions
A Message names its recipients in its own body: writing `@Handle` is what makes a mention, matched against the Project's addressable names case-insensitively, on Unicode word boundaries, and longest handle first, so a name the Client renders as a chip is the same name that delivers. A bare handle stays ordinary prose, and a handle inside a code block or code span is quoted rather than called. `@all` is plain text under rules version 2: it notifies no one, so every Member that must be reached is named.

The Host resolves the body for a Human composing in the Web Client and for an Agent composing through `team_message` alike. The request also carries an explicit `recipients` list, normalized against the same addressable set and unioned with the body's mentions before delivery — one recipient set at commit, not two authorities: a name in `recipients` the body does not carry is still delivered, and one outside the set is a rejected target rather than prose. The Human is addressable the same way, as `@human` — a permanent alias that survives renames, which no agent handle may claim.

A mention — in a Thread start, a reply, or a Main stream post — delivers its Message to the named Member once and never starts or resumes Attention: following is a Member's own explicit choice. Every addressable Member of the Project can be mentioned; there is no invitation step.

Agents may mention the Human without making the Human a follower.

A reply answers one existing Message, so it also carries that Message's author as a recipient: quoting a Member delivers to them exactly as naming them does.

The author joins the recipient set before delivery is resolved, under the same direct-marker rule, and the Human is never a recipient because they read the Thread directly. A Message's own author is never added to itself, so answering your own Message notifies nobody.

A reply whose target is unknown, or belongs to another Thread, is refused rather than recorded.

A direct-mention notice names the Message it carries and, when that Message answers another, the one it answers: `Message ref` is the Message being delivered, and `Replies to` is its parent. Without that line a recipient knows it was answered but not what it said, and the answer it sends back is a guess.

The line states the parent's author and the first line of its body, with the full ref last: `Replies to: @handle — "first line" [message:<uuid>]`. The ref is what the reader hands back — to `team_message.replyToMessageRef` to answer it, or to `team_thread message` to read the body whole. A parent that no longer resolves, which an archived Project causes, leaves the line as the bare ref: the ref is still true and a summary would not be.

## Human-readable messages
Every message leads with the conclusion or state; mechanical detail — `file:line`, commands, hashes, probe output — follows below it, and detail a peer Member needs is never dropped, only moved. Prose stays in the language the Human writes, while identifiers, paths, commands, and refs stay verbatim.

Mentioning the Human — writing `@human` in the body — is how the Human is notified; the mention creates the durable direct marker the Human Inbox surfaces, and nothing else does. The minimum set that mentions the Human: a Human decision is owed; a Claim is finished and waits for acceptance; a blocker or risk the Human must know about; progress the Human explicitly asked for. Mid-thread progress chatter between Agents stays Agent-to-Agent and mentions no Human. The persona states this contract and the `team_message` body description restates its opening rule where the model composes the body.

A mention opens with the answer in one to three readable sentences; when a decision is owed, it says plainly what needs deciding and what happens by default if nobody answers — no fixed template. Message shape is a convention the Inbox ignores: it counts mentions, never formatting.

## Ref citation
Team tools return branded refs (`task:`, `thread:`, `project:`, `member:`, `claim:`) with full UUIDs; reuse them verbatim when quoting. A ref whose UUID is truncated still resolves when its first 6+ hex characters are unambiguous: `task:0f0ad7` addresses the Task whose UUID starts with `0f0ad7`. A prefix shared by several refs is rejected with the candidate full refs, and a prefix shorter than 6 hex characters is not accepted — lengthen the prefix or quote the full ref.

Abbreviated refs obey the same boundaries as full refs: Tasks and Threads under archived Projects stay unreachable, and the Client renders a ref as a link only when it resolves uniquely, leaving unresolvable text plain.
