import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  AgentTeamActivity,
  AgentTeamActivityMarker,
  AgentTeamActivityRef,
  AgentTeamAddMemberRequest,
  AgentTeamMainActivity,
  AgentTeamMainMarker,
  AgentTeamMainMessage,
  AgentTeamMainMessagePostedOperation,
  AgentTeamMainMessageMarker,
  AgentTeamMainActivityMarker,
  AgentTeamMainStreamHistory,
  AgentTeamMainStreamHistoryRequest,
  AgentTeamMainStreamReadOperation,
  AgentTeamMainStreamReadRequest,
  AgentTeamMainStreamReadResult,
  AgentTeamMainStreamStanding,
  AgentTeamMainThreadCard,
  AgentTeamMainTimelineEntry,
  AgentTeamMainUnreadRequired,
  AgentTeamPostMainMessageCommittedResult,
  AgentTeamPostMainMessageRequest,
  AgentTeamPostMainMessageResult,
  AgentTeamStartThreadRequest,
  AgentTeamStartThreadResult,
  AgentTeamThreadStartedOperation,
  AgentTeamAttachmentId,
  AgentTeamAgentMember,
  AgentTeamActor,
  AgentTeamArchiveProjectRequest,
  AgentTeamArchiveProjectResult,
  AgentTeamArchiveMemberRequest,
  AgentTeamArchiveMemberResult,
  AgentTeamProject,
  AgentTeamChangeScope,
  AgentTeamProjectArchivedOperation,
  AgentTeamProjectCreatedOperation,
  AgentTeamProjectMemberAddedOperation,
  AgentTeamProjectMemberRemovedOperation,
  AgentTeamProjectRef,
  AgentTeamProjectUpdatedOperation,
  AgentTeamReleaseSnapshot,
  AgentTeamClaim,
  AgentTeamClaimActivity,
  AgentTeamClaimsReleasedActivity,
  AgentTeamClaimChangedOperation,
  AgentTeamClaimList,
  AgentTeamClaimRequest,
  AgentTeamClaimResult,
  AgentTeamClaimRef,
  AgentTeamConfirmationRequired,
  AgentTeamConfirmationToken,
  AgentTeamCreateProjectRequest,
  AgentTeamCreateProjectResult,
  AgentTeamDirectMarker,
  AgentTeamDmRequest,
  AgentTeamActiveTaskThread,
  AgentTeamDmResult,
  AgentTeamDmSentOperation,
  AgentTeamHostActor,
  AgentTeamHumanActor,
  AgentTeamInbox,
  AgentTeamInboxActor,
  AgentTeamInboxRequest,
  AgentTeamInboxDelta,
  AgentTeamInboxItem,
  AgentTeamInitializedOperation,
  AgentTeamJoinProjectRequest,
  AgentTeamJoinProjectResult,
  AgentTeamMemberActor,
  AgentTeamMemberAddedOperation,
  AgentTeamMemberArchivedOperation,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
  AgentTeamMemberRemovedOperation,
  AgentTeamMemberResumedOperation,
  AgentTeamMemberSessionRecycledOperation,
  AgentTeamRulesVersionAdoptedOperation,
  AgentTeamProjectOwnerAddedOperation,
  AgentTeamProjectOwnerRemovedOperation,
  AgentTeamMemberSuspendedOperation,
  AgentTeamMemberUpdatedOperation,
  AgentTeamMemberWorkspaceJoinedOperation,
  AgentTeamMemberWorkspaceLeftOperation,
  AgentTeamMessage,
  AgentTeamMessageRef,
  AgentTeamMessageSentOperation,
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamOperationReceipt,
  AgentTeamRemoveProjectMemberRequest,
  AgentTeamRemoveProjectMemberResult,
  AgentTeamJoinWorkspaceRequest,
  AgentTeamJoinWorkspaceResult,
  AgentTeamLeaveWorkspaceRequest,
  AgentTeamLeaveWorkspaceResult,
  AgentTeamRemoveMemberRequest,
  AgentTeamRemoveMemberResult,
  AgentTeamReplyRequest,
  AgentTeamReplyResult,
  AgentTeamRequestId,
  AgentTeamResolvedMessageRef,
  AgentTeamReadMessageRequest,
  AgentTeamReadMessageResult,
  AgentTeamResolvedTaskRef,
  AgentTeamResolvedThreadRef,
  AgentTeamMessageAttachment,
  AgentTeamSendMessageRequest,
  AgentTeamSendMessageResult,
  AgentTeamSetMemberStateRequest,
  AgentTeamStaleRevision,
  AgentTeamStatus,
  AgentTeamStoredMessage,
  AgentTeamStoredThreadFact,
  AgentTeamTask,
  AgentTeamTaskActivity,
  AgentTeamTaskChangedOperation,
  AgentTeamTaskRequest,
  AgentTeamTaskResult,
  AgentTeamTaskRef,
  AgentTeamThread,
  AgentTeamThreadAttention,
  AgentTeamThreadAttentionChangedOperation,
  AgentTeamThreadAttentionKey,
  AgentTeamThreadAttentionRequest,
  AgentTeamThreadAttentionResult,
  AgentTeamThreadAttentionStatus,
  AgentTeamThreadFact,
  AgentTeamThreadHistory,
  AgentTeamThreadHistoryRequest,
  AgentTeamThreadReadFact,
  AgentTeamThreadReadData,
  AgentTeamThreadReadOperation,
  AgentTeamThreadReadReceipt,
  AgentTeamThreadReadRequest,
  AgentTeamThreadReadResult,
  AgentTeamThreadReadSnapshot,
  AgentTeamThreadObservations,
  AgentTeamThreadObservationsRequest,
  AgentTeamThreadRef,
  AgentTeamThreadPromotedOperation,
  AgentTeamPromoteThreadRequest,
  AgentTeamPromoteThreadResult,
  AgentTeamThreadRepliedOperation,
  AgentTeamUnreadRequired,
  AgentTeamUpdateProjectRequest,
  AgentTeamProjectOwnerRequest,
  AgentTeamProjectOwnerResult,
  AgentTeamUpdateProjectResult,
  AgentTeamUpdateMemberRequest,
  AgentTeamView,
  AgentTeamViewRequest,
} from './types.ts'
import { formatTeamTimestamp } from './time-format.ts'
import { resolveBodyMentions } from './mentions.ts'
import { recoveryFor } from './recovery-hints.ts'
import type { AgentTeamBodyMentionCandidate } from './mentions.ts'

/** Stable Human Member identity shared by every replay of one dshHome Team. */
export const AGENT_TEAM_HUMAN_MEMBER_ID = 'member:human' as AgentTeamMemberId

/**
 * The handle the Human is addressed by in Message bodies. The body parser and
 * the Member directory both read this one constant, so a configurable display
 * name has a single place to land instead of a hard-coded literal per surface.
 */
export const AGENT_TEAM_HUMAN_HANDLE = 'human'

/** Idempotency identity of the one Host bootstrap operation. */
export const AGENT_TEAM_INITIALIZE_REQUEST_ID = 'agent-team:initialize:v1' as AgentTeamRequestId

const HUMAN_ACTOR: AgentTeamHumanActor = Object.freeze({
  kind: 'human',
  memberId: AGENT_TEAM_HUMAN_MEMBER_ID,
  handle: AGENT_TEAM_HUMAN_HANDLE,
})

/** Resolve the one Human authority owned by this Team. */
export function agentTeamHumanActor(): AgentTeamHumanActor {
  return HUMAN_ACTOR
}

const HOST_ACTOR: AgentTeamHostActor = Object.freeze({ kind: 'host', handle: 'agent-team' })

/** Highest validation-rules version this build implements; a ledger segment without a marker is version 1. */
export const AGENT_TEAM_RULES_VERSION = 1

/**
 * Rules version still under construction. Only an explicit preview opt-in adopts it, because its rules may still
 * change: a ledger that adopted it can stop replaying on a later build, and no build without the opt-in opens it.
 */
export const AGENT_TEAM_PREVIEW_RULES_VERSION = 2
export const AGENT_TEAM_PREVIEW_RULES_ENV = 'DSH_AGENT_TEAM_PREVIEW_RULES'

function freezeActor(actor: AgentTeamActor): AgentTeamActor {
  if (actor.kind === 'host') return Object.freeze({ kind: 'host', handle: actor.handle })
  if (actor.kind === 'human') return Object.freeze({ kind: 'human', memberId: actor.memberId, handle: actor.handle })
  return Object.freeze({ kind: 'member', memberId: actor.memberId, handle: actor.handle })
}

export function agentTeamHostActor(): AgentTeamHostActor {
  return HOST_ACTOR
}

/** Caller-owned payload of the idempotent Team initialization request. */
export interface AgentTeamInitializeRequest {
  readonly requestId: AgentTeamRequestId
  readonly actor: AgentTeamHumanActor
  readonly humanMemberId: AgentTeamMemberId
}

export interface AgentTeamAuthorizedCreateProjectRequest extends AgentTeamCreateProjectRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedAddMemberRequest extends AgentTeamAddMemberRequest {
  readonly actor: AgentTeamHumanActor
  readonly member: AgentTeamAgentMember
}

export interface AgentTeamAuthorizedSetMemberStateRequest extends AgentTeamSetMemberStateRequest {
  readonly actor: AgentTeamHumanActor
}

/** Host-authorized recycling of one cold Member generation onto a fresh Session. */
export interface AgentTeamAuthorizedRecycleMemberSessionRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
  readonly actor: AgentTeamHostActor
  readonly previousSessionId: SessionId
  readonly newSessionId: SessionId
  readonly inputFromSeq?: SessionLogOffset
}

export interface AgentTeamAuthorizedJoinProjectRequest extends AgentTeamJoinProjectRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedRemoveProjectMemberRequest extends AgentTeamRemoveProjectMemberRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedJoinWorkspaceRequest extends AgentTeamJoinWorkspaceRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedLeaveWorkspaceRequest extends AgentTeamLeaveWorkspaceRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedSendMessageRequest extends AgentTeamSendMessageRequest {
  readonly actor: AgentTeamHumanActor | AgentTeamMemberActor
  /** Metadata the Host resolved from the attachment cache before the append. */
  readonly resolvedAttachments?: readonly AgentTeamMessageAttachment[] | undefined
}

export interface AgentTeamAuthorizedPostMainMessageRequest extends AgentTeamPostMainMessageRequest {
  readonly actor: AgentTeamHumanActor | AgentTeamMemberActor
  readonly resolvedAttachments?: readonly AgentTeamMessageAttachment[] | undefined
}

export interface AgentTeamAuthorizedStartThreadRequest extends AgentTeamStartThreadRequest {
  readonly actor: AgentTeamHumanActor | AgentTeamMemberActor
  readonly resolvedAttachments?: readonly AgentTeamMessageAttachment[] | undefined
}

export interface AgentTeamAuthorizedMainStreamReadRequest extends AgentTeamMainStreamReadRequest {
  readonly actor: AgentTeamHumanActor | AgentTeamMemberActor
}

export interface AgentTeamAuthorizedReplyRequest extends AgentTeamReplyRequest {
  readonly actor: AgentTeamHumanActor | AgentTeamMemberActor
  /** Metadata the Host resolved from the attachment cache before the append. */
  readonly resolvedAttachments?: readonly AgentTeamMessageAttachment[] | undefined
}

export interface AgentTeamAuthorizedClaimRequest extends AgentTeamClaimRequest {
  readonly actor: AgentTeamHumanActor | AgentTeamMemberActor
}

export interface AgentTeamAuthorizedTaskRequest extends AgentTeamTaskRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedPromoteThreadRequest extends AgentTeamPromoteThreadRequest {
  /** A Member actor is judged against the rules version: only Project owners may promote from version 2, and nobody but the Human before. */
  readonly actor: AgentTeamHumanActor | AgentTeamMemberActor
}

export interface AgentTeamAuthorizedThreadAttentionRequest extends AgentTeamThreadAttentionRequest {
  readonly actor: AgentTeamHumanActor | AgentTeamMemberActor
}

export interface AgentTeamAuthorizedThreadReadRequest extends AgentTeamThreadReadRequest {
  readonly actor: AgentTeamHumanActor | AgentTeamMemberActor
}

export interface AgentTeamAuthorizedRemoveMemberRequest extends AgentTeamRemoveMemberRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedArchiveMemberRequest extends AgentTeamArchiveMemberRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedUpdateProjectRequest extends AgentTeamUpdateProjectRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedProjectOwnerRequest extends AgentTeamProjectOwnerRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedArchiveProjectRequest extends AgentTeamArchiveProjectRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedUpdateMemberRequest extends AgentTeamUpdateMemberRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedDmRequest extends AgentTeamDmRequest {
  readonly actor: AgentTeamMemberActor
}

/** Construction hooks used to make durable operation creation deterministic in tests. */
export interface AgentTeamLedgerOptions {
  readonly operationId?: () => AgentTeamOperationId
  readonly occurredAt?: () => string
  readonly ref?: (kind: 'project' | 'message' | 'task' | 'thread' | 'claim' | 'activity') => string
  /**
   * Whether one unread fact is already on the named Member's model-visible
   * surface, in full. The Host supplies it: it owns the live Agent sessions,
   * the ledger owns durable state and must never reach into a runtime.
   *
   * Returning false refuses the write. A true answer exempts this one write
   * only: nothing is persisted, no watermark advances, no marker is consumed.
   */
  readonly isFactVisible?: ((memberId: AgentTeamMemberId, fact: AgentTeamThreadReadFact) => boolean) | undefined
  /** Highest rules version to adopt and accept; defaults to `AGENT_TEAM_RULES_VERSION`. */
  readonly rulesVersion?: number
}

/** Internal append result indicating whether this call committed a new record. */
export interface AgentTeamLedgerResult<T> {
  readonly value: T
  readonly committed: boolean
}

/**
 * Outcome of one Thread read. A read that committed always carries the receipt
 * of the operation it wrote; a read that committed nothing — an already-read
 * Thread — answers with the current picture instead, and only a retry of a
 * read that did commit still carries that original receipt.
 */
export type AgentTeamThreadReadOutcome =
  | { readonly value: AgentTeamThreadReadResult & { readonly receipt: AgentTeamOperationReceipt }; readonly committed: true }
  | { readonly value: AgentTeamThreadReadResult; readonly committed: false }

interface AgentTeamDurableMemberResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly member: AgentTeamAgentMember
}

export type { AgentTeamDurableMemberResult }

interface Confirmation {
  readonly actor: AgentTeamMemberId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef?: AgentTeamThreadRef
  readonly body: string
  readonly recipients: readonly AgentTeamMemberId[]
  /** Whether each recipient was following when confirmation was issued. */
  readonly attention: readonly boolean[]
  readonly memberStates: readonly AgentTeamAgentMember['state'][]
}

/**
 * Everything one Thread read durably claims, plus the projection state the
 * picture derivation needs. `unread` and `attentionBefore` are derivation
 * inputs, not durable content: the receipt written to the ledger is the
 * watermark, the Inbox delta and the Thread they belong to.
 */
interface PreparedReadReceipt {
  readonly task?: AgentTeamTask | undefined
  readonly thread: AgentTeamThread
  readonly unread: readonly AgentTeamThreadReadFact[]
  readonly attentionBefore?: AgentTeamThreadAttention | undefined
  readonly readThroughSequence: number
  readonly attention?: AgentTeamThreadAttention | undefined
  readonly consumedDirectMarkers: readonly AgentTeamDirectMarker[]
  readonly inbox: AgentTeamInboxDelta
}

interface PreparedRead extends PreparedReadReceipt {
  readonly claims: readonly AgentTeamClaim[]
  readonly anchor: AgentTeamMessage
  readonly anchorMentions: readonly AgentTeamMemberId[]
  readonly facts: readonly AgentTeamThreadReadFact[]
  readonly remainingUnreadCount: number
  readonly earlierFactCount: number
}

interface Projection {
  readonly byRequest: Map<AgentTeamRequestId, AgentTeamOperation>
  readonly byOperation: Map<AgentTeamOperationId, AgentTeamOperation>
  readonly ordered: AgentTeamOperation[]
  /** Committing instant per ledger sequence, so a fact's instant is a lookup rather than an index into `ordered`. */
  readonly occurredAtBySequence: Map<number, string>
  readonly projects: Map<AgentTeamProjectRef, AgentTeamProject>
  readonly members: Map<AgentTeamMemberId, AgentTeamAgentMember>
  /** Member ↔ Workspace participation relation: the Workspace authorization set, seeded by member-added with the Member's default Workspace. */
  readonly participations: Map<AgentTeamMemberId, Set<WorkspaceId>>
  readonly memberships: Map<AgentTeamProjectRef, Set<AgentTeamMemberId>>
  readonly claims: Map<AgentTeamClaimRef, AgentTeamClaim>
  readonly tasks: Map<AgentTeamTaskRef, AgentTeamTask>
  readonly threads: Map<AgentTeamThreadRef, AgentTeamThread>
  readonly attention: Map<string, AgentTeamThreadAttention>
  readonly directMarkers: Map<string, AgentTeamDirectMarker>
  readonly activityMarkers: Map<string, AgentTeamActivityMarker>
  /** Derived read indexes; rebuilt by replay, never a second durable authority. */
  readonly orderedFacts: AgentTeamThreadFact[]
  /** Claims per Task, in the order `claims` first took them: the bucket that keeps a per-Task read from walking every Claim. */
  readonly claimsByTask: Map<AgentTeamTaskRef, AgentTeamClaim[]>
  readonly factsByThread: Map<AgentTeamThreadRef, AgentTeamThreadFact[]>
  /** Owning Project of each Thread, established by the anchor Message and immutable afterwards. */
  readonly projectRefByThread: Map<AgentTeamThreadRef, AgentTeamProjectRef>
  /** Structured mention refs per Message, derived from the originating send operations. */
  readonly mentionsByMessage: Map<AgentTeamMessageRef, readonly AgentTeamMemberId[]>
  readonly messageCountByThread: Map<AgentTeamThreadRef, number>
  /** Ref index over the Message facts, written by `appendMessageFact` alone. */
  readonly messagesByRef: Map<AgentTeamMessageRef, AgentTeamMessage>
  readonly attentionByThread: Map<AgentTeamThreadRef, Set<AgentTeamMemberId>>
  readonly sessionTransitions: Map<AgentTeamMemberId, { readonly previousSessionId: SessionId; readonly inputFromSeq?: SessionLogOffset }>
  /** Top-level anchor Message per Thread; the first topLevel Message wins. */
  readonly anchorByThread: Map<AgentTeamThreadRef, AgentTeamMessage>
  /** Display ordinal per Task, in per-Project creation order; workspace filtering happens at read time. */
  readonly taskNumberByTask: Map<AgentTeamTaskRef, number>
  readonly taskCountByProject: Map<AgentTeamProjectRef, number>
  /** Threads each Member follows — the reverse of attentionByThread, for per-reader Inbox candidates. */
  readonly attentionThreadsByMember: Map<AgentTeamMemberId, Set<AgentTeamThreadRef>>
  /** Threads each Member has written a Message in; participation is what the recent slice admits. */
  readonly threadsByWriter: Map<AgentTeamMemberId, Set<AgentTeamThreadRef>>
  /** Direct markers bucketed per recipient Member and Thread, kept sorted by sequence. */
  readonly directMarkersByMember: Map<AgentTeamMemberId, Map<AgentTeamThreadRef, AgentTeamDirectMarker[]>>
  /** Activity markers bucketed per recipient Member and Thread, kept sorted by sequence. */
  readonly activityMarkersByMember: Map<AgentTeamMemberId, Map<AgentTeamThreadRef, AgentTeamActivityMarker[]>>
  /** Replay-order Attention observations per Thread, appended by committed Inbox deltas only. */
  readonly observationsByThread: Map<AgentTeamThreadRef, AgentTeamAttentionObservation[]>
  /** Rules version the next record is validated under: the newest marker replayed so far, else 1. */
  rulesVersion: number
  /** Agent owners per Project with the sequence that made each one an owner; the Human owns every Project and is never stored. */
  readonly owners: Map<AgentTeamProjectRef, Map<AgentTeamMemberId, number>>
  /** Members named by a mention anywhere in each Project; one input to rules-version-2 Project membership. */
  readonly mentionedByProject: Map<AgentTeamProjectRef, Set<AgentTeamMemberId>>
  /** Main stream entries per Project in ledger order: Messages, owner Activities, and one card source per Thread anchor. */
  readonly mainSourcesByProject: Map<AgentTeamProjectRef, MainSource[]>
  /** Main Messages and Activities by their ref, for marker validation and reply targets. */
  readonly mainSourceByRef: Map<string, MainSource>
  readonly mainMarkers: Map<string, AgentTeamMainMarker>
  /** Main stream markers bucketed per recipient Member and Project, kept sorted by sequence. */
  readonly mainMarkersByMember: Map<AgentTeamMemberId, Map<AgentTeamProjectRef, AgentTeamMainMarker[]>>
  /** Owner read watermark per `member|project`; only owners hold one. */
  readonly mainWatermarks: Map<string, number>
  /** Sequence of the marker that adopted rules version 2 (0 before it): the earliest the Human's Main stream unread can start. */
  humanOwnerFloor: number
}

/** Kinds a rules-version-1 segment rejects (owner operations carry their own check), and the one kind version 2 stops writing. */
const V2_ONLY_KINDS: readonly string[] = ['team/main-message-posted', 'team/main-stream-read', 'team/thread-started']
const REPLACED_AT_V2_KINDS: readonly string[] = ['team/message-sent']

/** One entry of a reader's unread Main stream: why it is unread (ordinary owner unread, a marker, or both). */
interface MainUnreadItem {
  readonly source: MainSource
  readonly ordinary: boolean
  readonly direct: boolean
}

/** Entries a Main stream read answers with; the read still acknowledges everything through its sequence. */
const MAIN_READ_PAGE_SIZE = 20

/** One Main stream entry before projection into a timeline entry. A Thread source is a card; `unreadable` marks the v2 discussion anchors that count as unread. */
type MainSource =
  | { readonly kind: 'message'; readonly sequence: number; readonly message: AgentTeamMainMessage }
  | { readonly kind: 'activity'; readonly sequence: number; readonly activity: AgentTeamMainActivity }
  | { readonly kind: 'thread'; readonly sequence: number; readonly threadRef: AgentTeamThreadRef; readonly unreadable: boolean }

/** Minimal replay-time Attention observation; the read projection adds the current Task ref. */
interface AgentTeamAttentionObservation {
  readonly sequence: number
  readonly memberId: AgentTeamMemberId
  readonly action: 'follow' | 'unfollow'
}

/**
 * Operation kinds whose durable record is history alone: they must replay, but
 * they move no projection state, so replay skips them after indexing the
 * operation itself. The predicate form is load-bearing — the exhaustiveness
 * assert at the end of `applyTo` only accepts the kinds this excludes if the
 * check narrows the operation itself, not merely its `kind`.
 */
const AUDIT_ONLY_KINDS = [
  'team/member-session-restarted',
  'team/member-context-cleared',
  'team/dm-sent',
] as const satisfies readonly AgentTeamOperation['kind'][]

function isAuditOnlyOperation(operation: AgentTeamOperation): operation is Extract<AgentTeamOperation, { kind: typeof AUDIT_ONLY_KINDS[number] }> {
  return (AUDIT_ONLY_KINDS as readonly string[]).includes(operation.kind)
}

function emptyProjection(): Projection {
  return { byRequest: new Map(), byOperation: new Map(), ordered: [], occurredAtBySequence: new Map(), projects: new Map(), members: new Map(), participations: new Map(), memberships: new Map(),
    claims: new Map(), tasks: new Map(), threads: new Map(), attention: new Map(), directMarkers: new Map(), activityMarkers: new Map(),
    orderedFacts: [], claimsByTask: new Map(), factsByThread: new Map(), projectRefByThread: new Map(), mentionsByMessage: new Map(), messageCountByThread: new Map(),
    messagesByRef: new Map(),
    attentionByThread: new Map(), sessionTransitions: new Map(),
    anchorByThread: new Map(), taskNumberByTask: new Map(), taskCountByProject: new Map(), attentionThreadsByMember: new Map(),
    threadsByWriter: new Map(),
    directMarkersByMember: new Map(), activityMarkersByMember: new Map(), observationsByThread: new Map(), rulesVersion: 1, owners: new Map(), mentionedByProject: new Map(),
    mainSourcesByProject: new Map(), mainSourceByRef: new Map(), mainMarkers: new Map(), mainMarkersByMember: new Map(), mainWatermarks: new Map(), humanOwnerFloor: 0 }
}

/** Exhaustiveness guard for the closed operation union: adding a kind must update every dispatch. */
function assertUnhandledKind(operation: never): never {
  throw new Error(`agent-team ledger does not handle operation kind '${(operation as AgentTeamOperation).kind}'`)
}

/**
 * Opening-line gist: the first line, trimmed, then cut to `max` characters
 * with an explicit mark.
 */
function boundedOpeningLine(body: string, max: number): string {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine
}

/**
 * The one-line gist bound shared by the Inbox row, the Task title the Thread page renders, and a quote's excerpt of its parent Message.
 */
const ONE_LINE_GIST_MAX_CHARACTERS = 120

/** A chip shares its line with prose, so the gist bound above would crowd the message out. */
const THREAD_CHIP_TITLE_MAX_CHARACTERS = 40

/**
 * How many Threads one Workspace's 「最近活跃」 slice may carry. It bounds what
 * the Host hands over, not what the reader sees: the Client merges every
 * visible Workspace's slice and trims the merged list to its own visible bound
 * (`RECENT_ROWS_LIMIT`), which must stay at or below this one so no Workspace
 * is cut short before the merge. The unread slice keeps its own `limit`
 * request field.
 */
const RECENT_INBOX_LIMIT = 10

/**
 * Whether one operation's Inbox delta would change nothing. A read that finds
 * no unread fact for its reader and no marker to consume produces exactly this
 * delta, which is why such a read is a no-op rather than a durable operation.
 */
function isEmptyInboxDelta(delta: AgentTeamInboxDelta): boolean {
  return delta.attention.set.length === 0 && delta.attention.removed.length === 0
    && delta.directMarkers.added.length === 0 && delta.directMarkers.removed.length === 0
    && delta.activityMarkers.added.length === 0 && delta.activityMarkers.removed.length === 0
    && (delta.mainMarkers === undefined || (delta.mainMarkers.added.length === 0 && delta.mainMarkers.removed.length === 0))
}

function mainMarkerKey(marker: AgentTeamMainMarker): string {
  return `${marker.memberId}|${marker.projectRef}|${'messageRef' in marker ? marker.messageRef : marker.activityRef}`
}

function mainWatermarkKey(memberId: AgentTeamMemberId, projectRef: AgentTeamProjectRef): string {
  return `${memberId}|${projectRef}`
}

export function isThreadReadSnapshot(data: AgentTeamThreadReadData): data is AgentTeamThreadReadSnapshot {
  return 'thread' in data
}

/** The Thread and optional Task one read targeted, whichever form the record holds. */
export function threadReadTargetOf(data: AgentTeamThreadReadData): { readonly threadRef: AgentTeamThreadRef; readonly taskRef?: AgentTeamTaskRef | undefined } {
  return isThreadReadSnapshot(data)
    ? { threadRef: data.thread.threadRef, ...(data.task === undefined ? {} : { taskRef: data.task.taskRef }) }
    : { threadRef: data.threadRef, ...(data.taskRef === undefined ? {} : { taskRef: data.taskRef }) }
}

/** Deep-freeze a Member capability overlay; absent stays absent. */
function freezeCapabilities(capabilities: AgentTeamMemberCapabilities | undefined): { capabilities?: AgentTeamMemberCapabilities } {
  if (capabilities === undefined) return {}
  const freezeAllow = (allow: readonly string[] | undefined): { allow?: readonly string[] } =>
    allow === undefined ? {} : { allow: Object.freeze([...allow]) }
  return {
    capabilities: Object.freeze({
      ...(capabilities.tools === undefined ? {} : { tools: Object.freeze(freezeAllow(capabilities.tools.allow)) }),
      ...(capabilities.skills === undefined ? {} : { skills: Object.freeze(freezeAllow(capabilities.skills.allow)) }),
    }),
  }
}


/** Replay and append logic behind the Agent Team service interface. */
export class AgentTeamLedger {
  /** Live projection; record validation replays build independent Projection values instead. */
  private readonly state: Projection = emptyProjection()
  private readonly confirmations = new Map<AgentTeamConfirmationToken, Confirmation>()
  private readonly createOperationId: () => AgentTeamOperationId
  private readonly createOccurredAt: () => string
  private readonly createRef: (kind: 'project' | 'message' | 'task' | 'thread' | 'claim' | 'activity') => string
  /** Host-supplied surface visibility probe; absent means no write is ever exempt. */
  private readonly isFactVisible?: ((memberId: AgentTeamMemberId, fact: AgentTeamThreadReadFact) => boolean) | undefined
  private readonly rulesVersion: number
  private operationTail: Promise<void> = Promise.resolve()
  /**
   * Runtime human display name. Durable identity stays `member:human`; only
   * the handle read by @ matching and handle-uniqueness follows this value.
   * The Host syncs it from the `agent-team-human` settings namespace; the
   * ledger never persists it, so a rename affects only later resolutions.
   */
  private humanHandle: string = AGENT_TEAM_HUMAN_HANDLE
  /**
   * Head of the durable records the constructor's record-level replay
   * validated, adoptable once by the invariant mount. See `validateAtMount`.
   */
  private bootValidation: { readonly records: number; readonly lastSequence: number; readonly lastOperationId: AgentTeamOperationId | null } | undefined
  /**
   * Sequence of the newest committed record that invalidated the shared
   * projection — the durable position the Client's change cursors compare
   * against, rebuilt by replay like every other index.
   *
   * Records whose commit is private read progress or audit-only
   * (`changeScopesOf` derives no scope for them) never move it, so one
   * Member's Thread read cannot make a parked Client believe that something it
   * watches changed. Being a ledger position rather than a process counter, it
   * also stays monotone across a restart.
   */
  private projectionVersion = 0

  constructor(
    private readonly table: KvTable<AgentTeamOperationId, AgentTeamOperation>,
    options: AgentTeamLedgerOptions = {},
  ) {
    this.createOperationId = options.operationId ?? (() => `operation:${randomUUID()}` as AgentTeamOperationId)
    this.createOccurredAt = options.occurredAt ?? (() => new Date().toISOString())
    this.createRef = options.ref ?? (kind => `${kind}:${randomUUID()}`)
    this.isFactVisible = options.isFactVisible
    this.rulesVersion = options.rulesVersion ?? AGENT_TEAM_RULES_VERSION
    this.replay()
    const head = this.state.ordered.at(-1)
    this.bootValidation = Object.freeze({
      records: this.state.ordered.length,
      lastSequence: head?.sequence ?? 0,
      lastOperationId: head?.operationId ?? null,
    })
  }

  /** Current human display name for @ matching and uniqueness checks. */
  humanDisplayHandle(): string {
    return this.humanHandle
  }

  /**
   * Sync the runtime human display name from Host settings. Never persisted:
   * a rename affects only later @ resolutions and handle checks.
   */
  setHumanDisplayHandle(handle: string): void {
    const name = handle.normalize('NFKC').trim()
    if (name !== '') this.humanHandle = name
  }

