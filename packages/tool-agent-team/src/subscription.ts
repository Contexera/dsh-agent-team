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
    intervalMinutes: number
    unpublished: number
  }[]
}

const SUBSCRIPTION_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    subscriptionRef: { type: 'string' }, name: { type: 'string' },
    state: { type: 'string' }, revision: { type: 'number' }, intervalMinutes: { type: 'number' }, unpublished: { type: 'number' },
  },
} as const

const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', required: true },
    workspaceId: { type: 'string', required: true },
    projectRef: { type: 'string', required: true },
    subscriptionRef: { type: 'string' }, name: { type: 'string' }, state: { type: 'string' },
    revision: { type: 'number' }, intervalMinutes: { type: 'number' }, unpublished: { type: 'number' },
    baselineIds: { type: 'array', items: { type: 'string' } },
    // One rendered line per event: what the script printed, quoted as data.
    events: { type: 'array', items: { type: 'string' } },
    stdoutTail: { type: 'string' }, stderrTail: { type: 'string' }, reason: { type: 'string' },
    subscriptions: { type: 'array', items: SUBSCRIPTION_SCHEMA },
  },
} as const

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
  readonly triggers: { readonly interval?: { readonly minutes: number } | undefined }
} } | { readonly kind: 'trial-failed'; readonly failure: { readonly reason: string; readonly stdoutTail: string; readonly stderrTail: string } }

function written(action: string, result: SubscriptionWrite, base: { readonly workspaceId: string; readonly projectRef: string }): SubscriptionResult {
  if (result.kind === 'trial-failed') {
    return { kind: 'trial-failed', ...base, reason: result.failure.reason, stdoutTail: result.failure.stdoutTail, stderrTail: result.failure.stderrTail }
  }
  const { subscription } = result
  const intervalMinutes = intervalOf(subscription)
  return { kind: action, ...base, subscriptionRef: subscription.subscriptionRef, name: subscription.name, state: subscription.state,
    revision: subscription.revision, ...(intervalMinutes === undefined ? {} : { intervalMinutes }) }
}

