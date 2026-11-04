/**
 * `team_subscription` — the owner-facing tool for Project subscription
 * scripts. It drives the Host's own service surface: every authorization,
 * revision, and revision-pinned run decision belongs to the Host, and this
 * file only shapes arguments, names what happened, and quotes what a script
 * printed as untrusted data.
 * @module @contexera/dsh-agent-team-tools/subscription
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentTeamRequestId, AgentTeamProjectRef, AgentTeamSubscriptionRef } from '@contexera/dsh-agent-team/types'
import type { SubscriptionCredential } from '@contexera/dsh-agent-team/host'
import { service, workspaceOf, workspaceParam } from './host-access.ts'

/** What one tool call answers, and what its render reads back. */
interface SubscriptionResult {
  kind: string
  workspaceId: string
  projectRef: string
  subscriptionRef?: string
  name?: string
  state?: string
  revision?: number
  intervalMinutes?: number
  webhook?: boolean
  /** The complete address, present only on the call that armed it or reset it. */
  webhookAddress?: string
  /** Present when this call is a resolved retry of one that armed the address: it was shown once and cannot be fetched again. */
  webhookAddressGone?: true
  unpublished?: number
  baselineIds?: string[]
  events?: string[]
  stdoutTail?: string
  stderrTail?: string
  reason?: string
  subscriptions?: {
    subscriptionRef: string
    name: string
    state: string
    revision: number
    intervalMinutes?: number
    webhook: boolean
    unpublished: number
  }[]
  runs?: {
    runRef: string
    trigger: string
    startedAt: string
    durationMs: number
    category: string
    succeeded: boolean
    eventCount: number
    exitCode?: number
    timedOut: boolean
    subscriptionRevision: number
    scriptHash?: string
    attempt?: number
    deliveryRef?: string
    reason?: string
    stdoutTail?: string
    stderrTail?: string
  }[]
  deliveries?: {
    deliveryRef: string
    receivedRevision: number
    receivedAt: string
    expiresAt: string
    attempts: number
    lastError: string
  }[]
  runRef?: string
  eventCount?: number
}

const SUBSCRIPTION_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    subscriptionRef: { type: 'string' }, name: { type: 'string' },
    state: { type: 'string' }, revision: { type: 'number' }, intervalMinutes: { type: 'number' },
    webhook: { type: 'boolean' }, unpublished: { type: 'number' },
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

const intervalOf = (subscription: { readonly triggers: { readonly interval?: { readonly minutes: number } | undefined } }): number | undefined =>
  subscription.triggers.interval?.minutes

/** Which of the two triggers a subscription carries: either one alone is a complete subscription. */
function triggersOf(subscription: { readonly intervalMinutes?: number | undefined; readonly webhook?: boolean | undefined }): string {
  const timer = subscription.intervalMinutes === undefined ? '' : `every ${subscription.intervalMinutes} min`
  if (!subscription.webhook) return timer
  return timer === '' ? 'webhook' : `${timer} + webhook`
}

/** `REF` injects under the same name; `REF=ENV_NAME` asks for a different one. */
function credentialsFrom(entries: readonly string[] | undefined): readonly SubscriptionCredential[] {
  return Object.freeze((entries ?? []).map(entry => {
    const separator = entry.indexOf('=')
    if (separator < 0) return Object.freeze({ ref: entry.trim(), env: entry.trim() })
    return Object.freeze({ ref: entry.slice(0, separator).trim(), env: entry.slice(separator + 1).trim() })
  }))
}

function requireSubscriptionRef(value: string | undefined): AgentTeamSubscriptionRef {
  if (value === undefined || value.trim() === '') throw new Error('team_subscription needs subscriptionRef for this action; list them first')
  return value as AgentTeamSubscriptionRef
}

