import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { TEAM_INBOX_NOTICE_SUMMARY } from '../src/context-projection.ts'
import { agentTeamHostActor, agentTeamHumanActor } from '../src/ledger.ts'
import { snapshotScript } from '../src/subscriptions.ts'
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

  it('puts the newest missing Main direct before a Thread identity and its ordinary digest', async () => {
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

describe('subscription lifecycle notices', () => {
  it('describes an automatic pause as a subscription failure, never as an ownership removal', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [projectRef] })
    const memberId = added.status.member.memberId
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const ledger = ctx.agentTeam['ledger']!
    await ledger.addProjectOwner({ requestId: requestId('owner'), actor: agentTeamHumanActor(), workspaceId, projectRef, memberId })
    await ledger.readMainStream({ requestId: requestId('read-owner'), actor: { kind: 'member', memberId, handle: 'builder' }, workspaceId, projectRef })
    const snapshot = snapshotScript('printf \'{"id":"a","title":"A"}\\n\'\n', 'bash')
    if (!snapshot.ok) throw new Error('the fixture script must be valid')
    const created = await ledger.createSubscription({ requestId: requestId('create'), actor: agentTeamHumanActor(), workspaceId,
      projectRef, name: 'main CI', triggers: { interval: { minutes: 10 } }, script: snapshot.script, credentials: [], baselineIds: [] })
    if (!created.committed) throw new Error('expected a committed subscription')
    const subscriptionRef = created.value.subscription.subscriptionRef
    const paused = await ledger.pauseSubscription({ requestId: requestId('pause'), actor: agentTeamHostActor(), workspaceId,
      projectRef, subscriptionRef, expectedRevision: 1, reason: 'failures' })
    if (!paused.committed) throw new Error('expected a committed automatic pause')

    const main = ledger.mainNotificationFacts(memberId)
    const notice = ctx.agentTeam['notificationText'](agent, [], memberId, main).text
    expect(notice).toContain('Team subscription paused')
    expect(notice).toContain('main CI')
    expect(notice).toContain(subscriptionRef)
    expect(notice).toContain('after repeated failures')
    expect(notice).toContain('team_subscription logs')
    expect(notice).not.toContain('Team Project ownership changed')
    expect(notice).not.toContain('removed you as an owner')
  })
})

describe('ordinary unread digests', () => {
  it('shows the latest three Main Messages and summarizes only the earlier overflow', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [projectRef] })
    const memberId = added.status.member.memberId
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const ledger = ctx.agentTeam['ledger']!
    const actor = { kind: 'member', memberId, handle: 'builder' } as const
    await ledger.changeAttention({ requestId: requestId('follow'), actor, workspaceId, projectRef, action: 'follow' })
    for (let index = 0; index < 5; index += 1) {
      await ledger.postMainMessage({ requestId: requestId(`post-${index}`), actor: agentTeamHumanActor(), workspaceId,
        projectRef, body: index === 4 ? `ordinary-update-4 ${'x'.repeat(300)} LONG-END` : `ordinary-update-${index}` })
    }

    const notice = ctx.agentTeam['notificationText'](agent, [], memberId, ledger.mainNotificationFacts(memberId)).text
    expect(notice).toContain('Main stream: 5 unread updates')
    expect(notice).toContain('ordinary-update-2')
    expect(notice).toContain('ordinary-update-3')
    expect(notice).toContain('ordinary-update-4')
    expect(notice).toContain('…')
    expect(notice).not.toContain('LONG-END')
    expect(notice).not.toContain('- human: ordinary-update-0')
    expect(notice).not.toContain('- human: ordinary-update-1')
    expect(notice).toContain('2 earlier ordinary updates not expanded; read for the full facts.')
  })

  it('renders an ordinary subscription event once as untrusted data, without expanding and counting it twice', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [projectRef] })
    const memberId = added.status.member.memberId
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const ledger = ctx.agentTeam['ledger']!
    const actor = { kind: 'member', memberId, handle: 'builder' } as const
    await ledger.changeAttention({ requestId: requestId('follow'), actor, workspaceId, projectRef, action: 'follow' })
    const snapshot = snapshotScript('printf \'{"id":"a","title":"A"}\\n\'\n', 'bash')
    if (!snapshot.ok) throw new Error('the fixture script must be valid')
    const created = await ledger.createSubscription({ requestId: requestId('create'), actor: agentTeamHumanActor(), workspaceId,
      projectRef, name: 'main CI', triggers: { interval: { minutes: 10 } }, script: snapshot.script, credentials: [], baselineIds: [] })
    if (!created.committed) throw new Error('expected a committed subscription')
    const subscriptionRef = created.value.subscription.subscriptionRef
    await ledger.readMainStream({ requestId: requestId('read-create'), actor, workspaceId, projectRef })
    await ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: agentTeamHostActor(), workspaceId,
      projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: snapshot.script.sha256,
      events: [{ id: 'run-1', title: 'CI failed', detail: 'Inspect the failing test' }] })
    const pending = ledger.pendingSubscriptionEvents(subscriptionRef)
    await ledger.publishSubscriptionEvent({ requestId: requestId('publish'), actor: agentTeamHostActor(), workspaceId,
      projectRef, subscriptionRef, acceptedSequence: pending[0]!.acceptedSequence, eventId: 'run-1' })

    const notice = ctx.agentTeam['notificationText'](agent, [], memberId, ledger.mainNotificationFacts(memberId)).text
    expect(notice).toContain('Main stream: 1 unread update')
    expect(notice.match(/CI failed/g)).toHaveLength(1)
    expect(notice).toContain('untrusted external data')
    expect(notice).not.toContain('Project subscription event —')
    expect(notice).not.toContain('Inspect the failing test')
  })

  it('digests an ordinary Task Activity without presenting it as a complete direct event', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
      name: 'Packaging', description: 'Release verification' })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
      handle: 'builder', description: 'Checks releases', presetId: 'team-member', projectRefs: [projectRef] })
    const memberId = added.status.member.memberId
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const worker = await ctx.agentTeam.addMember({ requestId: requestId('worker'), workspaceId,
      handle: 'worker', description: 'Claims work', presetId: 'team-member', projectRefs: [projectRef] })
    const ledger = ctx.agentTeam['ledger']!
    const actor = { kind: 'member', memberId, handle: 'builder' } as const
    const started = await ledger.startThread({ requestId: requestId('task'), actor: agentTeamHumanActor(), workspaceId,
      projectRef, kind: 'task', body: 'Check the release' })
    if (started.value.kind !== 'committed' || started.value.task === undefined) throw new Error('expected a Task')
    const threadRef = started.value.thread.threadRef
    const taskRef = started.value.task.taskRef
    await ledger.changeAttention({ requestId: requestId('follow'), actor, workspaceId, threadRef, action: 'follow' })
    await ledger.changeClaim({ requestId: requestId('claim'), actor: { kind: 'member', memberId: worker.status.member.memberId, handle: 'worker' },
      workspaceId, taskRef, baseRevision: started.value.thread.revision, action: 'claim', direction: 'Check the package' })

    const notifications = ledger.notificationFacts(memberId)
    const notice = ctx.agentTeam['notificationText'](agent, notifications, memberId)
    expect(notice.text).toContain(`Task ${taskRef}: 1 unread update`)
    expect(notice.text).toContain(`worker claim Task ${taskRef}`)
    expect(notice.text).not.toContain('Team Task update')
    expect(notice.activities).toEqual([])
  })
})
