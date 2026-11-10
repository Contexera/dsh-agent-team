import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Stable identifier of one Agent Team operation. */
export type AgentTeamOperationId = Branded<'AgentTeamOperationId'>

/** Caller-supplied idempotency identifier for one business operation. */
export type AgentTeamRequestId = Branded<'AgentTeamRequestId'>

/** Stable identifier of one uploaded composer attachment (cache, not archive). */
export type AgentTeamAttachmentId = Branded<'AgentTeamAttachmentId'>

/** Stable identifier of one Team member. */
export type AgentTeamMemberId = Branded<'AgentTeamMemberId'>

/** Stable identifier of one Workspace-scoped Project. */
export type AgentTeamProjectRef = Branded<'AgentTeamProjectRef'>

/** Stable identifier of one immutable Message. */
export type AgentTeamMessageRef = Branded<'AgentTeamMessageRef'>

/** Stable identifier of one Task. */
export type AgentTeamTaskRef = Branded<'AgentTeamTaskRef'>

/** Stable identifier of one Thread. */
export type AgentTeamThreadRef = Branded<'AgentTeamThreadRef'>

/** Stable identifier of one Worker execution. Team-owned: never an engine session id or activation id. */
export type AgentTeamWorkerRef = Branded<'AgentTeamWorkerRef'>

/** Stable identifier of one Claim. */
export type AgentTeamClaimRef = Branded<'AgentTeamClaimRef'>

/** Stable identifier of one public Thread Activity. */
export type AgentTeamActivityRef = Branded<'AgentTeamActivityRef'>

/** Opaque, restorable reference to one completed-turn context checkpoint in a Member's private Session lineage. The ref is the selection authority; the name is display only. */
export type AgentTeamContextCheckpointRef = Branded<'AgentTeamContextCheckpointRef'>

/** Snapshot of the Human authority authorized for an operation. */
export interface AgentTeamHumanActor {
  readonly kind: 'human'
  readonly memberId: AgentTeamMemberId
  readonly handle: string
}

/** Snapshot of the exact Agent Member authorized by its live Agent binding. */
export interface AgentTeamMemberActor {
  readonly kind: 'member'
  readonly memberId: AgentTeamMemberId
  readonly handle: string
}

/** Host-owned effects, never a business actor: Session recycling, rules adoption and private Task reminders. A model cannot choose this authority. */
export interface AgentTeamHostActor {
  readonly kind: 'host'
  readonly handle: 'agent-team'
}

export type AgentTeamActor = AgentTeamHumanActor | AgentTeamMemberActor | AgentTeamHostActor

/** Provider route plus provider-owned model id one Member can be pinned to. */
export interface AgentTeamModelSelection {
  readonly provider: string
  readonly model: string
  /** Adapter-owned reasoning effort, or the model's provider/default behavior when absent. */
  readonly reasoningEffort?: ReasoningEffortId
}

/** Durable capability intent of one Member, carried on the Member entity through every lifecycle operation. Names are not validated against known tools at commit time, so a Harness upgrade renaming tools cannot make an old ledger unreplayable; divergence surfaces at activation as runtime-derived warnings, never persisted. */
export interface AgentTeamMemberCapabilities {
  /** Absent = the Member sees all standard tools; present = the activation allow-list (unknown names drop with a warning; the Host always unions the Team tools and `working_directory` over it). */
  readonly tools?: { readonly allow?: readonly string[] } | undefined
  /** Absent = auto-load every skill in the Member's private skills directory; present = only the listed names. */
  readonly skills?: { readonly allow?: readonly string[] } | undefined
}

/** Durable identity and lifecycle intent of one team-managed Agent. */
export interface AgentTeamAgentMember {
  readonly memberId: AgentTeamMemberId
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly handle: string
  readonly description: string
  readonly presetId: string
  /** Absent inherits the Host default model selection at every activation. */
  readonly model?: AgentTeamModelSelection | undefined
  /** Durable capability intent; see AgentTeamMemberCapabilities. */
  readonly capabilities?: AgentTeamMemberCapabilities | undefined
  /** Host-internal namespace; never exposed through Client projections. */
  readonly privateMemoryPath: string
  /** Durable lifecycle state. `enabled`/`suspended` are the reversible working pair; `archived` hides the Member everywhere while keeping its Session log and private memory recoverable (no restore entry point yet); `inactive` is irreversible removal with data cleanup. */
  readonly state: 'enabled' | 'suspended' | 'inactive' | 'archived'
}

