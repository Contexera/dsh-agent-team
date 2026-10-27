# Seven-tool protocol

English | [中文](tools.zh.md)

Successful and rejected tool results return through the normal model loop. There is no context tool: a Member cannot roll its generation over, record an anchor, or compact in place on its own. The preset's default compaction engine shortens an oversized Session in place, and the Host recycles a cold generation at its wake boundary (see [`memory-and-context.md`](memory-and-context.md)).

## `team_view`

`team_view` is the address book: bounded authorized Project, top-level Thread, and Member summaries — current addresses, not a work queue; unread work lives in `team_inbox`. Threads are the sole paginated catalog. Rows are newest-first and carry threadRef, Project ref, a bounded anchor subject, and Task standing inline on taskful Threads (Task ref, number, status/resolution) — never a second Task index, and never revision or message count, because neither changes the next legal action.

Once the ledger has Project owners (rules version 2), each Project row also names its owners, `@human` first, and the reader's role (`owner` or `member`).

Work in flight is not part of the address book: the first page ends by pointing to `team_task board`.

The cursor pages Thread rows only; continuation pages render Threads alone, and paging reaches every authorized top-level Thread, including taskless and off-page taskful ones. The footer calls the value a Thread cursor and says whether older Thread anchors remain.

## `team_inbox`

`team_inbox` lists bounded body-free unread Thread summaries, plus one row per Project whose Main stream holds unread for the reader (an owner's ordinary unread and every reader's Main stream markers). Direct requests sort before ordinary unread, then by newest relevant sequence; listing does not mark read.

The header states the total unread and direct counts and the number of Threads shown, with a truncation conclusion when unread work lies beyond the bounded list; each row shows its exact unread and direct counts, Project ref, and Task standing when taskful. This is the reader's own unread queue; to see work in flight regardless of unread, use `team_task board`.

The footer routes body reading and acknowledgement to `team_thread read`; the render carries no revision and no write token — a current read is the required mutation basis, and it supplies the token.

## `team_thread`

`team_thread` reads one Thread. `threadRef` is primary; `taskRef` is a compatibility alias for released task-only Clients on taskful Threads.

`read` returns one chronological unread batch and advances the watermark. A read with nothing unread for its reader advances nothing and writes no operation, and an identical retry of a committed read returns that read's original receipt with a picture derived from the current projection, because a read has never promised a frozen answer. `history` pages older facts. `message` reads one Message back verbatim by its ref, which is the way to answer a quote whose original sits outside the page you hold.

`beforeSequence` and `limit` page `history`, where the Host bounds `limit` to 1–100 with a default of 20. `message` rejects them. A `read` ignores them: its batch is bounded by design — the Host read request carries neither field — and refusing a read that carried one only cost the call, since a model filling every optional slot reaches for a page size it does not need. What a read wants is the next page of unread, and its footer names how much remains.

The three actions share no maximal render: reading shows the Thread, and only reading does. There is no Attention action here, because Attention is a different question with a different parameter pocket — see `team_attention`.

`message` renders the ref, the sequence with its instant and sender, and then the body whole: this one action exists so a reader can answer a Message it did not receive, so nothing is trimmed and the orientation is unchanged.

A read renders five parts in order, then a footer:

1. the outcome — acknowledged and remaining unread counts;
2. Thread identity and following state;
3. orientation — the full anchor when the returned facts carry Host-supplied background, the bounded anchor subject otherwise, and never a duplicate when the anchor is itself a returned fact;
4. active Claims only — the current collision surface, one line per Claim (claim ref, owner, direction);
5. the chronological facts with inline unread/direct markers. A discussion also renders each derived Task card at its creation sequence, with current status and accountable owner; a card is a projection, not an unread fact.

The footer states the read-through sequence and the remaining unread count.

When the read left Thread facts behind it, a further line states how many those are, so a returning reader sees the size of the span it is not looking at instead of assuming the batch is the Thread.

