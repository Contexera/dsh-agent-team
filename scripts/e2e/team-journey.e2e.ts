import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  BROWSER_ARTIFACTS,
  closeScenario,
  openTeamPage,
  scaffold,
  settleLayout,
} from './__external-agent-team-support.ts'

const SMOKE_SHOTS = join(BROWSER_ARTIFACTS, 'team-journey-smoke')

afterEach(async () => { await closeScenario() })

it('installs the bundle, crosses the Team surface, survives reload, and restores ordinary DSH', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true })
  const ordinaryComposer = page.locator('[data-composer-input][contenteditable="true"]')
  await ordinaryComposer.waitFor()
  expect(scaffold!.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(true)
  await page.screenshot({ path: join(SMOKE_SHOTS, 'ordinary-before-team.png'), fullPage: true })

  await page.getByRole('button', { name: '团队', exact: true }).click()
  await page.getByRole('button', { name: '新建项目' }).click()
  const projectDialog = page.getByRole('dialog', { name: '新建项目' })
  await projectDialog.getByLabel('名称').fill('journey-smoke')
  await projectDialog.getByRole('button', { name: '创建项目' }).click()

  const projectEntry = page.getByRole('button', { name: '# journey-smoke', exact: true })
  await projectEntry.waitFor()
  await projectEntry.click()
  await page.getByRole('heading', { name: '# journey-smoke', exact: true }).waitFor()

  const composer = page.getByRole('textbox', { name: '消息内容' })
  const send = page.getByRole('button', { name: '发送', exact: true })
  await composer.fill('journey smoke message')
  await send.click()
  await page.getByText('journey smoke message', { exact: true }).waitFor()

  const taskToggle = page.getByRole('button', { name: '讨论/任务' })
  await taskToggle.click()
  await page.getByRole('checkbox', { name: '作为任务' }).check()
  await composer.fill('journey smoke task')
  await send.click()
  await page.getByRole('tab', { name: '看板' }).waitFor()
  await page.getByRole('button', { name: '打开 Task #1', exact: true }).waitFor()
  await page.screenshot({ path: join(SMOKE_SHOTS, 'team-task.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.getByRole('button', { name: '打开 Task #1', exact: true }).waitFor()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await page.screenshot({ path: join(SMOKE_SHOTS, 'team-task-narrow.png'), fullPage: true })

  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  await page.reload()
  await projectEntry.waitFor()
  await page.getByRole('heading', { name: '# journey-smoke', exact: true }).waitFor()
  const boardTab = page.getByRole('tab', { name: '看板' })
  await boardTab.waitFor()
  if (await boardTab.getAttribute('aria-selected') !== 'true') await boardTab.click()
  await page.getByRole('button', { name: '打开 Task #1', exact: true }).waitFor()

  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect.poll(() => page.locator('[data-team-project]').count()).toBe(0)
  await ordinaryComposer.waitFor()
  await ordinaryComposer.fill('/')
  await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(0)
  await ordinaryComposer.fill('')
  await page.screenshot({ path: join(SMOKE_SHOTS, 'ordinary-after-team.png'), fullPage: true })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
})
