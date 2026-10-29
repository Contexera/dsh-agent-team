import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanups, realHarness, ScriptedAdapter, textResponse, toolCallResponse, requestId, waitFor } from './helpers/member-harness.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
vi.setConfig({ testTimeout: 60_000 })

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

/** One real Member and a Thread they follow, with one ordinary Human reply waiting unread. */
async function waitingThread(body: string) {
  const adapter = new ScriptedAdapter()
  const test = await realHarness(adapter)
  const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: test.workspaceId,
    name: 'engineering', description: 'Engineering work' })
  const member = await test.ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: test.workspaceId,
    handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
  const agent = test.ctx.agents.get(member.status.member.sessionId)!
  const started = await test.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('thread'),
    workspaceId: test.workspaceId, projectRef: project.project.projectRef, body: 'Release plan' })
  if (started.kind !== 'committed') throw new Error('setup failed')
  await test.ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('follow'),
    workspaceId: test.workspaceId, threadRef: started.thread.threadRef, action: 'follow' })
  adapter.enqueue(textResponse('Noted the unread update.'))
  const update = await test.ctx.agentTeam.reply({ requestId: requestId('update'), workspaceId: test.workspaceId,
    threadRef: started.thread.threadRef, body, baseRevision: started.thread.revision })
  if (update.kind !== 'committed') throw new Error('setup failed')
  await waitFor(() => adapter.requests.length === 1 ? true : undefined)
  await agent.whenIdle()
  return { ...test, adapter, agent, threadRef: started.thread.threadRef,
    oldRevision: started.thread.revision, currentRevision: update.thread.revision }
}

function toolResultTexts(agent: Agent): string[] {
  return agent.session.deriveMessages().filter(message => message.role === 'tool').map(message =>
    message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
}

describe('a complete rejection lets the writer reconsider without re-reading', () => {
  it('shows the whole change and current token, then commits the modified reply without a read', async () => {
    const change = 'Windows install failed — hold the release until it is reproduced.'
    const { ctx, adapter, agent, threadRef, oldRevision, currentRevision } = await waitingThread(change)

    adapter.enqueue(toolCallResponse('old-token', 'team_message', { action: 'reply', threadRef, body: 'Publish it', baseRevision: oldRevision }))
    adapter.enqueue(toolCallResponse('new-token', 'team_message', { action: 'reply', threadRef,
      body: 'Paused the release; reproducing the Windows install failure.', baseRevision: currentRevision }))
    adapter.enqueue(textResponse('Paused and investigating.'))

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reconsider the release plan.' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length === 4 ? true : undefined)
    await agent.whenIdle()

    const results = toolResultTexts(agent)
    expect(results).toHaveLength(2)
    // 1. The old token is refused, but nothing is hidden: the complete change
    // and the current revision arrive in the same tool result.
    expect(results[0]).toContain('Not committed — unread_required.')
    expect(results[0]).toContain(change)
    expect(results[0]).toContain(`Next write — baseRevision: ${currentRevision}`)
    // 2. The next model step sees that result as ordinary context.
    expect(JSON.stringify(adapter.requests[2]!.messages)).toContain(change)
    expect(JSON.stringify(adapter.requests[2]!.messages)).toContain('Next write — baseRevision')
    // 3. The modified reply commits even though the change was never read and
    // remains unread: the exemption is the surface, not a durable read.
    expect(results[1]).toContain('Committed — reply added.')
    expect(results[1]).not.toContain('unread_required')

    const unread = ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)
    expect(unread?.unreadCount).toBe(1)
    expect(unread?.attention?.readThroughSequence).toBeLessThan(unread!.newestSequence)
  })
})

