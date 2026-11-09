/**
 * Stopping one Worker execution through the Host: who may ask, what the startup
 * race does, how a natural ending wins, what a cleanup failure is allowed to
 * report, and the order a released Host follows.
 *
 * The Harness subagent service is faked here because the cases are about the
 * decisions Team owns. The Harness contract this fake copies — teardown runs
 * first, and the parent is then told the result captured before it, which a
 * teardown failure never edits — is pinned against the real service in
 * `worker-stop-notice.spec.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivation, SubagentResult, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { provideQuietTokenMeter } from './helpers/team-host-fixture.ts'
import AgentTeam from '../src/index.ts'
import type { Config } from '../src/host-row-settings.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import { WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC, WorkerFailure } from '../src/worker-runtime.ts'
import type { AgentTeamMemberActor, AgentTeamMemberId, AgentTeamProjectRef, AgentTeamRequestId,
  AgentTeamTaskRef, AgentTeamThreadRef, AgentTeamWorkerRef } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const cleanups: Array<() => Promise<void>> = []
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

/** A Host row with delegation allowed on Codex, which is what a Human has to switch on first. */
const workerRow = (): Config => ({ worker: { enabled: true, defaultEngine: 'codex' as const, timeoutMs: 0,
  engines: { codex: { enabled: true, executable: '', sandbox: 'workspace-write' },
    claude: { enabled: false, executable: '', sandbox: '' } } } }) as unknown as Config

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

interface FakeWorker {
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
interface FakeEngines {
  readonly runtime: SubagentRuntime
  readonly starts: Array<Parameters<SubagentRuntime['startActivation']>[0]>
  readonly workers: Map<string, FakeWorker>
  /** `immediate` publishes at once; `cancel-on-abort` behaves like Team's provider; `hold` ignores abort until released. */
  startMode: 'immediate' | 'cancel-on-abort' | 'hold'
  readonly gate: PromiseWithResolvers<void>
  readonly order: string[]
  readonly releases: number
}

function fakeEngines(): FakeEngines {
  const state: FakeEngines = {
    starts: [], workers: new Map(), startMode: 'immediate', gate: Promise.withResolvers(), order: [], releases: 0,
    runtime: undefined as never,
  } as unknown as FakeEngines
  let opened = 0
  const service = {
    registerProvider: () => {
      return () => { (state as { releases: number }).releases += 1; state.order.push('release') }
    },
    startActivation: async (spec: Parameters<SubagentRuntime['startActivation']>[0]): Promise<SubagentActivation> => {
      state.order.push('start')
      state.starts.push(spec)
      if (state.startMode === 'cancel-on-abort') {
        // Team's provider: a stop during startup disposes its partial resources
        // and rejects with the cancellation the run records as its ending.
        await new Promise<void>((_resolve, reject) => {
          if (spec.signal.aborted) { reject(new WorkerFailure('startup', 'cancelled')); return }
          spec.signal.addEventListener('abort', () => { reject(new WorkerFailure('startup', 'cancelled')) }, { once: true })
        })
      }
      if (state.startMode === 'hold') await state.gate.promise
      const childId = `session:worker-${++opened}`
      const result = Promise.withResolvers<SubagentResult>()
      const released = Promise.withResolvers<void>()
      const worker: FakeWorker = { childId, result, disposed: false, disposeFails: false, disposeHangs: false,
        release: () => { released.resolve() } }
      state.workers.set(childId, worker)
      return {
        childId,
        result: result.promise,
        dispose: async () => {
          worker.disposed = true
          state.order.push(`dispose:${childId}`)
          if (worker.disposeHangs) await released.promise
          if (worker.disposeFails) {
            // What Team's provider hands the Harness: the one result the parent
            // will be told carries the cleanup verdict and the output so far.
            result.resolve({ output: [{ type: 'text', text: 'partial output' }], stopReason: 'error',
              diagnostic: WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC })
            throw new WorkerFailure('dispose', 'unknown')
          }
          result.resolve({ output: [{ type: 'text', text: 'partial output' }], stopReason: 'aborted' })
        },
      } as unknown as SubagentActivation
    },
  }
  return Object.assign(state, { runtime: service as unknown as SubagentRuntime })
}

interface BootedHost {
  readonly ctx: Context
  readonly host: AgentTeam
  readonly engines: FakeEngines
  readonly fiber: { dispose: () => Promise<void> }
  readonly stop: () => Promise<void>
}

/** Boot the Team plugin over the given storage pool; booting twice is how a restart reads the same ledger. */
async function boot(pool: MemoryMediaPool, engines: FakeEngines = fakeEngines()): Promise<BootedHost> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('subagents', engines.runtime)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === alpha ? { id, path: process.cwd(), attachSession: async () => {}, archiveSession: async () => {} } : undefined,
    list: () => [{ id: alpha, path: process.cwd() }],
    archiveSession: async () => {},
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  provideQuietTokenMeter(ctx)
  await ctx.plugin(agentTeamInvariant)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam, workerRow())
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await fiber.dispose()
    await facility.closeAll()
  }
  cleanups.push(stop)
  return { ctx, host: ctx.agentTeam, engines, fiber, stop }
}

