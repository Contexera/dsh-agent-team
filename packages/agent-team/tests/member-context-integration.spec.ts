import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, freezeMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'
import * as memberContext from '../src/member-context.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Test-only projection that rewrites selected Member context messages without touching their raw events. */
    'test/prune-member-context': { readonly seqs: readonly number[] }
  }
}

const pruneMemberContext: SessionMessageProjection<'test/prune-member-context'> = {
  type: 'test/prune-member-context',
  project(event, context) {
    const updates = new Map<SessionSeq, Message>()
    for (const value of event.data.seqs) {
      const sequence = SessionSeq(value)
      const source = context.events[sequence - context.baseSeq]
      const message = context.messages.get(sequence) ?? (source?.type === 'user/message' ? source.data : undefined)
      if (message?.role !== 'user') continue
      updates.set(sequence, freezeMessage({ ...message, content: [{ type: 'text' as const, text: '[pruned by projection]' }] }))
    }
    return updates
  },
}

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

/** An Agent over a real Session, so each step reads the surface it actually accumulated. */
function surfaceAgent(ctx: Context): Agent {
  return agentWithSession(ctx, Session.create(SessionId('session:member-context-surface')))
}

function agentWithSession(ctx: Context, session: Session): Agent {
  return {
    id: session.id, ctx, status: 'idle', options: { provider: 'mock', model: 'mock' },
    session,
    inbox: {} as never,
    cancel() {}, whenIdle: async () => {}, runMaintenance: async task => task(new AbortController().signal),
    send() {}, followup() {}, steer() {}, inject() {},
  } as Agent
}

/** Run one step and commit what the injection asked the Session to carry, as the loop would. */
async function step(ctx: Context, agent: Agent): Promise<readonly UserMessage[]> {
  const decision = await preStep(ctx, agent)
  const messages = decision.kind === 'enter' ? decision.messages : []
  for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
  return messages
}

/** Replace the whole surface with one compaction summary, as a successful compaction does. */
function compactSurface(agent: Agent, summary: string): void {
  const nodes = agent.session.surface.nodes
  if (nodes.length === 0) return
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: summary }],
    source: { kind: memberContext.name, form: 'instructions' },
  }), {
    surfaceOp: { op: 'replace', startSeq: SessionSeq(nodes[0]!), endSeq: SessionSeq(nodes.at(-1)!) },
    sourceEventSeqs: nodes.map(sequence => SessionSeq(sequence)),
  })
}

function texts(messages: readonly UserMessage[]): string[] {
  return messages.map(message => message.content[0]?.type === 'text' ? message.content[0].text : '')
}

async function mount(ctx: Context): Promise<void> {
  const loader = Object.create(Loader.prototype) as Loader
  const plugin = loader.unwrapExports(memberContext) as Parameters<Context['plugin']>[0]
  await ctx.plugin(plugin)
}

