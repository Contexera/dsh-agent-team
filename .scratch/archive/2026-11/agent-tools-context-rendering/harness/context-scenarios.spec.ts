import { afterEach, expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { cleanups, realHarness, requestId, ScriptedAdapter, textResponse, toolCallResponse, waitFor } from '../../../../../packages/agent-team/tests/helpers/member-harness.ts'

afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

it('exports real Session checkpoints for direct reply, acknowledgment, compaction and continuation', async () => {
  const adapter = new ScriptedAdapter()
  const { ctx, workspaceId } = await realHarness(adapter)
  const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId,
    name: 'Synthetic release checks', description: 'Isolated context acceptance scenario' })
  const projectRef = project.project.projectRef
  const member = await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId,
    handle: 'builder', description: 'Checks signed packages', presetId: 'team-member', projectRefs: [projectRef] })
  const agent = ctx.agents.get(member.status.member.sessionId)!
  const snapshots: unknown[] = []
  function checkpoint(stage: string) {
    snapshots.push({ stage, sessionId: agent.session.id, header: agent.session.header,
      events: agent.session.snapshotEvents(), requests: adapter.requests.map(request => ({ messages: request.messages, tools: request.tools })) })
  }
  async function call(name: string, args: object) {
    const before = adapter.requests.length
    adapter.enqueue(toolCallResponse(`call-${before}`, name, args))
    adapter.enqueue(textResponse('Checks recorded.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the package checks.' }], source: { kind: 'user' } }))
    await waitFor(() => adapter.requests.length === before + 2 ? true : undefined)
    await agent.whenIdle()
    const result = agent.session.deriveMessages().filter(message => message.role === 'tool').at(-1)!
    expect(result.isError).not.toBe(true)
    return result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
  }
  function standing() { return ctx.agentTeam.mainStreamHistoryForAgent(agent, { workspaceId, projectRef }).standing }
  adapter.enqueue(textResponse('The direct request is available.'))
  const direct = await ctx.agentTeam.postMainMessage({ requestId: requestId('direct'), workspaceId, projectRef,
    body: '@builder Verify the signed package in a path containing spaces.' })
  if (direct.kind !== 'committed') throw new Error('Direct setup failed')
  await waitFor(() => adapter.requests.length === 1 ? true : undefined)
  await agent.whenIdle()
  checkpoint('F3-direct-notice')
  expect(await call('team_message', { action: 'post', projectRef, body: 'The signed package passed the path-with-spaces check.', replyToMessageRef: direct.message.messageRef }))
    .toContain('Committed — Main stream message posted.')
  expect(standing()).toMatchObject({ unreadCount: 1, directCount: 1 })
  checkpoint('F3-reply-without-read')
  const read = await call('team_thread', { action: 'read', projectRef })
  expect(read).toContain('acknowledged 1 unread update(s)')
  expect(read).not.toContain(direct.message.body)
  expect(standing().unreadCount).toBe(0)
  checkpoint('F3-explicit-read')

  const operationCount = ctx.agentTeam.status().operationCount
  const nodes = agent.session.surface.nodes.slice(1)
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Summary: continue package verification.' }], source: { kind: 'user' } }), {
    surfaceOp: { op: 'replace', startSeq: SessionSeq(nodes[0]!), endSeq: SessionSeq(nodes.at(-1)!) }, sourceEventSeqs: [...nodes],
  })
  checkpoint('F5-compacted')
  expect(await call('team_thread', { action: 'read', projectRef })).toContain(direct.message.body)
  expect(ctx.agentTeam.status().operationCount).toBe(operationCount)
  checkpoint('F5-background-restored')
  expect(await call('team_thread', { action: 'read', projectRef })).not.toContain(direct.message.body)
  expect(ctx.agentTeam.status().operationCount).toBe(operationCount)
  checkpoint('F5-background-not-repeated')

  await ctx.agentTeam.readMainStream({ requestId: requestId('human-read'), workspaceId, projectRef })
  const body = '@builder ' + '安装路径🙂保留空格。'.repeat(5200) + '完整检查结束。'
  adapter.enqueue(textResponse('A long check arrived.'))
  const before = adapter.requests.length
  const long = await ctx.agentTeam.postMainMessage({ requestId: requestId('long'), workspaceId, projectRef, body })
  if (long.kind !== 'committed') throw new Error('Long setup failed')
  await waitFor(() => adapter.requests.length === before + 1 ? true : undefined)
  await agent.whenIdle()
  checkpoint('F6-truncated-notice')
  const pieces: string[] = []
  for (let index = 0; index < 5; index += 1) {
    const text = await call('team_thread', { action: 'message', projectRef, messageRef: long.message.messageRef })
    expect(text.length).toBeLessThanOrEqual(32768)
    pieces.push(...[...text.matchAll(/<message-part[^>]*>\n([\s\S]*?)\n<\/message-part>/g)].map(match => match[1]!))
    expect(standing()).toMatchObject({ unreadCount: 1, directCount: 1 })
    checkpoint(`F6-message-part-${index + 1}`)
    if (text.includes('complete in current context')) break
  }
  expect(pieces.join('')).toBe(body)
  const acknowledged = await call('team_thread', { action: 'read', projectRef })
  expect(acknowledged).toContain('acknowledged 1 unread update(s)')
  expect(acknowledged).not.toContain('安装路径')
  expect(standing().unreadCount).toBe(0)
  checkpoint('F6-explicit-read')
  const output = resolve('.scratch/local/agent-context-implementation/context-snapshots.json')
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, JSON.stringify({ format: 'team-context-snapshots-v1', snapshots }, null, 2))
})