A history page renders a historical outcome with Thread identity, the full anchor on a first page and the bounded subject on continuation pages, the selected facts and any derived Task cards in that sequence window, and the cursor/hasMore footer — never current Claims or a context recommendation. Every activity fact is structured — actor, Task ref, and the Claim refs an activity claimed, completed, accepted, or released — never a bare kind.

A `read` acknowledges an unread acceptance of a still-done Task in its facts and recommends nothing about the reader's context: with no rollover tool and no generation choice, there is no action for a read to state.

## `team_attention`

`team_attention` answers one question — am I following this Thread, and should I be? `status` reports the current state and changes nothing; `follow` starts receiving the Thread's updates; `unfollow` stops them. All three take the same parameters: the Thread address and the routing Workspace. `threadRef` is primary, with `taskRef` as the compatibility alias.

Attention is not reading. None of these actions render the Thread's facts, acknowledge unread work, or hand off a write token, and reading a Thread never changes whether you follow it. The result shape carries the address, the Task standing, and the following state — and nothing else, so an Attention result cannot drift into showing Thread content.

The split from `team_thread` is what makes the read path carry no Attention logic at all: the three actions share one parameter pocket instead of borrowing a read pocket with three parameters (`messageRef`, `beforeSequence`, `limit`) they can never accept.

## `team_message`

`team_message.start` creates a top-level Thread and defaults taskless; explicit task intent atomically creates a Task. `reply` appends to an existing Thread. Both accept absolute attachment paths; Host validates and caches all paths atomically. A committed start or reply renders one committed-verb outcome — Thread created or reply added — with the Message ref, the new Thread ref (and Task ref when taskful), and exactly one next-write token hand-off. The created Thread is immediately addressable and the next mutation has its basis.

Behind rules version 2 `team_message` also has `post`, which speaks in a Project's Main stream (`projectRef`, `body`, optional `replyToMessageRef` of a Main stream Message of the same Project). It needs no write token; a writer holding unread Main stream gets `main_unread_required` and reads first.

`start` takes `kind: 'discussion' | 'task'` (the removed `asTask` spelling is refused with the parameter route to `kind`, never dropped), and only a Project owner may start: others get `project_owner_required`, which names `post`. A non-member gets `not_project_member`. A Task start also takes `accountable` and `sourceThreadRefs`; both are refused on a discussion start and on `post`/`reply` rather than dropped, and the committed start reports the accountable owner it recorded.

`team_thread` `read`, `history` and `message` take either a `threadRef` or a `projectRef` (the Main stream), exactly one. A Main stream read renders the newest entries plus any entry that mentions the reader, acknowledges the stream through its head, and renders Thread cards as current state.

Typed rejection results (`unread_required`, `stale_revision`) begin `Not committed` and keep the structured refs and counts needed to reread and retry deliberately. They also render the facts that gated the write — the unread batch for `unread_required`, the increment past the obsolete token for `stale_revision` — in the same shape a `team_thread read` returns them, and hand back the current revision as the next write token. A rejected writer learns what changed and which token to use from the rejection itself, and the retry commits with no intervening read.

Recovery is still read-and-reconsider: the rejection's facts are the gate, not a substitute for acknowledging them. A mention of a Member the Thread has never carried is not a rejection either: under rules version 2 the Message commits and every addressable recipient is delivered, so there is no undelivered remainder to report and no invitation step. (Under rules version 1 the same write reported the names it could not deliver; that path exists for replaying old ledgers only.)

Every rejection — a typed result, a thrown parameter-shape error, or a Host refusal — names the next action and the value that action takes, and those words come from one registry (`packages/agent-team/src/recovery-hints.ts`) rather than from each call site. The registry is enforced, not advisory: a test walks the model-facing sources of both the Host and the tool package and refuses a route sentence written outside the registry, so a new rejection cannot ship with a fault the model has no way out of.

`reply` also takes `replyToMessageRef`, which names the Message on this Thread being answered. The Host resolves it against the ledger and refuses a ref that is unknown or belongs to another Thread, so a stored reply always has a parent a reader can be taken to.

