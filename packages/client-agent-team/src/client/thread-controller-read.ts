import { useCallback, useEffect, useRef } from 'react'
import type { AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { mintRequestId } from './requests.ts'
import { factKey, mergeFacts } from './thread-facts.ts'
import type { TeamThreadControllerOptions } from './thread-controller.ts'
import type {
  ThreadOpening,
  ThreadLifetime,
  ThreadFacts,
  ThreadHistory,
  ThreadFollowers,
  ThreadViewport,
  ThreadFeedback,
} from './thread-controller-state.ts'

// A bounded read acknowledges at most 20 unread facts and reads never self-wake a change scope,
// so larger backlogs need continuation reads; the cap stops a feed that outpaces reading.
const MAX_AUTO_READ_ROUNDS = 50

export function useThreadReadPhase({
  options,
  lifetime,
  facts,
  history,
  followers,
  viewport,
  feedback,
}: {
  readonly options: TeamThreadControllerOptions
  readonly lifetime: ThreadLifetime
  readonly facts: ThreadFacts
  readonly history: ThreadHistory
  readonly followers: ThreadFollowers
  readonly viewport: ThreadViewport
  readonly feedback: ThreadFeedback
}) {
  const { workspaceId, threadRef, taskRef, readThread, loadThreadHistory, threadObservations, subscribeChanges } = options
  const request = { threadRef, ...(taskRef === undefined ? {} : { taskRef }) }
  const sequenceRef = useRef(0)
  const { activeGenerationRef, isCurrentOpen } = lifetime
  const { setProjection, projectionRef, setCurrentFacts, currentFactsRef, setTaskCards, setReadFacts, setWorkerStates, updateProjection } = facts
  const { setOlderFacts, setHistoryCursor, setHistoryHasMore } = history
  const { setFollowerObservation, followerReadSequenceRef, followerReadFloorRef, followerAppliedSequenceRef } = followers
  const { timeline, setPendingJump, pulsedRef } = viewport
  const { setLoading, setError, setAutoReadExhausted, setNewFactsCount } = feedback
  // Continuations need fresh requestIds: the Host replays repeated ids from its idempotency cache.
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
      setCurrentFacts(current => mergeFacts(current, incoming))
      setProjection(current => current === undefined ? current : { ...current, ...(result.value.task === undefined ? {} : { task: result.value.task }), thread: result.value.thread, claims: result.value.claims })
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

  useEffect(() => {
    const generation = activeGenerationRef.current
    if (generation === undefined) return
    setProjection(undefined)
    setFollowerObservation({ ids: new Set(), sequence: 0 })
    setCurrentFacts([])
    setTaskCards([])
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
        setCurrentFacts(current => mergeFacts(current, history.value.facts))
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

  const retryAutoRead = (): void => {
    setAutoReadExhausted(false)
    void drainUnread()
  }

  return { readCurrent, drainUnread, refreshPassiveFacts, invalidateFollowerReads, retryAutoRead }
}

export type ThreadReads = ReturnType<typeof useThreadReadPhase>
