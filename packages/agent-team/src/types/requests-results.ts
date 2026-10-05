import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type { SessionId as AgentTeamMemberSessionId, SessionLogOffset as AgentTeamMemberSessionLogOffset, SessionSeq as AgentTeamMemberSessionSeq } from "@deepseek-ai/dsh-session"
import type {
  AgentTeamActivity,
  AgentTeamAgentMember,
  AgentTeamAgentMemberStatus,
  AgentTeamAttachmentId,
  AgentTeamChannel,
  AgentTeamChannelMembership,
  AgentTeamChannelRef,
  AgentTeamClaim,
  AgentTeamClaimActivity,
  AgentTeamClaimRef,
  AgentTeamConfirmationToken,
  AgentTeamContextCheckpointRef,
  AgentTeamDirectMarker,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
  AgentTeamMessage,
  AgentTeamModelSelection,
  AgentTeamOperationId,
  AgentTeamRequestId,
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

/** Receipt returned after an operation is durable or an identical retry resolves it. */
export interface AgentTeamOperationReceipt {
  readonly operationId: AgentTeamOperationId
  readonly requestId: AgentTeamRequestId
  readonly sequence: number
  /** Wall-clock instant of the committing operation; the one source results carry for optimistic fact instants. */
  readonly occurredAt: string
}

/** Human intent to create a Workspace Channel with its initial Members. */
export interface AgentTeamCreateChannelRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly name: string
  /** Display purpose text; may be empty and filled in later through an edit. */
  readonly description: string
  readonly memberIds?: readonly AgentTeamMemberId[]
}

/** Result of creating or idempotently resolving a Channel and its initial Members. */
export interface AgentTeamCreateChannelResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly channel: AgentTeamChannel
  readonly memberIds: readonly AgentTeamMemberId[]
}

/** Human intent to provision one team-managed Agent Member with initial Channels. */
export interface AgentTeamAddMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly handle: string
  /** Display purpose text; may be empty and filled in later through an edit. */
  readonly description: string
  readonly presetId: string
  /** Absent inherits the Host default model selection. */
  readonly model?: AgentTeamModelSelection
  /** Durable capability intent; see AgentTeamMemberCapabilities. */
  readonly capabilities?: AgentTeamMemberCapabilities
  /** Existing Channels in this Workspace; may be empty — the Member joins Channels later and stays reachable through its DM view. */
  readonly channelRefs: readonly AgentTeamChannelRef[]
}

/** Human intent to rename one Channel's display facts. */
export interface AgentTeamUpdateChannelRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly name: string
  /** Display purpose text; may be empty, matching creation. */
  readonly description: string
}

/** Result of updating or idempotently resolving one Channel's display facts. */
export interface AgentTeamUpdateChannelResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly channel: AgentTeamChannel
}

/** Human intent to archive one Channel: hidden everywhere, facts kept. */
export interface AgentTeamArchiveChannelRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
}

/**
 * Result of Channel archival: the Channel is hidden with every fact
 * recoverable. Active Claims on the Channel's Threads were released.
 */
export interface AgentTeamArchiveChannelResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly channel: AgentTeamChannel
  readonly releasedClaims: readonly AgentTeamClaim[]
}

/**
 * Human intent to edit one Member's mutable facts; absent optional facts
 * clear any override. Callers that do not manage capabilities must echo the
 * stored value back, or their edit would silently clear it.
 */
export interface AgentTeamUpdateMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
  readonly handle: string
  /** Display purpose text; may be empty, matching creation. */
  readonly description: string
  readonly model?: AgentTeamModelSelection
  /** Absent clears any capability override, matching `model`. */
  readonly capabilities?: AgentTeamMemberCapabilities
}

/** Human intent to suspend or resume one Agent Member. */
export interface AgentTeamSetMemberStateRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
}

/** Human intent to archive one Agent Member: hidden everywhere, data kept. */
export interface AgentTeamArchiveMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
}

/**
 * Result of archival: the Member is hidden with its data recoverable. Active
 * Claims the Member held were released, so those Tasks are no longer stuck
 * in progress behind a hidden Member.
 */
export interface AgentTeamArchiveMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly member: AgentTeamAgentMember
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Result of a Member lifecycle operation. */
export interface AgentTeamMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly status: AgentTeamAgentMemberStatus
}

