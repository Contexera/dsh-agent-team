import { useCallback, useRef, useState } from 'react'
import type {
  AgentTeamMessageRef,
  AgentTeamRequestId,
  AgentTeamThreadFact,
  AgentTeamThreadReadFact,
  AgentTeamThreadReadResult,
  AgentTeamThreadRef,
  AgentTeamThreadTaskCard,
  AgentTeamWorkerRef,
  AgentTeamWorkerStateView,
} from '@contexera/dsh-agent-team/types'
import type { TeamDraftKey } from './drafts.ts'
import { reconcileComposerUploads, type ComposerUpload } from './requests.ts'
import { useTimelineScroll } from './timeline-scroll.ts'
import { factKey, mergeFacts, messageFact } from './thread-facts.ts'
import type { ThreadFollowerObservation } from './thread-observation.ts'
import type { TeamThreadController, TeamThreadControllerOptions } from './thread-controller.ts'

export interface ThreadOpening {
  readonly threadRef: AgentTeamThreadRef
  readRequestId: AgentTeamRequestId
}

type TaskWriteAction = Parameters<TeamThreadController['commit']>[0]['key']
type ThreadWriteAction = Exclude<TeamThreadController['pendingAction'], undefined>

function useSynchronousState<T>(initial: T) {
  const [value, setValue] = useState(initial)
  const ref = useRef(value)
  const set = useCallback((next: T | ((current: T) => T)): void => {
    if (next instanceof Function) {
      setValue(current => {
        const resolved = next(current)
        ref.current = resolved
        return resolved
      })
    } else {
      ref.current = next
      setValue(next)
    }
  }, [])
  return [value, set, ref] as const
}

export function useThreadControllerState(options: TeamThreadControllerOptions) {
  const { threadRef, drafts } = options
  const [projection, setProjection, projectionRef] = useSynchronousState<AgentTeamThreadReadResult | undefined>(undefined)
  const [currentFacts, setCurrentFacts, currentFactsRef] = useSynchronousState<readonly AgentTeamThreadFact[]>([])
  const [taskCards, setTaskCards] = useState<readonly AgentTeamThreadTaskCard[]>([])
  const [olderFacts, setOlderFacts] = useState<readonly AgentTeamThreadFact[]>([])
  const [readFacts, setReadFacts] = useState<readonly AgentTeamThreadReadFact[]>([])
  const [workerStates, setWorkerStates] = useState<ReadonlyMap<AgentTeamWorkerRef, AgentTeamWorkerStateView>>(() => new Map())
  const [historyCursor, setHistoryCursor] = useState<number>()
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [autoReadExhausted, setAutoReadExhausted] = useState(false)
  const [newFactsCount, setNewFactsCount] = useState(0)
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
  const pulsedRef = useRef<AgentTeamMessageRef>()
  const [pendingAction, setPendingAction] = useState<ThreadWriteAction>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([])
  const activeGenerationRef = useRef<ThreadOpening>()
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
    setProjection(next)
    setReadFacts(next.facts)
    mergeWorkerStates(next.workerStates)
    const anchor = messageFact(next.anchor, next.anchorMentions)
    const batch = [anchor, ...next.facts.map(fact => fact.fact)]
    setCurrentFacts(current => mergeFacts(current, batch))
  }

  return {
    lifetime: { activeGenerationRef, mutationRequests, writes, uploads, isCurrentOpen, draftKey },
    facts: { projection, setProjection, projectionRef, currentFacts, setCurrentFacts, currentFactsRef, taskCards, setTaskCards, readFacts, setReadFacts, workerStates, setWorkerStates, mergeWorkerStates, updateProjection },
    history: { olderFacts, setOlderFacts, historyCursor, setHistoryCursor, historyHasMore, setHistoryHasMore },
    feedback: { loading, setLoading, error, setError, pendingAction, setPendingAction, autoReadExhausted, setAutoReadExhausted, newFactsCount, setNewFactsCount },
    followers: { followerObservation, setFollowerObservation, followerReadSequenceRef, followerReadFloorRef, followerAppliedSequenceRef },
    composer: { replyTarget, setReplyTargetState, setReplyTarget, pendingFiles, setPendingFiles, changePendingFiles, clearReplySelection },
    viewport: { timeline, timelineOnScroll, flashedMessage, setFlashedMessage, pendingJump, setPendingJump, pulsedRef },
  }
}

export type ThreadLifetime = ReturnType<typeof useThreadControllerState>['lifetime']
export type ThreadFacts = ReturnType<typeof useThreadControllerState>['facts']
export type ThreadHistory = ReturnType<typeof useThreadControllerState>['history']
export type ThreadFeedback = ReturnType<typeof useThreadControllerState>['feedback']
export type ThreadFollowers = ReturnType<typeof useThreadControllerState>['followers']
export type ThreadComposer = ReturnType<typeof useThreadControllerState>['composer']
export type ThreadViewport = ReturnType<typeof useThreadControllerState>['viewport']
