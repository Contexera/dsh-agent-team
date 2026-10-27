import { afterEach, describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })

import { changeBaseline, nextChange } from './helpers/change-stream.ts'

import { EmptyAdapter, realHarness, requestId } from './helpers/member-harness.ts'



describe('Agent Team change version domains', () => {
  /** Resolve only after a macrotask so a premature wake-up cannot hide behind microtasks. */
  async function staysPending(promise: Promise<unknown>, ms = 15): Promise<boolean> {
    let settled = false
    void promise.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, ms))
    return !settled
  }

  it('answers no parked Client when a Member read of its own Thread makes progress', async () => {
    const { ctx, workspaceId } = await realHarness(new EmptyAdapter())
    const project = await ctx.agentTeam.createProject({ requestId: requestId('domain-project'), workspaceId, name: 'engineering', description: 'Version domains' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('domain-add'), workspaceId, handle: 'builder', description: 'Reads work', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const live = ctx.agents.get(added.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('domain-task'), workspaceId, projectRef: project.project.projectRef, body: '@builder Unread work' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)

    const baseline = (await changeBaseline(ctx.agentTeam)).version
    const clients = Array.from({ length: 10 }, (_unused, index) => index % 2 === 0
      ? nextChange(ctx.agentTeam)
      : nextChange(ctx.agentTeam, { kind: 'thread' as const, threadRef: started.thread.threadRef }))
    expect(await Promise.all(clients.map(client => staysPending(client)))).toEqual(clients.map(() => true))

    // One private read that really commits: the Human's anchor is unread for
    // this Member, so a durable thread-read record is appended.
    const read = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('domain-read'), workspaceId, taskRef: started.task!.taskRef })
    expect(read.receipt).toBeDefined()
    expect(read.remainingUnreadCount).toBe(0)

    // The record exists, and still no cursor moved: a private read is not a
    // projection change, so no parked Client is answered by it.
    expect((await changeBaseline(ctx.agentTeam)).version).toBe(baseline)
    expect(await Promise.all(clients.map(client => staysPending(client)))).toEqual(clients.map(() => true))

    // A real Thread change still reaches every parked Client, at the durable
    // position of the commit itself.
    const reply = await ctx.agentTeam.reply({ requestId: requestId('domain-reply'), workspaceId, taskRef: started.task!.taskRef, body: 'Update', baseRevision: started.thread.revision })
    if (reply.kind !== 'committed') throw new Error(`expected committed reply, received ${reply.kind}`)
    expect(await clients[1]!).toMatchObject({ version: reply.receipt.sequence })
    expect(await clients[0]!).toMatchObject({ version: reply.receipt.sequence })
  })

  it('wakes a presence waiter holding another domain cursor without moving any projection cursor', async () => {
    const { ctx, workspaceId } = await realHarness(new EmptyAdapter())
    const added = await ctx.agentTeam.addMember({ requestId: requestId('domain-presence-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const projection = (await changeBaseline(ctx.agentTeam)).version

    // A cursor taken from the projection domain must never park a presence
    // scope: a presence wake is an edge, not a position comparison.
    const presence = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    expect(await staysPending(presence)).toBe(true)

    ctx.emit('agent/status', { agent, status: 'running' })
    expect(await presence).toMatchObject({ version: expect.any(Number) })

    // The edge left every projection cursor exactly where it was.
    expect((await changeBaseline(ctx.agentTeam)).version).toBe(projection)
    expect(await staysPending(nextChange(ctx.agentTeam))).toBe(true)
  })
})
