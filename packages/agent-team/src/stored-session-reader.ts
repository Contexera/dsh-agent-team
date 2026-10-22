/**
 * The Team's single seam for reading stored Sessions: one `open → read → close` cycle that always closes the handle and normalizes failures into five categories. Callers never touch a `SessionHandle`, artifact path, format generation, or Harness error text. Reading and classification only; no Member lifecycle, Agent create/resume, UI, or ledger.
 *
 * The JSONL backend throws its `corrupt session log` family as plain `Error`s, so corruption is detected by that message prefix; if the text changes, failures degrade to `unknown`, which consumers treat conservatively. Typed refusals are also matched through `error.cause` chains because the Harness agent layer wraps persistence failures during resume.
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

/** A call site's session-read failure, carrying the typed classification so activation can route the diagnostic without re-matching error text. */
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

/** Session-shaped classification of one error: typed Harness failures plus the corruption message family. System error codes are not matched here, since outside the reader an fs error may come from unrelated work (private memory, attachment cache). */
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

/** Classifies any failure as a stored-Session read failure; total: unmatched errors become `unknown`, a direct system error code becomes `io`. Call only where the failed operation is known to be a session read. */
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

/** The session-shaped failure carried by an error, if any: deterministic markers are matched through the cause chain, transient fs errors are not (unprovable outside the reader). `undefined` means not session-shaped. */
export function sessionFailureOf(error: unknown, sessionId: SessionId): StoredSessionFailure | undefined {
  const inChain = sessionClassInChain(error)
  if (inChain === undefined) return undefined
  return { kind: inChain.classified.kind, sessionId, detail: messageOf(inChain.matched), ...('location' in inChain.classified ? { location: inChain.classified.location } : {}) }
}

/** Read stored Sessions through one seam: full validated reads with normalized failures. */
export class StoredSessionReader {
  constructor(private readonly ctx: Context) {}

  /** Reads one stored Session completely; the handle is closed on every path and failures are returned as a category, never thrown. */
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

  async exists(sessionId: SessionId): Promise<boolean> {
    return (await this.ctx.sessionPersistence.stat(sessionId)) !== undefined
  }
}
