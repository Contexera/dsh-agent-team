import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { mergeSettledComposerUploads, mintRequestId, reconcileComposerUploads, type ComposerUpload } from './requests.ts'
import { useTimelineScroll, type TimelineScroll } from './timeline-scroll.ts'
import { cachedResolvedMessageRef, hostMessageRefLookup, resolveUnknownMessageRefs, useResolvedMessageRefVersion } from './refs.ts'
import { factKey, mergeFacts, messageFact, minSequence } from './thread-facts.ts'
import { mentionedMemberIds } from './team-formatters.ts'
import type { ThreadFollowerObservation } from './thread-observation.ts'

// A bounded read acknowledges at most 20 unread facts and reads never self-wake a change scope,
// so larger backlogs need continuation reads; the cap stops a feed that outpaces reading.
const MAX_AUTO_READ_ROUNDS = 50

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
  /** The Project's roster at send time, for the optimistic mention chips a committed reply merges before the Host's own facts land. */
  readonly projectMembers: () => readonly AgentTeamClientMemberStatus[]
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

interface ThreadOpening {
  readonly threadRef: AgentTeamThreadRef
  readRequestId: AgentTeamRequestId
}

/** One durable Task write, with a requestId that an uncertain retry replays. */
interface ThreadWrite {
  readonly key: TaskWriteAction
  readonly write: (requestId: AgentTeamRequestId) => Promise<RemoteResult<CommittedTaskWrite | AgentTeamUnreadRequired | AgentTeamStaleRevision>>
  readonly onCommitted: (committed: CommittedTaskWrite) => void | Promise<void>
}

/** The fields every committed Task write carries, so one merge serves promote, accept, close, reopen, and transfer. */
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
 * One page instance's read/write coordination for a single Thread: the bounded read and its unread
 * drain, history paging, passive and follower refreshes, the sequence guards that keep a late answer
 * from overwriting a newer one, fact merging, message-ref resolution, and the reply lifecycle.
 *
 * It owns no durable authority. The Host projection and ledger stay the single source of truth, and
 * the copy held here is only what this mount renders from. Both Thread faces drive it and keep their
 * own layout, navigation, and Task controls.
 */
