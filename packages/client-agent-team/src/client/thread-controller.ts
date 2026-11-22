import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamClaim,
  AgentTeamClientMemberStatus,
  AgentTeamMemberId,
  AgentTeamMessageRef,
  AgentTeamOperationReceipt,
  AgentTeamRequestId,
  AgentTeamStaleRevision,
  AgentTeamTask,
  AgentTeamTaskActivity,
  AgentTeamTaskRef,
  AgentTeamThread,
  AgentTeamThreadFact,
  AgentTeamThreadReadFact,
  AgentTeamThreadReadResult,
  AgentTeamThreadRef,
  AgentTeamThreadTaskCard,
  AgentTeamUnreadRequired,
  AgentTeamWorkerRef,
  AgentTeamWorkerStateView,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import type { ReplyTarget } from './composer-sends.ts'
import type { TimelineScroll } from './timeline-scroll.ts'
import type { ThreadFollowerObservation } from './thread-observation.ts'
import { useThreadControllerState } from './thread-controller-state.ts'
import { useThreadOpenPhase } from './thread-controller-open.ts'
import { useThreadReadPhase } from './thread-controller-read.ts'
import { useThreadHistoryPhase } from './thread-controller-history.ts'
import { useThreadWritePhase } from './thread-controller-write.ts'
import { useThreadPresentation } from './thread-controller-presentation.ts'

export interface TeamThreadControllerOptions {
  readonly workspaceId: WorkspaceId
  readonly threadRef: AgentTeamThreadRef
  readonly taskRef?: AgentTeamTaskRef | undefined
  readonly readThread: TeamConversationProps['readThread']
  readonly loadThreadHistory: TeamConversationProps['loadThreadHistory']
  readonly threadObservations: TeamConversationProps['threadObservations']
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly resolveMessageRefs: TeamConversationProps['resolveMessageRefs']
  readonly reply: TeamConversationProps['reply']
  readonly drafts: TeamDraftStore
  readonly putAttachment: TeamConversationProps['putAttachment']
  /** The Workspace roster at send time, for the optimistic mention chips a committed reply merges before the Host's own facts land — under rules version 9 a mention can land on any enabled Workspace Member. */
  readonly workspaceMembers: () => readonly AgentTeamClientMemberStatus[]
  /** One Member's display name, for the composer's quote banner. */
  readonly memberName: (memberId: AgentTeamMemberId) => string
  readonly t: TeamConversationProps['t']
  /** A durable read committed: the surface's unread statement can answer without waiting for another read. */
  readonly onRead?: (() => void) | undefined
  /** Re-reads the surface-owned state a write moved (roster, Project view); the Thread itself is already re-read. */
  readonly afterWrite?: (() => void | Promise<void>) | undefined
  /** Where the first read opens: a Message to centre, or undefined for the latest fact. */
  readonly openingTarget?: ((facts: readonly AgentTeamThreadReadFact[]) => AgentTeamMessageRef | undefined) | undefined
}

type TaskWriteAction = 'promote' | 'task:accept' | 'task:close' | 'task:reopen'
type ThreadWriteAction = 'reply' | TaskWriteAction

/** One durable Task write, with a requestId that an uncertain retry replays. */
interface ThreadWrite {
  readonly key: TaskWriteAction
  readonly write: (requestId: AgentTeamRequestId) => Promise<RemoteResult<CommittedTaskWrite | AgentTeamUnreadRequired | AgentTeamStaleRevision>>
  readonly onCommitted: (committed: CommittedTaskWrite) => void | Promise<void>
}

/** The fields every committed Task write carries, so one merge serves promote, accept, close, and reopen. */
export interface CommittedTaskWrite {
  readonly kind: 'committed'
  readonly receipt: AgentTeamOperationReceipt
  readonly activity: AgentTeamTaskActivity
  readonly task: AgentTeamTask
  readonly thread: AgentTeamThread
  readonly claims?: readonly AgentTeamClaim[] | undefined
}

