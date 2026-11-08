import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { teamTools } from './render-text.ts'

/**
 * Execution-level tests for `team_subscription` reads: what the Host answers
 * must reach the caller whole, because the run history is how an owner lines a
 * delivery up with the run it produced. Renders are covered in
 * `team-tools-render.spec.ts`; these lock the tool-to-Host mapping.
 */

const WORKSPACE = 'workspace:alpha'
const PROJECT = 'project:046dd831-c679-4279-b6aa-7813476cf12e'
const SUBSCRIPTION = 'subscription:8f14e45f-ceea-467f-a7d3-9b0f1a4c7e21'
const RUN = 'run:6b1f2c3d-0000-4000-8000-000000000001'
const SCRIPT_HASH = 'a'.repeat(64)

/** The Host surface these reads touch, recorded so the assertion is on what came back. */
function fakeHost(overrides: Record<string, unknown> = {}) {
  const subscription = { subscriptionRef: SUBSCRIPTION, projectRef: PROJECT, name: 'main CI', revision: 2,
    state: 'active', triggers: { interval: { minutes: 10 } } }
  return {
    workspacesForAgent: () => [{ workspaceId: WORKSPACE, path: undefined, default: true }],
    // The Member surface a caller's written name is resolved against.
    members: () => [],
    humanHandle: () => 'human',
    subscriptionLogsForAgent: vi.fn((_agent: unknown, _request: Record<string, unknown>) => ({ subscription, runs: [{ runRef: RUN, trigger: 'webhook',
      startedAt: '2026-11-03T09:00:00.000Z', durationMs: 42, category: 'accepted', succeeded: true, eventCount: 1,
      exitCode: 0, timedOut: false, subscriptionRevision: 2, scriptHash: SCRIPT_HASH, deliveryRef: 'delivery:d1',
      attempt: 3, stdoutTail: '{"id":"a","title":"A"}', stderrTail: '' }] })),
    replaySubscriptionDeliveryForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({ kind: 'replayed', runRef: RUN, eventCount: 1,
      delivery: { deliveryRef: 'delivery:d1', receivedRevision: 1, receivedScriptHash: SCRIPT_HASH,
        receivedAt: '2026-11-01T00:00:00.000Z', expiresAt: '2026-11-08T00:00:00.000Z', attempts: 3, lastError: 'exit 1' } })),
    ...overrides,
  }
}

async function call(tool: ToolDefinition, args: Record<string, unknown>, host: ReturnType<typeof fakeHost>): Promise<unknown> {
  const agent = { id: 'agent:tool-test', ctx: { get: (name: string) => name === 'agentTeam' ? host : undefined } }
  return tool.execute(args, { agent, callId: 'call:1', signal: new AbortController().signal } as never)
}

describe('team_subscription logs', () => {
  it('carries the identity the Host answered with, so a run and its delivery read as one story', async () => {
    const host = fakeHost()
    const result = await call(teamTools().get('team_subscription')!, { action: 'logs', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION }, host)
    expect(host.subscriptionLogsForAgent).toHaveBeenCalledTimes(1)
    // Every identity field the Host already carries reaches the caller: dropping
    // one here is invisible to the Host and loses the link to the delivery.
    expect((result as { runs: readonly Record<string, unknown>[] }).runs[0]).toMatchObject({
      runRef: RUN, subscriptionRevision: 2, scriptHash: SCRIPT_HASH, deliveryRef: 'delivery:d1', attempt: 3,
      eventCount: 1, succeeded: true, stdoutTail: '{"id":"a","title":"A"}',
    })
  })

  it('passes the limit through and leaves it out when the caller named none', async () => {
    const host = fakeHost()
    await call(teamTools().get('team_subscription')!, { action: 'logs', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION, limit: 5 }, host)
    expect(host.subscriptionLogsForAgent.mock.calls[0]![1]).toMatchObject({ limit: 5 })
    await call(teamTools().get('team_subscription')!, { action: 'logs', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION }, host)
    expect(host.subscriptionLogsForAgent.mock.calls[1]![1]).not.toHaveProperty('limit')
  })
})

