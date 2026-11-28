import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { type SessionEvent, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dshInstallAnchor, managerSessionEvidenceScriptPath } from '../src/session-evidence.ts'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const skillDirectory = resolve(dirname(managerSessionEvidenceScriptPath()), '..')
const sessionId = SessionId('session:evidence-fixture')
/** A real installed package path: the reader resolves its backend from one of these. */
const anchor = require.resolve('@deepseek-ai/dsh-session-persistence-jsonl/package.json')

let home: string
let temporaryRoot: string
let script: string
let sessionsRoot: string

/** Only the message-shaped events carry a surface operation; lifecycle events refuse one. */
const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'system/message'])

/**
 * One turn a manager would actually diagnose: a request, a tool call the
 * assistant advertised, its refusal, and an oversized answer. The v4 format
 * validates these relationships, so a fixture that skips them is corruption,
 * not a shortcut.
 */
function fixtureEvents(): readonly SessionEvent[] {
  const time = Date.now()
  const event = (seq: number, type: string, data: unknown): SessionEvent => ({
    type, seq: SessionSeq(seq), time, ...(SURFACE_TYPES.has(type) ? { surfaceOp: 'append' } : {}), data,
  } as SessionEvent)
  return [
    event(0, 'user/message', createUserMessage({ content: [{ type: 'text', text: 'Please tighten the release notes.' }], source: { kind: 'user' } })),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'step/start', { turn: 1, step: 1 }),
    event(3, 'assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
      content: [
        { type: 'text', text: 'Reading the Thread first.' },
        { type: 'tool-call', id: 'call_evidence', name: 'team_thread', arguments: '{"action":"read"}' },
      ] as never,
      source: { provider: 'mock', model: 'mock' },
    }) }),
    event(4, 'tool/call', { turn: 1, step: 1, callId: 'call_evidence', name: 'team_thread', arguments: '{"action":"read"}' }),
    event(5, 'tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: 'call_evidence' as never, content: [{ type: 'text', text: 'Refused: not_project_member' }], isError: true,
    }) }),
    event(6, 'assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
      // Backslashes and quotes double when JSON escapes them, and the tail is
      // multi-byte: a budget measured before escaping is not the printed size.
      content: [{ type: 'text', text: 'C:\\path\\"quoted"\\n '.repeat(450) + '中文 🚀 '.repeat(60) }],
      source: { provider: 'mock', model: 'mock' },
    }) }),
    event(7, 'step/end', { turn: 1, step: 1 }),
    event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/** Every file under `home` with its digest, so a read that wrote anything is visible. */
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const relative of (await readdir(home, { recursive: true })).sort()) {
    const file = join(home, relative)
    if ((await stat(file)).isFile()) files[relative] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  return files
}

/** Run the shipped reader the way a manager would: plain `node`, no checkout, no tsx, no NODE_PATH. */
async function reader(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args], {
      cwd: home, timeout: 30_000, env: { PATH: dirname(process.execPath), HOME: home },
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}

/** Write one Session through the same backend the Host uses, so the fixture is a real log. */
async function writeSession(id: string, events: readonly SessionEvent[]): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) throw new Error('JSONL persistence did not mount')
    const handle = await persistence.create({
      id: SessionId(id), version: sessionFormatCatalog.currentVersion, createdAt: Date.now(),
      cwd: '/tmp/evidence-checkout', isSeeded: false, delegationDepth: 0,
    } as never)
    try {
      await handle.append(events)
      await handle.flush()
    } finally {
      await handle.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

/**
 * A Session whose index rows are long enough to outgrow the answer budget: a
 * tool name is the only field a row carries that can be arbitrarily long, so
 * the bulk is real tool calls rather than padded bodies.
 */
async function seedBulkSession(count: number): Promise<string> {
  const id = `session:bulk-${count}`
  const events: SessionEvent[] = []
  let seq = 0
  const push = (type: string, data: unknown) => {
    events.push({
      type, seq: SessionSeq(seq++), time: Date.now(),
      ...(SURFACE_TYPES.has(type) ? { surfaceOp: 'append' } : {}), data,
    } as SessionEvent)
  }
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  for (let index = 0; index < count; index += 1) {
    const callId = `call_bulk_${index}`
    const name = `mcp__workspace__${'long_tool_name_'.repeat(8)}${index}`
    push('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }] as never,
      source: { provider: 'mock', model: 'mock' },
    }) })
    push('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
    push('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
      callId: callId as never, content: [{ type: 'text', text: 'ok' }], isError: false,
    }) })
  }
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await writeSession(id, events)
  return id
}

/**
 * Nine long messages in one Session, each carrying backslashes, quotes and
 * multi-byte text. Every one serializes past the per-event cap and re-escapes
 * to roughly twice its pre-escape length, which is the shape the pre-fix
 * budget miscounted: on this fixture that reader printed 51,560 characters
 * while reporting 28,304, and returned previews with no way to continue.
 */