/** One durable Member of the Project, plus the live Agent surface its wake touches. */
async function addMember(host: BootedHost, projectRef: AgentTeamProjectRef, options: {
  readonly owner: boolean
  readonly handle: string
}): Promise<{ readonly actor: AgentTeamMemberActor; readonly agent: Agent; readonly wakes: UserMessage[] }> {
  const memberId = `member:${options.handle}` as AgentTeamMemberId
  const member = { memberId, sessionId: SessionId(`session:${memberId}`), workspaceId: alpha, handle: options.handle,
    description: 'Delegates work', presetId: 'team-member', model: { provider: 'mock', model: 'mock' },
    privateMemoryPath: `/tmp/${options.handle}`, state: 'enabled' as const }
  await host.host['ledger']!.addMember({ requestId: requestId(`member-${options.handle}`), actor: agentTeamHumanActor(),
    member, handle: options.handle, description: 'Delegates work', presetId: 'team-member', workspaceId: alpha,
    projectRefs: [projectRef], model: { provider: 'mock', model: 'mock' } })
  if (options.owner) {
    await host.host['ledger']!.addProjectOwner({ requestId: requestId(`owner-${options.handle}`), actor: agentTeamHumanActor(),
      workspaceId: alpha, projectRef, memberId })
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

async function createProject(host: BootedHost): Promise<AgentTeamProjectRef> {
  const project = await host.host.createProject({ requestId: requestId('project'), workspaceId: alpha,
    name: 'stop', description: 'Stop' })
  return project.project.projectRef
}

async function startThread(host: BootedHost, projectRef: AgentTeamProjectRef, kind: 'discussion' | 'task'):
  Promise<{ readonly threadRef: AgentTeamThreadRef; readonly taskRef?: AgentTeamTaskRef }> {
  const result = await host.host.startThread({ requestId: requestId(`thread-${kind}-${Math.random()}`), workspaceId: alpha, projectRef,
    kind, body: kind === 'task' ? 'Fix the nightly run' : 'Where does the nightly run fail?' })
  if (result.kind !== 'committed') throw new Error('Thread did not commit')
  return { threadRef: result.thread.threadRef, ...(result.task === undefined ? {} : { taskRef: result.task.taskRef }) }
}

/** Wait until the opening record exists, so a stop can address a start that has not returned. */
async function waitForStart(host: BootedHost, count = 1): Promise<void> {
  await vi.waitFor(() => { expect(host.engines.starts).toHaveLength(count) })
}

/** Wait until the ledger holds the ending this run recorded, not just the live view. */
async function waitRecorded(host: BootedHost, workerRef: string, state: string): Promise<void> {
  await vi.waitFor(() => {
    expect(host.host['ledger']!.workerRunState(workerRef as never)).toBe(state)
  })
}

const workerRefOf = (host: BootedHost, memberId: AgentTeamMemberId): AgentTeamWorkerRef => {
  const execution = host.host['ledger']!.workerExecutionsOfMember(memberId)[0]
  if (execution === undefined) throw new Error('no recorded run')
  return execution.workerRef
}

describe('stopping one run leaves its siblings alone', () => {
  it('stops the named run of two in flight and settles each in its own Thread', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const first = await startThread(host, projectRef, 'discussion')
    const second = await startThread(host, projectRef, 'task')
    const runA = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run-a'),
      threadRef: first.threadRef, task: 'check the schedule', cwd: process.cwd() })
    const runB = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run-b'),
      taskRef: second.taskRef!, task: 'fix the schedule', cwd: process.cwd() })

    const stopped = await host.host.workerStopForAgent(owner.agent, { workerRef: runA.workerRef })
    expect(stopped.state).toBe('stopped')
    // The sibling is untouched and still live.
    expect(host.host['workerRegistry']!.liveState(runB.workerRef)).toBe('running')
    // In the other direction: the second run ends naturally.
    host.engines.workers.get('session:worker-2')!.result.resolve({ output: [{ type: 'text', text: 'fixed' }], stopReason: 'completed' })
    await waitRecorded(host, runB.workerRef, 'completed')

    const readA = await host.host.readThread({ requestId: requestId('read-a'), workspaceId: alpha, threadRef: first.threadRef })
    const readB = await host.host.readThread({ requestId: requestId('read-b'), workspaceId: alpha, taskRef: second.taskRef! })
    const factKinds = (read: Awaited<ReturnType<AgentTeam['readThread']>>) => read.facts
      .flatMap(entry => entry.fact.kind === 'activity' && (entry.fact.activity.kind === 'worker_started'
        || entry.fact.activity.kind === 'worker_settled') ? [entry.fact.activity.kind] : [])
    expect(factKinds(readA)).toEqual(['worker_started', 'worker_settled'])
    expect(factKinds(readB)).toEqual(['worker_started', 'worker_settled'])
    expect(readA.workerStates).toEqual([{ workerRef: runA.workerRef, state: 'stopped', unconfirmed: false }])
    expect(readB.workerStates).toEqual([{ workerRef: runB.workerRef, state: 'completed', unconfirmed: false }])
    // The stopped run's partial output is private: it reaches its initiator's
    // Inbox, not the Thread every member reads.
    expect(JSON.stringify(readA)).not.toContain('partial output')
    expect(JSON.stringify(owner.wakes.at(-1))).toContain('partial output')
  })

  it('lets only the initiating Member and the Human stop a run', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const plain = await addMember(host, projectRef, { owner: false, handle: 'plain' })
    const thread = await startThread(host, projectRef, 'discussion')
    const run = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })

    await expect(host.host.workerStopForAgent(plain.agent, { workerRef: run.workerRef }))
      .rejects.toThrow(/Only the Member who delegated/)
    // The refusal reached nothing: the run is still live.
    expect(host.host['workerRegistry']!.liveState(run.workerRef)).toBe('running')
    // The Human stops from the edit surface, addressed to the initiating Member.
    const stopped = await host.host.stopWorkerForClient({ workspaceId: alpha, workerRef: run.workerRef, memberId: owner.actor.memberId })
    expect(stopped).toMatchObject({ kind: 'ended', state: 'stopped' })
    // Another Member's edit surface cannot address it.
    const second = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run-2'),
      threadRef: thread.threadRef, task: 'check again', cwd: process.cwd() })
    await expect(host.host.stopWorkerForClient({ workspaceId: alpha, workerRef: second.workerRef, memberId: plain.actor.memberId }))
      .rejects.toThrow(/delegated by another Member/)
  })

  it('stops a run after the switch was turned off, because that switch gates starting', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const run = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    // The Human turns delegation off while the run is in flight. The Host row is
    // a live volatile, so a stop that re-read it would see the switch off.
    const config = host.host['config'] as unknown as { worker: unknown }
    const reads: string[] = []
    config.worker = { get: () => {
      reads.push('read')
      return { enabled: false, defaultEngine: 'codex', timeoutMs: 0, engines: {
        codex: { enabled: false, executable: '', sandbox: 'workspace-write' },
        claude: { enabled: false, executable: '', sandbox: '' } } }
    } }
    const stopped = await host.host.workerStopForAgent(owner.agent, { workerRef: run.workerRef })
    expect(stopped.state).toBe('stopped')
    // Starting is what the switch decides; a stop never asks it.
    expect(reads).toEqual([])
    // The switch really is off for the next delegation, so the stop above ran
    // with it off rather than before it took effect.
    await expect(host.host.workerStartForAgent(owner.agent, { requestId: requestId('after'), threadRef: thread.threadRef,
      task: 'check again', cwd: process.cwd() })).rejects.toThrow(/switched off/)
  })

  it('answers the Human with the ending, or with a cleanup still in flight, never a bare refusal', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const run = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    host.engines.workers.get('session:worker-1')!.result.resolve({ output: [{ type: 'text', text: 'finished first' }], stopReason: 'completed' })
    await waitRecorded(host, run.workerRef, 'completed')
    // An execution that ended first answers with its own ending.
    expect(await host.host.stopWorkerForClient({ workspaceId: alpha, workerRef: run.workerRef, memberId: owner.actor.memberId }))
      .toMatchObject({ kind: 'ended', state: 'completed' })

    // A stop whose cleanup outlasts the deadline is still in flight, not failed.
    const second = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run-2'),
      threadRef: thread.threadRef, task: 'check again', cwd: process.cwd() })
    const worker = host.engines.workers.get('session:worker-2')!
    worker.disposeHangs = true
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const stopping = host.host.stopWorkerForClient({ workspaceId: alpha, workerRef: second.workerRef, memberId: owner.actor.memberId })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await stopping).toMatchObject({ kind: 'pending', workerRef: second.workerRef })
    vi.useRealTimers()
    // The cleanup then finishes, and the next read of the same run reports the
    // ending the engine confirmed.
    worker.release()
    await waitRecorded(host, second.workerRef, 'stopped')
    expect(await host.host.stopWorkerForClient({ workspaceId: alpha, workerRef: second.workerRef, memberId: owner.actor.memberId }))
      .toMatchObject({ kind: 'ended', state: 'stopped' })
  })

  it('reports an execution that ended first with the state it really ended in', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const run = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    host.engines.workers.get('session:worker-1')!.result.resolve({ output: [{ type: 'text', text: 'finished first' }], stopReason: 'completed' })
    await waitRecorded(host, run.workerRef, 'completed')
    const answered = await host.host.workerStopForAgent(owner.agent, { workerRef: run.workerRef })
    expect(answered.state).toBe('completed')
    const history = host.host.threadHistory({ workspaceId: alpha, threadRef: thread.threadRef })
    expect(history.facts.filter(entry => entry.kind === 'activity' && entry.activity.kind === 'worker_settled')).toHaveLength(1)
  })
})

