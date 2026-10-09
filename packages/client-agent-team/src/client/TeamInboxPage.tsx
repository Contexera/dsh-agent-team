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
  /** The Human's display name, from the Client's one identity projection. */
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly t: TeamConversationProps['t']
}

/**
 * How many 「最近活跃」 rows the merged page may show. The Host bounds each
 * Workspace's own slice; this is the single bound across every Workspace on
 * screen, so the section stays the same size no matter how many are open — and
 * it stays a way back into work rather than a second queue, which is why it is
 * shorter than the queue the reader is actually being asked to work through.
 */
const RECENT_ROWS_LIMIT = 5

/**
 * Queue order, one total order across Workspaces: the Host's own keys —
 * mentions first, then the ledger sequence, then the Thread ref. Each Workspace
 * slice already arrives in this order, and it is also the Host's truncation
 * policy, so the merge re-applies it instead of inventing a second one: a row
 * that survived the cut on mentions must not sink below a merely newer row
 * after the merge. `newestSequence` is a global ledger position, so it stays
 * comparable across Workspaces.
 */
function compareInboxRows(left: TeamInboxRow, right: TeamInboxRow): number {
  return right.item.directCount - left.item.directCount
    || right.item.newestSequence - left.item.newestSequence
    || left.item.thread.threadRef.localeCompare(right.item.thread.threadRef)
}

/**
 * The Human Inbox: one Inbox call per visible Workspace, rendering the Host's
 * two slices — the unread queue (「需要我」, mentions counted inside it rather
 * than alone) and the 「最近活跃」 tail of Threads the reader took part in.
 * Both merge across every Workspace into one list in the Host's own order,
 * mentions first and then newest, rather than by Workspace.
 * Opening the page never acknowledges anything — only a durable Thread read
 * advances the watermark and consumes a mention marker, so rows and the badge
 * drop after the Thread is opened through the existing auto-ack path. A Thread
 * holding unread is only ever in the queue: the Host already excludes it from
 * the tail, and this page never re-derives that judgement.
 */
