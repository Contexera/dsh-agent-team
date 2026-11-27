import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MANAGER_BUNDLED_SKILLS_DIRECTORY, ManagerSessionRuntime } from '../src/manager-session.ts'
import type { ManagerSessionPointer, ManagerSessionStoreLike } from '../src/manager-session-store.ts'
import { realHarness, requestId, ScriptedAdapter, textResponse, toolCallResponse, waitFor } from './helpers/member-harness.ts'
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
async function managerFixture(options: { bundledRoot?: string; adapter?: LlmAdapter } = {}): Promise<ManagerFixture> {
  const { ctx, root, workspaceId, checkout } = await realHarness(options.adapter)
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

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

async function runTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = waitForIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

describe('Team manager skill discovery', () => {
  it('discovers all six guide skills through the shipped manager catalog', async () => {
    const fixture = await managerFixture({ bundledRoot: MANAGER_BUNDLED_SKILLS_DIRECTORY })
    expect(await catalogNames(fixture.ctx, fixture.agent))
      .toEqual(['manager-domain-model', 'manager-memory', 'manager-session-evidence', 'team-event-loops', 'team-management-guide', 'team-operations'])
  })

  it('puts the manager catalog and skill tool in the first model request and loads a body later', async () => {
    // The catalog test above reads the registry; this reads the actual
    // GenerateOptions the manager's turn sends, so a provider that never
    // reaches the model prompt cannot pass as a working catalog.
    const adapter = new ScriptedAdapter()
    adapter.enqueue(textResponse('Ready.'))
    // The Host path, not a hand-built runtime: this is the manager Session the
    // plugin actually registers, with the shipped skill root the Host passes.
    const { ctx } = await realHarness(adapter)
    const opened = await ctx.agentTeam.openManagerSession({})
    if (opened.status !== 'ready') throw new Error(`expected a ready manager Session, received '${opened.status}'`)
    const agent = ctx.agents.get(opened.sessionId)
    if (agent === undefined) throw new Error('expected the manager Agent to be registered')
    await runTurn(ctx, agent, 'What can you do?')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('skill')
    const first = JSON.stringify(adapter.requests[0]?.messages)
    expect(first).toContain('<available_skills>')
    for (const name of ['manager-domain-model', 'manager-memory', 'manager-session-evidence', 'team-event-loops', 'team-management-guide', 'team-operations']) {
      expect(first).toContain(name)
    }
    // The Member core skills stay out of the manager's prompt, not merely out
    // of its registry.
    for (const name of ['member-memory-manager', 'member-skill-manager', 'project-subscriptions', 'team-domain-model']) {
      expect(first).not.toContain(name)
    }

    // The model itself calls `skill`, and the loaded body reaches the request
    // after the tool result: that is what proves the tool is callable in this
    // preset rather than merely listed. A `/name` invocation would only prove
    // the user path, which the Host expands before the model sees it.
    adapter.enqueue(toolCallResponse('call-manager-skill', 'skill', { name: 'team-management-guide' }))
    adapter.enqueue(textResponse('Guide loaded.'))
    await runTurn(ctx, agent, 'Load the management guide.')
    expect(adapter.requests).toHaveLength(3)
    const loadedRequest = JSON.stringify(adapter.requests[2]?.messages)
    expect(loadedRequest).toContain('<skill_content name=\\"team-management-guide\\">')
    expect(loadedRequest).toContain('## Diagnose before you design')
  })

  it('loads the bundled manager skills and its own private directory, and nothing else', async () => {
    const fixture = await managerFixture()

    // A private skill the manager installs itself is discovered by the next
    // query of the same Session: no new conversation and no preset edit.
    await writeFile(join(fixture.privateRoot, 'skills', 'weekly-review.md'),
      SKILL_MD('weekly-review', 'How this Human likes the weekly review run', 'Ask for the board first.'))
    expect(await catalogNames(fixture.ctx, fixture.agent)).toEqual(['shared-name', 'weekly-review'])
    const loaded = await skillRegistryFor(fixture.ctx, fixture.agent).get('weekly-review', { scope: fixture.agent as never })
    expect(loaded?.content).toContain('Ask for the board first.')

    // Removing it is equally file-driven.
    await rm(join(fixture.privateRoot, 'skills', 'weekly-review.md'))
    await vi.waitFor(async () => {
      expect(await catalogNames(fixture.ctx, fixture.agent)).toEqual(['shared-name'])
    })
  })

  it('keeps a bundled skill ahead of a same-name private one', async () => {
    const fixture = await managerFixture()
    await writeFile(join(fixture.privateRoot, 'skills', 'shared-name.md'),
      SKILL_MD('shared-name', 'A private skill that tries to shadow the shipped one', 'Private body.'))
    expect((await catalogNames(fixture.ctx, fixture.agent)).filter(name => name === 'shared-name')).toHaveLength(1)
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
    expect(await catalogNames(fixture.ctx, fixture.agent)).toContain('manager-only')

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

  it('keeps the shipped catalog and skill tool callable across restart beside a separate Host preset registry', async () => {
    const adapter = new ScriptedAdapter()
    const first = await realHarness(adapter, 'jsonl', undefined, false, undefined, 'sqlite', { isolatedPresetRealm: true })
    const opened = await first.ctx.agentTeam.openManagerSession({})
    if (opened.status !== 'ready') throw new Error(`expected a ready manager Session, received '${opened.status}'`)

    const verify = async (ctx: Context, agent: Agent, callId: string): Promise<void> => {
      const registry = ctx.agentPresets.serviceFor(agent, 'skills')
      if (registry === undefined) throw new Error('the manager preset has no isolated skill registry')
      expect(registry).not.toBe(ctx.skills)
      const names = (await registry.list({ scope: agent as never })).map(skill => skill.name).sort()
      expect(names).toEqual(['manager-domain-model', 'manager-memory', 'manager-session-evidence', 'team-event-loops', 'team-management-guide', 'team-operations'])

      adapter.enqueue(textResponse('Ready.'))
      await runTurn(ctx, agent, 'What can you do?')
      const catalogRequest = JSON.stringify(adapter.requests.at(-1)?.messages)
      expect(catalogRequest).toContain('<available_skills>')
      expect(catalogRequest).toContain('team-event-loops')

      adapter.enqueue(toolCallResponse(callId, 'skill', { name: 'team-event-loops' }))
      adapter.enqueue(textResponse('Loaded.'))
      await runTurn(ctx, agent, 'Load the event loop guide.')
      expect(JSON.stringify(adapter.requests.at(-1)?.messages)).toContain('<skill_content name=\\"team-event-loops\\">')
    }

    const fresh = first.ctx.agents.get(opened.sessionId)
    if (fresh === undefined) throw new Error('the fresh manager Session has no live Agent')
    await verify(first.ctx, fresh, 'call-manager-fresh')
    await first.teamFiber.dispose()

    const second = await realHarness(adapter, 'jsonl', { root: first.root }, false, undefined, 'sqlite', { isolatedPresetRealm: true })
    // A boot that returned is not yet a resumed manager: Host startup restores
    // the manager Session after readiness, so wait for that deferred restore
    // instead of reading the registry once.
    const resumed = await waitFor(() => second.ctx.agents.get(opened.sessionId), 20_000)
    await verify(second.ctx, resumed, 'call-manager-resumed')
  })
})
