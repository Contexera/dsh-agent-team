# Memory, context pressure, and notifications

English | [中文](memory-and-context.zh.md)

## Member memory upkeep
`memory.md` is a bounded routing index rather than a store: identity and role, durable rules that must bind every step, what is in hand, and one line per topic cluster, while `notes/` is read on demand and never injected. Members hold the index well under 8 KiB against the 16 KiB hard ceiling — past it the index is not injected at all, and the block always states its own usage.

Upkeep craft (what earns a line, the three tiers, compaction and demotion) is owned by the bundled `member-memory-manager` core skill, on the same pattern as skill craft in `member-skill-manager`; the persona carries only the resident rule that the index stays bounded and that detail lives in the note it names, and a Member's first-run `memory.md` scaffold states the same sections.

## Context pressure ownership
The engine owns Member context pressure end to end as policy; the Host binds that policy to one Member's readings and performs what it decides.

Two budget thresholds derive from the Member's live routed selection — the selection captured for the current step when it entered prompt assembly, its current selection otherwise — resolved through the LLM service (capped at 200K handoff / 256K hard, with a safety reserve). At the handoff budget the Member receives one structured pressure notice per generation advising a `context_rollover` rollover — repeating is suppressed for that generation and re-armed after a rollover.

At the hard limit the Host forces an in-place compaction before the next model request is forwarded, and a Member whose compaction provably advances neither its generation nor its measured pressure is failed closed (the step is rejected rather than submitted over the Team limit).

A provider context-overflow failure gets one bounded compact-and-retry sequence before surfacing. A route whose window cannot be measured is an explicit rejection, never a silent over-limit submission. Accepted-Task auto compaction is retired: pressure policy is the only compaction trigger besides the Member's own explicit choice.

A step arriving into a large context after a long idle gap is put to the relatedness judge first: an input the judge reads as unrelated work is kept instead of admitted, and one rollover instruction takes its place until the held input returns. The judge is the `jev` service, which this bundle mounts itself from the Host row's `jev.apiKey` — or from the environment variable that row names — so a key is what enables the gate, and a row that states none leaves the gate off. A deployment that mounts its own `jev` row is read instead, and never mounted twice.

The gate's three thresholds are the Host row's own configuration: `gate.tokens`, `gate.idleMs`, and `gate.judgeTimeoutMs`, each optional, so an omitted field keeps the engine's default and a deployment states only what it disagrees with. A deployment sets them in its own `cordis.patch.yml`, by the row id `wowyuarm-agent-team-host`, and they are read when that row mounts.

The deadline is the field that decides whether a configured judge is ever heard: a judgement that takes longer than `gate.judgeTimeoutMs` leaves the step ungated. The judge this bundle mounts is therefore given a call budget one second inside that deadline.

## Agent notification boundary
Host derives bounded coalesced notifications from durable unread state. Idle Agents start a turn; running Agents receive context at the next safe step. Direct mentions include Message body, sender, Channel, optional Task overlay, Thread, and Message ref. Task/Claim Activities include actor, transition, and affected Task/Thread/Claim refs. Ordinary unread exposes only a body-free Thread-first route with its unread count; taskful summaries may name the Task. No notice renders a revision or write token. Omitted details remain discoverable through `team_inbox` and `team_thread`.

Hints are at-least-once notification intent, coalesced per Member and rediscovered on restart/resume. A consumed or ignored hint does not create another turn until a later relevant durable change or recovery. Runtime recovery, error thresholds, and the two UI recovery actions remain Host behavior; they do not create ledger authority beyond their documented operations.

Automatic recovery acts only on two conservatively matched error families — transient network failures and rate limiting — and counts consecutive `agent/error` occurrences per Member rather than wakeups or error text: each of the first two occurrences schedules its own delayed wakeup, the third stands down and leaves the error with the operator, and a non-recoverable error cancels tracking outright. Only a clean turn end clears the count.

The former manual "start from a fresh context" row action is retired: Members manage their own context through `context_rollover`, and the Human-side clear-context Remote stays as a hidden migration escape hatch with no visible entry point.

That Remote keeps its `team/member-session-renewed` operation schema and replay validation, so ledgers that recorded it still replay. During a model-initiated rollover the Member reads unavailable with a `context rollover in progress` diagnostic; when that Member's Session is embedded in the right rail, the Client follows the old→new binding once, and archived views never follow.

## Assembled acceptance
`npm run test:browser` uses a credential-free Harness Web scaffold. It verifies default taskless Thread creation, default-off Human 「作为任务」, Human promotion and Host reread, taskless header/Claim gating, invitation confirmation, Agent Inbox read/reply, Human Channel/Thread state, reload persistence, desktop/390×844/keyboard paths, Team exit, and ordinary DSH restoration. Real Agent-loop integration tests separately cover safe-boundary wake and direct, Activity, and body-free ordinary notification forms.
