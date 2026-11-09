import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AssistantStreamAccumulator, createAssistantMessage, createSystemMessage, createUserMessage, type LlmCallConfig, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'

import { measureMemberInput, memberCompactionThreshold } from '../src/member-compaction.ts'

/**
 * These cases run the real meter over a real Session log, because the budget is
 * only as good as the meter's own decision to reuse a provider count: a stub
 * that answers by header identity proves nothing about that decision.
 */

const disposals: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposals.splice(0).map(dispose => dispose())) })

function harness() {
  const ctx = new Context()
  new SessionProjectionRegistry(ctx)
  const meter = new TokenMeter(ctx)
  disposals.push(async () => { await ctx.fiber.dispose() })
  return { ctx, meter }
}

let serial = 0

/** One Session whose last request reported `pressure` prompt tokens and settled. */
function fixture(meter: TokenMeter, pressure = 230_000) {
  const session = Session.create(SessionId(`member-budget-${++serial}`))
  const header = canonicalHeader({
    config: { provider: 'review-no-provider', model: 'review-no-model', maxTokens: 68_587 },
    tools: [],
  })
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'abcd'.repeat(120_000) }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header, reason: 'initial' })
  const usage = { inputTokens: pressure - 4, outputTokens: 4 }
  const accumulator = new AssistantStreamAccumulator()
  const chunks: StreamChunk[] = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'done' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  for (const [index, chunk] of chunks.entries()) accumulator.push({ time: index, chunk })
  session.append('assistant/message', {
    turn: 1, step: 1, stream: [...accumulator.snapshot()], usage,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: header.config }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  // This hook clamps `maxTokens` per request, so the proposal never equals the
  // header that request was sent with — the condition that hid the count.
  const proposed: LlmCallConfig = { ...header.config, maxTokens: 128_000 }
  const anchored = meter.measure(session, header)
  expect(anchored.baseline.kind).toBe('usage')
  expect(anchored.totalTokens).toBe(pressure)
  return { session, header, proposed, agent: { session } as never, anchored }
}

const assembly = { sections: [], contexts: [], variables: {} } as never

describe('Agent Team Member context budget', () => {
  it('restores the provider count when only the proposed maxTokens differs', () => {
    const { ctx, meter } = harness()
    const { agent, proposed, anchored } = fixture(meter)
    expect(measureMemberInput(ctx, agent, proposed, [])).toBe(anchored.totalTokens)
  })

  it('adds pending messages to the provider count', () => {
    const { ctx, meter } = harness()
    const { agent, proposed, anchored } = fixture(meter)
    const pending = createUserMessage({ content: [{ type: 'text', text: 'abcd'.repeat(1_000) }], source: { kind: 'user' } })
    expect(measureMemberInput(ctx, agent, proposed, [pending]))
      .toBe(anchored.totalTokens + meter.estimateMessage(pending))
  })

  it('counts a tool set this step declares beyond the anchored one', () => {
    const { ctx, meter } = harness()
    const { session, header, agent, proposed, anchored } = fixture(meter)
    const tools = [{ name: 'large_schema', description: 'abcd'.repeat(20_000), parameters: { type: 'object' } }]
    // The growth is what the meter itself charges for the added declarations.
    const growth = meter.measure(session, { ...header, config: proposed, tools }).totalTokens
      - meter.measure(session, { ...header, config: proposed, tools: [] }).totalTokens
    const threshold = memberCompactionThreshold(256_000, 300_000)!
    // The provider count alone sits under the trigger; the new declarations are
    // what should carry the step over it.
    expect(anchored.totalTokens).toBeLessThan(threshold)
    expect(anchored.totalTokens + growth).toBeGreaterThanOrEqual(threshold)
    expect(measureMemberInput(ctx, agent, proposed, [], assembly, tools as never))
      .toBeGreaterThanOrEqual(anchored.totalTokens + growth)
  })

  it('keeps the provider count after a request that settled no usage', () => {
    const { ctx, meter } = harness()
    const { session, header, agent, proposed, anchored } = fixture(meter, 250_000)
    const before = measureMemberInput(ctx, agent, proposed, [])
    expect(before).toBe(anchored.totalTokens)
    // A failed or aborted attempt logs a header and no usage, so the latest
    // header is not the one the count belongs to.
    session.append('step/start', { turn: 1, step: 2 })
    session.append('request/header', {
      header: canonicalHeader({ ...header, config: { ...header.config, maxTokens: 70_000 } }), reason: 'change',
    })
    session.append('step/end', { turn: 1, step: 2 })
    expect(measureMemberInput(ctx, agent, proposed, [])).toBe(before)
  })

  it('does not borrow the provider count across a model-route change', () => {
    const { ctx, meter } = harness()
    const { session, header, agent, proposed, anchored } = fixture(meter, 250_000)
    const changed: LlmCallConfig = { ...proposed, model: 'different-review-model' }
    // The count belongs to the route that produced it; another route can only be
    // priced from its own header.
    const expected = meter.measure(session, { ...header, config: changed })
    expect(expected.baseline.kind).toBe('estimated')
    const actual = measureMemberInput(ctx, agent, changed, [])
    expect(actual).toBe(expected.totalTokens)
    expect(actual).toBeLessThan(anchored.totalTokens)
  })

  it('keeps the signed reduction after a surface replacement', () => {
    const { ctx, meter } = harness()
    const { session, header, agent, proposed, anchored } = fixture(meter, 250_000)
    const replaced = session.surface.nodes[1]!
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'short replacement' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: replaced, endSeq: replaced }, sourceEventSeqs: [replaced] })
    // A compaction replaces the surface with something smaller: the count must
    // fall with it instead of pinning the pre-replacement size.
    const expected = meter.measure(session, header)
    expect(expected.baseline.kind).toBe('usage')
    expect(expected.surfaceDeltaTokens).toBeLessThan(0)
    const actual = measureMemberInput(ctx, agent, proposed, [])
    expect(actual).toBe(expected.totalTokens)
    expect(actual).toBeLessThan(anchored.totalTokens)
  })

  it('counts new system text without writing to the Session log', () => {
    const { ctx, meter } = harness()
    const { session, agent, proposed, anchored } = fixture(meter)
    const text = 'abcd'.repeat(1_000)
    const presentation = { sections: [{ name: 'review', text, interpolate: false }], contexts: [], variables: {} } as never
    const revision = session.seq
    const actual = measureMemberInput(ctx, agent, proposed, [], presentation, [])
    expect(actual).toBe(anchored.totalTokens + meter.estimateMessage(createSystemMessage(text)))
    // Pricing a request is a read: the assembled prompt is measured, not logged.
    expect(session.seq).toBe(revision)
  })

  it('prices a first request from the heuristic when no count exists', () => {
    const { ctx, meter } = harness()
    const session = Session.create(SessionId(`member-budget-${++serial}`))
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'abcd'.repeat(1_000) }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const proposed: LlmCallConfig = { provider: 'review-no-provider', model: 'review-no-model', maxTokens: 128_000 }
    const measured = measureMemberInput(ctx, { session } as never, proposed, [])
    expect(measured).toBe(meter.measure(session, { config: proposed }).totalTokens)
  })
})
