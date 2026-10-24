import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconAgentPresetOutlineRegular, IconChevronLeftOutlineMedium, IconChevronLeftOutlineRegular, IconListPenOutlineRegular, IconQueueOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamAddMemberRequest, AgentTeamInbox } from '@contexera/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { TeamSidebarProps } from './slots.ts'
import { TeamWorkspaceSelector } from './TeamWorkspaceSelector.tsx'
import { TeamAgentsPanel } from './TeamAgentsPanel.tsx'
import { TeamProjectsPanel } from './TeamProjectsPanel.tsx'
import css from './sidebar.module.css'

/** A failed read keeps the last good total: it must never fold into zero and read as "no unread". Recovery overwrites the kept value. */
function mergeInboxTotals(
  results: readonly { readonly workspaceId: string; readonly result: RemoteResult<AgentTeamInbox> }[],
  previous: ReadonlyMap<string, number>,
): Map<string, number> {
  const totals = new Map<string, number>()
  for (const { workspaceId, result } of results) {
    totals.set(workspaceId, result.ok ? result.value.totalUnreadCount : previous.get(workspaceId) ?? 0)
  }
  return totals
}

type SidebarSection = 'projects' | 'agents'

/**
 * The quantity lives in the control's accessible name. The mark hangs off the icon so the wide card and the 36px rail
 * button put the same dot on the same corner.
 */
function InboxMark({ unread }: { readonly unread: number }) {
  return <span className={css.inboxMark}>
    <IconQueueOutlineRegular size={16} />
    {unread > 0 && <span className={css.inboxDot} data-team-inbox-dot aria-hidden="true" />}
  </span>
}

