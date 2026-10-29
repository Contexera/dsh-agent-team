import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/index.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { cleanups, realHarness, ScriptedAdapter, textResponse, toolCallResponse, requestId, waitFor, waitForIdle } from './helpers/member-harness.ts'

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

describe('complete Activity notices supply context without acknowledging it', () => {
  it('states both sides of a Task transfer and permits a reply while leaving it unread', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Review', description: 'Independent release review' })
    const member = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(member.status.member.sessionId)!
    adapter.enqueue(textResponse('Noted ownership.'))
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId,
      projectRef: project.project.projectRef, memberId: member.status.member.memberId })
    await waitFor(() => adapter.requests.length === 1 ? true : undefined)
    await waitForIdle(ctx, agent)
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('task'), workspaceId,
      projectRef: project.project.projectRef, body: 'Verify the installer' })
    if (started.kind !== 'committed') throw new Error('setup failed')
    await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('read'), workspaceId, threadRef: started.thread.threadRef })
    adapter.enqueue(textResponse('I will review the installer.'))
    const before = adapter.requests.length
    const transfer = await ctx.agentTeam.transferTask({ requestId: requestId('transfer'), workspaceId,
      taskRef: started.task!.taskRef, target: member.status.member.memberId, baseRevision: started.thread.revision })
    if (transfer.kind !== 'committed') throw new Error('transfer failed')
    await waitFor(() => adapter.requests.length > before ? true : undefined)
    await waitForIdle(ctx, agent)
    const text = JSON.stringify(adapter.requests.at(-1)!.messages)
    expect(text).toContain(`from ${AGENT_TEAM_HUMAN_MEMBER_ID}`)
    expect(text).toContain(`to ${member.status.member.memberId}`)
    const result = await ctx.agentTeam.replyForAgent(agent, { requestId: requestId('reply'), workspaceId,
      threadRef: started.thread.threadRef, body: 'Checking the installer independently.', baseRevision: transfer.thread.revision })
    expect(result.kind).toBe('committed')
    expect(ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === started.thread.threadRef))
      .toMatchObject({ unreadCount: 1, directCount: 1 })
    const beforeRead = adapter.requests.length
    adapter.enqueue(toolCallResponse('read-notice', 'team_thread', { action: 'read', threadRef: started.thread.threadRef }))
    adapter.enqueue(textResponse('Read the transfer.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Acknowledge the transfer.' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length >= beforeRead + 2 ? true : undefined)
    await waitForIdle(ctx, agent)
    const read = agent.session.deriveMessages().filter(message => message.role === 'tool').at(-1)!
      .content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    expect(read).toContain('acknowledged 1 unread update(s)')
    expect(read).toContain('complete event already in current context; omitted')
    expect(read).not.toContain(`from ${AGENT_TEAM_HUMAN_MEMBER_ID}`)
  })
})
