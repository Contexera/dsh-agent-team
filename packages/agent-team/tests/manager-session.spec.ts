import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { defineContentToolFixture, executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import {
  ManagerSessionRuntime,
  type ManagerSessionRuntimeDeps,
  type ManagerWorkspaceValue,
} from '../src/manager-session.ts'
import { ManagerSessionStore, type ManagerSessionPointer, type ManagerSessionStoreLike } from '../src/manager-session-store.ts'
import type { StoredSessionFailure, StoredSessionReadResult } from '../src/stored-session-reader.ts'
import { StoredSessionReader } from '../src/stored-session-reader.ts'
import { realHarness, requestId } from './helpers/member-harness.ts'

class MemoryPointerStore implements ManagerSessionStoreLike {
  pointer: ManagerSessionPointer | undefined
  readFailure: Error | undefined
  writeFailure: Error | undefined
  writes = 0

  read(): ManagerSessionPointer | undefined {
    if (this.readFailure !== undefined) throw this.readFailure
    return this.pointer
  }

  ownedSessionIds(): readonly SessionId[] {
    return this.pointer === undefined ? [] : [...this.pointer.previousSessionIds ?? [], this.pointer.sessionId]
  }

  async writeIfExpected(expectedSessionId: SessionId | undefined, pointer: ManagerSessionPointer): Promise<boolean> {
    this.writes += 1
    if (this.writeFailure !== undefined) throw this.writeFailure
    if (this.pointer?.sessionId !== expectedSessionId) return false
    this.pointer = Object.freeze({ ...pointer })
    return true
  }
}

function readResultOf(failure: StoredSessionFailure): StoredSessionReadResult {
  return { ok: false, failure }
}

function runtimeFor(
  ctx: Context,
  options: {
    readonly store: MemoryPointerStore
    readonly root: string
    readonly bundledSkillsRoot?: string | undefined
    readonly workspace: ManagerWorkspaceValue
    readonly reader?: Pick<StoredSessionReader, 'read'> | undefined
    readonly initializeDefaultWorkspace?: ((signal: AbortSignal) => Promise<ManagerWorkspaceValue | undefined>) | undefined
  },
): ManagerSessionRuntime {
  const deps: ManagerSessionRuntimeDeps = {
    ctx,
    store: options.store,
    reader: options.reader ?? { read: async sessionId => readResultOf({ kind: 'missing', sessionId, detail: 'not stored' }) },
    managerPrivateRoot: join(options.root, 'manager-private'),
    managerBundledSkillsRoot: options.bundledSkillsRoot ?? join(options.root, 'manager-bundled-skills'),
    defaultAgentOptions: () => ({ provider: 'mock', model: 'mock' }),
    initializeDefaultWorkspace: options.initializeDefaultWorkspace ?? (async () => options.workspace),
  }
  return new ManagerSessionRuntime(deps)
}

function managerAgents(ctx: Context): Agent[] {
  return ctx.agents.list().filter(agent => ctx.agentPresets.composedPreset(agent.ctx) === 'team-manager')
}

function toolNames(ctx: Context, agent: Agent): readonly string[] {
  return ctx.tools.schemas(agent as never).map(schema => schema.name).sort()
}

async function execute(ctx: Context, agent: Agent, name: string, callId: string) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    agent,
    name,
    callId: ToolCallId(callId),
    arguments: {},
  })
}

