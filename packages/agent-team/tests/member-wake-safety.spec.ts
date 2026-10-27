import { afterEach, describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'


import { realHarness, ScriptedAdapter, textResponse, waitFor, waitForArchive, requestId } from './helpers/member-harness.ts'



describe('Agent Team wake-slot swap safety (ticket 05)', () => {
  it('keeps a generation that still owes queued input instead of retiring it, and answers that input with the wake', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('queued-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('queued-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      // Queued after the Member went idle, without waking it: the ordinary
      // input a retiring generation would cancel.
      agent.inject(createUserMessage({ content: [{ type: 'text', text: 'answer this queued question' }], source: { kind: 'user' } }))
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      adapter.enqueue(textResponse('Answering the queued question.'))
      const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('queued-message'), workspaceId,
        projectRef: project.project.projectRef, body: '@builder Please pick this up now' })
      expect(sent.kind).toBe('committed')
      await vi.waitFor(() => {
        if (agent.status !== 'idle') throw new Error('the waking turn has not finished yet')
        if (adapter.requests.length < 2) throw new Error('the waking turn has not asked the model yet')
      }, { timeout: 20_000 })

      // The generation is the same one: nothing retired it, so the queued input
      // and the waking message were both answered in its own context.
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
      expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(sessionId)
      const request = JSON.stringify(adapter.requests.at(-1)!.messages)
      expect(request).toContain('answer this queued question')
    } finally {
      vi.useRealTimers()
    }
  })

  it('finishes a swap whose activation failed after the commit on the next Team notification', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState, presets } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('post-commit-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('post-commit-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      // The swap commits, then its activation fails: the durable binding has
      // moved while no live generation runs it.
      presets.failingMount = true
      const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('post-commit-message'), workspaceId,
        projectRef: project.project.projectRef, body: '@builder Please pick this up now' })
      expect(sent.kind).toBe('committed')
      const stranded = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        if (current.availability === 'active') throw new Error('activation unexpectedly succeeded')
        return current
      }, { timeout: 20_000 })
      const successor = stranded.member.sessionId
      await waitForArchive(ctx, sessionId)
      expect(ctx.agents.get(sessionId)).toBeUndefined()

      // The next thing that needs this Member finishes the recorded transition
      // and rederives its Inbox; nothing retries in the background.
      presets.failingMount = false
      adapter.enqueue(textResponse('Answering from the recovered context.'))
      adapter.enqueue(textResponse('Second answer.'))
      await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('post-commit-second'), workspaceId,
        projectRef: project.project.projectRef, body: '@builder Second message' })

      await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current?.availability !== 'active') throw new Error(`member not active yet: ${current?.availability}`)
        const asked = adapter.requests.map(request => JSON.stringify(request.messages))
        if (!asked.some(messages => messages.includes('Team Inbox has unread work'))) throw new Error('the successor has not rederived its Inbox yet')
      }, { timeout: 20_000 })
      // The retired generation stays retired: recovery never resumes it.
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      expect(ctx.agents.get(successor)).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays unanswered input a legacy rollover log still records into the successor', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('legacy-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('legacy-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // A log the retired rollover tool wrote: its intent parked on a durable
      // result, an ordinary message arrived while it was parked, and the turn
      // that claimed that message never answered it. Nothing in this build
      // writes such a log any more, so it is appended here directly.
      const carried = createUserMessage({ content: [{ type: 'text', text: 'the legacy carried question' }], source: { kind: 'user' } })
      const session = agent.session
      const turn = session.ownEvents().filter(event => event.type === 'turn/start').length + 1
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      session.append('assistant/message', {
        turn, step: 1, stream: [],
        message: {
          id: 'assistant-legacy', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
          content: [{ type: 'tool-call', id: 'call-legacy', name: 'context_rollover', arguments: JSON.stringify({ handoff: 'carry it' }) }],
        },
      } as never, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step: 1, callId: 'call-legacy' as never, name: 'context_rollover', arguments: JSON.stringify({ handoff: 'carry it' }) })
      session.append('tool/result', {
        turn, step: 1,
        message: createToolResultMessage({ callId: 'call-legacy' as never, content: [{ type: 'text', text: 'ok' }], isError: false }),
      }, { surfaceOp: 'append' })
      // Arrives while the intent is parked, then leaves the inbox when the turn
      // claims it; the claim is what leaves it unconsumed in the record.
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [carried] })
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      // The swap's replay reads the retired log back through persistence, so the
      // synthetic log has to be durable before the swap can see it.
      await ctx.sessionPersistence.flush()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      adapter.enqueue(textResponse('Reading the legacy question in the fresh context.'))
      await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('legacy-message'), workspaceId,
        projectRef: project.project.projectRef, body: '@builder Please pick this up now' })

      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      await vi.waitFor(() => {
        if (!adapter.requests.some(request => request.sessionId === successor
          && JSON.stringify(request.messages).includes('the legacy carried question'))) throw new Error('the carried input has not reached the successor yet')
      }, { timeout: 20_000 })
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      expect(ctx.agents.get(successor)).toBeDefined()
      expect(ctx.agentTeam['ledger']!.status().sequence).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the generation when the meter cannot price it and says why', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('meter-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('meter-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.failFor.add(sessionId)
      await vi.advanceTimersByTimeAsync(61 * 60_000)
      const warn = vi.spyOn(ctx.logger, 'warn')
      adapter.enqueue(textResponse('Continuing without a price.'))
      await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('meter-message'), workspaceId,
        projectRef: project.project.projectRef, body: '@builder Continue please' })
      await agent.whenIdle()

      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
      const priced = warn.mock.calls.map(args => String(args[0])).find(line => line.includes('could not price'))
      expect(priced).toBeDefined()
      expect(priced).toContain(sessionId)
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })
})
