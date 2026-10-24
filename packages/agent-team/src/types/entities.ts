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

/** Stable identifier of one Claim. */
export type AgentTeamClaimRef = Branded<'AgentTeamClaimRef'>

/** Stable identifier of one public Thread Activity. */
export type AgentTeamActivityRef = Branded<'AgentTeamActivityRef'>

/** Opaque, restorable reference to one completed-turn context checkpoint in a Member's private Session lineage. The ref is the selection authority; the name is display only. */
export type AgentTeamContextCheckpointRef = Branded<'AgentTeamContextCheckpointRef'>

/** Process-local one-use authorization for one Human invitation. */
export type AgentTeamConfirmationToken = Branded<'AgentTeamConfirmationToken'>

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

/** The Host acting on a Member's Session, never a business actor. Automatic Session recycling is the only user: the model neither asked for nor could refuse it, so Human or Member authority would misattribute it. */
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
  /** Opening-line gist distinguishing one Thread chip from another: first line, trimmed, capped at 40 characters. */
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
  /** Body gist for the quote block: first line, trimmed, capped at 120 characters. */
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

/** Task overlay created by an atomic start or Human promotion. */
export interface AgentTeamTask {
  readonly taskRef: AgentTeamTaskRef
  readonly projectRef: AgentTeamProjectRef
  readonly threadRef: AgentTeamThreadRef
  readonly status: AgentTeamTaskStatus
  readonly resolution: 'open' | 'accepted' | 'closed'
}

export type AgentTeamTaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed'

/** The two statuses a live Claim keeps a Task in — the only ones a live-work surface lists. */
export type AgentTeamLiveTaskStatus = Extract<AgentTeamTaskStatus, 'in_progress' | 'in_review'>

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
}

/** Identity of one Member × Thread attention period. */
export interface AgentTeamThreadAttentionKey {
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
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

/** Project-level change shown in the Main stream: a Human grant or withdrawal of Project ownership. Rules version 2 and later only. */
export interface AgentTeamMainActivity {
  readonly activityRef: AgentTeamActivityRef
  readonly projectRef: AgentTeamProjectRef
  readonly kind: 'owner-added' | 'owner-removed'
  /** The Agent Member whose ownership changed. */
  readonly memberId: AgentTeamMemberId
  readonly actor: AgentTeamMemberId
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

/** Main stream marker: what a non-owner's Main stream unread consists of, and what an owner keeps on top of the ordinary unread. */
export type AgentTeamMainMarker = AgentTeamMainMessageMarker | AgentTeamMainActivityMarker

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
  /** Present only when it changes something, so every rules-version-1 delta keeps its stored bytes. */
  readonly mainMarkers?: {
    readonly added: readonly AgentTeamMainMarker[]
    readonly removed: readonly AgentTeamMainMarker[]
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

interface AgentTeamActivityBase {
  readonly activityRef: AgentTeamActivityRef
  readonly taskRef: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly actor: AgentTeamMemberId
  readonly sequence: number
}

export interface AgentTeamClaimActivity extends AgentTeamActivityBase {
  readonly kind: 'claim' | 'done' | 'release'
  readonly claimRef: AgentTeamClaimRef
}

export interface AgentTeamTaskActivity extends AgentTeamActivityBase {
  readonly kind: 'promote' | 'accept' | 'close' | 'reopen'
  /** Claims atomically released by close; absent for other Task transitions. */
  readonly releasedClaimRefs?: readonly AgentTeamClaimRef[] | undefined
  /** Active claims the Human acceptance completed alongside the Task; absent when none were active. */
  readonly completedClaimRefs?: readonly AgentTeamClaimRef[] | undefined
  /** Every done Claim at acceptance time, including pre-finished ones: the durable discriminator accept markers deliver from. Always present on new accepts (possibly empty); older records keep completed-only wake semantics. */
  readonly acceptedClaimRefs?: readonly AgentTeamClaimRef[] | undefined
}

/** One automatic, public release summary caused by a membership lifecycle action. */
export interface AgentTeamClaimsReleasedActivity extends AgentTeamActivityBase {
  readonly kind: 'claims_released'
  readonly claimRefs: readonly AgentTeamClaimRef[]
}

/** One ordered public Thread Activity. */
export type AgentTeamActivity = AgentTeamClaimActivity | AgentTeamTaskActivity | AgentTeamClaimsReleasedActivity

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

