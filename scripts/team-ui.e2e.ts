import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { launchWebScaffold, acknowledgeReloadConnectionLoss, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh } from './support.ts'
// This file is rendered into the adjacent harness checkout and runs from there,
// where bare workspace imports resolve to harness source by the lane's own
// tsconfig paths facade — so the version the page must state is read through the
// same call the running Host makes, not from a copy of its path.
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'

const TEAM_ROOT = '__TEAM_ROOT__'
const HOME = '__HOME__'
const CHROME = '__CHROME__'
const STAGED_BUNDLE = join(HOME, 'profiles', 'node_modules', '@contexera', 'dsh-agent-team')
const BROWSER_ARTIFACTS = join(TEAM_ROOT, 'artifacts/browser')
const UI01_SHOTS = join(BROWSER_ARTIFACTS, 'ui-01')
const UI02_SHOTS = join(BROWSER_ARTIFACTS, 'ui-02')
const UI03_SHOTS = join(BROWSER_ARTIFACTS, 'ui-03')
const UI04_SHOTS = join(BROWSER_ARTIFACTS, 'ui-04')
const UI05_SHOTS = join(BROWSER_ARTIFACTS, 'ui-05')
const UI06_SHOTS = join(BROWSER_ARTIFACTS, 'ui-06')
const UI07_SHOTS = join(BROWSER_ARTIFACTS, 'ui-07')
const UI08_SHOTS = join(BROWSER_ARTIFACTS, 'ui-08')
const UI09_SHOTS = join(BROWSER_ARTIFACTS, 'ui-09')
let scaffold: WebScaffold | undefined
let browser: Browser | undefined

afterEach(async () => {
  await browser?.close(); browser = undefined
  await scaffold?.close(); scaffold = undefined
})

/**
 * Wait until no finite animation is still running. The sidebar collapse and
 * its rail-in crossfade are 150ms each, and the AppFrame track slides between
 * 56px and 280px: a screenshot taken mid-flight captures the frozen expanded
 * column clipped to the rail instead of the settled rail itself. Infinite
 * animations (presence and loading pulses) are not waits.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every(animation => {
    const timing = animation.effect?.getTiming()
    return timing === undefined || timing.iterations === Infinity || animation.playState !== 'running'
  }))
}

/**
 * What a control's focus ring actually renders, plus whether the browser counts
 * the focus as keyboard-visible at all. A ring the reader never sees is not
 * evidence, so the assertion has to read `:focus-visible` too.
 */
async function focusRing(page: Page, selector: string): Promise<{
  readonly focusVisible: boolean
  readonly outlineStyle: string
  readonly outlineWidth: string
  readonly outlineColor: string
} | null> {
  return page.evaluate((sel) => {
    const target = document.querySelector(sel)
    if (target === null) return null
    const style = getComputedStyle(target)
    return {
      focusVisible: target.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
    }
  }, selector)
}

/**
 * Settle a viewport change all the way. The responsive sidebar starts its slide
 * on the frame *after* the resize, so a single animation check can pass before
 * the transition exists and the screenshot lands mid-flight — frozen expanded
 * column clipped to the rail. Two quiet frames later, re-check.
 */
async function settleLayout(page: Page): Promise<void> {
  await settleAnimations(page)
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  }))
  await settleAnimations(page)
}

/**
 * One Task's Thread door in the Channel feed. The door button carries the
 * accessible name — with or without an unread count, so the prefix form has to
 * carry the full-width opening bracket — while the entry line
 * (`data-thread-entry`) is the row that holds the state cluster beside it.
 * `:has()` keeps the exact/prefix pair on one button, so `Task #1` can never
 * resolve to `Task #10`.
 */
function taskEntrySelector(taskNumber: number): string {
  return `[data-team-channel] [data-thread-entry]:has(> button[aria-label="打开 Task #${taskNumber}"], > button[aria-label^="打开 Task #${taskNumber}（"]) > button`
}

/** The entry line (`data-thread-entry`) one Task's door belongs to. */
function taskEntryLineSelector(taskNumber: number): string {
  return `[data-team-channel] [data-thread-entry]:has(> button[aria-label="打开 Task #${taskNumber}"], > button[aria-label^="打开 Task #${taskNumber}（"])`
}

/** One Task's Thread door: the locator form of {@link taskEntrySelector}. */
function taskEntryRow(page: Page, taskNumber: number) {
  return page.locator(taskEntrySelector(taskNumber))
}

/**
 * Left edges of one entry's state cluster, the entry line it leads, and the
 * reading column holding both it and the body above it. All three meet when the
 * state opens the entry line — the path the reader's eye already follows — and
 * diverge when it is parked at a line's far end instead. The column is the
 * message body box itself rather than a positional child, because a grouped row
 * that carries no time of its own renders no identity line at all.
 */
async function entryClusterEdges(page: Page, lineSelector: string): Promise<{ readonly cluster: number; readonly row: number; readonly column: number } | null> {
  return page.evaluate((selector) => {
    const line = document.querySelector(selector)
    const cluster = line?.firstElementChild
    const column = line?.parentElement
    if (line === null || line === undefined || cluster === null || cluster === undefined || column === null || column === undefined) return null
    return {
      cluster: Math.round(cluster.getBoundingClientRect().left),
      row: Math.round(line.getBoundingClientRect().left),
      column: Math.round(column.getBoundingClientRect().left),
    }
  }, lineSelector)
}

/**
 * The Channel feed's state column: the left edge of every entry line's state
 * cluster. A Taskful entry always carries one — a status dot and word at
 * minimum — so these x values are what a reader's eye scans down.
 */
async function taskEntryClusterLefts(page: Page): Promise<readonly number[]> {
  return page.evaluate(() => {
    const edges: number[] = []
    for (const line of document.querySelectorAll('[data-team-channel] [data-thread-entry]')) {
      const cluster = line.firstElementChild
      if (cluster !== null) edges.push(Math.round(cluster.getBoundingClientRect().left))
    }
    return edges
  })
}

/**
 * What decides where the digit sits and how wide the capsule runs. Three copies
 * of these declarations is how the count drifted between the sidebar's Inbox
 * entry, the Channel feed's Thread entry, and the Inbox queue's own rows; one
 * component means one answer, and this reads that answer off the assembled
 * bundle instead of trusting the source.
 */
function readCountCapsule(element: Element): {
  readonly text: string
  readonly hidden: string | null
  readonly background: string
  /** The used box, computed style is not enough: `min-width` is a floor the
   * content can still push past, so whether one digit really lands in a square
   * is only answered here. */
  readonly box: Record<string, number>
  /** The inset that reaches the digit: what a tone spends before the count can
   * start, padding plus its own border. The two tones declare different numbers
   * on purpose, so this — not the declaration — is what has to agree. */
  readonly inset: number
  readonly shape: Record<string, string>
} {
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return {
    text: element.textContent?.trim() ?? '',
    hidden: element.getAttribute('aria-hidden'),
    background: style.backgroundColor,
    box: { width: rect.width, height: rect.height },
    inset: Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth),
    shape: {
      // The longhands, because `font` is the empty string here and a shape that
      // silently compares '' to '' would let a second font in unnoticed.
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fontVariantNumeric: style.fontVariantNumeric,
      lineHeight: style.lineHeight,
      height: style.height,
      minWidth: style.minWidth,
      boxSizing: style.boxSizing,
      display: style.display,
      alignItems: style.alignItems,
      justifyContent: style.justifyContent,
      radius: style.borderTopLeftRadius,
      cornerShape: style.getPropertyValue('corner-shape'),
    },
  }
}

/**
 * The unread capsule an entry carries, found by the shared count badge's own
 * attribute: CSS-module class names are hashed by the build, and one component
 * now wears every count, so the attribute — not a class name and not a guessed
 * shape — is the contract. Computed style is the evidence that the single rule
 * actually reached the page.
 */
async function entryUnreadCapsule(page: Page, lineSelector: string): Promise<ReturnType<typeof readCountCapsule> | null> {
  const capsule = page.locator(`${lineSelector} [data-team-count-badge]`).first()
  return await capsule.count() === 0 ? null : await capsule.evaluate(readCountCapsule)
}

/**
 * Stage this bundle and its dependency closure the way `dsh plugin add`
 * installs it. Production mounts the package as a profile bundle and takes the
 * row set from the bundle's own patch; a command-line overlay declaring those
 * rows instead shadows the profile document, so the Host row's settings write
 * fails (rc.1 `ConfigEditor`: "overridden by a home patch or command-line
 * overlay"). Every lane therefore mounts the staged copy as a profile package.
 * Only the first case of a run clears the artifacts directory
 * (`clearArtifacts`); every later case appends to it, so one full run leaves
 * every case's screenshots to review instead of only the last case's.
 */
