import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { TEAM_INBOX_NOTICE_SUMMARY } from '../src/context-projection.ts'
import { cleanups, realHarness, requestId, ScriptedAdapter, textResponse, toolCallResponse, waitFor } from './helpers/member-harness.ts'

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

/** The last Inbox notice the Member's Session actually carries. */
function latestNotice(agent: Agent): string {
  return agent.session.deriveMessages().filter(message => message.role === 'user'
    && message.source.kind === AGENT_TEAM_PLUGIN_ID && message.source.form === 'notice'
    && message.source.summary === TEAM_INBOX_NOTICE_SUMMARY).at(-1)!
    .content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
}

async function runTurn(agent: Agent, adapter: ScriptedAdapter, requests: number): Promise<void> {
  await waitFor(() => adapter.requests.length === requests ? true : undefined)
  await agent.whenIdle()
}

describe('Main notices attribute ordinary facts and keep the reader relation', () => {
  it('counts a non-target ownership change as an ordinary update instead of telling the follower it owns the Project', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const follower = await ctx.agentTeam.addMember({ requestId: requestId('follower'), workspaceId,
      handle: 'follower', description: 'Watches the Main stream', presetId: 'team-member', projectRefs: [projectRef] })
    const agent = ctx.agents.get(follower.status.member.sessionId)!
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('follow'), workspaceId, projectRef, action: 'follow' })
    const target = await ctx.agentTeam.addMember({ requestId: requestId('target'), workspaceId,
      handle: 'target', description: 'Takes ownership', presetId: 'team-member', projectRefs: [projectRef] })
    // A suspended target owns the Project without running a turn of its own.
    await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId: target.status.member.memberId })
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 0, directCount: 0 })

    adapter.enqueue(textResponse('Noted the Main stream change.'))
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('owner'), workspaceId, projectRef,
      memberId: target.status.member.memberId })
    await runTurn(agent, adapter, 1)

    const notice = latestNotice(agent)
    expect(notice).not.toContain('made you an owner')
    expect(notice).not.toContain('You can still take part')
    expect(notice).toContain(`Main stream: 1 unread update · Project ${projectRef}`)
    // Delivery is context, not acknowledgment: the ordinary fact stays unread.
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 1, directCount: 0 })

    // An ordinary Message and the ownership Activity share one count, so each
    // ordinary fact keeps an entry without being expanded into direct text.
    adapter.enqueue(textResponse('Noted the ordinary update.'))
    await ctx.agentTeam.postMainMessage({ requestId: requestId('ordinary'), workspaceId,
      projectRef, body: 'Ordinary Main update' })
    await runTurn(agent, adapter, 2)
    const combined = latestNotice(agent)
    expect(combined).not.toContain('made you an owner')
    expect(combined).toContain(`Main stream: 2 unread updates · Project ${projectRef}`)
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 2, directCount: 0 })
  })

  it('names each Project on its own ordinary Main stream count when two Projects differ', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const alpha = await ctx.agentTeam.createProject({ requestId: requestId('alpha'), workspaceId,
      name: 'Alpha', description: 'First Project' })
    const beta = await ctx.agentTeam.createProject({ requestId: requestId('beta'), workspaceId,
      name: 'Beta', description: 'Second Project' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('reader'), workspaceId,
      handle: 'reader', description: 'Reads both streams', presetId: 'team-member',
      projectRefs: [alpha.project.projectRef, beta.project.projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('follow-alpha'), workspaceId,
      projectRef: alpha.project.projectRef, action: 'follow' })
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('follow-beta'), workspaceId,
      projectRef: beta.project.projectRef, action: 'follow' })

    adapter.enqueue(textResponse('Noted the Alpha update.'))
    await ctx.agentTeam.postMainMessage({ requestId: requestId('alpha-1'), workspaceId,
      projectRef: alpha.project.projectRef, body: 'Alpha ordinary update' })
    await runTurn(agent, adapter, 1)
    for (let index = 1; index <= 2; index += 1) {
      adapter.enqueue(textResponse(`Noted Beta update ${index}.`))
      await ctx.agentTeam.postMainMessage({ requestId: requestId(`beta-${index}`), workspaceId,
        projectRef: beta.project.projectRef, body: `Beta ordinary update ${index}` })
      await runTurn(agent, adapter, index + 1)
    }

    adapter.enqueue(textResponse('Noted the Alpha direct.'))
    await ctx.agentTeam.postMainMessage({ requestId: requestId('alpha-direct'), workspaceId,
      projectRef: alpha.project.projectRef, body: '@reader Check Alpha.' })
    await runTurn(agent, adapter, 4)
    adapter.enqueue(textResponse('Noted the Beta direct.'))
    await ctx.agentTeam.postMainMessage({ requestId: requestId('beta-direct'), workspaceId,
      projectRef: beta.project.projectRef, body: '@reader Check Beta.' })
    await runTurn(agent, adapter, 5)
    const notice = latestNotice(agent)
    expect(notice.indexOf('Check Beta.')).toBeLessThan(notice.indexOf('Main stream: 1 unread update'))
    expect(notice).toContain(`Main stream: 1 unread update · Project ${alpha.project.projectRef}`)
    expect(notice).toContain(`Main stream: 2 unread updates · Project ${beta.project.projectRef}`)
  })

  it('keeps Replies to when a Thread direct reply body is already on the surface', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const anchor = await ctx.agentTeam.startThread({ requestId: requestId('anchor'), workspaceId,
      projectRef, kind: 'discussion', body: 'Anchor for the quoted reply' })
    if (anchor.kind !== 'committed') throw new Error('anchor failed')
    const threadRef = anchor.thread.threadRef
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('follow'), workspaceId, threadRef, action: 'follow' })

    adapter.enqueue(textResponse('Noted the quoted reply.'))
    const first = await ctx.agentTeam.reply({ requestId: requestId('first'), workspaceId, threadRef,
      body: '@builder first quoted reply', replyToMessageRef: anchor.message.messageRef, baseRevision: anchor.thread.revision })
    if (first.kind !== 'committed') throw new Error('first reply failed')
    await runTurn(agent, adapter, 1)

    const original = agent.session.surface.nodes.slice(1)
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Previous notice removed.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(original[0]!), endSeq: SessionSeq(original.at(-1)!) }, sourceEventSeqs: [...original],
    })
    // The verbatim Message query supplies the body, but not its reply relation.
    adapter.enqueue(toolCallResponse('message-call', 'team_thread', { action: 'message', threadRef, messageRef: first.message.messageRef }))
    adapter.enqueue(textResponse('Read the earlier reply.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check the quoted reply.' }], source: { kind: 'user' } }))
    await runTurn(agent, adapter, 3)
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items
      .find(item => item.thread.threadRef === threadRef)).toMatchObject({ unreadCount: 1, directCount: 1 })

    adapter.enqueue(textResponse('Noted the second direct.'))
    const second = await ctx.agentTeam.reply({ requestId: requestId('second'), workspaceId, threadRef,
      body: '@builder second direct body', baseRevision: first.thread.revision })
    if (second.kind !== 'committed') throw new Error('second reply failed')
    await runTurn(agent, adapter, 4)

    const notice = latestNotice(agent)
    expect(notice).toContain('second direct body')
    expect(notice).toContain('already in current context; still unread')
    expect(notice).toContain(first.message.messageRef)
    expect(notice).toContain(`Replies to: @human — "Anchor for the quoted reply" [${anchor.message.messageRef}]`)
    expect(notice).not.toContain('first quoted reply')
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items
      .find(item => item.thread.threadRef === threadRef)).toMatchObject({ unreadCount: 2, directCount: 2 })
  })

  it('keeps Replies to when a Main direct reply body is already on the surface', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const anchor = await ctx.agentTeam.postMainMessage({ requestId: requestId('anchor'), workspaceId,
      projectRef, body: 'Main anchor message' })
    if (anchor.kind !== 'committed') throw new Error('anchor failed')

    adapter.enqueue(textResponse('Noted the Main quoted reply.'))
    const first = await ctx.agentTeam.postMainMessage({ requestId: requestId('first'), workspaceId, projectRef,
      body: '@builder first Main quoted reply', replyToMessageRef: anchor.message.messageRef })
    if (first.kind !== 'committed') throw new Error('first Main reply failed')
    await runTurn(agent, adapter, 1)

    const original = agent.session.surface.nodes.slice(1)
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Previous notice removed.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(original[0]!), endSeq: SessionSeq(original.at(-1)!) }, sourceEventSeqs: [...original],
    })
    adapter.enqueue(toolCallResponse('message-call', 'team_thread', { action: 'message', projectRef, messageRef: first.message.messageRef }))
    adapter.enqueue(textResponse('Read the earlier Main reply.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check the quoted Main reply.' }], source: { kind: 'user' } }))
    await runTurn(agent, adapter, 3)
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 1, directCount: 1 })

    adapter.enqueue(textResponse('Noted the second Main direct.'))
    const second = await ctx.agentTeam.postMainMessage({ requestId: requestId('second'), workspaceId,
      projectRef, body: '@builder second Main direct body' })
    if (second.kind !== 'committed') throw new Error('second Main reply failed')
    await runTurn(agent, adapter, 4)

    const notice = latestNotice(agent)
    expect(notice).toContain('second Main direct body')
    expect(notice).toContain('already in current context; still unread')
    expect(notice).toContain(first.message.messageRef)
    expect(notice).toContain(`Replies to: @human — "Main anchor message" [${anchor.message.messageRef}]`)
    expect(notice).not.toContain('first Main quoted reply')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 2, directCount: 2 })
  })
})
