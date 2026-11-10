/**
 * A delegation observed through the whole Host: the tool's own request shape,
 * the target it is bound through, the Thread facts it lands as, and the wake its
 * initiator receives.
 *
 * The Harness subagent service is faked because a real engine process is not
 * what these cases are about: they press on the binding, the durable record, and
 * the destination a result follows, across two runs that end in either order and
 * across a Host that is replaced while one is still running.
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
import { agentTeamHumanActor } from '../src/ledger.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import { carryWorkerAnchors } from '../src/worker-runtime.ts'
import type { AgentTeamMemberActor, AgentTeamMemberId, AgentTeamProjectRef, AgentTeamRequestId,
  AgentTeamTaskRef, AgentTeamThreadRef } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const cleanups: Array<() => Promise<void>> = []
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

/** A Host row with delegation allowed on Codex, which is what a Human has to switch on first. */
const workerRow = () => ({ worker: { enabled: true, defaultEngine: 'codex' as const, timeoutMs: 0,
  engines: { codex: { enabled: true, executable: '', sandbox: 'workspace-write' },
    claude: { enabled: false, executable: '', sandbox: '' } } } })

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** One fake engine process per open, so several runs can be in flight at once. */
interface FakeEngines {
  readonly runtime: SubagentRuntime
  readonly starts: Array<Parameters<SubagentRuntime['startActivation']>[0]>
  readonly pending: Map<string, { resolve: (result: SubagentResult) => void }>
}

function fakeEngines(): FakeEngines {
  const starts: FakeEngines['starts'] = []
  const pending = new Map<string, { resolve: (result: SubagentResult) => void }>()
  let opened = 0
  const runtime = {
    registerProvider: () => () => {},
    startActivation: async (spec: Parameters<SubagentRuntime['startActivation']>[0]): Promise<SubagentActivation> => {
      starts.push(spec)
      const childId = `session:worker-${++opened}`
      const result = Promise.withResolvers<SubagentResult>()
      pending.set(childId, { resolve: result.resolve })
      // Closing the activation ends the engine, exactly as the real service's disposal does.
      const dispose = async (): Promise<void> => {
        const open = pending.get(childId)
        pending.delete(childId)
        open?.resolve({ output: [], stopReason: 'aborted' })
      }
      return { childId, result: result.promise.then(outcome => carryWorkerAnchors(outcome, { nativeSessionId: `native:${childId}` })),
        dispose } as unknown as SubagentActivation
    },
  } as unknown as SubagentRuntime
  return { runtime, starts, pending }
}

interface BootedHost {
  readonly ctx: Context
  readonly host: AgentTeam
  readonly engines: FakeEngines
  /** What the initiating Member's session received. */
  readonly wakes: UserMessage[]
  /** Shut this Host down, as losing the process would. */
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
  return { ctx, host: ctx.agentTeam, engines, wakes: [] as UserMessage[], stop }
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
    name: 'delivery', description: 'Delivery' })
  return project.project.projectRef
}

async function startThread(host: BootedHost, projectRef: AgentTeamProjectRef, kind: 'discussion' | 'task'):
  Promise<{ readonly threadRef: AgentTeamThreadRef; readonly taskRef?: AgentTeamTaskRef }> {
  const result = await host.host.startThread({ requestId: requestId(`thread-${kind}`), workspaceId: alpha, projectRef,
    kind, body: kind === 'task' ? 'Fix the nightly run' : 'Where does the nightly run fail?' })
  if (result.kind !== 'committed') throw new Error('Thread did not commit')
  return { threadRef: result.thread.threadRef, ...(result.task === undefined ? {} : { taskRef: result.task.taskRef }) }
}

const settle = (host: BootedHost, childId: string, result: SubagentResult): void => {
  const pending = host.engines.pending.get(childId)
  if (pending === undefined) throw new Error(`no Worker '${childId}' is open`)
  pending.resolve(result)
}

const workerWakes = (wakes: readonly UserMessage[]): string => wakes.map(message => JSON.stringify(message.content)).join('\n')

/** Wait until the ledger holds the ending this run recorded, not just the live view. */
async function waitRecorded(host: BootedHost, workerRef: string): Promise<void> {
  await vi.waitFor(() => {
    expect(host.host['ledger']!.workerRunState(workerRef as never)).not.toBe('running')
  })
}

