import type { SessionId, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session"
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type {
  AgentTeamAgentMember,
  AgentTeamProject,
  AgentTeamProjectRef,
  AgentTeamContextCheckpointRef,
  AgentTeamHostActor,
  AgentTeamOperationBase,
  AgentTeamClaim,
  AgentTeamClaimActivity,
  AgentTeamClaimsReleasedActivity,
  AgentTeamInboxDelta,
  AgentTeamMainActivity,
  AgentTeamMainMessage,
  AgentTeamMemberId,
  AgentTeamMessage,
  AgentTeamStoredMessage,
  AgentTeamStoredThreadReadFact,
  AgentTeamTask,
  AgentTeamTaskActivity,
  AgentTeamTaskRef,
  AgentTeamThread,
  AgentTeamThreadAttention,
  AgentTeamThreadRef,
} from "./entities.ts"

/** The first durable operation in every Agent Team ledger. */
export interface AgentTeamInitializedOperation extends AgentTeamOperationBase {
  readonly previousOperationId: null
  readonly kind: 'team/initialized'
  readonly data: {
    readonly humanMemberId: AgentTeamMemberId
  }
}

/** Durable creation of one Project with its atomic initial memberships. */
export interface AgentTeamProjectCreatedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/project-created'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly project: AgentTeamProject
    readonly memberIds: readonly AgentTeamMemberId[]
  }
}

/** Durable Agent Member creation with optional initial Project memberships. */
export interface AgentTeamMemberAddedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-added'
  readonly data: {
    readonly member: AgentTeamAgentMember
    readonly projectRefs: readonly AgentTeamProjectRef[]
  }
}

/** Durable suspension of one existing Agent Member. */
export interface AgentTeamMemberSuspendedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-suspended'
  readonly data: { readonly member: AgentTeamAgentMember }
}

/** Durable re-enablement of one suspended Agent Member. */
export interface AgentTeamMemberResumedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-resumed'
  readonly data: { readonly member: AgentTeamAgentMember }
}

/** Departure facts every releasing operation persists: released Claims, public release Activities, touched Tasks and Threads, and the consumed Inbox delta. Replay recomputes the projection from these alone. */
export interface AgentTeamReleaseSnapshot {
  /** Claims released by this operation. */
  readonly claims: readonly AgentTeamClaim[]
  /** Public release summaries for the affected Threads. */
  readonly activities: readonly AgentTeamClaimsReleasedActivity[]
  readonly tasks: readonly AgentTeamTask[]
  readonly threads: readonly AgentTeamThread[]
  readonly inbox: AgentTeamInboxDelta
}

/** Durable archival of one Agent Member: the Member leaves every surface while its Session log and private memory stay recoverable. */
export interface AgentTeamMemberArchivedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-archived'
  readonly data: { readonly member: AgentTeamAgentMember } & AgentTeamReleaseSnapshot
}

/** Audit record of one in-place Member session restart; no projection change (the Member keeps identity, transcript, and memory), so apply() treats it as a marker. */
export interface AgentTeamMemberSessionRestartedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-session-restarted'
  readonly data: { readonly member: AgentTeamAgentMember }
}

/** Legacy audit record of an in-place Member context clear (current flow: `team/member-session-renewed`). Never written; kept so existing ledgers replay. Projection state is unchanged, so apply() treats it as a marker. */
export interface AgentTeamMemberContextClearedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-context-cleared'
  readonly data: { readonly member: AgentTeamAgentMember }
}

/** Durable transition of one Member onto a fresh Session: identity, memory, and binding are kept while sessionId moves to a new Session starting from an empty context. The previous log stays on disk (archived from grouping surfaces) and the new header records it as fork lineage. */
export interface AgentTeamMemberSessionRenewedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-session-renewed'
  readonly data: {
    readonly member: AgentTeamAgentMember
    /** The Session the Member ran on before this renewal. */
    readonly previousSessionId: SessionId
  }
}