export function useTeamThreadController(options: TeamThreadControllerOptions): TeamThreadController {
  const {
    workspaceId, threadRef, taskRef, readThread, loadThreadHistory, threadObservations, subscribeChanges,
    resolveMessageRefs, reply, drafts, putAttachment, t,
  } = options
  const request = { threadRef, ...(taskRef === undefined ? {} : { taskRef }) }
  const [projection, setProjection] = useState<AgentTeamThreadReadResult>()
  const [currentFacts, setCurrentFacts] = useState<readonly AgentTeamThreadFact[]>([])
  // Tasks derived from this discussion; projection rows, never facts or unread.
  const [taskCards, setTaskCards] = useState<readonly AgentTeamThreadTaskCard[]>([])
  const [olderFacts, setOlderFacts] = useState<readonly AgentTeamThreadFact[]>([])
  const [readFacts, setReadFacts] = useState<readonly AgentTeamThreadReadFact[]>([])
  const [workerStates, setWorkerStates] = useState<ReadonlyMap<AgentTeamWorkerRef, AgentTeamWorkerStateView>>(() => new Map())
  const [historyCursor, setHistoryCursor] = useState<number>()
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [autoReadExhausted, setAutoReadExhausted] = useState(false)
  const [newFactsCount, setNewFactsCount] = useState(0)
  // Current Thread followers; the composer ranks them first because they are already in the conversation.
  const [followerObservation, setFollowerObservation] = useState<ThreadFollowerObservation>(() => ({ ids: new Set(), sequence: 0 }))
  const followerReadSequenceRef = useRef(0)
  const followerReadFloorRef = useRef(0)
  const followerAppliedSequenceRef = useRef(0)
  // The draft cache outlives this page across view switches; the composer owns the subscription so typing never re-renders the timeline.
  const draftKey: TeamDraftKey = `thread:${threadRef}`
  const [replyTarget, setReplyTargetState] = useState<AgentTeamMessageRef>()
  const [flashedMessage, setFlashedMessage] = useState<AgentTeamMessageRef>()
  // The Message this opening lands on, held until its row exists: the jump is
  // decided from the first read, and rows render a paint later.
  const [pendingJump, setPendingJump] = useState<AgentTeamMessageRef>()
  // The target whose opening pulse has already started; released with the pulse. This effect also re-runs while the
  // timeline settles, and a state write on each of those commits would keep re-centring a reader who has already arrived.
  const pulsedRef = useRef<AgentTeamMessageRef>()
  const [pendingAction, setPendingAction] = useState<ThreadWriteAction>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([])
  const activeGenerationRef = useRef<ThreadOpening>()
  const currentFactsRef = useRef<readonly AgentTeamThreadFact[]>([])
  const sequenceRef = useRef(0)
  const projectionRef = useRef<AgentTeamThreadReadResult>()
  const mutationRequests = useRef(new Map<TaskWriteAction, AgentTeamRequestId>())
  const writes = useRef(new Map<AgentTeamThreadRef, ThreadWriteAction>())
  const uploads = useRef<readonly ComposerUpload[]>([])
  const isCurrentOpen = (generation: ThreadOpening): boolean => activeGenerationRef.current === generation
  const setReplyTarget = useCallback((next: AgentTeamMessageRef | undefined): void => {
    drafts.replies.changeSelection(draftKey)
    setReplyTargetState(next)
  }, [drafts, draftKey])
  const changePendingFiles = useCallback((files: readonly File[]): void => {
    uploads.current = reconcileComposerUploads(files, uploads.current)
    drafts.replies.changeSelection(draftKey)
    setPendingFiles(files)
  }, [drafts, draftKey])
  const clearReplySelection = (): void => {
    uploads.current = []
    setReplyTargetState(undefined)
    setPendingFiles([])
  }
  const threadLastFact = currentFacts[currentFacts.length - 1]
  const timeline = useTimelineScroll(`${currentFacts.length}:${olderFacts.length}:${threadLastFact === undefined ? '' : factKey(threadLastFact)}`)
  // The hook returns a fresh object per render, but this callback is stable: the
  // opening jump depends on it without re-running on every render.
  const timelineOnScroll = timeline.onScroll

  // Every read and history page carries the runs its own facts name; merging keeps a run's
  // state after a later page stops mentioning it — what "unconfirmed" must not depend on.
  const mergeWorkerStates = (next: readonly AgentTeamWorkerStateView[] | undefined): void => {
    if (next === undefined) return
    setWorkerStates(current => new Map([...current, ...next.map(view => [view.workerRef, view] as const)]))
  }

  const updateProjection = (next: AgentTeamThreadReadResult): void => {
    projectionRef.current = next
    setProjection(next)
    setReadFacts(next.facts)
    mergeWorkerStates(next.workerStates)
    const anchor = messageFact(next.anchor, next.anchorMentions)
    const batch = [anchor, ...next.facts.map(fact => fact.fact)]
    setCurrentFacts(current => {
      const merged = mergeFacts(current, batch)
      currentFactsRef.current = merged
      return merged
    })
  }

  // Each round mints a fresh requestId (the Host replays a repeated id from its idempotency cache). Terminates on a zero
  // remainder, a failed read, a superseding sequence, or the round cap.
  const drainUnread = async (): Promise<void> => {
    const generation = activeGenerationRef.current
    if (generation === undefined) return
    for (let round = 1; round <= MAX_AUTO_READ_ROUNDS; round += 1) {
      if (!isCurrentOpen(generation)) return
      const snapshot = projectionRef.current
      if (snapshot === undefined || snapshot.remainingUnreadCount <= 0) return
      const beforeSequence = sequenceRef.current
      if (!await readCurrent(true)) return
      // A newer read or remount owns the tail now; it drains the remainder.
      if (!isCurrentOpen(generation) || sequenceRef.current !== beforeSequence + 1) return
      // A stalled remainder (Host fault) must not spin the loop.
      if (projectionRef.current?.remainingUnreadCount === snapshot.remainingUnreadCount) return
    }
    setAutoReadExhausted(true)
  }

  const readCurrent = async (newRequest = false): Promise<boolean> => {
    const generation = activeGenerationRef.current
    if (generation === undefined) return false
    if (newRequest) generation.readRequestId = mintRequestId()
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    setLoading(true)
    try {
      const result = await readThread({ requestId: generation.readRequestId, workspaceId, ...request })
      if (!isCurrentOpen(generation) || sequence !== sequenceRef.current) return false
      if (!result.ok) { setError(result.error.message); return false }
      updateProjection(result.value)
      setError(undefined)
      options.onRead?.()
      return true
    } catch (cause) {
      if (isCurrentOpen(generation) && sequence === sequenceRef.current) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (isCurrentOpen(generation) && sequence === sequenceRef.current) setLoading(false)
    }
  }

  const refreshPassiveFacts = async (): Promise<void> => {
    const generation = activeGenerationRef.current
    if (generation === undefined) return
    try {
      const result = await loadThreadHistory({ workspaceId, ...request, limit: 100 })
      if (!isCurrentOpen(generation) || !result.ok) return
      setTaskCards(result.value.taskCards ?? [])
      const incoming = result.value.facts
      const shown = currentFactsRef.current
      if (shown.length === 0) return
      const known = new Set(shown.map(fact => factKey(fact)))
      // Facts older than everything rendered are backfill of the wider history window, not new updates; counting them would re-flag read messages.
      const newestShown = shown.reduce((maximum, fact) => Math.max(maximum, fact.sequence), 0)
      const additions = incoming.filter(fact => !known.has(factKey(fact)) && fact.sequence > newestShown)
      setCurrentFacts(current => {
        const merged = mergeFacts(current, incoming)
        currentFactsRef.current = merged
        return merged
      })
      setProjection(current => {
        const next = current === undefined ? current : { ...current, ...(result.value.task === undefined ? {} : { task: result.value.task }), thread: result.value.thread, claims: result.value.claims }
        if (next !== undefined) projectionRef.current = next
        return next
      })
      if (additions.length === 0) return
      // Every arrival while the Thread is open is acknowledged durably. The count only feeds the
      // jump hint for a reader away from the tail.
      if (!timeline.isPinned()) setNewFactsCount(current => current + additions.length)
      // The acknowledgment outcome does not change what is on screen: a
      // failed read surfaces through the error surface, not through the count.
      await readCurrent(true)
    } catch {
    }
  }

  const applyFollowerObservation = useCallback((generation: ThreadOpening, sequence: number, followers: readonly AgentTeamMemberId[]): void => {
    if (activeGenerationRef.current !== generation || sequence < followerReadFloorRef.current || sequence <= followerAppliedSequenceRef.current) return
    followerAppliedSequenceRef.current = sequence
    setFollowerObservation({ ids: new Set(followers), sequence })
  }, [])

  // Follower ranking is an enhancement, not a page fact: a failed observation
  // read leaves the roster order in place instead of surfacing an error.
  const refreshFollowers = useCallback(async (): Promise<void> => {
    const generation = activeGenerationRef.current
    if (generation === undefined) return
    const sequence = ++followerReadSequenceRef.current
    try {
      const result = await threadObservations({ workspaceId, ...request })
      if (result.ok) applyFollowerObservation(generation, sequence, result.value.followers)
    } catch {
    }
  }, [applyFollowerObservation, threadObservations, workspaceId, threadRef, taskRef])

  const invalidateFollowerReads = useCallback((): number => {
    followerReadFloorRef.current = Math.max(followerReadFloorRef.current, followerReadSequenceRef.current + 1)
    void refreshFollowers()
    return followerReadFloorRef.current
  }, [refreshFollowers])

  // Returning to the same Thread must not revive a response from its earlier opening.
  useLayoutEffect(() => {
    const generation = { threadRef, readRequestId: mintRequestId() }
    activeGenerationRef.current = generation
    followerReadSequenceRef.current = 0
    followerReadFloorRef.current = 0
    followerAppliedSequenceRef.current = 0
    projectionRef.current = undefined
    mutationRequests.current.clear()
    const replyDraft = drafts.replies.restore(draftKey)
    uploads.current = replyDraft?.uploads ?? []
    setPendingAction(writes.current.get(threadRef))
    setReplyTargetState(replyDraft?.address.replyToMessageRef)
    setPendingFiles(uploads.current.map(upload => upload.file))
    setFlashedMessage(undefined)
    void replyDraft?.pending?.then(settled => {
      if (isCurrentOpen(generation) && settled.kind === 'answered' && settled.clearedDraft && drafts.getSnapshot(draftKey).draft === '') {
        clearReplySelection()
      }
    })
    return () => {
      if (activeGenerationRef.current !== generation) return
      activeGenerationRef.current = undefined
    }
  }, [workspaceId, taskRef, threadRef, drafts, draftKey])

  useEffect(() => {
    const generation = activeGenerationRef.current
    if (generation === undefined) return
    setProjection(undefined)
    setFollowerObservation({ ids: new Set(), sequence: 0 })
    setCurrentFacts([])
    setTaskCards([])
    currentFactsRef.current = []
    setOlderFacts([])
    setReadFacts([])
    setWorkerStates(new Map())
    setHistoryCursor(undefined)
    setHistoryHasMore(false)
    setAutoReadExhausted(false)
    setNewFactsCount(0)
    setPendingJump(undefined)
    pulsedRef.current = undefined
    setError(undefined)
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    const followerSequence = ++followerReadSequenceRef.current
    setLoading(true)
    void (async () => {
      const [read, history, observations] = await Promise.all([
        readThread({ requestId: generation.readRequestId, workspaceId, ...request }),
        loadThreadHistory({ workspaceId, ...request, limit: 20 }).catch(() => undefined),
        threadObservations({ workspaceId, ...request }).catch(() => undefined),
      ])
      if (!isCurrentOpen(generation) || sequence !== sequenceRef.current) return
      if (history !== undefined && history.ok) setTaskCards(history.value.taskCards ?? [])
      if (!read.ok) {
        setError(read.error.message)
        setLoading(false)
        return
      }
      updateProjection(read.value)
      options.onRead?.()
      // Open on the Message the surface says this Thread opens on, decided from this first read before
      // the acknowledgement clears the flags; no answer opens at the latest fact.
      const addressed = options.openingTarget?.(read.value.facts)
      if (addressed === undefined) timeline.scrollToBottom()
      else setPendingJump(addressed)
      if (history !== undefined && history.ok) {
        setCurrentFacts(current => {
          const merged = mergeFacts(current, history.value.facts)
          currentFactsRef.current = merged
          return merged
        })
        setHistoryCursor(history.value.cursor)
        setHistoryHasMore(history.value.hasMore)
      } else {
        // A rejected or refused history read must not take the only way back to older facts with it: pressing the affordance pages under its own error surface.
        setHistoryHasMore(true)
      }
      if (observations !== undefined && observations.ok) applyFollowerObservation(generation, followerSequence, observations.value.followers)
      setError(undefined)
      setLoading(false)
      await drainUnread()
    })()
    const disposers = [
      subscribeChanges({ kind: 'thread', threadRef }, update => {
        if (!isCurrentOpen(generation)) return
        if (update.type === 'failed') { setError(update.message); return }
        void refreshPassiveFacts()
        void refreshFollowers()
      }),
    ]
    return () => {
      sequenceRef.current += 1
      for (const dispose of disposers) dispose()
    }
  }, [workspaceId, taskRef, threadRef])

  // Returning to the bottom answers the jump hint: arrivals are on screen and their durable read already happened or will be retried.
  useEffect(() => {
    if (newFactsCount > 0 && timeline.isPinned()) setNewFactsCount(0)
  }, [newFactsCount, currentFacts, olderFacts, timeline])

  const loadOlder = async (): Promise<void> => {
    const generation = activeGenerationRef.current
    if (generation === undefined) return
    if (historyHasMore === false && historyCursor === undefined) return
    const beforeSequence = historyCursor ?? minSequence(currentFactsRef.current)
    if (beforeSequence === undefined) return
    setLoading(true)
    try {
      const result = await loadThreadHistory({ workspaceId, ...request, beforeSequence, limit: 20 })
      if (!isCurrentOpen(generation)) return
      if (!result.ok) { setError(result.error.message); return }
      setOlderFacts(current => mergeFacts(current, result.value.facts))
      mergeWorkerStates(result.value.workerStates)
      setHistoryCursor(result.value.cursor)
      setHistoryHasMore(result.value.hasMore)
      setError(undefined)
    } catch (cause) {
      if (isCurrentOpen(generation)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (isCurrentOpen(generation)) setLoading(false)
    }
  }

  const lookupMessageRefs = useMemo(() => hostMessageRefLookup(resolveMessageRefs, workspaceId), [resolveMessageRefs, workspaceId])
  const messageRefVersion = useResolvedMessageRefVersion()
  useEffect(() => {
    // Every reply's parent (for its quote block) and the composer's current target (for its banner) need context; the target is usually not itself a reply.
    const refs = currentFacts.flatMap(fact => fact.kind === 'message' && fact.message.replyToMessageRef !== undefined ? [fact.message.replyToMessageRef] : [])
    if (replyTarget !== undefined && !refs.includes(replyTarget)) refs.push(replyTarget)
    if (refs.length > 0) void resolveUnknownMessageRefs(refs, lookupMessageRefs)
  }, [currentFacts, replyTarget, lookupMessageRefs, messageRefVersion])

  useEffect(() => {
    if (flashedMessage === undefined) return
    // The pulse is the opening jump's lifetime: releasing it releases the target, so a settling jump never outlives its mark or pulls a reader who moved on.
    const timer = setTimeout(() => { setFlashedMessage(undefined); setPendingJump(undefined); pulsedRef.current = undefined }, 1200)
    return () => { clearTimeout(timer) }
  }, [flashedMessage])

  // Centre the Message the first read opened on and pulse its row once, with an instant scroll since this is where the page opens.
  // The target stays pending for the pulse: the first paint may still be growing and the pin-to-bottom policy would undo an early jump, so every commit re-centres it until the pulse releases it.
  useLayoutEffect(() => {
    if (pendingJump === undefined) return
    const node = document.querySelector(`[data-message-ref="${pendingJump}"]`)
    if (node === null) return
    node.scrollIntoView({ block: 'center' })
    // Tell the shared scroll policy the reader is off the tail, or the next arriving fact counts them as pinned and undoes the jump.
    timelineOnScroll()
    // The pulse starts once per target. This effect also re-runs while the timeline settles, and a state write on each
    // of those commits would keep re-centring a reader who has already arrived.
    if (pulsedRef.current !== pendingJump) {
      pulsedRef.current = pendingJump
      setFlashedMessage(pendingJump)
    }
  }, [pendingJump, currentFacts, readFacts, timelineOnScroll])

  const replyTo = useMemo((): ReplyTarget | undefined => {
    if (replyTarget === undefined) return undefined
    const target = cachedResolvedMessageRef(replyTarget)
    // The member id lets the author join the composer's "will notify" row; an unresolved parent cannot name one, and the Host still delivers.
    return target === undefined
      ? { senderName: t('memberUnknown'), excerpt: '' }
      : { memberId: target.sender, senderName: options.memberName(target.sender), excerpt: target.excerpt }
  }, [replyTarget, messageRefVersion, options.memberName, t])

  const refreshAfterFence = async (): Promise<void> => {
    const generation = activeGenerationRef.current
    if (generation === undefined) return
    timeline.scrollToBottom()
    await readCurrent(true)
    if (!isCurrentOpen(generation)) return
    await options.afterWrite?.()
    if (isCurrentOpen(generation)) await drainUnread()
  }

  // A write that left the screen may still commit. Keep its own Thread busy until the receipt,
  // without holding another discussion or letting a second opening send the same draft again.
  const beginWrite = (action: ThreadWriteAction) => {
    const generation = activeGenerationRef.current
    if (generation?.threadRef !== threadRef || writes.current.has(threadRef)) return undefined
    writes.current.set(threadRef, action)
    setPendingAction(action)
    setError(undefined)
    return generation
  }

  const endWrite = (): void => {
    writes.current.delete(threadRef)
    if (activeGenerationRef.current?.threadRef === threadRef) setPendingAction(undefined)
  }

  const commit = async (spec: ThreadWrite): Promise<void> => {
    const generation = beginWrite(spec.key)
    if (generation === undefined) return
    const requestId = mutationRequests.current.get(spec.key) ?? mintRequestId()
    mutationRequests.current.set(spec.key, requestId)
    try {
      const result = await spec.write(requestId)
      if (!isCurrentOpen(generation)) return
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.kind === 'committed') {
        mutationRequests.current.delete(spec.key)
        await spec.onCommitted(result.value)
      } else if (result.value.kind === 'unread_required') {
        setError(t('unreadRequired', { count: result.value.unreadCount }))
        mutationRequests.current.delete(spec.key)
        await refreshAfterFence()
      } else {
        setError(t('staleRevision'))
        mutationRequests.current.delete(spec.key)
        await refreshPassiveFacts()
      }
    } catch (cause) {
      if (isCurrentOpen(generation)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      endWrite()
    }
  }

  const applyTaskCommit = async (committed: CommittedTaskWrite): Promise<void> => {
    const generation = activeGenerationRef.current
    if (generation === undefined) return
    setProjection(current => current === undefined ? current
      : { ...current, task: committed.task, thread: committed.thread, ...(committed.claims === undefined ? {} : { claims: committed.claims }) })
    // The Host's own activity row, merged exactly as an accept or close merges its own.
    setCurrentFacts(current => {
      const merged = mergeFacts(current, [{ kind: 'activity', sequence: committed.activity.sequence, activity: committed.activity, occurredAt: committed.receipt.occurredAt }])
      currentFactsRef.current = merged
      return merged
    })
    await readCurrent(true)
    if (isCurrentOpen(generation)) await options.afterWrite?.()
  }

  const sendReply = async (): Promise<void> => {
    // Read at send time: neither face subscribes to the draft.
    const { draft } = drafts.getSnapshot(draftKey)
    const activeProjection = projectionRef.current
    if (activeProjection === undefined || draft.trim() === '') return
    const generation = beginWrite('reply')
    if (generation === undefined) return
    try {
      const task = activeProjection.task
      uploads.current = reconcileComposerUploads(pendingFiles, uploads.current)
      const settled = await drafts.replies.send(draftKey, {
        workspaceId, threadRef, body: draft.trim(), baseRevision: activeProjection.thread.revision,
        ...(task === undefined ? {} : { taskRef: task.taskRef }),
        ...(replyTarget === undefined ? {} : { replyToMessageRef: replyTarget }),
      }, uploads.current, { submit: reply, putAttachment })
      if (!isCurrentOpen(generation)) return
      uploads.current = mergeSettledComposerUploads(uploads.current, settled.uploads)
      if (settled.kind === 'superseded') return
      if (settled.kind === 'failed') { setError(settled.error); return }
      const { result } = settled
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.kind === 'committed') {
        const committed = result.value
        // Hand-typed `@Handle` delivers directly; committed facts replace this row on arrival.
        const optimisticMentions = mentionedMemberIds(draft, options.projectMembers())
        setCurrentFacts(current => {
          const merged = mergeFacts(current, [{ kind: 'message', sequence: committed.message.sequence, message: committed.message, mentions: optimisticMentions, occurredAt: committed.receipt.occurredAt }])
          currentFactsRef.current = merged
          return merged
        })
        setProjection(current => current === undefined || committed.thread.revision < current.thread.revision
          ? current
          : { ...current, ...(committed.task === undefined ? {} : { task: committed.task }), thread: committed.thread })
        if (settled.clearedDraft && drafts.getSnapshot(draftKey).draft === '') clearReplySelection()
        await options.afterWrite?.()
      } else if (result.value.kind === 'unread_required') {
        setError(t('unreadRequired', { count: result.value.unreadCount }))
        await refreshAfterFence()
      } else if (result.value.kind === 'stale_revision') {
        setError(t('staleRevision'))
        await refreshPassiveFacts()
      }
    } catch (cause) {
      if (isCurrentOpen(generation)) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      endWrite()
    }
  }

  const retryAutoRead = (): void => {
    setAutoReadExhausted(false)
    void drainUnread()
  }

  // The hint must go away the moment the reader is back within the follow margin, even when no render follows the position change.
  const onTimelineScroll = useCallback((): void => {
    timelineOnScroll()
    if (timeline.isPinned()) setNewFactsCount(0)
  }, [timelineOnScroll, timeline])

  const jumpToNewest = useCallback((): void => {
    setNewFactsCount(0)
    timeline.scrollToBottom()
  }, [timeline])

  return {
    projection,
    task: projection?.task,
    thread: projection?.thread,
    currentFacts,
    readFacts,
    olderFacts,
    taskCards,
    workerStates,
    followerObservation,
    historyHasMore,
    loading,
    error,
    pending: pendingAction !== undefined,
    pendingAction,
    autoReadExhausted,
    newFactsCount,
    replyTarget,
    replyTo,
    pendingFiles,
    draftKey,
    flashedMessage,
    timelineRef: timeline.ref,
    readCurrent,
    loadOlder,
    refreshAfterFence,
    refreshPassiveFacts,
    retryAutoRead,
    invalidateFollowerReads,
    onTimelineScroll,
    jumpToNewest,
    flashMessage: setFlashedMessage,
    setReplyTarget,
    setPendingFiles: changePendingFiles,
    reportError: setError,
    sendReply,
    commit,
    applyTaskCommit,
  }
}
