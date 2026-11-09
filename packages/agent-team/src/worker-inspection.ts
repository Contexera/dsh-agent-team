/**
 * The Team's one seam for reading an engine's own record of one Worker run after
 * the process that wrote it exited. Callers never touch a path, a format
 * generation, or an engine's error text: they hand over the anchors the
 * settlement recorded and get a bounded set of fragments, or a reason there are
 * none.
 *
 * Three rules hold the whole design. The reader opens only the location the
 * engine itself reported, resolves it through every symlink, and requires the
 * record's own first line to name the session the settlement recorded — never a
 * scan for the newest file, never a path a caller supplied, never a file whose
 * identity the content does not confirm. Its byte bound applies to the read
 * itself, so an oversized line is never buffered or parsed. And a fragment whose
 * text looks like a credential is withheld instead of masked, because a masked
 * secret is still a secret the reader read.
 * @module @contexera/dsh-agent-team/worker-inspection
 */

import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type {
  AgentTeamWorkerInspectionFragment,
  AgentTeamWorkerInspectionHistory,
} from './types/requests-results.ts'
import { truncateToCharacters } from './text.ts'

/** How much of one native record the reader will take before it stops and says so. */
export const WORKER_HISTORY_MAX_BYTES = 8 * 1024 * 1024

/** How many fragments one read returns; the report is a diagnostic, not a transcript. */
export const WORKER_HISTORY_MAX_FRAGMENTS = 4

/** How long one fragment may be, in code points. */
export const WORKER_FRAGMENT_MAX_CHARACTERS = 600

/** The read size, small enough that the byte bound is never overshot by much. */
const READ_CHUNK_BYTES = 64 * 1024

/** How long a recorded location may be before this reader refuses it instead of carrying it. */
export const WORKER_LOCATION_MAX_CHARACTERS = 4096

/** How long one reason may be: the report carries bounded sentences, never a native value. */
const WORKER_REASON_MAX_CHARACTERS = 300

/** One reason the report can carry without echoing a native value whole. */
function boundedReason(text: string): string {
  return truncateToCharacters(text, WORKER_REASON_MAX_CHARACTERS)
}

/** The anchors a settlement recorded, as a look-up takes them. */
export interface WorkerHistoryAnchors {
  readonly nativeSessionId?: string | undefined
  readonly nativeTurnId?: string | undefined
  readonly nativeStorage?: string | undefined
}

/**
 * Text shaped like a credential is withheld rather than rewritten. Two families:
 * the shapes real keys take, and a sensitive key followed by a value. Both are
 * narrow on purpose — an ordinary failure sentence has to survive, and a masked
 * secret would still be a secret this reader touched.
 */
const CREDENTIAL_SHAPES = [
  /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abpr]-[A-Za-z0-9-]{10,})/u,
  /(?:^|[^A-Za-z0-9])bearer\s+[A-Za-z0-9._~+/-]{16,}/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  // A sensitive key with a value after it, in any case, whatever the separator, and
  // whether the key and value are bare, quoted as JSON, or quoted as a sentence.
  /(?:password|passwd|passphrase|secret|token|api[-_]?key|authorization|credential|cookie|private[-_]?key|client[-_]?secret|session[-_]?key)["']?\s*[:=]\s*["']?\S+/iu,
]

function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_SHAPES.some(shape => shape.test(text))
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** One labelled fact, or nothing when the engine did not report that field. */
function labelled(label: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `${label} ${value}`
}

function joined(parts: readonly (string | undefined)[]): string[] {
  return parts.filter((part): part is string => part !== undefined)
}

/**
 * Whether a resolved location is one this reader may open: absolute, a JSONL
 * record, and inside a `sessions` directory. The record's own first line then has
 * to name the recorded session, so a wrong or hostile path cannot become a read
 * of an unrelated file.
 */
function isInspectableLocation(path: string): boolean {
  return isAbsolute(path) && path.endsWith('.jsonl') && path.split(sep).includes('sessions')
}

/** The system error code a failed filesystem call carried, if any. */
function codeOf(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One parsed line: the record's own `type` and payload, without the rest of the file's shape. */
interface RawRecord {
  readonly type: string
  readonly payload: Record<string, unknown>
}

function parseRecord(line: string): RawRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  const record = recordOf(parsed)
  const type = textOf(record?.type)
  const payload = recordOf(record?.payload)
  return type === undefined || payload === undefined ? undefined : { type, payload }
}

/** What one record contributes: whether it belongs to the recorded turn, and its fragments. */
interface Contribution {
  readonly matched: boolean
  readonly fragments: readonly AgentTeamWorkerInspectionFragment[]
}

const NOTHING: Contribution = Object.freeze({ matched: false, fragments: Object.freeze([]) })

