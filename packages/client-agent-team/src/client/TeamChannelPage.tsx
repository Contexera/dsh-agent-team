import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamChannelRef, AgentTeamInbox, AgentTeamMemberId, AgentTeamSendMessageRequest, AgentTeamTask, AgentTeamView, AgentTeamViewItem,
  AgentTeamTaskRef, AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { Button, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { mintRequestId, uploadComposerFiles } from './requests.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import { TeamComposer } from './TeamComposer.tsx'
import { TeamChannelPanel } from './TeamChannelPanel.tsx'
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
import { rosterChannelName, rosterMember } from './refs.ts'
import { chunkRunsWithDays, isRunGap } from './team-separators.ts'
import channelCss from './channel.module.css'
import css from './conversation.module.css'
import threadCss from './thread.module.css'

interface TeamChannelPageProps {
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  /** The Human's own display name and avatar, from the shared identity projection. */
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly loadChannels: TeamConversationProps['loadChannels']
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly loadMembers: TeamConversationProps['loadMembers']
  /** The Human's own unread per Thread: the Host's three-class judgement, never a Client guess. */
  readonly loadInbox: TeamConversationProps['loadInbox']
  readonly drafts: TeamDraftStore
  readonly getAttachment: TeamConversationProps['getAttachment']
  readonly putAttachment: TeamConversationProps['putAttachment']
  readonly sendMessage: TeamConversationProps['sendMessage']
  readonly readThread: TeamConversationProps['readThread']
  readonly loadThreadHistory: TeamConversationProps['loadThreadHistory']
  readonly threadObservations: TeamConversationProps['threadObservations']
  readonly reply: TeamConversationProps['reply']
  readonly promoteThread: TeamConversationProps['promoteThread']
  readonly selectThread: TeamConversationProps['selectThread']
  readonly selectChannel: TeamConversationProps['selectChannel']
  readonly resolveTaskRefs: TeamConversationProps['resolveTaskRefs']
  readonly resolveThreadRefs: TeamConversationProps['resolveThreadRefs']
  readonly openMemberSession: TeamConversationProps['openMemberSession']
  readonly t: TeamConversationProps['t']
}

/**
 * Merge the freshest top-level window over what the reader already has. The
 * fresh window is authoritative for every Message it covers — a change wake
 * must move that row's live Task state, newest instant, and unread with it —
 * while older Messages loaded earlier are retained instead of discarded.
 */
function mergeChannelView(current: AgentTeamView, fresh: AgentTeamView): AgentTeamView {
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

/** Whether the retained items reach older than the fresh window's own start. */
function hasOlderBeyondFreshWindow(current: AgentTeamView, fresh: AgentTeamView): boolean {
  return current.cursor < fresh.cursor
}

/**
 * The newest fact instant, or nothing when the entry's own Message is still the
 * newest fact on its Thread. That difference is exactly what "has follow-up
 * activity" means, and the Host projects both instants from the ledger.
 */
function newerActivityAt(item: AgentTeamViewItem): string | undefined {
  const lastActivityAt: string | undefined = item.lastActivityAt
  return lastActivityAt === undefined || lastActivityAt === item.message.occurredAt ? undefined : lastActivityAt
}

/**
 * What the door prints about follow-up activity, or nothing. Unfinished work
 * reports the recency that is the whole of its state line; a resolved Task
 * prints the day it landed instead (see `ThreadEntryRow`), because the recency
 * there would only repeat the moment it resolved on every finished row.
 */
function unresolvedFollowUpAt(item: AgentTeamViewItem): string | undefined {
  const status = item.task?.status
  return status === 'done' || status === 'closed' ? undefined : newerActivityAt(item)
}

/**
 * Host unread per Thread, keyed for the feed's rows: zero unread is the absence
 * of a badge, not a row. A failed read keeps the previous counts: a read failure
 * must not render as "everything was consumed".
 */
function applyInboxRead(
  previous: ReadonlyMap<AgentTeamThreadRef, number>,
  result: RemoteResult<AgentTeamInbox>,
): ReadonlyMap<AgentTeamThreadRef, number> {
  if (!result.ok) return previous
  return new Map(result.value.items.filter(item => item.unreadCount > 0).map(item => [item.thread.threadRef, item.unreadCount]))
}

export function TeamChannelPage({ workspaceId, channelRef, humanName, humanAvatarUrl, loadChannels, subscribeChanges, loadMembers, loadInbox, drafts, putAttachment, getAttachment, sendMessage, readThread, loadThreadHistory, threadObservations, reply, promoteThread, selectThread, selectChannel, resolveTaskRefs, resolveThreadRefs, openMemberSession, t }: TeamChannelPageProps) {
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
  // The feed and the board are two readings of one window; the tab only chooses
  // which of them fills the content seat.
  const [tab, setTab] = useState<'feed' | 'board'>('feed')
  // The taskless Thread open in the feed's side panel. A Task's entry still
  // walks into the Thread page; only a discussion stays here.
  const [panelThreadRef, setPanelThreadRef] = useState<AgentTeamThreadRef>()
  // The surface the panel is seated in, which owns the panel-width variable: the
  // drag handle writes it there, so a drag never re-renders this page.
  const [panelSurface, setPanelSurface] = useState<HTMLElement | null>(null)
  // The composer draft lives in the keyed draft cache: view switches unmount
  // this page, and a refresh must not cost the half-written message either.
  // The composer owns the subscription — this page only reads a snapshot when
  // it sends, so typing never re-renders the timeline.
  const draftKey: TeamDraftKey = `channel:${channelRef}`
  const mountedRef = useRef(false)
  // Flips after the first successful timeline load; later change wakes
  // refresh in place instead of showing the loading surface again.
  const loadedRef = useRef(false)
  const refreshSequenceRef = useRef(0)
  const channelLastItem = view?.items[view.items.length - 1]
  // Derived ids, so a second Channel page cannot collide with this one.
  const tabIdPrefix = useId()
  const feedTabRef = useRef<HTMLButtonElement>(null)
  const boardTabRef = useRef<HTMLButtonElement>(null)
  // The shipped tab strip's contract: arrows cycle, Home/End jump, and
  // selection follows focus. Enter and Space need no branch — the button's own
  // activation runs the click handler on release.
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
  // Branded-ref navigation for message bodies: channel refs hop directly,
  // task and thread refs resolve against this Channel's loaded timeline and
  // fall back to the Host resolver, which also accepts abbreviated spellings.
  // Unresolvable refs never become links (see TeamMessage), so this path only
  // fires for refs the Host already confirmed.
  const openRef = (ref: string): void => {
    if (ref.startsWith('channel:')) {
      if (ref !== channelRef) selectChannel(ref as AgentTeamChannelRef)
      return
    }
    if (ref.startsWith('thread:')) {
      const match = view?.items.find(item => item.thread.threadRef === ref)
      if (match !== undefined) {
        // A taskless discussion opens in the feed's own panel; a Task keeps
        // walking into the Thread page.
        if (match.task === undefined) { setPanelThreadRef(match.thread.threadRef); return }
        selectThread(match.thread.threadRef, channelRef, match.task.taskRef, match.taskNumber)
        return
      }
      // Not in the loaded timeline (or cited by abbreviation): resolve through
      // the Host and jump to the Thread's home Channel.
      jumpToThread(resolveThreadRefs, workspaceId, ref as AgentTeamThreadRef, selectThread)
      return
    }
    if (ref.startsWith('task:')) {
      const match = view?.items.find(item => item.task?.taskRef === ref)
      if (match !== undefined) {
        selectThread(match.thread.threadRef, channelRef, match.task?.taskRef, match.taskNumber)
        return
      }
      // Not in the loaded timeline: resolve through the Host and jump to the
      // Task's home Channel.
      jumpToTaskThread(resolveTaskRefs, workspaceId, ref as AgentTeamTaskRef, selectThread)
    }
  }

  const lookupTaskRefs = hostTaskRefLookup(resolveTaskRefs, workspaceId)
  const lookupThreadRefs = hostThreadRefLookup(resolveThreadRefs, workspaceId)
  // Roster chips resolve synchronously from loaded data: channel names from
  // the loaded feed windows, member facts from the member list. Anything
  // outside stays plain text — the same rule unresolvable refs follow. The
  // lookups key on roster content, not array identity: every refresh hands
  // over fresh arrays, and the memoized rows must survive change bursts that
  // leave the roster itself untouched.
  const rosterKey = useMemo(() => [
    (view?.channels ?? []).map(channel => `${channel.channelRef}=${channel.name}=${channel.state}`).join(','),
    members.map(status => `${status.member.memberId}=${status.member.handle}=${status.member.sessionId}=${status.availability}`).join(','),
    view?.humanMemberId ?? '',
  ].join(';'), [view, members])
  const channelNameOf = useMemo(() => {
    const channels = view?.channels ?? []
    return (ref: AgentTeamChannelRef): string | undefined => rosterChannelName(channels, ref)
  }, [rosterKey])
  const memberOf = useMemo(() => {
    const humanMemberId = view?.humanMemberId
    return (ref: AgentTeamMemberId) => rosterMember(members, humanMemberId, humanName, ref)
  }, [rosterKey, humanName])
  const taskNumberOf = useMemo(() => {
    const numbers = view?.taskNumbers ?? []
    return (taskRef: AgentTeamTaskRef): number | undefined => numbers.find(entry => entry.taskRef === taskRef)?.taskNumber
  }, [view])
  // Zero unread is the absence of a map entry, so clearing deletes the key.
  const handlePanelRead = useCallback((read: AgentTeamThreadRef): void => {
    setUnreadByThread(current => {
      if (!current.has(read)) return current
      const next = new Map(current)
      next.delete(read)
      return next
    })
  }, [])
  const handlePanelPromoted = useCallback((taskRef: AgentTeamTaskRef): void => {
    if (panelThreadRef !== undefined) selectThread(panelThreadRef, channelRef, taskRef, taskNumberOf(taskRef))
    setPanelThreadRef(undefined)
  }, [panelThreadRef, channelRef, selectThread, taskNumberOf])
  const handlePanelClose = useCallback((): void => { setPanelThreadRef(undefined) }, [])
  // The Thread entry row's owner stack speaks the same grammar as the Inbox
  // row's, Human included: the Host names which actor is the reader, the
  // Client's identity projection says what that actor looks like.
  const humanMemberId = view?.humanMemberId
  const humanIdentity: TeamAvatarHuman | undefined = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) }

  // Every taskful entry in the loaded window, newest Task number first inside
  // its column. The window is the feed's: walking the Channel's remaining
  // history would merge every top-level Message into the timeline to fill four
  // columns, defeating the feed's own pagination.
  const boardColumns = useMemo(() => {
    const taskful = (view?.items ?? []).filter((item): item is AgentTeamViewItem & { readonly task: AgentTeamTask } => item.task !== undefined)
    const byNumber = (left: AgentTeamViewItem, right: AgentTeamViewItem): number => (right.taskNumber ?? 0) - (left.taskNumber ?? 0)
    return BOARD_COLUMNS.map(column => ({ ...column, items: taskful.filter(item => column.match(item.task.status)).sort(byNumber) }))
  }, [view])

  const timeline = useTimelineScroll(`${view?.items.length ?? 0}:${channelLastItem?.message.messageRef ?? ''}`)

  // Seat the panel from its surface: the saved choice, else this surface's
  // default share. The surface is laid out after this effect first runs, so the
  // seat follows its box — a one-shot pass would seat from a pre-layout width
  // and leave it there. A dragged choice is re-clamped, never re-derived.
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
  const channel = view?.channels.find(item => item.channelRef === channelRef)
  const channelMemberIds = new Set(view?.members.filter(item => item.channelRef === channelRef).map(item => item.memberId) ?? [])
  const messageSender = (item: AgentTeamViewItem): AgentTeamMemberId => item.message.sender
  const handleByMember = new Map(members.map(status => [status.member.memberId, status.member.handle.replace(/^@/, '')]))

  const refresh = async (clearError = false) => {
    if (!mountedRef.current) return false
    const sequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = sequence
    // Only the first refresh owns the loading surface; change wakes refresh
    // the rendered timeline in place instead of flashing it back to skeleton.
    if (!loadedRef.current) setLoading(true)
    if (clearError) {
      setLoadError(undefined)
      setStatusMessage(undefined)
    }
    try {
      const [loaded, loadedMembers, loadedInbox] = await Promise.all([
        loadChannels({ workspaceId, channelRef, direction: 'before', topLevelOnly: true, includeActivities: false, limit: 20 }),
        loadMembers({ workspaceId }),
        // The non-direct slice of the Host's own Inbox is the authority for
        // "what needs me on this Thread" — following activity, mentions, and my
        // Task/Claim changes alike. Nothing here re-derives unread from message
        // mentions.
        loadInbox({ workspaceId, limit: 100 }),
      ])
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return false
      if (loaded.ok) { setView(current => current === undefined ? loaded.value : mergeChannelView(current, loaded.value)); loadedRef.current = true } else setLoadError(loaded.error.message)
      if (loadedMembers.ok) setMembers(loadedMembers.value); else setLoadError(loadedMembers.error.message)
      // A failed inbox read keeps the last successful counts while the failure
      // itself surfaces through the error face below.
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

  // Presence and membership live in the workspace projection; they never need
  // the Channel timeline refetch that a full refresh performs.
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
      subscribeChanges({ kind: 'channel', channelRef }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setLoadError(update.message); return }
        void refresh()
      }),
      subscribeChanges({ kind: 'workspace', workspaceId }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setLoadError(update.message); return }
        void refreshMembers()
      }),
      // Presence transitions commit nothing: only the member rows move, so
      // the header presence counts refresh without a timeline refetch.
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
  }, [workspaceId, channelRef])

  const loadOlder = async () => {
    if (view === undefined || !view.hasMore || loadingOlder) return
    setLoadingOlder(true)
    try {
      const result = await loadChannels({ workspaceId, channelRef, direction: 'before', topLevelOnly: true, includeActivities: false, cursor: view.cursor, limit: 20 })
      if (!mountedRef.current) return
      if (!result.ok) { setError(result.error.message); return }
      setView(current => current === undefined ? result.value : mergeChannelView(current, result.value))
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setLoadingOlder(false)
    }
  }

  // Retained across transport failures so a replayed send dedupes on the Host;
  // definitive outcomes (committed or rejected) start the next send fresh.
  const pendingSendId = useRef<AgentTeamSendMessageRequest['requestId']>()

  // Editing the draft invalidates the one-shot status line. The setter returns
  // the same state when there is nothing to clear, so a keystroke does not
  // re-render the timeline now that the composer owns the draft.
  const clearSendState = useCallback((): void => {
    setStatusMessage(current => current === undefined ? current : undefined)
  }, [])

  const send = async () => {
    // Read the draft at send time: this page no longer subscribes to it, so a
    // captured render value would be stale after the composer's own edits.
    const { draft, recipients } = drafts.getSnapshot(draftKey)
    if (pending || draft.trim() === '') return
    const recipientIds = [...recipients].sort()
    const requestId = pendingSendId.current ?? mintRequestId()
    pendingSendId.current = requestId
    setPending(true); setError(undefined); setStatusMessage(undefined)
    try {
      // Upload chosen files first; any failure aborts the send with the
      // existing error surface and keeps the chips for a retry.
      const upload = await uploadComposerFiles(putAttachment, workspaceId, pendingFiles)
      if (!upload.ok) {
        pendingSendId.current = undefined
        setError(upload.error)
        return
      }
      const attachmentIds = upload.attachmentIds
      const request: AgentTeamSendMessageRequest = {
        requestId, workspaceId,
        channelRef, body: draft.trim(), recipients: recipientIds,
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

  return <main className={css.surface} data-team-channel={channelRef} ref={setPanelSurface}>
    <div className={`${css.surfaceHeader} ${css.surfaceHeaderWithTabs}`}>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <div className={channelCss.headerIdentity}>
            <h1>{channel === undefined ? '# …' : `# ${channel.name}`}</h1>
            {channel !== undefined && channel.description !== '' && <p className={channelCss.headerDescription} title={channel.description}>{channel.description}</p>}
          </div>
        </div>
      </header>
      <nav className={channelCss.tabs} role="tablist" aria-label={channel === undefined ? '# …' : `# ${channel.name}`} onKeyDown={onTabKeyDown}>
        <button ref={feedTabRef} id={`${tabIdPrefix}-feed`} type="button" role="tab" aria-selected={tab === 'feed'} aria-controls={`${tabIdPrefix}-feed-panel`} tabIndex={tab === 'feed' ? 0 : -1} className={channelCss.tab} onClick={() => { setTab('feed') }}>{t('channelTabFeed')}</button>
        <button ref={boardTabRef} id={`${tabIdPrefix}-board`} type="button" role="tab" aria-selected={tab === 'board'} aria-controls={`${tabIdPrefix}-board-panel`} tabIndex={tab === 'board' ? 0 : -1} className={channelCss.tab} onClick={() => { setTab('board') }}>{t('channelTabBoard')}</button>
      </nav>
    </div>

    {tab === 'board' && <section id={`${tabIdPrefix}-board-panel`} role="tabpanel" aria-labelledby={`${tabIdPrefix}-board`} className={channelCss.board}>
      {view?.hasMore && <div className={css.timelineAction}><Button size="sm" disabled={loadingOlder} onClick={() => { void loadOlder() }}>{t('loadOlder')}</Button></div>}
      {boardColumns.every(column => column.items.length === 0) && <div className={css.emptySurface}><p className={css.emptyState}>{t('boardEmpty')}</p></div>}
      {boardColumns.some(column => column.items.length > 0) && <div className={channelCss.boardColumns}>
        {boardColumns.map(column => <div className={channelCss.boardColumn} key={column.labelKey}>
          <div className={channelCss.boardColumnHead}>{t(column.labelKey)}<span className={channelCss.boardColumnCount}>{column.items.length}</span></div>
          {column.items.map(item => <BoardCard
            key={item.message.messageRef}
            item={item}
            unread={unreadByThread.get(item.thread.threadRef) ?? 0}
            human={humanIdentity}
            t={t}
            onOpen={() => { selectThread(item.thread.threadRef, channelRef, item.task.taskRef, item.taskNumber) }}
          />)}
        </div>)}
      </div>}
    </section>}

    {tab === 'feed' && <div id={`${tabIdPrefix}-feed-panel`} role="tabpanel" aria-labelledby={`${tabIdPrefix}-feed`} className={channelCss.feedStage} data-panel={panelThreadRef === undefined ? 'closed' : 'open'}>
      <section ref={timeline.ref} onScroll={timeline.onScroll} className={css.timeline} aria-label={t('timelineLabel')}>
      <div className={css.timelineContent}>
        {loading && channel === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingChannels')}</p></div>}
        {!loading && channel === undefined && error === undefined && <div className={css.emptySurface}><p className={css.emptyState}>{t('emptyChannels')}</p></div>}
        {!loading && channel === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void refresh(true) }}>{t('retry')}</Button></div>}
        {view?.hasMore && <div className={css.timelineAction}><Button size="sm" disabled={loadingOlder} onClick={() => { void loadOlder() }}>{t('loadOlder')}</Button></div>}
        {channel !== undefined && view?.items.length === 0 && <div className={css.emptySurface}>
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
            // The entry's own line is the gate under the body, and its state
            // leads that line: ownership, status, and unread answer the reader
            // where they are already reading. A reply inside a Thread has none
            // of it — the Thread page owns that surface.
            const unread = unreadByThread.get(item.thread.threadRef) ?? 0
            // A turn boundary on this level keeps its hairline — the feed states
            // blocks, where the Thread reads as one flow — but never the instant:
            // every row states its own time under the pointer.
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
                channelNameOf={channelNameOf}
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
                    // A taskless discussion opens in the feed's own panel; a
                    // Task keeps walking into the Thread page.
                    if (item.task === undefined) setPanelThreadRef(item.thread.threadRef)
                    else selectThread(item.thread.threadRef, channelRef, item.task.taskRef, item.taskNumber)
                  }}
                />}
              </TeamMessage>
            </Fragment>
          })}
        </div>)}
      </div>
      </section>

      {channel !== undefined ? <TeamComposer
      key={draftKey}
      members={members}
      channelPeerMemberIds={channelMemberIds}
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
    </div>}

    {tab === 'feed' && panelThreadRef !== undefined && channel !== undefined && <TeamChannelPanel
      surface={panelSurface}
      workspaceId={workspaceId}
      channelRef={channelRef}
      threadRef={panelThreadRef}
      channelName={channel.name}
      humanName={humanName}
      {...(humanAvatarUrl === undefined ? {} : { humanAvatarUrl })}
      {...(view?.humanMemberId === undefined ? {} : { humanMemberId: view.humanMemberId })}
      members={members}
      channelMemberIds={channelMemberIds}
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
      selectChannel={selectChannel}
      resolveTaskRefs={resolveTaskRefs}
      resolveThreadRefs={resolveThreadRefs}
      openMemberSession={openMemberSession}
      channelNameOf={channelNameOf}
      memberOf={memberOf}
      taskNumberOf={taskNumberOf}
      onRead={handlePanelRead}
      onPromoted={handlePanelPromoted}
      onClose={handlePanelClose}
      t={t}
    />}
  </main>
}

