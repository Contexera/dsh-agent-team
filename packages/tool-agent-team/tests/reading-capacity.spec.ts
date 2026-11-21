import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { budgetReading, messagePartText, readingCapacity } from '../src/reading-budget.ts'

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

  it.each([
    [16_000, 0],
    [100_000, 83_616],
    [1_000_000, 256 * 1024],
  ])('reserves headroom and clamps a %i-token context window to %i UTF-16 units', async (contextWindow, expected) => {
    const agent = reader(async () => ({ context: { contextWindow } }))
    await expect(readingCapacity(agent, new AbortController().signal)).resolves.toBe(expected)
  })
})

function emptyContext(): Agent {
  return { session: Session.create(SessionId('session:reading-budget')) } as Agent
}

describe('bounded read selection', () => {
  it('backs off before a split surrogate and keeps the partial Message and reminders unacknowledged', () => {
    const messageRef = 'message:long'
    const body = `abc🙂${'z'.repeat(33_000)}`
    const reading: Parameters<typeof budgetReading>[1] = {
      kind: 'read', projectRef: 'project:alpha',
      facts: [{ sequence: 12, kind: 'message', messageRef, body, unread: true }],
      remainingUnreadCount: 2, reminders: [{ kind: 'review-backlog' }],
    }
    // Leave room for the high surrogate, but not for the whole emoji.
    const split = messagePartText(body, { messageRef, start: 0, end: 4, complete: false })
    const prefix = 'x'.repeat(32 * 1024 - 64 - split.length)
    const render = (value: typeof reading) => prefix + messagePartText(body, value.messageParts?.[0])
    const { through, value } = budgetReading(emptyContext(), reading, render, body.length)

    expect(through).toBe(0)
    expect(value.messageParts).toEqual([{ messageRef, start: 0, end: 3, complete: false }])
    expect(render(value)).toContain('>\nabc\n</message-part>')
    expect(value.remainingUnreadCount).toBe(3)
    expect(value.reminders).toEqual([])
  })

  it('refuses an indivisible oversized Activity instead of acknowledging the shorter Message after it', () => {
    const reading = {
      kind: 'read', projectRef: 'project:alpha',
      facts: [
        { sequence: 12, kind: 'activity', body: 'x'.repeat(32 * 1024), unread: true },
        { sequence: 13, kind: 'message', messageRef: 'message:short', body: 'short', unread: true },
      ],
    }
    const render = (value: typeof reading) => value.facts.map(fact => fact.body).join('\n')
    expect(() => budgetReading(emptyContext(), reading, render, 256 * 1024))
      .toThrow('nothing acknowledged. Activity events cannot be split.')
  })
})
