import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AgentTeamInboxItem, AgentTeamMainInboxItem, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, formatTaskStatus, taskStatusDot } from './team-formatters.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamCountBadge } from './TeamCountBadge.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import css from './conversation.module.css'
import inboxCss from './inbox.module.css'

interface TeamThreadInboxRow {
  readonly kind: 'thread'
  readonly workspaceId: WorkspaceId
  readonly workspaceTitle: string
  readonly item: AgentTeamInboxItem
}

/** One Project's Main stream: it has no Thread, so it opens the Project page. */
interface TeamMainInboxRow {
  readonly kind: 'main'
  readonly workspaceId: WorkspaceId
  readonly workspaceTitle: string
  readonly item: AgentTeamMainInboxItem
}

type TeamQueueRow = TeamThreadInboxRow | TeamMainInboxRow

interface TeamInboxPageProps {
  readonly useWorkspaces: TeamConversationProps['useWorkspaces']
  readonly loadInbox: TeamConversationProps['loadInbox']
  /** Wake source while the page is open: one scope-less subscription, shared with the badge poll. */
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly selectWorkspace: TeamConversationProps['selectWorkspace']
  readonly selectThread: TeamConversationProps['selectThread']
  readonly selectProject: TeamConversationProps['selectProject']
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly t: TeamConversationProps['t']
}

/** One bound across every Workspace so the 「最近活跃」 tail stays a way back into work, shorter than the queue. */
const RECENT_ROWS_LIMIT = 5

const rowKey = (row: TeamQueueRow): string => row.kind === 'thread' ? row.item.thread.threadRef : row.item.projectRef

/**
 * Queue order across Workspaces is the Host's own keys (mentions, ledger sequence, then a stable ref). The Host truncates by
 * this order, so re-apply it on merge: a row that survived the cut on mentions must not sink below a merely newer row.
 * Main stream rows rank by the same keys so they interleave with Thread rows instead of forming a block.
 */
function compareByHostInboxOrder(left: TeamQueueRow, right: TeamQueueRow): number {
  return right.item.directCount - left.item.directCount
    || right.item.newestSequence - left.item.newestSequence
    || rowKey(left).localeCompare(rowKey(right))
}

/**
 * The Human Inbox: one Inbox call per visible Workspace, merged in the Host's order into the Host's two slices: the unread
 * queue (「需要我」, Thread rows and one Main stream row per Project) and the 「最近活跃」 tail. Opening the page acknowledges
 * nothing; only a durable read advances the watermark. A Thread with unread is only in the queue (the Host excludes it from
 * the tail); this page never re-derives that.
 */
