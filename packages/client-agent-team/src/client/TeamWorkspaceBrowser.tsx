import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconAgentPresetOutlineRegular, IconListPenOutlineRegular, IconQueueOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamAddMemberRequest } from '@contexera/dsh-agent-team/types'
import type { TeamSidebarProps } from './slots.ts'
import { TeamWorkspaceSelector } from './TeamWorkspaceSelector.tsx'
import { TeamAgentsPanel } from './TeamAgentsPanel.tsx'
import { TeamChannelsPanel } from './TeamChannelsPanel.tsx'
import css from './sidebar.module.css'

type SidebarSection = 'channels' | 'agents'

/**
 * The Inbox entry's icon with its unread mark. The quantity left this surface
 * and lives in the control's accessible name: the sidebar answers whether
 * anything is waiting at a glance, and the number — which moves on every fact —
 * is what a reader asks for on purpose. The mark hangs off the icon rather than
 * off the control, so the wide card and the 36px rail button put the same dot
 * on the same corner of the same glyph.
 */
function InboxMark({ unread }: { readonly unread: number }) {
  return <span className={css.inboxMark}>
    <IconQueueOutlineRegular size={16} />
    {unread > 0 && <span className={css.inboxDot} data-team-inbox-dot aria-hidden="true" />}
  </span>
}

