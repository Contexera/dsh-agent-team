# Tools and preset

English | [中文](tools-and-preset.zh.md)

The explicit `team-member` preset is the only Team Member composition. It adds coding capability rows (shell, filesystem/search, web search and fetch, background jobs, the skill loader tool, compaction), collaboration guidance/tools, Harness Workspace instruction discovery, and bounded private-memory context. Skill discovery itself is not a preset row: each Member's provider is Host-registered on its agent scope (see Host authority). Ordinary Sessions remain outside this roster and receive no Team prompt sections, tools, or Member memory.

The filesystem row states `applyPatch: false` rather than inheriting the Host default: `edit` is the one file-modification tool a Member is granted, and a preset that left the flag unstated would widen every Member's surface the day a Host default flips. The shipped preset test asserts the value, so the decision is checked rather than assumed.

Every Member starts restricted to the tool definitions contributed by its selected preset, plus the explicitly shared `working_directory` tool. `capabilities.tools.allow` still only narrows this baseline.

A separate profile-wide `extraToolGrants` list in the Team Host row can grant exact, case-sensitive registered Host tool names, including an inherited baseline name the Member allow-list omitted. The list defaults to empty, belongs to one profile, and applies to every Team Member in that profile. The ten Team tools and `working_directory` remain reserved, so a grant cannot name them. `team_worker` is one of the ten and is declared only while the Host Worker switch is on, so a grant cannot turn it on. A grant is a name, never a plugin origin, definition object, or registration instance.

The Host reads the grants synchronously at each Session `turn/start`, before the first tool resolution, and freezes them for that turn. A later-saved edit reaches the next turn even when consecutive turns never pass through idle, and creation, resume, and generation replacement use the same policy path. The restriction materializes the names known at that boundary.

Execution follows the registration DSH actually resolves for this Member and step, so its own `when`, pre-execute checks, Agent identity, and direct or nested step admission remain authoritative. A selected name registered after turn start is rematerialized into the next normal step's declaration; an unregister or re-registration invalidates the previously prepared admission.

External tool visibility and execution are separate. Inherited global or ancestor registrations are removed from the schema by `tools.restrict()` until granted. Registrations in the Member's own Agent scope are exempt from that restriction, so current Harness APIs cannot hide them; the execution guard denies them until granted.

A conditional `team:tool-availability` prompt section lists these visible, ungranted names at every assembly and tells the Member not to call them. A grant removes that name from the warning from the next turn. This is compatibility behavior, not a permanent interface promise: if Harness later exposes an own-scope declaration filter, Team can hide the schemas instead while retaining the execution guard.

A step refresh runs inside the public `agent/pre-step` gate using the turn's frozen grants. Tool resolution for that step has already happened, so this refresh prepares later declarations, not the current one; a failed refresh can still refuse the current request. Session event observers cannot provide that refusal, and `step/start` is too late.

The same switch also governs the Worker paragraph of the owner guidance section, which is re-derived at every assembly; the Worker registry still refuses a start while the switch is off.

The Host captures the preset definitions before Agent publication and guards direct and nested execution. If a grant-bearing policy cannot be installed, the Host tightens to the same Member baseline with no extra grants rather than restoring the previous grant-bearing restriction. If that baseline also cannot be established, the pre-step gate refuses the turn before a model request and the next normal turn retries. Replacing an allowed definition is refused at execution rather than at assembly. These checks apply to the exact Member, not ordinary Agents or delegated child scopes.

The settings catalog discovers tool names from the Host's global registry and every live Agent scope. It does not infer plugin origin, clone a plugin, or claim to be the exact filtered set for a particular Member or turn. Names supplied by activated Member presets, Team-owned names, `working_directory`, and `team_worker` are not offered. An unregistered saved name remains selected and removable. Ordinary Sessions and other profiles receive no grant.

Team mode does not filter prompts injected by other official or custom plugins. Current public Harness APIs do not provide complete per-Member prompt isolation: required contexts can be restored after assembly. In particular, experimental Team's `team:policy` and required `team:identity` remain visible; they do not block activation or conversation.

