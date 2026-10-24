// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** One seeded taskless discussion on the bench, with the Project page open. */
async function seedPanel() {
  const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskless: true, seededMessages: [
    { body: '帮我看看这个方案', occurredAt: '2026-10-14T09:00:00.000Z' },
  ] })
  fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
  expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
  return b
}

describe('Team Project discussion panel', () => {
  it('opens a taskless Thread in the side panel instead of the Thread page', async () => {
    const b = await seedPanel()
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    // The head names the discussion and offers the promotion and the way out.
    expect(within(panel).getByText('讨论 · #engineering')).toBeTruthy()
    expect(await within(panel).findByRole('button', { name: '转为 Task' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: '关闭讨论' })).toBeTruthy()
    // The anchor Message and the reply composer are the body and the foot.
    expect(within(panel).getByText('帮我看看这个方案')).toBeTruthy()
    expect(within(panel).getByRole('textbox', { name: '消息内容' })).toBeTruthy()
    // The feed never left: the project page and the discussion's door stand.
    expect(b.view.container.querySelector('[data-team-project]')).toBeTruthy()
    expect(b.view.getByRole('button', { name: /^打开讨论：/ })).toBeTruthy()
    await waitFor(() => expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ threadRef: 'thread:1' })))
    await b.runtime.dispose()
  })

  it('keeps the card marked unread for this visit while the panel reads it', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskless: true, seededMessages: [
      { body: '帮我看看这个方案', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    b.seedInbox([{
      workspaceId: 'w1', projectRef: 'project:engineering',
      thread: { threadRef: 'thread:1', revision: 2 },
      unreadCount: 3, directCount: 0,
      previewText: '帮我看看这个方案', newestSequence: 1, newestOccurredAt: '2026-10-14T09:00:00.000Z',
    }])
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    // The card wears its unread in its name; the panel's durable read consumes it,
    // yet the card stays marked until the Human leaves, as the Main stream keeps what was unread on arrival.
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：.*未读/ }))
    expect(await b.view.findByRole('complementary', { name: '讨论' })).toBeTruthy()
    await waitFor(() => expect(b.readThread).toHaveBeenCalled())
    const loads = b.mainStreamHistory.mock.calls.length
    b.publishProjectUpdate()
    await waitFor(() => expect(b.mainStreamHistory.mock.calls.length).toBeGreaterThan(loads))
    expect(b.view.getByRole('button', { name: /^打开讨论：/ }).getAttribute('aria-label')).toContain('未读')
    await b.runtime.dispose()
  })

  it('replies from the panel composer and renders the committed message', async () => {
    const b = await seedPanel()
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    fireEvent.change(await within(panel).findByRole('textbox', { name: '消息内容' }), { target: { value: '面板里的回复' } })
    fireEvent.click(within(panel).getByRole('button', { name: '发送' }))
    await waitFor(() => expect(b.reply).toHaveBeenCalledWith(expect.objectContaining({ threadRef: 'thread:1', body: '面板里的回复' })))
    expect(await within(panel).findByText('面板里的回复')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('offers each Message the same row actions the Thread page does', async () => {
    const b = await seedPanel()
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    const row = (await within(panel).findByText('帮我看看这个方案')).closest('article')!
    // Copy and quote, on the panel's own rows: a reader who turned to the panel
    // reads the same Thread the page renders, so it cannot be the one surface
    // where a Message has no actions.
    expect(row.querySelector('[data-message-card]')).toBeTruthy()
    expect(row.querySelector('[data-copy-message]')).toBeTruthy()
    const quote = row.querySelector('[data-quote-message]')
    expect(quote).toBeTruthy()
    fireEvent.click(quote!)
    // The quote fills the composer the panel already owns, so the reply the
    // reader writes lands under the Message they picked.
    const banner = await waitFor(() => {
      const found = panel.querySelector('[data-reply-banner]')
      expect(found).toBeTruthy()
      return found!
    })
    expect(banner.textContent).toContain('引用')
    fireEvent.change(within(panel).getByRole('textbox', { name: '消息内容' }), { target: { value: '面板里的引用回复' } })
    fireEvent.click(within(panel).getByRole('button', { name: '发送' }))
    await waitFor(() => expect(b.reply).toHaveBeenCalledWith(expect.objectContaining({
      threadRef: 'thread:1',
      body: '面板里的引用回复',
      replyToMessageRef: row.getAttribute('data-message-ref'),
    })))
    await b.runtime.dispose()
  })

  it('promotes the discussion and walks the reader into the Thread page', async () => {
    const b = await seedPanel()
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    fireEvent.click(await within(panel).findByRole('button', { name: '转为 Task' }))
    await waitFor(() => expect(b.promoteThread).toHaveBeenCalledWith(expect.objectContaining({ threadRef: 'thread:1' })))
    // The panel's job ends where the Task begins: it closes as the Thread
    // page opens, and the feed's door is a Task's when the reader returns.
    expect(await b.view.findByRole('heading', { name: 'Task #1' })).toBeTruthy()
    expect(b.view.queryByRole('complementary', { name: '讨论' })).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: '返回项目' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    expect(await b.view.findByRole('button', { name: /^打开 Task #1：/ })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps the panel open across tab switches and closes on its own button', async () => {
    const b = await seedPanel()
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    expect(await b.view.findByRole('complementary', { name: '讨论' })).toBeTruthy()
    // The board takes the whole seat; the panel's state stays for the feed.
    fireEvent.click(b.view.getByRole('tab', { name: '看板' }))
    expect(b.view.queryByRole('complementary', { name: '讨论' })).toBeNull()
    fireEvent.click(b.view.getByRole('tab', { name: '主对话' }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    fireEvent.click(within(panel).getByRole('button', { name: '关闭讨论' }))
    expect(b.view.queryByRole('complementary', { name: '讨论' })).toBeNull()
    // The seat is reserved only while the panel is open: with the discussion
    // closed the reading column takes the width back instead of standing beside
    // an empty band.
    expect(b.view.container.querySelector('[data-panel="closed"]')).toBeTruthy()
    await b.runtime.dispose()
  })
})