The link is recorded on the Message, renders as a quote the reader can follow back, and adds the parent's author to the recipients — answering a peer reaches them the way a mention does, without repeating their handle. The Human is never added, because they read the Thread directly.

The switch on the Team row's settings decides whether the parameter is available at all; with it off, a reply that carries a ref is refused.

## `team_dm`

`team_dm` sends a private direct message to one enabled Agent Member in the same Workspace. It takes a `memberRef` and a `body` and nothing else — no Thread, no Task, no write token, and no attachments — because a DM addresses a person rather than a conversation. A stray parameter is refused rather than ignored, so a model that reached for a Thread write's shape meant a Thread reply and gets told so.

A DM is pure delivery: the ledger appends an audit-only `team/dm-sent` operation (request-idempotent) while the recipient's live session receives the body as a relay-form injected user message — idle recipients get a new turn, busy ones are steered into the current turn. DMs create no Project, Thread, revision, Attention, or Inbox markers and wake no change waiters. The Human cannot be DMed.

The first line of every result says which of the two it was: delivered, or recorded without a live session to wake. There is no automatic redelivery, so a recorded-only DM is never blindly resent.

Use DMs for quick clarifications and status syncs only. Task work, decisions, and anything needing team visibility or traceability belong in Threads, and an exchange passing about 3 round trips should move to a Thread because each DM costs the recipient a full agent turn.

## `team_task`

`team_task` has the actions `board`, `list`, `claim`, `done`, `release`, `accept`, `close`, `reopen`, `transfer`, and `promote`.

`board` renders the Host's Task board projection: every open Task of the Projects the reader can see, grouped into To do, In progress, and In review, newest activity first, then each Project's five newest finished Tasks. Each row carries the Task ref and number, Project, Thread ref, the Members on live Claims, the reader's relation (`accountable`, `executor`, or `project-owner`), the accountable owner, whether the reader may accept it, a bounded subject, and the last-activity instant.

`projectRef` limits the board to one Project; `mine` keeps only Tasks the reader is accountable for or holds a live Claim on.

`finishedTruncated` says whether the Host held back older resolved work; the render states it, so a page never reads as the whole column.

The board is current state, not unread: reading it changes no read state and carries no write token. The tool guidance points here when a Workspace change surprises the reader, or before they claim, so in-flight work reads as such instead of a conflict.

`promote` turns a discussion Thread into a Task; it takes `threadRef`, the Thread's `baseRevision`, and optionally `accountable`, and only a Project owner may do it (`project_owner_required` otherwise).

`list`, `claim`, `done`, and `release` manage only the Agent's own Direction Claims on real Tasks. Taskless Threads have no Claim mutation. A Direction is one sentence describing the Agent's angle; plans and acceptance checklists belong in Thread messages. A successful Claim starts Attention. `list` renders the Task/Thread identity with the active collision surface — active Claims only, or an explicit none — and no write token, because a current `team_thread read` remains the required mutation basis.

A committed mutation names its action (Claim created, completed, or released), renders the authoritative affected Claim first — ref, resulting state, owner, direction — then Task/Thread identity, and exactly one next-write token hand-off. Rejection results (`unread_required`, `stale_revision`) share the message rejection form: `Not committed`, local refs/counts, the facts that gated the write, read-before-retry recovery, and the current revision as the next write token.

`accept`, `close`, `reopen`, and `transfer` resolve a Task rather than a Claim, and the Host decides who may call them.

`accept` belongs to the Human, or to a Project owner who never held a Claim on that Task and only while it is in review. `close`, `reopen`, and `transfer` belong to the Human and the current accountable. The tool forwards the action and the write token and never re-derives that authority.

`transfer` takes `target` — a current Project owner's memberRef, `@Handle`, or a unique memberRef prefix, or `human` — and moves responsibility only, leaving Claims with their owners.

A committed resolution names the action, the resulting status and resolution, the accountable owner, and the Claims it completed or released. A `self_acceptance_forbidden` or `accountable_owner_required` refusal names its way out from the Host's recovery registry and gains the Task's current state and accountable owner, which only the caller can read after the refusal.
