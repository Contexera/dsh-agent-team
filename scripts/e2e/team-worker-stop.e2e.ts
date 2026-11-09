import { afterEach, it, expect } from 'vitest'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKER_STOP_SHOTS, chooseMemberModel, closeScenario, maxHorizontalScroll, memberAgent, openSettings, openSidebar,
  openTeamPage, scaffold, settleLayout, waitForMemberAgent } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

const MASTER = '允许从成员会话派出 Worker'

/**
 * A stand-in for the Codex CLI, reached through the production setting the
 * operator would fill in. It answers the app-server handshake and then holds the
 * turn open, so a run stays live until the Host stops it — which is the state
 * this scenario needs two of.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--help')) { process.stdout.write('codex app-server\\n'); process.exit(0) }
if (args.includes('--version')) { process.stdout.write('codex-cli 0.0.0-fake\\n'); process.exit(0) }
const write = (value) => { process.stdout.write(JSON.stringify(value) + '\\n') }
let thread = 0
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim() === '') continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message.id === undefined) continue
    if (message.method === 'initialize') write({ id: message.id, result: { userAgent: 'fake-codex' } })
    else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      thread += 1
      write({ id: message.id, result: { thread: { id: 'fake-thread-' + process.pid + '-' + thread } } })
    } else if (message.method === 'turn/start') {
      write({ id: message.id, result: { turn: { id: 'fake-turn-' + process.pid + '-' + thread } } })
    } else write({ id: message.id, result: {} })
  }
})
const stop = () => { process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`

it('stops one of two live Worker runs from the edit-Agent dialog and leaves the other running', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id

  await page.getByRole('button', { name: '添加 Agent' }).click()
  const createAgent = page.getByRole('dialog', { name: '添加 Agent' })
  await createAgent.getByLabel('名称').fill('runner')
  await createAgent.getByLabel('说明').fill('同时跑两个 Worker 的执行者')
  await chooseMemberModel(page, createAgent)
  await createAgent.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText('runner', { exact: true }).waitFor({ timeout: 20_000 })

  const created = await team.createProject({ requestId: 'e2e-worker-stop-project' as never, workspaceId,
    name: 'worker-stop', description: '只停指定的一次执行' })
  const projectRef = created.project.projectRef
  const runner = team.members({ workspaceId }).find(status => status.member.handle === 'runner')!.member
  await team.addProjectOwner({ requestId: 'e2e-worker-stop-owner' as never, workspaceId, projectRef, memberId: runner.memberId })
  const discussion = await team.startThread({ requestId: 'e2e-worker-stop-thread' as never, workspaceId, projectRef,
    kind: 'discussion', body: '**STOPONE** 两条并行 Worker 只停一条' })
  const threadRef = discussion.thread.threadRef

  // The fake engine is installed where an operator would point the setting.
  const directory = await mkdtemp(join(tmpdir(), 'dsh-team-fake-codex-'))
  const fakeCodex = join(directory, 'codex')
  await writeFile(fakeCodex, FAKE_CODEX, 'utf8')
  await chmod(fakeCodex, 0o755)

  await openSettings(page)
  const panel = page.getByRole('dialog')
  await panel.getByRole('button', { name: '团队', exact: true }).click()
  const group = panel.locator('[data-worker-settings]')
  await group.waitFor()
  await group.getByRole('button', { name: /Worker 委派/ }).click()
  await group.getByRole('switch', { name: MASTER }).click()
  const codex = group.locator('[data-worker-engine="codex"]')
  const codexSwitch = codex.getByRole('switch')
  await expect.poll(async () => await codexSwitch.isDisabled()).toBe(false)
  await codexSwitch.click()
  await expect.poll(async () => await codexSwitch.getAttribute('aria-checked')).toBe('true')
  await codex.getByLabel('Codex 的可执行路径').fill(fakeCodex)
  const save = group.getByRole('button', { name: '保存' })
  await save.click()
  await expect.poll(async () => await save.isDisabled(), { timeout: 20_000 }).toBe(true)
  await panel.getByRole('button', { name: '关闭', exact: true }).click()
  expect(team.config.worker.get().engines.codex).toMatchObject({ enabled: true, executable: fakeCodex })

  // Two delegations through the production start path, both bound to one Thread.
  // The Host confirms the Agent belongs to the Member before any Member-scoped call.
  await waitForMemberAgent(scaffold!, workspaceId, runner.memberId)
  const cwd = scaffold!.ctx.workspaceRegistry.list()[0]!.path
  const first = await team.workerStartForAgent(memberAgent(scaffold!, workspaceId, runner.memberId), { requestId: 'e2e-worker-stop-a' as never, threadRef,
    task: '把第一条讨论收尾', cwd })
  const second = await team.workerStartForAgent(memberAgent(scaffold!, workspaceId, runner.memberId), { requestId: 'e2e-worker-stop-b' as never, threadRef,
    task: '把第二条讨论收尾', cwd })
  expect(first.workerRef).not.toBe(second.workerRef)
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs.length,
    { timeout: 30_000 }).toBe(2)

  // The Human's surface: the row menu's edit dialog lists both live runs.
  const row = page.locator('[class*="agentRow"]').filter({ hasText: 'runner' }).first()
  await row.hover()
  await row.getByRole('button', { name: 'runner 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑 Agent' }).click()
  const editor = page.getByRole('dialog', { name: '编辑 Agent' })
  const workers = editor.locator('[data-team-member-workers]')
  await workers.waitFor({ timeout: 20_000 })
  const runRows = workers.locator('[data-worker-run]')
  await expect.poll(async () => await runRows.count(), { timeout: 20_000 }).toBe(2)
  await expect.poll(async () => await workers.textContent()).toContain('把第一条讨论收尾')
  await expect.poll(async () => await workers.textContent()).toContain('把第二条讨论收尾')

  // Keyboard reach: the stop control takes focus and shows its ring before it is pressed.
  const stopFirst = workers.locator(`[data-worker-run="${first.workerRef}"]`).getByRole('button', { name: /停止 Worker/ })
  await stopFirst.focus()
  expect(await stopFirst.evaluate(node => node === document.activeElement)).toBe(true)
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_STOP_SHOTS, 'worker-stop-dialog.png') })

  await stopFirst.click()
  // The row reports the stop in flight, then the ending the Host confirmed.
  await expect.poll(async () => await workers.locator(`[data-worker-run="${first.workerRef}"]`).getAttribute('data-worker-state'),
    { timeout: 30_000 }).toBe('stopped')
  const stoppedRow = workers.locator(`[data-worker-run="${first.workerRef}"]`)
  await expect.poll(async () => await stoppedRow.textContent()).toContain('已停止')
  expect(await stoppedRow.getByRole('button', { name: /停止 Worker/ }).count()).toBe(0)
  // The sibling is untouched: still live, still stoppable, still listed.
  const liveRow = workers.locator(`[data-worker-run="${second.workerRef}"]`)
  expect(await liveRow.getAttribute('data-worker-state')).toBe('running')
  expect(await liveRow.textContent()).toContain('运行中')
  expect(await liveRow.getByRole('button', { name: /停止 Worker/ }).count()).toBe(1)
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_STOP_SHOTS, 'worker-stop-one-of-two.png') })

  // The Host's own record agrees: one ending, one live run, and the Thread carries one terminal fact.
  const runs = team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs
  expect(runs.map(view => view.workerRef)).toEqual([second.workerRef])
  const read = await team.readThreadForAgent(memberAgent(scaffold!, workspaceId, runner.memberId),
    { requestId: 'e2e-worker-stop-read' as never, workspaceId, threadRef })
  expect(read.workerStates?.map(state => state.state).sort()).toEqual(['running', 'stopped'])
  const settled = read.facts.map(entry => entry.fact)
    .filter(fact => fact.kind === 'activity' && fact.activity.kind === 'worker_settled')
  expect(settled).toHaveLength(1)

  await editor.getByRole('button', { name: '关闭', exact: true }).click()

  // 390×844: the list and its controls stay inside the dialog column.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  // The narrow layout collapses the sidebar behind its opener; the row lives there.
  await openSidebar(page)
  await settleLayout(page)
  await row.hover()
  await row.getByRole('button', { name: 'runner 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑 Agent' }).click()
  const narrowEditor = page.getByRole('dialog', { name: '编辑 Agent' })
  await narrowEditor.locator('[data-team-member-workers]').waitFor({ timeout: 20_000 })
  expect(await maxHorizontalScroll(page, '[data-team-member-workers]')).toBe(0)
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_STOP_SHOTS, 'worker-stop-narrow.png') })
  await narrowEditor.getByRole('button', { name: '关闭', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 960 })

  // Leaving Team mode restores an ordinary conversation over the same page.
  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe(null)
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 20_000 })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 300_000)
