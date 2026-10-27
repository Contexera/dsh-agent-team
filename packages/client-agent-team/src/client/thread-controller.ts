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
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import type { ReplyTarget } from './TeamComposer.tsx'
import { mintRequestId, uploadComposerFiles } from './requests.ts'
import { useTimelineScroll, type TimelineScroll } from './timeline-scroll.ts'
import { cachedResolvedMessageRef, hostMessageRefLookup, resolveUnknownMessageRefs, useResolvedMessageRefVersion } from './refs.ts'
import { factKey, mergeFacts, messageFact, minSequence } from './thread-facts.ts'
import { mentionedMemberIds } from './team-formatters.ts'

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

/** One durable Thread write, run under the surface's shared busy gate with a requestId that a retry replays. */
export interface ThreadWrite<TCommitted extends { readonly kind: 'committed' }> {
  /** Cache key for the requestId; one in-flight write per key at a time. */
  readonly key: string
  readonly write: (requestId: AgentTeamRequestId) => Promise<RemoteResult<TCommitted | AgentTeamUnreadRequired | AgentTeamStaleRevision>>
  readonly onCommitted: (committed: TCommitted) => void | Promise<void>
}

/** The fields every committed Task write carries, so one merge serves promote, accept, close, reopen, and transfer. */
export interface CommittedTaskWrite {
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
  readonly followerIds: ReadonlySet<AgentTeamMemberId>
  readonly historyHasMore: boolean
  readonly loading: boolean
  readonly error: string | undefined
  /** The surface's shared busy gate: a reply send and every Task write hold it. */
  readonly pending: boolean
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
  readonly onTimelineScroll: () => void
  readonly jumpToNewest: () => void
  readonly flashMessage: (messageRef: AgentTeamMessageRef) => void
  readonly setReplyTarget: (messageRef: AgentTeamMessageRef | undefined) => void
  readonly setPendingFiles: (files: readonly File[]) => void
  readonly clearSendState: () => void
  readonly reportError: (message: string) => void
  readonly sendReply: () => Promise<void>
  /** Runs one durable write and converges on the Host's answer for either fence. */
  readonly commit: <TCommitted extends { readonly kind: 'committed' }>(spec: ThreadWrite<TCommitted>) => Promise<void>
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
  const [historyCursor, setHistoryCursor] = useState<number>()
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [autoReadExhausted, setAutoReadExhausted] = useState(false)
  const [newFactsCount, setNewFactsCount] = useState(0)
  // Current Thread followers; the composer ranks them first because they are already in the conversation.
  const [followerIds, setFollowerIds] = useState<ReadonlySet<AgentTeamMemberId>>(() => new Set())
  // The draft cache outlives this page across view switches; the composer owns the subscription so typing never re-renders the timeline.
  const draftKey: TeamDraftKey = `thread:${threadRef}`
  const [replyRequestId, setReplyRequestId] = useState<AgentTeamRequestId>()
  const [replyTarget, setReplyTarget] = useState<AgentTeamMessageRef>()
  const [flashedMessage, setFlashedMessage] = useState<AgentTeamMessageRef>()
  // The Message this opening lands on, held until its row exists: the jump is
  // decided from the first read, and rows render a paint later.
  const [pendingJump, setPendingJump] = useState<AgentTeamMessageRef>()
  const [pending, setPending] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([])
  const mountedRef = useRef(false)
  const currentFactsRef = useRef<readonly AgentTeamThreadFact[]>([])
  const sequenceRef = useRef(0)
  const readRequestIdRef = useRef<AgentTeamRequestId>(mintRequestId())
  const projectionRef = useRef<AgentTeamThreadReadResult>()
  const mutationRequests = useRef(new Map<string, AgentTeamRequestId>())
  const threadLastFact = currentFacts[currentFacts.length - 1]
  const timeline = useTimelineScroll(`${currentFacts.length}:${olderFacts.length}:${threadLastFact === undefined ? '' : factKey(threadLastFact)}`)
  // The hook returns a fresh object per render, but this callback is stable: the
  // opening jump depends on it without re-running on every render.
  const timelineOnScroll = timeline.onScroll

