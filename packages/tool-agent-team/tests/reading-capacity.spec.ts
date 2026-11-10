import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readingCapacity } from '../src/reading-budget.ts'

function reader(resolveModelInfo?: () => Promise<unknown>): Agent {
  return {
    options: { provider: 'test', model: 'test' },
    session: { requestHeader: () => undefined },
    ctx: { get: () => resolveModelInfo === undefined ? undefined : { resolveModelInfo } },
  } as unknown as Agent
}

describe('bounded reading capacity cancellation', () => {
  it('refuses an already-cancelled read even without model metadata', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(readingCapacity(reader(), controller.signal)).rejects.toBe(controller.signal.reason)
  })

  it('does not fall back when cancellation arrives with model metadata', async () => {
    const controller = new AbortController()
    const agent = reader(async () => {
      controller.abort()
      return { context: { contextWindow: 100_000 } }
    })
    await expect(readingCapacity(agent, controller.signal)).rejects.toBe(controller.signal.reason)
  })

  it('preserves the caller cancellation reason when metadata rejects', async () => {
    const controller = new AbortController()
    const reason = new Error('caller stopped reading')
    const agent = reader(async () => {
      controller.abort(reason)
      throw new Error('metadata request stopped')
    })
    await expect(readingCapacity(agent, controller.signal)).rejects.toBe(reason)
  })

  it('still falls back when metadata fails without cancellation', async () => {
    const agent = reader(async () => { throw new Error('metadata unavailable') })
    await expect(readingCapacity(agent, new AbortController().signal)).resolves.toBe(256 * 1024)
  })

  it('still reserves headroom from a known context window', async () => {
    const agent = reader(async () => ({ context: { contextWindow: 100_000 } }))
    await expect(readingCapacity(agent, new AbortController().signal)).resolves.toBe(83_616)
  })
})
