import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { launchWebScaffold, acknowledgeReloadConnectionLoss, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh } from './support.ts'
// Runs from the adjacent harness checkout, where bare workspace imports resolve
// to harness source; the expected version is read through the same call the Host
// makes.
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
const MAIN_STREAM_SHOTS = join(BROWSER_ARTIFACTS, 'main-stream')
let scaffold: WebScaffold | undefined
let browser: Browser | undefined

afterEach(async () => {
  await browser?.close(); browser = undefined
  await scaffold?.close(); scaffold = undefined
})

/**
 * Wait until no finite animation is running: a screenshot taken mid-collapse
 * captures the expanded column clipped to the rail. Infinite animations
 * (presence and loading pulses) are not waited on.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every(animation => {
    const timing = animation.effect?.getTiming()
    return timing === undefined || timing.iterations === Infinity || animation.playState !== 'running'
  }))
}

/** Open Settings from the shell's own entry, whichever seat holds it. */
async function openSettings(page: Page): Promise<void> {
  // The seat, not a name: both footer occupants register `settings.launcher`.
  const launcher = page.locator('[data-slot="sidebar.settings"] button').first()
  await launcher.click()
  const item = page.getByRole('menuitem', { name: '设置', exact: true })
  await expect.poll(async () => await item.count() > 0 || await page.getByRole('dialog').count() > 0).toBe(true)
  if (await item.count() > 0) await item.click()
  await page.getByRole('dialog').waitFor()
}

/**
 * The focus ring a control renders, plus whether the browser counts the focus
 * as keyboard-visible (`:focus-visible`).
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
 * Settle a viewport change: the responsive sidebar starts sliding a frame
 * after the resize, so re-check animations after two quiet frames.
 */
async function settleLayout(page: Page): Promise<void> {
  await settleAnimations(page)
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  }))
  await settleAnimations(page)
}

/**
 * One Task's Thread entry line in the Project feed, matched by the stable
 * `data-thread-entry-door` marker (the Task number, or `thread`) rather than
 * the localized accessible name.
 */
/** The board card is its own control: the unread and plain spellings both match exactly one card number. */
/** One Task's board card, matched by its exact accessible name in both the unread and plain spellings. */
function taskEntryLineSelector(taskNumber: number): string {
  return `[data-team-project] button[class*="boardCard"]:is([aria-label^="打开 Task #${taskNumber}（"], [aria-label="打开 Task #${taskNumber}"])`
}

/** One Task's board card: the locator form of {@link taskEntryLineSelector}. */
function taskEntryRow(page: Page, taskNumber: number) {
  return page.locator(taskEntryLineSelector(taskNumber))
}

/**
 * The colour a `--dsw-*` alias resolves to in the running theme, so
 * expectations follow palette changes.
 */
async function resolveAliasColor(page: Page, alias: string): Promise<string> {
  return page.evaluate(name => {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const resolved = getComputedStyle(probe).color
    probe.remove()
    return resolved
  }, alias)
}

/**
 * Left edges of an entry's state cluster, its entry line, and the reading
 * column (the message body box itself, since grouped rows render no identity
 * line).
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
 * Furthest any scroller inside the region can travel when scrolled right.
 * `overflow-x: hidden` boxes still scroll programmatically and report a
 * `scrollWidth` past `clientWidth`, so every clipping element is asked.
 * Scoped to the Team region because the shell's sidebar clips 1px of
 * scrollbar gutter.
 */
async function maxHorizontalScroll(page: Page, selector: string): Promise<number> {
  return page.evaluate(rootSelector => {
    const root = document.querySelector(rootSelector)
    if (root === null) throw new Error(`no ${rootSelector}`)
    let furthest = 0
    for (const element of [root, ...root.querySelectorAll('*')]) {
      const style = getComputedStyle(element)
      if (style.overflowX === 'visible' || style.overflowX === 'clip') continue
      const start = element.scrollLeft
      element.scrollLeft = 9999
      const reached = element.scrollLeft
      element.scrollLeft = start
      if (reached > furthest) furthest = reached
    }
    return furthest
  }, selector)
}

/** Left edge of every entry line's state cluster in the Project feed. */
async function taskEntryClusterLefts(page: Page): Promise<readonly number[]> {
  return page.evaluate(() => {
    const edges: number[] = []
    for (const card of document.querySelectorAll('[data-team-project] button[class*="boardCard"]')) {
      const cluster = card.querySelector('[class*="boardCardNum"]')
      if (cluster !== null) edges.push(Math.round(cluster.getBoundingClientRect().left - card.getBoundingClientRect().left))
    }
    return edges
  })
}

/**
 * The declarations that decide where the count digit sits and how wide the
 * capsule runs, read from the assembled bundle.
 */