function scriptSource(args: { readonly scriptPath?: string | undefined; readonly scriptContent?: string | undefined }):
  { readonly scriptPath: string } | { readonly scriptContent: string } {
  if (args.scriptPath !== undefined && args.scriptContent !== undefined) {
    throw new Error('team_subscription takes either scriptPath or scriptContent, never both')
  }
  if (args.scriptPath !== undefined) return { scriptPath: args.scriptPath }
  if (args.scriptContent !== undefined) return { scriptContent: args.scriptContent }
  throw new Error('team_subscription needs the script: pass scriptPath, or scriptContent when there is no file')
}

type SubscriptionWrite = { readonly kind: 'changed'; readonly subscription: {
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly name: string
  readonly state: string
  readonly revision: number
  readonly triggers: { readonly interval?: { readonly minutes: number } | undefined; readonly webhook?: true | undefined }
  readonly webhook?: unknown
}, readonly webhookAddress?: string | undefined, readonly webhookAddressGone?: true | undefined
} | { readonly kind: 'trial-failed'; readonly failure: { readonly reason: string; readonly stdoutTail: string; readonly stderrTail: string } }

function written(action: string, result: SubscriptionWrite, base: { readonly workspaceId: string; readonly projectRef: string }): SubscriptionResult {
  if (result.kind === 'trial-failed') {
    return { kind: 'trial-failed', ...base, reason: result.failure.reason, stdoutTail: result.failure.stdoutTail, stderrTail: result.failure.stderrTail }
  }
  const { subscription } = result
  const intervalMinutes = intervalOf(subscription)
  return { kind: action, ...base, subscriptionRef: subscription.subscriptionRef, name: subscription.name, state: subscription.state,
    revision: subscription.revision, webhook: subscription.triggers.webhook === true,
    ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
    // Only the call that armed or reset the address has it: the ledger keeps a
    // hash, so this is the one time a caller can read the whole thing.
    ...(result.webhookAddress === undefined ? {} : { webhookAddress: result.webhookAddress }),
    ...(result.webhookAddressGone === true ? { webhookAddressGone: true as const } : {}) }
}

type RenderedRun = NonNullable<SubscriptionResult['runs']>[number]

function runLine(run: RenderedRun): string {
  const exit = run.timedOut ? ' · timed out' : run.exitCode === undefined ? '' : ` · exit ${run.exitCode}`
  // The identity a run is explained by: which revision it pinned, and which
  // delivery (and which attempt of it) asked for it when a webhook started it.
  const delivery = run.deliveryRef === undefined ? '' : ` · ${run.deliveryRef} attempt ${run.attempt ?? 0}`
  return `${run.startedAt} · ${run.trigger} · ${run.category} · ${run.eventCount} event${run.eventCount === 1 ? '' : 's'} · r${run.subscriptionRevision}${delivery} · ${run.durationMs} ms${exit}`
}

function outcomeLine(run: RenderedRun): string {
  return run.succeeded ? run.category : `${run.category}: ${run.reason ?? 'no reason recorded'}`
}

/**
 * The tails an owner's read carries. A passing run has them too: "the script
 * printed nothing useful" is exactly what an owner reads the output to find out,
 * and hiding it on success makes a green run undebuggable. A summary-only read
 * carries no tail at all, so this renders nothing for it.
 */
function outputLines(run: RenderedRun): string {
  if (run.stdoutTail === undefined) return ''
  return `\n  stdout tail:\n${run.stdoutTail || '(empty)'}\n  stderr tail:\n${run.stderrTail || '(empty)'}`
}

