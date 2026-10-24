import { describe, expect, it } from 'vitest'
import { INBOX_THRESHOLD_UPDATES, planInboxDelivery, type InboxDeliveryInput, type InboxThreadUnread } from '../src/inbox-delivery.ts'
import type { AgentTeamProjectRef, AgentTeamThreadRef } from '../src/types/entities.ts'
import type { AgentTeamMainTimelineEntry } from '../src/types/requests-results.ts'

const owned = 'project:00000000-0000-4000-8000-000000000001' as AgentTeamProjectRef
const other = 'project:00000000-0000-4000-8000-000000000002' as AgentTeamProjectRef
const threadA = 'thread:00000000-0000-4000-8000-00000000000a' as AgentTeamThreadRef
const threadB = 'thread:00000000-0000-4000-8000-00000000000b' as AgentTeamThreadRef

function thread(threadRef: AgentTeamThreadRef, projectRef: AgentTeamProjectRef, sequences: readonly number[], options: { direct?: readonly number[]; following?: boolean } = {}): InboxThreadUnread {
  return {
    item: { projectRef, thread: { threadRef }, ...(options.following === false ? {} : { attention: {} }) },
    facts: sequences.map(sequence => ({ fact: { kind: 'message', sequence }, unread: true, direct: options.direct?.includes(sequence) ?? false })),
  } as unknown as InboxThreadUnread
}

function plan(input: Partial<InboxDeliveryInput>) {
  return planInboxDelivery({ threads: [], main: [], owns: projectRef => projectRef === owned, summarizedThrough: new Map(), covered: undefined, ...input })
}

const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index)

describe('an owner is not interrupted by ordinary Thread updates below the threshold', () => {
  it('waits at four ordinary updates and fires on the fifth', () => {
    expect(plan({ threads: [thread(threadA, owned, range(1, INBOX_THRESHOLD_UPDATES - 1))] }).trigger).toBeUndefined()
    expect(plan({ threads: [thread(threadA, owned, range(1, INBOX_THRESHOLD_UPDATES))] }).trigger).toBe('threshold')
  })

  it('counts per Thread, never across Threads', () => {
    expect(plan({ threads: [thread(threadA, owned, range(1, 4)), thread(threadB, owned, range(11, 4))] }).trigger).toBeUndefined()
  })

  it('counts only updates after the last summary, even while the earlier ones stay unread', () => {
    const summarized = plan({ threads: [thread(threadA, owned, range(1, 5))] }).summarizedThrough
    expect(summarized.get(threadA)).toBe(5)
    expect(plan({ threads: [thread(threadA, owned, range(1, 9))], summarizedThrough: summarized }).trigger).toBeUndefined()
    expect(plan({ threads: [thread(threadA, owned, range(1, 10))], summarizedThrough: summarized }).trigger).toBe('threshold')
  })

  it('lets ordinary updates ride along with a mention without re-firing for them later', () => {
    const first = plan({ threads: [thread(threadA, owned, [1, 2, 3], { direct: [3] })] })
    expect(first.trigger).toBe('immediate')
    expect(first.threads[0]).toMatchObject({ role: 'owner', delivery: 'immediate', thresholdCount: 2 })
    expect(plan({ threads: [thread(threadA, owned, [1, 2, 3, 4], { direct: [3] })], covered: first.signature, summarizedThrough: first.summarizedThrough }).trigger).toBeUndefined()
  })
})

describe('everything else interrupts immediately', () => {
  it('a follower who does not own the Project gets each ordinary update', () => {
    const result = plan({ threads: [thread(threadA, other, [1])] })
    expect(result.trigger).toBe('immediate')
    expect(result.threads[0]).toMatchObject({ role: 'follower', delivery: 'immediate', thresholdCount: 0 })
  })

  it('Main stream unread is immediate, and an unchanged set is not delivered twice', () => {
    const main = [{ projectRef: owned, entries: [{ kind: 'message', sequence: 7 } as AgentTeamMainTimelineEntry] }]
    const first = plan({ main })
    expect(first.trigger).toBe('immediate')
    expect(plan({ main, covered: first.signature }).trigger).toBeUndefined()
  })
})
