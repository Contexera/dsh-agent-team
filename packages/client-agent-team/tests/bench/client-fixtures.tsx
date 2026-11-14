import { vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamClientMemberStatus,
  AgentTeamHumanProfileResult,
  AgentTeamMemberId,
} from '@contexera/dsh-agent-team/types'
import { TeamHumanIdentity } from '../../src/client/human-identity.ts'
import { zh } from '../../src/client/locales.ts'
import { TeamSettingsSection } from '../../src/client/TeamSettingsSection.tsx'

export function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => { values.clear() },
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

export function zhTranslator<T>(): T {
  return ((key: keyof typeof zh, params?: Record<string, string | number>) => {
    let value: string = zh[key]
    for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
    return value
  }) as T
}

export function composerMemberStatus(handle: string, memberId: string): AgentTeamClientMemberStatus {
  return {
    member: {
      memberId: memberId as AgentTeamMemberId,
      sessionId: 'session:one' as never,
      workspaceId: 'workspace:alpha' as never,
      handle,
      description: '',
      presetId: 'team-member',
      state: 'enabled',
    },
    availability: 'active',
    presence: 'available',
    capabilityState: 'applied',
    workspaceIds: ['workspace:alpha' as never],
  }
}

export function openMentionMenu(ui: ReturnType<typeof render>, text: string): void {
  const textarea = ui.container.querySelector('textarea') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, text)
  textarea.selectionStart = text.length
  textarea.selectionEnd = text.length
  fireEvent.change(textarea, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } })
}

const DEFAULT_PROFILE: AgentTeamHumanProfileResult = {
  name: 'Ada',
  version: '0.1.13',
  repoUrl: 'https://github.com/Contexera/dsh-agent-team',
}

const INERT_ENVIRONMENT = { status: 'loading' as const }
const INERT_ENVIRONMENT_SOURCE = {
  getSnapshot: () => INERT_ENVIRONMENT,
  subscribe: () => () => {},
}

export function renderTeamSettingsSection(extraProps: Record<string, unknown>) {
  const identity = new TeamHumanIdentity({
    loadProfile: async (): Promise<RemoteResult<AgentTeamHumanProfileResult>> => ({ ok: true, value: DEFAULT_PROFILE }),
    loadAvatarUrl: async () => null,
  })
  const props = {
    close: () => {},
    t: zhTranslator<Parameters<typeof TeamSettingsSection>[0]['t']>(),
    identity,
    environment: INERT_ENVIRONMENT_SOURCE,
    saveName: vi.fn(async () => undefined),
    uploadAvatar: vi.fn(async () => undefined),
    removeAvatar: vi.fn(async () => undefined),
    ...extraProps,
  } as unknown as Parameters<typeof TeamSettingsSection>[0]
  return render(<TeamSettingsSection {...props} />)
}
