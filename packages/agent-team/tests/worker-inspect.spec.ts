/**
 * Reading one delegated Worker run's diagnostic by its Team-owned number: the
 * anchors the settlement recorded, the engine's own record read back after the
 * process exited, and the authority that decides who may ask. OAR is mocked here
 * because this pins the Team's own seam — the released CLI's post-exit contract
 * is proved separately, by `artifacts/probe-04-native-anchors.mjs`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@botiverse/oar'
import { cleanups, realHarness, requestId, waitFor } from './helpers/member-harness.ts'
import type { Config } from '../src/host-row-settings.ts'
import type { WorkerConfig } from '../src/worker-service.ts'
import type { AgentTeamLedger } from '../src/ledger.ts'
import type { AgentTeamMemberId, AgentTeamProjectRef, AgentTeamWorkerExecution, AgentTeamWorkerRef } from '../src/types.ts'
import { newestEndedRuns, WORKER_RUN_LIST_LIMIT } from '../src/worker-service.ts'

/** What the fake engine does on the next open: where its record lives, and how its turn ends. */
const engine = { storage: undefined as string | undefined, turn: 'failed' as 'failed' | 'completed' | 'hanging',
  open: 'ok' as 'ok' | 'missing',
  /** Ends the turn a `hanging` run is waiting on, so a test can settle runs out of start order. */
  release: undefined as (() => void) | undefined,
  /** Whether each open gets its own session id; the Harness refuses two children under one id. */
  unique: false,
  nextSession: 1,
  /** The Claude mock's reported cwd and the prompt input id it was asked to write. */
  claudeCwd: '/fake/claude-work',
  claudeInputId: undefined as string | undefined }

vi.mock('@botiverse/oar', () => ({
  codexRuntime: {
    installation: async () => engine.open === 'missing'
      ? { kind: 'not_found' }
      : { kind: 'available', via: 'executable', command: '/fake/codex', version: 'x' },
    session: async (): Promise<Session> => {
      const id = engine.unique ? `native-session-${engine.nextSession++}` : 'native-session-1'
      return {
        id,
        events: () => () => {},
        prompt: async () => ({ kind: 'accepted', seq: 1 }),
        abort: async () => {},
        dispose: async () => {},
        records: () => [
          { sessionId: id, agentPath: [], seq: 1, receivedAt: 0, kind: 'frame',
            body: { type: 'thread/start', native: { thread: { id, path: engine.storage } }, events: [] } },
          { sessionId: id, agentPath: [], seq: 2, receivedAt: 0, spanId: 'native-turn-1', kind: 'frame',
            body: { type: 'turn/started', native: {}, events: [] } },
        ],
      } as unknown as Session
    },
  },
  claudeRuntime: {
    installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/claude', version: '2.1.319' }),
    session: async (): Promise<Session> => {
      const id = 'native-claude-1'
      return {
        id,
        events: () => () => {},
        prompt: async (_input: unknown, options?: { readonly inputId?: string }) => {
          engine.claudeInputId = options?.inputId
          return { kind: 'accepted' as const, seq: 1 }
        },
        abort: async () => {},
        dispose: async () => {},
        records: () => [
          { sessionId: id, agentPath: [], seq: 1, receivedAt: 0, kind: 'frame',
            body: { type: 'system/init', native: { type: 'system', subtype: 'init', session_id: id,
              cwd: engine.claudeCwd, version: '2.1.319' }, events: [] } },
        ],
      } as unknown as Session
    },
  },
}))

vi.mock('@botiverse/oar/observe', () => ({
  awaitTurnEnd: async () => engine.turn === 'completed' ? { kind: 'completed' }
    : engine.turn === 'hanging'
      ? new Promise(resolve => { engine.release = () => { resolve({ kind: 'failed', failure: 'unknown' }) } })
      : { kind: 'failed', failure: 'unknown' },
}))

const roots: string[] = []

afterEach(async () => {
  engine.storage = undefined
  engine.turn = 'failed'
  engine.open = 'ok'
  engine.release = undefined
  engine.unique = false
  engine.nextSession = 1
  engine.claudeCwd = '/fake/claude-work'
  engine.claudeInputId = undefined
  vi.unstubAllEnvs()
  while (cleanups.length > 0) await cleanups.pop()!()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}, 30_000)

