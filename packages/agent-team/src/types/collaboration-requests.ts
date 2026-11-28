/** Remote contracts for threads, the main stream, tasks, claims, attention, reminders and the Inbox. */
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type {
  AgentTeamAgentMember,
  AgentTeamAttachmentId,
  AgentTeamClaim,
  AgentTeamClaimActivity,
  AgentTeamClaimRef,
  AgentTeamDirectMarker,
  AgentTeamHumanActor,
  AgentTeamMainActivity,
  AgentTeamMainAttention,
  AgentTeamMainMarker,
  AgentTeamMainMessage,
  AgentTeamMemberActor,
  AgentTeamMemberId,
  AgentTeamMemberReminder,
  AgentTeamMessage,
  AgentTeamMessageRef,
  AgentTeamMessageReplyContext,
  AgentTeamProject,
  AgentTeamProjectRef,
  AgentTeamReminderRef,
  AgentTeamReminderSchedule,
  AgentTeamRequestId,
  AgentTeamSubscriptionEventPublished,
  AgentTeamTask,
  AgentTeamTaskActivity,
  AgentTeamTaskRef,
  AgentTeamThread,
  AgentTeamThreadAttention,
  AgentTeamThreadAttentionKey,
  AgentTeamThreadFact,
  AgentTeamThreadReadFact,
  AgentTeamThreadRef,
} from "./entities.ts"
import type { AgentTeamOperationReceipt } from "./operation-receipt.ts"
import type { AgentTeamWorkerStateView } from "./worker-requests.ts"

/** Intent to append one public Message to an existing Thread. */
export interface AgentTeamReplyRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly body: string
  readonly baseRevision: number
  /** The Message this reply answers. The Host refuses an unknown ref or one from another Thread; the parent's author is delivered to, so answering a Member reaches them. */
  readonly replyToMessageRef?: AgentTeamMessageRef
  /** Agent-supplied absolute file paths, resolved like startThread's. */
  readonly attachmentPaths?: readonly string[] | undefined
  /** Attachment cache IDs from the Human picker, resolved like startThread's. */
  readonly attachments?: readonly AgentTeamAttachmentId[] | undefined
}

/** Existing unread work must be read before this Thread mutation can proceed. */
export interface AgentTeamUnreadRequired {
  readonly kind: 'unread_required'
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly revision: number
  readonly unreadCount: number
  readonly directCount: number
  readonly facts?: readonly AgentTeamThreadReadFact[]
}

/** A public Thread mutation used an obsolete optimistic-concurrency revision. */
export interface AgentTeamStaleRevision {
  readonly kind: 'stale_revision'
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly expectedRevision: number
  readonly revision: number
  /** How the writer's token relates to this Thread's revisions; absent for a token the Thread really reached (a plain race). `unknown` is a token from before the Thread's first fact (possibly read too early); `unrecognized` is one the Thread's revisions skipped, copied from another Thread or invented. */
  readonly staleTokenKind?: 'unknown' | 'unrecognized'
  /** The facts committed inside `(expectedRevision, revision]`, in the shape of a Thread read's facts; absent when the increment carries nothing renderable. */
  readonly facts?: readonly AgentTeamThreadReadFact[]
}

/** An Agent tried to address an Agent who is not already following. */
export interface AgentTeamMemberNotFollowing {
  readonly kind: 'member_not_following'
  readonly memberIds: readonly AgentTeamMemberId[]
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef?: AgentTeamThreadRef
  readonly revision?: number
}

export interface AgentTeamStartThreadResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly message: AgentTeamMessage
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly attention: readonly AgentTeamThreadAttention[]
  readonly directMarkers: readonly AgentTeamDirectMarker[]
}

/** Which Thread a Main stream card stands for, and the current state it shows. A card is a projection of its Thread, never a stored fact: it changes as the Thread does. */
export interface AgentTeamMainThreadCard {
  readonly threadRef: AgentTeamThreadRef
  readonly anchor: {
    readonly messageRef: AgentTeamMessageRef
    readonly sender: AgentTeamMemberId
    /** Bounded opening line of the anchor Message. */
    readonly preview: string
    readonly sequence: number
    readonly occurredAt: string
  }
  /** Present when the Thread is a Task: the card shows its current status, resolution and live Claim owners instead of a discussion summary. */
  readonly task?: {
    readonly taskRef: AgentTeamTaskRef
    readonly taskNumber: number
    readonly status: AgentTeamTask['status']
    readonly resolution: AgentTeamTask['resolution']
    readonly accountable: AgentTeamMemberId
    readonly liveClaimOwners: readonly AgentTeamInboxActor[]
  }
  /** Messages after the anchor. */
  readonly replyCount: number
  /** Members who wrote in the Thread, in order of their first Message. */
  readonly participants: readonly AgentTeamInboxActor[]
  readonly newestSequence: number
  readonly newestOccurredAt: string
  readonly newestActor: AgentTeamInboxActor
}

