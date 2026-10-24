import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type {
  AgentTeamActivity,
  AgentTeamAgentMember,
  AgentTeamAgentMemberStatus,
  AgentTeamAttachmentId,
  AgentTeamProject,
  AgentTeamProjectMembership,
  AgentTeamProjectRef,
  AgentTeamClaim,
  AgentTeamClaimActivity,
  AgentTeamClaimRef,
  AgentTeamConfirmationToken,
  AgentTeamDirectMarker,
  AgentTeamMainActivity,
  AgentTeamMainMarker,
  AgentTeamMainMessage,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
  AgentTeamMessage,
  AgentTeamMessageRef,
  AgentTeamMessageReplyContext,
  AgentTeamModelSelection,
  AgentTeamOperationId,
  AgentTeamRequestId,
  AgentTeamLiveTaskStatus,
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

/** Human intent to create a Workspace Project with its initial Members. */
export interface AgentTeamCreateProjectRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly name: string
  /** Display purpose text; may be empty and filled in later through an edit. */
  readonly description: string
  readonly memberIds?: readonly AgentTeamMemberId[]
}

/** Result of creating or idempotently resolving a Project and its initial Members. */
export interface AgentTeamCreateProjectResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly project: AgentTeamProject
  readonly memberIds: readonly AgentTeamMemberId[]
}

/** Human intent to provision one team-managed Agent Member with initial Projects. */
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
  /** Existing Projects in this Workspace; may be empty — the Member joins Projects later and stays reachable through its DM view. */
  readonly projectRefs: readonly AgentTeamProjectRef[]
}

/** Human intent to rename one Project's display facts. */
export interface AgentTeamUpdateProjectRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly name: string
  /** Display purpose text; may be empty, matching creation. */
  readonly description: string
}

/** Result of updating or idempotently resolving one Project's display facts. */
export interface AgentTeamUpdateProjectResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly project: AgentTeamProject
}

/** Human intent to grant or withdraw one Agent Member's ownership of a Project. The Human owns every Project and is never named. */
export interface AgentTeamProjectOwnerRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
}

/** Result of changing or idempotently resolving one Project owner, with the Project's Agent owners after it. */
export interface AgentTeamProjectOwnerResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly projectRef: AgentTeamProjectRef
  readonly ownerIds: readonly AgentTeamMemberId[]
}

/** Human intent to archive one Project: hidden everywhere, facts kept. */
export interface AgentTeamArchiveProjectRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
}

/** Result of Project archival: hidden with every fact recoverable; active Claims on its Threads were released. */
export interface AgentTeamArchiveProjectResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly project: AgentTeamProject
  readonly releasedClaims: readonly AgentTeamClaim[]
}

/** Human intent to edit one Member's mutable facts, as a partial update: an absent optional field keeps the current value and an explicit `null` clears the override (Host default model / full standard capability surface). */
export interface AgentTeamUpdateMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly memberId: AgentTeamMemberId
  readonly handle: string
  /** Display purpose text; may be empty, matching creation. */
  readonly description: string
  /** Absent keeps the current selection; `null` clears it back to the Host default. */
  readonly model?: AgentTeamModelSelection | null
  /** Absent keeps the current override; `null` clears it back to the full surface. */
  readonly capabilities?: AgentTeamMemberCapabilities | null
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

/** Result of archival: the Member is hidden with data recoverable; its active Claims were released so no Task stays in progress behind it. */
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

/** How a configuration edit's runtime effects landed: installed now, already in force, or saved but deferred to the next activation (with the reason). A failed apply is a rejection, never listed here. */
export type AgentTeamMemberEffect =
  | 'applied'
  | 'already-applied'
  | 'deferred:no-live-handle'
  | 'deferred:generation-changed'

/** Result of a configuration edit: lifecycle status plus its effect outcome. */
export interface AgentTeamUpdateMemberResult extends AgentTeamMemberResult {
  readonly effect: AgentTeamMemberEffect
}

/** Result of creating a Member: lifecycle status plus the participation set the Host seeded at creation. */
export interface AgentTeamAddMemberResult extends AgentTeamMemberResult {
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

/** Human intent to remove one Agent Member from one Project. */
export interface AgentTeamRemoveProjectMemberRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
}

