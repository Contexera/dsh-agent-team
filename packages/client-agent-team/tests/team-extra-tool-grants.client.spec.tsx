// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamHumanProfileResult, AgentTeamToolCatalogResult } from '@contexera/dsh-agent-team/types'
import { HUMAN_PROFILE_SETTINGS_NAMESPACE } from '@contexera/dsh-agent-team/human-settings'
import { TeamHumanIdentity } from '../src/client/human-identity.ts'
import { ExtraToolGrantsController } from '../src/client/extra-tool-grants.ts'
import { zh } from '../src/client/locales.ts'
import { TeamSettingsSection } from '../src/client/TeamSettingsSection.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof TeamSettingsSection>[0]['t']

const PROFILE = {
  name: 'Ada',
  version: '0.2.7',
  repoUrl: 'https://github.com/Contexera/dsh-agent-team',
}

const INERT_ENVIRONMENT = { status: 'loading' as const }
const INERT_ENVIRONMENT_SOURCE = {
  getSnapshot: () => INERT_ENVIRONMENT,
  subscribe: () => () => {},
}

function view(names: readonly string[], revision: number): SettingsNamespaceView {
  return {
    autoGenerate: false,
    ns: HUMAN_PROFILE_SETTINGS_NAMESPACE,
    schema: {},
    value: { extraToolGrants: [...names] },
    user: { extraToolGrants: [...names] },
    applies: 'live',
    secrets: [],
    revision,
  } as SettingsNamespaceView
}

function describeValue(names: readonly string[], revision: number, writable = true): RemoteResult<SettingsDescribeValue> {
  return {
    ok: true,
    value: {
      writable,
      hasDocument: true,
      namespaces: [view(names, revision)],
    },
  }
}

interface GrantHost {
  readonly controller: ExtraToolGrantsController
  readonly describe: ReturnType<typeof vi.fn<() => Promise<RemoteResult<SettingsDescribeValue>>>>
  readonly mutate: ReturnType<typeof vi.fn<(
    namespace: string,
    ops: readonly SettingsPathOpView[],
    expectedRevision: number | undefined,
  ) => Promise<RemoteResult<SettingsNamespaceView>>>>
  readonly catalog: ReturnType<typeof vi.fn<() => Promise<RemoteResult<AgentTeamToolCatalogResult>>>>
  readonly names: string[]
  revision: number
}

function grantHost(options: {
  readonly names?: readonly string[]
  readonly revision?: number
  readonly writable?: boolean
  readonly catalog?: readonly string[]
  readonly catalogFailure?: string
} = {}): GrantHost {
  const host: GrantHost = {
    names: [...(options.names ?? [])],
    revision: options.revision ?? 1,
    describe: vi.fn<() => Promise<RemoteResult<SettingsDescribeValue>>>(),
    mutate: vi.fn<(
      namespace: string,
      ops: readonly SettingsPathOpView[],
      expectedRevision: number | undefined,
    ) => Promise<RemoteResult<SettingsNamespaceView>>>(),
    catalog: vi.fn<() => Promise<RemoteResult<AgentTeamToolCatalogResult>>>(),
    controller: undefined as never,
  }
  host.describe.mockImplementation(async () => describeValue(host.names, host.revision, options.writable ?? true))
  host.mutate.mockImplementation(async (
    _namespace: string,
    ops: readonly SettingsPathOpView[],
    _expectedRevision: number | undefined,
  ) => {
    const op = ops[0]
    if (op?.op !== 'set') throw new Error('test host expects one set operation')
    host.names.splice(0, host.names.length, ...(op.value as string[]))
    host.revision += 1
    return { ok: true as const, value: view(host.names, host.revision) }
  })
  host.catalog.mockImplementation(async (): Promise<RemoteResult<AgentTeamToolCatalogResult>> =>
    options.catalogFailure === undefined
      ? { ok: true, value: { names: [...(options.catalog ?? [])] } }
      : { ok: false, error: { message: options.catalogFailure } } as RemoteResult<AgentTeamToolCatalogResult>)
  const controller = new ExtraToolGrantsController({
    namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
    settings: { describe: host.describe, mutate: host.mutate },
    catalog: { load: host.catalog },
  })
  ;(host as { controller: ExtraToolGrantsController }).controller = controller
  return host
}

