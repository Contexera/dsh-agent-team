import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  MANAGER_SHOTS, acknowledgeReloadConnectionLoss, closeScenario, focusRing, openSidebar, openTeamPage, scaffold, settleAnimations, settleLayout,
} from './__external-agent-team-support.ts'

let replayDir: string | undefined

afterEach(async () => {
  try { await closeScenario() } finally {
    if (replayDir !== undefined) await rm(replayDir, { recursive: true, force: true })
    replayDir = undefined
  }
})

type ChunksResponse = Extract<ReplayEntry, { kind: 'chunks' }>

function textResponse(text: string): ChunksResponse {
  return { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }
}

function questionResponse(): ChunksResponse {
  const id = ToolCallId('team-manager-question')
  const args = JSON.stringify({ questions: [{
    id: 'next-step', header: '下一步', question: '要先检查团队现状，还是直接修改配置？',
    options: [{ label: '只读检查', description: '先读取现状，不做修改。' }, { label: '直接修改' }],
  }] })
  return { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'ask_user_question', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'ask_user_question', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] }
}

/** Child replay derives its own positional script from recorded streams; the primary override cannot supply it. */
function managerReplayFixture(responses: readonly ChunksResponse[]): string {
  const rows: object[] = [{
    type: 'session', version: 4, id: 'manager', createdAt: 1, cwd: '/tmp/team-manager-replay',
    isSeeded: false, delegationDepth: 0, agentPreset: 'team-manager',
  }]
  for (const [index, response] of responses.entries()) {
    const turn = index + 1
    rows.push(
      { type: 'turn/start', data: { turn } },
      { type: 'step/start', data: { turn, step: 1 } },
      { type: 'assistant/attempt', data: { turn, step: 1,
        stream: response.chunks.map(chunk => ({ type: 'chunk', time: 0, chunk })) } },
      { type: 'step/end', data: { turn, step: 1 } },
      { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    )
  }
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n'
}

async function currentSessionId(page: import('playwright').Page): Promise<string | undefined> {
  return page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? '{}') as { sessionId?: string }).sessionId)
}

async function waitForSession(page: import('playwright').Page, sessionId: string): Promise<void> {
  await expect.poll(() => currentSessionId(page), { timeout: 20_000 }).toBe(sessionId)
  await page.locator(`[data-conversation-session="${sessionId}"]`).waitFor({ timeout: 20_000 })
}