export function TeamInboxPage({ useWorkspaces, loadInbox, subscribeChanges, selectWorkspace, selectThread, selectProject, humanName, humanAvatarUrl, t }: TeamInboxPageProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [rows, setRows] = useState<readonly TeamQueueRow[]>()
  const [recentRows, setRecentRows] = useState<readonly TeamThreadInboxRow[]>([])
  // The Host names the Human's Member id on every row, so a row can draw that actor from the Client's Human identity.
  const [humanMemberId, setHumanMemberId] = useState<AgentTeamMemberId>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  // Keeping the Host's cap verdict stops a full page from reading as the whole queue; a failed read keeps the last verdict.
  const [truncated, setTruncated] = useState(false)
  const loadedRef = useRef(false)
  // Last successful slice per Workspace: a failed read must not empty this action queue for it (the sidebar badge keeps last-good too).
  const keptSlicesRef = useRef(new Map<string, { readonly items: readonly AgentTeamInboxItem[]; readonly main: readonly AgentTeamMainInboxItem[]; readonly recent: readonly AgentTeamInboxItem[] }>())

  const refresh = useCallback(async () => {
    if (!loadedRef.current) setLoading(true)
    const results = await Promise.all(workspaces.map(async workspace => {
      const result = await loadInbox({ workspaceId: workspace.workspaceId, limit: 100 })
      if (result.ok) {
        const { items, main, recent } = result.value
        keptSlicesRef.current.set(workspace.workspaceId, { items, main, recent })
        return { ok: true as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, items, main, recent, hasMore: result.value.hasMore, humanMemberId: result.value.humanMemberId }
      }
      const kept = keptSlicesRef.current.get(workspace.workspaceId)
      return { ok: false as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, items: kept?.items ?? [], main: kept?.main ?? [], recent: kept?.recent ?? [], message: result.error.message }
    }))
    const failure = results.find(result => !result.ok)
    setHumanMemberId(results.find(result => result.ok)?.humanMemberId)
    const asThreadRows = (items: readonly AgentTeamInboxItem[], workspaceId: WorkspaceId, workspaceTitle: string): TeamThreadInboxRow[] =>
      items.map(item => ({ kind: 'thread', workspaceId, workspaceTitle, item }))
    const asMainRows = (items: readonly AgentTeamMainInboxItem[], workspaceId: WorkspaceId, workspaceTitle: string): TeamMainInboxRow[] =>
      items.map(item => ({ kind: 'main', workspaceId, workspaceTitle, item }))
    setRows(results.flatMap((result): TeamQueueRow[] => [
      ...asThreadRows(result.items, result.workspaceId, result.workspaceTitle),
      ...asMainRows(result.main, result.workspaceId, result.workspaceTitle),
    ]).sort(compareByHostInboxOrder))
    // Every Workspace's slice is already capped; trim the merged tail to the one global bound.
    setRecentRows(results.flatMap(result => asThreadRows(result.recent, result.workspaceId, result.workspaceTitle))
      .sort(compareByHostInboxOrder).slice(0, RECENT_ROWS_LIMIT))
    setError(failure?.ok === false ? failure.message : undefined)
    // Only a successful read carries a verdict: a kept slice must not clear the
    // footnote it was rendered with.
    if (results.some(result => result.ok)) setTruncated(results.some(result => result.ok && result.hasMore))
    loadedRef.current = true
    setLoading(false)
  }, [loadInbox, workspaces])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => subscribeChanges(undefined, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    void refresh()
  }), [subscribeChanges, refresh])

  const open = (row: TeamQueueRow): void => {
    selectWorkspace(row.workspaceId)
    if (row.kind === 'main') selectProject(row.item.projectRef)
    else selectThread(row.item.thread.threadRef, row.item.projectRef, row.item.task?.taskRef, row.item.taskNumber)
  }

  // Shares the conversation seat's header band and reading column with Project and Thread, so switching surfaces does not shift content.
  const totalUnread = rows?.reduce((sum, row) => sum + row.item.unreadCount, 0) ?? 0
  const totalMentions = rows?.reduce((sum, row) => sum + row.item.directCount, 0) ?? 0
  const threadRowCount = rows?.filter(row => row.kind === 'thread').length ?? 0
  const mainRowCount = (rows?.length ?? 0) - threadRowCount
  // A row names its Workspace only while the rows on screen span more than one; a constant segment wastes the row's most readable position.
  const shownWorkspaces = new Set<string>()
  for (const row of rows ?? []) shownWorkspaces.add(row.workspaceTitle)
  for (const row of recentRows) shownWorkspaces.add(row.workspaceTitle)
  const showWorkspace = shownWorkspaces.size > 1
  // Either half missing leaves the stack on its initials fallback.
  const human = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) } satisfies TeamAvatarHuman
  const renderRow = (row: TeamQueueRow) => row.kind === 'main'
    ? <InboxMainRow key={`${row.workspaceId} ${rowKey(row)}`} row={row} t={t} showWorkspace={showWorkspace} human={human} onOpen={() => { open(row) }} />
    : <InboxQueueRow key={`${row.workspaceId} ${rowKey(row)}`} row={row} t={t} showWorkspace={showWorkspace} human={human} onOpen={() => { open(row) }} />
  return <main className={css.surface} data-team-inbox>
    <div className={css.surfaceHeader}>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <h1>{t('inboxTitle')}</h1>
          {rows !== undefined && rows.length > 0 && <p className={inboxCss.headerMeta}>
            {threadRowCount > 0 && <span>{t('inboxHeaderThreads', { count: threadRowCount })}</span>}
            {mainRowCount > 0 && <span>{t('inboxHeaderMain', { count: mainRowCount })}</span>}
            <span className={inboxCss.headerUnread}>{t('inboxHeaderUnread', { count: totalUnread })}</span>
            {totalMentions > 0 && <span>{t('inboxHeaderMentions', { count: totalMentions })}</span>}
          </p>}
        </div>
      </header>
    </div>
    <div className={css.timeline}>
      <div className={css.timelineContent}>
        {loading && rows === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingInbox')}</p></div>}
        {!loading && rows === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void refresh() }}>{t('retry')}</Button></div>}
        {rows !== undefined && (rows.length === 0 && recentRows.length === 0
          ? <div className={css.emptySurface}>
              <div className={css.emptyState}>
                <strong>{t('inboxEmptyTitle')}</strong>
                <span>{t('inboxEmptyHint')}</span>
              </div>
            </div>
          : <>
              {rows.length > 0 && <section className={inboxCss.section}>
                <h2 className={inboxCss.sectionTitle}>{t('inboxSectionNeedsMe')}<span className={inboxCss.sectionCount}>{rows.length}</span></h2>
                <div className={inboxCss.list}>
                  {rows.map(renderRow)}
                </div>
                {/* A capped queue says so where the list ends. */}
                {truncated && <p className={inboxCss.queueMore} role="status">{t('inboxQueueMore')}</p>}
              </section>}
              {recentRows.length > 0 && <section className={inboxCss.section}>
                <h2 className={inboxCss.sectionTitle}>{t('inboxSectionRecent')}<span className={inboxCss.sectionCount}>{recentRows.length}</span></h2>
                <div className={inboxCss.list}>
                  {recentRows.map(renderRow)}
                </div>
              </section>}
            </>)}
        {rows !== undefined && error !== undefined && <p className={css.error} role="alert">{error}</p>}
      </div>
    </div>
  </main>
}