describe('a stop that meets the startup race', () => {
  it('cancels a start that has not published and records its one ending', async () => {
    const host = await boot(new MemoryMediaPool())
    host.engines.startMode = 'cancel-on-abort'
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const starting = host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    await waitForStart(host)
    const workerRef = workerRefOf(host, owner.actor.memberId)
    const stopped = await host.host.workerStopForAgent(owner.agent, { workerRef })
    expect(stopped.state).toBe('stopped')
    // The start call answers with the run its stop recorded instead of an error.
    expect((await starting).state).toBe('stopped')
    await waitRecorded(host, workerRef, 'stopped')
    const read = await host.host.readThread({ requestId: requestId('read'), workspaceId: alpha, threadRef: thread.threadRef })
    expect(read.facts.filter(entry => entry.fact.kind === 'activity' && entry.fact.activity.kind === 'worker_settled')).toHaveLength(1)
  })

  it('disposes a native session that opens after the stop was requested, and still records once', async () => {
    const host = await boot(new MemoryMediaPool())
    host.engines.startMode = 'hold'
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const starting = host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    await waitForStart(host)
    const workerRef = workerRefOf(host, owner.actor.memberId)
    const stopping = host.host.workerStopForAgent(owner.agent, { workerRef })
    // The engine ignores the abort and publishes late: its handle must be disposed
    // before the run is confirmed stopped, not leaked.
    host.engines.gate.resolve()
    const run = await starting
    expect(run.state).toBe('running')
    const stopped = await stopping
    expect(stopped.state).toBe('stopped')
    expect(host.engines.workers.size).toBe(1)
    expect([...host.engines.workers.values()][0]!.disposed).toBe(true)
    await waitRecorded(host, workerRef, 'stopped')
    const read = await host.host.readThread({ requestId: requestId('read'), workspaceId: alpha, threadRef: thread.threadRef })
    expect(read.facts.filter(entry => entry.fact.kind === 'activity' && entry.fact.activity.kind === 'worker_settled')).toHaveLength(1)
  })
})