/** Result of creating a Member: lifecycle status plus the participation set the Host seeded at creation. */
export interface AgentTeamAddMemberResult extends AgentTeamMemberResult {
  /** Workspaces the new Member participates in — creation always seeds exactly the creation Workspace. */
  readonly workspaceIds: readonly WorkspaceId[]
}

/** Operator intent to nudge one error-stopped Member into continuing its work. */
export interface AgentTeamRecoverMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

/** Result of a recovery nudge; runtime-only steering, so there is no ledger receipt. */
export interface AgentTeamRecoverMemberResult {
  readonly status: AgentTeamAgentMemberStatus
}

/** Human intent to start one enabled Member's next turn from an empty context. */
export interface AgentTeamClearMemberContextRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

/** The Member keeps identity, memory, and binding; its sessionId moves to a fresh Session and the previous log stays archived on disk. */
export interface AgentTeamClearMemberContextResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly status: AgentTeamAgentMemberStatus
}

/**
 * Member-authored intent (carried by its live Agent) to continue in its next
 * private context generation. The requestId and new Session id derive stably
 * from the successful `context_rollover` tool call so crash replay converges on
 * one operation and one generation.
 */
export interface AgentTeamRolloverSessionRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
  /** The Session the Member must still be bound to at commit time. */
  readonly previousSessionId: AgentTeamMemberSessionId
  /** The next generation Session, derived from the successful tool call. */
  readonly newSessionId: AgentTeamMemberSessionId
  /** Seq of the successful `context_rollover` tool result in the previous Session log. */
  readonly handoffEventSeq: AgentTeamMemberSessionSeq
  /** Why the rollover happened: the model asked, or honored a pressure notice. */
  readonly trigger: 'model' | 'pressure'
  /** Seed source Session for a checkpoint return; absent on a fresh rollover. */
  readonly sourceSessionId?: AgentTeamMemberSessionId
  /** Exclusive end of the seeded source prefix (its exact length in the source log). */
  readonly sourceThroughSeq?: AgentTeamMemberSessionLogOffset
  /** The checkpoint a return was addressed to; absent on a fresh rollover. */
  readonly checkpointRef?: AgentTeamContextCheckpointRef
}

export interface AgentTeamRolloverSessionResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly member: AgentTeamAgentMember
}

/** Human intent to remove one Agent Member from one Channel. */
export interface AgentTeamRemoveChannelMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly memberId: AgentTeamMemberId
}

/** Result of Channel-scoped member cleanup. */
export interface AgentTeamRemoveChannelMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly channelRef: AgentTeamChannelRef
  readonly memberId: AgentTeamMemberId
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Human intent to join one Agent Member to one additional Workspace. */
export interface AgentTeamJoinWorkspaceRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamJoinWorkspaceResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly memberId: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
}

/**
 * Human intent to withdraw one Agent Member from one of its non-default
 * Workspaces: participation ends, Workspace-scoped Claims release, and the
 * Member's Attention/markers on that Workspace's Threads clear.
 */
export interface AgentTeamLeaveWorkspaceRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamLeaveWorkspaceResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly memberId: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
  readonly releasedClaims: readonly AgentTeamClaim[]
  readonly removedAttention: readonly AgentTeamThreadAttentionKey[]
}

/** Human intent to add one Agent Member to one Channel. */
export interface AgentTeamJoinChannelRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamJoinChannelResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly channelRef: AgentTeamChannelRef
  readonly memberId: AgentTeamMemberId
}

/** Intent to create one top-level Message and Thread, with an optional Task. */
export interface AgentTeamSendMessageRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly body: string
  readonly recipients?: readonly AgentTeamMemberId[]
  /** Uploaded attachments to reference; the Host resolves and verifies each id. */
  readonly attachments?: readonly AgentTeamAttachmentId[] | undefined
  /**
   * Agent-supplied absolute file paths; the Host validates each one, copies the
   * bytes into the attachment cache, and turns them into the same metadata.
   */
  readonly attachmentPaths?: readonly string[] | undefined
  readonly confirmationToken?: AgentTeamConfirmationToken
  /**
   * When false, create a taskless Thread. Omitted/true keeps the released-client
   * atomic Message+Thread+Task path. New composer/tool seams pass false explicitly.
   */
  readonly asTask?: boolean
}