describe('team_subscription replay', () => {
  it('reports how many events the replay accepted, so an empty success is not called a delivery', async () => {
    const host = fakeHost()
    const result = await call(teamTools().get('team_subscription')!, { action: 'replay', projectRef: PROJECT,
      subscriptionRef: SUBSCRIPTION, deliveryRef: 'delivery:d1' }, host)
    expect(host.replaySubscriptionDeliveryForAgent.mock.calls[0]![1]).toMatchObject({ deliveryRef: 'delivery:d1' })
    expect(result).toMatchObject({ kind: 'replayed', runRef: RUN, eventCount: 1 })
  })
})

describe('team_subscription arms and resets the webhook address', () => {
  const ADDRESS = 'https://team.example.com/team/hooks/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
  const armed = (overrides: Record<string, unknown> = {}) => ({
    workspacesForAgent: () => [{ workspaceId: WORKSPACE, path: undefined, default: true }],
    createSubscriptionForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({ kind: 'changed',
      subscription: { subscriptionRef: SUBSCRIPTION, projectRef: PROJECT, name: 'hooks only', revision: 1, state: 'active',
        triggers: { webhook: true }, webhook: { tokenHash: 'b'.repeat(64) } }, webhookAddress: ADDRESS })),
    updateSubscriptionForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({ kind: 'changed',
      subscription: { subscriptionRef: SUBSCRIPTION, projectRef: PROJECT, name: 'hooks only', revision: 2, state: 'active',
        triggers: { interval: { minutes: 60 }, webhook: true } } })),
    resetSubscriptionWebhookForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({ kind: 'changed',
      subscription: { subscriptionRef: SUBSCRIPTION, projectRef: PROJECT, name: 'hooks only', revision: 2, state: 'active',
        triggers: { webhook: true } }, webhookAddress: ADDRESS })),
    ...overrides,
  })

  it('creates a webhook-only subscription without inventing an interval', async () => {
    const host = armed()
    const result = await call(teamTools().get('team_subscription')!, { action: 'create', projectRef: PROJECT,
      name: 'hooks only', webhook: true, scriptContent: 'json-body\n' }, host as never)
    const request = host.createSubscriptionForAgent.mock.calls[0]![1]
    expect(request).toMatchObject({ name: 'hooks only', webhook: true })
    expect(request, 'a webhook-only subscription has no timer to set').not.toHaveProperty('intervalMinutes')
    // The address comes back exactly once, on the call that armed it.
    expect(result).toMatchObject({ kind: 'create', webhook: true, webhookAddress: ADDRESS })
  })

  it('resets the address under the revision the caller read, and hands the new one back', async () => {
    const host = armed()
    const result = await call(teamTools().get('team_subscription')!, { action: 'reset_webhook', projectRef: PROJECT,
      subscriptionRef: SUBSCRIPTION, expectedRevision: 2 }, host as never)
    expect(host.resetSubscriptionWebhookForAgent.mock.calls[0]![1]).toMatchObject({ subscriptionRef: SUBSCRIPTION, expectedRevision: 2 })
    expect(result).toMatchObject({ kind: 'reset_webhook', webhook: true, webhookAddress: ADDRESS, revision: 2 })
    // A reset is a state transition: the revision it reports is the one it read.
    await expect(call(teamTools().get('team_subscription')!, { action: 'reset_webhook', projectRef: PROJECT,
      subscriptionRef: SUBSCRIPTION }, host as never)).rejects.toThrow(/reset_webhook needs expectedRevision/)
  })

  it('leaves the trigger alone when an edit does not name it', async () => {
    const host = armed()
    await call(teamTools().get('team_subscription')!, { action: 'update', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION,
      expectedRevision: 1, name: 'hooks only', intervalMinutes: 60, scriptContent: 'json-body\n' }, host as never)
    const request = host.updateSubscriptionForAgent.mock.calls[0]![1]
    expect(request).toMatchObject({ intervalMinutes: 60 })
    expect(request, 'an edit that says nothing about the webhook must not disarm it').not.toHaveProperty('webhook')
  })
})

