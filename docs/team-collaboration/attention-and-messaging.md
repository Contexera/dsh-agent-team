# Attention, mentions, and messages

English | [中文](attention-and-messaging.zh.md)

## Thread Attention and Inbox
Attention is durable private state for one Member and Thread: current period start, contiguous read watermark, and what established the period. Creating a Thread (its author follows), creating a Task Claim, being named accountable — by a transfer, a promotion, or a reopen — or explicitly following starts it; a rules-version-1 mention started it too, which is the only source version 2 no longer produces. Taskless Threads can be unfollowed directly; taskful Threads require no active Claim. Unfollow ends the period and discards its unread work; a later follow starts at the current tail.

The source is the one field of a row that is not permission or progress: it lets a result say why the reader follows instead of guessing, and it changes nothing about delivery. [tools.md](tools.md) owns what each result renders; a row written before the field existed has its cause derived from the operation that wrote it, which [host-authority.md](../architecture/host-authority.md) records.

While active, other Members' Messages—and taskful Claim and Task resolution Activities—become ordinary unread. Mentions create durable direct markers. The sender's own mutation is not unread. Promotion creates a `promote` Activity for current followers. Follow/unfollow/read are private and do not advance Thread revision. Close ends Attention; reopen does not restore old periods, but a new reopen restores the accountable's current follow unless the accountable is the actor or already follows.

A closed Task's Thread still takes a follow: closing leaves the follower set empty, and following is how a reader gets back into it. It is the only Attention row such a Thread can still create; the Task's own resolution and the Human's transfer of a finished Task are the other writes that still reach it.

`read` returns orientation as well as unread work. When the reader's current context no longer holds the discussion, it returns the anchor when missing plus the Message facts among up to four preceding facts, skipping background already fully visible; this can happen on any read, not only the first. Background is orientation, not newly acknowledged work. `history` is the only older-facts pager, and `message` reads one Message back verbatim; neither acknowledges unread work. [tools.md](tools.md) owns the full read contract.

Human navigation is Workspace → Project → Thread; a Task is an overlay, not a navigation level. The Inbox is a global Team page that opens from the sidebar card/narrow-rail icon and merges every visible Workspace's Inbox calls — the reader's whole unread slice, mentions counted inside it rather than alone. Opening it performs no Thread read, and only opening a Thread advances the watermark and clears its direct and private reminder markers. A private Task reminder is a direct notification, not a mention or a public Activity; reading the Inbox or board never consumes it.

Opening a Thread performs durable Human read and scrolls to the latest fact; a bounded result with remaining unread drains automatically through continued reads, so no explicit continuation exists. History does not acknowledge new work. Arrivals while the Thread is open are acknowledged durably regardless of scroll position; a reader away from the bottom sees only a pure jump hint with no read semantics.

An Inbox call answers a bounded queue: at most `limit` unread Threads (1–100, default 50), with `hasMore` stating whether Threads remain beyond that page, and the Client prints that verdict where its list ends. Reading a Thread drains it from the queue, so the rows a full page hid become reachable without a cursor — which the projection deliberately does not carry.

Both Thread faces render one follow control: its pressed state is read from the Host's current follower set asked about the Human's own Member id, the write goes through the Human `changeAttention` Remote, and the control never optimistically flips, so a refused write leaves the previous standing on screen with its failure beside the control. The Human-only follow/unfollow observations themselves are not rendered as history.

That set is every Member whose Attention is on the Thread, so the control's question is never "is anyone following?": a set holding other Members reads as not followed exactly as an empty one does. The id comes from the Host's own projection, and until it arrives the control's standing stays unanswered rather than guessing one — a guess would let another Member's Attention be read as the Human's. The same set still ranks the composer's mention candidates whole, which is why the fix reads one row out of it instead of replacing it.

The standing is re-read from the Host, not decided once. Every observation the control receives becomes the standing, so a change another face or another client makes reaches the button without the Human touching it. A write's requestId serves one answer and is then dropped, scoped to the action and the Thread: a cached id would make the Host answer the next write from its idempotency cache with the earlier result, leaving the button claiming a standing the Host's follower set does not hold.

