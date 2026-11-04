import { afterEach, it, expect } from 'vitest'
import { join } from 'node:path'
import { SUBSCRIPTION_SHOTS, closeScenario, maxHorizontalScroll, openTeamPage, settleAnimations, settleLayout } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

/**
 * The webhook trigger as a Human meets it: a subscription that only takes
 * pushes, the one-time address a save arms, and the reset that moves it.
 *
 * The origin is installation config (`webhook.publicOrigin`), so the lane boots
 * the Host row with one — without it nothing can be armed and the dialog this
 * scenario exists to prove would never open.
 */
const ORIGIN = 'https://hooks.example.test'

/** A script that reads the stdin envelope, which is what a webhook run hands it. */
const SCRIPT = [
  `payload=$(cat)`,
  `case "$payload" in *'"headers"'*) ;; *) echo 'no stdin envelope' >&2; exit 1 ;; esac`,
  `printf '%s\\n' '{"id":"pr-1","title":"PR opened"}'`,
].join('\n')

const addressOf = async (page: Parameters<typeof maxHorizontalScroll>[0]): Promise<string> => {
  const code = page.locator('[data-team-webhook-address]')
  await code.waitFor()
  return (await code.textContent())?.trim() ?? ''
}

it('arms a webhook-only subscription, shows the address once, and moves it on reset', async () => {
  const { page, consoleWatch } = await openTeamPage({ webhookOrigin: ORIGIN })

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('hooks-web')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# hooks-web', exact: true }).click()
  const tabs = page.getByRole('tablist', { name: '# hooks-web' })
  await tabs.getByRole('tab', { name: /^订阅/ }).click()

  await page.getByRole('button', { name: '新建订阅' }).click()
  const editor = page.getByRole('dialog', { name: '新建订阅' })
  await editor.waitFor()
  await editor.getByLabel('名称').fill('PR 动态（webhook）')
  // Only the webhook trigger: no timer, and therefore no interval to send.
  await editor.getByRole('checkbox', { name: '定时运行' }).uncheck()
  await editor.getByRole('checkbox', { name: '接收 webhook' }).check()
  expect(await editor.getByRole('spinbutton').count()).toBe(0)
  await editor.getByLabel('脚本').fill(SCRIPT)
  await editor.getByRole('button', { name: '试运行' }).click()
  await editor.getByText(/试运行通过：1 条事件/).waitFor()
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'webhook-editor-desktop.png'), fullPage: true })
  await editor.getByRole('button', { name: '保存' }).click()

  // The address is the whole point of the save: shown once, complete, copyable.
  const addressDialog = page.getByRole('dialog', { name: 'Webhook 地址 · PR 动态（webhook）' })
  await addressDialog.waitFor()
  const first = await addressOf(page)
  expect(first.startsWith(`${ORIGIN}/team/hooks/`)).toBe(true)
  expect(first.length).toBeGreaterThan(`${ORIGIN}/team/hooks/`.length + 40)
  await expect.poll(async () => await addressDialog.getByRole('button', { name: '复制地址' }).count()).toBe(1)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'webhook-address-desktop.png'), fullPage: true })
  await addressDialog.getByRole('button', { name: '关闭' }).first().click()

  // Closing forgets it: nothing on the page can show the address again.
  await expect.poll(async () => await page.locator('[data-team-webhook-address]').count()).toBe(0)
  expect(await page.getByText(first, { exact: false }).count()).toBe(0)
  const card = page.locator('[data-team-subscription-ref]').first()
  await card.getByText('webhook', { exact: true }).waitFor()
  await card.getByRole('button', { name: '重置地址 · PR 动态（webhook）' }).waitFor()

  // A reset is a new address under the same subscription, and the only other
  // place the complete one is ever shown.
  await card.getByRole('button', { name: '重置地址 · PR 动态（webhook）' }).click()
  const resetDialog = page.getByRole('dialog', { name: 'Webhook 地址 · PR 动态（webhook）' })
  await resetDialog.waitFor()
  const second = await addressOf(page)
  expect(second.startsWith(`${ORIGIN}/team/hooks/`)).toBe(true)
  expect(second).not.toBe(first)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'webhook-address-reset-desktop.png'), fullPage: true })
  await resetDialog.getByRole('button', { name: '关闭' }).first().click()

  // The narrow lane: a 300-character address must stay inside a 390px column.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await card.getByRole('button', { name: '重置地址 · PR 动态（webhook）' }).click()
  const narrowDialog = page.getByRole('dialog', { name: 'Webhook 地址 · PR 动态（webhook）' })
  await narrowDialog.waitFor()
  await addressOf(page)
  await settleAnimations(page)
  expect(await maxHorizontalScroll(page, '[data-team-subscriptions]')).toBe(0)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'webhook-address-mobile.png'), fullPage: true })

  // Keyboard: the dialog's own close control is reachable without a pointer, and
  // Escape dismisses it as every other Team dialog does.
  await narrowDialog.getByRole('button', { name: '关闭' }).first().focus()
  await page.keyboard.press('Escape')
  await expect.poll(async () => await page.locator('[data-team-webhook-address]').count()).toBe(0)

  // The failed-delivery list is the owner's own read: empty here, and it says so.
  await card.getByRole('button', { name: '失败投递 · PR 动态（webhook）' }).click()
  const deliveries = page.getByRole('dialog', { name: '失败投递 · PR 动态（webhook）' })
  await deliveries.getByText('没有失败投递：每个投递都处理完了。').waitFor()
  await deliveries.getByRole('button', { name: '关闭' }).first().click()

  expect(consoleWatch.pageErrors).toEqual([])
}, 180_000)
