import { describe, expect, it } from 'vitest'
import type { InboxState } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { coldInboxOf } from '../src/cold-inbox.ts'

/** One pending message; the id is what the cross-list uniqueness rule reads. */
function pending(text: string, id: string): UserMessage {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  return { ...message, id: id as MessageId }
}

/** An `agent/inbox/spliced` event with only the fields the fold reads. */
function splice(target: 'next-turn' | 'next-step', start: number, inserted: readonly UserMessage[], removedCount?: number): SessionEvent {
  return {
    type: 'agent/inbox/spliced',
    data: { target, start, ...(removedCount === undefined ? {} : { removedCount }), inserted },
  } as unknown as SessionEvent
}

/** Any other Session event, which the fold must step over without changing state. */
const otherEvent = { type: 'user/message', data: {} } as unknown as SessionEvent

/** Read the pending bodies back as text, so an assertion names them. */
function texts(state: InboxState | undefined): { turn: (string | undefined)[]; step: (string | undefined)[] } {
  const body = (message: UserMessage): string | undefined => (message.content[0]?.type === 'text' ? message.content[0].text : undefined)
  return { turn: (state?.['next-turn'] ?? []).map(body), step: (state?.['next-step'] ?? []).map(body) }
}

describe('coldInboxOf folds a cold generation pending input', () => {
  it('returns both lists empty for a Session with no splice history', () => {
    expect(coldInboxOf([])).toEqual({ 'next-turn': [], 'next-step': [] })
  })

  it('appends, inserts and removes within one list, and keeps the two lists apart', () => {
    const first = pending('first', 'm1')
    const second = pending('second', 'm2')
    const third = pending('third', 'm3')
    const step = pending('step input', 'm4')
    const state = coldInboxOf([
      otherEvent,
      splice('next-turn', 0, [first]),
      splice('next-turn', 1, [second]),
      splice('next-step', 0, [step]),
      // Insert before the first pending turn message, and drop the last one.
      splice('next-turn', 0, [third], 0),
      splice('next-turn', 2, [], 1),
    ])
    expect(texts(state)).toEqual({ turn: ['third', 'first'], step: ['step input'] })
  })

  it('treats an absent removedCount as removing nothing', () => {
    const state = coldInboxOf([
      splice('next-turn', 0, [pending('kept', 'm1')]),
      splice('next-turn', 0, [pending('inserted', 'm2')]),
    ])
    expect(texts(state)).toEqual({ turn: ['inserted', 'kept'], step: [] })
  })

  it('refuses a message pending in both lists', () => {
    const shared = pending('shared', 'm1')
    const state = coldInboxOf([
      splice('next-turn', 0, [shared]),
      splice('next-step', 0, [pending('step', 'm2')]),
      // The same message id lands in the other list: the fold must not repair it.
      splice('next-step', 0, [shared], 0),
    ])
    expect(state).toBeUndefined()
  })

  it('refuses coordinates that reach outside the list they splice', () => {
    const kept = pending('kept', 'm1')
    for (const bad of [
      splice('next-turn', 2, [pending('past the end', 'm2')]),
      splice('next-turn', -1, [pending('negative', 'm2')]),
      splice('next-turn', 0, [pending('non-integer', 'm2')], 0.5),
      splice('next-turn', 0, [], 2),
    ]) {
      expect(coldInboxOf([splice('next-turn', 0, [kept]), bad])).toBeUndefined()
    }
  })

  it('ignores events that are not inbox splices', () => {
    const state = coldInboxOf([
      otherEvent,
      { type: 'agent/inbox/claimed', data: {} } as unknown as SessionEvent,
      splice('next-turn', 0, [pending('only', 'm1')]),
      otherEvent,
    ])
    expect(texts(state)).toEqual({ turn: ['only'], step: [] })
  })
})
