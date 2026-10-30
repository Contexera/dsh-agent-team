import { afterEach, describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AgentTeamProjectRef } from '@contexera/dsh-agent-team/types'
import { cleanups, realHarness, requestId } from '../../agent-team/tests/helpers/member-harness.ts'
import { teamTools } from './render-text.ts'

/**
 * Execution-level addressing tests over the real Host and live Member
 * Sessions. The Host is seeded through its public API; the tool definitions
 * are the source under test. No Host result or refusal is mocked.
 */

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

type Harness = Awaited<ReturnType<typeof realHarness>>
type Member = { readonly agent: NonNullable<ReturnType<Harness['ctx']['agents']['get']>> }

async function addMember(ctx: Harness['ctx'], workspaceId: Harness['workspaceId'], handle: string, projectRef: AgentTeamProjectRef): Promise<Member> {
  const added = await ctx.agentTeam.addMember({ requestId: requestId(`add-${handle}`), workspaceId, handle, description: '', presetId: 'team-member', projectRefs: [projectRef] })
  const agent = ctx.agents.get(added.status.member.sessionId)
  if (agent === undefined) throw new Error(`Member ${handle} did not get a live Agent`)
  return { agent }
}

async function boot() {
  const { ctx, workspaceId } = await realHarness()
  const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId, name: 'alpha', description: '', memberIds: [] })
  const projectRef = project.project.projectRef
  const peer = await addMember(ctx, workspaceId, 'peer', projectRef)
  const other = await addMember(ctx, workspaceId, 'other', projectRef)
  const first = await ctx.agentTeam.startThread({ requestId: requestId('first-task'), workspaceId, projectRef, kind: 'task', body: 'First task' })
  const second = await ctx.agentTeam.startThread({ requestId: requestId('second-task'), workspaceId, projectRef, kind: 'task', body: 'Second task' })
  if (first.task === undefined || second.task === undefined) throw new Error('the seeded Threads did not carry Tasks')
  return { ctx, workspaceId, projectRef, peer, other, first, second,
    firstTask: first.task.taskRef, secondTask: second.task.taskRef, firstThread: first.thread.threadRef }
}

function call(name: string, args: Record<string, unknown>, agent: Member['agent']): Promise<unknown> {
  const tool: ToolDefinition | undefined = teamTools().get(name)
  if (tool === undefined) throw new Error(`tool ${name} is not registered`)
  return tool.execute(args, { agent, callId: `call:${crypto.randomUUID()}`, signal: new AbortController().signal } as never)
}

describe('Thread and Main addressing over the real Host', () => {
  it('accepts the same Thread through both refs and rejects refs from different Threads', async () => {
    const team = await boot()

    const status = await call('team_attention', { action: 'status', threadRef: team.firstThread, taskRef: team.firstTask }, team.peer.agent)
    expect(status).toMatchObject({ threadRef: team.firstThread })

    const read = await call('team_thread', { action: 'read', threadRef: team.firstThread, taskRef: team.firstTask }, team.peer.agent)
    expect(read).toMatchObject({ threadRef: team.firstThread })

    await expect(call('team_attention', { action: 'status', threadRef: team.firstThread, taskRef: team.secondTask }, team.peer.agent))
      .rejects.toThrow(/does not belong/)
    await expect(call('team_thread', { action: 'read', threadRef: team.firstThread, taskRef: team.secondTask }, team.peer.agent))
      .rejects.toThrow(/does not belong/)
  })

  it('reads Messages through matching Thread refs or the Main stream Project ref', async () => {
    const team = await boot()

    const threadMessage = await call('team_thread', { action: 'message', threadRef: team.firstThread, taskRef: team.firstTask, messageRef: team.first.message.messageRef }, team.peer.agent)
    expect(threadMessage).toMatchObject({ kind: 'message', message: { messageRef: team.first.message.messageRef } })
    await expect(call('team_thread', { action: 'message', threadRef: team.firstThread, taskRef: team.secondTask, messageRef: team.first.message.messageRef }, team.peer.agent))
      .rejects.toThrow(/does not belong/)
    await expect(call('team_thread', { action: 'message', taskRef: team.firstTask, messageRef: team.first.message.messageRef }, team.peer.agent))
      .rejects.toThrow(/message needs threadRef/)

    const posted = await team.ctx.agentTeam.postMainMessage({ requestId: requestId('main-post'), workspaceId: team.workspaceId, projectRef: team.projectRef, body: 'Main hello' })
    if (posted.kind !== 'committed') throw new Error(`Main stream post was refused: ${posted.kind}`)
    const mainMessage = await call('team_thread', { action: 'message', projectRef: team.projectRef, messageRef: posted.message.messageRef }, team.peer.agent)
    expect(mainMessage).toMatchObject({ kind: 'message', message: { messageRef: posted.message.messageRef, body: 'Main hello' } })
  })

  it('refuses unfollow only for the caller\'s own active Claim', async () => {
    const team = await boot()
    const peerRead = await team.ctx.agentTeam.readThreadForAgent(team.peer.agent, { requestId: requestId('peer-read'), workspaceId: team.workspaceId, threadRef: team.firstThread })
    const claimed = await team.ctx.agentTeam.changeClaimForAgent(team.peer.agent, { requestId: requestId('peer-claim'), workspaceId: team.workspaceId,
      taskRef: team.firstTask, action: 'claim', direction: 'peer owns the first task', baseRevision: peerRead.thread.revision })
    expect(claimed.kind).toBe('committed')
    await team.ctx.agentTeam.changeAttentionForAgent(team.other.agent, { requestId: requestId('other-follow'), workspaceId: team.workspaceId, threadRef: team.firstThread, action: 'follow' })

    await expect(call('team_attention', { action: 'unfollow', threadRef: team.firstThread }, team.peer.agent))
      .rejects.toThrow(/active Claim.*finish the work or release the Claim first/)
    expect(team.ctx.agentTeam.attentionStatusForAgent(team.peer.agent, { workspaceId: team.workspaceId, threadRef: team.firstThread }).attention).toBeDefined()

    const other = await call('team_attention', { action: 'unfollow', threadRef: team.firstThread }, team.other.agent)
    expect(other).toMatchObject({ following: false, threadRef: team.firstThread })
    expect(team.ctx.agentTeam.attentionStatusForAgent(team.other.agent, { workspaceId: team.workspaceId, threadRef: team.firstThread }).attention).toBeUndefined()

    await call('team_attention', { action: 'follow', projectRef: team.projectRef }, team.peer.agent)
    const main = await call('team_attention', { action: 'unfollow', projectRef: team.projectRef }, team.peer.agent)
    expect(main).toMatchObject({ following: false, projectRef: team.projectRef })
  })
})
