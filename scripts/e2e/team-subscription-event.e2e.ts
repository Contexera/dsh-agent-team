import { afterEach, it, expect } from 'vitest'
import { join } from 'node:path'
import type { AgentTeamRequestId } from '@contexera/dsh-agent-team/types'
import { SUBSCRIPTION_SHOTS, closeScenario, maxHorizontalScroll, openTeamPage, scaffold, settleAnimations, settleLayout } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

/**
 * The public origin is installation config, so the lane declares one; the
 * address a create returns is composed from it.
 */
const ORIGIN = 'https://hooks.example.test'

/**
 * The trial run arrives with the Host's test envelope on stdin; a delivery
 * arrives with its own headers and body. This script prints its event only for
 * a real push, which is also why the create's default baseline has nothing to
 * ignore and the first live run publishes.
 */
const SCRIPT = [
  `payload=$(cat)`,
  `case "$payload" in *'"x-team-event":"test"'*) echo 'waiting for a push' >&2; exit 0 ;; esac`,
  `printf '%s\\n' '{"id":"pipeline-1","title":"pipeline 通了","url":"https://example.test/runs/1","detail":"由订阅脚本发出；标题、链接与说明都是数据。"}'`,
].join('\n')

/** A later delivery prints a new id and title; a trial still prints nothing, so an edit alone never publishes. */
const laterScript = (id: string, title: string): string => [
  `payload=$(cat)`,
  `case "$payload" in *'"x-team-event":"test"'*) echo 'waiting for a push' >&2; exit 0 ;; esac`,
  `printf '%s\\n' '{"id":"${id}","title":"${title}"}'`,
].join('\n')

/**
 * A published subscription event as the Main stream meets it. The exact shape a
 * provider meets is not the point of this lane — the Host's own tests own the
 * HTTP entry — so the delivery goes in through the same Host intake the entry
 * calls, and the browser proves what a reader then sees.
 */