This uses public Harness hooks rather than an enforced final request policy. Other assembly middleware can change the result after Team's filter. Full plugin compatibility is not certified; see [the compatibility restriction](../dsh-release-compatibility.md#37-competing-team-implementations).

Every row `name:` is a bare specifier the Loader resolves against the profile, not against this bundle. A profile links this bundle and the host closure, so a row may name a host package or one of this bundle's own subpaths, and never a package nested inside this bundle's dependency tree. A name that resolves in a working tree can still leave the row `never started` in a real install, so a dependency's module reaches a row only through a re-export under this bundle's own name.

The ten tools are defined in `packages/tool-agent-team/src/index.ts` and `packages/tool-agent-team/src/subscription.ts`; their contract is in [`tools.md`](../team-collaboration/tools.md). They mount under the isolated `team-member` preset. The Web Client is the only Human control surface and delegates every mutation through `ctx.agentTeam` typed Remote; do not restore a slash-command adapter.

A Member has no context tool. The preset's `compaction-basic` row mounts Team's thin `member-compaction-engine` adapter: Team owns proactive admission, while the Harness's `BasicCompactionEngine` supplies the summary template, compaction transaction, and overflow recovery. [`memory-and-context.md`](../team-collaboration/memory-and-context.md) defines the budgets. Generation swaps remain Host decisions, never model ones.

The generation swap is owned by `team-context-management.ts`, Team's own coordinator. It starts from a Host wake decision rather than a durable intent, executes through the serialized lifecycle queue, and takes the successor's identity from the retired Session so a crash converges on one successor:

