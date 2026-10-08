import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamHumanProfileResult } from '@contexera/dsh-agent-team/types'
import { TeamHumanIdentity } from '../src/client/human-identity.ts'

/** A read failure in the shape the carrier produces (code/details belong to it, not to the test). */
const readFailure = (message: string): RemoteResult<AgentTeamHumanProfileResult> =>
  ({ ok: false, error: { message } }) as RemoteResult<AgentTeamHumanProfileResult>

const PROFILE = {
  name: 'Ada',
  version: '0.1.13',
  repoUrl: 'https://github.com/Contexera/dsh-agent-team',
  updateAvailable: false,
}

function storeWith(overrides: {
  profile?: () => Promise<RemoteResult<AgentTeamHumanProfileResult>>
  avatar?: (avatarRef: string) => Promise<string | null>
} = {}) {
  const loadProfile = vi.fn(overrides.profile ?? (async () => ({ ok: true as const, value: PROFILE })))
  const loadAvatarUrl = vi.fn(overrides.avatar ?? (async () => null))
  return { identity: new TeamHumanIdentity({ loadProfile, loadAvatarUrl }), loadProfile, loadAvatarUrl }
}

describe('Human identity projection', () => {
  it('reads once for every seat that subscribes, and keeps one snapshot reference', async () => {
    const { identity, loadProfile } = storeWith()
    const first = vi.fn()
    const second = vi.fn()
    const offFirst = identity.subscribe(first)
    const offSecond = identity.subscribe(second)
    const before = identity.getSnapshot()
    await identity.refresh()
    expect(loadProfile).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(identity.getSnapshot()).not.toBe(before)
    expect(identity.getSnapshot().name).toBe('Ada')
    offFirst()
    offSecond()
  })

  it('does not read before the first seat asks for the identity', () => {
    const { identity, loadProfile } = storeWith()
    expect(identity.getSnapshot().status).toBe('loading')
    expect(identity.getSnapshot().name).toBeUndefined()
    expect(loadProfile).not.toHaveBeenCalled()
  })

  it('fetches avatar bytes once per reference and drops them when the reference clears', async () => {
    let value: typeof PROFILE & { avatarRef?: string } = { ...PROFILE, avatarRef: 'avatar:1' }
    const { identity, loadAvatarUrl } = storeWith({ profile: async () => ({ ok: true as const, value }), avatar: async () => 'data:image/png;base64,AAAA' })
    await identity.refresh()
    await identity.refresh()
    expect(loadAvatarUrl).toHaveBeenCalledTimes(1)
    expect(identity.getSnapshot().avatarUrl).toBe('data:image/png;base64,AAAA')
    const { avatarRef: _avatarRef, ...cleared } = value
    value = cleared
    await identity.refresh()
    expect(identity.getSnapshot().avatarRef).toBeUndefined()
    expect(identity.getSnapshot().avatarUrl).toBeUndefined()
  })

  it('keeps the last accepted identity beside a later read failure', async () => {
    const { identity, loadProfile } = storeWith()
    await identity.refresh()
    loadProfile.mockImplementation(async () => readFailure('transport down'))
    await identity.refresh()
    const snapshot = identity.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.name).toBe('Ada')
    expect(snapshot.error).toBe('transport down')
  })

  it('reports an unavailable identity when the first read fails, and recovers on retry', async () => {
    const { identity, loadProfile } = storeWith({ profile: async () => readFailure('host offline') })
    await identity.refresh()
    expect(identity.getSnapshot().status).toBe('unavailable')
    expect(identity.getSnapshot().error).toBe('host offline')
    loadProfile.mockImplementation(async () => ({ ok: true as const, value: PROFILE }))
    await identity.refresh()
    expect(identity.getSnapshot().status).toBe('ready')
    expect(identity.getSnapshot().error).toBeUndefined()
  })

  it('turns a thrown carrier error into the same reported failure', async () => {
    const { identity } = storeWith({ profile: async () => { throw new Error('connection closed') } })
    await identity.refresh()
    expect(identity.getSnapshot().status).toBe('unavailable')
    expect(identity.getSnapshot().error).toBe('connection closed')
  })

  it('shares one round trip between concurrent refreshes', async () => {
    const { identity, loadProfile } = storeWith()
    await Promise.all([identity.refresh(), identity.refresh(), identity.refresh()])
    expect(loadProfile).toHaveBeenCalledTimes(1)
  })
})
