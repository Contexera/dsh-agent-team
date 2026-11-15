import { vi } from 'vitest'
import { HUMAN_PROFILE_SETTINGS_NAMESPACE } from '@contexera/dsh-agent-team/human-settings'
import type {
  AgentTeamSubscriptionListEntry,
  AgentTeamSubscriptionLogEntry,
} from '@contexera/dsh-agent-team/types'

export interface HumanProfileSeed {
  readonly name?: string
  readonly avatarRef?: string
  readonly settingsFence?: string
  readonly version?: string
  readonly repoUrl?: string
  readonly latestVersion?: string
}

export interface EnvironmentSeed {
  readonly verdict?: 'ok' | 'out-of-range' | 'undetermined'
  readonly reason?: string
  readonly bundleVersion?: string
  readonly dshVersion?: string
  readonly certifiedDshVersion?: string
  readonly supportRange?: { readonly lower: string; readonly upper: string }
}

export function createSettingsAndSubscriptionsDouble(options?: {
  readonly humanProfile?: HumanProfileSeed
  readonly humanProfileFailure?: string
  readonly environment?: EnvironmentSeed
  readonly environmentFailure?: string
  readonly subscriptions?: readonly AgentTeamSubscriptionListEntry[]
  readonly subscriptionFailure?: string
  readonly subscriptionRuns?: Readonly<Record<string, readonly AgentTeamSubscriptionLogEntry[]>>
  readonly subscriptionDraftFailure?: string
}) {
  let subscriptionRows: readonly AgentTeamSubscriptionListEntry[] = options?.subscriptions ?? []
  let subscriptionFailure: string | undefined = options?.subscriptionFailure
  let subscriptionDraftFailure: string | undefined = options?.subscriptionDraftFailure
  const subscriptionRuns = new Map<string, readonly AgentTeamSubscriptionLogEntry[]>(Object.entries(options?.subscriptionRuns ?? {}))

  const loadSubscriptions = vi.fn(async () => subscriptionFailure === undefined
    ? { ok: true as const, value: { entries: subscriptionRows } }
    : { ok: false as const, error: { message: subscriptionFailure } })

  const loadSubscriptionLogs = vi.fn(async ({ subscriptionRef }: { subscriptionRef: string }) => {
    const row = subscriptionRows.find(entry => entry.subscription.subscriptionRef === subscriptionRef)
    if (row === undefined) return { ok: false as const, error: { message: 'unknown subscription' } }
    return { ok: true as const, value: { subscription: row.subscription, runs: subscriptionRuns.get(subscriptionRef) ?? [] } }
  })

  const testSubscriptionDraft = vi.fn(async () => subscriptionDraftFailure === undefined
    ? { ok: true as const, value: { kind: 'tested' as const, events: [], stdoutTail: '', stderrTail: '', scriptHash: 'a'.repeat(64), revision: 1 } }
    : { ok: false as const, error: { message: subscriptionDraftFailure } })

  const unwiredSubscriptionWrite = vi.fn(async () => ({ ok: false as const, error: { message: 'subscription write not seeded' } }))
  const seedSubscriptions = (rows: readonly AgentTeamSubscriptionListEntry[]): void => { subscriptionRows = rows }
  const failSubscriptions = (message?: string): void => { subscriptionFailure = message }
  const seedSubscriptionRuns = (runs: Readonly<Record<string, readonly AgentTeamSubscriptionLogEntry[]>>): void => {
    subscriptionRuns.clear()
    for (const [ref, entries] of Object.entries(runs)) subscriptionRuns.set(ref, entries)
  }
  const failSubscriptionDraft = (message?: string): void => { subscriptionDraftFailure = message }

  let humanProfileValue: { name: string; avatarRef?: string; settingsFence?: string; version: string; repoUrl: string; latestVersion?: string } = {
    name: 'human',
    settingsFence: 'fixture-host:0',
    version: '0.1.13',
    repoUrl: 'https://github.com/Contexera/dsh-agent-team',
    ...options?.humanProfile,
  }
  let humanProfileFailure: string | undefined = options?.humanProfileFailure
  let humanProfileWriteFailure: string | undefined

  const humanProfile = vi.fn(async () => humanProfileFailure === undefined
    ? { ok: true as const, value: { ...humanProfileValue } }
    : { ok: false as const, error: { message: humanProfileFailure } })

  const getHumanAvatar = vi.fn(async (_request: { avatarRef: string }) => ({
    ok: true as const,
    value: { name: 'avatar.png', mediaType: 'image/png', byteSize: 3, bytesBase64: 'AAAA' },
  }))

  const putHumanAvatar = vi.fn(async (request: { name: string; mediaType?: string; bytesBase64: string; expectedFence: string }) => {
    humanProfileValue = { ...humanProfileValue, avatarRef: 'avatar:1', settingsFence: `${request.expectedFence}:next` }
    return {
      ok: true as const,
      value: { name: humanProfileValue.name, avatarRef: 'avatar:1', settingsFence: humanProfileValue.settingsFence },
    }
  })

  const removeHumanAvatar = vi.fn(async (request: { expectedFence: string }) => {
    const { avatarRef: _avatarRef, ...rest } = humanProfileValue
    humanProfileValue = { ...rest, settingsFence: `${request.expectedFence}:next` }
    return { ok: true as const, value: { name: humanProfileValue.name, settingsFence: humanProfileValue.settingsFence } }
  })

  const setHumanProfile = vi.fn(async (request: { name: string; expectedFence: string }) => {
    if (humanProfileWriteFailure !== undefined) return { ok: false as const, error: { message: humanProfileWriteFailure } }
    humanProfileValue = { ...humanProfileValue, name: request.name, settingsFence: `${request.expectedFence}:next` }
    return { ok: true as const, value: { name: request.name, settingsFence: humanProfileValue.settingsFence } }
  })

  const seedHumanProfile = (next: Partial<typeof humanProfileValue>): void => {
    humanProfileValue = { ...humanProfileValue, ...next }
  }
  const failHumanProfile = (message?: string): void => { humanProfileFailure = message }
  const failHumanProfileWrite = (message?: string): void => { humanProfileWriteFailure = message }

  let environmentValue: EnvironmentSeed & { readonly verdict: 'ok' | 'out-of-range' | 'undetermined' } = {
    verdict: 'ok',
    bundleVersion: '0.1.15',
    dshVersion: '0.1.7-rc.1',
    certifiedDshVersion: '0.1.7-rc.1',
    supportRange: { lower: '0.1.7-rc.1', upper: '0.1.8' },
    ...options?.environment,
  }
  let environmentFailure: string | undefined = options?.environmentFailure
  const environment = vi.fn(async () => environmentFailure === undefined
    ? { ok: true as const, value: { ...environmentValue } }
    : { ok: false as const, error: { message: environmentFailure } })
  const seedEnvironment = (next: Partial<typeof environmentValue>): void => { environmentValue = { ...environmentValue, ...next } }
  const failEnvironment = (message?: string): void => { environmentFailure = message }

  let extraToolGrants: string[] = []
  let settingsRevision = 1
  const settingsView = () => ({
    autoGenerate: false,
    ns: HUMAN_PROFILE_SETTINGS_NAMESPACE,
    schema: {},
    value: { extraToolGrants: [...extraToolGrants] },
    user: { extraToolGrants: [...extraToolGrants] },
    applies: 'live' as const,
    secrets: [],
    revision: settingsRevision,
  })
  const settingsDescribe = vi.fn(async () => ({
    ok: true as const,
    value: { writable: true, hasDocument: true, namespaces: [settingsView()] },
  }))
  const settingsMutate = vi.fn(async (
    _namespace: string,
    ops: readonly { op: 'set' | 'unset'; path: string[]; value?: unknown }[],
    _expectedRevision?: number,
  ) => {
    for (const operation of ops) {
      if (operation.op === 'set' && operation.path.length === 1 && operation.path[0] === 'extraToolGrants') {
        extraToolGrants = [...operation.value as string[]]
      }
    }
    settingsRevision += 1
    return { ok: true as const, value: settingsView() }
  })
  const toolCatalog = vi.fn(async () => ({ ok: true as const, value: { names: [] as string[] } }))

  return {
    humanProfile,
    setHumanProfile,
    putHumanAvatar,
    getHumanAvatar,
    removeHumanAvatar,
    seedHumanProfile,
    failHumanProfile,
    failHumanProfileWrite,
    environment,
    seedEnvironment,
    failEnvironment,
    settingsDescribe,
    settingsMutate,
    toolCatalog,
    loadSubscriptions,
    loadSubscriptionLogs,
    testSubscriptionDraft,
    unwiredSubscriptionWrite,
    seedSubscriptions,
    failSubscriptions,
    seedSubscriptionRuns,
    failSubscriptionDraft,
  }
}
