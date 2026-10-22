import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentTeamInboxItem, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, formatTaskStatus, taskStatusDot } from './team-formatters.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamCountBadge } from './TeamCountBadge.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import css from './conversation.module.css'
import inboxCss from './inbox.module.css'

interface TeamInboxRow {
  readonly workspaceId: WorkspaceId
  readonly workspaceTitle: string
  readonly item: AgentTeamInboxItem
}

interface TeamInboxPageProps {
  readonly useWorkspaces: TeamConversationProps['useWorkspaces']
  readonly loadInbox: TeamConversationProps['loadInbox']
  /** Wake source while the page is open: one scope-less subscription, shared with the badge poll. */
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly selectWorkspace: TeamConversationProps['selectWorkspace']
  readonly selectThread: TeamConversationProps['selectThread']
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly t: TeamConversationProps['t']
}

/** One bound across every Workspace so the 「最近活跃」 tail stays a way back into work, shorter than the queue. */
const RECENT_ROWS_LIMIT = 5

/**
 * Queue order across Workspaces is the Host's own keys (mentions, ledger sequence, Thread ref). The Host truncates by
 * this order, so re-apply it on merge: a row that survived the cut on mentions must not sink below a merely newer row.
 */
function compareByHostInboxOrder(left: TeamInboxRow, right: TeamInboxRow): number {
  return right.item.directCount - left.item.directCount
    || right.item.newestSequence - left.item.newestSequence
    || left.item.thread.threadRef.localeCompare(right.item.thread.threadRef)
}

/**
 * The Human Inbox: one Inbox call per visible Workspace, merged in the Host's order into the Host's two slices: the unread
 * queue (「需要我」) and the 「最近活跃」 tail. Opening the page acknowledges nothing; only a durable Thread read advances the
 * watermark. A Thread with unread is only in the queue (the Host excludes it from the tail); this page never re-derives that.
 */
export function TeamInboxPage({ useWorkspaces, loadInbox, subscribeChanges, selectWorkspace, selectThread, humanName, humanAvatarUrl, t }: TeamInboxPageProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [rows, setRows] = useState<readonly TeamInboxRow[]>()
  const [recentRows, setRecentRows] = useState<readonly TeamInboxRow[]>([])
  // The Host names the Human's Member id on every row, so a row can draw that actor from the Client's Human identity.
  const [humanMemberId, setHumanMemberId] = useState<AgentTeamMemberId>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  // Keeping the Host's cap verdict stops a full page from reading as the whole queue; a failed read keeps the last verdict.
  const [truncated, setTruncated] = useState(false)
  const loadedRef = useRef(false)
  // Last successful slice per Workspace: a failed read must not empty this action queue for it (the sidebar badge keeps last-good too).
  const keptSlicesRef = useRef(new Map<string, { readonly items: readonly AgentTeamInboxItem[]; readonly recent: readonly AgentTeamInboxItem[] }>())

  const refresh = useCallback(async () => {
    if (!loadedRef.current) setLoading(true)
    const results = await Promise.all(workspaces.map(async workspace => {
      const result = await loadInbox({ workspaceId: workspace.workspaceId, limit: 100 })
      if (result.ok) {
        keptSlicesRef.current.set(workspace.workspaceId, { items: result.value.items, recent: result.value.recent })
        return { ok: true as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, items: result.value.items, recent: result.value.recent, hasMore: result.value.hasMore, humanMemberId: result.value.humanMemberId }
      }
      const kept = keptSlicesRef.current.get(workspace.workspaceId)
      return { ok: false as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, items: kept?.items ?? [], recent: kept?.recent ?? [], message: result.error.message }
    }))
    const failure = results.find(result => !result.ok)
    setHumanMemberId(results.find(result => result.ok)?.humanMemberId)
    const asRows = (items: readonly AgentTeamInboxItem[], workspaceId: WorkspaceId, workspaceTitle: string): TeamInboxRow[] =>
      items.map(item => ({ workspaceId, workspaceTitle, item }))
    setRows(results.flatMap(result => asRows(result.items, result.workspaceId, result.workspaceTitle)).sort(compareByHostInboxOrder))
    // Every Workspace's slice is already capped; trim the merged tail to the one global bound.
    setRecentRows(results.flatMap(result => asRows(result.recent, result.workspaceId, result.workspaceTitle))
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

  const open = (row: TeamInboxRow): void => {
    selectWorkspace(row.workspaceId)
    selectThread(row.item.thread.threadRef, row.item.channelRef, row.item.task?.taskRef, row.item.taskNumber)
  }

  // Shares the conversation seat's header band and reading column with Channel and Thread, so switching surfaces does not shift content.
  const totalUnread = rows?.reduce((sum, row) => sum + row.item.unreadCount, 0) ?? 0
  const totalMentions = rows?.reduce((sum, row) => sum + row.item.directCount, 0) ?? 0
  // A row names its Workspace only while the rows on screen span more than one; a constant segment wastes the row's most readable position.
  const shownWorkspaces = new Set<string>()
  for (const row of rows ?? []) shownWorkspaces.add(row.workspaceTitle)
  for (const row of recentRows) shownWorkspaces.add(row.workspaceTitle)
  const showWorkspace = shownWorkspaces.size > 1
  // Either half missing leaves the stack on its initials fallback.
  const human = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) } satisfies TeamAvatarHuman
  return <main className={css.surface} data-team-inbox>
    <div className={css.surfaceHeader}>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <h1>{t('inboxTitle')}</h1>
          {rows !== undefined && rows.length > 0 && <p className={inboxCss.headerMeta}>
            <span>{t('inboxHeaderThreads', { count: rows.length })}</span>
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
                  {rows.map(row => <InboxQueueRow key={`${row.workspaceId} ${row.item.thread.threadRef}`} row={row} t={t} showWorkspace={showWorkspace} human={human} onOpen={() => { open(row) }} />)}
                </div>
                {/* A capped queue says so where the list ends. */}
                {truncated && <p className={inboxCss.queueMore} role="status">{t('inboxQueueMore')}</p>}
              </section>}
              {recentRows.length > 0 && <section className={inboxCss.section}>
                <h2 className={inboxCss.sectionTitle}>{t('inboxSectionRecent')}<span className={inboxCss.sectionCount}>{recentRows.length}</span></h2>
                <div className={inboxCss.list}>
                  {recentRows.map(row => <InboxQueueRow key={`${row.workspaceId} ${row.item.thread.threadRef}`} row={row} t={t} showWorkspace={showWorkspace} human={human} onOpen={() => { open(row) }} />)}
                </div>
              </section>}
            </>)}
        {rows !== undefined && error !== undefined && <p className={css.error} role="alert">{error}</p>}
      </div>
    </div>
  </main>
}