describe('Team Member private memory composition', () => {
  it('injects every current context category once, then nothing while the surface is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    await writeFile(join(root, 'memory.md'), 'index v1')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: 'tester' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)

    const first = await step(ctx, agent)
    expect(first).toHaveLength(4)
    const [identity, ownership, workspaces, memory] = texts(first)
    expect(identity).toBe('Team identity: you are @A — tester')
    expect(ownership).toContain('You own no Projects.')
    expect(workspaces).toContain('workspace:default (creation Workspace)')
    expect(workspaces).toContain(JSON.stringify(join(root, 'AGENTS.md')))
    expect(memory).toContain('index v1')
    expect(memory).toContain(`Memory index: ${root}/memory.md`)

    expect(await step(ctx, agent)).toEqual([])
    await ctx.fiber.dispose()
  })

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

  it('reports a memory edit once as a stale-copy notice and never resends other categories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    const memoryFile = join(root, 'memory.md')
    await writeFile(memoryFile, 'index v1')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    let owned: { projectRef: string; name: string; workspaceId: string }[] = []
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: 'tester' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => owned,
    } as never)
    await mount(ctx)
    await step(ctx, agent)

    await writeFile(memoryFile, 'index v2')
    const update = await step(ctx, agent)
    expect(update).toHaveLength(1)
    expect(texts(update)[0]).toContain('Private memory update')
    expect(texts(update)[0]).toContain('no longer represents the latest memory.md')
    expect(texts(update)[0]).toContain(`Memory index: ${root}/memory.md`)
    expect(texts(update)[0]).not.toContain('index v2')
    expect(await step(ctx, agent)).toEqual([])

    owned = [{ projectRef: 'project:alpha', name: 'alpha', workspaceId: 'workspace:default' }]
    const granted = await step(ctx, agent)
    expect(texts(granted)).toHaveLength(1)
    expect(texts(granted)[0]).toContain('You own these Projects:\n- alpha project:alpha (Workspace workspace:default)')
    expect(texts(granted)[0]).not.toContain('Private memory')
    await ctx.fiber.dispose()
  })

  it('replaces the whole Workspace list when participation grows, shrinks to one, or empties', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    await writeFile(join(root, 'memory.md'), 'index')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    const workspaces = [{ workspaceId: 'workspace:default', path: root, default: true }]
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: '' }
        : undefined,
      workspacesForAgent: () => workspaces,
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)
    await step(ctx, agent)

    workspaces.push({ workspaceId: 'workspace:other', path: join(root, 'other'), default: false })
    const joined = await step(ctx, agent)
    expect(texts(joined)).toHaveLength(1)
    expect(texts(joined)[0]).toContain('workspace:other')
    expect(texts(joined)[0]).toContain('working_directory({cd: <path>})')
    expect(texts(joined)[0]).not.toContain('Private memory')

    workspaces.pop()
    const left = await step(ctx, agent)
    expect(texts(left)).toHaveLength(1)
    expect(texts(left)[0]).toContain('workspace:default (creation Workspace)')
    expect(texts(left)[0]).not.toContain('workspace:other')

    workspaces.splice(0)
    const none = await step(ctx, agent)
    expect(texts(none)).toHaveLength(1)
    expect(texts(none)[0]).toContain('You participate in no Workspaces.')
    await ctx.fiber.dispose()
  })

  it('restores every category after a compaction, and the full index when only a stale notice survives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    const memoryFile = join(root, 'memory.md')
    await writeFile(memoryFile, 'index v1')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: 'tester' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)
    await step(ctx, agent)
    await writeFile(memoryFile, 'index v2')
    await step(ctx, agent)

    // A compaction keeps only the stale notice: that notice is not the complete index.
    const nodes = agent.session.surface.nodes
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted summary' }],
      source: { kind: memberContext.name, form: 'instructions' },
    }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(nodes[0]!), endSeq: SessionSeq(nodes[3]!) },
      sourceEventSeqs: nodes.slice(0, 4).map(sequence => SessionSeq(sequence)),
    })
    const afterNoticeOnly = await step(ctx, agent)
    expect(afterNoticeOnly).toHaveLength(4)
    const [identity, ownership, workspaces, memory] = texts(afterNoticeOnly)
    expect(identity).toContain('@A')
    expect(ownership).toContain('You own no Projects.')
    expect(workspaces).toContain('workspace:default')
    expect(memory).toContain('index v2')
    expect(memory).not.toContain('Private memory update')

    compactSurface(agent, 'compacted summary again')
    const afterFullCompaction = await step(ctx, agent)
    expect(afterFullCompaction).toHaveLength(4)
    expect(texts(afterFullCompaction)[3]).toContain('index v2')
    await ctx.fiber.dispose()
  })

  it('states absent, unreadable, and over-budget memory anomalies with their entry point', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    const memoryFile = join(root, 'memory.md')
    await writeFile(memoryFile, 'index v1')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: '' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)
    await step(ctx, agent)

    await writeFile(memoryFile, Buffer.alloc(16 * 1024 + 1, 'x'))
    const overBudget = texts(await step(ctx, agent))
    expect(overBudget).toHaveLength(1)
    expect(overBudget[0]).toContain('exceeds the 16 KiB context budget')
    expect(overBudget[0]).toContain('contents were not injected')
    expect(overBudget[0]).toContain(`Memory index: ${root}/memory.md`)

    await rm(memoryFile)
    const absent = texts(await step(ctx, agent))
    expect(absent).toHaveLength(1)
    expect(absent[0]).toContain('memory.md is absent')
    expect(absent[0]).toContain(`Memory index: ${root}/memory.md`)

    await mkdir(memoryFile)
    const unreadable = texts(await step(ctx, agent))
    expect(unreadable).toHaveLength(1)
    expect(unreadable[0]).toContain('memory.md is currently unreadable')
    expect(unreadable[0]).toContain(`Memory index: ${root}/memory.md`)
    await ctx.fiber.dispose()
  })

  it('keeps the fixed F1 scenario to classified injections and never resends an unchanged step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    await writeFile(join(root, 'memory.md'), 'index v1')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    let owned: { projectRef: string; name: string; workspaceId: string }[] = []
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: 'tester' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => owned,
    } as never)
    await mount(ctx)

    const start = await step(ctx, agent)
    const idle = await step(ctx, agent)
    await writeFile(join(root, 'memory.md'), 'index v2')
    const edited = await step(ctx, agent)
    owned = [{ projectRef: 'project:p', name: 'P', workspaceId: 'workspace:default' }]
    const granted = await step(ctx, agent)
    const idleAgain = await step(ctx, agent)
    compactSurface(agent, 'compaction summary')
    const recovered = await step(ctx, agent)

    expect([start, idle, edited, granted, idleAgain, recovered].map(messages => messages.length)).toEqual([4, 0, 1, 1, 0, 4])
    const injected = [start, edited, granted, recovered].flatMap(messages => texts(messages))
    // Identity, ownership, and participation are re-sent only by the compaction recovery; memory carries the newer baseline.
    expect(injected).toHaveLength(10)
    expect(new Set(injected).size).toBe(7)
    await ctx.fiber.dispose()
  })

  it('sends only the identity block when the Member identity changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    await writeFile(join(root, 'memory.md'), 'index')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    let description = 'tester'
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)
    await step(ctx, agent)

    description = 'reviewer'
    const changed = await step(ctx, agent)
    expect(texts(changed)).toHaveLength(1)
    expect(texts(changed)[0]).toBe('Team identity: you are @A — reviewer')
    await ctx.fiber.dispose()
  })

  it('states an empty ownership list when ownership is withdrawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    await writeFile(join(root, 'memory.md'), 'index')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    let owned: { projectRef: string; name: string; workspaceId: string }[] = [
      { projectRef: 'project:alpha', name: 'alpha', workspaceId: 'workspace:default' },
    ]
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: '' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => owned,
    } as never)
    await mount(ctx)
    await step(ctx, agent)

    owned = []
    const revoked = await step(ctx, agent)
    expect(texts(revoked)).toHaveLength(1)
    expect(texts(revoked)[0]).toContain('You own no Projects.')
    expect(texts(revoked)[0]).not.toContain('Private memory')
    await ctx.fiber.dispose()
  })

  it('replays a real Session seed without re-injecting unchanged blocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    const memoryFile = join(root, 'memory.md')
    await writeFile(memoryFile, 'index v1')
    const ctx = new Context()
    const session = Session.create(SessionId('session:member-context-reload-source'))
    const agent = agentWithSession(ctx, session)
    const members = new Set<Agent>([agent])
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => members.has(subject)
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: '' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)
    await step(ctx, agent)

    const restored = Session.fromRestore(
      session.id,
      [...session.snapshotEvents()],
      session.header,
      session.inheritedEventCount,
      'shared-frozen',
    )
    const reloaded = agentWithSession(ctx, restored)
    members.add(reloaded)
    expect(await step(ctx, reloaded)).toEqual([])

    await writeFile(memoryFile, 'index v2')
    const updated = texts(await step(ctx, reloaded))
    expect(updated).toHaveLength(1)
    expect(updated[0]).toContain('Private memory update')
    await ctx.fiber.dispose()
  })

  it('compares the newest memory event when a file returns to an earlier state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    const memoryFile = join(root, 'memory.md')
    await writeFile(memoryFile, 'index v1')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: '' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)
    await step(ctx, agent)

    await writeFile(memoryFile, 'index v2')
    expect(texts(await step(ctx, agent))).toHaveLength(1)
    await writeFile(memoryFile, 'index v1')
    const reverted = texts(await step(ctx, agent))
    expect(reverted).toHaveLength(1)
    expect(reverted[0]).toContain('Private memory update')
    expect(await step(ctx, agent)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('lets a newer baseline outrank an older matching update digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    const memoryFile = join(root, 'memory.md')
    await writeFile(memoryFile, 'index v1')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: '' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)
    await step(ctx, agent)

    await writeFile(memoryFile, 'index v2')
    expect(texts(await step(ctx, agent))).toHaveLength(1)
    await writeFile(memoryFile, 'index v3')
    const baseline = agent.session.surface.nodes[3]!
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'baseline compacted; old update retained' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(baseline), endSeq: SessionSeq(baseline) },
      sourceEventSeqs: [SessionSeq(baseline)],
    })
    expect(texts(await step(ctx, agent))[0]).toContain('index v3')

    await writeFile(memoryFile, 'index v2')
    const changed = texts(await step(ctx, agent))
    expect(changed).toHaveLength(1)
    expect(changed[0]).toContain('Private memory update')
    await ctx.fiber.dispose()
  })

  it('reads projected text and rejects a pruned baseline or update as memory evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    const memoryFile = join(root, 'memory.md')
    await writeFile(memoryFile, 'index v1')
    const ctx = new Context()
    const session = Session.create(SessionId('session:member-context-projected'), undefined, undefined, undefined, [pruneMemberContext])
    const agent = agentWithSession(ctx, session)
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: '' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)
    await step(ctx, agent)

    const baselineSeq = agent.session.surface.nodes[3]!
    agent.session.append('test/prune-member-context', { seqs: [baselineSeq] })
    const raw = agent.session.snapshotEvents().find(event => event.seq === baselineSeq)!
    expect(agent.session.deriveEventMessage(raw)).toMatchObject({ content: [{ text: '[pruned by projection]' }] })
    const recovered = texts(await step(ctx, agent))
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toContain('index v1')

    await writeFile(memoryFile, 'index v2')
    expect(texts(await step(ctx, agent))).toHaveLength(1)
    const updateSeq = agent.session.surface.nodes.at(-1)!
    agent.session.append('test/prune-member-context', { seqs: [updateSeq] })
    const resent = texts(await step(ctx, agent))
    expect(resent).toHaveLength(1)
    expect(resent[0]).toContain('Private memory update')
    await ctx.fiber.dispose()
  })

  it('restores a baseline when a replacement keeps its source but removes its body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    await writeFile(join(root, 'memory.md'), 'index v1')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    ctx.provide('agentTeam', {
      memberForAgent: () => ({ memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: '' }),
      workspacesForAgent: () => [],
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)
    const first = await step(ctx, agent)
    const baseline = first.at(-1)!
    const sequence = agent.session.surface.nodes.at(-1)!
    agent.session.append('user/message', createUserMessage({
      source: baseline.source,
      content: [{ type: 'text', text: '[memory summary]' }],
    }), {
      surfaceOp: { op: 'replace', startSeq: SessionSeq(sequence), endSeq: SessionSeq(sequence) },
      sourceEventSeqs: [SessionSeq(sequence)],
    })
    const recovered = texts(await step(ctx, agent))
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toContain('index v1')
    expect(await step(ctx, agent)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('provides the first complete index when an unavailable startup index becomes readable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-context-'))
    roots.push(root)
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    ctx.provide('agentTeam', {
      memberForAgent: () => ({ memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: '' }),
      workspacesForAgent: () => [],
      ownedProjectsForAgent: () => [],
    } as never)
    await mount(ctx)
    expect(texts(await step(ctx, agent)).at(-1)).toContain('memory.md is absent')
    expect(await step(ctx, agent)).toEqual([])
    await writeFile(join(root, 'memory.md'), 'first available index')
    const recovered = texts(await step(ctx, agent))
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toContain('first available index')
    expect(await step(ctx, agent)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('does nothing while the Host service is absent', async () => {
    const ctx = new Context()
    const agent = fakeAgent(ctx)
    await mount(ctx)
    expect(await preStep(ctx, agent)).toEqual({ kind: 'enter', messages: [] })
    await ctx.fiber.dispose()
  })

  it('renders no ownership block on a ledger without Project owners, then replaces it once owners exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-member-memory-'))
    roots.push(root)
    await writeFile(join(root, 'memory.md'), 'own index')
    const ctx = new Context()
    const agent = surfaceAgent(ctx)
    let owned: { projectRef: string; name: string; workspaceId: string }[] | undefined
    ctx.provide('agentTeam', {
      memberForAgent: (subject: Agent) => subject === agent
        ? { memberId: 'member:a', privateMemoryPath: root, handle: 'A', description: '' }
        : undefined,
      workspacesForAgent: () => [{ workspaceId: 'workspace:default', path: root, default: true }],
      ownedProjectsForAgent: () => owned,
    } as never)
    await mount(ctx)

    const first = texts(await step(ctx, agent))
    expect(first).toHaveLength(3)
    expect(first.some(text => text.includes('Team Project ownership'))).toBe(false)

    owned = []
    const unowned = texts(await step(ctx, agent))
    expect(unowned).toHaveLength(1)
    expect(unowned[0]).toContain('You own no Projects.')

    owned = [{ projectRef: 'project:alpha', name: 'alpha', workspaceId: 'workspace:default' }]
    const owning = texts(await step(ctx, agent))
    expect(owning).toHaveLength(1)
    expect(owning[0]).toContain('You own these Projects:\n- alpha project:alpha (Workspace workspace:default)')
    expect(await step(ctx, agent)).toEqual([])
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
