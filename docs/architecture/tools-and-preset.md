# Tools and preset

English | [中文](tools-and-preset.zh.md)

The explicit `team-member` preset is the only Team Member composition. It adds coding capability rows (shell, filesystem/search, web search and fetch, background jobs, the skill loader tool, compaction), collaboration guidance/tools, Harness Workspace instruction discovery, and bounded private-memory context. Skill discovery itself is not a preset row: each Member's provider is Host-registered on its agent scope (see Host authority). Ordinary Sessions remain outside this roster and receive no Team prompt sections, tools, or Member memory.

The nine tools are defined in `packages/tool-agent-team/src/` — the five Team tools in `index.ts`, the four context tools in `context-tools.ts`; their contract is in [`tools.md`](../team-collaboration/tools.md). They mount under the isolated `team-member` preset. The Web Client is the only Human control surface and delegates every mutation through `ctx.agentTeam` typed Remote; do not restore a slash-command adapter.

All four context tools are the engine's own definitions: `context-tools.ts` builds `context_rollover`, `context_checkpoint`, `context_status`, and `context_compact` through the engine's `createContinuityTools`, supplying Team vocabulary and the host adapter rather than its own prose or validation. The engine's copy therefore always names a tool this surface has, and Team's own glossary travels through the engine's `timelineGuidance` seam.

One Team rule stays in the adapter, because the engine renders a row's `ref` on every row: a row that is not restorable answers with a short digest of that ref instead of the ref itself, so no non-selectable row ever carries a citable string.

Member context self-management is Host-orchestrated on top of that preset. The `context_rollover` and `context_checkpoint` tools only validate and conclude/anchor the turn: at tool time the engine's gate refuses a `checkpointRef` the Member's own `context_status` does not list as restorable, and every ref that passes it is still prevalidated by the Host's seed resolver — the one the swap uses — so a ref that cannot succeed rejects as a model-visible error result instead of a fake `scheduled`, while the mutable guard set (jobs, route limits) is revalidated at the commit seam.

A single context-continuity coordinator (`ContextContinuityCoordinator` from `@wowyuarm/dsh-context-continuity`) is bound to the Member lifecycle by `context-continuity-host.ts`, which also supplies the engine's message codec with Team's plugin id and the frozen handoff prose. It watches each Member Session's events, folds rollover and checkpoint intent from the durable `tool/call`+`tool/result` pairs, and executes the swap through the serialized lifecycle queue.

The fold is the engine's own `contextContinuity` projection unit, registered once per host at Team service init. `context-projection.ts` supplies only the Team half:

- the host hooks that resolve `context-checkpoint-*`/`team-boundary-*` refs, classify a boundary as `team-boundary`, `handoff`, or `compaction`, attribute a claim boundary to its ledger Thread, and recognize Team notices;
- the adapter that reads the engine state.

The unit carries the fork cut, so a seeded child's inherited prefix folds back to the same reference. The swap then runs in order:

1. wait for true idle;
2. recheck the owned-jobs guard at the commit seam;
3. retire the old generation (dispose + archive, never delete);
4. commit the idempotent `team/member-session-rolled-over` operation;
5. activate a fresh Session — or a seeded Session for a checkpoint return, with the exact completed-turn prefix and its seed source as lineage parent;
6. deliver the handoff via steer and any carried non-Team input via followup.

Intent is one-per-unresolved-turn at the fold: a second successful rollover call inside the same unresolved turn is first-wins, and a pending whose turn ended is the ready (or, after a restart, recoverable) intent — the coordinator's process lock rejects a later call on the normal in-flight path. Only once that lock is gone (the transition failed or never ran) can a later-turn successful rollover replace the ended intent, which is the retry path that recovers the Member after a seam failure.

The admission gate (`agent/turn-stopping` + `agent/pre-step`) is armed only for the outgoing generation's Agent instance so later input cannot open another old-generation model request. Quiet checkpoint continuations deliver exactly once (per-member latch in-process, the projection's durable delivery record across restarts).

Recovery is log-derived: a restart replays pending intent and finishes the swap; a restart between the durable rollover commit and the new Session's activation reconstructs the handoff from the ledger-recorded previous Session — even when the new Session never materialized before the crash — and the reconstruction is idempotent (a generation whose own log already carries a handoff never receives a second one).

Carried-input replay after a restart is bounded: a current generation that already started its own turns skips the replay (its carried input was delivered or superseded while it ran), and an unreadable retired previous Session fails open with a warning for two bounded classes — log corruption (`corrupt session log`, whose torn tail the Host repairs) and a deterministic released-format refusal (`SessionFormatUnsupportedError`, which no retry can change) — while missing/IO and unknown causes stay fail-closed, so a retired generation's readability never gates the Member's activation once the current one has run.

Whether a Member Session has durable persisted content is decided through session-persistence inspection (which awaits in-flight retirement drains), never a bare metadata listing that races a suspend's final flush.

Context pressure is the engine's own policy (`ContextPressurePolicy`) over a Team host, riding the same pre-step seam: budget thresholds derive from the live route's context window (200K handoff / 256K hard caps with a safety reserve); at the handoff budget one structured notice per generation advises a rollover (re-armed after one); at the hard limit the policy forces an in-place compaction and fails closed when it cannot prove progress; a provider context-overflow failure gets one bounded compact-and-retry sequence.

A step arriving into a large context after a long idle gap is put to the relatedness judge first: when the judge reads the arriving input as unrelated work, the policy keeps that input and steers one rollover instruction in its place, and the held input returns once the driver converges — or rides into the next generation when the rollover lands. Team supplies the per-Member readings (limits, surface, log span, compaction, work in hand) and the judge; the decision order, the notice latch and the fail-closed proof stay the engine's.

In-place hard compaction never cancels the owner, so it stays exempt from the rollover job guard that rejects switches over running or unreported-terminal jobs.