/** Runtime-derived divergence between a Member's persisted capability intent and the names known at activation. Never persisted; recomputed at every activation. */
export interface AgentTeamCapabilityWarning {
  /** The persisted allow-list entry that resolved to no known capability. */
  readonly name: string
  /** Digest of the names that were known when the entry was dropped. */
  readonly knownNames: readonly string[]
}

/** Host projection combining durable intent with process-local availability. The optional diagnostic is structured: `class` routes which action helps, `detail` is the human-readable reason, and a refused session carries its artifact location. */
export interface AgentTeamAgentMemberStatus {
  readonly member: AgentTeamAgentMember
  readonly availability: 'active' | 'suspended' | 'inactive' | 'archived' | 'unavailable'
  readonly presence: 'available' | 'working' | 'error' | 'unavailable'
  readonly diagnostic?: AgentTeamMemberDiagnostic
  /** Activation-scoped capability warnings; empty while capabilities resolve cleanly. */
  readonly capabilityWarnings?: readonly AgentTeamCapabilityWarning[] | undefined
  /** Whether the live runtime reflects the stored configuration: 'applied' after a successful apply, 'pending' while there is no proof (no live handle, deferred edit, or failed apply). Always present so absence is never mistaken for applied. */
  readonly capabilityState: 'applied' | 'pending'
}

/** Which action actually helps an unavailable or erroring Member; the diagnostic's policy axis. */
export type AgentTeamMemberDiagnosticClass =
  | 'session-refused' // deterministic format refusal of a Session the activation needed
  | 'session-unreadable' // missing, corrupt, io, or unknown Session read failure
  | 'preset-composition' // preset mount/validation failure (often an install/runtime split)
  | 'rollover' // transient context-rollover window
  | 'runtime' // live runtime or compaction failure
  | 'activation' // unclassified activation failure
  | 'capability-apply' // post-commit configuration apply failed at the runtime

/** One Member failure's structured reason; rendered, never persisted. */
export interface AgentTeamMemberDiagnostic {
  readonly class: AgentTeamMemberDiagnosticClass
  readonly detail: string
  /** The refused artifact's location, when a format refusal reported one. */
  readonly location?: { readonly kind: string; readonly path: string }
  /** The Session the failure is about, when it is about one. */
  readonly sessionId?: SessionId
  /** The bounded source that observed the failure, when one is available. */
  readonly source?: string
  /** When the Host observed the failure, as an ISO timestamp. */
  readonly occurredAt?: string
}

/** Browser-safe Member identity with Host-only paths removed. */
export type AgentTeamClientMember = Omit<AgentTeamAgentMember, 'privateMemoryPath'>

/** Browser-safe lifecycle projection. */
export interface AgentTeamClientMemberStatus extends Omit<AgentTeamAgentMemberStatus, 'member'> {
  readonly member: AgentTeamClientMember
  readonly workspaceIds: readonly WorkspaceId[]
}

/** Human roster: omit Workspace to select from the global Member catalog. */
export interface AgentTeamMembersRequest {
  readonly workspaceId?: WorkspaceId
}

/** Look up navigation facts for branded Task refs found in message bodies. */
export interface AgentTeamResolveTaskRefsRequest {
  readonly workspaceId: WorkspaceId
  readonly taskRefs: readonly AgentTeamTaskRef[]
}

/** One resolved Task; refs that do not exist in the workspace are omitted. */
export interface AgentTeamResolvedTaskRef {
  readonly taskRef: AgentTeamTaskRef
  readonly projectRef: AgentTeamProjectRef
  readonly threadRef: AgentTeamThreadRef
  readonly taskNumber: number
}

export interface AgentTeamResolveTaskRefsResult {
  readonly resolved: readonly AgentTeamResolvedTaskRef[]
}

/** Look up navigation facts for branded Thread refs found in message bodies. */
export interface AgentTeamResolveThreadRefsRequest {
  readonly workspaceId: WorkspaceId
  readonly threadRefs: readonly AgentTeamThreadRef[]
}

/** One resolved Thread; refs that do not exist in the workspace are omitted. */
export interface AgentTeamResolvedThreadRef {
  readonly threadRef: AgentTeamThreadRef
  readonly projectRef: AgentTeamProjectRef
  readonly taskRef?: AgentTeamTaskRef
  readonly taskNumber?: number
  /** Opening-line gist distinguishing one Thread chip from another: the first non-empty line, trimmed, bounded as a wire guard — the Client projects it to plain text and caps its own display width. */
  readonly title: string
}

export interface AgentTeamResolveThreadRefsResult {
  readonly resolved: readonly AgentTeamResolvedThreadRef[]
}

