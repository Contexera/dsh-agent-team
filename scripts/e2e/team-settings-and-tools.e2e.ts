import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { Page } from 'playwright'
import {
  EXTRA_TOOL_SHOTS,
  ONE_PIXEL_PNG,
  UI09_SHOTS,
  acknowledgeReloadConnectionLoss,
  browser,
  chooseMemberModel,
  closeScenario,
  connectFreshWorkspaceZh,
  focusRing,
  maxHorizontalScroll,
  openSettings,
  openTeamPage,
  scaffold,
  scenarioHome,
  settleLayout,
} from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

const NAMESPACE = 'contexera-agent-team-host'
const FIELD = 'extraToolGrants'
const GROUP = '[data-extra-tool-grants]'
const DSH_INTERNAL_TOOLS = [
  'subagent', 'subagent_fork', 'list_subagent_models', 'list_agents', 'send_message', 'wait_agent',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'get_goal', 'update_goal', 'create_goal',
  'ask_user_question', 'todo_write', 'plugin_manager', 'present',
]

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

async function browserPage(): Promise<Page> {
  const page = await browser!.newPage({
    viewport: { width: 1440, height: 960 },
    locale: 'zh-CN',
  })
  await page.goto(scaffold!.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold!.workspaceCwd, 'team-workspace-conflict')
  return page
}

