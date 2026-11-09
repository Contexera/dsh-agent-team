import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The one filesystem seam a test may redirect: which file an open actually returns. */
const fsControl = vi.hoisted(() => ({ substitute: undefined as { requested: string; actual: string } | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    // Everything else stays the real filesystem; only an open of the named path
    // returns another real file, which is how a swap between the check and the
    // open is modelled without fabricating a handle.
    open: async (path: string, ...rest: readonly unknown[]) => {
      const target = fsControl.substitute?.requested === path ? fsControl.substitute.actual : path
      return (actual.open as unknown as (target: string, ...args: readonly unknown[]) => Promise<unknown>)(target, ...rest)
    },
  }
})

import {
  WORKER_FRAGMENT_MAX_CHARACTERS,
  WORKER_HISTORY_MAX_BYTES,
  WORKER_HISTORY_MAX_FRAGMENTS,
  readWorkerHistory,
} from '../src/worker-inspection.ts'

const homes: string[] = []

afterEach(async () => {
  fsControl.substitute = undefined
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

/** A throwaway CODEX_HOME-shaped tree: the reader only ever sees `sessions/**\/rollout-*.jsonl`. */
async function recordPath(threadId: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'worker-inspection-'))
  homes.push(home)
  const directory = join(home, 'sessions', '2026', '11', '09')
  await mkdir(directory, { recursive: true })
  return join(directory, `rollout-2026-11-09T12-00-00-${threadId}.jsonl`)
}

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function sessionMeta(threadId: string, extra: Record<string, unknown> = {}): string {
  return line({ timestamp: '2026-11-09T12:00:00.000Z', ordinal: 0, type: 'session_meta',
    payload: { session_id: threadId, id: threadId, cli_version: '0.167.0', originator: 'oar',
      cwd: '/tmp/project', timestamp: '2026-11-09T12:00:00.000Z', ...extra } })
}

function turnContext(turnId: string, model = 'gpt-6.1-sol'): string {
  return line({ type: 'turn_context', payload: { turn_id: turnId, root_turn_id: turnId, model,
    approval_policy: 'on-request', sandbox_policy: { type: 'read-only' }, cwd: '/tmp/project' } })
}

function taskComplete(turnId: string, error: string | null, answer: string | null = null): string {
  return line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId, root_turn_id: turnId,
    last_agent_message: answer, duration_ms: 15674,
    ...error === null ? {} : { error: { message: error, codex_error_info: { http_connection_failed: { http_status_code: 401 } } } } } })
}

function turnAborted(turnId: string, reason = 'interrupted'): string {
  return line({ type: 'event_msg', payload: { type: 'turn_aborted', turn_id: turnId, root_turn_id: turnId, reason } })
}

const UNAUTHORIZED = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, '
  + 'url: https://api.openai.com/v1/responses, cf-ray: a57cba66-NRT'