/** One Message's answer target, as a reader sees it. */
export interface AgentTeamMessageReplyContext {
  /** Printable author handle of the Message being answered; `human` for the Human. */
  readonly sender: string
  /** Bounded first line of that Message; display only, never the body. */
  readonly excerpt: string
}

/** Read one Message back verbatim, inside the Thread that carries it, or (with `projectRef`) from the Project's Main stream. Exactly one of `threadRef` and `projectRef`. */
export interface AgentTeamReadMessageRequest {
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly projectRef?: AgentTeamProjectRef
  readonly messageRef: AgentTeamMessageRef
}

/** One Message read back in full, body verbatim; the quote a Message renders is not this (see `AgentTeamResolvedMessageRef`). */
export interface AgentTeamReadMessageResult {
  readonly messageRef: AgentTeamMessageRef
  /** Absent for a Main stream Message. */
  readonly threadRef?: AgentTeamThreadRef
  readonly projectRef: AgentTeamProjectRef
  readonly sender: AgentTeamMemberId
  readonly sequence: number
  readonly occurredAt?: string | undefined
  readonly body: string
}

/** Looks up the context of Messages cited by `replyToMessageRef`. A reply stores only its parent's identity; author and excerpt resolve here from the ledger, so the quote cannot disagree with its Message and a parent outside the loaded history window still resolves. */
export interface AgentTeamResolveMessageRefsRequest {
  readonly workspaceId: WorkspaceId
  readonly messageRefs: readonly AgentTeamMessageRef[]
}

/** One resolved Message; refs the workspace cannot resolve are omitted. */
export interface AgentTeamResolvedMessageRef {
  readonly messageRef: AgentTeamMessageRef
  /** Absent for a Main stream Message, which belongs to no Thread. */
  readonly threadRef?: AgentTeamThreadRef
  readonly sender: AgentTeamMemberId
  /** Body gist for the quote block: the first non-empty line, trimmed, bounded as a wire guard — the Client projects it to plain text and caps its own display width. */
  readonly excerpt: string
}

export interface AgentTeamResolveMessageRefsResult {
  readonly resolved: readonly AgentTeamResolvedMessageRef[]
}

export interface AgentTeamOperationBase {
  readonly sequence: number
  readonly operationId: AgentTeamOperationId
  readonly requestId: AgentTeamRequestId
  readonly occurredAt: string
  readonly actor: AgentTeamActor
  readonly previousOperationId: AgentTeamOperationId | null
}

/** One Workspace-scoped collaboration Project. */
export interface AgentTeamProject {
  readonly projectRef: AgentTeamProjectRef
  readonly workspaceId: WorkspaceId
  readonly name: string
  readonly description: string
  readonly createdAtSequence: number
  /** Durable lifecycle state. `archived` hides the Project and its Threads everywhere while keeping all facts recoverable (no restore entry point yet). Older records omit the field; the schema normalizes it to `active` on load. */
  readonly state: 'active' | 'archived'
}

/** One durable Project membership fact derived from the operation ledger. */
export interface AgentTeamProjectMembership {
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
}

/** One immutable top-level or reply Message. */
export interface AgentTeamMessageAttachment {
  readonly attachmentId: AgentTeamAttachmentId
  readonly name: string
  readonly byteSize: number
  readonly mediaType: string
}

export interface AgentTeamMessage {
  readonly messageRef: AgentTeamMessageRef
  readonly projectRef: AgentTeamProjectRef
  readonly threadRef: AgentTeamThreadRef
  /** Absent on Messages committed while the Thread had no Task; promotion does not rewrite prior Messages. */
  readonly taskRef?: AgentTeamTaskRef
  readonly sender: AgentTeamMemberId
  readonly body: string
  readonly attachments?: readonly AgentTeamMessageAttachment[] | undefined
  /** The Message this one answers, when written as a reply; absent otherwise (including Messages recorded before replies existed). Only the parent's identity is stored; author and excerpt resolve at read time from the ledger's ref index. */
  readonly replyToMessageRef?: AgentTeamMessageRef
  readonly topLevel: boolean
  readonly sequence: number
  /** Instant of the wrapping ledger operation. */
  readonly occurredAt: string
}

/** Task overlay created by an atomic start or owner promotion. */
export interface AgentTeamTask {
  readonly taskRef: AgentTeamTaskRef
  readonly projectRef: AgentTeamProjectRef
  readonly threadRef: AgentTeamThreadRef
  readonly status: AgentTeamTaskStatus
  readonly resolution: 'open' | 'accepted' | 'closed'
  /** The current Project owner or Human responsible for progress; defaults to Human on records written before accountability. */
  readonly accountable: AgentTeamMemberId
  /** Immutable discussion Threads from which this Task was derived. In-place promotion has none. */
  readonly sourceThreadRefs: readonly AgentTeamThreadRef[]
}

