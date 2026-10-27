import { Fragment, useCallback, useMemo, useRef, useState } from 'react'
import type {
  AgentTeamProjectRef,
  AgentTeamClientMemberStatus,
  AgentTeamMemberId,
  AgentTeamMessageRef,
  AgentTeamTaskRef,
  AgentTeamThreadFact,
  AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftStore } from './drafts.ts'
import { TeamComposer } from './TeamComposer.tsx'
import { TeamPanelHandle } from './TeamPanelHandle.tsx'
import { TeamMessage } from './TeamMessage.tsx'
import { formatActivity } from './team-formatters.ts'
import { factKey, mergeFacts, messageFact, stableMentionNames } from './thread-facts.ts'
import { chunkRunsWithDays } from './team-separators.ts'
import { cachedResolvedMessageRef, useResolvedMessageRefVersion } from './refs.ts'
import { hostTaskRefLookup, hostThreadRefLookup, jumpToTaskThread, jumpToThread, type ResolvedMemberRef } from './refs.ts'
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
  readonly projectName: string
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly humanMemberId?: AgentTeamMemberId | undefined
  /** The Project page's roster: the panel reads it instead of pulling its own copy. */
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly projectMemberIds: ReadonlySet<AgentTeamMemberId>
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
export function TeamProjectPanel({ surface, workspaceId, projectRef, threadRef, projectName, humanName, humanAvatarUrl, humanMemberId, members, projectMemberIds, drafts, getAttachment, putAttachment, readThread, loadThreadHistory, threadObservations, reply, promoteThread, changeAttention, subscribeChanges, selectThread, selectProject, resolveTaskRefs, resolveThreadRefs, resolveMessageRefs, openMemberSession, projectNameOf, memberOf, taskNumberOf, onRead, onPromoted, onClose, t }: TeamProjectPanelProps) {
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

  const controller = useTeamThreadController({
    workspaceId, threadRef, readThread, loadThreadHistory, threadObservations, subscribeChanges, resolveMessageRefs, reply, drafts, putAttachment,
    projectMembers: () => projectMembers,
    memberName, t,
    onRead: () => { onRead(threadRef) },
  })

  const {
    projection, task, thread,
    currentFacts, olderFacts, followerIds, historyHasMore, loading, error, pending, autoReadExhausted,
    replyTarget, replyTo, pendingFiles, draftKey, timelineRef,
    readCurrent, loadOlder, retryAutoRead, onTimelineScroll, setReplyTarget, setPendingFiles, clearSendState, sendReply, commit,
  } = controller

  const mentionHandlesMap = useMemo(() => new Map(members.map(status => [status.member.memberId, status.member.handle.replace(/^@/, '')])), [members])

  const openRef = useCallback((ref: string): void => {
    if (ref.startsWith('project:')) {
      if (ref !== projectRef) selectProject(ref as AgentTeamProjectRef)
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
  }, [projectRef, threadRef, workspaceId, selectProject, selectThread, resolveTaskRefs, resolveThreadRefs])

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
      {renderBlocks(olderFacts)}
      {historyHasMore && <div className={css.timelineAction}><Button size="sm" onClick={() => { void loadOlder() }}>{t('loadOlder')}</Button></div>}
      {renderBlocks(currentFactsWithAnchor)}
      {autoReadExhausted && <div className={css.timelineAction} role="alert">
        <span>{t('autoReadIncomplete')}</span>
        <Button size="sm" onClick={retryAutoRead} disabled={loading}>{t('retry')}</Button>
      </div>}
    </section>
    {projection !== undefined && thread !== undefined && <TeamComposer
      key={draftKey}
      members={members}
      followerMemberIds={followerIds}
      projectPeerMemberIds={projectMemberIds}
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
