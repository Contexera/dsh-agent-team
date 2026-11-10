import { afterEach, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import { join } from 'node:path'
import type { Page } from 'playwright'
import {
  EXTRA_TOOL_SHOTS, acknowledgeReloadConnectionLoss, browser, chooseMemberModel, closeScenario, connectFreshWorkspaceZh,
  maxHorizontalScroll, openSettings, openTeamPage, scaffold, settleLayout,
} from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

const NAMESPACE = 'contexera-agent-team-host'
const FIELD = 'extraToolGrants'
const GROUP = '[data-extra-tool-grants]'

type SettingsProvider = {
  describe(): readonly {
    readonly ns: string
    readonly value: unknown
    readonly user?: unknown
    readonly revision: number
  }[]
  mutate(ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined): Promise<unknown>
}

type SettingsControllerHost = {
  // Both reads and writes cross an asynchronous Remote even when the Host
  // implementation returns its current settings synchronously.
  describe(): SettingsDescribeValue | Promise<SettingsDescribeValue>
  mutate(ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined): Promise<SettingsNamespaceView>
}

function settingsHost(): SettingsProvider {
  return scaffold!.ctx.settings as unknown as SettingsProvider
}

function namespaceView(): ReturnType<SettingsProvider['describe']>[number] {
  const view = settingsHost().describe().find(candidate => candidate.ns === NAMESPACE)
  if (view === undefined) throw new Error(`missing settings namespace ${NAMESPACE}`)
  return view
}

function grantedNames(): readonly string[] {
  const value = namespaceView().value as { readonly [FIELD]?: readonly string[] }
  return value[FIELD] ?? []
}

async function setGrantedNames(names: readonly string[]): Promise<void> {
  const view = namespaceView()
  await settingsHost().mutate(
    NAMESPACE,
    [{ op: 'set', path: [FIELD], value: [...names] }],
    view.revision,
  )
}

async function openGrants(page: Page) {
  await openSettings(page)
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const group = panel.locator(GROUP)
  await group.waitFor()
  return { panel, group }
}

async function reload(page: Page, consoleWatch: { warnings: string[]; pageErrors: string[] }): Promise<void> {
  const warningStart = consoleWatch.warnings.length
  await page.reload()
  await settleLayout(page)
  acknowledgeReloadConnectionLoss(consoleWatch, warningStart)
}

it('grants, revokes, and reconciles profile extra tools in the assembled Web surface', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true })
  // Catalog filtering must use a real activated Member, not an empty Host with
  // no preset bindings. This is the production shape behind the baseline report.
  await page.getByRole('button', { name: '团队', exact: true }).click()
  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('catalog-baseline')
  await createAgent.getByLabel('说明').fill('激活真实 Member preset')
  await chooseMemberModel(page, createAgent)
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('catalog-baseline', { exact: true }).waitFor({ timeout: 20_000 })
  let catalog = scaffold!.ctx.agentTeam.toolCatalogForClient({}).names
  // This isolated scenario mounts production Host plugins so the foreign-tool
  // catalog is non-empty after activated Member preset baselines are excluded;
  // it does not certify the unknown plugin behind issue #82.
  if (!catalog.includes('str_replace_editor')) await scaffold!.ctx.plugin(ToolStrReplaceEditor)
  catalog = scaffold!.ctx.agentTeam.toolCatalogForClient({}).names
  if (catalog.length < 2) {
    await scaffold!.ctx.plugin(ToolFs)
    catalog = scaffold!.ctx.agentTeam.toolCatalogForClient({}).names
  }
  expect(catalog.length).toBeGreaterThanOrEqual(2)
  const first = catalog[0]!
  const second = catalog[1]!
  const { group } = await openGrants(page)

  await group.getByRole('checkbox', { name: first, exact: true }).waitFor()
  expect(await group.getByRole('checkbox', { name: 'team_worker' }).count()).toBe(0)
  expect(await group.getByRole('checkbox', { name: 'working_directory' }).count()).toBe(0)
  expect(await group.getByRole('checkbox', { name: 'bash', exact: true }).count()).toBe(0)
  expect(await group.getByRole('checkbox', { name: 'read', exact: true }).count()).toBe(0)
  expect(await group.getByRole('checkbox', { name: 'web_fetch', exact: true }).count()).toBe(0)
  expect(await group.textContent()).toContain('仅注册不等于允许执行')
  expect(await group.textContent()).toContain('勾选并保存')

  // Keyboard selection and search: the checkbox itself takes focus and Space
  // toggles exactly the catalog name, while the search only narrows discovery.
  const search = group.getByLabel('搜索工具名')
  await search.fill(first)
  const firstChoice = group.getByRole('checkbox', { name: first, exact: true })
  await search.focus()
  await page.keyboard.press('Tab')
  expect(await firstChoice.evaluate(choice => choice === document.activeElement)).toBe(true)
  // A focused checkbox also gets a UA `auto` ring, and the theme's global
  // `:focus-visible` rule hands width and colour to it, so "not none" survives
  // deleting the component rule. Pin what only that rule sets: a solid style
  // and the atom's 2px offset, plus the resolved token colour.
  const choiceRing = await page.evaluate((selector) => {
    const node = document.querySelector(selector)
    if (node === null) return null
    const style = getComputedStyle(node)
    const probe = document.createElement('span')
    probe.style.color = 'var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))'
    document.body.append(probe)
    const tokenColor = getComputedStyle(probe).color
    probe.remove()
    return {
      focusVisible: node.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineColor: style.outlineColor,
      outlineOffset: style.outlineOffset,
      tokenColor,
    }
  }, `${GROUP} input[type="checkbox"]:focus`)
  expect(choiceRing).not.toBeNull()
  expect(choiceRing?.focusVisible).toBe(true)
  expect(choiceRing?.outlineStyle).toBe('solid')
  expect(choiceRing?.outlineWidth).toBe('2px')
  expect(choiceRing?.outlineColor).toBe(choiceRing?.tokenColor)
  expect(choiceRing?.outlineOffset).toBe('2px')
  await page.keyboard.press('Space')
  await expect.poll(async () => await firstChoice.isChecked()).toBe(true)

  await search.fill(second)
  const secondChoice = group.getByRole('checkbox', { name: second, exact: true })
  await secondChoice.click()
  await expect.poll(async () => await group.getByText(`已选 2 个名称`).count()).toBe(1)
  await search.fill('')

  await page.screenshot({ path: join(EXTRA_TOOL_SHOTS, 'extra-tools-desktop.png') })
  await group.getByRole('button', { name: '取消', exact: true }).click()
  await expect.poll(async () => await firstChoice.isChecked()).toBe(false)
  await expect.poll(async () => await secondChoice.isChecked()).toBe(false)

  await group.getByRole('checkbox', { name: first, exact: true }).click()
  const operationsBeforeSave = scaffold!.ctx.agentTeam.status().operationCount
  const workerBeforeSave = scaffold!.ctx.agentTeam.config.worker.get()
  await group.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => grantedNames()).toEqual([first])
  expect(scaffold!.ctx.agentTeam.status().operationCount).toBe(operationsBeforeSave)
  expect(scaffold!.ctx.agentTeam.config.worker.get()).toEqual(workerBeforeSave)
  expect((namespaceView().user as Record<string, unknown>)[FIELD]).toEqual([first])
  await group.getByText('已保存。所选工具从下一轮起允许执行；未保留的选择同时撤销。').waitFor()

  // Search with no matches is its own state, not an empty catalog.
  await group.getByLabel('搜索工具名').fill('pr83-no-such-tool')
  await group.getByText('没有匹配的工具名。').waitFor()
  await group.getByLabel('搜索工具名').fill('')

  // A grant that no longer has a registration stays selected and removable.
  await setGrantedNames(['pr83_unregistered_tool', first])
  await reload(page, consoleWatch)
  const missing = await openGrants(page)
  expect(await missing.group.locator('[data-extra-tool-missing]').textContent()).toContain('pr83_unregistered_tool')
  // A registration that disappeared is a real warning, unlike the neutral
  // fallback list, so this block keeps its stripe.
  expect(await missing.group.locator('[data-extra-tool-missing]')
    .evaluate(node => getComputedStyle(node).borderLeftWidth)).not.toBe('0px')
  await missing.group.getByRole('checkbox', { name: /pr83_unregistered_tool/ }).click()
  await missing.group.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => grantedNames()).toEqual([first])

  // Profile identity and the discovery catalog are independent reads. Neither
  // failure hides the accepted list or prevents a revoke.
  const team = scaffold!.ctx.agentTeam as unknown as {
    humanProfileForClient: (...args: never[]) => unknown
    toolCatalogForClient: (...args: never[]) => unknown
  }
  const originalProfile = team.humanProfileForClient
  const originalCatalog = team.toolCatalogForClient
  team.humanProfileForClient = () => { throw new Error('pr83 identity unavailable') }
  team.toolCatalogForClient = () => { throw new Error('pr83 catalog unavailable') }
  try {
    await reload(page, consoleWatch)
    const degraded = await openGrants(page)
    await degraded.panel.getByText('资料读不出来：pr83 identity unavailable').waitFor()
    await degraded.group.getByText(/工具目录读取失败：pr83 catalog unavailable/).waitFor()
    await degraded.group.getByText('已保存的选择').waitFor()
    // The fallback list is neutral: a failed catalog read is already reported
    // above, so the saved names must not wear the warning stripe a second time.
    expect(await degraded.group.locator('[data-extra-tool-selected]')
      .evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('0px')
    await degraded.group.getByRole('checkbox', { name: first, exact: true }).click()
    await degraded.group.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => grantedNames()).toEqual([])
    await degraded.group.getByText('已保存。所选工具从下一轮起允许执行；未保留的选择同时撤销。').waitFor()
    await page.screenshot({ path: join(EXTRA_TOOL_SHOTS, 'extra-tools-identity-catalog-failure.png') })
  } finally {
    team.humanProfileForClient = originalProfile
    team.toolCatalogForClient = originalCatalog
  }

  // A list read that cannot decode the stored field is a failure, never an
  // empty accepted value. Retrying the read recovers without losing the list.
  await setGrantedNames([first])
  const settings = scaffold!.ctx.settingsController as unknown as SettingsControllerHost
  const originalDescribe = settings.describe
  settings.describe = async () => {
    const value = await originalDescribe.call(settings)
    return {
      ...value,
      namespaces: value.namespaces.map((view) => view.ns === NAMESPACE
        ? { ...view, value: { ...(view.value as object), [FIELD]: undefined } }
        : view),
    }
  }
  let failed: Awaited<ReturnType<typeof openGrants>>
  try {
    await reload(page, consoleWatch)
    failed = await openGrants(page)
    await failed.group.getByText(/额外工具名单读取失败/).waitFor()
    // An unknown list is not an empty one: no count until the read succeeds.
    expect(await failed.group.getByText(/已选 \d+ 个名称/).count()).toBe(0)
    expect((await failed.group.getByRole('button', { name: '保存', exact: true }).isDisabled())).toBe(true)
    settings.describe = originalDescribe
    await failed.group.getByRole('button', { name: '重试' }).first().click()
    await expect.poll(async () => await failed.group.getByRole('checkbox', { name: first, exact: true }).isChecked()).toBe(true)
  } finally {
    settings.describe = originalDescribe
  }

  // A Host rejection keeps the explicit empty draft, unlike a transport
  // failure or conflict, and a later retry writes the exact `set` operation.
  const originalMutate = settings.mutate
  settings.mutate = async (ns, ops, expectedRevision) => {
    if (ns === NAMESPACE && ops.some(op => op.path[0] === FIELD)) {
      throw new RemoteError('settings/rejected', 'pr83 write rejected', { ns })
    }
    return originalMutate.call(settings, ns, ops, expectedRevision)
  }
  try {
    await failed.group.getByRole('button', { name: '清空名单' }).click()
    await failed.group.getByRole('button', { name: '保存', exact: true }).click()
    await failed.group.getByText(/设置写入被拒绝：pr83 write rejected/).waitFor()
    expect(await failed.group.getByText('已选 0 个名称').count()).toBe(1)
  } finally {
    settings.mutate = originalMutate
  }
  await failed.group.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => grantedNames()).toEqual([])
  await failed.group.getByText('已保存。所选工具从下一轮起允许执行；未保留的选择同时撤销。').waitFor()
  expect((namespaceView().user as Record<string, unknown>)[FIELD]).toEqual([])

  // 390×844: the group and its controls stay inside the shell with no
  // horizontal scroll, and the search remains usable.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await failed.group.scrollIntoViewIfNeeded()
  await failed.group.getByLabel('搜索工具名').fill(first)
  await settleLayout(page)
  await page.screenshot({ path: join(EXTRA_TOOL_SHOTS, 'extra-tools-narrow.png') })
  const narrow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  expect(await maxHorizontalScroll(page, GROUP)).toBe(0)
  const boxes = await failed.group.evaluate((element) => {
    const group = element.getBoundingClientRect()
    const search = element.querySelector('input[type="search"]')!.getBoundingClientRect()
    return { groupRight: group.right, searchRight: search.right }
  })
  expect(boxes.searchRight).toBeLessThanOrEqual(boxes.groupRight + 1)
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  // Two independently loaded settings pages: the older draft conflicts with
  // the newer committed revision. It is preserved beside the latest value and
  // cannot save until the Human explicitly reviews it.
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const firstPage = await openGrants(page)
  const secondPage = await browserPage()
  const secondSettings = await openGrants(secondPage)
  await firstPage.group.getByRole('checkbox', { name: first, exact: true }).click()
  await firstPage.group.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => grantedNames()).toEqual([first])

  await secondSettings.group.getByRole('checkbox', { name: second, exact: true }).click()
  const conflictReload = Promise.withResolvers<void>()
  settings.describe = async () => {
    await conflictReload.promise
    return originalDescribe.call(settings)
  }
  try {
    const conflictSave = secondSettings.group.getByRole('button', { name: '保存', exact: true })
    await conflictSave.focus()
    await secondPage.keyboard.press('Enter')
    await secondSettings.group.getByText('正在重新读取…', { exact: true }).waitFor()
    // The review button is disabled while the latest list reloads, so focus
    // must land on the conflict block rather than fall out to <body>.
    await expect.poll(async () => await secondSettings.group
      .evaluate(group => group.contains(document.activeElement))).toBe(true)
    const cancel = secondSettings.group.getByRole('button', { name: '取消', exact: true })
    expect(await cancel.isDisabled()).toBe(true)
    await cancel.evaluate((button: HTMLButtonElement) => { button.click() })
    expect(await secondSettings.group.getByRole('button', { name: '我已核对，继续编辑' }).isDisabled()).toBe(true)
    await cancel.scrollIntoViewIfNeeded()
    await secondPage.screenshot({ path: join(EXTRA_TOOL_SHOTS, 'extra-tools-conflict-loading.png') })
  } finally {
    conflictReload.resolve()
    settings.describe = originalDescribe
  }
  await expect.poll(async () => await secondSettings.group.getByRole('button', { name: '我已核对，继续编辑' }).isDisabled()).toBe(false)
  await secondSettings.group.getByText('设置版本冲突').waitFor()
  expect(await secondSettings.group.textContent()).toContain(first)
  expect((await secondSettings.group.getByRole('checkbox', { name: second, exact: true }).isChecked())).toBe(true)
  expect(await secondSettings.group.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
  // Disabling the focused save button drops focus to <body>; the review button
  // must take it instead so a keyboard user keeps a landing point.
  await expect.poll(async () => await secondSettings.group
    .getByRole('button', { name: '我已核对，继续编辑' })
    .evaluate(button => button === document.activeElement)).toBe(true)
  // Save was activated from the keyboard, so the landing point must also paint
  // a ring: a focus move a keyboard user cannot see is not a landing point.
  expect(await secondSettings.group.getByRole('button', { name: '我已核对，继续编辑' })
    .evaluate(button => button.matches(':focus-visible'))).toBe(true)
  await secondPage.screenshot({ path: join(EXTRA_TOOL_SHOTS, 'extra-tools-conflict.png') })
  const revisionBeforeReview = namespaceView().revision
  await secondSettings.group.getByRole('button', { name: '我已核对，继续编辑' }).click()
  expect(await secondSettings.group.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(false)
  expect(namespaceView().revision).toBe(revisionBeforeReview)
  await secondPage.close()

  await setGrantedNames([])
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect.poll(async () => await page.getByRole('dialog').count()).toBe(0)
  await page.getByRole('button', { name: '对话', exact: true }).click()
  expect(await page.getByRole('button', { name: '团队', exact: true }).count()).toBeGreaterThan(0)
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 240_000)

async function browserPage(): Promise<Page> {
  const page = await browser!.newPage({
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
  })
  await page.goto(scaffold!.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold!.workspaceCwd, 'team-workspace-conflict')
  return page
}