describe('a stop that cannot confirm its cleanup', () => {
  it('records the existing failure state with the unconfirmed reason and never calls it stopped', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const run = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    host.engines.workers.get('session:worker-1')!.disposeFails = true

    await expect(host.host.workerStopForAgent(owner.agent, { workerRef: run.workerRef }))
      .rejects.toThrow(/did not confirm its cleanup/)
    // The durable record is the existing failure state, not a second store.
    await waitRecorded(host, run.workerRef, 'failed')
    const read = await host.host.readThread({ requestId: requestId('read'), workspaceId: alpha, threadRef: thread.threadRef })
    const settled = read.facts.flatMap(entry => entry.fact.kind === 'activity' && entry.fact.activity.kind === 'worker_settled'
      ? [entry.fact.activity] : [])[0]!
    expect(settled).toMatchObject({ state: 'failed' })
    expect(settled.reason).toMatch(/did not confirm|may still be active/u)
    // The human surface reports the same conclusion, not a shorter list.
    const listed = host.host.workerRunsForClient({ workspaceId: alpha, memberId: owner.actor.memberId })
    expect(listed.runs).toEqual([])
    // A stop that arrives after the ending answers with the ending and the
    // Host's own sentence, not a refusal and not a bare state.
    expect(await host.host.stopWorkerForClient({ workspaceId: alpha, workerRef: run.workerRef, memberId: owner.actor.memberId }))
      .toEqual({ kind: 'ended', workerRef: run.workerRef, state: 'failed', settledAt: expect.any(String) as string,
        diagnostic: expect.stringMatching(/may still be active/u) as unknown as string })
  })
})

