# Tools and preset

English | [中文](tools-and-preset.zh.md)

The explicit `team-member` preset is the only Team Member composition. It adds coding capability rows (shell, filesystem/search, web search and fetch, background jobs, the skill loader tool, compaction), collaboration guidance/tools, Harness Workspace instruction discovery, and bounded private-memory context. Ordinary Sessions remain outside this roster and receive no Team prompt sections, tools, or Member memory.

A nested preset group isolates the skills registry, Team's per-Agent router, and the skill loader together; [Host authority](host-authority.md#member-capabilities-and-skills) owns the exact roots and selection lifecycle.

Tool declarations and prompt guidance are separate model-input layers. Tool names, descriptions, and parameters become schemas in the request's dedicated `tools` field; some tool plugins also register system-prompt guidance sections. Skill summaries instead arrive as durable user-role `<system-reminder>` / `<available_skills>` messages, and a full skill body enters only after the `skill` tool loads it or the user explicitly invokes it. The isolated Team skills registry is shared by all three skill surfaces.

The filesystem row states `applyPatch: false` rather than inheriting the Host default: `edit` is the one file-modification tool a Member is granted, and a preset that left the flag unstated would widen every Member's surface the day a Host default flips. The shipped preset test asserts the value, so the decision is checked rather than assumed.

Every Member starts restricted to the tool definitions contributed by its selected preset, plus the explicitly shared `working_directory` tool. `capabilities.tools.allow` still only narrows this baseline.

A profile-wide `extraToolGrants` list on the Team Host row grants exact, case-sensitive registered Host tool names, including a baseline name omitted by the Member allow-list. It defaults to empty and applies to every Team Member in that profile. This is an execution grant for external plugin tools already reachable by Members: it neither mounts a plugin, changes the Member preset, nor enables built-in DSH capabilities.

Team-owned tools and `working_directory` are reserved; a grant cannot name them. `team_worker` is declared only while the Host Worker switch is on, so a grant cannot turn it on; the nine manager tools are never candidates. A grant is a name, never a plugin origin, definition object, or registration instance.

The Host reads the grants synchronously at each Session `turn/start`, before the first tool resolution, and freezes them for that turn. A later-saved edit reaches the next turn even when consecutive turns never pass through idle, and creation, resume, and generation replacement use the same policy path. The restriction materializes the names known at that boundary.

Execution follows the registration DSH actually resolves for this Member and step, so its own `when`, pre-execute checks, Agent identity, and direct or nested step admission remain authoritative. A selected name registered after turn start is rematerialized into the next normal step's declaration; an unregister or re-registration invalidates the previously prepared admission.

External tool visibility and execution are separate. Inherited global or ancestor registrations are removed from the schema by `tools.restrict()` until granted. Registrations in the Member's own Agent scope are exempt from that restriction, so current Harness APIs cannot hide them; the execution guard denies them until granted.

At each prompt assembly, `team:tool-availability` lists visible names that the Member guard denies: ungranted Agent-scope registrations and same-name replacements of baseline tools. It tells the Member not to call them. A valid grant can remove its name from the warning from the next turn. The execution guard remains authoritative for the actual step.

A step refresh runs inside the public `agent/pre-step` gate using the turn's frozen grants. Tool resolution for that step has already happened, so this refresh prepares later declarations, not the current one; a failed refresh can still refuse the current request. Session event observers cannot provide that refusal, and `step/start` is too late.

The same switch also governs the Worker paragraph of the owner guidance section, which is re-derived at every assembly; the Worker registry still refuses a start while the switch is off.

The Host captures the preset definitions before Agent publication and guards direct and nested execution. If a grant-bearing policy cannot be installed, the Host tightens to the same Member baseline with no extra grants rather than restoring the previous grant-bearing restriction. If that baseline also cannot be established, the pre-step gate refuses the turn before a model request and the next normal turn retries. Replacing an allowed definition is refused at execution rather than at assembly. These checks apply to the exact Member, not ordinary Agents or delegated child scopes.

