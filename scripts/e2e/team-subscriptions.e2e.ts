import { afterEach, it, expect } from 'vitest'
import { join } from 'node:path'
import { SUBSCRIPTION_SHOTS, closeScenario, focusRing, maxHorizontalScroll, openTeamPage, settleAnimations, settleLayout } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

/**
 * One event on stdout and a warning on stderr: the trial both passes (the event
 * stream is valid) and leaves two streams worth expanding in the run record.
 */
const SCRIPT = [
  `printf '%s\\n' '{"id":"ci-1234","title":"main 分支 CI 失败","url":"https://github.com/example/repo/actions/1"}'`,
  `printf '%s\\n' 'gh: HTTP 502 网关错误' >&2`,
].join('\n')

const EDITED_SCRIPT = `${SCRIPT}\n# 修改后的快照`

it('creates a subscription only after its trial passes, then reads a run record, pauses, resumes and deletes it in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage()

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('subs-web')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# subs-web', exact: true }).click()

  const tabs = page.getByRole('tablist', { name: '# subs-web' })
  const subscriptionsTab = tabs.getByRole('tab', { name: /^订阅/ })
  await subscriptionsTab.waitFor()
  // The count is part of the tab's own name once the list has loaded: it is the
  // only place the page states how many subscriptions the Project holds.
  await expect.poll(async () => await subscriptionsTab.textContent()).toBe('订阅 0')

  // The strip is one tab stop: End reaches the third tab, selects it, and the
  // focus ring is the shipped one rather than the browser default.
  await tabs.getByRole('tab', { name: '主对话' }).focus()
  await page.keyboard.press('End')
  expect(await subscriptionsTab.getAttribute('aria-selected')).toBe('true')
  const tabRing = await focusRing(page, '[data-team-project] [role="tablist"] [role="tab"][aria-selected="true"]')
  expect(tabRing?.focusVisible).toBe(true)
  expect(tabRing?.outlineStyle).not.toBe('none')

  await page.getByText('还没有订阅').waitFor()
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'empty-desktop.png'), fullPage: true })

  await page.getByRole('button', { name: '新建订阅' }).click()
  const editor = page.getByRole('dialog', { name: '新建订阅' })
  await editor.waitFor()
  // Nothing is optimistically written: Save stays disabled until a trial of this
  // exact form passes on the Host.
  const save = editor.getByRole('button', { name: '保存' })
  expect(await save.isDisabled()).toBe(true)
  await editor.getByLabel('名称').fill('main 分支 CI 失败')
  await editor.getByRole('spinbutton').fill('10')
  await editor.getByLabel('脚本').fill(SCRIPT)
  expect(await save.isDisabled()).toBe(true)
  // The script field is at the bottom of a scrolling form: the dialog's own
  // title must not scroll out with it.
  const titleBox = await editor.getByRole('heading', { name: '新建订阅' }).boundingBox()
  const dialogBox = await editor.boundingBox()
  expect(titleBox!.y).toBeGreaterThanOrEqual(dialogBox!.y)

  await editor.getByRole('button', { name: '试运行' }).click()
  await editor.getByText('试运行通过：1 条事件').waitFor()
  expect(await save.isEnabled()).toBe(true)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'editor-trial-desktop.png'), fullPage: true })

  // A refusal is not a reset: the reason and its output tails stand beside the
  // form, and the fields still hold the script the executor just refused.
  await editor.getByLabel('脚本').fill('printf %s not-json')
  expect(await save.isDisabled()).toBe(true)
  await editor.getByRole('button', { name: '试运行' }).click()
  await editor.getByText(/^试运行未通过：/).waitFor()
  expect(await editor.getByLabel('名称').inputValue()).toBe('main 分支 CI 失败')
  expect(await editor.getByLabel('脚本').inputValue()).toBe('printf %s not-json')
  await editor.locator('summary').click()
  await editor.getByText('stderr 末尾').waitFor()
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'trial-failed-desktop.png'), fullPage: true })

  await editor.getByLabel('脚本').fill(SCRIPT)
  await editor.getByRole('button', { name: '试运行' }).click()
  await editor.getByText('试运行通过：1 条事件').waitFor()
  await save.click()
  await expect.poll(async () => await editor.count()).toBe(0)

  const card = page.locator('[data-team-subscription-ref]')
  await card.waitFor()
  await card.getByRole('heading', { name: 'main 分支 CI 失败' }).waitFor()
  expect(await card.textContent()).toContain('每 10 分钟')
  expect(await card.textContent()).toContain('建立者')
  expect(await card.textContent()).toContain('还没有运行记录')
  expect(await subscriptionsTab.textContent()).toBe('订阅 1')
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'list-desktop.png'), fullPage: true })

  // Main stream: the write is announced there, so a Human who was not on this
  // tab still learns the Project gained an unattended script.
  await tabs.getByRole('tab', { name: '主对话' }).click()
  await page.getByText('创建了订阅 main 分支 CI 失败').waitFor()
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'main-stream-desktop.png'), fullPage: true })
  await subscriptionsTab.click()
  await card.waitFor()

  // Editing: the changed form must be trialled again, and the edit trial is what
  // leaves the first run record an owner can read.
  await card.getByRole('button', { name: '编辑 · main 分支 CI 失败' }).click()
  const editDialog = page.getByRole('dialog', { name: '编辑订阅' })
  await editDialog.waitFor()
  expect(await editDialog.getByLabel('名称').inputValue()).toBe('main 分支 CI 失败')
  const editSave = editDialog.getByRole('button', { name: '保存' })
  expect(await editSave.isDisabled()).toBe(true)
  await editDialog.getByLabel('脚本').fill(EDITED_SCRIPT)
  await editDialog.getByRole('button', { name: '试运行' }).click()
  await editDialog.getByText('试运行通过：1 条事件').waitFor()
  await editSave.click()
  await expect.poll(async () => await editDialog.count()).toBe(0)

  await card.getByRole('button', { name: '运行记录 · main 分支 CI 失败' }).click()
  const logs = page.getByRole('dialog', { name: '运行记录 · main 分支 CI 失败' })
  await logs.waitFor()
  const runs = logs.locator('[data-team-subscription-run]')
  await runs.first().waitFor()
  expect(await runs.count()).toBeGreaterThan(0)
  // A trial that passed is recorded with its own category, never as a run that
  // published: the card says 试运行通过, the event count stays 0.
  expect(await runs.first().textContent()).toContain('试运行通过')
  await runs.first().getByRole('button', { name: /^展开 · / }).click()
  await runs.first().getByText('stdout 末尾').waitFor()
  expect(await runs.first().locator('pre').first().textContent()).toContain('"id":"ci-1234"')
  expect(await runs.first().locator('pre').last().textContent()).toContain('gh: HTTP 502 网关错误')
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'run-record-desktop.png'), fullPage: true })
  await logs.getByRole('button', { name: '关闭' }).first().click()
  await expect.poll(async () => await logs.count()).toBe(0)

  // Durability is the reread: the paused card states the reason and offers only
  // 恢复, and the committed write survives the dialog-free page.
  await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).click()
  await card.getByText('已暂停：手动暂停').waitFor()
  expect(await card.getByRole('button', { name: '恢复 · main 分支 CI 失败' }).count()).toBe(1)
  expect(await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).count()).toBe(0)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'paused-desktop.png'), fullPage: true })

  await card.getByRole('button', { name: '恢复 · main 分支 CI 失败' }).click()
  await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).waitFor()
  expect(await card.getByText('已暂停：手动暂停').count()).toBe(0)

  // Keyboard: a card's own controls are real buttons with the shipped ring. The
  // Tab press sets the modality, so the ring is the one a keyboard reader sees.
  await page.keyboard.press('Tab')
  await card.getByRole('button', { name: '运行记录 · main 分支 CI 失败' }).focus()
  const actionRing = await focusRing(page, '[aria-label="运行记录 · main 分支 CI 失败"]')
  expect(actionRing?.focusVisible).toBe(true)
  expect(actionRing?.outlineStyle).not.toBe('none')

  expect(await maxHorizontalScroll(page, '[data-team-subscriptions]')).toBe(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await card.waitFor()
  expect(await maxHorizontalScroll(page, '[data-team-subscriptions]')).toBe(0)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'list-mobile.png'), fullPage: true })

  // A long form on the narrow lane: the whole card keeps the 24px overlay inset,
  // so the fixed head and foot stay reachable while the form scrolls.
  await page.getByRole('button', { name: '新建订阅' }).click()
  const mobileEditor = page.getByRole('dialog', { name: '新建订阅' })
  await mobileEditor.waitFor()
  const mobileDialogBox = await mobileEditor.boundingBox()
  expect(mobileDialogBox!.y).toBeGreaterThanOrEqual(0)
  expect(mobileDialogBox!.y + mobileDialogBox!.height).toBeLessThanOrEqual(844)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'editor-mobile.png'), fullPage: true })
  await mobileEditor.getByRole('button', { name: '取消' }).click()
  await expect.poll(async () => await mobileEditor.count()).toBe(0)

  await card.getByRole('button', { name: '运行记录 · main 分支 CI 失败' }).click()
  await logs.waitFor()
  await runs.first().waitFor()
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'run-record-mobile.png'), fullPage: true })
  await logs.getByRole('button', { name: '关闭' }).first().click()
  await expect.poll(async () => await logs.count()).toBe(0)

  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  await card.waitFor()

  await card.getByRole('button', { name: '删除 · main 分支 CI 失败' }).click()
  const deletion = page.getByRole('dialog', { name: '删除订阅：main 分支 CI 失败' })
  await deletion.waitFor()
  await deletion.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByText('还没有订阅').waitFor()
  await expect.poll(async () => await page.locator('[data-team-subscription-ref]').count()).toBe(0)
  await expect.poll(async () => await subscriptionsTab.textContent()).toBe('订阅 0')
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'deleted-desktop.png'), fullPage: true })

  await tabs.getByRole('tab', { name: '主对话' }).click()
  await page.getByText('删除了订阅 main 分支 CI 失败').waitFor()
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 240_000)