describe('a Project-only delegation', () => {
  it('stops without a public fact and keeps its record private', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const run = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: process.cwd() })
    expect(host.engines.starts[0]!.delivery).toBe('parent')
    const stopped = await host.host.workerStopForAgent(owner.agent, { workerRef: run.workerRef })
    expect(stopped.state).toBe('stopped')
    await waitRecorded(host, run.workerRef, 'stopped')
    expect(host.host.workerRunsForClient({ workspaceId: alpha, memberId: owner.actor.memberId }).runs).toEqual([])
  })
})

describe('a Host that no longer holds the run', () => {
  it('lists it as unconfirmed and refuses to stop what it cannot address', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    // What a Host that died mid-run leaves behind: the opening record, no handle.
    const workerRef = 'worker:from-a-previous-host' as AgentTeamWorkerRef
    await host.host['ledger']!.recordWorkerStarted({ requestId: requestId('crashed'), actor: owner.actor, workspaceId: alpha,
      execution: { workerRef, projectRef, threadRef: thread.threadRef, initiatedBy: owner.actor.memberId, engine: 'codex',
        task: 'check the schedule', cwd: process.cwd() } })

    await expect(host.host.workerStopForAgent(owner.agent, { workerRef })).rejects.toThrow(/no longer holds its handle/)
    // The Human's surface is told the same thing as a fact it can render, not
    // as a sentence it would have to read a state out of.
    expect(await host.host.stopWorkerForClient({ workspaceId: alpha, workerRef, memberId: owner.actor.memberId }))
      .toMatchObject({ kind: 'unconfirmed', workerRef, message: expect.stringMatching(/no longer holds its handle/u) as unknown as string })
    // Nothing was replayed into this Host.
    expect(host.engines.starts).toEqual([])
  })
})

