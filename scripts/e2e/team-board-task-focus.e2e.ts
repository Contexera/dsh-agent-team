import { afterEach, it, expect } from 'vitest'
import { join } from 'node:path'
import { UI04_SHOTS, closeScenario, openTeamPage, settleLayout } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

// Starting a Task from the Project composer switches to the board and the composer
// unmounts, so focus has to land somewhere. It lands on the Task's own new card —
// not the tab, whose `:focus-visible` ring read as a stray blue circle at the top.
// These assertions pin the landing target and the two input modalities apart: a
// keyboard send rings the card, a mouse send focuses it without a visible ring.
it('lands a started Task on its board card, keyboard and mouse', async () => {
  const { page, consoleWatch } = await openTeamPage()

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('delivery')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# delivery', exact: true }).click()

  const active = () => page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null
    return {
      role: element?.getAttribute('role') ?? null,
      label: element?.getAttribute('aria-label') ?? null,
      taskRef: element?.getAttribute('data-team-task-ref') ?? null,
      focusVisible: element?.matches(':focus-visible') ?? false,
    }
  })

  const startTask = async (body: string, send: 'enter' | 'click'): Promise<void> => {
    const composer = page.getByRole('textbox', { name: '消息内容' })
    await composer.waitFor()
    const toggle = page.getByRole('button', { name: '讨论/任务' })
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect.poll(() => toggle.getAttribute('aria-pressed')).toBe('true')
    await page.getByRole('checkbox', { name: '作为任务' }).check()
    await composer.fill(body)
    if (send === 'enter') await composer.press('Enter')
    else await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => page.getByRole('tab', { name: '看板' }).getAttribute('aria-selected')).toBe('true')
  }

  // Keyboard send: the card, not the tab, is the landing target, and it carries the
  // focus ring (the same `.boardCard:focus-visible` every board card takes).
  await startTask('键盘发送的任务', 'enter')
  await expect.poll(async () => (await active()).label).toBe('打开 Task #1')
  const keyboard = await active()
  expect(keyboard.role).not.toBe('tab')
  expect(keyboard.taskRef).toMatch(/^task:/)
  expect(keyboard.focusVisible).toBe(true)
  await settleLayout(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'task-focus-card-desktop.png'), fullPage: true })

  // The ring must survive the narrow board, whose columns scroll horizontally.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await settleLayout(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'task-focus-card-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })

  // Mouse send: focus still lands on the new card, but a pointer-driven focus draws
  // no visible ring — the stray blue circle cannot come from this path.
  await page.getByRole('tab', { name: '主对话' }).click()
  await startTask('鼠标发送的任务', 'click')
  await expect.poll(async () => (await active()).label).toBe('打开 Task #2')
  const mouse = await active()
  expect(mouse.role).not.toBe('tab')
  expect(mouse.taskRef).toMatch(/^task:/)
  expect(mouse.focusVisible).toBe(false)
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
