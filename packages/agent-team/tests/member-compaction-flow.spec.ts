import { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, describe, expect, it } from 'vitest'
import MemberCompactionEngine from '../src/member-compaction-engine.ts'
import { DEFAULT_MEMBER_COMPACTION, installMemberCompaction, MEMBER_SUMMARY_INSTRUCTION_TOKENS, MEMBER_SUMMARY_TOKENS, type MemberCompactionConfig } from '../src/member-compaction.ts'

class BudgetAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly summaries: GenerateOptions[] = []
  outputLimit = 128_000
  overflowAtRequest: number | undefined
  failRequestAt: number | undefined
  summary = 'Durable checkpoint: continue the requested work.'
  /** Routes whose summary spends the whole cap on reasoning and returns no text. */
  readonly silentRoutes = new Set<string>()
  /** Per-model windows that override the defaults below. */
  readonly windows = new Map<string, number>()
  beforeSummary: (() => void) | undefined

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: this.windows.get(model) ?? (model === 'small' ? 272_000 : model === 'tiny' ? 8_000 : 2_000_000) },
      defaultMaxTokens: this.outputLimit,
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const summarizing = options.purpose === 'compaction'
    if (summarizing) this.summaries.push(options)
    else this.requests.push(options)
    if (summarizing) {
      this.beforeSummary?.()
      if (this.silentRoutes.has(options.model)) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
    }
    if (!summarizing && this.requests.length === this.failRequestAt) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'ADAPTER_FAILURE', message: 'fixture provider failure' } } }
      return
    }
    if (!summarizing && this.requests.length === this.overflowAtRequest) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'fixture context overflow' } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: summarizing ? this.summary : 'Acknowledged.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function fixture(model = 'large', settings: MemberCompactionConfig = { ...DEFAULT_MEMBER_COMPACTION }, maxTokens?: number, engineConfig: BasicCompactionConfig = { maxTokens: MEMBER_SUMMARY_TOKENS }): Promise<{
  ctx: Context; agent: Agent; adapter: BudgetAdapter; engine: MemberCompactionEngine;
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  const adapter = new BudgetAdapter()
  ctx.llm.registerAdapter(['budget-test'], adapter)
  ctx.provide('agentTeam', { config: { memberCompaction: { get: () => settings } } } as never)
  await ctx.plugin(MemberCompactionEngine, engineConfig)
  const engine = ctx.get('compaction') as MemberCompactionEngine
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(`budget-${model}`), {
    provider: 'budget-test', model, ...maxTokens === undefined ? {} : { maxTokens },
  })
  installModelSelection(agent.ctx)
  installMemberCompaction(agent.ctx, agent, () => settings, () => engine, () => false)
  return { ctx, agent, adapter, engine }
}

async function send(agent: Agent, tokens: number): Promise<void> {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'e'.repeat(tokens * 4) }] }))
  await agent.whenIdle()
}

