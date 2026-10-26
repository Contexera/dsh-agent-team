import { describe, expect, it } from 'vitest'
import type {
  AgentTeamMainStreamHistory, AgentTeamMainStreamReadResult, AgentTeamMainStreamStanding, AgentTeamMainTimelineEntry,
} from '@contexera/dsh-agent-team/types'
import { ARRIVAL_MARK_MS, liveArrivals, mergeMainRead, mergeMainStream, mainEntryKey } from '../src/client/main-stream.ts'

const standing = (unreadCount: number): AgentTeamMainStreamStanding =>
  ({ owner: true, head: 12, unreadCount, directCount: 0, markers: [] })

function entry(sequence: number, unread: boolean): AgentTeamMainTimelineEntry {
  return { kind: 'activity', sequence, occurredAt: '2026-10-24T00:00:00Z', unread, direct: unread } as AgentTeamMainTimelineEntry
}

function page(entries: readonly AgentTeamMainTimelineEntry[], cursor: number, hasMore = false): AgentTeamMainStreamHistory {
  return { projectRef: 'project:1' as never, entries, cursor, hasMore, standing: standing(entries.filter(item => item.unread).length) }
}

function read(entries: readonly AgentTeamMainTimelineEntry[], readThroughSequence: number): AgentTeamMainStreamReadResult {
  return { projectRef: 'project:1' as never, readThroughSequence, entries, consumedMarkers: [], standing: standing(0) }
}

/** The marked sequences of one instant, read through the same release rule the Client renders. */
const marked = (arrivals: ReadonlyMap<string, number>, now: number): readonly number[] =>
  [...liveArrivals(arrivals, now)].map(key => Number(key.split(':')[1])).sort((left, right) => left - right)

describe('mergeMainStream', () => {
  it('stamps an entry that arrives unread and releases it on the mark\'s own clock', () => {
    const merged = mergeMainStream(undefined, page([entry(10, true), entry(11, false)], 10), 1_000)
    expect(marked(merged.arrivals, 1_000)).toEqual([10])
    expect(marked(merged.arrivals, 1_000 + ARRIVAL_MARK_MS - 1)).toEqual([10])
    // The hold is a fixed window from the arrival, not a state the reader has to leave the page to shed.
    expect(marked(merged.arrivals, 1_000 + ARRIVAL_MARK_MS)).toEqual([])
  })

  it('does not restart the hold when a later page or refresh re-covers the same entry', () => {
    const first = mergeMainStream(undefined, page([entry(10, true)], 10), 1_000)
    const refreshed = mergeMainStream(first, page([entry(10, true)], 10), 2_500)
    expect(refreshed.arrivals.get(mainEntryKey(entry(10, true)))).toBe(1_000)
    expect(marked(refreshed.arrivals, 1_000 + ARRIVAL_MARK_MS)).toEqual([])
  })

  it('keeps the entries an older page does not cover', () => {
    const first = mergeMainStream(undefined, page([entry(10, false), entry(11, false)], 10, true), 1_000)
    const older = mergeMainStream(first, page([entry(8, false), entry(9, false)], 8, false), 1_200)
    expect(older.entries.map(item => item.sequence)).toEqual([8, 9, 10, 11])
    // The backward page said it was the start of the stream, so the affordance goes away with it.
    expect(older.hasMore).toBe(false)
    expect(older.cursor).toBe(8)
  })
})

describe('mergeMainRead', () => {
  it('folds a consumed marker entry older than the loaded stream into it, so no marker is cleared unseen', () => {
    const current = mergeMainStream(undefined, page([entry(10, true), entry(11, false)], 10, true), 1_000)
    const merged = mergeMainRead(current, read([entry(4, true), entry(10, false), entry(11, false)], 11), 1_100)
    expect(merged.entries.map(item => item.sequence)).toEqual([4, 10, 11])
    expect(merged.entries[0]?.unread).toBe(true)
  })

  it('takes the read\'s answer for the flag while the arrival accent keeps its own instant', () => {
    const current = mergeMainStream(undefined, page([entry(10, true), entry(11, true)], 10), 1_000)
    const merged = mergeMainRead(current, read([entry(10, false), entry(11, false)], 11), 1_050)
    // The read is authoritative for the durable flag: the accent is the arrival, not a sticky "unread for this visit".
    expect(merged.entries.every(item => item.unread === false)).toBe(true)
    // The reader saw them arrive, so the accent still holds for its window — a read lands in the same frame as the arrival.
    expect(marked(merged.arrivals, 1_050)).toEqual([10, 11])
    expect(marked(merged.arrivals, 1_000 + ARRIVAL_MARK_MS)).toEqual([])
  })

  it('takes the read picture over the loaded copy and keeps newer loaded entries and the cursor untouched', () => {
    const current = mergeMainStream(undefined, page([entry(9, false), entry(10, false), entry(12, true)], 9, true), 1_000)
    const merged = mergeMainRead(current, read([entry(10, true)], 10), 1_100)
    expect(merged.entries.map(item => [item.sequence, item.unread])).toEqual([[9, false], [10, true], [12, true]])
    expect(merged.cursor).toBe(9)
    expect(merged.hasMore).toBe(true)
    expect(merged.standing).toEqual(standing(0))
    // A read never marks an entry the reader already saw as read.
    expect(marked(merged.arrivals, 1_100)).toEqual([10, 12])
  })
})
