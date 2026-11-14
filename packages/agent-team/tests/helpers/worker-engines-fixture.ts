import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentResult, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type AgentTeam from '../../src/index.ts'
import * as agentTeamInvariant from '../../src/invariant.ts'
import { agentTeamHumanActor } from '../../src/ledger.ts'
import type {
  AgentTeamMemberActor,
  AgentTeamMemberId,
  AgentTeamProjectRef,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
} from '../../src/types.ts'
import { carryWorkerAnchors, WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC, WorkerFailure } from '../../src/worker-runtime.ts'
import { alpha, harness, requestId } from './host-harness.ts'
import { MemoryMediaPool } from './memory-backend.ts'

/** A Host row with delegation allowed on Codex, which is what a Human has to switch on first. */
export const workerRow = () => ({
  worker: {
    enabled: true,
    defaultEngine: 'codex' as const,
    timeoutMs: 0,
    engines: {
      codex: { enabled: true, executable: '', sandbox: 'workspace-write' },
      claude: { enabled: false, executable: '', sandbox: '' },
    },
  },
})

export interface FakeWorker {
  readonly childId: string
  readonly result: PromiseWithResolvers<SubagentResult>
  disposed: boolean
  /** Reject the engine's own disposal, as a process that will not confirm its exit does. */
  disposeFails: boolean
  /** Hold disposal open, as a process that is still shutting down does. */
  disposeHangs: boolean
  /** Let a held disposal finish. */
  readonly release: () => void
}

/** One fake engine service whose starts can be held, cancelled, or cleaned up on demand. */
export interface FakeEngines {
  readonly runtime: SubagentRuntime
  readonly starts: Array<Parameters<SubagentRuntime['startActivation']>[0]>
  readonly workers: Map<string, FakeWorker>
  readonly pending: Map<string, { resolve: (result: SubagentResult) => void }>
  /** `immediate` publishes at once; `cancel-on-abort` behaves like Team's provider; `hold` ignores abort until released. */
  startMode: 'immediate' | 'cancel-on-abort' | 'hold'
  readonly gate: PromiseWithResolvers<void>
  readonly order: string[]
  readonly releases: number
}

export function fakeEngines(): FakeEngines {
  const pending = new Map<string, { resolve: (result: SubagentResult) => void }>()
  const state: FakeEngines = {
    starts: [],
    workers: new Map(),
    pending,
    startMode: 'immediate',
    gate: Promise.withResolvers(),
    order: [],
    releases: 0,
    runtime: undefined as never,
  } as unknown as FakeEngines
  let opened = 0
  const service = {
    registerProvider: () => {
      return () => {
        ;(state as { releases: number }).releases += 1
        state.order.push('release')
      }
    },
    startActivation: async (spec: Parameters<SubagentRuntime['startActivation']>[0]): Promise<SubagentActivation> => {
      state.order.push('start')
      state.starts.push(spec)
      if (state.startMode === 'cancel-on-abort') {
        await new Promise<void>((_resolve, reject) => {
          if (spec.signal.aborted) {
            reject(new WorkerFailure('startup', 'cancelled'))
            return
          }
          spec.signal.addEventListener('abort', () => {
            reject(new WorkerFailure('startup', 'cancelled'))
          }, { once: true })
        })
      }
      if (state.startMode === 'hold') await state.gate.promise
      const childId = `session:worker-${++opened}`
      const result = Promise.withResolvers<SubagentResult>()
      const released = Promise.withResolvers<void>()
      pending.set(childId, { resolve: result.resolve })
      const worker: FakeWorker = {
        childId,
        result,
        disposed: false,
        disposeFails: false,
        disposeHangs: false,
        release: () => { released.resolve() },
      }
      state.workers.set(childId, worker)
      return {
        childId,
        result: result.promise.then(outcome => carryWorkerAnchors(outcome, { nativeSessionId: `native:${childId}` })),
        dispose: async () => {
          worker.disposed = true
          pending.delete(childId)
          state.order.push(`dispose:${childId}`)
          if (worker.disposeHangs) await released.promise
          if (worker.disposeFails) {
            result.resolve({
              output: [{ type: 'text', text: 'partial output' }],
              stopReason: 'error',
              diagnostic: WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC,
            })
            throw new WorkerFailure('dispose', 'unknown')
          }
          result.resolve({ output: [{ type: 'text', text: 'partial output' }], stopReason: 'aborted' })
        },
      } as unknown as SubagentActivation
    },
  }
  return Object.assign(state, { runtime: service as unknown as SubagentRuntime })
}