export function TeamInboxPage({ useWorkspaces, loadInbox, subscribeChanges, selectWorkspace, selectThread, humanName, humanAvatarUrl, t }: TeamInboxPageProps) {
  const workspaces = useWorkspaces(state => state.items)
  const [rows, setRows] = useState<readonly TeamInboxRow[]>()
  const [recentRows, setRecentRows] = useState<readonly TeamInboxRow[]>([])
  // The Host names the Human's Member id on every Inbox row's payload; the
  // page keeps it so a row can draw that one actor from the Client's own
  // Human identity instead of the initials the stack gives every Agent.
  const [humanMemberId, setHumanMemberId] = useState<AgentTeamMemberId>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  // Only the first refresh owns the loading surface; later wakes refresh the
  // rendered rows in place instead of flashing them back to skeleton.
  const loadedRef = useRef(false)
  // Per-Workspace last successful slice: a Workspace whose read fails keeps
  // its rows — a failed read must not empty this action queue for that
  // Workspace (the sidebar badge holds the same keep-last-good policy) — and
  // the next success overwrites the kept slice.
  const keptSlicesRef = useRef(new Map<string, { readonly items: readonly AgentTeamInboxItem[]; readonly recent: readonly AgentTeamInboxItem[] }>())

  const refresh = useCallback(async () => {
    if (!loadedRef.current) setLoading(true)
    const results = await Promise.all(workspaces.map(async workspace => {
      const result = await loadInbox({ workspaceId: workspace.workspaceId, limit: 100 })
      if (result.ok) {
        keptSlicesRef.current.set(workspace.workspaceId, { items: result.value.items, recent: result.value.recent })
        return { ok: true as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, items: result.value.items, recent: result.value.recent, humanMemberId: result.value.humanMemberId }
      }
      const kept = keptSlicesRef.current.get(workspace.workspaceId)
      return { ok: false as const, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, items: kept?.items ?? [], recent: kept?.recent ?? [], message: result.error.message }
    }))
    const failure = results.find(result => !result.ok)
    setHumanMemberId(results.find(result => result.ok)?.humanMemberId)
    const asRows = (items: readonly AgentTeamInboxItem[], workspaceId: WorkspaceId, workspaceTitle: string): TeamInboxRow[] =>
      items.map(item => ({ workspaceId, workspaceTitle, item }))
    setRows(results.flatMap(result => asRows(result.items, result.workspaceId, result.workspaceTitle)).sort(compareInboxRows))
    // The tail is one global bound rather than one per Workspace: the reader was
    // promised five Threads to step back into, and every Workspace's slice is
    // already capped on its own, so the merged list is trimmed here.
    setRecentRows(results.flatMap(result => asRows(result.recent, result.workspaceId, result.workspaceTitle))
      .sort(compareInboxRows).slice(0, RECENT_ROWS_LIMIT))
    setError(failure?.ok === false ? failure.message : undefined)
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

  // The page rides the shared conversation seat: the same header band, 880px
  // reading column, responsive gutters, and scrollbar gutter as Channel and
  // Thread, so switching surfaces does not shift the content column.
  const totalUnread = rows?.reduce((sum, row) => sum + row.item.unreadCount, 0) ?? 0
  const totalMentions = rows?.reduce((sum, row) => sum + row.item.directCount, 0) ?? 0
  // A row names its Workspace only while the rows on screen span more than one.
  // With a single Workspace in the list the segment is a constant printed down
  // every row, which spends the row's most readable position on something that
  // never varies; the moment a second Workspace reaches the list it comes back,
  // because two rows then have to be tellable apart. This reads the rows rather
  // than the open Workspaces: a Workspace holding nothing to show here is not a
  // reason to keep printing the name of the one that is.
  const shownWorkspaces = new Set<string>()
  for (const row of rows ?? []) shownWorkspaces.add(row.workspaceTitle)
  for (const row of recentRows) shownWorkspaces.add(row.workspaceTitle)
  const showWorkspace = shownWorkspaces.size > 1
  // One identity for every row on the page: the Host tells the rows which
  // actor is the reader, the Client's identity projection says what that actor
  // looks like. Either half missing leaves the stack on its initials fallback.
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
            {/* The one number the page is about leads the line; mentions join it
                only when the queue actually holds one. */}
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
 * One queue row, shaped like the shipped two-line result row: who is on this
 * Thread leads in the gutter, the identity line answers which Thread this is,
 * how much is waiting, and when it last moved, and the gist sits under it on the
 * same column as evidence for that identity rather than as the row's subject.
 *
 * The gutter carries the one thing every row has — who is on the work, or who
 * moved a Thread nobody has claimed — so a Thread that merely arrived and one
 * that named the reader open on the same edge instead of the quieter one opening
 * on a slot reserved for a count it does not hold. It is the grammar the Channel
 * feed's Thread entry row already speaks, where the people on the work lead the
 * row.
 *
 * Before the queue admitted every unread Thread, each row was a mention and the
 * rows were interchangeable; now that named and ambient unread share one list,
 * the row has to carry that difference itself. The count closes the identity
 * line and only its ink changes — the shared capsule fill for a row that names
 * the reader, a hairline for one that merely moved. The two numbers behind that
 * ink (unread, mentions) reach assistive tech through the capsule's own name,
 * because a second visible count beside the first would cost the row the one
 * thing it needs to stay scannable.
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
  const owners = item.claimOwners
  // The row's names come from the Client's Human identity where it applies, so
  // the chip's letter and the label's name move together on a rename.
  const namedOwners = namedAvatarOwners(owners, human)
  const namedActor = namedAvatarOwners([actor], human)[0]!
  const named = item.directCount > 0
  const countLabel = named
    ? t('inboxRowUnreadMentions', { count: item.unreadCount, mentions: item.directCount })
    : t('inboxRowUnread', { count: item.unreadCount })
  return <button type="button" className={inboxCss.row} data-named={named || undefined} onClick={onOpen}>
    {/* Who is on this Thread leads every row, in the slot the count used to
        reserve: the cluster is there whatever the row holds, so a row never
        opens on empty space and the one column the reader scans down answers
        「谁」 before it answers anything else. A Task's live owners answer it
        wherever there are any — the same stack, the same rule, and the same
        words the Channel feed's Thread entry row leads with — and a Thread with
        no live owner falls back to the person its newest fact came from, since
        that is all anybody knows about it. Which of the two a row shows is the
        Thread's own fact, never the section's: a Thread must not change shape on
        its way from the queue into the 「最近活跃」 tail. The stack's own label is
        what joins the control's accessible name — the avatars are presentational,
        the row's visible text is the Thread, not the queue. */}
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
        {/* Where the Task stands, in the pair the Channel feed's Thread entry row
            and the Thread header already speak: an 8px state dot then its word, so
            a reader picks the Thread back up knowing whether the work they left is
            waiting for them or finished. It is the Task's own fact and it rides
            the clamped provenance run, so a Thread that is merely a discussion
            draws nothing extra and a squeezed seat shortens the standing along
            with the Channel name instead of cutting a hole around it. */}
        {item.task !== undefined && <>
          {' '}
          <span className={inboxCss.rowTaskState} data-team-task-state={item.task.status}>
            <TeamStateDot size={8} state={taskStatusDot(item.task.status)} />
            {formatTaskStatus(item.task.status, t)}
          </span>
        </>}
      </span>
      {/* One capsule per row, closing the identity line beside the instant it
          shares its subject with. A 「最近活跃」 row holds no unread, so it
          renders no capsule at all — zero is the absence of a badge, not a badge
          reading zero — and the row keeps its shape without it. */}
      <TeamCountBadge count={item.unreadCount} tone={named ? 'solid' : 'hairline'} label={countLabel} />
      <time className={inboxCss.rowTime} dateTime={item.newestOccurredAt} title={formatAbsoluteTime(item.newestOccurredAt)}>{formatInboxTime(item.newestOccurredAt, t)}</time>
    </span>
    <span className={inboxCss.rowPreview}>{item.previewText}</span>
  </button>
}
