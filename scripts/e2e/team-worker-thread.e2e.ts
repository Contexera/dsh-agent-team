import { afterEach, it, expect } from 'vitest'
import { join } from 'node:path'
import { WORKER_SHOTS, acknowledgeReloadConnectionLoss, chooseMemberModel, closeScenario, maxHorizontalScroll, memberAgent,
  openSettings, openTeamPage, scaffold, settleLayout, waitForMemberAgent } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

/** An executable that cannot exist: the run still writes its start and its terminal fact before it fails. */
const MISSING_CODEX = '/nonexistent/worker-lane/codex'
const MASTER = '允许从成员会话派出 Worker'

it('leaves a delegated Worker run in its own Thread', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id

  // A real Agent Member: the UI's own activation keeps a live handle, so the Host matches the caller by identity.
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
  // Only a current owner of the target Project may delegate into it.
  await team.addProjectOwner({ requestId: 'e2e-worker-owner' as never, workspaceId, projectRef, memberId: runner.memberId })
  const discussion = await team.startThread({ requestId: 'e2e-worker-discussion' as never, workspaceId, projectRef,
    kind: 'discussion', body: '**TASKFREE** 一条不提升成 Task 的讨论' })
  const discussionRef = discussion.thread.threadRef
  const taskful = await team.startThread({ requestId: 'e2e-worker-taskful' as never, workspaceId, projectRef,
    kind: 'discussion', body: '**TASKFUL** 一条会提升成 Task 的讨论' })
  const taskfulRef = taskful.thread.threadRef
  // A Member-scoped read needs the Host to have registered this Agent for the
  // Member: the name and a non-null Agent appear before that attach completes.
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
  // Pin the row before delegating: a save that never reached it refuses before any fact, which reads like a lane bug.
  const workerRow = team.config.worker.get()
  expect(workerRow.enabled).toBe(true)
  expect(workerRow.engines.codex).toMatchObject({ enabled: true, executable: MISSING_CODEX })

  // One delegation into a discussion, one into a Task's Thread; both report the failure they hit.
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
    // A Thread read consumes the batch's markers, so reading it first would prove the read rather than the wake.
    const inbox = team.inboxForAgent(memberAgent(scaffold!, workspaceId, runner.memberId), { workspaceId })
    const row = inbox.items.find(item => item.thread.threadRef === delegation.threadRef)
    expect(row).toBeDefined()
    expect(row!.directCount).toBeGreaterThanOrEqual(1)
    const read = await team.readThreadForAgent(memberAgent(scaffold!, workspaceId, runner.memberId),
      { requestId: `e2e-worker-read-${delegation.threadRef}` as never, workspaceId, threadRef: delegation.threadRef })
    // The initiator's own read carries the durable state, not its own start row: that fact is unmarked and self-authored.
    // The surface holding both rows is the Thread a follower reads, opened in the browser below.
    expect(read.workerStates).toHaveLength(1)
    expect(read.workerStates?.[0]).toMatchObject({ state: 'failed', unconfirmed: false })
    const settled = read.facts.map(entry => entry.fact)
      .find(fact => fact.kind === 'activity' && fact.activity.kind === 'worker_settled')
    expect(settled?.kind).toBe('activity')
    if (settled?.kind === 'activity' && settled.activity.kind === 'worker_settled') {
      expect(settled.activity.state).toBe('failed')
      // The reason is the provider's bounded safe diagnostic; the answer never enters the Thread.
      expect(settled.activity.reason).toBeTruthy()
    }
  }

  const warningStart = consoleWatch.warnings.length
  await page.reload()
  await settleLayout(page)
  acknowledgeReloadConnectionLoss(consoleWatch, warningStart)
  // A reload keeps the Team face: the mode flag is set only while this page owns it.
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe('team')
  const openInbox = async (): Promise<void> => {
    // By name: the rail collapses on its own and this entry keeps its name in both states.
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

  // 390×844: the sentences wrap inside the column instead of widening the page.
  await page.setViewportSize({ width: 390, height: 844 })
  await settleLayout(page)
  expect(await maxHorizontalScroll(page, `main[data-team-thread="${taskfulRef}"]`)).toBe(0)
  await page.screenshot({ path: join(WORKER_SHOTS, 'worker-thread-task-narrow.png') })
  await page.setViewportSize({ width: 1440, height: 960 })

  // A discussion without a Task is a face of its Project and carries the same two rows.
  await openInbox()
  await openRow('TASKFREE')
  const discussionPanel = page.locator(`[data-team-panel="${discussionRef}"]`)
  await discussionPanel.waitFor({ timeout: 20_000 })
  await expect.poll(async () => await discussionPanel.textContent()).toContain('runner 派出了 Codex Worker')
  await expect.poll(async () => await discussionPanel.textContent()).toContain('失败：')
  // The answer never reaches the Thread, and a run ref never leaks as raw text.
  expect(await discussionPanel.textContent()).not.toContain('worker:')
  await settleLayout(page)
  await page.screenshot({ path: join(WORKER_SHOTS, 'worker-thread-discussion.png') })

  // Leaving Team mode restores an ordinary conversation.
  await page.getByRole('button', { name: '对话', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe(null)
  await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 20_000 })

  expect(consoleWatch).toEqual({ warnings: [], pageErrors: [] })
}, 300_000)