async function installLocalBundle(clearArtifacts = true): Promise<void> {
  await rm(HOME, { recursive: true, force: true })
  if (clearArtifacts) await rm(BROWSER_ARTIFACTS, { recursive: true, force: true })
  const scope = `${HOME}/profiles/node_modules/@contexera`
  await mkdir(scope, { recursive: true })
  // The filter must match on both separators: on Windows cp walks backslash
  // paths, so forward-slash-only matching lets node_modules and src through.
  await cp(TEAM_ROOT, `${scope}/dsh-agent-team`, {
    recursive: true,
    filter: source => {
      const normalized = source.replaceAll('\\', '/')
      // .hoplite is agent-workspace state (runtime FIFOs kill fs.cp), never
      // part of the bundle layout being staged.
      return !normalized.includes('/node_modules') && !normalized.includes('/src') && !normalized.includes('/artifacts') && !normalized.includes('/.hoplite')
    },
  })
  // Production installs the bundle's regular dependencies with it (pnpm,
  // hoisted); this manual staging runs no installer, so stage the same
  // closure or a boot-time bare import resolves nowhere — before this, zod
  // passed only because the installation fallback heals its own copy. Stage
  // them INSIDE the bundle dir: the shared profiles/node_modules root is
  // dsh-managed healed state, and the healer rejects foreign real entries.
  const { dependencies } = JSON.parse(await readFile(join(TEAM_ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const bundleModules = join(scope, 'dsh-agent-team', 'node_modules')
  for (const name of Object.keys(dependencies)) {
    // No filter: the source root itself lives under node_modules (the
    // bundle filter above would reject it), and a store package never nests
    // its own node_modules — pnpm keeps siblings beside it instead.
    await cp(join(TEAM_ROOT, 'node_modules', name), join(bundleModules, ...name.split('/')), {
      recursive: true,
      dereference: true,
    })
  }
  // The routed ledger backend travels inside the staged copy: it is vendored
  // under this bundle's own package name (see cordis.patch.yml), so no host
  // node_modules link is staged here.
  await mkdir(UI01_SHOTS, { recursive: true })
  await mkdir(UI02_SHOTS, { recursive: true })
  await mkdir(UI03_SHOTS, { recursive: true })
  await mkdir(UI04_SHOTS, { recursive: true })
  await mkdir(UI05_SHOTS, { recursive: true })
  await mkdir(UI06_SHOTS, { recursive: true })
  await mkdir(UI07_SHOTS, { recursive: true })
  await mkdir(UI08_SHOTS, { recursive: true })
  await mkdir(UI09_SHOTS, { recursive: true })
}

it('drives the complete opt-in Agent Team journey in real Web', async () => {
  await installLocalBundle()
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  // rc.1: the web server gates the browser surface behind a process-token
  // exchange; the scaffold's authenticatedUrl establishes the session cookie.
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')
  const ordinaryComposer = page.locator('[data-composer-input][contenteditable="true"][data-placeholder="描述你想要构建的内容, / 调用指令, @ 文件或对话"]')
  await expect.poll(() => ordinaryComposer.count()).toBe(1)

  expect(scaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(true)
  const teamTrigger = page.getByRole('button', { name: '团队' })
  const settingsTrigger = page.getByRole('button', { name: '设置' })
  const [teamBox, settingsBox] = await Promise.all([teamTrigger.boundingBox(), settingsTrigger.boundingBox()])
  expect(teamBox).not.toBeNull()
  expect(settingsBox).not.toBeNull()
  await teamTrigger.click()
  const conversationTrigger = page.getByRole('button', { name: '对话' })
  const membersTrigger = page.getByRole('button', { name: '成员' })
  const [conversationBox, membersTriggerBox] = await Promise.all([conversationTrigger.boundingBox(), membersTrigger.boundingBox()])
  expect(conversationBox).not.toBeNull()
  expect(membersTriggerBox).not.toBeNull()
  expect(conversationBox!.y).toBeCloseTo(teamBox!.y, 0)
  expect(conversationBox!.height).toBeCloseTo(teamBox!.height, 0)
  expect(membersTriggerBox!.y).toBeCloseTo(settingsBox!.y, 0)
  expect(membersTriggerBox!.height).toBeCloseTo(settingsBox!.height, 0)
  const newSessionButtons = page.locator('button[aria-label="新建会话"]')
  const newSessionButton = page.locator('button[class*="newSession"][aria-label="新建会话"]')
  const brandButton = page.locator('button[class*="brand"][aria-label="新建会话"]')
  await expect.poll(() => newSessionButtons.count()).toBe(2)
  await expect.poll(() => newSessionButton.count()).toBe(1)
  await expect.poll(() => newSessionButton.isVisible()).toBe(false)
  await expect.poll(() => brandButton.count()).toBe(1)
  await expect.poll(() => brandButton.isVisible()).toBe(true)
  await page.getByRole('button', { name: '新建频道' }).click()
  const initialChannelDialog = page.getByRole('dialog', { name: '新建频道' })
  await initialChannelDialog.getByLabel('名称').fill('engineering')
  await initialChannelDialog.getByLabel('说明').fill('Agent membership')
  await initialChannelDialog.getByRole('button', { name: '创建频道' }).click()
  for (const [name, description] of [['builder', '实现功能'], ['reviewer', '检查结果']] as const) {
    await page.getByRole('button', { name: '添加 Agent' }).click()
    const dialog = page.getByRole('dialog', { name: '添加 Agent' })
    await dialog.getByLabel('名称').fill(name)
    await dialog.getByLabel('说明').fill(description)
    // Creation has no Channel page anymore: membership is Channel-side.
    expect(await dialog.getByRole('button', { name: '初始频道' }).count()).toBe(0)
    if (name === 'builder') {
      // The import entry shares the create dialog: toggling reveals the
      // global Member roster — truthfully empty here, since no Member exists
      // outside this Workspace yet — and toggling back restores the form
      // with its input intact.
      await dialog.getByRole('button', { name: '从其他 Workspace 引入' }).click()
      await dialog.getByText('没有可引入的 Agent。').waitFor()
      await page.screenshot({ path: join(UI03_SHOTS, 'agent-import-empty.png'), fullPage: true })
      await dialog.getByRole('button', { name: '创建 Agent' }).click()
      await expect.poll(() => dialog.getByLabel('名称').inputValue()).toBe('builder')
      await page.screenshot({ path: join(UI03_SHOTS, 'agent-create-modal.png'), fullPage: true })
      // The model picker caps its card and scrolls internally.
      await dialog.getByRole('button', { name: '模型' }).click()
      await page.getByRole('menuitem', { name: '跟随全局默认' }).waitFor()
      await page.screenshot({ path: join(UI03_SHOTS, 'agent-create-model-menu.png'), fullPage: true })
      // Selecting the default row closes the menu and keeps the model unset
      // (Escape would bubble to the Modal and close the whole dialog).
      await page.getByRole('menuitem', { name: '跟随全局默认' }).click()
      // The Input atoms sit evenly inside the dialog card (the lopsided
      // right gutter regression this guard pins).
      const inputBox = await dialog.getByLabel('名称').boundingBox()
      const cardBox = await dialog.boundingBox()
      expect(inputBox).not.toBeNull()
      expect(cardBox).not.toBeNull()
      const leftGap = inputBox!.x - cardBox!.x
      const rightGap = cardBox!.x + cardBox!.width - (inputBox!.x + inputBox!.width)
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(2)
    }
    await dialog.getByRole('button', { name: '创建 Agent' }).click()
    await page.getByText(name, { exact: true }).waitFor({ timeout: 20_000 })
  }
  // Membership is managed from the Channel side now: add both Members to
  // engineering through the Channel editor before any membership-dependent
  // flow runs.
  await page.getByRole('button', { name: '# engineering' }).hover()
  await page.getByRole('button', { name: 'engineering 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑频道' }).click()
  const joinEditor = page.getByRole('dialog', { name: '编辑频道' })
  await joinEditor.waitFor()
  for (const handle of ['builder', 'reviewer']) {
    const row = joinEditor.locator('[data-team-member-row]').filter({ hasText: `@${handle}` })
    // rc.1: member activation lands asynchronously (handle-based persistence
    // + async AgentLoop create); the roster can briefly show the new member
    // as unavailable before its handle registers.
    await expect.poll(async () => await row.getByRole('button', { name: '添加' }).isEnabled(), { timeout: 30_000 }).toBe(true)
    await row.getByRole('button', { name: '添加' }).click()
  }
  await expect.poll(async () => await joinEditor.getByRole('button', { name: '移除', exact: true }).count()).toBe(2)
  await joinEditor.getByRole('button', { name: '关闭', exact: true }).click()
  // Narrow-viewport create form with every field optional. The 390
  // breakpoint collapses the frame to the rail and unmounts the sidebar
  // panels (dialog state included), so the dialog opens from the
  // narrow-expanded sidebar once the collapse has settled.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await page.getByRole('button', { name: '打开侧边栏' }).click()
  await page.getByRole('button', { name: '添加 Agent' }).click()
  const narrowDialog = page.getByRole('dialog', { name: '添加 Agent' })
  await narrowDialog.getByLabel('名称').waitFor()
  const narrowBox = await narrowDialog.boundingBox()
  expect(narrowBox).not.toBeNull()
  expect(narrowBox!.x).toBeGreaterThanOrEqual(0)
  expect(narrowBox!.x + narrowBox!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI03_SHOTS, 'agent-create-modal-narrow.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 960 })
  await expect.poll(() => page.getByLabel('可用').count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
  // The Agent list seats the shared Member identity in the row's second track.
  // A centred or over-wide identity walks the avatar right and pushes the row
  // past the sidebar; both are invisible to a hover-only glance, so they are
  // pinned here at the settled desktop width.
  const agentRowBoxes = await page.locator('[data-agent-row]').evaluateAll(rows => rows.map(row => {
    const select = row.querySelector('button')
    const avatar = row.querySelector('[role="img"]')
    const handle = row.querySelector('strong')
    const padding = select === null ? 0 : Number.parseFloat(getComputedStyle(select).paddingLeft)
    return {
      avatarInset: avatar === null || select === null ? -1 : Math.round(avatar.getBoundingClientRect().left - select.getBoundingClientRect().left),
      handleGap: avatar === null || handle === null ? -1 : Math.round(handle.getBoundingClientRect().left - avatar.getBoundingClientRect().right),
      rowOverflow: Math.round(row.getBoundingClientRect().right - (row.parentElement?.getBoundingClientRect().right ?? 0)),
      padding,
    }
  }))
  expect(agentRowBoxes.length).toBeGreaterThanOrEqual(2)
  for (const box of agentRowBoxes) {
    expect(Math.abs(box.avatarInset - box.padding)).toBeLessThanOrEqual(1)
    expect(box.handleGap).toBeGreaterThanOrEqual(6)
    expect(box.rowOverflow).toBeLessThanOrEqual(0)
  }
  await page.screenshot({ path: join(UI02_SHOTS, 'sidebar-agents.png'), fullPage: true })

  await page.getByRole('button', { name: '新建频道' }).click()
  const channelDialog = page.getByRole('dialog', { name: '新建频道' })
  await channelDialog.getByLabel('名称').fill('delivery')
  await channelDialog.getByLabel('说明').fill('M2 完整协作验收')
  // Initial members ride the shared multi-select Menu now.
  await channelDialog.getByRole('button', { name: '初始成员' }).click()
  await page.getByRole('menuitem', { name: /builder/ }).click()
  await page.getByRole('menuitem', { name: /reviewer/ }).click()
  await expect.poll(async () => (await channelDialog.getByRole('button', { name: /初始成员/ }).textContent())?.trim() ?? '').toContain('已选 2 个成员')
  await page.screenshot({ path: join(UI03_SHOTS, 'channel-create-modal.png'), fullPage: true })
  await channelDialog.getByRole('button', { name: '创建频道' }).click()
  // The same form at 390: the breakpoint unmounts sidebar panels (dialog
  // state included), so the check re-opens it from the narrow-expanded
  // sidebar after the collapse has settled.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await page.getByRole('button', { name: '打开侧边栏' }).click()
  await page.getByRole('button', { name: '新建频道' }).click()
  const narrowChannelDialog = page.getByRole('dialog', { name: '新建频道' })
  await narrowChannelDialog.getByLabel('名称').waitFor()
  const dialogBox = await narrowChannelDialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390)
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(844)
  await page.screenshot({ path: join(UI03_SHOTS, 'channel-create-modal-narrow.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByText('还没有消息', { exact: true }).waitFor()
  await page.screenshot({ path: join(UI02_SHOTS, 'sidebar-channels.png'), fullPage: true })

  // Sidebar ordering: whole-row native drag reuses the Harness list model —
  // a before/after insertion marker, one commit per gesture — and the personal
  // order lives in this browser only, folded over the Remote default on load.
  const channelOrder = (): Promise<string[]> => page.evaluate(() =>
    [...document.querySelectorAll('[class*="channelSelect"] strong')].map(node => node.textContent?.trim().replace(/^#\s*/, '') ?? ''))
  await expect.poll(channelOrder).toEqual(['engineering', 'delivery'])
  const deliveryRow = page.getByRole('button', { name: '# delivery' })
  const dropBelowTopHalfOf = async (locator: ReturnType<typeof page.getByRole>): Promise<void> => {
    const box = await locator.boundingBox()
    if (box === null) throw new Error('drop target vanished')
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
    const draggingRow = page.getByRole('button', { name: '# engineering' })
    await draggingRow.dispatchEvent('dragstart', { dataTransfer })
    await locator.dispatchEvent('dragover', { dataTransfer, clientY: box.y + box.height * 0.75 })
    // The insertion marker is part of the contract: the lower half of the
    // target row must paint the drop-after line before anything commits.
    const deliveryWrapper = locator.locator('xpath=ancestor::div[1]')
    await expect.poll(async () =>
      await deliveryWrapper.evaluate(element => element.className.includes('sidebarRowDropAfter'))).toBe(true)
    await page.screenshot({ path: join(UI02_SHOTS, 'channel-drop-marker.png'), fullPage: true })
    await locator.dispatchEvent('drop', { dataTransfer, clientY: box.y + box.height * 0.75 })
    await draggingRow.dispatchEvent('dragend', { dataTransfer })
  }
  await dropBelowTopHalfOf(deliveryRow)
  await expect.poll(channelOrder).toEqual(['delivery', 'engineering'])
  // The committed order survives a full reload: boot restore folds the saved
  // preference over the freshly loaded Remote default order.
  await page.reload()
  // Boot restore lands on the persisted Thread route; the channel list is one
  // explicit step back.
  await page.getByRole('heading', { name: '# delivery' }).waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: '返回频道列表' }).click()
  await expect.poll(channelOrder, { timeout: 20_000 }).toEqual(['delivery', 'engineering'])
  // A brand-new channel appends after the user's saved entries.
  await page.getByRole('button', { name: '新建频道' }).click()
  const rampDialog = page.getByRole('dialog', { name: '新建频道' })
  await rampDialog.getByLabel('名称').fill('ramp')
  await rampDialog.getByRole('button', { name: '创建频道' }).click()
  await expect.poll(channelOrder).toEqual(['delivery', 'engineering', 'ramp'])

  // Sidebar row menus: the ⋯ entry opens the M2 editors — display facts plus
  // membership. 保存 stays disabled until a field actually changes, and the
  // committed rename reaches the row through the refreshed projection.
  await page.getByRole('button', { name: '# engineering' }).hover()
  await page.getByRole('button', { name: 'engineering 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑频道' }).click()
  const channelEditor = page.getByRole('dialog', { name: '编辑频道' })
  await channelEditor.waitFor()
  expect(await channelEditor.getByText('@builder').count()).toBe(1)
  const channelSave = channelEditor.getByRole('button', { name: '保存' })
  await expect.poll(async () => await channelSave.isDisabled()).toBe(true)
  await channelEditor.getByLabel('说明').fill('Platform delivery work')
  await expect.poll(async () => await channelSave.isDisabled()).toBe(false)
  await page.screenshot({ path: join(UI04_SHOTS, 'channel-edit-modal.png'), fullPage: true })
  await channelSave.click()
  await expect.poll(() => page.getByRole('dialog', { name: '编辑频道' }).count()).toBe(0)
  await page.getByRole('button', { name: '# engineering' }).hover()
  await page.getByRole('button', { name: 'engineering 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑频道' }).click()
  const channelRecheck = page.getByRole('dialog', { name: '编辑频道' })
  await channelRecheck.waitFor()
  await expect.poll(async () => channelRecheck.getByLabel('说明').inputValue()).toBe('Platform delivery work')
  await channelRecheck.getByRole('button', { name: '关闭', exact: true }).click()
  await expect.poll(() => page.getByRole('dialog', { name: '编辑频道' }).count()).toBe(0)
  // Collapsed sections hide their rows until expanded again.
  const channelsToggle = page.getByRole('button', { name: '频道', exact: true })
  await channelsToggle.click()
  await expect.poll(() => page.getByRole('button', { name: '# engineering' }).count()).toBe(0)
  // Collapse is a browser-local presentation preference, not a Team fact: it
  // survives a full reload like the row order does, then still expands again.
  // The section header itself stays reachable while collapsed, so no channel
  // row is needed to prove the persisted state.
  await page.reload()
  await channelsToggle.waitFor({ timeout: 20_000 })
  await expect.poll(() => page.getByRole('button', { name: '# engineering' }).count()).toBe(0)
  await channelsToggle.click()
  await page.getByRole('button', { name: '# engineering' }).waitFor()

  // The Workspace is one selector line, not a list: its own text names where
  // the reader is, its accessible name states that same Workspace, and the
  // other Workspaces exist only inside its menu.
  const workspaceTrigger = page.getByRole('button', { name: '工作区，team-workspace', exact: true })
  await expect.poll(async () => (await workspaceTrigger.textContent())?.trim() ?? '').toBe('team-workspace')
  await expect.poll(() => workspaceTrigger.getAttribute('aria-haspopup')).toBe('menu')
  await expect.poll(() => workspaceTrigger.getAttribute('aria-expanded')).toBe('false')
  await workspaceTrigger.click()
  await expect.poll(() => workspaceTrigger.getAttribute('aria-expanded')).toBe('true')
  await page.getByRole('menuitem', { name: 'team-workspace' }).waitFor()
  await page.keyboard.press('Escape')
  await expect.poll(() => workspaceTrigger.getAttribute('aria-expanded')).toBe('false')
  // The menu is the only way to switch Workspaces, so its rows have to be
  // reachable without a pointer: opening from the keyboard puts focus on the
  // first row, and Escape hands focus back to the trigger.
  await workspaceTrigger.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role') ?? '')).toBe('menuitem')
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-team-workspace-trigger]') ?? false)).toBe(true)
  // The Inbox is the one entry that crosses Workspaces — its total sums every
  // one of them — so it stands above the selector that scopes the sections
  // below it rather than inside that scope.
  const [workspaceTriggerBox, inboxCardBox] = await Promise.all([
    workspaceTrigger.boundingBox(),
    page.locator('button[class*="inboxCard"]').boundingBox(),
  ])
  expect(workspaceTriggerBox).not.toBeNull()
  expect(inboxCardBox).not.toBeNull()
  expect(workspaceTriggerBox!.y).toBeGreaterThan(inboxCardBox!.y)

  const builderRow = page.locator('[class*="agentRow"]').filter({ hasText: 'builder' }).first()
  await builderRow.hover()
  await builderRow.getByRole('button', { name: 'builder 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑 Agent' }).click()
  const agentEditor = page.getByRole('dialog', { name: '编辑 Agent' })
  await agentEditor.waitFor()
  // The Agent editor carries no Channel section anymore: handle,
  // description, and model only (membership lives on the Channel side).
  await expect.poll(() => agentEditor.getByRole('button', { name: '移除' }).count()).toBe(0)
  await expect.poll(() => agentEditor.getByRole('button', { name: '添加' }).count()).toBe(0)
  // The per-Member model picker rides the shared Menu primitive: the trigger
  // echoes the current selection and opening lists the Host catalog grouped
  // by provider without any live Session round-trip. Re-selecting the
  // default row closes it without dirtying the form.
  const modelTrigger = agentEditor.getByRole('button', { name: '模型', exact: true })
  await modelTrigger.waitFor()
  await expect.poll(() => modelTrigger.textContent()).toBe('跟随全局默认')
  await modelTrigger.click()
  const modelMenu = page.locator('[role="menu"]').filter({ hasText: '跟随全局默认' })
  await modelMenu.waitFor()
  expect(await modelMenu.getByRole('menuitem').count()).toBeGreaterThanOrEqual(2)
  // The radius the shared Menu primitive gives its own rows, measured live: the
  // Team composer's mention popover is held to this same value below, so the two
  // cannot drift into separate menu languages on any DSH line.
  const shippedRowRadius = await modelMenu.getByRole('menuitem').first()
    .evaluate(row => getComputedStyle(row).borderTopLeftRadius)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-model-menu.png'), fullPage: true })
  await modelMenu.getByRole('menuitem', { name: '跟随全局默认' }).click()
  await expect.poll(() => page.locator('[role="menu"]').count()).toBe(0)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-edit-modal.png'), fullPage: true })
  await agentEditor.getByRole('button', { name: '关闭', exact: true }).click()

  // The manual clear-context entry is retired (ticket 01): Members manage
  // their own context through the context_rollover tool, so every row menu must
  // omit the entry entirely and no confirm dialog exists. Model-initiated
  // rollover and the live follow are covered by the member-lifecycle
  // integration tests and the Client component suite; the full
  // model-driven browser journey lands with ticket 04.
  await builderRow.hover()
  await builderRow.getByRole('button', { name: 'builder 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑 Agent' }).waitFor()
  expect(await page.getByRole('menuitem', { name: '从全新上下文开始' }).count()).toBe(0)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-row-menu-fresh-only.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect.poll(() => page.locator('[role="menu"]').count()).toBe(0)

  const memberWorkspace = scaffold.ctx.workspaceRegistry.list()[0]!
  const memberStatuses = scaffold.ctx.agentTeam.members({ workspaceId: memberWorkspace.id })
  const builderMember = memberStatuses.find((status: { member: { handle: string } }) => status.member.handle === 'builder')!
  const builderAgent = scaffold.ctx.agents.get(builderMember.member.sessionId)!

  // Fixture seam, not an assertion change: the adjacent Harness scaffold's
  // fixture-less adapter reports route capacity on a top-level field the
  // canonical LlmResolvedModelInfo shape never reads, so the Member's route
  // would price as unknown and the pressure policy fail-closed would reject
  // every pre-step. The canonical durable route record — the same
  // `request/context` event a real first request appends — matches the
  // Member's default selection and carries the route's real capacity, so
  // the Host's persisted-route fast path prices the turn normally. The
  // journey still proves a plain composer prompt lands on the Member's live
  // Session below; nothing about the delivery assertion changes.
  {
    const selection = scaffold.ctx.agentDefaultModel.currentSelection()
    builderAgent.session.append('request/context', {
      provider: selection.provider,
      model: selection.model,
      contextWindow: 128_000,
    })
  }

  // Clicking the Agent card keeps Team mode mounted and swaps only the right
  // pane: the conversation shadow stands down so the shipped root renders the
  // Member Session between the Team sidebars. A Member session has no human
  // turns yet, so DSH renders its blank-session view — the hero composer
  // carrying the Member's workspace + `team-member` preset chips.
  // The Human's own session is staged first on purpose: the embedded view then
  // carries a return target, so leaving Team later restores an ordinary
  // conversation instead of stranding the Member Session.
  await brandButton.click()
  // The two Member Sessions exist already; the brand click adds the Human's.
  await expect.poll(() => scaffold.ctx.sessions.list().length).toBeGreaterThanOrEqual(3)
  await builderRow.getByRole('button', { name: '打开 builder 的会话' }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe('team')
  await expect.poll(() => page.locator('[data-team-channel]').count()).toBe(0)
  // rc.1: the shipped InputBar owns the composer entirely — the Team manages
  // no member-session input surface, so the journey only asserts the shipped
  // composer renders for the embedded Member Session.
  const memberInput = page.locator('[data-composer-input][contenteditable="true"]')
  await expect.poll(() => memberInput.count()).toBe(1)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-session-composer.png'), fullPage: true })

  // With clear-context retired there is no Human-initiated rollover in this
  // journey: the embedded Member Session simply stays live for its current
  // generation (model-driven context rollover and the Client follow are
  // covered by the member-lifecycle integration tests and the Client
  // component suite; the full model-driven browser journey lands with
  // ticket 04). The pane keeps rendering the Member's live Session — blank
  // hero, composer enabled, Team mode mounted.
  await expect.poll(() => page.evaluate(() => ({
    channel: document.querySelectorAll('[data-team-channel]').length,
    mode: document.documentElement.dataset.agentTeamMode ?? null,
  })), { timeout: 10_000 }).toEqual({ channel: 0, mode: 'team' })
  await expect.poll(() => memberInput.isEnabled()).toBe(true)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-session-live.png'), fullPage: true })
  // Host side: the Member is still bound to its original Session id; no
  // archive happened and no rollover operation exists.
  const liveStatuses = scaffold.ctx.agentTeam.members({ workspaceId: memberWorkspace.id })
  const liveBuilder = liveStatuses.find((status: { member: { handle: string } }) => status.member.handle === 'builder')!
  expect(liveBuilder.member.sessionId).toBe(builderMember.member.sessionId)
  expect(scaffold.ctx.workspaceRegistry.archivedSessionIds).not.toContain(builderMember.member.sessionId)

  // The embedded Member Session is directly usable through the shipped
  // composer: a plain prompt lands on the Member's live Session (the Team
  // manages no member-session input surface, so no structured mention flow
  // remains).
  await memberInput.fill('member session hello')
  await memberInput.press('Enter')
  const isPlainMemberPrompt = (event: ReturnType<typeof builderAgent.session.snapshotEvents>[number]): boolean => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && event.data.content.some(block => block.type === 'text' && block.text === 'member session hello')
  await expect.poll(() => builderAgent.session.snapshotEvents().some(isPlainMemberPrompt)).toBe(true)
  await builderAgent.whenIdle()
  await expect.poll(() => page.locator('[class*="agentRow"]').count()).toBeGreaterThan(0)
  // The single positioning highlight sits on the selected Agent card; the
  // workspace overview row stays quiet while the Member view is open.
  await expect.poll(() => page.locator('[aria-current="page"]').count()).toBe(1)
  await expect.poll(() => page.locator('[aria-current="page"]').getAttribute('aria-label')).toBe('打开 builder 的会话')
  await expect.poll(() => page.getByRole('button', { name: '# delivery' }).count()).toBe(1)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-session-dm.png'), fullPage: true })
  // Opening the row menu on the selected card must show ONE seamless full-row
  // fill: the leaf's resident fill is suppressed while the row paints its own.
  await builderRow.hover()
  await builderRow.getByRole('button', { name: 'builder 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑 Agent' }).waitFor()
  await expect.poll(() => page.evaluate(() => {
    const el = document.querySelector('[aria-current="page"]')
    return el === null ? 'missing' : getComputedStyle(el).backgroundColor
  })).toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-session-dm-row-menu.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-session-dm-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  // Explicit Team navigation closes the embedded Member view again.
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await expect.poll(() => page.locator('[data-team-channel]').count()).toBe(1)
  await page.getByText('还没有消息', { exact: true }).waitFor()
  await page.screenshot({ path: join(UI02_SHOTS, 'sidebar-channels.png'), fullPage: true })
  await page.screenshot({ path: join(UI01_SHOTS, 'empty-channel.png'), fullPage: true })
  const channelComposer = page.getByRole('textbox', { name: '消息内容' })
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('消息内容')
  await page.getByRole('button', { name: '返回频道列表' }).focus()
  const idleComposerBorder = await page.locator('[data-team-composer]').evaluate(element => {
    const style = getComputedStyle(element)
    return `${style.borderColor} ${style.boxShadow}`
  })
  await channelComposer.click()
  expect(await page.locator('[data-team-composer]').evaluate(element => {
    const style = getComputedStyle(element)
    return `${style.borderColor} ${style.boxShadow}`
  })).toBe(idleComposerBorder)
  await channelComposer.fill('请协作完成验收 @')
  // DSH 0.1.7's menu surface token is translucent, so the popup must frost what
  // is behind it — the blur plus that translucent fill is what keeps the roster
  // legible over the conversation, which is the state this pins. Its shape is
  // the shipped menu's too: the surface rides the tier the shared radius scale
  // names, and the rows land on the row radius measured off the Menu primitive
  // above. rc.2 moved that scale onto `--dsw-radius-*` (lg surface, md rows)
  // where rc.1 hard-coded the pixels, so both expectations are read from the
  // running line instead of frozen to one cut of it.
  const menuSurface = await page.getByRole('listbox', { name: '提及成员建议' }).evaluate(element => {
    const style = getComputedStyle(element)
    const firstRow = element.querySelector('[role="option"]')
    return {
      blur: style.backdropFilter,
      fill: style.backgroundColor,
      radius: style.borderTopLeftRadius,
      rowRadius: firstRow === null ? '' : getComputedStyle(firstRow).borderTopLeftRadius,
      surfaceTier: getComputedStyle(document.documentElement).getPropertyValue('--dsw-radius-lg').trim() || '16px',
    }
  })
  expect(menuSurface.blur).toContain('blur')
  expect(menuSurface.fill).toContain('rgba(')
  expect(menuSurface.radius).toBe(menuSurface.surfaceTier)
  expect(menuSurface.rowRadius).toBe(shippedRowRadius)
  await page.getByRole('option', { name: /@builder/ }).click()
  await page.screenshot({ path: join(UI04_SHOTS, 'mention-menu-selected.png'), fullPage: true })
  const asTaskToggle = page.getByRole('button', { name: '作为任务' })
  await expect.poll(() => asTaskToggle.getAttribute('aria-pressed')).toBe('false')
  await asTaskToggle.focus()
  await page.keyboard.press('Space')
  await expect.poll(() => asTaskToggle.getAttribute('aria-pressed')).toBe('true')
  // The pressed state must be visible on its own: primary fill, unchanged by hover.
  const pressedFill = await asTaskToggle.evaluate(element => getComputedStyle(element).backgroundColor)
  await asTaskToggle.hover()
  expect(await asTaskToggle.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(pressedFill)
  await page.screenshot({ path: join(UI04_SHOTS, 'as-task-pressed.png'), fullPage: true })
  // The mode keeps its word at every width: the narrow branch narrows the
  // toolbar's control gaps instead of dropping the label, so 390 asserts both
  // halves. It runs in the settled collapsed layout, never mid-reflow.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await expect.poll(async () => (await page.locator('[data-team-channel]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(330)
  expect(await asTaskToggle.getAttribute('aria-label')).toBe('作为任务')
  expect(await asTaskToggle.getAttribute('title')).toBe('作为任务')
  expect(await asTaskToggle.getAttribute('aria-pressed')).toBe('true')
  const modeLabel = (element: Element) => {
    const label = element.querySelector('[class*="asTaskLabel"]')
    const toolbar = element.closest('[class*="toolbar"]')
    return {
      display: label === null ? 'missing' : getComputedStyle(label).display,
      gap: toolbar === null ? 'missing' : getComputedStyle(toolbar).gap,
    }
  }
  const narrow = await asTaskToggle.evaluate(modeLabel)
  expect(narrow.display).not.toBe('none')
  expect(narrow.display).not.toBe('missing')
  expect(narrow.gap).toBe('8px')
  await page.setViewportSize({ width: 1440, height: 960 })
  const wide = await asTaskToggle.evaluate(modeLabel)
  expect(wide.display).not.toBe('none')
  expect(wide.display).not.toBe('missing')
  expect(wide.gap).toBe('12px')
  await page.getByRole('button', { name: '发送' }).click()
  const committedMessage = page.locator('[data-team-channel] article').filter({ hasText: '请协作完成验收' })
  await committedMessage.waitFor()
  await expect.poll(() => asTaskToggle.getAttribute('aria-pressed')).toBe('false')
  await expect.poll(() => page.getByRole('textbox', { name: '消息内容' }).inputValue()).toBe('')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('消息内容')
  await page.getByRole('button', { name: '发送', exact: true }).waitFor()

  // A handle typed by hand is delivered exactly like a pick from the menu, so
  // the notify row must report it with no pick at all — and follow the text
  // back out again when the name is deleted.
  await channelComposer.fill('再确认一次 @reviewer')
  await expect.poll(() => page.getByText(/将通知/).textContent()).toContain('@reviewer')
  await page.screenshot({ path: join(UI04_SHOTS, 'mention-typed-notify.png'), fullPage: true })
  await channelComposer.fill('')
  await expect.poll(() => page.getByText(/将通知/).count()).toBe(0)

  // @all expansion: typing a prefix of "all" surfaces the fixed row on top of
  // the matching members; keyboard navigation highlights it and Tab accepts.
  // The expansion snapshot covers every eligible delivery member (builder,
  // reviewer) at pick time, and later text edits must not prune it away.
  await channelComposer.fill('全员同步 @a')
  const allOption = page.getByRole('option', { name: /@all/ })
  await allOption.waitFor()
  // 'a' prefixes "all" but no handle in this channel, so the fixed row is
  // the only candidate; it is highlighted by default.
  expect(await page.getByRole('option').count()).toBe(1)
  await expect.poll(() => allOption.getAttribute('aria-selected')).toBe('true')
  await page.screenshot({ path: join(UI04_SHOTS, 'all-mention-menu.png'), fullPage: true })
  await page.keyboard.press('Tab')
  await expect.poll(() => channelComposer.inputValue()).toBe('全员同步 @all ')
  const notifyRow = page.getByText(/将通知/)
  await expect.poll(() => notifyRow.textContent()).toContain('@builder')
  expect(await notifyRow.textContent()).toContain('@reviewer')
  await channelComposer.fill('全员同步 @all，今天截止')
  await expect.poll(() => notifyRow.textContent()).toContain('@reviewer')
  await page.getByRole('button', { name: '发送' }).click()
  const allMessage = page.locator('[data-team-channel] article').filter({ hasText: '全员同步' })
  await allMessage.waitFor()
  expect((await allMessage.textContent())?.includes('@all，今天截止')).toBe(true)
  // The expansion delivered a direct mention to every eligible member: both
  // agents read the taskless Thread so the later inbox assertions keep
  // counting only the original @builder invitation flow. The @all message is
  // the newest taskless Thread in the workspace; the Members are re-fetched
  // through their current live bindings.
  const allWorkspace = scaffold.ctx.workspaceRegistry.list()[0]!
  const allProjection = scaffold.ctx.agentTeam.view({ workspaceId: allWorkspace.id })
  const allThread = allProjection.threads
    .filter((thread: { taskRef?: string }) => thread.taskRef === undefined)
    .reduce((latest: { revision: number } | undefined, thread: { revision: number }) => latest === undefined || thread.revision > latest.revision ? thread : latest, undefined)!
  for (const handle of ['builder', 'reviewer']) {
    const status = scaffold.ctx.agentTeam.members({ workspaceId: allWorkspace.id }).find((entry: { member: { handle: string } }) => entry.member.handle === handle)!
    const reader = scaffold.ctx.agents.get(status.member.sessionId)!
    await scaffold.ctx.agentTeam.readThreadForAgent(reader, {
      requestId: `m2-all-read-${handle}` as never, workspaceId: allWorkspace.id, threadRef: allThread.threadRef,
    })
  }

  // Branded-ref linkify: only refs the Host resolves become link controls.
  // An unknown UUID-shaped task ref and non-UUID `channel:` prose both stay
  // literal in the plain body; click-to-navigate is component-tested against
  // the resolved selectThread call.
  await channelComposer.fill('请复核 task:c0ffee00-1234-4c05-8a9e-6f2b1c9d7e21 与 channel:engineering 的口径')
  await page.getByRole('button', { name: '发送' }).click()
  const refMessage = page.locator('[data-team-channel] article').filter({ hasText: '请复核' })
  await refMessage.waitFor()
  expect(await refMessage.getByRole('button', { name: /task:c0ffee00|channel:engineering/ }).count()).toBe(0)
  await expect.poll(() => refMessage.textContent()).toContain('task:c0ffee00-1234-4c05-8a9e-6f2b1c9d7e21')
  expect(await refMessage.textContent()).toContain('channel:engineering')
  await page.screenshot({ path: join(UI04_SHOTS, 'message-ref-linkify.png'), fullPage: true })

  // Long-body clamp: a body past the deterministic character threshold starts
  // clamped behind 展开全文 — the preview keeps the full text mounted under an
  // alpha fade, expands in place, and collapses back through the same control.
  const longBody = '这是一条超长验收消息。'.repeat(60)
  await channelComposer.fill(longBody)
  await page.getByRole('button', { name: '发送' }).click()
  const longMessage = page.locator('[data-team-channel] article').filter({ hasText: '这是一条超长验收消息' })
  await longMessage.waitFor()
  const expandControl = longMessage.getByRole('button', { name: '展开全文' })
  await expandControl.waitFor()
  expect(await expandControl.getAttribute('aria-expanded')).toBe('false')
  await page.screenshot({ path: join(UI04_SHOTS, 'message-clamp-preview.png'), fullPage: true })
  // Keyboard path: the focused control expands with Enter and flips to 收起.
  await expandControl.focus()
  await page.keyboard.press('Enter')
  const collapseControl = longMessage.getByRole('button', { name: '收起' })
  await collapseControl.waitFor()
  expect(await collapseControl.getAttribute('aria-expanded')).toBe('true')
  expect(await longMessage.locator('[class*="messageClamp"]').count()).toBe(0)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-clamp-expanded.png'), fullPage: true })
  await collapseControl.click()
  await expect.poll(() => longMessage.locator('[class*="messageClamp"]').count()).toBe(1)
  await expect.poll(async () => await longMessage.getByRole('button', { name: '展开全文' }).getAttribute('aria-expanded')).toBe('false')
  // Narrow viewport: the clamped preview stays inside the viewport width.
  // Geometry polls until the fold settles — the collapsed attribute flips
  // before the conversation pane reaches its narrow width.
  await page.setViewportSize({ width: 390, height: 844 })
  const narrowClamp = longMessage.locator('[class*="messageClamp"]')
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await expect.poll(async () => (await narrowClamp.boundingBox())?.x ?? 999).toBeGreaterThanOrEqual(0)
  await expect.poll(async () => {
    const box = await narrowClamp.boundingBox()
    return box === null ? 999 : box.x + box.width
  }).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-clamp-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })

  // Attachment upload: the "+" picker takes real files, chips confirm the
  // selection, and the committed message renders the image thumbnail from the
  // Host cache — the full upload → ledger → display loop on the real app.
  // Upload a real screenshot-sized PNG so thumbnails and the zoom preview
  // demonstrate actual scaling, not a tiny fixture.
  const pngBytes = await readFile(join(UI02_SHOTS, 'sidebar-channels.png'))
  const uploadPath = join(BROWSER_ARTIFACTS, 'upload-fixture.png')
  await writeFile(uploadPath, pngBytes)
  // The "+" control must open the real file picker (not a command menu).
  const pickerPromise = page.waitForEvent('filechooser', { timeout: 5000 })
  await page.getByRole('button', { name: '添加附件' }).click()
  await pickerPromise
  await page.locator('[data-team-composer] input[type="file"]').setInputFiles([{ name: '验收截图.png', mimeType: 'image/png', buffer: pngBytes }])
  await page.getByText('验收截图.png').waitFor()
  await channelComposer.fill('这是带附件的验收消息')
  await page.screenshot({ path: join(UI04_SHOTS, 'composer-attachment-chip.png'), fullPage: true })
  await page.getByRole('button', { name: '发送' }).click()
  const attachmentMessage = page.locator('[data-team-channel] article').filter({ hasText: '这是带附件的验收消息' })
  await attachmentMessage.waitFor()
  await expect.poll(() => page.locator('[data-team-channel] article img[src^="data:image/png"]').count()).toBeGreaterThanOrEqual(1)
  await expect.poll(() => page.getByText('验收截图.png', { exact: true }).count()).toBe(0)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-attachment-thumbnail.png'), fullPage: true })
  // Zoom: clicking the thumbnail opens a wide preview card over the mask.
  await page.locator('[data-team-channel] article img[src^="data:image/png"]').first().click()
  await page.getByRole('dialog').waitFor()
  await expect.poll(() => page.getByRole('dialog').locator('img').count()).toBe(1)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-attachment-zoom.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect.poll(() => page.getByRole('dialog').count()).toBe(0)

  // Paste intake: a real Chromium paste carrying an image file is intercepted
  // before the textarea's native handling and joins the same chip flow, then
  // uploads through the same ledger path as the "+" picker above.
  await channelComposer.focus()
  await channelComposer.evaluate((el, bytes) => {
    const file = new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, [...pngBytes])
  await page.getByText('image.png').first().waitFor()
  await channelComposer.fill('这是粘贴上传的截图')
  await page.getByRole('button', { name: '发送' }).click()
  const pastedMessage = page.locator('[data-team-channel] article').filter({ hasText: '这是粘贴上传的截图' })
  await pastedMessage.waitFor()
  await expect.poll(() => pastedMessage.locator('img[src^="data:image/png"]').count()).toBeGreaterThanOrEqual(1)

  // Narrow-viewport literal ref row: the unresolvable refs stay plain text
  // and the row keeps its width without horizontal overflow.
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await refMessage.getByRole('button', { name: /task:c0ffee00|channel:engineering/ }).count()).toBe(0)
  expect((await refMessage.textContent())?.includes('task:c0ffee00-1234-4c05-8a9e-6f2b1c9d7e21')).toBe(true)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-ref-linkify-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-attachment-thumbnail-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  const channelGeometry = await page.locator('[data-team-channel]').evaluate(element => {
    const children = [...element.children].map(child => child.getBoundingClientRect())
    return children.map(rect => ({ top: rect.top, bottom: rect.bottom, height: rect.height }))
  })
  expect(channelGeometry).toHaveLength(3)
  expect(channelGeometry[0]!.bottom).toBeLessThanOrEqual(channelGeometry[1]!.top + 1)
  expect(channelGeometry[1]!.bottom).toBeLessThanOrEqual(channelGeometry[2]!.top + 1)
  expect(channelGeometry[1]!.height).toBeGreaterThan(200)
  await page.screenshot({ path: join(UI01_SHOTS, 'desktop-channel.png'), fullPage: true })
  await page.getByRole('button', { name: '管理成员' }).click()
  const channelMembersDialog = page.getByRole('dialog', { name: '频道成员' })
  await channelMembersDialog.waitFor()
  // The roster is the shared Member row: identity avatar, handle over its
  // description, and one 28px membership action per row. The guards below pin
  // that geometry — a row that silently loses its avatar, lets the copy
  // overflow its grid, or drops the 12/11px type steps is the regression this
  // surface keeps regrowing. The 12px radius is the list-row tier this row
  // shares with the sidebar rows it sits beside in the same app.
  const rosterRows = await channelMembersDialog.locator('[data-team-member-row]').evaluateAll(rows => rows.map(row => {
    const avatar = row.querySelector('[role="img"]')
    const handle = row.querySelector('strong')
    const description = row.querySelector('small')
    const action = row.querySelector('button')
    return {
      height: Math.round(row.getBoundingClientRect().height),
      radius: getComputedStyle(row).borderTopLeftRadius,
      avatarWidth: avatar === null ? 0 : Math.round(avatar.getBoundingClientRect().width),
      handle: handle?.textContent ?? '',
      handleSize: handle === null ? undefined : getComputedStyle(handle).fontSize,
      handleWeight: handle === null ? undefined : getComputedStyle(handle).fontWeight,
      descriptionSize: description === null ? undefined : getComputedStyle(description).fontSize,
      copyFits: description === null || description.parentElement === null
        ? false : description.parentElement.scrollWidth <= description.parentElement.clientWidth,
      actionWidth: action === null ? 0 : Math.round(action.getBoundingClientRect().width),
      actionHeight: action === null ? 0 : Math.round(action.getBoundingClientRect().height),
    }
  }))
  expect(rosterRows.length).toBeGreaterThanOrEqual(2)
  for (const row of rosterRows) {
    expect(row.avatarWidth).toBe(24)
    expect(row.height).toBeGreaterThanOrEqual(40)
    expect(row.radius).toBe('12px')
    expect(row.handle.startsWith('@')).toBe(true)
    expect(row.handleSize).toBe('12px')
    expect(row.handleWeight).toBe('500')
    expect(row.descriptionSize).toBe('11px')
    expect(row.copyFits).toBe(true)
    expect(row.actionWidth).toBeGreaterThanOrEqual(64)
    expect(row.actionHeight).toBe(28)
  }
  await page.screenshot({ path: join(UI04_SHOTS, 'channel-members-modal.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(async () => (await channelMembersDialog.boundingBox())?.width ?? 999).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'channel-members-modal-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  const narrowChannelFrame = page.locator('[data-sidebar-collapsed="true"]')
  await narrowChannelFrame.waitFor()
  await expect.poll(async () => (await narrowChannelFrame.locator(':scope > div').first().boundingBox())?.width ?? 999).toBeLessThanOrEqual(56)
  await expect.poll(async () => (await page.locator('[data-team-channel]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(330)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'narrow-channel.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })

  await channelComposer.fill('这是一条不作为任务的讨论')
  await expect.poll(() => asTaskToggle.getAttribute('aria-pressed')).toBe('false')
  await page.getByRole('button', { name: '发送' }).click()
  const tasklessMessage = page.locator('[data-team-channel] article').filter({ hasText: '这是一条不作为任务的讨论' })
  await tasklessMessage.waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  const tasklessChannelFrame = page.locator('[data-sidebar-collapsed="true"]')
  await tasklessChannelFrame.waitFor()
  await expect.poll(async () => (await tasklessChannelFrame.locator(':scope > div').first().boundingBox())?.width ?? 999).toBeLessThanOrEqual(56)
  await expect.poll(async () => (await page.locator('[data-team-channel]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(330)
  await tasklessMessage.getByRole('button', { name: '打开讨论' }).click()
  await page.getByRole('heading', { name: '讨论' }).waitFor()
  expect(await page.getByRole('button', { name: /Claims/ }).count()).toBe(0)
  expect(await page.getByRole('button', { name: '验收' }).count()).toBe(0)
  const promote = page.getByRole('button', { name: '转为 Task' })
  await promote.waitFor()
  const tasklessThreadFrame = page.locator('[data-sidebar-collapsed="true"]')
  await expect.poll(async () => (await tasklessThreadFrame.locator(':scope > div').first().boundingBox())?.width ?? 999).toBeLessThanOrEqual(56)
  await expect.poll(async () => (await page.locator('[data-team-thread]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(330)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'taskless-thread-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await promote.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: 'Task #2' }).waitFor()
  await page.getByText('Human 为此讨论创建了 Task').waitFor()
  expect(await page.getByRole('button', { name: '转为 Task' }).count()).toBe(0)
  await page.getByRole('button', { name: '返回频道' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()

  const workspace = scaffold.ctx.workspaceRegistry.list()[0]!
  const projection = scaffold.ctx.agentTeam.view({ workspaceId: workspace.id })
  const task = projection.tasks[0]!
  const statuses = scaffold.ctx.agentTeam.members({ workspaceId: workspace.id })
  const builder = statuses.find((status: { member: { handle: string } }) => status.member.handle === 'builder')!
  const reviewer = statuses.find((status: { member: { handle: string } }) => status.member.handle === 'reviewer')!
  const agent = scaffold.ctx.agents.get(builder.member.sessionId)!
  const reviewerAgent = scaffold.ctx.agents.get(reviewer.member.sessionId)!
  expect(scaffold.ctx.agentTeam.inboxForAgent(agent, { workspaceId: workspace.id })).toMatchObject({
    totalUnreadCount: 1,
    totalDirectCount: 1,
    items: [expect.objectContaining({ task: expect.objectContaining({ taskRef: task.taskRef }), directCount: 1 })],
  })

  await page.getByRole('button', { name: /Task #1/ }).click()
  const invitationComposer = page.getByRole('textbox', { name: '消息内容' })
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('消息内容')
  // Both calls are authored with '@': a bare name is prose the Host would not
  // deliver to, so only the chipified handle threads the invitee in.
  await invitationComposer.fill('请 @re')
  await page.getByRole('option', { name: /@reviewer/ }).click()
  await invitationComposer.fill(`${await invitationComposer.inputValue()}加入这个已有 Thread 并回复 Human @reviewer `)
  await invitationComposer.press('Enter')
  await page.getByRole('status').filter({ hasText: '再次发送' }).waitFor()
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('消息内容')
  await invitationComposer.press('Enter')
  await page.locator('[data-team-thread] article').filter({ hasText: '请 @reviewer 加入这个已有 Thread 并回复 Human @reviewer' }).waitFor()
  const reviewerInbox = scaffold.ctx.agentTeam.inboxForAgent(reviewerAgent, { workspaceId: workspace.id })
  expect(reviewerInbox).toMatchObject({ totalDirectCount: 1, items: [expect.objectContaining({
    task: expect.objectContaining({ taskRef: task.taskRef }), directCount: 1,
  })] })
  const reviewerRead = await scaffold.ctx.agentTeam.readThreadForAgent(reviewerAgent, {
    requestId: 'm2-06-reviewer-read' as never, workspaceId: workspace.id, taskRef: task.taskRef,
  })
  const reviewerReply = await scaffold.ctx.agentTeam.replyForAgent(reviewerAgent, {
    requestId: 'm2-06-reviewer-reply' as never,
    workspaceId: workspace.id,
    taskRef: task.taskRef,
    body: `reviewer 已读取邀请并回复 @human，关联 **${task.taskRef}**；风格记录 \`task::${task.taskRef.slice('task:'.length)}\`\n\n- 已核实邀请`,
    baseRevision: reviewerRead.thread.revision,
    recipients: [scaffold.ctx.agentTeam.status().humanMemberId],
  })
  expect(reviewerReply.kind).toBe('committed')

  // Rich Agent Markdown keeps its structure while branded refs become inline
  // Task links: the bold prose ref and the model-style backticked doubled
  // colon both relabel to the human-facing number with the canonical full ref
  // on hover, and no doubled colon survives into the rendered DOM.
  const agentRefLinks = page.locator('[data-team-thread] article').filter({ hasText: 'reviewer 已读取邀请' }).getByRole('button', { name: /Task #\d+/ })
  await agentRefLinks.first().waitFor()
  expect(await agentRefLinks.count()).toBe(2)
  // The Host lookup relabels the raw UUID into the human-facing number; the
  // full ref stays on hover.
  await expect.poll(() => agentRefLinks.first().textContent()).toBe('Task #1')
  await expect.poll(() => agentRefLinks.nth(1).textContent()).toBe('Task #1')
  expect(await agentRefLinks.first().getAttribute('title')).toBe(task.taskRef)
  expect(await agentRefLinks.nth(1).getAttribute('title')).toBe(task.taskRef)
  expect(await page.getByText(`task::${task.taskRef.slice('task:'.length)}`).count()).toBe(0)
  expect(await agentRefLinks.first().locator('xpath=ancestor::strong').count()).toBe(1)
  expect(await page.getByText('已核实邀请', { exact: true }).count()).toBe(1)

  // Long Agent Markdown under the clamp: publish an over-threshold reply and
  // compare the rendered root's computed font across the fold. The preview
  // keeps the whole body mounted, so a typography reset broken by the clamp
  // wrapper would render the preview text larger than the expanded body —
  // the exact regression this parity check pins.
  const longRead = await scaffold.ctx.agentTeam.readThreadForAgent(reviewerAgent, {
    requestId: 'm2-07-long-read' as never, workspaceId: workspace.id, taskRef: task.taskRef,
  })
  const longReply = await scaffold.ctx.agentTeam.replyForAgent(reviewerAgent, {
    requestId: 'm2-07-long-markdown-reply' as never,
    workspaceId: workspace.id,
    taskRef: task.taskRef,
    body: `## 长文折叠回归验收\n\n这一条 Agent Markdown 回复用于验证限高预览与展开态共用同一文字网格。${'折叠回归验证段落。'.repeat(60)}\n\n- 第一条:预览态按共享文字网格渲染，底部渐隐；\n- 第二条:展开态与预览态字号一致；\n- 第三条:收起后回到限高预览。\n\n\`task::${task.taskRef.slice('task:'.length)}\` 与 **加粗片段** 穿插在长正文里。`,
    baseRevision: longRead.thread.revision,
    recipients: [scaffold.ctx.agentTeam.status().humanMemberId],
  })
  expect(longReply.kind).toBe('committed')
  const longMarkdownRow = page.locator('[data-team-thread] article').filter({ hasText: '长文折叠回归验收' })
  await longMarkdownRow.waitFor()
  const markdownClamp = longMarkdownRow.locator('[class*="messageClamp"]')
  await markdownClamp.waitFor()
  const markdownRootFont = async (): Promise<string> =>
    await longMarkdownRow.locator('[class*="messageMarkdown"] > div').first().evaluate(node => getComputedStyle(node).fontSize)
  await expect.poll(markdownRootFont).toBe('14px')
  await longMarkdownRow.getByRole('button', { name: '展开全文' }).click()
  await expect.poll(async () => await longMarkdownRow.locator('[class*="messageClamp"]').count()).toBe(0)
  await expect.poll(markdownRootFont).toBe('14px')
  // The doubled-colon ref inside the long body still resolves to its chip
  // while the row is expanded — clamping must not break the post-render pass.
  await expect.poll(async () => await longMarkdownRow.getByRole('button', { name: /Task #\d+/ }).count()).toBeGreaterThanOrEqual(1)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-clamp-markdown-expanded.png'), fullPage: true })
  await longMarkdownRow.getByRole('button', { name: '收起' }).click()
  await expect.poll(async () => await longMarkdownRow.locator('[class*="messageClamp"]').count()).toBe(1)

  // The sender line is the secondary grade of the content axis: 13px/20px at
  // the default Settings size, and it grows with the body once that size is
  // raised, while the 11px time stays the fixed small grade. The axis is the
  // one variable the theme bootstrap publishes on body, so overriding it here
  // walks the same path a raised Settings size takes. Both ends of the
  // published range are walked: the shipped secondary tier is size − 1 up to
  // 14px and size − 2 above it, so 22px reads 20px/27px and 10px reads
  // 9px/16px — the default is asserted around them so the restore is covered.
  const senderName = page.locator('[data-team-thread] article [class*="nameRow"] strong').first()
  await senderName.waitFor()
  const senderMetrics = async (): Promise<string> => await senderName.evaluate(node => {
    const { fontSize, lineHeight } = getComputedStyle(node)
    return `${fontSize}/${lineHeight}`
  })
  const setAxis = async (size: string): Promise<void> => {
    await page.evaluate(value => { document.body.style.setProperty('--dsh-content-font-size', value) }, size)
  }
  await expect.poll(senderMetrics).toBe('13px/20px')
  const axisBefore = await page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size'))
  await setAxis('22px')
  await expect.poll(senderMetrics).toBe('20px/27px')
  await page.screenshot({ path: join(UI04_SHOTS, 'content-axis-22px.png') })
  await setAxis('10px')
  await expect.poll(senderMetrics).toBe('9px/16px')
  await page.screenshot({ path: join(UI04_SHOTS, 'content-axis-10px.png') })
  await page.evaluate(value => {
    if (value === '') document.body.style.removeProperty('--dsh-content-font-size')
    else document.body.style.setProperty('--dsh-content-font-size', value)
  }, axisBefore)
  await expect.poll(senderMetrics).toBe('13px/20px')

  await agentRefLinks.first().click()
  await page.getByRole('heading', { name: /Task #1/ }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await agentRefLinks.first().scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-ref-inline-markdown-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })

  // Human reply with attachment inside the Task Thread: the reply composer
  // offers the same "+" upload chain as the Channel composer.
  const replyPicker = page.waitForEvent('filechooser', { timeout: 5000 })
  await page.getByRole('button', { name: '添加附件' }).click()
  await replyPicker
  await page.locator('[data-team-composer] input[type="file"]').setInputFiles([{ name: 'thread-evidence.png', mimeType: 'image/png', buffer: pngBytes }])
  await page.getByText('thread-evidence.png').waitFor()
  await page.getByRole('textbox', { name: '消息内容' }).fill('这是带附件的 Thread 回复')
  await page.getByRole('button', { name: '发送' }).click()
  const replyWithFile = page.locator('article').filter({ hasText: '这是带附件的 Thread 回复' })
  await replyWithFile.waitFor()
  await expect.poll(() => replyWithFile.locator('img[src^="data:image/png"]').count()).toBeGreaterThanOrEqual(1)
  await expect.poll(() => page.getByText('thread-evidence.png', { exact: true }).count()).toBe(0)
  await page.screenshot({ path: join(UI04_SHOTS, 'thread-reply-attachment.png'), fullPage: true })

  await page.getByRole('button', { name: '返回频道' }).click()
  await page.getByRole('button', { name: /Task #1/ }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('button', { name: /Task #1/ }).click()
  // The authored @human mention renders as the canonical chip at its prose
  // position — the same occurrence the Host delivery scan resolves.
  await page.getByText('reviewer 已读取邀请并回复 @human，关联', { exact: false }).waitFor()

  // Open-onto-unread acceptance: while the Human is away from the Thread,
  // agents publish a multi-batch backlog, then the Human reopens it. The
  // Thread must land at the latest fact, drain every bounded batch
  // automatically (no continue-reading control), keep the unread boundary
  // rendered as information, and leave no unread remainder in the ledger.
  await page.getByRole('button', { name: '返回频道' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  const backlogBatch = async (label: string): Promise<void> => {
    const backlogRead = await scaffold.ctx.agentTeam.readThreadForAgent(reviewerAgent, {
      requestId: `m2-open-unread-${label}-read` as never, workspaceId: workspace.id, taskRef: task.taskRef,
    })
    const backlogReply = await scaffold.ctx.agentTeam.replyForAgent(reviewerAgent, {
      requestId: `m2-open-unread-${label}-reply` as never,
      workspaceId: workspace.id, taskRef: task.taskRef,
      body: `离线期间的批量更新 ${label}`,
      baseRevision: backlogRead.thread.revision,
    })
    if (backlogReply.kind !== 'committed') throw new Error(`backlog reply rejected: ${backlogReply.kind}`)
  }
  for (const label of ['一', '二', '三']) await backlogBatch(label)
  const preOpenInbox = scaffold.ctx.agentTeam.inbox({ workspaceId: workspace.id })
  const preOpenThread = preOpenInbox.items.find(item => item.task?.taskRef === task.taskRef)
  expect(preOpenThread?.unreadCount ?? 0).toBeGreaterThanOrEqual(3)
  // The Channel feed says what the Host says. The entry row carries this
  // reader's unread for its Thread, so the count lives in the row's accessible
  // name rather than only in the capsule's pixels — and it arrives without a
  // reload, because a Thread reply wakes the Channel scope.
  const unreadLineSelector = taskEntryLineSelector(1)
  const unreadEntryRow = taskEntryRow(page, 1)
  const unreadTotal = preOpenThread!.unreadCount
  await expect.poll(async () => await unreadEntryRow.getAttribute('aria-label'), { timeout: 10_000 })
    .toBe(`打开 Task #1（${unreadTotal} 条新动态）`)
  await expect.poll(async () => (await entryUnreadCapsule(page, unreadLineSelector))?.text ?? 'missing', { timeout: 10_000 })
    .toBe(unreadTotal > 99 ? '99+' : String(unreadTotal))
  // The Task is still live, so its door keeps reporting when the work last
  // moved — the one thing the feed's own order cannot say, since that order
  // follows each anchor Message rather than the Thread.
  await expect.poll(async () => (await unreadEntryRow.textContent())?.trim() ?? '').toContain('最近活动')
  const unreadCapsule = await entryUnreadCapsule(page, unreadLineSelector)
  // The capsule is decoration inside a labeled control, and it is a capsule:
  // a filled 18px pill whose radius covers its own height.
  expect(unreadCapsule?.hidden).toBe('true')
  expect(unreadCapsule?.shape.height).toBe('18px')
  expect(unreadCapsule?.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(Number.parseFloat(unreadCapsule?.shape.radius ?? '0')).toBeGreaterThanOrEqual(9)
  // The state leads its entry row: it opens where the body and the door text
  // open, on one x for every entry, instead of trailing a line the reader has
  // to cross the column for.
  const clusterEdges = await entryClusterEdges(page, unreadLineSelector)
  expect(clusterEdges).not.toBeNull()
  expect(clusterEdges!.cluster).toBe(clusterEdges!.row)
  expect(clusterEdges!.cluster).toBe(clusterEdges!.column)
  const stateColumn = await taskEntryClusterLefts(page)
  expect(stateColumn.length).toBeGreaterThanOrEqual(2)
  expect(new Set(stateColumn).size).toBe(1)
  await unreadEntryRow.scrollIntoViewIfNeeded()
  await settleAnimations(page)
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-entry-unread.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await unreadEntryRow.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await unreadEntryRow.focus()
  await settleAnimations(page)
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-entry-unread-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  // Keyboard: the entry is one control and the focus ring is the only chrome it
  // grows. Tab first — a script `focus()` alone leaves the browser's own
  // focus-visible heuristic cold, so the ring a keyboard reader sees would not
  // be painted and the screenshot would prove nothing.
  await page.keyboard.press('Tab')
  await unreadEntryRow.focus()
  await unreadEntryRow.scrollIntoViewIfNeeded()
  await settleAnimations(page)
  const ring = await focusRing(page, taskEntrySelector(1))
  expect(ring?.focusVisible).toBe(true)
  expect(ring?.outlineStyle).toBe('solid')
  expect(ring?.outlineWidth).toBe('2px')
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-entry-unread-focus.png'), fullPage: true })
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: /Task #1/ }).waitFor()
  await page.getByText('离线期间的批量更新 三', { exact: true }).waitFor()
  // The boundary stays as an informational separator even though reading is
  // fully automatic now.
  await page.getByText('以下是本次打开收到的更新').waitFor()
  await expect.poll(() => page.getByRole('button', { name: '继续阅读' }).count()).toBe(0)
  await expect.poll(() => page.getByRole('button', { name: '标记为已读' }).count()).toBe(0)
  const humanThreadScroller = page.locator('section[aria-label="消息时间线"]')
  await expect.poll(async () => {
    const box = await humanThreadScroller.boundingBox()
    if (box === null) return -1
    const atBottom = await humanThreadScroller.evaluate(element =>
      element.scrollHeight - element.scrollTop - element.clientHeight < 48)
    return atBottom ? 1 : 0
  }, { timeout: 10_000 }).toBe(1)
  await expect.poll(() => {
    const openInbox = scaffold.ctx.agentTeam.inbox({ workspaceId: workspace.id })
    const openThread = openInbox.items.find(item => item.task?.taskRef === task.taskRef)
    return openThread?.unreadCount ?? 0
  }, { timeout: 10_000 }).toBe(0)
  await page.screenshot({ path: join(UI05_SHOTS, 'open-onto-unread-drained.png'), fullPage: true })

  const replayedThread = scaffold.ctx.agentTeam.threadHistory({ workspaceId: workspace.id, taskRef: task.taskRef, limit: 100 })
  expect(JSON.stringify(replayedThread)).toContain('请 @reviewer 加入这个已有 Thread 并回复 Human @reviewer')
  expect(JSON.stringify(replayedThread)).toContain('reviewer 已读取邀请并回复 @human')

  await page.getByRole('button', { name: '返回频道' }).click()
  await page.getByRole('button', { name: '# delivery' }).click()
  // The durable read cleared this reader's unread, so the entry row comes back
  // to its bare label and drops the capsule.
  await expect.poll(async () => await taskEntryRow(page, 1).getAttribute('aria-label'), { timeout: 10_000 }).toBe('打开 Task #1')
  await expect.poll(async () => await entryUnreadCapsule(page, unreadLineSelector), { timeout: 10_000 }).toBeNull()
  await taskEntryRow(page, 1).click()
  const agentRead = await scaffold.ctx.agentTeam.readThreadForAgent(agent, {
    requestId: 'm2-06-agent-read' as never, workspaceId: workspace.id, taskRef: task.taskRef,
  })
  const agentClaim = await scaffold.ctx.agentTeam.changeClaimForAgent(agent, {
    requestId: 'm2-06-agent-claim' as never, workspaceId: workspace.id,
    taskRef: task.taskRef, action: 'claim', direction: '实现验收功能', baseRevision: agentRead.thread.revision,
  })
  if (agentClaim.kind !== 'committed') throw new Error(`Agent Claim was rejected: ${agentClaim.kind}`)

  await page.getByRole('button', { name: /Claims · 1/ }).click()
  await page.getByText('实现验收功能', { exact: true }).waitFor()
  await page.getByText(/认领了「实现验收功能」/).waitFor()
  await page.screenshot({ path: join(UI05_SHOTS, 'active-thread.png'), fullPage: true })

  const threadComposer = page.getByRole('textbox', { name: '消息内容' })
  await threadComposer.fill('@re')
  await page.getByRole('option', { name: /@reviewer/ }).click()
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-mention-menu.png'), fullPage: true })
  await threadComposer.fill('Human 已检查 Thread')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByText('Human 已检查 Thread', { exact: true }).waitFor()
  const agentReviewRead = await scaffold.ctx.agentTeam.readThreadForAgent(agent, {
    requestId: 'm2-06-agent-review-read' as never, workspaceId: workspace.id, taskRef: task.taskRef,
  })
  await scaffold.ctx.agentTeam.changeClaimForAgent(agent, {
    requestId: 'm2-06-agent-done' as never, workspaceId: workspace.id, taskRef: task.taskRef,
    claimRef: agentClaim.claim.claimRef, action: 'done', baseRevision: agentReviewRead.thread.revision,
  })
  await scaffold.ctx.agentTeam.readThread({
    requestId: 'm2-06-human-review-read' as never, workspaceId: workspace.id, taskRef: task.taskRef,
  })
  // One self-healing loop: press the live 验收 control whenever the Task is
  // still open, then wait for the ledger to show the committed acceptance.
  const acceptButtonsState = (): Promise<readonly { readonly text: string | null; readonly disabled: boolean }[]> =>
    page.evaluate(() => [...document.querySelectorAll('button')]
      .map(button => ({ text: button.textContent?.trim(), disabled: button.disabled }))
      .filter(entry => entry.text === '验收'))
  await acceptButtonsState().then(buttons => expect(buttons.length).toBeGreaterThan(0))
  await expect.poll(async () => {
    for (const state of await acceptButtonsState()) {
      if (!state.disabled) await page.locator(`button:text-is("${state.text}")`).first().click()
    }
    const currentProjection = scaffold!.ctx.agentTeam.view({ workspaceId: workspace.id })
    const currentTask = currentProjection.tasks.find(candidate => candidate.taskRef === task.taskRef)
    const currentClaims = currentProjection.claims.filter(candidate => candidate.taskRef === task.taskRef)
    const alert = await page.getByRole('alert').allTextContents()
    return JSON.stringify({ task: currentTask, claims: currentClaims, alert })
  }).toContain('"resolution":"accepted"')
  await page.getByRole('button', { name: '重新打开' }).waitFor()
  const acceptedComposer = page.getByRole('textbox', { name: '消息内容' })
  await acceptedComposer.waitFor()
  await acceptedComposer.fill('验收后继续讨论')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByText('验收后继续讨论', { exact: true }).waitFor()
  await page.screenshot({ path: join(UI01_SHOTS, 'desktop-thread.png'), fullPage: true })
  await page.screenshot({ path: join(UI05_SHOTS, 'accepted-thread.png'), fullPage: true })
  // Early acceptance drill: reopen puts the Task back to in_progress; a fresh
  // Agent Claim re-creates the exact precondition for accepting over open work.
  await page.getByRole('button', { name: '重新打开' }).click()
  // Direct Host calls below must observe the committed open state, not the
  // optimistic-free UI in flight.
  await expect.poll(async () =>
    JSON.stringify(scaffold!.ctx.agentTeam.view({ workspaceId: workspace.id }).tasks.find(candidate => candidate.taskRef === task.taskRef)))
    .toContain('"resolution":"open"')
  const reopenRead = await scaffold.ctx.agentTeam.readThreadForAgent(agent, {
    requestId: 'm2-06-agent-reopen-read' as never, workspaceId: workspace.id, taskRef: task.taskRef,
  })
  const reclaim = await scaffold.ctx.agentTeam.changeClaimForAgent(agent, {
    requestId: 'm2-06-agent-reclaim' as never, workspaceId: workspace.id,
    taskRef: task.taskRef, action: 'claim', direction: '补齐回归清单', baseRevision: reopenRead.thread.revision,
  })
  if (reclaim.kind !== 'committed') throw new Error(`Agent re-Claim was rejected: ${reclaim.kind}`)
  await page.getByRole('button', { name: '验收', exact: true }).click()
  const acceptDialog = page.getByRole('dialog', { name: '提前验收任务' })
  await expect.poll(() => acceptDialog.count()).toBe(1)
  await expect.poll(() => acceptDialog.getByText(/将验收本 Task，并把以下 1 个未完成的 Claim 一并标记为完成/).count()).toBe(1)
  await expect.poll(() => acceptDialog.getByText('@builder · 补齐回归清单').count()).toBe(1)
  await page.screenshot({ path: join(UI05_SHOTS, 'accept-confirm-dialog.png'), fullPage: true })
  // Snapshot before any interaction; compared after the Escape cancels below.
  const tasksBeforeCancel = JSON.stringify(scaffold.ctx.agentTeam.view({ workspaceId: workspace.id }).tasks.find(candidate => candidate.taskRef === task.taskRef))

  // Same confirm beat at phone size for the narrow layout.
  const escapeDialog = async (): Promise<void> => {
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: '提前验收任务' }).count()).toBe(0)
  }
  await escapeDialog()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '验收', exact: true }).click()
  await expect.poll(() => acceptDialog.count()).toBe(1)
  await page.screenshot({ path: join(UI05_SHOTS, 'narrow-accept-confirm-dialog.png'), fullPage: true })
  await escapeDialog()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1440, height: 960 })

  // The ledger stayed untouched through both Escape cancels.
  expect(JSON.stringify(scaffold.ctx.agentTeam.view({ workspaceId: workspace.id }).tasks.find(candidate => candidate.taskRef === task.taskRef))).toBe(tasksBeforeCancel)

  // Confirm completes the open Claim inside the same accept operation.
  await page.getByRole('button', { name: '验收', exact: true }).click()
  await expect.poll(() => acceptDialog.count()).toBe(1)
  await acceptDialog.locator('button').filter({ hasText: '验收' }).last().click()
  await expect.poll(async () =>
    JSON.stringify(scaffold.ctx.agentTeam.view({ workspaceId: workspace.id }).claims.filter(candidate => candidate.taskRef === task.taskRef && candidate.direction === '补齐回归清单')))
    .toContain('"state":"done"')
  await expect.poll(async () =>
    JSON.stringify(scaffold.ctx.agentTeam.view({ workspaceId: workspace.id }).tasks.find(candidate => candidate.taskRef === task.taskRef)))
    .toContain('"resolution":"accepted"')
  await page.screenshot({ path: join(UI05_SHOTS, 'early-accepted-thread.png'), fullPage: true })
  // Restore the pre-drill state so the following closed-thread beats run as before.
  await page.getByRole('button', { name: '重新打开' }).waitFor()

  // The header offers exactly one of 打开/关闭 actions per resolution, so the
  // restored open state comes from this reopen before the close beat.
  await page.getByRole('button', { name: '重新打开' }).click()
  await page.getByRole('button', { name: '关闭任务' }).waitFor()
  await page.getByRole('button', { name: '关闭任务' }).click()
  // The closed Thread swaps the composer for the explanatory notice with its reopen action.
  await page.getByText('任务已关闭，重新打开后可继续讨论').waitFor()
  await expect.poll(() => page.getByRole('textbox', { name: '消息内容' }).count()).toBe(0)
  await page.screenshot({ path: join(UI05_SHOTS, 'closed-thread.png'), fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  const collapsedFrame = page.locator('[data-sidebar-collapsed="true"]')
  await collapsedFrame.waitFor()
  await expect.poll(async () => (await collapsedFrame.locator(':scope > div').first().boundingBox())?.width ?? 999).toBeLessThanOrEqual(56)
  await page.screenshot({ path: join(UI01_SHOTS, 'narrow-thread.png'), fullPage: true })
  await page.screenshot({ path: join(UI02_SHOTS, 'narrow-team-rail.png'), fullPage: true })
  await page.screenshot({ path: join(UI05_SHOTS, 'narrow-closed-thread.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1440, height: 960 })

  await page.getByRole('button', { name: '返回频道' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await expect.poll(() => page.getByText('Human 已检查 Thread', { exact: true }).count()).toBe(0)
  await expect.poll(() => page.getByText('验收后继续讨论', { exact: true }).count()).toBe(0)
  // A resolved Task's door stops printing when the work last moved: a done or
  // closed status word says nothing is moving, and the instant would only repeat
  // the moment it resolved on every finished row. The Thread has follow-up facts
  // either way, so the precise instant stays on the control's title, one hover
  // away.
  const closedEntry = taskEntryRow(page, 1)
  await expect.poll(async () => (await closedEntry.textContent())?.trim() ?? '').toBe('Task #1')
  await expect.poll(async () => await closedEntry.getAttribute('title') ?? '').toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  await closedEntry.scrollIntoViewIfNeeded()
  await settleAnimations(page)
  await page.screenshot({ path: join(UI05_SHOTS, 'resolved-task-entry.png'), fullPage: true })
  // The door got shorter, so the narrow column has strictly less to wrap: the
  // same row must still fit without a horizontal scrollbar.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await closedEntry.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI05_SHOTS, 'narrow-resolved-task-entry.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  await page.getByRole('button', { name: '成员', exact: true }).click()
  await page.getByRole('dialog', { name: '成员' }).screenshot({ path: join(UI01_SHOTS, 'global-members.png') })
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  await page.reload()
  await page.getByRole('button', { name: '# delivery' }).waitFor({ timeout: 20_000 })
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dsh.agent-team.navigation'))).toContain('"mode":"team"')
  // Browser restoration returns to the last selected Channel instead of the
  // empty Team welcome surface.
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await expect.poll(() => page.getByText('Human 已检查 Thread', { exact: true }).count()).toBe(0)
  await expect.poll(() => page.getByText('验收后继续讨论', { exact: true }).count()).toBe(0)
  await expect.poll(() => page.getByText('关闭后继续讨论', { exact: true }).count()).toBe(0)
  await page.getByRole('button', { name: '对话' }).click()
  await expect.poll(() => newSessionButton.isVisible()).toBe(true)
  await expect.poll(() => brandButton.isVisible()).toBe(true)
  // Leaving Team closes any embedded Member Session view and restores the
  // session the Human came from, so the ordinary shell shows an ordinary
  // conversation composer rather than a stranded Member Session.
  const restoredComposer = page.locator('[data-composer-input][contenteditable="true"]').first()
  await restoredComposer.waitFor({ timeout: 20_000 })
  await expect.poll(() => page.locator('[data-team-channel]').count()).toBe(0)
  // Team's globally registered sources return no ordinary candidates; shipped
  // command/skill discovery takes the restored ordinary Session back over.
  await restoredComposer.fill('/')
  await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(0)
  expect(await page.getByRole('option', { name: '@reviewer' }).count()).toBe(0)
  await restoredComposer.fill('')
  await page.screenshot({ path: join(UI01_SHOTS, 'restored-conversations.png'), fullPage: true })

  // Archival beats: both danger entries hide their entity behind a
  // destructive confirm that states the no-restore contract. The archived
  // Channel leaves the sidebar; the archived Member leaves the agents panel,
  // and the Host side disposes its session and archives it from grouping
  // surfaces while the private memory stays on disk.
  await page.getByRole('button', { name: '团队' }).click()
  // Restoration returns to the last open surface; the sidebar row is the
  // stable entry back onto the Channel page regardless of the restored route.
  await page.getByRole('button', { name: '# delivery' }).waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor({ timeout: 20_000 })
  const rampRow = page.getByRole('button', { name: '# ramp' })
  await rampRow.hover()
  await page.getByRole('button', { name: 'ramp 的操作' }).click()
  await page.getByRole('menuitem', { name: '归档频道' }).click()
  const rampArchiveDialog = page.getByRole('dialog', { name: '归档频道：ramp' })
  await rampArchiveDialog.waitFor()
  expect(await rampArchiveDialog.textContent()).toContain('暂无恢复入口')
  await page.screenshot({ path: join(UI06_SHOTS, 'channel-archive-modal.png'), fullPage: true })
  await rampArchiveDialog.getByRole('button', { name: '归档频道', exact: true }).click()
  await expect.poll(() => page.getByRole('button', { name: '# ramp' }).count()).toBe(0)
  const archiveWorkspace = scaffold.ctx.workspaceRegistry.list()[0]!
  const archivedChannel = scaffold.ctx.agentTeam.view({ workspaceId: archiveWorkspace.id }).channels.find((channel: { name: string }) => channel.name === 'ramp')
  expect(archivedChannel).toBeUndefined()

  const archiveableRow = page.locator('[class*="agentRow"]').filter({ hasText: 'builder' }).first()
  await archiveableRow.hover()
  await page.getByRole('button', { name: 'builder 的操作' }).click()
  await page.getByRole('menuitem', { name: '归档', exact: true }).click()
  const builderArchiveDialog = page.getByRole('dialog', { name: '归档 Agent：builder' })
  await builderArchiveDialog.waitFor()
  expect(await builderArchiveDialog.textContent()).toContain('暂无恢复入口')
  await page.screenshot({ path: join(UI06_SHOTS, 'agent-archive-modal.png'), fullPage: true })
  await builderArchiveDialog.getByRole('button', { name: '归档', exact: true }).click()
  await expect.poll(() => page.locator('[class*="agentRow"]').filter({ hasText: 'builder' }).count()).toBe(0)
  const archivedStatuses = scaffold.ctx.agentTeam.members({ workspaceId: archiveWorkspace.id })
  const archivedBuilder = archivedStatuses.find((status: { member: { handle: string } }) => status.member.handle === 'builder')!
  expect(archivedBuilder.availability).toBe('archived')
  expect(archivedBuilder.member.state).toBe('archived')
  // The Session archival settles behind the Client wake; poll the registry.
  await expect.poll(() => scaffold.ctx.workspaceRegistry.archivedSessionIds.includes(archivedBuilder.member.sessionId)).toBe(true)
  // The archived Member's row menu and mention candidates are gone, and the
  // members modal roster no longer lists it.
  await page.getByRole('button', { name: '成员', exact: true }).click()
  const archiveMembersDialog = page.getByRole('dialog', { name: '成员' })
  await archiveMembersDialog.waitFor()
  expect(await archiveMembersDialog.getByText('@builder').count()).toBe(0)
  await archiveMembersDialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '对话' }).click()
  await expect.poll(() => page.locator('[data-team-channel]').count()).toBe(0)

  // The shipped global panel rail (the Plugins entry) addresses the profile,
  // not the Team: ordinary conversations show it, Team mode stands it down —
  // present in the DOM on both sides, visible only on one.
  const globalPanelsNav = page.locator('nav[class*="panelList"]')
  await expect.poll(() => globalPanelsNav.count()).toBe(1)
  await expect.poll(() => globalPanelsNav.isVisible()).toBe(true)
  // Selecting that panel keys the shell's single main cell to it. Team mode owns
  // that cell, so a Team destination opening behind the foreign page would move
  // the sidebar alone — the reported failure. Enter Team mode from here, and the
  // assertions below prove the column came back rather than merely covering it.
  const pluginsEntry = globalPanelsNav.getByRole('button', { name: '插件' })
  await pluginsEntry.click()
  await expect.poll(() => pluginsEntry.getAttribute('aria-current')).toBe('page')
  const pluginPanel = page.locator('[data-plugin-panel]')
  await pluginPanel.waitFor()

  // The plugin page lists this very bundle under a matching name ("智能体团队"),
  // so the Team entry is addressed exactly while that page is on screen.
  const enterTeamKeyboard = page.getByRole('button', { name: '团队', exact: true })
  await enterTeamKeyboard.focus()
  await expect.poll(() => enterTeamKeyboard.evaluate(element => element === document.activeElement)).toBe(true)
  await expect.poll(() => page.getByRole('button', { name: '团队', exact: true }).getAttribute('data-team-action')).toBe('enter')
  await enterTeamKeyboard.press('Enter')
  await expect.poll(() => page.getByRole('button', { name: '成员', exact: true }).count()).toBe(1)
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  // The selected global panel is unmounted, not sitting behind the Team seat.
  await expect.poll(() => pluginPanel.count()).toBe(0)
  await expect.poll(() => globalPanelsNav.count()).toBe(1)
  await expect.poll(() => globalPanelsNav.isVisible()).toBe(false)

  const membersKeyboard = page.getByRole('button', { name: '成员', exact: true })
  await membersKeyboard.focus()
  await membersKeyboard.press('Space')
  const membersDialog = page.getByRole('dialog', { name: '成员' })
  await membersDialog.waitFor()
  await expect.poll(() => membersDialog.locator('[tabindex="-1"]').evaluate(element => element === document.activeElement)).toBe(true)
  // The read-only roster rides the same shared Member row, minus the action
  // track: same avatar, same handle/description steps, no reserved button hole.
  // The panel mounts loading, so the roster is awaited before it is measured.
  await expect.poll(() => membersDialog.locator('[data-team-member-row]').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
  const readOnlyRows = await membersDialog.locator('[data-team-member-row]').evaluateAll(rows => rows.map(row => ({
    avatar: Math.round((row.querySelector('[role="img"]')?.getBoundingClientRect().width ?? 0)),
    action: row.querySelectorAll('button').length,
    handle: row.querySelector('strong')?.textContent ?? '',
    description: row.querySelector('small')?.textContent ?? '',
  })))
  for (const row of readOnlyRows) {
    expect(row.avatar).toBe(24)
    expect(row.action).toBe(0)
    expect(row.handle.startsWith('@')).toBe(true)
    expect(row.description.length).toBeGreaterThan(0)
  }
  await page.screenshot({ path: join(UI06_SHOTS, 'members-modal-desktop.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect.poll(() => membersKeyboard.evaluate(element => element === document.activeElement)).toBe(true)
  // Narrow viewport: the breakpoint unmounts sidebar panels (dialog state
  // included), so the check re-opens the dialog from the narrow-expanded
  // sidebar after the collapse has settled.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await page.getByRole('button', { name: '打开侧边栏' }).click()
  const narrowMembersKeyboard = page.getByRole('button', { name: '成员', exact: true })
  await narrowMembersKeyboard.focus()
  await narrowMembersKeyboard.press('Space')
  const narrowMembersDialog = page.getByRole('dialog', { name: '成员' })
  await narrowMembersDialog.waitFor()
  const membersBox = await narrowMembersDialog.boundingBox()
  expect(membersBox).not.toBeNull()
  expect(membersBox!.x).toBeGreaterThanOrEqual(0)
  expect(membersBox!.y).toBeGreaterThanOrEqual(0)
  expect(membersBox!.x + membersBox!.width).toBeLessThanOrEqual(390)
  expect(membersBox!.y + membersBox!.height).toBeLessThanOrEqual(844)
  await page.screenshot({ path: join(UI06_SHOTS, 'members-modal-narrow.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect.poll(() => narrowMembersKeyboard.evaluate(element => element === document.activeElement)).toBe(true)
  await page.setViewportSize({ width: 1440, height: 960 })

  // ── Human Inbox (收件箱) ─────────────────────────────────────────────────
  // mention Human → badge; an Agent's ordinary reply on a followed Thread →
  // badge too; open Inbox → row; open Thread → badge/row clear. Deltas ride a
  // fresh taskless Thread so the assertions stay independent of earlier
  // segments.
  const inboxWorkspace = scaffold.ctx.workspaceRegistry.list()[0]!
  const inboxCard = page.locator('button[class*="inboxCard"]')
  const railInboxButton = page.locator('nav[class*="railWorkspace"] button[aria-label*="收件箱"]')
  // The sidebar states unread as a mark rather than a number, so the entry's own
  // accessible name is the only place the quantity is written down — which is how
  // a screen reader reaches it, and why this reads the name instead of a visible
  // digit. `null` is the zero case: no count in the name at all.
  const sidebarUnread = async (): Promise<string | null> => {
    const scope = await inboxCard.count() > 0 ? inboxCard : railInboxButton
    const match = /(\d+)/.exec((await scope.getAttribute('aria-label')) ?? '')
    return match === null ? null : match[1]
  }
  /** The visible half of the same fact: the dot stands exactly while the name states a count. */
  const sidebarDot = async (): Promise<number> => {
    const scope = await inboxCard.count() > 0 ? inboxCard : railInboxButton
    return await scope.locator('[data-team-inbox-dot]').count()
  }
  const expectSidebarUnread = async (expected: string | null): Promise<void> => {
    await expect.poll(async () => await sidebarUnread(), { timeout: 10_000 }).toBe(expected)
    await expect.poll(async () => await sidebarDot()).toBe(expected === null ? 0 : 1)
  }
  await inboxCard.waitFor()
  const baseUnread = scaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id }).totalUnreadCount
  await expectSidebarUnread(baseUnread === 0 ? null : String(baseUnread))

  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  const inboxComposer = page.getByRole('textbox', { name: '消息内容' })
  await inboxComposer.fill('请 Human 决策的讨论')
  await page.getByRole('button', { name: '发送' }).click()
  await page.locator('[data-team-channel] article').filter({ hasText: '请 Human 决策的讨论' }).waitFor()
  const inboxChannels = scaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id }).channels
  const deliveryChannel = inboxChannels.find((channel: { name: string }) => channel.name === 'delivery')!
  // 'after' is the oldest window; the fresh opener is the newest top-level fact.
  const inboxView = scaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id, channelRef: deliveryChannel.channelRef, topLevelOnly: true, includeActivities: false, direction: 'before', limit: 50 })
  const inboxThreadItem = inboxView.items.find((item: { message: { body: string } }) => item.message.body === '请 Human 决策的讨论')!
  const inboxThreadRef = (inboxThreadItem.thread as { threadRef: string }).threadRef
  // builder is archived earlier in the journey; reviewer stays an active
  // delivery Member and drives the mention on the Human's behalf.
  const inboxReviewer = scaffold.ctx.agentTeam.members({ workspaceId: inboxWorkspace.id }).find((entry: { member: { handle: string } }) => entry.member.handle === 'reviewer')!
  const inboxAgent = scaffold.ctx.agents.get(inboxReviewer.member.sessionId)!
  const inboxRead = await scaffold.ctx.agentTeam.readThreadForAgent(inboxAgent, {
    requestId: 'm2-09-builder-read' as never, workspaceId: inboxWorkspace.id, threadRef: inboxThreadRef as never,
  })
  const inboxMention = await scaffold.ctx.agentTeam.replyForAgent(inboxAgent, {
    requestId: 'm2-09-builder-mention' as never,
    workspaceId: inboxWorkspace.id,
    threadRef: inboxThreadRef as never,
    body: '需要 Human 拍板：默认走 A 方案',
    baseRevision: inboxRead.thread.revision,
    recipients: [scaffold.ctx.agentTeam.status().humanMemberId],
  })
  expect(inboxMention.kind).toBe('committed')
  const mentionedInbox = scaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id })
  expect(mentionedInbox.totalUnreadCount).toBe(baseUnread + 1)
  // The row preview is the Thread anchor's first line — the Human's own opener.
  expect(mentionedInbox.items.find((item: { thread: { threadRef: string } }) => item.thread.threadRef === inboxThreadRef)).toMatchObject({
    channelName: 'delivery', previewText: '请 Human 决策的讨论',
  })
  const inboxRow = page.locator('[data-team-inbox] button').filter({ hasText: '请 Human 决策的讨论' })
  await expectSidebarUnread(String(baseUnread + 1))
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-dot-desktop.png'), fullPage: true })

  // An ordinary Agent reply needs no mention: the Human follows their own
  // Thread, so it lands in the queue and moves the badge by its own fact.
  const inboxOrdinary = await scaffold.ctx.agentTeam.replyForAgent(inboxAgent, {
    requestId: 'm2-09-builder-ordinary' as never,
    workspaceId: inboxWorkspace.id,
    threadRef: inboxThreadRef as never,
    body: '继续推进实现细节，无需 Human 介入',
    baseRevision: inboxMention.thread.revision,
  })
  expect(inboxOrdinary.kind).toBe('committed')
  expect(scaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id }).totalUnreadCount).toBe(baseUnread + 2)
  await expectSidebarUnread(String(baseUnread + 2))

  // A second Thread the Human opens and follows whose only unread fact is an
  // Agent reply that names nobody. The queue now mixes the two kinds of unread
  // the surface has to keep apart: one row that named the reader, one that
  // merely moved, both waiting.
  await inboxComposer.fill('工程侧同步，无需决策')
  await page.getByRole('button', { name: '发送' }).click()
  await page.locator('[data-team-channel] article').filter({ hasText: '工程侧同步，无需决策' }).waitFor()
  const plainView = scaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id, channelRef: deliveryChannel.channelRef, topLevelOnly: true, includeActivities: false, direction: 'before', limit: 50 })
  const plainThreadRef = (plainView.items.find((item: { message: { body: string } }) => item.message.body === '工程侧同步，无需决策').thread as { threadRef: string }).threadRef
  const plainRead = await scaffold.ctx.agentTeam.readThreadForAgent(inboxAgent, {
    requestId: 'm2-09-plain-read' as never, workspaceId: inboxWorkspace.id, threadRef: plainThreadRef as never,
  })
  const plainReply = await scaffold.ctx.agentTeam.replyForAgent(inboxAgent, {
    requestId: 'm2-09-plain-reply' as never,
    workspaceId: inboxWorkspace.id,
    threadRef: plainThreadRef as never,
    body: '收到，先按计划推进',
    baseRevision: plainRead.thread.revision,
  })
  expect(plainReply.kind).toBe('committed')
  expect(scaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id }).totalUnreadCount).toBe(baseUnread + 3)
  await expectSidebarUnread(String(baseUnread + 3))

  // Narrow rail: 收件箱 → Channels → Agents, unread marked on the first icon, and
  // the icon is a destination that opens the Inbox page and expands the sidebar.
  await page.setViewportSize({ width: 390, height: 844 })
  const inboxRail = page.locator('nav[class*="railWorkspace"]')
  await inboxRail.waitFor()
  const railLabels = await inboxRail.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
  expect(railLabels).toEqual([`收件箱，${baseUnread + 3} 条未读`, '频道', 'Agents'])
  await expectSidebarUnread(String(baseUnread + 3))
  // The dot replaced the number on the surface, so the rail's hover hint is where
  // a reader still meets the quantity without opening the page: the same name the
  // control carries, shown on demand. Hovering also proves the hint is not the
  // only place it lives — the assertion above reads it with nothing hovered.
  await railInboxButton.hover()
  const railHint = page.locator('[role="tooltip"]')
  await expect.poll(async () => await railHint.count()).toBe(1)
  expect(await railHint.textContent()).toBe(`收件箱，${baseUnread + 3} 条未读`)
  // Back off the control so the settled screenshot shows the rail, not the bubble.
  await page.mouse.move(300, 600)
  await expect.poll(async () => await railHint.count()).toBe(0)
  // The rail settles after the collapse crossfade; screenshot the settled rail.
  await settleAnimations(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-narrow-rail.png'), fullPage: true })
  await railInboxButton.click()
  await page.locator('[data-team-inbox]').waitFor()
  await expect.poll(() => page.locator('button[class*="inboxCard"]').count()).toBe(1)
  await expect.poll(async () => await inboxRow.count()).toBe(1)
  await expect.poll(async () => await inboxRow.textContent()).toContain('#delivery')
  const plainRow = page.locator('[data-team-inbox] button').filter({ hasText: '工程侧同步，无需决策' })
  await expect.poll(async () => await plainRow.count()).toBe(1)
  // The queue carries the shared header band plus its own count line, and that
  // line is now segments the reader scans rather than a clause: the Thread
  // count, the Host's whole unread slice, and — only while the queue holds one
  // — the mentions inside it.
  const inboxPage = page.locator('[data-team-inbox]')
  await expect.poll(async () => await inboxPage.getByRole('heading', { name: '收件箱' }).count()).toBe(1)
  // The page holds two slices, so each one is counted on its own: the queue
  // shows every Thread the Host admits with unread, and the 「最近活跃」 tail
  // shows what the Client caps it at. One whole-page row count would have to
  // move every time an unrelated Thread joins the tail — which is exactly what
  // a slice the reader's own writing admits does. Each slice is found by its own
  // heading text: `filter({ has <locator> })` matches nothing in this page —
  // even `has: locator('h2')` resolves to zero sections — while the text form
  // this file already uses does.
  const queueSection = inboxPage.locator('section').filter({ hasText: '需要我' })
  const recentSection = inboxPage.locator('section').filter({ hasText: '最近活跃' })
  const queue = scaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id })
  await expect.poll(async () => await queueSection.locator('button[class*="row"]').count()).toBe(queue.items.length)
  await expect.poll(async () => await recentSection.locator('button[class*="row"]').count()).toBeLessThanOrEqual(5)
  const queueUnread = queue.items.reduce((sum, item) => sum + item.unreadCount, 0)
  const queueMentions = queue.items.reduce((sum, item) => sum + item.directCount, 0)
  await expect.poll(async () => await inboxPage.getByText(`${queue.items.length} 个 Thread`, { exact: true }).count()).toBe(1)
  await expect.poll(async () => await inboxPage.getByText(`${queueUnread} 条未读`, { exact: true }).count()).toBe(1)
  await expect.poll(async () => await inboxPage.getByText(`${queueMentions} 条提及`, { exact: true }).count()).toBe(1)
  // The row time is the newest unread fact's instant (the Human follows their
  // own opener, so the ordinary inter-chat reply advances it past the mention).
  await expect.poll(async () => await inboxRow.locator('time').count()).toBe(1)
  // A mention raised today is a bare clock time — no day word to print down
  // every row — and the precise instant stays on the element behind that label.
  const inboxRowTime = inboxRow.locator('time').first()
  await expect.poll(async () => await inboxRowTime.textContent()).toMatch(/^\d{2}:\d{2}$/)
  expect(await inboxRowTime.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  // The count closes the row's identity line, and it is where the split between
  // a named Thread and one that merely moved reaches assistive tech: the row's
  // visible text stays the Thread itself, never a second count.
  const namedCapsule = inboxRow.locator('[data-team-count-badge]')
  const plainCapsule = plainRow.locator('[data-team-count-badge]')
  await expect.poll(async () => await namedCapsule.getAttribute('aria-label')).toBe('2 条未读，其中 1 条提及')
  await expect.poll(async () => await plainCapsule.getAttribute('aria-label')).toBe('1 条未读')
  expect(await namedCapsule.getAttribute('title')).toBe('2 条未读，其中 1 条提及')
  expect(await namedCapsule.textContent()).toBe('2')
  expect(await plainCapsule.textContent()).toBe('1')
  // A squeezed seat: the provenance shortens with an ellipsis instead of folding
  // one row into three lines, nothing spills out of a row, and the page still
  // does not scroll sideways. The clock keeps the identity's own line wherever
  // the line has the room to draw it: a line too narrow for the count and the
  // clock together yields the clock entirely (inbox.module.css), and that face
  // of the row is asserted where the seat has the room again — the collapsed
  // rail below.
  const narrowFit = await inboxPage.evaluate(root => {
    const rows = [...root.querySelectorAll('button[class*="row"]')] as HTMLElement[]
    const crumbs = rows.map(row => row.querySelector('[class*="rowCrumb"]') as HTMLElement)
    const times = rows.map(row => row.querySelector('time') as HTMLElement)
    const crumbStyle = getComputedStyle(crumbs[0]!)
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rowSpill: Math.max(...rows.map(row => row.scrollWidth - row.clientWidth)),
      crumbNowrap: crumbStyle.whiteSpace,
      crumbEllipsis: crumbStyle.textOverflow,
      clockOnIdentityLine: rows.every((_, index) => {
        // A yielded clock draws no box at all, which is this row's own answer to
        // a line that cannot hold it; a drawn one shares the identity's line.
        if (times[index]!.getBoundingClientRect().width === 0) return true
        return Math.abs(crumbs[index]!.getBoundingClientRect().top - times[index]!.getBoundingClientRect().top) < 4
      }),
      rowHeight: Math.round(rows[0]!.getBoundingClientRect().height),
    }
  })
  expect(narrowFit.documentOverflow).toBeLessThanOrEqual(0)
  expect(narrowFit.rowSpill).toBeLessThanOrEqual(0)
  expect(narrowFit.crumbNowrap).toBe('nowrap')
  expect(narrowFit.crumbEllipsis).toBe('ellipsis')
  expect(narrowFit.clockOnIdentityLine).toBe(true)
  // A wrapped provenance costs this seat three lines' worth of row; two lines
  // with a clipped one is the shape the row keeps now.
  expect(narrowFit.rowHeight).toBeLessThanOrEqual(60)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-page-narrow.png'), fullPage: true })
  // The expanded seat above is the side effect of the rail icon being a
  // destination; on a phone the ordinary reading state is the collapsed rail,
  // so the queue gets that face too — and there the row keeps its compact shape
  // rather than the folded one the crushed seat forces. The card's current-page
  // fill is read while it is still on screen, because the icon that replaces it
  // has to wear exactly that.
  const currentCardFill = await inboxCard.evaluate(card => ({
    label: card.getAttribute('aria-current'),
    background: getComputedStyle(card).backgroundColor,
  }))
  expect(currentCardFill.label).toBe('page')
  await page.getByRole('button', { name: '收起侧边栏' }).click()
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await settleLayout(page)
  const collapsedRow = await inboxPage.locator('button[class*="row"]').first().evaluate(row => {
    const box = (selector: string): DOMRect => (row.querySelector(selector) as HTMLElement).getBoundingClientRect()
    const line = box('[class*="rowCrumb"]')
    return { height: Math.round(row.getBoundingClientRect().height), sameLine: Math.abs(line.top - box('time').top) < 4 }
  })
  expect(collapsedRow.height).toBeLessThanOrEqual(62)
  expect(collapsedRow.sameLine).toBe(true)
  // The rail has no label to say where the reader is, so the current page is the
  // fill on the icon — the same `aria-current="page"` the wide card reads, and
  // the same fill the card wears. One seat, one marker, at both widths.
  const railCurrent = await railInboxButton.evaluate(button => ({
    label: button.getAttribute('aria-current'),
    background: getComputedStyle(button).backgroundColor,
  }))
  expect(railCurrent.label).toBe('page')
  expect(railCurrent.background).toBe(currentCardFill.background)
  expect(railCurrent.background).not.toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-page-narrow-collapsed.png'), fullPage: true })
  await railInboxButton.click()
  await page.locator('[data-sidebar-collapsed]').waitFor({ state: 'detached' })
  await settleLayout(page)
  await page.setViewportSize({ width: 1440, height: 960 })
  // The queue's settled desktop face, before a row is opened: the two rows the
  // queue now mixes, in the two inks, at the width most reading happens at.
  await settleLayout(page)
  const ink = async (locator: Locator) => await locator.evaluate(element => {
    const style = getComputedStyle(element)
    const box = element.getBoundingClientRect()
    return {
      background: style.backgroundColor, border: style.borderTopColor, color: style.color,
      width: Math.round(box.width), height: Math.round(box.height), left: Math.round(box.x),
    }
  })
  const namedInk = await ink(namedCapsule)
  const plainInk = await ink(plainCapsule)
  // One grammar, two inks: the row that named the reader wears the solid fill,
  // and the row that merely moved wears the same capsule as a hairline.
  expect(plainInk.background).not.toBe(namedInk.background)
  expect(plainInk.border).not.toBe('rgba(0, 0, 0, 0)')
  // The sidebar states that same fact as a mark instead of a number: the count
  // left the surface for the entry's accessible name, and what is left on screen
  // is the ink the row that named the reader wears. It is a mark rather than a
  // shrunken capsule, so it is measured as one — a count that comes back here
  // would fail the first assertion.
  expect(await page.locator('button[class*="inboxCard"] [data-team-count-badge]').count()).toBe(0)
  const inboxDot = page.locator('button[class*="inboxCard"] [data-team-inbox-dot]')
  await expect.poll(async () => await inboxDot.count()).toBe(1)
  const dotInk = await ink(inboxDot)
  expect(dotInk.background).toBe(namedInk.background)
  expect(dotInk.width).toBe(8)
  expect(dotInk.height).toBe(8)
  // Identical geometry either way: a Thread does not shift its row when it is
  // named again, and the counts open one column down the page.
  expect(namedInk.height).toBe(plainInk.height)
  expect(namedInk.width).toBe(plainInk.width)
  expect(namedInk.left).toBe(plainInk.left)
  // One capsule, two surfaces: the Channel feed's Thread entry and both Inbox
  // queue rows are the same component, so the shape that decides where the digit
  // sits cannot drift between them — which is exactly how the feed's copy ended
  // up on a different line box from the other two. The sidebar left this set: it
  // draws the mark asserted above rather than a count.
  const namedCapsuleRead = await namedCapsule.evaluate(readCountCapsule)
  const plainCapsuleRead = await plainCapsule.evaluate(readCountCapsule)
  const capsuleReads = [namedCapsuleRead, plainCapsuleRead, unreadCapsule]
  for (const read of capsuleReads.slice(1)) {
    if (read === null) continue
    expect(read.shape).toEqual(namedCapsuleRead.shape)
  }
  // The two tones spend their inset differently on purpose — the hairline draws
  // a 1px border where the fill has none, and pays for it out of the padding — so
  // what has to agree is the inset that reaches the digit, not the declaration:
  // 4px of padding behind a 1px border is the solid tone's 5px. Reading only the
  // declaration would let the hairline capsule run a pixel wider than the fill
  // beside it and still pass.
  expect(capsuleReads.map(read => read?.inset))
    .toEqual([namedCapsuleRead.inset, namedCapsuleRead.inset, namedCapsuleRead.inset])
  for (const read of capsuleReads) {
    // One character keeps the box square: the shared rule's 18px floor, not the
    // digit's own advance, decides the width — which is what seats one digit in
    // a circle instead of an oval. A wider count is allowed to widen the pill
    // (`99+` is the widest), so the square is claimed only where the content is
    // one character. This is read as a box rather than as a declaration because
    // `min-width` is a floor the content can still push past.
    if (read === null || read.text.length !== 1) continue
    expect(read.box.height).toBe(read.box.width)
  }
  const edgeLeft = async (locator: Locator): Promise<number> => Math.round(await locator.evaluate(element => element.getBoundingClientRect().x))
  const edgeRight = async (locator: Locator): Promise<number> => Math.round(await locator.evaluate(element => element.getBoundingClientRect().right))
  // One content column, measured rather than assumed: a Member circle hangs in
  // the row's gutter on every row — counted or not — and everything the row says
  // opens on the column after it, in both sections; the section heading opens on
  // that same column. The whole promise of this layout is that heading, identity,
  // and gist read down one inset instead of three, so a row that drifts sideways
  // fails here. The count then closes the identity line one line-gap left of the
  // instant, which is where a reader scans for what is still waiting.
  const column = await inboxPage.evaluate(root => [...root.querySelectorAll('section')].map(section => {
    const heading = section.querySelector('h2') as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(heading)
    const box = (selector: string, row: Element): DOMRect => (row.querySelector(selector) as HTMLElement).getBoundingClientRect()
    const left = (selector: string, row: Element): number => Math.round(box(selector, row).left)
    return {
      heading: Math.round(range.getBoundingClientRect().left),
      rows: [...section.querySelectorAll('button')].map(row => {
        const badge = row.querySelector('[data-team-count-badge]') as HTMLElement | null
        const actor = row.querySelector('[class*="rowActor"]') as HTMLElement
        return {
          actor: left('[class*="rowActor"]', row),
          actorWidth: Math.round((actor.querySelector('[role="img"]') as HTMLElement).getBoundingClientRect().width),
          actorLabel: (actor.querySelector('[role="img"]') as HTMLElement).getAttribute('aria-label'),
          badgeToTime: badge === null ? null : Math.round(box('time', row).left - badge.getBoundingClientRect().right),
          crumb: left('[class*="rowCrumb"]', row),
          preview: left('[class*="rowPreview"]', row),
          text: (row.querySelector('[class*="rowPreview"]') as HTMLElement).textContent,
          // One Workspace on screen, so no row prints the name that never varies.
          workspace: row.querySelector('[class*="rowWorkspace"]') === null ? null : 1,
        }
      }),
    }
  }))
  expect(column.length).toBeGreaterThan(0)
  // The leading cluster is the Host's own roster, drawn: one 18px face per owner,
  // —6px of overlap per neighbour, and the same again for a `+N` chip. The two
  // names below are the Channel feed's own words, so 「谁在这个 Task 上」 reads the
  // same on both surfaces; a Thread with no live owner falls back to whoever its
  // newest fact came from, which is what the taskless rows above exercise.
  const inboxNow = scaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id })
  const hostRows = [...inboxNow.items, ...inboxNow.recent]
  const clusterWidth = (owners: number): number => owners === 0 ? 18 : 18 + 12 * (Math.min(owners, 3) - 1) + (owners > 3 ? 12 : 0)
  for (const section of column) {
    for (const row of section.rows) {
      const item = hostRows.find(candidate => (candidate.previewText ?? '') === row.text)
      expect(item).toBeDefined()
      expect(row.actorLabel).toBe(item!.claimOwners.length === 0
        ? `最新来自 @${item!.newestActor.name}`
        : `由 ${item!.claimOwners.map(owner => `@${owner.name}`).join(', ')} 处理`)
      expect(row.actorWidth).toBe(clusterWidth(item!.claimOwners.length))
      // The text column follows the cluster that is really drawn: a row pays one
      // face's width per face it has and nothing for the stack it could have had.
      // Reserving the widest stack is what used to put 36px of empty space in
      // front of the identity on every single-face row.
      expect(row.crumb).toBe(row.actor + row.actorWidth + 8)
      expect(row.preview).toBe(row.crumb)
      // The section heading is pinned to the one-face column — the row's own 8px
      // inset plus one 18px face plus the line's 8px gap — which is the column
      // every row without a stack opens on, so the section still reads as one
      // block wherever a row is not actually carrying a stack.
      expect(section.heading).toBe(row.actor + 26)
      if (row.badgeToTime !== null) expect(row.badgeToTime).toBe(8)
      expect(row.workspace).toBeNull()
    }
  }
  // The two times close one column on the right.
  expect(await edgeRight(inboxRow.locator('time'))).toBe(await edgeRight(plainRow.locator('time')))
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-page-desktop.png'), fullPage: true })
  // Keyboard: a row is one control, and the ring is the only chrome it grows —
  // around both of its lines, not around the count. Tab first, because a script
  // `focus()` alone leaves the browser's focus-visible heuristic cold.
  await page.keyboard.press('Tab')
  await inboxRow.focus()
  await inboxRow.scrollIntoViewIfNeeded()
  const rowRing = await focusRing(page, '[data-team-inbox] button[data-named]')
  expect(rowRing?.focusVisible).toBe(true)
  expect(rowRing?.outlineStyle).toBe('solid')
  expect(rowRing?.outlineWidth).toBe('2px')
  await settleAnimations(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-row-focus.png'), fullPage: true })

  // Opening the row's Thread acknowledges the mention durably: the badge and the
  // row drop through the existing auto-ack read, and Back lands on the row's
  // Channel — the Inbox is never on the back path. The row that merely moved is
  // still waiting, so the badge lands on its count rather than zero — and the
  // row just read is not gone from the page either: it comes back under
  // 「最近活跃」 without a count, while the queue keeps the one still waiting.
  await inboxRow.click()
  await page.locator('[data-team-thread]').waitFor()
  await expectSidebarUnread(baseUnread === 0 ? '1' : String(baseUnread + 1))
  await page.getByRole('button', { name: '返回频道' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await page.locator('button[class*="inboxCard"]').click()
  await page.locator('[data-team-inbox]').waitFor()
  // Wait on the section rather than on a row count: a row count of zero is also
  // what the entry frame shows, so only the section proves the fetch settled.
  await page.locator('[data-team-inbox]').getByRole('heading', { name: '最近活跃' }).waitFor({ timeout: 30_000 })
  await expect.poll(async () => await inboxRow.count()).toBe(1)
  await expect.poll(async () => await inboxRow.locator('[data-team-count-badge]').count()).toBe(0)
  await expect.poll(async () => await plainRow.count()).toBe(1)
  await expect.poll(async () => await plainRow.textContent()).toContain('工程侧同步，无需决策')
  await expect.poll(async () => await plainRow.locator('[data-team-count-badge]').count()).toBe(1)
  // A read row keeps the leading column instead of sliding left: the same Thread
  // moves between the two sections, so it reads down one column either way, and
  // a read row is the queue row minus its count rather than a differently shaped
  // object — both still open on the person who moved them.
  expect(await edgeLeft(inboxRow.locator('[class*="rowActor"]'))).toBe(await edgeLeft(plainRow.locator('[class*="rowActor"]')))
  expect(await edgeLeft(inboxRow.locator('[class*="rowCrumb"]'))).toBe(await edgeLeft(plainRow.locator('[class*="rowCrumb"]')))
  // Reading the second row drains the queue the same way, and a drained queue is
  // no longer the empty page: both Threads the reader took part in come back as
  // the 「最近活跃」 tail, so the settled face is that section. The queue's own
  // heading and count line go with its rows, and the tail's rows carry no count
  // capsule — zero is the absence of a badge rather than a badge reading zero.
  // The empty copy is left to the reader who has neither, which the component
  // spec covers, since this journey's reader always took part somewhere. Wait
  // for the section rather than for rows: rows are absent while the page loads.
  await plainRow.click()
  await page.locator('[data-team-thread]').waitFor()
  await expectSidebarUnread(baseUnread === 0 ? null : String(baseUnread))
  await page.getByRole('button', { name: '返回频道' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await page.locator('button[class*="inboxCard"]').click()
  await page.locator('[data-team-inbox]').waitFor()
  await page.locator('[data-team-inbox]').getByRole('heading', { name: '最近活跃' }).waitFor({ timeout: 30_000 })
  await expect.poll(async () => await page.locator('[data-team-inbox]').getByRole('heading', { name: '需要我' }).count()).toBe(0)
  await expect.poll(async () => await inboxRow.count()).toBe(1)
  await expect.poll(async () => await plainRow.count()).toBe(1)
  await expect.poll(async () => await inboxRow.locator('[data-team-count-badge]').count()).toBe(0)
  await expect.poll(async () => await plainRow.locator('[data-team-count-badge]').count()).toBe(0)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-page-recent.png'), fullPage: true })
  await expect.poll(async () => await page.locator('button[class*="inboxCard"]').getAttribute('aria-current')).toBe('page')

  // Both Threads above are taskless, so they only ever exercise the fallback: a
  // row names whoever moved a Thread nobody claimed. A Task's row is the case the
  // leading column is laid out for, and it leads with the same stack, the same
  // rule, and the same words the Channel feed's Thread entry row leads with.
  // Seeded here on real Host facts — a Task thread an Agent opens, plus the Claims
  // its peers put on it — because a stack is the one thing a fake row could too
  // easily fake. Every enabled Member still live in this Channel claims it, and the
  // row is read against whatever roster the Host really has: this journey archives
  // builder before it reaches the Inbox, and a peer cannot be provisioned here at
  // all — a direct `agentTeam.addMember` call mounts no `team-member` preset in
  // this lane (that call path resolves the shipped presets only, at boot as much as
  // at the end), while the Client's own dialog provisions Members normally — so the
  // count is asserted rather than assumed. The stack's geometry is what scales — one
  // face or three, the row pays for exactly the faces it draws — and the multi-face
  // shape itself is pinned in the Client component spec and the Host's claim-owner
  // spec.
  const stackStarted = await scaffold.ctx.agentTeam.sendMessageForAgent(inboxAgent, {
    requestId: 'm2-09-stack-task' as never, workspaceId: inboxWorkspace.id, channelRef: deliveryChannel.channelRef,
    asTask: true, body: '叠放校验：谁在这个 Task 上', recipients: [scaffold.ctx.agentTeam.status().humanMemberId],
  })
  if (stackStarted.kind !== 'committed') throw new Error(`stack fixture was rejected: ${stackStarted.kind}`)
  const stackTaskRef = stackStarted.task!.taskRef
  const stackThreadRef = stackStarted.thread.threadRef
  // Only a Member of the Task's own Channel may claim it, so the roster to draw
  // from is the Channel's, not the Workspace's.
  const channelMemberIds = new Set(scaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id }).members
    .filter((membership: { channelRef: string }) => membership.channelRef === deliveryChannel.channelRef)
    .map((membership: { memberId: string }) => membership.memberId))
  const claimants = scaffold.ctx.agentTeam.members()
    .filter((entry: { member: { memberId: string; state: string; sessionId: string } }) => entry.member.state === 'enabled'
      && channelMemberIds.has(entry.member.memberId)
      && scaffold.ctx.agents.get(entry.member.sessionId as never) !== undefined)
    .slice(0, 3)
  // A Member of this Channel is live, so the Task has an owner to lead with rather
  // than falling back to `newestActor` — which is the branch the two rows above
  // already covered.
  expect(claimants.length).toBeGreaterThanOrEqual(1)
  for (const [index, entry] of claimants.entries()) {
    const claimant = scaffold.ctx.agents.get(entry.member.sessionId as never)!
    // A Claim is a Thread write, so the claimant drains its own unread first —
    // the read that also hands back the revision the write is based on. The
    // Claim itself is what makes the claimant a follower.
    const read = await scaffold.ctx.agentTeam.readThreadForAgent(claimant, {
      requestId: `m2-09-stack-read-${index}` as never, workspaceId: inboxWorkspace.id, taskRef: stackTaskRef,
    })
    const claimed = await scaffold.ctx.agentTeam.changeClaimForAgent(claimant, {
      requestId: `m2-09-stack-claim-${index}` as never, workspaceId: inboxWorkspace.id, taskRef: stackTaskRef,
      action: 'claim', direction: `叠放校验 ${index + 1}`, baseRevision: read.thread.revision,
    })
    if (claimed.kind !== 'committed') throw new Error(`stack Claim was rejected: ${claimed.kind}`)
  }
  const stackRow = page.locator('[data-team-inbox] button').filter({ hasText: '叠放校验：谁在这个 Task 上' })
  await expect.poll(async () => await stackRow.count(), { timeout: 30_000 }).toBe(1)
  // The cluster is the Host's own roster made pixels: one face per owner, in
  // claim order, under the same words the Channel feed uses — and the row around
  // it pays for exactly those faces, so the widest stack costs the rows that
  // carry one and no row a pixel more.
  const stackBox = await stackRow.evaluate(row => {
    const cluster = row.querySelector('[class*="rowActor"] [role="img"]') as HTMLElement
    const gutter = row.querySelector('[class*="rowActor"]') as HTMLElement
    const crumb = row.querySelector('[class*="rowCrumb"]') as HTMLElement
    return {
      label: cluster.getAttribute('aria-label'),
      width: Math.round(cluster.getBoundingClientRect().width),
      circles: cluster.querySelectorAll('span').length,
      // The faces the row really has, then the line's own 8px gap.
      inset: Math.round(crumb.getBoundingClientRect().left - gutter.getBoundingClientRect().left),
    }
  })
  const stackItem = scaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id }).items
    .find(item => item.thread.threadRef === stackThreadRef)!
  // Every claimant the Host accepted is an owner on the row, and the row paid one
  // face per owner rather than the width of the stack it could have carried.
  expect(stackItem.claimOwners.length).toBe(claimants.length)
  expect(stackItem.claimOwners.map(owner => owner.name).sort()).toEqual(
    claimants.map((entry: { member: { handle: string } }) => entry.member.handle).sort())
  expect(stackBox.circles).toBe(Math.min(stackItem.claimOwners.length, 3) + (stackItem.claimOwners.length > 3 ? 1 : 0))
  expect(stackBox.label).toBe(`由 ${stackItem.claimOwners.map(owner => `@${owner.name}`).join(', ')} 处理`)
  expect(stackBox.width).toBe(clusterWidth(stackItem.claimOwners.length))
  expect(stackBox.inset).toBe(stackBox.width + 8)
  // The row also states where its Task stands, behind the Task's own number and in
  // the pair every other Task surface prints: a dot and the word the Host's status
  // renders as. This row is the busiest shape a row has — live owners in the gutter
  // and a standing on the identity line — and it arrived after the page had already
  // opened, so the standing came in on a wake rather than with the first render.
  await expect.poll(async () => await stackRow.locator('[data-team-task-state]').getAttribute('data-team-task-state')).toBe(stackItem.task!.status)
  expect(await stackRow.locator('[data-team-task-state]').textContent()).toBe('进行中')
  // The two Threads the tail above still holds carry no Task, and so draw no
  // standing at all: the mark belongs to a Task, never to a row.
  expect(await inboxRow.locator('[data-team-task-state]').count()).toBe(0)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-row-owners-desktop.png'), fullPage: true })

  // Losing the Host connection surfaces the failure in two places, and both
  // must read as states rather than as drift: the Channel body centers in the
  // free space exactly like the loading and empty surfaces it replaces, and the
  // rail line sits on the rail's alert scale, on the row labels, in the error
  // colour. A failed load also never reads as an empty workspace.
  await page.getByRole('button', { name: '新建频道' }).click()
  const probeDialog = page.getByRole('dialog', { name: '新建频道' })
  await probeDialog.getByLabel('名称').fill('recovery')
  await probeDialog.getByLabel('说明').fill('disconnect probe')
  await probeDialog.getByRole('button', { name: '创建频道' }).click()
  const recoveryRow = page.getByRole('button', { name: '# recovery' })
  await recoveryRow.waitFor()
  // The row label sets the inset every line in the rail agrees with, so read it
  // while the list is still there to read it from: a failed load leaves the rail
  // with no rows at all, and the error line is what stands in their place.
  const railLabel = await recoveryRow.locator('strong').evaluate(element => ({ x: element.getBoundingClientRect().x, color: getComputedStyle(element).color }))
  // Cutting the network is this block's own doing, so the ordinary shell's
  // connection-loss warnings from this window are acknowledged — and only those:
  // gap-repair and discontinuity warnings stay fatal.
  const offlineWarningStart = consoleWatch.warnings.length
  await page.context().setOffline(true)
  // A Channel whose projection was never loaded is the one that shows the
  // whole-surface error state instead of a stale timeline.
  await recoveryRow.click()
  const channelSurface = page.locator('[data-team-channel]')
  const bodyError = channelSurface.locator('[role="alert"]').first()
  await bodyError.waitFor({ timeout: 30_000 })
  const bodyBox = await bodyError.evaluate(element => {
    const box = element.getBoundingClientRect()
    const parent = element.parentElement!.getBoundingClientRect()
    return { centerX: box.x + box.width / 2, centerY: box.y + box.height / 2, parentCenterX: parent.x + parent.width / 2, parentCenterY: parent.y + parent.height / 2 }
  })
  expect(Math.abs(bodyBox.centerY - bodyBox.parentCenterY)).toBeLessThanOrEqual(2)
  expect(Math.abs(bodyBox.centerX - bodyBox.parentCenterX)).toBeLessThanOrEqual(2)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI08_SHOTS, 'channel-error-offline.png'), fullPage: true })

  // Rail Panels only re-subscribe when they remount, so leaving Team mode and
  // returning is what makes the sideways surfaces report the same drop.
  await page.getByRole('button', { name: '对话' }).click()
  await page.getByRole('button', { name: '团队' }).click()
  const railAlert = page.locator('section[aria-label="工作区"] [role="alert"]')
  await railAlert.first().waitFor({ timeout: 30_000 })
  const railBox = await railAlert.first().evaluate(element => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return { x: box.x, inset: box.x + parseFloat(style.paddingLeft), fontSize: style.fontSize, marginTop: style.marginTop, marginBottom: style.marginBottom, color: style.color }
  })
  expect(railBox.x).toBeLessThan(300)
  expect(railBox.fontSize).toBe('11px')
  expect(railBox.marginTop).toBe('0px')
  expect(railBox.marginBottom).toBe('0px')
  expect(Math.abs(railBox.inset - railLabel.x)).toBeLessThanOrEqual(1)
  expect(railBox.color).not.toBe(railLabel.color)
  expect(await page.getByText('还没有频道').count()).toBe(0)
  expect(await page.getByText('还没有 Agent').count()).toBe(0)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI08_SHOTS, 'sidebar-error-offline.png'), fullPage: true })

  // Reopening the stream supplies a baseline even without a new commit;
  // both the Channel and sidebar must recover without a manual retry.
  await page.context().setOffline(false)
  await page.getByRole('heading', { name: '# recovery' }).waitFor({ timeout: 30_000 })
  await expect.poll(() => channelSurface.locator('[role="alert"]').count()).toBe(0)
  await recoveryRow.waitFor({ timeout: 45_000 })
  await expect.poll(async () => await railAlert.count(), { timeout: 20_000 }).toBe(0)
  await expect.poll(() => consoleWatch.warnings.slice(offlineWarningStart).some(warning => /connection lost/i.test(warning)), { timeout: 20_000 }).toBe(true)
  acknowledgeReloadConnectionLoss(consoleWatch, offlineWarningStart)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI08_SHOTS, 'sidebar-recovered-online.png'), fullPage: true })

  // One member posting several Messages in a row: each is its own Thread entry
  // and its own Task, so the feed has to keep three entries readable without
  // repeating the identity line the run already carries.
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  for (const body of ['连续消息之一', '连续消息之二', '连续消息之三']) {
    await asTaskToggle.focus()
    await page.keyboard.press('Space')
    await expect.poll(() => asTaskToggle.getAttribute('aria-pressed')).toBe('true')
    await channelComposer.fill(body)
    await page.getByRole('button', { name: '发送' }).click()
    await page.locator('[data-team-channel] article').filter({ hasText: body }).waitFor()
    await expect.poll(() => asTaskToggle.getAttribute('aria-pressed')).toBe('false')
  }
  await settleAnimations(page)
  await page.screenshot({ path: join(UI05_SHOTS, 'consecutive-entries.png'), fullPage: true })
  // The operator's case, as an assertion: several Messages from one member in a
  // row. Each is its own Thread entry and its own Task, and a continuation row's
  // identity line carries nothing but its own time — so the state has to ride
  // each entry's own row, opening it, instead of parking at a line's far end.
  const consecutive = await page.evaluate(() => [...document.querySelectorAll('[data-team-channel] article')]
    .filter(article => /连续消息之[一二三]/.test(article.textContent ?? ''))
    .map(article => {
      const body = article.lastElementChild
      const entry = [...(body?.children ?? [])].find(child => child.hasAttribute('data-thread-entry'))
      // The identity line is whatever the body box opens with, unless the entry
      // line itself does — a grouped row renders no identity line at all.
      const opening = body?.firstElementChild
      const nameRow = opening !== null && opening !== undefined && !opening.hasAttribute('data-thread-entry') ? opening : null
      const left = (element: Element | null | undefined): number => element === null || element === undefined ? -1 : Math.round(element.getBoundingClientRect().left)
      return {
        grouped: article.getAttribute('data-grouped') === 'true',
        identityLine: nameRow?.textContent ?? '',
        entryText: entry?.textContent ?? '',
        series: /连续消息之([一二三])/.exec(article.textContent ?? '')?.[1] ?? '',
        stateLeft: left(entry?.firstElementChild),
        entryLeft: left(entry),
        columnLeft: left(body),
      }
    }))
  // Chinese numerals do not collate into counting order, so the send order is
  // the only correct key here.
  const seriesOrder = ['一', '二', '三']
  consecutive.sort((first, second) => seriesOrder.indexOf(first.series) - seriesOrder.indexOf(second.series))
  expect(consecutive.map(row => row.series)).toEqual(seriesOrder)
  expect(consecutive.some(row => row.grouped)).toBe(true)
  for (const row of consecutive) {
    // The identity line stays identity — the status word is not on it, so no
    // continuation row shows a lone status floating where a sender would be.
    expect(row.identityLine).not.toContain('待处理')
    // …and it did land on the entry line, opening it level with the body.
    expect(row.entryText).toContain('待处理')
    expect(row.stateLeft).toBe(row.entryLeft)
    expect(row.stateLeft).toBe(row.columnLeft)
  }
  // One state column for the whole feed, not one per message length.
  expect(new Set(consecutive.map(row => row.stateLeft)).size).toBe(1)

  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await page.locator('button[class*="inboxCard"]').focus()
  await page.keyboard.press('Space')
  await page.locator('[data-team-inbox]').waitFor()
  const inboxEntry = page.locator('button[class*="inboxCard"]')
  await expect.poll(async () => await inboxEntry.getAttribute('aria-current')).toBe('page')

  // An Agent card is the one Team row a reader can open from the Inbox page, and
  // the overlay embeds that Session over the page instead of replacing it. That
  // makes the Inbox the one face that can stand underneath the Member view, so
  // the two must not both claim the seat: the Agent card takes the marker and the
  // Inbox entry stands down — it is the remembered face underneath, not a second
  // current page — while the page itself leaves the seat with the overlay.
  const liveAgentCard = page.locator('button[class*="agentSelect"]:not([disabled])').first()
  const liveAgentName = await liveAgentCard.getAttribute('aria-label')
  await liveAgentCard.click()
  await page.locator('[data-team-inbox]').waitFor({ state: 'detached' })
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
  await expect.poll(async () => await page.locator('[aria-current="page"]').count()).toBe(1)
  await expect.poll(async () => await page.locator('[aria-current="page"]').getAttribute('aria-label')).toBe(liveAgentName)
  await expect.poll(async () => await inboxEntry.getAttribute('aria-current')).toBeNull()
  await settleLayout(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-under-agent-overlay.png'), fullPage: true })
  // Asking for the Inbox is Team navigation: it closes the overlay and puts the
  // reader back on the page they were reading, marker included — one marked row
  // at every step, never two and never none. The seat matters as much as the
  // sidebar here: the shipped composer belongs to the Member Session, so the
  // page the reader asked for is only really back once that composer is gone.
  await inboxEntry.click()
  await page.locator('[data-team-inbox]').waitFor()
  await expect.poll(async () => await page.locator('[aria-current="page"]').count()).toBe(1)
  await expect.poll(async () => await inboxEntry.getAttribute('aria-current')).toBe('page')
  await expect.poll(async () => await page.locator('[data-composer-input]').count()).toBe(0)

  const channelKeyboard = page.getByRole('button', { name: '# delivery' })
  await channelKeyboard.focus()
  await channelKeyboard.press('Space')
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  const taskKeyboard = page.getByRole('button', { name: '打开 Task #1' })
  await taskKeyboard.focus()
  await taskKeyboard.press('Space')
  await page.getByRole('heading', { name: 'Task #1' }).waitFor()
  const backKeyboard = page.getByRole('button', { name: '返回频道' })
  await backKeyboard.focus()
  await backKeyboard.press('Space')
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  const leaveTeamKeyboard = page.getByRole('button', { name: '对话' })
  await leaveTeamKeyboard.focus()
  await leaveTeamKeyboard.press('Space')
  // Leaving Team restores the Human's original session (see the Member view
  // above), so the ordinary shell renders a conversation composer.
  // The restored ordinary shell may hold an inert composer (blank session),
  // so the wait is on the composer surface, not its editable state.
  await page.locator('[data-composer-input]').first().waitFor({ timeout: 20_000 })
  await expect.poll(() => page.locator('[data-team-channel]').count()).toBe(0)

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 120_000)


it('keeps four same-origin Team pages responsive and independently subscribed', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'multi-web')
  await scaffold.ctx.agentTeam.createChannel({ requestId: 'multi-channel' as never, workspaceId: workspace.id, name: 'multi-web', description: 'Multi-page regression' })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const pages: Page[] = []
  let membersRequest: { url: string; body: string } | undefined
  context.on('request', request => {
    if (request.url().endsWith('/agentTeam/members')) membersRequest = { url: request.url(), body: request.postData()! }
  })
  const probe = async (page: Page) => {
    expect(membersRequest).toBeDefined()
    const result = await page.evaluate(async request => {
      const start = performance.now()
      const response = await fetch(request.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.body, signal: AbortSignal.timeout(3000) })
      return { status: response.status, body: await response.json(), ms: performance.now() - start }
    }, membersRequest!)
    expect(result.status).toBe(200)
    expect(result.body.result.ok).toBe(true)
    console.log(`Team multi-page query (${pages.length} pages): ${Math.round(result.ms)}ms`)
  }
  for (let index = 0; index < 4; index++) {
    const page = await context.newPage()
    pages.push(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'domcontentloaded' })
    if (index === 0) await page.getByRole('button', { name: '团队', exact: true }).click()
    await page.getByRole('button', { name: '# multi-web', exact: true }).click()
    await page.getByRole('heading', { name: '# multi-web', exact: true }).waitFor()
    await probe(page)
  }
  const composer = pages[0]!.locator('[data-team-channel] textarea')
  await composer.fill('来自第一页的消息')
  await pages[0]!.getByRole('button', { name: '发送', exact: true }).click()
  for (const page of pages) await page.locator('[data-team-channel] article').filter({ hasText: '来自第一页的消息' }).waitFor()
  await pages.shift()!.close()
  await probe(pages[0]!)
  await pages[0]!.getByRole('button', { name: '对话', exact: true }).click()
  await probe(pages[1]!)
  const separate = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const other = await separate.newPage()
  await other.goto(scaffold.authenticatedUrl)
  await other.getByRole('button', { name: '团队', exact: true }).click()
  await other.getByRole('button', { name: '# multi-web', exact: true }).click()
  await other.locator('[data-team-channel] textarea').fill('来自独立浏览器的消息')
  await other.getByRole('button', { name: '发送', exact: true }).click()
  await pages[1]!.locator('[data-team-channel] article').filter({ hasText: '来自独立浏览器的消息' }).waitFor()
  await pages[1]!.screenshot({ path: join(BROWSER_ARTIFACTS, 'multi-web-desktop.png'), fullPage: true })
  await pages[1]!.setViewportSize({ width: 390, height: 844 })
  await settleLayout(pages[1]!)
  await pages[1]!.screenshot({ path: join(BROWSER_ARTIFACTS, 'multi-web-mobile.png'), fullPage: true })
}, 120_000)

/**
 * Taskless-thread ref chips must navigate, not just render (task #17): one
 * taskless Thread cites another's abbreviated ref in plain prose, the reader
 * clicks the chip, and the Thread page of the cited Thread opens. The chip is
 * located by its raw-ref title so the assertion survives label redesigns, and
 * arrival is proven by the Thread page marker carrying the cited full ref.
 */
it('opens a taskless thread from its ref chip in real Web', async () => {
  await installLocalBundle(false)
  // Same install flow as the other journeys: installLocalBundle stages the
  // bundle, so no extra install anchor is needed (an undefined anchor
  // identifier here failed the whole journey with a ReferenceError).
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')
  await page.getByRole('button', { name: '团队', exact: true }).click()
  await page.getByRole('button', { name: '新建频道' }).click()
  const channelDialog = page.getByRole('dialog', { name: '新建频道' })
  await channelDialog.getByLabel('名称').fill('ref-repro')
  await channelDialog.getByLabel('说明').fill('thread ref chips')
  await channelDialog.getByRole('button', { name: '创建频道' }).click()
  await page.getByRole('button', { name: '# ref-repro', exact: true }).click()
  await page.getByRole('heading', { name: '# ref-repro', exact: true }).waitFor()
  const channelComposer = page.getByRole('textbox', { name: '消息内容' })
  await channelComposer.fill('ALPHA-ROOT-MARKER alpha discussion opens here')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('[data-team-channel] article').filter({ hasText: 'ALPHA-ROOT-MARKER' }).waitFor()
  // The cited form is the abbreviated spelling from the report (8 hex chars):
  // resolution, not spelling, must decide linkability.
  const workspaceId = scaffold.ctx.workspaceRegistry.list()[0]!.id
  const projection = scaffold.ctx.agentTeam.view({ workspaceId })
  const alphaThread = projection.threads.find((thread: { taskRef?: string }) => thread.taskRef === undefined)!
  const alphaRef = alphaThread.threadRef as string
  const alphaShort = `thread:${(alphaRef.slice('thread:'.length) as string).replaceAll('-', '').slice(0, 8).toLowerCase()}`
  await channelComposer.fill(`BETA-ROOT-MARKER citing ${alphaShort} for the chip`)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const betaArticle = page.locator('[data-team-channel] article').filter({ hasText: 'BETA-ROOT-MARKER' })
  await betaArticle.waitFor()
  const chip = betaArticle.locator(`button[title="${alphaShort}"]`)
  await chip.waitFor()
  // Chip titles cap at 40 characters (boundedThreadTitle): the 43-char
  // anchor below renders truncated, and navigation still proves identity.
  await expect.poll(() => chip.textContent()).toMatch(/ALPHA-ROOT-MARKER alpha discussion open…/)
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip.png'), fullPage: true })
  await chip.click()
  // Split "never navigated" from "navigated but failed to render": the
  // persisted snapshot answers the first without waiting on the second.
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { threadRef?: string }).threadRef), { timeout: 10_000 }).toBe(alphaRef)
  // Arrival at the cited Thread (not just any navigation): the Thread page
  // marker carries the cited full ref, and the persisted snapshot agrees.
  await page.locator(`[data-team-thread="${alphaRef}"]`).waitFor({ timeout: 20_000 })
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { threadRef?: string }).threadRef)).toBe(alphaRef)
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip-opened.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip-opened-narrow.png'), fullPage: true })
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)

/** One real 1×1 RGBA PNG: the avatar store validates the payload as an image and
 * the page must decode it, so a placeholder byte string would prove nothing. The
 * single pixel is opaque amber rather than white so the screenshot shows the
 * uploaded avatar filling the identity seat instead of a blank circle. */
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4Oo/7PwAGyAKe4yFCTgAAAABJRU5ErkJggg=='

/**
 * The Human's own settings page: display name, avatar, version footnote. It is
 * an ordinary-mode settings section — Team mode's sidebar takeover makes the
 * panel unreachable by design — so this journey does its panel work first and
 * only then enters Team mode, to prove the same rename reaches the timeline.
 */
it('configures the Team page identity from Settings in real Web', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const nameField = panel.getByLabel('名字')
  await nameField.waitFor()
  // The Team page carries two saves — this row's and the judge group's — so the
  // identity row is addressed through the one form it owns.
  const nameSave = panel.locator('form button[type="submit"]')
  // The Host has no override stored yet, so the page shows the historic default
  // and the version footnote's two facts: the bundle version and the repo link.
  expect(await nameField.inputValue()).toBe('human')
  // The page states what owns it before anything else: among the Harness's own
  // settings pages, a bare 「团队」 leaves the reader guessing.
  expect(await panel.textContent()).toContain('你在 Team 里的身份')
  expect(await panel.textContent()).toMatch(/版本 \d+\.\d+\.\d+/)
  expect(await panel.getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe('https://github.com/Contexera/dsh-agent-team')
  expect(await panel.getByRole('button', { name: '移除头像' }).count()).toBe(0)

  // Keyboard rename, no pointer involved: typing makes the field dirty, Tab
  // hands focus to the Save button that owns the form, and Enter activates it.
  await nameField.fill('Ada')
  await nameField.press('Tab')
  const saveRing = await focusRing(page, '[role="dialog"] form button[type="submit"]')
  expect(saveRing?.focusVisible).toBe(true)
  expect(saveRing?.outlineStyle).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect.poll(() => scaffold!.ctx.agentTeam.humanHandle()).toBe('Ada')
  await expect.poll(async () => await nameSave.isDisabled()).toBe(true)

  // Avatar upload: bytes go to the persistent store, the reference into
  // settings, and the page draws what the browser can decode.
  const avatarPath = join(HOME, 'ada-avatar.png')
  await writeFile(avatarPath, Buffer.from(ONE_PIXEL_PNG, 'base64'))
  await panel.locator('input[type="file"]').setInputFiles(avatarPath)
  const preview = panel.locator('img').first()
  await preview.waitFor()
  await expect.poll(async () => await preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
  expect(await preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef !== undefined).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page.png'), fullPage: true })

  // A refused name is refused before the round trip: the field keeps what the
  // reader typed and the notice states the rule.
  await nameField.fill('   ')
  await panel.getByText('名字不能为空。').waitFor()
  expect(await nameSave.isDisabled()).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-empty-name.png'), fullPage: true })
  await nameField.fill('Ada')
  await expect.poll(async () => await nameSave.isDisabled()).toBe(true)

  // 390×844: the shipped panel keeps its 188px nav rail at every viewport, so
  // the question this answers is whether OUR column survives the squeeze.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-narrow.png'), fullPage: true })
  const narrow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(390)
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  // Bytes this browser cannot decode fall back to the initial, exactly like a
  // removed avatar. The Host accepts them — it checks the declared media type,
  // not the payload — so this is also the state a phone photo in HEIC lands in,
  // and the page's own copy promises the initial for it.
  await panel.locator('input[type="file"]').setInputFiles([{ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('this is not a PNG') }])
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef !== undefined).toBe(true)
  await expect.poll(async () => await panel.locator('[data-avatar="initial"]').textContent()).toBe('A')
  expect(await panel.locator('img').count()).toBe(0)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-undecodable-avatar.png'), fullPage: true })

  // Removal returns the identity to the initial while the rename stands.
  await panel.getByRole('button', { name: '移除头像' }).click()
  await expect.poll(async () => await panel.locator('img').count()).toBe(0)
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef).toBeUndefined()
  await expect.poll(async () => await panel.getByRole('button', { name: '上传头像' }).count()).toBe(1)
  // The readable bytes go back in: the Inbox leg below draws the compact stack
  // from the same profile, and a seat can only prove that with a picture.
  await panel.locator('input[type="file"]').setInputFiles(avatarPath)
  await expect.poll(async () => await panel.locator('img').count()).toBe(1)
  await panel.getByRole('button', { name: '关闭' }).click()

  // The rename is not page-local: the Team timeline names the Human by it.
  await page.getByRole('button', { name: '团队', exact: true }).click()
  await page.getByRole('button', { name: '新建频道' }).click()
  const channelDialog = page.getByRole('dialog', { name: '新建频道' })
  await channelDialog.getByLabel('名称').fill('profile-check')
  await channelDialog.getByLabel('说明').fill('renamed human')
  await channelDialog.getByRole('button', { name: '创建频道' }).click()
  await page.getByRole('button', { name: '# profile-check', exact: true }).click()
  const composer = page.getByRole('textbox', { name: '消息内容' })
  await composer.fill('PROFILE-NAME-MARKER hello from the renamed human')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const row = page.locator('[data-team-channel] article').filter({ hasText: 'PROFILE-NAME-MARKER' })
  await row.waitFor()
  await expect.poll(async () => await row.textContent()).toContain('Ada')
  expect(await row.textContent()).not.toContain('Human')
  // The picture lands on the row the profile describes: the Human's own message
  // draws it in the assembled bundle (the Agent row keeping its initial is
  // pinned by the component suite, which seeds both authors into one feed).
  const humanPicture = row.locator('[data-avatar="image"]')
  await expect.poll(async () => await humanPicture.count()).toBe(1)
  expect(await humanPicture.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  await page.screenshot({ path: join(UI09_SHOTS, 'renamed-human-in-timeline.png'), fullPage: true })

  // The identity is not page-local either. The Inbox row that names the Human
  // leads with the profile picture in the very circle an Agent's initial fills
  // — the same seat, the same 18px geometry — and the row reads the display
  // name rather than the durable `member:human` id no Agent roster holds.
  await page.locator('button[class*="inboxCard"]').click()
  const identityRow = page.locator('[data-team-inbox] button').filter({ hasText: 'PROFILE-NAME-MARKER' })
  await expect.poll(async () => await identityRow.count(), { timeout: 30_000 }).toBe(1)
  const identityStack = identityRow.locator('[class*="rowActor"] [role="img"]')
  const identityPicture = identityStack.locator('img')
  await expect.poll(async () => await identityPicture.count()).toBe(1)
  expect(await identityPicture.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  expect(await identityStack.getAttribute('aria-label')).toContain('@Ada')
  const identityGeometry = await identityStack.evaluate(cluster => {
    const rect = cluster.getBoundingClientRect()
    return { width: Math.round(rect.width), height: Math.round(rect.height), radius: getComputedStyle(cluster.firstElementChild!).borderTopLeftRadius }
  })
  expect(identityGeometry).toEqual({ width: 18, height: 18, radius: '50%' })
  await page.screenshot({ path: join(UI09_SHOTS, 'human-identity-in-inbox-stack.png'), fullPage: true })
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)

/**
 * The environment check above the version footnote. The versions it prints are
 * the whole point: `0.1.15` comes from the installed manifest and the DSH
 * version from the running Host's own reader, so this journey proves the Host
 * resolved its real manifests rather than a fixture. Only the `ok` tier is
 * reachable in a browser — the other two describe an environment this run does
 * not have (a different DSH cut, or unreadable facts) and are pinned by the Host
 * and component suites. The `ok` line names the **running** version, never the
 * declared range's lower bound: that bound belongs to the out-of-range tier,
 * which is why this case also pins its absence. The expectation therefore comes
 * from `getDshRuntimeVersion()` — the call the Host itself makes — so the
 * journey states the fact on rc.1, rc.2, and whatever cut the adjacent checkout
 * carries instead of naming one cut once.
 */
it('states the local environment check on the Team page', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const block = panel.locator('[data-environment]')
  await block.waitFor()
  await expect.poll(async () => await block.getAttribute('data-environment')).toBe('ok')
  // The running version is stated as a fact and in words: no raw semver range
  // appears anywhere, and the certified line stays out of the `ok` tier.
  expect(await block.textContent()).toContain('在支持范围内')
  expect(await block.textContent()).toContain(`正在运行的 DSH ${getDshRuntimeVersion()} 在我们声明的支持范围内。`)
  expect(await block.textContent()).not.toContain('>=0.1.7-rc.1')
  expect(await block.textContent()).not.toContain('我们实测认证的组合')
  expect(await block.locator('a').count()).toBe(0)
  // Reading both versions is what proves the Host reached its own manifests:
  // the bundle version resolves from the staged install, and the DSH version
  // from the app-boot package the running host ships.
  expect(await block.textContent()).not.toContain('unknown')
  await page.screenshot({ path: join(UI09_SHOTS, 'environment-check-ok.png'), fullPage: true })

  // 390×844: the shipped panel keeps its 188px nav rail, so the block has to
  // survive a column far narrower than its sentence. It must stay inside the
  // panel and add no horizontal overflow of its own.
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

/**
 * The judge group on the Team page: one line of state above the three controls
 * that decide whether jev can be reached at all. The journey proves the whole
 * path — page → settings document → the Host's own judge → back into the status
 * line — because a write that landed and a write that merely staged look
 * identical on the page, so only that round trip tells them apart.
 *
 * The page is deliberately small: the gate's thresholds and the key's
 * environment variable share the same row and are Team's own business, so this
 * journey also pins their absence from the controls and from the copy.
 *
 * The key literal is written, then cleared: mounting and unmounting the judge
 * is the one state change this page can reach without a network call, and the
 * literal is a fixture that never leaves the temporary profile.
 */
it('configures the jev endpoint from the Team page in real Web', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')

  await page.getByRole('button', { name: '设置', exact: true }).click()
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const heading = panel.getByRole('heading', { name: '团队', exact: true })
  await heading.waitFor()
  const judgeToggle = panel.getByRole('button', { name: /^jev/ })
  const judge = panel.locator('[data-team-judge]')

  // A fresh profile holds no key: the row says so in one line and the controls
  // that would change it are not on the page at all. A closed disclosure that
  // merely hid its content would still be reachable by keyboard and by a screen
  // reader, so the journey pins the absence rather than the styling.
  const status = judgeToggle.locator('[data-context-judge]')
  await status.waitFor()
  await expect.poll(async () => await status.getAttribute('data-context-judge')).toBe('no-key')
  expect(await status.textContent()).toContain('未配置 key')
  expect(await judgeToggle.getAttribute('aria-expanded')).toBe('false')
  expect(await judge.count()).toBe(0)
  expect(await panel.getByRole('textbox', { name: 'apiBase' }).count()).toBe(0)
  await heading.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-no-key.png'), fullPage: true })

  // Opening it is what puts the three controls on the page — exactly those, and
  // nothing else: the gate's thresholds and the key's environment variable share
  // the same settings section and are Team's own business, so neither a control
  // nor a number for them appears here. It is a real button, so the keyboard
  // path a reader without a pointer has is the one that opens it.
  await judgeToggle.focus()
  await page.keyboard.press('Enter')
  expect(await judgeToggle.getAttribute('aria-expanded')).toBe('true')
  await judge.waitFor()
  expect(await judge.textContent()).not.toContain('阈值')
  expect(await judge.textContent()).not.toContain('环境变量')
  expect(await judge.getByRole('textbox').count()).toBe(3)
  expect(await judge.getByText('jev', { exact: true }).count()).toBe(0)
  // Nothing is overridden in a fresh profile, so the endpoint controls start
  // empty: the row states only what it states, and the engine's own defaults are
  // never copied onto the page. The key is a password field — a stored literal
  // never rides a response — so it starts blank and there is nothing to clear.
  expect(await judge.getByRole('textbox', { name: 'apiBase' }).inputValue()).toBe('')
  expect(await judge.getByRole('textbox', { name: 'model' }).inputValue()).toBe('')
  const keyField = judge.getByLabel('key', { exact: true })
  expect(await keyField.getAttribute('type')).toBe('password')
  expect(await keyField.getAttribute('autocomplete')).toBe('new-password')
  expect(await keyField.inputValue()).toBe('')
  expect(await judge.getByRole('button', { name: '清除 key' }).count()).toBe(0)
  await heading.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-open.png'), fullPage: true })

  // One save writes all three: the row now carries them, which is what the
  // shipped overridden badge reports, and the judge mounts — the status line
  // states the Host's own answer rather than the form's optimism.
  await judge.getByRole('textbox', { name: 'apiBase' }).fill('https://openrouter.ai/api/v1')
  await judge.getByRole('textbox', { name: 'model' }).fill('typesafe/jev-1.13')
  await keyField.fill('sk-e2e-not-a-real-key')
  await judge.getByRole('button', { name: '保存' }).click()
  await expect.poll(async () => await status.getAttribute('data-context-judge')).toBe('enabled')
  expect(await status.textContent()).toContain('jev 已就绪')
  await expect.poll(async () => await judge.getByRole('button', { name: '重置' }).count()).toBe(2)
  expect(await keyField.inputValue()).toBe('')
  await heading.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-enabled.png'), fullPage: true })

  // Clearing is its own write, and unmounts the judge again. It is the page's
  // own control, so it is also where the keyboard path is proven: Tab from the
  // key field reaches it, it carries the one focus ring the language defines,
  // and Enter is what clears.
  const clearButton = judge.getByRole('button', { name: '清除 key' })
  await clearButton.waitFor()
  await keyField.click()
  await page.keyboard.press('Tab')
  const clearRing = await focusRing(page, '[role="dialog"] button:focus-visible')
  expect(clearRing?.focusVisible).toBe(true)
  expect(clearRing?.outlineStyle).not.toBe('none')
  expect(clearRing?.outlineWidth).toBe('2px')
  // The shot is taken while the ring is on the control, so the page's own
  // control carries its focus state in the evidence rather than in prose.
  await heading.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-key-configured.png'), fullPage: true })
  await page.keyboard.press('Enter')
  await expect.poll(async () => await status.getAttribute('data-context-judge')).toBe('no-key')
  await expect.poll(async () => await judge.getByRole('button', { name: '清除 key' }).count()).toBe(0)
  // The endpoint survives the key's removal: they are one row, but the clear
  // writes exactly the one field it names.
  expect(await judge.getByRole('textbox', { name: 'apiBase' }).inputValue()).toBe('https://openrouter.ai/api/v1')

  // 390×844: the shipped panel keeps its 188px nav rail, so the page has to
  // survive a column far narrower than its sentences. It must stay inside the
  // panel and add no horizontal overflow of its own. The shot is taken with the
  // judge group itself in view — the panel scrolls, so a full-page capture at
  // the top would leave the row this rule restacks below the fold.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await judgeToggle.scrollIntoViewIfNeeded()
  // Two rules are measured here rather than eyeballed. The row's answer moves
  // under the title it answers for, and the shipped field head turns into a
  // column: at this width a label and its override badges cannot share a line,
  // and side by side the badges are painted over the label's text.
  const narrowGeometry = await judgeToggle.evaluate(toggle => {
    const title = toggle.querySelector('[class*="groupTitle"]')!
    const answer = toggle.querySelector('[data-context-judge]')!
    const head = document.querySelector('[data-team-judge] [class*="head"]')!
    const label = head.querySelector('label')!
    const badges = head.querySelector('[class*="badges"]')
    const titleBox = title.getBoundingClientRect()
    const answerBox = answer.getBoundingClientRect()
    const labelBox = label.getBoundingClientRect()
    const badgesBox = badges?.getBoundingClientRect()
    return {
      answerBelowTitle: Math.round(answerBox.top - (titleBox.top + titleBox.height)),
      labelWidth: Math.round(labelBox.width),
      labelText: Math.round(label.scrollWidth),
      badgesTop: badgesBox === undefined ? undefined : Math.round(badgesBox.top - labelBox.bottom),
    }
  })
  expect(narrowGeometry.answerBelowTitle).toBeGreaterThanOrEqual(-1)
  expect(narrowGeometry.labelWidth).toBeGreaterThanOrEqual(narrowGeometry.labelText)
  expect(narrowGeometry.badgesTop).toBeGreaterThanOrEqual(-1)
  // The answer is a sentence with a leading glyph, so at this width the glyph
  // rides the first line of the text instead of hanging at the middle of a
  // wrapped block, and the sentence starts where the glyph ends rather than in
  // a column of its own.
  const narrowAnswer = await status.evaluate(node => {
    const glyph = node.querySelector('svg')!.getBoundingClientRect()
    const text = node.querySelector('span')!.getBoundingClientRect()
    return {
      glyphTop: Math.round(glyph.top),
      glyphRight: Math.round(glyph.right),
      textTop: Math.round(text.top),
      textLeft: Math.round(text.left),
    }
  })
  expect(narrowAnswer.glyphTop - narrowAnswer.textTop).toBeLessThanOrEqual(4)
  expect(narrowAnswer.textLeft).toBeGreaterThanOrEqual(narrowAnswer.glyphRight)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-narrow-judge.png'), fullPage: true })
  const narrow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  const statusBox = (await status.boundingBox())!
  const panelBox = (await panel.boundingBox())!
  expect(statusBox.x + statusBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
