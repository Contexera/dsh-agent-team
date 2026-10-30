import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { cleanups, GatedAdapter, ScriptedAdapter, realHarness, requestId, textResponse, waitFor } from './helpers/member-harness.ts'

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

describe('recovery notifications retain unread work within the whole-output budget', () => {
  it('does not let an omitted notice attest after the original full Message leaves the surface', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const first = await ctx.agentTeam.postMainMessage({ requestId: requestId('first'), workspaceId, projectRef, body: '@builder first full check' })
    if (first.kind !== 'committed') throw new Error('first post failed')
    adapter.enqueue(textResponse('Noted first check.'))
    await agent.whenIdle()
    const original = agent.session.surface.nodes.slice(1)
    adapter.enqueue(textResponse('Noted second check.'))
    await ctx.agentTeam.postMainMessage({ requestId: requestId('second'), workspaceId, projectRef, body: '@builder second full check' })
    await waitFor(() => adapter.requests.length === 2 ? true : undefined)
    await agent.whenIdle()
    const notice = agent.session.deriveMessages().filter(message => message.role === 'user'
      && message.source.kind === '@wowyuarm/dsh-agent-team' && message.source['form'] === 'notice').at(-1)!
      .content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    expect(notice).not.toContain('first full check')
    expect(notice).toContain(first.message.messageRef)
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Earlier context removed.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(original[0]!), endSeq: SessionSeq(original.at(-1)!) }, sourceEventSeqs: [...original],
    })
    const attempted = await ctx.agentTeam.postMainMessageForAgent(agent, { requestId: requestId('attempt'), workspaceId, projectRef,
      body: 'Checks complete.' })
    expect(attempted.kind).toBe('main_unread_required')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 2, directCount: 2 })
  })

  it.each([70, 491, 570])('restores direct facts after compaction within the whole budget (%i body repeats)', async repeats => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work on the package.' }], source: { kind: 'user' } }))
    await adapter.started.promise
    for (let index = 0; index < 24; index += 1) {
      const result = await ctx.agentTeam.postMainMessage({ requestId: requestId(`post-${index}`), workspaceId, projectRef,
        body: `@builder Check ${index}: ${'signed package '.repeat(repeats)} END-${index}` })
      if (result.kind !== 'committed') throw new Error('setup post failed')
    }
    adapter.release.resolve()
    await agent.whenIdle()
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 24, directCount: 24 })
    if (repeats === 491) {
      const ordinaryNotice = agent.session.deriveMessages().filter(message => message.role === 'user'
        && message.source.kind === '@wowyuarm/dsh-agent-team' && message.source['form'] === 'notice').at(-1)!
        .content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
      expect(ordinaryNotice).toContain('END-20')
    }
    const nodes = agent.session.surface.nodes.slice(1)
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary: package verification remains.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(nodes[0]!), endSeq: SessionSeq(nodes.at(-1)!) }, sourceEventSeqs: [...nodes],
    })
    const before = adapter.requests.length
    adapter.enqueue(textResponse('I will check the pending packages.'))
    await ctx.agentTeam.recoverMember({ requestId: requestId('recover'), workspaceId, memberId: added.status.member.memberId })
    await waitFor(() => adapter.requests.length > before ? true : undefined)
    await agent.whenIdle()
    const recovery = agent.session.deriveMessages().filter(message => message.role === 'user'
      && message.source.kind === '@wowyuarm/dsh-agent-team' && message.source['form'] === 'notice').at(-1)!
      .content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    expect(recovery).toContain('The operator asked you to resume')
    expect(recovery.length).toBeLessThanOrEqual(32 * 1024)
    expect(recovery).toContain('@builder Check 23:')
    if (repeats < 570) expect(recovery).toContain('END-23')
    else expect(recovery).toContain('Message body truncated')
    if (repeats === 491) {
      // Four such bodies fit the ordinary notice's content allotment, but the
      // recovery instruction takes enough space that only three fit here.
      expect(recovery).toContain('END-21')
      expect(recovery).not.toContain('END-20')
    }
    expect(recovery).toMatch(/direct.*not expanded/i)
    expect(recovery).toContain('team_inbox')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 24, directCount: 24 })
  })
})
