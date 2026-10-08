# Workspace, Session, and storage reuse

English | [中文](workspace-session-storage.zh.md)

Team reads the existing Harness Workspace projection and does not create a second Workspace store or Session tree. The Client does not create Workspaces; users return to ordinary Session UI for that. Member sessions appear in the ordinary list, but cold Members cannot resume there because the ambient shipped preset registry declares no `team-member` definition; resume through the Team panel or restart with a healthy bundle.

For Workspace, Session, storage, persistence, or Thread Inbox changes, read the relevant Team source/tests and Harness `workspace.md`, `session.md`, `storage.md`, `persistence.md`, and `defensive-patterns.md`. The ledger remains the only Team authority, and recovery changes require failure-window or composition evidence.

The published bundle routes only `agent_team` to SQLite at `$DSH_HOME/storages/agent_team.sqlite`; every other domain keeps JSON. The medium is created fresh and an older `agent_team.json` is never read or migrated. The backend is a vendored fork under our own package name (`@contexera/dsh-agent-team/sqlite-backend`, see `packages/agent-team/src/vendor/storage-sqlite/`); [`development/storage-and-delivery.md`](../development/storage-and-delivery.md) owns why the fork exists and the boot constraint a loader row must not reintroduce.

Message sources are producer-attributed on the dsh `0.1.7-rc.1` line: Session format V4 requires every durable source to carry its producer's own kind (never the retired `{ kind: 'plugin', plugin: … }` wrapper, which write admission refuses), and released V3 history is converted at read time — `plugin:<producer>`, `plugin` key dropped, `form`/`sections`/`summary` preserved — never rewritten on disk.

The read side recognizes both shapes for all three of this bundle's producer ids by exact identity, in one place (`packages/agent-team/src/context-source.ts` and the two per-Member producers that own their ids).

The startup write-side repair pass that earlier lines shipped (`session-remediation.ts`) was removed with the V4 cut: what it published was exactly the wrapper V4 refuses at write time, and the bespoke pre-0.1.5 kinds it targeted are refused by the released migration chain before the read-time conversion runs, so they have no repair path — such an artifact stays refused with its deterministic `session-refused` diagnostic on every retry.

Every per-Session stored read the Host performs goes through one seam, `packages/agent-team/src/stored-session-reader.ts`: one `open → read → close` cycle with the handle guaranteed closed, and every failure normalized into five categories — `missing`, `refused` (deterministic format refusals, carrying the artifact location), `corrupt`, `io`, and `unknown`.

Consumers choose policy by category and never match Harness error text: current-binding activation and checkpoint-seed resolution fail closed on any failure, carried-input replay skips only the deterministic `refused`/`corrupt` classes of a retired generation, handoff reconstruction and token measurement degrade, and the timeline truncates its lineage walk at an unreadable ancestor and reports `incompleteFrom` instead of silently ending. A DSH persistence-interface change is adapted in this one module.

The shipped JSONL backend throws its corruption family as plain `Error`s, so corruption is matched by that stable message prefix inside the seam; if the text ever changes, the failure degrades to `unknown`, which every consumer treats conservatively.

Member restart is the bounded self-heal for refusals: when activation failed with a `session-refused` diagnostic, `recoverMember` re-runs the activation — a transient refusal heals, and a deterministic one replays the same refusal into the refreshed diagnostic, since no write-side repair pass exists.

Activation diagnostics are structured — `AgentTeamMemberDiagnostic` carries a `class` (`session-refused`, `session-unreadable`, `preset-composition`, `rollover`, `runtime`, or `activation`), a detail, and where applicable the refused artifact location. Availability/presence remain the only user-facing states; diagnostics are projection-derived, never persisted, and the ledger stays the sole Team authority.
