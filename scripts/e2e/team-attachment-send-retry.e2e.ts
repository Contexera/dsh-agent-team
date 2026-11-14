import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentTeamRequestId } from '@contexera/dsh-agent-team/types'
import { ONE_PIXEL_PNG, closeScenario, openTeamPage, scaffold, scenarioHome } from './__external-agent-team-support.ts'

afterEach(async () => { await closeScenario() })

it('retries a Main stream attachment send after losing a committed response', async () => {
  const { page, consoleWatch } = await openTeamPage()
  const team = scaffold!.ctx.agentTeam
  const workspaceId = scaffold!.ctx.workspaceRegistry.list()[0]!.id
  const { project } = await team.createProject({
    workspaceId, requestId: crypto.randomUUID() as AgentTeamRequestId, name: 'send-retry', description: '',
  })
  const projectRef = project.projectRef
  await page.getByRole('button', { name: '# send-retry', exact: true }).click()
  const surface = page.locator('[data-team-project]')
  const input = surface.getByRole('textbox', { name: '消息内容' })
  const send = surface.getByRole('button', { name: '发送', exact: true })
  const body = '发送回执丢失后的重试'
  await input.fill(body)
  await surface.locator('input[type="file"]').setInputFiles({
    name: 'retry.png', mimeType: 'image/png', buffer: Buffer.from(ONE_PIXEL_PNG, 'base64'),
  })

  const requests: unknown[] = []
  const responses: unknown[] = []
  await page.route('**/agentTeam/postMainMessage', async route => {
    const { rpcId: _transportId, ...request } = route.request().postDataJSON() as { rpcId: string }
    requests.push(request)
    const response = await route.fetch()
    const envelope = await response.json() as { result: unknown }
    responses.push(envelope.result)
    if (requests.length === 1) {
      await route.abort('failed')
    } else {
      await route.fulfill({ response })
    }
  })
  await send.click()
  await surface.getByRole('alert').waitFor()
  expect(responses[0]).toMatchObject({ ok: true, value: { kind: 'committed' } })
  const cache = join(scenarioHome(), 'agent-team', 'attachments', 'v1')
  const originalUploads = await readdir(cache)
  expect(originalUploads).toHaveLength(1)
  expect(await input.inputValue()).toBe(body)
  await send.click()
  await expect.poll(() => input.inputValue()).toBe('')
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(responses[1]).toEqual(responses[0])
  expect(await readdir(cache)).toEqual(originalUploads)
  const entries = team.mainStreamHistory({ workspaceId, projectRef }).entries
  const sent = entries.filter(entry => entry.kind === 'message' && entry.message.body.startsWith(body))
  expect(sent).toMatchObject([{ kind: 'message', message: { attachments: [{ name: 'retry.png' }] } }])
  const zoom = surface.getByRole('button', { name: '查看大图 retry.png', exact: true })
  await expect.poll(() => zoom.isEnabled()).toBe(true)
  await zoom.press('Enter')
  await page.getByRole('dialog').getByRole('img').waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  expect(consoleWatch.pageErrors).toEqual([])
}, 60_000)
