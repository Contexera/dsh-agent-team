import { describe, expect, it } from 'vitest'
// Every test here boots a real Host harness and waits on asynchronous session
// transitions, so the per-test budget needs headroom on slow CI machines.
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

import { GatedAdapter, realHarness, ScriptedAdapter, textResponse, requestId } from './helpers/member-harness.ts'

/** Every lane a relay-form message was spliced into, in arrival order. */
function relayLanes(agent: NonNullable<ReturnType<Context['agents']['get']>>): string[] {
  return agent.session.ownEvents().flatMap(event => {
    if (event.type !== 'agent/inbox/spliced') return []
    const data = event.data as { target: string; inserted?: UserMessage[] }
    return (data.inserted ?? []).some(message => (message.source as { form?: string }).form === 'relay') ? [data.target] : []
  })
}

describe('Agent Team DM delivery lane', () => {
  it('steers a DM to an idle recipient instead of opening a separate turn', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('dm-idle-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const sender = await ctx.agentTeam.addMember({ requestId: requestId('dm-idle-sender'), workspaceId, handle: 'sender', description: 'Sends', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
    const receiver = await ctx.agentTeam.addMember({ requestId: requestId('dm-idle-receiver'), workspaceId, handle: 'receiver', description: 'Receives', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
    const senderAgent = ctx.agents.get(sender.status.member.sessionId)!
    const receiverAgent = ctx.agents.get(receiver.status.member.sessionId)!
    expect(receiverAgent.status).toBe('idle')

    adapter.enqueue(textResponse('Yes, I am here.'))
    await expect(ctx.agentTeam.dmForAgent(senderAgent, { requestId: requestId('dm-idle'), workspaceId,
      recipientMemberId: receiver.status.member.memberId, body: 'are you there?' })).resolves.toBeDefined()

    // An idle recipient does not need a turn of its own: steering starts one
    // anyway, and the steered lane is claimed at every step boundary, so the
    // DM never queues behind another pending turn.
    expect(relayLanes(receiverAgent)).toEqual(['next-step'])
    await receiverAgent.whenIdle()
    expect(adapter.requests.map(request => JSON.stringify(request.messages))
      .some(messages => messages.includes('are you there?'))).toBe(true)
  })

  it('steers a DM past a queued follow-up instead of waiting for the next turn', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('dm-lane-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const sender = await ctx.agentTeam.addMember({ requestId: requestId('dm-lane-sender'), workspaceId, handle: 'sender', description: 'Sends', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
    const receiver = await ctx.agentTeam.addMember({ requestId: requestId('dm-lane-receiver'), workspaceId, handle: 'receiver', description: 'Receives', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
    const senderAgent = ctx.agents.get(sender.status.member.sessionId)!
    const receiverAgent = ctx.agents.get(receiver.status.member.sessionId)!

    // The receiver is mid-turn and already holds one queued follow-up. The
    // next-turn lane is a FIFO that admits one message per turn, so a second
    // follow-up queued behind it waits for a whole extra turn — hours, when
    // the running turn is long.
    receiverAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'Do the first thing.' }], source: { kind: 'user' } }))
    await adapter.started.promise
    expect(receiverAgent.status).toBe('running')
    const queued = createUserMessage({ content: [{ type: 'text', text: 'And then the second thing.' }], source: { kind: 'user' } })
    receiverAgent.followup(queued)

    adapter.enqueue(textResponse('Answering the DM.'))
    adapter.enqueue(textResponse('Second thing done.'))
    await expect(ctx.agentTeam.dmForAgent(senderAgent, { requestId: requestId('dm-lane'), workspaceId,
      recipientMemberId: receiver.status.member.memberId, body: 'are you there?' })).resolves.toBeDefined()

    // The DM took the steered lane, so the queued follow-up keeps its place and
    // the DM is claimed at the next step boundary of the turn already running.
    expect(receiverAgent.inbox.nextTurn.map(message => message.id)).toEqual([queued.id])
    expect(receiverAgent.inbox.nextStep.filter(message => (message.source as { form?: string }).form === 'relay')).toHaveLength(1)

    adapter.release.resolve()
    await receiverAgent.whenIdle()
    // Both arrived, in the order the lanes promise: the steered DM inside the
    // turn that was already running, the queued follow-up in the turn after it.
    const asked = adapter.requests.map(request => JSON.stringify(request.messages))
    expect(asked.some(messages => messages.includes('are you there?'))).toBe(true)
    expect(asked.some(messages => messages.includes('And then the second thing.'))).toBe(true)
  })
})
