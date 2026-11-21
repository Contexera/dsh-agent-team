# Workspace, Session, and storage reuse

English | [中文](workspace-session-storage.zh.md)

This page owns reuse of Harness storage and the manager Session pointer. [Host authority](host-authority.md) owns Team lifecycle decisions; [Client and Remote](client-and-remote.md) owns navigation.

## Workspace reuse and Member Sessions

Team reads the existing Harness Workspace projection and does not create a second Workspace store or Session tree. The Client does not create Workspaces; users return to ordinary Session UI for that.

Member Sessions appear in the ordinary list, but cold Members cannot resume there because the ambient shipped preset registry declares no `team-member` definition; resume through the Team panel or restart with a healthy bundle.

For changes here, read Team source/tests and the contracts linked by [Harness navigation](../harness-navigation.md). Recovery changes need failure-window or composition evidence, not a silent fallback.

## Private storage facility

The Host has a private SQLite-backed `DomainFacility` at `$DSH_HOME/storages/agent_team.sqlite`. Toggling leaves the global storage route and unrelated consumers unchanged. The medium starts fresh; an older `agent_team.json` is never read or migrated.

The backend is a vendored fork under our own package name (`@contexera/dsh-agent-team/sqlite-backend`, see `packages/agent-team/src/vendor/storage-sqlite/`); [`development/storage-and-delivery.md`](../development/storage-and-delivery.md) owns why the fork exists and the boot constraint a loader row must not reintroduce.

## Stored Session reads and compatibility

Message sources are producer-attributed. Session format V4 requires every durable source to carry its producer's own kind (never the retired `{ kind: 'plugin', plugin: … }` wrapper, which write admission refuses). Released V3 history is converted at read time — `plugin:<producer>`, `plugin` key dropped, `form`/`sections`/`summary` preserved — never rewritten on disk.

The read side recognizes both shapes for each of this bundle's producer ids, current and legacy, by exact identity, in one place (`packages/agent-team/src/context-source.ts` and the two per-Member producers that own their ids), so a Session written before the rename still reads.

There is no Team write-side Session repair pass. A format the Harness migration chain refuses remains refused on retry; Team reports `session-refused` rather than rewriting the artifact.

Every per-Session stored read the Host performs goes through one seam, `packages/agent-team/src/stored-session-reader.ts`: one `open → read → close` cycle with the handle guaranteed closed, and every failure normalized into five categories — `missing`, `refused` (deterministic format refusals, carrying the artifact location), `corrupt`, `io`, and `unknown`.

Consumers choose policy by category and never match Harness error text. Current-binding activation fails closed on any failure, the wake decision treats an unreadable Session as resume, and carried-input replay skips only the deterministic `refused`/`corrupt` classes of a retired generation. A DSH persistence-interface change is adapted in this one module.

The seam recognizes typed `SessionPersistenceCorruptionError` failures and the JSONL backend's plain-`Error` `corrupt session log` message family, including wrapped causes. An unrecognized failure becomes `unknown`; callers treat it conservatively.

When activation failed, `recoverMember` retries activation through the [Host recovery ladder](host-authority.md#which-operations-wake-a-member-and-how-recovery-is-chosen). A transient read failure may recover; a deterministic format refusal repeats the same diagnostic. Retrying is not a format repair.

`AgentTeamMemberDiagnostic` adds a structured reason to availability and presence, not another durable state. Its classes cover Session reads (`session-refused`, `session-unreadable`), composition and activation (`preset-composition`, `activation`), transitions and execution (`rollover`, `runtime`), and committed configuration effects (`capability-apply`, `model-apply`).

Diagnostics carry detail and, when available, the artifact location, Session id, source, and observation time. They are derived at runtime, never persisted.

## Team manager Session

The Host owns one dedicated [Team manager](../domain-model.md#team-manager) Session. Its durable destination is a singleton `pointer` row in the private `agent_team_manager` domain, in the same SQLite file as Team but outside the operation ledger. The row stores `{sessionId, workspaceId, previousSessionIds?}`; the optional lineage keeps replaced managers recognizable as Team-owned history, and old pointers without it remain readable.

`workspaceId` is restoration and display metadata, not a second existence authority. A pointer-store open failure is logged and leaves the manager unavailable without failing Host boot or the Team ledger.

First creation asks the shipped Workspace controller to initialize its default Workspace, then takes the first usable Workspace in registry order; when none is usable it returns `no-workspace` and creates no Session. An existing Session resumes only in the Workspace whose path exactly matches its stored cwd. Startup pre-restore resumes a readable registered Session but never creates one; an absent pointer or an archived registered Session is left for the next open.

### Open and replacement rules

Public opens and replacements share one serialized chain. Concurrent first opens create one Session, and concurrent new-conversation requests under one expected id create one successor; a stale caller observes the current Session instead of creating another. For an existing pointer, only an archived Session or a stored read that positively reports `missing` is replacement-eligible. `refused`, `corrupt`, `io`, `unknown`, pointer-read, and pointer-write failures return `unavailable` and retain the pointer.

### Publication and archival

Replacement persists the pointer, then publishes the successor and immediately denies the old manager. After the old handle stops, the Host archives the retired Session without deleting its log, so the successor stays in the active list and the predecessor moves to the Workspace's archive view.

Archival is best-effort after publication: a failure is warned about without rolling back the successor or deleting history. Workspace archival and pointer persistence are separate authorities, so a race can leave them briefly out of step; the next open converges by replacing an archived manager rather than by a cross-authority atomic transaction.

### Private manager resources

Manager-private resources live under `$DSH_HOME/agent-team/manager`: `memory.md`, `notes/`, and `skills/`. They are not ledger facts. [Host authority](host-authority.md#member-capabilities-and-skills) owns the isolated skill roots and their precedence.

The manager's memory reaches its context through its own preset row, not through the Member context plugin: the row asks the Host whether this exact Agent is the current manager, reads `memory.md` from that private root, and injects the same bounded index block a Member gets — one complete baseline, then a stale-copy notice after the file changes. The block states where the private root sits relative to the Session's actual cwd, because the manager runs inside a Workspace rather than outside every one.