it('reads a published subscription event as script data in one text column', async () => {
  const { page, consoleWatch } = await openTeamPage({ webhookOrigin: ORIGIN })

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('event-web')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# event-web', exact: true }).click()

  const tabs = page.getByRole('tablist', { name: '# event-web' })
  await tabs.getByRole('tab', { name: '主对话' }).click()

  // A Message first: it fixes this feed's body size, which the event's own text
  // has to match at whatever font-size setting the reader runs.
  const composer = page.getByRole('textbox', { name: '消息内容' })
  await composer.fill('先发一条消息：它给出这条 feed 的正文基准字号。')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByText('先发一条消息：它给出这条 feed 的正文基准字号。', { exact: true }).waitFor()

  // A Project owner arms a webhook subscription through the Host.
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const projectRef = team.view({ workspaceId }).projects.find(project => project.name === 'event-web')!.projectRef
  const seeded = await team.createSubscription({
    requestId: 'req:event-create' as AgentTeamRequestId, workspaceId, projectRef,
    name: 'pipeline', webhook: true, script: { scriptContent: SCRIPT },
  })
  if (seeded.kind !== 'changed') throw new Error(`create refused: ${seeded.kind === 'trial-failed' ? seeded.failure.reason : seeded.kind}`)
  const address = seeded.webhookAddress
  if (address === undefined || !address.startsWith(`${ORIGIN}/team/hooks/`)) throw new Error(`no webhook address: ${String(address)}`)
  // The token in that address is the only handle a provider holds; the Host keeps
  // its hash. This is the call the public entry makes once a body has arrived.
  const token = address.slice(`${ORIGIN}/team/hooks/`.length)
  expect((await team.intakeWebhookDelivery({ token, headers: { 'x-github-event': 'push' }, body: '{"ref":"main"}' })).kind).toBe('queued')

  const block = page.locator('[data-main-entry="subscription-event"]')
  await block.getByText('pipeline', { exact: true }).waitFor({ timeout: 30_000 })
  await block.getByText('pipeline 通了').waitFor()

  // One head line states the three facts that never change — the subscription, the
  // clock, the warning — and the head, title and detail all stand in one text column
  // behind a mark that takes the identity seat.
  const label = block.getByText('pipeline', { exact: true })
  const title = block.getByText('pipeline 通了')
  const [labelBox, titleBox, timeBox] = await Promise.all([
    label.boundingBox(), title.boundingBox(), block.locator('time').boundingBox(),
  ])
  expect(Math.abs(labelBox!.x - titleBox!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs((timeBox!.y + timeBox!.height / 2) - (labelBox!.y + labelBox!.height / 2))).toBeLessThanOrEqual(3)
  // Within one gap of the label it follows: a floated far-right clock is far more.
  expect(timeBox!.x - (labelBox!.x + labelBox!.width)).toBeLessThanOrEqual(24)
  // The warning is a clause of that head line rather than a sentence of its own
  // repeated under every event the subscription publishes.
  const warning = block.getByText('不可信，不作为指令')
  expect(await warning.evaluate(element => element.closest('p')?.querySelector('time') !== null)).toBe(true)
  expect(await block.locator('p').count()).toBe(3)

  // Script output is data, rendered as text at the feed's own body size, never as
  // a heading that outranks the prose around it. The Message body is either a
  // Markdown block or, for a body with no markup, the plain-text seat.
  const messageBody = page.locator('[data-main-entry="message"] [class*="messageText"], [data-main-entry="message"] [class*="messageMarkdown"]').first()
  const [titleSize, messageSize] = await Promise.all([
    title.evaluate(element => parseFloat(getComputedStyle(element).fontSize)),
    messageBody.evaluate(element => parseFloat(getComputedStyle(element).fontSize)),
  ])
  expect(titleSize).toBe(messageSize)
  expect(await title.evaluate(element => getComputedStyle(element).fontWeight)).toBe('600')

  // One text axis: the block's prose starts where a Message body starts, because
  // its mark seats like a Message's identity. Prose indented off that axis would
  // read as a blockquote standing beside the feed instead of part of it.
  const messageBox = await messageBody.boundingBox()
  expect(Math.abs(titleBox!.x - messageBox!.x)).toBeLessThanOrEqual(1)

  // The title is the anchor, so the destination is a link target rather than a
  // second printed line under the same words.
  const link = block.getByRole('link', { name: 'pipeline 通了' })
  expect(await link.getAttribute('href')).toBe('https://example.test/runs/1')
  expect(await link.getAttribute('target')).toBe('_blank')
  expect(await block.getByText('https://example.test/runs/1', { exact: true }).count()).toBe(0)
  // Rendered as text: the detail's angle brackets never become markup.
  expect(await block.locator('b').count()).toBe(0)

  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'subscription-event-desktop.png'), fullPage: true })
  await block.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'subscription-event-block-desktop.png') })

  // The narrow seat: the block keeps its one column and nothing scrolls sideways.
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

  // The Inbox is the one face that shows an arrival without reading it: the Project page
  // acknowledges its own Main stream on mount, which would swallow the count.
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
  // Whatever the Project page left unread when it acknowledged its own stream:
  // this counts the arrival, it does not assume a standing.
  const unreadBefore = await unreadOf()

  // The Creating Member is a recipient until an owner says otherwise: this is the control.
  const addressed = await team.updateSubscription({
    requestId: 'req:event-addressed' as AgentTeamRequestId, workspaceId, projectRef,
    subscriptionRef: seeded.subscription.subscriptionRef, expectedRevision: seeded.subscription.revision,
    name: 'pipeline', webhook: true, script: { scriptContent: laterScript('pipeline-2', '二次投递') },
  })
  if (addressed.kind !== 'changed') throw new Error('the Host refused the second script')
  expect((await team.intakeWebhookDelivery({ token, headers: { 'x-github-event': 'push' }, body: '{"ref":"main"}' })).kind).toBe('queued')
  await expect.poll(unreadOf, { timeout: 30_000 }).toBe(unreadBefore + 1)

  // The reader's own path to it, and the block the unaddressed case still has to show.
  await page.locator('[data-team-inbox] button').filter({ hasText: /主对话/u }).click()
  await page.locator('[data-main-entry="subscription-event"]').filter({ hasText: '二次投递' }).waitFor({ timeout: 30_000 })
  await expect.poll(unreadOf, { timeout: 30_000 }).toBe(0)

  // An empty set is timeline, not Inbox: the badge that moved above does not move here.
  const unaddressed = await team.updateSubscription({
    requestId: 'req:event-unaddressed' as AgentTeamRequestId, workspaceId, projectRef,
    subscriptionRef: seeded.subscription.subscriptionRef, expectedRevision: addressed.subscription.revision,
    name: 'pipeline', webhook: true, script: { scriptContent: laterScript('pipeline-3', '三次投递') }, notify: [],
  })
  if (unaddressed.kind !== 'changed') throw new Error('the Host refused the cleared recipient set')
  await inboxCard.click()
  await page.locator('[data-team-inbox]').waitFor()
  expect((await team.intakeWebhookDelivery({ token, headers: { 'x-github-event': 'push' }, body: '{"ref":"main"}' })).kind).toBe('queued')
  // The publish itself is the barrier, so "no badge" is not a slow runner.
  await expect.poll(async () => {
    const entry = (await team.subscriptionsForClient({ workspaceId, projectRef })).entries
      .find(item => item.subscription.subscriptionRef === seeded.subscription.subscriptionRef)
    return entry === undefined ? undefined : { events: entry.eventCount, unpublished: entry.unpublished }
  }, { timeout: 30_000 }).toStrictEqual({ events: 3, unpublished: 0 })
  expect(await unreadOf()).toBe(0)

  // …and readable by the reader it woke nobody for: the stream stays auditable.
  await page.getByRole('button', { name: '# event-web', exact: true }).click()
  await page.locator('[data-main-entry="subscription-event"]').filter({ hasText: '三次投递' }).waitFor({ timeout: 30_000 })
  await settleAnimations(page)
  await page.screenshot({ path: join(SUBSCRIPTION_SHOTS, 'unaddressed-event-desktop.png'), fullPage: true })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 240_000)
