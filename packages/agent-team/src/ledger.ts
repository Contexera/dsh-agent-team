import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  AgentTeamActivity,
  AgentTeamActivityMarker,
  AgentTeamActivityRef,
  AgentTeamAddMemberRequest,
  AgentTeamAttachmentId,
  AgentTeamAgentMember,
  AgentTeamArchiveChannelRequest,
  AgentTeamArchiveChannelResult,
  AgentTeamArchiveMemberRequest,
  AgentTeamArchiveMemberResult,
  AgentTeamChannel,
  AgentTeamChangeScope,
  AgentTeamChannelArchivedOperation,
  AgentTeamChannelCreatedOperation,
  AgentTeamChannelMemberAddedOperation,
  AgentTeamChannelMemberRemovedOperation,
  AgentTeamChannelRef,
  AgentTeamChannelUpdatedOperation,
  AgentTeamContextCheckpointRef,
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
  AgentTeamCreateChannelRequest,
  AgentTeamCreateChannelResult,
  AgentTeamDirectMarker,
  AgentTeamDmRequest,
  AgentTeamActiveTaskThread,
  AgentTeamDmResult,
  AgentTeamDmSentOperation,
  AgentTeamHumanActor,
  AgentTeamInbox,
  AgentTeamInboxActor,
  AgentTeamInboxRequest,
  AgentTeamInboxDelta,
  AgentTeamInboxItem,
  AgentTeamInitializedOperation,
  AgentTeamJoinChannelRequest,
  AgentTeamJoinChannelResult,
  AgentTeamMemberActor,
  AgentTeamMemberAddedOperation,
  AgentTeamMemberArchivedOperation,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
  AgentTeamMemberRemovedOperation,
  AgentTeamMemberResumedOperation,
  AgentTeamMemberSessionRenewedOperation,
  AgentTeamMemberSessionRolledOverOperation,
  AgentTeamMemberSessionRestartedOperation,
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
  AgentTeamRemoveChannelMemberRequest,
  AgentTeamRemoveChannelMemberResult,
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
  AgentTeamUpdateChannelRequest,
  AgentTeamUpdateChannelResult,
  AgentTeamUpdateMemberRequest,
  AgentTeamView,
  AgentTeamViewRequest,
} from './types.ts'
import { formatTeamTimestamp } from './time-format.ts'
import { resolveBodyMentions } from './mentions.ts'
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

/** Caller-owned payload of the idempotent Team initialization request. */
export interface AgentTeamInitializeRequest {
  readonly requestId: AgentTeamRequestId
  readonly actor: AgentTeamHumanActor
  readonly humanMemberId: AgentTeamMemberId
}

export interface AgentTeamAuthorizedCreateChannelRequest extends AgentTeamCreateChannelRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedAddMemberRequest extends AgentTeamAddMemberRequest {
  readonly actor: AgentTeamHumanActor
  readonly member: AgentTeamAgentMember
}

export interface AgentTeamAuthorizedSetMemberStateRequest extends AgentTeamSetMemberStateRequest {
  readonly actor: AgentTeamHumanActor
}

/** Host-authorized intent to move one enabled Member onto a fresh Session id. */
export interface AgentTeamAuthorizedRenewMemberSessionRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
  /** The freshly minted Session the Member transitions onto. */
  readonly sessionId: SessionId
  readonly actor: AgentTeamHumanActor
}

/**
 * Member-authored intent to continue in its next private context generation.
 * The requestId and new Session id derive stably from the successful
 * `context_rollover` tool call so crash replay converges on one operation.
 */
export interface AgentTeamAuthorizedRolloverMemberSessionRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamMemberId
  /** The calling Member; must be the target Member itself. */
  readonly actor: AgentTeamMemberActor
  /** The Session the Member must still be bound to at commit time. */
  readonly previousSessionId: SessionId
  /** The next generation Session, derived from the successful tool call. */
  readonly newSessionId: SessionId
  /** Seq of the successful `context_rollover` tool result in the previous Session log. */
  readonly handoffEventSeq: SessionSeq
  /** Why the rollover happened: the model asked, or honored a pressure notice. */
  readonly trigger: 'model' | 'pressure'
  /** Seed source Session for a checkpoint return; absent on a fresh rollover. */
  readonly sourceSessionId?: SessionId
  /** Exclusive end of the seeded source prefix (its exact length in the source log). */
  readonly sourceThroughSeq?: SessionLogOffset
  /** The checkpoint a return was addressed to; absent on a fresh rollover. */
  readonly checkpointRef?: AgentTeamContextCheckpointRef
}

export interface AgentTeamAuthorizedJoinChannelRequest extends AgentTeamJoinChannelRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedRemoveChannelMemberRequest extends AgentTeamRemoveChannelMemberRequest {
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
  readonly actor: AgentTeamHumanActor
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

export interface AgentTeamAuthorizedUpdateChannelRequest extends AgentTeamUpdateChannelRequest {
  readonly actor: AgentTeamHumanActor
}

export interface AgentTeamAuthorizedArchiveChannelRequest extends AgentTeamArchiveChannelRequest {
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
  readonly ref?: (kind: 'channel' | 'message' | 'task' | 'thread' | 'claim' | 'activity') => string
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
  readonly channelRef: AgentTeamChannelRef
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
  readonly channels: Map<AgentTeamChannelRef, AgentTeamChannel>
  readonly members: Map<AgentTeamMemberId, AgentTeamAgentMember>
  /** Member ↔ Workspace participation relation: the Workspace authorization set, seeded by member-added with the Member's default Workspace. */
  readonly participations: Map<AgentTeamMemberId, Set<WorkspaceId>>
  readonly memberships: Map<AgentTeamChannelRef, Set<AgentTeamMemberId>>
  readonly claims: Map<AgentTeamClaimRef, AgentTeamClaim>
  readonly tasks: Map<AgentTeamTaskRef, AgentTeamTask>
  readonly threads: Map<AgentTeamThreadRef, AgentTeamThread>
  readonly attention: Map<string, AgentTeamThreadAttention>
  readonly directMarkers: Map<string, AgentTeamDirectMarker>
  readonly activityMarkers: Map<string, AgentTeamActivityMarker>
  /** Derived read indexes; rebuilt by replay, never a second durable authority. */
  readonly orderedFacts: AgentTeamThreadFact[]
  readonly factsByThread: Map<AgentTeamThreadRef, AgentTeamThreadFact[]>
  /** Owning Channel of each Thread, established by the anchor Message and immutable afterwards. */
  readonly channelRefByThread: Map<AgentTeamThreadRef, AgentTeamChannelRef>
  /** Structured mention refs per Message, derived from the originating send operations. */
  readonly mentionsByMessage: Map<AgentTeamMessageRef, readonly AgentTeamMemberId[]>
  readonly messageCountByThread: Map<AgentTeamThreadRef, number>
  /** Ref index over the Message facts, written by `appendMessageFact` alone. */
  readonly messagesByRef: Map<AgentTeamMessageRef, AgentTeamMessage>
  readonly attentionByThread: Map<AgentTeamThreadRef, Set<AgentTeamMemberId>>
  /** Latest retired Session id per Member, from the most recent renewal or rollover record. */
  readonly previousSessions: Map<AgentTeamMemberId, SessionId>
  /** Latest rollover seed envelope per Member, keyed to its target Session; absent on fresh rollovers and renewals. */
  readonly rolloverSeeds: Map<AgentTeamMemberId, { readonly targetSessionId: SessionId; readonly sourceSessionId: SessionId; readonly sourceThroughSeq: SessionLogOffset; readonly checkpointRef: AgentTeamContextCheckpointRef }>
  /** Top-level anchor Message per Thread; the first topLevel Message wins, like the linear scan it replaces. */
  readonly anchorByThread: Map<AgentTeamThreadRef, AgentTeamMessage>
  /** Display ordinal per Task, in per-Channel creation order; workspace filtering happens at read time. */
  readonly taskNumberByTask: Map<AgentTeamTaskRef, number>
  readonly taskCountByChannel: Map<AgentTeamChannelRef, number>
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
}

/** Minimal replay-time Attention observation; the read projection adds the current Task ref. */
interface AgentTeamAttentionObservation {
  readonly sequence: number
  readonly memberId: AgentTeamMemberId
  readonly action: 'follow' | 'unfollow'
}

function emptyProjection(): Projection {
  return { byRequest: new Map(), byOperation: new Map(), ordered: [], channels: new Map(), members: new Map(), participations: new Map(), memberships: new Map(),
    claims: new Map(), tasks: new Map(), threads: new Map(), attention: new Map(), directMarkers: new Map(), activityMarkers: new Map(),
    orderedFacts: [], factsByThread: new Map(), channelRefByThread: new Map(), mentionsByMessage: new Map(), messageCountByThread: new Map(),
    messagesByRef: new Map(),
    attentionByThread: new Map(), previousSessions: new Map(), rolloverSeeds: new Map(),
    anchorByThread: new Map(), taskNumberByTask: new Map(), taskCountByChannel: new Map(), attentionThreadsByMember: new Map(),
    threadsByWriter: new Map(),
    directMarkersByMember: new Map(), activityMarkersByMember: new Map(), observationsByThread: new Map() }
}

/** Exhaustiveness guard for the closed operation union: adding a kind must update every dispatch. */
function assertUnhandledKind(operation: never): never {
  throw new Error(`agent-team ledger does not handle operation kind '${(operation as AgentTeamOperation).kind}'`)
}

/**
 * Opening-line preview for a Human Inbox row: the Thread anchor's first line,
 * trimmed, then capped at 120 characters with an explicit mark — the same bound
 * the Thread page applies to its Task title, so the row and the page it opens
 * never disagree about what a Thread is about.
 */
function boundedInboxPreview(body: string): string {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine
}

/**
 * Chip title for a resolved Thread ref: the same opening-line gist as the
 * Inbox preview, but capped at 40 characters — a chip shares its line with
 * prose, so the 120-character row bound would crowd the message out.
 */
function boundedThreadTitle(body: string): string {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > 40 ? `${firstLine.slice(0, 39)}…` : firstLine
}

/**
 * Body gist for one quote block. Longer than a Thread title because a quote is
 * the reader's only handle on the parent Message: it must carry enough of the
 * opening line to be recognised, while still fitting one line in the bubble.
 */
function boundedReplyExcerpt(body: string): string {
  const firstLine = body.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine
}

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
}

