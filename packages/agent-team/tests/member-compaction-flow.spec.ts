import { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage, LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach, describe, expect, it } from 'vitest'
import MemberCompactionEngine from '../src/member-compaction-engine.ts'
import { DEFAULT_MEMBER_COMPACTION, installMemberCompaction, MEMBER_SUMMARY_TOKENS, type MemberCompactionConfig } from '../src/member-compaction.ts'

class BudgetAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  readonly summaries: GenerateOptions[] = []
  outputLimit = 128_000
  overflowAtRequest: number | undefined
  summary = 'Durable checkpoint: continue the requested work.'

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model,
      context: { contextWindow: model === 'small' ? 272_000 : model === 'tiny' ? 8_000 : 2_000_000 },
      defaultMaxTokens: this.outputLimit,
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const summarizing = options.purpose === 'compaction'
    if (summarizing) this.summaries.push(options)
    else this.requests.push(options)
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

async function fixture(model = 'large', settings: MemberCompactionConfig = { ...DEFAULT_MEMBER_COMPACTION }, maxTokens?: number): Promise<{
  ctx: Context; agent: Agent; adapter: BudgetAdapter; engine: MemberCompactionEngine; selection: ModelSelectionRef;
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  const adapter = new BudgetAdapter()
  ctx.llm.registerAdapter(['budget-test'], adapter)
  ctx.provide('agentTeam', { config: { memberCompaction: { get: () => settings } } } as never)
  await ctx.plugin(MemberCompactionEngine, { maxTokens: MEMBER_SUMMARY_TOKENS })
  const engine = ctx.get('compaction') as MemberCompactionEngine
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(`budget-${model}`), {
    provider: 'budget-test', model, ...maxTokens === undefined ? {} : { maxTokens },
  })
  const selection: ModelSelectionRef = { current: { provider: 'budget-test', model }, assembled: undefined }
  installModelSelection(agent.ctx, selection)
  installMemberCompaction(agent.ctx, agent, () => settings, () => engine, () => false)
  return { ctx, agent, adapter, engine, selection }
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

  it('applies a model switch before deciding the input and output budgets', async () => {
    const { agent, adapter, selection } = await fixture()
    await send(agent, 180_000)
    selection.current = { provider: 'budget-test', model: 'small' }
    await send(agent, 45_000)
    expect(adapter.summaries).toHaveLength(1)
    expect(adapter.requests[1]!.model).toBe('small')
    expect(adapter.requests[1]!.maxTokens).toBe(128_000)
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
    const { ctx, agent, selection } = await fixture()
    let served = 0
    ctx.on('llm/stream', (options, next) => {
      if (options.provider !== 'virtual') return next()
      served += 1
      return (async function* (): AsyncIterable<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    })
    selection.current = { provider: 'virtual', model: 'virtual' }
    await send(agent, 10)
    expect(served).toBe(1)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason.kind).toBe('completed')
  })
})
