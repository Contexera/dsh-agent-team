/**
 * What the registered Worker provider reads at each open: the settings row as it
 * stands then, a fresh external execution id, and the native conversation anchors
 * carried separately on its result. OAR is mocked here because this pins the seam
 * the acceptance run proves natively.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@botiverse/oar'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { TeamWorkerProvider, WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC, workerAnchorsOf, type WorkerRunSpec } from '../src/worker-runtime.ts'

const KEY = 'OAR_CODEX_SANDBOX'

/** What the fake engine does on the next open: its output, its turn, and its disposal verdict. */
const control = { text: '', hangTurn: false, disposeFails: false, eraseOnDispose: false, extraTurn: false,
  mismatchResume: false, emptyRecords: false }

/** `hostSandbox` is what OAR 0.95.1 actually reads at open; `env` only reaches the child. */
const sessions: Array<{ id: string; env: Readonly<Record<string, string | null>>; hostSandbox: string | undefined }> = []
const disposals: string[] = []

vi.mock('@botiverse/oar', () => ({
  codexRuntime: {
    installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/codex', version: 'x' }),
    session: async (_installation: unknown, options: { env: Readonly<Record<string, string | null>>; resume?: string }): Promise<Session> => {
      const id = control.mismatchResume ? 'native-other' : options.resume ?? `native-${sessions.length + 1}`
      let disposed = false
      const session = {
        id,
        events: (listener: (event: object) => void) => {
          if (control.text !== '') listener({ sessionId: id, agentPath: [], kind: 'text_delta', text: control.text, messageId: 'message-1' })
          return () => {}
        },
        prompt: async () => ({ kind: 'accepted', seq: 1 }),
        abort: async () => {},
        dispose: async () => {
          disposed = true
          disposals.push(id)
          if (control.disposeFails) throw new Error('the engine process did not exit')
        },
        // The engine's own record stream: the opening frame names where its record
        // lives, and the turn's records carry the native turn id. A real engine
        // closes this stream as it tears down, which `eraseOnDispose` models.
        records: () => {
          if (disposed && control.eraseOnDispose) throw new Error('record stream is closed')
          if (control.emptyRecords) return []
          return [
            { sessionId: id, agentPath: [], seq: 1, receivedAt: 0, kind: 'frame',
              body: { type: 'thread/start', native: { thread: { id, path: `/fake/sessions/2026/11/09/rollout-${id}.jsonl` } }, events: [] } },
            { sessionId: id, agentPath: [], seq: 2, receivedAt: 0, spanId: `turn-${id}`, kind: 'frame',
              body: { type: 'turn/started', native: {}, events: [] } },
            ...control.extraTurn ? [{ sessionId: id, agentPath: [], seq: 3, receivedAt: 0, spanId: 'unrelated-turn',
              kind: 'frame', body: { type: 'turn/started', native: {}, events: [] } }] : [],
          ]
        },
      }
      sessions.push({ id: session.id, env: options.env, hostSandbox: process.env[KEY] })
      return session as unknown as Session
    },
  },
  claudeRuntime: {},
}))

vi.mock('@botiverse/oar/observe', () => ({
  awaitTurnEnd: async () => control.hangTurn ? new Promise(() => {}) : { kind: 'completed' },
}))

afterEach(() => {
  sessions.splice(0)
  disposals.splice(0)
  control.text = ''
  control.hangTurn = false
  control.disposeFails = false
  control.eraseOnDispose = false
  control.extraTurn = false
  control.mismatchResume = false
  control.emptyRecords = false
})

const request = (cwd: string): ResolvedSubagentStartRequest => ({
  parent: { id: 'session:parent' },
  prompt: [{ type: 'text', text: 'do the small thing' }],
  cwd,
  signal: new AbortController().signal,
}) as unknown as ResolvedSubagentStartRequest

/** These cases read the run's own result, so the live-session sink has nothing to hold. */
const NO_SESSIONS = { opened: () => {}, closed: () => {} }

