/**
 * The Team's one seam for reading an engine's own record of one Worker run after
 * the process that wrote it exited. Callers never touch a path, a format
 * generation, or an engine's error text: they hand over the anchors the
 * settlement recorded and get a bounded set of fragments, or a reason there are
 * none.
 *
 * Three rules hold the whole design. The reader opens only the location the
 * settlement recorded, resolves it through every symlink, and requires the
 * record's own first line to name the session the settlement recorded — never a
 * scan for the newest file, never a path a caller supplied, never a file whose
 * identity the content does not confirm. Its byte bound applies to the read
 * itself, so an oversized line is never buffered or parsed. And a fragment whose
 * text looks like a credential is withheld instead of masked, because a masked
 * secret is still a secret the reader read.
 *
 * The two engines name the same facts differently: Codex writes a session header
 * and a turn id, Claude writes a queue header and names the turn by the prompting
 * user message. The reader keeps one bounded pass and one set of rules; the
 * engine only chooses which fields identify the session, the turn, and a failure.
 * @module @contexera/dsh-agent-team/worker-inspection
 */

import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import type {
  AgentTeamWorkerInspectionFragment,
  AgentTeamWorkerInspectionHistory,
} from './types/requests-results.ts'
import type { WorkerEngine } from './worker-settings.ts'
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
  /** The engine the run used: it decides which record shape the reader expects. */
  readonly engine: WorkerEngine
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
 * record, and under the directory the engine writes records in. The record's own
 * first line then has to name the recorded session, so a wrong or hostile path
 * cannot become a read of an unrelated file.
 */
function isInspectableLocation(path: string, engine: WorkerEngine): boolean {
  if (!isAbsolute(path) || !path.endsWith('.jsonl')) return false
  const segments = path.split(sep)
  return segments.includes(engine === 'codex' ? 'sessions' : 'projects')
}