describe('Member compaction through real requests', () => {
  it('compacts a 2M model at 256K, including pending input, without a proportional retained tail', async () => {
    const { agent, adapter, ctx } = await fixture()
    await send(agent, 180_000)
    expect(adapter.summaries).toHaveLength(0)
    await send(agent, 85_000)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.summaries[0]?.maxTokens).toBe(MEMBER_SUMMARY_TOKENS)
    expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeLessThan(100_000)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/end')).toHaveLength(1)
  })

  it('lets 272K models pass 78K and compacts at the window ratio', async () => {
    const { agent, adapter } = await fixture('small')
    await send(agent, 100_000)
    await send(agent, 90_000)
    expect(adapter.summaries).toHaveLength(0)
    expect(adapter.requests).toHaveLength(2)
    await send(agent, 35_000)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(3)
  })

  it('restores the original output allowance after compaction instead of making a clamp sticky', async () => {
    const { agent, adapter, engine } = await fixture('small')
    await send(agent, 190_000)
    expect(adapter.requests[0]!.maxTokens).toBeLessThan(80_000)
    expect(agent.session.requestHeader()?.config.maxTokens).toBe(adapter.requests[0]!.maxTokens)
    await engine.compactNow(agent, new AbortController().signal)
    await send(agent, 1_000)
    expect(adapter.requests[1]!.maxTokens).toBe(128_000)
    expect(agent.session.requestHeader()?.config.maxTokens).toBe(128_000)
    expect(agent.session.requestHeader()?.adapterDefaults?.maxTokens).toBe(true)
  })

  it('does not commit a new temporary allowance when preparation is cancelled before the header is logged', async () => {
    const { agent, adapter, engine } = await fixture('small')
    await send(agent, 190_000)
    const logged = agent.session.requestHeader()?.config.maxTokens
    const stop = agent.ctx.on('agent/request', async (_payload, next) => {
      const request = await next()
      agent.cancel({ kind: 'user' })
      return request
    }, { prepend: true })
    await send(agent, 500)
    stop()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.requestHeader()?.config.maxTokens).toBe(logged)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('aborted')
    await engine.compactNow(agent, new AbortController().signal)
    await send(agent, 1_000)
    expect(adapter.requests[1]!.maxTokens).toBe(128_000)
  })

  it('does not raise an explicit smaller output cap when a larger default exists', async () => {
    const { agent, adapter, engine } = await fixture('small', { ...DEFAULT_MEMBER_COMPACTION }, 8_192)
    await send(agent, 190_000)
    await engine.compactNow(agent, new AbortController().signal)
    await send(agent, 1_000)
    expect(adapter.requests.map(request => request.maxTokens)).toEqual([8_192, 8_192])
  })

  it('applies a model switch the new window can hold, then budgets from that window', async () => {
    const { agent, adapter } = await fixture()
    await send(agent, 20_000)
    agent.model.select({ provider: 'budget-test', model: 'small' })
    await send(agent, 20_000)
    expect(adapter.requests[1]!.model).toBe('small')
    expect(adapter.requests[1]!.maxTokens).toBe(128_000)
  })

  it('refuses a model switch the new window cannot hold, preserving the previous route', async () => {
    const { agent, adapter } = await fixture()
    await send(agent, 180_000)
    agent.model.select({ provider: 'budget-test', model: 'small' })
    await send(agent, 45_000)
    // 0.2.2 compacts on the committed route before honoring a switch and refuses one it cannot make safe. One uncompactable user message leaves no range, so the request never reaches the adapter and the previous route stays committed.
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.summaries).toHaveLength(0)
    expect(agent.session.requestHeader()?.config.model).toBe('large')
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
  })

  it('honors a smaller configured budget with no retained-tail floor', async () => {
    const { agent, adapter } = await fixture('large', { enabled: true, tokens: 100_000 })
    await send(agent, 75_000)
    await send(agent, 30_000)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
  })

  it('stops clearly when a single pending input cannot be made to fit the budget', async () => {
    const { agent, adapter } = await fixture('large', { enabled: true, tokens: 100_000 })
    await send(agent, 110_000)
    expect(adapter.requests).toHaveLength(0)
    expect(adapter.summaries).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(agent.inbox.nextTurn[0]!.content).toEqual([{ type: 'text', text: 'e'.repeat(110_000 * 4) }])
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason).toMatchObject({
      kind: 'error', error: { message: expect.stringContaining('shorten the input') },
    })
  })

  it('keeps the upstream pressure policy when the Team boundary is disabled', async () => {
    const { agent, adapter } = await fixture('small', { enabled: false, tokens: 256_000 })
    await send(agent, 60_000)
    await send(agent, 60_000)
    await send(agent, 1_000)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(3)
  })

  it('closes a failed compaction and makes no overflowing normal request', async () => {
    const { agent, adapter } = await fixture('large', { enabled: true, tokens: 100_000 })
    await send(agent, 75_000)
    adapter.summary = 'not smaller'.repeat(50_000)
    await send(agent, 30_000)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.summaries).toHaveLength(1)
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'compaction/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'compaction/end')).toHaveLength(1)
    expect(events.findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('error')
    expect(agent.inbox.nextTurn).toHaveLength(1)
  })

  it('keeps upstream overflow recovery and does not count or admit pending input twice on retry', async () => {
    const { agent, adapter } = await fixture()
    await send(agent, 40_000)
    adapter.overflowAtRequest = 2
    await send(agent, 5_000)
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.summaries).toHaveLength(1)
    const offered = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === 'e'.repeat(20_000)))
    expect(offered).toHaveLength(1)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  })

  it('can retry retained input after the budget changes without automatically spinning', async () => {
    const settings = { enabled: true, tokens: 100_000 }
    const { agent, adapter } = await fixture('large', settings)
    await send(agent, 110_000)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    settings.tokens = 150_000
    await send(agent, 10)
    expect(adapter.requests).toHaveLength(2)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(adapter.requests[0]!.messages.some(message => message.content.some(block => block.type === 'text'
      && block.text === 'e'.repeat(440_000)))).toBe(true)
  })

  it('leaves a tiny-window route usable instead of failing its requests', async () => {
    const { agent, adapter, engine } = await fixture('tiny')
    await send(agent, 40_000)
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.summaries).toHaveLength(0)
    expect(engine).toBeDefined()
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  })

  it('leaves middleware-served virtual routes usable without a model directory entry', async () => {
    const { ctx, agent } = await fixture()
    let served = 0
    ctx.on('llm/stream', (options, next) => {
      if (options.provider !== 'virtual') return next()
      served += 1
      return (async function* (): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    })
    agent.model.select({ provider: 'virtual', model: 'virtual' })
    await send(agent, 10)
    expect(served).toBe(1)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  })
})