/**
 * One entry's state: who is on the work, where it stands, and how much of it
 * needs the reader. It leads the entry's own line rather than trailing the
 * identity line, so a reader meets it where they are already reading instead of
 * crossing the column for it — and the same placement holds whether this
 * Message opened its run or continued one, where an identity line would have
 * carried nothing else. The unread capsule is the only member a taskless
 * discussion can carry: it needs no Task.
 */
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
 * The gate under one top-level Message: the single row that opens its Thread,
 * and the one line that says what stands there. State leads it, then what the
 * entry is: a Task entry keeps its number so the status word never floats free
 * of the Task it describes, follow-up activity adds when the work last moved —
 * while the work is still unfinished — and an unanswered Thread says only 回复.
 * The instant uses the Inbox's own 今天/昨天 form with the precise local time on
 * the control's title, and an unread Thread says so in the control's label
 * rather than only in pixels.
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
  // A resolved Task's gate slims to a footnote — no owner stack, no status
  // dot: the word and the day it landed say what is left to say, and the
  // board owns scanning resolved work now. Unread still counts beside it:
  // a resolved Thread can be answered.
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
  // The state is a label, not a control: it stays outside the button so the
  // owner stack keeps its own accessible name — a labeled button prunes its
  // descendants from the accessibility tree — and so the control's name says
  // exactly what clicking it does.
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