export type AgentTeamTaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed'

/** Current projection of one collaboration Thread. */
export interface AgentTeamThread {
  readonly threadRef: AgentTeamThreadRef
  /** Present after atomic Task creation or Human promotion; absent on taskless Threads. */
  readonly taskRef?: AgentTeamTaskRef
  /** Last public Message, Claim, or Task-resolution sequence. */
  readonly revision: number
}

/** A Member's current attention period for one Thread. Absence means not following. Read state is compact: all follower-visible facts from `startSequence` through `readThroughSequence` are acknowledged, except sparse direct markers kept separately. */
export interface AgentTeamThreadAttention {
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
  readonly startSequence: number
  readonly readThroughSequence: number
  /** What established this period, so a result can say why the reader follows it instead of guessing. */
  readonly source: AgentTeamAttentionSource
}

/** Identity of one Member × Thread attention period. */
export interface AgentTeamThreadAttentionKey {
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
}

/**
 * Why one Attention period exists. Four are identity actions that establish a
 * default, one is a version-1 rule that no longer applies, and one is the
 * Member's own choice: the difference matters, because only the last is a
 * subscription the Member picked rather than a responsibility it holds. A
 * reopened Task re-establishes its accountable's Attention, so it is the same
 * source as being named accountable rather than a sixth kind.
 */
export type AgentTeamAttentionSource = 'thread-author' | 'claim' | 'accountable' | 'project-owner' | 'mention' | 'self'

/**
 * A Member's current attention period for one Project's Main stream. It is the
 * Main stream's own row, keyed by Member × Project rather than a Thread ref:
 * the Main stream is a conversation of its own outside every Thread, so giving
 * it a synthetic Thread ref would put it in the Thread indexes. Absence means
 * the Main stream's ordinary updates never reach this Member, whoever it is.
 */
export interface AgentTeamMainAttention {
  readonly memberId: AgentTeamMemberId
  readonly projectRef: AgentTeamProjectRef
  readonly startSequence: number
  readonly readThroughSequence: number
  /** What established this period; the Main stream is only ever granted or chosen. */
  readonly source: AgentTeamAttentionSource
}

/** Identity of one Member × Project Main stream attention period. */
export interface AgentTeamMainAttentionKey {
  readonly memberId: AgentTeamMemberId
  readonly projectRef: AgentTeamProjectRef
}

/** Sparse direct-priority marker for one structured Message mention. */
export interface AgentTeamDirectMarker {
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
  readonly messageRef: AgentTeamMessageRef
  readonly sequence: number
}

/** Sparse marker retaining a relevant Task or Claim Activity after Attention ends. */
export interface AgentTeamActivityMarker {
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
  readonly activityRef: AgentTeamActivityRef
  readonly sequence: number
}

/** One immutable Main stream Message: a Project-level conversation entry that belongs to no Thread. Rules version 2 and later only. */
export interface AgentTeamMainMessage {
  readonly messageRef: AgentTeamMessageRef
  readonly projectRef: AgentTeamProjectRef
  readonly scope: 'main'
  readonly sender: AgentTeamMemberId
  readonly body: string
  readonly attachments?: readonly AgentTeamMessageAttachment[] | undefined
  /** The Main stream Message this one answers; a Thread Message is never a valid target. */
  readonly replyToMessageRef?: AgentTeamMessageRef
  readonly sequence: number
  readonly occurredAt: string
}

/** Sparse direct marker for one Main stream Message that mentions or answers a Member. Its own shape: the Thread marker requires a `threadRef`. */
export interface AgentTeamMainMessageMarker {
  readonly memberId: AgentTeamMemberId
  readonly projectRef: AgentTeamProjectRef
  readonly messageRef: AgentTeamMessageRef
  readonly sequence: number
}

/** Sparse marker for one Main stream Activity that concerns a Member. */
export interface AgentTeamMainActivityMarker {
  readonly memberId: AgentTeamMemberId
  readonly projectRef: AgentTeamProjectRef
  readonly activityRef: AgentTeamActivityRef
  readonly sequence: number
}

/** Sparse marker for one published subscription event; every owner of the Project holds one. */
export interface AgentTeamMainEventMarker {
  readonly memberId: AgentTeamMemberId
  readonly projectRef: AgentTeamProjectRef
  readonly eventRef: Branded<'AgentTeamSubscriptionEventRef'>
  readonly sequence: number
}

/** Main stream marker: what a non-owner's Main stream unread consists of, and what an owner keeps on top of the ordinary unread. */
export type AgentTeamMainMarker = AgentTeamMainMessageMarker | AgentTeamMainActivityMarker | AgentTeamMainEventMarker

