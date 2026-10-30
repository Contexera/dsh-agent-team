import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { visibleTeamSurface } from '../src/surface-visibility.ts'
import { cleanups, realHarness, ScriptedAdapter, textResponse, toolCallResponse, requestId, waitFor } from './helpers/member-harness.ts'

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function mainStream() {
  const adapter = new ScriptedAdapter()
  const test = await realHarness(adapter)
  const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: test.workspaceId,
    name: 'Install checks', description: 'Verify the signed installer' })
  const projectRef = project.project.projectRef
  const member = await test.ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: test.workspaceId,
    handle: 'builder', description: 'Checks installation', presetId: 'team-member', projectRefs: [projectRef] })
  const agent = test.ctx.agents.get(member.status.member.sessionId)!
  await test.ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('follow'), workspaceId: test.workspaceId, projectRef, action: 'follow' })
  async function post(body: string) {
    await test.ctx.agentTeam.readMainStream({ requestId: requestId(`human-read-${adapter.requests.length}`), workspaceId: test.workspaceId, projectRef })
    const before = adapter.requests.length
    adapter.enqueue(textResponse('Noted.'))
    const result = await test.ctx.agentTeam.postMainMessage({ requestId: requestId(`post-${before}`), workspaceId: test.workspaceId, projectRef, body })
    if (result.kind !== 'committed') throw new Error('setup post failed')
    await waitFor(() => adapter.requests.length > before ? true : undefined)
    await agent.whenIdle()
    return result.message
  }
  async function call(action: 'read' | 'history' | 'message' | 'post', messageRef?: string) {
    const before = adapter.requests.length
    adapter.enqueue(toolCallResponse(`call-${before}`, action === 'post' ? 'team_message' : 'team_thread', { action, projectRef,
      ...(action === 'post' ? { body: 'I will verify the signed installer in a path with spaces.' } : {}),
      ...(messageRef === undefined ? {} : { messageRef }) }))
    adapter.enqueue(textResponse('Context checked.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check the Project Main stream.' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length === before + 2 ? true : undefined)
    await agent.whenIdle()
    const last = agent.session.deriveMessages().filter(message => message.role === 'tool').at(-1)!
    return last.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
  }
  return { ...test, adapter, agent, projectRef, post, call }
}

