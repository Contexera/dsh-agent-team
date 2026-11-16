import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  WORKER_INSPECT_SHOTS,
  WORKER_STOP_SHOTS,
  chooseMemberModel,
  closeScenario,
  installFakeCodex,
  maxHorizontalScroll,
  memberAgent,
  openSidebar,
  openTeamPage,
  scaffold,
  settleLayout,
  waitForMemberAgent,
  type Locator,
} from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

const FAKE_CODEX_INSPECT = `#!/usr/bin/env node
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
      write({ method: 'turn/started', params: { threadId, turnId } })
      if (line.includes('HOLD')) continue
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

const FAKE_CODEX_STOP = `#!/usr/bin/env node
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

  await installFakeCodex(page, team, FAKE_CODEX_INSPECT)

  await waitForMemberAgent(scaffold!, workspaceId, runner.memberId)
  await waitForMemberAgent(scaffold!, workspaceId, other.memberId)

  const delegate = async (member: typeof runner, task: string): Promise<void> => {
    await team.workerStartForAgent(memberAgent(scaffold!, workspaceId, member.memberId), {
      requestId: `e2e-worker-inspect-${task}` as never, threadRef, task, cwd,
    }).then(() => undefined, (error: unknown) => error)
  }
  const waitForFailure = async (member: typeof runner, marker: string): Promise<void> => {
    await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: member.memberId }).runs
      .find(run => run.task.includes(marker))?.state, { timeout: 60_000 }).toBe('failed')
  }

  await delegate(runner, '[REC] 最早结束、会掉出窗口的那条')
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs.length,
    { timeout: 60_000 }).toBe(1)
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs[0]?.state,
    { timeout: 60_000 }).toBe('failed')
  const outside = team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs[0]!
  expect(outside.state).toBe('failed')
  const longTask = '[FAIL] 填满窗口的第 1 条：这是一段足够长的任务描述，用来证明任务行只占一行、'
    + '超出的部分以省略号收尾，而全文留在 title 上，读者hover 就能读到。'
  for (let index = 0; index < 4; index += 1) {
    const marker = `[FAIL] 填满窗口的第 ${index + 1} 条`
    await delegate(runner, index === 0 ? longTask : marker)
    await waitForFailure(runner, marker)
  }
  await delegate(runner, '[HOLD] 一直运行、占掉窗口一个座位的那条')
  await delegate(other, '[FAIL] 另一个成员的执行')
  await waitForFailure(other, '[FAIL] 另一个成员的执行')

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

  const row = page.locator('[class*="agentRow"]').filter({ hasText: 'runner' }).first()
  await row.hover()
  await row.getByRole('button', { name: 'runner 的操作' }).click()
  await page.getByRole('menuitem', { name: '编辑 Agent' }).click()
  const editor = page.getByRole('dialog', { name: '编辑 Agent' })
  const workers = editor.locator('[data-team-member-workers]')
  await workers.waitFor({ timeout: 20_000 })
  const runRows = workers.locator('[data-worker-run]')
  await expect.poll(async () => await runRows.count(), { timeout: 30_000 }).toBe(5)
  expect(await workers.locator(`[data-worker-run="${outside.workerRef}"]`).count()).toBe(0)
  expect(await workers.locator(`[data-worker-run="${live.workerRef}"]`).count()).toBe(1)
  expect(await workers.getByText('最近 5 条', { exact: true }).count()).toBe(1)
  expect(await workers.locator('form').count()).toBe(0)
  expect(await workers.getByRole('textbox').count()).toBe(0)
  expect(await workers.locator('[data-worker-lookup]').count()).toBe(0)

  const longRow = workers.locator(`[data-worker-run="${long.workerRef}"]`)
  const taskLine = longRow.locator('[data-worker-task]')
  expect(await taskLine.getAttribute('title')).toBe(long.task)
  const taskBox = (await taskLine.boundingBox())!
  expect(Math.round(taskBox.height)).toBe(20)
  expect(await taskLine.evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(true)
  const factsBox = (await longRow.locator('[class*="workerRunFacts"]').boundingBox())!
  expect(Math.round(factsBox.height)).toBe(18)

  const liveRow = workers.locator(`[data-worker-run="${live.workerRef}"]`)
  expect(await liveRow.getByRole('button', { name: /停止 Worker/ }).count()).toBe(1)
  expect(await liveRow.getByRole('button', { name: `查看诊断：${live.task}` }).count()).toBe(0)
  expect(await liveRow.locator('[class*="reminderActions"]').count()).toBe(1)

  const listedRow = workers.locator(`[data-worker-run="${listed.workerRef}"]`)
  const door = listedRow.getByRole('button', { name: `查看诊断：${listed.task}` })
  expect(await door.getAttribute('aria-expanded')).toBe('false')
  expect(await door.textContent()).toBe('查看诊断')
  await door.click()
  const closing = listedRow.getByRole('button', { name: `收起诊断：${listed.task}` })
  await expect.poll(async () => await closing.getAttribute('aria-expanded')).toBe('true')
  expect(await closing.textContent()).toBe('收起诊断')
  const listedReport = listedRow.locator('[data-worker-report]')
  await expect.poll(async () => await listedReport.count()).toBe(1)
  await expect.poll(async () => await listedReport.textContent()).toContain('摘要:')
  await expect.poll(async () => await listedReport.textContent()).toContain('fake engine failed the turn')
  expect(await runRows.count()).toBe(5)

  await settleLayout(page)
  await listedReport.scrollIntoViewIfNeeded()
  await settleLayout(page)
  await expectUnclippedReport(listedReport)
  await page.screenshot({ path: join(WORKER_INSPECT_SHOTS, 'worker-inspect-desktop.png') })
  await closing.click()
  await expect.poll(async () => await listedRow.locator('[data-worker-report]').count()).toBe(0)
  expect(await listedRow.getByRole('button', { name: `查看诊断：${listed.task}` }).getAttribute('aria-expanded')).toBe('false')

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
  expect(await narrowWorkers.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0)
  expect(await narrowEditor.evaluate(node => node.scrollWidth - node.clientWidth)).toBe(0)
  const narrowTask = narrowWorkers.locator(`[data-worker-run="${long.workerRef}"] [data-worker-task]`)
  expect(Math.round((await narrowTask.boundingBox())!.height)).toBe(20)
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

it('stops one of two live Worker runs from the edit-Agent dialog and leaves the other running', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id

  await createAgent(page, 'runner', '同时跑两个 Worker 的执行者')

  const created = await team.createProject({ requestId: 'e2e-worker-stop-project' as never, workspaceId,
    name: 'worker-stop', description: '只停指定的一次执行' })
  const projectRef = created.project.projectRef
  const runner = team.members({ workspaceId }).find(status => status.member.handle === 'runner')!.member
  await team.addProjectOwner({ requestId: 'e2e-worker-stop-owner' as never, workspaceId, projectRef, memberId: runner.memberId })
  const discussion = await team.startThread({ requestId: 'e2e-worker-stop-thread' as never, workspaceId, projectRef,
    kind: 'discussion', body: '**STOPONE** 两条并行 Worker 只停一条' })
  const threadRef = discussion.thread.threadRef

  await installFakeCodex(page, team, FAKE_CODEX_STOP)

  await waitForMemberAgent(scaffold!, workspaceId, runner.memberId)
  const cwd = scaffold!.ctx.workspaceRegistry.list()[0]!.path
  const first = await team.workerStartForAgent(memberAgent(scaffold!, workspaceId, runner.memberId), { requestId: 'e2e-worker-stop-a' as never, threadRef,
    task: '把第一条讨论收尾', cwd })
  const second = await team.workerStartForAgent(memberAgent(scaffold!, workspaceId, runner.memberId), { requestId: 'e2e-worker-stop-b' as never, threadRef,
    task: '把第二条讨论收尾', cwd })
  expect(first.workerRef).not.toBe(second.workerRef)
  await expect.poll(() => team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs.length,
    { timeout: 30_000 }).toBe(2)

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

  const stopFirst = workers.locator(`[data-worker-run="${first.workerRef}"]`).getByRole('button', { name: /停止 Worker/ })
  await stopFirst.focus()
  expect(await stopFirst.evaluate(node => node === document.activeElement)).toBe(true)
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_STOP_SHOTS, 'worker-stop-dialog.png') })

  await stopFirst.click()
  await expect.poll(async () => await workers.locator(`[data-worker-run="${first.workerRef}"]`).getAttribute('data-worker-state'),
    { timeout: 30_000 }).toBe('stopped')
  const stoppedRow = workers.locator(`[data-worker-run="${first.workerRef}"]`)
  await expect.poll(async () => await stoppedRow.textContent()).toContain('已停止')
  expect(await stoppedRow.getByRole('button', { name: /停止 Worker/ }).count()).toBe(0)
  const liveRow = workers.locator(`[data-worker-run="${second.workerRef}"]`)
  expect(await liveRow.getAttribute('data-worker-state')).toBe('running')
  expect(await liveRow.textContent()).toContain('运行中')
  expect(await liveRow.getByRole('button', { name: /停止 Worker/ }).count()).toBe(1)
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_STOP_SHOTS, 'worker-stop-one-of-two.png') })

  const runs = team.workerRunsForClient({ workspaceId, memberId: runner.memberId }).runs
  expect(runs.map(view => [view.workerRef, view.state]))
    .toEqual([[second.workerRef, 'running'], [first.workerRef, 'stopped']])
  const read = await team.readThreadForAgent(memberAgent(scaffold!, workspaceId, runner.memberId),
    { requestId: 'e2e-worker-stop-read' as never, workspaceId, threadRef })
  expect(read.workerStates?.map(state => state.state).sort()).toEqual(['running', 'stopped'])
  const settled = read.facts.map(entry => entry.fact)
    .filter(fact => fact.kind === 'activity' && fact.activity.kind === 'worker_settled')
  expect(settled).toHaveLength(1)

  await editor.getByRole('button', { name: '关闭', exact: true }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
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

  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe(null)
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 20_000 })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 300_000)
