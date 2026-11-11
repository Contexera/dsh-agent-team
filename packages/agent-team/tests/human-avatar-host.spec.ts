import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import AgentTeam from '../src/index.ts'
import * as avatarStore from '../src/human-avatar.ts'
import { humanAvatarsRoot, readHumanAvatar, writeHumanAvatar } from '../src/human-avatar.ts'
import { HUMAN_PROFILE_SETTINGS_NAMESPACE } from '../src/human-settings.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { provideQuietTokenMeter } from './helpers/team-host-fixture.ts'

const cleanups: Array<() => Promise<void>> = []
const tempRoots: string[] = []
const previousHome = process.env.DSH_HOME

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

type SettingsFailure = 'conflict' | 'error' | 'after-commit'

async function bootHost(home: string, stored: Record<string, unknown> = {}) {
  process.env.DSH_HOME = home
  let revision = 0
  let failureMode: SettingsFailure | undefined
  const mutations: Array<{ readonly expected: number; readonly ops: readonly unknown[] }> = []
  let host: AgentTeam | undefined
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  ctx.provide('workspaceRegistry', { get: () => undefined, list: () => [], archiveSession: async () => {} })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  provideQuietTokenMeter(ctx)
  ctx.provide('settings', {
    configure: () => () => {},
    describe: () => [{ ns: HUMAN_PROFILE_SETTINGS_NAMESPACE, revision, user: { ...stored } }],
    mutate: async (_namespace: string, ops: ReadonlyArray<{ op: 'set' | 'unset'; path: readonly string[]; value?: unknown }>, expected: number) => {
      mutations.push({ expected, ops })
      if (failureMode === 'conflict') {
        throw { code: 'SETTINGS_CONFLICT', message: 'settings changed', expected, actual: expected + 1 }
      }
      if (failureMode === 'error') throw new Error('settings storage failed')
      if (expected !== revision) throw { code: 'SETTINGS_CONFLICT', message: 'settings changed', expected, actual: revision }
      for (const op of ops) {
        if (op.op !== 'set' || op.path.length !== 1 || host === undefined) continue
        if (op.path[0] === 'avatarRef') updateVolatile(host.config.avatarRef, createVolatile(op.value))
        stored[op.path[0]!] = op.value
      }
      revision += 1
      if (failureMode === 'after-commit') throw new Error('response path failed')
    },
  } as never)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam, stored as never)
  host = ctx.agentTeam
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await fiber.dispose()
  }
  cleanups.push(close)
  return {
    host,
    close,
    mutations,
    setFailure: (next?: SettingsFailure) => { failureMode = next },
    revision: () => revision,
  }
}

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agent-team-avatar-host-'))
  tempRoots.push(home)
  process.env.DSH_HOME = home
  return home
}

async function avatarEntries(): Promise<string[]> {
  return readdir(humanAvatarsRoot()).catch(() => [])
}

