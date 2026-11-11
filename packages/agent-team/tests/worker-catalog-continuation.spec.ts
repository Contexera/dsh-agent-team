/**
 * A Project-only Worker continuation opens the original native conversation as
 * a new external execution. The Harness gives each external execution its own
 * catalog identity, so reusing the native session id as `SubagentRun.id` makes
 * the second parent catalog fact a duplicate that the persisted Host cannot
 * rebuild.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@botiverse/oar'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentTeam from '../src/index.ts'
import { cleanups, realHarness, requestId, waitFor } from './helpers/member-harness.ts'
import type { Config } from '../src/host-row-settings.ts'
import type { AgentTeamProjectRef, AgentTeamWorkerExecution, AgentTeamWorkerRef } from '../src/types.ts'

const engine = {
  nativeSessionId: 'native-session-catalog-continuation',
  storageRoot: '',
  sessions: [] as Array<{ readonly id: string; readonly resume?: string | undefined }>,
}

const fakeRuntime = {
  installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/codex', version: 'x' }),
  session: async (_installation: unknown, options?: { readonly resume?: string }): Promise<Session> => {
    const id = options?.resume ?? engine.nativeSessionId
    engine.sessions.push({ id, ...(options?.resume === undefined ? {} : { resume: options.resume }) })
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
    let inputId = ''
    return {
      id,
      events: () => () => {},
      prompt: async (_instruction: string, promptOptions?: { readonly inputId?: string }) => {
        inputId = promptOptions?.inputId ?? ''
        return { kind: 'accepted', seq: 1 }
      },
      deliver: async (_instruction: string, deliverOptions?: { readonly inputId?: string }) => ({
        landed: 'prompted',
        inputId: deliverOptions?.inputId ?? '',
        result: { kind: 'accepted', response: { body: { kind: 'accepted', native: {} } } },
      }),
      abort: async () => {},
      dispose: async () => {},
      records: () => [
        { sessionId: id, agentPath: [], seq: 1, receivedAt: 0, kind: 'frame',
          body: { type: options?.resume === undefined ? 'thread/start' : 'thread/resume',
            native: { thread: { id, path: storage } }, events: [] } },
        { sessionId: id, agentPath: [], seq: 2, receivedAt: 0, spanId: `turn-${id}`, kind: 'frame',
          body: { type: 'turn/started', native: {}, events: [{
            kind: 'user_message', input: 'task', inputId, evidence: 'turn_item', turnId: `turn-${id}`,
          }] } },
      ],
    } as unknown as Session
  },
}

vi.mock('@botiverse/oar', () => ({
  codexRuntime: fakeRuntime,
  claudeRuntime: fakeRuntime,
}))

vi.mock('@botiverse/oar/observe', () => ({
  awaitTurnEnd: async () => ({ kind: 'completed' }),
}))

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  engine.storageRoot = ''
  engine.sessions = []
}, 30_000)

const workerRow = (): Config => ({ worker: { enabled: true, defaultEngine: 'codex' as const, timeoutMs: 0,
  engines: { codex: { enabled: true, executable: '/fake/codex', sandbox: 'workspace-write' },
    claude: { enabled: false, executable: '', sandbox: '' } } } }) as unknown as Config

const executionOf = (team: unknown, workerRef: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined =>
  (team as { readonly ledger: { workerExecution(ref: AgentTeamWorkerRef): AgentTeamWorkerExecution | undefined } })
    .ledger.workerExecution(workerRef)

const settledOf = async (team: unknown, workerRef: AgentTeamWorkerRef): Promise<AgentTeamWorkerExecution> =>
  waitFor(() => {
    const recorded = executionOf(team, workerRef)
    return recorded?.settledAt === undefined ? undefined : recorded
  }, 20_000)

async function setup() {
  const harness = await realHarness()
  const ctx = harness.ctx
  engine.storageRoot = harness.root
  await ctx.plugin(SubagentRuntime)
  const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
    name: 'catalog', description: 'Catalog' })
  const projectRef = project.project.projectRef as AgentTeamProjectRef
  const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
    handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
    model: { provider: 'mock', model: 'mock' } })
  const member = added.status.member
  await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
    memberId: member.memberId })
  const agent = ctx.agents.get(member.sessionId) as Agent
  ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }
  return { harness, ctx, projectRef, member, agent }
}

describe('Project-only Worker continuation identity', () => {
  it('persists one catalog child per external execution and rebuilds the Host', async () => {
    const { harness, ctx, projectRef, member, agent } = await setup()
    const originalRun = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      projectRef, task: 'inspect the first case', cwd: harness.checkout })
    const original = await settledOf(ctx.agentTeam, originalRun.workerRef)
    const nativeSessionId = original.nativeSessionId
    expect(nativeSessionId).toBe(engine.nativeSessionId)

    const continued = await ctx.agentTeam.workerSteerForAgent(agent, { workerRef: originalRun.workerRef,
      instruction: 'inspect the second case', requestId: requestId('continue') })
    expect(continued).toMatchObject({ state: 'started', continuedFrom: originalRun.workerRef })
    const successor = await settledOf(ctx.agentTeam, continued.workerRef)

    // The linked execution keeps the native conversation, while the old record
    // remains immutable and the external catalog gains a second identity.
    expect(successor.nativeSessionId).toBe(nativeSessionId)
    expect(engine.sessions.at(-1)).toMatchObject({ resume: nativeSessionId })
    expect(executionOf(ctx.agentTeam, originalRun.workerRef)).toEqual(original)
    expect(successor.workerRef).not.toBe(originalRun.workerRef)

    await harness.teamFiber.dispose()
    await ctx.sessionPersistence.flush()
    const stored = await ctx.sessionPersistence.open(member.sessionId, 'read')
    const events = (await stored.read()).events
    await stored.close()
    const catalog = events.filter(event => event.type === 'subagent/catalog')
    expect(catalog).toHaveLength(2)
    expect(new Set(catalog.map(event => event.data.childId)).size).toBe(2)

    // A Host rebuild reads the same persisted Member session. Duplicate external
    // child identities make this fail before the Member can activate.
    await ctx.plugin(AgentTeam)
    const restored = await waitFor(() => {
      const status = ctx.agentTeam.members().find(item => item.member.memberId === member.memberId)
      return status?.availability === 'active' ? status : undefined
    })
    expect(restored.member.sessionId).toBe(member.sessionId)
  }, 60_000)
})
