import { describe, expect, it } from 'vitest'
import { planInboxDelivery, type InboxDeliveryInput, type InboxThreadUnread } from '../src/inbox-delivery.ts'
import type { AgentTeamProjectRef, AgentTeamThreadRef } from '../src/types/entities.ts'
import type { AgentTeamMainTimelineEntry } from '../src/types/requests-results.ts'

const owned = 'project:00000000-0000-4000-8000-000000000001' as AgentTeamProjectRef
const other = 'project:00000000-0000-4000-8000-000000000002' as AgentTeamProjectRef
const threadA = 'thread:00000000-0000-4000-8000-00000000000a' as AgentTeamThreadRef
const threadB = 'thread:00000000-0000-4000-8000-00000000000b' as AgentTeamThreadRef

function thread(threadRef: AgentTeamThreadRef, projectRef: AgentTeamProjectRef, sequences: readonly number[], options: { direct?: readonly number[]; following?: boolean; reminders?: readonly { kind: string; baselineSequence: number }[] } = {}): InboxThreadUnread {
  return {
    item: { projectRef, thread: { threadRef }, ...(options.following === false ? {} : { attention: {} }) },
    facts: sequences.map(sequence => ({ fact: { kind: 'message', sequence }, unread: true, direct: options.direct?.includes(sequence) ?? false })),
    ...(options.reminders === undefined ? {} : { reminders: options.reminders }),
  } as unknown as InboxThreadUnread
}

function plan(input: Partial<InboxDeliveryInput>) {
  return planInboxDelivery({ threads: [], main: [], covered: undefined, ...input })
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index)

describe('every unread Thread fact interrupts, whatever the reader owns', () => {
  it('a Project owner gets one ordinary update immediately', () => {
    const result = plan({ threads: [thread(threadA, owned, [1])] })
    expect(result.trigger).toBe('immediate')
    expect(result.threads[0]).toMatchObject({ role: 'follower', delivery: 'immediate' })
  })

  it('a reader who owns no Project gets the same result', () => {
    const result = plan({ threads: [thread(threadA, other, [1])] })
    expect(result.trigger).toBe('immediate')
    expect(result.threads[0]).toMatchObject({ role: 'follower', delivery: 'immediate' })
  })

  it('one ordinary update is enough, so no count accumulates across reads', () => {
    const first = plan({ threads: [thread(threadA, owned, [1])] })
    expect(first.trigger).toBe('immediate')
    expect(plan({ threads: [thread(threadA, owned, [2])], covered: first.signature }).trigger).toBe('immediate')
  })

  it('carries an ordinary update alongside a mention instead of waiting for it', () => {
    const result = plan({ threads: [thread(threadA, owned, [1, 2], { direct: [2] })] })
    expect(result.trigger).toBe('immediate')
    expect(result.threads[0]).toMatchObject({ role: 'follower', delivery: 'immediate' })
  })
})

describe('an unchanged unread set spends no second attempt', () => {
  it('the same Thread facts already have a delivery attempt', () => {
    const first = plan({ threads: [thread(threadA, owned, [1, 2, 3])] })
    expect(plan({ threads: [thread(threadA, owned, [1, 2, 3])], covered: first.signature }).trigger).toBeUndefined()
  })

  it('a new fact on the same Thread rederives', () => {
    const first = plan({ threads: [thread(threadA, owned, [1, 2, 3])] })
    expect(plan({ threads: [thread(threadA, owned, [1, 2, 3, 4])], covered: first.signature }).trigger).toBe('immediate')
  })

  it('an unchanged set across two Threads is not delivered twice', () => {
    const threads = [thread(threadA, owned, [1]), thread(threadB, owned, [2])]
    const first = plan({ threads })
    expect(plan({ threads, covered: first.signature }).trigger).toBeUndefined()
  })
})

describe('a Thread the notice could not render stays undelivered', () => {
  it('retries the dropped Thread facts the next time, unchanged', () => {
    const threads = [thread(threadA, owned, [1]), thread(threadB, owned, [2])]
    const first = plan({ threads })
    // The notice rendered Thread A and dropped Thread B, so what it answered is
    // Thread A's facts alone. The dropped Thread keeps its facts out of that.
    const answered = plan({ threads, undelivered: [threadB] })
    expect(answered.delivered).not.toContain(threadB)
    expect(plan({ threads, covered: answered.delivered }).trigger).toBe('immediate')
  })

  it('still stands down for the Threads the notice did render', () => {
    const threads = [thread(threadA, owned, [1]), thread(threadB, owned, [2])]
    const answered = plan({ threads, undelivered: [threadB] })
    // Thread A is unchanged and was rendered, so it is covered: only Thread B
    // still owes a delivery.
    const retry = plan({ threads: [thread(threadB, owned, [2])], covered: answered.delivered })
    expect(retry.trigger).toBe('immediate')
  })

  it('carries a reminder as delivered even when the Thread holds no ordinary unread', () => {
    const withReminder = thread(threadA, owned, [1], { reminders: [{ kind: 'review-backlog', baselineSequence: 1 }] })
    const first = plan({ threads: [withReminder] })
    expect(first.delivered).toContain('reminder')
    expect(plan({ threads: [withReminder], covered: first.delivered }).trigger).toBeUndefined()
  })
})

describe('the scope role names why the Thread is in scope, not how fast the notice travels', () => {
  it('a reader holding Attention is a follower', () => {
    expect(plan({ threads: [thread(threadA, owned, [1])] }).threads[0]!.role).toBe('follower')
  })

  it('a reader addressed only by a marker is a Project member named here', () => {
    expect(plan({ threads: [thread(threadA, owned, [1], { following: false })] }).threads[0]!.role).toBe('member')
  })

  it('Main stream unread is immediate, and an unchanged set is not delivered twice', () => {
    const main = [{ projectRef: owned, entries: [{ kind: 'message', sequence: 7 } as AgentTeamMainTimelineEntry] }]
    const first = plan({ main })
    expect(first.trigger).toBe('immediate')
    expect(plan({ main, covered: first.signature }).trigger).toBeUndefined()
  })
})
