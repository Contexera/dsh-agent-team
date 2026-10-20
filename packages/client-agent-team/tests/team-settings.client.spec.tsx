// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamHumanProfileResult } from '@contexera/dsh-agent-team/types'
import { TeamHumanIdentity, type TeamHumanIdentityLoader } from '../src/client/human-identity.ts'
import { TeamEnvironmentCheck, type TeamEnvironmentLoader } from '../src/client/environment-check.ts'
import { zh } from '../src/client/locales.ts'
import { TeamSettingsSection } from '../src/client/TeamSettingsSection.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof TeamSettingsSection>[0]['t']

const readFailure = (message: string): RemoteResult<AgentTeamHumanProfileResult> =>
  ({ ok: false, error: { message } }) as RemoteResult<AgentTeamHumanProfileResult>

const PROFILE = {
  name: 'Ada',
  version: '0.1.13',
  repoUrl: 'https://github.com/Contexera/dsh-agent-team',
}

/** One identity store over a fake Remote pair: the page's real read path. */
function identityWith(overrides: Record<string, unknown> = {}) {
  const loadProfile = vi.fn(async () => ({ ok: true as const, value: { ...PROFILE, ...overrides } }))
  const loadAvatarUrl = vi.fn(async () => null)
  return { identity: new TeamHumanIdentity({ loadProfile, loadAvatarUrl } as unknown as TeamHumanIdentityLoader), loadProfile, loadAvatarUrl }
}

/** An environment projection that never settles; the reference must be stable, as React requires of a store. */
const INERT_ENVIRONMENT = { status: 'loading' as const }
const INERT_ENVIRONMENT_SOURCE = {
  getSnapshot: () => INERT_ENVIRONMENT,
  subscribe: () => () => {},
}

/** Render the page with the faces a test cares about; the rest stay inert. */
function renderSection(injected: Record<string, unknown> = {}) {
  const { identity } = identityWith()
  const props = {
    close: () => {},
    t,
    identity,
    // The environment block is a separate projection; an inert one keeps these
    // identity tests about identity. The block's own behaviour is covered in
    // environment-check.client.spec.tsx.
    environment: INERT_ENVIRONMENT_SOURCE,
    saveName: vi.fn(async () => undefined),
    uploadAvatar: vi.fn(async () => undefined),
    removeAvatar: vi.fn(async () => undefined),
    ...injected,
  } as unknown as Parameters<typeof TeamSettingsSection>[0]
  return { ...render(<TeamSettingsSection {...props} />), props }
}

afterEach(cleanup)