The settings catalog discovers tool names from the Host's global registry and live Member scopes, never from ordinary Agent scopes. It does not infer plugin origin, clone a plugin, or claim to be the exact step-admission set for a particular Member or turn. Names supplied by activated Member presets, Team-owned names, `working_directory`, and `team_worker` are not offered. DSH's four tree-local shared-task tools are also excluded because that board overlaps Team's ledger-owned Tasks.

A saved name that is no longer grantable remains selected and removable. Ordinary Sessions and other profiles receive no grant.

Team mode does not filter prompts injected by other official or custom plugins. Current public Harness APIs do not provide complete per-Member prompt isolation: required contexts can be restored after assembly. In particular, experimental Team's `team:policy` and required `team:identity` remain visible; they do not block activation or conversation.

This uses public Harness hooks rather than an enforced final request policy. Other assembly middleware can change the result after Team's filter. Full plugin compatibility is not certified; see [the compatibility restriction](../dsh-release-compatibility.md#37-competing-team-implementations).

Every row `name:` is a bare specifier the Loader resolves against the profile, not against this bundle. A profile links this bundle and the host closure, so a row may name a host package or one of this bundle's own subpaths, and never a package nested inside this bundle's dependency tree. A name that resolves in a working tree can still leave the row `never started` in a real install, so a dependency's module reaches a row only through a re-export under this bundle's own name.

The model-facing tools are defined in `packages/tool-agent-team/src/index.ts` and `packages/tool-agent-team/src/subscription.ts`; the Member contract is in [`tools.md`](../team-collaboration/tools.md). Every preset that mounts the tools plugin declares its own exact subset through the plugin's `only` config, because the model's visible tool list is read from the registering scope's schemas: a tool registered here and hidden later is still listed to the model, and a tool refused in its handler is still spent on before it fails.

`team-member` names the ten Member tools; `team-manager` names the nine manager tools and nothing else. An unknown name in the list is refused rather than skipped, so a typo cannot mount an empty surface that only surfaces as a Session that cannot act.

The Web Client is the only Human control surface and delegates every mutation through `ctx.agentTeam` typed Remote; do not restore a slash-command adapter.

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

## Team manager preset

