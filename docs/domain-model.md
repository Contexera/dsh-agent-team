# dsh-agent-team Domain Vocabulary

English | [中文](domain-model.zh.md)

## Agent Team

The single shared collaboration domain in one DSH home. It stores cross-member collaboration facts, not model context, session transcripts, or private memory.

## Member

A stable identity authorized to read, speak, claim work, and receive Inbox hints. A Member is identified by an immutable branded ref. Private memory, skills, persona, and model are Member-global facts, not per-Workspace state. The first release has Human and Agent Members.

## Workspace Participation

A join/leave relation between a Member and a Workspace, committed as ledger operations — the same relation shape as Project participation, one rung above it (Workspace participation → Project participation, derived from Threads → Thread Attention). A Member's `workspaceId` records where it was created and never changes; authorization everywhere reads the current participation set, not the creation field. Joining grants collaboration immediately; it does not move or create the Member's Session. Each Member retains one Session lineage in its creation Workspace.

Joining does not create another Session; collaboration in other participated Workspaces uses the same Session, and the Member moves its own working directory into them with `working_directory`. The Human Member participates in every Workspace.

## Human Member

The special Member corresponding to the current Harness user. It participates in Messages, Claims, and Activities and can manage Projects, Members, acceptance, and Task terminal state.

## Agent Member

A Member created and managed by Team. Created inside one Workspace (its creation record), it joins further Workspaces through Workspace Participation. It runs one explicit team-enabled preset Session at a time, rooted in its creation Workspace; ordinary Sessions and forks do not gain membership automatically.

## Member Capabilities

Durable capability intent on the Member entity (optional `capabilities` field: `tools.allow` and `skills.allow`), carried verbatim through every lifecycle operation and restored by Host restart replay. Pure intent: allow-list names are not validated against any known-name set at commit time — a Harness upgrade that renames or removes tools can never make an old ledger unreplayable. Divergence from the names known at activation is derived as a runtime warning (`capabilityWarnings`, a projection-derived state, never persisted — persisted warnings would lie after Host restart or upgrades).

## Workspace

A shared working directory and authorization domain. An Agent Member's Session header cwd is its creation Workspace's directory and never changes; the directory it works in is the Session's own, movable through `working_directory`. Private memory lives outside the Workspace directory.

## Project

A persistent collaboration place in a Workspace. A Member takes part in a Project by taking part in one of its Threads — reading, speaking, claiming, or following — and that is what authorizes it everywhere in the Project; there is no separate enrolment to grant. Human Members can view every Workspace Project.

Once the ledger adopts rules version 2, a Project has owners: the Human owns every Project without being recorded, and the Human grants or withdraws Agent owners (`team/project-owner-added` / `team/project-owner-removed`) among Agents that participate in the Project's Workspace and are enabled or suspended. Leaving that Workspace, archival, or removal ends an Agent's ownership; suspension does not.

From version 2, Project membership also counts owners and every Member ever mentioned in the Project, and drops archived and inactive Members; everything visible under version 1 stays visible.

Behind rules version 2 a Project also has a Main stream: a conversation of its own, outside every Thread. Any Project member may post to it (`team/main-message-posted`). A Main stream Message carries `scope: 'main'`, no Thread or Task, and may only answer another Main stream Message of the same Project. Mentioning a Member, or answering their Message (the Human included), gives them one Main stream marker; `@all` is plain text.

An owner's Main stream unread is what other Members wrote after the owner started and after its read watermark — Messages, owner changes and new discussion Threads — plus its markers; the Human starts at the later of the Project's creation and the version-2 adoption. Anyone else has markers only, and an Agent that stops being an owner keeps its markers but loses the ordinary unread.

A writer holding Main stream unread reads first (`main_unread_required`). `team/main-stream-read` advances an owner's watermark and consumes markers, and writes nothing when it would change neither.

Behind rules version 2 only a Project owner starts a Thread (`team/thread-started`, kind `discussion` or `task`) and the top-level `team/message-sent` is no longer written; anyone else gets `project_owner_required`, which points to the Main stream.

A Thread appears in the Main stream as a card showing its current state: anchor preview, reply count, writers and newest activity for a discussion; Task number, status and live Claim owners for a Task. Version-1 top-level Threads appear as cards in creation order and are never unread.

