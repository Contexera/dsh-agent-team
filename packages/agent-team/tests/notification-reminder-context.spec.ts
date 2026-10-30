import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { cleanups, GatedAdapter, realHarness, requestId, textResponse, waitFor } from './helpers/member-harness.ts'

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('bounded notices retain a route to live Task reminders', () => {
  it('explicitly names a reminder omitted behind twenty direct facts without consuming it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-30T08:00:00Z'))
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release checks' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks packages', presetId: 'team-member', projectRefs: [projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check pending work.' }], source: { kind: 'user' } }))
    await adapter.started.promise
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId, projectRef, memberId: added.status.member.memberId })
    const task = await ctx.agentTeam.startThread({ requestId: requestId('task'), workspaceId, projectRef,
      kind: 'task', accountable: added.status.member.memberId, body: 'Check the stalled package.' })
    if (task.kind !== 'committed' || task.task === undefined) throw new Error('Task failed')
    const threadRef = task.thread.threadRef
    const initial = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('read-task'), workspaceId, threadRef })
    const claim = await ctx.agentTeam.changeClaimForAgent(agent, { requestId: requestId('claim'), workspaceId,
      taskRef: task.task.taskRef, action: 'claim', direction: 'Package checks', baseRevision: initial.thread.revision })
    if (claim.kind !== 'committed') throw new Error('Claim failed')
    await ctx.agentTeam.readMainStreamForAgent(agent, { requestId: requestId('read-main'), workspaceId, projectRef })
    vi.setSystemTime(new Date('2026-10-31T09:00:00Z'))
    await waitFor(() => ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items
      .find(item => item.thread.threadRef === threadRef)?.reminders.length === 1 ? true : undefined)
    for (let index = 0; index < 20; index += 1) {
      const post = await ctx.agentTeam.postMainMessage({ requestId: requestId(`direct-${index}`), workspaceId,
        projectRef, body: `@builder New check ${index}.` })
      if (post.kind !== 'committed') throw new Error('Main post failed')
    }
    adapter.enqueue(textResponse('Reviewing the new checks.'))
    adapter.release.resolve()
    await agent.whenIdle()
    const text = agent.session.deriveMessages().filter(message => message.role === 'user'
      && message.source.kind === '@wowyuarm/dsh-agent-team' && message.source['form'] === 'notice').at(-1)!
      .content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    expect(text).toContain(`Direct Team signal not expanded: 1 in Thread ${threadRef}`)
    expect(text).toContain('team_inbox')
    expect(text.length).toBeLessThanOrEqual(32 * 1024)
    const item = ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items.find(item => item.thread.threadRef === threadRef)!
    expect(item.unreadCount).toBe(1)
    expect(item.directCount).toBe(1)
    expect(item.reminders).toHaveLength(1)
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 20, directCount: 20 })
    const read = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('acknowledge-reminder'), workspaceId, threadRef })
    expect(read.reminders).toHaveLength(1)
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items.find(item => item.thread.threadRef === threadRef)?.reminders ?? []).toEqual([])
  })
})
