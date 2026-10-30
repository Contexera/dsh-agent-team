/**
 * Shared plumbing for the Team browser scenarios.
 *
 * Every scenario stages the bundle the way `dsh plugin add` installs it, boots
 * the real Web scaffold in a real Chromium, and drives the assembled Client.
 * That arrangement — the staged copy, the artifact directories, the animation
 * and layout settling, the measurement probes — is identical in each scenario,
 * so it lives here once. A scenario owns its own `scaffold`/`browser` handles
 * and its own `afterEach`, because vitest lifecycle is per-file.
 *
 * `installLocalBundle` wipes `HOME`, which is the shared staged profile, and
 * every scenario re-stages it because each one boots its own scaffold. The
 * artifact directories belong to the run instead: `run-browser-test.mjs`
 * clears them once before the first scenario, and no scenario may remove them,
 * because vitest decides which scenario runs last and a late clear would delete
 * screenshots an earlier scenario already produced.
 */
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh } from './support.ts'

/**
 * A 1×1 opaque amber RGBA PNG: the avatar store validates an image payload,
 * and the colour makes the avatar visibly fill the seat.
 */
export const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4Oo/7PwAGyAKe4yFCTgAAAABJRU5ErkJggg=='

/**
 * The opening every scenario repeats: the scaffold and browser handles a
 * scenario owns for its own run, and the teardown that releases them. Each
 * scenario declares these itself — vitest lifecycle is per-file — so they live
 * here as the one text a scenario's own header matches against.
 */
export type { Browser, Locator, Page } from 'playwright'
export { launchWebScaffold, acknowledgeReloadConnectionLoss, watchConsole } from './scaffold.ts'
export { connectFreshWorkspaceZh } from './support.ts'
export { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
export type { WebScaffold } from './scaffold.ts'

/**
 * Boot one scenario: stage the bundle, launch the scaffold, open a Chromium
 * page, connect a fresh Workspace and enter Team mode.
 *
 * Every scenario starts from exactly this arrangement, so it is written once.
 * The returned `page` and `consoleWatch` are the scenario's own handles; the
 * module-level `scaffold`/`browser` pair each scenario declares is filled in
 * here so its `afterEach` can release them.
 */
export async function openTeamPage(options: { readonly stayInOrdinaryMode?: boolean } = {}): Promise<{
  readonly page: Page
  readonly consoleWatch: { warnings: string[]; pageErrors: string[] }
}> {
  await installLocalBundle()
  scaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
  browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const consoleWatch = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'team-workspace')
  if (!options.stayInOrdinaryMode) await page.getByRole('button', { name: '团队', exact: true }).click()
  return { page, consoleWatch }
}

/** The one scaffold and browser the current scenario owns; `openTeamPage` fills them. */
export let scaffold: WebScaffold | undefined
export let browser: Browser | undefined

/** Release the current scenario's scaffold and browser. */
export async function closeScenario(): Promise<void> {
  await browser?.close(); browser = undefined
  await scaffold?.close(); scaffold = undefined
}