describe('Member summary target and bounded fallback', () => {
  const lastTurn = (agent: Agent) => agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason
  /** Three balanced turns just under the default budget, so a later step has a compactable range. */
  const history = async (agent: Agent): Promise<void> => {
    await send(agent, 85_000)
    await send(agent, 85_000)
    await send(agent, 80_000)
  }

  it('routes a switching step summary to the model the switch names, with the real call envelope', async () => {
    const { agent, adapter } = await fixture()
    await history(agent)
    adapter.windows.set('middle', 1_000_000)
    agent.model.select({ provider: 'budget-test', model: 'middle' })
    await send(agent, 40_000)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.summaries[0]!.model).toBe('middle')
    expect(adapter.summaries[0]!.sessionId).toBe(agent.session.id)
    expect(adapter.summaries[0]!.toolHistory).toEqual(agent.session.toolHistory())
    expect(agent.session.requestHeader()?.config.model).toBe('middle')
  })

  it('refuses a proposed window the summary input would exactly fill', async () => {
    const { agent, adapter, engine, ctx } = await fixture()
    await history(agent)
    const input = { messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'e'.repeat(160_000) }] })] }
    const need = input.messages.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0)
    const tools = estimateToolsTokens(agent.session.requestHeader())
    const route = { provider: 'budget-test', model: 'edge' }
    const priced = need + tools + MEMBER_SUMMARY_INSTRUCTION_TOKENS + MEMBER_SUMMARY_TOKENS
    adapter.windows.set('edge', priced)
    expect(await engine.canHoldSummary(agent, input, route)).toBe(false)
    adapter.windows.set('edge', priced + 1)
    expect(await engine.canHoldSummary(agent, input, route)).toBe(true)
  })

  it('prices the capability gate from the route summary cap a model policy resolves', async () => {
    const { agent, adapter, ctx } = await fixture('large', { ...DEFAULT_MEMBER_COMPACTION }, undefined,
      { maxTokens: MEMBER_SUMMARY_TOKENS, modelPolicies: [{ provider: 'budget-test', model: 'middle', maxTokens: 8_192 }] })
    await history(agent)
    const surface = ctx.tokenMeter.measure(agent.session).totalTokens
    adapter.windows.set('middle', surface + 8_193)
    agent.model.select({ provider: 'budget-test', model: 'middle' })
    await send(agent, 40_000)
    expect(adapter.summaries[0]!.model).toBe('middle')
  })

  it('summarizes once more on the committed route after the proposed one cannot write', async () => {
    const { agent, adapter } = await fixture()
    await history(agent)
    adapter.windows.set('middle', 1_000_000)
    adapter.silentRoutes.add('middle')
    agent.model.select({ provider: 'budget-test', model: 'middle' })
    await send(agent, 40_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['middle', 'large'])
    expect(agent.session.requestHeader()?.config.model).toBe('middle')
  })

  it('passes the request through after a bounded failure and stops summarizing that route', async () => {
    const { agent, adapter } = await fixture()
    await history(agent)
    adapter.silentRoutes.add('large')
    await send(agent, 40_000)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(4)
    expect(lastTurn(agent)?.kind).toBe('completed')
    const failures = agent.session.snapshotEvents()
      .filter(event => event.type === 'compaction/end' && event.data.error !== undefined)
    expect(failures).toHaveLength(1)
    await send(agent, 1_000)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests).toHaveLength(5)
    expect(lastTurn(agent)?.kind).toBe('completed')
  })

  it('clears the circuit after a successful manual compaction, which still tries while it is open', async () => {
    const { agent, adapter, engine } = await fixture()
    await history(agent)
    adapter.silentRoutes.add('large')
    await send(agent, 40_000)
    expect(adapter.summaries).toHaveLength(1)
    await send(agent, 1_000)
    expect(adapter.summaries).toHaveLength(1)
    expect(lastTurn(agent)?.kind).toBe('completed')
    adapter.silentRoutes.delete('large')
    await engine.compactNow(agent, new AbortController().signal)
    expect(adapter.summaries).toHaveLength(2)
    await send(agent, 260_000)
    expect(adapter.summaries).toHaveLength(3)
  })

  it('does not open the circuit when the turn is cancelled mid-summary', async () => {
    const { agent, adapter, engine } = await fixture()
    await history(agent)
    adapter.silentRoutes.add('large')
    adapter.beforeSummary = () => agent.cancel({ kind: 'user' })
    await send(agent, 40_000)
    expect(adapter.summaries).toHaveLength(1)
    expect(lastTurn(agent)?.kind).toBe('aborted')
    expect(engine.degraded(agent, { provider: 'budget-test', model: 'large' })).toBe(false)
    adapter.beforeSummary = undefined
    await send(agent, 40_000)
    expect(adapter.summaries).toHaveLength(2)
  })

  it('refuses a request whose route left the step selection before summarizing', async () => {
    const { agent, adapter } = await fixture()
    await history(agent)
    agent.model.select({ provider: 'budget-test', model: 'small' })
    agent.ctx.on('agent/request', async (_payload, next) => ({ ...(await next()), model: 'large' }))
    await send(agent, 40_000)
    expect(adapter.summaries).toHaveLength(0)
    expect(lastTurn(agent)).toMatchObject({ kind: 'error', error: { message: expect.stringContaining('disagrees') } })
  })

  it('keeps the step route out of a later manual compaction', async () => {
    const { agent, adapter, engine } = await fixture()
    await history(agent)
    adapter.silentRoutes.add('small')
    agent.model.select({ provider: 'budget-test', model: 'small' })
    agent.ctx.on('agent/request', async (_payload, next) => ({ ...(await next()), model: 'large' }))
    await send(agent, 40_000)
    expect(adapter.summaries).toHaveLength(0)
    await engine.compactNow(agent, new AbortController().signal)
    expect(adapter.summaries.map(options => options.model)).toEqual(['large'])
  })

  it('honours a summary target configured for the step route only', async () => {
    const { agent, adapter } = await fixture('large', { ...DEFAULT_MEMBER_COMPACTION }, undefined,
      { maxTokens: MEMBER_SUMMARY_TOKENS, modelPolicies: [{ provider: 'budget-test', model: 'far', summarizationProvider: 'budget-test', summarizationModel: 'summarizer-far' }] })
    await history(agent)
    adapter.windows.set('far', 1_000_000)
    agent.model.select({ provider: 'budget-test', model: 'far' })
    await send(agent, 40_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['summarizer-far'])
  })

  it('keeps a summary target configured for the committed route', async () => {
    const { agent, adapter } = await fixture('large', { ...DEFAULT_MEMBER_COMPACTION }, undefined,
      { maxTokens: MEMBER_SUMMARY_TOKENS, modelPolicies: [{ provider: 'budget-test', model: 'large', summarizationProvider: 'budget-test', summarizationModel: 'summarizer-large' }] })
    await history(agent)
    adapter.windows.set('far', 1_000_000)
    agent.model.select({ provider: 'budget-test', model: 'far' })
    await send(agent, 40_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['summarizer-large'])
  })

  it('keeps an operator pin on the summary target without rotating to the conversation model', async () => {
    const { agent, adapter } = await fixture('large', { ...DEFAULT_MEMBER_COMPACTION }, undefined,
      { maxTokens: MEMBER_SUMMARY_TOKENS, summarizationProvider: 'budget-test', summarizationModel: 'summarizer' })
    await history(agent)
    adapter.windows.set('far', 1_000_000)
    adapter.silentRoutes.add('summarizer')
    agent.model.select({ provider: 'budget-test', model: 'far' })
    await send(agent, 40_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['summarizer'])
    await send(agent, 1_000)
    expect(adapter.summaries).toHaveLength(1)
  })

  it('uses a summary target configured on a small-window step route ahead of that window', async () => {
    const { agent, adapter } = await fixture('large', { ...DEFAULT_MEMBER_COMPACTION }, 8_192,
      { maxTokens: MEMBER_SUMMARY_TOKENS, modelPolicies: [{ provider: 'budget-test', model: 'far', summarizationProvider: 'budget-test', summarizationModel: 'summarizer-far' }] })
    await history(agent)
    adapter.windows.set('far', 200_000)
    agent.model.select({ provider: 'budget-test', model: 'far' })
    await send(agent, 40_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['summarizer-far'])
  })

  it('falls back to the committed route when a configured summary target fails', async () => {
    const { agent, adapter } = await fixture('large', { ...DEFAULT_MEMBER_COMPACTION }, undefined,
      { maxTokens: MEMBER_SUMMARY_TOKENS, modelPolicies: [{ provider: 'budget-test', model: 'far', summarizationProvider: 'budget-test', summarizationModel: 'summarizer-far' }] })
    await history(agent)
    adapter.windows.set('far', 1_000_000)
    adapter.silentRoutes.add('summarizer-far')
    agent.model.select({ provider: 'budget-test', model: 'far' })
    await send(agent, 40_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['summarizer-far', 'large'])
  })

  it('prices the call region, not the whole session, when a route has a smaller window', async () => {
    const { agent, adapter } = await fixture('large', { enabled: true, tokens: 2_000_000 })
    await history(agent)
    adapter.windows.set('sw', 270_000)
    agent.model.select({ provider: 'budget-test', model: 'sw' })
    await send(agent, 1_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['sw', 'sw'])
  })

  it('lets an explicit summary configuration outrank the step route', async () => {
    const { agent, adapter } = await fixture('large', { ...DEFAULT_MEMBER_COMPACTION }, undefined,
      { maxTokens: MEMBER_SUMMARY_TOKENS, summarizationProvider: 'budget-test', summarizationModel: 'summarizer' })
    await history(agent)
    adapter.windows.set('middle', 1_000_000)
    agent.model.select({ provider: 'budget-test', model: 'middle' })
    await send(agent, 40_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['summarizer'])
  })

  it('keeps the step route readable for that step overflow recovery', async () => {
    const { agent, adapter } = await fixture('large', { enabled: true, tokens: 2_000_000 })
    await send(agent, 20_000)
    adapter.windows.set('middle', 1_000_000)
    agent.model.select({ provider: 'budget-test', model: 'middle' })
    adapter.overflowAtRequest = 2
    await send(agent, 5_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['middle'])
    expect(lastTurn(agent)?.kind).toBe('completed')
  })

  it('tries the failed route again once another route held the summary', async () => {
    const { agent, adapter, engine } = await fixture()
    await history(agent)
    adapter.silentRoutes.add('large')
    await send(agent, 40_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['large'])
    expect(engine.degraded(agent, { provider: 'budget-test', model: 'large' })).toBe(true)
    // Another route writes the checkpoint, so the failure belonged to 'large' alone.
    adapter.silentRoutes.delete('large')
    adapter.windows.set('middle', 1_000_000)
    agent.model.select({ provider: 'budget-test', model: 'middle' })
    await send(agent, 1_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['large', 'middle'])
    agent.model.select({ provider: 'budget-test', model: 'large' })
    await send(agent, 260_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['large', 'middle', 'large'])
    expect(engine.degraded(agent, { provider: 'budget-test', model: 'large' })).toBe(false)
  })

  it('clears the step route when pre-step rejects the step', async () => {
    const { agent, adapter, engine } = await fixture()
    await history(agent)
    adapter.windows.set('middle', 1_000_000)
    let rejecting = false
    agent.ctx.on('agent/pre-step', async (_payload, next) => (rejecting ? { kind: 'reject' as const } : next()))
    agent.model.select({ provider: 'budget-test', model: 'middle' })
    rejecting = true
    await send(agent, 1_000)
    expect(lastTurn(agent)?.kind).toBe('blocked')
    expect(adapter.requests).toHaveLength(3)
    rejecting = false
    await engine.compactNow(agent, new AbortController().signal)
    expect(adapter.summaries.map(options => options.model)).toEqual(['large'])
  })

  it('clears the step route when pre-step throws', async () => {
    const { agent, adapter, engine } = await fixture()
    await history(agent)
    adapter.windows.set('middle', 1_000_000)
    let failing = false
    agent.ctx.on('agent/pre-step', async (_payload, next) => {
      if (failing) throw new Error('fixture pre-step failure')
      return next()
    })
    agent.model.select({ provider: 'budget-test', model: 'middle' })
    failing = true
    await send(agent, 1_000)
    expect(lastTurn(agent)?.kind).toBe('error')
    expect(adapter.requests).toHaveLength(3)
    failing = false
    await engine.compactNow(agent, new AbortController().signal)
    expect(adapter.summaries.map(options => options.model)).toEqual(['large'])
  })

  it('pays for at most one region and its one alternative per step, switching or not', async () => {
    // Per step the shipped paths allow one Team admission region, compactionRetries + 1
    // model-switch regions and maxOverflowRetries overflow regions. The fallback adds one
    // further summary for the step, and a failure then pauses every automatic summary on
    // that route, so two is the ceiling — not two per region, and none on later turns.
    const { agent, adapter, engine } = await fixture()
    await history(agent)
    adapter.windows.set('far', 400_000)
    adapter.silentRoutes.add('far')
    adapter.silentRoutes.add('large')
    agent.model.select({ provider: 'budget-test', model: 'far' })
    await send(agent, 40_000)
    expect(adapter.summaries.map(options => options.model)).toEqual(['far', 'large'])
    expect(lastTurn(agent)?.kind).toBe('error')
    await send(agent, 1_000)
    expect(adapter.summaries).toHaveLength(2)
    adapter.silentRoutes.delete('large')
    adapter.silentRoutes.delete('far')
    await engine.compactNow(agent, new AbortController().signal)
    expect(adapter.summaries.map(options => options.model)).toEqual(['far', 'large', 'large'])
  })
})