interface AgentTeamMainTimelineBase {
  /** Position in the ledger; a card sits where its Thread's anchor was written. */
  readonly sequence: number
  readonly occurredAt: string
  /** Unread for the reader: ordinary unread (owners only) or carrying one of the reader's Main stream markers. Task cards are never unread. */
  readonly unread: boolean
  /** Carries one of the reader's Main stream markers. */
  readonly direct: boolean
}

/** One entry of a Project's Main stream, in ledger order. */
export type AgentTeamMainTimelineEntry =
  | (AgentTeamMainTimelineBase & {
    readonly kind: 'message'
    readonly message: AgentTeamMainMessage
    /** Members this Message mentions or answers; each holds a Main stream marker. */
    readonly mentions: readonly AgentTeamMemberId[]
    readonly replyTo?: AgentTeamMessageReplyContext | undefined
  })
  | (AgentTeamMainTimelineBase & { readonly kind: 'activity'; readonly activity: AgentTeamMainActivity })
  | (AgentTeamMainTimelineBase & { readonly kind: 'thread-card'; readonly card: AgentTeamMainThreadCard })
  | (AgentTeamMainTimelineBase & { readonly kind: 'subscription-event'; readonly event: AgentTeamSubscriptionEventPublished })

/** The reader's own Main stream standing in one Project. */
export interface AgentTeamMainStreamStanding {
  /** Whether this reader's own Attention covers the Main stream; without it the ordinary updates never reach them. */
  readonly following: boolean
  /** Newest sequence the Main stream holds (0 when empty): what a read can pass as `readThroughSequence`. */
  readonly head: number
  readonly unreadCount: number
  readonly directCount: number
  readonly markers: readonly AgentTeamMainMarker[]
}

/** Intent to post one Main stream Message. */
export interface AgentTeamPostMainMessageRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly body: string
  /** The Main stream Message this answers; its author is delivered to. */
  readonly replyToMessageRef?: AgentTeamMessageRef
  readonly attachments?: readonly AgentTeamAttachmentId[] | undefined
  readonly attachmentPaths?: readonly string[] | undefined
}

export interface AgentTeamPostMainMessageCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly message: AgentTeamMainMessage
  readonly markers: readonly AgentTeamMainMarker[]
}

/** The writer has unread Main stream entries or markers and must read them before posting. */
export interface AgentTeamMainUnreadRequired {
  readonly kind: 'main_unread_required'
  readonly projectRef: AgentTeamProjectRef
  readonly unreadCount: number
  readonly directCount: number
  readonly head: number
  readonly entries: readonly AgentTeamMainTimelineEntry[]
}

export type AgentTeamPostMainMessageResult = AgentTeamPostMainMessageCommittedResult | AgentTeamMainUnreadRequired

/** Atomically acknowledge the Main stream up to one sequence. Without `readThroughSequence` the read reaches the current head. */
export interface AgentTeamMainStreamReadRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly readThroughSequence?: number
}

export interface AgentTeamMainStreamReadResult {
  /** Receipt of the durable read this response committed; absent when nothing was left to acknowledge, since no operation was appended. */
  readonly receipt?: AgentTeamOperationReceipt
  readonly projectRef: AgentTeamProjectRef
  readonly readThroughSequence: number
  /** The newest entries (plus any entry carrying a marker this read consumed), oldest first, flagged as the reader saw them before this read. */
  readonly entries: readonly AgentTeamMainTimelineEntry[]
  readonly consumedMarkers: readonly AgentTeamMainMarker[]
  /** Standing after this read. */
  readonly standing: AgentTeamMainStreamStanding
}

/** Non-mutating Main stream page. */
export interface AgentTeamMainStreamHistoryRequest {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  /** Page entries older than this sequence (exclusive); default the newest page. */
  readonly beforeSequence?: number
  /** Entries per page: an integer from 1 to 100, default 20. */
  readonly limit?: number
}

export interface AgentTeamMainStreamHistory {
  readonly projectRef: AgentTeamProjectRef
  readonly entries: readonly AgentTeamMainTimelineEntry[]
  readonly cursor: number
  readonly hasMore: boolean
  readonly standing: AgentTeamMainStreamStanding
}

