import { afterEach, it, expect } from 'vitest'
import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKER_INSPECT_SHOTS, chooseMemberModel, closeScenario, memberAgent, openSettings,
  openSidebar, openTeamPage, scaffold, scenarioTempDir, settleLayout, waitForMemberAgent, type Locator } from './__external-agent-team-support.ts'

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
      threadId = 'fake-thread-' + process.pid + '-' + 'native'.repeat(16) + '-' + counter
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

/** Check visible text against every clipping ancestor, including the Modal outside the Worker subtree. */
async function expectUnclippedReport(report: Locator): Promise<void> {
  const overflow = await report.evaluate(node => {
    if (!(node instanceof HTMLElement)) throw new Error('Worker report is not an HTML element')
    let left = 0
    let right = window.innerWidth
    for (let ancestor: HTMLElement | null = node; ancestor !== null; ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).overflowX === 'visible') continue
      const box = ancestor.getBoundingClientRect()
      left = Math.max(left, box.left + ancestor.clientLeft)
      right = Math.min(right, box.left + ancestor.clientLeft + ancestor.clientWidth)
    }
    const boxes = [node.getBoundingClientRect()]
    const text = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    while (text.nextNode() !== null) {
      const range = document.createRange()
      range.selectNodeContents(text.currentNode)
      boxes.push(...range.getClientRects())
    }
    return Math.max(0, ...boxes.map(box => Math.max(left - box.left, box.right - right)))
  })
  expect(overflow).toBeLessThanOrEqual(1)
}

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

