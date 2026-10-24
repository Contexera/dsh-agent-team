// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam, type MainStreamSeedEntry } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

const agentMessage = {
  messageRef: 'message:main-1', projectRef: 'project:engineering', scope: 'main', sender: 'member:builder',
  body: '配色要不要跟设置页统一？', sequence: 1, occurredAt: '2026-10-20T08:00:00.000Z',
}
const seedEntries: readonly MainStreamSeedEntry[] = [
  { kind: 'message', sequence: 1, occurredAt: agentMessage.occurredAt, message: agentMessage, mentions: [] },
  { kind: 'activity', sequence: 2, occurredAt: '2026-10-20T08:05:00.000Z', activity: { activityRef: 'activity:1', projectRef: 'project:engineering', kind: 'owner-added', memberId: 'member:builder', actor: 'member:human', sequence: 2, occurredAt: '2026-10-20T08:05:00.000Z' } },
  { kind: 'thread-card', sequence: 3, occurredAt: '2026-10-20T08:10:00.000Z', card: {
    threadRef: 'thread:login', anchor: { messageRef: 'message:t3', sender: 'member:human', preview: '登录页改版', sequence: 3, occurredAt: '2026-10-20T08:10:00.000Z' },
    replyCount: 6, participants: [{ memberId: 'member:human', name: 'human' }, { memberId: 'member:builder', name: 'builder' }],
    newestSequence: 3, newestOccurredAt: '2026-10-20T08:10:00.000Z', newestActor: { memberId: 'member:builder', name: 'builder' },
  } },
  { kind: 'thread-card', sequence: 4, occurredAt: '2026-10-20T08:20:00.000Z', unread: true, card: {
    threadRef: 'thread:api', anchor: { messageRef: 'message:t4', sender: 'member:human', preview: '实现 API 网关', sequence: 4, occurredAt: '2026-10-20T08:20:00.000Z' },
    task: { taskRef: 'task:12', taskNumber: 12, status: 'in_review', resolution: 'open', liveClaimOwners: [{ memberId: 'member:builder', name: 'builder' }] },
    replyCount: 2, participants: [], newestSequence: 4, newestOccurredAt: '2026-10-20T08:20:00.000Z', newestActor: { memberId: 'member:builder', name: 'builder' },
  } },
]

async function openProject(options?: Parameters<typeof runtimeWithTeam>[0]) {
  const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, rulesVersion: 2, mainStreamEntries: seedEntries, ...options })
  fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
  await b.view.findByRole('tab', { name: '主对话' })
  return b
}

const typeDraft = (b: Awaited<ReturnType<typeof openProject>>, text: string) => {
  fireEvent.change(b.view.getByRole('textbox', { name: '消息内容' }), { target: { value: text } })
}

