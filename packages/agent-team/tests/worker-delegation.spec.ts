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
import { carryWorkerAnchors, WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC, type WorkerSteerOutcome } from '../src/worker-runtime.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { AgentTeamMemberActor, AgentTeamMemberId, AgentTeamProjectRef, AgentTeamRequestId,
  AgentTeamWorkerRef, AgentTeamWorkerSettlement, AgentTeamWorkerStartRecord, AgentTeamWorkerSteerAdmission,
  AgentTeamWorkerSteerAdmissionWrite } from '../src/types.ts'
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
  /** Refuse the open, as an engine that cannot start would. */
  failActivation: Error | undefined
  /** Every step either side of the process, in the order it happened. */
  readonly order: string[]
}

function fakeSubagents(): FakeService {
  const state: FakeService = {
    starts: [],
    providers: [],
    settle: undefined,
    disposals: 0,
    failActivation: undefined,
    order: [],
    runtime: undefined as never,
  } as unknown as FakeService
  const service = {
    registerProvider: (provider: { readonly name: string }) => {
      ;(state.providers as string[]).push(provider.name)
      return () => {}
    },
    startActivation: async (spec: Parameters<SubagentRuntime['startActivation']>[0]): Promise<SubagentActivation> => {
      ;(state.order as string[]).push('start-activation')
      if (state.failActivation !== undefined) throw state.failActivation
      ;(state.starts as unknown[]).push(spec)
      const result = Promise.withResolvers<SubagentResult>()
      ;(state as { settle?: (value: SubagentResult) => void }).settle = output => { result.resolve(output) }
      return {
        childId: 'session:child',
        result: result.promise.then(outcome => carryWorkerAnchors(outcome, { nativeSessionId: 'native:child' })),
        // Closing an activation settles its engine: the real service's disposal does the same.
        dispose: async () => {
          ;(state as { disposals: number }).disposals += 1
          result.resolve({ output: [], stopReason: 'aborted' })
        },
      } as unknown as SubagentActivation
    },
  }
  return Object.assign(state, { runtime: service as unknown as SubagentRuntime })
}

/** What the Host would have written to the ledger, in the order it wrote it. */
interface Journal {
  readonly order: string[]
  readonly started: AgentTeamWorkerStartRecord[]
  readonly settled: Omit<AgentTeamWorkerSettlement, 'settledAt'>[]
  /** Reject the opening write, as a ledger that refuses the binding would. */
  failStart: Error | undefined
}

interface SteerFaults {
  failAdmission?: boolean
  failOutcome?: boolean
  admissionGate?: Promise<void>
  outcomeGate?: Promise<void>
  admissionReached?: PromiseWithResolvers<void>
  outcomeReached?: PromiseWithResolvers<void>
}

