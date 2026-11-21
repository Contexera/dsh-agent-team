import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react'
import type { ReplyTarget } from './composer-sends.ts'
import { cachedResolvedMessageRef, hostMessageRefLookup, resolveUnknownMessageRefs, useResolvedMessageRefVersion } from './refs.ts'
import type { TeamThreadController, TeamThreadControllerOptions } from './thread-controller.ts'
import type {
  ThreadLifetime,
  ThreadFacts,
  ThreadHistory,
  ThreadFeedback,
  ThreadFollowers,
  ThreadComposer,
  ThreadViewport,
} from './thread-controller-state.ts'
import type { ThreadReads } from './thread-controller-read.ts'
import type { ThreadWrites } from './thread-controller-write.ts'

export function useThreadPresentation({
  options,
  lifetime,
  facts,
  history,
  feedback,
  followers,
  composer,
  viewport,
  reads,
  loadOlder,
  writes,
}: {
  readonly options: TeamThreadControllerOptions
  readonly lifetime: ThreadLifetime
  readonly facts: ThreadFacts
  readonly history: ThreadHistory
  readonly feedback: ThreadFeedback
  readonly followers: ThreadFollowers
  readonly composer: ThreadComposer
  readonly viewport: ThreadViewport
  readonly reads: ThreadReads
  readonly loadOlder: TeamThreadController['loadOlder']
  readonly writes: ThreadWrites
}): TeamThreadController {
  const { workspaceId, resolveMessageRefs, t } = options
  const { readCurrent, refreshPassiveFacts, retryAutoRead, invalidateFollowerReads } = reads
  const { refreshAfterFence, sendReply, commit, applyTaskCommit } = writes
  const { draftKey } = lifetime
  const { projection, currentFacts, taskCards, readFacts, workerStates } = facts
  const { olderFacts, historyHasMore } = history
  const { loading, error, setError, pendingAction, autoReadExhausted, newFactsCount, setNewFactsCount } = feedback
  const { followerObservation } = followers
  const { replyTarget, setReplyTarget, pendingFiles, changePendingFiles } = composer
  const { timeline, timelineOnScroll, flashedMessage, setFlashedMessage, pendingJump, setPendingJump, pulsedRef } = viewport
  // Returning to the bottom answers the jump hint: arrivals are on screen and their durable read already happened or will be retried.
  useEffect(() => {
    if (newFactsCount > 0 && timeline.isPinned()) setNewFactsCount(0)
  }, [newFactsCount, currentFacts, olderFacts, timeline])

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
