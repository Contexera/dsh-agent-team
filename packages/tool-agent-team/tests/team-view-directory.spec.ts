import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { EmptyAdapter, realHarness, requestId } from '../../agent-team/tests/helpers/member-harness.ts'
import { teamTools } from './render-text.ts'

interface ViewResult {
  projects: { projectRef: string; role: string; subscriptions: { active: number; paused: number }
    ownerResponsibilities?: { handle: string; responsibility: string }[] }[]
  threads: { subject: string }[]
  tasks: { projectRef: string }[]
  members: { memberId: string }[]
}

async function execute<T = Record<string, unknown>>(tool: ToolDefinition, agent: unknown, args: Record<string, unknown>): Promise<T> {
  return await tool.execute(args, { agent, callId: `call:${crypto.randomUUID()}`, signal: new AbortController().signal } as never) as T
}

function rendered(tool: ToolDefinition, args: Record<string, unknown>, value: unknown): string {
  return tool.output.render(args, value as never).map(block => block.type === 'text' ? block.text : '').join('\n')
}

describe('team_view Workspace directory', () => {
  it('shows every Project and Thread to each Workspace participant, with own and follow as the only relations', async () => {
    const test = await realHarness(new EmptyAdapter())
    const tools = teamTools()
    const viewTool = tools.get('team_view')!
    const first = await test.ctx.agentTeam.createProject({ requestId: requestId('directory-first'), workspaceId: test.workspaceId,
      name: 'first', description: '' })
    const second = await test.ctx.agentTeam.createProject({ requestId: requestId('directory-second'), workspaceId: test.workspaceId,
      name: 'second', description: '' })
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
      [firstRef, 'none', { active: 0, paused: 0 }],
      [secondRef, 'none', { active: 0, paused: 0 }],
    ])
    expect(outsideView.threads.map(thread => thread.subject)).toEqual(['first task', 'second task'])
    expect(outsideView.tasks.map(task => task.projectRef)).toEqual([firstRef, secondRef])
    expect(outsideView.members.map(member => member.memberId)).toEqual(expect.arrayContaining([
      owner.status.member.memberId, outsider.status.member.memberId,
    ]))

    const ownerView = await execute<ViewResult>(viewTool, ownerAgent, {})
    expect(ownerView.projects.map(project => [project.projectRef, project.role])).toEqual([
      [firstRef, 'owner'], [secondRef, 'none'],
    ])
    expect(ownerView.threads.map(thread => thread.subject)).toEqual(['first task', 'second task'])
    expect(ownerView.tasks.map(task => task.projectRef)).toEqual([firstRef, secondRef])

    const filtered = await execute<ViewResult>(viewTool, outsiderAgent, { projectRef: secondRef })
    expect(filtered.projects.map(project => project.projectRef)).toEqual([secondRef])
    expect(filtered.threads.map(thread => thread.subject)).toEqual(['second task'])
    const text = rendered(viewTool, { projectRef: secondRef }, filtered)
    expect(text).toContain('Projects — Workspace directory')
    expect(text).not.toContain('Directory only')
    expect(text).not.toContain('No top-level Threads')

    await execute(tools.get('team_task')!, outsiderAgent, { action: 'board', projectRef: secondRef })
    await execute(tools.get('team_thread')!, outsiderAgent, {
      action: 'history', threadRef: otherTask.thread.threadRef,
    })
  })

  it('states what owners answer for only once somebody recorded it, and never guesses a value', async () => {
    const test = await realHarness(new EmptyAdapter())
    const viewTool = teamTools().get('team_view')!
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('responsibility-project'), workspaceId: test.workspaceId,
      name: 'releases', description: '' })
    const projectRef = project.project.projectRef
    const first = await test.ctx.agentTeam.addMember({ requestId: requestId('responsibility-first'), workspaceId: test.workspaceId,
      handle: 'first', description: '', presetId: 'team-member', projectRefs: [projectRef], model: { provider: 'mock', model: 'mock' }})
    const second = await test.ctx.agentTeam.addMember({ requestId: requestId('responsibility-second'), workspaceId: test.workspaceId,
      handle: 'second', description: '', presetId: 'team-member', projectRefs: [projectRef], model: { provider: 'mock', model: 'mock' }})
    const firstAgent = test.ctx.agents.get(first.status.member.sessionId)!
    await test.ctx.agentTeam.addProjectOwner({ requestId: requestId('responsibility-grant-first'), workspaceId: test.workspaceId,
      projectRef, memberId: first.status.member.memberId })
    await test.ctx.agentTeam.addProjectOwner({ requestId: requestId('responsibility-grant-second'), workspaceId: test.workspaceId,
      projectRef, memberId: second.status.member.memberId })

    // Nobody recorded text, so the row says nothing: the field is absent, not `[]`
    // and not a row of `unspecified` that would read as a recorded answer.
    const silent = await execute<ViewResult>(viewTool, firstAgent, {})
    expect(silent.projects[0]!.ownerResponsibilities).toBeUndefined()
    expect(rendered(viewTool, {}, silent)).not.toContain('responsibility')

    await test.ctx.agentTeam.updateProjectOwner({ requestId: requestId('responsibility-set'), workspaceId: test.workspaceId,
      projectRef, memberId: first.status.member.memberId, responsibility: 'owns the release checklist' })
    const recorded = await execute<ViewResult>(viewTool, firstAgent, {})
    // Owner rows are ordered by Member id, which the Host mints, so the pair is
    // asserted by content rather than by a position this test cannot control.
    expect(recorded.projects[0]!.ownerResponsibilities).toEqual(expect.arrayContaining([
      { handle: 'first', responsibility: 'owns the release checklist' },
      { handle: 'second', responsibility: 'unspecified' },
    ]))
    const line = rendered(viewTool, {}, recorded)
    expect(line).toContain('· responsibility ')
    expect(line).toContain('@first: owns the release checklist')
    expect(line).toContain('@second: unspecified')

    // Clearing the only recorded text returns the row to "nobody recorded it":
    // the update stores `''` while the projection drops the field, so this is the
    // one place where the presence rule and that normalization have to agree.
    await test.ctx.agentTeam.updateProjectOwner({ requestId: requestId('responsibility-clear'), workspaceId: test.workspaceId,
      projectRef, memberId: first.status.member.memberId, responsibility: '' })
    const cleared = await execute<ViewResult>(viewTool, firstAgent, {})
    expect(cleared.projects[0]!.ownerResponsibilities).toBeUndefined()
    expect(rendered(viewTool, {}, cleared)).not.toContain('responsibility')
  })
})
