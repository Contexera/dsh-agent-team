import { describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { realHarness, ScriptedAdapter, textResponse, requestId } from './helpers/member-harness.ts'

describe('Agent Team wake-slot swap delivery windows (ticket 05)', () => {
  it('hands a DM to the swapped-in generation instead of reporting a delivery failure', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const h = await realHarness(adapter)
      const project = await h.human.createProject('engineering')
      const sender = await h.human.addMember('sender', { description: 'Sends', projects: [project] })
      const receiver = await h.human.addMember('receiver', { description: 'Receives', projects: [project] })
      adapter.enqueue(textResponse('First look done.'))
      receiver.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await receiver.waitForIdle()
      h.pressureState.bySession.set(receiver.sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      adapter.enqueue(textResponse('Answering the DM from the fresh context.'))
      await expect(h.ctx.agentTeam.dmForAgent(sender.agent, { requestId: requestId('dm-wake'), workspaceId: h.workspaceId,
        recipientMemberId: receiver.memberId, body: 'are you back?' })).resolves.toBeDefined()

      const successor = await vi.waitFor(() => {
        const current = h.ctx.agentTeam.members().find(entry => entry.member.memberId === receiver.memberId)
        if (current === undefined || current.member.sessionId === receiver.sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      const fresh = await vi.waitFor(() => {
        const live = h.ctx.agents.get(successor)
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
