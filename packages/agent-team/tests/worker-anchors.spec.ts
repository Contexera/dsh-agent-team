/**
 * The anchors a run's ending carries, composed by the real Harness: the result
 * object the Team provider publishes comes back through the manager's settlement
 * unchanged, so a bound run and a Project-only run record the same native
 * identities, and a run that ends before an anchor exists still records its real
 * ending. OAR is mocked here — the released CLI's own post-exit contract is
 * proved by `artifacts/probe-04-native-anchors.mjs`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@botiverse/oar'
import { cleanups, realHarness, requestId, waitFor } from './helpers/member-harness.ts'
import { WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC } from '../src/worker-runtime.ts'
import type { Config } from '../src/host-row-settings.ts'
import type { AgentTeamMemberId, AgentTeamProjectRef, AgentTeamThreadRef, AgentTeamWorkerExecution,
  AgentTeamWorkerRef } from '../src/types.ts'

/** What the fake engine does on the next open: its record stream, its turn, and its disposal verdict. */
const engine = {
  /** Whether the session exposes the engine's own record stream at all. */
  records: true,
  turn: 'failed' as 'failed' | 'completed' | 'hanging' | 'throws',
  /** The engine refuses the prompt itself, so no turn is ever started. */
  promptRejected: false,
  disposeFails: false,
  /** Holds the session open, so a stop can arrive while the start is still opening. */
  opening: undefined as PromiseWithResolvers<void> | undefined,
  next: 1,
}

vi.mock('@botiverse/oar', () => ({
  codexRuntime: {
    installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/codex', version: 'x' }),
    session: async (): Promise<Session> => {
      if (engine.opening !== undefined) await engine.opening.promise
      const id = `native-session-${engine.next++}`
      return {
        id,
        events: () => () => {},
        prompt: async () => engine.promptRejected ? { kind: 'rejected', code: 'busy', reason: 'busy' }
          : { kind: 'accepted', seq: 1 },
        abort: async () => {},
        dispose: async () => { if (engine.disposeFails) throw new Error('the engine process did not exit') },
        ...engine.records ? { records: () => [
          { sessionId: id, agentPath: [], seq: 1, receivedAt: 0, kind: 'frame',
            body: { type: 'thread/start', native: { thread: { id, path: `/fake/sessions/2026/11/09/rollout-${id}.jsonl` } }, events: [] } },
          { sessionId: id, agentPath: [], seq: 2, receivedAt: 0, spanId: `turn-${id}`, kind: 'frame',
            body: { type: 'turn/started', native: {}, events: [] } },
        ] } : {},
      } as unknown as Session
    },
  },
  claudeRuntime: {},
}))

vi.mock('@botiverse/oar/observe', () => ({
  awaitTurnEnd: async () => {
    if (engine.turn === 'throws') throw new Error('the transport closed before the turn reported')
    return engine.turn === 'completed' ? { kind: 'completed' }
      : engine.turn === 'hanging' ? new Promise(() => {}) : { kind: 'failed', failure: 'unknown' }
  },
}))

afterEach(async () => {
  engine.records = true
  engine.turn = 'failed'
  engine.promptRejected = false
  engine.disposeFails = false
  engine.opening = undefined
  engine.next = 1
  while (cleanups.length > 0) await cleanups.pop()!()
}, 30_000)

const workerRow = (): Config => ({ worker: { enabled: true, defaultEngine: 'codex' as const, timeoutMs: 0,
  engines: { codex: { enabled: true, executable: '/fake/codex', sandbox: 'workspace-write' },
    claude: { enabled: false, executable: '', sandbox: '' } } } }) as unknown as Config

