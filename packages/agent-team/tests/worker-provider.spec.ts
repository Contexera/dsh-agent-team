/**
 * What the registered Worker provider reads at each open: the settings row as it
 * stands then, and the engine's own session identity as the run's id. OAR is
 * mocked here because this pins the seam the acceptance run proves natively.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@botiverse/oar'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { TeamWorkerProvider, type WorkerRunSpec } from '../src/worker-runtime.ts'

const KEY = 'OAR_CODEX_SANDBOX'

/** `hostSandbox` is what OAR 0.95.1 actually reads at open; `env` only reaches the child. */
const sessions: Array<{ id: string; env: Readonly<Record<string, string | null>>; hostSandbox: string | undefined }> = []

vi.mock('@botiverse/oar', () => ({
  codexRuntime: {
    installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/codex', version: 'x' }),
    session: async (_installation: unknown, options: { env: Readonly<Record<string, string | null>> }): Promise<Session> => {
      const session = {
        id: `native-${sessions.length + 1}`,
        events: () => () => {},
        prompt: async () => ({ kind: 'accepted', seq: 1 }),
        abort: async () => {},
        dispose: async () => {},
      }
      sessions.push({ id: session.id, env: options.env, hostSandbox: process.env[KEY] })
      return session as unknown as Session
    },
  },
  claudeRuntime: {},
}))

vi.mock('@botiverse/oar/observe', () => ({
  awaitTurnEnd: async () => ({ kind: 'completed' }),
}))

afterEach(() => { sessions.splice(0) })

const request = (cwd: string): ResolvedSubagentStartRequest => ({
  parent: { id: 'session:parent' },
  prompt: [{ type: 'text', text: 'do the small thing' }],
  cwd,
  signal: new AbortController().signal,
}) as unknown as ResolvedSubagentStartRequest

describe('the Worker provider', () => {
  it('reads the settings row at every open, so a saved change reaches the next delegation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'team-worker-provider-'))
    const operatorDefault = process.env[KEY]
    process.env[KEY] = 'danger-full-access'
    try {
      let spec: WorkerRunSpec = {
        engine: 'codex', env: { OAR_CODEX_BIN: '/data/bin/codex', OAR_CODEX_SANDBOX: 'workspace-write' }, launchArgs: [],
      }
      const provider = new TeamWorkerProvider('team-worker-codex', () => spec)
      await (await provider.start(request(cwd))).result
      spec = { engine: 'codex', env: { OAR_CODEX_BIN: '/data/bin/codex', OAR_CODEX_SANDBOX: 'read-only' }, launchArgs: [] }
      const second = await provider.start(request(cwd))
      await second.result

      expect(sessions.map(session => session.env)).toEqual([
        { OAR_CODEX_BIN: '/data/bin/codex', OAR_CODEX_SANDBOX: 'workspace-write' },
        { OAR_CODEX_BIN: '/data/bin/codex', OAR_CODEX_SANDBOX: 'read-only' },
      ])
      // Each open carries its own policy into the Host's env and hands the Host's back.
      expect(sessions.map(session => session.hostSandbox)).toEqual(['workspace-write', 'read-only'])
      expect(process.env[KEY]).toBe('danger-full-access')
      // The external child's id is the engine's own session identity.
      expect(second.id).toBe('native-2')
      expect(await second.result).toMatchObject({ stopReason: 'completed' })
    } finally {
      if (operatorDefault === undefined) delete process.env[KEY]
      else process.env[KEY] = operatorDefault
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
