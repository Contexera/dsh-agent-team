/**
 * The Team's single seam for reading stored Sessions.
 *
 * Every per-Session read the Host performs goes through here: one
 * `open → read → close` cycle whose handle lifecycle is guaranteed closed,
 * and whose failures are normalized into the five categories consumers choose
 * policy by. Callers never touch a `SessionHandle`, an artifact path, a
 * format generation, or Harness error message text.
 *
 * The reader owns reading and classification only — not Member lifecycle,
 * Agent create/resume, UI, or ledger.
 *
 * Classification notes: the shipped JSONL backend throws its
 * `corrupt session log` family as plain `Error`s, so corruption is detected by
 * that stable message prefix (an upstream gap; if the text ever changes the
 * failure degrades to `unknown`, which consumers treat conservatively —
 * blocking rather than silently skipping). Typed refusals are also matched
 * through `error.cause` chains because the Harness agent layer wraps
 * persistence failures during resume.
 * @module @contexera/dsh-agent-team/stored-session-reader
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  type SessionLocation,
} from '@deepseek-ai/dsh-session-persistence'

/** Why one stored Session could not be read; the policy axis for consumers. */
export type StoredSessionFailureKind =
  | 'missing' // no durable log exists for the id
  | 'refused' // deterministic format/migration refusal; retrying can never succeed
  | 'corrupt' // stored contents failed validation after a successful backend read
  | 'io' // transient storage/system failure; retry may succeed
  | 'unknown' // unclassified; consumers fail closed on it

/** One normalized stored-Session read failure. */
export interface StoredSessionFailure {
  readonly kind: StoredSessionFailureKind
  readonly sessionId: SessionId
  /** The underlying reason, from the matched error's own message. */
  readonly detail: string
  /** The refused artifact's location, when the backend reported one. */
  readonly location?: SessionLocation
}

/** A complete, validated stored-Session read: storage metadata plus the whole event log. */
export interface StoredSessionInspection {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly events: readonly SessionEvent[]
}

/** The result of one read: the inspection, or its normalized failure. */
export type StoredSessionReadResult =
  | { readonly ok: true; readonly inspection: StoredSessionInspection }
  | { readonly ok: false; readonly failure: StoredSessionFailure }

/**
 * A call site's session-read failure, carrying the typed classification so
 * activation can route the diagnostic without re-matching error text.
 */
export class StoredSessionReadError extends Error {
  constructor(message: string, readonly failure: StoredSessionFailure) {
    super(message)
    this.name = 'StoredSessionReadError'
  }
}

/** How deep to follow `error.cause` chains looking for a typed session failure. */
const MAX_CAUSE_DEPTH = 4

/** The JSONL backend's stable corruption-message prefix (plain `Error`s, not typed). */
const CORRUPT_SESSION_LOG_TEXT = /corrupt session log/

interface Classified {
  readonly kind: StoredSessionFailureKind
  readonly location?: SessionLocation
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The deterministic session-shaped classification of one error value:
 * typed Harness failures plus the corruption message family. A system error
 * code is deliberately NOT matched here — outside the reader an fs error may
 * come from unrelated work (private memory, attachment cache), so only the
 * reader itself, where the failed operation is known to be a session read,
 * may classify an fs error as `io`.
 */
function sessionClassOf(error: unknown): Classified | undefined {
  if (error instanceof SessionPersistenceNotFoundError) return { kind: 'missing' }
  if (error instanceof SessionFormatUnsupportedError) {
    return { kind: 'refused', ...(error.location === undefined ? {} : { location: error.location }) }
  }
  if (error instanceof SessionPersistenceCorruptionError) return { kind: 'corrupt' }
  if (error instanceof Error && CORRUPT_SESSION_LOG_TEXT.test(error.message)) return { kind: 'corrupt' }
  return undefined
}

/** The first session-shaped classification in an error's cause chain, with the matched error for its message. */
function sessionClassInChain(error: unknown): { readonly classified: Classified; readonly matched: unknown } | undefined {
  let current: unknown = error
  for (let depth = 0; current !== undefined && current !== null && depth <= MAX_CAUSE_DEPTH; depth += 1) {
    const classified = sessionClassOf(current)
    if (classified !== undefined) return { classified, matched: current }
    current = current instanceof Error ? current.cause : undefined
  }
  return undefined
}

/**
 * Classify any failure as a stored-Session read failure. Total: unmatched
 * errors become `unknown`, and a direct system error code becomes `io` —
 * call this only where the failed operation is known to be a session read.
 */
export function classifyStoredSessionFailure(error: unknown, sessionId: SessionId): StoredSessionFailure {
  const inChain = sessionClassInChain(error)
  if (inChain !== undefined) {
    return { kind: inChain.classified.kind, sessionId, detail: messageOf(inChain.matched), ...('location' in inChain.classified ? { location: inChain.classified.location } : {}) }
  }
  if (error !== null && typeof error === 'object' && typeof (error as { readonly code?: unknown }).code === 'string') {
    return { kind: 'io', sessionId, detail: messageOf(error) }
  }
  return { kind: 'unknown', sessionId, detail: messageOf(error) }
}

/**
 * The session-shaped failure carried by an arbitrary error, when it carries
 * one at all: deterministic markers (typed classes, the corruption message
 * family) are matched through the cause chain; transient fs errors are not —
 * outside the reader they are not provably session-related. Activation uses
 * this to route diagnostics; `undefined` means the failure is not
 * session-shaped.
 */
export function sessionFailureOf(error: unknown, sessionId: SessionId): StoredSessionFailure | undefined {
  const inChain = sessionClassInChain(error)
  if (inChain === undefined) return undefined
  return { kind: inChain.classified.kind, sessionId, detail: messageOf(inChain.matched), ...('location' in inChain.classified ? { location: inChain.classified.location } : {}) }
}

/** Read stored Sessions through one seam: full validated reads with normalized failures. */
export class StoredSessionReader {
  constructor(private readonly ctx: Context) {}

  /**
   * Read one stored Session completely. The handle is closed on every path;
   * any failure of open, read, or close is returned as its normalized
   * category, never thrown.
   */
  async read(sessionId: SessionId): Promise<StoredSessionReadResult> {
    try {
      const handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
      try {
        const { events } = await handle.read()
        return { ok: true, inspection: { header: handle.header, inheritedEventCount: handle.inheritedEventCount, events } }
      } finally {
        await handle.close()
      }
    } catch (error) {
      return { ok: false, failure: classifyStoredSessionFailure(error, sessionId) }
    }
  }

  /**
   * Whether one stored Session has durable persisted content, decided through
   * `stat`: the backend reports a still-draining session through its pending
   * header, so this is the existence probe activation relies on. Only the
   * missing case returns `false`; unexpected errors propagate as before.
   */
  async exists(sessionId: SessionId): Promise<boolean> {
    return (await this.ctx.sessionPersistence.stat(sessionId)) !== undefined
  }
}
