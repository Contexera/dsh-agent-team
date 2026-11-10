import { join } from 'node:path'
import { afterEach, it, expect } from 'vitest'
import { UI09_SHOTS, closeScenario, openTeamPage, settleLayout } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })


it('reaches Team mode, its two faces, and the shortcut reference from the keyboard', async () => {
  // The visiting device decides which defaults are in force, so this lane states
  // the macOS device the Human runs and presses that set.
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true, platform: 'MacIntel' })
  const mode = (): Promise<string | null> => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)
  expect(await mode()).toBeNull()

  await page.keyboard.press('Meta+Alt+KeyT')
  await expect.poll(mode).toBe('team')

  // The composer chord puts the caret in the Team composer, and only a project's
  // main conversation carries one. Blur first, so the assertion measures the
  // chord and not a composer that the click already focused.
  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('shortcut')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# shortcut', exact: true }).click()
  await page.locator('[data-team-composer] textarea').waitFor()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('TEXTAREA')
  await page.keyboard.press('Meta+Alt+KeyM')
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA')

  // Back climbs one face at a time. A Task started from the composer opens a full
  // Thread page, and Back returns to the Project it was opened from.
  const snapshot = (): Promise<Record<string, unknown>> => page.evaluate(() => JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as Record<string, unknown>)
  await page.getByRole('button', { name: '讨论/任务' }).click()
  await page.getByRole('checkbox', { name: '作为任务' }).check()
  await page.getByRole('textbox', { name: '消息内容' }).fill('返回键验收')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(() => page.getByRole('tab', { name: '看板' }).getAttribute('aria-selected')).toBe('true')
  await page.getByRole('button', { name: '打开 Task #1' }).click()
  await page.locator('main[data-team-thread]').waitFor()
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.locator('main[data-team-thread]').waitFor({ state: 'detached' })
  await page.locator('[data-team-project]').waitFor()
  await expect.poll(async () => (await snapshot()).threadRef).toBeUndefined()
  expect((await snapshot()).projectRef).toMatch(/^project:/)

  // Forward re-enters the Thread page the last Back left, and Back leaves it
  // again: on this pair of faces the two chords are exact inverses.
  await page.keyboard.press('Meta+Alt+ArrowRight')
  await page.locator('main[data-team-thread]').waitFor()
  await expect.poll(async () => (await snapshot()).threadRef).toMatch(/^thread:/)
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.locator('main[data-team-thread]').waitFor({ state: 'detached' })
  await page.locator('[data-team-project]').waitFor()

  await page.keyboard.press('Meta+Alt+Digit1')
  await page.locator('[data-team-inbox]').waitFor()
  await page.screenshot({ path: join(UI09_SHOTS, 'shortcut-inbox.png'), fullPage: true })

  // The Inbox and the Board are faces of the workspace, so Back leaves them for it.
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.locator('[data-team-inbox]').waitFor({ state: 'detached' })
  await page.locator('[data-team-conversation]').waitFor()
  await expect.poll(async () => (await snapshot()).inbox).toBeUndefined()

  await page.keyboard.press('Meta+Alt+Digit2')
  await page.locator('[data-team-task-board]').waitFor()
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.locator('[data-team-task-board]').waitFor({ state: 'detached' })
  await page.locator('[data-team-conversation]').waitFor()
  await expect.poll(async () => (await snapshot()).board).toBeUndefined()

  // The welcome surface is the top rung: Back is consumed and nothing moves.
  const welcome = await snapshot()
  await page.keyboard.press('Meta+Alt+ArrowLeft')
  await page.locator('[data-team-conversation]').waitFor()
  expect(await snapshot()).toEqual(welcome)

  // The same chord hands the column back to the conversation.
  await page.keyboard.press('Meta+Alt+KeyT')
  await expect.poll(mode).toBeNull()

  // Every command is in the shell's own reference, which is where a reader
  // discovers it and where it stays rebindable.
  await page.keyboard.press('Meta+Slash')
  const reference = page.getByRole('dialog', { name: '快捷键' })
  await reference.waitFor()
  const application = reference.getByRole('region', { name: '应用操作' })
  for (const label of ['进入或退出团队模式', '收件箱', '任务看板', '聚焦输入框', '返回', '前进', '上一个项目', '下一个项目',
    '收件箱第 1 项', '收件箱第 9 项']) {
    expect(await application.getByText(label, { exact: true }).count()).toBe(1)
  }
  await page.screenshot({ path: join(UI09_SHOTS, 'shortcut-reference.png'), fullPage: true })

  // The reference is long; the Team block sits below the shipped commands, and
  // this is where a reader checks which chord the composer command carries.
  await application.getByText('聚焦输入框', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(UI09_SHOTS, 'shortcut-reference-team.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'shortcut-reference-narrow.png'), fullPage: true })
  const narrow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
