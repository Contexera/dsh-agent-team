import { mergeSettledComposerUploads, mintRequestId, reconcileComposerUploads } from './requests.ts'
import { mergeFacts } from './thread-facts.ts'
import { mentionedMemberIds } from './team-formatters.ts'
import type { TeamThreadController, TeamThreadControllerOptions, CommittedTaskWrite } from './thread-controller.ts'
import type { ThreadLifetime, ThreadFacts, ThreadComposer, ThreadViewport, ThreadFeedback } from './thread-controller-state.ts'
import type { ThreadReads } from './thread-controller-read.ts'

type ThreadWrite = Parameters<TeamThreadController['commit']>[0]
type ThreadWriteAction = Exclude<TeamThreadController['pendingAction'], undefined>

export function useThreadWritePhase({
  options,
  lifetime,
  facts,
  composer,
  viewport,
  feedback,
  reads,
}: {
  readonly options: TeamThreadControllerOptions
  readonly lifetime: ThreadLifetime
  readonly facts: ThreadFacts
  readonly composer: ThreadComposer
  readonly viewport: ThreadViewport
  readonly feedback: ThreadFeedback
  readonly reads: ThreadReads
}) {
  const { workspaceId, threadRef, drafts, reply, putAttachment, t } = options
  const { readCurrent, drainUnread, refreshPassiveFacts } = reads
  const { activeGenerationRef, mutationRequests, writes, uploads, isCurrentOpen, draftKey } = lifetime
  const { setProjection, projectionRef, setCurrentFacts } = facts
  const { replyTarget, pendingFiles, clearReplySelection } = composer
  const { timeline } = viewport
  const { setError, setPendingAction } = feedback
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
    setCurrentFacts(current => mergeFacts(current, [{ kind: 'activity', sequence: committed.activity.sequence, activity: committed.activity, occurredAt: committed.receipt.occurredAt }]))
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
        const optimisticMentions = mentionedMemberIds(draft, options.workspaceMembers())
        setCurrentFacts(current => mergeFacts(current, [{ kind: 'message', sequence: committed.message.sequence, message: committed.message, mentions: optimisticMentions, occurredAt: committed.receipt.occurredAt }]))
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

  return { refreshAfterFence, sendReply, commit, applyTaskCommit }
}

export type ThreadWrites = ReturnType<typeof useThreadWritePhase>
