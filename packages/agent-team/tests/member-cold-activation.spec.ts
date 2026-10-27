import { afterEach, describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })
import AgentTeam from '../src/index.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { SessionId } from '@deepseek-ai/dsh-session'

import { realHarness, ScriptedAdapter, textResponse, waitFor, waitForArchive, requestId } from './helpers/member-harness.ts'



describe('Agent Team cold-generation activation (ticket 05)', () => {
  it('starts a fresh generation at startup instead of resuming a cold, large Session', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState, teamFiber } = await realHarness(adapter)
      const added = await ctx.agentTeam.addMember({ requestId: requestId('boot-wake-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      // A restart re-activates from the ledger binding alone: the stored log is
      // priced first, and a cold generation is never even resumed.
      await teamFiber.dispose()
      await ctx.plugin(AgentTeam)

      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      expect(ctx.agents.get(successor)).toBeDefined()
      expect(ctx.agents.get(sessionId)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a cold Session that holds pending ordinary input instead of retiring it at startup', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState, teamFiber } = await realHarness(adapter)
      const added = await ctx.agentTeam.addMember({ requestId: requestId('boot-pending-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      // The Host stops with one ordinary message still pending in the durable
      // inbox: the input was accepted, has no owning turn yet, and the swap must
      // not discard it. Written through the persistence seam so the log stays a
      // legal stored Session rather than a hand-built fixture.
      await teamFiber.dispose()
      const pending = createUserMessage({ content: [{ type: 'text', text: 'pending ordinary input across the restart' }], source: { kind: 'user' } })
      const handle = await ctx.sessionPersistence.open(sessionId, 'write')
      try {
        const stored = await handle.read()
        await handle.append([{
          type: 'agent/inbox/spliced', seq: stored.events.length, time: Date.now(),
          data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [pending] },
        } as never])
        await handle.flush()
      } finally {
        await handle.close()
      }

      await ctx.plugin(AgentTeam)

      const resumed = await vi.waitFor(() => {
        const live = ctx.agents.get(sessionId)
        if (live === undefined) throw new Error('not reactivated yet')
        return live
      }, { timeout: 20_000 })
      // The pending input is the reason this cold, large Session was kept: a
      // generation holding accepted work is never swapped away from it.
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
      expect(resumed.inbox.nextTurn.map(message => JSON.stringify(message.content))).toContain(JSON.stringify([{ type: 'text', text: 'pending ordinary input across the restart' }]))
      expect(ctx.agentTeam['ledger']!.lastTransitionForMember(memberId)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('swaps a cold generation reached through resume, inside that request\'s own lifecycle chain', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const added = await ctx.agentTeam.addMember({ requestId: requestId('resume-wake-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)
      await ctx.agentTeam.suspendMember({ requestId: requestId('resume-wake-suspend'), memberId })
      adapter.enqueue(textResponse('Resumed into a fresh context.'))

      // Resume activates the stored, cold Session from inside its own lifecycle
      // chain; the swap that activation requests must run in that frame rather
      // than queue behind the operation awaiting it.
      const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume-wake'), memberId })
      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      expect(String(successor)).toMatch(/^agent-team-recycle-[0-9a-f]{64}$/)
      expect(ctx.agents.get(successor)).toBeDefined()
      await waitForArchive(ctx, sessionId)
      expect(resumed.status.member.sessionId).toBe(sessionId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes the stored Session at startup while the cache may still be warm', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState, teamFiber } = await realHarness(adapter)
      const added = await ctx.agentTeam.addMember({ requestId: requestId('boot-warm-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      await teamFiber.dispose()
      await ctx.plugin(AgentTeam)

      await vi.waitFor(() => {
        const live = ctx.agents.get(sessionId)
        if (live === undefined) throw new Error('not reactivated yet')
      }, { timeout: 20_000 })
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
    } finally {
      vi.useRealTimers()
    }
  })
})
