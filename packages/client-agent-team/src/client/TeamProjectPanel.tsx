import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AgentTeamProjectRef,
  AgentTeamClientMemberStatus,
  AgentTeamMemberId,
  AgentTeamMessageRef,
  AgentTeamTaskRef,
  AgentTeamThreadFact,
  AgentTeamThreadReadFact,
  AgentTeamThreadRef,
  AgentTeamThreadTaskCard,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDiscussionAnchor } from './navigation.ts'
import type { TeamDraftStore } from './drafts.ts'
import { TeamComposer } from './TeamComposer.tsx'
import { TeamPanelHandle } from './TeamPanelHandle.tsx'
import { TeamMessage } from './TeamMessage.tsx'
import { TeamThreadCard } from './TeamThreadCard.tsx'
import type { TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { formatActivity } from './team-formatters.ts'
import { factKey, firstUnreadMention, mergeFacts, messageFact, stableMentionNames } from './thread-facts.ts'
import { chunkTimeline, placeCards, type TimelineNode } from './team-separators.ts'
import { cachedResolvedMessageRef, useResolvedMessageRefVersion } from './refs.ts'
import { hostTaskRefLookup, hostThreadRefLookup, jumpToTaskThread, jumpToThread, resolvedThreadDestination, type ResolvedMemberRef } from './refs.ts'
import { useThreadFollow } from './thread-actions.ts'
import { useTeamThreadController } from './thread-controller.ts'
import projectCss from './project.module.css'
import css from './conversation.module.css'
import threadCss from './thread.module.css'

interface TeamProjectPanelProps {
  /** The surface this panel is seated in: it owns the width the handle writes. */
  readonly surface: HTMLElement | null
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly threadRef: AgentTeamThreadRef
  /** Why this discussion was opened: `unread` lands on the first unread Message naming the Human, like the full page. */
  readonly anchor?: TeamDiscussionAnchor | undefined
  readonly projectName: string
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly humanMemberId?: AgentTeamMemberId | undefined
  /** The Project page's roster: the panel reads it instead of pulling its own copy. */
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly projectMemberIds: ReadonlySet<AgentTeamMemberId>
  readonly projectOwnerIds: ReadonlySet<AgentTeamMemberId>
  readonly drafts: TeamDraftStore
  readonly getAttachment: TeamConversationProps['getAttachment']
  readonly putAttachment: TeamConversationProps['putAttachment']
  readonly readThread: TeamConversationProps['readThread']
  readonly loadThreadHistory: TeamConversationProps['loadThreadHistory']
  readonly threadObservations: TeamConversationProps['threadObservations']
  readonly reply: TeamConversationProps['reply']
  readonly promoteThread: TeamConversationProps['promoteThread']
  readonly changeAttention: TeamConversationProps['changeAttention']
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly selectThread: TeamConversationProps['selectThread']
  readonly selectDiscussion: TeamConversationProps['selectDiscussion']
  readonly selectProject: TeamConversationProps['selectProject']
  readonly resolveTaskRefs: TeamConversationProps['resolveTaskRefs']
  readonly resolveThreadRefs: TeamConversationProps['resolveThreadRefs']
  readonly resolveMessageRefs: TeamConversationProps['resolveMessageRefs']
  readonly openMemberSession: TeamConversationProps['openMemberSession']
  readonly projectNameOf: (ref: AgentTeamProjectRef) => string | undefined
  readonly memberOf: (ref: AgentTeamMemberId) => ResolvedMemberRef | undefined
  /** Task number for one ref, from the Project projection; undefined stays 「…」. */
  readonly taskNumberOf: (taskRef: AgentTeamTaskRef) => number | undefined
  /** A durable read committed: the feed's unread badge clears without waiting for the Inbox. */
  readonly onRead: (threadRef: AgentTeamThreadRef) => void
  /** This Thread is a Task now — the Project closes the panel and walks the reader into it. */
  readonly onPromoted: (taskRef: AgentTeamTaskRef) => void
  readonly onClose: () => void
  readonly t: TeamConversationProps['t']
}

const factSender = (fact: AgentTeamThreadFact): AgentTeamMemberId | undefined => fact.kind === 'message' ? fact.message.sender : undefined
const factOccurredAt = (fact: AgentTeamThreadFact): string | undefined => fact.kind === 'message' ? fact.message.occurredAt : undefined

/** A taskless Thread's whole face beside its feed. Claims and acceptance stay on the Thread page. */
export function TeamProjectPanel({ surface, workspaceId, projectRef, threadRef, anchor, projectName, humanName, humanAvatarUrl, humanMemberId, members, projectMemberIds, projectOwnerIds, drafts, getAttachment, putAttachment, readThread, loadThreadHistory, threadObservations, reply, promoteThread, changeAttention, subscribeChanges, selectThread, selectDiscussion, selectProject, resolveTaskRefs, resolveThreadRefs, resolveMessageRefs, openMemberSession, projectNameOf, memberOf, taskNumberOf, onRead, onPromoted, onClose, t }: TeamProjectPanelProps) {
  const [openCard, setOpenCard] = useState<AgentTeamMessageRef>()
  // The promote button's own label: a reply send also raises the shared `pending` gate, and must not retitle it.
  const [mutating, setMutating] = useState<'promote' | undefined>()
  const rootRef = useRef<HTMLElement | null>(null)

  const projectMembers = members.filter(status => projectMemberIds.size === 0 || projectMemberIds.has(status.member.memberId))

  const memberName = (memberId: AgentTeamMemberId): string => {
    if (memberId === humanMemberId) return humanName
    const status = members.find(candidate => candidate.member.memberId === memberId)
    return status === undefined ? t('memberUnknown') : `@${status.member.handle}`
  }

  // The full page's opening rule, applied to the panel: only an Inbox arrival asks for the first unread Message that
  // names the Human; a plain open still lands at the latest fact. Memoized so its identity is stable across renders.
  const openingTarget = useMemo(
    () => anchor === 'unread' ? (facts: readonly AgentTeamThreadReadFact[]) => firstUnreadMention(facts, humanName) : undefined,
    [anchor, humanName],
  )

  const controller = useTeamThreadController({
    workspaceId, threadRef, readThread, loadThreadHistory, threadObservations, subscribeChanges, resolveMessageRefs, reply, drafts, putAttachment,
    projectMembers: () => projectMembers,
    memberName, t,
    onRead: () => { onRead(threadRef) },
    openingTarget,
  })

  const {
    projection, task, thread,
    currentFacts, readFacts, olderFacts, taskCards, followerIds, historyHasMore, loading, error, pending, autoReadExhausted,
    replyTarget, replyTo, pendingFiles, draftKey, flashedMessage, timelineRef,
    readCurrent, loadOlder, retryAutoRead, onTimelineScroll, setReplyTarget, setPendingFiles, clearSendState, sendReply, commit,
  } = controller

  const mentionHandlesMap = useMemo(() => new Map(members.map(status => [status.member.memberId, status.member.handle.replace(/^@/, '')])), [members])

  // Stable: it is a dependency of the memoized ref opener below, and TeamMessage is memoized on that.
  // A resolved ref carries its own Project: a discussion may cite one in a sibling Project, and the panel opens there.
  const openThreadRef = useMemo(() => resolvedThreadDestination(selectThread, selectDiscussion), [selectThread, selectDiscussion])
  const openRef = useCallback((ref: string): void => {
    if (ref.startsWith('project:')) {
      if (ref !== projectRef) selectProject(ref as AgentTeamProjectRef)
      return
    }
    if (ref === threadRef) return
    if (ref.startsWith('thread:')) {
      jumpToThread(resolveThreadRefs, workspaceId, ref as AgentTeamThreadRef, openThreadRef)
      return
    }
    if (ref.startsWith('task:')) {
      jumpToTaskThread(resolveTaskRefs, workspaceId, ref as AgentTeamTaskRef, selectThread)
    }
  }, [projectRef, threadRef, workspaceId, selectProject, openThreadRef, selectThread, resolveTaskRefs, resolveThreadRefs])

  const lookupTaskRefs = useMemo(() => hostTaskRefLookup(resolveTaskRefs, workspaceId), [resolveTaskRefs, workspaceId])
  const lookupThreadRefs = useMemo(() => hostThreadRefLookup(resolveThreadRefs, workspaceId), [resolveThreadRefs, workspaceId])
  const messageRefVersion = useResolvedMessageRefVersion()

  const replyContexts = useMemo(() => {
    const contexts = new Map<AgentTeamMessageRef, { readonly senderName: string; readonly excerpt: string; readonly messageRef: AgentTeamMessageRef }>()
    const nameOf = (memberId: AgentTeamMemberId): string => {
      if (memberId === humanMemberId) return humanName
      const status = members.find(candidate => candidate.member.memberId === memberId)
      return status === undefined ? t('memberUnknown') : `@${status.member.handle}`
    }
    for (const fact of currentFacts) {
      if (fact.kind !== 'message' || fact.message.replyToMessageRef === undefined) continue
      const parent = cachedResolvedMessageRef(fact.message.replyToMessageRef)
      contexts.set(fact.message.messageRef, parent === undefined
        ? { senderName: t('memberUnknown'), excerpt: '', messageRef: fact.message.replyToMessageRef }
        : { senderName: nameOf(parent.sender), excerpt: parent.excerpt, messageRef: parent.messageRef })
    }
    return contexts
  }, [currentFacts, messageRefVersion, members, humanMemberId, humanName, t])

  const handleReply = useCallback((messageRef: AgentTeamMessageRef): void => { setReplyTarget(messageRef) }, [])
  const handleToggleCard = useCallback((messageRef: AgentTeamMessageRef): void => {
    setOpenCard(current => current === messageRef ? undefined : messageRef)
  }, [])
  const jumpToMessage = useCallback((messageRef: AgentTeamMessageRef): void => {
    const row = rootRef.current?.querySelector(`[data-message-ref="${messageRef}"]`)
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'center' })
  }, [])

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
        projectNameOf={projectNameOf}
        memberOf={memberOf}
        onOpenMemberSession={openMemberSession}
        grouped={grouped}
        showGroupedTime
        cardOpen={openCard === fact.message.messageRef}
        onToggleCard={handleToggleCard}
        messageRef={fact.message.messageRef}
        {...(replyContexts.has(fact.message.messageRef) ? { replyTo: replyContexts.get(fact.message.messageRef)!, onOpenReplyTo: jumpToMessage } : {})}
        onReply={handleReply}
        rowActions="always"
        replyTarget={replyTarget === fact.message.messageRef}
        replyFlash={flashedMessage === fact.message.messageRef}
        {...(senderStatus === undefined ? {} : { senderTitle: senderStatus.member.description })}
      />
    }
    return <p className={threadCss.activityRow} key={factKey(fact)}><span className={threadCss.activityMark} aria-hidden="true" /><span className={threadCss.activityText}>{formatActivity(fact.activity, { t, actorName: memberName, claims: projection?.claims ?? [] })}</span></p>
  }

  const humanIdentity: TeamAvatarHuman | undefined = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) }

  /**
   * One derived Task card, rendered by the same component as the Project's Main stream and the discussion's own page: the
   * status, the live Claim owners and the reply count must not depend on which of the three faces is open.
   */
  const renderTaskCard = (entry: AgentTeamThreadTaskCard): ReactNode => {
    const task = entry.card.task
    return <TeamThreadCard
      key={`task-card-${task.taskRef}`}
      card={entry.card}
      unread={false}
      human={humanIdentity}
      t={t}
      onOpen={() => { selectThread(entry.card.threadRef, projectRef, task.taskRef, task.taskNumber) }}
    />
  }

  /** The one fact the unread boundary sits above: the first unread fact of the open discussion, or none once it is read. */
  const firstUnread = readFacts.find(fact => fact.unread)?.fact
  const firstUnreadKey = firstUnread === undefined ? undefined : factKey(firstUnread)

  /** Facts and derived cards in one sequence-ordered stream, with the day dividers and the unread boundary the page draws. */
  const renderTimeline = (facts: readonly AgentTeamThreadFact[], cards: readonly AgentTeamThreadTaskCard[]): ReactNode[] => {
    const placements = new Map<string, AgentTeamThreadTaskCard>(cards.map(card => [`task-card-${card.card.task.taskRef}`, card]))
    const entries = placeCards(facts, cards, fact => fact.sequence, card => ({ sequence: card.sequence, key: `task-card-${card.card.task.taskRef}` }))
    // The boundary sits above the first unread fact of the whole open discussion, as on the full page — not at every gap.
    // It belongs to the Inbox opening only: a plain card click keeps the panel it already was.
    const boundary = anchor === 'unread' ? firstUnreadKey : undefined
    const isBoundary = boundary === undefined ? undefined : (fact: AgentTeamThreadFact): boolean => factKey(fact) === boundary
    const nodes: TimelineNode<AgentTeamThreadFact, AgentTeamThreadTaskCard>[] = [...chunkTimeline(entries, factSender, factOccurredAt, isBoundary)]
    return nodes.map((node, nodeIndex) => {
      if (node.kind === 'day') return <p className={threadCss.daySeparator} key={`day-${nodeIndex}-${node.label}`}><span>{node.label}</span></p>
      if (node.kind === 'boundary') return <p key={`boundary-${nodeIndex}`} className={threadCss.unreadBoundary} role="separator"><span>{t('unreadBoundary')}</span></p>
      if (node.kind === 'card') return <Fragment key={node.key}>{renderTaskCard(placements.get(node.key)!)}</Fragment>
      if (node.kind === 'lone') return <Fragment key={factKey(node.fact)}>{renderFact(node.fact)}</Fragment>
      return <div className={css.messageRun} key={`run-${factKey(node.items[0]!)}`}>
        {node.items.map((entry, entryIndex) => <Fragment key={factKey(entry)}>{renderFact(entry, entryIndex > 0)}</Fragment>)}
      </div>
    })
  }

  // The same hook the Thread page uses, so the panel's follow control shows the Host's
  // current observation and recovers from a failed write exactly like the other face. The
  // follower set the Host projects is every Member's Attention, so the control is told which
  // id is the Human's — another Member's follow must not read as the Human's own.
  const follow = useThreadFollow(changeAttention, threadObservations, { workspaceId, threadRef }, undefined, humanMemberId)

  // The panel's only Task action; the promotion walks the reader into the Task's own Thread.
  const convertToTask = async (): Promise<void> => {
    if (pending || thread === undefined || task !== undefined) return
    setMutating('promote')
    try {
      await commit({
        key: 'promote',
        write: requestId => promoteThread({ requestId, workspaceId, threadRef, baseRevision: thread.revision }),
        onCommitted: committed => { onPromoted(committed.task.taskRef) },
      })
    } finally {
      setMutating(undefined)
    }
  }

  const currentFactsWithAnchor = mergeFacts(projection === undefined ? [] : [messageFact(projection.anchor, projection.anchorMentions)], currentFacts)
  const resolvedTaskNumber = task === undefined ? undefined : taskNumberOf(task.taskRef)
  const title = `${t('threadLabel')} · #${projectName}`

  return <aside ref={rootRef} className={projectCss.panel} aria-label={t('threadLabel')} data-team-panel={threadRef} data-team-thread={threadRef}>
    <TeamPanelHandle surface={surface} label={t('panelResize')} />
    <div className={projectCss.panelHead}>
      <span className={projectCss.panelTitle} title={title}>{title}</span>
      {/* The same control the Thread page's band carries, in the head's own room: the visible verb is the
          short one and the accessible name keeps the full phrase — and, while the write runs, the long
          pending phrase, so the panel announces progress the shortened visible word cannot. */}
      {thread !== undefined && <Button size="sm" variant="outline" className={follow.following === true ? css.toggleOn : undefined}
        disabled={follow.pending} aria-pressed={follow.following === true}
        aria-label={follow.pending ? t('followPending') : follow.following === true ? t('unfollowThread') : t('followThread')}
        onClick={() => { void follow.toggle(follow.following === true ? 'unfollow' : 'follow') }}>
        {follow.pending ? t('followPendingLabel') : follow.following === true ? t('unfollowLabel') : t('followLabel')}
      </Button>}
      {task === undefined && thread !== undefined && <Button size="sm" variant="primary" disabled={pending} onClick={() => { void convertToTask() }}>{mutating === 'promote' ? t('promotingTask') : t('promoteToTask')}</Button>}
      {task !== undefined && <Button size="sm" variant="primary" onClick={() => { onPromoted(task.taskRef) }}>{t('openTask', { number: resolvedTaskNumber ?? '…' })}</Button>}
      <Button size="sm" icon={<IconCloseOutlineRegular size={14} />} aria-label={t('panelClose')} onClick={onClose} />
    </div>
    {/* The follow control's own failure, stated beside the untouched control: a Remote failure is the
        one error this face can raise that the read surface below does not own. */}
    {follow.error !== undefined && <p className={css.actionError} role="alert">{follow.error}</p>}
    <section ref={timelineRef} onScroll={onTimelineScroll} className={projectCss.panelBody} aria-label={t('timelineLabel')}>
      {loading && projection === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingThread')}</p></div>}
      {projection === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void readCurrent() }}>{t('retry')}</Button></div>}
      {renderTimeline(olderFacts, taskCards.filter(card => card.sequence < (currentFactsWithAnchor[0]?.sequence ?? Number.POSITIVE_INFINITY)))}
      {historyHasMore && <div className={css.timelineAction}><Button size="sm" onClick={() => { void loadOlder() }}>{t('loadOlder')}</Button></div>}
      {renderTimeline(currentFactsWithAnchor, taskCards.filter(card => card.sequence >= (currentFactsWithAnchor[0]?.sequence ?? 0)))}
      {autoReadExhausted && <div className={css.timelineAction} role="alert">
        <span>{t('autoReadIncomplete')}</span>
        <Button size="sm" onClick={retryAutoRead} disabled={loading}>{t('retry')}</Button>
      </div>}
    </section>
    {projection !== undefined && thread !== undefined && <TeamComposer
      key={draftKey}
      members={members}
      followerMemberIds={followerIds}
      projectMemberIds={projectMemberIds}
      ownerMemberIds={projectOwnerIds}
      drafts={drafts}
      draftKey={draftKey}
      pending={pending}
      {...(error === undefined ? {} : { error })}
      onEdit={clearSendState}
      onSubmit={() => { void sendReply() }}
      placeholder={t('replyPlaceholder')}
      pendingFiles={pendingFiles}
      onFilesChange={setPendingFiles}
      {...(replyTo === undefined ? {} : {
        replyTo,
        onCancelReply: () => { setReplyTarget(undefined) },
      })}
      t={t}
    />}
  </aside>
}
