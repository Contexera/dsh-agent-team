# Memory, context pressure, and notifications

English | [中文](memory-and-context.zh.md)

## Member memory upkeep
`memory.md` is a bounded routing index rather than a store: identity and role, durable rules that must bind every step, what is in hand, and one line per topic cluster, while `notes/` is read on demand and never injected. Members hold the index well under 8 KiB against the 16 KiB hard ceiling — past it the index is not injected at all, and the block always states its own usage.

Upkeep craft (what earns a line, the three tiers, compaction and demotion) is owned by the bundled `member-memory-manager` core skill, on the same pattern as skill craft in `member-skill-manager`. The persona carries only the resident rule that the index stays bounded and that detail lives in the note it names, and a Member's first-run `memory.md` scaffold states the same sections.

## Context lifecycle ownership
A Member's context has exactly two mechanisms, and neither is the model's to invoke.

**In-place compaction.** The preset mounts `member-compaction-engine`, a thin adapter over the Harness's `BasicCompactionEngine`. Team owns proactive request admission; the parent supplies the summary template, tool-pair-safe reduction, durable transaction, and overflow retries. Compaction never changes generation or deletes the original log.

The input trigger is `floor(min(B, W × 0.8, W − 16384))`, where `B` is `memberCompaction.tokens` (default 256000) and `W` is the routed window. Without a declared window the absolute budget still applies. A 1M or 2M model triggers at 256000; a 272000 model triggers at 217600. Model maximum output is not subtracted from this trigger. Pending messages, assembled tools, and system-prompt growth are counted before admission.

`memberCompaction` is a volatile Host-row group (`enabled`, `tokens`). The Team settings page edits `tokens` alone under 「上下文」, through the shared configuration form: the field accepts a capacity (`256K`, `1M`) and a blank field clears the override so the group re-inherits the composition layer and its 256000 default. The write names the `memberCompaction.tokens` child path, so the sibling `enabled` switch is untouched.

When input reaches the trigger, Team first prunes tool results, then requests one upstream forced reduction if needed. This path uses a zero retained-tail budget rather than retaining 0.16 of a large window; upstream may still preserve a recent balanced block. The summary output cap is independently set to 16384. A failed or insufficient reduction ends the turn explicitly; unadmitted input stays queued without an automatic retry.

Each request's output allowance is capped at `W − estimated input − 4096`, never raised above its original allowance. The actual value is logged in the request header; a temporary reduction is removed before the next allowance is resolved, and a resumed loop starts from its declared options. Input pricing is heuristic, so provider overflow recovery remains necessary.

Cancellation follows the Agent's own stop/dispose semantics; only budget failures restore unadmitted input. A window too small to hold both the context reserve and a minimal output allowance — under 20480 tokens — cannot satisfy this policy at all, so the policy declines there and leaves the request to the Agent's own limits.

This is a trigger, not a physical ceiling: a tool result can cross it before the next request. `memberCompaction.enabled: false` restores upstream pressure handling, including its output reservation, headroom, and retained-tail policy. The adapter is mounted only in the Team preset; ordinary Sessions are unchanged.

**Generation swaps.** A swap is a Host decision taken at a wake boundary and executed by Team's own coordinator (`team-context-management.ts`). It commits `team/member-session-recycled` as the Host actor, retires the old Session (dispose and archive, never delete), and activates a fresh one parented at the one it replaces, then rederives the Inbox.

The successor's identity derives from the retired Session, so a restart between the commit and the activation finishes the same swap rather than minting a second one. An older log's pending intent or checkpoint anchor is read only for legacy recovery; no current build writes one.

The ordinary swap has one trigger: a wake aimed at an idle Member, whether that wake is a notification, a DM, or an activation at startup or resume. It is strict — the generation must have been idle longer than 60 minutes and measure more than 128000 context tokens — and every fact it cannot establish answers resume, the conservative direction because a swap that should not have happened costs a Member its working trail.

`wakeRecycle` is a volatile Host-row group (`enabled`, `idleMs`, `minContextTokens`); the Team settings page renders no form for it, and `enabled: false` turns the swap off.

The cold path decides from storage, not from a live Agent: a stored Session is rebuilt from its own log and its inbox inspected, and a pending ordinary message there keeps that generation instead of recycling it; a live generation is asked the same question from its queue before any context pricing.