/** Upload one composer attachment into the Team attachment cache. */
export interface AgentTeamPutAttachmentRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly name: string
  readonly mediaType?: string | undefined
  readonly bytesBase64: string
}

export interface AgentTeamPutAttachmentResult {
  readonly attachmentId: AgentTeamAttachmentId
  /** Absolute path members read the bytes from; stable for the cache lifetime. */
  readonly path: string
  readonly name: string
  readonly byteSize: number
  readonly mediaType: string
}

/** Read one uploaded attachment back for client-side display. */
export interface AgentTeamGetAttachmentRequest {
  readonly attachmentId: AgentTeamAttachmentId
}

export interface AgentTeamGetAttachmentResult {
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly bytesBase64: string
}

/** Human profile read: name + avatar reference + version footnote facts. */
export interface AgentTeamHumanProfileRequest {
}

export interface AgentTeamHumanProfileResult {
  readonly name: string
  readonly avatarRef?: string | undefined
  /** Bundle version shown in the settings footnote. */
  readonly version: string
  /** Repository home the footnote links to. */
  readonly repoUrl: string
  /**
   * Whether a newer release is known. Best-effort and cached Host-side
   * (npm `latest`, 12 h TTL, silent on any failure), so this stays false
   * until a background refresh actually observes one; the footnote shows
   * only the version + link until then.
   */
  readonly updateAvailable: boolean
  readonly latestVersion?: string | undefined
}

/** Local environment read: how the running DSH compares to the declared support line. */
export interface AgentTeamEnvironmentRequest {
}

/**
 * The one of three shapes the page renders. `undetermined` is the answer for
 * every fact this Host cannot establish — an unreadable runtime version, a
 * support range the manifest does not state — and never a guessed verdict; its
 * two causes are not distinguished to the reader, only recorded in `reason`.
 */
export type AgentTeamEnvironmentVerdict = 'ok' | 'out-of-range' | 'undetermined'

/** Declared DSH support line, stated in words by the page rather than as a range string. */
export interface AgentTeamEnvironmentSupportRange {
  /** Lower bound of the declared range, which is also the certified baseline. */
  readonly lower: string
  /** Exclusive upper bound of the declared range. */
  readonly upper: string
}

export interface AgentTeamEnvironmentResult {
  readonly verdict: AgentTeamEnvironmentVerdict
  /** Host-side diagnostic behind an `undetermined` verdict; not rendered as user copy. */
  readonly reason?: string | undefined
  // Every fact below is optional by contract: a missing one is never a
  // mismatch, it only withholds the line that would have stated it.
  /** Version of the bundle this Host runs from. */
  readonly bundleVersion?: string | undefined
  /**
   * The running DSH version, which is what the page states it is running.
   * Distinct from `certifiedDshVersion`: one is the environment, the other is
   * the line this bundle declares support for.
   */
  readonly dshVersion?: string | undefined
  /** Lower bound of the declared range: the certified, actually-tested DSH line. */
  readonly certifiedDshVersion?: string | undefined
  readonly supportRange?: AgentTeamEnvironmentSupportRange | undefined
}

/** Relatedness-judge read: carries no input; the answer is the Host's own state. */
export interface AgentTeamContextJudgeRequest {
}

/**
 * What the Team settings surface states about the long-gap gate's judge. It
 * carries only what the settings document cannot: whether a judge is actually
 * reachable, why it is not, and the gate's effective thresholds — which are row
 * configuration, so the Host resolves an omitted field against the engine's own
 * default rather than letting a second copy of those numbers exist.
 */
export interface AgentTeamContextJudgeResult {
  /** Whether a judge is reachable for the next step. */
  readonly enabled: boolean
  /** Why no judge is reachable; absent when one is. */
  readonly reason?: 'no-key' | 'unavailable' | undefined
  /** Host-side diagnostic behind `unavailable`; not rendered as user copy. */
  readonly detail?: string | undefined
  /** The environment variable this deployment reads the judge's key from. */
  readonly keyEnv: string
  /** The gate's thresholds in force: row configuration resolved against the engine's defaults. */
  readonly gate: {
    readonly tokens: number
    readonly idleMs: number
    readonly judgeTimeoutMs: number
  }
}

/**
 * Human profile write: the fields the Client supplies, each one optional and
 * independent of the others.
 */