describe('a delegation through the whole Host', () => {
  it('returns two concurrent runs to their own Threads in the order they end', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const first = await startThread(host, projectRef, 'discussion')
    const second = await startThread(host, projectRef, 'task')

    const runA = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run-a'),
      threadRef: first.threadRef, task: 'work out why the nightly run fails', cwd: process.cwd() })
    const runB = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run-b'),
      taskRef: second.taskRef!, task: 'fix the nightly run', cwd: process.cwd() })
    expect(runA.threadRef).toBe(first.threadRef)
    expect(runB.threadRef).toBe(second.threadRef)
    expect(runB.taskRef).toBe(second.taskRef)
    // A Thread is not the reason a run reports: the second one ends first.
    settle(host, 'session:worker-2', { output: [], stopReason: 'error', diagnostic: 'the engine exited before answering' })
    settle(host, 'session:worker-1', { output: [{ type: 'text', text: 'step 3 writes the wrong date' }], stopReason: 'completed' })
    await waitRecorded(host, runB.workerRef)
    await waitRecorded(host, runA.workerRef)

    const readFirst = await host.host.readThread({ requestId: requestId('read-a'), workspaceId: alpha, threadRef: first.threadRef })
    const readSecond = await host.host.readThread({ requestId: requestId('read-b'), workspaceId: alpha,
      taskRef: second.taskRef! })
    const activities = (read: Awaited<ReturnType<AgentTeam['readThread']>>) => read.facts
      .flatMap(entry => entry.fact.kind === 'activity' ? [entry.fact.activity] : [])
      .filter(activity => activity.kind === 'worker_started' || activity.kind === 'worker_settled')
    expect(activities(readFirst).map(activity => `${activity.workerRef}:${activity.kind}`))
      .toEqual([`${runA.workerRef}:worker_started`, `${runA.workerRef}:worker_settled`])
    expect(activities(readSecond).map(activity => `${activity.workerRef}:${activity.kind}`))
      .toEqual([`${runB.workerRef}:worker_started`, `${runB.workerRef}:worker_settled`])
    expect(readFirst.workerStates).toEqual([{ workerRef: runA.workerRef, state: 'completed', unconfirmed: false }])
    expect(readSecond.workerStates).toEqual([{ workerRef: runB.workerRef, state: 'failed', unconfirmed: false }])

    // The answer is the initiator's, and the Thread that holds the fact does not hold it.
    expect(JSON.stringify(readFirst)).not.toContain('step 3 writes the wrong date')
    expect(workerWakes(owner.wakes)).toContain('step 3 writes the wrong date')
    expect(workerWakes(owner.wakes)).toContain('the engine exited before answering')
  })

  it('wakes the initiator once per ending and tells nobody else', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const run = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    settle(host, 'session:worker-1', { output: [{ type: 'text', text: 'the schedule is wrong' }], stopReason: 'completed' })
    await vi.waitFor(() => { expect(workerWakes(owner.wakes)).toContain('the schedule is wrong') })
    const wake = owner.wakes.find(message => JSON.stringify(message.content).includes('the schedule is wrong'))
    // The wake names the same fact the Thread shows, so the model can read it back.
    expect(JSON.stringify(wake)).toContain(run.workerRef)
    expect(JSON.stringify(wake)).toContain(thread.threadRef)
    expect(owner.wakes.filter(message => JSON.stringify(message.content).includes('the schedule is wrong'))).toHaveLength(1)
  })

  it('refuses an unknown or contradictory target, and a Member who does not own the Project', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const plain = await addMember(host, projectRef, { owner: false, handle: 'plain' })
    const discussion = await startThread(host, projectRef, 'discussion')
    const taskThread = await startThread(host, projectRef, 'task')
    await expect(host.host.workerStartForAgent(owner.agent, { requestId: requestId('unknown-thread'),
      threadRef: 'thread:00000000-0000-4000-8000-00000000dead' as AgentTeamThreadRef, task: 'x', cwd: process.cwd() }))
      .rejects.toThrow(/not a Thread in this Team/)
    await expect(host.host.workerStartForAgent(owner.agent, { requestId: requestId('unknown-task'),
      taskRef: 'task:00000000-0000-4000-8000-00000000dead' as AgentTeamTaskRef, task: 'x', cwd: process.cwd() }))
      .rejects.toThrow(/not a Task in this Team/)
    await expect(host.host.workerStartForAgent(owner.agent, { requestId: requestId('conflict'),
      threadRef: discussion.threadRef, taskRef: taskThread.taskRef, task: 'x', cwd: process.cwd() }))
      .rejects.toThrow(/is not in Thread/)
    await expect(host.host.workerStartForAgent(plain.agent, { requestId: requestId('plain'),
      threadRef: discussion.threadRef, task: 'x', cwd: process.cwd() })).rejects.toThrow(/Only a current owner/)
    // No refusal reached the engine.
    expect(host.engines.starts).toEqual([])
  })

  // Both terminal Task states, because a run outliving its Task must not depend on
  // which one an owner picked: close ends the work, accept declares it done.
  for (const [action, resolution] of [['close', 'closed'], ['accept', 'accepted']] as const) {
    it(`keeps the result of a run whose Task is ${resolution} while it works`, async () => {
      const host = await boot(new MemoryMediaPool())
      const projectRef = await createProject(host)
      const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
      const taskThread = await startThread(host, projectRef, 'task')
      const run = await host.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
        taskRef: taskThread.taskRef!, task: 'fix the nightly run', cwd: process.cwd() })
      const before = await host.host.readThread({ requestId: requestId('read-before'), workspaceId: alpha,
        taskRef: taskThread.taskRef! })
      await host.host.changeTask({ requestId: requestId('change'), workspaceId: alpha, taskRef: taskThread.taskRef!,
        action, baseRevision: before.thread.revision })
      settle(host, 'session:worker-1', { output: [{ type: 'text', text: 'patched the date parsing' }], stopReason: 'completed' })
      await waitRecorded(host, run.workerRef)
      // The ended Task keeps its resolution; the run's facts stay on its Thread.
      const task = (await host.host.readThread({ requestId: requestId('read-task'), workspaceId: alpha,
        taskRef: taskThread.taskRef! })).task
      expect(task?.resolution).toBe(resolution)
      const history = host.host.threadHistory({ workspaceId: alpha, taskRef: taskThread.taskRef! })
      expect(history.workerStates).toEqual([{ workerRef: run.workerRef, state: 'completed', unconfirmed: false }])
      expect(history.facts.flatMap(entry => entry.kind === 'activity'
        && (entry.activity.kind === 'worker_started' || entry.activity.kind === 'worker_settled')
        ? [entry.activity.kind] : [])).toEqual(['worker_started', 'worker_settled'])
    })
  }
})

