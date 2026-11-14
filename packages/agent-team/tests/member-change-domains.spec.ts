import { describe, expect, it } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
import { changeBaseline, nextChange } from './helpers/change-stream.ts'

import { EmptyAdapter, realHarness } from './helpers/member-harness.ts'

describe('Agent Team change version domains', () => {
  /** Resolve only after a macrotask so a premature wake-up cannot hide behind microtasks. */
  async function staysPending(promise: Promise<unknown>, ms = 15): Promise<boolean> {
    let settled = false
    void promise.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, ms))
    return !settled
  }

  it('answers no parked Client when a Member read of its own Thread makes progress', async () => {
    const h = await realHarness(new EmptyAdapter())
    const project = await h.human.createProject('engineering', { description: 'Version domains' })
    const builder = await h.human.addMember('builder', { description: 'Reads work', projects: [project] })
    const task = await h.human.startTask(project, '@builder Unread work')

    const baseline = (await changeBaseline(h.ctx.agentTeam)).version
    const clients = Array.from({ length: 10 }, (_unused, index) => index % 2 === 0
      ? nextChange(h.ctx.agentTeam)
      : nextChange(h.ctx.agentTeam, { kind: 'thread' as const, threadRef: task.threadRef }))
    expect(await Promise.all(clients.map(client => staysPending(client)))).toEqual(clients.map(() => true))

    // One private read that really commits: the Human's anchor is unread for
    // this Member, so a durable thread-read record is appended.
    const read = await builder.readThread(task)
    expect(read.receipt).toBeDefined()
    expect(read.remainingUnreadCount).toBe(0)

    // The record exists, and still no cursor moved: a private read is not a
    // projection change, so no parked Client is answered by it.
    expect((await changeBaseline(h.ctx.agentTeam)).version).toBe(baseline)
    expect(await Promise.all(clients.map(client => staysPending(client)))).toEqual(clients.map(() => true))

    // A real Thread change still reaches every parked Client, at the durable
    // position of the commit itself.
    const reply = await h.human.reply(task, 'Update')
    expect(await clients[1]!).toMatchObject({ version: reply.receipt.sequence })
    expect(await clients[0]!).toMatchObject({ version: reply.receipt.sequence })
  })

  it('wakes a presence waiter holding another domain cursor without moving any projection cursor', async () => {
    const h = await realHarness(new EmptyAdapter())
    const builder = await h.human.addMember('builder', { description: 'Builds changes' })
    const projection = (await changeBaseline(h.ctx.agentTeam)).version

    // A cursor taken from the projection domain must never park a presence
    // scope: a presence wake is an edge, not a position comparison.
    const presence = nextChange(h.ctx.agentTeam, { kind: 'presence', workspaceId: h.workspaceId })
    expect(await staysPending(presence)).toBe(true)

    h.ctx.emit('agent/status', { agent: builder.agent, status: 'running' })
    expect(await presence).toMatchObject({ version: expect.any(Number) })

    // The edge left every projection cursor exactly where it was.
    expect((await changeBaseline(h.ctx.agentTeam)).version).toBe(projection)
    expect(await staysPending(nextChange(h.ctx.agentTeam))).toBe(true)
  })
})
