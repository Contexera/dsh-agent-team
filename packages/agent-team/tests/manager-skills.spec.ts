import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MANAGER_BUNDLED_SKILLS_DIRECTORY, ManagerSessionRuntime } from '../src/manager-session.ts'
import type { ManagerSessionPointer, ManagerSessionStoreLike } from '../src/manager-session-store.ts'
import { realHarness, requestId } from './helpers/member-harness.ts'
import { skillRegistryFor } from './helpers/team-host-fixture.ts'


class MemoryPointerStore implements ManagerSessionStoreLike {
  pointer: ManagerSessionPointer | undefined
  read(): ManagerSessionPointer | undefined { return this.pointer }
  ownedSessionIds(): readonly SessionId[] {
    return this.pointer === undefined ? [] : [...this.pointer.previousSessionIds ?? [], this.pointer.sessionId]
  }
  async writeIfExpected(expectedSessionId: SessionId | undefined, pointer: ManagerSessionPointer): Promise<boolean> {
    if (this.pointer?.sessionId !== expectedSessionId) return false
    this.pointer = Object.freeze({ ...pointer })
    return true
  }
}

const SKILL_MD = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`

interface ManagerFixture {
  readonly ctx: Context
  readonly agent: Agent
  readonly privateRoot: string
  readonly bundledRoot: string
}

/** One manager Session whose two skill roots are directories the test controls, so precedence and discovery are provable. */
async function managerFixture(options: { bundledRoot?: string } = {}): Promise<ManagerFixture> {
  const { ctx, root, workspaceId, checkout } = await realHarness()
  const bundledRoot = options.bundledRoot ?? join(root, 'bundled-manager-skills')
  const privateRoot = join(root, 'manager-private')
  if (options.bundledRoot === undefined) {
    await mkdir(join(bundledRoot, 'shared-name'), { recursive: true })
    await writeFile(join(bundledRoot, 'shared-name', 'SKILL.md'),
      SKILL_MD('shared-name', 'The shipped guide skill the manager routes by', 'Bundled body.'))
  }
  const runtime = new ManagerSessionRuntime({
    ctx,
    store: new MemoryPointerStore(),
    reader: { read: async sessionId => ({ ok: false, failure: { kind: 'missing', sessionId, detail: 'not stored' } }) },
    managerPrivateRoot: privateRoot,
    managerBundledSkillsRoot: bundledRoot,
    defaultAgentOptions: () => ({ provider: 'mock', model: 'mock' }),
    initializeDefaultWorkspace: async () => ({ workspaceId, path: checkout }),
  })
  onTestFinished(async () => { await runtime.dispose() })
  const opened = await runtime.open()
  if (opened.status !== 'ready') throw new Error(`expected a ready manager Session, got ${JSON.stringify(opened)}`)
  const agent = ctx.agents.get(opened.sessionId)
  if (agent === undefined) throw new Error('the manager Session has no live Agent')
  return { ctx, agent, privateRoot, bundledRoot }
}

async function catalogNames(ctx: Context, agent: Agent): Promise<readonly string[]> {
  const skills = await skillRegistryFor(ctx, agent).list({ scope: agent as never })
  return skills.map(skill => skill.name).sort()
}

describe('Team manager skill discovery', () => {
  it('resolves the shipped manager skills beside the built module, not the Member core skills', async () => {
    // The production default is what the Host passes; a wrong relative path
    // would leave the manager with no bundled catalog and no failing test.
    expect(MANAGER_BUNDLED_SKILLS_DIRECTORY.endsWith(`${sep}manager-skills`)).toBe(true)
    expect(MANAGER_BUNDLED_SKILLS_DIRECTORY).not.toContain(`${sep}core-skills`)
    expect(await readdir(MANAGER_BUNDLED_SKILLS_DIRECTORY)).toContain('README.md')
  })

  it('ships the two guide skills in the bundled root and discovers both', async () => {
    // The gate reads the same directories statically; this proves the manager's
    // own provider loads them from the root the Host passes, so a rename or a
    // dropped SKILL.md cannot ship as a silent empty catalog.
    const shipped = (await readdir(MANAGER_BUNDLED_SKILLS_DIRECTORY, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    expect(shipped).toEqual(['team-management-guide', 'team-operations'])
    for (const name of shipped) {
      // A Windows checkout can hand the file back with CRLF; the Harness
      // frontmatter reader tolerates it, so the shipped shape is asserted on
      // normalized text instead of the checkout's line endings.
      const text = (await readFile(join(MANAGER_BUNDLED_SKILLS_DIRECTORY, name, 'SKILL.md'), 'utf8')).replaceAll('\r\n', '\n')
      expect(text.startsWith(`---\nname: ${name}\n`)).toBe(true)
    }
    const fixture = await managerFixture({ bundledRoot: MANAGER_BUNDLED_SKILLS_DIRECTORY })
    expect(await catalogNames(fixture.ctx, fixture.agent)).toEqual(['team-management-guide', 'team-operations'])
  })

  it('loads the bundled manager skills and its own private directory, and nothing else', async () => {
    const fixture = await managerFixture()
    expect(await catalogNames(fixture.ctx, fixture.agent)).toEqual(['shared-name'])

    // A private skill the manager installs itself is discovered by the next
    // query of the same Session: no new conversation and no preset edit.
    await writeFile(join(fixture.privateRoot, 'skills', 'weekly-review.md'),
      SKILL_MD('weekly-review', 'How this Human likes the weekly review run', 'Ask for the board first.'))
    await vi.waitFor(async () => {
      expect(await catalogNames(fixture.ctx, fixture.agent)).toEqual(['shared-name', 'weekly-review'])
    }, { timeout: 5_000, interval: 50 })
    const loaded = await skillRegistryFor(fixture.ctx, fixture.agent).get('weekly-review', { scope: fixture.agent as never })
    expect(loaded?.content).toContain('Ask for the board first.')

    // Removing it is equally file-driven.
    await rm(join(fixture.privateRoot, 'skills', 'weekly-review.md'))
    await vi.waitFor(async () => {
      expect(await catalogNames(fixture.ctx, fixture.agent)).toEqual(['shared-name'])
    }, { timeout: 5_000, interval: 50 })
  })

  it('keeps a bundled skill ahead of a same-name private one', async () => {
    const fixture = await managerFixture()
    await writeFile(join(fixture.privateRoot, 'skills', 'shared-name.md'),
      SKILL_MD('shared-name', 'A private skill that tries to shadow the shipped one', 'Private body.'))
    await vi.waitFor(async () => {
      expect((await catalogNames(fixture.ctx, fixture.agent)).filter(name => name === 'shared-name')).toHaveLength(1)
    }, { timeout: 5_000, interval: 50 })
    const loaded = await skillRegistryFor(fixture.ctx, fixture.agent).get('shared-name', { scope: fixture.agent as never })
    expect(loaded?.content).toContain('Bundled body.')
    expect(loaded?.content).not.toContain('Private body.')
  })

  it('keeps manager and Member catalogs private while ordinary Sessions retain Host-global skills', async () => {
    const fixture = await managerFixture()
    const dispose = fixture.ctx.skills.register({
      name: 'office', description: 'Host-global Office skills', source: 'runtime', content: 'Ordinary manager bystanders may load this body.',
    })
    onTestFinished(async () => { dispose() })
    await writeFile(join(fixture.privateRoot, 'skills', 'manager-only.md'),
      SKILL_MD('manager-only', 'A skill only the management Session may load', 'Manager only.'))
    await vi.waitFor(async () => {
      expect(await catalogNames(fixture.ctx, fixture.agent)).toContain('manager-only')
    }, { timeout: 5_000, interval: 50 })

    const ordinary = await fixture.ctx.agents.create({ sessionId: SessionId('ordinary-manager-skills') })
    onTestFinished(async () => { await ordinary.dispose() })
    expect(await catalogNames(fixture.ctx, fixture.agent)).not.toContain('office')
    expect(await skillRegistryFor(fixture.ctx, fixture.agent).get('office', { scope: fixture.agent as never })).toBeUndefined()
    expect(await catalogNames(fixture.ctx, ordinary.agent)).toEqual(['office'])
    expect((await skillRegistryFor(fixture.ctx, ordinary.agent).get('office', { scope: ordinary.agent as never }))?.content)
      .toBe('Ordinary manager bystanders may load this body.')

    const member = await fixture.ctx.agentTeam.addMember({ requestId: requestId('manager-skills-member'),
      workspaceId: (await fixture.ctx.workspaceRegistry.list())[0]!.id, handle: 'skills-bystander',
      description: 'Ordinary Member', presetId: 'team-member', projectRefs: [], model: { provider: 'mock', model: 'mock' } })
    const memberAgent = fixture.ctx.agents.get(member.status.member.sessionId)
    expect(memberAgent).toBeDefined()
    const memberCatalog = await catalogNames(fixture.ctx, memberAgent!)
    // The Member keeps exactly its own bundled core skills.
    expect(memberCatalog).toEqual(['member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model'])
    expect(memberCatalog).not.toContain('manager-only')
    expect(memberCatalog).not.toContain('shared-name')
  })
})
