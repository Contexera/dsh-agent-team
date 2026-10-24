import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamProjectRef, AgentTeamInbox, AgentTeamMemberId, AgentTeamSendMessageRequest, AgentTeamTask, AgentTeamView, AgentTeamViewItem,
  AgentTeamTaskRef, AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { Button, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { mintRequestId, uploadComposerFiles } from './requests.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import { TeamComposer } from './TeamComposer.tsx'
import { TeamMainStream } from './TeamMainStream.tsx'
import { TeamProjectPanel } from './TeamProjectPanel.tsx'
import { resolvePanelWidth, readPanelWidthPreference } from './panel-width.ts'
import { TeamMessage } from './TeamMessage.tsx'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman, type TeamAvatarOwner } from './TeamAvatarStack.tsx'
import { TeamCountBadge } from './TeamCountBadge.tsx'
import { TeamRunDivider } from './TeamRunDivider.tsx'
import { claimersLabel, formatAbsoluteTime, formatDateOnly, formatInboxTime, formatTaskStatus, formatTaskTitle, taskStatusDot, mentionNamesOf } from './team-formatters.ts'
import { TeamStateDot } from './TeamStateDot.tsx'
import { useTimelineScroll } from './timeline-scroll.ts'
import { hostTaskRefLookup, jumpToTaskThread } from './refs.ts'
import { hostThreadRefLookup, jumpToThread } from './refs.ts'
import { rosterProjectName, rosterMember } from './refs.ts'
import { chunkRunsWithDays, isRunGap } from './team-separators.ts'
import projectCss from './project.module.css'
import css from './conversation.module.css'
import threadCss from './thread.module.css'

interface TeamProjectPageProps {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly loadProjects: TeamConversationProps['loadProjects']
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly loadMembers: TeamConversationProps['loadMembers']
  /** The Human's own unread per Thread: the Host's three-class judgement, never a Client guess. */
  readonly loadInbox: TeamConversationProps['loadInbox']
  readonly drafts: TeamDraftStore
  readonly getAttachment: TeamConversationProps['getAttachment']
  readonly putAttachment: TeamConversationProps['putAttachment']
  readonly sendMessage: TeamConversationProps['sendMessage']
  readonly postMainMessage: TeamConversationProps['postMainMessage']
  readonly startThread: TeamConversationProps['startThread']
  readonly readMainStream: TeamConversationProps['readMainStream']
  readonly mainStreamHistory: TeamConversationProps['mainStreamHistory']
  readonly readThread: TeamConversationProps['readThread']
  readonly loadThreadHistory: TeamConversationProps['loadThreadHistory']
  readonly threadObservations: TeamConversationProps['threadObservations']
  readonly reply: TeamConversationProps['reply']
  readonly promoteThread: TeamConversationProps['promoteThread']
  readonly selectThread: TeamConversationProps['selectThread']
  readonly selectProject: TeamConversationProps['selectProject']
  readonly resolveTaskRefs: TeamConversationProps['resolveTaskRefs']
  readonly resolveThreadRefs: TeamConversationProps['resolveThreadRefs']
  readonly resolveMessageRefs: TeamConversationProps['resolveMessageRefs']
  readonly openMemberSession: TeamConversationProps['openMemberSession']
  readonly t: TeamConversationProps['t']
}

/** Fresh window is authoritative for every Message it covers; older loaded Messages are retained. */
function mergeProjectView(current: AgentTeamView, fresh: AgentTeamView): AgentTeamView {
  // An empty window's cursor is the request default, not a loaded boundary, so it must not cap the fresh one.
  if (current.items.length === 0) return fresh
  const freshRefs = new Set(fresh.items.map(item => item.message.messageRef))
  const items = [...current.items.filter(item => !freshRefs.has(item.message.messageRef)), ...fresh.items]
    .sort((left, right) => left.message.sequence - right.message.sequence)
  return {
    ...fresh,
    items,
    cursor: Math.min(fresh.cursor, current.cursor),
    hasMore: fresh.hasMore || hasOlderBeyondFreshWindow(current, fresh),
  }
}

function hasOlderBeyondFreshWindow(current: AgentTeamView, fresh: AgentTeamView): boolean {
  return current.cursor < fresh.cursor
}

