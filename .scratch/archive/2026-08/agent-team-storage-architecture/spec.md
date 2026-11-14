# Agent Team Ledger Storage Design

Status: accepted in part — see §0

Date: 2026-08-23

## 0. Decision Update (2026-08-23)

Human-confirmed release scope:

- **This release:** Phase A (v1 reset) + Phase B (route `agent_team` to
  SQLite via public composition). No Harness source modifications.
- **Deferred post-release:** Phase C (public log facet), Phase D (validated
  checkpoint), and archive-segment work (§5.8). The log facet requires
  modifying `../deepseek-harness` storage packages, which is outside this
  bundle's boundary unless separately approved; a KV-only snapshot cannot
  deliver tail-only startup because `loadAll()` still validates every record.
- **Version reset timing:** performed once, alongside the SQLite cutover, in
  this release train. Physical store markers (`PRAGMA user_version`,
  `units` stamps) are independent of the logical domain version, so a later
  physical change never re-numbers the logical format.
- **Old local media:** rejected by shipped code with no migration path. Local
  data conversion is an operator-run one-off task outside the product; no
  export/import tool ships.

Verified feasibility facts for Phase B (checked against Harness source):

- `DomainFacility` config natively supports per-domain overrides:
  `routes[spec.name] ?? backend`
  (`packages/storage/storage-domain/src/index.ts`). No routing code changes.
- The web-app bundle patch inserts the `storage`, `storage-json`, and
  `storage-domain` rows. This bundle installs at profile level, whose patch
  layer applies after shipped bundle layers, so it can insert a
  `@deepseek-ai/dsh-storage-sqlite` row and override the `storage-domain`
  row by id. A patch replaces the targeted row's whole config, so the Team
  patch must restate `backend: json` — a coupling point to maintain when
  upstream adds keys.
- The sqlite backend is complete but mounted by no composition today; Team
  is its first production consumer. Its README already declares the
  synchronous `DatabaseSync` limitation as acceptable at domain-data scale.
- Open verification item: whether `@deepseek-ai/dsh-storage-sqlite` resolves
  in a real installed profile layout (web-app depends only on storage,
  storage-domain, storage-json). If the profile peer fallback does not
  provide it, this bundle must carry it as a regular dependency. Verify in
  the copied-package release layout used by `scripts/team-ui.e2e.ts`.

### Implementation Results (2026-08-23)

Both issues implemented (uncommitted at the time of writing):

- Composition: `storage-sqlite` insert row + top-level `storage-domain`
  override. First e2e attempt caught a real composition rule — insert lists
  append and never override, so the override had to move to a top-level row;
  shipping.spec now replays both patch layers through `applyEntryPatches` to
  keep this guard semantic, not textual.
- Dependency resolution: regular dependency + an e2e install-step link,
  because the heal fallback only links the dsh app manifest's dependency
  closure, which does not contain storage-sqlite.
- Real Web journey passes end to end with the routed medium.
- Benchmark (storage layer only; ~3.4 KB payloads):

| backend | operations | total | mean/op | p95/op |
| --- | --- | --- | --- | --- |
| json | 1k | 15.1s | 15.0ms | 19.5ms |
| sqlite | 1k | 5.9s | 5.9ms | 7.7ms |
| json | 10k | 401s | 40.1ms | 64.1ms |
| sqlite | 10k | 66s | 6.6ms | 10.6ms |

JSON write cost grows linearly with history; SQLite stays flat at the
per-statement fsync floor. The startup-side full `loadAll()` + replay is
unchanged by design in this phase.

## 1. Decision Summary

The current Team ledger is correct at its present size, but its physical
storage shape has two separate scaling limits:

1. The default JSON backend rewrites the complete `agent_team.json` file for
every operation. Write cost grows with the whole medium.
2. Startup asks `storage-domain` to load and schema-validate every operation,
then `AgentTeamLedger` validates and applies the complete history. A checkpoint
stored as another ordinary KV record would not avoid that first full
`loadAll()`.

The recommended long-term shape is:

1. **Route `agent_team` to SQLite first.** This removes JSON whole-file rewrite
cost without changing Team operation semantics.
2. **Add a log-shaped storage seam.** Prefer a public Harness `log` facet beside
`kv`, with durable append and range reads. The Team must not open SQLite
directly or bypass `ctx.storageDomain` without a public contract.
3. **Add a validated checkpoint cache.** Store a complete Team projection at a
committed operation boundary. On boot, validate it and replay only the tail.
A missing, stale, corrupt, or unverifiable checkpoint is a cache miss and falls
back to full replay.
4. **Do not physically delete history in the first implementation.** Keep the
operation log as authoritative history. Add sealed archive segments only if
measurements show that SQLite history itself becomes a problem.
5. **Reset the logical `agent_team` domain version to `1` before public
release.** Local v8/v9 media are rejected and recreated; no runtime migration,
compatibility reader, or silent fallback is shipped.

This changes storage and restore mechanics, not Team semantics. The append-only
operation ledger remains the only durable authority. The in-memory projection,
checkpoint, Inbox, Remote, UI, and agent wake/context are derived layers.

### 1.1 Expected effects

These are directional effects, not benchmark results:

| Change | Expected benefit | What does not change / new cost |
| --- | --- | --- |
| JSON -> SQLite for the hot Team route | A write changes one operation row plus SQLite journal/WAL pages instead of rewriting the whole JSON medium. Write amplification should stop growing linearly with the entire file. | Current `loadAll()` still reads every operation, so startup is almost unchanged in this phase. `DatabaseSync` can block the Node event loop; JSON is easier for manual inspection. |
| Validated checkpoint + tail replay | Replay validation and projection reconstruction depend on checkpoint size plus the post-checkpoint tail, instead of replaying all historical operations. | A checkpoint that contains all historical Message/Activity bodies still grows with history. It is a replay accelerator, not automatically a constant-time startup solution. |
| Current-state checkpoint + lazy/indexed history | Startup can stay bounded by current mutable state and a small tail; old Thread bodies are read from indexed history only when requested. | Requires a larger ledger/read-model refactor and a log/query storage contract. History remains durable; it is not discarded. |
| Sealed archive segments | Keeps the hot SQLite portion small while preserving old operations for audit and history. | Adds manifests, checksums, range lookup, crash recovery, and backup complexity. The first version should not delete history. |
| Explicit single-writer guard | Prevents two Hosts from calculating conflicting sequences from stale projections. | This is not horizontal write scaling. A second Host must fail clearly or a future service/CAS protocol must own the write authority. |
| Reset logical version to v1 | Removes experimental v8/v9 compatibility burden and lets the first public format be designed cleanly. | Existing local Team data is not carried forward automatically. Member sessions and private-memory leftovers may need deliberate cleanup when starting a fresh profile. |

At the observed scale (about 1.3 MB and 384 operations), the visible latency
change may be small. The value is avoiding a write cost and startup algorithm
whose cost grows with every future operation. Exact thresholds should come from
1k/10k/100k-operation benchmarks rather than an arbitrary constant.

## 2. Research Scope and Evidence

### 2.1 `raft.build` is not a public storage design

`raft.build` is a collaboration product for humans and AI agents, not the Raft
consensus algorithm. Its public documentation describes product behavior and
external integration contracts. It does **not** publish the server database,
WAL, segment, snapshot, compaction, replication, or crash-recovery design.
The main service repository referenced by its npm packages is not available
through the public GitHub API at the time of this research. The published CLI
bundle contains no source or storage design documentation.

Sources checked:

- [Raft public docs discovery](https://docs.raft.build/llms.txt)
- [Raft public docs repository](https://github.com/botiverse/raft-docs)
- [Published CLI metadata](https://registry.npmjs.org/@botiverse/raft/0.0.17)
- [External Agent wake contract](https://github.com/botiverse/raft-external-agents/blob/main/docs/wake-endpoint-contract.md)

Therefore, claims such as “Raft uses database X”, “Raft compacts with snapshot
Y”, or “Raft scales through sharding” would be speculation. The design below
borrows documented product invariants, not an invented description of Raft's
private implementation.

### 2.2 Public patterns worth carrying over

| Public pattern | Documented behavior | Team storage implication |
| --- | --- | --- |
| Immutable messages | Sent messages cannot be edited or deleted. | Keep collaboration facts append-only; corrections are new facts. |
| Task as tracked message | A task has a stable number, status, optional owner, and a thread. | Keep task/thread identity and state transitions in ordered operations. |
| Follow and unread are separate | Following controls future notifications; history remains readable after unfollow. | Keep member-specific attention/read state separate from message history. |
| Activity versus push | Activity is a pull surface; push notifications are reserved for urgent attention. | Keep durable Inbox facts separate from bounded wake delivery. |
| Content-free wake | The external-agent bridge sends metadata-only wake hints; the agent reads message bodies separately. | Persist facts first, send a bounded hint second; the hint is never authority. |
| At-least-once wake reconciliation | Unconsumed wake hints survive and are reconciled after reconnect; burst wakes may be coalesced. | Coalesce notifications, but retain durable unread state and make retries safe. |
| Stable external event id | Reusing `externalEventId` returns the original event instead of delivering twice. | Preserve request-id idempotency independently of checkpoints and delivery. |
| Server/computer split | The server is the shared collaboration space; a local Computer runs and recovers agents. | Keep Team facts in Host storage and runtime effects outside the ledger. |
| Persistent agent workspace | Agent files and memory survive idle/wake and session resets. | Separate durable identity/history from ephemeral process state. |

Relevant product pages:

- [Messages](https://docs.raft.build/features/messaging/messages.md)
- [Threads](https://docs.raft.build/features/messaging/threads.md)
- [Tasks](https://docs.raft.build/features/collaboration/tasks.md)
- [Activity](https://docs.raft.build/features/messaging/activity.md)
- [Computers](https://docs.raft.build/features/server/computers.md)
- [Agent workspace](https://docs.raft.build/features/agents/workspace.md)
- [Agent lifecycle](https://docs.raft.build/features/agents/lifecycle.md)
- [Login with Raft and inbound event idempotency](https://docs.raft.build/developers/login-with-raft.md)

The useful design lesson is a three-way separation:

```text
durable facts  ->  derived attention/read views  ->  delivery/wake hints
```

The current Team design already follows this separation. Storage work must keep
it intact.

## 3. Current Baseline

The current implementation has these properties:

- One logical domain, `agent_team`, with one `operations` KV table:
  [`packages/agent-team/src/spec.ts`](../../../../packages/agent-team/src/spec.ts).
- Each operation has a global positive `sequence`, an `operationId`, a
  `requestId`, and a `previousOperationId` link.
- `AgentTeamLedger` serializes mutations with an in-process promise tail,
  writes the operation first, and applies it to memory only after the durable
  write resolves: [`packages/agent-team/src/ledger.ts`](../../../../packages/agent-team/src/ledger.ts).
- Construction and `validate()` sort all table entries, validate the complete
  transition history, and apply the complete history again.
- The projection contains current entities, message/activity history, Inbox
  markers, attention state, idempotency lookup, and derived indexes. It is
  rebuildable and is not a durable authority.
- The standard Web composition routes storage-domain to JSON. The JSON backend
  publishes one complete unit file per write. The SQLite backend publishes one
  JSON document per row, but its current `loadAll()` API still returns every
  row at domain open.
- The observed local medium is approximately 1.3 MB and 384 operations. The
  measured parse-and-replay median is approximately 10 ms. This is a design
  boundary, not an emergency performance incident.

Relevant Harness contracts:

- [`../deepseek-harness/docs/subsystems/storage.md`](../../../../deepseek-harness/docs/subsystems/storage.md)
- [`../deepseek-harness/packages/storage/storage/src/backend.ts`](../../../../deepseek-harness/packages/storage/storage/src/backend.ts)
- [`../deepseek-harness/packages/storage/storage-domain/src/index.ts`](../../../../deepseek-harness/packages/storage/storage-domain/src/index.ts)
- [`../deepseek-harness/packages/storage/storage-json/src/unit.ts`](../../../../deepseek-harness/packages/storage/storage-json/src/unit.ts)
- [`../deepseek-harness/packages/storage/storage-sqlite/src/unit.ts`](../../../../deepseek-harness/packages/storage/storage-sqlite/src/unit.ts)

The current storage contract guarantees atomicity and durability for one KV
primitive, and the domain layer serializes writes per domain. It does not
provide cross-table transactions, range reads, lazy record validation,
append-log semantics, or cross-process writer coordination.

## 4. Options Considered

### JSON append log with periodic rewrite

Rejected as the target. An append-only JSONL file could reduce the immediate
write size, but it would introduce torn-record recovery, truncation rules,
checksums, and compaction logic in a package whose existing JSON backend is
explicitly designed around whole-file atomic replacement. It also would not
provide indexed request lookup or range reads without another implementation.

### Entity-partitioned JSONL (evaluated 2026-08-23, rejected)

Splitting the ledger into per-Channel/per-Thread append-only JSONL groups
(for example ~50 records each) was raised and rejected. Team operations are
cross-entity (`team/member-removed` carries member, claims, activities,
tasks, threads, and inbox in one operation; `team/message-sent` updates a
Thread plus several members' Inbox and Attention), so entity partitions
would duplicate facts or need a second coordinating index, and multi-file
appends have no atomicity to protect the dense global sequence chain. It
also means hand-building rotation, manifests, checksums, torn-tail
truncation, and request-id indexes inside the Team package — the sealed
segment machinery deferred in §5.8, rebuilt as a private permanent backend.
Future medium migration is hardest from fragmented stores: the cheapest
migration source is one fully ordered log replayed into any target, verified
by the ledger's own full-replay validator. Segment-style append logs remain
the right shape for a future public Harness log facet (issue 03), where a
shared conformance suite owns these mechanics.

### Existing KV API plus a `projection_snapshot` table

Useful only as an interim cache. It can store a snapshot of the projection, but
`DomainFacility.open()` still calls `loadAll()` and validates every operation
record before Team can decide to use the snapshot. It therefore does not solve
true tail-only startup. Two separate `table.put()` calls also are not a
cross-table transaction under the current API.

### SQLite KV routing

Recommended as the first implementation. It changes a hot operation write from
whole-file replacement to one row update and preserves the current domain and
ledger contracts. It does not, by itself, solve full startup load/replay.

### Team directly importing `node:sqlite`

Rejected. It would bypass the public storage seam, duplicate backend lifecycle
and durability rules, and make the Team package responsible for Harness
storage internals. It would also create a second route that tests do not model.

### Team-owned custom log store

Acceptable only as a short-lived prototype if the Harness public seam blocks
progress. The store must still have one clear authority, explicit durability,
strict record validation, a single-writer rule, and a removable package
boundary. It should not become a hidden permanent backend.

### Public append-log facet plus checkpoint

Recommended final shape. The existing Harness design already distinguishes
append-only session logs from KV data. A `log` facet lets Team use durable
append/range semantics while keeping storage ownership in Harness and business
validation/authority in Team.

## 5. Target Architecture

### 5.1 Ownership model

```text
Human / Agent mutation
          |
          v
  AgentTeamLedger  -- one writer, one sequence
          |
          +--> authoritative append log (SQLite log facet)
          |          |
          |          +--> sealed history segments later, if needed
          |
          +--> in-memory Projection
          |          |
          |          +--> Inbox, Thread history, Remote, UI
          |
          +--> asynchronous projection checkpoint (rebuildable cache)
          |
          +--> bounded Agent wake/context notification
                     (delivery hint, never authority)
```

Only the append log is authoritative. The checkpoint may be deleted without
changing Team facts. The notification may be delayed, repeated, coalesced, or
lost; the next restore/notification pass derives state from the log again.

### 5.2 Immediate layout: route Team to SQLite

The first physical change can use the existing SQLite KV backend:

```text
one SQLite database
  units(name = agent_team, version = 1)
  u_agent_team_operations
    key   = operationId
    value = canonical operation JSON
```

This removes JSON whole-file rewriting from the hot path. It does **not** yet
provide tail-only startup because `storage-domain` still calls `loadAll()` and
validates every operation.

Changing the route is not itself a data migration. If the old JSON medium is
left at `$DSH_HOME/storages/agent_team.json`, SQLite can create a new empty
`agent_team` unit while the old JSON file remains untouched. That would look
like lost data or create two competing histories. The cutover must therefore
be explicit: stop DSH, back up and move/remove the old JSON medium, then start
with the new SQLite medium, or run a separately validated export/import tool
before switching the route. The Host must not silently choose one medium or
merge both.

The route must be configured through public storage composition:

```yaml
storage-domain:
  backend: json
  routes:
    agent_team: sqlite
```

The exact patch depends on the public bundle configuration rules and whether
the Web profile already loads `storage-sqlite`. If the Team bundle cannot add
the provider and route through public APIs, record a Harness extension
requirement. Do not mount a competing `DomainFacility` or open SQLite from the
Team Host.

The SQLite backend currently uses `DatabaseSync`, so a single statement can
block the Node event loop. WAL and row-level updates improve write
amplification, not CPU scheduling. Measure this before adding a worker-thread
or asynchronous database abstraction.

### 5.3 Final layout: append-log facet

The public storage seam should expose a log-shaped unit, conceptually:

```ts
interface DurableLog<Operation> {
  append(operation: Operation): Promise<void>
  readAfter(sequence: number): AsyncIterable<Operation>
  readRange(from: number, to?: number): AsyncIterable<Operation>
  readAt(sequence: number): Promise<Operation | undefined>
  findByRequestId(requestId: string): Promise<Operation | undefined>
  tail(): Promise<{ sequence: number; operationId: string }>
  close(): Promise<void>
}
```

The exact names and types belong to the Harness package. Required semantics:

- append resolves only after the record is durable;
- sequence order and expected previous operation are enforced by one explicit
  store owner or an atomic append transaction;
- range reads do not materialize the complete log;
- malformed records fail loudly at the record boundary;
- close drains accepted appends;
- an implementation can use SQLite rows now and sealed files later without
  changing Team ledger semantics.

A practical SQLite implementation would use a physical table like:

```sql
CREATE TABLE agent_team_log (
  sequence INTEGER PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  previous_operation_id TEXT,
  payload TEXT NOT NULL,
  digest TEXT NOT NULL
) STRICT;
CREATE INDEX agent_team_log_request ON agent_team_log(request_id);
```

`payload` remains the operation's canonical JSON. The SQLite schema should not
try to duplicate every Team field as columns until a measured query needs it.
The `sequence` primary key makes tail/range reads natural; unique request and
operation indexes preserve idempotency and receipt lookup.

### 5.4 Checkpoint contents

Use a strict, separately versioned checkpoint record/blob:

```text
checkpoint {
  checkpointFormat: 1
  ledgerFormat: 1
  coveredSequence
  coveredOperationId
  coveredLedgerDigest
  projection: complete canonical Team state
  checksum
}
```

The projection must preserve current behavior, including:

- current Channels, Members, memberships, Claims, Tasks, Threads, Attention,
  direct markers, and Activity markers;
- ordered Message/Activity facts needed by Thread history, observations, and
  `view()`;
- enough operation receipt/request metadata for idempotent retries before the
  boundary, or a durable indexed `findByRequestId()` path that can resolve
  those old operations without loading them all;
- any stable metadata needed for receipts and diagnostics.

Canonical arrays should be the checkpoint source of truth. Maps, sets, and
secondary indexes can be rebuilt from those arrays after schema validation.
Do not add a second durable Inbox table. A query index may exist as a cache,
but it must be rebuildable and checked against the canonical projection/log.

The checkpoint should not copy the entire raw operation list. That would make
it another log and eliminate much of the startup benefit. Keep old operations
in the log for history/audit and fetch them lazily when a caller needs a
specific old operation.

There are two checkpoint levels:

- **First useful level:** checkpoint the complete current projection, including
  the bounded in-memory fact indexes needed by today's implementation. This
  reduces replay CPU and is a safe intermediate step, but checkpoint load and
  memory still grow with retained history.
- **Long-term level:** checkpoint only current mutable state, attention/marker
  state, request/idempotency metadata, and compact per-Thread cursors. Keep
  Message/Activity bodies in an indexed durable history store and load them by
  Thread/sequence for `threadHistory`, `readThread`, and `view`. This is the
  version that keeps startup and memory from scaling with the entire transcript.

The second level still has one authority: the operation log. The indexed
history and current-state checkpoint are rebuildable projections. Recovery can
rebuild them from the log, and a full-audit mode can compare them with the log.

### 5.5 Restore algorithm

```text
open log
  -> read newest checkpoint
  -> strict schema parse + checksum check
  -> verify covered sequence/id/digest and checkpoint invariants
  -> load operations after coveredSequence only
  -> validate previous-operation link and each tail transition
  -> apply tail to checkpoint projection
  -> publish live ledger

any checkpoint uncertainty
  -> discard checkpoint as a cache miss
  -> full ordered log validation + replay
```

Checkpoint validation must check at least:

- all refs and map keys agree;
- current entity relationships and membership sets are legal;
- every fact points at an existing Task/Thread and has a unique sequence/ref;
- Inbox marker and Attention indexes agree with their canonical collections;
- `coveredSequence` is not ahead of the durable log;
- the first tail operation links to `coveredOperationId`;
- the checksum covers the canonical serialized checkpoint, not only its header.

The existing `previousOperationId` link detects continuity, but it does not
prove that an old skipped record was not edited. Add a rolling digest to each
new operation and store the boundary digest in the checkpoint before claiming
that the skipped prefix is integrity-verified. Until then, retain a full-audit
path and describe the checkpoint as a performance cache, not a complete audit
proof.

`AgentTeamLedger` should become an async restore factory, or receive an
already-built restore plan. The current synchronous constructor cannot perform
checkpoint I/O cleanly. Direct ledger tests can use an in-memory log fixture;
Host initialization can await the restore operation before publishing the
service.

For the long-term level, `AgentTeamLedger` also needs a history reader rather
than assuming every Message/Activity is resident in `Projection`. The public
API can stay the same; only the Host-side read implementation changes.

### 5.6 Commit and crash ordering

| Failure window | Durable state | Recovery result |
| --- | --- | --- |
| Before append resolves | No new operation | No projection change; caller sees failure. |
| Append resolves before in-memory apply | Operation exists; memory is old | Restart replays the operation. |
| Apply completes before checkpoint | Log and memory are current; checkpoint is old | Replay the tail after the old checkpoint. |
| Checkpoint write is torn/corrupt | Log is current; checkpoint is invalid | Checksum/schema failure causes full replay. |
| Checkpoint is older than the log | Both are valid | Tail replay is expected. |
| Checkpoint is ahead of the log | Checkpoint is invalid | Ignore it; never trust or truncate the log. |
| Shutdown during checkpoint | Log remains authoritative | Drain the worker or keep the last valid checkpoint. |

Checkpoint failure must never roll back an already durable operation. The
checkpoint writer is maintenance work after commit, with one serialized worker
and latest-covered-sequence wins.

### 5.7 Concurrency

M1's single Host-writer rule remains the default. SQLite's native writer lock
alone is not sufficient: two processes can calculate the same next sequence
from stale in-memory projections and construct incompatible operations.

The first SQLite implementation should either:

- acquire an OS/process lock for the Team medium and fail loudly when another
  Host owns it; or
- keep the documented single-process assumption and expose a diagnostic that a
  second writer is unsupported.

Do not add timestamp-only stale-lock breaking. If multi-process writes become a
real requirement, use an explicit transaction/CAS protocol or move the
authority to a service. Do not merge independent projections.

Within one process, retain the existing operation promise tail. A user-visible
operation resolves after its own append is durable. Checkpoint and archive
maintenance may be batched and coalesced, but must not delay or reorder the
ledger commit contract.

### 5.8 Hybrid hot log and archive segments

Separate these concepts:

1. **Checkpointing:** copy a projection for faster restore. Safe and
   recommended.
2. **Segmenting:** move old immutable operations into sealed, checksummed
   archive segments while retaining them as ledger history. Future option.
3. **Compaction/deletion:** remove raw operations because a checkpoint replaces
   them. Not safe under the current Team contract without preserving equivalent
   history, audit records, and request-id fingerprints.

If measurements justify a hybrid layout:

```text
SQLite hot tail:       checkpoint boundary + recent operations
sealed archive files:  older immutable operation segments
archive manifest:      contiguous ranges + hash links + checksums
checkpoint:            current projection + boundary metadata
```

Rotate only after the segment is sealed and fsynced. Publish the manifest last.
Recovery ignores unreferenced temporary files but rejects gaps, overlaps, bad
checksums, or broken hash links. Keep archived operations queryable for Thread
history and audit. Deleting them is a separate retention decision, not an
automatic compaction side effect.

## 6. Version Reset Decision

**Decision: reset `agent_team` to version `1` before public release.**

Reasons:

- The package is still pre-release and has no supported external data users.
- v8 was already a local experimental format that required a one-time rewrite
  after the routed Task Inbox change.
- The next durable shape may add a log store, checkpoint metadata, and
  operation integrity fields. Calling that v9 or v10 would preserve migration
  history with no external compatibility value.
- Harness storage intentionally rejects version mismatches and supplies no
  implicit migration. A clean break is safer than a compatibility layer or
  silent fallback authority.

Version 1 means “the first public logical Team ledger format.” It does not mean
the Harness SQLite physical schema version; `PRAGMA user_version` remains a
separate format marker.

### Reset procedure

1. Freeze the final operation and checkpoint schemas, including the pending
   mention-related fields in the current worktree.
2. Set `agentTeamDomainSpec.version` to `1` and describe it as the initial
   public format. Do not add a v8/v9 parser or runtime migration.
3. If the storage shape changes from KV to a log facet, give that physical
   store its own explicit format marker. Do not infer compatibility from the
   logical domain number.
4. Update test helpers, fixtures, test names, and maintained documentation from
   v8/v9 to v1. Keep tests proving old stamped media fail loudly.
5. For local development, stop DSH, copy the old medium if it matters, then
   move or remove the old `agent_team` JSON/SQLite medium and start the new
   build. A rejected old medium must not be silently deleted by Host startup.
   Use a fresh DSH home/profile when possible. The old ledger's Member session
   records and private-memory directories are separate from the Team medium;
   inspect and clean them deliberately rather than assuming the domain reset
   removes them.
6. If a developer temporarily needs the old data, use a separately run,
   validated export/import tool that writes the new v1 format. This is an
   operator tool, not a shipped runtime compatibility path.
7. After the first public release, logical version changes must be monotonic;
   each breaking change needs an explicit migration or a documented clean-break
   policy before release.

Perform the reset once, alongside the final schema/storage cutover. Do not
keep resetting the number while the design is still changing.

## 7. Implementation Sequence

### Phase A: finish the v1 contract

Files:

- `packages/agent-team/src/spec.ts`
- `packages/agent-team/src/types.ts`
- `packages/agent-team/src/ledger.ts`
- `packages/agent-team/tests/agent-team.spec.ts`
- `packages/agent-team/tests/update-operations.spec.ts`
- `packages/agent-team/README.md`
- `docs/architecture.md` and `docs/development.md` when current behavior
  changes

Work:

- finish the pending schema changes as one coherent public v1 shape;
- update version fixtures and old-medium rejection tests;
- keep one operation authority and one replay validator;
- do not mix this storage work with unrelated Client or Member-context edits.

### Phase B: route Team to SQLite and benchmark

Files/areas:

- Team bundle composition (`cordis.patch.yml`), if the public patch API can add
  the SQLite provider and route only `agent_team`;
- adjacent Harness Web storage composition only if a public extension requires
  an upstream change;
- `packages/agent-team/tests/agent-team.spec.ts` and a new storage benchmark
  fixture;
- `docs/development.md` for the verified route and benchmark command.

Work:

- route only `agent_team` to SQLite;
- verify JSON-backed domains remain unchanged;
- verify a route cutover cannot leave two silently competing Team media;
- measure append latency and bytes written at 1k, 10k, and 100k operations;
- document that this phase improves writes but not `loadAll()` startup cost.

### Phase C: add the public log facet

Likely Harness files:

- `../deepseek-harness/packages/storage/storage/src/backend.ts`
- `../deepseek-harness/packages/storage/storage-sqlite/src/{index,unit,schema}.ts`
- `../deepseek-harness/packages/storage/storage-json/src/{index,unit,format}.ts`
  if JSON conformance is retained
- shared storage contract tests

Team files:

- `packages/agent-team/src/log-store.ts`
- `packages/agent-team/src/ledger.ts`
- `packages/agent-team/src/index.ts`
- `packages/agent-team/tests/`

Work:

- define append/range/tail semantics and failure behavior;
- make restore an explicit async operation;
- keep schema validation at the log record boundary;
- make the one-writer policy explicit and tested.

### Phase D: add checkpoint restore

Team files:

- `packages/agent-team/src/checkpoint.ts`
- `packages/agent-team/src/ledger.ts`
- `packages/agent-team/src/index.ts`
- `packages/agent-team/tests/checkpoint.spec.ts`

Work:

- define strict checkpoint schema, canonical serialization, checksum, and
  projection invariant checks;
- write checkpoints after durable append and live apply, with coalescing;
- restore from checkpoint plus tail;
- full-replay fallback on every uncertainty;
- compare checkpoint restore and cold replay in tests;
- retain an explicit full validation path for audits and corruption detection.

### Phase E: decide on archives from measurements

Do not start physical compaction until Phase B and D measurements show a real
need. If archives are needed, first write a product decision covering
historical reads, audit retention, idempotency after compaction, backup,
restore, segment checksums, and retention/deletion policy.

## 8. Test Matrix

| Area | Required test |
| --- | --- |
| v1 reset | v1 opens fresh media; v7/v8/v9 media reject with version mismatch; no automatic deletion or fallback. |
| SQLite route | Team writes survive Host close/reopen; unrelated JSON domains still use JSON. |
| Append durability | Failure before durable append leaves projection unchanged; restart after append recovers the operation. |
| Checkpoint equivalence | Valid checkpoint plus tail produces the same status, Inbox, history, view, and idempotency behavior as full replay. |
| Checkpoint fallback | Missing, malformed, checksum-invalid, stale, ahead-of-log, broken-boundary, and semantically invalid checkpoints all fall back to full replay. |
| Tail validation | Broken previous link, sequence gap, duplicate request, and forged tail projection are rejected. |
| Retry semantics | Requests before the checkpoint resolve identically; payload drift still collides. |
| History | Thread history and attention observations remain correct across checkpoint boundaries. |
| Crash windows | Append/apply/checkpoint and close races converge without losing committed operations. |
| Concurrency | A second writer is rejected or the documented single-writer failure is observable; independent writers never silently merge. |
| Scale | Benchmarks record startup time, tail length, append latency, checkpoint size, and bytes written at 1k/10k/100k operations. |
| Archive, if added | Segment seal, manifest publication, crash recovery, range reads, gaps/overlaps/checksum failures, and retention policy. |

## 9. Acceptance Criteria

The design is ready for implementation when:

- the Team route is known to use SQLite in the real Web composition;
- the public storage seam needed for range reads is accepted by Harness or an
  explicit Team-owned alternative is approved;
- deleting a checkpoint changes only boot time, not durable facts or public
  behavior;
- a full replay remains available and is covered by tests;
- v1 reset behavior is documented and old local media failure is intentional;
- benchmark results, rather than an arbitrary operation count, set the first
  checkpoint and archive thresholds.

## 10. Open Constraints

- The current `storage-domain` API cannot provide true tail-only startup by
  itself because it eagerly `loadAll()`s and validates all declared records.
- The current SQLite backend uses `DatabaseSync`, so high-frequency writes can
  block the Node event loop even after whole-file rewrite cost is removed.
- The current storage packages do not provide cross-process writer locking,
  cross-table transactions, or a log facet.
- The current Team invariant path performs full ledger validation after commits;
  scaling work must distinguish incremental validation from explicit full audit.
- `raft.build` storage internals remain unavailable publicly. Any design claim
  about its database, replication, or compaction needs new primary evidence.