export const TEAM_ROOT = '__TEAM_ROOT__'
export const HOME = '__HOME__'
export const CHROME = '__CHROME__'
export const STAGED_BUNDLE = join(HOME, 'profiles', 'node_modules', '@contexera', 'dsh-agent-team')
export const BROWSER_ARTIFACTS = join(TEAM_ROOT, 'artifacts/browser')
export const UI01_SHOTS = join(BROWSER_ARTIFACTS, 'ui-01')
export const UI02_SHOTS = join(BROWSER_ARTIFACTS, 'ui-02')
export const UI03_SHOTS = join(BROWSER_ARTIFACTS, 'ui-03')
export const UI04_SHOTS = join(BROWSER_ARTIFACTS, 'ui-04')
export const UI05_SHOTS = join(BROWSER_ARTIFACTS, 'ui-05')
export const UI06_SHOTS = join(BROWSER_ARTIFACTS, 'ui-06')
export const UI07_SHOTS = join(BROWSER_ARTIFACTS, 'ui-07')
export const UI08_SHOTS = join(BROWSER_ARTIFACTS, 'ui-08')
export const UI09_SHOTS = join(BROWSER_ARTIFACTS, 'ui-09')
export const SETTINGS_SHOTS = join(BROWSER_ARTIFACTS, 'settings-nav')
export const MAIN_STREAM_SHOTS = join(BROWSER_ARTIFACTS, 'main-stream')
/**
 * Wait until no finite animation is running: a screenshot taken mid-collapse
 * captures the expanded column clipped to the rail. Infinite animations
 * (presence and loading pulses) are not waited on.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every(animation => {
    const timing = animation.effect?.getTiming()
    return timing === undefined || timing.iterations === Infinity || animation.playState !== 'running'
  }))
}

/** Open Settings from the shell's own entry, whichever seat holds it. */
export async function openSettings(page: Page): Promise<void> {
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
export async function focusRing(page: Page, selector: string): Promise<{
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
export async function settleLayout(page: Page): Promise<void> {
  await settleAnimations(page)
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  }))
  await settleAnimations(page)
}

/** The board card is its own control: the unread and plain spellings both match exactly one card number. */
/** One Task's board card, matched by its exact accessible name in both the unread and plain spellings. */
export function taskEntryLineSelector(taskNumber: number): string {
  return `[data-team-project] button[class*="boardCard"]:is([aria-label^="打开 Task #${taskNumber}（"], [aria-label^="打开 Task #${taskNumber} "], [aria-label="打开 Task #${taskNumber}"])`
}

/** One Task's board card: the locator form of {@link taskEntryLineSelector}. */
export function taskEntryRow(page: Page, taskNumber: number) {
  return page.locator(taskEntryLineSelector(taskNumber))
}

/**
 * The Thread band's controls as the browser laid them out. Uniformity is a set of
 * equations over one band's boxes — one height, one radius, one inset, one
 * outline stroke, one step — not an impression, and widths stay out of it
 * because a label's length is content, not chrome.
 */
export async function actionBandGeometry(page: Page): Promise<{
  readonly bands: number
  readonly groups: number
  readonly labels: readonly string[]
  readonly heights: readonly string[]
  readonly radii: readonly string[]
  readonly insets: readonly string[]
  readonly outlineWidths: readonly string[]
  readonly outlineColors: readonly string[]
  readonly steps: readonly string[]
  readonly bandRight: number
  readonly overflowing: readonly string[]
} | null> {
  return page.evaluate(() => {
    const bands = [...document.querySelectorAll('[data-team-action-band]')]
    const band = bands[0]
    if (band === undefined) return null
    const groups = [...band.querySelectorAll('[data-team-action-group]')]
    const buttons = groups.flatMap(group => [...group.querySelectorAll('button')])
    const styleOf = (button: Element) => getComputedStyle(button)
    return {
      bands: bands.length,
      groups: groups.length,
      labels: buttons.map(button => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''),
      heights: [...new Set(buttons.map(button => styleOf(button).height))],
      radii: [...new Set(buttons.map(button => styleOf(button).borderTopLeftRadius))],
      // The inline inset of the label: 10px on every shipped `sm` control.
      insets: [...new Set(buttons.map(button => styleOf(button).paddingLeft))],
      // Only the outlined controls carry a stroke: the primary is fill-only on purpose. Width is one
      // value across them; colour is held separately because a followed control paints its own
      // on-state stroke, which is a state difference rather than an inconsistency.
      outlineWidths: [...new Set(buttons
        .filter(button => styleOf(button).borderTopWidth !== '0px')
        .map(button => styleOf(button).borderTopWidth))],
      outlineColors: [...new Set(buttons
        .filter(button => styleOf(button).borderTopWidth !== '0px')
        .map(button => styleOf(button).borderTopColor))],
      steps: [...new Set(groups.map(group => styleOf(group).gap))],
      bandRight: Math.round(band.getBoundingClientRect().right),
      // A wrapped band may use more than one line; no control may leave the band's box.
      overflowing: buttons
        .filter(button => Math.round(button.getBoundingClientRect().right) > Math.round(band.getBoundingClientRect().right) + 1)
        .map(button => button.textContent?.trim() ?? ''),
    }
  })
}

