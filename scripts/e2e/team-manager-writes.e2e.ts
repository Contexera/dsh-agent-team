import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  MANAGER_WRITES_SHOTS, closeScenario, openSidebar, openTeamPage, scaffold, settleAnimations, settleLayout,
} from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

/**
 * Staffing a Project through the manager, in the shipped composition.
 *
 * The manager's write tools are the only way the model can create a Member,
 * record a Project's shared goal, grant or reword ownership, edit or archive a
 * Project, adjust a Member, or move it through its lifecycle, so this lane
 * drives them through the real executor —
 * the same pipeline, guards, ledger queue, activation and receipt the Web
 * Client's own forms ride — rather than calling a Host method directly. The workspace id is random per run, so it is
 * read from the Host directory instead of being written into a fixture; the
 * model-facing renders and the durable records are what this asserts.
 */
it('staffs a Project through the manager write tools in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true })
  const ordinaryId = await page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
  expect(ordinaryId).toBeDefined()

  await page.getByRole('button', { name: '团队', exact: true }).click()
  await page.locator('button[data-team-action="manager"]').click()
  await expect.poll(async () => (await page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId))?.startsWith('agent-team-manager-') ?? false,
    { timeout: 30_000 }).toBe(true)
  const managerId = (await page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId))!
  await page.locator(`[data-conversation-session="${managerId}"]`).waitFor({ timeout: 20_000 })
  const manager = scaffold!.ctx.agents.get(managerId as SessionId)
  expect(manager).toBeDefined()

  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const route = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

  /** One tool call through the live executor, as the model's own batch would be. */
  const call = async (name: string, callId: string, args: Record<string, unknown>) => {
    const batch = await scaffold!.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(callId), name, arguments: JSON.stringify(args) }],
      agent: manager, signal: new AbortController().signal,
    })
    expect(batch.results).toHaveLength(1)
    expect(batch.results[0]!.callId).toBe(callId)
    return batch.results[0]!.result
  }

  // 1. The Member: committed, activated, and carried by the ordinary Client projection.
  const member = await call('member_create', 'manager-write-member', {
    workspaceId, handle: 'Iris', description: '长期负责评审与验收', model: route, requestId: 'manager-write-member-1',
  })
  expect(member.isError).toBe(false)
  if (member.isError) return
  const memberValue = member.value as { memberRef: string; receipt: { operationId: string }; status: { availability: string; presence: string } }
  expect(memberValue.memberRef.startsWith('member:')).toBe(true)
  expect(memberValue.status).toMatchObject({ availability: 'active', presence: 'available' })
  expect(JSON.stringify(member.content)).toContain('Member created')
  const memberRows = scaffold!.ctx.agentTeam.members({ workspaceId }).map(entry => entry.member)
  expect(memberRows.filter(row => row.handle === 'Iris')).toHaveLength(1)
  expect(memberRows.find(row => row.handle === 'Iris')!.memberId).toBe(memberValue.memberRef)

  // 2. The Project: the shared goal, with the Member it was staffed for.
  const project = await call('project_create', 'manager-write-project', {
    workspaceId, name: 'Parser', description: '把解析收敛到一个权威实现', memberIds: [memberValue.memberRef],
    requestId: 'manager-write-project-1',
  })
  expect(project.isError).toBe(false)
  if (project.isError) return
  const projectValue = project.value as { projectRef: string; memberIds: string[] }
  expect(projectValue.memberIds).toEqual([memberValue.memberRef])
  expect(JSON.stringify(project.content)).toContain('Project created')

  // 3. The grant: what this owner answers for there, distinct from both descriptions.
  const responsibility = '对解析器的根因诊断与评审结论负责'
  const owner = await call('project_owner', 'manager-write-owner', {
    action: 'add', workspaceId, projectRef: projectValue.projectRef, memberRef: memberValue.memberRef,
    responsibility, requestId: 'manager-write-owner-1',
  })
  expect(owner.isError).toBe(false)
  if (owner.isError) return
  expect((owner.value as { responsibility: string }).responsibility).toBe(responsibility)
  expect(JSON.stringify(owner.content)).toContain('Owner granted')
  const projected = scaffold!.ctx.agentTeam.view({ workspaceId })
  const projectRow = projected.projects.find(entry => entry.projectRef === projectValue.projectRef)
  expect(projectRow).toMatchObject({ name: 'Parser', description: '把解析收敛到一个权威实现', state: 'active' })
  expect(projected.owners).toEqual([{ projectRef: projectValue.projectRef, memberId: memberValue.memberRef, responsibility }])
  expect(projected.members).toEqual([{ projectRef: projectValue.projectRef, memberId: memberValue.memberRef }])

  // 3b. The responsibility is the owner relation's own field: an update replaces
  // it in place, and the Member's global description is untouched.
  const rewordedResponsibility = '对解析器的交付节奏与评审结论负责'
  const reworded = await call('project_owner', 'manager-write-owner-update', {
    action: 'update', workspaceId, projectRef: projectValue.projectRef, memberRef: memberValue.memberRef,
    responsibility: rewordedResponsibility, requestId: 'manager-write-owner-update-1',
  })
  expect(reworded.isError).toBe(false)
  if (reworded.isError) return
  expect(JSON.stringify(reworded.content)).toContain('Responsibility updated')
  expect(scaffold!.ctx.agentTeam.view({ workspaceId }).owners)
    .toEqual([{ projectRef: projectValue.projectRef, memberId: memberValue.memberRef, responsibility: rewordedResponsibility }])
  expect(scaffold!.ctx.agentTeam.members({ workspaceId })
    .find(entry => entry.member.memberId === memberValue.memberRef)!.member.description).toBe('长期负责评审与验收')

  // 3c. A partial Project edit: the name changes, and the goal it never named
  // stays as the Human wrote it.
  const renamed = await call('project_update', 'manager-write-project-rename', {
    action: 'update', workspaceId, projectRef: projectValue.projectRef, name: 'Parser v2', requestId: 'manager-write-project-rename-1',
  })
  expect(renamed.isError).toBe(false)
  if (renamed.isError) return
  expect(JSON.stringify(renamed.content)).toContain('Project updated')
  expect(scaffold!.ctx.agentTeam.view({ workspaceId }).projects.find(entry => entry.projectRef === projectValue.projectRef))
    .toMatchObject({ name: 'Parser v2', description: '把解析收敛到一个权威实现', state: 'active' })

  // 4. Idempotency and collision: the same id and parameters answer with the
  // original receipt, and a changed parameter under a reused id writes nothing.
  const replayed = await call('member_create', 'manager-write-member-replay', {
    workspaceId, handle: 'Iris', description: '长期负责评审与验收', model: route, requestId: 'manager-write-member-1',
  })
  expect(replayed.isError).toBe(false)
  if (replayed.isError) return
  expect((replayed.value as { receipt: { operationId: string } }).receipt.operationId).toBe(memberValue.receipt.operationId)
  expect(scaffold!.ctx.agentTeam.members({ workspaceId }).filter(entry => entry.member.handle === 'Iris')).toHaveLength(1)

  const collision = await call('member_create', 'manager-write-member-collision', {
    workspaceId, handle: 'Someone else', description: '长期负责评审与验收', model: route, requestId: 'manager-write-member-1',
  })
  expect(collision.isError).toBe(true)
  if (!collision.isError) return
  expect(collision.error.message).toContain('was reused with a different operation or payload')
  expect(scaffold!.ctx.agentTeam.members({ workspaceId }).filter(entry => entry.member.handle === 'Iris')).toHaveLength(1)
  expect(scaffold!.ctx.agentTeam.members({ workspaceId }).filter(entry => entry.member.handle === 'Someone else')).toHaveLength(0)

  // 5. Adjustment: a partial edit that names one field keeps the rest, and the
  // lifecycle and Workspace tools ride the same guards and receipts.
  const edited = await call('member_update', 'manager-write-update', {
    memberRef: memberValue.memberRef, description: '长期负责评审、验收与交付节奏', requestId: 'manager-write-update-1',
  })
  expect(edited.isError).toBe(false)
  if (edited.isError) return
  expect(JSON.stringify(edited.content)).toContain('Member updated')
  // A description-only patch changes no runtime configuration, so the answer
  // says so instead of claiming an apply that never happened.
  expect((edited.value as { effect: string }).effect).toBe('already-applied')
  const editedRow = scaffold!.ctx.agentTeam.members({ workspaceId })
    .find(entry => entry.member.memberId === memberValue.memberRef)!
  expect(editedRow.member).toMatchObject({ handle: 'Iris', description: '长期负责评审、验收与交付节奏', model: route })

  const editedReplay = await call('member_update', 'manager-write-update-replay', {
    memberRef: memberValue.memberRef, description: '长期负责评审、验收与交付节奏', requestId: 'manager-write-update-1',
  })
  expect(editedReplay.isError).toBe(false)
  if (editedReplay.isError) return
  expect((editedReplay.value as { receipt: { operationId: string } }).receipt.operationId)
    .toBe((edited.value as { receipt: { operationId: string } }).receipt.operationId)

  const suspended = await call('member_state', 'manager-write-suspend', {
    action: 'suspend', memberRef: memberValue.memberRef, requestId: 'manager-write-suspend-1',
  })
  expect(suspended.isError).toBe(false)
  if (suspended.isError) return
  expect(JSON.stringify(suspended.content)).toContain('Member suspended')
  expect((suspended.value as { status: { availability: string } }).status.availability).toBe('suspended')
  // The Client reads the same availability the write answered: the roster row
  // stays, and opening its Session is disabled until the Member is resumed.
  const rowButton = page.getByRole('button', { name: '打开 Iris 的会话', exact: true })
  await expect.poll(async () => rowButton.isDisabled(), { timeout: 20_000 }).toBe(true)

  const resumed = await call('member_state', 'manager-write-resume', {
    action: 'resume', memberRef: memberValue.memberRef, requestId: 'manager-write-resume-1',
  })
  expect(resumed.isError).toBe(false)
  if (resumed.isError) return
  expect((resumed.value as { status: { availability: string } }).status.availability).toBe('active')
  await expect.poll(async () => rowButton.isDisabled(), { timeout: 20_000 }).toBe(false)

  // Archival is the end state this version offers: the record stays readable
  // with its private data, and the Member leaves the active roster.
  const retiring = await call('member_create', 'manager-write-retiring', {
    workspaceId, handle: 'Nadia', description: '临时支援解析器迁移', model: route, requestId: 'manager-write-retiring-1',
  })
  expect(retiring.isError).toBe(false)
  if (retiring.isError) return
  const retiringRef = (retiring.value as { memberRef: string }).memberRef
  const archived = await call('member_state', 'manager-write-archive', {
    action: 'archive', memberRef: retiringRef, requestId: 'manager-write-archive-1',
  })
  expect(archived.isError).toBe(false)
  if (archived.isError) return
  expect(JSON.stringify(archived.content)).toContain('Member archived')
  expect((archived.value as { status: { availability: string } }).status.availability).toBe('archived')
  const archivedRow = scaffold!.ctx.agentTeam.members({ workspaceId })
    .find(entry => entry.member.memberId === retiringRef)!
  expect(archivedRow.availability).toBe('archived')
  expect(archivedRow.member.description).toBe('临时支援解析器迁移')

  // The creation Workspace cannot be left; the refusal is the ledger's own.
  const leaveCreation = await call('member_workspace', 'manager-write-leave-creation', {
    action: 'leave', memberRef: memberValue.memberRef, workspaceId, requestId: 'manager-write-leave-creation-1',
  })
  expect(leaveCreation.isError).toBe(true)
  if (!leaveCreation.isError) return
  expect(leaveCreation.error.message).toContain('cannot leave its default Workspace')

  // Archival is the Project's end state: a second Project, so the one the Client
  // checks below still stands, keeps its history and stops accepting work.
  const doomed = await call('project_create', 'manager-write-doomed', {
    workspaceId, name: 'Scratch', description: '一次性的实验目标', memberIds: [memberValue.memberRef], requestId: 'manager-write-doomed-1',
  })
  expect(doomed.isError).toBe(false)
  if (doomed.isError) return
  const doomedRef = (doomed.value as { projectRef: string }).projectRef
  const archivedProject = await call('project_update', 'manager-write-project-archive', {
    action: 'archive', workspaceId, projectRef: doomedRef, requestId: 'manager-write-project-archive-1',
  })
  expect(archivedProject.isError).toBe(false)
  if (archivedProject.isError) return
  expect(JSON.stringify(archivedProject.content)).toContain('nothing was deleted')
  expect(archivedProject.value).toMatchObject({ state: 'archived', releasedClaims: 0, subscriptionsCleared: 0 })
  expect(scaffold!.ctx.agentTeam.view({ workspaceId }).projects.find(entry => entry.projectRef === doomedRef)).toBeUndefined()

  // 6. The write surface belongs to the manager Session alone: an ordinary
  // Session reaching the tool by any other route is refused, not answered.
  const ordinary = scaffold!.ctx.agents.get(ordinaryId as SessionId)
  expect(ordinary).toBeDefined()
  const foreign = await scaffold!.ctx.tools.execute({
    calls: [{ type: 'tool-call', id: ToolCallId('manager-write-foreign'), name: 'member_create',
      arguments: JSON.stringify({ workspaceId, handle: 'Intruder', description: '越权创建', model: route, requestId: 'manager-write-foreign-1' }) }],
    agent: ordinary, signal: new AbortController().signal,
  })
  expect(foreign.results[0]!.result.isError).toBe(true)
  expect(scaffold!.ctx.agentTeam.members({ workspaceId }).filter(entry => entry.member.handle === 'Intruder')).toHaveLength(0)

  // 7. The Client shows the same records the manager wrote: the roster row, and
  // the Project dialog's owner row with its responsibility.
  await page.getByText('Iris', { exact: true }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: '# Parser v2', exact: true }).hover()
  await page.getByRole('button', { name: 'Parser v2 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑项目', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑项目' })
  await editor.waitFor()
  const owners = editor.getByRole('group', { name: '负责人' })
  await owners.getByRole('button', { name: '移除负责人 @Iris' }).waitFor({ timeout: 20_000 })
  await owners.getByText(rewordedResponsibility).waitFor()
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await settleAnimations(page)
  await settleLayout(page)
  await page.screenshot({ path: join(MANAGER_WRITES_SHOTS, 'manager-writes-desktop.png'), fullPage: true, animations: 'disabled' })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await openSidebar(page)
  await page.getByRole('button', { name: '# Parser v2', exact: true }).hover()
  await page.getByRole('button', { name: 'Parser v2 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑项目', exact: true }).click()
  const narrowEditor = page.getByRole('dialog', { name: '编辑项目' })
  await narrowEditor.waitFor()
  await narrowEditor.getByRole('group', { name: '负责人' }).getByText(rewordedResponsibility).waitFor()
  await settleAnimations(page)
  await settleLayout(page)
  await page.screenshot({ path: join(MANAGER_WRITES_SHOTS, 'manager-writes-mobile.png'), fullPage: true, animations: 'disabled' })
  await narrowEditor.getByRole('button', { name: '关闭', exact: true }).click()
  await settleAnimations(page)

  // 8. Withdrawal ends the owner relation only: the Member keeps its Project
  // participation, and the Client's dialog no longer offers the owner row.
  const withdrawn = await call('project_owner', 'manager-write-owner-remove', {
    action: 'remove', workspaceId, projectRef: projectValue.projectRef, memberRef: memberValue.memberRef, requestId: 'manager-write-owner-remove-1',
  })
  expect(withdrawn.isError).toBe(false)
  if (withdrawn.isError) return
  expect(JSON.stringify(withdrawn.content)).toContain('Owner withdrawn')
  expect(scaffold!.ctx.agentTeam.view({ workspaceId }).owners).toEqual([])
  await page.getByRole('button', { name: '# Parser v2', exact: true }).hover()
  await page.getByRole('button', { name: 'Parser v2 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑项目', exact: true }).click()
  const clearedEditor = page.getByRole('dialog', { name: '编辑项目' })
  await clearedEditor.waitFor()
  await expect.poll(async () => await clearedEditor.getByRole('button', { name: '移除负责人 @Iris' }).count()).toBe(0)
  await clearedEditor.getByRole('button', { name: '关闭', exact: true }).click()

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
