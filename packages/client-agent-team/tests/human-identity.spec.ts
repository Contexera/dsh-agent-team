import { describe, expect, it, vi } from 'vitest'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamHumanProfileResult } from '@contexera/dsh-agent-team/types'
import { TeamHumanIdentity, TeamHumanProfileWriter } from '../src/client/human-identity.ts'

/** A read failure in the shape the carrier produces (code/details belong to it, not to the test). */
const readFailure = (message: string): RemoteResult<AgentTeamHumanProfileResult> =>
  ({ ok: false, error: { message } }) as RemoteResult<AgentTeamHumanProfileResult>

const PROFILE = {
  name: 'Ada',
  version: '0.1.13',
  repoUrl: 'https://github.com/Contexera/dsh-agent-team',
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

  it('keeps the accepted profile when the avatar loader throws, then retries that reference', async () => {
    let fail = true
    const { identity, loadAvatarUrl } = storeWith({
      profile: async () => ({ ok: true as const, value: { ...PROFILE, avatarRef: 'avatar:1' } }),
      avatar: async () => {
        if (fail) throw new Error('avatar transport down')
        return 'data:image/png;base64,AAAA'
      },
    })
    await identity.refresh()
    expect(identity.getSnapshot()).toMatchObject({ status: 'ready', name: 'Ada', avatarRef: 'avatar:1' })
    expect(identity.getSnapshot().avatarUrl).toBeUndefined()
    fail = false
    await identity.refresh()
    expect(loadAvatarUrl).toHaveBeenCalledTimes(2)
    expect(identity.getSnapshot().avatarUrl).toBe('data:image/png;base64,AAAA')
  })

  it('does not keep the old picture when a new avatar reference fails during refresh', async () => {
    let profile = { ...PROFILE, avatarRef: 'avatar:old' }
    const { identity, loadAvatarUrl } = storeWith({
      profile: async () => ({ ok: true as const, value: profile }),
      avatar: async () => 'data:image/png;base64,AAAA',
    })
    await identity.refresh()
    expect(identity.getSnapshot().avatarUrl).toBeDefined()
    profile = { ...profile, name: 'Grace', avatarRef: 'avatar:new' }
    loadAvatarUrl.mockRejectedValueOnce(new Error('new image unavailable'))
    await identity.refresh()
    expect(identity.getSnapshot()).toMatchObject({ status: 'ready', name: 'Grace', avatarRef: 'avatar:new' })
    expect(identity.getSnapshot().avatarUrl).toBeUndefined()
    await identity.refresh()
    expect(loadAvatarUrl.mock.calls.map(([ref]) => ref)).toEqual(['avatar:old', 'avatar:new', 'avatar:new'])
    expect(identity.getSnapshot().avatarUrl).toBeDefined()
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

describe('Human profile writes', () => {
  const writeFailure = (code: string, message: string): RemoteResult<never> =>
    ({ ok: false, error: { code, message } }) as RemoteResult<never>

  function writerWith(
    identity: TeamHumanIdentity,
    setHumanName: () => Promise<RemoteResult<never>> = async () => ({ ok: true, value: {} }) as never,
  ) {
    return new TeamHumanProfileWriter(identity, {
      setHumanName,
      replaceAvatar: async () => ({ ok: true, value: {} }) as never,
      removeAvatar: async () => ({ ok: true, value: {} }) as never,
    })
  }

  it.each(['gateway/internal', 'gateway/cancelled'])('treats %s as uncertain and re-reads', async (code) => {
    const { identity, loadProfile } = storeWith()
    await identity.refresh()
    const writer = writerWith(identity, async () => writeFailure(code, 'transport failed'))
    await expect(writer.setName('Grace', 'fixture-host:0')).resolves.toEqual({ kind: 'uncertain', message: 'transport failed' })
    expect(loadProfile).toHaveBeenCalledTimes(2)
  })

  it('treats a settings conflict as a re-read outcome', async () => {
    const { identity } = storeWith()
    await identity.refresh()
    const writer = writerWith(identity, async () => writeFailure('settings/conflict', 'changed elsewhere'))
    await expect(writer.setName('Grace', 'fixture-host:0')).resolves.toEqual({ kind: 'conflict', message: 'changed elsewhere' })
  })

  it('reports a committed write as saved when the following profile read fails', async () => {
    const { identity, loadProfile } = storeWith()
    await identity.refresh()
    loadProfile.mockImplementation(async () => readFailure('refresh offline'))
    const writer = writerWith(identity)
    await expect(writer.setName('Grace', 'fixture-host:0')).resolves.toEqual({ kind: 'saved', warning: 'refresh offline' })
  })

  it('cannot coalesce the post-commit read with a read that began before the write', async () => {
    let releaseOld!: (value: RemoteResult<AgentTeamHumanProfileResult>) => void
    const oldRead = new Promise<RemoteResult<AgentTeamHumanProfileResult>>(resolve => { releaseOld = resolve })
    const loadProfile = vi.fn()
      .mockImplementationOnce(() => oldRead)
      .mockImplementationOnce(async () => ({ ok: true as const, value: { ...PROFILE, name: 'Grace', settingsFence: 'fixture-host:1' } }))
    const identity = new TeamHumanIdentity({ loadProfile, loadAvatarUrl: async () => null })
    const reading = identity.refresh()
    const writer = writerWith(identity)
    const writing = writer.setName('Grace', 'fixture-host:0')
    await writing
    expect(loadProfile).toHaveBeenCalledTimes(2)
    expect(identity.getSnapshot()).toMatchObject({ name: 'Grace', settingsFence: 'fixture-host:1' })
    releaseOld({ ok: true, value: { ...PROFILE, settingsFence: 'fixture-host:0' } })
    await reading
    expect(identity.getSnapshot()).toMatchObject({ name: 'Grace', settingsFence: 'fixture-host:1' })
  })
})
