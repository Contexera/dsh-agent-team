import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Locator, Page } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import {
  UI09_SHOTS,
  WORKER_SHOTS,
  acknowledgeReloadConnectionLoss,
  chooseMemberModel,
  closeScenario,
  maxHorizontalScroll,
  memberAgent,
  openSettings,
  openTeamPage,
  scaffold,
  settleLayout,
  waitForMemberAgent,
} from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

const MASTER = '允许从成员会话派出 Worker'
const SAVE = '保存'
const MISSING_CODEX = '/nonexistent/worker-lane/codex'

async function openWorkerGroup(page: Page) {
  await openSettings(page)
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const group = panel.locator('[data-worker-settings]')
  await group.waitFor()
  return { panel, group }
}

function disclosure(group: Locator): Locator {
  return group.getByRole('button', { name: /Worker 委派/ })
}

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
  const summary = disclosure(group)
  expect(await summary.getAttribute('aria-expanded')).toBe('false')
  expect(await summary.textContent()).toContain('已关闭')
  expect(await group.getByRole('switch', { name: MASTER }).count()).toBe(0)
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'worker-settings-collapsed.png') })

  await expand(group)
  const master = group.getByRole('switch', { name: MASTER })
  await expect.poll(async () => await master.getAttribute('aria-checked')).toBe('false')
  const copy = await group.textContent()
  expect(copy).toContain('完整权限运行')
  expect(copy).toContain('默认关闭')

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

  const codex = group.locator('[data-worker-engine="codex"]')
  const codexSwitch = codex.getByRole('switch')
  expect(await codexSwitch.isDisabled()).toBe(true)
  expect(await codex.getByLabel('Codex 的可执行路径').isDisabled()).toBe(true)
  expect(await group.getByLabel('沙箱策略').count()).toBe(0)

  await master.click()
  await expect.poll(async () => await codexSwitch.isDisabled()).toBe(false)
  await codexSwitch.click()
  await expect.poll(async () => await codexSwitch.getAttribute('aria-checked')).toBe('true')
  await codex.getByLabel('Codex 的可执行路径').fill('/data/bin/codex')

  const save = group.getByRole('button', { name: SAVE })
  await save.click()
  await expect.poll(async () => await save.isDisabled(), { timeout: 20_000 }).toBe(true)
  await settleLayout(page)
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
  expect(geometry.separators).toEqual([])
  expect(geometry.panelFill).not.toBe(geometry.groupFill)
  expect(geometry.panelIndent).toBe(0)
  expect(geometry.labelLeft).toBe(geometry.shippedLabelLeft)
  expect(Math.abs(geometry.controlsRight - geometry.groupRight)).toBeLessThanOrEqual(1)
  await group.evaluate(element => { element.scrollIntoView({ block: 'start' }) })
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'worker-settings-desktop.png') })

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

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
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

  const storedClaude = stored.locator('[data-worker-engine="claude"]')
  await storedClaude.getByRole('switch').click()
  await expect.poll(async () => await storedClaude.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  await storedClaude.getByLabel('Claude 的可执行路径').fill('/data/bin/claude')
  await stored.locator('select').selectOption('claude')
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
  await switchedClaude.scrollIntoViewIfNeeded()
  await settleLayout(page)
  await page.screenshot({ path: join(UI09_SHOTS, 'worker-settings-claude.png') })

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

it('leaves a delegated Worker run in its own Thread', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id

  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('runner')
  await createAgent.getByLabel('说明').fill('派 Worker 的执行者')
  await chooseMemberModel(page, createAgent)
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('runner', { exact: true }).waitFor({ timeout: 20_000 })

  const created = await team.createProject({ requestId: 'e2e-worker-project' as never, workspaceId,
    name: 'worker-results', description: 'Worker 结果表明在 Thread 里' })
  const projectRef = created.project.projectRef
  const runner = team.members({ workspaceId }).find(status => status.member.handle === 'runner')!.member
  await team.addProjectOwner({ requestId: 'e2e-worker-owner' as never, workspaceId, projectRef, memberId: runner.memberId })
  const discussion = await team.startThread({ requestId: 'e2e-worker-discussion' as never, workspaceId, projectRef,
    kind: 'discussion', body: '**TASKFREE** 一条不提升成 Task 的讨论' })
  const discussionRef = discussion.thread.threadRef
  const taskful = await team.startThread({ requestId: 'e2e-worker-taskful' as never, workspaceId, projectRef,
    kind: 'discussion', body: '**TASKFUL** 一条会提升成 Task 的讨论' })
  const taskfulRef = taskful.thread.threadRef
  await waitForMemberAgent(scaffold!, workspaceId, runner.memberId)
  const opened = await team.readThreadForAgent(memberAgent(scaffold!, workspaceId, runner.memberId),
    { requestId: 'e2e-worker-read-open' as never, workspaceId, threadRef: taskfulRef })
  await team.promoteThread({ requestId: 'e2e-worker-promote' as never, workspaceId, threadRef: taskfulRef,
    baseRevision: opened.thread.revision })
  const promoteState = team.readThreadForAgent(memberAgent(scaffold!, workspaceId, runner.memberId),
    { requestId: 'e2e-worker-read-promoted' as never, workspaceId, threadRef: taskfulRef })
  expect((await promoteState).thread.taskRef ?? (await promoteState).task).toBeDefined()

  await openSettings(page)
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const group = panel.locator('[data-worker-settings]')
  await group.waitFor()
  await group.getByRole('button', { name: /Worker 委派/ }).click()
  const master = group.getByRole('switch', { name: MASTER })
  await master.click()
  const codex = group.locator('[data-worker-engine="codex"]')
  const codexSwitch = codex.getByRole('switch')
  await expect.poll(async () => await codexSwitch.isDisabled()).toBe(false)
  await codexSwitch.click()
  await expect.poll(async () => await codexSwitch.getAttribute('aria-checked')).toBe('true')
  await codex.getByLabel('Codex 的可执行路径').fill(MISSING_CODEX)
  const save = group.getByRole('button', { name: '保存' })
  await save.click()
  await expect.poll(async () => await save.isDisabled(), { timeout: 20_000 }).toBe(true)
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  const workerRow = team.config.worker.get()
  expect(workerRow.enabled).toBe(true)
  expect(workerRow.engines.codex).toMatchObject({ enabled: true, executable: MISSING_CODEX })

  const delegations = [
    { requestId: 'e2e-worker-run-free', threadRef: discussionRef },
    { requestId: 'e2e-worker-run-task', threadRef: taskfulRef },
  ] as const
  const cwd = scaffold!.ctx.workspaceRegistry.list()[0]!.path
  for (const delegation of delegations) {
    const outcome = await team.workerStartForAgent(memberAgent(scaffold!, workspaceId, runner.memberId), { requestId: delegation.requestId as never,
      threadRef: delegation.threadRef, task: '把这条讨论收尾', cwd }).then(() => undefined, (error: unknown) => error)
    expect(outcome).toBeInstanceOf(Error)
  }

  for (const delegation of delegations) {
    const inbox = team.inboxForAgent(memberAgent(scaffold!, workspaceId, runner.memberId), { workspaceId })
    const row = inbox.items.find(item => item.thread.threadRef === delegation.threadRef)
    expect(row).toBeDefined()
    expect(row!.directCount).toBeGreaterThanOrEqual(1)
    const read = await team.readThreadForAgent(memberAgent(scaffold!, workspaceId, runner.memberId),
      { requestId: `e2e-worker-read-${delegation.threadRef}` as never, workspaceId, threadRef: delegation.threadRef })
    expect(read.workerStates).toHaveLength(1)
    expect(read.workerStates?.[0]).toMatchObject({ state: 'failed', unconfirmed: false })
    const settled = read.facts.map(entry => entry.fact)
      .find(fact => fact.kind === 'activity' && fact.activity.kind === 'worker_settled')
    expect(settled?.kind).toBe('activity')
    if (settled?.kind === 'activity' && settled.activity.kind === 'worker_settled') {
      expect(settled.activity.state).toBe('failed')
      expect(settled.activity.reason).toBeTruthy()
    }
  }

  const warningStart = consoleWatch.warnings.length
  await page.reload()
  await settleLayout(page)
  acknowledgeReloadConnectionLoss(consoleWatch, warningStart)
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe('team')
  const openInbox = async (): Promise<void> => {
    await page.getByRole('button', { name: /^收件箱/ }).first().click()
    await page.getByRole('button', { name: /TASKFUL/ }).first().waitFor({ timeout: 20_000 })
  }
  const openRow = async (marker: string): Promise<void> => {
    await page.getByRole('button', { name: new RegExp(marker) }).first().click()
  }
  await openInbox()
  await openRow('TASKFUL')
  const taskPage = page.locator(`main[data-team-thread="${taskfulRef}"]`)
  await taskPage.waitFor({ timeout: 20_000 })
  await expect.poll(async () => await taskPage.textContent()).toContain('runner 派出了 Codex Worker')
  await expect.poll(async () => await taskPage.textContent()).toContain('runner 的 Codex Worker 失败：')
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_SHOTS, 'worker-thread-task.png') })

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  expect(await maxHorizontalScroll(page, `main[data-team-thread="${taskfulRef}"]`)).toBe(0)
  await page.screenshot({ path: join(WORKER_SHOTS, 'worker-thread-task-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 960 })

  await openInbox()
  await openRow('TASKFREE')
  const discussionPanel = page.locator(`[data-team-panel="${discussionRef}"]`)
  await discussionPanel.waitFor({ timeout: 20_000 })
  await expect.poll(async () => await discussionPanel.textContent()).toContain('runner 派出了 Codex Worker')
  await expect.poll(async () => await discussionPanel.textContent()).toContain('失败：')
  expect(await discussionPanel.textContent()).not.toContain('worker:')
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_SHOTS, 'worker-thread-discussion.png') })

  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe(null)
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 20_000 })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 300_000)