/** Durable model-initiated rollover of one Member onto its next context generation. The actor is the calling Member; the Host executes. The data records only the verifiable envelope (session anchors, handoff tool-result sequence, trigger); the handoff prose stays in the Member's Session log. */
export interface AgentTeamMemberSessionRolledOverOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-session-rolled-over'
  readonly data: {
    readonly member: AgentTeamAgentMember
    /** The Session the Member ran on before this rollover. */
    readonly previousSessionId: SessionId
    /** The fresh or seeded Session the Member transitions onto. */
    readonly newSessionId: SessionId
    /** The Session a checkpoint return was seeded from; absent on a fresh rollover, where the new Session inherits no prefix and its lineage parent is the previous active Session. */
    readonly sourceSessionId?: SessionId
    readonly sourceThroughSeq?: SessionLogOffset
    readonly handoffEventSeq: SessionSeq
    readonly checkpointRef?: AgentTeamContextCheckpointRef
    readonly trigger: 'model' | 'pressure'
  }
}

/** Durable Host-initiated recycling of one Member's Session: the Host judged a live generation cold enough to replace before delivering the waking message. Records the old log offset from which unanswered input is replayed; no handoff prose or checkpoint lineage is copied. */
export interface AgentTeamMemberSessionRecycledOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-session-recycled'
  readonly actor: AgentTeamHostActor
  readonly data: {
    readonly member: AgentTeamAgentMember
    readonly previousSessionId: SessionId
    readonly newSessionId: SessionId
    readonly inputFromSeq?: SessionLogOffset
  }
}

/**
 * The ledger switches to a later set of validation rules from this record on. Records before it keep validating under the rules
 * they were written with; a ledger with no marker is rules version 1.
 */
export interface AgentTeamRulesVersionAdoptedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/rules-version-adopted'
  readonly actor: AgentTeamHostActor
  readonly data: { readonly version: number }
}

/** Durable Human grant of Project ownership to one Agent Member; the Human owns every Project and is never recorded. Rules version 2 and later only. The Main stream Activity tells the other owners and gives the new owner a Main stream marker. */
export interface AgentTeamProjectOwnerAddedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/project-owner-added'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly memberId: AgentTeamMemberId
    readonly activity: AgentTeamMainActivity
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Durable Human withdrawal of one Agent Member's Project ownership. Rules version 2 and later only. The removed Agent stays a Project member and gets a Main stream marker. */
export interface AgentTeamProjectOwnerRemovedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/project-owner-removed'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly memberId: AgentTeamMemberId
    readonly activity: AgentTeamMainActivity
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Durable Human rename of one Project's display facts; identity refs never change. */
export interface AgentTeamProjectUpdatedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/project-updated'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly project: AgentTeamProject
  }
}

/** Durable Human edit of one Member's mutable facts (handle, description, model). */
export interface AgentTeamMemberUpdatedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-updated'
  readonly data: { readonly member: AgentTeamAgentMember }
}

/** Durable addition of one Agent Member to one Project. */
export interface AgentTeamProjectMemberAddedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/project-member-added'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly memberId: AgentTeamMemberId
  }
}

/** Durable removal of one Agent Member from one Project and Project-scoped cleanup. */
export interface AgentTeamProjectMemberRemovedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/project-member-removed'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly memberId: AgentTeamMemberId
  } & AgentTeamReleaseSnapshot
}

/** Durable addition of one Workspace to a Member's participation set. Participation is a pure relation with no Session or execution semantics: the Member's Session stays rooted in its default Workspace (`member.workspaceId`, fixed at creation) and joined-Workspace collaboration is ledger work addressed by workspaceId. */
export interface AgentTeamMemberWorkspaceJoinedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-workspace-joined'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly memberId: AgentTeamMemberId
  }
}

/** Durable withdrawal of one non-default Workspace participation. Identity, Session, and other participations survive. Active Claims on the Workspace's Threads release with public Activities and the Member's Attention and markers for them clear, so no Task stays stuck in progress and no phantom unread remains. */
export interface AgentTeamMemberWorkspaceLeftOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-workspace-left'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly memberId: AgentTeamMemberId
  } & AgentTeamReleaseSnapshot
}