describe('the handle a delegation needs', () => {
  it('reads only the Member identity, the Session, and the working-directory seam', async () => {
    const host = await boot(new MemoryMediaPool())
    const projectRef = await createProject(host)
    const owner = await addMember(host, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(host, projectRef, 'discussion')
    const member = host.host['ledger']!.getMember(owner.actor.memberId)!
    // A lane has no real Agent: this stub answers for the three fields the
    // delegation is allowed to read and throws for anything else it grows into.
    const handle = new Proxy({
      id: SessionId(member.sessionId),
      session: { id: SessionId(member.sessionId) },
      ctx: { get: (name: string) => name === 'workingDirectory' ? { get: () => process.cwd() } : undefined },
    } as Record<string, unknown>, {
      get: (target, key) => {
        if (typeof key === 'symbol' || key in target) return target[key as string]
        throw new Error(`team_worker reached for agent.${String(key)}, which a lane cannot stub`)
      },
    })
    host.host['handles'].set(member.memberId, { agent: handle as unknown as Agent, dispose: async () => {} })
    const run = await host.host.workerStartForAgent(handle as unknown as Agent, { requestId: requestId('stub'),
      threadRef: thread.threadRef, task: 'check the schedule' })
    expect(run.state).toBe('running')
    expect(run.cwd).toBe(process.cwd())
  })
})

describe('a Host replaced while a run is working', () => {
  it('reads the run as unconfirmed and never starts it again', async () => {
    const pool = new MemoryMediaPool()
    const before = await boot(pool)
    const projectRef = await createProject(before)
    const owner = await addMember(before, projectRef, { owner: true, handle: 'owner' })
    const thread = await startThread(before, projectRef, 'discussion')
    const run = await before.host.workerStartForAgent(owner.agent, { requestId: requestId('run'),
      threadRef: thread.threadRef, task: 'check the schedule', cwd: process.cwd() })
    expect(before.engines.starts).toHaveLength(1)

    // The process that started the run is gone without recording an ending; a
    // new Host reads the same ledger and finds it still running.
    const after = await boot(pool)
    const read = await after.host.readThread({ requestId: requestId('read-after-restart'), workspaceId: alpha,
      threadRef: thread.threadRef })
    expect(read.workerStates).toEqual([{ workerRef: run.workerRef, state: 'running', unconfirmed: true }])
    expect(after.engines.starts).toEqual([])
  })
})