function registryFor(options: { config: WorkerConfig; owners?: readonly string[]; service?: FakeService; journal?: Journal
  steerFaults?: SteerFaults }): {
  registry: WorkerRegistry
  service: FakeService
  journal: Journal
  steerRequests: Map<AgentTeamRequestId, AgentTeamWorkerSteerAdmission>
} {
  const service = options.service ?? fakeSubagents()
  // One sequence for both sides of the process, so a spec can assert that the
  // record was durable before anything was started.
  const journal = options.journal ?? { order: service.order as string[], started: [], settled: [], failStart: undefined }
  const steerRequests = new Map<AgentTeamRequestId, AgentTeamWorkerSteerAdmission>()
  const quarter = <T>(value: T): T => value
  const ctx = { get: (name: string) => name === 'subagents' ? service.runtime : undefined } as never
  const registry = new WorkerRegistry(ctx, {
    config: () => options.config,
    projectExists: ref => ref === project,
    projectActive: ref => ref === project,
    projectWorkspace: () => 'workspace:1' as never,
    memberEnabled: () => true,
    projectOwners: () => options.owners ?? ['member:owner'],
    recordStarted: async write => {
      if (journal.failStart !== undefined) throw journal.failStart
      const execution = Object.freeze({ ...write.execution, startedAt: '2026-11-09T00:00:00.000Z' })
      ;(journal.started as AgentTeamWorkerStartRecord[]).push(execution)
      journal.order.push('record-started')
      return execution
    },
    recordSettled: async write => {
      ;(journal.settled as Omit<AgentTeamWorkerSettlement, 'settledAt'>[]).push(write.settlement)
      journal.order.push('record-settled')
    },
    recordSteerAdmitted: async (write: AgentTeamWorkerSteerAdmissionWrite) => {
      if (options.steerFaults?.failAdmission === true) throw new Error('admission storage unavailable')
      options.steerFaults?.admissionReached?.resolve()
      await options.steerFaults?.admissionGate
      const prior = steerRequests.get(write.requestId)
      if (prior !== undefined) {
        if (prior.instruction !== write.instruction || prior.workerRef !== write.workerRef
          || prior.initiatedBy !== write.initiatedBy || prior.continuedFrom !== write.continuedFrom
          || prior.aliasOf !== write.aliasOf) throw new Error('request id reused for another steer')
        return prior
      }
      const admission: AgentTeamWorkerSteerAdmission = quarter(Object.freeze({
        kind: 'admitted' as const, requestId: write.requestId, operationId: `operation:${write.requestId}` as never,
        workspaceId: write.workspaceId, workerRef: write.workerRef, instruction: write.instruction,
        initiatedBy: write.initiatedBy, ...(write.continuedFrom === undefined ? {} : { continuedFrom: write.continuedFrom }),
        ...(write.aliasOf === undefined ? {} : { aliasOf: write.aliasOf }),
      }))
      steerRequests.set(write.requestId, admission)
      return admission
    },
    recordSteerRecorded: async ({ admissionRequestId, outcome }) => {
      options.steerFaults?.outcomeReached?.resolve()
      await options.steerFaults?.outcomeGate
      if (options.steerFaults?.failOutcome === true) throw new Error('outcome storage unavailable')
      const admission = steerRequests.get(admissionRequestId)
      if (admission === undefined) throw new Error('steer was not admitted')
      steerRequests.set(admissionRequestId, Object.freeze({ ...admission, outcome }))
    },
    steerRequest: requestId => steerRequests.get(requestId),
    steerOutcome: requestId => {
      const admission = steerRequests.get(requestId)
      return admission?.outcome ?? (admission?.aliasOf === undefined ? undefined : steerRequests.get(admission.aliasOf)?.outcome)
    },
    steerAdmissionsForText: query => [...steerRequests.values()].filter(admission => admission.aliasOf === undefined
      && admission.workerRef === query.workerRef && admission.instruction === query.instruction
      && admission.initiatedBy === query.initiatedBy),
    workerStartedByRequest: () => undefined,
    workerResumeAnchors: () => [],
    warn: () => {},
  })
  return { registry, service, journal, steerRequests }
}

const caller = (memberId = 'member:owner') => ({
  actor: { kind: 'member', memberId: memberId as AgentTeamMemberId, handle: 'handle' } as AgentTeamMemberActor,
  parent,
})

const settledWithin = async (promise: Promise<unknown>, milliseconds = 50): Promise<'settled' | 'pending'> =>
  Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>(resolve => setTimeout(() => { resolve('pending') }, milliseconds)),
  ])

const request = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'request:1' as AgentTeamRequestId,
  workspaceId: 'workspace:1' as Parameters<WorkerRegistry['start']>[1]['workspaceId'],
  projectRef: project,
  task: 'find why the nightly run fails',
  cwd,
  ...overrides,
}) as Parameters<WorkerRegistry['start']>[1]