/** Durable archival of one Project: it and its Threads leave every surface while facts stay recoverable. Every active Claim on its Threads releases (any owner) and affected Members' Attention and markers clear, so no Task stays stuck in progress and no phantom unread remains. */
export interface AgentTeamProjectArchivedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/project-archived'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly project: AgentTeamProject
  } & AgentTeamReleaseSnapshot
}

/** Durable top-level Message, Thread, optional Task, and initial inbox facts. */
export interface AgentTeamMessageSentOperation extends AgentTeamOperationBase {
  readonly kind: 'team/message-sent'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly mentions: readonly AgentTeamMemberId[]
    readonly message: AgentTeamMessage
    readonly task?: AgentTeamTask
    readonly thread: AgentTeamThread
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Durable existing-Thread reply and any invitation/direct-mention facts. */
export interface AgentTeamThreadRepliedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/thread-replied'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly baseRevision: number
    readonly mentions: readonly AgentTeamMemberId[]
    readonly message: AgentTeamMessage
    readonly task?: AgentTeamTask
    readonly thread: AgentTeamThread
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Durable Human promotion of a taskless Thread into a real Task, announced by a structured Task activity. */
export interface AgentTeamThreadPromotedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/thread-promoted'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly baseRevision: number
    readonly activity: AgentTeamTaskActivity
    readonly task: AgentTeamTask
    readonly thread: AgentTeamThread
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Durable Main stream Message from a Project member and the Main stream markers it delivers. Rules version 2 and later only. */
export interface AgentTeamMainMessagePostedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/main-message-posted'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly mentions: readonly AgentTeamMemberId[]
    readonly message: AgentTeamMainMessage
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Durable Main stream read: the watermark an owner advances to and the markers consumed. Everything else is derived. Rules version 2 and later only. */
export interface AgentTeamMainStreamReadOperation extends AgentTeamOperationBase {
  readonly kind: 'team/main-stream-read'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly memberId: AgentTeamMemberId
    readonly readThroughSequence: number
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Durable Project-owner start of a discussion or Task: anchor Message, Thread, optional Task, and the creator's Attention. Replaces `team/message-sent` from rules version 2. */
export interface AgentTeamThreadStartedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/thread-started'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly kind: 'discussion' | 'task'
    readonly mentions: readonly AgentTeamMemberId[]
    readonly anchor: AgentTeamMessage
    readonly task?: AgentTeamTask
    readonly thread: AgentTeamThread
    readonly inbox: AgentTeamInboxDelta
  }
}

export interface AgentTeamClaimOperationData {
  readonly workspaceId: WorkspaceId
  readonly baseRevision: number
  readonly activity: AgentTeamClaimActivity
  readonly claim: AgentTeamClaim
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly inbox: AgentTeamInboxDelta
}

export interface AgentTeamClaimCreatedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/claim-created'
  readonly data: AgentTeamClaimOperationData
}

export interface AgentTeamClaimDoneOperation extends AgentTeamOperationBase {
  readonly kind: 'team/claim-done'
  readonly data: AgentTeamClaimOperationData
}

export interface AgentTeamClaimReleasedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/claim-released'
  readonly data: AgentTeamClaimOperationData
}

export type AgentTeamClaimChangedOperation =
  | AgentTeamClaimCreatedOperation
  | AgentTeamClaimDoneOperation
  | AgentTeamClaimReleasedOperation

/** Durable Human Task-resolution change. */
export interface AgentTeamTaskChangedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/task-changed'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly baseRevision: number
    readonly activity: AgentTeamTaskActivity
    readonly task: AgentTeamTask
    readonly thread: AgentTeamThread
    readonly claims: readonly AgentTeamClaim[]
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Durable personal Attention follow or unfollow; it does not revise the Thread. */
export interface AgentTeamThreadAttentionChangedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/thread-attention-changed'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly action: 'follow' | 'unfollow'
    readonly memberId: AgentTeamMemberId
    readonly task?: AgentTeamTask
    readonly thread: AgentTeamThread
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Durable content of one Thread read: the watermark advanced to and the Inbox delta consumed. Everything else the read answered with is derived from the projection at read time and on replay. */
export interface AgentTeamThreadReadReceipt {
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
  readonly threadRef: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef | undefined
  readonly readThroughSequence: number
  readonly inbox: AgentTeamInboxDelta
}

