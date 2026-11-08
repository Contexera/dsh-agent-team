/**
 * Delegation refusals, idempotency, and result destination.
 *
 * The Harness subagent service is faked here on purpose: this spec is about the
 * decisions Team owns — who may delegate, which engine runs, what a resent
 * request does, and where the result goes. The real service is exercised by the
 * composition probe and by the native acceptance run.
 */

import { describe, expect, it, vi } from 'vitest'
import { WorkerRegistry, workerEnvironment, workerRunSpec, type WorkerConfig, DEFAULT_WORKER_CONFIG } from '../src/worker-service.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { AgentTeamProjectRef, AgentTeamRequestId, AgentTeamWorkerRef } from '../src/types.ts'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'

const project = 'project:00000000-0000-4000-8000-000000000001' as AgentTeamProjectRef
const cwd = '/tmp/worker-cwd'
const parent = { id: 'session:parent' } as unknown as Agent

const enabled = (overrides: Partial<WorkerConfig> = {}): WorkerConfig => ({
  ...DEFAULT_WORKER_CONFIG,
  enabled: true,
  engines: {
    codex: { ...DEFAULT_WORKER_CONFIG.engines.codex, enabled: true },
    claude: { ...DEFAULT_WORKER_CONFIG.engines.claude, enabled: false },
  },
  ...overrides,
})

interface FakeService {
  readonly runtime: SubagentRuntime
  readonly starts: Array<Parameters<SubagentRuntime['startActivation']>[0]>
  readonly providers: string[]
  settle: ((result: SubagentResult) => void) | undefined
  readonly disposals: number
}

function fakeSubagents(): FakeService {
  const state: FakeService = {
    starts: [],
    providers: [],
    settle: undefined,
    disposals: 0,
    runtime: undefined as never,
  } as unknown as FakeService
  const service = {
    registerProvider: (provider: { readonly name: string }) => {
      ;(state.providers as string[]).push(provider.name)
      return () => {}
    },
    startActivation: async (spec: Parameters<SubagentRuntime['startActivation']>[0]): Promise<SubagentActivation> => {
      ;(state.starts as unknown[]).push(spec)
      const result = Promise.withResolvers<SubagentResult>()
      ;(state as { settle?: (value: SubagentResult) => void }).settle = output => { result.resolve(output) }
      return {
        childId: 'session:child',
        result: result.promise,
        dispose: async () => { (state as { disposals: number }).disposals += 1 },
      } as unknown as SubagentActivation
    },
  }
  return Object.assign(state, { runtime: service as unknown as SubagentRuntime })
}

function registryFor(options: { config: WorkerConfig; owners?: readonly string[]; service?: FakeService }): {
  registry: WorkerRegistry
  service: FakeService
} {
  const service = options.service ?? fakeSubagents()
  const ctx = { get: (name: string) => name === 'subagents' ? service.runtime : undefined } as never
  const registry = new WorkerRegistry(ctx, {
    config: () => options.config,
    projectExists: ref => ref === project,
    projectOwners: () => options.owners ?? ['member:owner'],
    warn: () => {},
  })
  return { registry, service }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'request:1' as AgentTeamRequestId,
  projectRef: project,
  task: 'find why the nightly run fails',
  cwd,
  ...overrides,
}) as Parameters<WorkerRegistry['start']>[2]

describe('Worker delegation refusals', () => {
  it('refuses while the setting is off, before any provider exists', async () => {
    const { registry, service } = registryFor({ config: DEFAULT_WORKER_CONFIG })
    await expect(registry.start('member:owner', parent, request())).rejects.toThrow(/switched off/)
    expect(service.providers).toEqual([])
    expect(service.starts).toEqual([])
  })

  it('refuses a Member who does not own the Project', async () => {
    const { registry } = registryFor({ config: enabled() })
    await expect(registry.start('member:other', parent, request())).rejects.toThrow(/owner/)
  })

  it('refuses a Project this Team does not have', async () => {
    const { registry } = registryFor({ config: enabled() })
    await expect(registry.start('member:owner', parent, request({ projectRef: 'project:missing' }))).rejects.toThrow(/not a Project/)
  })

  it('refuses an engine the operator did not enable, and an unknown engine', async () => {
    const { registry } = registryFor({ config: enabled() })
    await expect(registry.start('member:owner', parent, request({ engine: 'claude' }))).rejects.toThrow(/not enabled/)
    await expect(registry.start('member:owner', parent, request({ engine: 'gemini' }))).rejects.toThrow(/not a Worker engine/)
  })

  it('refuses an empty task and a relative directory', async () => {
    const { registry } = registryFor({ config: enabled() })
    await expect(registry.start('member:owner', parent, request({ task: '   ' }))).rejects.toThrow(/task text/)
    await expect(registry.start('member:owner', parent, request({ cwd: 'relative/dir' }))).rejects.toThrow(/absolute working directory/)
  })
})

