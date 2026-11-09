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
  AgentTeamMemberReminder,
  AgentTeamMessage,
  AgentTeamStoredMessage,
  AgentTeamStoredThreadReadFact,
  AgentTeamTask,
  AgentTeamTaskActivity,
  AgentTeamTaskRef,
  AgentTeamThread,
  AgentTeamThreadAttention,
  AgentTeamThreadRef,
  AgentTeamWorkerRef,
  AgentTeamWorkerSettledActivity,
  AgentTeamWorkerStartedActivity,
  AgentTeamWorkerStartRecord,
  AgentTeamWorkerSettlement,
  AgentTeamSubscription,
  AgentTeamSubscriptionActivity,
  AgentTeamSubscriptionRef,
  AgentTeamOwnerActivity,
  AgentTeamReminderRef,
} from "./entities.ts"
import type { AgentTeamCreateSubscriptionRequestIntent, AgentTeamSubscriptionRequestIntent } from "./requests-results.ts"
import type { SubscriptionEvent } from "../subscriptions.ts"

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
  /** Open Tasks whose former accountable returned to the Human. */
  readonly transfers: readonly AgentTeamTaskActivity[]
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
    readonly activity: AgentTeamOwnerActivity
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
    readonly activity: AgentTeamOwnerActivity
    readonly inbox: AgentTeamInboxDelta
    readonly transfers: readonly AgentTeamTaskActivity[]
    readonly tasks: readonly AgentTeamTask[]
    readonly threads: readonly AgentTeamThread[]
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
    readonly activity?: AgentTeamTaskActivity
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

/** Durable transfer of Task responsibility; execution Claims are unchanged. */
export interface AgentTeamTaskAccountableChangedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/task-accountable-changed'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly baseRevision: number
    readonly activity: AgentTeamTaskActivity
    readonly task: AgentTeamTask
    readonly thread: AgentTeamThread
    readonly inbox: AgentTeamInboxDelta
  }
}

/** One private, durable Task reminder. The complete episode stays for replay and deduplication after its Inbox marker is read. */
export interface AgentTeamReminderRaisedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/reminder-raised'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly taskRef: AgentTeamTaskRef
    readonly kind: 'review-backlog' | 'stalled'
    readonly recipient: AgentTeamMemberId
    readonly baselineSequence: number
    readonly inbox: AgentTeamInboxDelta
  }
}

/** A Member's own time promise, created for and by that Member alone. It carries no Inbox delta: nothing is unread until an occurrence fires. */
export interface AgentTeamMemberReminderCreatedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-reminder-created'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly reminder: AgentTeamMemberReminder
  }
}

/**
 * One occurrence of a Member reminder, raised by the Host when it comes due. The
 * marker it adds is the private Inbox unread; a marker it removes is the
 * previous occurrence of the same reminder, which this one replaces rather than
 * stacks on.
 */
export interface AgentTeamMemberReminderRaisedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-reminder-raised'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly memberId: AgentTeamMemberId
    readonly reminderRef: AgentTeamReminderRef
    /** Instant this occurrence was raised at, ISO 8601. */
    readonly scheduledAt: string
    readonly inbox: AgentTeamInboxDelta
  }
}

/** The occurrence reached the Member's context, so its private Inbox marker is consumed. */
export interface AgentTeamMemberReminderConsumedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-reminder-consumed'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly memberId: AgentTeamMemberId
    readonly reminderRef: AgentTeamReminderRef
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Withdrawal by the Member that owns the reminder, or by the Human on its behalf. */
export interface AgentTeamMemberReminderCancelledOperation extends AgentTeamOperationBase {
  readonly kind: 'team/member-reminder-cancelled'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly memberId: AgentTeamMemberId
    readonly reminderRef: AgentTeamReminderRef
    readonly reminder: AgentTeamMemberReminder
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

/** Durable personal Attention follow or unfollow on one Project's Main stream; it revises nothing. */
export interface AgentTeamMainAttentionChangedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/main-attention-changed'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly action: 'follow' | 'unfollow'
    readonly memberId: AgentTeamMemberId
    readonly project: AgentTeamProject
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
  /**
   * The Host-selected prefix bound this read acknowledged, when the caller
   * bounded one. It is not the watermark: replay re-derives the acknowledged
   * batch from the projection plus this bound. Absent means the default batch,
   * which also keeps every older receipt's meaning.
   */
  readonly selectedThroughSequence?: number | undefined
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

/**
 * Durable start of one delegated Worker run, recorded before a native process
 * exists. `threadRef`/`taskRef` are the target binding fixed for the whole run:
 * a later page, directory, Membership change, or Task transfer never moves it.
 * `activity` is present exactly when the binding names a Thread, and is the
 * public fact that Thread holds; the rest of the record is private to the
 * initiating Member and the Human.
 */
export interface AgentTeamWorkerStartedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/worker-started'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly execution: AgentTeamWorkerStartRecord
    readonly activity?: AgentTeamWorkerStartedActivity | undefined
  }
}

/**
 * The one terminal record of a delegated Worker run. It commits at most once
 * per run: the write is keyed on the run, so a repeated callback resolves the
 * same record instead of writing a second ending. `activity` is the Thread's
 * public fact when the run is Thread-bound, and `inbox` holds the initiator's
 * marker pointing at exactly that fact — never the whole Thread's unread.
 */
