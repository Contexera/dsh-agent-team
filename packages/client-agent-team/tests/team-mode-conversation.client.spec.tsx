// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Rendering the whole Team surface in jsdom has reached 3.4s on the windows lane
// (worst of 11 CI runs, 2026-09-17..21) against vitest's 5s default, so the file
// keeps headroom rather than betting on runner throughput.
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { TEAM_DRAFTS_STORAGE_KEY } from '../src/client/drafts.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/**
 * Fold upstream-owned sidebar chrome onto one shape across the certified line.
 * Two cosmetic details of it moved between the 0.1.7-rc.1 and rc.2 cuts: the logo
 * row gained `data-window-drag`, and the new-session icon and label were rewrapped
 * in a mask/content pair. Both cuts sit inside the certified range, so the
 * container snapshot normalizes that rewrapping instead of pinning one cut.
 */
function normalizeSidebarChrome(container: HTMLElement): HTMLElement {
  const clone = container.cloneNode(true) as HTMLElement
  for (const node of clone.querySelectorAll('[data-window-drag]')) node.removeAttribute('data-window-drag')
  // Class names arrive CSS-module hashed, so these selectors match the stable part.
  for (const mask of clone.querySelectorAll('[class*="newSessionLabelMask"]')) {
    const content = mask.querySelector('[class*="newSessionContent"]') ?? mask
    mask.replaceWith(...content.childNodes)
  }
  return clone
}

