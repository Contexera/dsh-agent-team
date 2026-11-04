import { useEffect, useId, useRef, useState } from 'react'
import type {
  AgentTeamCreateSubscriptionRequest,
  AgentTeamMemberId,
  AgentTeamProjectRef,
  AgentTeamSubscription,
  AgentTeamSubscriptionDraftTrialResult,
  AgentTeamSubscriptionDeliveryEntry,
  AgentTeamSubscriptionListEntry,
  AgentTeamSubscriptionLogEntry,
  AgentTeamSubscriptionReplayVersion,
  AgentTeamSubscriptionRunSummary,
  AgentTeamSubscriptionTrialFailure,
  AgentTeamUpdateSubscriptionRequest,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamKey } from './locales.ts'
import { mintRequestId } from './requests.ts'
import { formatAbsoluteTime, formatInboxTime } from './team-formatters.ts'
import css from './subscriptions.module.css'
import conversationCss from './conversation.module.css'
import createCss from './create.module.css'

type TeamSubscriptionHost = Pick<TeamConversationProps,
  'loadSubscriptionLogs' | 'testSubscriptionDraft' | 'createSubscription' | 'updateSubscription' |
  'pauseSubscription' | 'resumeSubscription' | 'deleteSubscription' | 'resetSubscriptionWebhook' |
  'loadSubscriptionDeliveries' | 'replaySubscriptionDelivery'>

export interface TeamSubscriptionsTabProps {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly host: TeamSubscriptionHost
  readonly entries: readonly AgentTeamSubscriptionListEntry[] | undefined
  readonly loading: boolean
  readonly error: string | undefined
  readonly onRetry: () => void
  /** A committed write re-reads the Host list; nothing is added optimistically. */
  readonly onChanged: () => void
  readonly canManage: boolean
  readonly memberOf: (memberId: AgentTeamMemberId) => { readonly handle: string } | undefined
  readonly panelId: string
  readonly labelledBy: string
  readonly t: TeamConversationProps['t']
}

type EditorMode =
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly entry: AgentTeamSubscriptionListEntry }

type PendingAction = { readonly ref: string; readonly kind: 'pause' | 'resume' | 'reset' }

/** The form's last trial verdict: a draft answer, or a save whose own trial refused. */
type TrialView = AgentTeamSubscriptionDraftTrialResult | { readonly kind: 'trial-failed'; readonly failure: AgentTeamSubscriptionTrialFailure }

/** One subscription's failing write, kept beside the card so two failures never collapse into one line. */
interface CardFailure {
  readonly ref: string
  readonly message: string
  readonly failure?: AgentTeamSubscriptionTrialFailure | undefined
}

/**
 * The Project's subscription tab: the list, the run history, and the forms that
 * create or edit one. Every durable write rereads the Host, and a refused one
 * leaves the form exactly as typed.
 */
