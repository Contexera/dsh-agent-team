import { afterEach, it, expect } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { CHROME, HOME, STAGED_BUNDLE, UI02_SHOTS, closeScenario, connectFreshWorkspaceZh, installLocalBundle, launchWebScaffold, openTeamPage, scaffold, settleLayout, watchConsole } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })


it('opens a taskless thread from its ref chip in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage({ clearArtifacts: false })
  await page.getByRole('button', { name: '新建项目' }).click()
  const projectDialog = page.getByRole('dialog', { name: '新建项目' })
  await projectDialog.getByLabel('名称').fill('ref-repro')
  await projectDialog.getByLabel('说明').fill('thread ref chips')
  await projectDialog.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# ref-repro', exact: true }).click()
  await page.getByRole('heading', { name: '# ref-repro', exact: true }).waitFor()
  const projectComposer = page.getByRole('textbox', { name: '消息内容' })
  const workspaceId = scaffold.ctx.workspaceRegistry.list()[0]!.id
  const refProject = scaffold.ctx.agentTeam.view({ workspaceId }).projects.find((entry: { name: string }) => entry.name === 'ref-repro')!
  // Rules version 2 has no top-level send: the Project page's composer posts to
  // the Main stream, so the cited Thread is started through the Host.
  const started = await scaffold.ctx.agentTeam.startThread({ requestId: 'e2e-thread-ref' as never, workspaceId,
    projectRef: refProject.projectRef, kind: 'discussion', body: 'ALPHA-ROOT-MARKER alpha discussion opens here' })
  const alphaRef = (started as { thread: { threadRef: string } }).thread.threadRef
  // The abbreviated 8-hex spelling: resolution, not spelling, decides
  // linkability.
  const alphaShort = `thread:${(alphaRef.slice('thread:'.length) as string).replaceAll('-', '').slice(0, 8).toLowerCase()}`
  await projectComposer.fill(`BETA-ROOT-MARKER citing ${alphaShort} for the chip`)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const betaArticle = page.locator('[data-team-project] article').filter({ hasText: 'BETA-ROOT-MARKER' })
  await betaArticle.waitFor()
  const chip = betaArticle.locator(`button[title="${alphaShort}"]`)
  await chip.waitFor()
  // Chip titles cap at 40 characters, so the 43-char anchor renders truncated;
  // navigation still proves identity.
  await expect.poll(() => chip.textContent()).toMatch(/ALPHA-ROOT-MARKER alpha discussion open…/)
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip.png'), fullPage: true })
  await chip.click()
  // Separate "never navigated" from "navigated but failed to render": the
  // persisted snapshot answers the first without waiting on the second. A
  // taskless discussion is a face of its Project, so the destination is the
  // side panel and never the full Thread page.
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { discussionRef?: string }).discussionRef), { timeout: 10_000 }).toBe(alphaRef)
  await page.locator(`[data-team-panel="${alphaRef}"]`).waitFor({ timeout: 20_000 })
  await page.locator(`main[data-team-thread="${alphaRef}"]`).waitFor({ state: 'detached', timeout: 5_000 })
  // Arrival at the cited discussion: the panel carries the full ref, and the
  // snapshot agrees without claiming a Thread page.
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { discussionRef?: string; threadRef?: string }).discussionRef)).toBe(alphaRef)
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { threadRef?: string }).threadRef)).toBeUndefined()
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip-opened.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip-opened-narrow.png'), fullPage: true })
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
import { join } from 'node:path'
