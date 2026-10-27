import { afterEach, describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { GatedAdapter, realHarness, requestId } from './helpers/member-harness.ts'



describe('Agent Team member execution isolation (state-requests 02)', () => {
  it("suspends B while A's capability edit waits for A's turn boundary", async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('isolation-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('isolation-reviewer'), workspaceId,
      handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!

    // A runs a held turn: model call 1 parks until the test releases it.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    // A's capability edit stores its intent, then waits for the turn
    // boundary: it cannot resolve while A keeps running.
    const edit = ctx.agentTeam.updateMember({ requestId: requestId('isolation-edit'), memberId: builder.status.member.memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
    const editOutcome = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])

    // B's suspension must complete while A still runs: one Member's waiting
    // execution may not block lifecycle management of another Member.
    const suspending = ctx.agentTeam.suspendMember({ requestId: requestId('isolation-suspend'), memberId: reviewer.status.member.memberId })
    const suspensionOutcome = await Promise.race([suspending.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 1500) })])

    // Release before asserting so the held turn always ends, red or green.
    adapter.release.resolve()
    const applied = await edit
    const suspended = await suspending

    expect(editOutcome).toBe('pending')
    expect(suspensionOutcome).toBe('settled')
    expect(applied.effect).toBe('applied')
    expect(applied.status.availability).toBe('active')
    expect(applied.status.member.sessionId).toBe(builder.status.member.sessionId)
    expect(applied.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool'] } })
    expect(suspended.status.availability).toBe('suspended')
    expect(ctx.agents.get(reviewer.status.member.sessionId)).toBeUndefined()
    // A's turn ran to completion after the boundary swap, untouched by B's suspension.
    await agent.whenIdle()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('keeps same-Member order: a stop queued behind a parked edit runs after the edit applies', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('order-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const order: string[] = []
    const edit = ctx.agentTeam.updateMember({ requestId: requestId('order-edit'), memberId: builder.status.member.memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
      .then(result => { order.push('edit'); return result })
    const editOutcome = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(editOutcome).toBe('pending')

    const suspending = ctx.agentTeam.suspendMember({ requestId: requestId('order-suspend'), memberId: builder.status.member.memberId })
      .then(result => { order.push('suspend'); return result })
    const stopOutcome = await Promise.race([suspending.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    // Same Member: the stop is queued behind the parked edit, never beside it.
    expect(stopOutcome).toBe('pending')

    adapter.release.resolve()
    const applied = await edit
    const suspended = await suspending
    expect(order).toEqual(['edit', 'suspend'])
    expect(applied.effect).toBe('applied')
    expect(applied.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool'] } })
    expect(suspended.status.availability).toBe('suspended')
    // Stop never clears a committed configuration: the stored intent survives
    // the suspension for the next activation.
    expect(suspended.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool'] } })
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('defers an edit whose stop committed first and applies the stored intent at the next activation', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('deferred-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const memberId = builder.status.member.memberId

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    // The stop commits first and cancels the in-flight turn as soon as its
    // own chain slot runs — it settles while the gate is still held.
    const suspending = ctx.agentTeam.suspendMember({ requestId: requestId('deferred-suspend'), memberId })
    const edit = ctx.agentTeam.updateMember({ requestId: requestId('deferred-edit'), memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
    const requestsBefore = adapter.requests.length

    const suspended = await suspending
    expect(suspended.status.availability).toBe('suspended')
    const deferred = await edit
    expect(deferred.effect).toBe('deferred:no-live-handle')
    expect(deferred.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool'] } })
    expect(deferred.status.capabilityState).toBe('pending')
    expect(adapter.requests.length).toBe(requestsBefore)

    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('deferred-resume'), memberId })
    expect(resumed.status.availability).toBe('active')
    expect(resumed.status.member.sessionId).toBe(builder.status.member.sessionId)
    expect(resumed.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool'] } })
    expect(resumed.status.capabilityState).toBe('applied')
    expect(ctx.agents.get(builder.status.member.sessionId)).toBeDefined()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('activates exactly once when the same add request arrives concurrently', async () => {
    const { ctx, workspaceId } = await realHarness()
    const request = { requestId: requestId('dup-add'), workspaceId, handle: 'duplicate',
      description: 'Concurrent duplicate', presetId: 'team-member', projectRefs: [] }
    const [first, second] = await Promise.all([ctx.agentTeam.addMember(request), ctx.agentTeam.addMember(request)])

    expect(second.status.member.memberId).toBe(first.status.member.memberId)
    expect(second.status.member.sessionId).toBe(first.status.member.sessionId)
    // The hard idempotency evidence: the duplicate resolves to the same
    // committed operation, not a second row.
    expect(second.receipt).toEqual(first.receipt)
    expect(ctx.agentTeam.members().filter(item => item.member.memberId === first.status.member.memberId)).toHaveLength(1)
    const live = ctx.agents.get(first.status.member.sessionId)
    expect(live).toBeDefined()
    expect(ctx.agentTeam.memberForAgent(live!)).toEqual(first.status.member)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('runs distinct add requests concurrently with disjoint members', async () => {
    const { ctx, workspaceId } = await realHarness()
    const [left, right] = await Promise.all([
      ctx.agentTeam.addMember({ requestId: requestId('parallel-left'), workspaceId, handle: 'left',
        description: 'Left member', presetId: 'team-member', projectRefs: [] }),
      ctx.agentTeam.addMember({ requestId: requestId('parallel-right'), workspaceId, handle: 'right',
        description: 'Right member', presetId: 'team-member', projectRefs: [] }),
    ])

    expect(left.status.availability).toBe('active')
    expect(right.status.availability).toBe('active')
    expect(right.status.member.memberId).not.toBe(left.status.member.memberId)
    expect(right.status.member.sessionId).not.toBe(left.status.member.sessionId)
    expect(ctx.agents.get(left.status.member.sessionId)).toBeDefined()
    expect(ctx.agents.get(right.status.member.sessionId)).toBeDefined()
    const handles = ctx.agentTeam.members().map(item => item.member.handle)
    expect(handles).toEqual(expect.arrayContaining(['left', 'right']))
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('drains a parked lifecycle chain on Host shutdown without waiting for the turn to end', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId, teamFiber } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('shutdown-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const edit = ctx.agentTeam.updateMember({ requestId: requestId('shutdown-edit'), memberId: builder.status.member.memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
    const editOutcome = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(editOutcome).toBe('pending')

    // The gate is never released: Host shutdown must finish anyway instead
    // of waiting out a turn that may never end.
    const team = ctx.agentTeam
    const requestsBefore = adapter.requests.length
    const disposal = teamFiber.dispose().then(() => 'disposed' as const)
    const outcome = await Promise.race([disposal,
      new Promise<'stalled'>(resolve => { setTimeout(() => resolve('stalled'), 5000) })])
    // Unblock a stalled (red) shutdown so the suite's own cleanup cannot wedge.
    adapter.release.resolve()
    expect(outcome).toBe('disposed')
    await disposal
    await edit
    // No chain, waiter, or model request survives the shutdown. The instance
    // is held from before disposal: the ctx service accessor is gone after it.
    expect(team['memberLifecycleTails'].size).toBe(0)
    expect(team['additionLifecycleTails'].size).toBe(0)
    expect(team['memberRuntime']['turnWaitResolvers'].size).toBe(0)
    expect(adapter.requests.length).toBe(requestsBefore)
  })

  it('resolves a parked boundary wait when the turn is cancelled', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('cancel-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const edit = ctx.agentTeam.updateMember({ requestId: requestId('cancel-edit'), memberId: builder.status.member.memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
    const editOutcome = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(editOutcome).toBe('pending')

    const requestsBefore = adapter.requests.length
    agent.cancel({ kind: 'user' })
    const settled = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'stalled'>(resolve => { setTimeout(() => resolve('stalled'), 5000) })])
    expect(settled).toBe('settled')
    const applied = await edit
    // The cancellation ended the turn without disposing the generation, so
    // the boundary applies the stored intent — and no model request follows.
    expect(applied.effect).toBe('applied')
    expect(applied.status.availability).toBe('active')
    expect(adapter.requests.length).toBe(requestsBefore)
    expect(ctx.agentTeam['memberLifecycleTails'].size).toBe(0)
    expect(ctx.agentTeam['memberRuntime']['turnWaitResolvers'].size).toBe(0)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('logs each lifecycle wait class with the Member, Session, and duration', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('waitlog-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const memberId = builder.status.member.memberId
    const sessionId = builder.status.member.sessionId
    const agent = ctx.agents.get(sessionId)!
    const info = vi.spyOn(ctx.logger, 'info')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise
    const edit = ctx.agentTeam.updateMember({ requestId: requestId('waitlog-edit'), memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
    const editOutcome = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(editOutcome).toBe('pending')
    adapter.release.resolve()
    expect((await edit).effect).toBe('applied')
    await agent.whenIdle()

    // An edit applied to an already-idle Member spends no time waiting and
    // logs no wait line: the log answers "why is this operation slow", not
    // "an operation happened".
    const idleEdit = await ctx.agentTeam.updateMember({ requestId: requestId('waitlog-idle'), memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['spare_tool'] } } })
    expect(idleEdit.effect).toBe('applied')

    // A stop's disposal is external execution — the Agent releasing its
    // Session write path — not the Member's own turn.
    await ctx.agentTeam.suspendMember({ requestId: requestId('waitlog-suspend'), memberId })

    const lines = info.mock.calls.map(args => String(args[0]))
    const turnWaits = lines.filter(line => line.includes("stage 'wait-turn'"))
    expect(turnWaits).toHaveLength(1)
    expect(turnWaits[0]).toContain("member 'builder'")
    expect(turnWaits[0]).toContain(`session '${sessionId}'`)
    expect(turnWaits[0]).toMatch(/waited \d+ms for its turn boundary/)
    const externalWait = lines.find(line => line.includes("stage 'wait-external'"))
    expect(externalWait).toBeDefined()
    expect(externalWait).toContain("member 'builder'")
    expect(externalWait).toContain(`session '${sessionId}'`)
    expect(externalWait).toMatch(/waited \d+ms for the Agent to release its Session write path/)
    info.mockRestore()
  })
})
