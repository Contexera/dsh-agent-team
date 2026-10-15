import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import * as memberTimeContext from '../src/member-time-context.ts'

const PLUGIN = memberTimeContext.name

function fakeAgent(ctx: Context, events: unknown[] = []): Agent {
  return {
    id: SessionId('session:clock-test'), ctx, status: 'idle', options: { provider: 'mock', model: 'mock' },
    session: { surface: { nodes: [] }, events, ownEvents: () => events, inheritedEventCount: 0 } as never,
    inbox: {} as never,
    cancel() {}, whenIdle: async () => {}, runMaintenance: async task => task(new AbortController().signal),
    send() {}, followup() {}, steer() {}, inject() {},
  } as Agent
}

async function preStep(ctx: Context, agent: Agent, turn = 1, step = 1): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [], turn, step, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))
}

async function mount(ctx: Context, config?: memberTimeContext.Config): Promise<void> {
  const loader = Object.create(Loader.prototype) as Loader
  const plugin = loader.unwrapExports(memberTimeContext) as Parameters<Context['plugin']>[0]
  await ctx.plugin(plugin, config)
}

function snapshotText(decision: PreStepDecision): string | undefined {
  const last = decision.kind === 'enter' ? decision.messages.at(-1) : undefined
  return last?.content[0]?.type === 'text' ? last.content[0].text : undefined
}

describe('Team Member clock composition', () => {
  it('is a namespace plugin with no declared inject, like member-context', () => {
    expect('default' in memberTimeContext).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const plugin = loader.unwrapExports(memberTimeContext) as Record<string, unknown>
    expect(plugin).toBe(memberTimeContext)
    expect(plugin.name).toBe(PLUGIN)
    expect(plugin.inject).toBeUndefined()
  })

  it('does nothing while the Host service is absent or the Agent is unbound', async () => {
    const ctx = new Context()
    const agent = fakeAgent(ctx)
    await mount(ctx)
    expect(await preStep(ctx, agent)).toEqual({ kind: 'enter', messages: [] })
    ctx.provide('agentTeam', { memberForAgent: () => undefined } as never)
    expect(await preStep(ctx, agent)).toEqual({ kind: 'enter', messages: [] })
    await ctx.fiber.dispose()
  })

  it('appends one durable snapshot with the folded elapsed baseline for the bound Member', async () => {
    const ctx = new Context()
    const events: Array<{ type: string; time: number; data?: unknown }> = [
      { type: 'turn/start', time: 1_000, data: { turn: 1 } },
      { type: 'user/message', time: 1_500, data: createUserMessage({ content: [{ type: 'text', text: 'human prompt' }], source: { kind: 'user' } }) },
    ]
    const agent = fakeAgent(ctx, events)
    ctx.provide('agentTeam', { memberForAgent: (subject: Agent) => subject === agent ? { memberId: 'member:clock' } : undefined } as never)
    await mount(ctx)

    const first = await preStep(ctx, agent, 1, 1)
    const text = snapshotText(first)
    expect(text).toBeDefined()
    expect(text).toContain('Team clock sampled while preparing turn 1, step 1:')
    // Elapsed hangs off the last model-visible event, rendered compact.
    expect(text).toContain('Elapsed since the preceding model-visible event:')
    expect(text).toMatch(/Team collaboration timestamps use UTC\+8\./)
    // The snapshot is a durable user message with this producer's own kind.
    const message = first.kind === 'enter' ? first.messages.at(-1) as UserMessage : undefined
    expect(message?.source).toMatchObject({ kind: PLUGIN, form: 'snapshot' })
    await ctx.fiber.dispose()
  })

  it('a step-2 snapshot measures elapsed against the step-1 snapshot once it lands in the log', async () => {
    const ctx = new Context()
    const events: Array<{ type: string; time: number; data?: unknown }> = []
    const agent = fakeAgent(ctx, events)
    ctx.provide('agentTeam', { memberForAgent: () => ({ memberId: 'member:clock' }) } as never)
    await mount(ctx)

    const first = await preStep(ctx, agent, 1, 1)
    const firstText = snapshotText(first)
    expect(firstText).toContain('Elapsed since the preceding model-visible event: unavailable.')
    // The injected snapshot becomes a session event, as the loop would log
    // it, at a realistic epoch time so the refresh gate sees true spacing.
    const injected = first.kind === 'enter' ? first.messages.at(-1) as UserMessage : undefined
    events.push({ type: 'user/message', time: Date.now(), data: injected! })

    // A quick follow-up step inside the refresh interval stays quiet: the
    // turn keeps its single snapshot, exactly the density decision.
    const quietStep = await preStep(ctx, agent, 1, 2)
    expect(quietStep).toEqual({ kind: 'enter', messages: [] })

    // Once the turn outlives the interval since the landed snapshot, the
    // next step samples again with the elapsed against that snapshot.
    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const refreshed = await (async () => {
      // Mount with a tiny interval for this check: a second plugin instance
      // with refreshIntervalMs 50 exercises the same gate on real clocks.
      const ctx2 = new Context()
      const events2: Array<{ type: string; time: number; data?: unknown }> = [...events]
      const agent2 = fakeAgent(ctx2, events2)
      ctx2.provide('agentTeam', { memberForAgent: () => ({ memberId: 'member:clock' }) } as never)
      await mount(ctx2, { refreshIntervalMs: 50 })
      await wait(60)
      const decision = await preStep(ctx2, agent2, 1, 3)
      await ctx2.fiber.dispose()
      return decision
    })()
    const refreshedText = snapshotText(refreshed)
    expect(refreshedText).toContain('Elapsed since the preceding step context:')
    expect(refreshedText).not.toContain('unavailable')
    await ctx.fiber.dispose()
  })

  it('keeps the loop-provided decision messages and appends the snapshot after them', async () => {
    const ctx = new Context()
    const agent = fakeAgent(ctx, [])
    ctx.provide('agentTeam', { memberForAgent: () => ({ memberId: 'member:clock' }) } as never)
    await mount(ctx)
    const loopMessage = createUserMessage({ content: [{ type: 'text', text: 'loop message' }], source: { kind: 'user' } })
    const decision = await agentEvents(ctx, agent).waterfall('agent/pre-step', {
      messages: [loopMessage], turn: 2, step: 1, signal: new AbortController().signal,
    }, async () => ({ kind: 'enter', messages: [loopMessage] }))
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') return
    expect(decision.messages[0]).toBe(loopMessage)
    expect(decision.messages.length).toBe(2)
    expect(snapshotText(decision)).toContain('turn 2, step 1')
    await ctx.fiber.dispose()
  })
})
