import { afterEach, describe, expect, it, vi } from 'vitest'
// The generation-swap case boots a real Host harness and waits on asynchronous
// Session transitions, so both this budget and the waitFor deadline need headroom.
vi.setConfig({ testTimeout: 60_000 })
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { PROJECT_OWNER_SECTION } from '../src/project-owner-guidance.ts'
import { cleanups, realHarness, ScriptedAdapter, textResponse, requestId, waitFor, waitForIdle } from './helpers/member-harness.ts'

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

/** The text one assembly carries for the owner section; empty when the scope registers none. */
async function sectionText(agent: Agent): Promise<string> {
  const assembly = await agent.ctx.systemPrompt.assemble({ scope: agent })
  return assembly.sections.find(section => section.name === PROJECT_OWNER_SECTION)?.text ?? ''
}

/** The system prompt a loop-built request sends: its leading system-role message. */
function systemText(request: GenerateOptions): string {
  const [first] = request.messages
  if (first === undefined || first.role !== 'system') return ''
  return first.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** The tools one request declares, by name. */
function declaredTools(request: GenerateOptions): readonly string[] {
  return (request.tools ?? []).map(tool => tool.name)
}

/** Flip the Host row's Worker switch and deliver the volatile update a settings write emits. */
function setWorkerSwitch(ctx: Context, enabled: boolean): void {
  const config = ctx.agentTeam.config as unknown as { worker: { get(): { enabled: boolean } } }
  const current = config.worker.get()
  config.worker = { get: () => ({ ...current, enabled }) }
  ctx.emit('loader/volatile-update', [])
}

/** One Project, one Member that joined it, and the handle the assertions read. */
async function ownedMember(handle: string, owner: boolean) {
  const adapter = new ScriptedAdapter()
  const harness = await realHarness(adapter)
  const { ctx, workspaceId } = harness
  const project = await ctx.agentTeam.createProject({ requestId: requestId(`${handle}-project`), workspaceId,
    name: 'engineering', description: 'Engineering work' })
  const added = await ctx.agentTeam.addMember({ requestId: requestId(`${handle}-add`), workspaceId,
    handle, description: 'Owns the work', presetId: 'team-member',
    projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' } })
  const agent = ctx.agents.get(added.status.member.sessionId)!
  const grant = async (): Promise<void> => {
    adapter.enqueue(textResponse('Noted the ownership.'))
    await ctx.agentTeam.addProjectOwner({ requestId: requestId(`${handle}-owner`), workspaceId,
      projectRef: project.project.projectRef, memberId: added.status.member.memberId })
    await waitForIdle(ctx, agent)
  }
  if (owner) await grant()
  return { ...harness, adapter, agent, projectRef: project.project.projectRef, memberId: added.status.member.memberId, grant }
}

describe('Project-owner guidance section', () => {
  it('carries owner duties only while the Member owns a Project', async () => {
    const { ctx, workspaceId, adapter, agent, projectRef, memberId, grant } = await ownedMember('builder', false)
    // A Project member that owns nothing is told nothing: the section is
    // registered, but its provider contributes no text.
    expect(await sectionText(agent)).toBe('')

    await grant()

    // The grant reaches the live generation without a restart, and the waking
    // request already carried the duties.
    expect(await sectionText(agent)).toContain('# Owning a Project')
    expect(systemText(adapter.requests[0]!)).toContain('# Owning a Project')

    adapter.enqueue(textResponse('Noted the withdrawal.'))
    await ctx.agentTeam.removeProjectOwner({ requestId: requestId('builder-withdraw'), workspaceId, projectRef, memberId })
    await waitForIdle(ctx, agent)
    // Ownership is read at each assembly, so the withdrawal is already in effect.
    expect(await sectionText(agent)).toBe('')
  })

  it('adds the Worker paragraph only while the Host switch is on, and the tool follows the same switch', async () => {
    const { ctx, adapter, agent } = await ownedMember('worker-owner', true)
    // Off: the duties stand, the Worker paragraph and the tool do not.
    expect(await sectionText(agent)).toContain('# Owning a Project')
    expect(await sectionText(agent)).not.toContain('# Local Workers')
    expect(await sectionText(agent)).not.toContain('team_worker')

    setWorkerSwitch(ctx, true)
    await waitFor(() => ctx.tools.schemas(agent as never).some(schema => schema.name === 'team_worker') ? true : undefined)
    adapter.enqueue(textResponse('The switch is on.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check the surface.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const withWorker = adapter.requests.at(-1)!
    expect(systemText(withWorker)).toContain('# Local Workers')
    expect(declaredTools(withWorker)).toContain('team_worker')

    setWorkerSwitch(ctx, false)
    await waitFor(() => ctx.tools.schemas(agent as never).some(schema => schema.name === 'team_worker') ? undefined : true)
    adapter.enqueue(textResponse('The switch is off.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check the surface again.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const withoutWorker = adapter.requests.at(-1)!
    expect(systemText(withoutWorker)).toContain('# Owning a Project')
    expect(systemText(withoutWorker)).not.toContain('# Local Workers')
    expect(declaredTools(withoutWorker)).not.toContain('team_worker')
  })

  it('keeps the section through a compaction of the Member Session', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter, 'jsonl', undefined, true)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('compact-project'), workspaceId,
      name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('compact-add'), workspaceId,
      handle: 'builder', description: 'Owns the work', presetId: 'team-member',
      projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' } })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    adapter.enqueue(textResponse('Noted the ownership.'))
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('compact-owner'), workspaceId,
      projectRef: project.project.projectRef, memberId: added.status.member.memberId })
    await waitForIdle(ctx, agent)
    expect(systemText(adapter.requests.at(-1)!)).toContain('# Owning a Project')

    // A real compaction rewrites the Session's messages; the section is a scope
    // registration, so the next request must still carry it. The harness meter
    // prices one node at the head, while a compaction needs the priced surface to
    // match the Session's own, so this test prices it per node with a recent tail
    // above the retention budget.
    const meter = ctx.tokenMeter as unknown as {
      measure(session: { surface: { nodes: readonly number[] } }): {
        totalTokens: number
        nodes: { seq: number; tokens: number; heuristicTokens: number }[]
      }
    }
    meter.measure = session => {
      const nodes = session.surface.nodes.map((seq, index) => {
        const tokens = index === session.surface.nodes.length - 1 ? 40_000 : 100
        return { seq, tokens, heuristicTokens: tokens }
      })
      return { totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0), nodes }
    }
    const engine = ctx.agentPresets.serviceFor(agent, 'compaction') as unknown as {
      compactNow(agent: Agent, signal: AbortSignal): Promise<unknown>
    }
    // The summary call answers like a provider that reports no usage: the
    // engine records the summary text, not a streamed usage object.
    adapter.enqueue([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Durable checkpoint: continue the requested work.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await engine.compactNow(agent, new AbortController().signal)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/end')).toHaveLength(1)

    adapter.enqueue(textResponse('After the checkpoint.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(systemText(adapter.requests.at(-1)!)).toContain('# Owning a Project')
  })

  it('registers the section again when a wake swaps the Member generation', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('swap-project'), workspaceId,
        name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('swap-add'), workspaceId,
        handle: 'builder', description: 'Owns the work', presetId: 'team-member',
        projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' } })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('Noted the ownership.'))
      await ctx.agentTeam.addProjectOwner({ requestId: requestId('swap-owner'), workspaceId,
        projectRef: project.project.projectRef, memberId })
      await waitForIdle(ctx, agent)
      expect(systemText(adapter.requests.at(-1)!)).toContain('# Owning a Project')

      // Idle past the cache TTL with a large context: the next wake replaces the
      // generation instead of resuming it.
      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)
      adapter.enqueue(textResponse('Read the waking message in the fresh context.'))
      await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('swap-wake'), workspaceId,
        projectRef: project.project.projectRef, body: '@builder Please pick this up now' })
      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      })
      const successorAgent = await vi.waitFor(() => {
        const live = ctx.agents.get(successor)
        if (live === undefined) throw new Error('successor not live yet')
        return live
      })
      await waitForIdle(ctx, successorAgent)
      // The new generation registered its own section: the successor's first
      // request carries the duties the previous generation carried.
      expect(systemText(adapter.requests.at(-1)!)).toContain('# Owning a Project')
      expect(await sectionText(successorAgent)).toContain('# Owning a Project')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an ordinary Session without the section', async () => {
    const { ctx } = await ownedMember('ordinary-owner', true)
    const ordinary = await ctx.agents.create({ sessionId: SessionId('owner-guidance-ordinary') })
    cleanups.push(async () => { await ordinary.dispose() })
    const assembly = await ordinary.agent.ctx.systemPrompt.assemble({ scope: ordinary.agent })
    expect(assembly.sections.map(section => section.name)).not.toContain(PROJECT_OWNER_SECTION)
  })
})