/** Intent to start one discussion or Task Thread; Project owners only. */
export interface AgentTeamStartThreadRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly kind: 'discussion' | 'task'
  readonly body: string
  readonly sourceThreadRefs?: readonly AgentTeamThreadRef[]
  /** Task accountable; absent means the Agent owner creator, or Human for a Human creator. */
  readonly accountable?: AgentTeamMemberId
  readonly attachments?: readonly AgentTeamAttachmentId[] | undefined
  readonly attachmentPaths?: readonly string[] | undefined
}


export interface AgentTeamReplyCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly message: AgentTeamMessage
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly attention: readonly AgentTeamThreadAttention[]
  readonly directMarkers: readonly AgentTeamDirectMarker[]
  readonly undeliveredMentions?: readonly AgentTeamMemberId[]
}

export type AgentTeamReplyResult =
  | AgentTeamReplyCommittedResult
  | AgentTeamUnreadRequired
  | AgentTeamStaleRevision
  | AgentTeamMemberNotFollowing

/** Human or accountable Task resolution intent. */
export interface AgentTeamTaskRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly taskRef: AgentTeamTaskRef
  readonly action: 'accept' | 'close' | 'reopen'
  readonly baseRevision: number
}

export interface AgentTeamTaskCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly activity: AgentTeamTaskActivity
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly claims: readonly AgentTeamClaim[]
}

export type AgentTeamTaskResult =
  | AgentTeamTaskCommittedResult
  | AgentTeamUnreadRequired
  | AgentTeamStaleRevision

/** Human or current-accountable Task responsibility transfer. */
export interface AgentTeamTransferTaskRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly taskRef: AgentTeamTaskRef
  readonly target: AgentTeamMemberId
  readonly baseRevision: number
}

export interface AgentTeamTransferTaskCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly activity: AgentTeamTaskActivity
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
}

export type AgentTeamTransferTaskResult = AgentTeamTransferTaskCommittedResult | AgentTeamUnreadRequired | AgentTeamStaleRevision

/** Human intent to attach a real Task overlay to a taskless Thread. */
export interface AgentTeamPromoteThreadRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly threadRef: AgentTeamThreadRef
  readonly baseRevision: number
  /** Task accountable; absent means the Agent owner promoter, or Human for a Human promoter. */
  readonly accountable?: AgentTeamMemberId
}

export interface AgentTeamPromoteThreadCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly activity: AgentTeamTaskActivity
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
}

export type AgentTeamPromoteThreadResult =
  | AgentTeamPromoteThreadCommittedResult
  | AgentTeamUnreadRequired
  | AgentTeamStaleRevision

/** Human intent to permanently remove one Agent Member. */
export interface AgentTeamRemoveMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamRemoveMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly member: AgentTeamAgentMember
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Personal Thread Attention mutation; it is exempt from public mutation fences. */
export interface AgentTeamThreadAttentionRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  /** Addresses one Project's Main stream instead of a Thread: give this or threadRef, never both. */
  readonly projectRef?: AgentTeamProjectRef
  readonly action: 'follow' | 'unfollow'
}

/** Agent-only direct message to one enabled Agent Member in the same Workspace. Pure injection: the ledger records the send and the recipient's live session receives the body as a relay-form user message. */
export interface AgentTeamDmRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly recipientMemberId: AgentTeamMemberId
  readonly body: string
}

export interface AgentTeamDmResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly recipient: AgentTeamAgentMember
}

export interface AgentTeamThreadAttentionResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  /** Present after follow, absent after unfollow. */
  readonly attention?: AgentTeamThreadAttention
}

export interface AgentTeamThreadAttentionStatus {
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly attention?: AgentTeamThreadAttention
}

/** Following or unfollowing one Project's Main stream answers with the Project and the row now standing. */
export interface AgentTeamMainAttentionResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly project: AgentTeamProject
  /** Present after follow, absent after unfollow. */
  readonly attention?: AgentTeamMainAttention
}

/** One Member's Main stream Attention standing on one Project, as a status query answers it. */
export interface AgentTeamMainAttentionStatus {
  readonly project: AgentTeamProject
  readonly attention?: AgentTeamMainAttention
}

/** Direction Claim mutation. `baseRevision` fences every non-list public mutation. */
export interface AgentTeamClaimRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly taskRef: AgentTeamTaskRef
  readonly action: 'claim' | 'done' | 'release'
  readonly baseRevision: number
  readonly direction?: string
  readonly claimRef?: AgentTeamClaimRef
}

export interface AgentTeamClaimCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly activity: AgentTeamClaimActivity
  readonly claim: AgentTeamClaim
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly attention?: AgentTeamThreadAttention
}

export type AgentTeamClaimResult =
  | AgentTeamClaimCommittedResult
  | AgentTeamUnreadRequired
  | AgentTeamStaleRevision

