// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, fireEvent, waitFor, within } from '@testing-library/react'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')

async function openThread(surface: 'page' | 'panel') {
  const runtime = await runtimeWithTeam({
    mode: 'team', workspaceId: 'w1', initialProjects: true,
    seedTaskless: surface === 'panel',
    seededMessages: [{ body: '讨论起点', occurredAt: '2026-08-21T09:00:00.000Z' }],
  })
  fireEvent.click(await runtime.view.findByRole('button', { name: '# engineering' }))
  fireEvent.click(await runtime.view.findByRole('button', { name: surface === 'panel' ? /^打开讨论：/ : /^打开 Task #1：/ }))
  const element = surface === 'panel'
    ? await runtime.view.findByRole('complementary', { name: '讨论' })
    : (await runtime.view.findByRole('heading', { name: 'Task #1' })).closest('main')!
  const view = within(element)
  await view.findByText('讨论起点', { selector: '[data-message-ref] *' })
  await act(async () => {})
  return { runtime, view }
}

async function send(view: ReturnType<typeof within>, body: string): Promise<void> {
  fireEvent.change(view.getByRole('textbox', { name: '消息内容' }), { target: { value: body } })
  await waitFor(() => expect(view.getByRole('button', { name: '发送' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(view.getByRole('button', { name: '发送' }))
  await waitFor(() => expect((view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe(''))
}

describe('Thread committed revision', () => {
  it.each(['page', 'panel'] as const)('uses the committed reply revision for a fresh reply in the %s', async surface => {
    const { runtime, view } = await openThread(surface)
    const reads = runtime.readThread.mock.calls.length
    const historyReads = runtime.loadThreadHistory.mock.calls.length

    await send(view, '第一条回复')
    await send(view, '第二条回复')

    const [first, second] = runtime.reply.mock.calls.map(([request]) => request)
    expect(second!.requestId).not.toBe(first!.requestId)
    expect(second!.baseRevision).toBe(first!.baseRevision + 1)
    expect(runtime.readThread).toHaveBeenCalledTimes(reads)
    expect(runtime.loadThreadHistory).toHaveBeenCalledTimes(historyReads)
  })

  it('uses the committed Task revision for a reply when the follow-up read fails', async () => {
    const { runtime, view } = await openThread('page')
    const failure = {
      ok: false as const,
      error: new RemoteError('gateway/internal', 'read unavailable after commit', {}),
    }
    runtime.readThread.mockResolvedValue(failure)
    runtime.loadThreadHistory.mockResolvedValue(failure)

    fireEvent.click(view.getByRole('button', { name: '验收' }))
    await view.findByText('read unavailable after commit')
    await send(view, '验收后的回复')

    const committed = await runtime.changeTask.mock.results[0]!.value
    expect(committed.ok).toBe(true)
    if (!committed.ok) throw new Error('Task did not commit')
    expect(runtime.reply.mock.calls[0]![0].baseRevision).toBe(committed.value.thread.revision)
  })
})
