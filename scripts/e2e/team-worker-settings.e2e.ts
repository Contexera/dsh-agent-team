import { afterEach, it, expect } from 'vitest'
import z from '@deepseek-ai/schemastery'
import type { Locator, Page } from 'playwright'
import { UI09_SHOTS, acknowledgeReloadConnectionLoss, closeScenario, maxHorizontalScroll, openSettings, openTeamPage, scaffold, settleLayout } from './__external-agent-team-support.ts'
import { join } from 'node:path'

afterEach(async () => { await closeScenario() })

/** The switch that turns the whole experimental group on. */
const MASTER = '允许从成员会话派出 Worker'
/** The save the shared settings form renders; the identity rows above carry their own. */
const SAVE = '保存'

/** Open the Team settings page and return its dialog plus the Worker group inside it. */
async function openWorkerGroup(page: Page) {
  await openSettings(page)
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const group = panel.locator('[data-worker-settings]')
  await group.waitFor()
  return { panel, group }
}

/** The group's disclosure, whose name carries the title and the summary after it. */
function disclosure(group: Locator): Locator {
  return group.getByRole('button', { name: /Worker 委派/ })
}

/** Open the group; closed, it is one summary line and none of its controls. */
async function expand(group: Locator): Promise<void> {
  const toggle = disclosure(group)
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
  await expect.poll(async () => await toggle.getAttribute('aria-expanded')).toBe('true')
}