export const teamSubscription = defineTool({
  name: 'team_subscription',
  description: `Create and maintain a Project's interval subscription: a script the Host runs on a timer with no Session, as this Project. Only the Project's owners may create, change, test, pause, resume, delete, or re-baseline one; any member may list them. Create and update take the script from a file path (resolved against your working directory) or as pasted content, snapshot it (at most 16 KiB), validate the declared credential references, and run it once — a failing trial refuses the write and returns the tail of its stdout and stderr. A new subscription ignores the ids its trial printed by default, so the first live run does not republish what the script already found; pass baseline: ignore-history to publish everything it sees from the start. An update never touches the deduplication waterline: after changing the script's id rule, call baseline with the ids to ignore. Events the script prints (one JSON object per line: id, title, optional url and detail) are deduplicated inside this subscription and published to the Project's Main stream at most 20 per minute; the Host pauses a subscription after three failed runs in a row. This tool covers interval subscriptions only.`,
  parameters: {
    action: { type: 'string', required: true, enum: ['list', 'create', 'update', 'test', 'pause', 'resume', 'delete', 'baseline'] },
    projectRef: { type: 'string', required: true, description: 'The Project that owns the subscription, exactly as team_view lists it.' },
    subscriptionRef: { type: 'string', description: 'The subscription a change, trial, or baseline addresses, exactly as team_subscription list returns it.' },
    name: { type: 'string', description: 'Subscription label, at most 80 characters. Required by create; update replaces it.' },
    intervalMinutes: { type: 'number', description: 'Minutes between timer runs, at least 5. Required by create; update replaces it.' },
    scriptPath: { type: 'string', description: 'Path to the script file, resolved against your working directory. Prefer this over inline content: debug the script with your own shell tool first.' },
    scriptContent: { type: 'string', description: 'The script itself, for a caller with no file to point at. Mutually exclusive with scriptPath.' },
    credentials: { type: 'array', items: { type: 'string' },
      description: 'Credential references to inject on every run, at most 8, each written REF or REF=ENV_NAME. Values are never stored here; the Host resolves them at each run.' },
    baseline: { type: 'string', enum: ['current-output', 'ignore-history'], description: 'Which history a brand-new subscription ignores. Default current-output.' },
    expectedRevision: { type: 'number', description: 'The revision an update, pause, resume, or delete must still be at. Read it from list; a concurrent change makes this call fail instead of overwriting.' },
    ids: { type: 'array', items: { type: 'string' }, description: 'For baseline: ids to ignore from now on. They append; nothing earlier is cleared.' },
    workspace: workspaceParam,
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => {
      const where = `Workspace: ${value.workspaceId} · Project: ${value.projectRef}`
      if (value.kind === 'list') {
        const rows = (value.subscriptions ?? []).map(row => `- ${row.subscriptionRef} — ${row.name} · ${row.state} · r${row.revision} · every ${row.intervalMinutes} min${row.unpublished === 0 ? '' : ` · ${row.unpublished} waiting to publish`}`)
        return [{ type: 'text', text: `${where}\nSubscriptions (${rows.length}):\n${rows.length === 0 ? '- none' : rows.join('\n')}` }]
      }
      if (value.kind === 'trial-failed') {
        return [{ type: 'text', text: `${where}\nThe trial run failed, so nothing changed: ${value.reason ?? 'unknown reason'}\nstdout tail:\n${value.stdoutTail || '(empty)'}\nstderr tail:\n${value.stderrTail || '(empty)'}` }]
      }
      if (value.kind === 'tested') {
        const events = (value.events ?? []).map(line => `- ${line}`)
        return [{ type: 'text', text: `${where}\nTrial run passed — ${events.length} event${events.length === 1 ? '' : 's'} in the sample output${events.length === 0 ? '' : `:\n${events.join('\n')}`}\nA trial never changes the deduplication waterline or the failure count.` }]
      }
      if (value.kind === 'baselined') {
        const ids = value.baselineIds ?? []
        return [{ type: 'text', text: `${where}\n${value.name ?? value.subscriptionRef} now ignores ${ids.length} more id${ids.length === 1 ? '' : 's'}: ${ids.join(', ') || '(none)'}. Earlier ids stay recorded, and events already accepted still publish.` }]
      }
      const interval = value.intervalMinutes === undefined ? '' : ` · every ${value.intervalMinutes} min`
      return [{ type: 'text', text: `${where}\n${value.kind}: ${value.name ?? 'subscription'} (${value.subscriptionRef}) · ${value.state ?? 'active'} · r${value.revision ?? 1}${interval}` }]
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
      return { kind: 'list', ...base, subscriptions: listed.entries.map(entry => ({
        subscriptionRef: entry.subscription.subscriptionRef, name: entry.subscription.name, state: entry.subscription.state,
        revision: entry.subscription.revision, intervalMinutes: intervalOf(entry.subscription) ?? 0, unpublished: entry.unpublished,
      })) }
    }
    if (args.action === 'create') {
      if (args.name === undefined || args.intervalMinutes === undefined) throw new Error('team_subscription create needs name and intervalMinutes')
      const result = await host.createSubscriptionForAgent(agent, { requestId, ...base, name: args.name, intervalMinutes: args.intervalMinutes,
        script: scriptSource(args), credentials: credentialsFrom(args.credentials), baseline: args.baseline ?? 'current-output' })
      return written('create', result, base)
    }
    const subscriptionRef = requireSubscriptionRef(args.subscriptionRef)
    if (args.action === 'update') {
      if (args.name === undefined || args.intervalMinutes === undefined || args.expectedRevision === undefined) {
        throw new Error('team_subscription update needs name, intervalMinutes, and expectedRevision')
      }
      const result = await host.updateSubscriptionForAgent(agent, { requestId, ...base, subscriptionRef, expectedRevision: args.expectedRevision,
        name: args.name, intervalMinutes: args.intervalMinutes, script: scriptSource(args), credentials: credentialsFrom(args.credentials) })
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
    if (args.action === 'baseline') {
      if (args.ids === undefined || args.ids.length === 0) throw new Error('team_subscription baseline needs the ids to ignore')
      const result = await host.baselineSubscriptionForAgent(agent, { requestId, ...base, subscriptionRef, ids: args.ids })
      return { kind: 'baselined', ...base, subscriptionRef, name: result.subscription.name, state: result.subscription.state,
        revision: result.subscription.revision, baselineIds: [...result.added] }
    }
    const expectedRevision = args.expectedRevision
    if (expectedRevision === undefined) throw new Error(`team_subscription ${args.action} needs expectedRevision`)
    const request = { requestId, ...base, subscriptionRef, expectedRevision }
    const result = args.action === 'pause' ? await host.pauseSubscriptionForAgent(agent, request)
      : args.action === 'resume' ? await host.resumeSubscriptionForAgent(agent, request)
        : await host.deleteSubscriptionForAgent(agent, request)
    return written(args.action, result, base)
  },
})
