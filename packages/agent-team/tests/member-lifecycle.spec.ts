import { changeBaseline, nextChange } from './helpers/change-stream.ts'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, basename, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
// Slow CI machines (windows lane) can stretch multi-generation rollover
// chains past the default per-test budget. Every test here boots a real
// Host harness and waits on asynchronous session transitions, so both this
// per-test budget and the waitFor deadline below (kept equal) need headroom.
vi.setConfig({ testTimeout: 60_000 })

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresetPlugin from '@deepseek-ai/dsh-agent-preset'
import AgentPresetRegistry, { type AgentPreset, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime, { LlmError, ToolCallId, createToolResultMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { AgentTeamLedger } from '../src/ledger.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID, teamPresetScopeMismatchMessage } from '../src/index.ts'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { isAcceptanceNotice } from '../src/context-projection.ts'
import { ACCEPTANCE_COMPACT_TOKENS } from '../src/acceptance-context.ts'
import { MEMBER_COMPACT_TOKENS } from '../src/member-compaction.ts'
import { RECOVERY_DELAY_MS } from '../src/recovery.ts'
import type { AgentTeamProjectRef, AgentTeamClaimRef, AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'

const cleanups: Array<() => Promise<void>> = []
const originalDshHome = process.env.DSH_HOME
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
/** The ENOENT shape the JSONL backend raises when a walk hits a win32 staging directory mid-rename. */
const persistenceRaceError = (): Error =>
  Object.assign(new Error("scandir ENOENT: transient win32 staging directory raced the walk (test seam)"), { code: 'ENOENT' })

const rmFault = vi.hoisted(() => ({ match: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: ((path: import('node:fs').PathLike, options?: import('node:fs').RmOptions): Promise<void> => {
      if (rmFault.match.length > 0 && typeof path === 'string' && path.includes(rmFault.match)) {
        return Promise.reject(Object.assign(new Error(`private memory removal failed (test seam): ${path}`), { code: 'EACCES' }))
      }
      return actual.rm(path, options)
    }) as typeof actual.rm,
  }
})

afterEach(async () => {
  rmFault.match = ''
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

class EmptyAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 320_000 } }) }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield* [] }
}

class ScriptedAdapter extends EmptyAdapter {
  readonly requests: GenerateOptions[] = []
  readonly requestSessions: Array<string | undefined> = []
  private readonly responses: StreamChunk[][] = []
  resolveModelWindow: (model: string) => number = () => 320_000

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.resolveModelWindow(model) } })
  }

  enqueue(response: StreamChunk[]): void {
    this.responses.push(response)
  }

  failWith: unknown = undefined

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.requestSessions.push((options as { sessionId?: string }).sessionId)
    if (this.failWith !== undefined) throw this.failWith
    const response = this.responses.shift()
    if (response === undefined) throw new Error('ScriptedAdapter response queue is empty')
    for (const chunk of response) yield chunk
  }
}

class GatedAdapter extends ScriptedAdapter {
  readonly started = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<void>()
  private calls = 0

  constructor(private readonly gateAt = 1) { super() }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.calls !== this.gateAt) {
      yield* super.stream(options)
      return
    }
    this.requests.push(options)
    this.started.resolve()
    // Honor the abort contract every real adapter implements: disposal
    // cancels the phase signal, and the gate must end with it instead of
    // pinning the disposer on a promise nobody resolves.
    const aborted = new Promise<'abort'>(resolve => {
      const signal = options.signal
      if (signal === undefined) return
      if (signal.aborted) { resolve('abort'); return }
      signal.addEventListener('abort', () => resolve('abort'), { once: true })
    })
    const outcome = await Promise.race([this.release.promise.then(() => 'release' as const), aborted])
    if (outcome === 'abort') return
    for (const chunk of textResponse('Initial work finished.')) yield chunk
  }
}

function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const id = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * The swap commits its new binding before it archives the retired Session, so
 * `members()` reports the new binding while the archive is still in flight.
 */
function waitForArchive(ctx: Context, sessionId: SessionId): Promise<void> {
  return vi.waitFor(() => {
    if (!ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) throw new Error(`Session '${sessionId}' is not archived yet`)
  }, { timeout: 20_000 })
}

function waitForIdle(ctx: Context, agent: NonNullable<ReturnType<Context['agents']['get']>>): Promise<void> {
  if (agent.status === 'idle') return Promise.resolve()
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

/** Every acceptance reminder this Session's log holds, in arrival order. */
function acceptanceReminders(agent: NonNullable<ReturnType<Context['agents']['get']>>): string[] {
  return agent.session.ownEvents().flatMap(event => event.type === 'user/message' && isAcceptanceNotice(event.data)
    ? [event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
    : [])
}

type PersistenceBackend = 'jsonl'

class TestablePresets extends AgentPresetRegistry {
  readonly orphaned = new WeakSet<Context>()
  failingMount = false

  override composedPreset(agentCtx: Context): string | undefined {
    if (this.orphaned.has(agentCtx)) return undefined
    return super.composedPreset(agentCtx)
  }

  override async mount(agentCtx: Context, id?: string): Promise<AgentPreset> {
    if (this.failingMount) throw new Error(`preset '${id ?? 'default'}' failed to load (test seam)`)
    return super.mount(agentCtx, id)
  }
}

async function realHarness(
  adapter: LlmAdapter = new EmptyAdapter(),
  persistenceBackend: PersistenceBackend = 'jsonl',
  reopen?: { readonly root: string },
  realCompaction = false,
): Promise<{
  readonly ctx: Context
  readonly workspaceId: WorkspaceId
  readonly root: string
  readonly checkout: string
  readonly workspaces: Map<WorkspaceId, { id: WorkspaceId; path: string; attachSession: () => Promise<void> }>
  readonly teamFiber: Awaited<ReturnType<Context['plugin']>>
  readonly archived: readonly SessionId[]
  /** One-shot failures for the workspace archive side effect. */
  readonly archiveFailures: { remaining: number }
  readonly presets: TestablePresets
  /** Writable fake meter pressure; tests drive the thresholds through it. */
  readonly pressureState: { usageTokens: number; bySession: Map<string, number>; failFor: Set<string> }
  /** Writable fake owned-jobs list; tests drive the rollover guard through it. */
  readonly jobsState: { jobs: Array<{ id: string; label: string; status: string; reported: boolean }> }
}> {
  const root = reopen?.root ?? await mkdtemp(join(tmpdir(), 'dsh-agent-team-member-'))
  const checkout = join(root, 'checkout')
  const persistence = join(root, 'sessions')
  if (reopen === undefined) await Promise.all([mkdir(checkout), mkdir(persistence)])
  process.env.DSH_HOME = join(root, 'dsh-home')
  // The preset's compaction row points at a real file with a file: URL, so
  // its health check and the `compaction` service are both genuine.
  const compactionStub = join(root, 'compaction-stub.mjs')
  await writeFile(compactionStub, realCompaction
    ? `export { default } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../src/member-compaction-engine.ts')).href)}`
    : [
    "export const name = 'test-compaction'",
    "export function apply(scope) { scope.provide('compaction', { compactNow: async () => null, compactIfNeeded: async () => null }) }",
    '',
  ].join('\n'))
  // The team-member definition as one declarative row, the same shape the
  // shipped cordis.patch.yml declares; bare internal loader names resolve
  // through the self-linked node_modules.
  const teamMemberPlugins: PresetDefinition['plugins'] = [
    { id: 'member-context', name: '@contexera/dsh-agent-team/member-context' },
    { id: 'member-time-context', name: '@contexera/dsh-agent-team/member-time-context' },
    { id: 'team-tools', name: '@contexera/dsh-agent-team/tools' },
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
      { id: 'compaction-stub', name: pathToFileURL(compactionStub).href },
    ] },
  ]

  const ctx = new Context()
  // rc.1: preset health resolves package rows by walking node_modules above
  // ctx.baseUrl — point at this repository, where the harness and bundle
  // packages are linked, as a real profile install would.
  ctx.baseUrl = pathToFileURL(resolve(import.meta.dirname, '../../../')).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  const pressureState = { usageTokens: 0, bySession: new Map<string, number>(), failFor: new Set<string>() }
  ctx.provide('tokenMeter', { estimateMessage: () => 0, measure: (session: { id: string }): { totalTokens: number; nodes: { seq: number; tokens: number }[] } => {
    if (pressureState.failFor.has(session.id)) throw new Error('meter unavailable for this session')
    // One node at the head of the surface, so any retained prefix through an
    // anchor prices at the whole source's measured size - the shape the real
    // meter reports, and what the engine prices a return off.
    const totalTokens = pressureState.bySession.get(session.id) ?? pressureState.usageTokens
    return { totalTokens, nodes: [{ seq: 0, tokens: totalTokens }] }
  } })
  // The generation swap's job guard reads the member-scoped jobs registry; a
  // writable fake keeps the service present.
  const jobsState: { jobs: Array<{ id: string; label: string; status: string; reported: boolean }> } = { jobs: [] }
  ctx.provide('jobs', { list: () => jobsState.jobs })
  if (persistenceBackend === 'jsonl') await ctx.plugin(JsonlSessionPersistence, { root: persistence })
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(TestablePresets, { default: 'team-member' })
  await ctx.plugin(AgentPresetPlugin, { id: 'team-member', plugins: teamMemberPlugins })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const workspaceId = WorkspaceId('workspace:member-test')
  const archived: SessionId[] = []
  const archiveFailures = { remaining: 0 }
  const workspaces = new Map([[workspaceId, { id: workspaceId, path: checkout, attachSession: async () => {} }]])
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => workspaces.get(id),
    list: () => [],
    get archivedSessionIds(): readonly SessionId[] { return archived },
    archiveSession: async (sessionId: SessionId) => {
      if (archived.includes(sessionId)) return
      if (archiveFailures.remaining > 0) {
        archiveFailures.remaining -= 1
        throw new Error('workspace archive failed (test seam)')
      }
      archived.push(sessionId)
    },
  })
  const teamFiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await ctx.fiber.dispose(); await facility.closeAll(); await rm(root, { recursive: true, force: true }) })
  return { ctx, workspaceId, root, checkout, workspaces, teamFiber, archived, archiveFailures, presets: ctx.agentPresets as TestablePresets, pressureState, jobsState }
}