  const updateProjection = (next: AgentTeamThreadReadResult): void => {
    projectionRef.current = next
    setProjection(next)
    setReadFacts(next.facts)
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
    for (let round = 1; round <= MAX_AUTO_READ_ROUNDS; round += 1) {
      const snapshot = projectionRef.current
      if (snapshot === undefined || snapshot.remainingUnreadCount <= 0) return
      const beforeSequence = sequenceRef.current
      if (!await readCurrent(true)) return
      // A newer read or remount owns the tail now; it drains the remainder.
      if (!mountedRef.current || sequenceRef.current !== beforeSequence + 1) return
      // A stalled remainder (Host fault) must not spin the loop.
      if (projectionRef.current?.remainingUnreadCount === snapshot.remainingUnreadCount) return
    }
    setAutoReadExhausted(true)
  }

  const readCurrent = async (newRequest = false): Promise<boolean> => {
    if (!mountedRef.current) return false
    if (newRequest) readRequestIdRef.current = mintRequestId()
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    setLoading(true)
    try {
      const result = await readThread({ requestId: readRequestIdRef.current, workspaceId, ...request })
      if (!mountedRef.current || sequence !== sequenceRef.current) return false
      if (!result.ok) { setError(result.error.message); return false }
      updateProjection(result.value)
      setError(undefined)
      options.onRead?.()
      return true
    } catch (cause) {
      if (mountedRef.current && sequence === sequenceRef.current) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (mountedRef.current && sequence === sequenceRef.current) setLoading(false)
    }
  }

  const refreshPassiveFacts = async (): Promise<void> => {
    try {
      const result = await loadThreadHistory({ workspaceId, ...request, limit: 100 })
      if (!mountedRef.current || !result.ok) return
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

  // Follower ranking is an enhancement, not a page fact: a failed observation
  // read leaves the roster order in place instead of surfacing an error.
  const refreshFollowers = async (): Promise<void> => {
    try {
      const result = await threadObservations({ workspaceId, ...request })
      if (!mountedRef.current || !result.ok) return
      setFollowerIds(new Set(result.value.followers))
    } catch {
    }
  }

  useEffect(() => {
    mountedRef.current = true
    projectionRef.current = undefined
    setProjection(undefined)
    setFollowerIds(new Set())
    setCurrentFacts([])
    setTaskCards([])
    currentFactsRef.current = []
    setOlderFacts([])
    setReadFacts([])
    setHistoryCursor(undefined)
    setHistoryHasMore(false)
    setAutoReadExhausted(false)
    setNewFactsCount(0)
    setPendingJump(undefined)
    setError(undefined)
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    setLoading(true)
    void (async () => {
      const [read, history, observations] = await Promise.all([
        readThread({ requestId: readRequestIdRef.current, workspaceId, ...request }),
        loadThreadHistory({ workspaceId, ...request, limit: 20 }).catch(() => undefined),
        threadObservations({ workspaceId, ...request }).catch(() => undefined),
      ])
      if (!mountedRef.current || sequence !== sequenceRef.current) return
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
      if (observations !== undefined && observations.ok) setFollowerIds(new Set(observations.value.followers))
      setError(undefined)
      setLoading(false)
      await drainUnread()
    })()
    const disposers = [
      subscribeChanges({ kind: 'thread', threadRef }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setError(update.message); return }
        void refreshPassiveFacts()
        void refreshFollowers()
      }),
    ]
    return () => {
      mountedRef.current = false
      sequenceRef.current += 1
      for (const dispose of disposers) dispose()
    }
  }, [workspaceId, taskRef, threadRef])

  // Returning to the bottom answers the jump hint: arrivals are on screen and their durable read already happened or will be retried.
  useEffect(() => {
    if (newFactsCount > 0 && timeline.isPinned()) setNewFactsCount(0)
  }, [newFactsCount, currentFacts, olderFacts, timeline])