/**
 * The shared two-line queue row shape: a leading actor cluster, then identity, count and instant, then the gist. The count
 * closes the identity line and only its ink changes: a solid capsule when the row names the reader (a mention, or a reply to
 * them), a hairline otherwise. Unread and mention counts reach assistive tech through the capsule's own name, so no second
 * visible count competes.
 */
function InboxRowShell({ actor, crumb, unreadCount, directCount, newestOccurredAt, preview, t, onOpen }: {
  readonly actor: ReactNode
  readonly crumb: ReactNode
  readonly unreadCount: number
  readonly directCount: number
  readonly newestOccurredAt: string
  readonly preview: string | undefined
  readonly t: TeamConversationProps['t']
  readonly onOpen: () => void
}) {
  const named = directCount > 0
  const countLabel = named
    ? t('inboxRowUnreadMentions', { count: unreadCount, mentions: directCount })
    : t('inboxRowUnread', { count: unreadCount })
  return <button type="button" className={inboxCss.row} data-named={named || undefined} onClick={onOpen}>
    <span className={inboxCss.rowActor}>{actor}</span>
    <span className={inboxCss.rowLine}>
      <span className={inboxCss.rowCrumb}>{crumb}</span>
      {/* A 「最近活跃」 row holds no unread, so it renders no capsule: zero is the absence of a badge. */}
      <TeamCountBadge count={unreadCount} tone={named ? 'solid' : 'hairline'} label={countLabel} />
      <time className={inboxCss.rowTime} dateTime={newestOccurredAt} title={formatAbsoluteTime(newestOccurredAt)}>{formatInboxTime(newestOccurredAt, t)}</time>
    </span>
    <span className={inboxCss.rowPreview}>{preview}</span>
  </button>
}