A generation holding unprocessed non-Team input keeps its continuity. While a queued ordinary message is pending, the swap declines to start. Past that point the commit runs inside `agent.runMaintenance`, so a message arriving mid-swap waits in the durable inbox instead of reaching the retiring generation, and the retiring generation rejects any later step without spending a model request. Its original inbox insertions remain available for replay even after a claim.

What crosses a generation is inbox input at and after the recorded boundary, carried as Message ids: replay is bounded by that offset, deduplicated against what the successor already holds, and is not a general carry of working context.

A swap leaves no mark on what the successor is told. Its first model-facing context is the same per-step injection every turn carries — identity, `memory.md`, the Workspace list — followed by the message that woke it. Continuity across a generation is not a briefing: it is `memory.md` being maintained while the work happens and read back afterwards.

Because both mechanisms are Host-controlled, the model has no context tool at all: no rollover, no checkpoint, no status, and no advice riding a Thread read. Nothing a Member can say starts, prevents, or steers a swap.

## Agent notification boundary
Host derives bounded coalesced notifications from durable unread state. Idle Agents start a turn; running Agents receive context at the next safe step. Direct mentions include Message body, sender, Project, optional Task overlay, Thread, and Message ref. Task/Claim Activities include actor, transition, and affected Task/Thread/Claim refs. Ordinary unread exposes only a body-free Thread-first route with its unread count; taskful summaries may name the Task. No notice renders a revision or write token. Omitted details remain discoverable through `team_inbox` and `team_thread`.

Hints are at-least-once notification intent, coalesced per Member and rediscovered on restart/resume. A consumed or ignored hint does not create another turn until a later relevant durable change or recovery. Runtime recovery, error thresholds, and the two UI recovery actions remain Host behavior; they do not create ledger authority beyond their documented operations.

Automatic recovery acts only on two conservatively matched error families — transient network failures and rate limiting — and counts consecutive `agent/error` occurrences per Member rather than wakeups or error text. Each of the first two occurrences schedules its own delayed wakeup, the third stands down and leaves the error with the operator, and a non-recoverable error cancels tracking outright. Only a clean turn end clears the count.

Every delivery and recovery decision leaves one bounded line through the Host logger: an Inbox wake names the Member id, the Session, the request and operation that caused it, and the attempt it spent, and says a queued notice is not yet read by the model. Unchanged facts spend no second attempt and add no line above diagnostic level. A failed wake logs at warn, keeps the committed operation as its result, and clears its signature for the next rederivation; automatic recovery reports its classification, count, wait, wakeup, stand-down, and the reason tracking ended.

Manual control of a Member's context is gone: no row action and no Remote write starts a new generation. The ledger keeps the older transition kinds (`team/member-session-renewed`, `team/member-session-rolled-over`) readable so recorded ledgers still replay, but nothing writes them.

While a swap's ledger binding has moved and the successor has not activated, the Member reads unavailable with a `context rollover in progress` diagnostic; when that Member's Session is embedded in the right rail, the Client follows the old→new binding once, and archived views never follow.

**The acceptance boundary.** A Thread read that acknowledges the acceptance of a Task also hands the reader a boundary of its own, but only when that acceptance concluded work the reader owned — an observer following the Thread sees the same accept as unread and is left alone.

The Host appends one `<system-reminder>` asking the Member to move durable conclusions into its `memory.md` index and the notes it names. At or above 128000 measured tokens the same boundary also compacts the generation, once the Agent settles: acceptance usually lands mid-turn, and the engine only compacts an idle Agent.

Nothing crosses the boundary — no handoff, no announcement — so the reminder states the consequence only when it is true, and a preset that mounts no compaction engine is never told otherwise.

## Assembled acceptance
`npm run test:browser` uses a credential-free Harness Web scaffold. It verifies default taskless Thread creation, default-off Human 「作为任务」, Human promotion and Host reread, taskless header/Claim gating, invitation confirmation, Agent Inbox read/reply, Human Project/Thread state, reload persistence, desktop/390×844/keyboard paths, Team exit, and ordinary DSH restoration. Real Agent-loop integration tests separately cover safe-boundary wake and direct, Activity, and body-free ordinary notification forms.
