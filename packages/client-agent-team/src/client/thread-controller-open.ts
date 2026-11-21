import { useLayoutEffect } from 'react'
import { mintRequestId } from './requests.ts'
import type { TeamThreadControllerOptions } from './thread-controller.ts'
import type {
  ThreadLifetime,
  ThreadFacts,
  ThreadFollowers,
  ThreadComposer,
  ThreadViewport,
  ThreadFeedback,
} from './thread-controller-state.ts'

export function useThreadOpenPhase({
  options,
  lifetime,
  facts,
  followers,
  composer,
  viewport,
  feedback,
}: {
  readonly options: TeamThreadControllerOptions
  readonly lifetime: ThreadLifetime
  readonly facts: ThreadFacts
  readonly followers: ThreadFollowers
  readonly composer: ThreadComposer
  readonly viewport: ThreadViewport
  readonly feedback: ThreadFeedback
}) {
  const { workspaceId, taskRef, threadRef, drafts } = options
  const { activeGenerationRef, mutationRequests, writes, uploads, isCurrentOpen, draftKey } = lifetime
  const { setProjection } = facts
  const { followerReadSequenceRef, followerReadFloorRef, followerAppliedSequenceRef } = followers
  const { setReplyTargetState, setPendingFiles, clearReplySelection } = composer
  const { setFlashedMessage } = viewport
  const { setPendingAction } = feedback
  // Returning to the same Thread must not revive a response from its earlier opening.
  useLayoutEffect(() => {
    const generation = { threadRef, readRequestId: mintRequestId() }
    activeGenerationRef.current = generation
    followerReadSequenceRef.current = 0
    followerReadFloorRef.current = 0
    followerAppliedSequenceRef.current = 0
    setProjection(undefined)
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
}
