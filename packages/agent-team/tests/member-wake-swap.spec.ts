import { describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
import type { AgentTeamMemberId } from '../src/types.ts'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { SessionId } from '@deepseek-ai/dsh-session'

import { realHarness, ScriptedAdapter, textResponse, waitForArchive, requestId } from './helpers/member-harness.ts'

describe('Agent Team wake-slot generation swap (ticket 05)', () => {
  /**
   * One Member with a real log, priced above the context waterline, woken after
   * `idleMs` of wall clock. The clock is moved rather than the timestamps: the
   * decision reads `Date.now()` against the log's own event times.
   */
  async function coldMember(idleMs: number, contextTokens: number): Promise<{
    readonly ctx: Context
    readonly adapter: ScriptedAdapter
    readonly memberId: AgentTeamMemberId
    readonly sessionId: SessionId
    readonly pressureState: { usageTokens: number; bySession: Map<string, number>; failFor: Set<string> }
  }> {
    const adapter = new ScriptedAdapter()
    const h = await realHarness(adapter)
    const project = await h.human.createProject('engineering')
    const builder = await h.human.addMember('builder', { description: 'Builds changes', projects: [project] })
    adapter.enqueue(textResponse('First look done.'))
    builder.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
    await builder.waitForIdle()
    h.pressureState.bySession.set(builder.sessionId, contextTokens)
    await vi.advanceTimersByTimeAsync(idleMs)
    return { ctx: h.ctx, adapter, memberId: builder.memberId, sessionId: builder.sessionId, pressureState: h.pressureState }
  }

  it('swaps a generation that idled past the cache TTL with a large context, and the waking message opens the new one', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { ctx, adapter, memberId, sessionId } = await coldMember(61 * 60_000, 130_000)
      const workspaceId = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!.member.workspaceId
      const projectRef = ctx.agentTeam.view({ workspaceId }).projects[0]!.projectRef

      adapter.enqueue(textResponse('Read the waking message in the fresh context.'))
      const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('wake-message'), workspaceId,
        projectRef, body: '@builder Please pick this up now' })
      expect(sent.kind).toBe('committed')

      // The swap runs through the lifecycle queue; fake timers only move the
      // clock, so the chain is driven by advancing the timer queue itself.
      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      // The retired log is archived, never deleted, and the binding moved.
      await waitForArchive(ctx, sessionId)
      // Availability flips to active only once the successor's Agent is live;
      // reading it immediately after the binding moved sees the window in
      // between, so wait for the settled value instead of a one-shot read.
      await vi.waitFor(() => {
        const availability = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.availability
        if (availability !== 'active') throw new Error(`member not active yet: ${availability}`)
      }, { timeout: 20_000 })
      const firstRequest = await vi.waitFor(() => {
        const asked = adapter.requests.find(request => JSON.stringify(request.messages).includes('Please pick this up now'))
        if (asked === undefined) throw new Error('the successor has not asked the model yet')
        expect(asked.sessionId).toBe(successor)
        return JSON.stringify(asked.messages)
      }, { timeout: 20_000 })
      // The successor's own request carries the waking message and the ordinary
      // per-step environment block — nothing announces a swap.
      expect(firstRequest).toContain('Team identity: you are @builder')
      expect(firstRequest).not.toMatch(/handoff|new generation|previous context|context was (?:reset|rebuilt)/i)
      expect(ctx.agentTeam['ledger']!.status().sequence).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers into the same generation when the idle gap is under the cache TTL', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { ctx, adapter, memberId, sessionId } = await coldMember(59 * 60_000, 130_000)
      const workspaceId = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!.member.workspaceId
      const projectRef = ctx.agentTeam.view({ workspaceId }).projects[0]!.projectRef
      const agent = ctx.agents.get(sessionId)!

      // Pricing a generation for the wake decision is a full replay, so it must
      // stay behind the idle gate: a wake that fails the cheap gates never asks
      // the Host to price the swap. The spy reads the Host's own pricing entry
      // (not the shared meter, which the running 256K hard boundary reads every
      // step), so the assertion names the wake decision alone.
      const price = vi.spyOn(ctx.agentTeam as never as { measureLiveContext: (agent: unknown) => unknown }, 'measureLiveContext')
      adapter.enqueue(textResponse('Continuing in the same context.'))
      const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('warm-message'), workspaceId,
        projectRef, body: '@builder Continue please' })
      expect(sent.kind).toBe('committed')
      await agent.whenIdle()
      expect(price).not.toHaveBeenCalled()
      price.mockRestore()

      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('Continue please')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a small cold context on its own generation', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { ctx, adapter, memberId, sessionId } = await coldMember(3 * 60 * 60_000, 40_000)
      const workspaceId = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!.member.workspaceId
      const projectRef = ctx.agentTeam.view({ workspaceId }).projects[0]!.projectRef
      const agent = ctx.agents.get(sessionId)!

      adapter.enqueue(textResponse('Continuing in the same context.'))
      await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('small-message'), workspaceId,
        projectRef, body: '@builder Continue please' })
      await agent.whenIdle()

      // The wake actually reached the Agent: the assertion above holds trivially
      // if nothing woke it, so the request that carried the message is the proof.
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('Continue please')
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
    } finally {
      vi.useRealTimers()
    }
  })
})