/** The fragments one record contributes, if it is one of the few this reader understands. */
function fragmentsOf(record: RawRecord, turnId: string | undefined): Contribution {
  if (record.type === 'session_meta') {
    const parts = joined([
      labelled('engine', textOf(record.payload.cli_version)),
      labelled('originator', textOf(record.payload.originator)),
      labelled('cwd', textOf(record.payload.cwd)),
      labelled('written', textOf(record.payload.timestamp)),
    ])
    return { matched: false, fragments: parts.length === 0 ? [] : [{ kind: 'session', text: `Native session record: ${parts.join(' · ')}` }] }
  }
  if (turnId === undefined || record.payload.turn_id !== turnId) return NOTHING
  if (record.type === 'turn_context') {
    const sandbox = recordOf(record.payload.sandbox_policy)
    const parts = joined([
      labelled('model', textOf(record.payload.model)),
      labelled('approval', textOf(record.payload.approval_policy)),
      labelled('sandbox', textOf(sandbox?.type)),
    ])
    return { matched: true, fragments: parts.length === 0 ? [] : [{ kind: 'turn', text: `Native turn ${turnId}: ${parts.join(' · ')}` }] }
  }
  if (record.type !== 'event_msg') return NOTHING
  if (record.payload.type === 'turn_aborted') {
    return { matched: true, fragments: [{ kind: 'failure', text: `Native turn interrupted: ${textOf(record.payload.reason) ?? 'no reason reported'}` }] }
  }
  if (record.payload.type !== 'task_complete') return NOTHING
  // The turn's own failure sentence, and nothing else: the model's last answer
  // already reaches the initiator through the run's normal result, so reading it
  // here would only duplicate text this reader cannot vouch for.
  const message = textOf(recordOf(record.payload.error)?.message)
  if (message === undefined) return { matched: true, fragments: [] }
  const duration = typeof record.payload.duration_ms === 'number' ? ` after ${record.payload.duration_ms} ms` : ''
  return { matched: true, fragments: [{ kind: 'failure', text: `Native turn failed${duration}: ${message}` }] }
}

/** What one bounded pass over the record found. */
interface Pass {
  /** The first line named the recorded session. */
  readonly identified: boolean
  /** A record for the recorded turn was seen, whatever it said. */
  readonly matched: boolean
  readonly fragments: readonly AgentTeamWorkerInspectionFragment[]
  readonly withheld: number
  readonly truncated: boolean
}

/**
 * Read the record in bounded chunks. The budget is spent on the read itself, so a
 * single oversized line is never buffered, never parsed, and never counted as
 * read: the loop stops at the bound whatever the file's shape.
 */
/** One pass over the record: what it held, why it refused, or why it could not be read. */
type ReadOutcome =
  | { readonly kind: 'pass'; readonly pass: Pass }
  /** A shape or content refusal: this Team does not read that. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** The file that opened is not the file that was checked: an integrity refusal. */
  | { readonly kind: 'unstable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }

async function readRecord(location: string, expected: { readonly dev: number; readonly ino: number },
  size: number, nativeSessionId: string, turnId: string | undefined): Promise<ReadOutcome> {
  const handle = await open(location, 'r')
  try {
    const opened = await handle.stat()
    // The handle, not the path, is what this read consumes: a path that was
    // swapped between the check and the open would otherwise hand this reader a
    // different file under a name it already trusted.
    if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
      return { kind: 'unstable', reason: 'The file that opened is not the file the recorded location names, so this Team will not read it.' }
    }
    if (!opened.isFile()) return { kind: 'refused', reason: 'The recorded location is not a file.' }
    const fragments: AgentTeamWorkerInspectionFragment[] = []
    const decoder = new StringDecoder('utf8')
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES)
    let remaining = WORKER_HISTORY_MAX_BYTES
    let position = 0
    let carry = ''
    let identified = false
    let matched = false
    let withheld = 0
    let first = true
    const take = (line: string): string | undefined => {
      if (line.trim() === '') return undefined
      const record = parseRecord(line)
      if (first) {
        first = false
        // The record has to name the session the settlement recorded. Anything
        // else — another thread's file, a hand-written path, a newer layout whose
        // first line is not a session header — is refused here, before a single
        // fragment is taken from it.
        if (record?.type !== 'session_meta' || record.payload.session_id !== nativeSessionId) {
          return `The file is not the record of native session ${nativeSessionId}, so this Team will not read it.`
        }
        identified = true
      }
      if (record === undefined) return undefined
      const contribution = fragmentsOf(record, turnId)
      if (contribution.matched) matched = true
      for (const fragment of contribution.fragments) {
        if (fragments.length >= WORKER_HISTORY_MAX_FRAGMENTS) break
        if (looksLikeCredential(fragment.text)) {
          withheld += 1
          continue
        }
        fragments.push(Object.freeze({ kind: fragment.kind, text: truncateToCharacters(fragment.text, WORKER_FRAGMENT_MAX_CHARACTERS) }))
      }
      return undefined
    }
    while (remaining > 0) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, remaining), position)
      if (bytesRead === 0) break
      position += bytesRead
      remaining -= bytesRead
      carry += decoder.write(chunk.subarray(0, bytesRead))
      let end: number
      while ((end = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, end)
        carry = carry.slice(end + 1)
        const refusal = take(line)
        if (refusal !== undefined) return { kind: 'refused', reason: refusal }
      }
    }
    // A record longer than the bound is not finished, so its trailing bytes are
    // not a line: parsing them would spend the whole budget on a fragment the
    // reader never claimed to read.
    const truncated = remaining === 0 && position < size
    carry += decoder.end()
    if (!truncated && carry.trim() !== '') {
      const refusal = take(carry)
      if (refusal !== undefined) return { kind: 'refused', reason: refusal }
    }
    return { kind: 'pass', pass: { identified, matched, fragments: Object.freeze(fragments), withheld, truncated } }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Read one run's native record, bounded and fail-closed. The handle is closed on
 * every path, and every way the record cannot answer becomes its own reason —
 * a missing file, an unreadable one, a shape this Team does not read, or a record
 * that holds no turn with the recorded id.
 */