1. wait for true idle;
2. recheck the owned-jobs guard and the ordinary-input queue at the commit seam — a queued ordinary message defers the swap;
3. inside `agent.runMaintenance`, commit the idempotent `team/member-session-recycled` operation as the Host actor, recording `inputFromSeq` (the retired log's offset) when a live generation exists;
4. retire the old generation: its pre-step gate rejects the step without a model request, then dispose and archive (never delete); the original inbox insertions remain in the log even if already claimed;
5. activate the fresh Session, whose lineage the ledger transition already records (its header carries no `parentSession`, which names a subagent's creator);
6. fold the retired log from `inputFromSeq`, drop every message the successor already holds by id, deliver the rest by followup, then rederive the Inbox from the ledger.

Maintenance is what makes the commit safe against input arriving mid-swap: the loop is parked there, so a new message waits in the durable inbox instead of reaching the generation being retired. A failed commit releases maintenance and the old generation continues; a committed one retires it, and startup or recovery finishes a swap interrupted before the replay.

The successor first receives identity, Project ownership, Workspace participation, and its private-memory index, plus the message that woke it. Later steps append only changed or missing categories; [Member context injection](../team-collaboration/memory-and-context.md#member-context-injection) defines memory updates and recovery. There is no handoff envelope or generation announcement.

The fold is Team's own `contextContinuity` projection unit, registered once per host at Team service init. `context-projection.ts` owns the durable checkpoint-ref naming, the Team-notice rule, the fork cut, and the folded state a generation reads back: its checkpoints with their turn-end delivery state, at most one legacy rollover intent, the continuation delivery records, and the unconsumed non-Team input the retired generation never consumed. The tool names it still decodes (`context_rollover`, `new_context`, `context_checkpoint`) are decoders for logs written by earlier builds, not tool aliases.

`context-codec.ts` writes the one envelope this build still produces, the quiet checkpoint continuation. Recognition of that envelope, and of the two shapes earlier builds wrote, lives in `context-source.ts`; the handoff writer survives only as a test helper for those legacy shapes.

Crash recovery is log-derived. An interrupted swap is finished from the recorded binding and the retired Session, and a legacy pending intent whose containing turn never ended durably is spent and discarded instead of leaving the generation permanently un-swappable.

Carried-input replay is bounded and keyed by Message id. A swap records `inputFromSeq`, the retired log's offset at commit, so the fold counts only input at or after that boundary, and the retired Session's log is the only source — no message content is held in memory for the carry. A successor that already started its own turns is not skipped for that reason: the boundary and the successor's own log and inbox queues decide which messages it still lacks. Only a legacy transition without `inputFromSeq` skips the replay along its started generation.

`agent-instructions` messages are regenerated by the successor rather than replayed as standalone turns.

A canceled inbox splice does not identify who removed the message. Replay must preserve input cleared by disposal, so an explicit queue removal or replacement racing this swap can also be replayed. Ordinary Session cancel retains pending input by design; this limitation concerns queue editing during the transition.

An unreadable retired previous Session fails open with a warning for two bounded classes — log corruption (`corrupt session log`, whose torn tail the Host repairs) and a deterministic released-format refusal (`SessionFormatUnsupportedError`, which no retry can change) — while missing, IO, and unknown causes stay fail-closed. A wake swap with an input boundary keeps this check even after its successor has run.

Whether a Member Session has durable persisted content is decided through session-persistence inspection (which awaits in-flight retirement drains), never a bare metadata listing that races a suspend's final flush.

The wake decision itself is a pure gate ladder in `wake-recycle.ts`: disabled, no prior generation, unreadable activity time, a cache possibly still warm, and a context below the waterline each answer resume, and only a cold gap over a large enough context recycles. [`memory-and-context.md`](../team-collaboration/memory-and-context.md) owns the thresholds and the configuration group.

## Persona and core skills

The persona is the `prefix` of the `persona` row in `cordis.patch.yml`. It is always resident and carries behavior rules, not reference material:

- where each message belongs: Main stream post, discussion or Task start, Thread reply, or DM;
- that only Project owners start discussions and Tasks, and that a Task has one accountable owner;
- how a mention or `replyToMessageRef` differs from an ordinary message, and when to involve the Human;
- that naming a Member in plain prose is not a mention: `@Handle` is a delivery, so it is written only when that Member should read this Message;
- when to unfollow a Thread after participation ends or repeated ordinary updates are irrelevant, and when an active Claim, an unresolved Task you are accountable for, or owed follow-up requires staying subscribed;
- what a wake costs: every Message wakes its readers, and each wake is a full turn for every Member it reaches;
- that accepting, closing, and reopening a Task are separate decisions, and that an Agent that executed a Task cannot accept it;
- etiquette, the read-before-write workflow, and a role quick reference of at most eight lines.

Guidance is placed by use: the persona carries rules shared across tools, each tool description carries what selecting and calling that tool requires, parameter descriptions keep their required shapes, a result states this operation's state and recovery, and the bundled core skill carries detailed method and rare cases. Detail has one home; the persona keeps only the short reminder a basic call needs.

Team content stays untrusted input. The persona names the tools as the code defines them; when a tool's surface changes, change the persona with it.

Detail lives in bundled core skills under `packages/agent-team/core-skills/`, loaded on demand through the Member's skill catalog:

- `team-domain-model` explains roles and permissions (Human, Project owner, Project member, accountable), the Main stream and Thread division of labor, how mentions, linked replies, and ordinary messages are delivered, when to read the Inbox or the board, the Task lifecycle and who accepts, closes, reopens, or transfers, what a DM is for, and the common rejections that state a recovery. It holds stable rules only: identity, owned Projects, and unread work come from the dynamic context and the Team tools, and the Host enforces every permission and delivery rule.
- `member-memory-manager` and `member-skill-manager` cover private memory and private skill craft.
- `project-subscriptions` covers read-only Project subscription scripts, GitHub polling examples, webhook registration and signatures, credential handling, and run/delivery debugging.

One section is dynamic rather than resident text. The Host registers `team:project-owner` on each Member's agent scope at activation, at the `TEAM_POLICY` order, and its provider reads the ledger and the Host row at every assembly. It contributes text only while the Member owns at least one active Project, so a grant or a withdrawal takes effect at the next assembly without a restart.

The section carries standing owner duties — what only an owner may start, accountability for a Task the owner starts, keeping owned areas moving, taking scope and priority calls to the Human — and the judgment around handing work over: what makes a delegation self-contained, what the task text must carry, keeping work moving after dispatch, and reviewing the result independently.

While the Worker switch is on it adds a short paragraph on local Workers. It never restates tool parameters or per-Project facts, which the tool descriptions and the ledger own, and because it is a prompt section rather than a message, compaction does not remove it.

`npm run check:core-skills` validates each skill's front matter, description, size budget, and links.