/**
 * The contrast a rendered element's own ink has against what actually sits behind
 * it. The declarations are `color-mix(...)`, which the browser reports back as
 * `color(srgb …)` rather than `rgb()`, so the ratio is computed here instead of
 * trusting a token name: a floor is a number.
 */
export async function inkContrast(page: Page, scope: string, selector: string): Promise<number | null> {
  return page.evaluate(({ within, sel }) => {
    const parse = (value: string): { rgb: number[]; alpha: number } | null => {
      const mixed = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(value)
      if (mixed !== null) return { rgb: [1, 2, 3].map(index => Number(mixed[index]) * 255), alpha: mixed[4] === undefined ? 1 : Number(mixed[4]) }
      const classic = /^rgba?\(([^)]+)\)$/.exec(value)
      if (classic === null) return null
      const parts = classic[1]!.split(/[ ,/]+/).filter(part => part !== '').map(Number)
      return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3]! : 1 }
    }
    const target = document.querySelector(within)?.querySelector(sel) ?? null
    if (target === null) return null
    const own = parse(getComputedStyle(target).backgroundColor)
    const ink = parse(getComputedStyle(target).color)
    if (own === null || ink === null) return null
    // The fill may be translucent; composite it onto the first opaque box above it.
    let base: number[] = [255, 255, 255]
    for (let node: Element | null = target; node !== null; node = node.parentElement) {
      const layer = parse(getComputedStyle(node).backgroundColor)
      if (layer !== null && layer.alpha >= 0.999) { base = layer.rgb; break }
    }
    const fill = own.alpha >= 0.999 ? own.rgb : own.rgb.map((channel, index) => own.alpha * channel + (1 - own.alpha) * base[index]!)
    const linear = (channel: number): number => {
      const scaled = channel / 255
      return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
    }
    const luminance = (rgb: readonly number[]): number => 0.2126 * linear(rgb[0]!) + 0.7152 * linear(rgb[1]!) + 0.0722 * linear(rgb[2]!)
    const [light, dark] = [luminance(ink.rgb), luminance(fill)].sort((left, right) => right - left) as [number, number]
    return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
  }, { within: scope, sel: selector })
}

/**
 * The colour a `--dsw-*` alias resolves to in the running theme, so
 * expectations follow palette changes.
 */
export async function resolveAliasColor(page: Page, alias: string): Promise<string> {
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
export async function entryClusterEdges(page: Page, lineSelector: string): Promise<{ readonly cluster: number; readonly row: number; readonly column: number } | null> {
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
export async function maxHorizontalScroll(page: Page, selector: string): Promise<number> {
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
export async function taskEntryClusterLefts(page: Page): Promise<readonly number[]> {
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
export function readCountCapsule(element: Element): {
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
export async function entryUnreadCapsule(page: Page, lineSelector: string): Promise<ReturnType<typeof readCountCapsule> | null> {
  const capsule = page.locator(`${lineSelector} [data-team-count-badge]`).first()
  return await capsule.count() === 0 ? null : await capsule.evaluate(readCountCapsule)
}

/**
 * Stage this bundle and its dependency closure as `dsh plugin add` installs
 * it. A command-line overlay would shadow the profile document and make the
 * Host row's settings write fail, so every lane mounts the staged copy as a
 * profile package. Nothing here touches the artifact directories: the run owns
 * them, so a scenario can never delete evidence of the run it belongs to.
 */
export async function installLocalBundle(): Promise<void> {
  await rm(HOME, { recursive: true, force: true })
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
  await mkdir(SETTINGS_SHOTS, { recursive: true })
}
