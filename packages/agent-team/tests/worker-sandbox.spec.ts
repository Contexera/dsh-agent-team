/**
 * The one channel OAR 0.95.1 offers for Codex's permission mode — the Host's own
 * `OAR_CODEX_SANDBOX`, read when a session opens — and the policy the settings
 * row carries into it. The native acceptance run proves the process it spawns;
 * this pins the window and its restoration.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { withCodexSandbox } from '../src/worker-runtime.ts'
import { workerEnvironment, workerRunSpec } from '../src/worker-service.ts'
import { TEAM_HOST_ROW_SETTINGS_SCHEMA, type Config } from '../src/host-row-settings.ts'

const row = (input: unknown): Config => TEAM_HOST_ROW_SETTINGS_SCHEMA(input as never) as unknown as Config

const KEY = 'OAR_CODEX_SANDBOX'

afterEach(() => { delete process.env[KEY] })

describe('the Codex sandbox policy a Worker carries', () => {
  it('is in place while the session opens, then the host environment is restored', async () => {
    process.env[KEY] = 'read-only'
    const seen: Array<string | undefined> = []
    await withCodexSandbox({ [KEY]: 'workspace-write' }, async () => {
      seen.push(process.env[KEY])
    })
    expect(seen).toEqual(['workspace-write'])
    expect(process.env[KEY]).toBe('read-only')
  })

  it('leaves no key behind when the host had none, even if the open fails', async () => {
    delete process.env[KEY]
    await expect(withCodexSandbox({ [KEY]: 'workspace-write' }, async () => {
      throw new Error('the engine refused to start')
    })).rejects.toThrow('the engine refused to start')
    expect(process.env[KEY]).toBeUndefined()
  })

  it('resolves a stored row that never named the Codex policy to full access', () => {
    // A Worker runs work the operator already delegated: the bundle adds no second
    // permission gate, and narrowing one is the operator's explicit opt-in.
    const worker = row({ worker: { enabled: true, engines: { codex: { enabled: true } } } }).worker.get()
    expect(worker.engines.codex.sandbox).toBe('danger-full-access')
    // Claude has no policy of its own, so an empty value stays the honest one.
    expect(worker.engines.claude.sandbox).toBe('')
  })

  it('gives both engines full permissions without a field to fill in', () => {
    const worker = row({ worker: { enabled: true, engines: { codex: { enabled: true }, claude: { enabled: true } } } }).worker.get()
    // Codex carries the default policy to OAR under OAR's own name.
    expect(workerEnvironment('codex', worker.engines.codex)).toEqual({ OAR_CODEX_SANDBOX: 'danger-full-access' })
    // Claude carries no permission flag at all: OAR adds --dangerously-skip-permissions itself.
    expect(workerEnvironment('claude', worker.engines.claude)).toEqual({})
    const claude = workerRunSpec('claude', worker, () => {})
    expect(claude.launchArgs).toEqual([])
    expect(JSON.stringify(claude)).not.toContain('permission-mode')
  })

  it('touches nothing when the engine is not Codex, or names no policy', async () => {
    process.env[KEY] = 'read-only'
    await withCodexSandbox({}, async () => {
      expect(process.env[KEY]).toBe('read-only')
    })
    expect(process.env[KEY]).toBe('read-only')
  })
})