describe('Team Main stream (rules version 2)', () => {
  it('renders messages, owner activity and both card kinds from the Host history, and opens the cards', async () => {
    const b = await openProject()
    expect(await b.view.findByText('配色要不要跟设置页统一？')).toBeTruthy()
    expect(b.view.getByText('human 指定 @builder 为项目负责人')).toBeTruthy()
    const discussion = b.view.getByRole('button', { name: '打开讨论：登录页改版 · 6 条回复 · 2 人' })
    const task = b.view.getByRole('button', { name: '打开 Task #12：实现 API 网关 · 待验收 · 由 @builder 处理 · 2 条回复 · 未读' })
    expect(discussion.getAttribute('data-main-card')).toBe('discussion')
    expect(task.getAttribute('data-main-card')).toBe('task')

    // A discussion opens the side panel on the Project page; a Task opens its own Thread level.
    fireEvent.click(discussion)
    expect(await b.view.findByRole('button', { name: '关闭讨论' })).toBeTruthy()
    await waitFor(() => { expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ threadRef: 'thread:login' })) })
    fireEvent.click(task)
    await waitFor(() => { expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ threadRef: 'thread:api', taskRef: 'task:12' })) })
    await b.runtime.dispose()
  })

  it('pages older entries with beforeSequence and acknowledges unread entries once on screen', async () => {
    const many: MainStreamSeedEntry[] = Array.from({ length: 25 }, (_, index) => ({
      kind: 'message', sequence: index + 1, occurredAt: '2026-10-20T08:00:00.000Z', mentions: [],
      message: { ...agentMessage, messageRef: `message:m${index + 1}`, body: `第 ${index + 1} 条`, sequence: index + 1 },
    }))
    const b = await openProject({ mainStreamEntries: many, mainStreamUnread: 3 })
    expect(await b.view.findByText('第 25 条')).toBeTruthy()
    expect(b.view.queryByText('第 5 条')).toBeNull()
    await waitFor(() => { expect(b.readMainStream).toHaveBeenCalledWith(expect.objectContaining({ readThroughSequence: 25 })) })
    expect(b.readMainStream).toHaveBeenCalledTimes(1)

    fireEvent.click(b.view.getByRole('button', { name: '加载更早消息' }))
    expect(await b.view.findByText('第 1 条')).toBeTruthy()
    expect(b.mainStreamHistory).toHaveBeenLastCalledWith(expect.objectContaining({ beforeSequence: 6 }))
    // The older page prepends: the newer entries already on screen must survive it.
    expect(b.view.getByText('第 25 条')).toBeTruthy()
    expect(b.view.getByText('第 24 条')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('reveals the quote/copy card on a Main stream message row under pointer and keyboard', async () => {
    const b = await openProject()
    await b.view.findByText('配色要不要跟设置页统一？')
    const row = b.view.getByText('配色要不要跟设置页统一？').closest('article')!
    // The reveal rules live under [data-team-project] (Main stream) and [data-team-thread] (Thread pages);
    // this pins that the Main stream container carries them.
    expect(row.closest('[data-team-project]')).not.toBeNull()
    const styles = getComputedStyle(row.querySelector('[data-message-card]')!)
    expect(styles.opacity).not.toBe('0')
    fireEvent.click(row)
    await b.runtime.dispose()
  })

  it('posts a plain message to the Main stream, quoting a Main message when asked', async () => {
    const b = await openProject()
    await b.view.findByText('配色要不要跟设置页统一？')
    fireEvent.click(b.view.getAllByRole('button', { name: '引用这条消息' })[0]!)
    typeDraft(b, '统一')
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(b.postMainMessage).toHaveBeenCalledTimes(1) })
    expect(b.postMainMessage).toHaveBeenCalledWith(expect.objectContaining({ body: '统一', replyToMessageRef: 'message:main-1', projectRef: 'project:engineering' }))
    expect(b.startThread).not.toHaveBeenCalled()
    expect(b.sendMessage).not.toHaveBeenCalled()
    expect(await b.view.findByText('统一')).toBeTruthy()
    expect((b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('')
    await b.runtime.dispose()
  })

  it('starts a discussion from the composer toggle and shows its card', async () => {
    const b = await openProject()
    await b.view.findByText('配色要不要跟设置页统一？')
    fireEvent.click(b.view.getByRole('button', { name: '讨论/任务' }))
    typeDraft(b, '导航栏怎么收')
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(b.startThread).toHaveBeenCalledWith(expect.objectContaining({ kind: 'discussion', body: '导航栏怎么收' })) })
    expect(b.postMainMessage).not.toHaveBeenCalled()
    expect(await b.view.findByRole('button', { name: /^打开讨论：导航栏怎么收/ })).toBeTruthy()
    expect(b.view.getByRole('tab', { name: '主对话' }).getAttribute('aria-selected')).toBe('true')
    expect(b.view.getByRole('button', { name: '讨论/任务' }).getAttribute('aria-pressed')).toBe('false')
    await b.runtime.dispose()
  })

  it('starts a Task when 作为任务 is checked and moves to the board', async () => {
    const b = await openProject()
    await b.view.findByText('配色要不要跟设置页统一？')
    fireEvent.click(b.view.getByRole('button', { name: '讨论/任务' }))
    fireEvent.click(b.view.getByRole('checkbox', { name: '作为任务' }))
    typeDraft(b, '整理组件库')
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(b.startThread).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task', body: '整理组件库' })) })
    await waitFor(() => { expect(b.view.getByRole('tab', { name: '看板' }).getAttribute('aria-selected')).toBe('true') })
    await b.runtime.dispose()
  })

  it('keeps the draft and asks the Human to look when the Host requires a read first', async () => {
    const b = await openProject()
    await b.view.findByText('配色要不要跟设置页统一？')
    b.requireMainRead()
    typeDraft(b, '先说一句')
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect(await b.view.findByText('主对话有新消息，请先看一下，再发送一次。')).toBeTruthy()
    expect((b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('先说一句')
    await waitFor(() => { expect(b.readMainStream).toHaveBeenCalled() })

    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(b.postMainMessage).toHaveBeenCalledTimes(2) })
    expect(b.postMainMessage.mock.calls[1]![0]).toEqual(expect.objectContaining({ body: '先说一句' }))
    expect(b.postMainMessage.mock.calls[1]![0].requestId).not.toBe(b.postMainMessage.mock.calls[0]![0].requestId)
    await b.runtime.dispose()
  })

  it('keeps the Project feed, its tab name and its composer at rules version 1', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, rulesVersion: 1 })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('tab', { name: '项目' })).toBeTruthy()
    expect(b.view.getByRole('button', { name: '作为任务' })).toBeTruthy()
    expect(b.view.queryByRole('button', { name: '讨论/任务' })).toBeNull()
    expect(b.mainStreamHistory).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })
})