export function TeamSubscriptionsTab({
  workspaceId, projectRef, host, entries, loading, error, onRetry, onChanged, canManage, memberOf, panelId, labelledBy, t,
}: TeamSubscriptionsTabProps) {
  const [editing, setEditing] = useState<EditorMode>()
  const [scriptOf, setScriptOf] = useState<AgentTeamSubscriptionListEntry>()
  const [logsOf, setLogsOf] = useState<AgentTeamSubscriptionListEntry>()
  const [deliveriesOf, setDeliveriesOf] = useState<AgentTeamSubscriptionListEntry>()
  const [deleting, setDeleting] = useState<AgentTeamSubscriptionListEntry>()
  const [pending, setPending] = useState<PendingAction>()
  const [failure, setFailure] = useState<CardFailure>()
  // The one time an address is readable: the answer that armed it. It lives
  // here, not in the card, so closing the dialog really forgets it.
  const [armed, setArmed] = useState<{ readonly name: string; readonly address: string } | { readonly name: string; readonly gone: true }>()

  const live = (entries ?? []).filter(entry => entry.subscription.state !== 'deleted')
  const runStateAction = async (entry: AgentTeamSubscriptionListEntry, kind: PendingAction['kind']): Promise<void> => {
    if (pending !== undefined) return
    const ref = entry.subscription.subscriptionRef
    setPending({ ref, kind })
    setFailure(undefined)
    try {
      const request = { requestId: mintRequestId(), workspaceId, projectRef, subscriptionRef: ref, expectedRevision: entry.subscription.revision }
      const result = kind === 'pause' ? await host.pauseSubscription(request) : await host.resumeSubscription(request)
      if (!result.ok) {
        setFailure({ ref, message: t('subscriptionActionFailed', { message: result.error.message }) })
        return
      }
      if (result.value.kind === 'trial-failed') {
        setFailure({ ref, message: t('subscriptionResumeTrialFailed', { reason: result.value.failure.reason }), failure: result.value.failure })
        return
      }
      onChanged()
    } catch (cause) {
      setFailure({ ref, message: t('subscriptionActionFailed', { message: cause instanceof Error ? cause.message : String(cause) }) })
    } finally {
      setPending(undefined)
    }
  }

  /** Move the address, and show the new one: the Host will never hand it out again. */
  const runResetAction = async (entry: AgentTeamSubscriptionListEntry): Promise<void> => {
    if (pending !== undefined) return
    const ref = entry.subscription.subscriptionRef
    setPending({ ref, kind: 'reset' })
    setFailure(undefined)
    try {
      const result = await host.resetSubscriptionWebhook({ requestId: mintRequestId(), workspaceId, projectRef,
        subscriptionRef: ref, expectedRevision: entry.subscription.revision })
      if (!result.ok) {
        setFailure({ ref, message: t('subscriptionWebhookResetFailed', { message: result.error.message }) })
        return
      }
      // A reset trialled nothing, so the only answer left is the address itself.
      if (result.value.kind === 'changed' && result.value.webhookAddress !== undefined) {
        setArmed({ name: entry.subscription.name, address: result.value.webhookAddress })
      }
      if (result.value.kind === 'changed' && result.value.webhookAddressGone === true) {
        setArmed({ name: entry.subscription.name, gone: true })
      }
      onChanged()
    } catch (cause) {
      setFailure({ ref, message: t('subscriptionWebhookResetFailed', { message: cause instanceof Error ? cause.message : String(cause) }) })
    } finally {
      setPending(undefined)
    }
  }

  return <section id={panelId} role="tabpanel" aria-labelledby={labelledBy} className={css.panel} data-team-subscriptions>
    <div className={css.column}>
      {loading && <SurfaceLoading text={t('subscriptionsLoading')} />}
      {!loading && error !== undefined && <SurfaceError message={t('subscriptionsFailed', { message: error })} retry={t('retry')} onRetry={onRetry} />}
      {!loading && error === undefined && live.length === 0 && <div className={conversationCss.emptySurface}>
        <p className={conversationCss.emptyState}>{t('subscriptionsEmpty')}</p>
        <p className={css.emptyHint}>{t('subscriptionsEmptyHint')}</p>
        {canManage
          ? <Button variant="primary" onClick={() => { setEditing({ kind: 'create' }) }}>{t('subscriptionNew')}</Button>
          : <p className={css.readOnlyNote}>{t('subscriptionsReadOnly')}</p>}
      </div>}
      {!loading && error === undefined && live.map(entry => <SubscriptionCard
        key={entry.subscription.subscriptionRef}
        entry={entry}
        canManage={canManage}
        creator={memberOf(entry.subscription.createdBy)?.handle ?? t('memberUnknown')}
        pending={pending !== undefined && pending.ref === entry.subscription.subscriptionRef ? pending.kind : undefined}
        failure={failure?.ref === entry.subscription.subscriptionRef ? failure : undefined}
        t={t}
        onEdit={() => { setEditing({ kind: 'edit', entry }) }}
        onScript={() => { setScriptOf(entry) }}
        onLogs={() => { setLogsOf(entry) }}
        onDeliveries={() => { setDeliveriesOf(entry) }}
        onPause={() => { void runStateAction(entry, 'pause') }}
        onResume={() => { void runStateAction(entry, 'resume') }}
        onResetWebhook={() => { void runResetAction(entry) }}
        onDelete={() => { setDeleting(entry) }}
      />)}
      {!loading && error === undefined && live.length > 0 && <div className={css.footer}>
        {canManage ? <Button variant="primary" onClick={() => { setEditing({ kind: 'create' }) }}>{t('subscriptionNew')}</Button>
          : <p className={css.readOnlyNote}>{t('subscriptionsReadOnly')}</p>}
      </div>}
    </div>

    {editing !== undefined && <SubscriptionEditorDialog
      mode={editing}
      workspaceId={workspaceId}
      projectRef={projectRef}
      host={host}
      onClose={() => { setEditing(undefined) }}
      onChanged={onChanged}
      onArmed={setArmed}
      t={t}
    />}
    {armed !== undefined && ('gone' in armed
      ? <SubscriptionWebhookGoneDialog name={armed.name} onClose={() => { setArmed(undefined) }} t={t} />
      : <SubscriptionWebhookAddressDialog
        name={armed.name}
        address={armed.address}
        onClose={() => { setArmed(undefined) }}
        t={t}
      />)}
    {scriptOf !== undefined && <SubscriptionScriptDialog
      entry={scriptOf}
      canManage={canManage}
      onEdit={() => {
        const entry = scriptOf
        setScriptOf(undefined)
        setEditing({ kind: 'edit', entry })
      }}
      onClose={() => { setScriptOf(undefined) }}
      t={t}
    />}
    {logsOf !== undefined && <SubscriptionLogsDialog
      entry={logsOf}
      workspaceId={workspaceId}
      projectRef={projectRef}
      loadSubscriptionLogs={host.loadSubscriptionLogs}
      onClose={() => { setLogsOf(undefined) }}
      t={t}
    />}
    {deliveriesOf !== undefined && <SubscriptionDeliveriesDialog
      entry={deliveriesOf}
      workspaceId={workspaceId}
      projectRef={projectRef}
      loadSubscriptionDeliveries={host.loadSubscriptionDeliveries}
      replaySubscriptionDelivery={host.replaySubscriptionDelivery}
      onClose={() => { setDeliveriesOf(undefined) }}
      onChanged={onChanged}
      t={t}
    />}
    {deleting !== undefined && <SubscriptionDeleteDialog
      entry={deleting}
      workspaceId={workspaceId}
      projectRef={projectRef}
      deleteSubscription={host.deleteSubscription}
      onClose={() => { setDeleting(undefined) }}
      onDeleted={() => { setDeleting(undefined); onChanged() }}
      t={t}
    />}
  </section>
}

function SurfaceLoading({ text }: { readonly text: string }) {
  return <div className={conversationCss.emptySurface}>
    <p className={conversationCss.loadingState}><span className={conversationCss.loadingMark} aria-hidden="true" />{text}</p>
  </div>
}

function SurfaceError({ message, retry, onRetry }: { readonly message: string; readonly retry: string; readonly onRetry: () => void }) {
  return <div className={conversationCss.errorState} role="alert">
    <span>{message}</span>
    <Button size="sm" variant="outline" onClick={onRetry}>{retry}</Button>
  </div>
}

