// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, within } from '@testing-library/react'
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
    expect(card.textContent).toContain('未指派')
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

  it('reads the same window the feed has loaded and offers the way to older work', async () => {
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
        tasks: [{ taskRef: 'task:1', projectRef: 'project:engineering', threadRef: 'thread:1', status: 'in_progress', resolution: 'open' }],
        threads: [{ threadRef: 'thread:1', taskRef: 'task:1', revision: 2 }],
        taskNumbers: [{ taskRef: 'task:1', taskNumber: 1 }],
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
        // Older work exists beyond this window: one page of history, which the
        // board must not walk on its own.
        hasMore: true,
      },
    }))
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.getByRole('tab', { name: '看板' }))
    expect(await b.view.findByRole('button', { name: '加载更早消息' })).toBeTruthy()
    // Opening the board issues no read of its own: the tab is a second reading
    // of the window the feed already holds, not a reason to page the Project.
    const before = b.viewProjects.mock.calls.length
    fireEvent.click(b.view.getByRole('tab', { name: '主对话' }))
    fireEvent.click(b.view.getByRole('tab', { name: '看板' }))
    await Promise.resolve()
    expect(b.viewProjects.mock.calls.length).toBe(before)
    await b.runtime.dispose()
  })
})
