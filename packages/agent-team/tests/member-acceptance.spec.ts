import { afterEach, describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })
import { Context } from '@deepseek-ai/cordis'
import AgentTeam from '../src/index.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isAcceptanceNotice } from '../src/context-projection.ts'
import { ACCEPTANCE_COMPACT_TOKENS } from '../src/acceptance-context.ts'
import { MEMBER_COMPACT_TOKENS } from '../src/member-compaction.ts'
import type { AgentTeamClaimRef } from '../src/types.ts'

import { realHarness, ScriptedAdapter, acceptanceReminders, textResponse, waitFor, waitForIdle, requestId } from './helpers/member-harness.ts'



describe('Agent Team Member lifecycle: context, acceptance, and activation (ticket 04)', () => {
    it('leaves an acceptance below the budget as a reminder alone', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('noauto-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('noauto-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
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
      const added = await ctx.agentTeam.addMember({ requestId: requestId('budget-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
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
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('bystander-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const watcher = await ctx.agentTeam.addMember({ requestId: requestId('bystander-watcher'), workspaceId, handle: 'watcher', description: 'Watches the work', presetId: 'team-member', projectRefs: [project.project.projectRef] })
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

    it('resolves the same Host policy through the real preset engine scope', async () => {
      const { ctx, workspaceId } = await realHarness(new ScriptedAdapter(), 'jsonl', undefined, true)
      const added = await ctx.agentTeam.addMember({ requestId: requestId('engine-scope'), workspaceId,
        handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
      expect(added.status.availability).toBe('active')
      const live = ctx.agents.get(added.status.member.sessionId)!
      const engine = ctx.agentPresets.serviceFor(live, 'compaction') as unknown as { ctx: Context }
      expect(engine.ctx.get('agentTeam')?.config.memberCompaction).toBe(ctx.agentTeam.config.memberCompaction)
    })

    it('compacts a Member through the preset engine at the configured budget', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('hard-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('hard-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const live = ctx.agents.get(added.status.member.sessionId)!

      const compactions: string[] = []
      const engine = {
        compactIfNeeded: async (_agent: unknown, trigger: string) => {
          compactions.push(trigger)
          pressureState.usageTokens = 0
          return null
        },
      }
      const serviceFor = vi.spyOn(ctx.agentPresets, 'serviceFor').mockImplementation((_agent, service) => service === 'compaction' ? engine as never : undefined)
      try {
        // Below the boundary, a turn runs to completion without compaction.
        pressureState.usageTokens = MEMBER_COMPACT_TOKENS - 1
        adapter.enqueue(textResponse('First answer.'))
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'First question?' }], source: { kind: 'user' } }))
        await waitForIdle(ctx, live)
        expect(compactions).toHaveLength(0)

        pressureState.usageTokens = MEMBER_COMPACT_TOKENS + 1
        adapter.enqueue(textResponse('Second answer.'))
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'Second question?' }], source: { kind: 'user' } }))
        await waitFor(() => compactions.length > 0 ? compactions : undefined)
        await waitForIdle(ctx, live)
        expect(compactions).toHaveLength(1)
        expect(compactions).toEqual(['context-overflow'])
      } finally {
        serviceFor.mockRestore()
      }
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)).toBeDefined()
    })

    it('uses the window ratio for a 272K Member instead of skipping its budget', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('small-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('small-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const live = ctx.agents.get(added.status.member.sessionId)!

      adapter.resolveModelWindow = () => 272_000
      let compacted = 0
      const engine = {
        compactIfNeeded: async () => { compacted += 1; pressureState.usageTokens = 0; return null },
      }
      const serviceFor = vi.spyOn(ctx.agentPresets, 'serviceFor').mockImplementation((_agent, service) => service === 'compaction' ? engine as never : undefined)
      try {
        pressureState.usageTokens = 217_601
        adapter.enqueue(textResponse('Answer.'))
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'Question?' }], source: { kind: 'user' } }))
        await waitForIdle(ctx, live)
        expect(compacted).toBe(1)
      } finally {
        serviceFor.mockRestore()
      }
    })

    it('wakes a normal-accept contributor with both the accepted and completed Claim semantics', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('notify-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('notify-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('notify-reviewer'), workspaceId, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('notify-task'), workspaceId, projectRef: project.project.projectRef, body: 'Ship both semantics' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const builderAgent = ctx.agents.get(builder.status.member.sessionId)!
      const reviewerAgent = ctx.agents.get(reviewer.status.member.sessionId)!
      adapter.enqueue(textResponse('builder saw the task.'))
      adapter.enqueue(textResponse('reviewer saw the task.'))
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, reviewerAgent)
      // Advance both members' read watermarks so their initial-start unread
      // facts are consumed: a member with no unread facts is not woken by the
      // other member's Claim mutations, which keeps the scripted wake turns
      // below attributable to exactly one member at a time.
      await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('notify-builder-initial-read'), workspaceId, taskRef: started.task!.taskRef })
      await ctx.agentTeam.readThreadForAgent(reviewerAgent, { requestId: requestId('notify-reviewer-initial-read'), workspaceId, taskRef: started.task!.taskRef })

      // builder: finished its Claim before the accept (normal flow). Each
      // mutation wakes only the OTHER following member with an unread
      // activity (a member's own activity is never unread to itself), so one
      // scripted response per commit suffices; the mutating member itself
      // stays idle and the helper resolves immediately for it.
      adapter.enqueue(textResponse('reviewer saw the claim.'))
      const builderRead = await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('notify-builder-read'), workspaceId, taskRef: started.task!.taskRef })
      const builderClaim = await ctx.agentTeam.changeClaimForAgent(builderAgent, { requestId: requestId('notify-builder-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: builderRead.thread.revision, direction: 'implement' })
      if (builderClaim.kind !== 'committed') throw new Error(`expected committed claim, received ${builderClaim.kind}`)
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, reviewerAgent)
      // Consume the claim activity so later wake turns stay attributable to
      // exactly one mutation at a time.
      await ctx.agentTeam.readThreadForAgent(reviewerAgent, { requestId: requestId('notify-reviewer-claim-read'), workspaceId, taskRef: started.task!.taskRef })
      adapter.enqueue(textResponse('reviewer saw the completion.'))
      const builderRead2 = await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('notify-builder-read-2'), workspaceId, taskRef: started.task!.taskRef })
      const builderDone = await ctx.agentTeam.changeClaimForAgent(builderAgent, { requestId: requestId('notify-builder-done'), workspaceId, taskRef: started.task!.taskRef, action: 'done', claimRef: (builderClaim as { claim: { claimRef: AgentTeamClaimRef } }).claim.claimRef, baseRevision: builderRead2.thread.revision })
      if (builderDone.kind !== 'committed') throw new Error(`expected committed done, received ${builderDone.kind}`)
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, reviewerAgent)
      await ctx.agentTeam.readThreadForAgent(reviewerAgent, { requestId: requestId('notify-reviewer-done-read'), workspaceId, taskRef: started.task!.taskRef })
      // reviewer: still holds an active Claim at accept time (early accept).
      adapter.enqueue(textResponse('builder saw the review claim.'))
      const reviewerRead = await ctx.agentTeam.readThreadForAgent(reviewerAgent, { requestId: requestId('notify-reviewer-read'), workspaceId, taskRef: started.task!.taskRef })
      const reviewerClaim = await ctx.agentTeam.changeClaimForAgent(reviewerAgent, { requestId: requestId('notify-reviewer-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: reviewerRead.thread.revision, direction: 'review' })
      if (reviewerClaim.kind !== 'committed') throw new Error(`expected committed claim, received ${reviewerClaim.kind}`)
      await waitForIdle(ctx, reviewerAgent)
      await waitForIdle(ctx, builderAgent)
      await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('notify-builder-review-read'), workspaceId, taskRef: started.task!.taskRef })

      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('notify-human-read'), workspaceId, taskRef: started.task!.taskRef })
      adapter.enqueue(textResponse('I saw the acceptance.'))
      adapter.enqueue(textResponse('I saw the atomic completion.'))
      // Register the idle waits BEFORE the commit as pure event listeners:
      // both members are idle now and the helper would resolve immediately,
      // so a dedicated listener-only wait is required to observe the wake
      // turns the acceptance is about to start.
      const idleAfterWake = (agent: { id: string }): Promise<void> => new Promise(resolve => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject !== agent || status !== 'idle') return
          dispose()
          resolve()
        })
      })
      const builderIdle = idleAfterWake(builderAgent)
      const reviewerIdle = idleAfterWake(reviewerAgent)
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('notify-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
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
      const builderRequest = requestsFor(builderAgent).at(-1)!
      const reviewerRequest = requestsFor(reviewerAgent).at(-1)!
      expect(builderRequest).toContain('accept')
      expect(builderRequest).toContain(builderClaimRef)
      expect(reviewerRequest).toContain(reviewerClaimRef)
      expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    })

    it('names the atomic completion without an empty finished-Claim clause when the only Claim was early-accepted', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('emptyclause-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('emptyclause-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('emptyclause-task'), workspaceId, projectRef: project.project.projectRef, body: 'Ship the early accept' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const builderAgent = ctx.agents.get(builder.status.member.sessionId)!
      adapter.enqueue(textResponse('builder saw the task.'))
      await waitForIdle(ctx, builderAgent)
      await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('emptyclause-initial-read'), workspaceId, taskRef: started.task!.taskRef })
      // The owner still holds an ACTIVE Claim at accept time (early accept):
      // the accept completes it atomically, so acceptedOwn === completedOwn
      // for this reader. The combined-semantics branch must not then render
      // an empty "finished Claim" list — regression against the review
      // finding on commit afd2c16.
      const claimed = await ctx.agentTeam.changeClaimForAgent(builderAgent, { requestId: requestId('emptyclause-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: started.thread.revision, direction: 'implement' })
      if (claimed.kind !== 'committed') throw new Error(`expected committed claim, received ${claimed.kind}`)
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('emptyclause-human-read'), workspaceId, taskRef: started.task!.taskRef })
      adapter.enqueue(textResponse('builder saw the atomic completion.'))
      const builderIdle = new Promise<void>(resolve => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject !== builderAgent || status !== 'idle') return
          dispose()
          resolve()
        })
      })
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('emptyclause-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
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
      expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    })

    it('blocks activation with a session-refused diagnostic when the current binding is refused, and a restart replays the deterministic refusal', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, teamFiber: initialFiber } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('ref-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('ref-add'), workspaceId, handle: 'refused', description: 'Refused binding', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      expect(added.status.availability).toBe('active')

      // The Member's own current Session becomes deterministically refused.
      // A Host restart re-activates from the persisted binding and must block
      // with the structured refusal diagnostic — not a raw error string.
      const realOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      ctx.sessionPersistence.open = async (id, access, options) => {
        if (id === sessionId) throw new SessionFormatUnsupportedError('cannot safely transform unclassified message source (test seam)')
        return realOpen(id, access, options)
      }
      await initialFiber.dispose()
      await new Promise(resolve => setImmediate(resolve))
      await ctx.plugin(AgentTeam)
      const blocked = await waitFor(() => {
        const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        return status !== undefined && status.availability === 'unavailable' ? status : undefined
      })
      expect(blocked.diagnostic).toMatchObject({ class: 'session-refused', sessionId, detail: 'cannot safely transform unclassified message source (test seam)' })

      // No write-side repair pass exists anymore: the read-time conversion owns
      // V3 history, and this bundle no longer authors the refused wrapper
      // shape. A restart therefore re-runs the activation, which replays the
      // deterministic refusal and reports it again — never silently, and never
      // claiming the refusal was healed.
      const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('ref-recover'), workspaceId, memberId })
      expect(recovered.status.availability).toBe('unavailable')
      expect(recovered.status.diagnostic).toMatchObject({ class: 'session-refused', sessionId, detail: 'cannot safely transform unclassified message source (test seam)' })
      expect(ctx.agents.get(sessionId)).toBeUndefined()
    })

    it('recovers a member by re-running activation once the refusal is gone', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, teamFiber: initialFiber } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('heal-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('heal-add'), workspaceId, handle: 'healing', description: 'Heal retry', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId

      const realOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      ctx.sessionPersistence.open = async (id, access, options) => {
        if (id === sessionId) throw new SessionFormatUnsupportedError('cannot safely transform unclassified message source (test seam)')
        return realOpen(id, access, options)
      }
      await initialFiber.dispose()
      await new Promise(resolve => setImmediate(resolve))
      await ctx.plugin(AgentTeam)
      await waitFor(() => {
        const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        return status !== undefined && status.availability === 'unavailable' ? status : undefined
      })

      // The refusal was transient (an out-of-band repair removed it): the
      // restart retry path re-runs the activation, which now succeeds.
      ctx.sessionPersistence.open = realOpen
      const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('heal-recover'), workspaceId, memberId })
      expect(recovered.status.availability).toBe('active')
      expect(recovered.status.diagnostic).toBeUndefined()
    })

    it('logs a warning with the member handle when activation fails', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, presets, teamFiber: initialFiber } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('p3-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('p3-add'), workspaceId, handle: 'p3member', description: 'P3 failure visibility', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId

      // A restart against a broken preset fails the activation; the operator
      // must see the member handle in a warning line, not only in the status
      // diagnostic.
      presets.failingMount = true
      const warn = vi.spyOn(ctx.logger, 'warn')
      await initialFiber.dispose()
      await new Promise(resolve => setImmediate(resolve))
      await ctx.plugin(AgentTeam)
      await waitFor(() => {
        const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        return status !== undefined && status.availability === 'unavailable' && status.diagnostic?.class === 'preset-composition' ? status : undefined
      })
      const failures = warn.mock.calls.map(args => String(args[0])).filter(text => text.includes('activation failed'))
      expect(failures.length).toBeGreaterThan(0)
      expect(failures.some(text => text.includes('p3member'))).toBe(true)
      warn.mockRestore()
    })
})
