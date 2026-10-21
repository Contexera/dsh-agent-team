# Seven-tool protocol

English | [中文](tools.zh.md)

Successful and rejected tool results return through the normal model loop. There is no context tool: a Member cannot roll its generation over, record an anchor, or compact in place on its own. The engine compacts an oversized Session in place, and the Host recycles a cold generation at its wake boundary (see [`memory-and-context.md`](memory-and-context.md)).

## `team_view`

`team_view` is the address book: bounded authorized Channel, top-level Thread, and Member summaries — current addresses, not a work queue; unread work lives in `team_inbox`. Threads are the sole paginated catalog. Rows are newest-first and carry threadRef, Channel ref, a bounded anchor subject, and Task standing inline on taskful Threads (Task ref, number, status/resolution) — never a second Task index, and never revision or message count, because neither changes the next legal action.

An `active task threads` section follows the Members list on the first page. It lists every in_progress / in_review Task Thread in the reader's authorized Channels of the Workspace, newest activity first, each row carrying its threadRef, Channel ref, status, Task number, the Members on its live Claims, a bounded anchor subject, and last-activity instant.

Its admission is the Task being active, not the reader's participation, and a Thread still holding the reader's unread is not excluded — it answers "who is already on what" independently of the unread queue. The tool guidance points the reader here when a Workspace change surprises them, or before they claim or commit, so in-flight work reads as such instead of a conflict; it is not the unread queue, which stays in `team_inbox`.

The cursor pages Thread rows only; continuation pages render Threads alone, and paging reaches every authorized top-level Thread, including taskless and off-page taskful ones. The footer calls the value a Thread cursor and says whether older Thread anchors remain.

## `team_inbox`

`team_inbox` lists bounded body-free unread Thread summaries. Direct requests sort before ordinary unread, then by newest relevant sequence; listing does not mark read. The header states the total unread and direct counts and the number of Threads shown, with a truncation conclusion when unread work lies beyond the bounded list; each row shows its exact unread and direct counts, Channel ref, and Task standing when taskful. This is the reader's own unread queue; to see work others have in flight regardless of unread, use the active-task-threads section of `team_view`.

The footer routes body reading and acknowledgement to `team_thread read`; the render carries no revision and no write token — a current read is the required mutation basis, and it supplies the token.

## `team_thread`

`team_thread` reads one Thread. `threadRef` is primary; `taskRef` is a compatibility alias for released task-only Clients on taskful Threads.

`read` returns one chronological unread batch and advances the watermark. A read with nothing unread for its reader advances nothing and writes no operation, and an identical retry of a committed read returns that read's original receipt with a picture derived from the current projection, because a read has never promised a frozen answer. `history` pages older facts. `message` reads one Message back verbatim by its ref, which is the way to answer a quote whose original sits outside the page you hold.

`beforeSequence` and `limit` are history-only parameters. `read` drains unread and cannot page, so any other action carrying them is refused with the `action: history` route.

The three actions share no maximal render: reading shows the Thread, and only reading does. There is no Attention action here, because Attention is a different question with a different parameter pocket — see `team_attention`.

`message` renders the ref, the sequence with its instant and sender, and then the body whole: this one action exists so a reader can answer a Message it did not receive, so nothing is trimmed and the orientation is unchanged.

A read renders five parts in order, then a footer:

1. the outcome — acknowledged and remaining unread counts;
2. Thread identity and following state;
3. orientation — the full anchor when the returned facts carry Host-supplied background, the bounded anchor subject otherwise, and never a duplicate when the anchor is itself a returned fact;
4. active Claims only — the current collision surface, one line per Claim (claim ref, owner, direction);
5. the chronological facts with inline unread/direct markers.

The footer states the read-through sequence and the remaining unread count.

When the read left Thread facts behind it, a further line states how many those are, so a returning reader sees the size of the span it is not looking at instead of assuming the batch is the Thread.

A history page renders a historical outcome with Thread identity, the full anchor on a first page and the bounded subject on continuation pages, the selected facts, and the cursor/hasMore footer — never current Claims or a context recommendation. Every activity fact is structured — actor, Task ref, and the Claim refs an activity claimed, completed, accepted, or released — never a bare kind.

A `read` acknowledges an unread acceptance of a still-done Task in its facts and recommends nothing about the reader's context: with no rollover tool and no generation choice, there is no action for a read to state.

## `team_attention`

`team_attention` answers one question — am I following this Thread, and should I be? `status` reports the current state and changes nothing; `follow` starts receiving the Thread's updates; `unfollow` stops them. All three take the same parameters: the Thread address and the routing Workspace. `threadRef` is primary, with `taskRef` as the compatibility alias.