it('configures the Team page identity from Settings in real Web', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true })

  await openSettings(page)
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const nameField = panel.getByLabel('名字')
  await nameField.waitFor()
  const nameSave = panel.locator('form button[type="submit"]')
  expect(await nameField.inputValue()).toBe('human')
  expect(await panel.textContent()).toContain('你在 Team 里的身份')
  expect(await panel.textContent()).toMatch(/版本 \d+\.\d+\.\d+/)
  expect(await panel.getByRole('link', { name: 'GitHub' }).getAttribute('href')).toBe('https://github.com/Contexera/dsh-agent-team')
  expect(await panel.getByRole('button', { name: '移除头像' }).count()).toBe(0)

  await nameField.fill('Ada')
  await nameField.press('Tab')
  const saveRing = await focusRing(page, '[role="dialog"] form button[type="submit"]')
  expect(saveRing?.focusVisible).toBe(true)
  expect(saveRing?.outlineStyle).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect.poll(() => scaffold!.ctx.agentTeam.humanHandle()).toBe('Ada')
  await expect.poll(async () => await nameSave.isDisabled()).toBe(true)

  const avatarPath = join(scenarioHome(), 'ada-avatar.png')
  await writeFile(avatarPath, Buffer.from(ONE_PIXEL_PNG, 'base64'))
  await expect.poll(() => panel.getByRole('button', { name: '上传头像', exact: true }).isEnabled()).toBe(true)
  await panel.locator('input[type="file"]').setInputFiles(avatarPath)
  const preview = panel.locator('img').first()
  await preview.waitFor()
  await expect.poll(async () => await preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1)
  expect(await preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef !== undefined).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page.png'), fullPage: true })

  const context = panel.getByRole('region', { name: '上下文' })
  const threshold = context.getByLabel('默认压缩阈值')
  await threshold.waitFor()
  expect(await threshold.inputValue()).toBe('256K')
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
    const value = scaffold!.ctx.settings.describe().find(row => row.ns === 'contexera-agent-team-host')?.value as
      | { memberCompaction?: { enabled?: boolean; tokens?: number } }
      | undefined
    return value?.memberCompaction
  }).toEqual({ enabled: true, tokens: 512_000 })
  await expect.poll(async () => await context.getByText('已覆盖').count()).toBe(1)

  await threshold.fill('2GB')
  await context.getByText('请填一个大于 0 的整数，例如 256K 或 1M。').waitFor()
  await expect.poll(async () => await context.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
  expect(await threshold.inputValue()).toBe('2GB')
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-compaction-invalid.png'), fullPage: true })
  await threshold.fill('512K')
  await expect.poll(async () => await context.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-compaction.png'), fullPage: true })

  await nameField.fill('   ')
  await panel.getByText('名字不能为空。').waitFor()
  expect(await nameSave.isDisabled()).toBe(true)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-empty-name.png'), fullPage: true })
  await nameField.fill('Ada')
  await expect.poll(async () => await nameSave.isDisabled()).toBe(true)

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-narrow.png'), fullPage: true })
  const narrow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.clientWidth)
  expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(390)
  const environmentBlock = panel.locator('[data-environment]')
  await environmentBlock.waitFor()
  await expect.poll(async () => await environmentBlock.getAttribute('data-environment')).toBe('ok')
  const envBox = (await environmentBlock.boundingBox())!
  const panelBox = (await panel.boundingBox())!
  expect(envBox.x + envBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
  const narrowContext = await panel.getByRole('region', { name: '上下文' }).evaluate((element) => {
    const label = element.querySelector('label') as HTMLElement
    const input = element.querySelector('input') as HTMLElement
    return {
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      labelWidth: Math.round(label.getBoundingClientRect().width),
      labelHeight: Math.round(label.getBoundingClientRect().height),
      labelLineHeight: Number.parseFloat(getComputedStyle(label).lineHeight),
      inputWidth: Math.round(input.getBoundingClientRect().width),
    }
  })
  expect(narrowContext.scrollWidth).toBeLessThanOrEqual(narrowContext.clientWidth)
  expect(narrowContext.labelWidth).toBeGreaterThan(0)
  expect(narrowContext.labelHeight).toBeLessThanOrEqual(narrowContext.labelLineHeight * 1.5)
  expect(narrowContext.inputWidth).toBeGreaterThan(0)
  await page.setViewportSize({ width: 1440, height: 960 })
  await settleLayout(page)

  await panel.locator('input[type="file"]').setInputFiles([{ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('this is not a PNG') }])
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef !== undefined).toBe(true)
  await expect.poll(async () => await panel.locator('[data-avatar="initial"]').textContent()).toBe('A')
  expect(await panel.locator('img').count()).toBe(0)
  await page.screenshot({ path: join(UI09_SHOTS, 'team-page-undecodable-avatar.png'), fullPage: true })

  const previousAvatar = scaffold!.ctx.agentTeam.humanProfile().avatarRef!
  const staleContext = await browser!.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
  const stalePage = await staleContext.newPage()
  await stalePage.goto(scaffold!.authenticatedUrl)
  await openSettings(stalePage)
  const stalePanel = stalePage.getByRole('dialog')
  await stalePanel.getByRole('button', { name: '团队', exact: true }).click()
  await stalePanel.getByRole('button', { name: '移除头像' }).waitFor()
  await stalePage.setViewportSize({ width: 390, height: 844 })
  await settleLayout(stalePage)

  await panel.getByRole('button', { name: '移除头像' }).click()
  await expect.poll(async () => await panel.locator('img').count()).toBe(0)
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef).toBeUndefined()
  await expect.poll(async () => await panel.getByRole('button', { name: '上传头像' }).count()).toBe(1)
  await expect(scaffold!.ctx.agentTeam.getHumanAvatar({ avatarRef: previousAvatar })).resolves.toMatchObject({ name: 'broken.png' })

  await stalePanel.locator('input[type="file"]').setInputFiles(avatarPath)
  await stalePanel.getByText('资料已在别处更新，请重新读取后再试。').waitFor()
  expect(scaffold!.ctx.agentTeam.humanProfile().avatarRef).toBeUndefined()
  await stalePage.screenshot({ path: join(UI09_SHOTS, 'avatar-conflict-narrow.png'), fullPage: true })
  await stalePanel.getByRole('button', { name: '重新读取', exact: true }).press('Enter')
  await expect.poll(() => stalePanel.getByRole('button', { name: '上传头像' }).isEnabled()).toBe(true)

  const lostAvatarRequests: unknown[] = []
  const lostAvatarResponses: unknown[] = []
  await page.route('**/agentTeam/putHumanAvatar', async route => {
    const { rpcId: _transportId, ...request } = route.request().postDataJSON() as { rpcId: string }
    lostAvatarRequests.push(request)
    const response = await route.fetch()
    const envelope = await response.json() as { result: unknown }
    lostAvatarResponses.push(envelope.result)
    if (lostAvatarRequests.length === 1) await route.abort('failed')
    else await route.fulfill({ response })
  })
  await panel.locator('input[type="file"]').setInputFiles(avatarPath)
  const uncertain = panel.getByRole('alert').filter({ hasText: '保存结果未确认' })
  await uncertain.waitFor()
  expect(lostAvatarRequests).toHaveLength(1)
  expect(lostAvatarResponses[0]).toMatchObject({ ok: true, value: { avatarRef: expect.any(String) } })
  const lostWriteAvatar = scaffold!.ctx.agentTeam.humanProfile().avatarRef
  expect(lostWriteAvatar).toBeDefined()
  await expect.poll(async () => await panel.locator('img').count()).toBe(1)

  await stalePanel.locator('input[type="file"]').setInputFiles(avatarPath)
  await stalePanel.getByText('资料已在别处更新，请重新读取后再试。').waitFor()
  expect(scaffold!.ctx.agentTeam.humanProfile().avatarRef).toBe(lostWriteAvatar)
  await stalePanel.getByRole('button', { name: '重新读取', exact: true }).press('Enter')
  await stalePanel.getByRole('button', { name: '移除头像' }).waitFor()
  await stalePanel.getByRole('button', { name: '移除头像' }).click()
  await expect.poll(() => scaffold!.ctx.agentTeam.humanProfile().avatarRef).toBeUndefined()
  expect(await uncertain.isVisible()).toBe(true)
  expect(await panel.locator('img').count()).toBe(1)
  expect(lostAvatarRequests).toHaveLength(1)
  await page.screenshot({ path: join(UI09_SHOTS, 'avatar-uncertain-after-other-window.png'), fullPage: true })

  await uncertain.getByRole('button', { name: '重新读取', exact: true }).press('Enter')
  await expect.poll(async () => await panel.locator('img').count()).toBe(0)
  await expect.poll(async () => await panel.locator('[data-avatar="initial"]').textContent()).toBe('A')
  await expect.poll(async () => await panel.getByRole('alert').count()).toBe(0)
  await expect.poll(async () => await panel.getByRole('button', { name: '上传头像' }).isEnabled()).toBe(true)
  expect(lostAvatarRequests).toHaveLength(1)
  await staleContext.close()

  await panel.locator('input[type="file"]').setInputFiles(avatarPath)
  await expect.poll(async () => await panel.locator('img').count()).toBe(1)
  await panel.getByRole('button', { name: '关闭', exact: true }).click()

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
  const profileWorkspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const profileProject = scaffold!.ctx.agentTeam.view({ workspaceId: profileWorkspaceId }).projects.find((entry: { name: string }) => entry.name === 'profile-check')!
  await scaffold!.ctx.agentTeam.startThread({ requestId: 'e2e-profile-thread' as never, workspaceId: profileWorkspaceId,
    projectRef: profileProject.projectRef, kind: 'discussion', body: 'PROFILE-NAME-MARKER hello from the renamed human' })
  await expect.poll(async () => await row.textContent()).toContain('Ada')
  expect(await row.textContent()).not.toContain('Human')
  const humanPicture = row.locator('[data-avatar="image"]')
  await expect.poll(async () => await humanPicture.count()).toBe(1)
  expect(await humanPicture.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  await page.screenshot({ path: join(UI09_SHOTS, 'renamed-human-in-timeline.png'), fullPage: true })

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

it('grants, revokes, and reconciles profile extra tools in the assembled Web surface', async () => {
  const { page, consoleWatch } = await openTeamPage({ stayInOrdinaryMode: true })
  await page.getByRole('button', { name: '团队', exact: true }).click()
  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('catalog-baseline')
  await createAgent.getByLabel('说明').fill('激活真实 Member preset')
  await chooseMemberModel(page, createAgent)
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('catalog-baseline', { exact: true }).waitFor({ timeout: 20_000 })
  for (const name of ['e2e_external_alpha', 'e2e_external_beta']) {
    scaffold!.ctx.tools.register(defineContentToolFixture({
      name,
      description: 'external plugin fixture',
      parameters: {},
      execute: async () => [{ type: 'text', text: 'ok' }],
    }))
  }
  const catalog = scaffold!.ctx.agentTeam.toolCatalogForClient({}).names
  for (const name of DSH_INTERNAL_TOOLS) expect(catalog).not.toContain(name)
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
  expect(await group.textContent()).toContain('不安装插件')
  expect(await group.textContent()).toContain('从下一轮生效')

  const search = group.getByLabel('搜索工具名')
  await search.fill(first)
  const firstChoice = group.getByRole('checkbox', { name: first, exact: true })
  await search.focus()
  await page.keyboard.press('Tab')
  expect(await firstChoice.evaluate(choice => choice === document.activeElement)).toBe(true)
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
  await expect.poll(async () => await group.getByText('已选 2 个名称').count()).toBe(1)
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
  await group.getByText('已保存，从下一轮生效。').waitFor()

  await group.getByLabel('搜索工具名').fill('pr83-no-such-tool')
  await group.getByText('没有匹配的工具名。').waitFor()
  await group.getByLabel('搜索工具名').fill('')

  await setGrantedNames(['pr83_unregistered_tool', first])
  await reload(page, consoleWatch)
  const missing = await openGrants(page)
  expect(await missing.group.locator('[data-extra-tool-missing]').textContent()).toContain('pr83_unregistered_tool')
  expect(await missing.group.locator('[data-extra-tool-missing]')
    .evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('0px')
  await page.screenshot({ path: join(EXTRA_TOOL_SHOTS, 'extra-tools-not-grantable.png') })
  await missing.group.getByRole('checkbox', { name: /pr83_unregistered_tool/ }).click()
  await missing.group.getByRole('button', { name: '保存', exact: true }).click()
  await expect.poll(() => grantedNames()).toEqual([first])

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
    expect(await degraded.group.locator('[data-extra-tool-selected]')
      .evaluate(node => getComputedStyle(node).borderLeftWidth)).toBe('0px')
    await degraded.group.getByRole('checkbox', { name: first, exact: true }).click()
    await degraded.group.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => grantedNames()).toEqual([])
    await degraded.group.getByText('已保存，从下一轮生效。').waitFor()
    await page.screenshot({ path: join(EXTRA_TOOL_SHOTS, 'extra-tools-identity-catalog-failure.png') })
  } finally {
    team.humanProfileForClient = originalProfile
    team.toolCatalogForClient = originalCatalog
  }

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
    expect(await failed.group.getByText(/已选 \d+ 个名称/).count()).toBe(0)
    expect((await failed.group.getByRole('button', { name: '保存', exact: true }).isDisabled())).toBe(true)
    settings.describe = originalDescribe
    await failed.group.getByRole('button', { name: '重试' }).first().click()
    await expect.poll(async () => await failed.group.getByRole('checkbox', { name: first, exact: true }).isChecked()).toBe(true)
  } finally {
    settings.describe = originalDescribe
  }

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
  await failed.group.getByText('已保存，从下一轮生效。').waitFor()
  expect((namespaceView().user as Record<string, unknown>)[FIELD]).toEqual([])

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
  await expect.poll(async () => await secondSettings.group
    .getByRole('button', { name: '我已核对，继续编辑' })
    .evaluate(button => button === document.activeElement)).toBe(true)
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