export interface TeamThreadController {
  readonly projection: AgentTeamThreadReadResult | undefined
  readonly task: AgentTeamTask | undefined
  readonly thread: AgentTeamThread | undefined
  readonly currentFacts: readonly AgentTeamThreadFact[]
  /** Flags from the read that produced the projection; opening a Thread acknowledges them. */
  readonly readFacts: readonly AgentTeamThreadReadFact[]
  readonly olderFacts: readonly AgentTeamThreadFact[]
  readonly taskCards: readonly AgentTeamThreadTaskCard[]
  /** How each Worker run these facts name stands, merged across every read and page, so a window never decides a run's state. */
  readonly workerStates: ReadonlyMap<AgentTeamWorkerRef, AgentTeamWorkerStateView>
  readonly followerObservation: ThreadFollowerObservation
  readonly historyHasMore: boolean
  readonly loading: boolean
  readonly error: string | undefined
  /** A reply or Task write is in flight for this Thread. */
  readonly pending: boolean
  readonly pendingAction: ThreadWriteAction | undefined
  readonly autoReadExhausted: boolean
  readonly newFactsCount: number
  readonly replyTarget: AgentTeamMessageRef | undefined
  /** The composer's quote banner, resolved through the Host and read at render time. */
  readonly replyTo: ReplyTarget | undefined
  readonly pendingFiles: readonly File[]
  readonly draftKey: TeamDraftKey
  readonly flashedMessage: AgentTeamMessageRef | undefined
  readonly timelineRef: TimelineScroll['ref']
  readonly readCurrent: (newRequest?: boolean) => Promise<boolean>
  readonly loadOlder: () => Promise<void>
  readonly refreshAfterFence: () => Promise<void>
  readonly refreshPassiveFacts: () => Promise<void>
  readonly retryAutoRead: () => void
  /** Rejects every follower read already issued in this opening, refreshes the set, and returns the next accepted sequence. */
  readonly invalidateFollowerReads: () => number
  readonly onTimelineScroll: () => void
  readonly jumpToNewest: () => void
  readonly flashMessage: (messageRef: AgentTeamMessageRef) => void
  readonly setReplyTarget: (messageRef: AgentTeamMessageRef | undefined) => void
  readonly setPendingFiles: (files: readonly File[]) => void
  readonly reportError: (message: string) => void
  readonly sendReply: () => Promise<void>
  /** Runs one durable write and converges on the Host's answer for either fence. */
  readonly commit: (spec: ThreadWrite) => Promise<void>
  /** Merges one committed Task write's projection and activity row, then re-reads the Thread. */
  readonly applyTaskCommit: (committed: CommittedTaskWrite) => Promise<void>
}

/**
 * The opening layout effect mints and clears ThreadOpening per workspace/task/thread/draft key;
 * async results belong to that token, not to a Thread revisited later. The read phase alone owns
 * sequenceRef: only its latest bounded read applies, its effect cleanup advances the sequence,
 * and the unread drain yields when a newer read takes the tail. Plain retries replay readRequestId;
 * continuations and acknowledging reads mint it anew.
 *
 * Follower reads have separate sequence/floor/applied counters; invalidateFollowerReads raises
 * the floor after a follow write. History and passive merges need only the opening guard because
 * they are idempotent. The threadRef-keyed writes map survives openings within this mount;
 * mutationRequests belongs to one opening so uncertain retries reuse only that opening's requestId.
 */
export function useTeamThreadController(options: TeamThreadControllerOptions): TeamThreadController {
  const { lifetime, facts, history, feedback, followers, composer, viewport } = useThreadControllerState(options)
  useThreadOpenPhase({ options, lifetime, facts, followers, composer, viewport, feedback })
  const reads = useThreadReadPhase({ options, lifetime, facts, history, followers, viewport, feedback })
  const loadOlder = useThreadHistoryPhase({ options, lifetime, facts, history, feedback })
  const writes = useThreadWritePhase({ options, lifetime, facts, composer, viewport, feedback, reads })
  return useThreadPresentation({ options, lifetime, facts, history, feedback, followers, composer, viewport, reads, loadOlder, writes })
}
