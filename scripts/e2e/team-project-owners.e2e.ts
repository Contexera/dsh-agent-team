import { afterEach, it, expect } from 'vitest'
import { UI04_SHOTS, closeScenario, openSidebar, openTeamPage, scaffold, settleLayout, chooseMemberModel } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })


it('edits Project owners from the Project dialog under rules version 2 in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage()

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('owners-web')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# owners-web', exact: true }).waitFor()

  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('steward')
  await createAgent.getByLabel('说明').fill('负责交付')
  await chooseMemberModel(page, createAgent)
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('steward', { exact: true }).waitFor({ timeout: 20_000 })

  const openEditor = async () => {
    // The row menu button only takes pointer events while its row is hovered.
    await page.getByRole('button', { name: '# owners-web', exact: true }).hover()
    await page.getByRole('button', { name: 'owners-web 的操作' }).click()
    await page.getByRole('menuitem', { name: '编辑项目' }).click()
    const editor = page.getByRole('dialog', { name: '编辑项目' })
    await editor.waitFor()
    return editor
  }
  const editor = await openEditor()
  const owners = editor.getByRole('group', { name: '负责人' })
  await owners.waitFor()
  await owners.getByText('始终是负责人').waitFor()
  expect(await owners.getByRole('button', { name: /^移除负责人/ }).count()).toBe(0)

  // The text typed beside the add control is what the grant records, and the row states it
  // only after the Host's projection comes back with it.
  await owners.getByLabel('新负责人的责任（可留空）').fill('负责交付与验收')
  await owners.getByRole('button', { name: '添加负责人 @steward' }).click()
  const remove = owners.getByRole('button', { name: '移除负责人 @steward' })
  await remove.waitFor()
  await owners.getByText('负责交付与验收').waitFor()
  expect(await owners.getByRole('button', { name: '添加负责人 @steward' }).count()).toBe(0)
  const workspaceId = scaffold.ctx.workspaceRegistry.list()[0]!.id
  expect(scaffold.ctx.agentTeam.view({ workspaceId }).owners).toHaveLength(1)
  expect(scaffold.ctx.agentTeam.view({ workspaceId }).owners[0]!.responsibility).toBe('负责交付与验收')

  // Editing replaces the text on the grant it already holds; the ownership itself never moves.
  await owners.getByRole('button', { name: '编辑 @steward 的责任' }).click()
  const field = owners.getByLabel('@steward 的责任')
  // The form replaced the control that opened it, so the field takes the focus instead of the body.
  await expect.poll(() => field.evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
  // The edit field is the dialog's own field surface, not a second one beside it: text size, radius,
  // stroke and fill are the Input's, and focus answers by moving the stroke rather than adding a ring.
  const nameField = editor.getByLabel('名称')
  // Resting surfaces: the focused field answers with the focus stroke, so both are read unfocused.
  await field.evaluate(element => { (element as HTMLElement).blur() })
  const fieldSurface = await field.evaluate(element => {
    const style = getComputedStyle(element)
    return { size: style.fontSize, leading: style.lineHeight, radius: style.borderRadius, stroke: style.borderColor, fill: style.backgroundColor }
  })
  const inputSurface = await nameField.evaluate(element => {
    const style = getComputedStyle(element)
    const frame = getComputedStyle(element.parentElement as HTMLElement)
    return { size: style.fontSize, leading: style.lineHeight, radius: frame.borderRadius, stroke: frame.borderColor, fill: frame.backgroundColor }
  })
  expect(fieldSurface).toEqual(inputSurface)
  await nameField.focus()
  const inputFocusStroke = await nameField.evaluate(element => getComputedStyle(element.parentElement as HTMLElement).borderColor)
  await field.focus()
  const fieldFocus = await field.evaluate(element => {
    const style = getComputedStyle(element)
    return { stroke: style.borderColor, outline: style.outlineStyle }
  })
  expect(fieldFocus.stroke).toBe(inputFocusStroke)
  expect(fieldFocus.outline).toBe('none')
  await field.fill('负责交付、验收与发布')
  // The actions sit at the row's end in the dialog footer's order: the outline cancel, then the primary save.
  const [cancelBox, saveBox, fieldBox] = await Promise.all([
    owners.getByRole('button', { name: '取消' }).boundingBox(),
    owners.getByRole('button', { name: '保存' }).boundingBox(),
    field.boundingBox(),
  ])
  expect(saveBox!.x).toBeCloseTo(cancelBox!.x + cancelBox!.width + 8, 0)
  expect(saveBox!.x + saveBox!.width).toBeCloseTo(fieldBox!.x + fieldBox!.width, 0)
  // The edit state is its own evidence: the field opens on the recorded text, not on an empty box.
  await settleLayout(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-owners-responsibility-edit.png'), fullPage: true })
  await owners.getByRole('button', { name: '保存' }).click()
  await owners.getByText('负责交付、验收与发布').waitFor()
  expect(scaffold.ctx.agentTeam.view({ workspaceId }).owners[0]!.responsibility).toBe('负责交付、验收与发布')
  // A committed edit hands the focus back to the row's own control once the refresh leaves it interactive.
  await expect.poll(() => owners.getByRole('button', { name: '编辑 @steward 的责任' })
    .evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-owners-desktop.png'), fullPage: true })
  await editor.getByRole('button', { name: '关闭', exact: true }).click()

  // The 390 breakpoint unmounts sidebar panels, so reopen the dialog from the narrow-expanded sidebar.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await openSidebar(page)
  const narrowEditor = await openEditor()
  const narrowOwners = narrowEditor.getByRole('group', { name: '负责人' })
  await narrowOwners.getByRole('button', { name: '移除负责人 @steward' }).waitFor()
  // The recorded text survives the narrow lane, so the screenshot carries the real state.
  await narrowOwners.getByText('负责交付、验收与发布').waitFor()
  await settleLayout(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-owners-mobile.png'), fullPage: true })

  await narrowOwners.getByRole('button', { name: '移除负责人 @steward' }).click()
  await narrowOwners.getByRole('button', { name: '添加负责人 @steward' }).waitFor()
  expect(scaffold.ctx.agentTeam.view({ workspaceId }).owners).toHaveLength(0)
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
import { join } from 'node:path'
