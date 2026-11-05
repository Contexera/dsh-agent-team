import { useEffect, useId, useState } from 'react'
import type {
  AgentTeamMemberId,
  AgentTeamProjectRef,
  AgentTeamSubscription,
  AgentTeamSubscriptionListEntry,
  AgentTeamSubscriptionLogEntry,
  AgentTeamSubscriptionRunSummary,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconChevronDownOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamKey } from './locales.ts'
import { mintRequestId } from './requests.ts'
import { formatAbsoluteTime, formatInboxTime } from './team-formatters.ts'
import css from './subscriptions.module.css'
import conversationCss from './conversation.module.css'

type TeamSubscriptionHost = Pick<TeamConversationProps,
  'loadSubscriptionLogs' | 'pauseSubscription' | 'resumeSubscription' | 'deleteSubscription'>

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

type PendingAction = { readonly ref: string; readonly kind: 'pause' | 'resume' }

/** One subscription's failing write, kept beside the card so two failures never collapse into one line. */
interface CardFailure {
  readonly ref: string
  readonly message: string
}

/**
 * The Project's subscription tab. A Project owner arms and maintains a
 * subscription through `team_subscription`, so the Human's surface reads what is
 * armed and may only stop or remove what an owner started.
 */
export function TeamSubscriptionsTab({
  workspaceId, projectRef, host, entries, loading, error, onRetry, onChanged, canManage, memberOf, panelId, labelledBy, t,
}: TeamSubscriptionsTabProps) {
  const [scriptOf, setScriptOf] = useState<AgentTeamSubscriptionListEntry>()
  const [logsOf, setLogsOf] = useState<AgentTeamSubscriptionListEntry>()
  const [deleting, setDeleting] = useState<AgentTeamSubscriptionListEntry>()
  const [pending, setPending] = useState<PendingAction>()
  const [failure, setFailure] = useState<CardFailure>()

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
      onChanged()
    } catch (cause) {
      setFailure({ ref, message: t('subscriptionActionFailed', { message: cause instanceof Error ? cause.message : String(cause) }) })
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
      </div>}
      {!loading && error === undefined && live.map(entry => <SubscriptionCard
        key={entry.subscription.subscriptionRef}
        entry={entry}
        canManage={canManage}
        owner={memberOf(entry.subscription.createdBy)?.handle ?? t('memberUnknown')}
        pending={pending !== undefined && pending.ref === entry.subscription.subscriptionRef ? pending.kind : undefined}
        failure={failure?.ref === entry.subscription.subscriptionRef ? failure : undefined}
        t={t}
        onScript={() => { setScriptOf(entry) }}
        onLogs={() => { setLogsOf(entry) }}
        onPause={() => { void runStateAction(entry, 'pause') }}
        onResume={() => { void runStateAction(entry, 'resume') }}
        onDelete={() => { setDeleting(entry) }}
      />)}
      {!loading && error === undefined && live.length > 0 && <p className={css.ownerNote}>{t('subscriptionsOwnerNote')}</p>}
    </div>

    {scriptOf !== undefined && <SubscriptionScriptDialog
      entry={scriptOf}
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

function SubscriptionCard({ entry, canManage, owner, pending, failure, t, onScript, onLogs, onPause, onResume, onDelete }: {
  readonly entry: AgentTeamSubscriptionListEntry
  readonly canManage: boolean
  readonly owner: string
  readonly pending: PendingAction['kind'] | undefined
  readonly failure: CardFailure | undefined
  readonly t: TeamConversationProps['t']
  readonly onScript: () => void
  readonly onLogs: () => void
  readonly onPause: () => void
  readonly onResume: () => void
  readonly onDelete: () => void
}) {
  const { subscription } = entry
  const name = subscription.name
  const paused = subscription.state === 'paused'
  const named = (label: string): string => `${label} · ${name}`
  const lastRun = entry.lastRun
  // Two declared lines rather than a wrapped run of facts: a separator that wraps
  // to the head of a line reads as a stray mark. Times use the short reader clock,
  // the same one the run history names.
  const runFacts = [
    lastRun === undefined ? t('subscriptionLastRunNever') : t('subscriptionLastRun', { time: formatInboxTime(lastRun.startedAt, t) }),
    ...(entry.nextRunAt === undefined ? [] : [t('subscriptionNextRunAt', { time: formatInboxTime(entry.nextRunAt, t) })]),
  ].join(' · ')
  const eventFacts = [
    ...(entry.eventCount > 0 ? [t('subscriptionEventCount', { count: entry.eventCount })] : []),
    ...(entry.unpublished > 0 ? [t('subscriptionUnpublished', { count: entry.unpublished })] : []),
  ].join(' · ')
  return <article className={css.card} data-team-subscription-ref={subscription.subscriptionRef} data-subscription-state={subscription.state}>
    <div className={css.cardHead}>
      <h3 className={css.cardName}>{name}</h3>
      <span className={css.trigger}>{triggerText(subscription.triggers, t)}</span>
      <span className={css.owner}>{t('subscriptionOwner', { name: owner })}</span>
    </div>
    <p className={css.facts}>
      <span>{runFacts}</span>
      {eventFacts !== '' && <span>{eventFacts}</span>}
    </p>
    {paused && <p className={css.paused} data-paused-reason={subscription.pausedReason}>
      {pausedText(entry, t)}
    </p>}
    {failure !== undefined && <div className={css.inlineFailure} role="alert">
      <span>{failure.message}</span>
    </div>}
    {/* Reads stay quiet text; the two controls that change what runs are buttons. */}
    <div className={css.actions}>
      <Button size="sm" variant="ghost" aria-label={named(t('subscriptionLogs'))} onClick={onLogs}>{t('subscriptionLogs')}</Button>
      <Button size="sm" variant="ghost" aria-label={named(t('subscriptionScript'))} onClick={onScript}>{t('subscriptionScript')}</Button>
      {canManage && (paused
        ? <Button size="sm" variant="outline" disabled={pending !== undefined} aria-label={named(pending === 'resume' ? t('subscriptionResuming') : t('subscriptionResume'))} onClick={onResume}>{pending === 'resume' ? t('subscriptionResuming') : t('subscriptionResume')}</Button>
        : <Button size="sm" variant="outline" disabled={pending !== undefined} aria-label={named(pending === 'pause' ? t('subscriptionPausing') : t('subscriptionPause'))} onClick={onPause}>{pending === 'pause' ? t('subscriptionPausing') : t('subscriptionPause')}</Button>)}
      {canManage && <Button size="sm" variant="outline" aria-label={named(t('subscriptionDelete'))} onClick={onDelete}>{t('subscriptionDelete')}</Button>}
    </div>
  </article>
}

function SubscriptionScriptDialog({ entry, onClose, t }: {
  readonly entry: AgentTeamSubscriptionListEntry
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
    footer={<Button variant="outline" onClick={onClose}>{t('close')}</Button>}
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

function RunRow({ run, t }: { readonly run: AgentTeamSubscriptionLogEntry; readonly t: TeamConversationProps['t'] }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  // A tail the Host withheld is not an empty stream, so the expander and the
  // per-stream captions both key off `undefined` rather than off empty text.
  const hasOutput = run.reason !== undefined || run.stdoutTail !== undefined || run.stderrTail !== undefined
  const facts = <>
    <time className={css.runTime} dateTime={run.startedAt} title={formatAbsoluteTime(run.startedAt)}>{formatInboxTime(run.startedAt, t)}</time>
    {run.trigger !== 'test' && <span className={css.runTrigger}>{triggerLabel(run.trigger, t)}</span>}
    <span className={css.runOutcome} data-succeeded={run.succeeded}>{runCategoryText(run.category, t)}</span>
    <span className={css.runMeta}>{t('subscriptionRunDuration', { seconds: (run.durationMs / 1000).toFixed(1) })}</span>
    {run.eventCount > 0 && <span className={css.runMeta}>{t('subscriptionRunEvents', { count: run.eventCount })}</span>}
  </>
  return <li className={css.runRow} data-team-subscription-run={run.runRef} data-run-succeeded={run.succeeded}>
    {/* The whole row is the disclosure target: one hit area, and its accessible
        name is the run it describes rather than a verb floating at the far edge. */}
    {hasOutput
      ? <button type="button" className={css.runHead} data-expandable aria-expanded={expanded} aria-controls={id}
        onClick={() => { setExpanded(value => !value) }}>
        <span className={css.runChevron} data-open={expanded || undefined} aria-hidden="true"><IconChevronDownOutlineRegular /></span>
        {facts}
      </button>
      : <div className={css.runHead}>
        <span className={css.runChevron} aria-hidden="true" />
        {facts}
      </div>}
    {expanded && <div id={id} className={css.runBody} data-team-subscription-run-output>
      {run.reason !== undefined && <p className={css.runReason}>{t('subscriptionRunReason')}: {run.reason}</p>}
      <OutputTails stdout={run.stdoutTail} stderr={run.stderrTail} t={t} />
    </div>}
  </li>
}

function OutputTails({ stdout, stderr, t }: {
  readonly stdout: string | undefined
  readonly stderr: string | undefined
  readonly t: TeamConversationProps['t']
}) {
  // A stream that printed nothing states that in one line; a code block around
  // `(empty)` spends a surface on saying nothing ran.
  const streams = [
    { key: 'stdout', caption: t('subscriptionRunStdout'), value: stdout },
    { key: 'stderr', caption: t('subscriptionRunStderr'), value: stderr },
  ]
  return <div className={css.tails}>
    {streams.map(stream => stream.value === undefined
      ? null
      : stream.value === ''
        ? <p key={stream.key} className={css.runStreamEmpty}>{t('subscriptionRunStreamEmpty', { stream: stream.caption })}</p>
        : <section key={stream.key}>
          <h4>{stream.caption}</h4>
          <pre>{stream.value}</pre>
        </section>)}
  </div>
}

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