/** A Host reminder aimed at one Member. It is not a public Thread fact: reading its Task consumes only the recipient's marker. */
export interface AgentTeamReminderMarker {
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
  readonly taskRef: AgentTeamTaskRef
  readonly kind: 'review-backlog' | 'stalled'
  readonly baselineSequence: number
  readonly sequence: number
}

/** Stable identifier of one Member's own time promise. */
export type AgentTeamReminderRef = Branded<'AgentTeamReminderRef'>

/** When a Member reminder fires: one instant, a fixed interval, or a cron expression read in the fixed Team zone (UTC+8). */
export type AgentTeamReminderSchedule =
  | { readonly kind: 'once'; readonly at: string }
  | { readonly kind: 'every'; readonly minutes: number }
  | { readonly kind: 'cron'; readonly expression: string }

/** A time promise one Member makes to itself. It belongs to no Thread and no Project: the creating Member is also its only recipient. */
export interface AgentTeamMemberReminder {
  readonly reminderRef: AgentTeamReminderRef
  readonly memberId: AgentTeamMemberId
  readonly schedule: AgentTeamReminderSchedule
  /** Handed to the Member when an occurrence fires. */
  readonly note: string
  /** `active` waits for its next occurrence, `done` has fired its last (a one-shot), `cancelled` was withdrawn. */
  readonly state: AgentTeamMemberReminderState
  /** Instant the reminder was created, ISO 8601; the first interval occurrence is measured from it. */
  readonly createdAt: string
}

export type AgentTeamMemberReminderState = 'active' | 'done' | 'cancelled'

/** One unconsumed Member reminder occurrence: the private Inbox unread that wakes the Member it belongs to. */
export interface AgentTeamMemberReminderMarker {
  readonly memberId: AgentTeamMemberId
  readonly reminderRef: AgentTeamReminderRef
  /** Sequence of the operation that raised this occurrence. */
  readonly sequence: number
}

/** Durable changes to private Member inbox state carried by one operation. */
export interface AgentTeamInboxDelta {
  readonly attention: {
    /** New or replacement current Attention records. */
    readonly set: readonly AgentTeamThreadAttention[]
    /** Attention periods ended by this operation. */
    readonly removed: readonly AgentTeamThreadAttentionKey[]
  }
  readonly directMarkers: {
    readonly added: readonly AgentTeamDirectMarker[]
    readonly removed: readonly AgentTeamDirectMarker[]
  }
  readonly activityMarkers: {
    readonly added: readonly AgentTeamActivityMarker[]
    readonly removed: readonly AgentTeamActivityMarker[]
  }
  /** Present only when it changes something, so existing deltas keep their stored shape. */
  readonly reminderMarkers?: {
    readonly added: readonly AgentTeamReminderMarker[]
    readonly removed: readonly AgentTeamReminderMarker[]
  }
  /** Present only when it changes something, so every delta written before Member reminders existed keeps its stored bytes. */
  readonly memberReminderMarkers?: {
    readonly added: readonly AgentTeamMemberReminderMarker[]
    readonly removed: readonly AgentTeamMemberReminderMarker[]
  }
  /** Present only when it changes something, so every rules-version-1 delta keeps its stored bytes. */
  readonly mainMarkers?: {
    readonly added: readonly AgentTeamMainMarker[]
    readonly removed: readonly AgentTeamMainMarker[]
  }
  /** Present only when it changes something, so every delta written before Main stream Attention existed keeps its stored bytes. */
  readonly mainAttention?: {
    /** New or replacement current Main stream Attention records. */
    readonly set: readonly AgentTeamMainAttention[]
    /** Main stream Attention periods ended by this operation. */
    readonly removed: readonly AgentTeamMainAttentionKey[]
  }
}

/** One Direction Claim retained as Task progress history. */
export interface AgentTeamClaim {
  readonly claimRef: AgentTeamClaimRef
  readonly taskRef: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly owner: AgentTeamMemberId
  readonly direction: string
  readonly normalizedDirection: string
  readonly state: 'active' | 'done' | 'released'
}

/**
 * What every Thread Activity has: its own identity, the Thread it belongs to,
 * and the Member whose action it records.
 */
interface AgentTeamActivityBase {
  readonly activityRef: AgentTeamActivityRef
  readonly threadRef: AgentTeamThreadRef
  readonly actor: AgentTeamMemberId
  readonly sequence: number
}