The Host mounts a separate isolated `team-manager` preset for its [Team manager](../domain-model.md#team-manager) Session. It keeps a generic coding surface — persona, time and Workspace instructions, shell, filesystem/search, web, jobs, skill loading, ask-user, and basic compaction — but deliberately omits Member context, the Member time context, Member memory and its compaction adapter, Worker and rollover policy, and the profile `extraToolGrants`. This build registers the nine manager tools of the planned management set and none of the rest.

That surface runs at the trusted `danger-full-access` policy, so the persona carries the data red line as a rule: under `$DSH_HOME` the manager reads and writes only its own `agent-team/manager/` directory plus a Member's private assets `team_overview` has just confirmed by ref, never the Host's sqlite files, and a Member's Session only through the read-only reader the locator names — never by opening the stored log itself.

It edits a Member's memory, notes or skills only within the Human's current request and under the applicable upkeep rules; it never deletes a Member's directory or copies private content into shared material. Its own memory, notes and a tool result record what was once said, so none of them authorizes an irreversible or costly action in place of the Human asking for it now.

The Team surface it mounts is that exact subset: two read-only tools plus seven writes. `team_overview` reads the whole Team as a directory: every Workspace with its checkout path, every Project with its shared goal, its owners and what each answers for, its live subscription counts and board summary, and every Member with its standing, where it participates, which model route it is configured to run, how it runs, what its capability configuration mounted, and what it owns.

`team_models` reads the model routes a Member may run from the Session controller's own catalog, so the manager can never offer a route the Web member editor does not. Neither read carries a message body, a Thread fact, a credential, or private file content; a `memberRef` read adds that Member's full standing, its private directory path, and the locator for its current Session, and nothing beyond them.

A capability warning in `team_overview` means the stored configuration names a tool the Member cannot hold: the write succeeded and the stored list keeps the name, but the runtime ignores it, so the Member runs narrower than the list reads, and the warning names the tools it can hold.

`member_create`, `project_create`, `project_owner`, `project_update`, `member_update`, `member_state` and `member_workspace` are the manager's only writes, and each rides the Host's own write path — the same serialized ledger queue, activation and receipt the Web Client uses — so the record a write answers with is the record every other surface reads.

`member_update` adjusts a Member that already exists, and it is a partial update: every field the call leaves out keeps the value stored at the moment the write runs, merged inside the ledger's serialized section, so an edit cannot overwrite a rename or description change that landed while it was queued.

A replayed `requestId` compares only the fields it stated. The handle and the preset are not editable there, an explicit blank standing is refused, an omitted `capabilities` keeps the stored override while `clearCapabilities` clears it, and a replacement route is checked against the catalog only while the request is new.

Its answer keeps the durable receipt and reports separately how far the stored configuration reached the live runtime — `applied`, `already-applied`, `deferred:no-live-handle`, `deferred:generation-changed`, or `failed:model-apply` / `failed:capability-apply` with the Member's own diagnostic — so a committed write whose live apply failed is never answered as an uncommitted rejection that would invite a duplicate retry.

The failing stage names the effect and the diagnostic class, and the comparison is against the route and the surface the live generation actually runs: replaying the same request retries the effect the stored configuration still owes, while a route a later edit replaced is never put back.

`member_state` suspends, resumes, or archives through the Host's existing durable operations; archive releases the Member's active Claims and clears its Attention while its private memory and Session log stay on disk. `recover` is the one runtime-only action: it writes no ledger record, requires the Workspace whose participation the Host verifies, and finishes an interrupted swap, rebuilds an orphaned composition, or restarts a failed activation.

`member_workspace` joins or leaves a non-default Workspace as a pure ledger relation — the Member's Session is not created, copied, or moved — and leaving the creation Workspace is refused in favour of archival.

`project_update` edits one Project's display facts or archives it. A name or goal the call leaves out keeps the value stored at the moment the write runs, merged inside the ledger's serialized section, so a rename cannot write back a goal the Human changed while it was queued; an explicit empty goal clears it the way the Web editor does, while an empty name is refused. Archival keeps every fact and the whole history, releases the Project's active Claims, clears the related Attention, and stops and clears every subscription the Project owns.

A cleanup that fails after an archival commits is named in the answer as a warning beside the receipt instead of turning the durable decision into a rejection. The archival itself cannot be redone under a new `requestId`, and replaying the same one keeps the original receipt while running that cleanup again, which is how the owed subscription state still gets cleared.

`project_owner` grants one Agent Member ownership of one Project, replaces the responsibility it answers for there, or withdraws the grant. An update appends to the owner relation instead of withdrawing and re-granting, so the Member keeps its grant, its Main stream Attention and its history across the change, and the responsibility is replaced everywhere it is read — the ownership context, `team_view`, and `team_overview` — while the Member's global description is untouched.

An update that records no responsibility stores `unspecified`, which is a fact about the grant rather than a gap to repair, and `add` still refuses an empty one. A withdrawal ends the relation only: a Member that still takes part in the Project keeps the Tasks it is accountable for, and one whose participation ends hands them back to the Human.

The manager layer adds only what the Web Client's own forms add: a non-empty Member standing, a non-empty Project goal, a non-empty responsibility on a new grant, and a model route validated against the Session controller's catalog once the request is known to be new. Owner eligibility, admission, the reserved Member tool set, and the 2,000-character responsibility bound stay the ledger's own rules rather than a second copy inside the tool.

Every write carries a `requestId`. The same id with the same parameters answers with the original receipt instead of writing twice, so a lost answer is retried rather than duplicated; a changed parameter under a reused id is refused as a collision. A refusal names its reason and wrote nothing. A committed Member whose activation failed is still committed: the answer keeps its receipt, ref and activation diagnostic, so the manager continues from there instead of creating it again.

The isolated registry's default remains `team-member`; only the manager runtime mounts `team-manager`.

All nine handlers authorize the caller themselves: the tool is served only while the calling Agent is the current manager Session. `ownsSession` cannot serve there, because it answers lineage, which a replaced generation still satisfies, so a Session that reaches the tool by any other path — a Member's own scope registration, a custom preset, an ordinary Session — is refused rather than answered.

A write authorizes twice: the same manager gate at the tool, and the ledger's own `authorize` hook inside the serialized section after the idempotency replay branch resolves, so a manager replaced between its call and its commit is refused with nothing written. `recover` has no ledger section to authorize in, so it re-checks the manager inside the Member's lifecycle section — the critical section it actually runs in — and a manager replaced while a recovery was queued is refused there with nothing repaired.

The manager policy captures that preset's exact definitions plus the shared `working_directory`, and its execution guard admits only those definitions for the exact current manager Agent. A later or foreign definition is denied rather than inherited. `addMember` accepts only `team-member`, checked before model validation or any ledger write, so a manager composition cannot become a Member.

The Client hides the shipped hero preset picker while the manager destination is active. That suppression is presentation only, not a grant or a permanent authorization lock: the Host owns the composition, and the manager guard authorizes each execution from the exact Agent and current pointer. The [Client boundary](client-and-remote.md#client-plugin-and-slot-composition) owns the entry and gate behavior.

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

- `team-domain-model` explains roles and permissions (Human, Project owner, Workspace participant, accountable), the Main stream and Thread division of labor, how mentions, linked replies, and ordinary messages are delivered, when to read the Inbox or the board, the Task lifecycle and who accepts, closes, reopens, or transfers, what a DM is for, and the common rejections that state a recovery. It holds stable rules only: identity, owned Projects, and unread work come from the dynamic context and the Team tools, and the Host enforces every permission and delivery rule.
- `member-memory-manager` and `member-skill-manager` cover private memory and private skill craft.
- `project-subscriptions` covers read-only Project subscription scripts, GitHub polling examples, webhook registration and signatures, credential handling, and run/delivery debugging.

One section is dynamic rather than resident text. The Host registers `team:project-owner` on each Member's agent scope at activation, at the `TEAM_POLICY` order, and its provider reads the ledger and the Host row at every assembly. It contributes text only while the Member owns at least one active Project, so a grant or a withdrawal takes effect at the next assembly without a restart.

The section carries standing owner duties — what only an owner may start, accountability for a Task the owner starts, keeping owned areas moving, taking scope and priority calls to the Human — and the judgment around handing work over: what makes a delegation self-contained, what the task text must carry, keeping work moving after dispatch, and reviewing the result independently.

While the Worker switch is on it adds a short paragraph on local Workers. It never restates tool parameters or per-Project facts, which the tool descriptions and the ledger own, and because it is a prompt section rather than a message, compaction does not remove it.

The Team manager Session loads its own read-only skills from `packages/agent-team/manager-skills/`, ahead of its writable `$DSH_HOME/agent-team/manager/skills/`. That root is deliberately separate from the Member core skills: a management skill must not appear in a Member catalog, and a Member skill must not appear in the manager's.

The six shipped skills split resident method from on-demand knowledge: `team-management-guide` covers how a Team works and how to design one from evidence; `team-operations` the order of work and the nine tools; `team-event-loops` subscriptions, reminders and messages as the loops that keep a Team moving; `manager-domain-model` the Member-facing rules explained to a manager that holds none of those tools; `manager-memory` the manager's own bounded index and review points; `manager-session-evidence` reading a Member's stored Session as evidence.

`team_overview` is the only tool that names a Session. A `memberRef` read adds `sessionEvidence` — the Session id, the state the persistence backend reported, the backend-resolved log location, and the read-only reader that inspects it — so the manager never guesses a Session id or builds a log path from a home directory.

The reader is a script shipped inside `manager-session-evidence`, and it reads through the Harness Session persistence backend rather than a second decoder. Its output cap is measured on the JSON it prints, a cut event carries a segment offset that `--offset` continues, and a log path that no longer matches the Session is refused before any body is returned.

`npm run check:core-skills` validates each skill's front matter, description, prompt budget, and links in both shipped roots (`core-skills/` and `manager-skills/`). The budget counts the Markdown a model reads; a shipped script is reported in the gate summary instead. The Member root may never be empty; the manager root ships those six skills, and the gate still tolerates an empty one because content is not a build dependency.