export async function readWorkerHistory(anchors: WorkerHistoryAnchors): Promise<AgentTeamWorkerInspectionHistory> {
  if (anchors.nativeSessionId === undefined) {
    return { kind: 'unpersisted', reason: 'The ending recorded no native session, so there is no native record to look up.' }
  }
  const recorded = anchors.nativeStorage
  if (recorded === undefined) {
    return { kind: 'unpersisted', reason: 'The ending recorded no location for its native record, so there is nothing to look up.' }
  }
  // The recorded shape is judged before any filesystem call, so a location this
  // Team never reads is a deterministic refusal rather than a missing file. An
  // oversized value is refused whole: cutting it into a shorter path would only
  // invent a location nobody recorded.
  if (recorded.length > WORKER_LOCATION_MAX_CHARACTERS) {
    return { kind: 'unsupported', reason: 'The recorded location is longer than any native record this Team reads.' }
  }
  if (!isInspectableLocation(recorded)) {
    return { kind: 'unsupported', reason: 'The recorded location is not a native record this Team reads.' }
  }
  // Every symlink resolved next: the location this reader opens is the file the
  // engine actually wrote, not a link that pointed somewhere at capture time.
  const location = await realpath(recorded).catch((error: unknown): Error => error instanceof Error ? error : new Error(String(error)))
  if (location instanceof Error) {
    const code = codeOf(location)
    if (code === 'ENOENT') return { kind: 'missing', reason: 'The engine\'s record is no longer at the recorded location.' }
    return { kind: 'unreadable', reason: boundedReason(`The recorded location could not be resolved: ${messageOf(location)}`) }
  }
  if (!isInspectableLocation(location)) {
    return { kind: 'unsupported', reason: 'The resolved location is not a native record this Team reads.' }
  }
  const before = await stat(location).catch((error: unknown): Error => error instanceof Error ? error : new Error(String(error)))
  if (before instanceof Error) {
    return { kind: 'unreadable', reason: boundedReason(`The engine's record could not be read: ${messageOf(before)}`) }
  }
  const outcome = await readRecord(location, before, before.size, anchors.nativeSessionId, anchors.nativeTurnId)
    .catch((error: unknown): ReadOutcome => ({ kind: 'failed', reason: messageOf(error) }))
  if (outcome.kind === 'refused') return { kind: 'unsupported', reason: boundedReason(outcome.reason) }
  if (outcome.kind === 'unstable') return { kind: 'unreadable', reason: boundedReason(outcome.reason) }
  if (outcome.kind === 'failed') {
    return /ENOENT/u.test(outcome.reason)
      ? { kind: 'missing', reason: 'The engine\'s record is no longer at the recorded location.' }
      : { kind: 'unreadable', reason: boundedReason(`The engine's record could not be read: ${outcome.reason}`) }
  }
  const pass = outcome.pass
  if (!pass.identified) {
    return { kind: 'unsupported', reason: 'The record holds no session header this Team reads.' }
  }
  const after = await stat(location).catch(() => undefined)
  if (after === undefined || after.dev !== before.dev || after.ino !== before.ino) {
    return { kind: 'unreadable', reason: 'The record changed while it was being opened, so this Team will not read it.' }
  }
  if (anchors.nativeTurnId === undefined) {
    return { kind: 'unmatched', reason: 'The ending recorded no native turn id for this run, so there is no turn to look up in its record.' }
  }
  if (!pass.matched) {
    return { kind: 'unmatched', reason: boundedReason(`The engine's record holds no turn ${anchors.nativeTurnId}.`
      + (pass.truncated ? ' The record is longer than this reader takes, so the turn may be past the part that was read.' : '')) }
  }
  return { kind: 'read', fragments: pass.fragments, withheld: pass.withheld, truncated: pass.truncated }
}