describe('each write checks the current facts and revision again', () => {
  it('refuses a new unread change even when the earlier rejection is still visible', async () => {
    const { ctx, workspaceId, adapter, agent, threadRef, oldRevision, currentRevision } = await waitingThread('First failure')
    adapter.enqueue(toolCallResponse('first-attempt', 'team_message', { action: 'reply', threadRef, body: 'Publish', baseRevision: oldRevision }))
    adapter.enqueue(textResponse('Reconsidering.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review the release.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(toolResultTexts(agent)[0]).toContain(`Next write — baseRevision: ${currentRevision}`)
    const before = ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)!.attention

    adapter.enqueue(toolCallResponse('second-attempt', 'team_message', { action: 'reply', threadRef, body: 'Addressed first failure', baseRevision: currentRevision }))
    adapter.enqueue(textResponse('The second failure also needs attention.'))
    await ctx.agentTeam.reply({ requestId: requestId('second-update'), workspaceId, threadRef, body: 'Second failure', baseRevision: currentRevision })
    await waitFor(() => adapter.requests.length >= 5 ? true : undefined)
    await agent.whenIdle()
    const results = toolResultTexts(agent)
    expect(results).toHaveLength(2)
    expect(results[1]).toContain('Not committed — unread_required.')
    expect(results[1]).toContain('Second failure')
    const after = ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)!
    expect(after.unreadCount).toBe(2)
    expect(after.attention).toEqual(before)
  })

  it.each(['history', 'message'] as const)('%s supplies full context without confirming read; a stale token still rejects', async action => {
    const { ctx, workspaceId, adapter, agent, threadRef, oldRevision, currentRevision } = await waitingThread('Hold the release')
    const history = ctx.agentTeam.threadHistoryForAgent(agent, { workspaceId, threadRef })
    const message = history.facts.find(fact => fact.kind === 'message' && fact.message.body === 'Hold the release')
    if (message?.kind !== 'message') throw new Error('missing fixture reply')
    adapter.enqueue(toolCallResponse('context', 'team_thread', { action, threadRef,
      ...(action === 'message' ? { messageRef: message.message.messageRef } : {}) }))
    adapter.enqueue(toolCallResponse('stale', 'team_message', { action: 'reply', threadRef, body: 'Paused', baseRevision: oldRevision }))
    adapter.enqueue(toolCallResponse('current', 'team_message', { action: 'reply', threadRef, body: 'Paused and investigating', baseRevision: currentRevision }))
    adapter.enqueue(textResponse('Done.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review the release.' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length === 5 ? true : undefined)
    await agent.whenIdle()
    const results = toolResultTexts(agent)
    expect(results[0]).toContain('Hold the release')
    expect(results[1]).toContain('stale_revision')
    expect(results[1]).not.toContain('unread_required')
    expect(results[1]).toContain(`Next write — baseRevision: ${currentRevision}`)
    expect(results[2]).toContain('Committed — reply added.')
    expect(ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)?.unreadCount).toBe(1)
  })
})

describe('an incomplete rejection never implies a direct write', () => {
  it('bounds an oversized change and keeps the next write refused until the Thread is read', async () => {
    const change = 'Windows install failed. '.repeat(500)
    const { ctx, adapter, agent, threadRef, oldRevision, currentRevision } = await waitingThread(change)

    adapter.enqueue(toolCallResponse('old-token', 'team_message', { action: 'reply', threadRef, body: 'Publish it', baseRevision: oldRevision }))
    adapter.enqueue(toolCallResponse('current-token', 'team_message', { action: 'reply', threadRef,
      body: 'Publish after the failure', baseRevision: currentRevision }))
    adapter.enqueue(toolCallResponse('read-required', 'team_thread', { action: 'read', threadRef }))
    adapter.enqueue(toolCallResponse('after-read', 'team_message', { action: 'reply', threadRef,
      body: 'Paused until the complete failure is addressed.', baseRevision: currentRevision }))
    adapter.enqueue(textResponse('Read and paused.'))

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Reconsider the release plan.' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length === 6 ? true : undefined)
    await agent.whenIdle()

    const results = toolResultTexts(agent)
    expect(results[0]).toContain('Not committed — unread_required.')
    expect(results[0]).toContain('1 of 1 pending fact(s) included; some content is truncated or omitted:')
    expect(results[0]).toContain('the full change is not shown')
    expect(results[0]).not.toContain('Next write — baseRevision')
    expect(results[0]).toContain('No write token is provided')
    // The current token alone does not pass: the body is still not fully on the
    // surface, so the gate refuses again.
    expect(results[1]).toContain('Not committed — unread_required.')
    expect(results[2]).toContain(change.trim())
    expect(results[3]).toContain('Committed — reply added.')

    const unread = ctx.agentTeam.inboxForAgent(agent, {}).items.find(item => item.thread.threadRef === threadRef)
    expect(unread).toBeUndefined()
  })
})