describe('Worker delegation refusals', () => {
  it('refuses while the setting is off, before any provider exists', async () => {
    const { registry, service } = registryFor({ config: DEFAULT_WORKER_CONFIG })
    await expect(registry.start(caller(), request())).rejects.toThrow(/switched off/)
    expect(service.providers).toEqual([])
    expect(service.starts).toEqual([])
  })

  it('refuses a Member who does not own the Project', async () => {
    const { registry } = registryFor({ config: enabled() })
    await expect(registry.start(caller('member:other'), request())).rejects.toThrow(/owner/)
  })

  it('refuses a Project this Team does not have', async () => {
    const { registry } = registryFor({ config: enabled() })
    await expect(registry.start(caller(), request({ projectRef: 'project:missing' }))).rejects.toThrow(/not a Project/)
  })

  it('refuses an engine the operator did not enable, and an unknown engine', async () => {
    const { registry } = registryFor({ config: enabled() })
    await expect(registry.start(caller(), request({ engine: 'claude' }))).rejects.toThrow(/not enabled/)
    await expect(registry.start(caller(), request({ engine: 'gemini' }))).rejects.toThrow(/not a Worker engine/)
  })

  it('refuses an empty task and a relative directory', async () => {
    const { registry } = registryFor({ config: enabled() })
    await expect(registry.start(caller(), request({ task: '   ' }))).rejects.toThrow(/task text/)
    await expect(registry.start(caller(), request({ cwd: 'relative/dir' }))).rejects.toThrow(/absolute working directory/)
  })
})