it('reads a Worker diagnostic from its row and keeps the list to five rows', async () => {
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
  const directory = await scenarioTempDir('dsh-team-fake-codex-')
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

  /** Start one run; the scenario waits below where it depends on the ending. */
  const delegate = async (member: typeof runner, task: string): Promise<void> => {
    await team.workerStartForAgent(memberAgent(scaffold!, workspaceId, member.memberId), {
      requestId: `e2e-worker-inspect-${task}` as never, threadRef, task, cwd,
    }).then(() => undefined, (error: unknown) => error)
  }
  const waitForFailure = async (member: typeof runner, marker: string): Promise<void> => {
    await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: member.memberId }).runs
      .find(run => run.task.includes(marker))?.state, { timeout: 60_000 }).toBe('failed')
  }

  // The run that will fall out of the window ends first: it carries the turn's own
  // record, so its diagnostic is the fragment path. It is captured while it is still
  // the only run, because the window is what removes it later.
  await delegate(runner, '[REC] 最早结束、会掉出窗口的那条')
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs.length,
    { timeout: 60_000 }).toBe(1)
  // The ending is written by the engine's exit, so the row settles a moment after the start returns.
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs[0]?.state,
    { timeout: 60_000 }).toBe('failed')
  const outside = team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs[0]!
  expect(outside.state).toBe('failed')
  // Four more endings fill the window beside the live run below, so the run above
  // is no longer listed. The first of them carries a task long enough that the
  // one-line rule has to cut it.
  const longTask = '[FAIL] 填满窗口的第 1 条：这是一段足够长的任务描述，用来证明任务行只占一行、'
    + '超出的部分以省略号收尾，而全文留在 title 上，读者hover 就能读到。'
  for (let index = 0; index < 4; index += 1) {
    const marker = `[FAIL] 填满窗口的第 ${index + 1} 条`
    await delegate(runner, index === 0 ? longTask : marker)
    // Let each ending land before the next run changes which rows are in the window.
    await waitForFailure(runner, marker)
  }
  // One live run: it takes a seat in the window instead of being added on top.
  await delegate(runner, '[HOLD] 一直运行、占掉窗口一个座位的那条')
  // Another Member's run: it stays out of this Member's list.
  await delegate(other, '[FAIL] 另一个成员的执行')
  await waitForFailure(other, '[FAIL] 另一个成员的执行')

  // Five rows: the live run holds one seat, the newest four endings hold the rest.
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs.length,
    { timeout: 60_000 }).toBe(5)
  const runs = team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs
  const byTask = (needle: string) => runs.find(run => run.task.includes(needle))!
  const live = byTask('[HOLD]')
  const long = byTask('[FAIL] 填满窗口的第 1 条')
  const listed = byTask('[FAIL] 填满窗口的第 4 条')
  expect(live.state).toBe('running')
  expect(runs[0]!.workerRef).toBe(live.workerRef)
  expect(runs.some(run => run.workerRef === outside.workerRef)).toBe(false)
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: other.memberId }).runs.length,
    { timeout: 60_000 }).toBe(1)

  // The Human's surface: the row menu's edit dialog.
  const row = page.locator('[class*="agentRow"]').filter({ hasText: 'runner' }).first()
  await row.hover()
  await row.getByRole('button', { name: 'runner 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑 Agent' }).click()
  const editor = page.getByRole('dialog', { name: '编辑 Agent' })
  const workers = editor.locator('[data-team-member-workers]')
  await workers.waitFor({ timeout: 20_000 })
  const runRows = workers.locator('[data-worker-run]')
  await expect.poll(async () => await runRows.count(), { timeout: 30_000 }).toBe(5)
  // The list is a window: the oldest ending is not in it, and the live run is.
  expect(await workers.locator(`[data-worker-run="${outside.workerRef}"]`).count()).toBe(0)
  expect(await workers.locator(`[data-worker-run="${live.workerRef}"]`).count()).toBe(1)
  // The window says its own size beside the heading, in four characters.
  expect(await workers.getByText('最近 5 条', { exact: true }).count()).toBe(1)
  // The by-number door is gone: this surface never shows a number, so nothing asks for one.
  expect(await workers.locator('form').count()).toBe(0)
  expect(await workers.getByRole('textbox').count()).toBe(0)
  expect(await workers.locator('[data-worker-lookup]').count()).toBe(0)

  // One run reads in two lines: the task on one, its facts on the next. The task
  // line is the Host's bounded preview, cut to one line with the full text in title.
  const longRow = workers.locator(`[data-worker-run="${long.workerRef}"]`)
  const taskLine = longRow.locator('[data-worker-task]')
  expect(await taskLine.getAttribute('title')).toBe(long.task)
  const taskBox = (await taskLine.boundingBox())!
  expect(Math.round(taskBox.height)).toBe(20)
  // The line really is cut: its content is wider than the box it was given.
  expect(await taskLine.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(true)
  const factsBox = (await longRow.locator('[class*="workerRunFacts"]').boundingBox())!
  expect(Math.round(factsBox.height)).toBe(18)

  // A live run still has no native record to read, so its row carries the stop
  // alone: the door belongs to the rows that ended.
  const liveRow = workers.locator(`[data-worker-run="${live.workerRef}"]`)
  expect(await liveRow.getByRole('button', { name: /停止 Worker/ }).count()).toBe(1)
  expect(await liveRow.getByRole('button', { name: `查看诊断：${live.task}` }).count()).toBe(0)
  expect(await liveRow.locator('[class*="reminderActions"]').count()).toBe(1)

  // An ended run keeps its door, and its report is the Host's answer as it came.
  const listedRow = workers.locator(`[data-worker-run="${listed.workerRef}"]`)
  const door = listedRow.getByRole('button', { name: `查看诊断：${listed.task}` })
  // The accessible name, the visible word and the expanded state move together.
  expect(await door.getAttribute('aria-expanded')).toBe('false')
  expect(await door.textContent()).toBe('查看诊断')
  await door.click()
  const closing = listedRow.getByRole('button', { name: `收起诊断：${listed.task}` })
  await expect.poll(async () => await closing.getAttribute('aria-expanded')).toBe('true')
  expect(await closing.textContent()).toBe('收起诊断')
  const listedReport = listedRow.locator('[data-worker-report]')
  await expect.poll(async () => await listedReport.count()).toBe(1)
  await expect.poll(async () => await listedReport.textContent()).toContain('摘要:')

  // The report is the Host's answer as it came, and reading it never adds a row.
  await expect.poll(async () => await listedReport.textContent()).toContain('fake engine failed the turn')
  expect(await runRows.count()).toBe(5)

  await settleLayout(page)
  await listedReport.scrollIntoViewIfNeeded()
  await settleLayout(page)
  await expectUnclippedReport(listedReport)
  await page.screenshot({ path: join(WORKER_INSPECT_SHOTS, 'worker-inspect-desktop.png') })
  // The same control folds the report away.
  await closing.click()
  await expect.poll(async () => await listedRow.locator('[data-worker-report]').count()).toBe(0)
  expect(await listedRow.getByRole('button', { name: `查看诊断：${listed.task}` }).getAttribute('aria-expanded')).toBe('false')

  // 390×844: the rows stay inside the column, and the task line still takes one line.
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
  await settleLayout(page)
  // The card never widens past its column. The task line alone can scroll its own
  // clipped content — that is the ellipsis doing its job — so the measurement is the
  // boxes that hold it, not every scroller inside the section.
  expect(await narrowWorkers.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0)
  expect(await narrowEditor.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0)
  const narrowTask = narrowWorkers.locator(`[data-worker-run="${long.workerRef}"] [data-worker-task]`)
  expect(Math.round((await narrowTask.boundingBox())!.height)).toBe(20)
  // One control per row is what keeps every row two lines here: the live row's body
  // is exactly as tall as an ended row's, so its stop sits beside the facts line
  // instead of wrapping under it. The row boxes themselves differ by the first and
  // last row's padding and border, so the body is what the two have in common.
  const narrowLive = (await narrowWorkers.locator(`[data-worker-run="${live.workerRef}"] [class*="reminderBody"]`).boundingBox())!
  const narrowEnded = (await narrowWorkers.locator(`[data-worker-run="${long.workerRef}"] [class*="reminderBody"]`).boundingBox())!
  expect(Math.round(narrowLive.height)).toBe(Math.round(narrowEnded.height))
  await narrowTask.scrollIntoViewIfNeeded()
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_INSPECT_SHOTS, 'worker-inspect-narrow.png') })
  const narrowListed = narrowWorkers.locator(`[data-worker-run="${listed.workerRef}"]`)
  const narrowDoor = narrowListed.getByRole('button', { name: `查看诊断：${listed.task}` })
  await narrowDoor.focus()
  await narrowDoor.press('Enter')
  const narrowClosing = narrowListed.getByRole('button', { name: `收起诊断：${listed.task}` })
  await expect.poll(async () => await narrowClosing.getAttribute('aria-expanded')).toBe('true')
  expect(await narrowClosing.evaluate(node => node === document.activeElement)).toBe(true)
  const narrowReport = narrowListed.locator('[data-worker-report]')
  await expect.poll(async () => await narrowReport.textContent()).toContain('fake engine failed the turn')
  await narrowReport.scrollIntoViewIfNeeded()
  await settleLayout(page)
  await expectUnclippedReport(narrowReport)
  await page.screenshot({ path: join(WORKER_INSPECT_SHOTS, 'worker-inspect-diagnostic-narrow.png') })
  await narrowEditor.getByRole('button', { name: '关闭', exact: true }).click()
  await page.setViewportSize({ width: 1440, height: 960 })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 300_000)
