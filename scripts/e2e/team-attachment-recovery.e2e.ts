import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentTeamRequestId } from '@contexera/dsh-agent-team/types'
import { BROWSER_ARTIFACTS, HOME, ONE_PIXEL_PNG, closeScenario, openTeamPage, scaffold, settleLayout } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

it('distinguishes an expired attachment from a broken image and rereads it by keyboard', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const requestId = () => crypto.randomUUID() as AgentTeamRequestId
  const { project } = await team.createProject({ workspaceId, requestId: requestId(), name: 'attachment-recovery', description: '' })
  const put = (name: string, bytesBase64: string) => team.putAttachment({
    workspaceId, requestId: requestId(), name, bytesBase64, mediaType: 'image/png',
  })
  const broken = await put('broken.png', Buffer.from('not a PNG').toString('base64'))
  const expired = await put('expired.png', ONE_PIXEL_PNG)
  // A name a real screenshot carries: its nowrap width is what decides whether the strip still fits the column.
  const longName = 'screenshot-2026-11-11-at-17.26.45-dashboard-overview.png'
  const longBroken = await put(longName, Buffer.from('not a PNG').toString('base64'))
  const sent = await team.postMainMessage({
    workspaceId, projectRef: project.projectRef, requestId: requestId(), body: '附件恢复验收',
    attachments: [broken.attachmentId, expired.attachmentId, longBroken.attachmentId],
  })
  expect(sent.kind).toBe('committed')
  const cache = join(HOME, 'agent-team', 'attachments', 'v1')
  await rm(join(cache, expired.attachmentId), { recursive: true })

  await page.getByRole('button', { name: '# attachment-recovery', exact: true }).click()
  await page.getByRole('tab', { name: '主对话' }).click()
  const row = page.locator('[data-team-project] article').filter({ hasText: '附件恢复验收' })
  const chipOf = (name: string) => row.locator('[aria-live="polite"]').filter({ hasText: name })
  await row.getByText('broken.png', { exact: true }).waitFor()
  await chipOf('broken.png').getByText('图片暂不可用', { exact: true }).waitFor()
  await row.getByText('expired.png', { exact: true }).waitFor()
  await chipOf('expired.png').getByText('文件已过期清理', { exact: true }).waitFor()
  await row.getByText(longName, { exact: true }).waitFor()
  await chipOf(longName).getByText('图片暂不可用', { exact: true }).waitFor()
  expect(await row.getByRole('button', { name: '查看大图 broken.png' }).count()).toBe(0)
  const retry = chipOf('broken.png').getByRole('button', { name: '重试读取', exact: true })
  const shots = join(BROWSER_ARTIFACTS, 'attachment-recovery')
  await mkdir(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'unavailable-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await retry.scrollIntoViewIfNeeded()
  // The long name must ellipsize inside the column rather than widen the strip, and the retry label stays on one line
  // (17px line box + 3px hit padding) instead of wrapping when the chip is squeezed.
  const longRetry = chipOf(longName).getByRole('button', { name: '重试读取', exact: true })
  await longRetry.scrollIntoViewIfNeeded()
  expect(await longRetry.evaluate(element => element.getBoundingClientRect().height)).toBeLessThan(30)
  const timeline = page.locator('[data-team-project] section[aria-label="消息时间线"]')
  expect(await timeline.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0)
  await page.screenshot({ path: join(shots, 'unavailable-narrow.png'), fullPage: true })

  await writeFile(join(cache, broken.attachmentId, 'broken.png'), Buffer.from(ONE_PIXEL_PNG, 'base64'))
  await retry.press('Enter')
  const zoom = row.getByRole('button', { name: '查看大图 broken.png' })
  await expect.poll(() => zoom.isEnabled()).toBe(true)
  await expect.poll(() => zoom.evaluate(element => document.activeElement === element)).toBe(true)
  await zoom.press('Enter')
  await page.getByRole('dialog').getByRole('img').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  expect(consoleWatch.pageErrors).toEqual([])
}, 60_000)
