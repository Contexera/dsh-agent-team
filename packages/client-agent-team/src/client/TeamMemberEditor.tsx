import { useEffect, useId, useRef, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamMemberReminderView, AgentTeamModelSelection, AgentTeamReminderSchedule, AgentTeamWorkerInspection, AgentTeamWorkerRef, AgentTeamWorkerRunView, AgentTeamWorkerStopResult } from '@contexera/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TeamModelCatalog, TeamModelEffortOption, TeamModelProviderGroup, TeamSidebarProps } from './slots.ts'
import type { TeamKey } from './locales.ts'
import { formatAbsoluteTime, formatMessageTime } from './team-formatters.ts'
import { workerEngineName } from './worker-copy.ts'
import { Button, IconChevronDownOutlineRegular, Input, Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { mintRequestId } from './requests.ts'
import { useEditDialogSave } from './team-dialog-save.ts'
import createCss from './create.module.css'
import css from './sidebar.module.css'
import settingsCss from './team-settings.module.css'

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
 * One Member's reminders that can still fire, in Member detail. Read-only by construction: the
 * Human sees what the Member asked of itself and may withdraw a reminder, but never invents one —
 * a reminder has exactly one recipient, and only that Member creates its own. Every write re-reads
 * the list, so the rows are never an optimistic guess at what the Host stored.
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

  // The ledger keeps a reminder after it fires or is withdrawn, but Member detail is a
  // management surface: a row that can no longer fire has nothing left to manage.
  const manageable = reminders?.filter(view => view.reminder.state === 'active')
  const headingId = useId()
  return (
    <div className={createCss.section} role="group" aria-labelledby={headingId} data-team-member-reminders>
      <h3 className={settingsCss.groupHeading} id={headingId}>{t('memberReminders')}</h3>
      {manageable === undefined && error === undefined && <small className={css.editHint}>{t('memberRemindersLoading')}</small>}
      {manageable !== undefined && manageable.length === 0 && <small className={css.editHint}>{t('memberRemindersEmpty')}</small>}
      {manageable !== undefined && manageable.length > 0 && (
        <ul className={createCss.reminderList}>
          {manageable.map(view => (
            <ReminderRow
              key={view.reminder.reminderRef}
              view={view}
              disabled={disabled}
              withdrawing={withdrawing}
              onCancel={reminderRef => { void cancel(reminderRef) }}
              t={t}
            />
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

/** A note long enough to dominate the row folds to a fixed preview with an expand toggle,
 *  reusing the Message body's alpha-mask fade so the cutoff reads as "there is more". */
const REMINDER_NOTE_EXPAND_CHARS = 120

/** One manageable reminder: the note leads, the schedule/state/timing facts and the withdraw
 *  control share a footer line, and an over-long note folds until expanded. */
function ReminderRow({ view, disabled, withdrawing, onCancel, t }: {
  readonly view: AgentTeamMemberReminderView
  readonly disabled: boolean
  readonly withdrawing: AgentTeamMemberReminderView['reminder']['reminderRef'] | undefined
  readonly onCancel: (reminderRef: AgentTeamMemberReminderView['reminder']['reminderRef']) => void
  readonly t: TeamSidebarProps['t']
}) {
  const [expanded, setExpanded] = useState(false)
  const note = view.reminder.note
  const clampable = note.length > REMINDER_NOTE_EXPAND_CHARS
  const timing = reminderTimingText(view, t)
  return (
    <li className={createCss.reminderRow}>
      <div className={createCss.reminderBody}>
        <span data-reminder-note="" className={`${createCss.reminderNote!} ${clampable && !expanded ? createCss.reminderNoteClamp! : ''}`}>{note}</span>
        {clampable && (
          <button type="button" className={createCss.reminderExpand} aria-expanded={expanded} onClick={() => { setExpanded(value => !value) }}>
            {expanded ? t('collapseMessage') : t('expandMessage')}
          </button>
        )}
        <div className={createCss.reminderFooter}>
          <p className={createCss.reminderFacts}>
            <span>{`${reminderScheduleText(view.reminder.schedule, t)} · ${t(REMINDER_STATE_KEYS[view.reminder.state])}`}</span>
            {timing !== undefined && <span>{timing}</span>}
          </p>
          {view.reminder.state === 'active' && (
            <Button
              className={createCss.reminderCancel!}
              size="sm"
              variant="ghost"
              aria-label={`${t('memberReminderCancel')} · ${note}`}
              disabled={disabled || withdrawing !== undefined}
              onClick={() => { onCancel(view.reminder.reminderRef) }}
            >
              {withdrawing === view.reminder.reminderRef ? t('memberReminderCancelling') : t('memberReminderCancel')}
            </Button>
          )}
        </div>
      </div>
    </li>
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


/** Every label one row can show: what the Host reports, plus the endings a stop receipt names. */
type WorkerRunRowState = AgentTeamWorkerRunView['state'] | Extract<AgentTeamWorkerStopResult, { kind: 'ended' }>['state']

const WORKER_RUN_STATE_KEYS = {
  running: 'memberWorkerRunRunning',
  stopping: 'memberWorkerRunStopping',
  stopped: 'memberWorkerRunStopped',
  completed: 'memberWorkerRunCompleted',
  failed: 'memberWorkerRunFailed',
  unconfirmed: 'memberWorkerRunUnconfirmed',
} as const satisfies Record<WorkerRunRowState, TeamKey>

/** What the run reports into, in the words the Thread faces already use. */
function workerRunTargetText(run: AgentTeamWorkerRunView, t: TeamSidebarProps['t']): string {
  if (run.taskRef !== undefined) return t('memberWorkerTargetTask')
  if (run.threadRef !== undefined) return t('memberWorkerTargetThread')
  return t('memberWorkerTargetProject')
}

/**
 * What this surface knows about one row beyond its first read, in two separate
 * fields: the state a Host receipt confirmed, and the sentence of the latest
 * request. A request that never completed writes the sentence alone, so it can
 * explain itself without ever taking back a state the Host already confirmed.
 */
interface WorkerRunOutcome {
  readonly run: AgentTeamWorkerRunView
  /** Written only by a receipt that carries an execution fact. */
  readonly hostState?: WorkerRunRowState | undefined
  /** Written by any request: a diagnostic, an in-flight word, or a refusal. */
  readonly notice?: string | undefined
}

/**
 * One Member's running Worker executions, read from the Host that owns them.
 * Read-only by construction: the Human sees what this Host holds and may ask it
 * to stop one, but a stop is only reported as done when the engine confirmed its
 * cleanup. A failed stop keeps its row and its sentence across refreshes rather
 * than disappearing into a shorter list.
 */
export function MemberWorkerRunsSection({ workspaceId, memberId, loadWorkerRuns, stopWorker, inspectWorker, disabled, t }: {
  readonly workspaceId: WorkspaceId
  readonly memberId: AgentTeamClientMemberStatus['member']['memberId']
  readonly loadWorkerRuns: TeamSidebarProps['loadWorkerRuns']
  readonly stopWorker: TeamSidebarProps['stopWorker']
  readonly inspectWorker: TeamSidebarProps['inspectWorker']
  readonly disabled: boolean
  readonly t: TeamSidebarProps['t']
}) {
  const [runs, setRuns] = useState<readonly AgentTeamWorkerRunView[]>()
  const [error, setError] = useState<string>()
  const [reloadToken, setReloadToken] = useState(0)
  const [stopping, setStopping] = useState<string>()
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, WorkerRunOutcome>>(() => new Map())
  // One seat for a row's report: opening another row closes the previous one
  // instead of stacking them.
  const [report, setReport] = useState<WorkerReportState>()
  const headingId = useId()
  // A read that answers after the surface moved on is not the answer to show:
  // each open bumps its generation, and only the current one lands.
  const reportGeneration = useRef(0)
  useEffect(() => {
    let mounted = true
    let pending: Promise<RemoteResult<{ readonly runs: readonly AgentTeamWorkerRunView[] }>>
    try {
      pending = loadWorkerRuns({ workspaceId, memberId })
    } catch (cause) {
      // A synchronously refused read (an undeclared remote, a dead scope) is the same retryable failure.
      setError(cause instanceof Error ? cause.message : String(cause))
      return
    }
    void pending.then(
      (result) => {
        if (!mounted) return
        if (result.ok) {
          setRuns(result.value.runs)
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
  }, [loadWorkerRuns, workspaceId, memberId, reloadToken])

  /**
   * Record a request that carried no execution fact: the sentence changes, and
   * whatever the Host last confirmed for this row stays exactly as it was.
   */
  const recordNotice = (run: AgentTeamWorkerRunView, notice: string): void => {
    setOutcomes(current => {
      const previous = current.get(run.workerRef)
      return new Map(current).set(run.workerRef, { run,
        ...(previous?.hostState === undefined ? {} : { hostState: previous.hostState }), notice })
    })
  }

  const stop = async (run: AgentTeamWorkerRunView): Promise<void> => {
    if (stopping !== undefined) return
    setStopping(run.workerRef)
    try {
      const result = await stopWorker({ workspaceId, memberId, workerRef: run.workerRef })
      if (!result.ok) {
        // A refused call says the request did not complete. It carries no
        // execution fact, so it may not take back a state the Host confirmed.
        recordNotice(run, result.error.message)
        return
      }
      const value = result.value
      // The Host's receipt is structured: an ending it decided, a cleanup still
      // in flight, or a handle it no longer holds. None of them is guessed here.
      setOutcomes(current => new Map(current).set(run.workerRef, value.kind === 'ended'
        ? { run, hostState: value.state, ...(value.diagnostic === undefined ? {} : { notice: value.diagnostic }) }
        : { run, hostState: value.kind === 'pending' ? 'stopping' : 'unconfirmed', notice: value.message }))
    } catch (cause) {
      // The row stays, and so does whatever the Host last confirmed: a request
      // that never completed is an explanation, not an execution fact.
      recordNotice(run, cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStopping(undefined)
    }
  }

  /**
   * Read one ended run's diagnostic from its row. The Host answers the summary,
   * the native identities it recorded, and whatever the engine's own record
   * still holds; this surface only renders what it is given. The same control
   * folds the report away, including while its read is still in flight.
   */
  const inspect = async (workerRef: AgentTeamWorkerRef): Promise<void> => {
    if (report?.workerRef === workerRef) {
      reportGeneration.current += 1
      setReport(undefined)
      return
    }
    const current = ++reportGeneration.current
    setReport({ workerRef })
    try {
      const result = await inspectWorker({ workspaceId, memberId, workerRef })
      if (current !== reportGeneration.current) return
      setReport(result.ok ? { workerRef, value: result.value } : { workerRef, error: result.error.message })
    } catch (cause) {
      if (current !== reportGeneration.current) return
      setReport({ workerRef, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  const rows: Array<{ readonly run: AgentTeamWorkerRunView; readonly outcome: WorkerRunOutcome | undefined }> =
    (runs ?? []).map(run => ({ run, outcome: outcomes.get(run.workerRef) }))
  for (const outcome of outcomes.values()) {
    if (!(runs ?? []).some(run => run.workerRef === outcome.run.workerRef)) rows.push({ run: outcome.run, outcome })
  }
  return (
    <div className={createCss.section} role="group" aria-labelledby={headingId} data-team-member-workers>
      <div className={createCss.sectionHead}>
        <h3 className={settingsCss.groupHeading} id={headingId}>{t('memberWorkerRuns')}</h3>
        {rows.length > 0 && <small className={createCss.sectionHeadMeta}>{t('memberWorkerRunsWindow')}</small>}
      </div>
      {runs === undefined && error === undefined && <small className={css.editHint}>{t('memberWorkerRunsLoading')}</small>}
      {runs !== undefined && rows.length === 0 && <small className={css.editHint}>{t('memberWorkerRunsEmpty')}</small>}
      {rows.length > 0 && (
        <ul className={createCss.reminderList}>
          {rows.map(({ run, outcome }) => {
            // The Host's live word wins over a snapshot; a receipt's ending wins
            // over both, because a run that ended is no longer listed.
            const listed = (runs ?? []).find(candidate => candidate.workerRef === run.workerRef)
            const state: WorkerRunRowState = outcome?.hostState ?? listed?.state ?? run.state
            // One flag drives the visible word, the accessible name, the expanded
            // state, and the click: a control whose name says "view" while it folds
            // the report away tells a screen reader a different story than the page.
            const open = report?.workerRef === run.workerRef
            // Only an ended run has a native record to read. The Host answers a live
            // one with "still going" and an unconfirmed one with the sentence its own
            // hint already carries, so a door there would open onto nothing.
            const ended = state === 'stopped' || state === 'completed' || state === 'failed'
            return (
              <li key={run.workerRef} className={createCss.reminderRow} data-worker-run={run.workerRef} data-worker-state={state}>
                <div className={createCss.reminderBody}>
                  <span className={createCss.workerRunTask} data-worker-task="" title={run.task}>
                    {`${workerEngineName(t, run.engine)} · ${run.task}`}
                  </span>
                  <div className={createCss.reminderFooter}>
                    <p className={createCss.workerRunFacts}>
                      {`${t(WORKER_RUN_STATE_KEYS[state])} · ${workerRunTargetText(run, t)} · `
                        + t('memberWorkerStarted', { time: formatMessageTime(run.startedAt) })}
                    </p>
                    {(state === 'running' || state === 'stopping' || ended) && (
                      <div className={createCss.reminderActions}>
                        {(state === 'running' || state === 'stopping') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t('memberWorkerStopAction', { task: run.task })}
                            disabled={disabled || stopping !== undefined}
                            onClick={() => { void stop(run) }}
                          >
                            {stopping === run.workerRef || state === 'stopping' ? t('memberWorkerRunStopping') : t('memberWorkerStop')}
                          </Button>
                        )}
                        {ended && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={open
                              ? t('memberWorkerInspectHideAction', { task: run.task })
                              : t('memberWorkerInspectAction', { task: run.task })}
                            aria-expanded={open}
                            disabled={disabled}
                            onClick={() => { void inspect(run.workerRef) }}
                          >
                            {open ? t('memberWorkerInspectHide') : t('memberWorkerInspect')}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {outcome?.notice !== undefined && <p className={createCss.error} role="alert">{outcome.notice}</p>}
                  {state === 'unconfirmed' && <small className={css.editHint}>{t('memberWorkerStopUnconfirmedHint')}</small>}
                  {report?.workerRef === run.workerRef && <WorkerReport report={report} t={t} />}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {error !== undefined && (
        <p className={createCss.failure} role="alert">
          <span>{t('memberWorkerRunsFailed', { message: error })}</span>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => { setError(undefined); setReloadToken(token => token + 1) }}>
            {t('retry')}
          </Button>
        </p>
      )}
    </div>
  )
}

/** One open diagnostic: the run it belongs to, and what the Host answered. */
interface WorkerReportState {
  readonly workerRef: string
  readonly value?: AgentTeamWorkerInspection | undefined
  readonly error?: string | undefined
}

/**
 * The Host's report as it came: the summary the Thread already carries, the
 * native identities the settlement recorded, and the bounded fragments the
 * engine's own record still answers — or the reason it cannot. Nothing here is
 * derived from a refusal.
 */
function WorkerReport({ report, t }: { readonly report: WorkerReportState; readonly t: TeamSidebarProps['t'] }) {
  if (report.value === undefined) {
    // A read in flight is a status; a read that failed is the same failure every
    // other read on this page reports, so it is an alert.
    return report.error === undefined
      ? <p className={createCss.error} role="status">{t('memberWorkerInspectLoading')}</p>
      : <p className={createCss.error} role="alert">{t('memberWorkerInspectFailed', { message: report.error })}</p>
  }
  const value = report.value
  const native = [
    value.native.threadId === undefined ? undefined : t('memberWorkerInspectNativeThread', { id: value.native.threadId }),
    value.native.turnId === undefined ? undefined : t('memberWorkerInspectNativeTurn', { id: value.native.turnId }),
    value.native.storage === undefined ? undefined : t('memberWorkerInspectNativeRecord', { path: value.native.storage }),
  ].filter((line): line is string => line !== undefined)
  return (
    <div className={`${createCss.reminderFacts} ${createCss.workerReport}`} data-worker-report={value.workerRef}>
      <p className={createCss.reportLine}>{`${t('memberWorkerInspectSummary')}: ${value.summary}`}</p>
      {value.stage !== undefined && <p className={createCss.reportLine}>{t('memberWorkerInspectStage', { stage: value.stage })}</p>}
      {native.length === 0
        ? <p className={createCss.reportLine}>{t('memberWorkerInspectNoNative')}</p>
        : native.map(line => <p key={line} className={createCss.reportLine}>{line}</p>)}
      {value.history.kind === 'read' ? (
        <>
          <p className={createCss.reportLine}>{t('memberWorkerInspectFragments')}</p>
          {value.history.fragments.length === 0
            ? <p className={createCss.reportLine}>{t('memberWorkerInspectNoFragments')}</p>
            : <ul className={createCss.reportList}>{value.history.fragments.map((fragment, index) => (
              // Two fragments of one kind are ordinary (an interrupted turn and a
              // failed one), so the position is part of the identity.
              <li key={`${fragment.kind}-${index}`}>{`${fragment.kind}: ${fragment.text}`}</li>
            ))}</ul>}
          {value.history.withheld > 0
            && <p className={createCss.reportLine}>{t('memberWorkerInspectWithheld', { count: value.history.withheld })}</p>}
          {value.history.truncated && <p className={createCss.reportLine}>{t('memberWorkerInspectTruncated')}</p>}
        </>
      ) : <p className={createCss.reportLine}>{value.history.reason}</p>}
    </div>
  )
}

export function AgentEditorDialog({ status, updateMember, loadModels, loadMemberReminders, cancelMemberReminder, loadWorkerRuns, stopWorker, inspectWorker, onCommitted, onClose, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly loadMemberReminders: TeamSidebarProps['loadMemberReminders']
  readonly cancelMemberReminder: TeamSidebarProps['cancelMemberReminder']
  readonly loadWorkerRuns: TeamSidebarProps['loadWorkerRuns']
  readonly stopWorker: TeamSidebarProps['stopWorker']
  readonly inspectWorker: TeamSidebarProps['inspectWorker']
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
          <Input className={createCss.input!} value={handle} onChange={event => { setHandle(event.target.value); invalidate() }} disabled={saving} data-modal-autofocus />
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
      <MemberWorkerRunsSection
        workspaceId={status.member.workspaceId}
        memberId={memberId}
        loadWorkerRuns={loadWorkerRuns}
        stopWorker={stopWorker}
        inspectWorker={inspectWorker}
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
