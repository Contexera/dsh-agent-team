import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamClientMemberStatus, AgentTeamMainTimelineEntry, AgentTeamMemberId, AgentTeamMessageRef,
  AgentTeamProjectRef, AgentTeamRequestId, AgentTeamTaskRef, AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import { isUncertainRemoteFailure, mergeSettledComposerUploads, mintRequestId, reconcileComposerUploads, sameComposerFiles, uploadComposerFiles, type ComposerUpload } from './requests.ts'
import { mainEntryKey, useMainStream } from './main-stream.ts'
import { TeamComposer } from './TeamComposer.tsx'
import { TeamThreadStartControls } from './TeamThreadStartControls.tsx'
import { TeamMessage } from './TeamMessage.tsx'
import type { TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamRunDivider } from './TeamRunDivider.tsx'
import { TeamThreadCard } from './TeamThreadCard.tsx'
import { rosterAccountableOwner } from './refs.ts'
import { formatAbsoluteTime, formatInboxTime, mentionNamesOf, plainGist } from './team-formatters.ts'
import { chunkRunsWithDays, isRunGap } from './team-separators.ts'
import { useTimelineScroll } from './timeline-scroll.ts'
import css from './conversation.module.css'
import threadCss from './thread.module.css'
import streamCss from './main-stream.module.css'

type MessageProps = ComponentProps<typeof TeamMessage>
type MainPostRequest = Parameters<TeamConversationProps['postMainMessage']>[0]
type ThreadStartRequest = Parameters<TeamConversationProps['startThread']>[0]
type MainSendMode = 'main' | 'discussion' | 'task'
type MainSendRequest =
  | { readonly kind: 'post'; readonly request: MainPostRequest }
  | { readonly kind: 'thread'; readonly request: ThreadStartRequest }

interface MainSendIntent {
  readonly requestId: AgentTeamRequestId
  readonly body: string
  readonly mode: MainSendMode
  readonly replyToMessageRef?: AgentTeamMessageRef | undefined
  readonly uploads: readonly ComposerUpload[]
  readonly request?: MainSendRequest | undefined
}

const matchesMainSend = (
  intent: MainSendIntent,
  body: string,
  mode: MainSendMode,
  replyToMessageRef: AgentTeamMessageRef | undefined,
  files: readonly File[],
): boolean => intent.body === body && intent.mode === mode
  && intent.replyToMessageRef === replyToMessageRef && sameComposerFiles(intent.uploads, files)

/** Generated Remote failures always carry a code; Main keeps its established explicit-failure handling for unclassified test doubles. */
const isUncertainMainFailure = (error: RemoteFailure): boolean =>
  (error as { readonly code?: string }).code !== undefined && isUncertainRemoteFailure(error)

interface TeamMainStreamProps {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly humanMemberId?: AgentTeamMemberId | undefined
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly projectMemberIds: ReadonlySet<AgentTeamMemberId>
  readonly projectOwnerIds: ReadonlySet<AgentTeamMemberId>
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
  /** A committed Task start: the board is where it lands, and the Task's own card is the landing target. */
  readonly onTaskStarted: (taskRef: AgentTeamTaskRef | undefined) => void
  readonly t: TeamConversationProps['t']
}

type MessageEntry = Extract<AgentTeamMainTimelineEntry, { readonly kind: 'message' }>