describe('Team settings page: identity', () => {
  it('reads the profile once and shows the name, version, and repository link', async () => {
    const loadProfile = vi.fn(async () => ({ ok: true as const, value: PROFILE }))
    const identity = new TeamHumanIdentity({ loadProfile, loadAvatarUrl: async () => null })
    renderSection({ identity })
    await waitFor(() => {
      expect((screen.getByLabelText('名字') as HTMLInputElement).value).toBe('Ada')
    })
    expect(loadProfile).toHaveBeenCalledTimes(1)
    expect(screen.getByText('版本 0.1.13')).not.toBeNull()
    expect((screen.getByRole('link', { name: 'GitHub' }) as HTMLAnchorElement).href).toBe(PROFILE.repoUrl)
    // The page names what owns it, so the reader never has to guess whose
    // profile this is among the Harness's own settings pages.
    expect(screen.getByText(zh.teamSettingsIntro)).not.toBeNull()
    // Nothing to update: the footnote stays the two facts it promised.
    expect(screen.queryByText(/有新版本/)).toBeNull()
  })

  it('holds the page on a loading line until the first read settles', async () => {
    let settle: ((value: { ok: true; value: typeof PROFILE }) => void) | undefined
    const identity = new TeamHumanIdentity({
      loadProfile: () => new Promise(resolve => { settle = resolve as never }),
      loadAvatarUrl: async () => null,
    })
    renderSection({ identity })
    expect(screen.getByRole('status').textContent).toBe('正在载入资料…')
    // Every state answers the same question: this line is not part of the read.
    expect(screen.getByText(zh.teamSettingsIntro)).not.toBeNull()
    settle?.({ ok: true, value: PROFILE })
    await waitFor(() => { expect(screen.getByLabelText('名字')).not.toBeNull() })
  })

  it('reports an unreadable profile with the Host reason and retries the read', async () => {
    const loadProfile = vi.fn(async () => readFailure('host offline'))
    const identity = new TeamHumanIdentity({ loadProfile, loadAvatarUrl: async () => null })
    renderSection({ identity })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('资料读不出来：host offline') })
    // A failed read still says what the page is, next to why it is empty.
    expect(screen.getByText(zh.teamSettingsIntro)).not.toBeNull()
    loadProfile.mockImplementation(async (): Promise<RemoteResult<AgentTeamHumanProfileResult>> => ({ ok: true, value: PROFILE }))
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.getByLabelText('名字')).not.toBeNull() })
  })

  it('keeps a refused rename in the field and reports the Host reason', async () => {
    const saveName = vi.fn(async () => "human name 'Ada' collides with an existing Member handle")
    renderSection({ saveName })
    const field = await screen.findByLabelText('名字')
    fireEvent.change(field, { target: { value: 'Ada Lovelace' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(screen.getByRole('alert')).not.toBeNull() })
    expect(screen.getByRole('alert').textContent).toBe("名字没保存上：human name 'Ada' collides with an existing Member handle")
    // Non-optimistic: the typed value survives the refusal.
    expect((screen.getByLabelText('名字') as HTMLInputElement).value).toBe('Ada Lovelace')
  })

  it('clears the draft once the Host accepts the rename', async () => {
    const saveName = vi.fn(async () => undefined)
    renderSection({ saveName })
    const field = await screen.findByLabelText('名字')
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'Ada Lovelace' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(saveName).toHaveBeenCalledWith('Ada Lovelace') })
    await waitFor(() => { expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true) })
  })

  it('refuses an empty name and an oversized or non-image file before any round trip', async () => {
    const uploadAvatar = vi.fn(async () => undefined)
    renderSection({ uploadAvatar })
    const field = await screen.findByLabelText('名字')
    fireEvent.change(field, { target: { value: '   ' } })
    expect(screen.getByText('名字不能为空。')).not.toBeNull()
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)

    const picker = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(picker, { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('只收图片文件。') })
    const tooLarge = new File(['x'], 'big.png', { type: 'image/png' })
    Object.defineProperty(tooLarge, 'size', { value: 11 * 1024 * 1024 })
    fireEvent.change(picker, { target: { files: [tooLarge] } })
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('图片不能超过 10MB。') })
    expect(uploadAvatar).not.toHaveBeenCalled()
  })

  it('draws the uploaded avatar and offers removal only while one is configured', async () => {
    const identity = new TeamHumanIdentity({
      loadProfile: async () => ({ ok: true, value: { ...PROFILE, avatarRef: 'avatar:1' } }),
      loadAvatarUrl: async () => 'data:image/png;base64,AAAA',
    })
    const removeAvatar = vi.fn(async () => undefined)
    renderSection({ identity, removeAvatar })
    await waitFor(() => { expect(document.querySelector('img')).not.toBeNull() })
    expect(document.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    fireEvent.click(screen.getByRole('button', { name: '移除头像' }))
    await waitFor(() => { expect(removeAvatar).toHaveBeenCalledTimes(1) })
  })

  it('keeps the initial when the stored avatar cannot be decoded', async () => {
    const identity = new TeamHumanIdentity({
      loadProfile: async () => ({ ok: true, value: { ...PROFILE, name: 'Ada', avatarRef: 'avatar:1' } }),
      loadAvatarUrl: async () => 'data:image/png;base64,AAAA',
    })
    renderSection({ identity })
    const image = await waitFor(() => {
      const node = document.querySelector('[data-avatar="image"]')
      if (node === null) throw new Error('avatar image not mounted')
      return node
    })
    // The Host stores any `image/…` payload without decoding it, so a stored
    // reference is not evidence of a picture — the seat decides.
    fireEvent.error(image)
    await waitFor(() => { expect(document.querySelector('[data-avatar="initial"]')?.textContent).toBe('A') })
    expect(document.querySelector('img')).toBeNull()
  })

  it('falls back to the initial when the avatar bytes cannot be read', async () => {
    const identity = new TeamHumanIdentity({
      loadProfile: async () => ({ ok: true, value: { ...PROFILE, name: 'zoe', avatarRef: 'avatar:gone' } }),
      loadAvatarUrl: async () => null,
    })
    renderSection({ identity })
    await waitFor(() => { expect(screen.getByText('Z')).not.toBeNull() })
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: '移除头像' })).not.toBeNull()
  })

  it('carries the environment check for the installation it runs in', async () => {
    // The block is a separate projection fed through the section's injected
    // face; this pins the wiring between the two, so a page that stopped
    // passing the face would fail here rather than silently render nothing.
    const environment = new TeamEnvironmentCheck({
      loadEnvironment: async () => ({
        ok: true,
        value: {
          verdict: 'out-of-range',
          bundleVersion: '0.1.15',
          dshVersion: '0.1.6',
          certifiedDshVersion: '0.1.7-rc.1',
          supportRange: { lower: '0.1.7-rc.1', upper: '0.1.8' },
        },
      }),
    } as unknown as TeamEnvironmentLoader)
    renderSection({ environment })
    await waitFor(() => { expect(screen.getByText(zh.environmentOutOfRangeTitle)).not.toBeNull() })
    // Above the version footnote, which is the page's other version fact.
    const footnote = screen.getByText('版本 0.1.13')
    expect(screen.getByText(zh.environmentOutOfRangeTitle).compareDocumentPosition(footnote))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})