describe('the Worker provider', () => {
  it('reads the settings row at every open, so a saved change reaches the next delegation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'team-worker-provider-'))
    const operatorDefault = process.env[KEY]
    process.env[KEY] = 'danger-full-access'
    try {
      let spec: WorkerRunSpec = {
        engine: 'codex', env: { OAR_CODEX_BIN: '/data/bin/codex', OAR_CODEX_SANDBOX: 'workspace-write' }, launchArgs: [],
      }
      const provider = new TeamWorkerProvider('team-worker-codex', () => spec, NO_SESSIONS)
      const first = await provider.start(request(cwd))
      await first.result
      spec = { engine: 'codex', env: { OAR_CODEX_BIN: '/data/bin/codex', OAR_CODEX_SANDBOX: 'read-only' }, launchArgs: [],
        resume: 'native-1' }
      const second = await provider.start(request(cwd))
      const secondResult = await second.result

      expect(sessions.map(session => session.env)).toEqual([
        { OAR_CODEX_BIN: '/data/bin/codex', OAR_CODEX_SANDBOX: 'workspace-write' },
        { OAR_CODEX_BIN: '/data/bin/codex', OAR_CODEX_SANDBOX: 'read-only' },
      ])
      // Each open carries its own policy into the Host's env and hands the Host's back.
      expect(sessions.map(session => session.hostSandbox)).toEqual(['workspace-write', 'read-only'])
      expect(process.env[KEY]).toBe('danger-full-access')
      // A resumed native conversation is a fresh external child in the parent catalog.
      expect(second.id).not.toBe(first.id)
      expect(second.id).not.toBe('native-1')
      expect(secondResult).toMatchObject({ stopReason: 'completed' })
      expect(workerAnchorsOf(secondResult)?.nativeSessionId).toBe('native-1')
    } finally {
      if (operatorDefault === undefined) delete process.env[KEY]
      else process.env[KEY] = operatorDefault
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('disposes a native session that did not resume the requested conversation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'team-worker-provider-'))
    const provider = new TeamWorkerProvider('team-worker-codex', () => ({
      engine: 'codex', env: {}, launchArgs: [], resume: 'native-expected',
    }), NO_SESSIONS)
    control.mismatchResume = true
    let failure: unknown
    try {
      // If the provider incorrectly publishes the mismatched run, settle it so
      // the regression cannot leave an open turn behind.
      await (await provider.start(request(cwd))).result
    } catch (error: unknown) {
      failure = error
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
    expect(failure).toMatchObject({ stage: 'startup', category: 'unsupported' })
    expect(disposals).toEqual(['native-other'])
  })

  it('keeps the native conversation identity when its record stream is empty', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'team-worker-provider-'))
    const provider = new TeamWorkerProvider('team-worker-codex', () => ({ engine: 'codex', env: {}, launchArgs: [] }), NO_SESSIONS)
    control.emptyRecords = true
    try {
      const run = await provider.start(request(cwd))
      const anchors = workerAnchorsOf(await run.result)
      expect(anchors).toMatchObject({ nativeSessionId: 'native-1' })
      expect(anchors?.nativeTurnId).toBeUndefined()
      expect(anchors?.nativeStorage).toBeUndefined()
      expect(run.id).not.toBe('native-1')
      await run.dispose()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('publishes a stop with the cleanup verdict in the one result the parent is told', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'team-worker-provider-'))
    const spec: WorkerRunSpec = { engine: 'codex', env: {}, launchArgs: [] }
    const provider = new TeamWorkerProvider('team-worker-codex', () => spec, NO_SESSIONS)
    try {
      // A stop whose engine keeps producing output, then refuses to confirm its exit.
      control.text = 'partial output'
      control.hangTurn = true
      control.disposeFails = true
      const unconfirmed = new AbortController()
      const stopped = await provider.start({ ...request(cwd), signal: unconfirmed.signal })
      unconfirmed.abort()
      // The Harness waits for teardown but hands the parent the result it captured
      // here, so the cleanup verdict and the output so far have to be in it.
      expect(await stopped.result).toEqual({ output: [{ type: 'text', text: 'partial output' }], stopReason: 'error',
        diagnostic: WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC })
      // The engine's own teardown is the separate failure the Harness reports to the caller.
      await expect(stopped.dispose()).rejects.toThrow(/dispose/)

      // A stop the engine does confirm keeps the ordinary stopped result.
      control.disposeFails = false
      const confirmed = new AbortController()
      const clean = await provider.start({ ...request(cwd), signal: confirmed.signal })
      confirmed.abort()
      expect(await clean.result).toEqual({ output: [{ type: 'text', text: 'partial output' }], stopReason: 'aborted' })
      await clean.dispose()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('captures the anchors before a stop closes the record stream', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'team-worker-provider-'))
    const spec: WorkerRunSpec = { engine: 'codex', env: {}, launchArgs: [] }
    const provider = new TeamWorkerProvider('team-worker-codex', () => spec, NO_SESSIONS)
    try {
      // The engine answers its record stream only while it is alive; a capture
      // taken after the abort or the cleanup would find nothing to read.
      control.hangTurn = true
      control.eraseOnDispose = true
      const controller = new AbortController()
      const stopped = await provider.start({ ...request(cwd), signal: controller.signal })
      controller.abort()
      const result = await stopped.result
      expect(result.stopReason).toBe('aborted')
      expect(workerAnchorsOf(result)?.nativeTurnId).toBe('turn-native-1')
      expect(workerAnchorsOf(result)?.nativeStorage).toBe('/fake/sessions/2026/11/09/rollout-native-1.jsonl')
      // The anchors ride the object without becoming part of its JSON.
      expect(JSON.stringify(result)).not.toContain('turn-native-1')
      await stopped.dispose()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('reports no turn when the record holds more than one root turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'team-worker-provider-'))
    const spec: WorkerRunSpec = { engine: 'codex', env: {}, launchArgs: [] }
    const provider = new TeamWorkerProvider('team-worker-codex', () => spec, NO_SESSIONS)
    try {
      // Another root turn in the same record cannot be tied to this run's input,
      // so the run reports no turn id rather than the last one it saw.
      control.extraTurn = true
      const run = await provider.start(request(cwd))
      const anchors = workerAnchorsOf(await run.result)
      expect(anchors?.nativeTurnId).toBeUndefined()
      // The record's location is still known, so the look-up can say what it saw.
      expect(anchors?.nativeStorage).toBe('/fake/sessions/2026/11/09/rollout-native-1.jsonl')
      await run.dispose()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