/**
 * The Host's own execution record, which no public read exposes: the inspection
 * result is the surface, and this is the durable fact behind it.
 */
function executionOf(team: unknown, workerRef: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined {
  const ledger = (team as { readonly ledger?: { workerExecution(ref: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined } }).ledger
  return ledger?.workerExecution(workerRef)
}

function executionsOf(team: unknown, memberId: AgentTeamMemberId): readonly AgentTeamWorkerExecution[] {
  const ledger = (team as { readonly ledger?: {
    workerExecutionsOfMember(id: AgentTeamMemberId): readonly AgentTeamWorkerExecution[] } }).ledger
  return ledger?.workerExecutionsOfMember(memberId) ?? []
}

const workerRow = (): Config => ({ worker: { enabled: true, defaultEngine: 'codex' as const, timeoutMs: 0,
  engines: { codex: { enabled: true, executable: '/fake/codex', sandbox: 'workspace-write' },
    claude: { enabled: false, executable: '', sandbox: '' } } } }) as unknown as Config

/** One native record of the fake engine's failed turn, at a path shaped like the real one. */
async function writeNativeRecord(threadId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'team-worker-inspect-'))
  roots.push(root)
  const directory = join(root, 'sessions', '2026', '11', '09')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `rollout-2026-11-09T12-00-00-${threadId}.jsonl`)
  await writeFile(path, [
    { timestamp: '2026-11-09T12:00:00.000Z', ordinal: 0, type: 'session_meta',
      payload: { session_id: threadId, id: threadId, cli_version: '0.167.0', originator: 'oar', cwd: '/tmp/project' } },
    { type: 'turn_context', payload: { turn_id: 'native-turn-1', model: 'gpt-6.1-sol', approval_policy: 'on-request',
      sandbox_policy: { type: 'read-only' } } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'native-turn-1', duration_ms: 15674,
      last_agent_message: null, error: { message: 'unexpected status 401 Unauthorized' } } },
  ].map(record => `${JSON.stringify(record)}\n`).join(''))
  return path
}