function SubscriptionCard({ entry, canManage, creator, pending, failure, t, onEdit, onScript, onLogs, onDeliveries, onPause, onResume, onResetWebhook, onDelete }: {
  readonly entry: AgentTeamSubscriptionListEntry
  readonly canManage: boolean
  readonly creator: string
  readonly pending: PendingAction['kind'] | undefined
  readonly failure: CardFailure | undefined
  readonly t: TeamConversationProps['t']
  readonly onEdit: () => void
  readonly onScript: () => void
  readonly onLogs: () => void
  readonly onDeliveries: () => void
  readonly onPause: () => void
  readonly onResume: () => void
  readonly onResetWebhook: () => void
  readonly onDelete: () => void
}) {
  const { subscription } = entry
  const name = subscription.name
  const paused = subscription.state === 'paused'
  const named = (label: string): string => `${label} · ${name}`
  const lastRun = entry.lastRun
  return <article className={css.card} data-team-subscription-ref={subscription.subscriptionRef} data-subscription-state={subscription.state}>
    <div className={css.cardHead}>
      <h3 className={css.cardName}>{name}</h3>
      <span className={css.trigger}>{triggerText(subscription.triggers, t)}</span>
      <span className={css.creator}>{t('subscriptionCreator', { name: creator })}</span>
    </div>
    <p className={css.facts}>
      <span>{lastRun === undefined ? t('subscriptionLastRunNever') : t('subscriptionLastRun', { time: timeLabel(lastRun.startedAt) })}</span>
      <span>{entry.lastEventAt === undefined ? t('subscriptionLastEventNever') : t('subscriptionLastEvent', { time: timeLabel(entry.lastEventAt) })}</span>
      <span>{t('subscriptionEventCount', { count: entry.eventCount })}</span>
      {entry.unpublished > 0 && <span>{t('subscriptionUnpublished', { count: entry.unpublished })}</span>}
      {entry.nextRunAt !== undefined && <span>{t('subscriptionNextRunAt', { time: timeLabel(entry.nextRunAt) })}</span>}
    </p>
    {paused && <p className={css.paused} data-paused-reason={subscription.pausedReason}>
      {pausedText(entry, t)}
    </p>}
    {failure !== undefined && <div className={css.inlineFailure} role="alert">
      <span>{failure.message}</span>
      {failure.failure !== undefined && <details className={css.failureDetails}>
        <summary>{t('subscriptionShowOutput')}</summary>
        <OutputTails stdout={failure.failure.stdoutTail} stderr={failure.failure.stderrTail} t={t} />
      </details>}
    </div>}
    <div className={css.actions}>
      {canManage && <Button size="sm" variant="outline" aria-label={named(t('subscriptionEdit'))} onClick={onEdit}>{t('subscriptionEdit')}</Button>}
      <Button size="sm" variant="outline" aria-label={named(t('subscriptionScript'))} onClick={onScript}>{t('subscriptionScript')}</Button>
      <Button size="sm" variant="outline" aria-label={named(t('subscriptionLogs'))} onClick={onLogs}>{t('subscriptionLogs')}</Button>
      {canManage && <Button size="sm" variant="outline" aria-label={named(t('subscriptionDeliveries'))} onClick={onDeliveries}>{t('subscriptionDeliveries')}</Button>}
      {canManage && (paused
        ? <Button size="sm" variant="outline" disabled={pending !== undefined} aria-label={named(pending === 'resume' ? t('subscriptionResuming') : t('subscriptionResume'))} onClick={onResume}>{pending === 'resume' ? t('subscriptionResuming') : t('subscriptionResume')}</Button>
        : <Button size="sm" variant="outline" disabled={pending !== undefined} aria-label={named(pending === 'pause' ? t('subscriptionPausing') : t('subscriptionPause'))} onClick={onPause}>{pending === 'pause' ? t('subscriptionPausing') : t('subscriptionPause')}</Button>)}
      {canManage && subscription.webhook !== undefined && <Button size="sm" variant="outline" disabled={pending !== undefined}
        aria-label={named(t('subscriptionWebhookReset'))} onClick={onResetWebhook}>{pending === 'reset' ? t('subscriptionWebhookResetting') : t('subscriptionWebhookReset')}</Button>}
      {canManage && <Button size="sm" variant="outline" aria-label={named(t('subscriptionDelete'))} onClick={onDelete}>{t('subscriptionDelete')}</Button>}
    </div>
  </article>
}

function SubscriptionScriptDialog({ entry, canManage, onEdit, onClose, t }: {
  readonly entry: AgentTeamSubscriptionListEntry
  readonly canManage: boolean
  readonly onEdit: () => void
  readonly onClose: () => void
  readonly t: TeamConversationProps['t']
}) {
  const { subscription } = entry
  return <Modal
    open
    onClose={onClose}
    title={t('subscriptionScriptTitle', { name: subscription.name })}
    description={t('subscriptionScriptDescription', {
      revision: subscription.revision, shell: subscription.script.shell, hash: subscription.script.sha256.slice(0, 12),
    })}
    closeLabel={t('close')}
    className={css.dialogWide!}
    footer={<>
      <Button variant="outline" onClick={onClose}>{t('close')}</Button>
      {canManage && <Button variant="primary" onClick={onEdit}>{t('subscriptionEdit')}</Button>}
    </>}
  >
    <pre className={css.scriptBlock} data-team-subscription-script>{subscription.script.content}</pre>
    {subscription.credentials.length > 0 && <div className={css.credentialList}>
      <h3 className={css.sectionTitle}>{t('subscriptionCredentials')}</h3>
      <ul>
        {subscription.credentials.map(credential => <li key={`${credential.ref}\u0000${credential.env}`}><code>{credential.ref}</code>{' → '}<code>{credential.env}</code></li>)}
      </ul>
    </div>}
  </Modal>
}

