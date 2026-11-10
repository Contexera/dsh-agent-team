# Nine-tool protocol

English | [中文](tools.zh.md)

Successful and rejected tool results return through the normal model loop. There is no context tool: a Member cannot roll its generation over, record an anchor, or compact in place on its own. The preset's default compaction engine shortens an oversized Session in place, and the Host recycles a cold generation at its wake boundary (see [`memory-and-context.md`](memory-and-context.md)).

## Optional argument slots

The Team schema accepts omitted optional fields. For models that fill unused slots, each tool normalizes only the values that carry no instruction for that action; this is not a blanket rule that empty strings, zero, `false`, or `[]` mean absent. The action sections below describe the exceptions. `null` is not an alternative: the declared string, number, boolean, and array types reject it before execution.

The [optional-slot matrix](../../packages/tool-agent-team/tests/optional-slot-matrix.spec.ts) covers every registered tool and action enum. It compares clean and filled calls at the Host boundary, including which operations were called and their payloads. Meaningful values such as a Worker's start engine, subscription recipients, and webhook removal are explicit baseline choices, not neutral placeholders.

## `team_view`

`team_view` is the address book: every active Project in the Workspace, top-level Threads from the reader's Project memberships, and the complete Workspace Member roster — current addresses, not a work queue; unread work lives in `team_inbox`.

Each Project row carries the reader's `owner` / `member` / `directory only` relation and active/paused subscription counts. Once the ledger has Project owners (rules version 2), it also names them, `@human` first. Directory-only discovery grants no Project content, write, Attention, or unread delivery. Subscription details remain with `team_subscription list` rather than expanding the directory into a dashboard.

Threads are the sole paginated catalog. Rows are newest-first and carry threadRef, Project ref, a bounded anchor subject, and Task standing inline on taskful Threads (Task ref, number, status/resolution) — never a second Task index, and never revision or message count, because neither changes the next legal action. Their section is explicitly scoped to the reader's Project memberships. A `projectRef` filter naming a directory-only Project returns its directory row but says Thread rows require membership instead of falsely reporting an empty Project.

Work in flight is not part of the address book: the first page ends by pointing to `team_task board` and subscription details to `team_subscription list`.

The cursor pages Thread rows only; continuation pages render Threads alone, and paging reaches every authorized top-level Thread, including taskless and off-page taskful ones. The footer calls the value a Thread cursor and says whether older Thread anchors remain.

## `team_inbox`

