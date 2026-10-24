import { describe, expect, it } from 'vitest'
import type {
  AgentTeamMainStreamReadResult, AgentTeamMainStreamStanding, AgentTeamMainTimelineEntry,
} from '@contexera/dsh-agent-team/types'
import { mergeMainRead } from '../src/client/main-stream.ts'

const standing = (unreadCount: number): AgentTeamMainStreamStanding =>
  ({ owner: true, head: 12, unreadCount, directCount: 0, markers: [] })

function entry(sequence: number, unread: boolean): AgentTeamMainTimelineEntry {
  return { kind: 'activity', sequence, occurredAt: '2026-10-24T00:00:00Z', unread, direct: unread } as AgentTeamMainTimelineEntry
}

function read(entries: readonly AgentTeamMainTimelineEntry[], readThroughSequence: number): AgentTeamMainStreamReadResult {
  return { projectRef: 'project:1' as never, readThroughSequence, entries, consumedMarkers: [], standing: standing(0) }
}

describe('mergeMainRead', () => {
  it('folds a consumed marker entry older than the loaded stream into it, so no marker is cleared unseen', () => {
    const current = { entries: [entry(10, true), entry(11, false)], cursor: 10, hasMore: true, standing: standing(2) }
    const merged = mergeMainRead(current, read([entry(4, true), entry(10, false), entry(11, false)], 11))
    expect(merged.entries.map(entry_ => entry_.sequence)).toEqual([4, 10, 11])
    expect(merged.entries[0]?.unread).toBe(true)
  })

  it('keeps an entry unread for this visit even when the read answers it as read', () => {
    const current = { entries: [entry(10, true), entry(11, true)], cursor: 10, hasMore: false, standing: standing(2) }
    const merged = mergeMainRead(current, read([entry(10, false), entry(11, false)], 11))
    expect(merged.entries.every(entry_ => entry_.unread)).toBe(true)
  })

  it('takes the read picture over the loaded copy and keeps newer loaded entries and the cursor untouched', () => {
    const current = { entries: [entry(9, false), entry(10, false), entry(12, true)], cursor: 9, hasMore: true, standing: standing(1) }
    const merged = mergeMainRead(current, read([entry(10, true)], 10))
    expect(merged.entries.map(entry_ => [entry_.sequence, entry_.unread])).toEqual([[9, false], [10, true], [12, true]])
    expect(merged.cursor).toBe(9)
    expect(merged.hasMore).toBe(true)
    expect(merged.standing).toEqual(standing(0))
  })
})
