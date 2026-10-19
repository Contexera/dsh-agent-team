import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { AgentTeamLedger, AGENT_TEAM_HUMAN_HANDLE, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { assertValidHumanName, HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_VERSION, normalizeHumanName, parseLegacyHumanProfile, planLegacyAdoption } from '../src/human-profile.ts'
import { HUMAN_PROFILE_SETTINGS_NAMESPACE } from '../src/human-settings.ts'
import { humanAvatarsRoot, readHumanAvatar, removeHumanAvatar, writeHumanAvatar } from '../src/human-avatar.ts'
import type { AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const memberId = (value: string): AgentTeamMemberId => `member:${value}` as AgentTeamMemberId

const cleanups: Array<() => Promise<void>> = []
const tempRoots: string[] = []
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function openLedger(): Promise<AgentTeamLedger> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  return new AgentTeamLedger(domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

describe('human display name validation', () => {
  it('trims and rejects empty names like Member handles', () => {
    expect(normalizeHumanName('  Ada  ')).toBe('Ada')
    expect(assertValidHumanName('Ada')).toBe('Ada')
    expect(() => assertValidHumanName('   ')).toThrow('human name must not be empty')
    expect(HUMAN_PROFILE_DEFAULT_NAME).toBe(AGENT_TEAM_HUMAN_HANDLE)
  })
})

describe('ledger runtime human handle', () => {
  it('defaults to the historic literal and syncs from settings', async () => {
    const team = await openLedger()
    expect(team.humanDisplayHandle()).toBe('human')
    team.setHumanDisplayHandle('  Ada  ')
    expect(team.humanDisplayHandle()).toBe('Ada')
    team.setHumanDisplayHandle('   ')
    expect(team.humanDisplayHandle()).toBe('Ada')
    await team.initialize()
  })

  it('accepts human operations carrying either the old or the new handle', async () => {
    const team = await openLedger()
    await team.initialize()
    team.setHumanDisplayHandle('Ada')
    const renamedActor = Object.freeze({ ...agentTeamHumanActor(), handle: 'Ada' })
    const created = await team.createChannel({ requestId: requestId('human-rename-ok'), workspaceId: alpha, name: 'general', description: '', memberIds: [], actor: renamedActor })
    expect(created.committed).toBe(true)
  })

  it('reserves the human name against agent handles', async () => {
    const team = await openLedger()
    await team.initialize()
    team.setHumanDisplayHandle('Ada')
    await expect(team.addMember({
      requestId: requestId('agent-collides'), workspaceId: alpha, handle: 'ada', description: '', presetId: 'preset',
      channelRefs: [], member: {
        memberId: memberId('m1'), sessionId: 'session:m1' as never, workspaceId: alpha,
        handle: 'ada', description: '', presetId: 'preset', privateMemoryPath: '/tmp/m1', state: 'enabled',
      },
      actor: agentTeamHumanActor(),
    })).rejects.toThrow('collides with the human display name')
  })
})

describe('human avatar persistent store', () => {
  it('writes, reads, and removes one image entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'human-avatar-'))
    tempRoots.push(root)
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const written = await writeHumanAvatar(root, 'avatar.png', 'image/png', bytes)
    expect(written.avatarRef).toMatch(/^[0-9a-f-]{36}$/)
    const stored = await readHumanAvatar(root, written.avatarRef)
    expect(stored?.mediaType).toBe('image/png')
    expect(stored?.bytes.equals(bytes)).toBe(true)
    await removeHumanAvatar(root, written.avatarRef)
    expect(await readHumanAvatar(root, written.avatarRef)).toBeUndefined()
  })

  it('rejects non-images, empty bytes, and missing entries read as undefined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'human-avatar-'))
    tempRoots.push(root)
    await expect(writeHumanAvatar(root, 'a.txt', 'text/plain', Buffer.from('x'))).rejects.toThrow('must be an image')
    await expect(writeHumanAvatar(root, 'a.png', 'image/png', Buffer.alloc(0))).rejects.toThrow('must not be empty')
    expect(await readHumanAvatar(root, 'missing')).toBeUndefined()
  })
})

describe('bundle version footnote', () => {
  it('states the version of the package this Host runs from', async () => {
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { readonly version: string }
    // The Host resolves its manifest relative to its own module while this
    // oracle resolves it independently: a layout change that sends the Host at
    // another manifest (or at none) lands here as 'unknown' or a mismatch,
    // instead of a footnote that quietly names another release — which is how
    // the 0.1.14 bundle ended up reporting 0.1.13.
    expect(HUMAN_PROFILE_VERSION).not.toBe('unknown')
    expect(HUMAN_PROFILE_VERSION).toBe(manifest.version)
  })
})

describe('legacy human profile adoption', () => {
  const legacyDocument = [
    'ui-theme:',
    '  preference: light',
    'agent-team-human:',
    '  avatarRef: 8dbafa6d-06a8-4b4b-8a34-1b1f73c99aa0',
    '  name: YuCreate',
    '',
  ].join('\n')

  it('reads the section out of a legacy settings document', () => {
    expect(parseLegacyHumanProfile(legacyDocument)).toEqual({
      avatarRef: '8dbafa6d-06a8-4b4b-8a34-1b1f73c99aa0',
      name: 'YuCreate',
    })
  })

  it('treats an unparsable or section-less document as nothing to adopt', () => {
    expect(parseLegacyHumanProfile('}{')).toBeUndefined()
    expect(parseLegacyHumanProfile('ui-theme:\n  preference: light')).toBeUndefined()
    expect(parseLegacyHumanProfile('agent-team-human: not-an-object')).toBeUndefined()
  })

  it('drops an unusable name but keeps a usable avatar reference', () => {
    expect(parseLegacyHumanProfile('agent-team-human:\n  name: "   "\n  avatarRef: ref-1')).toEqual({ avatarRef: 'ref-1' })
  })

  it('returns undefined when no field survives validation', () => {
    expect(parseLegacyHumanProfile('agent-team-human:\n  name: "   "\n  avatarRef: ""')).toBeUndefined()
  })

  it('carries both fields into a pristine profile', () => {
    expect(planLegacyAdoption({ name: HUMAN_PROFILE_DEFAULT_NAME }, { name: 'YuCreate', avatarRef: 'ref-1' }))
      .toEqual({ name: 'YuCreate', avatarRef: 'ref-1' })
  })

  it('never writes over a profile the Human already filled', () => {
    expect(planLegacyAdoption({ name: 'Ada' }, { name: 'YuCreate', avatarRef: 'ref-1' })).toBeUndefined()
    expect(planLegacyAdoption({ name: HUMAN_PROFILE_DEFAULT_NAME, avatarRef: 'mine' }, { name: 'YuCreate' })).toBeUndefined()
  })

  it('skips a legacy name that is the default and reports nothing when nothing survives', () => {
    expect(planLegacyAdoption({ name: HUMAN_PROFILE_DEFAULT_NAME }, { name: 'human', avatarRef: 'ref-1' })).toEqual({ avatarRef: 'ref-1' })
    expect(planLegacyAdoption({ name: HUMAN_PROFILE_DEFAULT_NAME }, { name: 'human' })).toBeUndefined()
  })
})

describe('legacy human profile adoption on boot', () => {
  const legacyDocument = (avatarRef: string): string => [
    'ui-theme:',
    '  preference: light',
    'agent-team-human:',
    `  avatarRef: ${avatarRef}`,
    '  name: YuCreate',
    '',
  ].join('\n')

  /** Throwaway DSH home with the environment pointed at it for this test. */
  async function tempDshHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'agent-team-adoption-'))
    tempRoots.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    cleanups.push(async () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    })
    return home
  }

  /**
   * Boot a real Host over that home and record every profile write it makes.
   * The settings stub is the write surface: adoption has to reach it through
   * the same namespace and op shape the profile page's Remote uses.
   */
  async function bootHost(home: string, config?: { readonly name: string }): Promise<Array<{ readonly namespace: string; readonly ops: unknown }>> {
    const mutations: Array<{ readonly namespace: string; readonly ops: unknown }> = []
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
    ctx.provide('settings', {
      configure: () => () => {},
      mutate: async (namespace: string, ops: unknown) => { mutations.push({ namespace, ops }) },
    } as never)
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = config === undefined ? await ctx.plugin(AgentTeam) : await ctx.plugin(AgentTeam, config)
    cleanups.push(async () => { await fiber.dispose() })
    expect(home).toBe(process.env.DSH_HOME)
    return mutations
  }

  it('carries a legacy name and avatar into a pristine Host row', async () => {
    const home = await tempDshHome()
    const avatar = await writeHumanAvatar(humanAvatarsRoot(), 'logo.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))
    await writeFile(join(home, 'settings.yaml.imported'), legacyDocument(avatar.avatarRef))
    const mutations = await bootHost(home)
    await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]).toEqual({
      namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
      ops: [
        { op: 'set', path: ['name'], value: 'YuCreate' },
        { op: 'set', path: ['avatarRef'], value: avatar.avatarRef },
      ],
    })
  })

  it('carries the name alone when the referenced avatar bytes are gone', async () => {
    const home = await tempDshHome()
    await writeFile(join(home, 'settings.yaml.imported'), legacyDocument('8dbafa6d-06a8-4b4b-8a34-1b1f73c99aa0'))
    const mutations = await bootHost(home)
    await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
    expect(mutations[0]).toEqual({
      namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
      ops: [{ op: 'set', path: ['name'], value: 'YuCreate' }],
    })
  })

  it('leaves a profile the Human already filled alone', async () => {
    const home = await tempDshHome()
    await writeFile(join(home, 'settings.yaml.imported'), legacyDocument('ref-1'))
    const mutations = await bootHost(home, { name: 'Ada' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mutations).toEqual([])
  })
})
