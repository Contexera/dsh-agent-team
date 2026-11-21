import { defineTool } from '@deepseek-ai/dsh-tools'
import type AgentTeam from '@contexera/dsh-agent-team/host'
import type { SubscriptionCredential } from '@contexera/dsh-agent-team/host'
import type { AgentTeamMemberId, AgentTeamRequestId, AgentTeamProjectRef, AgentTeamSubscriptionRef, AgentTeamSubscriptionWriteResult } from '@contexera/dsh-agent-team/types'
import { service, workspaceOf, workspaceParam } from './host-access.ts'
import { memberTarget } from './member-target.ts'
import { subscriptionOutput, type SubscriptionResult } from './subscription-output.ts'

const intervalOf = (subscription: { readonly triggers: { readonly interval?: { readonly minutes: number } | undefined } }): number | undefined =>
  subscription.triggers.interval?.minutes

/** `REF` injects under the same name; `REF=ENV_NAME` asks for a different one. */
function credentialsFrom(entries: readonly string[] | undefined): readonly SubscriptionCredential[] {
  return Object.freeze((entries ?? []).map(entry => {
    const separator = entry.indexOf('=')
    if (separator < 0) return Object.freeze({ ref: entry.trim(), env: entry.trim() })
    return Object.freeze({ ref: entry.slice(0, separator).trim(), env: entry.slice(separator + 1).trim() })
  }))
}