/** A Workspace prefix leads the crumb only while the page spans more than one Workspace. */
function WorkspacePrefix({ title, show }: { readonly title: string; readonly show: boolean }) {
  return show ? <><span className={inboxCss.rowWorkspace}>{title}</span>{' / '}</> : null
}

/**
 * One Thread row. The gutter leads with who is on the work (or who moved an unclaimed Thread), the Thread entry grammar.
 */
function InboxQueueRow({ row, t, showWorkspace, human, onOpen }: {
  readonly row: TeamThreadInboxRow
  readonly t: TeamConversationProps['t']
  readonly showWorkspace: boolean
  readonly human: TeamAvatarHuman | undefined
  readonly onOpen: () => void
}) {
  const { item } = row
  const owners = item.liveClaimOwners
  // Names come from the Human identity so the chip's letter and the label move together on a rename.
  const namedOwners = namedAvatarOwners(owners, human)
  const namedActor = namedAvatarOwners([item.newestActor], human)[0]!
  return <InboxRowShell
    // A Task's live owners show when there are any, else the person the newest fact came from; this is the Thread's own fact,
    // so it keeps its shape between the queue and the 「最近活跃」 tail. The avatars are presentational: the stack's label joins
    // the control's accessible name.
    actor={owners.length > 0
      ? <TeamAvatarStack owners={namedOwners} label={claimersLabel(namedOwners, t)} human={human} />
      : <TeamAvatarStack owners={[namedActor]} label={t('inboxRowActor', { name: `@${namedActor.name}` })} human={human} />}
    crumb={<>
      <WorkspacePrefix title={row.workspaceTitle} show={showWorkspace} />
      <span className={inboxCss.rowProject}>#{item.projectName}</span>
      {' '}
      {item.taskNumber !== undefined && <span className={inboxCss.rowTask}>{t('taskLabel', { number: item.taskNumber })}</span>}
      {/* The state dot and word, as in the Thread header. A discussion draws nothing; it rides the clamped provenance run so a
          squeezed seat shortens it with the Project name. */}
      {item.task !== undefined && <>
        {' '}
        <span className={inboxCss.rowTaskState} data-team-task-state={item.task.status}>
          <TeamStateDot size={8} state={taskStatusDot(item.task.status)} />
          {formatTaskStatus(item.task.status, t)}
        </span>
      </>}
    </>}
    unreadCount={item.unreadCount}
    directCount={item.directCount}
    newestOccurredAt={item.newestOccurredAt}
    preview={item.previewText}
    t={t}
    onOpen={onOpen}
  />
}

/** One Project's Main stream: the Project name then 「主对话」, led by the person who wrote the newest message. */
function InboxMainRow({ row, t, showWorkspace, human, onOpen }: {
  readonly row: TeamMainInboxRow
  readonly t: TeamConversationProps['t']
  readonly showWorkspace: boolean
  readonly human: TeamAvatarHuman | undefined
  readonly onOpen: () => void
}) {
  const { item } = row
  const namedActor = namedAvatarOwners([item.newestActor], human)[0]!
  return <InboxRowShell
    actor={<TeamAvatarStack owners={[namedActor]} label={t('inboxRowActor', { name: `@${namedActor.name}` })} human={human} />}
    crumb={<>
      <WorkspacePrefix title={row.workspaceTitle} show={showWorkspace} />
      <span className={inboxCss.rowProject}>#{item.projectName}</span>
      {' · '}
      <span>{t('inboxMainLabel')}</span>
    </>}
    unreadCount={item.unreadCount}
    directCount={item.directCount}
    newestOccurredAt={item.newestOccurredAt}
    preview={item.previewText}
    t={t}
    onOpen={onOpen}
  />
}
