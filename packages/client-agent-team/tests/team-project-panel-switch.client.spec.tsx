// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/**
 * Two taskless discussions in one Project, each with its own anchor. The panel
 * stays mounted while the reader moves from one to the other, so a read that is
 * not re-issued for the new Thread leaves the previous discussion's anchor on
 * screen — which is what this pins shut.
 */
describe('Team Project discussion panel switching', () => {
  it('reads the discussion the reader opened, not the one before it', async () => {
    const card = (threadRef: string, sequence: number, preview: string) => ({
      kind: 'thread-card' as const, sequence, occurredAt: '2026-10-14T09:00:00.000Z', card: {
        threadRef, anchor: { messageRef: `message:seed-${sequence - 1}`, sender: 'member:human', preview, sequence, occurredAt: '2026-10-14T09:00:00.000Z' },
        replyCount: 0, participants: [], newestSequence: sequence, newestOccurredAt: '2026-10-14T09:00:00.000Z', newestActor: { memberId: 'member:human', name: 'human' },
      },
    })
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskless: true, seededMessages: [
      { body: '第一条讨论', occurredAt: '2026-10-14T09:00:00.000Z' },
    ], mainStreamEntries: [card('thread:1', 1, '第一条讨论'), card('thread:2', 2, '第二条讨论')] })
    const bodies: Record<string, string> = { 'thread:1': '第一条讨论', 'thread:2': '第二条讨论' }
    const base = b.viewProjects.getMockImplementation()!
    b.viewProjects.mockImplementation(async (request: { threadRef?: string; topLevelOnly?: boolean }) => {
      const result = await base(request)
      if (!result.ok) return result
      // Only the feed's own window gains the second discussion: a thread-scoped
      // read answers for one Thread and is left alone.
      if (request.threadRef !== undefined || request.topLevelOnly !== true) return result
      return { ok: true as const, value: { ...result.value, items: [...result.value.items, {
        message: { messageRef: 'message:seed-1', projectRef: 'project:engineering', threadRef: 'thread:2', sender: 'member:human', body: bodies['thread:2'], topLevel: true, sequence: 2, occurredAt: '2026-10-14T10:00:00.000Z' },
        mentions: [], thread: { threadRef: 'thread:2', revision: 2 }, liveClaimOwners: [], messageCount: 1,
        lastActivityAt: '2026-10-14T10:00:00.000Z',
      }] } }
    })
    // The harness answers for whatever Thread is asked, but it projects every
    // seeded item into every read's facts. A real Host answers for one Thread,
    // so each read is scoped to its own anchor and its own facts.
    const baseRead = b.readThread.getMockImplementation()!
    b.readThread.mockImplementation(async (request: { threadRef?: string }) => {
      const result = await baseRead(request)
      if (!result.ok) return result
      const threadRef = request.threadRef ?? 'thread:1'
      const anchor = threadRef === 'thread:2'
        ? { messageRef: 'message:seed-1', projectRef: 'project:engineering', threadRef, sender: 'member:human',
            body: bodies[threadRef], topLevel: true, sequence: 2, occurredAt: '2026-10-14T10:00:00.000Z' }
        : result.value.anchor
      return { ok: true as const, value: {
        ...result.value,
        anchor,
        thread: { threadRef, revision: 2 },
        facts: result.value.facts.filter(fact => fact.fact.kind !== 'message'
          || (fact.fact.message as { threadRef?: string }).threadRef === threadRef),
      } }
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    await waitFor(() => expect(b.view.container.querySelectorAll('[data-main-card]').length).toBe(2))
    const doors = b.view.container.querySelectorAll<HTMLElement>('[data-main-card]')
    fireEvent.click(doors[0]!)
    const panel = await b.view.findByRole('complementary', { name: '讨论' })
    expect(await within(panel).findByText('第一条讨论')).toBeTruthy()
    // The other discussion replaces it in place, and the panel is the same
    // element: this is a swap, not a remount.
    fireEvent.click(doors[1]!)
    expect(await within(panel).findByText('第二条讨论')).toBeTruthy()
    expect(within(panel).queryByText('第一条讨论')).toBeNull()
    // The read travelled with the panel: the second discussion was read on the
    // Host's own ref rather than reusing the first answer.
    expect(b.readThread).toHaveBeenCalledWith(expect.objectContaining({ threadRef: 'thread:2' }))
    await b.runtime.dispose()
  })
})