describe('Worker delegation runs', () => {
  it('starts with parent delivery and reports the execution to the caller', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const run = await registry.start('member:owner', parent, request())
    expect(run.engine).toBe('codex')
    expect(run.state).toBe('running')
    expect(service.providers).toEqual(['team-worker-codex'])
    expect(service.starts).toHaveLength(1)
    const spec = service.starts[0]!
    expect(spec.delivery).toBe('parent')
    expect(spec.provider).toBe('team-worker-codex')
    expect(spec.request.parent).toBe(parent)
    expect(spec.request.cwd).toBe(cwd)
  })

  it('honours an explicit engine over the default', async () => {
    const config = enabled({
      defaultEngine: 'codex',
      engines: {
        codex: { enabled: true, executable: '', sandbox: 'workspace-write' },
        claude: { enabled: true, executable: '', sandbox: '' },
      },
    })
    const { registry, service } = registryFor({ config })
    const run = await registry.start('member:owner', parent, request({ engine: 'claude' }))
    expect(run.engine).toBe('claude')
    expect(service.starts[0]!.provider).toBe('team-worker-claude')
  })

  it('returns the same execution for a resent request instead of starting another', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const first = await registry.start('member:owner', parent, request())
    const second = await registry.start('member:owner', parent, request())
    expect(second.workerRef).toBe(first.workerRef)
    expect(service.starts).toHaveLength(1)
  })

  it('settles the record once the execution ends', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const run = await registry.start('member:owner', parent, request())
    service.settle?.({ output: [{ type: 'text', text: 'the job fails at step 3' }], stopReason: 'completed' })
    await vi.waitFor(() => { expect(registry.get(run.workerRef)?.state).toBe('completed') })
    expect(registry.get(run.workerRef)?.settledAt).toBeDefined()
    // The external child id IS the engine's own session identity.
    expect(registry.get(run.workerRef)?.nativeSessionId).toBe('session:child')
  })

  it('stops one execution and refuses an unknown number', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const run = await registry.start('member:owner', parent, request())
    service.settle?.({ output: [], stopReason: 'aborted' })
    const stopped = await registry.stop(run.workerRef)
    expect(stopped.state).toBe('stopped')
    expect(service.disposals).toBe(1)
    await expect(registry.stop('worker:none' as AgentTeamWorkerRef)).rejects.toThrow(/No Worker/)
  })

  it('refuses new work after unload and releases live executions', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const run = await registry.start('member:owner', parent, request())
    service.settle?.({ output: [], stopReason: 'aborted' })
    await registry.dispose()
    await expect(registry.start('member:owner', parent, request({ requestId: 'request:2' }))).rejects.toThrow(/unloading/)
    expect(registry.get(run.workerRef)?.state).toBe('stopped')
  })
})

describe('the run one delegation opens', () => {
  it('maps the row’s executable path and Codex policy into OAR’s own environment names', () => {
    const config = enabled({
      timeoutMs: 90_000,
      engines: {
        codex: { enabled: true, executable: ' /data/bin/codex ', sandbox: 'read-only' },
        claude: { enabled: true, executable: '/data/bin/claude', sandbox: 'ignored' },
      },
    })
    expect(workerEnvironment('codex', config.engines.codex)).toEqual({
      OAR_CODEX_BIN: '/data/bin/codex', OAR_CODEX_SANDBOX: 'read-only',
    })
    // Claude has no sandbox setting of its own.
    expect(workerEnvironment('claude', config.engines.claude)).toEqual({ OAR_CLAUDE_BIN: '/data/bin/claude' })
    // A blank executable stays out of the environment so the engine finds its own binary.
    expect(workerEnvironment('codex', { enabled: true, executable: '  ', sandbox: 'workspace-write' })).toEqual({
      OAR_CODEX_SANDBOX: 'workspace-write',
    })
    expect(workerRunSpec('codex', config, () => {})).toMatchObject({
      engine: 'codex', env: { OAR_CODEX_BIN: '/data/bin/codex', OAR_CODEX_SANDBOX: 'read-only' }, timeoutMs: 90_000,
    })
    expect(workerRunSpec('codex', { ...config, timeoutMs: 0 }, () => {})).not.toHaveProperty('timeoutMs')
  })
})
