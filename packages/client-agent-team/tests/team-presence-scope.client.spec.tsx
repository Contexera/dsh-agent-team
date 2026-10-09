// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('presence-scope wake wiring (issue #21)', () => {
  it('refreshes member rows on a presence wake without catalog or Inbox refetches', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await waitFor(() => expect(b.members.mock.calls.length).toBeGreaterThanOrEqual(1))
    await waitFor(() => expect(b.viewChannels.mock.calls.length).toBeGreaterThanOrEqual(1))
    await new Promise(resolve => setTimeout(resolve, 300))
    const inboxCalls = b.inbox.mock.calls.length
    const channelCalls = b.viewChannels.mock.calls.length
    const memberCalls = b.members.mock.calls.length

    // Agent running/idle reaches the Client as a presence-scope wake: the
    // Agents panel refreshes its rows (green dots), while the Channels
    // panel's view() and the scope-less Inbox badge stay parked. The
    // badge debounces, so wait past that window before asserting stillness.
    b.publishPresence()
    await waitFor(() => expect(b.members.mock.calls.length).toBeGreaterThan(memberCalls))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(b.viewChannels.mock.calls.length).toBe(channelCalls)
    expect(b.inbox.mock.calls.length).toBe(inboxCalls)

    // A workspace commit still refreshes the sidebar catalog.
    b.publishChannelUpdate()
    await waitFor(() => expect(b.viewChannels.mock.calls.length).toBeGreaterThan(channelCalls))
    await b.runtime.dispose()
  })

  it('presence wake on an open Thread refreshes only the roster, never the view', async () => {
    const b = await runtimeWithTeam({
      mode: 'team', workspaceId: 'w1', initialChannels: true,
      seededMessages: [{ body: '开工任务', occurredAt: '2026-08-21T09:00:00.000Z' }],
    })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(await b.view.findByRole('button', { name: '打开 Task #1' }))
    await b.view.findByRole('heading', { name: 'Task #1' })
    await new Promise(resolve => setTimeout(resolve, 300))
    const inboxCalls = b.inbox.mock.calls.length
    const channelCalls = b.viewChannels.mock.calls.length
    const memberCalls = b.members.mock.calls.length

    // A presence wake moves member rows only (issue 03, criterion 4): the
    // open Thread's roster refresh must not ride the supplemental view
    // fetch, so view() stays parked exactly like the Inbox badge. The badge
    // debounces, so wait past that window before asserting stillness.
    b.publishPresence()
    await waitFor(() => expect(b.members.mock.calls.length).toBeGreaterThan(memberCalls))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(b.viewChannels.mock.calls.length).toBe(channelCalls)
    expect(b.inbox.mock.calls.length).toBe(inboxCalls)
    await b.runtime.dispose()
  })
})