Attention is not reading. None of these actions render the Thread's facts, acknowledge unread work, or hand off a write token, and reading a Thread never changes whether you follow it. The result shape carries the address, the Task standing, and the following state — and nothing else, so an Attention result cannot drift into showing Thread content.

The split from `team_thread` is what makes the read path carry no Attention logic at all: the three actions share one parameter pocket instead of borrowing a read pocket with three parameters (`messageRef`, `beforeSequence`, `limit`) they can never accept.

`status` produces no semantic boundary — it reports and changes nothing, the same rule `list` follows on Claims and `read` follows on Threads. A successful `follow` or `unfollow` anchors one boundary.

## `team_message`

`team_message.start` creates a top-level Thread and defaults taskless; explicit task intent atomically creates a Task. `reply` appends to an existing Thread. Both accept absolute attachment paths; Host validates and caches all paths atomically. A committed start or reply renders one committed-verb outcome — Thread created or reply added — with the Message ref, the new Thread ref (and Task ref when taskful), and exactly one next-write token hand-off. The created Thread is immediately addressable and the next mutation has its basis.

Typed rejection results (`unread_required`, `stale_revision`) begin `Not committed` and keep the structured refs and counts needed to reread and retry deliberately. They also render the facts that gated the write — the unread batch for `unread_required`, the increment past the obsolete token for `stale_revision` — in the same shape a `team_thread read` returns them, and hand back the current revision as the next write token. A rejected writer learns what changed and which token to use from the rejection itself, and the retry commits with no intervening read.

Recovery is still read-and-reconsider: the rejection's facts are the gate, not a substitute for acknowledging them. A mention of a Member the Thread has never carried is not a rejection: the Message commits and the result reports the undelivered names.

Every rejection — a typed result, a thrown parameter-shape error, or a Host refusal — names the next action and the value that action takes, and those words come from one registry (`packages/agent-team/src/recovery-hints.ts`) rather than from each call site. The registry is enforced, not advisory: a test walks the model-facing sources of both the Host and the tool package and refuses a route sentence written outside the registry, so a new rejection cannot ship with a fault the model has no way out of.

`reply` also takes `replyToMessageRef`, which names the Message on this Thread being answered. The Host resolves it against the ledger and refuses a ref that is unknown or belongs to another Thread, so a stored reply always has a parent a reader can be taken to.

The link is recorded on the Message, renders as a quote the reader can follow back, and adds the parent's author to the recipients — answering a peer reaches them the way a mention does, without repeating their handle. The Human is never added, because they read the Thread directly.

The switch on the Team row's settings decides whether the parameter is available at all; with it off, a reply that carries a ref is refused.

## `team_dm`

`team_dm` sends a private direct message to one enabled Agent Member in the same Workspace. It takes a `memberRef` and a `body` and nothing else — no Thread, no Task, no write token, and no attachments — because a DM addresses a person rather than a conversation. A stray parameter is refused rather than ignored, so a model that reached for a Thread write's shape meant a Thread reply and gets told so.

A DM is pure delivery: the ledger appends an audit-only `team/dm-sent` operation (request-idempotent) while the recipient's live session receives the body as a relay-form injected user message — idle recipients get a new turn, busy ones are steered into the current turn. DMs create no Channel, Thread, revision, Attention, or Inbox markers and wake no change waiters. The Human cannot be DMed.

The first line of every result says which of the two it was: delivered, or recorded without a live session to wake. There is no automatic redelivery, so a recorded-only DM is never blindly resent.

Use DMs for quick clarifications and status syncs only. Task work, decisions, and anything needing team visibility or traceability belong in Threads, and an exchange passing about 3 round trips should move to a Thread because each DM costs the recipient a full agent turn.

## `team_claim`

`team_claim` lists and mutates only the Agent's own Direction Claims on real Tasks. Taskless Threads have no Claim mutation. A Direction is one sentence describing the Agent's angle; plans and acceptance checklists belong in Thread messages. A successful Claim starts Attention. `list` renders the Task/Thread identity with the active collision surface — active Claims only, or an explicit none — and no write token, because a current `team_thread read` remains the required mutation basis.

A committed mutation names its action (Claim created, completed, or released), renders the authoritative affected Claim first — ref, resulting state, owner, direction — then Task/Thread identity, and exactly one next-write token hand-off. Rejection results (`unread_required`, `stale_revision`) share the message rejection form: `Not committed`, local refs/counts, the facts that gated the write, read-before-retry recovery, and the current revision as the next write token.
