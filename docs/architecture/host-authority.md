# Host authority

English | [中文](host-authority.zh.md)

This page owns Host decisions and their failure boundaries: durable commits, runtime effects, and the projections they produce. Start with the ledger rules, then use the lifecycle and recovery sections to distinguish a committed fact from an effect still owed.

Team is one collaboration domain per DSH home. Its append-only ledger owns Team facts: Members, Workspace participation, Projects, Messages, Threads, optional Task overlays, Claims, Attention, Inbox, and Activities. Harness remains the authority for Workspace existence and Session storage; see [storage reuse](workspace-session-storage.md).

When changing a Host capability, read package source/tests first and then the matching Harness contract. [`harness-navigation.md`](../harness-navigation.md) maps the route to `deepseek-harness/docs/subsystems/` and source packages.

## Ledger authority and commits

### Rules versions and replay

- Current Session context may satisfy the [Thread reading requirement](../team-collaboration/boundaries.md#mutation-fences), but never confirms unread or creates another authority. Only explicit reads commit read-state changes.
- Agent Thread and Main stream reads add [context-aware presentation](../team-collaboration/tools.md#team_thread) to the ledger result: missing recent Message background and references to already-visible bodies. The tool selects the prefix it can render within its output ceiling, and a Thread receipt stores that bound as `selectedThroughSequence` while a legacy receipt keeps the default batch; the Host commits only that prefix. Human reads, Remote parameters, and replay semantics are otherwise unchanged, and replay never depends on a Session.
- Mutations enter Host authority and commit one durable operation. Projections, Inbox, tools, commands, Remote responses, and UI derive from committed operations; Client code never interprets ledger records or creates parallel authority.

- Replay re-derives each record's expected Inbox delta and compares it exactly, so a release that changes how an existing kind is validated first records `team/rules-version-adopted` (Host actor, `{ version }`). Each record validates under the newest marker before it; a ledger with none is version 1. `initialize` appends the marker inside its own queued commit, so it precedes every later write, startup recovery included. Markers only ascend, at most one per version, and a build refuses a ledger adopted at a version above its own.
- Current builds implement version 10. Mounting a ledger whose newest marker is lower appends only the version 10 marker, once, and a fresh ledger records it right after `team/initialized`; reopening a ledger already at version 10 appends nothing. The version-2 rules below still describe their own segments, not the current marker.
- Version 10 changes how `team/thread-started` and `team/thread-promoted` validate a Task's accountable: any target a transfer accepts, where earlier segments demand the Agent creator, a Human start's enabled owner or the Human, and a promotion's promoter. Those segments replay byte-identically under their own rule, and a version 9 build stops at the version 10 marker.
- Version 9 replaces Project-membership gates with Workspace participation: enabled Members may write, suspended Members may still read, and inactive or archived Members may not read. New Projects store no membership list; earlier segments retain their original rules. Ownership remains a separate permission.
- Version 8 adds `team/project-owner-responsibility-updated` and an optional `responsibility` on `team/project-owner-added`. Both are refused inside a segment below version 8, so a ledger written by an earlier build replays byte-identically and its owner records keep reading as unspecified; a build implementing only version 7 stops at the version 8 marker before it parses either shape. An upgrade therefore needs no data migration — the marker alone decides which segments may carry the new field.
- Behind version 2 the Host also commits `team/main-message-posted`, `team/main-stream-read` and `team/thread-started`, which a version-1 segment rejects, while `team/message-sent` is rejected in a version-2 segment. The Host no longer writes `team/message-sent` (a Thread starts with `startThread`); it replays only inside version-1 segments.
- A version-2 segment containing `team/message-sent` is refused, including a preview ledger with that combination; the marker and operation kind, not a release label, decide replay.

### Inbox deltas and reply references

- An inbox delta may carry an optional `mainMarkers` list with its own marker shape (`projectRef` plus a `messageRef` or `activityRef`). It appears only when it changes something, so version-1 records keep their stored bytes, and a departing Member's Main stream markers clear in the same operation as its other inbox state.
- An inbox delta may also carry an optional `mainAttention` list (`set` of Main stream Attention rows, `removed` of their keys), with the same "only when it changes something" rule, so every delta written before Main stream Attention existed keeps its stored bytes. `team/main-attention-changed` writes it for an explicit follow or unfollow, an ownership grant writes the row it starts, and a withdrawal removes that row; its row is keyed by Member × Project and never enters a Thread index.
- An Attention row carries the `source` that established it: `thread-author`, `claim`, `accountable`, `project-owner`, `mention`, or `self`. It is optional in storage, so rows written before it existed keep their bytes.
- On load, a missing cause is derived from the operation that wrote the row: an ownership grant reads as `project-owner`, a Claim as `claim`, a Thread start as `thread-author`, a transfer or reopen as `accountable`, and a legacy read inherits the existing Attention row's cause. The repaired row then participates in strict replay validation, so old records keep their stored shape without weakening the comparison.
- An Agent is woken from its Main stream markers through the same direct-notification path as a Thread marker, and an ordinary Main stream update its Attention covers is delivered immediately. Every unread fact interrupts, so an ordinary Thread update reaches a reader only because it follows that Thread: no identity — owner or accountable — sits in a slower class, and nothing accumulates a count first. `covered` is the process-memory signature that stops an unchanged rederivation spending a second attempt; a queued but unread notice is replaced, not stacked.
- A reply records the Message it answers as `replyToMessageRef` on the Message itself, and the Host resolves that ref against the ledger before committing: an unknown ref, or one belonging to another Thread, is refused rather than stored.
- The parent's author joins the recipients at commit and takes a direct marker exactly as a mention does — the same resolution, the same markers, no invitation step. Under rules version 2 `undeliveredMentions` is never populated: every addressable recipient is delivered, whether or not the Thread ever carried it, and nothing follows as a side effect. Reporting an undelivered remainder is the version-1 compatibility path alone.
- The quoted picture — the parent's author and one line of its body — is a read-time derivation (`replyTo`), never a second stored copy. It therefore cannot disagree with the parent and still fills in when the parent sits outside the page being read. A ref that no longer resolves stays a bare ref. Quoting is not optional: the parameter is part of the reply contract, and a reply carrying a ref is accepted or refused on the ref alone.

## Lifecycle and notifications
- Agent lifecycle, replay, authorization, idempotency, and revision checks stay on Host. Durable unread changes may produce one bounded coalesced Agent notification through the public safe boundary: direct mentions carry their Message and source, direct Task/Claim Activities carry the complete event, and ordinary unread carries a Thread-first route with bounded digests and overflow counts. Promotion reaches followers through Activity markers. Notifications are not a second authority and do not promise exactly-once processing.
- The notice ranks missing direct signals before reminders and ordinary digests; [attention-and-messaging.md](../team-collaboration/attention-and-messaging.md) owns its order, caps, and character budget.
- A committed Session transition (`team/member-session-renewed`, `team/member-session-rolled-over`, `team/member-session-recycled`) records the desired binding, not a completed one: retiring the old generation and activating the target are Host effects outside the ledger write.

  Startup and the explicit Member recovery action both finish an interrupted transition from the recorded previous Session, and each effect derives its own completion — a live handle never proves the archive half ran. A repeated request answers with the recorded receipt and an honest status, never a second binding.
- If a reload leaves another live Agent holding the current binding's write handle, the Member stays unavailable until that owner disposes. The release queues a runtime-only retry against the same binding, without another transition.
- That transition record is the whole lineage of a rollover. The successor Session's header carries no `parentSession`, because the field names a subagent's creator, so a reader looking for the retired Session reads the ledger rather than the header.
- Every durable Member state has one desired external effect set — the [Member Lifecycle](../domain-model.md#member-lifecycle) table. Each lifecycle operation re-runs that set right after its commit, and startup re-runs it for every non-enabled Member, so an archive, suspension, or removal interrupted by a crash or a failed Workspace/Session/filesystem call converges by repeating the same derivation rather than by a second durable write.
- Startup never activates a non-enabled Member: an effect that fails during startup is logged and retried at the next boot instead of failing the boot. Member and manager restoration starts after Host readiness. Teardown cancels listing and activation; cancelled Member startup effects fence their own late handles, while only manager disposal receives a 100 ms drain grace. A stuck restore therefore holds neither boot nor shutdown. Lifecycle operations for one Member stay serialized in submission order, while different Members and the manager never queue behind each other's waits.
- Task reminders are Host-owned `team/reminder-raised` operations evaluated after Team events, never timers. Their optional `reminderMarkers` Inbox delta is private to one recipient; replay retains the complete episode for deduplication after its marker is consumed.
- Member reminders are Host-owned `team/member-reminder-created`, `team/member-reminder-raised`, `team/member-reminder-consumed`, and `team/member-reminder-cancelled` operations, driven by a Host-owned timer and every Team event rather than by the model-facing schedule text.
- The ledger stores only the create, each raise, the consumption, and the cancel. A raised occurrence carries a private `memberReminderMarkers` Inbox delta for its one recipient, and one marker per reminder is what replaces an unread occurrence instead of stacking them; archived or removed Members derive every reminder cancelled, as the Member Lifecycle table derives the rest.
- Consumption names the marker sequence it answers, so a notice that rendered an older occurrence cannot consume the newer one that replaced it. A reminder ref the durable ref shape cannot parse back is refused at the create boundary rather than failing on replay.
- A consumption write that fails drops the coverage its notice earned and rederives that notice for the live Session, because the occurrence is still owed and the same durable facts must not read as answered. The retry is bounded by consecutive failures; standing down leaves the occurrence unread and uncovered until the next Team fact touching that Member.
- Reminder operations invalidate the Task Thread change scope so the Human Inbox refreshes, but add no public fact or revision; a Member reminder occurrence invalidates no public scope at all, reaching one Member's private Inbox. Acceptance, close, and lifecycle cleanup remove obsolete unread markers while retaining episode history. Agent idle observations are process-local, retained across generation replacement and discarded on Host restart; unknown idle never satisfies a time condition.

- After the ledger append, delivery effects follow — commit listeners, Client change invalidation, the participation notice, and one wake per affected Member. Each runs in a boundary that logs an ordinary failure instead of failing the operation, so the caller still receives the committed result.
- Notification reads reuse Thread/Main unread material only within one synchronous read set; text rendering reuses that attempt's delivery plan. Nothing is cached across commits. A `running` edge rederives current unread facts before deciding whether delivery is already covered; a prior notice's coverage alone cannot establish this after a read.
- A commit affecting at least eight identities defers notification effects until after durable commit and Client invalidation. Each Member has an ordered queue; a later small batch joins any pending queue instead of overtaking it. Different Members are scheduled independently. Shutdown skips effects that have not started; activation rederives durable unread facts. Queue drain means dispatch has finished, not that an Agent has read or answered the notice.
- Synchronous invariant divergence still rejects its caller; a deferred notification reports the divergence at error level because its commit has already returned. A failed Inbox wake clears its recorded notice state, so the next commit touching that Member rederives the same durable Inbox facts and retries without a second append. DM keeps its explicit recorded-but-not-delivered error.

## Which operations wake a Member, and how recovery is chosen

A wake is one bounded coalesced notice the Host delivers over one of four causes, each carrying the durable fact that produced it:

| Cause | What produced it |
| --- | --- |
| `commit` | any committed operation touching the Member: a mention, a DM, a Task activity, a promotion, an accepted answer |
| `transition` | a recorded `team/member-session-renewed`, `team/member-session-recycled`, or legacy `team/member-session-rolled-over` whose retire and activation effects complete out of order; the rederived Inbox is sequenced after any carried input |
| `activation` | a fresh activation, carrying the previous Session id when input was carried forward |
| `running` | the Member's own `agent/status` going `running` — one wake per transition, not per step |

Waking is not a second authority and never promises exactly-once model processing. A wake that fails delivery clears its recorded notice state, so the next commit touching that Member rederives the same durable facts and retries without a second append.

When a recovery instruction is queued, the Host records coverage from that snapshot. Later Inbox facts, Threads omitted as a whole, and Member reminder occurrences left out of the text stay owed.

`recoverMember` is the manual path and picks exactly one of these, in order:

| Condition | Action | Use it when |
| --- | --- | --- |
| handle absent, or the live handle's Session id is not the recorded binding, and a recorded transition exists | finish the recorded transition | a crash or a failed effect left a Session transition half-applied |
| durable state is not `enabled` but a live handle survives | finish that state's effects | a suspend, archive, or removal committed but its disposal failed |
| a live handle whose preset composition is gone | reactivate in place | a reload lost the preset composition, so the Member's tools are unavailable |
| no live handle at all | reactivate | the activation itself failed |
| otherwise | steer a resume prompt | the Member is alive, composed, and bound — every other state has already been handled |

An error-state Member with a live handle is the last row: `recoverMember` steers it, and a cause that is still present makes the next turn fail again. Distinguish the two before choosing: a broken model route or a rejecting gateway is fixed by changing the route, not by recovering the Member, and steering recovers nothing until the route answers. Recovery never resets a context generation: a stranded Member whose binding already moved finishes that recorded transition, and nothing in the Remote surface renews or rolls a Session over.

A Member's current failure reason is carried on its status as a `diagnostic` and rendered by the Client. It is derived from the live surface, not persisted: after a Host restart it is re-derived only if something wakes the Member, so an un-woken Member shows no reason until the next operation touches it.

## Projections and the change stream
- The `contextContinuity` unit supports incremental live folding and full stored-log inspection; its recovery state is defined under [generation swaps](#generation-swaps-and-input-replay).
- The Member clock baseline uses `session-event-cursor.ts` to consume only appended events. The cursor restarts when the Session identity, inherited prefix, length or anchor event changes. Its guard relies on the append-only log contract; an in-place replacement with the same sequence and event type is not detected.
- `changes()` is a streaming Remote with one optional scope (workspace/project/thread/presence); an omitted scope observes shared Team projection changes, not presence. Host registers the listener before emitting the current baseline, then emits matching invalidations, retaining only the latest pending version while a consumer pauses. Cancellation or Host disposal closes the subscription.
- Thread reads and `team/dm-sent` change no shared projection, so neither advances its version nor wakes subscribers. A private reminder does invalidate its Task Thread scope: that is how an open Human Inbox learns about it, without turning it into public Thread history.

  Presence uses a process-local epoch; other scopes report the latest shared-projection ledger sequence. Versions are meaningful only within their scope and Host lifetime. Host recomputes Inbox hints only for Members affected by an operation.
- `TeamChangeStream` shares one logical stream per scope within each page through `ctx.remote.$stream()`; Harness owns the shared `/api/remote.mux` WebSocket and connection recovery. Each new baseline, including an unchanged or lower version after reconnection, requests a fresh Host read. This closes the initial-read race and recovers failed reads without a new commit. The last listener leaving disposes that scope; plugin disposal closes all scopes. Carrier failures are reported once until recovery; terminal failures are reported without a Team-owned retry loop.

  Team has no long-poll fallback, cross-page leader election, or single-active-page restriction. Concurrent supplemental reads coalesce notifications and retain a trailing read when another notification arrives during a fetch, rather than suppressing reconnect baselines by an old version. The Human Inbox badge subscribes without a scope, debounces Inbox totals, and also refreshes after local Thread reads. Presence subscriptions update Member availability without waking the Inbox. Notifications are invalidation hints, never a second facts store.
- Read projections are bounded by purpose. `view` answers the requested fact page plus the Thread it names: its catalog fields carry that page's Tasks, Threads, display ordinals and Claims. Only `includeCatalog` returns the Task/Thread/Claim catalog of the whole request scope — the address-book projection the model-facing `team_view` renders.
- Agent views additionally request `includeWorkspaceDirectory`: a separate directory lists every active Project, its owners, the reader's `owner` / `following` / `none` role and subscription counts, plus the Workspace Member roster. Under rules version 9 participation in the Workspace already authorizes the content catalog, so the directory adds no gate; on earlier versions it listed `directory only` Projects without leaking Threads, Tasks, or Claims.
- A page read walks the fact ledger until one match past its limit; a catalog read adds one directory filter over the Threads in scope plus one live-Claim lookup per Task row. Those are the components to report separately, never as one total: a returned row count alone does not show what a read walked.
- Claims are bucketed per Task by a replay-derived index, so a per-Task read — a Claim list, a Thread picture, an Inbox row, the Task board — never walks the ledger's whole Claim set. Every index here is rebuilt by replay, never a second durable authority.

## Session persistence and replay
- The bundle targets DSH `0.2.2-rc.2` and uses the current DSH Session persistence: the shipped JSONL backend migrates released historical formats itself (v0/v1/v2 → V3 → V4), and old-format Session data needs no manual disposal. Team nevertheless retains a narrow replay normalization for old pre-Message `occurredAt` records, and exactly one record shape still reaches it: the pre-receipt `team/thread-read` snapshot, which froze Message anchors and Thread facts beside the Inbox delta it consumed.

  That is the only Thread-read form that stores an instant at all — the receipt every current read writes carries progress and its Inbox delta only — and it is normalized and validated in place, never rewritten. Do not add Team Session migration, broad compatibility reads, or fallback storage paths.

## Attention and Inbox authority
- Thread Attention is private Member × Thread state. The Host is the only Inbox authority. Session history may retain bounded notification context but never a parallel unread projection.
- The Inbox read ranks the reader's whole unread queue, then materializes preview text, the instant's person and live Claim owners only for the rows it returns; its totals stay whole-queue, so a one-row badge still reports every unread Thread. `threadObservations` returns the newest `limit` observations with `hasMore`, and its follower set is always the complete current state.

## Sessions, policy, and context pressure
- Team-managed Agent sessions use the explicit Team preset and trusted `danger-full-access` policy. An untitled Member session receives its handle as a title; explicit or previous titles win.
- Member context is owned by two Host-side mechanisms and no model tool (see Tools and preset): Team controls request budgets through its preset adapter over the Harness's `BasicCompactionEngine`, which shortens an oversized Session in place, and the generation coordinator swaps a cold Session at a wake boundary, recording `team/member-session-recycled` as the Host actor. [`memory-and-context.md`](../team-collaboration/memory-and-context.md) owns the pressure and wake thresholds.
- A swapping generation reports unavailable with a `rollover` diagnostic until its successor activates, so a Client following the row never opens a Session that does not exist yet.
- A swap carries input, not context: the commit records the retired log's offset and the successor replays only the input at or after it, deduplicated by Message id, using the original durable inbox insertions even for already-claimed input. Nothing is copied through process memory (see [Tools and preset](tools-and-preset.md)).
- Pending/error bookkeeping is process-local; only compactions in a transaction add Session history.
- Terminal recovery classifies each `agent/error` from structured Harness data before any wording. The stable code decides alone — `RATE_LIMIT` is rate limiting, `TRANSPORT`/`TIMEOUT` a transient network failure, an explicit 429/503 response rate limiting — and any other code (quota, auth, context, request) stays manual whatever its message says. Only a codeless error falls back to the narrow message signatures.
- `agent/error` owns terminal recovery with its consecutive-error limit, and the failure keeps its recorded Member diagnostic.
- A Team wake discarded before any `turn/start` is the one error diagnostic with no `agent/error` behind it. A Team-owned Inbox or recovery notice that leaves the queue before the turn opens, and that the Host did not replace or dispose, records a `runtime` diagnostic with `source: 'agent/inbox/discarded'`, the `sessionId`, and `occurredAt`. A notice the Host replaces or disposes raises nothing, so ordinary replacement never errors. Like every runtime diagnostic it is process-local, re-derived only on the next wake.

### Generation swaps and input replay

The generation swap is owned by `team-context-management.ts`, Team's own coordinator. It starts from a Host wake decision rather than a durable intent, executes through the serialized lifecycle queue, and takes the successor's identity from the retired Session so a crash converges on one successor:

1. wait for true idle;
2. recheck the owned-jobs guard and the ordinary-input queue at the commit seam — a queued ordinary message defers the swap;
3. inside `agent.runMaintenance`, commit the idempotent `team/member-session-recycled` operation as the Host actor, recording `inputFromSeq` (the retired log's offset) when a live generation exists;
4. retire the old generation: its pre-step gate rejects the step without a model request, then dispose and archive (never delete); the original inbox insertions remain in the log even if already claimed;
5. activate the fresh Session, whose lineage the ledger transition already records (its header carries no `parentSession`, which names a subagent's creator);
6. fold the retired log from `inputFromSeq`, drop every message the successor already holds by id, deliver the rest by followup, then rederive the Inbox from the ledger.

Maintenance is what makes the commit safe against input arriving mid-swap: the loop is parked there, so a new message waits in the durable inbox instead of reaching the generation being retired. A failed commit releases maintenance and the old generation continues; a committed one retires it, and startup or recovery finishes a swap interrupted before the replay.

The successor receives the wake message and the context defined by [Member context injection](../team-collaboration/memory-and-context.md#member-context-injection). There is no handoff envelope or generation announcement.

The fold is Team's own `contextContinuity` projection unit, registered once per host at Team service init. `context-projection.ts` owns the durable checkpoint-ref naming, the Team-notice rule, the fork cut, and the folded state a generation reads back: its checkpoints with turn-end delivery state, one possible legacy rollover intent, continuation delivery records, and unconsumed non-Team input. The tool names it still decodes (`context_rollover`, `new_context`, `context_checkpoint`) are decoders for logs written by earlier builds, not tool aliases.

`context-codec.ts` writes the one envelope this build still produces, the quiet checkpoint continuation. Recognition of that envelope, and of the two shapes earlier builds wrote, lives in `context-source.ts`; the handoff writer survives only as a test helper for those legacy shapes.

Crash recovery is log-derived. An interrupted swap is finished from the recorded binding and the retired Session, and a legacy pending intent whose containing turn never ended durably is spent and discarded instead of leaving the generation permanently un-swappable.

Carried-input replay is bounded and keyed by Message id. A swap records `inputFromSeq`, the retired log's offset at commit, so the fold counts only input at or after that boundary, and the retired Session's log is the only source — no message content is held in memory for the carry. A successor that already started its own turns is not skipped for that reason: the boundary and the successor's own log and inbox queues decide which messages it still lacks. Only a legacy transition without `inputFromSeq` skips the replay along its started generation.

`agent-instructions` messages are regenerated by the successor rather than replayed as standalone turns.

A canceled inbox splice does not identify who removed the message. Replay must preserve input cleared by disposal, so an explicit queue removal or replacement racing this swap can also be replayed. Ordinary Session cancel retains pending input by design; this limitation concerns queue editing during the transition.

An unreadable retired previous Session fails open with a warning for two bounded classes — log corruption (`corrupt session log`, whose torn tail the Host repairs) and a deterministic released-format refusal (`SessionFormatUnsupportedError`, which no retry can change) — while missing, IO, and unknown causes stay fail-closed. A wake swap with an input boundary keeps this check even after its successor has run.

Whether a Member Session has durable persisted content is decided through session-persistence inspection (which awaits in-flight retirement drains), never a bare metadata listing that races a suspend's final flush.

The wake decision itself is a pure gate ladder in `wake-recycle.ts`: disabled, no prior generation, unreadable activity time, a cache possibly still warm, and a context below the waterline each answer resume, and only a cold gap over a large enough context recycles. [`memory-and-context.md`](../team-collaboration/memory-and-context.md) owns the thresholds and the configuration group.

## Private memory, archival, and identity effects
- The Member preset derives identity, Project ownership, Workspace participation, and private-memory context from current Host facts and the current Session surface. Classification and memory-update rules are defined in [Member context injection](../team-collaboration/memory-and-context.md#member-context-injection); this creates no second durable state store.
- `workspaceRulesForAgent` resolves which [Workspace rules](../team-collaboration/memory-and-context.md#workspace-rules) files a Member or the current manager reads; the files are Team-owned, not ledger facts, and the Host only reads them.
- Private-memory directories under `$DSH_HOME/agent-team/members/` are Host-owned effects of Member identity. Activation ensures the directory, `notes/`, and missing `memory.md`; startup does not prune unknown directories. Explicit removal archives the Session and removes that Member's private directory; unrelated entries remain untouched.

  Both that removal and the activation-time rename of a pre-fix colon directory are confined to the running process's own members root. The recorded `privateMemoryPath` is a durable absolute fact that names a directory in whichever DSH home added the Member, so a process resolving another home refuses to move or delete it (with a warning) instead of taking the Member's real private memory out of its home.
- Archival hides a Member or Project while retaining its facts; it is not removal. There is currently no restore entry point. `archiveMember` commits `team/member-archived`, disposes the live session (private memory and the Session log stay on disk), archives the Session from grouping surfaces, and releases the Member's active Claims with public `claims_released` Activities plus Attention/marker cleanup. A hidden Member must not leave Tasks stuck in progress or phantom unread counts.

  `archiveProject` commits `team/project-archived` with the same release shape across every owner on the Project's Threads; the Project memberships earlier rules versions derived survive both archival forms as stored facts (hidden state, not departure).

  A partial Project edit merges inside the ledger's serialized section: `updateProject` keeps the stored name or description for every field the request leaves out, and a replay compares only the fields it stated, so an edit queued behind a concurrent one never writes back the snapshot its caller read before it queued.

  Archived entities are excluded from active collaboration surfaces — projections (view projects/threads/tasks/members, mention candidates, Project joins, edits), ref resolution (`resolveTaskRefs`/`resolveThreadRefs` skip them so message bodies render plain text), and ref-addressed reads (`readThread`/`threadHistory`/`threadObservations`/`listClaims` reject with an explicit archived error, never an unknown-ref disguise). The facts stay complete in the ledger for replay and a future restore, and that boundary is the archival-vs-remove divide.

  Removal from archived stays available as the data hygiene path, and there is deliberately no restore entry point this round (mirroring archived dsh sessions). Ledgers written before Project archival omit `project.state`; the record schema normalizes it to `active` at load.

## Member capabilities and skills

### Durable intent and turn-boundary effects

- Member capabilities (`capabilities` on the Member entity: reserved `tools.allow`, `skills.allow`) are durable intent carried verbatim by every lifecycle operation. Committing performs no known-name validation so old ledgers stay replayable across Harness upgrades; divergence is derived at activation as non-persisted `capabilityWarnings`. `tools.allow` is a deliberate interface reservation: it has no UI write path today.

  Edits are partial updates: an omitted field keeps the stored value and an explicit `null` clears it, so a caller that does not manage capabilities can leave the field out and any Remote-written override survives. `model` is deliberately not clearable — see the model contract below.
- Activation restricts every Member before preset validation (mount → restrict → validate), even without `tools.allow`. The allow-list can only narrow the preset baseline, retaining the Team tools and `working_directory` — `team_worker` only while the Worker switch is on — and names outside that baseline drop with a warning. Tool filtering, execution checks, fallback, and their limits are defined in [Tools and preset](tools-and-preset.md).

  A profile-wide `extraToolGrants` list in the Host row is a separate permit by exact registered tool name: it may reopen an inherited baseline name the Member allow-list omitted or admit an Agent-scoped registration, but cannot reopen Team tools, `working_directory`, or the Worker switch. The Host reads it synchronously at `turn/start`, freezes it for that turn, and gives later turns the latest saved list.

  Team tools survive every allow-list, so a Team tool that would make the Host run code checks the enforced surface itself: an Agent's subscription create, update, test, resume, or replay is refused unless the restriction currently installed for that Member admits `bash` or `pwsh`, and a Member with no installed restriction counts as having none. See [`team_subscription`](../team-collaboration/tools.md#team_subscription).

  A `team_message` `attachments` path is the same shape of reach: it asks the Host to read one Host file the Member could read itself, so an Agent's start, reply, or post that carries one is refused with `attachment_read_required` unless the Member's enforced surface admits `read`, `read_image`, `bash`, or `pwsh`.

  The path is then held to the calling Agent's working directory, checked lexically before any filesystem call and again after `realpath`, so an absolute path elsewhere, a `..` escape, or an escaping symlink refuses the whole send without touching the cache. The Human Remote path carries no Member surface or working directory and keeps only the ordinary validation. See [`team_message`](../team-collaboration/tools.md#team_message).

  Editing the allow-list on a live Member swaps the restriction at a turn boundary in the same Session: idle Members apply immediately, and a running Member's edit waits for that Member's turn to end. Each Member owns one lifecycle chain, so the wait holds only that Member's later operations, still in submission order, while managing another Member never queues behind it and the ledger keeps its single ordered writer.

  After each awaited boundary, capability and Worker-exposure edits synchronously recheck the live handle and true idle. A new turn delays the swap again rather than replacing its frozen grants. Shutdown releases the wait without allowing another observer or restriction to be installed on the retired context.

  Host shutdown releases every pending wait instead of waiting out a turn that may never end, and a Session disposed outside the chain also releases it. A stop cancels that Member's in-flight turn and then waits for the Agent to quiesce, so a stop queued behind a parked edit reaches the boundary after that edit has applied and then usually finds the Agent idle. A stop never clears or aborts a committed configuration: the edit either applies at the boundary or reports a deferred effect, and either order leaves the stored intent in force at the next activation.

  Waits are logged by class with their Member, Session, and duration: `stage 'wait-turn'` for waiting on the Member's own turn, and `stage 'wait-external'` for external execution such as the Agent releasing its Session write path. Restriction failures during activation surface as that Member's activation failure.
- A failed live apply of Member capability intent never widens the surface: the edit keeps its ledger commit, a no-grant edit leaves the previous restriction in force, the Remote call surfaces the failure, and retrying the same request re-applies the stored configuration without a second commit. The Host compares stored intent against the capability effects the runtime has actually applied, never against the requesting call's own history.

  A failed profile grant policy instead tightens to the no-grant Member baseline, never back to the previous grant-bearing restriction. If that baseline fails too, the next step is refused before a model request.
- Configuration edits report their effect separately from their commit: `updateMember` returns `effect` as `applied`, `already-applied`, `deferred:no-live-handle`, or `deferred:generation-changed` (saved now, applied at the next activation). A failure never appears as a value — it stays a rejection and is also kept as a routable `model-apply` or `capability-apply` diagnostic, named for the stage that failed, whose `detail` carries requestId, operationId, stage, and reason with the Session in `sessionId`, logged under the same correlation group.
- The manager surface answers a committed edit whose live apply failed differently: `member_update` reports `failed:model-apply` or `failed:capability-apply` as the effect, matching the stage that failed, and carries the Member's own diagnostic of that class in `status`, because its write is already committed and its caller is a model that would retry a rejection.

  The stored intent stays for the next activation to retry, and replaying the request retries it too: the effect is derived from what the live generation runs against the row as it stands, never from the record the request started from.
- A lifecycle replay finishes only what its own operation owes: `suspendMember`, `resumeMember`, and `archiveMember` read the Member row as it stands after the write and converge the runtime to that state, so a late retry of a suspend cannot dispose the generation a resume activated, and a replayed resume cannot revive a Member a later suspend stopped. The answer reports the same row, while the receipt stays the original one.

### Model route persistence

- A Member always runs an explicit route. Creation requires one, an edit replaces it but never clears it back to the Host default, and the only two writers are the Human's edits (this section) and the Member Session itself (below). Ledger records written before this contract omit `model`; they still read, and they wake on the Host's default selection at that moment.
- A model edit commits and reports like any other edit, but whether the new route takes effect is upstream's call: a switch whose new window cannot hold the Session after compaction is refused with the previous route kept, so the pending selection waits for a compatible model while the recorded intent survives either way.
- The composer is the other entry point, and it does not reach the ledger on the selection event. A Member Session's `request/header` is what proves the switch passed the Host's compaction guard and entered a real request, so the Host records the route from `header.config` as one Human `team/member-updated` operation. Only the route is written: the reasoning tier stays a Session-log fact that activation re-reads for the same route.
- Three requests write nothing. One is a request on the route the Member already runs, which includes the route Team itself wrote back when it activated that Member — so the write-back cannot feed itself through the ledger. Another is a switch the Host refuses: it never logs a header, so it never writes. The third is a header the Member has already moved past: a pick made after that step fixed its route is newer, and writing the header's route would put the replaced one back.
- Every roster row carries `capabilityState` (`applied` | `pending`). It compares that Member's stored `capabilities` with the capabilities applied to its live runtime; a Member without a live runtime reports `pending`. It is separate from `availability` and `presence` and does not report whether the profile's `extraToolGrants` took effect on a turn.

### Isolated skill catalogs

- Team skills use an isolated registry inside each Team preset. Its only registered provider is Team's router, which selects the exact Agent's filesystem provider; Host-global providers and runtime skills never enter Team discovery, loading, explicit `/skill` invocation, or the model catalog. The same registry backs the shipped Session skill catalog and the `skill` tool. Ordinary Sessions keep using the Host registry and all their configured global skills.

  The Host runtime passes its Team registry into the provider mount explicitly. An ordinary `agent.ctx` lookup resolves the Host registry when both exist and cannot find the Team mount.

  A mount handle can change selection or unmount only its own provider. Once replaced, the old handle cannot affect its successor. Routing and filtering preserve incomplete discovery results, so the registry can show the candidates it found and retry discovery.

  Each Member provider scans exactly two Team-owned roots with default roots excluded: the plugin's bundled read-only core skills (`packages/agent-team/core-skills/`, first — a same-name bundled skill stays stable across upgrades) and the Member's writable `$DSH_HOME/agent-team/members/<member-directory>/skills/` (the Member id with `:` replaced by `-`).

  The Team manager Session gets the same isolated shape from its own runtime, with the two roots swapped for manager ones: the read-only `packages/agent-team/manager-skills/` (first, and checked by the same `check:core-skills` gate) and the writable `$DSH_HOME/agent-team/manager/skills/`. No Member root and no manager root crosses over.

  A Member catalog therefore starts with the bundled set (the `member-skill-manager` meta skill, which owns all skill craft guidance — the persona itself only states the private-space physical facts). Installing is writing into the Member's own directory (directory form `skills/<name>/SKILL.md` with optional references/scripts, or a flat `.md`), there is deliberately no upload Remote, and the filesystem watcher feeds discovery.

  `skills.allow` filters `list()` output through a live selection swap on the mounted provider (edits swap the filter and invalidate the catalog at the same turn boundary as tool edits); filtering is a visibility semantic, not a security boundary — both roots stay scanned and watched. Member removal deletes the private directory with its skills; suspend/resume and Host restart restore the identical catalog.

## Host service surface (`ctx.agentTeam`)

The Host row publishes one service, `ctx.agentTeam`, consumed in two distinct ways with different stability promises. There is no CLI and no `bin`: the Web Client is the only Human control surface, and every change reaches the Host through the typed Remote. The one HTTP entry the bundle mounts is the webhook ingress below, which is not a control surface — it carries an outside service's request and nothing else.

- **Remote methods** (the `@Remote`-decorated ones, e.g. `members`, `view`, `addMember`, `updateMember`, `sendMessage`, `readThread`, `inbox`, `humanProfile`) are the Client contract. They are typed through Typert artefacts generated from the declarations, so the Client, the model-facing tools, and any other consumer compile against the same shape; changing one is a contract change.
- **Host-only service methods** (e.g. `memberForAgent`, `membersForClient`, `status`, and the activation/lifecycle internals) exist for in-process Host callers — the preset row, commit listeners, and startup derivation. They carry no compatibility promise and may move between releases.

Only Remote methods carry a compatibility promise.

A preset row must resolve `ctx.agentTeam` while it runs, never capture it statically at declaration time: the service is provided when the Host plugin starts, so a row that closed over it at import time sees nothing. The same applies to `ctx.get('agentTeam')` in external code, which is undocumented use of an internal surface rather than a supported integration point.

## Subscription scheduling and unattended execution

`SubscriptionScheduler` (`subscription-runtime.ts`) owns timers and failure accounting. It admits four script runs globally, including owner trials, and never runs one subscription concurrently. Each subscription has one queued timer entry; later due instants merge into it. Publication is limited to 20 events per subscription per minute.

Admission rereads the ledger. A queued trial or timer cannot run after deletion or Project archival. An input-read failure logs and keeps the entry queued; a definite refusal removes it and settles the caller. Terminal subscriptions neither publish nor retain checkpoints.

### Private history and cleanup

`subscription-store.ts` owns the private `agent_team_subscriptions` domain:

| State | Retention and purpose |
| --- | --- |
| checkpoint | Next due time, consecutive failures, publication window, and last success; restart resumes from it. |
| `runs` | Newest 50 runs per subscription. |
| `deliveries` | Webhook deliveries whose automatic retries are exhausted. |
| `replays` | Intent and answer for each replay request. |
| `admissions` | Accepted webhooks still owing execution, acceptance, or a replayable failure; includes the received definition and any batch held back by a full queue. |

These rows are not Team ledger facts. Deleting a checkpoint cannot rewrite an event, but does change scheduling and failure accounting.

A run records its trigger, start time, duration, category, exit code or timeout, accepted-event count, and the last 8 KiB of each output stream. Identity travels with the summary: `subscriptionRevision`, `scriptHash`, `runRef`, and, for a delivery, `deliveryRef` and retry attempt.

Event counts measure ledger acceptance, not printed output. Trials, refused batches, and already-known event ids add no accepted events. Trials enter history except a create's draft trial, which has no stored subscription to own the record.

Deletion clears all private tables and the checkpoint before reporting completion; boot converges interrupted cleanup. Project archival clears the same state immediately. Cleanup and private writes share a lock, and every write segment rechecks terminal state: a segment either precedes cleanup or writes nothing after it. Deletion between segments cannot recreate rows.

Any authorized Project reader sees run summaries and identity. Only the Human and owners see output tails and explanatory text, whether the run succeeded or failed, because scripts use Project credentials. `team_subscription logs` and Remote `subscriptionLogs` read the same history.

### Success, failures, and publication limits

Success is linearized at durable output acceptance. Acceptance, consecutive-failure reset, and last-success time share one locked segment; later settlement only advances next due time. Exit 0 with no new events uses the same successful zero-event acceptance.

Scripts run outside the lock so they do not block deliveries. Every checkpoint update uses locked read-modify-write, never a whole row composed from an earlier read. Thus concurrent failures cannot be lost between reading and writing a success reset: three failed deliveries count three times and the third pauses.

Only a result pinned to the current revision changes its failure count or last-success time. Older results remain in history under their own revision without clearing or extending the current streak.

The unpublished-event ceiling is 500:

- A subscription already at the ceiling is skipped before script execution; the skip counts no failure.
- A single batch over 500 is refused permanently.
- An interval batch that would overflow the current queue fails.
- A webhook batch that fits the ceiling alone but not the current queue stays on its admission until room opens; its request cannot be fetched again.

Interval and webhook failures count; trials neither count nor clear. A resume clears only after its successful trial and durable commit. Three consecutive failures cause a Host-authored automatic pause and one Main stream marker per owner, including the Human, regardless of follow state.

A spent delivery retains its stable ref, received revision and script hash, that version's script and credential references, stdin request body, last error, and seven-day expiry. At most ten are retained per subscription. It can outlive run history and counts one failure regardless of retries or provider redelivery.

Ingress writes are not scheduler admissions, so ingress checks terminal state itself before writing. Deleted subscriptions and archived Projects cannot regain private rows through a late delivery.

### Replay receipts and committed retries

`replay` uses the current definition by default or the received version explicitly. It publishes through normal acceptance, with the same four slots, per-subscription exclusion, and shutdown convergence. Pause, deletion, or Project archival refuse admission. A successful replay clears the streak; a replay script failure adds no failure.

Before execution, `replays` durably records `requestId`, delivery, version, and `running`. Failure to record intent refuses execution. Once recorded, the id is spent: another delivery or version under it is a collision, even if no answer survived. A delivered replay cannot run again under a fresh id.

A retry of a still-`running` replay never executes it automatically. If the ledger contains its acceptance, it returns that result; otherwise it reports the missing answer and offers an explicit new request id. Settlement writes the answer and delivery tombstone in one locked segment, ordered wholly before or after deletion.

Settlement storage faults are logged without hiding what the run already delivered. The answer expires with its delivery.

Current create/update operations also retain original script source, trigger options, and create baseline. After current actor and Project authorization, committed retries resolve that intent before file reads, origin checks, credential lookup, or execution.

Older operations compare stored normalized fields. Pasted scripts remain exactly comparable; an unverifiable legacy path retry is refused with the committed `subscriptionRef`, so the caller can inspect it before choosing a new request.

### Webhook ingress and durable admission

The bundle's `webhook-ingress` row mounts a separate WebServer under `isolate: { webServer: true }`. It does not share the browser API listener. The row mounts the listener itself: naming the Harness-protected WebServer module in composition would prevent disabling the bundle.

The listener binds `127.0.0.1`, port `DSH_TEAM_WEBHOOK_PORT` (default 3081), and accepts only `/team/hooks/<token>`, not nested or longer paths. Public exposure requires a tunnel or reverse proxy and a matching `webhook.publicOrigin`.

Token hashes are compared in constant time across armed subscriptions. Resetting an address, dropping its trigger, deleting its subscription, or archiving its Project makes the old address return 404. Reset changes the address, not already-queued deliveries.

| Response | Condition |
| --- | --- |
| 202 | Admission row is durable. |
| 404 | Unknown token, deleted subscription, or archived Project. |
| 409 | Paused subscription. |
| 429 + `Retry-After` | Ten deliveries already queued or retrying. |
| 413 | Body exceeds 256 KiB. |
| 431 | A forwarded header value exceeds 1 KiB; never silently truncated. |
| 415 | Non-identity `content-encoding`. |
| 400 | Body is not UTF-8. |
| 405 | Method is not POST. |
| 5xx | Admission storage failed. |

Size and encoding checks preserve the bytes a provider signed. Scripts receive only lowercased `content-type`, `user-agent`, and headers matching `x-*-event`, `x-*-delivery`, `x-*-signature*`, or `x-*-timestamp`; never authorization, cookies, API keys, or proxy-added headers.

Scripts read `{headers, body}` on stdin with `DSH_TEAM_TRIGGER=webhook` and the admission id as `DSH_TEAM_DELIVERY_ID`. The same identity survives retries and replay. A restart after durable admission but before the 202 response leaves the work queued.

Shutdown stops new queue passes, drains the scheduler, waits for the active webhook pass, then closes storage. Owed work remains for the next Host.

Failures retry after 1, 5, and 30 minutes. The fourth failure becomes a replayable `deliveries` row; a batch over the ceiling goes there immediately. A successful retry ends the delivery without counting a failure.

Before writing the replayable failure, Host records exhausted retries and failure-streak eligibility. Interrupted settlement resumes without rerunning the script; an eligible delivery counts once and may commit one automatic pause. Pause permits settlement; deletion and Project archival discard outstanding work.

A committed resume starts a new streak even if checkpoint persistence needs retry. Later success or resume prevents older pending settlement from counting again. A definition edit also prevents old settlement from counting or pausing the new definition, but preserves failures already counted. Timers wait for pending failure or pause settlement.

Reset mints a token and increments `generation`, not revision. Accepted deliveries keep their received version. Only the returned address contains the clear token; the ledger stores its hash.

Committed create/update/reset retries report `webhookAddressGone` only if that operation armed an address. For update, Host compares the previous revision; retaining an address does not report it gone, even when both writes share a millisecond.

### Script execution boundary

Runtime tests use fake clocks and executors through ports. Production uses `ctx.shell`, as the Member shell tool does, with Host-built policy from the trusted Workspace: `workspace-write` rooted there, 60 seconds, 65,536 bytes of stdout, and no escalation. The cwd is that Workspace, never Host cwd; hard-coded checkout paths therefore fail after a move.

Team sets `ShellExecSpec.stdoutMaxBytes=1` to force a public `spillPath`, then reads and bounds the complete raw spill and removes it. The provider's default `maxSpillBytes` is 64 MiB. Missing, oversized, or incomplete spill is refused, not reconstructed from decoded text.

Stdout must be complete valid UTF-8, at most 65,536 bytes, with one validated JSON object per line. These are Team runner bounds, not caller/tool options. A valid-looking tail is not a complete stream.

The mounted shell family is behavior-probed once and cached. A snapshot from another family fails rather than running under the wrong shell. No executor yields `executor-missing`; a mounted executor whose policy probe cannot spawn yields `spawn-failed` with its own refusal. Without a usable sandbox backend, no subscription runs.

Acceptance pins revision and script hash; publication observes the budget above. Credentials resolve per run through `ctx.credentials` and merge after the executor's environment scrub. Team constructs only managed `DSH_TEAM_*` facts and declared credential references, forwarding none of Host's process environment itself.

### One Host per DSH home

Run at most one Host per `$DSH_HOME`. Timers and private checkpoints do not enforce a process lock; two Hosts would each schedule work and race ledger projections and sequence numbers. Concurrent profiles need separate homes. Never start another `dsh web` against an occupied home.

## Worker delegation

The Host owns the authorization and the execution record of every Worker a Member delegates; the Harness subagent service owns admission, activation capacity, and the completion notice. The two are wired by `WorkerRegistry` (`packages/agent-team/src/worker-service.ts`) and `TeamWorkerProvider` (`packages/agent-team/src/worker-runtime.ts`).

The subagent service follows the Host, not the Member: one `@deepseek-ai/dsh-subagent` mount with one provider row per enabled engine is what the Team composes, and a Member's tool call reaches it from that Member's own Agent context, passing that live Agent as the activation's `parent`. Mounting a provider per Member would register the same projection once per Member and give each Member its own activation tree, so it is not the shape.

Authorization is decided from the ledger at call time, never from the current page or directory: the target must exist and agree with itself, the caller must be one of the current Agent owners of the Project it belongs to, and the Host settings row's `worker` group must have the switch and that engine both on. The Human owns every Project but does not call Team tools, so no Human path exists. Any refusal happens before a native process starts, and a `requestId` already admitted answers with its own execution

That answer belongs to the Member and delegation that opened the id: two concurrent calls under one id open one engine, and a resend naming another Member, task, engine, or target is refused instead of answered.

### Engine policy and exposure

The provider opens one OAR session per delegation with the operator's explicit engine settings, and carries the row's Codex permission mode into that open: the pinned OAR 0.95.1 reads it from the Host process's own `OAR_CODEX_SANDBOX` — a session's `env` only reaches the child process, and the library exposes no per-session option — so the value is set for the open call and restored once the app-server handshake returns — the one window in which another Codex session opening in this Host would see it.

The row's switch also decides the Member surface, not only the execution: while it is off, `team_worker` is not declared to Members, and a live edit reaches existing Sessions at their next turn boundary. The same switch governs the Worker paragraph of the `team:project-owner` prompt section, which is re-derived at every assembly. The registry still refuses a start while the switch is off, so a surface that has not caught up yet is never an execution path, and a run already in flight keeps its handle.

A row that never stored the policy resolves to `danger-full-access`, and Claude needs no policy of its own: both engines run gate-free in embedded use, where an approval prompt nobody sits at is a hang rather than safety, so the bundle adds no second permission gate to work the operator already delegated. Narrowing a Worker is the operator's explicit opt-in, and the field exists only for that: the settings page shows the switch and the engines, not the policy, so a narrower Worker is a hand-edit of the row rather than a form field.

The provider keeps the engine's native session identity and working directory, and captures the anchors a read-only diagnostic needs — the native turn and the absolute path of the engine's own record — on the result object itself. Codex reports that path; Claude's stream carries none, so it is derived from the cwd the CLI reports and the environment the run opened with (`CLAUDE_CONFIG_DIR`, else `$HOME/.claude`), and a wrong guess reads nothing rather than searching for another file.

It uses the pinned `@botiverse/oar` package directly rather than the Harness OAR provider, because a Worker must expose that native identity and Team must own the execution record; the library is imported on demand, so a Host without it still boots and every ordinary Session is unaffected.

A delegation is bound to a target before anything is written: `taskRef` fixes its Thread, `threadRef` alone fixes the Thread and that Thread's own Task, and `projectRef` alone is a Project-only delegation. The Thread or Task decides the Project the ownership check runs against, and a Task named against a Thread that is not its own is refused as contradictory. Every refusal happens before the opening record and before any native process. What the binding wrote is frozen: a later page, directory, Membership change, or Task transfer does not move a run's result.

Two record shapes follow from that binding.

A **bound** run keeps two ledger operations — `team/worker-started` and `team/worker-settled` — and the Thread carries their public facts `worker_started` and `worker_settled`. The start fact says a run began and names its engine; the terminal fact adds its `state` and, for a failure or a stop, a single-line `reason` of at most 2000 code points.

The answer a Worker gives is never public. It stays in the terminal operation's private payload with the task text, the working directory, the native session identity, and the full diagnostic, and reaches the initiator alone through the Inbox notice that the same commit wakes them with — labelled as external text that is data, not instructions. Any participant can therefore see that a run happened and how it ended, and only the Member who delegated it (or the Human) reads what it said. The activation uses caller delivery, so the parent Session receives no second copy.

That makes the record the only holder of the text, so a run that fails or is stopped keeps what it had already produced: the ending says how far it got, and the state word alone never stands in for it.

An **unbound** run stays what it was before on the public face: parent delivery, no Thread fact, nothing published to the Project. Its execution record is written all the same — `team/worker-started` and `team/worker-settled` exist for every run this Host starts — which is what keeps a Project-only execution findable by its `worker:` ref later.

Rules version 6 introduced both operations. Version 7 extends them with an optional continuation link on the start and optional native turn/input arrays on the ending; a version-6 Worker record without those fields still replays unchanged. The new fields are refused in a version-6 segment, and a build implementing only version 6 stops at a version-7 marker before it parses the Worker operation.

The durable state of a bound run is derived, never stored twice. `threadWorkerStates` reads the execution records rather than the facts a page returned, so a long Thread reports the state of every run bound to it even when that run's facts sit outside the window.

A record still marked `running` with no live execution in this Host reads as `unconfirmed`. This can follow a Host restart or an ending that has not reached the ledger. The run is not restarted or retried automatically, and `unconfirmed` writes no fact and wakes nobody.

One stop transaction covers both surfaces: the Member's `team_worker` call with `stop` and the Human's `stopWorker` Remote enter the same `WorkerRegistry.stop`. Authorization is the identity that opened the run — its `initiatedBy` Member, or the Human — and deliberately not the start conditions, so an ownership change, a transfer, or the settings switch being turned off never decides a stop.

The transaction aborts the startup signal (the only cancellation channel before publication), disposes the published activation, and waits for the one terminal write the engine's own evidence decides. `stopping` is a derived, process-local view: the ledger keeps `running → terminal`, and the Thread read and the Human's list add the word while the stop is in flight.

The engine's result decides the ending, not the request. A natural completion or failure that landed first keeps its real state and the stop answers with it.

Every terminal result waits for native cleanup, bounded at ten seconds; a cleanup that rejects or exceeds that bound turns the ending into `failed` with an unconfirmed-cleanup diagnostic. A cancelled run whose disposal rejected is therefore never `stopped`, because a stop nobody confirmed would be a claim the Host cannot support. The partial output the run already produced rides that same result, so the one Inbox notice keeps the text and the caveat together.

Unloading the bundle is the same transaction at Host scale, in order: refuse new delegations and continuations, cancel every start still opening — including one whose opening record is still being written, which is sealed instead of opening an engine — and wait up to five seconds for those starts, continuation admissions, and active steer calls before disposing what is published. A continuation still reading native history or writing its opening record therefore either completes before storage closes or rechecks the unload fence and writes nothing.

After that opening wait, the steer persistence fence refuses late alias admissions and outcome writes. Unload waits up to eleven seconds for each ending: the native cleanup's full ten seconds, plus one second for its outcome to reach the durable record. A cancellation whose cleanup confirms in that window records `stopped`; a cleanup rejection or timeout records `failed` with its diagnostic.

Anything still without an ending at that boundary is sealed: the run keeps its `running` record, reads as `unconfirmed`, and accepts no later ending, so closing storage cannot race a write into a ledger nobody reads. Pending terminal and steer writes are awaited before the provider registrations are released; the eleven-second deadline does not cancel a storage write that has already started but stopped answering.

The Human's surface is the edit-Agent dialog, which gives that Member at most five rows: the live runs (`running`, `stopping`) and the records a previous Host left running as `unconfirmed` hold their seats first, and the newest endings by ending time fill the rest — a long run that started early and failed just now stays inside that window — each with the ending the Host confirmed, and a diagnostic door on every run that ended.

Its `stopWorker` receipt is structured: `ended` names the recorded ending and any diagnostic, `pending` means cleanup or recording is still in flight, and `unconfirmed` means the Host lost the live handle or could not record the ending. A run listed as `unconfirmed` has no stop control. A failed request that returns no receipt does not decide the run's state.

### Reading one run's diagnostic

The anchors a look-up needs are written with the run's ending, never collected afterwards. The provider knows the engine's native session as soon as it opens, captures the newest 128 turns and native input UUIDs this execution accepted plus the absolute path of its record — reported by Codex, derived for Claude — and carries them on the result object itself: a non-enumerable property on the object the Harness hands back unchanged, not a module-level map. A sealed run, or one whose ending lands late, therefore leaves nothing behind to collect.

The capture happens while the session is still open: before an abort or a cleanup begins, and after the accepted inputs have ended. An engine closes its record stream as it tears down, so a capture taken afterwards would find nothing left to read. Turns and inputs are bound to the UUIDs this execution submitted; a resumed conversation's older turns are not claimed as this execution's own.

A capture that fails changes no outcome: the ending keeps the state, diagnostic, output, and native session identity the engine already established, but lacks the turn or storage evidence the failed capture could not establish.

`readWorkerHistory` (`packages/agent-team/src/worker-inspection.ts`) is the only reader, and it reads both engines' records through one bounded pass: the engine chooses which fields identify the session, the turn, and a failure, and nothing else changes. It refuses a recorded location that is not an absolute `.jsonl` path under the engine's own directory — `sessions` for Codex, `projects` for Claude — and refuses an oversized value whole rather than cutting it into a path nobody recorded.

It resolves the real path, compares the identity of the file it opened with the one the location named, checks that identity again after the read, and requires the first record to name the recorded session: Codex's session header, or the queue header Claude writes before the first turn.

The execution's turns are the Codex spans tied to its submitted inputs, or the Claude prompting messages whose uuids are its submitted input ids. Its 8 MiB budget is spent on the read itself, so an oversized line is never parsed.

It returns records of the execution's own turns only, bounded per fragment, and withholds a fragment whole when its text matches a credential shape — quoted JSON pairs included. Repeated Claude turn metadata is deduplicated so model steps cannot crowd out a later failure; when the four-fragment ceiling still omits a fact, `truncated` says so.

Claude reports a failed turn as an `api_error` system line or a synthetic assistant message, and its retries repeat the same failure, so the reader reports the last one once instead of a growing list. Every reason it gives is one bounded sentence that names the fact and never echoes a native value. Nothing it reads is written back into the Team.

For a continued execution the pass first skips the predecessor's prompt prefix. It ends after every turn this execution owned, or before the next root prompt it did not submit, so a native session continued later never lends its model or failure to this execution.

The report is layered. The public Thread keeps the summary it already had; the detailed answer — the stage a failure came apart in, the native identities, the bounded fragments, or the one reason the record could not answer (`missing`, `unreadable`, `unpersisted`, `unsupported`, `unmatched`) — reaches only the initiating Member and the Human.

A run that has not ended answers with its summary and says its record is read once it does, and a run that ended before any session was recorded says exactly that instead of claiming the engine never opened one.

### Steering a Worker and continuing its native session

Both engines expose the same `team_worker` steer shape. For a live execution the Host calls OAR's public `Session.deliver(..., { when: 'now' })` with a native input UUID distinct from the Team request id. OAR chooses steer, queue, or a new prompt from the session state and retries across that state race.

A `prompted` result is still this execution's input: the runtime keeps the execution open until every accepted input is consumed, then closes the steer window atomically and settles once. The Host acquires that closing hold before durable admission first waits on storage and releases it after recording the outcome, so ledger latency cannot close an idle native session before delivery. No accepted input is discarded because the first native turn ended.

The receipt says `submitted`, never that the model read or followed the instruction. It reports where OAR landed the input when known and the execution state at the moment the receipt was written. A native refusal, a stopping execution, an unconfirmed previous-Host execution, or an unavailable session is refused rather than guessed around.

When the latest linked execution has ended cleanly and its handle is gone, steer resumes the recorded native session through `SessionOptions.resume` and writes one new execution whose `continuedFrom` names its predecessor. The old terminal record is immutable. The new execution keeps the original engine, cwd, Project, Thread, Task, and initiating Member, and opens from the steer instruction rather than resending the old task.

Each activation mints a fresh external `SubagentRun.id` for the Harness catalog and live controls; the stable native session id travels separately in the result anchors for resume, settlement, and inspection, so two linked executions never become duplicate catalog children.

A clean failure is resumable in the same way; a stop in flight, an unconfirmed cleanup, a missing or mismatched native record, or a previous-Host `running` record is refused. If the nearest failed continuation never opened a native session of its own, an explicit later continuation inherits the nearest readable predecessor anchor while still naming that failed execution as its direct predecessor.

Continuation rechecks the current Worker switch, the selected engine switch, the Project's active state, current Project ownership, and the initiating Member's enabled state. It never relies on the old authorization. The ledger permits at most one running execution for a native conversation and one direct successor per execution, so concurrent continuations join the established execution instead of forking the session. A steer through an older ref follows the immutable chain to its newest execution.

The authorization is still the initiating Member. Another Member is refused as `worker_steer_forbidden`, and there is no Human steer entry. The live delivery table belongs to `WorkerRegistry`; it is removed when a session closes and cleared when the Host releases its runs. A continuation's new execution is durable and can itself be stopped, inspected, or steered by its own ref.

The idempotency answer precedes state checks. Each steer request is admitted as a private ledger operation before native delivery, and its refused, ambiguous, or submitted outcome is recorded before the Host reports it. A repeated request id returns that first receipt or refusal, including after the execution ended or the Host was reconstructed; a changed instruction, Member, or Worker under it is `worker_steer_conflict`.

A fresh same-text request id is durably registered as an alias of the canonical admission and returns its outcome without reading native history or delivering again; concurrent canonical and alias calls join one admission.

An admission with no confirmed outcome reads as `worker_steer_unconfirmed` and is never sent again automatically. An explicit native refusal took nothing, so a fresh request id may retry its text; transport-unknown stays ambiguous and is not retried. A later linked execution may receive the same text under a fresh id. Continuation request ids and executions are durable across Host restart.

A steer admission and its outcome are private ledger state: they publish no Thread fact, advance no Thread revision, create no Task or Claim, and do not mutate the predecessor or the existing execution record. A continuation additionally writes its own `team/worker-started` and `team/worker-settled`. Old ledgers without steer receipts or continuation anchors replay unchanged, and a historic active steer cannot acquire a receipt retroactively.

## Composer attachments (cache, not archive)

Attachments live in the bounded cache `$DSH_HOME/agent-team/attachments/v1/<attachmentId>/`, with a sanitized original name and `meta.json`; they are never ledger bytes or an archive. `putAttachment` enforces a 10 MB file cap and sanitizes names; `getAttachment` serves Client display. Messages record metadata while the stored body contains machine-facing `[attachment] <absolute path>` lines. The Client strips those lines and renders thumbnails/chips.

The request's `requestId` is an upload's idempotency key. Retrying the same payload replays the original result, including after Host restart. Reusing that key for a different payload is refused even when both requests arrive together. The cache id derives from the request id alone.

The Project and Thread composers accept files both through the "+" picker and by pasting into the draft; a paste that carries files is intercepted and joins the same pending-file chips, while plain-text pastes keep their native insertion.

Garbage collection runs at startup and every 24 hours: referenced uploads older than 72 hours and orphaned uploads older than 24 hours are removed, while metadata remains. Agent-sent absolute paths are validated as absolute non-empty regular files under 10 MB and rejected atomically if any path fails; each surviving path is copied into an immutable cache entry whose id derives from the message or reply request and the path's position in it. A manually pasted absolute path is simply read by the Agent; Host touches nothing it does not own.

An interrupted upload with missing or corrupt metadata also expires after 24 hours from the cache directory's last modification, provided no Message references it. The sweep ignores foreign directory names and symlinks at the cache root.

Repeating a send or reply reuses the prepared copies, keeping each `[attachment]` line stable. Attempts that share those copies run in order through commit and failure cleanup. If a send or reply fails after preparation, it removes copies only when no committed Message references them.

The sweep checks ledger references after it has exclusive access to the cache entry. A file that has passed the orphan limit but is now referenced therefore gets the remaining referenced retention window.

On a reused request id the ledger compares the recorded resolved attachment ids with the retry's resolved ids, so a retry carrying a different attachment set is refused as a collision.

## Human profile and version footnote

### Profile authority and migration

The Human's display name and avatar reference live in the Team Host row's own Config, in the settings namespace `contexera-agent-team-host` (user layer); avatar bytes live in the persistent `$DSH_HOME/agent-team/human/v1/` store, never in the TTL-bound attachment cache.

A profile written before this row was renamed keeps the row's whole Config under the old id `wowyuarm-agent-team-host`: the display name, the avatar reference, and the operational `wakeRecycle` and `memberCompaction` groups. That row no longer mounts, so every one of those values silently returns to its schema default — a Member compaction an operator had switched off comes back on.

At boot the Host reads those values out of the profile's own patch document and writes each field into the current namespace unless that namespace's user layer already stores it, so a value the Human set there after upgrading wins, even one equal to the schema default. A field holding a `!!js` expression keeps its default instead of being written back as source text; the avatar reference is carried only while its bytes remain in the store; and a display name that a live Member handle already claims is dropped rather than written.

The retired `agent-team-human` section is no longer an authority: the rc.1 settings importer carries sections across through a closed built-in mapping, so a third-party section stays behind in the renamed legacy document. A boot that finds a field unset in the current namespace adopts it from there through the same write path the settings page uses — the section carries the name and the avatar reference only — and anything already re-entered wins.

Only the Host row has this migration path: a profile patch that addresses one of the other five renamed rows by its pre-rename id — `wowyuarm-agent-team-{scope,preset-registry,preset-team-member,client,invariant}` — is skipped, because no loader entry answers to that id, so Team falls back to that row's shipped values. A hand edit to the Team preset or to the preset registry's `default` has to be re-applied after upgrading.

### Settings reads and writes

Five Agent Team typed Remotes serve the settings page: `humanProfile` (name, avatar reference, version footnote facts, and a write token tied to this Host instance and settings revision), `putHumanAvatar`/`getHumanAvatar`/`removeHumanAvatar` (images only, 10 MB cap shared with attachments; a removed entry throws and the Client falls back to the initial), and `toolCatalog` (discovery across Host-global and live Member-scoped registrations, never ordinary Agent scopes).

The Host stores a replacement image before committing its reference. Removal writes an explicit empty value so an inherited or migrated avatar cannot reappear. Replaced and removed images remain available to other profiles sharing the store. Only a new file known never to have been committed can be discarded; an uncertain settings write keeps its bytes.

The grant editor reads and writes the Team Host row's `extraToolGrants` through the public settings Remote, carrying its revision and writing exactly one `set` operation for that field. It grants external plugin tools without mounting plugins or enabling built-in DSH capabilities; the four DSH tree-local task-board tools are not candidates.

It never uses `unset`, so an explicit `[]` is a real revocation rather than a fallback to a lower layer. A failed list read cannot be saved as an empty list. The catalog and the Human identity read are independent: a directory failure still permits removing loaded names, and an identity failure leaves the grant group available.

The settings form and runtime normalization share the structural schema in `member-tool-grants.ts`: an array of non-empty strings with exact spelling. Team adds no name grammar, length ceiling, or grant quota; consumers collapse duplicates, and the catalog omits reserved names. The schema contains no transform callbacks, so reconstructing the Host's editable schema and serializing it for the browser preserves validation, including absent and empty lists.

### Installed version and update checks

The footnote carries the version of the bundle this Host runs from — read from the installed package's own manifest, so it states what the profile actually installed rather than a string every release must remember to bump — plus the repository link and an update tip. The tip names the newer version once a background check has observed a newer published release.

The check reads the public npm `latest` document in the background at most every 12 hours. A successful check replaces the previous result; a failure keeps it. `DSH_AGENT_TEAM_UPDATE_CHECK=0` stops new outbound checks. It does not hide the last confirmed result or cancel a check already in flight.

The ledger reads the same profile for `team_view` and @ matching, so a rename reaches every surface at once. `human` stays a permanent alias for the Human and no agent handle may claim the literal, so `@human` keeps delivering across renames while chips render the current display name.

## Replay and Inbox sequencing

### Replay execution order

1. `replayLocked` re-reads the live subscription with `runTarget` after admission, rather than running the queued snapshot.
2. An existing request id with another delivery or version is rejected before any script execution.
3. A settled intent returns its stored answer; its delivery must still exist and be unexpired.
4. A running intent never reruns: ledger-accepted output repairs its answer; without acceptance it reports an unfinished attempt.
5. A fresh request requires an unexpired delivery and rejects prior success found in a tombstone, replay answer, or running intent with ledger acceptance.
6. The running intent is recorded before choosing the source or running the script; a failed intent write prevents execution.
7. `current` uses the live definition; `received` substitutes the delivery's revision, script, and credentials.
8. A run dropped after terminal state reports nothing delivered; accepted or empty output otherwise counts as success before settlement.
9. Settlement writes the answer before the tombstone under the subscription write lock; storage faults log without hiding delivered output.
10. If deletion wins settlement, ledger-accepted output is still reported as delivered; any other outcome reports nothing delivered.

### Inbox delivery order

1. `deliverInboxNotice` reads one durable notification snapshot, including Thread, Main, reminder, and Worker material.
2. No unread Thread, Main, or reminder material drops coverage and returns without creating a notice.
3. Already-queued ordinary next-turn input forces followup, preventing a steer from leapfrogging carried input.
4. An unchanged covered fact set returns before queue mutation or attempt accounting.
5. A pending recovery notice stays in place; newly arriving facts remain uncovered.
6. An old Inbox notice is removed before rendering and tracking its replacement.
7. The replacement message tracks only its rendered reminder occurrences; they are consumed on claim, not enqueue.
8. Coverage records rendered facts, not all offered facts; omitted Threads and reminders remain owed.
9. The attempt is counted before calling followup or steer.
10. A followup or steer failure drops coverage but keeps the attempt count; invariant failures are then rethrown.
11. Notice delivery does not roll back ledger commits; ordinary delivery failures log and leave durable unread facts recoverable.