/** The Host's own execution record, which no public read exposes: the inspection result is the surface. */
function ledgerOf(team: unknown): { workerExecution(ref: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined
  workerExecutionsOfMember(id: AgentTeamMemberId): readonly AgentTeamWorkerExecution[] } {
  return (team as { readonly ledger: never }).ledger as never
}

const executionOf = (team: unknown, workerRef: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined =>
  ledgerOf(team).workerExecution(workerRef)

const settledOf = async (team: unknown, workerRef: AgentTeamWorkerRef): Promise<AgentTeamWorkerExecution> =>
  waitFor(() => {
    const recorded = executionOf(team, workerRef)
    return recorded?.settledAt === undefined ? undefined : recorded
  }, 20_000)

/** One Project, one owning Member, and — when asked — the Thread a bound delegation needs. */
async function setup(options: { readonly thread: boolean }) {
  const harness = await realHarness()
  const ctx = harness.ctx
  await ctx.plugin(SubagentRuntime)
  const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
    name: 'anchors', description: 'Anchors' })
  const projectRef = project.project.projectRef as AgentTeamProjectRef
  const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
    handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
    model: { provider: 'mock', model: 'mock' } })
  const member = added.status.member
  await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
    memberId: member.memberId })
  const agent = ctx.agents.get(member.sessionId) as Agent
  ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }
  let threadRef: AgentTeamThreadRef | undefined
  if (options.thread) {
    const thread = await ctx.agentTeam.startThread({ requestId: requestId('thread'), workspaceId: harness.workspaceId,
      projectRef, kind: 'discussion', body: 'Where does the nightly run fail?' })
    if (thread.kind !== 'committed') throw new Error('Thread did not commit')
    threadRef = thread.thread.threadRef
  }
  return { harness, ctx, projectRef, member, agent, threadRef }
}

