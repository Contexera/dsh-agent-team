# Eight-tool protocol

English | [中文](tools.zh.md)

Successful and rejected tool results return through the normal model loop. `context_rollover` and `context_checkpoint` conclude the Agent turn — a rollover must not be followed by old-generation work, and a checkpoint resolves at its containing turn's end; every other Team tool does not.

## `team_view`

`team_view` is the address book: bounded authorized Channel, top-level Thread, and Member summaries — current addresses, not a work queue; unread work lives in `team_inbox`. Threads are the sole paginated catalog: rows are newest-first and carry threadRef, Channel ref, a bounded anchor subject, and Task standing inline on taskful Threads (Task ref, number, status/resolution) — never a second Task index, and never revision or message count, because neither changes the next legal action.

An `active task threads` section follows the Members list on the first page: every in_progress / in_review Task Thread in the reader's authorized Channels of the Workspace, newest activity first, each row carrying its threadRef, Channel ref, status, Task number, the Members on its live Claims, a bounded anchor subject, and last-activity instant.

Its admission is the Task being active, not the reader's participation, and a Thread still holding the reader's unread is not excluded — it answers "who is already on what" independently of the unread queue. The tool guidance points the reader here when a Workspace change surprises them, or before they claim or commit, so in-flight work reads as such instead of a conflict; it is not the unread queue, which stays in `team_inbox`.

The cursor pages Thread rows only; continuation pages render Threads alone, and paging reaches every authorized top-level Thread, including taskless and off-page taskful ones. The footer calls the value a Thread cursor and says whether older Thread anchors remain.

## `team_inbox`

`team_inbox` lists bounded body-free unread Thread summaries. Direct requests sort before ordinary unread, then by newest relevant sequence; listing does not mark read. The header states the total unread and direct counts and the number of Threads shown, with a truncation conclusion when unread work lies beyond the bounded list; each row shows its exact unread and direct counts, Channel ref, and Task standing when taskful. This is the reader's own unread queue; to see work others have in flight regardless of unread, use the active-task-threads section of `team_view`.

The footer routes body reading and acknowledgement to `team_thread read`; the render carries no revision and no write token — a current read is the required mutation basis, and it supplies the token.

## `team_thread`

`team_thread` owns Attention and reading. `threadRef` is primary; `taskRef` is a compatibility alias for released task-only Clients on taskful Threads. `read` returns one chronological unread batch and advances the watermark; a read with nothing unread for its reader advances nothing and writes no operation, and an identical retry of a committed read returns that read's original receipt with a picture derived from the current projection, because a read has never promised a frozen answer; `history` pages older facts; follow/unfollow change personal Attention.

The five actions do not share one maximal render: `status`, `follow`, and `unfollow` answer only the Attention question — one outcome line with the Thread ref, optional Task standing, and following state, no timeline.

A read renders outcome first (acknowledged and remaining unread counts), then Thread identity and following state, then orientation (the full anchor when the returned facts carry Host-supplied background, the bounded anchor subject otherwise, and never a duplicate when the anchor is itself a returned fact), then active Claims only — the current collision surface, one line per Claim (claim ref, owner, direction) — then the chronological facts with inline unread/direct markers, and a footer stating the read-through sequence and the remaining unread count.

When the read left Thread facts behind it, a further line states how many those are, so a returning reader sees the size of the span it is not looking at instead of assuming the batch is the Thread.

A history page renders a historical outcome with Thread identity, the full anchor on a first page and the bounded subject on continuation pages, the selected facts, and the cursor/hasMore footer — never current Claims or advice. Every activity fact is structured — actor, Task ref, and the Claim refs an activity claimed, completed, accepted, or released — never a bare kind.

When a `read` acknowledges an unread acceptance of a still-done Task, the result carries a `contextAdvice` section: the reading Member's measured usage, the route's budgets, the Task-boundary threshold `min(128_000, effective handoffAt)`, and one action — keep the current context, roll over fresh after the closeout, or compact in place at the handoff budget. Advice is a recommendation only: the Host never checkpoints, rolls over, or compacts on an acceptance, and a measurement failure degrades to an explicit `unavailable` line instead of reversing the committed read.

History and repeat reads carry no advice.

## `team_message`

`team_message.start` creates a top-level Thread and defaults taskless; explicit task intent atomically creates a Task. `reply` appends to an existing Thread. Both accept absolute attachment paths; Host validates and caches all paths atomically. A committed start or reply renders one committed-verb outcome — Thread created or reply added — with the Message ref, the new Thread ref (and Task ref when taskful), and exactly one next-write token hand-off, so the created Thread is immediately addressable and the next mutation has its basis.