describe('Team conversation surfaces', () => {
  it('opens a selected Channel in the Team center and sends only after Host commit', async () => {
    const b = await runtimeWithTeam({ remainingUnreadCounts: [1] })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    fireEvent.click(await b.view.findByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'API' } })
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    const backendChannel = await b.view.findByRole('button', { name: '# backend' })
    fireEvent.click(backendChannel)
    const channelRow = backendChannel.closest('article')!
    expect(channelRow.getAttribute('aria-current')).toBe('page')
    // Location moves to the leaf: the open Channel is the Channel list's only
    // aria-current='page', and the browsed Workspace row yields it. The panel
    // rail above keeps its own marker for the selected global panel, so the
    // two levels are asserted where each one lives.
    const channelList = channelRow.parentElement!
    expect([...channelList.querySelectorAll('[aria-current="page"]')]).toEqual([channelRow])
    expect(b.view.container.querySelector('[data-team-workspace-trigger]')?.getAttribute('aria-current')).toBeNull()
    expect(await b.view.findByRole('heading', { name: '# backend' })).toBeTruthy()
    const channelPage = b.view.container.querySelector('[data-team-channel]') as HTMLElement
    const manageMembers = within(channelPage).getByRole('button', { name: '管理成员' })
    fireEvent.click(manageMembers)
    const pageManager = b.view.getByRole('dialog', { name: '频道成员' })
    expect(within(pageManager).getByText('@builder')).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(within(pageManager).getByRole('button', { name: '移除' })))
    const removal = Promise.withResolvers<Awaited<ReturnType<typeof b.removeChannelMember>>>()
    b.removeChannelMember.mockReturnValueOnce(removal.promise)
    fireEvent.click(within(pageManager).getByRole('button', { name: '移除' }))
    expect((within(pageManager).getByRole('button', { name: '更新中…' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(pageManager).getAllByRole('button', { name: '添加' })[0] as HTMLButtonElement).disabled).toBe(false)
    removal.resolve({ ok: false, error: { message: 'membership failed' } } as never)
    expect((await within(pageManager).findByRole('alert')).textContent).toContain('membership failed')
    expect(within(pageManager).getByRole('button', { name: '移除' })).toBeTruthy()
    fireEvent.click(within(pageManager).getByRole('button', { name: '关闭' }))
    await waitFor(() => expect(document.activeElement).toBe(manageMembers))
    const messageInput = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    fireEvent.change(messageInput, { target: { value: 'hello team @b' } })
    fireEvent.click(b.view.getByRole('option', { name: /@builder/ }))
    expect(messageInput.value).toBe('hello team @builder ')
    fireEvent.click(b.view.getByRole('button', { name: '作为任务' }))
    b.sendMessage.mockResolvedValueOnce({ ok: false, error: { message: 'send failed' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect((await within(channelPage).findByRole('alert')).textContent).toContain('send failed')
    expect((b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('hello team @builder ')
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(b.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'hello team @builder', recipients: ['member:builder'], asTask: true })))
    expect(b.sendMessage.mock.calls[0]![0].requestId).not.toBe(b.sendMessage.mock.calls[1]![0].requestId)
    // Mention segmentation splits the body into spans (and css-module classes
    // are hashed here), so match the body container by class substring.
    await waitFor(() => {
      const rows = Array.from(b.view.container.querySelectorAll('[data-human] div[class*="messageText"]'))
      expect(rows.some(row => row.textContent === 'hello team @builder')).toBe(true)
    })
    expect(b.view.queryByText('任务消息')).toBeNull()
    // The state moved up onto the identity line, and the Task's own row under
    // the body replaced the always-on pill that used to repeat status + count.
    expect(b.view.getByText('待处理')).toBeTruthy()
    expect(b.view.getByText('Task #1')).toBeTruthy()
    expect(b.view.queryByText('1 条消息')).toBeNull()
    b.publishAgentReply()
    // The reply and its Claim are newer facts than the opener, so the entry row
    // now says when the work last moved.
    b.publishAgentReply()
    await waitFor(() => expect(b.view.queryByText('agent reply')).toBeNull())
    await waitFor(() => expect(b.view.getByRole('button', { name: '打开 Task #1' }).textContent).toContain('最近活动'))
    fireEvent.click(b.view.getByRole('button', { name: '打开 Task #1' }))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: /Claims/ }))
    expect(b.view.getByText('Implement API')).toBeTruthy()
    expect(b.view.queryByRole('button', { name: '关注 Thread' })).toBeNull()
    expect(b.view.queryByRole('button', { name: '取消关注' })).toBeNull()
    expect(b.view.queryByText('Human 观察')).toBeNull()
    // Opening onto a bounded read with a remainder drains it automatically:
    // each round carries a fresh requestId, no continue-reading control
    // exists, and the unread facts render once the loop settles.
    await waitFor(() => expect(b.readThread).toHaveBeenCalledTimes(2))
    expect(b.readThread.mock.calls[0]![0].requestId).not.toBe(b.readThread.mock.calls[1]![0].requestId)
    expect(b.view.queryByRole('button', { name: '继续阅读' })).toBeNull()
    expect(b.view.getByText('@builder 认领了「Implement API」')).toBeTruthy()
    expect(b.view.queryByText(/member:builder/)).toBeNull()
    expect(b.view.queryByText(/claim ·/)).toBeNull()
    expect(b.view.queryByRole('button', { name: '标记完成' })).toBeNull()
    fireEvent.change(b.view.getByRole('textbox', { name: '消息内容' }), { target: { value: 'human thread reply' } })
    b.reply.mockResolvedValueOnce({ ok: false, error: { message: 'stale Thread revision 2' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect((await b.view.findByRole('alert')).textContent).toContain('stale Thread revision')
    expect((b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('human thread reply')
    expect(b.reply).toHaveBeenCalledTimes(1)
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect(await b.view.findByText('human thread reply')).toBeTruthy()
    expect(b.reply.mock.calls[0]![0].requestId).toBe(b.reply.mock.calls[1]![0].requestId)
    fireEvent.click(b.view.getByRole('button', { name: '关闭任务' }))
    // The closed Thread swaps the composer for an explanatory notice with the reopen action.
    expect(await b.view.findByRole('button', { name: '重新打开' })).toBeTruthy()
    expect(b.view.getByText('任务已关闭，重新打开后可继续讨论')).toBeTruthy()
    expect(b.view.queryByRole('textbox', { name: '消息内容' })).toBeNull()
    expect(b.reply).toHaveBeenCalledTimes(2)
    fireEvent.click(b.view.getByRole('button', { name: '重新打开' }))
    await waitFor(() => expect((b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.click(b.view.getByRole('button', { name: '返回频道' }))
    expect(await b.view.findByRole('heading', { name: '# backend' })).toBeTruthy()
    await waitFor(() => expect(b.view.queryByText('agent reply')).toBeNull())
    await b.runtime.dispose()
  })

  it("shows the Host's own unread on the Channel feed's Thread entries and drops it with the slice", async () => {
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seededMessages: [{ body: '开工任务', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    // The unfiltered Inbox slice: this Thread needs the Human for 150 facts of
    // which only one is a mention, so the badge is not a mention count.
    b.seedInbox([{
      workspaceId: 'w1', channelRef: 'channel:engineering',
      thread: { threadRef: 'thread:1', taskRef: 'task:1', revision: 4 },
      unreadCount: 150, directCount: 1, newestSequence: 9, newestOccurredAt: '2026-08-21T09:30:00.000Z',
    }])
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    // The label carries the real number and the semantics; the capsule caps at 99+.
    const entry = await b.view.findByRole('button', { name: '打开 Task #1（150 条新动态）' })
    const row = entry.closest('article')!
    expect(within(row).getByText('99+')).toBeTruthy()
    expect(within(row).getByText('待处理')).toBeTruthy()
    // The state leads the entry's own line, on the reading path the body and the
    // door share — it never trails a line the reader has to cross the column
    // for, and a continuation row has no identity line to float on. It also
    // stays outside the door button, whose label would otherwise prune it.
    const entryLine = entry.parentElement!
    expect(entryLine.firstElementChild?.textContent).toBe('待处理99+')
    expect(entryLine.getAttribute('data-thread-entry')).toBe('')
    // A consumed Thread leaves no stale count behind: the next slice is empty.
    b.seedInbox([])
    b.seedInbox([])
    await waitFor(() => expect(within(row).queryByText('99+')).toBeNull())
    expect(b.view.getByRole('button', { name: '打开 Task #1' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps the last successful unread counts when the inbox read fails', async () => {
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seededMessages: [{ body: '开工任务', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    b.seedInbox([{
      workspaceId: 'w1', channelRef: 'channel:engineering',
      thread: { threadRef: 'thread:1', taskRef: 'task:1', revision: 4 },
      unreadCount: 150, directCount: 1, newestSequence: 9, newestOccurredAt: '2026-08-21T09:30:00.000Z',
    }])
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    await b.view.findByRole('button', { name: '打开 Task #1（150 条新动态）' })

    // The next wake's inbox read fails: a read failure must not read as
    // "everything was consumed". The counts keep the last successful slice —
    // the same policy the sidebar badge holds — while the failure itself
    // surfaces on the error face.
    ;(b.inbox as unknown as { mockImplementation(fn: () => Promise<unknown>): void })
      .mockImplementation(async () => ({ ok: false, error: { message: 'inbox read failed' } }))
    b.publishChannelUpdate()

    const alerts = await b.view.findAllByRole('alert')
    expect(alerts.some(node => node.textContent?.includes('inbox read failed'))).toBe(true)
    const entry = await b.view.findByRole('button', { name: '打开 Task #1（150 条新动态）' })
    expect(within(entry.closest('article')!).getByText('99+')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('stops printing activity on a resolved Task door', async () => {
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seedTaskStatus: 'done',
      seededMessages: [{ body: '已经完成的任务', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    // The reply is a newer fact than the opener, so follow-up activity exists —
    // the door is the only place that could print it.
    b.publishAgentReply()
    const door = await b.view.findByRole('button', { name: '打开 Task #1' })
    // A done Task already says nothing is moving, so the moment it resolved is
    // not repeated on every finished row; the precise instant stays one hover
    // away.
    expect(door.textContent).toBe('Task #1')
    expect(door.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    await b.runtime.dispose()
  })

  it('keeps printing activity on a taskless discussion, which never resolves', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    fireEvent.change(await b.view.findByRole('textbox', { name: '消息内容' }), { target: { value: 'plain thread' } })
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(b.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ asTask: false })))
    b.publishAgentReply()
    // A discussion wears no status word, dot, or owner stack, and it has no
    // terminal state: recency is the whole of what its door can say.
    const door = await b.view.findByRole('button', { name: '打开讨论' })
    expect(door.textContent).toContain('最近活动')
    await b.runtime.dispose()
  })

  it('linkifies branded refs in agent plain-prose bodies that skip the mention path', async () => {
    const taskRef = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e31'
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seedTaskRef: taskRef, seedThreadRef: 'thread:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e32',
      seededMessages: [
        { body: `ref 样本：本 Task 是 ${taskRef}，对照散文 channel:engineering 应保持纯文本。`, occurredAt: '2026-08-21T09:00:00.000Z', sender: 'agent' },
      ],
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    // The Agent body has no mentions, so it previously fell through to the
    // Markdown renderer and dropped the ref link entirely. The known Task
    // resolves to its number and links at the authored position.
    const link = await b.view.findByRole('button', { name: 'Task #1' })
    fireEvent.click(link)
    await waitFor(() => expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ taskRef })))
    await b.runtime.dispose()
  })

  it('resolves unknown task refs to task numbers and navigates on click', async () => {
    const citedRef = 'task:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6c'
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seedTaskRef: 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e51', seedThreadRef: 'thread:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e52',
      seededMessages: [{ body: `看 ${citedRef}`, occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    // The cited ref is not in the loaded timeline: it stays plain text until
    // the Host lookup resolves it, then relabels to the human-facing number.
    const link = await b.view.findByRole('button', { name: 'Task #2' })
    await waitFor(() => { expect(b.resolveTaskRefs).toHaveBeenCalled() })
    // The Host knows the cited Task: the label becomes the human-facing
    // number with the full ref on hover.
    expect(link.getAttribute('title')).toBe(citedRef)
    fireEvent.click(link)
    await waitFor(() => expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ taskRef: citedRef })))
    await b.runtime.dispose()
  })

  it('resolves abbreviated task refs in agent bodies and navigates with the full ref', async () => {
    const citedRef = 'task:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6c'
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seedTaskRef: 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e51', seedThreadRef: 'thread:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e52',
      seededMessages: [{ body: '审计来源 task:9c1b02，对照散文 task:cafe 保持纯文本', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    // The 6-hex abbreviation resolves uniquely through the Host lookup; the
    // link relabels to the number and jumps to the full ref's Thread.
    const link = await b.view.findByRole('button', { name: 'Task #2' })
    expect(link.getAttribute('title')).toBe('task:9c1b02')
    expect(b.view.getByText('task:cafe', { exact: false })).toBeTruthy()
    fireEvent.click(link)
    await waitFor(() => expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ taskRef: citedRef })))
    await b.runtime.dispose()
  })

  it('confirms early acceptance and lists the Claims completed with it', async () => {
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seedTaskStatus: 'in_progress',
      seededMessages: [{ body: '开工任务', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    // The active Claim arrives with the agent activity refresh.
    b.publishAgentReply()
    // The in_progress Task's entry leads with its live Claim owner and its
    // status word: ownership and state ride the row that opens the Thread,
    // instead of the old always-on pill or a line's far end. The owner stack
    // keeps its own label because it sits outside the door button.
    const claimEntry = await b.view.findByRole('button', { name: '打开 Task #1' })
    const claimLine = claimEntry.parentElement!
    expect(within(claimLine).getByRole('img', { name: '由 @builder 处理' })).toBeTruthy()
    expect(claimLine.firstElementChild?.textContent).toContain('进行中')
    fireEvent.click(claimEntry)
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()

    // An in_progress Task with an open Claim offers acceptance behind a
    // confirm dialog that lists exactly what will be completed.
    const acceptButton = await b.view.findByRole('button', { name: '验收' })
    fireEvent.click(acceptButton)
    const dialog = b.view.getByRole('dialog', { name: '提前验收任务' })
    expect(within(dialog).getByText(/将验收本 Task/)).toBeTruthy()
    expect(within(dialog).getByText('@builder · Implement API')).toBeTruthy()

    // Cancel closes without any remote call. Two controls share the label
    // (the dialog X and the footer action); the text-bearing one is ours.
    const cancelButton = within(dialog).getAllByRole('button', { name: '取消' }).find(button => button.textContent === '取消')
    fireEvent.click(cancelButton!)
    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '提前验收任务' })).toBeNull())
    expect(b.changeTask).not.toHaveBeenCalled()

    // Confirm runs exactly one accept.
    fireEvent.click(b.view.getByRole('button', { name: '验收' }))
    fireEvent.click(within(b.view.getByRole('dialog', { name: '提前验收任务' })).getByRole('button', { name: '验收' }))
    await waitFor(() => expect(b.changeTask).toHaveBeenCalledTimes(1))
    expect(b.changeTask).toHaveBeenCalledWith(expect.objectContaining({ action: 'accept' }))
    await b.runtime.dispose()
  })

  it('expands @all into every eligible channel member at pick time', async () => {
    const b = await runtimeWithTeam()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    fireEvent.click(await b.view.findByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'standup' } })
    // builder, worker, and failed join; offline (unavailable) does not.
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /worker/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /failed/ }))
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: '# standup' }))
    expect(await b.view.findByRole('heading', { name: '# standup' })).toBeTruthy()

    const input = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    // Typing a prefix of "all" surfaces the fixed expansion row on top.
    fireEvent.change(input, { target: { value: '请评审 @a' } })
    const allOption = await b.view.findByRole('option', { name: /@all/ })
    expect(allOption.textContent).toContain('通知所有成员')

    // Keyboard: ArrowDown highlights @all first; Tab accepts it.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(allOption.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input.value).toBe('请评审 @all ')

    // The notify row lists the expansion snapshot: every channel member
    // whose presence is not unavailable — failed is error, not offline.
    await waitFor(() => expect(b.view.getByText(/将通知/).textContent).toContain('@builder'))
    expect(b.view.getByText(/将通知/).textContent).toContain('@worker')
    expect(b.view.getByText(/将通知/).textContent).toContain('@failed')
    expect(b.view.getByText(/将通知/).textContent).not.toContain('@offline')

    // Editing the text after the expansion must not prune the recipients:
    // their handles are not in the body, only the @all marker is.
    fireEvent.change(input, { target: { value: '请评审 @all，今天截止' } })
    await waitFor(() => expect(b.view.getByText(/将通知/).textContent).toContain('@worker'))

    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(b.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      body: '请评审 @all，今天截止',
      recipients: ['member:builder', 'member:failed', 'member:worker'],
    })))
    await b.runtime.dispose()
  })

  it('previews a hand-typed mention without turning it into an explicit recipient', async () => {
    const b = await runtimeWithTeam()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    fireEvent.click(await b.view.findByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'review' } })
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: '# review' }))
    expect(await b.view.findByRole('heading', { name: '# review' })).toBeTruthy()
    const input = await b.view.findByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement

    // No pick from the mention menu: the row still reports the name the Host
    // will resolve out of the body, and drops it when the text loses the name.
    fireEvent.change(input, { target: { value: '请 @builder 看一下' } })
    await waitFor(() => expect(b.view.getByText(/将通知/).textContent).toContain('@builder'))
    fireEvent.change(input, { target: { value: '请看一下' } })
    await waitFor(() => expect(b.view.queryByText(/将通知/)).toBeNull())

    // The Host owns body resolution: the payload keeps explicit recipients
    // empty, because a name the Channel cannot reach is prose, not a target.
    fireEvent.change(input, { target: { value: '请 @builder 看一下' } })
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(b.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      body: '请 @builder 看一下',
      recipients: [],
    })))
    await b.runtime.dispose()
  })

  it('accepts an unclaimed todo Task directly without a confirm dialog', async () => {
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seededMessages: [{ body: '外部完成的任务', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('button', { name: '打开 Task #1' }))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    // The default seed is a todo Task with no Claims: acceptance is offered
    // and runs immediately, with no early-acceptance dialog to confirm.
    const acceptButton = await b.view.findByRole('button', { name: '验收' })
    fireEvent.click(acceptButton)
    await waitFor(() => expect(b.changeTask).toHaveBeenCalledTimes(1))
    expect(b.changeTask).toHaveBeenCalledWith(expect.objectContaining({ action: 'accept' }))
    expect(b.view.queryByRole('dialog', { name: '提前验收任务' })).toBeNull()
    await b.runtime.dispose()
  })

  it('renders resolved Task refs inline in rich Agent Markdown, styled code spans included', async () => {
    const taskRef = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e41'
    const unknownRef = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e43'
    const inlineCodeRef = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e44'
    const fencedCodeRef = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e45'
    const linkedRef = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e46'
    const mixedCodeRef = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e47'
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seedTaskRef: taskRef, seedThreadRef: 'thread:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e42',
      seededMessages: [{
        body: `需求源头：${taskRef} 与 \`${taskRef}\`\n\n- **已核实**\n- 未知任务：${unknownRef}\n- 行内代码：\`${inlineCodeRef}\`\n- 混合代码：\`编号 ${mixedCodeRef}\`\n- [已有链接 ${linkedRef}](https://example.com/source)\n\n\`\`\`text\n${fencedCodeRef}\n\`\`\``,
        occurredAt: '2026-08-21T09:00:00.000Z',
        sender: 'agent',
      }],
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))

    // Prose refs and code spans holding exactly one ref resolve to the
    // human-facing number; fenced blocks, mixed-content code spans, and
    // existing links stay exactly as Markdown rendered them.
    const links = await b.view.findAllByRole('button', { name: 'Task #1' })
    expect(links).toHaveLength(2)
    expect(links.map(link => link.getAttribute('title'))).toEqual([taskRef, taskRef])
    expect(b.view.queryByText(taskRef)).toBeNull()
    expect(b.view.getByText('已核实').tagName).toBe('STRONG')
    expect(b.view.getByText(unknownRef, { exact: false })).toBeTruthy()
    expect(b.view.getByText(inlineCodeRef).tagName).toBe('CODE')
    const mixedCode = [...b.view.container.querySelectorAll('code')].filter(code => code.textContent?.includes(mixedCodeRef))
    expect(mixedCode).toHaveLength(1)
    expect(mixedCode[0]!.closest('pre')).toBeNull()
    expect(b.view.getByText(fencedCodeRef).closest('pre')).not.toBeNull()
    expect(b.view.getByRole('link', { name: `已有链接 ${linkedRef}` }).getAttribute('href')).toBe('https://example.com/source')
    await waitFor(() => expect(b.resolveTaskRefs).toHaveBeenCalledWith(expect.objectContaining({ taskRefs: [taskRef, unknownRef, inlineCodeRef] })))

    fireEvent.click(links[0]!)
    await waitFor(() => expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ taskRef })))
    await b.runtime.dispose()
  })

  it('renders a Lead-style dispatch: doubled-colon ref resolves and the spelled mention chipifies inline', async () => {
    const auditRef = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e61'
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seedTaskRef: auditRef, seedThreadRef: 'thread:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e62',
      seededMessages: [{
        body: '@builder 实施 Client 的结构重构，来源于审计 Task `task::0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e61`：\n\n1. 先读 audit scratch 与现有 tests\n2. 回复边界后再 Claim\n\n完成后由 Lead 复核。',
        occurredAt: '2026-08-28T11:00:00.000Z',
        sender: 'agent',
        mentions: ['member:builder'],
      }],
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))

    // The message is rich Markdown: the spelled handle chipifies at its
    // prose position and the trailing fallback row stays empty entirely.
    const messageRow = await waitFor(() => {
      const row = [...b.view.container.querySelectorAll('[data-team-channel] article')]
        .find(article => article.textContent?.includes('实施 Client 的结构重构'))
      expect(row).toBeTruthy()
      return row!
    })
    const chips = [...messageRow.querySelectorAll('span')]
      .filter(span => span.textContent === '@builder' && [...span.classList].some(className => className.includes('mention')))
    expect(chips).toHaveLength(1)
    expect([...messageRow.querySelectorAll('div')].some(div => [...div.classList].some(className => className.includes('mentionsRow')))).toBe(false)

    // The model's doubled-colon spelling resolves to the same Task: the
    // chip shows the human-facing number and navigates with the canonical ref.
    const link = await b.view.findByRole('button', { name: 'Task #1' })
    expect(link.getAttribute('title')).toBe(auditRef)
    fireEvent.click(link)
    await waitFor(() => expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ taskRef: auditRef })))
    await b.runtime.dispose()
  })

  it('uploads composer attachments as chips, sends their ids, and renders the strip', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    // Let the browser's one-time workspace selection settle first; a late
    // selectWorkspace would strip the channel ref mid-test.
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-workspace-trigger][aria-current="page"]')?.textContent).toContain('Alpha') })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    const composer = b.view.container
    const chipCount = (): number => composer.querySelectorAll('ul[aria-label="添加附件"] > li').length

    // The "+" picker adds chips; the remove button drops one.
    const input = composer.querySelector('input[type="file"]') as HTMLInputElement
    const png = new File(['png'], 'shot.png', { type: 'image/png' })
    const pdf = new File(['pdf'], 'spec.pdf', { type: 'application/pdf' })
    await waitFor(() => { fireEvent.change(input, { target: { files: [png, pdf] } }) })
    await waitFor(() => { expect(chipCount()).toBe(2) })
    // Image drafts render an inline preview card; documents stay text cards.
    const chips = [...composer.querySelectorAll('ul[aria-label="添加附件"] > li')]
    expect(chips.find(chip => chip.textContent?.includes('shot.png'))?.querySelector('img')).toBeTruthy()
    expect(chips.find(chip => chip.textContent?.includes('spec.pdf'))?.querySelector('img')).toBeNull()
    fireEvent.click(composer.querySelector('[class*="fileChipRemove"]') as HTMLButtonElement)
    await waitFor(() => { expect(chipCount()).toBe(1) })
    expect(composer.querySelector('[class*="fileChipName"]')?.textContent).toBe('spec.pdf3 B')
    expect(composer.querySelector('[class*="fileChipSize"]')?.textContent).toBe('3 B')

    // Sending uploads the remaining file and passes its id to sendMessage.
    fireEvent.change(b.view.getByRole('textbox', { name: '消息内容' }), { target: { value: '带附件' } })
    fireEvent.click(b.view.getByRole('button', { name: '作为任务' }))
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(b.putAttachment).toHaveBeenCalledWith(expect.objectContaining({ name: 'spec.pdf', mediaType: 'application/pdf' })) })
    await waitFor(() => { expect(b.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ body: '带附件', attachments: ['attachment:1'] })) })
    // Committed send clears the chips along with the draft...
    await waitFor(() => { expect(chipCount()).toBe(0) })
    // ...and the echoed message renders its image as a thumbnail.
    await waitFor(() => { expect(composer.querySelector('img[src^="data:image/png"]')).toBeTruthy() })

    // A second message whose bytes the Host no longer caches (GC'd) degrades
    // to an expiry chip: history stays honest about what was shared.
    await waitFor(() => { fireEvent.change(input, { target: { files: [new File(['gone'], 'expired.png', { type: 'image/png' })] } }) })
    await waitFor(() => { expect(chipCount()).toBe(1) })
    fireEvent.change(b.view.getByRole('textbox', { name: '消息内容' }), { target: { value: '图已过期' } })
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      const chips = [...b.view.container.querySelectorAll('[class*="attachmentChip"]')]
      return expect(chips.some(chip => chip.textContent?.includes('文件已过期清理'))).toBe(true)
    }, { timeout: 4000 })
    await b.runtime.dispose()
  })

  it('uploads thread reply attachments and passes their ids to reply', async () => {
    const b = await runtimeWithTeam({ initialChannels: true, remainingUnreadCounts: [1], seededMessages: [{ body: '开个任务', occurredAt: '2026-08-21T09:00:00.000Z' }] })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('button', { name: '打开 Task #1' }))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    const composer = b.view.container
    const chipCount = (): number => composer.querySelectorAll('ul[aria-label="添加附件"] > li').length

    // The reply composer offers the same "+" picker as the Channel composer.
    const input = composer.querySelector('input[type="file"]') as HTMLInputElement
    await waitFor(() => { fireEvent.change(input, { target: { files: [new File(['png'], 'evidence.png', { type: 'image/png' })] } }) })
    await waitFor(() => { expect(chipCount()).toBe(1) })

    fireEvent.change(b.view.getByRole('textbox', { name: '消息内容' }), { target: { value: '带截图的回复' } })
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(b.putAttachment).toHaveBeenCalledWith(expect.objectContaining({ name: 'evidence.png', mediaType: 'image/png' })) })
    await waitFor(() => { expect(b.reply).toHaveBeenCalledWith(expect.objectContaining({ body: '带截图的回复', attachments: ['attachment:1'] })) })
    // Committed reply clears the chips along with the draft.
    await waitFor(() => { expect(chipCount()).toBe(0) })
    expect(await b.view.findByText('带截图的回复')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('turns pasted clipboard files into composer chips and sends their ids', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-workspace-trigger][aria-current="page"]')?.textContent).toContain('Alpha') })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    const composer = b.view.container
    const chipCount = (): number => composer.querySelectorAll('ul[aria-label="添加附件"] > li').length
    const textarea = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement

    // A paste carrying files is intercepted and joins the same chip flow.
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => new File(['shot'], 'image.png', { type: 'image/png' }) }],
        getData: () => '',
      },
    })
    await waitFor(() => { expect(chipCount()).toBe(1) })
    expect(composer.querySelector('[class*="fileChipName"]')?.textContent).toContain('image.png')

    // Plain-text pastes keep the browser's native insertion: no chip, and the
    // text lands in the draft untouched.
    fireEvent.paste(textarea, {
      clipboardData: { items: [], getData: () => 'pasted note' },
    })
    expect(chipCount()).toBe(1)

    fireEvent.change(textarea, { target: { value: '粘贴的截图' } })
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => { expect(b.putAttachment).toHaveBeenCalledWith(expect.objectContaining({ name: 'image.png', mediaType: 'image/png' })) })
    await waitFor(() => { expect(b.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ body: '粘贴的截图', attachments: ['attachment:1'] })) })
    await waitFor(() => { expect(chipCount()).toBe(0) })
    await b.runtime.dispose()
  })

  it('caches composer drafts across view switches and clears them on committed sends', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    // A second Channel gives the draft somewhere to switch away to.
    fireEvent.click(await b.view.findByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'API' } })
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()

    const input = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'engineering draft' } })
    // Writes go straight through to the persisted cache.
    expect(JSON.parse(localStorage.getItem(TEAM_DRAFTS_STORAGE_KEY) ?? '{}')).toMatchObject({
      'channel:channel:engineering': { draft: 'engineering draft', recipientIds: [] },
    })

    // Switching views unmounts the page; returning restores from the cache.
    fireEvent.click(b.view.getByRole('button', { name: '# backend' }))
    expect(await b.view.findByRole('heading', { name: '# backend' })).toBeTruthy()
    expect((b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('')
    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    await waitFor(() => {
      const restored = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
      return expect(restored.value).toBe('engineering draft')
    })

    // Failed sends keep the cached draft...
    b.sendMessage.mockResolvedValueOnce({ ok: false, error: { message: 'send failed' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect((await b.view.findByRole('alert')).textContent).toContain('send failed')
    expect((b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('engineering draft')
    // ...and a committed send drops the key entirely.
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(TEAM_DRAFTS_STORAGE_KEY) ?? '{}') as Record<string, unknown>
      expect(stored['channel:channel:engineering']).toBeUndefined()
    })
    expect((b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement).value).toBe('')
    await b.runtime.dispose()
  })

  it('rehydrates drafts from localStorage and prunes stale recipients on restore', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    // Open the seeded Channel first so the browser's one-time workspace
    // selection settles before the new Channel row is clicked.
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'API' } })
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: '# backend' }))
    expect(await b.view.findByRole('heading', { name: '# backend' })).toBeTruthy()

    // Seed the cache under the Channel's REAL ref, then reload — the same
    // content a fresh page load would rehydrate for this view.
    const channelRef = b.runtime.ctx.teamNavigation.getSnapshot().channelRef!
    localStorage.setItem(TEAM_DRAFTS_STORAGE_KEY, JSON.stringify({
      [`channel:${channelRef}`]: {
        draft: 'hello team @builder',
        recipientIds: ['member:builder', 'member:ghost'],
        savedAt: Date.now(),
      },
    }))
    b.runtime.ctx.teamDrafts.reload()

    // The restored text lands in the composer untouched...
    await waitFor(() => {
      const input = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
      return expect(input.value).toBe('hello team @builder')
    })
    // ...while the Composer's convergence pass rewrites the cached entry with
    // only the recipients that are known Members still named in the draft.
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem(TEAM_DRAFTS_STORAGE_KEY) ?? '{}') as Record<string, { recipientIds: string[] }>
      return expect(stored[`channel:${channelRef}`]?.recipientIds).toEqual(['member:builder'])
    })
    await b.runtime.dispose()
  })

  it('opens a Thread and performs one baseline catch-up without repeated reads', async () => {
    const b = await runtimeWithTeam()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    fireEvent.click(await b.view.findByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'API' } })
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: '# backend' }))
    expect(await b.view.findByRole('heading', { name: '# backend' })).toBeTruthy()
    const messageInput = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    fireEvent.change(messageInput, { target: { value: 'first task' } })
    fireEvent.click(b.view.getByRole('button', { name: '作为任务' }))
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect(await b.view.findByText('first task')).toBeTruthy()

    b.readThread.mockClear()
    b.loadThreadHistory.mockClear()
    b.threadObservations.mockClear()
    b.members.mockClear()
    b.viewChannels.mockClear()
    b.changes.mockClear()
    fireEvent.click(b.view.getByRole('button', { name: '打开 Task #1' }))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    await vi.waitFor(() => expect(b.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 20 })))
    await vi.waitFor(() => expect(b.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 100 })))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.readThread).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(b.threadObservations).toHaveBeenCalledTimes(2))

    // The stream baseline closes the read/subscribe gap. Private reads must
    // not trigger further rounds after that bounded catch-up.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(b.readThread).toHaveBeenCalledTimes(1)
    expect(b.loadThreadHistory).toHaveBeenCalledTimes(2)
    expect(b.members).toHaveBeenCalledTimes(1)
    expect(b.viewChannels).toHaveBeenCalledTimes(1)

    // The page waits on its own thread scope. The workspace presence scope
    // rides the shared subscription the always-mounted sidebar Agents section holds:
    // opening a Thread must not open a second workspace subscription.
    const scopedCalls = b.changes.mock.calls.filter(([request]) => request.scope !== undefined)
    const scopes = scopedCalls.map(([request]) => request.scope as { kind: string; threadRef?: string })
    expect(scopes.some(scope => scope.kind === 'thread' && scope.threadRef === 'thread:1')).toBe(true)
    expect(scopes.some(scope => scope.kind === 'workspace')).toBe(false)
    for (const [, signal] of scopedCalls) expect(signal).toBeInstanceOf(AbortSignal)
    await b.runtime.dispose()
  })

  it('keeps the older-facts affordance when the history read fails, and recovers through it', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true,
      seededMessages: [{ body: 'capped history', occurredAt: '2026-09-13T03:00:00.000Z' }] })
    // The first paint's history read is the only source of the older-facts
    // cursor: a failed one must not take the affordance down with it, or the
    // Thread's older facts stay unreachable for the life of the page.
    b.failThreadHistory('history unavailable (spec)')
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('button', { name: '打开 Task #1' }))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    const affordance = await b.view.findByRole('button', { name: '加载更早消息' })
    // The affordance stands and is itself the retry: its failure is loud...
    fireEvent.click(affordance)
    expect(await b.view.findByText('history unavailable (spec)')).toBeTruthy()
    // ...and a successful press retires it, so the page never strands the reader.
    b.failThreadHistory(undefined)
    fireEvent.click(b.view.getByRole('button', { name: '加载更早消息' }))
    await waitFor(() => expect(b.view.queryByRole('button', { name: '加载更早消息' })).toBeNull())
    await b.runtime.dispose()
  })

  it('ranks Thread followers first among mention candidates and scrolls the highlighted row into view', async () => {
    const taskRef = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e71'
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seedTaskRef: taskRef, seedThreadRef: 'thread:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e72',
      seedFollowers: ['member:worker'],
      seededMessages: [{ body: 'rank task', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    // jsdom has no layout engine, so the scroll fix is observed through the
    // call the highlighted row makes, not through real offsets.
    const prototype = window.HTMLElement.prototype as { scrollIntoView?: (options?: { block?: string }) => void }
    const originalScrollIntoView = prototype.scrollIntoView
    const scrollIntoView = vi.fn()
    prototype.scrollIntoView = scrollIntoView
    try {
      fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
      fireEvent.click(await b.view.findByRole('button', { name: '打开 Task #1' }))
      const replyInput = await b.view.findByRole('textbox', { name: '消息内容' })
      fireEvent.change(replyInput, { target: { value: '@' } })
      const replyMenu = await b.view.findByRole('listbox')
      // The seeded Channel has no membership rows, so the Thread composer sees
      // the whole roster; the follower ranks above that roster order once the
      // observation read from the first paint round lands.
      await waitFor(() => expect(within(replyMenu).getAllByRole('option').map(option => option.textContent)).toEqual([
        expect.stringContaining('@all'),
        expect.stringContaining('@worker'),
        expect.stringContaining('@builder'),
        expect.stringContaining('@failed'),
      ]))
      fireEvent.keyDown(replyInput, { key: 'ArrowDown' })
      fireEvent.keyDown(replyInput, { key: 'ArrowDown' })
      expect(within(replyMenu).getAllByRole('option')[2]?.getAttribute('aria-selected')).toBe('true')
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    } finally {
      if (originalScrollIntoView === undefined) delete prototype.scrollIntoView
      else prototype.scrollIntoView = originalScrollIntoView
      await b.runtime.dispose()
    }
  })

  it('restores persisted Team mode, reconciles a stale Workspace, renders the rail, and unloads cleanly', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'stale' })
    expect(await b.view.findByRole('heading', { name: '频道' })).toBeTruthy()
    await vi.waitFor(() => expect(b.runtime.ctx.teamNavigation.getSnapshot().workspaceId).toBe('w1'))

    fireEvent.click(b.view.getByRole('button', { name: 'Toggle fixture sidebar' }))
    await waitFor(() => { expect(b.view.getByRole('button', { name: '频道' })).toBeTruthy() })
    expect(b.view.getByRole('button', { name: '对话' })).toBeTruthy()
    expect(b.view.getByRole('button', { name: '频道' })).toBeTruthy()
    expect(b.view.queryByRole('button', { name: '新建工作区' })).toBeNull()
    expect(normalizeSidebarChrome(b.view.container)).toMatchSnapshot()

    await b.team.dispose()
    expect(await b.view.findByText('普通工作区')).toBeTruthy()
    // The conversation seat keeps the shipped ConversationRoot after the Team
    // plugin unloads; its resident composer seat stands in for the old
    // baseline double's text.
    expect(b.view.container.querySelector('[data-composer-seat]')).toBeTruthy()
    expect(await b.view.findByText('设置')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('states the current Workspace on one line and switches through its menu', async () => {
    const b = await runtimeWithTeam({ mode: 'team' })
    expect(await b.view.findByRole('heading', { name: '频道' })).toBeTruthy()
    // The selector renders in the wide sidebar only, and collapsing the fixture
    // keeps that wide surface mounted for another 150ms (SidebarRoot's collapse
    // settle) before the rail replaces it. Every assertion below reads the wide
    // surface, so this test leaves the sidebar width alone: the collapse click
    // it used to fire raced that window, and the last assertion lost the race on
    // a slow lane. The rail keeps its own coverage in the toggle test above.
    // The selected Workspace is the trigger's own text and its accessible name:
    // a reader who cannot see the field still learns which one is stated. The
    // others are not rows on the surface, so the sections below read as that
    // Workspace's content.
    const trigger = await b.view.findByRole('button', { name: '工作区，Alpha' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.textContent).toContain('Alpha')
    expect(b.view.queryByRole('button', { name: '工作区' })).toBeNull()
    expect(b.view.queryByRole('button', { name: 'Beta' })).toBeNull()
    // The Inbox crosses Workspaces, so it stands above the selector that scopes
    // the sections below it.
    const inboxCard = b.view.getByRole('button', { name: /^收件箱/ })
    expect(inboxCard.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    // The menu list is a portal the loaded runtime can re-render between the
    // query and the click, so a click can land on a detached node and be lost.
    // Retry the interaction — not just the assertion — until the selection
    // actually moves the navigation snapshot.
    await waitFor(() => {
      fireEvent.click(within(document.body).getByRole('menuitem', { name: 'Beta' }))
      expect(b.runtime.ctx.teamNavigation.getSnapshot().workspaceId).toBe('w2')
    })
    await waitFor(() => { expect(b.view.getByRole('button', { name: '工作区，Beta' })).toBeTruthy() })
    // Picking closes the menu and leaves the content sections standing.
    expect(b.view.getByRole('button', { name: '工作区，Beta' }).getAttribute('aria-expanded')).toBe('false')
    expect(b.view.getByRole('button', { name: '频道' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('acknowledges off-screen arrivals automatically and keeps only a pure jump hint', async () => {
    const b = await runtimeWithTeam()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    fireEvent.click(await b.view.findByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'API' } })
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: '# backend' }))
    expect(await b.view.findByRole('heading', { name: '# backend' })).toBeTruthy()
    const messageInput = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    fireEvent.change(messageInput, { target: { value: 'first task' } })
    fireEvent.click(b.view.getByRole('button', { name: '作为任务' }))
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect(await b.view.findByText('first task')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '打开 Task #1' }))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    await vi.waitFor(() => expect(b.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 20 })))
    await vi.waitFor(() => expect(b.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 100 })))
    await new Promise(resolve => setTimeout(resolve, 20))

    const anchor = { messageRef: 'message:anchor', channelRef: 'channel:1', threadRef: 'thread:1', taskRef: 'task:1',
      sender: 'member:human', body: 'first task', topLevel: true, sequence: 2, occurredAt: '' }
    const historyWith = (facts: unknown[]) => b.loadThreadHistory.mockImplementation(async () => ({ ok: true as const, value: {
      task: { taskRef: 'task:1', channelRef: 'channel:1', status: 'todo', resolution: 'open' },
      thread: { threadRef: 'thread:1', revision: 2 }, anchor, claims: [], facts, cursor: 0, hasMore: false,
    } } as never))
    const backfillFact = { kind: 'message', sequence: 1, message: { messageRef: 'message:old-1', channelRef: 'channel:1', threadRef: 'thread:1',
      taskRef: 'task:1', sender: 'member:human', body: 'old backfill', topLevel: false, sequence: 1, occurredAt: '' }, mentions: [] }


    // Backfill from the wider passive window is already-read material, not news.
    historyWith([backfillFact])
    b.publishAgentReply()
    await waitFor(() => expect(b.loadThreadHistory).toHaveBeenLastCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 100 })))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.view.queryByText(/↓ \d+ 条新更新/)).toBeNull()

    // A reader scrolled away from the tail still gets every arrival
    // acknowledged durably; the only on-screen affordance is the pure jump
    // hint, which carries no read semantics.
    const timelineSection = document.querySelector('section[aria-label="消息时间线"]') as HTMLElement
    Object.defineProperty(timelineSection, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(timelineSection, 'clientHeight', { configurable: true, value: 120 })
    fireEvent.scroll(timelineSection)

    historyWith([{ ...backfillFact, sequence: 9, message: { ...backfillFact.message, messageRef: 'message:new-9', body: 'genuinely new', sequence: 9 } }])
    b.publishAgentReply()
    await waitFor(() => expect(b.readThread).toHaveBeenCalledTimes(2))
    expect(await b.view.findByText('↓ 1 条新更新')).toBeTruthy()
    expect(b.view.queryByRole('button', { name: '标记为已读' })).toBeNull()

    // The hint click scrolls to the tail, performs no read itself, and is
    // the reader's answer: the hint clears immediately on the click.
    fireEvent.click(b.view.getByRole('button', { name: '↓ 1 条新更新' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.readThread).toHaveBeenCalledTimes(2)
    expect(b.view.queryByText(/↓ \d+ 条新更新/)).toBeNull()
    await b.runtime.dispose()
  })

  it('drops the jump hint the moment the reader returns to the tail', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-workspace-trigger][aria-current="page"]')?.textContent).toContain('Alpha') })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    const messageInput = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    fireEvent.change(messageInput, { target: { value: 'first task' } })
    fireEvent.click(b.view.getByRole('button', { name: '作为任务' }))
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect(await b.view.findByText('first task')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '打开 Task #1' }))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    await vi.waitFor(() => expect(b.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 20 })))
    await vi.waitFor(() => expect(b.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 100 })))
    await new Promise(resolve => setTimeout(resolve, 20))

    const anchor = { messageRef: 'message:anchor', channelRef: 'channel:1', threadRef: 'thread:1', taskRef: 'task:1',
      sender: 'member:human', body: 'first task', topLevel: true, sequence: 2, occurredAt: '' }
    const newFact = { kind: 'message', sequence: 9, message: { messageRef: 'message:new-9', channelRef: 'channel:1', threadRef: 'thread:1',
      taskRef: 'task:1', sender: 'member:builder', body: 'fresh arrival one', topLevel: false, sequence: 9, occurredAt: '' }, mentions: [] }
    const nextFact = { kind: 'message', sequence: 10, message: { messageRef: 'message:new-10', channelRef: 'channel:1', threadRef: 'thread:1',
      taskRef: 'task:1', sender: 'member:builder', body: 'fresh arrival two', topLevel: false, sequence: 10, occurredAt: '' }, mentions: [] }
    const historyWith = (facts: unknown[]) => b.loadThreadHistory.mockImplementation(async () => ({ ok: true as const, value: {
      task: { taskRef: 'task:1', channelRef: 'channel:1', status: 'todo', resolution: 'open' },
      thread: { threadRef: 'thread:1', revision: 3 }, anchor, claims: [], facts, cursor: 0, hasMore: false,
    } } as never))

    historyWith([])

    const timelineSection = document.querySelector('section[aria-label="消息时间线"]') as HTMLElement
    Object.defineProperty(timelineSection, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(timelineSection, 'clientHeight', { configurable: true, value: 120 })
    fireEvent.scroll(timelineSection)

    // A reader away from the tail gets the hint for the arrival...
    historyWith([newFact])
    b.publishAgentReply()
    expect(await b.view.findByText('↓ 1 条新更新')).toBeTruthy()

    // ...and scrolling back within the follow margin clears it via the scroll
    // event alone, without any other re-render in between.
    Object.defineProperty(timelineSection, 'scrollHeight', { configurable: true, value: 120 })
    fireEvent.scroll(timelineSection)
    await waitFor(() => expect(b.view.queryByText(/↓ \d+ 条新更新/)).toBeNull())

    // A fresh arrival while the reader is at the tail stays invisible to the
    // hint: the reader is watching the bottom, so the timeline follows them.
    historyWith([nextFact])
    b.publishAgentReply()
    expect(await b.view.findByText('fresh arrival two')).toBeTruthy()
    await waitFor(() => expect(b.view.queryByText(/↓ \d+ 条新更新/)).toBeNull())
    await b.runtime.dispose()
  })

  it('acknowledges arrivals a bottom-pinned reader is watching instead of prompting a manual read', async () => {
    const b = await runtimeWithTeam()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    fireEvent.click(await b.view.findByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'API' } })
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: '# backend' }))
    expect(await b.view.findByRole('heading', { name: '# backend' })).toBeTruthy()
    const messageInput = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    fireEvent.change(messageInput, { target: { value: 'first task' } })
    fireEvent.click(b.view.getByRole('button', { name: '作为任务' }))
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect(await b.view.findByText('first task')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '打开 Task #1' }))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    await vi.waitFor(() => expect(b.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 20 })))
    await vi.waitFor(() => expect(b.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 100 })))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.readThread).toHaveBeenCalledTimes(1)

    const anchor = { messageRef: 'message:anchor', channelRef: 'channel:1', threadRef: 'thread:1', taskRef: 'task:1',
      sender: 'member:human', body: 'first task', topLevel: true, sequence: 2, occurredAt: '' }
    const watchedFact = { kind: 'message', sequence: 9, message: { messageRef: 'message:new-9', channelRef: 'channel:1', threadRef: 'thread:1',
      taskRef: 'task:1', sender: 'member:builder', body: 'watched live', topLevel: false, sequence: 9, occurredAt: '' }, mentions: [] }
    b.loadThreadHistory.mockImplementation(async () => ({ ok: true as const, value: {
      task: { taskRef: 'task:1', channelRef: 'channel:1', status: 'todo', resolution: 'open' },
      thread: { threadRef: 'thread:1', revision: 3 }, anchor, claims: [], facts: [watchedFact], cursor: 0, hasMore: false,
    } } as never))


    // jsdom never scrolls the reader away from the bottom, so the arriving
    // fact renders in front of them and must be acknowledged durably rather
    // than surfaced as a jump hint.
    b.publishChannelUpdate()
    await waitFor(() => expect(b.view.queryByText(/↓ \d+ 条新更新/)).toBeNull())
    expect(await b.view.findByText('watched live')).toBeTruthy()
    await waitFor(() => expect(b.readThread).toHaveBeenCalledTimes(2))
    expect(b.view.queryByRole('button', { name: '标记为已读' })).toBeNull()
    await b.runtime.dispose()
  })

  it('drains a multi-round unread backlog automatically with fresh request ids', async () => {
    const b = await runtimeWithTeam({
      initialChannels: true, remainingUnreadCounts: [25, 5, 0],
      seededMessages: [{ body: '积压任务', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-workspace-trigger][aria-current="page"]')?.textContent).toContain('Alpha') })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('button', { name: '打开 Task #1' }))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()

    // The bounded batches drain in a serial loop: one read per round, each
    // with its own requestId, until the remainder reaches zero. No manual
    // continue-reading control exists anywhere in the flow.
    await waitFor(() => expect(b.readThread).toHaveBeenCalledTimes(3))
    const requestIds = b.readThread.mock.calls.map(([request]) => request.requestId)
    expect(new Set(requestIds).size).toBe(3)
    expect(b.view.queryByRole('button', { name: '继续阅读' })).toBeNull()
    expect(b.view.queryByText(/仍有未读更新未能自动读取/)).toBeNull()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(b.readThread).toHaveBeenCalledTimes(3)
    await b.runtime.dispose()
  })

  it('keeps the jump hint when the automatic acknowledgment read fails', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-workspace-trigger][aria-current="page"]')?.textContent).toContain('Alpha') })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    const messageInput = b.view.getByRole('textbox', { name: '消息内容' }) as HTMLTextAreaElement
    fireEvent.change(messageInput, { target: { value: 'first task' } })
    fireEvent.click(b.view.getByRole('button', { name: '作为任务' }))
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect(await b.view.findByText('first task')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '打开 Task #1' }))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    await vi.waitFor(() => expect(b.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 20 })))
    await vi.waitFor(() => expect(b.loadThreadHistory).toHaveBeenCalledWith(expect.objectContaining({ taskRef: 'task:1', limit: 100 })))
    await new Promise(resolve => setTimeout(resolve, 20))

    const anchor = { messageRef: 'message:anchor', channelRef: 'channel:1', threadRef: 'thread:1', taskRef: 'task:1',
      sender: 'member:human', body: 'first task', topLevel: true, sequence: 2, occurredAt: '' }
    const failedFact = { kind: 'message', sequence: 9, message: { messageRef: 'message:new-9', channelRef: 'channel:1', threadRef: 'thread:1',
      taskRef: 'task:1', sender: 'member:builder', body: 'unacknowledged', topLevel: false, sequence: 9, occurredAt: '' }, mentions: [] }
    b.loadThreadHistory.mockImplementation(async () => ({ ok: true as const, value: {
      task: { taskRef: 'task:1', channelRef: 'channel:1', status: 'todo', resolution: 'open' },
      thread: { threadRef: 'thread:1', revision: 3 }, anchor, claims: [], facts: [failedFact], cursor: 0, hasMore: false,
    } } as never))


    // The reader sits away from the tail, so the arrival raises the hint;
    // the failed acknowledgment must not rob them of it — the hint is the
    // only affordance (with no manual read control to substitute for the
    // retry).
    const timelineSection = document.querySelector('section[aria-label="消息时间线"]') as HTMLElement
    Object.defineProperty(timelineSection, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(timelineSection, 'clientHeight', { configurable: true, value: 120 })
    fireEvent.scroll(timelineSection)

    b.readThread.mockRejectedValueOnce(new Error('acknowledgment transport failed') as never)
    b.publishChannelUpdate()
    // The durable read failed: the arrivals stay visible, the durable
    // acknowledgment surfaces as an error, and the pure jump hint remains
    // — still counting the arrival batch exactly once.
    await waitFor(() => { expect(b.view.getByText('↓ 1 条新更新')).toBeTruthy() })
    expect(await b.view.findByText('unacknowledged')).toBeTruthy()
    expect(await b.view.findByRole('alert')).toBeTruthy()
    expect(b.view.queryByRole('button', { name: '标记为已读' })).toBeNull()
    await b.runtime.dispose()
  })
  it('refreshes the sidebar Channel list from one workspace change', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await b.view.findByText('还没有频道')
    expect(b.view.queryByRole('button', { name: '# gamma' })).toBeNull()
    b.seedChannel({ channelRef: 'channel:gamma', workspaceId: 'w1', name: 'gamma', description: 'Gamma work', createdAtSequence: 2 })
    b.publishChannelUpdate()
    await b.view.findByRole('button', { name: '# gamma' })
    expect(b.view.queryByText('还没有频道')).toBeNull()
    await b.runtime.dispose()
  })

  it('anchors timeline days when messages span dates', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true, seededMessages: [
      { body: 'day one status', occurredAt: '2026-08-19T09:00:00.000Z' },
      { body: 'day two follow-up', occurredAt: '2026-08-21T04:00:00.000Z' },
    ] })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByText('day two follow-up')).toBeTruthy()
    // Exactly one quiet anchor for the crossed boundary; the first message of
    // the timeline opens its day without a leading marker.
    const dayAnchors = Array.from(b.view.container.querySelectorAll('p span')).filter(node => /^\d{2}-\d{2}$/.test(node.textContent ?? ''))
    expect(dayAnchors.map(node => node.textContent)).toEqual(['08-21'])
    await b.runtime.dispose()
  })

  it('separates wide same-sender gaps with a turn divider on both timelines', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true, seededMessages: [
      { body: 'burst one', occurredAt: '2026-08-21T09:00:00.000Z' },
      { body: 'burst two', occurredAt: '2026-08-21T09:01:00.000Z' },
      { body: 'later publication', occurredAt: '2026-08-21T11:30:00.000Z' },
    ] })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByText('later publication')).toBeTruthy()
    // Only the two-hour gap earns a divider; the one-minute burst stays a
    // seamless run, and the label carries the later message's instant.
    const channelDividers = b.view.getAllByRole('separator')
    expect(channelDividers).toHaveLength(1)
    expect(channelDividers[0]!.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-21T11:30:00.000Z')

    fireEvent.click(b.view.getAllByRole('button', { name: '打开 Task #1' })[0]!)
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    const threadDividers = b.view.getAllByRole('separator')
    expect(threadDividers).toHaveLength(1)
    expect(threadDividers[0]!.querySelector('time')?.getAttribute('datetime')).toBe('2026-08-21T11:30:00.000Z')
    await b.runtime.dispose()
  })

  it('linkifies branded refs in plain bodies and navigates on click', async () => {
    const taskRef = 'task:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e21'
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seedTaskRef: taskRef, seedThreadRef: 'thread:0f0ad7ce-11d3-4c05-8a9e-6f2b1c9d7e22',
      seededMessages: [{ body: `see ${taskRef} and channel:engineering for prose`, occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    // Only the fixed-prefix ref shape resolves; `channel:engineering` stays
    // literal prose. The known Task relabels to its number once resolved.
    expect(b.view.queryByText(taskRef)).toBeNull()
    const link = await b.view.findByRole('button', { name: 'Task #1' })
    expect(link.getAttribute('title')).toBe(taskRef)
    fireEvent.click(link)
    await waitFor(() => expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ taskRef })))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('sends a Channel message as a taskless Thread unless As task is pressed', async () => {
    const b = await runtimeWithTeam()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    fireEvent.click(await b.view.findByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'API' } })
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: '# backend' }))
    expect(await b.view.findByRole('heading', { name: '# backend' })).toBeTruthy()
    fireEvent.change(b.view.getByRole('textbox', { name: '消息内容' }), { target: { value: 'plain thread' } })
    expect(b.view.getByRole('button', { name: '作为任务' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(b.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ body: 'plain thread', asTask: false })))
    expect(await b.view.findByRole('button', { name: '打开讨论' })).toBeTruthy()
    expect(b.view.queryByRole('button', { name: '打开 Task #1' })).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: '打开讨论' }))
    expect(await b.view.findByRole('heading', { name: '讨论' })).toBeTruthy()
    expect(b.view.queryByRole('button', { name: /Claims/ })).toBeNull()
    expect(b.view.queryByRole('button', { name: '验收' })).toBeNull()
    expect(b.view.getByRole('button', { name: '转为 Task' })).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '转为 Task' }))
    await waitFor(() => expect(b.promoteThread).toHaveBeenCalledWith(expect.objectContaining({
      threadRef: 'thread:1',
    })))
    await waitFor(() => expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ threadRef: 'thread:1' })))
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    expect(b.view.queryByRole('button', { name: '转为 Task' })).toBeNull()
    await b.runtime.dispose()
  })

  it('resets As task after a committed Task send and keeps it after a failed send', async () => {
    const b = await runtimeWithTeam()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    fireEvent.click(await b.view.findByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: '# backend' }))
    expect(await b.view.findByRole('heading', { name: '# backend' })).toBeTruthy()
    const toggle = () => b.view.getByRole('button', { name: '作为任务' })
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(b.view.getByRole('textbox', { name: '消息内容' }), { target: { value: 'keep toggle' } })
    b.sendMessage.mockResolvedValueOnce({ ok: false, error: { message: 'send failed' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    expect((await b.view.findByRole('alert')).textContent).toContain('send failed')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(b.view.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(b.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'keep toggle', asTask: true })))
    await waitFor(() => expect(toggle().getAttribute('aria-pressed')).toBe('false'))
    await b.runtime.dispose()
  })
})
