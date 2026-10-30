import { afterEach, describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { isFactOnSurface, visibleTeamSurface } from '../src/surface-visibility.ts'
import { cleanups, realHarness, ScriptedAdapter, textResponse, toolCallResponse, requestId, waitFor } from './helpers/member-harness.ts'

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

async function discussion(kind: 'discussion' | 'task' = 'discussion') {
  const adapter = new ScriptedAdapter()
  const test = await realHarness(adapter)
  const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: test.workspaceId,
    name: 'Install checks', description: 'Reproduce an installation failure' })
  const member = await test.ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: test.workspaceId,
    handle: 'builder', description: 'Checks installation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
  const agent = test.ctx.agents.get(member.status.member.sessionId)!
  const started = await test.ctx.agentTeam.startThread({ kind, requestId: requestId('thread'),
    workspaceId: test.workspaceId, projectRef: project.project.projectRef,
    body: 'Windows installation investigation. '.repeat(4) + 'Keep paths containing spaces in the reproduction.' })
  if (started.kind !== 'committed') throw new Error('setup failed')
  await test.ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('follow'),
    workspaceId: test.workspaceId, threadRef: started.thread.threadRef, action: 'follow' })
  let revision = started.thread.revision
  async function reply(body: string) {
    const before = adapter.requests.length
    adapter.enqueue(textResponse('Noted.'))
    const result = await test.ctx.agentTeam.reply({ requestId: requestId(`reply-${before}`), workspaceId: test.workspaceId,
      threadRef: started.thread.threadRef, body, baseRevision: revision })
    if (result.kind !== 'committed') throw new Error('setup reply failed')
    revision = result.thread.revision
    await waitFor(() => adapter.requests.length > before ? true : undefined)
    await agent.whenIdle()
    return result
  }
  async function read(action: 'read' | 'message' = 'read', messageRef?: string) {
    const before = adapter.requests.length
    adapter.enqueue(toolCallResponse(`read-${before}`, 'team_thread', { action, threadRef: started.thread.threadRef, ...(messageRef === undefined ? {} : { messageRef }) }))
    adapter.enqueue(textResponse('Context checked.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check this discussion.' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length === before + 2 ? true : undefined)
    await agent.whenIdle()
    const last = agent.session.deriveMessages().filter(message => message.role === 'tool').at(-1)!
    return last.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
  }
  return { ...test, adapter, agent, threadRef: started.thread.threadRef, taskRef: started.task?.taskRef, anchor: started.message, reply, read }
}