/** Latest fact instant, or nothing when the entry's own Message is the newest on its Thread. */
function newerActivityAt(item: AgentTeamViewItem): string | undefined {
  const lastActivityAt: string | undefined = item.lastActivityAt
  return lastActivityAt === undefined || lastActivityAt === item.message.occurredAt ? undefined : lastActivityAt
}

/** Resolved Tasks print their resolution day instead (see `ThreadEntryRow`), so recency is omitted for them. */
function unresolvedFollowUpAt(item: AgentTeamViewItem): string | undefined {
  const status = item.task?.status
  return status === 'done' || status === 'closed' ? undefined : newerActivityAt(item)
}

/** Zero unread is the absence of a badge. A failed read keeps the previous counts rather than rendering as "everything was consumed". */
function applyInboxRead(
  previous: ReadonlyMap<AgentTeamThreadRef, number>,
  result: RemoteResult<AgentTeamInbox>,
): ReadonlyMap<AgentTeamThreadRef, number> {
  if (!result.ok) return previous
  return new Map(result.value.items.filter(item => item.unreadCount > 0).map(item => [item.thread.threadRef, item.unreadCount]))
}

export function TeamProjectPage({ workspaceId, projectRef, humanName, humanAvatarUrl, loadProjects, subscribeChanges, loadMembers, loadInbox, drafts, putAttachment, getAttachment, sendMessage, postMainMessage, startThread, readMainStream, mainStreamHistory, readThread, loadThreadHistory, threadObservations, reply, promoteThread, selectThread, selectProject, resolveTaskRefs, resolveThreadRefs, resolveMessageRefs, openMemberSession, t }: TeamProjectPageProps) {
  const [view, setView] = useState<AgentTeamView>()
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [unreadByThread, setUnreadByThread] = useState<ReadonlyMap<AgentTeamThreadRef, number>>(new Map())
  const [actionError, setError] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const error = actionError ?? loadError
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([])
  const [statusMessage, setStatusMessage] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [asTask, setAsTask] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [tab, setTab] = useState<'feed' | 'board'>('feed')
  const [panelThreadRef, setPanelThreadRef] = useState<AgentTeamThreadRef>()
  // The surface owns the panel-width variable; a drag writes it there so this page never re-renders.
  const [panelSurface, setPanelSurface] = useState<HTMLElement | null>(null)
  // The draft cache outlives this page across view switches; the composer owns the subscription so typing never re-renders the timeline.
  const draftKey: TeamDraftKey = `project:${projectRef}`
  const mountedRef = useRef(false)
  // True after the first load; later refreshes keep the rendered timeline.
  const loadedRef = useRef(false)
  const refreshSequenceRef = useRef(0)
  const projectLastItem = view?.items[view.items.length - 1]
  const tabIdPrefix = useId()
  const feedTabRef = useRef<HTMLButtonElement>(null)
  const boardTabRef = useRef<HTMLButtonElement>(null)
  // Enter and Space need no branch: the button's own activation fires click.
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const order: readonly { readonly value: 'feed' | 'board'; readonly ref: React.RefObject<HTMLButtonElement | null> }[] = [
      { value: 'feed', ref: feedTabRef },
      { value: 'board', ref: boardTabRef },
    ]
    const current = order.findIndex(entry => entry.value === tab)
    if (current < 0) return
    let next: number
    switch (event.key) {
      case 'ArrowLeft': next = (current + order.length - 1) % order.length; break
      case 'ArrowRight': next = (current + 1) % order.length; break
      case 'Home': next = 0; break
      case 'End': next = order.length - 1; break
      default: return
    }
    event.preventDefault()
    const target = order[next]!
    setTab(target.value)
    target.ref.current?.focus()
  }
  // Unresolvable refs never become links (see TeamMessage), so only Host-confirmed refs reach here.
  const openRef = (ref: string): void => {
    if (ref.startsWith('project:')) {
      if (ref !== projectRef) selectProject(ref as AgentTeamProjectRef)
      return
    }
    if (ref.startsWith('thread:')) {
      const match = view?.items.find(item => item.thread.threadRef === ref)
      if (match !== undefined) {
        if (match.task === undefined) { setPanelThreadRef(match.thread.threadRef); return }
        selectThread(match.thread.threadRef, projectRef, match.task.taskRef, match.taskNumber)
        return
      }
      jumpToThread(resolveThreadRefs, workspaceId, ref as AgentTeamThreadRef, selectThread)
      return
    }
    if (ref.startsWith('task:')) {
      const match = view?.items.find(item => item.task?.taskRef === ref)
      if (match !== undefined) {
        selectThread(match.thread.threadRef, projectRef, match.task?.taskRef, match.taskNumber)
        return
      }
      jumpToTaskThread(resolveTaskRefs, workspaceId, ref as AgentTeamTaskRef, selectThread)
    }
  }

  const lookupTaskRefs = hostTaskRefLookup(resolveTaskRefs, workspaceId)
  const lookupThreadRefs = hostThreadRefLookup(resolveThreadRefs, workspaceId)
  // Keyed on roster content, not array identity, so memoized rows survive change bursts that leave the roster untouched.
  const rosterKey = useMemo(() => [
    (view?.projects ?? []).map(project => `${project.projectRef}=${project.name}=${project.state}`).join(','),
    members.map(status => `${status.member.memberId}=${status.member.handle}=${status.member.sessionId}=${status.availability}`).join(','),
    view?.humanMemberId ?? '',
  ].join(';'), [view, members])
  const projectNameOf = useMemo(() => {
    const projects = view?.projects ?? []
    return (ref: AgentTeamProjectRef): string | undefined => rosterProjectName(projects, ref)
  }, [rosterKey])
  const memberOf = useMemo(() => {
    const humanMemberId = view?.humanMemberId
    return (ref: AgentTeamMemberId) => rosterMember(members, humanMemberId, humanName, ref)
  }, [rosterKey, humanName])
  const taskNumberOf = useMemo(() => {
    const numbers = view?.taskNumbers ?? []
    return (taskRef: AgentTeamTaskRef): number | undefined => numbers.find(entry => entry.taskRef === taskRef)?.taskNumber
  }, [view])
  const handlePanelRead = useCallback((read: AgentTeamThreadRef): void => {
    setUnreadByThread(current => {
      if (!current.has(read)) return current
      const next = new Map(current)
      next.delete(read)
      return next
    })
  }, [])
  const handlePanelPromoted = useCallback((taskRef: AgentTeamTaskRef): void => {
    if (panelThreadRef !== undefined) selectThread(panelThreadRef, projectRef, taskRef, taskNumberOf(taskRef))
    setPanelThreadRef(undefined)
  }, [panelThreadRef, projectRef, selectThread, taskNumberOf])
  // The board is the Task's home and the Task just started is its newest card; refresh so it is there before the Human looks.
  const handleTaskStarted = (): void => {
    setTab('board')
    void refresh()
    requestAnimationFrame(() => { boardTabRef.current?.focus() })
  }
  const handlePanelClose = useCallback((): void => { setPanelThreadRef(undefined) }, [])
  const humanMemberId = view?.humanMemberId
  const humanIdentity: TeamAvatarHuman | undefined = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) }

  // The window is the feed's: walking the Project's remaining history would defeat the feed's pagination.
  const boardColumns = useMemo(() => {
    const taskful = (view?.items ?? []).filter((item): item is AgentTeamViewItem & { readonly task: AgentTeamTask } => item.task !== undefined)
    const byNumber = (left: AgentTeamViewItem, right: AgentTeamViewItem): number => (right.taskNumber ?? 0) - (left.taskNumber ?? 0)
    return BOARD_COLUMNS.map(column => ({ ...column, items: taskful.filter(item => column.match(item.task.status)).sort(byNumber) }))
  }, [view])

  const timeline = useTimelineScroll(`${view?.items.length ?? 0}:${projectLastItem?.message.messageRef ?? ''}`)

  // The surface is laid out after this effect first runs, so the seat follows its box; a dragged choice is re-clamped, never re-derived.
  useEffect(() => {
    if (panelSurface === null) return
    const seat = () => {
      if (panelSurface.offsetWidth === 0) return
      const width = resolvePanelWidth(panelSurface.offsetWidth, readPanelWidthPreference())
      panelSurface.style.setProperty('--team-panel-width', `${width}px`)
    }
    seat()
    const observer = new ResizeObserver(seat)
    observer.observe(panelSurface)
    return () => { observer.disconnect() }
  }, [panelSurface, panelThreadRef])
  const project = view?.projects.find(item => item.projectRef === projectRef)
  // Rules version 2 reads the Main stream; version 1 keeps the Project feed.
  const mainStreamActive = view !== undefined && view.rulesVersion >= 2 && project !== undefined
  const projectMemberIds = new Set(view?.members.filter(item => item.projectRef === projectRef).map(item => item.memberId) ?? [])
  const messageSender = (item: AgentTeamViewItem): AgentTeamMemberId => item.message.sender
  const handleByMember = new Map(members.map(status => [status.member.memberId, status.member.handle.replace(/^@/, '')]))

  const refresh = async (clearError = false) => {
    if (!mountedRef.current) return false
    const sequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = sequence
    if (!loadedRef.current) setLoading(true)
    if (clearError) {
      setLoadError(undefined)
      setStatusMessage(undefined)
    }
    try {
      const [loaded, loadedMembers, loadedInbox] = await Promise.all([
        loadProjects({ workspaceId, projectRef, direction: 'before', topLevelOnly: true, includeActivities: false, limit: 20 }),
        loadMembers({ workspaceId }),
        // The Host Inbox is the authority for unread; never re-derive it from message mentions.
        loadInbox({ workspaceId, limit: 100 }),
      ])
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return false
      if (loaded.ok) { setView(current => current === undefined ? loaded.value : mergeProjectView(current, loaded.value)); loadedRef.current = true } else setLoadError(loaded.error.message)
      if (loadedMembers.ok) setMembers(loadedMembers.value); else setLoadError(loadedMembers.error.message)
      if (!loadedInbox.ok) setLoadError(loadedInbox.error.message)
      setUnreadByThread(current => applyInboxRead(current, loadedInbox))
      if (loaded.ok && loadedMembers.ok && loadedInbox.ok) setLoadError(undefined)
      return loaded.ok && loadedMembers.ok && loadedInbox.ok
    } catch (cause) {
      if (mountedRef.current && sequence === refreshSequenceRef.current) setLoadError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (mountedRef.current && sequence === refreshSequenceRef.current) setLoading(false)
    }
  }

  const refreshMembers = async () => {
    if (!mountedRef.current) return
    try {
      const loaded = await loadMembers({ workspaceId })
      if (!mountedRef.current) return
      if (loaded.ok) setMembers(loaded.value); else setLoadError(loaded.error.message)
    } catch (cause) {
      if (mountedRef.current) setLoadError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    mountedRef.current = true
    loadedRef.current = false
    setView(undefined)
    setTab('feed')
    setPanelThreadRef(undefined)
    setLoadError(undefined)
    setLoading(true)
    void refresh()
    const disposers = [
      subscribeChanges({ kind: 'project', projectRef }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setLoadError(update.message); return }
        void refresh()
      }),
      subscribeChanges({ kind: 'workspace', workspaceId }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setLoadError(update.message); return }
        void refreshMembers()
      }),
      subscribeChanges({ kind: 'presence', workspaceId }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setLoadError(update.message); return }
        void refreshMembers()
      }),
    ]
    return () => {
      mountedRef.current = false
      refreshSequenceRef.current += 1
      for (const dispose of disposers) dispose()
    }
  }, [workspaceId, projectRef])

  const loadOlder = async () => {
    if (view === undefined || !view.hasMore || loadingOlder) return
    setLoadingOlder(true)
    try {
      const result = await loadProjects({ workspaceId, projectRef, direction: 'before', topLevelOnly: true, includeActivities: false, cursor: view.cursor, limit: 20 })
      if (!mountedRef.current) return
      if (!result.ok) { setError(result.error.message); return }
      setView(current => current === undefined ? result.value : mergeProjectView(current, result.value))
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setLoadingOlder(false)
    }
  }

  // Retained across transport failures so a replayed send dedupes on the Host.
  const pendingSendId = useRef<AgentTeamSendMessageRequest['requestId']>()

  // The setter returns the same state when nothing is set, so keystrokes do not re-render the timeline.
  const clearSendState = useCallback((): void => {
    setStatusMessage(current => current === undefined ? current : undefined)
  }, [])

  const send = async () => {
    // Read at send time: this page does not subscribe to the draft.
    const { draft, recipients } = drafts.getSnapshot(draftKey)
    if (pending || draft.trim() === '') return
    const recipientIds = [...recipients].sort()
    const requestId = pendingSendId.current ?? mintRequestId()
    pendingSendId.current = requestId
    setPending(true); setError(undefined); setStatusMessage(undefined)
    try {
      const upload = await uploadComposerFiles(putAttachment, workspaceId, pendingFiles)
      if (!upload.ok) {
        pendingSendId.current = undefined
        setError(upload.error)
        return
      }
      const attachmentIds = upload.attachmentIds
      const request: AgentTeamSendMessageRequest = {
        requestId, workspaceId,
        projectRef, body: draft.trim(), recipients: recipientIds,
        asTask,
        ...(attachmentIds.length === 0 ? {} : { attachments: attachmentIds }),
      }
      const result = await sendMessage(request)
      if (!result.ok) {
        pendingSendId.current = undefined
        setError(result.error.message)
      } else if (result.value.kind === 'committed') {
        pendingSendId.current = undefined
        setAsTask(false)
        await refresh()
        drafts.clear(draftKey)
        setPendingFiles([])
        setStatusMessage(undefined)
      } else if (result.value.kind === 'confirmation_required') {
        // Same-requestId resend continues the pending operation.
        setStatusMessage(t('mentionConfirmation'))
      } else {
        // Rejections are final for this draft; editing it must mint a new operation.
        pendingSendId.current = undefined
        setError(t('memberNotFollowing', { ids: result.value.memberIds.map(memberId => `@${members.find(candidate => candidate.member.memberId === memberId)?.member.handle ?? memberId}`).join(', ') }))
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }

  return <main className={css.surface} data-team-project={projectRef} ref={setPanelSurface}>
    <div className={`${css.surfaceHeader} ${css.surfaceHeaderWithTabs}`}>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <div className={projectCss.headerIdentity}>
            <h1>{project === undefined ? '# …' : `# ${project.name}`}</h1>
            {project !== undefined && project.description !== '' && <p className={projectCss.headerDescription} title={project.description}>{project.description}</p>}
          </div>
        </div>
      </header>
      <nav className={projectCss.tabs} role="tablist" aria-label={project === undefined ? '# …' : `# ${project.name}`} onKeyDown={onTabKeyDown}>
        <button ref={feedTabRef} id={`${tabIdPrefix}-feed`} type="button" role="tab" aria-selected={tab === 'feed'} aria-controls={`${tabIdPrefix}-feed-panel`} tabIndex={tab === 'feed' ? 0 : -1} className={projectCss.tab} onClick={() => { setTab('feed') }}>{t(mainStreamActive ? 'projectTabMain' : 'projectTabFeed')}</button>
        <button ref={boardTabRef} id={`${tabIdPrefix}-board`} type="button" role="tab" aria-selected={tab === 'board'} aria-controls={`${tabIdPrefix}-board-panel`} tabIndex={tab === 'board' ? 0 : -1} className={projectCss.tab} onClick={() => { setTab('board') }}>{t('projectTabBoard')}</button>
      </nav>
    </div>

    {tab === 'board' && <section id={`${tabIdPrefix}-board-panel`} role="tabpanel" aria-labelledby={`${tabIdPrefix}-board`} className={projectCss.board}>
      {view?.hasMore && <div className={css.timelineAction}><Button size="sm" disabled={loadingOlder} onClick={() => { void loadOlder() }}>{t('loadOlder')}</Button></div>}
      {boardColumns.every(column => column.items.length === 0) && <div className={css.emptySurface}><p className={css.emptyState}>{t('boardEmpty')}</p></div>}
      {boardColumns.some(column => column.items.length > 0) && <div className={projectCss.boardColumns}>
        {boardColumns.map(column => <div className={projectCss.boardColumn} key={column.labelKey}>
          <div className={projectCss.boardColumnHead}>{t(column.labelKey)}<span className={projectCss.boardColumnCount}>{column.items.length}</span></div>
          {column.items.map(item => <BoardCard
            key={item.message.messageRef}
            item={item}
            unread={unreadByThread.get(item.thread.threadRef) ?? 0}
            human={humanIdentity}
            t={t}
            onOpen={() => { selectThread(item.thread.threadRef, projectRef, item.task.taskRef, item.taskNumber) }}
          />)}
        </div>)}
      </div>}
    </section>}

    {tab === 'feed' && <div id={`${tabIdPrefix}-feed-panel`} role="tabpanel" aria-labelledby={`${tabIdPrefix}-feed`} className={projectCss.feedStage} data-panel={panelThreadRef === undefined ? 'closed' : 'open'}>
      {mainStreamActive ? <TeamMainStream
        workspaceId={workspaceId}
        projectRef={projectRef}
        humanName={humanName}
        humanAvatarUrl={humanAvatarUrl}
        humanMemberId={view.humanMemberId}
        members={members}
        projectMemberIds={projectMemberIds}
        drafts={drafts}
        mainStreamHistory={mainStreamHistory}
        readMainStream={readMainStream}
        postMainMessage={postMainMessage}
        startThread={startThread}
        putAttachment={putAttachment}
        getAttachment={getAttachment}
        subscribeChanges={subscribeChanges}
        openRef={openRef}
        onResolveTaskRefs={lookupTaskRefs}
        onResolveThreadRefs={lookupThreadRefs}
        projectNameOf={projectNameOf}
        memberOf={memberOf}
        openMemberSession={openMemberSession}
        onOpenDiscussion={setPanelThreadRef}
        onOpenTask={(threadRef, taskRef, taskNumber) => { selectThread(threadRef, projectRef, taskRef, taskNumber) }}
        onTaskStarted={handleTaskStarted}
        t={t}
      /> : <>
      <section ref={timeline.ref} onScroll={timeline.onScroll} className={css.timeline} aria-label={t('timelineLabel')}>
      <div className={css.timelineContent}>
        {loading && project === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingProjects')}</p></div>}
        {!loading && project === undefined && error === undefined && <div className={css.emptySurface}><p className={css.emptyState}>{t('emptyProjects')}</p></div>}
        {!loading && project === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void refresh(true) }}>{t('retry')}</Button></div>}
        {view?.hasMore && <div className={css.timelineAction}><Button size="sm" disabled={loadingOlder} onClick={() => { void loadOlder() }}>{t('loadOlder')}</Button></div>}
        {project !== undefined && view?.items.length === 0 && <div className={css.emptySurface}>
          <div className={css.emptyState}>
            <strong>{t('emptyMessages')}</strong>
            <span>{t('emptyMessagesHint')}</span>
          </div>
        </div>}
        {(view?.items.length ?? 0) > 0 && chunkRunsWithDays(view!.items, messageSender, item => item.message.occurredAt).map((block, blockIndex) => block.kind === 'day'
          ? <p className={threadCss.daySeparator} key={`day-${blockIndex}-${block.label}`}><span>{block.label}</span></p>
          : <div className={css.messageRun} key={`run-${block.items[0]!.message.messageRef}`}>
          {block.items.map((item, index) => {
            const senderStatus = members.find(member => member.member.memberId === item.message.sender)
            const human = item.message.sender === view!.humanMemberId
            const sender = human ? humanName : senderStatus?.member.handle ?? item.message.sender
            const turnGap = isRunGap(index > 0 ? block.items[index - 1]!.message.occurredAt : undefined, item.message.occurredAt)
            // A reply inside a Thread carries no entry state; the Thread page owns that.
            const unread = unreadByThread.get(item.thread.threadRef) ?? 0
            // A turn boundary keeps its hairline but never the instant: every row states its own time.
            return <Fragment key={item.message.messageRef}>
              {turnGap && <TeamRunDivider />}
              <TeamMessage
                senderName={sender}
                memberId={item.message.sender}
                human={human}
                readerName={humanName}
                {...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl })}
                body={item.message.body}
                attachments={item.message.attachments}
                loadAttachment={getAttachment}
                t={t}
                occurredAt={item.message.occurredAt}
                mentionNames={mentionNamesOf(item.mentions, handleByMember, humanName)}
                onOpenRef={openRef}
                onResolveTaskRefs={lookupTaskRefs}
                onResolveThreadRefs={lookupThreadRefs}
                projectNameOf={projectNameOf}
                memberOf={memberOf}
                onOpenMemberSession={openMemberSession}
                grouped={index > 0}
                showGroupedTime={item.message.topLevel === true}
                {...(senderStatus === undefined ? {} : { senderTitle: senderStatus.member.description })}
              >
                {item.message.topLevel && <ThreadEntryRow
                  item={item}
                  owners={item.liveClaimOwners}
                  unread={unread}
                  human={humanIdentity}
                  t={t}
                  onOpen={() => {
                    if (item.task === undefined) setPanelThreadRef(item.thread.threadRef)
                    else selectThread(item.thread.threadRef, projectRef, item.task.taskRef, item.taskNumber)
                  }}
                />}
              </TeamMessage>
            </Fragment>
          })}
        </div>)}
      </div>
      </section>

      {project !== undefined ? <TeamComposer
      key={draftKey}
      members={members}
      projectPeerMemberIds={projectMemberIds}
      drafts={drafts}
      draftKey={draftKey}
      pending={pending}
      {...(statusMessage === undefined ? {} : { confirmation: statusMessage })}
      {...(error === undefined ? {} : { error })}
      onEdit={clearSendState}
      onSubmit={() => { void send() }}
      pendingFiles={pendingFiles}
      onFilesChange={setPendingFiles}
      asTask={asTask}
      onAsTaskChange={setAsTask}
      t={t}
      /> : <div />}
      </>}
    </div>}

    {tab === 'feed' && panelThreadRef !== undefined && project !== undefined && <TeamProjectPanel
      surface={panelSurface}
      workspaceId={workspaceId}
      projectRef={projectRef}
      threadRef={panelThreadRef}
      projectName={project.name}
      humanName={humanName}
      {...(humanAvatarUrl === undefined ? {} : { humanAvatarUrl })}
      {...(view?.humanMemberId === undefined ? {} : { humanMemberId: view.humanMemberId })}
      members={members}
      projectMemberIds={projectMemberIds}
      drafts={drafts}
      getAttachment={getAttachment}
      putAttachment={putAttachment}
      readThread={readThread}
      loadThreadHistory={loadThreadHistory}
      threadObservations={threadObservations}
      reply={reply}
      promoteThread={promoteThread}
      subscribeChanges={subscribeChanges}
      selectThread={selectThread}
      selectProject={selectProject}
      resolveTaskRefs={resolveTaskRefs}
      resolveThreadRefs={resolveThreadRefs}
      resolveMessageRefs={resolveMessageRefs}
      openMemberSession={openMemberSession}
      projectNameOf={projectNameOf}
      memberOf={memberOf}
      taskNumberOf={taskNumberOf}
      onRead={handlePanelRead}
      onPromoted={handlePanelPromoted}
      onClose={handlePanelClose}
      allMention={!mainStreamActive}
      t={t}
    />}
  </main>
}

