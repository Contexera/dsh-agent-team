/**
 * Independent regression gate for the pre-rename Host row upgrade.
 *
 * Three counter-examples an upgrade must never show, each as one end-to-end
 * boot over a profile that still carries the `wowyuarm` row, plus two controls
 * that must stay green on both sides of the fix — a control turning red means
 * the fixture broke, not the migration.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig, type Fiber } from '@deepseek-ai/cordis'
import { updateVolatile, volatileEntries, type Volatile } from '@deepseek-ai/cosmokit'
import { harness } from './helpers/host-harness.ts'
import { HUMAN_PROFILE_SETTINGS_NAMESPACE } from '../src/human-settings.ts'
import { humanAvatarsRoot, writeHumanAvatar } from '../src/human-avatar.ts'
import { DEFAULT_MEMBER_COMPACTION } from '../src/member-compaction.ts'
import { DEFAULT_WAKE_RECYCLE } from '../src/wake-recycle.ts'

const tempRoots: string[] = []
const previousHome = process.env.DSH_HOME

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

/** Throwaway DSH home with the environment pointed at it for this test. */
async function tempDshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agent-team-upgrade-'))
  tempRoots.push(home)
  process.env.DSH_HOME = home
  return home
}

interface SettingsOp { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
interface Mutation { readonly namespace: string; readonly ops: unknown }

interface BootOptions {
  readonly patchPath?: string
  /** The current namespace's user layer: the fields the Human stored themselves. */
  readonly user?: Record<string, unknown>
  /** Also commit each write into the live config, the way the loader applies a volatile settings edit. */
  readonly apply?: boolean
}

/**
 * Boot a real Host over the throwaway home and capture every settings write.
 *
 * The recording stub is the migration's own surface: its obligation ends at
 * emitting the write, and the settings service is what makes a volatile write
 * live. With `apply` the stub additionally commits the write into the running
 * volatile references the way the loader does for a settings edit (see
 * `_commitVolatile` in the loader's config entry), so the value a restarted
 * Host would resolve can be asserted in the same boot.
 */
async function bootHost(options: BootOptions = {}) {
  const mutations: Mutation[] = []
  const stored: Record<string, unknown> = {}
  let fiber: Fiber | undefined
  const { ctx, fiber: bootedFiber } = await harness({
    workspaceIds: [],
    config: options.user === undefined ? undefined : options.user as never,
    prepare: c => {
      c.provide('settings', {
        configure: () => () => {},
        describe: () => options.patchPath === undefined
          ? []
          : [{ ns: HUMAN_PROFILE_SETTINGS_NAMESPACE, user: options.user ?? {} }],
        mutate: async (namespace: string, ops: unknown) => {
          mutations.push({ namespace, ops })
          for (const op of ops as readonly SettingsOp[]) {
            if (op.op !== 'set') continue
            let target = stored
            for (const key of op.path.slice(0, -1)) {
              const next = target[key]
              target = (next !== undefined && typeof next === 'object' ? next : target[key] = {}) as Record<string, unknown>
            }
            const field = op.path.at(-1)
            if (field === undefined) continue
            target[field] = op.value
          }
          if (options.apply !== true || fiber === undefined) return
          const candidate = resolveConfig(fiber.runtime!, structuredClone(stored))
          const changed: string[][] = []
          for (const { path, ref } of volatileEntries(c.agentTeam.config)) {
            const source = path.reduce<unknown>((value, key) => Reflect.get(value as object, key), candidate)
            if (source === undefined) continue
            updateVolatile(ref, source as Volatile<unknown>)
            changed.push(path)
          }
          if (changed.length === 0) return
          try {
            fiber.ctx.emit('loader/volatile-update', changed)
          } catch {
            // A listener failure must not fail the write; every value is committed.
          }
        },
      } as never)
      if (options.patchPath !== undefined) {
        c.provide('profileContext', { home: process.env.DSH_HOME, dir: process.env.DSH_HOME, patchPath: options.patchPath })
      }
    },
  })
  fiber = bootedFiber
  const dispose = async () => { await fiber!.dispose() }
  return { mutations, host: ctx.agentTeam, dispose }
}

/** A profile patch document that still carries the pre-rename Host row. */
function preRenameRow(...config: readonly string[]): string {
  return [
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
}

const operationalRow = preRenameRow(
  'memberCompaction: { enabled: false, tokens: 12345 }',
  'wakeRecycle: { enabled: false, idleMs: 123, minContextTokens: 456 }',
)
const carriedCompaction = { enabled: false, tokens: 12345 }
const carriedWakeRecycle = { enabled: false, idleMs: 123, minContextTokens: 456 }

describe('operational Host settings survive the identity rename', () => {
  it('emits the stored thresholds into the current namespace', async () => {
    const home = await tempDshHome()
    const patchPath = join(home, 'cordis.patch.yml')
    await writeFile(patchPath, operationalRow)
    const { mutations } = await bootHost({ patchPath })
    await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
    const [migration] = mutations
    if (migration === undefined) throw new Error('the migration emitted no settings write')
    expect(migration.namespace).toBe(HUMAN_PROFILE_SETTINGS_NAMESPACE)
    const ops = migration.ops as readonly SettingsOp[]
    expect(ops).toContainEqual({ op: 'set', path: ['memberCompaction'], value: carriedCompaction })
    expect(ops).toContainEqual({ op: 'set', path: ['wakeRecycle'], value: carriedWakeRecycle })
  })

  it('leaves the thresholds in effect instead of resetting them to defaults', async () => {
    // A rename that silently resets these is a behaviour change, not a
    // cosmetic one: an operator who switched Member compaction off would get
    // it back on without touching anything.
    const home = await tempDshHome()
    const patchPath = join(home, 'cordis.patch.yml')
    await writeFile(patchPath, operationalRow)
    const { host } = await bootHost({ patchPath, apply: true })
    await vi.waitFor(() => {
      expect(host.config.memberCompaction.get()).toEqual(carriedCompaction)
    })
    expect(host.config.wakeRecycle.get()).toEqual(carriedWakeRecycle)
    expect(host.config.memberCompaction.get()).not.toEqual(DEFAULT_MEMBER_COMPACTION)
    expect(host.config.wakeRecycle.get()).not.toEqual(DEFAULT_WAKE_RECYCLE)
  })
})

describe('the post-upgrade user layer outranks both legacy sources', () => {
  const bothLegacySources = [
    '- id: contexera-agent-team-host',
    "  name: '@contexera/dsh-agent-team/host'",
    '  config: { name: human }',
    '- id: wowyuarm-agent-team-host',
    "  name: '@wowyuarm/dsh-agent-team/host'",
    '  config:',
    '    name: YuCreate',
    '',
  ].join('\n')
  const retiredSection = 'agent-team-human:\n  name: EarlierLegacyName\n'

  it('keeps a display name the Human stored as the shipped default', async () => {
    // `human` is the Human's own choice here, not an absence: the resolved
    // config cannot tell the two apart, so only the user layer can.
    const home = await tempDshHome()
    const patchPath = join(home, 'cordis.patch.yml')
    await writeFile(patchPath, bothLegacySources)
    await writeFile(join(home, 'settings.yaml.imported'), retiredSection)
    const { mutations } = await bootHost({ patchPath, user: { name: 'human' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mutations).toEqual([])
  })

  it('control: keeps an explicitly stored non-default name over both legacy sources', async () => {
    const home = await tempDshHome()
    const patchPath = join(home, 'cordis.patch.yml')
    await writeFile(patchPath, bothLegacySources)
    await writeFile(join(home, 'settings.yaml.imported'), retiredSection)
    const { mutations } = await bootHost({ patchPath, user: { name: 'CurrentName' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mutations).toEqual([])
  })

  it('keeps an explicit avatar removal across legacy migration without taking the image from another profile', async () => {
    const home = await tempDshHome()
    const avatar = await writeHumanAvatar(humanAvatarsRoot(), 'old.png', 'image/png', Buffer.from([1]))
    const patchPath = join(home, 'cordis.patch.yml')
    await writeFile(patchPath, preRenameRow('name: LegacyName', `avatarRef: ${avatar.avatarRef}`))
    await writeFile(join(home, 'settings.yaml.imported'), `agent-team-human:\n  avatarRef: ${avatar.avatarRef}\n`)

    const removed = await bootHost({ patchPath, user: { avatarRef: null } })
    await vi.waitFor(() => { expect(removed.mutations).toHaveLength(1) })
    expect(removed.mutations[0]?.ops).toEqual([{ op: 'set', path: ['name'], value: 'LegacyName' }])
    expect(removed.host.humanProfile().avatarRef).toBeUndefined()
    await removed.dispose()

    const other = await bootHost({ user: { avatarRef: avatar.avatarRef } })
    expect(other.host.humanProfile().avatarRef).toBe(avatar.avatarRef)
    await expect(other.host.getHumanAvatar({ avatarRef: avatar.avatarRef })).resolves.toMatchObject({ name: 'old.png' })
  })
})

describe('an unevaluated expression never lands as a literal', () => {
  it('migrates the fields beside the expression but not the expression itself', async () => {
    // The `!!js` scalar parses without an error: its value is the expression's
    // SOURCE, so adopting it would leave the Human literally named
    // 'process.env.HUMAN_NAME'. One expression must not condemn its neighbors.
    const home = await tempDshHome()
    const patchPath = join(home, 'cordis.patch.yml')
    await writeFile(patchPath, preRenameRow(
      'name: !!js process.env.HUMAN_NAME',
      'memberCompaction: { enabled: false, tokens: 12345 }',
    ))
    const { mutations } = await bootHost({ patchPath })
    await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
    const [migration] = mutations
    if (migration === undefined) throw new Error('the migration emitted no settings write')
    const ops = migration.ops as readonly SettingsOp[]
    expect(ops.some(op => op.path[0] === 'name')).toBe(false)
    expect(ops).toContainEqual({ op: 'set', path: ['memberCompaction'], value: carriedCompaction })
  })
})

describe('control: an ordinary pre-rename row still migrates', () => {
  it('carries the display name and a live avatar reference', async () => {
    const home = await tempDshHome()
    const avatar = await writeHumanAvatar(humanAvatarsRoot(), 'logo.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff]))
    const patchPath = join(home, 'cordis.patch.yml')
    await writeFile(patchPath, preRenameRow('name: YuCreate', `avatarRef: ${avatar.avatarRef}`))
    const { mutations } = await bootHost({ patchPath })
    await vi.waitFor(() => { expect(mutations).toHaveLength(1) })
    const [migration] = mutations
    if (migration === undefined) throw new Error('the migration emitted no settings write')
    const ops = migration.ops as readonly SettingsOp[]
    expect(ops).toContainEqual({ op: 'set', path: ['name'], value: 'YuCreate' })
    expect(ops).toContainEqual({ op: 'set', path: ['avatarRef'], value: avatar.avatarRef })
  })
})