export interface AgentTeamSetHumanProfileRequest {
  /** New display name; omitted keeps the current one. */
  readonly name?: string | undefined
  /**
   * New avatar reference; `null` clears the stored one and omitted keeps it.
   * Clearing needs its own shape because a merge patch cannot remove a field.
   */
  readonly avatarRef?: string | null | undefined
}

/** Resolved Human profile after a write; the same two fields the read returns. */
export interface AgentTeamSetHumanProfileResult {
  readonly name: string
  readonly avatarRef?: string | undefined
}

/** Upload one human avatar image into the persistent avatar store. */
export interface AgentTeamPutHumanAvatarRequest {
  readonly name: string
  readonly mediaType?: string | undefined
  readonly bytesBase64: string
}

export interface AgentTeamPutHumanAvatarResult {
  readonly avatarRef: string
  /** Absolute path members read the bytes from; stable until removed. */
  readonly path: string
  readonly name: string
  readonly byteSize: number
  readonly mediaType: string
}

/** Read one human avatar back for client-side display. */
export interface AgentTeamGetHumanAvatarRequest {
  readonly avatarRef: string
}

export interface AgentTeamGetHumanAvatarResult {
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly bytesBase64: string
}

/** Remove one human avatar entry; the profile falls back to hue/initial. */
export interface AgentTeamRemoveHumanAvatarRequest {
  readonly avatarRef: string
}

export interface AgentTeamRemoveHumanAvatarResult {
  readonly removed: boolean
}

/** Intent to append one public Message to an existing Thread. */
export interface AgentTeamReplyRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly body: string
  readonly baseRevision: number
  readonly recipients?: readonly AgentTeamMemberId[]
  /** Agent-supplied absolute file paths, resolved like sendMessage's. */
  readonly attachmentPaths?: readonly string[] | undefined
  /** Attachment cache IDs from the Human picker, resolved like sendMessage's. */
  readonly attachments?: readonly AgentTeamAttachmentId[] | undefined
  readonly confirmationToken?: AgentTeamConfirmationToken
}

/** A Human must send the same invitation one more time with this token. */
export interface AgentTeamConfirmationRequired {
  readonly kind: 'confirmation_required'
  readonly confirmationToken: AgentTeamConfirmationToken
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly recipients: readonly AgentTeamMemberId[]
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef?: AgentTeamThreadRef
  readonly revision?: number
}

/** Existing unread work must be read before this Thread mutation can proceed. */
export interface AgentTeamUnreadRequired {
  readonly kind: 'unread_required'
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly revision: number
  readonly unreadCount: number
  readonly directCount: number
}

/** A public Thread mutation used an obsolete optimistic-concurrency revision. */
export interface AgentTeamStaleRevision {
  readonly kind: 'stale_revision'
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly expectedRevision: number
  readonly revision: number
}

/** An Agent tried to address an Agent who is not already following. */
export interface AgentTeamMemberNotFollowing {
  readonly kind: 'member_not_following'
  readonly memberIds: readonly AgentTeamMemberId[]
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef?: AgentTeamThreadRef
  readonly revision?: number
}

export interface AgentTeamSendMessageCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly message: AgentTeamMessage
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly attention: readonly AgentTeamThreadAttention[]
  readonly directMarkers: readonly AgentTeamDirectMarker[]
}

export type AgentTeamSendMessageResult =
  | AgentTeamSendMessageCommittedResult
  | AgentTeamConfirmationRequired
  | AgentTeamMemberNotFollowing

export interface AgentTeamReplyCommittedResult {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly message: AgentTeamMessage
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly attention: readonly AgentTeamThreadAttention[]
  readonly directMarkers: readonly AgentTeamDirectMarker[]
  /**
   * Agents named in the body that this Thread has never carried. The Message
   * still commits; these Members simply receive no notification, and the
   * author is told so it can ask the Human to invite them.
   */
  readonly undeliveredMentions?: readonly AgentTeamMemberId[]
}

export type AgentTeamReplyResult =
  | AgentTeamReplyCommittedResult
  | AgentTeamConfirmationRequired
  | AgentTeamUnreadRequired
  | AgentTeamStaleRevision
  | AgentTeamMemberNotFollowing

/** Human Task resolution intent. */
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

