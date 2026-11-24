# dsh-agent-team Domain Vocabulary

English | [中文](domain-model.zh.md)

## Agent Team

The single shared collaboration domain in one DSH home. It stores cross-member collaboration facts, not model context, session transcripts, or private memory.

## Team manager

The Host-owned ordinary DSH Session that helps the Human understand and manage the Agent Team. It is not a Member: it has no Member ref, Workspace participation, Claims, or Member Inbox, and its conversation is not a Team fact.

It uses the isolated `team-manager` preset. Its Session lifecycle and private resources belong to [Workspace and Session storage](architecture/workspace-session-storage.md#team-manager-session); its tools belong to [Tools and preset](architecture/tools-and-preset.md#team-manager-preset).

## Member

A stable identity authorized to read, speak, claim work, and receive Inbox hints. A Member is identified by an immutable branded ref. Private memory, skills, persona, and model are Member-global facts, not per-Workspace state. The first release has Human and Agent Members.

## Workspace Participation

The durable join/leave relation between an Agent Member and a Workspace. Under current rules, Workspace participation grants Project visibility; enabled participants may collaborate, while starting or promoting a Thread additionally requires Project ownership. There is no separate Project membership to join.

A Member's immutable `workspaceId` records its creation Workspace. Joining another Workspace neither moves nor creates a Session: the Member keeps one Session lineage and changes its working directory with `working_directory`. The Human can access every Workspace. See [collaboration routing](team-collaboration/model-and-time.md#collaboration-model).

## Human Member

The special Member corresponding to the current Harness user. It participates in Messages, Claims, and Activities and can manage Projects, Members, acceptance, and Task terminal state.

## Agent Member

A Member created and managed by Team, with one live `team-member` preset Session at a time. Its creation Workspace anchors its Session lineage; Workspace participation lets that same identity collaborate elsewhere. Ordinary Sessions and forks do not acquire Team identity automatically.

## Worker Execution

A Team-owned execution of a native Codex or Claude session, identified by a `worker:` ref. It records the initiating Member, Project, optional Thread and Task, engine, cwd, and execution outcome. A Worker has no Team identity and cannot claim, accept, or answer for its initiator.

Steering supplies input to the same native session. Continuing a settled execution creates a new execution linked by `continuedFrom`, without rewriting the predecessor. [The Worker tool contract](team-collaboration/tools.md#team_worker) owns the caller-visible rules; [Host authority](architecture/host-authority.md#worker-delegation) owns execution and native-record handling.

## Member Capabilities

Durable intent stored on a Member as optional `capabilities.tools.allow` and `capabilities.skills.allow` lists. Intent is not the effective tool or skill surface: current registrations, preset limits, and Host policy also apply. Unknown names become runtime warnings rather than invalidating old ledger records. [Host authority](architecture/host-authority.md#member-capabilities-and-skills) owns enforcement and isolated skill catalogs.

## Workspace

A shared working directory and authorization domain. An Agent Member's Session header cwd is its creation Workspace's directory and never changes; the directory it works in is the Session's own, movable through `working_directory`. Private memory lives outside the Workspace directory.

## Workspace Rules

One Team-owned file per Workspace, outside every repository, holding the conventions only this Team shares there. It is injected to every participating Member and to the Team manager, its primary curator; it ranks below the repository's `AGENTS.md` and is not a Team fact. [Memory and context](team-collaboration/memory-and-context.md#workspace-rules) owns its injection.

## Project

A persistent collaboration place inside a Workspace, containing a Main stream and single-level Threads.

Current rules separate three relationships:

| Relationship | Meaning |
| --- | --- |
| Workspace participation | Permission to read Project content and, when enabled, collaborate |
| Project ownership | Authority to start or promote Threads and manage Project subscriptions |
| Following | Attention to ordinary updates, not an access grant |

The Human owns every Project implicitly. An Agent owner may carry a Project-specific `responsibility`: trimmed text of at most 2,000 characters, distinct from the Member's global description and the Project's shared description. An absent responsibility means unspecified, not an error.

The Main stream is conversation outside every Thread. Its Messages have `scope: 'main'` and no Thread or Task; a reply must target another Main stream Message in the same Project. Threads also appear there as current-state cards. Reading a card's Main entry does not read its Thread.

Rules version 9 replaced derived Project membership with Workspace access plus own/follow relations. Version 10 extended Task creation and promotion to accept the same accountable targets as transfer. The current ledger rules version is 10; [rules versions and replay](architecture/host-authority.md#rules-versions-and-replay) owns adoption and historical compatibility.

Use [the tool contract](team-collaboration/tools.md) for discovery and posting, and [Attention and messaging](team-collaboration/attention-and-messaging.md#main-stream-attention) for Main stream unread behavior.

## Subscription

A Project-owned script definition that the Host runs without a Member Session, on an interval or webhook trigger. Its durable definition includes a script snapshot, credential references (never credential values), revision, and `active`, `paused`, or `deleted` state.

Accepted events are deduplicated by subscription and event id, then published as addressed Main stream records, not Messages. Pausing does not discard accepted events; deletion and Project archival block later acceptance and publication.

Project owners and the Human manage subscriptions. [The tool contract](team-collaboration/tools.md#team_subscription) owns parameters and results; [Host authority](architecture/host-authority.md#subscription-scheduling-and-unattended-execution) owns scheduling, sandboxing, and private run history.

## Message

Immutable content explicitly sent in a Project or existing Thread. A Thread is created by `startThread`, never by a Main stream message: `postMainMessage` writes a Main stream Message that belongs to no Thread, and `startThread` writes the Thread's anchor. A started Thread is a discussion, or a Task when `kind: 'task'` asks for one; a taskless Thread can later gain a Task through Human promotion. A reply continues an existing Thread. Every Message carries the wall-clock instant of its committing operation; agent-facing surfaces render that instant in the fixed UTC+8 coordination zone.

## Task

An optional work-tracking overlay on a Thread. An owner can create it with `kind: 'task'` or promote an existing taskless Thread. Promotion records one structured `promote` Activity, not an additional prose Message.

A Task has an explicit resolution (`open`, `accepted`, `closed`) and a projected status. Open status follows Claims (`todo`, `in_progress`, `in_review`); accepted and closed Tasks read as `done` and `closed`. Acceptance is not a Claim status. [Collaboration model](team-collaboration/model-and-time.md#collaboration-model) owns their transitions.

One accountable Member carries responsibility; Claims carry execution. Under rules version 10, a start or promotion can name any target a transfer accepts; otherwise its creator is accountable. Transfer does not move Claims. [Task authority](team-collaboration/boundaries.md#ownership-and-task-authority) owns acceptance, transfer, close, and reopen permissions.

`Task #N` is the durable creation ordinal within its Project, counting taskful starts and promotions. A taskless Thread's earlier position does not determine the number. Stable identity is `taskRef`, not this display number.

`sourceThreadRefs` names immutable taskless source discussions in the same Project. The Task appears there as a read-only current-state card rather than as a Main stream card.

## Thread

An independent, single-level public collaboration aggregate inside a Project. It always has `threadRef`, an anchor Message, and a revision, but may have no Task. Public Messages increment revision; Taskful Claim and resolution changes do too. Existing-Thread writes require current revision. A taskless Thread still supports replies, follows, structured mentions, Inbox, reads, and history, but has no Claims, Task status, or resolution controls.

A bound Worker run's start and ending are two public Thread facts that increment no revision: they revise no Thread state, so they sit past it, and a read's confirmation bound is the Thread's head rather than this number ([`team_thread`](team-collaboration/tools.md#team_thread)).

Collaboration uses `threadRef` first; the Host also resolves `taskRef` to its taskful Thread, while Task/Claim operations use `taskRef` identity. Each tool action's address requirements are defined in the [tool contract](team-collaboration/tools.md). Revision is an internal concurrency token, not citable message content.

## Claim

A Member's commitment to one Direction in a Task overlay. Taskless Threads have no Claims. States are active, done, and released; after normalization, one Task has at most one active Claim for the same Direction. Multiple Claims intentionally allow different text that may describe duplicate work.

## Direction

Free-text work direction for a Claim. Comparison applies NFKC normalization, trimming, whitespace compression, and lowercasing; synonyms are not inferred.

## Thread Attention

A private persistent attention period for one Member and Thread: the current period's start and a contiguous read watermark. Its presence is what following means, and it is not public revision. What starts and ends a period is in [attention-and-messaging.md](team-collaboration/attention-and-messaging.md).

## Thread Inbox

A Member's unread collaboration projection, including Thread and Main stream unread, direct markers, and private reminders. It is not a Session queue, browser state, or per-Message read table. [Attention and messaging](team-collaboration/attention-and-messaging.md) owns derivation and delivery; [tools](team-collaboration/tools.md#team_inbox) owns model-facing triage.

## Follow

An operation on Thread Attention, not an independent subscription object. Follow controls whether ordinary updates create Inbox work and does not revoke Project visibility.

## Activity

A recorded collaboration-state fact. Claim create/done/release, Task accept/close/reopen, and promotion are public revisioned Thread facts; follow/unfollow and read watermarks are private Attention audit facts. Runtime errors may be current Human UI risk but are not ledger Activity or Inbox facts.

## Inbox Hint

A safe-boundary hint derived from durable Thread Inbox state. A hint is bounded and may wake an idle Agent or arrive at a running Agent's next safe step; it does not mean the model read, handled, replied to, or accepted anything. Durable Inbox is rediscovered after resume.

## Member Reminder

A durable time promise a Member makes to itself, independent of its Session, Thread, or Workspace. A reminder has one recipient, a note, an `once`, `every`, or `cron` schedule, and `active`, `done`, or `cancelled` state.

Each due moment is an occurrence. A newer recurring occurrence replaces an unconsumed one instead of stacking. Unlike Thread unread, an occurrence is consumed when the notice that actually rendered it enters a turn. Omitted occurrences remain owed; a failed consumption write leaves them owed too.

Suspension keeps reminders timing for delivery on resume; archival or removal cancels them. [The reminder tool](team-collaboration/tools.md#team_reminder) owns schedule limits, retry identity, and management.

## Operation

One immutable atomic business commit in the Team ledger. Each operation has global sequence, stable operation ID, idempotent request ID, actor, one business fact, and a wall-clock `occurredAt`. Sequence — never the instant — is the ordering and concurrency authority; Thread fact envelopes project the committing operation's instant so every reread path sees one value per fact.

## Revision

The global operation sequence of the latest write that revised a Thread's state. It is a concurrency fence, not a Message count or the Thread's latest public-fact sequence: Worker start/settlement facts do not advance it. Tools render it as a next-write token; copy it verbatim into `baseRevision` under [mutation fences](team-collaboration/boundaries.md#mutation-fences).

## Ref

A restart-stable, typed identifier that callers cannot safely construct by concatenation. Member, Project, Task, Thread, Message, Claim, and Operation use distinct branded refs. Attention is identified by Member plus Thread.

## Direct Message

A private Member-to-Member message, not part of any Thread. The ledger appends one audit-only `team/dm-sent` operation (request-idempotent; sender and recipient must be enabled Agent Members of the same Workspace) while the projection deliberately stays unchanged — no Project, Thread, revision, Attention, or Inbox markers. Delivery is a transient runtime effect: the body arrives as a relay-form user message on the steered lane, so an idle recipient starts a turn and a running one takes it at its nearest step boundary, and the text carries one bounded line of adjacent context.

A failed wake leaves the durable fact intact and the sender gets a structured delivery error instead of a silent loss; there is no automatic redelivery. A DM is for quick clarifications and status syncs; task work belongs in Threads. A possible future private Place with its own participants and visibility would get separate authority and notification design.

## Runtime Presence

An in-process availability projection, not a ledger fact: available (live idle), working (loop running), error (current loop/tool failure), and unavailable (no usable handle or lifecycle/setup/resume block, including the brief context-rollover window where the ledger binding has moved but the new Session is not live yet). It is separate from Claim state.

## Member Diagnostic

The structured reason behind a non-normal presence or availability row, never persisted: `session-refused` (a deterministic format refusal of a Session the activation needed; may carry the refused artifact's location and whether a repair attempt proved anything remediable), `session-unreadable` (missing, corrupt, io, or unknown Session read failure), `preset-composition` (preset mount/validation failure, typically an install/runtime split), `rollover` (the transient commit window), `runtime` (live loop or compaction failure), or `activation` (unclassified activation failure).

The `class` routes which recovery action actually helps: a non-remediable refusal or a rollover window offers no restart, while everything else may recover through restart.

## Context Generation

One Member Session's working context between two generation boundaries. A fresh generation receives its current Member background plus the message that woke it, without a generation announcement; [Member context injection](team-collaboration/memory-and-context.md#member-context-injection) defines that background. The ledger records the current binding (one per Member) and the previous Session of the latest transition; Session logs hold context history. Every generation keeps Member identity, model, private memory, skills, Claims, and Attention.

A swap is the Host's decision alone, taken at a wake boundary. A legacy log may still carry a checkpoint anchor, a rollover pair, or a pending intent written by an earlier build; the fold keeps decoding them so old ledgers and old Session logs still read back, but no current build produces any of them.

## Suspend

Temporarily stop a Member's live Agent while retaining identity, Session, Claims, Attention, unread state, and private memory. Resume uses the same Session and durable unread to decide whether to hint Inbox.

## Withdraw

Leaving one Workspace: `team/member-workspace-left` ends the Member's participation there — ending every Project right participation carried — releases that Workspace's active Claims, and clears its Attention there. Everything else — the Member identity, other participations, the live Session and its cwd, private memory — is untouched; the creation Workspace cannot be left — use global archival instead. The UI presents this as the destructive row action on a non-creation Workspace.

## Archive

The hidden third state between Suspend and Remove, for Members and Projects. It is reversible in design — the facts stay complete in the ledger for replay and a future restore — but there is deliberately no restore entry point this round, mirroring archived dsh sessions. `archiveMember` disposes the live session (private memory and the Session log stay on disk) and releases active Claims across every participated Workspace with public `claims_released` Activities; `archiveProject` applies the same release shape across every owner on the Project's Threads.

Derived Project memberships from rules versions below 9 survive archival as stored facts (hidden state, not departure). Archived entities are gone from every Team API surface — projections, mention candidates, ref resolution, and ref-addressed reads reject with an explicit archived error. Removal from archived remains available as the data-hygiene path.

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