describe('one run\'s diagnostic, read by its Team number', () => {
  it('records the native anchors with the ending and reads the engine\'s own record back', async () => {
    const harness = await realHarness()
    const ctx = harness.ctx
    await ctx.plugin(SubagentRuntime)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
      name: 'inspect', description: 'Inspect' })
    const projectRef = project.project.projectRef as AgentTeamProjectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
      handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    const member = added.status.member
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
      memberId: member.memberId })
    const agent = ctx.agents.get(member.sessionId) as Agent
    const thread = await ctx.agentTeam.startThread({ requestId: requestId('thread'), workspaceId: harness.workspaceId,
      projectRef, kind: 'discussion', body: 'Where does the nightly run fail?' })
    if (thread.kind !== 'committed') throw new Error('Thread did not commit')
    engine.storage = await writeNativeRecord('native-session-1')
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }

    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      threadRef: thread.thread.threadRef, task: 'check the schedule', cwd: harness.checkout })
    const execution = await waitFor(() => {
      const recorded = executionOf(ctx.agentTeam, run.workerRef)
      return recorded?.settledAt === undefined ? undefined : recorded
    }, 20_000)
    expect(execution.state).toBe('failed')
    expect(execution.nativeSessionId).toBe('native-session-1')
    expect(execution.nativeTurnId).toBe('native-turn-1')
    expect(execution.nativeTurnIds).toEqual(['native-turn-1'])
    expect(execution.nativeInputIds).toHaveLength(1)
    expect(execution.nativeStorage).toBe(engine.storage)
    expect(execution.stage).toBe('turn')

    const inspection = await ctx.agentTeam.workerInspectForAgent(agent, { workerRef: run.workerRef })
    expect(inspection.workerRef).toBe(run.workerRef)
    expect(inspection.state).toBe('failed')
    expect(inspection.unconfirmed).toBe(false)
    expect(inspection.summary).toBe(execution.diagnostic)
    expect(inspection.stage).toBe('turn')
    expect(inspection.native).toEqual({ threadId: 'native-session-1', turnId: 'native-turn-1',
      turnIds: ['native-turn-1'], inputIds: execution.nativeInputIds, storage: engine.storage })
    expect(inspection.history.kind).toBe('read')
    if (inspection.history.kind !== 'read') return
    expect(inspection.history.fragments.map(fragment => fragment.kind)).toEqual(['session', 'turn', 'failure'])
    expect(inspection.history.fragments.at(-1)?.text).toBe('Native turn failed after 15674 ms: unexpected status 401 Unauthorized')
  }, 60_000)

  it('reads a Claude run\'s own record after its process exited', async () => {
    const harness = await realHarness()
    const ctx = harness.ctx
    await ctx.plugin(SubagentRuntime)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
      name: 'claude-inspect', description: 'Claude inspect' })
    const projectRef = project.project.projectRef as AgentTeamProjectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
      handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    const member = added.status.member
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
      memberId: member.memberId })
    const agent = ctx.agents.get(member.sessionId) as Agent
    const base = workerRow().worker as unknown as WorkerConfig
    const config = { ...base, defaultEngine: 'claude' as const,
      engines: { ...base.engines, claude: { enabled: true, executable: '/fake/claude', sandbox: '' } } }
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => config }
    const root = await mkdtemp(join(tmpdir(), 'team-worker-claude-'))
    roots.push(root)
    vi.stubEnv('CLAUDE_CONFIG_DIR', root)
    engine.claudeCwd = harness.checkout

    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })
    const execution = await waitFor(() => {
      const recorded = executionOf(ctx.agentTeam, run.workerRef)
      return recorded?.settledAt === undefined ? undefined : recorded
    }, 20_000)
    expect(execution.engine).toBe('claude')
    expect(execution.nativeSessionId).toBe('native-claude-1')
    expect(execution.nativeTurnId).toBe(engine.claudeInputId)
    expect(execution.nativeTurnIds).toEqual([engine.claudeInputId])
    expect(execution.nativeInputIds).toEqual([engine.claudeInputId])
    // The path is derived from the cwd the session reported, not read from a frame.
    const slug = harness.checkout.replaceAll(/[^A-Za-z0-9]/gu, '-')
    const path = join(root, 'projects', slug, 'native-claude-1.jsonl')
    expect(execution.nativeStorage).toBe(path)

    // The process is gone; the record it left is what the look-up opens.
    const turnId = execution.nativeTurnId!
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, [
      { type: 'queue-operation', operation: 'enqueue', sessionId: 'native-claude-1' },
      { type: 'user', uuid: turnId, message: { role: 'user', content: [{ type: 'text', text: 'check the schedule' }] },
        cwd: harness.checkout, version: '2.1.319', permissionMode: 'bypassPermissions', sessionId: 'native-claude-1' },
      { type: 'assistant', message: { role: 'assistant', model: 'claude-probe', content: [{ type: 'text', text: 'answer' }] },
        requestedModel: 'claude-probe', effort: 'high', sessionId: 'native-claude-1' },
      { type: 'system', subtype: 'api_error', level: 'error', error: { formatted: '500 probe boom' }, sessionId: 'native-claude-1' },
    ].map(record => `${JSON.stringify(record)}\n`).join(''))

    const inspection = await ctx.agentTeam.workerInspectForAgent(agent, { workerRef: run.workerRef })
    expect(inspection.engine).toBe('claude')
    expect(inspection.native).toEqual({ threadId: 'native-claude-1', turnId, turnIds: [turnId],
      inputIds: [turnId], storage: path })
    expect(inspection.history.kind).toBe('read')
    if (inspection.history.kind !== 'read') return
    expect(inspection.history.fragments.map(fragment => fragment.kind)).toEqual(['session', 'turn', 'failure'])
    expect(inspection.history.fragments.at(-1)?.text).toBe('Native turn failed: 500 probe boom')
  }, 60_000)

  it('refuses another Member, and answers the Human only for the Member whose surface asked', async () => {
    const harness = await realHarness()
    const ctx = harness.ctx
    await ctx.plugin(SubagentRuntime)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
      name: 'authority', description: 'Authority' })
    const projectRef = project.project.projectRef as AgentTeamProjectRef
    const initiator = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
      handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    const bystander = await ctx.agentTeam.addMember({ requestId: requestId('other'), workspaceId: harness.workspaceId,
      handle: 'watcher', description: 'Watches', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
      memberId: initiator.status.member.memberId })
    const agent = ctx.agents.get(initiator.status.member.sessionId) as Agent
    const otherAgent = ctx.agents.get(bystander.status.member.sessionId) as Agent
    engine.storage = await writeNativeRecord('native-session-1')
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }

    // A Project-only delegation is the other shape of run: no Thread, same record.
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })
    await waitFor(() => executionOf(ctx.agentTeam, run.workerRef)?.settledAt, 20_000)

    await expect(ctx.agentTeam.workerInspectForAgent(otherAgent, { workerRef: run.workerRef }))
      .rejects.toThrow(/or the Human may read its diagnostic/)
    const inspection = await ctx.agentTeam.workerInspectForAgent(agent, { workerRef: run.workerRef })
    expect(inspection.threadRef).toBeUndefined()
    expect(inspection.history.kind).toBe('read')

    const forHuman = await ctx.agentTeam.inspectWorkerForClient({ workspaceId: harness.workspaceId,
      memberId: initiator.status.member.memberId, workerRef: run.workerRef })
    expect(forHuman.workerRef).toBe(run.workerRef)
    await expect(ctx.agentTeam.inspectWorkerForClient({ workspaceId: harness.workspaceId,
      memberId: bystander.status.member.memberId, workerRef: run.workerRef }))
      .rejects.toThrow(/delegated by another Member/)
  }, 60_000)

  it('keeps the Team summary and names the stage when no native session ever opened', async () => {
    const harness = await realHarness()
    const ctx = harness.ctx
    await ctx.plugin(SubagentRuntime)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
      name: 'no-session', description: 'No session' })
    const projectRef = project.project.projectRef as AgentTeamProjectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
      handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
      memberId: added.status.member.memberId })
    const agent = ctx.agents.get(added.status.member.sessionId) as Agent
    engine.open = 'missing'
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }

    await expect(ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })).rejects.toThrow(/installation/)
    const execution = executionsOf(ctx.agentTeam, added.status.member.memberId)[0]
    expect(execution?.state).toBe('failed')
    expect(execution?.stage).toBe('installation')
    expect(execution?.nativeSessionId).toBeUndefined()

    const inspection = await ctx.agentTeam.workerInspectForAgent(agent, { workerRef: execution!.workerRef })
    expect(inspection.stage).toBe('installation')
    expect(inspection.native).toEqual({})
    expect(inspection.summary).toBe(execution!.diagnostic)
    expect(inspection.history).toEqual({ kind: 'unpersisted',
      reason: 'The ending recorded no native session, so there is no native record to look up.' })
  }, 60_000)

  it('lists the newest endings, not the newest starts, inside one bounded window', async () => {
    const harness = await realHarness()
    const ctx = harness.ctx
    await ctx.plugin(SubagentRuntime)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
      name: 'run-list', description: 'Run list' })
    const projectRef = project.project.projectRef as AgentTeamProjectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
      handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    const member = added.status.member
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
      memberId: member.memberId })
    const agent = ctx.agents.get(member.sessionId) as Agent
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }
    engine.unique = true

    // One long run starts first and ends last: a window ordered by start time
    // would drop exactly the record the Human came to read.
    engine.turn = 'hanging'
    const long = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run-long'), projectRef,
      task: 'check the schedule, slowly', cwd: harness.checkout })
    await waitFor(() => engine.release, 20_000)
    engine.turn = 'failed'
    const refs: AgentTeamWorkerRef[] = []
    for (let index = 0; index < WORKER_RUN_LIST_LIMIT; index += 1) {
      const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId(`run-${index}`), projectRef,
        task: `check the schedule ${index}`, cwd: harness.checkout })
      refs.push(run.workerRef)
      await waitFor(() => executionOf(ctx.agentTeam, run.workerRef)?.settledAt, 20_000)
    }
    // A later millisecond keeps the two endings distinct, so the order is decided
    // by the fact and not by a tie.
    await new Promise(resolve => setTimeout(resolve, 5))
    engine.release?.()
    await waitFor(() => executionOf(ctx.agentTeam, long.workerRef)?.settledAt, 20_000)

    const listed = ctx.agentTeam.workerRunsForClient({ workspaceId: harness.workspaceId, memberId: member.memberId })
    const listedRefs = listed.runs.map(run => run.workerRef)
    expect(listed.runs).toHaveLength(WORKER_RUN_LIST_LIMIT)
    expect(listed.runs.every(run => run.state === 'failed')).toBe(true)
    // Started first, ended last: inside the window. Started second, ended first:
    // the one the bound drops.
    expect(listedRefs[0]).toBe(long.workerRef)
    expect(listedRefs).not.toContain(refs[0])
    expect(listedRefs).toContain(refs.at(-1))
    const endings = listed.runs.map(run => Date.parse(executionOf(ctx.agentTeam, run.workerRef)!.settledAt!))
    expect(endings).toEqual([...endings].sort((left, right) => right - left))
  }, 120_000)

  it('keeps a live run inside the window instead of adding it on top', async () => {
    const harness = await realHarness()
    const ctx = harness.ctx
    await ctx.plugin(SubagentRuntime)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
      name: 'live-seat', description: 'Live seat' })
    const projectRef = project.project.projectRef as AgentTeamProjectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
      handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    const member = added.status.member
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
      memberId: member.memberId })
    const agent = ctx.agents.get(member.sessionId) as Agent
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }
    engine.unique = true

    // A run that is still going holds a seat: the list is five rows, not five
    // endings plus whatever is running.
    engine.turn = 'hanging'
    const live = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run-live'), projectRef,
      task: 'hold the turn', cwd: harness.checkout })
    await waitFor(() => engine.release, 20_000)
    engine.turn = 'failed'
    const refs: AgentTeamWorkerRef[] = []
    for (let index = 0; index < WORKER_RUN_LIST_LIMIT; index += 1) {
      const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId(`run-${index}`), projectRef,
        task: `check the schedule ${index}`, cwd: harness.checkout })
      refs.push(run.workerRef)
      await waitFor(() => executionOf(ctx.agentTeam, run.workerRef)?.settledAt, 20_000)
    }

    const listed = ctx.agentTeam.workerRunsForClient({ workspaceId: harness.workspaceId, memberId: member.memberId })
    expect(listed.runs).toHaveLength(WORKER_RUN_LIST_LIMIT)
    // The live row leads and keeps its seat; the ending the window has no room
    // for is the oldest one, never the run that can still be stopped.
    expect(listed.runs[0]!.workerRef).toBe(live.workerRef)
    expect(listed.runs[0]!.state).toBe('running')
    const listedRefs = listed.runs.map(run => run.workerRef)
    expect(listedRefs).not.toContain(refs[0])
    expect(listedRefs).toContain(refs.at(-1))

    await ctx.agentTeam.stopWorkerForClient({ workspaceId: harness.workspaceId,
      memberId: member.memberId, workerRef: live.workerRef })
  }, 120_000)

  it('answers a run whose ending was written before the anchors existed', async () => {
    const harness = await realHarness()
    const ctx = harness.ctx
    await ctx.plugin(SubagentRuntime)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
      name: 'old-ledger', description: 'Old ledger' })
    const projectRef = project.project.projectRef as AgentTeamProjectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
      handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    const member = added.status.member
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
      memberId: member.memberId })

    // Exactly what the version before this ticket wrote: a start and an ending,
    // neither carrying a native identity.
    const legacyRef = 'worker:legacy' as AgentTeamWorkerRef
    const ledger = (ctx.agentTeam as unknown as { ledger: AgentTeamLedger }).ledger
    await ledger.recordWorkerStarted({ requestId: requestId('legacy-start'),
      actor: { kind: 'member', memberId: member.memberId, handle: 'runner' }, workspaceId: harness.workspaceId,
      execution: { workerRef: legacyRef, projectRef, initiatedBy: member.memberId, engine: 'codex',
        task: 'check the schedule', cwd: harness.checkout } })
    await ledger.recordWorkerSettled({ requestId: requestId('legacy-settled'),
      settlement: { workerRef: legacyRef, state: 'failed', diagnostic: 'The Worker ended in a failed turn.' } })

    const inspection = await ctx.agentTeam.inspectWorkerForClient({ workspaceId: harness.workspaceId,
      memberId: member.memberId, workerRef: legacyRef })
    // The Team summary survives, and the missing anchors are named as what the
    // record holds rather than as something the engine did.
    expect(inspection.state).toBe('failed')
    expect(inspection.summary).toBe('The Worker ended in a failed turn.')
    expect(inspection.stage).toBeUndefined()
    expect(inspection.native).toEqual({})
    expect(inspection.history).toEqual({ kind: 'unpersisted',
      reason: 'The ending recorded no native session, so there is no native record to look up.' })
  }, 60_000)

  it('answers a run that has not ended without pretending it has no native session', async () => {
    const harness = await realHarness()
    const ctx = harness.ctx
    await ctx.plugin(SubagentRuntime)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
      name: 'still-running', description: 'Still running' })
    const projectRef = project.project.projectRef as AgentTeamProjectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
      handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
      memberId: added.status.member.memberId })
    const agent = ctx.agents.get(added.status.member.sessionId) as Agent
    engine.storage = await writeNativeRecord('native-session-1')
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }

    // The engine holds its turn, so the run is genuinely still going when asked.
    engine.turn = 'hanging'
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })
    const inspection = await ctx.agentTeam.workerInspectForAgent(agent, { workerRef: run.workerRef as AgentTeamWorkerRef })
    expect(inspection.state).toBe('running')
    expect(inspection.unconfirmed).toBe(false)
    expect(inspection.summary).toBe('The run is still going.')
    // The anchors are written with the ending, so a live run has none to look up —
    // and the report must not claim a live run never opened a native session.
    expect(inspection.native).toEqual({})
    expect(inspection.history).toEqual({ kind: 'unpersisted',
      reason: 'The run has not ended yet; its native record is read once it does.' })
    await ctx.agentTeam.stopWorkerForClient({ workspaceId: harness.workspaceId,
      memberId: added.status.member.memberId, workerRef: run.workerRef })
  }, 60_000)
})