async function seedLongSession(): Promise<string> {
  const id = 'session:long-messages'
  const events: SessionEvent[] = []
  let seq = 0
  const push = (type: string, data: unknown) => {
    events.push({
      type, seq: SessionSeq(seq++), time: Date.now(),
      ...(SURFACE_TYPES.has(type) ? { surfaceOp: 'append' } : {}), data,
    } as SessionEvent)
  }
  push('turn/start', { turn: 1 })
  for (let step = 1; step <= 9; step += 1) {
    push('step/start', { turn: 1, step })
    push('assistant/message', { turn: 1, step, message: createAssistantMessage({
      content: [{ type: 'text', text: `step ${step} ` + 'C:\\path\\"quoted"\\n '.repeat(200) + '中文 🚀 '.repeat(20) }],
      source: { provider: 'mock', model: 'mock' },
    }) })
    push('step/end', { turn: 1, step })
  }
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await writeSession(id, events)
  return id
}

beforeEach(async () => {
  temporaryRoot = await realpath(tmpdir())
  home = await mkdtemp(join(temporaryRoot, 'team-session-evidence-'))
  sessionsRoot = join(home, 'sessions')
  // The script is copied out of the repository: an installed package has the
  // skill directory and nothing above it, which is what makes the anchor real.
  await cp(skillDirectory, join(home, 'installed', 'manager-session-evidence'), { recursive: true })
  script = join(home, 'installed', 'manager-session-evidence', 'scripts', 'session-evidence.mjs')
  await writeSession(sessionId, fixtureEvents())
})

afterEach(async () => {
  if (home === undefined) return
  expect(dirname(home)).toBe(temporaryRoot)
  expect(basename(home).startsWith('team-session-evidence-')).toBe(true)
  await rm(home, { recursive: true, force: true })
})

