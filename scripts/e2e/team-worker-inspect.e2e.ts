import { afterEach, it, expect } from 'vitest'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKER_INSPECT_SHOTS, chooseMemberModel, closeScenario, maxHorizontalScroll, memberAgent, openSettings,
  openSidebar, openTeamPage, scaffold, settleLayout, waitForMemberAgent } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

const MASTER = '允许从成员会话派出 Worker'

/**
 * A stand-in for the Codex CLI that speaks the app-server handshake and answers
 * the two requests the Host anchors a run by. The task text picks the ending:
 * `[HOLD]` keeps the turn open so the run stays live, anything else writes the
 * turn's own record and exits non-zero, which is the failed ending this surface
 * reads. The record is written where the reader looks — an absolute `.jsonl`
 * under a `sessions` directory, headed by the session the Host recorded.
 */
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const args = process.argv.slice(2)
if (args.includes('--help')) { process.stdout.write('codex app-server\\n'); process.exit(0) }
if (args.includes('--version')) { process.stdout.write('codex-cli 0.0.0-fake\\n'); process.exit(0) }
const write = (value) => { process.stdout.write(JSON.stringify(value) + '\\n') }
const root = path.join(os.tmpdir(), 'dsh-worker-inspect-e2e', 'sessions')
fs.mkdirSync(root, { recursive: true })
let counter = 0
let threadId
let location
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
      counter += 1
      threadId = 'fake-thread-' + process.pid + '-' + counter
      location = path.join(root, threadId + '.jsonl')
      fs.writeFileSync(location, JSON.stringify({ type: 'session_meta',
        payload: { session_id: threadId, cli_version: '0.0.0-fake', originator: 'e2e' } }) + '\\n')
      write({ id: message.id, result: { thread: { id: threadId, path: location } } })
    } else if (message.method === 'turn/start') {
      const turnId = 'fake-turn-' + process.pid + '-' + counter
      write({ id: message.id, result: { turn: { id: turnId } } })
      // The engine reports the turn it started; that notification is what gives the
      // run a turn span the Host can anchor its diagnostic to.
      write({ method: 'turn/started', params: { threadId, turnId } })
      if (line.includes('HOLD')) continue
      // Let the engine's own turn span reach the record stream before the exit, so
      // the ending carries the turn this run owned rather than only its session.
      setTimeout(() => {
        fs.appendFileSync(location, [
          JSON.stringify({ type: 'turn_context',
            payload: { turn_id: turnId, model: 'fake-model', approval_policy: 'never', sandbox_policy: { type: 'read-only' } } }),
          JSON.stringify({ type: 'event_msg',
            payload: { turn_id: turnId, type: 'task_complete', duration_ms: 12, error: { message: 'fake engine failed the turn' } } }),
        ].join('\\n') + '\\n')
        process.exit(1)
      }, 250)
    } else write({ id: message.id, result: {} })
  }
})
const stop = () => { process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
`

/** Create one Agent through the Human's own dialog, so the Host holds a live handle for it. */
async function createAgent(page: Awaited<ReturnType<typeof openTeamPage>>['page'], name: string, description: string): Promise<void> {
  await page.getByRole('button', { name: '添加 Agent' }).click()
  const dialog = page.getByRole('dialog', { name: '添加 Agent' })
  await dialog.getByLabel('名称').fill(name)
  await dialog.getByLabel('说明').fill(description)
  await chooseMemberModel(page, dialog)
  await dialog.getByRole('button', { name: '创建 Agent' }).click()
  await page.getByText(name, { exact: true }).waitFor({ timeout: 20_000 })
}

it('reads a Worker diagnostic by number, folds it by name, and keeps both doors inside the dialog', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const cwd = scaffold!.ctx.workspaceRegistry.list()[0]!.path

  await createAgent(page, 'runner', '按编号查诊断的执行者')
  await createAgent(page, 'other', '另一个执行者，它的编号不该被 runner 读到')

  const created = await team.createProject({ requestId: 'e2e-worker-inspect-project' as never, workspaceId,
    name: 'worker-inspect', description: '按执行编号只读查看诊断' })
  const projectRef = created.project.projectRef
  const runner = team.members({ workspaceId }).find(status => status.member.handle === 'runner')!.member
  const other = team.members({ workspaceId }).find(status => status.member.handle === 'other')!.member
  for (const member of [runner, other]) {
    await team.addProjectOwner({ requestId: `e2e-worker-inspect-owner-${member.handle}` as never, workspaceId, projectRef,
      memberId: member.memberId })
  }
  const discussion = await team.startThread({ requestId: 'e2e-worker-inspect-thread' as never, workspaceId, projectRef,
    kind: 'discussion', body: '**INSPECT** 按编号查看失败的 Worker' })
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

  await waitForMemberAgent(scaffold!, workspaceId, runner.memberId)
  await waitForMemberAgent(scaffold!, workspaceId, other.memberId)

  /** Start one run and let its ending settle; a failed start is the expected ending here. */
  const delegate = async (member: typeof runner, task: string): Promise<void> => {
    await team.workerStartForAgent(memberAgent(scaffold!, workspaceId, member.memberId), {
      requestId: `e2e-worker-inspect-${task}` as never, threadRef, task, cwd,
    }).then(() => undefined, (error: unknown) => error)
  }

  // The run that will fall out of the window ends first: it carries the turn's own
  // record, so reading it by number is also the fragment path. Its number is taken
  // while it is still the only run, because the window is what removes it later.
  await delegate(runner, '[REC] 最早结束、会掉出窗口的那条')
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs.length,
    { timeout: 60_000 }).toBe(1)
  // The ending is written by the engine's exit, so the row settles a moment after the start returns.
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs[0]?.state,
    { timeout: 60_000 }).toBe('failed')
  const outside = team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs[0]!
  expect(outside.state).toBe('failed')
  // Twenty more endings fill the window, so the run above is no longer listed.
  for (let index = 0; index < 20; index += 1) await delegate(runner, `[FAIL] 填满窗口的第 ${index + 1} 条`)
  // One live run: the only row that carries both a stop control and a diagnostic door.
  await delegate(runner, '[HOLD] 一直运行、用来验两个尾随按钮的那条')
  // Another Member's run: its number is the one this Member may not read.
  await delegate(other, '[FAIL] 另一个成员的执行')

  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs.length,
    { timeout: 60_000 }).toBe(21)
  const runs = team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs
  const byTask = (needle: string) => runs.find(run => run.task.includes(needle))!
  const live = byTask('[HOLD]')
  const listed = byTask('[FAIL] 填满窗口的第 20 条')
  expect(live.state).toBe('running')
  expect(runs.some(run => run.workerRef === outside.workerRef)).toBe(false)
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: other.memberId }).runs.length,
    { timeout: 60_000 }).toBe(1)
  const otherRuns = team.workerRunsForClient({ workspaceId, memberId: other.memberId }).runs
  const foreign = otherRuns[0]!

  // The Human's surface: the row menu's edit dialog.
  const row = page.locator('[class*="agentRow"]').filter({ hasText: 'runner' }).first()
  await row.hover()
  await row.getByRole('button', { name: 'runner 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑 Agent' }).click()
  const editor = page.getByRole('dialog', { name: '编辑 Agent' })
  const workers = editor.locator('[data-team-member-workers]')
  await workers.waitFor({ timeout: 20_000 })
  const runRows = workers.locator('[data-worker-run]')
  await expect.poll(async () => await runRows.count(), { timeout: 30_000 }).toBe(21)
  // The list is a window: the oldest ending is not in it, and the live run is.
  expect(await workers.locator(`[data-worker-run="${outside.workerRef}"]`).count()).toBe(0)
  expect(await workers.locator(`[data-worker-run="${live.workerRef}"]`).count()).toBe(1)

  // One live row carries both trailing controls, and they sit beside each other.
  const liveRow = workers.locator(`[data-worker-run="${live.workerRef}"]`)
  const stopButton = liveRow.getByRole('button', { name: /停止 Worker/ })
  const doorButton = liveRow.getByRole('button', { name: `查看诊断：${live.task}` })
  const stopBox = (await stopButton.boundingBox())!
  const doorBox = (await doorButton.boundingBox())!
  expect(Math.round(doorBox.x - (stopBox.x + stopBox.width))).toBe(4)
  expect(await liveRow.locator('[class*="reminderActions"]').count()).toBe(1)

  // The accessible name, the visible word and the expanded state move together.
  expect(await doorButton.getAttribute('aria-expanded')).toBe('false')
  expect(await doorButton.textContent()).toBe('查看诊断')
  await doorButton.click()
  const closing = liveRow.getByRole('button', { name: `收起诊断：${live.task}` })
  await expect.poll(async () => await closing.getAttribute('aria-expanded')).toBe('true')
  expect(await closing.textContent()).toBe('收起诊断')
  await expect.poll(async () => await liveRow.locator('[data-worker-report]').count()).toBe(1)
  // The one place a screenshot carries what an assertion cannot: the two trailing
  // controls sit beside each other instead of splitting the row's free space.
  await liveRow.scrollIntoViewIfNeeded()
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_INSPECT_SHOTS, 'worker-inspect-actions.png') })
  await closing.click()
  await expect.poll(async () => await liveRow.locator('[data-worker-report]').count()).toBe(0)
  expect(await liveRow.getByRole('button', { name: `查看诊断：${live.task}` }).getAttribute('aria-expanded')).toBe('false')

  // An ended run keeps its door, and its report is the Host's answer as it came.
  const listedRow = workers.locator(`[data-worker-run="${listed.workerRef}"]`)
  await listedRow.getByRole('button', { name: `查看诊断：${listed.task}` }).click()
  const listedReport = listedRow.locator('[data-worker-report]')
  await expect.poll(async () => await listedReport.count()).toBe(1)
  await expect.poll(async () => await listedReport.textContent()).toContain('摘要:')

  // The by-number door: the run that fell out of the window is read from the form,
  // not inserted into the list, and the answer is announced as a status.
  const lookup = workers.locator('[data-worker-lookup]')
  const input = workers.getByLabel('Worker 编号')
  const submit = workers.getByRole('button', { name: '按编号查询 Worker 诊断' })
  expect(await submit.isDisabled()).toBe(true)
  await input.fill(outside.workerRef)
  await expect.poll(async () => await submit.isDisabled()).toBe(false)
  await input.press('Enter')
  await expect.poll(async () => await lookup.count(), { timeout: 20_000 }).toBe(1)
  const outsideReport = workers.locator(`[data-worker-lookup="${outside.workerRef}"]`)
  await expect.poll(async () => await outsideReport.count()).toBe(1)
  await expect.poll(async () => await outsideReport.locator('[role="status"]').textContent(),
    { timeout: 20_000 }).toContain(`编号：${outside.workerRef}`)
  await expect.poll(async () => await outsideReport.textContent()).toContain('摘要:')
  await expect.poll(async () => await outsideReport.textContent()).toContain('fake engine failed the turn')
  // Reading by number never inserts the run into the window.
  expect(await runRows.count()).toBe(21)

  await settleLayout(page)
  await outsideReport.scrollIntoViewIfNeeded()
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_INSPECT_SHOTS, 'worker-inspect-desktop.png') })

  // Another Member's number is refused where the form is, as an alert.
  await input.fill(foreign.workerRef)
  await input.press('Enter')
  await expect.poll(async () => await workers.locator('[role="alert"]').first().textContent(),
    { timeout: 20_000 }).toContain('诊断读取失败：')
  // A number that names nothing is refused the same way.
  await input.fill('worker:nothing-here')
  await input.press('Enter')
  await expect.poll(async () => await workers.locator(`[data-worker-lookup="worker:nothing-here"]`).count(),
    { timeout: 20_000 }).toBe(1)
  await expect.poll(async () => await workers.locator('[role="alert"]').first().textContent()).toContain('诊断读取失败：')

  // 390×844: the form wraps and the card never widens past its column.
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  await openSidebar(page)
  await settleLayout(page)
  await row.hover()
  await row.getByRole('button', { name: 'runner 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑 Agent' }).click()
  const narrowEditor = page.getByRole('dialog', { name: '编辑 Agent' })
  const narrowWorkers = narrowEditor.locator('[data-team-member-workers]')
  await narrowWorkers.waitFor({ timeout: 20_000 })
  await narrowWorkers.getByLabel('Worker 编号').fill(outside.workerRef)
  await narrowWorkers.getByLabel('Worker 编号').press('Enter')
  await expect.poll(async () => await narrowWorkers.locator(`[data-worker-lookup="${outside.workerRef}"]`).count(),
    { timeout: 20_000 }).toBe(1)
  await settleLayout(page)
  expect(await maxHorizontalScroll(page, '[data-team-member-workers]')).toBe(0)
  await narrowWorkers.locator(`[data-worker-lookup="${outside.workerRef}"]`).scrollIntoViewIfNeeded()
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_INSPECT_SHOTS, 'worker-inspect-narrow.png') })
  await narrowEditor.getByRole('button', { name: '关闭', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 960 })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 300_000)
