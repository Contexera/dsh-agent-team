import type { DefineToolOptions, InferValue } from '@deepseek-ai/dsh-tools'

const SUBSCRIPTION_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    subscriptionRef: { type: 'string' }, name: { type: 'string' },
    state: { type: 'string' }, revision: { type: 'number' }, intervalMinutes: { type: 'number' },
    webhook: { type: 'boolean' }, unpublished: { type: 'number' },
    notify: { type: 'array', items: { type: 'string' } },
  },
} as const

const RUN_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    runRef: { type: 'string', required: true }, trigger: { type: 'string', required: true },
    startedAt: { type: 'string', required: true }, durationMs: { type: 'number', required: true },
    category: { type: 'string', required: true }, succeeded: { type: 'boolean', required: true },
    eventCount: { type: 'number', required: true }, exitCode: { type: 'number' }, timedOut: { type: 'boolean', required: true },
    subscriptionRevision: { type: 'number', required: true }, scriptHash: { type: 'string' },
    attempt: { type: 'number' }, deliveryRef: { type: 'string' },
    reason: { type: 'string' }, stdoutTail: { type: 'string' }, stderrTail: { type: 'string' },
  },
} as const

const DELIVERY_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    deliveryRef: { type: 'string', required: true }, receivedRevision: { type: 'number', required: true },
    receivedAt: { type: 'string', required: true }, expiresAt: { type: 'string', required: true },
    attempts: { type: 'number', required: true }, lastError: { type: 'string', required: true },
  },
} as const

const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true },
    workspaceId: { type: 'string', required: true },
    projectRef: { type: 'string', required: true },
    subscriptionRef: { type: 'string' }, name: { type: 'string' }, state: { type: 'string' },
    revision: { type: 'number' }, intervalMinutes: { type: 'number' }, webhook: { type: 'boolean' },
    webhookAddress: { type: 'string' }, webhookAddressGone: { type: 'boolean' }, unpublished: { type: 'number' },
    notify: { type: 'array', items: { type: 'string' } },
    baselineIds: { type: 'array', items: { type: 'string' } },
    // One rendered line per event: what the script printed, quoted as data.
    events: { type: 'array', items: { type: 'string' } },
    stdoutTail: { type: 'string' }, stderrTail: { type: 'string' }, reason: { type: 'string' },
    subscriptions: { type: 'array', items: SUBSCRIPTION_SCHEMA },
    runs: { type: 'array', items: RUN_SCHEMA },
    deliveries: { type: 'array', items: DELIVERY_SCHEMA },
    runRef: { type: 'string' },
    eventCount: { type: 'number' },
  },
} as const

export type SubscriptionResult = InferValue<typeof OUTPUT_SCHEMA>

function notifyLine(notify: readonly string[]): string {
  return notify.length === 0 ? 'notify: nobody (published to the timeline only)' : `notify: ${notify.join(', ')}`
}

function triggersOf(subscription: { readonly intervalMinutes?: number | undefined; readonly webhook?: boolean | undefined }): string {
  const timer = subscription.intervalMinutes === undefined ? '' : `every ${subscription.intervalMinutes} min`
  if (!subscription.webhook) return timer
  return timer === '' ? 'webhook' : `${timer} + webhook`
}

type RenderedRun = NonNullable<SubscriptionResult['runs']>[number]

function runLine(run: RenderedRun): string {
  const exit = run.timedOut ? ' · timed out' : run.exitCode === undefined ? '' : ` · exit ${run.exitCode}`
  const delivery = run.deliveryRef === undefined ? '' : ` · ${run.deliveryRef} attempt ${run.attempt ?? 0}`
  return `${run.startedAt} · ${run.trigger} · ${run.category} · ${run.eventCount} event${run.eventCount === 1 ? '' : 's'} · r${run.subscriptionRevision}${delivery} · ${run.durationMs} ms${exit}`
}

function outcomeLine(run: RenderedRun): string {
  return run.succeeded ? run.category : `${run.category}: ${run.reason ?? 'no reason recorded'}`
}

function outputLines(run: RenderedRun): string {
  // Distinguish a summary-only response from an owner-visible run that printed nothing.
  if (run.stdoutTail === undefined) return ''
  return `\n  stdout tail:\n${run.stdoutTail || '(empty)'}\n  stderr tail:\n${run.stderrTail || '(empty)'}`
}

