import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamClientMemberStatus,
  AgentTeamModelSelection,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconArchiveOutlineRegular, IconEditOutlineRegular, IconPlayOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular, Input, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamSidebarProps } from './slots.ts'
import { TeamMemberIdentity } from './TeamMemberRow.tsx'
import { SortableRow, useSidebarRowDrag } from './sidebar-drag.tsx'
import { moveSidebarItem, useSidebarOrder } from './sidebar-order.ts'
import { useSidebarSectionOpen, setSidebarSectionOpen } from './sidebar-sections.ts'
import { mintRequestId } from './requests.ts'
import { diagnosticText, restartOffered } from './TeamPresenceDot.tsx'
import { TeamRowMenu } from './TeamRowMenu.tsx'
import { TeamSidebarSection } from './TeamSidebarSection.tsx'
import { AgentEditorDialog, ModelPickerField, sameModel, warmModelCatalog } from './TeamMemberEditor.tsx'
import { TeamAgentImport } from './TeamAgentImport.tsx'
import createCss from './create.module.css'
import css from './sidebar.module.css'

interface TeamAgentsPanelProps {  readonly workspaceId: WorkspaceId
  readonly loadMembers: TeamSidebarProps['loadMembers']
  readonly subscribeChanges: TeamSidebarProps['subscribeChanges']
  readonly addMember: TeamSidebarProps['addMember']
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly recoverMember: TeamSidebarProps['recoverMember']
  readonly archiveMember: TeamSidebarProps['archiveMember']
  readonly joinWorkspace: TeamSidebarProps['joinWorkspace']
  readonly leaveWorkspace: TeamSidebarProps['leaveWorkspace']
  readonly loadModels: TeamSidebarProps['loadModels']
  /** Member detail's reminder surface: read the Member's own reminders, withdraw one on its behalf. */
  readonly loadMemberReminders: TeamSidebarProps['loadMemberReminders']
  readonly cancelMemberReminder: TeamSidebarProps['cancelMemberReminder']
  /** Member detail's Worker surface: the Member's runs and the Human's stop of one. */
  readonly loadWorkerRuns: TeamSidebarProps['loadWorkerRuns']
  readonly stopWorker: TeamSidebarProps['stopWorker']
  readonly inspectWorker: TeamSidebarProps['inspectWorker']
  readonly memberSessionId?: AgentTeamClientMemberStatus['member']['sessionId']
  readonly openMemberSession: TeamSidebarProps['openMemberSession']
  readonly onCreatingChange: (request: AgentTeamAddMemberRequest, creating: boolean) => void
  readonly t: TeamSidebarProps['t']
}

type MemberSessionId = AgentTeamClientMemberStatus['member']['sessionId']

type RolloverFollow =
  | { readonly kind: 'idle' }
  | { readonly kind: 'pending'; readonly previousSessionId: MemberSessionId; readonly nextSessionId: MemberSessionId }
  | { readonly kind: 'followed'; readonly nextSessionId: MemberSessionId }

/**
 * Follow a Host-initiated Session swap exactly once. The panel follows only once the refreshed status is active, so the
 * commit window never redirects to a Session that does not exist. The seat must still show the previous Session at
 * completion; navigating away first cancels the follow.
 */
function useMemberSessionFollow(
  seatSessionId: MemberSessionId | undefined,
  openMemberSession: TeamSidebarProps['openMemberSession'],
): (statuses: readonly AgentTeamClientMemberStatus[]) => void {
  const observed = useRef(new Map<string, MemberSessionId>())
  const follows = useRef(new Map<string, RolloverFollow>())
  // Refs, so the follow decision reads the live value even through a refresh closure captured before the seat rebinds.
  const seatRef = useRef(seatSessionId)
  seatRef.current = seatSessionId
  const openRef = useRef(openMemberSession)
  openRef.current = openMemberSession
  return useCallback((statuses: readonly AgentTeamClientMemberStatus[]) => {
    for (const status of statuses) {
      const memberId = status.member.memberId
      const current = status.member.sessionId
      const previous = observed.current.get(memberId)
      if (previous === undefined) {
        observed.current.set(memberId, current)
        continue
      }
      if (previous !== current) {
        observed.current.set(memberId, current)
        // Only the exact previous live page arms a follow. A binding change seen before any page is embedded is still recorded as the baseline.
        const seat = seatRef.current
        follows.current.set(memberId, seat !== undefined && previous === seat
          ? { kind: 'pending', previousSessionId: previous, nextSessionId: current }
          : { kind: 'idle' })
      }
      const follow = follows.current.get(memberId)
      if (follow?.kind === 'pending' && follow.nextSessionId === current && status.availability === 'active') {
        const seat = seatRef.current
        follows.current.set(memberId, { kind: 'followed', nextSessionId: current })
        if (seat !== undefined && seat === follow.previousSessionId) openRef.current(follow.nextSessionId)
      }
    }
  }, [])
}