describe('releasing the Host', () => {
  it('stops what it holds, records the endings, and releases providers after them', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const run = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    await host.stop()
    expect([...host.engines.workers.values()][0]!.disposed).toBe(true)
    expect(host.host['ledger']!.workerRunState(run.workerRef)).toBe('stopped')
    // The terminal fact landed before the provider it came through was released.
    const disposeAt = host.engines.order.lastIndexOf('dispose:session:worker-1')
    const releaseAt = host.engines.order.indexOf('release')
    expect(disposeAt).toBeGreaterThanOrEqual(0)
    expect(releaseAt).toBeGreaterThan(disposeAt)
  })

  it('covers a start still writing its opening record when the release begins', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const ledger = host.host['ledger']!
    const writeStarted = Promise.withResolvers<void>()
    const writeGate = Promise.withResolvers<void>()
    const record = ledger.recordWorkerStarted.bind(ledger)
    // Hold the opening write: the release begins before this run has an entry.
    ledger.recordWorkerStarted = async (request) => {
      writeStarted.resolve()
      await writeGate.promise
      return record(request)
    }
    const starting = host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    await writeStarted.promise
    const releasing = host.fiber.dispose()
    // The write lands while the release is waiting for starts to open.
    writeGate.resolve()
    await releasing
    await expect(starting).rejects.toThrow(/released this Worker before it opened its engine/)
    // No engine opened, and the record a later Host reads stays unconfirmed.
    expect(host.engines.starts).toEqual([])
    expect(host.engines.order).toContain('release')
    expect(ledger.workerExecutionsOfMember(owner.actor.memberId).map(execution => execution.state))
      .toEqual(['running'])
  })

  it('seals a start whose opening record lands after the release deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const ledger = host.host['ledger']!
    const writeStarted = Promise.withResolvers<void>()
    const writeGate = Promise.withResolvers<void>()
    const record = ledger.recordWorkerStarted.bind(ledger)
    ledger.recordWorkerStarted = async (request) => {
      writeStarted.resolve()
      await writeGate.promise
      return record(request)
    }
    const starting = host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    await writeStarted.promise
    const releasing = host.fiber.dispose()
    await vi.advanceTimersByTimeAsync(5_000)
    await releasing
    // The provider is gone; the write lands afterwards and opens no engine.
    expect(host.engines.order).toContain('release')
    writeGate.resolve()
    // Its storage is closed by then, so the opening write is refused rather than
    // landing a record no Host could ever settle; either way no engine opens.
    await expect(starting).rejects.toThrow(/closed|released this Worker before it opened its engine/)
    expect(host.engines.starts).toEqual([])
    expect(ledger.workerExecutionsOfMember(owner.actor.memberId)).toEqual([])
  })

  it('keeps a start whose handle opens after the deadline unconfirmed, and writes no late ending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const host = await boot(new MemoryMediaPool())
    host.engines.startMode = 'hold'
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const starting = host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    await waitForStart(host)
    const workerRef = workerRefOf(host, owner.actor.memberId)

    const releasing = host.fiber.dispose()
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    await releasing
    // The provider is gone before the late handle arrives; its release is the order marker.
    expect(host.engines.order).toContain('release')
    expect(host.host['ledger']!.workerRunState(workerRef)).toBe('running')
    // A sealed run is no longer this Host's: every reader derives "unconfirmed"
    // from the same rule, so nothing offers to stop or report it as live.
    expect(host.host['workerRegistry']!.liveState(workerRef)).toBeUndefined()
    expect(host.host['workerRegistry']!.isLive(workerRef)).toBe(false)
    expect(host.host['workerRegistry']!.get(workerRef)).toBeUndefined()

    // The handle opens after the Host released the run: it is disposed, and its
    // ending never reaches the closed storage.
    host.engines.gate.resolve()
    await expect(starting).rejects.toThrow(/released this Worker while it was still starting/)
    expect(host.engines.order.indexOf('dispose:session:worker-1')).toBeGreaterThan(host.engines.order.indexOf('release'))
    expect(host.host['ledger']!.workerRunState(workerRef)).toBe('running')
  })
})
