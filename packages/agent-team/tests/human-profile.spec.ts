import { mkdir, mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises'
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
import { provideQuietTokenMeter } from './helpers/team-host-fixture.ts'
import { assertValidHumanName, HUMAN_PROFILE_DEFAULT_NAME, HUMAN_PROFILE_VERSION, normalizeHumanName, parseLegacyHumanProfile, parseRowHumanProfile } from '../src/human-profile.ts'
import { TEAM_HOST_ROW_SETTINGS_SCHEMA, planHostRowWrite } from '../src/host-row-settings.ts'
import { DEFAULT_WAKE_RECYCLE } from '../src/wake-recycle.ts'
import { HUMAN_PROFILE_SETTINGS_NAMESPACE, LEGACY_HUMAN_PROFILE_SETTINGS_NAMESPACE } from '../src/human-settings.ts'
import { assertHumanAvatarRef, humanAvatarsRoot, readHumanAvatar, removeHumanAvatar, writeHumanAvatar } from '../src/human-avatar.ts'
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
    const created = await team.createProject({ requestId: requestId('human-rename-ok'), workspaceId: alpha, name: 'general', description: '', memberIds: [], actor: renamedActor })
    expect(created.committed).toBe(true)
  })

  it('reserves the human name against agent handles', async () => {
    const team = await openLedger()
    await team.initialize()
    team.setHumanDisplayHandle('Ada')
    await expect(team.addMember({
      requestId: requestId('agent-collides'), workspaceId: alpha, handle: 'ada', description: '', presetId: 'preset',
      projectRefs: [], member: {
        memberId: memberId('m1'), sessionId: 'session:m1' as never, workspaceId: alpha,
        handle: 'ada', description: '', presetId: 'preset', model: { provider: 'mock', model: 'mock' }, privateMemoryPath: '/tmp/m1', state: 'enabled',
      },
      actor: agentTeamHumanActor(),
     model: { provider: 'mock', model: 'mock' },})).rejects.toThrow('collides with the human display name')
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
    expect(await readHumanAvatar(root, '00000000-0000-4000-8000-000000000000')).toBeUndefined()
  })

  it('accepts released UUID ids and rejects traversal before touching the filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'human-avatar-'))
    tempRoots.push(root)
    const oldId = '8dbafa6d-06a8-4b4b-8a34-1b1f73c99aa0'
    expect(assertHumanAvatarRef(oldId)).toBe(oldId)
    await expect(readHumanAvatar(root, '../outside')).rejects.toThrow('invalid human avatar reference')
    await expect(removeHumanAvatar(root, '/tmp/outside')).rejects.toThrow('invalid human avatar reference')
  })

  it('reads exactly the payload named by metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'human-avatar-'))
    tempRoots.push(root)
    const avatarRef = '8dbafa6d-06a8-4b4b-8a34-1b1f73c99aa0'
    const dir = join(root, avatarRef)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'chosen.png'), Buffer.from([1]))
    await writeFile(join(dir, 'other.png'), Buffer.from([2]))
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ name: 'chosen.png', mediaType: 'image/png', uploadedAt: '2026-11-11T00:00:00.000Z' }))
    expect((await readHumanAvatar(root, avatarRef))?.bytes).toEqual(Buffer.from([1]))
  })

  it.runIf(process.platform !== 'win32')('rejects an avatar directory symlinked outside the store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'human-avatar-'))
    const outside = await mkdtemp(join(tmpdir(), 'human-avatar-outside-'))
    tempRoots.push(root, outside)
    const avatarRef = '8dbafa6d-06a8-4b4b-8a34-1b1f73c99aa0'
    await symlink(outside, join(root, avatarRef), 'dir')
    await expect(readHumanAvatar(root, avatarRef)).rejects.toThrow('outside the avatar store')
    await expect(removeHumanAvatar(root, avatarRef)).rejects.toThrow('outside the avatar store')
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

describe('retired human settings section', () => {
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

  it('preserves the explicit no-avatar sentinel', () => {
    expect(parseLegacyHumanProfile('agent-team-human:\n  avatarRef: null')).toEqual({ avatarRef: null })
  })
})

describe('pre-rename host row document', () => {
  // Spelled out rather than imported: the value under test is the id an
  // un-upgraded profile already wrote, so a fixture that follows the constant
  // would pass even after the constant stopped matching those documents.
  const legacyRowId = 'wowyuarm-agent-team-host'

  const patchDocument = (...config: readonly string[]): string => [
    '- id: contexera-agent-team-host',
    "  name: '@contexera/dsh-agent-team/host'",
    '  config:',
    '    name: Ada',
    `- id: ${legacyRowId}`,
    "  name: '@wowyuarm/dsh-agent-team/host'",
    '  config:',
    ...config.map(line => `    ${line}`),
    '',
  ].join('\n')

  it('reads the retired row by its own id, wherever it sits', () => {
    // The fixtures below spell the id out so they describe real profile
    // documents; this pin is what keeps the constant answering to them.
    expect(LEGACY_HUMAN_PROFILE_SETTINGS_NAMESPACE).toBe(legacyRowId)
    expect(HUMAN_PROFILE_SETTINGS_NAMESPACE).not.toBe(legacyRowId)
    expect(parseRowHumanProfile(patchDocument('name: YuCreate', 'avatarRef: ref-1'), legacyRowId))
      .toEqual({ name: 'YuCreate', avatarRef: 'ref-1' })
    // The current row answers too — the parse is id-driven, not position-driven.
    expect(parseRowHumanProfile(patchDocument('name: YuCreate'), 'contexera-agent-team-host')).toEqual({ name: 'Ada' })
  })

  it('keeps each field as the document holds it, including nested groups', () => {
    const document = patchDocument('name: YuCreate', 'wakeRecycle: { enabled: false, idleMs: 123 }')
    expect(parseRowHumanProfile(document, legacyRowId)).toEqual({ name: 'YuCreate', wakeRecycle: { enabled: false, idleMs: 123 } })
  })

  it('treats a missing, duplicated, or malformed row as nothing to migrate', () => {
    expect(parseRowHumanProfile(patchDocument('name: YuCreate'), 'wowyuarm-agent-team-invariant')).toBeUndefined()
    // Two rows for one id: the loader would apply them in order, and a recovery
    // must not guess which write won.
    expect(parseRowHumanProfile([
      '- id: wowyuarm-agent-team-host',
      '  config: { name: Ada }',
      '- id: wowyuarm-agent-team-host',
      '  config: { name: Bob }',
    ].join('\n'), legacyRowId)).toBeUndefined()
    expect(parseRowHumanProfile('- id: wowyuarm-agent-team-host\n  config: not-an-object', legacyRowId)).toBeUndefined()
    expect(parseRowHumanProfile('}{', legacyRowId)).toBeUndefined()
    expect(parseRowHumanProfile('{ id: wowyuarm-agent-team-host }', legacyRowId)).toBeUndefined()
  })

  it('reads an expression as nothing to migrate rather than as its source text', () => {
    // `!!js` parses without an error: the scalar is the expression's SOURCE, so
    // adopting it would leave the Human literally named 'process.env.HUMAN_NAME'.
    expect(parseRowHumanProfile(patchDocument('name: !!js process.env.HUMAN_NAME'), legacyRowId)).toBeUndefined()
    // A field that merely contains an expression cannot be carried either: the
    // loader would evaluate it in the row's own context, and a literal write
    // would replace a computed threshold with its own source.
    expect(parseRowHumanProfile(patchDocument('name: YuCreate', 'wakeRecycle: { enabled: false, idleMs: !!js 60_000 }'), legacyRowId))
      .toEqual({ name: 'YuCreate' })
    // One expression does not condemn the fields beside it.
    expect(parseRowHumanProfile(patchDocument('name: !!js process.env.HUMAN_NAME', 'avatarRef: ref-1'), legacyRowId))
      .toEqual({ avatarRef: 'ref-1' })
  })
})

describe('host row migration precedence', () => {
  const operational = { wakeRecycle: { enabled: false, idleMs: 123, minContextTokens: 456 }, memberCompaction: { enabled: false, tokens: 12345 } }

  it('fills an empty namespace from the carried values', () => {
    expect(planHostRowWrite({}, { name: 'YuCreate', avatarRef: 'ref-1', ...operational }))
      .toEqual({ name: 'YuCreate', avatarRef: 'ref-1', ...operational })
  })

  it('never overwrites a field the current namespace already stores', () => {
    expect(planHostRowWrite({ name: 'Ada' }, { name: 'YuCreate', avatarRef: 'ref-1' })).toEqual({ avatarRef: 'ref-1' })
    expect(planHostRowWrite({ wakeRecycle: { enabled: true } }, operational)).toEqual({ memberCompaction: operational.memberCompaction })
    expect(planHostRowWrite({ name: 'Ada', avatarRef: 'mine', ...operational }, { name: 'YuCreate', avatarRef: 'ref-1', ...operational }))
      .toBeUndefined()
  })

  it('counts a stored value equal to the default as the Human having set it', () => {
    // `human` here is the Human's own choice after the upgrade, not an absence,
    // so the retired name may not replace it.
    expect(planHostRowWrite({ name: HUMAN_PROFILE_DEFAULT_NAME }, { name: 'YuCreate' })).toBeUndefined()
  })

  it('treats the explicit no-avatar value as stored, so neither migration can revive an inherited avatar', () => {
    expect(TEAM_HOST_ROW_SETTINGS_SCHEMA({ avatarRef: null }).avatarRef.get()).toBeNull()
    expect(planHostRowWrite({}, { avatarRef: null })).toEqual({ avatarRef: null })
    expect(planHostRowWrite({ avatarRef: null }, { avatarRef: 'ref-1' })).toBeUndefined()
  })

  it('never re-writes the retired row\'s default name as if it were a fact', () => {
    expect(planHostRowWrite({}, { name: HUMAN_PROFILE_DEFAULT_NAME })).toBeUndefined()
    expect(planHostRowWrite({}, { name: HUMAN_PROFILE_DEFAULT_NAME, avatarRef: 'ref-1' })).toEqual({ avatarRef: 'ref-1' })
  })

  it('completes a group an older row stored only part of', () => {
    // Writing the partial object would leave the row resolving schema defaults
    // for the rest, mixing a carried setting with a stale default.
    expect(planHostRowWrite({}, { wakeRecycle: { enabled: false } })).toEqual({
      wakeRecycle: { enabled: false, idleMs: DEFAULT_WAKE_RECYCLE.idleMs, minContextTokens: DEFAULT_WAKE_RECYCLE.minContextTokens },
    })
  })

  it('drops a value its own schema rejects instead of writing it', () => {
    expect(planHostRowWrite({}, { name: '   ', avatarRef: '', memberCompaction: { tokens: -1 } })).toBeUndefined()
    expect(planHostRowWrite({}, { name: 42, wakeRecycle: 'not-a-group' })).toBeUndefined()
  })
})

describe('host row migration on boot', () => {
  const retiredSection = (name: string, avatarRef?: string): string => [
    'ui-theme:',
    '  preference: light',
    'agent-team-human:',
    ...(avatarRef === undefined ? [] : [`  avatarRef: ${avatarRef}`]),
    `  name: ${name}`,
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

  interface Mutation { readonly namespace: string; readonly ops: unknown }

  /**
   * Boot a real Host over that home and record every settings write it makes.
   *
   * The settings stub records rather than applies, which is the right surface
   * for this migration: a field of this row is volatile, so the settings
   * service is what makes a write live, and the migration's own obligation ends
   * at emitting the write. `profile.user` is the current namespace's user layer
   * — the only signal that says whether the Human stored a field themselves.
   */
  async function bootHost(
    home: string,
    profile?: { readonly patchPath: string; readonly user?: Record<string, unknown> },
  ): Promise<readonly Mutation[]> {
    const mutations: Mutation[] = []
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
      mutate: async (namespace: string, ops: unknown) => { mutations.push({ namespace, ops }) },
      describe: () => profile === undefined
        ? []
        : [{ ns: HUMAN_PROFILE_SETTINGS_NAMESPACE, user: profile.user ?? {} }],
    } as never)
    if (profile !== undefined) ctx.provide('profileContext', { home, dir: home, patchPath: profile.patchPath })
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(AgentTeam)
    cleanups.push(async () => { await fiber.dispose() })
    expect(home).toBe(process.env.DSH_HOME)
    return mutations
  }

  /** Write the profile patch document a pre-rename profile already holds. */
  async function tempProfile(home: string, document: string): Promise<{ readonly patchPath: string }> {
    const patchPath = join(home, 'cordis.patch.yml')
    await writeFile(patchPath, document)
    return { patchPath }
  }

  const legacyRow = (...config: readonly string[]): string => [
    '- id: contexera-agent-team-host',
    "  name: '@contexera/dsh-agent-team/host'",
    '  config:',
    '    name: Ada',
    '- id: wowyuarm-agent-team-host',
    "  name: '@wowyuarm/dsh-agent-team/host'",
    '  config:',
    ...config.map(line => `    ${line}`),
    '',
  ].join('\n')

  describe('retired settings section', () => {
    it('carries a legacy name and avatar into an unwritten Host row', async () => {
      const home = await tempDshHome()
      const avatar = await writeHumanAvatar(humanAvatarsRoot(), 'logo.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))
      await writeFile(join(home, 'settings.yaml.imported'), retiredSection('YuCreate', avatar.avatarRef))
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
      await writeFile(join(home, 'settings.yaml.imported'), retiredSection('YuCreate', '8dbafa6d-06a8-4b4b-8a34-1b1f73c99aa0'))
      const mutations = await bootHost(home)
      await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
      expect(mutations[0]).toEqual({
        namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
        ops: [{ op: 'set', path: ['name'], value: 'YuCreate' }],
      })
    })

    it('leaves a row the Human already wrote alone', async () => {
      const home = await tempDshHome()
      await writeFile(join(home, 'settings.yaml.imported'), retiredSection('YuCreate', 'ref-1'))
      const mutations = await bootHost(home, { patchPath: join(home, 'cordis.patch.yml'), user: { name: 'Ada' } })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mutations).toEqual([])
    })
  })

  describe('pre-rename host row', () => {
    it('moves the name and avatar reference into the current namespace', async () => {
      const home = await tempDshHome()
      const avatar = await writeHumanAvatar(humanAvatarsRoot(), 'logo.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))
      const profile = await tempProfile(home, legacyRow('name: YuCreate', `avatarRef: ${avatar.avatarRef}`))
      const mutations = await bootHost(home, profile)
      await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
      expect(mutations[0]).toEqual({
        namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
        ops: [
          { op: 'set', path: ['name'], value: 'YuCreate' },
          { op: 'set', path: ['avatarRef'], value: avatar.avatarRef },
        ],
      })
    })

    it('moves the operational settings the same row stored', async () => {
      // A rename that silently resets these is a behaviour change, not a
      // cosmetic one: an operator who switched Member compaction off would get
      // it back on without touching anything.
      const home = await tempDshHome()
      const profile = await tempProfile(home, legacyRow(
        'memberCompaction: { enabled: false, tokens: 12345 }',
        'wakeRecycle: { enabled: false, idleMs: 123, minContextTokens: 456 }',
      ))
      const mutations = await bootHost(home, profile)
      await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
      expect(mutations[0]).toEqual({
        namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
        ops: [
          { op: 'set', path: ['wakeRecycle'], value: { enabled: false, idleMs: 123, minContextTokens: 456 } },
          { op: 'set', path: ['memberCompaction'], value: { enabled: false, tokens: 12345 } },
        ],
      })
    })

    it('keeps a field the Human stored after upgrading and fills only the gaps', async () => {
      const home = await tempDshHome()
      const avatar = await writeHumanAvatar(humanAvatarsRoot(), 'logo.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))
      const profile = await tempProfile(home, legacyRow('name: YuCreate', `avatarRef: ${avatar.avatarRef}`, 'memberCompaction: { enabled: false, tokens: 12345 }'))
      const mutations = await bootHost(home, { ...profile, user: { name: 'Ada' } })
      await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
      // The Human's post-upgrade name wins; everything else is a gap.
      expect(mutations[0]).toEqual({
        namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
        ops: [
          { op: 'set', path: ['avatarRef'], value: avatar.avatarRef },
          { op: 'set', path: ['memberCompaction'], value: { enabled: false, tokens: 12345 } },
        ],
      })
    })

    it('writes nothing once the current namespace carries every field', async () => {
      const home = await tempDshHome()
      const avatar = await writeHumanAvatar(humanAvatarsRoot(), 'logo.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))
      const profile = await tempProfile(home, legacyRow('name: YuCreate', `avatarRef: ${avatar.avatarRef}`, 'memberCompaction: { enabled: false, tokens: 12345 }'))
      const mutations = await bootHost(home, {
        ...profile,
        user: { name: 'Ada', avatarRef: avatar.avatarRef, memberCompaction: { enabled: true, tokens: 1 } },
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mutations).toEqual([])
    })

    it('writes nothing when the profile has no pre-rename row', async () => {
      const home = await tempDshHome()
      const profile = await tempProfile(home, [
        '- id: contexera-agent-team-host',
        "  name: '@contexera/dsh-agent-team/host'",
        '  config:',
        '    name: Ada',
        '',
      ].join('\n'))
      const mutations = await bootHost(home, profile)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mutations).toEqual([])
    })

    it('carries the name alone when the pre-rename avatar bytes are gone', async () => {
      const home = await tempDshHome()
      const profile = await tempProfile(home, legacyRow('name: YuCreate', 'avatarRef: 8dbafa6d-06a8-4b4b-8a34-1b1f73c99aa0'))
      const mutations = await bootHost(home, profile)
      await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
      expect(mutations[0]).toEqual({
        namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
        ops: [{ op: 'set', path: ['name'], value: 'YuCreate' }],
      })
    })

    it('skips an invalid legacy avatar without blocking the other carried fields', async () => {
      const home = await tempDshHome()
      const profile = await tempProfile(home, legacyRow(
        'name: YuCreate',
        'avatarRef: ../../outside',
        'memberCompaction: { enabled: false, tokens: 12345 }',
      ))
      const mutations = await bootHost(home, profile)
      await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
      expect(mutations[0]).toEqual({
        namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
        ops: [
          { op: 'set', path: ['name'], value: 'YuCreate' },
          { op: 'set', path: ['memberCompaction'], value: { enabled: false, tokens: 12345 } },
        ],
      })
    })

    it('carries the explicit no-avatar sentinel without trying to read a file', async () => {
      const home = await tempDshHome()
      const profile = await tempProfile(home, legacyRow('name: YuCreate', 'avatarRef: null'))
      const mutations = await bootHost(home, profile)
      await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
      expect(mutations[0]).toEqual({
        namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
        ops: [
          { op: 'set', path: ['name'], value: 'YuCreate' },
          { op: 'set', path: ['avatarRef'], value: null },
        ],
      })
    })

    it('never writes an expression\'s source text as a setting', async () => {
      const home = await tempDshHome()
      const avatar = await writeHumanAvatar(humanAvatarsRoot(), 'logo.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))
      const profile = await tempProfile(home, legacyRow('name: !!js process.env.HUMAN_NAME', `avatarRef: ${avatar.avatarRef}`))
      const mutations = await bootHost(home, profile)
      await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
      // The name is left at its default rather than becoming
      // 'process.env.HUMAN_NAME'; the field beside it still migrates.
      expect(mutations[0]).toEqual({
        namespace: HUMAN_PROFILE_SETTINGS_NAMESPACE,
        ops: [{ op: 'set', path: ['avatarRef'], value: avatar.avatarRef }],
      })
    })

    it('keeps an explicitly stored default name over both legacy sources', async () => {
      // End-to-end precedence: the new namespace stores `human` on purpose, and
      // the OLDER retired section must not overwrite it either.
      const home = await tempDshHome()
      const profile = await tempProfile(home, legacyRow('name: FormerName'))
      await writeFile(join(home, 'settings.yaml.imported'), retiredSection('EarlierLegacyName'))
      const mutations = await bootHost(home, { ...profile, user: { name: HUMAN_PROFILE_DEFAULT_NAME } })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mutations).toEqual([])
    })

    it('keeps an explicitly stored non-default name over both legacy sources', async () => {
      const home = await tempDshHome()
      const profile = await tempProfile(home, legacyRow('name: FormerName'))
      await writeFile(join(home, 'settings.yaml.imported'), retiredSection('EarlierLegacyName'))
      const mutations = await bootHost(home, { ...profile, user: { name: 'CurrentName' } })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mutations).toEqual([])
    })
  })
})