export function TeamWorkspaceBrowser({ wide, expandSidebar, navigation, selectWorkspace, selectProject, selectInbox, selectBoard, leaveTeam, t, useWorkspaces, loadMembers, loadInbox, subscribeChanges, subscribeReads, addMember, loadProjects, createProject, updateProject, archiveProject, addProjectOwner, removeProjectOwner, humanIdentity, updateMember, recoverMember, archiveMember, joinWorkspace, leaveWorkspace, loadModels, openMemberSession }: TeamSidebarProps) {
  const navigationState = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot)
  const workspaces = useWorkspaces(state => state.items)
  const selected = navigationState.workspaceId
  const selectedExists = selected !== undefined && workspaces.some(workspace => workspace.workspaceId === selected)
  const selectedId = selectedExists ? selected : workspaces[0]?.workspaceId
  // Exactly one sidebar row carries aria-current='page': the open Project, else the selected Agent card while a Member Session
  // view is open, else the Workspace overview. The Inbox card takes the marker while the Inbox page stands, but not while an
  // embedded Member Session covers it (the Inbox stays the remembered face underneath).
  const overviewIsCurrent = navigationState.projectRef === undefined && navigationState.memberSessionId === undefined && navigationState.inbox !== true
  const inboxIsCurrent = navigationState.inbox === true && navigationState.memberSessionId === undefined
  const boardIsCurrent = navigationState.board === true && navigationState.memberSessionId === undefined
  const [creatingAgents, setCreatingAgents] = useState<readonly AgentTeamAddMemberRequest[]>([])
  // Rail icons request expansion and name the section to reveal once wide.
  const [pendingSection, setPendingSection] = useState<SidebarSection>()
  const projectsRef = useRef<HTMLDivElement>(null)
  const agentsRef = useRef<HTMLDivElement>(null)
  // One scope-less subscription re-pulls each Workspace's unread total (limit 1) on every wake; same-burst wakes coalesce behind a short debounce.
  const [inboxTotal, setInboxTotal] = useState(0)
  // Kept across failed refreshes so the badge never folds an unread read into zero.
  const keptTotalsRef = useRef(new Map<string, number>())
  // The rail repeats it as the hover hint, the only place a reader meets the quantity without opening the page.
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
      const totals = mergeInboxTotals(results, keptTotalsRef.current)
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
    // Reads change no shared projection, so no changes wake fires; refresh the badge from every completed read.
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
    const node = pendingSection === 'agents' ? agentsRef.current : projectsRef.current
    setPendingSection(undefined)
    queueMicrotask(() => { node?.querySelector<HTMLButtonElement>('button')?.focus() })
  }, [wide, pendingSection])

  if (!wide) {
    return <nav className={css.railWorkspace} aria-label={t('workspaceSections')}>
      <Tooltip label={t('backToConversations')} side="right">
        <button type="button" className={css.railButton} aria-label={t('backToConversations')} data-team-action="leave" onClick={leaveTeam}>
          <IconChevronLeftOutlineRegular size={18} />
        </button>
      </Tooltip>
      <Tooltip label={inboxLabel} side="right">
        <button type="button" className={css.railButton} aria-label={inboxLabel} aria-current={inboxIsCurrent ? 'page' : undefined} onClick={() => { selectInbox(); expandSidebar() }}>
          <InboxMark unread={inboxTotal} />
        </button>
      </Tooltip>
      <Tooltip label={t('projects')} side="right">
        <button type="button" className={css.railButton} aria-label={t('projects')} onClick={() => { setPendingSection('projects'); expandSidebar() }}>
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
    {/* Takes the New Session bar's slot, which the mode hides: directly under the shell's brand row in the same 38px slab. */}
    <button type="button" className={css.leaveCard} aria-label={t('backToConversations')} data-team-action="leave" onClick={leaveTeam}>
      <span className={css.leaveCardGroup}>
        <IconChevronLeftOutlineMedium size={14} className={css.leaveCardGlyph} />
        <span className={css.leaveCardLabel}>{t('backToConversations')}</span>
      </span>
    </button>
    {/* The Inbox crosses Workspaces, so it stands above the selector rather than inside its scope. */}
    <button type="button" className={css.inboxCard} aria-label={inboxLabel} aria-current={inboxIsCurrent ? 'page' : undefined} onClick={selectInbox}>
      <InboxMark unread={inboxTotal} />
      <span className={css.inboxCardLabel}>{t('inboxTitle')}</span>
    </button>
    <button type="button" className={css.taskBoardCard} aria-label={t('taskBoard')} aria-current={boardIsCurrent ? 'page' : undefined} onClick={selectBoard}><InboxMark unread={0} /><span className={css.inboxCardLabel}>{t('taskBoard')}</span></button>
    <TeamWorkspaceSelector workspaces={workspaces} selectedId={selectedId} current={overviewIsCurrent} onSelect={selectWorkspace} t={t} />
    {selectedId !== undefined && <div className={css.workspaceSection}>
      <div ref={projectsRef}>
        <TeamProjectsPanel key={selectedId} workspaceId={selectedId} loadMembers={loadMembers} loadProjects={loadProjects} subscribeChanges={subscribeChanges} createProject={createProject} updateProject={updateProject} archiveProject={archiveProject} addProjectOwner={addProjectOwner} removeProjectOwner={removeProjectOwner} humanIdentity={humanIdentity} creatingAgents={creatingAgents.filter(request => request.workspaceId === selectedId)} {...(navigationState.memberSessionId !== undefined || navigationState.projectRef === undefined ? {} : { selectedProjectRef: navigationState.projectRef })} selectProject={selectProject} t={t} />
      </div>
      <div ref={agentsRef}>
        <TeamAgentsPanel key={selectedId} workspaceId={selectedId} loadMembers={loadMembers} subscribeChanges={subscribeChanges} addMember={addMember} updateMember={updateMember} recoverMember={recoverMember} archiveMember={archiveMember} joinWorkspace={joinWorkspace} leaveWorkspace={leaveWorkspace} loadModels={loadModels} {...(navigationState.memberSessionId === undefined ? {} : { memberSessionId: navigationState.memberSessionId })} openMemberSession={openMemberSession} onCreatingChange={(request, creating) => { setCreatingAgents(current => creating ? [...current.filter(item => item.requestId !== request.requestId), request] : current.filter(item => item.requestId !== request.requestId)) }} t={t} />
      </div>
    </div>}
  </section>
}
