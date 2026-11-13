import { afterEach, expect, it } from 'vitest'
import type { AgentTeamRequestId } from '@contexera/dsh-agent-team/types'
import { closeScenario, openTeamPage, scaffold } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

it.each(['delayed', 'lost'] as const)('resumes a discussion reply after reopening with a %s receipt', async (receipt) => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const requestId = () => crypto.randomUUID() as AgentTeamRequestId
  const { project } = await team.createProject({ workspaceId, requestId: requestId(), name: 'reply-reopen', description: '' })
  const { thread } = await team.startThread({ workspaceId, projectRef: project.projectRef, requestId: requestId(), kind: 'discussion', body: '讨论回复重试' })
  await page.getByRole('button', { name: '# reply-reopen', exact: true }).click()
  const card = page.getByRole('button', { name: /打开讨论：讨论回复重试/ })
  await card.click()
  const panel = page.locator('[data-team-panel]')
  const input = panel.getByRole('textbox', { name: '消息内容' })
  const send = panel.getByRole('button', { name: '发送', exact: true })
  const body = '关掉再打开，仍是同一笔回复'
  let intercepted = 0
  const committed = Promise.withResolvers<unknown>()
  const release = Promise.withResolvers<void>()
  await page.route('**/agentTeam/reply', async route => {
    const first = intercepted++ === 0
    const response = await route.fetch()
    if (first) {
      committed.resolve((await response.json() as { result: unknown }).result)
      await release.promise
      if (receipt === 'lost') { await route.abort('failed'); return }
    }
    await route.fulfill({ response })
  })
  try {
    await input.fill(body)
    if (receipt === 'lost') await panel.locator('input[type="file"]').setInputFiles({
      name: 'reply.txt', mimeType: 'text/plain', buffer: Buffer.from('original file'),
    })
    await send.click()
    expect(await committed.promise).toMatchObject({ ok: true, value: { kind: 'committed' } })
    await panel.getByRole('button', { name: '关闭讨论' }).click()
    await card.click()
    await expect.poll(() => input.inputValue()).toBe(body)
    await send.click()
    if (receipt === 'lost') await panel.getByRole('button', { name: '移除 reply.txt' }).waitFor({ state: 'attached' })
    release.resolve()
    if (receipt === 'lost') {
      await panel.getByRole('alert').waitFor()
      await send.click()
    }
    await expect.poll(() => input.inputValue()).toBe('')
    await send.waitFor()
    const replies = team.threadHistory({ workspaceId, threadRef: thread.threadRef }).facts
      .flatMap(fact => fact.kind === 'message' && fact.message.body.startsWith(body) ? [fact.message] : [])
    expect(replies).toHaveLength(1)
    if (receipt === 'lost') expect(replies[0]!.attachments).toMatchObject([{ name: 'reply.txt' }])
    expect(intercepted).toBe(receipt === 'lost' ? 2 : 1)
    expect(consoleWatch.pageErrors).toEqual([])
  } finally {
    release.resolve()
  }
}, 30_000)
