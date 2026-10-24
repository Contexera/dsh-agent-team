import { Fragment, useCallback, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import type {
  AgentTeamClientMemberStatus, AgentTeamMainThreadCard, AgentTeamMainTimelineEntry, AgentTeamMemberId, AgentTeamMessageRef,
  AgentTeamProjectRef, AgentTeamRequestId, AgentTeamTaskRef, AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import { mintRequestId, uploadComposerFiles } from './requests.ts'
import { mainEntryKey, useMainStream } from './main-stream.ts'
import { TeamComposer } from './TeamComposer.tsx'
import { TeamThreadStartControls } from './TeamThreadStartControls.tsx'
import { TeamMessage } from './TeamMessage.tsx'
import { TeamAvatarStack, namedAvatarOwners, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamRunDivider } from './TeamRunDivider.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, formatTaskStatus, formatTaskTitle, mentionNamesOf, taskStatusDot } from './team-formatters.ts'
import { chunkRunsWithDays, isRunGap } from './team-separators.ts'
import { useTimelineScroll } from './timeline-scroll.ts'
import css from './conversation.module.css'
import threadCss from './thread.module.css'
import streamCss from './main-stream.module.css'

type MessageProps = ComponentProps<typeof TeamMessage>

interface TeamMainStreamProps {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly humanMemberId?: AgentTeamMemberId | undefined
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly projectMemberIds: ReadonlySet<AgentTeamMemberId>
  readonly drafts: TeamDraftStore
  readonly mainStreamHistory: TeamConversationProps['mainStreamHistory']
  readonly readMainStream: TeamConversationProps['readMainStream']
  readonly postMainMessage: TeamConversationProps['postMainMessage']
  readonly startThread: TeamConversationProps['startThread']
  readonly putAttachment: TeamConversationProps['putAttachment']
  readonly getAttachment: TeamConversationProps['getAttachment']
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly openRef: (ref: string) => void
  readonly onResolveTaskRefs: MessageProps['onResolveTaskRefs']
  readonly onResolveThreadRefs: MessageProps['onResolveThreadRefs']
  readonly projectNameOf: MessageProps['projectNameOf']
  readonly memberOf: MessageProps['memberOf']
  readonly openMemberSession: TeamConversationProps['openMemberSession']
  readonly onOpenDiscussion: (threadRef: AgentTeamThreadRef) => void
  readonly onOpenTask: (threadRef: AgentTeamThreadRef, taskRef: AgentTeamTaskRef, taskNumber: number) => void
  /** A committed Task start: the board is where it lands. */
  readonly onTaskStarted: () => void
  readonly t: TeamConversationProps['t']
}

type MessageEntry = Extract<AgentTeamMainTimelineEntry, { readonly kind: 'message' }>

/** Rules version 2 Project reading: the Main stream timeline and its composer. Message, activity and card entries arrive from the Host already ordered. */
export function TeamMainStream({
  workspaceId, projectRef, humanName, humanAvatarUrl, humanMemberId, members, projectMemberIds, drafts,
  mainStreamHistory, readMainStream, postMainMessage, startThread, putAttachment, getAttachment, subscribeChanges,
  openRef, onResolveTaskRefs, onResolveThreadRefs, projectNameOf, memberOf, openMemberSession, onOpenDiscussion, onOpenTask, onTaskStarted, t,
}: TeamMainStreamProps) {
  const stream = useMainStream({ workspaceId, projectRef, mainStreamHistory, readMainStream, subscribeChanges })
  const { entries } = stream
  const [pending, setPending] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([])
  const [actionError, setActionError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [startingThread, setStartingThread] = useState(false)
  const [asTask, setAsTask] = useState(false)
  const [replyTarget, setReplyTarget] = useState<AgentTeamMessageRef>()
  const [openCard, setOpenCard] = useState<AgentTeamMessageRef>()
  const draftKey: TeamDraftKey = `project:${projectRef}`
  // Retained across transport failures so a replayed send dedupes on the Host.
  const pendingSendId = useRef<AgentTeamRequestId>()
  const lastEntry = entries.at(-1)
  const timeline = useTimelineScroll(`${entries.length}:${lastEntry === undefined ? '' : mainEntryKey(lastEntry)}`)
  const error = actionError ?? stream.error

  const handleByMember = useMemo(() => new Map(members.map(status => [status.member.memberId, status.member.handle.replace(/^@/, '')])), [members])
  const human: TeamAvatarHuman | undefined = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) }
  const nameOf = (memberId: AgentTeamMemberId): string => {
    if (memberId === humanMemberId) return humanName
    const handle = handleByMember.get(memberId)
    return handle === undefined ? memberId : `@${handle}`
  }

  const clearNotice = useCallback((): void => { setNotice(current => current === undefined ? current : undefined) }, [])
  const handleReply = useCallback((messageRef: AgentTeamMessageRef): void => {
    setReplyTarget(messageRef)
    setStartingThread(false)
    setAsTask(false)
  }, [])
  const handleToggleCard = useCallback((messageRef: AgentTeamMessageRef): void => {
    setOpenCard(current => current === messageRef ? undefined : messageRef)
  }, [])
  const toggleThreadStart = (open: boolean): void => {
    setStartingThread(open)
    if (!open) setAsTask(false)
    else setReplyTarget(undefined)
  }

  const replyEntry = replyTarget === undefined
    ? undefined
    : entries.find((entry): entry is MessageEntry => entry.kind === 'message' && entry.message.messageRef === replyTarget)

  const send = async (): Promise<void> => {
    // Read at send time: this page does not subscribe to the draft.
    const { draft, recipients } = drafts.getSnapshot(draftKey)
    if (pending || draft.trim() === '') return
    const requestId = pendingSendId.current ?? mintRequestId()
    pendingSendId.current = requestId
    setPending(true); setActionError(undefined); setNotice(undefined)
    try {
      const upload = await uploadComposerFiles(putAttachment, workspaceId, pendingFiles)
      if (!upload.ok) {
        pendingSendId.current = undefined
        setActionError(upload.error)
        return
      }
      const content = {
        requestId, workspaceId, projectRef, body: draft.trim(), recipients: [...recipients].sort(),
        ...(upload.attachmentIds.length === 0 ? {} : { attachments: upload.attachmentIds }),
      }
      const starting = startingThread
      const startedTask = starting && asTask
      const result = starting
        ? await startThread({ ...content, kind: startedTask ? 'task' : 'discussion' })
        : await postMainMessage({ ...content, ...(replyTarget === undefined ? {} : { replyToMessageRef: replyTarget }) })
      if (!result.ok) {
        pendingSendId.current = undefined
        setActionError(result.error.message)
      } else if (result.value.kind === 'committed') {
        pendingSendId.current = undefined
        setStartingThread(false)
        setAsTask(false)
        setReplyTarget(undefined)
        await stream.refresh()
        drafts.clear(draftKey)
        setPendingFiles([])
        timeline.scrollToBottom()
        if (startedTask) onTaskStarted()
      } else {
        // The draft stays; a resend after reading is a new operation.
        pendingSendId.current = undefined
        setNotice(t('mainUnreadRequired'))
        await stream.refresh()
        await stream.markRead()
      }
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }

  const renderEntry = (entry: AgentTeamMainTimelineEntry, index: number, run: readonly AgentTeamMainTimelineEntry[]) => {
    const unread = entry.unread ? '' : undefined
    if (entry.kind === 'activity') {
      const text = t(entry.activity.kind === 'owner-added' ? 'mainOwnerAdded' : 'mainOwnerRemoved', {
        actor: nameOf(entry.activity.actor), member: nameOf(entry.activity.memberId),
      })
      return <div className={streamCss.entry} data-main-entry="activity" data-unread={unread} key={mainEntryKey(entry)}>
        <p className={threadCss.activityRow}><span className={threadCss.activityMark} aria-hidden="true" /><span className={threadCss.activityText}>{text}</span></p>
      </div>
    }
    if (entry.kind === 'thread-card') {
      return <div className={streamCss.entry} data-main-entry="thread-card" data-unread={unread} key={mainEntryKey(entry)}>
        <MainThreadCard
          entry={entry}
          unread={entry.unread}
          human={human}
          t={t}
          onOpen={() => {
            if (entry.card.task === undefined) onOpenDiscussion(entry.card.threadRef)
            else onOpenTask(entry.card.threadRef, entry.card.task.taskRef, entry.card.task.taskNumber)
          }}
        />
      </div>
    }
    const { message } = entry
    const senderStatus = members.find(status => status.member.memberId === message.sender)
    const isHuman = message.sender === humanMemberId
    const previous = index > 0 ? run[index - 1] : undefined
    const turnGap = isRunGap(previous?.occurredAt, entry.occurredAt)
    return <Fragment key={mainEntryKey(entry)}>
      {turnGap && <TeamRunDivider />}
      <div className={streamCss.entry} data-main-entry="message" data-unread={unread}>
        <TeamMessage
          senderName={isHuman ? humanName : senderStatus?.member.handle ?? message.sender}
          memberId={message.sender}
          human={isHuman}
          readerName={humanName}
          {...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl })}
          body={message.body}
          attachments={message.attachments}
          loadAttachment={getAttachment}
          t={t}
          occurredAt={message.occurredAt}
          mentionNames={mentionNamesOf(entry.mentions, handleByMember, humanName)}
          onOpenRef={openRef}
          onResolveTaskRefs={onResolveTaskRefs}
          onResolveThreadRefs={onResolveThreadRefs}
          projectNameOf={projectNameOf}
          memberOf={memberOf}
          onOpenMemberSession={openMemberSession}
          grouped={index > 0 && previous?.kind === 'message'}
          showGroupedTime
          cardOpen={openCard === message.messageRef}
          onToggleCard={handleToggleCard}
          messageRef={message.messageRef}
          {...(entry.replyTo === undefined || message.replyToMessageRef === undefined ? {} : {
            replyTo: {
              senderName: entry.replyTo.sender === 'human' ? humanName : `@${entry.replyTo.sender.replace(/^@/, '')}`,
              excerpt: entry.replyTo.excerpt,
              messageRef: message.replyToMessageRef,
            },
          })}
          onReply={handleReply}
          rowActions="always"
          replyTarget={replyTarget === message.messageRef}
          {...(senderStatus === undefined ? {} : { senderTitle: senderStatus.member.description })}
        />
      </div>
    </Fragment>
  }

  const blocks = chunkRunsWithDays(
    entries,
    entry => entry.kind === 'message' ? entry.message.sender : mainEntryKey(entry),
    entry => entry.occurredAt,
  )

  return <>
    <section ref={timeline.ref} onScroll={timeline.onScroll} className={css.timeline} aria-label={t('timelineLabel')}>
      <div className={css.timelineContent}>
        {stream.loading && entries.length === 0 && stream.error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingProjects')}</p></div>}
        {!stream.loading && entries.length === 0 && stream.error !== undefined && <div className={css.errorState} role="alert"><span>{stream.error}</span><Button size="sm" variant="outline" onClick={() => { void stream.refresh() }}>{t('retry')}</Button></div>}
        {stream.hasMore && <div className={css.timelineAction}><Button size="sm" disabled={stream.loadingOlder} onClick={() => { void stream.loadOlder() }}>{t('loadOlder')}</Button></div>}
        {!stream.loading && entries.length === 0 && stream.error === undefined && <div className={css.emptySurface}>
          <div className={css.emptyState}>
            <strong>{t('mainEmpty')}</strong>
            <span>{t('mainEmptyHint')}</span>
          </div>
        </div>}
        {blocks.map((block, blockIndex) => block.kind === 'day'
          ? <p className={threadCss.daySeparator} key={`day-${blockIndex}-${block.label}`}><span>{block.label}</span></p>
          : <div className={css.messageRun} key={`run-${mainEntryKey(block.items[0]!)}`}>
            {block.items.map((entry, index) => renderEntry(entry, index, block.items))}
          </div>)}
      </div>
    </section>
    <TeamComposer
      key={draftKey}
      members={members}
      projectPeerMemberIds={projectMemberIds}
      drafts={drafts}
      draftKey={draftKey}
      pending={pending}
      placeholder={startingThread ? t(asTask ? 'startTaskPlaceholder' : 'startThreadPlaceholder') : t('messagePlaceholder')}
      {...(notice === undefined ? {} : { notice })}
      {...(error === undefined ? {} : { error })}
      onEdit={clearNotice}
      onSubmit={() => { void send() }}
      pendingFiles={pendingFiles}
      onFilesChange={setPendingFiles}
      {...(replyEntry === undefined ? {} : {
        replyTo: { memberId: replyEntry.message.sender, senderName: nameOf(replyEntry.message.sender), excerpt: formatTaskTitle(replyEntry.message.body) },
        onCancelReply: () => { setReplyTarget(undefined) },
      })}
      toolbarExtra={<TeamThreadStartControls open={startingThread} asTask={asTask} pending={pending} onOpenChange={toggleThreadStart} onAsTaskChange={setAsTask} t={t} />}
      t={t}
    />
  </>
}

/** A Thread's current state at the place its anchor was written. A card is the entry door itself, so it carries no separate row. */
function MainThreadCard({ entry, unread, human, t, onOpen }: {
  readonly entry: Extract<AgentTeamMainTimelineEntry, { readonly kind: 'thread-card' }>
  readonly unread: boolean
  readonly human: TeamAvatarHuman | undefined
  readonly t: TeamConversationProps['t']
  readonly onOpen: () => void
}) {
  const card: AgentTeamMainThreadCard = entry.card
  const task = card.task
  const title = formatTaskTitle(card.anchor.preview)
  const resolved = task?.status === 'done' || task?.status === 'closed'
  const owners = namedAvatarOwners(task?.liveClaimOwners ?? [], human)
  const replies = t('cardReplies', { count: card.replyCount })
  const people = card.participants.length === 0 || task !== undefined ? undefined : t('cardParticipants', { count: card.participants.length })
  const label = [
    task === undefined ? t('openDiscussionCard', { title }) : t('openTaskCard', { number: task.taskNumber, title }),
    task === undefined ? undefined : formatTaskStatus(task.status, t),
    owners.length === 0 ? undefined : claimersLabel(owners, t),
    replies,
    people,
    unread ? t('cardUnread') : undefined,
  ].filter((part): part is string => part !== undefined).join(' · ')
  return <button
    type="button"
    className={streamCss.card}
    data-main-card={task === undefined ? 'discussion' : 'task'}
    {...(resolved ? { 'data-resolved': '' } : {})}
    aria-label={label}
    onClick={onOpen}
  >
    <span className={streamCss.cardHead}>
      <span className={streamCss.cardKind}>
        {task === undefined ? t('discussionLabel') : <>
          <TeamStateDot size={8} state={taskStatusDot(task.status)} />
          {t('taskLabel', { number: task.taskNumber })}
        </>}
      </span>
      {task !== undefined && <span className={streamCss.cardStatus}>{formatTaskStatus(task.status, t)}</span>}
      {task !== undefined && owners.length === 0 && <span>{t('boardUnassigned')}</span>}
      {task !== undefined && owners.length > 0 && <TeamAvatarStack owners={owners} label={claimersLabel(owners, t)} human={human} />}
      <span className={streamCss.cardMeta}>
        <span>{replies}</span>
        {people !== undefined && <span>{people}</span>}
        <time dateTime={card.newestOccurredAt} title={formatAbsoluteTime(card.newestOccurredAt)}>{formatInboxTime(card.newestOccurredAt, t)}</time>
      </span>
    </span>
    <span className={streamCss.cardTitle}>{title}</span>
  </button>
}
