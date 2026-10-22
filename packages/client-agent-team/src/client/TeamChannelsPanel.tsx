import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentTeamAddMemberRequest,
  AgentTeamChannel,
  AgentTeamChannelRef,
  AgentTeamClientMemberStatus,
  AgentTeamCreateChannelRequest,
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
import { TeamRowMenu } from './TeamRowMenu.tsx'
import { TeamSidebarSection } from './TeamSidebarSection.tsx'
import { useEditDialogSave } from './team-dialog-save.ts'
import createCss from './create.module.css'
import css from './sidebar.module.css'

interface TeamChannelsPanelProps {
  readonly workspaceId: WorkspaceId
  readonly loadMembers: TeamSidebarProps['loadMembers']
  readonly loadChannels: TeamSidebarProps['loadChannels']
  readonly subscribeChanges: TeamSidebarProps['subscribeChanges']
  readonly createChannel: TeamSidebarProps['createChannel']
  readonly updateChannel: TeamSidebarProps['updateChannel']
  readonly archiveChannel: TeamSidebarProps['archiveChannel']
  readonly creatingAgents: readonly AgentTeamAddMemberRequest[]
  readonly selectedChannelRef?: AgentTeamChannelRef
  readonly selectChannel: TeamSidebarProps['selectChannel']
  readonly t: TeamSidebarProps['t']
}