describe('Main read uses the current Session context', () => {
  it('reconsiders a complete Main rejection but stops for a new missing Message', async () => {
    const { ctx, agent, workspaceId, projectRef, post, call } = await mainStream()
    await post('Ordinary change not included in the automatic notice.')
    const rejected = await call('post')
    expect(rejected).toContain('Not committed — main_unread_required')
    expect(rejected).toContain('Reconsider')
    expect(rejected).not.toContain('baseRevision')
    expect(await call('post')).toContain('Committed — Main stream message posted.')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(1)
    await post('A new ordinary update needs another review.')
    expect(await call('post')).toContain('Not committed — main_unread_required')
    const read = await call('read')
    expect(read).toContain('acknowledged 2 unread update(s)')
  })

  it('posts after a complete ownership notice without marking the Activity read', async () => {
    const { ctx, adapter, agent, workspaceId, projectRef, call } = await mainStream()
    const memberId = ctx.agentTeam.members().find(item => item.member.sessionId === agent.id)!.member.memberId
    adapter.enqueue(textResponse('Noted the ownership change.'))
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('grant-owner'), workspaceId, projectRef, memberId })
    await waitFor(() => adapter.requests.length === 1 ? true : undefined)
    await agent.whenIdle()
    expect(await call('post')).toContain('Committed — Main stream message posted.')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(1)
  })

  it.each(['history', 'post'] as const)('recovers an ownership Activity through %s, then acknowledges without reattesting omitted content', async action => {
    const { ctx, adapter, agent, workspaceId, projectRef, call } = await mainStream()
    const memberId = ctx.agentTeam.members().find(item => item.member.sessionId === agent.id)!.member.memberId
    adapter.enqueue(textResponse('Noted ownership.'))
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('grant'), workspaceId, projectRef, memberId })
    await waitFor(() => adapter.requests.length === 1 ? true : undefined)
    await agent.whenIdle()
    const nodes = agent.session.surface.nodes.slice(1)
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary: review the Project.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(nodes[0]!), endSeq: SessionSeq(nodes.at(-1)!) }, sourceEventSeqs: [...nodes],
    })
    const context = await call(action)
    expect(context).toContain(`owner-added Member ${memberId}`)
    expect(context).toContain(projectRef)
    expect(context).toContain('activity:')
    if (action === 'post') expect(context).toContain('Not committed — main_unread_required')
    expect(await call('post')).toContain('Committed — Main stream message posted.')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(1)
    const completeNodes = [...agent.session.surface.nodes].slice(1)
    const read = await call('read')
    expect(read).toContain('acknowledged 1 unread update(s)')
    expect(read).toContain('complete event already in current context; omitted')
    expect(read).not.toContain('owner-added Member')
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Earlier context removed.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(completeNodes[0]!), endSeq: SessionSeq(completeNodes.at(-1)!) }, sourceEventSeqs: completeNodes,
    })
    expect(visibleTeamSurface(agent).flatMap(surface => surface.activities)).toHaveLength(0)
  })

  it('bounds a long Main rejection and keeps the Message unread until explicitly read', async () => {
    const { ctx, agent, workspaceId, projectRef, post, call } = await mainStream()
    await post('Very long pending Main content. '.repeat(2000))
    const result = await call('post')
    expect(result.length).toBeLessThanOrEqual(16 * 1024)
    expect(result).toContain('truncated')
    expect(await call('post')).toContain('Not committed — main_unread_required')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(1)
  })

  it('posts after a complete direct notice without acknowledging it, then reads to confirm', async () => {
    const { ctx, agent, workspaceId, projectRef, post, call } = await mainStream()
    const direct = await post('@builder verify the signed installer in a path with spaces.')
    expect(await call('post')).toContain('Committed — Main stream message posted.')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing).toMatchObject({ unreadCount: 1, directCount: 1 })
    const read = await call('read')
    expect(read).toContain('acknowledged 1 unread update(s)')
    expect(read).not.toContain(direct.body)
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(0)
  })

  it('stops without acknowledging when a Message exceeds the available context capacity', async () => {
    const { ctx, adapter, agent, workspaceId, projectRef, post, call } = await mainStream()
    adapter.resolveModelWindow = () => 32_000
    const long = await post('模型容量不足🙂'.repeat(12000))
    const result = await call('read')
    expect(result).toContain('Message exceeds the reading capacity')
    expect(result).toContain(long.messageRef)
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(1)
  })

  it('continues Main Messages in order and leaves a queried long Message unread until read', async () => {
    const { ctx, agent, workspaceId, projectRef, post, call } = await mainStream()
    const long = await post('主线消息🙂不能提前确认。'.repeat(4200) + '全文结束。')
    const first = await call('message', long.messageRef)
    expect(first.length).toBeLessThanOrEqual(32 * 1024)
    expect(first).toContain('Message part')
    const second = await call('message', long.messageRef)
    expect(second).toContain('全文结束。')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(1)
    const acknowledged = await call('read')
    expect(acknowledged).toContain('acknowledged 1 unread update(s)')
    expect(acknowledged).not.toContain('主线消息')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(0)
    const next = await post('第二条长消息🙂'.repeat(6500) + '第二条结束。')
    const later = await post('This update stays behind the incomplete Message.')
    const page = await call('read')
    expect(page.length).toBeLessThanOrEqual(32 * 1024)
    expect(page).toContain('not acknowledged')
    expect(page).not.toContain(later.body)
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(2)
    for (let index = 0; index < 5 && ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount > 0; index += 1) {
      expect((await call('read')).length).toBeLessThanOrEqual(32 * 1024)
    }
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(0)
    expect(next.body).toContain('第二条结束。')
  })

  it('restores missing recent Messages after compaction without repeating them on the next read', async () => {
    const { ctx, agent, post, call } = await mainStream()
    const message = await post('Release checks need the signed package and a Windows path with spaces.')
    await call('read')
    const operationCount = ctx.agentTeam.status().operationCount
    const nodes = agent.session.surface.nodes.slice(1)
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary: continue release checks.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(nodes[0]!), endSeq: SessionSeq(nodes.at(-1)!) }, sourceEventSeqs: [...nodes],
    })
    const restored = await call('read')
    expect(restored).toContain('Background — not newly acknowledged')
    expect(restored).toContain(message.body)
    expect(ctx.agentTeam.status().operationCount).toBe(operationCount)
    const repeated = await call('read')
    expect(repeated).not.toContain(message.body)
    expect(repeated).not.toContain('Background — not newly acknowledged')
    expect(repeated).not.toContain('Main stream is empty')
    expect(ctx.agentTeam.status().operationCount).toBe(operationCount)
  })

  it('does not skip an unread Message hidden behind more than a page of Task cards', async () => {
    const { ctx, agent, workspaceId, projectRef, post, call } = await mainStream()
    const unread = await post('Unread original before task cards. '.repeat(2000))
    for (let index = 0; index < 25; index += 1) await ctx.agentTeam.startThread({ requestId: requestId(`card-${index}`),
      workspaceId, projectRef, kind: 'task', body: `Task ${index}` })
    const result = await call('read')
    expect(result).toContain(unread.messageRef)
    expect(result).toContain('not acknowledged')
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(1)
  })

  it('acknowledges a complete direct notice without repeating its body', async () => {
    const { post, call } = await mainStream()
    const direct = await post('@builder verify the signed installer before approving release.')
    const result = await call('read')
    expect(result).toContain('acknowledged 1 unread update(s)')
    expect(result).not.toContain(direct.body)
    expect(result).toContain(direct.messageRef)
    expect(result).toContain('body already in current context; omitted')
  })

  it('acknowledges a queried Message without repeating its body and supplies the next Message', async () => {
    const { ctx, agent, workspaceId, projectRef, post, call } = await mainStream()
    const first = await post('Verify the Windows installer in a path containing spaces.')
    expect(await call('message', first.messageRef)).toContain(first.body)
    const second = await post('The signed package is ready for that verification.')
    const read = await call('read')
    expect(read).toContain('acknowledged 2 unread update(s)')
    expect(read).not.toContain(first.body)
    expect(read).toContain(first.messageRef)
    expect(read).toContain('body already in current context; omitted')
    expect(read).toContain(second.body)
    expect(ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing.unreadCount).toBe(0)
  })

  it('keeps an already-read Thread card once a newer entry arrives', async () => {
    const { ctx, agent, workspaceId, projectRef } = await mainStream()
    // The discussion's Main entry is a Thread card: current state, not unread work.
    await ctx.agentTeam.startThread({ requestId: requestId('discussion'), workspaceId, projectRef, kind: 'discussion', body: 'Fix the importer' })
    await ctx.agentTeam.readMainStreamForAgent(agent, { requestId: requestId('first'), workspaceId, projectRef })
    await ctx.agentTeam.postMainMessage({ requestId: requestId('post'), workspaceId, projectRef, body: 'Status check on the importer.' })
    // The second read answers the new Message; the card it already acknowledged
    // stays visible, because a card is the Thread's current state.
    const read = await ctx.agentTeam.readMainStreamForAgent(agent, { requestId: requestId('second'), workspaceId, projectRef })
    const cards = read.entries.filter(entry => entry.kind === 'thread-card')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ unread: false, card: expect.objectContaining({ anchor: expect.objectContaining({ preview: 'Fix the importer' }) }) })
    expect(read.entries.filter(entry => entry.unread)).toHaveLength(1)
  })
})
