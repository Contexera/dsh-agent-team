import type { SessionId, SessionLogOffset, SessionSeq } from "@deepseek-ai/dsh-session"
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type {
  AgentTeamAgentMember,
  AgentTeamChannel,
  AgentTeamChannelRef,
  AgentTeamContextCheckpointRef,
  AgentTeamHostActor,
  AgentTeamOperationBase,
  AgentTeamClaim,
  AgentTeamClaimActivity,
  AgentTeamClaimsReleasedActivity,
  AgentTeamInboxDelta,
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

/** Durable creation of one Channel with its atomic initial memberships. */
export interface AgentTeamChannelCreatedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/channel-created'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly channel: AgentTeamChannel
    readonly memberIds: readonly AgentTeamMemberId[]
  }
}

/** Durable Agent Member creation with optional initial Channel memberships. */
export interface AgentTeamMemberAddedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-added'
  readonly data: {
    readonly member: AgentTeamAgentMember
    readonly channelRefs: readonly AgentTeamChannelRef[]
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

/** Durable Human rename of one Channel's display facts; identity refs never change. */
export interface AgentTeamChannelUpdatedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/channel-updated'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly channel: AgentTeamChannel
  }
}

/** Durable Human edit of one Member's mutable facts (handle, description, model). */
export interface AgentTeamMemberUpdatedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-updated'
  readonly data: { readonly member: AgentTeamAgentMember }
}

/** Durable addition of one Agent Member to one Channel. */
export interface AgentTeamChannelMemberAddedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/channel-member-added'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly channelRef: AgentTeamChannelRef
    readonly memberId: AgentTeamMemberId
  }
}

/** Durable removal of one Agent Member from one Channel and Channel-scoped cleanup. */
export interface AgentTeamChannelMemberRemovedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/channel-member-removed'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly channelRef: AgentTeamChannelRef
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

/** Durable archival of one Channel: it and its Threads leave every surface while facts stay recoverable. Every active Claim on its Threads releases (any owner) and affected Members' Attention and markers clear, so no Task stays stuck in progress and no phantom unread remains. */
export interface AgentTeamChannelArchivedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/channel-archived'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly channel: AgentTeamChannel
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

/** Durable audit record of one Member-to-Member direct message. A DM is pure delivery: no Channel/Thread/revision, Inbox attention, or markers. The ledger keeps it for audit, idempotent retries, and post-compaction traceability; the wake is a transient runtime effect. */
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
  | AgentTeamChannelCreatedOperation
  | AgentTeamMemberAddedOperation
  | AgentTeamMemberSuspendedOperation
  | AgentTeamMemberResumedOperation
  | AgentTeamMemberArchivedOperation
  | AgentTeamMemberSessionRestartedOperation
  | AgentTeamMemberContextClearedOperation
  | AgentTeamMemberSessionRenewedOperation
  | AgentTeamMemberSessionRolledOverOperation
  | AgentTeamMemberSessionRecycledOperation
  | AgentTeamChannelUpdatedOperation
  | AgentTeamMemberUpdatedOperation
  | AgentTeamChannelMemberAddedOperation
  | AgentTeamChannelMemberRemovedOperation
  | AgentTeamMemberWorkspaceJoinedOperation
  | AgentTeamMemberWorkspaceLeftOperation
  | AgentTeamChannelArchivedOperation
  | AgentTeamMessageSentOperation
  | AgentTeamThreadRepliedOperation
  | AgentTeamThreadPromotedOperation
  | AgentTeamClaimCreatedOperation
  | AgentTeamClaimDoneOperation
  | AgentTeamClaimReleasedOperation
  | AgentTeamTaskChangedOperation
  | AgentTeamThreadAttentionChangedOperation
  | AgentTeamThreadReadOperation
  | AgentTeamMemberRemovedOperation
  | AgentTeamDmSentOperation

