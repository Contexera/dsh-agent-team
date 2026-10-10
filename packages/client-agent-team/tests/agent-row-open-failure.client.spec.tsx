// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('Team agent session open failures', () => {
  it('reports a rejected open instead of leaving the sidebar ahead of the seat', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await b.view.findByText('builder')
    // A Session the Client catalog does not carry yet — the window right after
    // a Member is created, where `uiWorkspace.openSession` throws.
    b.openSession.mockImplementation(() => {
      throw new Error('sessions.retain: unknown session session:member:builder')
    })
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    const alert = await b.view.findByRole('alert')
    expect(alert.textContent).toContain('sessions.retain: unknown session session:member:builder')
    // The row is not marked current: the navigation did not stay switched to a
    // Session the conversation seat never showed.
    expect(b.view.getByRole('button', { name: '打开 builder 的会话' }).getAttribute('aria-current')).toBeNull()
    await b.runtime.dispose()
  })

  it('marks the row current when the open succeeds', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await b.view.findByText('builder')
    // The bench's openSession retains against its catalog, so the Session has
    // to be a known one for the ordinary path to succeed.
    await b.runtime.sessions.add({ id: 'session:member:builder', summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => {
      expect(b.view.getByRole('button', { name: '打开 builder 的会话' }).getAttribute('aria-current')).toBe('page')
    })
    expect(b.view.queryByRole('alert')).toBeNull()
    await b.runtime.dispose()
  })
})
