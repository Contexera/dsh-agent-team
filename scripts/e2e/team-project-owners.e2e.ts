import { afterEach, it, expect } from 'vitest'
import { UI04_SHOTS, closeScenario, openTeamPage, scaffold, settleLayout } from './__external-agent-team-support.ts'

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

  await owners.getByRole('button', { name: '添加负责人 @steward' }).click()
  const remove = owners.getByRole('button', { name: '移除负责人 @steward' })
  await remove.waitFor()
  expect(await owners.getByRole('button', { name: '添加负责人 @steward' }).count()).toBe(0)
  const workspaceId = scaffold.ctx.workspaceRegistry.list()[0]!.id
  expect(scaffold.ctx.agentTeam.view({ workspaceId }).owners).toHaveLength(1)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-owners-desktop.png'), fullPage: true })
  await editor.getByRole('button', { name: '关闭', exact: true }).click()

  // The 390 breakpoint unmounts sidebar panels, so reopen the dialog from the narrow-expanded sidebar.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await page.getByRole('button', { name: '打开侧边栏' }).click()
  const narrowEditor = await openEditor()
  const narrowOwners = narrowEditor.getByRole('group', { name: '负责人' })
  await narrowOwners.getByRole('button', { name: '移除负责人 @steward' }).waitFor()
  await settleLayout(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-owners-mobile.png'), fullPage: true })

  await narrowOwners.getByRole('button', { name: '移除负责人 @steward' }).click()
  await narrowOwners.getByRole('button', { name: '添加负责人 @steward' }).waitFor()
  expect(scaffold.ctx.agentTeam.view({ workspaceId }).owners).toHaveLength(0)
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
import { join } from 'node:path'