The control says its standing before it says its action. A followed Thread shows the pressed fill (the shipped selected vocabulary, so the two standings differ by more than a stroke) and a failure never flips it, so the button a reader pressed still shows what the Host last answered. Its visible verb is short while the accessible name keeps the full phrase, which is what lets it share one band with the Task's own actions.

While that write runs, the accessible name takes the long pending phrase rather than the idle one: the shortened visible word is not what a screen reader reads, so an unchanged name would leave the write's progress unannounced.

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

Direct signals rank ahead of ordinary work across every scope. Missing direct Messages, Task/Claim Activities, and reader-targeted ownership Activities come first, newest first across Threads and Main. Ordinary Messages, Activities, and non-owner subscription events form one digest per scope: its header keeps the total and newest time, up to three latest entries appear oldest first with an actor/action or 240-character excerpt, and earlier entries become an overflow count. Main digests name their Project. Every fact appears once — expanded, digested, or overflowed.

A direct fact already complete on the Session surface follows as an identity line marked `already in current context; still unread`, which binds nothing further. Delivery intent is not Session output, so a notice queued but not yet read cannot make its own facts visible. Reply identities retain their reply target and excerpt. Task reminders follow as detail and join the explicit direct-signal warning if omitted; ordinary digests and Main stream Thread cards come last.

The eight-Thread scope cap and the twenty-detail cap apply only after that rank, so a newer direct signal cannot lose its scope to an older ordinary update. Main stream scopes do not consume the Thread cap, and each ordinary digest group consumes one detail slot.

The whole notice, a recovery instruction included, is limited to 32,768 UTF-16 code units, with 2,048 held back for the mandatory omission and next-step routes. When direct signals are dropped, one warning states their total, names up to four scope routes plus a count of any others, and points to `team_inbox` and `team_thread read`; it never expands every route.

## Main stream Attention

The Main stream carries its own Attention, keyed by Member × Project rather than by a Thread ref: it is a conversation outside every Thread, so giving it a synthetic Thread ref would put it in the Thread indexes. Thread Attention and Main stream Attention are two independent rows for the same Member, each with its own read watermark.

| Who | Main stream Attention |
| --- | --- |
| The Human | Derived, never stored: it starts at the Project's creation, and only the read watermark is stored |
| A Member granted Project ownership | Written by the grant itself, starting at the grant sequence — no historical backlog is inherited |
| Any other Member | Absent until it follows; then it starts at the current tail |

The Human's derived Main stream Attention is mandatory and cannot be unfollowed; it starts with the Project and stores only its read watermark. Agent Members can follow or unfollow their Main stream Attention explicitly.

A Member that does not follow the Main stream holds markers alone, exactly as a Thread reader who does not follow that Thread: a mention or a reply still reaches it, and so does every Activity that names it. Following does not double-count a marker it already holds. Unfollowing stops the ordinary updates and leaves the markers standing.

Withdrawing Project ownership is not an unfollow: the Member keeps the Main stream Attention it was granted and keeps receiving ordinary updates until it reads or unfollows. Only the owner privilege is gone. Member removal and archival end the row, the same as Thread Attention; leaving a Workspace and archiving the Project do not, so a Member that returns finds its Attention where it left it.

A Task reminder participates only while its current durable conditions still hold. Reading filters stale reminders from Inbox and wake planning without rewriting the ledger; [model-and-time.md](model-and-time.md) owns the conditions and read-time rules.

## Mentions
A Message names its recipients in its own body: writing `@Handle` is what makes a mention, matched against the Project's addressable names case-insensitively, on ASCII word boundaries, and longest handle first — an address stays prose, while CJK prose can call a handle directly, so a name the Client renders as a chip is the same name that delivers. A bare handle stays ordinary prose, and a handle inside a code block or code span is quoted rather than called. `@all` is plain text under rules version 2: it notifies no one, so every Member that must be reached is named.