export interface AgentTeamClaimActivity extends AgentTeamActivityBase {
  readonly taskRef: AgentTeamTaskRef
  readonly kind: 'claim' | 'done' | 'release'
  readonly claimRef: AgentTeamClaimRef
}

export interface AgentTeamTaskActivity extends AgentTeamActivityBase {
  readonly taskRef: AgentTeamTaskRef
  readonly kind: 'promote' | 'accept' | 'close' | 'reopen' | 'transfer'
  readonly from?: AgentTeamMemberId
  readonly to?: AgentTeamMemberId
  /** Claims atomically released by close; absent for other Task transitions. */
  readonly releasedClaimRefs?: readonly AgentTeamClaimRef[] | undefined
  /** Active claims the Human acceptance completed alongside the Task; absent when none were active. */
  readonly completedClaimRefs?: readonly AgentTeamClaimRef[] | undefined
  /** Every done Claim at acceptance time, including pre-finished ones: the durable discriminator accept markers deliver from. Always present on new accepts (possibly empty); older records keep completed-only wake semantics. */
  readonly acceptedClaimRefs?: readonly AgentTeamClaimRef[] | undefined
  /** Members whose Task Attention reopened. Always present on new reopens (possibly empty); older records keep their marker-only semantics. */
  readonly refollowedMembers?: readonly AgentTeamMemberId[] | undefined
}

/** One automatic, public release summary caused by a membership lifecycle action. */
export interface AgentTeamClaimsReleasedActivity extends AgentTeamActivityBase {
  readonly taskRef: AgentTeamTaskRef
  readonly kind: 'claims_released'
  readonly claimRefs: readonly AgentTeamClaimRef[]
}

/**
 * How one delegated Worker run stands. `running` is the execution record's own
 * state until a terminal fact exists; a read derives `unconfirmed` from a
 * running record no live execution backs any more, and never stores it.
 */
export type AgentTeamWorkerState = 'running' | 'completed' | 'failed' | 'stopped'

/** What one bounded piece of an engine's own record is, so a surface can label it without parsing its text. */
export type AgentTeamWorkerFragmentKind = 'session' | 'turn' | 'failure'

/**
 * Where a Worker run that failed came apart, in the Team's own vocabulary. It is
 * recorded only when the ending was a failure the Host itself classified, and it
 * is what lets a read say "it failed before a native session existed" instead of
 * parsing that claim back out of a sentence.
 */
export type AgentTeamWorkerStage =
  | 'engine-unavailable' // the OAR library is not installed
  | 'installation' // the engine is missing or unauthenticated
  | 'startup' // the engine refused to open a session
  | 'turn' // the session opened and the turn failed
  | 'abort' // interruption was not accepted
  | 'dispose' // the engine did not confirm cleanup

/** The immutable part of one delegated Worker run, written once when it starts. */
export interface AgentTeamWorkerStartRecord {
  readonly workerRef: AgentTeamWorkerRef
  readonly projectRef: AgentTeamProjectRef
  /** The Thread the run reports into; absent on a Project-only delegation. */
  readonly threadRef?: AgentTeamThreadRef | undefined
  readonly taskRef?: AgentTeamTaskRef | undefined
  readonly initiatedBy: AgentTeamMemberId
  readonly engine: import('../worker-settings.ts').WorkerEngine
  /** The task text the Worker was given; the Worker never sees the Member's conversation. */
  readonly task: string
  readonly cwd: string
  readonly startedAt: string
}

/**
 * One delegated Worker run's whole durable record: what was asked, where it
 * ran, and how it ended. It is private to the initiating Member and the Human —
 * no tool or Remote read exposes it — and the Thread holds only the public
 * activity facts that name the run by `workerRef`.
 */
export interface AgentTeamWorkerExecution extends AgentTeamWorkerStartRecord {
  /** `running` until the terminal write lands; a read after a restart derives `unconfirmed` from it without storing it. */
  readonly state: AgentTeamWorkerState
  readonly settledAt?: string | undefined
  /** The engine's own session identity, once one opened. */
  readonly nativeSessionId?: string | undefined
  /** The engine's own identity for the turn this run drove, once one started. */
  readonly nativeTurnId?: string | undefined
  /** The absolute path of the engine's own record for that session: reported by Codex, derived from the cwd Claude reported and the environment the run opened with. */
  readonly nativeStorage?: string | undefined
  /** Where a failed run came apart; absent when it did not fail. */
  readonly stage?: AgentTeamWorkerStage | undefined
  /** The Worker's final answer, text only, bounded when stored; absent when it produced none. */
  readonly output?: string | undefined
  /** Safe failure summary, never a native cause. */
  readonly diagnostic?: string | undefined
}