/** The board's columns: the three moving states first, then everything resolved. */
const BOARD_COLUMNS = [
  { labelKey: 'taskStatusTodo', match: (status: AgentTeamTask['status']): boolean => status === 'todo' },
  { labelKey: 'taskStatusInProgress', match: (status: AgentTeamTask['status']): boolean => status === 'in_progress' },
  { labelKey: 'taskStatusInReview', match: (status: AgentTeamTask['status']): boolean => status === 'in_review' },
  { labelKey: 'taskStatusDone', match: (status: AgentTeamTask['status']): boolean => status === 'done' || status === 'closed' },
] as const

/**
 * One Task on the board: the same facts the feed's entry row prints, re-dealt
 * for scanning by state — the status dot and number lead, the title is the
 * opener's first line, and the foot names who is on it (or that nobody is)
 * beside when it last moved. Resolved work dims rather than dressing up: the
 * board's job is to keep the moving work loudest.
 */
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
  // For resolved work the newest fact is the resolution itself — the date the
  // card prints is when it landed; for moving work it is when it last moved.
  const activityAt = item.lastActivityAt
  const namedOwners = namedAvatarOwners(item.liveClaimOwners, human)
  return <button
    type="button"
    className={channelCss.boardCard}
    {...(resolved ? { 'data-resolved': '' } : {})}
    aria-label={unread > 0 ? t('openTaskUnread', { number: taskNumber, count: unread }) : t('openTask', { number: taskNumber })}
    onClick={onOpen}
  >
    <span className={channelCss.boardCardNum}>
      <TeamStateDot size={8} state={taskStatusDot(task.status)} />
      {t('taskLabel', { number: taskNumber })}
      <TeamCountBadge count={unread} />
    </span>
    <span className={channelCss.boardCardTitle}>{formatTaskTitle(item.message.body)}</span>
    <span className={channelCss.boardCardFoot}>
      {namedOwners.length === 0
        ? <span>{t('boardUnassigned')}</span>
        : <TeamAvatarStack owners={namedOwners} label={claimersLabel(namedOwners, t)} human={human} />}
      <time dateTime={activityAt} title={formatAbsoluteTime(activityAt)}>{formatInboxTime(activityAt, t)}</time>
    </span>
  </button>
}
