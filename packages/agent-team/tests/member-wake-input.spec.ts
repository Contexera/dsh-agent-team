import { afterEach, describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })
import type { AgentTeamMemberId, AgentTeamProjectRef } from '../src/types.ts'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { SessionId } from '@deepseek-ai/dsh-session'

import { realHarness, ScriptedAdapter, textResponse, waitFor, waitForArchive, requestId, TestablePresets } from './helpers/member-harness.ts'



describe('Agent Team wake-slot swap input across the commit (ticket 05)', () => {
  /**
   * Hold the durable recycled-binding write itself, so a test can let input
   * land in the retire window that production narrows but cannot remove.
   */
  function holdRecycledPut(ctx: Context): {
    readonly entered: Promise<void>
    readonly release: (fail?: Error) => void
    readonly restore: () => void
  } {
    const table = ctx.agentTeam['ledger']!['table']
    const realPut = table.put.bind(table)
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<Error | undefined>()
    const spy = vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
      if (value.kind === 'team/member-session-recycled') {
        entered.resolve()
        const failure = await gate.promise
        if (failure !== undefined) throw failure
      }
      return realPut(key, value)
    })
    return { entered: entered.promise, release: failure => gate.resolve(failure), restore: () => { spy.mockRestore() } }
  }

  /**
   * One idle Member with a real persisted log, priced past both swap gates and
   * woken after the cache TTL: the next Team wake retires this generation.
   */
  async function recyclableMember(tag: string): Promise<{
    readonly adapter: ScriptedAdapter
    readonly ctx: Context
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly memberId: AgentTeamMemberId
    readonly sessionId: SessionId
    readonly agent: NonNullable<ReturnType<Context['agents']['get']>>
    readonly archived: readonly SessionId[]
    readonly presets: TestablePresets
  }> {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState, presets, archived } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId(`${tag}-project`), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId(`${tag}-add`), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    adapter.enqueue(textResponse('First look done.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    pressureState.bySession.set(added.status.member.sessionId, 130_000)
    await vi.advanceTimersByTimeAsync(61 * 60_000)
    return { adapter, ctx, workspaceId, projectRef: project.project.projectRef, memberId: added.status.member.memberId,
      sessionId: added.status.member.sessionId, agent, archived, presets }
  }

  it('carries ordinary input that arrives while the recycled binding is being written into the successor', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { adapter, ctx, workspaceId, projectRef, memberId, sessionId, agent } = await recyclableMember('held-put')
      const before = adapter.requests.length
      const retire = ctx.agentTeam['retireMemberGeneration'].bind(ctx.agentTeam)
      const retireSpy = vi.spyOn(ctx.agentTeam as unknown as { retireMemberGeneration: typeof retire }, 'retireMemberGeneration').mockImplementation(async (...args: Parameters<typeof retire>) => {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'input during the retirement gap' }], source: { kind: 'user' } }))
        await agent.whenIdle()
        return retire(...args)
      })
      const put = holdRecycledPut(ctx)
      try {
        const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('held-put-message'), workspaceId,
          projectRef, body: '@builder Please pick this up now' })
        expect(sent.kind).toBe('committed')
        await put.entered

        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'late ordinary followup' }], source: { kind: 'user' } }))
        agent.inject(createUserMessage({ content: [{ type: 'text', text: 'late injected step input' }], source: { kind: 'user' } }))
        expect(adapter.requests.length).toBe(before)
        for (let index = 0; index < 6; index += 1) adapter.enqueue(textResponse(`Successor answer ${index}.`))
        put.release()
      } finally {
        put.restore()
      }

      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      await vi.waitFor(() => {
        const asked = adapter.requests.filter(request => request.sessionId === successor).map(request => JSON.stringify(request.messages))
        for (const body of ['late ordinary followup', 'late injected step input', 'input during the retirement gap']) {
          if (!asked.some(messages => messages.includes(body))) throw new Error(`the successor has not replayed '${body}' yet`)
        }
      }, { timeout: 20_000 })

      const retired = adapter.requests.filter(request => request.sessionId === sessionId).map(request => JSON.stringify(request.messages))
      expect(retired.some(messages => messages.includes('late ordinary followup') || messages.includes('late injected step input'))).toBe(false)
      const transition = ctx.agentTeam['ledger']!.lastTransitionForMember(memberId)
      expect(transition?.previousSessionId).toBe(sessionId)
      expect(transition?.targetSessionId).toBe(successor)
      expect(transition?.inputFromSeq).toBeTypeOf('number')
      expect(agent.session.ownEvents().some(event => event.type === 'agent/inbox/spliced'
        && event.seq >= transition!.inputFromSeq! && event.data.removedCount !== undefined && event.data.outcome === undefined)).toBe(true)
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      retireSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the binding and answers late input in the old generation when the recycled commit rejects', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { adapter, ctx, workspaceId, projectRef, memberId, sessionId, agent, archived } = await recyclableMember('reject-put')
      const before = adapter.requests.length
      const put = holdRecycledPut(ctx)
      try {
        await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('reject-put-message'), workspaceId,
          projectRef, body: '@builder Please pick this up now' })
        await put.entered
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'late followup while the commit failed' }], source: { kind: 'user' } }))
        expect(adapter.requests.length).toBe(before)
        adapter.enqueue(textResponse('Answered in the old generation.'))
        put.release(new Error('ledger write failed (test seam)'))
      } finally {
        put.restore()
      }

      await vi.waitFor(() => {
        if (adapter.requests.length <= before) throw new Error('the old generation has not answered the late input yet')
      }, { timeout: 20_000 })
      await agent.whenIdle()
      expect(adapter.requests.at(-1)!.sessionId).toBe(sessionId)
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('late followup while the commit failed')
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
      expect(ctx.agents.get(sessionId)).toBe(agent)
      expect(ctx.agentTeam['ledger']!.lastTransitionForMember(memberId)).toBeUndefined()
      expect(archived).not.toContain(sessionId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays late input from the retired log when the activation failed after the commit', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { adapter, ctx, workspaceId, projectRef, memberId, sessionId, agent, presets } = await recyclableMember('postcommit-late')
      const late = createUserMessage({ content: [{ type: 'text', text: 'late followup recorded before activation failed' }], source: { kind: 'user' } })
      const put = holdRecycledPut(ctx)
      try {
        await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('postcommit-late-message'), workspaceId,
          projectRef, body: '@builder Please pick this up now' })
        await put.entered
        // The successor will fail to compose, so the old log is the only place
        // the late input survives.
        presets.failingMount = true
        agent.followup(late)
        for (let index = 0; index < 6; index += 1) adapter.enqueue(textResponse(`Recovered answer ${index}.`))
        put.release()
      } finally {
        put.restore()
      }

      const stranded = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        if (current.availability === 'active') throw new Error('activation unexpectedly succeeded')
        return current
      }, { timeout: 20_000 })
      const successor = stranded.member.sessionId
      await waitForArchive(ctx, sessionId)
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      expect(ctx.agents.get(successor)).toBeUndefined()
      expect(adapter.requests.filter(request => request.sessionId === successor)).toHaveLength(0)

      // Nothing carried this input in memory: the successor did not exist while
      // the input arrived, so recovery must replay the retired log from the
      // recorded offset.
      presets.failingMount = false
      const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('postcommit-late-recover'), workspaceId, memberId })
      expect(recovered.status.member.sessionId).toBe(successor)
      await vi.waitFor(() => {
        const asked = adapter.requests.filter(request => request.sessionId === successor).map(request => JSON.stringify(request.messages))
        if (!asked.some(messages => messages.includes('late followup recorded before activation failed'))) {
          throw new Error('the recovered successor has not replayed the late input yet')
        }
      }, { timeout: 20_000 })
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      await ctx.agents.get(successor)!.whenIdle()
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await ctx.agentTeam.suspendMember({ requestId: requestId(`postcommit-suspend-${attempt}`), memberId })
        await ctx.agentTeam.resumeMember({ requestId: requestId(`postcommit-resume-${attempt}`), memberId })
        const resumed = ctx.agents.get(successor)!
        await resumed.whenIdle()
        expect(resumed.session.ownEvents().filter(event => event.type === 'user/message' && event.data.id === late.id)).toHaveLength(1)
        expect(resumed.session.ownEvents().filter(event => event.type === 'agent/inbox/spliced'
          && event.data.inserted.some(message => message.id === late.id))).toHaveLength(1)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