/** What the terminal write adds to a run's record. */
export interface AgentTeamWorkerSettlement {
  readonly workerRef: AgentTeamWorkerRef
  readonly state: Exclude<AgentTeamWorkerState, 'running'>
  readonly settledAt: string
  /** The engine's own session identity, once one opened. */
  readonly nativeSessionId?: string | undefined
  /** The engine's own identity for the turn this run drove, once one started. */
  readonly nativeTurnId?: string | undefined
  /** The absolute path of the engine's own record for that session: reported by Codex, derived from the cwd Claude reported and the environment the run opened with. */
  readonly nativeStorage?: string | undefined
  /** Where a failed run came apart; absent when it did not fail. */
  readonly stage?: AgentTeamWorkerStage | undefined
  /** The Worker's final answer, text only, bounded when stored; absent when it produced none. */
  readonly output?: string | undefined
  /** Safe failure summary, never a native cause. */
  readonly diagnostic?: string | undefined
}

/**
 * One delegated Worker run that began, as the Thread it belongs to holds it.
 * It carries no state word of its own: "started" is its whole durable meaning,
 * and whether the run is still alive or was left behind by a previous Host is
 * derived when the Thread is read. `taskRef` is absent when the target is a
 * discussion Thread that never had a Task.
 */
export interface AgentTeamWorkerStartedActivity extends AgentTeamActivityBase {
  readonly kind: 'worker_started'
  readonly projectRef: AgentTeamProjectRef
  readonly workerRef: AgentTeamWorkerRef
  readonly engine: import('../worker-settings.ts').WorkerEngine
  readonly taskRef?: AgentTeamTaskRef | undefined
}

/**
 * The terminal fact of one delegated Worker run. What the Worker answered is
 * never public: it stays with the initiator, and this fact says only how the
 * run ended and, for a failure or a stop, a bounded reason.
 */
export interface AgentTeamWorkerSettledActivity extends AgentTeamActivityBase {
  readonly kind: 'worker_settled'
  readonly projectRef: AgentTeamProjectRef
  readonly workerRef: AgentTeamWorkerRef
  readonly engine: import('../worker-settings.ts').WorkerEngine
  readonly taskRef?: AgentTeamTaskRef | undefined
  readonly state: Exclude<AgentTeamWorkerState, 'running'>
  /** Bounded single-line reason a failed or stopped run gives; absent on completion and when the engine gave none. */
  readonly reason?: string | undefined
}

/** One ordered public Thread Activity. */
export type AgentTeamActivity = AgentTeamClaimActivity | AgentTeamTaskActivity | AgentTeamClaimsReleasedActivity
  | AgentTeamWorkerStartedActivity | AgentTeamWorkerSettledActivity

/** One public, revisioned fact in a Thread timeline. */
export type AgentTeamThreadFact =
  | {
    readonly kind: 'message'
    readonly sequence: number
    readonly message: AgentTeamMessage
    /** Structured Member refs from the originating send operation; empty when the Message mentions nobody. */
    readonly mentions: readonly AgentTeamMemberId[]
    readonly replyTo?: AgentTeamMessageReplyContext | undefined
    readonly occurredAt: string
  }
  | { readonly kind: 'activity'; readonly sequence: number; readonly activity: AgentTeamActivity
    readonly occurredAt: string }

/** One fact returned by a durable Thread read. */
export interface AgentTeamThreadReadFact {
  readonly fact: AgentTeamThreadFact
  /** This fact was part of the unread batch advanced by this read. */
  readonly unread: boolean
  /** This fact carries one of the recipient's structured direct mentions. */
  readonly direct: boolean
}

/** Stored form of a Message inside durable operations; pre-occurredAt ledgers omit it and normalize on load. */
export type AgentTeamStoredMessage = Omit<AgentTeamMessage, 'occurredAt'> & { readonly occurredAt?: string | undefined }

/** Stored form of one Thread timeline fact; mirrors AgentTeamThreadFact with stored messages. */
export type AgentTeamStoredThreadFact =
  | { readonly kind: 'message'; readonly sequence: number; readonly message: AgentTeamStoredMessage;
    readonly mentions: readonly AgentTeamMemberId[]
    /** Ledger-operation instant; pre-envelope ledgers omit it and normalize on load. */
    readonly occurredAt?: string | undefined }
  | { readonly kind: 'activity'; readonly sequence: number; readonly activity: AgentTeamActivity
    /** Ledger-operation instant; pre-envelope ledgers omit it and normalize on load. */
    readonly occurredAt?: string | undefined }

/** Stored form of one durable Thread read fact. */
export interface AgentTeamStoredThreadReadFact {
  readonly fact: AgentTeamStoredThreadFact
  readonly unread: boolean
  readonly direct: boolean
}

