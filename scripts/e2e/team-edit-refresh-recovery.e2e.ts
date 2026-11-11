import { afterEach, expect, it } from 'vitest'
import { chooseMemberModel, closeScenario, openTeamPage, scaffold } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

it('keeps a committed Agent edit closed and retries its failed list read without rewriting', async () => {
  const { page, consoleWatch } = await openTeamPage()
  await page.getByRole('button', { name: '添加 Agent' }).click()
  const create = page.getByRole('dialog', { name: '添加 Agent' })
  await create.getByLabel('名称').fill('builder')
  await create.getByLabel('说明').fill('编辑恢复验收')
  await chooseMemberModel(page, create)
  await create.getByRole('button', { name: '创建 Agent' }).click()
  const row = page.getByRole('button', { name: '打开 builder 的会话' })
  await expect.poll(() => row.isEnabled()).toBe(true)

  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const memberId = scaffold!.ctx.agentTeam.members({ workspaceId })
    .find(entry => entry.member.handle === 'builder')!.member.memberId

  const action = page.getByRole('button', { name: 'builder 的操作', exact: true })
  await row.focus()
  await page.keyboard.press('Tab')
  await expect.poll(() => action.evaluate(element => document.activeElement === element)).toBe(true)
  await page.keyboard.press('Enter')
  const edit = page.getByRole('menuitem', { name: '编辑 Agent', exact: true })
  await edit.waitFor()
  await page.keyboard.press('ArrowDown')
  await expect.poll(() => edit.evaluate(element => document.activeElement === element)).toBe(true)
  await page.keyboard.press('Enter')

  const editor = page.getByRole('dialog', { name: '编辑 Agent' })
  await editor.waitFor()
  const name = editor.getByLabel('名称')
  await expect.poll(() => name.evaluate(element => document.activeElement === element)).toBe(true)

  const writes: unknown[] = []
  const writeResults: unknown[] = []
  let failedReads = 0
  let readState: 'normal' | 'fail' = 'normal'

  await page.route('**/agentTeam/members', async route => {
    if (readState === 'fail') {
      failedReads += 1
      await route.abort('failed')
      return
    }
    await route.continue()
  })
  await page.route('**/agentTeam/updateMember', async route => {
    writes.push(route.request().postDataJSON())
    // The commit can wake the roster before the write response reaches the page.
    readState = 'fail'
    const response = await route.fetch()
    const envelope = await response.json() as { result: unknown }
    writeResults.push(envelope.result)
    await route.fulfill({ response })
  })

  await name.fill('architect')
  await name.press('Enter')
  await editor.waitFor({ state: 'hidden' })
  await expect.poll(() => scaffold!.ctx.agentTeam.members({ workspaceId })
    .find(entry => entry.member.memberId === memberId)?.member.handle).toBe('architect')

  const alert = page.locator('[role="alert"]').filter({ hasText: '已保存，列表刷新失败' })
  await alert.waitFor()
  expect(failedReads).toBeGreaterThan(0)
  expect(writes).toHaveLength(1)
  expect(writeResults[0]).toMatchObject({ ok: true })

  // A failed follow-up read belongs to the panel. The edit is already committed,
  // so its opener must regain focus instead of leaving it on the removed dialog.
  const editedRow = page.getByRole('button', { name: /^打开 (builder|architect) 的会话$/ })
  await expect.poll(() => editedRow.evaluate(element => document.activeElement === element)).toBe(true)

  readState = 'normal'
  const retry = alert.getByRole('button', { name: '重试刷新', exact: true })
  await retry.focus()
  await retry.press('Enter')
  await page.getByRole('button', { name: '打开 architect 的会话', exact: true }).waitFor()
  await alert.waitFor({ state: 'hidden' })
  expect(writes).toHaveLength(1)
  expect(scaffold!.ctx.agentTeam.members({ workspaceId })
    .find(entry => entry.member.memberId === memberId)?.member.handle).toBe('architect')
  expect(consoleWatch.pageErrors).toEqual([])
}, 60_000)
