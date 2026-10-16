// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('Team Channel board', () => {
  it('switches feed and board through the header tabs and opens a Task card on the Thread level', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true, seedTaskStatus: 'todo', seededMessages: [
      { body: '实现 API 网关\n细节在 Thread 里', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    expect(b.view.container.querySelector('[data-team-channel]')).toBeTruthy()
    // The feed is the default reading: its tab is selected, and both the
    // timeline entry and the composer stand in the content seat.
    const feedTab = b.view.getByRole('tab', { name: '频道' })
    const boardTab = b.view.getByRole('tab', { name: '看板' })
    expect(feedTab.getAttribute('aria-selected')).toBe('true')
    expect(boardTab.getAttribute('aria-selected')).toBe('false')
    expect(b.view.getByRole('button', { name: '打开 Task #1' })).toBeTruthy()
    expect(b.view.getByRole('textbox', { name: '消息内容' })).toBeTruthy()

    fireEvent.click(boardTab)
    expect(boardTab.getAttribute('aria-selected')).toBe('true')
    expect(feedTab.getAttribute('aria-selected')).toBe('false')
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
    expect(b.view.getAllByText('（空）')).toHaveLength(3)

    // A card opens the existing Thread level — the same place the feed's
    // entry row goes, not a new surface.
    fireEvent.click(card)
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '返回频道' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    // Returning remounts the page on its default reading; switching back to
    // the feed restores the timeline and the composer.
    expect(b.view.getByRole('tab', { name: '频道' }).getAttribute('aria-selected')).toBe('true')
    expect(b.view.getByRole('button', { name: '打开 Task #1' })).toBeTruthy()
    expect(b.view.getByRole('textbox', { name: '消息内容' })).toBeTruthy()
    await b.runtime.dispose()
  })
})
