import { afterEach, it, expect } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { CHROME, HOME, STAGED_BUNDLE, UI09_SHOTS, closeScenario, connectFreshWorkspaceZh, getDshRuntimeVersion, installLocalBundle, launchWebScaffold, openSettings, openTeamPage, settleLayout, watchConsole } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })


it('states the local environment check on the Team page', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true })

  await openSettings(page)
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const block = panel.locator('[data-environment]')
  await block.waitFor()
  await expect.poll(async () => await block.getAttribute('data-environment')).toBe('ok')
  // The running version is stated as a fact in words: no raw semver range, and
  // the certified line stays out of the `ok` tier.
  expect(await block.textContent()).toContain('在支持范围内')
  expect(await block.textContent()).toContain(`正在运行的 DSH ${getDshRuntimeVersion()} 在我们声明的支持范围内。`)
  expect(await block.textContent()).not.toContain('>=0.1.7-rc.1')
  expect(await block.textContent()).not.toContain('我们实测认证的组合')
  expect(await block.locator('a').count()).toBe(0)
  // The bundle version resolves from the staged install and the DSH version from
  // the app-boot package the running host ships.
  expect(await block.textContent()).not.toContain('unknown')
  await page.screenshot({ path: join(UI09_SHOTS, 'environment-check-ok.png'), fullPage: true })

  // At 390×844 the block must stay inside the panel and add no horizontal
  // overflow.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'environment-check-narrow.png'), fullPage: true })
  const narrow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  const blockBox = (await block.boundingBox())!
  const panelBox = (await panel.boundingBox())!
  expect(blockBox.x + blockBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
import { join } from 'node:path'
