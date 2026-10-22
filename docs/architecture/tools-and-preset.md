# Tools and preset

English | [中文](tools-and-preset.zh.md)

The explicit `team-member` preset is the only Team Member composition. It adds coding capability rows (shell, filesystem/search, web search and fetch, background jobs, the skill loader tool, compaction), collaboration guidance/tools, Harness Workspace instruction discovery, and bounded private-memory context. Skill discovery itself is not a preset row: each Member's provider is Host-registered on its agent scope (see Host authority). Ordinary Sessions remain outside this roster and receive no Team prompt sections, tools, or Member memory.

Every row `name:` is a bare specifier the Loader resolves against the profile, not against this bundle. A profile links this bundle and the host closure, so a row may name a host package or one of this bundle's own subpaths, and never a package nested inside this bundle's dependency tree. A name that resolves in a working tree can still leave the row `never started` in a real install, so a dependency's module reaches a row only through a re-export under this bundle's own name.

The seven tools are defined in `packages/tool-agent-team/src/index.ts`; their contract is in [`tools.md`](../team-collaboration/tools.md). They mount under the isolated `team-member` preset. The Web Client is the only Human control surface and delegates every mutation through `ctx.agentTeam` typed Remote; do not restore a slash-command adapter.

A Member has no context tool at all. Its Session is compacted in place by the Harness's own `@deepseek-ai/dsh-compaction-basic` — the preset's `compaction-basic` row names that package unmodified, with `auto` on and the ratio configuration described in [`memory-and-context.md`](../team-collaboration/memory-and-context.md). Generation swaps are Host decisions, never model ones, so there is nothing for a tool to schedule and nothing for a model to cite.

The generation swap is owned by `team-context-management.ts`, Team's own coordinator. It starts from a Host wake decision rather than a durable intent, executes through the serialized lifecycle queue, and takes the successor's identity from the retired Session so a crash converges on one successor:

1. wait for true idle;
2. recheck the owned-jobs guard and the ordinary-input queue at the commit seam — a queued ordinary message defers the swap;
3. inside `agent.runMaintenance`, commit the idempotent `team/member-session-recycled` operation as the Host actor, recording `inputFromSeq` (the retired log's offset) when a live generation exists;
4. retire the old generation: its pre-step gate rejects the step without a model request, then dispose and archive (never delete); the original inbox insertions remain in the log even if already claimed;
5. activate the fresh Session, parented at the one it replaces;
6. fold the retired log from `inputFromSeq`, drop every message the successor already holds by id, deliver the rest by followup, then rederive the Inbox from the ledger.

Maintenance is what makes the commit safe against input arriving mid-swap: the loop is parked there, so a new message waits in the durable inbox instead of reaching the generation being retired. A failed commit releases maintenance and the old generation continues; a committed one retires it, and startup or recovery finishes a swap interrupted before the replay.

The successor's first model-facing context is its ordinary per-step injection — identity, `memory.md`, the workspace list — plus the message that woke it. There is no handoff envelope and no generation announcement: a successor told it received a handoff performs a handoff instead of reading its memory.

The fold is Team's own `contextContinuity` projection unit, registered once per host at Team service init. `context-projection.ts` owns the durable checkpoint-ref naming, the Team-notice rule, the fork cut, and the folded state a generation reads back: its checkpoints with their turn-end delivery state, at most one legacy rollover intent, the continuation delivery records, and the unconsumed non-Team input the retired generation never consumed. The tool names it still decodes (`context_rollover`, `new_context`, `context_checkpoint`) are decoders for logs written by earlier builds, not tool aliases.

`context-codec.ts` writes the one envelope this build still produces, the quiet checkpoint continuation. Recognition of that envelope, and of the two shapes earlier builds wrote, lives in `context-source.ts`; the handoff writer survives only as a test helper for those legacy shapes.

Crash recovery is log-derived. An interrupted swap is finished from the recorded binding and the retired Session, and a legacy pending intent whose containing turn never ended durably is spent and discarded instead of leaving the generation permanently un-swappable.

Carried-input replay is bounded and keyed by Message id. A swap records `inputFromSeq`, the retired log's offset at commit, so the fold counts only input at or after that boundary, and the retired Session's log is the only source — no message content is held in memory for the carry. A successor that already started its own turns is not skipped for that reason: the boundary and the successor's own log and inbox queues decide which messages it still lacks. Only a legacy transition without `inputFromSeq` skips the replay along its started generation.

`agent-instructions` messages are regenerated by the successor rather than replayed as standalone turns.

A canceled inbox splice does not identify who removed the message. Replay must preserve input cleared by disposal, so an explicit queue removal or replacement racing this swap can also be replayed. Ordinary Session cancel retains pending input by design; this limitation concerns queue editing during the transition.

An unreadable retired previous Session fails open with a warning for two bounded classes — log corruption (`corrupt session log`, whose torn tail the Host repairs) and a deterministic released-format refusal (`SessionFormatUnsupportedError`, which no retry can change) — while missing, IO, and unknown causes stay fail-closed. A wake swap with an input boundary keeps this check even after its successor has run.

Whether a Member Session has durable persisted content is decided through session-persistence inspection (which awaits in-flight retirement drains), never a bare metadata listing that races a suspend's final flush.

The wake decision itself is a pure gate ladder in `wake-recycle.ts`: disabled, no prior generation, unreadable activity time, a cache possibly still warm, and a context below the waterline each answer resume, and only a cold gap over a large enough context recycles. [`memory-and-context.md`](../team-collaboration/memory-and-context.md) owns the thresholds and the configuration group.
