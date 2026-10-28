// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('Team Project board', () => {
  it('switches feed and board through the header tabs and opens a Task card on the Thread level', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskStatus: 'todo', seededMessages: [
      { body: '实现 API 网关\n细节在 Thread 里', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    expect(b.view.container.querySelector('[data-team-project]')).toBeTruthy()
    // The feed is the default reading: its tab is selected, and both the
    // timeline entry and the composer stand in the content seat.
    const feedTab = b.view.getByRole('tab', { name: '主对话' })
    const boardTab = b.view.getByRole('tab', { name: '看板' })
    expect(feedTab.getAttribute('aria-selected')).toBe('true')
    expect(boardTab.getAttribute('aria-selected')).toBe('false')
    // The switch is a composite control: one tab stop for the group, and each
    // tab names the panel it controls.
    expect(feedTab.getAttribute('tabindex')).toBe('0')
    expect(boardTab.getAttribute('tabindex')).toBe('-1')
    expect(b.view.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(feedTab.id)
    expect(b.view.getByRole('button', { name: /^打开 Task #1：/ })).toBeTruthy()
    expect(b.view.getByRole('textbox', { name: '消息内容' })).toBeTruthy()

    fireEvent.click(boardTab)
    expect(boardTab.getAttribute('aria-selected')).toBe('true')
    expect(feedTab.getAttribute('aria-selected')).toBe('false')
    expect(boardTab.getAttribute('tabindex')).toBe('0')
    expect(feedTab.getAttribute('tabindex')).toBe('-1')
    expect(b.view.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(boardTab.id)
    // The board is a full-content switch: the composer leaves with the feed.
    expect(b.view.queryByRole('textbox', { name: '消息内容' })).toBeNull()
    for (const column of ['待处理', '进行中', '待验收', '已完成']) expect(b.view.getByText(column)).toBeTruthy()
    // The seeded Task sits in its state column with the entry row's facts
    // re-dealt for scanning: number, the opener's first line, nobody on it.
    const card = b.view.getByRole('button', { name: '打开 Task #1' })
    expect(card.textContent).toContain('Task #1')
    expect(card.textContent).toContain('实现 API 网关')
    expect(card.textContent).not.toContain('细节在 Thread 里')
    expect(card.textContent).toContain('待认领')
    // The card names who owns the Task's outcome; the Human sees itself.
    expect(card.textContent).toContain('你负责')
    expect(card.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-14T09:00:00.000Z')
    // An empty column still states its heading and its own zero; it does not
    // print a second placeholder row inside a column the count already closed.
    const columns = b.view.getAllByText(/^(待处理|进行中|待验收|已完成)$/).map(head => head.parentElement)
    expect(columns).toHaveLength(4)
    expect(within(columns[1]!).queryByRole('button')).toBeNull()

    // A card opens the existing Thread level — the same place the feed's
    // entry row goes, not a new surface.
    fireEvent.click(card)
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '返回项目' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    // Returning remounts the page on its default reading; switching back to
    // the feed restores the timeline and the composer.
    expect(b.view.getByRole('tab', { name: '主对话' }).getAttribute('aria-selected')).toBe('true')
    expect(b.view.getByRole('button', { name: /^打开 Task #1：/ })).toBeTruthy()
    expect(b.view.getByRole('textbox', { name: '消息内容' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('discloses a suspended accountable owner instead of presenting the Task as normally staffed', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true,
      seededMessages: [{ sender: 'human', body: '实现 API 网关', occurredAt: '2026-10-14T09:00:00.000Z' }] })
    b.loadTaskBoard.mockImplementation(async () => ({ ok: true, value: { humanMemberId: 'member:human', open: [{
      workspaceId: 'w1', projectRef: 'project:engineering', projectName: 'engineering',
      task: { taskRef: 'task:1', projectRef: 'project:engineering', threadRef: 'thread:1', status: 'in_progress', resolution: 'open', accountable: 'member:iris', sourceThreadRefs: [] },
      taskNumber: 1, threadRef: 'thread:1', subject: '实现 API 网关', liveClaimOwners: [],
      accountableOwner: { memberId: 'member:iris', name: 'Iris', state: 'suspended' },
      lastActivitySequence: 1, lastActivityAt: '2026-10-14T09:00:00.000Z', relation: 'project-owner', needsAcceptance: false,
    }], finished: [], finishedTruncated: false } }))
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('tab', { name: '看板' }))
    await waitFor(() => expect(b.view.getByText('负责人已暂停')).toBeTruthy())
    await b.runtime.dispose()
  })

  it('moves the selection with the arrow keys and reaches both tabs from the keyboard', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskStatus: 'todo', seededMessages: [
      { body: '实现 API 网关', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    const feedTab = await b.view.findByRole('tab', { name: '主对话' })
    const boardTab = b.view.getByRole('tab', { name: '看板' })
    feedTab.focus()
    // Right moves the selection and the focus together, so the reader never has
    // to press a key on a tab that is not the one they are standing on.
    fireEvent.keyDown(b.view.getByRole('tablist'), { key: 'ArrowRight' })
    expect(boardTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(boardTab)
    fireEvent.keyDown(b.view.getByRole('tablist'), { key: 'ArrowRight' })
    expect(feedTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(feedTab)
    // Home and End reach the ends of the strip without stepping through it.
    fireEvent.keyDown(b.view.getByRole('tablist'), { key: 'End' })
    expect(boardTab.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(b.view.getByRole('tablist'), { key: 'Home' })
    expect(feedTab.getAttribute('aria-selected')).toBe('true')
    // An unrelated key is left alone: it must not steal typing or scrolling.
    fireEvent.keyDown(b.view.getByRole('tablist'), { key: 'ArrowDown' })
    expect(feedTab.getAttribute('aria-selected')).toBe('true')
    await b.runtime.dispose()
  })

  // The board is a Task view, not a second reading of the loaded Message window:
  // the ticket's regression is that it once inherited the feed's paging and its
  // counters only described whatever Messages happened to be loaded.
  it('shows every Task of the project and never inherits the feed\'s paging', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskStatus: 'in_progress', seededMessages: [
      { body: '实现 API 网关', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    b.viewProjects.mockImplementation(async () => ({
      ok: true,
      value: {
        humanMemberId: 'member:human',
        projects: [{ projectRef: 'project:engineering', workspaceId: 'w1', name: 'engineering', description: 'Engineering work', createdAtSequence: 1 }],
        members: [],
        owners: [], rulesVersion: 2,
        // `task:2` sits in no loaded Message: only the Host board can surface it,
        // which is what pins the board's coverage to the Project rather than the feed.
        tasks: [
          { taskRef: 'task:1', projectRef: 'project:engineering', threadRef: 'thread:1', status: 'in_progress', resolution: 'open' },
          { taskRef: 'task:2', projectRef: 'project:engineering', threadRef: 'thread:2', status: 'todo', resolution: 'open' },
        ],
        threads: [{ threadRef: 'thread:1', taskRef: 'task:1', revision: 2 }, { threadRef: 'thread:2', taskRef: 'task:2', revision: 1 }],
        taskNumbers: [{ taskRef: 'task:1', taskNumber: 1 }, { taskRef: 'task:2', taskNumber: 2 }],
        items: [{
          message: { messageRef: 'message:seed-0', projectRef: 'project:engineering', threadRef: 'thread:1', taskRef: 'task:1', sender: 'member:human', body: '实现 API 网关', topLevel: true, sequence: 1, occurredAt: '2026-10-14T09:00:00.000Z' },
          mentions: [],
          task: { taskRef: 'task:1', projectRef: 'project:engineering', threadRef: 'thread:1', status: 'in_progress', resolution: 'open' },
          taskNumber: 1,
          thread: { threadRef: 'thread:1', taskRef: 'task:1', revision: 2 },
          liveClaimOwners: [],
          messageCount: 1,
          lastActivityAt: '2026-10-14T09:00:00.000Z',
        }],
        claims: [], activities: [], cursor: 1,
        // Older Messages exist beyond this window. The board must ignore that
        // entirely: no paging control, and no read issued to fill its columns.
        hasMore: true,
      },
    }))
    b.loadTaskBoard.mockImplementation(async () => ({
      ok: true,
      value: {
        humanMemberId: 'member:human',
        open: [
          { workspaceId: 'w1', projectRef: 'project:engineering', projectName: 'engineering', threadRef: 'thread:2',
            task: { taskRef: 'task:2', projectRef: 'project:engineering', threadRef: 'thread:2', status: 'todo', resolution: 'open' },
            taskNumber: 2, subject: '接入计费', liveClaimOwners: [], accountableOwner: { memberId: 'member:human', name: 'human' },
            lastActivitySequence: 2, lastActivityAt: '2026-10-14T10:00:00.000Z', relation: 'project-owner', needsAcceptance: false },
          { workspaceId: 'w1', projectRef: 'project:engineering', projectName: 'engineering', threadRef: 'thread:1',
            task: { taskRef: 'task:1', projectRef: 'project:engineering', threadRef: 'thread:1', status: 'in_progress', resolution: 'open' },
            taskNumber: 1, subject: '实现 API 网关', liveClaimOwners: [], accountableOwner: { memberId: 'member:human', name: 'human' },
            lastActivitySequence: 1, lastActivityAt: '2026-10-14T09:00:00.000Z', relation: 'project-owner', needsAcceptance: false },
        ],
        finished: [],
        finishedTruncated: false,
      },
    }))
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.getByRole('tab', { name: '看板' }))
    // (a) The board carries no Message-paging control of its own.
    await waitFor(() => expect(b.view.getByText('实现 API 网关')).toBeTruthy())
    expect(b.view.queryByRole('button', { name: '加载更早消息' })).toBeNull()
    // (b) A Task absent from the loaded window still reaches its column.
    expect(b.view.getByText('接入计费')).toBeTruthy()
    // Switching tabs issues no read of the Project: the board is not a reason to
    // page the feed, so its content cannot drift with the feed's window.
    const before = b.viewProjects.mock.calls.length
    fireEvent.click(b.view.getByRole('tab', { name: '主对话' }))
    fireEvent.click(b.view.getByRole('tab', { name: '看板' }))
    await Promise.resolve()
    expect(b.viewProjects.mock.calls.length).toBe(before)
    await b.runtime.dispose()
  })

  it('expands the finished column to the whole resolved history on demand', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskStatus: 'done', seededMessages: [
      { body: '完成旧任务', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    // Seven resolved Tasks: more than the Host's default page of five.
    const finished = Array.from({ length: 7 }, (_unused, index) => ({
      workspaceId: 'w1', projectRef: 'project:engineering', projectName: 'engineering', threadRef: `thread:${index + 1}`,
      task: { taskRef: `task:${index + 1}`, projectRef: 'project:engineering', threadRef: `thread:${index + 1}`, status: 'done', resolution: 'open' },
      taskNumber: index + 1, subject: `已完成 ${index + 1}`, liveClaimOwners: [], accountableOwner: { memberId: 'member:human', name: 'human' },
      lastActivitySequence: index + 1, lastActivityAt: '2026-10-14T09:00:00.000Z', relation: 'project-owner', needsAcceptance: false,
    }))
    const page = (finishedLimit: number | undefined) => ({
      ok: true as const,
      value: { humanMemberId: 'member:human', open: [], finished: finishedLimit === undefined ? finished.slice(-5) : finished.slice(-finishedLimit),
        finishedTruncated: finished.length > (finishedLimit ?? 5) },
    })
    b.loadTaskBoard.mockImplementation(async (request: { finishedLimit?: number }) => page(request.finishedLimit))
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.getByRole('tab', { name: '看板' }))
    // The column opens on the Host's page, so the oldest work is still hidden.
    expect(await b.view.findByText('已完成 7')).toBeTruthy()
    expect(b.view.queryByText('已完成 1')).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: '展开全部已完成' }))
    // Expanding asks for a deeper slice rather than re-deriving the old one.
    await waitFor(() => expect(b.view.getByText('已完成 1')).toBeTruthy())
    expect(b.loadTaskBoard.mock.calls.at(-1)?.[0]).toMatchObject({ finishedLimit: 100 })
    // The control retires once the column shows everything.
    expect(b.view.queryByRole('button', { name: '展开全部已完成' })).toBeNull()
    // A change event refreshes the board with whatever the reader had asked for:
    // the expanded page must survive it, or the column silently collapses under them.
    b.publishProjectUpdate()
    await waitFor(() => expect(b.loadTaskBoard.mock.calls.length).toBeGreaterThan(1))
    await waitFor(() => expect(b.loadTaskBoard.mock.calls.at(-1)?.[0]).toMatchObject({ finishedLimit: 100 }))
    expect(b.view.getByText('已完成 1')).toBeTruthy()
    await b.runtime.dispose()
  })

  // A full page is not proof of an older one. This case and the next pin the two
  // edges where counting rows instead of reading the Host's truncation signal
  // offered a control that changed nothing.
  it('offers no expand control when the page is full but nothing was cut', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskStatus: 'done', seededMessages: [
      { body: '完成旧任务', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    // Exactly the Host's default page: a full column with no older work behind it.
    const finished = Array.from({ length: 5 }, (_unused, index) => ({
      workspaceId: 'w1', projectRef: 'project:engineering', projectName: 'engineering', threadRef: `thread:${index + 1}`,
      task: { taskRef: `task:${index + 1}`, projectRef: 'project:engineering', threadRef: `thread:${index + 1}`, status: 'done', resolution: 'open' },
      taskNumber: index + 1, subject: `已完成 ${index + 1}`, liveClaimOwners: [], accountableOwner: { memberId: 'member:human', name: 'human' },
      lastActivitySequence: index + 1, lastActivityAt: '2026-10-14T09:00:00.000Z', relation: 'project-owner', needsAcceptance: false,
    }))
    b.loadTaskBoard.mockImplementation(async () => ({
      ok: true as const,
      value: { humanMemberId: 'member:human', open: [], finished, finishedTruncated: false },
    }))
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.getByRole('tab', { name: '看板' }))
    expect(await b.view.findByText('已完成 5')).toBeTruthy()
    expect(b.view.queryByRole('button', { name: '展开全部已完成' })).toBeNull()
    await b.runtime.dispose()
  })

  it('retires the expand control at the deepest page the Host accepts', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskStatus: 'done', seededMessages: [
      { body: '完成旧任务', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    // More resolved work than any page can show: the Host stays truncated at its
    // own maximum, and a control that could only repeat the same request retires.
    const finished = Array.from({ length: 101 }, (_unused, index) => ({
      workspaceId: 'w1', projectRef: 'project:engineering', projectName: 'engineering', threadRef: `thread:${index + 1}`,
      task: { taskRef: `task:${index + 1}`, projectRef: 'project:engineering', threadRef: `thread:${index + 1}`, status: 'done', resolution: 'open' },
      taskNumber: index + 1, subject: `已完成 ${index + 1}`, liveClaimOwners: [], accountableOwner: { memberId: 'member:human', name: 'human' },
      lastActivitySequence: index + 1, lastActivityAt: '2026-10-14T09:00:00.000Z', relation: 'project-owner', needsAcceptance: false,
    }))
    b.loadTaskBoard.mockImplementation(async (request: { finishedLimit?: number }) => ({
      ok: true as const,
      value: { humanMemberId: 'member:human', open: [], finished: finished.slice(-(request.finishedLimit ?? 5)), finishedTruncated: true },
    }))
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.getByRole('tab', { name: '看板' }))
    expect(await b.view.findByText('已完成 101')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '展开全部已完成' }))
    await waitFor(() => expect(b.view.getByText('已完成 2')).toBeTruthy())
    expect(b.loadTaskBoard.mock.calls.at(-1)?.[0]).toMatchObject({ finishedLimit: 100 })
    // Still truncated, but there is no deeper page to ask for.
    expect(b.view.queryByRole('button', { name: '展开全部已完成' })).toBeNull()
    await b.runtime.dispose()
  })
})