export const subscriptionOutput = {
  schema: OUTPUT_SCHEMA,
  render: (_args, value) => {
    const where = `Workspace: ${value.workspaceId} · Project: ${value.projectRef}`
    if (value.kind === 'list') {
      const rows = (value.subscriptions ?? []).map(row => `- ${row.subscriptionRef} — ${row.name} · ${row.state} · r${row.revision} · ${triggersOf(row)}${row.notify === undefined ? '' : ` · ${notifyLine(row.notify)}`}${row.unpublished === 0 ? '' : ` · ${row.unpublished} waiting to publish`}`)
      return [{ type: 'text', text: `${where}\nSubscriptions (${rows.length}):\n${rows.length === 0 ? '- none' : rows.join('\n')}` }]
    }
    if (value.kind === 'trial-failed') {
      return [{ type: 'text', text: `${where}\nThe trial run failed, so nothing changed: ${value.reason ?? 'unknown reason'}\nstdout tail:\n${value.stdoutTail || '(empty)'}\nstderr tail:\n${value.stderrTail || '(empty)'}` }]
    }
    if (value.kind === 'tested') {
      const events = (value.events ?? []).map(line => `- ${line}`)
      return [{ type: 'text', text: `${where}\nTrial run passed — ${events.length} event${events.length === 1 ? '' : 's'} in the sample output${events.length === 0 ? '' : `:\n${events.join('\n')}`}\nA trial never changes the deduplication waterline or the failure count.` }]
    }
    if (value.kind === 'logs') {
      const runs = value.runs ?? []
      const lines = runs.map(run => `- ${runLine(run)}\n  ${outcomeLine(run)}${outputLines(run)}`)
      const summariesOnly = runs.some(run => run.stdoutTail === undefined)
      return [{ type: 'text', text: `${where}\nRun history of ${value.name ?? value.subscriptionRef} (${value.subscriptionRef}), newest first (${runs.length}):\n${runs.length === 0 ? '- none recorded yet' : lines.join('\n')}${summariesOnly ? '\nOnly a Project owner sees what a run printed; you are seeing summaries.' : ''}` }]
    }
    if (value.kind === 'deliveries') {
      const deliveries = value.deliveries ?? []
      const lines = deliveries.map(entry => `- ${entry.deliveryRef} · ${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'} spent · received ${entry.receivedAt} at r${entry.receivedRevision} · expires ${entry.expiresAt}\n  last error: ${entry.lastError}`)
      return [{ type: 'text', text: `${where}\nFailed deliveries of ${value.name ?? value.subscriptionRef} (${value.subscriptionRef}), newest first (${deliveries.length}):\n${deliveries.length === 0 ? '- none: every delivery was handled' : lines.join('\n')}` }]
    }
    if (value.kind === 'replayed' || value.kind === 'replay-failed') {
      // A replay that prints nothing new is a success with nothing to publish,
      // not a delivery: saying it "delivered what it printed" would be false.
      const events = value.eventCount ?? 0
      const detail = value.kind !== 'replayed'
        ? `the run did not deliver: ${value.reason ?? 'unknown reason'}\nstdout tail:\n${value.stdoutTail || '(empty)'}\nstderr tail:\n${value.stderrTail || '(empty)'}`
        : events === 0
          ? `the run passed and printed nothing new, so nothing was published${value.runRef === undefined ? '' : ` (${value.runRef})`}`
          : `the run passed; ${events} event${events === 1 ? '' : 's'} accepted for publication${value.runRef === undefined ? '' : ` (${value.runRef})`}`
      return [{ type: 'text', text: `${where}\nReplay of ${value.subscriptionRef} — ${detail}` }]
    }
    if (value.kind === 'baselined') {
      const ids = value.baselineIds ?? []
      return [{ type: 'text', text: `${where}\n${value.name ?? value.subscriptionRef} now ignores ${ids.length} more id${ids.length === 1 ? '' : 's'}: ${ids.join(', ') || '(none)'}. Earlier ids stay recorded, and events already accepted still publish.` }]
    }
    const interval = value.intervalMinutes === undefined ? '' : ` · every ${value.intervalMinutes} min`
    const hook = value.webhook === true ? ' · webhook' : ''
    // The address is on the answer exactly when this call armed or reset it,
    // so the render says both the address and that no later read repeats it.
    const address = value.webhookAddress === undefined ? ''
      : `\nWebhook address: ${value.webhookAddress}\nRegister it with the provider now: only its hash is stored, so this is the one time it is shown. Call reset_webhook if it is lost.`
    const gone = value.webhookAddressGone === true
      ? '\nThe webhook address was shown once when this change committed and cannot be fetched again; call reset_webhook to arm a new one.'
      : ''
    return [{ type: 'text', text: `${where}\n${value.kind}: ${value.name ?? 'subscription'} (${value.subscriptionRef}) · ${value.state ?? 'active'} · r${value.revision ?? 1}${interval}${hook}${address}${gone}${value.notify === undefined ? '' : `\n${notifyLine(value.notify)}`}` }]
  },
} satisfies DefineToolOptions<{}, typeof OUTPUT_SCHEMA>['output']
