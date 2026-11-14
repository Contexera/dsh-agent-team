// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')

async function openDiscussions(configure?: (bench: Awaited<ReturnType<typeof runtimeWithTeam>>) => void) {
  const card = (threadRef: string, sequence: number, preview: string) => ({
    kind: 'thread-card' as const, sequence, occurredAt: '2026-10-14T09:00:00.000Z', card: {
      threadRef, anchor: { messageRef: `message:seed-${sequence - 1}`, sender: 'member:human', preview, sequence, occurredAt: '2026-10-14T09:00:00.000Z' },
      replyCount: 0, participants: [], newestSequence: sequence, newestOccurredAt: '2026-10-14T09:00:00.000Z', newestActor: { memberId: 'member:human', name: 'human' },
    },
  })
  const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskless: true, seededMessages: [
    { body: '第一条讨论', occurredAt: '2026-10-14T09:00:00.000Z' },
  ], mainStreamEntries: [card('thread:1', 1, '第一条讨论'), card('thread:2', 2, '第二条讨论')] })
  const baseRead = b.readThread.getMockImplementation()!
  b.readThread.mockImplementation(async request => {
    const result = await baseRead(request)
    if (!result.ok) return result
    const threadRef = request.threadRef ?? 'thread:1'
    const anchor = threadRef === 'thread:2'
      ? { messageRef: 'message:seed-1', projectRef: 'project:engineering', threadRef, sender: 'member:human',
          body: '第二条讨论', topLevel: true, sequence: 2, occurredAt: '2026-10-14T10:00:00.000Z' }
      : result.value.anchor
    return { ok: true as const, value: {
      ...result.value,
      anchor,
      ...(threadRef === 'thread:2' ? { task: undefined } : {}),
      thread: { threadRef, revision: 2 },
      facts: result.value.facts.filter(fact => fact.fact.kind !== 'message'
        || (fact.fact.message as { threadRef?: string }).threadRef === threadRef),
    } }
  })
  configure?.(b)
  fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
  await waitFor(() => expect(b.view.container.querySelectorAll('[data-main-card]').length).toBe(2))
  const doors = b.view.container.querySelectorAll<HTMLElement>('[data-main-card]')
  fireEvent.click(doors[0]!)
  const panel = await b.view.findByRole('complementary', { name: '讨论' })
  await within(panel).findByText('第一条讨论')
  return { b, panel, open: (index: number) => { fireEvent.click(doors[index]!) } }
}

