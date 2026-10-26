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

  it('lets the panel\'s read answer the card\'s unread statement while the arrival accent keeps its own clock', async () => {
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
    // The card's name states the durable standing, the entry's accent states the arrival. The panel's read answers the
    // standing, so a refreshed card stops claiming 未读, while the accent — stamped when the entry was first shown —
    // still holds for its own few seconds instead of lasting until the Human leaves the page.
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：.*未读/ }))
    expect(await b.view.findByRole('complementary', { name: '讨论' })).toBeTruthy()
    await waitFor(() => expect(b.readThread).toHaveBeenCalled())
    const loads = b.mainStreamHistory.mock.calls.length
    b.publishProjectUpdate()
    await waitFor(() => expect(b.mainStreamHistory.mock.calls.length).toBeGreaterThan(loads))
    // waitFor keeps polling only while the callback throws, so the wrong state has to throw to be retried.
    await waitFor(() => {
      const label = b.view.getByRole('button', { name: /^打开讨论：/ }).getAttribute('aria-label')
      if (label?.includes('未读') === true) throw new Error(`the read has not answered the name yet: ${label}`)
    })
    const card = b.view.getByRole('button', { name: /^打开讨论：/ })
    expect(card.getAttribute('aria-label')).not.toContain('未读')
    expect(card.closest('[data-unread]')).not.toBeNull()
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

  /**
   * A discussion spawned a Task, and both the panel and the Thread page must draw that Task with one projection: status,
   * live Claim owners, reply count and time come from `mainThreadCard`, so opening one discussion beside the feed and
   * inside its own page cannot describe the same work differently.
   */
  it('draws a derived Task with one card component in the panel and on the Thread page', async () => {
    const b = await seedPanel()
    const derived = {
      sequence: 2,
      card: {
        threadRef: 'thread:derived',
        anchor: { messageRef: 'message:derived', sender: 'member:human', preview: '把讨论结论落地', sequence: 2, occurredAt: '2026-10-14T09:30:00.000Z' },
        task: { taskRef: 'task:derived', taskNumber: 2, status: 'in_progress', resolution: 'open', accountable: 'member:human', liveClaimOwners: [{ memberId: 'member:builder', name: 'builder' }] },
        replyCount: 3, participants: [{ memberId: 'member:human', name: 'human' }, { memberId: 'member:builder', name: 'builder' }],
        newestSequence: 5, newestOccurredAt: '2026-10-14T10:00:00.000Z',
        newestActor: { memberId: 'member:builder', name: 'builder' },
      },
    }
    const baseHistory = b.loadThreadHistory.getMockImplementation()!
    b.loadThreadHistory.mockImplementation(async (request: { threadRef?: string }) => {
      const result = await baseHistory(request)
      return result.ok ? { ok: true as const, value: { ...result.value, taskCards: [derived] } } : result
    })
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    const inPanel = await within(panel).findByRole('button', { name: /^打开 Task #2：/ })
    const panelLabel = inPanel.getAttribute('aria-label')
    // The claim owners are named from the Host's live set, not from the Client's roster.
    expect(panelLabel).toContain('把讨论结论落地')
    expect(panelLabel).toContain('@builder')
    expect(panelLabel).toContain('3 条回复')
    // The same discussion on its own page renders the same card, with the same accessible name.
    b.runtime.ctx.teamNavigation.actions().selectThread('thread:1' as never, 'project:engineering' as never)
    await waitFor(() => expect(b.view.container.querySelector('[data-team-thread]')).not.toBeNull())
    const page = b.view.container.querySelector<HTMLElement>('[data-team-thread]')!
    const onPage = await within(page).findByRole('button', { name: /^打开 Task #2：/ })
    expect(onPage.getAttribute('aria-label')).toBe(panelLabel)
    // A card is a door: it opens the Task's own page rather than the discussion it came from.
    fireEvent.click(onPage)
    await waitFor(() => expect(b.runtime.ctx.teamNavigation.getSnapshot().threadRef).toBe('thread:derived'))
    await b.runtime.dispose()
  })

  /**
   * A citation resolves to its own Project, and that Project is what the destination must carry. A Thread page opened
   * without a `projectRef` — the shape a Task Thread takes when it is restored on its own — has no Project to substitute,
   * so guessing one either sent the discussion to the full page or seated the panel in the wrong Project.
   */
  it('opens a cited cross-Project discussion beside its own Project from a Thread page that has no projectRef', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seededMessages: [
      { body: '起因', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    const baseRead = b.readThread.getMockImplementation()!
    // The Task Thread cites a discussion living in another Project; the Host resolves it with that Project's own ref.
    b.readThread.mockImplementation(async request => {
      const result = await baseRead(request)
      return result.ok ? { ok: true as const, value: { ...result.value, facts: [
        { fact: { kind: 'message' as const, sequence: 1, mentions: [], message: { messageRef: 'message:cite', projectRef: 'project:engineering', threadRef: 'thread:1', sender: 'member:human', body: '接着看 thread:c0a1b2c3', topLevel: true, sequence: 1, occurredAt: '2026-10-14T09:00:00.000Z' } }, unread: false, direct: false },
      ] } } : result
    })
    // No projectRef: the page opened from a Task's own identity rather than from a Project feed.
    b.runtime.ctx.teamNavigation.actions().selectThread('thread:1' as never, undefined, 'task:1' as never, 1)
    // Wait for that surface: the panel's own `main` would satisfy a looser query before the page arrived.
    await waitFor(() => expect(b.view.container.querySelector('main[data-team-thread="thread:1"]')).not.toBeNull())
    const page = b.view.container.querySelector<HTMLElement>('main[data-team-thread="thread:1"]')!
    fireEvent.click(await within(page).findByRole('button', { name: /^讨论 · 另一个项目的讨论/ }))
    // The destination is the panel, carrying the resolved Project — not the full Thread page, and not this page's Project.
    await waitFor(() => expect(b.runtime.ctx.teamNavigation.getSnapshot()).toMatchObject({
      discussionRef: 'thread:c0a1b2c3', projectRef: 'project:delivery',
    }))
    expect(b.runtime.ctx.teamNavigation.getSnapshot().threadRef).toBeUndefined()
    await b.runtime.dispose()
  })

  /**
   * The same rule inside the panel: a discussion may cite one in a sibling Project, and the panel has to move the seat
   * there rather than open that discussion over the feed it does not belong to.
   */
  it('follows a cited sibling-Project discussion out of the panel instead of keeping the current Project', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskless: true, seededMessages: [
      { body: '起因', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    const citing = { messageRef: 'message:cite', projectRef: 'project:engineering', threadRef: 'thread:1', sender: 'member:human', body: '也看 thread:c0a1b2c3', topLevel: false, sequence: 2, occurredAt: '2026-10-14T09:05:00.000Z' }
    const baseRead = b.readThread.getMockImplementation()!
    b.readThread.mockImplementation(async request => {
      const result = await baseRead(request)
      return result.ok ? { ok: true as const, value: { ...result.value, facts: [
        { fact: { kind: 'message' as const, sequence: 2, message: citing, mentions: [] }, unread: false, direct: false },
      ] } } : result
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    fireEvent.click(await within(panel).findByRole('button', { name: /^讨论 · 另一个项目的讨论/ }))
    await waitFor(() => expect(b.runtime.ctx.teamNavigation.getSnapshot()).toMatchObject({
      discussionRef: 'thread:c0a1b2c3', projectRef: 'project:delivery',
    }))
    await b.runtime.dispose()
  })

  /**
   * The card sits where its Task was created, not at the end of the feed: sequence 2 lands between the two Messages that
   * surround it, so a reader scrolling the discussion meets the work in the order it happened.
   */
  it('keeps a derived card at its creation sequence in the panel timeline', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskless: true, seededMessages: [
      { body: '起因', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    const derived = {
      sequence: 2,
      card: {
        threadRef: 'thread:derived',
        anchor: { messageRef: 'message:derived', sender: 'member:human', preview: '中间落地', sequence: 2, occurredAt: '2026-10-14T09:30:00.000Z' },
        task: { taskRef: 'task:derived', taskNumber: 2, status: 'todo', resolution: 'open', accountable: 'member:human', liveClaimOwners: [] },
        replyCount: 0, participants: [],
        newestSequence: 2, newestOccurredAt: '2026-10-14T09:30:00.000Z',
        newestActor: { memberId: 'member:human', name: 'human' },
      },
    }
    const first = { messageRef: 'message:first', projectRef: 'project:engineering', threadRef: 'thread:1', sender: 'member:human', body: '起因', topLevel: true, sequence: 1, occurredAt: '2026-10-14T09:00:00.000Z' }
    const last = { ...first, messageRef: 'message:last', body: '结论', sequence: 3, occurredAt: '2026-10-14T10:00:00.000Z' }
    const baseRead = b.readThread.getMockImplementation()!
    b.readThread.mockImplementation(async request => {
      const result = await baseRead(request)
      return result.ok ? { ok: true as const, value: { ...result.value, facts: [
        { fact: { kind: 'message' as const, sequence: 1, message: first, mentions: [] }, unread: false, direct: false },
        { fact: { kind: 'message' as const, sequence: 3, message: last, mentions: [] }, unread: false, direct: false },
      ] } } : result
    })
    const baseHistory = b.loadThreadHistory.getMockImplementation()!
    b.loadThreadHistory.mockImplementation(async request => {
      const result = await baseHistory(request)
      return result.ok ? { ok: true as const, value: { ...result.value, taskCards: [derived] } } : result
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('button', { name: /^打开讨论：/ }))
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    const card = await within(panel).findByRole('button', { name: /^打开 Task #2：/ })
    const rowOf = (messageRef: string): Element => panel.querySelector(`[data-message-ref="${messageRef}"]`)!
    // Document order, not list order: the card sits between the facts that surround its creation.
    expect(rowOf('message:first').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rowOf('message:last').compareDocumentPosition(card) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
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