describe('the ended-run window', () => {
  const run = (workerRef: string, startedAt: string, settledAt?: string) =>
    ({ workerRef, startedAt, ...(settledAt === undefined ? {} : { settledAt }) })

  it('orders by the ending, so a run that started early and failed last leads', () => {
    const long = run('worker:long', '2026-11-09T10:00:00.000Z', '2026-11-09T12:00:00.000Z')
    const short = run('worker:short', '2026-11-09T11:00:00.000Z', '2026-11-09T11:01:00.000Z')
    expect(newestEndedRuns([long, short], WORKER_RUN_LIST_LIMIT).map(entry => entry.workerRef))
      .toEqual(['worker:long', 'worker:short'])
  })

  it('keeps the newest endings and drops the earlier ones', () => {
    const ended = Array.from({ length: WORKER_RUN_LIST_LIMIT + 2 }, (_, index) => run(`worker:${index}`,
      new Date(Date.UTC(2026, 10, 9, 10, index)).toISOString(),
      new Date(Date.UTC(2026, 10, 9, 12, index)).toISOString()))
    const window = newestEndedRuns(ended, WORKER_RUN_LIST_LIMIT)
    expect(window).toHaveLength(WORKER_RUN_LIST_LIMIT)
    expect(window[0]!.workerRef).toBe(`worker:${WORKER_RUN_LIST_LIMIT + 1}`)
    expect(window.map(entry => entry.workerRef)).not.toContain('worker:0')
    expect(window.map(entry => entry.workerRef)).not.toContain('worker:1')
  })
})
