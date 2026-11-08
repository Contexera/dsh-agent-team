import { afterEach, it, expect } from 'vitest'
import type { Page } from 'playwright'
import { UI09_SHOTS, acknowledgeReloadConnectionLoss, closeScenario, maxHorizontalScroll, openSettings, openTeamPage, settleLayout } from './__external-agent-team-support.ts'
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

it('configures the Worker delegation group on the Team settings page', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true })

  const { panel, group } = await openWorkerGroup(page)
  const master = group.getByRole('switch', { name: MASTER })
  await expect.poll(async () => await master.getAttribute('aria-checked')).toBe('false')
  // The one fact the switch turns on is on the page before the switch: a local
  // CLI running under its own native permissions, off until the operator says so.
  const copy = await group.textContent()
  expect(copy).toContain('按下面配置的原生权限执行')
  expect(copy).toContain('默认关闭')

  // A group that is off cannot be configured; the engines read as locked rather
  // than as switches that would write a config nothing honours.
  const codex = group.locator('[data-worker-engine="codex"]')
  const codexSwitch = codex.getByRole('switch')
  expect(await codexSwitch.isDisabled()).toBe(true)
  expect(await codex.getByLabel('Codex 的可执行路径').isDisabled()).toBe(true)
  expect(await codex.getByLabel('沙箱策略').isDisabled()).toBe(true)

  await master.click()
  await expect.poll(async () => await codexSwitch.isDisabled()).toBe(false)
  await codexSwitch.click()
  await expect.poll(async () => await codexSwitch.getAttribute('aria-checked')).toBe('true')
  // This deployment's codex is installed outside the Host's PATH, which is why
  // the path is a setting at all; the sandbox is the one flag Codex exposes.
  await codex.getByLabel('Codex 的可执行路径').fill('/data/bin/codex')
  await codex.getByLabel('沙箱策略').selectOption('read-only')

  const save = group.getByRole('button', { name: SAVE })
  await save.click()
  // The form goes clean only when the Host accepted the write and the readback
  // carries it; a refusal leaves the drafts staged and the button live.
  await expect.poll(async () => await save.isDisabled(), { timeout: 20_000 }).toBe(true)
  await settleLayout(page)
  // Read the geometry the way the eye would judge it: the path and both pickers
  // at the shipped field's own height, that field's 13px/500 label, the identity
  // rows' 14px/22px title, and one hairline between blocks (never under the
  // group's own switch row).
  const geometry = await page.evaluate(() => {
    const group = document.querySelector('[data-worker-settings]') as HTMLElement
    const codex = group.querySelector('[data-worker-engine="codex"]') as HTMLElement
    const master = group.querySelector('button[role="switch"]') as HTMLElement
    const row = master.parentElement!.parentElement as HTMLElement
    const title = row.children[0].children[0] as HTMLElement
    const path = codex.querySelector('input') as HTMLElement
    const select = codex.querySelector('select') as HTMLSelectElement
    const label = codex.querySelector('label') as HTMLElement
    const blocks = [...codex.children] as HTMLElement[]
    // The compaction field above this group is the shipped field this page
    // already draws; both of this group's controls have to match it.
    const shipped = document.querySelector('#plugin-config-team-member-compaction-tokens') as HTMLElement
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
      rowBottom: getComputedStyle(blocks[0]!).borderBottomWidth,
      separators: blocks.map(block => getComputedStyle(block).borderTopWidth),
      headingLeft: (group.querySelector('h3') as HTMLElement).getBoundingClientRect().left,
      groupLeft: group.getBoundingClientRect().left,
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
  expect(geometry.rowBottom).toBe('0px')
  expect(geometry.separators).toEqual(['0px', '1px', '1px'])
  expect(geometry.headingLeft).toBe(geometry.groupLeft)
  // One column: this group's labels start where the shipped field's does, and
  // the switch ends on the group's own right edge.
  expect(geometry.labelLeft).toBe(geometry.shippedLabelLeft)
  expect(Math.abs(geometry.controlsRight - geometry.groupRight)).toBeLessThanOrEqual(1)
  // The dialog scrolls internally, so a viewport shot is what a reviewer can
  // actually see; put the group's heading at the top of that scroller, or the
  // sentence the switch turns on is above the frame.
  await group.evaluate(element => { element.scrollIntoView({ block: 'start' }) })
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'worker-settings-desktop.png') })

  // A reload is the only evidence that the row, not this page, holds the switch:
  // the section stages nothing across a mount.
  let warningStart = consoleWatch.warnings.length
  await page.reload()
  await settleLayout(page)
  acknowledgeReloadConnectionLoss(consoleWatch, warningStart)
  const reopened = await openWorkerGroup(page)
  const stored = reopened.group
  const storedCodex = stored.locator('[data-worker-engine="codex"]')
  await expect.poll(async () => await stored.getByRole('switch', { name: MASTER }).getAttribute('aria-checked')).toBe('true')
  expect(await storedCodex.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  expect(await storedCodex.getByLabel('Codex 的可执行路径').inputValue()).toBe('/data/bin/codex')
  expect(await storedCodex.getByLabel('沙箱策略').inputValue()).toBe('read-only')

  // 390×844: the settings shell keeps its 188px rail, so the group gets a narrow
  // column. Nothing may overflow it.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  // A ~106px column: the shipped narrow rule stacks each row's copy over its
  // control instead of squeezing them side by side.
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
  // A ~106px column leaves the pickers ~60px of text room. The widest spelling a
  // picker can show has to fit there, or the chosen value is unreadable at the
  // one width the release gate promises.
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
  expect(legible.length).toBe(2)
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

  // Every lane after this one shares the run's profile, so put the row back and
  // prove the revert reached the Host too.
  await storedCodex.getByLabel('Codex 的可执行路径').fill('')
  await storedCodex.getByLabel('沙箱策略').selectOption('workspace-write')
  await storedCodex.getByRole('switch').click()
  await stored.getByRole('switch', { name: MASTER }).click()
  await stored.getByRole('button', { name: SAVE }).click()
  await expect.poll(async () => await stored.getByRole('button', { name: SAVE }).isDisabled(), { timeout: 20_000 }).toBe(true)
  warningStart = consoleWatch.warnings.length
  await page.reload()
  await settleLayout(page)
  acknowledgeReloadConnectionLoss(consoleWatch, warningStart)
  const reverted = await openWorkerGroup(page)
  await expect.poll(async () => await reverted.group.getByRole('switch', { name: MASTER }).getAttribute('aria-checked')).toBe('false')
  const revertedCodex = reverted.group.locator('[data-worker-engine="codex"]')
  expect(await revertedCodex.getByRole('switch').getAttribute('aria-checked')).toBe('false')
  expect(await revertedCodex.getByLabel('Codex 的可执行路径').inputValue()).toBe('')

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 240_000)