export interface AgentTeamClaimList {
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly claims: readonly AgentTeamClaim[]
}

/** Read-only, personal Workspace Inbox projection. */
export interface AgentTeamInboxRequest {
  readonly workspaceId: WorkspaceId
  /** Unread Threads to return: an integer from 1 to 100, default 50. */
  readonly limit?: number
}

/** One person as an Inbox row draws them: the Member id carries the identity hue, the handle the initial; a row names who moved a Thread without a per-row Member view. */
export interface AgentTeamInboxActor {
  readonly memberId: AgentTeamMemberId
  /** Public handle, or the raw Member id when the roster no longer names them. */
  readonly name: string
  /** Agent lifecycle for accountable-owner display; absent for the Human and ordinary message actors. */
  readonly state?: AgentTeamAgentMember['state']
}

/** One Member reminder as a surface renders it: the durable entity plus the occurrence facts derived from the ledger. */
export interface AgentTeamMemberReminderView {
  readonly reminder: AgentTeamMemberReminder
  /** Instant the occurrence waiting to be read was raised at; absent when nothing is pending. */
  readonly pendingOccurrenceAt?: string | undefined
  /** Instant the last occurrence was raised at; absent when this reminder has never fired. */
  readonly lastOccurrenceAt?: string | undefined
  /** Instant the next occurrence is due; absent when this reminder will not fire again. */
  readonly nextOccurrenceAt?: string | undefined
}

/** A Member's intent to make itself a time promise. Only the creating Member may do this: a reminder has exactly one recipient. */
export interface AgentTeamMemberReminderCreateRequest {
  readonly requestId: AgentTeamRequestId
  readonly actor: AgentTeamMemberActor
  readonly workspaceId: WorkspaceId
  readonly reminderRef: AgentTeamReminderRef
  readonly schedule: AgentTeamReminderSchedule
  readonly note: string
}

export interface AgentTeamMemberReminderCreateResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly workspaceId: WorkspaceId
  readonly reminder: AgentTeamMemberReminder
  /** Active reminders this Member carries after the creation, against the per-Member ceiling. */
  readonly activeCount: number
}

/** A Member's own reminders, as a list read returns them. */
export interface AgentTeamMemberReminderListRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

/** Withdrawal of one reminder by the Member that owns it, or by the Human on its behalf. */
export interface AgentTeamMemberReminderCancelRequest {
  readonly requestId: AgentTeamRequestId
  readonly actor: AgentTeamMemberActor | AgentTeamHumanActor
  readonly workspaceId: WorkspaceId
  readonly reminderRef: AgentTeamReminderRef
}

export interface AgentTeamMemberReminderCancelResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly workspaceId: WorkspaceId
  readonly reminder: AgentTeamMemberReminder
}

/** One unread private Member reminder; never part of any Thread history. */
export interface AgentTeamUnreadMemberReminder {
  readonly reminder: AgentTeamMemberReminder
  readonly scheduledAt: string
  readonly sequence: number
}

/**
 * One occurrence of a Member reminder by the marker identity that delivered it.
 * Consumption is by this identity, so a notice that named an older occurrence
 * never consumes the newer one that replaced it while the notice waited unread.
 */
export interface AgentTeamMemberReminderOccurrenceRef {
  readonly reminderRef: AgentTeamReminderRef
  readonly sequence: number
}

/** One unread private Task reminder; never part of the public Thread history. */
export interface AgentTeamInboxReminder {
  readonly taskRef: AgentTeamTaskRef
  readonly kind: 'review-backlog' | 'stalled'
  readonly recipient: AgentTeamMemberId
  readonly baselineSequence: number
  readonly sequence: number
  readonly occurredAt: string
}

/** One Thread summary containing no Message bodies. */
export interface AgentTeamInboxItem {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  /** The owning Project's display name, so a row renders without a per-row Project view. */
  readonly projectName?: string
  readonly task?: AgentTeamTask
  /** The Task's ordinal inside its home Project; absent on taskless Threads. */
  readonly taskNumber?: number
  readonly thread: AgentTeamThread
  readonly unreadCount: number
  /** How many of them name this reader; always zero on the 「最近活跃」 slice. */
  readonly directCount: number
  readonly previewText?: string
  readonly newestSequence: number
  /** Instant of the newest unread fact — on the 「最近活跃」 slice, of the newest fact. */
  readonly newestOccurredAt: string
  readonly newestActor: AgentTeamInboxActor
  /** Owners of the Task's live Claims, in claim order, deduped. */
  readonly liveClaimOwners: readonly AgentTeamInboxActor[]
  readonly reminders: readonly AgentTeamInboxReminder[]
  readonly attention?: AgentTeamThreadAttention
}