function SubscriptionLogsDialog({ entry, workspaceId, projectRef, loadSubscriptionLogs, onClose, t }: {
  readonly entry: AgentTeamSubscriptionListEntry
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly loadSubscriptionLogs: TeamSubscriptionHost['loadSubscriptionLogs']
  readonly onClose: () => void
  readonly t: TeamConversationProps['t']
}) {
  const subscriptionRef = entry.subscription.subscriptionRef
  const [runs, setRuns] = useState<readonly AgentTeamSubscriptionLogEntry[]>()
  const [error, setError] = useState<string>()
  const [reloadToken, setReloadToken] = useState(0)
  useEffect(() => {
    let mounted = true
    setError(undefined)
    void loadSubscriptionLogs({ workspaceId, projectRef, subscriptionRef }).then(
      result => {
        if (!mounted) return
        if (result.ok) { setRuns(result.value.runs); setError(undefined) } else setError(result.error.message)
      },
      (cause: unknown) => { if (mounted) setError(cause instanceof Error ? cause.message : String(cause)) },
    )
    return () => { mounted = false }
  }, [workspaceId, projectRef, subscriptionRef, loadSubscriptionLogs, reloadToken])

  return <Modal
    open
    onClose={onClose}
    title={t('subscriptionLogsTitle', { name: entry.subscription.name })}
    description={t('subscriptionLogsDescription')}
    closeLabel={t('close')}
    className={css.dialogWide!}
    footer={<Button variant="outline" onClick={onClose}>{t('close')}</Button>}
  >
    {runs === undefined && error === undefined && <p className={css.hint}>{t('subscriptionsLoading')}</p>}
    {error !== undefined && <SurfaceError message={t('subscriptionLogsFailed', { message: error })} retry={t('retry')} onRetry={() => { setReloadToken(token => token + 1) }} />}
    {runs !== undefined && error === undefined && runs.length === 0 && <p className={css.hint}>{t('subscriptionLogsEmpty')}</p>}
    {runs !== undefined && error === undefined && runs.length > 0 && <div className={css.listViewport}>
      <ol className={css.runList}>
        {runs.map(run => <RunRow key={run.runRef} run={run} t={t} />)}
      </ol>
    </div>}
  </Modal>
}

function RunRow({ run, t }: { readonly run: AgentTeamSubscriptionLogEntry; readonly t: TeamConversationProps['t'] }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const hasOutput = run.reason !== undefined || run.stdoutTail !== undefined || run.stderrTail !== undefined
  return <li className={css.runRow} data-team-subscription-run={run.runRef} data-run-succeeded={run.succeeded}>
    <div className={css.runHead}>
      <time className={css.runTime} dateTime={run.startedAt} title={formatAbsoluteTime(run.startedAt)}>{formatInboxTime(run.startedAt, t)}</time>
      <span className={css.runTrigger}>{triggerLabel(run.trigger, t)}</span>
      <span className={css.runOutcome} data-succeeded={run.succeeded}>{runCategoryText(run.category, t)}</span>
      <span className={css.runMeta}>{t('subscriptionRunDuration', { seconds: (run.durationMs / 1000).toFixed(1) })}</span>
      <span className={css.runMeta}>{t('subscriptionRunEvents', { count: run.eventCount })}</span>
      {hasOutput && <Button
        size="sm"
        variant="ghost"
        aria-expanded={expanded}
        aria-controls={id}
        aria-label={`${expanded ? t('subscriptionRunCollapse') : t('subscriptionRunExpand')} · ${formatInboxTime(run.startedAt, t)}`}
        onClick={() => { setExpanded(value => !value) }}
      >{expanded ? t('subscriptionRunCollapse') : t('subscriptionRunExpand')}</Button>}
    </div>
    {expanded && <div id={id} className={css.runBody}>
      {run.reason !== undefined && <p className={css.runReason}>{t('subscriptionRunReason')}: {run.reason}</p>}
      <OutputTails stdout={run.stdoutTail ?? ''} stderr={run.stderrTail ?? ''} t={t} />
    </div>}
  </li>
}

function OutputTails({ stdout, stderr, t }: { readonly stdout: string; readonly stderr: string; readonly t: TeamConversationProps['t'] }) {
  return <div className={css.tails}>
    <section>
      <h4>{t('subscriptionRunStdout')}</h4>
      <pre>{stdout === '' ? t('subscriptionRunEmpty') : stdout}</pre>
    </section>
    <section>
      <h4>{t('subscriptionRunStderr')}</h4>
      <pre>{stderr === '' ? t('subscriptionRunEmpty') : stderr}</pre>
    </section>
  </div>
}