it('drives the manager through shipped Conversation, replacement, reload, and ordinary Session restoration', async () => {
  replayDir = await mkdtemp(join(tmpdir(), 'dsh-team-manager-'))
  const fixture = join(replayDir, 'session.jsonl')
  const override = join(replayDir, 'replay.override.json')
  const managerFixture = join(replayDir, 'session.1.v4.jsonl')
  const secondManagerFixture = join(replayDir, 'session.2.v4.jsonl')
  await writeFile(fixture, '{"type":"session","version":0,"id":"primary","createdAt":0}\n')
  await writeFile(override, JSON.stringify([
    textResponse('普通 DSH 会话已就绪。'),
    textResponse('普通 DSH 会话仍可继续。'),
  ]))
  await writeFile(managerFixture, managerReplayFixture([
    questionResponse(),
    textResponse('已收到选择：只读检查。'),
  ]))
  await writeFile(secondManagerFixture, managerReplayFixture([textResponse('第二代管理会话已就绪。')]))
  const { page, consoleWatch } = await openTeamPage({
    stayInOrdinaryMode: true,
    replay: { fixture, override, childFixtures: [managerFixture, secondManagerFixture] },
  })
  const presetPicker = page.locator('button[title="选择新任务使用的 Agent 预设"]')
  const presetLabel = page.locator('[data-slot="conversation.session.header.actions"] span[title]:has(svg[data-icon="dsw-icon-agent-preset-outline-regular"])')
  const permissionControl = page.getByRole('button', { name: /^访问模式，当前：/ })

  // A staged ordinary preset must survive the manager detour. The manager has no preset picker of its own.
  await page.getByRole('button', { name: '标准模式', exact: true }).click()
  await page.getByRole('menuitem', { name: /^极简模式/ }).click()
  await page.getByRole('button', { name: '极简模式', exact: true }).waitFor()
  const ordinaryId = await currentSessionId(page)
  expect(ordinaryId).toBeDefined()
  const initialOrdinaryComposer = page.locator('[data-composer-input][contenteditable="true"]')
  await initialOrdinaryComposer.fill('先保留一条普通对话')
  await initialOrdinaryComposer.press('Enter')
  await page.getByText('普通 DSH 会话已就绪。', { exact: true }).waitFor({ timeout: 30_000 })

  await page.getByRole('button', { name: '团队', exact: true }).click()
  const managerEntry = page.locator('button[data-team-action="manager"]')
  await managerEntry.focus()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await currentSessionId(page))?.startsWith('agent-team-manager-') ?? false, { timeout: 30_000 }).toBe(true)
  const firstManagerId = (await currentSessionId(page))!
  await waitForSession(page, firstManagerId)
  expect(await page.locator('[data-team-manager-gate]').count()).toBe(0)
  expect(await presetPicker.count()).toBe(0)
  await expect.poll(() => presetLabel.count()).toBe(0)
  await expect.poll(() => permissionControl.count()).toBe(0)
  expect(await page.evaluate(() => {
    const navigation = JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as Record<string, unknown>
    return navigation.manager === true && !('managerSessionId' in navigation) && !('returnToSessionId' in navigation)
  })).toBe(true)
  const firstAgent = scaffold!.ctx.agents.get(firstManagerId as SessionId)
  expect(firstAgent).toBeDefined()
  expect(firstAgent!.session.header.agentPreset).toBe('team-manager')
  expect(scaffold!.ctx.tools.schemas(firstAgent! as never).some(tool => tool.name === 'ask_user_question')).toBe(true)
  // The manager holds the nine manager Team tools and none of the Member
  // family. The preset's `only` list is the only narrowing that reaches the
  // model, because the visible list is read from the registering scope's
  // schemas — so an exact set here is what proves a Member tool never leaks
  // into the manager composition. The set is named, not filtered by prefix:
  // the seven write tools carry no `team_` prefix, so a prefix filter would
  // quietly drop them and pass on the two reads alone.
  const managerToolNames = scaffold!.ctx.tools.schemas(firstAgent! as never).map(tool => tool.name)
  expect(managerToolNames).toEqual(expect.arrayContaining(['team_overview', 'team_models', 'member_create', 'project_create', 'project_owner', 'project_update', 'member_update', 'member_state', 'member_workspace']))
  expect(managerToolNames.filter(name => ['team_inbox', 'team_attention', 'team_thread', 'team_message', 'team_dm',
    'team_task', 'team_view', 'team_subscription', 'team_reminder', 'team_worker'].includes(name))).toEqual([])
  const directSelectError = await scaffold!.ctx.agentPresets.select(firstAgent!, 'minimal').then(() => undefined, (error: unknown) => error)
  expect(directSelectError).toBeInstanceOf(Error)
  expect(String(directSelectError)).toContain('scope key is already bound')
  expect(firstAgent!.session.header.agentPreset).toBe('team-manager')
  expect(firstAgent!.status).toBe('idle')
  expect(firstAgent!.session.ownEvents().map(event => event.type)).toEqual(['sandbox/mode', 'approval/policy', 'session/title'])
  expect(scaffold!.ctx.agentPresets.composedPreset(firstAgent!.ctx)).toBeUndefined()

  const managerComposer = page.locator('[data-composer-input][contenteditable="true"]')
  await managerComposer.fill('请先问我一个问题')
  await managerComposer.press('Enter')
  const question = page.locator('[data-question-key]')
  await question.waitFor({ timeout: 20_000 })
  const choice = question.getByRole('radio', { name: /只读检查/ })
  await choice.focus()
  await page.keyboard.press('Space')
  await expect.poll(async () => choice.isChecked()).toBe(true)
  await page.mouse.move(1400, 900)
  await page.screenshot({ path: join(MANAGER_SHOTS, 'manager-question-desktop.png'), fullPage: true, animations: 'disabled' })
  const submit = question.getByRole('button', { name: '提交', exact: true })
  await submit.focus()
  await page.keyboard.press('Enter')
  await page.getByText('已收到选择：只读检查。', { exact: true }).waitFor({ timeout: 30_000 })
  expect(JSON.stringify(firstAgent!.session.ownEvents().filter(event => event.type === 'tool/result'))).toContain('只读检查')

  await page.getByRole('button', { name: '新开对话', exact: true }).click()
  await expect.poll(async () => {
    const id = await currentSessionId(page)
    return id !== undefined && id !== firstManagerId && id.startsWith('agent-team-manager-')
  }, { timeout: 30_000 }).toBe(true)
  const secondManagerId = (await currentSessionId(page))!
  await waitForSession(page, secondManagerId)
  // The ordinary creation path must not reuse a blank manager bound to its isolated preset registry.
  await page.locator('button[data-team-action="leave"]').click()
  await waitForSession(page, ordinaryId!)
  await page.locator('button[class*="newSession"][aria-label="新建会话"]').click()
  await expect.poll(async () => {
    const id = await currentSessionId(page)
    return id !== undefined && id !== ordinaryId && !id.startsWith('agent-team-manager-')
  }, { timeout: 10_000 }).toBe(true)
  await expect.poll(() => page.locator('[role="alert"]').count()).toBe(0)
  const newestOrdinaryId = (await currentSessionId(page))!
  await page.locator(`[data-row-key="session:${ordinaryId}"]`).click()
  await waitForSession(page, ordinaryId!)
  await page.getByRole('button', { name: '团队', exact: true }).click()
  await managerEntry.click()
  await waitForSession(page, secondManagerId)
  const secondManagerComposer = page.locator('[data-composer-input][contenteditable="true"]')
  await secondManagerComposer.waitFor()
  await secondManagerComposer.fill('准备第二代管理历史')
  await secondManagerComposer.press('Enter')
  await page.getByText('第二代管理会话已就绪。', { exact: true }).waitFor({ timeout: 30_000 })
  expect(scaffold!.ctx.workspaceRegistry.archivedSessionIds).toContain(firstManagerId)
  expect(await scaffold!.ctx.agentTeam.openManagerSession({})).toMatchObject({ status: 'ready', sessionId: secondManagerId })

  const warningStart = consoleWatch.warnings.length
  await page.reload()
  await settleLayout(page)
  acknowledgeReloadConnectionLoss(consoleWatch, warningStart)
  await waitForSession(page, secondManagerId)
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 20_000 })
  expect(await presetPicker.count()).toBe(0)

  // A reload forgets the return target and captures the newest ordinary sibling.
  await page.locator('button[data-team-action="leave"]').click()
  await waitForSession(page, newestOrdinaryId)
  await page.locator(`[data-row-key="session:${ordinaryId}"]`).click()
  await waitForSession(page, ordinaryId!)
  const ordinaryComposer = page.locator('[data-composer-input][contenteditable="true"]')
  await ordinaryComposer.fill('继续普通对话')
  await ordinaryComposer.press('Enter')
  await page.getByText('普通 DSH 会话仍可继续。', { exact: true }).waitFor({ timeout: 30_000 })
  expect(scaffold!.ctx.agentPresets.composedPreset(scaffold!.ctx.agents.get(ordinaryId as SessionId)!.ctx)).toBe('minimal')
  await page.locator('[data-content-phase="active"]').waitFor()
  await expect.poll(() => presetLabel.count()).toBe(1)
  await expect.poll(() => permissionControl.count()).toBe(1)
  await expect.poll(() => page.getByRole('button', { name: '新开对话', exact: true }).count()).toBe(0)
  await page.locator('button[class*="newSession"][aria-label="新建会话"]').click()
  await expect.poll(async () => {
    const id = await currentSessionId(page)
    return id !== undefined && id !== ordinaryId && !id.startsWith('agent-team-manager-')
  }, { timeout: 10_000 }).toBe(true)
  await expect.poll(() => page.locator('[role="alert"]').count()).toBe(0)
  await page.locator(`[data-row-key="session:${ordinaryId}"]`).click()
  await waitForSession(page, ordinaryId!)
  // Replacement moves the old manager out of the active list without deleting
  // its history; the current manager remains an ordinary Workspace Session.
  expect(await page.locator('[role="treeitem"]').filter({ hasText: '团队管理' }).count()).toBeGreaterThan(0)
  const retiredHistoryRow = page.locator(`[data-row-key="session:${firstManagerId}"]`)
  const currentHistoryRow = page.locator(`[data-row-key="session:${secondManagerId}"]`)
  await expect.poll(() => retiredHistoryRow.count()).toBe(0)
  await expect.poll(() => currentHistoryRow.count()).toBe(1)
  await page.getByRole('button', { name: '视图选项', exact: true }).click()
  await page.getByRole('menuitem', { name: '仅显示已归档', exact: true }).click()
  await retiredHistoryRow.waitFor()
  await expect.poll(() => currentHistoryRow.count()).toBe(0)
  await retiredHistoryRow.hover()
  await page.screenshot({ path: join(MANAGER_SHOTS, 'manager-history-desktop.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('button', { name: '视图选项', exact: true }).click()
  await page.getByRole('menuitem', { name: '隐藏已归档', exact: true }).click()
  await expect.poll(() => retiredHistoryRow.count()).toBe(0)
  await expect.poll(() => currentHistoryRow.count()).toBe(1)

  // Archiving the current manager through the same ordinary-list action is replacement-eligible.
  await currentHistoryRow.click()
  await waitForSession(page, secondManagerId)
  await currentHistoryRow.hover()
  await currentHistoryRow.getByRole('button', { name: /^会话“.*”的操作$/ }).click()
  await page.getByRole('menuitem', { name: '归档会话', exact: true }).click()
  await expect.poll(() => scaffold!.ctx.workspaceRegistry.archivedSessionIds.includes(secondManagerId as SessionId)).toBe(true)
  await page.locator(`[data-row-key="session:${ordinaryId}"]`).click()
  await waitForSession(page, ordinaryId!)
  await page.getByRole('button', { name: '团队', exact: true }).click()
  await page.getByRole('button', { name: '收起侧边栏' }).click()
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await settleLayout(page)
  const railManager = page.locator('nav[class*="railWorkspace"] button[data-team-action="manager"]')
  await railManager.focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  const ring = await focusRing(page, 'nav[class*="railWorkspace"] button[aria-label="团队管理"]:focus')
  expect(ring?.focusVisible).toBe(true)
  expect(ring?.outlineStyle).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect.poll(async () => {
    const id = await currentSessionId(page)
    return id !== undefined && id !== secondManagerId && id.startsWith('agent-team-manager-')
  }, { timeout: 30_000 }).toBe(true)
  const thirdManagerId = (await currentSessionId(page))!
  await waitForSession(page, thirdManagerId)
  await expect.poll(async () => presetPicker.count()).toBe(0)
  await expect.poll(async () => railManager.getAttribute('aria-current')).toBe('page')
  await settleAnimations(page)
  expect(await currentSessionId(page)).toBe(thirdManagerId)
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.agent-team.navigation') ?? '{}') as { manager?: boolean }).manager)).toBe(true)
  expect(await presetPicker.count()).toBe(0)
  await page.screenshot({ path: join(MANAGER_SHOTS, 'manager-collapsed-rail.png'), fullPage: true })

  // The narrow drawer keeps the same destination and the shipped composer stays inside the viewport.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await settleLayout(page)
  expect(await presetPicker.count()).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await page.screenshot({ path: join(MANAGER_SHOTS, 'manager-mobile.png'), fullPage: true })
  await openSidebar(page)
  await page.locator('button[data-team-action="leave"]').click()
  await waitForSession(page, ordinaryId!)
  if (await page.locator('[data-sidebar-collapsed="true"]').count() > 0) await openSidebar(page)
  await page.getByRole('button', { name: '团队', exact: true }).click()
  const narrowManagerEntry = page.locator('button[data-team-action="manager"]')
  await settleAnimations(page)
  if (!await narrowManagerEntry.isVisible()) await openSidebar(page)
  await narrowManagerEntry.waitFor({ state: 'visible' })
  await settleAnimations(page)
  await page.screenshot({ path: join(MANAGER_SHOTS, 'manager-narrow-drawer.png'), fullPage: true })
  await narrowManagerEntry.click()
  await waitForSession(page, thirdManagerId)
  await openSidebar(page)
  await page.locator('button[data-team-action="leave"]').click()
  await waitForSession(page, ordinaryId!)
  await page.getByText('普通 DSH 会话仍可继续。', { exact: true }).waitFor()
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 240_000)

it('keeps failures retryable and ignores a manager resolution that arrives after the reader leaves', async () => {
  replayDir = await mkdtemp(join(tmpdir(), 'dsh-team-manager-'))
  const fixture = join(replayDir, 'session.jsonl')
  const override = join(replayDir, 'replay.override.json')
  await writeFile(fixture, '{"type":"session","version":0,"id":"primary","createdAt":0}\n')
  await writeFile(override, JSON.stringify([textResponse('管理会话已就绪。')]))
  const { page, consoleWatch } = await openTeamPage({ replay: { fixture, override } })
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await openSidebar(page)
  const team = scaffold!.ctx.agentTeam
  const original = team.openManagerSession
  team.openManagerSession = async () => ({
    status: 'unavailable',
    // One unbroken token: a Host diagnostic can be a class or a path, and the band has to wrap it
    // rather than let it push the retry control off the surface.
    diagnostic: { class: 'session-refused', detail: 'managerbrowserdiagnostic'.repeat(6), occurredAt: new Date().toISOString() },
  })
  await page.locator('button[data-team-action="manager"]').click()
  await page.getByRole('alert').filter({ hasText: 'managerbrowserdiagnostic' }).waitFor()
  // The gate's failure is the surface failure the rest of this Client already draws:
  // one line, message first, retry at the row's end. A second anatomy would stack the
  // control under the message, which is exactly what these two measurements catch.
  const band = page.locator('[data-team-manager-gate] [role="alert"]')
  const bandText = band.locator('span').first()
  const bandStyle = await bandText.evaluate(element => {
    const style = getComputedStyle(element)
    return { size: style.fontSize, leading: style.lineHeight }
  })
  expect(bandStyle).toEqual({ size: '12px', leading: '18px' })
  const [bandTextBox, bandRetryBox] = await Promise.all([
    bandText.boundingBox(),
    band.getByRole('button', { name: '重试', exact: true }).boundingBox(),
  ])
  expect(bandRetryBox!.y).toBeLessThan(bandTextBox!.y + bandTextBox!.height)
  expect(bandRetryBox!.x).toBeGreaterThan(bandTextBox!.x + bandTextBox!.width)
  // The unbroken diagnostic wraps inside the band: the surface scrolls neither sideways at 390
  // nor inside the band itself, which is what the message's own wrap rule buys.
  const bandOverflow = await band.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }))
  expect(bandOverflow.scroll).toBeLessThanOrEqual(bandOverflow.client)
  const pageOverflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(pageOverflow.scroll).toBeLessThanOrEqual(pageOverflow.client)
  expect(await page.locator('[data-composer-input]').count()).toBe(0)
  await settleLayout(page)
  await page.screenshot({ path: join(MANAGER_SHOTS, 'manager-open-failure.png'), fullPage: true })

  team.openManagerSession = original
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect.poll(async () => (await currentSessionId(page))?.startsWith('agent-team-manager-') ?? false, { timeout: 30_000 }).toBe(true)
  const readyManagerId = (await currentSessionId(page))!
  await waitForSession(page, readyManagerId)
  await expect.poll(() => page.locator('[data-composer-input][contenteditable="true"]')
    .evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)

  const readyManagerComposer = page.locator('[data-composer-input][contenteditable="true"]')
  await readyManagerComposer.fill('请准备一条管理对话')
  await readyManagerComposer.press('Enter')
  await page.getByText('管理会话已就绪。', { exact: true }).waitFor({ timeout: 30_000 })
  await page.locator('[data-content-phase="active"]').waitFor({ timeout: 10_000 })
  await page.getByRole('button', { name: '新开对话', exact: true }).waitFor({ timeout: 10_000 })
  const originalReplacement = team.newManagerSession
  team.newManagerSession = async () => ({
    status: 'unavailable',
    diagnostic: { class: 'runtime', detail: 'new manager browser failure', occurredAt: new Date().toISOString() },
  })
  await page.getByRole('button', { name: '新开对话', exact: true }).click()
  const failureToast = page.getByRole('alert').filter({ hasText: 'new manager browser failure' })
  await failureToast.waitFor()
  await expect.poll(() => failureToast.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
  await page.screenshot({ path: join(MANAGER_SHOTS, 'manager-new-failure-mobile.png'), fullPage: true })
  await expect.poll(() => page.getByRole('button', { name: '新开对话', exact: true }).isDisabled()).toBe(false)
  await expect.poll(() => failureToast.count(), { timeout: 9000 }).toBe(0)
  team.newManagerSession = originalReplacement
  await openSidebar(page)
  await page.getByRole('button', { name: /^收件箱/ }).click()
  await page.locator('[data-team-inbox]').waitFor()

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let finished = false
  team.openManagerSession = async request => {
    await gate
    try { return await original.call(team, request) } finally { finished = true }
  }
  await openSidebar(page)
  await page.locator('button[data-team-action="manager"]').click()
  await page.getByRole('status').filter({ hasText: '正在打开团队管理' }).waitFor()
  await openSidebar(page)
  await page.getByRole('button', { name: /^收件箱/ }).click()
  release()
  await expect.poll(() => finished, { timeout: 30_000 }).toBe(true)
  await page.locator('[data-team-inbox]').waitFor()
  expect((await currentSessionId(page))?.startsWith('agent-team-manager-') ?? false).toBe(false)
  expect(await page.locator('[data-team-manager-gate]').count()).toBe(0)
  team.openManagerSession = original
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 120_000)

it('projects manager-written Member and Project owner into the Sidebar and Project dialog', async () => {
  const { page, consoleWatch } = await openTeamPage()
  await page.locator('button[data-team-action="manager"]').click()
  await expect.poll(async () => (await currentSessionId(page))?.startsWith('agent-team-manager-') ?? false, { timeout: 30_000 }).toBe(true)
  const managerId = (await currentSessionId(page))!
  await page.locator(`[data-conversation-session="${managerId}"]`).waitFor({ timeout: 20_000 })
  const manager = scaffold!.ctx.agents.get(managerId as SessionId)
  expect(manager).toBeDefined()

  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const route = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const call = async (name: string, callId: string, args: Record<string, unknown>) => {
    const batch = await scaffold!.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(callId), name, arguments: JSON.stringify(args) }],
      agent: manager, signal: new AbortController().signal,
    })
    expect(batch.results).toHaveLength(1)
    expect(batch.results[0]!.result.isError).toBe(false)
    return batch.results[0]!.result.value as Record<string, unknown>
  }

  const memberValue = await call('member_create', 'manager-write-member', {
    workspaceId, handle: 'Iris', description: '长期负责评审与验收', model: route, requestId: 'manager-write-member-1',
  }) as { memberRef: string }
  const projectValue = await call('project_create', 'manager-write-project', {
    workspaceId, name: 'Parser v2', description: '把解析收敛到一个权威实现', memberIds: [memberValue.memberRef],
    requestId: 'manager-write-project-1',
  }) as { projectRef: string }
  const responsibility = '对解析器的交付节奏与评审结论负责'
  await call('project_owner', 'manager-write-owner', {
    action: 'add', workspaceId, projectRef: projectValue.projectRef, memberRef: memberValue.memberRef,
    responsibility, requestId: 'manager-write-owner-1',
  })

  await page.getByText('Iris', { exact: true }).first().waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: '# Parser v2', exact: true }).hover()
  await page.getByRole('button', { name: 'Parser v2 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑项目', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '编辑项目' })
  await editor.waitFor()
  const owners = editor.getByRole('group', { name: '负责人' })
  await owners.getByRole('button', { name: '移除负责人 @Iris' }).waitFor({ timeout: 20_000 })
  await owners.getByText(responsibility).waitFor()
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await settleAnimations(page)
  await settleLayout(page)
  await page.screenshot({ path: join(MANAGER_SHOTS, 'manager-writes-desktop.png'), fullPage: true, animations: 'disabled' })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('[data-sidebar-collapsed="true"]').waitFor()
  await openSidebar(page)
  await page.getByRole('button', { name: '# Parser v2', exact: true }).hover()
  await page.getByRole('button', { name: 'Parser v2 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑项目', exact: true }).click()
  const narrowEditor = page.getByRole('dialog', { name: '编辑项目' })
  await narrowEditor.waitFor()
  await narrowEditor.getByRole('group', { name: '负责人' }).getByText(responsibility).waitFor()
  await settleAnimations(page)
  await settleLayout(page)
  await page.screenshot({ path: join(MANAGER_SHOTS, 'manager-writes-mobile.png'), fullPage: true, animations: 'disabled' })
  await narrowEditor.getByRole('button', { name: '关闭', exact: true }).click()
  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 120_000)