describe('Agent Team Member lifecycle', () => {
  it('works in a joined Workspace through the existing live Session and withdraws without disposing it', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, checkout, root, workspaces, archived } = await realHarness(adapter)
    const otherId = WorkspaceId('workspace:joined')
    workspaces.set(otherId, { id: otherId, path: join(root, 'other-checkout'), attachSession: async () => {} })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('global-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    expect(added.status.availability, JSON.stringify(added.status)).toBe('active')
    const memberId = added.status.member.memberId
    const agent = ctx.agents.get(added.status.member.sessionId)!
    await ctx.agentTeam.joinWorkspace({ requestId: requestId('global-join'), workspaceId: otherId, memberId })
    expect(ctx.agentTeam.membersForClient({ workspaceId: otherId }).map(status => status.member.memberId)).toEqual([memberId])
    adapter.enqueue(textResponse('Acknowledged the participation change.'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const noticeRequest = JSON.stringify(adapter.requests[0]!.messages)
    expect(noticeRequest).toContain('Team participation changed')
    expect(noticeRequest).toContain(otherId)
    expect(noticeRequest).toContain('Your Session and cwd have not moved')
    for (const [name, args] of [
      ['team_view', {}],
      ['team_thread', { action: 'read', threadRef: 'thread:missing' }],
      ['team_attention', { action: 'status', threadRef: 'thread:missing' }],
      ['team_message', { action: 'start', projectRef: 'project:missing', body: 'Do not route implicitly' }],
      ['team_dm', { memberRef: 'member:missing', body: 'Do not route implicitly' }],
      ['team_task', { action: 'list', taskRef: 'task:missing' }],
    ] as const) {
      const omitted = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`global-missing-${name}`),
        name, arguments: args, agent })
      expect(omitted.isError).toBe(true)
      if (!omitted.isError) throw new Error('Expected an explicit Workspace requirement')
      expect(omitted.error.message).toContain('workspace is required')
      expect(omitted.error.message).toContain(workspaceId)
      expect(omitted.error.message).toContain(otherId)
    }
    const project = await ctx.agentTeam.createProject({ requestId: requestId('global-project'), workspaceId: otherId,
      name: 'work', description: '', memberIds: [memberId] })
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('global-owner'), workspaceId: otherId, projectRef: project.project.projectRef, memberId })
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('global-start'),
      name: 'team_message', arguments: { action: 'start', workspace: otherId, projectRef: project.project.projectRef, body: 'Working in joined checkout' }, agent })
    expect(result.isError, result.isError ? result.error.message : '').toBe(false)
    expect(ctx.agentTeam.view({ workspaceId: otherId }).items[0]?.message.body).toBe('Working in joined checkout')
    const legacyRef = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('global-start-channel-ref'),
      name: 'team_message', arguments: { action: 'start', workspace: otherId, projectRef: project.project.projectRef.replace('project:', 'channel:'), body: 'Cited by its Channel ref' }, agent })
    expect(legacyRef.isError, legacyRef.isError ? legacyRef.error.message : 'Agents still cite the channel: refs older history shows').toBe(false)
    expect(agent.session.header.cwd).toBe(checkout)
    expect(ctx.agents.get(added.status.member.sessionId)).toBe(agent)
    await ctx.agentTeam.leaveWorkspace({ requestId: requestId('global-leave'), workspaceId: otherId, memberId })
    expect(ctx.agentTeam.membersForClient({ workspaceId: otherId })).toEqual([])
    expect(ctx.agents.get(added.status.member.sessionId)).toBe(agent)
    expect(ctx.agentTeam.memberForAgent(agent)).toEqual(added.status.member)
    expect(archived).toEqual([])
    expect(() => ctx.agentTeam.viewForAgent(agent, { workspaceId: otherId })).toThrow(/another Workspace/)
    ctx.agentTeam.validateLedger()
  })

  it('speaks, reads and starts through the Main stream tools', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('main-project'), workspaceId, name: 'work', description: '', memberIds: [] })
    const projectRef = project.project.projectRef
    const added = await ctx.agentTeam.addMember({ requestId: requestId('main-add'), workspaceId, handle: 'builder', description: '', presetId: 'team-member', projectRefs: [projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const run = async (name: string, args: Record<string, unknown>) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`main-${name}-${JSON.stringify(args)}`), name, arguments: args, agent })
      return result.isError ? { error: result.error.message } : { text: JSON.stringify(result) }
    }

    await ctx.agentTeam.postMainMessage({ requestId: requestId('main-human'), workspaceId, projectRef, body: 'Plain note from the Human' })
    expect(await run('team_thread', { action: 'read', projectRef })).toMatchObject({ text: expect.stringContaining('Plain note from the Human') })
    expect(await run('team_message', { action: 'post', projectRef, body: 'Agent speaking' })).toMatchObject({ text: expect.stringContaining('Main stream message posted') })
    // Not an owner yet: starting a Thread points back to the Main stream.
    expect(await run('team_message', { action: 'start', projectRef, kind: 'discussion', body: 'x' })).toMatchObject({ error: expect.stringMatching(/project_owner_required.*team_message post/s) })
    // The removed asTask spelling is refused with the route to kind, never dropped: a silent drop would commit a
    // discussion while the model believes it started a Task.
    expect(await run('team_message', { action: 'start', projectRef, asTask: true, body: 'x' })).toMatchObject({ error: expect.stringMatching(/start does not accept asTask.*kind: 'task'/s) })

    adapter.enqueue(textResponse('Noted my new ownership.'))
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('main-owner'), workspaceId, projectRef, memberId: added.status.member.memberId })
    await agent.whenIdle()
    expect(await run('team_message', { action: 'start', projectRef, kind: 'task', body: 'Build the importer' })).toMatchObject({ text: expect.stringContaining('Thread created') })
    expect(ctx.agentTeam.mainStreamHistory({ workspaceId, projectRef }).entries.map(entry => entry.kind)).toEqual(['message', 'message', 'activity', 'thread-card'])
    ctx.agentTeam.validateLedger()
  })

  it('accepts a unique Workspace id abbreviation and points at the fix when the abbreviation is not unique', async () => {
    const { ctx, workspaces } = await realHarness()
    const homeId = WorkspaceId('workspace:1a2b3c4d-0000-4000-8000-000000000001')
    const otherId = WorkspaceId('workspace:1a2b3c4d-0000-4000-8000-000000000002')
    workspaces.set(homeId, { id: homeId, path: '/tmp/other-checkout', attachSession: async () => {} })
    workspaces.set(otherId, { id: otherId, path: '/tmp/other-checkout', attachSession: async () => {} })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('abbrev-add'), workspaceId: homeId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    await ctx.agentTeam.joinWorkspace({ requestId: requestId('abbrev-join'), workspaceId: otherId, memberId: added.status.member.memberId })
    const call = (name: string, args: unknown) => ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId(`abbrev-${name}-${JSON.stringify(args)}`), name, arguments: args, agent })

    const abbreviated = await call('team_view', { workspace: 'workspace:1a2b3c4d-0000-4000-8000-000000000001' })
    expect(abbreviated.isError, abbreviated.isError ? abbreviated.error.message : '').toBe(false)

    const ambiguous = await call('team_view', { workspace: 'workspace:1a2b3c4d' })
    expect(ambiguous.isError).toBe(true)
    if (!ambiguous.isError) throw new Error('expected an ambiguous-Workspace rejection')
    expect(ambiguous.error.message).toContain(homeId)
    expect(ambiguous.error.message).toContain(otherId)
    expect(ambiguous.error.message).toMatch(/longer prefix|full Workspace id/i)
    expect(ambiguous.error.message.match(/matches/g) ?? []).toHaveLength(1)

    const unknown = await call('team_view', { workspace: 'workspace:9f8e7d6c-0000-4000-8000-000000000009' })
    expect(unknown.isError).toBe(true)
    if (!unknown.isError) throw new Error('expected an unknown-Workspace rejection')
    expect(unknown.error.message).toContain('Not participating in Workspace')
    expect(unknown.error.message).toContain(homeId)
  })

  it('wakes an idle accountable once for a private review reminder and consumes it on the Task read', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-25T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('reminder-project'), workspaceId, name: 'engineering', description: '' })
      const projectRef = project.project.projectRef
      const added = await ctx.agentTeam.addMember({ requestId: requestId('reminder-add'), workspaceId, handle: 'builder', description: '', presetId: 'team-member', projectRefs: [projectRef] })
      const memberId = added.status.member.memberId
      const agent = ctx.agents.get(added.status.member.sessionId)!
      const executor = await ctx.agentTeam.addMember({ requestId: requestId('reminder-executor-add'), workspaceId, handle: 'executor', description: '', presetId: 'team-member', projectRefs: [projectRef] })
      const executorAgent = ctx.agents.get(executor.status.member.sessionId)!
      await ctx.agentTeam.addProjectOwner({ requestId: requestId('reminder-owner'), workspaceId, projectRef, memberId })
      const started = await ctx.agentTeam.startThread({ requestId: requestId('reminder-task'), workspaceId, projectRef, kind: 'task', body: 'Review this work', accountable: memberId })
      if (started.kind !== 'committed' || started.task === undefined) throw new Error('Task did not start')
      const read = await ctx.agentTeam.readThreadForAgent(executorAgent, { requestId: requestId('reminder-claim-read'), workspaceId, taskRef: started.task.taskRef })
      const claimed = await ctx.agentTeam.changeClaimForAgent(executorAgent, { requestId: requestId('reminder-claim'), workspaceId, taskRef: started.task.taskRef,
        action: 'claim', direction: 'implementation', baseRevision: read.thread.revision })
      if (claimed.kind !== 'committed') throw new Error('Claim did not start')
      const doneRead = await ctx.agentTeam.readThreadForAgent(executorAgent, { requestId: requestId('reminder-done-read'), workspaceId, taskRef: started.task.taskRef })
      const done = await ctx.agentTeam.changeClaimForAgent(executorAgent, { requestId: requestId('reminder-done'), workspaceId, taskRef: started.task.taskRef,
        action: 'done', claimRef: claimed.claim.claimRef, baseRevision: doneRead.thread.revision })
      if (done.kind !== 'committed') throw new Error('Claim did not finish')
      await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('reminder-owner-responsibility'), workspaceId, taskRef: started.task.taskRef })
      await agent.whenIdle()
      await vi.advanceTimersByTimeAsync(31 * 60_000)
      expect(Date.now() - Date.parse(done.receipt.occurredAt)).toBeGreaterThanOrEqual(31 * 60_000)
      adapter.enqueue(textResponse('Reviewed the reminder.'))
      await ctx.agentTeam.inboxForAgent(agent, { workspaceId })
      const reminderOperation = await vi.waitFor(() => {
        const found = ctx.agentTeam['ledger']!['state'].ordered.find(operation => operation.kind === 'team/reminder-raised')
        if (found === undefined) throw new Error('the event evaluation has not committed the reminder')
        return found
      }, { timeout: 10_000 })
      expect(reminderOperation.kind).toBe('team/reminder-raised')
      const request = await vi.waitFor(() => {
        const found = adapter.requests.find(candidate => JSON.stringify(candidate.messages).includes('Team Task reminder'))
        if (found === undefined) throw new Error('the private reminder did not wake the accountable Agent')
        return found
      }, { timeout: 10_000 })
      expect(JSON.stringify(request.messages)).toContain('waiting for acceptance')
      expect(JSON.stringify(request.messages)).toContain(started.task.taskRef)
      await agent.whenIdle()
      const inbox = ctx.agentTeam.inboxForAgent(agent, { workspaceId })
      expect(inbox.items.find(item => item.task?.taskRef === started.task!.taskRef)?.reminders).toHaveLength(1)
      const before = ctx.agentTeam.threadHistory({ workspaceId, taskRef: started.task.taskRef })
      const consumed = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('reminder-consume'), workspaceId, taskRef: started.task.taskRef })
      expect(consumed.reminders).toHaveLength(1)
      expect(ctx.agentTeam.threadHistory({ workspaceId, taskRef: started.task.taskRef }).facts).toEqual(before.facts)
      expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items.find(item => item.task?.taskRef === started.task!.taskRef)?.reminders ?? []).toEqual([])
      await ctx.agentTeam.inboxForAgent(agent, { workspaceId })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).items.find(item => item.task?.taskRef === started.task!.taskRef)?.reminders ?? []).toEqual([])
      ctx.agentTeam.validateLedger()
    } finally { vi.useRealTimers() }
  })

  it('every argument-shape rejection names the next action', async () => {
    const { ctx, workspaceId } = await realHarness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('shape-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('shape-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ requestId: requestId('shape-task'), workspaceId, projectRef: project.project.projectRef, body: 'Shape the argument contract', recipients: [added.status.member.memberId], kind: 'task' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const threadRef = started.thread!.threadRef
    const taskRef = started.task!.taskRef
    const rejected = async (name: string, args: unknown): Promise<string> => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`shape-${name}-${JSON.stringify(args)}`), name, arguments: args, agent })
      expect(result.isError, `${name} ${JSON.stringify(args)} unexpectedly succeeded`).toBe(true)
      if (!result.isError) throw new Error('expected a rejection')
      return result.error.message
    }

    // read drains unread and cannot page: the fix is the history action. A read ignores a
    // page size instead of refusing, because a model that fills every optional slot reaches
    // for one and a refusal it cannot act on only bought an identical retry.
    const historyArgs = await rejected('team_thread', { action: 'message', threadRef, messageRef: 'message:23011', beforeSequence: 1, limit: 5 })
    expect(historyArgs).toContain('action: history')
    expect(historyArgs).toMatch(/cannot page/i)
    const paged = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('shape-read-page'), name: 'team_thread',
      arguments: { action: 'read', threadRef, beforeSequence: 1, limit: 5 }, agent })
    expect(paged.isError, `read with a page size was refused: ${paged.isError ? paged.error.message : ''}`).toBe(false)
    for (const action of ['read', 'history'] as const) {
      const strayRef = await rejected('team_thread', { action, threadRef, messageRef: 'message:23011' })
      expect(strayRef, `${action} silently dropped messageRef`).toContain('does not accept messageRef')
      expect(strayRef).toContain('action: message')
    }
    const owned = await rejected('team_thread', { action: 'message', threadRef })
    expect(owned).toContain('messageRef')
    expect(owned).not.toContain('does not accept')
    expect(await rejected('team_message', { action: 'reply', threadRef, body: 'no token' })).toMatch(/team_thread read/)
    expect(await rejected('team_task', { action: 'done', taskRef, claimRef: 'claim:missing' })).toMatch(/team_thread read/)
    expect(await rejected('team_task', { action: 'done', baseRevision: 1, claimRef: 'claim:missing' })).toContain('taskRef')
    expect(await rejected('team_task', { action: 'list' })).toContain('taskRef')
    expect(await rejected('team_task', { action: 'claim', taskRef, baseRevision: 1, direction: 'd', claimRef: 'claim:missing' })).toContain('direction')
    expect(await rejected('team_task', { action: 'done', taskRef, baseRevision: 1, direction: 'd' })).toContain('claimRef')
    expect(await rejected('team_message', { action: 'reply', threadRef, baseRevision: 1, replyToMessageRef: 'message:23011', body: 'bad target' })).toContain('recorded Message')
    expect(await rejected('team_message', { action: 'reply', threadRef, baseRevision: 1, attachments: ['relative/shot.png'], body: 'bad attachment' })).toMatch(/absolute|does not exist/)
    expect(await rejected('team_message', { action: 'start', body: 'no project' })).toContain('projectRef')
    expect(await rejected('team_dm', { body: 'no recipient' })).toContain('memberRef')

    const peer = await ctx.agentTeam.addMember({ requestId: requestId('shape-peer'), workspaceId, handle: 'peer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const peerAgent = ctx.agents.get(peer.status.member.sessionId)!
    const peerRead = await ctx.agentTeam.readThreadForAgent(peerAgent, { requestId: requestId('shape-peer-read'), workspaceId, threadRef })
    const peerClaim = await ctx.agentTeam.changeClaimForAgent(peerAgent, { requestId: requestId('shape-peer-claim'), workspaceId, taskRef, action: 'claim', baseRevision: peerRead.thread.revision, direction: 'Peer claim on this Task' })
    if (peerClaim.kind !== 'committed') throw new Error(`expected committed peer claim, received ${peerClaim.kind}`)
    const builderRead = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('shape-builder-read'), workspaceId, threadRef })
    const ownAttempt = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('shape-own-claim'), name: 'team_task', arguments: { action: 'done', taskRef, baseRevision: builderRead.thread.revision, claimRef: peerClaim.claim.claimRef }, agent })
    expect(ownAttempt.isError).toBe(true)
    if (!ownAttempt.isError) throw new Error('expected an ownership rejection')
    expect(ownAttempt.error.message).toContain('own Claim')
    expect(ownAttempt.error.message).toContain('team_task list')
  })

  it('archives a Member: session disposed and archived, private memory kept, claims released', async () => {
    const { ctx, workspaceId, archived } = await realHarness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('archive-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('archive-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const memberId = added.status.member.memberId
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')

    // Give the Member an active Claim so the release cleanup is observable
    // end-to-end.
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('archive-task'), workspaceId, projectRef: project.project.projectRef, body: 'Build the feature', recipients: [memberId] })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const live = ctx.agents.get(added.status.member.sessionId)!
    await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('archive-read'), workspaceId, taskRef: started.task!.taskRef })
    const claimed = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('archive-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', direction: 'implements the feature', baseRevision: started.thread.revision })
    if (claimed.kind !== 'committed') throw new Error(`expected committed claim, received ${claimed.kind}`)
    expect(claimed.task.status).toBe('in_progress')

    const result = await ctx.agentTeam.archiveMember({ requestId: requestId('archive'), memberId })
    expect(result.member.state).toBe('archived')
    expect(result.member.sessionId).toBe(added.status.member.sessionId)
    expect(result.releasedClaims).toEqual([expect.objectContaining({ owner: memberId, state: 'released' })])
    expect(result.removedAttention).toEqual([expect.objectContaining({ memberId, threadRef: started.task!.threadRef })])

    // Runtime effects: the live session is disposed and its Session archived
    // from grouping surfaces; private memory stays on disk.
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(archived).toContain(added.status.member.sessionId)
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()
    expect(ctx.agentTeam.members().find(status => status.member.memberId === memberId)).toMatchObject({ availability: 'archived', presence: 'unavailable' })

    // The released Claim drops the Task back to todo in the shared view.
    const view = ctx.agentTeam.view({ workspaceId })
    expect(view.tasks.find(task => task.taskRef === started.task!.taskRef)).toMatchObject({ status: 'todo' })
    expect(view.members).toEqual([])

    // Idempotent retry returns the same receipt; removal from archived stays
    // available as the data hygiene path and deletes the private namespace.
    const again = await ctx.agentTeam.archiveMember({ requestId: requestId('archive'), memberId })
    expect(again.receipt.operationId).toBe(result.receipt.operationId)
    const removed = await ctx.agentTeam.removeMember({ requestId: requestId('archive-remove'), memberId })
    expect(removed.member.state).toBe('inactive')
    await expect(access(added.status.member.privateMemoryPath)).rejects.toThrow()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('retries an archive after the post-commit Session archive fails', async () => {
    const { ctx, workspaceId, archived, archiveFailures } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('archive-retry-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    archiveFailures.remaining = 1

    await expect(ctx.agentTeam.archiveMember({ requestId: requestId('archive-retry'), memberId }))
      .rejects.toThrow('workspace archive failed')
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('archived')
    expect(archived).toEqual([])

    const retried = await ctx.agentTeam.archiveMember({ requestId: requestId('archive-retry'), memberId })
    expect(retried.member.state).toBe('archived')
    expect(archived).toEqual([added.status.member.sessionId])
  })

  it('converges an archive interrupted after its commit during startup', async () => {
    const { ctx, workspaceId, archived, archiveFailures, teamFiber } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('arch-boot-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')
    archiveFailures.remaining = 1

    // The commit landed and the disposal succeeded; only the hide half
    // failed, so the durable state already says archived while no effect
    // hid the Session from grouping surfaces.
    await expect(ctx.agentTeam.archiveMember({ requestId: requestId('arch-boot'), memberId }))
      .rejects.toThrow('workspace archive failed')
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('archived')
    expect(archived).toEqual([])
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()

    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    // Startup finishes the owed hide half from the durable state alone and
    // never activates the archived Member as an enabled one.
    expect(archived).toEqual([added.status.member.sessionId])
    const restored = ctx.agentTeam.members().find(item => item.member.memberId === memberId)
    expect(restored).toMatchObject({ availability: 'archived', presence: 'unavailable' })
    expect(restored?.member.sessionId).toBe(added.status.member.sessionId)
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()
    expect(ctx.agentTeam.view({ workspaceId }).members).toEqual([])
    expect(ctx.agentTeam.members().filter(item => item.member.memberId === memberId)).toHaveLength(1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('converges an archive whose Agent disposal failed during startup', async () => {
    const { ctx, workspaceId, archived, teamFiber } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('arch-dispose-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')
    const handle = ctx.agentTeam['handles'].get(memberId)!
    vi.spyOn(handle, 'dispose').mockRejectedValueOnce(new Error('agent disposal failed (test seam)'))

    // Durable state says archived while the generation is still live — the
    // window a caller that never retries would leave standing.
    await expect(ctx.agentTeam.archiveMember({ requestId: requestId('arch-dispose'), memberId }))
      .rejects.toThrow('agent disposal failed')
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('archived')
    expect(ctx.agents.get(added.status.member.sessionId)).toBeDefined()
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(true)

    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    expect(archived).toEqual([added.status.member.sessionId])
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()
    expect(ctx.agentTeam.members().filter(item => item.member.memberId === memberId)).toHaveLength(1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('finishes a removal whose private-memory cleanup failed when the Host restarts', async () => {
    const { ctx, workspaceId, archived, teamFiber } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('remove-fs-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    const memoryPath = added.status.member.privateMemoryPath
    await writeFile(join(memoryPath, 'notes', 'kept.md'), 'persistent note')
    rmFault.match = join('agent-team', 'members')

    await expect(ctx.agentTeam.removeMember({ requestId: requestId('remove-fs'), memberId }))
      .rejects.toThrow('failed to clean up removed Member')
    rmFault.match = ''
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('inactive')
    // The Session half of the cleanup already ran; the memory half is owed.
    expect(archived).toEqual([added.status.member.sessionId])
    await expect(access(join(memoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()

    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    await expect(access(memoryPath)).rejects.toThrow()
    expect(archived).toEqual([added.status.member.sessionId])
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('keeps a failing private-memory cleanup from failing startup and retries it at the next boot', async () => {
    const { ctx, workspaceId, archived, teamFiber } = await realHarness()
    const removed = await ctx.agentTeam.addMember({ requestId: requestId('boot-fs-remove'), workspaceId,
      handle: 'victim', description: '', presetId: 'team-member', projectRefs: [] })
    const keeper = await ctx.agentTeam.addMember({ requestId: requestId('boot-fs-keep'), workspaceId,
      handle: 'keeper', description: '', presetId: 'team-member', projectRefs: [] })
    await writeFile(join(removed.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')
    rmFault.match = join('agent-team', 'members')
    await expect(ctx.agentTeam.removeMember({ requestId: requestId('boot-fs'), memberId: removed.status.member.memberId }))
      .rejects.toThrow('failed to clean up removed Member')

    // Restart while the fault still stands: startup retries the owed
    // cleanup, fails again, and must neither take the Host down with it nor
    // cost the rest of the roster their activation.
    await teamFiber.dispose()
    const boot = await ctx.plugin(AgentTeam)
    expect(boot).toBeDefined()
    expect(ctx.agentTeam.members().find(item => item.member.memberId === removed.status.member.memberId)?.availability).toBe('inactive')
    expect(ctx.agentTeam.members().find(item => item.member.memberId === keeper.status.member.memberId)?.availability).toBe('active')
    await expect(access(removed.status.member.privateMemoryPath)).resolves.toBeUndefined()
    expect(archived).toEqual([removed.status.member.sessionId])

    // The fault clears like the failed call it stands for; the next startup
    // finishes what is still owed.
    rmFault.match = ''
    await boot.dispose()
    await ctx.plugin(AgentTeam)
    await expect(access(removed.status.member.privateMemoryPath)).rejects.toThrow()
    expect(archived).toEqual([removed.status.member.sessionId])
    expect(ctx.agentTeam.members().find(item => item.member.memberId === keeper.status.member.memberId)?.availability).toBe('active')
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('keeps a suspended Member suspended across startup and finishes a disposal-failed suspension on retry', async () => {
    const { ctx, workspaceId, archived, teamFiber } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('susp-boot-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')
    const handle = ctx.agentTeam['handles'].get(memberId)!
    vi.spyOn(handle, 'dispose').mockRejectedValueOnce(new Error('agent disposal failed (test seam)'))

    await expect(ctx.agentTeam.suspendMember({ requestId: requestId('susp-boot'), memberId }))
      .rejects.toThrow('agent disposal failed')
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('suspended')
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(true)

    const retried = await ctx.agentTeam.suspendMember({ requestId: requestId('susp-boot'), memberId })
    expect(retried.status.availability).toBe('suspended')
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    // Suspended keeps the Session: nothing archives it, memory stays.
    expect(archived).toEqual([])
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()

    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    const restored = ctx.agentTeam.members().find(item => item.member.memberId === memberId)
    expect(restored).toMatchObject({ availability: 'suspended', presence: 'unavailable' })
    expect(restored?.member.sessionId).toBe(added.status.member.sessionId)
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    expect(archived).toEqual([])
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('finishes an interrupted suspension through explicit recovery instead of steering the stray generation', async () => {
    const { ctx, workspaceId, archived } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('susp-recover-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
    const memberId = added.status.member.memberId
    const handle = ctx.agentTeam['handles'].get(memberId)!
    vi.spyOn(handle, 'dispose').mockRejectedValueOnce(new Error('agent disposal failed (test seam)'))
    await expect(ctx.agentTeam.suspendMember({ requestId: requestId('susp-recover'), memberId }))
      .rejects.toThrow('agent disposal failed')
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(true)

    // The durable state already says no live generation, so explicit
    // recovery converges the stray handle instead of feeding it a resume.
    const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('susp-recover-recover'), workspaceId, memberId })
    expect(recovered.status.availability).toBe('suspended')
    expect(ctx.agentTeam['handles'].has(memberId)).toBe(false)
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(archived).toEqual([])
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('creates, suspends, resumes, and removes an exact Team-owned Agent session', async () => {
    const { ctx, workspaceId, root, checkout } = await realHarness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    expect(added.status.availability).toBe('active')
    expect(added.status.member.privateMemoryPath).toBe(join(root, 'dsh-home', 'agent-team', 'members', added.status.member.memberId.replaceAll(':', '-')))
    // The first-run scaffold states the index's four sections and routes the
    // writing rules to the bundled skill instead of restating them.
    const scaffold = await readFile(join(added.status.member.privateMemoryPath, 'memory.md'), 'utf8')
    expect(scaffold).toContain('# Member memory')
    expect(scaffold).toContain('## Identity and role')
    expect(scaffold).toContain('## Durable rules')
    expect(scaffold).toContain('## In hand')
    expect(scaffold).toContain('## Notes index')
    expect(scaffold).toContain('the bundled `member-memory-manager` skill')
    await expect(access(join(added.status.member.privateMemoryPath, 'notes'))).resolves.toBeUndefined()
    const live = ctx.agents.get(added.status.member.sessionId)
    expect(live?.session.header.cwd).toBe(checkout)
    expect(live?.session.ownEvents()).toContainEqual(expect.objectContaining({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }))
    expect(ctx.agentTeam.memberForAgent(live!)).toEqual(added.status.member)
    expect(ctx.agentTeam.membersForClient({ workspaceId })[0]?.member).not.toHaveProperty('privateMemoryPath')
    const sessionTitle = ctx.get('sessionTitle')
    expect(sessionTitle?.get(live!.session)).toMatchObject({ title: 'builder', source: { kind: 'user' } })

    const suspended = await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId: added.status.member.memberId })
    expect(suspended.status.availability).toBe('suspended')
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume'), memberId: added.status.member.memberId })
    expect(resumed.status.availability).toBe('active')
    expect(resumed.status.member.sessionId).toBe(added.status.member.sessionId)
    const resumedLive = ctx.agents.get(added.status.member.sessionId)
    expect(sessionTitle?.get(resumedLive!.session)).toMatchObject({ title: 'builder', source: { kind: 'user' } })

    const removed = await ctx.agentTeam.removeMember({ requestId: requestId('remove'), memberId: added.status.member.memberId })
    expect(removed.member.state).toBe('inactive')
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    await expect(access(added.status.member.privateMemoryPath)).rejects.toThrow()
  })

  it('surfaces an orphaned preset composition and rebuilds the Member on resume', async () => {
    const { ctx, workspaceId, presets } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [] })
    expect(added.status.presence).toBe('available')
    const live = ctx.agents.get(added.status.member.sessionId)!
    expect(ctx.agentPresets.serviceFor(live, 'compaction')).toBeDefined()

    // Arm the orphan seam: this agent now resolves no preset composition,
    // as members composed before a bundle-row reload do after it.
    presets.orphaned.add(live.ctx)
    const orphaned = ctx.agentTeam.members().find(member => member.member.memberId === added.status.member.memberId)!
    expect(orphaned.presence).toBe('error')
    expect(orphaned.diagnostic).toMatchObject({ class: 'preset-composition' })
    expect(orphaned.diagnostic?.detail).toContain('preset composition was lost')

    const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('recover'), workspaceId, memberId: added.status.member.memberId })
    expect(recovered.status.presence).toBe('available')
    const rebuilt = ctx.agents.get(added.status.member.sessionId)!
    expect(rebuilt).not.toBe(live)
    expect(ctx.agentPresets.serviceFor(rebuilt, 'compaction')).toBeDefined()
    expect(ctx.tools.schemas(rebuilt).length).toBeGreaterThan(0)
  })

  it('re-derives a Member\u2019s failed last turn when the Host restarts', async () => {
    // The runtime failure slot is process-local memory, so nothing of it
    // survives a restart. Its durable source is the Session log, and a
    // restart re-runs the failure: the wake leaves facts to deliver, so the
    // Member reports the same failure again from the same durable origin.
    const adapter = new ScriptedAdapter()
    adapter.failWith = new LlmError('gateway answered 401', 'AUTH')
    const { ctx, workspaceId, teamFiber } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('restart-project'), workspaceId, name: 'engineering', description: '' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('restart-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const memberId = added.status.member.memberId
    await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('restart-send'), workspaceId, projectRef: project.project.projectRef, body: '@builder go' })
    await ctx.agents.get(added.status.member.sessionId)!.whenIdle()
    const before = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
    expect(before?.presence).toBe('error')
    expect(before?.diagnostic?.detail).toContain('401')

    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    // Straight after the boot the Member has already been woken by the
    // restart, so it is working rather than still marked failed — the error
    // presence returns once that turn settles on the same durable failure.
    const booting = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
    expect(booting?.availability).toBe('active')
    expect(booting?.presence).toBe('working')
    const agent = ctx.agents.get(booting!.member.sessionId)!
    await agent.whenIdle()
    const after = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
    expect(after?.presence).toBe('error')
    expect(after?.diagnostic).toMatchObject({ class: 'runtime' })
    expect(after?.diagnostic?.detail).toContain('401')
  })

  it('reports an unexpected Team wake cancellation before turn start without blaming ordinary notice replacement', async () => {
    const adapter = new EmptyAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('pre-turn-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('pre-turn-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const discarded: string[] = []
    ctx.on('agent/inbox/discarded', ({ message }) => { discarded.push(message.id) })
    // Park every Team wake instead of letting an idle Agent run and claim it:
    // the reproduced bug is a wake that is queued and then discarded with no
    // turn/start, which the live loop only produces from a maintenance-latched
    // wake cleared before convergence. Parking reaches that end-state directly.
    const steer = vi.spyOn(agent, 'steer').mockImplementation(input => { agent.inbox.append('next-turn', input) })

    const first = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('pre-turn-first'), workspaceId, projectRef: project.project.projectRef, body: '@builder investigate' })
    expect(first.kind).toBe('committed')
    const firstNotice = agent.inbox.nextTurn.at(-1)!
    expect(firstNotice.source).toMatchObject({ kind: AGENT_TEAM_PLUGIN_ID, form: 'notice' })
    expect((ctx.agentTeam as unknown as { pendingTeamWakes: Map<string, unknown> }).pendingTeamWakes.has(firstNotice.id)).toBe(true)

    const second = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('pre-turn-second'), workspaceId, projectRef: project.project.projectRef, body: '@builder investigate again' })
    expect(second.kind).toBe('committed')
    const replacement = ctx.agentTeam.members().find(status => status.member.memberId === added.status.member.memberId)!
    expect(replacement.diagnostic).toBeUndefined()
    expect(agent.inbox.nextTurn).toHaveLength(1)
    const replacementNotice = agent.inbox.nextTurn[0]!
    expect(replacementNotice.id).not.toBe(firstNotice.id)
    expect(agent.inbox.remove(replacementNotice.id)).toBe(true)
    expect(discarded).toContain(replacementNotice.id)

    const failed = ctx.agentTeam.members().find(status => status.member.memberId === added.status.member.memberId)!
    expect(failed).toMatchObject({ presence: 'error', diagnostic: {
      class: 'runtime', source: 'agent/inbox/discarded', sessionId: added.status.member.sessionId,
    } })
    expect(failed.diagnostic?.occurredAt).toEqual(expect.any(String))
    steer.mockRestore()
  })

  it('restarts a Member whose activation failed and rejects restart for suspended Members', async () => {
    const { ctx, workspaceId, presets } = await realHarness()
    presets.failingMount = true
    const added = await ctx.agentTeam.addMember({ requestId: requestId('add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [] })
    expect(added.status.availability).toBe('unavailable')
    expect(added.status.presence).toBe('unavailable')
    expect(added.status.diagnostic).toMatchObject({ class: 'preset-composition' })
    expect(added.status.diagnostic?.detail).toContain('failed to load')
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()

    presets.failingMount = false
    const restarted = await ctx.agentTeam.recoverMember({ requestId: requestId('restart'), workspaceId, memberId: added.status.member.memberId })
    expect(restarted.status.availability).toBe('active')
    expect(restarted.status.member.sessionId).toBe(added.status.member.sessionId)
    const live = ctx.agents.get(restarted.status.member.sessionId)!
    expect(ctx.tools.schemas(live).length).toBeGreaterThan(0)
    // Restart is runtime-only: the durable ledger stays replay-consistent.
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()

    await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId: added.status.member.memberId })
    await expect(ctx.agentTeam.recoverMember({ requestId: requestId('restart-suspended'), workspaceId, memberId: added.status.member.memberId }))
      .rejects.toThrow('only enabled Members can be restarted')
  })

  it('resumes a suspended Member without consulting the persistence tree walk', async () => {
    const { ctx, workspaceId } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('resume-add'), workspaceId, handle: 'restorer', description: 'Restores the exact session', presetId: 'team-member', projectRefs: [] })
    expect(added.status.availability).toBe('active')
    const memberId = added.status.member.memberId
    await ctx.agentTeam.suspendMember({ requestId: requestId('resume-suspend'), memberId })

    // The Host retires the suspended log fire-and-forget, and the JSONL
    // backend publishes its win32 directories through transient staging
    // entries; a tree walk concurrent with that retirement sees ENOENT. The
    // resume path must rely on agents.resume() waiting for the retirement
    // instead of re-listing, so any consult here fails the test loudly.
    ctx.sessionPersistence.list = async () => { throw persistenceRaceError() }
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume-resume'), memberId })
    expect(resumed.status.availability, JSON.stringify(resumed.status)).toBe('active')
    expect(ctx.agents.get(resumed.status.member.sessionId)).toBeDefined()
  })

  it('retries a transient persistence walk failure while restarting a Member', async () => {
    const { ctx, workspaceId, teamFiber } = await realHarness()
    await ctx.agentTeam.addMember({ requestId: requestId('retry-add'), workspaceId, handle: 'retrier', description: 'Survives a transient walk failure', presetId: 'team-member', projectRefs: [] })

    // Host restart remounts the plugin and the startup restore walks the
    // persistence tree once for every Member. The previous generation's
    // retirement is still draining in the background; that walk sees the
    // JSONL backend's transient staging entries as ENOENT. One injected
    // failure must not fail the restore: the idempotent read retries and
    // activation proceeds on whichever branch the second read supports.
    await teamFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    const realList = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
    let consulted = 0
    ctx.sessionPersistence.list = async () => {
      consulted += 1
      if (consulted === 1) throw persistenceRaceError()
      return realList()
    }
    await ctx.plugin(AgentTeam)
    const restored = await waitFor(() => {
      const status = ctx.agentTeam.members().find(item => item.member.handle === 'retrier')
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    expect(restored.member.handle).toBe('retrier')
    expect(consulted).toBe(2)
  })

  it('creates a Member with no description and no Projects and lights delivery on mention', async () => {
    const { ctx, workspaceId, teamFiber } = await realHarness()
    const bare = await ctx.agentTeam.addMember({ requestId: requestId('bare'), workspaceId, handle: 'bare', description: '', presetId: 'team-member', projectRefs: [] })
    expect(bare.status.availability).toBe('active')
    expect(bare.status.member.description).toBe('')
    // The invariant companion replays the same durable record shape; an empty
    // initial Project list is valid and must not be rejected as divergent.
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    expect(ctx.agentTeam.status().agentMemberCount).toBe(1)
    const agent = ctx.agents.get(bare.status.member.sessionId)!
    expect(agent).toBeDefined()

    // A message to an empty Project commits with an empty notification set.
    const project = await ctx.agentTeam.createProject({ requestId: requestId('bare-project'), workspaceId, name: 'ops', description: 'Ops work' })
    const before = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('pre-join'), workspaceId, projectRef: project.project.projectRef, body: 'Posted before anyone joined' })
    expect(before.kind).toBe('committed')
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [], recent: [], hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })

    // Project enrolment is retired — membership is derived from participation
    // — so a Workspace participant with no Projects at all is reachable by
    // mention, and that mention is what lights the delivery chain.
    const after = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('post-join'), workspaceId, projectRef: project.project.projectRef, body: 'Pinged without joining', recipients: [bare.status.member.memberId] })
    expect(after.kind).toBe('committed')
    if (after.kind !== 'committed') throw new Error(`expected committed mention, received ${after.kind}`)
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1,
      items: [expect.objectContaining({ task: expect.objectContaining({ taskRef: after.task!.taskRef }), directCount: 1 })] })
  })

  it('requires referenced Project authority and rejects an incomplete Team preset before publication', async () => {
    const { ctx, workspaceId } = await realHarness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    await expect(ctx.agentTeam.addMember({ requestId: requestId('wrong-workspace'), workspaceId, handle: 'wrong', description: 'Wrong project', presetId: 'team-member', projectRefs: ['project:missing' as AgentTeamProjectRef] })).rejects.toThrow(/unknown Project/)
    const first = await ctx.agentTeam.addMember({ requestId: requestId('first'), workspaceId, handle: 'first', description: 'First', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    await expect(ctx.agentTeam.addMember({ requestId: requestId('duplicate'), workspaceId, handle: 'FIRST', description: 'Duplicate', presetId: 'team-member', projectRefs: [project.project.projectRef] })).rejects.toThrow(/already active/)
    expect(first.status.member.state).toBe('enabled')
  })

  it('runs the five-tool pull protocol through one live Team Member', async () => {
    const { ctx, workspaceId } = await realHarness()
    const project = await ctx.agentTeam.createProject({ requestId: requestId('protocol-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('protocol-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('protocol-reviewer'), workspaceId, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    let callNumber = 0
    const call = async (name: string, args: unknown) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-protocol-${++callNumber}`), name, arguments: args, agent })
      expect(result.isError, `${name} ${JSON.stringify(args)}: ${result.isError ? result.error.message : 'ok'}`).toBe(false)
      expect(result.concludesTurn).toBeUndefined()
      if (result.isError) throw new Error(result.error.message)
      return result.value as Record<string, any>
    }

    const discovered = await call('team_view', {})
    expect(discovered.projects).toEqual([{ projectRef: project.project.projectRef, name: 'engineering', role: 'member', owners: ['human'] }])
    expect(discovered.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'human' }),
      expect.objectContaining({ memberId: builder.status.member.memberId, handle: 'builder' }),
      expect.objectContaining({ memberId: reviewer.status.member.memberId, handle: 'reviewer' }),
    ]))
    expect(discovered).not.toHaveProperty('items')
    expect(ctx.tools.schemas(agent).every(schema => !Object.hasOwn(schema.parameters.properties ?? {}, 'workspaceId'))).toBe(true)

    // team_view enumerates every top-level Thread of joined Projects, taskless
    // included, without message bodies: a Member who joined late and was never
    // mentioned can discover prior discussions and address them by ref (issue #2).
    const beforeThreads = await call('team_view', {})
    expect(beforeThreads.threads).toEqual([])
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('protocol-owner'), workspaceId, projectRef: project.project.projectRef, memberId: builder.status.member.memberId })
    const plainStart = await call('team_message', { action: 'start', projectRef: project.project.projectRef, body: 'Agent-led taskless discussion' })
    expect(plainStart).toMatchObject({ kind: 'committed' })
    const taskfulStart = await call('team_message', { action: 'start', kind: 'task', projectRef: project.project.projectRef, body: 'Agent-led task with work' })
    expect(taskfulStart).toMatchObject({ kind: 'committed' })
    await call('team_message', { action: 'reply', threadRef: plainStart.threadRef, body: 'One follow-up reply', baseRevision: plainStart.revision })
    const threadDirectory = await call('team_view', {})
    expect(threadDirectory.threads).toHaveLength(2)
    const taskless = threadDirectory.threads.find((thread: { threadRef: string }) => thread.threadRef === plainStart.threadRef)
    expect(taskless).toMatchObject({ projectRef: project.project.projectRef, messageCount: 2 })
    expect(taskless.taskRef).toBeUndefined()
    const taskful = threadDirectory.threads.find((thread: { threadRef: string }) => thread.threadRef === taskfulStart.threadRef)
    expect(taskful).toMatchObject({ projectRef: project.project.projectRef, messageCount: 1, taskRef: taskfulStart.taskRef, status: 'todo' })
    expect(typeof taskful.taskNumber).toBe('number')
    // Directory entries stay address-book summaries: each Thread row carries
    // its bounded anchor subject (the approved output enrichment), and reply
    // bodies still never leak — only the anchor becomes the subject.
    expect(taskless.subject).toBe('Agent-led taskless discussion')
    expect(JSON.stringify(threadDirectory.threads)).not.toContain('One follow-up reply')
    // A second Member who joined after both Threads started sees them too.
    const lateJoinerAgent = ctx.agents.get(reviewer.status.member.sessionId)!
    const lateJoinerView = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-protocol-${++callNumber}`), name: 'team_view', arguments: {}, agent: lateJoinerAgent }).then(result => {
      expect(result.isError).toBe(false)
      return result.value as Record<string, any>
    })
    expect(lateJoinerView.threads.map((thread: { threadRef: string }) => thread.threadRef)).toEqual(expect.arrayContaining([plainStart.threadRef, taskfulStart.threadRef]))
    // Threads in a Project the Member has not joined stay invisible.
    const privateProject = await ctx.agentTeam.createProject({ requestId: requestId('protocol-private'), workspaceId, name: 'private', description: 'Unjoined' })
    const privateStart = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('protocol-private-start'), workspaceId, projectRef: privateProject.project.projectRef, body: 'Taskless discussion outside membership' })
    expect(privateStart).toMatchObject({ kind: 'committed' })
    const privateThreadRef = (privateStart as { thread: { threadRef: string } }).thread.threadRef
    const afterPrivate = await call('team_view', {})
    expect(afterPrivate.threads.some((thread: { threadRef: string }) => thread.threadRef === privateThreadRef)).toBe(false)
    expect(afterPrivate.projects.some((entry: { projectRef: string }) => entry.projectRef === privateProject.project.projectRef)).toBe(false)

    // team_message attachments: the tool passes absolute paths, the Host
    // validates and copies them into the cache, and the committed message
    // carries the same metadata and prompt lines as a manual upload.
    const shotPath = join(process.env.DSH_HOME!, 'protocol-shot.png')
    await writeFile(shotPath, Buffer.from('png-bytes'))
    const shotMessage = await call('team_message', { action: 'start', projectRef: project.project.projectRef,
      body: 'Agent-created task with a screenshot', attachments: [shotPath] })
    expect(shotMessage).toMatchObject({ kind: 'committed' })
    const shotThreadRef = (shotMessage as { threadRef: string }).threadRef
    const shotHistory = ctx.agentTeam.threadHistory({ workspaceId, threadRef: shotThreadRef as never })
    const shotFact = shotHistory.facts.find(fact => fact.kind === 'message' && fact.message.attachments !== undefined)
    expect(shotFact).toBeDefined()
    expect(shotHistory.facts.some(fact => fact.kind === 'message' && new RegExp(`\\[attachment\\] .*attachments${sep === '/' ? '\\/' : '\\\\'}v1${sep === '/' ? '\\/' : '\\\\'}`).test(fact.message?.body ?? ''))).toBe(true)
    const rejected = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-protocol-bad-${++callNumber}`), name: 'team_message', arguments: { action: 'start', projectRef: project.project.projectRef, body: 'Never committed', attachments: ['relative/shot.png'] }, agent })
    expect(rejected.isError).toBe(true)
    expect(rejected.error?.message ?? rejected.value).toMatch(/must be absolute/)
    expect(ctx.agentTeam.threadHistory({ workspaceId, threadRef: shotThreadRef as never }).facts.some(fact => fact.kind === 'message' && fact.message?.body === 'Never committed')).toBe(false)

    const agentStarted = await call('team_message', { action: 'start', projectRef: project.project.projectRef,
      body: 'Agent-created task for @human' })
    expect(agentStarted).toMatchObject({ kind: 'committed' })
    expect(ctx.agentTeam.inbox({ workspaceId })).toMatchObject({ totalDirectCount: 1,
      items: [expect.objectContaining({ directCount: 1 })] })
    expect(await call('team_attention', { action: 'unfollow', threadRef: agentStarted.threadRef })).toMatchObject({ kind: 'unfollow', following: false })
    expect(await call('team_attention', { action: 'follow', threadRef: agentStarted.threadRef })).toMatchObject({ kind: 'follow', following: true })
    expect(await call('team_attention', { action: 'status', threadRef: agentStarted.threadRef })).toMatchObject({ kind: 'status', following: true })

    const enrolled = await call('team_message', { action: 'start', projectRef: project.project.projectRef,
      body: 'Agent-led task for @reviewer' })
    expect(enrolled).toMatchObject({ kind: 'committed', threadRef: expect.any(String) })
    const enrolledThreadRef = (enrolled as { threadRef: string }).threadRef
    const reviewerAgent = ctx.agents.get(reviewer.status.member.sessionId)!
    const reviewerInbox = ctx.agentTeam.inboxForAgent(reviewerAgent, { workspaceId })
    expect(reviewerInbox).toMatchObject({ totalDirectCount: 1,
      items: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: enrolledThreadRef }), directCount: 1 })] })
    expect(reviewerInbox.items[0]!.task).toBeUndefined()
    // Being named delivers a notice; following the Thread stays the Member's own choice.
    expect(ctx.agentTeam.attentionStatusForAgent(reviewerAgent, { workspaceId, threadRef: enrolledThreadRef as never }).attention).toBeUndefined()

    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('protocol-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the pull protocol' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const background = await ctx.agentTeam.reply({ requestId: requestId('protocol-background'), workspaceId, taskRef: started.task!.taskRef, body: 'Older context', baseRevision: started.thread.revision })
    if (background.kind !== 'committed') throw new Error(`expected committed background, received ${background.kind}`)
    const invitation = await ctx.agentTeam.reply({ requestId: requestId('protocol-invite'), workspaceId, taskRef: started.task!.taskRef, body: 'Builder, please investigate', baseRevision: background.thread.revision, recipients: [builder.status.member.memberId] })
    if (invitation.kind !== 'committed') throw new Error(`expected committed invitation, received ${invitation.kind}`)

    const inbox = await call('team_inbox', {})
    // An owner learns of the ownership change as a Main stream marker, and the
    // invitation as a Thread marker: two direct notices, no body text.
    expect(inbox).toMatchObject({ totalDirectCount: 2, items: [expect.objectContaining({ taskRef: started.task!.taskRef, directCount: 1 })],
      main: [expect.objectContaining({ directCount: 1 })] })
    expect(JSON.stringify(inbox)).not.toContain('Builder, please investigate')

    const firstRead = await call('team_thread', { action: 'read', taskRef: started.task!.taskRef })
    expect(firstRead).toMatchObject({
      kind: 'read', taskRef: started.task!.taskRef, status: 'todo', resolution: 'open', following: false,
      anchor: { body: 'Investigate the pull protocol' }, claims: [],
    })
    expect(firstRead.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: 'Builder, please investigate', unread: true, direct: true }),
    ]))

    // A mention delivers a notice; the Member follows the Thread by choosing to.
    expect(await call('team_attention', { action: 'follow', taskRef: started.task!.taskRef })).toMatchObject({ kind: 'follow', following: true })
    const update = await ctx.agentTeam.reply({ requestId: requestId('protocol-update'), workspaceId, taskRef: started.task!.taskRef, body: 'New evidence', baseRevision: invitation.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)
    expect(await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'Premature reply', baseRevision: invitation.thread.revision }))
      .toMatchObject({ kind: 'unread_required', revision: update.thread.revision, unreadCount: 1 })
    await call('team_thread', { action: 'read', taskRef: started.task!.taskRef })
    expect(await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'Stale reply', baseRevision: invitation.thread.revision }))
      .toMatchObject({ kind: 'stale_revision', expectedRevision: invitation.thread.revision, revision: update.thread.revision })
    const reply = await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'Current reply', baseRevision: update.thread.revision })
    expect(reply).toMatchObject({ kind: 'committed', taskRef: started.task!.taskRef })

    // A reply naming a Project Member who has never taken part in this Thread
    // delivers a notice to them without making them follow it.
    const dropped = await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: '@reviewer, please look', baseRevision: reply.revision })
    expect(dropped).toMatchObject({ kind: 'committed', taskRef: started.task!.taskRef, threadRef: started.thread.threadRef })
    expect(dropped.undeliveredMentions).toBeUndefined()
    expect(ctx.agentTeam.inboxForAgent(reviewerAgent, { workspaceId }).items.map(item => item.thread.threadRef).sort()).toEqual([enrolledThreadRef, started.thread.threadRef].sort())

    expect(await call('team_attention', { action: 'unfollow', taskRef: started.task!.taskRef })).toMatchObject({ following: false })
    const claim = await call('team_task', { action: 'claim', taskRef: started.task!.taskRef, direction: 'implementation', baseRevision: dropped.revision })
    // A committed Claim mutation returns the authoritative affected Claim;
    // the structured claims archive and Task status stay real (compat) —
    // the render is what omits the archive, never the structured value.
    expect(claim).toMatchObject({ kind: 'committed', action: 'claim', threadRef: started.thread.threadRef, status: 'in_progress',
      claim: expect.objectContaining({ owner: builder.status.member.memberId, direction: 'implementation', state: 'active' }),
      claims: [expect.objectContaining({ owner: builder.status.member.memberId, direction: 'implementation', state: 'active' })] })
    expect(await call('team_attention', { action: 'status', taskRef: started.task!.taskRef })).toMatchObject({ following: true })
    expect(await call('team_task', { action: 'list', taskRef: started.task!.taskRef })).toMatchObject({ kind: 'listed', claims: [expect.objectContaining({ direction: 'implementation' })] })
    const done = await call('team_task', { action: 'done', taskRef: started.task!.taskRef, claimRef: claim.claim.claimRef, baseRevision: claim.revision })
    expect(done).toMatchObject({ kind: 'committed', action: 'done', status: 'in_review', claim: expect.objectContaining({ state: 'done' }),
      claims: [expect.objectContaining({ direction: 'implementation', state: 'done' })] })
    const secondClaim = await call('team_task', { action: 'claim', taskRef: started.task!.taskRef, direction: 'follow-up', baseRevision: done.revision })
    const released = await call('team_task', { action: 'release', taskRef: started.task!.taskRef, claimRef: secondClaim.claim.claimRef, baseRevision: secondClaim.revision })
    expect(released).toMatchObject({ kind: 'committed', action: 'release', claim: expect.objectContaining({ direction: 'follow-up', state: 'released' }),
      claims: [expect.objectContaining({ direction: 'implementation', state: 'done' }), expect.objectContaining({ direction: 'follow-up', state: 'released' })] })

    const humanReadAfterClaims = await ctx.agentTeam.readThread({ requestId: requestId('protocol-human-read-after-claims'), workspaceId,
      taskRef: started.task!.taskRef })
    const unreadAfterClaims = await ctx.agentTeam.reply({ requestId: requestId('protocol-history-unread'), workspaceId,
      taskRef: started.task!.taskRef, body: 'Unread during history', baseRevision: humanReadAfterClaims.thread.revision })
    if (unreadAfterClaims.kind !== 'committed') throw new Error(`expected committed history update, received ${unreadAfterClaims.kind}`)
    const history = await call('team_thread', { action: 'history', taskRef: started.task!.taskRef, limit: 2 })
    expect(history).toMatchObject({ kind: 'history', anchor: { body: 'Investigate the pull protocol' }, claims: expect.arrayContaining([expect.objectContaining({ direction: 'implementation' })]) })
    expect(typeof history.cursor).toBe('number')
    // The owner-change Main stream marker is still unread; only the Thread row carries new work.
    expect(await call('team_inbox', {})).toMatchObject({ totalUnreadCount: 2, items: [expect.objectContaining({ taskRef: started.task!.taskRef })],
      main: [expect.objectContaining({ unreadCount: 1 })] })
    expect(await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'History did not read', baseRevision: unreadAfterClaims.thread.revision }))
      .toMatchObject({ kind: 'unread_required', unreadCount: 1 })
    await call('team_thread', { action: 'read', taskRef: started.task!.taskRef })
    expect(await call('team_inbox', {})).toMatchObject({ totalUnreadCount: 1, items: [], main: [expect.objectContaining({ unreadCount: 1 })] })
  })

  it('delivers a direct message through the tool and injects it into the live recipient session', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('dm-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('dm-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('dm-reviewer'), workspaceId, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const sender = ctx.agents.get(builder.status.member.sessionId)!
    const recipient = ctx.agents.get(reviewer.status.member.sessionId)!
    let callNumber = 0
    const call = async (name: string, args: unknown) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-${++callNumber}`), name, arguments: args, agent: sender })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error(result.error.message)
      return result.value as Record<string, any>
    }

    // The recipient's model answers briefly; the DM relay is one user turn.
    const sent = await call('team_dm', { memberRef: reviewer.status.member.memberId, body: 'quick check: is the build green?' })
    expect(sent).toMatchObject({ kind: 'dm-sent', recipientMemberId: reviewer.status.member.memberId, recipientHandle: 'reviewer', delivered: true })
    expect(sent).toMatchObject({ kind: 'dm-sent', recipientMemberId: reviewer.status.member.memberId, recipientHandle: 'reviewer', delivered: true })

    // The injected relay carries the DM body, the sender attribution, and the
    // plugin relay source; it is durable in the recipient's session log.
    adapter.enqueue(textResponse('Build is green.'))
    await waitForIdle(ctx, recipient)
    const relay = recipient.session.ownEvents().findLast(event => event.type === 'user/message'
      && (event.data as { source?: { form?: string } }).source?.form === 'relay')
    expect(relay).toBeDefined()
    const relayData = relay!.data as { content: Array<{ type: string; text: string }>; source: { kind: string; form: string } }
    expect(relayData.source).toMatchObject({ kind: AGENT_TEAM_PLUGIN_ID, form: 'relay' })
    expect(relayData.content[0]!.text).toContain('Direct message from @builder')
    expect(relayData.content[0]!.text).toContain('quick check: is the build green?')

    // Audit-only: no Thread or Message appears in the Project, and neither
    // Member's Inbox gains unread work from the DM.
    const view = ctx.agentTeam.view({ workspaceId })
    expect(view.threads).toHaveLength(0)
    expect(view.items).toHaveLength(0)
    expect(ctx.agentTeam.inboxForAgent(recipient, { workspaceId })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [], recent: [], hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()

    // A second DM carries the bounded adjacent context of the first exchange:
    // the context line cites the prior DM's body, never the one being sent.
    // Direction is from the reader's perspective: the cited DM came from the
    // other Member (the sender), so the reviewer reads (them → you).
    const second = await call('team_dm', { memberRef: reviewer.status.member.memberId, body: 'still green?' })
    expect(second).toMatchObject({ kind: 'dm-sent', delivered: true })
    adapter.enqueue(textResponse('Still green.'))
    await waitForIdle(ctx, recipient)
    const relays = recipient.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { form?: string } }).source?.form === 'relay')
    expect(relays).toHaveLength(2)
    const secondText = (relays[1]!.data as { content: Array<{ type: string; text: string }> }).content[0]!.text
    expect(secondText).toContain('most recent prior DM')
    expect(secondText).toMatch(/\(them → you, at [^)]+\+08:00\) quick check: is the build green\?/)
    expect(secondText.slice(secondText.indexOf('[most recent prior DM'))).not.toContain('still green?')

    // A reply DM in the mirror direction: the builder now reads the reviewer's
    // prior DM, which the reader received from the other Member — but the
    // latest prior exchange from the reader's own side is the builder's own
    // 'still green?', so the reader (builder) reads (you → them).
    adapter.enqueue(textResponse('Thanks.'))
    const replyFromReviewer = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-mirror-${++callNumber}`), name: 'team_dm', arguments: { memberRef: builder.status.member.memberId, body: 'yes, all green' }, agent: recipient })
    expect(replyFromReviewer.isError).toBe(false)
    adapter.enqueue(textResponse('Noted.'))
    await waitForIdle(ctx, sender)
    const senderRelays = sender.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { form?: string } }).source?.form === 'relay')
    expect(senderRelays).toHaveLength(1)
    const mirrorText = (senderRelays[0]!.data as { content: Array<{ type: string; text: string }> }).content[0]!.text
    expect(mirrorText).toMatch(/\(you → them, at [^)]+\+08:00\) still green\?/)

    // Parameter matrix: human recipients, unknown Members, and stray fields.
    const bad = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-bad-${++callNumber}`), name: 'team_dm', arguments: { memberRef: AGENT_TEAM_HUMAN_MEMBER_ID, body: 'hi' }, agent: sender })
    expect(bad.isError).toBe(true)
    expect(bad.error?.message ?? '').toMatch(/Agent Member/)
    expect(bad.error?.message ?? '').toMatch(/Agent Member/)
    const unknown = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-unknown-${++callNumber}`), name: 'team_dm', arguments: { memberRef: 'member:nobody', body: 'hi' }, agent: sender })
    expect(unknown.isError).toBe(true)
    // A Thread write's parameters are not merely ignored here: the schema does
    // not carry them, so a model reaching for one is refused before the Host.
    const stray = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-stray-${++callNumber}`), name: 'team_dm', arguments: { memberRef: reviewer.status.member.memberId, body: 'hi', projectRef: project.project.projectRef }, agent: sender })
    expect(stray.isError).toBe(true)
    expect(stray.error?.message ?? '').toMatch(/does not accept|unexpected/i)

    // A suspended peer is not a sendable target: the ledger rejects the send
    // outright (nothing is recorded), which is the pre-delivery guard.
    await ctx.agentTeam.suspendMember({ requestId: requestId('dm-suspend'), memberId: reviewer.status.member.memberId })
    const suspended = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-suspended-${++callNumber}`), name: 'team_dm', arguments: { memberRef: reviewer.status.member.memberId, body: 'are you back?' }, agent: sender })
    expect(suspended.isError).toBe(true)
    expect(suspended.error?.message ?? '').toMatch(/suspended/)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()

    // Missing live session: an enabled Member whose handle is gone records
    // the DM durably but surfaces the structured delivery error to the sender.
    await ctx.agentTeam.resumeMember({ requestId: requestId('dm-resume'), memberId: reviewer.status.member.memberId })
    ctx.agentTeam['handles'].delete(reviewer.status.member.memberId)
    const beforeUndeliveredDm = ctx.agentTeam.status().sequence
    await expect(ctx.agentTeam.dmForAgent(sender, { requestId: requestId('dm-undelivered'), workspaceId,
      recipientMemberId: reviewer.status.member.memberId, body: 'are you back?' })).rejects.toMatchObject({ name: 'AgentTeamDmDeliveryError', recipientHandle: 'reviewer' })
    // The delivery error reports a committed write, not a failed one: the
    // dm-sent operation is the durable fact the error is talking about.
    expect(ctx.agentTeam.status().sequence).toBe(beforeUndeliveredDm + 1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('injects one durable clock snapshot at turn start and stays quiet within the refresh interval', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('clock-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('clock-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('clock-start'), workspaceId, projectRef: project.project.projectRef,
      body: 'Drive the clock', recipients: [builder.status.member.memberId] })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)

    // One real, tool-dense Member turn from the direct-mention wake: two
    // tool steps, then the closing text. The turn's first step appends one
    // durable clock snapshot; the quick follow-up steps fall inside the
    // default refresh interval and stay quiet, so the whole turn produces
    // exactly one snapshot line.
    adapter.enqueue(toolCallResponse('clock-tool-1', 'team_view', {}))
    adapter.enqueue(toolCallResponse('clock-tool-2', 'team_inbox', {}))
    adapter.enqueue(textResponse('Clock observed.'))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(3)
    const first = JSON.stringify(adapter.requests[0]!.messages)
    // The snapshot is model-visible inside the turn's first request.
    expect(first).toContain('Team clock sampled while preparing turn ')
    expect(first).toContain('Team collaboration timestamps use UTC+8.')
    const last = JSON.stringify(adapter.requests[2]!.messages)
    // The closing step still carries the turn's single snapshot in history.
    const lastSnapshots = adapter.requests[2]!.messages.filter(message =>
      (message as { source?: { kind?: string } }).source?.kind === 'wowyuarm-agent-team-member-time-context')
    expect(lastSnapshots).toHaveLength(1)
    expect(last).toContain('Team clock sampled while preparing turn ')
    const snapshots = agent.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { kind?: string; form?: string } }).source?.kind === 'wowyuarm-agent-team-member-time-context')
    expect(snapshots).toHaveLength(1)
    const data = snapshots[0]!.data as { content: Array<{ type: string; text: string }>; source: { kind: string; form: string; sections?: unknown[] } }
    expect(data.source.form).toBe('snapshot')
    // ContextFormed snapshot messages must carry sections.
    expect(Array.isArray(data.source.sections)).toBe(true)
    const text = data.content[0]!.text
    expect(text).toContain('Team clock sampled while preparing turn ')
    expect(text).toMatch(/Elapsed since the preceding model-visible event: (unavailable|[0-9dhms ]+)\./)
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00/)
    // Absolute instants only: no relative time vocabulary.
    expect(text).not.toContain(' ago')
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('returns a rejected Team result to the next model step without ending the turn', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('loop-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('loop-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('loop-start'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the rejection flow' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('loop-follow'), workspaceId,
      taskRef: started.task!.taskRef, action: 'follow' })
    const firstRead = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('loop-read'), workspaceId,
      taskRef: started.task!.taskRef })
    const update = await ctx.agentTeam.reply({ requestId: requestId('loop-update'), workspaceId,
      taskRef: started.task!.taskRef, body: 'Newer context arrived', baseRevision: firstRead.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)

    adapter.enqueue(toolCallResponse('model-team-view', 'team_view', {}))
    adapter.enqueue(toolCallResponse('model-team-rejected', 'team_message', { action: 'reply',
      taskRef: started.task!.taskRef, body: 'Premature reply', baseRevision: update.thread.revision }))
    adapter.enqueue(textResponse('I will read the Thread before replying.'))

    // The committed Human update leaves durable unread work, so its pending
    // hint wakes the idle Member; that wake carries the model steps under test.
    const idle = waitForIdle(ctx, agent)
    await idle

    expect(adapter.requests).toHaveLength(3)
    const afterRejection = JSON.stringify(adapter.requests[2]!.messages)
    expect(afterRejection).toContain(started.task!.taskRef)
    expect(afterRejection).toContain('unread_required')
    const results = agent.session.ownEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    // 0.1.7 carries the outcome on the message, not inside a tool-result block.
    expect(results.map(result => (result.data.message as { isError?: boolean }).isError)).toEqual([false, false])
  })

  it('coalesces updates and delivers a running Member hint only at the next step boundary', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('safe-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('safe-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('safe-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate safe delivery' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('safe-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    let revision = (await ctx.agentTeam.readThread({ requestId: requestId('safe-human-read'), workspaceId, taskRef: started.task!.taskRef })).thread.revision
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start ordinary checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const first = await ctx.agentTeam.reply({ requestId: requestId('safe-update-1'), workspaceId, taskRef: started.task!.taskRef, body: 'First hidden update', baseRevision: revision })
    if (first.kind !== 'committed') throw new Error(`expected committed reply, received ${first.kind}`)
    revision = first.thread.revision
    const second = await ctx.agentTeam.reply({ requestId: requestId('safe-update-2'), workspaceId, taskRef: started.task!.taskRef, body: 'Second hidden update', baseRevision: revision })
    if (second.kind !== 'committed') throw new Error(`expected committed reply, received ${second.kind}`)
    expect(adapter.requests).toHaveLength(1)
    adapter.enqueue(textResponse('I will triage Team Inbox next.'))
    adapter.release.resolve()
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const safeBoundaryRequest = JSON.stringify(adapter.requests[1]!.messages)
    expect(safeBoundaryRequest).toContain('Team Inbox has unread work')
    expect(safeBoundaryRequest).toContain(started.task!.taskRef)
    expect(safeBoundaryRequest).toContain('2 unread updates')
    expect(safeBoundaryRequest).not.toContain('First hidden update')
    expect(safeBoundaryRequest).not.toContain('Second hidden update')
    const hints = agent.session.ownEvents().filter(event => event.type === 'user/message'
      && JSON.stringify(event.data).includes('Team Inbox has unread work'))
    expect(hints).toHaveLength(1)
  })

  it('wakes an idle Member with a direct mention body and source', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('top-level-wake-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('top-level-wake-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const committed = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('top-level-wake'), workspaceId, projectRef: project.project.projectRef,
      body: 'Please investigate the top-level wake path', recipients: [builder.status.member.memberId] })
    expect(committed.kind).toBe('committed')
    expect(adapter.requests).toHaveLength(0)

    adapter.enqueue(textResponse('I will inspect the mentioned Task.'))
    if (committed.kind !== 'committed') throw new Error(`expected committed top-level mention, received ${committed.kind}`)
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1,
      items: [expect.objectContaining({ task: expect.objectContaining({ taskRef: committed.task!.taskRef }), directCount: 1 })] })
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('Direct Team mention')
    expect(request).toContain('Please investigate the top-level wake path')
    // The rendered sender line, not the 'member:human' ids elsewhere in the request.
    expect(request).toContain('From: human')
    expect(request).toContain(committed.task!.taskRef)
    // The notification states the absolute commit instant in UTC+8.
    expect(request).toContain('Occurred at: ')
    expect(request).toMatch(/Occurred at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00/)
  })

  it('delivers a mention in an owner-started Thread to the mentioned Member', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('peer-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const starter = await ctx.agentTeam.addMember({ requestId: requestId('peer-starter'), workspaceId, handle: 'starter', description: 'Starts work', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const peer = await ctx.agentTeam.addMember({ requestId: requestId('peer-peer'), workspaceId, handle: 'peer', description: 'Peers in', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const starterAgent = ctx.agents.get(starter.status.member.sessionId)!
    adapter.enqueue(textResponse('Noted my new ownership.'))
    await ctx.agentTeam.addProjectOwner({ requestId: requestId('peer-owner'), workspaceId, projectRef: project.project.projectRef, memberId: starter.status.member.memberId })
    await starterAgent.whenIdle()
    const peerAgent = ctx.agents.get(peer.status.member.sessionId)!
    let callNumber = 0
    const call = async (name: string, args: unknown) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId(`peer-mention-${++callNumber}`), name, arguments: args, agent: starterAgent })
      if (result.isError) throw new Error(result.error.message)
      return result.value as Record<string, any>
    }

    const started = await call('team_message', { action: 'start', projectRef: project.project.projectRef,
      body: '@peer please verify the export path' })
    expect(started).toMatchObject({ kind: 'committed' })

    expect(ctx.agentTeam.inboxForAgent(peerAgent, { workspaceId })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1,
      items: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.threadRef }), directCount: 1 })] })
    expect(ctx.agentTeam.inboxForAgent(peerAgent, { workspaceId }).items[0]!.task).toBeUndefined()

    adapter.enqueue(textResponse('I will verify the export path.'))
    await peerAgent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    const request = JSON.stringify(adapter.requests[1]!.messages)
    expect(request).toContain('Direct Team mention')
    expect(request).toContain('@peer please verify the export path')
    expect(request).toContain('starter')
    expect(request).toContain(started.threadRef)
    expect(request).not.toContain('Task undefined')
    expect(request).toContain('relevant workspace and threadRef')
    expect(request).toMatch(/Occurred at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00/)
  })

  it('resolves what a reply answers from outside the reader window, once per read', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('reply-window-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('reply-window-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const anchor = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('reply-window-anchor'), workspaceId,
      projectRef: project.project.projectRef, body: 'Please investigate the anchored path', recipients: [builder.status.member.memberId] })
    if (anchor.kind !== 'committed') throw new Error('expected committed anchor')

    // The reader drains the anchor first, so both replies below arrive in one
    // batch whose answering target is already behind them.
    await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('reply-window-read-1'), workspaceId, taskRef: anchor.task!.taskRef })
    const first = await ctx.agentTeam.reply({ requestId: requestId('reply-window-reply-1'), workspaceId, taskRef: anchor.task!.taskRef,
      baseRevision: anchor.thread.revision, body: 'Looking now', recipients: [builder.status.member.memberId], replyToMessageRef: anchor.message.messageRef })
    if (first.kind !== 'committed') throw new Error('expected committed first reply')
    const second = await ctx.agentTeam.reply({ requestId: requestId('reply-window-reply-2'), workspaceId, taskRef: anchor.task!.taskRef,
      baseRevision: first.thread.revision, body: 'One correction', recipients: [builder.status.member.memberId], replyToMessageRef: anchor.message.messageRef })
    if (second.kind !== 'committed') throw new Error('expected committed second reply')

    const spy = vi.spyOn(AgentTeamLedger.prototype, 'resolveMessageRefs')
    const read = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('reply-window-read-2'), workspaceId, taskRef: anchor.task!.taskRef })
    const resolving = spy.mock.calls.filter(([, refs]) => refs.length > 0)
    spy.mockRestore()
    // The parent is asked for once for the whole window, not once per reply.
    expect(resolving).toHaveLength(1)

    const answered = read.facts.filter(entry => entry.fact.kind === 'message' && entry.fact.replyTo !== undefined)
    expect(answered).toHaveLength(2)
    for (const entry of answered) {
      if (entry.fact.kind !== 'message') continue
      // Resolved through the ledger, not out of the window: the anchor is not in it.
      expect(entry.fact.replyTo).toEqual({ sender: 'human', excerpt: 'Please investigate the anchored path' })
    }
    expect(read.facts.some(entry => entry.fact.kind === 'message' && entry.fact.message.messageRef === anchor.message.messageRef)).toBe(false)

    // The context is a projection this read added, not a durable fact: the
    // stored records keep the shape their schema declares. Writing it into a
    // record is what stops a whole domain from reopening.
    const records = JSON.stringify([...(ctx.get('storageDomain') as DomainFacility)
      .get('agent_team')!.table('operations').entries()])
    expect(records).toContain('Looking now')
    // The durable link is `replyToMessageRef`; the resolved `replyTo` is not.
    expect(records).toContain('replyToMessageRef')
    expect(records).not.toContain('"replyTo":')
  })

  it('names what a reply answers in the mention notice, with the ref it hands back', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('replies-to-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('replies-to-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    // The anchor mentions nobody, so the only wake below is the reply's.
    const anchor = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('replies-to-anchor'), workspaceId,
      projectRef: project.project.projectRef, body: 'Please investigate the anchored path' })
    if (anchor.kind !== 'committed') throw new Error('expected committed anchor')
    // Following first: a Human reply naming a Member who is not yet following
    // goes through the one-use confirmation, which is a different test's subject.
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('replies-to-follow'), workspaceId, taskRef: anchor.task!.taskRef, action: 'follow' })
    const answer = await ctx.agentTeam.reply({ requestId: requestId('replies-to-reply'), workspaceId, taskRef: anchor.task!.taskRef,
      baseRevision: anchor.thread.revision, body: 'Answering the anchored path', recipients: [builder.status.member.memberId],
      replyToMessageRef: anchor.message.messageRef })
    if (answer.kind !== 'committed') throw new Error('expected committed reply')

    adapter.enqueue(textResponse('Reading the answer.'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('Direct Team mention')
    // Author, the original's first line, and the full ref last — the ref is
    // what the reader hands back to team_message.replyToMessageRef.
    // The request is inspected as JSON, so the quoted summary arrives escaped.
    expect(request).toContain('Replies to: @human — \\"Please investigate the anchored path\\"')
    expect(request).toContain(`[${anchor.message.messageRef}]`)
  })

  it('bounds automatic direct context while retaining omitted Messages in durable Inbox', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('bounded-project'), workspaceId,
      name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('bounded-builder'), workspaceId, handle: 'builder',
      description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const started = []
    for (let index = 1; index <= 5; index++) {
      const body = `${`x${index}`.repeat(4_500)}\nDIRECT-END-${index}`
      const result = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId(`bounded-direct-${index}`), workspaceId,
        projectRef: project.project.projectRef, body, recipients: [builder.status.member.memberId] })
      if (result.kind !== 'committed') throw new Error(`expected committed direct Message, received ${result.kind}`)
      started.push(result)
    }
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toMatchObject({ totalUnreadCount: 5, totalDirectCount: 5 })

    adapter.enqueue(textResponse('I will inspect the routed Team work.'))
    adapter.release.resolve()
    await agent.whenIdle()
    const request = JSON.stringify(adapter.requests[1]!.messages)
    expect(request).toContain('More unread work remains in team_inbox')
    expect(request).not.toContain('DIRECT-END-5')

    const omitted = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('bounded-read-omitted'), workspaceId,
      taskRef: started[4]!.task!.taskRef })
    expect(omitted.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ direct: true, fact: expect.objectContaining({ kind: 'message', message: expect.objectContaining({ body: expect.stringContaining('DIRECT-END-5') }) }) }),
    ]))
  })

  it('wakes an affected Member with a Task close and released Claim summary', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('task-update-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('task-update-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('task-update-start'), workspaceId,
      projectRef: project.project.projectRef, body: 'Prepare a close notification test' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('task-update-follow'), workspaceId,
      taskRef: started.task!.taskRef, action: 'follow' })
    const initialRead = await ctx.agentTeam.readThreadForAgent(agent, { requestId: requestId('task-update-agent-read'), workspaceId,
      taskRef: started.task!.taskRef })
    const claim = await ctx.agentTeam.changeClaimForAgent(agent, { requestId: requestId('task-update-claim'), workspaceId,
      taskRef: started.task!.taskRef, action: 'claim', direction: 'browser verification', baseRevision: initialRead.thread.revision })
    expect(claim).toMatchObject({ kind: 'committed', claim: { state: 'active' } })
    if (claim.kind !== 'committed') throw new Error(`expected committed Claim, received ${claim.kind}`)
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('task-update-human-read'), workspaceId,
      taskRef: started.task!.taskRef })

    adapter.enqueue(textResponse('I will stop work on the closed Task.'))
    const closed = await ctx.agentTeam.changeTask({ requestId: requestId('task-update-close'), workspaceId,
      taskRef: started.task!.taskRef, action: 'close', baseRevision: humanRead.thread.revision })
    expect(closed).toMatchObject({ kind: 'committed', task: { resolution: 'closed' }, claims: [
      expect.objectContaining({ claimRef: claim.claim.claimRef, state: 'released' }),
    ] })
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('Team Task update')
    expect(request).toContain(`human close Task ${started.task!.taskRef}`)
    expect(request).toContain(claim.claim.claimRef)
    expect(request).toContain('Released Claims')
  })

  it('wakes an idle Member from durable Inbox state without injecting Thread bodies', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('wake-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('wake-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('wake-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the wake path' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('wake-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('wake-human-read'), workspaceId, taskRef: started.task!.taskRef })
    adapter.enqueue(textResponse('I will inspect Team Inbox.'))
    const first = await ctx.agentTeam.reply({ requestId: requestId('wake-reply-1'), workspaceId, taskRef: started.task!.taskRef, body: 'Please inspect the durable wake.', baseRevision: humanRead.thread.revision })
    if (first.kind !== 'committed') throw new Error(`expected committed reply, received ${first.kind}`)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('Team Inbox has unread work')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('Please inspect the durable wake.')

    adapter.enqueue(textResponse('I will triage both updates.'))
    const second = await ctx.agentTeam.reply({ requestId: requestId('wake-reply-2'), workspaceId, taskRef: started.task!.taskRef, body: 'A second update should coalesce.', baseRevision: first.thread.revision })
    if (second.kind !== 'committed') throw new Error(`expected committed reply, received ${second.kind}`)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).not.toContain('A second update should coalesce.')
  })

  it('recovers a needed hint from durable unread state on Member resume', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('resume-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('resume-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('resume-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate resume recovery' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('resume-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('resume-human-read'), workspaceId, taskRef: started.task!.taskRef })
    await ctx.agentTeam.suspendMember({ requestId: requestId('resume-suspend'), memberId: builder.status.member.memberId })
    const update = await ctx.agentTeam.reply({ requestId: requestId('resume-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread while suspended', baseRevision: humanRead.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed reply, received ${update.kind}`)

    adapter.enqueue(textResponse('I will inspect recovered Inbox work.'))
    await ctx.agentTeam.resumeMember({ requestId: requestId('resume-enable'), memberId: builder.status.member.memberId })
    const resumed = ctx.agents.get(builder.status.member.sessionId)!
    await resumed.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('Team Inbox has unread work')
    expect(request).not.toContain('Unread while suspended')
  })

  it('keeps the automatic recovery instruction with durable Inbox routing', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('automatic-recovery-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('automatic-recovery-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('automatic-recovery-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate automatic recovery' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('automatic-recovery-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('automatic-recovery-read'), workspaceId, taskRef: started.task!.taskRef })
      const update = await ctx.agentTeam.reply({ requestId: requestId('automatic-recovery-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread through automatic recovery', baseRevision: humanRead.thread.revision })
      if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)
      await agent.whenIdle()
      ctx.emit('agent/error', { agent, turn: 2, step: 1, error: new Error('fetch failed') })

      adapter.enqueue(textResponse('I will continue the interrupted work.'))
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)
      await agent.whenIdle()

      const request = JSON.stringify(adapter.requests.at(-1)!.messages)
      expect(request).toContain('temporary service error')
      expect(request).toContain('Please continue the work you were doing before the error.')
      expect(request).toContain('Team Inbox has unread work')
      expect(request).toContain(started.task!.taskRef)
      expect(request).not.toContain('Unread through automatic recovery')
      expect(request).not.toMatch(/operator asked|automatic recovery|attempt|stop|handoff/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports automatic recovery classification, wakeup, and stand-down with stable ids', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('recovery-trace-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const memberId = builder.status.member.memberId
      const sessionId = builder.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      await agent.whenIdle()
      const info = vi.spyOn(ctx.logger, 'info')
      const warn = vi.spyOn(ctx.logger, 'warn')
      const lines = (spy: typeof info): string[] => spy.mock.calls.map(args => String(args[0]))

      // One recoverable failure: the classification, the occurrence count, and
      // the armed wait are readable before any wakeup happens.
      ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('fetch failed') })
      const scheduled = lines(info).find(line => line.includes('automatic recovery scheduled'))
      expect(scheduled).toBeDefined()
      expect(scheduled).toContain(`memberId '${memberId}'`)
      expect(scheduled).toContain(`session '${sessionId}'`)
      expect(scheduled).toContain("errorKind 'transient network'")
      expect(scheduled).toContain('occurrence 1/3')
      expect(scheduled).toContain(`wait ${RECOVERY_DELAY_MS}ms`)

      adapter.enqueue(textResponse('I will continue the interrupted work.'))
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)
      await agent.whenIdle()
      const steered = lines(info).find(line => line.includes('automatic recovery continuation steered'))
      expect(steered).toBeDefined()
      expect(steered).toContain(`memberId '${memberId}'`)
      expect(steered).toContain(`session '${sessionId}'`)
      expect(steered).toContain('not yet read by the model')

      // Three consecutive occurrences with no clean turn between them stand the
      // episode down, and the stop says how many failures it counted.
      ctx.emit('agent/error', { agent, turn: 2, step: 1, error: new Error('HTTP 429') })
      ctx.emit('agent/error', { agent, turn: 3, step: 1, error: new Error('HTTP 429') })
      ctx.emit('agent/error', { agent, turn: 4, step: 1, error: new Error('ETIMEDOUT') })
      const stoodDown = lines(warn).find(line => line.includes('automatic recovery stood down'))
      expect(stoodDown).toBeDefined()
      expect(stoodDown).toContain(`memberId '${memberId}'`)
      expect(stoodDown).toContain(`session '${sessionId}'`)
      expect(stoodDown).toContain('3/3')
      expect(stoodDown).toContain('no further automatic wakeup')
      info.mockRestore()
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an automatic wakeup when a Member is suspended before the delay', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('suspend-recovery-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!

      ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('fetch failed') })
      await ctx.agentTeam.suspendMember({ requestId: requestId('suspend-recovery'), memberId: builder.status.member.memberId })
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)

      expect(adapter.requests).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('wakes a Member for a structured transport failure carried by the Harness event', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('structured-transport-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!

      ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new LlmError('DeepSeek Messages transport failed', 'TRANSPORT') })
      adapter.enqueue(textResponse('Continuing after the transport failure.'))
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)
      await agent.whenIdle()

      expect(adapter.requests.length).toBeGreaterThan(0)
      const request = JSON.stringify(adapter.requests.at(-1)!.messages)
      expect(request).toContain('temporary service error')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a structured terminal failure to manual recovery while keeping its diagnostic', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('structured-terminal-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!

      ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new LlmError('upstream answered 429 while settling quota', 'QUOTA', { status: 402 }) })
      adapter.enqueue(textResponse('Never reached.'))
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)

      expect(adapter.requests).toEqual([])
      const row = ctx.agentTeam.members().find(status => status.member.memberId === builder.status.member.memberId)
      expect(row).toMatchObject({ availability: 'active', presence: 'error', diagnostic: { class: 'runtime' } })
      expect(row?.diagnostic?.detail).toContain('429')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the manual recovery instruction with durable Inbox routing and cancels the pending wakeup', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('manual-recovery-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('manual-recovery-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('manual-recovery-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate manual recovery' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('manual-recovery-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('manual-recovery-read'), workspaceId, taskRef: started.task!.taskRef })
      const update = await ctx.agentTeam.reply({ requestId: requestId('manual-recovery-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread through manual recovery', baseRevision: humanRead.thread.revision })
      if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)
      await agent.whenIdle()

      adapter.enqueue(textResponse('I will continue the interrupted work.'))
      const info = vi.spyOn(ctx.logger, 'info')
      await ctx.agentTeam.recoverMember({ requestId: requestId('manual-recovery'), workspaceId, memberId: builder.status.member.memberId })
      await agent.whenIdle()
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)

      // The operator action is traceable to the Member and Session it steered
      // into, and claims a queue — not that the model has read anything.
      const steered = info.mock.calls.map(args => String(args[0])).find(line => line.includes('operator recovery continuation steered'))
      expect(steered).toBeDefined()
      expect(steered).toContain(`memberId '${builder.status.member.memberId}'`)
      expect(steered).toContain(`session '${builder.status.member.sessionId}'`)
      expect(steered).toContain('carrying 1 unread Thread(s)')
      expect(steered).toContain('not yet read by the model')
      info.mockRestore()

      expect(adapter.requests).toHaveLength(2)
      const request = JSON.stringify(adapter.requests.at(-1)!.messages)
      expect(request).toContain('The operator asked you to resume after the previous turn ended early.')
      expect(request).not.toContain('temporary service error')
      expect(request).toContain('Please continue the work you were doing before the error.')
      expect(request).toContain('Team Inbox has unread work')
      expect(request).toContain(started.task!.taskRef)
      expect(request).not.toContain('Unread through manual recovery')
      expect(request).not.toMatch(/automatic recovery|attempt|stop|handoff/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reissues a durable hint when a failed Member starts recovery work', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('error-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('error-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('error-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate error recovery' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('error-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('error-human-read'), workspaceId, taskRef: started.task!.taskRef })
    const update = await ctx.agentTeam.reply({ requestId: requestId('error-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread through runtime error', baseRevision: humanRead.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed reply, received ${update.kind}`)
    await agent.whenIdle()
    expect(ctx.agentTeam.members().find(status => status.member.memberId === builder.status.member.memberId)?.presence).toBe('error')

    adapter.enqueue(textResponse('I will recover by inspecting Team Inbox.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Recover now.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const request = JSON.stringify(adapter.requests.at(-1)!.messages)
    expect(request).toContain('Team Inbox has unread work')
    expect(request).not.toContain('Unread through runtime error')
  })

  it('reissues a needed hint from durable unread state after Host remount', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, teamFiber } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId('remount-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('remount-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('remount-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate remount recovery' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('remount-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('remount-human-read'), workspaceId, taskRef: started.task!.taskRef })
    const update = await ctx.agentTeam.reply({ requestId: requestId('remount-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread across Host remount', baseRevision: humanRead.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed reply, received ${update.kind}`)
    await agent.whenIdle()
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).totalUnreadCount).toBe(1)

    adapter.enqueue(textResponse('I will inspect remounted Inbox work.'))
    const info = vi.spyOn(ctx.logger, 'info')
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    const restored = ctx.agents.get(builder.status.member.sessionId)!
    await restored.whenIdle()
    const lastRequest = JSON.stringify(adapter.requests.at(-1)!.messages)
    expect(lastRequest).toContain('Team Inbox has unread work')
    expect(lastRequest).not.toContain('Unread across Host remount')

    // The catch-up wake states the lifecycle step that caused it, with the
    // stable Member and Session ids, and claims no more than a queue.
    const queued = info.mock.calls.map(args => String(args[0])).find(line => line.includes('Team Inbox notice queued'))
    expect(queued).toBeDefined()
    expect(queued).toContain(`memberId '${builder.status.member.memberId}'`)
    expect(queued).toContain(`session '${builder.status.member.sessionId}'`)
    expect(queued).toContain('cause Member activation')
    expect(queued).toContain('not yet read by the model')
    info.mockRestore()
  })

  it('surfaces an actionable diagnostic for the tsx source-mode dsh-scope mismatch', () => {
    const message = teamPresetScopeMismatchMessage(true)
    expect(message).toContain('selected preset is not team-enabled')
    expect(message).toContain('running from source via tsx')
    expect(message).toContain('compiled CLI')
    const generic = teamPresetScopeMismatchMessage(false)
    expect(generic).toContain('different physical copies')
    expect(generic).toContain('pnpm install')
  })

  it('keeps a persisted Member session active after switching its model and restarting', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, teamFiber } = await realHarness(adapter)
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('persisted-model-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member', projectRefs: [],
      model: { provider: 'mock', model: 'initial-model' },
    })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    adapter.enqueue(textResponse('initial response'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Create a persisted transcript.' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const edited = await ctx.agentTeam.updateMember({
      requestId: requestId('persisted-model-edit'), memberId: added.status.member.memberId,
      handle: 'builder', description: 'Builds the implementation',
      model: { provider: 'mock', model: 'switched-model' },
    })
    expect(edited.status.availability).toBe('active')

    // Host restart on the persisted Session: the switched selection, not the
    // creation-time model, drives the reactivated Agent.
    await ctx.agentTeam.suspendMember({ requestId: requestId('persisted-model-suspend'), memberId: added.status.member.memberId })
    await teamFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    await ctx.agentTeam.resumeMember({ requestId: requestId('persisted-model-resume'), memberId: added.status.member.memberId })
    const resumed = await waitFor(() => {
      const restarted = ctx.agents.get(added.status.member.sessionId)
      return restarted !== undefined && restarted.status === 'idle' ? restarted : undefined
    })
    adapter.enqueue(textResponse('after the restart.'))
    resumed.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the switched model after the restart.' }], source: { kind: 'user' } }))
    await resumed.whenIdle()
    expect(adapter.requests.at(-1)).toMatchObject({ provider: 'mock', model: 'switched-model' })
    expect(ctx.agentTeam.members().find(entry => entry.member.memberId === added.status.member.memberId)!.availability).toBe('active')
  })

  it('applies Member model edits to a live Agent immediately and keeps pinned selections across restarts', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const createSpy = vi.spyOn(ctx.agents, 'create')
    const resumeSpy = vi.spyOn(ctx.agents, 'resume')
    // Activation goes through create or resume depending on whether the
    // Session transcript has been persisted yet; both carry agentOptions.
    const lastActivationOptions = () => {
      const call = resumeSpy.mock.calls.at(-1) ?? createSpy.mock.calls.at(-1)
      expect(call).toBeDefined()
      return call![0]!.agentOptions
    }
    const clearActivationSpies = () => { createSpy.mockClear(); resumeSpy.mockClear() }
    const project = await ctx.agentTeam.createProject({ requestId: requestId('model-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('model-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member',
      projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'pinned-model' },
    })
    const liveAgent = () => ctx.agents.get(added.status.member.sessionId)!
    // Creation activates with the pinned selection instead of the Host default.
    expect(added.status.member.model).toEqual({ provider: 'mock', model: 'pinned-model' })
    expect(lastActivationOptions()).toMatchObject({ provider: 'mock', model: 'pinned-model' })
    const liveBeforeEdit = liveAgent()

    // Editing the model on the ACTIVE Member updates the live selection in
    // place — the same Session id remains usable by the Web Composer.
    clearActivationSpies()
    const edited = await ctx.agentTeam.updateMember({
      requestId: requestId('re-model'), memberId: added.status.member.memberId,
      handle: 'builder', description: 'Builds the implementation',
      model: { provider: 'mock', model: 'switched-model' },
    })
    expect(edited.status.availability).toBe('active')
    expect(edited.status.member.sessionId).toBe(added.status.member.sessionId)
    expect(liveAgent()).toBe(liveBeforeEdit)
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
    adapter.enqueue(textResponse('switched response'))
    liveAgent().followup(createUserMessage({ content: [{ type: 'text', text: 'Use the switched model.' }], source: { kind: 'user' } }))
    await liveAgent().whenIdle()
    expect(adapter.requests.at(-1)).toMatchObject({ provider: 'mock', model: 'switched-model' })

    // A display-only edit that re-states the current pin leaves the live
    // Agent untouched; an edit that OMITS model clears the override (below).
    clearActivationSpies()
    await ctx.agentTeam.updateMember({ requestId: requestId('desc-only'), memberId: added.status.member.memberId, handle: 'builder', description: 'Builds things', model: { provider: 'mock', model: 'switched-model' } })
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()

    // Clearing the override updates the same live Agent back to the Host default.
    clearActivationSpies()
    const cleared = await ctx.agentTeam.updateMember({ requestId: requestId('clear-model'), memberId: added.status.member.memberId, handle: 'builder', description: 'Builds things', model: null })
    expect(cleared.status.member.model).toBeUndefined()
    expect(cleared.status.availability).toBe('active')
    expect(createSpy).not.toHaveBeenCalled()
    expect(resumeSpy).not.toHaveBeenCalled()

    // A pinned selection survives suspend/resume without any further edit.
    await ctx.agentTeam.updateMember({ requestId: requestId('repin'), memberId: added.status.member.memberId, handle: 'builder', description: 'Builds things', model: { provider: 'mock', model: 'pinned-again' } })
    await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId: added.status.member.memberId })
    clearActivationSpies()
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume'), memberId: added.status.member.memberId })
    expect(resumed.status.member.model).toEqual({ provider: 'mock', model: 'pinned-again' })
    expect(lastActivationOptions()).toMatchObject({ provider: 'mock', model: 'pinned-again' })
  })
})

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before the deadline')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('Agent Team Member lifecycle: context, acceptance, and activation (ticket 04)', () => {
    it('leaves an acceptance below the budget as a reminder alone', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('noauto-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('noauto-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      pressureState.usageTokens = 0
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('noauto-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the release', recipients: [memberId] })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const live = ctx.agents.get(added.status.member.sessionId)!
      await waitForIdle(ctx, live)
      const read = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('noauto-read'), workspaceId, taskRef: started.task!.taskRef })
      const claim = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('noauto-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: read.thread.revision, direction: 'own the fix' })
      if (claim.kind !== 'committed') throw new Error(`expected committed claim, received ${claim.kind}`)
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('noauto-human-read'), workspaceId, taskRef: started.task!.taskRef })
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('noauto-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
      // Read the acceptance back as the contributor: a small context gets the
      // reminder and nothing else — acceptance is a semantic cue, never an
      // unconditional summarization job.
      await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('noauto-contributor-read'), workspaceId, taskRef: started.task!.taskRef })
      const queued = [...live.inbox.nextStep, ...live.inbox.nextTurn].filter(message => isAcceptanceNotice(message))
      expect(queued).toHaveLength(1)
      // The reminder must not promise a compaction the budget did not reach.
      expect(JSON.stringify(queued[0]!.content)).not.toContain('compacted')
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!
      expect(status.availability).toBe('active')
      expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    })

    it('compacts a contributor over the budget once the turn ends, and tells it so', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('budget-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('budget-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      pressureState.usageTokens = 0
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('budget-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the release', recipients: [memberId] })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const live = ctx.agents.get(added.status.member.sessionId)!
      await waitForIdle(ctx, live)
      const read = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('budget-read'), workspaceId, taskRef: started.task!.taskRef })
      const claim = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('budget-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: read.thread.revision, direction: 'own the fix' })
      if (claim.kind !== 'committed') throw new Error(`expected committed claim, received ${claim.kind}`)
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('budget-human-read'), workspaceId, taskRef: started.task!.taskRef })
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('budget-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
      pressureState.usageTokens = ACCEPTANCE_COMPACT_TOKENS + 1
      const compactions: string[] = []
      const engine = { compactNow: async (agent: { id: string }, signal: AbortSignal): Promise<null> => {
        // The engine is only legal once the Agent settles: the loop refuses a
        // maintenance phase while a turn runs.
        compactions.push(`${agent.id}:${signal.aborted ? 'aborted' : 'live'}`)
        return null
      } }
      const serviceFor = vi.spyOn(ctx.agentPresets, 'serviceFor').mockReturnValue(engine as never)
      try {
        await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('budget-contributor-read'), workspaceId, taskRef: started.task!.taskRef })
        const queued = [...live.inbox.nextStep, ...live.inbox.nextTurn].filter(message => isAcceptanceNotice(message))
        expect(queued).toHaveLength(1)
        // The reminder states the consequence, because this time it is true.
        expect(JSON.stringify(queued[0]!.content)).toContain('compacted once the Agent settles')
        await waitFor(() => compactions.length > 0 ? compactions : undefined)
        expect(compactions[0]!.startsWith(live.id)).toBe(true)
      } finally {
        serviceFor.mockRestore()
      }
    })

    it('leaves a follower that owns no accepted work alone', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('bystander-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('bystander-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const watcher = await ctx.agentTeam.addMember({ requestId: requestId('bystander-watcher'), workspaceId, handle: 'watcher', description: 'Watches the work', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      pressureState.usageTokens = 0
      // Both are recipients and both end up following the Thread (the builder by
      // claiming, the watcher explicitly): the difference under test is that only
      // the builder ever claimed work on it.
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('bystander-task'), workspaceId, projectRef: project.project.projectRef, body: 'Investigate the release', recipients: [builder.status.member.memberId, watcher.status.member.memberId] })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const builderAgent = ctx.agents.get(builder.status.member.sessionId)!
      const watcherAgent = ctx.agents.get(watcher.status.member.sessionId)!
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, watcherAgent)
      const builderRead = await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('bystander-builder-read'), workspaceId, taskRef: started.task!.taskRef })
      // The watcher follows the Thread but stays behind the accept, so the
      // accept reaches it as ordinary unread rather than as a mention.
      await ctx.agentTeam.readThreadForAgent(watcherAgent, { requestId: requestId('bystander-watcher-read'), workspaceId, taskRef: started.task!.taskRef })
      await ctx.agentTeam.changeAttentionForAgent(watcherAgent, { requestId: requestId('bystander-watcher-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
      const claim = await ctx.agentTeam.changeClaimForAgent(builderAgent, { requestId: requestId('bystander-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: builderRead.thread.revision, direction: 'own the fix' })
      if (claim.kind !== 'committed') throw new Error(`expected committed claim, received ${claim.kind}`)
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, watcherAgent)
      // Drain the claim activity so the accept below is the only unread fact
      // the watcher still holds.
      await ctx.agentTeam.readThreadForAgent(watcherAgent, { requestId: requestId('bystander-watcher-claim-read'), workspaceId, taskRef: started.task!.taskRef })
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('bystander-human-read'), workspaceId, taskRef: started.task!.taskRef })
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('bystander-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, watcherAgent)
      // Over the budget, so only the ownership check can keep the watcher out.
      pressureState.usageTokens = ACCEPTANCE_COMPACT_TOKENS * 2
      const watcherRead = await ctx.agentTeam.readThreadForAgent(watcherAgent, { requestId: requestId('bystander-watcher-accept-read'), workspaceId, taskRef: started.task!.taskRef })
      expect(watcherRead.facts.some(entry => entry.unread && entry.fact.kind === 'activity' && entry.fact.activity.kind === 'accept')).toBe(true)
      expect([...watcherAgent.inbox.nextStep, ...watcherAgent.inbox.nextTurn].some(message => isAcceptanceNotice(message))).toBe(false)
      expect(acceptanceReminders(watcherAgent)).toHaveLength(0)
    })

    it('resolves the same Host policy through the real preset engine scope', async () => {
      const { ctx, workspaceId } = await realHarness(new ScriptedAdapter(), 'jsonl', undefined, true)
      const added = await ctx.agentTeam.addMember({ requestId: requestId('engine-scope'), workspaceId,
        handle: 'builder', description: '', presetId: 'team-member', projectRefs: [] })
      expect(added.status.availability).toBe('active')
      const live = ctx.agents.get(added.status.member.sessionId)!
      const engine = ctx.agentPresets.serviceFor(live, 'compaction') as unknown as { ctx: Context }
      expect(engine.ctx.get('agentTeam')?.config.memberCompaction).toBe(ctx.agentTeam.config.memberCompaction)
    })

    it('compacts a Member through the preset engine at the configured budget', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('hard-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('hard-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const live = ctx.agents.get(added.status.member.sessionId)!

      const compactions: string[] = []
      const engine = {
        compactIfNeeded: async (_agent: unknown, trigger: string) => {
          compactions.push(trigger)
          pressureState.usageTokens = 0
          return null
        },
      }
      const serviceFor = vi.spyOn(ctx.agentPresets, 'serviceFor').mockImplementation((_agent, service) => service === 'compaction' ? engine as never : undefined)
      try {
        // Below the boundary, a turn runs to completion without compaction.
        pressureState.usageTokens = MEMBER_COMPACT_TOKENS - 1
        adapter.enqueue(textResponse('First answer.'))
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'First question?' }], source: { kind: 'user' } }))
        await waitForIdle(ctx, live)
        expect(compactions).toHaveLength(0)

        pressureState.usageTokens = MEMBER_COMPACT_TOKENS + 1
        adapter.enqueue(textResponse('Second answer.'))
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'Second question?' }], source: { kind: 'user' } }))
        await waitFor(() => compactions.length > 0 ? compactions : undefined)
        await waitForIdle(ctx, live)
        expect(compactions).toHaveLength(1)
        expect(compactions).toEqual(['context-overflow'])
      } finally {
        serviceFor.mockRestore()
      }
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)).toBeDefined()
    })

    it('uses the window ratio for a 272K Member instead of skipping its budget', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('small-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('small-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const live = ctx.agents.get(added.status.member.sessionId)!

      adapter.resolveModelWindow = () => 272_000
      let compacted = 0
      const engine = {
        compactIfNeeded: async () => { compacted += 1; pressureState.usageTokens = 0; return null },
      }
      const serviceFor = vi.spyOn(ctx.agentPresets, 'serviceFor').mockImplementation((_agent, service) => service === 'compaction' ? engine as never : undefined)
      try {
        pressureState.usageTokens = 217_601
        adapter.enqueue(textResponse('Answer.'))
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'Question?' }], source: { kind: 'user' } }))
        await waitForIdle(ctx, live)
        expect(compacted).toBe(1)
      } finally {
        serviceFor.mockRestore()
      }
    })

    it('wakes a normal-accept contributor with both the accepted and completed Claim semantics', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('notify-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('notify-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('notify-reviewer'), workspaceId, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('notify-task'), workspaceId, projectRef: project.project.projectRef, body: 'Ship both semantics', recipients: [builder.status.member.memberId, reviewer.status.member.memberId] })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const builderAgent = ctx.agents.get(builder.status.member.sessionId)!
      const reviewerAgent = ctx.agents.get(reviewer.status.member.sessionId)!
      adapter.enqueue(textResponse('builder saw the task.'))
      adapter.enqueue(textResponse('reviewer saw the task.'))
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, reviewerAgent)
      // Advance both members' read watermarks so their initial-start unread
      // facts are consumed: a member with no unread facts is not woken by the
      // other member's Claim mutations, which keeps the scripted wake turns
      // below attributable to exactly one member at a time.
      await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('notify-builder-initial-read'), workspaceId, taskRef: started.task!.taskRef })
      await ctx.agentTeam.readThreadForAgent(reviewerAgent, { requestId: requestId('notify-reviewer-initial-read'), workspaceId, taskRef: started.task!.taskRef })

      // builder: finished its Claim before the accept (normal flow). Each
      // mutation wakes only the OTHER following member with an unread
      // activity (a member's own activity is never unread to itself), so one
      // scripted response per commit suffices; the mutating member itself
      // stays idle and the helper resolves immediately for it.
      adapter.enqueue(textResponse('reviewer saw the claim.'))
      const builderRead = await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('notify-builder-read'), workspaceId, taskRef: started.task!.taskRef })
      const builderClaim = await ctx.agentTeam.changeClaimForAgent(builderAgent, { requestId: requestId('notify-builder-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: builderRead.thread.revision, direction: 'implement' })
      if (builderClaim.kind !== 'committed') throw new Error(`expected committed claim, received ${builderClaim.kind}`)
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, reviewerAgent)
      // Consume the claim activity so later wake turns stay attributable to
      // exactly one mutation at a time.
      await ctx.agentTeam.readThreadForAgent(reviewerAgent, { requestId: requestId('notify-reviewer-claim-read'), workspaceId, taskRef: started.task!.taskRef })
      adapter.enqueue(textResponse('reviewer saw the completion.'))
      const builderRead2 = await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('notify-builder-read-2'), workspaceId, taskRef: started.task!.taskRef })
      const builderDone = await ctx.agentTeam.changeClaimForAgent(builderAgent, { requestId: requestId('notify-builder-done'), workspaceId, taskRef: started.task!.taskRef, action: 'done', claimRef: (builderClaim as { claim: { claimRef: AgentTeamClaimRef } }).claim.claimRef, baseRevision: builderRead2.thread.revision })
      if (builderDone.kind !== 'committed') throw new Error(`expected committed done, received ${builderDone.kind}`)
      await waitForIdle(ctx, builderAgent)
      await waitForIdle(ctx, reviewerAgent)
      await ctx.agentTeam.readThreadForAgent(reviewerAgent, { requestId: requestId('notify-reviewer-done-read'), workspaceId, taskRef: started.task!.taskRef })
      // reviewer: still holds an active Claim at accept time (early accept).
      adapter.enqueue(textResponse('builder saw the review claim.'))
      const reviewerRead = await ctx.agentTeam.readThreadForAgent(reviewerAgent, { requestId: requestId('notify-reviewer-read'), workspaceId, taskRef: started.task!.taskRef })
      const reviewerClaim = await ctx.agentTeam.changeClaimForAgent(reviewerAgent, { requestId: requestId('notify-reviewer-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: reviewerRead.thread.revision, direction: 'review' })
      if (reviewerClaim.kind !== 'committed') throw new Error(`expected committed claim, received ${reviewerClaim.kind}`)
      await waitForIdle(ctx, reviewerAgent)
      await waitForIdle(ctx, builderAgent)
      await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('notify-builder-review-read'), workspaceId, taskRef: started.task!.taskRef })

      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('notify-human-read'), workspaceId, taskRef: started.task!.taskRef })
      adapter.enqueue(textResponse('I saw the acceptance.'))
      adapter.enqueue(textResponse('I saw the atomic completion.'))
      // Register the idle waits BEFORE the commit as pure event listeners:
      // both members are idle now and the helper would resolve immediately,
      // so a dedicated listener-only wait is required to observe the wake
      // turns the acceptance is about to start.
      const idleAfterWake = (agent: { id: string }): Promise<void> => new Promise(resolve => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject !== agent || status !== 'idle') return
          dispose()
          resolve()
        })
      })
      const builderIdle = idleAfterWake(builderAgent)
      const reviewerIdle = idleAfterWake(reviewerAgent)
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('notify-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)

      // Both contributors wake; the notice for the already-done owner names
      // the acceptance of its done Claim, the early-completed one names the
      // atomic completion. The two agents share one adapter, so attribute the
      // wake requests by the responding session's own history, not by queue
      // position: each agent's last request is the accept wake turn.
      await builderIdle
      await reviewerIdle
      const builderClaimRef = (builderClaim as { claim: { claimRef: string } }).claim.claimRef
      const reviewerClaimRef = (reviewerClaim as { claim: { claimRef: string } }).claim.claimRef
      // Attribute the wake requests by agent id (the request's sessionId is
      // the agent's session id), not by adapter queue position: the two agents
      // share one adapter and their turns interleave.
      const requestsFor = (agent: { id: string }): string[] =>
        adapter.requestSessions.map((sessionId, at) => sessionId === agent.id ? at : -1)
          .filter(at => at >= 0).map(at => JSON.stringify(adapter.requests[at]!.messages))
      const builderRequest = requestsFor(builderAgent).at(-1)!
      const reviewerRequest = requestsFor(reviewerAgent).at(-1)!
      expect(builderRequest).toContain('accept')
      expect(builderRequest).toContain(builderClaimRef)
      expect(reviewerRequest).toContain(reviewerClaimRef)
      expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    })

    it('names the atomic completion without an empty finished-Claim clause when the only Claim was early-accepted', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('emptyclause-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('emptyclause-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('emptyclause-task'), workspaceId, projectRef: project.project.projectRef, body: 'Ship the early accept', recipients: [builder.status.member.memberId] })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      const builderAgent = ctx.agents.get(builder.status.member.sessionId)!
      adapter.enqueue(textResponse('builder saw the task.'))
      await waitForIdle(ctx, builderAgent)
      await ctx.agentTeam.readThreadForAgent(builderAgent, { requestId: requestId('emptyclause-initial-read'), workspaceId, taskRef: started.task!.taskRef })
      // The owner still holds an ACTIVE Claim at accept time (early accept):
      // the accept completes it atomically, so acceptedOwn === completedOwn
      // for this reader. The combined-semantics branch must not then render
      // an empty "finished Claim" list — regression against the review
      // finding on commit afd2c16.
      const claimed = await ctx.agentTeam.changeClaimForAgent(builderAgent, { requestId: requestId('emptyclause-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: started.thread.revision, direction: 'implement' })
      if (claimed.kind !== 'committed') throw new Error(`expected committed claim, received ${claimed.kind}`)
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('emptyclause-human-read'), workspaceId, taskRef: started.task!.taskRef })
      adapter.enqueue(textResponse('builder saw the atomic completion.'))
      const builderIdle = new Promise<void>(resolve => {
        const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
          if (subject !== builderAgent || status !== 'idle') return
          dispose()
          resolve()
        })
      })
      const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('emptyclause-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
      if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
      await builderIdle
      const claimRef = (claimed as { claim: { claimRef: string } }).claim.claimRef
      const builderRequest = JSON.stringify(adapter.requests.at(-1)!.messages)
      expect(builderRequest).toContain('accept')
      // The single-Claim early-accept owner gets the completed semantics
      // alone, naming the Claim the acceptance completed — never an empty
      // "finished Claim" clause.
      expect(builderRequest).toContain('your open Claim')
      expect(builderRequest).toContain(claimRef)
      expect(builderRequest).toContain('was completed with it')
      expect(builderRequest).not.toContain('finished Claim')
      expect(builderRequest).not.toMatch(/Claim\s{2,}/)
      expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    })

    it('blocks activation with a session-refused diagnostic when the current binding is refused, and a restart replays the deterministic refusal', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, teamFiber: initialFiber } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('ref-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('ref-add'), workspaceId, handle: 'refused', description: 'Refused binding', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      expect(added.status.availability).toBe('active')

      // The Member's own current Session becomes deterministically refused.
      // A Host restart re-activates from the persisted binding and must block
      // with the structured refusal diagnostic — not a raw error string.
      const realOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      ctx.sessionPersistence.open = async (id, access, options) => {
        if (id === sessionId) throw new SessionFormatUnsupportedError('cannot safely transform unclassified message source (test seam)')
        return realOpen(id, access, options)
      }
      await initialFiber.dispose()
      await new Promise(resolve => setImmediate(resolve))
      await ctx.plugin(AgentTeam)
      const blocked = await waitFor(() => {
        const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        return status !== undefined && status.availability === 'unavailable' ? status : undefined
      })
      expect(blocked.diagnostic).toMatchObject({ class: 'session-refused', sessionId, detail: 'cannot safely transform unclassified message source (test seam)' })

      // No write-side repair pass exists anymore: the read-time conversion owns
      // V3 history, and this bundle no longer authors the refused wrapper
      // shape. A restart therefore re-runs the activation, which replays the
      // deterministic refusal and reports it again — never silently, and never
      // claiming the refusal was healed.
      const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('ref-recover'), workspaceId, memberId })
      expect(recovered.status.availability).toBe('unavailable')
      expect(recovered.status.diagnostic).toMatchObject({ class: 'session-refused', sessionId, detail: 'cannot safely transform unclassified message source (test seam)' })
      expect(ctx.agents.get(sessionId)).toBeUndefined()
    })

    it('recovers a member by re-running activation once the refusal is gone', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, teamFiber: initialFiber } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('heal-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('heal-add'), workspaceId, handle: 'healing', description: 'Heal retry', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId

      const realOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      ctx.sessionPersistence.open = async (id, access, options) => {
        if (id === sessionId) throw new SessionFormatUnsupportedError('cannot safely transform unclassified message source (test seam)')
        return realOpen(id, access, options)
      }
      await initialFiber.dispose()
      await new Promise(resolve => setImmediate(resolve))
      await ctx.plugin(AgentTeam)
      await waitFor(() => {
        const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        return status !== undefined && status.availability === 'unavailable' ? status : undefined
      })

      // The refusal was transient (an out-of-band repair removed it): the
      // restart retry path re-runs the activation, which now succeeds.
      ctx.sessionPersistence.open = realOpen
      const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('heal-recover'), workspaceId, memberId })
      expect(recovered.status.availability).toBe('active')
      expect(recovered.status.diagnostic).toBeUndefined()
    })

    it('logs a warning with the member handle when activation fails', async () => {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, presets, teamFiber: initialFiber } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('p3-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('p3-add'), workspaceId, handle: 'p3member', description: 'P3 failure visibility', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId

      // A restart against a broken preset fails the activation; the operator
      // must see the member handle in a warning line, not only in the status
      // diagnostic.
      presets.failingMount = true
      const warn = vi.spyOn(ctx.logger, 'warn')
      await initialFiber.dispose()
      await new Promise(resolve => setImmediate(resolve))
      await ctx.plugin(AgentTeam)
      await waitFor(() => {
        const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        return status !== undefined && status.availability === 'unavailable' && status.diagnostic?.class === 'preset-composition' ? status : undefined
      })
      const failures = warn.mock.calls.map(args => String(args[0])).filter(text => text.includes('activation failed'))
      expect(failures.length).toBeGreaterThan(0)
      expect(failures.some(text => text.includes('p3member'))).toBe(true)
      warn.mockRestore()
    })
})