describe('Worker delegation runs', () => {
  it('starts with parent delivery and reports the execution to the caller', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
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

  it('runs the default engine when the operator enabled only that one', async () => {
    const config = enabled({
      defaultEngine: 'claude',
      engines: {
        codex: { enabled: false, executable: '', sandbox: 'workspace-write' },
        claude: { enabled: true, executable: '', sandbox: '' },
      },
    })
    const { registry, service } = registryFor({ config })
    const run = await registry.start(caller(), request())
    expect(run.engine).toBe('claude')
    expect(service.starts[0]!.provider).toBe('team-worker-claude')
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
    const run = await registry.start(caller(), request({ engine: 'claude' }))
    expect(run.engine).toBe('claude')
    expect(service.starts[0]!.provider).toBe('team-worker-claude')
  })

  it('returns the same execution for a resent request instead of starting another', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const first = await registry.start(caller(), request())
    const second = await registry.start(caller(), request())
    expect(second.workerRef).toBe(first.workerRef)
    expect(service.starts).toHaveLength(1)
  })

  it('retries an explicitly refused sentence under a fresh request id', async () => {
    const { registry } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
    let calls = 0
    let refuse = true
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => {
      calls += 1
      return refuse
        ? { kind: 'unavailable', code: 'no_active_turn', delivery: 'rejected', reason: 'no active turn' }
        : { kind: 'submitted', inputId, landed: 'steered' }
    })

    await expect(registry.steer(run.workerRef, caller().actor, {
      requestId: 'request:steer-refused' as AgentTeamRequestId,
      instruction: 'one more thing',
    })).rejects.toThrow(/no_active_turn/)
    refuse = false
    await expect(registry.steer(run.workerRef, caller().actor, {
      requestId: 'request:steer-retry' as AgentTeamRequestId,
      instruction: 'one more thing',
    })).resolves.toMatchObject({ state: 'submitted', landed: 'steered' })
    expect(calls).toBe(2)
  })

  it('reserves a fresh request id when same-text dedupe returns an earlier receipt', async () => {
    const { registry } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
    let calls = 0
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => {
      calls += 1
      return { kind: 'submitted', inputId, landed: 'steered' }
    })
    const first = await registry.steer(run.workerRef, caller().actor, {
      requestId: 'request:steer-first' as AgentTeamRequestId, instruction: 'one more thing',
    })
    const aliasId = 'request:steer-alias' as AgentTeamRequestId
    await expect(registry.steer(run.workerRef, caller().actor, {
      requestId: aliasId, instruction: 'one more thing',
    })).resolves.toEqual(first)
    expect(calls).toBe(1)
    await expect(registry.steer(run.workerRef, caller().actor, {
      requestId: aliasId, instruction: 'a different instruction',
    })).rejects.toThrow(/already carried another instruction/)
    expect(calls).toBe(1)
  })

  it('treats a used request id as a conflict for another Member or Worker before authorization', async () => {
    const { registry, steerRequests } = registryFor({ config: enabled() })
    const first = await registry.start(caller(), request())
    const second = await registry.start(caller(), request({ requestId: 'request:second-run' as AgentTeamRequestId }))
    let calls = 0
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => {
      calls += 1
      return { kind: 'submitted', inputId, landed: 'steered' }
    })
    const steerRequest = { requestId: 'request:steer-owned' as AgentTeamRequestId, instruction: 'only once' }
    await registry.steer(first.workerRef, caller().actor, steerRequest)

    await expect(registry.steer(first.workerRef, caller('member:other').actor, steerRequest))
      .rejects.toThrow(/already carried another instruction/u)
    await expect(registry.steer(second.workerRef, caller().actor, steerRequest))
      .rejects.toThrow(/already carried another instruction/u)
    await expect(registry.steer(first.workerRef, caller().actor, { ...steerRequest, instruction: 'changed text' }))
      .rejects.toThrow(/already carried another instruction/u)
    expect(calls).toBe(1)
    expect(steerRequests.size).toBe(1)
  })

  it('treats a concurrent changed instruction under one request id as a conflict', async () => {
    const { registry } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
    let calls = 0
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => {
      calls += 1
      return { kind: 'submitted', inputId, landed: 'steered' }
    })
    const requestId = 'request:steer-concurrent-conflict' as AgentTeamRequestId
    const results = await Promise.allSettled([
      registry.steer(run.workerRef, caller().actor, { requestId, instruction: 'first sentence' }),
      registry.steer(run.workerRef, caller().actor, { requestId, instruction: 'changed sentence' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected).toBeDefined()
    if (rejected?.status === 'rejected') expect(String(rejected.reason)).toMatch(/already carried another instruction/u)
    expect(calls).toBe(1)
  })

  it('joins a canonical steer and a concurrent alias into one native delivery', async () => {
    const { registry } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
    let calls = 0
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => {
      calls += 1
      return { kind: 'submitted', inputId, landed: 'steered', turnId: 'turn-child' }
    })
    const [canonical, alias] = await Promise.all([
      registry.steer(run.workerRef, caller().actor, {
        requestId: 'request:steer-canonical' as AgentTeamRequestId, instruction: 'same sentence',
      }),
      registry.steer(run.workerRef, caller().actor, {
        requestId: 'request:steer-concurrent-alias' as AgentTeamRequestId, instruction: 'same sentence',
      }),
    ])
    expect(alias).toEqual(canonical)
    expect(calls).toBe(1)
    expect(await registry.steer(run.workerRef, caller().actor, {
      requestId: 'request:steer-concurrent-alias' as AgentTeamRequestId, instruction: 'same sentence',
    })).toEqual(canonical)
    expect(calls).toBe(1)
  })

  it('replays an explicit refusal but treats an admitted outcome that never landed as unconfirmed', async () => {
    const { registry, steerRequests } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
    let calls = 0
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => {
      calls += 1
      return calls === 1
        ? { kind: 'unavailable', code: 'no_active_turn', delivery: 'rejected', reason: 'no active turn' }
        : { kind: 'submitted', inputId, landed: 'steered' }
    })
    const refused = { requestId: 'request:steer-refusal' as AgentTeamRequestId, instruction: 'refused sentence' }
    await expect(registry.steer(run.workerRef, caller().actor, refused)).rejects.toThrow(/no_active_turn/)
    await expect(registry.steer(run.workerRef, caller().actor, refused)).rejects.toThrow(/no_active_turn/)
    expect(calls).toBe(1)
    await expect(registry.steer(run.workerRef, caller().actor, {
      requestId: 'request:steer-after-refusal' as AgentTeamRequestId, instruction: refused.instruction,
    })).resolves.toMatchObject({ state: 'submitted' })
    expect(calls).toBe(2)

    const admittedAt = 'request:steer-admitted-without-outcome' as AgentTeamRequestId
    steerRequests.set(admittedAt, Object.freeze({
      kind: 'admitted' as const,
      requestId: admittedAt,
      operationId: 'operation:steer-admitted-without-outcome' as never,
      workspaceId: 'workspace:1' as never,
      workerRef: run.workerRef,
      instruction: 'admitted without an outcome',
      initiatedBy: 'member:owner' as AgentTeamMemberId,
    }))
    await expect(registry.steer(run.workerRef, caller().actor, {
      requestId: admittedAt, instruction: 'admitted without an outcome',
    })).rejects.toThrow(/admitted, but no steer outcome/u)
    await expect(registry.steer(run.workerRef, caller().actor, {
      requestId: 'request:steer-alias-to-unconfirmed' as AgentTeamRequestId,
      instruction: 'admitted without an outcome',
    })).rejects.toThrow(/now aliases steer/u)
    expect(calls).toBe(2)
  })

  it('fails an admission before reaching the engine when its durable write fails', async () => {
    const { registry } = registryFor({ config: enabled(), steerFaults: { failAdmission: true } })
    const run = await registry.start(caller(), request())
    let calls = 0
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => {
      calls += 1
      return { kind: 'submitted', inputId, landed: 'steered' }
    })
    await expect(registry.steer(run.workerRef, caller().actor, {
      requestId: 'request:steer-admission-fails' as AgentTeamRequestId, instruction: 'do not send',
    })).rejects.toThrow(/could not be admitted durably/)
    expect(calls).toBe(0)
  })

  it('never claims success when a delivered steer outcome cannot be stored', async () => {
    const { registry } = registryFor({ config: enabled(), steerFaults: { failOutcome: true } })
    const run = await registry.start(caller(), request())
    let calls = 0
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => {
      calls += 1
      return { kind: 'submitted', inputId, landed: 'steered' }
    })
    const steer = { requestId: 'request:steer-outcome-fails' as AgentTeamRequestId, instruction: 'one more thing' }
    await expect(registry.steer(run.workerRef, caller().actor, steer)).rejects.toThrow(/could not be recorded/)
    expect(calls).toBe(1)
    await expect(registry.steer(run.workerRef, caller().actor, steer)).rejects.toThrow(/admitted.*no steer outcome/)
    expect(calls).toBe(1)
  })

  it('waits for an in-flight admission before unloading and never sends after it returns', async () => {
    const admissionGate = Promise.withResolvers<void>()
    const admissionReached = Promise.withResolvers<void>()
    const { registry } = registryFor({
      config: enabled(),
      steerFaults: { admissionGate: admissionGate.promise, admissionReached },
    })
    const run = await registry.start(caller(), request())
    let calls = 0
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => {
      calls += 1
      return { kind: 'submitted', inputId, landed: 'steered' }
    })
    const steered = registry.steer(run.workerRef, caller().actor, {
      requestId: 'request:steer-admission-unload' as AgentTeamRequestId,
      instruction: 'do not send during unload',
    })
    void steered.catch(() => {})
    await admissionReached.promise

    const disposing = registry.dispose()
    expect(await settledWithin(disposing)).toBe('pending')
    admissionGate.resolve()
    await expect(steered).rejects.toThrow(/unloading|nothing was delivered/u)
    await disposing
    expect(calls).toBe(0)
  })

  it('waits for an in-flight outcome write before unloading closes storage', async () => {
    const outcomeGate = Promise.withResolvers<void>()
    const outcomeReached = Promise.withResolvers<void>()
    const { registry } = registryFor({
      config: enabled(),
      steerFaults: { outcomeGate: outcomeGate.promise, outcomeReached },
    })
    const run = await registry.start(caller(), request())
    let calls = 0
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => {
      calls += 1
      return { kind: 'submitted', inputId, landed: 'steered' }
    })
    const steered = registry.steer(run.workerRef, caller().actor, {
      requestId: 'request:steer-outcome-unload' as AgentTeamRequestId,
      instruction: 'finish the admitted write',
    })
    await outcomeReached.promise

    const disposing = registry.dispose()
    expect(await settledWithin(disposing)).toBe('pending')
    outcomeGate.resolve()
    await expect(steered).resolves.toMatchObject({ state: 'submitted' })
    await disposing
    expect(calls).toBe(1)
  })

  it('refuses a late alias admission instead of writing after unloading closes persistence', async () => {
    const { registry, steerRequests } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
    const sessions = (registry as unknown as { readonly sessions: Map<unknown,
      ((instruction: string, inputId: string) => Promise<WorkerSteerOutcome>) | undefined> }).sessions
    sessions.set('session:child', async (_instruction, inputId) => ({ kind: 'submitted', inputId, landed: 'steered' }))
    await registry.steer(run.workerRef, caller().actor, {
      requestId: 'request:steer-before-unload' as AgentTeamRequestId, instruction: 'finish before unload',
    })
    await registry.dispose()
    const admitted = steerRequests.size

    await expect(registry.steerTextAlias(caller().actor, {
      requestId: 'request:steer-after-unload' as AgentTeamRequestId, instruction: 'finish before unload',
    }, { workerRef: run.workerRef, initiatedBy: 'member:owner' as AgentTeamMemberId,
      continuedFrom: run.workerRef, allowSubmitted: true }))
      .rejects.toThrow(/began unloading before the steer could be admitted durably/u)
    expect(steerRequests.size).toBe(admitted)
  })

  it('opens one execution when a request id arrives twice at once', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const [first, second] = await Promise.all([registry.start(caller(), request()), registry.start(caller(), request())])
    expect(second.workerRef).toBe(first.workerRef)
    expect(service.starts).toHaveLength(1)
    expect(registry.list()).toHaveLength(1)
  })

  it('refuses a request id reused by another Member or for a different task', async () => {
    const { registry, service } = registryFor({ config: enabled(), owners: ['member:owner', 'member:other'] })
    const run = await registry.start(caller(), request())
    // Another Member's identical delegation never inherits this run.
    await expect(registry.start(caller('member:other'), request())).rejects.toThrow(/another delegation/)
    // Neither does a changed task under the same id.
    await expect(registry.start(caller(), request({ task: 'and then do something else' }))).rejects.toThrow(/another delegation/)
    // The admitted run is untouched by either refusal.
    expect(service.starts).toHaveLength(1)
    expect(registry.get(run.workerRef)?.state).toBe('running')
  })

  it('settles the record once the execution ends', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
    service.settle?.({ output: [{ type: 'text', text: 'the job fails at step 3' }], stopReason: 'completed' })
    await vi.waitFor(() => { expect(registry.get(run.workerRef)?.state).toBe('completed') })
    expect(registry.get(run.workerRef)?.settledAt).toBeDefined()
    // The external activation id and native conversation id are separate.
    expect(registry.get(run.workerRef)?.nativeSessionId).toBe('native:child')
  })

  it('stops one execution and refuses an unknown number', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
    const stopped = await registry.stop(run.workerRef, caller().actor)
    expect(stopped.state).toBe('stopped')
    expect(service.disposals).toBe(1)
    await expect(registry.stop('worker:none' as AgentTeamWorkerRef, caller().actor)).rejects.toThrow(/No Worker/)
  })

  it('refuses new work after unload and releases live executions', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
    service.settle?.({ output: [], stopReason: 'aborted' })
    await registry.dispose()
    await expect(registry.start(caller(), request({ requestId: 'request:2' }))).rejects.toThrow(/unloading/)
    expect(registry.get(run.workerRef)?.state).toBe('stopped')
  })
})

