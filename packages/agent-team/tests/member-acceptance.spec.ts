import { describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
import { Context } from '@deepseek-ai/cordis'
import AgentTeam from '../src/index.ts'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isAcceptanceNotice } from '../src/context-projection.ts'
import { ACCEPTANCE_COMPACT_TOKENS } from '../src/acceptance-context.ts'
import { MEMBER_COMPACT_TOKENS } from '../src/member-compaction.ts'
import type { AgentTeamClaimRef } from '../src/types.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

import { realHarness, ScriptedAdapter, acceptanceReminders, textResponse, waitFor, waitForIdle, requestId } from './helpers/member-harness.ts'

describe('Agent Team Member lifecycle: context, acceptance, and activation (ticket 04)', () => {
    it('leaves an acceptance below the budget as a reminder alone', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('noauto-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('noauto-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
      const memberId = added.status.member.memberId
      pressureState.usageTokens = 0
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('noauto-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the release' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const live = ctx.agents.get(added.status.member.sessionId)!
      await waitForIdle(ctx, live)
      const read = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('noauto-read'), workspaceId, taskRef: started.task!.taskRef })
      const claim = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('noauto-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: read.thread.revision, direction: 'own the fix' })
      if (claim.kind !== 'committed') throw new Error(`expected committed claim, received ${claim.kind}`)
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('noauto-human-read'), workspaceId, taskRef: started.task!.taskRef })
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('noauto-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
      // Read the acceptance back as the contributor: a small context gets the
      // reminder and nothing else — acceptance is a semantic cue, never an
      // unconditional summarization job.
      await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('noauto-contributor-read'), workspaceId, taskRef: started.task!.taskRef })
      const queued = [...live.inbox.nextStep, ...live.inbox.nextTurn].filter(message => isAcceptanceNotice(message))
      expect(queued).toHaveLength(1)
      // The reminder belongs to the work this turn is finishing, so it takes the
      // steered lane: a follow-up would wait for a turn end that may be hundreds
      // of steps away. The splice is the durable record of the lane chosen.
      const reminderSplices = live.session.ownEvents().filter(event => event.type === 'agent/inbox/spliced'
        && ((event.data as { inserted?: UserMessage[] }).inserted ?? []).some(isAcceptanceNotice))
      expect(reminderSplices.map(event => (event.data as { target: string }).target)).toEqual(['next-step'])
      // The reminder must not promise a compaction the budget did not reach.
      expect(JSON.stringify(queued[0]!.content)).not.toContain('compacted')
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!
      expect(status.availability).toBe('active')
      expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    })

    it('compacts a contributor over the budget once the turn ends, and tells it so', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('budget-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('budget-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
      pressureState.usageTokens = 0
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('budget-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the release' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const live = ctx.agents.get(added.status.member.sessionId)!
      await waitForIdle(ctx, live)
      const read = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('budget-read'), workspaceId, taskRef: started.task!.taskRef })
      const claim = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('budget-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: read.thread.revision, direction: 'own the fix' })
      if (claim.kind !== 'committed') throw new Error(`expected committed claim, received ${claim.kind}`)
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('budget-human-read'), workspaceId, taskRef: started.task!.taskRef })
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('budget-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
      pressureState.usageTokens = ACCEPTANCE_COMPACT_TOKENS + 1
      const compactions: string[] = []
      const engine = { compactNow: async (agent: { id: string }, signal: AbortSignal): Promise<null> => {
        // The engine is only legal once the Agent settles: the loop refuses a
        // maintenance phase while a turn runs.
        compactions.push(`${agent.id}:${signal.aborted ? 'aborted' : 'live'}`)
        return null
      } }
      const serviceFor = vi.spyOn(ctx.agentPresets, 'serviceFor').mockReturnValue(engine as never)
      try {
        await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('budget-contributor-read'), workspaceId, taskRef: started.task!.taskRef })
        const queued = [...live.inbox.nextStep, ...live.inbox.nextTurn].filter(message => isAcceptanceNotice(message))
        expect(queued).toHaveLength(1)
        // The reminder states the consequence, because this time it is true.
        expect(JSON.stringify(queued[0]!.content)).toContain('compacted once the Agent settles')
        await waitFor(() => compactions.length > 0 ? compactions : undefined)
        expect(compactions[0]!.startsWith(live.id)).toBe(true)
      } finally {
        serviceFor.mockRestore()
      }
    })

    it('leaves a follower that owns no accepted work alone', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('bystander-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('bystander-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
      const watcher = await ctx.agentTeam.addMember({ requestId: requestId('bystander-watcher'), workspaceId, handle: 'watcher', description: 'Watches the work', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
      pressureState.usageTokens = 0
      // Both are recipients and both end up following the Thread (the builder by
      // claiming, the watcher explicitly): the difference under test is that only
      // the builder ever claimed work on it.
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('bystander-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the release' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const builderAgent = ctx.agents.get(builder.status.member.sessionId)!
      const watcherAgent = ctx.agents.get(watcher.status.member.sessionId)!
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, watcherAgent)
      const builderRead = await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('bystander-builder-read'), workspaceId, taskRef: started.task!.taskRef })
      // The watcher follows the Thread but stays behind the accept, so the
      // accept reaches it as ordinary unread rather than as a mention.
      await ctx.agentTeam.readThreadForAgent(watcherAgent, { requestId: requestId('bystander-watcher-read'), workspaceId, taskRef: started.task!.taskRef })
      await ctx.agentTeam.changeAttentionForAgent(watcherAgent, { requestId: requestId('bystander-watcher-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
      const claim = await ctx.agentTeam.changeClaimForAgent(builderAgent, { requestId: requestId('bystander-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: builderRead.thread.revision, direction: 'own the fix' })
      if (claim.kind !== 'committed') throw new Error(`expected committed claim, received ${claim.kind}`)
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, watcherAgent)
      // Drain the claim activity so the accept below is the only unread fact
      // the watcher still holds.
      await ctx.agentTeam.readThreadForAgent(watcherAgent, { requestId: requestId('bystander-watcher-claim-read'), workspaceId, taskRef: started.task!.taskRef })
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('bystander-human-read'), workspaceId, taskRef: started.task!.taskRef })
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('bystander-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, watcherAgent)
      // Over the budget, so only the ownership check can keep the watcher out.
      pressureState.usageTokens = ACCEPTANCE_COMPACT_TOKENS * 2
      const watcherRead = await ctx.agentTeam.readThreadForAgent(watcherAgent, { requestId: requestId('bystander-watcher-accept-read'), workspaceId, taskRef: started.task!.taskRef })
      expect(watcherRead.facts.some(entry => entry.unread && entry.fact.kind === 'activity' && entry.fact.activity.kind === 'accept')).toBe(true)
      expect([...watcherAgent.inbox.nextStep, ...watcherAgent.inbox.nextTurn].some(message => isAcceptanceNotice(message))).toBe(false)
      expect(acceptanceReminders(watcherAgent)).toHaveLength(0)
    })

    /**
     * A Task in review whose accountable never held a Claim: the builder finishes
     * the work and the Human hands the Task to the reviewer, so only the accept
     * itself can carry the boundary to the reviewer. Every wake needs one
     * scripted response; leftovers are harmless.
     */
    const handOffToVerifier = async (adapter: ScriptedAdapter, ctx: Context, workspaceId: WorkspaceId) => {
      const project = await ctx.agentTeam.createProject({ requestId: requestId('verifier-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('verifier-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
      const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('verifier-reviewer'), workspaceId, handle: 'reviewer', description: 'Verifies changes', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
      const builderAgent = ctx.agents.get(builder.status.member.sessionId)!
      const reviewerAgent = ctx.agents.get(reviewer.status.member.sessionId)!
      adapter.enqueue(textResponse('builder is ready.'))
      adapter.enqueue(textResponse('reviewer is ready.'))
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('verifier-task'), workspaceId, projectRef: project.project.projectRef, body: 'Ship the fix' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const taskRef = started.task!.taskRef
      const builderRead = await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('verifier-builder-read'), workspaceId, taskRef })
      const claim = await ctx.agentTeam.changeClaimForAgent(builderAgent, { requestId: requestId('verifier-claim'), workspaceId, taskRef, action: 'claim', baseRevision: builderRead.thread.revision, direction: 'implement' })
      if (claim.kind !== 'committed') throw new Error(`expected committed claim, received ${claim.kind}`)
      const builderRead2 = await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('verifier-builder-read-2'), workspaceId, taskRef })
      const done = await ctx.agentTeam.changeClaimForAgent(builderAgent, { requestId: requestId('verifier-done'), workspaceId, taskRef, action: 'done', claimRef: (claim as { claim: { claimRef: AgentTeamClaimRef } }).claim.claimRef, baseRevision: builderRead2.thread.revision })
      if (done.kind !== 'committed') throw new Error(`expected committed done, received ${done.kind}`)
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('verifier-human-read'), workspaceId, taskRef })
      // The handover wakes the new accountable and the builder that now follows the Thread.
      adapter.enqueue(textResponse('reviewer saw the handover.'))
      adapter.enqueue(textResponse('builder saw the handover.'))
      const transfer = await ctx.agentTeam.transferTask({ requestId: requestId('verifier-transfer'), workspaceId, taskRef, target: reviewer.status.member.memberId, baseRevision: humanRead.thread.revision })
      if (transfer.kind !== 'committed') throw new Error(`expected committed transfer, received ${transfer.kind}`)
      await waitForIdle(ctx, reviewerAgent)
      await waitForIdle(ctx, builderAgent)
      const read = await ctx.agentTeam.readThreadForAgent(reviewerAgent, { requestId: requestId('verifier-reviewer-read'), workspaceId, taskRef })
      return { builderAgent, reviewerAgent, reviewerMemberId: reviewer.status.member.memberId, taskRef, read }
    }

    /** The acceptance reminder wherever it landed: still queued, or claimed by a turn that was already running. */
    const acceptanceText = async (agent: NonNullable<ReturnType<Context['agents']['get']>>): Promise<string> => {
      const found = await waitFor(() => {
        const queued = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].filter(message => isAcceptanceNotice(message))
        if (queued.length > 0) return JSON.stringify(queued[0]!.content)
        return acceptanceReminders(agent)[0]
      })
      return found
    }

    it('hands the Member that commits the accept the boundary a claimant would get', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const { builderAgent, reviewerAgent, reviewerMemberId, taskRef, read } = await handOffToVerifier(adapter, ctx, workspaceId)
      expect(read.task?.accountable).toBe(reviewerMemberId)
      // Over the budget: the verifier gets the same compaction the contributor gets.
      pressureState.usageTokens = ACCEPTANCE_COMPACT_TOKENS + 1
      const compactions: string[] = []
      const engine = { compactNow: async (agent: { id: string }, signal: AbortSignal): Promise<null> => {
        compactions.push(`${agent.id}:${signal.aborted ? 'aborted' : 'live'}`)
        return null
      } }
      const serviceFor = vi.spyOn(ctx.agentPresets, 'serviceFor').mockReturnValue(engine as never)
      try {
        // The accept wakes the builder, whose Claim it concludes.
        adapter.enqueue(textResponse('builder saw the acceptance.'))
        const accepted = await ctx.agentTeam.changeTaskForAgent(reviewerAgent, { requestId: requestId('verifier-accept'), workspaceId, taskRef, action: 'accept', baseRevision: read.thread.revision })
        if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
        const text = await acceptanceText(reviewerAgent)
        expect(text).toContain('You accepted a Task.')
        expect(text).toContain('compacted once the Agent settles')
        const reminderSplices = reviewerAgent.session.ownEvents().filter(event => event.type === 'agent/inbox/spliced'
          && ((event.data as { inserted?: UserMessage[] }).inserted ?? []).some(isAcceptanceNotice))
        expect(reminderSplices.map(event => (event.data as { target: string }).target)).toEqual(['next-step'])
        await waitFor(() => compactions.length > 0 ? compactions : undefined)
        expect(compactions[0]!.startsWith(reviewerAgent.id)).toBe(true)
        await waitForIdle(ctx, builderAgent)
      } finally {
        serviceFor.mockRestore()
      }
    })

    it('hands the accountable the boundary when someone else accepts its Task', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const { reviewerAgent, taskRef } = await handOffToVerifier(adapter, ctx, workspaceId)
      pressureState.usageTokens = 0
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('accountable-human-read'), workspaceId, taskRef })
      // The Human accepts, so the reviewer never commits the accept and holds no
      // Claim: only the read-side boundary can reach it.
      adapter.enqueue(textResponse('reviewer saw the acceptance.'))
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('accountable-accept'), workspaceId, taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
      await waitForIdle(ctx, reviewerAgent)
      const read = await ctx.agentTeam.readThreadForAgent(reviewerAgent, { requestId: requestId('accountable-read'), workspaceId, taskRef })
      expect(read.facts.some(entry => entry.unread && entry.fact.kind === 'activity' && entry.fact.activity.kind === 'accept')).toBe(true)
      const text = await acceptanceText(reviewerAgent)
      expect(text).toContain('A Task you were accountable for was accepted.')
      expect(text).not.toContain('compacted')
    })

    it('resolves the same Host policy through the real preset engine scope', async () => {
      const h = await realHarness(new ScriptedAdapter(), 'jsonl', undefined, true)
      const builder = await h.human.addMember('builder', { description: '' })
      expect(h.ctx.agentTeam.members().find(entry => entry.member.memberId === builder.memberId)?.availability).toBe('active')
      const engine = h.ctx.agentPresets.serviceFor(builder.agent, 'compaction') as unknown as { ctx: Context }
      expect(engine.ctx.get('agentTeam')?.config.memberCompaction).toBe(h.ctx.agentTeam.config.memberCompaction)
    })

    it('compacts a Member through the preset engine at the configured budget', async () => {
      const adapter = new ScriptedAdapter()
      const h = await realHarness(adapter)
      const project = await h.human.createProject('engineering')
      const builder = await h.human.addMember('builder', { description: 'Builds changes', projects: [project] })
      const live = builder.agent

      const compactions: string[] = []
      const engine = {
        compactIfNeeded: async (_agent: unknown, trigger: string) => {
          compactions.push(trigger)
          h.pressureState.usageTokens = 0
          return null
        },
      }
      const serviceFor = vi.spyOn(h.ctx.agentPresets, 'serviceFor').mockImplementation((_agent, service) => service === 'compaction' ? engine as never : undefined)
      try {
        // Below the boundary, a turn runs to completion without compaction.
        h.pressureState.usageTokens = MEMBER_COMPACT_TOKENS - 1
        adapter.enqueue(textResponse('First answer.'))
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'First question?' }], source: { kind: 'user' } }))
        await builder.waitForIdle()
        expect(compactions).toHaveLength(0)

        h.pressureState.usageTokens = MEMBER_COMPACT_TOKENS + 1
        adapter.enqueue(textResponse('Second answer.'))
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'Second question?' }], source: { kind: 'user' } }))
        await waitFor(() => compactions.length > 0 ? compactions : undefined)
        await builder.waitForIdle()
        expect(compactions).toHaveLength(1)
        expect(compactions).toEqual(['context-overflow'])
      } finally {
        serviceFor.mockRestore()
      }
      expect(h.ctx.agentTeam.members().find(entry => entry.member.memberId === builder.memberId)).toBeDefined()
    })

    it('uses the window ratio for a 272K Member instead of skipping its budget', async () => {
      const adapter = new ScriptedAdapter()
      const h = await realHarness(adapter)
      const project = await h.human.createProject('engineering')
      const builder = await h.human.addMember('builder', { description: 'Builds changes', projects: [project] })

      adapter.resolveModelWindow = () => 272_000
      let compacted = 0
      const engine = {
        compactIfNeeded: async () => { compacted += 1; h.pressureState.usageTokens = 0; return null },
      }
      const serviceFor = vi.spyOn(h.ctx.agentPresets, 'serviceFor').mockImplementation((_agent, service) => service === 'compaction' ? engine as never : undefined)
      try {
        h.pressureState.usageTokens = 217_601
        adapter.enqueue(textResponse('Answer.'))
        builder.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Question?' }], source: { kind: 'user' } }))
        await builder.waitForIdle()
        expect(compacted).toBe(1)
      } finally {
        serviceFor.mockRestore()
      }
    })

    it('wakes a normal-accept contributor with both the accepted and completed Claim semantics', async () => {
      const adapter = new ScriptedAdapter()
      const h = await realHarness(adapter)
      const project = await h.human.createProject('engineering')
      const builder = await h.human.addMember('builder', { description: 'Builds changes', projects: [project] })
      const reviewer = await h.human.addMember('reviewer', { description: 'Reviews changes', projects: [project] })
      const task = await h.human.startTask(project, 'Ship both semantics')
      adapter.enqueue(textResponse('builder saw the task.'))
      adapter.enqueue(textResponse('reviewer saw the task.'))
      await builder.waitForIdle()
      await reviewer.waitForIdle()
      // Advance both members' read watermarks so their initial-start unread
      // facts are consumed: a member with no unread facts is not woken by the
      // other member's Claim mutations, which keeps the scripted wake turns
      // below attributable to exactly one member at a time.
      await builder.readThread(task)
      await reviewer.readThread(task)

      // builder: finished its Claim before the accept (normal flow). Each
      // mutation wakes only the OTHER following member with an unread
      // activity (a member's own activity is never unread to itself), so one
      // scripted response per commit suffices; the mutating member itself
      // stays idle and the helper resolves immediately for it.
      adapter.enqueue(textResponse('reviewer saw the claim.'))
      const builderClaim = await builder.claimTask(task, 'implement')
      await builder.waitForIdle()
      await reviewer.waitForIdle()
      // Consume the claim activity so later wake turns stay attributable to
      // exactly one mutation at a time.
      await reviewer.readThread(task)
      adapter.enqueue(textResponse('reviewer saw the completion.'))
      const builderRead2 = await builder.readThread(task)
      const builderDone = await h.ctx.agentTeam.changeClaimForAgent(builder.agent, { requestId: requestId('notify-builder-done'), workspaceId: h.workspaceId, taskRef: task.taskRef, action: 'done', claimRef: (builderClaim as { claim: { claimRef: AgentTeamClaimRef } }).claim.claimRef, baseRevision: builderRead2.thread.revision })
      if (builderDone.kind !== 'committed') throw new Error(`expected committed done, received ${builderDone.kind}`)
      await builder.waitForIdle()
      await reviewer.waitForIdle()
      await reviewer.readThread(task)
      // reviewer: still holds an active Claim at accept time (early accept).
      adapter.enqueue(textResponse('builder saw the review claim.'))
      const reviewerClaim = await reviewer.claimTask(task, 'review')
      await reviewer.waitForIdle()
      await builder.waitForIdle()
      await builder.readThread(task)

      const humanRead = await h.human.readThread(task)
      adapter.enqueue(textResponse('I saw the acceptance.'))
      adapter.enqueue(textResponse('I saw the atomic completion.'))
      // Register the idle waits BEFORE the commit as pure event listeners:
      // both members are idle now and the helper would resolve immediately,
      // so a dedicated listener-only wait is required to observe the wake
      // turns the acceptance is about to start.
      const idleAfterWake = (agent: { id: string }): Promise<void> => new Promise(resolve => {
        const dispose = h.ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject !== agent || status !== 'idle') return
          dispose()
          resolve()
        })
      })
      const builderIdle = idleAfterWake(builder.agent)
      const reviewerIdle = idleAfterWake(reviewer.agent)
      const accepted = await h.ctx.agentTeam.changeTask({ requestId: requestId('notify-accept'), workspaceId: h.workspaceId, taskRef: task.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)

      // Both contributors wake; the notice for the already-done owner names
      // the acceptance of its done Claim, the early-completed one names the
      // atomic completion. The two agents share one adapter, so attribute the
      // wake requests by the responding session's own history, not by queue
      // position: each agent's last request is the accept wake turn.
      await builderIdle
      await reviewerIdle
      const builderClaimRef = (builderClaim as { claim: { claimRef: string } }).claim.claimRef
      const reviewerClaimRef = (reviewerClaim as { claim: { claimRef: string } }).claim.claimRef
      // Attribute the wake requests by agent id (the request's sessionId is
      // the agent's session id), not by adapter queue position: the two agents
      // share one adapter and their turns interleave.
      const requestsFor = (agent: { id: string }): string[] =>
        adapter.requestSessions.map((sessionId, at) => sessionId === agent.id ? at : -1)
          .filter(at => at >= 0).map(at => JSON.stringify(adapter.requests[at]!.messages))
      const builderRequest = requestsFor(builder.agent).at(-1)!
      const reviewerRequest = requestsFor(reviewer.agent).at(-1)!
      expect(builderRequest).toContain('accept')
      expect(builderRequest).toContain(builderClaimRef)
      expect(reviewerRequest).toContain(reviewerClaimRef)
      expect(() => h.ctx.agentTeam.validateLedger()).not.toThrow()
    })

    it('names the atomic completion without an empty finished-Claim clause when the only Claim was early-accepted', async () => {
      const adapter = new ScriptedAdapter()
      const h = await realHarness(adapter)
      const project = await h.human.createProject('engineering')
      const builder = await h.human.addMember('builder', { description: 'Builds changes', projects: [project] })
      const task = await h.human.startTask(project, 'Ship the early accept')
      adapter.enqueue(textResponse('builder saw the task.'))
      await builder.waitForIdle()
      await builder.readThread(task)
      // The owner still holds an ACTIVE Claim at accept time (early accept):
      // the accept completes it atomically, so acceptedOwn === completedOwn
      // for this reader. The combined-semantics branch must not then render
      // an empty "finished Claim" list — regression against the review
      // finding on commit afd2c16.
      const claimed = await builder.claimTask(task, 'implement')
      const humanRead = await h.human.readThread(task)
      adapter.enqueue(textResponse('builder saw the atomic completion.'))
      const builderIdle = new Promise<void>(resolve => {
        const dispose = h.ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject !== builder.agent || status !== 'idle') return
          dispose()
          resolve()
        })
      })
      const accepted = await h.ctx.agentTeam.changeTask({ requestId: requestId('emptyclause-accept'), workspaceId: h.workspaceId, taskRef: task.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
      await builderIdle
      const claimRef = (claimed as { claim: { claimRef: string } }).claim.claimRef
      const builderRequest = JSON.stringify(adapter.requests.at(-1)!.messages)
      expect(builderRequest).toContain('accept')
      // The single-Claim early-accept owner gets the completed semantics
      // alone, naming the Claim the acceptance completed — never an empty
      // "finished Claim" clause.
      expect(builderRequest).toContain('your open Claim')
      expect(builderRequest).toContain(claimRef)
      expect(builderRequest).toContain('was completed with it')
      expect(builderRequest).not.toContain('finished Claim')
      expect(builderRequest).not.toMatch(/Claim\s{2,}/)
      expect(() => h.ctx.agentTeam.validateLedger()).not.toThrow()
    })

    it('blocks activation with a session-refused diagnostic when the current binding is refused, and a restart replays the deterministic refusal', async () => {
      const adapter = new ScriptedAdapter()
      const h = await realHarness(adapter)
      const project = await h.human.createProject('engineering')
      const refused = await h.human.addMember('refused', { description: 'Refused binding', projects: [project] })
      const memberId = refused.memberId
      const sessionId = refused.sessionId
      expect(h.ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.availability).toBe('active')

      // The Member's own current Session becomes deterministically refused.
      // A Host restart re-activates from the persisted binding and must block
      // with the structured refusal diagnostic — not a raw error string.
      const realOpen = h.ctx.sessionPersistence.open.bind(h.ctx.sessionPersistence)
      h.ctx.sessionPersistence.open = async (id, access, options) => {
        if (id === sessionId) throw new SessionFormatUnsupportedError('cannot safely transform unclassified message source (test seam)')
        return realOpen(id, access, options)
      }
      await h.teamFiber.dispose()
      await new Promise(resolve => setImmediate(resolve))
      await h.ctx.plugin(AgentTeam)
      const blocked = await waitFor(() => {
        const status = h.ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        return status !== undefined && status.availability === 'unavailable' ? status : undefined
      })
      expect(blocked.diagnostic).toMatchObject({ class: 'session-refused', sessionId, detail: 'cannot safely transform unclassified message source (test seam)' })

      // No write-side repair pass exists anymore: the read-time conversion owns
      // V3 history, and this bundle no longer authors the refused wrapper
      // shape. A restart therefore re-runs the activation, which replays the
      // deterministic refusal and reports it again — never silently, and never
      // claiming the refusal was healed.
      const recovered = await h.ctx.agentTeam.recoverMember({ requestId: requestId('ref-recover'), workspaceId: h.workspaceId, memberId })
      expect(recovered.status.availability).toBe('unavailable')
      expect(recovered.status.diagnostic).toMatchObject({ class: 'session-refused', sessionId, detail: 'cannot safely transform unclassified message source (test seam)' })
      expect(h.ctx.agents.get(sessionId)).toBeUndefined()
    })

    it('recovers a member by re-running activation once the refusal is gone', async () => {
      const adapter = new ScriptedAdapter()
      const h = await realHarness(adapter)
      const project = await h.human.createProject('engineering')
      const healing = await h.human.addMember('healing', { description: 'Heal retry', projects: [project] })
      const memberId = healing.memberId
      const sessionId = healing.sessionId

      const realOpen = h.ctx.sessionPersistence.open.bind(h.ctx.sessionPersistence)
      h.ctx.sessionPersistence.open = async (id, access, options) => {
        if (id === sessionId) throw new SessionFormatUnsupportedError('cannot safely transform unclassified message source (test seam)')
        return realOpen(id, access, options)
      }
      await h.teamFiber.dispose()
      await new Promise(resolve => setImmediate(resolve))
      await h.ctx.plugin(AgentTeam)
      await waitFor(() => {
        const status = h.ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        return status !== undefined && status.availability === 'unavailable' ? status : undefined
      })

      // The refusal was transient (an out-of-band repair removed it): the
      // restart retry path re-runs the activation, which now succeeds.
      h.ctx.sessionPersistence.open = realOpen
      const recovered = await h.ctx.agentTeam.recoverMember({ requestId: requestId('heal-recover'), workspaceId: h.workspaceId, memberId })
      expect(recovered.status.availability).toBe('active')
      expect(recovered.status.diagnostic).toBeUndefined()
    })

    it('logs a warning with the member handle when activation fails', async () => {
      const adapter = new ScriptedAdapter()
      const h = await realHarness(adapter)
      const project = await h.human.createProject('engineering')
      const p3 = await h.human.addMember('p3member', { description: 'P3 failure visibility', projects: [project] })
      const memberId = p3.memberId

      // A restart against a broken preset fails the activation; the operator
      // must see the member handle in a warning line, not only in the status
      // diagnostic.
      h.presets.failingMount = true
      const warn = vi.spyOn(h.ctx.logger, 'warn')
      await h.teamFiber.dispose()
      await new Promise(resolve => setImmediate(resolve))
      await h.ctx.plugin(AgentTeam)
      await waitFor(() => {
        const status = h.ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        return status !== undefined && status.availability === 'unavailable' && status.diagnostic?.class === 'preset-composition' ? status : undefined
      })
      const failures = warn.mock.calls.map(args => String(args[0])).filter(text => text.includes('activation failed'))
      expect(failures.length).toBeGreaterThan(0)
      expect(failures.some(text => text.includes('p3member'))).toBe(true)
      warn.mockRestore()
    })
})