/** Result of Project-scoped member cleanup. */
export interface AgentTeamRemoveProjectMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly projectRef: AgentTeamProjectRef
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

/** Human intent to withdraw one Agent Member from a non-default Workspace: participation ends, Workspace-scoped Claims release, and Attention/markers on its Threads clear. */
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

/** Human intent to add one Agent Member to one Project. */
export interface AgentTeamJoinProjectRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
}

export interface AgentTeamJoinProjectResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
}

/** Intent to create one top-level Message and Thread, with an optional Task. */
export interface AgentTeamSendMessageRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly body: string
  readonly recipients?: readonly AgentTeamMemberId[]
  /** Uploaded attachments to reference; the Host resolves and verifies each id. */
  readonly attachments?: readonly AgentTeamAttachmentId[] | undefined
  /** Agent-supplied absolute file paths; the Host validates each, copies the bytes into the attachment cache, and produces the same metadata. */
  readonly attachmentPaths?: readonly string[] | undefined
  readonly confirmationToken?: AgentTeamConfirmationToken
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
  /** A newer published release, when known. Best-effort and cached Host-side (npm `latest`, 12 h TTL, silent on failure); absent until a background refresh observes one. */
  readonly latestVersion?: string | undefined
}

/** Local environment read: how the running DSH compares to the declared support line. */
export interface AgentTeamEnvironmentRequest {
}

/** `undetermined` answers every fact this Host cannot establish (unreadable runtime version, unstated support range) and is never a guessed verdict; the two causes are indistinguishable to the reader and recorded only in `reason`. */
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
  readonly bundleVersion?: string | undefined
  /** The running DSH version the page states it is running; distinct from `certifiedDshVersion`, the line this bundle declares. */
  readonly dshVersion?: string | undefined
  /** Lower bound of the declared range: the certified, actually-tested DSH line. */
  readonly certifiedDshVersion?: string | undefined
  readonly supportRange?: AgentTeamEnvironmentSupportRange | undefined
}

/** Human profile write: each Client-supplied field is optional and independent. */
export interface AgentTeamSetHumanProfileRequest {
  /** New display name; omitted keeps the current one. */
  readonly name?: string | undefined
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
  /** The Message this reply answers. The Host refuses an unknown ref or one from another Thread; the parent's author joins the recipients, so answering a Member reaches them. */
  readonly replyToMessageRef?: AgentTeamMessageRef
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
  readonly projectRef: AgentTeamProjectRef
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

/** The reader's own Main stream standing in one Project. */
export interface AgentTeamMainStreamStanding {
  /** Owners (the Human always) have ordinary unread; everyone else only has markers. */
  readonly owner: boolean
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
  readonly recipients?: readonly AgentTeamMemberId[]
  /** The Main stream Message this answers; its author joins the recipients. */
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
  readonly recipients?: readonly AgentTeamMemberId[]
  readonly attachments?: readonly AgentTeamAttachmentId[] | undefined
  readonly attachmentPaths?: readonly string[] | undefined
}

export type AgentTeamStartThreadResult = AgentTeamSendMessageCommittedResult

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
  readonly attention?: AgentTeamThreadAttention
}

export interface AgentTeamInbox {
  readonly humanMemberId: AgentTeamMemberId
  readonly items: readonly AgentTeamInboxItem[]
  readonly hasMore: boolean
  /** Human readers only: the 「最近活跃」 slice, Threads this reader took part in, newest activity first, at most ten, excluding Threads the unread queue carries. Agent readers get an empty slice, so the model-facing Inbox stays exactly the unread queue. */
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
  /** The same Message, with what it answers attached when it is a reply. */
  readonly anchor: AgentTeamMessage & { readonly replyTo?: AgentTeamMessageReplyContext | undefined }
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
  /** The newest observations up to `limit` (default 50, at most 100); `hasMore` says whether older ones exist. */
  readonly items: readonly AgentTeamThreadAttentionObservation[]
  /** Members whose Attention currently follows the Thread — the state the replayed observations lead to. */
  readonly followers: readonly AgentTeamMemberId[]
  /** Older observations than `items` exist. The follower set is always complete. */
  readonly hasMore: boolean
}