describe('readWorkerHistory', () => {
  it('reads the recorded turn out of the engine\'s own record, bounded to safe fields', async () => {
    const threadId = 'thread-a'
    const turnId = 'turn-a'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + turnContext(turnId) + taskComplete(turnId, UNAUTHORIZED))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
    expect(read).toEqual({
      kind: 'read',
      withheld: 0,
      truncated: false,
      fragments: [
        { kind: 'session', text: 'Native session record: engine 0.167.0 · originator oar · cwd /tmp/project · written 2026-11-09T12:00:00.000Z' },
        { kind: 'turn', text: `Native turn ${turnId}: model gpt-6.1-sol · approval on-request · sandbox read-only` },
        { kind: 'failure', text: `Native turn failed after 15674 ms: ${UNAUTHORIZED}` },
      ],
    })
  })

  it('never duplicates the model\'s own answer, which the run already returned', async () => {
    const threadId = 'thread-output'
    const turnId = 'turn-output'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + taskComplete(turnId, 'stream disconnected', 'half an answer'))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
    expect(read.kind).toBe('read')
    if (read.kind !== 'read') return
    expect(read.fragments.map(fragment => fragment.kind)).toEqual(['session', 'failure'])
    expect(JSON.stringify(read)).not.toContain('half an answer')
  })

  it('answers an interrupted turn with its own reason instead of a failure', async () => {
    const threadId = 'thread-aborted'
    const turnId = 'turn-aborted'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + turnContext(turnId) + turnAborted(turnId))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
    expect(read.kind).toBe('read')
    if (read.kind !== 'read') return
    expect(read.fragments.map(fragment => fragment.text)).toContain('Native turn interrupted: interrupted')
  })

  it('ignores another turn recorded in the same file', async () => {
    const threadId = 'thread-two-turns'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + turnContext('turn-first') + taskComplete('turn-first', 'first failure')
      + turnContext('turn-second') + taskComplete('turn-second', 'second failure'))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: 'turn-second', nativeStorage: path })
    expect(read.kind).toBe('read')
    if (read.kind !== 'read') return
    expect(read.fragments.map(fragment => fragment.text).filter(text => text.includes('failure'))).toEqual([
      'Native turn failed after 15674 ms: second failure',
    ])
  })

  it('answers two records looked up in reverse order with only their own fragments', async () => {
    const first = await recordPath('thread-first')
    const second = await recordPath('thread-second')
    await writeFile(first, sessionMeta('thread-first') + turnContext('turn-first') + taskComplete('turn-first', 'first failure'))
    await writeFile(second, sessionMeta('thread-second') + turnContext('turn-second') + taskComplete('turn-second', 'second failure'))
    const readSecond = await readWorkerHistory({ nativeSessionId: 'thread-second', nativeTurnId: 'turn-second', nativeStorage: second })
    const readFirst = await readWorkerHistory({ nativeSessionId: 'thread-first', nativeTurnId: 'turn-first', nativeStorage: first })
    const textsOf = (read: typeof readFirst): string[] => read.kind === 'read' ? read.fragments.map(fragment => fragment.text) : []
    expect(textsOf(readSecond).join('\n')).toContain('second failure')
    expect(textsOf(readSecond).join('\n')).not.toContain('first failure')
    expect(textsOf(readFirst).join('\n')).toContain('first failure')
    expect(textsOf(readFirst).join('\n')).not.toContain('second failure')
  })

  it('never reports a complete read when the recorded turn is not in the record', async () => {
    const threadId = 'thread-unmatched'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + turnContext('turn-other') + taskComplete('turn-other', 'another turn'))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: 'turn-absent', nativeStorage: path })
    expect(read.kind).toBe('unmatched')
    if (read.kind !== 'unmatched') return
    expect(read.reason).toContain('turn-absent')
  })

  it('names a record written without a turn anchor instead of calling it complete', async () => {
    const threadId = 'thread-unanchored'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeStorage: path })
    expect(read.kind).toBe('unmatched')
    if (read.kind !== 'unmatched') return
    expect(read.reason).toContain('The ending recorded no native turn id')
  })

  it('refuses a location that is not a file', async () => {
    const threadId = 'thread-directory'
    const path = await recordPath(threadId)
    await mkdir(path)
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: 'turn-x', nativeStorage: path })
    expect(read.kind).toBe('unsupported')
  })

  it('reports a location it cannot resolve as unreadable, not as missing', async () => {
    const threadId = 'thread-loop'
    const path = await recordPath(threadId)
    // A link that points at itself: the location exists and can never be opened.
    await symlink(path, path)
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: 'turn-loop', nativeStorage: path })
    expect(read.kind).toBe('unreadable')
    if (read.kind !== 'unreadable') return
    expect(read.reason).toContain(path)
  })

  it('resolves a symlinked location before deciding it is a record', async () => {
    const threadId = 'thread-link'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + taskComplete('turn-link', 'linked failure'))
    const link = `${path}.link.jsonl`
    await symlink(path, link)
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: 'turn-link', nativeStorage: link })
    expect(read.kind).toBe('read')
  })

  it('withholds a fragment carrying a sensitive key and value', async () => {
    for (const message of ['Refused: password=NOT_A_REAL_PASSWORD_PROBE', 'Refused: x-api-key: NOT_A_REAL_KEY_PROBE',
      'Refused: Authorization: NOT_A_REAL_AUTH_PROBE', 'Refused: api_key=NOT_A_REAL_API_KEY_PROBE']) {
      const threadId = 'thread-keyed'
      const turnId = 'turn-keyed'
      const path = await recordPath(threadId)
      await writeFile(path, sessionMeta(threadId) + taskComplete(turnId, message))
      const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
      expect(read.kind).toBe('read')
      if (read.kind !== 'read') return
      expect(read.withheld).toBe(1)
      expect(JSON.stringify(read)).not.toContain('NOT_A_REAL_')
    }
  })

  it('withholds a credential written as a quoted JSON pair', async () => {
    // A JSON body quotes both the key and the value; the separator is still the
    // one a sensitive key uses, so the fragment is withheld whole.
    for (const message of ['Refused: {"password":"NOT_A_REAL_QUOTED_PASSWORD_PROBE"}',
      'Refused: {"x-api-key":"NOT_A_REAL_QUOTED_KEY_PROBE"}']) {
      const threadId = 'thread-quoted'
      const turnId = 'turn-quoted'
      const path = await recordPath(threadId)
      await writeFile(path, sessionMeta(threadId) + taskComplete(turnId, message))
      const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
      expect(read.kind).toBe('read')
      if (read.kind !== 'read') return
      expect(read.withheld).toBe(1)
      expect(JSON.stringify(read)).not.toContain('NOT_A_REAL_')
    }
  })

  it('refuses a file that opened in place of the one it checked', async () => {
    const threadId = 'thread-swapped'
    const turnId = 'turn-swapped'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + taskComplete(turnId, 'the recorded failure'))
    const other = await recordPath(threadId)
    await writeFile(other, sessionMeta(threadId) + taskComplete(turnId, 'WRONG_OPENED_FILE_PROBE'))
    fsControl.substitute = { requested: path, actual: other }
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
    // The path and its stat never changed; only the handle did, so the identity
    // check is the one that has to catch it.
    expect(read.kind).toBe('unreadable')
    expect(JSON.stringify(read)).not.toContain('WRONG_OPENED_FILE_PROBE')
  })

  it('refuses an oversized recorded location without echoing it', async () => {
    const oversized = 'unsupported/' + 'P'.repeat(128 * 1024)
    const read = await readWorkerHistory({ nativeSessionId: 'thread-oversized', nativeTurnId: 'turn',
      nativeStorage: oversized })
    expect(read.kind).toBe('unsupported')
    // Cutting the value into a shorter path would invent a location nobody
    // recorded, so the whole value is refused and never carried into the reason.
    expect(JSON.stringify(read)).not.toContain('PPPPPPPPPP')
  })

  it('keeps an ordinary failure sentence that only mentions authentication', async () => {
    const threadId = 'thread-plain'
    const turnId = 'turn-plain'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + taskComplete(turnId, UNAUTHORIZED))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
    expect(read.kind).toBe('read')
    if (read.kind !== 'read') return
    expect(read.withheld).toBe(0)
    expect(read.fragments.at(-1)?.text).toContain('Missing bearer or basic authentication')
  })

  it('reports a record that is no longer there instead of failing', async () => {
    const path = await recordPath('thread-gone')
    const read = await readWorkerHistory({ nativeSessionId: 'thread-gone', nativeTurnId: 'turn-gone', nativeStorage: path })
    expect(read.kind).toBe('missing')
    if (read.kind !== 'missing') return
    // The reason names the fact, not the path: the report already carries the
    // recorded location, and a reason never echoes a native value.
    expect(read.reason).toBe('The engine\'s record is no longer at the recorded location.')
  })

  it('reports a run that never opened a native session', async () => {
    const read = await readWorkerHistory({})
    expect(read).toEqual({ kind: 'unpersisted',
      reason: 'The ending recorded no native session, so there is no native record to look up.' })
  })

  it('reports a session whose engine named no location', async () => {
    const read = await readWorkerHistory({ nativeSessionId: 'thread-nowhere' })
    expect(read).toEqual({ kind: 'unpersisted',
      reason: 'The ending recorded no location for its native record, so there is nothing to look up.' })
  })

  it('refuses a location outside a sessions directory', async () => {
    const read = await readWorkerHistory({ nativeSessionId: 'thread-x', nativeStorage: '/tmp/rollout-thread-x.jsonl' })
    expect(read.kind).toBe('unsupported')
  })

  it('refuses a file that is not the recorded session\'s own record', async () => {
    const path = await recordPath('thread-claimed')
    await writeFile(path, sessionMeta('thread-someone-else') + taskComplete('turn-x', 'someone else\'s failure'))
    const read = await readWorkerHistory({ nativeSessionId: 'thread-claimed', nativeTurnId: 'turn-x', nativeStorage: path })
    expect(read.kind).toBe('unsupported')
    if (read.kind !== 'unsupported') return
    expect(read.reason).toContain('thread-claimed')
  })

  it('refuses a record whose first line is not a session header', async () => {
    const path = await recordPath('thread-future')
    await writeFile(path, line({ type: 'future_layout', payload: { session_id: 'thread-future' } }))
    const read = await readWorkerHistory({ nativeSessionId: 'thread-future', nativeStorage: path })
    expect(read.kind).toBe('unsupported')
  })

  it('refuses an empty record', async () => {
    const path = await recordPath('thread-empty')
    await writeFile(path, '')
    const read = await readWorkerHistory({ nativeSessionId: 'thread-empty', nativeStorage: path })
    expect(read.kind).toBe('unsupported')
  })

  it('withholds a fragment whose text looks like a credential instead of masking it', async () => {
    const threadId = 'thread-secret'
    const turnId = 'turn-secret'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + taskComplete(turnId, 'request failed with Bearer abcdefghijklmnopqrstuvwxyz012345'))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
    expect(read.kind).toBe('read')
    if (read.kind !== 'read') return
    expect(read.withheld).toBe(1)
    expect(read.fragments.map(fragment => fragment.kind)).toEqual(['session'])
  })

  it('bounds one fragment\'s length', async () => {
    const threadId = 'thread-long'
    const turnId = 'turn-long'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + taskComplete(turnId, 'x'.repeat(WORKER_FRAGMENT_MAX_CHARACTERS * 3)))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
    expect(read.kind).toBe('read')
    if (read.kind !== 'read') return
    const failure = read.fragments.find(fragment => fragment.kind === 'failure')
    expect(failure?.text.length).toBeLessThanOrEqual(WORKER_FRAGMENT_MAX_CHARACTERS)
  })

  it('stops at its byte bound before parsing an oversized line', async () => {
    const threadId = 'thread-huge'
    const turnId = 'turn-huge'
    const path = await recordPath(threadId)
    // One line far past the bound: it must never be buffered whole or parsed, so
    // no fragment may come out of it and the turn stays unmatched.
    await writeFile(path, sessionMeta(threadId) + line({ type: 'event_msg',
      payload: { type: 'task_complete', turn_id: turnId, error: { message: 'x'.repeat(WORKER_HISTORY_MAX_BYTES + 65_536) } } }))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
    expect(read.kind).toBe('unmatched')
    if (read.kind !== 'unmatched') return
    expect(read.reason).toContain('longer than this reader takes')
    expect(JSON.stringify(read)).not.toContain('xxxxxxxxxx')
  })

  it('stops at its byte bound on a record of many lines and says so', async () => {
    const threadId = 'thread-long'
    const turnId = 'turn-long'
    const path = await recordPath(threadId)
    const filler = line({ type: 'response_item', payload: { type: 'message', text: 'x'.repeat(4096) } })
    await writeFile(path, sessionMeta(threadId) + filler.repeat(2200) + taskComplete(turnId, 'beyond the bound'))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
    expect(read.kind).toBe('unmatched')
    if (read.kind !== 'unmatched') return
    expect(read.reason).toContain('longer than this reader takes')
  })

  it('never returns more fragments than its bound', async () => {
    const threadId = 'thread-many'
    const turnId = 'turn-many'
    const path = await recordPath(threadId)
    await writeFile(path, sessionMeta(threadId) + turnContext(turnId) + taskComplete(turnId, 'failure', 'answer'))
    const read = await readWorkerHistory({ nativeSessionId: threadId, nativeTurnId: turnId, nativeStorage: path })
    expect(read.kind).toBe('read')
    if (read.kind !== 'read') return
    expect(read.fragments.length).toBeLessThanOrEqual(WORKER_HISTORY_MAX_FRAGMENTS)
  })
})