/** State leads the entry's line. The unread capsule is the only part a taskless discussion can carry. */
function ThreadStateCluster({ task, owners, unread, human, t }: {
  readonly task: AgentTeamTask | undefined
  readonly owners: readonly TeamAvatarOwner[]
  readonly unread: number
  readonly human: TeamAvatarHuman | undefined
  readonly t: TeamConversationProps['t']
}) {
  if (task === undefined && unread === 0) return null
  const namedOwners = namedAvatarOwners(owners, human)
  return <span className={css.stateCluster}>
    {task !== undefined && <TeamAvatarStack owners={namedOwners} label={claimersLabel(namedOwners, t)} human={human} />}
    {task !== undefined && <TeamStateDot size={8} state={taskStatusDot(task.status)} />}
    {task !== undefined && <span className={css.statusWord}>{formatTaskStatus(task.status, t)}</span>}
    {/* The capsule is decoration inside the control whose label already carries
        the count, so the number is never pixels-only — the same shared capsule
        the Inbox entry and the Inbox queue's own rows wear. */}
    <TeamCountBadge count={unread} />
  </span>
}

/**
 * The single row that opens an entry's Thread. A Task entry keeps its number so the status word stays attached;
 * the instant uses the Inbox's 今天/昨天 form, with the precise local time in the title.
 */