/** Human intent to attach a real Task overlay to a taskless Thread. */
export interface AgentTeamPromoteThreadRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly threadRef: AgentTeamThreadRef
  readonly baseRevision: number
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
  readonly action: 'follow' | 'unfollow'
}

/**
 * Agent-only direct message to one enabled Agent Member in the same
 * Workspace. Delivery is pure injection: the ledger records the send, and the
 * recipient's live session receives the body as a relay-form user message.
 */
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
  readonly limit?: number
}

/**
 * One person as an Inbox row draws them: the Member id carries the shared
 * identity hue, the handle the initial. A row names who moved a Thread without
 * a per-row Member view, the same way it already carries its Channel's name.
 */
export interface AgentTeamInboxActor {
  readonly memberId: AgentTeamMemberId
  /** Public handle, or the raw Member id when the roster no longer names them. */
  readonly name: string
}

/** One Thread summary containing no Message bodies. */
export interface AgentTeamInboxItem {
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  /** The owning Channel's display name, so a row renders without a per-row Channel view. */
  readonly channelName?: string
  readonly task?: AgentTeamTask
  /** The Task's ordinal inside its home Channel; absent on taskless Threads. */
  readonly taskNumber?: number
  readonly thread: AgentTeamThread
  /** Unread facts waiting for this reader; always zero on the 「最近活跃」 slice. */
  readonly unreadCount: number
  /** How many of them name this reader; always zero on the 「最近活跃」 slice. */
  readonly directCount: number
  /**
   * The Thread's opening line, trimmed and capped at 120 characters — the same
   * bound the Thread page applies to its Task title. Row material only: it
   * never reaches model-visible notification text.
   */
  readonly previewText?: string
  readonly newestSequence: number
  /** Instant of the newest unread fact — on the 「最近活跃」 slice, of the newest fact. */
  readonly newestOccurredAt: string
  /**
   * Who committed the fact those two fields name — the person waiting for this
   * reader on the queue, and whoever moved the Thread on the tail. Every Thread
   * fact is committed by exactly one actor, so a row always names one.
   */
  readonly newestActor: AgentTeamInboxActor
  /**
   * The people still on this Thread's Task: owners of its live Claims, in claim
   * order, deduped — the same rule, and the same words, the Channel feed's Thread
   * entry row already uses for the same Task. Resolved here because a row draws
   * handles and has no Member view of its own to turn ids into them. Empty on a
   * taskless Thread, and on a done or closed one, whose Claims are history that
   * the state word already tells.
   */
  readonly claimOwners: readonly AgentTeamInboxActor[]
  readonly attention?: AgentTeamThreadAttention
}

