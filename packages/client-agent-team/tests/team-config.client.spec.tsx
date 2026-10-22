// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamHumanProfileResult } from '@contexera/dsh-agent-team/types'
import { TeamHumanIdentity } from '../src/client/human-identity.ts'
import { zh } from '../src/client/locales.ts'
import { TeamConfigController, teamConfigScope, type TeamConfigSection } from '../src/client/team-config.ts'
import { TeamSettingsSection } from '../src/client/TeamSettingsSection.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof TeamSettingsSection>[0]['t']

const PROFILE = {
  name: 'Ada',
  version: '0.1.13',
  repoUrl: 'https://github.com/Contexera/dsh-agent-team',
}

const INERT_ENVIRONMENT = { status: 'loading' as const }
const INERT_ENVIRONMENT_SOURCE = {
  getSnapshot: () => INERT_ENVIRONMENT,
  subscribe: () => () => {},
}

/** One Host row stub: the resolved value, the composition layer under it, and the raw user layer. */
function hostRow(options: { tokens?: number; baseTokens?: number; revision?: number } = {}) {
  const form = stubConfigForm<TeamConfigSection>()
  form.publish({
    status: 'ready',
    writable: true,
    revision: options.revision ?? 1,
    // The real Host row carries an `enabled` sibling beside the threshold; the
    // form's section type names only the field it reads.
    value: { memberCompaction: { enabled: true, tokens: options.tokens ?? 256_000 } } as TeamConfigSection,
    base: { memberCompaction: { tokens: options.baseTokens ?? 256_000 } },
    user: options.tokens === undefined ? {} : { memberCompaction: { tokens: options.tokens } },
  })
  return form
}

/** Render the page with the real configuration controller over one stubbed row. */
function renderSection(row = hostRow()) {
  const identity = new TeamHumanIdentity({
    loadProfile: async (): Promise<RemoteResult<AgentTeamHumanProfileResult>> => ({ ok: true, value: PROFILE }),
    loadAvatarUrl: async () => null,
  })
  const teamConfig = new TeamConfigController(teamConfigScope(row.scope))
  const props = {
    close: () => {},
    t,
    identity,
    environment: INERT_ENVIRONMENT_SOURCE,
    saveName: vi.fn(async () => undefined),
    uploadAvatar: vi.fn(async () => undefined),
    removeAvatar: vi.fn(async () => undefined),
    teamConfig,
  } as unknown as Parameters<typeof TeamSettingsSection>[0]
  const rendered = render(<TeamSettingsSection {...props} />)
  return { ...rendered, row, teamConfig }
}

/** The context group's own region: the identity rows above it also carry a Save. */
async function contextGroup() {
  return within(await screen.findByRole('region', { name: zh.memberCompactionTitle }))
}

afterEach(cleanup)

describe('Team settings page: the Host row configuration group', () => {
  it('renders the resolved threshold in its capacity spelling', async () => {
    renderSection()
    const group = await contextGroup()
    expect((group.getByLabelText(zh.memberCompactionTokens) as HTMLInputElement).value).toBe('256K')
    // The resolved value is the schema default, not a stored override: the
    // badge and its reset stay away until the user layer carries the field.
    expect(group.queryByText(zh.overridden)).toBeNull()
    expect(group.queryByRole('button', { name: zh.reset })).toBeNull()
  })

  it('writes a typed capacity as a child path of the group, never restating its siblings', async () => {
    const { row } = renderSection()
    const group = await contextGroup()
    const field = group.getByLabelText(zh.memberCompactionTokens)
    fireEvent.change(field, { target: { value: '512K' } })
    // What a save would store is previewed while the draft stands, even though
    // the user layer does not carry the field yet.
    expect(group.getByText(zh.overridden)).not.toBeNull()
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(row.mutate).toHaveBeenCalledWith(
        [{ op: 'set', path: ['memberCompaction', 'tokens'], value: 512_000 }],
        1,
      )
    })
  })

  it('keeps an unreadable draft, blocks its save, and says what the field accepts', async () => {
    const { row } = renderSection()
    const group = await contextGroup()
    const field = group.getByLabelText(zh.memberCompactionTokens)
    fireEvent.change(field, { target: { value: '2GB' } })
    expect(group.getByText(zh.memberCompactionTokenInvalid)).not.toBeNull()
    expect((field as HTMLInputElement).value).toBe('2GB')
    expect((group.getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    expect(row.mutate).not.toHaveBeenCalled()
  })

  it('keeps a refused save staged and reports that the deployment did not accept it', async () => {
    const row = hostRow({ tokens: 512_000 })
    row.mutate.mockResolvedValue(false)
    renderSection(row)
    const group = await contextGroup()
    const field = group.getByLabelText(zh.memberCompactionTokens)
    fireEvent.change(field, { target: { value: '1M' } })
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await waitFor(() => { expect(group.getByRole('status').textContent).toBe(zh.saveFailed) })
    expect((field as HTMLInputElement).value).toBe('1M')
    expect(row.mutate).toHaveBeenCalledWith(
      [{ op: 'set', path: ['memberCompaction', 'tokens'], value: 1_000_000 }],
      1,
    )
  })

  it('clears a stored override back to the composition layer and to the default placeholder', async () => {
    const row = hostRow({ tokens: 512_000 })
    renderSection(row)
    const group = await contextGroup()
    expect(group.getByText(zh.overridden)).not.toBeNull()
    fireEvent.change(group.getByLabelText(zh.memberCompactionTokens), { target: { value: '' } })
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(row.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['memberCompaction', 'tokens'] }], 1)
    })
  })

  it('resets a stored override to the composition value and stages a clear', async () => {
    const row = hostRow({ tokens: 512_000, baseTokens: 256_000 })
    renderSection(row)
    const group = await contextGroup()
    fireEvent.click(group.getByRole('button', { name: zh.reset }))
    const field = group.getByLabelText(zh.memberCompactionTokens) as HTMLInputElement
    expect(field.value).toBe('256K')
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await waitFor(() => {
      expect(row.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['memberCompaction', 'tokens'] }], 1)
    })
  })

  it('renders the group as unavailable while the Host row is not served', async () => {
    const row = stubConfigForm<TeamConfigSection>()
    renderSection(row)
    const group = await contextGroup()
    expect(group.getByRole('status').textContent).toBe(zh.unavailable)
    expect(group.queryByLabelText(zh.memberCompactionTokens)).toBeNull()
  })
})
