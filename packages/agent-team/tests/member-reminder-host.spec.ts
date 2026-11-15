import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { TEAM_INBOX_NOTICE_SUMMARY } from '../src/context-projection.ts'
import type { AgentTeamReminderRef } from '../src/types.ts'
import { realHarness, requestId, ScriptedAdapter, textResponse, waitFor } from './helpers/member-harness.ts'

/** The last Team Inbox notice the Member's Session actually carries. */
function latestNotice(agent: Agent): string {
  return agent.session.deriveMessages().filter(message => message.role === 'user'
    && message.source.kind === AGENT_TEAM_PLUGIN_ID && message.source.form === 'notice'
    && message.source.summary === TEAM_INBOX_NOTICE_SUMMARY).at(-1)!
    .content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
}

/** One Member with a real persisted log, already idle after one turn. */
async function idleMember(tag: string) {
  const adapter = new ScriptedAdapter()
  const { ctx, workspaceId } = await realHarness(adapter)
  const project = await ctx.agentTeam.createProject({ requestId: requestId(`${tag}-project`), workspaceId,
    name: 'engineering', description: 'Engineering work' })
  const added = await ctx.agentTeam.addMember({ requestId: requestId(`${tag}-add`), workspaceId, handle: 'builder',
    description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' }})
  const agent = ctx.agents.get(added.status.member.sessionId)!
  adapter.enqueue(textResponse('First look done.'))
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return { adapter, ctx, workspaceId, memberId: added.status.member.memberId, agent }
}

describe('a Member reminder reaches its own Member and is consumed when it does', () => {
  it('wakes the idle Member with a private notice and records the occurrence consumed once it enters a turn', async () => {
    const { adapter, ctx, workspaceId, memberId, agent } = await idleMember('reminder-wake')
    const reminderRef = 'reminder:host-wake' as AgentTeamReminderRef
    const note = 'check the CI run before reviewing'
    // A one-shot reminder already due: the Host raises it on the next evaluation.
    await ctx.agentTeam.createMemberReminderForAgent(agent, { requestId: requestId('create'), workspaceId, reminderRef,
      schedule: { kind: 'once', at: new Date(Date.now() - 60_000).toISOString() }, note })
    // The wake puts the notice in front of the model, which spends a turn on it.
    adapter.enqueue(textResponse('Handled the reminder.'))
    await waitFor(() => adapter.requests.length === 2 ? true : undefined)
    await agent.whenIdle()

    const notice = latestNotice(agent)
    expect(notice).toContain('Team reminder, private to you')
    expect(notice).toContain(note)
    expect(notice).toContain(reminderRef)
    // The notice is private to this Member: it names no Thread and no other Member's work.
    expect(notice).not.toContain('Thread ')

    // The notice entered a turn, so the occurrence is consumed and nothing is owed.
    expect(ctx.agentTeam['ledger']!.unreadMemberRemindersFor(memberId)).toEqual([])
    const [view] = ctx.agentTeam['ledger']!.memberRemindersOf(memberId)
    expect(view?.reminder.state).toBe('done')
    expect(view?.pendingOccurrenceAt).toBeUndefined()
    expect(view?.lastOccurrenceAt).toBeDefined()
  })

  it('lists and cancels through the Member surface, and the Human may cancel the rest', async () => {
    const { ctx, workspaceId, memberId, agent } = await idleMember('reminder-cancel')
    await ctx.agentTeam.createMemberReminderForAgent(agent, { requestId: requestId('create-1'), workspaceId,
      reminderRef: 'reminder:host-list-1' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 30 }, note: 'first' })
    await ctx.agentTeam.createMemberReminderForAgent(agent, { requestId: requestId('create-2'), workspaceId,
      reminderRef: 'reminder:host-list-2' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 45 }, note: 'second' })
    expect(ctx.agentTeam.memberRemindersForAgent(agent, { workspaceId }).map(view => view.reminder.note)).toEqual(['second', 'first'])

    await ctx.agentTeam.cancelMemberReminderForAgent(agent, { requestId: requestId('cancel-own'), workspaceId,
      reminderRef: 'reminder:host-list-2' as AgentTeamReminderRef })
    expect(ctx.agentTeam.memberRemindersForAgent(agent, { workspaceId }).map(view => view.reminder.state)).toEqual(['cancelled', 'active'])

    // Member detail is the Human's control over the same reminders.
    expect(ctx.agentTeam.memberRemindersForClient({ requestId: requestId('human-list'), workspaceId, memberId })
      .map(view => view.reminder.reminderRef)).toEqual(['reminder:host-list-2', 'reminder:host-list-1'])
    await ctx.agentTeam.cancelMemberReminderForClient({ requestId: requestId('human-cancel'), workspaceId,
      reminderRef: 'reminder:host-list-1' as AgentTeamReminderRef })
    expect(ctx.agentTeam.memberRemindersForAgent(agent, { workspaceId }).every(view => view.reminder.state === 'cancelled')).toBe(true)
  })

  it('refuses a note that says nothing and an interval under the floor', async () => {
    const { ctx, workspaceId, agent } = await idleMember('reminder-refuse')
    await expect(ctx.agentTeam.createMemberReminderForAgent(agent, { requestId: requestId('blank'), workspaceId,
      reminderRef: 'reminder:host-blank' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 30 }, note: '   ' }))
      .rejects.toThrow(/what this reminder is for/)
    await expect(ctx.agentTeam.createMemberReminderForAgent(agent, { requestId: requestId('fast'), workspaceId,
      reminderRef: 'reminder:host-fast' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 5 }, note: 'too fast' }))
      .rejects.toThrow(/at least 10/)
  })
})