Behind rules version 2 any Project member may reply in any Thread. A mention or an answer is one direct marker and never starts or resumes Attention, and the Human invitation confirmation no longer exists.

## Message

Immutable content explicitly sent in a Project or existing Thread. Every top-level Project Message atomically creates a Thread; new Clients/tools default to a taskless Thread, while explicit 「作为任务」 creates a real Task in the same commit. A reply continues an existing Thread. Every Message carries the wall-clock instant of its committing operation; agent-facing surfaces render that instant in the fixed UTC+8 coordination zone.

## Task

An optional work-tracking overlay attached to an existing Thread, not a prerequisite for a Thread. It can be created by explicit top-level task intent or added by Human promotion. Promotion also appends a public explanation Message. Task status is derived from Claims; Human acceptance and close are explicit facts. Human-facing `Task #N` is the durable Task creation ordinal within its home Project: taskful starts and promotions participate, while a taskless anchor's original position does not. It is not identity; stable cross-project references use branded `taskRef`.

Acceptance normally waits for every Claim to be done (`in_review`). The Human may also accept early from `in_progress`: the accept operation projects the Claims still active at that moment to done and records them in the activity as `completedClaimRefs`, notifying each owner without fabricating owner claim-done events. A `todo` Task that was never claimed is accepted directly, and its activity carries no claim list.

## Thread

An independent, single-level public collaboration aggregate inside a Project. It always has `threadRef`, an anchor Message, and a revision, but may have no Task. Public Messages increment revision; Taskful Claim and resolution changes do too. Existing-Thread writes require current revision. A taskless Thread still supports replies, follows, structured mentions, Inbox, reads, and history, but has no Claims, Task status, or resolution controls.

Collaboration uses `threadRef` first; a released task-only Client may use `taskRef` as a Host compatibility alias only for taskful Threads, while Task/Claim operations use `taskRef` identity. Revision is an internal concurrency token, not citable message content.

## Claim

A Member's commitment to one Direction in a Task overlay. Taskless Threads have no Claims. States are active, done, and released; after normalization, one Task has at most one active Claim for the same Direction. Multiple Claims intentionally allow different text that may describe duplicate work.

## Direction

Free-text work direction for a Claim. Comparisons apply Unicode normalization, trim, whitespace compression, and case folding; synonyms are not inferred.

## Thread Attention

A private persistent attention period for one Member and Thread: the current period's start and a contiguous read watermark. Its presence is what following means, and it is not public revision. What starts and ends a period is in [attention-and-messaging.md](team-collaboration/attention-and-messaging.md).

## Thread Inbox

Member-level unread projection derived from Thread Attention and direct mentions. It is not a Session queue, browser state, or per-message read table; its derivation and read semantics are in [attention-and-messaging.md](team-collaboration/attention-and-messaging.md), and the tool contract in [tools.md](team-collaboration/tools.md).

## Follow

An operation on Thread Attention, not an independent subscription object. Follow controls whether ordinary updates create Inbox work and does not revoke Project visibility.

## Activity

A recorded collaboration-state fact. Claim create/done/release, Task accept/close/reopen, and promotion are public revisioned Thread facts; follow/unfollow and read watermarks are private Attention audit facts. Runtime errors may be current Human UI risk but are not ledger Activity or Inbox facts.

## Inbox Hint

A safe-boundary hint derived from durable Thread Inbox state. A hint is bounded and may wake an idle Agent or arrive at a running Agent's next safe step; it does not mean the model read, handled, replied to, or accepted anything. Durable Inbox is rediscovered after resume.

## Operation

One immutable atomic business commit in the Team ledger. Each operation has global sequence, stable operation ID, idempotent request ID, actor, one business fact, and a wall-clock `occurredAt`. Sequence — never the instant — is the ordering and concurrency authority; Thread fact envelopes project the committing operation's instant so every reread path sees one value per fact.

## Revision

The sequence of the latest operation relevant to a Thread. It is an optimistic concurrency fence, not a Message count.

## Ref

A restart-stable, typed identifier that callers cannot safely construct by concatenation. Member, Project, Task, Thread, Message, Claim, and Operation use distinct branded refs. Attention is identified by Member plus Thread.

## Direct Message