/** The system error code a failed filesystem call carried, if any. */
function codeOf(error: unknown): string | undefined {
  const code = (error as { readonly code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One parsed line: the record's own type, its Codex payload when it has one, and the whole object. */
interface RawRecord {
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly raw: Record<string, unknown>
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
  if (record === undefined || type === undefined) return undefined
  return { type, payload: recordOf(record.payload) ?? {}, raw: record }
}

/** What one record contributes: whether it belongs to the recorded turn, its fragments, and a failure to report once. */
interface Contribution {
  readonly matched: boolean
  readonly fragments: readonly AgentTeamWorkerInspectionFragment[]
  /** A failure sentence for the pass to report after it: the last one wins, so retries do not flood the report. */
  readonly failure?: string | undefined
}

const NOTHING: Contribution = Object.freeze({ matched: false, fragments: Object.freeze([]) })

/** The fragments one record contributes, if it is one of the few this reader understands. */
function fragmentsOf(record: RawRecord, turnId: string | undefined, engine: WorkerEngine): Contribution {
  return engine === 'claude' ? claudeFragmentsOf(record, turnId) : codexFragmentsOf(record, turnId)
}

/** Codex's record: a session header, turn contexts, and event messages keyed by the native turn id. */
function codexFragmentsOf(record: RawRecord, turnId: string | undefined): Contribution {
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
    return { matched: true, fragments: [],
      failure: `Native turn interrupted: ${textOf(record.payload.reason) ?? 'no reason reported'}` }
  }
  if (record.payload.type !== 'task_complete') return NOTHING
  // The turn's own failure sentence, and nothing else: the model's last answer
  // already reaches the initiator through the run's normal result, so reading it
  // here would only duplicate text this reader cannot vouch for.
  const message = textOf(recordOf(record.payload.error)?.message)
  if (message === undefined) return { matched: true, fragments: [] }
  const duration = typeof record.payload.duration_ms === 'number' ? ` after ${record.payload.duration_ms} ms` : ''
  return { matched: true, fragments: [], failure: `Native turn failed${duration}: ${message}` }
}

/**
 * Whether a Claude line opens the next root prompt. A user line that carries a
 * tool result belongs to the turn already running, a sidechain line belongs to a
 * subagent, and a meta line is a synthetic record rather than something the user
 * asked: none of them ends this turn. Any other user line is the next prompt.
 */
function isClaudeRootPrompt(record: RawRecord): boolean {
  if (record.type !== 'user' || record.raw.isSidechain === true || record.raw.isMeta === true) return false
  const content = recordOf(record.raw.message)?.content
  if (typeof content === 'string') return true
  if (!Array.isArray(content)) return false
  return !content.some(part => recordOf(part)?.type === 'tool_result')
}

/**
 * Claude's record: a queue header, then the prompting user message OAR wrote with
 * this run's input id, then the turn's own assistant and system lines. The prompt
 * line is the turn anchor, and the session facts ride it: Claude keeps no separate
 * session header. A sidechain line belongs to a subagent, not to this run.
 */
function claudeFragmentsOf(record: RawRecord, turnId: string | undefined): Contribution {
  if (turnId === undefined || record.raw.isSidechain === true) return NOTHING
  if (record.type === 'user' && record.raw.uuid === turnId) {
    const parts = joined([
      labelled('engine', textOf(record.raw.version)),
      labelled('cwd', textOf(record.raw.cwd)),
      labelled('permission', textOf(record.raw.permissionMode)),
    ])
    return { matched: true, fragments: parts.length === 0 ? [] : [{ kind: 'session', text: `Native session record: ${parts.join(' · ')}` }] }
  }
  const failure = claudeFailureOf(record)
  if (failure !== undefined) return { matched: false, fragments: [], failure }
  if (record.type !== 'assistant') return NOTHING
  const message = recordOf(record.raw.message)
  const parts = joined([
    labelled('model', textOf(record.raw.requestedModel) ?? textOf(message?.model)),
    labelled('effort', textOf(record.raw.effort)),
  ])
  return { matched: false, fragments: parts.length === 0 ? [] : [{ kind: 'turn', text: `Native turn ${turnId}: ${parts.join(' · ')}` }] }
}

/** The one failure sentence a Claude record carries: an API error line, or the synthetic assistant line of a refused turn. */
function claudeFailureOf(record: RawRecord): string | undefined {
  if (record.type === 'system' && (record.raw.subtype === 'api_error' || record.raw.level === 'error')) {
    const error = recordOf(record.raw.error)
    return `Native turn failed: ${textOf(error?.formatted) ?? textOf(error?.message) ?? 'the engine reported an error'}`
  }
  if (record.type !== 'assistant' || record.raw.isApiErrorMessage !== true) return undefined
  const code = textOf(record.raw.error)
  const message = recordOf(record.raw.message)
  const content = Array.isArray(message?.content) ? message.content : []
  const text = content.map(part => recordOf(part)).map(part => textOf(part?.text)).find(value => value !== undefined)
  const detail = joined([code, text]).join(' — ')
  return `Native turn failed: ${detail === '' ? 'the engine reported an error' : detail}`
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
  size: number, engine: WorkerEngine, nativeSessionId: string, turnId: string | undefined): Promise<ReadOutcome> {
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
    let seenTurn = false
    let stopped = false
    let pendingFailure: string | undefined
    let withheld = 0
    let first = true
    const take = (line: string): string | undefined => {
      if (line.trim() === '') return undefined
      const record = parseRecord(line)
      if (first) {
        first = false
        // The record has to name the session the settlement recorded. Anything
        // else — another session's file, a hand-written path, a newer layout whose
        // first line is not a header this Team reads — is refused here, before a
        // single fragment is taken from it.
        const names = record !== undefined && (engine === 'codex'
          ? record.type === 'session_meta' && record.payload.session_id === nativeSessionId
          : record.raw.sessionId === nativeSessionId)
        if (!names) {
          return `The file is not the record of native session ${nativeSessionId}, so this Team will not read it.`
        }
        identified = true
      }
      if (record === undefined) return undefined
      // A native session that is continued later appends the next root prompt
      // after this turn's records. The pass ends there: the later turn's model
      // and failure are not this run's, and reading on would attribute them to it.
      if (engine === 'claude' && seenTurn && isClaudeRootPrompt(record)) {
        stopped = true
        return undefined
      }
      // Claude names its turn by the prompting user message: records before that
      // line belong to an earlier turn (the Team never resumes, but the reader
      // does not rely on that) and are not this run's.
      if (engine === 'claude' && !seenTurn && !(record.type === 'user' && record.raw.uuid === turnId)) return undefined
      const contribution = fragmentsOf(record, turnId, engine)
      if (contribution.matched) {
        matched = true
        if (engine === 'claude') seenTurn = true
      }
      if (contribution.failure !== undefined) pendingFailure = contribution.failure
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
        if (stopped) break
      }
      if (stopped) break
    }
    // A record longer than the bound is not finished, so its trailing bytes are
    // not a line: parsing them would spend the whole budget on a fragment the
    // reader never claimed to read.
    const truncated = remaining === 0 && position < size
    carry += decoder.end()
    if (!stopped && !truncated && carry.trim() !== '') {
      const refusal = take(carry)
      if (refusal !== undefined) return { kind: 'refused', reason: refusal }
    }
    // One failure sentence per pass: retries repeat the same error, and the last
    // one is the one the engine settled on. It is appended after the facts, so a
    // report reads as session, turn, then what went wrong.
    if (pendingFailure !== undefined && fragments.length < WORKER_HISTORY_MAX_FRAGMENTS) {
      if (looksLikeCredential(pendingFailure)) withheld += 1
      else fragments.push(Object.freeze({ kind: 'failure', text: truncateToCharacters(pendingFailure, WORKER_FRAGMENT_MAX_CHARACTERS) }))
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
  if (!isInspectableLocation(recorded, anchors.engine)) {
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
  if (!isInspectableLocation(location, anchors.engine)) {
    return { kind: 'unsupported', reason: 'The resolved location is not a native record this Team reads.' }
  }
  const before = await stat(location).catch((error: unknown): Error => error instanceof Error ? error : new Error(String(error)))
  if (before instanceof Error) {
    return { kind: 'unreadable', reason: boundedReason(`The engine's record could not be read: ${messageOf(before)}`) }
  }
  const outcome = await readRecord(location, before, before.size, anchors.engine, anchors.nativeSessionId, anchors.nativeTurnId)
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
