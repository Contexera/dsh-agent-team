import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { cleanups, realHarness, ScriptedAdapter, textResponse, toolCallResponse, requestId, waitFor } from './helpers/member-harness.ts'
import { visibleTeamSurface } from '../src/surface-visibility.ts'

vi.setConfig({ testTimeout: 60_000 })

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

describe('a complete Activity rejection lets the writer reconsider without a read', () => {
  it('shows a transfer with both Members beside the mixed Message, then commits and keeps both unread', async () => {
    const adapter = new ScriptedAdapter()
    const test = await realHarness(adapter)
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: test.workspaceId,
      name: 'Release checks', description: 'Verify the signed installer' })
    const projectRef = project.project.projectRef
    const member = await test.ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: test.workspaceId,
      handle: 'builder', description: 'Verifies releases', presetId: 'team-member', projectRefs: [projectRef] })
    const memberId = member.status.member.memberId
    const agent = test.ctx.agents.get(member.status.member.sessionId)!
    await test.ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId: test.workspaceId, projectRef, memberId })
    const started = await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('thread'),
      workspaceId: test.workspaceId, projectRef, body: 'Verify the signed installer' })
    if (started.kind !== 'committed' || started.task === undefined) throw new Error('setup failed')
    const threadRef = started.thread.threadRef
    const transferred = await test.ctx.agentTeam.transferTask({ requestId: requestId('transfer'), workspaceId: test.workspaceId,
      taskRef: started.task.taskRef, target: memberId, baseRevision: started.thread.revision })
    if (transferred.kind !== 'committed') throw new Error('setup transfer failed')
    const update = await test.ctx.agentTeam.reply({ requestId: requestId('update'), workspaceId: test.workspaceId,
      threadRef, body: 'Release checklist updated.', baseRevision: transferred.thread.revision })
    if (update.kind !== 'committed') throw new Error('setup reply failed')

    async function call(callId: string, body: string, baseRevision: number) {
      const before = adapter.requests.length
      adapter.enqueue(toolCallResponse(callId, 'team_message', { action: 'reply', threadRef, body, baseRevision }))
      adapter.enqueue(textResponse('Reconsidered.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reconsider the release check.' }], source: { kind: 'user' } }))
      await waitFor(() => adapter.requests.length >= before + 2 ? true : undefined)
      await agent.whenIdle()
      return agent.session.deriveMessages().filter(message => message.role === 'tool')
        .flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : [])).at(-1)!
    }

    // A notice may already have delivered the transfer; crop the surface so the
    // rejection itself must prove the complete event.
    const nodes = agent.session.surface.nodes.slice(1)
    if (nodes.length > 0) {
      agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary: continue the release check.' }], source: { kind: 'user' } }), {
        surfaceOp: { op: 'replace', startSeq: SessionSeq(nodes[0]!), endSeq: SessionSeq(nodes.at(-1)!) }, sourceEventSeqs: [...nodes],
      })
    }
    expect(visibleTeamSurface(agent)).toHaveLength(0)

    const rejected = await call('stale-attempt', 'I will verify the installer.', started.thread.revision)
    expect(rejected).toContain('Not committed — unread_required.')
    // The complete immutable event: what changed, who handed it over, and to whom.
    expect(rejected).toContain(`human transfer Task ${started.task.taskRef}`)
    expect(rejected).toContain(threadRef)
    expect(rejected).toContain('from member:human')
    expect(rejected).toContain(`to ${memberId}`)
    expect(rejected).toContain('Release checklist updated.')
    expect(rejected).toContain(`Next write — baseRevision: ${update.thread.revision}`)
    // The rendered Activity is bound to this exact tool output, not carried as unverified text.
    expect(visibleTeamSurface(agent).some(surface => surface.activities.length > 0)).toBe(true)

    const committed = await call('current-attempt', 'Verified the signed installer.', update.thread.revision)
    expect(committed).toContain('Committed — reply added.')
    expect(committed).not.toContain('unread_required')

    const inbox = test.ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)
    expect(inbox?.unreadCount).toBe(2)
    expect(inbox?.attention?.readThroughSequence).toBeLessThan(inbox!.newestSequence)

    // A later read acknowledges both while repeating only the Activity's identity:
    // the complete event is already bound above, and the omitting read binds nothing.
    await test.ctx.agentTeam.readThread({ requestId: requestId('human-before-new'), workspaceId: test.workspaceId, threadRef })
    adapter.enqueue(textResponse('Noted the additional check.'))
    const newUpdate = await test.ctx.agentTeam.reply({ requestId: requestId('new-update'), workspaceId: test.workspaceId,
      threadRef, body: 'Also test the unsigned package rejection.', baseRevision: test.ctx.agentTeam.threadHistoryForAgent(agent, { workspaceId: test.workspaceId, threadRef }).thread.revision })
    if (newUpdate.kind !== 'committed') throw new Error('new update failed')
    await agent.whenIdle()
    const refusedAgain = await call('new-missing-fact', 'Release approved.', newUpdate.thread.revision)
    expect(refusedAgain).toContain('Not committed — unread_required.')
    expect(refusedAgain).toContain('Also test the unsigned package rejection.')
    const completeNodes = agent.session.surface.nodes.slice(1)
    const before = adapter.requests.length
    adapter.enqueue(toolCallResponse('read-both', 'team_thread', { action: 'read', threadRef }))
    adapter.enqueue(textResponse('Read.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the Thread.' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length >= before + 2 ? true : undefined)
    await agent.whenIdle()
    const read = agent.session.deriveMessages().filter(message => message.role === 'tool')
      .flatMap(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : [])).at(-1)!
    expect(read).toContain('acknowledged 3 unread update(s)')
    expect(read).toContain('complete event already in current context; omitted')
    expect(read).not.toContain('from member:human')
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Earlier complete event removed.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(completeNodes[0]!), endSeq: SessionSeq(completeNodes.at(-1)!) }, sourceEventSeqs: [...completeNodes],
    })
    expect(visibleTeamSurface(agent).flatMap(surface => surface.activities)
      .filter(activity => activity.scope === 'thread' && activity.threadRef === threadRef)).toHaveLength(0)
  })
})