function identityWith(failure?: string): TeamHumanIdentity {
  return new TeamHumanIdentity({
    loadProfile: async (): Promise<RemoteResult<AgentTeamHumanProfileResult>> => failure === undefined
      ? { ok: true, value: PROFILE }
      : { ok: false, error: { message: failure } } as RemoteResult<AgentTeamHumanProfileResult>,
    loadAvatarUrl: async () => null,
  })
}

function renderSection(host: GrantHost, identity = identityWith()) {
  const props = {
    close: () => {},
    t,
    identity,
    environment: INERT_ENVIRONMENT_SOURCE,
    saveName: vi.fn(async () => undefined),
    uploadAvatar: vi.fn(async () => undefined),
    removeAvatar: vi.fn(async () => undefined),
    extraToolGrants: host.controller,
  } as unknown as Parameters<typeof TeamSettingsSection>[0]
  return render(<TeamSettingsSection {...props} />)
}

async function grantsGroup() {
  return within(await screen.findByRole('region', { name: zh.extraToolsTitle }))
}

afterEach(cleanup)

describe('Team settings: profile extra tool grants', () => {
  it('searches exact catalog names, stages multiple choices, cancels them, saves, and clears explicitly', async () => {
    const host = grantHost({ names: ['Beta'], revision: 3, catalog: ['Alpha', 'beta', 'Beta', 'Gamma'] })
    renderSection(host)
    const group = await grantsGroup()
    expect(group.getByText(zh.extraToolsIntro)).not.toBeNull()
    expect(group.getByText(zh.extraToolsRegistrationHint)).not.toBeNull()
    expect(group.getByText(zh.extraToolsSearchHint)).not.toBeNull()
    const search = group.getByLabelText(zh.extraToolsSearch)
    await group.findByRole('checkbox', { name: 'Beta' })
    expect((group.getByRole('checkbox', { name: 'Beta' }) as HTMLInputElement).checked).toBe(true)
    expect((group.getByRole('checkbox', { name: 'beta' }) as HTMLInputElement).checked).toBe(false)

    fireEvent.change(search, { target: { value: 'alpha' } })
    expect(group.queryByRole('checkbox', { name: 'Beta' })).toBeNull()
    fireEvent.click(group.getByRole('checkbox', { name: 'Alpha' }))
    expect(group.getByText('已选 2 个名称')).not.toBeNull()
    fireEvent.click(group.getByRole('button', { name: zh.cancel }))
    expect((group.getByRole('checkbox', { name: 'Alpha' }) as HTMLInputElement).checked).toBe(false)

    fireEvent.click(group.getByRole('checkbox', { name: 'Alpha' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await waitFor(() => expect(host.mutate).toHaveBeenCalledWith(
      HUMAN_PROFILE_SETTINGS_NAMESPACE,
      [{ op: 'set', path: ['extraToolGrants'], value: ['Alpha', 'Beta'] }],
      3,
    ))
    await group.findByText(zh.extraToolsSaved)

    fireEvent.click(group.getByRole('button', { name: zh.extraToolsClear }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await waitFor(() => expect(host.mutate).toHaveBeenLastCalledWith(
      HUMAN_PROFILE_SETTINGS_NAMESPACE,
      [{ op: 'set', path: ['extraToolGrants'], value: [] }],
      4,
    ))
  })

  it('keeps a large loaded list editable without imposing a separate UI quota', async () => {
    const names = Array.from({ length: 200 }, (_, index) => `tool_${index}`)
    const host = grantHost({ names, catalog: ['another_tool'] })
    renderSection(host)
    const group = await grantsGroup()
    const choice = await group.findByRole('checkbox', { name: 'another_tool' })
    expect((choice as HTMLInputElement).disabled).toBe(false)
    fireEvent.click(choice)
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await group.findByText(zh.extraToolsSaved)
    expect(host.names).toEqual([...names, 'another_tool'].sort())
  })

  it('keeps and removes a selected name that is absent from the loaded catalog', async () => {
    const host = grantHost({ names: ['Alpha', 'removed_tool'], catalog: ['Alpha'] })
    renderSection(host)
    const group = await grantsGroup()
    expect(await group.findByText('当前未注册', { selector: '[data-extra-tool-missing] > div' })).not.toBeNull()
    expect((group.getByRole('checkbox', { name: /removed_tool/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(group.getByRole('checkbox', { name: /removed_tool/ }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await waitFor(() => expect(host.mutate).toHaveBeenCalledWith(
      HUMAN_PROFILE_SETTINGS_NAMESPACE,
      [{ op: 'set', path: ['extraToolGrants'], value: ['Alpha'] }],
      1,
    ))
  })

  it('distinguishes catalog loading, failure, empty, and search with no matches', async () => {
    let settleCatalog: ((value: RemoteResult<AgentTeamToolCatalogResult>) => void) | undefined
    const host = grantHost({ names: ['Alpha'] })
    host.catalog.mockImplementation(() => new Promise(resolve => { settleCatalog = resolve }))
    renderSection(host)
    let group = await grantsGroup()
    expect(await group.findByText(zh.extraToolsCatalogLoading)).not.toBeNull()
    expect(group.getByText(zh.extraToolsSelectedTitle)).not.toBeNull()
    expect(group.getByText(zh.extraToolsSelectedHint)).not.toBeNull()
    expect(group.queryByText(zh.extraToolsMissingBadge, { selector: '[data-extra-tool-missing] span' })).toBeNull()
    settleCatalog?.({ ok: true, value: { names: [] } })
    expect(await group.findByText(zh.extraToolsCatalogEmpty)).not.toBeNull()
    expect(await group.findByText(zh.extraToolsMissingBadge, { selector: '[data-extra-tool-missing] span' })).not.toBeNull()

    cleanup()
    const failed = grantHost({ names: ['Alpha'], catalogFailure: 'catalog offline' })
    renderSection(failed)
    group = await grantsGroup()
    expect(await group.findByText(zh.extraToolsCatalogFailed.replace('{message}', 'catalog offline'))).not.toBeNull()
    expect(group.getByText(zh.extraToolsSelectedTitle)).not.toBeNull()
    expect(group.getByText(zh.extraToolsSelectedHint)).not.toBeNull()
    expect(group.queryByText(zh.extraToolsMissingTitle)).toBeNull()

    cleanup()
    const searchable = grantHost({ catalog: ['Alpha', 'Beta'] })
    renderSection(searchable)
    group = await grantsGroup()
    await group.findByRole('checkbox', { name: 'Alpha' })
    fireEvent.change(group.getByLabelText(zh.extraToolsSearch), { target: { value: 'no-such-tool' } })
    expect(group.getByText(zh.extraToolsNoMatches)).not.toBeNull()
  })

  it('does not state a selected count until the saved list has been read', async () => {
    const host = grantHost({ names: ['Alpha'] })
    const pending = Promise.withResolvers<RemoteResult<SettingsDescribeValue>>()
    host.describe.mockImplementationOnce(() => pending.promise)
    renderSection(host)
    const group = await grantsGroup()
    expect(group.queryByText(/已选 \d+ 个名称/)).toBeNull()
    pending.resolve(describeValue(['Alpha'], 1))
    expect(await group.findByText('已选 1 个名称')).not.toBeNull()
  })

  it('does not treat a failed list read as an empty saved list', async () => {
    const host = grantHost()
    host.describe.mockResolvedValue({
      ok: false,
      error: { message: 'settings offline' },
    } as RemoteResult<SettingsDescribeValue>)
    renderSection(host)
    const group = await grantsGroup()
    expect(await group.findByRole('alert')).toBeTruthy()
    expect(group.getByRole('alert').textContent).toContain('settings offline')
    expect(group.queryByText(/已选 \d+ 个名称/)).toBeNull()
    expect((group.getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(true)
    expect(host.mutate).not.toHaveBeenCalled()
  })

  it('keeps the draft on rejection and transport failure, with distinct messages', async () => {
    const rejected = grantHost({ catalog: ['Alpha'] })
    rejected.mutate.mockResolvedValue({
      ok: false,
      error: { code: 'settings/rejected', message: 'read-only profile' },
    } as RemoteResult<SettingsNamespaceView>)
    renderSection(rejected)
    let group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Alpha' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    expect(await group.findByText(zh.extraToolsRejected.replace('{message}', 'read-only profile'))).not.toBeNull()
    expect((group.getByRole('checkbox', { name: 'Alpha' }) as HTMLInputElement).checked).toBe(true)
    expect((group.getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(false)

    cleanup()
    const dropped = grantHost({ catalog: ['Beta'] })
    dropped.mutate.mockRejectedValue(new Error('carrier dropped'))
    renderSection(dropped)
    group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Beta' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    expect(await group.findByText(zh.extraToolsWriteFailed.replace('{message}', 'carrier dropped'))).not.toBeNull()
    expect((group.getByRole('checkbox', { name: 'Beta' }) as HTMLInputElement).checked).toBe(true)
  })

  it('shows the latest committed list on conflict, keeps the draft, and waits for explicit review', async () => {
    const host = grantHost({ names: ['Alpha'], catalog: ['Alpha', 'Beta'] })
    host.mutate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'settings/conflict', message: 'revision 2 won', details: { ns: HUMAN_PROFILE_SETTINGS_NAMESPACE, expected: 1, actual: 2 } },
    } as RemoteResult<SettingsNamespaceView>)
    host.describe.mockResolvedValueOnce(describeValue(['Alpha'], 1))
    host.describe.mockResolvedValueOnce(describeValue([], 2))
    renderSection(host)
    const group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Beta' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))

    const conflict = await group.findByText(zh.extraToolsConflictTitle)
    expect(conflict).not.toBeNull()
    expect(group.getByText('空名单')).not.toBeNull()
    expect((group.getByRole('checkbox', { name: 'Alpha' }) as HTMLInputElement).checked).toBe(true)
    expect((group.getByRole('checkbox', { name: 'Beta' }) as HTMLInputElement).checked).toBe(true)
    expect((group.getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(true)
    expect(host.mutate).toHaveBeenCalledTimes(1)

    fireEvent.click(group.getByRole('button', { name: zh.extraToolsConflictReviewed }))
    expect((group.getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(false)
    expect(host.mutate).toHaveBeenCalledTimes(1)
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await waitFor(() => expect(host.mutate).toHaveBeenLastCalledWith(
      HUMAN_PROFILE_SETTINGS_NAMESPACE,
      [{ op: 'set', path: ['extraToolGrants'], value: ['Alpha', 'Beta'] }],
      2,
    ))
  })

  it('lands focus on a conflict and then on its review control', async () => {
    const host = grantHost({ names: ['Alpha'], catalog: ['Alpha', 'Beta'] })
    const latest = Promise.withResolvers<RemoteResult<SettingsDescribeValue>>()
    host.describe
      .mockResolvedValueOnce(describeValue(['Alpha'], 1))
      .mockImplementationOnce(() => latest.promise)
    host.mutate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'settings/conflict', message: 'newer revision', details: { expected: 1, actual: 2 } },
    } as RemoteResult<SettingsNamespaceView>)
    renderSection(host)
    const group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Beta' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    const conflict = await group.findByText(zh.extraToolsConflictTitle)
    expect(document.activeElement).toBe(conflict.closest('[data-extra-tool-conflict]'))
    expect((group.getByRole('button', { name: zh.extraToolsConflictReviewed }) as HTMLButtonElement).disabled).toBe(true)
    latest.resolve(describeValue([], 2))
    await waitFor(() => expect(
      (group.getByRole('button', { name: zh.extraToolsConflictReviewed }) as HTMLButtonElement).disabled,
    ).toBe(false))
    expect(document.activeElement).toBe(group.getByRole('button', { name: zh.extraToolsConflictReviewed }))
  })

  it('does not pull focus back when the reader moved on during a conflict reload', async () => {
    const host = grantHost({ names: ['Alpha'], catalog: ['Alpha', 'Beta'] })
    const latest = Promise.withResolvers<RemoteResult<SettingsDescribeValue>>()
    host.describe
      .mockResolvedValueOnce(describeValue(['Alpha'], 1))
      .mockImplementationOnce(() => latest.promise)
    host.mutate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'settings/conflict', message: 'newer revision', details: { expected: 1, actual: 2 } },
    } as RemoteResult<SettingsNamespaceView>)
    renderSection(host)
    const group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Beta' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    const conflict = await group.findByText(zh.extraToolsConflictTitle)
    expect(document.activeElement).toBe(conflict.closest('[data-extra-tool-conflict]'))
    const search = group.getByLabelText(zh.extraToolsSearch)
    search.focus()
    latest.resolve(describeValue([], 2))
    await waitFor(() => expect(
      (group.getByRole('button', { name: zh.extraToolsConflictReviewed }) as HTMLButtonElement).disabled,
    ).toBe(false))
    expect(document.activeElement).toBe(search)
  })

  it('keeps a conflict awaiting review when the latest list read is retried and succeeds', async () => {
    const host = grantHost({ names: ['Alpha'], catalog: ['Alpha', 'Beta'] })
    host.mutate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'settings/conflict', message: 'newer revision', details: { ns: HUMAN_PROFILE_SETTINGS_NAMESPACE, expected: 1, actual: 2 } },
    } as RemoteResult<SettingsNamespaceView>)
    host.describe
      .mockResolvedValueOnce(describeValue(['Alpha'], 1))
      .mockRejectedValueOnce(new Error('settings carrier lost'))
      .mockResolvedValueOnce(describeValue([], 2))
    renderSection(host)
    const group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Beta' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    expect(await group.findByText(zh.extraToolsConflictReloadFailed.replace('{message}', 'settings carrier lost'))).not.toBeNull()
    expect(group.getByText(zh.extraToolsCommittedUnavailable)).not.toBeNull()
    expect(group.queryByText(zh.extraToolsEmpty)).toBeNull()
    expect((group.getByRole('button', { name: zh.extraToolsConflictReviewed }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(group.getByRole('button', { name: zh.retry }))
    await waitFor(() => expect((group.getByRole('button', { name: zh.extraToolsConflictReviewed }) as HTMLButtonElement).disabled).toBe(false))
    expect(group.getByText(zh.extraToolsConflictTitle)).not.toBeNull()
    expect((group.getByRole('checkbox', { name: 'Alpha' }) as HTMLInputElement).checked).toBe(true)
    expect((group.getByRole('checkbox', { name: 'Beta' }) as HTMLInputElement).checked).toBe(true)
    expect((group.getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(true)
    expect(host.mutate).toHaveBeenCalledTimes(1)
  })

  it('does not make revoked grants saveable when cancelled during a conflict reload', async () => {
    const host = grantHost({ names: ['Alpha'], catalog: ['Alpha', 'Beta'] })
    const latest = Promise.withResolvers<RemoteResult<SettingsDescribeValue>>()
    host.describe
      .mockResolvedValueOnce(describeValue(['Alpha'], 1))
      .mockImplementationOnce(() => latest.promise)
    host.mutate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'settings/conflict', message: 'newer revision', details: { expected: 1, actual: 2 } },
    } as RemoteResult<SettingsNamespaceView>)
    renderSection(host)
    const group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Beta' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await group.findByText(zh.extraToolsCommittedLoading)
    expect((group.getByRole('button', { name: zh.cancel }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(group.getByRole('button', { name: zh.cancel }))
    act(() => {
      host.controller.discard()
      host.controller.acknowledgeConflict()
    })
    latest.resolve(describeValue([], 2))
    await waitFor(() => expect(host.controller.getSnapshot().revision).toBe(2))
    expect(host.controller.getSnapshot()).toMatchObject({
      draft: ['Alpha', 'Beta'], committed: [], canSave: false, awaitingReview: true,
    })
    fireEvent.click(group.getByRole('button', { name: zh.cancel }))
    expect(host.controller.getSnapshot()).toMatchObject({
      draft: [], committed: [], canSave: false, awaitingReview: false,
    })
    expect(host.mutate).toHaveBeenCalledTimes(1)
  })

  it('blocks stale draft actions while reloading the accepted list', async () => {
    const host = grantHost({ names: ['Alpha'], catalog: ['Alpha', 'Beta'] })
    renderSection(host)
    const group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Beta' }))
    const latest = Promise.withResolvers<RemoteResult<SettingsDescribeValue>>()
    host.describe.mockImplementationOnce(() => latest.promise)
    act(() => { host.controller.load() })
    expect(host.controller.getSnapshot()).toMatchObject({ listStatus: 'loading', canSave: false, canDiscard: false })
    act(() => {
      host.controller.save()
      host.controller.discard()
    })
    expect(host.mutate).not.toHaveBeenCalled()
    expect(host.controller.getSnapshot().draft).toEqual(['Alpha', 'Beta'])
    latest.reject(new Error('settings offline'))
    await waitFor(() => expect(host.controller.getSnapshot().listStatus).toBe('error'))
    expect(host.controller.getSnapshot()).toMatchObject({ canSave: false, canDiscard: false })
  })

  it('keeps a pending save locked across a settings remount', async () => {
    const host = grantHost({ catalog: ['Alpha'] })
    const saved = Promise.withResolvers<RemoteResult<SettingsNamespaceView>>()
    host.mutate.mockImplementationOnce(() => saved.promise)
    renderSection(host)
    let group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Alpha' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    cleanup()
    renderSection(host)
    group = await grantsGroup()
    expect(host.describe).toHaveBeenCalledTimes(1)
    expect(host.controller.getSnapshot()).toMatchObject({ saving: true, canSave: false, canDiscard: false })
    saved.resolve({ ok: true, value: view(['Alpha'], 2) })
    await group.findByText(zh.extraToolsSaved)
    expect(host.controller.getSnapshot()).toMatchObject({ committed: ['Alpha'], saving: false })
  })

  it('does not invent a saved list from an undecodable successful response', async () => {
    const host = grantHost({ names: ['Alpha'], catalog: ['Alpha', 'Beta'] })
    host.mutate.mockResolvedValueOnce({ ok: true, value: { ...view([], 2), value: {} } })
    renderSection(host)
    const group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Beta' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await waitFor(() => expect(host.controller.getSnapshot().listStatus).toBe('error'))
    expect(host.controller.getSnapshot()).toMatchObject({
      committed: ['Alpha'], draft: ['Alpha', 'Beta'], canSave: false, revision: undefined,
    })
    expect(group.queryByText(zh.extraToolsSaved)).toBeNull()
  })

  it('ignores an older conflict reload after a remount reads a newer revision', async () => {
    const host = grantHost({ names: ['Alpha'], catalog: ['Alpha', 'Beta'] })
    const older = Promise.withResolvers<RemoteResult<SettingsDescribeValue>>()
    host.describe
      .mockResolvedValueOnce(describeValue(['Alpha'], 1))
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce(describeValue(['Gamma'], 3))
    host.mutate.mockResolvedValueOnce({
      ok: false,
      error: { code: 'settings/conflict', message: 'newer revision', details: { expected: 1, actual: 2 } },
    } as RemoteResult<SettingsNamespaceView>)
    renderSection(host)
    let group = await grantsGroup()
    fireEvent.click(await group.findByRole('checkbox', { name: 'Beta' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await group.findByText(zh.extraToolsCommittedLoading)
    cleanup()
    renderSection(host)
    group = await grantsGroup()
    await waitFor(() => expect(host.controller.getSnapshot().revision).toBe(3))
    await act(async () => { older.resolve(describeValue([], 2)) })
    expect(host.controller.getSnapshot()).toMatchObject({
      committed: ['Gamma'], draft: ['Alpha', 'Beta'], revision: 3, canSave: false, awaitingReview: true,
    })
    expect(group.getByText(zh.extraToolsConflictTitle)).not.toBeNull()
  })

  it('still removes a loaded grant when Human identity and the catalog both fail', async () => {
    const host = grantHost({ names: ['Alpha'], catalogFailure: 'catalog offline' })
    renderSection(host, identityWith('identity offline'))
    const group = await grantsGroup()
    expect(await group.findByText(zh.extraToolsSelectedTitle)).not.toBeNull()
    expect(screen.getByText(zh.humanSettingsUnavailable.replace('{message}', 'identity offline'))).not.toBeNull()
    fireEvent.click(group.getByRole('checkbox', { name: 'Alpha' }))
    fireEvent.click(group.getByRole('button', { name: zh.save }))
    await waitFor(() => expect(host.mutate).toHaveBeenCalledWith(
      HUMAN_PROFILE_SETTINGS_NAMESPACE,
      [{ op: 'set', path: ['extraToolGrants'], value: [] }],
      1,
    ))
  })

  it('honours read-only settings and exposes keyboard-operable controls', async () => {
    const host = grantHost({ names: ['Alpha'], catalog: ['Alpha', 'Beta'], writable: false })
    renderSection(host)
    const group = await grantsGroup()
    expect(await group.findByText(zh.readOnly)).not.toBeNull()
    expect((group.getByRole('checkbox', { name: 'Alpha' }) as HTMLInputElement).disabled).toBe(true)
    expect((group.getByRole('button', { name: zh.save }) as HTMLButtonElement).disabled).toBe(true)
    const search = group.getByLabelText(zh.extraToolsSearch)
    search.focus()
    expect(document.activeElement).toBe(search)
  })
})