export function TeamWorkspaceBrowser({ wide, expandSidebar, navigation, selectWorkspace, selectChannel, selectInbox, t, useWorkspaces, loadMembers, loadInbox, subscribeChanges, subscribeReads, addMember, loadChannels, createChannel, updateChannel, archiveChannel, updateMember, recoverMember, archiveMember, joinWorkspace, leaveWorkspace, joinChannel, removeChannelMember, loadModels, openMemberSession }: TeamSidebarProps) {
  const navigationState = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  const workspaces = useWorkspaces(state => state.items)
  const selected = navigationState.workspaceId
  const selectedExists = selected !== undefined && workspaces.some(workspace => workspace.workspaceId === selected)
  const selectedId = selectedExists ? selected : workspaces[0]?.workspaceId
  // Exactly one sidebar row carries aria-current='page': the open Channel while
  // one is set, the selected Agent card while a Member Session view is open,
  // otherwise the browsed Workspace's overview. The selected row keeps its
  // quiet folder tint (data-selected) in every case. The mention-Inbox card
  // takes the marker while the Inbox page stands, and stands down while the
  // embedded Member Session covers that page: the Inbox stays the remembered
  // face underneath — closing the overlay returns to it, marker included —
  // but the card is not a second current page while an Agent holds the seat.
  const overviewIsCurrent = navigationState.channelRef === undefined && navigationState.memberSessionId === undefined && navigationState.inbox !== true
  const inboxIsCurrent = navigationState.inbox === true && navigationState.memberSessionId === undefined
  const [creatingAgents, setCreatingAgents] = useState<readonly AgentTeamAddMemberRequest[]>([])
  // Rail icons request expansion and name the section to reveal once wide.
  const [pendingSection, setPendingSection] = useState<SidebarSection>()
  const channelsRef = useRef<HTMLDivElement>(null)
  const agentsRef = useRef<HTMLDivElement>(null)
  // The cross-Workspace Inbox badge: one scope-less subscription while the
  // Team sidebar stands; every wake re-pulls each Workspace's unread total
  // (limit 1 — totals cover every row, never the list). Same-burst wakes
  // coalesce behind a short debounce; the number is whatever the Host's whole
  // unread slice returns, mentions included rather than alone.
  const [inboxTotal, setInboxTotal] = useState(0)
  // The last successful total per Workspace, kept across failed refreshes so
  // the badge never folds an unread read into zero.
  const keptTotalsRef = useRef(new Map<string, number>())
  // One name for both entries: what the control is, and how much waits behind
  // it. The rail repeats it as its hover hint, which is the only place a reader
  // still meets the quantity without opening the page.
  const inboxLabel = inboxTotal > 0 ? t('inboxTitleWithCount', { count: inboxTotal }) : t('inboxTitle')
  useEffect(() => {
    let disposed = false
    let scheduled: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      const results = await Promise.all(workspaces.map(async workspace => ({
        workspaceId: workspace.workspaceId,
        result: await loadInbox({ workspaceId: workspace.workspaceId, limit: 1 }),
      })))
      if (disposed) return
      // A failed refresh keeps that Workspace's last successful total: a read
      // that did not land must never fold into zero and read as "no unread"
      // (issue 03 criterion 6). Recovery overwrites the kept value — a
      // failure freezes nothing — and the read layer's per-key failed
      // counter is where the failure stays inspectable; the badge gains no
      // new visual state for it.
      const totals = new Map<string, number>()
      for (const { workspaceId, result } of results) {
        totals.set(workspaceId, result.ok ? result.value.totalUnreadCount : keptTotalsRef.current.get(workspaceId) ?? 0)
      }
      keptTotalsRef.current = totals
      setInboxTotal([...totals.values()].reduce((sum, total) => sum + total, 0))
    }
    const schedule = (): void => {
      if (scheduled !== undefined) return
      scheduled = setTimeout(() => { scheduled = undefined; void refresh() }, 200)
    }
    void refresh()
    const unsubscribe = subscribeChanges(undefined, update => {
      if (update.type === 'changed') schedule()
    })
    // A durable Thread read consumes this reader's mention markers without a
    // changes wake (reads change no shared projection), so the badge also
    // refreshes from every completed read.
    const unsubscribeReads = subscribeReads(schedule)
    return () => {
      disposed = true
      if (scheduled !== undefined) clearTimeout(scheduled)
      unsubscribe()
      unsubscribeReads()
    }
  }, [loadInbox, subscribeChanges, subscribeReads, workspaces])

  useEffect(() => {
    // The Inbox page is global and needs no selected Workspace, so the
    // auto-select must not yank the seat back to a Workspace overview.
    if (navigationState.inbox === true) return
    if (navigationState.mode === 'team' && selectedId !== undefined && selectedId !== selected) {
      selectWorkspace(selectedId)
    }
  }, [navigationState.inbox, navigationState.mode, selected, selectedId, selectWorkspace])

  useEffect(() => {
    if (!wide || pendingSection === undefined) return
    const node = pendingSection === 'agents' ? agentsRef.current : channelsRef.current
    setPendingSection(undefined)
    queueMicrotask(() => { node?.querySelector<HTMLButtonElement>('button')?.focus() })
  }, [wide, pendingSection])

  if (!wide) {
    return <nav className={css.railWorkspace} aria-label={t('workspaceSections')}>
      <Tooltip label={inboxLabel} side="right">
        <button type="button" className={css.railButton} aria-label={inboxLabel} aria-current={inboxIsCurrent ? 'page' : undefined} onClick={() => { selectInbox(); expandSidebar() }}>
          <InboxMark unread={inboxTotal} />
        </button>
      </Tooltip>
      <Tooltip label={t('channels')} side="right">
        <button type="button" className={css.railButton} aria-label={t('channels')} onClick={() => { setPendingSection('channels'); expandSidebar() }}>
          <IconListPenOutlineRegular size={16} />
        </button>
      </Tooltip>
      <Tooltip label={t('agents')} side="right">
        <button type="button" className={css.railButton} aria-label={t('agents')} onClick={() => { setPendingSection('agents'); expandSidebar() }}>
          <IconAgentPresetOutlineRegular size={16} />
        </button>
      </Tooltip>
    </nav>
  }

  return <section className={css.workspaceBrowser} aria-label={t('workspaces')}>
    {/* The Inbox is the one destination that crosses Workspaces — its total sums
        every one of them — so it stands above the selector rather than inside
        the scope that selector names. */}
    <button type="button" className={css.inboxCard} aria-label={inboxLabel} aria-current={inboxIsCurrent ? 'page' : undefined} onClick={selectInbox}>
      <InboxMark unread={inboxTotal} />
      <span className={css.inboxCardLabel}>{t('inboxTitle')}</span>
    </button>
    <TeamWorkspaceSelector workspaces={workspaces} selectedId={selectedId} current={overviewIsCurrent} onSelect={selectWorkspace} t={t} />
    {selectedId !== undefined && <div className={css.workspaceSection}>
      <div ref={channelsRef}>
        <TeamChannelsPanel key={selectedId} workspaceId={selectedId} loadMembers={loadMembers} loadChannels={loadChannels} subscribeChanges={subscribeChanges} createChannel={createChannel} updateChannel={updateChannel} archiveChannel={archiveChannel} joinChannel={joinChannel} removeChannelMember={removeChannelMember} creatingAgents={creatingAgents.filter(request => request.workspaceId === selectedId)} {...(navigationState.memberSessionId !== undefined || navigationState.channelRef === undefined ? {} : { selectedChannelRef: navigationState.channelRef })} selectChannel={selectChannel} t={t} />
      </div>
      <div ref={agentsRef}>
        <TeamAgentsPanel key={selectedId} workspaceId={selectedId} loadMembers={loadMembers} subscribeChanges={subscribeChanges} addMember={addMember} updateMember={updateMember} recoverMember={recoverMember} archiveMember={archiveMember} joinWorkspace={joinWorkspace} leaveWorkspace={leaveWorkspace} loadModels={loadModels} {...(navigationState.memberSessionId === undefined ? {} : { memberSessionId: navigationState.memberSessionId })} openMemberSession={openMemberSession} onCreatingChange={(request, creating) => { setCreatingAgents(current => creating ? [...current.filter(item => item.requestId !== request.requestId), request] : current.filter(item => item.requestId !== request.requestId)) }} t={t} />
      </div>
    </div>}
  </section>
}
