import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { TEAM_INBOX_NOTICE_SUMMARY } from '../src/context-projection.ts'
import { cleanups, GatedAdapter, realHarness, ScriptedAdapter, textResponse, requestId, waitFor, waitForIdle } from './helpers/member-harness.ts'

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

/** The last Inbox notice the Member's Session actually carries. */
function latestNotice(agent: Agent): string {
  return agent.session.deriveMessages().filter(message => message.role === 'user'
    && message.source.kind === AGENT_TEAM_PLUGIN_ID && message.source.form === 'notice'
    && message.source.summary === TEAM_INBOX_NOTICE_SUMMARY).at(-1)!
    .content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
}

describe('Inbox notices present direct signals before ordinary work', () => {
  it('does not repeat a direct Message already on the Session surface and leaves both unread', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!

    adapter.enqueue(textResponse('Noted the first direct Message.'))
    const started = await ctx.agentTeam.startThread({ requestId: requestId('first-direct'), workspaceId,
      projectRef, kind: 'discussion', body: '@builder first direct body' })
    if (started.kind !== 'committed') throw new Error('first direct Message failed')
    await waitFor(() => adapter.requests.length === 1 ? true : undefined)
    await waitForIdle(ctx, agent)
    expect(latestNotice(agent)).toContain('first direct body')

    adapter.enqueue(textResponse('Noted the second direct Message.'))
    const replied = await ctx.agentTeam.reply({ requestId: requestId('second-direct'), workspaceId,
      threadRef: started.thread.threadRef, body: '@builder second direct body', baseRevision: started.thread.revision })
    if (replied.kind !== 'committed') throw new Error('second direct Message failed')
    await waitFor(() => adapter.requests.length === 2 ? true : undefined)
    await waitForIdle(ctx, agent)

    const notice = latestNotice(agent)
    expect(notice).toContain('second direct body')
    expect(notice).toContain('already in current context; still unread')
    expect(notice).toContain(started.message.messageRef)
    expect(notice).not.toContain('first direct body')
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items
      .find(item => item.thread.threadRef === started.thread.threadRef)).toMatchObject({ unreadCount: 2, directCount: 2 })
  })

  it('puts the newest missing Main direct before a Thread identity and its ordinary count', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!

    // One Thread direct is delivered first, then ordinary updates accumulate
    // behind it. The later Main direct is the only missing direct signal.
    const started = await ctx.agentTeam.startThread({ requestId: requestId('anchor'), workspaceId,
      projectRef, kind: 'discussion', body: 'Anchor the ordering check.' })
    if (started.kind !== 'committed') throw new Error('anchor failed')
    const threadRef = started.thread.threadRef
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('follow'), workspaceId, threadRef, action: 'follow' })
    adapter.enqueue(textResponse('Noted the Thread direct.'))
    const direct = await ctx.agentTeam.reply({ requestId: requestId('thread-direct'), workspaceId,
      threadRef, body: '@builder first direct in thread', baseRevision: started.thread.revision })
    if (direct.kind !== 'committed') throw new Error('Thread direct failed')
    await waitFor(() => adapter.requests.length === 1 ? true : undefined)
    await waitForIdle(ctx, agent)

    let revision = direct.thread.revision
    for (let index = 1; index <= 2; index += 1) {
      adapter.enqueue(textResponse(`Noted ordinary update ${index}.`))
      const ordinary = await ctx.agentTeam.reply({ requestId: requestId(`ordinary-${index}`), workspaceId,
        threadRef, body: `Ordinary update ${index}`, baseRevision: revision })
      if (ordinary.kind !== 'committed') throw new Error('ordinary update failed')
      revision = ordinary.thread.revision
      await waitFor(() => adapter.requests.length === index + 1 ? true : undefined)
      await waitForIdle(ctx, agent)
    }

    adapter.enqueue(textResponse('Noted the Main direct.'))
    const main = await ctx.agentTeam.postMainMessage({ requestId: requestId('main-direct'), workspaceId,
      projectRef, body: '@builder main newest direct' })
    if (main.kind !== 'committed') throw new Error('Main direct failed')
    await waitFor(() => adapter.requests.length === 4 ? true : undefined)
    await waitForIdle(ctx, agent)

    const notice = latestNotice(agent)
    expect(notice.length).toBeLessThanOrEqual(32 * 1024)
    expect(notice).toContain('main newest direct')
    expect(notice).toContain('already in current context; still unread')
    expect(notice).toContain('2 unread updates')
    expect(notice).not.toContain('first direct in thread')
    expect(notice.indexOf('Direct Main stream mention')).toBeGreaterThanOrEqual(0)
    expect(notice.indexOf('Direct Main stream mention')).toBeLessThan(notice.indexOf('already in current context'))
    expect(notice.indexOf('Direct Main stream mention')).toBeLessThan(notice.indexOf('Scope: Thread'))
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items
      .find(item => item.thread.threadRef === threadRef)).toMatchObject({ unreadCount: 3, directCount: 1 })
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 1, directCount: 1 })
  })

  it('selects the eight Thread scopes after ranking missing direct facts', async () => {
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
    for (let index = 0; index < 9; index += 1) {
      const thread = await ctx.agentTeam.startThread({ requestId: requestId(`start-${index}`), workspaceId, projectRef,
        kind: 'discussion', body: `@builder ${index === 8 ? 'NEWEST-DIRECT' : `Older check ${index}`}` })
      if (thread.kind !== 'committed') throw new Error('start failed')
      if (index < 8) await ctx.agentTeam.reply({ requestId: requestId(`more-${index}`), workspaceId,
        threadRef: thread.thread.threadRef, body: '@builder extra older check', baseRevision: thread.thread.revision })
    }
    adapter.enqueue(textResponse('Reviewing the latest checks.'))
    adapter.release.resolve()
    await agent.whenIdle()
    const notice = latestNotice(agent)
    expect(notice).toContain('NEWEST-DIRECT')
    expect(notice.match(/Scope: Thread/g)?.length).toBeLessThanOrEqual(8)
    expect(notice).toMatch(/direct.*not expanded/i)
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toMatchObject({ totalUnreadCount: 17, totalDirectCount: 17 })
  })

  it('keeps the direct omission warning when many scope routes would exceed the footer', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Work on the package.' }], source: { kind: 'user' } }))
    await adapter.started.promise
    for (let index = 0; index < 100; index += 1) {
      const result = await ctx.agentTeam.startThread({ requestId: requestId(`start-${index}`), workspaceId,
        projectRef: project.project.projectRef, kind: 'task', body: `@builder ${'x'.repeat(7000)} END-${index}` })
      if (result.kind !== 'committed') throw new Error('start failed')
    }
    adapter.enqueue(textResponse('Reviewing pending requests.'))
    adapter.release.resolve()
    await agent.whenIdle()
    const notice = latestNotice(agent)
    expect(notice.length).toBeLessThanOrEqual(32 * 1024)
    expect(notice).toMatch(/direct.*not expanded/i)
    expect(notice).toContain('team_inbox')
    expect(notice).toContain('team_thread read')
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toMatchObject({ totalUnreadCount: 100, totalDirectCount: 100 })
  })

  it('bounds the whole notice by characters before the 20-fact cap', async () => {
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

    // Seven direct Main Messages, but the five old bodies each exceed 7.5K, so
    // the character budget stops before the 20-fact cap can.
    for (let index = 0; index < 5; index += 1) {
      const result = await ctx.agentTeam.postMainMessage({ requestId: requestId(`long-${index}`), workspaceId, projectRef,
        body: `@builder ${'signed package '.repeat(500)}\nLONG-${index}-END` })
      if (result.kind !== 'committed') throw new Error('long Main direct failed')
    }
    for (let index = 5; index <= 6; index += 1) {
      const result = await ctx.agentTeam.postMainMessage({ requestId: requestId(`short-${index}`), workspaceId, projectRef,
        body: `@builder SHORT-${index}-END` })
      if (result.kind !== 'committed') throw new Error('short Main direct failed')
    }
    adapter.release.resolve()
    await agent.whenIdle()

    const notice = latestNotice(agent)
    expect(notice.length).toBeLessThanOrEqual(32 * 1024)
    expect(notice).toContain('SHORT-6-END')
    expect(notice).toMatch(/direct.*not expanded/i)
    expect(notice).not.toContain('LONG-0-END')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing)
      .toMatchObject({ unreadCount: 7, directCount: 7 })
  })
})