/**
 * Which of the two durable Thread-read forms one record holds. Both schemas are
 * strict and structurally disjoint — only the pre-receipt snapshot carries the
 * Thread picture — so `thread` decides it for every stored record.
 */
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
  private readonly createRef: (kind: 'channel' | 'message' | 'task' | 'thread' | 'claim' | 'activity') => string
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
      this.apply(operation)
      return this.committed(this.receipt(operation))
    })
  }

  createChannel(request: AgentTeamAuthorizedCreateChannelRequest): Promise<AgentTeamLedgerResult<AgentTeamCreateChannelResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameChannelCreation(existing, request, this.normalizeUnique(request.memberIds, 'initial Channel members'))
        return this.resolved(this.channelResult(existing))
      }
      this.assertHumanActor(request.actor)
      const name = request.name.trim()
      const description = request.description.trim()
      if (name === '') throw new Error('channel name must not be empty')
      const memberIds = this.normalizeUnique(request.memberIds, 'initial Channel members')
      for (const memberId of memberIds) this.assertJoinableMember(request.workspaceId, memberId)
      const sequence = this.nextSequence()
      const channel: AgentTeamChannel = Object.freeze({
        channelRef: this.ref('channel'), workspaceId: request.workspaceId, name, description, createdAtSequence: sequence, state: 'active' as const,
      })
      const operation: AgentTeamChannelCreatedOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind: 'team/channel-created',
        data: Object.freeze({ workspaceId: request.workspaceId, channel, memberIds }),
      })
      await this.table.put(operation.operationId, operation)
      this.apply(operation)
      return this.committed(this.channelResult(operation))
    })
  }

  /** Human rename of one Channel's display facts; identity refs are immutable. */
  updateChannel(request: AgentTeamAuthorizedUpdateChannelRequest): Promise<AgentTeamLedgerResult<AgentTeamUpdateChannelResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameChannelUpdate(existing, request)
        return this.resolved(this.channelUpdateResult(existing))
      }
      this.assertHumanActor(request.actor)
      const name = request.name.trim()
      const description = request.description.trim()
      if (name === '') throw new Error('channel name must not be empty')
      const channel = Object.freeze({ ...this.requireActiveChannel(request.workspaceId, request.channelRef), name, description })
      const operation: AgentTeamChannelUpdatedOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/channel-updated',
        data: Object.freeze({ workspaceId: request.workspaceId, channel }),
      })
      await this.table.put(operation.operationId, operation)
      this.apply(operation)
      return this.committed(this.channelUpdateResult(operation))
    })
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
      // Description and initial Channels are optional: a Member with neither is
      // still drivable through its DM view, and joins Channels later.
      const channelRefs = this.normalizeUnique(request.channelRefs, 'initial Member Channels')
      for (const channelRef of channelRefs) this.requireActiveChannel(request.workspaceId, channelRef)
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
        data: Object.freeze({ member, channelRefs }),
      })
      await this.table.put(operation.operationId, operation)
      this.apply(operation)
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
      // An absent model or capabilities field must CLEAR any override
      // (inherit the Host default / full standard capability surface);
      // spreading `prior` verbatim would silently keep the pinned value.
      const { model: _priorModel, capabilities: _priorCapabilities, ...priorWithoutOverlays } = prior
      const member = Object.freeze({
        ...priorWithoutOverlays, handle, description,
        ...(request.model === undefined ? {} : { model: Object.freeze({ ...request.model }) }),
        ...freezeCapabilities(request.capabilities),
      })
      const operation: AgentTeamMemberUpdatedOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/member-updated',
        data: Object.freeze({ member }),
      })
      await this.table.put(operation.operationId, operation)
      this.apply(operation)
      return this.committed(this.memberResult(operation))
    })
  }

  suspendMember(request: AgentTeamAuthorizedSetMemberStateRequest): Promise<AgentTeamLedgerResult<AgentTeamDurableMemberResult>> {
    return this.setMemberState(request, 'suspended')
  }

  resumeMember(request: AgentTeamAuthorizedSetMemberStateRequest): Promise<AgentTeamLedgerResult<AgentTeamDurableMemberResult>> {
    return this.setMemberState(request, 'enabled')
  }

  /**
   * Move one enabled Member onto a fresh Session: the durable operation
   * records the sessionId transition while identity, memory, and binding
   * survive. The Host disposes the old handle and archives the previous
   * Session log around this write, so the next turn starts empty.
   */
  renewMemberSession(request: AgentTeamAuthorizedRenewMemberSessionRequest): Promise<AgentTeamLedgerResult<AgentTeamDurableMemberResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameMemberSessionRenewed(existing, request)
        return this.resolved(this.memberResult(existing))
      }
      this.assertHumanActor(request.actor)
      const prior = this.requireMember(request.memberId)
      if (prior.state !== 'enabled') throw new Error(`Agent Member '${prior.handle}' is ${prior.state}; only enabled Members can start from a new context`)
      if (prior.sessionId === request.sessionId) throw new Error(`Agent Member '${prior.handle}' already runs Session '${request.sessionId}'`)
      const member = Object.freeze({ ...prior, sessionId: request.sessionId })
      const operation: AgentTeamMemberSessionRenewedOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/member-session-renewed',
        data: Object.freeze({ member, previousSessionId: prior.sessionId }),
      })
      await this.table.put(operation.operationId, operation)
      this.apply(operation)
      return this.committed(this.memberResult(operation))
    })
  }

  /**
   * Move one enabled Member onto its next context generation as itself. The
   * actor is the calling Member — the Host executes the transition but is
   * never the business actor — and the durable data records only the
   * verifiable envelope (previous/new Session anchors, the successful handoff
   * tool-result seq, checkpoint seed lineage, trigger). The private handoff
   * prose stays in the Member's own Session log. An exact retry resolves to
   * the recorded outcome; the same requestId with different data collides.
   */
  rolloverMemberSession(request: AgentTeamAuthorizedRolloverMemberSessionRequest): Promise<AgentTeamLedgerResult<AgentTeamDurableMemberResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameMemberSessionRolledOver(existing, request)
        return this.resolved(this.memberResult(existing))
      }
      if (request.actor.kind !== 'member') throw new Error('Member session rollover requires Member authority')
      const prior = this.requireMember(request.memberId)
      if (request.actor.memberId !== request.memberId) throw new Error(`Agent Member '${prior.handle}' cannot roll over another Member's Session`)
      if (prior.state !== 'enabled') throw new Error(`Agent Member '${prior.handle}' is ${prior.state}; only enabled Members can roll over their Session`)
      if (prior.sessionId === request.newSessionId) throw new Error(`Agent Member '${prior.handle}' already runs Session '${request.newSessionId}'`)
      if (prior.sessionId !== request.previousSessionId) throw new Error(`Agent Member '${prior.handle}' is no longer bound to Session '${request.previousSessionId}'`)
      if ((request.checkpointRef !== undefined) !== (request.sourceSessionId !== undefined)) throw new Error('rollover checkpoint fields must appear together')
      if (request.sourceSessionId !== undefined && request.sourceThroughSeq === undefined) throw new Error('rollover checkpoint seed requires a through sequence')
      if (request.sourceThroughSeq !== undefined && request.sourceSessionId === undefined) throw new Error('rollover through sequence requires a source Session')
      const member = Object.freeze({ ...prior, sessionId: request.newSessionId })
      const operation: AgentTeamMemberSessionRolledOverOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/member-session-rolled-over',
        data: Object.freeze({
          member,
          previousSessionId: request.previousSessionId,
          newSessionId: request.newSessionId,
          handoffEventSeq: request.handoffEventSeq,
          trigger: request.trigger,
          ...(request.sourceSessionId === undefined ? {} : { sourceSessionId: request.sourceSessionId }),
          ...(request.sourceThroughSeq === undefined ? {} : { sourceThroughSeq: request.sourceThroughSeq }),
          ...(request.checkpointRef === undefined ? {} : { checkpointRef: request.checkpointRef }),
        }),
      })
      await this.table.put(operation.operationId, operation)
      this.apply(operation)
      return this.committed(this.memberResult(operation))
    })
  }

  getMember(memberId: AgentTeamMemberId): AgentTeamAgentMember | undefined {
    return this.state.members.get(memberId)
  }

  /**
   * The retired Session this Member most recently left through a renewal or
   * rollover — the lineage parent a crash between the durable binding commit
   * and the new Session's activation must reconstruct a handoff from. Read
   * from the audit projection; the Member record itself only names the
   * current Session.
   */
  previousSessionForMember(memberId: AgentTeamMemberId): SessionId | undefined {
    return this.state.previousSessions.get(memberId)
  }

  /**
   * The latest session transition this Member committed: the retired Session
   * and the target it moved onto, through either a renewal or a rollover.
   * Crash recovery binds carried-input redelivery to the recorded target —
   * the CURRENT Session being that target proves the old generation's
   * unconsumed input still belongs here, regardless of whether the handoff
   * itself already landed.
   */
  lastTransitionForMember(memberId: AgentTeamMemberId): { readonly previousSessionId: SessionId; readonly targetSessionId: SessionId } | undefined {
    const previousSessionId = this.state.previousSessions.get(memberId)
    const member = this.state.members.get(memberId)
    if (previousSessionId === undefined || member === undefined) return undefined
    return { previousSessionId, targetSessionId: member.sessionId }
  }

  /**
   * The Thread a Task overlay lives on, or undefined for an unknown or
   * archived-Channel Task. Read-only input for attributing claim-mutation
   * boundaries to the Thread whose context they entered.
   */
  threadForTask(taskRef: AgentTeamTaskRef): AgentTeamThreadRef | undefined {
    const task = this.state.tasks.get(taskRef)
    if (task === undefined) return undefined
    return this.state.channels.get(task.channelRef)?.state === 'archived' ? undefined : task.threadRef
  }

  /**
   * The seed envelope of this Member's most recent rollover, when that
   * rollover was a checkpoint return: the recorded source Session, the
   * exclusive end of its seeded prefix, and the checkpoint ref. A fresh
   * rollover clears the envelope. Crash recovery reads this to rebuild the
   * child generation from the recorded seed instead of an empty context.
   */
  rolloverSeedForMember(memberId: AgentTeamMemberId, targetSessionId: SessionId): { readonly sourceSessionId: SessionId; readonly sourceThroughSeq: SessionLogOffset; readonly checkpointRef: AgentTeamContextCheckpointRef } | undefined {
    const seed = this.state.rolloverSeeds.get(memberId)
    // Bind the envelope to its recorded target: a later renewal or fresh
    // rollover that reused or replaced the binding must never consume an
    // older generation's seed.
    return seed?.targetSessionId === targetSessionId ? seed : undefined
  }

  /**
   * Count one Member's active Claims on open Tasks in active Channels — the
   * read-only input to the checkpoint single-Thread coverage guard: with
   * more than one, a rewind cannot be proven to stay inside one Thread.
   */
  activeClaimCountForMember(memberId: AgentTeamMemberId): number {
    return this.activeClaimsForMember(memberId).length
  }

  /**
   * One Member's active Claims on open Tasks in active Channels, oldest
   * first — the read-only input for the pressure notice's Claim labels.
   */
  activeClaimsForMember(memberId: AgentTeamMemberId): readonly AgentTeamClaim[] {
    const active: AgentTeamClaim[] = []
    for (const claim of this.state.claims.values()) {
      if (claim.owner !== memberId || claim.state !== 'active') continue
      const task = this.state.tasks.get(claim.taskRef)
      if (task === undefined || task.resolution !== 'open') continue
      if (this.state.channels.get(task.channelRef)?.state === 'archived') continue
      active.push(claim)
    }
    return active.sort((a, b) => a.claimRef.localeCompare(b.claimRef))
  }

  listMembers(): readonly AgentTeamAgentMember[] {
    return Object.freeze([...this.state.members.values()])
  }

  joinChannel(request: AgentTeamAuthorizedJoinChannelRequest): Promise<AgentTeamLedgerResult<AgentTeamJoinChannelResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameChannelJoin(existing, request)
        return this.resolved(this.joinResult(existing))
      }
      this.assertHumanActor(request.actor)
      const channel = this.requireActiveChannel(request.workspaceId, request.channelRef)
      const member = this.requireMember(request.memberId)
      if (!this.participatesIn(member.memberId, request.workspaceId)) throw new Error('Agent Member does not participate in the Channel\'s Workspace')
      if (member.state !== 'enabled') throw new Error(`Agent Member '${member.memberId}' is ${member.state}; only enabled Members can join a Channel`)
      if (this.isChannelMember(channel.channelRef, member.memberId)) throw new Error(`Agent Member '${member.memberId}' already belongs to Channel '${channel.channelRef}'`)
      const operation: AgentTeamChannelMemberAddedOperation = Object.freeze({
        ...this.operationBase(request, this.nextSequence()), kind: 'team/channel-member-added',
        data: Object.freeze({ workspaceId: request.workspaceId, channelRef: channel.channelRef, memberId: member.memberId }),
      })
      await this.table.put(operation.operationId, operation)
      this.apply(operation)
      return this.committed(this.joinResult(operation))
    })
  }

  removeChannelMember(
    request: AgentTeamAuthorizedRemoveChannelMemberRequest,
  ): Promise<AgentTeamLedgerResult<AgentTeamRemoveChannelMemberResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameChannelMemberRemoval(existing, request)
        return this.resolved(this.channelMemberRemovalResult(existing))
      }
      this.assertHumanActor(request.actor)
      const channel = this.requireChannel(request.workspaceId, request.channelRef)
      const member = this.requireMember(request.memberId)
      if (!this.participatesIn(member.memberId, channel.workspaceId) || !this.isChannelMember(channel.channelRef, member.memberId)) {
        throw new Error(`Agent Member '${member.memberId}' is not a member of Channel '${channel.channelRef}'`)
      }
      const threadRefs = this.channelThreadRefs(channel.channelRef)
      const releasedClaims = [...this.state.claims.values()]
        .filter(claim => claim.owner === member.memberId && claim.state === 'active' && threadRefs.has(claim.threadRef))
        .map(claim => Object.freeze({ ...claim, state: 'released' as const }))
      const nextClaims = new Map(this.state.claims)
      for (const claim of releasedClaims) nextClaims.set(claim.claimRef, claim)
      const sequence = this.nextSequence()
      const activities = this.releaseSummaries(releasedClaims, member.memberId, sequence)
      const threads = this.threadsForActivities(activities)
      const tasks = this.tasksForClaims(releasedClaims, nextClaims)
      const inbox = this.removeMemberThreadInbox(member.memberId, threadRefs)
      const operation: AgentTeamChannelMemberRemovedOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind: 'team/channel-member-removed',
        data: Object.freeze({ workspaceId: request.workspaceId, channelRef: channel.channelRef, memberId: member.memberId,
          claims: Object.freeze(releasedClaims), activities, tasks, threads, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.apply(operation)
      return this.committed(this.channelMemberRemovalResult(operation))
    })
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
      this.apply(operation)
      return this.committed(this.workspaceJoinResult(operation))
    })
  }

  /**
   * Withdraw one Agent Member from one of its non-default Workspaces. The
   * default Workspace cannot be left — ending it is the archive path. Every
   * active Claim the Member holds on the Workspace's Threads releases with
   * public Activities, its Attention and markers on those Threads clear, and
   * its Channel memberships there end; identity, Session, and remaining
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
      const inbox = this.removeMemberThreadInbox(member.memberId, threadRefs)
      const operation: AgentTeamMemberWorkspaceLeftOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind: 'team/member-workspace-left',
        data: Object.freeze({ workspaceId: request.workspaceId, memberId: member.memberId,
          claims: Object.freeze(releasedClaims), activities, tasks, threads, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.apply(operation)
      return this.committed(this.workspaceLeaveResult(operation))
    })
  }

  /**
   * Archive one Channel: hidden from every surface, facts kept recoverable.
   * Every active Claim on the Channel's Threads releases with one public
   * Activity per (owner, Thread), and every Member's Attention and markers
   * for those Threads clear — a hidden Channel must not leave Tasks stuck in
   * progress behind it or phantom unread counts.
   */
  archiveChannel(request: AgentTeamAuthorizedArchiveChannelRequest): Promise<AgentTeamLedgerResult<AgentTeamArchiveChannelResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameChannelArchival(existing, request)
        return this.resolved(this.channelArchivalResult(existing))
      }
      this.assertHumanActor(request.actor)
      const channel = this.requireChannel(request.workspaceId, request.channelRef)
      if (channel.state === 'archived') throw new Error(`Channel '${channel.channelRef}' is already archived`)
      const nextChannel = Object.freeze({ ...channel, state: 'archived' as const })
      const threadRefs = this.channelThreadRefs(channel.channelRef)
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
      const inbox = this.channelArchivalInbox(threadRefs)
      const operation: AgentTeamChannelArchivedOperation = Object.freeze({
        ...this.operationBase(request, sequence), kind: 'team/channel-archived',
        data: Object.freeze({ workspaceId: request.workspaceId, channel: nextChannel,
          claims: Object.freeze(releasedClaims), activities, tasks, threads, inbox }),
      })
      await this.table.put(operation.operationId, operation)
      this.apply(operation)
      return this.committed(this.channelArchivalResult(operation))
    })
  }

  sendMessage(request: AgentTeamAuthorizedSendMessageRequest): Promise<AgentTeamLedgerResult<AgentTeamSendMessageResult>> {
    return this.enqueue(async () => {
      const actor = this.assertActorForWorkspace(request.actor, request.workspaceId)
      const channel = this.requireActiveChannel(request.workspaceId, request.channelRef)
      if (actor.kind === 'member') this.requireMemberChannel(this.requireMember(actor.memberId), channel.channelRef)
      const body = request.body.trim()
      if (body === '') throw new Error('message body must not be empty')
      // Recipients are resolved before the request-id lookup: the stored
      // operation carries the merged set, so a retry has to re-derive the same
      // list for the collision check to prove it is the same request.
      const recipients = this.mergeBodyMentions(actor.memberId, channel.channelRef, body, this.normalizeRecipients(request.actor, request.recipients))
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameMessage(existing, request, recipients)
        return this.resolved(this.messageResult(existing))
      }
      this.assertMentionTargets(channel, recipients)
      // Top-level Task creation is open to every actor: mentioned Members join
      // the new Thread as followers. Only existing-Thread invitations stay
      // Human-gated (reply path).
      const sequence = this.nextSequence()
      const base = this.operationBase(request, sequence)
      const asTask = request.asTask !== false
      const threadRef = this.ref('thread')
      const taskRef = asTask ? this.ref('task') : undefined
      const task = taskRef === undefined ? undefined
        : Object.freeze({ taskRef, channelRef: channel.channelRef, threadRef, status: 'todo' as const, resolution: 'open' as const })
      const thread: AgentTeamThread = Object.freeze({ threadRef, ...(taskRef === undefined ? {} : { taskRef }), revision: sequence })
      const message: AgentTeamMessage = Object.freeze({
        messageRef: this.ref('message'), channelRef: channel.channelRef, threadRef, ...(taskRef === undefined ? {} : { taskRef }),
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
      this.apply(operation)
      return this.committed(this.messageResult(operation))
    })
  }

  reply(request: AgentTeamAuthorizedReplyRequest): Promise<AgentTeamLedgerResult<AgentTeamReplyResult>> {
    return this.enqueue(async () => {
      const actor = this.assertActorForWorkspace(request.actor, request.workspaceId)
      const { task, thread, channelRef } = this.threadContextForActor(actor, request.workspaceId, request)
      const body = request.body.trim()
      if (body === '') throw new Error('message body must not be empty')
      const channel = this.requireChannel(request.workspaceId, channelRef)
      const parent = this.requireReplyParent(request, thread.threadRef)
      const explicit = this.normalizeRecipients(actor, request.recipients)
      // Answering a Member delivers to them the way a mention does: a reply the
      // recipient never learns about is not a reply. The Human is skipped — they
      // read the Thread directly and hold no session to deliver to — as is the
      // author's own Message, which `normalizeRecipients` refuses outright.
      const answered = parent === undefined || parent.sender === actor.memberId || parent.sender === AGENT_TEAM_HUMAN_MEMBER_ID
        ? explicit
        : [...new Set([...explicit, parent.sender])].sort()
      const recipients = this.mergeBodyMentions(actor.memberId, channelRef, body, answered)
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSameReply(existing, request, recipients)
        return this.resolved(this.replyResult(existing, this.undeliverableRecipients(actor, thread.threadRef, recipients)))
      }
      this.assertMentionTargets(channel, recipients)
      const deferred = this.deferredThreadWrite(actor.memberId, task, thread, request.baseRevision)
      if (deferred !== undefined) return this.resolved(deferred)
      if (task?.resolution === 'closed') throw new Error(`Task '${task.taskRef}' is closed; reopen it before replying`)
      // An Agent cannot invite into an existing Thread, so a body mention the
      // Thread has never carried is dropped and reported back rather than
      // failing the send. The Human keeps the confirmation step, which is what
      // actually grants the invitation.
      const undelivered = this.undeliverableRecipients(actor, thread.threadRef, recipients)
      const delivered = undelivered.length === 0 ? recipients : recipients.filter(memberId => !undelivered.includes(memberId))
      const unfollowedAgents = delivered.filter(memberId => this.state.members.has(memberId) && !this.isFollowing(thread.threadRef, memberId))
      // A Member that once took part in this Thread is delivered to directly:
      // re-joining a Thread it already belongs to is not an invitation.
      if (unfollowedAgents.length > 0 && actor.kind === 'human' && request.confirmationToken === undefined) {
        return this.resolved(this.issueConfirmation(request.actor, request.workspaceId, channelRef, body, delivered, task, thread))
      }
      if (request.confirmationToken !== undefined) {
        this.consumeConfirmation(request.confirmationToken, request.actor, request.workspaceId, channelRef,
          task, thread, body, delivered)
      }
      const sequence = this.nextSequence()
      const base = this.operationBase(request, sequence)
      const message: AgentTeamMessage = Object.freeze({
        messageRef: this.ref('message'), channelRef, threadRef: thread.threadRef,
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
      this.apply(operation)
      return this.committed(this.replyResult(operation, undelivered))
    })
  }

  promoteThread(request: AgentTeamAuthorizedPromoteThreadRequest): Promise<AgentTeamLedgerResult<AgentTeamPromoteThreadResult>> {
    return this.enqueue(async () => {
      const existing = this.state.byRequest.get(request.requestId)
      if (existing !== undefined) {
        this.assertSamePromotion(existing, request)
        return this.resolved(this.promotionResult(existing))
      }
      this.assertHumanActor(request.actor)
      const { task: existingTask, thread, channelRef } = this.threadContextForActor(request.actor, request.workspaceId, request)
      if (existingTask !== undefined) throw new Error(`Thread '${thread.threadRef}' already has Task '${existingTask.taskRef}'`)
      const deferred = this.deferredThreadWrite(request.actor.memberId, undefined, thread, request.baseRevision)
      if (deferred !== undefined) return this.resolved(deferred)
      const sequence = this.nextSequence()
      const base = this.operationBase(request, sequence)
      const taskRef = this.ref('task')
      const task: AgentTeamTask = Object.freeze({ taskRef, channelRef, threadRef: thread.threadRef, status: 'todo', resolution: 'open' })
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
      this.apply(operation)
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
        if ([...this.state.claims.values()].some(candidate => candidate.taskRef === task.taskRef
          && candidate.state === 'active' && candidate.normalizedDirection === normalizedDirection)) {
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
          throw new Error('Member can modify only its own Claim on this Task')
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
      this.apply(operation)
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
      const priorActiveClaims = [...this.state.claims.values()].filter(claim => claim.taskRef === task.taskRef && claim.state === 'active')
      if (request.action === 'accept' && task.status === 'in_progress' && priorActiveClaims.length === 0) {
        throw new Error(`Task '${task.taskRef}' has no active Claims to complete for early acceptance`)
      }
      if (request.action === 'reopen' && task.resolution === 'open') throw new Error(`Task '${task.taskRef}' is already open`)
      const sequence = this.nextSequence()
      const claims = [...this.state.claims.values()].filter(claim => claim.taskRef === task.taskRef).map(claim =>
        request.action === 'close' && claim.state === 'active' ? Object.freeze({ ...claim, state: 'released' as const })
          : request.action === 'accept' && claim.state === 'active' ? Object.freeze({ ...claim, state: 'done' as const })
            : claim)
      const releasedClaims = claims.filter(claim => claim.state === 'released' && this.state.claims.get(claim.claimRef)?.state === 'active')
      const completedClaims = claims.filter(claim => claim.state === 'done' && this.state.claims.get(claim.claimRef)?.state === 'active')
      // Every done Claim at commit time — pre-finished and atomically
      // completed alike — is the acceptance discriminator: the one list
      // accept markers deliver from, so a normal accept no longer stays
      // silent about the Members whose work it accepted. Sorted lexically
      // so replay validation compares stably regardless of claim-ref
      // generation order.
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
      this.apply(operation)
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
      this.apply(operation)
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
      this.apply(operation)
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
        this.apply(operation)
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
      this.apply(operation)
      return this.committed(this.attentionResult(operation))
    })
  }

  /**
   * Append one Member-to-Member direct message as an audit-only operation.
   * A DM is pure delivery: no Channel, Thread, revision, attention, or
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
      this.apply(operation)
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
      const pair = operation.data.senderMemberId === sender.memberId && operation.data.recipientMemberId === recipientMemberId
      const mirror = operation.data.senderMemberId === recipientMemberId && operation.data.recipientMemberId === sender.memberId
      if (!pair && !mirror) continue
      // pair: the other Member sent it to the reader → (them → you);
      // mirror: the reader sent it to the other Member → (you → them).
      const direction = pair ? 'them → you' : 'you → them'
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
    // One unread slice serves every reader: Threads the reader follows or
    // holds a marker on, admitted whenever they hold an unread fact — mentions
    // are counted inside it (`directCount`), never a separate admission rule.
    // Every row carries its rendering material — Channel display name, Task
    // ordinal, opening line, and the person the row's instant came from — so the
    // Client renders a row without a Channel or Member view per row. Carrying
    // the opening line on the agent-facing projection is
    // safe: model-visible notifications read the refs and the facts, never this.
    // A Human reader additionally receives the separate 「最近活跃」 slice below;
    // `items` stays exactly the unread queue for every reader, so the badge
    // totals and the agent-facing `team_inbox` result cannot drift with it.
    const taskNumbers = new Map(workspaceIds.flatMap(workspaceId => [...this.taskNumbers(workspaceId)]))
    const items: AgentTeamInboxItem[] = []
    const unreadThreads = new Set<AgentTeamThreadRef>()
    for (const threadRef of this.inboxCandidateThreads(authorized.memberId)) {
      const thread = this.state.threads.get(threadRef)
      if (thread === undefined) continue
      const channelRef = this.channelRefForThread(thread.threadRef)
      if (channelRef === undefined) continue
      const channel = this.state.channels.get(channelRef)
      if (channel === undefined || !workspaceIds.includes(channel.workspaceId)) continue
      // Archived Channels do not exist on Team API surfaces: their Threads
      // reach neither Inbox slice, matching ref resolution and the feed.
      if (channel.state === 'archived') continue
      const workspaceId = channel.workspaceId
      if (authorized.kind === 'member' && !this.isChannelMember(channelRef, authorized.memberId)) continue
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
      items.push(Object.freeze({ workspaceId, channelRef,
        channelName: this.state.channels.get(channelRef)?.name ?? '',
        ...(task === undefined ? {} : { task }), ...(taskNumber === undefined ? {} : { taskNumber }), thread,
        unreadCount: unread.length, directCount,
        previewText: boundedInboxPreview(this.threadAnchor(thread.threadRef).body),
        newestSequence: newest.sequence, newestOccurredAt: newest.occurredAt,
        newestActor: this.inboxActorFor(newest), claimOwners: this.liveClaimOwners(task),
        ...(attention === undefined ? {} : { attention }) }))
    }
    items.sort((left, right) => right.directCount - left.directCount || right.newestSequence - left.newestSequence || left.thread.threadRef.localeCompare(right.thread.threadRef))
    const selected = items.slice(0, limit)
    const recent = authorized.kind === 'human'
      ? this.recentInboxItems(authorized.memberId, workspaceIds[0]!, unreadThreads, taskNumbers)
      : Object.freeze([] as AgentTeamInboxItem[])
    return Object.freeze({ humanMemberId: this.initialization().data.humanMemberId,
      items: Object.freeze(selected), recent,
      totalUnreadCount: items.reduce((sum, item) => sum + item.unreadCount, 0),
      totalDirectCount: items.reduce((sum, item) => sum + item.directCount, 0) })
  }

  /**
   * The one person a row names: whoever committed the fact that row's instant
   * came from — a Message's sender, an activity's actor — resolved to the handle
   * the row draws. Resolving it here is what spares every Client row a Member
   * view of its own, and a Member the roster no longer names still reads as
   * themselves through their raw id rather than as nobody.
   */
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
   * presence — deliberately the same rule the Channel feed applies to the same
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
   * The Human Inbox's 「最近活跃」 slice: the Threads this reader has written in
   * — the durable way back into work instead of a mention-only queue.
   * Participation is the whole admission rule: a reader who replied to somebody
   * else's Thread is here whether or not they follow it, and so is one who
   * started a Thread nobody has answered yet, because starting one is writing
   * its anchor. Attention deliberately plays no part — it decides what notifies
   * a reader (a reply does not implicitly follow a Thread), and reading it here
   * as well is what once hid every Thread a reader had replied to without
   * following. A Thread the reader later unfollowed stays: they did take part
   * in it, and unfollowing stops the notifications, not the record. Every
   * Thread still holding unread is excluded because the queue above already
   * carries it, and the slice is newest-activity first, bounded by
   * `RECENT_INBOX_LIMIT`. Rows are the same shape as unread rows with every
   * count at zero — they are the same row to render.
   */
  private recentInboxItems(memberId: AgentTeamMemberId, workspaceId: WorkspaceId,
    unreadThreads: ReadonlySet<AgentTeamThreadRef>, taskNumbers: ReadonlyMap<AgentTeamTaskRef, number>): readonly AgentTeamInboxItem[] {
    const recent: AgentTeamInboxItem[] = []
    for (const threadRef of this.state.threadsByWriter.get(memberId) ?? []) {
      if (unreadThreads.has(threadRef)) continue
      const thread = this.state.threads.get(threadRef)
      if (thread === undefined) continue
      const channelRef = this.channelRefForThread(thread.threadRef)
      if (channelRef === undefined) continue
      const channel = this.state.channels.get(channelRef)
      if (channel === undefined || channel.workspaceId !== workspaceId) continue
      // Archived Channels do not exist on Team API surfaces, so their Threads
      // are no way back into work either — participation ends at archival.
      if (channel.state === 'archived') continue
      const facts = this.state.factsByThread.get(thread.threadRef) ?? []
      const newest = facts.at(-1)
      if (newest === undefined) continue
      const task = thread.taskRef === undefined ? undefined : this.state.tasks.get(thread.taskRef)
      const taskNumber = task === undefined ? undefined : taskNumbers.get(task.taskRef)
      recent.push(Object.freeze({ workspaceId, channelRef,
        channelName: this.state.channels.get(channelRef)?.name ?? '',
        ...(task === undefined ? {} : { task }), ...(taskNumber === undefined ? {} : { taskNumber }), thread,
        unreadCount: 0, directCount: 0,
        previewText: boundedInboxPreview(this.threadAnchor(thread.threadRef).body),
        newestSequence: newest.sequence, newestOccurredAt: newest.occurredAt,
        newestActor: this.inboxActorFor(newest), claimOwners: this.liveClaimOwners(task) }))
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
        // A retry reports the original receipt with the picture the current
        // projection derives, and never advances a watermark a second time.
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
      this.apply(operation)
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
    const observations = (this.state.observationsByThread.get(threadRef) ?? []).slice(-limit)
      .map(event => Object.freeze({ sequence: event.sequence, threadRef, ...(task === undefined ? {} : { taskRef: task.taskRef }),
        memberId: event.memberId, action: event.action }))
    return Object.freeze({ items: Object.freeze(observations), followers: Object.freeze([...this.state.attentionByThread.get(threadRef) ?? []]) })
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
      const channelRef = thread === undefined ? undefined : this.channelRefForThread(thread.threadRef)
      const channel = channelRef === undefined ? undefined : this.state.channels.get(channelRef)
      // Same archival rule as tasks: archived Channels do not exist on Team
      // API surfaces, so their Threads stop resolving and message bodies
      // render the refs as plain non-navigable text.
      if (thread === undefined || channelRef === undefined || channel?.workspaceId !== workspaceId || channel?.state === 'archived') continue
      const task = thread.taskRef === undefined ? undefined : this.state.tasks.get(thread.taskRef)
      resolved.push(Object.freeze({
        threadRef: thread.threadRef,
        channelRef,
        ...(task === undefined ? {} : { taskRef: task.taskRef, taskNumber: numbers.get(task.taskRef) ?? 0 }),
        title: boundedThreadTitle(this.threadAnchor(thread.threadRef).body),
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
      const message = this.state.messagesByRef.get(messageRef)
      if (message === undefined) continue
      // Archived Channels stop existing on Team API surfaces, exactly as they
      // do for Task and Thread refs, so their Messages stop resolving too.
      const channel = this.state.channels.get(message.channelRef)
      if (channel?.workspaceId !== workspaceId || channel.state === 'archived') continue
      resolved.push(Object.freeze({
        messageRef: message.messageRef,
        threadRef: message.threadRef,
        sender: message.sender,
        excerpt: boundedReplyExcerpt(message.body),
      }))
    }
    return resolved
  }

  /**
   * Read one Message back verbatim, inside the Thread that carries it.
   *
   * Authorization comes first and comes from the Thread: a reader must be able
   * to address the Thread at all, which is where membership and Channel
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
    // Addressing the Thread is the authorization: unknown, foreign, and
    // archived all refuse here, and refuse distinguishably.
    const context = this.threadContextForActor(actor, request.workspaceId, { threadRef: request.threadRef })
    const message = this.state.messagesByRef.get(request.messageRef)
    if (message === undefined) throw new Error(`Message '${request.messageRef}' is not a recorded Message`)
    if (message.threadRef !== context.thread.threadRef) throw new Error(`Message '${request.messageRef}' belongs to another Thread`)
    return Object.freeze({
      messageRef: message.messageRef,
      threadRef: message.threadRef,
      channelRef: context.channelRef,
      sender: message.sender,
      sequence: message.sequence,
      ...(message.occurredAt === undefined ? {} : { occurredAt: message.occurredAt }),
      body: message.body,
    })
  }

  /** Navigation facts for message-body Task refs; unknown refs are omitted. */
  resolveTaskRefs(workspaceId: WorkspaceId, taskRefs: readonly AgentTeamTaskRef[]): AgentTeamResolvedTaskRef[] {
    const numbers = this.taskNumbers(workspaceId)
    const resolved: AgentTeamResolvedTaskRef[] = []
    for (const taskRef of taskRefs) {
      const key = this.uniqueRefKey(this.state.tasks, taskRef, 'task')
      const task = key === undefined ? undefined : this.state.tasks.get(key)
      const channel = task === undefined ? undefined : this.state.channels.get(task.channelRef)
      // Archived Channels do not exist on Team API surfaces: their Tasks stop
      // resolving, so live message bodies render the refs as plain
      // non-navigable text through the existing unknown-ref path.
      if (task === undefined || channel?.workspaceId !== workspaceId || channel?.state === 'archived') continue
      resolved.push(Object.freeze({ taskRef: task.taskRef, channelRef: task.channelRef, threadRef: task.threadRef, taskNumber: numbers.get(task.taskRef) ?? 0 }))
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
    // Validation above accepts unique UUID abbreviations, so resolve both
    // filters to full keys once: comparing the authored spelling in the fact
    // filters below matches nothing and returns an empty view that every
    // caller reads as "no such thread" (task #17).
    const channelRefFilter = request.channelRef === undefined
      ? undefined
      : this.requireActiveChannel(request.workspaceId, request.channelRef).channelRef
    if (channelRefFilter !== undefined) {
      if (memberId !== undefined && !this.isChannelMember(channelRefFilter, memberId)) throw new Error(`Agent Member '${memberId}' is not authorized for Channel '${request.channelRef}'`)
    }
    let threadRefFilter: AgentTeamThreadRef | undefined
    if (request.threadRef !== undefined) {
      const thread = this.requireThread(request.threadRef)
      threadRefFilter = thread.threadRef
      const channelRef = this.channelRefForThread(thread.threadRef)
      if (channelRef === undefined) throw new Error(`unknown Thread ref '${request.threadRef}'`)
      if (this.state.channels.get(channelRef)?.workspaceId !== request.workspaceId) throw new Error(`Thread '${request.threadRef}' does not belong to Workspace '${request.workspaceId}'`)
      this.assertThreadChannelActive(channelRef)
      if (channelRefFilter !== undefined && channelRef !== channelRefFilter) throw new Error(`Thread '${request.threadRef}' does not belong to Channel '${request.channelRef}'`)
      if (memberId !== undefined && !this.isChannelMember(channelRef, memberId)) throw new Error(`Agent Member '${memberId}' is not authorized for Channel '${channelRef}'`)
    }
    const channels = [...this.state.channels.values()].filter(channel => channel.workspaceId === request.workspaceId
      && channel.state !== 'archived'
      && (memberId === undefined || this.isChannelMember(channel.channelRef, memberId)))
    const channelRefs = new Set(channels.map(channel => channel.channelRef))
    const before = request.cursor ?? this.state.ordered.length + 1
    const matches = (fact: AgentTeamThreadFact): boolean => {
      const threadRef = fact.kind === 'message' ? fact.message.threadRef : fact.activity.threadRef
      const channelRef = this.channelRefForThread(threadRef)
      if (channelRef === undefined || !channelRefs.has(channelRef)) return false
      if (channelRefFilter !== undefined && channelRef !== channelRefFilter) return false
      if (threadRefFilter !== undefined && threadRef !== threadRefFilter) return false
      if (request.topLevelOnly && (fact.kind !== 'message' || !fact.message.topLevel)) return false
      if (request.includeActivities === false && fact.kind === 'activity') return false
      return direction === 'before' ? fact.sequence < before : fact.sequence > cursor
    }
    // Walk from the end the direction starts at and stop once `limit` matches
    // are collected plus one more proves `hasMore` — `limit` bounds only the
    // returned items, never the scan below a single extra match. A sidebar
    // asking for one item no longer sweeps the whole fact ledger.
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
    const visibleTasks = [...this.state.tasks.values()].filter(task => channelRefs.has(task.channelRef)
      && (channelRefFilter === undefined || task.channelRef === channelRefFilter)
      && (threadRefFilter === undefined || task.threadRef === threadRefFilter))
    const taskNumbers = this.taskNumbers(request.workspaceId)
    const items = selected.filter((fact): fact is Extract<AgentTeamThreadFact, { kind: 'message' }> => fact.kind === 'message').map(fact => {
      const message = fact.message
      const thread = this.requireThread(message.threadRef)
      const task = thread.taskRef === undefined ? undefined : this.state.tasks.get(thread.taskRef)
      const facts = this.state.factsByThread.get(thread.threadRef) ?? []
      return Object.freeze({ message, mentions: fact.mentions, ...(task === undefined ? {} : { task, taskNumber: taskNumbers.get(task.taskRef) ?? 0 }), thread,
        claimOwners: this.liveClaimOwners(task),
        messageCount: this.state.messageCountByThread.get(thread.threadRef) ?? 0,
        lastActivityAt: facts.at(-1)?.occurredAt ?? '' })
    })
    const initialization = this.initialization()
    const nextCursor = selected.length === 0 ? cursor : direction === 'before' ? selected[0]!.sequence : selected.at(-1)!.sequence
    return Object.freeze({
      humanMemberId: initialization.data.humanMemberId,
      workspaces: Object.freeze(memberId === undefined ? [] : this.workspacesOfFrom(this.state, memberId)
        .map(workspaceId => Object.freeze({ workspaceId, default: workspaceId === this.state.members.get(memberId)?.workspaceId }))),
      channels: Object.freeze(channels),
      members: Object.freeze([...this.state.memberships.entries()].filter(([channelRef]) => channelRefs.has(channelRef)).flatMap(([channelRef, ids]) =>
        [...ids].filter(id => {
          const state = this.state.members.get(id)?.state
          return state !== 'inactive' && state !== 'archived'
        }).sort().map(memberId => Object.freeze({ channelRef, memberId })))),
      tasks: Object.freeze(visibleTasks),
      threads: Object.freeze([...this.state.threads.values()].filter(thread => {
        const channelRef = this.channelRefForThread(thread.threadRef)
        return channelRef !== undefined && channelRefs.has(channelRef)
          && (channelRefFilter === undefined || channelRef === channelRefFilter)
          && (threadRefFilter === undefined || thread.threadRef === threadRefFilter)
      })),
      taskNumbers: Object.freeze(visibleTasks.map(task => Object.freeze({ taskRef: task.taskRef, taskNumber: taskNumbers.get(task.taskRef) ?? 0 }))),
      items: Object.freeze(items),
      activeTaskThreads: this.activeTaskThreads(visibleTasks, taskNumbers),
      claims: this.claimsForVisibleTasks(visibleTasks),
      activities: Object.freeze(selected.filter((fact): fact is Extract<AgentTeamThreadFact, { kind: 'activity' }> => fact.kind === 'activity').map(fact => fact.activity)),
      cursor: nextCursor,
      hasMore,
    })
  }

  status(): AgentTeamStatus {
    const initialization = this.initialization()
    return Object.freeze({ initialized: true, sequence: this.state.ordered.length, operationCount: this.state.ordered.length,
      channelCount: this.state.channels.size, agentMemberCount: this.state.members.size, humanMemberId: initialization.data.humanMemberId })
  }

  validate(): void {
    this.validateRecords(this.sortedRecords())
  }

  /**
   * Validate the durable ledger for the invariant's mount check, reusing the
   * constructor's record-level replay once instead of paying a second identical
   * one at startup.
   *
   * The adoption is gated on the operations table's single-writer identity —
   * this ledger's commit path is the only caller of `table.put` — so an
   * unchanged record count, head sequence and head operation id mean a
   * mount-time replay would re-derive precisely the records the constructor
   * already re-derived against its own scratch projection. Any commit between
   * construction and mount, and every later call, falls back to the full
   * replay. The check is never narrowed: the reused conclusion is still that
   * same independent replay of every durable record.
   */
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

  /**
   * Claim releases are thread-visible facts: an open Channel page and every
   * affected Thread page must refetch alongside the workspace-wide change. Each
   * released activity contributes its own Thread scope plus the Channel that
   * owns its Task, deduplicated against the caller's initial scopes — which is
   * why the caller passes them in rather than the helper inventing them.
   */
  private withReleasedActivityScopes(
    scopes: AgentTeamChangeScope[],
    tasks: readonly AgentTeamTask[],
    activities: readonly AgentTeamClaimsReleasedActivity[],
  ): AgentTeamChangeScope[] {
    const channelByTask = new Map(tasks.map(task => [task.taskRef, task.channelRef]))
    for (const activity of activities) {
      scopes.push({ kind: 'thread', threadRef: activity.threadRef })
      const channelRef = channelByTask.get(activity.taskRef)
      if (channelRef !== undefined && !scopes.some(scope => scope.kind === 'channel' && scope.channelRef === channelRef)) {
        scopes.push({ kind: 'channel', channelRef })
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
      case 'team/channel-created':
        return [{ kind: 'workspace', workspaceId: operation.data.workspaceId }]
      case 'team/channel-updated':
        // The rename is visible in the sidebar list and any open Channel/Thread header.
        return [{ kind: 'workspace', workspaceId: operation.data.workspaceId }, { kind: 'channel', channelRef: operation.data.channel.channelRef }]
      case 'team/member-added':
      case 'team/member-suspended':
      case 'team/member-resumed':
      case 'team/member-session-restarted':
      case 'team/member-context-cleared':
      case 'team/member-session-renewed':
      case 'team/member-session-rolled-over':
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
      case 'team/channel-member-added':
        return [{ kind: 'workspace', workspaceId: operation.data.workspaceId }, { kind: 'channel', channelRef: operation.data.channelRef }]
      case 'team/channel-member-removed':
        return this.withReleasedActivityScopes(
          [
            { kind: 'workspace', workspaceId: operation.data.workspaceId },
            { kind: 'channel', channelRef: operation.data.channelRef },
          ],
          operation.data.tasks,
          operation.data.activities,
        )
      case 'team/channel-archived': {
        const scopes: AgentTeamChangeScope[] = [
          { kind: 'workspace', workspaceId: operation.data.workspaceId },
          { kind: 'channel', channelRef: operation.data.channel.channelRef },
        ]
        for (const activity of operation.data.activities) scopes.push({ kind: 'thread', threadRef: activity.threadRef })
        return scopes
      }
      case 'team/message-sent':
      case 'team/thread-replied':
        return [{ kind: 'channel', channelRef: operation.data.message.channelRef }, { kind: 'thread', threadRef: operation.data.message.threadRef }]
      case 'team/thread-promoted':
        return [{ kind: 'channel', channelRef: operation.data.task.channelRef }, { kind: 'thread', threadRef: operation.data.thread.threadRef }]
      case 'team/claim-created':
      case 'team/claim-done':
      case 'team/claim-released':
      case 'team/task-changed':
        return [{ kind: 'channel', channelRef: operation.data.task.channelRef }, { kind: 'thread', threadRef: operation.data.thread.threadRef }]
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
      case 'team/thread-promoted':
        return [operation.data.activity.threadRef]
      case 'team/claim-created':
      case 'team/claim-done':
      case 'team/claim-released':
      case 'team/task-changed':
      case 'team/thread-attention-changed':
        return [operation.data.thread.threadRef]
      case 'team/channel-member-removed':
      case 'team/channel-archived':
      case 'team/member-removed':
      case 'team/member-archived':
      case 'team/member-workspace-left':
        return operation.data.activities.map(activity => activity.threadRef)
      case 'team/initialized':
      case 'team/channel-created':
      case 'team/channel-updated':
      case 'team/member-added':
      case 'team/member-workspace-joined':
      case 'team/member-suspended':
      case 'team/member-resumed':
      case 'team/member-session-restarted':
      case 'team/member-context-cleared':
      case 'team/member-session-renewed':
      case 'team/member-session-rolled-over':
      case 'team/member-updated':
      case 'team/channel-member-added':
      case 'team/thread-read':
      case 'team/dm-sent':
        return []
      default:
        return assertUnhandledKind(operation)
    }
  }

  private replay(): void {
    const records = this.sortedRecords()
    this.validateRecords(records)
    for (const [, operation] of records) this.apply(operation)
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
      if (operation.actor.kind !== 'human' || operation.actor.memberId !== humanMemberId) {
        throw new Error(`agent-team operation ${operation.sequence} has invalid Human authority`)
      }
    }
    const assertMember = (): AgentTeamAgentMember => {
      if (operation.actor.kind !== 'member') throw new Error(`agent-team operation ${operation.sequence} requires Member authority`)
      const member = projection.members.get(operation.actor.memberId)
      if (member === undefined || member.state !== 'enabled' || member.handle !== operation.actor.handle) {
        throw new Error(`agent-team operation ${operation.sequence} has invalid Member authority`)
      }
      return member
    }
    if (operation.kind === 'team/initialized') throw new Error('agent-team initialization must be first')
    if (operation.kind === 'team/channel-created') {
      assertHuman()
      const { channel, memberIds } = operation.data
      if (projection.channels.has(channel.channelRef) || channel.createdAtSequence !== operation.sequence || channel.workspaceId !== operation.data.workspaceId) throw new Error('invalid Channel creation')
      this.addRef(refs, channel.channelRef)
      const unique = new Set(memberIds)
      if (unique.size !== memberIds.length) throw new Error('invalid initial Channel members')
      for (const memberId of memberIds) {
        const member = projection.members.get(memberId)
        if (member === undefined || !this.participatesInFrom(projection, member.memberId, channel.workspaceId) || member.state !== 'enabled') throw new Error('invalid initial Channel Member')
      }
      return
    }
    if (operation.kind === 'team/member-added') {
      assertHuman()
      const { member, channelRefs } = operation.data
      if (projection.members.has(member.memberId) || new Set(channelRefs).size !== channelRefs.length) throw new Error('invalid Member creation')
      this.addRef(refs, member.memberId)
      for (const channelRef of channelRefs) {
        const channel = projection.channels.get(channelRef)
        if (channel === undefined || channel.workspaceId !== member.workspaceId) throw new Error('invalid initial Member Channel')
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
      // Legacy in-place clear: the recorded Member is unchanged, and the
      // projection deliberately does not change either.
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
    if (operation.kind === 'team/channel-updated') {
      assertHuman()
      const prior = projection.channels.get(operation.data.channel.channelRef)
      if (prior === undefined || prior.workspaceId !== operation.data.workspaceId
        || operation.data.channel.workspaceId !== prior.workspaceId || operation.data.channel.createdAtSequence !== prior.createdAtSequence
        || operation.data.channel.state !== prior.state) {
        throw new Error('invalid Channel update')
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
      // Replay-time human collision uses the Host-synced runtime name; the
      // default keeps old ledgers (written before configurable names) valid.
      // A stored rename that now collides fails replay loudly rather than
      // silently forking the @ namespace, so the operator renames first.
      if (normalized === this.humanHandle.normalize('NFKC').trim().toLowerCase()) throw new Error('invalid Member update handle')
      return
    }
    if (operation.kind === 'team/channel-member-added') {
      assertHuman()
      const channel = projection.channels.get(operation.data.channelRef)
      const member = projection.members.get(operation.data.memberId)
      if (channel === undefined || member === undefined || !this.participatesInFrom(projection, member.memberId, channel.workspaceId) || operation.data.workspaceId !== channel.workspaceId || projection.memberships.get(channel.channelRef)?.has(member.memberId)) throw new Error('invalid Channel membership')
      return
    }
    if (operation.kind === 'team/channel-member-removed') {
      assertHuman()
      const channel = projection.channels.get(operation.data.channelRef)
      const member = projection.members.get(operation.data.memberId)
      if (channel === undefined || member === undefined || operation.data.workspaceId !== channel.workspaceId
        || !this.participatesInFrom(projection, member.memberId, channel.workspaceId) || !projection.memberships.get(channel.channelRef)?.has(member.memberId)) throw new Error('invalid Channel membership removal')
      const threadRefs = new Set([...projection.threads.keys()].filter(threadRef => this.channelRefForThreadFrom(projection, threadRef) === channel.channelRef))
      this.validateReleaseCleanup(operation.data, projection, member.memberId, threadRefs, operation.sequence, refs)
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
      this.validateReleaseCleanup(operation.data, projection, member.memberId, threadRefs, operation.sequence, refs)
      return
    }
    if (operation.kind === 'team/channel-archived') {
      assertHuman()
      const prior = projection.channels.get(operation.data.channel.channelRef)
      if (prior === undefined || prior.state !== 'active' || operation.data.channel.state !== 'archived'
        || operation.data.channel.workspaceId !== prior.workspaceId || operation.data.workspaceId !== prior.workspaceId
        || operation.data.channel.name !== prior.name || operation.data.channel.description !== prior.description
        || operation.data.channel.createdAtSequence !== prior.createdAtSequence) throw new Error('invalid Channel archival')
      const threadRefs = new Set([...projection.threads.keys()].filter(threadRef => this.channelRefForThreadFrom(projection, threadRef) === prior.channelRef))
      this.validateReleaseCleanup(operation.data, projection, undefined, threadRefs, operation.sequence, refs)
      return
    }
    if (operation.kind === 'team/member-removed') {
      assertHuman()
      const prior = projection.members.get(operation.data.member.memberId)
      if (prior === undefined || prior.state === 'inactive' || operation.data.member.state !== 'inactive' || !this.sameMemberIdentity(prior, operation.data.member)) throw new Error('invalid Member removal')
      const threadRefs = new Set(projection.threads.keys())
      this.validateReleaseCleanup(operation.data, projection, prior.memberId, threadRefs, operation.sequence, refs)
      return
    }
    if (operation.kind === 'team/member-archived') {
      assertHuman()
      const prior = projection.members.get(operation.data.member.memberId)
      if (prior === undefined || (prior.state !== 'enabled' && prior.state !== 'suspended') || operation.data.member.state !== 'archived' || !this.sameMemberIdentity(prior, operation.data.member)) throw new Error('invalid Member archival')
      const threadRefs = new Set(projection.threads.keys())
      this.validateReleaseCleanup(operation.data, projection, prior.memberId, threadRefs, operation.sequence, refs)
      return
    }
    if (operation.kind === 'team/thread-attention-changed') {
      const actor = operation.actor.kind === 'member' ? assertMember() : (assertHuman(), undefined)
      if (operation.data.memberId !== operation.actor.memberId) throw new Error('Attention operation has wrong actor')
      const thread = projection.threads.get(operation.data.thread.threadRef)
      const task = operation.data.task
      const currentTask = thread?.taskRef === undefined ? undefined : projection.tasks.get(thread.taskRef)
      const channelRef = thread === undefined ? undefined : this.channelRefForThreadFrom(projection, thread.threadRef)
      if (thread === undefined || channelRef === undefined || !this.sameThread(thread, operation.data.thread)
        || (task === undefined ? currentTask !== undefined : currentTask === undefined || !this.sameTask(currentTask, task) || thread.taskRef !== task.taskRef)
        || (actor !== undefined && !projection.memberships.get(channelRef)?.has(actor.memberId))) throw new Error('invalid Attention operation')
      const current = this.attentionForFrom(projection, operation.data.memberId, thread.threadRef)
      if ((operation.data.action === 'follow' && (task?.resolution === 'closed' || current !== undefined))
        || (operation.data.action === 'unfollow' && (current === undefined || (task !== undefined && this.hasActiveClaimFrom(projection, operation.data.memberId, task.taskRef))))) {
        throw new Error('invalid Attention transition')
      }
      const expected = operation.data.action === 'follow'
        ? this.inboxDelta([this.followAttentionFrom(projection, operation.data.memberId, thread.threadRef)])
        : this.inboxDelta([], [{ memberId: operation.data.memberId, threadRef: thread.threadRef }], [], this.directMarkersForFrom(projection, operation.data.memberId, thread.threadRef))
      if (!isDeepStrictEqual(operation.data.inbox, expected)) throw new Error('invalid Attention projection')
      this.validateInboxDelta(operation.data.inbox, projection, refs)
      return
    }
    if (operation.kind === 'team/thread-read') {
      if (operation.actor.kind === 'member') assertMember(); else assertHuman()
      const data = operation.data
      if (data.memberId !== operation.actor.memberId) throw new Error('Thread read has wrong actor')
      const target = threadReadTargetOf(data)
      if (isThreadReadSnapshot(data)) {
        // The pre-receipt form froze the whole picture, so its expected value
        // is re-derived the same way it was written: from this record's prior
        // projection only, never from the live one. That shape stays frozen —
        // a field added after it, like the orientation count, is not compared
        // here, because no stored legacy record carries it and inventing one
        // would reject every upgrade of a ledger written before the field.
        const expected = this.prepareReadFrom(projection, data.memberId, data.workspaceId, target)
        const expectedData = Object.freeze({ workspaceId: data.workspaceId, memberId: data.memberId,
          ...(expected.task === undefined ? {} : { task: expected.task }), thread: expected.thread, claims: expected.claims, anchor: expected.anchor,
          anchorMentions: expected.anchorMentions, facts: expected.facts,
          readThroughSequence: expected.readThroughSequence, remainingUnreadCount: expected.remainingUnreadCount,
          ...(expected.attention === undefined ? {} : { attention: expected.attention }), inbox: expected.inbox })
        if (!isDeepStrictEqual(data, expectedData)) throw new Error('invalid Thread read projection')
      } else {
        // A receipt claims progress and its Inbox delta, nothing else, so the
        // independent derivation stops there too: the picture and the unread
        // count left behind are projection state a replay re-derives for the
        // surfaces that need them, not content of this record. The Task ref is
        // derived rather than copied back, so a Task Thread read cannot drop
        // the Task it belongs to and shrink its own claim unchecked.
        const expected = this.prepareReadReceiptFrom(projection, data.memberId, data.workspaceId, target)
        const expectedData = Object.freeze({ workspaceId: data.workspaceId, memberId: data.memberId, threadRef: data.threadRef,
          ...(expected.task === undefined ? {} : { taskRef: expected.task.taskRef }),
          readThroughSequence: expected.readThroughSequence, inbox: expected.inbox })
        if (!isDeepStrictEqual(data, expectedData)) throw new Error('invalid Thread read receipt')
      }
      this.validateInboxDelta(data.inbox, projection, refs)
      return
    }
    if (operation.kind === 'team/thread-promoted') {
      assertHuman()
      const { activity, task, thread } = operation.data
      const priorThread = projection.threads.get(thread.threadRef)
      const channelRef = priorThread === undefined ? undefined : this.channelRefForThreadFrom(projection, thread.threadRef)
      if (priorThread === undefined || priorThread.taskRef !== undefined || projection.tasks.has(task.taskRef)
        || channelRef === undefined || task.channelRef !== channelRef
        || projection.channels.get(channelRef)?.workspaceId !== operation.data.workspaceId
        || operation.data.baseRevision !== priorThread.revision
        || task.status !== 'todo' || task.resolution !== 'open'
        || thread.revision !== operation.sequence || task.threadRef !== thread.threadRef || thread.taskRef !== task.taskRef
        || !this.sameThread(thread, { ...priorThread, taskRef: task.taskRef, revision: operation.sequence })
        || activity.kind !== 'promote' || activity.sequence !== operation.sequence || activity.actor !== operation.actor.memberId
        || activity.taskRef !== task.taskRef || activity.threadRef !== thread.threadRef) throw new Error('invalid Thread promotion')
      this.addRef(refs, task.taskRef)
      this.addRef(refs, activity.activityRef)
      const expectedInbox = this.promoteThreadInboxFrom(projection, activity, thread.threadRef)
      if (!isDeepStrictEqual(operation.data.inbox, expectedInbox)) throw new Error('invalid Promotion inbox projection')
      this.validateInboxDelta(operation.data.inbox, projection, refs, [], [], [activity])
      return
    }
    if (operation.kind === 'team/message-sent' || operation.kind === 'team/thread-replied') {
      const actor = operation.actor.kind === 'member' ? assertMember() : (assertHuman(), undefined)
      const { message, task, thread } = operation.data
      const channel = projection.channels.get(message.channelRef)
      if (channel === undefined || channel.workspaceId !== operation.data.workspaceId || message.sender !== operation.actor.memberId
        || message.sequence !== operation.sequence || thread.revision !== operation.sequence
        || message.threadRef !== thread.threadRef
        || (task === undefined ? message.taskRef !== undefined || thread.taskRef !== undefined
          : message.taskRef !== task.taskRef || thread.taskRef !== task.taskRef || task.threadRef !== thread.threadRef || task.channelRef !== channel.channelRef)
        || (actor !== undefined && !projection.memberships.get(channel.channelRef)?.has(actor.memberId))) throw new Error('invalid Message operation')
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
        || thread.revision !== operation.sequence || activity.sequence !== operation.sequence || activity.actor !== operation.actor.memberId
        || activity.taskRef !== task.taskRef || activity.threadRef !== thread.threadRef || activity.claimRef !== claim.claimRef
        || (actor !== undefined && !projection.memberships.get(task.channelRef)?.has(actor.memberId))) throw new Error('invalid Claim operation')
      const creates = operation.kind === 'team/claim-created'
      const expectedKind = creates ? 'claim' : operation.kind === 'team/claim-done' ? 'done' : 'release'
      if (activity.kind !== expectedKind || claim.taskRef !== task.taskRef || claim.threadRef !== thread.threadRef) throw new Error('invalid Claim activity')
      if (operation.actor.kind !== 'member') throw new Error('invalid Claim authority')
      if ((creates && projection.claims.has(claim.claimRef))
        || (creates && claim.owner !== operation.actor.memberId) || (creates && claim.state !== 'active')) throw new Error('invalid Claim creation')
      const previousClaim = projection.claims.get(claim.claimRef)
      if (!creates && (previousClaim === undefined || previousClaim.state !== 'active' || !this.sameClaimIdentity(previousClaim, claim)
        || (operation.actor.kind === 'member' && previousClaim.owner !== operation.actor.memberId)
        || claim.state !== (operation.kind === 'team/claim-done' ? 'done' : 'released'))) throw new Error('invalid Claim transition')
      if (task.status !== this.deriveResolvedTaskStatus(task, new Map(projection.claims).set(claim.claimRef, claim).values())) throw new Error('invalid Claim Task status')
      this.addRef(refs, activity.activityRef)
      if (creates) this.addRef(refs, claim.claimRef)
      const expectedInbox = creates && !this.isFollowingFrom(projection, thread.threadRef, operation.actor.memberId)
        ? this.inboxDelta([this.startAttention(operation.actor.memberId, thread.threadRef, operation.sequence)])
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
        || activity.sequence !== operation.sequence || activity.actor !== operation.actor.memberId
        || activity.taskRef !== task.taskRef || activity.threadRef !== thread.threadRef) throw new Error('invalid Task operation')
      const expectedResolution = activity.kind === 'accept' ? 'accepted' : activity.kind === 'close' ? 'closed' : 'open'
      const expectedStatus = expectedResolution === 'accepted' ? 'done' : expectedResolution === 'closed' ? 'closed'
        : this.deriveTaskStatus(task.taskRef, operation.data.claims)
      const expectedCompletedClaimRefs = operation.data.claims
        .filter(claim => projection.claims.get(claim.claimRef)?.state === 'active' && claim.state === 'done')
        .map(claim => claim.claimRef)
      // New-shape accepts carry the acceptance discriminator: every done
      // Claim at commit time, sorted. Legacy accepts predate it; the
      // recorded wake semantics for them stay completed-only (the old rule)
      // so every existing ledger replays unchanged.
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
      const priorClaims = [...projection.claims.values()].filter(claim => claim.taskRef === task.taskRef).sort((left, right) => left.claimRef.localeCompare(right.claimRef))
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
        || !this.validMentionTarget(projection, message.channelRef, marker.memberId)) throw new Error('invalid direct marker addition')
    }
    for (const marker of delta.directMarkers.removed) {
      const key = this.directMarkerKey(marker)
      if (markerKeys.has(key) || !projection.directMarkers.has(key)) throw new Error('invalid direct marker removal')
      markerKeys.add(key)
      const current = projection.directMarkers.get(key)!
      const message = projection.messagesByRef.get(marker.messageRef) ?? additionalMessages.find(candidate => candidate.messageRef === marker.messageRef)
      if (!isDeepStrictEqual(current, marker) || message === undefined || message.threadRef !== marker.threadRef
        || message.sequence !== marker.sequence || !this.validMentionTarget(projection, message.channelRef, marker.memberId)) {
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
  }

  /**
   * Replay validation of one departure's release snapshot against the
   * projection it was derived from. `memberId` scopes everything to a single
   * departing Member; `undefined` validates every owner, which is what
   * archiving a whole Channel releases. The two scopes differ in exactly four
   * ways, all of them visible here rather than spread over two copies:
   *
   * 1. released Claims are owner-filtered for a Member, unfiltered for a Channel;
   * 2. Activities group per (owner, Thread) with owners sorted, which for a
   *    single departing Member collapses to one Activity per Thread — the shape
   *    the commit path writes;
   * 3. the inbox cleanup covers the departing Member's Attention and markers, or
   *    every Member's on the archived Channel's Threads;
   * 4. the failure message names which of the two paths lost its cleanup.
   */
  private validateReleaseCleanup(
    data: AgentTeamChannelMemberRemovedOperation['data'] | AgentTeamMemberRemovedOperation['data']
      | AgentTeamMemberArchivedOperation['data'] | AgentTeamChannelArchivedOperation['data']
      | AgentTeamMemberWorkspaceLeftOperation['data'],
    projection: Projection,
    memberId: AgentTeamMemberId | undefined,
    threadRefs: ReadonlySet<AgentTeamThreadRef>,
    sequence: number,
    refs: Set<string>,
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
    const expectedInbox = this.inboxDelta([], expectedAttention, [], expectedMarkers, [], expectedActivityMarkers)
    if (!isDeepStrictEqual(data.inbox, expectedInbox)) {
      throw new Error(memberId === undefined ? 'invalid Channel archival inbox cleanup' : 'invalid Member inbox cleanup')
    }
    this.validateInboxDelta(data.inbox, projection, refs)
  }

  private validateMessageInbox(operation: AgentTeamMessageSentOperation | AgentTeamThreadRepliedOperation, projection: Projection): void {
    const { message, mentions } = operation.data
    const mentionedAgents = mentions.filter(memberId => projection.members.has(memberId))
    // Top-level mentions are open to every actor; only a Member reply may not
    // pull an unfollowed Member into an existing Thread.
    if (operation.actor.kind === 'member' && operation.kind === 'team/thread-replied'
      && mentionedAgents.some(memberId => !this.everParticipatedFrom(projection, message.threadRef, memberId))) {
      throw new Error('invalid Agent mention projection')
    }
    const started = operation.kind === 'team/message-sent'
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
    message: AgentTeamMessage,
    projection: Projection,
  ): void {
    if (mentions.includes(message.sender) || !this.sameList(mentions, [...new Set(mentions)].sort())) throw new Error('invalid Message mentions')
    for (const memberId of mentions) if (!this.validMentionTarget(projection, message.channelRef, memberId)) throw new Error('invalid Message mention target')
  }

  private validMentionTarget(projection: Projection, channelRef: AgentTeamChannelRef, memberId: AgentTeamMemberId): boolean {
    if (memberId === AGENT_TEAM_HUMAN_MEMBER_ID) return true
    const member = projection.members.get(memberId)
    const channelWorkspaceId = projection.channels.get(channelRef)?.workspaceId
    return member !== undefined && member.state !== 'inactive' && member.state !== 'archived'
      && channelWorkspaceId !== undefined && this.participatesInFrom(projection, memberId, channelWorkspaceId)
      && this.isChannelMemberFrom(projection, channelRef, memberId)
  }

  private apply(operation: AgentTeamOperation): void {
    this.applyTo(this.state, operation)
    // Live apply only: the record-validation replay re-derives each record
    // against its own scratch projection, so a scope derivation there would be
    // discarded.
    const scopes = this.changeScopesOf(operation)
    if (scopes === undefined || scopes.length !== 0) this.projectionVersion = operation.sequence
  }

  private applyTo(target: Projection, operation: AgentTeamOperation): void {
    target.ordered.push(operation)
    target.byRequest.set(operation.requestId, operation)
    target.byOperation.set(operation.operationId, operation)
    if (operation.kind === 'team/initialized') return
    if (operation.kind === 'team/channel-created') {
      target.channels.set(operation.data.channel.channelRef, operation.data.channel)
      target.memberships.set(operation.data.channel.channelRef, new Set(operation.data.memberIds))
      return
    }
    if (operation.kind === 'team/member-added') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      // Creation seeds the first Workspace participation; member.workspaceId
      // stays the default Workspace the Session roots in, immutable after add.
      target.participations.set(operation.data.member.memberId, new Set([operation.data.member.workspaceId]))
      for (const channelRef of operation.data.channelRefs) this.addMembership(target, channelRef, operation.data.member.memberId)
      return
    }
    if (operation.kind === 'team/member-suspended' || operation.kind === 'team/member-resumed') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      return
    }
    if (operation.kind === 'team/member-session-restarted') {
      // Audit-only: identity, transcript, and memory are untouched, so the
      // projection deliberately does not change.
      return
    }
    if (operation.kind === 'team/member-context-cleared') {
      // Legacy audit-only marker: identity, memory path, and binding were
      // untouched; the Host recreated the live Session empty under the same id.
      return
    }
    if (operation.kind === 'team/member-session-renewed') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      target.previousSessions.set(operation.data.member.memberId, operation.data.previousSessionId)
      // A Human-side renewal is always a fresh start: a stale checkpoint
      // seed from an earlier rollover must never re-seed it.
      target.rolloverSeeds.delete(operation.data.member.memberId)
      return
    }
    if (operation.kind === 'team/member-session-rolled-over') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      target.previousSessions.set(operation.data.member.memberId, operation.data.previousSessionId)
      // A checkpoint return records its seed envelope: a crash between this
      // commit and the new Session's activation rebuilds the child from the
      // recorded source instead of an empty context.
      const { sourceSessionId, sourceThroughSeq, checkpointRef } = operation.data
      if (sourceSessionId !== undefined && sourceThroughSeq !== undefined && checkpointRef !== undefined) {
        target.rolloverSeeds.set(operation.data.member.memberId, { targetSessionId: operation.data.newSessionId, sourceSessionId, sourceThroughSeq, checkpointRef })
      } else {
        target.rolloverSeeds.delete(operation.data.member.memberId)
      }
      return
    }
    if (operation.kind === 'team/channel-updated') {
      target.channels.set(operation.data.channel.channelRef, operation.data.channel)
      return
    }
    if (operation.kind === 'team/member-updated') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      return
    }
    if (operation.kind === 'team/channel-member-added') {
      this.addMembership(target, operation.data.channelRef, operation.data.memberId)
      return
    }
    if (operation.kind === 'team/channel-member-removed') {
      target.memberships.get(operation.data.channelRef)?.delete(operation.data.memberId)
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
      // Departure ends Channel memberships inside the left Workspace — unlike
      // archival, which keeps them hidden for a possible restore.
      for (const channel of target.channels.values()) {
        if (channel.workspaceId === operation.data.workspaceId) target.memberships.get(channel.channelRef)?.delete(operation.data.memberId)
      }
      this.applyReleaseSnapshot(target, operation, operation.data, operation.occurredAt)
      return
    }
    if (operation.kind === 'team/channel-archived') {
      // Archival keeps Memberships: hidden state, not departure — a future
      // restore returns every Member to the Channel. Visibility filters by
      // channel state instead.
      target.channels.set(operation.data.channel.channelRef, operation.data.channel)
      this.applyReleaseSnapshot(target, operation, operation.data, operation.occurredAt)
      return
    }
    if (operation.kind === 'team/member-removed') {
      target.members.set(operation.data.member.memberId, operation.data.member)
      for (const membership of target.memberships.values()) membership.delete(operation.data.member.memberId)
      this.applyReleaseSnapshot(target, operation, operation.data, operation.occurredAt)
      return
    }
    if (operation.kind === 'team/member-archived') {
      // Archival keeps Memberships: hidden state, not departure — a future
      // restore returns the Member to its Channels. Visibility filters by
      // member state instead.
      target.members.set(operation.data.member.memberId, operation.data.member)
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
      target.mentionsByMessage.set(message.messageRef, Object.freeze([...mentions]))
      this.appendMessageFact(target, message, mentions, message.occurredAt ?? operation.occurredAt)
      if (operation.data.task !== undefined) target.tasks.set(operation.data.task.taskRef, operation.data.task)
      target.threads.set(operation.data.thread.threadRef, operation.data.thread)
      if (message.topLevel) {
        target.channelRefByThread.set(message.threadRef, message.channelRef)
        // The anchor is the Thread's first topLevel Message; a later topLevel
        // Message (none today) must not displace it, matching the linear scan.
        if (!target.anchorByThread.has(message.threadRef)) target.anchorByThread.set(message.threadRef, message)
      }
      // Only message-sent mints a Task ordinal; thread-replied may echo the
      // Task without renumbering it, like the operation scan it replaces.
      if (operation.kind === 'team/message-sent' && operation.data.task !== undefined) this.recordTaskNumber(target, operation.data.task)
      this.recordAttentionObservations(target, operation, operation.data.inbox)
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/claim-created' || operation.kind === 'team/claim-done' || operation.kind === 'team/claim-released') {
      target.claims.set(operation.data.claim.claimRef, operation.data.claim)
      this.appendActivityFact(target, operation.data.activity, operation.occurredAt)
      target.tasks.set(operation.data.task.taskRef, operation.data.task)
      target.threads.set(operation.data.thread.threadRef, operation.data.thread)
      this.recordAttentionObservations(target, operation, operation.data.inbox)
      this.applyInboxDelta(target, operation.data.inbox)
      return
    }
    if (operation.kind === 'team/task-changed') {
      for (const claim of operation.data.claims) target.claims.set(claim.claimRef, claim)
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
    if (operation.kind === 'team/dm-sent') {
      // Audit-only: delivery is a transient runtime effect, so the durable
      // projection deliberately does not change.
      return
    }
    assertUnhandledKind(operation)
  }

  /**
   * Replay the departure snapshot a releasing operation carries. The order is
   * replay semantics, not style: Claims land before the Activities that
   * reference them, and Tasks/Threads before the inbox delta that reads them.
   * Each caller still applies its own identifying writes (member, membership,
   * channel) around this call.
   */
  private applyReleaseSnapshot(
    target: Projection,
    operation: AgentTeamOperation,
    data: {
      readonly claims: readonly AgentTeamClaim[]
      readonly activities: readonly AgentTeamClaimsReleasedActivity[]
      readonly tasks: readonly AgentTeamTask[]
      readonly threads: readonly AgentTeamThread[]
      readonly inbox: AgentTeamInboxDelta
    },
    occurredAt: string,
  ): void {
    for (const claim of data.claims) target.claims.set(claim.claimRef, claim)
    for (const activity of data.activities) this.appendActivityFact(target, activity, occurredAt)
    for (const task of data.tasks) target.tasks.set(task.taskRef, task)
    for (const thread of data.threads) target.threads.set(thread.threadRef, thread)
    this.recordAttentionObservations(target, operation, data.inbox)
    this.applyInboxDelta(target, data.inbox)
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

  /** Display ordinals are a per-Channel creation counter; the workspace filter happens at read time. */
  private recordTaskNumber(target: Projection, task: AgentTeamTask): void {
    const ordinal = (target.taskCountByChannel.get(task.channelRef) ?? 0) + 1
    target.taskCountByChannel.set(task.channelRef, ordinal)
    target.taskNumberByTask.set(task.taskRef, ordinal)
  }

  /**
   * Replay-order Attention observations, appended from committed Inbox deltas
   * only (the hypothetical read projection applies its delta directly). The
   * follow/unfollow decision mirrors the full replay scan it replaces: a
   * removal records only when Attention existed, and a set records unless it
   * is the Thread-creating Message (initial Attention) or merely advances the
   * same follow's watermark. Removals are evaluated before sets, exactly like
   * the scan's loop order.
   */
  private recordAttentionObservations(target: Projection, operation: AgentTeamOperation, delta: AgentTeamInboxDelta): void {
    if (delta.attention.removed.length === 0 && delta.attention.set.length === 0) return
    const retired = new Set<string>()
    for (const key of delta.attention.removed) {
      retired.add(this.attentionKey(key.memberId, key.threadRef))
      if (!target.attention.has(this.attentionKey(key.memberId, key.threadRef))) continue
      this.appendObservation(target, key.threadRef, { sequence: operation.sequence, memberId: key.memberId, action: 'unfollow' })
    }
    for (const next of delta.attention.set) {
      const key = this.attentionKey(next.memberId, next.threadRef)
      const prior = retired.has(key) ? undefined : target.attention.get(key)
      if (operation.kind === 'team/message-sent' || (prior !== undefined && prior.startSequence === next.startSequence)) continue
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
  }

  /** Insert into the Member's Thread bucket keeping the sequence order the read path must see. */
  private insertBucketedMarker<M extends { readonly sequence: number }>(
    index: Map<AgentTeamMemberId, Map<AgentTeamThreadRef, M[]>>,
    memberId: AgentTeamMemberId,
    threadRef: AgentTeamThreadRef,
    marker: M,
  ): void {
    const threads = index.get(memberId) ?? new Map<AgentTeamThreadRef, M[]>()
    index.set(memberId, threads)
    const bucket = threads.get(threadRef) ?? []
    threads.set(threadRef, bucket)
    let position = bucket.length
    while (position > 0 && bucket[position - 1]!.sequence > marker.sequence) position -= 1
    bucket.splice(position, 0, marker)
  }

  private removeBucketedMarker<M>(
    index: Map<AgentTeamMemberId, Map<AgentTeamThreadRef, M[]>>,
    memberId: AgentTeamMemberId,
    threadRef: AgentTeamThreadRef,
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
    const { task, thread, channelRef } = this.threadContextFrom(projection, workspaceId, request)
    if (memberId !== AGENT_TEAM_HUMAN_MEMBER_ID) {
      const member = projection.members.get(memberId)
      if (member === undefined || !projection.memberships.get(channelRef)?.has(member.memberId)) {
        throw new Error(`Agent Member '${memberId}' is not authorized for Channel '${channelRef}'`)
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
    const consumed = this.directMarkersForFrom(projection, memberId, thread.threadRef)
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
    const directKeys = new Set(this.directMarkersForFrom(projection, memberId, threadRef).map(marker => this.directMarkerKey(marker)))
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
    const directKeys = new Set(this.directMarkersForFrom(projection, memberId, threadRef).map(marker => this.directMarkerKey(marker)))
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
   * The one per-fact instant projection: a fact's wall-clock time is the
   * occurredAt of the ledger operation that committed it, looked up by
   * sequence inside the same read snapshot. Every agent-facing surface
   * (Thread facts, notifications, DM history, mutation results) resolves
   * through this single path, never a second parallel lookup.
   */
  private occurredAtForFactFrom(projection: Projection, sequence: number, fallback?: string | undefined): string {
    if (fallback !== undefined) return fallback
    // Facts arrive in ledger sequence order and `ordered` is append-only, so
    // the entry at index sequence - 1 is the committing operation. The index
    // read is guarded for hypothetical projections whose prefix has not yet
    // caught up; those callers always pass an explicit fallback instead.
    const operation = projection.ordered[sequence - 1]
    return operation?.occurredAt ?? ''
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
   * Acceptance notifies every done Claim owner — pre-finished (the normal
   * flow) and atomically completed (early acceptance) alike — through
   * activity markers regardless of whether they still follow the Thread.
   * The actor never notifies itself. Legacy records without the acceptance
   * discriminator keep the old completed-only wake semantics on replay.
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

  /** Promotion wakes every current follower; the Human actor never follows, so no recipient filter is needed. */
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

  private removeMemberThreadInbox(memberId: AgentTeamMemberId, threadRefs: ReadonlySet<AgentTeamThreadRef>): AgentTeamInboxDelta {
    return this.removeMemberThreadInboxFrom(this.state, memberId, threadRefs)
  }

  private removeMemberThreadInboxFrom(projection: Projection, memberId: AgentTeamMemberId, threadRefs: ReadonlySet<AgentTeamThreadRef>): AgentTeamInboxDelta {
    const removed = [...projection.attention.values()].filter(attention => attention.memberId === memberId && threadRefs.has(attention.threadRef))
      .map(attention => Object.freeze({ memberId, threadRef: attention.threadRef }))
    const markers = [...projection.directMarkers.values()].filter(marker => marker.memberId === memberId && threadRefs.has(marker.threadRef))
    const activityMarkers = [...projection.activityMarkers.values()].filter(marker => marker.memberId === memberId && threadRefs.has(marker.threadRef))
    return this.inboxDelta([], removed, [], markers, [], activityMarkers)
  }

  /** Attention and marker cleanup for EVERY Member on the given Threads. */
  private channelArchivalInbox(threadRefs: ReadonlySet<AgentTeamThreadRef>): AgentTeamInboxDelta {
    return this.channelArchivalInboxFrom(this.state, threadRefs)
  }

  private channelArchivalInboxFrom(projection: Projection, threadRefs: ReadonlySet<AgentTeamThreadRef>): AgentTeamInboxDelta {
    const removed = [...projection.attention.values()].filter(attention => threadRefs.has(attention.threadRef))
      .map(attention => Object.freeze({ memberId: attention.memberId, threadRef: attention.threadRef }))
    const markers = [...projection.directMarkers.values()].filter(marker => threadRefs.has(marker.threadRef))
    const activityMarkers = [...projection.activityMarkers.values()].filter(marker => threadRefs.has(marker.threadRef))
    return this.inboxDelta([], removed, [], markers, [], activityMarkers)
  }

  private inboxDelta(
    set: readonly AgentTeamThreadAttention[] = [],
    removed: readonly AgentTeamThreadAttentionKey[] = [],
    addedMarkers: readonly AgentTeamDirectMarker[] = [],
    removedMarkers: readonly AgentTeamDirectMarker[] = [],
    addedActivityMarkers: readonly AgentTeamActivityMarker[] = [],
    removedActivityMarkers: readonly AgentTeamActivityMarker[] = [],
  ): AgentTeamInboxDelta {
    return Object.freeze({
      attention: Object.freeze({ set: Object.freeze(set), removed: Object.freeze(removed) }),
      directMarkers: Object.freeze({ added: Object.freeze(addedMarkers), removed: Object.freeze(removedMarkers) }),
      activityMarkers: Object.freeze({ added: Object.freeze(addedActivityMarkers), removed: Object.freeze(removedActivityMarkers) }),
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
    return this.directMarkersForFrom(this.state, memberId, threadRef)
  }

  private directMarkersForFrom(projection: Projection, memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): readonly AgentTeamDirectMarker[] {
    // A frozen copy, not the live bucket: callers may hand the array to an
    // Inbox delta that freezes it, which must not freeze the derived index.
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
    channelRef: AgentTeamChannelRef,
    body: string,
    recipients: readonly AgentTeamMemberId[],
    task?: AgentTeamTask,
    thread?: AgentTeamThread,
  ): AgentTeamConfirmationRequired {
    if (actor.kind !== 'human') throw new Error('only Human may invite an unfollowed Agent')
    for (const [token, confirmation] of this.confirmations) if (confirmation.actor === actor.memberId) this.confirmations.delete(token)
    const confirmationToken = `confirmation:${randomUUID()}` as AgentTeamConfirmationToken
    this.confirmations.set(confirmationToken, Object.freeze({ actor: actor.memberId, workspaceId, channelRef,
      ...(task === undefined ? {} : { taskRef: task.taskRef }), ...(thread === undefined ? {} : { threadRef: thread.threadRef }),
      body, recipients, attention: recipients.map(memberId => thread !== undefined && this.isFollowing(thread.threadRef, memberId)),
      memberStates: recipients.map(memberId => this.state.members.get(memberId)?.state ?? 'enabled') }))
    return Object.freeze({ kind: 'confirmation_required', confirmationToken, workspaceId, channelRef,
      recipients: Object.freeze(recipients.filter(memberId => this.state.members.has(memberId) && (thread === undefined || !this.isFollowing(thread.threadRef, memberId)))),
      ...(task === undefined ? {} : { taskRef: task.taskRef }), ...(thread === undefined ? {} : { threadRef: thread.threadRef, revision: thread.revision }) })
  }

  private consumeConfirmation(
    token: AgentTeamConfirmationToken,
    actor: AgentTeamHumanActor | AgentTeamMemberActor,
    workspaceId: WorkspaceId,
    channelRef: AgentTeamChannelRef,
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
      || confirmation.channelRef !== channelRef || confirmation.taskRef !== task?.taskRef || confirmation.threadRef !== thread?.threadRef
      || confirmation.body !== body || !this.sameList(confirmation.recipients, recipients)
      || !this.sameList(confirmation.attention, attention) || !this.sameList(confirmation.memberStates, states)) {
      throw new Error('confirmation token is invalid or expired')
    }
  }

  private assertMentionTargets(channel: AgentTeamChannel, recipients: readonly AgentTeamMemberId[]): void {
    for (const memberId of recipients) {
      if (memberId === AGENT_TEAM_HUMAN_MEMBER_ID) continue
      const member = this.requireMember(memberId)
      if (member.state === 'inactive' || member.state === 'archived' || !this.participatesIn(member.memberId, channel.workspaceId) || !this.isChannelMember(channel.channelRef, memberId)) {
        throw new Error(`Agent Member '${memberId}' is not authorized for Channel '${channel.channelRef}'`)
      }
    }
  }

  private unreadRequired(task: AgentTeamTask | undefined, thread: AgentTeamThread, unread: readonly AgentTeamThreadReadFact[]): AgentTeamUnreadRequired {
    return Object.freeze({ kind: 'unread_required', ...(task === undefined ? {} : { taskRef: task.taskRef }), threadRef: thread.threadRef,
      revision: thread.revision, unreadCount: unread.length, directCount: unread.filter(item => item.direct).length })
  }

  private staleRevision(task: AgentTeamTask | undefined, thread: AgentTeamThread, expectedRevision: number): AgentTeamStaleRevision {
    return Object.freeze({ kind: 'stale_revision', ...(task === undefined ? {} : { taskRef: task.taskRef }), threadRef: thread.threadRef,
      expectedRevision, revision: thread.revision })
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
    return Object.freeze([...projection.claims.values()].filter(claim => claim.taskRef === taskRef))
  }

  private claimsForVisibleTasks(tasks: readonly AgentTeamTask[]): readonly AgentTeamClaim[] {
    const refs = new Set(tasks.map(task => task.taskRef))
    return Object.freeze([...this.state.claims.values()].filter(claim => refs.has(claim.taskRef)))
  }

  /**
   * The team_view「活跃 task thread」radar for a Workspace: every visible Task
   * still in flight — in_progress or in_review, the two states a live Claim
   * keeps a Task in — newest activity first. Unlike `recentInboxItems`, this is
   * not a participation slice: admission is the Task being active in a Channel
   * the reader can see, whether or not the reader wrote in it, and a Thread
   * still holding the reader's unread is not excluded. Rows carry the same
   * `liveClaimOwners`口径 the Inbox and Channel feed already use, so 「谁在这个
   * Task 上」 never gains a second definition. Archived Channels are already
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
        row: Object.freeze({ taskRef: task.taskRef, threadRef: thread.threadRef, channelRef: task.channelRef,
          ...(taskNumber === undefined ? {} : { taskNumber }), status: task.status,
          subject: boundedInboxPreview(this.threadAnchor(thread.threadRef).body),
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

  /** Resolve one Task's Thread for a workspace-authorized actor; Member actors must belong to the Task's Channel. */
  private threadForActor(actor: AgentTeamHumanActor | AgentTeamMemberActor, workspaceId: WorkspaceId, taskRef: AgentTeamTaskRef): { readonly task: AgentTeamTask; readonly thread: AgentTeamThread } {
    const task = this.requireTask(workspaceId, taskRef)
    const thread = this.requireThread(task.threadRef)
    // Archived Channels do not exist on Team API surfaces: their Tasks and
    // Claims are unreachable for reads (listClaims) as for writes.
    this.assertThreadChannelActive(task.channelRef)
    if (actor.kind === 'member') this.requireMemberChannel(this.requireMember(actor.memberId), task.channelRef)
    return { task, thread }
  }

  /** Business outcomes that defer a thread write: unread work first, then a stale revision. */
  private deferredThreadWrite(actorMemberId: AgentTeamMemberId, task: AgentTeamTask | undefined, thread: AgentTeamThread, baseRevision: number): AgentTeamUnreadRequired | AgentTeamStaleRevision | undefined {
    const unread = this.unreadFor(actorMemberId, thread.threadRef)
    if (unread.length > 0) return this.unreadRequired(task, thread, unread)
    if (baseRevision !== thread.revision) return this.staleRevision(task, thread, baseRevision)
    return undefined
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
   * Display numbers for Tasks: one counter per home Channel, in creation
   * order. This is the single numbering authority — Channel cards, Thread
   * headings, cross-channel ref resolution, and inbox renders all show the
   * ordinal the Task holds inside its own Channel. The ordinals are derived
   * at replay time (`taskNumberByTask`); this read only filters them to one
   * Workspace.
   */
  private taskNumbers(workspaceId: WorkspaceId): Map<AgentTeamTaskRef, number> {
    const numbers = new Map<AgentTeamTaskRef, number>()
    for (const [taskRef, taskNumber] of this.state.taskNumberByTask) {
      const task = this.state.tasks.get(taskRef)
      if (task === undefined || this.state.channels.get(task.channelRef)?.workspaceId !== workspaceId) continue
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
      this.apply(operation)
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

  private assertHumanActor(actor: AgentTeamHumanActor): void {
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
      const candidates = [...map.keys()].filter(candidate => candidate.slice(prefix.length + 1).replaceAll('-', '').startsWith(lower))
      if (candidates.length > 1) {
        throw new Error(`ambiguous ${label} ref '${ref}' matches ${candidates.map(candidate => `'${candidate}'`).join(', ')}; reuse a longer prefix or the full ref exactly as returned by Team tools`)
      }
    }
    throw new Error(`unknown ${label} ref '${ref}'${this.unknownRefHint(ref, prefix, label)}`)
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
    if (this.state.channels.get(task.channelRef)?.workspaceId !== workspaceId) throw new Error(`Task '${taskRef}' does not belong to Workspace '${workspaceId}'`)
    return task
  }

  private requireThread(threadRef: AgentTeamThreadRef): AgentTeamThread {
    const thread = this.state.threads.get(this.requireRefKey(this.state.threads, threadRef, 'thread', 'Thread'))
    if (thread === undefined) throw new Error(`unknown Thread ref '${threadRef}'${this.unknownRefHint(threadRef, 'thread', 'Thread')}`)
    return thread
  }

  private channelRefForThread(threadRef: AgentTeamThreadRef): AgentTeamChannelRef | undefined {
    return this.channelRefForThreadFrom(this.state, threadRef)
  }

  private channelRefForThreadFrom(projection: Projection, threadRef: AgentTeamThreadRef): AgentTeamChannelRef | undefined {
    return projection.channelRefByThread.get(threadRef)
  }

  private threadContextForActor(
    actor: AgentTeamHumanActor | AgentTeamMemberActor,
    workspaceId: WorkspaceId,
    request: { threadRef?: AgentTeamThreadRef | undefined; taskRef?: AgentTeamTaskRef | undefined },
  ): { readonly task?: AgentTeamTask; readonly thread: AgentTeamThread; readonly channelRef: AgentTeamChannelRef } {
    const resolved = this.threadContextFrom(this.state, workspaceId, request)
    if (actor.kind === 'member') this.requireMemberChannel(this.requireMember(actor.memberId), resolved.channelRef)
    return resolved
  }

  private threadContextFrom(
    projection: Projection,
    workspaceId: WorkspaceId,
    request: { threadRef?: AgentTeamThreadRef | undefined; taskRef?: AgentTeamTaskRef | undefined },
  ): { readonly task?: AgentTeamTask; readonly thread: AgentTeamThread; readonly channelRef: AgentTeamChannelRef } {
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
    const channelRef = this.channelRefForThreadFrom(projection, thread.threadRef)
    if (channelRef === undefined) throw new Error(`Thread '${thread.threadRef}' has no Channel`)
    if (projection.channels.get(channelRef)?.workspaceId !== workspaceId) throw new Error(`Thread '${thread.threadRef}' does not belong to Workspace '${workspaceId}'`)
    // Archived Channels do not exist on Team API surfaces: their Threads are
    // unreachable by ref, for reads as for writes. Replay stays honest —
    // operations predating the archival resolve against the then-active
    // Channel because replay applies in sequence.
    if (projection.channels.get(channelRef)?.state === 'archived') {
      throw new Error(`Channel '${channelRef}' is archived and no longer accepts Team work`)
    }
    if (task !== undefined && task.channelRef !== channelRef) throw new Error(`Task '${task.taskRef}' does not belong to Thread '${thread.threadRef}'`)
    return { ...(task === undefined ? {} : { task }), thread, channelRef }
  }

  private requireChannel(workspaceId: WorkspaceId, channelRef: AgentTeamChannelRef): AgentTeamChannel {
    const channel = this.state.channels.get(this.requireRefKey(this.state.channels, channelRef, 'channel', 'Channel'))
    if (channel === undefined) throw new Error(`unknown Channel ref '${channelRef}'${this.unknownRefHint(channelRef, 'channel', 'Channel')}`)
    if (channel.workspaceId !== workspaceId) throw new Error(`Channel '${channelRef}' does not belong to Workspace '${workspaceId}'`)
    return channel
  }

  /** Guard for every mutating or Channel-scoped surface flow: archived Channels reject. */
  private requireActiveChannel(workspaceId: WorkspaceId, channelRef: AgentTeamChannelRef): AgentTeamChannel {
    const channel = this.requireChannel(workspaceId, channelRef)
    if (channel.state === 'archived') throw new Error(`Channel '${channelRef}' is archived and no longer accepts Team work`)
    return channel
  }

  /** Thread-mutation guard: the Channel owning the Thread must still be active. */
  private assertThreadChannelActive(channelRef: AgentTeamChannelRef): void {
    if (this.state.channels.get(channelRef)?.state === 'archived') {
      throw new Error(`Channel '${channelRef}' is archived and no longer accepts Team work`)
    }
  }

  private requireMember(memberId: AgentTeamMemberId): AgentTeamAgentMember {
    const member = this.state.members.get(this.requireRefKey(this.state.members, memberId, 'member', 'Agent Member'))
    if (member === undefined) throw new Error(`unknown Agent Member '${memberId}'`)
    return member
  }

  private requireMemberChannel(member: AgentTeamAgentMember, channelRef: AgentTeamChannelRef): void {
    if (!this.isChannelMember(channelRef, member.memberId)) throw new Error(`Agent Member '${member.memberId}' is not authorized for Channel '${channelRef}'`)
  }

  private isChannelMember(channelRef: AgentTeamChannelRef, memberId: AgentTeamMemberId): boolean {
    return this.state.memberships.get(channelRef)?.has(memberId) === true
  }

  private isChannelMemberFrom(projection: Projection, channelRef: AgentTeamChannelRef, memberId: AgentTeamMemberId): boolean {
    return projection.memberships.get(channelRef)?.has(memberId) === true
  }

  /** Every Thread of the Channel, taskful or taskless — the scope both cleanup validators replay against. */
  private channelThreadRefs(channelRef: AgentTeamChannelRef): Set<AgentTeamThreadRef> {
    return this.channelThreadRefsFrom(this.state, channelRef)
  }

  private channelThreadRefsFrom(projection: Projection, channelRef: AgentTeamChannelRef): Set<AgentTeamThreadRef> {
    return new Set([...projection.threads.keys()].filter(threadRef => this.channelRefForThreadFrom(projection, threadRef) === channelRef))
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

  private workspaceThreadRefsFrom(projection: Projection, workspaceId: WorkspaceId): Set<AgentTeamThreadRef> {
    return new Set([...projection.threads.keys()].filter(threadRef => {
      const channelRef = this.channelRefForThreadFrom(projection, threadRef)
      return channelRef !== undefined && projection.channels.get(channelRef)?.workspaceId === workspaceId
    }))
  }

  private assertJoinableMember(workspaceId: WorkspaceId, memberId: AgentTeamMemberId): void {
    const member = this.requireMember(memberId)
    if (!this.participatesIn(memberId, workspaceId)) throw new Error(`Agent Member '${memberId}' does not participate in Workspace '${workspaceId}'`)
    if (member.state !== 'enabled') throw new Error(`Agent Member '${memberId}' is ${member.state}; only enabled Members can join a Channel`)
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
   * Names a Message body may address in one Channel: every live Member of that
   * Channel plus the Human. A name outside this set stays prose, which is what
   * keeps an incidental name-drop from reaching someone the Channel cannot
   * deliver to.
   *
   * The Human is reachable under two names: the current display handle and the
   * permanent `human` alias, so a rename never silently orphans `@human`
   * (matching ignores case, and chips render the display name either way).
   * The alias yields when another candidate already answers to it, so one
   * written name never notifies two different Members; enrollment reserves the
   * literal, so that yield only ever covers data predating the reservation.
   */
  private mentionCandidatesFor(channelRef: AgentTeamChannelRef): readonly AgentTeamBodyMentionCandidate[] {
    const candidates: AgentTeamBodyMentionCandidate[] = [{ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, handle: this.humanHandle }]
    for (const member of this.state.members.values()) {
      if (member.state === 'inactive' || member.state === 'archived') continue
      if (!this.isChannelMember(channelRef, member.memberId)) continue
      candidates.push({ memberId: member.memberId, handle: member.handle })
    }
    if (this.humanHandle.normalize('NFKC').trim().toLowerCase() !== AGENT_TEAM_HUMAN_HANDLE
      && !candidates.some(candidate => candidate.handle.normalize('NFKC').trim().toLowerCase() === AGENT_TEAM_HUMAN_HANDLE)) {
      candidates.push({ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, handle: AGENT_TEAM_HUMAN_HANDLE })
    }
    return Object.freeze(candidates)
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
    if (parent === undefined) throw new Error(`reply target '${ref}' is not a recorded Message`)
    if (parent.threadRef !== threadRef) throw new Error(`reply target '${ref}' belongs to another Thread`)
    return parent
  }

  /**
   * Merge the `@Handle` mentions authored in `body` into an explicit recipient
   * set. Body mentions are the primary channel now: an Agent has no recipient
   * parameter to forget, and the same scan serves Human input typed by hand.
   * The result stays a plain recipient set, so every downstream projection —
   * delivery markers, chip rendering, confirmation — is unchanged.
   */
  private mergeBodyMentions(
    sender: AgentTeamMemberId,
    channelRef: AgentTeamChannelRef,
    body: string,
    explicit: readonly AgentTeamMemberId[],
  ): readonly AgentTeamMemberId[] {
    const candidates = this.mentionCandidatesFor(channelRef)
    const resolution = resolveBodyMentions(body, candidates, sender)
    // `@all` stands for its expansion as of this write: the Member set is
    // snapshotted into the recipient list, so a later roster change cannot
    // retroactively alter what this operation delivered.
    const authored = resolution.all ? candidates.map(candidate => candidate.memberId) : resolution.memberIds
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

  /** Provider route and model id are exact identifiers; only whitespace-only values are rejected. */
  private assertModelSelection(model: AgentTeamUpdateMemberRequest['model']): void {
    if (model === undefined) return
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

  private assertSameChannelCreation(operation: AgentTeamOperation, request: AgentTeamAuthorizedCreateChannelRequest, memberIds: readonly AgentTeamMemberId[]): asserts operation is AgentTeamChannelCreatedOperation {
    if (operation.kind !== 'team/channel-created' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.channel.name !== request.name.trim()
      || operation.data.channel.description !== request.description.trim() || !this.sameList(operation.data.memberIds, memberIds)) this.throwRequestCollision(request.requestId)
  }

  private assertSameMemberAdd(operation: AgentTeamOperation, request: AgentTeamAuthorizedAddMemberRequest): asserts operation is AgentTeamMemberAddedOperation {
    if (operation.kind !== 'team/member-added' || !this.sameActor(operation.actor, request.actor)
      || operation.data.member.workspaceId !== request.workspaceId || operation.data.member.handle !== request.handle.trim()
      || operation.data.member.description !== request.description.trim() || operation.data.member.presetId !== request.presetId.trim()
      || !isDeepStrictEqual(operation.data.member.model ?? undefined, request.member.model ?? undefined)
      || !isDeepStrictEqual(operation.data.member.capabilities ?? undefined, request.member.capabilities ?? undefined)
      || !this.sameList(operation.data.channelRefs, this.normalizeUnique(request.channelRefs, 'initial Member Channels'))) this.throwRequestCollision(request.requestId)
  }

  private assertSameMemberState(operation: AgentTeamOperation, request: AgentTeamAuthorizedSetMemberStateRequest, state: 'enabled' | 'suspended'): asserts operation is AgentTeamMemberSuspendedOperation | AgentTeamMemberResumedOperation {
    const kind = state === 'suspended' ? 'team/member-suspended' : 'team/member-resumed'
    if (operation.kind !== kind || !this.sameActor(operation.actor, request.actor) || operation.data.member.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameMemberSessionRenewed(operation: AgentTeamOperation, request: AgentTeamAuthorizedRenewMemberSessionRequest): asserts operation is AgentTeamMemberSessionRenewedOperation {
    if (operation.kind !== 'team/member-session-renewed' || !this.sameActor(operation.actor, request.actor)
      || operation.data.member.memberId !== request.memberId || operation.data.member.sessionId !== request.sessionId) this.throwRequestCollision(request.requestId)
  }

  private assertSameMemberSessionRolledOver(operation: AgentTeamOperation, request: AgentTeamAuthorizedRolloverMemberSessionRequest): asserts operation is AgentTeamMemberSessionRolledOverOperation {
    if (operation.kind !== 'team/member-session-rolled-over' || !this.sameActor(operation.actor, request.actor)
      || operation.data.member.memberId !== request.memberId || operation.data.member.sessionId !== request.newSessionId
      || operation.data.previousSessionId !== request.previousSessionId || operation.data.handoffEventSeq !== request.handoffEventSeq
      || operation.data.trigger !== request.trigger
      || operation.data.sourceSessionId !== request.sourceSessionId
      || operation.data.sourceThroughSeq !== request.sourceThroughSeq
      || operation.data.checkpointRef !== request.checkpointRef) this.throwRequestCollision(request.requestId)
  }

  private assertSameChannelUpdate(operation: AgentTeamOperation, request: AgentTeamAuthorizedUpdateChannelRequest): asserts operation is AgentTeamChannelUpdatedOperation {
    if (operation.kind !== 'team/channel-updated' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.channel.channelRef !== request.channelRef
      || operation.data.channel.name !== request.name.trim() || operation.data.channel.description !== request.description.trim()) this.throwRequestCollision(request.requestId)
  }

  private assertSameMemberUpdate(operation: AgentTeamOperation, request: AgentTeamAuthorizedUpdateMemberRequest): asserts operation is AgentTeamMemberUpdatedOperation {
    if (operation.kind !== 'team/member-updated' || !this.sameActor(operation.actor, request.actor)
      || operation.data.member.memberId !== request.memberId || operation.data.member.handle !== request.handle.trim()
      || operation.data.member.description !== request.description.trim()
      || !isDeepStrictEqual(operation.data.member.model ?? undefined, request.model ?? undefined)
      || !isDeepStrictEqual(operation.data.member.capabilities ?? undefined, request.capabilities ?? undefined)) this.throwRequestCollision(request.requestId)
  }

  private assertSameChannelJoin(operation: AgentTeamOperation, request: AgentTeamAuthorizedJoinChannelRequest): asserts operation is AgentTeamChannelMemberAddedOperation {
    if (operation.kind !== 'team/channel-member-added' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.channelRef !== request.channelRef || operation.data.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameChannelMemberRemoval(operation: AgentTeamOperation, request: AgentTeamAuthorizedRemoveChannelMemberRequest): asserts operation is AgentTeamChannelMemberRemovedOperation {
    if (operation.kind !== 'team/channel-member-removed' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.channelRef !== request.channelRef || operation.data.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameWorkspaceJoin(operation: AgentTeamOperation, request: AgentTeamAuthorizedJoinWorkspaceRequest): asserts operation is AgentTeamMemberWorkspaceJoinedOperation {
    if (operation.kind !== 'team/member-workspace-joined' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameWorkspaceLeave(operation: AgentTeamOperation, request: AgentTeamAuthorizedLeaveWorkspaceRequest): asserts operation is AgentTeamMemberWorkspaceLeftOperation {
    if (operation.kind !== 'team/member-workspace-left' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.memberId !== request.memberId) this.throwRequestCollision(request.requestId)
  }

  private assertSameChannelArchival(operation: AgentTeamOperation, request: AgentTeamAuthorizedArchiveChannelRequest): asserts operation is AgentTeamChannelArchivedOperation {
    if (operation.kind !== 'team/channel-archived' || !this.sameActor(operation.actor, request.actor)
      || operation.data.workspaceId !== request.workspaceId || operation.data.channel.channelRef !== request.channelRef) this.throwRequestCollision(request.requestId)
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
      || operation.data.workspaceId !== request.workspaceId || operation.data.message.channelRef !== request.channelRef
      || operation.data.message.body !== request.body.trim() || !this.sameList(operation.data.mentions, recipients)
      || !this.sameList(operation.data.message.attachments?.map(attachment => attachment.attachmentId) ?? [],
        request.resolvedAttachments?.map(attachment => attachment.attachmentId) ?? [])
      || (request.asTask !== false) !== (operation.data.task !== undefined)) this.throwRequestCollision(request.requestId)
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
    return left.taskRef === right.taskRef && left.channelRef === right.channelRef && left.threadRef === right.threadRef
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
    return left.memberId === right.memberId && left.sessionId === right.sessionId && left.workspaceId === right.workspaceId
      && left.handle === right.handle && left.description === right.description && left.presetId === right.presetId
      && isDeepStrictEqual(left.model ?? undefined, right.model ?? undefined)
      && left.privateMemoryPath === right.privateMemoryPath
  }

  /** sameMemberIdentity minus the sessionId: every durable Member fact a session renewal must carry over unchanged. */
  private sameMemberFacts(left: AgentTeamAgentMember, right: AgentTeamAgentMember): boolean {
    return left.memberId === right.memberId && left.workspaceId === right.workspaceId
      && left.handle === right.handle && left.description === right.description && left.presetId === right.presetId
      && isDeepStrictEqual(left.model ?? undefined, right.model ?? undefined)
      && left.privateMemoryPath === right.privateMemoryPath
  }

  private sameActor(left: AgentTeamHumanActor | AgentTeamMemberActor, right: AgentTeamHumanActor | AgentTeamMemberActor): boolean {
    return left.kind === right.kind && left.memberId === right.memberId && left.handle === right.handle
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

  private addMembership(target: Pick<Projection, 'memberships'>, channelRef: AgentTeamChannelRef, memberId: AgentTeamMemberId): void {
    const members = target.memberships.get(channelRef) ?? new Set<AgentTeamMemberId>()
    members.add(memberId)
    target.memberships.set(channelRef, members)
  }

  private addRef(refs: Set<string>, ref: string): void {
    if (refs.has(ref)) throw new Error(`agent-team ledger repeats entity ref '${ref}'`)
    refs.add(ref)
  }

  private throwRequestCollision(requestId: AgentTeamRequestId): never {
    throw new Error(`agent-team request id '${requestId}' was reused with a different operation or payload`)
  }

  private channelResult(operation: AgentTeamChannelCreatedOperation): AgentTeamCreateChannelResult {
    return Object.freeze({ receipt: this.receipt(operation), channel: operation.data.channel, memberIds: operation.data.memberIds })
  }

  private channelUpdateResult(operation: AgentTeamChannelUpdatedOperation): AgentTeamUpdateChannelResult {
    return Object.freeze({ receipt: this.receipt(operation), channel: operation.data.channel })
  }

  private memberResult(operation: AgentTeamMemberAddedOperation | AgentTeamMemberSuspendedOperation | AgentTeamMemberResumedOperation | AgentTeamMemberSessionRestartedOperation | AgentTeamMemberSessionRenewedOperation | AgentTeamMemberSessionRolledOverOperation | AgentTeamMemberUpdatedOperation): AgentTeamDurableMemberResult {
    return Object.freeze({ receipt: this.receipt(operation), member: operation.data.member })
  }

  private joinResult(operation: AgentTeamChannelMemberAddedOperation): AgentTeamJoinChannelResult {
    return Object.freeze({ receipt: this.receipt(operation), channelRef: operation.data.channelRef, memberId: operation.data.memberId })
  }

  private channelMemberRemovalResult(operation: AgentTeamChannelMemberRemovedOperation): AgentTeamRemoveChannelMemberResult {
    return Object.freeze({ receipt: this.receipt(operation), channelRef: operation.data.channelRef, memberId: operation.data.memberId,
      releasedClaims: operation.data.claims, removedAttention: operation.data.inbox.attention.removed })
  }

  private workspaceJoinResult(operation: AgentTeamMemberWorkspaceJoinedOperation): AgentTeamJoinWorkspaceResult {
    return Object.freeze({ receipt: this.receipt(operation), memberId: operation.data.memberId, workspaceId: operation.data.workspaceId })
  }

  private workspaceLeaveResult(operation: AgentTeamMemberWorkspaceLeftOperation): AgentTeamLeaveWorkspaceResult {
    return Object.freeze({ receipt: this.receipt(operation), memberId: operation.data.memberId, workspaceId: operation.data.workspaceId,
      releasedClaims: operation.data.claims, removedAttention: operation.data.inbox.attention.removed })
  }

  private channelArchivalResult(operation: AgentTeamChannelArchivedOperation): AgentTeamArchiveChannelResult {
    return Object.freeze({ receipt: this.receipt(operation), channel: operation.data.channel,
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

  private operationBase(request: { readonly requestId: AgentTeamRequestId; readonly actor: AgentTeamHumanActor | AgentTeamMemberActor }, sequence: number) {
    return { sequence, operationId: this.createOperationId(), requestId: request.requestId, occurredAt: this.createOccurredAt(),
      actor: Object.freeze({ ...request.actor }), previousOperationId: this.state.ordered.at(-1)?.operationId ?? null }
  }

  private nextSequence(): number {
    if (this.state.ordered.length === 0) throw new Error('agent-team ledger is not initialized')
    return this.state.ordered.length + 1
  }

  private ref(kind: 'channel'): AgentTeamChannelRef
  private ref(kind: 'message'): AgentTeamMessageRef
  private ref(kind: 'task'): AgentTeamTaskRef
  private ref(kind: 'thread'): AgentTeamThreadRef
  private ref(kind: 'claim'): AgentTeamClaimRef
  private ref(kind: 'activity'): AgentTeamActivityRef
  private ref(kind: 'channel' | 'message' | 'task' | 'thread' | 'claim' | 'activity') {
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
      const normalized = this.repairLegacyChannelCleanup(this.normalizeOperation(operation, occurrences, instants), projection)
      this.applyTo(projection, normalized)
      return [id, normalized]
    })
  }

  /**
   * Releases up to 0.1.9 scoped Channel archival and Channel member-removal
   * inbox cleanup to taskful Threads only (the collector read the Task
   * projection), so archiving or member removal in a Channel holding a
   * taskless Thread with Attention or markers wrote an incomplete inbox and
   * every later load rejected the record, leaving the profile unable to boot.
   * Records carrying exactly that legacy cleanup are repaired in memory the
   * same way pre-envelope Thread reads are; any other inbox still fails
   * validation, so a forgery is not silently accepted.
   */
  private repairLegacyChannelCleanup(operation: AgentTeamOperation, projection: Projection): AgentTeamOperation {
    if (operation.kind === 'team/channel-archived') {
      const channelRef = operation.data.channel.channelRef
      const expected = this.channelArchivalInboxFrom(projection, this.channelThreadRefsFrom(projection, channelRef))
      if (!isDeepStrictEqual(operation.data.inbox, expected)
        && isDeepStrictEqual(operation.data.inbox, this.channelArchivalInboxFrom(projection, this.legacyChannelThreadRefs(projection, channelRef)))) {
        return { ...operation, data: { ...operation.data, inbox: expected } }
      }
      return operation
    }
    if (operation.kind === 'team/channel-member-removed') {
      const { channelRef, memberId } = operation.data
      const expected = this.removeMemberThreadInboxFrom(projection, memberId, this.channelThreadRefsFrom(projection, channelRef))
      if (!isDeepStrictEqual(operation.data.inbox, expected)
        && isDeepStrictEqual(operation.data.inbox, this.removeMemberThreadInboxFrom(projection, memberId, this.legacyChannelThreadRefs(projection, channelRef)))) {
        return { ...operation, data: { ...operation.data, inbox: expected } }
      }
      return operation
    }
    return operation
  }

  /** The pre-fix Channel Thread scope: only Threads carrying a Task. */
  private legacyChannelThreadRefs(projection: Projection, channelRef: AgentTeamChannelRef): Set<AgentTeamThreadRef> {
    return new Set([...projection.tasks.values()].filter(task => task.channelRef === channelRef).map(task => task.threadRef))
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
