// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Stands in for the shipped plugin manager's global panel (main key 'plugins'). */
function ShippedPluginPage() { return <div data-shipped-plugins>插件</div> }

/**
 * The shell renders one keyed main panel — `activePanelId ?? 'conversation'` —
 * and the Team is one of those panels: the sidebar rail's Team row selects it and
 * the mode follows the selection. A global panel the Human selected owns the
 * column until that row takes it back, and a restored Team mode yields to a panel
 * that was already selected when the page loaded.
 */
describe('Team mode and the shell main panel', () => {
  it('yields a restored Team mode to a global panel already selected at mount', async () => {
    const b = await runtimeWithTeam({ mode: 'team', mainPanelId: 'plugins', workspaceId: 'w1' })
    // The panel owns the column, so the restored mode stands down rather than
    // covering the page the reader left open.
    await waitFor(() => expect(b.runtime.ctx.teamNavigation.getSnapshot().mode).toBe('conversation'))
    expect(b.panelInfo.getSnapshot().activePanelId).toBe('plugins')
  })

  it('takes the column back from a global panel when the rail row selects the Team', async () => {
    const b = await runtimeWithTeam({})
    b.runtime.slots.register({ name: 'main', key: 'plugins' }, ShippedPluginPage as never)
    await act(async () => { b.selectPanel('plugins') })
    expect(await b.view.findByText('插件')).toBeTruthy()

    // The rail row is the shell's own button: it selects the panel, and the mode
    // is what follows.
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))

    await waitFor(() => expect(b.panelInfo.getSnapshot().activePanelId).toBe('agent-team'))
    expect(b.runtime.ctx.teamNavigation.getSnapshot().mode).toBe('team')
    expect(b.view.container.querySelector('[data-shipped-plugins]')).toBeNull()
  })

  it('keeps the Team panel selected while the mode navigates inside itself', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await act(async () => { b.selectPanel('agent-team') })
    // The Team's own overview stands in the column while the panel is selected.
    expect(await b.view.findByRole('button', { name: '# engineering' })).toBeTruthy()

    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))

    // A Team destination is not a panel: the rail keeps saying which destination
    // the column belongs to while the Team's own pages move underneath it.
    await waitFor(() => expect(b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy())
    expect(b.panelInfo.getSnapshot().activePanelId).toBe('agent-team')
    expect(b.runtime.ctx.teamNavigation.getSnapshot().mode).toBe('team')
  })
})
