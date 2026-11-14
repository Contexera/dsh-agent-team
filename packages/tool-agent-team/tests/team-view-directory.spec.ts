import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { EmptyAdapter, realHarness, requestId } from '../../agent-team/tests/helpers/member-harness.ts'
import { teamTools } from './render-text.ts'

interface ViewResult {
  projects: { projectRef: string; role: string; subscriptions: { active: number; paused: number } }[]
  threads: { subject: string }[]
  tasks: { projectRef: string }[]
  members: { memberId: string }[]
  directoryOnly: boolean
}

async function execute<T = Record<string, unknown>>(tool: ToolDefinition, agent: unknown, args: Record<string, unknown>): Promise<T> {
  return await tool.execute(args, { agent, callId: `call:${crypto.randomUUID()}`, signal: new AbortController().signal } as never) as T
}

function rendered(tool: ToolDefinition, args: Record<string, unknown>, value: unknown): string {
  return tool.output.render(args, value as never).map(block => block.type === 'text' ? block.text : '').join('\n')
}

describe('team_view Workspace directory', () => {
  it('shows every Project without widening Project content, Task board access, or Thread reads', async () => {
    const test = await realHarness(new EmptyAdapter())
    const tools = teamTools()
    const viewTool = tools.get('team_view')!
    const first = await test.ctx.agentTeam.createProject({ requestId: requestId('directory-first'), workspaceId: test.workspaceId,
      name: 'first', description: '', memberIds: [] })
    const second = await test.ctx.agentTeam.createProject({ requestId: requestId('directory-second'), workspaceId: test.workspaceId,
      name: 'second', description: '', memberIds: [] })
    const firstRef = first.project.projectRef
    const secondRef = second.project.projectRef
    const owner = await test.ctx.agentTeam.addMember({ requestId: requestId('directory-owner'), workspaceId: test.workspaceId,
      handle: 'owner', description: '', presetId: 'team-member', projectRefs: [firstRef], model: { provider: 'mock', model: 'mock' }})
    const outsider = await test.ctx.agentTeam.addMember({ requestId: requestId('directory-outsider'), workspaceId: test.workspaceId,
      handle: 'outsider', description: '', presetId: 'team-member', projectRefs: [], model: { provider: 'mock', model: 'mock' }})
    const ownerAgent = test.ctx.agents.get(owner.status.member.sessionId)!
    const outsiderAgent = test.ctx.agents.get(outsider.status.member.sessionId)!
    await test.ctx.agentTeam.addProjectOwner({ requestId: requestId('directory-owner-grant'), workspaceId: test.workspaceId,
      projectRef: firstRef, memberId: owner.status.member.memberId })
    await test.ctx.agentTeam.startThread({ requestId: requestId('directory-first-task'), workspaceId: test.workspaceId,
      projectRef: firstRef, kind: 'task', body: 'first task' })
    const otherTask = await test.ctx.agentTeam.startThread({ requestId: requestId('directory-second-task'), workspaceId: test.workspaceId,
      projectRef: secondRef, kind: 'task', body: 'second task' })

    const outsideView = await execute<ViewResult>(viewTool, outsiderAgent, {})
    expect(outsideView.projects.map(project => [project.projectRef, project.role, project.subscriptions])).toEqual([
      [firstRef, 'directory only', { active: 0, paused: 0 }],
      [secondRef, 'directory only', { active: 0, paused: 0 }],
    ])
    expect(outsideView.threads).toEqual([])
    expect(outsideView.tasks).toEqual([])
    expect(outsideView.members.map(member => member.memberId)).toEqual(expect.arrayContaining([
      owner.status.member.memberId, outsider.status.member.memberId,
    ]))

    const ownerView = await execute<ViewResult>(viewTool, ownerAgent, {})
    expect(ownerView.projects.map(project => [project.projectRef, project.role])).toEqual([
      [firstRef, 'owner'], [secondRef, 'directory only'],
    ])
    expect(ownerView.threads.map(thread => thread.subject)).toEqual(['first task'])
    expect(ownerView.tasks.map(task => task.projectRef)).toEqual([firstRef])

    const filtered = await execute<ViewResult>(viewTool, outsiderAgent, { projectRef: secondRef })
    expect(filtered.directoryOnly).toBe(true)
    expect(filtered.projects.map(project => project.projectRef)).toEqual([secondRef])
    expect(filtered.threads).toEqual([])
    const text = rendered(viewTool, { projectRef: secondRef }, filtered)
    expect(text).toContain('Projects — Workspace directory')
    expect(text).toContain('Directory only: Thread rows require Project membership.')
    expect(text).not.toContain('No top-level Threads')

    await expect(execute(tools.get('team_task')!, outsiderAgent, { action: 'board', projectRef: secondRef })).rejects.toThrow(/not authorized/)
    await expect(execute(tools.get('team_thread')!, outsiderAgent, {
      action: 'history', threadRef: otherTask.thread.threadRef,
    })).rejects.toThrow(/not_project_member/)
  })
})
