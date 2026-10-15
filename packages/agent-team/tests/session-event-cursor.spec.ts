import { describe, expect, it } from 'vitest'
import { advanceOwnedSessionEventCursor, advanceSessionEventCursor, initSessionEventCursor, type SessionCursorEvent, type SessionEventCursor, type SessionEventFold } from '../src/session-event-cursor.ts'

function event(seq: number, type: string, payload = ''): SessionCursorEvent & { readonly payload: string } {
  return { seq, type, payload }
}

/** A log of `count` events at their true positions: the event at index `i` carries `seq === from + i`. */
function logOf(count: number, options: { readonly type?: string; readonly from?: number } = {}): Array<SessionCursorEvent & { readonly payload: string }> {
  const type = options.type ?? 'user/message'
  const from = options.from ?? 0
  return Array.from({ length: count }, (_unused, offset) => event(from + offset, type, `p${from + offset}`))
}

/** A fold over event seqs, which is what makes a per-pass measurement possible. */
const seqFold: SessionEventFold<readonly number[], SessionCursorEvent & { readonly payload: string }> = {
  start: [],
  step: (state, cursorEvent) => [...state, cursorEvent.seq],
}

/** Cold-fold a whole log: the reference result every incremental advance must match. */
function coldFold(events: readonly (SessionCursorEvent & { readonly payload: string })[], logFrom = 0): readonly number[] {
  return advanceSessionEventCursor(initSessionEventCursor(seqFold, logFrom), events, logFrom, logFrom + events.length, seqFold).value
}

/**
 * A fold whose value records the types it consumed. Unlike {@link seqFold},
 * whose value is just the positions, this one can tell a resumed advance from a
 * cold fold over the same slice.
 */
const typeFold: SessionEventFold<readonly string[], SessionCursorEvent & { readonly payload: string }> = {
  start: [],
  step: (state, cursorEvent) => [...state, cursorEvent.type],
}

/**
 * The seqs this advance folded, for passes known to have resumed: the cursor's
 * value is followed by exactly the new events, so the tail starts at the old
 * length. Passes that restarted are judged by equality against a cold fold
 * instead, because a restart produces a value that can be longer or shorter
 * than the one the cursor held and this helper cannot tell the two apart.
 */
function injected(before: SessionEventCursor<readonly number[]>, advanced: SessionEventCursor<readonly number[]>): readonly number[] {
  return advanced.value.slice(before.value.length)
}

describe('session event cursor', () => {
  it('folds the whole slice on the first advance and only the tail after that', () => {
    const events = logOf(5)
    const first = advanceSessionEventCursor(initSessionEventCursor(seqFold), events, 0, events.length, seqFold)
    expect(first.value).toEqual([0, 1, 2, 3, 4])
    expect(first.foldedThrough).toBe(5)

    // Two more events arrive: exactly those two are folded, and the value
    // equals what a cold fold of the same log produces.
    const grown = logOf(7)
    const second = advanceSessionEventCursor(first, grown, 0, grown.length, seqFold)
    // Resumed: the value is what the cursor held plus exactly the two new
    // events, and the position moved by exactly that much.
    expect(second.value).toEqual([...first.value, 5, 6])
    expect(injected(first, second)).toEqual([5, 6])
    expect(second.foldedThrough - first.foldedThrough).toBe(2)
  })

  it('returns the same cursor when no event arrived', () => {
    const events = logOf(3)
    const cursor = advanceSessionEventCursor(initSessionEventCursor(seqFold), events, 0, events.length, seqFold)
    expect(advanceSessionEventCursor(cursor, events, 0, events.length, seqFold)).toBe(cursor)
    // A log that grew while the caller's slice did not is also a no-op.
    expect(advanceSessionEventCursor(cursor, events, 0, 3, seqFold)).toBe(cursor)
  })

  it('folds from a non-zero logFrom, as an inherited Session requires', () => {
    // A fork: the first 10 events belong to the parent and are never folded.
    const own = logOf(4, { from: 10 })
    const cursor = advanceSessionEventCursor(initSessionEventCursor(seqFold, 10), own, 10, 14, seqFold)
    expect(cursor.value).toEqual([10, 11, 12, 13])
    expect(cursor.foldedThrough).toBe(14)
  })

  it('does not mutate the cursor it advances', () => {
    const events = logOf(3)
    const cursor = advanceSessionEventCursor(initSessionEventCursor(seqFold), events, 0, events.length, seqFold)
    const snapshot = JSON.stringify(cursor)
    advanceSessionEventCursor(cursor, logOf(5), 0, 5, seqFold)
    expect(JSON.stringify(cursor)).toBe(snapshot)
  })

  it('refuses a slice that does not span the log it claims', () => {
    expect(() => advanceSessionEventCursor(initSessionEventCursor(seqFold), logOf(3), 0, 5, seqFold)).toThrow(RangeError)
    expect(() => advanceSessionEventCursor(initSessionEventCursor(seqFold, 10), logOf(4, { from: 10 }), 10, 20, seqFold)).toThrow(RangeError)
  })
})

