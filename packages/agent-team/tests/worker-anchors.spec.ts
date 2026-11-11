/**
 * The anchors a run's ending carries, composed by the real Harness: the result
 * object the Team provider publishes comes back through the manager's settlement
 * unchanged, so a bound run and a Project-only run record the same native
 * identities, and a run that ends before an anchor exists still records its real
 * ending. OAR is mocked here — the released CLI's own post-exit contract is
 * proved by `artifacts/probe-04-native-anchors.mjs`.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@botiverse/oar'
import { cleanups, realHarness, requestId, waitFor } from './helpers/member-harness.ts'
import AgentTeam from '../src/index.ts'
import { startWorkerRun, workerAnchorsOf, WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC, type WorkerSteer } from '../src/worker-runtime.ts'
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

/** What the fake Claude engine reports about its own session; the record path is derived from it. */
const claude = { next: 1, cwd: '/fake/claude-work' }

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
  claudeRuntime: {
    installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/claude', version: '2.1.319' }),
    session: async (): Promise<Session> => {
      const id = `native-claude-${claude.next++}`
      return {
        id,
        events: () => () => {},
        prompt: async () => ({ kind: 'accepted', seq: 1 }),
        abort: async () => {},
        dispose: async () => {},
        records: () => [
          { sessionId: id, agentPath: [], seq: 1, receivedAt: 0, kind: 'frame',
            body: { type: 'system/init', native: { type: 'system', subtype: 'init', session_id: id,
              cwd: claude.cwd, version: '2.1.319' }, events: [] } },
        ],
      } as unknown as Session
    },
  },
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
  claude.next = 1
  claude.cwd = '/fake/claude-work'
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
}, 30_000)

const workerRow = (): Config => ({ worker: { enabled: true, defaultEngine: 'codex' as const, timeoutMs: 0,
  engines: { codex: { enabled: true, executable: '/fake/codex', sandbox: 'workspace-write' },
    claude: { enabled: false, executable: '', sandbox: '' } } } }) as unknown as Config

