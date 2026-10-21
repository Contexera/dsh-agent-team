# Tools and preset

English | [中文](tools-and-preset.zh.md)

The explicit `team-member` preset is the only Team Member composition. It adds coding capability rows (shell, filesystem/search, web search and fetch, background jobs, the skill loader tool, compaction), collaboration guidance/tools, Harness Workspace instruction discovery, and bounded private-memory context. Skill discovery itself is not a preset row: each Member's provider is Host-registered on its agent scope (see Host authority). Ordinary Sessions remain outside this roster and receive no Team prompt sections, tools, or Member memory.

Every row `name:` is a bare specifier the Loader resolves against the profile, not against this bundle. A profile links this bundle and the host closure, so a row may name a host package or one of this bundle's own subpaths, and never a package nested inside this bundle's dependency tree. A name that resolves in a working tree can still leave the row `never started` in a real install, so a dependency's module reaches a row only through a re-export under this bundle's own name.

The seven tools are defined in `packages/tool-agent-team/src/index.ts`; their contract is in [`tools.md`](../team-collaboration/tools.md). They mount under the isolated `team-member` preset. The Web Client is the only Human control surface and delegates every mutation through `ctx.agentTeam` typed Remote; do not restore a slash-command adapter.

A Member has no context tool at all. Its Session is compacted in place by the engine when it grows large — the preset's `compaction-basic` row mounts this bundle's own `team-compaction-engine`, a `BasicCompactionEngine` subclass that only supplies the measured seven-section summary template, with `auto` on and the trigger at 256K. Generation swaps are Host decisions, never model ones, so there is nothing for a tool to schedule and nothing for a model to cite.

The generation swap is owned by `team-context-management.ts`, Team's own coordinator. It watches each Member Session's events, derives the pending intent from the durable `tool/call`+`tool/result` pairs (legacy logs still carry rollover pairs written by earlier builds; no current build produces them), and executes the swap through the serialized lifecycle queue:

1. wait for true idle;
2. recheck the owned-jobs guard at the commit seam;
3. retire the old generation (dispose + archive, never delete);
4. commit the idempotent `team/member-session-recycled` operation as the Host actor;
5. activate the fresh Session, parented at the one it replaces;
6. deliver any carried non-Team input via followup, then rederive the Inbox.

The successor's first model-facing context is its ordinary per-step injection — identity, `memory.md`, the workspace list — plus the message that woke it. There is no handoff envelope and no generation announcement: a successor told it received a handoff performs a handoff instead of reading its memory.

The fold is Team's own `contextContinuity` projection unit, registered once per host at Team service init. `context-projection.ts` carries the durable ref naming, the Team-notice rule, the boundary classification (`team-boundary`, `handoff`, `compaction`), the claim boundary's Task→Thread attribution, and the fork cut, so a seeded child's inherited prefix folds back to the same reference. `context-codec.ts` is the one writer of the two envelopes it reads back, byte-identical to what earlier builds wrote.

Crash recovery is log-derived. A restart replays a pending intent and finishes the swap; a legacy pending whose containing turn never ended durably is spent and is discarded instead of leaving the generation permanently un-swappable.

Quiet checkpoint continuations deliver exactly once (per-member latch in-process, the projection's durable delivery record across restarts).

Carried-input replay after a restart is bounded. A current generation that already started its own turns skips the replay (its carried input was delivered or superseded while it ran). An unreadable retired previous Session fails open with a warning for two bounded classes — log corruption (`corrupt session log`, whose torn tail the Host repairs) and a deterministic released-format refusal (`SessionFormatUnsupportedError`, which no retry can change) — while missing/IO and unknown causes stay fail-closed, so a retired generation's readability never gates the Member's activation once the current one has run.

Whether a Member Session has durable persisted content is decided through session-persistence inspection (which awaits in-flight retirement drains), never a bare metadata listing that races a suspend's final flush.