describe('session event cursor identity guard', () => {
  it('refolds from scratch when the anchor event type changed at the same position', () => {
    // The adversarial shape: an event at the anchor position is replaced by
    // another of a different type at the same seq, then one event is appended.
    const before = logOf(4)
    const cursor = advanceSessionEventCursor(initSessionEventCursor(seqFold), before, 0, before.length, seqFold)

    const rebuilt = [...before.slice(0, 3), event(3, 'assistant/message', 'p3'), event(4, 'user/message', 'p4')]
    const advanced = advanceSessionEventCursor(cursor, rebuilt, 0, rebuilt.length, seqFold)
    // Everything was consumed again, not just the appended event: the value is
    // longer than the cursor's, which a resume could never produce.
    expect(advanced.value).toEqual(coldFold(rebuilt))
    expect(advanced.value.length).toBeGreaterThan(cursor.value.length)
  })

  it('refolds from scratch when the log is shorter than the position it consumed', () => {
    const events = logOf(6)
    const cursor = advanceSessionEventCursor(initSessionEventCursor(seqFold), events, 0, events.length, seqFold)
    const shrunk = logOf(3)
    const advanced = advanceSessionEventCursor(cursor, shrunk, 0, shrunk.length, seqFold)
    expect(advanced.foldedThrough - advanced.logFrom).toBe(3)
    expect(advanced.value).toEqual(coldFold(shrunk))
    expect(advanced.foldedThrough).toBe(3)
  })

  it('refolds from scratch when the fork prefix moved under the cursor', () => {
    const events = logOf(6)
    const cursor = advanceSessionEventCursor(initSessionEventCursor(seqFold), events, 0, events.length, seqFold)
    // Same events, different inherited cut: a different Session's own log.
    const own = events.slice(2)
    const advanced = advanceSessionEventCursor(cursor, own, 2, 6, seqFold)
    expect(advanced.value).toEqual([2, 3, 4, 5])
    expect(advanced.foldedThrough).toBe(6)
  })

  it('refolds from scratch when the whole log was replaced', () => {
    const cursor = advanceSessionEventCursor(initSessionEventCursor(seqFold), logOf(4), 0, 4, seqFold)
    const unrelated = logOf(4, { type: 'assistant/message' })
    const advanced = advanceSessionEventCursor(cursor, unrelated, 0, unrelated.length, seqFold)
    expect(advanced.value).toEqual(coldFold(unrelated))
    expect(advanced.value).not.toEqual([...cursor.value, 3])
  })

  it('does not detect a same-type payload swap at the anchor (named residual)', () => {
    // Documents the boundary of the guard rather than asserting it is safe.
    // The anchor is `(seq, type)`, so a same-seq same-type replacement is
    // accepted and the cursor resumes instead of restarting. Reaching this
    // state requires violating the log's append-only contract.
    const before = logOf(4)
    const cursor = advanceSessionEventCursor(initSessionEventCursor(seqFold), before, 0, before.length, seqFold)
    const swapped = [...before.slice(0, 3), event(3, 'user/message', 'different'), event(4, 'user/message', 'p4')]
    const advanced = advanceSessionEventCursor(cursor, swapped, 0, swapped.length, seqFold)
    // Resumed rather than refolded: only the appended event was consumed, and
    // the value carries the stale pre-swap history into the new result.
    expect(advanced.value).toEqual([...cursor.value, 4])
    expect(injected(cursor, advanced)).toEqual([4])
    expect(advanced.foldedThrough - cursor.foldedThrough).toBe(1)
  })
})

describe('advanceOwnedSessionEventCursor', () => {
  it('resumes the entry that still belongs to the same Session', () => {
    const first = advanceOwnedSessionEventCursor(undefined, 'session-a', seqFold, logOf(5), 0)
    expect(first.sessionId).toBe('session-a')
    expect(first.cursor.value).toEqual([0, 1, 2, 3, 4])

    const grown = logOf(7)
    const second = advanceOwnedSessionEventCursor(first, 'session-a', seqFold, grown, 0)
    // Resumed: exactly the two new events were folded, and the value still
    // equals the cold fold of the same log.
    expect(injected(first.cursor, second.cursor)).toEqual([5, 6])
    expect(second.cursor.value).toEqual(coldFold(grown))
  })

  it('starts cold at the new log when the owner moved to another Session', () => {
    // An adversarial pair: the new Session's log is long enough and its anchor
    // position carries the same sequence and type, so the cursor's own guard
    // would resume the predecessor happily. Only ownership refuses it, and the
    // type-recording fold is what makes a resumed value differ from the cold
    // one — a seq-recording fold would produce the same value either way.
    const before = advanceOwnedSessionEventCursor(undefined, 'session-a', typeFold, logOf(5), 0)
    expect(before.cursor.value).toEqual(Array.from({ length: 5 }, () => 'user/message'))

    const mixed = [
      event(0, 'assistant/message'), event(1, 'assistant/message'), event(2, 'assistant/message'),
      event(3, 'assistant/message'), event(4, 'user/message'),
      event(5, 'tool/result'), event(6, 'tool/result'),
    ]
    const cold = advanceSessionEventCursor(initSessionEventCursor(typeFold), mixed, 0, mixed.length, typeFold).value
    const after = advanceOwnedSessionEventCursor(before, 'session-b', typeFold, mixed, 0)
    expect(after.sessionId).toBe('session-b')
    expect(after.cursor.value).toEqual(cold)
    expect(after.cursor.foldedThrough).toBe(7)
    // One entry per owner: the predecessor was replaced, not carried along.
    expect(after.cursor.value).not.toEqual([...before.cursor.value, 'tool/result', 'tool/result'])
  })

  it('keeps the replacement from resuming when the Session id is unchanged but its cut moved', () => {
    // A resumed Session can rebuild the same id over a log with a different
    // inherited cut; ownership resumes it, and the cursor's own guard is what
    // refuses the position.
    const before = advanceOwnedSessionEventCursor(undefined, 'session-a', seqFold, logOf(6), 0)
    const own = logOf(4, { from: 2 })
    const after = advanceOwnedSessionEventCursor(before, 'session-a', seqFold, own, 2)
    expect(after.cursor.value).toEqual(coldFold(own, 2))
    expect(after.cursor.foldedThrough).toBe(6)
  })
})