export interface AgentTeamWorkerSettledOperation extends AgentTeamOperationBase {
  readonly kind: 'team/worker-settled'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly execution: AgentTeamWorkerSettlement
    readonly activity?: AgentTeamWorkerSettledActivity | undefined
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Durable creation of one Project subscription, with the Main stream line that announces it. */
export interface AgentTeamSubscriptionCreatedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/subscription-created'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly subscription: AgentTeamSubscription
    readonly activity: AgentTeamSubscriptionActivity
    /** The trial run's ids this subscription must never publish; empty means "ignore that history". */
    readonly baselineIds: readonly string[]
    /** Absent on operations written before request replays carried their source and baseline intent. */
    readonly request?: AgentTeamCreateSubscriptionRequestIntent | undefined
  }
}

/** Durable configuration change; the revision it moved from and the line that announces it. */
export interface AgentTeamSubscriptionUpdatedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/subscription-updated'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly subscription: AgentTeamSubscription
    readonly previousRevision: number
    readonly activity: AgentTeamSubscriptionActivity
    /** Absent on operations written before request replays carried their source and trigger intent. */
    readonly request?: AgentTeamSubscriptionRequestIntent | undefined
  }
}

/** Manual or automatic pause. The revision does not move: this is a state transition, not an edit. */
export interface AgentTeamSubscriptionPausedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/subscription-paused'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly subscription: AgentTeamSubscription
    readonly activity: AgentTeamSubscriptionActivity
    /**
     * Present when the Host paused the subscription itself: one Main stream
     * marker per owner, so the pause reaches them even unfollowed.
     */
    readonly inbox?: AgentTeamInboxDelta | undefined
  }
}

/** Resume after a passing trial run; the revision does not move. */
export interface AgentTeamSubscriptionResumedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/subscription-resumed'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly subscription: AgentTeamSubscription
    readonly activity: AgentTeamSubscriptionActivity
  }
}

/** Terminal state. Delete is the barrier: nothing accepted, published, or run afterwards revives it. */
export interface AgentTeamSubscriptionDeletedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/subscription-deleted'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly subscription: AgentTeamSubscription
    readonly activity: AgentTeamSubscriptionActivity
  }
}

/**
 * A new webhook address under the same subscription: the token is replaced and
 * the generation moves by one, while the revision does not. Deliveries already
 * accepted stay in their queue; only the old address stops meaning anything.
 */
export interface AgentTeamSubscriptionWebhookResetOperation extends AgentTeamOperationBase {
  readonly kind: 'team/subscription-webhook-reset'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly subscription: AgentTeamSubscription
    /** The generation this reset replaced, so a replay can prove the move is exactly one. */
    readonly previousGeneration: number
    readonly activity: AgentTeamSubscriptionActivity
  }
}

/** Append-only deduplication waterline: the ids this subscription must never publish again. */
export interface AgentTeamSubscriptionBaselineOperation extends AgentTeamOperationBase {
  readonly kind: 'team/subscription-baseline'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly subscriptionRef: AgentTeamSubscriptionRef
    readonly ids: readonly string[]
  }
}

/** One run's validated output, accepted as durable facts before any of it is published. */
export interface AgentTeamSubscriptionEventsAcceptedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/subscription-events-accepted'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly subscriptionRef: AgentTeamSubscriptionRef
    /** The version the producing run pinned; a run that crossed an update keeps its own. */
    readonly subscriptionRevision: number
    readonly scriptHash: string
    readonly events: readonly SubscriptionEvent[]
  }
}

/** One accepted event published to the Main stream, with the frozen recipient markers of that moment. */
export interface AgentTeamSubscriptionEventPublishedOperation extends AgentTeamOperationBase {
  readonly kind: 'team/subscription-event-published'
  readonly data: {
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly subscriptionRef: AgentTeamSubscriptionRef
    /** The subscription's name when this event was published; a later rename does not rewrite history. */
    readonly subscriptionName: string
    /** The accepting operation, and which of its events this is: the accept record is the content authority. */
    readonly acceptedSequence: number
    readonly eventId: string
    readonly inbox: AgentTeamInboxDelta
  }
}

/** Every subscription record: its lifecycle writes, the deduplication waterline, and event acceptance/publication. */
export type AgentTeamSubscriptionOperation =
  | AgentTeamSubscriptionCreatedOperation
  | AgentTeamSubscriptionUpdatedOperation
  | AgentTeamSubscriptionPausedOperation
  | AgentTeamSubscriptionResumedOperation
  | AgentTeamSubscriptionDeletedOperation
  | AgentTeamSubscriptionBaselineOperation
  | AgentTeamSubscriptionEventsAcceptedOperation
  | AgentTeamSubscriptionEventPublishedOperation
  | AgentTeamSubscriptionWebhookResetOperation

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
  | AgentTeamTaskAccountableChangedOperation
  | AgentTeamThreadAttentionChangedOperation
  | AgentTeamMainAttentionChangedOperation
  | AgentTeamThreadReadOperation
  | AgentTeamReminderRaisedOperation
  | AgentTeamMemberReminderCreatedOperation
  | AgentTeamMemberReminderRaisedOperation
  | AgentTeamMemberReminderConsumedOperation
  | AgentTeamMemberReminderCancelledOperation
  | AgentTeamMemberRemovedOperation
  | AgentTeamDmSentOperation
  | AgentTeamWorkerStartedOperation
  | AgentTeamWorkerSettledOperation
  | AgentTeamSubscriptionCreatedOperation
  | AgentTeamSubscriptionUpdatedOperation
  | AgentTeamSubscriptionPausedOperation
  | AgentTeamSubscriptionResumedOperation
  | AgentTeamSubscriptionDeletedOperation
  | AgentTeamSubscriptionBaselineOperation
  | AgentTeamSubscriptionEventsAcceptedOperation
  | AgentTeamSubscriptionEventPublishedOperation
  | AgentTeamSubscriptionWebhookResetOperation