/** Rules version 2 Project reading: the Main stream timeline and its composer. Message, activity and card entries arrive from the Host already ordered. */
export function TeamMainStream({
  workspaceId, projectRef, humanName, humanAvatarUrl, humanMemberId, members, projectMemberIds, projectOwnerIds, drafts,
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
  const [flashedMessage, setFlashedMessage] = useState<AgentTeamMessageRef>()
  const draftKey: TeamDraftKey = `project:${projectRef}`
  const sending = useRef(false)
  const sendIntent = useRef<MainSendIntent>()
  const uploads = useRef<readonly ComposerUpload[]>([])
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

  const clearSendState = useCallback((): void => {
    sendIntent.current = undefined
    setNotice(current => current === undefined ? current : undefined)
    setActionError(current => current === undefined ? current : undefined)
  }, [])
  const changePendingFiles = useCallback((files: readonly File[]): void => {
    uploads.current = reconcileComposerUploads(files, uploads.current)
    sendIntent.current = undefined
    setPendingFiles(files)
  }, [])
  const handleReply = useCallback((messageRef: AgentTeamMessageRef): void => {
    sendIntent.current = undefined
    setReplyTarget(messageRef)
    setStartingThread(false)
    setAsTask(false)
  }, [])
  const handleToggleCard = useCallback((messageRef: AgentTeamMessageRef): void => {
    setOpenCard(current => current === messageRef ? undefined : messageRef)
  }, [])
  // A quoted line names a Message already in this timeline, so the jump is a scroll and a pulse rather than a route:
  // the Thread page's own gesture, wired here because the row's quote falls back to inert text without it.
  const timelineOnScroll = timeline.onScroll
  const jumpToMessage = useCallback((messageRef: AgentTeamMessageRef): void => {
    const node = document.querySelector(`[data-message-ref="${messageRef}"]`)
    if (node === null) return
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // Tell the shared scroll policy the reader is off the tail, or the next arriving Message counts them as pinned and
    // undoes the jump.
    timelineOnScroll()
    setFlashedMessage(messageRef)
  }, [timelineOnScroll])
  useEffect(() => {
    if (flashedMessage === undefined) return
    // The pulse is the jump's lifetime: releasing it releases the mark, so a settling jump never outlives its highlight.
    const timer = setTimeout(() => { setFlashedMessage(undefined) }, 1200)
    return () => { clearTimeout(timer) }
  }, [flashedMessage])
  const handleOpenReplyTo = useCallback((messageRef: AgentTeamMessageRef): void => { jumpToMessage(messageRef) }, [jumpToMessage])
  const toggleThreadStart = (open: boolean): void => {
    sendIntent.current = undefined
    setStartingThread(open)
    if (!open) setAsTask(false)
    else setReplyTarget(undefined)
  }
  const changeAsTask = (next: boolean): void => {
    sendIntent.current = undefined
    setAsTask(next)
  }

  const replyEntry = replyTarget === undefined
    ? undefined
    : entries.find((entry): entry is MessageEntry => entry.kind === 'message' && entry.message.messageRef === replyTarget)

  const send = async (): Promise<void> => {
    // Read at send time: this page does not subscribe to the draft.
    const { draft } = drafts.getSnapshot(draftKey)
    if (sending.current || pending || draft.trim() === '') return
    sending.current = true
    const body = draft.trim()
    const mode: MainSendMode = startingThread ? (asTask ? 'task' : 'discussion') : 'main'
    const replyToMessageRef = mode === 'main' ? replyTarget : undefined
    const currentUploads = reconcileComposerUploads(pendingFiles, uploads.current)
    uploads.current = currentUploads
    let intent = sendIntent.current
    if (intent === undefined || !matchesMainSend(intent, body, mode, replyToMessageRef, pendingFiles)) {
      intent = { requestId: mintRequestId(), body, mode, ...(replyToMessageRef === undefined ? {} : { replyToMessageRef }), uploads: currentUploads }
      sendIntent.current = intent
    }
    setPending(true); setActionError(undefined); setNotice(undefined)
    try {
      const upload = await uploadComposerFiles(putAttachment, workspaceId, intent.uploads)
      const stillCurrent = sendIntent.current?.requestId === intent.requestId
      uploads.current = stillCurrent ? upload.uploads : mergeSettledComposerUploads(uploads.current, upload.uploads)
      if (!stillCurrent) return
      intent = { ...intent, uploads: upload.uploads }
      sendIntent.current = intent
      if (!upload.ok) {
        setActionError(upload.error)
        return
      }
      let submission = intent.request
      if (submission === undefined) {
        const content = {
          requestId: intent.requestId, workspaceId, projectRef, body: intent.body,
          ...(intent.replyToMessageRef === undefined ? {} : { replyToMessageRef: intent.replyToMessageRef }),
          ...(upload.attachmentIds.length === 0 ? {} : { attachments: upload.attachmentIds }),
        }
        submission = intent.mode === 'main'
          ? { kind: 'post', request: content }
          : { kind: 'thread', request: { ...content, kind: intent.mode } }
        intent = { ...intent, request: submission }
        sendIntent.current = intent
      }
      const result = submission.kind === 'thread'
        ? await startThread(submission.request)
        : await postMainMessage(submission.request)
      const ownsIntent = sendIntent.current?.requestId === intent.requestId
      if (!result.ok) {
        if (ownsIntent) {
          if (!isUncertainMainFailure(result.error)) sendIntent.current = undefined
          setActionError(result.error.message)
        }
      } else if (result.value.kind === 'committed') {
        if (ownsIntent) {
          sendIntent.current = undefined
          uploads.current = []
          setStartingThread(false)
          setAsTask(false)
          setReplyTarget(undefined)
          drafts.clear(draftKey)
          setPendingFiles([])
          timeline.scrollToBottom()
          if (intent.mode === 'task') onTaskStarted('task' in result.value ? result.value.task?.taskRef : undefined)
        }
        await stream.refresh()
      } else {
        // The draft stays; a resend after reading is a new operation.
        if (ownsIntent) {
          sendIntent.current = undefined
          setNotice(t('mainUnreadRequired'))
        }
        await stream.refresh()
        await stream.markRead()
      }
    } catch (cause) {
      if (sendIntent.current?.requestId === intent.requestId) setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sending.current = false
      setPending(false)
    }
  }

  const renderEntry = (entry: AgentTeamMainTimelineEntry, index: number, run: readonly AgentTeamMainTimelineEntry[]) => {
    // The accent states an arrival, not a standing: it holds for a few seconds after the entry is first shown and then
    // releases on its own clock, so a reader who stays on the page is not left with a mark that never goes away.
    const unread = stream.marked.has(mainEntryKey(entry)) ? '' : undefined
    if (entry.kind === 'activity') {
      const activity = entry.activity
      // A subscription lifecycle line names a script, not a Task. The Host
      // writes the automatic pause after repeated failures without an actor of
      // its own, so that line says who acted instead of guessing a Member.
      if ('subscriptionRef' in activity) {
        const text = activity.kind === 'subscription-paused' && activity.reason === 'failures'
          ? t('mainSubscriptionPausedByHost', { name: activity.subscriptionName })
          : t(activity.kind === 'subscription-created' ? 'mainSubscriptionCreated'
            : activity.kind === 'subscription-updated' ? 'mainSubscriptionUpdated'
              : activity.kind === 'subscription-paused' ? 'mainSubscriptionPaused'
                : activity.kind === 'subscription-resumed' ? 'mainSubscriptionResumed'
                  : activity.kind === 'subscription-webhook-reset' ? 'mainSubscriptionWebhookReset' : 'mainSubscriptionDeleted',
          { actor: activity.actor === undefined ? t('mainSubscriptionHostActor') : nameOf(activity.actor), name: activity.subscriptionName })
        return <div className={streamCss.entry} data-main-entry="subscription" data-unread={unread} key={mainEntryKey(entry)}>
          <p className={threadCss.activityRow} ><span className={threadCss.activityMark} aria-hidden="true" /><span className={threadCss.activityText}>{text}</span></p>
        </div>
      }
      const text = t(activity.kind === 'owner-added' ? 'mainOwnerAdded' : 'mainOwnerRemoved', {
        actor: nameOf(activity.actor), member: nameOf(activity.memberId),
      })
      return <div className={streamCss.entry} data-main-entry="activity" data-unread={unread} key={mainEntryKey(entry)}>
        <p className={threadCss.activityRow} ><span className={threadCss.activityMark} aria-hidden="true" /><span className={threadCss.activityText}>{text}</span></p>
      </div>
    }
    if (entry.kind === 'subscription-event') {
      // What a script printed is data. It is rendered as text, never parsed for
      // mentions or Markdown, and the marker states that boundary on screen.
      // The block is content, not a system notice: its mark seats where a Message's identity seats and the head,
      // title and detail share the feed's text column. The head states the three facts that never change — which
      // subscription, when, and how much to trust it — so the warning is a clause there instead of a sentence
      // repeated under every event, and the title is the one place a reader aims at, so a link is the title.
      const { event } = entry.event
      return <div className={streamCss.entry} data-main-entry="subscription-event" data-unread={unread} key={mainEntryKey(entry)}>
        <div className={streamCss.subscriptionEvent}>
          <p className={streamCss.subscriptionEventHead}>
            <span className={streamCss.subscriptionEventLabel}>{entry.event.subscriptionName}</span>
            <time className={streamCss.subscriptionEventTime} dateTime={entry.occurredAt} title={formatAbsoluteTime(entry.occurredAt)}>{formatInboxTime(entry.occurredAt, t)}</time>
            <span className={streamCss.subscriptionEventWarning}>{t('mainSubscriptionEventUntrusted')}</span>
          </p>
          <div className={streamCss.subscriptionEventBody}>
            <p className={streamCss.subscriptionEventTitle}>
              {event.url === undefined ? event.title : <a href={event.url} target="_blank" rel="noreferrer noopener">{event.title}</a>}
            </p>
            {event.detail === undefined ? null : <p className={streamCss.subscriptionEventDetail}>{event.detail}</p>}
          </div>
        </div>
      </div>
    }
    if (entry.kind === 'thread-card') {
      // The accent states the arrival; the card's accessible name states the durable standing a read clears. A name that
      // expired with the accent would be unstable to a screen reader.
      return <div className={streamCss.entry} data-main-entry="thread-card" data-unread={unread} key={mainEntryKey(entry)}>
        <TeamThreadCard
          card={entry.card}
          unread={entry.unread}
          human={human}
          humanMemberId={humanMemberId}
          accountableOwner={entry.card.task === undefined ? undefined : rosterAccountableOwner(members, humanMemberId, humanName, entry.card.task.accountable)}
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
          onOpenReplyTo={handleOpenReplyTo}
          rowActions="always"
          replyTarget={replyTarget === message.messageRef}
          replyFlash={flashedMessage === message.messageRef}
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
        {stream.loading && entries.length === 0 && stream.error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingMainStream')}</p></div>}
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
      projectMemberIds={projectMemberIds}
      ownerMemberIds={projectOwnerIds}
      drafts={drafts}
      draftKey={draftKey}
      pending={pending}
      placeholder={startingThread ? t(asTask ? 'startTaskPlaceholder' : 'startThreadPlaceholder') : t('messagePlaceholder')}
      {...(notice === undefined ? {} : { notice })}
      {...(error === undefined ? {} : { error })}
      onEdit={clearSendState}
      onSubmit={() => { void send() }}
      pendingFiles={pendingFiles}
      onFilesChange={changePendingFiles}
      {...(replyEntry === undefined ? {} : {
        replyTo: { memberId: replyEntry.message.sender, senderName: nameOf(replyEntry.message.sender), excerpt: plainGist(replyEntry.message.body) },
        onCancelReply: () => { sendIntent.current = undefined; setReplyTarget(undefined) },
      })}
      toolbarExtra={<TeamThreadStartControls open={startingThread} asTask={asTask} pending={pending} onOpenChange={toggleThreadStart} onAsTaskChange={changeAsTask} t={t} />}
      t={t}
    />
  </>
}