function SubscriptionDeleteDialog({ entry, workspaceId, projectRef, deleteSubscription, onClose, onDeleted, t }: {
  readonly entry: AgentTeamSubscriptionListEntry
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly deleteSubscription: TeamSubscriptionHost['deleteSubscription']
  readonly onClose: () => void
  readonly onDeleted: () => void
  readonly t: TeamConversationProps['t']
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string>()
  const confirm = async (): Promise<void> => {
    if (deleting) return
    setDeleting(true)
    setError(undefined)
    try {
      const result = await deleteSubscription({
        requestId: mintRequestId(), workspaceId, projectRef,
        subscriptionRef: entry.subscription.subscriptionRef, expectedRevision: entry.subscription.revision,
      })
      if (!result.ok) { setError(result.error.message); return }
      onDeleted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDeleting(false)
    }
  }
  return <Modal
    open
    onClose={onClose}
    title={t('subscriptionDeleteTitle', { name: entry.subscription.name })}
    closeLabel={t('close')}
    footer={<>
      <Button variant="outline" disabled={deleting} onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={deleting} onClick={() => { void confirm() }}>{deleting ? t('subscriptionDeleting') : t('subscriptionDeleteConfirm')}</Button>
    </>}
  >
    <p className={css.notice}>{t('subscriptionDeleteNotice')}</p>
    {error !== undefined && <p className={css.error} role="alert">{t('subscriptionDeleteFailed', { message: error })}</p>}
  </Modal>
}

/**
 * The deliveries whose automatic retries are spent: the owner's own list, because
 * a record carries the request body it arrived with. Replaying one is an explicit
 * action against the version the owner picks, and the Host answers what it did.
 */
function SubscriptionDeliveriesDialog({ entry, workspaceId, projectRef, loadSubscriptionDeliveries, replaySubscriptionDelivery,
  onClose, onChanged, t }: {
  readonly entry: AgentTeamSubscriptionListEntry
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  /** The two Host calls travel on their own, so the dialog's read depends on them and not on a render-scoped bundle. */
  readonly loadSubscriptionDeliveries: TeamSubscriptionHost['loadSubscriptionDeliveries']
  readonly replaySubscriptionDelivery: TeamSubscriptionHost['replaySubscriptionDelivery']
  readonly onClose: () => void
  readonly onChanged: () => void
  readonly t: TeamConversationProps['t']
}) {
  const subscriptionRef = entry.subscription.subscriptionRef
  const [deliveries, setDeliveries] = useState<readonly AgentTeamSubscriptionDeliveryEntry[]>()
  const [error, setError] = useState<string>()
  const [reloadToken, setReloadToken] = useState(0)
  const [replaying, setReplaying] = useState<string>()
  const [replayed, setReplayed] = useState<string>()
  const [replayError, setReplayError] = useState<string>()
  const [version, setVersion] = useState<AgentTeamSubscriptionReplayVersion>('current')
  const versionGroup = useId()
  useEffect(() => {
    let mounted = true
    setError(undefined)
    void loadSubscriptionDeliveries({ workspaceId, projectRef, subscriptionRef }).then(
      result => {
        if (!mounted) return
        if (result.ok) { setDeliveries(result.value.deliveries); setError(undefined) } else setError(result.error.message)
      },
      (cause: unknown) => { if (mounted) setError(cause instanceof Error ? cause.message : String(cause)) },
    )
    return () => { mounted = false }
  }, [workspaceId, projectRef, subscriptionRef, loadSubscriptionDeliveries, reloadToken])

  const replay = async (deliveryRef: string): Promise<void> => {
    if (replaying !== undefined) return
    setReplaying(deliveryRef)
    setReplayError(undefined)
    setReplayed(undefined)
    try {
      const result = await replaySubscriptionDelivery({ requestId: mintRequestId(), workspaceId, projectRef, subscriptionRef, deliveryRef, version })
      if (!result.ok) {
        setReplayError(t('subscriptionDeliveryReplayFailed', { message: result.error.message }))
        return
      }
      if (result.value.kind === 'replay-failed') {
        setReplayError(t('subscriptionDeliveryReplayFailed', { message: result.value.reason ?? entry.subscription.name }))
        return
      }
      setReplayed(t('subscriptionDeliveryReplayed', { count: result.value.eventCount ?? 0 }))
      // The Host is the list: a delivery that replayed successfully is gone.
      setReloadToken(token => token + 1)
      onChanged()
    } catch (cause) {
      setReplayError(t('subscriptionDeliveryReplayFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setReplaying(undefined)
    }
  }

  return <Modal
    open
    onClose={onClose}
    title={t('subscriptionDeliveriesTitle', { name: entry.subscription.name })}
    description={t('subscriptionDeliveriesDescription')}
    closeLabel={t('close')}
    className={css.dialogWide!}
    footer={<Button variant="outline" onClick={onClose}>{t('close')}</Button>}
  >
    {deliveries === undefined && error === undefined && <p className={css.hint}>{t('subscriptionsLoading')}</p>}
    {error !== undefined && <SurfaceError message={t('subscriptionDeliveriesFailed', { message: error })} retry={t('retry')}
      onRetry={() => { setReloadToken(token => token + 1) }} />}
    {deliveries !== undefined && error === undefined && deliveries.length === 0 && <p className={css.hint}>{t('subscriptionDeliveriesEmpty')}</p>}
    {deliveries !== undefined && deliveries.length > 0 && <fieldset className={css.fieldset}>
      <legend>{t('subscriptionReplayVersion')}</legend>
      <label className={css.radioRow}>
        <input type="radio" name={versionGroup} checked={version === 'current'} disabled={replaying !== undefined}
          onChange={() => { setVersion('current') }} />
        <span>{t('subscriptionReplayVersionCurrent')}</span>
      </label>
      <label className={css.radioRow}>
        <input type="radio" name={versionGroup} checked={version === 'received'} disabled={replaying !== undefined}
          onChange={() => { setVersion('received') }} />
        <span>{t('subscriptionReplayVersionReceived')}</span>
      </label>
      <p className={css.hint}>{t('subscriptionReplayVersionHint')}</p>
    </fieldset>}
    {replayed !== undefined && <p className={css.notice} role="status">{replayed}</p>}
    {replayError !== undefined && <p className={css.error} role="alert">{replayError}</p>}
    {deliveries !== undefined && deliveries.length > 0 && <div className={css.listViewport}>
      <ol className={css.runList}>
        {deliveries.map(delivery => <li className={css.runRow} key={delivery.deliveryRef} data-team-delivery-ref={delivery.deliveryRef}>
          <div className={css.runHead}>
            <code className={css.runMeta}>{delivery.deliveryRef}</code>
            <span className={css.runMeta}>{t('subscriptionDeliveryLine', {
              attempts: delivery.attempts, received: timeLabel(delivery.receivedAt), expires: timeLabel(delivery.expiresAt),
            })}</span>
          </div>
          <p className={css.trialFailure}>{t('subscriptionDeliveryLastError', { message: delivery.lastError })}</p>
          <div className={css.actions}>
            <Button size="sm" variant="outline" disabled={replaying !== undefined} aria-label={`${t('subscriptionDeliveryReplay')} · ${delivery.deliveryRef}`}
              onClick={() => { void replay(delivery.deliveryRef) }}>
              {replaying === delivery.deliveryRef ? t('subscriptionDeliveryReplaying') : t('subscriptionDeliveryReplay')}
            </Button>
          </div>
        </li>)}
      </ol>
    </div>}
  </Modal>
}

/**
 * The one place a complete address is shown. Closing it forgets the address:
 * the Host keeps a hash, so nothing can show it again except a reset.
 */
function SubscriptionWebhookAddressDialog({ name, address, onClose, t }: {
  readonly name: string
  readonly address: string
  readonly onClose: () => void
  readonly t: TeamConversationProps['t']
}) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return <Modal
    open
    onClose={onClose}
    title={t('subscriptionWebhookAddressTitle', { name })}
    description={t('subscriptionWebhookAddressOnce')}
    closeLabel={t('close')}
    footer={<Button variant="outline" onClick={onClose}>{t('close')}</Button>}
  >
    <p className={css.webhookAddress}><code data-team-webhook-address>{address}</code></p>
    <div className={css.actions}>
      <Button size="sm" variant="outline" autoFocus onClick={() => { void copy() }}>
        {copied ? t('subscriptionWebhookAddressCopied') : t('subscriptionWebhookAddressCopy')}
      </Button>
    </div>
    <p className={css.hint}>{t('subscriptionWebhookRegisterHint')}</p>
  </Modal>
}

/**
 * The answer a retried save or reset gets: the address armed once at the commit
 * and cannot be fetched again, so the reader is told that instead of nothing.
 */
function SubscriptionWebhookGoneDialog({ name, onClose, t }: {
  readonly name: string
  readonly onClose: () => void
  readonly t: TeamConversationProps['t']
}) {
  return <Modal
    open
    onClose={onClose}
    title={t('subscriptionWebhookGoneTitle', { name })}
    description={t('subscriptionWebhookGoneBody')}
    closeLabel={t('close')}
    footer={<Button variant="outline" onClick={onClose}>{t('close')}</Button>}
  />
}

function SubscriptionEditorDialog({ mode, workspaceId, projectRef, host, onClose, onChanged, onArmed, t }: {
  readonly mode: EditorMode
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly host: TeamSubscriptionHost
  readonly onClose: () => void
  readonly onChanged: () => void
  /** The address a save armed, handed up to the dialog that shows it once. */
  readonly onArmed: (armed: { readonly name: string; readonly address: string } | { readonly name: string; readonly gone: true }) => void
  readonly t: TeamConversationProps['t']
}) {
  const editing = mode.kind === 'edit' ? mode.entry.subscription : undefined
  const formId = useId()
  const [name, setName] = useState(editing?.name ?? '')
  const [minutes, setMinutes] = useState(String(editing?.triggers.interval?.minutes ?? 10))
  // A subscription runs on a timer, on a webhook, or on both: the form edits the
  // triggers as a pair rather than assuming the timer is always there.
  const [timer, setTimer] = useState(editing === undefined || editing.triggers.interval !== undefined)
  const [webhook, setWebhook] = useState(editing?.triggers.webhook === true)
  const [script, setScript] = useState(editing?.script.content ?? '')
  const [credentials, setCredentials] = useState<readonly { readonly ref: string; readonly env: string }[]>(editing?.credentials ?? [])
  const [baseline, setBaseline] = useState<'current-output' | 'ignore-history'>('current-output')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [trial, setTrial] = useState<TrialView>()
  const [tested, setTested] = useState<AgentTeamSubscriptionDraftTrialResult>()
  const [testError, setTestError] = useState<string>()
  const [saveError, setSaveError] = useState<string>()
  const requestIdRef = useRef<string>()
  const busy = testing || saving

  // Save is enabled by a trial of this exact form, never by an older one: an
  // edit and a fresh trial both retire the pass, so a form whose latest attempt
  // failed cannot be saved on the strength of an earlier success.
  const invalidate = (): void => {
    setTested(undefined)
    setTrial(undefined)
    setTestError(undefined)
    setSaveError(undefined)
    requestIdRef.current = undefined
  }
  const minuteValue = Number(minutes)
  const minutesValid = Number.isInteger(minuteValue) && minuteValue >= 5
  const scriptBytes = new TextEncoder().encode(script).length
  const scriptBytesValid = scriptBytes <= 16 * 1024
  const credentialsValid = credentials.every(row => row.ref.trim() !== '' && row.env.trim() !== '')
  const triggersValid = webhook || (timer && minutesValid)
  const canTest = !busy && name.trim() !== '' && triggersValid && script.trim() !== '' && scriptBytesValid && credentialsValid

  /** The triggers as the Host reads them: an interval only when the timer is on, the webhook always when editing. */
  const triggers = {
    ...(timer ? { intervalMinutes: minuteValue } : {}),
    ...(editing === undefined ? (webhook ? { webhook: true } : {}) : { webhook }),
  }

  const cleanCredentials = (): readonly { readonly ref: string; readonly env: string }[] => credentials.map(row => ({ ref: row.ref.trim(), env: row.env.trim() }))

  const runTrial = async (): Promise<void> => {
    if (!canTest) return
    setTesting(true)
    setTestError(undefined)
    setTrial(undefined)
    // The verdict about to be replaced stops unlocking Save the moment the next
    // attempt starts: a pass is a statement about the latest trial, not any trial.
    setTested(undefined)
    try {
      const result = await host.testSubscriptionDraft({
        workspaceId, projectRef,
        ...(editing === undefined ? {} : { subscriptionRef: editing.subscriptionRef, expectedRevision: editing.revision }),
        name: name.trim(), ...triggers, scriptContent: script, credentials: cleanCredentials(),
      })
      if (!result.ok) { setTestError(result.error.message); return }
      setTrial(result.value)
      if (result.value.kind === 'tested') setTested(result.value)
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    if (tested === undefined || busy || !canTest) return
    setSaving(true)
    setSaveError(undefined)
    try {
      // A retry of the same form keeps its request id, so a lost response cannot
      // store a second subscription or apply an edit twice.
      const requestId = (requestIdRef.current ?? mintRequestId()) as AgentTeamCreateSubscriptionRequest['requestId']
      requestIdRef.current = requestId
      const shared = {
        requestId, workspaceId, projectRef, name: name.trim(), ...triggers,
        script: { scriptContent: script }, credentials: cleanCredentials(),
      }
      const result = editing === undefined
        ? await host.createSubscription({ ...shared, baseline })
        : await host.updateSubscription({
          ...shared, subscriptionRef: editing.subscriptionRef, expectedRevision: editing.revision,
        } as AgentTeamUpdateSubscriptionRequest)
      if (!result.ok) { setSaveError(result.error.message); return }
      if (result.value.kind === 'trial-failed') {
        setTrial(result.value)
        setTested(undefined)
        return
      }
      // The save that armed or reset the address is the only answer that carries
      // it: show it before the form closes, or it is lost with the request.
      if (result.value.webhookAddress !== undefined) {
        onArmed({ name: name.trim(), address: result.value.webhookAddress })
      }
      // A retried save answers without the address, so it says why instead.
      if (result.value.webhookAddressGone === true) {
        onArmed({ name: name.trim(), gone: true })
      }
      onChanged()
      onClose()
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const title = editing === undefined ? t('subscriptionFormCreateTitle') : t('subscriptionFormEditTitle')
  return <Modal
    open
    onClose={onClose}
    title={title}
    description={t('subscriptionFormDescription')}
    closeLabel={t('close')}
    className={css.dialogWide!}
    footer={<>
      <Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      <Button variant="outline" disabled={!canTest} onClick={() => { void runTrial() }}>{testing ? t('subscriptionTesting') : t('subscriptionTest')}</Button>
      <Button type="submit" form={formId} variant="primary" disabled={tested === undefined || busy || !canTest}>{saving ? t('subscriptionSaving') : t('subscriptionSave')}</Button>
    </>}
  >
    <div className={css.formViewport}>
      <form id={formId} className={createCss.form} onSubmit={event => { event.preventDefault(); void save() }}>
        <label className={createCss.field}>
          <span>{t('subscriptionName')}</span>
          <Input className={createCss.input!} value={name} maxLength={80} disabled={busy} autoFocus onChange={event => { invalidate(); setName(event.target.value) }} />
        </label>
        <fieldset className={css.fieldset}>
          <legend>{t('subscriptionTrigger')}</legend>
          <label className={css.triggerChoice}>
            <input type="checkbox" checked={timer} disabled={busy} onChange={event => { invalidate(); setTimer(event.target.checked) }} />
            <span>{t('subscriptionTimerEnable')}</span>
          </label>
          {timer && <span className={css.intervalRow}>
            <span>{t('subscriptionEveryPrefix')}</span>
            <Input
              className={css.minutesInput!}
              type="number"
              min={5}
              step={1}
              value={minutes}
              disabled={busy}
              aria-invalid={!minutesValid}
              aria-label={t('subscriptionMinutes')}
              onChange={event => { invalidate(); setMinutes(event.target.value) }}
            />
            <span>{t('subscriptionMinutes')}</span>
          </span>}
          <label className={css.triggerChoice}>
            <input type="checkbox" checked={webhook} disabled={busy} onChange={event => { invalidate(); setWebhook(event.target.checked) }} />
            <span>{t('subscriptionWebhookArm')}</span>
          </label>
          {webhook && <p className={css.hint}>{t('subscriptionWebhookHint')}</p>}
          {!triggersValid && <p className={css.error} role="alert">{t('subscriptionNoTrigger')}</p>}
        </fieldset>
        {timer && <p className={css.hint}>{t('subscriptionIntervalHint')}</p>}
        <p className={css.hint}>{t('subscriptionZoneNow', { utc: formatUtc8(new Date().toISOString()), local: formatAbsoluteTime(new Date().toISOString()) })}</p>
        {mode.kind === 'edit' && mode.entry.nextRunAt !== undefined && <p className={css.hint}>{t('subscriptionNextRun', {
          utc: formatUtc8(mode.entry.nextRunAt), local: timeLabel(mode.entry.nextRunAt),
        })}</p>}

        <fieldset className={css.fieldset}>
          <legend>{t('subscriptionCredentials')}</legend>
          {credentials.map((credential, index) => <div className={css.credentialRow} key={index}>
            <Input
              className={createCss.input!}
              aria-label={t('subscriptionCredentialRef', { index: index + 1 })}
              placeholder={t('subscriptionCredentialRef', { index: index + 1 })}
              value={credential.ref}
              disabled={busy}
              onChange={event => {
                invalidate()
                setCredentials(rows => rows.map((row, at) => at === index ? { ...row, ref: event.target.value } : row))
              }}
            />
            <Input
              className={createCss.input!}
              aria-label={t('subscriptionCredentialEnv', { index: index + 1 })}
              placeholder="ENV_NAME"
              value={credential.env}
              disabled={busy}
              onChange={event => {
                invalidate()
                setCredentials(rows => rows.map((row, at) => at === index ? { ...row, env: event.target.value } : row))
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={t('subscriptionCredentialRemove', { index: index + 1 })}
              onClick={() => { invalidate(); setCredentials(rows => rows.filter((_row, at) => at !== index)) }}
            >{t('subscriptionCredentialRemoveShort')}</Button>
          </div>)}
          {credentials.length < 8 && <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => { invalidate(); setCredentials(rows => [...rows, { ref: '', env: '' }]) }}
          >{t('subscriptionCredentialAdd')}</Button>}
          <p className={css.hint}>{t('subscriptionCredentialsHint')}</p>
        </fieldset>

        <label className={createCss.field}>
          <span>{t('subscriptionScriptLabel')}</span>
          <textarea
            className={css.scriptInput}
            value={script}
            rows={10}
            spellCheck={false}
            disabled={busy}
            aria-invalid={!scriptBytesValid}
            onChange={event => { invalidate(); setScript(event.target.value) }}
          />
        </label>
        <p className={css.hint} data-invalid={!scriptBytesValid}>{t('subscriptionScriptHint', { bytes: scriptBytes, limit: 16 * 1024 })}</p>
        {!scriptBytesValid && <p className={css.error} role="alert">{t('subscriptionScriptTooLarge', { limit: 16 * 1024 })}</p>}

        {mode.kind === 'create' && <fieldset className={css.fieldset}>
          <legend>{t('subscriptionBaseline')}</legend>
          <label className={css.radioRow}>
            <input type="radio" name={`${formId}-baseline`} checked={baseline === 'current-output'} disabled={busy} onChange={() => { invalidate(); setBaseline('current-output') }} />
            <span>{t('subscriptionBaselineCurrent')}</span>
          </label>
          <label className={css.radioRow}>
            <input type="radio" name={`${formId}-baseline`} checked={baseline === 'ignore-history'} disabled={busy} onChange={() => { invalidate(); setBaseline('ignore-history') }} />
            <span>{t('subscriptionBaselineIgnore')}</span>
          </label>
          <p className={css.hint}>{t('subscriptionBaselineHint')}</p>
        </fieldset>}
      </form>
    </div>
    {/* The verdict stays above the footer: the form scrolls, so a pass or a
        refusal must not be able to sit below the fold of what it unlocks. */}
    <div className={css.verdict}>
      {testError !== undefined && <p className={css.error} role="alert">{t('subscriptionTestError', { message: testError })}</p>}
      {trial?.kind === 'trial-failed' && <div className={css.trialFailure} role="alert">
        <p>{t('subscriptionTestFailed', { reason: trial.failure.reason })}</p>
        <details className={css.failureDetails}>
          <summary>{t('subscriptionShowOutput')}</summary>
          <OutputTails stdout={trial.failure.stdoutTail} stderr={trial.failure.stderrTail} t={t} />
        </details>
      </div>}
      {trial?.kind === 'tested' && <div className={css.trialPass} role="status">
        <p>{t('subscriptionTestPass', { count: trial.events.length })}</p>
        <p className={css.hint}>{t('subscriptionTestHash', { hash: trial.scriptHash.slice(0, 12), revision: trial.revision })}</p>
        <details className={css.failureDetails}>
          <summary>{t('subscriptionShowOutput')}</summary>
          <OutputTails stdout={trial.stdoutTail} stderr={trial.stderrTail} t={t} />
        </details>
      </div>}
      {saveError !== undefined && <p className={css.error} role="alert">{t('subscriptionSaveFailed', { message: saveError })}</p>}
      {tested === undefined && trial === undefined && <p className={css.hint}>{t('subscriptionTestRequired')}</p>}
    </div>
  </Modal>
}

/** The triggers a reader sees, named as the pair the form edits. */
function triggerText(triggers: AgentTeamSubscription['triggers'], t: TeamConversationProps['t']): string {
  // Two triggers are one subscription: naming only the timer would hide the
  // address that is also armed.
  const parts = [
    ...(triggers.interval === undefined ? [] : [t('subscriptionEvery', { minutes: triggers.interval.minutes })]),
    ...(triggers.webhook === true ? [t('subscriptionWebhook')] : []),
  ]
  return parts.length === 0 ? t('subscriptionNoTrigger') : parts.join(' · ')
}

function triggerLabel(trigger: AgentTeamSubscriptionLogEntry['trigger'], t: TeamConversationProps['t']): string {
  return t(trigger === 'interval' ? 'subscriptionTriggerInterval'
    : trigger === 'webhook' ? 'subscriptionTriggerWebhook' : 'subscriptionTriggerTest')
}

const RUN_CATEGORY_KEYS = {
  accepted: 'subscriptionCategoryAccepted',
  empty: 'subscriptionCategoryEmpty',
  verified: 'subscriptionCategoryVerified',
  timeout: 'subscriptionCategoryTimeout',
  'exit-code': 'subscriptionCategoryExitCode',
  'stdout-truncated': 'subscriptionCategoryStdoutTruncated',
  'invalid-utf8': 'subscriptionCategoryInvalidUtf8',
  'invalid-output': 'subscriptionCategoryInvalidOutput',
  'executor-missing': 'subscriptionCategoryExecutorMissing',
  'shell-mismatch': 'subscriptionCategoryShellMismatch',
  'workspace-missing': 'subscriptionCategoryWorkspaceMissing',
  'credentials-missing': 'subscriptionCategoryCredentialsMissing',
  'spawn-failed': 'subscriptionCategorySpawnFailed',
  'backlog-full': 'subscriptionCategoryBacklogFull',
} as const satisfies Record<AgentTeamSubscriptionRunSummary['category'], TeamKey>

function runCategoryText(category: AgentTeamSubscriptionRunSummary['category'], t: TeamConversationProps['t']): string {
  return t(RUN_CATEGORY_KEYS[category])
}

function pausedText(entry: AgentTeamSubscriptionListEntry, t: TeamConversationProps['t']): string {
  if (entry.subscription.pausedReason !== 'failures') return t('subscriptionPausedManual')
  const failure = entry.lastRun === undefined || entry.lastRun.trigger === 'test' ? undefined : entry.lastRun
  return failure === undefined ? t('subscriptionPausedFailures')
    : t('subscriptionPausedFailuresWithCategory', { category: runCategoryText(failure.category, t) })
}

function timeLabel(instant: string): string {
  return formatAbsoluteTime(instant)
}

function formatUtc8(instant: string): string {
  const at = new Date(instant)
  if (Number.isNaN(at.getTime())) return ''
  const shifted = new Date(at.getTime() + 8 * 3_600_000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}
