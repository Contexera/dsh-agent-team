# Memory, context pressure, and notifications

English | [中文](memory-and-context.zh.md)

## Member memory upkeep
`memory.md` is a bounded routing index rather than a store: identity and role, durable rules that must bind every step, what is in hand, and one line per topic cluster, while `notes/` is read on demand and never injected. Members hold the index well under 8 KiB against the 16 KiB hard ceiling — past it the index is not injected at all, and the block always states its own usage.

Upkeep craft (what earns a line, the three tiers, compaction and demotion) is owned by the bundled `member-memory-manager` core skill, on the same pattern as skill craft in `member-skill-manager`. The persona carries only the resident rule that the index stays bounded and that detail lives in the note it names, and a Member's first-run `memory.md` scaffold states the same sections.

## Context lifecycle ownership
A Member's context has exactly two mechanisms, and neither is the model's to invoke.

**In-place compaction.** The preset mounts this bundle's `team-compaction-engine`, a `BasicCompactionEngine` subclass whose only difference is the summary template. Its seven sections are ordered by what a successor cannot reconstruct: a summary names files instead of restating them, and states who is waiting on the subject.

`auto` is on and the trigger is an absolute 256K waterline, so the ratio is 0.256 on a 1M window and `modelPolicies` keeps other windows at the same line. `retainRatio` 0.08 keeps roughly 70K of verbatim tail, so one compaction clears about 180K rather than firing every other step. Compaction never changes generation and never cancels the owner.

**Generation swaps.** A swap is a Host decision, executed by Team's own coordinator (`team-context-management.ts`) at a true idle boundary. It records the transition itself (`team/member-session-recycled`, Host actor), retires the old Session (dispose and archive, never delete), and activates a fresh one parented at the one it replaces. Carried non-Team input follows as its own turn, then the Inbox is rederived from the ledger.

The coordinator reacts to a durable pending intent in the Member's Session, so a restart between the commit and the activation finishes the swap it owed. A legacy intent whose containing turn never ended durably is spent and is discarded, rather than leaving the generation permanently un-swappable.

A swap leaves no mark on what the successor is told. Its first model-facing context is the same per-step injection every turn carries — identity, `memory.md`, the Workspace list — followed by the message that woke it. Continuity across a generation is not a briefing: it is `memory.md` being maintained while the work happens and read back afterwards.

Because both mechanisms are Host-controlled, the model has no context tool at all: no rollover, no checkpoint, no status, and no advice riding a Thread read. Nothing a Member can say starts, prevents, or steers a swap.

## Agent notification boundary
Host derives bounded coalesced notifications from durable unread state. Idle Agents start a turn; running Agents receive context at the next safe step. Direct mentions include Message body, sender, Channel, optional Task overlay, Thread, and Message ref. Task/Claim Activities include actor, transition, and affected Task/Thread/Claim refs. Ordinary unread exposes only a body-free Thread-first route with its unread count; taskful summaries may name the Task. No notice renders a revision or write token. Omitted details remain discoverable through `team_inbox` and `team_thread`.

Hints are at-least-once notification intent, coalesced per Member and rediscovered on restart/resume. A consumed or ignored hint does not create another turn until a later relevant durable change or recovery. Runtime recovery, error thresholds, and the two UI recovery actions remain Host behavior; they do not create ledger authority beyond their documented operations.

Automatic recovery acts only on two conservatively matched error families — transient network failures and rate limiting — and counts consecutive `agent/error` occurrences per Member rather than wakeups or error text. Each of the first two occurrences schedules its own delayed wakeup, the third stands down and leaves the error with the operator, and a non-recoverable error cancels tracking outright. Only a clean turn end clears the count.

Every delivery and recovery decision leaves one bounded line through the Host logger: an Inbox wake names the Member id, the Session, the request and operation that caused it, and the attempt it spent, and says a queued notice is not yet read by the model. Unchanged facts spend no second attempt and add no line above diagnostic level. A failed wake logs at warn, keeps the committed operation as its result, and clears its signature for the next rederivation; automatic recovery reports its classification, count, wait, wakeup, stand-down, and the reason tracking ended.

The former manual "start from a fresh context" row action is retired: the Host recycles a cold generation at its wake boundary, and the Human-side clear-context Remote stays as a hidden migration escape hatch with no visible entry point.

That Remote keeps its `team/member-session-renewed` operation schema and replay validation, so ledgers that recorded it still replay. While a swap's ledger binding has moved and the successor has not activated, the Member reads unavailable with a `context rollover in progress` diagnostic; when that Member's Session is embedded in the right rail, the Client follows the old→new binding once, and archived views never follow.

## Assembled acceptance
`npm run test:browser` uses a credential-free Harness Web scaffold. It verifies default taskless Thread creation, default-off Human 「作为任务」, Human promotion and Host reread, taskless header/Claim gating, invitation confirmation, Agent Inbox read/reply, Human Channel/Thread state, reload persistence, desktop/390×844/keyboard paths, Team exit, and ordinary DSH restoration. Real Agent-loop integration tests separately cover safe-boundary wake and direct, Activity, and body-free ordinary notification forms.
