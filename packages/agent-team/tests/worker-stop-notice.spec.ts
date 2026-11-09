/**
 * The one notice a parent Session receives when a stop cannot confirm its
 * cleanup, composed by the real Harness from the result the Team provider
 * publishes. OAR is mocked here: this pins the seam the acceptance run proves
 * natively, not the engine.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRuntime as SubagentRuntimeService } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@botiverse/oar'
import { cleanups, realHarness, requestId, waitFor } from './helpers/member-harness.ts'
import { WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC } from '../src/worker-runtime.ts'
import type { Config } from '../src/host-row-settings.ts'
import type { AgentTeamProjectRef } from '../src/types.ts'

/** The fake engine streams one line, then holds its turn until the Host aborts it. */
const engine = { text: 'partial output', hangTurn: true, disposeFails: true }

vi.mock('@botiverse/oar', () => ({
  codexRuntime: {
    installation: async () => ({ kind: 'available', via: 'executable', command: '/fake/codex', version: 'x' }),
    session: async (): Promise<Session> => ({
      id: 'native-session-1',
      events: (listener: (event: object) => void) => {
        listener({ sessionId: 'native-session-1', agentPath: [], kind: 'text_delta', text: engine.text, messageId: 'message-1' })
        return () => {}
      },
      prompt: async () => ({ kind: 'accepted', seq: 1 }),
      abort: async () => {},
      dispose: async () => {
        if (engine.disposeFails) throw new Error('the engine process did not exit')
      },
    }) as unknown as Session,
  },
  claudeRuntime: {},
}))

vi.mock('@botiverse/oar/observe', () => ({
  awaitTurnEnd: async () => engine.hangTurn ? new Promise(() => {}) : { kind: 'completed' },
}))

afterEach(async () => {
  engine.text = 'partial output'
  engine.hangTurn = true
  engine.disposeFails = true
  while (cleanups.length > 0) await cleanups.pop()!()
}, 30_000)

/** The Host row with delegation on, which is what the Human has to switch on first. */
const workerRow = (): Config => ({ worker: { enabled: true, defaultEngine: 'codex' as const, timeoutMs: 0,
  engines: { codex: { enabled: true, executable: '/fake/codex', sandbox: 'workspace-write' },
    claude: { enabled: false, executable: '', sandbox: '' } } } }) as unknown as Config

/** Every message the Harness handed this parent, whichever delivery path it chose. */
function watchParent(agent: Agent): UserMessage[] {
  const delivered: UserMessage[] = []
  for (const method of ['inject', 'followup', 'steer'] as const) {
    const original = agent[method].bind(agent)
    Object.defineProperty(agent, method, { configurable: true, writable: true,
      value: (message: UserMessage) => { delivered.push(message); return original(message) } })
  }
  return delivered
}

const textOf = (message: UserMessage): string =>
  message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

describe('the parent notice of a stop that could not confirm its cleanup', () => {
  it('sends no settlement notice for a bound run, whose answer belongs to its Thread and Inbox', async () => {
    const harness = await realHarness()
    const ctx = harness.ctx
    await ctx.plugin(SubagentRuntime)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
      name: 'bound-stop', description: 'Bound stop' })
    const projectRef = project.project.projectRef as AgentTeamProjectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
      handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
      memberId: added.status.member.memberId })
    const agent = ctx.agents.get(added.status.member.sessionId) as Agent
    const thread = await ctx.agentTeam.startThread({ requestId: requestId('thread'), workspaceId: harness.workspaceId,
      projectRef, kind: 'discussion', body: 'Where does the nightly run fail?' })
    if (thread.kind !== 'committed') throw new Error('Thread did not commit')
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }
    const delivered = watchParent(agent)
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'),
      threadRef: thread.thread.threadRef, task: 'check the schedule', cwd: harness.checkout })
    await expect(ctx.agentTeam.workerStopForAgent(agent, { workerRef: run.workerRef }))
      .rejects.toThrow(/did not confirm its cleanup/)
    // The Thread carries the ending and the initiator's Inbox carries the answer;
    // the parent Session is told nothing twice.
    await vi.waitFor(async () => {
      const read = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('read'),
        workspaceId: harness.workspaceId, threadRef: thread.thread.threadRef })
      expect(read.workerStates).toEqual([{ workerRef: run.workerRef, state: 'failed', unconfirmed: false }])
    }, { timeout: 20_000 })
    expect(delivered.filter(message => message.source.kind === 'subagent-settled')).toEqual([])
  }, 60_000)

  it('carries the output and the cleanup verdict once, and never calls the run stopped', async () => {
    const harness = await realHarness()
    const ctx = harness.ctx
    await ctx.plugin(SubagentRuntime)
    const subagents = ctx.get('subagents') as SubagentRuntimeService
    expect(subagents).toBeDefined()

    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: harness.workspaceId,
      name: 'stop-notice', description: 'Stop notice' })
    const projectRef = project.project.projectRef as AgentTeamProjectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: harness.workspaceId,
      handle: 'runner', description: 'Runs work', presetId: 'team-member', projectRefs: [projectRef],
      model: { provider: 'mock', model: 'mock' } })
    const member = added.status.member
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: harness.workspaceId, projectRef,
      memberId: member.memberId })
    const agent = ctx.agents.get(member.sessionId) as Agent

    // The row is read at each open, so this is the same switch the Human sets.
    ;(ctx.agentTeam['config'] as unknown as { worker: unknown }).worker = { get: () => workerRow().worker }
    const delivered = watchParent(agent)
    // A Project-only delegation is the one whose result reaches the parent
    // Session; a bound run's answer belongs to its Thread and Inbox instead.
    const run = await ctx.agentTeam.workerStartForAgent(agent, { requestId: requestId('run'), projectRef,
      task: 'check the schedule', cwd: harness.checkout })
    await waitFor(() => subagents.list().includes('team-worker-codex') ? true : undefined)

    // The engine keeps producing output and then refuses to confirm its exit.
    await expect(ctx.agentTeam.workerStopForAgent(agent, { workerRef: run.workerRef }))
      .rejects.toThrow(/did not confirm its cleanup/)

    // The parent also receives Team wakes; the settlement notice is the one the
    // Harness composes from this run's result.
    const settlement = (): UserMessage | undefined =>
      delivered.find(message => message.source.kind === 'subagent-settled')
    const notice = await waitFor(settlement, 20_000)
    const text = textOf(notice)
    // One notice, and it says what happened: not a stop the Host cannot support.
    expect(delivered.filter(message => message.source.kind === 'subagent-settled')).toHaveLength(1)
    expect(text).not.toContain('was stopped before it finished')
    expect(text).toContain('failed before it finished')
    // The text the run already produced rides the same notice as the caveat.
    expect(text).toContain('partial output')
    expect(text).toContain(WORKER_CLEANUP_UNCONFIRMED_DIAGNOSTIC)
  }, 60_000)
})
