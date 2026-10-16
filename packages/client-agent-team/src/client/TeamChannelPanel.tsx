import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTeamChannelRef,
  AgentTeamClientMemberStatus,
  AgentTeamConfirmationToken,
  AgentTeamMemberId,
  AgentTeamRequestId,
  AgentTeamTaskRef,
  AgentTeamThreadFact,
  AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import { TeamComposer } from './TeamComposer.tsx'
import { TeamMessage } from './TeamMessage.tsx'
import { formatActivity, mentionedMemberIds } from './team-formatters.ts'
import { factKey, mergeFacts, messageFact, minSequence, stableMentionNames } from './thread-facts.ts'
import { mintRequestId, uploadComposerFiles } from './requests.ts'
import { chunkRunsWithDays } from './team-separators.ts'
import { useTimelineScroll } from './timeline-scroll.ts'
import { hostTaskRefLookup, hostThreadRefLookup, jumpToTaskThread, jumpToThread, type ResolvedMemberRef } from './refs.ts'
import channelCss from './channel.module.css'
import css from './conversation.module.css'
import threadCss from './thread.module.css'

interface TeamChannelPanelProps {
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly threadRef: AgentTeamThreadRef
  /** The home Channel's display name, for the head's 讨论 · #name title. */
  readonly channelName: string
  /** The Human's own display name and avatar, from the shared identity projection. */
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly humanMemberId?: AgentTeamMemberId | undefined
  /** The Channel page's roster: the panel reads it instead of pulling its own copy. */
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly channelMemberIds: ReadonlySet<AgentTeamMemberId>
  readonly drafts: TeamDraftStore
  readonly getAttachment: TeamConversationProps['getAttachment']
  readonly putAttachment: TeamConversationProps['putAttachment']
  readonly readThread: TeamConversationProps['readThread']
  readonly loadThreadHistory: TeamConversationProps['loadThreadHistory']
  readonly threadObservations: TeamConversationProps['threadObservations']
  readonly reply: TeamConversationProps['reply']
  readonly promoteThread: TeamConversationProps['promoteThread']
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly selectThread: TeamConversationProps['selectThread']
  readonly selectChannel: TeamConversationProps['selectChannel']
  readonly resolveTaskRefs: TeamConversationProps['resolveTaskRefs']
  readonly resolveThreadRefs: TeamConversationProps['resolveThreadRefs']
  readonly openMemberSession: TeamConversationProps['openMemberSession']
  readonly channelNameOf: (ref: AgentTeamChannelRef) => string | undefined
  readonly memberOf: (ref: AgentTeamMemberId) => ResolvedMemberRef | undefined
  /** Task number for one ref, from the Channel projection; undefined stays 「…」. */
  readonly taskNumberOf: (taskRef: AgentTeamTaskRef) => number | undefined
  /** A durable read committed: the feed's unread badge clears without waiting for the Inbox. */
  readonly onRead: (threadRef: AgentTeamThreadRef) => void
  /** This Thread is a Task now — the Channel closes the panel and walks the reader into it. */
  readonly onPromoted: (taskRef: AgentTeamTaskRef) => void
  readonly onClose: () => void
  readonly t: TeamConversationProps['t']
}

const factSender = (fact: AgentTeamThreadFact): AgentTeamMemberId | undefined => fact.kind === 'message' ? fact.message.sender : undefined
const factOccurredAt = (fact: AgentTeamThreadFact): string | undefined => fact.kind === 'message' ? fact.message.occurredAt : undefined

type ReadProjection = Awaited<ReturnType<TeamChannelPanelProps['readThread']>> extends infer Result
  ? Result extends { ok: true; value: infer Value } ? Value : never
  : never

/**
 * A taskless Thread's whole face beside its feed: read, answer, and — when the
 * discussion turns into work — promote. Quoting, Claims, and acceptance stay on
 * the Thread page, which a promoted Thread walks into anyway.
 */
