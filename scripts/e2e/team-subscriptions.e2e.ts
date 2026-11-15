import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentTeamRequestId } from '@contexera/dsh-agent-team/types'
import {
  SUBSCRIPTION_SHOTS,
  closeScenario,
  focusRing,
  maxHorizontalScroll,
  openTeamPage,
  scaffold,
  settleAnimations,
  settleLayout,
} from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

const SCRIPT = [
  `printf '%s\\n' '{"id":"ci-1234","title":"main 分支 CI 失败","url":"https://github.com/example/repo/actions/1"}'`,
  `printf '%s\\n' 'gh: HTTP 502 网关错误' >&2`,
].join('\n')

const EDITED_SCRIPT = `${SCRIPT}\n# 修改后的快照`

const ORIGIN = 'https://hooks.example.test'

const WEBHOOK_SCRIPT = [
  `payload=$(cat)`,
  `case "$payload" in *'"x-team-event":"test"'*) echo 'waiting for a push' >&2; exit 0 ;; esac`,
  `printf '%s\\n' '{"id":"pipeline-1","title":"pipeline 通了","url":"https://example.test/runs/1","detail":"由订阅脚本发出；标题、链接与说明都是数据。"}'`,
].join('\n')

const laterScript = (id: string, title: string): string => [
  `payload=$(cat)`,
  `case "$payload" in *'"x-team-event":"test"'*) echo 'waiting for a push' >&2; exit 0 ;; esac`,
  `printf '%s\\n' '{"id":"${id}","title":"${title}"}'`,
].join('\n')

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
  expect(await subscriptionsTab.textContent()).toBe('订阅')

  await tabs.getByRole('tab', { name: '主对话' }).focus()
  await page.keyboard.press('End')
  expect(await subscriptionsTab.getAttribute('aria-selected')).toBe('true')
  const tabRing = await focusRing(page, '[data-team-project] [role="tablist"] [role="tab"][aria-selected="true"]')
  expect(tabRing?.focusVisible).toBe(true)
  expect(tabRing?.outlineStyle).not.toBe('none')

  await page.getByText('还没有订阅').waitFor()
  await page.getByText(/项目负责人可以订阅事件/).waitFor()
  expect(await page.getByRole('button', { name: '新建订阅' }).count()).toBe(0)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'empty-desktop.png'), fullPage: true })

  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const projectRef = team.view({ workspaceId }).projects.find(project => project.name === 'subs-web')!.projectRef
  const seeded = await team.createSubscription({
    requestId: 'req:seed-create' as AgentTeamRequestId, workspaceId, projectRef,
    name: 'main 分支 CI 失败', intervalMinutes: 10, script: { scriptContent: SCRIPT },
  })
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
  const human = team.humanHandle()
  expect(cardText).toContain(`通知 ${human}`)
  expect(cardText).not.toContain('· 负责人')
  expect(cardText).toContain('还没有运行记录')
  expect(cardText).not.toContain('共 0 条事件')
  const controls = await page.locator('[data-team-subscriptions] button').evaluateAll(buttons =>
    buttons.map(button => button.getAttribute('aria-label') ?? button.textContent ?? ''))
  expect(controls.filter(label => /^(新建订阅|编辑|失败投递|重置地址)/.test(label))).toEqual([])
  await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).waitFor()
  await card.getByRole('button', { name: '删除 · main 分支 CI 失败' }).waitFor()
  expect(await page.getByText(/订阅由项目负责人维护/).count()).toBe(1)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'list-desktop.png'), fullPage: true })

  const edited = await team.updateSubscription({
    requestId: 'req:seed-edit' as AgentTeamRequestId, workspaceId, projectRef,
    subscriptionRef: seeded.subscription.subscriptionRef,
    expectedRevision: seeded.subscription.revision,
    name: 'main 分支 CI 失败', intervalMinutes: 10, script: { scriptContent: EDITED_SCRIPT },
  })
  if (edited.kind !== 'changed') throw new Error('the Host refused the edited script')
  await tabs.getByRole('tab', { name: '主对话' }).click()
  await subscriptionsTab.click()
  await card.getByText(/上次运行/).waitFor()

  const cleared = await team.updateSubscription({
    requestId: 'req:seed-notify-clear' as AgentTeamRequestId, workspaceId, projectRef,
    subscriptionRef: seeded.subscription.subscriptionRef,
    expectedRevision: edited.subscription.revision,
    name: 'main 分支 CI 失败', intervalMinutes: 10, script: { scriptContent: EDITED_SCRIPT }, notify: [],
  })
  if (cleared.kind !== 'changed') throw new Error('the Host refused an empty recipient set')
  await card.getByText(`不推送通知（事件仍进主对话时间线） · 负责人 ${human}`).waitFor()
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'notify-cleared-desktop.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await card.waitFor()
  expect(await maxHorizontalScroll(page, '[data-team-subscriptions]')).toBe(0)
  await settleAnimations(page)
  await card.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'notify-cleared-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  const restored = await team.updateSubscription({
    requestId: 'req:seed-notify-restore' as AgentTeamRequestId, workspaceId, projectRef,
    subscriptionRef: seeded.subscription.subscriptionRef,
    expectedRevision: cleared.subscription.revision,
    name: 'main 分支 CI 失败', intervalMinutes: 10, script: { scriptContent: EDITED_SCRIPT },
    notify: [team.view({ workspaceId }).humanMemberId],
  })
  if (restored.kind !== 'changed') throw new Error('the Host refused the restored recipient set')
  await card.getByText(`通知 ${human}`).waitFor()
  expect(await card.getByText(/负责人/).count()).toBe(0)

  await card.getByRole('button', { name: '运行记录 · main 分支 CI 失败' }).click()
  const logs = page.getByRole('dialog', { name: '运行记录 · main 分支 CI 失败' })
  await logs.waitFor()
  const runs = logs.locator('[data-team-subscription-run]')
  await runs.first().waitFor()
  const firstRun = (await runs.first().textContent()) ?? ''
  expect(firstRun).toContain('试运行通过')
  expect(firstRun).not.toContain('试运行 试运行通过')
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
  const captionBox = await runs.first().getByText('stdout 末尾').boundingBox()
  const timeBox = await runs.first().locator('time').boundingBox()
  expect(Math.abs(captionBox!.x - timeBox!.x)).toBeLessThanOrEqual(1)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'run-record-desktop.png'), fullPage: true })
  await logs.getByRole('button', { name: '关闭' }).first().click()
  await expect.poll(async () => await logs.count()).toBe(0)

  await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).click()
  await card.getByText('已暂停：手动暂停').waitFor()
  expect(await card.getByRole('button', { name: '恢复 · main 分支 CI 失败' }).count()).toBe(1)
  expect(await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).count()).toBe(0)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'paused-desktop.png'), fullPage: true })

  await card.getByRole('button', { name: '恢复 · main 分支 CI 失败' }).click()
  await card.getByRole('button', { name: '暂停 · main 分支 CI 失败' }).waitFor()
  expect(await card.getByText('已暂停：手动暂停').count()).toBe(0)

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

