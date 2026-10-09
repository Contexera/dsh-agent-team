# Host authority

English | [中文](host-authority.zh.md)

Team is one collaboration domain per DSH home. Its append-only operation ledger is durable authority for Member, Workspace, Channel, Message, independent Thread aggregates, optional Task overlays, Claim, Thread Attention, Inbox, and Activity facts.

When changing a Host capability, read package source/tests first and then the matching Harness contract. [`harness-navigation.md`](../harness-navigation.md) maps the route to `deepseek-harness/docs/subsystems/` and source packages.

## Ledger authority and commits
- Mutations enter Host authority and commit one durable operation. Projections, Inbox, tools, commands, Remote responses, and UI derive from committed operations; Client code never interprets ledger records or creates parallel authority.

## Lifecycle and notifications
- Agent lifecycle, JSON/SQLite replay, authorization, idempotency, and revision checks stay on Host. Durable unread changes may produce one bounded coalesced Agent context notification through the public safe boundary: direct mentions carry their Message and source, Task/Claim Activities carry a concise transition, and ordinary unread carries only a body-free Thread-first route. Promotion is a Task activity and reaches followers through Activity markers. Notifications are not a second authority and do not promise exactly-once model processing.
- A committed Session transition (`team/member-session-renewed`, `team/member-session-rolled-over`) records the desired binding, not a completed one: retiring the old generation and activating the target are Host effects outside the ledger write. Startup and the explicit Member recovery action both finish an interrupted transition from the recorded previous Session, and each effect derives its own completion — a live handle never proves the archive half ran — so a repeated request answers with the recorded receipt and an honest status rather than committing a second binding.
- Every durable Member state has one desired external effect set — the [Member Lifecycle](../domain-model.md#member-lifecycle) table. Each lifecycle operation re-runs that set right after its commit, and startup re-runs it for every non-enabled Member, so an archive, suspension, or removal interrupted by a crash or a failed Workspace/Session/filesystem call converges by repeating the same derivation rather than by a second durable write.
- Startup never activates a non-enabled Member: an effect that fails during startup is logged and retried at the next boot instead of failing the boot, and lifecycle operations stay serialized through the existing queue.
- After the ledger append, delivery effects follow — commit listeners, Client change invalidation, the participation notice, and one wake per affected Member. Each runs in a boundary that logs a failure instead of failing the operation, so a failed listener or wake still answers with the committed result, not a false rollback; only invariant divergence still rejects. A failed Inbox wake clears its recorded notice state, so the next commit touching that Member rederives the same durable Inbox facts and retries without a second append. DM keeps its explicit recorded-but-not-delivered error.

## Projections and the change stream
- Host projections over a Member Session fold incrementally. Context intent, the clock baseline, and the one-shot pressure notice each derive from one Session's own events, and all three read through a Session event cursor that keeps the folded value beside the log position it consumed — `context-projection.ts` supplies the fold, `session-event-cursor.ts` the position — so the first read of a log folds it once and every later read folds only the events appended since.

  The cursor assumes the log is append-only and verifies what it can: it remembers the sequence and type of the event it stopped on, so a log whose fork prefix moved, that shrank, or that replaced that event re-folds from the start, and a fork, resume, or rollover therefore costs a cold fold at worst rather than yielding a wrong picture.

  One residual is named in the module rather than papered over: an event replaced in place by another of the same type at the same sequence is invisible to that guard, which is reachable only by violating the append-only contract and which a content-sensitive anchor would not close either, because only the anchor position is re-read while a swap at any earlier folded position would pass the same way. Cold paths that read a whole inspected or foreign log — activation, transitions, timeline, carried-input replay — keep folding in full.

  Each of the three keeps one cursor per Member and replaces it when that Member's Session changes, so the retained fold state is bounded by the roster rather than by the number of generations a Member has lived through.
- `changes()` is a streaming Remote with one optional scope (workspace/channel/thread/presence); an omitted scope observes shared Team projection changes, not presence. Host registers the listener before emitting the current baseline, then emits matching invalidations, retaining only the latest pending version while a consumer pauses. Cancellation or Host disposal closes the subscription. Thread reads and `team/dm-sent` change no shared projection, so neither advances its version nor wakes subscribers.

  Presence uses a process-local epoch; other scopes report the latest shared-projection ledger sequence. Versions are meaningful only within their scope and Host lifetime. Host recomputes Inbox hints only for Members affected by an operation.
- `TeamChangeStream` shares one logical stream per scope within each page through `ctx.remote.$stream()`; Harness owns the shared `/api/remote.mux` WebSocket and connection recovery. Each new baseline, including an unchanged or lower version after reconnection, requests a fresh Host read. This closes the initial-read race and recovers failed reads without a new commit. The last listener leaving disposes that scope; plugin disposal closes all scopes. Carrier failures are reported once until recovery; terminal failures are reported without a Team-owned retry loop.

  Team has no long-poll fallback, cross-page leader election, or single-active-page restriction. Concurrent supplemental reads coalesce notifications and retain a trailing read when another notification arrives during a fetch, rather than suppressing reconnect baselines by an old version. The Human Inbox badge subscribes without a scope, debounces Inbox totals, and also refreshes after local Thread reads. Presence subscriptions update Member availability without waking the Inbox. Notifications are invalidation hints, never a second facts store.

## Session persistence and replay
- The bundle targets DSH `0.2.0-rc.2` and uses the current DSH Session persistence: the shipped JSONL backend migrates released historical formats itself (v0/v1/v2 → V3 → V4), and old-format Session data needs no manual disposal. Team nevertheless retains a narrow replay normalization for old pre-Message `occurredAt` records, and exactly one record shape still reaches it: the pre-receipt `team/thread-read` snapshot, which froze Message anchors and Thread facts beside the Inbox delta it consumed.

  That is the only Thread-read form that stores an instant at all — the receipt every current read writes carries progress and its Inbox delta only — and it is normalized and validated in place, never rewritten. Do not add Team Session migration, broad compatibility reads, or fallback storage paths.

## Attention and Inbox authority
- Thread Attention is private Member × Thread state. The Host is the only Inbox authority. Session history may retain bounded notification context but never a parallel unread projection.

## Sessions, policy, and context pressure
- Team-managed Agent sessions use the explicit Team preset and trusted `danger-full-access` policy. An untitled Member session receives its handle as a title; explicit or previous titles win.
- Accepted-Task auto compaction is retired. Member context pressure is decided by the engine's policy, which the Host binds to Member readings (see Tools and preset): budgets derive from the live route's context window, one handoff-budget notice per generation, a long-gap step the relatedness judge reads as unrelated is held rather than admitted, forced in-place compaction with fail-closed verification at the hard limit, and one bounded compact-and-retry for provider context-overflow. Pending/error bookkeeping is process-local; only compactions in a transaction add Session history.
- Terminal recovery classifies each `agent/error` from structured Harness data before any wording: the stable code decides alone — `RATE_LIMIT` is rate limiting, `TRANSPORT`/`TIMEOUT` a transient network failure, an explicit 429/503 response rate limiting — and any other code (quota, auth, context, request) stays manual whatever its message says; only a codeless error falls back to the narrow message signatures.
- The split stays two-level: `agent/request-error` owns the same-step pressure/compaction retry, `agent/error` owns terminal recovery with its consecutive-error limit, and either way the failure keeps its recorded Member diagnostic.

## Private memory, archival, and identity effects
- Private-memory directories under `$DSH_HOME/agent-team/members/` are Host-owned effects of Member identity. Activation ensures the directory, `notes/`, and missing `memory.md`; startup does not prune unknown directories. Explicit removal archives the Session and removes that Member's private directory; unrelated entries remain untouched.

  Both that removal and the activation-time rename of a pre-fix colon directory are confined to the running process's own members root — the recorded `privateMemoryPath` is a durable absolute fact that names a directory in whichever DSH home added the Member, so a process resolving another home refuses to move or delete it (with a warning) instead of taking the Member's real private memory out of its home.
- Member and Channel archival is the reversible third state between suspend and remove. `archiveMember` commits `team/member-archived`, disposes the live session (private memory and the Session log stay on disk), archives the Session from grouping surfaces, and releases the Member's active Claims with public `claims_released` Activities plus Attention/marker cleanup — a hidden Member must not leave Tasks stuck in progress or phantom unread counts.

  `archiveChannel` commits `team/channel-archived` with the same release shape across every owner on the Channel's Threads; Memberships survive both archival forms (hidden state, not departure).

  Archived entities are gone from every Team API surface — projections (view channels/threads/tasks/members, mention candidates, Channel joins, edits), ref resolution (`resolveTaskRefs`/`resolveThreadRefs` skip them so message bodies render plain text), and ref-addressed reads (`readThread`/`threadHistory`/`threadObservations`/`listClaims` reject with an explicit archived error, never an unknown-ref disguise) — while the facts stay complete in the ledger for replay and a future restore; that boundary is the archival-vs-remove divide.

  Removal from archived stays available as the data hygiene path, and there is deliberately no restore entry point this round (mirroring archived dsh sessions). Ledgers written before Channel archival omit `channel.state`; the record schema normalizes it to `active` at load.

## Member capabilities and skills
- Member capabilities (`capabilities` on the Member entity: reserved `tools.allow`, `skills.allow`) are durable intent carried verbatim by every lifecycle operation. Committing performs no known-name validation so old ledgers stay replayable across Harness upgrades; divergence is derived at activation as non-persisted `capabilityWarnings`. `tools.allow` is a deliberate interface reservation (no UI write path) that future Runtime Revision manifest orchestration depends on; do not remove during cleanup.

  Edits follow the absent-clears semantics of `model`; callers that do not manage capabilities must echo the stored value back.
- Activation applies `tools.allow` as a scoped restriction on the composed preset surface before preset validation (mount → restrict → validate), force-unioning the eight Team tools over the configured list. Unknown names drop with a warning instead of failing activation.

  Editing the allow-list on a live Member swaps the restriction at a turn boundary in the same Session: idle Members apply immediately; a running Member's edit waits for the turn to end, and later lifecycle operations queue behind that wait (lifecycle Remote calls are strictly serialized, so a suspend issued during the wait runs after the swap; the disposed-scope listener covers non-lifecycle disposal). Restriction failures during activation surface as that Member's activation failure.
- A failed live apply never widens the surface: the edit keeps its ledger commit, the previous restriction stays in force (restored when the new one fails to install), the Remote call surfaces the failure, and retrying the same request re-applies the stored configuration without a second commit — the Host compares stored intent against the capability effects the runtime has actually applied, never against the requesting call's own history.
- Configuration edits report their effect separately from their commit: `updateMember` returns `effect` as `applied`, `already-applied`, `deferred:no-live-handle`, or `deferred:generation-changed` (saved now, applied at the next activation). A failure never appears as a value — it stays a rejection and is also kept as a routable `capability-apply` diagnostic whose `detail` carries requestId, operationId, stage, and reason with the Session in `sessionId`, logged under the same correlation group.
- Every roster row carries `capabilityState` (`applied` | `pending`), derived from the effects the runtime actually applied; states with no live surface report `pending` literally. The field is orthogonal to `availability`/`presence`: those answer whether the Member runs, this answers whether its stored configuration is in effect.
- Skills are Member-private. The preset carries no shared skill-filesystem row; instead the Host registers one filesystem provider per Member on that agent's exact scope layer (the traceable-service seam, same shape as the tool restriction) scanning exactly two Team-owned roots with default roots excluded: the plugin's bundled read-only core skills (`packages/agent-team/core-skills/`, first — a same-name bundled skill stays stable across upgrades) and the Member's writable `$DSH_HOME/agent-team/members/<memberId>/skills/`.

  A Member catalog therefore starts with the bundled set (the `member-skill-manager` meta skill, which owns all skill craft guidance — the persona itself only states the private-space physical facts); installing is writing into the Member's own directory (directory form `skills/<name>/SKILL.md` with optional references/scripts, or a flat `.md`), there is deliberately no upload Remote, and the filesystem watcher feeds discovery.

  `skills.allow` filters `list()` output through a live selection ref (edits swap the filter and invalidate the catalog at the same turn boundary as tool edits); filtering is a visibility semantic, not a security boundary — both roots stay scanned and watched. Member removal deletes the private directory with its skills; suspend/resume and Host restart restore the identical catalog.

## Composer attachments (cache, not archive)

Attachments live in the bounded cache `$DSH_HOME/agent-team/attachments/v1/<attachmentId>/`, with a sanitized original name and `meta.json`; they are never ledger bytes or an archive. `putAttachment` enforces a 10 MB file cap and sanitizes names; `getAttachment` serves Client display. Messages record metadata while the stored body contains machine-facing `[attachment] <absolute path>` lines. The Client strips those lines and renders thumbnails/chips.

The request's `requestId` is an upload's idempotency key. Retrying the same payload replays the original result instead of writing a second entry, reusing that key for a different payload is refused as a request collision, and the cache id derives from the request id alone — so a retry converges on the same entry after a Host restart without a second durable store or an in-memory map.

The Channel and Thread composers accept files both through the "+" picker and by pasting into the draft; a paste that carries files is intercepted and joins the same pending-file chips, while plain-text pastes keep their native insertion.

Garbage collection runs at startup and every 24 hours: referenced uploads older than 72 hours and orphaned uploads older than 24 hours are removed, while metadata remains. Agent-sent absolute paths are validated as absolute non-empty regular files under 10 MB and rejected atomically if any path fails; each surviving path is copied into an immutable cache entry whose id derives from the message or reply request and the path's position in it. A manually pasted absolute path is simply read by the Agent; Host touches nothing it does not own.

That request-derived identity is what makes retries cheap: a repeated send or reply converges on the entry the first attempt prepared instead of writing an orphan, so the stored body — one `[attachment]` line per file — stays identical across retries. A message or reply that fails after preparation removes the entries this attempt prepared which no committed Message references, with the ledger's reference set as the guard; genuinely unreferenced uploads stay GC's to reclaim.

On a reused request id the ledger compares the recorded resolved attachment ids with the retry's resolved ids, so a retry carrying a different attachment set is refused as a collision.

## Human profile and version footnote

The Human's display name and avatar reference live in the Team Host row's own Config, in the settings namespace `wowyuarm-agent-team-host` (user layer); avatar bytes live in the persistent `$DSH_HOME/agent-team/human/v1/` store, never in the TTL-bound attachment cache.

The retired `agent-team-human` section is no longer an authority: the rc.1 settings importer carries sections across through a closed built-in mapping, so a third-party section stays behind in the renamed legacy document. A boot that finds the row still pristine — the default name and no avatar — adopts those facts through the same write path the settings page uses, and anything already re-entered wins.

Four typed Remotes serve the settings page: `humanProfile` (name, avatar reference, and version footnote facts) and `putHumanAvatar`/`getHumanAvatar`/`removeHumanAvatar` (images only, 10 MB cap shared with attachments; a removed entry throws and the Client falls back to the initial).

The footnote carries the version of the bundle this Host runs from — read from the installed package's own manifest, so it states what the profile actually installed rather than a string every release must remember to bump — plus the repository link and an update tip naming the newer version once a background check has observed a newer published release. The check asks the public npm `latest` document at most every 12 hours, refreshes in the background so profile reads never wait on the network, settles every failure as "no update known", and stays off while `DSH_AGENT_TEAM_UPDATE_CHECK=0`.

The ledger reads the same profile for `team_view` and @ matching, so a rename reaches every surface at once; `human` stays a permanent alias for the Human and no agent handle may claim the literal, so `@human` keeps delivering across renames while chips render the current display name.