export function TeamChannelPanel({ workspaceId, channelRef, threadRef, channelName, humanName, humanAvatarUrl, humanMemberId, members, channelMemberIds, drafts, getAttachment, putAttachment, readThread, loadThreadHistory, threadObservations, reply, promoteThread, subscribeChanges, selectThread, selectChannel, resolveTaskRefs, resolveThreadRefs, openMemberSession, channelNameOf, memberOf, taskNumberOf, onRead, onPromoted, onClose, t }: TeamChannelPanelProps) {
  const threadRequest = { threadRef }
  const [projection, setProjection] = useState<ReadProjection>()
  const [followerIds, setFollowerIds] = useState<ReadonlySet<AgentTeamMemberId>>(() => new Set())
  const [currentFacts, setCurrentFacts] = useState<readonly AgentTeamThreadFact[]>([])
  const [olderFacts, setOlderFacts] = useState<readonly AgentTeamThreadFact[]>([])
  const [historyCursor, setHistoryCursor] = useState<number>()
  const [historyHasMore, setHistoryHasMore] = useState(false)
  // A read acknowledges at most 20 unread facts, so the cap stops a
  // pathological feed from looping without bound.
  const MAX_AUTO_READ_ROUNDS = 50
  const [autoReadExhausted, setAutoReadExhausted] = useState(false)
  // The Thread page's draft key, so a draft continues across both faces.
  const draftKey: TeamDraftKey = `thread:${threadRef}`
  const [replyRequestId, setReplyRequestId] = useState<AgentTeamRequestId>()
  const [confirmation, setConfirmation] = useState<AgentTeamConfirmationToken>()
  const [statusMessage, setStatusMessage] = useState<string>()
  const [pending, setPending] = useState(false)
  const [mutating, setMutating] = useState<'promote' | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([])
  const mountedRef = useRef(false)
  const currentFactsRef = useRef<readonly AgentTeamThreadFact[]>([])
  const sequenceRef = useRef(0)
  const readRequestIdRef = useRef<AgentTeamRequestId>(mintRequestId())
  const projectionRef = useRef<ReadProjection>()
  const mutationRequests = useRef(new Map<string, AgentTeamRequestId>())
  const threadLastFact = currentFacts[currentFacts.length - 1]
  const timeline = useTimelineScroll(`${currentFacts.length}:${olderFacts.length}:${threadLastFact === undefined ? '' : factKey(threadLastFact)}`)

  const updateProjection = (next: ReadProjection): void => {
    projectionRef.current = next
    setProjection(next)
    const anchor = messageFact(next.anchor, next.anchorMentions)
    const batch = [anchor, ...next.facts.map(fact => fact.fact)]
    setCurrentFacts(current => {
      const merged = mergeFacts(current, batch)
      currentFactsRef.current = merged
      return merged
    })
  }

  const readCurrent = async (newRequest = false): Promise<boolean> => {
    if (!mountedRef.current) return false
    if (newRequest) readRequestIdRef.current = mintRequestId()
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    setLoading(true)
    try {
      const result = await readThread({ requestId: readRequestIdRef.current, workspaceId, ...threadRequest })
      if (!mountedRef.current || sequence !== sequenceRef.current) return false
      if (!result.ok) { setError(result.error.message); return false }
      updateProjection(result.value)
      setError(undefined)
      onRead(threadRef)
      return true
    } catch (cause) {
      if (mountedRef.current && sequence === sequenceRef.current) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (mountedRef.current && sequence === sequenceRef.current) setLoading(false)
    }
  }

  // Each round mints a fresh requestId: the Host replays a repeated id from its
  // idempotency cache, which would return the same batch forever.
  const drainUnread = async (): Promise<void> => {
    for (let round = 1; round <= MAX_AUTO_READ_ROUNDS; round += 1) {
      const snapshot = projectionRef.current
      if (snapshot === undefined || snapshot.remainingUnreadCount <= 0) return
      const beforeSequence = sequenceRef.current
      if (!await readCurrent(true)) return
      if (!mountedRef.current || sequenceRef.current !== beforeSequence + 1) return
      if (projectionRef.current?.remainingUnreadCount === snapshot.remainingUnreadCount) return
    }
    setAutoReadExhausted(true)
  }

  const refreshPassiveFacts = async (): Promise<void> => {
    try {
      const result = await loadThreadHistory({ workspaceId, ...threadRequest, limit: 100 })
      if (!mountedRef.current || !result.ok) return
      const incoming = result.value.facts
      const shown = currentFactsRef.current
      if (shown.length === 0) return
      const known = new Set(shown.map(fact => factKey(fact)))
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
      // Every arrival while the panel is open is acknowledged durably: the
      // timeline renders it either way.
      await readCurrent(true)
    } catch {
    }
  }

  // Follower ranking is an enhancement: a failed read leaves roster order.
  const refreshFollowers = async (): Promise<void> => {
    try {
      const result = await threadObservations({ workspaceId, ...threadRequest })
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
    currentFactsRef.current = []
    setOlderFacts([])
    setHistoryCursor(undefined)
    setHistoryHasMore(false)
    setAutoReadExhausted(false)
    setError(undefined)
    setStatusMessage(undefined)
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    setLoading(true)
    void (async () => {
      const [read, history, observations] = await Promise.all([
        readThread({ requestId: readRequestIdRef.current, workspaceId, ...threadRequest }),
        loadThreadHistory({ workspaceId, ...threadRequest, limit: 20 }).catch(() => undefined),
        threadObservations({ workspaceId, ...threadRequest }).catch(() => undefined),
      ])
      if (!mountedRef.current || sequence !== sequenceRef.current) return
      if (!read.ok) {
        setError(read.error.message)
        setLoading(false)
        return
      }
      updateProjection(read.value)
      onRead(threadRef)
      timeline.scrollToBottom()
      if (history !== undefined && history.ok) {
        setCurrentFacts(current => {
          const merged = mergeFacts(current, history.value.facts)
          currentFactsRef.current = merged
          return merged
        })
        setHistoryCursor(history.value.cursor)
        setHistoryHasMore(history.value.hasMore)
      } else {
        // A refused read keeps the way back open: the affordance stands and
        // pages under its own error surface.
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
  }, [workspaceId, threadRef])

  const loadOlder = async (): Promise<void> => {
    if (historyHasMore === false && historyCursor === undefined) return
    const beforeSequence = historyCursor ?? minSequence(currentFactsRef.current)
    if (beforeSequence === undefined) return
    setLoading(true)
    try {
      const result = await loadThreadHistory({ workspaceId, ...threadRequest, beforeSequence, limit: 20 })
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

  const task = projection?.task
  const thread = projection?.thread
  const mentionHandlesMap = useMemo(() => new Map(members.map(status => [status.member.memberId, status.member.handle.replace(/^@/, '')])), [members])
  const channelMembers = members.filter(status => channelMemberIds.size === 0 || channelMemberIds.has(status.member.memberId))

  const memberName = (memberId: AgentTeamMemberId): string => {
    if (memberId === humanMemberId) return humanName
    const status = members.find(candidate => candidate.member.memberId === memberId)
    return status === undefined ? t('memberUnknown') : `@${status.member.handle}`
  }

  // A cited Thread or Task resolves through the Host and jumps to its home
  // Channel, where it reads whole; a cited Channel hops directly.
  const openRef = useCallback((ref: string): void => {
    if (ref.startsWith('channel:')) {
      if (ref !== channelRef) selectChannel(ref as AgentTeamChannelRef)
      return
    }
    if (ref === threadRef) return
    if (ref.startsWith('thread:')) {
      jumpToThread(resolveThreadRefs, workspaceId, ref as AgentTeamThreadRef, selectThread)
      return
    }
    if (ref.startsWith('task:')) {
      jumpToTaskThread(resolveTaskRefs, workspaceId, ref as AgentTeamTaskRef, selectThread)
    }
  }, [channelRef, threadRef, workspaceId, selectChannel, selectThread, resolveTaskRefs, resolveThreadRefs])

  const lookupTaskRefs = useMemo(() => hostTaskRefLookup(resolveTaskRefs, workspaceId), [resolveTaskRefs, workspaceId])
  const lookupThreadRefs = useMemo(() => hostThreadRefLookup(resolveThreadRefs, workspaceId), [resolveThreadRefs, workspaceId])

  const renderFact = (fact: AgentTeamThreadFact, grouped = false) => {
    if (fact.kind === 'message') {
      const sender = memberName(fact.message.sender)
      const senderStatus = members.find(candidate => candidate.member.memberId === fact.message.sender)
      const human = fact.message.sender === humanMemberId
      return <TeamMessage
        key={factKey(fact)}
        senderName={sender}
        memberId={fact.message.sender}
        human={human}
        readerName={humanName}
        {...(human && humanAvatarUrl !== undefined ? { avatarUrl: humanAvatarUrl } : {})}
        body={fact.message.body}
        attachments={fact.message.attachments}
        loadAttachment={getAttachment}
        t={t}
        occurredAt={fact.message.occurredAt}
        mentionNames={stableMentionNames(fact.mentions, mentionHandlesMap, humanName)}
        onOpenRef={openRef}
        onResolveTaskRefs={lookupTaskRefs}
        onResolveThreadRefs={lookupThreadRefs}
        channelNameOf={channelNameOf}
        memberOf={memberOf}
        onOpenMemberSession={openMemberSession}
        grouped={grouped}
        showGroupedTime
        {...(senderStatus === undefined ? {} : { senderTitle: senderStatus.member.description })}
      />
    }
    return <p className={threadCss.activityRow} key={factKey(fact)}><span className={threadCss.activityMark} aria-hidden="true" /><span className={threadCss.activityText}>{formatActivity(fact.activity, { t, actorName: memberName, claims: projection?.claims ?? [] })}</span></p>
  }

  const renderBlocks = (facts: readonly AgentTeamThreadFact[]) => chunkRunsWithDays(facts, factSender, factOccurredAt).map((block, blockIndex) => block.kind === 'day'
    ? <p className={threadCss.daySeparator} key={`day-${blockIndex}-${block.label}`}><span>{block.label}</span></p>
    : <div className={css.messageRun} key={`run-${factKey(block.items[0]!)}`}>
        {block.items.map((entry, entryIndex) => <Fragment key={factKey(entry)}>{renderFact(entry, entryIndex > 0)}</Fragment>)}
      </div>)

  const refreshAfterFence = async (): Promise<void> => {
    timeline.scrollToBottom()
    await readCurrent(true)
    await drainUnread()
  }

  const convertToTask = async (): Promise<void> => {
    if (pending || thread === undefined || task !== undefined) return
    setPending(true)
    setMutating('promote')
    setError(undefined)
    const key = 'promote'
    const requestId = mutationRequests.current.get(key) ?? mintRequestId()
    mutationRequests.current.set(key, requestId)
    try {
      const result = await promoteThread({ requestId, workspaceId, threadRef, baseRevision: thread.revision })
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.kind === 'committed') {
        mutationRequests.current.delete(key)
        onPromoted(result.value.task.taskRef)
      } else if (result.value.kind === 'unread_required') {
        setError(t('unreadRequired', { count: result.value.unreadCount }))
        mutationRequests.current.delete(key)
        await refreshAfterFence()
      } else {
        setError(t('staleRevision'))
        mutationRequests.current.delete(key)
        await refreshPassiveFacts()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
      setMutating(undefined)
    }
  }

  // Editing the draft invalidates one-shot send state.
  const clearSendState = useCallback((): void => {
    setConfirmation(current => current === undefined ? current : undefined)
    setReplyRequestId(current => current === undefined ? current : undefined)
    setStatusMessage(current => current === undefined ? current : undefined)
  }, [])

  const sendReply = async (): Promise<void> => {
    // The composer owns the draft subscription, so a captured render value
    // would be stale after its own edits.
    const { draft, recipients } = drafts.getSnapshot(draftKey)
    if (pending || thread === undefined || draft.trim() === '') return
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
      const result = await reply({ requestId: id, workspaceId, threadRef, ...(task === undefined ? {} : { taskRef: task.taskRef }), body: draft.trim(), baseRevision: thread.revision, recipients: [...recipients].sort(), ...(attachmentIds.length === 0 ? {} : { attachments: attachmentIds }), ...(confirmation === undefined ? {} : { confirmationToken: confirmation }) })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (result.value.kind === 'committed') {
        const committed = result.value as Extract<typeof result.value, { kind: 'committed' }>
        // Chips what the Host is about to report; its committed facts replace
        // this row as soon as they arrive.
        const optimisticMentions = [...new Set([...recipients, ...mentionedMemberIds(draft, channelMembers)])].sort()
        setCurrentFacts(current => {
          const merged = mergeFacts(current, [{ kind: 'message', sequence: committed.message.sequence, message: committed.message, mentions: optimisticMentions, occurredAt: committed.receipt.occurredAt }])
          currentFactsRef.current = merged
          return merged
        })
        setProjection(current => current === undefined ? current : { ...current, ...(committed.task === undefined ? {} : { task: committed.task }), thread: committed.thread })
        drafts.clear(draftKey)
        setPendingFiles([])
        setReplyRequestId(undefined)
        setConfirmation(undefined)
        setStatusMessage(undefined)
      } else if (result.value.kind === 'confirmation_required') {
        setConfirmation(result.value.confirmationToken)
        setStatusMessage(t('mentionConfirmation'))
      } else if (result.value.kind === 'unread_required') {
        setError(t('unreadRequired', { count: result.value.unreadCount }))
        setConfirmation(undefined)
        setStatusMessage(undefined)
        setReplyRequestId(undefined)
        await refreshAfterFence()
      } else if (result.value.kind === 'stale_revision') {
        setError(t('staleRevision'))
        setConfirmation(undefined)
        setStatusMessage(undefined)
        setReplyRequestId(undefined)
        await refreshPassiveFacts()
      } else {
        setError(t('memberNotFollowing', { ids: result.value.memberIds.map(memberId => `@${members.find(candidate => candidate.member.memberId === memberId)?.member.handle ?? memberId}`).join(', ') }))
        setConfirmation(undefined)
        setStatusMessage(undefined)
        setReplyRequestId(undefined)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setPending(false) }
  }

  const currentFactsWithAnchor = mergeFacts(projection === undefined ? [] : [messageFact(projection.anchor, projection.anchorMentions)], currentFacts)
  const resolvedTaskNumber = task === undefined ? undefined : taskNumberOf(task.taskRef)
  const title = `${t('threadLabel')} · #${channelName}`

  return <aside className={channelCss.panel} aria-label={t('threadLabel')} data-team-panel={threadRef}>
    <div className={channelCss.panelHead}>
      <span className={channelCss.panelTitle} title={title}>{title}</span>
      {task === undefined && thread !== undefined && <Button size="sm" variant="primary" disabled={pending} onClick={() => { void convertToTask() }}>{mutating === 'promote' ? t('promotingTask') : t('promoteToTask')}</Button>}
      {task !== undefined && <Button size="sm" variant="primary" onClick={() => { onPromoted(task.taskRef) }}>{t('openTask', { number: resolvedTaskNumber ?? '…' })}</Button>}
      <Button size="sm" icon={<IconCloseOutlineRegular size={14} />} aria-label={t('panelClose')} onClick={onClose} />
    </div>
    <section ref={timeline.ref} onScroll={timeline.onScroll} className={channelCss.panelBody} aria-label={t('timelineLabel')}>
      {loading && projection === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingThread')}</p></div>}
      {projection === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void readCurrent() }}>{t('retry')}</Button></div>}
      {renderBlocks(olderFacts)}
      {historyHasMore && <div className={css.timelineAction}><Button size="sm" onClick={() => { void loadOlder() }}>{t('loadOlder')}</Button></div>}
      {renderBlocks(currentFactsWithAnchor)}
      {autoReadExhausted && <div className={css.timelineAction} role="alert">
        <span>{t('autoReadIncomplete')}</span>
        <Button size="sm" onClick={() => { setAutoReadExhausted(false); void drainUnread() }} disabled={loading}>{t('retry')}</Button>
      </div>}
    </section>
    {projection !== undefined && thread !== undefined && <div className={channelCss.panelFoot}>
      <TeamComposer
        key={draftKey}
        members={members}
        followerMemberIds={followerIds}
        channelPeerMemberIds={channelMemberIds}
        drafts={drafts}
        draftKey={draftKey}
        pending={pending}
        {...(statusMessage === undefined ? {} : { confirmation: statusMessage })}
        {...(error === undefined ? {} : { error })}
        onEdit={clearSendState}
        onSubmit={() => { void sendReply() }}
        placeholder={t('replyPlaceholder')}
        pendingFiles={pendingFiles}
        onFilesChange={setPendingFiles}
        t={t}
      />
    </div>}
  </aside>
}
