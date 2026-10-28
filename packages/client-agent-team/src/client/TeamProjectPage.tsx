import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamProjectRef, AgentTeamInbox, AgentTeamMemberId, AgentTeamTask, AgentTeamView,
  AgentTeamTaskRef, AgentTeamThreadRef, AgentTeamTaskBoard, AgentTeamTaskBoardItem,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDiscussionAnchor } from './navigation.ts'
import type { TeamDraftStore } from './drafts.ts'
import { TeamMainStream } from './TeamMainStream.tsx'
import { TeamProjectPanel } from './TeamProjectPanel.tsx'
import { resolvePanelWidth, readPanelWidthPreference } from './panel-width.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamCountBadge } from './TeamCountBadge.tsx'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, taskStatusDot } from './team-formatters.ts'
import { TeamStateDot } from './TeamStateDot.tsx'
import { hostTaskRefLookup, jumpToTaskThread } from './refs.ts'
import { hostThreadRefLookup, jumpToThread, resolvedThreadDestination } from './refs.ts'
import { rosterProjectName, rosterMember } from './refs.ts'
import projectCss from './project.module.css'
import css from './conversation.module.css'

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
  readonly loadTaskBoard: TeamConversationProps['loadTaskBoard']
  readonly drafts: TeamDraftStore
  readonly getAttachment: TeamConversationProps['getAttachment']
  readonly putAttachment: TeamConversationProps['putAttachment']
  readonly postMainMessage: TeamConversationProps['postMainMessage']
  readonly startThread: TeamConversationProps['startThread']
  readonly readMainStream: TeamConversationProps['readMainStream']
  readonly mainStreamHistory: TeamConversationProps['mainStreamHistory']
  readonly readThread: TeamConversationProps['readThread']
  readonly loadThreadHistory: TeamConversationProps['loadThreadHistory']
  readonly threadObservations: TeamConversationProps['threadObservations']
  readonly reply: TeamConversationProps['reply']
  readonly promoteThread: TeamConversationProps['promoteThread']
  readonly changeAttention: TeamConversationProps['changeAttention']
  readonly selectThread: TeamConversationProps['selectThread']
  readonly selectDiscussion: TeamConversationProps['selectDiscussion']
  readonly closeDiscussion: TeamConversationProps['closeDiscussion']
  readonly selectProject: TeamConversationProps['selectProject']
  /** The open discussion panel, from the persisted navigation fact; a reload reopens the same panel. */
  readonly discussionRef?: AgentTeamThreadRef | undefined
  /** Why that panel was opened, so an Inbox entry lands on its first unread Message naming the Human. */
  readonly discussionAnchor?: TeamDiscussionAnchor | undefined
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

/** Zero unread is the absence of a badge. A failed read keeps the previous counts rather than rendering as "everything was consumed". */
function applyInboxRead(
  previous: ReadonlyMap<AgentTeamThreadRef, number>,
  result: RemoteResult<AgentTeamInbox>,
): ReadonlyMap<AgentTeamThreadRef, number> {
  if (!result.ok) return previous
  return new Map(result.value.items.filter(item => item.unreadCount > 0).map(item => [item.thread.threadRef, item.unreadCount]))
}

