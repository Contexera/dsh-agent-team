// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import type { AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Open the seeded Channel in Team mode: the surface that names and draws the Human. */
async function openSeededChannel(options?: Parameters<typeof runtimeWithTeam>[0]) {
  const b = await runtimeWithTeam({
    initialChannels: true,
    seededMessages: [{ body: 'human note', occurredAt: '2026-08-21T10:00:00.000Z', sender: 'human' }],
    ...options,
  })
  fireEvent.click(b.view.getByRole('button', { name: '团队' }))
  fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
  const page = await waitFor(() => {
    const node = b.view.container.querySelector('[data-team-channel]') as HTMLElement | null
    if (node === null) throw new Error('channel page not mounted')
    return node
  })
  return { b, page }
}

describe('Human identity in the Team surfaces', () => {
  it('names the Human by the profile name the Host reports', async () => {
    const { page } = await openSeededChannel({ humanProfile: { name: 'Ada' } })
    await waitFor(() => { expect(within(page).getByText('Ada')).toBeTruthy() })
    expect(within(page).queryByText('Human')).toBeNull()
    expect(page.querySelector('img')).toBeNull()
  })

  it('keeps the localized name when the profile cannot be read', async () => {
    const { page } = await openSeededChannel({ humanProfileFailure: 'host offline' })
    await waitFor(() => { expect(within(page).getByText('Human')).toBeTruthy() })
  })

  it('draws the uploaded avatar in the message identity seat', async () => {
    const { b, page } = await openSeededChannel({ humanProfile: { name: 'Ada', avatarRef: 'avatar:1' } })
    await waitFor(() => { expect(page.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA') })
    expect(b.getHumanAvatar).toHaveBeenCalledWith({ avatarRef: 'avatar:1' })
  })

  it('keeps the initial in the message seat when those bytes do not decode', async () => {
    const { page } = await openSeededChannel({ humanProfile: { name: 'Ada', avatarRef: 'avatar:1' } })
    const image = await waitFor(() => {
      const node = page.querySelector('[data-avatar="image"]')
      if (node === null) throw new Error('message avatar not mounted')
      return node
    })
    fireEvent.error(image)
    await waitFor(() => { expect(page.querySelector('[data-avatar="initial"]')?.textContent).toBe('A') })
    expect(page.querySelector('img')).toBeNull()
  })

  it('keeps the uploaded avatar off Agent rows in the channel feed', async () => {
    const { page } = await openSeededChannel({
      humanProfile: { name: 'Ada', avatarRef: 'avatar:1' },
      seededMessages: [
        { body: 'human note', occurredAt: '2026-08-21T10:00:00.000Z', sender: 'human' },
        { body: 'agent note', occurredAt: '2026-08-21T10:05:00.000Z', sender: 'agent' },
      ],
    })
    // The profile picture belongs to the Human's own seat: an Agent row keeps
    // its own hue and initial, so the feed never paints two people alike.
    const seats = await waitFor(() => {
      const rows = [...page.querySelectorAll('article')]
      if (rows.length < 2) throw new Error('feed rows not mounted')
      return rows.map(row => ({
        human: row.hasAttribute('data-human'),
        seat: row.querySelector('[data-avatar]')?.getAttribute('data-avatar'),
        src: row.querySelector('img')?.getAttribute('src'),
      }))
    })
    expect(seats).toEqual([
      { human: true, seat: 'image', src: 'data:image/png;base64,AAAA' },
      { human: false, seat: 'initial', src: undefined },
    ])
  })

  it('chips an agent message that wrote the historic human handle as the renamed Human', async () => {
    const { page } = await openSeededChannel({
      humanProfile: { name: 'Ada' },
      seededMessages: [{
        body: 'ping @human please look',
        occurredAt: '2026-08-21T10:00:00.000Z',
        sender: 'agent',
        mentions: ['member:human' as AgentTeamMemberId],
      }],
    })
    // The chip lands where the body authored the mention and names the reader
    // as they are called today; the trailing row must not repeat the same
    // person under the name the body already carries.
    await waitFor(() => { expect(within(page).getByText('@Ada')).toBeTruthy() })
    expect(page.textContent).toContain('ping @Ada please look')
    expect(within(page).queryByText('@human')).toBeNull()
    expect(within(page).getAllByText('@Ada').length).toBe(1)
  })
})