A private Member-to-Member message, not part of any Thread. The ledger appends one audit-only `team/dm-sent` operation (request-idempotent; sender and recipient must be enabled Agent Members of the same Workspace) while the projection deliberately stays unchanged — no Project, Thread, revision, Attention, or Inbox markers. Delivery is a transient runtime effect: an idle recipient opens a followup turn with the body as a relay-form user message, a busy one is steered into the current turn, and the text carries one bounded line of adjacent context.

A failed wake leaves the durable fact intact and the sender gets a structured delivery error instead of a silent loss; there is no automatic redelivery. A DM is for quick clarifications and status syncs; task work belongs in Threads. A possible future private Place with its own participants and visibility would get separate authority and notification design.

## Runtime Presence

An in-process availability projection, not a ledger fact: available (live idle), working (loop running), error (current loop/tool failure), and unavailable (no usable handle or lifecycle/setup/resume block, including the brief context-rollover window where the ledger binding has moved but the new Session is not live yet). It is separate from Claim state.

## Member Diagnostic

The structured reason behind a non-normal presence or availability row, never persisted: `session-refused` (a deterministic format refusal of a Session the activation needed; may carry the refused artifact's location and whether a repair attempt proved anything remediable), `session-unreadable` (missing, corrupt, io, or unknown Session read failure), `preset-composition` (preset mount/validation failure, typically an install/runtime split), `rollover` (the transient commit window), `runtime` (live loop or compaction failure), or `activation` (unclassified activation failure).

The `class` routes which recovery action actually helps: a non-remediable refusal or a rollover window offers no restart, while everything else may recover through restart.

## Context Generation

One Member Session's working context between two generation boundaries. A fresh generation starts empty: its first model-facing context is the ordinary per-step injection (identity, `memory.md`, the Workspace list) plus whatever message woke it, and it is never told a generation changed. The ledger records the current binding (one per Member at all times) and the previous Session of the latest transition; the Session logs themselves hold the context history. Every generation keeps Member identity, model, private memory, skills, Claims, and Attention.

A swap is the Host's decision alone, taken at a wake boundary. A legacy log may still carry a checkpoint anchor, a rollover pair, or a pending intent written by an earlier build; the fold keeps decoding them so old ledgers and old Session logs still read back, but no current build produces any of them.

## Suspend

Temporarily stop a Member's live Agent while retaining identity, Session, Claims, Attention, unread state, and private memory. Resume uses the same Session and durable unread to decide whether to hint Inbox.

## Withdraw

Leaving one Workspace: `team/member-workspace-left` ends the Member's participation there, exits its Project memberships in that Workspace, releases that Workspace's active Claims, and clears its Attention there. Everything else — the Member identity, other participations, the live Session and its cwd, private memory — is untouched; the creation Workspace cannot be left — use global archival instead. The UI presents this as the destructive row action on a non-creation Workspace.

## Archive

The hidden third state between Suspend and Remove, for Members and Projects. It is reversible in design — the facts stay complete in the ledger for replay and a future restore — but there is deliberately no restore entry point this round, mirroring archived dsh sessions. `archiveMember` disposes the live session (private memory and the Session log stay on disk) and releases active Claims across every participated Workspace with public `claims_released` Activities; `archiveProject` applies the same release shape across every owner on the Project's Threads.

Memberships survive archival (hidden state, not departure). Archived entities are gone from every Team API surface — projections, mention candidates, ref resolution, and ref-addressed reads reject with an explicit archived error. Removal from archived remains available as the data-hygiene path.

## Remove

Irreversibly deactivate an Agent Member: release active Claims, end Attention, delete private memory, and archive its Session. Historical Messages, Activities, and identity snapshots remain.

## Member Lifecycle

The desired external state of each durable Member state, in one table. Every lifecycle operation runs exactly this effect set right after its commit, and Host startup re-runs it for each Member, so a crash or a failed effect between commit and effect converges by repeating the same derivation:

| State | Live handle | Session grouping | Private memory |
| --- | --- | --- | --- |
| `enabled` | one, on the recorded binding | active | kept |
| `suspended` | none; resume restores the same Session | kept | kept |
| `archived` | none | archived (hidden), log kept on disk | kept |
| `inactive` | none | archived | deleted |

Each step derives from the durable state alone, so repeating it after a crash or a failed call runs exactly the owed steps and never a second durable write.