describe('Thread read uses the current Session context', () => {
  it('recovers a missing middle part after compaction and confirms only when all parts are visible', async () => {
    const { ctx, agent, threadRef, reply, read } = await discussion()
    const message = await reply('多段正文🙂需要全部仍在上下文。'.repeat(7000) + '正文结束。')
    const parts: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const part = await read('message', message.message.messageRef)
      parts.push(part)
      if (part.includes('complete in current context')) break
    }
    expect(parts.length).toBeGreaterThanOrEqual(3)
    expect(parts.at(-1)).toContain('complete in current context')
    expect(ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)?.unreadCount).toBe(1)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    const middle = results[1]!
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'A middle part was summarized.' }], source: { kind: 'user' } }), {
      surfaceOp: { op: 'replace', startSeq: middle.seq, endSeq: middle.seq }, sourceEventSeqs: [middle.seq],
    })
    const recovery = [await read()]
    if (ctx.agentTeam.inboxForAgent(agent, {}).items.some(item => item.thread.threadRef === threadRef)) recovery.push(await read())
    expect(recovery.at(-1)).toContain('acknowledged 1 unread update(s)')
    const missingBody = /<message-part[^>]*>\n([\s\S]*?)\n<\/message-part>/.exec(parts[1]!)![1]!
    const recoveredBody = recovery.flatMap(text => [...text.matchAll(/<message-part[^>]*>\n([\s\S]*?)\n<\/message-part>/g)].map(match => match[1]!)).join('')
    expect(recoveredBody).toBe(missingBody)
    expect(ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)).toBeUndefined()
  })

  it('continues a long Message without acknowledging it or a later Message before all parts are supplied', async () => {
    const { ctx, agent, threadRef, reply, read } = await discussion()
    const long = '安装路径🙂保留空格。'.repeat(5000) + '最后一段必须保留。'
    await reply(long)
    const later = await reply('A later update must not pass the incomplete Message.')
    const first = await read()
    expect(first.length).toBeLessThanOrEqual(32 * 1024)
    expect(first).toContain('Message part')
    expect(first).toContain('not acknowledged')
    expect(first).not.toContain(later.message.body)
    expect(ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)?.unreadCount).toBe(2)
    const parts = [first]
    for (let index = 0; index < 8 && ctx.agentTeam.inboxForAgent(agent, {}).items.some(item => item.thread.threadRef === threadRef); index += 1) parts.push(await read())
    expect(parts.every(part => part.length <= 32 * 1024)).toBe(true)
    expect(parts.some(part => part.includes('最后一段必须保留。'))).toBe(true)
    expect(parts.some(part => part.includes(later.message.body))).toBe(true)
    expect(ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)).toBeUndefined()
    const bodyParts = parts.flatMap(text => [...text.matchAll(/<message-part[^>]*>\n([\s\S]*?)\n<\/message-part>/g)].map(match => match[1]!))
    expect(bodyParts.join('')).toBe(long)
  })

  it('provides the Task and discussion before the Member checks the board and claims a direction', async () => {
    const { ctx, workspaceId, adapter, agent, threadRef, taskRef, anchor, read } = await discussion('task')
    const projectRef = anchor.projectRef
    const peer = await ctx.agentTeam.addMember({ requestId: requestId('peer'), workspaceId,
      handle: 'packager', description: 'Builds the signed package', presetId: 'team-member', projectRefs: [projectRef] })
    const peerAgent = ctx.agents.get(peer.status.member.sessionId)!
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('pause-follow'), workspaceId, threadRef, action: 'unfollow' })
    const peerRead = await ctx.agentTeam.readThreadForAgent(peerAgent, { requestId: requestId('peer-read'), workspaceId, threadRef })
    const peerClaim = await ctx.agentTeam.changeClaimForAgent(peerAgent, { requestId: requestId('peer-claim'), workspaceId,
      taskRef: taskRef!, action: 'claim', direction: 'Build the signed release package', baseRevision: peerRead.thread.revision })
    if (peerClaim.kind !== 'committed') throw new Error('peer Claim failed')
    await ctx.agentTeam.suspendMember({ requestId: requestId('pause-peer'), memberId: peer.status.member.memberId })
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('resume-follow'), workspaceId, threadRef, action: 'follow' })
    await ctx.agentTeam.readThread({ requestId: requestId('human-read-claim'), workspaceId, threadRef })
    adapter.enqueue(textResponse('Checking current work.'))
    const update = await ctx.agentTeam.reply({ requestId: requestId('package-check'), workspaceId, threadRef,
      body: 'Verify installation from the signed package, not the source checkout.', baseRevision: peerClaim.thread.revision })
    if (update.kind !== 'committed') throw new Error('ordinary update failed')
    await waitFor(() => adapter.requests.length > 0 ? true : undefined)
    await agent.whenIdle()
    const context = await read()
    expect(context).toContain(anchor.body)
    expect(context).toContain(taskRef)
    expect(context).toContain('Verify installation from the signed package')
    expect(context).toContain('Build the signed release package')
    expect(context).toContain(peerClaim.claim.claimRef)
    const token = Number(/Next write — baseRevision: (\d+)/.exec(context)?.[1])
    const before = adapter.requests.length
    adapter.enqueue(toolCallResponse('inspect-board', 'team_task', { action: 'board' }))
    adapter.enqueue(toolCallResponse('claim-install', 'team_task', { action: 'claim', taskRef,
      direction: 'Reproduce Windows installation from the signed package', baseRevision: token }))
    adapter.enqueue(textResponse('Claimed installation verification.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Check current work and take the installation check.' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length === before + 3 ? true : undefined)
    await agent.whenIdle()
    const results = agent.session.deriveMessages().filter(message => message.role === 'tool')
      .map(message => message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
    expect(results.at(-1)).toContain('Claim created')
    expect(ctx.agentTeam.threadHistoryForAgent(agent, { workspaceId, threadRef }).claims)
      .toEqual(expect.arrayContaining([expect.objectContaining({ direction: 'Reproduce Windows installation from the signed package', state: 'active' })]))
  })

  it('budgets long background once without turning it into a new acknowledgement', async () => {
    const { ctx, workspaceId, agent, threadRef, reply, read } = await discussion()
    const message = await reply('Background body with Unicode🙂. '.repeat(2400))
    await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('already-read'), workspaceId, threadRef })
    const operations = ctx.agentTeam.status().operationCount
    const parts: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const text = await read()
      expect(text.length).toBeLessThanOrEqual(32 * 1024)
      expect(text).not.toContain('Read committed')
      parts.push(...[...text.matchAll(/<message-part[^>]*>\n([\s\S]*?)\n<\/message-part>/g)].map(match => match[1]!))
      if (text.includes('complete in current context')) break
    }
    expect(parts.join('')).toBe(message.message.body)
    expect(ctx.agentTeam.status().operationCount).toBe(operations)
  })

  it('restores recent discussion after compaction with no unread, then avoids repeating that background', async () => {
    const { ctx, agent, anchor, reply, read } = await discussion()
    const update = 'A new package fixes paths with spaces; retest the signed installer.'
    await reply(update)
    await read()
    const operationCount = ctx.agentTeam.status().operationCount
    const nodes = agent.session.surface.nodes.slice(1)
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Summary: continue checking installation.' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: SessionSeq(nodes[0]!), endSeq: SessionSeq(nodes.at(-1)!) }, sourceEventSeqs: [...nodes] })
    const restored = await read()
    expect(restored).toContain('Read — no unread updates')
    expect(restored).toContain('Background — not newly acknowledged')
    expect(restored).toContain(anchor.body)
    expect(restored).toContain(update)
    expect(ctx.agentTeam.status().operationCount).toBe(operationCount)
    const repeated = await read()
    expect(repeated).not.toContain(anchor.body)
    expect(repeated).not.toContain(update)
    expect(repeated).not.toContain('Background — not newly acknowledged')
    expect(ctx.agentTeam.status().operationCount).toBe(operationCount)
  })

  it('acknowledges a visible direct Message without repeating it, and supplies a new ordinary Message', async () => {
    const { ctx, workspaceId, agent, threadRef, reply, read } = await discussion()
    const direct = '@builder reproduce the installer in a path with spaces before shipping.'
    const ordinary = 'The rebuilt package is ready for the next check.'
    const message = await reply(direct)
    await reply(ordinary)
    expect(ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)?.unreadCount).toBe(2)
    const text = await read()
    expect(text).toContain('acknowledged 2 unread update(s)')
    expect(text).not.toContain(direct)
    expect(text).toContain(message.message.messageRef)
    expect(text).toContain('body already in current context; omitted')
    expect(text).toContain(ordinary)
    expect(ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)).toBeUndefined()
    const fact = ctx.agentTeam.threadHistoryForAgent(agent, { workspaceId, threadRef }).facts
      .find(item => item.kind === 'message' && item.message.messageRef === message.message.messageRef)!
    expect(isFactOnSurface(visibleTeamSurface(agent), { fact, unread: false, direct: false }, threadRef)).toBe(true)
    // Retain the read result but remove the original notice: omission is not another copy of the body.
    const readResult = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)!
    const beforeRead = agent.session.surface.nodes.slice(1).filter(seq => seq < readResult.seq)
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Older discussion summarized.' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: SessionSeq(beforeRead[0]!), endSeq: SessionSeq(beforeRead.at(-1)!) }, sourceEventSeqs: [...beforeRead] })
    expect(isFactOnSurface(visibleTeamSurface(agent), { fact, unread: false, direct: false }, threadRef)).toBe(false)
  })
})