export interface BootedWorkerHost {
  readonly ctx: Context
  readonly host: AgentTeam
  readonly engines: FakeEngines
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly wakes: UserMessage[]
  readonly stop: () => Promise<void>
}

export async function bootWorkerHost(
  pool: MemoryMediaPool,
  engines: FakeEngines = fakeEngines(),
  options?: { readonly validateLedger?: boolean },
): Promise<BootedWorkerHost> {
  const booted = await harness({
    pool,
    config: workerRow(),
    validateLedger: options?.validateLedger ?? true,
    prepare: async ctx => {
      ctx.provide('subagents', engines.runtime)
      await ctx.plugin(agentTeamInvariant)
    },
  })
  return {
    ctx: booted.ctx,
    host: booted.ctx.agentTeam,
    engines,
    fiber: booted.fiber,
    wakes: [],
    stop: booted.close,
  }
}

export async function addWorkerMember(
  host: BootedWorkerHost,
  projectRef: AgentTeamProjectRef,
  options: { readonly owner: boolean; readonly handle: string },
): Promise<{ readonly actor: AgentTeamMemberActor; readonly agent: Agent; readonly wakes: UserMessage[] }> {
  const memberId = `member:${options.handle}` as AgentTeamMemberId
  const member = {
    memberId,
    sessionId: SessionId(`session:${memberId}`),
    workspaceId: alpha,
    handle: options.handle,
    description: 'Delegates work',
    presetId: 'team-member',
    model: { provider: 'mock', model: 'mock' },
    privateMemoryPath: `/tmp/${options.handle}`,
    state: 'enabled' as const,
  }
  await host.host['ledger']!.addMember({
    requestId: requestId(`member-${options.handle}`),
    actor: agentTeamHumanActor(),
    member,
    handle: options.handle,
    description: 'Delegates work',
    presetId: 'team-member',
    workspaceId: alpha,
    projectRefs: [projectRef],
    model: { provider: 'mock', model: 'mock' },
  })
  if (options.owner) {
    await host.host['ledger']!.addProjectOwner({
      requestId: requestId(`owner-${options.handle}`),
      actor: agentTeamHumanActor(),
      workspaceId: alpha,
      projectRef,
      memberId,
    })
  }
  const wakes: UserMessage[] = []
  const wake = (message: UserMessage): void => { wakes.push(message) }
  const agent = {
    id: SessionId(`session:${memberId}`),
    ctx: host.ctx,
    session: Session.create(SessionId(`session:${memberId}`)),
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [], remove: () => {} },
    steer: wake,
    followup: wake,
  } as unknown as Agent
  host.host['handles'].set(memberId, { agent, dispose: async () => {} })
  return { actor: { kind: 'member', memberId, handle: options.handle }, agent, wakes }
}

export async function createWorkerProject(host: BootedWorkerHost, name = 'delivery'): Promise<AgentTeamProjectRef> {
  const project = await host.host.createProject({
    requestId: requestId('project'),
    workspaceId: alpha,
    name,
    description: `${name} work`,
  })
  return project.project.projectRef
}

export async function startWorkerThread(
  host: BootedWorkerHost,
  projectRef: AgentTeamProjectRef,
  kind: 'discussion' | 'task',
): Promise<{ readonly threadRef: AgentTeamThreadRef; readonly taskRef?: AgentTeamTaskRef }> {
  const result = await host.host.startThread({
    requestId: requestId(`thread-${kind}`),
    workspaceId: alpha,
    projectRef,
    kind,
    body: kind === 'task' ? 'Fix the nightly run' : 'Where does the nightly run fail?',
  })
  if (result.kind !== 'committed') throw new Error('Thread did not commit')
  return { threadRef: result.thread.threadRef, ...(result.task !== undefined ? { taskRef: result.task.taskRef } : {}) }
}