function ThreadEntryRow({ item, owners, unread, human, t, onOpen }: {
  readonly item: AgentTeamViewItem
  readonly owners: readonly TeamAvatarOwner[]
  readonly unread: number
  readonly human: TeamAvatarHuman | undefined
  readonly t: TeamConversationProps['t']
  readonly onOpen: () => void
}) {
  const taskNumber = item.taskNumber
  const followUp = newerActivityAt(item)
  const printedActivity = unresolvedFollowUpAt(item)
  // A resolved Task slims to a footnote; unread still counts because a resolved Thread can be answered.
  const resolved = item.task?.status === 'done' || item.task?.status === 'closed'
  const label = taskNumber !== undefined
    ? t('taskLabel', { number: taskNumber })
    : followUp === undefined ? t('replyAction') : t('threadLabel')
  const text = resolved && item.task !== undefined
    ? `${label} · ${formatTaskStatus(item.task.status, t)} · ${formatDateOnly(item.lastActivityAt)}`
    : printedActivity === undefined ? label : `${label} · ${t('recentActivity', { time: formatInboxTime(printedActivity, t) })}`
  const openLabel = taskNumber === undefined
    ? unread > 0 ? t('openThreadUnread', { count: unread }) : t('openThread')
    : unread > 0 ? t('openTaskUnread', { number: taskNumber, count: unread }) : t('openTask', { number: taskNumber })
  // Outside the button so the owner stack keeps its accessible name: a labeled button prunes its descendants from the accessibility tree.
  return <span className={css.entryLine} data-thread-entry="" data-thread-entry-door={taskNumber ?? 'thread'}>
    {resolved ? <TeamCountBadge count={unread} /> : <ThreadStateCluster task={item.task} owners={owners} unread={unread} human={human} t={t} />}
    <button
      type="button"
      className={css.entryRow}
      aria-label={openLabel}
      {...(followUp === undefined ? {} : { title: formatAbsoluteTime(followUp) })}
      onClick={onOpen}
    >
      <span>{text}</span>
      <span className={css.entryArrow} aria-hidden="true"><IconChevronRightOutlineRegular size={12} /></span>
    </button>
  </span>
}