export const teamSubscription = defineTool({
  name: 'team_subscription',
  description: `Create and maintain a Project's subscription: a script the Host runs on a timer, on an incoming webhook, or both, with no Session, as this Project. Only the Project's owners may create, change, test, pause, resume, delete, re-baseline one, or replay a failed delivery; any member may list them and read their run history. Create and update take the script from a file path (resolved against your working directory) or as pasted content, snapshot it (at most 16 KiB), validate the declared credential references, and run it once — a failing trial refuses the write and returns the tail of its stdout and stderr. A new subscription ignores the ids its trial printed by default, so the first live run does not republish what the script already found; pass baseline: ignore-history to publish everything it sees from the start. An update keeps the existing deduplication waterline, so an id that appeared between two polls is never swallowed; after changing the script's id rule, call baseline with the ids to ignore. Events the script prints (one JSON object per line: id, title, optional url and detail) are deduplicated inside this subscription and published to the Project's Main stream at most 20 per minute; the Host pauses a subscription after three failed runs in a row. logs reads the newest recorded runs: trigger, start, duration, structured outcome, event count, the revision it pinned, and for a webhook run the delivery and attempt that asked for it; the Project's owners and the Human also see why a run failed and the tails of what it printed, passing runs included, while any other member sees only the summary. deliveries lists — for the owners, because a delivery carries the request body it arrived with — the webhook deliveries whose automatic retries were spent, with a stable ref, the last error, and an expiry — each counted one failure when its retries ran out; replay runs one again — the definition as it stands now by default, so a fix can handle an old request, or the version it arrived under. A replay never counts as a failure of the subscription, it takes a run slot and the subscription's own exclusion like any other run, and it is refused while the subscription is paused or gone. Repeating a call answers with what the first one did; one call id names one delivery and one version, and a delivery that already replayed successfully is not run again. Create or update with webhook: true arms an address under the Host's public origin, at <public origin>/team/hooks/<token>. The Host stores only a hash of the token, so the complete address is returned exactly once — register it with the provider in the same turn; reset_webhook replaces it and shows the new address once, the old one stops resolving immediately, and deliveries already queued keep running. A webhook run reads {headers, body} on stdin with lower-case header names from a fixed whitelist, and its output is accepted into the ledger before publication, so a 202 is never lost to a throttled publish: a run whose batch has no room in that queue keeps it and retries only the accept, without running the script again. An update that does not name a trigger keeps the webhook address, because a provider already posts to it; only webhook: false drops it.`,
  parameters: {
    action: { type: 'string', required: true,
      enum: ['list', 'create', 'update', 'test', 'pause', 'resume', 'delete', 'baseline', 'logs', 'deliveries', 'replay', 'reset_webhook'] },
    projectRef: { type: 'string', required: true, description: 'The Project that owns the subscription, exactly as team_view lists it.' },
    subscriptionRef: { type: 'string', description: 'The subscription a change, trial, or baseline addresses, exactly as team_subscription list returns it.' },
    name: { type: 'string', description: 'Subscription label, at most 80 characters. Required by create; update replaces it.' },
    intervalMinutes: { type: 'number', description: 'Minutes between timer runs, at least 5. An update that leaves it out runs on no timer, so name it again to keep a timer; a create or update needs at least one trigger: this one, webhook, or both.' },
    webhook: { type: 'boolean', description: 'Arm the subscription webhook on create or update; an update that leaves it out keeps the address the provider already posts to, and false is what drops it. The armed address is returned once and can never be read back.' },
    scriptPath: { type: 'string', description: 'Path to the script file, resolved against your working directory. Prefer this over inline content: debug the script with your own shell tool first.' },
    scriptContent: { type: 'string', description: 'The script itself, for a caller with no file to point at. Mutually exclusive with scriptPath.' },
    credentials: { type: 'array', items: { type: 'string' },
      description: 'Credential references to inject on every run, at most 8, each written REF or REF=ENV_NAME. Values are never stored here; the Host resolves them at each run.' },
    baseline: { type: 'string', enum: ['current-output', 'ignore-history'], description: 'Which history a brand-new subscription ignores. Default current-output.' },
    expectedRevision: { type: 'number', description: 'The revision an update, pause, resume, reset_webhook, or delete must still be at. Read it from list; a concurrent change makes this call fail instead of overwriting.' },
    ids: { type: 'array', items: { type: 'string' }, description: 'For baseline: ids to ignore from now on. They append; nothing earlier is cleared.' },
    limit: { type: 'number', description: 'For logs: how many of the newest runs to return, 1 to 50. Default 50.' },
    deliveryRef: { type: 'string', description: 'For replay: the failed delivery to run again, exactly as deliveries lists it.' },
    version: { type: 'string', enum: ['current', 'received'],
      description: 'For replay: current (default) runs the script as it stands now, so a fix can handle an old request; received runs the version the delivery arrived under.' },
    workspace: workspaceParam,
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => {
      const where = `Workspace: ${value.workspaceId} · Project: ${value.projectRef}`
      if (value.kind === 'list') {
        const rows = (value.subscriptions ?? []).map(row => `- ${row.subscriptionRef} — ${row.name} · ${row.state} · r${row.revision} · ${triggersOf(row)}${row.unpublished === 0 ? '' : ` · ${row.unpublished} waiting to publish`}`)
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
      return [{ type: 'text', text: `${where}\n${value.kind}: ${value.name ?? 'subscription'} (${value.subscriptionRef}) · ${value.state ?? 'active'} · r${value.revision ?? 1}${interval}${hook}${address}${gone}` }]
    },
  },
  async execute(rawArgs, exec): Promise<SubscriptionResult> {
    const args = rawArgs
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_subscription requires an Agent session')
    const host = service(agent)
    const workspaceId = workspaceOf(args, agent)
    const projectRef = args.projectRef as AgentTeamProjectRef
    const base = { workspaceId, projectRef }
    const requestId = `agent-team:tool:${agent.id}:${exec.callId}` as AgentTeamRequestId
    if (args.action === 'list') {
      const listed = host.subscriptionsForAgent(agent, base)
      return { kind: 'list', ...base, subscriptions: listed.entries.map(entry => {
        const minutes = intervalOf(entry.subscription)
        return { subscriptionRef: entry.subscription.subscriptionRef, name: entry.subscription.name,
          state: entry.subscription.state, revision: entry.subscription.revision, unpublished: entry.unpublished,
          webhook: entry.subscription.triggers.webhook === true,
          ...(minutes === undefined ? {} : { intervalMinutes: minutes }) }
      }) }
    }
    if (args.action === 'create') {
      if (args.name === undefined) throw new Error('team_subscription create needs name')
      const result = await host.createSubscriptionForAgent(agent, { requestId, ...base, name: args.name,
        ...(args.intervalMinutes === undefined ? {} : { intervalMinutes: args.intervalMinutes }),
        ...(args.webhook === undefined ? {} : { webhook: args.webhook }),
        script: scriptSource(args), credentials: credentialsFrom(args.credentials), baseline: args.baseline ?? 'current-output' })
      return written('create', result, base)
    }
    const subscriptionRef = requireSubscriptionRef(args.subscriptionRef)
    if (args.action === 'update') {
      if (args.name === undefined || args.expectedRevision === undefined) {
        throw new Error('team_subscription update needs name and expectedRevision')
      }
      const result = await host.updateSubscriptionForAgent(agent, { requestId, ...base, subscriptionRef, expectedRevision: args.expectedRevision,
        name: args.name, ...(args.intervalMinutes === undefined ? {} : { intervalMinutes: args.intervalMinutes }),
        ...(args.webhook === undefined ? {} : { webhook: args.webhook }),
        script: scriptSource(args), credentials: credentialsFrom(args.credentials) })
      return written('update', result, base)
    }
    if (args.action === 'test') {
      const result = await host.testSubscriptionForAgent(agent, { ...base, subscriptionRef })
      if (result.kind === 'trial-failed') {
        return { kind: 'trial-failed', ...base, subscriptionRef, reason: result.failure.reason, stdoutTail: result.failure.stdoutTail,
          stderrTail: result.failure.stderrTail }
      }
      return { kind: 'tested', ...base, subscriptionRef,
        events: result.events.map(event => `${event.id} — ${event.title}${event.url === undefined ? '' : ` (${event.url})`}`),
        stdoutTail: result.stdoutTail, stderrTail: result.stderrTail }
    }
    if (args.action === 'logs') {
      const logged = host.subscriptionLogsForAgent(agent, { ...base, subscriptionRef, ...(args.limit === undefined ? {} : { limit: args.limit }) })
      return { kind: 'logs', ...base, subscriptionRef, name: logged.subscription.name,
        runs: logged.runs.map(run => ({ runRef: run.runRef, trigger: run.trigger, startedAt: run.startedAt, durationMs: run.durationMs,
          category: run.category, succeeded: run.succeeded, eventCount: run.eventCount, timedOut: run.timedOut,
          // The identity the Host already carries travels with the summary: without
          // it a delivery, the revision it arrived under, and the run it produced
          // cannot be read as one story.
          subscriptionRevision: run.subscriptionRevision,
          ...(run.scriptHash === undefined ? {} : { scriptHash: run.scriptHash }),
          ...(run.attempt === undefined ? {} : { attempt: run.attempt }),
          ...(run.deliveryRef === undefined ? {} : { deliveryRef: run.deliveryRef }),
          ...(run.exitCode === null ? {} : { exitCode: run.exitCode }), ...(run.reason === undefined ? {} : { reason: run.reason }),
          ...(run.stdoutTail === undefined ? {} : { stdoutTail: run.stdoutTail }),
          ...(run.stderrTail === undefined ? {} : { stderrTail: run.stderrTail }) })) }
    }
    if (args.action === 'deliveries') {
      const listed = host.subscriptionDeliveriesForAgent(agent, { ...base, subscriptionRef })
      return { kind: 'deliveries', ...base, subscriptionRef,
        deliveries: listed.deliveries.map(entry => ({ ...entry })) }
    }
    if (args.action === 'replay') {
      if (args.deliveryRef === undefined || args.deliveryRef.trim() === '') {
        throw new Error('team_subscription replay needs deliveryRef; read it from deliveries first')
      }
      const replayed = await host.replaySubscriptionDeliveryForAgent(agent, { requestId, ...base, subscriptionRef, deliveryRef: args.deliveryRef,
        ...(args.version === undefined ? {} : { version: args.version }) })
      return { kind: replayed.kind, ...base, subscriptionRef,
        ...(replayed.runRef === undefined ? {} : { runRef: replayed.runRef }),
        ...(replayed.eventCount === undefined ? {} : { eventCount: replayed.eventCount }),
        ...(replayed.reason === undefined ? {} : { reason: replayed.reason }),
        ...(replayed.stdoutTail === undefined ? {} : { stdoutTail: replayed.stdoutTail }),
        ...(replayed.stderrTail === undefined ? {} : { stderrTail: replayed.stderrTail }) }
    }
    if (args.action === 'baseline') {
      if (args.ids === undefined || args.ids.length === 0) throw new Error('team_subscription baseline needs the ids to ignore')
      const result = await host.baselineSubscriptionForAgent(agent, { requestId, ...base, subscriptionRef, ids: args.ids })
      return { kind: 'baselined', ...base, subscriptionRef, name: result.subscription.name, state: result.subscription.state,
        revision: result.subscription.revision, baselineIds: [...result.added] }
    }
    const expectedRevision = args.expectedRevision
    if (args.action === 'reset_webhook') {
      if (args.expectedRevision === undefined) throw new Error('team_subscription reset_webhook needs expectedRevision')
      return written('reset_webhook', await host.resetSubscriptionWebhookForAgent(agent, { requestId, ...base, subscriptionRef,
        expectedRevision: args.expectedRevision }), base)
    }
    if (expectedRevision === undefined) throw new Error(`team_subscription ${args.action} needs expectedRevision`)
    const request = { requestId, ...base, subscriptionRef, expectedRevision }
    const result = args.action === 'pause' ? await host.pauseSubscriptionForAgent(agent, request)
      : args.action === 'resume' ? await host.resumeSubscriptionForAgent(agent, request)
        : await host.deleteSubscriptionForAgent(agent, request)
    return written(args.action, result, base)
  },
})
