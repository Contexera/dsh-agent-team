/**
 * Incremental Session-log fold with an identity guard: keeps the fold value with how far it consumed the log, so each step folds only the new tail instead of O(session length). Session-agnostic: it takes an event array plus the log offset the array starts at.
 *
 * Correctness rests on the append-only log (`seq` is the log index and `seq === log.length`). The guard re-folds from `logFrom` on a changed `logFrom`, a shorter log, or a different event type at the anchor, so a fork, resume, or rollover costs a cold fold, never a wrong picture.
 *
 * Known gap: the guard anchors on `(seq, type)`, so an event replaced in place by another of the same type at the same seq is undetected. That requires violating the append-only contract; closing it would need fingerprinting every folded event, which is the full refold this module avoids.
 * @module @contexera/dsh-agent-team/session-event-cursor
 */

/** The minimum event shape the cursor reads: identity and position, never payload. */
export interface SessionCursorEvent {
  readonly seq: number
  readonly type: string
}

/** One fold as the two pure functions the cursor needs. `start` is the value of an empty log; `step` returns the same reference when the event is not this fold's business. */
export interface SessionEventFold<S, E extends SessionCursorEvent = SessionCursorEvent> {
  readonly start: S
  readonly step: (state: S, event: E) => S
}

/** A fold value plus its position. `foldedThrough` is a log offset (events consumed, so the next event sits at that index); `anchor` identifies the last consumed event by position and type to detect a rebuilt log. */
export interface SessionEventCursor<S> {
  readonly value: S
  readonly foldedThrough: number
  readonly logFrom: number
  readonly anchor: { readonly seq: number; readonly type: string } | null
}

/** Opens a cursor for a log slice starting at `logFrom` (a Session's `inheritedEventCount`, or 0 for a full log); the first advance folds the whole slice. */
export function initSessionEventCursor<S, E extends SessionCursorEvent>(fold: SessionEventFold<S, E>, logFrom = 0): SessionEventCursor<S> {
  return { value: fold.start, foldedThrough: logFrom, logFrom, anchor: null }
}

/**
 * Folds the log tail that arrived since the cursor stopped; returns the same reference when nothing is new.
 *
 * `events` starts at `logFrom`, and `logEnd` is the exclusive end offset in the owning log (same coordinate space as `logFrom`, not `events.length`): with 10 inherited events in a 14-event log, the slice is `events[0..4]` spanning 10 to 14, mirroring `snapshotEvents(fromSeq, toSeqExclusive)`. Both are passed explicitly so the caller states the log it folds.
 */
export function advanceSessionEventCursor<S, E extends SessionCursorEvent>(
  cursor: SessionEventCursor<S>,
  events: readonly E[],
  logFrom: number,
  logEnd: number,
  fold: SessionEventFold<S, E>,
): SessionEventCursor<S> {
  if (logEnd !== logFrom + events.length) {
    // The slice and the log it claims to describe disagree; refuse rather than fold a shape the caller did not state.
    throw new RangeError(`session event cursor: ${events.length} events cannot span [${logFrom}, ${logEnd})`)
  }
  // Resume only from a position the log can still justify; every other case re-folds from `logFrom`, covering truncation, a changed fork prefix, and a rebuilt log alike.
  const resumable = cursor.logFrom === logFrom
    && cursor.foldedThrough >= logFrom
    && cursor.foldedThrough <= logEnd
    && (cursor.foldedThrough === logFrom || anchorMatches(cursor, events))
  const from = resumable ? cursor.foldedThrough : logFrom
  if (from === logEnd) return cursor
  let value = resumable ? cursor.value : fold.start
  for (let index = from; index < logEnd; index += 1) value = fold.step(value, events[index - logFrom] as E)
  return { value, foldedThrough: logEnd, logFrom, anchor: anchorOf(events[logEnd - 1 - logFrom]) }
}

/** Whether the event the cursor stopped on still has its position and type; `seq` is a log index, so a moved event is a different event. */
function anchorMatches<S>(cursor: SessionEventCursor<S>, events: readonly SessionCursorEvent[]): boolean {
  const anchor = cursor.anchor
  if (anchor === null) return false
  const seen = events[anchor.seq - cursor.logFrom]
  return seen !== undefined && seen.seq === anchor.seq && seen.type === anchor.type
}

/** The identity a cursor anchors on when it stops at the last consumed event. */
function anchorOf(event: SessionCursorEvent | undefined): { seq: number; type: string } | null {
  if (event === undefined) return null
  return { seq: event.seq, type: event.type }
}

/** A cursor with the Session it folded from. Keyed by owner (a Member) so entries are bounded by the roster; the Session id stops a replacement from reading as a hit, and lives here because the cursor is Session-agnostic. */
export interface OwnedSessionEventCursor<S> {
  readonly sessionId: string
  readonly cursor: SessionEventCursor<S>
}

/** Advances one owner's fold and returns the entry to store back. `events` is the Session's whole own-events slice from `logFrom`; the cursor resumes only while `owned` belongs to `sessionId`, otherwise it starts cold. */
export function advanceOwnedSessionEventCursor<S, E extends SessionCursorEvent>(
  owned: OwnedSessionEventCursor<S> | undefined,
  sessionId: string,
  fold: SessionEventFold<S, E>,
  events: readonly E[],
  logFrom: number,
): OwnedSessionEventCursor<S> {
  const cursor = owned !== undefined && owned.sessionId === sessionId ? owned.cursor : initSessionEventCursor(fold, logFrom)
  return { sessionId, cursor: advanceSessionEventCursor(cursor, events, logFrom, logFrom + events.length, fold) }
}
