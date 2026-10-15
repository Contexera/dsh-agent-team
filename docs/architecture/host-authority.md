# Host authority

English | [中文](host-authority.zh.md)

Team is one collaboration domain per DSH home. Its append-only operation ledger is durable authority for Member, Workspace, Channel, Message, independent Thread aggregates, optional Task overlays, Claim, Thread Attention, Inbox, and Activity facts.

When changing a Host capability, read package source/tests first and then the matching Harness contract. [`harness-navigation.md`](../harness-navigation.md) maps the route to `deepseek-harness/docs/subsystems/` and source packages.

## Ledger authority and commits
- Mutations enter Host authority and commit one durable operation. Projections, Inbox, tools, commands, Remote responses, and UI derive from committed operations; Client code never interprets ledger records or creates parallel authority.

- A reply records the Message it answers as `replyToMessageRef` on the Message itself, and the Host resolves that ref against the ledger before committing: an unknown ref, or one belonging to another Thread, is refused rather than stored. The parent's author joins the recipients at commit, under the same invitation rule, direct markers, and `undeliveredMentions` reporting as a mention.
- The quoted picture — the parent's author and one line of its body — is a read-time derivation (`replyTo`), never a second stored copy. It therefore cannot disagree with the parent and still fills in when the parent sits outside the page being read. A ref that no longer resolves stays a bare ref. Quoting is not optional: the parameter is part of the reply contract, and a reply carrying a ref is accepted or refused on the ref alone.

