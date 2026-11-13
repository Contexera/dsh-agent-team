import { afterEach, expect, it } from 'vitest'
import type { AgentTeamRequestId } from '@contexera/dsh-agent-team/types'
import { ONE_PIXEL_PNG, closeScenario, openTeamPage, scaffold } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

it('keeps one Main message when a tab remount happens before its delayed receipt', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const { project } = await team.createProject({
    workspaceId, requestId: crypto.randomUUID() as AgentTeamRequestId, name: 'main-reopen', description: '',
  })
  const projectRef = project.projectRef
  await page.getByRole('button', { name: '# main-reopen', exact: true }).click()

  const surface = page.locator('[data-team-project]')
  const input = surface.getByRole('textbox', { name: '消息内容' })
  const send = surface.getByRole('button', { name: '发送', exact: true })
  const mainTab = surface.getByRole('tab', { name: '主对话' })
  const boardTab = surface.getByRole('tab', { name: '看板' })
  const body = 'mounted send remains one Main message'
  const committed = Promise.withResolvers<unknown>()
  const release = Promise.withResolvers<void>()
  let posts = 0

  await page.route('**/agentTeam/postMainMessage', async route => {
    const first = posts++ === 0
    const response = await route.fetch()
    if (first) {
      committed.resolve((await response.json() as { result: unknown }).result)
      await release.promise
    }
    await route.fulfill({ response })
  })

  try {
    await input.fill(body)
    await send.click()
    expect(await committed.promise).toMatchObject({ ok: true, value: { kind: 'committed' } })

    await boardTab.click()
    await expect.poll(() => boardTab.getAttribute('aria-selected')).toBe('true')
    await mainTab.click()
    await expect.poll(() => mainTab.getAttribute('aria-selected')).toBe('true')
    await expect.poll(() => input.inputValue()).toBe(body)

    // The restored attempt is still clickable: this joins the first promise rather than minting another send.
    await send.click()
    release.resolve()
    await expect.poll(() => input.inputValue()).toBe('')
    await send.waitFor({ state: 'visible' })

    const posted = team.mainStreamHistory({ workspaceId, projectRef }).entries
      .flatMap(entry => entry.kind === 'message' && entry.message.body === body ? [entry.message] : [])
    expect(posted).toHaveLength(1)
    expect(consoleWatch.pageErrors).toEqual([])
  } finally {
    release.resolve()
  }
}, 30_000)

it('restores a lost-ack Task attempt, its attachment, and one Host fact', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const { project } = await team.createProject({
    workspaceId, requestId: crypto.randomUUID() as AgentTeamRequestId, name: 'task-reopen', description: '',
  })
  const projectRef = project.projectRef
  await page.getByRole('button', { name: '# task-reopen', exact: true }).click()

  const surface = page.locator('[data-team-project]')
  const input = surface.getByRole('textbox', { name: '消息内容' })
  const send = surface.getByRole('button', { name: '发送', exact: true })
  const mainTab = surface.getByRole('tab', { name: '主对话' })
  const boardTab = surface.getByRole('tab', { name: '看板' })
  const toggle = surface.getByRole('button', { name: '讨论/任务' })
  const body = 'lost-ack Task keeps its mode and file'
  const attachmentName = 'main-reopen.png'
  const committed = Promise.withResolvers<unknown>()
  const release = Promise.withResolvers<void>()
  let starts = 0

  await page.route('**/agentTeam/startThread', async route => {
    const first = starts++ === 0
    const response = await route.fetch()
    if (first) {
      committed.resolve((await response.json() as { result: unknown }).result)
      await release.promise
      await route.abort('failed')
      return
    }
    await route.fulfill({ response })
  })

  try {
    await input.fill(body)
    await toggle.click()
    await surface.getByRole('checkbox', { name: '作为任务' }).check()
    await surface.locator('input[type="file"]').setInputFiles({
      name: attachmentName,
      mimeType: 'image/png',
      buffer: Buffer.from(ONE_PIXEL_PNG, 'base64'),
    })
    await send.click()
    expect(await committed.promise).toMatchObject({ ok: true, value: { kind: 'committed' } })

    await boardTab.click()
    await expect.poll(() => boardTab.getAttribute('aria-selected')).toBe('true')
    await mainTab.click()
    await expect.poll(() => mainTab.getAttribute('aria-selected')).toBe('true')
    await expect.poll(() => input.inputValue()).toBe(body)
    await expect.poll(() => toggle.getAttribute('aria-pressed')).toBe('true')
    const taskMode = surface.getByRole('checkbox', { name: '作为任务' })
    await expect.poll(() => taskMode.count()).toBe(1)
    await expect.poll(() => taskMode.isChecked()).toBe(true)
    await surface.getByRole('button', { name: `移除 ${attachmentName}`, exact: true }).waitFor()

    // Joining before the lost receipt settles keeps the new face subscribed to the same attempt.
    await send.click()
    release.resolve()
    await surface.getByRole('alert').waitFor()
    await send.click()
    await expect.poll(() => boardTab.getAttribute('aria-selected')).toBe('true')

    const cards = team.mainStreamHistory({ workspaceId, projectRef }).entries
      .flatMap(entry => entry.kind === 'thread-card' && entry.card.anchor.preview.startsWith(body) ? [entry.card] : [])
    expect(cards).toHaveLength(1)
    expect(cards[0]?.task).toBeDefined()
    const facts = team.threadHistory({ workspaceId, threadRef: cards[0]!.threadRef }).facts
    const messages = facts.flatMap(fact => fact.kind === 'message' && fact.message.body.startsWith(body) ? [fact.message] : [])
    expect(messages).toHaveLength(1)
    expect(messages[0]?.attachments).toMatchObject([{ name: attachmentName }])
    expect(consoleWatch.pageErrors).toEqual([])
  } finally {
    release.resolve()
  }
}, 30_000)