describe('the record a bound run keeps', () => {
  const bound = { threadRef: 'thread:00000000-0000-4000-8000-000000000002', taskRef: 'task:00000000-0000-4000-8000-000000000003' }

  it('writes the opening record before the engine process exists', async () => {
    const { registry, journal } = registryFor({ config: enabled() })
    await registry.start(caller(), request(bound))
    expect(journal.started).toHaveLength(1)
    expect(journal.order).toEqual(['record-started', 'start-activation'])
  })

  it('binds the target into the record and keeps the parent session out of the result', async () => {
    const { registry, service, journal } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request(bound))
    expect(journal.started[0]).toMatchObject({ threadRef: bound.threadRef, taskRef: bound.taskRef,
      initiatedBy: 'member:owner', projectRef: project, task: 'find why the nightly run fails', cwd })
    expect(service.starts[0]!.delivery).toBe('caller')
    expect(run.threadRef).toBe(bound.threadRef)
  })

  it('leaves an unbound Project delegation on the parent result with no public fact', async () => {
    const { registry, service, journal } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request())
    expect(journal.started[0]?.threadRef).toBeUndefined()
    expect(service.starts[0]!.delivery).toBe('parent')
    expect(run.threadRef).toBeUndefined()
  })

  it('records the answer as the private half of the one terminal write', async () => {
    const { registry, service, journal } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request(bound))
    service.settle?.({ output: [{ type: 'text', text: 'the job fails at step 3' }], stopReason: 'completed' })
    await vi.waitFor(() => { expect(journal.settled).toHaveLength(1) })
    expect(journal.settled[0]).toMatchObject({ workerRef: run.workerRef, state: 'completed', output: 'the job fails at step 3' })
  })

  it('keeps the text a failed run produced, and the failure that ended it', async () => {
    const { registry, service, journal } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request(bound))
    service.settle?.({ output: [{ type: 'text', text: 'patched the parser, not the date' }],
      stopReason: 'error', diagnostic: 'the engine exited before answering' })
    await vi.waitFor(() => { expect(journal.settled).toHaveLength(1) })
    // A bound run suppressed the parent's copy, so this text exists nowhere else.
    expect(journal.settled[0]).toMatchObject({ workerRef: run.workerRef, state: 'failed',
      output: 'patched the parser, not the date', diagnostic: 'the engine exited before answering' })
  })

  it('keeps the text a stopped run produced', async () => {
    const { registry, service, journal } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request(bound))
    service.settle?.({ output: [{ type: 'text', text: 'half a plan' }], stopReason: 'aborted' })
    await vi.waitFor(() => { expect(journal.settled).toHaveLength(1) })
    expect(journal.settled[0]).toMatchObject({ workerRef: run.workerRef, state: 'stopped', output: 'half a plan' })
    expect(journal.settled[0]?.diagnostic).toBeUndefined()
  })

  it.each([
    ['a bound run', bound],
    ['a Project-only run', {}],
  ])('keeps timeout, partial output, and unconfirmed cleanup in one ending for %s', async (_label, target) => {
    const { registry, service, journal } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request(target))
    service.settle?.({
      output: [{ type: 'text', text: 'work before the deadline' }],
      stopReason: 'error',
      diagnostic: `The Worker exceeded its execution timeout. ${WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC}`,
    })
    await vi.waitFor(() => { expect(journal.settled).toHaveLength(1) })
    expect(journal.settled[0]).toMatchObject({
      workerRef: run.workerRef,
      state: 'failed',
      stage: 'dispose',
      output: 'work before the deadline',
      diagnostic: expect.stringContaining('exceeded its execution timeout'),
    })
    expect(journal.settled[0]?.diagnostic).toContain('engine may still be active')
  })

  it('records the ending of a run that could not start, before the refusal reaches the caller', async () => {
    const service = fakeSubagents()
    service.failActivation = new Error('spawn /nonexistent/codex ENOENT')
    const { registry, journal } = registryFor({ config: enabled(), service })
    await expect(registry.start(caller(), request(bound))).rejects.toThrow(/ENOENT/)
    expect(journal.started).toHaveLength(1)
    expect(journal.settled[0]).toMatchObject({ state: 'failed' })
    expect(registry.isLive(journal.started[0]!.workerRef)).toBe(false)
  })

  it('starts nothing when the ledger refuses the opening binding', async () => {
    const journal: Journal = { order: [], started: [], settled: [], failStart: new Error('only a current owner may delegate a Worker') }
    const { registry, service } = registryFor({ config: enabled(), journal })
    await expect(registry.start(caller(), request(bound))).rejects.toThrow(/owner/)
    expect(service.starts).toEqual([])
    expect(journal.settled).toEqual([])
  })

  it('reports a run as live only while this Host holds it', async () => {
    const { registry, service } = registryFor({ config: enabled() })
    const run = await registry.start(caller(), request(bound))
    expect(registry.isLive(run.workerRef)).toBe(true)
    service.settle?.({ output: [], stopReason: 'completed' })
    await vi.waitFor(() => { expect(registry.isLive(run.workerRef)).toBe(false) })
    // A ref no Host holds is not live: a rebuilt Host reads it as unconfirmed.
    expect(registry.isLive('worker:00000000-0000-4000-8000-000000000009' as AgentTeamWorkerRef)).toBe(false)
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
