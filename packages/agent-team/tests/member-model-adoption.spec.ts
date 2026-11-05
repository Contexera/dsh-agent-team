import { afterEach, describe, expect, it, vi } from 'vitest'
// Every case boots the real Host harness and waits on a real turn, so the same
// per-test budget the sibling lifecycle specs use applies here too.
vi.setConfig({ testTimeout: 60_000 })
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import { cleanups, realHarness, requestId, ScriptedAdapter, textResponse } from './helpers/member-harness.ts'
import type { AgentTeamModelSelection } from '../src/types.ts'

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('Member model adoption from the request header', () => {
  const add = async (
    ctx: Context,
    workspaceId: WorkspaceId,
    handle: string,
    model?: AgentTeamModelSelection,
  ) => ctx.agentTeam.addMember({
    requestId: requestId(`add-${handle}-${crypto.randomUUID()}`), workspaceId, handle,
    description: '', presetId: 'team-member', projectRefs: [],
    ...(model === undefined ? {} : { model }),
  })

  const turn = async (agent: Agent, adapter: ScriptedAdapter, text: string): Promise<void> => {
    adapter.enqueue(textResponse('Noted.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }

  it('records the route the Session actually sent, once, and not on the selection alone', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const added = await add(ctx, workspaceId, 'builder', { provider: 'mock', model: 'start' })
    const memberId = added.status.member.memberId
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const recorded = () => ctx.agentTeam.membersForClient({ workspaceId })
      .find(status => status.member.memberId === memberId)?.member.model
    expect(recorded()).toEqual({ provider: 'mock', model: 'start' })

    // What the composer does upstream: the Session's own selection changes and nothing else.
    agent.model.select({ provider: 'mock', model: 'next' })
    expect(recorded()).toEqual({ provider: 'mock', model: 'start' })

    const before = ctx.agentTeam.status().operationCount
    await turn(agent, adapter, 'Carry on with the change.')
    // Exactly one write: the adoption, and no selection-event write before the request.
    expect(ctx.agentTeam.status().operationCount).toBe(before + 1)
    expect(recorded()).toEqual({ provider: 'mock', model: 'next' })

    // Same route again: the header already matches, so Team's own write-back cannot loop through the ledger.
    await turn(agent, adapter, 'Carry on once more.')
    expect(ctx.agentTeam.status().operationCount).toBe(before + 1)
    expect(recorded()).toEqual({ provider: 'mock', model: 'next' })
  })

  it('leaves the ledger untouched when the request is refused before its header is sent', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const added = await add(ctx, workspaceId, 'builder', { provider: 'mock', model: 'start' })
    const memberId = added.status.member.memberId
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const recorded = () => ctx.agentTeam.membersForClient({ workspaceId })
      .find(status => status.member.memberId === memberId)?.member.model

    // The real guard lives in the Host's compaction plugin, which this harness does not mount; this reproduces the
    // same seam: a prepended `agent/request` hook rejects the switch, so the loop never appends a header.
    ctx.on('agent/request', async () => {
      throw new LlmError(
        'Cannot switch to mock/next: context compaction failed: no safe compaction range can reduce context below threshold.',
        'MODEL_SWITCH_COMPACTION_FAILED',
      )
    }, { prepend: true })
    agent.model.select({ provider: 'mock', model: 'next' })

    const before = ctx.agentTeam.status().operationCount
    adapter.enqueue(textResponse('Never sent.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Switch models now.' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(ctx.agentTeam.status().operationCount).toBe(before)
    expect(recorded()).toEqual({ provider: 'mock', model: 'start' })
    expect(adapter.requests).toHaveLength(0)
  })

  it('rejects creation without a route and refuses to clear one on edit', async () => {
    const { ctx, workspaceId } = await realHarness(new ScriptedAdapter())
    await expect(ctx.agentTeam.addMember({
      requestId: requestId('no-model-add'), workspaceId, handle: 'builder',
      description: '', presetId: 'team-member', projectRefs: [],
    })).rejects.toThrow(/requires an explicit model selection/)

    const added = await add(ctx, workspaceId, 'builder', { provider: 'mock', model: 'start' })
    await expect(ctx.agentTeam.updateMember({
      requestId: requestId('clear-model'), memberId: added.status.member.memberId,
      handle: 'builder', description: '', model: null,
    })).rejects.toThrow(/cannot be cleared/)
    expect(ctx.agentTeam.membersForClient({ workspaceId }).find(status => status.member.memberId === added.status.member.memberId)?.member.model)
      .toEqual({ provider: 'mock', model: 'start' })
  })
})
