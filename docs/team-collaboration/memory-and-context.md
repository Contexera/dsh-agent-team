# Memory, context pressure, and notifications

English | [中文](memory-and-context.zh.md)

## Member memory upkeep
`memory.md` is a cold-start recovery index rather than a store, in three sections: durable rules that must bind every step, one routing line per on-demand note cluster, and open local state the ledger and git cannot show. Identity, ownership, Team state and shared rules are injected or read live, so they never belong in it, and `notes/` is read on demand and never injected. Members hold the index well under 8 KiB against the 16 KiB hard ceiling — past it only the leading whole lines within the budget are injected, and the block always states its own usage.

Upkeep craft (what earns a line, the three tiers, compaction and demotion) is owned by the bundled `member-memory-manager` core skill, on the same pattern as skill craft in `member-skill-manager`.

The persona carries a resident map of where each kind of knowledge lives — `AGENTS.md`, the Workspace rules, the identity and ownership context, the ledger, the private space — and the rule that the index stays bounded with detail in the note it names; a Member's first-run `memory.md` scaffold states the same three sections. An ownership-update wake and the acceptance reminder each ask the Member to drop the memory lines they make stale.

## Member context injection
A Member's per-step context is assembled as four classified blocks: identity, Project ownership, Workspace participation, and private memory. [Workspace rules](#workspace-rules) arrive through their own row beside them. Each block is a separate surface message; a later block of the same class supersedes the earlier one semantically — the earlier message stays in the Session log and surface until compaction — and an unchanged class appends nothing.

Ownership and participation are always stated in full, including an empty ownership list and a participation list that shrank from several Workspaces to one. Each ownership line names what that owner answers for in the Project, and an unspecified responsibility is stated as unspecified — a neutral fact about the grant, not a gap the Member is expected to close.

Private memory starts with a baseline: the index within its byte budget. When `memory.md` changes and an intact baseline is still visible, the next step gets a short stale-copy notice with the path and current usage. The newest intact memory block determines whether the current file state has already been reported.

Only blocks whose visible text still matches their recorded digest count. If compaction drops or rewrites the baseline, the next step receives a new baseline even when a matching notice survives. An over-budget baseline shows only leading whole lines and a warning. Framing markers in the injected content are escaped; the file itself is never trimmed or summarized.

A missing or unreadable index produces a notice with that state and its path, not index content. An unchanged unavailable state appends nothing; a readable zero-byte file is a valid index, not a missing one.

## Workspace rules
Each Workspace can carry one Team-owned rules file, `$DSH_HOME/agent-team/workspaces/<workspaceId>/rules.md`, outside every repository. It holds what only this Team shares in this Workspace: collaboration conventions, shared-checkout discipline, and local environment clues. Public engineering rules stay in the repository's `AGENTS.md`; live state stays in the ledger.

The `workspace-rules-context` row, mounted in both Team presets, injects one block per Workspace. A Member reads the Workspaces it participates in now; the Team manager reads every registered Workspace. Ordinary Sessions and forks read none. The Host never creates the file, so a missing file is stated with its path; only the manager is invited to start it, and a Member creates it only to record a rule its editing terms allow.

The block names the file, states that it ranks below system, developer and user instructions and below `AGENTS.md`, and states who may edit what. The manager is told it is the primary curator. A Member may directly correct a stale fact or record a rule the Human already settled, citing date and ref, but proposes a new or overturned cross-Member rule to the Human instead.

Unlike private memory, a changed file is injected in full again, because the reader is usually not the writer. An unchanged file appends nothing, and a compaction that drops the block brings it back. The budget is 8 KiB: past it, only whole leading lines up to the budget are injected, with a note to read the rest, and the file itself is never trimmed.

## Team manager memory and skills
The Team manager Session keeps its own private space under `$DSH_HOME/agent-team/manager/` — `memory.md`, `notes/`, and `skills/` — and it is not a Member's. The directory outlives every manager Session: a restart, a reopen after archival, and "new conversation" all read the same files, so what the Human taught the manager survives the conversation that taught it.