export interface AgentTeamThreadReadSnapshot {
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
  readonly task?: AgentTeamTask | undefined
  readonly thread: AgentTeamThread
  readonly claims: readonly AgentTeamClaim[]
  readonly anchor: AgentTeamStoredMessage
  /** Structured Member refs of the anchor Message, from its originating send operation. */
  readonly anchorMentions: readonly AgentTeamMemberId[]
  readonly facts: readonly AgentTeamStoredThreadReadFact[]
  readonly readThroughSequence: number
  readonly remainingUnreadCount: number
  readonly attention?: AgentTeamThreadAttention | undefined
  readonly inbox: AgentTeamInboxDelta
}

/** Both durable Thread-read forms: the receipt every new read writes, and the legacy snapshot. */
export type AgentTeamThreadReadData = AgentTeamThreadReadReceipt | AgentTeamThreadReadSnapshot

/** Durable one-batch read and direct-marker consumption. It does not revise the Thread. */
export interface AgentTeamThreadReadOperation extends AgentTeamOperationBase {
  readonly kind: 'team/thread-read'
  readonly data: AgentTeamThreadReadData
}

/** Durable irreversible Member removal and global inbox cleanup. */
export interface AgentTeamMemberRemovedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-removed'
  readonly data: { readonly member: AgentTeamAgentMember } & AgentTeamReleaseSnapshot
}

/** Durable audit record of one Member-to-Member direct message. A DM is pure delivery: no Project/Thread/revision, Inbox attention, or markers. The ledger keeps it for audit, idempotent retries, and post-compaction traceability; the wake is a transient runtime effect. */
export interface AgentTeamDmSentOperation extends AgentTeamOperationBase {
  readonly kind: 'team/dm-sent'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly senderMemberId: AgentTeamMemberId
    readonly recipientMemberId: AgentTeamMemberId
    readonly body: string
  }
}

/** Closed union of durable Agent Team operations. */
export type AgentTeamOperation =
  | AgentTeamInitializedOperation
  | AgentTeamProjectCreatedOperation
  | AgentTeamMemberAddedOperation
  | AgentTeamMemberSuspendedOperation
  | AgentTeamMemberResumedOperation
  | AgentTeamMemberArchivedOperation
  | AgentTeamMemberSessionRestartedOperation
  | AgentTeamMemberContextClearedOperation
  | AgentTeamMemberSessionRenewedOperation
  | AgentTeamMemberSessionRolledOverOperation
  | AgentTeamMemberSessionRecycledOperation
  | AgentTeamRulesVersionAdoptedOperation
  | AgentTeamProjectOwnerAddedOperation
  | AgentTeamProjectOwnerRemovedOperation
  | AgentTeamProjectUpdatedOperation
  | AgentTeamMemberUpdatedOperation
  | AgentTeamProjectMemberAddedOperation
  | AgentTeamProjectMemberRemovedOperation
  | AgentTeamMemberWorkspaceJoinedOperation
  | AgentTeamMemberWorkspaceLeftOperation
  | AgentTeamProjectArchivedOperation
  | AgentTeamMessageSentOperation
  | AgentTeamThreadRepliedOperation
  | AgentTeamMainMessagePostedOperation
  | AgentTeamMainStreamReadOperation
  | AgentTeamThreadStartedOperation
  | AgentTeamThreadPromotedOperation
  | AgentTeamClaimCreatedOperation
  | AgentTeamClaimDoneOperation
  | AgentTeamClaimReleasedOperation
  | AgentTeamTaskChangedOperation
  | AgentTeamThreadAttentionChangedOperation
  | AgentTeamThreadReadOperation
  | AgentTeamMemberRemovedOperation
  | AgentTeamDmSentOperation