/**
 * One queue row, shaped like the shipped two-line result row. The gutter leads with who is on the work (or who moved an
 * unclaimed Thread), the Channel feed's Thread entry grammar. The count closes the identity line and only its ink changes:
 * capsule fill when the row names the reader, a hairline otherwise. Unread and mention counts reach assistive tech through
 * the capsule's own name, so no second visible count competes.
 */
function InboxQueueRow({ row, t, showWorkspace, human, onOpen }: {
  readonly row: TeamInboxRow
  readonly t: TeamConversationProps['t']
  readonly showWorkspace: boolean
  readonly human: TeamAvatarHuman | undefined
  readonly onOpen: () => void
}) {
  const { item } = row
  const actor = item.newestActor
  const owners = item.liveClaimOwners
  // Names come from the Human identity so the chip's letter and the label move together on a rename.
  const namedOwners = namedAvatarOwners(owners, human)
  const namedActor = namedAvatarOwners([actor], human)[0]!
  const named = item.directCount > 0
  const countLabel = named
    ? t('inboxRowUnreadMentions', { count: item.unreadCount, mentions: item.directCount })
    : t('inboxRowUnread', { count: item.unreadCount })
  return <button type="button" className={inboxCss.row} data-named={named || undefined} onClick={onOpen}>
    {/* The cluster leads every row so none opens on empty space. A Task's live owners show when there are any, else the person the
        newest fact came from; this is the Thread's own fact, so it keeps its shape between the queue and the 「最近活跃」 tail.
        The avatars are presentational: the stack's label joins the control's accessible name. */}
    <span className={inboxCss.rowActor}>
      {owners.length > 0
        ? <TeamAvatarStack owners={namedOwners} label={claimersLabel(namedOwners, t)} human={human} />
        : <TeamAvatarStack owners={[namedActor]} label={t('inboxRowActor', { name: `@${namedActor.name}` })} human={human} />}
    </span>
    <span className={inboxCss.rowLine}>
      <span className={inboxCss.rowCrumb}>
        {showWorkspace && <span className={inboxCss.rowWorkspace}>{row.workspaceTitle}</span>}
        {showWorkspace && ' / '}
        <span className={inboxCss.rowChannel}>#{item.channelName}</span>
        {' '}
        {item.taskNumber !== undefined && <span className={inboxCss.rowTask}>{t('taskLabel', { number: item.taskNumber })}</span>}
        {/* The state dot and word, as in the Channel feed and the Thread header. A discussion draws nothing; it rides the clamped
            provenance run so a squeezed seat shortens it with the Channel name. */}
        {item.task !== undefined && <>
          {' '}
          <span className={inboxCss.rowTaskState} data-team-task-state={item.task.status}>
            <TeamStateDot size={8} state={taskStatusDot(item.task.status)} />
            {formatTaskStatus(item.task.status, t)}
          </span>
        </>}
      </span>
      {/* A 「最近活跃」 row holds no unread, so it renders no capsule: zero is the absence of a badge. */}
      <TeamCountBadge count={item.unreadCount} tone={named ? 'solid' : 'hairline'} label={countLabel} />
      <time className={inboxCss.rowTime} dateTime={item.newestOccurredAt} title={formatAbsoluteTime(item.newestOccurredAt)}>{formatInboxTime(item.newestOccurredAt, t)}</time>
    </span>
    <span className={inboxCss.rowPreview}>{item.previewText}</span>
  </button>
}
