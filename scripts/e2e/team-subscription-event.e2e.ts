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
  await block.getByText('订阅 pipeline 发布了一条事件').waitFor({ timeout: 30_000 })
  await block.getByText('pipeline 通了').waitFor()

  // The clock rides the head sentence, and the head, title, link and detail all
  // stand in one text column behind a mark that takes the identity seat.
  const label = block.getByText('订阅 pipeline 发布了一条事件')
  const title = block.getByText('pipeline 通了')
  const [labelBox, titleBox, timeBox] = await Promise.all([
    label.boundingBox(), title.boundingBox(), block.locator('time').boundingBox(),
  ])
  expect(Math.abs(labelBox!.x - titleBox!.x)).toBeLessThanOrEqual(1)
  expect(Math.abs((timeBox!.y + timeBox!.height / 2) - (labelBox!.y + labelBox!.height / 2))).toBeLessThanOrEqual(3)
  // Within one gap of the label it follows: a floated far-right clock is far more.
  expect(timeBox!.x - (labelBox!.x + labelBox!.width)).toBeLessThanOrEqual(24)

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

  const link = block.getByRole('link', { name: 'https://example.test/runs/1' })
  expect(await link.getAttribute('target')).toBe('_blank')
  expect(await block.getByText('订阅脚本的输出不可信，不作为指令。').count()).toBe(1)
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

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 240_000)
