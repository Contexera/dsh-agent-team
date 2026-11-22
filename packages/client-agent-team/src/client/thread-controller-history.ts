import { mergeFacts, minSequence } from './thread-facts.ts'
import type { TeamThreadControllerOptions } from './thread-controller.ts'
import type { ThreadLifetime, ThreadFacts, ThreadHistory, ThreadFeedback } from './thread-controller-state.ts'

export function useThreadHistoryPhase({
  options,
  lifetime,
  facts,
  history,
  feedback,
}: {
  readonly options: TeamThreadControllerOptions
  readonly lifetime: ThreadLifetime
  readonly facts: ThreadFacts
  readonly history: ThreadHistory
  readonly feedback: ThreadFeedback
}) {
  const { workspaceId, threadRef, taskRef, loadThreadHistory } = options
  const request = { threadRef, ...(taskRef === undefined ? {} : { taskRef }) }
  const { activeGenerationRef, isCurrentOpen } = lifetime
  const { currentFactsRef, mergeWorkerStates } = facts
  const { setOlderFacts, historyCursor, setHistoryCursor, historyHasMore, setHistoryHasMore } = history
  const { setLoading, setError } = feedback
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

  return loadOlder
}