/** One bounded Workspace view item. */
export interface AgentTeamViewItem {
  readonly message: AgentTeamMessage
  /** Structured Member refs of this Message, from its originating send operation. */
  readonly mentions: readonly AgentTeamMemberId[]
  readonly task?: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly taskNumber?: number
  /** Owners of this item's Task's live Claims, in claim order, deduped (the Inbox row's rule), resolved here because a feed entry draws handles and has no Member view. Empty on a taskless, done, or closed item. */
  readonly liveClaimOwners: readonly AgentTeamInboxActor[]
  readonly messageCount: number
  /** Instant of the latest fact on this Thread (message or activity), projected from its committing operation. */
  readonly lastActivityAt: string
}

/** One in-flight Task Thread for the team_view「活跃 task thread」radar: claimed, moving work, so an unexpected edit or a Task a reader was about to pick up resolves to "someone is on this". Unlike the Inbox's 「最近活跃」 slice, admission is not participation: every active Task Thread in the reader's authorized Projects appears, including Threads still holding unread. */
export interface AgentTeamActiveTaskThread {
  readonly taskRef: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly projectRef: AgentTeamProjectRef
  /** The Task's ordinal inside its home Project. */
  readonly taskNumber?: number
  readonly status: AgentTeamLiveTaskStatus
  /** The Thread's opening line, trimmed and capped at 120 characters — the same bound the Inbox row uses. */
  readonly subject: string
  /** Owners of the Task's live Claims, in claim order, deduped — the same rule the Inbox row and Project feed use. */
  readonly members: readonly AgentTeamInboxActor[]
  /** Instant of the newest fact on this Thread. */
  readonly lastActivityAt: string
}

export interface AgentTeamViewRequest {
  readonly workspaceId: WorkspaceId
  readonly projectRef?: AgentTeamProjectRef
  readonly threadRef?: AgentTeamThreadRef
  readonly limit?: number
  readonly cursor?: number
  /** Read facts after the cursor (Agent default) or the latest facts before it (Client history). */
  readonly direction?: 'after' | 'before'
  readonly topLevelOnly?: boolean
  /** Include public Claim and Task activities in the bounded stream (default true). */
  readonly includeActivities?: boolean
  readonly includeCatalog?: boolean
}

/** Bounded public collaboration facts plus a continuation sequence. */
export interface AgentTeamView {
  readonly humanMemberId: AgentTeamMemberId
  /** Every Workspace the viewing Member participates in — the address book for the optional `workspace` selector; `default` marks the Workspace its Session roots in. */
  readonly workspaces: readonly AgentTeamWorkspaceParticipation[]
  readonly projects: readonly AgentTeamProject[]
  readonly members: readonly AgentTeamProjectMembership[]
  /** Agent owners of the listed Projects. The Human owns every Project and is not listed. */
  readonly owners: readonly AgentTeamProjectMembership[]
  /** Validation rules version the ledger has adopted; Project owners exist from version 2. */
  readonly rulesVersion: number
  /** Catalog of the response's scope: visible Tasks, their Threads, ordinals, radar rows, and Claims. With `includeCatalog` this is the whole request scope; otherwise only the Tasks and Threads the fact page and named Thread carry. */
  readonly tasks: readonly AgentTeamTask[]
  readonly threads: readonly AgentTeamThread[]
  readonly taskNumbers: readonly { readonly taskRef: AgentTeamTaskRef; readonly taskNumber: number }[]
  readonly items: readonly AgentTeamViewItem[]
  /** The「活跃 task thread」radar: in_progress / in_review Task Threads of the response's scope, newest activity first. With `includeCatalog` that is every such Thread in the reader's authorized Projects of this Workspace; otherwise only those the catalog carries. Independent of participation and unread state, so re-entry and pre-claim checks do not mistake in-flight work for a conflict. */
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
  | { readonly kind: 'project'; readonly projectRef: AgentTeamProjectRef }
  | { readonly kind: 'thread'; readonly threadRef: AgentTeamThreadRef }
  /** Presence-only lifecycle wake (Agent running/idle/failure) with no ledger commit: members/presence subscribers refresh, while workspace catalog and scope-less Inbox subscribers stay parked. */
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
  readonly projectCount: number
  readonly agentMemberCount: number
  readonly humanMemberId: AgentTeamMemberId
  /** Validation rules version the ledger has adopted; Project owners exist from version 2. */
  readonly rulesVersion: number
}
