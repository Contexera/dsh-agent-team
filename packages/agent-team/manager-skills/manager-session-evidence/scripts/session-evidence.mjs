#!/usr/bin/env node
// Read-only Session evidence for the Team manager: index one stored Session, then
// read a bounded raw window around one seq. It reads and filters; it never judges,
// never writes, and never touches the Team ledger.
//
// The stored log is read through the Harness's own Session persistence backend —
// the same decoder, validation and format refusals the live Host uses — so this
// script ships no second parser. `--anchor` names the installed Harness package
// whose dependencies resolve that backend; without it the script tries its own
// location and the Host entry point.
//
// Usage:
//   node session-evidence.mjs index  --session <id> (--root <dir> | --log <path>) [filters]
//   node session-evidence.mjs window --session <id> (--root <dir> | --log <path>) --seq <n> [--before n] [--after n] [--offset n]
//
// Exit codes: 0 the log was read and the answer is in the JSON (including "no
// events matched" and "no such seq"); 1 usage, Harness resolution, or a locator
// that no longer names this Session's log; 2 the log or its storage root could
// not be read (missing/refused/corrupt/io/unknown).
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_INDEX_LIMIT = 40
const MAX_INDEX_LIMIT = 200
const DEFAULT_WINDOW = 3
const MAX_WINDOW = 50
/** One event's own text, per read; a longer event continues with `--offset`. */
const MAX_EVENT_CHARACTERS = 4000
/** The whole answer, measured on the JSON this process prints, wrapper included. */
const MAX_OUTPUT_CHARACTERS = 32000
/** The JSONL backend's stable corruption-message prefix (plain `Error`s, not typed). */
const CORRUPT_SESSION_LOG_TEXT = /corrupt session log/

/** A locator that no longer matches the log the backend resolves for this Session id. */
class LocatorMismatch extends Error {}

const USAGE = `usage: session-evidence.mjs <command> --session <id> (--root <dir> | --log <path>)

commands:
  index    bounded event index of one stored Session (no bodies)
  window   bounded raw events around one seq

options:
  --session <id>   the Session id from team_overview's sessionEvidence
  --root <dir>     the Session storage root (the directory holding project dirs)
  --log <path>     the stored log path from the locator; the root is derived from it
  --anchor <path>  the installed @deepseek-ai/dsh package.json (or its directory)
  index: --limit <n> (default ${DEFAULT_INDEX_LIMIT}, max ${MAX_INDEX_LIMIT}) --from-seq <n> --to-seq <n> --type <t[,t]> --tool <prefix>
  window: --seq <n> --before <n> --after <n> (default ${DEFAULT_WINDOW}, max ${MAX_WINDOW})
          --offset <n> continue a cut event's text from where the last read stopped

Every answer is one JSON object on stdout, at most ${MAX_OUTPUT_CHARACTERS} characters
including this wrapper. A cut event carries \`dataSegment\` — a character window into
the compact JSON of its data — with \`nextOffset\`; pass that back as \`--offset\` to
continue, and concatenate the segments in offset order to reassemble the event.
Bounded output is not a bounded read: the backend validates the whole stored log.
A --log that no longer names this Session's log is refused (exit 1) before any
event body is returned: re-read team_overview and use the locator it returns now.`

function parseArgs(argv) {
  const [command = '', ...rest] = argv
  const values = new Map()
  const flags = new Set()
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    if (!arg.startsWith('--')) usage(`unexpected argument "${arg}"`)
    const eq = arg.indexOf('=')
    if (eq > 0) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const name = arg.slice(2)
    const next = rest[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next)
      index += 1
    } else flags.add(name)
  }
  return { command, values, flags }
}

function usage(message) {
  console.error(`session-evidence: ${message}\n\n${USAGE}`)
  process.exit(1)
}

/** The stored log could not be read; the caller gets a category, never a stack trace. */
function unreadable(kind, detail, extra = {}) {
  console.log(JSON.stringify({ ok: false, kind, detail, ...extra }, null, 2))
  console.error(`session-evidence: ${kind}: ${detail}`)
  process.exit(2)
}