  initialize(request: AgentTeamInitializeRequest = {
    requestId: AGENT_TEAM_INITIALIZE_REQUEST_ID,
    actor: HUMAN_ACTOR,
    humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID,
  }): Promise<AgentTeamLedgerResult<AgentTeamOperationReceipt>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameInitialization(existing, request)
        await this.adoptRulesVersion()
        return this.resolved(this.receipt(existing))
      }
      if (this.state.ordered.length !== 0) throw new Error('agent-team ledger has operations but no initialization request')
      const operation: AgentTeamInitializedOperation = Object.freeze({
        sequence: 1,
        operationId: this.createOperationId(),
        requestId: request.requestId,
        occurredAt: this.createOccurredAt(),
        actor: Object.freeze({ ...request.actor }),
        previousOperationId: null,
        kind: 'team/initialized',
        data: Object.freeze({ humanMemberId: request.humanMemberId }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      await this.adoptRulesVersion()
      return this.committed(this.receipt(operation))
    })
  }

  /**
   * Append the marker for a rules version this build implements but the ledger has not adopted.
   * It runs inside initialize's queued task, so it precedes every later write — startup recovery's included.
   */
  private async adoptRulesVersion(): Promise<void> {
    if (this.state.rulesVersion >= this.rulesVersion) return
    const operation: AgentTeamRulesVersionAdoptedOperation = Object.freeze({
      ...this.operationBase({ requestId: `agent-team:rules-version-${this.rulesVersion}` as AgentTeamRequestId, actor: HOST_ACTOR }, this.nextSequence()),
      kind: 'team/rules-version-adopted',
      actor: HOST_ACTOR,
      data: Object.freeze({ version: this.rulesVersion }),
    })
    await this.table.put(operation.operationId, operation)
    this.applyAndAdvanceProjectionVersion(operation)
  }

  createProject(request: AgentTeamAuthorizedCreateProjectRequest): Promise<AgentTeamLedgerResult<AgentTeamCreateProjectResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameProjectCreation(existing, request, this.normalizeUnique(request.memberIds, 'initial Project members'))
        return this.resolved(this.projectResult(existing))
      }
      this.assertHumanActor(request.actor)
      const name = request.name.trim()
      const description = request.description.trim()
      if (name === '') throw new Error('project name must not be empty')
      const memberIds = this.normalizeUnique(request.memberIds, 'initial Project members')
      for (const memberId of memberIds) this.assertJoinableMember(request.workspaceId, memberId)
      const sequence = this.nextSequence()
      const project: AgentTeamProject = Object.freeze({
        projectRef: this.ref('project'), workspaceId: request.workspaceId, name, description, createdAtSequence: sequence, state: 'active' as const,
      })
      const operation: AgentTeamProjectCreatedOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind: 'team/project-created',
        data: Object.freeze({ workspaceId: request.workspaceId, project, memberIds }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.projectResult(operation))
    })
  }

  /** Human rename of one Project's display facts; identity refs are immutable. */
  updateProject(request: AgentTeamAuthorizedUpdateProjectRequest): Promise<AgentTeamLedgerResult<AgentTeamUpdateProjectResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameProjectUpdate(existing, request)
        return this.resolved(this.projectUpdateResult(existing))
      }
      this.assertHumanActor(request.actor)
      const name = request.name.trim()
      const description = request.description.trim()
      if (name === '') throw new Error('project name must not be empty')
      const project = Object.freeze({ ...this.requireActiveProject(request.workspaceId, request.projectRef), name, description })
      const operation: AgentTeamProjectUpdatedOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/project-updated',
        data: Object.freeze({ workspaceId: request.workspaceId, project }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.projectUpdateResult(operation))
    })
  }

  addProjectOwner(request: AgentTeamAuthorizedProjectOwnerRequest): Promise<AgentTeamLedgerResult<AgentTeamProjectOwnerResult>> {
    return this.changeProjectOwner(request, 'team/project-owner-added')
  }

  removeProjectOwner(request: AgentTeamAuthorizedProjectOwnerRequest): Promise<AgentTeamLedgerResult<AgentTeamProjectOwnerResult>> {
    return this.changeProjectOwner(request, 'team/project-owner-removed')
  }

  private changeProjectOwner(
    request: AgentTeamAuthorizedProjectOwnerRequest,
    kind: 'team/project-owner-added' | 'team/project-owner-removed',
  ): Promise<AgentTeamLedgerResult<AgentTeamProjectOwnerResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        if (existing.kind !== kind || !this.sameActor(existing.actor, request.actor) || existing.data.workspaceId !== request.workspaceId
          || existing.data.projectRef !== request.projectRef || existing.data.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
        return this.resolved(this.projectOwnerResult(existing))
      }
      this.assertHumanActor(request.actor)
      const base = { workspaceId: request.workspaceId, projectRef: request.projectRef, memberId: request.memberId }
      const problem = this.projectOwnerChangeProblem(this.state, kind, base)
      if (problem !== undefined) throw new Error(problem)
      const sequence = this.nextSequence()
      const envelope = this.operationBase(request, sequence)
      const activity: AgentTeamMainActivity = Object.freeze({ activityRef: this.ref('activity'), projectRef: request.projectRef,
        kind: kind === 'team/project-owner-added' ? 'owner-added' as const : 'owner-removed' as const,
        memberId: request.memberId, actor: request.actor.memberId, sequence, occurredAt: envelope.occurredAt })
      const data = Object.freeze({ ...base, activity, inbox: this.ownerActivityInboxDelta(activity) })
      const operation: AgentTeamProjectOwnerAddedOperation | AgentTeamProjectOwnerRemovedOperation = Object.freeze({
        ...envelope, kind, data,
      }) as AgentTeamProjectOwnerAddedOperation | AgentTeamProjectOwnerRemovedOperation
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.projectOwnerResult(operation))
    })
  }

  /** The one owner-change rule, judged against the live projection on write and the replay projection on load. */
  private projectOwnerChangeProblem(
    projection: Projection,
    kind: 'team/project-owner-added' | 'team/project-owner-removed',
    data: { readonly workspaceId: WorkspaceId; readonly projectRef: AgentTeamProjectRef; readonly memberId: AgentTeamMemberId },
  ): string | undefined {
    if (projection.rulesVersion < 2) return `Project owners need rules version 2; this ledger runs version ${projection.rulesVersion}`
    const project = projection.projects.get(data.projectRef)
    if (project === undefined || project.workspaceId !== data.workspaceId) return `unknown Project '${data.projectRef}' in Workspace '${data.workspaceId}'`
    if (project.state === 'archived') return `Project '${data.projectRef}' is archived and no longer accepts Team work`
    if (data.memberId === AGENT_TEAM_HUMAN_MEMBER_ID) {
      return kind === 'team/project-owner-added' ? 'the Human already owns every Project' : 'the Human owns every Project and cannot be removed'
    }
    const owned = projection.owners.get(data.projectRef)?.has(data.memberId) === true
    if (kind === 'team/project-owner-removed') return owned ? undefined : `Agent Member '${data.memberId}' does not own Project '${data.projectRef}'`
    const member = projection.members.get(data.memberId)
    if (member === undefined) return `unknown Agent Member '${data.memberId}'`
    if (member.state !== 'enabled' && member.state !== 'suspended') return `Agent Member '${member.handle}' is ${member.state} and cannot own a Project`
    if (!this.participatesInFrom(projection, member.memberId, project.workspaceId)) return `Agent Member '${member.handle}' does not participate in Workspace '${project.workspaceId}'`
    if (owned) return `Agent Member '${member.handle}' already owns Project '${data.projectRef}'`
    return undefined
  }

  addMember(request: AgentTeamAuthorizedAddMemberRequest): Promise<AgentTeamLedgerResult<AgentTeamDurableMemberResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameMemberAdd(existing, request)
        return this.resolved(this.memberResult(existing))
      }
      this.assertHumanActor(request.actor)
      const handle = request.handle.trim()
      const description = request.description.trim()
      const presetId = request.presetId.trim()
      if (handle === '') throw new Error('member handle must not be empty')
      if (presetId === '') throw new Error('member preset must not be empty')
      // Description and initial Projects are optional: a Member with neither is
      // still drivable through its DM view, and joins Projects later.
      const projectRefs = this.normalizeUnique(request.projectRefs, 'initial Member Projects')
      for (const projectRef of projectRefs) this.requireActiveProject(request.workspaceId, projectRef)
      this.assertHandleAvailable(request.workspaceId, handle)
      this.assertModelSelection(request.member.model)
      this.assertCapabilities(request.member.capabilities)
      const member = Object.freeze({
        ...request.member, handle, description, presetId, state: 'enabled' as const,
        ...(request.member.model === undefined ? {} : { model: Object.freeze({ ...request.member.model }) }),
        ...freezeCapabilities(request.member.capabilities),
      })
      const operation: AgentTeamMemberAddedOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/member-added',
        data: Object.freeze({ member, projectRefs }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.memberResult(operation))
    })
  }

  /** Human edit of one Member's mutable facts; identity, preset, and lifecycle state are preserved. */
  updateMember(request: AgentTeamAuthorizedUpdateMemberRequest): Promise<AgentTeamLedgerResult<AgentTeamDurableMemberResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameMemberUpdate(existing, request)
        return this.resolved(this.memberResult(existing))
      }
      this.assertHumanActor(request.actor)
      const prior = this.requireMember(request.memberId)
      if (prior.state === 'inactive') throw new Error(`Agent Member '${prior.memberId}' is inactive and can no longer be edited`)
      if (prior.state === 'archived') throw new Error(`Agent Member '${prior.memberId}' is archived and can no longer be edited`)
      const handle = request.handle.trim()
      const description = request.description.trim()
      if (handle === '') throw new Error('member handle must not be empty')
      if (handle !== prior.handle) for (const workspaceId of this.workspacesOf(prior.memberId)) this.assertHandleAvailable(workspaceId, handle, prior.memberId)
      this.assertModelSelection(request.model)
      this.assertCapabilities(request.capabilities)
      const nextModel = request.model === undefined ? prior.model
        : request.model === null ? undefined : Object.freeze({ ...request.model })
      const nextCapabilities = request.capabilities === undefined ? prior.capabilities
        : request.capabilities === null ? undefined : request.capabilities
      // Both overlays come off `prior` before being re-added, or a cleared field
      // would survive in the spread and the null branch would do nothing.
      const { model: _priorModel, capabilities: _priorCapabilities, ...priorWithoutOverlays } = prior
      const member = Object.freeze({
        ...priorWithoutOverlays, handle, description,
        ...(nextModel === undefined ? {} : { model: nextModel }),
        ...freezeCapabilities(nextCapabilities),
      })
      const operation: AgentTeamMemberUpdatedOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/member-updated',
        data: Object.freeze({ member }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.memberResult(operation))
    })
  }

  suspendMember(request: AgentTeamAuthorizedSetMemberStateRequest): Promise<AgentTeamLedgerResult<AgentTeamDurableMemberResult>> {
    return this.setMemberState(request, 'suspended')
  }

  resumeMember(request: AgentTeamAuthorizedSetMemberStateRequest): Promise<AgentTeamLedgerResult<AgentTeamDurableMemberResult>> {
    return this.setMemberState(request, 'enabled')
  }

  /** Move one enabled Member from a cold generation onto a fresh Session. */
  recycleMemberSession(request: AgentTeamAuthorizedRecycleMemberSessionRequest): Promise<AgentTeamLedgerResult<AgentTeamDurableMemberResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameMemberSessionRecycled(existing, request)
        return this.resolved(this.memberResult(existing))
      }
      if (request.actor.kind !== 'host') throw new Error('Member session recycling requires Host authority')
      if (request.inputFromSeq !== undefined && (!Number.isSafeInteger(request.inputFromSeq) || request.inputFromSeq < 0)) throw new Error('Member session recycling requires a non-negative input log offset')
      const prior = this.requireMember(request.memberId)
      if (prior.state !== 'enabled') throw new Error(`Agent Member '${prior.handle}' is ${prior.state}; only enabled Members can recycle their Session`)
      if (prior.sessionId !== request.previousSessionId) throw new Error(`Agent Member '${prior.handle}' is no longer bound to Session '${request.previousSessionId}'`)
      if (request.newSessionId === request.previousSessionId) throw new Error(`Agent Member '${prior.handle}' already runs Session '${request.newSessionId}'`)
      const member = Object.freeze({ ...prior, sessionId: request.newSessionId })
      const operation: AgentTeamMemberSessionRecycledOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/member-session-recycled',
        actor: Object.freeze({ ...request.actor }),
        data: Object.freeze({ member, previousSessionId: request.previousSessionId, newSessionId: request.newSessionId,
          ...(request.inputFromSeq === undefined ? {} : { inputFromSeq: request.inputFromSeq }) }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.memberResult(operation))
    })
  }

  getMember(memberId: AgentTeamMemberId): AgentTeamAgentMember | undefined {
    return this.state.members.get(memberId)
  }

  /**
   * The retired Session this Member most recently left through a swap — the
   * lineage parent a crash between the durable binding commit and the new
   * Session's activation recreates the successor from. Read from the audit
   * projection; the Member record itself only names the current Session.
   */
  previousSessionForMember(memberId: AgentTeamMemberId): SessionId | undefined {
    return this.state.sessionTransitions.get(memberId)?.previousSessionId
  }

  /**
   * The latest session transition this Member committed: the retired Session
   * and the target it moved onto. Crash recovery binds carried-input
   * redelivery to the recorded target — the CURRENT Session being that target
   * proves the old generation's unconsumed input still belongs here.
   */
  lastTransitionForMember(memberId: AgentTeamMemberId): { readonly previousSessionId: SessionId; readonly targetSessionId: SessionId; readonly inputFromSeq?: SessionLogOffset } | undefined {
    const transition = this.state.sessionTransitions.get(memberId)
    const member = this.state.members.get(memberId)
    if (transition === undefined || member === undefined) return undefined
    return { ...transition, targetSessionId: member.sessionId }
  }

  listMembers(): readonly AgentTeamAgentMember[] {
    return Object.freeze([...this.state.members.values()])
  }

  /**
   * Join one Agent Member to one additional Workspace. Participation is a
   * pure relation — no Session is created or moved; the Member's Session
   * stays rooted in its default Workspace and collaboration in the joined
   * Workspace is ledger work addressed by the workspaceId.
   */
  joinWorkspace(request: AgentTeamAuthorizedJoinWorkspaceRequest): Promise<AgentTeamLedgerResult<AgentTeamJoinWorkspaceResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameWorkspaceJoin(existing, request)
        return this.resolved(this.workspaceJoinResult(existing))
      }
      this.assertHumanActor(request.actor)
      const member = this.requireMember(request.memberId)
      if (member.state === 'inactive') throw new Error(`Agent Member '${member.memberId}' is inactive and cannot join a Workspace`)
      if (member.state === 'archived') throw new Error(`Agent Member '${member.memberId}' is archived and cannot join a Workspace`)
      if (this.participatesIn(member.memberId, request.workspaceId)) throw new Error(`Agent Member '${member.memberId}' already participates in Workspace '${request.workspaceId}'`)
      // Handles resolve per Workspace: a second live Member with the same
      // handle in the target would make mentions ambiguous there.
      this.assertHandleAvailable(request.workspaceId, member.handle)
      const operation: AgentTeamMemberWorkspaceJoinedOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/member-workspace-joined',
        data: Object.freeze({ workspaceId: request.workspaceId, memberId: member.memberId }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.workspaceJoinResult(operation))
    })
  }

  /**
   * Withdraw one Agent Member from one of its non-default Workspaces. The
   * default Workspace cannot be left — ending it is the archive path. Every
   * active Claim the Member holds on the Workspace's Threads releases with
   * public Activities, its Attention and markers on those Threads clear, and
   * its Project memberships there end; identity, Session, and remaining
   * participations are untouched.
   */
  leaveWorkspace(request: AgentTeamAuthorizedLeaveWorkspaceRequest): Promise<AgentTeamLedgerResult<AgentTeamLeaveWorkspaceResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameWorkspaceLeave(existing, request)
        return this.resolved(this.workspaceLeaveResult(existing))
      }
      this.assertHumanActor(request.actor)
      const member = this.requireMember(request.memberId)
      if (member.state === 'inactive') throw new Error(`Agent Member '${member.memberId}' is already inactive`)
      if (member.state === 'archived') throw new Error(`Agent Member '${member.memberId}' is already archived`)
      if (request.workspaceId === member.workspaceId) throw new Error(`Agent Member '${member.memberId}' cannot leave its default Workspace '${request.workspaceId}'; archive the Member instead`)
      if (!this.participatesIn(member.memberId, request.workspaceId)) throw new Error(`Agent Member '${member.memberId}' does not participate in Workspace '${request.workspaceId}'`)
      const threadRefs = this.workspaceThreadRefs(request.workspaceId)
      const releasedClaims = [...this.state.claims.values()]
        .filter(claim => claim.owner === member.memberId && claim.state === 'active' && threadRefs.has(claim.threadRef))
        .map(claim => Object.freeze({ ...claim, state: 'released' as const }))
      const projectedClaims = new Map(this.state.claims)
      for (const claim of releasedClaims) projectedClaims.set(claim.claimRef, claim)
      const sequence = this.nextSequence()
      const activities = this.releaseSummaries(releasedClaims, member.memberId, sequence)
      const threads = this.threadsForActivities(activities)
      const tasks = this.tasksForClaims(releasedClaims, projectedClaims)
      const inbox = this.removeMemberThreadInbox(member.memberId, threadRefs, this.workspaceProjectRefsFrom(this.state, request.workspaceId))
      const operation: AgentTeamMemberWorkspaceLeftOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind: 'team/member-workspace-left',
        data: Object.freeze({ workspaceId: request.workspaceId, memberId: member.memberId,
          claims: Object.freeze(releasedClaims), activities, tasks, threads, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.workspaceLeaveResult(operation))
    })
  }

  /**
   * Archive one Project: hidden from every surface, facts kept recoverable.
   * Every active Claim on the Project's Threads releases with one public
   * Activity per (owner, Thread), and every Member's Attention and markers
   * for those Threads clear — a hidden Project must not leave Tasks stuck in
   * progress behind it or phantom unread counts.
   */
  archiveProject(request: AgentTeamAuthorizedArchiveProjectRequest): Promise<AgentTeamLedgerResult<AgentTeamArchiveProjectResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameProjectArchival(existing, request)
        return this.resolved(this.projectArchivalResult(existing))
      }
      this.assertHumanActor(request.actor)
      const project = this.requireProject(request.workspaceId, request.projectRef)
      if (project.state === 'archived') throw new Error(`Project '${project.projectRef}' is already archived`)
      const nextProject = Object.freeze({ ...project, state: 'archived' as const })
      const threadRefs = this.projectThreadRefs(project.projectRef)
      const releasedClaims = [...this.state.claims.values()]
        .filter(claim => claim.state === 'active' && threadRefs.has(claim.threadRef))
        .map(claim => Object.freeze({ ...claim, state: 'released' as const }))
      const nextClaims = new Map(this.state.claims)
      for (const claim of releasedClaims) nextClaims.set(claim.claimRef, claim)
      const sequence = this.nextSequence()
      const owners = [...new Set(releasedClaims.map(claim => claim.owner))].sort()
      const activities = Object.freeze(owners.flatMap(owner => this.releaseSummaries(releasedClaims.filter(claim => claim.owner === owner), owner, sequence)))
      const threads = this.threadsForActivities(activities)
      const tasks = this.tasksForClaims(releasedClaims, nextClaims)
      const inbox = this.projectArchivalInbox(threadRefs, project.projectRef)
      const operation: AgentTeamProjectArchivedOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind: 'team/project-archived',
        data: Object.freeze({ workspaceId: request.workspaceId, project: nextProject,
          claims: Object.freeze(releasedClaims), activities, tasks, threads, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.projectArchivalResult(operation))
    })
  }

  sendMessage(request: AgentTeamAuthorizedSendMessageRequest): Promise<AgentTeamLedgerResult<AgentTeamSendMessageResult>> {
    return this.enqueue(async () => {
      const actor = this.assertActorForWorkspace(request.actor, request.workspaceId)
      const project = this.requireActiveProject(request.workspaceId, request.projectRef)
      if (actor.kind === 'member') this.requireMemberProject(this.requireMember(actor.memberId), project.projectRef)
      const body = request.body.trim()
      if (body === '') throw new Error('message body must not be empty')
      const recipients = this.mergeBodyMentions(actor.memberId, project.projectRef, body, this.normalizeRecipients(request.actor, request.recipients))
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameMessage(existing, request, recipients)
        return this.resolved(this.messageResult(existing))
      }
      if (this.state.rulesVersion >= 2) throw new Error('top-level sends are replaced by startThread from rules version 2')
      this.assertMentionTargets(project, recipients)
      // Top-level Task creation is open to every actor: mentioned Members join
      // the new Thread as followers. Only existing-Thread invitations stay
      // Human-gated (reply path).
      const sequence = this.nextSequence()
      const base = this.operationBase(request, sequence)
      const asTask = request.asTask === true
      const threadRef = this.ref('thread')
      const taskRef = asTask ? this.ref('task') : undefined
      const task = taskRef === undefined ? undefined
        : Object.freeze({ taskRef, projectRef: project.projectRef, threadRef, status: 'todo' as const, resolution: 'open' as const })
      const thread: AgentTeamThread = Object.freeze({ threadRef, ...(taskRef === undefined ? {} : { taskRef }), revision: sequence })
      const message: AgentTeamMessage = Object.freeze({
        messageRef: this.ref('message'), projectRef: project.projectRef, threadRef, ...(taskRef === undefined ? {} : { taskRef }),
        sender: request.actor.memberId, body,
        ...(request.resolvedAttachments === undefined ? {} : { attachments: request.resolvedAttachments }),
        topLevel: true, sequence, occurredAt: base.occurredAt,
      })
      const started = [this.startAttention(request.actor.memberId, threadRef, sequence),
        ...recipients.filter(memberId => this.state.members.has(memberId))
          .map(memberId => this.startAttention(memberId, threadRef, sequence))]
      const inbox = this.messageInboxDelta(message, request.actor.memberId, recipients, started)
      const operation: AgentTeamMessageSentOperation = Object.freeze({
        ...base, kind: 'team/message-sent',
        data: Object.freeze({ workspaceId: request.workspaceId, mentions: recipients, message,
          ...(task === undefined ? {} : { task }), thread, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.messageResult(operation))
    })
  }

  reply(request: AgentTeamAuthorizedReplyRequest): Promise<AgentTeamLedgerResult<AgentTeamReplyResult>> {
    return this.enqueue(async () => {
      const actor = this.assertActorForWorkspace(request.actor, request.workspaceId)
      const { task, thread, projectRef } = this.threadContextForActor(actor, request.workspaceId, request)
      const v2 = this.state.rulesVersion >= 2
      if (v2) this.requireProjectMemberActor(actor, projectRef)
      if (v2 && request.confirmationToken !== undefined) throw new Error('invitation confirmation does not exist at rules version 2: a mention delivers directly')
      const body = request.body.trim()
      if (body === '') throw new Error('message body must not be empty')
      const project = this.requireProject(request.workspaceId, projectRef)
      const parent = this.requireReplyParent(request, thread.threadRef)
      const explicit = this.normalizeRecipients(actor, request.recipients)
      // Answering a Member delivers to them the way a mention does: a reply the
      // recipient never learns about is not a reply. Before version 2 the Human
      // is skipped — they read the Thread directly — as is the author's own
      // Message, which `normalizeRecipients` refuses outright.
      const answered = parent === undefined || parent.sender === actor.memberId || (!v2 && parent.sender === AGENT_TEAM_HUMAN_MEMBER_ID)
        ? explicit
        : [...new Set([...explicit, parent.sender])].sort()
      const recipients = this.mergeBodyMentions(actor.memberId, projectRef, body, answered)
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameReply(existing, request, recipients)
        return this.resolved(this.replyResult(existing, v2 ? [] : this.undeliverableRecipients(actor, thread.threadRef, recipients)))
      }
      this.assertMentionTargets(project, recipients)
      const deferred = this.deferredThreadWrite(actor.memberId, task, thread, request.baseRevision)
      if (deferred !== undefined) return this.resolved(deferred)
      if (task?.resolution === 'closed') throw new Error(`Task '${task.taskRef}' is closed; reopen it before replying`)
      // An Agent cannot invite into an existing Thread, so a body mention the
      // Thread has never carried is dropped and reported back rather than
      // failing the send. The Human keeps the confirmation step, which is what
      // actually grants the invitation.
      const undelivered = v2 ? Object.freeze([] as AgentTeamMemberId[]) : this.undeliverableRecipients(actor, thread.threadRef, recipients)
      const delivered = undelivered.length === 0 ? recipients : recipients.filter(memberId => !undelivered.includes(memberId))
      // Version 2: a mention or an answer delivers one direct marker and never starts or resumes Attention.
      const unfollowedAgents = v2 ? [] : delivered.filter(memberId => this.state.members.has(memberId) && !this.isFollowing(thread.threadRef, memberId))
      // A Member that once took part in this Thread is delivered to directly:
      // re-joining a Thread it already belongs to is not an invitation.
      if (unfollowedAgents.length > 0 && actor.kind === 'human' && request.confirmationToken === undefined) {
        return this.resolved(this.issueConfirmation(request.actor, request.workspaceId, projectRef, body, delivered, task, thread))
      }
      if (request.confirmationToken !== undefined) {
        this.consumeConfirmation(request.confirmationToken, request.actor, request.workspaceId, projectRef,
          task, thread, body, delivered)
      }
      const sequence = this.nextSequence()
      const base = this.operationBase(request, sequence)
      const message: AgentTeamMessage = Object.freeze({
        messageRef: this.ref('message'), projectRef, threadRef: thread.threadRef,
        ...(task === undefined ? {} : { taskRef: task.taskRef }), sender: request.actor.memberId, body,
        ...(request.resolvedAttachments === undefined ? {} : { attachments: request.resolvedAttachments }),
        ...(parent === undefined ? {} : { replyToMessageRef: parent.messageRef }),
        topLevel: false, sequence, occurredAt: base.occurredAt,
      })
      const nextThread: AgentTeamThread = Object.freeze({ ...thread, revision: sequence })
      const started = unfollowedAgents.map(memberId => this.startAttention(memberId, thread.threadRef, sequence))
      const inbox = this.messageInboxDelta(message, request.actor.memberId, delivered, started)
      const operation: AgentTeamThreadRepliedOperation = Object.freeze({
        ...base, kind: 'team/thread-replied',
        data: Object.freeze({ workspaceId: request.workspaceId, baseRevision: request.baseRevision,
          mentions: delivered, message, ...(task === undefined ? {} : { task }), thread: nextThread, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.replyResult(operation, undelivered))
    })
  }

  /**
   * Post one Main stream Message: the Project-level conversation outside every Thread. Any Project member may write; a
   * writer holding Main stream unread (an owner's ordinary unread, or any Member's markers) reads first.
   */
  postMainMessage(request: AgentTeamAuthorizedPostMainMessageRequest): Promise<AgentTeamLedgerResult<AgentTeamPostMainMessageResult>> {
    return this.enqueue(async () => {
      const actor = this.assertActorForWorkspace(request.actor, request.workspaceId)
      const project = this.requireActiveProject(request.workspaceId, request.projectRef)
      const body = request.body.trim()
      if (body === '') throw new Error('message body must not be empty')
      const parent = this.requireMainReplyParent(request.replyToMessageRef, project.projectRef)
      const explicit = this.normalizeRecipients(actor, request.recipients)
      const answered = parent === undefined || parent.sender === actor.memberId ? explicit : [...new Set([...explicit, parent.sender])].sort()
      const recipients = this.mergeBodyMentions(actor.memberId, project.projectRef, body, answered)
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameMainMessage(existing, request, recipients)
        return this.resolved(this.mainPostResult(existing))
      }
      this.requireRulesVersion2('the Main stream')
      this.requireProjectMemberActor(actor, project.projectRef)
      this.assertMentionTargets(project, recipients)
      const unread = this.mainUnreadFrom(this.state, actor.memberId, project.projectRef)
      if (unread.length > 0) return this.resolved(this.mainUnreadRequired(project.projectRef, unread))
      const sequence = this.nextSequence()
      const base = this.operationBase(request, sequence)
      const message: AgentTeamMainMessage = Object.freeze({
        messageRef: this.ref('message'), projectRef: project.projectRef, scope: 'main', sender: actor.memberId, body,
        ...(request.resolvedAttachments === undefined ? {} : { attachments: request.resolvedAttachments }),
        ...(parent === undefined ? {} : { replyToMessageRef: parent.messageRef }), sequence, occurredAt: base.occurredAt,
      })
      const operation: AgentTeamMainMessagePostedOperation = Object.freeze({
        ...base, kind: 'team/main-message-posted',
        data: Object.freeze({ workspaceId: request.workspaceId, mentions: recipients, message,
          inbox: this.mainMessageInboxDelta(message, recipients) }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.mainPostResult(operation))
    })
  }

  /**
   * Acknowledge the Main stream through one sequence (default the head): an owner's watermark advances and the reader's
   * markers up to it are consumed. A read that changes neither writes nothing, like a Thread read.
   */
  readMainStream(request: AgentTeamAuthorizedMainStreamReadRequest): Promise<AgentTeamLedgerResult<AgentTeamMainStreamReadResult>> {
    return this.enqueue(async () => {
      const actor = this.assertActorForWorkspace(request.actor, request.workspaceId)
      const project = this.requireActiveProject(request.workspaceId, request.projectRef)
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameMainRead(existing, request, project.projectRef)
        return this.resolved(this.mainReadResult(actor.memberId, project.projectRef, existing.data.readThroughSequence, [], this.receipt(existing)))
      }
      this.requireRulesVersion2('the Main stream')
      this.requireProjectMemberActor(actor, project.projectRef)
      const head = this.mainHeadFrom(this.state, project.projectRef)
      // Without an explicit bound a read acknowledges only the first page of unread, so a backlog is read page by page, never skipped.
      const backlog = request.readThroughSequence === undefined ? this.mainUnreadFrom(this.state, actor.memberId, project.projectRef) : []
      const readThrough = request.readThroughSequence ?? (backlog.length > MAIN_READ_PAGE_SIZE ? backlog[MAIN_READ_PAGE_SIZE - 1]!.source.sequence : head)
      if (!Number.isInteger(readThrough) || readThrough < 0 || readThrough > head) {
        throw new Error(`readThroughSequence must be an integer from 0 to the Main stream head ${head}`)
      }
      const prepared = this.prepareMainReadFrom(this.state, actor.memberId, project.projectRef, readThrough)
      if (!prepared.advances && isEmptyInboxDelta(prepared.inbox)) {
        return this.resolved(this.mainReadResult(actor.memberId, project.projectRef, readThrough, []))
      }
      const operation: AgentTeamMainStreamReadOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/main-stream-read',
        data: Object.freeze({ workspaceId: request.workspaceId, projectRef: project.projectRef, memberId: actor.memberId,
          readThroughSequence: readThrough, inbox: prepared.inbox }),
      })
      // The picture shows what the reader saw before this read, so it is taken ahead of the commit.
      const picture = this.mainReadPage(actor.memberId, project.projectRef, prepared.consumed, readThrough)
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(Object.freeze({ receipt: this.receipt(operation), projectRef: project.projectRef, readThroughSequence: readThrough,
        entries: picture, consumedMarkers: prepared.consumed, standing: this.mainStandingFrom(this.state, actor.memberId, project.projectRef) }))
    })
  }

  /** Start a discussion or Task Thread: a Project owner's act. Mentions deliver a direct marker only; the creator alone follows. */
  startThread(request: AgentTeamAuthorizedStartThreadRequest): Promise<AgentTeamLedgerResult<AgentTeamStartThreadResult>> {
    return this.enqueue(async () => {
      const actor = this.assertActorForWorkspace(request.actor, request.workspaceId)
      const project = this.requireActiveProject(request.workspaceId, request.projectRef)
      const body = request.body.trim()
      if (body === '') throw new Error('message body must not be empty')
      const recipients = this.mergeBodyMentions(actor.memberId, project.projectRef, body, this.normalizeRecipients(actor, request.recipients))
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameThreadStart(existing, request, recipients)
        return this.resolved(this.startThreadResult(existing))
      }
      this.requireRulesVersion2('starting a Thread')
      this.requireProjectMemberActor(actor, project.projectRef)
      this.requireProjectOwnerActor(actor, project.projectRef)
      this.assertMentionTargets(project, recipients)
      const sequence = this.nextSequence()
      const base = this.operationBase(request, sequence)
      const threadRef = this.ref('thread')
      const taskRef = request.kind === 'task' ? this.ref('task') : undefined
      const task = taskRef === undefined ? undefined
        : Object.freeze({ taskRef, projectRef: project.projectRef, threadRef, status: 'todo' as const, resolution: 'open' as const })
      const thread: AgentTeamThread = Object.freeze({ threadRef, ...(taskRef === undefined ? {} : { taskRef }), revision: sequence })
      const anchor: AgentTeamMessage = Object.freeze({
        messageRef: this.ref('message'), projectRef: project.projectRef, threadRef, ...(taskRef === undefined ? {} : { taskRef }),
        sender: actor.memberId, body,
        ...(request.resolvedAttachments === undefined ? {} : { attachments: request.resolvedAttachments }),
        topLevel: true, sequence, occurredAt: base.occurredAt,
      })
      const inbox = this.messageInboxDelta(anchor, actor.memberId, recipients, [this.startAttention(actor.memberId, threadRef, sequence)])
      const operation: AgentTeamThreadStartedOperation = Object.freeze({
        ...base, kind: 'team/thread-started',
        data: Object.freeze({ workspaceId: request.workspaceId, projectRef: project.projectRef, kind: request.kind, mentions: recipients,
          anchor, ...(task === undefined ? {} : { task }), thread, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.startThreadResult(operation))
    })
  }

  /** One page of a Project's Main stream, oldest first, with the reader's own standing. Never writes. */
  mainStreamHistory(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamMainStreamHistoryRequest): AgentTeamMainStreamHistory {
    this.requireRulesVersion2('the Main stream')
    const authorized = this.assertActorForWorkspace(actor, request.workspaceId)
    const project = this.requireActiveProject(request.workspaceId, request.projectRef)
    this.requireProjectMemberActor(authorized, project.projectRef)
    const limit = request.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('history limit must be an integer between 1 and 100')
    const sources = this.mainSourcesFrom(this.state, project.projectRef)
    const before = request.beforeSequence ?? (sources.at(-1)?.sequence ?? 0) + 1
    if (!Number.isInteger(before) || before < 1) throw new Error('beforeSequence must be a positive integer')
    const older = sources.filter(source => source.sequence < before)
    const page = older.slice(-limit)
    const unread = this.mainUnreadFrom(this.state, authorized.memberId, project.projectRef)
    return Object.freeze({ projectRef: project.projectRef, entries: this.mainEntries(page, unread),
      cursor: page.length === 0 ? before : page[0]!.sequence, hasMore: older.length > page.length,
      standing: this.mainStandingFrom(this.state, authorized.memberId, project.projectRef) })
  }

  /** What one Member's Main stream markers say, per Project, for the Host's wake: only direct entries, never ordinary owner unread. */
  mainNotificationFacts(memberId: AgentTeamMemberId): readonly { readonly project: AgentTeamProject; readonly entries: readonly AgentTeamMainTimelineEntry[] }[] {
    const buckets = this.state.mainMarkersByMember.get(memberId)
    if (buckets === undefined) return []
    const result: { project: AgentTeamProject; entries: readonly AgentTeamMainTimelineEntry[] }[] = []
    for (const projectRef of buckets.keys()) {
      const project = this.visibleProject(this.state.projects.get(projectRef))
      if (project === undefined || !this.participatesIn(memberId, project.workspaceId)) continue
      const direct = this.mainUnreadFrom(this.state, memberId, projectRef).filter(item => item.direct)
      if (direct.length > 0) result.push({ project, entries: this.mainEntries(direct.map(item => item.source), direct) })
    }
    return Object.freeze(result)
  }

  promoteThread(request: AgentTeamAuthorizedPromoteThreadRequest): Promise<AgentTeamLedgerResult<AgentTeamPromoteThreadResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSamePromotion(existing, request)
        return this.resolved(this.promotionResult(existing))
      }
      const v2 = this.state.rulesVersion >= 2
      if (v2 && request.actor.kind === 'member') this.assertMemberActor(request.actor)
      else this.assertHumanActor(request.actor)
      const { task: existingTask, thread, projectRef } = this.threadContextForActor(request.actor, request.workspaceId, request)
      if (v2) this.requireProjectOwnerActor(request.actor, projectRef)
      if (existingTask !== undefined) throw new Error(`Thread '${thread.threadRef}' already has Task '${existingTask.taskRef}'`)
      const deferred = this.deferredThreadWrite(request.actor.memberId, undefined, thread, request.baseRevision)
      if (deferred !== undefined) return this.resolved(deferred)
      const sequence = this.nextSequence()
      const base = this.operationBase(request, sequence)
      const taskRef = this.ref('task')
      const task: AgentTeamTask = Object.freeze({ taskRef, projectRef, threadRef: thread.threadRef, status: 'todo', resolution: 'open' })
      const nextThread: AgentTeamThread = Object.freeze({ threadRef: thread.threadRef, taskRef, revision: sequence })
      const activity: AgentTeamTaskActivity = Object.freeze({ activityRef: this.ref('activity'), kind: 'promote',
        taskRef, threadRef: thread.threadRef, actor: request.actor.memberId, sequence })
      const inbox = this.promoteThreadInbox(activity, thread.threadRef)
      const operation: AgentTeamThreadPromotedOperation = Object.freeze({
        ...base, kind: 'team/thread-promoted',
        data: Object.freeze({ workspaceId: request.workspaceId, baseRevision: request.baseRevision,
          activity, task, thread: nextThread, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.promotionResult(operation))
    })
  }

  changeClaim(request: AgentTeamAuthorizedClaimRequest): Promise<AgentTeamLedgerResult<AgentTeamClaimResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameClaim(existing, request)
        return this.resolved(this.claimResult(existing))
      }
      const actor = this.assertActorForWorkspace(request.actor, request.workspaceId)
      const { task, thread } = this.threadForActor(actor, request.workspaceId, request.taskRef)
      if (this.state.rulesVersion >= 2 && request.action === 'claim') this.requireProjectMemberActor(actor, task.projectRef)
      const deferred = this.deferredThreadWrite(actor.memberId, task, thread, request.baseRevision)
      if (deferred !== undefined) return this.resolved(deferred)
      if (task.resolution !== 'open') throw new Error(`Task '${task.taskRef}' is ${task.status}; reopen it before changing Claims`)
      if (actor.kind !== 'member') throw new Error('Human cannot change an Agent Claim')
      let claim: AgentTeamClaim
      let kind: AgentTeamClaimChangedOperation['kind']
      let activityKind: AgentTeamClaimActivity['kind']
      if (request.action === 'claim') {
        if (request.claimRef !== undefined) throw new Error('claim action does not accept claimRef')
        const direction = request.direction?.trim() ?? ''
        const normalizedDirection = this.normalizeDirection(direction)
        if (normalizedDirection === '') throw new Error('claim direction must not be empty')
        if ((this.state.claimsByTask.get(task.taskRef) ?? []).some(candidate =>
          candidate.state === 'active' && candidate.normalizedDirection === normalizedDirection)) {
          throw new Error(`Direction '${direction}' already has an active Claim`)
        }
        claim = Object.freeze({ claimRef: this.ref('claim'), taskRef: task.taskRef, threadRef: task.threadRef,
          owner: actor.memberId, direction, normalizedDirection, state: 'active' })
        kind = 'team/claim-created'
        activityKind = 'claim'
      } else {
        if (request.direction !== undefined) throw new Error(`${request.action} action does not accept direction`)
        const previous = request.claimRef === undefined ? undefined : this.state.claims.get(this.requireRefKey(this.state.claims, request.claimRef, 'claim', 'Claim'))
        if (previous === undefined) {
          throw new Error(`unknown Claim '${request.claimRef ?? ''}'${request.claimRef === undefined ? '' : this.unknownRefHint(request.claimRef, 'claim', 'Claim')}`)
        }
        if (previous.taskRef !== task.taskRef || previous.owner !== actor.memberId) {
          throw new Error(`Member can modify only its own Claim on this Task — ${recoveryFor('claim_owned_by_another').sentence({ refused: `claim ${previous.claimRef}` })}`)
        }
        if (previous.state !== 'active') throw new Error(`Claim '${previous.claimRef}' is already ${previous.state}`)
        claim = Object.freeze({ ...previous, state: request.action === 'done' ? 'done' : 'released' })
        kind = request.action === 'done' ? 'team/claim-done' : 'team/claim-released'
        activityKind = request.action
      }
      const sequence = this.nextSequence()
      const projected = new Map(this.state.claims).set(claim.claimRef, claim)
      const nextTask: AgentTeamTask = Object.freeze({ ...task, status: this.deriveTaskStatus(task.taskRef, projected.values()) })
      const nextThread: AgentTeamThread = Object.freeze({ ...thread, revision: sequence })
      const activity: AgentTeamClaimActivity = Object.freeze({
        activityRef: this.ref('activity'), kind: activityKind, taskRef: task.taskRef,
        threadRef: task.threadRef, actor: actor.memberId, claimRef: claim.claimRef, sequence,
      })
      const ownAttention = request.action === 'claim' && actor.kind === 'member' && !this.isFollowing(thread.threadRef, actor.memberId)
        ? [this.startAttention(actor.memberId, thread.threadRef, sequence)] : []
      const inbox = this.inboxDelta(ownAttention)
      const operation: AgentTeamClaimChangedOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind,
        data: Object.freeze({ workspaceId: request.workspaceId, baseRevision: request.baseRevision,
          activity, claim, task: nextTask, thread: nextThread, inbox }),
      }) as AgentTeamClaimChangedOperation
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.claimResult(operation))
    })
  }

  changeTask(request: AgentTeamAuthorizedTaskRequest): Promise<AgentTeamLedgerResult<AgentTeamTaskResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameTask(existing, request)
        return this.resolved(this.taskResult(existing))
      }
      this.assertHumanActor(request.actor)
      const { task, thread } = this.threadForActor(request.actor, request.workspaceId, request.taskRef)
      const deferred = this.deferredThreadWrite(request.actor.memberId, task, thread, request.baseRevision)
      if (deferred !== undefined) return this.resolved(deferred)
      if (request.action === 'accept' && task.resolution !== 'open') throw new Error(`Task '${task.taskRef}' is already ${task.resolution}`)
      if (request.action === 'close' && task.resolution === 'closed') throw new Error(`Task '${task.taskRef}' is already closed`)
      // Acceptance normally waits for every Claim to finish (in_review);
      // a Human may also accept early while work is in progress, which then
      // completes the still-active Claims inside the same atomic operation.
      // A never-claimed todo Task may be accepted directly as well: work
      // finished outside the ledger is declared complete by the Human.
      if (request.action === 'accept' && task.status !== 'in_review' && task.status !== 'in_progress' && task.status !== 'todo') {
        throw new Error(`Task '${task.taskRef}' must be in_review, in_progress, or todo before acceptance`)
      }
      const priorActiveClaims = (this.state.claimsByTask.get(task.taskRef) ?? []).filter(claim => claim.state === 'active')
      if (request.action === 'accept' && task.status === 'in_progress' && priorActiveClaims.length === 0) {
        throw new Error(`Task '${task.taskRef}' has no active Claims to complete for early acceptance`)
      }
      if (request.action === 'reopen' && task.resolution === 'open') throw new Error(`Task '${task.taskRef}' is already open`)
      const sequence = this.nextSequence()
      const claims = (this.state.claimsByTask.get(task.taskRef) ?? []).map(claim =>
        request.action === 'close' && claim.state === 'active' ? Object.freeze({ ...claim, state: 'released' as const })
          : request.action === 'accept' && claim.state === 'active' ? Object.freeze({ ...claim, state: 'done' as const })
            : claim)
      const releasedClaims = claims.filter(claim => claim.state === 'released' && this.state.claims.get(claim.claimRef)?.state === 'active')
      const completedClaims = claims.filter(claim => claim.state === 'done' && this.state.claims.get(claim.claimRef)?.state === 'active')
      // Every done Claim at commit time, pre-finished and atomically
      // completed alike, is the acceptance discriminator and the list accept
      // markers deliver from. Sorted lexically so replay validation compares
      // stably regardless of claim-ref generation order.
      const acceptedClaims = request.action === 'accept'
        ? claims.filter(claim => claim.state === 'done').sort((left, right) => left.claimRef.localeCompare(right.claimRef))
        : []
      const resolution = request.action === 'reopen' ? 'open' as const : request.action === 'accept' ? 'accepted' as const : 'closed' as const
      const status = resolution === 'accepted' ? 'done' as const : resolution === 'closed' ? 'closed' as const
        : this.deriveTaskStatus(task.taskRef, claims)
      const nextTask: AgentTeamTask = Object.freeze({ ...task, resolution, status })
      const nextThread: AgentTeamThread = Object.freeze({ ...thread, revision: sequence })
      const activity: AgentTeamTaskActivity = Object.freeze({ activityRef: this.ref('activity'), kind: request.action,
        taskRef: task.taskRef, threadRef: task.threadRef, actor: request.actor.memberId, sequence,
        ...(releasedClaims.length === 0 ? {} : { releasedClaimRefs: Object.freeze(releasedClaims.map(claim => claim.claimRef)) }),
        ...(completedClaims.length === 0 ? {} : { completedClaimRefs: Object.freeze(completedClaims.map(claim => claim.claimRef)) }),
        ...(request.action === 'accept' ? { acceptedClaimRefs: Object.freeze(acceptedClaims.map(claim => claim.claimRef)) } : {}) })
      const inbox = request.action === 'close'
        ? this.closeThreadInbox(activity, thread.threadRef)
        : request.action === 'reopen'
          ? this.reopenThreadInbox(activity, thread.threadRef)
          : this.acceptThreadInbox(activity, thread.threadRef, acceptedClaims.map(claim => claim.owner))
      const operation: AgentTeamTaskChangedOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind: 'team/task-changed',
        data: Object.freeze({ workspaceId: request.workspaceId, baseRevision: request.baseRevision,
          activity, task: nextTask, thread: nextThread, claims: Object.freeze(claims), inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.taskResult(operation))
    })
  }

  removeMember(request: AgentTeamAuthorizedRemoveMemberRequest): Promise<AgentTeamLedgerResult<AgentTeamRemoveMemberResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameRemoval(existing, request)
        return this.resolved(this.removalResult(existing))
      }
      this.assertHumanActor(request.actor)
      const member = this.requireMember(request.memberId)
      if (member.state === 'inactive') throw new Error(`Agent Member '${member.memberId}' is already inactive`)
      const nextMember = Object.freeze({ ...member, state: 'inactive' as const })
      const releasedClaims = [...this.state.claims.values()].filter(claim => claim.owner === member.memberId && claim.state === 'active')
        .map(claim => Object.freeze({ ...claim, state: 'released' as const }))
      const projectedClaims = new Map(this.state.claims)
      for (const claim of releasedClaims) projectedClaims.set(claim.claimRef, claim)
      const sequence = this.nextSequence()
      const activities = this.releaseSummaries(releasedClaims, member.memberId, sequence)
      const threads = this.threadsForActivities(activities)
      const tasks = this.tasksForClaims(releasedClaims, projectedClaims)
      // The Member leaves entirely, so Attention and markers clear on every
      // Thread — taskless ones too — matching the replay validator's scope.
      const threadRefs = new Set(this.state.threads.keys())
      const inbox = this.removeMemberThreadInbox(member.memberId, threadRefs)
      const operation: AgentTeamMemberRemovedOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind: 'team/member-removed',
        data: Object.freeze({ member: nextMember, claims: Object.freeze(releasedClaims), activities, tasks, threads, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      this.confirmations.clear()
      return this.committed(this.removalResult(operation))
    })
  }

  /**
   * Archive one Member: hidden from every surface, data kept recoverable.
   * The release shape matches removal — active Claims release with public
   * Activities and the Member's Attention/markers clear — because a hidden
   * Member must not leave Tasks stuck in progress or phantom unread counts.
   */
  archiveMember(request: AgentTeamAuthorizedArchiveMemberRequest): Promise<AgentTeamLedgerResult<AgentTeamArchiveMemberResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameArchival(existing, request)
        return this.resolved(this.archivalResult(existing))
      }
      this.assertHumanActor(request.actor)
      const member = this.requireMember(request.memberId)
      if (member.state === 'inactive') throw new Error(`Agent Member '${member.memberId}' is already inactive`)
      if (member.state === 'archived') throw new Error(`Agent Member '${member.memberId}' is already archived`)
      const nextMember = Object.freeze({ ...member, state: 'archived' as const })
      const releasedClaims = [...this.state.claims.values()].filter(claim => claim.owner === member.memberId && claim.state === 'active')
        .map(claim => Object.freeze({ ...claim, state: 'released' as const }))
      const projectedClaims = new Map(this.state.claims)
      for (const claim of releasedClaims) projectedClaims.set(claim.claimRef, claim)
      const sequence = this.nextSequence()
      const activities = this.releaseSummaries(releasedClaims, member.memberId, sequence)
      const threads = this.threadsForActivities(activities)
      const tasks = this.tasksForClaims(releasedClaims, projectedClaims)
      // The Member leaves entirely, so Attention and markers clear on every
      // Thread — taskless ones too — matching the replay validator's scope.
      const threadRefs = new Set(this.state.threads.keys())
      const inbox = this.removeMemberThreadInbox(member.memberId, threadRefs)
      const operation: AgentTeamMemberArchivedOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind: 'team/member-archived',
        data: Object.freeze({ member: nextMember, claims: Object.freeze(releasedClaims), activities, tasks, threads, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      this.confirmations.clear()
      return this.committed(this.archivalResult(operation))
    })
  }

  changeAttention(
    request: AgentTeamAuthorizedThreadAttentionRequest,
  ): Promise<AgentTeamLedgerResult<AgentTeamThreadAttentionResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameAttention(existing, request)
        return this.resolved(this.attentionResult(existing))
      }
      const actor = this.assertActorForWorkspace(request.actor, request.workspaceId)
      const { task, thread } = this.threadContextForActor(actor, request.workspaceId, request)
      const current = this.attentionFor(actor.memberId, thread.threadRef)
      if (request.action === 'follow') {
        if (task?.resolution === 'closed') throw new Error(`Task '${task.taskRef}' is closed; reopen it before following`)
        if (current !== undefined) throw new Error(`Member is already following Thread '${thread.threadRef}'`)
        const attention = this.followAttention(actor.memberId, thread.threadRef)
        const operation: AgentTeamThreadAttentionChangedOperation = Object.freeze({
          ...this.operationBase(request, this.nextSequence()), kind: 'team/thread-attention-changed',
          data: Object.freeze({ workspaceId: request.workspaceId, action: 'follow', memberId: actor.memberId,
            ...(task === undefined ? {} : { task }), thread, inbox: this.inboxDelta([attention]) }),
        })
        await this.table.put(operation.operationId, operation)
        this.applyAndAdvanceProjectionVersion(operation)
        return this.committed(this.attentionResult(operation))
      }
      if (current === undefined) throw new Error(`Member is already unfollowed from Thread '${thread.threadRef}'`)
      if (task !== undefined && this.hasActiveClaim(actor.memberId, task.taskRef)) throw new Error('Member cannot unfollow while owning an active Claim')
      const operation: AgentTeamThreadAttentionChangedOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/thread-attention-changed',
        data: Object.freeze({ workspaceId: request.workspaceId, action: 'unfollow', memberId: actor.memberId,
          ...(task === undefined ? {} : { task }), thread, inbox: this.inboxDelta([], [{ memberId: actor.memberId, threadRef: thread.threadRef }], [], this.directMarkersFor(actor.memberId, thread.threadRef)) }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.attentionResult(operation))
    })
  }

  /**
   * Append one Member-to-Member direct message as an audit-only operation.
   * A DM is pure delivery: no Project, Thread, revision, attention, or
   * markers change, so apply() is a marker and no projection state moves.
   */
  sendDm(request: AgentTeamAuthorizedDmRequest): Promise<AgentTeamLedgerResult<AgentTeamDmResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameDm(existing, request)
        return this.resolved(this.dmResult(existing))
      }
      // Only an enabled Member in this Workspace may send a DM; the Human is
      // not a sendable peer, and Members in other Workspaces are unreachable.
      const sender = this.assertActorForWorkspace(request.actor, request.workspaceId)
      if (sender.kind !== 'member') throw new Error('agent-team DM requires Member authority')
      const body = request.body.trim()
      if (body === '') throw new Error('DM body must not be empty')
      const recipient = this.requireMember(request.recipientMemberId)
      if (!this.participatesIn(recipient.memberId, request.workspaceId)) throw new Error(`Agent Member '${recipient.memberId}' is not in Workspace '${request.workspaceId}'`)
      if (recipient.state !== 'enabled') throw new Error(`Agent Member '${recipient.memberId}' is ${recipient.state}; DM delivery requires an enabled Member`)
      if (recipient.memberId === AGENT_TEAM_HUMAN_MEMBER_ID || !recipient.sessionId) throw new Error('DM recipient must be an Agent Member')
      if (recipient.memberId === sender.memberId) throw new Error('Members cannot DM themselves')
      const operation: AgentTeamDmSentOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/dm-sent',
        data: Object.freeze({ workspaceId: request.workspaceId, senderMemberId: sender.memberId,
          recipientMemberId: recipient.memberId, body }),
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return this.committed(this.dmResult(operation))
    })
  }

  /**
   * Bounded adjacent context for a DM relay: the truncated body of the most
   * recent earlier DM between the two sessions, newest first. Returns
   * undefined when this is their first exchange. `excluding` skips the
   * operation id of the DM being delivered right now, so the context line is
   * the adjacent prior exchange rather than a self-reference. Direction
   * labels are from the reader's perspective: the reader is the recipient of
   * the DM being delivered, so messages the reader sent are `you → them`.
   */
  dmHistoryBetween(senderSessionId: SessionId, recipientMemberId: AgentTeamMemberId, excluding?: AgentTeamOperationId): string | undefined {
    const sender = [...this.state.members.values()].find(member => member.sessionId === senderSessionId)
    if (sender === undefined) return undefined
    for (let index = this.state.ordered.length - 1; index >= 0; index -= 1) {
      const operation = this.state.ordered[index]!
      if (operation.kind !== 'team/dm-sent' || operation.operationId === excluding) continue
      const sentByOther = operation.data.senderMemberId === sender.memberId && operation.data.recipientMemberId === recipientMemberId
      const sentByReader = operation.data.senderMemberId === recipientMemberId && operation.data.recipientMemberId === sender.memberId
      if (!sentByOther && !sentByReader) continue
      const direction = sentByOther ? 'them → you' : 'you → them'
      const truncated = operation.data.body.length > 160 ? `${operation.data.body.slice(0, 160)}…` : operation.data.body
      return `(${direction}, at ${formatTeamTimestamp(operation.occurredAt)}) ${truncated}`
    }
    return undefined
  }

  attentionStatus(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: {
    workspaceId: WorkspaceId
    threadRef?: AgentTeamThreadRef | undefined
    taskRef?: AgentTeamTaskRef | undefined
  }): AgentTeamThreadAttentionStatus {
    const authorized = this.assertActorForWorkspace(actor, request.workspaceId)
    const { task, thread } = this.threadContextForActor(authorized, request.workspaceId, request)
    const attention = this.attentionFor(authorized.memberId, thread.threadRef)
    return Object.freeze({ ...(task === undefined ? {} : { task }), thread, ...(attention === undefined ? {} : { attention }) })
  }

  inbox(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamInboxRequest): AgentTeamInbox {
    const authorized = this.assertActorForWorkspace(actor, request.workspaceId)
    return this.inboxForWorkspaces(authorized, [request.workspaceId], request.limit)
  }

  memberInbox(actor: AgentTeamMemberActor, request: { readonly limit?: number }): AgentTeamInbox {
    const workspaces = this.workspacesOf(actor.memberId)
    for (const workspaceId of workspaces) this.assertActorForWorkspace(actor, workspaceId)
    return this.inboxForWorkspaces(actor, workspaces, request.limit)
  }

  private inboxForWorkspaces(authorized: AgentTeamHumanActor | AgentTeamMemberActor, workspaceIds: readonly WorkspaceId[], requestedLimit?: number): AgentTeamInbox {
    const limit = requestedLimit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('inbox limit must be an integer between 1 and 100')
    const taskNumbers = new Map(workspaceIds.flatMap(workspaceId => [...this.taskNumbers(workspaceId)]))
    const unreadThreads = new Set<AgentTeamThreadRef>()
    // Candidates carry only what ranking and the totals need; a row's preview
    // text, actor and live Claim owners are materialized only for the rows
    // this response returns.
    type Candidate = { readonly workspaceId: WorkspaceId; readonly projectRef: AgentTeamProjectRef; readonly projectName: string
      readonly task?: AgentTeamTask; readonly taskNumber?: number; readonly thread: AgentTeamThread
      readonly unreadCount: number; readonly directCount: number; readonly newest: AgentTeamThreadFact
      readonly attention?: AgentTeamThreadAttention }
    const candidates: Candidate[] = []
    for (const threadRef of this.inboxCandidateThreads(authorized.memberId)) {
      const thread = this.state.threads.get(threadRef)
      if (thread === undefined) continue
      const projectRef = this.projectRefForThread(thread.threadRef)
      if (projectRef === undefined) continue
      const project = this.state.projects.get(projectRef)
      if (project === undefined || !workspaceIds.includes(project.workspaceId)) continue
      if (this.visibleProject(project) === undefined) continue
      const workspaceId = project.workspaceId
      if (authorized.kind === 'member' && !this.isProjectMember(projectRef, authorized.memberId)) continue
      const unread = this.unreadFor(authorized.memberId, thread.threadRef)
      if (unread.length === 0) continue
      unreadThreads.add(thread.threadRef)
      const task = thread.taskRef === undefined ? undefined : this.state.tasks.get(thread.taskRef)
      const directCount = unread.filter(item => item.direct).length
      const attention = this.attentionFor(authorized.memberId, thread.threadRef)
      // Same snapshot, same source as newestSequence: the instant hangs off
      // the newest unread fact itself, never a second lookup that could
      // observe a different commit between the two reads.
      const newest = unread.at(-1)!.fact
      const taskNumber = task === undefined ? undefined : taskNumbers.get(task.taskRef)
      candidates.push({ workspaceId, projectRef, projectName: project.name,
        ...(task === undefined ? {} : { task }), ...(taskNumber === undefined ? {} : { taskNumber }), thread,
        unreadCount: unread.length, directCount, newest, ...(attention === undefined ? {} : { attention }) })
    }
    candidates.sort((left, right) => right.directCount - left.directCount || right.newest.sequence - left.newest.sequence || left.thread.threadRef.localeCompare(right.thread.threadRef))
    const selected = candidates.slice(0, limit).map(candidate => Object.freeze({ workspaceId: candidate.workspaceId, projectRef: candidate.projectRef,
      projectName: candidate.projectName, ...(candidate.task === undefined ? {} : { task: candidate.task }),
      ...(candidate.taskNumber === undefined ? {} : { taskNumber: candidate.taskNumber }), thread: candidate.thread,
      unreadCount: candidate.unreadCount, directCount: candidate.directCount,
      previewText: boundedOpeningLine(this.threadAnchor(candidate.thread.threadRef).body, ONE_LINE_GIST_MAX_CHARACTERS),
      newestSequence: candidate.newest.sequence, newestOccurredAt: candidate.newest.occurredAt,
      newestActor: this.inboxActorFor(candidate.newest), liveClaimOwners: this.liveClaimOwners(candidate.task),
      ...(candidate.attention === undefined ? {} : { attention: candidate.attention }) }))
    const recent = authorized.kind === 'human'
      ? this.recentInboxItems(authorized.memberId, workspaceIds[0]!, unreadThreads, taskNumbers)
      : Object.freeze([] as AgentTeamInboxItem[])
    return Object.freeze({ humanMemberId: this.initialization().data.humanMemberId,
      items: Object.freeze(selected), hasMore: candidates.length > selected.length, recent,
      totalUnreadCount: candidates.reduce((sum, item) => sum + item.unreadCount, 0),
      totalDirectCount: candidates.reduce((sum, item) => sum + item.directCount, 0) })
  }

  private inboxActorFor(fact: AgentTeamThreadFact): AgentTeamInboxActor {
    return this.memberActor(fact.kind === 'message' ? fact.message.sender : fact.activity.actor)
  }

  /**
   * One Member as a row draws them: the id carries the identity hue, the handle
   * the initial. The Human is the one Member the Agent roster never holds, so
   * their row reads the runtime display name rather than falling back to the
   * durable `member:human` id — the same name every other seat and @ matching
   * already use.
   */
  private memberActor(memberId: AgentTeamMemberId): AgentTeamInboxActor {
    if (memberId === this.initialization().data.humanMemberId) return Object.freeze({ memberId, name: this.humanHandle })
    return Object.freeze({ memberId, name: this.state.members.get(memberId)?.handle ?? memberId })
  }

  /**
   * The people a Task still has on it, resolved the way a row draws them: owners
   * of its live Claims, in claim order, deduped. A released Claim is not work,
   * and a done or closed Task keeps its Claims as history rather than as
   * presence — deliberately the same rule the Project feed applies to the same
   * Task, so 「谁在这个 Task 上」 never acquires a second definition.
   */
  private liveClaimOwners(task: AgentTeamTask | undefined): readonly AgentTeamInboxActor[] {
    if (task === undefined || (task.status !== 'in_progress' && task.status !== 'in_review')) return Object.freeze([] as AgentTeamInboxActor[])
    const owners: AgentTeamMemberId[] = []
    for (const claim of this.claimsForTask(task.taskRef)) {
      if (claim.state === 'released' || owners.includes(claim.owner)) continue
      owners.push(claim.owner)
    }
    return Object.freeze(owners.map(owner => this.memberActor(owner)))
  }

  /**
   * The Human Inbox's 「最近活跃」 slice: the Threads this reader has written in, a
   * durable way back into work. Participation is the whole admission rule,
   * whether or not the reader follows the Thread; starting a Thread counts
   * because it writes its anchor. Attention plays no part: it decides what
   * notifies a reader, and a reply does not implicitly follow a Thread. A
   * Thread the reader later unfollowed stays, since unfollowing stops
   * notifications, not the record. Threads still holding unread are excluded
   * because the unread queue already carries them. Newest activity first,
   * bounded by `RECENT_INBOX_LIMIT`. Rows have the same shape as unread rows
   * with every count at zero.
   */
  private recentInboxItems(memberId: AgentTeamMemberId, workspaceId: WorkspaceId,
    unreadThreads: ReadonlySet<AgentTeamThreadRef>, taskNumbers: ReadonlyMap<AgentTeamTaskRef, number>): readonly AgentTeamInboxItem[] {
    const recent: AgentTeamInboxItem[] = []
    for (const threadRef of this.state.threadsByWriter.get(memberId) ?? []) {
      if (unreadThreads.has(threadRef)) continue
      const thread = this.state.threads.get(threadRef)
      if (thread === undefined) continue
      const projectRef = this.projectRefForThread(thread.threadRef)
      if (projectRef === undefined) continue
      const project = this.state.projects.get(projectRef)
      if (project === undefined || project.workspaceId !== workspaceId) continue
      if (this.visibleProject(project) === undefined) continue
      const facts = this.state.factsByThread.get(thread.threadRef) ?? []
      const newest = facts.at(-1)
      if (newest === undefined) continue
      const task = thread.taskRef === undefined ? undefined : this.state.tasks.get(thread.taskRef)
      const taskNumber = task === undefined ? undefined : taskNumbers.get(task.taskRef)
      recent.push(Object.freeze({ workspaceId, projectRef,
        projectName: this.state.projects.get(projectRef)?.name ?? '',
        ...(task === undefined ? {} : { task }), ...(taskNumber === undefined ? {} : { taskNumber }), thread,
        unreadCount: 0, directCount: 0,
        previewText: boundedOpeningLine(this.threadAnchor(thread.threadRef).body, ONE_LINE_GIST_MAX_CHARACTERS),
        newestSequence: newest.sequence, newestOccurredAt: newest.occurredAt,
        newestActor: this.inboxActorFor(newest), liveClaimOwners: this.liveClaimOwners(task) }))
    }
    recent.sort((left, right) => right.newestSequence - left.newestSequence || left.thread.threadRef.localeCompare(right.thread.threadRef))
    return Object.freeze(recent.slice(0, RECENT_INBOX_LIMIT))
  }

  /**
   * Threads that can hold unread facts for one reader, from the per-reader
   * derived indexes: Attention follows plus direct and activity markers.
   * Every unread source is covered — ordinary unread requires Attention, and
   * marker unread requires a marker — so no full Thread scan is needed.
   */
  private inboxCandidateThreads(memberId: AgentTeamMemberId): Iterable<AgentTeamThreadRef> {
    const refs = new Set<AgentTeamThreadRef>()
    for (const source of [this.state.attentionThreadsByMember.get(memberId), this.state.directMarkersByMember.get(memberId), this.state.activityMarkersByMember.get(memberId)]) {
      for (const threadRef of source?.keys() ?? []) refs.add(threadRef)
    }
    return refs
  }

  /** Model-visible notification material derived from the recipient's current durable unread state. */
  notificationFacts(memberId: AgentTeamMemberId, request?: AgentTeamInboxRequest): readonly {
    readonly item: AgentTeamInboxItem
    readonly facts: readonly AgentTeamThreadReadFact[]
  }[] {
    const member = this.requireMember(memberId)
    if (request !== undefined && !this.participatesIn(memberId, request.workspaceId)) throw new Error('Member cannot inspect another Workspace')
    const actor = { kind: 'member' as const, memberId, handle: member.handle }
    const inbox = request === undefined ? this.memberInbox(actor, {}) : this.inbox(actor, request)
    return Object.freeze(inbox.items.map(item => Object.freeze({ item,
      facts: this.unreadFor(memberId, item.thread.threadRef) })))
  }

  readThread(request: AgentTeamAuthorizedThreadReadRequest): Promise<AgentTeamThreadReadOutcome> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameThreadRead(existing, request)
        const current = this.prepareRead(existing.data.memberId, existing.data.workspaceId, request)
        return Object.freeze({ value: Object.freeze({ receipt: this.receipt(existing), ...this.readPicture(current) }), committed: false })
      }
      const actor = this.assertActorForWorkspace(request.actor, request.workspaceId)
      const prepared = this.prepareRead(actor.memberId, request.workspaceId, request)
      // A read whose Inbox delta is empty writes nothing: the watermark does
      // not advance and no marker is consumed. It answers with the same picture
      // and no receipt, so the caller learns "no operation" from the result's
      // committed flag, never from a sequence this read did not write.
      if (isEmptyInboxDelta(prepared.inbox)) return Object.freeze({ value: this.readPicture(prepared), committed: false })
      // The record carries progress, not the picture: the Thread, its facts,
      // the anchor and the reader's Attention are projection state every replay
      // already holds.
      const data: AgentTeamThreadReadReceipt = Object.freeze({ workspaceId: request.workspaceId, memberId: actor.memberId,
        threadRef: prepared.thread.threadRef, ...(prepared.task === undefined ? {} : { taskRef: prepared.task.taskRef }),
        readThroughSequence: prepared.readThroughSequence, inbox: prepared.inbox })
      const operation: AgentTeamThreadReadOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/thread-read', data,
      })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      return Object.freeze({ value: Object.freeze({ receipt: this.receipt(operation), ...this.readPicture(prepared) }), committed: true })
    })
  }

  threadObservations(actor: AgentTeamHumanActor, request: AgentTeamThreadObservationsRequest): AgentTeamThreadObservations {
    this.assertHumanActor(actor)
    const { task, thread } = this.threadContextForActor(actor, request.workspaceId, request)
    const limit = request.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('observation limit must be an integer between 1 and 100')
    const threadRef = thread.threadRef
    // Both slices are replay-derived: the observation log is appended by
    // committed Inbox deltas in ledger order, and the live follower set is
    // the same Attention index the follow history converges to.
    const log = this.state.observationsByThread.get(threadRef) ?? []
    const observations = log.slice(-limit)
      .map(event => Object.freeze({ sequence: event.sequence, threadRef, ...(task === undefined ? {} : { taskRef: task.taskRef }),
        memberId: event.memberId, action: event.action }))
    return Object.freeze({ items: Object.freeze(observations), hasMore: log.length > observations.length,
      followers: Object.freeze([...this.state.attentionByThread.get(threadRef) ?? []]) })
  }

  /** Every operation carrying an inbox delta drives the Inbox projection; the payload shape decides, not a per-kind list. */
  private attentionDelta(operation: AgentTeamOperation): AgentTeamInboxDelta | undefined {
    return 'inbox' in operation.data ? operation.data.inbox : undefined
  }

  /** Attachment ids referenced by any stored Message — the GC's keep-set oracle. */
  referencedAttachmentIds(): Set<AgentTeamAttachmentId> {
    const referenced = new Set<AgentTeamAttachmentId>()
    for (const fact of this.state.orderedFacts) {
      if (fact.kind !== 'message') continue
      for (const attachment of fact.message.attachments ?? []) referenced.add(attachment.attachmentId)
    }
    for (const source of this.state.mainSourceByRef.values()) {
      if (source.kind !== 'message') continue
      for (const attachment of source.message.attachments ?? []) referenced.add(attachment.attachmentId)
    }
    return referenced
  }

  threadHistory(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamThreadHistoryRequest): AgentTeamThreadHistory {
    const authorized = this.assertActorForWorkspace(actor, request.workspaceId)
    const { task, thread } = this.threadContextForActor(authorized, request.workspaceId, request)
    const limit = request.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('history limit must be an integer between 1 and 100')
    const before = request.beforeSequence ?? this.currentTail(thread.threadRef) + 1
    if (!Number.isInteger(before) || before < 1) throw new Error('beforeSequence must be a positive integer')
    const all = this.threadFacts(thread.threadRef).filter(fact => fact.sequence < before)
    const facts = all.slice(-limit)
    const anchor = this.threadAnchor(thread.threadRef)
    return Object.freeze({ ...(task === undefined ? {} : { task }), thread, anchor, anchorMentions: this.state.mentionsByMessage.get(anchor.messageRef) ?? [],
      claims: task === undefined ? Object.freeze([]) : this.claimsForTask(task.taskRef), facts: Object.freeze(facts),
      cursor: facts.length === 0 ? before : facts[0]!.sequence, hasMore: all.length > facts.length })
  }

  listClaims(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: { workspaceId: WorkspaceId; taskRef: AgentTeamTaskRef }): AgentTeamClaimList {
    const authorized = this.assertActorForWorkspace(actor, request.workspaceId)
    const { task, thread } = this.threadForActor(authorized, request.workspaceId, request.taskRef)
    return Object.freeze({ task, thread, claims: this.claimsForTask(task.taskRef) })
  }

  getTask(taskRef: AgentTeamTaskRef): AgentTeamTask | undefined {
    return this.state.tasks.get(taskRef)
  }

  getClaim(claimRef: AgentTeamClaimRef): AgentTeamClaim | undefined {
    return this.state.claims.get(claimRef)
  }

  /** Navigation facts for message-body Thread refs; unknown refs are omitted. */
  resolveThreadRefs(workspaceId: WorkspaceId, threadRefs: readonly AgentTeamThreadRef[]): AgentTeamResolvedThreadRef[] {
    const numbers = this.taskNumbers(workspaceId)
    const resolved: AgentTeamResolvedThreadRef[] = []
    for (const threadRef of threadRefs) {
      const key = this.uniqueRefKey(this.state.threads, threadRef, 'thread')
      const thread = key === undefined ? undefined : this.state.threads.get(key)
      const projectRef = thread === undefined ? undefined : this.projectRefForThread(thread.threadRef)
      const project = projectRef === undefined ? undefined : this.state.projects.get(projectRef)
      if (thread === undefined || projectRef === undefined || project?.workspaceId !== workspaceId || this.visibleProject(project) === undefined) continue
      const task = thread.taskRef === undefined ? undefined : this.state.tasks.get(thread.taskRef)
      resolved.push(Object.freeze({
        threadRef: thread.threadRef,
        projectRef,
        ...(task === undefined ? {} : { taskRef: task.taskRef, taskNumber: numbers.get(task.taskRef) ?? 0 }),
        title: boundedOpeningLine(this.threadAnchor(thread.threadRef).body, THREAD_CHIP_TITLE_MAX_CHARACTERS),
      }))
    }
    return resolved
  }

  /**
   * Context for Messages cited by `replyToMessageRef`; unknown refs are omitted.
   *
   * A reply stores only its parent's identity, so the author and the excerpt a
   * quote block renders are derived here from the recorded Message. Resolving
   * through the ledger rather than the reader's loaded window is what lets a
   * quote survive history paging — the parent may be far outside the facts the
   * reader currently holds.
   */
  resolveMessageRefs(workspaceId: WorkspaceId, messageRefs: readonly AgentTeamMessageRef[]): AgentTeamResolvedMessageRef[] {
    const resolved: AgentTeamResolvedMessageRef[] = []
    for (const messageRef of messageRefs) {
      const main = this.state.mainSourceByRef.get(messageRef)
      if (main?.kind === 'message') {
        if (this.visibleProject(this.state.projects.get(main.message.projectRef))?.workspaceId !== workspaceId) continue
        resolved.push(Object.freeze({ messageRef, sender: main.message.sender, excerpt: boundedOpeningLine(main.message.body, ONE_LINE_GIST_MAX_CHARACTERS) }))
        continue
      }
      const message = this.state.messagesByRef.get(messageRef)
      if (message === undefined) continue
      const project = this.state.projects.get(message.projectRef)
      if (this.visibleProject(project)?.workspaceId !== workspaceId) continue
      resolved.push(Object.freeze({
        messageRef: message.messageRef,
        threadRef: message.threadRef,
        sender: message.sender,
        excerpt: boundedOpeningLine(message.body, ONE_LINE_GIST_MAX_CHARACTERS),
      }))
    }
    return resolved
  }

  /**
   * Read one Message back verbatim, inside the Thread that carries it.
   *
   * Authorization comes first and comes from the Thread: a reader must be able
   * to address the Thread at all, which is where membership and Project
   * archival are decided, so this opens no path that reading the Thread did
   * not already open. The Message is then looked up by identity in the index —
   * never by position — so a ref resolves the same Message whatever else has
   * been written since, and an answer can never quietly become a neighbour.
   *
   * The body is returned whole. The quote a Message renders is a bounded
   * summary by design; this is the other thing, for the reader that has to
   * answer it.
   */
  readMessage(actor: AgentTeamHumanActor | AgentTeamMemberActor, request: AgentTeamReadMessageRequest): AgentTeamReadMessageResult {
    if ((request.threadRef === undefined) === (request.projectRef === undefined)) throw new Error('readMessage needs exactly one of threadRef and projectRef')
    if (request.projectRef !== undefined) return this.readMainMessage(actor, request.workspaceId, request.projectRef, request.messageRef)
    // Addressing the Thread is the authorization: unknown, foreign, and
    // archived all refuse here, and refuse distinguishably.
    const context = this.threadContextForActor(actor, request.workspaceId, { threadRef: request.threadRef! })
    const message = this.state.messagesByRef.get(request.messageRef)
    if (message === undefined) throw new Error(`Message '${request.messageRef}' is not a recorded Message`)
    if (message.threadRef !== context.thread.threadRef) throw new Error(`Message '${request.messageRef}' belongs to another Thread`)
    return Object.freeze({
      messageRef: message.messageRef,
      threadRef: message.threadRef,
      projectRef: context.projectRef,
      sender: message.sender,
      sequence: message.sequence,
      ...(message.occurredAt === undefined ? {} : { occurredAt: message.occurredAt }),
      body: message.body,
    })
  }

  /** A Main stream Message read back whole; the Main stream itself is the authorization. */
  private readMainMessage(actor: AgentTeamHumanActor | AgentTeamMemberActor, workspaceId: WorkspaceId, projectRef: AgentTeamProjectRef, messageRef: AgentTeamMessageRef): AgentTeamReadMessageResult {
    this.requireRulesVersion2('the Main stream')
    const authorized = this.assertActorForWorkspace(actor, workspaceId)
    const project = this.requireActiveProject(workspaceId, projectRef)
    this.requireProjectMemberActor(authorized, project.projectRef)
    const source = this.state.mainSourceByRef.get(messageRef)
    if (source?.kind !== 'message') throw new Error(`Message '${messageRef}' is not a recorded Main stream Message`)
    if (source.message.projectRef !== project.projectRef) throw new Error(`Message '${messageRef}' belongs to another Project`)
    const { message } = source
    return Object.freeze({ messageRef, projectRef: project.projectRef, sender: message.sender, sequence: message.sequence, occurredAt: message.occurredAt, body: message.body })
  }

  /** Navigation facts for message-body Task refs; unknown refs are omitted. */
  resolveTaskRefs(workspaceId: WorkspaceId, taskRefs: readonly AgentTeamTaskRef[]): AgentTeamResolvedTaskRef[] {
    const numbers = this.taskNumbers(workspaceId)
    const resolved: AgentTeamResolvedTaskRef[] = []
    for (const taskRef of taskRefs) {
      const key = this.uniqueRefKey(this.state.tasks, taskRef, 'task')
      const task = key === undefined ? undefined : this.state.tasks.get(key)
      const project = task === undefined ? undefined : this.state.projects.get(task.projectRef)
      if (task === undefined || this.visibleProject(project)?.workspaceId !== workspaceId) continue
      resolved.push(Object.freeze({ taskRef: task.taskRef, projectRef: task.projectRef, threadRef: task.threadRef, taskNumber: numbers.get(task.taskRef) ?? 0 }))
    }
    return resolved
  }

  view(request: AgentTeamViewRequest, memberId?: AgentTeamMemberId): AgentTeamView {
    const limit = request.limit ?? 20
    const direction = request.direction ?? 'after'
    const cursor = request.cursor ?? 0
    if (direction !== 'after' && direction !== 'before') throw new Error('direction must be after or before')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer between 1 and 100')
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error('cursor must be a non-negative integer sequence')
    if (memberId !== undefined) {
      const member = this.requireMember(memberId)
      if (!this.participatesIn(member.memberId, request.workspaceId)) throw new Error('Member cannot view another Workspace')
    }
    const projectRefFilter = request.projectRef === undefined
      ? undefined
      : this.requireActiveProject(request.workspaceId, request.projectRef).projectRef
    if (projectRefFilter !== undefined) {
      if (memberId !== undefined && !this.isProjectMember(projectRefFilter, memberId)) throw new Error(`Agent Member '${memberId}' is not authorized for Project '${request.projectRef}'`)
    }
    let threadRefFilter: AgentTeamThreadRef | undefined
    if (request.threadRef !== undefined) {
      const thread = this.requireThread(request.threadRef)
      threadRefFilter = thread.threadRef
      const projectRef = this.projectRefForThread(thread.threadRef)
      if (projectRef === undefined) throw new Error(`unknown Thread ref '${request.threadRef}'`)
      if (this.state.projects.get(projectRef)?.workspaceId !== request.workspaceId) throw new Error(`Thread '${request.threadRef}' does not belong to Workspace '${request.workspaceId}'`)
      this.assertThreadProjectActive(projectRef)
      if (projectRefFilter !== undefined && projectRef !== projectRefFilter) throw new Error(`Thread '${request.threadRef}' does not belong to Project '${request.projectRef}'`)
      if (memberId !== undefined && !this.isProjectMember(projectRef, memberId)) throw new Error(`Agent Member '${memberId}' is not authorized for Project '${projectRef}'`)
    }
    const projects = [...this.state.projects.values()].filter(project => project.workspaceId === request.workspaceId
      && this.visibleProject(project) !== undefined
      && (memberId === undefined || this.isProjectMember(project.projectRef, memberId)))
    const projectRefs = new Set(projects.map(project => project.projectRef))
    const before = request.cursor ?? this.state.ordered.length + 1
    const matches = (fact: AgentTeamThreadFact): boolean => {
      const threadRef = fact.kind === 'message' ? fact.message.threadRef : fact.activity.threadRef
      const projectRef = this.projectRefForThread(threadRef)
      if (projectRef === undefined || !projectRefs.has(projectRef)) return false
      if (projectRefFilter !== undefined && projectRef !== projectRefFilter) return false
      if (threadRefFilter !== undefined && threadRef !== threadRefFilter) return false
      if (request.topLevelOnly && (fact.kind !== 'message' || !fact.message.topLevel)) return false
      if (request.includeActivities === false && fact.kind === 'activity') return false
      return direction === 'before' ? fact.sequence < before : fact.sequence > cursor
    }
    const selected: AgentTeamThreadFact[] = []
    let hasMore = false
    if (direction === 'before') {
      for (let index = this.state.orderedFacts.length - 1; index >= 0; index -= 1) {
        const fact = this.state.orderedFacts[index]!
        if (!matches(fact)) continue
        if (selected.length < limit) selected.push(fact)
        else { hasMore = true; break }
      }
      selected.reverse()
    } else {
      for (const fact of this.state.orderedFacts) {
        if (!matches(fact)) continue
        if (selected.length < limit) selected.push(fact)
        else { hasMore = true; break }
      }
    }
    // What this response's catalog describes. A caller that asked for the
    // catalog wants the whole request scope (the address-book radar). Every
    // other read describes its own facts: the Threads this page's facts
    // belong to plus the Thread it names, resolved by ref through the page's
    // own lookups.
    const catalogThreadRefs = new Set<AgentTeamThreadRef>()
    if (request.includeCatalog === true) {
      for (const thread of this.state.threads.values()) catalogThreadRefs.add(thread.threadRef)
    } else {
      if (threadRefFilter !== undefined) catalogThreadRefs.add(threadRefFilter)
      for (const fact of selected) catalogThreadRefs.add(fact.kind === 'message' ? fact.message.threadRef : fact.activity.threadRef)
    }
    const scopeCache = new Map<AgentTeamThreadRef, boolean>()
    const inScope = (threadRef: AgentTeamThreadRef): boolean => {
      const cached = scopeCache.get(threadRef)
      if (cached !== undefined) return cached
      const projectRef = this.projectRefForThread(threadRef)
      const scoped = projectRef !== undefined && projectRefs.has(projectRef)
        && (projectRefFilter === undefined || projectRef === projectRefFilter)
        && (threadRefFilter === undefined || threadRef === threadRefFilter)
      scopeCache.set(threadRef, scoped)
      return scoped
    }
    const catalogThreads = request.includeCatalog === true
      ? [...this.state.threads.values()].filter(thread => inScope(thread.threadRef))
      : [...catalogThreadRefs].map(threadRef => this.state.threads.get(threadRef)).filter((thread): thread is AgentTeamThread => thread !== undefined && inScope(thread.threadRef))
    const catalogTasks = request.includeCatalog === true
      ? [...this.state.tasks.values()].filter(task => inScope(task.threadRef))
      : catalogThreads.flatMap(thread => thread.taskRef === undefined ? [] : [this.state.tasks.get(thread.taskRef)])
        .filter((task): task is AgentTeamTask => task !== undefined)
    const taskNumbers = this.taskNumbers(request.workspaceId)
    const items = selected.filter((fact): fact is Extract<AgentTeamThreadFact, { kind: 'message' }> => fact.kind === 'message').map(fact => {
      const message = fact.message
      const thread = this.requireThread(message.threadRef)
      const task = thread.taskRef === undefined ? undefined : this.state.tasks.get(thread.taskRef)
      const facts = this.state.factsByThread.get(thread.threadRef) ?? []
      return Object.freeze({ message, mentions: fact.mentions, ...(task === undefined ? {} : { task, taskNumber: taskNumbers.get(task.taskRef) ?? 0 }), thread,
        liveClaimOwners: this.liveClaimOwners(task),
        messageCount: this.state.messageCountByThread.get(thread.threadRef) ?? 0,
        lastActivityAt: facts.at(-1)?.occurredAt ?? '' })
    })
    const initialization = this.initialization()
    const nextCursor = selected.length === 0 ? cursor : direction === 'before' ? selected[0]!.sequence : selected.at(-1)!.sequence
    return Object.freeze({
      humanMemberId: initialization.data.humanMemberId,
      workspaces: Object.freeze(memberId === undefined ? [] : this.workspacesOfFrom(this.state, memberId)
        .map(workspaceId => Object.freeze({ workspaceId, default: workspaceId === this.state.members.get(memberId)?.workspaceId }))),
      projects: Object.freeze(projects),
      // Project participation is derived, so this roster is too: every Member
      // that takes part in a visible Project, by explicit enrolment a ledger
      // still carries or by having taken part in one of its Threads. Reading
      // the membership table directly would hide Members that mention rules
      // let you address.
      members: Object.freeze([...projectRefs].flatMap(projectRef => [...this.state.members.keys()]
        .filter(memberId => {
          const state = this.state.members.get(memberId)?.state
          return state !== undefined && state !== 'inactive' && state !== 'archived'
            && this.isProjectMemberFrom(this.state, projectRef, memberId)
        }).sort().map(memberId => Object.freeze({ projectRef, memberId })))),
      owners: Object.freeze([...projectRefs].flatMap(projectRef => this.projectOwnerIds(projectRef)
        .map(memberId => Object.freeze({ projectRef, memberId })))),
      rulesVersion: this.state.rulesVersion,
      tasks: Object.freeze(catalogTasks),
      threads: Object.freeze(catalogThreads),
      taskNumbers: Object.freeze(catalogTasks.map(task => Object.freeze({ taskRef: task.taskRef, taskNumber: taskNumbers.get(task.taskRef) ?? 0 }))),
      items: Object.freeze(items),
      activeTaskThreads: this.activeTaskThreads(catalogTasks, taskNumbers),
      claims: this.claimsForVisibleTasks(catalogTasks),
      activities: Object.freeze(selected.filter((fact): fact is Extract<AgentTeamThreadFact, { kind: 'activity' }> => fact.kind === 'activity').map(fact => fact.activity)),
      cursor: nextCursor,
      hasMore,
    })
  }

  status(): AgentTeamStatus {
    const initialization = this.initialization()
    return Object.freeze({ initialized: true, sequence: this.state.ordered.length, operationCount: this.state.ordered.length,
      projectCount: this.state.projects.size, agentMemberCount: this.state.members.size, humanMemberId: initialization.data.humanMemberId,
      rulesVersion: this.state.rulesVersion })
  }

  getProject(projectRef: AgentTeamProjectRef): AgentTeamProject | undefined {
    return this.state.projects.get(projectRef)
  }

  /** Agent owners of one Project, sorted. The Human owns every Project and is not listed. */
  projectOwnerIds(projectRef: AgentTeamProjectRef): readonly AgentTeamMemberId[] {
    return Object.freeze([...this.state.owners.get(projectRef)?.keys() ?? []].sort())
  }

  /** Active Projects the Agent Member owns, in creation order. */
  ownedProjects(memberId: AgentTeamMemberId): readonly AgentTeamProject[] {
    return Object.freeze([...this.state.projects.values()]
      .filter(project => project.state === 'active' && this.state.owners.get(project.projectRef)?.has(memberId) === true))
  }

  validate(): void {
    this.validateRecords(this.sortedRecords())
  }

  validateAtMount(): void {
    const boot = this.bootValidation
    this.bootValidation = undefined
    const head = this.state.ordered.at(-1)
    if (boot !== undefined
      && boot.records === this.state.ordered.length
      && boot.lastSequence === (head?.sequence ?? 0)
      && boot.lastOperationId === (head?.operationId ?? null)) return
    this.validate()
  }

  hasCommitted(requestId: AgentTeamRequestId): boolean {
    return this.state.byRequest.has(requestId)
  }

  /** Return one stored committed operation by id. */
  getOperation(operationId: AgentTeamOperationId): AgentTeamOperation | undefined {
    return this.state.byOperation.get(operationId)
  }

  private withReleasedActivityScopes(
    scopes: AgentTeamChangeScope[],
    tasks: readonly AgentTeamTask[],
    activities: readonly AgentTeamClaimsReleasedActivity[],
  ): AgentTeamChangeScope[] {
    const projectByTask = new Map(tasks.map(task => [task.taskRef, task.projectRef]))
    for (const activity of activities) {
      scopes.push({ kind: 'thread', threadRef: activity.threadRef })
      const projectRef = projectByTask.get(activity.taskRef)
      if (projectRef !== undefined && !scopes.some(scope => scope.kind === 'project' && scope.projectRef === projectRef)) {
        scopes.push({ kind: 'project', projectRef })
      }
    }
    return scopes
  }

  /** One workspace change scope per Workspace the Member participates in — member-level commits wake every panel that lists it. */
  private memberWorkspaceScopes(memberId: AgentTeamMemberId): AgentTeamChangeScope[] {
    return [...(this.state.participations.get(memberId) ?? [])].map(workspaceId => ({ kind: 'workspace' as const, workspaceId }))
  }

  /**
   * Durable position of the newest shared-projection commit: the version every
   * change waiter outside the presence scope observes. It only moves when a
   * commit has scopes somebody could refetch (`changeScopesOf`), never for
   * private read progress or an audit-only record.
   */
  projectionSequence(): number {
    return this.projectionVersion
  }

  /** Scopes whose projections one committed operation invalidates; undefined wakes every waiter. */
  changeScopesOf(operation: AgentTeamOperation): readonly AgentTeamChangeScope[] | undefined {
    switch (operation.kind) {
      case 'team/initialized':
        return undefined
      case 'team/project-created':
        return [{ kind: 'workspace', workspaceId: operation.data.workspaceId }]
      case 'team/project-updated':
        // The rename is visible in the sidebar list and any open Project/Thread header.
        return [{ kind: 'workspace', workspaceId: operation.data.workspaceId }, { kind: 'project', projectRef: operation.data.project.projectRef }]
      case 'team/member-added':
      case 'team/member-suspended':
      case 'team/member-resumed':
      case 'team/member-session-restarted':
      case 'team/member-context-cleared':
      case 'team/member-session-renewed':
      case 'team/member-session-rolled-over':
      case 'team/member-session-recycled':
      case 'team/member-updated':
      case 'team/member-removed':
        return this.memberWorkspaceScopes(operation.data.member.memberId)
      case 'team/member-archived':
        return this.withReleasedActivityScopes(
          this.memberWorkspaceScopes(operation.data.member.memberId),
          operation.data.tasks,
          operation.data.activities,
        )
      case 'team/member-workspace-joined':
        return [{ kind: 'workspace', workspaceId: operation.data.workspaceId }]
      case 'team/member-workspace-left':
        return this.withReleasedActivityScopes(
          [{ kind: 'workspace', workspaceId: operation.data.workspaceId }],
          operation.data.tasks,
          operation.data.activities,
        )
      case 'team/project-member-added':
        return [{ kind: 'workspace', workspaceId: operation.data.workspaceId }, { kind: 'project', projectRef: operation.data.projectRef }]
      case 'team/project-member-removed':
        return this.withReleasedActivityScopes(
          [
            { kind: 'workspace', workspaceId: operation.data.workspaceId },
            { kind: 'project', projectRef: operation.data.projectRef },
          ],
          operation.data.tasks,
          operation.data.activities,
        )
      case 'team/project-archived': {
        const scopes: AgentTeamChangeScope[] = [
          { kind: 'workspace', workspaceId: operation.data.workspaceId },
          { kind: 'project', projectRef: operation.data.project.projectRef },
        ]
        for (const activity of operation.data.activities) scopes.push({ kind: 'thread', threadRef: activity.threadRef })
        return scopes
      }
      case 'team/message-sent':
      case 'team/thread-replied':
        return [{ kind: 'project', projectRef: operation.data.message.projectRef }, { kind: 'thread', threadRef: operation.data.message.threadRef }]
      case 'team/thread-started':
        return [{ kind: 'project', projectRef: operation.data.projectRef }, { kind: 'thread', threadRef: operation.data.thread.threadRef }]
      case 'team/main-message-posted':
        return [{ kind: 'project', projectRef: operation.data.message.projectRef }]
      case 'team/main-stream-read':
        // Private read progress, like a Thread read: nobody else has anything to refetch.
        return []
      case 'team/thread-promoted':
        return [{ kind: 'project', projectRef: operation.data.task.projectRef }, { kind: 'thread', threadRef: operation.data.thread.threadRef }]
      case 'team/claim-created':
      case 'team/claim-done':
      case 'team/claim-released':
      case 'team/task-changed':
        return [{ kind: 'project', projectRef: operation.data.task.projectRef }, { kind: 'thread', threadRef: operation.data.thread.threadRef }]
      case 'team/thread-attention-changed':
        return [{ kind: 'thread', threadRef: operation.data.thread.threadRef }]
      case 'team/thread-read':
        // A read advances only the reader's private watermark; no projection
        // visible to other participants changes, so nobody is woken.
        return []
      case 'team/dm-sent':
        // A DM changes no shared projection: delivery is a session-level
        // runtime effect, so no change waiter has anything to refetch.
        return []
      case 'team/rules-version-adopted':
        // Later records validate differently; no projection anybody reads changes.
        return []
      case 'team/project-owner-added':
      case 'team/project-owner-removed':
        // Ownership shows on the Project rows and widens who sees the Project.
        return [{ kind: 'workspace', workspaceId: operation.data.workspaceId }, { kind: 'project', projectRef: operation.data.projectRef }]
      default:
        return assertUnhandledKind(operation)
    }
  }

  /** Members whose Inbox projection may have changed; the Host notifies only live ones. */
  affectedMembersOf(operation: AgentTeamOperation): readonly AgentTeamMemberId[] {
    const members = new Set<AgentTeamMemberId>()
    const delta = this.attentionDelta(operation)
    if (delta !== undefined) {
      for (const attention of delta.attention.set) members.add(attention.memberId)
      for (const key of delta.attention.removed) members.add(key.memberId)
      for (const marker of delta.directMarkers.added) members.add(marker.memberId)
      for (const marker of delta.directMarkers.removed) members.add(marker.memberId)
      for (const marker of delta.activityMarkers.added) members.add(marker.memberId)
      for (const marker of delta.activityMarkers.removed) members.add(marker.memberId)
      for (const marker of delta.mainMarkers?.added ?? []) members.add(marker.memberId)
      for (const marker of delta.mainMarkers?.removed ?? []) members.add(marker.memberId)
    }
    for (const threadRef of this.touchedThreadRefs(operation)) {
      for (const follower of this.state.attentionByThread.get(threadRef) ?? []) members.add(follower)
    }
    if (operation.kind === 'team/member-workspace-joined' || operation.kind === 'team/member-workspace-left') members.add(operation.data.memberId)
    if (operation.actor.kind === 'member') members.add(operation.actor.memberId)
    return [...members]
  }

  private touchedThreadRefs(operation: AgentTeamOperation): readonly AgentTeamThreadRef[] {
    switch (operation.kind) {
      case 'team/message-sent':
      case 'team/thread-replied':
        return [operation.data.message.threadRef]
      case 'team/thread-started':
        return [operation.data.anchor.threadRef]
      case 'team/thread-promoted':
        return [operation.data.activity.threadRef]
      case 'team/claim-created':
      case 'team/claim-done':
      case 'team/claim-released':
      case 'team/task-changed':
      case 'team/thread-attention-changed':
        return [operation.data.thread.threadRef]
      case 'team/project-member-removed':
      case 'team/project-archived':
      case 'team/member-removed':
      case 'team/member-archived':
      case 'team/member-workspace-left':
        return operation.data.activities.map(activity => activity.threadRef)
      case 'team/initialized':
      case 'team/project-created':
      case 'team/project-updated':
      case 'team/member-added':
      case 'team/member-workspace-joined':
      case 'team/member-suspended':
      case 'team/member-resumed':
      case 'team/member-session-restarted':
      case 'team/member-context-cleared':
      case 'team/member-session-renewed':
      case 'team/member-session-rolled-over':
      case 'team/member-session-recycled':
      case 'team/member-updated':
      case 'team/project-member-added':
      case 'team/thread-read':
      case 'team/main-message-posted':
      case 'team/main-stream-read':
      case 'team/dm-sent':
      case 'team/rules-version-adopted':
      case 'team/project-owner-added':
      case 'team/project-owner-removed':
        return []
      default:
        return assertUnhandledKind(operation)
    }
  }

  private replay(): void {
    const records = this.sortedRecords()
    this.validateRecords(records)
    for (const [, operation] of records) this.applyAndAdvanceProjectionVersion(operation)
  }

  private validateRecords(records: readonly [AgentTeamOperationId, AgentTeamOperation][]): void {
    const projection = emptyProjection()
    const operationIds = new Set<AgentTeamOperationId>()
    const requestIds = new Set<AgentTeamRequestId>()
    const refs = new Set<string>()
    let previous: AgentTeamOperationId | null = null
    for (const [index, [key, operation]] of records.entries()) {
      const sequence = index + 1
      if (key !== operation.operationId) throw new Error(`agent-team operation key '${key}' differs from record id '${operation.operationId}'`)
      if (operation.sequence !== sequence) throw new Error(`agent-team ledger expected sequence ${sequence}, found ${operation.sequence}`)
      if (operation.previousOperationId !== previous) throw new Error(`agent-team operation ${sequence} has a broken previous-operation link`)
      if (operationIds.has(operation.operationId)) throw new Error(`agent-team ledger repeats operation id '${operation.operationId}'`)
      if (requestIds.has(operation.requestId)) throw new Error(`agent-team ledger repeats request id '${operation.requestId}'`)
      if (sequence === 1) this.assertInitializationRecord(operation)
      else this.validateOperation(operation, projection, refs)
      this.applyTo(projection, operation)
      operationIds.add(operation.operationId)
      requestIds.add(operation.requestId)
      previous = operation.operationId
    }
  }

  private validateOperation(operation: AgentTeamOperation, projection: Projection, refs: Set<string>): void {
    const human = projection.ordered[0]
    if (human === undefined || human.kind !== 'team/initialized') throw new Error('agent-team ledger has no Human Member')
    const humanMemberId = human.data.humanMemberId
    const assertHuman = (): void => {
      // memberId is the durable Human authority; the handle is display-only
      // and may carry a configured name (old records carry the historic
      // literal), so replay never judges it here.
      if (operation.actor.kind !== 'human' || actorMemberId() !== humanMemberId) {
        throw new Error(`agent-team operation ${operation.sequence} has invalid Human authority`)
      }
    }
    const actorMemberId = (): AgentTeamMemberId => {
      if (operation.actor.kind === 'host') throw new Error(`agent-team operation ${operation.sequence} has no Member actor`)
      return operation.actor.memberId
    }
    const assertMember = (): AgentTeamAgentMember => {
      if (operation.actor.kind !== 'member') throw new Error(`agent-team operation ${operation.sequence} requires Member authority`)
      const member = projection.members.get(actorMemberId())
      if (member === undefined || member.state !== 'enabled' || member.handle !== operation.actor.handle) {
        throw new Error(`agent-team operation ${operation.sequence} has invalid Member authority`)
      }
      return member
    }
    if (operation.kind === 'team/initialized') throw new Error('agent-team initialization must be first')
    if (REPLACED_AT_V2_KINDS.includes(operation.kind) && projection.rulesVersion >= 2) {
      throw new Error(`agent-team operation ${operation.sequence} (${operation.kind}) is not written under rules version ${projection.rulesVersion}`)
    }
    if (V2_ONLY_KINDS.includes(operation.kind) && projection.rulesVersion < 2) {
      throw new Error(`agent-team operation ${operation.sequence} (${operation.kind}) needs rules version 2; its segment runs version ${projection.rulesVersion}`)
    }
    if (operation.kind === 'team/project-created') {
      assertHuman()
      const { project, memberIds } = operation.data
      if (projection.projects.has(project.projectRef) || project.createdAtSequence !== operation.sequence || project.workspaceId !== operation.data.workspaceId) throw new Error('invalid Project creation')
      this.addRef(refs, project.projectRef)
      const unique = new Set(memberIds)
      if (unique.size !== memberIds.length) throw new Error('invalid initial Project members')
      for (const memberId of memberIds) {
        const member = projection.members.get(memberId)
        if (member === undefined || !this.participatesInFrom(projection, member.memberId, project.workspaceId) || member.state !== 'enabled') throw new Error('invalid initial Project Member')
      }
      return
    }
    if (operation.kind === 'team/member-added') {
      assertHuman()
      const { member, projectRefs } = operation.data
      if (projection.members.has(member.memberId) || new Set(projectRefs).size !== projectRefs.length) throw new Error('invalid Member creation')
      this.addRef(refs, member.memberId)
      for (const projectRef of projectRefs) {
        const project = projection.projects.get(projectRef)
        if (project === undefined || project.workspaceId !== member.workspaceId) throw new Error('invalid initial Member Project')
      }
      return
    }
    if (operation.kind === 'team/member-suspended' || operation.kind === 'team/member-resumed') {
      assertHuman()
      const prior = projection.members.get(operation.data.member.memberId)
      const expected = operation.kind === 'team/member-suspended' ? 'enabled' : 'suspended'
      const next = operation.kind === 'team/member-suspended' ? 'suspended' : 'enabled'
      if (prior === undefined || prior.state !== expected || operation.data.member.state !== next || !this.sameMemberIdentity(prior, operation.data.member)) throw new Error('invalid Member lifecycle transition')
      return
    }
    if (operation.kind === 'team/member-session-restarted') {
      assertHuman()
      const prior = projection.members.get(operation.data.member.memberId)
      // The restart records the unchanged Member: same identity, still enabled.
      if (prior === undefined || prior.state !== 'enabled' || !this.sameMemberIdentity(prior, operation.data.member)) throw new Error('invalid Member restart')
      return
    }
    if (operation.kind === 'team/member-context-cleared') {
      assertHuman()
      const prior = projection.members.get(operation.data.member.memberId)
      if (prior === undefined || prior.state !== 'enabled' || !this.sameMemberIdentity(prior, operation.data.member)) throw new Error('invalid Member context clear')
      return
    }
    if (operation.kind === 'team/member-session-renewed') {
      assertHuman()
      const prior = projection.members.get(operation.data.member.memberId)
      // The renewal moves exactly the sessionId: the prior Member must be
      // enabled on the recorded previous Session, and every other fact must
      // carry over unchanged.
      if (prior === undefined || prior.state !== 'enabled'
        || prior.sessionId !== operation.data.previousSessionId
        || operation.data.member.sessionId === operation.data.previousSessionId
        || !this.sameMemberFacts(prior, operation.data.member)) throw new Error('invalid Member session renewal')
      return
    }
    if (operation.kind === 'team/project-owner-added' || operation.kind === 'team/project-owner-removed') {
      assertHuman()
      const problem = this.projectOwnerChangeProblem(projection, operation.kind, operation.data)
      if (problem !== undefined) throw new Error(`agent-team operation ${operation.sequence}: ${problem}`)
      const { activity } = operation.data
      if (activity.projectRef !== operation.data.projectRef || activity.memberId !== operation.data.memberId
        || activity.kind !== (operation.kind === 'team/project-owner-added' ? 'owner-added' : 'owner-removed')
        || activity.actor !== actorMemberId() || activity.sequence !== operation.sequence || activity.occurredAt !== operation.occurredAt) {
        throw new Error('invalid Project owner activity')
      }
      this.addRef(refs, activity.activityRef)
      if (!isDeepStrictEqual(operation.data.inbox, this.ownerActivityInboxDelta(activity))) throw new Error('invalid Project owner inbox projection')
      this.validateInboxDelta(operation.data.inbox, projection, refs, [], [], [], [], [activity])
      return
    }
    if (operation.kind === 'team/rules-version-adopted') {
      if (operation.actor.kind !== 'host' || operation.actor.handle !== 'agent-team') throw new Error('invalid rules version authority')
      const { version } = operation.data
      if (version <= projection.rulesVersion) throw new Error(`agent-team operation ${operation.sequence} adopts rules version ${version} after version ${projection.rulesVersion}`)
      if (version > this.rulesVersion) {
        const remedy = version <= AGENT_TEAM_PREVIEW_RULES_VERSION ? `it was opened with the ${AGENT_TEAM_PREVIEW_RULES_ENV}=1 preview` : 'open it with a newer release'
        throw new Error(`agent-team ledger adopted rules version ${version}, but this build implements up to ${this.rulesVersion}; ${remedy}`)
      }
      return
    }
    if (operation.kind === 'team/member-session-recycled') {
      if (operation.actor.kind !== 'host' || operation.actor.handle !== 'agent-team') throw new Error('invalid Member session recycling authority')
      const prior = projection.members.get(operation.data.member.memberId)
      if (prior === undefined || prior.state !== 'enabled'
        || prior.sessionId !== operation.data.previousSessionId
        || operation.data.member.sessionId !== operation.data.newSessionId
        || operation.data.member.sessionId === operation.data.previousSessionId
        || !this.sameMemberFacts(prior, operation.data.member)) throw new Error('invalid Member session recycling')
      return
    }
    if (operation.kind === 'team/member-session-rolled-over') {
      // The rollover's business actor is the calling Member itself; the Host
      // only executes the recorded transition. Authorization is self-scoped:
      // the actor must be the enabled target Member on its currently bound
      // Session, and the recorded transition moves exactly the sessionId.
      const actorMember = assertMember()
      const prior = projection.members.get(operation.data.member.memberId)
      if (actorMember.memberId !== operation.data.member.memberId) throw new Error('rolled-over Member must match its actor')
      if (prior === undefined || prior.state !== 'enabled'
        || prior.sessionId !== operation.data.previousSessionId
        || operation.data.member.sessionId !== operation.data.newSessionId
        || operation.data.member.sessionId === operation.data.previousSessionId
        || !this.sameMemberFacts(prior, operation.data.member)) throw new Error('invalid Member session rollover')
      if (operation.data.sourceSessionId !== undefined && operation.data.sourceThroughSeq === undefined) throw new Error('rolled-over checkpoint seed requires a through sequence')
      if (operation.data.sourceThroughSeq !== undefined && operation.data.sourceSessionId === undefined) throw new Error('rolled-over through sequence requires a source Session')
      if ((operation.data.checkpointRef !== undefined) !== (operation.data.sourceSessionId !== undefined)) throw new Error('rolled-over checkpoint fields must appear together')
      return
    }
    if (operation.kind === 'team/project-updated') {
      assertHuman()
      const prior = projection.projects.get(operation.data.project.projectRef)
      if (prior === undefined || prior.workspaceId !== operation.data.workspaceId
        || operation.data.project.workspaceId !== prior.workspaceId || operation.data.project.createdAtSequence !== prior.createdAtSequence
        || operation.data.project.state !== prior.state) {
        throw new Error('invalid Project update')
      }
      return
    }
    if (operation.kind === 'team/member-updated') {
      assertHuman()
      const prior = projection.members.get(operation.data.member.memberId)
      if (prior === undefined || prior.state === 'inactive' || prior.state === 'archived' || operation.data.member.state !== prior.state
        || operation.data.member.sessionId !== prior.sessionId || operation.data.member.workspaceId !== prior.workspaceId
        || operation.data.member.presetId !== prior.presetId
        || operation.data.member.privateMemoryPath !== prior.privateMemoryPath) throw new Error('invalid Member update')
      // The renamed handle must stay unique among the live Members sharing any Workspace participation.
      const normalized = operation.data.member.handle.normalize('NFKC').trim().toLowerCase()
      for (const other of projection.members.values()) {
        if (other.memberId !== prior.memberId && other.state !== 'inactive' && this.participationOverlapFrom(projection, other.memberId, prior.memberId)
          && other.handle.normalize('NFKC').trim().toLowerCase() === normalized) throw new Error('invalid Member update handle')
      }
      if (normalized === this.humanHandle.normalize('NFKC').trim().toLowerCase()) throw new Error('invalid Member update handle')
      return
    }
    if (operation.kind === 'team/project-member-added') {
      assertHuman()
      const project = projection.projects.get(operation.data.projectRef)
      const member = projection.members.get(operation.data.memberId)
      if (project === undefined || member === undefined || !this.participatesInFrom(projection, member.memberId, project.workspaceId) || operation.data.workspaceId !== project.workspaceId || projection.memberships.get(project.projectRef)?.has(member.memberId)) throw new Error('invalid Project membership')
      return
    }
    if (operation.kind === 'team/project-member-removed') {
      assertHuman()
      const project = projection.projects.get(operation.data.projectRef)
      const member = projection.members.get(operation.data.memberId)
      if (project === undefined || member === undefined || operation.data.workspaceId !== project.workspaceId
        || !this.participatesInFrom(projection, member.memberId, project.workspaceId) || !projection.memberships.get(project.projectRef)?.has(member.memberId)) throw new Error('invalid Project membership removal')
      const threadRefs = new Set([...projection.threads.keys()].filter(threadRef => this.projectRefForThreadFrom(projection, threadRef) === project.projectRef))
      this.validateReleaseCleanup(operation.data, projection, member.memberId, threadRefs, operation.sequence, refs, new Set([project.projectRef]))
      return
    }
    if (operation.kind === 'team/member-workspace-joined') {
      assertHuman()
      const member = projection.members.get(operation.data.memberId)
      if (member === undefined || member.state === 'inactive' || member.state === 'archived'
        || this.participatesInFrom(projection, member.memberId, operation.data.workspaceId)) throw new Error('invalid Workspace join')
      this.assertHandleAvailableFrom(projection, operation.data.workspaceId, member.handle)
      return
    }
    if (operation.kind === 'team/member-workspace-left') {
      assertHuman()
      const member = projection.members.get(operation.data.memberId)
      if (member === undefined || member.state === 'inactive' || member.state === 'archived'
        || operation.data.workspaceId === member.workspaceId
        || !this.participatesInFrom(projection, member.memberId, operation.data.workspaceId)) throw new Error('invalid Workspace leave')
      const threadRefs = this.workspaceThreadRefsFrom(projection, operation.data.workspaceId)
      this.validateReleaseCleanup(operation.data, projection, member.memberId, threadRefs, operation.sequence, refs, this.workspaceProjectRefsFrom(projection, operation.data.workspaceId))
      return
    }
    if (operation.kind === 'team/project-archived') {
      assertHuman()
      const prior = projection.projects.get(operation.data.project.projectRef)
      if (prior === undefined || prior.state !== 'active' || operation.data.project.state !== 'archived'
        || operation.data.project.workspaceId !== prior.workspaceId || operation.data.workspaceId !== prior.workspaceId
        || operation.data.project.name !== prior.name || operation.data.project.description !== prior.description
        || operation.data.project.createdAtSequence !== prior.createdAtSequence) throw new Error('invalid Project archival')
      const threadRefs = new Set([...projection.threads.keys()].filter(threadRef => this.projectRefForThreadFrom(projection, threadRef) === prior.projectRef))
      this.validateReleaseCleanup(operation.data, projection, undefined, threadRefs, operation.sequence, refs, new Set([prior.projectRef]))
      return
    }
    if (operation.kind === 'team/member-removed') {
      assertHuman()
      const prior = projection.members.get(operation.data.member.memberId)
      if (prior === undefined || prior.state === 'inactive' || operation.data.member.state !== 'inactive' || !this.sameMemberIdentity(prior, operation.data.member)) throw new Error('invalid Member removal')
      const threadRefs = new Set(projection.threads.keys())
      this.validateReleaseCleanup(operation.data, projection, prior.memberId, threadRefs, operation.sequence, refs, undefined)
      return
    }
    if (operation.kind === 'team/member-archived') {
      assertHuman()
      const prior = projection.members.get(operation.data.member.memberId)
      if (prior === undefined || (prior.state !== 'enabled' && prior.state !== 'suspended') || operation.data.member.state !== 'archived' || !this.sameMemberIdentity(prior, operation.data.member)) throw new Error('invalid Member archival')
      const threadRefs = new Set(projection.threads.keys())
      this.validateReleaseCleanup(operation.data, projection, prior.memberId, threadRefs, operation.sequence, refs, undefined)
      return
    }
    if (operation.kind === 'team/thread-attention-changed') {
      const actor = operation.actor.kind === 'member' ? assertMember() : (assertHuman(), undefined)
      if (operation.actor.kind === 'host' || operation.data.memberId !== operation.actor.memberId) throw new Error('Attention operation has wrong actor')
      const thread = projection.threads.get(operation.data.thread.threadRef)
      const task = operation.data.task
      const currentTask = thread?.taskRef === undefined ? undefined : projection.tasks.get(thread.taskRef)
      const projectRef = thread === undefined ? undefined : this.projectRefForThreadFrom(projection, thread.threadRef)
      if (thread === undefined || projectRef === undefined || !this.sameThread(thread, operation.data.thread)
        || (task === undefined ? currentTask !== undefined : currentTask === undefined || !this.sameTask(currentTask, task) || thread.taskRef !== task.taskRef)
        || (actor !== undefined && !this.participatesInProjectWorkspaceFrom(projection, projectRef, actor.memberId))) throw new Error('invalid Attention operation')
      const current = this.attentionForFrom(projection, operation.data.memberId, thread.threadRef)
      if ((operation.data.action === 'follow' && (task?.resolution === 'closed' || current !== undefined))
        || (operation.data.action === 'unfollow' && (current === undefined || (task !== undefined && this.hasActiveClaimFrom(projection, operation.data.memberId, task.taskRef))))) {
        throw new Error('invalid Attention transition')
      }
      const expected = operation.data.action === 'follow'
        ? this.inboxDelta([this.followAttentionFrom(projection, operation.data.memberId, thread.threadRef)])
        : this.inboxDelta([], [{ memberId: operation.data.memberId, threadRef: thread.threadRef }], [], this.frozenMarkerSnapshot(projection, operation.data.memberId, thread.threadRef))
      if (!isDeepStrictEqual(operation.data.inbox, expected)) throw new Error('invalid Attention projection')
      this.validateInboxDelta(operation.data.inbox, projection, refs)
      return
    }
    if (operation.kind === 'team/thread-read') {
      if (operation.actor.kind === 'member') assertMember(); else assertHuman()
      const data = operation.data
      if (operation.actor.kind === 'host' || data.memberId !== operation.actor.memberId) throw new Error('Thread read has wrong actor')
      const target = threadReadTargetOf(data)
      if (isThreadReadSnapshot(data)) this.validateLegacyThreadReadSnapshot(data, projection, target)
      else this.validateThreadReadReceipt(data, projection, target)
      this.validateInboxDelta(data.inbox, projection, refs)
      return
    }
    if (operation.kind === 'team/thread-promoted') {
      const promoter = operation.actor.kind === 'member' && projection.rulesVersion >= 2 ? assertMember() : (assertHuman(), undefined)
      const { activity, task, thread } = operation.data
      const priorThread = projection.threads.get(thread.threadRef)
      const projectRef = priorThread === undefined ? undefined : this.projectRefForThreadFrom(projection, thread.threadRef)
      if (priorThread === undefined || priorThread.taskRef !== undefined || projection.tasks.has(task.taskRef)
        || projectRef === undefined || task.projectRef !== projectRef
        || projection.projects.get(projectRef)?.workspaceId !== operation.data.workspaceId
        || operation.data.baseRevision !== priorThread.revision
        || task.status !== 'todo' || task.resolution !== 'open'
        || thread.revision !== operation.sequence || task.threadRef !== thread.threadRef || thread.taskRef !== task.taskRef
        || !this.sameThread(thread, { ...priorThread, taskRef: task.taskRef, revision: operation.sequence })
        || activity.kind !== 'promote' || activity.sequence !== operation.sequence || activity.actor !== actorMemberId()
        || activity.taskRef !== task.taskRef || activity.threadRef !== thread.threadRef) throw new Error('invalid Thread promotion')
      if (promoter !== undefined && !this.isProjectOwnerFrom(projection, projectRef, promoter.memberId)) throw new Error('invalid Thread promotion: not a Project owner')
      this.addRef(refs, task.taskRef)
      this.addRef(refs, activity.activityRef)
      const expectedInbox = this.promoteThreadInboxFrom(projection, activity, thread.threadRef)
      if (!isDeepStrictEqual(operation.data.inbox, expectedInbox)) throw new Error('invalid Promotion inbox projection')
      this.validateInboxDelta(operation.data.inbox, projection, refs, [], [], [activity])
      return
    }
    if (operation.kind === 'team/thread-started') {
      const actor = operation.actor.kind === 'member' ? assertMember() : (assertHuman(), undefined)
      const { anchor, task, thread, projectRef, kind, mentions } = operation.data
      const project = projection.projects.get(projectRef)
      if (project === undefined || project.workspaceId !== operation.data.workspaceId || project.state === 'archived'
        || anchor.projectRef !== projectRef || anchor.sender !== actorMemberId() || !anchor.topLevel
        || anchor.sequence !== operation.sequence || anchor.occurredAt !== operation.occurredAt
        || thread.revision !== operation.sequence || anchor.threadRef !== thread.threadRef || projection.threads.has(thread.threadRef)
        || (kind === 'task') !== (task !== undefined)
        || (task === undefined ? anchor.taskRef !== undefined || thread.taskRef !== undefined
          : anchor.taskRef !== task.taskRef || thread.taskRef !== task.taskRef || task.threadRef !== thread.threadRef
            || task.projectRef !== projectRef || task.status !== 'todo' || task.resolution !== 'open' || projection.tasks.has(task.taskRef))) {
        throw new Error('invalid Thread start')
      }
      if (actor !== undefined && !this.isProjectOwnerFrom(projection, projectRef, actor.memberId)) throw new Error('invalid Thread start: not a Project owner')
      this.addRef(refs, thread.threadRef)
      if (task !== undefined) this.addRef(refs, task.taskRef)
      this.addRef(refs, anchor.messageRef)
      this.validateMentions(mentions, anchor, projection)
      const expected = this.messageInboxDelta(anchor, anchor.sender, mentions, [this.startAttention(anchor.sender, thread.threadRef, operation.sequence)])
      if (!isDeepStrictEqual(operation.data.inbox, expected)) throw new Error('invalid Thread start inbox projection')
      this.validateInboxDelta(operation.data.inbox, projection, refs, [thread.threadRef], [anchor])
      return
    }
    if (operation.kind === 'team/main-message-posted') {
      const actor = operation.actor.kind === 'member' ? assertMember() : (assertHuman(), undefined)
      const { message, mentions } = operation.data
      const project = projection.projects.get(message.projectRef)
      if (project === undefined || project.workspaceId !== operation.data.workspaceId || project.state === 'archived'
        || message.sender !== actorMemberId() || message.sequence !== operation.sequence || message.occurredAt !== operation.occurredAt
        || (actor !== undefined && !this.isProjectMemberFrom(projection, project.projectRef, actor.memberId))) throw new Error('invalid Main stream Message')
      const parentSource = message.replyToMessageRef === undefined ? undefined : projection.mainSourceByRef.get(message.replyToMessageRef)
      if (message.replyToMessageRef !== undefined && (parentSource?.kind !== 'message' || parentSource.message.projectRef !== project.projectRef
        || (parentSource.message.sender !== message.sender && !mentions.includes(parentSource.message.sender)))) throw new Error('invalid Main stream reply target')
      this.addRef(refs, message.messageRef)
      this.validateMentions(mentions, message, projection)
      if (!isDeepStrictEqual(operation.data.inbox, this.mainMessageInboxDelta(message, mentions))) throw new Error('invalid Main stream inbox projection')
      this.validateInboxDelta(operation.data.inbox, projection, refs, [], [], [], [message])
      return
    }
    if (operation.kind === 'team/main-stream-read') {
      const actor = operation.actor.kind === 'member' ? assertMember() : (assertHuman(), undefined)
      const { projectRef, memberId, readThroughSequence } = operation.data
      const project = projection.projects.get(projectRef)
      if (project === undefined || project.workspaceId !== operation.data.workspaceId || project.state === 'archived'
        || memberId !== actorMemberId() || readThroughSequence > this.mainHeadFrom(projection, projectRef)
        || (actor !== undefined && !this.isProjectMemberFrom(projection, projectRef, actor.memberId))) throw new Error('invalid Main stream read')
      const expected = this.prepareMainReadFrom(projection, memberId, projectRef, readThroughSequence)
      if (!isDeepStrictEqual(operation.data.inbox, expected.inbox)) throw new Error('invalid Main stream read receipt')
      this.validateInboxDelta(operation.data.inbox, projection, refs)
      return
    }
    if (operation.kind === 'team/message-sent' || operation.kind === 'team/thread-replied') {
      const actor = operation.actor.kind === 'member' ? assertMember() : (assertHuman(), undefined)
      const { message, task, thread } = operation.data
      const project = projection.projects.get(message.projectRef)
      if (project === undefined || project.workspaceId !== operation.data.workspaceId || message.sender !== actorMemberId()
        || message.sequence !== operation.sequence || thread.revision !== operation.sequence
        || message.threadRef !== thread.threadRef
        || (task === undefined ? message.taskRef !== undefined || thread.taskRef !== undefined
          : message.taskRef !== task.taskRef || thread.taskRef !== task.taskRef || task.threadRef !== thread.threadRef || task.projectRef !== project.projectRef)
        || (actor !== undefined && !this.participatesInProjectWorkspaceFrom(projection, project.projectRef, actor.memberId))) throw new Error('invalid Message operation')
      if (operation.kind === 'team/message-sent') {
        if (!message.topLevel || projection.threads.has(thread.threadRef) || (task !== undefined && projection.tasks.has(task.taskRef))) {
          throw new Error('invalid top-level Message operation')
        }
        this.addRef(refs, thread.threadRef)
        if (task !== undefined) this.addRef(refs, task.taskRef)
      } else {
        const priorThread = projection.threads.get(thread.threadRef)
        const priorTask = task === undefined ? undefined : projection.tasks.get(task.taskRef)
        if (message.topLevel || priorThread === undefined || operation.data.baseRevision !== priorThread.revision
          || priorThread.taskRef !== thread.taskRef
          || (task === undefined ? priorTask !== undefined : priorTask === undefined || !this.sameTask(priorTask, task))) {
          throw new Error('invalid Thread reply')
        }
        if (projection.rulesVersion >= 2 && actor !== undefined && !this.isProjectMemberFrom(projection, project.projectRef, actor.memberId)) {
          throw new Error('invalid Thread reply: not a Project member')
        }
      }
      this.addRef(refs, message.messageRef)
      this.validateMentions(operation.data.mentions, message, projection)
      this.validateInboxDelta(operation.data.inbox, projection, refs, [thread.threadRef], [message])
      this.validateMessageInbox(operation, projection)
      return
    }
    if (operation.kind === 'team/claim-created' || operation.kind === 'team/claim-done' || operation.kind === 'team/claim-released') {
      const actor = operation.actor.kind === 'member' ? assertMember() : (assertHuman(), undefined)
      const { task, thread, claim, activity } = operation.data
      const priorTask = projection.tasks.get(task.taskRef)
      const priorThread = projection.threads.get(thread.threadRef)
      if (priorTask === undefined || priorThread === undefined || priorThread.revision !== operation.data.baseRevision
        || !this.sameTaskIdentity(priorTask, task) || task.threadRef !== thread.threadRef || task.taskRef !== thread.taskRef
        || thread.revision !== operation.sequence || activity.sequence !== operation.sequence || activity.actor !== actorMemberId()
        || activity.taskRef !== task.taskRef || activity.threadRef !== thread.threadRef || activity.claimRef !== claim.claimRef
        || (actor !== undefined && !this.participatesInProjectWorkspaceFrom(projection, task.projectRef, actor.memberId))) throw new Error('invalid Claim operation')
      const creates = operation.kind === 'team/claim-created'
      const expectedKind = creates ? 'claim' : operation.kind === 'team/claim-done' ? 'done' : 'release'
      if (activity.kind !== expectedKind || claim.taskRef !== task.taskRef || claim.threadRef !== thread.threadRef) throw new Error('invalid Claim activity')
      if (operation.actor.kind !== 'member') throw new Error('invalid Claim authority')
      if ((creates && projection.claims.has(claim.claimRef))
        || (creates && claim.owner !== actorMemberId()) || (creates && claim.state !== 'active')) throw new Error('invalid Claim creation')
      if (creates && projection.rulesVersion >= 2 && !this.isProjectMemberFrom(projection, task.projectRef, actorMemberId())) throw new Error('invalid Claim creation: not a Project member')
      const previousClaim = projection.claims.get(claim.claimRef)
      if (!creates && (previousClaim === undefined || previousClaim.state !== 'active' || !this.sameClaimIdentity(previousClaim, claim)
        || (operation.actor.kind === 'member' && previousClaim.owner !== operation.actor.memberId)
        || claim.state !== (operation.kind === 'team/claim-done' ? 'done' : 'released'))) throw new Error('invalid Claim transition')
      if (task.status !== this.deriveResolvedTaskStatus(task, new Map(projection.claims).set(claim.claimRef, claim).values())) throw new Error('invalid Claim Task status')
      this.addRef(refs, activity.activityRef)
      if (creates) this.addRef(refs, claim.claimRef)
      const expectedInbox = creates && !this.isFollowingFrom(projection, thread.threadRef, actorMemberId())
        ? this.inboxDelta([this.startAttention(actorMemberId(), thread.threadRef, operation.sequence)])
        : this.inboxDelta()
      if (!isDeepStrictEqual(operation.data.inbox, expectedInbox)) throw new Error('invalid Claim inbox projection')
      this.validateInboxDelta(operation.data.inbox, projection, refs)
      return
    }
    if (operation.kind === 'team/task-changed') {
      assertHuman()
      const { task, thread, activity } = operation.data
      const priorTask = projection.tasks.get(task.taskRef)
      const priorThread = projection.threads.get(thread.threadRef)
      if (priorTask === undefined || priorThread === undefined || priorThread.revision !== operation.data.baseRevision
        || task.threadRef !== thread.threadRef || !this.sameThread(thread, { ...priorThread, revision: operation.sequence })
        || activity.sequence !== operation.sequence || activity.actor !== actorMemberId()
        || activity.taskRef !== task.taskRef || activity.threadRef !== thread.threadRef) throw new Error('invalid Task operation')
      const expectedResolution = activity.kind === 'accept' ? 'accepted' : activity.kind === 'close' ? 'closed' : 'open'
      const expectedStatus = expectedResolution === 'accepted' ? 'done' : expectedResolution === 'closed' ? 'closed'
        : this.deriveTaskStatus(task.taskRef, operation.data.claims)
      const expectedCompletedClaimRefs = operation.data.claims
        .filter(claim => projection.claims.get(claim.claimRef)?.state === 'active' && claim.state === 'done')
        .map(claim => claim.claimRef)
      // New-shape accepts carry the acceptance discriminator: every done
      // Claim at commit time, sorted. Legacy accepts without it keep
      // completed-only wake semantics as recorded.
      const expectedAcceptedClaimRefs = operation.data.claims
        .filter(claim => claim.state === 'done')
        .map(claim => claim.claimRef)
        .sort((left, right) => left.localeCompare(right))
      if (task.resolution !== expectedResolution || task.status !== expectedStatus
        || (activity.kind !== 'close' && activity.releasedClaimRefs !== undefined)
        || (activity.kind !== 'accept' && activity.completedClaimRefs !== undefined)
        || (activity.kind !== 'accept' && activity.acceptedClaimRefs !== undefined)
        || (activity.kind === 'close' && !this.sameList(activity.releasedClaimRefs ?? [], operation.data.claims
          .filter(claim => projection.claims.get(claim.claimRef)?.state === 'active' && claim.state === 'released')
          .map(claim => claim.claimRef)))
        || !this.sameList(activity.completedClaimRefs ?? [], expectedCompletedClaimRefs)
        || (activity.kind === 'accept' && activity.acceptedClaimRefs !== undefined
          && !this.sameList(activity.acceptedClaimRefs, expectedAcceptedClaimRefs))) {
        throw new Error('invalid Task state transition')
      }
      const priorClaims = [...(projection.claimsByTask.get(task.taskRef) ?? [])].sort((left, right) => left.claimRef.localeCompare(right.claimRef))
      const operationClaims = [...operation.data.claims].sort((left, right) => left.claimRef.localeCompare(right.claimRef))
      if (priorClaims.length !== operationClaims.length || priorClaims.some((claim, index) => claim.claimRef !== operationClaims[index]?.claimRef)) throw new Error('invalid Task Claim set')
      for (const claim of operationClaims) {
        const previousClaim = projection.claims.get(claim.claimRef)
        if (previousClaim === undefined || !this.sameClaimIdentity(previousClaim, claim)) throw new Error('invalid Task Claim identity')
        const legal = activity.kind === 'close'
          ? (previousClaim.state === 'active' ? claim.state === 'released' : claim.state === previousClaim.state)
          : activity.kind === 'accept'
            ? (previousClaim.state === 'active' ? claim.state === 'done' : claim.state === previousClaim.state)
            : claim.state === previousClaim.state
        if (!legal) throw new Error('invalid Task Claim transition')
      }
      this.addRef(refs, activity.activityRef)
      const expectedInbox = activity.kind === 'close'
        ? this.closeThreadInboxFrom(projection, activity, thread.threadRef)
        : activity.kind === 'reopen'
          ? this.reopenThreadInboxFrom(projection, activity, thread.threadRef)
          // Presence of the discriminator picks the wake rule: new accepts
          // wake every done owner; legacy records keep the completed-only
          // delta exactly as recorded.
          : this.acceptThreadInboxFrom(projection, activity, thread.threadRef,
            activity.acceptedClaimRefs !== undefined ? activity.acceptedClaimRefs : expectedCompletedClaimRefs)
      if (!isDeepStrictEqual(operation.data.inbox, expectedInbox)) throw new Error('invalid Task inbox projection')
      this.validateInboxDelta(operation.data.inbox, projection, refs, [], [], [activity])
      return
    }
    if (operation.kind === 'team/dm-sent') {
      const sender = assertMember()
      const recipient = projection.members.get(operation.data.recipientMemberId)
      if (recipient === undefined || !this.participatesInFrom(projection, recipient.memberId, operation.data.workspaceId)
        || recipient.state !== 'enabled' || recipient.memberId === AGENT_TEAM_HUMAN_MEMBER_ID
        || operation.data.senderMemberId !== sender.memberId
        || operation.data.recipientMemberId === sender.memberId
        || operation.data.body.trim() === '' || operation.data.body !== operation.data.body.trim()) {
        throw new Error('invalid DM operation')
      }
      return
    }
    assertUnhandledKind(operation)
  }

  /**
   * Validation of one operation's Inbox delta against the projection it was
   * derived from.
   *
   * Direct marker references resolve through the replay-derived Message index:
   * this runs once per inbox-carrying record, so a rescan of the Message list
   * here would make every record cost the whole ledger. The index is written by
   * the same fact appends that build `factsByThread`, so a lookup sees exactly
   * the records replayed before this one and can never reach a Message that
   * arrives later — which is why the operation's own entity, not yet in the
   * projection, needs the `additional*` fallbacks. The commit path resolved the
   * projection first and then its own record, and that precedence is kept.
   */
  private validateInboxDelta(
    delta: AgentTeamInboxDelta,
    projection: Projection,
    _refs: Set<string>,
    additionalThreadRefs: readonly AgentTeamThreadRef[] = [],
    additionalMessages: readonly AgentTeamMessage[] = [],
    additionalActivities: readonly AgentTeamActivity[] = [],
    additionalMainMessages: readonly AgentTeamMainMessage[] = [],
    additionalMainActivities: readonly AgentTeamMainActivity[] = [],
  ): void {
    const attentionKeys = new Set<string>()
    for (const attention of delta.attention.set) {
      if ((!projection.threads.has(attention.threadRef) && !additionalThreadRefs.includes(attention.threadRef)) || attention.startSequence < 1
        || attention.readThroughSequence < attention.startSequence - 1) {
        throw new Error('invalid Attention delta')
      }
      const key = this.attentionKey(attention.memberId, attention.threadRef)
      if (attentionKeys.has(key)) throw new Error('repeated Attention delta')
      attentionKeys.add(key)
    }
    for (const key of delta.attention.removed) {
      if (attentionKeys.has(this.attentionKey(key.memberId, key.threadRef))) throw new Error('conflicting Attention delta')
    }
    const markerKeys = new Set<string>()
    for (const marker of delta.directMarkers.added) {
      const key = this.directMarkerKey(marker)
      if (markerKeys.has(key) || projection.directMarkers.has(key)) throw new Error('invalid direct marker addition')
      markerKeys.add(key)
      const message = projection.messagesByRef.get(marker.messageRef) ?? additionalMessages.find(candidate => candidate.messageRef === marker.messageRef)
      if (message === undefined || message.threadRef !== marker.threadRef || message.sequence !== marker.sequence
        || !this.validMentionTarget(projection, message.projectRef, marker.memberId)) throw new Error('invalid direct marker addition')
    }
    for (const marker of delta.directMarkers.removed) {
      const key = this.directMarkerKey(marker)
      if (markerKeys.has(key) || !projection.directMarkers.has(key)) throw new Error('invalid direct marker removal')
      markerKeys.add(key)
      const current = projection.directMarkers.get(key)!
      const message = projection.messagesByRef.get(marker.messageRef) ?? additionalMessages.find(candidate => candidate.messageRef === marker.messageRef)
      if (!isDeepStrictEqual(current, marker) || message === undefined || message.threadRef !== marker.threadRef
        || message.sequence !== marker.sequence || !this.validMentionTarget(projection, message.projectRef, marker.memberId)) {
        throw new Error('invalid direct marker removal')
      }
    }
    const activityMarkerKeys = new Set<string>()
    for (const marker of delta.activityMarkers.added) {
      const key = this.activityMarkerKey(marker)
      // Every activity marker is minted for the activity the same record
      // carries (promotion, close, reopen, acceptance), and a removal never
      // looks an activity up, so this record's own list is the whole
      // resolution space: scanning recorded activities would add nothing.
      const activity = additionalActivities.find(candidate => candidate.activityRef === marker.activityRef)
      if (activityMarkerKeys.has(key) || projection.activityMarkers.has(key) || activity === undefined
        || activity.threadRef !== marker.threadRef || activity.sequence !== marker.sequence) throw new Error('invalid activity marker addition')
      activityMarkerKeys.add(key)
    }
    for (const marker of delta.activityMarkers.removed) {
      const key = this.activityMarkerKey(marker)
      if (activityMarkerKeys.has(key) || !isDeepStrictEqual(projection.activityMarkers.get(key), marker)) {
        throw new Error('invalid activity marker removal')
      }
      activityMarkerKeys.add(key)
    }
    const mainKeys = new Set<string>()
    for (const marker of delta.mainMarkers?.added ?? []) {
      const key = mainMarkerKey(marker)
      // A Main stream marker always points at the Message or Activity its own record carries.
      const target = 'messageRef' in marker
        ? additionalMainMessages.find(candidate => candidate.messageRef === marker.messageRef)
        : additionalMainActivities.find(candidate => candidate.activityRef === marker.activityRef)
      if (mainKeys.has(key) || projection.mainMarkers.has(key) || target === undefined || target.projectRef !== marker.projectRef
        || target.sequence !== marker.sequence || !this.validMentionTarget(projection, marker.projectRef, marker.memberId)) throw new Error('invalid Main stream marker addition')
      mainKeys.add(key)
    }
    for (const marker of delta.mainMarkers?.removed ?? []) {
      const key = mainMarkerKey(marker)
      if (mainKeys.has(key) || !isDeepStrictEqual(projection.mainMarkers.get(key), marker)) throw new Error('invalid Main stream marker removal')
      mainKeys.add(key)
    }
  }

  /**
   * Replay validation of one departure's release snapshot against the
   * projection it was derived from. `memberId` scopes everything to a single
   * departing Member; `undefined` validates every owner, which is what
   * archiving a whole Project releases. The two scopes differ in exactly four
   * ways, all of them visible here rather than spread over two copies:
   *
   * 1. released Claims are owner-filtered for a Member, unfiltered for a Project;
   * 2. Activities group per (owner, Thread) with owners sorted, which for a
   *    single departing Member collapses to one Activity per Thread — the shape
   *    the commit path writes;
   * 3. the inbox cleanup covers the departing Member's Attention and markers, or
   *    every Member's on the archived Project's Threads;
   * 4. the failure message names which of the two paths lost its cleanup.
   */
  private validateReleaseCleanup(
    data: AgentTeamProjectMemberRemovedOperation['data'] | AgentTeamMemberRemovedOperation['data']
      | AgentTeamMemberArchivedOperation['data'] | AgentTeamProjectArchivedOperation['data']
      | AgentTeamMemberWorkspaceLeftOperation['data'],
    projection: Projection,
    memberId: AgentTeamMemberId | undefined,
    threadRefs: ReadonlySet<AgentTeamThreadRef>,
    sequence: number,
    refs: Set<string>,
    projectRefs: ReadonlySet<AgentTeamProjectRef> | undefined,
  ): void {
    const releasedClaims = [...projection.claims.values()]
      .filter(claim => (memberId === undefined || claim.owner === memberId) && claim.state === 'active' && threadRefs.has(claim.threadRef))
      .map(claim => Object.freeze({ ...claim, state: 'released' as const }))
    if (data.claims.length !== releasedClaims.length || data.claims.some((claim, index) => {
      const expected = releasedClaims[index]
      return expected === undefined || !this.sameClaim(expected, claim)
    })) throw new Error('invalid released Claim projection')

    // One Activity per (owner, Thread), owners sorted like the commit path.
    const byOwner = new Map<AgentTeamMemberId, Map<AgentTeamThreadRef, AgentTeamClaim[]>>()
    for (const claim of releasedClaims) {
      const byThread = byOwner.get(claim.owner) ?? new Map<AgentTeamThreadRef, AgentTeamClaim[]>()
      byOwner.set(claim.owner, byThread)
      byThread.set(claim.threadRef, [...(byThread.get(claim.threadRef) ?? []), claim])
    }
    const expectedActivities = [...byOwner.keys()].sort().flatMap(owner =>
      [...byOwner.get(owner)!.entries()].map(([threadRef, claims]) => ({
        kind: 'claims_released' as const, taskRef: claims[0]!.taskRef, threadRef, actor: owner, sequence,
        claimRefs: claims.map(claim => claim.claimRef).sort(),
      })))
    if (data.activities.length !== expectedActivities.length || data.activities.some((activity, index) => {
      const expected = expectedActivities[index]
      return expected === undefined || activity.kind !== expected.kind || activity.taskRef !== expected.taskRef
        || activity.threadRef !== expected.threadRef || activity.actor !== expected.actor || activity.sequence !== expected.sequence
        || !this.sameList(activity.claimRefs, expected.claimRefs)
    })) throw new Error('invalid released Claim activities')
    for (const claim of data.claims) {
      const prior = projection.claims.get(claim.claimRef)
      if (prior === undefined) throw new Error('invalid released Claim reference')
    }
    for (const activity of data.activities) this.addRef(refs, activity.activityRef)

    const projectedClaims = new Map(projection.claims)
    for (const claim of releasedClaims) projectedClaims.set(claim.claimRef, claim)
    const expectedTasks = [...new Set(releasedClaims.map(claim => claim.taskRef))].map(taskRef => {
      const task = projection.tasks.get(taskRef)!
      return Object.freeze({ ...task, status: this.deriveResolvedTaskStatus(task, projectedClaims.values()) })
    })
    const expectedThreads = expectedActivities.map(activity => {
      const thread = projection.threads.get(activity.threadRef)!
      return Object.freeze({ ...thread, revision: sequence })
    })
    if (!isDeepStrictEqual(data.tasks, expectedTasks) || !isDeepStrictEqual(data.threads, expectedThreads)) {
      throw new Error('invalid released Claim Task or Thread projection')
    }

    const expectedAttention = [...projection.attention.values()]
      .filter(attention => (memberId === undefined || attention.memberId === memberId) && threadRefs.has(attention.threadRef))
      .map(attention => ({ memberId: attention.memberId, threadRef: attention.threadRef }))
    const expectedMarkers = [...projection.directMarkers.values()]
      .filter(marker => (memberId === undefined || marker.memberId === memberId) && threadRefs.has(marker.threadRef))
    const expectedActivityMarkers = [...projection.activityMarkers.values()]
      .filter(marker => (memberId === undefined || marker.memberId === memberId) && threadRefs.has(marker.threadRef))
    const expectedInbox = this.inboxDelta([], expectedAttention, [], expectedMarkers, [], expectedActivityMarkers, [], this.mainMarkersToClear(projection, memberId, projectRefs))
    if (!isDeepStrictEqual(data.inbox, expectedInbox)) {
      throw new Error(memberId === undefined ? 'invalid Project archival inbox cleanup' : 'invalid Member inbox cleanup')
    }
    this.validateInboxDelta(data.inbox, projection, refs)
  }

  private validateMessageInbox(operation: AgentTeamMessageSentOperation | AgentTeamThreadRepliedOperation, projection: Projection): void {
    const { message, mentions } = operation.data
    const mentionedAgents = mentions.filter(memberId => projection.members.has(memberId))
    const v2 = projection.rulesVersion >= 2
    // Top-level mentions are open to every actor; only a Member reply may not
    // pull an unfollowed Member into an existing Thread. Version 2 has no such invitation rule.
    if (!v2 && operation.actor.kind === 'member' && operation.kind === 'team/thread-replied'
      && mentionedAgents.some(memberId => !this.everParticipatedFrom(projection, message.threadRef, memberId))) {
      throw new Error('invalid Agent mention projection')
    }
    if (v2 && message.replyToMessageRef !== undefined) {
      const parent = projection.messagesByRef.get(message.replyToMessageRef)
      if (parent === undefined || parent.threadRef !== message.threadRef
        || (parent.sender !== message.sender && !mentions.includes(parent.sender))) throw new Error('invalid Message reply target')
    }
    const started = v2 ? []
      : operation.kind === 'team/message-sent'
        ? [this.startAttention(message.sender, message.threadRef, message.sequence),
          ...mentionedAgents.map(memberId => this.startAttention(memberId, message.threadRef, message.sequence))]
        : mentionedAgents.filter(memberId => !this.isFollowingFrom(projection, message.threadRef, memberId))
          .map(memberId => this.startAttention(memberId, message.threadRef, message.sequence))
    const markers = mentions.map(memberId => Object.freeze({ memberId, threadRef: message.threadRef,
      messageRef: message.messageRef, sequence: message.sequence }))
    const expected = this.inboxDelta(started, [], markers)
    if (!isDeepStrictEqual(operation.data.inbox, expected)) throw new Error('invalid Message inbox projection')
  }

  private validateMentions(
    mentions: readonly AgentTeamMemberId[],
    message: Pick<AgentTeamMessage, 'sender' | 'projectRef'>,
    projection: Projection,
  ): void {
    if (mentions.includes(message.sender) || !this.sameList(mentions, [...new Set(mentions)].sort())) throw new Error('invalid Message mentions')
    for (const memberId of mentions) if (!this.validMentionTarget(projection, message.projectRef, memberId)) throw new Error('invalid Message mention target')
  }

  private validMentionTarget(projection: Projection, projectRef: AgentTeamProjectRef, memberId: AgentTeamMemberId): boolean {
    if (memberId === AGENT_TEAM_HUMAN_MEMBER_ID) return true
    const member = projection.members.get(memberId)
    const projectWorkspaceId = projection.projects.get(projectRef)?.workspaceId
    return member !== undefined && member.state !== 'inactive' && member.state !== 'archived'
      && projectWorkspaceId !== undefined && this.participatesInFrom(projection, memberId, projectWorkspaceId)
  }

  /**
   * Apply one committed operation to the live projection, then advance the
   * version shared-projection consumers compare against — but only when the
   * operation invalidated a scope somebody could refetch. Private read progress
   * and audit-only records (`changeScopesOf` derives no scope for them) leave it
   * where it was, so one Member's Thread read cannot make a parked Client
   * believe that something it watches changed.
   */
  private applyAndAdvanceProjectionVersion(operation: AgentTeamOperation): void {
    this.applyTo(this.state, operation)
    const scopes = this.changeScopesOf(operation)
    if (scopes === undefined || scopes.length !== 0) this.projectionVersion = operation.sequence
  }

  private applyTo(target: Projection, operation: AgentTeamOperation): void {
    target.ordered.push(operation)
    target.occurredAtBySequence.set(operation.sequence, operation.occurredAt)
    target.byRequest.set(operation.requestId, operation)
    target.byOperation.set(operation.operationId, operation)
    if (operation.kind === 'team/initialized') return
    if (isAuditOnlyOperation(operation)) return
    if (operation.kind === 'team/project-created') {
      target.projects.set(operation.data.project.projectRef, operation.data.project)
      target.memberships.set(operation.data.project.projectRef, new Set(operation.data.memberIds))
      return
    }
    if (operation.kind === 'team/member-added') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      // Creation seeds the first Workspace participation; member.workspaceId
      // stays the default Workspace the Session roots in, immutable after add.
      target.participations.set(operation.data.member.memberId, new Set([operation.data.member.workspaceId]))
      for (const projectRef of operation.data.projectRefs) this.addMembership(target, projectRef, operation.data.member.memberId)
      return
    }
    if (operation.kind === 'team/member-suspended' || operation.kind === 'team/member-resumed') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      return
    }
    if (operation.kind === 'team/member-session-renewed') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      target.sessionTransitions.set(operation.data.member.memberId, { previousSessionId: operation.data.previousSessionId })
      return
    }
    if (operation.kind === 'team/rules-version-adopted') {
      target.rulesVersion = operation.data.version
      if (operation.data.version >= 2 && target.humanOwnerFloor === 0) target.humanOwnerFloor = operation.sequence
      return
    }
    if (operation.kind === 'team/project-owner-added') {
      const owners = target.owners.get(operation.data.projectRef) ?? new Map<AgentTeamMemberId, number>()
      owners.set(operation.data.memberId, operation.sequence)
      target.owners.set(operation.data.projectRef, owners)
      this.recordNamed(target, operation.data.projectRef, [operation.data.memberId])
      this.appendMainActivity(target, operation.data.activity)
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/project-owner-removed') {
      target.owners.get(operation.data.projectRef)?.delete(operation.data.memberId)
      target.mainWatermarks.delete(mainWatermarkKey(operation.data.memberId, operation.data.projectRef))
      // A removed owner was named in this Project's Main stream, so it stays a member.
      this.recordNamed(target, operation.data.projectRef, [operation.data.memberId])
      this.appendMainActivity(target, operation.data.activity)
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/member-session-recycled') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      target.sessionTransitions.set(operation.data.member.memberId, {
        previousSessionId: operation.data.previousSessionId,
        ...(operation.data.inputFromSeq === undefined ? {} : { inputFromSeq: operation.data.inputFromSeq }),
      })
      return
    }
    if (operation.kind === 'team/member-session-rolled-over') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      target.sessionTransitions.set(operation.data.member.memberId, { previousSessionId: operation.data.previousSessionId })
      return
    }
    if (operation.kind === 'team/project-updated') {
      target.projects.set(operation.data.project.projectRef, operation.data.project)
      return
    }
    if (operation.kind === 'team/member-updated') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      return
    }
    if (operation.kind === 'team/project-member-added') {
      this.addMembership(target, operation.data.projectRef, operation.data.memberId)
      return
    }
    if (operation.kind === 'team/project-member-removed') {
      target.memberships.get(operation.data.projectRef)?.delete(operation.data.memberId)
      this.applyReleaseSnapshot(target, operation, operation.data, operation.occurredAt)
      return
    }
    if (operation.kind === 'team/member-workspace-joined') {
      const workspaces = target.participations.get(operation.data.memberId) ?? new Set<WorkspaceId>()
      workspaces.add(operation.data.workspaceId)
      target.participations.set(operation.data.memberId, workspaces)
      return
    }
    if (operation.kind === 'team/member-workspace-left') {
      target.participations.get(operation.data.memberId)?.delete(operation.data.workspaceId)
      // Departure ends Project memberships inside the left Workspace — unlike
      // archival, which keeps them hidden for a possible restore.
      for (const project of target.projects.values()) {
        if (project.workspaceId !== operation.data.workspaceId) continue
        target.memberships.get(project.projectRef)?.delete(operation.data.memberId)
        target.owners.get(project.projectRef)?.delete(operation.data.memberId)
        target.mainWatermarks.delete(mainWatermarkKey(operation.data.memberId, project.projectRef))
      }
      this.applyReleaseSnapshot(target, operation, operation.data, operation.occurredAt)
      return
    }
    if (operation.kind === 'team/project-archived') {
      // Archival keeps Memberships: hidden state, not departure — a future
      // restore returns every Member to the Project. Visibility filters by
      // project state instead.
      target.projects.set(operation.data.project.projectRef, operation.data.project)
      this.applyReleaseSnapshot(target, operation, operation.data, operation.occurredAt)
      return
    }
    if (operation.kind === 'team/member-removed') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      for (const membership of target.memberships.values()) membership.delete(operation.data.member.memberId)
      for (const owners of target.owners.values()) owners.delete(operation.data.member.memberId)
      this.dropMainWatermarks(target, operation.data.member.memberId)
      this.applyReleaseSnapshot(target, operation, operation.data, operation.occurredAt)
      return
    }
    if (operation.kind === 'team/member-archived') {
      // Archival keeps Memberships: hidden state, not departure — a future
      // restore returns the Member to its Projects. Visibility filters by
      // member state instead. Ownership is a responsibility, not membership: it ends here.
      target.members.set(operation.data.member.memberId, operation.data.member)
      for (const owners of target.owners.values()) owners.delete(operation.data.member.memberId)
      this.dropMainWatermarks(target, operation.data.member.memberId)
      this.applyReleaseSnapshot(target, operation, operation.data, operation.occurredAt)
      return
    }
    if (operation.kind === 'team/thread-promoted') {
      this.appendActivityFact(target, operation.data.activity, operation.occurredAt)
      target.tasks.set(operation.data.task.taskRef, operation.data.task)
      target.threads.set(operation.data.thread.threadRef, operation.data.thread)
      this.recordTaskNumber(target, operation.data.task)
      this.recordAttentionObservations(target, operation, operation.data.inbox)
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/message-sent' || operation.kind === 'team/thread-replied') {
      const { message, mentions } = operation.data
      this.recordMentions(target, message.messageRef, message.projectRef, mentions)
      this.appendMessageFact(target, message, mentions, message.occurredAt ?? operation.occurredAt)
      if (operation.data.task !== undefined) target.tasks.set(operation.data.task.taskRef, operation.data.task)
      target.threads.set(operation.data.thread.threadRef, operation.data.thread)
      if (message.topLevel) {
        target.projectRefByThread.set(message.threadRef, message.projectRef)
        // The anchor is the Thread's first topLevel Message; a later topLevel
        // Message must not displace it.
        if (!target.anchorByThread.has(message.threadRef)) target.anchorByThread.set(message.threadRef, message)
      }
      // Only message-sent mints a Task ordinal; thread-replied may echo the
      // Task without renumbering it.
      if (operation.kind === 'team/message-sent' && operation.data.task !== undefined) this.recordTaskNumber(target, operation.data.task)
      if (operation.kind === 'team/message-sent') this.appendMainSource(target, message.projectRef, { kind: 'thread', sequence: message.sequence, threadRef: message.threadRef, unreadable: false })
      this.recordAttentionObservations(target, operation, operation.data.inbox)
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/thread-started') {
      const { anchor, mentions, task, thread } = operation.data
      this.recordMentions(target, anchor.messageRef, anchor.projectRef, mentions)
      this.appendMessageFact(target, anchor, mentions, anchor.occurredAt ?? operation.occurredAt)
      if (task !== undefined) {
        target.tasks.set(task.taskRef, task)
        this.recordTaskNumber(target, task)
      }
      target.threads.set(thread.threadRef, thread)
      target.projectRefByThread.set(anchor.threadRef, anchor.projectRef)
      target.anchorByThread.set(anchor.threadRef, anchor)
      this.appendMainSource(target, anchor.projectRef, { kind: 'thread', sequence: anchor.sequence, threadRef: anchor.threadRef, unreadable: operation.data.kind === 'discussion' })
      this.recordAttentionObservations(target, operation, operation.data.inbox)
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/main-message-posted') {
      const { message, mentions } = operation.data
      this.recordMentions(target, message.messageRef, message.projectRef, mentions)
      this.appendMainSource(target, message.projectRef, { kind: 'message', sequence: message.sequence, message })
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/main-stream-read') {
      const { memberId, projectRef, readThroughSequence } = operation.data
      const key = mainWatermarkKey(memberId, projectRef)
      if (this.isProjectOwnerFrom(target, projectRef, memberId)) target.mainWatermarks.set(key, Math.max(target.mainWatermarks.get(key) ?? 0, readThroughSequence))
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/claim-created' || operation.kind === 'team/claim-done' || operation.kind === 'team/claim-released') {
      this.upsertClaimKeepingPosition(target, operation.data.claim)
      this.appendActivityFact(target, operation.data.activity, operation.occurredAt)
      target.tasks.set(operation.data.task.taskRef, operation.data.task)
      target.threads.set(operation.data.thread.threadRef, operation.data.thread)
      this.recordAttentionObservations(target, operation, operation.data.inbox)
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/task-changed') {
      for (const claim of operation.data.claims) this.upsertClaimKeepingPosition(target, claim)
      this.appendActivityFact(target, operation.data.activity, operation.occurredAt)
      target.tasks.set(operation.data.task.taskRef, operation.data.task)
      target.threads.set(operation.data.thread.threadRef, operation.data.thread)
      this.recordAttentionObservations(target, operation, operation.data.inbox)
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/thread-attention-changed' || operation.kind === 'team/thread-read') {
      this.recordAttentionObservations(target, operation, operation.data.inbox)
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    assertUnhandledKind(operation)
  }

  /**
   * Replay the departure snapshot a releasing operation carries. The listed
   * order is replay semantics: an Activity references a Claim, and the inbox
   * delta reads the Tasks and Threads. Each caller still applies its own
   * identifying writes (member, membership, project) around this call.
   */
  private applyReleaseSnapshot(
    target: Projection,
    operation: AgentTeamOperation,
    data: AgentTeamReleaseSnapshot,
    occurredAt: string,
  ): void {
    this.applyReleasedClaims(target, data.claims)
    this.applyReleasedActivities(target, data.activities, occurredAt)
    this.applyReleasedTargets(target, data.tasks, data.threads)
    this.applyReleasedInbox(target, operation, data.inbox)
  }

  private applyReleasedClaims(target: Projection, claims: readonly AgentTeamClaim[]): void {
    for (const claim of claims) this.upsertClaimKeepingPosition(target, claim)
  }

  private applyReleasedActivities(target: Projection, activities: readonly AgentTeamClaimsReleasedActivity[], occurredAt: string): void {
    for (const activity of activities) this.appendActivityFact(target, activity, occurredAt)
  }

  private applyReleasedTargets(target: Projection, tasks: readonly AgentTeamTask[], threads: readonly AgentTeamThread[]): void {
    for (const task of tasks) target.tasks.set(task.taskRef, task)
    for (const thread of threads) target.threads.set(thread.threadRef, thread)
  }

  private applyReleasedInbox(target: Projection, operation: AgentTeamOperation, inbox: AgentTeamInboxDelta): void {
    this.recordAttentionObservations(target, operation, inbox)
    this.applyInboxDelta(target, inbox)
  }

  /** Facts arrive in ledger sequence order, so global and per-thread lists stay sorted by append only. */
  private appendMessageFact(
    target: Pick<Projection, 'orderedFacts' | 'factsByThread' | 'messageCountByThread' | 'messagesByRef' | 'threadsByWriter'>,
    message: AgentTeamMessage,
    mentions: readonly AgentTeamMemberId[],
    occurredAt: string,
  ): void {
    const fact: AgentTeamThreadFact = Object.freeze({ kind: 'message', sequence: message.sequence, message, mentions, occurredAt })
    target.orderedFacts.push(fact)
    const facts = target.factsByThread.get(message.threadRef) ?? []
    facts.push(fact)
    target.factsByThread.set(message.threadRef, facts)
    target.messageCountByThread.set(message.threadRef, (target.messageCountByThread.get(message.threadRef) ?? 0) + 1)
    // The ref index is written in this same step, so it is exactly the set of
    // replayed Messages: a validator lookup can never reach a later record.
    target.messagesByRef.set(message.messageRef, message)
    // Participation is indexed per writer as the fact lands, so the Human
    // recent slice asks who wrote where without scanning the whole ledger.
    const written = target.threadsByWriter.get(message.sender) ?? new Set<AgentTeamThreadRef>()
    written.add(message.threadRef)
    target.threadsByWriter.set(message.sender, written)
  }

  private appendActivityFact(target: Pick<Projection, 'orderedFacts' | 'factsByThread'>, activity: AgentTeamActivity, occurredAt: string): void {
    const fact: AgentTeamThreadFact = Object.freeze({ kind: 'activity', sequence: activity.sequence, activity, occurredAt })
    target.orderedFacts.push(fact)
    const facts = target.factsByThread.get(activity.threadRef) ?? []
    facts.push(fact)
    target.factsByThread.set(activity.threadRef, facts)
  }

  /** Display ordinals are a per-Project creation counter; the workspace filter happens at read time. */
  private recordTaskNumber(target: Projection, task: AgentTeamTask): void {
    const ordinal = (target.taskCountByProject.get(task.projectRef) ?? 0) + 1
    target.taskCountByProject.set(task.projectRef, ordinal)
    target.taskNumberByTask.set(task.taskRef, ordinal)
  }

  /** One shared bucket for a Task's Claims, created on first write. */
  private claimBucketFor(target: Projection, taskRef: AgentTeamTaskRef): AgentTeamClaim[] {
    const bucket = target.claimsByTask.get(taskRef)
    if (bucket !== undefined) return bucket
    const created: AgentTeamClaim[] = []
    target.claimsByTask.set(taskRef, created)
    return created
  }

  /**
   * Write one Claim into the projection and its Task bucket, keeping the
   * position a Claim already holds: read projections paginate by bucket order,
   * so an update must not move its Claim to the end.
   */
  private upsertClaimKeepingPosition(target: Projection, claim: AgentTeamClaim): void {
    target.claims.set(claim.claimRef, claim)
    const bucket = this.claimBucketFor(target, claim.taskRef)
    const known = bucket.findIndex(entry => entry.claimRef === claim.claimRef)
    if (known === -1) bucket.push(claim); else bucket[known] = claim
  }

  /**
   * Replay-order Attention observations, appended from committed Inbox deltas
   * only (the hypothetical read projection applies its delta directly).
   *
   * Removals are evaluated before sets, exactly like the scan's loop order. A
   * removal records only when Attention existed, and a set records unless it is
   * the Thread-creating Message (initial Attention) or merely advances the same
   * follow's watermark.
   */
  private recordAttentionObservations(target: Projection, operation: AgentTeamOperation, delta: AgentTeamInboxDelta): void {
    if (delta.attention.removed.length === 0 && delta.attention.set.length === 0) return
    const retired = this.recordUnfollowObservations(target, operation, delta.attention.removed)
    this.recordFollowObservations(target, operation, delta.attention.set, retired)
  }

  /** Append one `unfollow` per removal that had Attention to end; returns the keys that ended. */
  private recordUnfollowObservations(
    target: Projection,
    operation: AgentTeamOperation,
    removed: AgentTeamInboxDelta['attention']['removed'],
  ): ReadonlySet<string> {
    const retired = new Set<string>()
    for (const key of removed) {
      retired.add(this.attentionKey(key.memberId, key.threadRef))
      if (!target.attention.has(this.attentionKey(key.memberId, key.threadRef))) continue
      this.appendObservation(target, key.threadRef, { sequence: operation.sequence, memberId: key.memberId, action: 'unfollow' })
    }
    return retired
  }

  /** Append one `follow` for each set that starts a new Attention rather than restating an existing one. */
  private recordFollowObservations(
    target: Projection,
    operation: AgentTeamOperation,
    set: AgentTeamInboxDelta['attention']['set'],
    retired: ReadonlySet<string>,
  ): void {
    for (const next of set) {
      const prior = retired.has(this.attentionKey(next.memberId, next.threadRef)) ? undefined : target.attention.get(this.attentionKey(next.memberId, next.threadRef))
      if (operation.kind === 'team/message-sent' || operation.kind === 'team/thread-started' || (prior !== undefined && prior.startSequence === next.startSequence)) continue
      this.appendObservation(target, next.threadRef, { sequence: operation.sequence, memberId: next.memberId, action: 'follow' })
    }
  }

  private appendObservation(target: Projection, threadRef: AgentTeamThreadRef, observation: AgentTeamAttentionObservation): void {
    const observations = target.observationsByThread.get(threadRef) ?? []
    observations.push(Object.freeze(observation))
    target.observationsByThread.set(threadRef, observations)
  }

  private applyInboxDelta(target: Projection, delta: AgentTeamInboxDelta): void {
    for (const key of delta.attention.removed) {
      target.attention.delete(this.attentionKey(key.memberId, key.threadRef))
      const followers = target.attentionByThread.get(key.threadRef)
      if (followers !== undefined) {
        followers.delete(key.memberId)
        if (followers.size === 0) target.attentionByThread.delete(key.threadRef)
      }
      const threads = target.attentionThreadsByMember.get(key.memberId)
      if (threads !== undefined) {
        threads.delete(key.threadRef)
        if (threads.size === 0) target.attentionThreadsByMember.delete(key.memberId)
      }
    }
    for (const attention of delta.attention.set) {
      target.attention.set(this.attentionKey(attention.memberId, attention.threadRef), attention)
      const followers = target.attentionByThread.get(attention.threadRef) ?? new Set<AgentTeamMemberId>()
      followers.add(attention.memberId)
      target.attentionByThread.set(attention.threadRef, followers)
      const threads = target.attentionThreadsByMember.get(attention.memberId) ?? new Set<AgentTeamThreadRef>()
      threads.add(attention.threadRef)
      target.attentionThreadsByMember.set(attention.memberId, threads)
    }
    for (const marker of delta.directMarkers.removed) {
      target.directMarkers.delete(this.directMarkerKey(marker))
      this.removeBucketedMarker(target.directMarkersByMember, marker.memberId, marker.threadRef, this.directMarkerKey(marker), candidate => this.directMarkerKey(candidate))
    }
    for (const marker of delta.directMarkers.added) {
      target.directMarkers.set(this.directMarkerKey(marker), marker)
      this.insertBucketedMarker(target.directMarkersByMember, marker.memberId, marker.threadRef, marker)
    }
    for (const marker of delta.activityMarkers.removed) {
      target.activityMarkers.delete(this.activityMarkerKey(marker))
      this.removeBucketedMarker(target.activityMarkersByMember, marker.memberId, marker.threadRef, this.activityMarkerKey(marker), candidate => this.activityMarkerKey(candidate))
    }
    for (const marker of delta.activityMarkers.added) {
      target.activityMarkers.set(this.activityMarkerKey(marker), marker)
      this.insertBucketedMarker(target.activityMarkersByMember, marker.memberId, marker.threadRef, marker)
    }
    for (const marker of delta.mainMarkers?.removed ?? []) {
      target.mainMarkers.delete(mainMarkerKey(marker))
      this.removeBucketedMarker(target.mainMarkersByMember, marker.memberId, marker.projectRef, mainMarkerKey(marker), candidate => mainMarkerKey(candidate))
    }
    for (const marker of delta.mainMarkers?.added ?? []) {
      target.mainMarkers.set(mainMarkerKey(marker), marker)
      this.insertBucketedMarker(target.mainMarkersByMember, marker.memberId, marker.projectRef, marker)
    }
  }

  /** Structured mentions per Message, and the Project-wide set that feeds rules-version-2 membership. */
  private recordMentions(target: Projection, messageRef: AgentTeamMessageRef, projectRef: AgentTeamProjectRef, mentions: readonly AgentTeamMemberId[]): void {
    target.mentionsByMessage.set(messageRef, Object.freeze([...mentions]))
    this.recordNamed(target, projectRef, mentions)
  }

  private recordNamed(target: Projection, projectRef: AgentTeamProjectRef, memberIds: readonly AgentTeamMemberId[]): void {
    if (memberIds.length === 0) return
    const named = target.mentionedByProject.get(projectRef) ?? new Set<AgentTeamMemberId>()
    for (const memberId of memberIds) named.add(memberId)
    target.mentionedByProject.set(projectRef, named)
  }

  private appendMainSource(target: Projection, projectRef: AgentTeamProjectRef, source: MainSource): void {
    const sources = target.mainSourcesByProject.get(projectRef) ?? []
    sources.push(source)
    target.mainSourcesByProject.set(projectRef, sources)
    if (source.kind === 'message') target.mainSourceByRef.set(source.message.messageRef, source)
    if (source.kind === 'activity') target.mainSourceByRef.set(source.activity.activityRef, source)
  }

  private appendMainActivity(target: Projection, activity: AgentTeamMainActivity): void {
    this.appendMainSource(target, activity.projectRef, { kind: 'activity', sequence: activity.sequence, activity })
  }

  private dropMainWatermarks(target: Projection, memberId: AgentTeamMemberId): void {
    for (const key of target.mainWatermarks.keys()) if (key.startsWith(`${memberId}|`)) target.mainWatermarks.delete(key)
  }

  /** Insert into the Member's Thread bucket keeping the sequence order the read path must see. */
  private insertBucketedMarker<K extends string, M extends { readonly sequence: number }>(
    index: Map<AgentTeamMemberId, Map<K, M[]>>,
    memberId: AgentTeamMemberId,
    threadRef: K,
    marker: M,
  ): void {
    const threads = index.get(memberId) ?? new Map<K, M[]>()
    index.set(memberId, threads)
    const bucket = threads.get(threadRef) ?? []
    threads.set(threadRef, bucket)
    let position = bucket.length
    while (position > 0 && bucket[position - 1]!.sequence > marker.sequence) position -= 1
    bucket.splice(position, 0, marker)
  }

  private removeBucketedMarker<K extends string, M>(
    index: Map<AgentTeamMemberId, Map<K, M[]>>,
    memberId: AgentTeamMemberId,
    threadRef: K,
    key: string,
    identityOf: (marker: M) => string,
  ): void {
    const threads = index.get(memberId)
    const bucket = threads?.get(threadRef)
    if (bucket === undefined) return
    const position = bucket.findIndex(item => identityOf(item) === key)
    if (position >= 0) bucket.splice(position, 1)
    if (bucket.length === 0) {
      threads!.delete(threadRef)
      if (threads!.size === 0) index.delete(memberId)
    }
  }

  private prepareRead(memberId: AgentTeamMemberId, workspaceId: WorkspaceId, request: { threadRef?: AgentTeamThreadRef | undefined; taskRef?: AgentTeamTaskRef | undefined }): PreparedRead {
    return this.prepareReadFrom(this.state, memberId, workspaceId, request)
  }

  /**
   * Derive the durable receipt of one Thread read from a prior projection: the
   * Thread it targeted, the watermark it reaches, the Attention row it writes
   * and the Inbox delta it consumes. This is the whole durable content of a
   * receipt-shaped read and the only thing `validateRecords` re-derives for
   * one; the picture derivation below builds on the same result, so the two can
   * never drift.
   */
  private prepareReadReceiptFrom(projection: Projection, memberId: AgentTeamMemberId, workspaceId: WorkspaceId, request: { threadRef?: AgentTeamThreadRef | undefined; taskRef?: AgentTeamTaskRef | undefined }): PreparedReadReceipt {
    const { task, thread, projectRef } = this.threadContextFrom(projection, workspaceId, request)
    if (memberId !== AGENT_TEAM_HUMAN_MEMBER_ID) {
      const member = projection.members.get(memberId)
      if (member === undefined || !this.participatesInProjectWorkspaceFrom(projection, projectRef, member.memberId)) {
        throw new Error(`Agent Member '${memberId}' is not authorized for Project '${projectRef}'`)
      }
    }
    const attention = this.attentionForFrom(projection, memberId, thread.threadRef)
    const unread = this.unreadForFrom(projection, memberId, thread.threadRef)
    const unreadFacts = unread.slice(0, 20)
    // Direct markers are sparse acknowledgements, not part of the contiguous
    // follower watermark. Consuming an old marker after a later follow must
    // never move that watermark backwards.
    const ordinaryUnread = unreadFacts.filter(item => item.fact.sequence >= (attention?.startSequence ?? Number.MAX_SAFE_INTEGER)
      && this.visibleToFollower(item.fact, memberId))
    const readThroughSequence = Math.max(attention?.readThroughSequence ?? 0, ordinaryUnread.at(-1)?.fact.sequence ?? 0)
    const nextAttention = attention === undefined || readThroughSequence === attention.readThroughSequence ? []
      : [Object.freeze({ ...attention, readThroughSequence })]
    const consumedDirectMarkers = new Set(unreadFacts.flatMap(item => item.direct && item.fact.kind === 'message'
      ? [this.directMarkerKey({ memberId, threadRef: thread.threadRef, messageRef: item.fact.message.messageRef })] : []))
    const consumed = this.frozenMarkerSnapshot(projection, memberId, thread.threadRef)
      .filter(marker => consumedDirectMarkers.has(this.directMarkerKey(marker)))
    const activityMarkers = this.activityMarkersForFrom(projection, memberId, thread.threadRef)
      .filter(marker => unreadFacts.some(item => item.fact.kind === 'activity' && item.fact.activity.activityRef === marker.activityRef))
    const inbox = this.inboxDelta(nextAttention, [], [], consumed, [], activityMarkers)
    return Object.freeze({ ...(task === undefined ? {} : { task }), thread, unread,
      ...(attention === undefined ? {} : { attentionBefore: attention }), readThroughSequence,
      ...(attention === undefined ? {} : { attention: nextAttention[0] ?? attention }),
      consumedDirectMarkers: Object.freeze(consumed), inbox })
  }

  /** Derive the only legal durable result of one Thread read from a prior projection. */
  private prepareReadFrom(projection: Projection, memberId: AgentTeamMemberId, workspaceId: WorkspaceId, request: { threadRef?: AgentTeamThreadRef | undefined; taskRef?: AgentTeamTaskRef | undefined }): PreparedRead {
    const receipt = this.prepareReadReceiptFrom(projection, memberId, workspaceId, request)
    const { task, thread } = receipt
    const anchor = this.threadAnchorFrom(projection, thread.threadRef)
    // The first read of a Thread after following also shows the bounded
    // background that preceded the follow, so a reader sees what they joined.
    const firstRead = receipt.attentionBefore !== undefined && receipt.attentionBefore.readThroughSequence < receipt.attentionBefore.startSequence
    const unreadFactKeys = new Set(receipt.unread.map(item => this.threadFactKey(item.fact)))
    const background = firstRead
      ? this.threadFactsFrom(projection, thread.threadRef)
        .filter((fact): fact is Extract<AgentTeamThreadFact, { kind: 'message' }> => fact.kind === 'message'
          && fact.sequence < receipt.attentionBefore!.startSequence)
        .map(fact => Object.freeze({ kind: 'message' as const, sequence: fact.sequence, message: fact.message,
          mentions: projection.mentionsByMessage.get(fact.message.messageRef) ?? [],
          occurredAt: this.occurredAtForFactFrom(projection, fact.sequence, fact.message.occurredAt) }))
        .filter(fact => !unreadFactKeys.has(this.threadFactKey(fact))).slice(-12)
      : []
    const combined = [...background.map(fact => this.readFactFrom(projection, memberId, fact, false)), ...receipt.unread.slice(0, 20)]
      .sort((left, right) => left.fact.sequence - right.fact.sequence)
    const remainingUnreadCount = this.remainingUnreadAfter(projection, memberId, receipt)
    // What this bounded read leaves behind it: the Thread facts that precede the
    // watermark it reaches, which is where this reader now stands in the Thread
    // and how much of it that position has never shown it. Anchoring on the
    // watermark rather than on the response's own oldest fact is what keeps a
    // returning reader honest — the background window starts at the Thread's
    // first fact whenever the Thread is short enough to fit it, so measuring
    // from the response would report nothing behind a reader that has in fact
    // never read the Thread. Derived from the projection the read resolved
    // against, like every other field of this picture, so a replay re-derives
    // the same number.
    const earlierFactCount = this.threadFactsFrom(projection, thread.threadRef)
      .filter(fact => fact.sequence < receipt.readThroughSequence).length
    return Object.freeze({ ...receipt, claims: task === undefined ? Object.freeze([]) : this.claimsForTaskFrom(projection, task.taskRef), anchor,
      anchorMentions: projection.mentionsByMessage.get(anchor.messageRef) ?? [],
      facts: Object.freeze(combined), remainingUnreadCount, earlierFactCount })
  }

  private readFactFrom(projection: Projection, memberId: AgentTeamMemberId, fact: AgentTeamThreadFact, unread: boolean): AgentTeamThreadReadFact {
    return Object.freeze({ fact, unread, direct: fact.kind === 'message'
      && projection.directMarkers.has(this.directMarkerKey({ memberId, threadRef: fact.message.threadRef,
        messageRef: fact.message.messageRef, sequence: fact.sequence })) })
  }

  private unreadFor(memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): readonly AgentTeamThreadReadFact[] {
    return this.unreadForFrom(this.state, memberId, threadRef)
  }

  private unreadForFrom(projection: Projection, memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): readonly AgentTeamThreadReadFact[] {
    const attention = this.attentionForFrom(projection, memberId, threadRef)
    const directKeys = new Set(this.frozenMarkerSnapshot(projection, memberId, threadRef).map(marker => this.directMarkerKey(marker)))
    const activityKeys = new Set(this.activityMarkersForFrom(projection, memberId, threadRef).map(marker => this.activityMarkerKey(marker)))
    const result: AgentTeamThreadReadFact[] = []
    for (const fact of this.threadFactsFrom(projection, threadRef)) {
      if (this.isUnreadFact(fact, memberId, threadRef, attention, directKeys, activityKeys)) {
        result.push(this.readFactFrom(projection, memberId, fact, true))
      }
    }
    return Object.freeze(result)
  }

  /**
   * The single authority on "this fact is unread for this reader". The picture
   * derivation and the remaining-count derivation both go through it, so the
   * count a read reports can never disagree with the facts it lists. Marker
   * membership arrives as key sets: the caller may be looking at a state the
   * projection has not applied yet.
   */
  private isUnreadFact(
    fact: AgentTeamThreadFact,
    memberId: AgentTeamMemberId,
    threadRef: AgentTeamThreadRef,
    attention: AgentTeamThreadAttention | undefined,
    directKeys: ReadonlySet<string>,
    activityKeys: ReadonlySet<string>,
  ): boolean {
    const marker = fact.kind === 'message' && directKeys.has(this.directMarkerKey({ memberId, threadRef,
      messageRef: fact.message.messageRef, sequence: fact.sequence }))
    const activityMarker = fact.kind === 'activity' && activityKeys.has(this.activityMarkerKey({ memberId, threadRef,
      activityRef: fact.activity.activityRef, sequence: fact.sequence }))
    const ordinary = attention !== undefined && fact.sequence >= attention.startSequence
      && fact.sequence > attention.readThroughSequence && this.visibleToFollower(fact, memberId)
    return marker || activityMarker || ordinary
  }

  /**
   * Unread count once this read's own Inbox delta has been applied, derived
   * without materializing a hypothetical projection. The delta can only touch
   * the reader's own Attention row and its own marker keys in one Thread, and
   * every lookup in `isUnreadFact` is scoped to that same (member, Thread)
   * pair, so the post-delta state is the Attention row the receipt already
   * derived plus those marker keys with the delta's own removals and additions
   * applied.
   */
  private remainingUnreadAfter(projection: Projection, memberId: AgentTeamMemberId, receipt: PreparedReadReceipt): number {
    const threadRef = receipt.thread.threadRef
    const directKeys = new Set(this.frozenMarkerSnapshot(projection, memberId, threadRef).map(marker => this.directMarkerKey(marker)))
    for (const marker of receipt.inbox.directMarkers.removed) directKeys.delete(this.directMarkerKey(marker))
    for (const marker of receipt.inbox.directMarkers.added) directKeys.add(this.directMarkerKey(marker))
    const activityKeys = new Set(this.activityMarkersForFrom(projection, memberId, threadRef).map(marker => this.activityMarkerKey(marker)))
    for (const marker of receipt.inbox.activityMarkers.removed) activityKeys.delete(this.activityMarkerKey(marker))
    for (const marker of receipt.inbox.activityMarkers.added) activityKeys.add(this.activityMarkerKey(marker))
    let count = 0
    for (const fact of this.threadFactsFrom(projection, threadRef)) {
      if (this.isUnreadFact(fact, memberId, threadRef, receipt.attention, directKeys, activityKeys)) count += 1
    }
    return count
  }

  private visibleToFollower(fact: AgentTeamThreadFact, memberId: AgentTeamMemberId): boolean {
    const sender = fact.kind === 'message' ? fact.message.sender : fact.activity.actor
    return sender !== memberId
  }

  private threadFacts(threadRef: AgentTeamThreadRef): readonly AgentTeamThreadFact[] {
    return this.threadFactsFrom(this.state, threadRef)
  }

  private threadFactsFrom(projection: Projection, threadRef: AgentTeamThreadRef): readonly AgentTeamThreadFact[] {
    return projection.factsByThread.get(threadRef) ?? []
  }

  /**
   * Check a receipt against its own independent derivation: the progress it
   * claims and the Inbox delta it consumed, nothing else. The picture and the
   * unread count left behind are projection state a replay re-derives for the
   * surfaces that need them, not content of this record. The Task ref is
   * derived rather than copied back, so a Task Thread read cannot drop the Task
   * it belongs to and shrink its own claim unchecked.
   */
  private validateThreadReadReceipt(
    data: Extract<AgentTeamThreadReadData, { threadRef: AgentTeamThreadRef }>,
    projection: Projection,
    target: { readonly threadRef?: AgentTeamThreadRef | undefined; readonly taskRef?: AgentTeamTaskRef | undefined },
  ): void {
    const expected = this.prepareReadReceiptFrom(projection, data.memberId, data.workspaceId, target)
    const expectedData = Object.freeze({ workspaceId: data.workspaceId, memberId: data.memberId, threadRef: data.threadRef,
      ...(expected.task === undefined ? {} : { taskRef: expected.task.taskRef }),
      readThroughSequence: expected.readThroughSequence, inbox: expected.inbox })
    if (!isDeepStrictEqual(data, expectedData)) throw new Error('invalid Thread read receipt')
  }

  /**
   * Check a pre-receipt snapshot against the same derivation that wrote it. That
   * shape is frozen: a field added to a read afterwards, like the orientation
   * count, is deliberately not compared, because no stored record carries it and
   * expecting one would reject every ledger written before the field existed.
   */
  private validateLegacyThreadReadSnapshot(
    data: AgentTeamThreadReadSnapshot,
    projection: Projection,
    target: { readonly threadRef?: AgentTeamThreadRef | undefined; readonly taskRef?: AgentTeamTaskRef | undefined },
  ): void {
    const expected = this.prepareReadFrom(projection, data.memberId, data.workspaceId, target)
    const expectedData = Object.freeze({ workspaceId: data.workspaceId, memberId: data.memberId,
      ...(expected.task === undefined ? {} : { task: expected.task }), thread: expected.thread, claims: expected.claims, anchor: expected.anchor,
      anchorMentions: expected.anchorMentions, facts: expected.facts,
      readThroughSequence: expected.readThroughSequence, remainingUnreadCount: expected.remainingUnreadCount,
      ...(expected.attention === undefined ? {} : { attention: expected.attention }), inbox: expected.inbox })
    if (!isDeepStrictEqual(data, expectedData)) throw new Error('invalid Thread read projection')
  }

  private occurredAtForFactFrom(projection: Projection, sequence: number, fallback?: string | undefined): string {
    if (fallback !== undefined) return fallback
    return projection.occurredAtBySequence.get(sequence) ?? ''
  }

  private messageInboxDelta(
    message: AgentTeamMessage,
    sender: AgentTeamMemberId,
    mentions: readonly AgentTeamMemberId[],
    attention: readonly AgentTeamThreadAttention[],
  ): AgentTeamInboxDelta {
    const markers = mentions.map(memberId => Object.freeze({ memberId, threadRef: message.threadRef,
      messageRef: message.messageRef, sequence: message.sequence }))
    return this.inboxDelta(attention, [], markers)
  }

  private closeThreadInbox(activity: AgentTeamTaskActivity, threadRef: AgentTeamThreadRef): AgentTeamInboxDelta {
    return this.closeThreadInboxFrom(this.state, activity, threadRef)
  }

  private closeThreadInboxFrom(projection: Projection, activity: AgentTeamTaskActivity, threadRef: AgentTeamThreadRef): AgentTeamInboxDelta {
    const recipients = [...projection.attention.values()]
      .filter(attention => attention.threadRef === threadRef && attention.memberId !== activity.actor)
      .map(attention => attention.memberId)
    const removed = [...projection.attention.values()].filter(attention => attention.threadRef === threadRef)
      .map(attention => Object.freeze({ memberId: attention.memberId, threadRef: attention.threadRef }))
    const activityMarkers = recipients.map(memberId => Object.freeze({ memberId, threadRef,
      activityRef: activity.activityRef, sequence: activity.sequence }))
    return this.inboxDelta([], removed, [], [...projection.directMarkers.values()].filter(marker => marker.threadRef === threadRef),
      activityMarkers, [...projection.activityMarkers.values()].filter(marker => marker.threadRef === threadRef))
  }

  /**
   * Acceptance notifies every done Claim owner, pre-finished (the normal
   * flow) and atomically completed (early acceptance) alike, through activity
   * markers regardless of whether they still follow the Thread. The actor
   * never notifies itself. Legacy records without the acceptance
   * discriminator keep completed-only wake semantics on replay.
   */
  private acceptThreadInbox(activity: AgentTeamTaskActivity, threadRef: AgentTeamThreadRef, acceptedOwners: readonly AgentTeamMemberId[]): AgentTeamInboxDelta {
    if (acceptedOwners.length === 0) return this.inboxDelta()
    const recipients = [...new Set(acceptedOwners)].filter(memberId => memberId !== activity.actor)
    const markers = recipients.map(memberId => Object.freeze({ memberId, threadRef,
      activityRef: activity.activityRef, sequence: activity.sequence }))
    return this.inboxDelta([], [], [], [], markers)
  }

  private acceptThreadInboxFrom(projection: Projection, activity: AgentTeamTaskActivity, threadRef: AgentTeamThreadRef, claimRefs: readonly AgentTeamClaimRef[]): AgentTeamInboxDelta {
    if (claimRefs.length === 0) return this.inboxDelta()
    const owners = claimRefs.map(claimRef => projection.claims.get(claimRef)?.owner).filter(owner => owner !== undefined)
    return this.acceptThreadInbox(activity, threadRef, owners)
  }

  private reopenThreadInbox(activity: AgentTeamTaskActivity, threadRef: AgentTeamThreadRef): AgentTeamInboxDelta {
    return this.reopenThreadInboxFrom(this.state, activity, threadRef)
  }

  private reopenThreadInboxFrom(projection: Projection, activity: AgentTeamTaskActivity, threadRef: AgentTeamThreadRef): AgentTeamInboxDelta {
    const recipients = new Set([...projection.activityMarkers.values()]
      .filter(marker => marker.threadRef === threadRef).map(marker => marker.memberId))
    const markers = [...recipients].map(memberId => Object.freeze({ memberId, threadRef,
      activityRef: activity.activityRef, sequence: activity.sequence }))
    return this.inboxDelta([], [], [], [], markers)
  }

  private promoteThreadInbox(activity: AgentTeamTaskActivity, threadRef: AgentTeamThreadRef): AgentTeamInboxDelta {
    return this.promoteThreadInboxFrom(this.state, activity, threadRef)
  }

  private promoteThreadInboxFrom(projection: Projection, activity: AgentTeamTaskActivity, threadRef: AgentTeamThreadRef): AgentTeamInboxDelta {
    const markers = [...projection.attention.values()]
      .filter(attention => attention.threadRef === threadRef && attention.memberId !== activity.actor)
      .map(attention => Object.freeze({ memberId: attention.memberId, threadRef,
        activityRef: activity.activityRef, sequence: activity.sequence }))
    return this.inboxDelta([], [], [], [], markers)
  }

  /** `projectRefs` scopes the Main stream markers a departure clears; undefined means every Project. */
  private removeMemberThreadInbox(memberId: AgentTeamMemberId, threadRefs: ReadonlySet<AgentTeamThreadRef>, projectRefs?: ReadonlySet<AgentTeamProjectRef>): AgentTeamInboxDelta {
    return this.removeMemberThreadInboxFrom(this.state, memberId, threadRefs, projectRefs)
  }

  private removeMemberThreadInboxFrom(projection: Projection, memberId: AgentTeamMemberId, threadRefs: ReadonlySet<AgentTeamThreadRef>, projectRefs?: ReadonlySet<AgentTeamProjectRef>): AgentTeamInboxDelta {
    const removed = [...projection.attention.values()].filter(attention => attention.memberId === memberId && threadRefs.has(attention.threadRef))
      .map(attention => Object.freeze({ memberId, threadRef: attention.threadRef }))
    const markers = [...projection.directMarkers.values()].filter(marker => marker.memberId === memberId && threadRefs.has(marker.threadRef))
    const activityMarkers = [...projection.activityMarkers.values()].filter(marker => marker.memberId === memberId && threadRefs.has(marker.threadRef))
    return this.inboxDelta([], removed, [], markers, [], activityMarkers, [], this.mainMarkersToClear(projection, memberId, projectRefs))
  }

  /** Live Main stream markers a departure clears, in sequence order so write and replay derive the same list. */
  private mainMarkersToClear(projection: Projection, memberId: AgentTeamMemberId | undefined, projectRefs: ReadonlySet<AgentTeamProjectRef> | undefined): readonly AgentTeamMainMarker[] {
    return [...projection.mainMarkers.values()]
      .filter(marker => (memberId === undefined || marker.memberId === memberId) && (projectRefs === undefined || projectRefs.has(marker.projectRef)))
      .sort((left, right) => left.sequence - right.sequence || mainMarkerKey(left).localeCompare(mainMarkerKey(right)))
  }

  /** Attention and marker cleanup for EVERY Member on the given Threads. */
  private projectArchivalInbox(threadRefs: ReadonlySet<AgentTeamThreadRef>, projectRef: AgentTeamProjectRef): AgentTeamInboxDelta {
    return this.projectArchivalInboxFrom(this.state, threadRefs, projectRef)
  }

  private projectArchivalInboxFrom(projection: Projection, threadRefs: ReadonlySet<AgentTeamThreadRef>, projectRef: AgentTeamProjectRef): AgentTeamInboxDelta {
    const removed = [...projection.attention.values()].filter(attention => threadRefs.has(attention.threadRef))
      .map(attention => Object.freeze({ memberId: attention.memberId, threadRef: attention.threadRef }))
    const markers = [...projection.directMarkers.values()].filter(marker => threadRefs.has(marker.threadRef))
    const activityMarkers = [...projection.activityMarkers.values()].filter(marker => threadRefs.has(marker.threadRef))
    return this.inboxDelta([], removed, [], markers, [], activityMarkers, [], this.mainMarkersToClear(projection, undefined, new Set([projectRef])))
  }

  private inboxDelta(
    set: readonly AgentTeamThreadAttention[] = [],
    removed: readonly AgentTeamThreadAttentionKey[] = [],
    addedMarkers: readonly AgentTeamDirectMarker[] = [],
    removedMarkers: readonly AgentTeamDirectMarker[] = [],
    addedActivityMarkers: readonly AgentTeamActivityMarker[] = [],
    removedActivityMarkers: readonly AgentTeamActivityMarker[] = [],
    addedMainMarkers: readonly AgentTeamMainMarker[] = [],
    removedMainMarkers: readonly AgentTeamMainMarker[] = [],
  ): AgentTeamInboxDelta {
    return Object.freeze({
      attention: Object.freeze({ set: Object.freeze(set), removed: Object.freeze(removed) }),
      directMarkers: Object.freeze({ added: Object.freeze(addedMarkers), removed: Object.freeze(removedMarkers) }),
      activityMarkers: Object.freeze({ added: Object.freeze(addedActivityMarkers), removed: Object.freeze(removedActivityMarkers) }),
      // Absent unless it changes something: a rules-version-1 delta keeps its stored bytes.
      ...(addedMainMarkers.length === 0 && removedMainMarkers.length === 0 ? {}
        : { mainMarkers: Object.freeze({ added: Object.freeze(addedMainMarkers), removed: Object.freeze(removedMainMarkers) }) }),
    })
  }

  private startAttention(memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef, startSequence: number): AgentTeamThreadAttention {
    return Object.freeze({ memberId, threadRef, startSequence, readThroughSequence: Math.max(0, startSequence - 1) })
  }

  private followAttention(memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): AgentTeamThreadAttention {
    return this.followAttentionFrom(this.state, memberId, threadRef)
  }

  private followAttentionFrom(projection: Projection, memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): AgentTeamThreadAttention {
    const tail = this.threadFactsFrom(projection, threadRef).at(-1)?.sequence ?? 1
    return Object.freeze({ memberId, threadRef, startSequence: tail + 1, readThroughSequence: tail })
  }

  private currentTail(threadRef: AgentTeamThreadRef): number {
    return this.threadFacts(threadRef).at(-1)?.sequence ?? 1
  }

  private attentionFor(memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): AgentTeamThreadAttention | undefined {
    return this.attentionForFrom(this.state, memberId, threadRef)
  }

  private attentionForFrom(projection: Projection, memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): AgentTeamThreadAttention | undefined {
    return projection.attention.get(this.attentionKey(memberId, threadRef))
  }

  private isFollowing(threadRef: AgentTeamThreadRef, memberId: AgentTeamMemberId): boolean {
    return this.attentionFor(memberId, threadRef) !== undefined
  }

  private isFollowingFrom(projection: Projection, threadRef: AgentTeamThreadRef, memberId: AgentTeamMemberId): boolean {
    return this.attentionForFrom(projection, memberId, threadRef) !== undefined
  }

  private directMarkersFor(memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): readonly AgentTeamDirectMarker[] {
    return this.frozenMarkerSnapshot(this.state, memberId, threadRef)
  }

  /** One Member's live Inbox markers for one Thread, snapshotted so a caller cannot freeze the live bucket's array. */
  private frozenMarkerSnapshot(projection: Projection, memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): readonly AgentTeamDirectMarker[] {
    const markers = projection.directMarkersByMember.get(memberId)?.get(threadRef)
    return markers === undefined ? [] : Object.freeze([...markers])
  }

  private activityMarkersForFrom(projection: Projection, memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): readonly AgentTeamActivityMarker[] {
    const markers = projection.activityMarkersByMember.get(memberId)?.get(threadRef)
    return markers === undefined ? [] : Object.freeze([...markers])
  }

  private issueConfirmation(
    actor: AgentTeamHumanActor | AgentTeamMemberActor,
    workspaceId: WorkspaceId,
    projectRef: AgentTeamProjectRef,
    body: string,
    recipients: readonly AgentTeamMemberId[],
    task?: AgentTeamTask,
    thread?: AgentTeamThread,
  ): AgentTeamConfirmationRequired {
    if (actor.kind !== 'human') throw new Error('only Human may invite an unfollowed Agent')
    for (const [token, confirmation] of this.confirmations) if (confirmation.actor === actor.memberId) this.confirmations.delete(token)
    const confirmationToken = `confirmation:${randomUUID()}` as AgentTeamConfirmationToken
    this.confirmations.set(confirmationToken, Object.freeze({ actor: actor.memberId, workspaceId, projectRef,
      ...(task === undefined ? {} : { taskRef: task.taskRef }), ...(thread === undefined ? {} : { threadRef: thread.threadRef }),
      body, recipients, attention: recipients.map(memberId => thread !== undefined && this.isFollowing(thread.threadRef, memberId)),
      memberStates: recipients.map(memberId => this.state.members.get(memberId)?.state ?? 'enabled') }))
    return Object.freeze({ kind: 'confirmation_required', confirmationToken, workspaceId, projectRef,
      recipients: Object.freeze(recipients.filter(memberId => this.state.members.has(memberId) && (thread === undefined || !this.isFollowing(thread.threadRef, memberId)))),
      ...(task === undefined ? {} : { taskRef: task.taskRef }), ...(thread === undefined ? {} : { threadRef: thread.threadRef, revision: thread.revision }) })
  }

  private consumeConfirmation(
    token: AgentTeamConfirmationToken,
    actor: AgentTeamHumanActor | AgentTeamMemberActor,
    workspaceId: WorkspaceId,
    projectRef: AgentTeamProjectRef,
    task: AgentTeamTask | undefined,
    thread: AgentTeamThread | undefined,
    body: string,
    recipients: readonly AgentTeamMemberId[],
  ): void {
    const confirmation = this.confirmations.get(token)
    this.confirmations.delete(token)
    const attention = recipients.map(memberId => thread !== undefined && this.isFollowing(thread.threadRef, memberId))
    const states = recipients.map(memberId => this.state.members.get(memberId)?.state ?? 'enabled')
    if (confirmation === undefined || confirmation.actor !== actor.memberId || confirmation.workspaceId !== workspaceId
      || confirmation.projectRef !== projectRef || confirmation.taskRef !== task?.taskRef || confirmation.threadRef !== thread?.threadRef
      || confirmation.body !== body || !this.sameList(confirmation.recipients, recipients)
      || !this.sameList(confirmation.attention, attention) || !this.sameList(confirmation.memberStates, states)) {
      throw new Error('confirmation token is invalid or expired')
    }
  }

  private assertMentionTargets(project: AgentTeamProject, recipients: readonly AgentTeamMemberId[]): void {
    for (const memberId of recipients) {
      if (memberId === AGENT_TEAM_HUMAN_MEMBER_ID) continue
      const member = this.requireMember(memberId)
      if (member.state === 'inactive' || member.state === 'archived' || !this.participatesIn(member.memberId, project.workspaceId)) {
        throw new Error(`Agent Member '${memberId}' is not authorized for Project '${project.projectRef}'`)
      }
    }
  }

  private requireRulesVersion2(what: string): void {
    if (this.state.rulesVersion < 2) throw new Error(`${what} needs rules version 2; this ledger runs version ${this.state.rulesVersion}`)
  }

  private requireProjectMemberActor(actor: AgentTeamHumanActor | AgentTeamMemberActor, projectRef: AgentTeamProjectRef): void {
    if (actor.kind === 'member' && !this.isProjectMember(projectRef, actor.memberId)) {
      throw new Error(`Agent Member '${actor.handle}' is not a member of Project '${projectRef}' (not_project_member) — ${recoveryFor('not_project_member').sentence({ projectRef })}`)
    }
  }

  private requireProjectOwnerActor(actor: AgentTeamHumanActor | AgentTeamMemberActor, projectRef: AgentTeamProjectRef): void {
    if (actor.kind === 'member' && !this.isProjectOwnerFrom(this.state, projectRef, actor.memberId)) {
      throw new Error(`Only a Project owner can do this in Project '${projectRef}' (project_owner_required) — ${recoveryFor('project_owner_required').sentence({ projectRef })}`)
    }
  }

  /** The Human owns every Project; an Agent owns it from its grant until the grant ends. */
  private isProjectOwnerFrom(projection: Projection, projectRef: AgentTeamProjectRef, memberId: AgentTeamMemberId): boolean {
    if (memberId === AGENT_TEAM_HUMAN_MEMBER_ID) return projection.projects.has(projectRef)
    return projection.owners.get(projectRef)?.has(memberId) === true
  }

  /** Sequence from which an owner's ordinary Main stream unread counts; undefined for a non-owner. */
  private ownerSinceFrom(projection: Projection, projectRef: AgentTeamProjectRef, memberId: AgentTeamMemberId): number | undefined {
    if (memberId === AGENT_TEAM_HUMAN_MEMBER_ID) {
      const project = projection.projects.get(projectRef)
      return project === undefined ? undefined : Math.max(project.createdAtSequence, projection.humanOwnerFloor)
    }
    return projection.owners.get(projectRef)?.get(memberId)
  }

  private mainSourcesFrom(projection: Projection, projectRef: AgentTeamProjectRef): readonly MainSource[] {
    return projection.mainSourcesByProject.get(projectRef) ?? []
  }

  private mainHeadFrom(projection: Projection, projectRef: AgentTeamProjectRef): number {
    return this.mainSourcesFrom(projection, projectRef).at(-1)?.sequence ?? 0
  }

  private mainProducerFrom(projection: Projection, source: MainSource): AgentTeamMemberId | undefined {
    if (source.kind === 'message') return source.message.sender
    if (source.kind === 'activity') return source.activity.actor
    return projection.anchorByThread.get(source.threadRef)?.sender
  }

  /**
   * One reader's unread Main stream, oldest first. An owner's ordinary unread is whatever the stream holds after the later
   * of the owner's start and read watermark, minus what the reader produced; task cards and earlier-version Thread anchors
   * are never unread. Markers add to it for owners and are all a non-owner has.
   */
  private mainUnreadFrom(projection: Projection, memberId: AgentTeamMemberId, projectRef: AgentTeamProjectRef): readonly MainUnreadItem[] {
    const found = new Map<number, MainUnreadItem>()
    const since = this.ownerSinceFrom(projection, projectRef, memberId)
    if (since !== undefined) {
      const floor = Math.max(since, projection.mainWatermarks.get(mainWatermarkKey(memberId, projectRef)) ?? 0)
      const sources = this.mainSourcesFrom(projection, projectRef)
      for (let index = sources.length - 1; index >= 0 && sources[index]!.sequence > floor; index -= 1) {
        const source = sources[index]!
        if ((source.kind === 'thread' && !source.unreadable) || this.mainProducerFrom(projection, source) === memberId) continue
        found.set(source.sequence, { source, ordinary: true, direct: false })
      }
    }
    for (const marker of projection.mainMarkersByMember.get(memberId)?.get(projectRef) ?? []) {
      const source = projection.mainSourceByRef.get('messageRef' in marker ? marker.messageRef : marker.activityRef)
      if (source !== undefined) found.set(source.sequence, { source, ordinary: found.get(source.sequence)?.ordinary ?? false, direct: true })
    }
    return Object.freeze([...found.values()].sort((left, right) => left.source.sequence - right.source.sequence))
  }

  private mainStandingFrom(projection: Projection, memberId: AgentTeamMemberId, projectRef: AgentTeamProjectRef): AgentTeamMainStreamStanding {
    const unread = this.mainUnreadFrom(projection, memberId, projectRef)
    return Object.freeze({ owner: this.ownerSinceFrom(projection, projectRef, memberId) !== undefined,
      head: this.mainHeadFrom(projection, projectRef), unreadCount: unread.length,
      directCount: unread.filter(item => item.direct).length,
      markers: Object.freeze([...projection.mainMarkersByMember.get(memberId)?.get(projectRef) ?? []]) })
  }

  /**
   * The only legal durable result of reading through `readThrough`: the markers it consumes, and whether an owner's
   * watermark moves. The watermark itself is replayed from the operation, so the delta carries markers alone.
   */
  private prepareMainReadFrom(projection: Projection, memberId: AgentTeamMemberId, projectRef: AgentTeamProjectRef, readThrough: number): {
    readonly advances: boolean
    readonly consumed: readonly AgentTeamMainMarker[]
    readonly inbox: AgentTeamInboxDelta
  } {
    const unread = this.mainUnreadFrom(projection, memberId, projectRef)
    const since = this.ownerSinceFrom(projection, projectRef, memberId)
    const floor = since === undefined ? readThrough : Math.max(since, projection.mainWatermarks.get(mainWatermarkKey(memberId, projectRef)) ?? 0)
    const advances = readThrough > floor && unread.some(item => item.ordinary && item.source.sequence <= readThrough)
    const consumed = Object.freeze((projection.mainMarkersByMember.get(memberId)?.get(projectRef) ?? []).filter(marker => marker.sequence <= readThrough))
    return Object.freeze({ advances, consumed, inbox: this.inboxDelta([], [], [], [], [], [], [], consumed) })
  }

  /** The newest page through `readThrough` a read answers with, plus any older entry whose marker the read consumes, so no marker is cleared unseen. */
  private mainReadPage(memberId: AgentTeamMemberId, projectRef: AgentTeamProjectRef, consumed: readonly AgentTeamMainMarker[], readThrough: number): readonly AgentTeamMainTimelineEntry[] {
    const sources = this.mainSourcesFrom(this.state, projectRef).filter(source => source.sequence <= readThrough)
    const marked = new Set(consumed.map(marker => this.state.mainSourceByRef.get('messageRef' in marker ? marker.messageRef : marker.activityRef)?.sequence))
    const page = sources.filter((source, index) => index >= sources.length - MAIN_READ_PAGE_SIZE || marked.has(source.sequence))
    return this.mainEntries(page, this.mainUnreadFrom(this.state, memberId, projectRef))
  }

  private mainReadResult(memberId: AgentTeamMemberId, projectRef: AgentTeamProjectRef, readThrough: number,
    consumed: readonly AgentTeamMainMarker[], receipt?: AgentTeamOperationReceipt): AgentTeamMainStreamReadResult {
    return Object.freeze({ ...(receipt === undefined ? {} : { receipt }), projectRef, readThroughSequence: readThrough,
      entries: this.mainReadPage(memberId, projectRef, consumed, readThrough), consumedMarkers: consumed,
      standing: this.mainStandingFrom(this.state, memberId, projectRef) })
  }

  private mainEntries(sources: readonly MainSource[], unread: readonly MainUnreadItem[]): readonly AgentTeamMainTimelineEntry[] {
    const flags = new Map(unread.map(item => [item.source.sequence, item.direct]))
    return Object.freeze(sources.map(source => this.mainEntry(source, flags.has(source.sequence), flags.get(source.sequence) === true)))
  }

  private mainEntry(source: MainSource, unread: boolean, direct: boolean): AgentTeamMainTimelineEntry {
    if (source.kind === 'activity') {
      return Object.freeze({ kind: 'activity', sequence: source.sequence, occurredAt: source.activity.occurredAt, unread, direct, activity: source.activity })
    }
    if (source.kind === 'thread') {
      const card = this.mainThreadCard(source.threadRef)
      return Object.freeze({ kind: 'thread-card', sequence: source.sequence, occurredAt: card.anchor.occurredAt, unread, direct, card })
    }
    const parentRef = source.message.replyToMessageRef
    const parent = parentRef === undefined ? undefined : this.state.mainSourceByRef.get(parentRef)
    const replyTo = parent?.kind === 'message'
      ? Object.freeze({ sender: this.printableSender(parent.message.sender), excerpt: boundedOpeningLine(parent.message.body, ONE_LINE_GIST_MAX_CHARACTERS) })
      : undefined
    return Object.freeze({ kind: 'message', sequence: source.sequence, occurredAt: source.message.occurredAt, unread, direct,
      message: source.message, mentions: this.state.mentionsByMessage.get(source.message.messageRef) ?? [],
      ...(replyTo === undefined ? {} : { replyTo }) })
  }

  /** A card is the current state of its Thread, rebuilt on every read; it keeps no copy of the Thread's progress. */
  private mainThreadCard(threadRef: AgentTeamThreadRef): AgentTeamMainThreadCard {
    const thread = this.state.threads.get(threadRef)!
    const anchor = this.threadAnchor(threadRef)
    const facts = this.threadFacts(threadRef)
    const writers: AgentTeamMemberId[] = []
    let replyCount = 0
    for (const fact of facts) {
      if (fact.kind !== 'message') continue
      if (fact.message.messageRef !== anchor.messageRef) replyCount += 1
      if (!writers.includes(fact.message.sender)) writers.push(fact.message.sender)
    }
    const newest = facts.at(-1)!
    const task = thread.taskRef === undefined ? undefined : this.state.tasks.get(thread.taskRef)
    return Object.freeze({
      threadRef, anchor: Object.freeze({ messageRef: anchor.messageRef, sender: anchor.sender,
        preview: boundedOpeningLine(anchor.body, ONE_LINE_GIST_MAX_CHARACTERS), sequence: anchor.sequence, occurredAt: anchor.occurredAt }),
      ...(task === undefined ? {} : { task: Object.freeze({ taskRef: task.taskRef, taskNumber: this.state.taskNumberByTask.get(task.taskRef) ?? 0,
        status: task.status, resolution: task.resolution, liveClaimOwners: this.liveClaimOwners(task) }) }),
      replyCount, participants: Object.freeze(writers.map(memberId => this.memberActor(memberId))),
      newestSequence: newest.sequence, newestOccurredAt: newest.occurredAt, newestActor: this.inboxActorFor(newest),
    })
  }

  private printableSender(memberId: AgentTeamMemberId): string {
    return memberId === AGENT_TEAM_HUMAN_MEMBER_ID ? AGENT_TEAM_HUMAN_HANDLE : this.state.members.get(memberId)?.handle ?? memberId
  }

  private mainUnreadRequired(projectRef: AgentTeamProjectRef, unread: readonly MainUnreadItem[]): AgentTeamMainUnreadRequired {
    return Object.freeze({ kind: 'main_unread_required', projectRef, unreadCount: unread.length,
      directCount: unread.filter(item => item.direct).length, head: this.mainHeadFrom(this.state, projectRef),
      entries: this.mainEntries(unread.slice(-MAIN_READ_PAGE_SIZE).map(item => item.source), unread) })
  }

  /** The Agent whose ownership changed learns of it through a Main stream marker. */
  private ownerActivityInboxDelta(activity: AgentTeamMainActivity): AgentTeamInboxDelta {
    const marker: AgentTeamMainActivityMarker = Object.freeze({ memberId: activity.memberId, projectRef: activity.projectRef,
      activityRef: activity.activityRef, sequence: activity.sequence })
    return this.inboxDelta([], [], [], [], [], [], [marker])
  }

  private mainMessageInboxDelta(message: AgentTeamMainMessage, mentions: readonly AgentTeamMemberId[]): AgentTeamInboxDelta {
    const markers: AgentTeamMainMessageMarker[] = mentions.map(memberId => Object.freeze({ memberId, projectRef: message.projectRef,
      messageRef: message.messageRef, sequence: message.sequence }))
    return this.inboxDelta([], [], [], [], [], [], markers)
  }

  /** A Main stream reply answers a Main stream Message of the same Project; a Thread Message is never a target. */
  private requireMainReplyParent(ref: AgentTeamMessageRef | undefined, projectRef: AgentTeamProjectRef): AgentTeamMainMessage | undefined {
    if (ref === undefined) return undefined
    const source = this.state.mainSourceByRef.get(ref)
    if (source?.kind === 'message') {
      if (source.message.projectRef !== projectRef) throw new Error(`reply target '${ref}' belongs to another Project`)
      return source.message
    }
    const reason = this.state.messagesByRef.has(ref) ? 'is a Thread Message, and the Main stream answers only Main stream Messages'
      : `is not a recorded Message${this.unknownRefHint(ref, 'message', 'Message')}`
    throw new Error(`reply target '${ref}' ${reason} — ${recoveryFor('reply_target_unknown').sentence({ refused: `'${ref}'` })}`)
  }

  private mainPostResult(operation: AgentTeamMainMessagePostedOperation): AgentTeamPostMainMessageCommittedResult {
    return Object.freeze({ kind: 'committed', receipt: this.receipt(operation), message: operation.data.message,
      markers: operation.data.inbox.mainMarkers?.added ?? [] })
  }

  private startThreadResult(operation: AgentTeamThreadStartedOperation): AgentTeamStartThreadResult {
    return Object.freeze({ kind: 'committed', receipt: this.receipt(operation), message: operation.data.anchor,
      ...(operation.data.task === undefined ? {} : { task: operation.data.task }), thread: operation.data.thread,
      attention: operation.data.inbox.attention.set, directMarkers: operation.data.inbox.directMarkers.added })
  }

  private assertSameMainMessage(operation: AgentTeamOperation, request: AgentTeamAuthorizedPostMainMessageRequest, recipients: readonly AgentTeamMemberId[]): asserts operation is AgentTeamMainMessagePostedOperation {
    if (operation.kind !== 'team/main-message-posted' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.message.projectRef !== request.projectRef
      || operation.data.message.body !== request.body.trim() || !this.sameList(operation.data.mentions, recipients)
      || operation.data.message.replyToMessageRef !== request.replyToMessageRef
      || !this.sameList(operation.data.message.attachments?.map(attachment => attachment.attachmentId) ?? [],
        request.resolvedAttachments?.map(attachment => attachment.attachmentId) ?? [])) this.throwRequestCollision(request.requestId)
  }

  private assertSameThreadStart(operation: AgentTeamOperation, request: AgentTeamAuthorizedStartThreadRequest, recipients: readonly AgentTeamMemberId[]): asserts operation is AgentTeamThreadStartedOperation {
    if (operation.kind !== 'team/thread-started' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.projectRef !== request.projectRef
      || operation.data.kind !== request.kind || operation.data.anchor.body !== request.body.trim()
      || !this.sameList(operation.data.mentions, recipients)
      || !this.sameList(operation.data.anchor.attachments?.map(attachment => attachment.attachmentId) ?? [],
        request.resolvedAttachments?.map(attachment => attachment.attachmentId) ?? [])) this.throwRequestCollision(request.requestId)
  }

  private assertSameMainRead(operation: AgentTeamOperation, request: AgentTeamAuthorizedMainStreamReadRequest, projectRef: AgentTeamProjectRef): asserts operation is AgentTeamMainStreamReadOperation {
    if (operation.kind !== 'team/main-stream-read' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.projectRef !== projectRef
      || (request.readThroughSequence !== undefined && operation.data.readThroughSequence !== request.readThroughSequence)) this.throwRequestCollision(request.requestId)
  }

  private unreadRequired(task: AgentTeamTask | undefined, thread: AgentTeamThread, unread: readonly AgentTeamThreadReadFact[]): AgentTeamUnreadRequired {
    return Object.freeze({ kind: 'unread_required', ...(task === undefined ? {} : { taskRef: task.taskRef }), threadRef: thread.threadRef,
      revision: thread.revision, unreadCount: unread.length, directCount: unread.filter(item => item.direct).length,
      facts: unread })
  }

  private staleRevision(actorMemberId: AgentTeamMemberId, task: AgentTeamTask | undefined, thread: AgentTeamThread, expectedRevision: number): AgentTeamStaleRevision {
    const relation = this.revisionRelationTo(thread, expectedRevision)
    const staleTokenKind = relation === 'reached' ? undefined : relation === 'known-absent' ? 'unrecognized' : 'unknown'
    return Object.freeze({ kind: 'stale_revision', ...(task === undefined ? {} : { taskRef: task.taskRef }), threadRef: thread.threadRef,
      expectedRevision, revision: thread.revision,
      ...(staleTokenKind === undefined ? {} : { staleTokenKind }),
      facts: this.factsAfter(actorMemberId, thread.threadRef, expectedRevision) })
  }

  /**
   * How the token a stale writer used relates to this Thread's revisions.
   *
   * `before-first-fact` is a token from before this Thread existed — the writer
   * may simply have read it a moment too early. `known-absent` is a token this
   * Thread's revisions skipped over: the writer copied it from another Thread or
   * invented it, so the way out names that instead of pointing at facts that
   * were never missed. `reached` means the revision really was a point this
   * Thread passed, so the write is a plain race.
   */
  private revisionRelationTo(thread: AgentTeamThread, expectedRevision: number): 'before-first-fact' | 'known-absent' | 'reached' {
    const facts = this.threadFactsFrom(this.state, thread.threadRef)
    const first = facts[0]?.sequence
    if (first === undefined || expectedRevision < first) return 'before-first-fact'
    return facts.some(fact => fact.sequence === expectedRevision) ? 'reached' : 'known-absent'
  }

  /**
   * The facts committed strictly after `sequence` — the increment a stale
   * writer never saw. `unread_required` already carries its own batch through
   * `unreadFor`; this is the revision gate's equivalent, where the missed
   * facts are simply those past the obsolete token. `unread` is true by
   * construction (the writer's token predates them) and `direct` resolves
   * through the same marker lookup a read uses, so the two surfaces can never
   * disagree about which facts were aimed at this reader.
   */
  private factsAfter(memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef, sequence: number): readonly AgentTeamThreadReadFact[] {
    const projection = this.state
    const directKeys = new Set(this.frozenMarkerSnapshot(projection, memberId, threadRef).map(marker => this.directMarkerKey(marker)))
    const result: AgentTeamThreadReadFact[] = []
    for (const fact of this.threadFactsFrom(projection, threadRef)) {
      if (fact.sequence <= sequence) continue
      const direct = fact.kind === 'message' && directKeys.has(this.directMarkerKey({ memberId, threadRef,
        messageRef: fact.message.messageRef, sequence: fact.sequence }))
      result.push(Object.freeze({ fact, unread: true, direct }))
    }
    return Object.freeze(result)
  }

  private releaseSummaries(
    claims: readonly AgentTeamClaim[],
    actor: AgentTeamMemberId,
    sequence: number,
  ): readonly AgentTeamClaimsReleasedActivity[] {
    const byThread = new Map<AgentTeamThreadRef, AgentTeamClaim[]>()
    for (const claim of claims) {
      const grouped = byThread.get(claim.threadRef) ?? []
      grouped.push(claim)
      byThread.set(claim.threadRef, grouped)
    }
    return Object.freeze([...byThread.entries()].map(([threadRef, grouped]) => Object.freeze({ activityRef: this.ref('activity'),
      kind: 'claims_released' as const, taskRef: grouped[0]!.taskRef, threadRef, actor, sequence,
      claimRefs: Object.freeze(grouped.map(claim => claim.claimRef).sort()) })))
  }

  private threadsForActivities(activities: readonly AgentTeamClaimsReleasedActivity[]): readonly AgentTeamThread[] {
    return Object.freeze(activities.map(activity => Object.freeze({ ...this.requireThread(activity.threadRef), revision: activity.sequence })))
  }

  private claimsForTask(taskRef: AgentTeamTaskRef): readonly AgentTeamClaim[] {
    return this.claimsForTaskFrom(this.state, taskRef)
  }

  private claimsForTaskFrom(projection: Projection, taskRef: AgentTeamTaskRef): readonly AgentTeamClaim[] {
    return Object.freeze([...(projection.claimsByTask.get(taskRef) ?? [])])
  }

  private claimsForVisibleTasks(tasks: readonly AgentTeamTask[]): readonly AgentTeamClaim[] {
    return Object.freeze(tasks.flatMap(task => [...(this.state.claimsByTask.get(task.taskRef) ?? [])]))
  }

  /**
   * The team_view「活跃 task thread」radar for a Workspace: every visible Task
   * still in flight — in_progress or in_review, the two states a live Claim
   * keeps a Task in — newest activity first. Unlike `recentInboxItems`, this is
   * not a participation slice: admission is the Task being active in a Project
   * the reader can see, whether or not the reader wrote in it, and a Thread
   * still holding the reader's unread is not excluded. Rows carry the same
   * `liveClaimOwners`口径 the Inbox and Project feed already use, so 「谁在这个
   * Task 上」 never gains a second definition. Archived Projects are already
   * absent from `visibleTasks`, so their Tasks never reach here.
   */
  private activeTaskThreads(visibleTasks: readonly AgentTeamTask[],
    taskNumbers: ReadonlyMap<AgentTeamTaskRef, number>): readonly AgentTeamActiveTaskThread[] {
    const rows: { row: AgentTeamActiveTaskThread; sequence: number }[] = []
    for (const task of visibleTasks) {
      if (task.status !== 'in_progress' && task.status !== 'in_review') continue
      const thread = this.state.threads.get(task.threadRef)
      if (thread === undefined) continue
      const newest = (this.state.factsByThread.get(thread.threadRef) ?? []).at(-1)
      if (newest === undefined) continue
      const taskNumber = taskNumbers.get(task.taskRef)
      rows.push({
        row: Object.freeze({ taskRef: task.taskRef, threadRef: thread.threadRef, projectRef: task.projectRef,
          ...(taskNumber === undefined ? {} : { taskNumber }), status: task.status,
          subject: boundedOpeningLine(this.threadAnchor(thread.threadRef).body, ONE_LINE_GIST_MAX_CHARACTERS),
          members: this.liveClaimOwners(task), lastActivityAt: newest.occurredAt }),
        sequence: newest.sequence,
      })
    }
    rows.sort((left, right) => right.sequence - left.sequence || left.row.threadRef.localeCompare(right.row.threadRef))
    return Object.freeze(rows.map(entry => entry.row))
  }

  private tasksForClaims(claims: readonly AgentTeamClaim[], projected: ReadonlyMap<AgentTeamClaimRef, AgentTeamClaim>): readonly AgentTeamTask[] {
    return Object.freeze([...new Set(claims.map(claim => claim.taskRef))].map(taskRef => {
      const task = this.state.tasks.get(taskRef)!
      return Object.freeze({ ...task, status: this.deriveResolvedTaskStatus(task, projected.values()) })
    }))
  }

  /** Resolve one Task's Thread for a workspace-authorized actor; Member actors must belong to the Task's Project. */
  private threadForActor(actor: AgentTeamHumanActor | AgentTeamMemberActor, workspaceId: WorkspaceId, taskRef: AgentTeamTaskRef): { readonly task: AgentTeamTask; readonly thread: AgentTeamThread } {
    const task = this.requireTask(workspaceId, taskRef)
    const thread = this.requireThread(task.threadRef)
    this.assertThreadProjectActive(task.projectRef)
    if (actor.kind === 'member') this.requireMemberProject(this.requireMember(actor.memberId), task.projectRef)
    return { task, thread }
  }

  /**
   * Business outcomes that defer a thread write: unread work first, then a
   * stale revision.
   *
   * The unread gate has a second chance before it refuses: when every unread
   * fact is already on this Member's model-visible surface in full, the model
   * has genuinely read the content, and refusing the write would buy nothing
   * but a round-trip. That exemption writes no ledger state — no watermark
   * advance, no marker consumed — it only declines to refuse this one write,
   * so the durable "has this been read" answer stays exactly what it was.
   */
  private deferredThreadWrite(actorMemberId: AgentTeamMemberId, task: AgentTeamTask | undefined, thread: AgentTeamThread, baseRevision: number): AgentTeamUnreadRequired | AgentTeamStaleRevision | undefined {
    const unread = this.unreadFor(actorMemberId, thread.threadRef)
    if (unread.length > 0 && !this.visibleSurfaceExempts(actorMemberId, unread)) return this.unreadRequired(task, thread, unread)
    if (baseRevision !== thread.revision) return this.staleRevision(actorMemberId, task, thread, baseRevision)
    return undefined
  }

  /**
   * Whether every unread fact is already on this Member's visible surface.
   * Fail-closed in every direction: an absent probe, an empty answer, or one
   * fact the surface cannot show means the write is not exempt. The probe is
   * the Host's, because the surface is runtime state the ledger never holds.
   */
  private visibleSurfaceExempts(memberId: AgentTeamMemberId, unread: readonly AgentTeamThreadReadFact[]): boolean {
    const probe = this.isFactVisible
    if (probe === undefined) return false
    return unread.every(fact => probe(memberId, fact))
  }

  /** Commit projections shared by the Message-sent and Thread-replied results. */
  private committedMessageResult(operation: AgentTeamMessageSentOperation | AgentTeamThreadRepliedOperation, undelivered: readonly AgentTeamMemberId[] = []) {
    return { kind: 'committed' as const, receipt: this.receipt(operation), message: operation.data.message,
      ...(operation.data.task === undefined ? {} : { task: operation.data.task }), thread: operation.data.thread, attention: operation.data.inbox.attention.set,
      directMarkers: operation.data.inbox.directMarkers.added,
      ...(undelivered.length === 0 ? {} : { undeliveredMentions: undelivered }) }
  }

  private threadAnchor(threadRef: AgentTeamThreadRef): AgentTeamMessage {
    return this.threadAnchorFrom(this.state, threadRef)
  }

  private threadAnchorFrom(projection: Projection, threadRef: AgentTeamThreadRef): AgentTeamMessage {
    const anchor = projection.anchorByThread.get(threadRef)
    if (anchor === undefined) throw new Error(`Thread '${threadRef}' has no anchor Message`)
    return anchor
  }

  private threadFactKey(fact: AgentTeamThreadFact): string {
    return fact.kind === 'message' ? `message:${fact.message.messageRef}` : `activity:${fact.activity.activityRef}`
  }

  /**
   * Display numbers for Tasks: one counter per home Project, in creation
   * order. This is the single numbering authority — Project cards, Thread
   * headings, cross-project ref resolution, and inbox renders all show the
   * ordinal the Task holds inside its own Project. The ordinals are derived
   * at replay time (`taskNumberByTask`); this read only filters them to one
   * Workspace.
   */
  private taskNumbers(workspaceId: WorkspaceId): Map<AgentTeamTaskRef, number> {
    const numbers = new Map<AgentTeamTaskRef, number>()
    for (const [taskRef, taskNumber] of this.state.taskNumberByTask) {
      const task = this.state.tasks.get(taskRef)
      if (task === undefined || this.state.projects.get(task.projectRef)?.workspaceId !== workspaceId) continue
      numbers.set(taskRef, taskNumber)
    }
    return numbers
  }

  private hasActiveClaim(memberId: AgentTeamMemberId, taskRef: AgentTeamTaskRef): boolean {
    return this.hasActiveClaimFrom(this.state, memberId, taskRef)
  }

  private hasActiveClaimFrom(projection: Projection, memberId: AgentTeamMemberId, taskRef: AgentTeamTaskRef): boolean {
    return [...projection.claims.values()].some(claim => claim.owner === memberId && claim.taskRef === taskRef && claim.state === 'active')
  }

  private deriveResolvedTaskStatus(task: AgentTeamTask, claims: Iterable<AgentTeamClaim>): AgentTeamTask['status'] {
    return task.resolution === 'accepted' ? 'done' : task.resolution === 'closed' ? 'closed' : this.deriveTaskStatus(task.taskRef, claims)
  }

  private deriveTaskStatus(taskRef: AgentTeamTaskRef, claims: Iterable<AgentTeamClaim>): AgentTeamTask['status'] {
    const relevant = [...claims].filter(claim => claim.taskRef === taskRef)
    if (relevant.some(claim => claim.state === 'active')) return 'in_progress'
    if (relevant.some(claim => claim.state === 'done')) return 'in_review'
    return 'todo'
  }

  private setMemberState(request: AgentTeamAuthorizedSetMemberStateRequest, state: 'enabled' | 'suspended'): Promise<AgentTeamLedgerResult<AgentTeamDurableMemberResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameMemberState(existing, request, state)
        return this.resolved(this.memberResult(existing))
      }
      this.assertHumanActor(request.actor)
      const member = this.requireMember(request.memberId)
      const prior = state === 'suspended' ? 'enabled' : 'suspended'
      if (member.state !== prior) throw new Error(`Agent Member '${member.memberId}' is already ${member.state}`)
      const next = Object.freeze({ ...member, state })
      const operation: AgentTeamMemberSuspendedOperation | AgentTeamMemberResumedOperation = state === 'suspended'
        ? Object.freeze({ ...this.operationBase(request, this.nextSequence()), kind: 'team/member-suspended', data: Object.freeze({ member: next }) })
        : Object.freeze({ ...this.operationBase(request, this.nextSequence()), kind: 'team/member-resumed', data: Object.freeze({ member: next }) })
      await this.table.put(operation.operationId, operation)
      this.applyAndAdvanceProjectionVersion(operation)
      this.confirmations.clear()
      return this.committed(this.memberResult(operation))
    })
  }

  private assertActorForWorkspace(actor: AgentTeamHumanActor | AgentTeamMemberActor, workspaceId: WorkspaceId): AgentTeamHumanActor | AgentTeamMemberActor {
    if (actor.kind === 'human') {
      this.assertHumanActor(actor)
      return actor
    }
    const member = this.assertMemberActor(actor)
    if (!this.participatesIn(member.memberId, workspaceId)) throw new Error('Member cannot mutate another Workspace')
    return actor
  }

  private assertHumanActor(actor: AgentTeamActor): void {
    const initialization = this.initialization()
    // memberId is the durable Human authority; the handle is display-only.
    if (actor.kind !== 'human' || actor.memberId !== initialization.data.humanMemberId) {
      throw new Error('agent-team operation lacks Human authority')
    }
  }

  private assertMemberActor(actor: AgentTeamMemberActor): AgentTeamAgentMember {
    const member = this.requireMember(actor.memberId)
    if (member.state !== 'enabled' || member.handle !== actor.handle) throw new Error('agent-team operation lacks enabled Member authority')
    return member
  }

  /** Shortest accepted UUID abbreviation after the branded prefix. */
  private static readonly MIN_REF_UUID_PREFIX = 6

  private isRefAbbreviationTail(tail: string): boolean {
    return tail.length >= AgentTeamLedger.MIN_REF_UUID_PREFIX && /^[0-9a-f]+$/i.test(tail)
  }

  /**
   * Full map key for one branded ref, tolerating a unique UUID abbreviation.
   * Exact refs win; an abbreviated ref (prefix plus at least 6 hex chars,
   * hyphens ignored) resolves only when it matches exactly one key. Returns
   * undefined for unknown or ambiguous refs so lenient callers can degrade
   * without throwing.
   */
  private uniqueRefKey<TKey extends string>(map: ReadonlyMap<TKey, unknown>, ref: string, prefix: string): TKey | undefined {
    if (map.has(ref as TKey)) return ref as TKey
    const tail = ref.startsWith(`${prefix}:`) ? ref.slice(prefix.length + 1).replaceAll('-', '') : undefined
    if (tail === undefined || !this.isRefAbbreviationTail(tail)) return undefined
    const lower = tail.toLowerCase()
    const candidates = [...map.keys()].filter(key => key.slice(prefix.length + 1).replaceAll('-', '').startsWith(lower))
    return candidates.length === 1 ? candidates[0] : undefined
  }

  /** uniqueRefKey with the established unknown/ambiguous error contract and hints. */
  private requireRefKey<TKey extends string>(map: ReadonlyMap<TKey, unknown>, ref: string, prefix: string, label: string): TKey {
    const key = this.uniqueRefKey(map, ref, prefix)
    if (key !== undefined) return key
    const tail = ref.startsWith(`${prefix}:`) ? ref.slice(prefix.length + 1).replaceAll('-', '') : undefined
    if (tail !== undefined && this.isRefAbbreviationTail(tail)) {
      const lower = tail.toLowerCase()
      const candidates = [...map.keys()].filter(candidate => candidate.slice(prefix.length + 1).replaceAll('-', '').toLowerCase().startsWith(lower))
      if (candidates.length > 1) {
        throw new Error(`ambiguous ${label} ref '${ref}' matches ${candidates.map(candidate => `'${candidate}'`).join(', ')} — ${recoveryFor('ambiguous_ref').sentence({ refused: `'${ref}'` })}`)
      }
    }
    throw new Error(`unknown ${label} ref '${ref}'${this.unknownRefHint(ref, prefix, label)} — ${recoveryFor('unknown_ref').sentence({ refused: `${label} '${ref}'` })}`)
  }

  /** Agents strip the branded prefix or abbreviate UUIDs when echoing refs; point at the fix instead of a bare lookup failure. */
  private unknownRefHint(ref: string, prefix: string, label: string): string {
    if (!ref.startsWith(`${prefix}:`)) {
      return ` A ${label} ref must start with '${prefix}:'; reuse the full ref exactly as returned by Team tools ('${prefix}:${ref}').`
    }
    const tail = ref.slice(prefix.length + 1).replaceAll('-', '')
    return this.isRefAbbreviationTail(tail)
      ? ` No ${label} matches this UUID prefix; reuse the full ref exactly as returned by Team tools.`
      : ` A ${label} ref needs at least 6 hex characters after '${prefix}:', or the full ref exactly as returned by Team tools.`
  }

  private requireTask(workspaceId: WorkspaceId, taskRef: AgentTeamTaskRef): AgentTeamTask {
    const task = this.state.tasks.get(this.requireRefKey(this.state.tasks, taskRef, 'task', 'Task'))
    if (task === undefined) throw new Error(`unknown Task ref '${taskRef}'${this.unknownRefHint(taskRef, 'task', 'Task')}`)
    if (this.state.projects.get(task.projectRef)?.workspaceId !== workspaceId) throw new Error(`Task '${taskRef}' does not belong to Workspace '${workspaceId}'`)
    return task
  }

  private requireThread(threadRef: AgentTeamThreadRef): AgentTeamThread {
    const thread = this.state.threads.get(this.requireRefKey(this.state.threads, threadRef, 'thread', 'Thread'))
    if (thread === undefined) throw new Error(`unknown Thread ref '${threadRef}'${this.unknownRefHint(threadRef, 'thread', 'Thread')}`)
    return thread
  }

  private projectRefForThread(threadRef: AgentTeamThreadRef): AgentTeamProjectRef | undefined {
    return this.projectRefForThreadFrom(this.state, threadRef)
  }

  /**
   * The Project one read resolves against, or undefined when it is not on Team
   * read surfaces at all.
   *
   * Archival removes a Project and everything it owns from every read: its
   * Threads, Tasks, Claims, and Messages stop resolving, and participation ends
   * with it. This is the single definition of that rule for reads; writes use
   * `requireActiveProject`, and Thread-scoped writes `assertThreadProjectActive`.
   */
  private visibleProject(project: AgentTeamProject | undefined): AgentTeamProject | undefined {
    return project?.state === 'archived' ? undefined : project
  }

  private projectRefForThreadFrom(projection: Projection, threadRef: AgentTeamThreadRef): AgentTeamProjectRef | undefined {
    return projection.projectRefByThread.get(threadRef)
  }

  private threadContextForActor(
    actor: AgentTeamHumanActor | AgentTeamMemberActor,
    workspaceId: WorkspaceId,
    request: { threadRef?: AgentTeamThreadRef | undefined; taskRef?: AgentTeamTaskRef | undefined },
  ): { readonly task?: AgentTeamTask; readonly thread: AgentTeamThread; readonly projectRef: AgentTeamProjectRef } {
    const resolved = this.threadContextFrom(this.state, workspaceId, request)
    if (actor.kind === 'member') this.requireMemberProject(this.requireMember(actor.memberId), resolved.projectRef)
    return resolved
  }

  private threadContextFrom(
    projection: Projection,
    workspaceId: WorkspaceId,
    request: { threadRef?: AgentTeamThreadRef | undefined; taskRef?: AgentTeamTaskRef | undefined },
  ): { readonly task?: AgentTeamTask; readonly thread: AgentTeamThread; readonly projectRef: AgentTeamProjectRef } {
    if (request.threadRef === undefined && request.taskRef === undefined) throw new Error('Thread addressing requires threadRef or taskRef')
    let thread: AgentTeamThread | undefined
    let task: AgentTeamTask | undefined
    if (request.threadRef !== undefined) {
      const threadKey = this.requireRefKey(projection.threads, request.threadRef, 'thread', 'Thread')
      thread = projection.threads.get(threadKey)
      if (thread === undefined) throw new Error(`unknown Thread ref '${request.threadRef}'${this.unknownRefHint(request.threadRef, 'thread', 'Thread')}`)
      task = thread.taskRef === undefined ? undefined : projection.tasks.get(thread.taskRef)
    }
    if (request.taskRef !== undefined) {
      const taskKey = this.requireRefKey(projection.tasks, request.taskRef, 'task', 'Task')
      const byTask = projection.tasks.get(taskKey)
      if (byTask === undefined) throw new Error(`unknown Task ref '${request.taskRef}'${this.unknownRefHint(request.taskRef, 'task', 'Task')}`)
      if (task !== undefined && task.taskRef !== byTask.taskRef) throw new Error(`Task '${request.taskRef}' does not belong to Thread '${request.threadRef}'`)
      if (thread !== undefined && byTask.threadRef !== thread.threadRef) throw new Error(`Task '${request.taskRef}' does not belong to Thread '${thread.threadRef}'`)
      task = byTask
      thread = projection.threads.get(byTask.threadRef)
      if (thread === undefined) throw new Error(`unknown Thread ref '${byTask.threadRef}'`)
    }
    if (thread === undefined) throw new Error('unknown Thread')
    const projectRef = this.projectRefForThreadFrom(projection, thread.threadRef)
    if (projectRef === undefined) throw new Error(`Thread '${thread.threadRef}' has no Project`)
    if (projection.projects.get(projectRef)?.workspaceId !== workspaceId) throw new Error(`Thread '${thread.threadRef}' does not belong to Workspace '${workspaceId}'`)
    // Replay stays honest: operations predating the archival resolve against
    // the then-active Project because replay applies in sequence.
    if (projection.projects.get(projectRef)?.state === 'archived') {
      throw new Error(`Project '${projectRef}' is archived and no longer accepts Team work`)
    }
    if (task !== undefined && task.projectRef !== projectRef) throw new Error(`Task '${task.taskRef}' does not belong to Thread '${thread.threadRef}'`)
    return { ...(task === undefined ? {} : { task }), thread, projectRef }
  }

  private requireProject(workspaceId: WorkspaceId, projectRef: AgentTeamProjectRef): AgentTeamProject {
    const project = this.state.projects.get(this.requireRefKey(this.state.projects, projectRef, 'project', 'Project'))
    if (project === undefined) throw new Error(`unknown Project ref '${projectRef}'${this.unknownRefHint(projectRef, 'project', 'Project')}`)
    if (project.workspaceId !== workspaceId) throw new Error(`Project '${projectRef}' does not belong to Workspace '${workspaceId}'`)
    return project
  }

  /** Guard for every mutating or Project-scoped surface flow: archived Projects reject. */
  private requireActiveProject(workspaceId: WorkspaceId, projectRef: AgentTeamProjectRef): AgentTeamProject {
    const project = this.requireProject(workspaceId, projectRef)
    if (project.state === 'archived') throw new Error(`Project '${projectRef}' is archived and no longer accepts Team work`)
    return project
  }

  /** Thread-mutation guard: the Project owning the Thread must still be active. */
  private assertThreadProjectActive(projectRef: AgentTeamProjectRef): void {
    if (this.state.projects.get(projectRef)?.state === 'archived') {
      throw new Error(`Project '${projectRef}' is archived and no longer accepts Team work`)
    }
  }

  private requireMember(memberId: AgentTeamMemberId): AgentTeamAgentMember {
    const member = this.state.members.get(this.requireRefKey(this.state.members, memberId, 'member', 'Agent Member'))
    if (member === undefined) throw new Error(`unknown Agent Member '${memberId}'`)
    return member
  }

  /**
   * Live-side write gate for a Member acting in a Project: participation in the
   * Workspace that owns the Project. Joining the Project is not a prerequisite —
   * a Member who works in this Workspace can reply, claim, follow and read here.
   */
  private requireMemberProject(member: AgentTeamAgentMember, projectRef: AgentTeamProjectRef): void {
    const project = this.state.projects.get(projectRef)
    if (project === undefined || !this.participatesIn(member.memberId, project.workspaceId)) {
      throw new Error(`Agent Member '${member.memberId}' is not authorized for Project '${projectRef}'`)
    }
  }

  /**
   * Replay-side write authorization for one Project's operations:
   * participation in the Workspace that owns the Project. Project membership
   * is a Human-side organisation and is not a write gate, but historical
   * operations were checked against it; every actor that passed the
   * membership form also participates, so this form never rejects a record
   * the membership form accepted.
   */
  private participatesInProjectWorkspaceFrom(projection: Projection, projectRef: AgentTeamProjectRef, memberId: AgentTeamMemberId): boolean {
    const workspaceId = projection.projects.get(projectRef)?.workspaceId
    return workspaceId !== undefined && this.participatesInFrom(projection, memberId, workspaceId)
  }

  /**
   * Whether a Member takes part in a Project (the visibility question),
   * derived from taking part in any Thread of the Project, or from an
   * explicit membership a historical ledger still carries. The explicit half
   * keeps old ledgers reproducible (a Member added by `project-member-joined`
   * who never wrote a word must still see the Project); nothing new is
   * enrolled. Deriving from Threads is what makes a Member mentioned into a
   * Thread see the Project that Thread belongs to.
   */
  private isProjectMember(projectRef: AgentTeamProjectRef, memberId: AgentTeamMemberId): boolean {
    return this.isProjectMemberFrom(this.state, projectRef, memberId)
  }

  private isProjectMemberFrom(projection: Projection, projectRef: AgentTeamProjectRef, memberId: AgentTeamMemberId): boolean {
    // Deriving stays inside the Workspace boundary: a Member who has left the
    // Workspace stops seeing its Projects even though the Threads it wrote
    // there are still on the record.
    if (memberId === AGENT_TEAM_HUMAN_MEMBER_ID) return false
    const project = projection.projects.get(projectRef)
    if (project === undefined || !this.participatesInFrom(projection, memberId, project.workspaceId)) return false
    if (projection.rulesVersion >= 2) {
      // Version 2 widens membership to owners and anyone ever named in the Project, and drops departed Members,
      // enrolled ones included: the rule intersects every source with the Member lifecycle (spec §2).
      const state = projection.members.get(memberId)?.state
      if (state === 'inactive' || state === 'archived') return false
      if (projection.owners.get(projectRef)?.has(memberId) === true) return true
      if (projection.mentionedByProject.get(projectRef)?.has(memberId) === true) return true
      if (projection.memberships.get(projectRef)?.has(memberId) === true) return true
    } else if (projection.memberships.get(projectRef)?.has(memberId) === true) {
      return true
    }
    for (const threadRef of this.projectThreadRefsFrom(projection, projectRef)) {
      if (this.everParticipatedFrom(projection, threadRef, memberId)) return true
    }
    return false
  }

  /** Every Thread of the Project, taskful or taskless — the scope both cleanup validators replay against. */
  private projectThreadRefs(projectRef: AgentTeamProjectRef): Set<AgentTeamThreadRef> {
    return this.projectThreadRefsFrom(this.state, projectRef)
  }

  private projectThreadRefsFrom(projection: Projection, projectRef: AgentTeamProjectRef): Set<AgentTeamThreadRef> {
    return new Set([...projection.threads.keys()].filter(threadRef => this.projectRefForThreadFrom(projection, threadRef) === projectRef))
  }

  /** The Workspace authorization question: does this Member participate in this Workspace. */
  participatesIn(memberId: AgentTeamMemberId, workspaceId: WorkspaceId): boolean {
    return this.participatesInFrom(this.state, memberId, workspaceId)
  }

  private participatesInFrom(projection: Projection, memberId: AgentTeamMemberId, workspaceId: WorkspaceId): boolean {
    return projection.participations.get(memberId)?.has(workspaceId) === true
  }

  /** Every Workspace the Member participates in: the default first, then the rest sorted. */
  workspacesOf(memberId: AgentTeamMemberId): readonly WorkspaceId[] {
    return Object.freeze(this.workspacesOfFrom(this.state, memberId))
  }

  private workspacesOfFrom(projection: Projection, memberId: AgentTeamMemberId): WorkspaceId[] {
    const member = projection.members.get(memberId)
    if (member === undefined) return []
    const rest = [...(projection.participations.get(memberId) ?? new Set<WorkspaceId>())]
      .filter(workspaceId => workspaceId !== member.workspaceId).sort()
    return [member.workspaceId, ...rest]
  }

  /** Whether two Members share at least one Workspace participation — the handle-uniqueness scope. */
  private participationOverlapFrom(projection: Projection, leftMemberId: AgentTeamMemberId, rightMemberId: AgentTeamMemberId): boolean {
    const left = projection.participations.get(leftMemberId)
    const right = projection.participations.get(rightMemberId)
    if (left === undefined || right === undefined) return false
    for (const workspaceId of left) if (right.has(workspaceId)) return true
    return false
  }

  /** Every Thread in the Workspace — the scope a Workspace leave replays its cleanup against. */
  private workspaceThreadRefs(workspaceId: WorkspaceId): Set<AgentTeamThreadRef> {
    return this.workspaceThreadRefsFrom(this.state, workspaceId)
  }

  private workspaceProjectRefsFrom(projection: Projection, workspaceId: WorkspaceId): Set<AgentTeamProjectRef> {
    return new Set([...projection.projects.values()].filter(project => project.workspaceId === workspaceId).map(project => project.projectRef))
  }

  private workspaceThreadRefsFrom(projection: Projection, workspaceId: WorkspaceId): Set<AgentTeamThreadRef> {
    return new Set([...projection.threads.keys()].filter(threadRef => {
      const projectRef = this.projectRefForThreadFrom(projection, threadRef)
      return projectRef !== undefined && projection.projects.get(projectRef)?.workspaceId === workspaceId
    }))
  }

  private assertJoinableMember(workspaceId: WorkspaceId, memberId: AgentTeamMemberId): void {
    const member = this.requireMember(memberId)
    if (!this.participatesIn(memberId, workspaceId)) throw new Error(`Agent Member '${memberId}' does not participate in Workspace '${workspaceId}'`)
    if (member.state !== 'enabled') throw new Error(`Agent Member '${memberId}' is ${member.state}; only enabled Members can join a Project`)
  }

  private normalizeRecipients(actor: AgentTeamHumanActor | AgentTeamMemberActor, recipients: readonly AgentTeamMemberId[] | undefined): readonly AgentTeamMemberId[] {
    const normalized = this.normalizeUnique(recipients, 'recipient set')
    if (normalized.includes(actor.memberId)) throw new Error('sender cannot be a recipient intent')
    return normalized
  }

  private normalizeUnique<T extends string>(values: readonly T[] | undefined, label: string): readonly T[] {
    const unique = new Set(values ?? [])
    if (unique.size !== (values?.length ?? 0)) throw new Error(`${label} contains duplicate Member refs`)
    return Object.freeze([...unique].sort())
  }

  /**
   * Names a Message body may address in one Project: every live Member who
   * participates in the Project's Workspace plus the Human. A name outside this
   * set stays prose, which is what keeps an incidental name-drop from reaching
   * someone the Workspace cannot deliver to.
   *
   * Participation, not Project membership, is the boundary: Project membership
   * is a Human-side organisation of the Workspace, so a Member who works in
   * this Workspace is addressable here without first being enrolled in the
   * Project. `@all` is narrower than this set — see `allRecipientsFor`.
   *
   * The Human is reachable under two names: the current display handle and the
   * permanent `human` alias, so a rename never silently orphans `@human`
   * (matching ignores case, and chips render the display name either way).
   * The alias yields when another candidate already answers to it, so one
   * written name never notifies two different Members; enrollment reserves the
   * literal, so that yield only ever covers data predating the reservation.
   */
  private mentionCandidatesFor(projectRef: AgentTeamProjectRef): readonly AgentTeamBodyMentionCandidate[] {
    const workspaceId = this.state.projects.get(projectRef)?.workspaceId
    const candidates: AgentTeamBodyMentionCandidate[] = [{ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, handle: this.humanHandle }]
    for (const member of this.state.members.values()) {
      if (member.state === 'inactive' || member.state === 'archived') continue
      if (workspaceId === undefined || !this.participatesIn(member.memberId, workspaceId)) continue
      candidates.push({ memberId: member.memberId, handle: member.handle })
    }
    return this.withHumanAlias(candidates)
  }

  /**
   * The Member set `@all` stands for in one Project: the Members who take part
   * in that Project plus the Human. Deliberately narrower than the names a body
   * may address — a Member can be named by hand from anywhere in the Workspace,
   * while `@all` only reaches the people already in this conversation.
   */
  private allRecipientsFor(projectRef: AgentTeamProjectRef): readonly AgentTeamMemberId[] {
    const memberIds: AgentTeamMemberId[] = [AGENT_TEAM_HUMAN_MEMBER_ID]
    for (const member of this.state.members.values()) {
      if (member.state === 'inactive' || member.state === 'archived') continue
      if (!this.isProjectMember(projectRef, member.memberId)) continue
      memberIds.push(member.memberId)
    }
    return Object.freeze(memberIds.sort())
  }

  private withHumanAlias(candidates: readonly AgentTeamBodyMentionCandidate[]): readonly AgentTeamBodyMentionCandidate[] {
    const taken = candidates.some(candidate => candidate.handle.normalize('NFKC').trim().toLowerCase() === AGENT_TEAM_HUMAN_HANDLE)
    if (taken || this.humanHandle.normalize('NFKC').trim().toLowerCase() === AGENT_TEAM_HUMAN_HANDLE) return Object.freeze([...candidates])
    return Object.freeze([...candidates, { memberId: AGENT_TEAM_HUMAN_MEMBER_ID, handle: AGENT_TEAM_HUMAN_HANDLE }])
  }

  /**
   * Resolve the Message one reply answers, inside the Thread being written.
   *
   * The ref is checked against the ledger's own Message index instead of being
   * trusted: a ref from another Thread would render as a quote of a
   * conversation this reader cannot follow, and an unknown ref would render as
   * a dangling quote. Both are refused at write time, so every stored reply has
   * a parent a reader can actually be taken to.
   */
  private requireReplyParent(request: AgentTeamAuthorizedReplyRequest, threadRef: AgentTeamThreadRef): AgentTeamMessage | undefined {
    const ref = request.replyToMessageRef
    if (ref === undefined) return undefined
    const parent = this.state.messagesByRef.get(ref)
    if (parent === undefined) throw new Error(`reply target '${ref}' is not a recorded Message${this.unknownRefHint(ref, 'message', 'Message')} — ${recoveryFor('reply_target_unknown').sentence({ refused: `'${ref}'` })}`)
    if (parent.threadRef !== threadRef) throw new Error(`reply target '${ref}' belongs to another Thread`)
    return parent
  }

  /**
   * Merge the `@Handle` mentions authored in `body` into an explicit
   * recipient set. An Agent has no recipient parameter to forget, and the
   * same scan serves Human input typed by hand. The result stays a plain
   * recipient set, so every downstream projection (delivery markers, chip
   * rendering, confirmation) is unaffected.
   */
  private mergeBodyMentions(
    sender: AgentTeamMemberId,
    projectRef: AgentTeamProjectRef,
    body: string,
    explicit: readonly AgentTeamMemberId[],
  ): readonly AgentTeamMemberId[] {
    const candidates = this.mentionCandidatesFor(projectRef)
    const resolution = resolveBodyMentions(body, candidates, sender)
    // `@all` stands for its expansion as of this write: the Member set is
    // snapshotted into the recipient list, so a later roster change cannot
    // retroactively alter what this operation delivered. It expands to the
    // Project's own participants, not to every name the body could address.
    const authored = resolution.all && this.state.rulesVersion < 2 ? this.allRecipientsFor(projectRef) : resolution.memberIds
    const merged = new Set([...explicit, ...authored])
    merged.delete(sender)
    return Object.freeze([...merged].sort())
  }

  /**
   * Whether one Member has ever held Attention on one Thread. Committed Inbox
   * deltas append a follow/unfollow observation, and the live index covers the
   * Thread-creating Message whose initial Attention is never observed — so the
   * two together answer "was this Member ever part of this Thread" without
   * adding a second durable authority.
   */
  private everParticipated(threadRef: AgentTeamThreadRef, memberId: AgentTeamMemberId): boolean {
    return this.everParticipatedFrom(this.state, threadRef, memberId)
  }

  private everParticipatedFrom(projection: Projection, threadRef: AgentTeamThreadRef, memberId: AgentTeamMemberId): boolean {
    if (this.isFollowingFrom(projection, threadRef, memberId)) return true
    return (projection.observationsByThread.get(threadRef) ?? []).some(observation => observation.memberId === memberId)
  }

  /**
   * Split the Agent recipients an existing Thread cannot deliver to: those the
   * body named that the Thread has never carried. The send still commits — a
   * text mention must never fail the write — and the author is told through the
   * result, because inviting a Member into an existing Thread stays a Human
   * decision.
   */
  private undeliverableRecipients(
    actor: AgentTeamHumanActor | AgentTeamMemberActor,
    threadRef: AgentTeamThreadRef,
    recipients: readonly AgentTeamMemberId[],
  ): readonly AgentTeamMemberId[] {
    if (actor.kind !== 'member') return Object.freeze([])
    return Object.freeze(recipients.filter(memberId => this.state.members.has(memberId) && !this.everParticipated(threadRef, memberId)))
  }

  private normalizeDirection(direction: string): string {
    return direction.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
  }

  private assertHandleAvailable(workspaceId: WorkspaceId, handle: string, exceptMemberId?: AgentTeamMemberId): void {
    this.assertHandleAvailableFrom(this.state, workspaceId, handle, exceptMemberId)
  }

  private assertHandleAvailableFrom(projection: Projection, workspaceId: WorkspaceId, handle: string, exceptMemberId?: AgentTeamMemberId): void {
    const normalized = handle.normalize('NFKC').trim().toLowerCase()
    if ([...projection.members.values()].some(member => member.memberId !== exceptMemberId && member.state !== 'inactive'
      && this.participatesInFrom(projection, member.memberId, workspaceId)
      && member.handle.normalize('NFKC').trim().toLowerCase() === normalized)) {
      throw new Error(`Agent Member handle '${handle}' is already active in Workspace '${workspaceId}'`)
    }
    // The human display name shares the @ namespace: an agent handle colliding
    // with it would make body mentions ambiguous, so it is reserved globally.
    // The ledger's runtime humanHandle is the single source; replay uses the
    // Host-synced value, and the default equals the historic literal.
    // The historic literal itself is reserved permanently alongside it: `@human`
    // is the documented permanent alias for the Human, so it must never belong
    // to an agent even after a rename moves the display name elsewhere.
    const humanNormalized = this.humanHandle.normalize('NFKC').trim().toLowerCase()
    if (humanNormalized !== '' && normalized === humanNormalized) {
      throw new Error(`Agent Member handle '${handle}' collides with the human display name`)
    }
    if (normalized === AGENT_TEAM_HUMAN_HANDLE) {
      throw new Error(`Agent Member handle '${handle}' collides with the reserved human alias`)
    }
  }

  private assertModelSelection(model: AgentTeamUpdateMemberRequest['model']): void {
    if (model === undefined || model === null) return
    if (model.provider.trim() === '' || model.model.trim() === '') throw new Error('member model selection must name a provider route and a model id')
  }

  /**
   * Capability allow-list entries are exact identifiers (skill names,
   * reserved tool names); only whitespace-only values are rejected. Unknown
   * names are intent, not errors — committing must stay replayable across
   * Harness upgrades, so divergence is derived at activation instead.
   */
  private assertCapabilities(capabilities: AgentTeamUpdateMemberRequest['capabilities']): void {
    for (const surface of [capabilities?.tools?.allow, capabilities?.skills?.allow]) {
      if (surface === undefined) continue
      if (surface.some(name => name.trim() === '')) throw new Error('capability allow-list names must not be empty')
    }
  }

  private initialization(): AgentTeamInitializedOperation {
    const operation = this.state.ordered[0]
    if (operation === undefined) throw new Error('agent-team ledger is not initialized')
    this.assertInitializationRecord(operation)
    return operation
  }

  private assertInitializationRecord(operation: AgentTeamOperation): asserts operation is AgentTeamInitializedOperation {
    if (operation.kind !== 'team/initialized' || operation.sequence !== 1 || operation.previousOperationId !== null
      || operation.actor.kind !== 'human' || operation.actor.memberId !== operation.data.humanMemberId) {
      throw new Error('agent-team initialization operation has an invalid payload')
    }
  }

  private assertSameInitialization(operation: AgentTeamOperation, request: AgentTeamInitializeRequest): asserts operation is AgentTeamInitializedOperation {
    if (operation.kind !== 'team/initialized' || !this.sameActor(operation.actor, request.actor) || operation.data.humanMemberId !== request.humanMemberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameProjectCreation(operation: AgentTeamOperation, request: AgentTeamAuthorizedCreateProjectRequest, memberIds: readonly AgentTeamMemberId[]): asserts operation is AgentTeamProjectCreatedOperation {
    if (operation.kind !== 'team/project-created' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.project.name !== request.name.trim()
      || operation.data.project.description !== request.description.trim() || !this.sameList(operation.data.memberIds, memberIds)) this.throwRequestCollision(request.requestId)
  }

  private assertSameMemberAdd(operation: AgentTeamOperation, request: AgentTeamAuthorizedAddMemberRequest): asserts operation is AgentTeamMemberAddedOperation {
    if (operation.kind !== 'team/member-added' || !this.sameActor(operation.actor, request.actor)
      || operation.data.member.workspaceId !== request.workspaceId || operation.data.member.handle !== request.handle.trim()
      || operation.data.member.description !== request.description.trim() || operation.data.member.presetId !== request.presetId.trim()
      || !isDeepStrictEqual(operation.data.member.model ?? undefined, request.member.model ?? undefined)
      || !isDeepStrictEqual(operation.data.member.capabilities ?? undefined, request.member.capabilities ?? undefined)
      || !this.sameList(operation.data.projectRefs, this.normalizeUnique(request.projectRefs, 'initial Member Projects'))) this.throwRequestCollision(request.requestId)
  }

  private assertSameMemberState(operation: AgentTeamOperation, request: AgentTeamAuthorizedSetMemberStateRequest, state: 'enabled' | 'suspended'): asserts operation is AgentTeamMemberSuspendedOperation | AgentTeamMemberResumedOperation {
    const kind = state === 'suspended' ? 'team/member-suspended' : 'team/member-resumed'
    if (operation.kind !== kind || !this.sameActor(operation.actor, request.actor) || operation.data.member.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameMemberSessionRecycled(operation: AgentTeamOperation, request: AgentTeamAuthorizedRecycleMemberSessionRequest): asserts operation is AgentTeamMemberSessionRecycledOperation {
    if (operation.kind !== 'team/member-session-recycled' || !this.sameActor(operation.actor, request.actor)
      || operation.data.member.memberId !== request.memberId || operation.data.member.sessionId !== request.newSessionId
      || operation.data.previousSessionId !== request.previousSessionId
      || operation.data.inputFromSeq !== request.inputFromSeq) this.throwRequestCollision(request.requestId)
  }

  private assertSameProjectUpdate(operation: AgentTeamOperation, request: AgentTeamAuthorizedUpdateProjectRequest): asserts operation is AgentTeamProjectUpdatedOperation {
    if (operation.kind !== 'team/project-updated' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.project.projectRef !== request.projectRef
      || operation.data.project.name !== request.name.trim() || operation.data.project.description !== request.description.trim()) this.throwRequestCollision(request.requestId)
  }

  private assertSameMemberUpdate(operation: AgentTeamOperation, request: AgentTeamAuthorizedUpdateMemberRequest): asserts operation is AgentTeamMemberUpdatedOperation {
    if (operation.kind !== 'team/member-updated' || !this.sameActor(operation.actor, request.actor)
      || operation.data.member.memberId !== request.memberId || operation.data.member.handle !== request.handle.trim()
      || operation.data.member.description !== request.description.trim()
      // Only fields the request actually states are comparable: an absent one
      // means "keep the stored value", which the record cannot distinguish from
      // a request that stated the same value.
      || (request.model !== undefined && !isDeepStrictEqual(operation.data.member.model ?? undefined, request.model ?? undefined))
      || (request.capabilities !== undefined && !isDeepStrictEqual(operation.data.member.capabilities ?? undefined, request.capabilities ?? undefined))) this.throwRequestCollision(request.requestId)
  }

  private assertSameProjectJoin(operation: AgentTeamOperation, request: AgentTeamAuthorizedJoinProjectRequest): asserts operation is AgentTeamProjectMemberAddedOperation {
    if (operation.kind !== 'team/project-member-added' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.projectRef !== request.projectRef || operation.data.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameProjectMemberRemoval(operation: AgentTeamOperation, request: AgentTeamAuthorizedRemoveProjectMemberRequest): asserts operation is AgentTeamProjectMemberRemovedOperation {
    if (operation.kind !== 'team/project-member-removed' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.projectRef !== request.projectRef || operation.data.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameWorkspaceJoin(operation: AgentTeamOperation, request: AgentTeamAuthorizedJoinWorkspaceRequest): asserts operation is AgentTeamMemberWorkspaceJoinedOperation {
    if (operation.kind !== 'team/member-workspace-joined' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameWorkspaceLeave(operation: AgentTeamOperation, request: AgentTeamAuthorizedLeaveWorkspaceRequest): asserts operation is AgentTeamMemberWorkspaceLeftOperation {
    if (operation.kind !== 'team/member-workspace-left' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameProjectArchival(operation: AgentTeamOperation, request: AgentTeamAuthorizedArchiveProjectRequest): asserts operation is AgentTeamProjectArchivedOperation {
    if (operation.kind !== 'team/project-archived' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.project.projectRef !== request.projectRef) this.throwRequestCollision(request.requestId)
  }

  private assertSameDm(operation: AgentTeamOperation, request: AgentTeamAuthorizedDmRequest): asserts operation is AgentTeamDmSentOperation {
    if (operation.kind !== 'team/dm-sent' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId
      || operation.data.senderMemberId !== request.actor.memberId
      || operation.data.recipientMemberId !== request.recipientMemberId
      || operation.data.body !== request.body.trim()) this.throwRequestCollision(request.requestId)
  }

  private dmResult(operation: AgentTeamDmSentOperation): AgentTeamDmResult {
    return Object.freeze({ receipt: this.receipt(operation), recipient: this.requireMember(operation.data.recipientMemberId) })
  }

  private assertSameMessage(operation: AgentTeamOperation, request: AgentTeamAuthorizedSendMessageRequest, recipients: readonly AgentTeamMemberId[]): asserts operation is AgentTeamMessageSentOperation {
    if (operation.kind !== 'team/message-sent' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.message.projectRef !== request.projectRef
      || operation.data.message.body !== request.body.trim() || !this.sameList(operation.data.mentions, recipients)
      || !this.sameList(operation.data.message.attachments?.map(attachment => attachment.attachmentId) ?? [],
        request.resolvedAttachments?.map(attachment => attachment.attachmentId) ?? [])
      || (request.asTask === true) !== (operation.data.task !== undefined)) this.throwRequestCollision(request.requestId)
  }

  private assertSameReply(operation: AgentTeamOperation, request: AgentTeamAuthorizedReplyRequest, recipients: readonly AgentTeamMemberId[]): asserts operation is AgentTeamThreadRepliedOperation {
    if (operation.kind !== 'team/thread-replied' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId
      || (request.threadRef !== undefined && operation.data.thread.threadRef !== request.threadRef)
      || (request.taskRef !== undefined && operation.data.task?.taskRef !== request.taskRef)
      || (request.threadRef === undefined && request.taskRef === undefined)
      || operation.data.message.body !== request.body.trim() || operation.data.baseRevision !== request.baseRevision
      || operation.data.message.replyToMessageRef !== request.replyToMessageRef
      || !this.sameList(operation.data.message.attachments?.map(attachment => attachment.attachmentId) ?? [],
        request.resolvedAttachments?.map(attachment => attachment.attachmentId) ?? [])
      || !this.sameList(operation.data.mentions, recipients)) this.throwRequestCollision(request.requestId)
  }

  private assertSamePromotion(operation: AgentTeamOperation, request: AgentTeamAuthorizedPromoteThreadRequest): asserts operation is AgentTeamThreadPromotedOperation {
    if (operation.kind !== 'team/thread-promoted' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId
      || operation.data.thread.threadRef !== request.threadRef
      || operation.data.baseRevision !== request.baseRevision) {
      this.throwRequestCollision(request.requestId)
    }
  }

  private assertSameClaim(operation: AgentTeamOperation, request: AgentTeamAuthorizedClaimRequest): asserts operation is AgentTeamClaimChangedOperation {
    const kind = request.action === 'claim' ? 'team/claim-created' : request.action === 'done' ? 'team/claim-done' : 'team/claim-released'
    if (operation.kind !== kind || !this.sameActor(operation.actor, request.actor) || operation.data.workspaceId !== request.workspaceId
      || operation.data.task.taskRef !== request.taskRef || operation.data.baseRevision !== request.baseRevision
      || (request.action === 'claim' ? operation.data.claim.direction !== request.direction?.trim() : operation.data.claim.claimRef !== request.claimRef)) this.throwRequestCollision(request.requestId)
  }

  private assertSameTask(operation: AgentTeamOperation, request: AgentTeamAuthorizedTaskRequest): asserts operation is AgentTeamTaskChangedOperation {
    if (operation.kind !== 'team/task-changed' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.task.taskRef !== request.taskRef
      || operation.data.baseRevision !== request.baseRevision || operation.data.activity.kind !== request.action) this.throwRequestCollision(request.requestId)
  }

  private assertSameRemoval(operation: AgentTeamOperation, request: AgentTeamAuthorizedRemoveMemberRequest): asserts operation is AgentTeamMemberRemovedOperation {
    if (operation.kind !== 'team/member-removed' || !this.sameActor(operation.actor, request.actor)
      || operation.data.member.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameArchival(operation: AgentTeamOperation, request: AgentTeamAuthorizedArchiveMemberRequest): asserts operation is AgentTeamMemberArchivedOperation {
    if (operation.kind !== 'team/member-archived' || !this.sameActor(operation.actor, request.actor)
      || operation.data.member.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameAttention(operation: AgentTeamOperation, request: AgentTeamAuthorizedThreadAttentionRequest): asserts operation is AgentTeamThreadAttentionChangedOperation {
    if (operation.kind !== 'team/thread-attention-changed' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId
      || (request.threadRef !== undefined && operation.data.thread.threadRef !== request.threadRef)
      || (request.taskRef !== undefined && operation.data.task?.taskRef !== request.taskRef)
      || (request.threadRef === undefined && request.taskRef === undefined)
      || operation.data.action !== request.action) this.throwRequestCollision(request.requestId)
  }

  private assertSameThreadRead(operation: AgentTeamOperation, request: AgentTeamAuthorizedThreadReadRequest): asserts operation is AgentTeamThreadReadOperation {
    if (operation.kind !== 'team/thread-read' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId
      || (request.threadRef !== undefined && threadReadTargetOf(operation.data).threadRef !== request.threadRef)
      || (request.taskRef !== undefined && threadReadTargetOf(operation.data).taskRef !== request.taskRef)
      || (request.threadRef === undefined && request.taskRef === undefined)) this.throwRequestCollision(request.requestId)
  }

  private sameTask(left: AgentTeamTask, right: AgentTeamTask): boolean {
    return this.sameTaskIdentity(left, right) && left.status === right.status && left.resolution === right.resolution
  }

  private sameTaskIdentity(left: AgentTeamTask, right: AgentTeamTask): boolean {
    return left.taskRef === right.taskRef && left.projectRef === right.projectRef && left.threadRef === right.threadRef
  }

  private sameClaim(left: AgentTeamClaim, right: AgentTeamClaim): boolean {
    return this.sameClaimIdentity(left, right) && left.state === right.state
  }

  private sameClaimIdentity(left: AgentTeamClaim, right: AgentTeamClaim): boolean {
    return left.claimRef === right.claimRef && left.taskRef === right.taskRef && left.threadRef === right.threadRef
      && left.owner === right.owner && left.direction === right.direction && left.normalizedDirection === right.normalizedDirection
  }

  private sameThread(left: AgentTeamThread, right: AgentTeamThread): boolean {
    return left.threadRef === right.threadRef && left.taskRef === right.taskRef && left.revision === right.revision
  }

  private sameMemberIdentity(left: AgentTeamAgentMember, right: AgentTeamAgentMember): boolean {
    return left.sessionId === right.sessionId && this.sameMemberFacts(left, right)
  }

  private sameMemberFacts(left: AgentTeamAgentMember, right: AgentTeamAgentMember): boolean {
    return left.memberId === right.memberId && left.workspaceId === right.workspaceId
      && left.handle === right.handle && left.description === right.description && left.presetId === right.presetId
      && isDeepStrictEqual(left.model ?? undefined, right.model ?? undefined)
      && left.privateMemoryPath === right.privateMemoryPath
  }

  private sameActor(left: AgentTeamActor, right: AgentTeamActor): boolean {
    if (left.kind !== right.kind || left.handle !== right.handle) return false
    if (left.kind === 'host') return true
    return right.kind !== 'host' && left.memberId === right.memberId
  }

  private sameList<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }

  private attentionKey(memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): string {
    return `${memberId}\u0000${threadRef}`
  }

  private directMarkerKey(marker: Pick<AgentTeamDirectMarker, 'memberId' | 'threadRef' | 'messageRef'> & Partial<Pick<AgentTeamDirectMarker, 'sequence'>>): string {
    return `${marker.memberId}\u0000${marker.threadRef}\u0000${marker.messageRef}`
  }

  private activityMarkerKey(marker: Pick<AgentTeamActivityMarker, 'memberId' | 'threadRef' | 'activityRef'> & Partial<Pick<AgentTeamActivityMarker, 'sequence'>>): string {
    return `${marker.memberId}\u0000${marker.threadRef}\u0000${marker.activityRef}`
  }

  private addMembership(target: Pick<Projection, 'memberships'>, projectRef: AgentTeamProjectRef, memberId: AgentTeamMemberId): void {
    const members = target.memberships.get(projectRef) ?? new Set<AgentTeamMemberId>()
    members.add(memberId)
    target.memberships.set(projectRef, members)
  }

  private addRef(refs: Set<string>, ref: string): void {
    if (refs.has(ref)) throw new Error(`agent-team ledger repeats entity ref '${ref}'`)
    refs.add(ref)
  }

  private throwRequestCollision(requestId: AgentTeamRequestId): never {
    throw new Error(`agent-team request id '${requestId}' was reused with a different operation or payload`)
  }

  private projectResult(operation: AgentTeamProjectCreatedOperation): AgentTeamCreateProjectResult {
    return Object.freeze({ receipt: this.receipt(operation), project: operation.data.project, memberIds: operation.data.memberIds })
  }

  private projectOwnerResult(operation: AgentTeamProjectOwnerAddedOperation | AgentTeamProjectOwnerRemovedOperation): AgentTeamProjectOwnerResult {
    return Object.freeze({ receipt: this.receipt(operation), projectRef: operation.data.projectRef, ownerIds: this.projectOwnerIds(operation.data.projectRef) })
  }

  private projectUpdateResult(operation: AgentTeamProjectUpdatedOperation): AgentTeamUpdateProjectResult {
    return Object.freeze({ receipt: this.receipt(operation), project: operation.data.project })
  }

  private memberResult(operation: AgentTeamMemberAddedOperation | AgentTeamMemberSuspendedOperation | AgentTeamMemberResumedOperation | AgentTeamMemberSessionRecycledOperation | AgentTeamMemberUpdatedOperation): AgentTeamDurableMemberResult {
    return Object.freeze({ receipt: this.receipt(operation), member: operation.data.member })
  }

  private joinResult(operation: AgentTeamProjectMemberAddedOperation): AgentTeamJoinProjectResult {
    return Object.freeze({ receipt: this.receipt(operation), projectRef: operation.data.projectRef, memberId: operation.data.memberId })
  }

  private projectMemberRemovalResult(operation: AgentTeamProjectMemberRemovedOperation): AgentTeamRemoveProjectMemberResult {
    return Object.freeze({ receipt: this.receipt(operation), projectRef: operation.data.projectRef, memberId: operation.data.memberId,
      releasedClaims: operation.data.claims, removedAttention: operation.data.inbox.attention.removed })
  }

  private workspaceJoinResult(operation: AgentTeamMemberWorkspaceJoinedOperation): AgentTeamJoinWorkspaceResult {
    return Object.freeze({ receipt: this.receipt(operation), memberId: operation.data.memberId, workspaceId: operation.data.workspaceId })
  }

  private workspaceLeaveResult(operation: AgentTeamMemberWorkspaceLeftOperation): AgentTeamLeaveWorkspaceResult {
    return Object.freeze({ receipt: this.receipt(operation), memberId: operation.data.memberId, workspaceId: operation.data.workspaceId,
      releasedClaims: operation.data.claims, removedAttention: operation.data.inbox.attention.removed })
  }

  private projectArchivalResult(operation: AgentTeamProjectArchivedOperation): AgentTeamArchiveProjectResult {
    return Object.freeze({ receipt: this.receipt(operation), project: operation.data.project,
      releasedClaims: operation.data.claims })
  }

  private messageResult(operation: AgentTeamMessageSentOperation): Extract<AgentTeamSendMessageResult, { kind: 'committed' }> {
    return Object.freeze(this.committedMessageResult(operation))
  }

  private replyResult(operation: AgentTeamThreadRepliedOperation, undelivered: readonly AgentTeamMemberId[] = []): Extract<AgentTeamReplyResult, { kind: 'committed' }> {
    return Object.freeze(this.committedMessageResult(operation, undelivered))
  }

  private claimResult(operation: AgentTeamClaimChangedOperation): Extract<AgentTeamClaimResult, { kind: 'committed' }> {
    const attention = operation.data.inbox.attention.set.find(candidate => candidate.memberId === operation.data.claim.owner)
    const base = { kind: 'committed' as const, receipt: this.receipt(operation), activity: operation.data.activity,
      claim: operation.data.claim, task: operation.data.task, thread: operation.data.thread }
    return attention === undefined ? Object.freeze(base) : Object.freeze({ ...base, attention })
  }

  private taskResult(operation: AgentTeamTaskChangedOperation): Extract<AgentTeamTaskResult, { kind: 'committed' }> {
    return Object.freeze({ kind: 'committed', receipt: this.receipt(operation), activity: operation.data.activity,
      task: operation.data.task, thread: operation.data.thread, claims: operation.data.claims })
  }

  private attentionResult(operation: AgentTeamThreadAttentionChangedOperation): AgentTeamThreadAttentionResult {
    return Object.freeze({ receipt: this.receipt(operation), ...(operation.data.task === undefined ? {} : { task: operation.data.task }), thread: operation.data.thread,
      ...(operation.data.inbox.attention.set[0] === undefined ? {} : { attention: operation.data.inbox.attention.set[0] }) })
  }

  private promotionResult(operation: AgentTeamThreadPromotedOperation): Extract<AgentTeamPromoteThreadResult, { kind: 'committed' }> {
    return Object.freeze({ kind: 'committed', receipt: this.receipt(operation), activity: operation.data.activity,
      task: operation.data.task, thread: operation.data.thread })
  }

  /**
   * The Thread picture a read answers with, derived from the projection the
   * read resolved against. Committed reads, no-op reads and retries all share
   * this one derivation, so a read that writes nothing still returns the same
   * Attention, facts, watermark and unread count a committed one would.
   */
  private readPicture(prepared: PreparedRead): Omit<AgentTeamThreadReadResult, 'receipt'> {
    return Object.freeze({ ...(prepared.task === undefined ? {} : { task: prepared.task }), thread: prepared.thread,
      claims: prepared.claims, anchor: prepared.anchor, anchorMentions: prepared.anchorMentions, facts: prepared.facts,
      readThroughSequence: prepared.readThroughSequence, remainingUnreadCount: prepared.remainingUnreadCount,
      earlierFactCount: prepared.earlierFactCount,
      ...(prepared.attention === undefined ? {} : { attention: prepared.attention }),
      consumedDirectMarkers: prepared.inbox.directMarkers.removed })
  }

  private receipt(operation: AgentTeamOperation): AgentTeamOperationReceipt {
    return Object.freeze({ operationId: operation.operationId, requestId: operation.requestId, sequence: operation.sequence, occurredAt: operation.occurredAt })
  }

  private removalResult(operation: AgentTeamMemberRemovedOperation): AgentTeamRemoveMemberResult {
    return Object.freeze({ receipt: this.receipt(operation), member: operation.data.member,
      releasedClaims: operation.data.claims, removedAttention: operation.data.inbox.attention.removed })
  }

  private archivalResult(operation: AgentTeamMemberArchivedOperation): AgentTeamArchiveMemberResult {
    return Object.freeze({ receipt: this.receipt(operation), member: operation.data.member,
      releasedClaims: operation.data.claims, removedAttention: operation.data.inbox.attention.removed })
  }

  private operationBase(request: { readonly requestId: AgentTeamRequestId; readonly actor: AgentTeamActor }, sequence: number) {
    return { sequence, operationId: this.createOperationId(), requestId: request.requestId, occurredAt: this.createOccurredAt(),
      actor: freezeActor(request.actor), previousOperationId: this.state.ordered.at(-1)?.operationId ?? null }
  }

  private nextSequence(): number {
    if (this.state.ordered.length === 0) throw new Error('agent-team ledger is not initialized')
    return this.state.ordered.length + 1
  }

  private ref(kind: 'project'): AgentTeamProjectRef
  private ref(kind: 'message'): AgentTeamMessageRef
  private ref(kind: 'task'): AgentTeamTaskRef
  private ref(kind: 'thread'): AgentTeamThreadRef
  private ref(kind: 'claim'): AgentTeamClaimRef
  private ref(kind: 'activity'): AgentTeamActivityRef
  private ref(kind: 'project' | 'message' | 'task' | 'thread' | 'claim' | 'activity') {
    return this.createRef(kind)
  }

  private committed<T>(value: T): AgentTeamLedgerResult<T> { return Object.freeze({ value, committed: true }) }
  private resolved<T>(value: T): AgentTeamLedgerResult<T> { return Object.freeze({ value, committed: false }) }

  private sortedRecords(): Array<[AgentTeamOperationId, AgentTeamOperation]> {
    const records = [...this.table.entries()].sort((left, right) => left[1].sequence - right[1].sequence)
    const occurrences = new Map<AgentTeamMessageRef, string>()
    const instants = new Map<number, string>()
    for (const [, operation] of records) {
      instants.set(operation.sequence, operation.occurredAt)
      if (operation.kind === 'team/message-sent' || operation.kind === 'team/thread-replied') {
        occurrences.set(operation.data.message.messageRef, operation.data.message.occurredAt ?? operation.occurredAt)
      }
    }
    // Replay against a scratch projection while normalizing, so a legacy
    // cleanup repair sees the same state its validator will.
    const projection = emptyProjection()
    return records.map(([id, operation]) => {
      const normalized = this.repairLegacyProjectCleanup(this.normalizeOperation(operation, occurrences, instants), projection)
      this.applyTo(projection, normalized)
      return [id, normalized]
    })
  }

  /**
   * Records written by releases that scoped Project archival and Project
   * member-removal inbox cleanup to taskful Threads only (the collector read
   * the Task projection) carry an incomplete inbox when the Project holds a
   * taskless Thread with Attention or markers. They are repaired in memory
   * the same way pre-envelope Thread reads are; any other inbox still fails
   * validation, so a forgery is not silently accepted.
   */
  private repairLegacyProjectCleanup(operation: AgentTeamOperation, projection: Projection): AgentTeamOperation {
    if (operation.kind === 'team/project-archived') {
      const projectRef = operation.data.project.projectRef
      const expected = this.projectArchivalInboxFrom(projection, this.projectThreadRefsFrom(projection, projectRef), projectRef)
      if (!isDeepStrictEqual(operation.data.inbox, expected)
        && isDeepStrictEqual(operation.data.inbox, this.projectArchivalInboxFrom(projection, this.legacyProjectThreadRefs(projection, projectRef), projectRef))) {
        return { ...operation, data: { ...operation.data, inbox: expected } }
      }
      return operation
    }
    if (operation.kind === 'team/project-member-removed') {
      const { projectRef, memberId } = operation.data
      const expected = this.removeMemberThreadInboxFrom(projection, memberId, this.projectThreadRefsFrom(projection, projectRef), new Set([projectRef]))
      if (!isDeepStrictEqual(operation.data.inbox, expected)
        && isDeepStrictEqual(operation.data.inbox, this.removeMemberThreadInboxFrom(projection, memberId, this.legacyProjectThreadRefs(projection, projectRef), new Set([projectRef])))) {
        return { ...operation, data: { ...operation.data, inbox: expected } }
      }
      return operation
    }
    return operation
  }

  /** The legacy Project Thread scope: only Threads carrying a Task. */
  private legacyProjectThreadRefs(projection: Projection, projectRef: AgentTeamProjectRef): Set<AgentTeamThreadRef> {
    return new Set([...projection.tasks.values()].filter(task => task.projectRef === projectRef).map(task => task.threadRef))
  }

  /**
   * Ledgers written before message occurredAt existed store bare messages;
   * snapshot-shaped Thread reads resolve instants from the originating
   * operations. A receipt-shaped read carries no message at all, so it passes
   * through untouched — the load path must never touch a shape it does not
   * have, and it never writes either form back.
   */
  private normalizeOperation(operation: AgentTeamOperation, occurrences: Map<AgentTeamMessageRef, string>, instants: Map<number, string>): AgentTeamOperation {
    if (operation.kind !== 'team/thread-read' || !isThreadReadSnapshot(operation.data)) return operation
    const data = operation.data
    const stamp = (message: AgentTeamStoredMessage): AgentTeamMessage => (
      message.occurredAt === undefined
        ? { ...message, occurredAt: occurrences.get(message.messageRef) ?? operation.occurredAt }
        : { ...message, occurredAt: message.occurredAt }
    )
    const stampEnvelope = (envelope: AgentTeamStoredThreadFact): AgentTeamThreadFact => envelope.kind === 'message'
      ? { kind: 'message', sequence: envelope.sequence, message: stamp(envelope.message), mentions: envelope.mentions,
        occurredAt: envelope.occurredAt ?? envelope.message.occurredAt ?? occurrences.get(envelope.message.messageRef) ?? operation.occurredAt }
      : { kind: 'activity', sequence: envelope.sequence, activity: envelope.activity,
        occurredAt: envelope.occurredAt ?? instants.get(envelope.sequence) ?? operation.occurredAt }
    const facts = data.facts.map((fact): AgentTeamThreadReadFact => (
      { ...fact, fact: stampEnvelope(fact.fact) }
    ))
    return { ...operation, data: { ...data, anchor: stamp(data.anchor), facts } }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => {}, () => {})
    return result
  }
}