export function TeamAgentsPanel({ workspaceId, loadMembers, subscribeChanges, addMember, updateMember, recoverMember, archiveMember, joinWorkspace, leaveWorkspace, loadModels, loadMemberReminders, cancelMemberReminder, loadWorkerRuns, stopWorker, inspectWorker, memberSessionId, openMemberSession, onCreatingChange, t }: TeamAgentsPanelProps) {
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [savedRefreshFailed, setSavedRefreshFailed] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [handle, setHandle] = useState('')
  const [description, setDescription] = useState('')
  const [model, setModel] = useState<AgentTeamModelSelection | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [retryRequest, setRetryRequest] = useState<AgentTeamAddMemberRequest>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const agentRefs = useMemo(() => members.map(status => status.member.memberId), [members])
  const orderedAgentRefs = useSidebarOrder(workspaceId, 'agents', agentRefs)
  const orderedMembers = useMemo(() => {
    const byId = new Map(members.map(status => [status.member.memberId, status]))
    return orderedAgentRefs.map(memberId => byId.get(memberId)).filter(status => status !== undefined)
  }, [orderedAgentRefs, members])
  const applyMove = (movedRef: typeof agentRefs[number], targetRef: typeof agentRefs[number], marker: 'before' | 'after'): void => {
    void moveSidebarItem(workspaceId, 'agents', orderedAgentRefs, movedRef, targetRef, marker)
  }
  const drag = useSidebarRowDrag({ refs: orderedAgentRefs, onCommit: applyMove })
  const sectionOpen = useSidebarSectionOpen(workspaceId, 'agents')
  const followRollover = useMemberSessionFollow(memberSessionId, openMemberSession)

  const loadedRef = useRef(false)
  const mountedRef = useRef(false)
  const editAwaitingRefresh = useRef(false)
  // Workspace and presence wakes can overlap; only the newest issuance may update the roster or its error.
  const refreshSequenceRef = useRef(0)
  const refresh = useCallback(async () => {
    const sequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = sequence
    if (!loadedRef.current) setLoading(true)
    try {
      const result = await loadMembers({ workspaceId })
      // A panel the user already left changes nothing; the key-remounted successor owns the roster state now.
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return
      if (result.ok) {
        const next = result.value.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived')
        setMembers(next)
        followRollover(next)
        setError(undefined)
        setSavedRefreshFailed(false)
        editAwaitingRefresh.current = false
        loadedRef.current = true
      } else {
        setError(result.error.message)
        setSavedRefreshFailed(editAwaitingRefresh.current)
      }
    } catch (cause) {
      if (mountedRef.current && sequence === refreshSequenceRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
        setSavedRefreshFailed(editAwaitingRefresh.current)
      }
    } finally {
      if (mountedRef.current && sequence === refreshSequenceRef.current) setLoading(false)
    }
  }, [loadMembers, workspaceId, followRollover])
  const refreshAfterCommit = useCallback(() => {
    editAwaitingRefresh.current = true
    return refresh()
  }, [refresh])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      refreshSequenceRef.current += 1
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  // Mount-scoped, not per refresh: presence wakes must not refetch the catalog.
  useEffect(() => { warmModelCatalog(loadModels) }, [loadModels])
  useEffect(() => subscribeChanges({ kind: 'workspace', workspaceId }, update => {
    if (update.type === 'failed') {
      setError(update.message)
      setSavedRefreshFailed(editAwaitingRefresh.current)
      return
    }
    void refresh()
  }), [subscribeChanges, refresh, workspaceId])
  // Presence commits nothing and wakes only this scope, so dots stay live without a catalog refetch.
  useEffect(() => subscribeChanges({ kind: 'presence', workspaceId }, update => {
    if (update.type === 'failed') {
      setError(update.message)
      setSavedRefreshFailed(editAwaitingRefresh.current)
      return
    }
    void refresh()
  }), [subscribeChanges, refresh, workspaceId])

  const closeForm = () => {
    if (creating) return
    setFormOpen(false)
    queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const provision = async (request: AgentTeamAddMemberRequest) => {
    setCreating(true)
    onCreatingChange(request, true)
    setError(undefined)
    setSavedRefreshFailed(false)
    setRetryRequest(request)
    try {
      const result = await addMember(request)
      if (result.ok) {
        const committed = { ...result.value.status, workspaceIds: result.value.workspaceIds }
        setMembers(current => {
          const retained = current.filter(status => status.member.memberId !== committed.member.memberId)
          return committed.member.state === 'inactive' || committed.member.state === 'archived' ? retained : [...retained, committed]
        })
        setHandle('')
        setDescription('')
        setModel(undefined)
        setFormOpen(false)
        if (result.value.status.presence === 'unavailable') {
          setError(diagnosticText(result.value.status) || t('statusUnavailable'))
        } else {
          setRetryRequest(undefined)
        }
        queueMicrotask(() => { triggerRef.current?.focus() })
      } else {
        await refresh()
        setError(result.error.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
      onCreatingChange(request, false)
    }
  }

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedHandle = handle.trim()
    const normalizedDescription = description.trim()
    // The Host requires an explicit route at creation, so the form refuses to submit without one.
    if (normalizedHandle.length === 0 || model === undefined || creating) return
    const sameRequest = retryRequest !== undefined && retryRequest.workspaceId === workspaceId
      && retryRequest.handle === normalizedHandle && retryRequest.description === normalizedDescription
      && sameModel(retryRequest.model, model)
      && retryRequest.projectRefs.length === 0
    void provision(sameRequest ? retryRequest : {
      requestId: mintRequestId(),
      workspaceId,
      handle: normalizedHandle,
      description: normalizedDescription,
      presetId: 'team-member',
      // No initial Projects: the Member joins later from the Project side, reachable through its DM view meanwhile.
      projectRefs: [],
      model,
    })
  }

  // `members` is empty both before the first successful load and after a failed
  // one, so claiming the roster is empty additionally requires a clear error.
  const showEmptyRoster = !loading && error === undefined && members.length === 0

  return (
    <div className={css.panel}>
      <Modal
        open={formOpen}
        onClose={closeForm}
        title={t('addAgent')}
        closeLabel={t('close')}
        contentClassName={createCss.dialogContent!}
        footer={<><Button variant="outline" disabled={creating} onClick={closeForm}>{t('cancel')}</Button>{!importing && <Button type="submit" form="team-agent-create-form" variant="primary" disabled={creating || handle.trim().length === 0 || model === undefined}>{creating ? t('creatingAgent') : t('createAgent')}</Button>}</>}
      >
        <Button className={createCss.modeSwitch!} variant="outline" disabled={creating} aria-expanded={importing} onClick={() => { setImporting(value => !value); setError(undefined) }}>{importing ? t('createAgent') : t('importAgentTitle')}</Button>
        {formOpen && importing ? <TeamAgentImport workspaceId={workspaceId} loadMembers={loadMembers} joinWorkspace={joinWorkspace} onPending={setCreating} onJoined={async () => { await refresh(); setFormOpen(false); queueMicrotask(() => { triggerRef.current?.focus() }) }} t={t} /> : <form id="team-agent-create-form" className={createCss.form} onSubmit={submit}>
          <label className={createCss.field}>
            <span>{t('agentName')}</span>
            <Input className={createCss.input!} value={handle} onChange={event => { setHandle(event.target.value); setRetryRequest(undefined) }} disabled={creating} autoFocus />
          </label>
          <label className={createCss.field}>
            <span>{t('agentDescription')}{t('optionalSuffix')}</span>
            <Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} onChange={event => { setDescription(event.target.value); setRetryRequest(undefined) }} disabled={creating} />
          </label>
          <ModelPickerField model={model} onModelChange={choice => { setModel(choice); setRetryRequest(undefined) }} loadModels={loadModels} disabled={creating} t={t} />
          {formOpen && error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
        </form>}
      </Modal>
      <TeamSidebarSection
        title={t('agents')}
        open={sectionOpen}
        onToggle={open => { setSidebarSectionOpen(workspaceId, 'agents', open) }}
        actions={(
          <Tooltip label={t('addAgent')} delayMs={500}>
            <button ref={triggerRef} type="button" className={css.iconButton} aria-label={t('addAgent')} onClick={() => { setError(undefined); setSavedRefreshFailed(false); setImporting(false); setFormOpen(true) }}>
              <IconPlusOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
      >
        {loading && members.length === 0 && <p className={css.emptyState}>{t('loadingAgents')}</p>}
        {showEmptyRoster && <p className={css.emptyState}>{t('emptyAgents')}</p>}
        <div className={css.agentList}>
          {orderedMembers.map(status => (
            <SortableRow key={status.member.memberId} drag={drag} orderKey={status.member.memberId}>
              <AgentRow workspaceId={workspaceId} leaveWorkspace={leaveWorkspace} status={status} {...(memberSessionId === undefined ? {} : { current: status.member.sessionId === memberSessionId })} updateMember={updateMember} recoverMember={recoverMember} archiveMember={archiveMember} loadModels={loadModels} loadMemberReminders={loadMemberReminders} cancelMemberReminder={cancelMemberReminder} loadWorkerRuns={loadWorkerRuns} stopWorker={stopWorker} inspectWorker={inspectWorker} openMemberSession={openMemberSession} onUpdated={refresh} onEditCommitted={refreshAfterCommit} t={t} />
            </SortableRow>
          ))}
        </div>
      </TeamSidebarSection>
      {!formOpen && error !== undefined && (
        <div className={css.retryError} role="alert">
          <span>{savedRefreshFailed ? t('editSavedRefreshFailed', { message: error }) : error}</span>
          <button type="button" className={css.textButton} disabled={creating} onClick={() => {
            if (savedRefreshFailed || retryRequest === undefined) void refresh()
            else setFormOpen(true)
          }}>{savedRefreshFailed ? t('editRefreshRetry') : t('retry')}</button>
        </div>
      )}
    </div>
  )
}

function AgentRow({ workspaceId, leaveWorkspace, status, current, updateMember, recoverMember, archiveMember, loadModels, loadMemberReminders, cancelMemberReminder, loadWorkerRuns, stopWorker, inspectWorker, openMemberSession, onUpdated, onEditCommitted, t }: {
  readonly workspaceId: WorkspaceId
  readonly leaveWorkspace: TeamSidebarProps['leaveWorkspace']
  readonly status: AgentTeamClientMemberStatus
  /** This Member's Session is the one embedded in the conversation seat. */
  readonly current?: boolean
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly recoverMember: TeamSidebarProps['recoverMember']
  readonly archiveMember: TeamSidebarProps['archiveMember']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly loadMemberReminders: TeamSidebarProps['loadMemberReminders']
  readonly cancelMemberReminder: TeamSidebarProps['cancelMemberReminder']
  readonly loadWorkerRuns: TeamSidebarProps['loadWorkerRuns']
  readonly stopWorker: TeamSidebarProps['stopWorker']
  readonly inspectWorker: TeamSidebarProps['inspectWorker']
  readonly openMemberSession: TeamSidebarProps['openMemberSession']
  readonly onUpdated: () => Promise<void> | void
  readonly onEditCommitted: () => Promise<void> | void
  readonly t: TeamSidebarProps['t']
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [rowAlert, setRowAlert] = useState<string>()
  const [archivePending, setArchivePending] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const selectRef = useRef<HTMLButtonElement>(null)
  const archiveRequest = useRef<ReturnType<typeof mintRequestId>>()
  const withdrawing = workspaceId !== status.member.workspaceId
  // The Host steers a live session, rebuilds an orphaned composition, or re-runs a failed activation.
  const recover = async (): Promise<void> => {
    try {
      const result = await recoverMember({
        requestId: mintRequestId(),
        workspaceId: status.member.workspaceId,
        memberId: status.member.memberId,
      })
      await onUpdated()
      if (!result.ok) {
        setRowAlert(t('restartFailed', { message: result.error.message }))
        return
      }
      if (result.value.status.availability === 'unavailable') {
        setRowAlert(t('restartStillUnavailable', { diagnostic: diagnosticText(result.value.status) || t('statusUnavailable') }))
        return
      }
      setRowAlert(undefined)
      // A page opened while the Member was down predates the live Session;
      // re-selecting is a no-op when already bound and rebinds when stale.
      if (current === true) openMemberSession(status.member.sessionId)
    } catch (cause) {
      setRowAlert(t('restartFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }
  const archive = async (): Promise<void> => {
    if (archivePending) return
    setArchivePending(true)
    setRowAlert(undefined)
    archiveRequest.current ??= mintRequestId()
    const request = { requestId: archiveRequest.current, memberId: status.member.memberId }
    try {
      const result = withdrawing ? await leaveWorkspace({ ...request, workspaceId }) : await archiveMember(request)
      if (!result.ok) throw new Error(result.error.message)
      setArchiving(false)
      archiveRequest.current = undefined
      await onUpdated()
    } catch (cause) {
      setRowAlert(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setArchivePending(false)
    }
  }
  return (
    <>
      <div ref={rowRef} tabIndex={-1} className={css.agentRow} data-agent-row data-menu-open={menuOpen || undefined}>
        <button ref={selectRef} type="button" className={css.agentSelect} aria-label={t('openAgentSession', { name: status.member.handle })} aria-current={current ? 'page' : undefined} disabled={status.availability !== 'active'} onClick={() => {
          // The message below belongs to the attempt that produced it: a later click that opens must not leave it behind.
          setRowAlert(undefined)
          openMemberSession(status.member.sessionId, message => {
            setRowAlert(t('openAgentSessionFailed', { name: status.member.handle.replace(/^@/, ''), message }))
          })
        }}>
          <TeamMemberIdentity status={status} name={status.member.handle.replace(/^@/, '')} className={css.agentCopy} t={t} />
        </button>
        <span className={css.rowMenu}>
          <TeamRowMenu
            label={t('actionsAgent', { name: status.member.handle })}
            items={[
              { id: 'edit', label: t('editAgent'), icon: <IconEditOutlineRegular /> },
              ...(status.presence === 'error' ? [{ id: 'resume', label: t('resumeAgent'), icon: <IconPlayOutlineRegular /> }] : []),
              ...(status.availability === 'unavailable' && restartOffered(status) ? [{ id: 'restart', label: t('restartAgent'), icon: <IconRefreshOutlineRegular /> }] : []),
              { id: 'archive', label: t(withdrawing ? 'withdrawAgent' : 'archiveAgent'), icon: <IconArchiveOutlineRegular size={16} />, danger: true },
            ]}
            onSelect={(id) => {
              if (id === 'edit') {
                // The menu item disappears; the modal needs a persistent return target.
                const target = selectRef.current?.disabled === true ? rowRef.current : selectRef.current
                target?.focus({ preventScroll: true })
                setEditing(true)
              } else if (id === 'archive') setArchiving(true)
              else void recover()
            }}
            onOpenChange={setMenuOpen}
          />
        </span>
      </div>
      {!archiving && rowAlert !== undefined && <div className={css.rowAlert} role="alert">{rowAlert}</div>}
      {archiving && (
        <Modal
          open
          onClose={() => { if (!archivePending) setArchiving(false) }}
          title={t(withdrawing ? 'withdrawAgentTitle' : 'archiveAgentTitle', { name: status.member.handle })}
          closeLabel={t('close')}
          contentClassName={createCss.dialogContent!}
          footer={<>
            <Button variant="outline" disabled={archivePending} onClick={() => { setArchiving(false) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={archivePending} onClick={() => { void archive() }}>{t(withdrawing ? 'withdrawAgent' : 'archiveAgentConfirm')}</Button>
          </>}
        >
          <p className={createCss.error}>{t(withdrawing ? 'withdrawAgentNotice' : 'archiveAgentNotice', { name: status.member.handle })}</p>
          {!withdrawing && status.workspaceIds.length > 1 && <p>{t('archiveOtherWorkspaces', { count: status.workspaceIds.length - 1 })}</p>}
          {rowAlert !== undefined && <p className={createCss.error} role="alert">{rowAlert}</p>}
        </Modal>
      )}
      {editing && (
        <AgentEditorDialog
          status={status}
          updateMember={updateMember}
          loadModels={loadModels}
          loadMemberReminders={loadMemberReminders}
          cancelMemberReminder={cancelMemberReminder}
          loadWorkerRuns={loadWorkerRuns}
          stopWorker={stopWorker}
          inspectWorker={inspectWorker}
          onCommitted={onEditCommitted}
          onClose={() => { setEditing(false) }}
          t={t}
        />
      )}
    </>
  )
}