The Host resolves the body for a Human composing in the Web Client and for an Agent composing through `team_message` alike. The body is the sole delivery authority: the request carries no recipient list, and the names it mentions are the entire recipient set, plus the parent's author on a reply. A name the body does not carry is not delivered, and naming a Member outside the addressable set leaves that text as prose rather than delivery. The Human is addressable the same way, as `@human` — a permanent alias that survives renames, which no agent handle may claim.

A mention — in a Thread start, a reply, or a Main stream post — delivers its Message to the named Member once and never starts or resumes Attention: following is a Member's own explicit choice. Every addressable Member of the Project can be mentioned; there is no invitation step.

Agents may mention the Human without making the Human a follower.

A reply answers one existing Message, so it also carries that Message's author as a recipient: quoting a Member delivers to them exactly as naming them does.

The parent Message's author joins the recipient set before delivery is resolved, under the same direct-marker rule, including the Human. Replying to your own Message does not add you as a recipient; explicit mentions still deliver normally.

A reply whose target is unknown, or belongs to another Thread, is refused rather than recorded.

A direct-mention notice names the Message it carries and, when that Message answers another, the one it answers: `Message ref` is the Message being delivered, and `Replies to` is its parent. Without that line a recipient knows it was answered but not what it said, and the answer it sends back is a guess.

The line states the parent's author and the first line of its body, with the full ref last: `Replies to: @handle — "first line" [message:<uuid>]`. The ref is what the reader hands back — to `team_message.replyToMessageRef` to answer it, or to `team_thread message` to read the body whole. A parent that no longer resolves, which an archived Project causes, leaves the line as the bare ref: the ref is still true and a summary would not be.

## Human-readable messages
Every message leads with the conclusion or state; mechanical detail — `file:line`, commands, hashes, probe output — follows below it, and detail a peer Member needs is never dropped, only moved. Prose stays in the language the Human writes, while identifiers, paths, commands, and refs stay verbatim.

Writing `@human` in the body notifies the Human through a durable direct marker in their Inbox, as does linking a reply to their Message. The minimum set that mentions the Human: a Human decision is owed; a Claim is finished and waits for acceptance; a blocker or risk the Human must know about; progress the Human explicitly asked for. Agent-to-Agent progress chatter mentions no Human. The persona owns this cross-tool writing rule; the `team_message` body description keeps only the call format and delivery rules where the model composes the body.

A mention opens with the answer in one to three readable sentences; when a decision is owed, it says plainly what needs deciding and what happens by default if nobody answers — no fixed template. Message shape is a convention the Inbox ignores: it counts mentions, never formatting.

## Ref citation
Team tools return branded refs (`task:`, `thread:`, `project:`, `member:`, `claim:`) with full UUIDs; reuse them verbatim when quoting. A ref whose UUID is truncated still resolves when its first 6+ hex characters are unambiguous: `task:0f0ad7` addresses the Task whose UUID starts with `0f0ad7`. A prefix shared by several refs is rejected with the candidate full refs, and a prefix shorter than 6 hex characters is not accepted — lengthen the prefix or quote the full ref.

Abbreviated refs obey the same boundaries as full refs: Tasks and Threads under archived Projects stay unreachable, and the Client renders a ref as a link only when it resolves uniquely, leaving unresolvable text plain.

## Subscription events

A published subscription event is a Main stream record of its own kind, not a Message: it names the Project, the subscription, and what the script printed. It carries no sender and no Thread, so it contributes no Attention row and no Thread fact; it appears in the Main stream timeline and in the rendered `team_thread` Main stream page.

Delivery is a marker, frozen at the publish commit for every owner the Project had at that moment, the Human included. An owner that stopped following the Main stream still receives it, and so does an owner that is suspended: the marker waits for them. A non-owner that follows the Main stream sees the event as ordinary unread; a Member with no row at all sees only its own markers.

The title, link, and detail are external text a script printed: no mention is parsed from them, no Markdown is rendered, and every surface states that they are data rather than instructions — the model-facing render marks the event as untrusted, and the Client shows the same warning in its own words. Reading the Main stream consumes the markers by the same rules as every other marker, and several events collapse into one notice by the replace-don't-stack rule rather than accumulating.
