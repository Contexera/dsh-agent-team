import { afterEach, it, expect } from 'vitest'
import { join } from 'node:path'
import type { AgentTeamRequestId } from '@contexera/dsh-agent-team/types'
import { SUBSCRIPTION_SHOTS, closeScenario, focusRing, maxHorizontalScroll, openTeamPage, scaffold, settleAnimations, settleLayout } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

/**
 * One event on stdout and a warning on stderr, so the run record has two streams
 * worth expanding.
 */
const SCRIPT = [
  `printf '%s\\n' '{"id":"ci-1234","title":"main 分支 CI 失败","url":"https://github.com/example/repo/actions/1"}'`,
  `printf '%s\\n' 'gh: HTTP 502 网关错误' >&2`,
].join('\n')

const EDITED_SCRIPT = `${SCRIPT}\n# 修改后的快照`

/**
 * The subscription page as the Human meets it now: a Project owner arms and
 * maintains subscriptions through the Host, and this page reads what is armed.
 * Nothing here creates, edits, pauses or deletes — the absence of those controls
 * is the contract this scenario exists to hold.
 */
it('reads the subscriptions a Project owner armed, and offers no write control in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage()

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('subs-web')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# subs-web', exact: true }).click()

  const tabs = page.getByRole('tablist', { name: '# subs-web' })
  const subscriptionsTab = tabs.getByRole('tab', { name: '订阅', exact: true })
  await subscriptionsTab.waitFor()
  // The label is the surface's name alone: no count, and nothing about it changes
  // when the list loads.
  expect(await subscriptionsTab.textContent()).toBe('订阅')

  // The strip is one tab stop: End reaches the third tab, selects it, and the
  // focus ring is the shipped one rather than the browser default.
  await tabs.getByRole('tab', { name: '主对话' }).focus()
  await page.keyboard.press('End')
  expect(await subscriptionsTab.getAttribute('aria-selected')).toBe('true')
  const tabRing = await focusRing(page, '[data-team-project] [role="tablist"] [role="tab"][aria-selected="true"]')
  expect(tabRing?.focusVisible).toBe(true)
  expect(tabRing?.outlineStyle).not.toBe('none')

  // Empty: the page says who can arm one instead of offering the Human a form.
  await page.getByText('还没有订阅').waitFor()
  await page.getByText(/项目负责人可以订阅事件/).waitFor()
  expect(await page.getByRole('button', { name: '新建订阅' }).count()).toBe(0)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'empty-desktop.png'), fullPage: true })

  // A Project owner arms one through the Host. The write is not the page's, so
  // the page only has to read it back.
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const projectRef = team.view({ workspaceId }).projects.find(project => project.name === 'subs-web')!.projectRef
  const seeded = await team.createSubscription({
    requestId: 'req:seed-create' as AgentTeamRequestId, workspaceId, projectRef,
    name: 'main 分支 CI 失败', intervalMinutes: 10, script: { scriptContent: SCRIPT },
  })
  // The Host answers the arm itself, not a Remote envelope: a create that failed
  // its trial says so here rather than leaving the page with nothing to read.
  if (seeded.kind !== 'changed') throw new Error(`create refused: ${seeded.kind === 'trial-failed' ? seeded.failure.reason : seeded.kind}`)

  await tabs.getByRole('tab', { name: '主对话' }).click()
  await page.getByText('创建了订阅 main 分支 CI 失败').waitFor()
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'main-stream-desktop.png'), fullPage: true })
  await subscriptionsTab.click()

  const card = page.locator('[data-team-subscription-ref]')
  await card.getByRole('heading', { name: 'main 分支 CI 失败' }).waitFor()
  const cardText = await card.textContent()
  expect(cardText).toContain('每 10 分钟')
  expect(cardText).toContain('负责人')
  expect(cardText).toContain('还没有运行记录')
  // A zero count is stated once, never as both "no events" and "0 events".
  expect(cardText).not.toContain('共 0 条事件')
  // Arm and edit never reach this page: the Human reads and may only stop what an
  // owner started, so no control here can author a subscription.
  const controls = await page.locator('[data-team-subscriptions] button').evaluateAll(buttons =>
    buttons.map(button => button.getAttribute('aria-label') ?? button.textContent ?? ''))
  expect(controls.filter(label => /^(新建订阅|编辑|失败投递|重置地址)/.test(label))).toEqual([])
  await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).waitFor()
  await card.getByRole('button', { name: '删除 · main 分支 CI 失败' }).waitFor()
  expect(await page.getByText(/订阅由项目负责人维护/).count()).toBe(1)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'list-desktop.png'), fullPage: true })

  // An owner's edit leaves the trial run this page reads; the run record is the
  // one place the script's own output is shown.
  await team.updateSubscription({
    requestId: 'req:seed-edit' as AgentTeamRequestId, workspaceId, projectRef,
    subscriptionRef: seeded.subscription.subscriptionRef,
    expectedRevision: seeded.subscription.revision,
    name: 'main 分支 CI 失败', intervalMinutes: 10, script: { scriptContent: EDITED_SCRIPT },
  })
  await tabs.getByRole('tab', { name: '主对话' }).click()
  await subscriptionsTab.click()
  await card.getByText(/上次运行/).waitFor()

  await card.getByRole('button', { name: '运行记录 · main 分支 CI 失败' }).click()
  const logs = page.getByRole('dialog', { name: '运行记录 · main 分支 CI 失败' })
  await logs.waitFor()
  const runs = logs.locator('[data-team-subscription-run]')
  await runs.first().waitFor()
  // A trial that passed is recorded with its own category: `试运行通过` already
  // names the trigger, so the row does not print 试运行 twice.
  const firstRun = (await runs.first().textContent()) ?? ''
  expect(firstRun).toContain('试运行通过')
  expect(firstRun).not.toContain('试运行 试运行通过')
  // The row itself is the disclosure: its accessible name is the run's own facts
  // and the clock, so nothing floats at the row's far edge.
  const firstHead = runs.first().getByRole('button')
  const clock = (await runs.first().locator('time').textContent()) ?? ''
  const firstFacts = (await firstHead.textContent()) ?? ''
  expect(firstFacts.startsWith(clock)).toBe(true)
  expect(await firstHead.getAttribute('aria-expanded')).toBe('false')
  await firstHead.click()
  await runs.first().getByText('stdout 末尾').waitFor()
  expect(await firstHead.getAttribute('aria-expanded')).toBe('true')
  expect(await runs.first().locator('pre').first().textContent()).toContain('"id":"ci-1234"')
  expect(await runs.first().locator('pre').last().textContent()).toContain('gh: HTTP 502 网关错误')
  // The expanded body sits in the row's text column (the chevron seat and its
  // gap), so output reads as this run's own rather than as the next row's peer.
  const captionBox = await runs.first().getByText('stdout 末尾').boundingBox()
  const timeBox = await runs.first().locator('time').boundingBox()
  expect(Math.abs(captionBox!.x - timeBox!.x)).toBeLessThanOrEqual(1)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'run-record-desktop.png'), fullPage: true })
  await logs.getByRole('button', { name: '关闭' }).first().click()
  await expect.poll(async () => await logs.count()).toBe(0)

  // Pausing is the Human's supervision of what an owner armed: the card states
  // the reason and offers only the control that applies from here.
  await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).click()
  await card.getByText('已暂停：手动暂停').waitFor()
  expect(await card.getByRole('button', { name: '恢复 · main 分支 CI 失败' }).count()).toBe(1)
  expect(await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).count()).toBe(0)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'paused-desktop.png'), fullPage: true })

  await card.getByRole('button', { name: '恢复 · main 分支 CI 失败' }).click()
  await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).waitFor()
  expect(await card.getByText('已暂停：手动暂停').count()).toBe(0)

  // Keyboard: the card's own controls are real buttons with the shipped ring. The
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

  // The run record at 390: settled before the shot, because an unsettled dialog
  // is captured mid fade-in.
  await card.getByRole('button', { name: '运行记录 · main 分支 CI 失败' }).click()
  await logs.waitFor()
  await runs.first().waitFor()
  await runs.first().getByRole('button').click()
  await runs.first().getByText('stdout 末尾').waitFor()
  const dialogBox = await logs.boundingBox()
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(844)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'run-record-mobile.png'), fullPage: true })
  await logs.getByRole('button', { name: '关闭' }).first().click()
  await expect.poll(async () => await logs.count()).toBe(0)

  // Deleting is confirmed, then the page states the empty projection again and
  // the tab's label never changed.
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  await card.getByRole('button', { name: '删除 · main 分支 CI 失败' }).click()
  const deletion = page.getByRole('dialog', { name: '删除订阅：main 分支 CI 失败' })
  await deletion.waitFor()
  await deletion.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByText('还没有订阅').waitFor()
  await expect.poll(async () => await page.locator('[data-team-subscription-ref]').count()).toBe(0)
  expect(await subscriptionsTab.textContent()).toBe('订阅')
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'deleted-desktop.png'), fullPage: true })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 240_000)