/** The request cannot be honoured against this address; nothing was read. */
function refuse(kind, detail, extra = {}) {
  console.log(JSON.stringify({ ok: false, kind, detail, ...extra }, null, 2))
  console.error(`session-evidence: ${kind}: ${detail}`)
  process.exit(1)
}

function integer(name, raw, fallback, max) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) usage(`--${name} must be a non-negative integer`)
  return max === undefined ? value : Math.min(value, max)
}

/** Anchors to resolve the Harness from, most specific first. */
function anchorCandidates(explicit) {
  if (explicit !== undefined) return [resolve(explicit)]
  const seeds = [fileURLToPath(import.meta.url)]
  if (process.argv[1] !== undefined) seeds.push(resolve(process.argv[1]))
  const candidates = []
  for (const seed of seeds) {
    candidates.push(seed)
    let directory = dirname(seed)
    for (let depth = 0; depth < 8; depth += 1) {
      candidates.push(join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  return candidates
}

/** Load the Harness modules this script reads through, from the first anchor that resolves them. */
async function loadHarness(explicit) {
  const names = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-session-persistence-jsonl']
  const tried = []
  for (const candidate of anchorCandidates(explicit)) {
    let require
    try {
      require = createRequire(candidate)
    } catch {
      continue
    }
    let resolved = []
    for (const name of names) {
      try {
        resolved.push(require.resolve(name))
      } catch {
        resolved = undefined
        break
      }
    }
    if (resolved === undefined) {
      tried.push(candidate)
      continue
    }
    const [cordis, persistence, jsonl] = await Promise.all(resolved.map(path => import(pathToFileURL(path).href)))
    return { anchor: candidate, Context: cordis.Context, errors: persistence, jsonl }
  }
  usage(`cannot resolve the Harness Session backend from ${explicit === undefined ? 'this installation' : explicit}. `
    + `Pass --anchor with the reader.anchor path that team_overview returned. Tried: ${tried.length === 0 ? 'none' : tried.join(', ')}`)
}

/** The storage root a stored log path belongs to: `<root>/<project>/<session>/<file>`. */
function rootOfLog(logPath) {
  return dirname(dirname(dirname(resolve(logPath))))
}

async function mount(harness, root) {
  const ctx = new harness.Context()
  await ctx.plugin(harness.jsonl, { root })
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('the JSONL Session backend did not mount')
  return { ctx, persistence }
}

/** The same five categories the Host reports, matched the same way. */
function classify(error, errors) {
  let current = error
  for (let depth = 0; current !== undefined && current !== null && depth <= 4; depth += 1) {
    if (current instanceof errors.SessionPersistenceNotFoundError) return { kind: 'missing', detail: current.message }
    if (current instanceof errors.SessionFormatUnsupportedError) {
      return { kind: 'refused', detail: current.message, ...(current.location === undefined ? {} : { location: current.location }) }
    }
    if (current instanceof errors.SessionPersistenceCorruptionError) return { kind: 'corrupt', detail: current.message }
    if (current instanceof Error && CORRUPT_SESSION_LOG_TEXT.test(current.message)) return { kind: 'corrupt', detail: current.message }
    current = current instanceof Error ? current.cause : undefined
  }
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return { kind: 'io', detail: error instanceof Error ? error.message : String(error) }
  }
  return { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) }
}

const stamp = time => (typeof time === 'number' ? new Date(time).toISOString() : null)

function dataOf(event) {
  const data = event.data
  return data === undefined || data === null || typeof data !== 'object' ? undefined : data
}

/** turn/step/callId/toolName, read from the canonical event data rather than guessed from neighbours. */
function derive(event) {
  const data = dataOf(event)
  if (data === undefined) return {}
  const derived = {}
  if (typeof data.turn === 'number') derived.turn = data.turn
  if (typeof data.step === 'number') derived.step = data.step
  const callId = data.callId ?? data.toolCallId ?? data.message?.source?.callId
  if (typeof callId === 'string') derived.callId = callId
  if (event.type === 'tool/call' && typeof data.name === 'string') derived.toolName = data.name
  return derived
}

const dataLength = event => {
  try {
    return JSON.stringify(event.data ?? null).length
  } catch {
    return null
  }
}

/** The storage root must be a readable directory before a backend is mounted on it; a file or an unreadable path is a classified failure, never a stack trace. */
function checkRoot(root) {
  let stats
  try {
    stats = statSync(root)
  } catch (error) {
    if (error.code === 'ENOENT') unreadable('missing', `no Session storage root at ${root}`, { root })
    unreadable('io', `cannot read the Session storage root ${root}: ${error.message}`, { root })
  }
  if (!stats.isDirectory()) unreadable('io', `the Session storage root ${root} is not a directory`, { root })
}

/**
 * Open one stored Session for reading. Mount, stat, open, read and close share
 * one failure path, so a backend that cannot start and a log that cannot be
 * decoded both answer with a category instead of a stack trace, and the fiber
 * is disposed on every exit.
 */
async function readSession(harness, args) {
  const sessionId = args.values.get('session')
  if (sessionId === undefined) usage('--session is required')
  const logPath = args.values.get('log')
  const rootFlag = args.values.get('root')
  if (rootFlag === undefined && logPath === undefined) usage('--root or --log is required')
  const root = rootFlag === undefined ? rootOfLog(logPath) : resolve(rootFlag)
  const harnessModules = await loadHarness(args.values.get('anchor'))
  checkRoot(root)
  let ctx
  let snapshot
  let events
  try {
    const mounted = await mount(harnessModules, root)
    ctx = mounted.ctx
    snapshot = await mounted.persistence.stat(sessionId)
    // A locator that names one artifact while the backend resolves another is a
    // stale address, not evidence: refuse before any event body is returned and
    // send the caller back to the current overview.
    if (logPath !== undefined && snapshot?.location !== undefined && resolve(snapshot.location.path) !== resolve(logPath)) {
      throw new LocatorMismatch(`the locator names ${resolve(logPath)} but this Session's log is ${resolve(snapshot.location.path)}`)
    }
    const handle = await mounted.persistence.open(sessionId, 'read')
    try {
      events = (await handle.read()).events
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (ctx !== undefined) await ctx.fiber.dispose().catch(() => {})
    if (error instanceof LocatorMismatch) {
      refuse('mismatch', `${error.message}; re-read team_overview for this Member and use the locator it returns now`,
        { sessionId, root, log: resolve(logPath) })
    }
    const classified = classify(error, harnessModules.errors)
    unreadable(classified.kind, classified.detail, {
      sessionId, root, ...(logPath === undefined ? {} : { log: resolve(logPath) }),
      ...(classified.location === undefined ? {} : { location: classified.location }),
    })
  }
  const location = snapshot?.location
  const storage = {
    root,
    ...(location === undefined ? {} : { location }),
    ...(snapshot?.formatStatus === undefined ? {} : { formatStatus: snapshot.formatStatus }),
    ...(snapshot?.sizeBytes === undefined ? {} : { sizeBytes: snapshot.sizeBytes }),
    ...(snapshot?.eventCount === undefined ? {} : { eventCount: snapshot.eventCount }),
  }
  return { sessionId, storage, events, dispose: () => ctx.fiber.dispose() }
}

async function cmdIndex(harness, args) {
  const session = await readSession(harness, args)
  try {
    const limit = integer('limit', args.values.get('limit'), DEFAULT_INDEX_LIMIT, MAX_INDEX_LIMIT)
    const fromSeq = integer('from-seq', args.values.get('from-seq'))
    const toSeq = integer('to-seq', args.values.get('to-seq'))
    const types = args.values.get('type')?.split(',').map(type => type.trim()).filter(type => type.length > 0)
    const tool = args.values.get('tool')
    const matched = session.events.filter(event => {
      if (fromSeq !== undefined && event.seq < fromSeq) return false
      if (toSeq !== undefined && event.seq > toSeq) return false
      if (types !== undefined && !types.includes(event.type)) return false
      if (tool !== undefined && !(derive(event).toolName ?? '').startsWith(tool)) return false
      return true
    })
    const start = Math.max(0, matched.length - limit)
    let rows = matched.slice(start).map(event => ({
      seq: event.seq, type: event.type, time: stamp(event.time), ...derive(event), dataLength: dataLength(event),
    }))
    // The index obeys the same output budget as a window, measured on the JSON
    // that is printed: rows are dropped from the oldest end and the answer says
    // how many are missing and how to narrow, so it never prints past its cap.
    let dropped = 0
    for (;;) {
      const omitted = start + dropped
      const text = JSON.stringify({
        ok: true,
        command: 'index',
        sessionId: session.sessionId,
        storage: session.storage,
        filters: {
          fromSeq: fromSeq ?? null, toSeq: toSeq ?? null, types: types ?? null, tool: tool ?? null, limit,
        },
        read: {
          eventsRead: session.events.length,
          scope: 'read-only; the backend validates the whole stored log to answer, only these rows are returned',
        },
        matched: matched.length,
        returned: rows.length,
        truncated: omitted > 0,
        ...(omitted === 0 ? {} : {
          truncatedNote: dropped === 0
            ? `${omitted} older matching event(s) exist; raise --limit or narrow with --from-seq/--to-seq`
            : `${omitted} matching event(s) are not in this answer; narrow with --from-seq/--to-seq`,
        }),
        seqRange: { from: rows[0]?.seq ?? null, to: rows.at(-1)?.seq ?? null },
        events: rows,
      }, null, 2)
      if (text.length <= MAX_OUTPUT_CHARACTERS || rows.length === 0) {
        console.log(text)
        return
      }
      rows = rows.slice(1)
      dropped += 1
    }
  } finally {
    await session.dispose()
  }
}

/** One event's data as the manager reads it: whole while it fits, otherwise a character window that names how to continue. */
function eventBody(event, offset) {
  const serialized = JSON.stringify(event.data ?? null)
  if (serialized.length <= MAX_EVENT_CHARACTERS) return { truncated: false, dataLength: serialized.length, data: event.data }
  const from = Math.min(offset, serialized.length)
  const text = sliceCodePoints(serialized.slice(from), MAX_EVENT_CHARACTERS)
  const nextOffset = from + text.length
  return {
    truncated: true, dataLength: serialized.length,
    dataSegment: {
      offset: from, nextOffset, totalCharacters: serialized.length,
      remaining: serialized.length - nextOffset, text,
    },
  }
}

/** Slice by code point so a cut never splits a surrogate pair; the budget stays in UTF-16 units. */
function sliceCodePoints(text, maxUnits) {
  let used = 0
  let end = 0
  for (const character of text) {
    if (used + character.length > maxUnits) break
    used += character.length
    end += character.length
  }
  return text.slice(0, end)
}

/**
 * The answer is the JSON this process prints, so the budget is measured on that
 * text — not on the payload before escaping, which under-counted quotes and
 * backslashes by more than a factor of two. Events are dropped from the far end
 * of the window until the whole answer fits; the target is never dropped, and
 * its own segment shrinks if it alone is too large.
 */
function emitWindow(payload, events, targetSeq) {
  const ordered = [...events]
  for (;;) {
    const fitted = {
      ...payload,
      target: ordered.find(event => event.seq === targetSeq) ?? null,
      events: ordered,
      count: ordered.length,
      startSeq: ordered[0]?.seq ?? null,
      endSeq: ordered.at(-1)?.seq ?? null,
      budget: {
        maxEventCharacters: MAX_EVENT_CHARACTERS, maxOutputCharacters: MAX_OUTPUT_CHARACTERS,
        outputCharacters: 0, eventsOmitted: payload.omitted,
        ...(payload.omitted > 0 ? { note: 'the answer hit its output budget; read a narrower window for the rest' } : {}),
      },
    }
    let text = JSON.stringify(fitted, null, 2)
    if (text.length <= MAX_OUTPUT_CHARACTERS) {
      // The reported size is the size of what is actually printed, so the count
      // is re-measured until the digits stop changing it.
      for (let pass = 0; pass < 3; pass += 1) {
        fitted.budget.outputCharacters = text.length
        const next = JSON.stringify(fitted, null, 2)
        const stable = next.length === text.length
        text = next
        if (stable) break
      }
      if (text.length <= MAX_OUTPUT_CHARACTERS) {
        console.log(text)
        return
      }
    }
    if (ordered.length > 1) {
      // Drop the farthest event from the target, never the target itself.
      const targetIndex = ordered.findIndex(event => event.seq === targetSeq)
      const last = ordered.length - 1
      ordered.splice(last === targetIndex ? last - 1 : last, 1)
      payload.omitted += 1
      continue
    }
    const only = ordered[0]
    const segment = only.dataSegment
    if (segment === undefined) {
      // Unreachable with these caps: one event without a segment is small.
      console.log(text)
      return
    }
    const shrunk = Math.max(200, Math.floor(segment.text.length / 2))
    ordered[0] = {
      ...only,
      dataSegment: {
        ...segment, nextOffset: segment.offset + shrunk,
        remaining: segment.totalCharacters - segment.offset - shrunk,
        text: segment.text.slice(0, shrunk),
      },
    }
  }
}

async function cmdWindow(harness, args) {
  const seq = integer('seq', args.values.get('seq'))
  if (seq === undefined) usage('--seq is required')
  const before = integer('before', args.values.get('before'), DEFAULT_WINDOW, MAX_WINDOW)
  const after = integer('after', args.values.get('after'), DEFAULT_WINDOW, MAX_WINDOW)
  const offset = integer('offset', args.values.get('offset'), 0)
  const session = await readSession(harness, args)
  try {
    const target = session.events.find(event => event.seq === seq)
    const base = { ok: true, command: 'window', sessionId: session.sessionId, storage: session.storage, requested: { seq, before, after, offset } }
    if (target === undefined) {
      console.log(JSON.stringify({
        ...base,
        target: null,
        note: session.events.length === 0
          ? 'this stored log holds no events'
          : `seq ${seq} is not in this log; it holds seq ${session.events[0].seq}–${session.events.at(-1).seq} (${session.events.length} events)`,
      }, null, 2))
      return
    }
    // The target is always included; the window then grows outward, nearest
    // first. `--offset` continues the target's own text, so a long event is read
    // in segments instead of being lost past the first slice.
    const ordered = [{ ...eventBody(target, offset), seq: target.seq, type: target.type, time: stamp(target.time), ...derive(target) }]
    for (let distance = 1; distance <= Math.max(before, after); distance += 1) {
      if (distance <= before) {
        const event = session.events.find(candidate => candidate.seq === seq - distance)
        if (event !== undefined) ordered.push({ ...eventBody(event, 0), seq: event.seq, type: event.type, time: stamp(event.time), ...derive(event) })
      }
      if (distance <= after) {
        const event = session.events.find(candidate => candidate.seq === seq + distance)
        if (event !== undefined) ordered.push({ ...eventBody(event, 0), seq: event.seq, type: event.type, time: stamp(event.time), ...derive(event) })
      }
    }
    ordered.sort((left, right) => left.seq - right.seq)
    emitWindow({ ...base, omitted: 0 }, ordered, seq)
  } finally {
    await session.dispose()
  }
}

const args = parseArgs(process.argv.slice(2))
if (args.flags.has('help') || args.command === '' || args.command === 'help') {
  console.log(USAGE)
  process.exit(args.command === '' ? 1 : 0)
}
const harness = await loadHarness(args.values.get('anchor'))
switch (args.command) {
  case 'index':
    await cmdIndex(harness, args)
    break
  case 'window':
    await cmdWindow(harness, args)
    break
  default:
    usage(`unknown command "${args.command}"`)
}