  const loadOlder = async (): Promise<void> => {
    if (historyHasMore === false && historyCursor === undefined) return
    const beforeSequence = historyCursor ?? minSequence(currentFactsRef.current)
    if (beforeSequence === undefined) return
    setLoading(true)
    try {
      const result = await loadThreadHistory({ workspaceId, ...request, beforeSequence, limit: 20 })
      if (!mountedRef.current) return
      if (!result.ok) { setError(result.error.message); return }
      setOlderFacts(current => mergeFacts(current, result.value.facts))
      setHistoryCursor(result.value.cursor)
      setHistoryHasMore(result.value.hasMore)
      setError(undefined)
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setLoading(false)
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
    const timer = setTimeout(() => { setFlashedMessage(undefined); setPendingJump(undefined) }, 1200)
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
    setFlashedMessage(pendingJump)
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
    timeline.scrollToBottom()
    await readCurrent(true)
    await options.afterWrite?.()
    await drainUnread()
  }

  const commit = async <TCommitted extends { readonly kind: 'committed' }>(spec: ThreadWrite<TCommitted>): Promise<void> => {
    setPending(true)
    setError(undefined)
    const requestId = mutationRequests.current.get(spec.key) ?? mintRequestId()
    mutationRequests.current.set(spec.key, requestId)
    try {
      const result = await spec.write(requestId)
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
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const applyTaskCommit = async (committed: CommittedTaskWrite): Promise<void> => {
    setProjection(current => current === undefined ? current
      : { ...current, task: committed.task, thread: committed.thread, ...(committed.claims === undefined ? {} : { claims: committed.claims }) })
    // The Host's own activity row, merged exactly as an accept or close merges its own.
    setCurrentFacts(current => {
      const merged = mergeFacts(current, [{ kind: 'activity', sequence: committed.activity.sequence, activity: committed.activity, occurredAt: committed.receipt.occurredAt }])
      currentFactsRef.current = merged
      return merged
    })
    await readCurrent(true)
    await options.afterWrite?.()
  }

  // Every setter returns the same state when there is nothing to clear, so a keystroke does not re-render the timeline.
  // Editing invalidates the retained requestId.
  const clearSendState = useCallback((): void => {
    setReplyRequestId(current => current === undefined ? current : undefined)
  }, [])

  const sendReply = async (): Promise<void> => {
    // Read at send time: neither face subscribes to the draft.
    const { draft } = drafts.getSnapshot(draftKey)
    const activeProjection = projectionRef.current
    if (pending || activeProjection === undefined || draft.trim() === '') return
    const thread = activeProjection.thread
    const task = activeProjection.task
    const id = replyRequestId ?? mintRequestId()
    setReplyRequestId(id)
    setPending(true)
    setError(undefined)
    try {
      const upload = await uploadComposerFiles(putAttachment, workspaceId, pendingFiles)
      if (!upload.ok) {
        setError(upload.error)
        return
      }
      const attachmentIds = upload.attachmentIds
      const result = await reply({ requestId: id, workspaceId, threadRef, ...(task === undefined ? {} : { taskRef: task.taskRef }), ...(replyTarget === undefined ? {} : { replyToMessageRef: replyTarget }), body: draft.trim(), baseRevision: thread.revision, ...(attachmentIds.length === 0 ? {} : { attachments: attachmentIds }) })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (result.value.kind === 'committed') {
        const committed = result.value as Extract<typeof result.value, { kind: 'committed' }>
        // Hand-typed `@Handle` delivers directly; committed facts replace this row on arrival.
        const optimisticMentions = mentionedMemberIds(draft, options.projectMembers())
        setCurrentFacts(current => {
          const merged = mergeFacts(current, [{ kind: 'message', sequence: committed.message.sequence, message: committed.message, mentions: optimisticMentions, occurredAt: committed.receipt.occurredAt }])
          currentFactsRef.current = merged
          return merged
        })
        setProjection(current => current === undefined ? current : { ...current, ...(committed.task === undefined ? {} : { task: committed.task }), thread: committed.thread })
        drafts.clear(draftKey)
        setReplyTarget(undefined)
        setPendingFiles([])
        setReplyRequestId(undefined)
        await options.afterWrite?.()
      } else if (result.value.kind === 'unread_required') {
        setError(t('unreadRequired', { count: result.value.unreadCount }))
        setReplyRequestId(undefined)
        await refreshAfterFence()
      } else if (result.value.kind === 'stale_revision') {
        setError(t('staleRevision'))
        setReplyRequestId(undefined)
        await refreshPassiveFacts()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setPending(false) }
  }

  const retryAutoRead = useCallback((): void => {
    setAutoReadExhausted(false)
    void drainUnread()
  }, [])

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
    followerIds,
    historyHasMore,
    loading,
    error,
    pending,
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
    onTimelineScroll,
    jumpToNewest,
    flashMessage: setFlashedMessage,
    setReplyTarget,
    setPendingFiles,
    clearSendState,
    reportError: setError,
    sendReply,
    commit,
    applyTaskCommit,
  }
}