export function TeamProjectPage({ workspaceId, projectRef, humanName, humanAvatarUrl, loadProjects, loadTaskBoard, subscribeChanges, loadMembers, loadInbox, drafts, putAttachment, getAttachment, postMainMessage, startThread, readMainStream, mainStreamHistory, readThread, loadThreadHistory, threadObservations, reply, promoteThread, changeAttention, selectThread, selectDiscussion, closeDiscussion, selectProject, discussionRef, discussionAnchor, resolveTaskRefs, resolveThreadRefs, resolveMessageRefs, openMemberSession, t }: TeamProjectPageProps) {
  const [view, setView] = useState<AgentTeamView>()
  const [taskBoard, setTaskBoard] = useState<AgentTeamTaskBoard>()
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [unreadByThread, setUnreadByThread] = useState<ReadonlyMap<AgentTeamThreadRef, number>>(new Map())
  const [loadError, setLoadError] = useState<string>()
  const [loading, setLoading] = useState(true)
  // The finished column starts at the Host's default page and grows on demand: the
  // reader asked to see older resolved work, so ask the Host for a deeper slice.
  // The mirror ref is what `refresh` reads, because the change subscription holds
  // the closure from the first render and a state read there would collapse an
  // expanded column back to the default page on the next change event.
  const [finishedLimit, setFinishedLimit] = useState(FINISHED_PAGE)
  const finishedLimitRef = useRef(FINISHED_PAGE)
  const [expandingFinished, setExpandingFinished] = useState(false)
  const [tab, setTab] = useState<'main' | 'board'>('main')
  // The surface owns the panel-width variable; a drag writes it there so this page never re-renders.
  const [panelSurface, setPanelSurface] = useState<HTMLElement | null>(null)
  const mountedRef = useRef(false)
  // True after the first load; later refreshes keep the rendered timeline.
  const loadedRef = useRef(false)
  const refreshSequenceRef = useRef(0)
  const tabIdPrefix = useId()
  const mainTabRef = useRef<HTMLButtonElement>(null)
  const boardTabRef = useRef<HTMLButtonElement>(null)
  // Enter and Space need no branch: the button's own activation fires click.
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    const order: readonly { readonly value: 'main' | 'board'; readonly ref: React.RefObject<HTMLButtonElement | null> }[] = [
      { value: 'main', ref: mainTabRef },
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
  // One destination rule for every `thread:` ref: a loaded row names its own Task, and a ref outside the window resolves
  // through the Host. The resolved ref carries the Project it lives in, so a cross-Project discussion opens beside that
  // Project's feed instead of this page's.
  const openThreadRef = resolvedThreadDestination(selectThread, selectDiscussion)
  // Unresolvable refs never become links (see TeamMessage), so only Host-confirmed refs reach here.
  const openRef = (ref: string): void => {
    if (ref.startsWith('project:')) {
      if (ref !== projectRef) selectProject(ref as AgentTeamProjectRef)
      return
    }
    if (ref.startsWith('thread:')) {
      const match = view?.items.find(item => item.thread.threadRef === ref)
      if (match !== undefined) {
        openThreadRef(match.task === undefined
          // The row came from this Project's feed, so its own Project is the page's.
          ? { threadRef: match.thread.threadRef, projectRef }
          : { threadRef: match.thread.threadRef, projectRef, taskRef: match.task.taskRef, ...(match.taskNumber === undefined ? {} : { taskNumber: match.taskNumber }) })
        return
      }
      jumpToThread(resolveThreadRefs, workspaceId, ref as AgentTeamThreadRef, openThreadRef)
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
  // Promotion has no panel to restore: the discussion became the Task, so `selectThread` must drop the panel state
  // explicitly instead of treating this as a same-Project Task cover.
  const handlePanelPromoted = useCallback((taskRef: AgentTeamTaskRef): void => {
    if (discussionRef !== undefined) selectThread(discussionRef, projectRef, taskRef, taskNumberOf(taskRef), { preserveDiscussion: false })
  }, [discussionRef, projectRef, selectThread, taskNumberOf])
  // The board is the Task's home and the Task just started is its newest card; refresh so it is there before the Human looks.
  const handleTaskStarted = (): void => {
    setTab('board')
    void refresh()
    requestAnimationFrame(() => { boardTabRef.current?.focus() })
  }
  const handlePanelClose = useCallback((): void => { closeDiscussion() }, [closeDiscussion])
  // The Host caps the finished column per Project; expanding asks for the whole set once,
  // so the deeper slice is fetched on the click rather than on every board refresh.
  const expandFinished = async (): Promise<void> => {
    if (expandingFinished) return
    setExpandingFinished(true)
    try {
      const result = await loadTaskBoard({ workspaceId, projectRef, finishedLimit: EXPANDED_FINISHED_LIMIT })
      if (!mountedRef.current) return
      if (!result.ok) { setLoadError(result.error.message); return }
      finishedLimitRef.current = EXPANDED_FINISHED_LIMIT
      setFinishedLimit(EXPANDED_FINISHED_LIMIT)
      setTaskBoard(result.value)
    } catch (cause) {
      if (mountedRef.current) setLoadError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setExpandingFinished(false)
    }
  }
  const humanMemberId = view?.humanMemberId
  const humanIdentity: TeamAvatarHuman | undefined = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) }

  // Every board row comes from the same Host projection the Agent tool reads.
  const boardColumns = useMemo(() => {
    const items = [...taskBoard?.open ?? [], ...taskBoard?.finished ?? []]
    return BOARD_COLUMNS.map(column => ({ ...column, items: items.filter(item => column.match(item.task.status)) }))
  }, [taskBoard])

  // Only the Host knows whether a full page was a cut or the end of the history,
  // so the expand control reads its truncation signal rather than counting rows.
  // At the deepest page the Host accepts there is nothing left to ask for, and
  // the control retires even while older resolved work still exists.
  const finishedHasMore = taskBoard?.finishedTruncated === true && finishedLimit < EXPANDED_FINISHED_LIMIT

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
  }, [panelSurface, discussionRef])
  const project = view?.projects.find(item => item.projectRef === projectRef)
  const projectMemberIds = new Set(view?.members.filter(item => item.projectRef === projectRef).map(item => item.memberId) ?? [])

  const refresh = async (clearError = false) => {
    if (!mountedRef.current) return false
    const sequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = sequence
    if (!loadedRef.current) setLoading(true)
    if (clearError) setLoadError(undefined)
    try {
      const [loaded, loadedTaskBoard, loadedMembers, loadedInbox] = await Promise.all([
        loadProjects({ workspaceId, projectRef, direction: 'before', topLevelOnly: true, includeActivities: false, limit: 20 }),
        loadTaskBoard({ workspaceId, projectRef, finishedLimit: finishedLimitRef.current }),
        loadMembers({ workspaceId }),
        // The Host Inbox is the authority for unread; never re-derive it from message mentions.
        loadInbox({ workspaceId, limit: 100 }),
      ])
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return false
      if (loaded.ok) { setView(current => current === undefined ? loaded.value : mergeProjectView(current, loaded.value)); loadedRef.current = true } else setLoadError(loaded.error.message)
      if (loadedTaskBoard.ok) setTaskBoard(loadedTaskBoard.value); else setLoadError(loadedTaskBoard.error.message)
      if (loadedMembers.ok) setMembers(loadedMembers.value); else setLoadError(loadedMembers.error.message)
      if (!loadedInbox.ok) setLoadError(loadedInbox.error.message)
      setUnreadByThread(current => applyInboxRead(current, loadedInbox))
      if (loaded.ok && loadedTaskBoard.ok && loadedMembers.ok && loadedInbox.ok) setLoadError(undefined)
      return loaded.ok && loadedTaskBoard.ok && loadedMembers.ok && loadedInbox.ok
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
    finishedLimitRef.current = FINISHED_PAGE
    setFinishedLimit(FINISHED_PAGE)
    setView(undefined)
    setTab('main')
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
        <button ref={mainTabRef} id={`${tabIdPrefix}-main`} type="button" role="tab" aria-selected={tab === 'main'} aria-controls={`${tabIdPrefix}-main-panel`} tabIndex={tab === 'main' ? 0 : -1} className={projectCss.tab} onClick={() => { setTab('main') }}>{t('projectTabMain')}</button>
        <button ref={boardTabRef} id={`${tabIdPrefix}-board`} type="button" role="tab" aria-selected={tab === 'board'} aria-controls={`${tabIdPrefix}-board-panel`} tabIndex={tab === 'board' ? 0 : -1} className={projectCss.tab} onClick={() => { setTab('board') }}>{t('projectTabBoard')}</button>
      </nav>
    </div>

    {tab === 'board' && <section id={`${tabIdPrefix}-board-panel`} role="tabpanel" aria-labelledby={`${tabIdPrefix}-board`} className={projectCss.board}>
      {loadError !== undefined && <p className={css.error} role="alert">{loadError}</p>}
      {loadError === undefined && taskBoard === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('boardLoading')}</p></div>}
      {loadError === undefined && taskBoard !== undefined && boardColumns.every(column => column.items.length === 0) && <div className={css.emptySurface}><p className={css.emptyState}>{t('boardEmpty')}</p></div>}
      {boardColumns.some(column => column.items.length > 0) && <div className={projectCss.boardColumns}>
        {boardColumns.map(column => <div className={projectCss.boardColumn} key={column.labelKey}>
          <div className={projectCss.boardColumnHead}>{t(column.labelKey)}<span className={projectCss.boardColumnCount}>{column.items.length}</span></div>
          {column.labelKey === 'taskStatusDone' && finishedHasMore
            && <div className={projectCss.boardColumnExpand}><Button size="sm" variant="outline" disabled={expandingFinished} onClick={() => { void expandFinished() }}>{t('boardShowAllFinished')}</Button></div>}
          {column.items.map(item => <ProjectionBoardCard
            key={item.task.taskRef}
            item={item}
            unread={unreadByThread.get(item.threadRef) ?? 0}
            human={humanIdentity}
            humanMemberId={humanMemberId}
            t={t}
            onOpen={() => { selectThread(item.threadRef, projectRef, item.task.taskRef, item.taskNumber) }}
          />)}
        </div>)}
      </div>}
    </section>}

    {tab === 'main' && <div id={`${tabIdPrefix}-main-panel`} role="tabpanel" aria-labelledby={`${tabIdPrefix}-main`} className={projectCss.feedStage} data-panel={discussionRef === undefined ? 'closed' : 'open'}>
      {project !== undefined && view !== undefined ? <TeamMainStream
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
        onOpenDiscussion={threadRef => { selectDiscussion(threadRef, projectRef) }}
        onOpenTask={(threadRef, taskRef, taskNumber) => { selectThread(threadRef, projectRef, taskRef, taskNumber) }}
        onTaskStarted={handleTaskStarted}
        t={t}
      /> : <section className={css.timeline} aria-label={t('timelineLabel')}>
        <div className={css.timelineContent}>
          {loading && loadError === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingProjects')}</p></div>}
          {!loading && loadError === undefined && <div className={css.emptySurface}><p className={css.emptyState}>{t('emptyProjects')}</p></div>}
          {!loading && loadError !== undefined && <div className={css.errorState} role="alert"><span>{loadError}</span><Button size="sm" variant="outline" onClick={() => { void refresh(true) }}>{t('retry')}</Button></div>}
        </div>
      </section>}
    </div>}

    {tab === 'main' && discussionRef !== undefined && project !== undefined && <TeamProjectPanel
      key={discussionAnchor ?? ''}
      surface={panelSurface}
      workspaceId={workspaceId}
      projectRef={projectRef}
      threadRef={discussionRef}
      {...(discussionAnchor === undefined ? {} : { anchor: discussionAnchor })}
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
      changeAttention={changeAttention}
      subscribeChanges={subscribeChanges}
      selectThread={selectThread}
      selectDiscussion={selectDiscussion}
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
      t={t}
    />}
  </main>
}

const BOARD_COLUMNS = [
  { labelKey: 'taskStatusTodo', match: (status: AgentTeamTask['status']): boolean => status === 'todo' },
  { labelKey: 'taskStatusInProgress', match: (status: AgentTeamTask['status']): boolean => status === 'in_progress' },
  { labelKey: 'taskStatusInReview', match: (status: AgentTeamTask['status']): boolean => status === 'in_review' },
  { labelKey: 'taskStatusDone', match: (status: AgentTeamTask['status']): boolean => status === 'done' || status === 'closed' },
] as const

/** The finished column's first page, matching the Host's per-Project default so the two agree before any expansion. */
const FINISHED_PAGE = 5

/** The finished column's expanded page: the Host caps a request at 100, which covers a Project's history in practice. */
const EXPANDED_FINISHED_LIMIT = 100

/** One Task on the board; resolved work dims so moving work stays loudest. */
function ProjectionBoardCard({ item, unread, human, humanMemberId, t, onOpen }: {
  readonly item: AgentTeamTaskBoardItem
  readonly unread: number
  readonly human: TeamAvatarHuman | undefined
  readonly humanMemberId: AgentTeamMemberId | undefined
  readonly t: TeamConversationProps['t']
  readonly onOpen: () => void
}) {
  const task = item.task
  const taskNumber = item.taskNumber ?? 0
  const resolved = task.status === 'done' || task.status === 'closed'
  const ownerLabel = item.accountableOwner?.state === 'suspended'
    ? t('boardAccountableSuspended')
    : task.accountable === humanMemberId ? t('boardAccountableYou') : t('boardAccountable', { name: item.accountableOwner?.name ?? task.accountable })
  // For resolved work the newest fact is the resolution itself.
  const activityAt = item.lastActivityAt
  const namedOwners = namedAvatarOwners(item.liveClaimOwners, human)
  return <button
    type="button"
    className={projectCss.boardCard}
    {...(resolved ? { 'data-resolved': '' } : {})}
    aria-label={`${unread > 0 ? t('openTaskUnread', { number: taskNumber, count: unread }) : t('openTask', { number: taskNumber })}${item.needsAcceptance ? ` · ${t('boardNeedsAcceptance')}` : ''}`}
    onClick={onOpen}
  >
    <span className={projectCss.boardCardNum}>
      <TeamStateDot size={8} state={taskStatusDot(task.status)} />
      {t('taskLabel', { number: taskNumber })}
      {item.needsAcceptance && <span className={projectCss.boardAcceptBadge}>{t('boardNeedsAcceptance')}</span>}
      <TeamCountBadge count={unread} />
    </span>
    <span className={projectCss.boardCardTitle}>{item.subject}</span>
    <span className={projectCss.boardCardFoot}>
      <span className={projectCss.boardCardOwner}>{ownerLabel}</span>
      {namedOwners.length === 0
        ? <span>{t('boardUnassigned')}</span>
        : <TeamAvatarStack owners={namedOwners} label={claimersLabel(namedOwners, t)} human={human} />}
      <time dateTime={activityAt} title={formatAbsoluteTime(activityAt)}>{formatInboxTime(activityAt, t)}</time>
    </span>
  </button>
}
