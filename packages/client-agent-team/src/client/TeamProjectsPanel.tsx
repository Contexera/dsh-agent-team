import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamProject,
  AgentTeamProjectRef,
  AgentTeamClientMemberStatus,
  AgentTeamCreateProjectRequest,
  AgentTeamMemberId,
  AgentTeamView,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconArchiveOutlineRegular, IconEditOutlineRegular, IconPlusOutlineRegular, Input, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamSidebarProps } from './slots.ts'
import { TeamPresenceDot } from './TeamPresenceDot.tsx'
import { MultiMenuField } from './multi-menu-field.tsx'
import { SortableRow, useSidebarRowDrag } from './sidebar-drag.tsx'
import { moveSidebarItem, useSidebarOrder } from './sidebar-order.ts'
import { useSidebarSectionOpen, setSidebarSectionOpen } from './sidebar-sections.ts'
import { mintRequestId } from './requests.ts'
import { TeamProjectOwners } from './TeamProjectOwners.tsx'
import { TeamRowMenu } from './TeamRowMenu.tsx'
import { TeamSidebarSection } from './TeamSidebarSection.tsx'
import { useEditDialogSave } from './team-dialog-save.ts'
import createCss from './create.module.css'
import css from './sidebar.module.css'

interface TeamProjectsPanelProps {
  readonly workspaceId: WorkspaceId
  readonly loadMembers: TeamSidebarProps['loadMembers']
  readonly loadProjects: TeamSidebarProps['loadProjects']
  readonly subscribeChanges: TeamSidebarProps['subscribeChanges']
  readonly createProject: TeamSidebarProps['createProject']
  readonly updateProject: TeamSidebarProps['updateProject']
  readonly archiveProject: TeamSidebarProps['archiveProject']
  readonly addProjectOwner: TeamSidebarProps['addProjectOwner']
  readonly removeProjectOwner: TeamSidebarProps['removeProjectOwner']
  readonly humanIdentity: TeamSidebarProps['humanIdentity']
  readonly creatingAgents: readonly AgentTeamAddMemberRequest[]
  readonly selectedProjectRef?: AgentTeamProjectRef
  readonly selectProject: TeamSidebarProps['selectProject']
  readonly t: TeamSidebarProps['t']
}