it('reads a published subscription event as script data in one text column', async () => {
  const { page, consoleWatch } = await openTeamPage({ webhookOrigin: ORIGIN })

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('event-web')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# event-web', exact: true }).click()

  const tabs = page.getByRole('tablist', { name: '# event-web' })
  await tabs.getByRole('tab', { name: '主对话' }).click()

  const composer = page.getByRole('textbox', { name: '消息内容' })
  await composer.fill('先发一条消息：它给出这条 feed 的正文基准字号。')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByText('先发一条消息：它给出这条 feed 的正文基准字号。', { exact: true }).waitFor()

  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const projectRef = team.view({ workspaceId }).projects.find(project => project.name === 'event-web')!.projectRef
  const seeded = await team.createSubscription({
    requestId: 'req:event-create' as AgentTeamRequestId, workspaceId, projectRef,
    name: 'pipeline', webhook: true, script: { scriptContent: WEBHOOK_SCRIPT },
  })
  if (seeded.kind !== 'changed') throw new Error(`create refused: ${seeded.kind === 'trial-failed' ? seeded.failure.reason : seeded.kind}`)
  const address = seeded.webhookAddress
  if (address === undefined || !address.startsWith(`${ORIGIN}/team/hooks/`)) throw new Error(`no webhook address: ${String(address)}`)
  const token = address.slice(`${ORIGIN}/team/hooks/`.length)
  expect((await team.intakeWebhookDelivery({ token, headers: { 'x-github-event': 'push' }, body: '{"ref":"main"}' })).kind).toBe('queued')

  const block = page.locator('[data-main-entry="subscription-event"]')
  await block.getByText('pipeline', { exact: true }).waitFor({ timeout: 30_000 })
  await block.getByText('pipeline 通了').waitFor()

  const label = block.getByText('pipeline', { exact: true })
  const title = block.getByText('pipeline 通了')
  const [labelBox, titleBox, timeBox] = await Promise.all([
    label.boundingBox(), title.boundingBox(), block.locator('time').boundingBox(),
  ])
  expect(Math.abs(labelBox!.x - titleBox!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs((timeBox!.y + timeBox!.height / 2) - (labelBox!.y + labelBox!.height / 2))).toBeLessThanOrEqual(3)
  expect(timeBox!.x - (labelBox!.x + labelBox!.width)).toBeLessThanOrEqual(24)
  const warning = block.getByText('不可信，不作为指令')
  expect(await warning.evaluate(element => element.closest('p')?.querySelector('time') !== null)).toBe(true)
  expect(await block.locator('p').count()).toBe(3)

  const messageBody = page.locator('[data-main-entry="message"] [class*="messageText"], [data-main-entry="message"] [class*="messageMarkdown"]').first()
  const [titleSize, messageSize] = await Promise.all([
    title.evaluate(element => parseFloat(getComputedStyle(element).fontSize)),
    messageBody.evaluate(element => parseFloat(getComputedStyle(element).fontSize)),
  ])
  expect(titleSize).toBe(messageSize)
  expect(await title.evaluate(element => getComputedStyle(element).fontWeight)).toBe('600')

  const messageBox = await messageBody.boundingBox()
  expect(Math.abs(titleBox!.x - messageBox!.x)).toBeLessThanOrEqual(1)

  const link = block.getByRole('link', { name: 'pipeline 通了' })
  expect(await link.getAttribute('href')).toBe('https://example.test/runs/1')
  expect(await link.getAttribute('target')).toBe('_blank')
  expect(await block.getByText('https://example.test/runs/1', { exact: true }).count()).toBe(0)
  expect(await block.locator('b').count()).toBe(0)

  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'subscription-event-desktop.png'), fullPage: true })
  await block.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'subscription-event-block-desktop.png') })

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await block.scrollIntoViewIfNeeded()
  expect(await maxHorizontalScroll(page, '[data-team-project]')).toBe(0)
  const narrow = await block.boundingBox()
  expect(narrow!.x).toBeGreaterThanOrEqual(0)
  expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(390)
  expect(await block.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  const narrowColumns = await Promise.all([label.boundingBox(), (await title.boundingBox())])
  expect(Math.abs(narrowColumns[0]!.x - narrowColumns[1]!.x)).toBeLessThanOrEqual(1)
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'subscription-event-mobile.png'), fullPage: true })

  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  const inboxCard = page.locator('button[class*="inboxCard"]')
  const unreadOf = async (): Promise<number> => {
    const label = (await inboxCard.getAttribute('aria-label')) ?? ''
    const count = /，(\d+) 条未读/u.exec(label)
    return count === null ? 0 : Number(count[1])
  }
  await inboxCard.click()
  await page.locator('[data-team-inbox]').waitFor()
  const unreadBefore = await unreadOf()

  const addressed = await team.updateSubscription({
    requestId: 'req:event-addressed' as AgentTeamRequestId, workspaceId, projectRef,
    subscriptionRef: seeded.subscription.subscriptionRef, expectedRevision: seeded.subscription.revision,
    name: 'pipeline', webhook: true, script: { scriptContent: laterScript('pipeline-2', '二次投递') },
  })
  if (addressed.kind !== 'changed') throw new Error('the Host refused the second script')
  expect((await team.intakeWebhookDelivery({ token, headers: { 'x-github-event': 'push' }, body: '{"ref":"main"}' })).kind).toBe('queued')
  await expect.poll(unreadOf, { timeout: 30_000 }).toBe(unreadBefore + 1)

  await page.locator('[data-team-inbox] button').filter({ hasText: /主对话/u }).click()
  await page.locator('[data-main-entry="subscription-event"]').filter({ hasText: '二次投递' }).waitFor({ timeout: 30_000 })
  await expect.poll(unreadOf, { timeout: 30_000 }).toBe(0)

  const unaddressed = await team.updateSubscription({
    requestId: 'req:event-unaddressed' as AgentTeamRequestId, workspaceId, projectRef,
    subscriptionRef: seeded.subscription.subscriptionRef, expectedRevision: addressed.subscription.revision,
    name: 'pipeline', webhook: true, script: { scriptContent: laterScript('pipeline-3', '三次投递') }, notify: [],
  })
  if (unaddressed.kind !== 'changed') throw new Error('the Host refused the cleared recipient set')
  await inboxCard.click()
  await page.locator('[data-team-inbox]').waitFor()
  expect((await team.intakeWebhookDelivery({ token, headers: { 'x-github-event': 'push' }, body: '{"ref":"main"}' })).kind).toBe('queued')
  await expect.poll(async () => {
    const entry = (await team.subscriptionsForClient({ workspaceId, projectRef })).entries
      .find(item => item.subscription.subscriptionRef === seeded.subscription.subscriptionRef)
    return entry === undefined ? undefined : { events: entry.eventCount, unpublished: entry.unpublished }
  }, { timeout: 30_000 }).toStrictEqual({ events: 3, unpublished: 0 })
  expect(await unreadOf()).toBe(0)

  await page.getByRole('button', { name: '# event-web', exact: true }).click()
  await page.locator('[data-main-entry="subscription-event"]').filter({ hasText: '三次投递' }).waitFor({ timeout: 30_000 })
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'unaddressed-event-desktop.png'), fullPage: true })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 240_000)