## Lifecycle and notifications
- Agent lifecycle, JSON/SQLite replay, authorization, idempotency, and revision checks stay on Host. Durable unread changes may produce one bounded coalesced Agent context notification through the public safe boundary: direct mentions carry their Message and source, Task/Claim Activities carry a concise transition, and ordinary unread carries only a body-free Thread-first route. Promotion is a Task activity and reaches followers through Activity markers. Notifications are not a second authority and do not promise exactly-once model processing.
- A committed Session transition (`team/member-session-renewed`, `team/member-session-rolled-over`) records the desired binding, not a completed one: retiring the old generation and activating the target are Host effects outside the ledger write. Startup and the explicit Member recovery action both finish an interrupted transition from the recorded previous Session, and each effect derives its own completion — a live handle never proves the archive half ran. A repeated request therefore answers with the recorded receipt and an honest status rather than committing a second binding.
- Every durable Member state has one desired external effect set — the [Member Lifecycle](../domain-model.md#member-lifecycle) table. Each lifecycle operation re-runs that set right after its commit, and startup re-runs it for every non-enabled Member, so an archive, suspension, or removal interrupted by a crash or a failed Workspace/Session/filesystem call converges by repeating the same derivation rather than by a second durable write.
- Startup never activates a non-enabled Member: an effect that fails during startup is logged and retried at the next boot instead of failing the boot. Lifecycle operations for one Member stay serialized in submission order, while different Members never queue behind each other's waits.
- After the ledger append, delivery effects follow — commit listeners, Client change invalidation, the participation notice, and one wake per affected Member. Each runs in a boundary that logs a failure instead of failing the operation, so a failed listener or wake still answers with the committed result, not a false rollback; only invariant divergence still rejects. A failed Inbox wake clears its recorded notice state, so the next commit touching that Member rederives the same durable Inbox facts and retries without a second append. DM keeps its explicit recorded-but-not-delivered error.

## Which operations wake a Member, and how recovery is chosen

A wake is one bounded coalesced notice the Host delivers over one of four causes, each carrying the durable fact that produced it:

| Cause | What produced it |
| --- | --- |
| `commit` | any committed operation touching the Member: a mention, a DM, a Task activity, a promotion, an accepted answer |
| `transition` | a recorded `team/member-session-renewed` or `team/member-session-rolled-over` whose retire and activation effects complete out of order; the rederived Inbox is sequenced after the handoff |
| `activation` | a fresh activation, carrying the previous Session id when input was carried forward |
| `running` | the Member's own `agent/status` going `running` — one wake per transition, not per step |

Waking is not a second authority and never promises exactly-once model processing. A wake that fails delivery clears its recorded notice state, so the next commit touching that Member rederives the same durable facts and retries without a second append.

`recoverMember` is the manual path and picks exactly one of these, in order:

| Condition | Action | Use it when |
| --- | --- | --- |
| handle absent, or the live handle's Session id is not the recorded binding, and a recorded transition exists | finish the recorded transition | a crash or a failed effect left a Session transition half-applied |
| durable state is not `enabled` but a live handle survives | finish that state's effects | a suspend, archive, or removal committed but its disposal failed |
| a live handle whose preset composition is gone | reactivate in place | a reload lost the preset composition, so the Member's tools are unavailable |
| no live handle at all | reactivate | the activation itself failed |
| otherwise | steer a resume prompt | the Member is alive, composed, and bound — every other state has already been handled |

An error-state Member with a live handle is the last row: `recoverMember` steers it, and a cause that is still present makes the next turn fail again. Distinguish the two before choosing: a broken model route or a rejecting gateway is fixed by changing the route, not by recovering the Member, and steering recovers nothing until the route answers. A context generation that cannot finish on its own is the case for `clearMemberContext`, which renews the Session so the next turn carries no history.

A Member's current failure reason is carried on its status as a `diagnostic` and rendered by the Client. It is derived from the live surface, not persisted: after a Host restart it is re-derived only if something wakes the Member, so an un-woken Member shows no reason until the next operation touches it.

## Projections and the change stream
- Host projections over a Member Session fold incrementally. Context intent, the clock baseline, and the one-shot pressure notice each derive from one Session's own events, and all three read through a Session event cursor that keeps the folded value beside the log position it consumed — `context-projection.ts` supplies the fold, `session-event-cursor.ts` the position. The first read of a log therefore folds it once, and every later read folds only the events appended since.

  The cursor assumes the log is append-only and verifies what it can: it remembers the sequence and type of the event it stopped on. A log whose fork prefix moved, that shrank, or that replaced that event re-folds from the start, so a fork, resume, or rollover costs a cold fold at worst rather than yielding a wrong picture.

  One residual is named in the module rather than papered over: an event replaced in place by another of the same type at the same sequence is invisible to that guard. That swap is reachable only by violating the append-only contract, and a content-sensitive anchor would not close it either, because only the anchor position is re-read while a swap at any earlier folded position would pass the same way. Cold paths that read a whole inspected or foreign log — activation, transitions, timeline, carried-input replay — keep folding in full.

  Each of the three keeps one cursor per Member and replaces it when that Member's Session changes, so the retained fold state is bounded by the roster rather than by the number of generations a Member has lived through.
- `changes()` is a streaming Remote with one optional scope (workspace/channel/thread/presence); an omitted scope observes shared Team projection changes, not presence. Host registers the listener before emitting the current baseline, then emits matching invalidations, retaining only the latest pending version while a consumer pauses. Cancellation or Host disposal closes the subscription. Thread reads and `team/dm-sent` change no shared projection, so neither advances its version nor wakes subscribers.

  Presence uses a process-local epoch; other scopes report the latest shared-projection ledger sequence. Versions are meaningful only within their scope and Host lifetime. Host recomputes Inbox hints only for Members affected by an operation.
- `TeamChangeStream` shares one logical stream per scope within each page through `ctx.remote.$stream()`; Harness owns the shared `/api/remote.mux` WebSocket and connection recovery. Each new baseline, including an unchanged or lower version after reconnection, requests a fresh Host read. This closes the initial-read race and recovers failed reads without a new commit. The last listener leaving disposes that scope; plugin disposal closes all scopes. Carrier failures are reported once until recovery; terminal failures are reported without a Team-owned retry loop.

  Team has no long-poll fallback, cross-page leader election, or single-active-page restriction. Concurrent supplemental reads coalesce notifications and retain a trailing read when another notification arrives during a fetch, rather than suppressing reconnect baselines by an old version. The Human Inbox badge subscribes without a scope, debounces Inbox totals, and also refreshes after local Thread reads. Presence subscriptions update Member availability without waking the Inbox. Notifications are invalidation hints, never a second facts store.
- Read projections are bounded by purpose. `view` answers the requested fact page plus the Thread it names: its catalog fields carry that page's Tasks, Threads, display ordinals and Claims. Only `includeCatalog` returns the Task/Thread/Claim catalog of the whole request scope — the address-book projection the model-facing `team_view` renders.
- A page read walks the fact ledger until one match past its limit; a catalog read adds one directory filter over the Threads in scope plus one live-Claim lookup per Task row. Those are the components to report separately, never as one total: a returned row count alone does not show what a read walked.
- Claims are bucketed per Task by a replay-derived index, so a per-Task read — a Claim list, a Thread picture, an Inbox row, the 「active task threads」 radar — never walks the ledger's whole Claim set. Every index here is rebuilt by replay, never a second durable authority.

## Session persistence and replay
- The bundle targets DSH `0.2.0-rc.2` and uses the current DSH Session persistence: the shipped JSONL backend migrates released historical formats itself (v0/v1/v2 → V3 → V4), and old-format Session data needs no manual disposal. Team nevertheless retains a narrow replay normalization for old pre-Message `occurredAt` records, and exactly one record shape still reaches it: the pre-receipt `team/thread-read` snapshot, which froze Message anchors and Thread facts beside the Inbox delta it consumed.

  That is the only Thread-read form that stores an instant at all — the receipt every current read writes carries progress and its Inbox delta only — and it is normalized and validated in place, never rewritten. Do not add Team Session migration, broad compatibility reads, or fallback storage paths.

## Attention and Inbox authority
- Thread Attention is private Member × Thread state. The Host is the only Inbox authority. Session history may retain bounded notification context but never a parallel unread projection.
- The Inbox read ranks the reader's whole unread queue, then materializes preview text, the instant's person and live Claim owners only for the rows it returns; its totals stay whole-queue, so a one-row badge still reports every unread Thread. `threadObservations` returns the newest `limit` observations with `hasMore`, and its follower set is always the complete current state.

## Sessions, policy, and context pressure
- Team-managed Agent sessions use the explicit Team preset and trusted `danger-full-access` policy. An untitled Member session receives its handle as a title; explicit or previous titles win.
- Accepted-Task auto compaction is retired. Member context pressure is decided by the engine's policy, which the Host binds to Member readings (see Tools and preset):
  - budgets derive from the live route's context window;
  - one handoff-budget notice per generation;
  - a long-gap step the relatedness judge reads as unrelated is held rather than admitted;
  - forced in-place compaction with fail-closed verification at the hard limit;
  - one bounded compact-and-retry for provider context-overflow.

  Pending/error bookkeeping is process-local; only compactions in a transaction add Session history.
- Terminal recovery classifies each `agent/error` from structured Harness data before any wording. The stable code decides alone — `RATE_LIMIT` is rate limiting, `TRANSPORT`/`TIMEOUT` a transient network failure, an explicit 429/503 response rate limiting — and any other code (quota, auth, context, request) stays manual whatever its message says. Only a codeless error falls back to the narrow message signatures.
- The split stays two-level: `agent/request-error` owns the same-step pressure/compaction retry, `agent/error` owns terminal recovery with its consecutive-error limit, and either way the failure keeps its recorded Member diagnostic.
- A Team wake discarded before any `turn/start` is the one error diagnostic with no `agent/error` behind it. A Team-owned Inbox or recovery notice that leaves the queue before the turn opens, and that the Host did not replace or dispose, records a `runtime` diagnostic with `source: 'agent/inbox/discarded'`, the `sessionId`, and `occurredAt`. A notice the Host replaces or disposes raises nothing, so ordinary replacement never errors. Like every runtime diagnostic it is process-local, re-derived only on the next wake.

## Private memory, archival, and identity effects
- Private-memory directories under `$DSH_HOME/agent-team/members/` are Host-owned effects of Member identity. Activation ensures the directory, `notes/`, and missing `memory.md`; startup does not prune unknown directories. Explicit removal archives the Session and removes that Member's private directory; unrelated entries remain untouched.

  Both that removal and the activation-time rename of a pre-fix colon directory are confined to the running process's own members root. The recorded `privateMemoryPath` is a durable absolute fact that names a directory in whichever DSH home added the Member, so a process resolving another home refuses to move or delete it (with a warning) instead of taking the Member's real private memory out of its home.
- Member and Channel archival is the reversible third state between suspend and remove. `archiveMember` commits `team/member-archived`, disposes the live session (private memory and the Session log stay on disk), archives the Session from grouping surfaces, and releases the Member's active Claims with public `claims_released` Activities plus Attention/marker cleanup. A hidden Member must not leave Tasks stuck in progress or phantom unread counts.

  `archiveChannel` commits `team/channel-archived` with the same release shape across every owner on the Channel's Threads; Memberships survive both archival forms (hidden state, not departure).

  Archived entities are gone from every Team API surface — projections (view channels/threads/tasks/members, mention candidates, Channel joins, edits), ref resolution (`resolveTaskRefs`/`resolveThreadRefs` skip them so message bodies render plain text), and ref-addressed reads (`readThread`/`threadHistory`/`threadObservations`/`listClaims` reject with an explicit archived error, never an unknown-ref disguise). The facts stay complete in the ledger for replay and a future restore, and that boundary is the archival-vs-remove divide.

  Removal from archived stays available as the data hygiene path, and there is deliberately no restore entry point this round (mirroring archived dsh sessions). Ledgers written before Channel archival omit `channel.state`; the record schema normalizes it to `active` at load.

## Member capabilities and skills
- Member capabilities (`capabilities` on the Member entity: reserved `tools.allow`, `skills.allow`) are durable intent carried verbatim by every lifecycle operation. Committing performs no known-name validation so old ledgers stay replayable across Harness upgrades; divergence is derived at activation as non-persisted `capabilityWarnings`. `tools.allow` is a deliberate interface reservation: it has no UI write path today.

  Edits follow the partial-update semantics of `model`: an omitted field keeps the stored value and an explicit `null` clears it, so a caller that does not manage capabilities can leave the field out and any Remote-written override survives.
- Activation applies `tools.allow` as a scoped restriction on the composed preset surface before preset validation (mount → restrict → validate), force-unioning the eleven Team tools over the configured list. Unknown names drop with a warning instead of failing activation.

  Editing the allow-list on a live Member swaps the restriction at a turn boundary in the same Session: idle Members apply immediately, and a running Member's edit waits for that Member's turn to end. Each Member owns one lifecycle chain, so the wait holds only that Member's later operations, still in submission order, while managing another Member never queues behind it and the ledger keeps its single ordered writer.

  Host shutdown releases every pending wait instead of waiting out a turn that may never end, and a Session disposed outside the chain also releases it. A stop cancels that Member's in-flight turn and then waits for the Agent to quiesce, so a stop queued behind a parked edit reaches the boundary after that edit has applied and then usually finds the Agent idle. A stop never clears or aborts a committed configuration: the edit either applies at the boundary or reports `deferred:no-live-handle`, and either order leaves the stored intent in force at the next activation.

  Waits are logged by class with their Member, Session, and duration: `stage 'wait-turn'` for waiting on the Member's own turn, and `stage 'wait-external'` for external execution such as the Agent releasing its Session write path. Restriction failures during activation surface as that Member's activation failure.
- A failed live apply never widens the surface: the edit keeps its ledger commit, the previous restriction stays in force (restored when the new one fails to install), the Remote call surfaces the failure, and retrying the same request re-applies the stored configuration without a second commit. The Host compares stored intent against the capability effects the runtime has actually applied, never against the requesting call's own history.
- Configuration edits report their effect separately from their commit: `updateMember` returns `effect` as `applied`, `already-applied`, `deferred:no-live-handle`, or `deferred:generation-changed` (saved now, applied at the next activation). A failure never appears as a value — it stays a rejection and is also kept as a routable `capability-apply` diagnostic whose `detail` carries requestId, operationId, stage, and reason with the Session in `sessionId`, logged under the same correlation group.
- Every roster row carries `capabilityState` (`applied` | `pending`), derived from the effects the runtime actually applied; states with no live surface report `pending` literally. The field is orthogonal to `availability`/`presence`: those answer whether the Member runs, this answers whether its stored configuration is in effect.
- Skills are Member-private. The preset carries no shared skill-filesystem row; instead the Host registers one filesystem provider per Member on that agent's exact scope layer (the traceable-service seam, same shape as the tool restriction). That provider scans exactly two Team-owned roots with default roots excluded: the plugin's bundled read-only core skills (`packages/agent-team/core-skills/`, first — a same-name bundled skill stays stable across upgrades) and the Member's writable `$DSH_HOME/agent-team/members/<memberId>/skills/`.

  A Member catalog therefore starts with the bundled set (the `member-skill-manager` meta skill, which owns all skill craft guidance — the persona itself only states the private-space physical facts). Installing is writing into the Member's own directory (directory form `skills/<name>/SKILL.md` with optional references/scripts, or a flat `.md`), there is deliberately no upload Remote, and the filesystem watcher feeds discovery.

  `skills.allow` filters `list()` output through a live selection ref (edits swap the filter and invalidate the catalog at the same turn boundary as tool edits); filtering is a visibility semantic, not a security boundary — both roots stay scanned and watched. Member removal deletes the private directory with its skills; suspend/resume and Host restart restore the identical catalog.

## Host service surface (`ctx.agentTeam`)

The Host row publishes one service, `ctx.agentTeam`, consumed in two distinct ways with different stability promises. There is no CLI, no `bin`, and no loopback HTTP entry: the Web Client is the only Human control surface, and every change reaches the Host through the typed Remote.

- **Remote methods** (the `@Remote`-decorated ones, e.g. `members`, `view`, `addMember`, `updateMember`, `sendMessage`, `readThread`, `inbox`, `humanProfile`) are the Client contract. They are typed through Typert artefacts generated from the declarations, so the Client, the model-facing tools, and any other consumer compile against the same shape; changing one is a contract change.
- **Host-only service methods** (e.g. `memberForAgent`, `membersForClient`, `status`, and the activation/lifecycle internals) exist for in-process Host callers — the preset row, commit listeners, and startup derivation. They carry no compatibility promise and may move between releases.

Only the Remote set is a contract. Everything else on `ctx.agentTeam` is internal and may change shape without a migration note.

A preset row must resolve `ctx.agentTeam` while it runs, never capture it statically at declaration time: the service is provided when the Host plugin starts, so a row that closed over it at import time sees nothing. The same applies to `ctx.get('agentTeam')` in external code, which is undocumented use of an internal surface rather than a supported integration point.

## Composer attachments (cache, not archive)

Attachments live in the bounded cache `$DSH_HOME/agent-team/attachments/v1/<attachmentId>/`, with a sanitized original name and `meta.json`; they are never ledger bytes or an archive. `putAttachment` enforces a 10 MB file cap and sanitizes names; `getAttachment` serves Client display. Messages record metadata while the stored body contains machine-facing `[attachment] <absolute path>` lines. The Client strips those lines and renders thumbnails/chips.

The request's `requestId` is an upload's idempotency key. Retrying the same payload replays the original result instead of writing a second entry, reusing that key for a different payload is refused as a request collision, and the cache id derives from the request id alone. A retry therefore converges on the same entry after a Host restart without a second durable store or an in-memory map.

The Channel and Thread composers accept files both through the "+" picker and by pasting into the draft; a paste that carries files is intercepted and joins the same pending-file chips, while plain-text pastes keep their native insertion.

Garbage collection runs at startup and every 24 hours: referenced uploads older than 72 hours and orphaned uploads older than 24 hours are removed, while metadata remains. Agent-sent absolute paths are validated as absolute non-empty regular files under 10 MB and rejected atomically if any path fails; each surviving path is copied into an immutable cache entry whose id derives from the message or reply request and the path's position in it. A manually pasted absolute path is simply read by the Agent; Host touches nothing it does not own.

That request-derived identity is what makes retries cheap: a repeated send or reply converges on the entry the first attempt prepared instead of writing an orphan, so the stored body — one `[attachment]` line per file — stays identical across retries. A message or reply that fails after preparation removes the entries this attempt prepared which no committed Message references, with the ledger's reference set as the guard; genuinely unreferenced uploads stay GC's to reclaim.

On a reused request id the ledger compares the recorded resolved attachment ids with the retry's resolved ids, so a retry carrying a different attachment set is refused as a collision.

## Human profile and version footnote

The Human's display name and avatar reference live in the Team Host row's own Config, in the settings namespace `wowyuarm-agent-team-host` (user layer); avatar bytes live in the persistent `$DSH_HOME/agent-team/human/v1/` store, never in the TTL-bound attachment cache.

The retired `agent-team-human` section is no longer an authority: the rc.1 settings importer carries sections across through a closed built-in mapping, so a third-party section stays behind in the renamed legacy document. A boot that finds the row still pristine — the default name and no avatar — adopts those facts through the same write path the settings page uses, and anything already re-entered wins.

Four typed Remotes serve the settings page: `humanProfile` (name, avatar reference, and version footnote facts) and `putHumanAvatar`/`getHumanAvatar`/`removeHumanAvatar` (images only, 10 MB cap shared with attachments; a removed entry throws and the Client falls back to the initial).

The footnote carries the version of the bundle this Host runs from — read from the installed package's own manifest, so it states what the profile actually installed rather than a string every release must remember to bump — plus the repository link and an update tip. The tip names the newer version once a background check has observed a newer published release.

The check asks the public npm `latest` document at most every 12 hours, refreshes in the background so profile reads never wait on the network, settles every failure as "no update known", and stays off while `DSH_AGENT_TEAM_UPDATE_CHECK=0`.

The ledger reads the same profile for `team_view` and @ matching, so a rename reaches every surface at once. `human` stays a permanent alias for the Human and no agent handle may claim the literal, so `@human` keeps delivering across renames while chips render the current display name.