/** Stable identifier of one Project subscription. */
export type AgentTeamSubscriptionRef = Branded<'AgentTeamSubscriptionRef'>

/** Stable identifier of one published subscription event; it is also the event's Main stream address. */
export type AgentTeamSubscriptionEventRef = Branded<'AgentTeamSubscriptionEventRef'>

/**
 * One Project subscription's durable configuration. The script is a snapshot:
 * the file it was read from is never consulted again, and `revision` moves only
 * on `update`, so a run's identity survives a later edit.
 */
export interface AgentTeamSubscription {
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly projectRef: AgentTeamProjectRef
  readonly name: string
  readonly triggers: import('../subscriptions.ts').SubscriptionTriggers
  readonly script: import('../subscriptions.ts').SubscriptionScriptSnapshot
  /** References only: every value stays in the Harness credential store. */
  readonly credentials: readonly import('../subscriptions.ts').SubscriptionCredential[]
  readonly revision: number
  readonly state: 'active' | 'paused' | 'deleted'
  /** Why it is paused; absent while active, and `'failures'` records an automatic pause. */
  readonly pausedReason?: 'manual' | 'failures' | undefined
  /**
   * Present exactly while this subscription can be posted to from outside. The
   * full address is derived from the Host's public origin and the token a create
   * or reset returned once; nothing durable holds that token in the clear.
   */
  readonly webhook?: import('../subscription-webhook.ts').SubscriptionWebhookArm | undefined
  readonly createdBy: AgentTeamMemberId
  /**
   * The members its published events are for: the only ones whose Inbox the
   * event reaches. An empty set is legal and means the timeline alone keeps the
   * event. Records written before this field existed read it back as
   * `[createdBy]`, which is what the old owner-wide delivery was not.
   */
  readonly notify: readonly AgentTeamMemberId[]
  readonly createdAt: string
}

/** One accepted event: a Ledger fact from the moment its run's output passed validation, published later under the rate limit. */
export interface AgentTeamSubscriptionEventAccepted {
  /** Ledger sequence of the accept operation; the event's identity inside its subscription. */
  readonly acceptedSequence: number
  readonly event: import('../subscriptions.ts').SubscriptionEvent
  /** The revision and script hash the producing run pinned, so a late r1 run never reads as r2. */
  readonly subscriptionRevision: number
  readonly scriptHash: string
  readonly acceptedAt: string
  /** Set once the event was published; its absence is the whole pending queue. */
  readonly publishedSequence?: number | undefined
}

/** A published event as the Main stream holds it: a record type of its own, never a Message. */
export interface AgentTeamSubscriptionEventPublished {
  readonly eventRef: AgentTeamSubscriptionEventRef
  readonly projectRef: AgentTeamProjectRef
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly subscriptionName: string
  readonly event: import('../subscriptions.ts').SubscriptionEvent
  /** The accept operation this event came from. */
  readonly acceptedSequence: number
  /** The publicizing operation, which is also this record's Main stream sequence. */
  readonly sequence: number
  readonly occurredAt: string
}

/** A Project ownership change: the one Main stream Activity that concerns exactly one Member. */
export interface AgentTeamOwnerActivity {
  readonly activityRef: AgentTeamActivityRef
  readonly projectRef: AgentTeamProjectRef
  readonly kind: 'owner-added' | 'owner-removed'
  /** The Agent Member whose ownership changed. */
  readonly memberId: AgentTeamMemberId
  readonly actor: AgentTeamMemberId
  readonly sequence: number
  readonly occurredAt: string
}

/** One subscription lifecycle line in the Main stream, naming the operator who caused it. */
export interface AgentTeamSubscriptionActivity {
  readonly activityRef: AgentTeamActivityRef
  readonly projectRef: AgentTeamProjectRef
  readonly kind: 'subscription-created' | 'subscription-updated' | 'subscription-paused' | 'subscription-resumed' | 'subscription-deleted'
    | 'subscription-webhook-reset'
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly subscriptionName: string
  /** The revision this line describes. */
  readonly revision: number
  /** Why a pause happened; absent on every other kind. */
  readonly reason?: 'manual' | 'failures' | undefined
  /** Who did it; absent only when the Host paused the subscription itself after repeated failures. */
  readonly actor?: AgentTeamMemberId | undefined
  readonly sequence: number
  readonly occurredAt: string
}

/** One Main stream Activity: an ownership change, or a subscription lifecycle line. */
export type AgentTeamMainActivity = AgentTeamOwnerActivity | AgentTeamSubscriptionActivity