describe('Team manager Session Host runtime', () => {
  it('opens and replaces the manager Session through the Host Remote', async () => {
    const { ctx, workspaceId, archived } = await realHarness()
    const first = await ctx.agentTeam.openManagerSession({})
    expect(first).toMatchObject({ status: 'ready', workspaceId })
    if (first.status !== 'ready') throw new Error('expected a ready manager Session')
    expect(await ctx.agentTeam.openManagerSession({})).toEqual(first)

    const replaced = await ctx.agentTeam.newManagerSession({ expectedSessionId: first.sessionId })
    expect(replaced.status).toBe('ready')
    if (replaced.status !== 'ready') throw new Error('expected a ready replacement')
    expect(replaced.sessionId).not.toBe(first.sessionId)
    // A stale caller observes the current id instead of creating another.
    expect(await ctx.agentTeam.newManagerSession({ expectedSessionId: first.sessionId })).toEqual(replaced)
    expect(managerAgents(ctx).map(agent => agent.id)).toEqual([replaced.sessionId])
    expect(archived).toContain(first.sessionId)
    expect(archived).not.toContain(replaced.sessionId)
  })

  it('identifies current and retired manager Sessions from their durable lineage', async () => {
    const first = await realHarness(undefined, 'jsonl', undefined, false, undefined, 'sqlite')
    const opened = await first.ctx.agentTeam.openManagerSession({})
    if (opened.status !== 'ready') throw new Error('expected a ready manager Session')
    const member = await first.ctx.agentTeam.addMember({
      requestId: requestId('ownership-member'), workspaceId: first.workspaceId,
      handle: 'ownership-member', description: '', presetId: 'team-member', projectRefs: [],
      model: { provider: 'mock', model: 'mock' },
    })
    await first.ctx.agentTeam.archiveMember({
      requestId: requestId('ownership-archive'), memberId: member.status.member.memberId,
    })
    const ordinary = await first.ctx.agents.create({
      sessionId: SessionId('session-ordinary-after-manager'),
      meta: { cwd: first.checkout, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await ordinary.dispose()
    const replaced = await first.ctx.agentTeam.newManagerSession({ expectedSessionId: opened.sessionId })
    if (replaced.status !== 'ready') throw new Error('expected a ready manager replacement')
    expect(first.ctx.agentTeam.sessionOwnership({
      sessionIds: [opened.sessionId, replaced.sessionId, member.status.member.sessionId, ordinary.agent.id],
    })).toEqual([
      { sessionId: opened.sessionId, kind: 'manager' },
      { sessionId: replaced.sessionId, kind: 'manager' },
      { sessionId: member.status.member.sessionId, kind: 'member' },
    ])
    await first.teamFiber.dispose()

    const second = await realHarness(undefined, 'jsonl', { root: first.root }, false, undefined, 'sqlite')
    expect(second.ctx.agentTeam.sessionOwnership({
      sessionIds: [opened.sessionId, member.status.member.sessionId, ordinary.agent.id],
    })).toEqual([
      { sessionId: opened.sessionId, kind: 'manager' },
      { sessionId: member.status.member.sessionId, kind: 'member' },
    ])
  })

  it('refuses ownership classification when the durable manager lineage cannot be read', async () => {
    const { ctx } = await realHarness()
    const opened = await ctx.agentTeam.openManagerSession({})
    if (opened.status !== 'ready') throw new Error('expected a ready manager Session')
    const read = vi.spyOn(ManagerSessionStore.prototype, 'ownedSessionIds').mockImplementation(() => {
      throw new Error('manager lineage unavailable')
    })
    try {
      expect(() => ctx.agentTeam.sessionOwnership({ sessionIds: [opened.sessionId] }))
        .toThrow('manager lineage unavailable')
    } finally {
      read.mockRestore()
    }
  })

  it('pre-restores the registered Session after a Host restart', async () => {
    const first = await realHarness(undefined, 'jsonl', undefined, false, undefined, 'sqlite')
    const opened = await first.ctx.agentTeam.openManagerSession({})
    if (opened.status !== 'ready') throw new Error('expected a ready manager Session')
    await first.teamFiber.dispose()

    const second = await realHarness(undefined, 'jsonl', { root: first.root }, false, undefined, 'sqlite')
    const agent = await vi.waitFor(() => {
      const live = second.ctx.agents.get(opened.sessionId)
      if (live === undefined) throw new Error('manager Session restore is still pending')
      return live
    })
    expect(agent).toBeDefined()
    expect(second.ctx.agentPresets.composedPreset(agent!.ctx)).toBe('team-manager')
    expect(agent!.session.ownEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(1)
    expect(agent!.session.ownEvents().filter(event => event.type === 'session/title')).toHaveLength(1)
    expect(await second.ctx.agentTeam.openManagerSession({})).toEqual(opened)
  })

  it('cancels an in-flight pre-restore when the manager runtime is disposed', async () => {
    const { ctx, workspaceId, checkout, root } = await realHarness()
    const store = new MemoryPointerStore()
    store.pointer = { sessionId: SessionId('manager-blocked-restore'), workspaceId }
    let started = false
    const runtime = runtimeFor(ctx, {
      store,
      root,
      workspace: { workspaceId, path: checkout },
      reader: {
        read: (_sessionId, signal) => new Promise<StoredSessionReadResult>((_, reject) => {
          started = true
          signal?.addEventListener('abort', () => { reject(new Error('test restore cancelled')) }, { once: true })
        }),
      },
    })
    const restoring = runtime.preRestore()
    await vi.waitFor(() => { expect(started).toBe(true) })
    await runtime.dispose()
    expect(await restoring).toMatchObject({ status: 'unavailable' })
  })

  it('leaves the current manager denied if its handle cannot stop at shutdown', async () => {
    const { ctx, workspaceId, checkout, root, archived } = await realHarness()
    const store = new MemoryPointerStore()
    const runtime = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    let handle: AgentHandle | undefined
    vi.spyOn(ctx.agents, 'create').mockImplementationOnce(async options => {
      handle = await originalCreate(options)
      return handle
    })
    const opened = await runtime.open()
    if (opened.status !== 'ready' || handle === undefined) throw new Error('expected a ready manager handle')
    const { agent } = handle
    expect(await execute(ctx, agent, 'manager_fixture', 'manager-before-shutdown')).toMatchObject({ isError: false })
    const stop = vi.spyOn(handle, 'dispose').mockRejectedValue(new Error('manager shutdown failed (test seam)'))
    try {
      await Promise.all([runtime.dispose(), runtime.dispose()])
      expect(stop).toHaveBeenCalledTimes(1)
      expect(store.pointer?.sessionId).toBe(opened.sessionId)
      expect(archived).not.toContain(opened.sessionId)
      expect(ctx.agents.get(opened.sessionId)).toBe(agent)
      const denied = await execute(ctx, agent, 'manager_fixture', 'manager-after-failed-shutdown')
      expect(denied).toMatchObject({ isError: true, error: { message: expect.stringContaining('not authorized') } })
    } finally {
      stop.mockRestore()
      await handle.dispose()
    }
  })

  it('sets the default title only when absent and ignores a rename failure', async () => {
    const { ctx, workspaceId, checkout, root } = await realHarness()
    const store = new MemoryPointerStore()
    const rename = vi.spyOn(ctx.sessionTitle, 'rename').mockImplementation(() => {
      throw new Error('title service unavailable (test seam)')
    })
    const runtime = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const opened = await runtime.open()
    expect(opened).toMatchObject({ status: 'ready' })
    if (opened.status !== 'ready') throw new Error('expected a ready manager Session')
    rename.mockRestore()
    const agent = ctx.agents.get(opened.sessionId)!
    // No title was written by the failing default attempt; an explicit title
    // then survives the next resume unchanged.
    expect(ctx.sessionTitle.get(agent.session)).toBeUndefined()
    ctx.sessionTitle.rename(agent.session, 'Custom manager')
    await runtime.dispose()

    const resumed = runtimeFor(ctx, {
      store,
      root,
      workspace: { workspaceId, path: checkout },
      reader: new StoredSessionReader(ctx),
    })
    expect(await resumed.preRestore()).toMatchObject({ status: 'ready', sessionId: opened.sessionId })
    expect(ctx.sessionTitle.get(ctx.agents.get(opened.sessionId)!.session)?.title).toBe('Custom manager')
    await resumed.dispose()
  })

  it('creates exactly one Session for concurrent first opens and attaches the exact Workspace path', async () => {
    const { ctx, workspaceId, checkout, root } = await realHarness()
    const runtime = runtimeFor(ctx, { store: new MemoryPointerStore(), root, workspace: { workspaceId, path: checkout } })
    const create = vi.spyOn(ctx.agents, 'create')
    const [first, second, restored] = await Promise.all([runtime.open(), runtime.open(), runtime.preRestore()])

    expect(first).toMatchObject({ status: 'ready', workspaceId })
    expect(second).toEqual(first)
    expect(restored).toEqual(first)
    expect(create).toHaveBeenCalledTimes(1)
    if (first.status !== 'ready') throw new Error('expected a ready manager Session')

    const agent = ctx.agents.get(first.sessionId)
    expect(agent).toBeDefined()
    expect(managerAgents(ctx)).toHaveLength(1)
    expect(agent!.session.header.cwd).toBe(checkout)
    expect(ctx.agentPresets.composedPreset(agent!.ctx)).toBe('team-manager')
    expect(ctx.sessionTitle.get(agent!.session)?.title).toBe('团队管理')
    expect(agent!.session.ownEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(1)
    const scaffold = await readFile(join(root, 'manager-private', 'memory.md'), 'utf8')
    expect(scaffold).toContain('# Team manager memory')
    // The same recovery-index sections a Member's scaffold carries.
    for (const section of ['## Durable rules', '## On-demand notes', '## Open local state']) expect(scaffold).toContain(section)
    expect(scaffold).not.toContain('## In hand')
    await runtime.dispose()
  })

  it('keeps the old manager denied after pointer persistence even if its disposal fails', async () => {
    const { ctx, workspaceId, checkout, root } = await realHarness()
    const runtime = runtimeFor(ctx, { store: new MemoryPointerStore(), root, workspace: { workspaceId, path: checkout } })
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    let firstHandle: AgentHandle | undefined
    vi.spyOn(ctx.agents, 'create').mockImplementation(async options => {
      const handle = await originalCreate(options)
      firstHandle ??= handle
      return handle
    })

    const first = await runtime.open()
    if (first.status !== 'ready' || firstHandle === undefined) throw new Error('expected the first manager handle')
    const firstAgent = firstHandle.agent
    const originalDispose = firstHandle.dispose.bind(firstHandle)
    firstHandle.dispose = async () => {
      throw new Error('old manager disposal failed (test seam)')
    }

    const replacement = await runtime.newConversation(first.sessionId)
    expect(replacement).toMatchObject({ status: 'ready' })
    if (replacement.status !== 'ready') throw new Error('expected a ready replacement')
    expect(ctx.agents.get(first.sessionId)).toBe(firstAgent)
    const denied = await execute(ctx, firstAgent, 'manager_fixture', 'manager-retired-denied')
    expect(denied.isError).toBe(true)
    if (denied.isError) expect(denied.error.message).toContain('not authorized')

    firstHandle.dispose = originalDispose
    await originalDispose()
    expect(ctx.agents.get(first.sessionId)).toBeUndefined()
    await runtime.dispose()
  })

  it('keeps the published successor and retired history when automatic archival fails', async () => {
    const { ctx, workspaceId, checkout, root, archived, archiveFailures } = await realHarness()
    const runtime = runtimeFor(ctx, { store: new MemoryPointerStore(), root, workspace: { workspaceId, path: checkout } })
    const first = await runtime.open()
    if (first.status !== 'ready') throw new Error('expected the first manager Session')
    const retired = ctx.agents.get(first.sessionId)!
    const retiredEvents = retired.session.ownEvents().map(event => event.seq)
    archiveFailures.remaining = 1

    const replacement = await runtime.newConversation(first.sessionId)
    expect(replacement).toMatchObject({ status: 'ready' })
    if (replacement.status !== 'ready') throw new Error('expected a ready replacement')
    expect(await runtime.open()).toEqual(replacement)
    expect(managerAgents(ctx).map(agent => agent.id)).toEqual([replacement.sessionId])
    expect(archived).not.toContain(first.sessionId)
    expect(archived).not.toContain(replacement.sessionId)
    expect(retired.session.ownEvents().map(event => event.seq)).toEqual(retiredEvents)
    await runtime.dispose()
  })

  it('prefers the controller default, then the first usable Workspace in registry order', async () => {
    const { ctx, workspaceId, checkout, root, workspaces, workspaceStatus } = await realHarness()
    const first = WorkspaceId('workspace:first')
    workspaces.clear()
    workspaces.set(first, { id: first, path: join(root, 'first-checkout'), attachSession: async () => {} })
    workspaces.set(workspaceId, { id: workspaceId, path: checkout, attachSession: async () => {} })

    const preferredStore = new MemoryPointerStore()
    const preferred = runtimeFor(ctx, {
      store: preferredStore,
      root,
      workspace: { workspaceId, path: checkout },
    })
    expect(await preferred.open()).toMatchObject({ status: 'ready', workspaceId })
    await preferred.dispose()

    // The default becomes unusable: the first usable registry entry wins.
    workspaceStatus.set(workspaceId, 'missing-dir')
    const fallbackStore = new MemoryPointerStore()
    const fallback = runtimeFor(ctx, {
      store: fallbackStore,
      root,
      workspace: { workspaceId, path: checkout },
      initializeDefaultWorkspace: async () => ({ workspaceId, path: checkout }),
    })
    expect(await fallback.open()).toMatchObject({ status: 'ready', workspaceId: first })
    await fallback.dispose()
  })

  it('serializes new conversations so a stale caller cannot create a third Session', async () => {
    const { ctx, workspaceId, checkout, root } = await realHarness()
    const store = new MemoryPointerStore()
    const runtime = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const first = await runtime.open()
    if (first.status !== 'ready') throw new Error('expected a ready manager Session')

    const create = vi.spyOn(ctx.agents, 'create')
    const [left, right] = await Promise.all([
      runtime.newConversation(first.sessionId),
      runtime.newConversation(first.sessionId),
    ])
    expect(left.status).toBe('ready')
    if (left.status !== 'ready' || right.status !== 'ready') throw new Error('expected ready results')
    expect(right.sessionId).toBe(left.sessionId)
    expect(left.sessionId).not.toBe(first.sessionId)
    expect(create).toHaveBeenCalledTimes(1)
    expect(managerAgents(ctx).map(agent => agent.id)).toEqual([left.sessionId])
    await runtime.dispose()
  })

  it('replaces only a missing or archived pointer and keeps every unreadable pointer intact', async () => {
    const { ctx, workspaceId, checkout, root } = await realHarness()
    const store = new MemoryPointerStore()
    store.pointer = { sessionId: SessionId('session:manager-unreadable'), workspaceId }
    const create = vi.spyOn(ctx.agents, 'create')
    const cases: Array<{ failure: StoredSessionFailure; diagnostic: string }> = [
      { failure: { kind: 'refused', sessionId: store.pointer.sessionId, detail: 'format v9' }, diagnostic: 'session-refused' },
      { failure: { kind: 'corrupt', sessionId: store.pointer.sessionId, detail: 'bad json' }, diagnostic: 'session-unreadable' },
      { failure: { kind: 'io', sessionId: store.pointer.sessionId, detail: 'EIO' }, diagnostic: 'session-unreadable' },
      { failure: { kind: 'unknown', sessionId: store.pointer.sessionId, detail: 'mystery' }, diagnostic: 'session-unreadable' },
    ]
    for (const entry of cases) {
      const runtime = runtimeFor(ctx, {
        store,
        root,
        workspace: { workspaceId, path: checkout },
        reader: { read: async () => readResultOf(entry.failure) },
      })
      const result = await runtime.open()
      expect(result.status).toBe('unavailable')
      if (result.status !== 'unavailable') throw new Error('expected unavailable')
      expect(result.diagnostic.class).toBe(entry.diagnostic)
      expect(result.diagnostic.detail).toContain(entry.failure.kind === 'refused' ? 'format v9' : entry.failure.kind)
      expect(store.pointer.sessionId).toBe('session:manager-unreadable')
      await runtime.dispose()
    }
    expect(create).not.toHaveBeenCalled()

    const replacing = runtimeFor(ctx, {
      store,
      root,
      workspace: { workspaceId, path: checkout },
      reader: { read: async sessionId => readResultOf({ kind: 'missing', sessionId, detail: 'gone' }) },
    })
    const replacement = await replacing.open()
    expect(replacement).toMatchObject({ status: 'ready', workspaceId })
    expect(create).toHaveBeenCalledTimes(1)
    expect(store.pointer?.sessionId).toBe(replacement.status === 'ready' ? replacement.sessionId : undefined)
    await replacing.dispose()
  })

  it('reports a pointer read failure without creating or replacing anything', async () => {
    const { ctx, workspaceId, checkout, root } = await realHarness()
    const store = new MemoryPointerStore()
    store.pointer = { sessionId: SessionId('session:manager-pointer'), workspaceId }
    store.readFailure = new Error('pointer store unavailable (test seam)')
    const create = vi.spyOn(ctx.agents, 'create')
    const runtime = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const result = await runtime.open()
    expect(result).toMatchObject({ status: 'unavailable', diagnostic: { class: 'pointer-read' } })
    expect(store.pointer.sessionId).toBe('session:manager-pointer')
    expect(create).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('rolls back a successor archived before pointer persistence', async () => {
    const { ctx, workspaceId, checkout, root, workspaces } = await realHarness()
    const store = new MemoryPointerStore()
    workspaces.set(workspaceId, {
      id: workspaceId,
      path: checkout,
      attachSession: async () => {
        const successor = managerAgents(ctx).find(agent => agent.id !== store.pointer?.sessionId)
        if (successor !== undefined) await ctx.workspaceRegistry.archiveSession(successor.id, { stopActivity: true })
      },
    })
    const runtime = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const result = await runtime.open()
    expect(result).toMatchObject({ status: 'unavailable', diagnostic: { class: 'runtime' } })
    expect(store.pointer).toBeUndefined()
    expect(managerAgents(ctx)).toHaveLength(0)
    await runtime.dispose()
  })

  it('keeps the old pointer and handle across attach, create, and pointer failures', async () => {
    const { ctx, workspaceId, checkout, root, workspaces, presets, archived } = await realHarness()
    const store = new MemoryPointerStore()
    const runtime = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const first = await runtime.open()
    if (first.status !== 'ready') throw new Error('expected a ready manager Session')
    const agent = ctx.agents.get(first.sessionId)
    expect(agent).toBeDefined()

    // Attach failure: the candidate is disposed and never registered.
    const attach = workspaces.get(workspaceId)!.attachSession
    workspaces.set(workspaceId, { id: workspaceId, path: checkout, attachSession: async () => { throw new Error('attach refused (test seam)') } })
    const attachFailure = await runtime.newConversation(first.sessionId)
    expect(attachFailure).toMatchObject({ status: 'unavailable', diagnostic: { class: 'session-attach' } })
    expect(store.pointer?.sessionId).toBe(first.sessionId)
    expect(ctx.agents.get(first.sessionId)).toBe(agent)
    expect(archived.some(sessionId => sessionId !== first.sessionId)).toBe(true)
    workspaces.set(workspaceId, { id: workspaceId, path: checkout, attachSession: attach })

    // Pointer failure: the successor is archived and the old generation stays current.
    store.writeFailure = new Error('pointer store unavailable (test seam)')
    const pointerFailure = await runtime.newConversation(first.sessionId)
    expect(pointerFailure).toMatchObject({ status: 'unavailable', diagnostic: { class: 'pointer-persist' } })
    expect(store.pointer?.sessionId).toBe(first.sessionId)
    expect(ctx.agents.get(first.sessionId)).toBe(agent)
    store.writeFailure = undefined

    // Creation failure leaves no pointer and no live manager Agent.
    const freshStore = new MemoryPointerStore()
    presets.failingMount = true
    const broken = runtimeFor(ctx, { store: freshStore, root, workspace: { workspaceId, path: checkout } })
    const createFailure = await broken.open()
    expect(createFailure).toMatchObject({ status: 'unavailable', diagnostic: { class: 'preset-composition' } })
    expect(freshStore.pointer).toBeUndefined()
    expect(managerAgents(ctx)).toHaveLength(1)
    presets.failingMount = false
    await broken.dispose()
    await runtime.dispose()
  })

  it('leaves an unpublished candidate denied when disposal and rollback archival both fail', async () => {
    const { ctx, workspaceId, checkout, root, archived, archiveFailures } = await realHarness()
    const store = new MemoryPointerStore()
    const runtime = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const first = await runtime.open()
    if (first.status !== 'ready') throw new Error('expected the current manager Session')
    const current = ctx.agents.get(first.sessionId)!
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    let candidate: AgentHandle | undefined
    let restoreStop: (() => void) | undefined
    let archiveFailuresAtStop: number | undefined
    vi.spyOn(ctx.agents, 'create').mockImplementationOnce(async options => {
      const handle = await originalCreate(options)
      candidate = handle
      const stop = vi.spyOn(handle, 'dispose').mockImplementation(async () => {
        archiveFailuresAtStop = archiveFailures.remaining
        throw new Error('candidate disposal failed (test seam)')
      })
      restoreStop = () => stop.mockRestore()
      return handle
    })
    store.writeFailure = new Error('pointer store unavailable (test seam)')
    archiveFailures.remaining = 1
    try {
      const result = await runtime.newConversation(first.sessionId)
      if (candidate === undefined) throw new Error('expected a manager candidate handle')
      expect(result).toMatchObject({
        status: 'unavailable',
        diagnostic: { class: 'pointer-persist', detail: store.writeFailure.message, sessionId: candidate.agent.id },
      })
      expect(archiveFailuresAtStop).toBe(1)
      expect(archiveFailures.remaining).toBe(0)
      expect(archived).not.toContain(candidate.agent.id)
      expect(store.pointer?.sessionId).toBe(first.sessionId)
      expect(ctx.agents.get(candidate.agent.id)).toBe(candidate.agent)
      const denied = await execute(ctx, candidate.agent, 'manager_fixture', 'manager-unpublished-denied')
      expect(denied).toMatchObject({ isError: true, error: { message: expect.stringContaining('not authorized') } })
      expect(await execute(ctx, current, 'manager_fixture', 'manager-still-current')).toMatchObject({ isError: false })
    } finally {
      restoreStop?.()
      await candidate?.dispose()
      await runtime.dispose()
    }
  })

  it('keeps a resumed Session when resume or attach fails and never archives the registered pointer', async () => {
    const { ctx, workspaceId, checkout, root, workspaces } = await realHarness()
    const store = new MemoryPointerStore()
    const first = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const opened = await first.open()
    if (opened.status !== 'ready') throw new Error('expected a ready manager Session')
    await first.dispose()

    const resumeFailure = runtimeFor(ctx, {
      store,
      root,
      workspace: { workspaceId, path: checkout },
      reader: { read: async () => ({ ok: false, failure: { kind: 'corrupt', sessionId: opened.sessionId, detail: 'bad log' } }) },
    })
    const failed = await resumeFailure.open()
    expect(failed).toMatchObject({ status: 'unavailable', diagnostic: { class: 'session-unreadable' } })
    expect(store.pointer?.sessionId).toBe(opened.sessionId)
    expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(opened.sessionId)
    await resumeFailure.dispose()

    const attach = workspaces.get(workspaceId)!.attachSession
    workspaces.set(workspaceId, {
      id: workspaceId,
      path: checkout,
      attachSession: async () => { throw new Error('attach refused for registered manager') },
    })
    const attachFailure = runtimeFor(ctx, {
      store,
      root,
      workspace: { workspaceId, path: checkout },
      reader: new StoredSessionReader(ctx),
    })
    const failedAttach = await attachFailure.open()
    expect(failedAttach).toMatchObject({ status: 'unavailable', diagnostic: { class: 'session-attach' } })
    expect(store.pointer?.sessionId).toBe(opened.sessionId)
    expect(ctx.agents.get(opened.sessionId)).toBeUndefined()
    expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(opened.sessionId)
    await attachFailure.dispose()
    workspaces.set(workspaceId, { id: workspaceId, path: checkout, attachSession: attach })

    const resumed = runtimeFor(ctx, {
      store,
      root,
      workspace: { workspaceId, path: checkout },
      reader: new StoredSessionReader(ctx),
    })
    const restored = await resumed.preRestore()
    expect(restored).toMatchObject({ status: 'ready', sessionId: opened.sessionId, workspaceId })
    const agent = ctx.agents.get(opened.sessionId)
    expect(agent).toBeDefined()
    // The resume commit saw the logged sandbox mode and did not append a second event.
    expect(agent!.session.ownEvents().filter(event => event.type === 'sandbox/mode')).toHaveLength(1)
    await resumed.dispose()
  })

  it('archiving the current Session denies its tools immediately and the next open replaces it', async () => {
    const { ctx, workspaceId, checkout, root } = await realHarness()
    const disposeWorking = ctx.tools.register(defineContentToolFixture({
      name: 'working_directory', description: 'directory fixture', parameters: {},
      execute: async () => [{ type: 'text', text: 'directory' }],
    }))
    onTestFinished(async () => { disposeWorking() })
    const store = new MemoryPointerStore()
    const runtime = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const opened = await runtime.open()
    if (opened.status !== 'ready') throw new Error('expected a ready manager Session')
    const agent = ctx.agents.get(opened.sessionId)!
    expect(await execute(ctx, agent, 'manager_fixture', 'manager-before-archive')).toMatchObject({ isError: false })

    await ctx.workspaceRegistry.archiveSession(opened.sessionId, { stopActivity: true })
    const denied = await execute(ctx, agent, 'manager_fixture', 'manager-after-archive')
    expect(denied.isError).toBe(true)
    if (denied.isError) expect(denied.error.message).toContain('not authorized')

    const replaced = await runtime.open()
    expect(replaced.status).toBe('ready')
    if (replaced.status === 'ready') expect(replaced.sessionId).not.toBe(opened.sessionId)
    await runtime.dispose()
  })

  it('mounts only the manager surface: preset tools and working_directory execute, foreign and late tools do not', async () => {
    const { ctx, workspaceId, checkout, root } = await realHarness()
    const disposeWorking = ctx.tools.register(defineContentToolFixture({
      name: 'working_directory', description: 'directory fixture', parameters: {},
      execute: async () => [{ type: 'text', text: 'directory' }],
    }))
    const disposeForeign = ctx.tools.register(defineContentToolFixture({
      name: 'foreign_global', description: 'foreign fixture', parameters: {},
      execute: async () => [{ type: 'text', text: 'foreign' }],
    }))
    onTestFinished(async () => { disposeWorking(); disposeForeign() })
    const late = vi.fn(async () => [{ type: 'text' as const, text: 'late' }])
    const install = ctx.on('agent/created', ({ agent }) => {
      if (ctx.agentPresets.composedPreset(agent.ctx) !== 'team-manager') return undefined
      agent.ctx.tools.register(defineContentToolFixture({
        name: 'late_manager_tool', description: 'late fixture', parameters: {}, execute: late,
      }))
      return undefined
    })
    onTestFinished(async () => { install() })

    const store = new MemoryPointerStore()
    const runtime = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const opened = await runtime.open()
    if (opened.status !== 'ready') throw new Error('expected a ready manager Session')
    const agent = ctx.agents.get(opened.sessionId)!
    // Own-scope registrations stay in the declaration surface (restriction
    // only masks inherited tools), so the late row is visible and the guard is
    // what denies it. The Team surface is the shipped manager subset — the two
    // read-only tools plus the seven manager write tools, and no tool from the
    // Member preset — because the model's visible list is read from this
    // scope's own schemas.
    expect(toolNames(ctx, agent)).toEqual(['manager_fixture', 'working_directory', 'late_manager_tool', 'skill', 'team_overview', 'team_models',
      'member_create', 'project_create', 'project_owner', 'project_update', 'member_update', 'member_state', 'member_workspace'].sort())
    expect(toolNames(ctx, agent)).not.toContain('foreign_global')
    for (const writeTool of ['team_inbox', 'team_attention', 'team_thread', 'team_dm', 'team_message', 'team_task', 'team_view', 'team_subscription', 'team_reminder', 'team_worker']) {
      expect(toolNames(ctx, agent)).not.toContain(writeTool)
    }
    expect(await execute(ctx, agent, 'working_directory', 'manager-working-directory')).toMatchObject({ isError: false })
    let nested: Awaited<ReturnType<typeof executeToolFixture>> | undefined
    const nestedHook = ctx.on('tools/pre-execute', async (execution, next) => {
      if (execution.agent === agent && execution.name === 'manager_fixture' && nested === undefined) {
        nested = await executeToolFixture(ctx, {
          signal: new AbortController().signal,
          agent,
          name: 'late_manager_tool',
          callId: ToolCallId('manager-late-nested'),
          arguments: {},
          parent: execution.token,
        })
      }
      return next()
    })
    onTestFinished(async () => { nestedHook() })
    expect(await execute(ctx, agent, 'manager_fixture', 'manager-preset-tool')).toMatchObject({ isError: false })
    expect(nested?.isError).toBe(true)
    const foreign = await execute(ctx, agent, 'foreign_global', 'manager-foreign')
    expect(foreign.isError).toBe(true)
    if (foreign.isError) expect(foreign.error.message).toContain('not declared')
    const lateResult = await execute(ctx, agent, 'late_manager_tool', 'manager-late')
    expect(lateResult.isError).toBe(true)
    expect(late).not.toHaveBeenCalled()
    await runtime.dispose()
  })

  it('rejects a replaced own-scope definition and a lost composition', async () => {
    const { ctx, workspaceId, checkout, root, presets } = await realHarness()
    const store = new MemoryPointerStore()
    const runtime = runtimeFor(ctx, { store, root, workspace: { workspaceId, path: checkout } })
    const opened = await runtime.open()
    if (opened.status !== 'ready') throw new Error('expected a ready manager Session')
    const agent = ctx.agents.get(opened.sessionId)!
    agent.ctx.tools.register(defineContentToolFixture({
      name: 'manager_fixture', description: 'replacement', parameters: {},
      execute: async () => [{ type: 'text', text: 'replacement' }],
    }))
    const replaced = await execute(ctx, agent, 'manager_fixture', 'manager-replaced')
    expect(replaced.isError).toBe(true)
    if (replaced.isError) expect(replaced.error.message).toContain('replaced')

    presets.orphaned.add(agent.ctx)
    const orphaned = await execute(ctx, agent, 'manager_fixture', 'manager-orphaned')
    expect(orphaned.isError).toBe(true)
    if (orphaned.isError) expect(orphaned.error.message).toContain('not authorized')
    await runtime.dispose()
  })

  it('reports no-workspace without creating a Session', async () => {
    const { ctx, workspaceController, workspaces } = await realHarness()
    workspaceController.initializeDefault = async () => undefined
    workspaces.clear()
    const result = await ctx.agentTeam.openManagerSession({})
    expect(result).toEqual({ status: 'no-workspace' })
    expect(managerAgents(ctx)).toHaveLength(0)
  })

  it('rejects team-manager and unknown presets before model validation or a ledger write', async () => {
    const { ctx, workspaceId } = await realHarness()
    for (const presetId of ['team-manager', 'unknown-preset']) {
      await expect(ctx.agentTeam.addMember({
        requestId: requestId(`manager-gate-${presetId}`),
        workspaceId,
        handle: 'manager-gate',
        description: '',
        presetId,
        projectRefs: [],
        model: { provider: 'not-a-route', model: 'not-a-route' },
      })).rejects.toThrow("only the 'team-member' preset")
    }
    expect(ctx.agentTeam.members()).toEqual([])
  })
})