const BOARD_COLUMNS = [
  { labelKey: 'taskStatusTodo', match: (status: AgentTeamTask['status']): boolean => status === 'todo' },
  { labelKey: 'taskStatusInProgress', match: (status: AgentTeamTask['status']): boolean => status === 'in_progress' },
  { labelKey: 'taskStatusInReview', match: (status: AgentTeamTask['status']): boolean => status === 'in_review' },
  { labelKey: 'taskStatusDone', match: (status: AgentTeamTask['status']): boolean => status === 'done' || status === 'closed' },
] as const

/** One Task on the board; resolved work dims so moving work stays loudest. */
function BoardCard({ item, unread, human, t, onOpen }: {
  readonly item: AgentTeamViewItem & { readonly task: AgentTeamTask }
  readonly unread: number
  readonly human: TeamAvatarHuman | undefined
  readonly t: TeamConversationProps['t']
  readonly onOpen: () => void
}) {
  const task = item.task
  const taskNumber = item.taskNumber ?? 0
  const resolved = task.status === 'done' || task.status === 'closed'
  // For resolved work the newest fact is the resolution itself.
  const activityAt = item.lastActivityAt
  const namedOwners = namedAvatarOwners(item.liveClaimOwners, human)
  return <button
    type="button"
    className={projectCss.boardCard}
    {...(resolved ? { 'data-resolved': '' } : {})}
    aria-label={unread > 0 ? t('openTaskUnread', { number: taskNumber, count: unread }) : t('openTask', { number: taskNumber })}
    onClick={onOpen}
  >
    <span className={projectCss.boardCardNum}>
      <TeamStateDot size={8} state={taskStatusDot(task.status)} />
      {t('taskLabel', { number: taskNumber })}
      <TeamCountBadge count={unread} />
    </span>
    <span className={projectCss.boardCardTitle}>{formatTaskTitle(item.message.body)}</span>
    <span className={projectCss.boardCardFoot}>
      {namedOwners.length === 0
        ? <span>{t('boardUnassigned')}</span>
        : <TeamAvatarStack owners={namedOwners} label={claimersLabel(namedOwners, t)} human={human} />}
      <time dateTime={activityAt} title={formatAbsoluteTime(activityAt)}>{formatInboxTime(activityAt, t)}</time>
    </span>
  </button>
}