describe('team_subscription addressed events', () => {
  const recipient = 'member:2eb79b61-1d71-4c97-823f-04b3d33f9e87'
  const changed = (notify: readonly string[]) => ({ kind: 'changed', subscription: { subscriptionRef: SUBSCRIPTION, projectRef: PROJECT,
    name: 'main CI', state: 'active', revision: 1, triggers: { interval: { minutes: 10 } }, notify } })

  it('passes the recipients through, and keeps "not named" apart from "nobody"', async () => {
    const create = vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => changed([recipient]))
    const update = vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => changed([]))
    const host = fakeHost({ createSubscriptionForAgent: create, updateSubscriptionForAgent: update })
    const tool = teamTools().get('team_subscription')!
    const created = await call(tool, { action: 'create', projectRef: PROJECT, name: 'main CI', intervalMinutes: 10,
      scriptContent: 'true\n', notify: [recipient] }, host) as { notify: readonly string[] }
    expect(create.mock.calls[0]![1]).toMatchObject({ notify: [recipient] })
    expect(created.notify).toEqual([recipient])

    // An omitted set must reach the Host as omitted: on a create that is the
    // Creating Member, and sending [] instead would silently mean "nobody".
    await call(tool, { action: 'create', projectRef: PROJECT, name: 'main CI', intervalMinutes: 10, scriptContent: 'true\n' }, host)
    expect(create.mock.calls[1]![1]).not.toHaveProperty('notify')

    // Clearing is a real instruction and must survive as an empty array.
    const cleared = await call(tool, { action: 'update', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION, name: 'main CI',
      expectedRevision: 1, scriptContent: 'true\n', notify: [] }, host) as { notify: readonly string[] }
    expect(update.mock.calls[0]![1]).toMatchObject({ notify: [] })
    expect(cleared.notify).toEqual([])
  })

  it('reads a recipient the way a caller writes it: @Handle, a 6+ hex prefix, or the Human', async () => {
    // Every Member-taking field accepts the form an Agent actually sees; a
    // handle that resolved would otherwise be reported as "not a Project member".
    const createForAgent = vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => changed([]))
    const host = fakeHost({
      members: () => [
        { member: { memberId: 'member:2eb79b61-1d71-4c97-823f-04b3d33f9e87', handle: 'Cole' } },
        // Shares its first six hex characters with Cole, so a prefix can be ambiguous.
        { member: { memberId: 'member:2eb79baa-4a85-4e08-86bb-a41b1a0bef48', handle: 'Iris' } },
      ],
      createSubscriptionForAgent: createForAgent,
    })
    const tool = teamTools().get('team_subscription')!
    const create = { action: 'create', projectRef: PROJECT, name: 'main CI', intervalMinutes: 10, scriptContent: 'true\n' }
    await call(tool, { ...create, notify: ['@cole', 'Iris', 'human'] }, host)
    const sent = createForAgent.mock.calls[0]![1]
    expect(sent.notify).toEqual(['member:2eb79b61-1d71-4c97-823f-04b3d33f9e87', 'member:2eb79baa-4a85-4e08-86bb-a41b1a0bef48', 'member:human'])

    // A unique prefix resolves; a shared one names the candidates instead.
    await call(tool, { ...create, notify: ['member:2eb79baa'] }, host)
    expect(createForAgent.mock.calls[1]![1]).toMatchObject({ notify: ['member:2eb79baa-4a85-4e08-86bb-a41b1a0bef48'] })

    // An unknown form names the accepted forms instead of blaming membership.
    await expect(call(tool, { ...create, notify: ['nobody-here'] }, host)).rejects.toThrow(/pass a memberRef, an @Handle, a unique 6\+ hex prefix, or 'human'/)
    // An ambiguous prefix says so, and offers the candidates.
    await expect(call(tool, { ...create, notify: ['2eb79b'] }, host)).rejects.toThrow(/matches 2 Members/)
  })

  it('lists the recipients each subscription wakes', async () => {
    const host = fakeHost({
      subscriptionsForAgent: vi.fn(() => ({ entries: [{ subscription: { subscriptionRef: SUBSCRIPTION, projectRef: PROJECT,
        name: 'main CI', state: 'active', revision: 1, triggers: { interval: { minutes: 10 } }, notify: [] }, unpublished: 0, eventCount: 0 }] })),
    })
    const result = await call(teamTools().get('team_subscription')!, { action: 'list', projectRef: PROJECT }, host) as {
      subscriptions: readonly { notify: readonly string[] }[] }
    expect(result.subscriptions[0]!.notify).toEqual([])
    const rendered = teamTools().get('team_subscription')!.output!.render!({ action: 'list' } as never, result as never) as readonly { text: string }[]
    expect(rendered[0]!.text).toContain('notify: nobody (published to the timeline only)')
  })
})