describe('manager Session evidence reader', () => {
  it('indexes one stored Session from an installed copy without reading or writing anything else', async () => {
    const before = await snapshot()
    const result = await reader('index', '--session', sessionId, '--root', sessionsRoot, '--anchor', anchor)
    expect(result.code).toBe(0)
    const index = JSON.parse(result.stdout)
    expect(index).toMatchObject({ ok: true, command: 'index', sessionId, read: { eventsRead: 9 }, matched: 9, returned: 9, truncated: false })
    expect(index.storage).toMatchObject({ root: sessionsRoot, formatStatus: 'current', location: { kind: 'jsonl' } })
    expect(index.storage.location.path.startsWith(sessionsRoot)).toBe(true)
    // The index is a shape, not content: no event body reaches the model here.
    expect(index.events.map((event: { seq: number }) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(index.events[4]).toMatchObject({ type: 'tool/call', turn: 1, step: 1, callId: 'call_evidence', toolName: 'team_thread' })
    expect(index.events[4].data).toBeUndefined()
    expect(index.events[0].data).toBeUndefined()
    expect(await snapshot()).toEqual(before)
  })

  it('keeps an index answer inside the same output budget and names what it dropped', async () => {
    const bulk = await seedBulkSession(200)
    const before = await snapshot()
    const printed = await reader('index', '--session', bulk, '--root', sessionsRoot, '--anchor', anchor, '--limit', '200')
    expect(printed.code).toBe(0)
    const index = JSON.parse(printed.stdout)
    // Long tool names alone can push 200 rows past the cap; the answer stays
    // inside it and says how many rows are missing instead of printing them.
    expect(printed.stdout.trimEnd().length).toBeLessThanOrEqual(32_000)
    expect(index).toMatchObject({ ok: true, matched: 604, truncated: true })
    expect(index.returned).toBeLessThan(200)
    expect(index.events).toHaveLength(index.returned)
    expect(index.truncatedNote).toContain('narrow with --from-seq/--to-seq')
    // The rows kept are the newest ones, and the range reports where they start.
    expect(index.seqRange.from).toBe(index.events[0].seq)
    expect(index.seqRange.to).toBe(index.events.at(-1).seq)
    expect(index.events.at(-1).seq).toBe(603)
    expect(await snapshot()).toEqual(before)
  })

  it('reads a bounded raw window around one seq and marks what it cut', async () => {
    const before = await snapshot()
    const printed = await reader('window', '--session', sessionId, '--root', sessionsRoot,
      '--anchor', anchor, '--seq', '5', '--before', '1', '--after', '1')
    const window = JSON.parse(printed.stdout)
    expect(window).toMatchObject({ ok: true, command: 'window', requested: { seq: 5, before: 1, after: 1 }, startSeq: 4, endSeq: 6, count: 3 })
    expect(window.target).toMatchObject({ seq: 5, type: 'tool/result', turn: 1, step: 1 })
    expect(JSON.stringify(window.target.data)).toContain('not_project_member')
    // The oversized assistant message is bounded, and the cut names how to
    // continue instead of losing the rest of the event.
    const big = window.events.find((event: { seq: number }) => event.seq === 6)
    expect(big).toMatchObject({ truncated: true })
    expect(big.data).toBeUndefined()
    expect(big.dataSegment).toMatchObject({ offset: 0 })
    expect(big.dataSegment.text.length).toBeLessThanOrEqual(4_000)
    expect(big.dataSegment.nextOffset).toBe(big.dataSegment.text.length)
    expect(big.dataSegment.remaining).toBe(big.dataLength - big.dataSegment.nextOffset)
    // A cut never splits a surrogate pair, so the piece is printable text.
    expect(big.dataSegment.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(window.budget).toMatchObject({ maxEventCharacters: 4_000, maxOutputCharacters: 32_000 })
    // The reported size is the size of what was printed, wrapper included.
    expect(window.budget.outputCharacters).toBe(printed.stdout.trimEnd().length)
    expect(printed.stdout.trimEnd().length).toBeLessThanOrEqual(32_000)
    expect(await snapshot()).toEqual(before)
  })

  it('continues a cut event from where the last read stopped and reassembles it', async () => {
    const read = async (offset: number) => JSON.parse((await reader('window', '--session', sessionId, '--root', sessionsRoot,
      '--anchor', anchor, '--seq', '6', '--before', '0', '--after', '0', '--offset', String(offset))).stdout).target.dataSegment
    let segment = await read(0)
    const pieces = [segment.text]
    const total = segment.totalCharacters
    // Every read continues where the last one stopped, so the whole event is
    // reachable through the script and the manager never opens the log itself.
    while (segment.remaining > 0) {
      const next = await read(segment.nextOffset)
      expect(next.offset).toBe(segment.nextOffset)
      pieces.push(next.text)
      segment = next
    }
    expect(pieces.length).toBeGreaterThan(1)
    const reassembled = JSON.parse(pieces.join(''))
    expect(JSON.stringify(reassembled)).toHaveLength(total)
    expect(reassembled.message.content[0].text).toContain('中文 🚀')
  })

  it('keeps nine long escaped events inside the budget it reports', async () => {
    const long = await seedLongSession()
    const before = await snapshot()
    // Seq 14 is the fifth of nine long messages; a 12/12 window spans all nine
    // plus the small lifecycle events between them.
    const printed = (await reader('window', '--session', long, '--root', sessionsRoot,
      '--anchor', anchor, '--seq', '14', '--before', '12', '--after', '12')).stdout
    const window = JSON.parse(printed)
    const text = printed.trimEnd()
    expect(text.length).toBeLessThanOrEqual(32_000)
    // The reported size is the printed size, not the payload before escaping.
    expect(window.budget.outputCharacters).toBe(text.length)
    expect(window.budget.eventsOmitted).toBeGreaterThan(0)
    // The window spans seq 2–26; every event in it is either returned or counted.
    expect(window.count + window.budget.eventsOmitted).toBe(25)
    // The target is never the event that gets dropped.
    expect(window.target).toMatchObject({ seq: 14, truncated: true })
    expect(window.events.some((event: { seq: number }) => event.seq === 14)).toBe(true)
    // Every long event in the answer was cut to its own segment, so the answer
    // is bounded by the window budget rather than by nine full bodies.
    const segments = window.events.filter((event: { dataSegment?: unknown }) => event.dataSegment !== undefined)
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.every((event: { dataSegment: { text: string } }) => event.dataSegment.text.length <= 4_000)).toBe(true)
    expect(await snapshot()).toEqual(before)
  })

  it('answers a seq that is not in the log instead of failing the read', async () => {
    const result = await reader('window', '--session', sessionId, '--root', sessionsRoot, '--anchor', anchor, '--seq', '99')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, target: null })
    expect(JSON.parse(result.stdout).note).toContain('seq 0–8')
  })

  it('reports a missing Session and a corrupt log as unreadable, with the category on stdout', async () => {
    const missing = await reader('index', '--session', 'session:absent', '--root', sessionsRoot, '--anchor', anchor)
    expect(missing.code).toBe(2)
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, kind: 'missing', sessionId: 'session:absent' })

    const [project] = await readdir(sessionsRoot)
    const [sessionDirectory] = await readdir(join(sessionsRoot, project!))
    const logDirectory = join(sessionsRoot, project!, sessionDirectory!)
    const [artifact] = (await readdir(logDirectory)).filter(name => !name.endsWith('.lock'))
    await writeFile(join(logDirectory, artifact!), 'not a session log\n')
    const corrupt = await reader('index', '--session', sessionId, '--root', sessionsRoot, '--anchor', anchor)
    expect(corrupt.code).toBe(2)
    expect(JSON.parse(corrupt.stdout)).toMatchObject({ ok: false, kind: 'corrupt' })
  })

  it('refuses to guess the Harness installation when it cannot resolve one', async () => {
    const result = await reader('index', '--session', sessionId, '--root', sessionsRoot)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--anchor')
    expect(result.stdout).toBe('')
  })

  it('resolves the Harness before validating command-specific options', async () => {
    const unresolved = await reader('window')
    expect(unresolved.code).toBe(1)
    expect(unresolved.stdout).toBe('')
    expect(unresolved.stderr).toContain('cannot resolve the Harness Session backend')

    const invalid = await reader('window', '--anchor', anchor)
    expect(invalid.code).toBe(1)
    expect(invalid.stdout).toBe('')
    expect(invalid.stderr).toContain('--seq is required')
  })

  it('derives the storage root from the locator log path', async () => {
    const [project] = await readdir(sessionsRoot)
    const [sessionDirectory] = await readdir(join(sessionsRoot, project!))
    const [artifact] = (await readdir(join(sessionsRoot, project!, sessionDirectory!))).filter(name => !name.endsWith('.lock'))
    const log = join(sessionsRoot, project!, sessionDirectory!, artifact!)
    const result = await reader('index', '--session', sessionId, '--log', log, '--anchor', anchor, '--limit', '1')
    expect(result.code).toBe(0)
    const index = JSON.parse(result.stdout)
    expect(index.storage).toMatchObject({ root: sessionsRoot, location: { path: log } })
    expect(index).toMatchObject({ returned: 1, truncated: true, seqRange: { from: 8, to: 8 } })
  })

  it('refuses a locator that no longer matches the log before returning any event body', async () => {
    const [project] = await readdir(sessionsRoot)
    const [sessionDirectory] = await readdir(join(sessionsRoot, project!))
    const stale = join(sessionsRoot, project!, sessionDirectory!, 'session.v9.jsonl.zstd')
    const result = await reader('index', '--session', sessionId, '--root', sessionsRoot, '--anchor', anchor, '--log', stale)
    expect(result.code).toBe(1)
    const refusal = JSON.parse(result.stdout)
    expect(refusal).toMatchObject({ ok: false, kind: 'mismatch', sessionId, log: stale })
    // The refusal names the current artifact and sends the caller back to the
    // overview instead of answering with evidence from a stale address.
    expect(refusal.detail).toContain('session.v4.jsonl.zstd')
    expect(refusal.detail).toContain('re-read team_overview')
    expect(refusal.events).toBeUndefined()
  })

  it('reports a missing or unusable storage root as a category instead of a stack trace', async () => {
    const absent = await reader('index', '--session', sessionId, '--root', join(home, 'no-such-root'), '--anchor', anchor)
    expect(absent.code).toBe(2)
    expect(JSON.parse(absent.stdout)).toMatchObject({ ok: false, kind: 'missing', root: join(home, 'no-such-root') })
    expect(absent.stderr).not.toContain('at async')

    const file = join(home, 'not-a-directory')
    await writeFile(file, '')
    const unusable = await reader('index', '--session', sessionId, '--root', file, '--anchor', anchor)
    expect(unusable.code).toBe(2)
    expect(JSON.parse(unusable.stdout)).toMatchObject({ ok: false, kind: 'io', root: file })
    expect(unusable.stderr).not.toContain('at async')
  })
})

describe('DSH installation anchor', () => {
  it('finds the manifest above a launcher entry and answers undefined for an unknown layout', async () => {
    const install = join(home, 'install')
    await mkdir(join(install, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await writeFile(join(install, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
    const entry = join(install, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await writeFile(entry, '')
    expect(dshInstallAnchor(entry)).toBe(join(install, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))

    const elsewhere = join(home, 'elsewhere', 'bin.js')
    await mkdir(dirname(elsewhere), { recursive: true })
    await writeFile(elsewhere, '')
    expect(dshInstallAnchor(elsewhere)).toBeUndefined()
    expect(dshInstallAnchor(undefined)).toBeUndefined()
    expect(dshInstallAnchor(join(home, 'missing', 'bin.js'))).toBeUndefined()
  })

  it('ships the reader inside the skill directory, beside the SKILL.md that documents it', async () => {
    expect(managerSessionEvidenceScriptPath()).toBe(join(skillDirectory, 'scripts', 'session-evidence.mjs'))
    expect((await readFile(script, 'utf8')).startsWith('#!/usr/bin/env node')).toBe(true)
    expect(await readdir(skillDirectory)).toEqual(expect.arrayContaining(['SKILL.md', 'references', 'scripts']))
  })
})