export interface AgentTeamInbox {
  /**
   * The ledger's Human Member id — the durable identity a row matches to know
   * which of its actors is the reader, so a seat can draw that one actor from
   * its own Human identity (name and avatar) instead of the row's initials
   * fallback. The same id `AgentTeamView` carries, from the same initialization
   * record.
   */
  readonly humanMemberId: AgentTeamMemberId
  /** The unread queue: every Thread holding at least one unread fact for this reader. */
  readonly items: readonly AgentTeamInboxItem[]
  /**
   * Human readers only: the 「最近活跃」 slice — Threads this reader took part in,
   * newest activity first, at most ten, excluding every Thread the queue above
   * already carries. Agent readers always receive an empty slice, so the
   * model-facing Inbox stays exactly the unread queue.
   */
  readonly recent: readonly AgentTeamInboxItem[]
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

/**
 * Private, read-time context guidance for one acceptance the reading Member
 * just acknowledged. Host-computed after the durable read committed; never a
 * ledger fact, never persisted, and absent unless this read acknowledged an
 * unread acceptance of a Task that is still done.
 */
export interface AgentTeamContextAdvice {
  /** Current measured usage of the reading Member's context; absent when unmeasured. */
  readonly usageTokens?: number | undefined
  /** Usage at or above which a fresh rollover is advised; min(128K, handoffAt); absent when unmeasured. */
  readonly taskBoundaryThreshold?: number | undefined
  /** Effective handoff budget of the Member's current route; absent when unmeasured. */
  readonly handoffAt?: number | undefined
  /** Effective hard limit of the Member's current route; absent when unmeasured. */
  readonly hardLimit?: number | undefined
  /** keep | rollover | compact-now | unavailable. */
  readonly action: 'keep' | 'rollover' | 'compact-now' | 'unavailable'
  readonly guidance: string
}

export interface AgentTeamThreadReadResult {
  /**
   * Receipt of the durable read this response committed; absent when the read
   * made no progress — an already-read Thread whose watermark did not move —
   * so no operation was appended and there is nothing to point at.
   */
  readonly receipt?: AgentTeamOperationReceipt
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly claims: readonly AgentTeamClaim[]
  readonly anchor: AgentTeamMessage
  /** Structured Member refs of the anchor Message, from its originating send operation. */
  readonly anchorMentions: readonly AgentTeamMemberId[]
  readonly facts: readonly AgentTeamThreadReadFact[]
  readonly readThroughSequence: number
  /** Number of unread facts left after this bounded read. */
  readonly remainingUnreadCount: number
  /**
   * Public Thread facts that precede the watermark this read reaches — where
   * the reader now stands in the Thread, and how much of it that position has
   * never shown it. A returning reader's batch answers with the newest facts
   * alone, so this is the span it is not looking at; the count never depends on
   * whether this particular response happened to carry background. Zero means
   * the Thread holds nothing before the reader's position. Absent on a legacy
   * read snapshot, whose stored shape stays frozen.
   */
  readonly earlierFactCount?: number
  readonly attention?: AgentTeamThreadAttention
  readonly consumedDirectMarkers: readonly AgentTeamDirectMarker[]
  /** Present only when this read acknowledged an unread acceptance of a still-done Task. */
  readonly contextAdvice?: AgentTeamContextAdvice
}

/** Non-mutating Thread history request. */
export interface AgentTeamThreadHistoryRequest {
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly beforeSequence?: number
  readonly limit?: number
}

export interface AgentTeamThreadHistory {
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly anchor: AgentTeamMessage
  /** Structured Member refs of the anchor Message, from its originating send operation. */
  readonly anchorMentions: readonly AgentTeamMemberId[]
  readonly claims: readonly AgentTeamClaim[]
  readonly facts: readonly AgentTeamThreadFact[]
  readonly cursor: number
  readonly hasMore: boolean
}

/** Human-only observation of a durable personal Attention change. */
export interface AgentTeamThreadAttentionObservation {
  readonly sequence: number
  readonly threadRef: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly memberId: AgentTeamMemberId
  readonly action: 'follow' | 'unfollow'
}

export interface AgentTeamThreadObservationsRequest {
  readonly workspaceId: WorkspaceId
  readonly threadRef?: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef
  readonly limit?: number
}

export interface AgentTeamThreadObservations {
  readonly items: readonly AgentTeamThreadAttentionObservation[]
  /** Members whose Attention currently follows the Thread — the state the replayed observations lead to. */
  readonly followers: readonly AgentTeamMemberId[]
}

/** One bounded Workspace view item. */
export interface AgentTeamViewItem {
  readonly message: AgentTeamMessage
  /** Structured Member refs of this Message, from its originating send operation. */
  readonly mentions: readonly AgentTeamMemberId[]
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly taskNumber?: number
  /**
   * The people still on this item's Task: owners of its live Claims, in claim
   * order, deduped — the same rule, and the same words, the Inbox row already
   * uses for the same Task, resolved here because a feed entry draws handles
   * and has no Member view of its own. Empty on a taskless item, and on a done
   * or closed one, whose Claims are history that the state word already tells.
   */
  readonly claimOwners: readonly AgentTeamInboxActor[]
  readonly messageCount: number
  /** Instant of the latest fact on this Thread (message or activity), projected from its committing operation. */
  readonly lastActivityAt: string
}

/**
 * One in-flight Task Thread for the team_view「活跃 task thread」radar: work a
 * reader can see is already claimed and moving, so an unexpected Workspace edit
 * or a Task they were about to pick up resolves to "someone is on this" instead
 * of a mystery. Unlike the Human Inbox's 「最近活跃」 slice, admission is not
 * participation — every active Task Thread in the reader's authorized Channels
 * appears, whether or not they took part — and a Thread still holding unread is
 * not excluded, because this radar answers "who is on what" independently of
 * the reader's own unread queue.
 */
export interface AgentTeamActiveTaskThread {
  readonly taskRef: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly channelRef: AgentTeamChannelRef
  /** The Task's ordinal inside its home Channel. */
  readonly taskNumber?: number
  /** Always `in_progress` or `in_review` — the two states a live Claim keeps a Task in. */
  readonly status: AgentTeamTask['status']
  /** The Thread's opening line, trimmed and capped at 120 characters — the same bound the Inbox row uses. */
  readonly subject: string
  /** Owners of the Task's live Claims, in claim order, deduped — the same rule the Inbox row and Channel feed use. */
  readonly members: readonly AgentTeamInboxActor[]
  /** Instant of the newest fact on this Thread. */
  readonly lastActivityAt: string
}

export interface AgentTeamViewRequest {
  readonly workspaceId: WorkspaceId
  readonly channelRef?: AgentTeamChannelRef
  readonly threadRef?: AgentTeamThreadRef
  readonly limit?: number
  readonly cursor?: number
  /** Read facts after the cursor (Agent default) or the latest facts before it (Client history). */
  readonly direction?: 'after' | 'before'
  /** Exclude Thread replies from a top-level-only projection. */
  readonly topLevelOnly?: boolean
  /** Include public Claim and Task activities in the bounded stream (default true). */
  readonly includeActivities?: boolean
}

/** Bounded public collaboration facts plus a continuation sequence. */
export interface AgentTeamView {
  readonly humanMemberId: AgentTeamMemberId
  /** Every Workspace the viewing Member participates in — the address book for the optional `workspace` selector; `default` marks the Workspace its Session roots in. */
  readonly workspaces: readonly AgentTeamWorkspaceParticipation[]
  readonly channels: readonly AgentTeamChannel[]
  readonly members: readonly AgentTeamChannelMembership[]
  readonly tasks: readonly AgentTeamTask[]
  readonly threads: readonly AgentTeamThread[]
  readonly taskNumbers: readonly { readonly taskRef: AgentTeamTaskRef; readonly taskNumber: number }[]
  readonly items: readonly AgentTeamViewItem[]
  /**
   * The「活跃 task thread」radar: every in_progress / in_review Task Thread in
   * the reader's authorized Channels of this Workspace, newest activity first.
   * Independent of the reader's participation and unread state — its job is to
   * surface who is already on what, so re-entry and pre-claim/pre-commit checks
   * do not mistake in-flight work for a conflict.
   */
  readonly activeTaskThreads: readonly AgentTeamActiveTaskThread[]
  readonly claims: readonly AgentTeamClaim[]
  readonly activities: readonly AgentTeamActivity[]
  readonly cursor: number
  readonly hasMore: boolean
}

/** One Workspace a Member participates in, as exposed to the Member-facing view. */
export interface AgentTeamWorkspaceParticipation {
  readonly workspaceId: WorkspaceId
  /** Registry display title; absent when the Workspace is already gone from the registry (a dangling participation pending cleanup). */
  readonly title?: string | undefined
  readonly default: boolean
}

/** One projection slice a Client can wait on; events wake only matching waiters. */
export type AgentTeamChangeScope =
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }
  | { readonly kind: 'channel'; readonly channelRef: AgentTeamChannelRef }
  | { readonly kind: 'thread'; readonly threadRef: AgentTeamThreadRef }
  /**
   * Presence-only lifecycle wake (Agent running/idle/failure) with no ledger
   * commit behind it: members/presence subscribers refresh their rows, while
   * workspace catalog and scope-less Inbox subscribers stay parked because no
   * durable projection changed.
   */
  | { readonly kind: 'presence'; readonly workspaceId: WorkspaceId }

/** Subscribe to lightweight invalidations; each connection starts with a current baseline. */
export interface AgentTeamChangesRequest {
  /** Omit to observe every shared projection change. */
  readonly scope?: AgentTeamChangeScope
}

/** Invalidation, not a history record: intermediate versions may be coalesced. */
export interface AgentTeamChangesResult {
  /** Presence uses a process-local epoch; other scopes use the shared projection's ledger position. */
  readonly version: number
}

/** Human-facing summary of the current Team projection. */
export interface AgentTeamStatus {
  readonly initialized: true
  readonly sequence: number
  readonly operationCount: number
  readonly channelCount: number
  readonly agentMemberCount: number
  readonly humanMemberId: AgentTeamMemberId
}