function notifyFrom(host: AgentTeam, entries: readonly string[]): readonly AgentTeamMemberId[] {
  return Object.freeze(entries.map(entry => memberTarget(host, entry)))
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

function written(action: string, result: AgentTeamSubscriptionWriteResult, base: { readonly workspaceId: string; readonly projectRef: string }): SubscriptionResult {
  if (result.kind === 'trial-failed') {
    return { kind: 'trial-failed', ...base, reason: result.failure.reason, stdoutTail: result.failure.stdoutTail, stderrTail: result.failure.stderrTail }
  }
  const { subscription } = result
  const intervalMinutes = intervalOf(subscription)
  return { kind: action, ...base, subscriptionRef: subscription.subscriptionRef, name: subscription.name, state: subscription.state,
    revision: subscription.revision, webhook: subscription.triggers.webhook === true,
    ...(subscription.notify === undefined ? {} : { notify: [...subscription.notify] }),
    ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
    // Only the call that armed or reset the address has it: the ledger keeps a
    // hash, so this is the one time a caller can read the whole thing.
    ...(result.webhookAddress === undefined ? {} : { webhookAddress: result.webhookAddress }),
    ...(result.webhookAddressGone === true ? { webhookAddressGone: true as const } : {}) }
}

export const teamSubscription = defineTool({
  name: 'team_subscription',
  description: `Create and maintain a Project's subscription: a script the Host runs on a timer, on an incoming webhook, or both, with no Session, as this Project. Only the Project's owners may create, change, test, pause, resume, delete, re-baseline one, or replay a failed delivery; any Workspace member may list their metadata, while run history remains available to Project members. Create, update, test, resume, and replay run a script on the Host's shell, so they need your own bash or pwsh tool and are refused without one. Create and update take the script from a file path inside your working directory or as pasted content, snapshot it (at most 16 KiB), validate the declared credential references, and run it once — a failing trial refuses the write and returns the tail of its stdout and stderr. A new subscription ignores the ids its trial printed by default, so the first live run does not republish what the script already found; pass baseline: ignore-history to publish everything it sees from the start. An update keeps the existing deduplication waterline, so an id that appeared between two polls is never swallowed; after changing the script's id rule, call baseline with the ids to ignore. Events the script prints (one JSON object per line: id, title, optional url and detail) are deduplicated inside this subscription and published to the Project's Main stream at most 20 per minute; publication addresses them: they reach only the Members named in notify (default: the Creating Member), while everyone else can still read them in the timeline without being woken. The Host pauses a subscription after three failed runs in a row. logs reads the newest recorded runs: trigger, start, duration, structured outcome, event count, the revision it pinned, and for a webhook run the delivery and attempt that asked for it; the Project's owners and the Human also see why a run failed and the tails of what it printed, passing runs included, while any other member sees only the summary. deliveries lists — for the owners, because a delivery carries the request body it arrived with — the webhook deliveries whose automatic retries were spent, with a stable ref, the last error, and an expiry — each counted one failure when its retries ran out; replay runs one again — the definition as it stands now by default, so a fix can handle an old request, or the version it arrived under. A replay never counts as a failure of the subscription, it takes a run slot and the subscription's own exclusion like any other run, and it is refused while the subscription is paused or gone. Repeating a call answers with what the first one did; one call id names one delivery and one version, and a delivery that already replayed successfully is not run again. Create or update with webhook: true arms an address under the Host's public origin, at <public origin>/team/hooks/<token>. The Host stores only a hash of the token, so the complete address is returned exactly once — register it with the provider in the same turn; reset_webhook replaces it and shows the new address once, the old one stops resolving immediately, and deliveries already queued keep running. A webhook run reads {headers, body} on stdin with lower-case header names from a fixed whitelist, and its output is accepted into the ledger before publication, so a 202 is never lost to a throttled publish: a run whose batch has no room in that queue keeps it and retries only the accept, without running the script again. An update that does not name a trigger keeps the webhook address, because a provider already posts to it; only webhook: false drops it.`,
  parameters: {
    action: { type: 'string', required: true,
      enum: ['list', 'create', 'update', 'test', 'pause', 'resume', 'delete', 'baseline', 'logs', 'deliveries', 'replay', 'reset_webhook'] },
    projectRef: { type: 'string', required: true, description: 'The Project that owns the subscription, exactly as team_view lists it.' },
    subscriptionRef: { type: 'string', description: 'The subscription a change, trial, or baseline addresses, exactly as team_subscription list returns it.' },
    name: { type: 'string', description: 'Subscription label, at most 80 characters. Required by create; update replaces it.' },
    intervalMinutes: { type: 'number', description: 'Minutes between timer runs, at least 5. An update that leaves it out runs on no timer, so name it again to keep a timer; a create or update needs at least one trigger: this one, webhook, or both.' },
    webhook: { type: 'boolean', description: 'Arm the subscription webhook on create or update; an update that leaves it out keeps the address the provider already posts to, and false is what drops it. The armed address is returned once and can never be read back.' },
    scriptPath: { type: 'string', description: 'Path to the script file inside your working directory; a relative path resolves against it, and one that leads outside it, through a symlink included, is refused. Prefer this over inline content: debug the script with your own shell tool first.' },
    scriptContent: { type: 'string', description: 'The script itself, for a caller with no file to point at. Mutually exclusive with scriptPath.' },
    credentials: { type: 'array', items: { type: 'string' },
      description: 'Credential references to inject on every run, at most 8, each written REF or REF=ENV_NAME. Values are never stored here; the Host resolves them at each run.' },
    notify: { type: 'array', items: { type: 'string' },
      description: 'For create or update: the Members whose Inbox this subscription event reaches — each as a memberRef, an @Handle, or the Human (any enabled or suspended Member of the Project\'s Workspace, owner or not). Omitted on create means the Creating Member alone; omitted on update keeps the stored set; an empty array means the timeline alone, with nobody woken. Non-recipients still see the event on the Main stream.' },
    baseline: { type: 'string', enum: ['current-output', 'ignore-history'], description: 'Which history a brand-new subscription ignores. Default current-output.' },
    expectedRevision: { type: 'number', description: 'The revision an update, pause, resume, reset_webhook, or delete must still be at. Read it from list; a concurrent change makes this call fail instead of overwriting.' },
    ids: { type: 'array', items: { type: 'string' }, description: 'For baseline: ids to ignore from now on. They append; nothing earlier is cleared.' },
    limit: { type: 'number', description: 'For logs: how many of the newest runs to return, 1 to 50. Default 50.' },
    deliveryRef: { type: 'string', description: 'For replay: the failed delivery to run again, exactly as deliveries lists it.' },
    version: { type: 'string', enum: ['current', 'received'],
      description: 'For replay: current (default) runs the script as it stands now, so a fix can handle an old request; received runs the version the delivery arrived under.' },
    workspace: workspaceParam,
  },
  output: subscriptionOutput,
  async execute(rawArgs, exec): Promise<SubscriptionResult> {
    const args = { ...rawArgs }
    // Blank selector slots use defaults, but empty notify explicitly means timeline only.
    // Empty credentials, false webhook, and zero expectedRevision must also reach the Host.
    for (const key of ['workspace', 'scriptPath', 'scriptContent'] as const) {
      if (args[key] === '') delete args[key]
    }
    for (const key of ['intervalMinutes', 'limit'] as const) {
      if (args[key] === 0) delete args[key]
    }
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
          ...(entry.subscription.notify === undefined ? {} : { notify: [...entry.subscription.notify] }),
          ...(minutes === undefined ? {} : { intervalMinutes: minutes }) }
      }) }
    }
    if (args.action === 'create') {
      if (args.name === undefined) throw new Error('team_subscription create needs name')
      const result = await host.createSubscriptionForAgent(agent, { requestId, ...base, name: args.name,
        ...(args.intervalMinutes === undefined ? {} : { intervalMinutes: args.intervalMinutes }),
        ...(args.webhook === undefined ? {} : { webhook: args.webhook }),
        script: scriptSource(args), credentials: credentialsFrom(args.credentials),
        ...(args.notify === undefined ? {} : { notify: notifyFrom(host, args.notify) }),
        baseline: args.baseline ?? 'current-output' })
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
        script: scriptSource(args), credentials: credentialsFrom(args.credentials),
        ...(args.notify === undefined ? {} : { notify: notifyFrom(host, args.notify) }) })
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