`team_inbox` lists bounded body-free unread Thread summaries, plus one row per Project whose Main stream holds unread for the reader (the ordinary unread its Main stream Attention covers, plus every reader's markers). Direct requests sort before ordinary unread, then by newest relevant sequence; listing does not mark read.

The header states the total unread and direct counts and the number of Threads shown, with a truncation conclusion when unread work lies beyond the bounded list; each row shows its exact unread and direct counts, Project ref, and Task standing when taskful. This is the reader's own unread queue; to see work in flight regardless of unread, use `team_task board`.

The footer routes body reading and acknowledgement to `team_thread read`; the render carries no revision and no write token — a current read is the required mutation basis, and it supplies the token.

## `team_thread`

`team_thread` reads a Thread or a Project's Main stream. For a Thread, prefer `threadRef`; `read` and `history` also accept `taskRef` when it has a Task. Both refs may be given only if they identify the same Thread. `message` requires `threadRef`, even when `taskRef` is also given. The Main stream takes `projectRef` without either Thread field.

`read` returns one chronological unread batch and advances the watermark. The batch defaults to at most 20 facts. Its acknowledgement covers only what the call delivers: the tool selects fewer facts when the rendered result would exceed the output ceiling, and the Host commits that selected prefix. An unread Message whose body is already fully visible in the current context may omit the body and still counts as acknowledged.

A read that selects no fact and carries no reminder advances nothing and writes no operation; a reminder-only read can still confirm its reminders. An identical retry of a committed read returns that read's original receipt with a picture derived from the current projection, because a read has never promised a frozen answer.

The selection bound is durable for a Thread: the receipt stores `selectedThroughSequence`, so replay reconstructs the same acknowledgement and facts after it stay unread. An identical retry returns that receipt, the `readThroughSequence` it recorded, and the count still unread; it does not redeliver the unread facts or acknowledge again. A receipt written before the field existed keeps the default batch. Human reads, Remote parameters, and their read semantics are unchanged.

The bound is a read position, not a write token. It is validated against the Thread's head — the sequence of its last public fact — because that is the furthest fact an unread batch can carry.

A public fact that revises no Thread state, such as a bound Worker run's start or ending, sits past the Thread revision. The token every Thread write fences on stays that revision ([Mutation fences](boundaries.md#mutation-fences)), so the two numbers are not necessarily equal; a selection past the Thread's own head, including one copied from another Thread, is still refused.

A Thread `read` also supplies background for a reader whose context no longer holds the discussion: the anchor when it is missing, plus the Message facts among up to four facts immediately before the unread batch — before the tail when nothing is unread. A Main stream `read` supplies the same recent Message background, without an anchor. Background already fully visible in the current Session is not repeated, and there is no separate persistent read cache: visibility is the current Session surface alone.

Background is orientation, not newly acknowledged work, and it can appear on any read; no permanent “already read” mark decides it. Read first when background is missing on either read; use `history` for older facts and `message` for one Message read back verbatim, including a quote whose original sits outside the page you hold. Neither acknowledges unread work.

`beforeSequence` and `limit` page `history`, where the Host bounds `limit` to 1–100 with a default of 20. `message` rejects them. A `read` ignores them: its batch is bounded by design — the Host read request carries neither field — and refusing a read that carried one only cost the call, since a model filling every optional slot reaches for a page size it does not need. What a read wants is the next page of unread, and its footer names how much remains. The output ceiling applies to `read` and `message`, not to `history` paging.

`read` and `message` share one total result ceiling of 32768 UTF-16 units, wrappers included. A single Message body may exceed that and still continue while it fits the reading capacity: `min(262144, model contextWindow − 16384)` UTF-16 units. That capacity is a deliberately conservative unit-for-token limit, not a token count; when the model capacity is unknown it is 262144.

A body beyond the total ceiling but within that capacity returns in ordered parts. A body beyond the capacity acknowledges nothing: the result asks the sender to split it into shorter Messages or the reader to use a larger-context model, and repeating the call cannot complete it. Continuation is bounded by that capacity, not unlimited.

The three actions share no maximal render: reading shows the Thread, and only reading does. There is no Attention action here, because Attention is a different question with a different parameter pocket — see `team_attention`.

`message` renders the ref, the sequence with its instant and sender, and then the body. A body that fits renders complete and untrimmed; this one action exists so a reader can answer a Message it did not receive, and an oversized body follows the part rule below.

A result that would exceed the output ceiling carries a bounded part of the body instead: ordered character ranges of the same Message, each saying whether the current context now holds the whole body. `message` never acknowledges unread work.

The only continuation is repeating the same `message` request with the same address and `messageRef`; the Host resumes at the first missing segment on the current surface and adds no offset parameter.

`read` follows the same rule: it stops before an incomplete Message rather than acknowledging past it, and a Message counts as acknowledged only when earlier visible parts plus this output cover its whole body. Session trimming or compaction invalidates those parts, so repeating the read or message refills them. `[attachment]` paths in a body remain file-reading locators; a complete Message does not prove that its attachments were read.

A read renders these parts in order, then a footer:

1. the outcome — acknowledged and remaining unread counts;
2. Thread identity and following state;
3. orientation — the bounded anchor subject when the anchor is not a returned fact;
4. active Claims only — the current collision surface, one line per Claim (claim ref, owner, direction);
5. acknowledged Task reminders, when the read carried any;
6. Host-supplied background under `Background — not newly acknowledged` — the anchor when missing, plus the Message facts among up to four preceding facts, none already visible in the current Session;
7. the acknowledged facts in sequence with inline unread/direct markers. A fully visible Message body shows `body already in current context; omitted` in place of the body. An acknowledged Activity already complete in the current context shows only its identity, marked `complete event already in current context; omitted`. Derived Task cards render under `Current Task cards — not Thread reading`, at their creation sequence with current status and accountable owner; a card is current state, not Thread reading;
8. `Incomplete Message — not acknowledged` — the bounded part returned when an unread or background Message does not fit. An unread Message stays unread until earlier visible parts plus later output cover its whole body; background remains background, not newly acknowledged. An Activity is one line and cannot be split: one beyond the fixed output ceiling acknowledges nothing, no model capacity setting makes it fit, and the result states that limit so the Human can inspect the event directly.

The footer states the read-through sequence and the remaining unread count.

When the read left Thread facts behind it, a further line states how many those are, so a returning reader sees the size of the span it is not looking at instead of assuming the batch is the Thread.

A Main stream `read` renders the same outcome and background rules. It selects the oldest unread entries before adding missing recent background, and acknowledges only the delivered prefix. Task cards or the reader's own Messages cannot hide earlier unread content.

Thread cards render under `Thread cards — Main entry acknowledged, not its Thread`: a card is the current state of the Thread it names, and acknowledging its Main entry never marks that Thread read. `message` on the Main stream reads one entry back by ref with the same part and continuation rule. Human reads of the Main stream are unchanged.

A history page renders a historical outcome with Thread identity, the full anchor on a first page and the bounded subject on continuation pages, the selected facts and any derived Task cards in that sequence window, and the cursor/hasMore footer — never current Claims or a context recommendation. Every activity fact is structured from that event alone — its activity ref, actor, Task and Thread refs, and the Claim refs or transfer endpoints the activity recorded — never a bare kind and never current Task or Claim state.

A `read` acknowledges an unread acceptance of a still-done Task in its facts and recommends nothing about the reader's context: with no rollover tool and no generation choice, there is no action for a read to state.

## `team_attention`

`team_attention` answers whether you follow this Thread or this Project's Main stream, and whether you should. `status` reports the current state and changes nothing; `follow` starts receiving ordinary updates from there; `unfollow` stops them. All three take the address and the routing Workspace. A Thread takes `threadRef`, or `taskRef` as the compatibility alias, and the two may appear together only when they name the same Thread; `projectRef` addresses the Main stream and is refused together with either Thread field rather than silently preferred.

Once the reader follows, every result also names what established that Attention — starting the Thread, claiming its Task, being accountable for it, owning the Project, being named in it, or choosing to follow. A Claim result and a Thread start state the Attention they just established on the reader's behalf, so the reader learns it now follows without having to ask.

Attention is not reading. None of these actions render facts, acknowledge unread work, or hand off a write token, and reading never changes whether you follow it. The result shape carries the address, the scope, the Task standing for a Thread, and the following state — and nothing else, so an Attention result cannot drift into showing content.

Every result states the consequence its verb alone does not carry. Following means ordinary updates from there interrupt you. Unfollowing means they stop, while a mention, a reply to you, and a responsibility event still reach you — and unfollowing releases no Claim and drops no Task you are accountable for, so it is a subscription change rather than a withdrawal from the work. Your active Claim prevents unfollowing that Thread until done or released. [Attention and messaging](attention-and-messaging.md) owns the rows themselves.

The split from `team_thread` is what makes the read path carry no Attention logic at all: the three actions share one parameter pocket instead of borrowing a read pocket with three parameters (`messageRef`, `beforeSequence`, `limit`) they can never accept.

## `team_message`

`team_message.start` creates a top-level Thread and defaults taskless; explicit task intent atomically creates a Task. `reply` appends to an existing Thread. Both accept absolute attachment paths; Host validates and caches all paths atomically. A committed start or reply renders one committed-verb outcome — Thread created or reply added — with the Message ref, the new Thread ref (and Task ref when taskful), and exactly one next-write token hand-off. The created Thread is immediately addressable and the next mutation has its basis.

Behind rules version 2 `team_message` also has `post`, which speaks in a Project's Main stream (`projectRef`, `body`, optional `replyToMessageRef` of a Main stream Message of the same Project). It needs no write token. A writer holding unread Main stream entries must instead hold every one of them complete in the current context — as a Team notice or a tool result that binds the actual rendered Message or Activity — or explicitly read with `projectRef`; otherwise it gets `main_unread_required`.

`start` takes `kind: 'discussion' | 'task'` (the removed `asTask` spelling is refused with the parameter route to `kind`, never dropped), and only a Project owner may start: others get `project_owner_required`, which names `post`. A non-member gets `not_project_member`. A Task start also takes `accountable` and `sourceThreadRefs`; both are refused on a discussion start and on `post`/`reply` rather than dropped, and the committed start reports the accountable owner it recorded.

`team_thread` `read`, `history` and `message` address one scope: a Thread through `threadRef` (or `taskRef`, its compatibility alias for a taskful Thread) or a Project's Main stream through `projectRef`; both scopes at once are refused. `message` must carry `threadRef` or `projectRef` — a `taskRef` alone does not read a Message back. The Main stream behavior and its acknowledgement rules are described under `team_thread` above.

Typed rejection results (`unread_required`, `stale_revision`, `main_unread_required`) begin `Not committed` and retain refs and counts with a bounded selection of pending facts. A complete Message and Activity result with a recognized revision baseline supplies a token for reconsideration; a Main stream result supplies none (it has no token). Partial results and unknown baselines route to `read`. This neither acknowledges unread facts nor guarantees the next write. [Mutation fences](boundaries.md#mutation-fences) defines the complete rule.

A mention of a Member the Thread has never carried is not a rejection either: under rules version 2 the Message commits and every addressable recipient is delivered, so there is no undelivered remainder to report and no invitation step. Rules version 1 recorded the names it could not deliver; that record survives only as the Host's historical explanation when replaying old ledgers, and the model-facing result no longer reports it.

Recovery wording with a next step comes from one registry (`packages/agent-team/src/recovery-hints.ts`), not from each call site, so a route names the value it takes. The registry does not claim that every error has a next step: a fault with no recovery path states what is missing instead of inventing a route. A test enforces it — it walks the model-facing sources of both the Host and the tool package and refuses a route sentence written outside the registry.

`reply` also takes `replyToMessageRef`, which names the Message on this Thread being answered. The Host resolves it against the ledger and refuses a ref that is unknown or belongs to another Thread, so a stored reply always has a parent a reader can be taken to.

The link is recorded on the Message and renders as a quote the reader can follow back. It also notifies the parent's author, including the Human, without repeating their handle; replying to your own Message does not add you as a recipient. See [Attention and messaging](attention-and-messaging.md) for delivery rules.

## `team_dm`

`team_dm` sends a private direct message to one enabled Agent Member in the same Workspace. It takes a `memberRef` and a `body` and nothing else — no Thread, no Task, no write token, and no attachments — because a DM addresses a person rather than a conversation. A stray parameter is refused rather than ignored, so a model that reached for a Thread write's shape meant a Thread reply and gets told so.

A DM is pure delivery: the ledger appends an audit-only `team/dm-sent` operation (request-idempotent) while the recipient's live session receives the body as a relay-form user message on the steered lane: an idle recipient starts a turn, a running one takes it at its nearest step boundary, so a DM never queues behind another pending turn. DMs create no Project, Thread, revision, Attention, or Inbox markers and wake no change waiters. The Human cannot be DMed.

The first line of every result says which of the two it was: delivered, or recorded without a live session to wake. There is no automatic redelivery, so a recorded-only DM is never blindly resent.

Use DMs for quick clarifications and status syncs only. Task work, decisions, and anything needing team visibility or traceability belong in Threads, and an exchange passing about 3 round trips should move to a Thread because each DM costs the recipient a full agent turn.

## `team_reminder`

`team_reminder` has the actions `create`, `list`, and `cancel`, and every one of them is about the caller's own reminders. A reminder has exactly one recipient, so the tool never takes a recipient and the Host derives the actor from the calling Agent; the Human reads and withdraws a Member's reminders from Member detail in the Web Client instead.

`create` takes `scheduleKind` with that kind's own fields — `once` with `at` (an ISO 8601 instant), `every` with `minutes` (a whole number, at least 10), or `cron` with `expression` (five fields read in the fixed UTC+8 zone, which has no daylight-saving component) — and always `note`, what the reminder is for, at most 2000 characters.

A schedule named without its own field is refused rather than guessed, and a schedule's content sent to `list` or `cancel` — `at`, `minutes`, `expression`, or the note — is refused rather than dropped, because a schedule on a cancel names a reminder the caller never picked.

The selector is not content: `scheduleKind` only says which field a create reads, so its default `once` is dropped on `list` and `cancel` like a blank slot, while naming another kind is still refused. Blank slots are absent on every action, so a model that fills every optional slot sends `note: ''` without turning a cancel into a create.

At most 50 reminders may be active for one Member, and the ledger enforces the interval floor and the never-fires rule at creation, so replay stays deterministic. `list` reports every reminder the caller owns with its state and its occurrence facts — pending, last, and next — and `cancel` withdraws one by `reminderRef`. Both read the caller's own set only.

A reminder's ref is derived from the tool call that created it, with the two characters the ref shape reserves percent-escaped, so a nested sub-call's id still yields a ref the durable schema parses back. A create whose request id already exists answers with the stored operation only when the normalized schedule and note match as well; a moved time or a rewritten note under a reused request id is a collision rather than a silent original.

A due occurrence reaches the caller's Team Inbox as a private notice and wakes it, and the Host records it consumed once it enters one of its turns — per occurrence, so a notice answers only for the occurrences its text rendered. An occurrence missed while the Host was down is made up exactly once after recovery, and an unread occurrence of the same recurring reminder is replaced rather than stacked.

While the Member is suspended its reminders keep timing and deliver when it resumes; when it is archived or removed they are all cancelled, which [domain-model.md](../domain-model.md#member-reminder) derives from the Member Lifecycle table rather than a second cleanup write.

## `team_task`

`team_task` has the actions `board`, `list`, `claim`, `done`, `release`, `accept`, `close`, `reopen`, `transfer`, and `promote`.

`board` renders the Host's Task board projection: every open Task of the Projects the reader can see, grouped into To do, In progress, and In review, newest activity first, then each Project's five newest finished Tasks. Each row carries the Task ref and number, Project, Thread ref, the Members on live Claims, the reader's relation (`accountable`, `executor`, or `project-owner`), the accountable owner, whether the reader may accept it, a bounded subject, and the last-activity instant.

`projectRef` limits the board to one Project; `mine` keeps only Tasks the reader is accountable for or holds a live Claim on.

`finishedTruncated` says whether the Host held back older resolved work; the render states it, so a page never reads as the whole column.

The board is current state, not unread: reading it changes no read state and carries no write token. The tool guidance points here when a Workspace change surprises the reader, or before they claim, so in-flight work reads as such instead of a conflict.

`promote` turns a discussion Thread into a Task; it takes `threadRef`, the Thread's `baseRevision`, and optionally `accountable`, and only a Project owner may do it (`project_owner_required` otherwise).

`list`, `claim`, `done`, and `release` manage only the Agent's own Direction Claims on real Tasks. Taskless Threads have no Claim mutation. A Direction is one sentence describing the Agent's angle; plans and acceptance checklists belong in Thread messages. A successful Claim starts Attention. `list` renders the Task/Thread identity with the active collision surface — active Claims only, or an explicit none — and no write token; it supplies neither Thread facts nor a mutation basis.

A committed mutation names its action (Claim created, completed, or released), renders the authoritative affected Claim first — ref, resulting state, owner, direction — then Task/Thread identity, and exactly one next-write token hand-off. Rejections share the message rejection form and the same [completeness and token rules](boundaries.md#mutation-fences); Task permissions are checked again on each attempt.

`accept`, `close`, `reopen`, and `transfer` resolve a Task rather than a Claim, and the Host decides who may call them.

`accept` belongs to the Human, to a Project owner, or to the Task's own accountable, and never to a Member that held a Claim on that Task; an Agent may accept only while it is in review. `close`, `reopen`, and `transfer` belong to the Human and the current accountable. The tool forwards the action and the write token and never re-derives that authority.

`transfer` takes `target` — any enabled Project member's memberRef, `@Handle`, or a unique memberRef prefix, or `human` — and moves responsibility only, leaving Claims with their owners; the new accountable takes part in the Thread from there and is woken with what the Task now asks of it.

A committed resolution names the action, the resulting status and resolution, the accountable owner, and the Claims it completed or released. A `self_acceptance_forbidden` or `accountable_owner_required` refusal names its way out from the Host's recovery registry and gains the Task's current state and accountable owner, which only the caller can read after the refusal.

## `team_subscription`

`team_subscription` creates and maintains a Project's subscription: a script the Host runs with no Session, as that Project, on a timer, on an incoming webhook, or on both. Its actions are `list`, `create`, `update`, `test`, `pause`, `resume`, `delete`, `baseline`, `logs`, `deliveries`, `replay`, and `reset_webhook`.

Only the Project's owners may change one, test one, or replay a delivery (`project_owner_required` otherwise). Any Workspace Member may use `list` for Agent-facing metadata that omits scripts, credential references, and webhook arms; run history remains Project-member-only, with owner-only output as described below.

Empty `workspace`, `scriptPath`, and `scriptContent` slots are absent; two nonempty script sources still conflict, and no script is still an error. Zero `intervalMinutes` or `limit` uses omission semantics. This never drops `notify: []`, `credentials: []`, `webhook: false`, or an `expectedRevision`: clearing recipients, removing credentials, disarming a webhook, and revision checks remain real instructions.

`create` and `update` take `intervalMinutes` for a timer, `webhook: true` for an address, or both, and refuse a subscription that names neither. On `update` the two triggers read omission differently: leaving out `intervalMinutes` drops the timer, while leaving out `webhook` keeps the address, and only an explicit `false` disarms it — a caller that does not model webhooks must not cut off a live provider. Arming the trigger needs the deployment's public origin (`webhook.publicOrigin` on the Host row).

The answer to an arming or resetting call carries the complete address, and that is the only time it is readable: the ledger keeps a hash of the token, so a retry of the same request, a later `list`, or the subscription page can never show it again. `reset_webhook` moves the address under the `expectedRevision` the caller read; the old one stops resolving immediately, while deliveries already queued keep running.

For create and update, request identity includes the script source, trigger options, and create baseline. A committed retry still checks the current actor and Project ownership, then answers from the ledger without reading the script file, checking credential availability, or running the trial again; reusing the id with different options is a collision. A legacy record with no stored script path refuses a path retry and returns the committed `subscriptionRef`; read that stored subscription before starting a new request.

`logs` reads the newest recorded runs — 50 are kept per subscription, newest first — with the trigger, start instant, duration, structured category, event count, exit code or timeout, the revision the run pinned, and for a webhook run the delivery and attempt that asked for it. The event count is what the run had accepted into the ledger, so a run that printed only ids the subscription already knew counts none.

A webhook run whose batch finds no room in the unpublished queue is not a lost one: the validated events are kept with the delivery and a later pass accepts exactly them, without spending one of the delivery's retries — only a run that alone prints past the 500-event ceiling becomes an item under `deliveries`.

The Project's owners and the Human also get each run's reason and the last 8 KiB of stdout and stderr — of a passing run as well as a failing one; every other member gets the summary alone, because the script ran under the Project's credentials.

`deliveries` lists — for the owners only, because a delivery holds the request body it arrived with — the webhook deliveries whose automatic retries were spent, with a stable ref, the revision they arrived at, the last error, and their expiry. Each one counted a single failure when its retries ran out, so three of them pause the subscription like three failed runs.

`replay` runs one again, by default with the script as it stands now so a fix can handle an old request, or with `version: received` for the definition that delivery arrived under. It is a run: it takes a run slot and the subscription's own exclusion, and a paused, deleted, or archived subscription is refused on the way in.

A replay publishes what the script prints and never counts as a failure of the subscription. Repeating it keeps the same request id, and that id then answers with what the first call did. One id names one intent: reusing it for another delivery, or the other version of the same one, is refused as a request collision, and a delivery whose replay delivered is not run again under a new id.

`create` and `update` take the script as `scriptPath` — resolved against the caller's own working directory, the one its shell tool uses — or as `scriptContent` for a caller with no file. The Host reads the file, stores a snapshot of at most 16 KiB, and runs it once with the production path: the same executor, the same explicit sandbox policy, a 60-second limit, and the same output contract.

A failing trial refuses the write and returns the tail of stdout and stderr instead; nothing is stored. Every declared credential reference must already be configured, and the Host resolves it again on each run — a reference removed later fails that run instead of silently running without it.

A new subscription records the ids its trial printed as its deduplication baseline by default, so the first live run does not republish what the script already found; `baseline: ignore-history` starts empty instead. `update` never touches that waterline: after changing the script's id rule, `baseline` appends the ids to ignore, and nothing already recorded is cleared. A pause, resume, or delete carries `expectedRevision`; an update moves the revision, a state transition does not.

Events are the script's stdout: one JSON object per line with `id`, `title`, and optional `url` and `detail`. Deduplication is scoped to one subscription, so two scripts printing the same id each publish their own.

New events are accepted into the ledger and published to the Project's Main stream at most 20 per minute per subscription. Up to 500 accepted events may wait unpublished, and a batch that would cross that ceiling is refused as one failure rather than silently trimmed. A trial run never counts as a failure and never clears the count; three failed runs in a row pause the subscription and are recorded as such.

`create` and `update` take `notify`: the Members whose Inbox the published events reach, each named as a `memberRef`, an `@Handle`, a unique 6+ hex prefix, or `human`. Any current member of the Project may be named, owners or not, and the Human when named; omitting it addresses the events to the Creating Member alone on a create, and keeps the stored set on an update, while an empty list is a real choice — the events still reach the Main stream and nobody is woken.

The publish commit drops a recipient who has left the Project rather than substituting an owner, and a record written before the field existed reads back as its Creating Member alone.

The result names the subscription, its state, its revision, and its interval, and any refused trial renders the reason with the last of each stream. What a script prints is data, never instructions: an event on the Main stream is marked as untrusted text and its title, link, and detail never become a mention. Project subscriptions run unattended — a restricted Member gains this execution path, the Main stream records every change, and the Human can pause the subscription at any time.

## `team_worker`

`team_worker` delegates one self-contained piece of work to a local Worker engine — Codex or Claude Code — running with its own tools, its own login, and its own settings. It takes `task`, at least one of `threadRef`, `taskRef`, and `projectRef`, and optional `engine`, `cwd`, and `requestId`.

A call is one of four shapes: a start, a stop, a look-up, or a steer. A stop and a look-up each name one `worker:` ref and nothing else; a steer names that ref plus its instruction.

A blank slot is absent before the shapes are told apart — a model that fills every optional slot sends `stop: ''` on a start and `task: ''` on a stop, and neither names a ref or a task — while a real value still gets the refusal that names the conflict. `engine` is a start selector, so on the other three shapes its shipped default `codex` is dropped the same way and naming the other engine is refused.

The target decides where the result goes. A run bound to a Thread reports there: its start and its ending become Thread facts every participant can read, and its answer arrives in the delegating Member's Inbox.

A run bound only to a Project publishes nothing and returns to the calling Member's own session, as it did before targets existed. Its execution record is still written, so the run stays findable by its `worker:` ref.

Delegation is off until the operator turns it on. The Team settings row carries a `worker` group — `enabled`, `defaultEngine`, one entry per engine with `enabled`, `executable`, and (Codex only) `sandbox`, plus an optional `timeoutMs` — and every field is volatile so a change reaches a running Host. Both engines run with full permissions and nothing to configure: `sandbox` defaults to `danger-full-access`, the settings page does not offer it, and narrowing Codex's policy is a hand-edit of the row.

`executable` exists because a Host's `PATH` is not a shell's: the CLI a human installed may be nowhere the Host process searches, and an empty value keeps the engine's own discovery.

While the switch is off, `team_worker` is not declared to Members at all; turning it on adds it to existing Member Sessions at their next turn boundary, and turning it off withdraws it. The same switch adds or removes the Worker paragraph of the `team:project-owner` guidance section, which is re-derived at every assembly. A run already in flight keeps its handle either way: the switch gates new delegations, and the registry still refuses a start while it is off.

A call is refused before the opening record and before any native process exists for each of these reasons: no target was named (`worker_target_required`); the named Thread (`worker_thread_unknown`), Task (`worker_task_unknown`), or Project (`worker_project_unknown`) is not one this Team holds; the Task is not in the Thread it was named with (`worker_target_conflict`); the caller does not currently own the Project the target belongs to (`worker_owner_required`).

The remaining refusals are the settings and the run itself: the switch is off (`worker_disabled`); the named engine is not a Worker engine (`worker_engine_unknown`) or is not enabled (`worker_engine_disabled`); the task text is empty (`worker_task_required`); no absolute working directory can be resolved (`worker_cwd_required`); the Harness subagent service is not mounted (`worker_unavailable`); or the request id was already opened for a different delegation (`worker_request_conflict`).

Ownership of one Project never authorizes another, and an ordinary DSH Session outside the Team preset never acquires the tool.

`engine` overrides `defaultEngine` for that one delegation, and an engine that is unavailable reports why instead of falling back to another engine, account, or model. Repeating a call with the same `requestId` answers with the execution the first call started; it never starts a second one, not even when both calls arrive at once. The id names that one delegation and no other: a resend from a different Member, or one that changes the task, engine, or target, is refused rather than answered with a run it did not ask for.

The receipt names the Team execution (`worker:` ref), the Project, the engine, the working directory, and the start instant, plus the Thread when the run is bound; it states that the work continues in the background, and where that result will appear.

The same tool stops one run: pass `stop: <worker:…>` and nothing else. `task` is not required, and naming a task, Thread, Task, Project, engine, working directory, or request id alongside it is refused rather than half-applied.

The stop is authorized by the identity that opened the run: the delegating Member, or the Human through the edit-Agent dialog. Another Member is refused even when it now owns the Project; the settings switch and current ownership are not re-checked, because they gate starting and not stopping. A run that already ended answers with the state it really ended in instead of being stopped twice.

A run this Host no longer holds — the signature of a restart — is refused as `worker_unconfirmed`: it cannot be confirmed or stopped, and it is never re-run.

The stop waits for the engine to confirm its cleanup, and the wait is bounded. Past the deadline the run is still `running` — the Thread read and the Human's list call it `stopping` while the stop is in flight — and the call is refused as `worker_stop_pending`, while the cleanup it already asked for keeps going. An engine that reports a failed teardown instead records the run `failed` with a diagnostic saying the cleanup is unconfirmed, never `stopped`.

Two runs are independent: stopping one leaves the other's process, Thread facts, and Inbox notice untouched.

A bound run publishes two Thread facts: `worker_started` when it opens, and `worker_settled` with its `state` and, for a failure or a stop, one bounded `reason` line. Its answer is never a Thread fact — it reaches the delegating Member's Inbox in the notice that wakes them with the ending, labelled as external text that is data and not instructions, and the parent Session receives no second copy. A Project-only run keeps the parent notice instead and publishes nothing. Neither creates a Task, a Main stream entry, or a Claim.

Delegating work on a Task changes no responsibility: the Claim stays with the Member, a finished run never accepts anything, and the ordinary independent-acceptance rule still applies.

A Worker holds no Team identity: it cannot post, claim, accept, or answer for the Member. If it performs work on a Task, the Claim stays with the Member and the ordinary independent-acceptance rule still applies. What a Worker returns is evidence to check, not instructions.

Every run's record is durable: a Thread read reports every run bound to it as `running`, `completed`, `failed`, `stopped`, or `unconfirmed`, and a Project-only run records the same execution facts without publishing them. A record a previous Host left in `running` reads as `unconfirmed`: the result cannot be confirmed, the run is never restarted or retried on its own, and nothing wakes anyone for it.

The same tool reads one execution's diagnostic: pass `inspect: <worker:…>` and nothing else. The answer is the summary the Thread already carries, the stage a failed run came apart in, the native identities the settlement recorded — the engine's own session, the turns and input ids this execution owned, and the absolute path of its record — and the bounded fragments that record still answers after the process exited, or the one reason it cannot.

The native record itself is never copied into the Team, never stored, and never published: the Thread keeps the summary it already had, and the detailed answer reaches only the Member who delegated the run and the Human, who reads it from the edit-Agent dialog by that run's row.

Only the initiating Member and the Human may ask; another Member is refused as `worker_inspect_forbidden`, even when it now owns the Project. A run that has not ended answers with its summary and says its native record is read once it does. A run that ended before the engine recorded a session, or whose record is gone, unreadable, of a shape this Team does not read, or holds no turn with the recorded id, keeps the Team summary and names that reason instead of returning fragments that are not there.

The look-up is bounded and self-checking: the recorded location must be an absolute `.jsonl` path under the engine's own directory — `sessions` for Codex, `projects` for Claude — and an oversized value is refused whole rather than cut into a path nobody recorded. Claude's stream carries no record path, so the settlement derives it from the cwd the CLI reported and the environment the run opened with.

The file that opens must be the file the location named — its identity is compared at open and again after the read — the first record must name the recorded session, and the byte ceiling applies before any line is split or parsed. A continued execution skips its predecessor's prefix and stops after its own turns or before the next root prompt it did not submit.

Fragments are limited to a few safe fields of the execution's own turns, each bounded, and text that looks like a credential is withheld whole rather than masked, quoted JSON pairs included. Repeated Claude turn metadata is deduplicated so a later failure remains visible; a fact omitted by the four-fragment ceiling sets `truncated`. Every reason is one bounded sentence that names the fact and never echoes a native value, and nothing about the engine's record is written back into the Team.

The Human's edit-Agent dialog gives at most five rows: the runs this Host still holds and the records a previous Host left running as `unconfirmed` hold their seats first, and the newest endings by ending time fill the rest — a long run that started early and failed just now stays inside that window — each with the state it really ended in.

An ended row offers its diagnostic; a live or unconfirmed one has nothing to read, so it carries no door. That row is the Human's only door: a `worker:` ref is never shown on that surface, so there is no field to type one into, while reading by ref stays the entry of the Member tool's `inspect`.

The same tool adds one instruction to a Worker's same native session: pass `steer: <worker:…>` with `instruction`, and nothing else. Both Codex and Claude use the same path. While the execution is live, OAR delivers the instruction into its current turn, a queued turn, or an idle session's next turn. The execution waits for every accepted input, and its later answer, failure, stop, timeout, and partial output belong to that one Team ending.

The receipt says `submitted`, never that the model read it or that it landed in a fixed turn. It names the turn when the engine acknowledged one and the execution state when the receipt was written, so a stop or ending that landed meanwhile is visible.

If the latest linked execution ended cleanly, steer resumes its native session as a new linked execution and returns the new `worker:` ref plus `continuedFrom`; the old ending stays unchanged. The new ref can be stopped, inspected, or steered again. A clean failure is resumable too. A stopping execution, an unconfirmed cleanup, an archived Project, a lost owner grant, a disabled Member or engine, a missing or mismatched native record, and a previous-Host `running` record are refused.

Only the Member who delegated the original execution may ask; another Member is refused as `worker_steer_forbidden`, and there is no Human steer entry. Continuation rechecks the current Worker and engine switches, Project state and ownership, and the initiating Member. The ledger allows one running execution per native conversation and one direct successor per execution, so concurrent continuations join the established ref instead of opening another session.

One instruction is sent once per its execution. The Host admits the request in the ledger before native delivery and records refused, ambiguous, or submitted before reporting it. A resend with the same request id answers with the first receipt or refusal, including after the execution ended or the Host was rebuilt, and never reaches the engine again.

A fresh same-text request id becomes a durable alias of that admission; it returns the same outcome without reading native history, and a concurrent canonical call and alias join one delivery. A different instruction, Member, or Worker under a used request id is refused as `worker_steer_conflict`.

An admission whose outcome never reached the ledger is `worker_steer_unconfirmed`, not an invitation to resend. An explicit native refusal delivered nothing, so it may be retried under a fresh request id; transport-unknown remains ambiguous and is never retried. A later linked execution may receive the same sentence under a fresh id.

The live delivery control belongs to this Host's run registry: it is created when the engine session opens, removed when that execution ends, and cleared when the Host releases its runs. A continuation is durable as its own execution. A steer's private ledger receipt and a continuation both leave the Thread revision, Task, Claim, predecessor ending, and existing execution unchanged; only the continuation adds its own Worker start and settle facts.

Unloading the bundle refuses new delegations, cancels starts that are still opening (including one still writing its opening record), and gives active steer calls the same bounded opening wait before fencing off late receipt writes. It then waits for the runs this Host holds to report and record their endings before it closes storage.

A run still unconfirmed at that boundary keeps its `running` record and is sealed, so no late ending is written after storage closes. Durable writes already in flight are awaited before providers are released; the five-second lifecycle deadline does not cancel a storage write that stopped answering.