export function TeamProjectsPanel(props: TeamProjectsPanelProps) {
  const { workspaceId, loadMembers, loadProjects, subscribeChanges, createProject, updateProject, creatingAgents, selectedProjectRef, selectProject, t } = props
  const [view, setView] = useState<AgentTeamView>()
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<AgentTeamMemberId>>(new Set())
  const [mutating, setMutating] = useState(false)
  const [pendingCreate, setPendingCreate] = useState<AgentTeamCreateProjectRequest>()
  const previousCreatingKey = useRef(creatingAgents.map(request => request.requestId).join(','))
  const triggerRef = useRef<HTMLButtonElement>(null)
  const projectRefs = useMemo(() => view?.projects.map(project => project.projectRef) ?? [], [view])
  const orderedProjectRefs = useSidebarOrder(workspaceId, 'projects', projectRefs)
  const orderedProjects = useMemo(() => {
    const byRef = new Map((view?.projects ?? []).map(project => [project.projectRef, project]))
    return orderedProjectRefs.map(projectRef => byRef.get(projectRef)).filter(project => project !== undefined)
  }, [orderedProjectRefs, view])
  const applyMove = (movedRef: AgentTeamProjectRef, targetRef: AgentTeamProjectRef, marker: 'before' | 'after'): void => {
    void moveSidebarItem(workspaceId, 'projects', orderedProjectRefs, movedRef, targetRef, marker)
  }
  const drag = useSidebarRowDrag({ refs: orderedProjectRefs, onCommit: applyMove })
  const sectionOpen = useSidebarSectionOpen(workspaceId, 'projects')

  const loadedRef = useRef(false)
  const mountedRef = useRef(false)
  // Three wake sources can overlap; only the newest issuance applies.
  const refreshSequenceRef = useRef(0)
  const refresh = useCallback(async () => {
    const sequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = sequence
    if (!loadedRef.current) setLoading(true)
    const [projectResult, memberResult] = await Promise.all([
      loadProjects({ workspaceId, limit: 1 }),
      loadMembers({ workspaceId }),
    ])
    // A panel the user already left changes nothing; the key-remounted successor owns the state.
    if (!mountedRef.current || sequence !== refreshSequenceRef.current) return
    // The roster and catalog legs have independent freshness; one leg's failure must not freeze the other's landed value.
    if (projectResult.ok) {
      setView(projectResult.value)
      loadedRef.current = true
    }
    if (memberResult.ok) {
      const visibleMembers = memberResult.value.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived')
      setMembers(visibleMembers)
      const selectable = new Set(visibleMembers.filter(status => status.presence !== 'unavailable')
        .map(status => status.member.memberId))
      setSelected(current => new Set([...current].filter(memberId => selectable.has(memberId))))
    }
    if (!projectResult.ok) setError(projectResult.error.message)
    else if (!memberResult.ok) setError(memberResult.error.message)
    else setError(undefined)
    setLoading(false)
  }, [loadProjects, loadMembers, workspaceId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      refreshSequenceRef.current += 1
    }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => subscribeChanges({ kind: 'workspace', workspaceId }, update => {
    if (update.type === 'failed') {
      setError(update.message)
      return
    }
    void refresh()
  }), [subscribeChanges, refresh, workspaceId])
  const creatingKey = creatingAgents.map(request => request.requestId).join(',')
  useEffect(() => {
    if (previousCreatingKey.current === creatingKey) return
    previousCreatingKey.current = creatingKey
    void refresh()
  }, [creatingKey, refresh])

  const membership = useMemo(() => {
    const byProject = new Map<AgentTeamProjectRef, Set<AgentTeamMemberId>>()
    for (const item of view?.members ?? []) {
      const ids = byProject.get(item.projectRef) ?? new Set<AgentTeamMemberId>()
      ids.add(item.memberId)
      byProject.set(item.projectRef, ids)
    }
    return byProject
  }, [view])

  const ownership = useMemo(() => {
    const byProject = new Map<AgentTeamProjectRef, Set<AgentTeamMemberId>>()
    for (const item of view?.owners ?? []) {
      const ids = byProject.get(item.projectRef) ?? new Set<AgentTeamMemberId>()
      ids.add(item.memberId)
      byProject.set(item.projectRef, ids)
    }
    return byProject
  }, [view])

  const closeForm = () => {
    if (mutating) return
    setFormOpen(false)
    queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (mutating || name.trim() === '') return
    const payload = { workspaceId, name: name.trim(), description: description.trim(), memberIds: [...selected] }
    const samePending = pendingCreate !== undefined && pendingCreate.workspaceId === payload.workspaceId
      && pendingCreate.name === payload.name && pendingCreate.description === payload.description
      && JSON.stringify(pendingCreate.memberIds) === JSON.stringify(payload.memberIds)
    const request: AgentTeamCreateProjectRequest = samePending ? pendingCreate : {
      requestId: mintRequestId(), ...payload,
    }
    setPendingCreate(request)
    setMutating(true)
    setError(undefined)
    try {
      const result = await createProject(request)
      if (result.ok) {
        setPendingCreate(undefined)
        setName('')
        setDescription('')
        setSelected(new Set())
        setFormOpen(false)
        await refresh()
        queueMicrotask(() => { triggerRef.current?.focus() })
      } else {
        setError(result.error.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMutating(false)
    }
  }

  return (
    <div className={css.panel}>
      <Modal
        open={formOpen}
        onClose={closeForm}
        title={t('addProject')}
        closeLabel={t('close')}
        contentClassName={createCss.dialogContent!}
        footer={<><Button variant="outline" disabled={mutating} onClick={closeForm}>{t('cancel')}</Button><Button type="submit" form="team-project-create-form" variant="primary" disabled={mutating || name.trim() === ''}>{mutating ? t('creatingProject') : t('createProject')}</Button></>}
      >
        <form id="team-project-create-form" className={createCss.form} onSubmit={event => { void submit(event) }}>
          <label className={createCss.field}><span>{t('projectName')}</span><Input className={createCss.input!} value={name} disabled={mutating} autoFocus onChange={event => { setName(event.target.value); setPendingCreate(undefined) }} /></label>
          <label className={createCss.field}><span>{t('projectDescription')}{t('optionalSuffix')}</span><Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} disabled={mutating} onChange={event => { setDescription(event.target.value); setPendingCreate(undefined) }} /></label>
          <MultiMenuField label={t('initialMembers')} disabled={mutating}
            options={[
              ...creatingAgents.map(request => ({ id: request.requestId, label: request.handle, disabled: true, hint: t('memberCreatingReason') })),
              ...members.map(status => ({
                id: status.member.memberId,
                label: status.member.handle,
                ...(status.presence === 'unavailable' ? { disabled: true, hint: t('memberUnavailableReason') } : {}),
                icon: <TeamPresenceDot status={status} t={t} />,
              })),
            ]}
            selected={[...selected]}
            onToggle={id => {
              setSelected(current => {
                const next = new Set(current)
                if (next.has(id)) next.delete(id); else next.add(id)
                return next
              })
              setPendingCreate(undefined)
            }}
            triggerEmptyLabel={t('membersPickerEmpty')}
            formatCount={count => t('membersPickerCount', { count })} />
          {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
        </form>
      </Modal>
      <TeamSidebarSection
        title={t('projects')}
        open={sectionOpen}
        onToggle={open => { setSidebarSectionOpen(workspaceId, 'projects', open) }}
        actions={(
          <Tooltip label={t('addProject')} delayMs={500}>
            <button ref={triggerRef} type="button" className={css.iconButton} aria-label={t('addProject')} onClick={() => { setError(undefined); setFormOpen(true) }}>
              <IconPlusOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
      >
        {loading && view === undefined && <p className={css.emptyState}>{t('loadingProjects')}</p>}
        {/* A standing error overrides the empty claim, so a failed load does not also read as "no projects yet". */}
        {!loading && error === undefined && view !== undefined && view.projects.length === 0 && <p className={css.emptyState}>{t('emptyProjects')}</p>}
        <div className={css.projectList}>
          {orderedProjects.map(project => {
            const joined = membership.get(project.projectRef) ?? new Set<AgentTeamMemberId>()
            return (
              <SortableRow key={project.projectRef} drag={drag} orderKey={project.projectRef}>
                <ProjectRow
                  project={project}
                  members={members}
                  joinedIds={joined}
                  ownerIds={ownership.get(project.projectRef) ?? new Set<AgentTeamMemberId>()}
                  addProjectOwner={props.addProjectOwner}
                  removeProjectOwner={props.removeProjectOwner}
                  humanIdentity={props.humanIdentity}
                  selected={selectedProjectRef === project.projectRef}
                  updateProject={updateProject}
                  archiveProject={props.archiveProject}
                  onCommitted={refresh}
                  selectProject={selectProject}
                  t={t}
                />
              </SortableRow>
            )
          })}
        </div>
      </TeamSidebarSection>
      {!formOpen && error !== undefined && <p className={css.error} role="alert">{error}</p>}
    </div>
  )
}

function ProjectRow({ project, members, joinedIds, ownerIds, addProjectOwner, removeProjectOwner, humanIdentity, selected, updateProject, archiveProject, onCommitted, selectProject, t }: {
  readonly project: AgentTeamProject
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly joinedIds: ReadonlySet<AgentTeamMemberId>
  readonly ownerIds: ReadonlySet<AgentTeamMemberId>
  readonly addProjectOwner: TeamSidebarProps['addProjectOwner']
  readonly removeProjectOwner: TeamSidebarProps['removeProjectOwner']
  readonly humanIdentity: TeamSidebarProps['humanIdentity']
  readonly selected: boolean
  readonly updateProject: TeamSidebarProps['updateProject']
  readonly archiveProject: TeamSidebarProps['archiveProject']
  readonly onCommitted: () => Promise<void> | void
  readonly selectProject: TeamSidebarProps['selectProject']
  readonly t: TeamSidebarProps['t']
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [rowAlert, setRowAlert] = useState<string>()
  const archive = async (): Promise<void> => {
    try {
      const result = await archiveProject({
        requestId: mintRequestId(),
        workspaceId: project.workspaceId,
        projectRef: project.projectRef,
      })
      await onCommitted()
      if (!result.ok) {
        setRowAlert(t('archiveProjectFailed', { message: result.error.message }))
      }
    } catch (cause) {
      setRowAlert(t('archiveProjectFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }
  return (
    <>
      <article className={css.projectRow} data-menu-open={menuOpen || undefined} aria-current={selected ? 'page' : undefined}>
        <button type="button" className={css.projectSelect} aria-label={`# ${project.name}`} onClick={() => { selectProject(project.projectRef) }}>
          <strong className={css.projectName}># {project.name}</strong>
        </button>
        <span className={css.rowMenu}>
          <TeamRowMenu
            label={t('actionsProject', { name: project.name })}
            items={[
              { id: 'edit', label: t('editProject'), icon: <IconEditOutlineRegular /> },
              { id: 'archive', label: t('archiveProject'), icon: <IconArchiveOutlineRegular size={16} />, danger: true },
            ]}
            onSelect={(id) => {
              if (id === 'edit') setEditing(true)
              else setArchiving(true)
            }}
            onOpenChange={setMenuOpen}
          />
        </span>
      </article>
      {rowAlert !== undefined && <div className={css.rowAlert} role="alert">{rowAlert}</div>}
      {archiving && (
        <Modal
          open
          onClose={() => { setArchiving(false) }}
          title={t('archiveProjectTitle', { name: project.name })}
          closeLabel={t('close')}
          contentClassName={createCss.dialogContent!}
          footer={<>
            <Button variant="outline" onClick={() => { setArchiving(false) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => { setArchiving(false); void archive() }}>{t('archiveProjectConfirm')}</Button>
          </>}
        >
          <p className={createCss.error}>{t('archiveProjectNotice', { name: project.name })}</p>
        </Modal>
      )}
      {editing && (
        <ProjectEditorDialog
          project={project}
          members={members}
          joinedIds={joinedIds}
          ownerIds={ownerIds}
          addProjectOwner={addProjectOwner}
          removeProjectOwner={removeProjectOwner}
          humanIdentity={humanIdentity}
          updateProject={updateProject}
          onCommitted={onCommitted}
          onClose={() => { setEditing(false) }}
          t={t}
        />
      )}
    </>
  )
}

/** Name and description commit through one durable update; membership keeps its own immediate add/remove flow. */
function ProjectEditorDialog({ project, members, ownerIds, addProjectOwner, removeProjectOwner, humanIdentity, updateProject, onCommitted, onClose, t }: {
  readonly project: AgentTeamProject
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly joinedIds: ReadonlySet<AgentTeamMemberId>
  readonly ownerIds: ReadonlySet<AgentTeamMemberId>
  readonly addProjectOwner: TeamSidebarProps['addProjectOwner']
  readonly removeProjectOwner: TeamSidebarProps['removeProjectOwner']
  readonly humanIdentity: TeamSidebarProps['humanIdentity']
  readonly updateProject: TeamSidebarProps['updateProject']
  readonly onCommitted: () => Promise<void> | void
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const { saving, error, save, invalidate } = useEditDialogSave({
    save: updateProject,
    onCommitted,
    onClose,
  })

  const dirty = name.trim() !== project.name || description.trim() !== project.description
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedName = name.trim()
    const normalizedDescription = description.trim()
    if (saving || !dirty || normalizedName === '') return
    await save(previous => previous !== undefined && previous.projectRef === project.projectRef
      && previous.name === normalizedName && previous.description === normalizedDescription ? previous : {
      requestId: mintRequestId(),
      workspaceId: project.workspaceId,
      projectRef: project.projectRef,
      name: normalizedName,
      description: normalizedDescription,
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('editProject')}
      description={`# ${project.name}`}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<><Button variant="outline" disabled={saving} onClick={onClose}>{t('cancel')}</Button><Button type="submit" form="team-project-edit-form" variant="primary" disabled={saving || !dirty || name.trim() === ''}>{saving ? t('editSaving') : t('editSave')}</Button></>}
    >
      <form id="team-project-edit-form" className={createCss.form} onSubmit={event => { void submit(event) }}>
        <label className={createCss.field}>
          <span>{t('projectName')}</span>
          <Input className={createCss.input!} value={name} onChange={event => { setName(event.target.value); invalidate() }} disabled={saving} autoFocus />
        </label>
        <label className={createCss.field}>
          <span>{t('projectDescription')}{t('optionalSuffix')}</span>
          <Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} onChange={event => { setDescription(event.target.value); invalidate() }} disabled={saving} />
        </label>
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </form>
      <TeamProjectOwners
        project={project}
        members={members}
        ownerIds={ownerIds}
        addProjectOwner={addProjectOwner}
        removeProjectOwner={removeProjectOwner}
        humanIdentity={humanIdentity}
        onCommitted={onCommitted}
        t={t}
      />
    </Modal>
  )
}
