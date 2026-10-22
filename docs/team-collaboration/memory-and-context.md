# Memory, context pressure, and notifications

English | [中文](memory-and-context.zh.md)

## Member memory upkeep
`memory.md` is a bounded routing index rather than a store: identity and role, durable rules that must bind every step, what is in hand, and one line per topic cluster, while `notes/` is read on demand and never injected. Members hold the index well under 8 KiB against the 16 KiB hard ceiling — past it the index is not injected at all, and the block always states its own usage.

Upkeep craft (what earns a line, the three tiers, compaction and demotion) is owned by the bundled `member-memory-manager` core skill, on the same pattern as skill craft in `member-skill-manager`. The persona carries only the resident rule that the index stays bounded and that detail lives in the note it names, and a Member's first-run `memory.md` scaffold states the same sections.

## Context lifecycle ownership
A Member's context has exactly two mechanisms, and neither is the model's to invoke.

**In-place compaction.** The preset mounts the Harness's own `@deepseek-ai/dsh-compaction-basic`, unmodified, with `auto` on and Team's ratios: `thresholdRatio` 0.256, `retainRatio` 0.08, `headroomTokens` 65536. The summary template, the routed summarization target, and the cap stay upstream's. Compaction never changes generation and never cancels the owner.

Team configures ratios, not a fixed window: the trigger is `min(W × 0.256, W − output − 65536)` for a window of `W` tokens, and `retainRatio` 0.08 keeps that share of the message budget as verbatim tail. The ratio is the binding term only while the remaining capacity is larger — on a 1M window the threshold is 256K and roughly 70K of tail survives — so a smaller, or heavily output-reserved, window compacts at the lower value instead. A deployment on other models adds per-model `modelPolicies` at the profile level to hold its own waterline; the bundle assumes no window size.

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
Host derives bounded coalesced notifications from durable unread state. Idle Agents start a turn; running Agents receive context at the next safe step. Direct mentions include Message body, sender, Channel, optional Task overlay, Thread, and Message ref. Task/Claim Activities include actor, transition, and affected Task/Thread/Claim refs. Ordinary unread exposes only a body-free Thread-first route with its unread count; taskful summaries may name the Task. No notice renders a revision or write token. Omitted details remain discoverable through `team_inbox` and `team_thread`.

Hints are at-least-once notification intent, coalesced per Member and rediscovered on restart/resume. A consumed or ignored hint does not create another turn until a later relevant durable change or recovery. Runtime recovery, error thresholds, and the two UI recovery actions remain Host behavior; they do not create ledger authority beyond their documented operations.

Automatic recovery acts only on two conservatively matched error families — transient network failures and rate limiting — and counts consecutive `agent/error` occurrences per Member rather than wakeups or error text. Each of the first two occurrences schedules its own delayed wakeup, the third stands down and leaves the error with the operator, and a non-recoverable error cancels tracking outright. Only a clean turn end clears the count.

Every delivery and recovery decision leaves one bounded line through the Host logger: an Inbox wake names the Member id, the Session, the request and operation that caused it, and the attempt it spent, and says a queued notice is not yet read by the model. Unchanged facts spend no second attempt and add no line above diagnostic level. A failed wake logs at warn, keeps the committed operation as its result, and clears its signature for the next rederivation; automatic recovery reports its classification, count, wait, wakeup, stand-down, and the reason tracking ended.

Manual control of a Member's context is gone: no row action and no Remote write starts a new generation. The ledger keeps the older transition kinds (`team/member-session-renewed`, `team/member-session-rolled-over`) readable so recorded ledgers still replay, but nothing writes them.

While a swap's ledger binding has moved and the successor has not activated, the Member reads unavailable with a `context rollover in progress` diagnostic; when that Member's Session is embedded in the right rail, the Client follows the old→new binding once, and archived views never follow.

## Assembled acceptance
`npm run test:browser` uses a credential-free Harness Web scaffold. It verifies default taskless Thread creation, default-off Human 「作为任务」, Human promotion and Host reread, taskless header/Claim gating, invitation confirmation, Agent Inbox read/reply, Human Channel/Thread state, reload persistence, desktop/390×844/keyboard paths, Team exit, and ordinary DSH restoration. Real Agent-loop integration tests separately cover safe-boundary wake and direct, Activity, and body-free ordinary notification forms.