it('configures the Worker delegation group on the Team settings page', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true })
  const hostView = scaffold!.ctx.settings.describe({ redactSecrets: true }).find(view => view.ns === 'contexera-agent-team-host')
  expect(hostView).toBeDefined()
  const wireView = JSON.parse(JSON.stringify(hostView))
  expect(() => new z(wireView.schema)(wireView.value)).not.toThrow()

  const { panel, group } = await openWorkerGroup(page)
  // Closed, the group costs one line and says what it is set to.
  const summary = disclosure(group)
  expect(await summary.getAttribute('aria-expanded')).toBe('false')
  expect(await summary.textContent()).toContain('已关闭')
  expect(await group.getByRole('switch', { name: MASTER }).count()).toBe(0)
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'worker-settings-collapsed.png') })

  await expand(group)
  const master = group.getByRole('switch', { name: MASTER })
  await expect.poll(async () => await master.getAttribute('aria-checked')).toBe('false')
  // The one fact the switch turns on stands before the switch: two local CLIs with full permissions, off by default.
  const copy = await group.textContent()
  expect(copy).toContain('完整权限运行')
  expect(copy).toContain('默认关闭')

  // The picker's label stays one line; its note takes the line under the control.
  const picker = await page.evaluate(() => {
    const select = document.querySelector('[data-worker-settings] select') as HTMLSelectElement
    const row = select.parentElement as HTMLElement
    const label = row.querySelector('label') as HTMLElement
    const note = row.querySelector('p') as HTMLElement | null
    return {
      labelHeight: label.getBoundingClientRect().height,
      labelLines: label.getClientRects().length,
      noteTop: note?.getBoundingClientRect().top ?? null,
      selectBottom: select.getBoundingClientRect().bottom,
    }
  })
  expect(picker.labelLines).toBe(1)
  expect(picker.labelHeight).toBeLessThanOrEqual(24)
  expect(picker.noteTop).not.toBeNull()
  expect(picker.noteTop!).toBeGreaterThanOrEqual(picker.selectBottom - 1)

  // A group that is off cannot be configured: its engines read as locked, not as switches nothing honours.
  const codex = group.locator('[data-worker-engine="codex"]')
  const codexSwitch = codex.getByRole('switch')
  expect(await codexSwitch.isDisabled()).toBe(true)
  expect(await codex.getByLabel('Codex 的可执行路径').isDisabled()).toBe(true)
  // Full permissions are the default and no longer a field: narrowing stays a row the operator writes.
  expect(await group.getByLabel('沙箱策略').count()).toBe(0)

  await master.click()
  await expect.poll(async () => await codexSwitch.isDisabled()).toBe(false)
  await codexSwitch.click()
  await expect.poll(async () => await codexSwitch.getAttribute('aria-checked')).toBe('true')
  // This deployment's codex sits outside the Host's PATH, which is why the path is a setting.
  await codex.getByLabel('Codex 的可执行路径').fill('/data/bin/codex')

  const save = group.getByRole('button', { name: SAVE })
  await save.click()
  // The form goes clean only when the Host accepted the write and the readback carries it.
  await expect.poll(async () => await save.isDisabled(), { timeout: 20_000 }).toBe(true)
  await settleLayout(page)
  // The hierarchy is drawn, not ruled: a fill under the switch, no hairline inside the group.
  // Controls keep the shipped field's height, type, fill and left edge.
  const geometry = await page.evaluate(() => {
    const group = document.querySelector('[data-worker-settings]') as HTMLElement
    const codex = group.querySelector('[data-worker-engine="codex"]') as HTMLElement
    const master = group.querySelector('button[role="switch"]') as HTMLElement
    const row = master.parentElement!.parentElement as HTMLElement
    const title = row.children[0].children[0] as HTMLElement
    const path = codex.querySelector('input') as HTMLElement
    const select = group.querySelector('select') as HTMLSelectElement
    const label = codex.querySelector('label') as HTMLElement
    const panel = codex.parentElement as HTMLElement
    const shipped = document.querySelector('#plugin-config-team-member-compaction-tokens') as HTMLElement
    // A separator spans the width (top or bottom set, sides unset); a control's own hairline has all four sides.
    const separators = [...group.querySelectorAll('*')].filter((node) => {
      const style = getComputedStyle(node)
      const across = Number.parseFloat(style.borderTopWidth) > 0 || Number.parseFloat(style.borderBottomWidth) > 0
      return across && Number.parseFloat(style.borderLeftWidth) === 0 && Number.parseFloat(style.borderRightWidth) === 0
    }).map(node => node.className)
    return {
      titleFont: getComputedStyle(title).fontSize,
      titleLine: getComputedStyle(title).lineHeight,
      labelFont: getComputedStyle(label).fontSize,
      labelWeight: getComputedStyle(label).fontWeight,
      pathHeight: path.getBoundingClientRect().height,
      selectHeight: select.getBoundingClientRect().height,
      shippedHeight: shipped.getBoundingClientRect().height,
      pathFont: getComputedStyle(path).fontSize,
      shippedFont: getComputedStyle(shipped).fontSize,
      pathFill: getComputedStyle(path).backgroundColor,
      shippedFill: getComputedStyle(shipped).backgroundColor,
      labelLeft: label.getBoundingClientRect().left,
      shippedLabelLeft: (document.querySelector('label[for="plugin-config-team-member-compaction-tokens"]') as HTMLElement).getBoundingClientRect().left,
      controlsRight: master.getBoundingClientRect().right,
      groupRight: group.getBoundingClientRect().right,
      panelFill: getComputedStyle(panel).backgroundColor,
      groupFill: getComputedStyle(group).backgroundColor,
      panelIndent: panel.getBoundingClientRect().left - group.getBoundingClientRect().left,
      separators,
    }
  })
  expect(geometry.titleFont).toBe('14px')
  expect(geometry.titleLine).toBe('22px')
  expect(geometry.labelFont).toBe('13px')
  expect(geometry.labelWeight).toBe('500')
  expect(geometry.pathHeight).toBe(geometry.shippedHeight)
  expect(geometry.selectHeight).toBe(geometry.shippedHeight)
  expect(geometry.pathFont).toBe(geometry.shippedFont)
  expect(geometry.pathFill).toBe(geometry.shippedFill)
  // No rule inside the group at any depth: the panel's fill says what the switch contains.
  expect(geometry.separators).toEqual([])
  expect(geometry.panelFill).not.toBe(geometry.groupFill)
  expect(geometry.panelIndent).toBe(0)
  // The group's labels start where the shipped field's does; the switch ends on the group's right edge.
  expect(geometry.labelLeft).toBe(geometry.shippedLabelLeft)
  expect(Math.abs(geometry.controlsRight - geometry.groupRight)).toBeLessThanOrEqual(1)
  // The dialog scrolls internally, so a viewport shot is the evidence; scroll the summary to its top.
  await group.evaluate(element => { element.scrollIntoView({ block: 'start' }) })
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'worker-settings-desktop.png') })

  // A reload is the only evidence that the row, not this page, holds the switch; the closed summary is a projection.
  let warningStart = consoleWatch.warnings.length
  await page.reload()
  await settleLayout(page)
  acknowledgeReloadConnectionLoss(consoleWatch, warningStart)
  const reopened = await openWorkerGroup(page)
  const stored = reopened.group
  expect(await disclosure(stored).textContent()).toContain('已开启 · Codex')
  await expand(stored)
  const storedCodex = stored.locator('[data-worker-engine="codex"]')
  await expect.poll(async () => await stored.getByRole('switch', { name: MASTER }).getAttribute('aria-checked')).toBe('true')
  expect(await storedCodex.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  expect(await storedCodex.getByLabel('Codex 的可执行路径').inputValue()).toBe('/data/bin/codex')

  // 390×844: the shell keeps its 188px rail, so the group gets a narrow column that may not overflow.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  // A ~106px column: the shipped narrow rule stacks each row's copy over its control.
  const stacked = await page.evaluate(() => {
    const group = document.querySelector('[data-worker-settings]') as HTMLElement
    const master = group.querySelector('button[role="switch"]') as HTMLElement
    const row = master.parentElement!.parentElement as HTMLElement
    const title = row.children[0].children[0] as HTMLElement
    return {
      switchTop: master.getBoundingClientRect().top,
      titleBottom: title.getBoundingClientRect().bottom,
      switchRight: master.getBoundingClientRect().right,
      groupRight: group.getBoundingClientRect().right,
    }
  })
  expect(stacked.switchTop).toBeGreaterThanOrEqual(stacked.titleBottom - 1)
  expect(stacked.switchRight).toBeLessThanOrEqual(stacked.groupRight + 1)
  // The one picker left has to keep its chosen value readable in that column.
  const legible = await page.evaluate(() => {
    const selects = [...document.querySelectorAll('[data-worker-settings] select')] as HTMLSelectElement[]
    const canvas = document.createElement('canvas').getContext('2d')!
    return selects.map((select) => {
      const style = getComputedStyle(select)
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const widest = [...select.options].reduce((max, option) => Math.max(max, canvas.measureText(option.textContent ?? '').width), 0)
      const available = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      return { widest, available }
    })
  })
  expect(legible.length).toBe(1)
  for (const picker of legible) expect(picker.widest).toBeLessThanOrEqual(picker.available)
  await stored.scrollIntoViewIfNeeded()
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'worker-settings-narrow.png') })
  const narrow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  expect(await maxHorizontalScroll(page, '[data-worker-settings]')).toBe(0)
  const groupBox = (await stored.boundingBox())!
  const panelBox = (await reopened.panel.boundingBox())!
  expect(groupBox.x + groupBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  // Claude is a first-class engine: it can be enabled, given its own executable,
  // and made the default a delegation names when it names no engine.
  const storedClaude = stored.locator('[data-worker-engine="claude"]')
  await storedClaude.getByRole('switch').click()
  await expect.poll(async () => await storedClaude.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  await storedClaude.getByLabel('Claude 的可执行路径').fill('/data/bin/claude')
  await stored.locator('select').selectOption('claude')
  // Claude alone, so the closed summary names the engine the row now defaults to.
  await storedCodex.getByRole('switch').click()
  await expect.poll(async () => await storedCodex.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  await stored.getByRole('button', { name: SAVE }).click()
  await expect.poll(async () => await stored.getByRole('button', { name: SAVE }).isDisabled(), { timeout: 20_000 }).toBe(true)
  warningStart = consoleWatch.warnings.length
  await page.reload()
  await settleLayout(page)
  acknowledgeReloadConnectionLoss(consoleWatch, warningStart)
  const switched = await openWorkerGroup(page)
  expect(await disclosure(switched.group).textContent()).toContain('已开启 · Claude')
  await expand(switched.group)
  const switchedClaude = switched.group.locator('[data-worker-engine="claude"]')
  expect(await switched.group.locator('select').inputValue()).toBe('claude')
  expect(await switchedClaude.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  expect(await switchedClaude.getByLabel('Claude 的可执行路径').inputValue()).toBe('/data/bin/claude')
  // The evidence shows the enabled engine row itself, not only the closed summary.
  await switchedClaude.scrollIntoViewIfNeeded()
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'worker-settings-claude.png') })

  // Later lanes share this profile, so put the row back and prove the revert reached the Host.
  await switched.group.locator('[data-worker-engine="codex"]').getByLabel('Codex 的可执行路径').fill('')
  await switchedClaude.getByLabel('Claude 的可执行路径').fill('')
  await switchedClaude.getByRole('switch').click()
  await switched.group.locator('select').selectOption('codex')
  await switched.group.getByRole('switch', { name: MASTER }).click()
  await switched.group.getByRole('button', { name: SAVE }).click()
  await expect.poll(async () => await switched.group.getByRole('button', { name: SAVE }).isDisabled(), { timeout: 20_000 }).toBe(true)
  warningStart = consoleWatch.warnings.length
  await page.reload()
  await settleLayout(page)
  acknowledgeReloadConnectionLoss(consoleWatch, warningStart)
  const reverted = await openWorkerGroup(page)
  await expect.poll(async () => await disclosure(reverted.group).textContent()).toContain('已关闭')
  await expand(reverted.group)
  const revertedCodex = reverted.group.locator('[data-worker-engine="codex"]')
  const revertedClaude = reverted.group.locator('[data-worker-engine="claude"]')
  expect(await revertedCodex.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  expect(await revertedCodex.getByLabel('Codex 的可执行路径').inputValue()).toBe('')
  expect(await revertedClaude.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  expect(await revertedClaude.getByLabel('Claude 的可执行路径').inputValue()).toBe('')
  expect(await reverted.group.locator('select').inputValue()).toBe('codex')

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 240_000)