The manager uses the same [private-memory injection rules](#member-context-injection) and 16 KiB ceiling as a Member, with its own wording. Its block describes the private root relative to the actual Session cwd. Only `memory.md` enters context; `notes/` is read on demand from the paths the block names.

Upkeep follows the same bounded-index and private-skill rules at the manager's paths, and the bundled `manager-memory` skill owns the craft: what earns a line, the three tiers, the review points, and what must never be saved. Its six guide skills live in `packages/agent-team/manager-skills/`; the Member core-skill root is not mounted into its catalog.

Skills are file-configured and discovered per turn through the manager preset's isolated registry: its provider scans the bundled manager root first and its writable `manager/skills/` second, so a same-name private skill never shadows a shipped one. Host-global skills do not enter the manager catalog or loader. Adding or removing a private file is visible on the next turn without a new conversation and without touching the preset. Neither manager root is mounted for a Member or an ordinary Session.

## Context lifecycle ownership

The Member maintains private continuity, not context lifecycle. Team has two automatic mechanisms: in-place compaction shortens a Session, while a generation swap replaces the Session binding. Neither is a model-callable Team tool.

### In-place compaction

The preset adapter uses Harness's `BasicCompactionEngine`. It preserves the generation and original log. The proactive input trigger is:

`floor(min(B, W × 0.8, W − 16384))`

`B` is `memberCompaction.tokens` (default 256000); `W` is the routed context window. Without a declared window, `B` still applies. Thus a 1M/2M model defaults to 256000, while a 272000 window triggers at 217600. Maximum model output is not subtracted from this trigger.

Pricing uses the last comparable provider prompt count plus surface growth, pending messages, changed tools, and system-prompt growth. Without comparable usage it falls back to the token meter's estimate. A failed/aborted request header is not mistaken for the usage-bearing request.

At the trigger, Team prunes tool results and, if still needed, forces reduction with zero retained-tail budget; upstream may preserve a recent balanced block. Summary output defaults to 32768 tokens, independently of the input trigger, with per-model overrides.

Summary route selection is deliberate:

1. An explicit global or committed-route summary target takes precedence.
2. Otherwise a target configured on the step's route takes precedence.
3. Without an explicit target, the step's fixed route is used only if its window strictly holds the summary call's own input, instruction, tools, and summary cap.
4. Otherwise the last committed request route is used.

The step route is captured from `agent/pre-step.modelSelection` only for that step, including its retries. A route mismatch is refused before summary execution. The choice uses the replayed summary input, not the whole Session size; a later manual `/compact` has no stale step route.

A step permits at most one alternative summary attempt. A globally pinned or committed-route target failure does not rotate away from that operator choice. If automatic summarization fails, that route is paused until the route/summary configuration changes or manual `/compact` succeeds. The failed `compaction/end` remains in the log; the turn may continue without a summary instead of being locked out.

A reduction that still leaves input over the trigger, without a summary failure, ends the turn. On a paused route, provider overflow can also end it. Three consecutive provider overflows without a settled response produce a compaction-unreachable diagnostic with recovery options; a route change, fresh generation, or successful checkpoint clears that episode.

Each request's output allowance is capped at `W − estimated input − 4096`, never increased above its requested allowance. This temporary clamp is logged and removed before the next resolution. Below a 20480-token window the policy declines because its reserves cannot fit. Only budget failures restore unadmitted input; cancellation follows Agent stop/dispose semantics.

This is a trigger, not a physical ceiling: tool output can cross it before the next request. `memberCompaction.enabled: false` restores upstream pressure handling. The volatile Host-row group contains `enabled` and `tokens`; the Team 「上下文」 setting edits only `tokens`, accepts capacities such as `256K`/`1M`, and a blank value clears the override without changing `enabled`. Ordinary Sessions are unchanged.

### Generation swaps

A notification, DM, or explicit resume aimed at an idle Member can trigger a swap. By default, both conditions are strict: idle longer than 60 minutes and measured context greater than 128000 tokens. Unknown facts choose resume. Host startup does not create a swap just because it restarted, but finishes an already committed one.

`wakeRecycle` is a volatile Host-row group with `enabled`, `idleMs`, and `minContextTokens`. No Team settings form exposes it; `enabled: false` disables new swaps. Pending ordinary input and owned-job guards can defer a swap even when the thresholds pass.

A swap commits `team/member-session-recycled`, archives rather than deletes the old Session, and activates a fresh binding. The successor is not a Harness subagent: lineage comes from the Team transition, not a Session `parentSession` header. [Host authority](../architecture/host-authority.md#generation-swaps-and-input-replay) owns commit ordering, crash completion, and bounded input replay.

The successor receives current identity, ownership, participation, private memory, and the wake input, not the old working context or a handoff briefing. Keep durable private conclusions in memory while working; there is no model action that starts, prevents, or steers a swap.

### Acceptance boundary

A Thread read that acknowledges acceptance prompts memory upkeep only when it concludes work the reader contributed to or was accountable for. An observing follower is left alone. The Member committing acceptance gets the same boundary without a separate read.

The Host steers one `<system-reminder>` into the relevant turn, naming the standing (`contributed`, `accountable`, or `accepted`) and asking for durable conclusions in the memory index and notes. At or above 128000 measured tokens, that boundary also requests in-place compaction once the Agent settles. It does not announce a handoff or promise compaction when no engine is mounted.

## Agent notification boundary

A notice provides context and a route, not proof of acknowledgment or a next-write token. Idle Agents start a turn; running Agents receive notices at a safe step. A complete identified Message/Activity can satisfy a later mutation's context check, but a digest cannot.

[Attention and messaging](attention-and-messaging.md#agent-delivery) owns ranking, coalescing, output limits, reminder consumption, and at-least-once delivery. Read missing or omitted facts with `team_thread`; use `team_inbox` to triage scopes. Thread unread stays unread until explicit read.

Recovery is distinct from unread. Runtime failures and recovery attempts do not create collaboration facts or move read watermarks. [Host authority](../architecture/host-authority.md#which-operations-wake-a-member-and-how-recovery-is-chosen) owns error classification, retry limits, diagnostics, and operator recovery.

## Assembled acceptance

The maintained [browser lane catalog](../development/e2e-lanes.md) owns scenario coverage and commands. Use the [verification gradient](../development/start-and-checks.md#verification-gradient) to choose component, integration, and assembled checks; unfiltered browser acceptance is the delivery gate for assembled-Web changes.

Collaboration acceptance must distinguish durable state from presentation: taskless start versus Task promotion, Inbox listing versus read, follow versus mention, Claim completion versus acceptance, and reload versus a fresh projection. Include Human writes, Agent safe-boundary delivery, desktop/mobile keyboard paths, and ordinary DSH restoration where applicable.

Replay can exercise real settings, notification delivery, and tool execution while substituting model responses and Worker executables. It does not establish live-model judgment, native CLI behavior, or native steering. Record that boundary rather than treating a replay result as evidence for all three.
