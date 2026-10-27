import { afterEach, describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })

import { changeBaseline, nextChange } from './helpers/change-stream.ts'

import { EmptyAdapter, realHarness, requestId } from './helpers/member-harness.ts'



describe('Agent Team presence-scope invalidation (issue #21)', () => {
  /** Resolve only after a macrotask so a premature wake-up cannot hide behind microtasks. */
  async function staysPending(promise: Promise<unknown>, ms = 15): Promise<boolean> {
    let settled = false
    void promise.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, ms))
    return !settled
  }

  it('wakes only presence waiters on Agent running/idle and leaves workspace and scope-less waiters parked', async () => {
    const { ctx, workspaceId } = await realHarness(new EmptyAdapter())
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('presence-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    // Presence versions are their own domain, so a presence waiter is parked
    // with a cursor sampled from the presence scope itself.
    const presenceBaseline = await changeBaseline(ctx.agentTeam, { kind: 'presence', workspaceId })
    const presenceWaiter = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    const workspaceWaiter = nextChange(ctx.agentTeam, { kind: 'workspace', workspaceId })
    const unscopedWaiter = nextChange(ctx.agentTeam)
    expect(await staysPending(presenceWaiter)).toBe(true)

    // A turn start (running) and its end (idle) change no durable projection:
    // only the presence waiter wakes, in both directions, and each wake
    // advances that one domain.
    ctx.emit('agent/status', { agent, status: 'running' })
    const runningWake = await presenceWaiter
    expect(runningWake.version).toBeGreaterThan(presenceBaseline.version)
    expect(await staysPending(workspaceWaiter)).toBe(true)
    expect(await staysPending(unscopedWaiter)).toBe(true)

    const idleWaiter = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    ctx.emit('agent/status', { agent, status: 'idle' })
    expect((await idleWaiter).version).toBeGreaterThan(runningWake.version)

    // A ledger commit still reaches the workspace and scope-less waiters, and
    // a fresh presence waiter stays parked through it — and it leaves the
    // projection cursors alone: project creation must refresh the sidebar
    // catalog, never the presence rows.
    const committedWaiter = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    const committedWorkspaceWaiter = nextChange(ctx.agentTeam, { kind: 'workspace', workspaceId })
    await ctx.agentTeam.createProject({ requestId: requestId('presence-project'), workspaceId, name: 'presence-check', description: 'Presence work' })
    expect(await committedWorkspaceWaiter).toMatchObject({ version: expect.any(Number) })
    expect(await staysPending(committedWaiter)).toBe(true)
  })

  it('reports Agent runtime failures through the presence scope only', async () => {
    const { ctx, workspaceId } = await realHarness(new EmptyAdapter())
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('presence-error-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const presenceBaseline = await changeBaseline(ctx.agentTeam, { kind: 'presence', workspaceId })
    const presenceWaiter = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    const unscopedWaiter = nextChange(ctx.agentTeam)
    expect(await staysPending(presenceWaiter)).toBe(true)

    ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('fetch failed') })
    const failureWake = await presenceWaiter
    expect(failureWake.version).toBeGreaterThan(presenceBaseline.version)
    expect(await staysPending(unscopedWaiter)).toBe(true)
  })
})