describe('the anchors one run\'s ending carries', () => {
  it('records the same native identities for a bound run and a Project-only run', async () => {
    const { harness, ctx, projectRef, agent, threadRef } = await setup({ thread: true })
    const bound = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('bound'),
      threadRef: threadRef!, task: 'check the schedule', cwd: harness.checkout })
    const boundExecution = await settledOf(ctx.agentTeam, bound.workerRef)
    const loose = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('loose'), projectRef,
      task: 'check the schedule too', cwd: harness.checkout })
    const looseExecution = await settledOf(ctx.agentTeam, loose.workerRef)

    // The delivery differs (a bound run answers its Thread, a Project-only run its
    // parent), but the result object the manager hands back is the same one.
    for (const execution of [boundExecution, looseExecution]) {
      expect(execution.state).toBe('failed')
      expect(execution.stage).toBe('turn')
      expect(execution.nativeSessionId).toMatch(/^native-session-\d+$/)
      expect(execution.nativeTurnId).toBe(`turn-${execution.nativeSessionId}`)
      expect(execution.nativeStorage).toBe(`/fake/sessions/2026/11/09/rollout-${execution.nativeSessionId}.jsonl`)
    }
    expect(boundExecution.nativeSessionId).not.toBe(looseExecution.nativeSessionId)

    // What the settlement recorded is what the read-only look-up opens.
    const inspection = await ctx.agentTeam.workerInspectForAgent(agent, { workerRef: bound.workerRef })
    expect(inspection.native).toEqual({ threadId: boundExecution.nativeSessionId, turnId: boundExecution.nativeTurnId,
      storage: boundExecution.nativeStorage })
    expect(inspection.history.kind).toBe('missing')
  }, 60_000)

  it('keeps the anchors when the turn\'s own wait throws instead of reporting', async () => {
    const { harness, ctx, projectRef, agent } = await setup({ thread: false })
    engine.turn = 'throws'
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })
    const execution = await settledOf(ctx.agentTeam, run.workerRef)

    // The ending is the failure the throw produced, and the session that was
    // already open still names its turn and its record: a settlement path that
    // never reached the turn's own receipt must not lose them.
    expect(execution.state).toBe('failed')
    expect(execution.stage).toBe('turn')
    expect(execution.nativeSessionId).toBe('native-session-1')
    expect(execution.nativeTurnId).toBe('turn-native-session-1')
    expect(execution.nativeStorage).toBe('/fake/sessions/2026/11/09/rollout-native-session-1.jsonl')
  }, 60_000)

  it('keeps the session anchor when the engine refuses the prompt itself', async () => {
    const { harness, ctx, projectRef, agent } = await setup({ thread: false })
    engine.promptRejected = true
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })
    const execution = await settledOf(ctx.agentTeam, run.workerRef)

    // No turn ever started, so there is no turn id — but the session and the
    // record it reported are real and stay readable.
    expect(execution.state).toBe('failed')
    expect(execution.nativeSessionId).toBe('native-session-1')
    expect(execution.nativeTurnId).toBeUndefined()
    expect(execution.nativeStorage).toBe('/fake/sessions/2026/11/09/rollout-native-session-1.jsonl')
  }, 60_000)

  it('keeps the ending the engine reported when it hands back no record stream to read', async () => {
    const { harness, ctx, projectRef, agent } = await setup({ thread: false })
    engine.records = false
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })
    const execution = await settledOf(ctx.agentTeam, run.workerRef)

    // Capturing no anchors is a missing detail, never a different ending.
    expect(execution.state).toBe('failed')
    expect(execution.stage).toBe('turn')
    expect(execution.diagnostic).toBeTruthy()
    expect(execution.nativeSessionId).toBe('native-session-1')
    expect(execution.nativeTurnId).toBeUndefined()
    expect(execution.nativeStorage).toBeUndefined()

    const inspection = await ctx.agentTeam.workerInspectForAgent(agent, { workerRef: run.workerRef })
    expect(inspection.summary).toBe(execution.diagnostic)
    expect(inspection.native).toEqual({ threadId: 'native-session-1' })
    expect(inspection.history).toEqual({ kind: 'unpersisted',
      reason: 'The ending recorded no location for its native record, so there is nothing to look up.' })
  }, 60_000)

  it('records a stop with no anchors when the stop cancels the start before it publishes', async () => {
    const { harness, ctx, member, agent, threadRef } = await setup({ thread: true })
    engine.opening = Promise.withResolvers()
    const starting = ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), threadRef: threadRef!,
      task: 'check the schedule', cwd: harness.checkout })
    const opened = await waitFor(() => ledgerOf(ctx.agentTeam).workerExecutionsOfMember(member.memberId)[0], 20_000)
    const stopping = ctx.agentTeam.workerStopForAgent(agent, { workerRef: opened.workerRef })
    // The engine opens after the stop was requested, so the provider disposes it
    // and reports the cancellation instead of publishing a run nobody asked for.
    engine.opening.resolve()
    expect((await stopping).state).toBe('stopped')
    expect((await starting).state).toBe('stopped')

    const execution = executionOf(ctx.agentTeam, opened.workerRef)!
    expect(execution.state).toBe('stopped')
    expect(execution.stage).toBeUndefined()
    expect(execution.nativeSessionId).toBeUndefined()
    expect(execution.nativeTurnId).toBeUndefined()
    expect(execution.nativeStorage).toBeUndefined()
    const inspection = await ctx.agentTeam.workerInspectForAgent(agent, { workerRef: opened.workerRef })
    // The record says what it recorded, not what the engine might have opened.
    expect(inspection.history).toEqual({ kind: 'unpersisted',
      reason: 'The ending recorded no native session, so there is no native record to look up.' })
  }, 60_000)

  it('keeps the anchors and the cleanup verdict when the engine cannot confirm its disposal', async () => {
    const { harness, ctx, member, agent, projectRef } = await setup({ thread: false })
    engine.turn = 'hanging'
    engine.disposeFails = true
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })

    const stopped = await ctx.agentTeam.stopWorkerForClient({ workspaceId: harness.workspaceId,
      memberId: member.memberId, workerRef: run.workerRef })
    expect(stopped).toMatchObject({ kind: 'ended', state: 'failed', diagnostic: WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC })

    // The anchors were captured before the disposal that failed, so the record
    // still says which native turn could not be confirmed.
    const execution = executionOf(ctx.agentTeam, run.workerRef)!
    expect(execution.state).toBe('failed')
    expect(execution.stage).toBe('dispose')
    expect(execution.nativeSessionId).toBe('native-session-1')
    expect(execution.nativeTurnId).toBe('turn-native-session-1')
    expect(execution.nativeStorage).toBe('/fake/sessions/2026/11/09/rollout-native-session-1.jsonl')
  }, 60_000)

  it('settles a run the Host releases with the anchors it captured before disposal', async () => {
    const { harness, ctx, agent, projectRef } = await setup({ thread: false })
    engine.turn = 'hanging'
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })
    const ledger = ledgerOf(ctx.agentTeam)
    await harness.teamFiber.dispose()

    const execution = ledger.workerExecution(run.workerRef)
    expect(execution?.state).toBe('stopped')
    expect(execution?.nativeSessionId).toBe('native-session-1')
    expect(execution?.nativeTurnId).toBe('turn-native-session-1')
    expect(execution?.nativeStorage).toBe('/fake/sessions/2026/11/09/rollout-native-session-1.jsonl')
  }, 60_000)
})
