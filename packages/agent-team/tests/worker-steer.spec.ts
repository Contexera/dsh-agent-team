/**
 * Adding one instruction to a Worker's native session through the Host: who may
 * ask, what OAR's delivery control answers, how an idle end is joined to the
 * current execution, and how a settled execution becomes a linked continuation.
 *
 * OAR is mocked here because the cases are about the decisions Team owns; the
 * released CLIs are proved against isolated native sessions by the probes under
 * `artifacts/worker-steer-both/`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@botiverse/oar'
import { cleanups, realHarness, requestId, waitFor } from './helpers/member-harness.ts'
import type { WorkerConfig } from '../src/worker-service.ts'
import type { WorkerSteer } from '../src/worker-runtime.ts'
import type { AgentTeamMemberId, AgentTeamProjectRef, AgentTeamWorkerExecution,
  AgentTeamWorkerRef, AgentTeamWorkerSteerAdmission, AgentTeamWorkerSteerAdmissionWrite } from '../src/types.ts'

/** What the fake engine does on the next open: its turn, its steer answer, its disposal. */
const engine = {
  turn: 'hanging' as 'failed' | 'completed' | 'hanging',
  /** Releasing this ends the hanging turn, as a Worker that finishes its work does. */
  release: undefined as PromiseWithResolvers<void> | undefined,
  /** Releasing this ends a resumed execution's first turn. */
  resumeRelease: undefined as PromiseWithResolvers<void> | undefined,
  /** Whether the session exposes a native steer control; without it delivery queues. */
  steerable: true,
  /** The engine's answer to the next steer: accepted with a turn id, or a typed refusal. */
  answer: { kind: 'accepted', turnId: 'native-turn' } as
    | { readonly kind: 'accepted'; readonly turnId?: string | undefined }
    | { readonly kind: 'rejected'; readonly code: string; readonly reason: string },
  /** Whether the native transport throws before its answer reaches Team. */
  steerThrows: false,
  /** Every steer the engine was actually asked for, in order. */
  steers: [] as Array<{ readonly sessionId: string; readonly instruction: string; readonly inputId: string }>,
  deliveries: [] as Array<{ readonly sessionId: string; readonly instruction: string; readonly inputId: string
    readonly landed: 'steered' | 'queued' | 'prompted' }>,
  sessions: [] as Array<{ readonly id: string; readonly resume?: string | undefined }>,
  storageRoot: '',
  /** Holds a steer open, so a stop can land while the answer is still being written. */
  steerGate: undefined as PromiseWithResolvers<void> | undefined,
  /** Holds disposal open, so a run stays stopping. */
  disposeGate: undefined as PromiseWithResolvers<void> | undefined,
  disposeFails: false,
  /** Holds a resumed provider's session open, so concurrent continuation calls overlap. */
  resumeOpenGate: undefined as PromiseWithResolvers<void> | undefined,
  /** Forces a resume to report a different native identity, as a broken engine would. */
  resumeId: undefined as string | undefined,
  /** Forces the next ordinary open to reuse an identity for the two-alias concurrency case. */
  newSessionId: undefined as string | undefined,
  disposed: [] as string[],
  gates: new Map<string, PromiseWithResolvers<void>>(),
  endedSessions: new Set<string>(),
  next: 1,
}

const initialClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR

const fakeRuntime = {
  installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/engine', version: 'x' }),
  session: async (_installation: unknown, options?: { readonly resume?: string
    readonly cwd?: string }): Promise<Session> => {
    const id = options?.resume === undefined
      ? engine.newSessionId ?? `native-session-${engine.next++}`
      : engine.resumeId ?? options.resume
    engine.sessions.push({ id, ...(options?.resume === undefined ? {} : { resume: options.resume }) })
    const gate = (options?.resume === undefined ? engine.release : engine.resumeRelease)!
    engine.gates.set(id, gate)
    engine.endedSessions.delete(id)
    if (options?.resume !== undefined && engine.resumeOpenGate !== undefined) await engine.resumeOpenGate.promise
    const sessionState = { initialInputId: '' }
    const storageDirectory = join(engine.storageRoot, 'sessions', '2026', '11', '10')
    await mkdir(storageDirectory, { recursive: true })
    const storage = join(storageDirectory, `rollout-${id}.jsonl`)
    await writeFile(storage, [
      JSON.stringify({ timestamp: '2026-11-10T12:00:00.000Z', ordinal: 0, type: 'session_meta',
        payload: { session_id: id, id, cli_version: '0.167.0', originator: 'oar', cwd: '/tmp/project',
          timestamp: '2026-11-10T12:00:00.000Z' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${id}`,
        root_turn_id: `turn-${id}`, last_agent_message: null, duration_ms: 1 } }),
      '',
    ].join('\n'))
    const session = {
      id,
      events: () => () => {},
      status: () => engine.endedSessions.has(id)
        ? { value: { kind: 'idle' as const }, seq: 2 }
        : { value: { kind: 'running' as const, sinceSeq: 2 }, seq: 2 },
      prompt: async (_instruction: string, promptOptions?: { readonly inputId?: string }) => {
        sessionState.initialInputId = promptOptions?.inputId ?? ''
        if (process.env.CLAUDE_CONFIG_DIR !== undefined && options?.cwd !== undefined) {
          const directory = join(process.env.CLAUDE_CONFIG_DIR, 'projects', options.cwd.replaceAll(/[^A-Za-z0-9]/gu, '-'))
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, `${id}.jsonl`), [
            JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-10T12:00:00.000Z', sessionId: id }),
            JSON.stringify({ parentUuid: null, isSidechain: false, promptId: 'prompt-1', type: 'user',
              message: { role: 'user', content: [{ type: 'text', text: _instruction }] }, uuid: sessionState.initialInputId,
              timestamp: '2026-11-10T12:00:01.000Z', permissionMode: 'bypassPermissions',
              turnPosition: { promptIndex: 0, turnIndex: 1 }, cwd: options.cwd, sessionId: id, version: '2.1.319' }),
            JSON.stringify({ parentUuid: sessionState.initialInputId, isSidechain: false, type: 'assistant',
              message: { role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'done' }] },
              uuid: 'assistant-1', timestamp: '2026-11-10T12:00:02.000Z', requestedModel: 'fake', effort: 'high',
              sessionId: id }),
            '',
          ].join('\n'))
        }
        return { kind: 'accepted', seq: 1 }
      },
      ...engine.steerable ? {
        steer: async (instruction: string, options?: { readonly inputId?: string }) => {
          engine.steers.push({ sessionId: id, instruction, inputId: options?.inputId ?? '' })
          if (engine.steerGate !== undefined) await engine.steerGate.promise
          if (engine.steerThrows) throw new Error('the native transport closed')
          return engine.answer.kind === 'accepted'
            ? { kind: 'accepted', response: { body: { kind: 'accepted', native: { turnId: engine.answer.turnId } } } }
            : { kind: 'rejected', code: engine.answer.code, reason: engine.answer.reason,
              response: { body: { kind: 'rejected', code: engine.answer.code, reason: engine.answer.reason } } }
        },
      } : {},
      deliver: async (instruction: string, options?: { readonly inputId?: string }) => {
        const inputId = options?.inputId ?? ''
        const landed = engine.endedSessions.has(id) ? 'prompted' as const : engine.steerable ? 'steered' as const : 'queued' as const
        engine.deliveries.push({ sessionId: id, instruction, inputId, landed })
        if (landed === 'steered') {
          const result = await (session as unknown as { steer(instruction: string,
            options?: { readonly inputId?: string }): Promise<{ readonly kind: string; readonly code?: string
              readonly reason?: string }> }).steer(instruction, options)
          return result.kind === 'accepted' ? { landed, inputId, result }
            : { landed: 'rejected' as const, inputId, code: result.code, reason: result.reason, result }
        }
        return { landed, inputId, result: { kind: 'accepted', response: { body: { kind: 'accepted', native: {} } } } }
      },
      abort: async () => {},
      dispose: async () => {
        if (engine.disposeGate !== undefined) await engine.disposeGate.promise
        engine.disposed.push(id)
        if (engine.disposeFails) throw new Error('the engine did not confirm cleanup')
      },
      records: () => [
        { sessionId: id, agentPath: [], seq: 1, receivedAt: 0, kind: 'frame',
          body: { type: options?.resume === undefined ? 'thread/start' : 'thread/resume',
            native: { thread: { id, path: storage } }, events: [] } },
        { sessionId: id, agentPath: [], seq: 2, receivedAt: 0, spanId: `turn-${id}`, kind: 'frame',
          body: { type: 'turn/started', native: {}, events: sessionState.initialInputId === '' ? [] : [{
            kind: 'user_message', input: 'task', inputId: sessionState.initialInputId,
            evidence: 'turn_item', turnId: `turn-${id}` }] } },
        ...engine.endedSessions.has(id) ? [{ sessionId: id, agentPath: [], seq: 3, receivedAt: 0, spanId: `turn-${id}`,
          kind: 'frame', body: { type: 'turn/completed', native: {}, events: [{ kind: 'turn_ended',
            outcome: { kind: 'completed' }, ...(engine.steers[0] === undefined ? {} : { inputId: engine.steers[0].inputId }),
            ...(engine.steers.length === 0 ? {} : { inputIds: engine.steers.map(entry => entry.inputId) }) }] } }] : [],
      ],
    } as unknown as Session
    return session
  },
}

vi.mock('@botiverse/oar', () => ({
  codexRuntime: fakeRuntime,
  claudeRuntime: fakeRuntime,
}))

vi.mock('@botiverse/oar/observe', () => ({
  awaitTurnEnd: async (session: Session) => engine.turn === 'completed' ? { kind: 'completed' }
    : engine.turn === 'hanging' ? (engine.gates.get(session.id) ?? engine.release!).promise.then(() => {
      engine.endedSessions.add(session.id)
      return { kind: 'completed' }
    })
      : { kind: 'failed', failure: 'unknown' },
}))

const history = {
  gate: undefined as PromiseWithResolvers<void> | undefined,
  reached: undefined as PromiseWithResolvers<void> | undefined,
}

vi.mock('../src/worker-inspection.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/worker-inspection.ts')>()
  return {
    ...actual,
    readWorkerHistory: async (anchors: Parameters<typeof actual.readWorkerHistory>[0]) => {
      history.reached?.resolve()
      if (history.gate !== undefined) await history.gate.promise
      return actual.readWorkerHistory(anchors)
    },
  }
})

afterEach(async () => {
  engine.release?.resolve()
  engine.resumeRelease?.resolve()
  engine.resumeOpenGate?.resolve()
  engine.steerGate?.resolve()
  engine.disposeGate?.resolve()
  while (cleanups.length > 0) await cleanups.pop()!()
  engine.turn = 'hanging'
  engine.release = undefined
  engine.resumeRelease = undefined
  engine.steerable = true
  engine.answer = { kind: 'accepted', turnId: 'native-turn' }
  engine.steerThrows = false
  engine.resumeOpenGate = undefined
  engine.resumeId = undefined
  engine.newSessionId = undefined
  engine.disposed = []
  engine.gates.clear()
  engine.endedSessions.clear()
  engine.steers = []
  engine.deliveries = []
  engine.sessions = []
  engine.storageRoot = ''
  engine.steerGate = undefined
  engine.disposeGate = undefined
  engine.disposeFails = false
  engine.next = 1
  history.gate?.resolve()
  history.gate = undefined
  history.reached = undefined
  if (initialClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = initialClaudeConfigDir
}, 30_000)

const workerConfig = (): WorkerConfig => ({ enabled: true, defaultEngine: 'codex', timeoutMs: 0,
  engines: { codex: { enabled: true, executable: '/fake/codex', sandbox: 'workspace-write' },
    claude: { enabled: true, executable: '/fake/claude', sandbox: '' } } })

const setWorkerConfig = (ctx: { readonly agentTeam: unknown }, config: WorkerConfig = workerConfig()): void => {
  ;(ctx.agentTeam as { readonly config: { worker: unknown } }).config.worker = { get: () => config }
}

const executionOf = (team: unknown, workerRef: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined =>
  (team as { readonly ledger: { workerExecution(ref: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined } })
    .ledger.workerExecution(workerRef)

const settledOf = async (team: unknown, workerRef: AgentTeamWorkerRef): Promise<AgentTeamWorkerExecution> =>
  waitFor(() => {
    const recorded = executionOf(team, workerRef)
    return recorded?.settledAt === undefined ? undefined : recorded
  }, 20_000)

const settledWithin = async (promise: Promise<unknown>, milliseconds = 50): Promise<'settled' | 'pending'> =>
  Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>(resolve => setTimeout(() => { resolve('pending') }, milliseconds)),
  ])

/** Registrations the runtime announced, kept because it no longer enumerates them. */
type ProviderProbe = { readonly live: Set<string>; readonly added: string[] }

/** Follows the runtime's own registration events, so the probe cannot invent state. */
const observeProviders = (ctx: Context): ProviderProbe => {
  const live = new Set<string>()
  const added: string[] = []
  ctx.on('subagent/provider-added', provider => { live.add(provider.name); added.push(provider.name) })
  ctx.on('subagent/provider-removed', name => { live.delete(name) })
  return { live, added }
}

/** Resume registrations still live and still resolved by the runtime: two answers, one set. */
const resumeProviders = (probe: ProviderProbe, ctx: Context): string[] =>
  [...probe.live].filter(name => name.includes(':resume:') && ctx.subagents.getProvider(name) !== undefined)

/** One Project, one owning Member, and a second Member who owns nothing here. */
async function setup() {
  // Each run's turn hangs until its own test releases it, so a steer always
  // arrives while the engine is still executing.
  engine.release = Promise.withResolvers()
  engine.resumeRelease = Promise.withResolvers()
  const harness = await realHarness()
  const ctx = harness.ctx
  engine.storageRoot = harness.root
  process.env.CLAUDE_CONFIG_DIR = join(harness.root, 'claude')
  await ctx.plugin(SubagentRuntime)
  const probe = observeProviders(ctx)
  const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
    name: 'steer', description: 'Steer' })
  const projectRef = project.project.projectRef as AgentTeamProjectRef
  const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
    handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
    model: { provider: 'mock', model: 'mock' } })
  const member = added.status.member
  await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
    memberId: member.memberId })
  const other = await ctx.agentTeam.addMember({ requestId: requestId('other'), workspaceId: harness.workspaceId,
    handle: 'bystander', description: 'Owns nothing', presetId: 'team-member', projectRefs: [projectRef],
    model: { provider: 'mock', model: 'mock' } })
  setWorkerConfig(ctx)
  return {
    harness, ctx, probe, projectRef, member,
    agent: ctx.agents.get(member.sessionId) as Agent,
    otherAgent: ctx.agents.get(other.status.member.sessionId) as Agent,
    otherId: other.status.member.memberId as AgentTeamMemberId,
  }
}

describe('one instruction in the Worker native session', () => {
  // The probe is the only record of provider names now that the runtime stopped
  // enumerating them. This control proves it sees a resume registration while it
  // is live, so an empty answer later is a withdrawal, not a blind probe.
  it('observes the resumed provider it later requires to be withdrawn', async () => {
    const { harness, ctx, agent, projectRef, probe } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)

    engine.resumeOpenGate = Promise.withResolvers()
    const opening = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'continue under observation', requestId: requestId('continue-observed') })
    await waitFor(() => engine.sessions.find(session => session.resume !== undefined), 10_000)
    const observed = [...probe.live].filter(name => name.includes(':resume:'))
    expect(observed).toHaveLength(1)
    expect(ctx.subagents.getProvider(observed[0]!)).toBeDefined()

    engine.resumeOpenGate.resolve()
    await opening
    expect(probe.added.filter(name => name.includes(':resume:'))).toEqual(observed)
    expect(ctx.subagents.getProvider(observed[0]!)).toBeUndefined()
    expect(resumeProviders(probe, ctx)).toEqual([])
  })

  it('reports submitted with the turn the engine named, without starting another execution', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    const steered = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also update the changelog', requestId: requestId('steer-1') })
    expect(steered).toMatchObject({ workerRef: run.workerRef, engine: 'codex', state: 'submitted',
      turnId: 'native-turn', runState: 'running' })
    // One instruction, one engine call. The Team request id remains Team's
    // idempotency key; the native control receives its own valid UUID.
    expect(engine.steers).toEqual([{ sessionId: expect.stringMatching(/^native-session-/u),
      instruction: 'also update the changelog',
      inputId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u) }])
    expect(engine.steers[0]?.inputId).not.toBe('steer-1')
    // The run is still the one execution: no second opening record.
    expect(executionOf(ctx.agentTeam, run.workerRef)?.state).toBe('running')
  })

  it('answers a resent request id with the first receipt instead of sending twice', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    const first = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also update the changelog', requestId: requestId('steer-1') })
    const again = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also update the changelog', requestId: requestId('steer-1') })
    expect(again).toEqual(first)
    expect(engine.steers).toHaveLength(1)
  })

  it('sends the same sentence once even when a retry arrives under a fresh request id', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also update the changelog', requestId: requestId('steer-1') })
    await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also update the changelog', requestId: requestId('steer-2') })
    expect(engine.steers).toHaveLength(1)
  })

  it('joins a fresh alias to a canonical steer whose native delivery is still in flight', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.steerGate = Promise.withResolvers()
    const canonical = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one sentence with a slow acknowledgement', requestId: requestId('steer-canonical') })
    await waitFor(() => engine.steers.length === 1 ? true : undefined, 10_000)
    const alias = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one sentence with a slow acknowledgement', requestId: requestId('steer-alias-in-flight') })
    engine.steerGate.resolve()
    const [first, second] = await Promise.all([canonical, alias])
    expect(second).toEqual(first)
    expect(engine.steers).toHaveLength(1)
  })

  it('refuses one request id carrying a different instruction', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also update the changelog', requestId: requestId('steer-1') })
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'stop and do something else', requestId: requestId('steer-1') }))
      .rejects.toThrow(/already carried another instruction/)
    expect(engine.steers).toHaveLength(1)
  })

  it('refuses a used request id for another Member or an unrelated Worker', async () => {
    const { harness, ctx, agent, otherAgent, projectRef } = await setup()
    const first = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('a'),
      projectRef, task: 'first task', cwd: harness.checkout })
    const second = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('b'),
      projectRef, task: 'second task', cwd: harness.checkout })
    const request = { workerRef: first.workerRef, instruction: 'one owned sentence',
      requestId: requestId('steer-owned') }
    await ctx.agentTeam.workerSteerForAgent(agent, request)

    await expect(ctx.agentTeam.workerSteerForAgent(otherAgent, request))
      .rejects.toThrow(/already carried another instruction/u)
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { ...request, workerRef: second.workerRef }))
      .rejects.toThrow(/already carried another instruction/u)
    expect(engine.steers).toHaveLength(1)
  })

  it('reaches only the run it names when two are executing', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const first = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('a'),
      projectRef, task: 'first task', cwd: harness.checkout })
    const second = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('b'),
      projectRef, task: 'second task', cwd: harness.checkout })
    await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: second.workerRef,
      instruction: 'only the second run hears this', requestId: requestId('steer-b') })
    expect(engine.steers).toHaveLength(1)
    const [call] = engine.steers
    const secondExecution = executionOf(ctx.agentTeam, second.workerRef)
    expect(call!.sessionId).toBe(secondExecution?.nativeSessionId ?? call!.sessionId)
    expect(engine.steers.map(entry => entry.instruction)).toEqual(['only the second run hears this'])
    expect(executionOf(ctx.agentTeam, first.workerRef)?.state).toBe('running')
  })

  it('refuses a Member who did not delegate the run', async () => {
    const { harness, ctx, agent, otherAgent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    await expect(ctx.agentTeam.workerSteerForAgent(otherAgent, { workerRef: run.workerRef,
      instruction: 'do this instead', requestId: requestId('steer-other') }))
      .rejects.toThrow(/Only the Member who delegated/)
    expect(engine.steers).toHaveLength(0)
  })

  it('continues a cleanly ended run as a new execution in the same native session', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    const original = await settledOf(ctx.agentTeam, run.workerRef)
    const continued = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-late') })
    expect(continued).toMatchObject({ state: 'started', continuedFrom: run.workerRef, engine: 'codex',
      workerRef: expect.not.stringMatching(`^${run.workerRef}$`), runState: 'running' })
    expect(executionOf(ctx.agentTeam, run.workerRef)).toEqual(original)
    expect(executionOf(ctx.agentTeam, continued.workerRef)).toMatchObject({ task: 'one more thing',
      continuedFrom: run.workerRef, projectRef })
    expect(engine.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ resume: original.nativeSessionId }),
    ]))
  })

  it.each(['codex', 'claude'] as const)('delivers to an idle native session before Team settlement for %s', async engineName => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout, engine: engineName })
    engine.endedSessions.add(engine.sessions[0]!.id)
    const steered = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'open the follow-up turn', requestId: requestId(`steer-idle-${engineName}`) })
    expect(steered).toMatchObject({ workerRef: run.workerRef, engine: engineName, state: 'submitted',
      landed: 'prompted', runState: 'running' })
    expect(executionOf(ctx.agentTeam, run.workerRef)?.state).toBe('running')
  })

  it('acquires the native closing hold before durable admission and releases it after recording', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    const registry = ctx.agentTeam['workerRegistry'] as unknown as {
      readonly sessions: Map<string, WorkerSteer>
      admitSteer(write: AgentTeamWorkerSteerAdmissionWrite): Promise<AgentTeamWorkerSteerAdmission>
    }
    const [sessionId, control] = [...registry.sessions.entries()][0]!
    let holds = 0
    let releases = 0
    const heldControl: WorkerSteer = Object.assign(
      async (instruction: string, inputId: string) => control(instruction, inputId),
      { hold: () => {
        holds += 1
        const release = control.hold!()
        return () => { releases += 1; release?.() }
      } },
    )
    registry.sessions.set(sessionId, heldControl)
    const admissionStarted = Promise.withResolvers<void>()
    const admissionGate = Promise.withResolvers<void>()
    const admit = registry.admitSteer
    registry.admitSteer = async write => {
      admissionStarted.resolve()
      await admissionGate.promise
      return admit.call(registry, write)
    }

    const steering = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'open a turn after this admission', requestId: requestId('steer-held-admission') })
    await admissionStarted.promise
    expect(holds).toBe(1)
    expect(engine.deliveries).toHaveLength(0)
    engine.release!.resolve()
    const nativeSessionId = engine.sessions[0]!.id
    await waitFor(() => engine.endedSessions.has(nativeSessionId) ? true : undefined, 10_000)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(engine.deliveries).toHaveLength(0)
    admissionGate.resolve()
    await expect(steering).resolves.toMatchObject({ state: 'submitted', landed: 'prompted', runState: 'running' })
    expect(holds).toBe(1)
    expect(releases).toBe(1)
  })

  it.each(['codex', 'claude'] as const)('continues a closed %s Worker on its original engine', async engineName => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout, engine: engineName })
    engine.release!.resolve()
    const original = await settledOf(ctx.agentTeam, run.workerRef)
    const continued = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId(`steer-continue-${engineName}`) })
    expect(continued).toMatchObject({ state: 'started', engine: engineName, continuedFrom: run.workerRef })
    expect(engine.sessions.at(-1)).toMatchObject({ resume: original.nativeSessionId })
  })

  it.each(['codex', 'claude'] as const)('continues a cleanly failed %s Worker', async engineName => {
    const { harness, ctx, agent, projectRef } = await setup()
    engine.turn = 'failed'
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'try the parser change', cwd: harness.checkout, engine: engineName })
    const original = await settledOf(ctx.agentTeam, run.workerRef)
    expect(original.state).toBe('failed')
    const continued = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'try again from the same context', requestId: requestId(`continue-failed-${engineName}`) })
    expect(continued).toMatchObject({ state: 'started', engine: engineName, continuedFrom: run.workerRef })
    expect(engine.sessions.at(-1)).toMatchObject({ resume: original.nativeSessionId })
  })

  it('joins concurrent continuations into one new execution and steers the second into it', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)

    engine.resumeOpenGate = Promise.withResolvers()
    const firstOpening = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'first follow-up', requestId: requestId('continue-first') })
    await waitFor(() => engine.sessions.some(session => session.resume !== undefined), 10_000)
    const secondOpening = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'second follow-up', requestId: requestId('continue-second') })
    engine.resumeOpenGate.resolve()
    const results = await Promise.all([firstOpening, secondOpening])
    const started = results.find(result => result.state === 'started')
    const joined = results.find(result => result.state === 'submitted')
    expect(started).toMatchObject({ state: 'started', continuedFrom: run.workerRef })
    expect(joined).toMatchObject({ state: 'submitted', workerRef: started?.workerRef })
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(1)
    // Either arrival order is valid: one request opens the successor and the
    // other is delivered into it. The test pins one successor, not which caller
    // won the asynchronous ledger race.
    expect(engine.steers.at(-1)?.instruction).toBe(
      results[0].state === 'submitted' ? 'first follow-up' : 'second follow-up')
  })

  it('answers a continuation request-id retry without opening another native session', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)
    const request = { workerRef: run.workerRef, instruction: 'one more thing', requestId: requestId('continue-once') }
    const first = await ctx.agentTeam.workerSteerForAgent(agent, request)
    const again = await ctx.agentTeam.workerSteerForAgent(agent, request)
    expect(again).toEqual(first)
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(1)
  })

  it('joins concurrent continuations carrying the same text without appending it twice', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)
    engine.resumeOpenGate = Promise.withResolvers()
    const firstOpening = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one follow-up', requestId: requestId('continue-text-first') })
    await waitFor(() => engine.sessions.some(session => session.resume !== undefined), 10_000)
    const secondOpening = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one follow-up', requestId: requestId('continue-text-second') })
    engine.resumeOpenGate.resolve()
    const [first, second] = await Promise.all([firstOpening, secondOpening])
    expect(first).toMatchObject({ state: 'started', continuedFrom: run.workerRef })
    expect(second).toEqual(first)
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(1)
    expect(engine.steers).toHaveLength(0)
  })

  it('applies text dedupe per execution, not across a continuation', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'repeat this later if asked', requestId: requestId('steer-before-end') })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)

    const continued = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'repeat this later if asked', requestId: requestId('continue-same-text') })
    expect(continued).toMatchObject({ state: 'started', continuedFrom: run.workerRef })
    expect(continued.workerRef).not.toBe(run.workerRef)
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(1)
    expect(engine.steers).toHaveLength(1)

    const duplicateOpening = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'repeat this later if asked', requestId: requestId('continue-same-text-again') })
    expect(duplicateOpening).toEqual(continued)
    expect(engine.steers).toHaveLength(1)
  })

  it('joins concurrent continuations carrying the same request id', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)
    engine.resumeOpenGate = Promise.withResolvers()
    const request = { workerRef: run.workerRef, instruction: 'one follow-up',
      requestId: requestId('continue-concurrent-same') }
    const firstOpening = ctx.agentTeam.workerSteerForAgent(agent, request)
    const secondOpening = ctx.agentTeam.workerSteerForAgent(agent, request)
    engine.resumeOpenGate.resolve()
    const [first, second] = await Promise.all([firstOpening, secondOpening])
    expect(first).toMatchObject({ state: 'started', continuedFrom: run.workerRef })
    expect(second).toEqual(first)
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(1)
  })

  it('fails a continuation whose resume opens a different native session', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)
    engine.resumeId = 'native-session-unexpected'
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'resume the same conversation', requestId: requestId('continue-mismatch') }))
      .rejects.toThrow(/Team Worker failure/)
    const successor = (ctx.agentTeam as unknown as { ledger: { workerSuccessor(
      ref: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined } }).ledger.workerSuccessor(run.workerRef)
    expect(successor).toMatchObject({ state: 'failed', stage: 'startup', continuedFrom: run.workerRef })
    expect(engine.disposed).toContain('native-session-unexpected')
  })

  it('keeps an unconfirmed cleanup after a resumed session mismatch', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)
    engine.resumeId = 'native-session-unexpected'
    engine.disposeFails = true
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'resume the same conversation', requestId: requestId('continue-mismatch-unclean') }))
      .rejects.toThrow(/stage: dispose/)
    const successor = (ctx.agentTeam as unknown as { ledger: { workerSuccessor(
      ref: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined } }).ledger.workerSuccessor(run.workerRef)
    expect(successor).toMatchObject({ state: 'failed', stage: 'dispose', continuedFrom: run.workerRef })
  })

  it('joins two old refs that name the same native conversation instead of forking it', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const firstRun = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run-first'),
      projectRef, task: 'first recorded execution', cwd: harness.checkout })
    engine.release!.resolve()
    const firstRecord = await settledOf(ctx.agentTeam, firstRun.workerRef)

    engine.newSessionId = firstRecord.nativeSessionId
    engine.release = Promise.withResolvers()
    const secondRun = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run-second'),
      projectRef, task: 'second recorded execution', cwd: harness.checkout })
    engine.release.resolve()
    await settledOf(ctx.agentTeam, secondRun.workerRef)

    engine.resumeOpenGate = Promise.withResolvers()
    const firstOpening = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: firstRun.workerRef,
      instruction: 'continue through the first old ref', requestId: requestId('continue-alias-first') })
    await waitFor(() => engine.sessions.some(session => session.resume !== undefined), 10_000)
    const secondOpening = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: secondRun.workerRef,
      instruction: 'continue through the second old ref', requestId: requestId('continue-alias-second') })
    engine.resumeOpenGate.resolve()
    const results = await Promise.all([firstOpening, secondOpening])
    const started = results.find(result => result.state === 'started')
    const joined = results.find(result => result.state === 'submitted')
    expect(started).toMatchObject({ state: 'started' })
    expect([firstRun.workerRef, secondRun.workerRef]).toContain(started?.continuedFrom)
    expect(joined).toMatchObject({ workerRef: started?.workerRef, state: 'submitted' })
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(1)
    expect(engine.steers.at(-1)?.instruction).toBe(
      results[0].state === 'submitted' ? 'continue through the first old ref' : 'continue through the second old ref')
  })

  it('uses the ledger to join or extend an alias conversation after its opening window', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const firstRun = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run-first'),
      projectRef, task: 'first recorded execution', cwd: harness.checkout })
    engine.release!.resolve()
    const firstRecord = await settledOf(ctx.agentTeam, firstRun.workerRef)

    engine.newSessionId = firstRecord.nativeSessionId
    engine.release = Promise.withResolvers()
    const secondRun = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run-second'),
      projectRef, task: 'second recorded execution', cwd: harness.checkout })
    engine.release.resolve()
    await settledOf(ctx.agentTeam, secondRun.workerRef)

    const first = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: firstRun.workerRef,
      instruction: 'continue through the first alias', requestId: requestId('continue-first-alias') })
    await waitFor(() => engine.sessions.some(session => session.resume !== undefined), 10_000)
    const joined = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: secondRun.workerRef,
      instruction: 'join the running successor', requestId: requestId('join-second-alias') })
    expect(joined).toMatchObject({ workerRef: first.workerRef, state: 'submitted', runState: 'running' })
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(1)

    engine.resumeRelease!.resolve()
    await settledOf(ctx.agentTeam, first.workerRef)
    engine.resumeRelease = Promise.withResolvers()
    const next = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: secondRun.workerRef,
      instruction: 'extend the same conversation after the successor ended', requestId: requestId('next-second-alias') })
    expect(next).toMatchObject({ state: 'started', continuedFrom: first.workerRef })
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(2)
    expect(engine.sessions.at(-1)).toMatchObject({ resume: firstRecord.nativeSessionId })
  })

  it('continues from the newest successor instead of forking the native conversation', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const original = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, original.workerRef)
    const first = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: original.workerRef,
      instruction: 'first continuation', requestId: requestId('continue-first') })
    engine.resumeRelease!.resolve()
    await settledOf(ctx.agentTeam, first.workerRef)
    engine.resumeRelease = Promise.withResolvers()

    const second = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: original.workerRef,
      instruction: 'second continuation', requestId: requestId('continue-second') })
    expect(second).toMatchObject({ state: 'started', continuedFrom: first.workerRef })
    expect((ctx.agentTeam as unknown as { workerRegistry: { continuations: Map<string, unknown> } })
      .workerRegistry.continuations.size).toBe(0)
  })

  it('continues again from a resumed execution with its native record anchor intact', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const original = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, original.workerRef)
    const first = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: original.workerRef,
      instruction: 'first continuation', requestId: requestId('continue-first') })
    engine.resumeRelease!.resolve()
    const firstRecord = await settledOf(ctx.agentTeam, first.workerRef)
    expect(firstRecord.nativeStorage).toBeTruthy()
    engine.resumeRelease = Promise.withResolvers()

    const second = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: first.workerRef,
      instruction: 'second continuation', requestId: requestId('continue-second') })
    expect(second).toMatchObject({ state: 'started', continuedFrom: first.workerRef })
    expect(engine.sessions.at(-1)).toMatchObject({ resume: firstRecord.nativeSessionId })
  })

  it('continues past a cleanly failed continuation by inheriting the chain native anchor', async () => {
    const { harness, ctx, agent, member, projectRef } = await setup()
    const original = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    const originalRecord = await settledOf(ctx.agentTeam, original.workerRef)
    const failedRef = 'worker:failed-continuation-before-open' as AgentTeamWorkerRef
    const ledger = (ctx.agentTeam as unknown as { readonly ledger: {
      recordWorkerStarted(write: unknown): Promise<unknown>
      recordWorkerSettled(write: unknown): Promise<unknown>
    } }).ledger
    await ledger.recordWorkerStarted({ requestId: requestId('failed-continuation'),
      actor: { kind: 'member', memberId: member.memberId, handle: member.handle },
      workspaceId: harness.workspaceId, execution: {
        workerRef: failedRef, projectRef, initiatedBy: member.memberId, engine: 'codex',
        task: 'the resume attempt that could not open', cwd: harness.checkout,
        continuedFrom: original.workerRef,
      } })
    await ledger.recordWorkerSettled({ requestId: requestId('failed-continuation-settled'), settlement: {
      workerRef: failedRef, state: 'failed', stage: 'startup',
      diagnostic: 'The resumed engine could not open the recorded native session.',
    } })

    const next = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: original.workerRef,
      instruction: 'try the continuation again', requestId: requestId('continue-after-open-failure') })
    expect(next).toMatchObject({ state: 'started', continuedFrom: failedRef })
    expect(engine.sessions.at(-1)).toMatchObject({ resume: originalRecord.nativeSessionId })
  })

  it('rechecks the Worker, engine, ownership, and Member before continuing', async () => {
    const { harness, ctx, agent, member, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)
    const request = (suffix: string) => ({ workerRef: run.workerRef,
      instruction: `continue ${suffix}`, requestId: requestId(`continue-${suffix}`) })

    const workerOff = { ...workerConfig(), enabled: false }
    setWorkerConfig(ctx, workerOff)
    await expect(ctx.agentTeam.workerSteerForAgent(agent, request('worker-off')))
      .rejects.toThrow(/Worker delegation is switched off/)

    const engineOff = { ...workerConfig(), engines: {
      ...workerConfig().engines, codex: { ...workerConfig().engines.codex, enabled: false } } }
    setWorkerConfig(ctx, engineOff)
    await expect(ctx.agentTeam.workerSteerForAgent(agent, request('engine-off')))
      .rejects.toThrow(/Engine 'codex' is not enabled/)

    setWorkerConfig(ctx)
    await ctx.agentTeam.removeProjectOwner({ requestId: requestId('owner-off'), workspaceId: harness.workspaceId,
      projectRef, memberId: member.memberId })
    await expect(ctx.agentTeam.workerSteerForAgent(agent, request('owner-off')))
      .rejects.toThrow(/current owner/)

    await ctx.agentTeam.suspendMember({ requestId: requestId('member-off'), memberId: member.memberId })
    await expect(ctx.agentTeam.workerSteerForAgent(agent, request('member-off')))
      .rejects.toThrow(/not an active Team Member/)
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(0)
  })

  it('waits for a continuation reading native history before unloading', async () => {
    const { harness, ctx, agent, projectRef, probe } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)

    history.gate = Promise.withResolvers()
    history.reached = Promise.withResolvers()
    const opening = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'continue after the history read', requestId: requestId('continue-history-window') })
    void opening.catch(() => {})
    await history.reached.promise

    const registry = ctx.agentTeam['workerRegistry']
    const ledger = ctx.agentTeam['ledger']!
    const disposing = registry.dispose()
    expect(await settledWithin(disposing)).toBe('pending')
    const sequenceBeforeRelease = ctx.agentTeam.status().sequence
    history.gate.resolve()
    await expect(opening).rejects.toThrow(/Team is unloading/u)
    await disposing

    expect(ctx.agentTeam.status().sequence).toBe(sequenceBeforeRelease)
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(0)
    expect(ledger.workerSuccessor(run.workerRef)).toBeUndefined()
    expect(resumeProviders(probe, ctx)).toEqual([])
  })

  it('waits for an opening record write before unloading closes its storage', async () => {
    const { harness, ctx, agent, projectRef, probe } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)

    const ledger = ctx.agentTeam['ledger']!
    const recordStarted = ledger.recordWorkerStarted.bind(ledger)
    const gate = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const openingRecord = vi.spyOn(ledger, 'recordWorkerStarted').mockImplementationOnce(async write => {
      reached.resolve()
      await gate.promise
      return recordStarted(write)
    })
    const opening = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'continue after the opening write', requestId: requestId('continue-opening-window') })
    void opening.catch(() => {})
    await reached.promise

    const registry = ctx.agentTeam['workerRegistry']
    const disposing = registry.dispose()
    expect(await settledWithin(disposing)).toBe('pending')
    gate.resolve()
    await expect(opening).rejects.toThrow(/Team is unloading|released this Worker/u)
    await disposing
    openingRecord.mockRestore()

    const sequenceAfterDispose = ctx.agentTeam.status().sequence
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(ctx.agentTeam.status().sequence).toBe(sequenceAfterDispose)
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(0)
    expect(resumeProviders(probe, ctx)).toEqual([])
    expect(ledger.workerSuccessor(run.workerRef)?.state).toBe('running')
  })

  it.each([
    {
      label: 'Worker setting',
      refusal: /Worker delegation is switched off/u,
      settledStage: 'startup',
      change: async (ctx: Awaited<ReturnType<typeof setup>>['ctx']) => {
        setWorkerConfig(ctx, { ...workerConfig(), enabled: false })
      },
    },
    {
      label: 'Project owner',
      refusal: /current owner/u,
      settledStage: 'startup',
      change: async (ctx: Awaited<ReturnType<typeof setup>>['ctx'], memberId: AgentTeamMemberId,
        workspaceId: Awaited<ReturnType<typeof setup>>['harness']['workspaceId'], projectRef: AgentTeamProjectRef) => {
        await ctx.agentTeam.removeProjectOwner({ requestId: requestId('owner-changed-at-startup'), workspaceId,
          projectRef, memberId })
      },
    },
    {
      label: 'Member',
      refusal: /not an active Team Member|parent is no longer live|exact live caller/u,
      settledStage: undefined,
      change: async (ctx: Awaited<ReturnType<typeof setup>>['ctx'], memberId: AgentTeamMemberId) => {
        await ctx.agentTeam.suspendMember({ requestId: requestId('member-changed-at-startup'), memberId })
      },
    },
  ])('rechecks the $label when resumed native startup returns', async ({ refusal, settledStage, change }) => {
    const { harness, ctx, agent, member, projectRef, probe } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)

    engine.resumeOpenGate = Promise.withResolvers()
    const opening = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'continue into a retightened Team', requestId: requestId('continue-native-window') })
    const resumed = await waitFor(() => engine.sessions.find(session => session.resume !== undefined), 10_000)
    const ledger = ctx.agentTeam['ledger']!
    await change(ctx, member.memberId, harness.workspaceId, projectRef)
    engine.resumeOpenGate.resolve()

    await expect(opening).rejects.toThrow(refusal)
    expect(engine.disposed).toContain(resumed!.id)
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(1)
    expect(ledger.workerSuccessor(run.workerRef)).toMatchObject({
      state: 'failed', continuedFrom: run.workerRef,
      ...(settledStage === undefined ? {} : { stage: settledStage }),
    })
    if (settledStage === undefined) {
      expect(ledger.workerSuccessor(run.workerRef)?.stage).toBeUndefined()
    }
    expect(resumeProviders(probe, ctx)).toEqual([])
  })

  it('refuses a continuation into an archived Project', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)
    await ctx.agentTeam.archiveProject({ requestId: requestId('project-archived'), workspaceId: harness.workspaceId,
      projectRef })
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'continue after archival', requestId: requestId('continue-archived') }))
      .rejects.toThrow(/cannot receive a continued Worker/)
    expect(engine.sessions.filter(session => session.resume !== undefined)).toHaveLength(0)
  })

  it('refuses continuation when the native record is missing or cleanup is unconfirmed', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    const original = await settledOf(ctx.agentTeam, run.workerRef)
    await rm(original.nativeStorage!)
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'cannot resume missing history', requestId: requestId('continue-missing') }))
      .rejects.toThrow(/no readable native record/)

    engine.disposeFails = true
    engine.release = Promise.withResolvers()
    const second = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run-two'),
      projectRef, task: 'another task', cwd: harness.checkout })
    await expect(ctx.agentTeam.workerStopForAgent(agent, { workerRef: second.workerRef }))
      .rejects.toThrow(/did not confirm its cleanup/)
    const unclean = await settledOf(ctx.agentTeam, second.workerRef)
    expect(unclean).toMatchObject({ state: 'failed', stage: 'dispose' })
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: second.workerRef,
      instruction: 'cannot resume an unclean run', requestId: requestId('continue-unclean') }))
      .rejects.toThrow(/did not confirm its cleanup/)
  })

  it('refuses a run that is stopping instead of sending into a turn that is ending', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.disposeGate = Promise.withResolvers()
    const stopping = ctx.agentTeam.workerStopForAgent(agent, { workerRef: run.workerRef })
    await waitFor(() => ctx.agentTeam['workerRegistry'].liveState(run.workerRef) === 'stopping', 10_000)
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-stopping') }))
      .rejects.toThrow(/is stopping, so nothing was sent/)
    expect(engine.steers).toHaveLength(0)
    engine.disposeGate.resolve()
    await stopping
    expect(await settledOf(ctx.agentTeam, run.workerRef)).toMatchObject({ state: 'stopped' })
    const continued = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'continue after the stop', requestId: requestId('steer-after-stop') })
    expect(continued).toMatchObject({ state: 'started', continuedFrom: run.workerRef })
  })

  it('reports the engine refusal instead of a success', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.answer = { kind: 'rejected', code: 'no_active_turn', reason: 'not_steerable: no active turn' }
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-refused') }))
      .rejects.toThrow(/did not take the instruction over \(no_active_turn\)/)
  })

  it('queues the input in the same native session when the engine exposes no steer control', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    engine.steerable = false
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-queued') }))
      .resolves.toMatchObject({ state: 'submitted', landed: 'queued', runState: 'running' })
    expect(engine.deliveries).toMatchObject([{ landed: 'queued', instruction: 'one more thing' }])
  })

  it('opens the same steer path for a Claude Worker', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout, engine: 'claude' })
    const steered = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-claude') })
    expect(steered).toMatchObject({ engine: 'claude', state: 'submitted', runState: 'running' })
    expect(engine.steers).toHaveLength(1)
    expect(engine.steers[0]?.inputId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  })

  it('retries an explicitly rejected sentence under a fresh request id', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.answer = { kind: 'rejected', code: 'no_active_turn', reason: 'not_steerable: no active turn' }
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-refused') }))
      .rejects.toThrow(/did not take the instruction over \(no_active_turn\)/)

    // The native control explicitly took nothing, so that refusal is not a
    // permanent text dedupe. A fresh id sends the same sentence again.
    engine.answer = { kind: 'accepted', turnId: 'native-turn' }
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-retry') }))
      .resolves.toMatchObject({ state: 'submitted' })
    expect(engine.steers).toHaveLength(2)
  })

  it('keeps a transport-ambiguous sentence deduplicated under a fresh request id', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.steerThrows = true
    const first = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-unknown') })
    await expect(first).rejects.toThrow(/did not take the instruction over \(error\)/)
    engine.steerThrows = false
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-retry') }))
      .rejects.toThrow(/did not take the instruction over \(error\)/)
    expect(engine.steers).toHaveLength(1)
  })

  it('refuses a run this Host no longer holds, leaving it unconfirmed', async () => {
    const { harness, ctx, agent, projectRef, member } = await setup()
    const foreign = 'worker:00000000-0000-4000-8000-0000000000ff' as AgentTeamWorkerRef
    await (ctx.agentTeam['ledger'] as unknown as { recordWorkerStarted(write: unknown): Promise<unknown> })
      .recordWorkerStarted({ requestId: requestId('foreign'),
        actor: { kind: 'member', memberId: member.memberId, handle: member.handle },
        workspaceId: harness.workspaceId, execution: { workerRef: foreign, projectRef, initiatedBy: member.memberId,
          engine: 'codex', task: 'a run from another Host', cwd: harness.checkout, startedAt: new Date().toISOString() } })
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: foreign,
      instruction: 'one more thing', requestId: requestId('steer-foreign') }))
      .rejects.toThrow(/no longer holds its handle/)
  })

  it('answers a resend after the run ended with the first receipt, without reaching the engine', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    const first = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also update the changelog', requestId: requestId('steer-1') })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)
    // The idempotency answer outlives the run: the same request answers with the
    // receipt it already produced, and the engine is never asked again.
    const again = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also update the changelog', requestId: requestId('steer-1') })
    expect(again).toEqual(first)
    expect(engine.steers).toHaveLength(1)
  })

  it('refuses a changed instruction under the same id even after the run ended', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also update the changelog', requestId: requestId('steer-1') })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'something else entirely', requestId: requestId('steer-1') }))
      .rejects.toThrow(/already carried another instruction/)
    expect(engine.steers).toHaveLength(1)
  })

  it('drops the live control when the Host releases its runs', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    await ctx.agentTeam['workerRegistry'].dispose()
    // The Host released every run, so it holds no control to reach: the table is
    // empty, and the answer is the ending the release confirmed.
    expect((ctx.agentTeam['workerRegistry'] as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-after-unload') }))
      .rejects.toThrow(/Team is unloading/)
    expect(engine.steers).toHaveLength(0)
  })

  it('repeats the run state when a stop lands while the answer is being written', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.steerGate = Promise.withResolvers()
    engine.disposeGate = Promise.withResolvers()
    const steered = ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-race') })
    await waitFor(() => engine.steers.length === 1 ? true : undefined, 10_000)
    const stopping = ctx.agentTeam.workerStopForAgent(agent, { workerRef: run.workerRef })
    await waitFor(() => ctx.agentTeam['workerRegistry'].liveState(run.workerRef) === 'stopping', 10_000)
    engine.steerGate.resolve()
    // The engine did take the instruction over, so this is not a refusal — but the
    // receipt says the run was already stopping, instead of a clean success.
    expect(await steered).toMatchObject({ state: 'submitted', runState: 'stopping' })
    engine.disposeGate.resolve()
    await stopping
  })
})
