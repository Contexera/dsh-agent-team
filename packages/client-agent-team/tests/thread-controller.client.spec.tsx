// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { act, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { AgentTeamMessage, AgentTeamTask } from '@contexera/dsh-agent-team/types'
import { runtimeWithTeam, type ClientTestBenchOptions } from './harness.tsx'
import { flushRefreshes, useRefreshClock } from './bench/refresh-clock.ts'

usePinnedBrowserLanguages('zh-CN')
beforeEach(useRefreshClock)

async function openThread(options: Pick<ClientTestBenchOptions, 'remainingUnreadCounts'> = {}) {
  const b = await runtimeWithTeam({
    mode: 'team', workspaceId: 'w1', initialProjects: true,
    seededMessages: [{ body: '审阅这个方案', occurredAt: '2026-10-14T09:00:00.000Z' }],
    ...options,
  })
  fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
  fireEvent.click(await b.view.findByRole('button', { name: /^打开 Task #1：/ }))
  await b.view.findByRole('heading', { name: 'Task #1' })
  await flushRefreshes(b)
  return b
}

describe('Thread controller read ownership and automatic catch-up', () => {
  it.each(['successful', 'refused'] as const)('keeps the newest overlapping read when the older read is %s', async outcome => {
    const b = await openThread()
    const originalRead = b.readThread.getMockImplementation()!
    const originalHistory = b.loadThreadHistory.getMockImplementation()!
    const header = within(b.view.getByRole('heading', { name: 'Task #1' }).closest('header')!)
    expect(header.getByText('待处理')).toBeTruthy()
    expect(header.getByRole('button', { name: '验收' })).toBeTruthy()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let sequence = 1
    b.loadThreadHistory.mockImplementation(async request => {
      const result = await originalHistory(request)
      if (!result.ok) return result
      sequence += 1
      return { ok: true, value: {
        ...result.value,
        facts: [{ kind: 'message', sequence, mentions: [], message: {
          ...result.value.anchor as AgentTeamMessage, messageRef: `message:arrival-${sequence}`, body: `新回复 ${sequence}`,
          topLevel: false, sender: 'member:builder', sequence,
        } }] as never[],
      } }
    })
    b.readThread.mockImplementationOnce(async request => {
      const result = await originalRead(request)
      entered.resolve()
      await release.promise
      return outcome === 'successful' ? result : { ok: false, error: { message: '旧读取失败' } }
    }).mockImplementationOnce(async request => {
      const result = await originalRead(request)
      if (!result.ok) return result
      return { ok: true, value: { ...result.value, task: { ...result.value.task as AgentTeamTask, status: 'in_progress' } } }
    })

    b.publishProjectUpdate()
    await entered.promise
    expect(await b.view.findByText('新回复 2')).toBeTruthy()
    b.publishProjectUpdate()
    await header.findByText('进行中')
    expect(await b.view.findByText('新回复 3')).toBeTruthy()
    expect(header.queryByRole('button', { name: '验收' })).toBeNull()

    await act(async () => { release.resolve() })
    await flushRefreshes(b)
    expect(header.getByText('进行中')).toBeTruthy()
    expect(header.queryByText('待处理')).toBeNull()
    expect(header.queryByRole('button', { name: '验收' })).toBeNull()
    expect(b.view.queryByRole('alert')).toBeNull()
    expect(b.view.getByText('新回复 2')).toBeTruthy()
    expect(b.view.getByText('新回复 3')).toBeTruthy()
    expect((b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).readOnly).toBe(false)
    const requests = b.readThread.mock.calls.map(([request]) => request)
    expect(requests).toHaveLength(3)
    expect(new Set(requests.map(request => request.requestId)).size).toBe(3)
  })

  it('stops after fifty automatic read rounds and drains the remainder only on retry', async () => {
    const b = await openThread({ remainingUnreadCounts: [...Array.from({ length: 51 }, (_, index) => 51 - index), 0] })
    const alert = await b.view.findByRole('alert')
    expect(alert.textContent).toContain('仍有未读更新未能自动读取')
    expect(b.readThread).toHaveBeenCalledTimes(51)
    const retry = within(alert).getByRole<HTMLButtonElement>('button', { name: '重试' })
    expect(retry.disabled).toBe(false)
    expect(b.view.getByRole('textbox', { name: '消息内容' })).toBeTruthy()

    fireEvent.click(retry)
    await flushRefreshes(b)
    await waitFor(() => expect(b.view.queryByText('仍有未读更新未能自动读取')).toBeNull())
    expect(b.view.queryByRole('alert')).toBeNull()
    expect(b.readThread).toHaveBeenCalledTimes(52)
    const requests = b.readThread.mock.calls.map(([request]) => request)
    expect(new Set(requests.map(request => request.requestId)).size).toBe(52)
    expect(b.view.getAllByText('审阅这个方案')).not.toHaveLength(0)
  })
})