Typed rejection results (`unread_required`, `stale_revision`) begin `Not committed`, keep the structured refs and counts needed to reread and retry deliberately, and render no numeric revision and no write token — a rejection carries no changed facts and is not a safe mutation basis; recovery is read-and-reconsider. A mention of a Member the Thread has never carried is not a rejection: the Message commits and the result reports the undelivered names.

`team_message.dm` sends a private direct message to one enabled Agent Member in the same Workspace. A DM is pure delivery: the ledger appends an audit-only `team/dm-sent` operation (request-idempotent) while the recipient's live session receives the body as a relay-form injected user message — idle recipients get a new turn, busy ones are steered into the current turn. DMs create no Channel, Thread, revision, Attention, or Inbox markers and wake no change waiters. The Human cannot be DMed.

If the recipient has no live session or the wake fails, the operation stays durable and the sender gets a structured delivery error instead of a silent loss; there is no automatic redelivery. Use DMs for quick clarifications and status syncs only — task work, decisions, and anything needing team visibility or traceability belong in Threads, and an exchange passing about 3 round trips should move to a Thread because each DM costs the recipient a full agent turn.

## `team_claim`

`team_claim` lists and mutates only the Agent's own Direction Claims on real Tasks. Taskless Threads have no Claim mutation. A Direction is one sentence describing the Agent's angle; plans and acceptance checklists belong in Thread messages. A successful Claim starts Attention. `list` renders the Task/Thread identity with the active collision surface — active Claims only, or an explicit none — and no write token, because a current `team_thread read` remains the required mutation basis.

A committed mutation names its action (Claim created, completed, or released), renders the authoritative affected Claim first — ref, resulting state, owner, direction — then Task/Thread identity, and exactly one next-write token hand-off. Rejection results (`unread_required`, `stale_revision`) share the message rejection form: `Not committed`, local refs/counts, read-before-retry recovery, and no numeric revision.

## `context_rollover`

`context_rollover` schedules one rollover of the calling Member into a fresh context. The Agent passes a private `handoff` (plus optional `relatedFiles`, or a `checkpointRef` to return to a recorded checkpoint instead). The `checkpointRef` is copy-hardened on both the tool and parameter descriptions: omit it for ordinary generation changes and pressure-driven handoffs, and supply it only when citing the exact ref a `context_status` result listed as restorable — never a synthesized or guessed one.

The tool only validates and returns `status: 'scheduled'` after concluding the turn — it performs no lifecycle or Inbox side effect in the tool body.

The Host reacts only after the successful `tool/result` is durably appended: it waits for the containing turn and true idle, commits one idempotent `team/member-session-rolled-over` operation (Member actor, self-scoped, recording previous/new Session ids, the successful handoff result sequence, and trigger — never handoff prose), disposes the old Agent, archives the old Session, and activates a fresh Session with the handoff as its first model-facing context. Member identity, model, private memory, skills, Claims, and Attention survive.

Without a `checkpointRef` the new Session inherits no old event/chunk history; with one it seeds the recorded checkpoint's exact completed-turn prefix (marked seeded, its inherited history inert) — the ledger never records handoff prose. Non-Team input that arrived after the intent is carried into the new generation once; stale Team Inbox notices are discarded and rederived from the ledger.

A failed or dangling call schedules nothing, and a landed failed result consumes its paired open call in the projection — a provider retry reusing the same call id folds its own fresh arguments, never the failed call's stale ones.

A `checkpointRef` return is prevalidated at tool time through the same resolver the swap uses: a ref that is fabricated, unresolved, unattributable, nonshrinking, unmeasurable, over-budget, or blocked by multiple active Claims rejects as a model-visible error result instead of a fake `scheduled` whose async swap always fails.

The mutable guard set (jobs, route limits, lineage growth) is revalidated at the lifecycle commit seam, so a rollover that passes tool-time validation can still fail there and leave the old generation recoverable — a later-turn fresh rollover replaces the spent intent and recovers the Member.

Request and new-Session identity derive stably from the calling Member's bound Session plus the tool call id, so a crash between result durability and the swap replays to the same generation.

A rollover is refused while the Member owns jobs that would not survive the switch — any running/stopping job, and any settled job whose terminal output was never reported; the rejection names the jobs and directs the Member to collect or stop them first.

A restart that lands between the durable rollover commit and the new Session's activation reconstructs the handoff from the previous Session's durable intent instead of treating the Member as blank: the ledger's recorded previous Session is the lineage source even when the new Session never materialized before the crash, and reconstruction is idempotent — a generation whose own log already carries a handoff never receives a second one.

## `context_checkpoint`

