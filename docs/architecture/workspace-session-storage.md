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

First creation prefers the default Workspace initialized by the Harness controller, then tries the registry in order; when none is usable it returns `no-workspace` and creates no Session. An existing Session resumes only in a Workspace whose path exactly matches its stored cwd.

### Open and replacement rules

Open, new conversation, and startup restore share one serialized chain. Concurrent first opens create one Session, and concurrent new-conversation requests with the same expected id create one successor.

| Entry point | When the registered Session is archived or missing |
| --- | --- |
| Open | Creates a replacement. An absent pointer also allows creation. |
| New conversation with a stale expected id | Looks up the current pointer. If its Session is lost, returns `unavailable` without creating a replacement. |
| Startup restore | Leaves the pointer alone for the next open. Startup can resume a Session but never creates one. |

These rules also apply if archival is discovered after the stored read, or if resume reports `missing` when opening the log for writing. An unreadable log (`refused`, `corrupt`, `io`, or `unknown`) is not a missing log. Those failures and pointer read/write errors return `unavailable`, not a replacement.

### Publication and archival

Replacement persists the pointer before publishing the successor, immediately denying the old manager. Each live generation owns its Agent handle, tool policy, and skill mount. Cleanup stops that handle before releasing its policy and mount. If the handle fails to stop, the guard stays installed and denies execution.

The Host then tries to archive the retired Session without deleting its log. An archival failure logs a warning without rolling back the successor. Workspace archival and pointer persistence are separate, so a race can leave an archived Session registered; the next open can replace it.

### Private manager resources

Manager-private resources live under `$DSH_HOME/agent-team/manager`: `memory.md`, `notes/`, and `skills/`. They are not ledger facts. [Host authority](host-authority.md#member-capabilities-and-skills) owns the isolated skill roots and their precedence.

The manager's preset row injects memory only for the exact current manager Agent, not through the Member context plugin. [Memory and context](../team-collaboration/memory-and-context.md#team-manager-memory-and-skills) owns the shared injection rules and the manager's cwd-relative wording.
