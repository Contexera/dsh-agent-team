import { afterEach, describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { realHarness, ScriptedAdapter, textResponse, waitFor, requestId } from './helpers/member-harness.ts'



describe('Agent Team wake-slot swap delivery windows (ticket 05)', () => {
  it('hands a DM to the swapped-in generation instead of reporting a delivery failure', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('dm-wake-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const sender = await ctx.agentTeam.addMember({ requestId: requestId('dm-wake-sender'), workspaceId, handle: 'sender', description: 'Sends', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const receiver = await ctx.agentTeam.addMember({ requestId: requestId('dm-wake-receiver'), workspaceId, handle: 'receiver', description: 'Receives', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const senderAgent = ctx.agents.get(sender.status.member.sessionId)!
      const receiverAgent = ctx.agents.get(receiver.status.member.sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      receiverAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await receiverAgent.whenIdle()
      pressureState.bySession.set(receiver.status.member.sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      adapter.enqueue(textResponse('Answering the DM from the fresh context.'))
      await expect(ctx.agentTeam.dmForAgent(senderAgent, { requestId: requestId('dm-wake'), workspaceId,
        recipientMemberId: receiver.status.member.memberId, body: 'are you back?' })).resolves.toBeDefined()

      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === receiver.status.member.memberId)
        if (current === undefined || current.member.sessionId === receiver.status.member.sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      const fresh = await vi.waitFor(() => {
        const live = ctx.agents.get(successor)
        if (live === undefined || live.status !== 'idle') throw new Error('successor not idle yet')
        return live
      }, { timeout: 20_000 })
      await fresh.whenIdle()

      // The relay landed in the successor: the DM was recorded durably and the
      // swap never turned into an `AgentTeamDmDeliveryError`.
      const relayed = adapter.requests.map(request => JSON.stringify(request.messages))
        .some(messages => messages.includes('are you back?'))
      expect(relayed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