/** A row whose only enabled engine is Claude: the delegation names no engine and must run the default. */
const claudeRow = (): Config => ({ worker: { enabled: true, defaultEngine: 'claude' as const, timeoutMs: 0,
  engines: { codex: { enabled: false, executable: '', sandbox: 'workspace-write' },
    claude: { enabled: true, executable: '/fake/claude', sandbox: '' } } } }) as unknown as Config

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
async function setup(options: { readonly thread: boolean; readonly ledgerBackend?: 'memory' | 'sqlite' }) {
  const harness = await realHarness(undefined, 'jsonl', undefined, false, undefined, options.ledgerBackend)
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
      expect(execution.nativeTurnIds).toEqual([execution.nativeTurnId])
      expect(execution.nativeInputIds).toHaveLength(1)
      expect(execution.nativeStorage).toBe(`/fake/sessions/2026/11/09/rollout-${execution.nativeSessionId}.jsonl`)
    }
    expect(boundExecution.nativeSessionId).not.toBe(looseExecution.nativeSessionId)

    // What the settlement recorded is what the read-only look-up opens.
    const inspection = await ctx.agentTeam.workerInspectForAgent(agent, { workerRef: bound.workerRef })
    expect(inspection.native).toEqual({ threadId: boundExecution.nativeSessionId, turnId: boundExecution.nativeTurnId,
      turnIds: boundExecution.nativeTurnIds, inputIds: boundExecution.nativeInputIds, storage: boundExecution.nativeStorage })
    expect(inspection.history.kind).toBe('missing')
  }, 60_000)

  it.each([true, false])('records failed cleanup after a completed run (bound: %s)', async thread => {
    const { harness, ctx, projectRef, agent, threadRef } = await setup({ thread })
    engine.turn = 'completed'
    engine.disposeFails = true
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('completed-unclean'),
      ...(threadRef === undefined ? { projectRef } : { threadRef }),
      task: 'finish before cleanup fails', cwd: harness.checkout })
    const execution = await settledOf(ctx.agentTeam, run.workerRef)
    expect(execution).toMatchObject({ state: 'failed', stage: 'dispose' })
    expect(execution.diagnostic).toContain(WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC)
    await expect(ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      requestId: requestId('refuse-unclean-continuation'), instruction: 'do not resume the live old process' }))
      .rejects.toThrow(/did not confirm its cleanup/)
  })

  it('names a Claude run\'s record and the prompt it drove', async () => {
    const { harness, ctx, projectRef, agent } = await setup({ thread: false })
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => claudeRow().worker }
    // A real directory, not a POSIX-shaped literal: the derivation resolves the
    // configured root against the session's cwd, and on Windows that turns a
    // rooted `/fake/...` into the current drive's own absolute path.
    const config = await mkdtemp(join(tmpdir(), 'claude-config-'))
    cleanups.push(async () => { await rm(config, { recursive: true, force: true }) })
    vi.stubEnv('CLAUDE_CONFIG_DIR', config)
    engine.turn = 'completed'
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })
    const execution = await settledOf(ctx.agentTeam, run.workerRef)

    // Claude reports no record path and no turn object: the path is derived from
    // the cwd the session reported, and the turn is the input id OAR wrote as the
    // prompting user message's uuid.
    expect(execution.state).toBe('completed')
    expect(execution.engine).toBe('claude')
    expect(execution.nativeSessionId).toBe('native-claude-1')
    expect(execution.nativeTurnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(execution.nativeStorage).toBe(join(config, 'projects', '-fake-claude-work', 'native-claude-1.jsonl'))
  }, 60_000)

  it('derives a Claude record from the environment the run opened with', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'claude-anchors-'))
    const config = await mkdtemp(join(tmpdir(), 'claude-config-'))
    const home = await mkdtemp(join(tmpdir(), 'claude-home-'))
    const hostConfig = await mkdtemp(join(tmpdir(), 'claude-host-config-'))
    cleanups.push(async () => {
      await Promise.all([cwd, config, home, hostConfig].map(directory => rm(directory, { recursive: true, force: true })))
    })
    claude.cwd = cwd
    engine.turn = 'completed'
    const slug = cwd.replaceAll(/[^A-Za-z0-9]/gu, '-')
    const open = async (env: Record<string, string | null>) => {
      const controller = new AbortController()
      const handle = await startWorkerRun({
        prompt: [{ type: 'text', text: 'check the schedule' }],
        cwd,
        parent: { id: 'session:parent' } as unknown as Agent,
        signal: controller.signal,
      }, { engine: 'claude', env, launchArgs: [] })
      return workerAnchorsOf(await handle.result)?.nativeStorage
    }
    // The home the engine reads is `HOME` on POSIX and `USERPROFILE` on Windows,
    // so a run that moves its home moves both.
    const moved = { HOME: home, USERPROFILE: home }

    // The row's own CLAUDE_CONFIG_DIR wins, a run that only moves its home keeps
    // the record under that home, and the Host's own setting applies when the row
    // names none: the anchors read the environment OAR opened the engine with.
    expect(await open({ OAR_CLAUDE_BIN: '/fake/claude', CLAUDE_CONFIG_DIR: config, ...moved }))
      .toBe(join(config, 'projects', slug, 'native-claude-1.jsonl'))
    expect(await open({ OAR_CLAUDE_BIN: '/fake/claude', ...moved }))
      .toBe(join(home, '.claude', 'projects', slug, 'native-claude-2.jsonl'))
    vi.stubEnv('CLAUDE_CONFIG_DIR', hostConfig)
    expect(await open({ OAR_CLAUDE_BIN: '/fake/claude', ...moved }))
      .toBe(join(hostConfig, 'projects', slug, 'native-claude-3.jsonl'))
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

  it('keeps a running Worker alive when the Host switch is turned off', async () => {
    const { harness, ctx, agent, projectRef } = await setup({ thread: false })
    engine.turn = 'hanging'
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })

    // The switch gates new delegations, not work already in flight: the live
    // Member loses the tool at its next step, while this run keeps its handle.
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker =
      { get: () => ({ ...workerRow().worker, enabled: false }) }
    ctx.emit('loader/volatile-update', [])
    await waitFor(() => ctx.tools.schemas(agent as never).some(tool => tool.name === 'team_worker') ? undefined : true)

    expect(executionOf(ctx.agentTeam, run.workerRef)?.state).toBe('running')
    const stopped = await ctx.agentTeam.workerStopForAgent(agent, { workerRef: run.workerRef })
    expect(stopped.state).toBe('stopped')
    expect(executionOf(ctx.agentTeam, run.workerRef)?.state).toBe('stopped')
  }, 60_000)

  // The sqlite arms pay a durable commit per ledger write, and that cost varies
  // wildly on the windows lane: run #235 crossed the 5s default on both arms
  // while the memory arms settled around 1.2s, and the next run settled at
  // 506ms and 534ms. The budget is 60s rather than the default.
  it.each([
    { ledgerBackend: 'memory' as const, alias: false },
    { ledgerBackend: 'memory' as const, alias: true },
    { ledgerBackend: 'sqlite' as const, alias: false },
    { ledgerBackend: 'sqlite' as const, alias: true },
  ])('replays an active steer after Host reconstruction without reading native history ($ledgerBackend, alias: $alias)',
    async ({ ledgerBackend, alias }) => {
    const { harness, ctx, agent, projectRef, member } = await setup({ thread: false, ledgerBackend })
    engine.turn = 'hanging'
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })
    const deliveries: string[] = []
    const sessions = (ctx.agentTeam as unknown as { workerRegistry: { sessions: Map<string, WorkerSteer> } })
      .workerRegistry.sessions
    sessions.set([...sessions.keys()][0]!, async (instruction, inputId) => {
      deliveries.push(instruction)
      return { kind: 'submitted', inputId, landed: 'steered', turnId: 'turn-native-session-1' }
    })
    const request = { workerRef: run.workerRef, instruction: 'also check tomorrow', requestId: requestId('steer-original') }
    const first = await ctx.agentTeam.workerSteerForAgent(agent, request)
    const retry = { ...request, requestId: alias ? requestId('steer-alias') : request.requestId }
    expect(await ctx.agentTeam.workerSteerForAgent(agent, retry)).toEqual(first)
    const freshAlias = { ...request, requestId: requestId(`steer-fresh-alias-${ledgerBackend}`) }
    expect(await ctx.agentTeam.workerSteerForAgent(agent, freshAlias)).toEqual(first)
    expect(deliveries).toEqual([request.instruction])
    await ctx.agentTeam.workerStopForAgent(agent, { workerRef: run.workerRef })
    const original = await settledOf(ctx.agentTeam, run.workerRef)

    await harness.teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }
    const resumedAgent = ctx.agents.get(member.sessionId) as Agent
    expect(executionOf(ctx.agentTeam, run.workerRef)).toEqual(original)
    // A receipt replay must not depend on a native record still being readable,
    // and must never turn an already submitted request into a continuation.
    await expect(ctx.agentTeam.workerSteerForAgent(resumedAgent, retry)).resolves.toEqual(first)
    await expect(ctx.agentTeam.workerSteerForAgent(resumedAgent, freshAlias)).resolves.toEqual(first)
    await expect(ctx.agentTeam.workerSteerForAgent(resumedAgent, { ...retry, instruction: 'a changed instruction' }))
      .rejects.toThrow(/already carried another instruction/)
    expect(deliveries).toEqual([request.instruction])
    expect(ledgerOf(ctx.agentTeam).workerExecutionsOfMember(member.memberId)).toHaveLength(1)
    expect(executionOf(ctx.agentTeam, run.workerRef)).toEqual(original)
  }, 60_000)

  it('keeps the Thread facts, revision, and execution unchanged when a steer receipt is aliased', async () => {
    const { harness, ctx, agent, threadRef, member } = await setup({ thread: true })
    engine.turn = 'hanging'
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('thread-run'),
      threadRef: threadRef!, task: 'check the schedule', cwd: harness.checkout })
    const sessions = (ctx.agentTeam as unknown as { workerRegistry: { sessions: Map<string, WorkerSteer> } })
      .workerRegistry.sessions
    sessions.set([...sessions.keys()][0]!, async (instruction, inputId) => {
      return { kind: 'submitted', inputId, landed: 'steered', turnId: 'turn-native-session-1' }
    })
    await ctx.agentTeam.readThread({ requestId: requestId('thread-read-baseline'),
      workspaceId: harness.workspaceId, threadRef: threadRef! })
    const before = await ctx.agentTeam.readThread({ requestId: requestId('thread-read-before'),
      workspaceId: harness.workspaceId, threadRef: threadRef! })
    const execution = executionOf(ctx.agentTeam, run.workerRef)

    await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also check tomorrow', requestId: requestId('thread-steer') })
    await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: run.workerRef,
      instruction: 'also check tomorrow', requestId: requestId('thread-steer-alias') })

    const after = await ctx.agentTeam.readThread({ requestId: requestId('thread-read-after'),
      workspaceId: harness.workspaceId, threadRef: threadRef! })
    expect(after.thread.revision).toBe(before.thread.revision)
    expect(after.facts).toEqual(before.facts)
    expect(after.workerStates).toEqual(before.workerStates)
    expect(executionOf(ctx.agentTeam, run.workerRef)).toEqual(execution)
    expect(ledgerOf(ctx.agentTeam).workerExecutionsOfMember(member.memberId)).toHaveLength(1)
  })

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