describe('Human avatar Host operations', () => {
  it('rejects invalid references through the read Remote while accepting released UUID ids', async () => {
    await tempHome()
    const { host } = await bootHost(process.env.DSH_HOME!)
    await expect(host.getHumanAvatar({ avatarRef: '../outside' })).rejects.toThrow('invalid human avatar reference')
    const written = await writeHumanAvatar(humanAvatarsRoot(), 'old.png', 'image/png', Buffer.from([1]))
    await expect(host.getHumanAvatar({ avatarRef: written.avatarRef })).resolves.toMatchObject({ name: 'old.png', mediaType: 'image/png' })
  })

  it.runIf(process.platform !== 'win32')('rejects a valid UUID whose directory points outside the avatar store', async () => {
    const home = await tempHome()
    const { host } = await bootHost(home)
    const original = await writeHumanAvatar(humanAvatarsRoot(), 'inside.png', 'image/png', Buffer.from([1]))
    const outside = await writeHumanAvatar(join(home, 'outside'), 'outside.png', 'image/png', Buffer.from([2]))
    await symlink(join(home, 'outside', outside.avatarRef), join(humanAvatarsRoot(), outside.avatarRef), 'dir')
    await expect(host.getHumanAvatar({ avatarRef: outside.avatarRef })).rejects.toThrow('outside the avatar store')
    await expect(host.getHumanAvatar({ avatarRef: original.avatarRef })).resolves.toMatchObject({ name: 'inside.png' })
  })

  it('prepares bytes and commits the reference with the Harness revision', async () => {
    await tempHome()
    const { host, mutations } = await bootHost(process.env.DSH_HOME!)
    const fence = host.humanProfileForClient({}).settingsFence!
    const result = await host.putHumanAvatar({ name: 'new.png', mediaType: 'image/png', bytesBase64: 'AQ==', expectedFence: fence })
    expect(result.avatarRef).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.settingsFence).not.toBe(fence)
    expect(mutations[0]?.expected).toBe(0)
    expect(await readHumanAvatar(humanAvatarsRoot(), result.avatarRef!)).toMatchObject({ name: 'new.png', byteSize: 1 })
  })

  it('removes only this request file after a CAS conflict', async () => {
    await tempHome()
    const { host, setFailure } = await bootHost(process.env.DSH_HOME!)
    const fence = host.humanProfileForClient({}).settingsFence!
    setFailure('conflict')
    await expect(host.putHumanAvatar({ name: 'new.png', mediaType: 'image/png', bytesBase64: 'AQ==', expectedFence: fence }))
      .rejects.toMatchObject({ code: 'settings/conflict' })
    expect(await avatarEntries()).toEqual([])
  })

  it('keeps the settings refusal and old avatar when cleanup of the new file fails', async () => {
    await tempHome()
    const { host, setFailure } = await bootHost(process.env.DSH_HOME!)
    const old = await host.putHumanAvatar({ name: 'old.png', mediaType: 'image/png', bytesBase64: 'AQ==',
      expectedFence: host.humanProfileForClient({}).settingsFence! })
    setFailure('conflict')
    vi.spyOn(avatarStore, 'removeHumanAvatar').mockRejectedValueOnce(new Error('store is read-only'))

    await expect(host.putHumanAvatar({ name: 'new.png', mediaType: 'image/png', bytesBase64: 'Ag==', expectedFence: old.settingsFence! }))
      .rejects.toMatchObject({ code: 'settings/conflict' })
    expect(host.humanProfile().avatarRef).toBe(old.avatarRef)
    await expect(host.getHumanAvatar({ avatarRef: old.avatarRef! })).resolves.toMatchObject({ name: 'old.png', bytesBase64: 'AQ==' })
    expect(await avatarEntries()).toHaveLength(2)
  })

  it('retains the new file when the settings write outcome is uncertain', async () => {
    await tempHome()
    const { host, setFailure } = await bootHost(process.env.DSH_HOME!)
    const fence = host.humanProfileForClient({}).settingsFence!
    setFailure('error')
    await expect(host.putHumanAvatar({ name: 'new.png', mediaType: 'image/png', bytesBase64: 'AQ==', expectedFence: fence }))
      .rejects.toMatchObject({ code: 'team/human-profile-write-uncertain' })
    expect(await avatarEntries()).toHaveLength(1)
  })

  it('retains and exposes the new reference when settings committed before the response failed', async () => {
    await tempHome()
    const { host, setFailure } = await bootHost(process.env.DSH_HOME!)
    const fence = host.humanProfileForClient({}).settingsFence!
    setFailure('after-commit')
    await expect(host.putHumanAvatar({ name: 'new.png', mediaType: 'image/png', bytesBase64: 'AQ==', expectedFence: fence }))
      .rejects.toMatchObject({ code: 'team/human-profile-write-uncertain' })
    expect(host.humanProfile().avatarRef).toBeDefined()
    expect(await avatarEntries()).toHaveLength(1)
  })

  it('rejects a fence from an earlier Host instance before writing a new file', async () => {
    const home = await tempHome()
    const first = await bootHost(home)
    const oldFence = first.host.humanProfileForClient({}).settingsFence!
    const second = await bootHost(home)
    await expect(second.host.putHumanAvatar({ name: 'new.png', mediaType: 'image/png', bytesBase64: 'AQ==', expectedFence: oldFence }))
      .rejects.toMatchObject({ code: 'settings/conflict' })
    expect(await avatarEntries()).toEqual([])
  })

  it('writes the explicit no-avatar sentinel and retains the old immutable file', async () => {
    await tempHome()
    const { host, mutations } = await bootHost(process.env.DSH_HOME!)
    const old = await writeHumanAvatar(humanAvatarsRoot(), 'old.png', 'image/png', Buffer.from([1]))
    updateVolatile(host.config.avatarRef, createVolatile(old.avatarRef))
    const fence = host.humanProfileForClient({}).settingsFence!
    const removed = await host.removeHumanAvatar({ expectedFence: fence })
    expect(removed.avatarRef).toBeUndefined()
    expect(host.config.avatarRef.get()).toBeNull()
    expect(mutations.at(-1)?.ops).toContainEqual({ op: 'set', path: ['avatarRef'], value: null })
    expect(await readHumanAvatar(humanAvatarsRoot(), old.avatarRef)).toBeDefined()
  })

  it('leaves the avatar usable when the remove settings write fails', async () => {
    await tempHome()
    const { host, setFailure } = await bootHost(process.env.DSH_HOME!)
    const old = await host.putHumanAvatar({ name: 'old.png', mediaType: 'image/png', bytesBase64: 'AQ==',
      expectedFence: host.humanProfileForClient({}).settingsFence! })
    setFailure('error')

    await expect(host.removeHumanAvatar({ expectedFence: old.settingsFence! }))
      .rejects.toMatchObject({ code: 'team/human-profile-write-uncertain' })
    expect(host.humanProfile().avatarRef).toBe(old.avatarRef)
    await expect(host.getHumanAvatar({ avatarRef: old.avatarRef! })).resolves.toMatchObject({ name: 'old.png', bytesBase64: 'AQ==' })
  })

  it('keeps another profile’s avatar readable when both profiles share the same home', async () => {
    const home = await tempHome()
    const firstProfile = {}
    const first = await bootHost(home, firstProfile)
    const shared = await first.host.putHumanAvatar({ name: 'shared.png', mediaType: 'image/png', bytesBase64: 'AQ==',
      expectedFence: first.host.humanProfileForClient({}).settingsFence! })
    await first.close()

    const secondProfile = { avatarRef: shared.avatarRef }
    const second = await bootHost(home, secondProfile)
    expect(second.host.humanProfile().avatarRef).toBe(shared.avatarRef)
    await second.host.removeHumanAvatar({ expectedFence: second.host.humanProfileForClient({}).settingsFence! })
    expect(second.host.humanProfile().avatarRef).toBeUndefined()
    await second.close()

    const reopened = await bootHost(home, firstProfile)
    expect(reopened.host.humanProfile().avatarRef).toBe(shared.avatarRef)
    await expect(reopened.host.getHumanAvatar({ avatarRef: shared.avatarRef! })).resolves.toMatchObject({ name: 'shared.png', bytesBase64: 'AQ==' })
  })

  it('refuses a stale second window instead of overwriting the first avatar', async () => {
    await tempHome()
    const { host } = await bootHost(process.env.DSH_HOME!)
    const staleFence = host.humanProfileForClient({}).settingsFence!
    const first = await host.putHumanAvatar({ name: 'first.png', mediaType: 'image/png', bytesBase64: 'AQ==', expectedFence: staleFence })
    await expect(host.removeHumanAvatar({ expectedFence: staleFence })).rejects.toMatchObject({ code: 'settings/conflict' })
    expect(host.humanProfile().avatarRef).toBe(first.avatarRef)
    expect(await readHumanAvatar(humanAvatarsRoot(), first.avatarRef!)).toBeDefined()
  })
})