function readCountCapsule(element: Element): {
  readonly text: string
  readonly hidden: string | null
  readonly background: string
  /**
   * The used box: `min-width` is only a floor, so squareness of one digit
   * needs the measured size.
   */
  readonly box: Record<string, number>
  /**
   * The inset reaching the digit (padding plus border). The tones declare
   * different values on purpose, so this is what must agree.
   */
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
      // Longhands: `font` computes to '' here, so comparing it would silently
      // pass.
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
 * The unread capsule of an entry, found by the shared count badge's attribute
 * because the build hashes CSS-module class names.
 */
async function entryUnreadCapsule(page: Page, lineSelector: string): Promise<ReturnType<typeof readCountCapsule> | null> {
  const capsule = page.locator(`${lineSelector} [data-team-count-badge]`).first()
  return await capsule.count() === 0 ? null : await capsule.evaluate(readCountCapsule)
}

/**
 * Stage this bundle and its dependency closure as `dsh plugin add` installs
 * it. A command-line overlay would shadow the profile document and make the
 * Host row's settings write fail, so every lane mounts the staged copy as a
 * profile package. Only the first case of a run clears the artifacts
 * directory (`clearArtifacts`).
 */
async function installLocalBundle(clearArtifacts = true): Promise<void> {
  await rm(HOME, { recursive: true, force: true })
  if (clearArtifacts) await rm(BROWSER_ARTIFACTS, { recursive: true, force: true })
  const scope = `${HOME}/profiles/node_modules/@contexera`
  await mkdir(scope, { recursive: true })
  // Match both separators: on Windows cp walks backslash paths.
  await cp(TEAM_ROOT, `${scope}/dsh-agent-team`, {
    recursive: true,
    filter: source => {
      const normalized = source.replaceAll('\\', '/')
      // .hoplite and .git hold agent-workspace state (runtime FIFOs kill fs.cp), and no installed bundle carries either.
      return !normalized.includes('/node_modules') && !normalized.includes('/src') && !normalized.includes('/artifacts') && !normalized.includes('/.hoplite')
        && !/\/\.git(\/|$)/.test(normalized)
    },
  })
  // Stage regular dependencies inside the bundle dir, as the production installer
  // would; the shared profiles/node_modules root is dsh-managed and rejects
  // foreign entries.
  const { dependencies } = JSON.parse(await readFile(join(TEAM_ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const bundleModules = join(scope, 'dsh-agent-team', 'node_modules')
  for (const name of Object.keys(dependencies)) {
    // No filter: the source root itself lives under node_modules, and store
    // packages never nest their own node_modules.
    await cp(join(TEAM_ROOT, 'node_modules', name), join(bundleModules, ...name.split('/')), {
      recursive: true,
      dereference: true,
    })
  }
  // The routed ledger backend is vendored under this bundle's own package name
  // (see cordis.patch.yml).
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

it('toggles the complete bundle without restarting the session controller', async () => {
  await installLocalBundle()
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: false }] } })
  const sessionController = [...scaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber

  const enabled = await scaffold.ctx.pluginManager.setBundleEnabled('@contexera/dsh-agent-team', true)
  expect(enabled, JSON.stringify(enabled)).toMatchObject({ application: 'applied' })
  expect(scaffold.ctx.get('agentTeam')).toBeDefined()
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'toggle-persistence')
  const project = await scaffold.ctx.agentTeam.createProject({
    requestId: 'toggle-persistence' as never,
    workspaceId: workspace.id,
    name: 'toggle-persistence',
    description: '',
  })
  expect(scaffold.ctx.agentTeam.status().projectCount).toBe(1)
  expect(scaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(true)
  expect([...scaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber).toBe(sessionController)

  const disabled = await scaffold.ctx.pluginManager.setBundleEnabled('@contexera/dsh-agent-team', false)
  expect(disabled, JSON.stringify(disabled)).toMatchObject({ application: 'applied' })
  expect(scaffold.ctx.get('agentTeam')).toBeUndefined()
  expect(scaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(false)
  expect([...scaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber).toBe(sessionController)

  expect(await scaffold.ctx.pluginManager.setBundleEnabled('@contexera/dsh-agent-team', true)).toMatchObject({ application: 'applied' })
  expect(scaffold.ctx.get('agentTeam')).toBeDefined()
  expect(scaffold.ctx.agentTeam.status().projectCount).toBe(1)
  expect(scaffold.ctx.agentTeam.view({ workspaceId: project.project.workspaceId }).projects[0]?.name).toBe('toggle-persistence')
  expect(scaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(true)
  expect([...scaffold.ctx.loader.entries()].find(entry => entry.id === 'session-controller')?.fiber).toBe(sessionController)
}, 30_000)

it('drives the complete opt-in Agent Team journey in real Web', async () => {
  await installLocalBundle()
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  // The web server gates the browser surface behind a process-token exchange;
  // authenticatedUrl sets the session cookie.
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')
  const ordinaryComposer = page.locator('[data-composer-input][contenteditable="true"][data-placeholder="描述你想要构建的内容, / 调用指令, @ 文件或对话"]')
  await expect.poll(() => ordinaryComposer.count()).toBe(1)
  // Scoped to the Team browser's marked row: the shell's rail marks the panel
  // that owns the column above it.
  const teamCurrentPage = page.locator('[data-slot="sidebar.workspaces"] [aria-current="page"]')

  expect(scaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@contexera/dsh-agent-team')).toBe(true)
  const panelRail = page.locator('nav[class*="panelList"]')
  const pluginsTrigger = panelRail.getByRole('button', { name: '插件' })
  const teamTrigger = panelRail.getByRole('button', { name: '团队', exact: true })
  const settingsTrigger = page.locator('[data-slot="sidebar.settings"] button').first()
  // Measured while on screen: Team mode's stand-down rule hides this bar.
  const shippedBarBox = await page.locator('button[class*="newSession"]').boundingBox()
  expect(shippedBarBox).not.toBeNull()
  // The shipped tree's bottom fade is measured in the same render as the bar above: Team's browsing seat must close on
  // the same seam, so the two boxes are compared as an equality rather than "looks faded".
  const shippedFadeBox = await page.evaluate(() => {
    const fade = document.querySelector('[class*="sidebarCol"] span[class*="fade"]')
    if (fade === null) return null
    const box = fade.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height, background: getComputedStyle(fade).backgroundImage }
  })
  expect(shippedFadeBox).not.toBeNull()
  const [teamBox, pluginsBox, settingsBox] = await Promise.all([teamTrigger.boundingBox(), pluginsTrigger.boundingBox(), settingsTrigger.boundingBox()])
  expect(teamBox).not.toBeNull()
  expect(pluginsBox).not.toBeNull()
  expect(settingsBox).not.toBeNull()
  expect(teamBox!.height).toBeCloseTo(pluginsBox!.height, 0)
  // Every launcher sits on the list's one pitch. The last row is not Team's to
  // claim: a shipped release may append its own launcher after the registered
  // panels, so the assertion is that Team lands on the same grid as the rest,
  // not that it terminates it.
  const railRows = await panelRail.evaluate(el => [...el.querySelectorAll('button')]
    .map(b => b.getBoundingClientRect().y))
  expect(railRows.length).toBeGreaterThan(1)
  const pitch = railRows[1]! - railRows[0]!
  expect(pitch).toBeGreaterThan(0)
  for (let index = 1; index < railRows.length; index += 1) {
    expect(railRows[index]! - railRows[index - 1]!, `row ${index} leaves the list's pitch`).toBeCloseTo(pitch, 0)
  }
  // Team must occupy a real row of that grid, not float between two.
  expect(railRows.some(row => Math.abs(row - teamBox!.y) <= 0.5), 'Team sits off the list grid').toBe(true)
  await teamTrigger.click()
  // The return control takes over the shipped New Session bar's slot (the mode
  // hides that bar), so it is measured against the bar's box in ordinary mode.
  // The footer's Settings row stays in both modes.
  const conversationTrigger = page.getByRole('button', { name: '对话' })
  const [conversationBox, brandRowBox, topInboxBox, teamSettingsBox] = await Promise.all([
    conversationTrigger.boundingBox(),
    page.locator('[class*="logoRow"]').boundingBox(),
    page.locator('button[class*="inboxCard"]').boundingBox(),
    settingsTrigger.boundingBox(),
  ])
  expect(conversationBox).not.toBeNull()
  expect(brandRowBox).not.toBeNull()
  expect(topInboxBox).not.toBeNull()
  expect(teamSettingsBox).not.toBeNull()
  expect(conversationBox!.y).toBeGreaterThanOrEqual(brandRowBox!.y + brandRowBox!.height)
  expect(conversationBox!.y).toBeLessThan(topInboxBox!.y)
  // Same top and height as the hidden shipped bar, so the first row does not jump
  // between modes.
  expect(conversationBox!.y).toBeCloseTo(shippedBarBox!.y, 0)
  expect(conversationBox!.height).toBeCloseTo(shippedBarBox!.height, 0)
  // Same box as the hidden shipped bar: 14px to 266px in the 280px sidebar.
  // `width: 100%` would add margin and overshoot by 4px; an inset onto the
  // browsing region's 12px edge would pull it in 2px.
  expect(conversationBox!.x).toBeCloseTo(shippedBarBox!.x, 0)
  expect(conversationBox!.width).toBeCloseTo(shippedBarBox!.width, 0)
  // Nothing in the browsing column may scroll sideways, though section headers
  // overhang the scrollport by their margin.
  expect(await maxHorizontalScroll(page, 'section[class*="workspaceBrowser"]')).toBe(0)
  // Centring is measured on the label's ink, not the whole control: the chevron
  // hangs off the label's leading edge out of flow. Assembled-bundle only: jsdom
  // loads no CSS.
  const labelCentreOffset = await page.evaluate(async () => {
    const label = document.querySelector('button[data-team-action="leave"] span[class*="leaveCardLabel"]')
    const control = label?.closest('button')
    if (label == null || control == null) return null
    const labelBox = label.getBoundingClientRect()
    const controlBox = control.getBoundingClientRect()
    return (labelBox.left + labelBox.width / 2) - (controlBox.left + controlBox.width / 2)
  })
  expect(labelCentreOffset).not.toBeNull()
  expect(Math.abs(labelCentreOffset!)).toBeLessThanOrEqual(1)
  const glyphBeforeLabel = await page.evaluate(() => {
    const glyph = document.querySelector('button[data-team-action="leave"] svg')
    const label = document.querySelector('button[data-team-action="leave"] span[class*="leaveCardLabel"]')
    if (glyph == null || label == null) return null
    return glyph.getBoundingClientRect().right <= label.getBoundingClientRect().left
  })
  expect(glyphBeforeLabel).toBe(true)
  // The shipped Settings row is not shadowed and keeps its position.
  expect(teamSettingsBox!.y).toBeCloseTo(settingsBox!.y, 0)
  expect(teamSettingsBox!.height).toBeCloseTo(settingsBox!.height, 0)
  // Team's browsing seat closes on the shipped tree's own bottom fade: same box, same gradient, inert to the pointer.
  // Without it the last row is cut at the clip edge and the seam to the Settings row reads as a break.
  const teamFade = await page.evaluate(() => {
    const fade = document.querySelector('span[class*="boardFade"]')
    if (fade === null) return null
    const box = fade.getBoundingClientRect()
    const style = getComputedStyle(fade)
    return { x: box.x, y: box.y, width: box.width, height: box.height, background: style.backgroundImage, pointerEvents: style.pointerEvents }
  })
  expect(teamFade).not.toBeNull()
  expect(teamFade!.width).toBeCloseTo(shippedFadeBox!.width, 0)
  expect(teamFade!.height).toBeCloseTo(shippedFadeBox!.height, 0)
  expect(teamFade!.x).toBeCloseTo(shippedFadeBox!.x, 0)
  expect(teamFade!.background).toBe(shippedFadeBox!.background)
  expect(teamFade!.pointerEvents).toBe('none')
  // The fade's bottom edge is the browsing seat's own bottom, and that seat ends where the footer row begins: no blank
  // band between the gradient and the Settings row.
  const fadeSeat = await page.evaluate(() => {
    const fade = document.querySelector('span[class*="boardFade"]')
    const seat = document.querySelector('section[class*="workspaceBrowser"]')
    const row = document.querySelector('[data-slot="sidebar.settings"]')
    if (fade === null || seat === null || row === null) return null
    return { fadeBottom: fade.getBoundingClientRect().bottom, seatBottom: seat.getBoundingClientRect().bottom, rowTop: row.getBoundingClientRect().top }
  })
  expect(fadeSeat).not.toBeNull()
  expect(fadeSeat!.fadeBottom).toBeCloseTo(fadeSeat!.seatBottom, 0)
  expect(fadeSeat!.rowTop - fadeSeat!.seatBottom).toBeLessThanOrEqual(4.5)
  await expect.poll(() => page.getByRole('button', { name: '成员', exact: true }).count()).toBe(0)
  const newSessionButtons = page.locator('button[aria-label="新建会话"]')
  const newSessionButton = page.locator('button[class*="newSession"][aria-label="新建会话"]')
  const brandButton = page.locator('button[class*="brand"][aria-label="新建会话"]')
  await expect.poll(() => newSessionButtons.count()).toBe(2)
  await expect.poll(() => newSessionButton.count()).toBe(1)
  await expect.poll(() => newSessionButton.isVisible()).toBe(false)
  await expect.poll(() => brandButton.count()).toBe(1)
  // Known defect: the mode's stand-down hides the `.newSession` bar and the panel
  // rail but not the wide brand row, a second live New Session button on non-
  // macOS. The journey uses it to stage the Human's own session.
  await expect.poll(() => brandButton.isVisible()).toBe(true)
  await page.getByRole('button', { name: '新建项目' }).click()
  const initialProjectDialog = page.getByRole('dialog', { name: '新建项目' })
  await initialProjectDialog.getByLabel('名称').fill('engineering')
  await initialProjectDialog.getByLabel('说明').fill('Agent membership')
  await initialProjectDialog.getByRole('button', { name: '创建项目' }).click()
  for (const [name, description] of [['builder', '实现功能'], ['reviewer', '检查结果']] as const) {
    await page.getByRole('button', { name: '添加 Agent' }).click()
    const dialog = page.getByRole('dialog', { name: '添加 Agent' })
    await dialog.getByLabel('名称').fill(name)
    await dialog.getByLabel('说明').fill(description)
    expect(await dialog.getByRole('button', { name: '初始项目' }).count()).toBe(0)
    if (name === 'builder') {
      // The import entry shares the create dialog; toggling reveals the (empty)
      // global Member roster, and toggling back restores the form with its input.
      await dialog.getByRole('button', { name: '从其他 Workspace 引入' }).click()
      await dialog.getByText('没有可引入的 Agent。').waitFor()
      await page.screenshot({ path: join(UI03_SHOTS, 'agent-import-empty.png'), fullPage: true })
      await dialog.getByRole('button', { name: '创建 Agent' }).click()
      await expect.poll(() => dialog.getByLabel('名称').inputValue()).toBe('builder')
      await page.screenshot({ path: join(UI03_SHOTS, 'agent-create-modal.png'), fullPage: true })
      await dialog.getByRole('button', { name: '模型' }).click()
      await page.getByRole('menuitem', { name: '跟随全局默认' }).waitFor()
      await page.screenshot({ path: join(UI03_SHOTS, 'agent-create-model-menu.png'), fullPage: true })
      // Select the default row: Escape would bubble to the Modal and close the
      // dialog.
      await page.getByRole('menuitem', { name: '跟随全局默认' }).click()
      // The Input atoms sit evenly inside the dialog card (no lopsided right
      // gutter).
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
  await page.getByRole('button', { name: '# engineering' }).hover()
  await page.getByRole('button', { name: 'engineering 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑项目' }).click()
  const joinEditor = page.getByRole('dialog', { name: '编辑项目' })
  await joinEditor.waitFor()
  // Rules version 2 replaces the v1 join editor with Project owners: the Human
  // owns it outright and both Agents wait as addable candidates.
  await joinEditor.getByRole('button', { name: '添加负责人 @builder' }).waitFor()
  await joinEditor.getByRole('button', { name: '添加负责人 @reviewer' }).waitFor()
  expect(await joinEditor.locator('[data-team-project-owner-human]').count()).toBe(1)
  await joinEditor.getByRole('button', { name: '关闭', exact: true }).click()
  // The 390 breakpoint unmounts sidebar panels (dialog state included), so reopen
  // the dialog from the narrow-expanded sidebar after the collapse settles.
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
  // A centred or over-wide identity pushes the avatar right and the row past the
  // sidebar, which a hover-only glance misses.
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

  await page.getByRole('button', { name: '新建项目' }).click()
  const projectDialog = page.getByRole('dialog', { name: '新建项目' })
  await projectDialog.getByLabel('名称').fill('delivery')
  await projectDialog.getByLabel('说明').fill('M2 完整协作验收')
  await projectDialog.getByRole('button', { name: '初始成员' }).click()
  await page.getByRole('menuitem', { name: /builder/ }).click()
  await page.getByRole('menuitem', { name: /reviewer/ }).click()
  await expect.poll(async () => (await projectDialog.getByRole('button', { name: /初始成员/ }).textContent())?.trim() ?? '').toContain('已选 2 个成员')
  await page.screenshot({ path: join(UI03_SHOTS, 'project-create-modal.png'), fullPage: true })
  await projectDialog.getByRole('button', { name: '创建项目' }).click()
  // Reopen from the narrow-expanded sidebar after the collapse settles.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await page.getByRole('button', { name: '打开侧边栏' }).click()
  await page.getByRole('button', { name: '新建项目' }).click()
  const narrowProjectDialog = page.getByRole('dialog', { name: '新建项目' })
  await narrowProjectDialog.getByLabel('名称').waitFor()
  const dialogBox = await narrowProjectDialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.y).toBeGreaterThanOrEqual(0)
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390)
  expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(844)
  await page.screenshot({ path: join(UI03_SHOTS, 'project-create-modal-narrow.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByText('主对话还没有内容', { exact: true }).waitFor()
  await page.screenshot({ path: join(UI02_SHOTS, 'sidebar-projects.png'), fullPage: true })

  // Whole-row native drag: a before/after insertion marker and one commit per
  // gesture; the personal order lives in this browser only.
  const projectOrder = (): Promise<string[]> => page.evaluate(() =>
    [...document.querySelectorAll('[class*="projectSelect"] strong')].map(node => node.textContent?.trim().replace(/^#\s*/, '') ?? ''))
  await expect.poll(projectOrder).toEqual(['engineering', 'delivery'])
  const deliveryRow = page.getByRole('button', { name: '# delivery' })
  const dropBelowTopHalfOf = async (locator: ReturnType<typeof page.getByRole>): Promise<void> => {
    const box = await locator.boundingBox()
    if (box === null) throw new Error('drop target vanished')
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
    const draggingRow = page.getByRole('button', { name: '# engineering' })
    await draggingRow.dispatchEvent('dragstart', { dataTransfer })
    await locator.dispatchEvent('dragover', { dataTransfer, clientY: box.y + box.height * 0.75 })
    // The lower half of the target row must paint the drop-after line before
    // anything commits.
    const deliveryWrapper = locator.locator('xpath=ancestor::div[1]')
    await expect.poll(async () =>
      await deliveryWrapper.evaluate(element => element.className.includes('sidebarRowDropAfter'))).toBe(true)
    await page.screenshot({ path: join(UI02_SHOTS, 'project-drop-marker.png'), fullPage: true })
    await locator.dispatchEvent('drop', { dataTransfer, clientY: box.y + box.height * 0.75 })
    await draggingRow.dispatchEvent('dragend', { dataTransfer })
  }
  await dropBelowTopHalfOf(deliveryRow)
  await expect.poll(projectOrder).toEqual(['delivery', 'engineering'])
  // Boot restore folds the saved order over the freshly loaded Remote default.
  await page.reload()
  await page.getByRole('heading', { name: '# delivery' }).waitFor({ timeout: 20_000 })
  await expect.poll(projectOrder, { timeout: 20_000 }).toEqual(['delivery', 'engineering'])
  // A brand-new project appends after the user's saved entries.
  await page.getByRole('button', { name: '新建项目' }).click()
  const rampDialog = page.getByRole('dialog', { name: '新建项目' })
  await rampDialog.getByLabel('名称').fill('ramp')
  await rampDialog.getByRole('button', { name: '创建项目' }).click()
  await expect.poll(projectOrder).toEqual(['delivery', 'engineering', 'ramp'])

  await page.getByRole('button', { name: '# ramp' }).click()
  await page.getByRole('heading', { name: '# ramp', exact: true }).waitFor()
  const rampComposer = page.getByRole('textbox', { name: '消息内容' })
  await rampComposer.fill('@')
  const rampMenu = page.getByRole('listbox', { name: '提及成员建议' })
  await rampMenu.waitFor()
  const rampWide = await rampMenu.evaluate((element: Element) => [...element.querySelectorAll<HTMLElement>('[role="option"][data-mention-tier]')]
    .map(row => {
      const name = row.querySelector<HTMLElement>('[class*="mentionName"]')!
      return {
        tier: row.getAttribute('data-mention-tier') ?? '',
        inside: row.getAttribute('data-mention-inside') ?? '',
        nameColor: getComputedStyle(name).color,
      }
    }))
  expect(rampWide.length).toBeGreaterThan(0)
  for (const row of rampWide) {
    expect(row.tier).toBe('2')
    expect(row.inside).toBe('false')
  }
  // Resolve the alias the rule names so the expectation follows a theme swap.
  const labelSecondary = await resolveAliasColor(page, '--dsw-alias-label-secondary')
  expect([...new Set(rampWide.map(row => row.nameColor))]).toEqual([labelSecondary])
  await page.screenshot({ path: join(UI04_SHOTS, 'mention-rows-outside.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  // Measure used values: the element never answers a container query about its
  // own visibility.
  const rampNarrow = await rampMenu
    .evaluate((element: Element) => [...element.querySelectorAll<HTMLElement>('[role="option"][data-mention-tier]')]
      .map(row => ({
        nameColor: getComputedStyle(row.querySelector<HTMLElement>('[class*="mentionName"]')!).color,
        descriptionDisplay: getComputedStyle(row.querySelector<HTMLElement>('[class*="mentionDescription"]')!).display,
      })))
  expect(rampNarrow.length).toBeGreaterThan(0)
  for (const row of rampNarrow) {
    expect(row.descriptionDisplay).toBe('none')
    expect(row.nameColor).toBe(labelSecondary)
  }
  await page.screenshot({ path: join(UI04_SHOTS, 'mention-rows-outside-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.keyboard.press('Escape')
  await expect.poll(projectOrder, { timeout: 20_000 }).toEqual(['delivery', 'engineering', 'ramp'])

  await page.getByRole('button', { name: '# engineering' }).hover()
  await page.getByRole('button', { name: 'engineering 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑项目' }).click()
  const projectEditor = page.getByRole('dialog', { name: '编辑项目' })
  await projectEditor.waitFor()
  expect(await projectEditor.locator('[data-team-project-owner-human]').count()).toBe(1)
  const projectSave = projectEditor.getByRole('button', { name: '保存' })
  await expect.poll(async () => await projectSave.isDisabled()).toBe(true)
  await projectEditor.getByLabel('说明').fill('Platform delivery work')
  await expect.poll(async () => await projectSave.isDisabled()).toBe(false)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-edit-modal.png'), fullPage: true })
  await projectSave.click()
  await expect.poll(() => page.getByRole('dialog', { name: '编辑项目' }).count()).toBe(0)
  await page.getByRole('button', { name: '# engineering' }).hover()
  await page.getByRole('button', { name: 'engineering 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑项目' }).click()
  const projectRecheck = page.getByRole('dialog', { name: '编辑项目' })
  await projectRecheck.waitFor()
  await expect.poll(async () => projectRecheck.getByLabel('说明').inputValue()).toBe('Platform delivery work')
  await projectRecheck.getByRole('button', { name: '关闭', exact: true }).click()
  await expect.poll(() => page.getByRole('dialog', { name: '编辑项目' }).count()).toBe(0)
  const projectsToggle = page.getByRole('button', { name: '项目', exact: true })
  await projectsToggle.click()
  await expect.poll(() => page.getByRole('button', { name: '# engineering' }).count()).toBe(0)
  // Collapse is a browser-local preference that survives reload; the section
  // header stays reachable while collapsed.
  await page.reload()
  await projectsToggle.waitFor({ timeout: 20_000 })
  await expect.poll(() => page.getByRole('button', { name: '# engineering' }).count()).toBe(0)
  await projectsToggle.click()
  await page.getByRole('button', { name: '# engineering' }).waitFor()

  const workspaceTrigger = page.getByRole('button', { name: '工作区，team-workspace', exact: true })
  await expect.poll(async () => (await workspaceTrigger.textContent())?.trim() ?? '').toBe('team-workspace')
  await expect.poll(() => workspaceTrigger.getAttribute('aria-haspopup')).toBe('menu')
  await expect.poll(() => workspaceTrigger.getAttribute('aria-expanded')).toBe('false')
  await workspaceTrigger.click()
  await expect.poll(() => workspaceTrigger.getAttribute('aria-expanded')).toBe('true')
  await page.getByRole('menuitem', { name: 'team-workspace' }).waitFor()
  await page.keyboard.press('Escape')
  await expect.poll(() => workspaceTrigger.getAttribute('aria-expanded')).toBe('false')
  // Opening from the keyboard focuses the first row; Escape returns focus to the
  // trigger.
  await workspaceTrigger.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('role') ?? '')).toBe('menuitem')
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => document.activeElement?.matches('[data-team-workspace-trigger]') ?? false)).toBe(true)
  // The Inbox crosses Workspaces (its total sums all of them), so it sits above
  // the selector that scopes the sections.
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
  await expect.poll(() => agentEditor.getByRole('button', { name: '移除' }).count()).toBe(0)
  await expect.poll(() => agentEditor.getByRole('button', { name: '添加' }).count()).toBe(0)
  // The picker lists the Host catalog grouped by provider with no live Session
  // round-trip.
  const modelTrigger = agentEditor.getByRole('button', { name: '模型', exact: true })
  await modelTrigger.waitFor()
  await expect.poll(() => modelTrigger.textContent()).toBe('跟随全局默认')
  await modelTrigger.click()
  const modelMenu = page.locator('[role="menu"]').filter({ hasText: '跟随全局默认' })
  await modelMenu.waitFor()
  expect(await modelMenu.getByRole('menuitem').count()).toBeGreaterThanOrEqual(2)
  // The shared Menu's row radius, measured live; the mention popover below must
  // match it.
  const shippedRowRadius = await modelMenu.getByRole('menuitem').first()
    .evaluate(row => getComputedStyle(row).borderTopLeftRadius)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-model-menu.png'), fullPage: true })
  await modelMenu.getByRole('menuitem', { name: '跟随全局默认' }).click()
  await expect.poll(() => page.locator('[role="menu"]').count()).toBe(0)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-edit-modal.png'), fullPage: true })
  await agentEditor.getByRole('button', { name: '关闭', exact: true }).click()

  // Row menus omit any clear-context entry: the Host recycles a Member's
  // generation at its wake boundary.
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

  // Opening an Agent card keeps Team mode mounted and swaps only the right pane:
  // the shipped root renders the Member Session's blank-session hero composer
  // with the workspace and `team-member` preset chips.
  // The Human's own session is staged first so the embedded view has a return
  // target.
  await brandButton.click()
  await expect.poll(() => scaffold.ctx.sessions.list().length).toBeGreaterThanOrEqual(3)
  await builderRow.getByRole('button', { name: '打开 builder 的会话' }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe('team')
  await expect.poll(() => page.locator('[data-team-project]').count()).toBe(0)
  // The Team manages no member-session input surface; only the shipped composer
  // is asserted.
  const memberInput = page.locator('[data-composer-input][contenteditable="true"]')
  await expect.poll(() => memberInput.count()).toBe(1)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-session-composer.png'), fullPage: true })

  await expect.poll(() => page.evaluate(() => ({
    project: document.querySelectorAll('[data-team-project]').length,
    mode: document.documentElement.dataset.agentTeamMode ?? null,
  })), { timeout: 10_000 }).toEqual({ project: 0, mode: 'team' })
  await expect.poll(() => memberInput.isEnabled()).toBe(true)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-session-live.png'), fullPage: true })
  // Host side: the Member is still bound to its original Session id.
  const liveStatuses = scaffold.ctx.agentTeam.members({ workspaceId: memberWorkspace.id })
  const liveBuilder = liveStatuses.find((status: { member: { handle: string } }) => status.member.handle === 'builder')!
  expect(liveBuilder.member.sessionId).toBe(builderMember.member.sessionId)
  expect(scaffold.ctx.workspaceRegistry.archivedSessionIds).not.toContain(builderMember.member.sessionId)

  // A plain prompt through the shipped composer lands on the Member's live
  // Session.
  await memberInput.click()
  await page.keyboard.type('member session hello')
  await page.keyboard.press('Enter')
  const isPlainMemberPrompt = (event: ReturnType<typeof builderAgent.session.snapshotEvents>[number]): boolean => event.type === 'user/message'
    && event.data.source.kind === 'user'
    && event.data.content.some(block => block.type === 'text' && block.text === 'member session hello')
  await expect.poll(() => builderAgent.session.snapshotEvents().some(isPlainMemberPrompt)).toBe(true)
  await builderAgent.whenIdle()
  await expect.poll(() => page.locator('[class*="agentRow"]').count()).toBeGreaterThan(0)
  // The single highlight sits on the selected Agent card, not on the workspace
  // overview row.
  await expect.poll(() => teamCurrentPage.count()).toBe(1)
  await expect.poll(() => teamCurrentPage.getAttribute('aria-label')).toBe('打开 builder 的会话')
  await expect.poll(() => page.getByRole('button', { name: '# delivery' }).count()).toBe(1)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-session-dm.png'), fullPage: true })
  await builderRow.hover()
  await builderRow.getByRole('button', { name: 'builder 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑 Agent' }).waitFor()
  await expect.poll(() => page.evaluate(() => {
    const el = document.querySelector('[data-slot="sidebar.workspaces"] [aria-current="page"]')
    return el === null ? 'missing' : getComputedStyle(el).backgroundColor
  })).toBe('rgba(0, 0, 0, 0)')
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-session-dm-row-menu.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'agent-session-dm-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await expect.poll(() => page.locator('[data-team-project]').count()).toBe(1)
  await page.getByText('主对话还没有内容', { exact: true }).waitFor()
  await page.screenshot({ path: join(UI02_SHOTS, 'sidebar-projects.png'), fullPage: true })
  await page.screenshot({ path: join(UI01_SHOTS, 'empty-project.png'), fullPage: true })
  const projectComposer = page.getByRole('textbox', { name: '消息内容' })
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('消息内容')
  await page.getByRole('tab', { name: '看板' }).focus()
  const idleComposerBorder = await page.locator('[data-team-composer]').evaluate(element => {
    const style = getComputedStyle(element)
    return `${style.borderColor} ${style.boxShadow}`
  })
  await projectComposer.click()
  expect(await page.locator('[data-team-composer]').evaluate(element => {
    const style = getComputedStyle(element)
    return `${style.borderColor} ${style.boxShadow}`
  })).toBe(idleComposerBorder)
  await projectComposer.fill('请协作完成验收 @')
  // The menu surface token is translucent, so the popup must blur what is behind
  // it to stay legible. Radii are read from the running `--dsw-radius-*` tiers
  // (lg surface, md rows).
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
  // Weight is the row's only distinction between a Member already in this Project
  // and one the Project never carried.
  const projectMentionRows = await page.getByRole('listbox', { name: '提及成员建议' })
    .evaluate((element: Element) => [...element.querySelectorAll('[role="option"][data-mention-tier]')].map(row => ({
      tier: row.getAttribute('data-mention-tier') ?? '',
      inside: row.getAttribute('data-mention-inside') ?? '',
      text: row.textContent ?? '',
    })))
  expect(projectMentionRows.length).toBeGreaterThan(1)
  // Every candidate already takes part in this Project, so none is dimmed; the
  // outside tier is driven by the ramp case and the component spec.
  for (const row of projectMentionRows) {
    expect(row.inside).toBe(String(row.tier !== '2'))
    expect(row.text).not.toContain('需确认')
  }
  expect([...new Set(projectMentionRows.map(row => row.inside))]).toEqual(['true'])
  await page.getByRole('option', { name: /@builder/ }).click()
  await page.screenshot({ path: join(UI04_SHOTS, 'mention-menu-selected.png'), fullPage: true })
  const startToggle = page.getByRole('button', { name: '讨论/任务' })
  await expect.poll(() => startToggle.getAttribute('aria-pressed')).toBe('false')
  await startToggle.focus()
  await page.keyboard.press('Space')
  await expect.poll(() => startToggle.getAttribute('aria-pressed')).toBe('true')
  // The pressed state must be visible on its own: primary fill, unchanged by hover.
  const pressedFill = await startToggle.evaluate(element => getComputedStyle(element).backgroundColor)
  await startToggle.hover()
  expect(await startToggle.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(pressedFill)
  await page.screenshot({ path: join(UI04_SHOTS, 'thread-start-pressed.png'), fullPage: true })
  // The label stays at every width; the narrow branch tightens the toolbar gaps.
  // Runs in the settled collapsed layout.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await expect.poll(async () => (await page.locator('[data-team-project]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(330)
  // The pill's accessible name is its label text, which the role locator above
  // already resolves; the pressed state is what must stay explicit.
  expect(await startToggle.getAttribute('aria-pressed')).toBe('true')
  const modeLabel = (element: Element) => {
    const label = element.querySelector('[class*="asTaskLabel"]')
    const toolbar = element.closest('[class*="toolbar"]')
    return {
      display: label === null ? 'missing' : getComputedStyle(label).display,
      gap: toolbar === null ? 'missing' : getComputedStyle(toolbar).gap,
    }
  }
  const narrow = await startToggle.evaluate(modeLabel)
  expect(narrow.display).not.toBe('none')
  expect(narrow.display).not.toBe('missing')
  expect(narrow.gap).toBe('8px')
  await page.setViewportSize({ width: 1440, height: 960 })
  const wide = await startToggle.evaluate(modeLabel)
  expect(wide.display).not.toBe('none')
  expect(wide.display).not.toBe('missing')
  expect(wide.gap).toBe('12px')
  // The checked 作为任务 turns the send into a Task; the mention rides along.
  await page.getByRole('checkbox', { name: '作为任务' }).check()
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('tab', { name: '看板' }).waitFor()
  await expect.poll(() => page.getByRole('tab', { name: '看板' }).getAttribute('aria-selected')).toBe('true')
  const committedTask = page.getByRole('button', { name: '打开 Task #1', exact: true })
  await committedTask.waitFor()
  await page.getByRole('tab', { name: '主对话' }).click()
  await expect.poll(() => startToggle.getAttribute('aria-pressed')).toBe('false')
  await expect.poll(() => page.getByRole('textbox', { name: '消息内容' }).inputValue()).toBe('')
  await page.getByRole('button', { name: '发送', exact: true }).waitFor()

  // A hand-typed handle is delivered like a menu pick, so the notify row reports
  // it and follows the text when it is deleted.
  await projectComposer.fill('再确认一次 @reviewer')
  await expect.poll(() => page.getByText(/将通知/).textContent()).toContain('@reviewer')
  await page.screenshot({ path: join(UI04_SHOTS, 'mention-typed-notify.png'), fullPage: true })
  await projectComposer.fill('')
  await expect.poll(() => page.getByText(/将通知/).count()).toBe(0)

  // The composer picks no @all at version 2: the menu is proven live by a real
  // handle's row, and '@a' — which prefixes "all" and no handle here — then
  // matches nothing.
  await projectComposer.fill('全员同步 @r')
  await page.getByRole('option', { name: /@reviewer/ }).waitFor()
  await projectComposer.fill('全员同步 @a')
  await expect.poll(() => page.getByRole('option').count()).toBe(0)
  await projectComposer.fill('')
  // A plain post with the same words stays a Main stream message: no Thread is
  // opened, so the stream article carries it without a card.
  await projectComposer.fill('全员同步，今天截止')
  await page.getByRole('button', { name: '发送' }).click()
  const allMessage = page.locator('[data-team-project] article').filter({ hasText: '全员同步' })
  await allMessage.waitFor()
  expect((await allMessage.textContent())?.includes('全员同步，今天截止')).toBe(true)

  // Only refs the Host resolves become links; unknown UUID-shaped task refs and
  // non-UUID `project:` prose stay literal.
  await projectComposer.fill('请复核 task:c0ffee00-1234-4c05-8a9e-6f2b1c9d7e21 与 project:engineering 的口径')
  await page.getByRole('button', { name: '发送' }).click()
  const refMessage = page.locator('[data-team-project] article').filter({ hasText: '请复核' })
  await refMessage.waitFor()
  expect(await refMessage.getByRole('button', { name: /task:c0ffee00|project:engineering/ }).count()).toBe(0)
  await expect.poll(() => refMessage.textContent()).toContain('task:c0ffee00-1234-4c05-8a9e-6f2b1c9d7e21')
  expect(await refMessage.textContent()).toContain('project:engineering')
  await page.screenshot({ path: join(UI04_SHOTS, 'message-ref-linkify.png'), fullPage: true })

  // A body past the character threshold starts clamped behind 展开全文, expands in
  // place under an alpha fade, and collapses via the same control.
  const longBody = '这是一条超长验收消息。'.repeat(60)
  await projectComposer.fill(longBody)
  await page.getByRole('button', { name: '发送' }).click()
  const longMessage = page.locator('[data-team-project] article').filter({ hasText: '这是一条超长验收消息' })
  await longMessage.waitFor()
  const expandControl = longMessage.getByRole('button', { name: '展开全文' })
  await expandControl.waitFor()
  expect(await expandControl.getAttribute('aria-expanded')).toBe('false')
  await page.screenshot({ path: join(UI04_SHOTS, 'message-clamp-preview.png'), fullPage: true })
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

  // The "+" picker takes real files, chips confirm the selection, and the sent
  // message renders the thumbnail from the Host cache.
  // A screenshot-sized PNG, so thumbnails and zoom show real scaling.
  const pngBytes = await readFile(join(UI02_SHOTS, 'sidebar-projects.png'))
  const uploadPath = join(BROWSER_ARTIFACTS, 'upload-fixture.png')
  await writeFile(uploadPath, pngBytes)
  // The "+" control must open the real file picker (not a command menu).
  const pickerPromise = page.waitForEvent('filechooser', { timeout: 5000 })
  await page.getByRole('button', { name: '添加附件' }).click()
  await pickerPromise
  await page.locator('[data-team-composer] input[type="file"]').setInputFiles([{ name: '验收截图.png', mimeType: 'image/png', buffer: pngBytes }])
  await page.getByText('验收截图.png').waitFor()
  await projectComposer.fill('这是带附件的验收消息')
  await page.screenshot({ path: join(UI04_SHOTS, 'composer-attachment-chip.png'), fullPage: true })
  await page.getByRole('button', { name: '发送' }).click()
  // One text column and no hover layer in Project feed rows; that language
  // belongs to the Thread.
  const projectRows = page.locator('[data-team-project] article')
  await expect.poll(() => projectRows.count()).toBeGreaterThanOrEqual(2)
  const projectColumns = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-team-project] article')]
    const columnOf = (row: Element): number => {
      const body = row.querySelector('[class*="messageBody"]')
      return body === null ? -1 : Math.round(body.getBoundingClientRect().left)
    }
    return {
      columns: [...new Set(rows.map(columnOf))],
      sides: rows.filter(row => row.hasAttribute('data-side')).length,
      cards: document.querySelectorAll('[data-team-project] [data-message-card]').length,
      seats: document.querySelectorAll('[data-team-project] [data-card-time]').length,
    }
  })
  expect(projectColumns.columns.length).toBe(1)
  expect(projectColumns.sides).toBe(0)
  // The Main stream shows each row's actions card unconditionally, so the
  // invariant is one card per row, never more.
  expect(projectColumns.cards).toBe(await projectRows.count())
  expect(projectColumns.seats).toBe(0)
  const feedRow = projectRows.filter({ hasText: '这是一条超长验收消息' }).first()
  await feedRow.hover()
  await settleAnimations(page)
  expect(await feedRow.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')

  const attachmentMessage = page.locator('[data-team-project] article').filter({ hasText: '这是带附件的验收消息' })
  await attachmentMessage.waitFor()
  await expect.poll(() => page.locator('[data-team-project] article img[src^="data:image/png"]').count()).toBeGreaterThanOrEqual(1)
  await expect.poll(() => page.getByText('验收截图.png', { exact: true }).count()).toBe(0)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-attachment-thumbnail.png'), fullPage: true })
  await page.locator('[data-team-project] article img[src^="data:image/png"]').first().click()
  await page.getByRole('dialog').waitFor()
  await expect.poll(() => page.getByRole('dialog').locator('img').count()).toBe(1)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-attachment-zoom.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect.poll(() => page.getByRole('dialog').count()).toBe(0)

  // A real Chromium paste carrying an image file is intercepted before native
  // handling and joins the chip flow.
  await projectComposer.focus()
  await projectComposer.evaluate((el, bytes) => {
    const file = new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, [...pngBytes])
  await page.getByText('image.png').first().waitFor()
  await projectComposer.fill('这是粘贴上传的截图')
  await page.getByRole('button', { name: '发送' }).click()
  const pastedMessage = page.locator('[data-team-project] article').filter({ hasText: '这是粘贴上传的截图' })
  await pastedMessage.waitFor()
  await expect.poll(() => pastedMessage.locator('img[src^="data:image/png"]').count()).toBeGreaterThanOrEqual(1)

  // Unresolvable refs stay plain text without horizontal overflow at narrow
  // width.
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await refMessage.getByRole('button', { name: /task:c0ffee00|project:engineering/ }).count()).toBe(0)
  expect((await refMessage.textContent())?.includes('task:c0ffee00-1234-4c05-8a9e-6f2b1c9d7e21')).toBe(true)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-ref-linkify-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-attachment-thumbnail-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  // Stacked bands: header, feed stage (one child holding timeline and composer),
  // composer.
  const projectGeometry = await page.locator('[data-team-project]').evaluate(element => {
    const children = [...element.children].map(child => child.getBoundingClientRect())
    return children.map(rect => ({ top: rect.top, bottom: rect.bottom, height: rect.height }))
  })
  expect(projectGeometry).toHaveLength(2)
  expect(projectGeometry[0]!.bottom).toBeLessThanOrEqual(projectGeometry[1]!.top + 1)
  expect(projectGeometry[1]!.height).toBeGreaterThan(200)
  // The header band sits near the pane's left edge while entry rows stay in the
  // centred reading column; the tab strip takes the band's edge.
  const projectColumnEdges = await page.evaluate(() => {
    const root = document.querySelector('[data-team-project]')
    const round = (value: number) => Math.round(value)
    const box = (node: Element | null) => node === null ? null : round(node.getBoundingClientRect().x)
    return {
      pane: root === null || root === undefined ? null : round(root.getBoundingClientRect().x),
      header: box(root?.querySelector('header')),
      tabs: box(root?.querySelector('[role="tablist"]')),
      entry: box(root?.querySelector('article [class*="messageBody"]')),
    }
  })
  expect(projectColumnEdges.header).not.toBeNull()
  expect(projectColumnEdges.tabs).toBe(projectColumnEdges.header)
  expect(projectColumnEdges.header! - projectColumnEdges.pane!).toBeLessThanOrEqual(32)
  expect(projectColumnEdges.entry).toBeGreaterThan(projectColumnEdges.header!)
  // Shipped session header shape: one identity row (title with the description
  // beside it) and the tab strip beneath, its 2px bar on the band's closing rule.
  // The description shares the title's line so the band height does not depend on
  // it.
  const projectBand = await page.evaluate(() => {
    const round = (value: number) => Math.round(value)
    const root = document.querySelector('[data-team-project]')
    const band = root?.querySelector('[class*="surfaceHeader"]')
    const title = root?.querySelector('h1')
    const description = root?.querySelector('h1 + p')
    const strip = root?.querySelector('[role="tablist"]')
    const active = strip?.querySelector('[aria-selected="true"]')
    if (band === null || band === undefined || title === null || title === undefined
      || strip === null || strip === undefined || active === null || active === undefined) return null
    const strip$ = strip.getBoundingClientRect()
    const bar = getComputedStyle(active, '::after')
    return {
      bandHeight: round(band.getBoundingClientRect().height),
      titleBottom: round(title.getBoundingClientRect().bottom),
      descriptionTop: description === null || description === undefined ? null : round(description.getBoundingClientRect().top),
      descriptionLines: description === null || description === undefined ? 0 : round(description.getBoundingClientRect().height / parseFloat(getComputedStyle(description).lineHeight)),
      stripBottom: round(strip$.bottom),
      ruleBottom: round(band.getBoundingClientRect().bottom),
      barColor: bar.backgroundColor,
      backRows: root === null ? -1 : [...root.querySelectorAll('button')].filter(node => (node.textContent ?? '').includes('返回项目列表')).length,
    }
  })
  expect(projectBand).not.toBeNull()
  expect(Math.abs(projectBand!.stripBottom - projectBand!.ruleBottom)).toBeLessThanOrEqual(1)
  expect(projectBand!.descriptionLines).toBe(1)
  expect(projectBand!.backRows).toBe(0)
  expect(projectBand!.descriptionTop).toBeLessThan(projectBand!.titleBottom)
  expect(projectBand!.barColor).not.toBe('rgba(0, 0, 0, 0)')
  // One 76px band at the shipped header's top inset.
  expect(projectBand!.bandHeight).toBeLessThanOrEqual(80)
  // The feed reads the shared conversation surface's seat declaration off the
  // Project root (custom properties inherit, never re-resolve there). The face is
  // measured too, since a fallback equal to the declaration would satisfy it.
  const projectSeat = await page.evaluate(() => {
    const root = document.querySelector('[data-team-project]')
    const face = document.querySelector('[data-team-project] article [class*="messageIdentity"], [data-team-project] article [class*="messageIdentityImage"]')
    return {
      declared: root === null ? null : getComputedStyle(root).getPropertyValue('--team-identity-seat').trim(),
      face: face === null ? null : Math.round(face.getBoundingClientRect().width),
    }
  })
  expect(projectSeat.declared).toBe('34px')
  expect(projectSeat.face).toBe(34)
  await page.screenshot({ path: join(UI01_SHOTS, 'desktop-project.png'), fullPage: true })
  await expect.poll(async () => await page.getByRole('button', { name: '管理成员' }).count()).toBe(0)
  await expect.poll(async () => await page.getByRole('dialog', { name: '项目成员' }).count()).toBe(0)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-members-retired.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  const narrowProjectFrame = page.locator('[data-sidebar-collapsed="true"]')
  await narrowProjectFrame.waitFor()
  await expect.poll(async () => (await narrowProjectFrame.locator(':scope > div').first().boundingBox())?.width ?? 999).toBeLessThanOrEqual(56)
  await expect.poll(async () => (await page.locator('[data-team-project]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(330)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'narrow-project.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })

  await startToggle.click()
  await projectComposer.fill('这是一条不作为任务的讨论')
  await page.getByRole('button', { name: '发送' }).click()
  const tasklessCard = page.getByRole('button', { name: /^打开讨论：这是一条不作为任务的讨论/ })
  await tasklessCard.waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  const tasklessProjectFrame = page.locator('[data-sidebar-collapsed="true"]')
  await tasklessProjectFrame.waitFor()
  await expect.poll(async () => (await tasklessProjectFrame.locator(':scope > div').first().boundingBox())?.width ?? 999).toBeLessThanOrEqual(56)
  await expect.poll(async () => (await page.locator('[data-team-project]').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(330)
  await tasklessCard.click()
  // A taskless discussion opens beside its feed; the Project page, timeline, and
  // the discussion's door stay.
  const panel = page.locator('[data-team-panel]')
  await panel.waitFor()
  await expect.poll(async () => await page.getByRole('heading', { name: '# delivery' }).count()).toBe(1)
  await expect.poll(async () => await page.locator('[data-team-project]').count()).toBe(1)
  // A discussion has no acceptance control; the feed beside it holds a Task's
  // door.
  expect(await panel.getByRole('button', { name: '验收' }).count()).toBe(0)
  const promote = page.getByRole('button', { name: '转为 Task' })
  await promote.waitFor()
  // At 390px the panel covers the feed and neither overflows. The band keeps its
  // own width (the panel must not reserve a column there); it is measured against
  // the surface because a clipped surface hides this from page-level overflow
  // checks.
  await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0))
    .toBeGreaterThanOrEqual(Math.round((await page.locator('[data-team-project]').boundingBox())?.width ?? 0) - 2)
  const narrowBand = await page.evaluate(() => {
    const box = (node: Element | null | undefined) => node?.getBoundingClientRect()
    const surface = box(document.querySelector('[data-team-project]'))
    const headerRow = box(document.querySelector('[data-team-project] [class*="headerRow"]'))
    if (surface === undefined || headerRow === undefined) return null
    return { surfaceWidth: Math.round(surface.width), headerRowWidth: Math.round(headerRow.width) }
  })
  expect(narrowBand).not.toBeNull()
  expect(narrowBand!.headerRowWidth).toBe(narrowBand!.surfaceWidth - 24)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'taskless-panel-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  // At desktop width the panel opens right of the feed without overlap, leaving a
  // readable reading column.
  const panelSplit = await page.evaluate(() => {
    const round = (value: number) => Math.round(value)
    const panelBox = document.querySelector('[data-team-panel]')?.getBoundingClientRect()
    const timelineBox = document.querySelector('[data-team-project] section[aria-label]')?.getBoundingClientRect()
    return panelBox === undefined || timelineBox === undefined ? null : {
      panelLeft: round(panelBox.left), panelWidth: round(panelBox.width),
      timelineRight: round(timelineBox.right), timelineWidth: round(timelineBox.width),
    }
  })
  expect(panelSplit).not.toBeNull()
  expect(panelSplit!.timelineRight).toBeLessThanOrEqual(panelSplit!.panelLeft + 1)
  expect(panelSplit!.timelineWidth).toBeGreaterThanOrEqual(520)
  // The panel head shares the band's identity row (same top and height) and its
  // foot the composer's line; each is an equation between boxes measured in one
  // render.
  const bandEdges = await page.evaluate(() => {
    const box = (node: Element | null | undefined) => node?.getBoundingClientRect()
    const surface = box(document.querySelector('[data-team-project]'))
    const headerRow = box(document.querySelector('[data-team-project] [class*="headerRow"]'))
    const panel = box(document.querySelector('[data-team-panel]'))
    const panelHead = box(document.querySelector('[data-team-panel] [class*="panelHead"]'))
    const panelFoot = box(document.querySelector('[data-team-panel] [data-team-composer]'))
    const feedFoot = box(document.querySelector('[data-team-project] [data-panel] [data-team-composer]'))
    if (surface === undefined || headerRow === undefined || panel === undefined || panelHead === undefined) return null
    return {
      surfaceTop: Math.round(surface.top), surfaceBottom: Math.round(surface.bottom),
      panelTop: Math.round(panel.top), panelBottom: Math.round(panel.bottom),
      headerRowTop: Math.round(headerRow.top), headerRowHeight: Math.round(headerRow.height),
      panelHeadTop: Math.round(panelHead.top), panelHeadHeight: Math.round(panelHead.height),
      panelFootBottom: panelFoot === undefined ? null : Math.round(panelFoot.bottom),
      feedFootBottom: feedFoot === undefined ? null : Math.round(feedFoot.bottom),
    }
  })
  expect(bandEdges).not.toBeNull()
  expect(bandEdges!.panelTop).toBe(bandEdges!.surfaceTop)
  expect(bandEdges!.panelBottom).toBe(bandEdges!.surfaceBottom)
  expect(bandEdges!.panelHeadTop).toBe(bandEdges!.headerRowTop)
  expect(bandEdges!.panelHeadHeight).toBe(bandEdges!.headerRowHeight)
  expect(bandEdges!.panelFootBottom).toBe(bandEdges!.feedFootBottom)
  // The seam is a separator control; a drag re-seats the panel while the feed
  // gives up exactly what it takes.
  const handle = page.locator('[data-team-panel-handle]')
  await handle.waitFor()
  expect(await handle.getAttribute('role')).toBe('separator')
  const seam = async (): Promise<{ panel: number, feed: number }> => await page.evaluate(() => {
    const box = (node: Element | null | undefined) => node?.getBoundingClientRect()
    const panel = box(document.querySelector('[data-team-panel]'))
    const feed = box(document.querySelector('[data-team-project] [data-panel] section[aria-label]'))
    return { panel: Math.round(panel?.width ?? 0), feed: Math.round(feed?.width ?? 0) }
  })
  const before = await seam()
  const handleBox = await handle.boundingBox()
  expect(handleBox).not.toBeNull()
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 200)
  await page.mouse.down()
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 - 40, handleBox!.y + 200)
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 - 120, handleBox!.y + 200)
  await page.mouse.up()
  await expect.poll(async () => (await seam()).panel).toBeGreaterThan(before.panel + 100)
  const dragged = await seam()
  expect(Math.abs((before.panel + before.feed) - (dragged.panel + dragged.feed))).toBeLessThanOrEqual(2)
  await page.screenshot({ path: join(UI04_SHOTS, 'taskless-panel-resized.png'), fullPage: true })
  // The seat survives reload and is reachable by keyboard. The stored seat is the
  // clamped integer; the painted box may differ by its border, hence the
  // tolerance.
  const storedWidth = await page.evaluate(() => Number(localStorage.getItem('dsh.agent-team.panel-width.v1')))
  expect(Math.abs(storedWidth - dragged.panel)).toBeLessThanOrEqual(1)
  await page.reload()
  await page.locator('[data-team-project]').first().waitFor()
  const reopened = page.getByRole('button', { name: /^打开讨论：这是一条不作为任务的讨论/ })
  await reopened.click()
  await page.locator('[data-team-panel]').waitFor()
  await expect.poll(async () => (await seam()).panel).toBe(dragged.panel)
  await page.locator('[data-team-panel-handle]').focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => (await seam()).panel).toBeLessThan(dragged.panel)
  // The panel's Messages carry the Thread page's hover card: copy and quote.
  const panelRow = page.locator('[data-team-panel] article').first()
  await panelRow.hover()
  await settleAnimations(page)
  const panelCard = panelRow.locator('[data-message-card]')
  await expect.poll(() => panelCard.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  // It hangs off the Message's own top-right corner here too — the panel is a narrower seat, not a different card language,
  // so the same anchoring holds and its lower edge still stops 2px above this Message's first line.
  const panelCardPlacement = await panelRow.evaluate(element => {
    const card = element.querySelector('[data-message-card]')!
    const cardBox = card.getBoundingClientRect()
    const rowBox = element.getBoundingClientRect()
    const body = element.querySelector('[class*="messageBody"]')!
    return {
      cardPosition: getComputedStyle(card).position,
      cardTop: getComputedStyle(card).top,
      riseAboveRow: Math.round(rowBox.top - cardBox.top),
      clearanceAboveWords: Math.round(
        (body.querySelector('[class*="nameRow"]')?.nextElementSibling ?? body).getBoundingClientRect().top - cardBox.bottom,
      ),
      gapToRowEdge: Math.round(cardBox.right - rowBox.right),
    }
  })
  expect(panelCardPlacement.cardPosition).toBe('absolute')
  expect(panelCardPlacement.riseAboveRow).toBe(0)
  // The same anchoring as the Thread page: never above its own row, never on the words it acts on.
  expect(panelCardPlacement.clearanceAboveWords).toBeGreaterThanOrEqual(2)
  expect(Math.abs(panelCardPlacement.gapToRowEdge)).toBeLessThanOrEqual(1)
  await panelCard.locator('[data-quote-message]').click()
  const replyBanner = page.locator('[data-team-panel] [data-reply-banner]')
  await replyBanner.waitFor()
  await expect.poll(async () => await replyBanner.textContent()).toContain('引用')
  await page.getByRole('button', { name: '取消引用' }).click()
  await expect.poll(async () => await replyBanner.count()).toBe(0)
  await page.mouse.move(4, 4)
  await expect.poll(() => panelCard.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
  await settleAnimations(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'taskless-panel-desktop.png'), fullPage: true })
  await promote.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: 'Task #2' }).waitFor()
  await page.getByText('Human 为此讨论创建了 Task').waitFor()
  expect(await page.getByRole('button', { name: '转为 Task' }).count()).toBe(0)
  await page.getByRole('button', { name: '返回项目' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()

  // The Project's two readings form one tab stop; arrow keys move selection with
  // focus.
  const feedTab = page.getByRole('tab', { name: '主对话' })
  const boardTab = page.getByRole('tab', { name: '看板' })
  await feedTab.waitFor()
  expect(await feedTab.getAttribute('aria-selected')).toBe('true')
  expect(await boardTab.getAttribute('tabindex')).toBe('-1')
  await feedTab.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => await boardTab.getAttribute('aria-selected')).toBe('true')
  await expect.poll(() => page.evaluate(() => document.activeElement?.textContent ?? '')).toBe('看板')
  await settleLayout(page)
  // The board is a full-content switch: four status columns, and no composer (a
  // status view has no send).
  const boardPanel = page.locator('[role="tabpanel"]')
  const boardHeadings = await boardPanel.locator('[class*="boardColumnHead"]').allTextContents()
  expect(boardHeadings.map(text => text.replace(/\d+$/, ''))).toEqual(['待处理', '进行中', '待验收', '已完成'])
  expect(await page.getByRole('textbox', { name: '消息内容' }).count()).toBe(0)
  const boardGeometry = await page.evaluate(() => {
    const round = (value: number) => Math.round(value)
    const scrollport = document.querySelector('[role="tabpanel"]')
    const columns = [...document.querySelectorAll('[role="tabpanel"] > div > div')].map(node => node.getBoundingClientRect())
    return {
      count: columns.length,
      tops: [...new Set(columns.map(box => round(box.top)))],
      widths: columns.map(box => round(box.width)),
      lefts: columns.map(box => round(box.left)),
      right: round(columns.at(-1)?.right ?? 0),
      scrollport: scrollport === null ? null : { left: round(scrollport.getBoundingClientRect().left), right: round(scrollport.getBoundingClientRect().right), width: round(scrollport.getBoundingClientRect().width) },
      pageWidth: document.documentElement.clientWidth,
    }
  })
  expect(boardGeometry.count).toBe(4)
  // Four equal columns: `flex: 1` with `min-width: 0` stops a wide card taking
  // room from its neighbours.
  expect(boardGeometry.tops).toHaveLength(1)
  expect(new Set(boardGeometry.widths).size).toBe(1)
  expect(boardGeometry.widths[0]).toBeGreaterThanOrEqual(150)
  // Columns span the content box rather than huddling at one edge.
  expect(boardGeometry.lefts[0]! - boardGeometry.scrollport!.left).toBeLessThanOrEqual(boardGeometry.lefts[1]! - boardGeometry.lefts[0]!)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-board.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  // Four columns cannot fit 390px, so the board scrolls sideways and keeps cards
  // readable; squeezing would break titles to one character per line while still
  // passing an overflow check.
  const narrowBoard = await page.evaluate(() => {
    const round = (value: number) => Math.round(value)
    const track = document.querySelector('[role="tabpanel"] > div')
    const cards = [...document.querySelectorAll('[role="tabpanel"] button')].map(node => node.getBoundingClientRect())
    return {
      cardWidths: cards.map(box => round(box.width)),
      track: track === null ? null : {
        overflowX: getComputedStyle(track).overflowX,
        scrollWidth: round(track.scrollWidth),
        clientWidth: round(track.clientWidth),
      },
    }
  })
  expect(narrowBoard.cardWidths.length).toBeGreaterThanOrEqual(1)
  expect(Math.min(...narrowBoard.cardWidths)).toBeGreaterThanOrEqual(190)
  // The overflow lives in the track's own horizontal scroll, not the page;
  // `hidden` would clip the last columns with nothing to reach them.
  expect(narrowBoard.track!.overflowX).toBe('auto')
  expect(narrowBoard.track!.scrollWidth).toBeGreaterThan(narrowBoard.track!.clientWidth)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'narrow-project-board.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => await feedTab.getAttribute('aria-selected')).toBe('true')
  await expect.poll(async () => await page.getByRole('textbox', { name: '消息内容' }).count()).toBeGreaterThanOrEqual(1)
  await feedTab.focus()
  await page.keyboard.press('End')
  await expect.poll(async () => await boardTab.getAttribute('aria-selected')).toBe('true')
  await page.keyboard.press('Home')
  await expect.poll(async () => await feedTab.getAttribute('aria-selected')).toBe('true')

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

  // A v2 mention delivers a marker, not a following: attention is an explicit
  // choice, so builder follows the Thread through the Host before the menu
  // below ranks it in the follower tier.
  const builderFollow = await scaffold.ctx.agentTeam.changeAttentionForAgent(agent, {
    requestId: 'm2-05-builder-follow' as never, action: 'follow', workspaceId: workspace.id, taskRef: task.taskRef,
  })
  expect(builderFollow.attention?.memberId).toBe(builder.member.memberId)
  await page.getByRole('button', { name: /Task #1/ }).click()
  const invitationComposer = page.getByRole('textbox', { name: '消息内容' })
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('消息内容')
  // Authored with '@': a bare name is prose the Host does not deliver to.
  await invitationComposer.fill('@')
  // reviewer does not follow Task #1's Thread, so its row is the outside one.
  // Weight is the only distinction, so this measures each name's resolved colour
  // at both widths. Read the unfiltered menu: a query would leave one row, which
  // cannot show that two groups differ.
  const invitationMenu = page.getByRole('listbox', { name: '提及成员建议' })
  await invitationMenu.waitFor()
  const invitationRowState = (element: Element) => [...element.querySelectorAll<HTMLElement>('[role="option"][data-mention-tier]')]
    .map(row => {
      const name = row.querySelector<HTMLElement>('[class*="mentionName"]')!
      const description = row.querySelector<HTMLElement>('[class*="mentionDescription"]')
      return {
        tier: row.getAttribute('data-mention-tier') ?? '',
        inside: row.getAttribute('data-mention-inside') ?? '',
        nameColor: getComputedStyle(name).color,
        text: row.textContent ?? '',
        descriptionDisplay: description === null ? 'missing' : getComputedStyle(description).display,
      }
    })
  // Follower ranking arrives with the page's observation read, so the menu may
  // open before the ranking lands; poll until both weights exist.
  await expect.poll(() => invitationMenu.evaluate((element: Element) => [...element.querySelectorAll('[role="option"][data-mention-tier]')].some(row => row.getAttribute('data-mention-tier') === '0')
    && [...element.querySelectorAll('[role="option"][data-mention-tier]')].some(row => row.getAttribute('data-mention-tier') !== '0')), { timeout: 10_000 }).toBe(true)
  const invitationRows = await invitationMenu.evaluate(invitationRowState)

  expect(invitationRows.some(row => row.tier !== '0')).toBe(true)
  const invitationSecondary = await resolveAliasColor(page, '--dsw-alias-label-secondary')
  const invitationPrimary = await resolveAliasColor(page, '--dsw-alias-label-primary')
  for (const row of invitationRows) {
    expect(row.inside).toBe(String(row.tier === '0'))
    expect(row.nameColor).toBe(row.tier === '0' ? invitationPrimary : invitationSecondary)
    expect(row.text).not.toContain('需确认')
  }
  await page.screenshot({ path: join(UI04_SHOTS, 'thread-mention-weight.png'), fullPage: true })
  // The narrow branch drops the description, not the weight. Measure used values:
  // the element never answers a container query about its own visibility.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  const invitationNarrow = await invitationMenu.evaluate(invitationRowState)
  expect(invitationNarrow.every(row => row.descriptionDisplay === 'none')).toBe(true)
  expect(invitationNarrow.some(row => row.tier === '0')).toBe(true)
  expect(invitationNarrow.some(row => row.tier !== '0')).toBe(true)
  for (const row of invitationNarrow) {
    expect(row.nameColor).toBe(row.tier === '0' ? invitationPrimary : invitationSecondary)
  }
  await page.screenshot({ path: join(UI04_SHOTS, 'thread-mention-weight-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await invitationComposer.fill('请 @re')
  await invitationMenu.waitFor()
  await page.getByRole('option', { name: /@reviewer/ }).click()
  await invitationComposer.fill(`${await invitationComposer.inputValue()}加入这个已有 Thread 并回复 Human @reviewer `)
  // Version 2 delivers a mention directly: one Enter commits, no confirmation
  // step, and the composer keeps focus for the next reply.
  await invitationComposer.press('Enter')
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('消息内容')
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

  // Branded refs in rich Markdown become inline Task links labelled with the
  // human-facing number (canonical full ref on hover), and no doubled colon
  // survives in the DOM.
  const agentRefLinks = page.locator('[data-team-thread] article').filter({ hasText: 'reviewer 已读取邀请' }).getByRole('button', { name: /Task #\d+/ })
  await agentRefLinks.first().waitFor()
  expect(await agentRefLinks.count()).toBe(2)
  await expect.poll(() => agentRefLinks.first().textContent()).toBe('Task #1')
  await expect.poll(() => agentRefLinks.nth(1).textContent()).toBe('Task #1')
  expect(await agentRefLinks.first().getAttribute('title')).toBe(task.taskRef)
  expect(await agentRefLinks.nth(1).getAttribute('title')).toBe(task.taskRef)
  expect(await page.getByText(`task::${task.taskRef.slice('task:'.length)}`).count()).toBe(0)
  expect(await agentRefLinks.first().locator('xpath=ancestor::strong').count()).toBe(1)
  expect(await page.getByText('已核实邀请', { exact: true }).count()).toBe(1)

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
  // The doubled-colon ref still resolves while the row is expanded: clamping must
  // not break the post-render pass.
  await expect.poll(async () => await longMarkdownRow.getByRole('button', { name: /Task #\d+/ }).count()).toBeGreaterThanOrEqual(1)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-clamp-markdown-expanded.png'), fullPage: true })
  await longMarkdownRow.getByRole('button', { name: '收起' }).click()
  await expect.poll(async () => await longMarkdownRow.locator('[class*="messageClamp"]').count()).toBe(1)

  // A wide Markdown table scrolls inside the reading column instead of painting
  // past it. The wrapper must be exactly as wide as the body column, stop at its
  // edge, and the wider table must scroll within it. Both body chain shapes are
  // walked: the Markdown box directly under the column, or under a `[data-
  // document]` wrapper when the body folds; either level left uncapped reopens
  // the overflow.
  // The tool list in the last cell is what makes the table overflow; the
  // assertion only means something while `scrollWidth` exceeds `clientWidth`.
  const wideTableHead = '| 序号 | 会话 | 耗时 | 工具 | 读取 | 写入 | 命中 |'
  const wideTableRule = '| --- | --- | --- | --- | --- | --- | --- |'
  const wideTableBody = '| 182 | pulse | 26.7 min | 83 | 0 | 0 | skill,bash,write,team_message,read,team_attention |'
  const wideTable = `${wideTableHead}\n${wideTableRule}\n${wideTableBody}`
  const wideTableCases = [
    { marker: '宽表回归验收', body: `### 宽表回归验收\n\n${wideTable}` },
    { marker: '宽表折叠回归验收', body: `### 宽表折叠回归验收\n\n${wideTable}\n\n${'折叠态宽表回归验证段落。'.repeat(40)}` },
  ]
  for (const [index, variant] of wideTableCases.entries()) {
    const wideRead = await scaffold.ctx.agentTeam.readThreadForAgent(reviewerAgent, {
      requestId: `m2-08-wide-table-read-${index}` as never, workspaceId: workspace.id, taskRef: task.taskRef,
    })
    const wideReply = await scaffold.ctx.agentTeam.replyForAgent(reviewerAgent, {
      requestId: `m2-08-wide-table-reply-${index}` as never,
      workspaceId: workspace.id, taskRef: task.taskRef, body: variant.body,
      baseRevision: wideRead.thread.revision,
      recipients: [scaffold.ctx.agentTeam.status().humanMemberId],
    })
    expect(wideReply.kind).toBe('committed')
    const wideTableRow = page.locator('[data-team-thread] article').filter({ hasText: variant.marker })
    await wideTableRow.waitFor()
    await wideTableRow.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(UI04_SHOTS, `message-wide-table-${index === 0 ? 'plain' : 'clamped'}.png`), fullPage: true })
    const tableFit = await wideTableRow.evaluate(element => {
      const wrapper = element.querySelector('[class*="tableScroll"]') as HTMLElement
      const body = element.querySelector('[class*="messageBody"]') as HTMLElement
      const column = element.closest('[class*="timelineContent"]') as HTMLElement
      const edges = (node: HTMLElement) => node.getBoundingClientRect()
      return {
        wrapperWidth: Math.round(edges(wrapper).width),
        bodyWidth: Math.round(edges(body).width),
        wrapperPastBody: Math.round(edges(wrapper).right - edges(body).right),
        wrapperPastColumn: Math.round(edges(wrapper).right - edges(column).right),
        clientWidth: wrapper.clientWidth,
        scrollWidth: wrapper.scrollWidth,
      }
    })
    expect(Math.abs(tableFit.wrapperWidth - tableFit.bodyWidth)).toBeLessThanOrEqual(1)
    expect(tableFit.wrapperPastBody).toBeLessThanOrEqual(1)
    expect(tableFit.wrapperPastColumn).toBeLessThanOrEqual(1)
    expect(tableFit.scrollWidth).toBeGreaterThan(tableFit.clientWidth)
  }

  // The sender line is the secondary grade: size − 1 up to 14px and size − 2
  // above it, so 22px reads 20px/27px and 10px reads 9px/16px, while the 11px
  // time stays fixed. Overriding the body variable the theme bootstrap publishes
  // follows the same path as raising the Settings size.
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

  // The face is chrome at a fixed 34px, dropped 5px from the name row's top,
  // where the author line's capitals begin (at 13px/20px: 2.5px half-leading plus
  // 3px between ascent and cap height). This is a fact about our type, pinned
  // against all three tiers. All three numbers are read in one pass: the timeline
  // scrolls and each row is its own offsetParent, so separate reads could fake a
  // match.
  const faceGeometry = async (): Promise<[number, number, number]> => await page.evaluate(() => {
    const row = document.querySelector('[data-team-thread] article')
    const face = row?.querySelector('[class*="messageIdentity"], [class*="messageIdentityImage"]')
    const line = row?.querySelector('[class*="nameRow"]')
    if (face === null || face === undefined || line === null || line === undefined) return [Number.NaN, Number.NaN, Number.NaN]
    const faceBox = face.getBoundingClientRect()
    const lineBox = line.getBoundingClientRect()
    return [faceBox.width, faceBox.height, faceBox.top - lineBox.top]
  })
  const axisBefore = await page.evaluate(() => document.body.style.getPropertyValue('--dsh-content-font-size'))
  for (const [size, expected] of [['', '13px/20px'], ['22px', '20px/27px'], ['10px', '9px/16px']] as const) {
    await setAxis(size)
    await expect.poll(senderMetrics).toBe(expected)
    if (size !== '') await page.screenshot({ path: join(UI04_SHOTS, `content-axis-${size}.png`) })
    const [width, height, drop] = await faceGeometry()
    expect(Number.isNaN(width)).toBe(false)
    expect([width, height, drop]).toEqual([34, 34, 5])
  }
  await page.evaluate(value => {
    if (value === '') document.body.style.removeProperty('--dsh-content-font-size')
    else document.body.style.setProperty('--dsh-content-font-size', value)
  }, axisBefore)
  await expect.poll(senderMetrics).toBe('13px/20px')

  const codeRead = await scaffold.ctx.agentTeam.readThreadForAgent(reviewerAgent, {
    requestId: 'm2-09-code-axis-read' as never, workspaceId: workspace.id, taskRef: task.taskRef,
  })
  const codeReply = await scaffold.ctx.agentTeam.replyForAgent(reviewerAgent, {
    requestId: 'm2-09-code-axis-reply' as never, workspaceId: workspace.id, taskRef: task.taskRef,
    body: `代码字号轴验收\n\n\`\`\`ts\nconst codeSizeAxis = 'fence follows the code size setting'\n\`\`\``,
    baseRevision: codeRead.thread.revision,
    recipients: [scaffold.ctx.agentTeam.status().humanMemberId],
  })
  expect(codeReply.kind).toBe('committed')
  const codeRow = page.locator('[data-team-thread] article').filter({ hasText: '代码字号轴验收' })
  await codeRow.waitFor()
  await codeRow.scrollIntoViewIfNeeded()
  const codeMetrics = async (): Promise<string> => await codeRow.locator('pre').first().evaluate(node => {
    const { fontSize, lineHeight, paddingTop, paddingBottom } = getComputedStyle(node)
    // The content box of a one-line fence is one line: independent of padding,
    // and it still fails on a block that never painted (height 0).
    const content = Math.round(node.getBoundingClientRect().height - parseFloat(paddingTop) - parseFloat(paddingBottom))
    return `${fontSize}/${lineHeight}/${content}`
  })
  await expect.poll(codeMetrics).toBe('13px/19px/19')
  const codeAxisBefore = await page.evaluate(() => document.body.style.getPropertyValue('--dsh-code-font-size'))
  for (const [size, expected] of [['', '13px/19px/19'], ['16px', '18px/24px/24'], ['10px', '12px/18px/18']] as const) {
    await page.evaluate(value => { document.body.style.setProperty('--dsh-code-font-size', value) }, size)
    await expect.poll(codeMetrics).toBe(expected)
    if (size !== '') await page.screenshot({ path: join(UI04_SHOTS, `code-axis-${size}.png`), fullPage: true })
  }
  await page.evaluate(value => {
    if (value === '') document.body.style.removeProperty('--dsh-code-font-size')
    else document.body.style.setProperty('--dsh-code-font-size', value)
  }, codeAxisBefore)
  await expect.poll(codeMetrics).toBe('13px/19px/19')

  await agentRefLinks.first().click()
  await page.getByRole('heading', { name: /Task #1/ }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await agentRefLinks.first().scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI04_SHOTS, 'message-ref-inline-markdown-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })

  // The Task Thread reply composer offers the same "+" upload chain as the
  // Project composer.
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

  await page.getByRole('button', { name: '返回项目' }).click()
  await page.getByRole('button', { name: /Task #1/ }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('button', { name: /Task #1/ }).click()
  // The authored @human mention renders as the canonical chip at the position the
  // Host delivery scan resolves.
  await page.getByText('reviewer 已读取邀请并回复 @human，关联', { exact: false }).waitFor()

  // Open-onto-unread: after agents publish a multi-batch backlog while the Human
  // is away, reopening lands at the latest fact, drains every batch
  // automatically, keeps the unread boundary as information, and leaves no unread
  // in the ledger.
  await page.getByRole('button', { name: '返回项目' }).click()
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
  await page.getByRole('tab', { name: '看板' }).click()
  const preOpenInbox = scaffold.ctx.agentTeam.inbox({ workspaceId: workspace.id })
  const preOpenThread = preOpenInbox.items.find(item => item.task?.taskRef === task.taskRef)
  expect(preOpenThread?.unreadCount ?? 0).toBeGreaterThanOrEqual(3)
  // The row's accessible name carries the reader's unread count (not only the
  // capsule's pixels) and updates without reload because a Thread reply wakes the
  // Project scope.
  const unreadLineSelector = taskEntryLineSelector(1)
  const unreadEntryRow = taskEntryRow(page, 1)
  const unreadTotal = preOpenThread!.unreadCount
  await expect.poll(async () => await unreadEntryRow.getAttribute('aria-label'), { timeout: 10_000 })
    .toBe(`打开 Task #1（${unreadTotal} 条新动态）`)
  await expect.poll(async () => (await entryUnreadCapsule(page, unreadLineSelector))?.text ?? 'missing', { timeout: 10_000 })
    .toBe(unreadTotal > 99 ? '99+' : String(unreadTotal))
  // A live Task's card reports when work last moved, which the stream order (by
  // anchor Message) cannot say.
  await expect.poll(async () => await unreadEntryRow.locator('[class*="boardCardFoot"] time').count()).toBeGreaterThan(0)
  const unreadCapsule = await entryUnreadCapsule(page, unreadLineSelector)
  // The capsule is decoration inside a labeled control, and it is a capsule:
  // a filled 18px pill whose radius covers its own height.
  expect(unreadCapsule?.hidden).toBe('true')
  expect(unreadCapsule?.shape.height).toBe('18px')
  expect(unreadCapsule?.background).not.toBe('rgba(0, 0, 0, 0)')
  expect(Number.parseFloat(unreadCapsule?.shape.radius ?? '0')).toBeGreaterThanOrEqual(9)
  // The number cluster opens every card at the same inset from the card's own
  // left edge, instead of trailing variable content.
  const clusterEdges = await entryClusterEdges(page, unreadLineSelector)
  expect(clusterEdges).not.toBeNull()
  expect(clusterEdges!.cluster - clusterEdges!.row).toBe(11)
  const stateColumn = await taskEntryClusterLefts(page)
  expect(stateColumn.length).toBeGreaterThanOrEqual(2)
  expect(new Set(stateColumn).size).toBe(1)
  // A board card is a target, so the pointer answers on its surface. Lightening the border was the wrong answer twice
  // over — it left the fill untouched and made the one reacting edge fainter — which is the defect the Human reported
  // on this board after naming the same thing on a Thread card.
  await unreadEntryRow.hover()
  await settleAnimations(page)
  const boardHover = await unreadEntryRow.evaluate(element => {
    const style = getComputedStyle(element)
    return { fill: style.backgroundColor, border: style.borderColor, shadow: style.boxShadow }
  })
  expect(boardHover.fill).toBe(await resolveAliasColor(page, '--dsw-alias-interactive-bg-hover'))
  expect(boardHover.border).toBe(await resolveAliasColor(page, '--dsw-alias-border-l2'))
  // The column behind a card is the module ground, so a fill that did not move is the failure this pins.
  const boardColumnGround = await page.evaluate(() => {
    const column = document.querySelector('[data-team-project] [class*="boardColumn"]')!
    return getComputedStyle(column).backgroundColor
  })
  expect(boardHover.fill).not.toBe(boardColumnGround)
  await page.mouse.move(4, 4)
  await settleAnimations(page)
  const boardRest = await unreadEntryRow.evaluate(element => getComputedStyle(element).backgroundColor)
  expect(boardRest).toBe(await resolveAliasColor(page, '--dsw-alias-bg-base'))
  await unreadEntryRow.scrollIntoViewIfNeeded()
  await settleAnimations(page)
  await page.screenshot({ path: join(UI05_SHOTS, 'board-card-unread.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await unreadEntryRow.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await unreadEntryRow.focus()
  await settleAnimations(page)
  await page.screenshot({ path: join(UI05_SHOTS, 'board-card-unread-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  // The focus ring is the only chrome the entry grows. Tab first: a script
  // `focus()` leaves the browser's focus-visible heuristic cold, so no ring would
  // paint.
  await page.keyboard.press('Tab')
  await unreadEntryRow.focus()
  await unreadEntryRow.scrollIntoViewIfNeeded()
  await settleAnimations(page)
  const ring = await focusRing(page, taskEntryLineSelector(1))
  expect(ring?.focusVisible).toBe(true)
  expect(ring?.outlineStyle).toBe('solid')
  expect(ring?.outlineWidth).toBe('2px')
  await page.screenshot({ path: join(UI05_SHOTS, 'board-card-unread-focus.png'), fullPage: true })
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: /Task #1/ }).waitFor()
  await page.getByText('离线期间的批量更新 三', { exact: true }).waitFor()
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

  // Hover reveals one flat layer on the row, its own time in the avatar seat for
  // continuations, and the floating actions; at rest all stay quiet.
  const hoveredRow = page.locator('article').filter({ hasText: '离线期间的批量更新 二' })
  await hoveredRow.scrollIntoViewIfNeeded()
  const actionCard = hoveredRow.locator('[data-message-card]')
  await expect.poll(() => actionCard.count()).toBe(1)
  expect(await hoveredRow.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  expect(await actionCard.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
  const seatTime = hoveredRow.locator('[data-gutter-time]')
  await expect.poll(() => seatTime.count()).toBe(1)
  expect(await seatTime.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
  await hoveredRow.hover()
  await settleAnimations(page)
  await expect.poll(() => actionCard.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await expect.poll(() => seatTime.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  // The only instants on the page are the unread boundary (information) and
  // waiting gaps stated by the row itself.
  expect(await page.locator('[role="separator"] time').count()).toBe(0)
  const hoverFacts = await hoveredRow.evaluate(element => {
    const row = getComputedStyle(element)
    const cardElement = element.querySelector('[data-message-card]') as HTMLElement
    const card = getComputedStyle(cardElement)
    const action = getComputedStyle(cardElement.querySelector('[data-copy-message]')!)
    return {
      rowFill: row.backgroundColor, rowRadius: row.borderRadius, rowShadow: row.boxShadow,
      cardRadius: card.borderRadius, cardShadow: card.boxShadow, cardFill: card.backgroundColor,
      cardHeight: Math.round(cardElement.getBoundingClientRect().height),
      cardTransition: `${card.transitionDuration} ${card.transitionTimingFunction}`,
      actionHeight: Math.round(Number.parseFloat(action.height)),
      actionRadius: action.borderRadius,
      // The hover block has to sit inside the card: an action as tall as the card paints from edge to edge at the card's
      // own radius, so the pointer state reads as the card being cut open instead of one control lighting up.
      actionInsets: (() => {
        const cardBox = cardElement.getBoundingClientRect()
        const actionBox = (cardElement.querySelector('[data-copy-message]') as HTMLElement).getBoundingClientRect()
        return {
          top: Math.round(actionBox.top - cardBox.top),
          bottom: Math.round(cardBox.bottom - actionBox.bottom),
        }
      })(),
      // The seat is the row's own avatar-seat column, a sibling of the body column the card now closes.
      seatWidth: Math.round(Number.parseFloat(getComputedStyle(element.querySelector('[data-gutter-time]')!).width)),
      // Painted width: the box is 28px by construction, so only a Range over the
      // text sees overflow the box does not clip.
      seatInk: (() => {
        const label = element.querySelector('[data-gutter-time]')!
        const range = document.createRange()
        range.selectNodeContents(label)
        return Math.round(range.getBoundingClientRect().width)
      })(),
      seatText: element.querySelector('[data-gutter-time]')!.textContent,
      seatScrollWidth: (element.querySelector('[data-gutter-time]') as HTMLElement).scrollWidth,
      seatClientWidth: (element.querySelector('[data-gutter-time]') as HTMLElement).clientWidth,
    }
  })
  expect(hoverFacts.rowFill).not.toBe('rgba(0, 0, 0, 0)')
  expect(hoverFacts.rowRadius).toBe('12px')
  expect(hoverFacts.rowShadow).toBe('none')
  // The one raised surface: the shipped floating-card shadow on an opaque surface
  // (radius pinned against the live 验收 control below).
  expect(hoverFacts.cardShadow).not.toBe('none')
  expect(hoverFacts.cardFill).not.toBe('rgba(0, 0, 0, 0)')
  // Same 28px height and corner radius as the header 验收 Button, measured against
  // the live control in this render.
  const acceptButton = page.getByRole('button', { name: '验收' }).first()
  const acceptFacts = await acceptButton.evaluate(element => {
    const style = getComputedStyle(element)
    return { height: Math.round(element.getBoundingClientRect().height), radius: style.borderRadius }
  })
  expect(hoverFacts.cardHeight).toBe(acceptFacts.height)
  expect(hoverFacts.cardRadius).toBe(acceptFacts.radius)
  // The action is one 24px control inside the 28px card, not the card's full height.
  expect(hoverFacts.actionHeight).toBe(24)
  expect(hoverFacts.actionRadius).toBe('4px')
  // Inset on both sides, so the card's own surface still frames the control.
  expect(hoverFacts.actionInsets.top).toBeGreaterThanOrEqual(2)
  expect(hoverFacts.actionInsets.bottom).toBeGreaterThanOrEqual(2)
  expect(hoverFacts.cardTransition).toBe('0.16s ease-out')
  expect(hoverFacts.seatWidth).toBe(34)
  // A dated label (57px within the year, 87px across it) would paint over the
  // adjacent words since the box does not clip. The seat states the time of day;
  // the date belongs to the identity line and the precise instant rides the
  // title.
  expect(hoverFacts.seatText).toMatch(/^\d{2}:\d{2}$/)
  expect(hoverFacts.seatInk).toBeLessThanOrEqual(hoverFacts.seatWidth)
  expect(hoverFacts.seatScrollWidth).toBeLessThanOrEqual(hoverFacts.seatClientWidth)
  // The card hangs off the top-right corner of the Message it acts on, and its lower edge stops 2px above that Message's
  // first line — measured against the body's own box, so it holds at any body length.
  const cardPlacement = await hoveredRow.evaluate(element => {
    const card = element.querySelector('[data-message-card]')!
    const cardBox = card.getBoundingClientRect()
    const rowBox = element.getBoundingClientRect()
    const body = element.querySelector('[class*="messageBody"]')!
    // The words start after the author line on a run head and at the body's own top on a continuation, so the first line
    // the card must clear is the author line's successor — measured, not assumed.
    const nameRow = body.querySelector('[class*="nameRow"]')
    const firstWordsTop = (nameRow?.nextElementSibling ?? body).getBoundingClientRect().top
    return {
      // A continuation row has no author line to hang beside, so its card rises over its run's previous line.
      grouped: element.hasAttribute('data-grouped'),
      clearanceAboveWords: Math.round(firstWordsTop - cardBox.bottom),
      // One equation instead of a hand-picked number: the card hangs from the row's top edge, so what is left between its
      // lower edge and the first words is the row's own top padding plus whatever line came before those words, minus the
      // card's height, plus however far the card rises above the row.
      expectedClearance: Math.round(
        Number.parseFloat(getComputedStyle(element).paddingTop)
        + (nameRow?.getBoundingClientRect().height ?? 0)
        - cardBox.height
        + Math.max(0, rowBox.top - cardBox.top),
      ),
      // How far the card reaches above its own row's top edge. Zero for a run head means the card never lands in the band
      // the row above owns — the defect the Human reported as a card that had clearly left its own Message.
      riseAboveRow: Math.round(rowBox.top - cardBox.top),
      gapToRowEdge: Math.round(cardBox.right - rowBox.right),
      cardPosition: getComputedStyle(card).position,
      cardTop: getComputedStyle(card).top,
    }
  })
  expect(cardPlacement.grouped).toBe(true)
  expect(cardPlacement.cardPosition).toBe('absolute')
  // The accepted continuation geometry: over the run's own previous line, lower edge 2px clear of the words it acts on.
  expect(cardPlacement.cardTop).toBe('-28px')
  // Measuring the equation is what proves the anchoring: it holds only while the card hangs off this row's own top edge and
  // clears the words it acts on rather than covering them.
  expect(cardPlacement.clearanceAboveWords).toBe(cardPlacement.expectedClearance)
  expect(cardPlacement.clearanceAboveWords).toBeGreaterThanOrEqual(2)
  expect(Math.abs(cardPlacement.gapToRowEdge)).toBeLessThanOrEqual(1)
  // The defect itself: a Message that opens a run hangs its card beside its own author line and never above its own row, so
  // the card can not appear over the words (or the empty gutter) of the Message before it. Both row kinds stop their card's
  // lower edge on the same 2px above the body, which is why the two assertions above and below agree on one number.
  const headRow = page.locator('article').filter({ hasText: '离线期间的批量更新 一' }).first()
  await headRow.hover()
  await settleAnimations(page)
  const headPlacement = await headRow.evaluate(element => {
    const card = element.querySelector('[data-message-card]')!
    const cardBox = card.getBoundingClientRect()
    const rowBox = element.getBoundingClientRect()
    const body = element.querySelector('[class*="messageBody"]')!
    const nameRow = body.querySelector('[class*="nameRow"]')
    return {
      grouped: element.hasAttribute('data-grouped'),
      riseAboveRow: Math.round(rowBox.top - cardBox.top),
      clearanceAboveWords: Math.round(
        (nameRow?.nextElementSibling ?? body).getBoundingClientRect().top - cardBox.bottom,
      ),
      expectedClearance: Math.round(
        Number.parseFloat(getComputedStyle(element).paddingTop)
        + (nameRow?.getBoundingClientRect().height ?? 0)
        - cardBox.height,
      ),
      cardTop: getComputedStyle(card).top,
    }
  })
  expect(headPlacement.grouped).toBe(false)
  expect(headPlacement.cardTop).toBe('0px')
  expect(headPlacement.riseAboveRow).toBe(0)
  expect(headPlacement.clearanceAboveWords).toBe(headPlacement.expectedClearance)
  expect(headPlacement.clearanceAboveWords).toBeGreaterThanOrEqual(2)
  // The row the Human reported: one that opens a run, whose card used to sit over the row above it.
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-row-run-head-hover.png') })
  await hoveredRow.hover()
  await settleAnimations(page)
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-row-hover.png') })
  // The reveal follows the pointer and focus ring, never sticky state: off the
  // row it returns to rest...
  await page.mouse.move(4, 4)
  await expect.poll(() => actionCard.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
  // ...and keyboard focus into the row reveals it (a :focus-visible rule, not
  // :focus-within).
  await hoveredRow.locator('[data-quote-message]').focus()
  await expect.poll(() => actionCard.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await page.mouse.move(4, 4)
  // A pressed action button holds DOM focus, so a :focus-within layer would stay
  // shaded; with the pointer off the row the layer must be gone.
  await hoveredRow.locator('[data-copy-message]').click()
  await page.mouse.move(4, 4)
  await settleAnimations(page)
  expect(await hoveredRow.evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  expect(await seatTime.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
  await expect.poll(() => actionCard.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-row-after-action.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await hoveredRow.scrollIntoViewIfNeeded()
  await hoveredRow.hover()
  await settleAnimations(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-row-hover-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  // The seat's label must hold across the calendar: a Thread read a day later
  // dates every Message. The page clock is the only lever on the Client's `now`,
  // so shift it a day, re-read, and restore it. A dated label (57px) in the 28px
  // unclipped box would paint over the words.
  const pageNow = await page.evaluate(() => Date.now())
  await page.clock.setFixedTime(pageNow + 86_400_000)
  await page.getByRole('button', { name: '返回项目' }).click()
  await page.getByRole('tab', { name: '看板' }).click()
  await taskEntryRow(page, 1).click()
  const agedRow = page.locator('article').filter({ hasText: '离线期间的批量更新 二' })
  await agedRow.waitFor()
  await agedRow.scrollIntoViewIfNeeded()
  await agedRow.hover()
  await settleAnimations(page)
  const agedSeat = await agedRow.evaluate(element => {
    const label = element.querySelector('[data-gutter-time]')!
    const range = document.createRange()
    range.selectNodeContents(label)
    const style = getComputedStyle(label)
    return {
      text: label.textContent,
      title: label.getAttribute('title'),
      ink: Math.round(range.getBoundingClientRect().width * 100) / 100,
      width: Math.round(Number.parseFloat(style.width) * 100) / 100,
    }
  })
  expect(agedSeat.title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  expect(agedSeat.text).toMatch(/^\d{2}:\d{2}$/)
  expect(agedSeat.width).toBe(34)
  expect(agedSeat.ink).toBeLessThanOrEqual(agedSeat.width)
  const seatToBody = await agedRow.evaluate(element => {
    const seat = element.querySelector('[data-gutter-time]')!.getBoundingClientRect()
    const body = element.querySelector('[class*="messageBody"]')!.getBoundingClientRect()
    return Math.round(body.left - seat.right)
  })
  expect(seatToBody).toBeGreaterThan(0)
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-seat-time-aged.png') })
  const agedHead = await page.locator('article').filter({ hasText: '离线期间的批量更新 一' }).first().evaluate(element => {
    const time = element.querySelector('[class*="messageTime"]')
    return time === null ? null : time.textContent
  })
  expect(agedHead).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  await page.clock.setFixedTime(pageNow)
  await page.getByRole('button', { name: '返回项目' }).click()
  await page.getByRole('tab', { name: '看板' }).click()
  await taskEntryRow(page, 1).click()
  await page.getByText('离线期间的批量更新 二', { exact: false }).first().waitFor()

  // Quote: the card's action puts the Message in the composer, the banner states
  // who the quote reaches, and the sent Message leads with a quote line that
  // jumps back to the original.
  // First match: the quoting Message repeats the text inside its quote line, and
  // the original always comes first.
  const quotedRow = page.locator('article').filter({ hasText: '离线期间的批量更新 一' }).first()
  await quotedRow.hover()
  await quotedRow.locator('[data-quote-message]').click()
  const quoteBanner = page.locator('[data-reply-banner]')
  await expect.poll(() => quoteBanner.count()).toBe(1)
  await expect.poll(async () => await quoteBanner.textContent() ?? '').toContain('引用')
  await expect.poll(async () => await quoteBanner.textContent() ?? '').toContain('离线期间的批量更新 一')
  // The quoted author appears in the same 「将通知」 row as any recipient, so the
  // delivery is stated once.
  const quoteNotify = page.locator('[data-team-notify]')
  await expect.poll(async () => await quoteNotify.textContent() ?? '').toContain('@reviewer')
  // The banner is a line: no fill, border, radius, or rule of its own (the card
  // frames it; the quote's 2px bar belongs inside a Message).
  const bannerFacts = await quoteBanner.evaluate(element => {
    const style = getComputedStyle(element)
    const author = element.querySelector('[class*="replyBannerAuthor"]')!.getBoundingClientRect()
    const cancel = element.querySelector('[class*="replyBannerCancel"]')!.getBoundingClientRect()
    const draft = element.parentElement!.querySelector('textarea')!.getBoundingClientRect()
    const draftStyle = getComputedStyle(element.parentElement!.querySelector('textarea')!)
    const notify = getComputedStyle(document.querySelector('[data-team-notify]')!)
    const body = element.querySelector('[class*="replyBannerBody"]')!.getBoundingClientRect()
    return {
      fill: style.backgroundColor, border: style.borderTopWidth, radius: style.borderTopLeftRadius,
      bar: element.querySelector('[class*="replyBannerBar"]') === null,
      // The words sit in the composer's text column: the same left inset as the
      // draft and the same right inset as the notify row.
      leftInset: Math.round(body.left - element.getBoundingClientRect().left),
      draftLeftInset: Math.round(Number.parseFloat(draftStyle.paddingLeft)),
      rightInset: Math.round(Number.parseFloat(style.paddingRight)),
      notifyRightInset: Math.round(Number.parseFloat(notify.paddingRight)),
      centerDelta: Math.abs((cancel.top + cancel.height / 2) - (author.top + author.height / 2)),
      cancelRight: Math.round(draft.right - cancel.right),
    }
  })
  expect(bannerFacts.fill).toBe('rgba(0, 0, 0, 0)')
  expect(bannerFacts.border).toBe('0px')
  expect(bannerFacts.radius).toBe('0px')
  expect(bannerFacts.bar).toBe(true)
  expect(bannerFacts.leftInset).toBe(bannerFacts.draftLeftInset)
  expect(bannerFacts.rightInset).toBe(bannerFacts.notifyRightInset)
  expect(bannerFacts.centerDelta).toBeLessThanOrEqual(0.5)
  expect(bannerFacts.cancelRight).toBe(bannerFacts.rightInset)
  await page.screenshot({ path: join(UI05_SHOTS, 'composer-quote-banner.png') })
  const bannerBox = (await quoteBanner.boundingBox())!
  await page.screenshot({ path: join(UI05_SHOTS, 'composer-quote-banner-crop.png'), clip: {
    x: Math.max(0, bannerBox.x - 8), y: Math.max(0, bannerBox.y - 8), width: bannerBox.width + 16, height: bannerBox.height + 16,
  } })
  // The reader is never delivered to, so quoting their own Message still names
  // what is answered but leaves the notify row empty. Read the banner first: it
  // resolves only after the Host lookup, so an absent notify row alone could mean
  // nothing had resolved.
  const ownRow = page.locator('article').filter({ hasText: '这是带附件的 Thread 回复' }).first()
  await ownRow.scrollIntoViewIfNeeded()
  await ownRow.hover()
  await ownRow.locator('[data-quote-message]').click()
  await expect.poll(async () => await quoteBanner.textContent() ?? '').toContain('这是带附件的 Thread 回复')
  expect(await quoteNotify.count()).toBe(0)
  await page.screenshot({ path: join(UI05_SHOTS, 'composer-quote-self.png') })
  // Restore the reviewer quote: the send below asserts its line.
  await quotedRow.hover()
  await quotedRow.locator('[data-quote-message]').click()
  await expect.poll(async () => await quoteNotify.textContent() ?? '').toContain('@reviewer')
  await page.getByRole('textbox', { name: '消息内容' }).fill('引用这条，确认引用管道')
  await page.getByRole('button', { name: '发送' }).click()
  const quotedMessage = page.locator('article').filter({ hasText: '引用这条，确认引用管道' })
  await quotedMessage.waitFor()
  const quoteLine = quotedMessage.locator('[data-quote-line]')
  await expect.poll(() => quoteLine.count()).toBe(1)
  await expect.poll(async () => await quoteLine.textContent() ?? '').toContain('离线期间的批量更新 一')
  expect(await quotedMessage.evaluate(element =>
    [...element.querySelector('[class*="messageBody"]')!.children].indexOf(element.querySelector('[data-quote-line]')!))).toBe(1)
  const quoteLineFacts = await quoteLine.evaluate(element => {
    const style = getComputedStyle(element)
    const bar = getComputedStyle(element.querySelector('[class*="quoteLineBar"]')!)
    return {
      fill: style.backgroundColor, radius: style.borderTopLeftRadius,
      barWidth: Math.round(Number.parseFloat(bar.width)), barOpacity: Number(bar.opacity),
    }
  })
  expect(quoteLineFacts.fill).toBe('rgba(0, 0, 0, 0)')
  expect(quoteLineFacts.radius).toBe('0px')
  expect(quoteLineFacts.barWidth).toBe(2)
  expect(quoteLineFacts.barOpacity).toBeLessThan(1)
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-quote.png') })
  // At narrow width the quote stays one line behind the 2px rule and never widens
  // the timeline.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await quotedMessage.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  expect(await quoteLine.evaluate(element =>
    Math.round(Number.parseFloat(getComputedStyle(element.querySelector('[class*="quoteLineBar"]')!).width)))).toBe(2)
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-quote-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  await quoteLine.click()
  await expect.poll(async () => await quotedRow.getAttribute('data-reply-flash')).toBe('true')

  // Opening onto a mention: the Thread centres on that Message with one pulse of
  // the row layer, not on the latest fact, and never again once the mention is
  // read.
  await page.getByRole('button', { name: '返回项目' }).click()
  const mentionRead = await scaffold.ctx.agentTeam.readThreadForAgent(agent, {
    requestId: 'm2-06-mention-read' as never, workspaceId: workspace.id, taskRef: task.taskRef,
  })
  const mentionReply = await scaffold.ctx.agentTeam.replyForAgent(agent, {
    requestId: 'm2-06-mention-reply' as never, workspaceId: workspace.id, taskRef: task.taskRef,
    body: '需要你拍板：@human 这条要你定方向', baseRevision: mentionRead.thread.revision,
  })
  if (mentionReply.kind !== 'committed') throw new Error(`mention reply rejected: ${mentionReply.kind}`)
  // Centring needs half a viewport of content below the target; at the very end
  // the browser can only clamp to the bottom.
  for (const label of ['一', '二', '三', '四', '五', '六', '七', '八']) {
    const afterRead = await scaffold.ctx.agentTeam.readThreadForAgent(agent, {
      requestId: `m2-06-mention-after-read-${label}` as never, workspaceId: workspace.id, taskRef: task.taskRef,
    })
    const afterReply = await scaffold.ctx.agentTeam.replyForAgent(agent, {
      requestId: `m2-06-mention-after-${label}` as never, workspaceId: workspace.id, taskRef: task.taskRef,
      body: `跳转留白 ${label}：这条不点名，只用来给居中留出下方空间。`, baseRevision: afterRead.thread.revision,
    })
    if (afterReply.kind !== 'committed') throw new Error(`trailing reply rejected: ${afterReply.kind}`)
  }
  await page.getByRole('tab', { name: '看板' }).click()
  await taskEntryRow(page, 1).click()
  const addressedRow = page.locator('article').filter({ hasText: '需要你拍板' })
  await addressedRow.waitFor()
  await expect.poll(async () => await addressedRow.getAttribute('data-reply-flash')).toBe('true')
  // The mention is stated on the row's card, never on the reading path.
  await addressedRow.hover()
  await settleAnimations(page)
  const mentionLine = addressedRow.locator('[data-mentions-you]')
  await expect.poll(() => mentionLine.count()).toBe(1)
  await expect.poll(async () => await mentionLine.textContent()).toBe('提到了你')
  // The notice uses the card's type tier, no smaller than the actions beside it;
  // the card draws its edge in two declared layers.
  const noticeFacts = await addressedRow.evaluate(element => {
    const card = element.querySelector('[data-message-card]')!
    return {
      noticeSize: Math.round(Number.parseFloat(getComputedStyle(element.querySelector('[data-mentions-you]')!).fontSize)),
      actionSize: Math.round(Number.parseFloat(getComputedStyle(card.querySelector('[data-copy-message]')!).fontSize)),
      cardShadow: getComputedStyle(card).boxShadow,
    }
  })
  expect(noticeFacts.noticeSize).toBe(noticeFacts.actionSize)
  // The elevation hairline keeps the chip legible over white code blocks and
  // screenshots; beneath it sits the lightest shipped elevation (--dsw-elevation-
  // panel), one step below the composer card's (--dsw-elevation-soft).
  expect(noticeFacts.cardShadow).toContain('0px 0px 0px 0.5px')
  expect(noticeFacts.cardShadow).not.toContain('rgba(0, 0, 0, 0) 0px 0px 0px 0.5px')
  expect(noticeFacts.cardShadow).toContain('rgba(0, 0, 0, 0.03) 0px 3px 8px 0px')
  expect(noticeFacts.cardShadow).toContain('rgba(0, 0, 0, 0.02) 0px 0px 16px 0px')
  const cardBox = (await addressedRow.locator('[data-message-card]').boundingBox())!
  await page.screenshot({ path: join(UI05_SHOTS, 'message-card.png'), clip: {
    x: Math.max(0, cardBox.x - 28), y: Math.max(0, cardBox.y - 28), width: cardBox.width + 56, height: cardBox.height + 56,
  } })
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-open-on-mention.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await addressedRow.scrollIntoViewIfNeeded()
  await addressedRow.hover()
  await settleAnimations(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-open-on-mention-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  // The badge answers for the reader alone: a row the reader wrote calling on
  // @reviewer raises its card without one. Prove the card exists first so the
  // badge's absence means something.
  const otherRow = page.locator('article').filter({ hasText: '请 @reviewer 加入这个已有 Thread' }).first()
  await otherRow.scrollIntoViewIfNeeded()
  await otherRow.hover()
  await settleAnimations(page)
  await expect.poll(async () => await otherRow.locator('[data-message-card]').count()).toBe(1)
  expect(await otherRow.locator('[data-mentions-you]').count()).toBe(0)
  await page.screenshot({ path: join(UI05_SHOTS, 'message-card-other-mention.png') })

  await page.getByRole('button', { name: '返回项目' }).click()
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('tab', { name: '看板' }).click()
  // The durable read clears the unread: the card drops the capsule.
  await expect.poll(async () => await taskEntryRow(page, 1).getAttribute('aria-label'), { timeout: 10_000 }).toBe('打开 Task #1')
  await expect.poll(async () => await entryUnreadCapsule(page, unreadLineSelector), { timeout: 10_000 }).toBeNull()
  // reviewer has been replying through the Host without following; the menu
  // below asserts the all-followers shape, so reviewer follows first.
  const reviewerFollow = await scaffold.ctx.agentTeam.changeAttentionForAgent(reviewerAgent, {
    requestId: 'm2-06-reviewer-follow' as never, action: 'follow', workspaceId: workspace.id, taskRef: task.taskRef,
  })
  expect(reviewerFollow.attention?.memberId).toBe(reviewer.member.memberId)
  await taskEntryRow(page, 1).click()
  const agentRead = await scaffold.ctx.agentTeam.readThreadForAgent(agent, {
    requestId: 'm2-06-agent-read' as never, workspaceId: workspace.id, taskRef: task.taskRef,
  })
  const agentClaim = await scaffold.ctx.agentTeam.changeClaimForAgent(agent, {
    requestId: 'm2-06-agent-claim' as never, workspaceId: workspace.id,
    taskRef: task.taskRef, action: 'claim', direction: '实现验收功能', baseRevision: agentRead.thread.revision,
  })
  if (agentClaim.kind !== 'committed') throw new Error(`Agent Claim was rejected: ${agentClaim.kind}`)

  // A Claim reaches this page only as the activity line that recorded it.
  expect(await page.getByRole('button', { name: /Claims/ }).count()).toBe(0)
  await page.getByText(/认领了「实现验收功能」/).waitFor()
  await page.screenshot({ path: join(UI05_SHOTS, 'active-thread.png'), fullPage: true })

  const threadComposer = page.getByRole('textbox', { name: '消息内容' })
  // On a Thread, weight tracks following: a Member taking part in the Project
  // through another Thread is outside. It is the row's only distinction.
  await threadComposer.fill('@')
  const mentionMenu = page.getByRole('listbox', { name: '提及成员建议' })
  await mentionMenu.waitFor()
  const rowState = (element: Element) => [...element.querySelectorAll('[role="option"][data-mention-tier]')].map(row => {
    const description = row.querySelector('[class*="mentionDescription"]')
    return {
      tier: row.getAttribute('data-mention-tier') ?? '',
      inside: row.getAttribute('data-mention-inside') ?? '',
      text: row.textContent ?? '',
      descriptionDisplay: description === null ? 'missing' : getComputedStyle(description).display,
    }
  })
  const threadRows = await mentionMenu.evaluate(rowState)
  expect(threadRows.length).toBeGreaterThan(1)
  for (const row of threadRows) {
    expect(row.inside).toBe(String(row.tier === '0'))
    expect(row.text).not.toContain('需确认')
  }
  // Both Members follow this Thread, so none is dimmed; the outside case needs a
  // Member the Thread does not carry (invitation step above, component spec).
  expect([...new Set(threadRows.map(row => row.tier))]).toEqual(['0'])
  expect(new Set(threadRows.map(row => row.inside))).toEqual(new Set(['true']))
  await page.screenshot({ path: join(UI05_SHOTS, 'thread-mention-rows.png'), fullPage: true })
  // Below 600px the description drops but the weight must survive; both groups
  // were covered at the invitation step.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  const narrowRows = await mentionMenu.evaluate(rowState)
  expect(narrowRows.some(row => row.descriptionDisplay === 'none')).toBe(true)
  expect(new Set(narrowRows.map(row => row.inside))).toEqual(new Set(['true']))
  await page.setViewportSize({ width: 1440, height: 960 })
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
  // Press the live 验收 control while the Task is open, then wait for the ledger to
  // show the acceptance.
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
  // Early acceptance drill: reopen sets in_progress, and a fresh Agent Claim
  // recreates the precondition for accepting over open work.
  await page.getByRole('button', { name: '重新打开' }).click()
  // Direct Host calls must observe the committed open state.
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
  await page.getByRole('button', { name: '重新打开' }).waitFor()

  // The header offers only one of 打开/关闭 per resolution, so this reopen restores
  // the open state before the close beat.
  await page.getByRole('button', { name: '重新打开' }).click()
  await page.getByRole('button', { name: '关闭任务' }).waitFor()
  await page.getByRole('button', { name: '关闭任务' }).click()
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

  await page.getByRole('button', { name: '返回项目' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await expect.poll(() => page.getByText('Human 已检查 Thread', { exact: true }).count()).toBe(0)
  await expect.poll(() => page.getByText('验收后继续讨论', { exact: true }).count()).toBe(0)
  await page.getByRole('tab', { name: '看板' }).click()
  const closedEntry = taskEntryRow(page, 1)
  // A resolved Task dims on the board so moving work stays loudest; the foot's
  // time is the resolution moment, precise on the time element's title.
  await expect.poll(async () => await closedEntry.getAttribute('data-resolved')).toBe('')
  await expect.poll(async () => await closedEntry.locator('[class*="boardCardFoot"] time').getAttribute('title') ?? '').toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  await closedEntry.scrollIntoViewIfNeeded()
  await settleAnimations(page)
  await page.screenshot({ path: join(UI05_SHOTS, 'resolved-board-card.png'), fullPage: true })
  // The shorter door leaves the narrow column less to wrap: it must still fit
  // without a horizontal scrollbar.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await closedEntry.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: join(UI05_SHOTS, 'narrow-resolved-board-card.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  // The shot covers the sidebar column so the exit row can be reviewed against
  // the brand row above and the Inbox card below. The wrapper is a real element;
  // the slot anchor is `display: contents` and cannot be screenshotted.
  const sidebarColumn = page.locator('[class*="sidebarCol"]').first()
  await sidebarColumn.screenshot({ path: join(UI01_SHOTS, 'sidebar-exit-row.png') })

  await page.reload()
  await page.getByRole('button', { name: '# delivery' }).waitFor({ timeout: 20_000 })
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dsh.agent-team.navigation'))).toContain('"mode":"team"')
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await expect.poll(() => page.getByText('Human 已检查 Thread', { exact: true }).count()).toBe(0)
  await expect.poll(() => page.getByText('验收后继续讨论', { exact: true }).count()).toBe(0)
  await expect.poll(() => page.getByText('关闭后继续讨论', { exact: true }).count()).toBe(0)
  await page.getByRole('button', { name: '对话' }).click()
  await expect.poll(() => newSessionButton.isVisible()).toBe(true)
  await expect.poll(() => brandButton.isVisible()).toBe(true)
  // Leaving Team closes any embedded Member view and restores the Human's
  // ordinary session.
  const restoredComposer = page.locator('[data-composer-input][contenteditable="true"]').first()
  await restoredComposer.waitFor({ timeout: 20_000 })
  await expect.poll(() => page.locator('[data-team-project]').count()).toBe(0)
  // Team's sources return no ordinary candidates, so shipped command/skill
  // discovery takes the restored Session back.
  await restoredComposer.fill('/')
  await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(0)
  expect(await page.getByRole('option', { name: '@reviewer' }).count()).toBe(0)
  await restoredComposer.fill('')
  await page.screenshot({ path: join(UI01_SHOTS, 'restored-conversations.png'), fullPage: true })

  // Archive confirms state the no-restore contract. The archived Project leaves
  // the sidebar; the archived Member leaves the agents panel, its Host session is
  // disposed and archived, and its private memory stays on disk.
  await page.getByRole('button', { name: '团队' }).click()
  // Restoration returns to the last open surface; the sidebar row stays the entry
  // back onto the Project.
  await page.getByRole('button', { name: '# delivery' }).waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor({ timeout: 20_000 })
  const rampRow = page.getByRole('button', { name: '# ramp' })
  await rampRow.hover()
  await page.getByRole('button', { name: 'ramp 的操作' }).click()
  await page.getByRole('menuitem', { name: '归档项目' }).click()
  const rampArchiveDialog = page.getByRole('dialog', { name: '归档项目：ramp' })
  await rampArchiveDialog.waitFor()
  expect(await rampArchiveDialog.textContent()).toContain('暂无恢复入口')
  await page.screenshot({ path: join(UI06_SHOTS, 'project-archive-modal.png'), fullPage: true })
  await rampArchiveDialog.getByRole('button', { name: '归档项目', exact: true }).click()
  await expect.poll(() => page.getByRole('button', { name: '# ramp' }).count()).toBe(0)
  const archiveWorkspace = scaffold.ctx.workspaceRegistry.list()[0]!
  const archivedProject = scaffold.ctx.agentTeam.view({ workspaceId: archiveWorkspace.id }).projects.find((project: { name: string }) => project.name === 'ramp')
  expect(archivedProject).toBeUndefined()

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
  // The archived Member's row menu and mention candidates are gone; the Agent
  // panel, the one surface still listing Members, carries the absence.
  await page.getByRole('button', { name: '对话' }).click()
  await expect.poll(() => page.locator('[data-team-project]').count()).toBe(0)

  // The shipped panel rail holds the Team row beside Plugins; Team mode stands
  // the rail down (present in the DOM on both sides, visible on one).
  const globalPanelsNav = page.locator('nav[class*="panelList"]')
  await expect.poll(() => globalPanelsNav.count()).toBe(1)
  await expect.poll(() => globalPanelsNav.isVisible()).toBe(true)
  // Selecting that panel keys the shell's single main cell to it. Team mode owns
  // that cell, so opening a Team destination behind the foreign page would move
  // only the sidebar. Enter Team mode from here and assert the column came back.
  const pluginsEntry = globalPanelsNav.getByRole('button', { name: '插件' })
  await pluginsEntry.click()
  await expect.poll(() => pluginsEntry.getAttribute('aria-current')).toBe('page')
  const pluginPanel = page.locator('[data-plugin-panel]')
  await pluginPanel.waitFor()
  // The page renders the manifest's `icon` artwork instead of the default mark.
  await page.screenshot({ path: join(UI01_SHOTS, 'plugin-list-artwork.png'), fullPage: true })

  // The plugin page lists this bundle by name ("智能体团队"), so the Team row is
  // addressed exactly.
  const enterTeamKeyboard = globalPanelsNav.getByRole('button', { name: '团队', exact: true })
  await enterTeamKeyboard.focus()
  await expect.poll(() => enterTeamKeyboard.evaluate(element => element === document.activeElement)).toBe(true)
  await enterTeamKeyboard.press('Enter')
  await expect.poll(() => page.getByRole('button', { name: '对话', exact: true }).count()).toBe(1)
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  // The plugin page is unmounted rather than hidden behind the Team seat, the
  // rail stands down, and the browser seat's top row carries the leave action.
  await expect.poll(() => page.getByRole('button', { name: '对话', exact: true }).getAttribute('data-team-action')).toBe('leave')
  await expect.poll(() => pluginPanel.count()).toBe(0)
  await expect.poll(() => globalPanelsNav.count()).toBe(1)
  await expect.poll(() => globalPanelsNav.isVisible()).toBe(false)

  // The exit is keyboard-reachable: focus it, press Space, and the mode stands
  // down to an ordinary conversation. Team mode is re-entered through the rail
  // row for the segments below.
  const leaveKeyboard = page.getByRole('button', { name: '对话', exact: true })
  await leaveKeyboard.focus()
  await expect.poll(() => leaveKeyboard.evaluate(element => element === document.activeElement)).toBe(true)
  await leaveKeyboard.press('Space')
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe(null)
  await expect.poll(() => globalPanelsNav.isVisible()).toBe(true)
  await globalPanelsNav.getByRole('button', { name: '团队', exact: true }).click()
  await expect.poll(() => page.getByRole('button', { name: '对话', exact: true }).count()).toBe(1)
  await page.setViewportSize({ width: 1440, height: 960 })

  // Human Inbox: a mention, or an Agent's ordinary reply on a followed Thread,
  // raises the badge and an Inbox row; opening the Thread clears both. Deltas
  // ride a fresh taskless Thread to stay independent of earlier segments.
  const inboxWorkspace = scaffold.ctx.workspaceRegistry.list()[0]!
  const inboxCard = page.locator('button[class*="inboxCard"]')
  const railInboxButton = page.locator('nav[class*="railWorkspace"] button[aria-label*="收件箱"]')
  // The sidebar states unread as a mark, so the entry's accessible name is the
  // only place the quantity is written (what a screen reader reads). `null` means
  // no count in the name.
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
  await page.getByRole('button', { name: '讨论/任务' }).click()
  await inboxComposer.fill('请 Human 决策的讨论')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('button', { name: /^打开讨论：请 Human 决策的讨论/ }).waitFor()
  const inboxProjects = scaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id }).projects
  const deliveryProject = inboxProjects.find((project: { name: string }) => project.name === 'delivery')!
  // 'after' is the oldest window; the fresh opener is the newest top-level fact.
  const inboxView = scaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id, projectRef: deliveryProject.projectRef, topLevelOnly: true, includeActivities: false, direction: 'before', limit: 50 })
  const inboxThreadItem = inboxView.items.find((item: { message: { body: string } }) => item.message.body === '请 Human 决策的讨论')!
  const inboxThreadRef = (inboxThreadItem.thread as { threadRef: string }).threadRef
  // builder is archived earlier; reviewer stays an active delivery Member and
  // mentions the Human.
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
  expect(mentionedInbox.items.find((item: { thread: { threadRef: string } }) => item.thread.threadRef === inboxThreadRef)).toMatchObject({
    projectName: 'delivery', previewText: '请 Human 决策的讨论',
  })
  const inboxRow = page.locator('[data-team-inbox] button').filter({ hasText: '请 Human 决策的讨论' })
  await expectSidebarUnread(String(baseUnread + 1))
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-dot-desktop.png'), fullPage: true })

  // An ordinary Agent reply needs no mention: the Human follows their own Thread,
  // so it moves the badge by its own fact.
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

  // A second Thread the Human follows whose only unread fact is an Agent reply
  // naming nobody: the queue mixes a row that named the reader with one that
  // merely moved.
  await page.getByRole('button', { name: '讨论/任务' }).click()
  await inboxComposer.fill('工程侧同步，无需决策')
  await page.getByRole('button', { name: '发送' }).click()
  await page.getByRole('button', { name: /^打开讨论：工程侧同步，无需决策/ }).waitFor()
  const plainView = scaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id, projectRef: deliveryProject.projectRef, topLevelOnly: true, includeActivities: false, direction: 'before', limit: 50 })
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

  // Narrow rail: 对话 → 收件箱 → 任务看板 → Projects → Agents. The Inbox icon marks unread and is
  // a destination that opens the Inbox and expands the sidebar. The exit leads
  // the rail as it leads the wide column, and the Task board is the Inbox's
  // sibling cross-Workspace destination right after it.
  await page.setViewportSize({ width: 390, height: 844 })
  const inboxRail = page.locator('nav[class*="railWorkspace"]')
  await inboxRail.waitFor()
  const railLabels = await inboxRail.locator('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))
  expect(railLabels).toEqual(['对话', `收件箱，${baseUnread + 3} 条未读`, '任务看板', '项目', 'Agents'])
  await expectSidebarUnread(String(baseUnread + 3))
  // The dot replaced the number, so the rail's hover hint is where the quantity
  // shows (the same name the control carries); the assertion above reads it
  // unhovered.
  await railInboxButton.hover()
  const railHint = page.locator('[role="tooltip"]')
  await expect.poll(async () => await railHint.count()).toBe(1)
  expect(await railHint.textContent()).toBe(`收件箱，${baseUnread + 3} 条未读`)
  await page.mouse.move(300, 600)
  await expect.poll(async () => await railHint.count()).toBe(0)
  // Screenshot the settled rail after the collapse crossfade.
  await settleAnimations(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-narrow-rail.png'), fullPage: true })
  await railInboxButton.click()
  await page.locator('[data-team-inbox]').waitFor()
  await expect.poll(() => page.locator('button[class*="inboxCard"]').count()).toBe(1)
  await expect.poll(async () => await inboxRow.count()).toBe(1)
  await expect.poll(async () => await inboxRow.textContent()).toContain('#delivery')
  const plainRow = page.locator('[data-team-inbox] button').filter({ hasText: '工程侧同步，无需决策' })
  await expect.poll(async () => await plainRow.count()).toBe(1)
  // The queue carries the shared header band plus a count line of segments: the
  // Thread count, the Host's whole unread slice, and, only while the queue holds
  // one, the mentions.
  const inboxPage = page.locator('[data-team-inbox]')
  await expect.poll(async () => await inboxPage.getByRole('heading', { name: '收件箱' }).count()).toBe(1)
  // Each slice is counted separately: the queue shows every Thread the Host
  // admits with unread, the 「最近活跃」 tail what the Client caps it at. One page-wide
  // count would move whenever an unrelated Thread joins the tail. Slices are
  // found by heading text: `filter({ has })` matches nothing on this page, even
  // `has: locator('h2')`.
  const queueSection = inboxPage.locator('section').filter({ hasText: '需要我' })
  const recentSection = inboxPage.locator('section').filter({ hasText: '最近活跃' })
  const queue = scaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id })
  await expect.poll(async () => await queueSection.locator('button[class*="row"]').count()).toBe(queue.items.length)
  await expect.poll(async () => await recentSection.locator('button[class*="row"]').count()).toBeLessThanOrEqual(5)
  const queueUnread = queue.items.reduce((sum, item) => sum + item.unreadCount, 0)
  const queueMentions = queue.items.reduce((sum, item) => sum + item.directCount, 0)
  await expect.poll(async () => await inboxPage.getByText(`${queue.items.length} 个 Thread`, { exact: true }).count()).toBe(1)
  await expect.poll(async () => await inboxPage.getByText(`${queueUnread} 条未读`, { exact: true }).count()).toBe(1)
  await expect.poll(async () => await inboxPage.getByText(`${queueMentions} 条直接通知`, { exact: true }).count()).toBe(1)
  // The row time is the newest unread fact's instant: the ordinary reply advances
  // it past the mention.
  await expect.poll(async () => await inboxRow.locator('time').count()).toBe(1)
  // A mention raised today is a bare clock time; the precise instant stays on the
  // element behind the label.
  const inboxRowTime = inboxRow.locator('time').first()
  await expect.poll(async () => await inboxRowTime.textContent()).toMatch(/^\d{2}:\d{2}$/)
  expect(await inboxRowTime.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  // The count closes the identity line and carries the named-versus-moved split
  // to assistive tech; the row's visible text stays the Thread itself.
  const namedCapsule = inboxRow.locator('[data-team-count-badge]')
  const plainCapsule = plainRow.locator('[data-team-count-badge]')
  await expect.poll(async () => await namedCapsule.getAttribute('aria-label')).toBe('2 条未读，其中 1 条直接通知')
  await expect.poll(async () => await plainCapsule.getAttribute('aria-label')).toBe('1 条未读')
  expect(await namedCapsule.getAttribute('title')).toBe('2 条未读，其中 1 条直接通知')
  expect(await namedCapsule.textContent()).toBe('2')
  expect(await plainCapsule.textContent()).toBe('1')
  // A squeezed seat: provenance ellipsizes instead of folding to three lines,
  // nothing spills out of a row, and the page does not scroll sideways. A line
  // too narrow for count and clock yields the clock (inbox.module.css), so that
  // face is asserted on the collapsed rail below.
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
        // A yielded clock draws no box; a drawn one shares the identity's line.
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
  // The row keeps two lines with a clipped provenance, not the three a wrapped
  // one would cost.
  expect(narrowFit.rowHeight).toBeLessThanOrEqual(60)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-page-narrow.png'), fullPage: true })
  // On a phone the reading state is the collapsed rail, so the queue gets that
  // face too, with the compact row shape. The card's current-page fill is read
  // while it is on screen because the replacing icon must wear exactly that.
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
  // The rail has no label, so the current page is the fill on the icon: the same
  // `aria-current="page"` fill the wide card wears.
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
  // The sidebar shows the fact as a mark, not a number (the count moved to the
  // accessible name), so it is measured as a mark; a returning count fails the
  // first assertion.
  expect(await page.locator('button[class*="inboxCard"] [data-team-count-badge]').count()).toBe(0)
  const inboxDot = page.locator('button[class*="inboxCard"] [data-team-inbox-dot]')
  await expect.poll(async () => await inboxDot.count()).toBe(1)
  const dotInk = await ink(inboxDot)
  expect(dotInk.background).toBe(namedInk.background)
  expect(dotInk.width).toBe(8)
  expect(dotInk.height).toBe(8)
  // Identical geometry either way: naming a Thread again does not shift its row,
  // and the counts open one column down.
  expect(namedInk.height).toBe(plainInk.height)
  expect(namedInk.width).toBe(plainInk.width)
  expect(namedInk.left).toBe(plainInk.left)
  // The Project feed's Thread entry and both Inbox queue rows share one capsule
  // component, so its shape cannot drift between them. The sidebar draws a mark
  // and is excluded.
  const namedCapsuleRead = await namedCapsule.evaluate(readCountCapsule)
  const plainCapsuleRead = await plainCapsule.evaluate(readCountCapsule)
  const capsuleReads = [namedCapsuleRead, plainCapsuleRead, unreadCapsule]
  for (const read of capsuleReads.slice(1)) {
    if (read === null) continue
    expect(read.shape).toEqual(namedCapsuleRead.shape)
  }
  // The tones spend their inset differently (the hairline's 1px border is paid
  // out of the padding: 4px + 1px = the solid tone's 5px), so compare the inset
  // that reaches the digit, not the declaration.
  expect(capsuleReads.map(read => read?.inset))
    .toEqual([namedCapsuleRead.inset, namedCapsuleRead.inset, namedCapsuleRead.inset])
  for (const read of capsuleReads) {
    // One character keeps the box square (the 18px floor decides the width);
    // wider counts may widen the pill (`99+`). Read as a box because `min-width`
    // is only a floor.
    if (read === null || read.text.length !== 1) continue
    expect(read.box.height).toBe(read.box.width)
  }
  const edgeLeft = async (locator: Locator): Promise<number> => Math.round(await locator.evaluate(element => element.getBoundingClientRect().x))
  const edgeRight = async (locator: Locator): Promise<number> => Math.round(await locator.evaluate(element => element.getBoundingClientRect().right))
  // One content column: a Member circle hangs in the gutter of every row, and
  // everything else, including the section heading, opens on the column after it.
  // The count closes the identity line one line-gap left of the instant.
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
          // One Workspace on screen: no row prints the constant name.
          workspace: row.querySelector('[class*="rowWorkspace"]') === null ? null : 1,
        }
      }),
    }
  }))
  expect(column.length).toBeGreaterThan(0)
  // The leading cluster is the Host's roster: one 18px face per owner,
  // overlapping by 6px (the same again for a `+N` chip), under the Project feed's
  // own words. A Thread with no live owner falls back to its newest fact's
  // author, as the taskless rows above do.
  const inboxNow = scaffold.ctx.agentTeam.inbox({ workspaceId: inboxWorkspace.id })
  const hostRows = [...inboxNow.items, ...inboxNow.recent]
  const clusterWidth = (owners: number): number => owners === 0 ? 18 : 18 + 12 * (Math.min(owners, 3) - 1) + (owners > 3 ? 12 : 0)
  for (const section of column) {
    for (const row of section.rows) {
      const item = hostRows.find(candidate => (candidate.previewText ?? '') === row.text)
      expect(item).toBeDefined()
      expect(row.actorLabel).toBe(item!.liveClaimOwners.length === 0
        ? `最新来自 @${item!.newestActor.name}`
        : `由 ${item!.liveClaimOwners.map(owner => `@${owner.name}`).join(', ')} 处理`)
      expect(row.actorWidth).toBe(clusterWidth(item!.liveClaimOwners.length))
      // The text column follows the cluster actually drawn: one face's width per
      // face, never a reserved widest stack.
      expect(row.crumb).toBe(row.actor + row.actorWidth + 8)
      expect(row.preview).toBe(row.crumb)
      // The section heading is pinned to the one-face column (8px inset + 18px
      // face + 8px gap), where every stackless row opens.
      expect(section.heading).toBe(row.actor + 26)
      if (row.badgeToTime !== null) expect(row.badgeToTime).toBe(8)
      expect(row.workspace).toBeNull()
    }
  }
  // The two times close one column on the right.
  expect(await edgeRight(inboxRow.locator('time'))).toBe(await edgeRight(plainRow.locator('time')))
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-page-desktop.png'), fullPage: true })
  // A row is one control and its ring wraps both lines, not the count. Tab first:
  // a script `focus()` leaves focus-visible cold.
  await page.keyboard.press('Tab')
  await inboxRow.focus()
  await inboxRow.scrollIntoViewIfNeeded()
  const rowRing = await focusRing(page, '[data-team-inbox] button[data-named]')
  expect(rowRing?.focusVisible).toBe(true)
  expect(rowRing?.outlineStyle).toBe('solid')
  expect(rowRing?.outlineWidth).toBe('2px')
  await settleAnimations(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-row-focus.png'), fullPage: true })

  // Opening the Thread acknowledges the mention durably: the badge and row drop,
  // and Back lands on the row's Project (the Inbox is not on the back path). The
  // row still waiting keeps the badge at its count, and the row just read returns
  // under 「最近活跃」 without a count.
  await inboxRow.click()
  await page.locator('[data-team-thread]').waitFor()
  await expectSidebarUnread(baseUnread === 0 ? '1' : String(baseUnread + 1))
  await page.getByRole('button', { name: '返回项目' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await page.locator('button[class*="inboxCard"]').click()
  await page.locator('[data-team-inbox]').waitFor()
  // Wait on the section: a zero row count is also what the entry frame shows.
  await page.locator('[data-team-inbox]').getByRole('heading', { name: '最近活跃' }).waitFor({ timeout: 30_000 })
  await expect.poll(async () => await inboxRow.count()).toBe(1)
  await expect.poll(async () => await inboxRow.locator('[data-team-count-badge]').count()).toBe(0)
  await expect.poll(async () => await plainRow.count()).toBe(1)
  await expect.poll(async () => await plainRow.textContent()).toContain('工程侧同步，无需决策')
  await expect.poll(async () => await plainRow.locator('[data-team-count-badge]').count()).toBe(1)
  // A read row keeps the leading column: it moves between sections as the queue
  // row minus its count.
  expect(await edgeLeft(inboxRow.locator('[class*="rowActor"]'))).toBe(await edgeLeft(plainRow.locator('[class*="rowActor"]')))
  expect(await edgeLeft(inboxRow.locator('[class*="rowCrumb"]'))).toBe(await edgeLeft(plainRow.locator('[class*="rowCrumb"]')))
  // Reading the second row drains the queue; both Threads return as the 「最近活跃」
  // tail, whose rows carry no count capsule. The empty copy is covered by the
  // component spec, since this reader always took part somewhere. Wait for the
  // section: rows are absent while loading.
  await plainRow.click()
  await page.locator('[data-team-thread]').waitFor()
  await expectSidebarUnread(baseUnread === 0 ? null : String(baseUnread))
  await page.getByRole('button', { name: '返回项目' }).click()
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

  // Both Threads above are taskless and only exercise the fallback. A Task's row
  // leads with the same stack, rule, and words as the Project feed's Thread
  // entry; it is seeded from real Host facts (a Task thread plus peers' Claims)
  // because a stack is easy to fake. This journey archives builder before the
  // Inbox, and `agentTeam.addMember` mounts no `team-member` preset in this lane,
  // so the live roster count is asserted rather than assumed. The multi-face
  // shape is pinned in the Client component spec and the Host's claim-owner spec.
  await scaffold.ctx.agentTeam.addProjectOwner({ requestId: 'm2-09-stack-owner' as never, workspaceId: inboxWorkspace.id,
    projectRef: deliveryProject.projectRef, memberId: inboxReviewer.member.memberId })
  const stackStarted = await scaffold.ctx.agentTeam.startThreadForAgent(inboxAgent, {
    requestId: 'm2-09-stack-task' as never, workspaceId: inboxWorkspace.id, projectRef: deliveryProject.projectRef,
    kind: 'task', body: '叠放校验：谁在这个 Task 上', recipients: [scaffold.ctx.agentTeam.status().humanMemberId],
  })
  if (stackStarted.kind !== 'committed') throw new Error(`stack fixture was rejected: ${stackStarted.kind}`)
  const stackTaskRef = stackStarted.task!.taskRef
  const stackThreadRef = stackStarted.thread.threadRef
  // Only a Member of the Task's Project may claim it.
  const projectMemberIds = new Set(scaffold.ctx.agentTeam.view({ workspaceId: inboxWorkspace.id }).members
    .filter((membership: { projectRef: string }) => membership.projectRef === deliveryProject.projectRef)
    .map((membership: { memberId: string }) => membership.memberId))
  const claimants = scaffold.ctx.agentTeam.members()
    .filter((entry: { member: { memberId: string; state: string; sessionId: string } }) => entry.member.state === 'enabled'
      && projectMemberIds.has(entry.member.memberId)
      && scaffold.ctx.agents.get(entry.member.sessionId as never) !== undefined)
    .slice(0, 3)
  // A live Project Member gives the Task an owner, not the `newestActor` fallback
  // covered above.
  expect(claimants.length).toBeGreaterThanOrEqual(1)
  for (const [index, entry] of claimants.entries()) {
    const claimant = scaffold.ctx.agents.get(entry.member.sessionId as never)!
    // A Claim is a Thread write: the claimant drains its own unread first to get
    // the revision, and the Claim makes it a follower.
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
  // One face per owner in claim order, under the Project feed's words; the row
  // pays exactly for those faces.
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
  expect(stackItem.liveClaimOwners.length).toBe(claimants.length)
  expect(stackItem.liveClaimOwners.map(owner => owner.name).sort()).toEqual(
    claimants.map((entry: { member: { handle: string } }) => entry.member.handle).sort())
  expect(stackBox.circles).toBe(Math.min(stackItem.liveClaimOwners.length, 3) + (stackItem.liveClaimOwners.length > 3 ? 1 : 0))
  expect(stackBox.label).toBe(`由 ${stackItem.liveClaimOwners.map(owner => `@${owner.name}`).join(', ')} 处理`)
  expect(stackBox.width).toBe(clusterWidth(stackItem.liveClaimOwners.length))
  expect(stackBox.inset).toBe(stackBox.width + 8)
  // The row also states the Task's standing (dot plus status word, as on every
  // Task surface). It arrives on a wake after the page opened, in the busiest row
  // shape.
  await expect.poll(async () => await stackRow.locator('[data-team-task-state]').getAttribute('data-team-task-state')).toBe(stackItem.task!.status)
  expect(await stackRow.locator('[data-team-task-state]').textContent()).toBe('进行中')
  // Taskless Threads in the tail draw no standing: the mark belongs to a Task.
  expect(await inboxRow.locator('[data-team-task-state]').count()).toBe(0)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-row-owners-desktop.png'), fullPage: true })

  // A lost Host connection shows in two places: the Project body centres in the
  // free space like the loading and empty surfaces, and the rail line uses the
  // rail's alert scale in the error colour. A failed load never reads as an empty
  // workspace.
  await page.getByRole('button', { name: '新建项目' }).click()
  const probeDialog = page.getByRole('dialog', { name: '新建项目' })
  await probeDialog.getByLabel('名称').fill('recovery')
  await probeDialog.getByLabel('说明').fill('disconnect probe')
  await probeDialog.getByRole('button', { name: '创建项目' }).click()
  const recoveryRow = page.getByRole('button', { name: '# recovery' })
  await recoveryRow.waitFor()
  // The row label sets the rail's inset; read it while the list exists, since a
  // failed load leaves no rows.
  const railLabel = await recoveryRow.locator('strong').evaluate(element => ({ x: element.getBoundingClientRect().x, color: getComputedStyle(element).color }))
  // Cutting the network acknowledges only connection-loss warnings from this
  // window; gap-repair and discontinuity warnings stay fatal.
  const offlineWarningStart = consoleWatch.warnings.length
  await page.context().setOffline(true)
  // A never-loaded Project projection shows the whole-surface error, not a stale
  // timeline.
  await recoveryRow.click()
  const projectSurface = page.locator('[data-team-project]')
  const bodyError = projectSurface.locator('[role="alert"]').first()
  await bodyError.waitFor({ timeout: 30_000 })
  const bodyBox = await bodyError.evaluate(element => {
    const box = element.getBoundingClientRect()
    const parent = element.parentElement!.getBoundingClientRect()
    return { centerX: box.x + box.width / 2, centerY: box.y + box.height / 2, parentCenterX: parent.x + parent.width / 2, parentCenterY: parent.y + parent.height / 2 }
  })
  expect(Math.abs(bodyBox.centerY - bodyBox.parentCenterY)).toBeLessThanOrEqual(2)
  expect(Math.abs(bodyBox.centerX - bodyBox.parentCenterX)).toBeLessThanOrEqual(2)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI08_SHOTS, 'project-error-offline.png'), fullPage: true })

  // Rail Panels re-subscribe only on remount, so leave and re-enter Team mode.
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
  expect(await page.getByText('还没有项目').count()).toBe(0)
  expect(await page.getByText('还没有 Agent').count()).toBe(0)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI08_SHOTS, 'sidebar-error-offline.png'), fullPage: true })

  // Reopening the stream supplies a baseline without a new commit; Project and
  // sidebar must recover without a manual retry.
  await page.context().setOffline(false)
  await page.getByRole('heading', { name: '# recovery' }).waitFor({ timeout: 30_000 })
  await expect.poll(() => projectSurface.locator('[role="alert"]').count()).toBe(0)
  await recoveryRow.waitFor({ timeout: 45_000 })
  await expect.poll(async () => await railAlert.count(), { timeout: 20_000 }).toBe(0)
  await expect.poll(() => consoleWatch.warnings.slice(offlineWarningStart).some(warning => /connection lost/i.test(warning)), { timeout: 20_000 }).toBe(true)
  acknowledgeReloadConnectionLoss(consoleWatch, offlineWarningStart)
  await settleAnimations(page)
  await page.screenshot({ path: join(UI08_SHOTS, 'sidebar-recovered-online.png'), fullPage: true })

  // Several Messages in a row from one member in the Main stream, kept readable
  // without repeating the identity line.
  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  for (const body of ['连续消息之一', '连续消息之二', '连续消息之三']) {
    await projectComposer.fill(body)
    await page.getByRole('button', { name: '发送' }).click()
    await page.locator('[data-team-project] article').filter({ hasText: body }).waitFor()
  }
  await settleAnimations(page)
  await page.screenshot({ path: join(UI05_SHOTS, 'consecutive-entries.png'), fullPage: true })
  // A continuation row's identity line carries only its time, so the state rides
  // each entry's own row instead of a line's far end.
  const consecutive = await page.evaluate(() => [...document.querySelectorAll('[data-team-project] article')]
    .filter(article => /连续消息之[一二三]/.test(article.textContent ?? ''))
    .map(article => {
      const identity = article.querySelector('[data-avatar], [data-gutter-time]')
      const body = article.querySelector('[class*="messageBody"]')
      const left = (element: Element | null | undefined): number => element === null || element === undefined ? -1 : Math.round(element.getBoundingClientRect().left)
      return {
        grouped: article.getAttribute('data-grouped') === 'true',
        series: /连续消息之([一二三])/.exec(article.textContent ?? '')?.[1] ?? '',
        seatLeft: left(identity),
        bodyLeft: left(body),
      }
    }))
  // Chinese numerals do not collate in counting order; send order is the key.
  const seriesOrder = ['一', '二', '三']
  consecutive.sort((first, second) => seriesOrder.indexOf(first.series) - seriesOrder.indexOf(second.series))
  expect(consecutive.map(row => row.series)).toEqual(seriesOrder)
  expect(consecutive.some(row => row.grouped)).toBe(true)
  for (const row of consecutive) {
    // The avatar seat holds every row's alignment: the group head's identity
    // face and the continuation rows' gutter time share one left edge.
    expect(row.seatLeft).toBeGreaterThanOrEqual(0)
  }
  // One inset for every board card, not one per title length.
  expect(new Set(consecutive.map(row => row.seatLeft)).size).toBe(1)

  await page.getByRole('button', { name: '# delivery' }).click()
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  await page.locator('button[class*="inboxCard"]').focus()
  await page.keyboard.press('Space')
  await page.locator('[data-team-inbox]').waitFor()
  const inboxEntry = page.locator('button[class*="inboxCard"]')
  await expect.poll(async () => await inboxEntry.getAttribute('aria-current')).toBe('page')

  // The Agent card is the one Team row openable from the Inbox page, and its
  // overlay embeds the Session over the page, so the Inbox is the face
  // underneath: the card takes the marker and the Inbox entry stands down.
  const liveAgentCard = page.locator('button[class*="agentSelect"]:not([disabled])').first()
  const liveAgentName = await liveAgentCard.getAttribute('aria-label')
  await liveAgentCard.click()
  await page.locator('[data-team-inbox]').waitFor({ state: 'detached' })
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
  await expect.poll(async () => await teamCurrentPage.count()).toBe(1)
  await expect.poll(async () => await teamCurrentPage.getAttribute('aria-label')).toBe(liveAgentName)
  await expect.poll(async () => await inboxEntry.getAttribute('aria-current')).toBeNull()
  await settleLayout(page)
  await page.screenshot({ path: join(UI07_SHOTS, 'inbox-under-agent-overlay.png'), fullPage: true })
  // Asking for the Inbox closes the overlay and restores the page with one marked
  // leaf at every step, and the rail marker returns. The page is only really back
  // once the Member Session's composer is gone.
  await inboxEntry.click()
  await page.locator('[data-team-inbox]').waitFor()
  await expect.poll(async () => await teamCurrentPage.count()).toBe(1)
  await expect.poll(async () => await inboxEntry.getAttribute('aria-current')).toBe('page')
  await expect.poll(async () => await globalPanelsNav.locator('[aria-current="page"]').count()).toBe(1)
  await expect.poll(async () => await page.locator('[data-composer-input]').count()).toBe(0)

  const projectKeyboard = page.getByRole('button', { name: '# delivery' })
  await projectKeyboard.focus()
  await projectKeyboard.press('Space')
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  const taskKeyboard = page.getByRole('button', { name: /^打开 Task #1/ })
  await taskKeyboard.focus()
  await taskKeyboard.press('Space')
  await page.getByRole('heading', { name: 'Task #1' }).waitFor()
  const backKeyboard = page.getByRole('button', { name: '返回项目' })
  await backKeyboard.focus()
  await backKeyboard.press('Space')
  await page.getByRole('heading', { name: '# delivery' }).waitFor()
  const leaveTeamKeyboard = page.getByRole('button', { name: '对话' })
  await leaveTeamKeyboard.focus()
  await leaveTeamKeyboard.press('Space')
  // Leaving Team restores the Human's session. The restored shell may hold an
  // inert composer (blank session), so wait on the composer surface, not
  // editability.
  await page.locator('[data-composer-input]').first().waitFor({ timeout: 20_000 })
  await expect.poll(() => page.locator('[data-team-project]').count()).toBe(0)

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 120_000)


it('keeps four same-origin Team pages responsive and independently subscribed', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd, 'multi-web')
  await scaffold.ctx.agentTeam.createProject({ requestId: 'multi-project' as never, workspaceId: workspace.id, name: 'multi-web', description: 'Multi-page regression' })
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
  const composer = pages[0]!.locator('[data-team-project] textarea')
  await composer.fill('来自第一页的消息')
  await pages[0]!.getByRole('button', { name: '发送', exact: true }).click()
  for (const page of pages) await page.locator('[data-team-project] article').filter({ hasText: '来自第一页的消息' }).waitFor()
  await pages.shift()!.close()
  await probe(pages[0]!)
  await pages[0]!.getByRole('button', { name: '对话', exact: true }).click()
  await probe(pages[1]!)
  const separate = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const other = await separate.newPage()
  await other.goto(scaffold.authenticatedUrl)
  await other.getByRole('button', { name: '团队', exact: true }).click()
  await other.getByRole('button', { name: '# multi-web', exact: true }).click()
  await other.locator('[data-team-project] textarea').fill('来自独立浏览器的消息')
  await other.getByRole('button', { name: '发送', exact: true }).click()
  await pages[1]!.locator('[data-team-project] article').filter({ hasText: '来自独立浏览器的消息' }).waitFor()
  await pages[1]!.screenshot({ path: join(BROWSER_ARTIFACTS, 'multi-web-desktop.png'), fullPage: true })
  await pages[1]!.setViewportSize({ width: 390, height: 844 })
  await settleLayout(pages[1]!)
  await pages[1]!.screenshot({ path: join(BROWSER_ARTIFACTS, 'multi-web-mobile.png'), fullPage: true })
}, 120_000)

it('opens a taskless thread from its ref chip in real Web', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')
  await page.getByRole('button', { name: '团队', exact: true }).click()
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
  // persisted snapshot answers the first without waiting on the second.
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { threadRef?: string }).threadRef), { timeout: 10_000 }).toBe(alphaRef)
  // Arrival at the cited Thread: the page marker carries the full ref and the
  // persisted snapshot agrees.
  await page.locator(`[data-team-thread="${alphaRef}"]`).waitFor({ timeout: 20_000 })
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { threadRef?: string }).threadRef)).toBe(alphaRef)
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip-opened.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI02_SHOTS, 'thread-ref-chip-opened-narrow.png'), fullPage: true })
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)

/**
 * A 1×1 opaque amber RGBA PNG: the avatar store validates an image payload,
 * and the colour makes the avatar visibly fill the seat.
 */
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4Oo/7PwAGyAKe4yFCTgAAAABJRU5ErkJggg=='

/**
 * The Human's own settings page: name, avatar, version footnote. It is an
 * ordinary-mode section (Team mode's sidebar takeover makes it unreachable),
 * so panel work comes first, then Team mode proves the rename reaches the
 * timeline.
 */
it('configures the Team page identity from Settings in real Web', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')

  await openSettings(page)
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const nameField = panel.getByLabel('名字')
  await nameField.waitFor()
  const nameSave = panel.locator('form button[type="submit"]')
  // With no stored override the page shows the default name plus the bundle
  // version and repo link.
  expect(await nameField.inputValue()).toBe('human')
  // The page names its owner first: among the Harness's settings pages a bare
  // 「团队」 is ambiguous.
  expect(await panel.textContent()).toContain('你在 Team 里的身份')
  expect(await panel.textContent()).toMatch(/版本 \d+\.\d+\.\d+/)
  expect(await panel.getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe('https://github.com/Contexera/dsh-agent-team')
  expect(await panel.getByRole('button', { name: '移除头像' }).count()).toBe(0)

  // Keyboard-only rename: typing dirties the field, Tab reaches the owning Save
  // button, Enter submits.
  await nameField.fill('Ada')
  await nameField.press('Tab')
  const saveRing = await focusRing(page, '[role="dialog"] form button[type="submit"]')
  expect(saveRing?.focusVisible).toBe(true)
  expect(saveRing?.outlineStyle).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect.poll(() => scaffold!.ctx.agentTeam.humanHandle()).toBe('Ada')
  await expect.poll(async () => await nameSave.isDisabled()).toBe(true)

  // Avatar bytes go to the persistent store, the reference into settings, and the
  // page draws what the browser can decode.
  const avatarPath = join(HOME, 'ada-avatar.png')
  await writeFile(avatarPath, Buffer.from(ONE_PIXEL_PNG, 'base64'))
  await panel.locator('input[type="file"]').setInputFiles(avatarPath)
  const preview = panel.locator('img').first()
  await preview.waitFor()
  await expect.poll(async () => await preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
  expect(await preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef !== undefined).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page.png'), fullPage: true })

  // The Host row's compaction threshold: the page's one settings-document
  // field. A save stages a child path of `memberCompaction`, so the sibling
  // `enabled` switch the page never shows has to survive it — the Host's own
  // descriptor is what proves the write, not the field it just rendered.
  const context = panel.getByRole('region', { name: '上下文' })
  const threshold = context.getByLabel('默认压缩阈值')
  await threshold.waitFor()
  expect(await threshold.inputValue()).toBe('256K')
  // Keyboard, no pointer: the staged edit makes the field dirty, Tab hands
  // focus from the input to the form's own save (the staged edit also puts the
  // reset control earlier in the document, so this proves the tab order skips
  // nothing it should not), and Enter writes it.
  await threshold.fill('512K')
  await threshold.press('Tab')
  const thresholdSave = context.getByRole('button', { name: '保存', exact: true })
  const thresholdRing = await thresholdSave.evaluate((target) => {
    const style = getComputedStyle(target)
    return {
      focusVisible: target.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    }
  })
  expect(thresholdRing.focusVisible).toBe(true)
  expect(thresholdRing.outlineStyle).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect.poll(() => {
    const value = scaffold!.ctx.settings.describe().find(row => row.ns === 'wowyuarm-agent-team-host')?.value as
      | { memberCompaction?: { enabled?: boolean; tokens?: number } }
      | undefined
    return value?.memberCompaction
  }).toEqual({ enabled: true, tokens: 512_000 })
  await expect.poll(async () => await context.getByText('已覆盖').count()).toBe(1)

  // An unreadable draft never becomes a value: the field keeps the text, the
  // group says what it accepts, and the save stays out of reach.
  await threshold.fill('2GB')
  await context.getByText('请填一个大于 0 的整数，例如 256K 或 1M。').waitFor()
  await expect.poll(async () => await context.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
  expect(await threshold.inputValue()).toBe('2GB')
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-compaction-invalid.png'), fullPage: true })
  await threshold.fill('512K')
  await expect.poll(async () => await context.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-compaction.png'), fullPage: true })

  // A refused name is refused before the round trip: the field keeps what the
  // reader typed and the notice states the rule.

  // A refused name is refused before the round trip: the field keeps the typed
  // text and the notice states the rule.
  await nameField.fill('   ')
  await panel.getByText('名字不能为空。').waitFor()
  expect(await nameSave.isDisabled()).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-empty-name.png'), fullPage: true })
  await nameField.fill('Ada')
  await expect.poll(async () => await nameSave.isDisabled()).toBe(true)

  // The shipped panel keeps its 188px nav rail at every viewport; this checks
  // whether our column survives the squeeze.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-narrow.png'), fullPage: true })
  const narrow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(390)
  // The configuration group is a shipped field inside the same squeezed
  // column: its own box must fit the column rather than painting past it, and
  // the group adds no width the panel did not already have.
  const narrowContext = await panel.getByRole('region', { name: '上下文' }).evaluate((element) => {
    const label = element.querySelector('label') as HTMLElement
    const input = element.querySelector('input') as HTMLElement
    return {
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      // A label with no room collapses to a zero-width box and paints one
      // character per line; that is readable neither by a scrollWidth probe
      // (the text wraps instead of overflowing) nor by the eye at 390px.
      labelWidth: Math.round(label.getBoundingClientRect().width),
      labelHeight: Math.round(label.getBoundingClientRect().height),
      labelLineHeight: Number.parseFloat(getComputedStyle(label).lineHeight),
      inputWidth: Math.round(input.getBoundingClientRect().width),
    }
  })
  expect(narrowContext.scrollWidth).toBeLessThanOrEqual(narrowContext.clientWidth)
  expect(narrowContext.labelWidth).toBeGreaterThan(0)
  // Four characters at 13px must sit on one line: a 1.5-line budget catches a
  // wrapped label without pinning the shipped line-height's exact value.
  expect(narrowContext.labelHeight).toBeLessThanOrEqual(narrowContext.labelLineHeight * 1.5)
  expect(narrowContext.inputWidth).toBeGreaterThan(0)
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  // Undecodable bytes fall back to the initial like a removed avatar. The Host
  // checks only the declared media type, so a HEIC phone photo lands here, and
  // the page copy promises the initial.
  await panel.locator('input[type="file"]').setInputFiles([{ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('this is not a PNG') }])
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef !== undefined).toBe(true)
  await expect.poll(async () => await panel.locator('[data-avatar="initial"]').textContent()).toBe('A')
  expect(await panel.locator('img').count()).toBe(0)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-undecodable-avatar.png'), fullPage: true })

  await panel.getByRole('button', { name: '移除头像' }).click()
  await expect.poll(async () => await panel.locator('img').count()).toBe(0)
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef).toBeUndefined()
  await expect.poll(async () => await panel.getByRole('button', { name: '上传头像' }).count()).toBe(1)
  // Restore readable bytes: the Inbox leg below draws the compact stack from the
  // same profile and needs a picture.
  await panel.locator('input[type="file"]').setInputFiles(avatarPath)
  await expect.poll(async () => await panel.locator('img').count()).toBe(1)
  await panel.getByRole('button', { name: '关闭' }).click()

  // The rename is not page-local: the Team timeline names the Human by it.
  await page.getByRole('button', { name: '团队', exact: true }).click()
  await page.getByRole('button', { name: '新建项目' }).click()
  const projectDialog = page.getByRole('dialog', { name: '新建项目' })
  await projectDialog.getByLabel('名称').fill('profile-check')
  await projectDialog.getByLabel('说明').fill('renamed human')
  await projectDialog.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# profile-check', exact: true }).click()
  const composer = page.getByRole('textbox', { name: '消息内容' })
  await composer.fill('PROFILE-NAME-MARKER hello from the renamed human')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const row = page.locator('[data-team-project] article').filter({ hasText: 'PROFILE-NAME-MARKER' })
  await row.waitFor()
  // A recent Inbox row admits Threads the reader wrote in; the Main stream post
  // above belongs to no Thread, so the Human's own discussion provides the row.
  const profileWorkspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const profileProject = scaffold!.ctx.agentTeam.view({ workspaceId: profileWorkspaceId }).projects.find((entry: { name: string }) => entry.name === 'profile-check')!
  await scaffold!.ctx.agentTeam.startThread({ requestId: 'e2e-profile-thread' as never, workspaceId: profileWorkspaceId,
    projectRef: profileProject.projectRef, kind: 'discussion', body: 'PROFILE-NAME-MARKER hello from the renamed human' })
  await expect.poll(async () => await row.textContent()).toContain('Ada')
  expect(await row.textContent()).not.toContain('Human')
  // The picture lands on the Human's own message row; the Agent row keeping its
  // initial is pinned by the component suite.
  const humanPicture = row.locator('[data-avatar="image"]')
  await expect.poll(async () => await humanPicture.count()).toBe(1)
  expect(await humanPicture.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  await page.screenshot({ path: join(UI09_SHOTS, 'renamed-human-in-timeline.png'), fullPage: true })

  // The Inbox row naming the Human leads with the profile picture in the same
  // 18px circle an Agent's initial fills, and reads the display name rather than
  // the `member:human` id.
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
 * The environment check above the version footnote. Expected versions come
 * from the installed manifest and `getDshRuntimeVersion()` (the call the Host
 * makes), so the journey proves real manifests were resolved on whichever cut
 * the checkout carries. Only the `ok` tier is reachable in a browser (the
 * others are pinned by Host and component suites); it names the running
 * version, never the declared range's lower bound, so that bound's absence is
 * asserted.
 */
it('states the local environment check on the Team page', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')

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



it('edits Project owners from the Project dialog under rules version 2 in real Web', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')
  await page.getByRole('button', { name: '团队', exact: true }).click()

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('owners-web')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# owners-web', exact: true }).waitFor()

  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('steward')
  await createAgent.getByLabel('说明').fill('负责交付')
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('steward', { exact: true }).waitFor({ timeout: 20_000 })

  const openEditor = async () => {
    // The row menu button only takes pointer events while its row is hovered.
    await page.getByRole('button', { name: '# owners-web', exact: true }).hover()
    await page.getByRole('button', { name: 'owners-web 的操作' }).click()
    await page.getByRole('menuitem', { name: '编辑项目' }).click()
    const editor = page.getByRole('dialog', { name: '编辑项目' })
    await editor.waitFor()
    return editor
  }
  const editor = await openEditor()
  const owners = editor.getByRole('group', { name: '负责人' })
  await owners.waitFor()
  await owners.getByText('始终是负责人').waitFor()
  expect(await owners.getByRole('button', { name: /^移除负责人/ }).count()).toBe(0)

  await owners.getByRole('button', { name: '添加负责人 @steward' }).click()
  const remove = owners.getByRole('button', { name: '移除负责人 @steward' })
  await remove.waitFor()
  expect(await owners.getByRole('button', { name: '添加负责人 @steward' }).count()).toBe(0)
  const workspaceId = scaffold.ctx.workspaceRegistry.list()[0]!.id
  expect(scaffold.ctx.agentTeam.view({ workspaceId }).owners).toHaveLength(1)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-owners-desktop.png'), fullPage: true })
  await editor.getByRole('button', { name: '关闭', exact: true }).click()

  // The 390 breakpoint unmounts sidebar panels, so reopen the dialog from the narrow-expanded sidebar.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await page.getByRole('button', { name: '打开侧边栏' }).click()
  const narrowEditor = await openEditor()
  const narrowOwners = narrowEditor.getByRole('group', { name: '负责人' })
  await narrowOwners.getByRole('button', { name: '移除负责人 @steward' }).waitFor()
  await settleLayout(page)
  await page.screenshot({ path: join(UI04_SHOTS, 'project-owners-mobile.png'), fullPage: true })

  await narrowOwners.getByRole('button', { name: '移除负责人 @steward' }).click()
  await narrowOwners.getByRole('button', { name: '添加负责人 @steward' }).waitFor()
  expect(scaffold.ctx.agentTeam.view({ workspaceId }).owners).toHaveLength(0)
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)

it('posts, starts a discussion and a Task, and opens cards in the Main stream under rules version 2 in real Web', async () => {
  await installLocalBundle(false)
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')
  await page.getByRole('button', { name: '团队', exact: true }).click()

  await page.getByRole('button', { name: '新建项目' }).click()
  const createProject = page.getByRole('dialog', { name: '新建项目' })
  await createProject.getByLabel('名称').fill('stream-web')
  await createProject.getByRole('button', { name: '创建项目' }).click()
  await page.getByRole('button', { name: '# stream-web', exact: true }).click()

  const mainTab = page.getByRole('tab', { name: '主对话' })
  await mainTab.waitFor()
  expect(await mainTab.getAttribute('aria-selected')).toBe('true')
  const composer = page.getByRole('textbox', { name: '消息内容' })
  const send = page.getByRole('button', { name: '发送' })
  await page.getByText('主对话还没有内容').waitFor()
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'empty-desktop.png'), fullPage: true })

  await composer.fill('配色要不要跟设置页统一？')
  await send.click()
  await page.getByText('配色要不要跟设置页统一？', { exact: true }).waitFor()
  await expect.poll(() => composer.inputValue()).toBe('')

  // Discussion: the toggle turns the send into a new Thread whose card lands in the stream.
  const toggle = page.getByRole('button', { name: '讨论/任务' })
  await toggle.click()
  expect(await toggle.getAttribute('aria-pressed')).toBe('true')
  await composer.fill('登录页改版')
  await send.click()
  const discussionCard = page.getByRole('button', { name: /^打开讨论：登录页改版/ })
  await discussionCard.waitFor()
  expect(await toggle.getAttribute('aria-pressed')).toBe('false')
  expect(await page.getByRole('checkbox', { name: '作为任务' }).count()).toBe(0)

  // Task: checking 作为任务 sends a Task and moves to the board.
  await toggle.click()
  await page.getByRole('checkbox', { name: '作为任务' }).check()
  await composer.fill('实现 API 网关')
  await send.click()
  await page.getByRole('tab', { name: '看板' }).waitFor()
  await expect.poll(() => page.getByRole('tab', { name: '看板' }).getAttribute('aria-selected')).toBe('true')
  await page.getByRole('button', { name: '打开 Task #1', exact: true }).waitFor()
  expect(await page.getByRole('button', { name: '加载更早消息' }).count()).toBe(0)
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'board-desktop.png'), fullPage: true })

  await mainTab.click()
  const taskCard = page.getByRole('button', { name: /^打开 Task #1：实现 API 网关/ })
  await taskCard.waitFor()
  expect(await discussionCard.getAttribute('data-main-card')).toBe('discussion')
  // The feed's large target answers on its own surface, not on one edge: the border alone used to lighten under the
  // pointer, which left the fill untouched and made the only reacting edge fainter.
  const cardRestFill = await discussionCard.evaluate(element => getComputedStyle(element).backgroundColor)
  expect(cardRestFill).not.toBe('rgba(0, 0, 0, 0)')
  await discussionCard.hover()
  await settleAnimations(page)
  const cardHoverFacts = await discussionCard.evaluate(element => {
    const style = getComputedStyle(element)
    return { fill: style.backgroundColor, border: style.borderColor }
  })
  expect(cardHoverFacts.fill).not.toBe(cardRestFill)
  expect(cardHoverFacts.border).not.toBe('rgba(0, 0, 0, 0)')
  await page.mouse.move(0, 0)
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'stream-desktop.png'), fullPage: true })

  // Keyboard: a card is a real button that opens the Thread side panel from Enter.
  await page.keyboard.press('Tab')
  await discussionCard.focus()
  const ring = await focusRing(page, '[data-main-card="discussion"]')
  expect(ring?.focusVisible).toBe(true)
  expect(ring?.outlineStyle).not.toBe('none')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '关闭讨论' }).waitFor()
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'panel-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: '关闭讨论' }).click()

  // An owner grant is a Main stream activity row.
  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('steward')
  await createAgent.getByLabel('说明').fill('负责交付')
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('steward', { exact: true }).waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: '# stream-web', exact: true }).hover()
  await page.getByRole('button', { name: 'stream-web 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑项目' }).click()
  const editor = page.getByRole('dialog', { name: '编辑项目' })
  await editor.getByRole('button', { name: '添加负责人 @steward' }).click()
  await editor.getByRole('button', { name: '移除负责人 @steward' }).waitFor()
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByText('human 指定 @steward 为项目负责人').waitFor()
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'stream-owner-desktop.png'), fullPage: true })

  // A quoted line in the Main stream is the same gesture as in a Thread: it names a Message already in this timeline, so
  // it is a button that centres that row and pulses it. Without the wiring the row degrades to inert text — the defect
  // the Human reported here.
  await composer.fill('引用测试：这条会被引用')
  await send.click()
  const quotedRow = page.locator('article').filter({ hasText: '引用测试：这条会被引用' }).first()
  await quotedRow.waitFor()
  await quotedRow.hover()
  await quotedRow.getByRole('button', { name: '引用这条消息' }).click()
  await composer.fill('主对话里的引用回复')
  await send.click()
  const mainQuotedRow = page.locator('article').filter({ hasText: '主对话里的引用回复' })
  await mainQuotedRow.waitFor()
  const mainQuoteLine = mainQuotedRow.locator('[data-quote-line]')
  await expect.poll(() => mainQuoteLine.count()).toBe(1)
  // A button, not a div: the inert fallback is exactly what the defect looked like.
  expect(await mainQuoteLine.evaluate(element => element.tagName)).toBe('BUTTON')
  // The Main stream keeps its rows inert under the pointer — a feed row is an entry row, not the Thread's reading seat —
  // while the action card still reveals. This is the deliberate split, so the journey states both halves: no row layer,
  // card present.
  await quotedRow.hover()
  await settleAnimations(page)
  const mainHoverFacts = await quotedRow.evaluate(element => {
    const row = getComputedStyle(element)
    return {
      rowFill: row.backgroundColor, rowRadius: row.borderRadius, rowShadow: row.boxShadow,
      cardOpacity: getComputedStyle(element.querySelector('[data-message-card]')!).opacity,
    }
  })
  expect(mainHoverFacts.rowFill).toBe('rgba(0, 0, 0, 0)')
  expect(mainHoverFacts.rowShadow).toBe('none')
  expect(mainHoverFacts.cardOpacity).toBe('1')
  await mainQuoteLine.click()
  await expect.poll(async () => await quotedRow.getAttribute('data-reply-flash')).toBe('true')
  // The attribute is the wiring; the pulse is the feedback. The Main stream takes the pulse without the row layer its
  // Thread seat has, so the fill is read here rather than assumed from the attribute.
  await expect.poll(async () => quotedRow.evaluate(element => {
    const fill = getComputedStyle(element).backgroundColor
    return fill === 'rgba(0, 0, 0, 0)' ? 'none' : fill
  })).not.toBe('none')

  // The composer picks no @all at version 2.
  await composer.fill('@')
  expect(await page.getByRole('option', { name: /通知所有成员/ }).count()).toBe(0)
  await composer.fill('')

  expect(await maxHorizontalScroll(page, '[data-team-project]')).toBe(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await taskCard.waitFor()
  await toggle.click()
  await page.getByRole('checkbox', { name: '作为任务' }).check()
  await composer.fill('在手机宽度下写一条比较长的任务描述，检查控制行换行与卡片不溢出')
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'stream-mobile.png'), fullPage: true })
  expect(await maxHorizontalScroll(page, '[data-team-project]')).toBe(0)
  const overflowing = await page.evaluate(() => [...document.querySelectorAll('[data-main-card], [data-team-composer]')]
    .filter(element => element.getBoundingClientRect().right > window.innerWidth + 0.5).length)
  expect(overflowing).toBe(0)

  // The global Task board: the cross-Workspace face the sidebar's board row
  // opens. Exactly one sidebar row carries aria-current — the board itself,
  // never the Workspace selector, because no Workspace overview stands under a
  // global face (the collapsed states the Human screenshotted).
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)
  const boardRow = page.getByRole('button', { name: '任务看板' })
  await boardRow.click()
  const boardPage = page.locator('[data-team-task-board]')
  await boardPage.waitFor()
  // The stacked band is one band on every face: title line, 3px step, description line, and a stated height so the band
  // cannot move with the data. Measured here across two of those faces in one render.
  const bandOf = async (): Promise<{ h: number; titleY: number; subY: number } | null> => page.evaluate(() => {
    const band = document.querySelector('[class*="surfaceHeader"]') as HTMLElement | null
    if (band === null) return null
    const title = band.querySelector('h1')
    const sub = band.querySelector('p')
    if (title === null || sub === null) return null
    const box = band.getBoundingClientRect()
    return { h: Math.round(box.height), titleY: Math.round(title.getBoundingClientRect().y - box.y), subY: Math.round(sub.getBoundingClientRect().y - box.y) }
  })
  const boardBand = await bandOf()
  expect(boardBand).not.toBeNull()
  // The Inbox is the other stacked face, measured in the same render: identical band height and identical baselines, so a
  // reader switching between them sees the feed start in the same place.
  await page.getByRole('button', { name: '收件箱' }).click()
  await page.waitForTimeout(400)
  const inboxBand = await bandOf()
  expect(inboxBand).toEqual(boardBand)
  await boardRow.click()
  await page.waitForTimeout(400)
  await expect.poll(async () => await boardRow.getAttribute('aria-current')).toBe('page')
  expect(await page.locator('[data-team-workspace-trigger]').getAttribute('aria-current')).toBeNull()
  const globalCard = boardPage.getByRole('button', { name: /Task #1/ })
  await globalCard.waitFor()
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'task-board-page.png'), fullPage: true })
  // The two cross-Workspace cards and the Workspace selector stand as one
  // stack: every gap between them is some control's 2px top step, so the
  // two top-to-top distances must measure equal in this one render.
  const stackSteps = await page.evaluate(() => {
    const tops = ['button[aria-label="收件箱"]', 'button[aria-label="任务看板"]', '[data-team-workspace-trigger]']
      .map(selector => document.querySelector(selector)?.getBoundingClientRect().top)
    return [tops[1]! - tops[0]!, tops[2]! - tops[1]!]
  })
  expect(stackSteps[0]).toBe(stackSteps[1])
  // A card opens the Task's own Thread level, and the sidebar marker follows
  // it off the board row: the board is a face, not a standing selection.
  await globalCard.click()
  await page.getByRole('heading', { name: /Task #1/ }).waitFor()
  await expect.poll(async () => await boardRow.getAttribute('aria-current')).toBe(null)
  // Back to the board face, then the narrow width keeps the page itself free
  // of horizontal overflow: the columns become the Project board's own sideways
  // strip, so the containment that must hold is the document's, not the strip's.
  await boardRow.click()
  await boardPage.waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(MAIN_STREAM_SHOTS, 'task-board-page-narrow.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 180_000)