`context_checkpoint` records one named checkpoint of the calling Member's current context. Like `context_rollover` it performs no lifecycle side effect in the tool body: the durable checkpoint is the successful `tool/call`+`tool/result` pair the Session projection folds, and the returned ref is deterministic from the Member Session identity plus the tool call id, so the model can cite it before the result exists and a repeated provider call id in another generation never collides.

The checkpoint resolves at its containing turn's end, so the model records it as the final action of a completed unit of work; after the turn the Host schedules one quiet continuation message so the Member can keep working toward the recorded anchor. Delivery is exactly-once across restarts: the projection's delivery record is durable, and a checkpoint whose continuation already landed is never re-scheduled.

## `context_status`

`context_status` returns one bounded structural view of the Member's context generations across the current Session and its archived ancestor lineage: recorded checkpoints (with the completed turn each anchors to, and whether its quiet continuation was delivered), plus handoff, Team-boundary, and compaction boundaries — each with the Threads whose facts entered the Member's context by that anchor, derived only from delivered Session facts, never from unread ledger activity.

It reports the Member's usage against the handoff budget and the hard limit, and — where the Member's preset scope can price one — what a compaction started now would replace.

The definition is the engine's (`createContinuityTools`), not the Team's: the Team supplies the adapter behind it and the glossary it splices into the description, so the surface and the engine's own copy cannot drift apart.

A fresh `context_rollover` (no `checkpointRef`) never requires reading the status first; the status is for picking a checkpointRef return or confirming that a fresh handoff is the better path.

Team boundaries anchor on effect, not push: a committed `team_message` (a start's Thread is attributed from the durable presentation meta of its result, a reply's from its call arguments), a successful `team_claim` mutation, and a successful follow/unfollow each anchor one boundary, labeled by action class (`Team message`, `Team task claim change`, `Team attention change`); a typed rejection (`unread_required`, `stale_revision`), a failed call, a dm, or the read path (`team_inbox`, `team_view`, `team_thread read`) never does.

On the push side, only a Thread's FIRST delivered notice anchors — the preserved "work just arrived" anchor, labeled with the Thread refs it first introduced (`First arrival: …`) instead of the notice's own generic account — while later re-deliveries of the same Thread and pure reminders (recovery notices, and the progress-nudge notices recorded before that system was removed) produce nothing.

A Team boundary is a selectable default checkpoint exactly when the retained prefix through it stays inside one Thread — exactly one Thread's facts entered the Member's context by that anchor — and the return would shrink the working set below the handoff budget; Thread attribution comes from delivered notice bodies, claim mutations' Task overlays resolved through the ledger, and committed message calls' refs, and a prefix that spans several Threads (or holds none) carries its reason instead.

The rule is judged on the retained prefix, never on the boundary's own contribution, which is the same proof `context_rollover` revalidates before it seeds a generation. Default-boundary refs are session-scoped, so consecutive generations anchoring at the same event seq never collide. Structural only — no transcript content.

Every row is rendered by the engine. On a row that is not restorable the Team answers with a short stable `anchor` digest of that row's own ref instead of the ref itself: rows that share a name and a price stay distinguishable, and no non-selectable row ever carries a citable string — only the `ref` printed on a restorable row may be cited to `context_rollover`.

A `context_rollover` call with a `checkpointRef` rolls the Member back to that checkpoint's exact completed-turn prefix: the seed is the durable prefix through the checkpoint's `turn/end`, balanced by construction, and the child Session parents at the seed source while inherited checkpoints stay inert history (no inherited intent fires in the child).

Return is rejected under the same conditions the `context_rollover` tool prevalidates — unresolved, nonshrinking, over-budget, or multiple active Claims (a rewind cannot be proven to stay inside one Thread); in every rejection case a fresh handoff is the documented alternative. A context return re-reads history; it never claims to revert external effects.

Seed costs are priced from the source Session's own replayed measurement — a source whose cost cannot be measured is not selectable (the budget cannot be proven); the discarded figure for an ancestor anchor approximates the current generation's whole usage. When an ancestor cannot be read, the walk stops there and the result carries `incompleteFrom` (the ancestor's id and the failure reason): history is complete through the last listed source and provably absent beyond it, which is a fact about history, never about Member availability.

## `context_compact`

`context_compact` shortens the calling Member's current generation in place: the engine replaces one stretch of older history with a summary and keeps the Member's newest work verbatim. It never switches generation and never returns to an anchor — `context_rollover` owns both.

The Team answers the engine's two questions about that stretch from the Member's own preset scope: which compaction engine serves it, and what its surface costs. The same meter the pressure policy reads prices the range, so what a compaction replaces and what a `context_status` promised cannot disagree.

A Member whose preset mounts no compaction engine is told the capability is not available in this scope — never a silent no-op — and a context with nothing safe to replace reports that this context is unchanged.