describe('Agent Team Member private memory directory sanitization (issue #7)', () => {
  it('derives a Windows-safe directory segment without touching the member ref', async () => {
    const { memberMemoryDirectoryName } = await import('../src/member-runtime.ts')
    const memberId = 'member:9d903b7c-0f9f-4d7c-8be9-3f5c0f8f1a2b' as AgentTeamMemberId
    expect(memberMemoryDirectoryName(memberId)).toBe('member-9d903b7c-0f9f-4d7c-8be9-3f5c0f8f1a2b')
    // No path-segment-forbidden characters remain on any platform.
    expect(memberMemoryDirectoryName(memberId)).not.toContain(':')
  })

  it('sanitizes only the final segment of a legacy colon path on any platform', async () => {
    // F8: the fallback must be segment arithmetic, not whole-string length
    // math on the memberId. A Windows drive-letter prefix keeps its colon; a
    // recorded path whose final segment is not the memberId no longer
    // crashes and still resolves to the member's sanitized directory.
    const { memberMemoryDirectoryPath } = await import('../src/member-runtime.ts')
    const memberId = 'member:1a2b3c4d-0000-4000-8000-000000000001' as AgentTeamMemberId
    expect(memberMemoryDirectoryPath({ memberId, privateMemoryPath: '/home/yu/.dsh/agent-team/members/member:1a2b3c4d-0000-4000-8000-000000000001' }))
      .toBe('/home/yu/.dsh/agent-team/members/member-1a2b3c4d-0000-4000-8000-000000000001')
    expect(memberMemoryDirectoryPath({ memberId, privateMemoryPath: 'C:\\Users\\team\\.dsh\\agent-team\\members\\member:1a2b3c4d-0000-4000-8000-000000000001' }))
      .toBe('C:\\Users\\team\\.dsh\\agent-team\\members\\member-1a2b3c4d-0000-4000-8000-000000000001')
    // A colon-free final segment keeps the recorded path verbatim even when
    // earlier segments carry the Windows drive-letter colon — a member
    // record without a memberId never reaches the rewrite branch.
    expect(memberMemoryDirectoryPath({ memberId: undefined as never, privateMemoryPath: 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\team-member-memory-x' }))
      .toBe('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\team-member-memory-x')
    expect(memberMemoryDirectoryPath({ memberId, privateMemoryPath: 'C:\\dsh-homes\\team\\.dsh\\agent-team\\members\\a1' }))
      .toBe('C:\\dsh-homes\\team\\.dsh\\agent-team\\members\\a1')
    // A colon in the final segment without any separator collapses to the
    // sanitized member name.
    expect(memberMemoryDirectoryPath({ memberId, privateMemoryPath: 'member:1a2b3c4d-0000-4000-8000-000000000001' }))
      .toBe('member-1a2b3c4d-0000-4000-8000-000000000001')
  })

  it('provisions new Members under a colon-free private memory path', async () => {
    const { ctx, workspaceId } = await realHarness()
    await ctx.agentTeam.createProject({ requestId: requestId('san-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('san-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', projectRefs: [] })
    const member = added.status.member
    expect(member.memberId).toContain(':')
    // The colon-free guarantee is about the directory segment: a Windows
    // absolute prefix still carries its drive-letter colon (F7b).
    const recordedDirectory = member.privateMemoryPath.replaceAll('\\', '/')
    expect(basename(recordedDirectory)).not.toContain(':')
    expect(recordedDirectory).toContain(member.memberId.replaceAll(':', '-'))
    await expect(access(join(member.privateMemoryPath, 'notes'))).resolves.toBeUndefined()
    await expect(access(join(member.privateMemoryPath, 'skills'))).resolves.toBeUndefined()
    await expect(access(join(member.privateMemoryPath, 'memory.md'))).resolves.toBeUndefined()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('migrates a legacy colon directory onto the sanitized path on activation, preserving memory', async () => {
    const { ctx } = await realHarness()
    // Exercise the migration seam directly with a synthetic pre-fix Member
    // record: the ledger recorded the colon path and the colon directory
    // holds the Member's existing private memory. On Windows the colon
    // directory cannot be constructed at all (NTFS parses it as an ADS
    // separator), so the legacy record there is the path-only form (F7c).
    const memberId = 'member:1a2b3c4d-0000-4000-8000-000000000001' as AgentTeamMemberId
    const parent = join(process.env.DSH_HOME!, 'agent-team', 'members')
    const legacyPath = join(parent, memberId)
    const sanitized = join(parent, memberId.replaceAll(':', '-'))
    const legacyDirectoryExists = process.platform !== 'win32'
    if (legacyDirectoryExists) {
      await mkdir(join(legacyPath, 'notes'), { recursive: true })
      await writeFile(join(legacyPath, 'notes', 'kept.md'), 'persistent note')
      await writeFile(join(legacyPath, 'memory.md'), '# Member memory\n\n## Stable facts\n- legacy fact\n')
    }

    const { MemberRuntime } = await import('../src/member-runtime.ts')
    const runtime = new MemberRuntime({ ctx: ctx as never, liveMemberContext: () => { throw new Error('unused') }, runningAgents: new Set() })
    await runtime.initializePrivateMemory(sanitized, legacyPath)

    if (legacyDirectoryExists) {
      // The sanitized directory now holds the migrated memory; the colon
      // directory is gone (renamed, not copied).
      await expect(readFile(join(sanitized, 'notes', 'kept.md'), 'utf8')).resolves.toBe('persistent note')
      await expect(readFile(join(sanitized, 'memory.md'), 'utf8')).resolves.toContain('legacy fact')
      await expect(access(legacyPath)).rejects.toThrow()
    } else {
      // Windows: no legacy directory could exist, so activation provisions
      // the sanitized directory from scratch without throwing.
      await expect(access(join(sanitized, 'notes'))).resolves.toBeUndefined()
    }

    // Re-running activation is idempotent: sanitized wins, no throw.
    await runtime.initializePrivateMemory(sanitized, legacyPath)
    if (legacyDirectoryExists) {
      await expect(readFile(join(sanitized, 'notes', 'kept.md'), 'utf8')).resolves.toBe('persistent note')
    }
  })

  it('refuses to migrate recorded private memory that lives under another DSH home', async () => {
    const { ctx, root } = await realHarness()
    // The recorded path is a durable absolute fact. In a process resolving a
    // different DSH home (an isolated test home, a second instance) the
    // sanitized target lands in THAT home while the record still names the real
    // Member directory; renaming across trees took one whole private memory out
    // of ~/.dsh on 2026-09-13, silently. The live harness keeps DSH_HOME at
    // <root>/dsh-home, so <root>/other-home is a foreign home.
    const memberId = 'member:1a2b3c4d-0000-4000-8000-000000000003' as AgentTeamMemberId
    const legacyPath = join(root, 'other-home', 'agent-team', 'members', memberId.replaceAll(':', '-'))
    await mkdir(join(legacyPath, 'notes'), { recursive: true })
    await writeFile(join(legacyPath, 'notes', 'kept.md'), 'real private memory')
    const sanitized = join(process.env.DSH_HOME!, 'agent-team', 'members', memberId.replaceAll(':', '-'))

    const { MemberRuntime } = await import('../src/member-runtime.ts')
    const runtime = new MemberRuntime({ ctx: ctx as never, liveMemberContext: () => { throw new Error('unused') }, runningAgents: new Set() })
    await runtime.initializePrivateMemory(sanitized, legacyPath)

    // The foreign directory is untouched — not moved, and not copied either: a
    // copy would leak the Member's private memory into the foreign home.
    await expect(readFile(join(legacyPath, 'notes', 'kept.md'), 'utf8')).resolves.toBe('real private memory')
    await expect(access(join(legacyPath, 'memory.md'))).rejects.toThrow()
    // This home still provisions the Member, from scratch and in place.
    await expect(readFile(join(sanitized, 'memory.md'), 'utf8')).resolves.toContain('# Member memory')
    await expect(access(join(sanitized, 'notes'))).resolves.toBeUndefined()
  })

  it('deletes recorded private memory only inside this DSH home', async () => {
    const { ctx, root, archived } = await realHarness()
    const { MemberRuntime } = await import('../src/member-runtime.ts')
    const runtime = new MemberRuntime({ ctx: ctx as never, liveMemberContext: () => { throw new Error('unused') }, runningAgents: new Set() })

    // A removal running under another DSH home must not delete the directory
    // the record names: that is the real Member's private memory, and this is
    // the shape that wiped three live directories on 2026-08-23.
    const foreignId = 'member:1a2b3c4d-0000-4000-8000-000000000004' as AgentTeamMemberId
    // Containment is about the location, not the spelling: this arm only needs
    // a directory outside this process's members root, so it uses the sanitized
    // name — win32 cannot create a colon directory at all (the colon is an NTFS
    // alternate-data-stream separator, so mkdir reports ENOENT). The colon
    // spelling is covered by the same-home arm below, gated to the platforms
    // that can hold such a directory.
    const foreignPath = join(root, 'other-home', 'agent-team', 'members', foreignId.replaceAll(':', '-'))
    await mkdir(join(foreignPath, 'notes'), { recursive: true })
    await writeFile(join(foreignPath, 'notes', 'kept.md'), 'real private memory')
    await runtime.cleanupRemovedMember({ memberId: foreignId, sessionId: SessionId('session:probe-foreign-cleanup'), privateMemoryPath: foreignPath } as never)
    await expect(readFile(join(foreignPath, 'notes', 'kept.md'), 'utf8')).resolves.toBe('real private memory')

    // Same home: both the recorded legacy colon directory and its sanitized
    // spelling are this process's to remove.
    const parent = join(process.env.DSH_HOME!, 'agent-team', 'members')
    const localId = 'member:1a2b3c4d-0000-4000-8000-000000000005' as AgentTeamMemberId
    const colonPath = join(parent, localId)
    const sanitizedPath = join(parent, localId.replaceAll(':', '-'))
    const colonDirectoryExists = process.platform !== 'win32'
    if (colonDirectoryExists) await mkdir(join(colonPath, 'notes'), { recursive: true })
    await mkdir(join(sanitizedPath, 'notes'), { recursive: true })
    await runtime.cleanupRemovedMember({ memberId: localId, sessionId: SessionId('session:probe-local-cleanup'), privateMemoryPath: colonPath } as never)
    await expect(access(sanitizedPath)).rejects.toThrow()
    if (colonDirectoryExists) await expect(access(colonPath)).rejects.toThrow()

    // The refusal is scoped to the filesystem: both Sessions are archived.
    expect(archived).toEqual([SessionId('session:probe-foreign-cleanup'), SessionId('session:probe-local-cleanup')])
  })

  it('merges a hand-created colon twin directory into the sanitized root on activation', async () => {
    const { ctx } = await realHarness()
    const memberId = 'member:1a2b3c4d-0000-4000-8000-000000000002' as AgentTeamMemberId
    const parent = join(process.env.DSH_HOME!, 'agent-team', 'members')
    const sanitized = join(parent, memberId.replaceAll(':', '-'))
    const twin = join(parent, memberId)
    const twinDirectoryExists = process.platform !== 'win32'
    // The live root pre-exists (the injected paths and skill provider point
    // at it) with its own memory.md and one note the twin does not know.
    await mkdir(join(sanitized, 'notes'), { recursive: true })
    await writeFile(join(sanitized, 'memory.md'), '# Member memory\n\n## Stable facts\n- live root fact\n')
    await writeFile(join(sanitized, 'notes', 'live-only.md'), 'live root note')
    if (twinDirectoryExists) {
      await mkdir(join(twin, 'notes'), { recursive: true })
      await writeFile(join(twin, 'notes', 'twin-only.md'), 'twin note')
      await writeFile(join(twin, 'memory.md'), '# Member memory\n\n## Stable facts\n- twin fact\n')
      // A nested twin-only skill survives the merge at its own relative path.
      await mkdir(join(twin, 'skills', 'probe'), { recursive: true })
      await writeFile(join(twin, 'skills', 'probe', 'SKILL.md'), 'twin skill')
    }

    const { MemberRuntime } = await import('../src/member-runtime.ts')
    const runtime = new MemberRuntime({ ctx: ctx as never, liveMemberContext: () => { throw new Error('unused') }, runningAgents: new Set() })
    // No legacyPath argument: the ledger never recorded the twin.
    await runtime.initializePrivateMemory(sanitized)

    if (twinDirectoryExists) {
      // Content preservation: every twin-only file moved into the live root.
      await expect(readFile(join(sanitized, 'notes', 'twin-only.md'), 'utf8')).resolves.toBe('twin note')
      await expect(readFile(join(sanitized, 'skills', 'probe', 'SKILL.md'), 'utf8')).resolves.toBe('twin skill')
      await expect(readFile(join(sanitized, 'notes', 'live-only.md'), 'utf8')).resolves.toBe('live root note')
      // Conflict resolution is explicit: the live root's memory.md wins; the
      // twin's losing copy stays traceable beside it, never silently dropped.
      await expect(readFile(join(sanitized, 'memory.md'), 'utf8')).resolves.toContain('live root fact')
      await expect(readFile(join(sanitized, 'memory.colon-twin.md'), 'utf8')).resolves.toContain('twin fact')
      // The twin directory itself is gone: the drift cannot silently recur.
      await expect(access(twin)).rejects.toThrow()
    }

    // Idempotent: a second activation without any twin present is a no-op
    // and keeps every merged file.
    await runtime.initializePrivateMemory(sanitized)
    if (twinDirectoryExists) {
      await expect(readFile(join(sanitized, 'notes', 'twin-only.md'), 'utf8')).resolves.toBe('twin note')
      await expect(readFile(join(sanitized, 'memory.md'), 'utf8')).resolves.toContain('live root fact')
      await expect(access(join(sanitized, 'notes'))).resolves.toBeUndefined()
    }
  })
})

describe('Agent Team presence-scope invalidation (issue #21)', () => {
  /** Resolve only after a macrotask so a premature wake-up cannot hide behind microtasks. */
  async function staysPending(promise: Promise<unknown>, ms = 15): Promise<boolean> {
    let settled = false
    void promise.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, ms))
    return !settled
  }

  it('wakes only presence waiters on Agent running/idle and leaves workspace and scope-less waiters parked', async () => {
    const { ctx, workspaceId } = await realHarness(new EmptyAdapter())
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('presence-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    // Presence versions are their own domain, so a presence waiter is parked
    // with a cursor sampled from the presence scope itself.
    const presenceBaseline = await changeBaseline(ctx.agentTeam, { kind: 'presence', workspaceId })
    const presenceWaiter = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    const workspaceWaiter = nextChange(ctx.agentTeam, { kind: 'workspace', workspaceId })
    const unscopedWaiter = nextChange(ctx.agentTeam)
    expect(await staysPending(presenceWaiter)).toBe(true)

    // A turn start (running) and its end (idle) change no durable projection:
    // only the presence waiter wakes, in both directions, and each wake
    // advances that one domain.
    ctx.emit('agent/status', { agent, status: 'running' })
    const runningWake = await presenceWaiter
    expect(runningWake.version).toBeGreaterThan(presenceBaseline.version)
    expect(await staysPending(workspaceWaiter)).toBe(true)
    expect(await staysPending(unscopedWaiter)).toBe(true)

    const idleWaiter = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    ctx.emit('agent/status', { agent, status: 'idle' })
    expect((await idleWaiter).version).toBeGreaterThan(runningWake.version)

    // A ledger commit still reaches the workspace and scope-less waiters, and
    // a fresh presence waiter stays parked through it — and it leaves the
    // projection cursors alone: project creation must refresh the sidebar
    // catalog, never the presence rows.
    const committedWaiter = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    const committedWorkspaceWaiter = nextChange(ctx.agentTeam, { kind: 'workspace', workspaceId })
    await ctx.agentTeam.createProject({ requestId: requestId('presence-project'), workspaceId, name: 'presence-check', description: 'Presence work' })
    expect(await committedWorkspaceWaiter).toMatchObject({ version: expect.any(Number) })
    expect(await staysPending(committedWaiter)).toBe(true)
  })

  it('reports Agent runtime failures through the presence scope only', async () => {
    const { ctx, workspaceId } = await realHarness(new EmptyAdapter())
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('presence-error-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const presenceBaseline = await changeBaseline(ctx.agentTeam, { kind: 'presence', workspaceId })
    const presenceWaiter = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    const unscopedWaiter = nextChange(ctx.agentTeam)
    expect(await staysPending(presenceWaiter)).toBe(true)

    ctx.emit('agent/error', { agent, turn: 1, step: 1, error: new Error('fetch failed') })
    const failureWake = await presenceWaiter
    expect(failureWake.version).toBeGreaterThan(presenceBaseline.version)
    expect(await staysPending(unscopedWaiter)).toBe(true)
  })
})

describe('Agent Team change version domains', () => {
  /** Resolve only after a macrotask so a premature wake-up cannot hide behind microtasks. */
  async function staysPending(promise: Promise<unknown>, ms = 15): Promise<boolean> {
    let settled = false
    void promise.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, ms))
    return !settled
  }

  it('answers no parked Client when a Member read of its own Thread makes progress', async () => {
    const { ctx, workspaceId } = await realHarness(new EmptyAdapter())
    const project = await ctx.agentTeam.createProject({ requestId: requestId('domain-project'), workspaceId, name: 'engineering', description: 'Version domains' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('domain-add'), workspaceId, handle: 'builder', description: 'Reads work', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const live = ctx.agents.get(added.status.member.sessionId)!
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('domain-task'), workspaceId, projectRef: project.project.projectRef, body: 'Unread work', recipients: [added.status.member.memberId] })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)

    const baseline = (await changeBaseline(ctx.agentTeam)).version
    const clients = Array.from({ length: 10 }, (_unused, index) => index % 2 === 0
      ? nextChange(ctx.agentTeam)
      : nextChange(ctx.agentTeam, { kind: 'thread' as const, threadRef: started.thread.threadRef }))
    expect(await Promise.all(clients.map(client => staysPending(client)))).toEqual(clients.map(() => true))

    // One private read that really commits: the Human's anchor is unread for
    // this Member, so a durable thread-read record is appended.
    const read = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('domain-read'), workspaceId, taskRef: started.task!.taskRef })
    expect(read.receipt).toBeDefined()
    expect(read.remainingUnreadCount).toBe(0)

    // The record exists, and still no cursor moved: a private read is not a
    // projection change, so no parked Client is answered by it.
    expect((await changeBaseline(ctx.agentTeam)).version).toBe(baseline)
    expect(await Promise.all(clients.map(client => staysPending(client)))).toEqual(clients.map(() => true))

    // A real Thread change still reaches every parked Client, at the durable
    // position of the commit itself.
    const reply = await ctx.agentTeam.reply({ requestId: requestId('domain-reply'), workspaceId, taskRef: started.task!.taskRef, body: 'Update', baseRevision: started.thread.revision })
    if (reply.kind !== 'committed') throw new Error(`expected committed reply, received ${reply.kind}`)
    expect(await clients[1]!).toMatchObject({ version: reply.receipt.sequence })
    expect(await clients[0]!).toMatchObject({ version: reply.receipt.sequence })
  })

  it('wakes a presence waiter holding another domain cursor without moving any projection cursor', async () => {
    const { ctx, workspaceId } = await realHarness(new EmptyAdapter())
    const added = await ctx.agentTeam.addMember({ requestId: requestId('domain-presence-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    const projection = (await changeBaseline(ctx.agentTeam)).version

    // A cursor taken from the projection domain must never park a presence
    // scope: a presence wake is an edge, not a position comparison.
    const presence = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    expect(await staysPending(presence)).toBe(true)

    ctx.emit('agent/status', { agent, status: 'running' })
    expect(await presence).toMatchObject({ version: expect.any(Number) })

    // The edge left every projection cursor exactly where it was.
    expect((await changeBaseline(ctx.agentTeam)).version).toBe(projection)
    expect(await staysPending(nextChange(ctx.agentTeam))).toBe(true)
  })
})

describe('Agent Team member execution isolation (state-requests 02)', () => {
  it("suspends B while A's capability edit waits for A's turn boundary", async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('isolation-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('isolation-reviewer'), workspaceId,
      handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!

    // A runs a held turn: model call 1 parks until the test releases it.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    // A's capability edit stores its intent, then waits for the turn
    // boundary: it cannot resolve while A keeps running.
    const edit = ctx.agentTeam.updateMember({ requestId: requestId('isolation-edit'), memberId: builder.status.member.memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
    const editOutcome = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])

    // B's suspension must complete while A still runs: one Member's waiting
    // execution may not block lifecycle management of another Member.
    const suspending = ctx.agentTeam.suspendMember({ requestId: requestId('isolation-suspend'), memberId: reviewer.status.member.memberId })
    const suspensionOutcome = await Promise.race([suspending.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 1500) })])

    // Release before asserting so the held turn always ends, red or green.
    adapter.release.resolve()
    const applied = await edit
    const suspended = await suspending

    expect(editOutcome).toBe('pending')
    expect(suspensionOutcome).toBe('settled')
    expect(applied.effect).toBe('applied')
    expect(applied.status.availability).toBe('active')
    expect(applied.status.member.sessionId).toBe(builder.status.member.sessionId)
    expect(applied.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool'] } })
    expect(suspended.status.availability).toBe('suspended')
    expect(ctx.agents.get(reviewer.status.member.sessionId)).toBeUndefined()
    // A's turn ran to completion after the boundary swap, untouched by B's suspension.
    await agent.whenIdle()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('keeps same-Member order: a stop queued behind a parked edit runs after the edit applies', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('order-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const order: string[] = []
    const edit = ctx.agentTeam.updateMember({ requestId: requestId('order-edit'), memberId: builder.status.member.memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
      .then(result => { order.push('edit'); return result })
    const editOutcome = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(editOutcome).toBe('pending')

    const suspending = ctx.agentTeam.suspendMember({ requestId: requestId('order-suspend'), memberId: builder.status.member.memberId })
      .then(result => { order.push('suspend'); return result })
    const stopOutcome = await Promise.race([suspending.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    // Same Member: the stop is queued behind the parked edit, never beside it.
    expect(stopOutcome).toBe('pending')

    adapter.release.resolve()
    const applied = await edit
    const suspended = await suspending
    expect(order).toEqual(['edit', 'suspend'])
    expect(applied.effect).toBe('applied')
    expect(applied.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool'] } })
    expect(suspended.status.availability).toBe('suspended')
    // Stop never clears a committed configuration: the stored intent survives
    // the suspension for the next activation.
    expect(suspended.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool'] } })
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('defers an edit whose stop committed first and applies the stored intent at the next activation', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('deferred-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const memberId = builder.status.member.memberId

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    // The stop commits first and cancels the in-flight turn as soon as its
    // own chain slot runs — it settles while the gate is still held.
    const suspending = ctx.agentTeam.suspendMember({ requestId: requestId('deferred-suspend'), memberId })
    const edit = ctx.agentTeam.updateMember({ requestId: requestId('deferred-edit'), memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
    const requestsBefore = adapter.requests.length

    const suspended = await suspending
    expect(suspended.status.availability).toBe('suspended')
    const deferred = await edit
    expect(deferred.effect).toBe('deferred:no-live-handle')
    expect(deferred.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool'] } })
    expect(deferred.status.capabilityState).toBe('pending')
    expect(adapter.requests.length).toBe(requestsBefore)

    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('deferred-resume'), memberId })
    expect(resumed.status.availability).toBe('active')
    expect(resumed.status.member.sessionId).toBe(builder.status.member.sessionId)
    expect(resumed.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool'] } })
    expect(resumed.status.capabilityState).toBe('applied')
    expect(ctx.agents.get(builder.status.member.sessionId)).toBeDefined()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('activates exactly once when the same add request arrives concurrently', async () => {
    const { ctx, workspaceId } = await realHarness()
    const request = { requestId: requestId('dup-add'), workspaceId, handle: 'duplicate',
      description: 'Concurrent duplicate', presetId: 'team-member', projectRefs: [] }
    const [first, second] = await Promise.all([ctx.agentTeam.addMember(request), ctx.agentTeam.addMember(request)])

    expect(second.status.member.memberId).toBe(first.status.member.memberId)
    expect(second.status.member.sessionId).toBe(first.status.member.sessionId)
    // The hard idempotency evidence: the duplicate resolves to the same
    // committed operation, not a second row.
    expect(second.receipt).toEqual(first.receipt)
    expect(ctx.agentTeam.members().filter(item => item.member.memberId === first.status.member.memberId)).toHaveLength(1)
    const live = ctx.agents.get(first.status.member.sessionId)
    expect(live).toBeDefined()
    expect(ctx.agentTeam.memberForAgent(live!)).toEqual(first.status.member)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('runs distinct add requests concurrently with disjoint members', async () => {
    const { ctx, workspaceId } = await realHarness()
    const [left, right] = await Promise.all([
      ctx.agentTeam.addMember({ requestId: requestId('parallel-left'), workspaceId, handle: 'left',
        description: 'Left member', presetId: 'team-member', projectRefs: [] }),
      ctx.agentTeam.addMember({ requestId: requestId('parallel-right'), workspaceId, handle: 'right',
        description: 'Right member', presetId: 'team-member', projectRefs: [] }),
    ])

    expect(left.status.availability).toBe('active')
    expect(right.status.availability).toBe('active')
    expect(right.status.member.memberId).not.toBe(left.status.member.memberId)
    expect(right.status.member.sessionId).not.toBe(left.status.member.sessionId)
    expect(ctx.agents.get(left.status.member.sessionId)).toBeDefined()
    expect(ctx.agents.get(right.status.member.sessionId)).toBeDefined()
    const handles = ctx.agentTeam.members().map(item => item.member.handle)
    expect(handles).toEqual(expect.arrayContaining(['left', 'right']))
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('drains a parked lifecycle chain on Host shutdown without waiting for the turn to end', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId, teamFiber } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('shutdown-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const edit = ctx.agentTeam.updateMember({ requestId: requestId('shutdown-edit'), memberId: builder.status.member.memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
    const editOutcome = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(editOutcome).toBe('pending')

    // The gate is never released: Host shutdown must finish anyway instead
    // of waiting out a turn that may never end.
    const team = ctx.agentTeam
    const requestsBefore = adapter.requests.length
    const disposal = teamFiber.dispose().then(() => 'disposed' as const)
    const outcome = await Promise.race([disposal,
      new Promise<'stalled'>(resolve => { setTimeout(() => resolve('stalled'), 5000) })])
    // Unblock a stalled (red) shutdown so the suite's own cleanup cannot wedge.
    adapter.release.resolve()
    expect(outcome).toBe('disposed')
    await disposal
    await edit
    // No chain, waiter, or model request survives the shutdown. The instance
    // is held from before disposal: the ctx service accessor is gone after it.
    expect(team['memberLifecycleTails'].size).toBe(0)
    expect(team['additionLifecycleTails'].size).toBe(0)
    expect(team['memberRuntime']['turnWaitResolvers'].size).toBe(0)
    expect(adapter.requests.length).toBe(requestsBefore)
  })

  it('resolves a parked boundary wait when the turn is cancelled', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('cancel-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const edit = ctx.agentTeam.updateMember({ requestId: requestId('cancel-edit'), memberId: builder.status.member.memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
    const editOutcome = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(editOutcome).toBe('pending')

    const requestsBefore = adapter.requests.length
    agent.cancel({ kind: 'user' })
    const settled = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'stalled'>(resolve => { setTimeout(() => resolve('stalled'), 5000) })])
    expect(settled).toBe('settled')
    const applied = await edit
    // The cancellation ended the turn without disposing the generation, so
    // the boundary applies the stored intent — and no model request follows.
    expect(applied.effect).toBe('applied')
    expect(applied.status.availability).toBe('active')
    expect(adapter.requests.length).toBe(requestsBefore)
    expect(ctx.agentTeam['memberLifecycleTails'].size).toBe(0)
    expect(ctx.agentTeam['memberRuntime']['turnWaitResolvers'].size).toBe(0)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('logs each lifecycle wait class with the Member, Session, and duration', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('waitlog-builder'), workspaceId,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
    const memberId = builder.status.member.memberId
    const sessionId = builder.status.member.sessionId
    const agent = ctx.agents.get(sessionId)!
    const info = vi.spyOn(ctx.logger, 'info')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current checkout work.' }], source: { kind: 'user' } }))
    await adapter.started.promise
    const edit = ctx.agentTeam.updateMember({ requestId: requestId('waitlog-edit'), memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['ordinary_tool'] } } })
    const editOutcome = await Promise.race([edit.then(() => 'settled' as const),
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(editOutcome).toBe('pending')
    adapter.release.resolve()
    expect((await edit).effect).toBe('applied')
    await agent.whenIdle()

    // An edit applied to an already-idle Member spends no time waiting and
    // logs no wait line: the log answers "why is this operation slow", not
    // "an operation happened".
    const idleEdit = await ctx.agentTeam.updateMember({ requestId: requestId('waitlog-idle'), memberId,
      handle: 'builder', description: 'Builds changes', capabilities: { tools: { allow: ['spare_tool'] } } })
    expect(idleEdit.effect).toBe('applied')

    // A stop's disposal is external execution — the Agent releasing its
    // Session write path — not the Member's own turn.
    await ctx.agentTeam.suspendMember({ requestId: requestId('waitlog-suspend'), memberId })

    const lines = info.mock.calls.map(args => String(args[0]))
    const turnWaits = lines.filter(line => line.includes("stage 'wait-turn'"))
    expect(turnWaits).toHaveLength(1)
    expect(turnWaits[0]).toContain("member 'builder'")
    expect(turnWaits[0]).toContain(`session '${sessionId}'`)
    expect(turnWaits[0]).toMatch(/waited \d+ms for its turn boundary/)
    const externalWait = lines.find(line => line.includes("stage 'wait-external'"))
    expect(externalWait).toBeDefined()
    expect(externalWait).toContain("member 'builder'")
    expect(externalWait).toContain(`session '${sessionId}'`)
    expect(externalWait).toMatch(/waited \d+ms for the Agent to release its Session write path/)
    info.mockRestore()
  })
})

describe('Agent Team model route rejection (issue #43 #6)', () => {
  it('rejects an unregistered provider at creation instead of deferring to the first turn', async () => {
    const { ctx, workspaceId } = await realHarness(new ScriptedAdapter())
    await expect(ctx.agentTeam.addMember({
      requestId: requestId('bad-provider-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member', projectRefs: [],
      model: { provider: 'no-such-provider', model: 'whatever' },
    })).rejects.toThrow(/provider 'no-such-provider' is not registered/)
  })

  it('rejects an unregistered provider on update too', async () => {
    const { ctx, workspaceId } = await realHarness(new ScriptedAdapter())
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('bad-provider-seed'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member', projectRefs: [],
      model: { provider: 'mock', model: 'fine' },
    })
    await expect(ctx.agentTeam.updateMember({
      requestId: requestId('bad-provider-edit'), memberId: added.status.member.memberId,
      handle: 'builder', description: 'Builds the implementation',
      model: { provider: 'no-such-provider', model: 'whatever' },
    })).rejects.toThrow(/provider 'no-such-provider' is not registered/)
  })

  it('accepts a registered provider and leaves unpinned Members alone', async () => {
    const { ctx, workspaceId } = await realHarness(new ScriptedAdapter())
    const pinned = await ctx.agentTeam.addMember({
      requestId: requestId('good-provider-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member', projectRefs: [],
      model: { provider: 'mock', model: 'fine' },
    })
    expect(pinned.status.availability).toBe('active')
    // No model at all: the Host default inheritance path, untouched.
    const inherited = await ctx.agentTeam.addMember({
      requestId: requestId('no-model-add'), workspaceId, handle: 'painter',
      description: 'Paints the UI', presetId: 'team-member', projectRefs: [],
    })
    expect(inherited.status.availability).toBe('active')
  })
})

describe('Agent Team private memory scaffold language (issue #43 #4)', () => {
  it('scaffolds a structural index and never overwrites an existing memory.md', async () => {
    const { ctx, workspaceId } = await realHarness()
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('scaffold-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member', projectRefs: [],
    })
    const memoryPath = join(added.status.member.privateMemoryPath, 'memory.md')
    const scaffold = await readFile(memoryPath, 'utf8')
    // Structural labels, not English prose sentences: the writing rules live in
    // the bundled skill the scaffold points at.
    expect(scaffold).toContain('- <scope>')
    expect(scaffold).toContain('- <rule>')
    expect(scaffold).toContain('- <work in hand>')
    expect(scaffold).not.toContain('what this Member owns')
    expect(scaffold).not.toContain('only rules that must bind')

    // The Member owns the file after creation: a later activation pass (here a
    // suspend/resume round trip re-runs the scaffold) must leave it alone.
    await writeFile(memoryPath, '# Member memory\n\nhand-written\n')
    await ctx.agentTeam.suspendMember({ requestId: requestId('scaffold-suspend'), memberId: added.status.member.memberId })
    await ctx.agentTeam.resumeMember({ requestId: requestId('scaffold-resume'), memberId: added.status.member.memberId })
    expect(await readFile(memoryPath, 'utf8')).toBe('# Member memory\n\nhand-written\n')
  })
})

describe('Agent Team wake-slot generation swap (ticket 05)', () => {
  /**
   * One Member with a real log, priced above the context waterline, woken after
   * `idleMs` of wall clock. The clock is moved rather than the timestamps: the
   * decision reads `Date.now()` against the log's own event times.
   */
  async function coldMember(idleMs: number, contextTokens: number): Promise<{
    readonly ctx: Context
    readonly adapter: ScriptedAdapter
    readonly memberId: AgentTeamMemberId
    readonly sessionId: SessionId
    readonly pressureState: { usageTokens: number; bySession: Map<string, number>; failFor: Set<string> }
  }> {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId(`wake-project-${idleMs}`), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId(`wake-builder-${idleMs}`), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    adapter.enqueue(textResponse('First look done.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    pressureState.bySession.set(added.status.member.sessionId, contextTokens)
    await vi.advanceTimersByTimeAsync(idleMs)
    return { ctx, adapter, memberId: added.status.member.memberId, sessionId: added.status.member.sessionId, pressureState }
  }

  it('swaps a generation that idled past the cache TTL with a large context, and the waking message opens the new one', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { ctx, adapter, memberId, sessionId } = await coldMember(61 * 60_000, 130_000)
      const workspaceId = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!.member.workspaceId
      const projectRef = ctx.agentTeam.view({ workspaceId }).projects[0]!.projectRef

      adapter.enqueue(textResponse('Read the waking message in the fresh context.'))
      const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('wake-message'), workspaceId,
        projectRef, body: 'Please pick this up now', recipients: [memberId] })
      expect(sent.kind).toBe('committed')

      // The swap runs through the lifecycle queue; fake timers only move the
      // clock, so the chain is driven by advancing the timer queue itself.
      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      // The retired log is archived, never deleted, and the binding moved.
      await waitForArchive(ctx, sessionId)
      // Availability flips to active only once the successor's Agent is live;
      // reading it immediately after the binding moved sees the window in
      // between, so wait for the settled value instead of a one-shot read.
      await vi.waitFor(() => {
        const availability = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.availability
        if (availability !== 'active') throw new Error(`member not active yet: ${availability}`)
      }, { timeout: 20_000 })
      const firstRequest = await vi.waitFor(() => {
        const asked = adapter.requests.find(request => JSON.stringify(request.messages).includes('Please pick this up now'))
        if (asked === undefined) throw new Error('the successor has not asked the model yet')
        expect(asked.sessionId).toBe(successor)
        return JSON.stringify(asked.messages)
      }, { timeout: 20_000 })
      // The successor's own request carries the waking message and the ordinary
      // per-step environment block — nothing announces a swap.
      expect(firstRequest).toContain('Team identity: you are @builder')
      expect(firstRequest).not.toMatch(/handoff|new generation|previous context|context was (?:reset|rebuilt)/i)
      expect(ctx.agentTeam['ledger']!.status().sequence).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('delivers into the same generation when the idle gap is under the cache TTL', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { ctx, adapter, memberId, sessionId } = await coldMember(59 * 60_000, 130_000)
      const workspaceId = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!.member.workspaceId
      const projectRef = ctx.agentTeam.view({ workspaceId }).projects[0]!.projectRef
      const agent = ctx.agents.get(sessionId)!

      // Pricing a generation for the wake decision is a full replay, so it must
      // stay behind the idle gate: a wake that fails the cheap gates never asks
      // the Host to price the swap. The spy reads the Host's own pricing entry
      // (not the shared meter, which the running 256K hard boundary reads every
      // step), so the assertion names the wake decision alone.
      const price = vi.spyOn(ctx.agentTeam as never as { measureLiveContext: (agent: unknown) => unknown }, 'measureLiveContext')
      adapter.enqueue(textResponse('Continuing in the same context.'))
      const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('warm-message'), workspaceId,
        projectRef, body: 'Continue please', recipients: [memberId] })
      expect(sent.kind).toBe('committed')
      await agent.whenIdle()
      expect(price).not.toHaveBeenCalled()
      price.mockRestore()

      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('Continue please')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a small cold context on its own generation', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { ctx, adapter, memberId, sessionId } = await coldMember(3 * 60 * 60_000, 40_000)
      const workspaceId = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!.member.workspaceId
      const projectRef = ctx.agentTeam.view({ workspaceId }).projects[0]!.projectRef
      const agent = ctx.agents.get(sessionId)!

      adapter.enqueue(textResponse('Continuing in the same context.'))
      await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('small-message'), workspaceId,
        projectRef, body: 'Continue please', recipients: [memberId] })
      await agent.whenIdle()

      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Agent Team wake-slot swap safety (ticket 05)', () => {
  it('keeps a generation that still owes queued input instead of retiring it, and answers that input with the wake', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('queued-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('queued-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      // Queued after the Member went idle, without waking it: the ordinary
      // input a retiring generation would cancel.
      agent.inject(createUserMessage({ content: [{ type: 'text', text: 'answer this queued question' }], source: { kind: 'user' } }))
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      adapter.enqueue(textResponse('Answering the queued question.'))
      const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('queued-message'), workspaceId,
        projectRef: project.project.projectRef, body: 'Please pick this up now', recipients: [memberId] })
      expect(sent.kind).toBe('committed')
      await vi.waitFor(() => {
        if (agent.status !== 'idle') throw new Error('the waking turn has not finished yet')
        if (adapter.requests.length < 2) throw new Error('the waking turn has not asked the model yet')
      }, { timeout: 20_000 })

      // The generation is the same one: nothing retired it, so the queued input
      // and the waking message were both answered in its own context.
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
      expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(sessionId)
      const request = JSON.stringify(adapter.requests.at(-1)!.messages)
      expect(request).toContain('answer this queued question')
    } finally {
      vi.useRealTimers()
    }
  })

  it('finishes a swap whose activation failed after the commit on the next Team notification', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState, presets } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('post-commit-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('post-commit-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      // The swap commits, then its activation fails: the durable binding has
      // moved while no live generation runs it.
      presets.failingMount = true
      const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('post-commit-message'), workspaceId,
        projectRef: project.project.projectRef, body: 'Please pick this up now', recipients: [memberId] })
      expect(sent.kind).toBe('committed')
      const stranded = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        if (current.availability === 'active') throw new Error('activation unexpectedly succeeded')
        return current
      }, { timeout: 20_000 })
      const successor = stranded.member.sessionId
      await waitForArchive(ctx, sessionId)
      expect(ctx.agents.get(sessionId)).toBeUndefined()

      // The next thing that needs this Member finishes the recorded transition
      // and rederives its Inbox; nothing retries in the background.
      presets.failingMount = false
      adapter.enqueue(textResponse('Answering from the recovered context.'))
      adapter.enqueue(textResponse('Second answer.'))
      await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('post-commit-second'), workspaceId,
        projectRef: project.project.projectRef, body: 'Second message', recipients: [memberId] })

      await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current?.availability !== 'active') throw new Error(`member not active yet: ${current?.availability}`)
        const asked = adapter.requests.map(request => JSON.stringify(request.messages))
        if (!asked.some(messages => messages.includes('Team Inbox has unread work'))) throw new Error('the successor has not rederived its Inbox yet')
      }, { timeout: 20_000 })
      // The retired generation stays retired: recovery never resumes it.
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      expect(ctx.agents.get(successor)).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays unanswered input a legacy rollover log still records into the successor', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('legacy-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('legacy-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // A log the retired rollover tool wrote: its intent parked on a durable
      // result, an ordinary message arrived while it was parked, and the turn
      // that claimed that message never answered it. Nothing in this build
      // writes such a log any more, so it is appended here directly.
      const carried = createUserMessage({ content: [{ type: 'text', text: 'the legacy carried question' }], source: { kind: 'user' } })
      const session = agent.session
      const turn = session.ownEvents().filter(event => event.type === 'turn/start').length + 1
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      session.append('assistant/message', {
        turn, step: 1, stream: [],
        message: {
          id: 'assistant-legacy', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
          content: [{ type: 'tool-call', id: 'call-legacy', name: 'context_rollover', arguments: JSON.stringify({ handoff: 'carry it' }) }],
        },
      } as never, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step: 1, callId: 'call-legacy' as never, name: 'context_rollover', arguments: JSON.stringify({ handoff: 'carry it' }) })
      session.append('tool/result', {
        turn, step: 1,
        message: createToolResultMessage({ callId: 'call-legacy' as never, content: [{ type: 'text', text: 'ok' }], isError: false }),
      }, { surfaceOp: 'append' })
      // Arrives while the intent is parked, then leaves the inbox when the turn
      // claims it; the claim is what leaves it unconsumed in the record.
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [carried] })
      session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      // The swap's replay reads the retired log back through persistence, so the
      // synthetic log has to be durable before the swap can see it.
      await ctx.sessionPersistence.flush()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      adapter.enqueue(textResponse('Reading the legacy question in the fresh context.'))
      await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('legacy-message'), workspaceId,
        projectRef: project.project.projectRef, body: 'Please pick this up now', recipients: [memberId] })

      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      await vi.waitFor(() => {
        if (!adapter.requests.some(request => request.sessionId === successor
          && JSON.stringify(request.messages).includes('the legacy carried question'))) throw new Error('the carried input has not reached the successor yet')
      }, { timeout: 20_000 })
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      expect(ctx.agents.get(successor)).toBeDefined()
      expect(ctx.agentTeam['ledger']!.status().sequence).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the generation when the meter cannot price it and says why', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('meter-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const added = await ctx.agentTeam.addMember({ requestId: requestId('meter-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.failFor.add(sessionId)
      await vi.advanceTimersByTimeAsync(61 * 60_000)
      const warn = vi.spyOn(ctx.logger, 'warn')
      adapter.enqueue(textResponse('Continuing without a price.'))
      await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('meter-message'), workspaceId,
        projectRef: project.project.projectRef, body: 'Continue please', recipients: [memberId] })
      await agent.whenIdle()

      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
      const priced = warn.mock.calls.map(args => String(args[0])).find(line => line.includes('could not price'))
      expect(priced).toBeDefined()
      expect(priced).toContain(sessionId)
      warn.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Agent Team wake-slot swap input across the commit (ticket 05)', () => {
  /**
   * Hold the durable recycled-binding write itself, so a test can let input
   * land in the retire window that production narrows but cannot remove.
   */
  function holdRecycledPut(ctx: Context): {
    readonly entered: Promise<void>
    readonly release: (fail?: Error) => void
    readonly restore: () => void
  } {
    const table = ctx.agentTeam['ledger']!['table']
    const realPut = table.put.bind(table)
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<Error | undefined>()
    const spy = vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
      if (value.kind === 'team/member-session-recycled') {
        entered.resolve()
        const failure = await gate.promise
        if (failure !== undefined) throw failure
      }
      return realPut(key, value)
    })
    return { entered: entered.promise, release: failure => gate.resolve(failure), restore: () => { spy.mockRestore() } }
  }

  /**
   * One idle Member with a real persisted log, priced past both swap gates and
   * woken after the cache TTL: the next Team wake retires this generation.
   */
  async function recyclableMember(tag: string): Promise<{
    readonly adapter: ScriptedAdapter
    readonly ctx: Context
    readonly workspaceId: WorkspaceId
    readonly projectRef: AgentTeamProjectRef
    readonly memberId: AgentTeamMemberId
    readonly sessionId: SessionId
    readonly agent: NonNullable<ReturnType<Context['agents']['get']>>
    readonly archived: readonly SessionId[]
    readonly presets: TestablePresets
  }> {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState, presets, archived } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: requestId(`${tag}-project`), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId(`${tag}-add`), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    const agent = ctx.agents.get(added.status.member.sessionId)!
    adapter.enqueue(textResponse('First look done.'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    pressureState.bySession.set(added.status.member.sessionId, 130_000)
    await vi.advanceTimersByTimeAsync(61 * 60_000)
    return { adapter, ctx, workspaceId, projectRef: project.project.projectRef, memberId: added.status.member.memberId,
      sessionId: added.status.member.sessionId, agent, archived, presets }
  }

  it('carries ordinary input that arrives while the recycled binding is being written into the successor', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { adapter, ctx, workspaceId, projectRef, memberId, sessionId, agent } = await recyclableMember('held-put')
      const before = adapter.requests.length
      const retire = ctx.agentTeam['retireMemberGeneration'].bind(ctx.agentTeam)
      const retireSpy = vi.spyOn(ctx.agentTeam as unknown as { retireMemberGeneration: typeof retire }, 'retireMemberGeneration').mockImplementation(async (...args: Parameters<typeof retire>) => {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'input during the retirement gap' }], source: { kind: 'user' } }))
        await agent.whenIdle()
        return retire(...args)
      })
      const put = holdRecycledPut(ctx)
      try {
        const sent = await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('held-put-message'), workspaceId,
          projectRef, body: 'Please pick this up now', recipients: [memberId] })
        expect(sent.kind).toBe('committed')
        await put.entered

        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'late ordinary followup' }], source: { kind: 'user' } }))
        agent.inject(createUserMessage({ content: [{ type: 'text', text: 'late injected step input' }], source: { kind: 'user' } }))
        expect(adapter.requests.length).toBe(before)
        for (let index = 0; index < 6; index += 1) adapter.enqueue(textResponse(`Successor answer ${index}.`))
        put.release()
      } finally {
        put.restore()
      }

      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      await vi.waitFor(() => {
        const asked = adapter.requests.filter(request => request.sessionId === successor).map(request => JSON.stringify(request.messages))
        for (const body of ['late ordinary followup', 'late injected step input', 'input during the retirement gap']) {
          if (!asked.some(messages => messages.includes(body))) throw new Error(`the successor has not replayed '${body}' yet`)
        }
      }, { timeout: 20_000 })

      const retired = adapter.requests.filter(request => request.sessionId === sessionId).map(request => JSON.stringify(request.messages))
      expect(retired.some(messages => messages.includes('late ordinary followup') || messages.includes('late injected step input'))).toBe(false)
      const transition = ctx.agentTeam['ledger']!.lastTransitionForMember(memberId)
      expect(transition?.previousSessionId).toBe(sessionId)
      expect(transition?.targetSessionId).toBe(successor)
      expect(transition?.inputFromSeq).toBeTypeOf('number')
      expect(agent.session.ownEvents().some(event => event.type === 'agent/inbox/spliced'
        && event.seq >= transition!.inputFromSeq! && event.data.removedCount !== undefined && event.data.outcome === undefined)).toBe(true)
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      retireSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the binding and answers late input in the old generation when the recycled commit rejects', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { adapter, ctx, workspaceId, projectRef, memberId, sessionId, agent, archived } = await recyclableMember('reject-put')
      const before = adapter.requests.length
      const put = holdRecycledPut(ctx)
      try {
        await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('reject-put-message'), workspaceId,
          projectRef, body: 'Please pick this up now', recipients: [memberId] })
        await put.entered
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'late followup while the commit failed' }], source: { kind: 'user' } }))
        expect(adapter.requests.length).toBe(before)
        adapter.enqueue(textResponse('Answered in the old generation.'))
        put.release(new Error('ledger write failed (test seam)'))
      } finally {
        put.restore()
      }

      await vi.waitFor(() => {
        if (adapter.requests.length <= before) throw new Error('the old generation has not answered the late input yet')
      }, { timeout: 20_000 })
      await agent.whenIdle()
      expect(adapter.requests.at(-1)!.sessionId).toBe(sessionId)
      expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('late followup while the commit failed')
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
      expect(ctx.agents.get(sessionId)).toBe(agent)
      expect(ctx.agentTeam['ledger']!.lastTransitionForMember(memberId)).toBeUndefined()
      expect(archived).not.toContain(sessionId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays late input from the retired log when the activation failed after the commit', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const { adapter, ctx, workspaceId, projectRef, memberId, sessionId, agent, presets } = await recyclableMember('postcommit-late')
      const late = createUserMessage({ content: [{ type: 'text', text: 'late followup recorded before activation failed' }], source: { kind: 'user' } })
      const put = holdRecycledPut(ctx)
      try {
        await ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('postcommit-late-message'), workspaceId,
          projectRef, body: 'Please pick this up now', recipients: [memberId] })
        await put.entered
        // The successor will fail to compose, so the old log is the only place
        // the late input survives.
        presets.failingMount = true
        agent.followup(late)
        for (let index = 0; index < 6; index += 1) adapter.enqueue(textResponse(`Recovered answer ${index}.`))
        put.release()
      } finally {
        put.restore()
      }

      const stranded = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        if (current.availability === 'active') throw new Error('activation unexpectedly succeeded')
        return current
      }, { timeout: 20_000 })
      const successor = stranded.member.sessionId
      await waitForArchive(ctx, sessionId)
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      expect(ctx.agents.get(successor)).toBeUndefined()
      expect(adapter.requests.filter(request => request.sessionId === successor)).toHaveLength(0)

      // Nothing carried this input in memory: the successor did not exist while
      // the input arrived, so recovery must replay the retired log from the
      // recorded offset.
      presets.failingMount = false
      const recovered = await ctx.agentTeam.recoverMember({ requestId: requestId('postcommit-late-recover'), workspaceId, memberId })
      expect(recovered.status.member.sessionId).toBe(successor)
      await vi.waitFor(() => {
        const asked = adapter.requests.filter(request => request.sessionId === successor).map(request => JSON.stringify(request.messages))
        if (!asked.some(messages => messages.includes('late followup recorded before activation failed'))) {
          throw new Error('the recovered successor has not replayed the late input yet')
        }
      }, { timeout: 20_000 })
      expect(ctx.agents.get(sessionId)).toBeUndefined()
      await ctx.agents.get(successor)!.whenIdle()
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await ctx.agentTeam.suspendMember({ requestId: requestId(`postcommit-suspend-${attempt}`), memberId })
        await ctx.agentTeam.resumeMember({ requestId: requestId(`postcommit-resume-${attempt}`), memberId })
        const resumed = ctx.agents.get(successor)!
        await resumed.whenIdle()
        expect(resumed.session.ownEvents().filter(event => event.type === 'user/message' && event.data.id === late.id)).toHaveLength(1)
        expect(resumed.session.ownEvents().filter(event => event.type === 'agent/inbox/spliced'
          && event.data.inserted.some(message => message.id === late.id))).toHaveLength(1)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Agent Team wake-slot swap delivery windows (ticket 05)', () => {
  it('hands a DM to the swapped-in generation instead of reporting a delivery failure', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const project = await ctx.agentTeam.createProject({ requestId: requestId('dm-wake-project'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const sender = await ctx.agentTeam.addMember({ requestId: requestId('dm-wake-sender'), workspaceId, handle: 'sender', description: 'Sends', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const receiver = await ctx.agentTeam.addMember({ requestId: requestId('dm-wake-receiver'), workspaceId, handle: 'receiver', description: 'Receives', presetId: 'team-member', projectRefs: [project.project.projectRef] })
      const senderAgent = ctx.agents.get(sender.status.member.sessionId)!
      const receiverAgent = ctx.agents.get(receiver.status.member.sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      receiverAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await receiverAgent.whenIdle()
      pressureState.bySession.set(receiver.status.member.sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      adapter.enqueue(textResponse('Answering the DM from the fresh context.'))
      await expect(ctx.agentTeam.dmForAgent(senderAgent, { requestId: requestId('dm-wake'), workspaceId,
        recipientMemberId: receiver.status.member.memberId, body: 'are you back?' })).resolves.toBeDefined()

      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === receiver.status.member.memberId)
        if (current === undefined || current.member.sessionId === receiver.status.member.sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      const fresh = await vi.waitFor(() => {
        const live = ctx.agents.get(successor)
        if (live === undefined || live.status !== 'idle') throw new Error('successor not idle yet')
        return live
      }, { timeout: 20_000 })
      await fresh.whenIdle()

      // The relay landed in the successor: the DM was recorded durably and the
      // swap never turned into an `AgentTeamDmDeliveryError`.
      const relayed = adapter.requests.map(request => JSON.stringify(request.messages))
        .some(messages => messages.includes('are you back?'))
      expect(relayed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Agent Team cold-generation activation (ticket 05)', () => {
  it('starts a fresh generation at startup instead of resuming a cold, large Session', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState, teamFiber } = await realHarness(adapter)
      const added = await ctx.agentTeam.addMember({ requestId: requestId('boot-wake-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      // A restart re-activates from the ledger binding alone: the stored log is
      // priced first, and a cold generation is never even resumed.
      await teamFiber.dispose()
      await ctx.plugin(AgentTeam)

      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      expect(ctx.agents.get(successor)).toBeDefined()
      expect(ctx.agents.get(sessionId)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a cold Session that holds pending ordinary input instead of retiring it at startup', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState, teamFiber } = await realHarness(adapter)
      const added = await ctx.agentTeam.addMember({ requestId: requestId('boot-pending-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)

      // The Host stops with one ordinary message still pending in the durable
      // inbox: the input was accepted, has no owning turn yet, and the swap must
      // not discard it. Written through the persistence seam so the log stays a
      // legal stored Session rather than a hand-built fixture.
      await teamFiber.dispose()
      const pending = createUserMessage({ content: [{ type: 'text', text: 'pending ordinary input across the restart' }], source: { kind: 'user' } })
      const handle = await ctx.sessionPersistence.open(sessionId, 'write')
      try {
        const stored = await handle.read()
        await handle.append([{
          type: 'agent/inbox/spliced', seq: stored.events.length, time: Date.now(),
          data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [pending] },
        } as never])
        await handle.flush()
      } finally {
        await handle.close()
      }

      await ctx.plugin(AgentTeam)

      const resumed = await vi.waitFor(() => {
        const live = ctx.agents.get(sessionId)
        if (live === undefined) throw new Error('not reactivated yet')
        return live
      }, { timeout: 20_000 })
      // The pending input is the reason this cold, large Session was kept: a
      // generation holding accepted work is never swapped away from it.
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
      expect(resumed.inbox.nextTurn.map(message => JSON.stringify(message.content))).toContain(JSON.stringify([{ type: 'text', text: 'pending ordinary input across the restart' }]))
      expect(ctx.agentTeam['ledger']!.lastTransitionForMember(memberId)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('swaps a cold generation reached through resume, inside that request\'s own lifecycle chain', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState } = await realHarness(adapter)
      const added = await ctx.agentTeam.addMember({ requestId: requestId('resume-wake-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)
      await ctx.agentTeam.suspendMember({ requestId: requestId('resume-wake-suspend'), memberId })
      adapter.enqueue(textResponse('Resumed into a fresh context.'))

      // Resume activates the stored, cold Session from inside its own lifecycle
      // chain; the swap that activation requests must run in that frame rather
      // than queue behind the operation awaiting it.
      const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume-wake'), memberId })
      const successor = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
        if (current === undefined || current.member.sessionId === sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      expect(String(successor)).toMatch(/^agent-team-recycle-[0-9a-f]{64}$/)
      expect(ctx.agents.get(successor)).toBeDefined()
      await waitForArchive(ctx, sessionId)
      expect(resumed.status.member.sessionId).toBe(sessionId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumes the stored Session at startup while the cache may still be warm', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId, pressureState, teamFiber } = await realHarness(adapter)
      const added = await ctx.agentTeam.addMember({ requestId: requestId('boot-warm-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [] })
      const memberId = added.status.member.memberId
      const sessionId = added.status.member.sessionId
      const agent = ctx.agents.get(sessionId)!
      adapter.enqueue(textResponse('First look done.'))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Take a first look.' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      pressureState.bySession.set(sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(10 * 60_000)

      await teamFiber.dispose()
      await ctx.plugin(AgentTeam)

      await vi.waitFor(() => {
        const live = ctx.agents.get(sessionId)
        if (live === undefined) throw new Error('not reactivated yet')
      }, { timeout: 20_000 })
      expect(ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)?.member.sessionId).toBe(sessionId)
    } finally {
      vi.useRealTimers()
    }
  })
})