/** One Project's Main stream while it holds unread for the reader: owners count ordinary unread, every reader counts their Main stream markers. */
export interface AgentTeamMainInboxItem {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly projectName: string
  readonly unreadCount: number
  /** How many of them carry one of the reader's Main stream markers (a mention, a reply to the reader, an ownership change). */
  readonly directCount: number
  readonly previewText?: string
  readonly newestSequence: number
  readonly newestOccurredAt: string
  readonly newestActor: AgentTeamInboxActor
}

export interface AgentTeamInbox {
  readonly humanMemberId: AgentTeamMemberId
  readonly items: readonly AgentTeamInboxItem[]
  readonly hasMore: boolean
  /** Every Project whose Main stream holds unread for the reader, direct first, then newest first; never paged. */
  readonly main: readonly AgentTeamMainInboxItem[]
  /** Human readers only: the 「最近活跃」 slice, Threads this reader took part in, newest activity first, at most ten, excluding Threads the unread queue carries. Agent readers get an empty slice, so the model-facing Inbox stays exactly the unread queue. */
  readonly recent: readonly AgentTeamInboxItem[]
  /** Thread and Main stream unread together. */
  readonly totalUnreadCount: number
  readonly totalDirectCount: number
}

/** Request to atomically receive and acknowledge one contiguous Thread batch. */
export interface AgentTeamThreadReadRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
}

export interface AgentTeamThreadReadResult {
  /** Receipt of the durable read this response committed; absent when the read made no progress (watermark did not move), since no operation was appended. */
  readonly receipt?: AgentTeamOperationReceipt
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly claims: readonly AgentTeamClaim[]
  /** The same Message, with what it answers attached when it is a reply. */
  readonly anchor: AgentTeamMessage & { readonly replyTo?: AgentTeamMessageReplyContext | undefined }
  readonly anchorMentions: readonly AgentTeamMemberId[]
  readonly facts: readonly AgentTeamThreadReadFact[]
  readonly readThroughSequence: number
  /** Number of unread facts left after this bounded read. */
  readonly remainingUnreadCount: number
  readonly earlierFactCount?: number
  readonly attention?: AgentTeamThreadAttention
  readonly consumedDirectMarkers: readonly AgentTeamDirectMarker[]
  readonly reminders: readonly AgentTeamInboxReminder[]
  /**
   * How every Worker run the returned facts mention stands, keyed by
   * `workerRef`. Present only when those facts carry a Worker run. An entry
   * reports the run's whole durable state, never just what this window shows:
   * a start whose terminal fact sits in a page not yet loaded is running or
   * unconfirmed, never silently assumed to have failed.
   */
  readonly workerStates?: readonly AgentTeamWorkerStateView[] | undefined
}

/** Non-mutating Thread history request. */
export interface AgentTeamThreadHistoryRequest {
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly beforeSequence?: number
  readonly limit?: number
}

/**
 * A Task derived from this discussion, projected as a card at its creation point. Not a fact: it changes as the
 * Task does and never counts as unread.
 *
 * The card carries the Main stream's own `AgentTeamMainThreadCard` for the Task's Thread, so a discussion face and the
 * Main stream that would have shown this Task hold the same projection: status, live Claim owners, reply count and
 * newest instant cannot disagree between them.
 */
export interface AgentTeamThreadTaskCard {
  /** At whose sequence the card sits in the source discussion: the Task's own anchor Message. */
  readonly sequence: number
  /** A derived card exists only for a Task, so the Main stream card's `task` facet is always present here. */
  readonly card: AgentTeamMainThreadCard & { readonly task: NonNullable<AgentTeamMainThreadCard['task']> }
}

export interface AgentTeamThreadHistory {
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  /** The same Message, with what it answers attached when it is a reply. */
  readonly anchor: AgentTeamMessage & { readonly replyTo?: AgentTeamMessageReplyContext | undefined }
  /** Structured Member refs of the anchor Message, from its originating send operation. */
  readonly anchorMentions: readonly AgentTeamMemberId[]
  readonly claims: readonly AgentTeamClaim[]
  readonly facts: readonly AgentTeamThreadFact[]
  /** Tasks whose immutable `sourceThreadRefs` name this discussion; absent for a Task Thread, which has no cards of its own. */
  readonly taskCards?: readonly AgentTeamThreadTaskCard[]
  readonly cursor: number
  readonly hasMore: boolean
  /** How every Worker run the returned facts mention stands; the same derivation a Thread read carries. */
  readonly workerStates?: readonly AgentTeamWorkerStateView[] | undefined
}
