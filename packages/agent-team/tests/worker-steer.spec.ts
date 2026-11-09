/**
 * Adding one instruction to a Worker turn that is already running, through the
 * Host: who may ask, what the engine's own control answers, and what a stop or an
 * ending that lands meanwhile is allowed to report.
 *
 * OAR is mocked here because the cases are about the decisions Team owns; the
 * released CLI's same-turn contract — a steer submitted while a tool runs reaches
 * the next model request of the same turn, and a late one is refused — is proved
 * against the real binary by `artifacts/probe-05-steer.mjs`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@botiverse/oar'
import { cleanups, realHarness, requestId, waitFor } from './helpers/member-harness.ts'
import type { Config } from '../src/host-row-settings.ts'
import type { AgentTeamMemberId, AgentTeamProjectRef, AgentTeamWorkerExecution,
  AgentTeamWorkerRef } from '../src/types.ts'

/** What the fake engine does on the next open: its turn, its steer answer, its disposal. */
const engine = {
  turn: 'hanging' as 'failed' | 'completed' | 'hanging',
  /** Releasing this ends the hanging turn, as a Worker that finishes its work does. */
  release: undefined as PromiseWithResolvers<void> | undefined,
  /** Whether the session exposes a same-turn control at all. */
  steerable: true,
  /** The engine's answer to the next steer: accepted with a turn id, or a typed refusal. */
  answer: { kind: 'accepted', turnId: 'native-turn' } as
    | { readonly kind: 'accepted'; readonly turnId?: string | undefined }
    | { readonly kind: 'rejected'; readonly code: string; readonly reason: string },
  /** Every steer the engine was actually asked for, in order. */
  steers: [] as Array<{ readonly sessionId: string; readonly instruction: string; readonly inputId: string }>,
  /** Holds a steer open, so a stop can land while the answer is still being written. */
  steerGate: undefined as PromiseWithResolvers<void> | undefined,
  /** Holds disposal open, so a run stays stopping. */
  disposeGate: undefined as PromiseWithResolvers<void> | undefined,
  next: 1,
}

const fakeRuntime = {
  installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/engine', version: 'x' }),
  session: async (): Promise<Session> => {
    const id = `native-session-${engine.next++}`
    return {
      id,
      events: () => () => {},
      prompt: async () => ({ kind: 'accepted', seq: 1 }),
      ...engine.steerable ? {
        steer: async (instruction: string, options?: { readonly inputId?: string }) => {
          engine.steers.push({ sessionId: id, instruction, inputId: options?.inputId ?? '' })
          if (engine.steerGate !== undefined) await engine.steerGate.promise
          return engine.answer.kind === 'accepted'
            ? { kind: 'accepted', response: { body: { kind: 'accepted', native: { turnId: engine.answer.turnId } } } }
            : { kind: 'rejected', code: engine.answer.code, reason: engine.answer.reason,
              response: { body: { kind: 'rejected', code: engine.answer.code, reason: engine.answer.reason } } }
        },
      } : {},
      abort: async () => {},
      dispose: async () => { if (engine.disposeGate !== undefined) await engine.disposeGate.promise },
      records: () => [
        { sessionId: id, agentPath: [], seq: 1, receivedAt: 0, kind: 'frame',
          body: { type: 'thread/start', native: { thread: { id, path: `/fake/sessions/2026/11/10/rollout-${id}.jsonl` } }, events: [] } },
        { sessionId: id, agentPath: [], seq: 2, receivedAt: 0, spanId: `turn-${id}`, kind: 'frame',
          body: { type: 'turn/started', native: {}, events: [] } },
      ],
    } as unknown as Session
  },
}

vi.mock('@botiverse/oar', () => ({
  codexRuntime: fakeRuntime,
  claudeRuntime: fakeRuntime,
}))

vi.mock('@botiverse/oar/observe', () => ({
  awaitTurnEnd: async () => engine.turn === 'completed' ? { kind: 'completed' }
    : engine.turn === 'hanging' ? engine.release!.promise.then(() => ({ kind: 'completed' }))
      : { kind: 'failed', failure: 'unknown' },
}))

afterEach(async () => {
  engine.turn = 'hanging'
  engine.release?.resolve()
  engine.release = undefined
  engine.steerable = true
  engine.answer = { kind: 'accepted', turnId: 'native-turn' }
  engine.steers = []
  engine.steerGate?.resolve()
  engine.steerGate = undefined
  engine.disposeGate?.resolve()
  engine.disposeGate = undefined
  engine.next = 1
  while (cleanups.length > 0) await cleanups.pop()!()
}, 30_000)

const workerRow = (): Config => ({ worker: { enabled: true, defaultEngine: 'codex' as const, timeoutMs: 0,
  engines: { codex: { enabled: true, executable: '/fake/codex', sandbox: 'workspace-write' },
    claude: { enabled: true, executable: '/fake/claude', sandbox: '' } } } }) as unknown as Config

const executionOf = (team: unknown, workerRef: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined =>
  (team as { readonly ledger: { workerExecution(ref: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined } })
    .ledger.workerExecution(workerRef)

const settledOf = async (team: unknown, workerRef: AgentTeamWorkerRef): Promise<AgentTeamWorkerExecution> =>
  waitFor(() => {
    const recorded = executionOf(team, workerRef)
    return recorded?.settledAt === undefined ? undefined : recorded
  }, 20_000)

/** One Project, one owning Member, and a second Member who owns nothing here. */
async function setup() {
  // Each run's turn hangs until its own test releases it, so a steer always
  // arrives while the engine is still executing.
  engine.release = Promise.withResolvers()
  const harness = await realHarness()
  const ctx = harness.ctx
  await ctx.plugin(SubagentRuntime)
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
  ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }
  return {
    harness, ctx, projectRef, member,
    agent: ctx.agents.get(member.sessionId) as Agent,
    otherAgent: ctx.agents.get(other.status.member.sessionId) as Agent,
    otherId: other.status.member.memberId as AgentTeamMemberId,
  }
}

describe('one instruction into a running turn', () => {
  it('reports submitted with the turn the engine named, and never starts a second turn', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    const steered = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also update the changelog', requestId: requestId('steer-1') })
    expect(steered).toMatchObject({ workerRef: run.workerRef, engine: 'codex', state: 'submitted',
      turnId: 'native-turn', runState: 'running' })
    // One instruction, one engine call, carrying the Team's request id as the
    // native input identity.
    expect(engine.steers).toEqual([{ sessionId: expect.stringMatching(/^native-session-/u),
      instruction: 'also update the changelog', inputId: 'steer-1' }])
    // The run is still the one execution: no second opening record, no second turn.
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

  it('refuses a run that already ended, with the state it ended in', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    engine.release!.resolve()
    await settledOf(ctx.agentTeam, run.workerRef)
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-late') }))
      .rejects.toThrow(/already ended: completed/)
    expect(engine.steers).toHaveLength(0)
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

  it('refuses an engine session that exposes no same-turn control', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    engine.steerable = false
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout })
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-unsupported') }))
      .rejects.toThrow(/exposes no same-turn control/)
  })

  it('refuses an engine whose same-turn control this version does not open', async () => {
    const { harness, ctx, agent, projectRef } = await setup()
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'refactor the parser', cwd: harness.checkout, engine: 'claude' })
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'one more thing', requestId: requestId('steer-claude') }))
      .rejects.toThrow(/does not open yet, so no instruction was sent/)
    expect(engine.steers).toHaveLength(0)
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
      .rejects.toThrow(/already ended: stopped/)
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
    await waitFor(() => engine.steers.length === 1, 10_000)
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
