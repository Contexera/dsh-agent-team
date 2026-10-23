import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as memberContext from '../src/member-context.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function fakeAgent(ctx: Context): Agent {
  return {
    id: SessionId('session:memory-test'), ctx, status: 'idle', options: { provider: 'mock', model: 'mock' },
    session: { surface: { nodes: [] }, events: [] } as never,
    inbox: {} as never,
    cancel() {}, whenIdle: async () => {}, runMaintenance: async task => task(new AbortController().signal),
    send() {}, followup() {}, steer() {}, inject() {},
  } as Agent
}

async function preStep(ctx: Context, agent: Agent): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }))
}

async function mount(ctx: Context): Promise<void> {
  const loader = Object.create(Loader.prototype) as Loader
  const plugin = loader.unwrapExports(memberContext) as Parameters<Context['plugin']>[0]
  await ctx.plugin(plugin)
}

describe('Team Member private memory composition', () => {
  it('resolves the Host service lazily when loaded as a Cordis namespace plugin', () => {
    expect('default' in memberContext).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const plugin = loader.unwrapExports(memberContext) as Record<string, unknown>
    expect(plugin).toBe(memberContext)
    expect(plugin.name).toBe('wowyuarm-agent-team-member-context')
    // No declared inject: the row mounts while the Host restores Members, so a
    // dependency on `agentTeam` would fail every startup preset mount.
    expect(plugin.inject).toBeUndefined()
  })

  it('does nothing while the Host service is absent', async () => {
    const ctx = new Context()
    const agent = fakeAgent(ctx)
    await mount(ctx)
    expect(await preStep(ctx, agent)).toEqual({ kind: 'enter', messages: [] })
    await ctx.fiber.dispose()
  })

  it('injects only the bound Member index and replaces changed or removed content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-memory-'))
    roots.push(root)
    const own = join(root, 'memory.md')
    await writeFile(own, 'own index')
    const ctx = new Context()
    const agent = fakeAgent(ctx)
    const workspaces = [{ workspaceId: 'workspace:default', path: root, default: true }]
    let owned: { projectRef: string; name: string; workspaceId: string }[] | undefined
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent ? { privateMemoryPath: root } : undefined,
      workspacesForAgent: () => workspaces,
      ownedProjectsForAgent: () => owned,
    } as never)
    await mount(ctx)

    const first = await preStep(ctx, agent)
    expect(first.kind === 'enter' && first.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('own index') }))
    expect(first.kind === 'enter' && first.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining(`Private memory directory: ${root}`) }))

    expect(first.kind === 'enter' && first.messages.at(-1)?.content[0]).not.toEqual(expect.objectContaining({ text: expect.stringContaining('Team Workspace participation') }))
    workspaces.push({ workspaceId: 'workspace:other', path: join(root, 'other'), default: false })
    const joined = await preStep(ctx, agent)
    expect(joined.kind === 'enter' && joined.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining(JSON.stringify(join(root, 'other', 'AGENTS.md')).slice(1, -1)) }))
    expect(joined.kind === 'enter' && joined.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('working_directory({cd: <path>})') }))
    expect(joined.kind === 'enter' && joined.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('leaves its instructions unloaded') }))
    workspaces.pop()
    const left = await preStep(ctx, agent)
    expect(left.kind === 'enter' && left.messages.at(-1)?.content[0]).not.toEqual(expect.objectContaining({ text: expect.stringContaining('workspace:other') }))

    // A ledger before Project owners renders no ownership block; once owners exist an empty list is still said.
    expect(left.kind === 'enter' && left.messages.at(-1)?.content[0]).not.toEqual(expect.objectContaining({ text: expect.stringContaining('Team Project ownership') }))
    owned = []
    const unowned = await preStep(ctx, agent)
    expect(unowned.kind === 'enter' && unowned.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('You own no Projects.') }))
    owned = [{ projectRef: 'project:alpha', name: 'alpha', workspaceId: 'workspace:default' }]
    const owning = await preStep(ctx, agent)
    expect(owning.kind === 'enter' && owning.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('You own these Projects:\n- alpha project:alpha (Workspace workspace:default)') }))

    await writeFile(own, 'replacement index')
    const second = await preStep(ctx, agent)
    expect(second.kind === 'enter' && second.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('replacement index') }))

    await rm(own)
    const removed = await preStep(ctx, agent)
    expect(removed.kind === 'enter' && removed.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining('index is empty') }))
    expect(removed.kind === 'enter' && removed.messages.at(-1)?.content[0]).toEqual(expect.objectContaining({ text: expect.stringContaining(`Memory index: ${root}/memory.md`) }))
    await ctx.fiber.dispose()
  })

  it('does nothing for an ordinary unbound Agent', async () => {
    const ctx = new Context()
    const agent = fakeAgent(ctx)
    ctx.provide('agentTeam', { memberForAgent: () => undefined } as never)
    await mount(ctx)
    expect(await preStep(ctx, agent)).toEqual({ kind: 'enter', messages: [] })
    await ctx.fiber.dispose()
  })
})