describe('Team Project discussion panel switching', () => {
  it('starts a new read on each discussion opening and drops old history', async () => {
    const latePage = Promise.withResolvers<void>()
    const lateFact = {
      kind: 'message', sequence: 1, mentions: [], occurredAt: '2026-10-14T08:00:00.000Z',
      message: {
        messageRef: 'message:late-a', projectRef: 'project:engineering', threadRef: 'thread:1', sender: 'member:builder',
        body: '迟到的 A 旧消息', topLevel: false, sequence: 1, occurredAt: '2026-10-14T08:00:00.000Z',
      },
    }
    const olderStarted = Promise.withResolvers<void>()
    const { b, panel, open } = await openDiscussions(bench => {
      const baseHistory = bench.loadThreadHistory.getMockImplementation()!
      bench.loadThreadHistory.mockImplementation(async (request: { taskRef?: string; threadRef?: string; beforeSequence?: number }) => {
        const result = await baseHistory(request)
        if (!result.ok || request.threadRef !== 'thread:1') return result
        if (request.beforeSequence !== undefined) {
          olderStarted.resolve()
          await latePage.promise
          return { ok: true, value: { ...result.value, facts: [lateFact] as never[], cursor: 1, hasMore: false } }
        }
        return { ok: true, value: { ...result.value, cursor: 2, hasMore: true } }
      })
    })

    expect(await within(panel).findByText('第一条讨论')).toBeTruthy()
    fireEvent.click(await within(panel).findByRole('button', { name: '加载更早消息' }))
    await olderStarted.promise
    open(1)
    expect(await within(panel).findByText('第二条讨论')).toBeTruthy()
    expect(within(panel).queryByText('第一条讨论')).toBeNull()
    // Returning to A is a new open, not a renewal of the first one whose history page is still in flight.
    open(0)
    expect(await within(panel).findByText('第一条讨论')).toBeTruthy()
    const reads = b.readThread.mock.calls.map(([request]) => request)
    expect(reads.map(request => request.threadRef)).toEqual(['thread:1', 'thread:2', 'thread:1'])
    expect(new Set(reads.map(request => request.requestId)).size).toBe(3)

    await act(async () => {
      latePage.resolve()
      await new Promise<void>(resolve => { setImmediate(resolve) })
    })
    expect(within(panel).queryByText('迟到的 A 旧消息')).toBeNull()
    expect(within(panel).getByText('第一条讨论')).toBeTruthy()
  })

  it.each(['committed', 'failed'] as const)('keeps the current reply independent of a %s reply to the previous discussion', async (outcome) => {
    const { b, panel, open } = await openDiscussions()
    const original = b.reply.getMockImplementation()!
    const sentA = Promise.withResolvers<void>()
    const settleA = Promise.withResolvers<void>()
    const sentB = Promise.withResolvers<void>()
    const settleB = Promise.withResolvers<void>()
    b.reply.mockImplementationOnce(async request => {
      sentA.resolve()
      await settleA.promise
      if (outcome === 'failed') throw new Error('A 的发送失败')
      return original(request)
    }).mockImplementationOnce(async () => {
      sentB.resolve()
      await settleB.promise
      throw new Error('B 的发送失败')
    })
    const input = () => within(panel).getByRole<HTMLTextAreaElement>('textbox', { name: '消息内容' })
    const send = () => { fireEvent.click(within(panel).getByRole('button', { name: '发送' })) }
    fireEvent.change(input(), { target: { value: 'A 的回复' } })
    send()
    await sentA.promise
    open(1)
    await within(panel).findByText('第二条讨论')
    expect(input().readOnly).toBe(false)
    if (outcome === 'committed') {
      open(0)
      await within(panel).findByText('第一条讨论')
      expect(input().readOnly).toBe(true)
      open(1)
      await within(panel).findByText('第二条讨论')
    }
    fireEvent.change(input(), { target: { value: 'B 的草稿' } })
    send()
    await sentB.promise

    await act(async () => { settleA.resolve() })
    expect(input().value).toBe('B 的草稿')
    expect(input().readOnly).toBe(true)
    expect(within(panel).queryByText('A 的发送失败')).toBeNull()
    expect(within(panel).queryByText('A 的回复')).toBeNull()
    expect(b.reply.mock.calls.map(([request]) => request.threadRef)).toEqual(['thread:1', 'thread:2'])

    await act(async () => { settleB.resolve() })
    expect(await within(panel).findByText('B 的发送失败')).toBeTruthy()
    open(0)
    await within(panel).findByText('第一条讨论')
    expect(input().value).toBe(outcome === 'failed' ? 'A 的回复' : '')
  })

  it.each(['unchanged', 'edited'] as const)('settles the previous reply against the %s draft after reopening', async (draft) => {
    const { b, panel, open } = await openDiscussions()
    const original = b.reply.getMockImplementation()!
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    b.reply.mockImplementationOnce(async request => {
      entered.resolve()
      await release.promise
      return original(request)
    })
    const file = new File(['attachment'], 'reply.txt', { type: 'text/plain' })
    fireEvent.change(panel.querySelector('input[type="file"]')!, { target: { files: [file] } })
    fireEvent.change(within(panel).getByRole('textbox', { name: '消息内容' }), { target: { value: '旧回复' } })
    fireEvent.click(within(panel).getByRole('button', { name: '发送' }))
    await entered.promise
    fireEvent.click(within(panel).getByRole('button', { name: '关闭讨论' }))
    open(0)
    const reopened = await b.view.findByRole('complementary', { name: '讨论' })
    const input = await within(reopened).findByRole<HTMLTextAreaElement>('textbox', { name: '消息内容' })
    const remove = () => within(reopened).queryByRole('button', { name: '移除 reply.txt' })
    expect(remove()).not.toBeNull()
    if (draft === 'edited') fireEvent.change(input, { target: { value: '后来编辑的草稿' } })

    await act(async () => { release.resolve() })
    expect(input.value).toBe(draft === 'edited' ? '后来编辑的草稿' : '')
    expect(remove() !== null).toBe(draft === 'edited')
  })

  it.each(['committed', 'failed'] as const)('keeps the current discussion open after a %s conversion in the previous one', async (outcome) => {
    const { b, panel, open } = await openDiscussions()
    const original = b.promoteThread.getMockImplementation()!
    const entered = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const enteredB = Promise.withResolvers<void>()
    const settledB = Promise.withResolvers<void>()
    b.promoteThread.mockImplementationOnce(async request => {
      entered.resolve()
      await settled.promise
      if (outcome === 'failed') throw new Error('A 的转换失败')
      return original(request)
    }).mockImplementationOnce(async () => {
      enteredB.resolve()
      await settledB.promise
      throw new Error('B 的转换失败')
    })
    fireEvent.click(within(panel).getByRole('button', { name: '转为 Task' }))
    await entered.promise
    open(1)
    await within(panel).findByText('第二条讨论')
    fireEvent.click(within(panel).getByRole('button', { name: '转为 Task' }))
    await enteredB.promise

    await act(async () => { settled.resolve() })
    expect(within(panel).getByText('第二条讨论')).toBeTruthy()
    expect(within(panel).queryByText('A 的转换失败')).toBeNull()
    expect(b.view.queryByRole('heading', { name: 'Task #1' })).toBeNull()
    const requests = b.promoteThread.mock.calls.map(([request]) => request)
    expect(requests.map(request => request.threadRef)).toEqual(['thread:1', 'thread:2'])
    expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId)
    await act(async () => { settledB.resolve() })
    expect(await within(panel).findByText('B 的转换失败')).toBeTruthy()
    if (outcome === 'committed') expect(await b.view.findByRole('button', { name: /^打开 Task #1：/ })).toBeTruthy()
  })
})
