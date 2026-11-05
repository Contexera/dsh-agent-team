import { useEffect, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamMemberReminderView, AgentTeamModelSelection, AgentTeamReminderSchedule } from '@contexera/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TeamModelCatalog, TeamModelEffortOption, TeamModelProviderGroup, TeamSidebarProps } from './slots.ts'
import type { TeamKey } from './locales.ts'
import { formatAbsoluteTime } from './team-formatters.ts'
import { Button, IconChevronDownOutlineRegular, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { mintRequestId } from './requests.ts'
import { useEditDialogSave } from './team-dialog-save.ts'
import createCss from './create.module.css'
import css from './sidebar.module.css'

function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/** Shared Host catalog: one in-flight read while pending, last good value afterwards; a loader that starts throwing keeps serving that value. */
interface ModelCatalogCache {
  inflight?: Promise<RemoteResult<TeamModelCatalog>>
  value?: TeamModelCatalog
}

const modelCatalogCaches = new WeakMap<TeamSidebarProps['loadModels'], ModelCatalogCache>()

function peekCatalogGroups(loadModels: TeamSidebarProps['loadModels']): readonly TeamModelProviderGroup[] | undefined {
  return modelCatalogCaches.get(loadModels)?.value?.groups
}

function sharedCatalog(loadModels: TeamSidebarProps['loadModels']): Promise<RemoteResult<TeamModelCatalog>> {
  const cached = modelCatalogCaches.get(loadModels)
  if (cached?.inflight !== undefined) return cached.inflight
  const next = loadModels()
  const entry = cached ?? {}
  entry.inflight = next
  modelCatalogCaches.set(loadModels, entry)
  const forget = (result: RemoteResult<TeamModelCatalog> | undefined): void => {
    if (modelCatalogCaches.get(loadModels) === entry && entry.inflight === next) {
      delete entry.inflight
      if (result !== undefined && result.ok) entry.value = result.value
    }
  }
  next.then(
    (result) => { forget(result) },
    () => { forget(undefined) },
  )
  return next
}

/** Best-effort warm so pickers open with rows; failures belong to the picker's own error surface. */
export function warmModelCatalog(loadModels: TeamSidebarProps['loadModels']): void {
  try {
    void sharedCatalog(loadModels).catch(() => {
      // The picker that later reads surfaces the failure with its retry entry.
    })
  } catch {
    // Same: a synchronously refused warm leaves no trace; the picker reports it.
  }
}

/**
 * Shared provider/model dropdown for the create and edit forms. Mounts open with the warmed value and revalidate behind it;
 * a refused or failed read with no warmed value renders a retryable error rather than stranding the field on "loading".
 */
export function ModelPickerField({ model, onModelChange, loadModels, disabled, t }: {
  readonly model: AgentTeamModelSelection | undefined
  readonly onModelChange: (choice: AgentTeamModelSelection | undefined) => void
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly disabled: boolean
  readonly t: TeamSidebarProps['t']
}) {
  const [groups, setGroups] = useState<readonly TeamModelProviderGroup[] | undefined>(() => peekCatalogGroups(loadModels))
  const [modelsError, setModelsError] = useState<string>()
  const [reloadToken, setReloadToken] = useState(0)
  const [open, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  useEffect(() => {
    let mounted = true
    let pending: Promise<RemoteResult<TeamModelCatalog>>
    try {
      pending = sharedCatalog(loadModels)
    } catch (error) {
      // A synchronously refused read (an undeclared remote, a dead scope) surfaces as the same retryable failure; last good rows stay rendered.
      setModelsError(error instanceof Error ? error.message : String(error))
      return
    }
    void pending.then(
      (result) => {
        if (!mounted) return
        if (result.ok) {
          setGroups(result.value.groups)
          setModelsError(undefined)
        } else {
          setModelsError(result.error.message)
        }
      },
      (error: unknown) => {
        // A rejected read (a transport that died mid-call) retries like any other failure.
        if (!mounted) return
        setModelsError(error instanceof Error ? error.message : String(error))
      },
    )
    return () => { mounted = false }
  }, [loadModels, reloadToken])

  // No "follow the Host default" row: a Member always runs a named route, so the picker only lists real routes.
  const items: MenuEntry[] = []
  const byKey = new Map<string, { provider: string; id: string; name: string; efforts: readonly TeamModelEffortOption[] }>()
  for (const group of groups ?? []) {
    items.push({ type: 'label', id: `model-group:${group.id}`, text: group.name })
    for (const entry of group.models) {
      const key = modelKey(group.id, entry.id)
      byKey.set(key, { provider: group.id, id: entry.id, name: entry.name, efforts: entry.reasoning?.efforts ?? [] })
      items.push({ id: key, label: entry.name })
    }
  }
  const selectedModelKey = model === undefined ? '' : modelKey(model.provider, model.model)
  const triggerLabel = model === undefined
    ? t('modelChoose')
    : byKey.get(selectedModelKey)?.name ?? `${model.provider} / ${model.model}`
  // The effort sub-row only makes sense for a chosen model with adapter-exposed efforts.
  const efforts = model === undefined ? [] : byKey.get(selectedModelKey)?.efforts ?? []
  const effortItems: MenuEntry[] = [{ id: '', label: t('effortFollowDefault') }, ...efforts.map(effort => ({ id: effort.id, label: effort.name }))]
  const selectedEffort = model?.reasoningEffort ?? ''
  const effortTriggerLabel = model === undefined || selectedEffort === ''
    ? t('effortFollowDefault')
    : efforts.find(effort => effort.id === selectedEffort)?.name ?? selectedEffort

  return <div className={createCss.field}>
    <span>{t('memberModel')}</span>
    {groups === undefined && modelsError === undefined && <small className={css.editHint}>{t('modelsLoading')}</small>}
    {modelsError !== undefined && (
      <p className={css.editHint}>
        <span role="alert">{t('modelsLoadFailed', { message: modelsError })}</span>
        {' '}
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => { setModelsError(undefined); setReloadToken(token => token + 1) }}
        >
          {t('retry')}
        </Button>
      </p>
    )}
    {groups !== undefined && (
      <Menu
        open={open}
        portal
        className={createCss.menuCap!}
        items={items}
        selectedId={selectedModelKey}
        onSelect={key => {
          setModelOpen(false)
          const choice = byKey.get(key)
          if (choice !== undefined) onModelChange({ provider: choice.provider, model: choice.id })
        }}
        onClose={() => { setModelOpen(false) }}
        anchor={
          <button
            type="button"
            className={createCss.selectTrigger!}
            aria-label={t('memberModel')}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => { setModelOpen(value => !value) }}
          >
            <span className={createCss.selectValue}>{triggerLabel}</span>
            <span className={`${createCss.chevron!} ${open ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
          </button>
        }
      />
    )}
    {model !== undefined && efforts.length > 0 && (
      <Menu
        open={effortOpen}
        portal
        className={createCss.menuCap!}
        items={effortItems}
        selectedId={selectedEffort}
        onSelect={key => {
          setEffortOpen(false)
          onModelChange(key === ''
            ? { provider: model.provider, model: model.model }
            : { provider: model.provider, model: model.model, reasoningEffort: key as NonNullable<AgentTeamModelSelection['reasoningEffort']> })
        }}
        onClose={() => { setEffortOpen(false) }}
        anchor={
          <button
            type="button"
            className={createCss.selectTrigger!}
            aria-label={t('reasoningEffort')}
            aria-haspopup="menu"
            aria-expanded={effortOpen}
            disabled={disabled}
            onClick={() => { setEffortOpen(value => !value) }}
          >
            <span className={createCss.selectValue}>{`${t('reasoningEffort')} · ${effortTriggerLabel}`}</span>
            <span className={`${createCss.chevron!} ${effortOpen ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
          </button>
        }
      />
    )}
  </div>
}

/** What the reminder is waiting on, as one line: the pending read wins, then the next
 *  occurrence, then the last one it already had. */
function reminderTimingText(view: AgentTeamMemberReminderView, t: TeamSidebarProps['t']): string | undefined {
  if (view.pendingOccurrenceAt !== undefined) return t('memberReminderPending', { time: formatAbsoluteTime(view.pendingOccurrenceAt) })
  if (view.nextOccurrenceAt !== undefined) return t('memberReminderNext', { time: formatAbsoluteTime(view.nextOccurrenceAt) })
  if (view.lastOccurrenceAt !== undefined) return t('memberReminderLast', { time: formatAbsoluteTime(view.lastOccurrenceAt) })
  return undefined
}

/**
 * One Member's reminders in Member detail. Read-only by construction: the Human sees what the
 * Member asked of itself and may withdraw a reminder, but never invents one — a reminder has
 * exactly one recipient, and only that Member creates its own. Every write re-reads the list,
 * so the rows are never an optimistic guess at what the Host stored.
 */
export function MemberRemindersSection({ workspaceId, memberId, loadMemberReminders, cancelMemberReminder, disabled, t }: {
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamClientMemberStatus['member']['memberId']
  readonly loadMemberReminders: TeamSidebarProps['loadMemberReminders']
  readonly cancelMemberReminder: TeamSidebarProps['cancelMemberReminder']
  readonly disabled: boolean
  readonly t: TeamSidebarProps['t']
}) {
  const [reminders, setReminders] = useState<readonly AgentTeamMemberReminderView[]>()
  const [error, setError] = useState<string>()
  const [reloadToken, setReloadToken] = useState(0)
  const [withdrawing, setWithdrawing] = useState<AgentTeamMemberReminderView['reminder']['reminderRef']>()
  useEffect(() => {
    let mounted = true
    let pending: Promise<RemoteResult<readonly AgentTeamMemberReminderView[]>>
    try {
      pending = loadMemberReminders({ requestId: mintRequestId(), workspaceId, memberId })
    } catch (cause) {
      // A synchronously refused read (an undeclared remote, a dead scope) is the same retryable failure.
      setError(cause instanceof Error ? cause.message : String(cause))
      return
    }
    void pending.then(
      (result) => {
        if (!mounted) return
        if (result.ok) {
          setReminders(result.value)
          setError(undefined)
        } else {
          setError(result.error.message)
        }
      },
      (cause: unknown) => {
        if (!mounted) return
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
    return () => { mounted = false }
  }, [loadMemberReminders, workspaceId, memberId, reloadToken])

  const cancel = async (reminderRef: AgentTeamMemberReminderView['reminder']['reminderRef']): Promise<void> => {
    if (withdrawing !== undefined) return
    setWithdrawing(reminderRef)
    try {
      const result = await cancelMemberReminder({ requestId: mintRequestId(), workspaceId, reminderRef })
      if (!result.ok) throw new Error(result.error.message)
      setReloadToken(token => token + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWithdrawing(undefined)
    }
  }

  return (
    <div className={createCss.remindersSection} role="group" aria-label={t('memberReminders')} data-team-member-reminders>
      <span className={createCss.sectionLabel}>{t('memberReminders')}</span>
      {reminders === undefined && error === undefined && <small className={css.editHint}>{t('memberRemindersLoading')}</small>}
      {reminders !== undefined && reminders.length === 0 && <small className={css.editHint}>{t('memberRemindersEmpty')}</small>}
      {reminders !== undefined && reminders.length > 0 && (
        <ul className={createCss.reminderList}>
          {reminders.map(view => (
            <li className={createCss.reminderRow} key={view.reminder.reminderRef} data-reminder-state={view.reminder.state}>
              <div className={createCss.reminderBody}>
                <span className={createCss.reminderNote}>{view.reminder.note}</span>
                <p className={createCss.reminderFacts}>
                  <span>{`${reminderScheduleText(view.reminder.schedule, t)} · ${t(REMINDER_STATE_KEYS[view.reminder.state])}`}</span>
                  {reminderTimingText(view, t) !== undefined && <span>{reminderTimingText(view, t)}</span>}
                </p>
              </div>
              {view.reminder.state === 'active' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${t('memberReminderCancel')} · ${view.reminder.note}`}
                  disabled={disabled || withdrawing !== undefined}
                  onClick={() => { void cancel(view.reminder.reminderRef) }}
                >
                  {withdrawing === view.reminder.reminderRef ? t('memberReminderCancelling') : t('memberReminderCancel')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && (
        <p className={createCss.failure} role="alert">
          <span>{t('memberRemindersFailed', { message: error })}</span>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setError(undefined); setReloadToken(token => token + 1) }}>
            {t('retry')}
          </Button>
        </p>
      )}
    </div>
  )
}

/** The one label per stored state, so a new state cannot silently render as nothing. */
const REMINDER_STATE_KEYS = {
  active: 'memberReminderActive',
  done: 'memberReminderDone',
  cancelled: 'memberReminderCancelled',
} as const satisfies Record<AgentTeamMemberReminderView['reminder']['state'], TeamKey>

/** One schedule as the Human reads it: the stored form, with cron naming the zone it is read in. */
function reminderScheduleText(schedule: AgentTeamReminderSchedule, t: TeamSidebarProps['t']): string {
  if (schedule.kind === 'once') return `${t('memberReminderOnce')} ${formatAbsoluteTime(schedule.at)}`
  if (schedule.kind === 'every') return t('memberReminderEvery', { minutes: schedule.minutes })
  return t('memberReminderCron', { expression: schedule.expression })
}

export function AgentEditorDialog({ status, updateMember, loadModels, loadMemberReminders, cancelMemberReminder, onCommitted, onClose, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly loadMemberReminders: TeamSidebarProps['loadMemberReminders']
  readonly cancelMemberReminder: TeamSidebarProps['cancelMemberReminder']
  readonly onCommitted: () => Promise<void> | void
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const memberId = status.member.memberId
  const [handle, setHandle] = useState(status.member.handle)
  const [description, setDescription] = useState(status.member.description)
  const [model, setModel] = useState<AgentTeamModelSelection | undefined>(status.member.model)
  const { saving, error, save, invalidate } = useEditDialogSave({
    save: updateMember,
    onCommitted,
    onClose,
  })
  const dirty = handle.trim() !== status.member.handle || description.trim() !== status.member.description
    || !sameModel(model, status.member.model)
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedHandle = handle.trim()
    const normalizedDescription = description.trim()
    if (saving || !dirty || normalizedHandle.length === 0) return
    const payload = {
      memberId,
      handle: normalizedHandle,
      description: normalizedDescription,
      // A Member always runs an explicit route and the Host refuses to clear one, so a record that has none yet simply
      // leaves the field out. Capabilities stay out of the payload so a Remote-written override is left alone.
      ...(model === undefined ? {} : { model }),
    }
    await save(previous => previous !== undefined && previous.memberId === payload.memberId
      && previous.handle === payload.handle && previous.description === payload.description
      && sameModel(previous.model, model) ? previous : {
      requestId: mintRequestId(),
      ...payload,
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('editAgent')}
      description={`@${status.member.handle}`}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<><Button variant="outline" disabled={saving} onClick={onClose}>{t('cancel')}</Button><Button type="submit" form="team-agent-edit-form" variant="primary" disabled={saving || !dirty || handle.trim().length === 0}>{saving ? t('editSaving') : t('editSave')}</Button></>}
    >
      <form id="team-agent-edit-form" className={createCss.form} onSubmit={event => { void submit(event) }}>
        <label className={createCss.field}>
          <span>{t('agentName')}</span>
          <Input className={createCss.input!} value={handle} onChange={event => { setHandle(event.target.value); invalidate() }} disabled={saving} autoFocus />
        </label>
        <label className={createCss.field}>
          <span>{t('agentDescription')}{t('optionalSuffix')}</span>
          <Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} onChange={event => { setDescription(event.target.value); invalidate() }} disabled={saving} />
        </label>
        <ModelPickerField model={model} onModelChange={choice => { invalidate(); setModel(choice) }} loadModels={loadModels} disabled={saving} t={t} />
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </form>
      {/* Outside the form: a reminder withdrawal is its own write, never part of the profile save. */}
      <MemberRemindersSection
        workspaceId={status.member.workspaceId}
        memberId={memberId}
        loadMemberReminders={loadMemberReminders}
        cancelMemberReminder={cancelMemberReminder}
        disabled={saving}
        t={t}
      />
    </Modal>
  )
}

export function sameModel(left: AgentTeamModelSelection | null | undefined, right: AgentTeamModelSelection | null | undefined): boolean {
  // `null` and an absent field both mean "no override", so they are the same
  // state even though the update request distinguishes them.
  if (left === undefined || left === null) return right === undefined || right === null
  if (right === undefined || right === null) return false
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}