export function TeamChannelsPanel(props: TeamChannelsPanelProps) {
  const { workspaceId, loadMembers, loadChannels, subscribeChanges, createChannel, updateChannel, creatingAgents, selectedChannelRef, selectChannel, t } = props
  const [view, setView] = useState<AgentTeamView>()
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selected, setSelected] = useState<ReadonlySet<AgentTeamMemberId>>(new Set())
  const [mutating, setMutating] = useState(false)
  const [pendingCreate, setPendingCreate] = useState<AgentTeamCreateChannelRequest>()
  const previousCreatingKey = useRef(creatingAgents.map(request => request.requestId).join(','))
  const triggerRef = useRef<HTMLButtonElement>(null)
  const channelRefs = useMemo(() => view?.channels.map(channel => channel.channelRef) ?? [], [view])
  const orderedChannelRefs = useSidebarOrder(workspaceId, 'channels', channelRefs)
  const orderedChannels = useMemo(() => {
    const byRef = new Map((view?.channels ?? []).map(channel => [channel.channelRef, channel]))
    return orderedChannelRefs.map(channelRef => byRef.get(channelRef)).filter(channel => channel !== undefined)
  }, [orderedChannelRefs, view])
  const applyMove = (movedRef: AgentTeamChannelRef, targetRef: AgentTeamChannelRef, marker: 'before' | 'after'): void => {
    void moveSidebarItem(workspaceId, 'channels', orderedChannelRefs, movedRef, targetRef, marker)
  }
  const drag = useSidebarRowDrag({ refs: orderedChannelRefs, onCommit: applyMove })
  const sectionOpen = useSidebarSectionOpen(workspaceId, 'channels')

  const loadedRef = useRef(false)
  const mountedRef = useRef(false)
  // Three wake sources can overlap; only the newest issuance applies.
  const refreshSequenceRef = useRef(0)
  const refresh = useCallback(async () => {
    const sequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = sequence
    if (!loadedRef.current) setLoading(true)
    const [channelResult, memberResult] = await Promise.all([
      loadChannels({ workspaceId, limit: 1 }),
      loadMembers({ workspaceId }),
    ])
    // A panel the user already left changes nothing; the key-remounted successor owns the state.
    if (!mountedRef.current || sequence !== refreshSequenceRef.current) return
    // The roster and catalog legs have independent freshness; one leg's failure must not freeze the other's landed value.
    if (channelResult.ok) {
      setView(channelResult.value)
      loadedRef.current = true
    }
    if (memberResult.ok) {
      const visibleMembers = memberResult.value.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived')
      setMembers(visibleMembers)
      const selectable = new Set(visibleMembers.filter(status => status.presence !== 'unavailable')
        .map(status => status.member.memberId))
      setSelected(current => new Set([...current].filter(memberId => selectable.has(memberId))))
    }
    if (!channelResult.ok) setError(channelResult.error.message)
    else if (!memberResult.ok) setError(memberResult.error.message)
    else setError(undefined)
    setLoading(false)
  }, [loadChannels, loadMembers, workspaceId])

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
    const byChannel = new Map<AgentTeamChannelRef, Set<AgentTeamMemberId>>()
    for (const item of view?.members ?? []) {
      const ids = byChannel.get(item.channelRef) ?? new Set<AgentTeamMemberId>()
      ids.add(item.memberId)
      byChannel.set(item.channelRef, ids)
    }
    return byChannel
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
    const request: AgentTeamCreateChannelRequest = samePending ? pendingCreate : {
      requestId: mintRequestId(), ...payload,
    }
    setPendingCreate(request)
    setMutating(true)
    setError(undefined)
    try {
      const result = await createChannel(request)
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
        title={t('addChannel')}
        closeLabel={t('close')}
        contentClassName={createCss.dialogContent!}
        footer={<><Button variant="outline" disabled={mutating} onClick={closeForm}>{t('cancel')}</Button><Button type="submit" form="team-channel-create-form" variant="primary" disabled={mutating || name.trim() === ''}>{mutating ? t('creatingChannel') : t('createChannel')}</Button></>}
      >
        <form id="team-channel-create-form" className={createCss.form} onSubmit={event => { void submit(event) }}>
          <label className={createCss.field}><span>{t('channelName')}</span><Input className={createCss.input!} value={name} disabled={mutating} autoFocus onChange={event => { setName(event.target.value); setPendingCreate(undefined) }} /></label>
          <label className={createCss.field}><span>{t('channelDescription')}{t('optionalSuffix')}</span><Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} disabled={mutating} onChange={event => { setDescription(event.target.value); setPendingCreate(undefined) }} /></label>
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
        title={t('channels')}
        open={sectionOpen}
        onToggle={open => { setSidebarSectionOpen(workspaceId, 'channels', open) }}
        actions={(
          <Tooltip label={t('addChannel')} delayMs={500}>
            <button ref={triggerRef} type="button" className={css.iconButton} aria-label={t('addChannel')} onClick={() => { setError(undefined); setFormOpen(true) }}>
              <IconPlusOutlineRegular size={14} />
            </button>
          </Tooltip>
        )}
      >
        {loading && view === undefined && <p className={css.emptyState}>{t('loadingChannels')}</p>}
        {/* A standing error overrides the empty claim, so a failed load does not also read as "no channels yet". */}
        {!loading && error === undefined && view !== undefined && view.channels.length === 0 && <p className={css.emptyState}>{t('emptyChannels')}</p>}
        <div className={css.channelList}>
          {orderedChannels.map(channel => {
            const joined = membership.get(channel.channelRef) ?? new Set<AgentTeamMemberId>()
            return (
              <SortableRow key={channel.channelRef} drag={drag} orderKey={channel.channelRef}>
                <ChannelRow
                  channel={channel}
                  members={members}
                  joinedIds={joined}
                  selected={selectedChannelRef === channel.channelRef}
                  updateChannel={updateChannel}
                  archiveChannel={props.archiveChannel}
                  onCommitted={() => { void refresh() }}
                  selectChannel={selectChannel}
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

function ChannelRow({ channel, members, joinedIds, selected, updateChannel, archiveChannel, onCommitted, selectChannel, t }: {
  readonly channel: AgentTeamChannel
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly joinedIds: ReadonlySet<AgentTeamMemberId>
  readonly selected: boolean
  readonly updateChannel: TeamSidebarProps['updateChannel']
  readonly archiveChannel: TeamSidebarProps['archiveChannel']
  readonly onCommitted: () => Promise<void> | void
  readonly selectChannel: TeamSidebarProps['selectChannel']
  readonly t: TeamSidebarProps['t']
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [rowAlert, setRowAlert] = useState<string>()
  const archive = async (): Promise<void> => {
    try {
      const result = await archiveChannel({
        requestId: mintRequestId(),
        workspaceId: channel.workspaceId,
        channelRef: channel.channelRef,
      })
      await onCommitted()
      if (!result.ok) {
        setRowAlert(t('archiveChannelFailed', { message: result.error.message }))
      }
    } catch (cause) {
      setRowAlert(t('archiveChannelFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    }
  }
  return (
    <>
      <article className={css.channelRow} data-menu-open={menuOpen || undefined} aria-current={selected ? 'page' : undefined}>
        <button type="button" className={css.channelSelect} aria-label={`# ${channel.name}`} onClick={() => { selectChannel(channel.channelRef) }}>
          <strong className={css.channelName}># {channel.name}</strong>
        </button>
        <span className={css.rowMenu}>
          <TeamRowMenu
            label={t('actionsChannel', { name: channel.name })}
            items={[
              { id: 'edit', label: t('editChannel'), icon: <IconEditOutlineRegular /> },
              { id: 'archive', label: t('archiveChannel'), icon: <IconArchiveOutlineRegular size={16} />, danger: true },
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
          title={t('archiveChannelTitle', { name: channel.name })}
          closeLabel={t('close')}
          contentClassName={createCss.dialogContent!}
          footer={<>
            <Button variant="outline" onClick={() => { setArchiving(false) }}>{t('cancel')}</Button>
            <Button variant="primary" onClick={() => { setArchiving(false); void archive() }}>{t('archiveChannelConfirm')}</Button>
          </>}
        >
          <p className={createCss.error}>{t('archiveChannelNotice', { name: channel.name })}</p>
        </Modal>
      )}
      {editing && (
        <ChannelEditorDialog
          channel={channel}
          members={members}
          joinedIds={joinedIds}
          updateChannel={updateChannel}
          onCommitted={onCommitted}
          onClose={() => { setEditing(false) }}
          t={t}
        />
      )}
    </>
  )
}

/** Name and description commit through one durable update; membership keeps its own immediate add/remove flow. */
function ChannelEditorDialog({ channel, updateChannel, onCommitted, onClose, t }: {
  readonly channel: AgentTeamChannel
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly joinedIds: ReadonlySet<AgentTeamMemberId>
  readonly updateChannel: TeamSidebarProps['updateChannel']
  readonly onCommitted: () => Promise<void> | void
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const [name, setName] = useState(channel.name)
  const [description, setDescription] = useState(channel.description)
  const { saving, error, save, invalidate } = useEditDialogSave({
    save: updateChannel,
    onCommitted,
    onClose,
  })

  const dirty = name.trim() !== channel.name || description.trim() !== channel.description
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedName = name.trim()
    const normalizedDescription = description.trim()
    if (saving || !dirty || normalizedName === '') return
    await save(previous => previous !== undefined && previous.channelRef === channel.channelRef
      && previous.name === normalizedName && previous.description === normalizedDescription ? previous : {
      requestId: mintRequestId(),
      workspaceId: channel.workspaceId,
      channelRef: channel.channelRef,
      name: normalizedName,
      description: normalizedDescription,
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('editChannel')}
      description={`# ${channel.name}`}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<><Button variant="outline" disabled={saving} onClick={onClose}>{t('cancel')}</Button><Button type="submit" form="team-channel-edit-form" variant="primary" disabled={saving || !dirty || name.trim() === ''}>{saving ? t('editSaving') : t('editSave')}</Button></>}
    >
      <form id="team-channel-edit-form" className={createCss.form} onSubmit={event => { void submit(event) }}>
        <label className={createCss.field}>
          <span>{t('channelName')}</span>
          <Input className={createCss.input!} value={name} onChange={event => { setName(event.target.value); invalidate() }} disabled={saving} autoFocus />
        </label>
        <label className={createCss.field}>
          <span>{t('channelDescription')}{t('optionalSuffix')}</span>
          <Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} onChange={event => { setDescription(event.target.value); invalidate() }} disabled={saving} />
        </label>
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </form>
    </Modal>
  )
}
