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
import LlmRuntime, { LlmError, ToolCallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionFormatUnsupportedError } from '@deepseek-ai/dsh-session-persistence'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_TOOL_NAMES, isTsxDevMode, markAgentTeamPreset, teamPresetScopeMismatchMessage } from '../src/index.ts'
import { checkpointRefFor, foldTeamContextProjection } from '../src/context-projection.ts'
import { AGENT_TEAM_PLUGIN_ID, continuationCheckpointRefOf, handoffOf, isCheckpointContinuationMessage, isHandoffMessage } from '../src/context-source.ts'
import { RECOVERY_DELAY_MS } from '../src/recovery.ts'
import type { AgentTeamChannelRef, AgentTeamClaimRef, AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'

const cleanups: Array<() => Promise<void>> = []
const originalDshHome = process.env.DSH_HOME
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
/** The ENOENT shape the JSONL backend raises when a walk hits a win32 staging directory mid-rename. */
const persistenceRaceError = (): Error =>
  Object.assign(new Error("scandir ENOENT: transient win32 staging directory raced the walk (test seam)"), { code: 'ENOENT' })

/**
 * One-shot filesystem fault for the private-memory half of Member cleanup:
 * while `match` names a path fragment, `rm` on a matching target fails as a
 * real permissions fault would, on every platform this suite runs on. The
 * default (empty) passes every call through unchanged.
 */
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
  // The pressure policy resolves the current route's context capacity through
  // the LLM service; the mock route reports a large window so ordinary turns
  // stay below every budget.
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 320_000 } }) }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield* [] }
}

class ScriptedAdapter extends EmptyAdapter {
  readonly requests: GenerateOptions[] = []
  /** Session ids that produced each recorded request, aligned with `requests`. */
  readonly requestSessions: Array<string | undefined> = []
  private readonly responses: StreamChunk[][] = []
  /** Context window per model name; the pressure route probe drives this. */
  resolveModelWindow: (model: string) => number = () => 320_000

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.resolveModelWindow(model) } })
  }

  enqueue(response: StreamChunk[]): void {
    this.responses.push(response)
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.requestSessions.push((options as { sessionId?: string }).sessionId)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('ScriptedAdapter response queue is empty')
    for (const chunk of response) yield chunk
  }
}

class GatedAdapter extends ScriptedAdapter {
  readonly started = Promise.withResolvers<void>()
  readonly release = Promise.withResolvers<void>()
  private calls = 0

  /** 1-based model-call number whose stream blocks until `release`; default 1. */
  constructor(private readonly gateAt = 1) { super() }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.calls !== this.gateAt) {
      yield* super.stream(options)
      return
    }
    this.requests.push(options)
    this.started.resolve()
    await this.release.promise
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

function waitForIdle(ctx: Context, agent: NonNullable<ReturnType<Context['agents']['get']>>): Promise<void> {
  // State-aware: an agent already idle resolves immediately; the event
  // listener only covers agents that still have a transition ahead.
  if (agent.status === 'idle') return Promise.resolve()
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
}

type PersistenceBackend = 'jsonl'

/**
 * The real roster with one test seam: agents armed here resolve no preset
 * composition, exactly as members composed before a bundle-row reload do.
 * Agents composed after arming resolve normally, so a re-activation heals.
 * While `failingMount` is set, preset mounts throw, as a Host restart against
 * a broken preset would, leaving an enabled Member without a live session.
 */
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
): Promise<{
  readonly ctx: Context
  readonly workspaceId: WorkspaceId
  readonly root: string
  readonly project: string
  readonly workspaces: Map<WorkspaceId, { id: WorkspaceId; path: string; attachSession: () => Promise<void> }>
  readonly teamFiber: Awaited<ReturnType<Context['plugin']>>
  /** Sessions the fake workspace registry archived, in archive order. */
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
  const project = join(root, 'project')
  const persistence = join(root, 'sessions')
  if (reopen === undefined) await Promise.all([mkdir(project), mkdir(persistence)])
  process.env.DSH_HOME = join(root, 'dsh-home')
  // The preset's compaction row points at a real file with a file: URL, so
  // its health check and the `compaction` service are both genuine.
  const compactionStub = join(root, 'compaction-stub.mjs')
  await writeFile(compactionStub, [
    "export const name = 'test-compaction'",
    "export function apply(scope) { scope.provide('compaction', { compactNow: async () => null, compactIfNeeded: async () => null }) }",
    '',
  ].join('\n'))
  // The team-member definition as one declarative row, the same shape the
  // shipped cordis.patch.yml declares; bare internal loader names resolve
  // through the self-linked node_modules.
  const teamMemberPlugins: PresetDefinition['plugins'] = [
    { id: 'member-context', name: '@wowyuarm/dsh-agent-team/member-context' },
    { id: 'member-time-context', name: '@wowyuarm/dsh-agent-team/member-time-context' },
    { id: 'team-tools', name: '@wowyuarm/dsh-agent-team/tools' },
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
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(SessionStore)
  // The preset registry injects 'sessionProjections'; the roster stays PENDING without it.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  // The Team pressure policy reads the token meter at every Member pre-step;
  // tests that need pressure control override this with a writable fake.
  const pressureState = { usageTokens: 0, bySession: new Map<string, number>(), failFor: new Set<string>() }
  ctx.provide('tokenMeter', { measure: (session: { id: string }): { totalTokens: number } => {
    if (pressureState.failFor.has(session.id)) throw new Error('meter unavailable for this session')
    return { totalTokens: pressureState.bySession.get(session.id) ?? pressureState.usageTokens }
  } })
  // The rollover job guard reads the member-scoped jobs registry; a writable
  // fake lets tests drive owned-job states.
  const jobsState: { jobs: Array<{ id: string; label: string; status: string; reported: boolean }> } = { jobs: [] }
  ctx.provide('jobs', { list: () => jobsState.jobs })
  if (persistenceBackend === 'jsonl') await ctx.plugin(JsonlSessionPersistence, { root: persistence })
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  // The registry injects 'sessionProjections'; the roster stays PENDING without it.
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
  const workspaces = new Map([[workspaceId, { id: workspaceId, path: project, attachSession: async () => {} }]])
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => workspaces.get(id),
    list: () => [],
    // The registry-global archive set the real registry exposes: the Host
    // reads it to decide whether a retired Session's archive effect is still
    // owed, so the fake has to report the same durable truth.
    get archivedSessionIds(): readonly SessionId[] { return archived },
    archiveSession: async (sessionId: SessionId) => {
      // The real registry resolves an already-archived id without writing;
      // the fake mirrors that so repeated cleanup cannot record a duplicate.
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
  return { ctx, workspaceId, root, project, workspaces, teamFiber, archived, archiveFailures, presets: ctx.agentPresets as TestablePresets, pressureState, jobsState }
}

describe('Agent Team Member lifecycle', () => {
  it('works in a joined Workspace through the existing live Session and withdraws without disposing it', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, project, root, workspaces, archived } = await realHarness(adapter)
    const otherId = WorkspaceId('workspace:joined')
    workspaces.set(otherId, { id: otherId, path: join(root, 'other-project'), attachSession: async () => {} })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('global-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', channelRefs: [] })
    expect(added.status.availability, JSON.stringify(added.status)).toBe('active')
    const memberId = added.status.member.memberId
    const agent = ctx.agents.get(added.status.member.sessionId)!
    await ctx.agentTeam.joinWorkspace({ requestId: requestId('global-join'), workspaceId: otherId, memberId })
    expect(ctx.agentTeam.membersForClient({ workspaceId: otherId }).map(status => status.member.memberId)).toEqual([memberId])
    // The committed join wakes the idle Member once; the notice names the Workspace and the unchanged Session.
    adapter.enqueue(textResponse('Acknowledged the participation change.'))
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const noticeRequest = JSON.stringify(adapter.requests[0]!.messages)
    expect(noticeRequest).toContain('Team participation changed')
    expect(noticeRequest).toContain(otherId)
    expect(noticeRequest).toContain('Your Session and cwd have not moved')
    for (const [name, args] of [
      ['team_view', {}],
      ['team_thread', { action: 'status', threadRef: 'thread:missing' }],
      ['team_message', { action: 'start', channelRef: 'channel:missing', body: 'Do not route implicitly' }],
      ['team_claim', { action: 'list', taskRef: 'task:missing' }],
    ] as const) {
      const omitted = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`global-missing-${name}`),
        name, arguments: args, agent })
      expect(omitted.isError).toBe(true)
      if (!omitted.isError) throw new Error('Expected an explicit Workspace requirement')
      expect(omitted.error.message).toContain('workspace is required')
      expect(omitted.error.message).toContain(workspaceId)
      expect(omitted.error.message).toContain(otherId)
    }
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('global-channel'), workspaceId: otherId,
      name: 'work', description: '', memberIds: [memberId] })
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('global-start'),
      name: 'team_message', arguments: { action: 'start', workspace: otherId, channelRef: channel.channel.channelRef, body: 'Working in joined checkout' }, agent })
    expect(result.isError, result.isError ? result.error.message : '').toBe(false)
    expect(ctx.agentTeam.view({ workspaceId: otherId }).items[0]?.message.body).toBe('Working in joined checkout')
    expect(agent.session.header.cwd).toBe(project)
    expect(ctx.agents.get(added.status.member.sessionId)).toBe(agent)
    await ctx.agentTeam.leaveWorkspace({ requestId: requestId('global-leave'), workspaceId: otherId, memberId })
    expect(ctx.agentTeam.membersForClient({ workspaceId: otherId })).toEqual([])
    expect(ctx.agents.get(added.status.member.sessionId)).toBe(agent)
    expect(ctx.agentTeam.memberForAgent(agent)).toEqual(added.status.member)
    expect(archived).toEqual([])
    expect(() => ctx.agentTeam.viewForAgent(agent, { workspaceId: otherId })).toThrow(/another Workspace/)
    ctx.agentTeam.validateLedger()
  })

  it('archives a Member: session disposed and archived, private memory kept, claims released', async () => {
    const { ctx, workspaceId, archived } = await realHarness()
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('archive-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('archive-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')

    // Give the Member an active Claim so the release cleanup is observable
    // end-to-end.
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('archive-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Build the feature', recipients: [memberId] })
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
      handle: 'builder', description: '', presetId: 'team-member', channelRefs: [] })
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

  it('finishes a context renewal whose Session archive failed when the same request is retried', async () => {
    const { ctx, workspaceId, archived, archiveFailures } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('clear-retry-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', channelRefs: [] })
    const memberId = added.status.member.memberId
    const target = SessionId(`agent-team-${requestId('clear-retry')}`)
    archiveFailures.remaining = 1

    await expect(ctx.agentTeam.clearMemberContext({ requestId: requestId('clear-retry'), workspaceId, memberId }))
      .rejects.toThrow('workspace archive failed')
    const stranded = ctx.agentTeam.members().find(item => item.member.memberId === memberId)
    expect(stranded?.member.sessionId).toBe(target)
    expect(stranded?.availability).toBe('unavailable')
    // The retire half disposed the old generation but never archived it, so
    // the recorded binding and the live effects disagree until it is finished.
    expect(archived).toEqual([])
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    expect(ctx.agents.get(target)).toBeUndefined()

    // The durable renewal is the desired binding: the same request finishes
    // the outstanding effects and answers with that recorded result instead
    // of refusing with "has no active session to clear".
    const retried = await ctx.agentTeam.clearMemberContext({ requestId: requestId('clear-retry'), workspaceId, memberId })
    expect(retried.status.member.sessionId).toBe(target)
    expect(retried.status.availability).toBe('active')
    expect(archived).toEqual([added.status.member.sessionId])
    expect(ctx.agents.get(target)).toBeDefined()

    // Still exactly one renewal: repeating the request never mints a second
    // binding, and the recorded receipt is what comes back.
    const again = await ctx.agentTeam.clearMemberContext({ requestId: requestId('clear-retry'), workspaceId, memberId })
    expect(again.receipt.operationId).toBe(retried.receipt.operationId)
    expect(again.status.availability).toBe('active')
    expect(archived).toEqual([added.status.member.sessionId])
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('finishes an interrupted context renewal during startup', async () => {
    const { ctx, workspaceId, archived, archiveFailures, teamFiber } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('clear-boot-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', channelRefs: [] })
    const memberId = added.status.member.memberId
    const target = SessionId(`agent-team-${requestId('clear-boot')}`)
    archiveFailures.remaining = 1

    await expect(ctx.agentTeam.clearMemberContext({ requestId: requestId('clear-boot'), workspaceId, memberId }))
      .rejects.toThrow('workspace archive failed')
    expect(archived).toEqual([])
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.availability).toBe('unavailable')

    // Restarting replays the same ledger through the boot path: no live handle
    // survives a restart, so startup itself must archive the retired Session
    // and start the recorded binding rather than the pre-renewal one.
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)

    expect(archived).toEqual([added.status.member.sessionId])
    const restored = ctx.agentTeam.members().find(item => item.member.memberId === memberId)
    expect(restored?.member.sessionId).toBe(target)
    expect(restored?.availability).toBe('active')
    expect(ctx.agents.get(target)).toBeDefined()
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('finishes a context renewal whose target Session activation failed', async () => {
    const { ctx, workspaceId, archived, presets } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('clear-activation-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', channelRefs: [] })
    const memberId = added.status.member.memberId
    const target = SessionId(`agent-team-${requestId('clear-activation')}`)
    presets.failingMount = true

    await expect(ctx.agentTeam.clearMemberContext({ requestId: requestId('clear-activation'), workspaceId, memberId }))
      .rejects.toThrow('failed to start a new context')
    const stranded = ctx.agentTeam.members().find(item => item.member.memberId === memberId)
    expect(stranded?.member.sessionId).toBe(target)
    expect(stranded?.availability).toBe('unavailable')
    // Here the retire half completed and the target never started — the two
    // failure windows are distinguishable, which is what reconciliation reads.
    expect(archived).toEqual([added.status.member.sessionId])
    expect(ctx.agents.get(target)).toBeUndefined()

    presets.failingMount = false
    const retried = await ctx.agentTeam.clearMemberContext({ requestId: requestId('clear-activation'), workspaceId, memberId })
    expect(retried.status.member.sessionId).toBe(target)
    expect(retried.status.availability).toBe('active')
    expect(ctx.agents.get(target)).toBeDefined()
    expect(archived).toEqual([added.status.member.sessionId])
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('converges an archive interrupted after its commit during startup', async () => {
    const { ctx, workspaceId, archived, archiveFailures, teamFiber } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('arch-boot-add'), workspaceId,
      handle: 'builder', description: '', presetId: 'team-member', channelRefs: [] })
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
      handle: 'builder', description: '', presetId: 'team-member', channelRefs: [] })
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
      handle: 'builder', description: '', presetId: 'team-member', channelRefs: [] })
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
      handle: 'victim', description: '', presetId: 'team-member', channelRefs: [] })
    const keeper = await ctx.agentTeam.addMember({ requestId: requestId('boot-fs-keep'), workspaceId,
      handle: 'keeper', description: '', presetId: 'team-member', channelRefs: [] })
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
      handle: 'builder', description: '', presetId: 'team-member', channelRefs: [] })
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
      handle: 'builder', description: '', presetId: 'team-member', channelRefs: [] })
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
    const { ctx, workspaceId, root, project } = await realHarness()
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
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
    expect(live?.session.header.cwd).toBe(project)
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

  it('renews an enabled Member onto a fresh session: new sessionId, archived previous log, memory and binding survive', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, archived } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('clear-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('clear-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const liveBefore = ctx.agents.get(added.status.member.sessionId)!
    // Give the Member a real turn so the clear has a transcript to erase.
    adapter.enqueue(textResponse('Initial work finished.'))
    // Listener-only wait: the Member is idle right after activation, so a
    // state-aware helper would resolve before the send's wake turn runs and
    // the request-count assertion below would race.
    const idle = new Promise<void>(resolve => {
      const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
        if (subject !== liveBefore || status !== 'idle') return
        dispose()
        resolve()
      })
    })
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('clear-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Build the initial feature', recipients: [added.status.member.memberId] })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await idle
    expect(adapter.requests).toHaveLength(1)
    expect(liveBefore.session.ownEvents().some(event => event.type === 'user/message' || event.type === 'turn/start')).toBe(true)
    // Consume the durable unread so the Member settles to available; the clear
    // guard requires an idle Member.
    await ctx.agentTeam.readThreadForAgent(liveBefore, { requestId: requestId('clear-read'), workspaceId, taskRef: started.task!.taskRef })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline
      && ctx.agentTeam.members().find(member => member.member.memberId === added.status.member.memberId)!.presence !== 'available') {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(ctx.agentTeam.members().find(member => member.member.memberId === added.status.member.memberId)!.presence).toBe('available')
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')

    const cleared = await ctx.agentTeam.clearMemberContext({ requestId: requestId('clear'), workspaceId, memberId: added.status.member.memberId })
    expect(cleared.status.availability).toBe('active')
    expect(cleared.status.presence).toBe('available')
    expect(cleared.status.member.sessionId).not.toBe(added.status.member.sessionId)

    // The old live Session is disposed; the Member now runs a fresh handle
    // under a new id with an empty conversation (the constructor seed marker
    // is the only event left) and fork lineage back to the previous Session.
    expect(ctx.agents.get(added.status.member.sessionId)).toBeUndefined()
    const liveAfter = ctx.agents.get(cleared.status.member.sessionId)!
    expect(liveAfter).not.toBe(liveBefore)
    expect(liveAfter.session.header.cwd).toBe(liveBefore.session.header.cwd)
    expect(liveAfter.session.header.parentSession).toBe(added.status.member.sessionId)
    expect(liveAfter.session.ownEvents().filter(event => event.type === 'user/message' || event.type === 'turn/start')).toHaveLength(0)
    expect(liveAfter.session.ownEvents().length).toBeLessThan(liveBefore.session.ownEvents().length)
    const sessionTitle = ctx.get('sessionTitle')
    expect(sessionTitle?.get(liveAfter.session)).toMatchObject({ title: 'builder', source: { kind: 'user' } })

    // The previous Session log survives on disk (only archived from grouping
    // surfaces), so the Member's history stays queryable. Disposal drains the
    // log asynchronously, so wait for the artifact to materialize; the walk
    // itself races the backend's transient win32 staging entries (ENOENT), so
    // retry those too.
    const listSessionIds = async (): Promise<Set<SessionId>> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return new Set((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id))
        } catch (error) {
          if (attempt >= 3 || (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
          await new Promise(resolve => setTimeout(resolve, 25))
        }
      }
    }
    const flushDeadline = Date.now() + 3000
    while (Date.now() < flushDeadline && !(await listSessionIds()).has(added.status.member.sessionId)) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect((await listSessionIds()).has(added.status.member.sessionId)).toBe(true)
    expect(archived).toContain(added.status.member.sessionId)
    expect(archived).not.toContain(cleared.status.member.sessionId)

    // Private memory and the workspace binding survive.
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()
    expect(ctx.agentTeam.memberForAgent(liveAfter)).toEqual(cleared.status.member)

    // The renewal replays cleanly and dedupes by request.
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    const again = await ctx.agentTeam.clearMemberContext({ requestId: requestId('clear'), workspaceId, memberId: added.status.member.memberId })
    expect(again.receipt.operationId).toBe(cleared.receipt.operationId)
    expect(again.status.member.sessionId).toBe(cleared.status.member.sessionId)

    // Guards: unknown and suspended Members cannot clear.
    await expect(ctx.agentTeam.clearMemberContext({ requestId: requestId('clear-unknown'), workspaceId, memberId: 'member:missing' as AgentTeamMemberId })).rejects.toThrow(/unknown Member/)
    await ctx.agentTeam.suspendMember({ requestId: requestId('clear-suspend'), memberId: added.status.member.memberId })
    await expect(ctx.agentTeam.clearMemberContext({ requestId: requestId('clear-suspended'), workspaceId, memberId: added.status.member.memberId }))
      .rejects.toThrow(/only enabled Members can start from a new context/)
  })

  it('surfaces an orphaned preset composition and rebuilds the Member on resume', async () => {
    const { ctx, workspaceId, presets } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [] })
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

  it('renews an error Member from a new context, healing the broken composition', async () => {
    const { ctx, workspaceId, presets, archived } = await realHarness()
    const added = await ctx.agentTeam.addMember({ requestId: requestId('add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [] })
    const live = ctx.agents.get(added.status.member.sessionId)!

    // An error Member keeps its live idle handle, so starting from a new
    // context must work for it too — and doubles as a recovery path.
    presets.orphaned.add(live.ctx)
    const orphaned = ctx.agentTeam.members().find(member => member.member.memberId === added.status.member.memberId)!
    expect(orphaned.presence).toBe('error')

    const cleared = await ctx.agentTeam.clearMemberContext({ requestId: requestId('clear'), workspaceId, memberId: added.status.member.memberId })
    expect(cleared.status.presence).toBe('available')
    expect(cleared.status.member.sessionId).not.toBe(added.status.member.sessionId)
    expect(archived).toContain(added.status.member.sessionId)
    const renewed = ctx.agents.get(cleared.status.member.sessionId)!
    expect(renewed).not.toBe(live)
    expect(ctx.agentPresets.serviceFor(renewed, 'compaction')).toBeDefined()
    expect(ctx.tools.schemas(renewed).length).toBeGreaterThan(0)
  })

  it('restarts a Member whose activation failed and rejects restart for suspended Members', async () => {
    const { ctx, workspaceId, presets } = await realHarness()
    presets.failingMount = true
    const added = await ctx.agentTeam.addMember({ requestId: requestId('add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [] })
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
    const added = await ctx.agentTeam.addMember({ requestId: requestId('resume-add'), workspaceId, handle: 'restorer', description: 'Restores the exact session', presetId: 'team-member', channelRefs: [] })
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
    await ctx.agentTeam.addMember({ requestId: requestId('retry-add'), workspaceId, handle: 'retrier', description: 'Survives a transient walk failure', presetId: 'team-member', channelRefs: [] })

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

  it('creates a Member with no description and no Channels and lights delivery on join', async () => {
    const { ctx, workspaceId, teamFiber } = await realHarness()
    const bare = await ctx.agentTeam.addMember({ requestId: requestId('bare'), workspaceId, handle: 'bare', description: '', presetId: 'team-member', channelRefs: [] })
    expect(bare.status.availability).toBe('active')
    expect(bare.status.member.description).toBe('')
    // The invariant companion replays the same durable record shape; an empty
    // initial Channel list is valid and must not be rejected as divergent.
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    expect(ctx.agentTeam.status().agentMemberCount).toBe(1)
    const agent = ctx.agents.get(bare.status.member.sessionId)!
    expect(agent).toBeDefined()

    // A message to an empty Channel commits with an empty notification set.
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('bare-channel'), workspaceId, name: 'ops', description: 'Ops work' })
    const before = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('pre-join'), workspaceId, channelRef: channel.channel.channelRef, body: 'Posted before anyone joined' })
    expect(before.kind).toBe('committed')
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0 })

    // Joining a Channel lights the whole delivery chain for later mentions.
    await ctx.agentTeam.joinChannel({ requestId: requestId('join'), workspaceId, channelRef: channel.channel.channelRef, memberId: bare.status.member.memberId })
    const after = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('post-join'), workspaceId, channelRef: channel.channel.channelRef, body: 'Pinged after joining', recipients: [bare.status.member.memberId] })
    expect(after.kind).toBe('committed')
    if (after.kind !== 'committed') throw new Error(`expected committed post-join mention, received ${after.kind}`)
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1,
      items: [expect.objectContaining({ task: expect.objectContaining({ taskRef: after.task!.taskRef }), directCount: 1 })] })
  })

  it('requires referenced Channel authority and rejects an incomplete Team preset before publication', async () => {
    const { ctx, workspaceId } = await realHarness()
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    await expect(ctx.agentTeam.addMember({ requestId: requestId('wrong-workspace'), workspaceId, handle: 'wrong', description: 'Wrong channel', presetId: 'team-member', channelRefs: ['channel:missing' as AgentTeamChannelRef] })).rejects.toThrow(/unknown Channel/)
    const first = await ctx.agentTeam.addMember({ requestId: requestId('first'), workspaceId, handle: 'first', description: 'First', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    await expect(ctx.agentTeam.addMember({ requestId: requestId('duplicate'), workspaceId, handle: 'FIRST', description: 'Duplicate', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })).rejects.toThrow(/already active/)
    expect(first.status.member.state).toBe('enabled')
  })

  it('runs the five-tool pull protocol through one live Team Member', async () => {
    const { ctx, workspaceId } = await realHarness()
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('protocol-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('protocol-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('protocol-reviewer'), workspaceId, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
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
    expect(discovered.channels).toEqual([{ channelRef: channel.channel.channelRef, name: 'engineering' }])
    expect(discovered.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'human' }),
      expect.objectContaining({ memberId: builder.status.member.memberId, handle: 'builder' }),
      expect.objectContaining({ memberId: reviewer.status.member.memberId, handle: 'reviewer' }),
    ]))
    expect(discovered).not.toHaveProperty('items')
    expect(ctx.tools.schemas(agent).every(schema => !Object.hasOwn(schema.parameters.properties ?? {}, 'workspaceId'))).toBe(true)

    // team_view enumerates every top-level Thread of joined Channels, taskless
    // included, without message bodies: a Member who joined late and was never
    // mentioned can discover prior discussions and address them by ref (issue #2).
    const beforeThreads = await call('team_view', {})
    expect(beforeThreads.threads).toEqual([])
    const plainStart = await call('team_message', { action: 'start', channelRef: channel.channel.channelRef, body: 'Agent-led taskless discussion' })
    expect(plainStart).toMatchObject({ kind: 'committed' })
    const taskfulStart = await call('team_message', { action: 'start', asTask: true, channelRef: channel.channel.channelRef, body: 'Agent-led task with work' })
    expect(taskfulStart).toMatchObject({ kind: 'committed' })
    await call('team_message', { action: 'reply', threadRef: plainStart.threadRef, body: 'One follow-up reply', baseRevision: plainStart.revision })
    const threadDirectory = await call('team_view', {})
    expect(threadDirectory.threads).toHaveLength(2)
    const taskless = threadDirectory.threads.find((thread: { threadRef: string }) => thread.threadRef === plainStart.threadRef)
    expect(taskless).toMatchObject({ channelRef: channel.channel.channelRef, messageCount: 2 })
    expect(taskless.taskRef).toBeUndefined()
    const taskful = threadDirectory.threads.find((thread: { threadRef: string }) => thread.threadRef === taskfulStart.threadRef)
    expect(taskful).toMatchObject({ channelRef: channel.channel.channelRef, messageCount: 1, taskRef: taskfulStart.taskRef, status: 'todo' })
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
    // Threads in a Channel the Member has not joined stay invisible.
    const privateChannel = await ctx.agentTeam.createChannel({ requestId: requestId('protocol-private'), workspaceId, name: 'private', description: 'Unjoined' })
    const privateStart = await ctx.agentTeam.sendMessage({ requestId: requestId('protocol-private-start'), workspaceId, channelRef: privateChannel.channel.channelRef, body: 'Taskless discussion outside membership' })
    expect(privateStart).toMatchObject({ kind: 'committed' })
    const privateThreadRef = (privateStart as { thread: { threadRef: string } }).thread.threadRef
    const afterPrivate = await call('team_view', {})
    expect(afterPrivate.threads.some((thread: { threadRef: string }) => thread.threadRef === privateThreadRef)).toBe(false)
    expect(afterPrivate.channels.some((entry: { channelRef: string }) => entry.channelRef === privateChannel.channel.channelRef)).toBe(false)

    // team_message attachments: the tool passes absolute paths, the Host
    // validates and copies them into the cache, and the committed message
    // carries the same metadata and prompt lines as a manual upload.
    const shotPath = join(process.env.DSH_HOME!, 'protocol-shot.png')
    await writeFile(shotPath, Buffer.from('png-bytes'))
    const shotMessage = await call('team_message', { action: 'start', channelRef: channel.channel.channelRef,
      body: 'Agent-created task with a screenshot', attachments: [shotPath] })
    expect(shotMessage).toMatchObject({ kind: 'committed' })
    const shotThreadRef = (shotMessage as { threadRef: string }).threadRef
    const shotHistory = ctx.agentTeam.threadHistory({ workspaceId, threadRef: shotThreadRef as never })
    const shotFact = shotHistory.facts.find(fact => fact.kind === 'message' && fact.message.attachments !== undefined)
    expect(shotFact).toBeDefined()
    expect(shotHistory.facts.some(fact => fact.kind === 'message' && new RegExp(`\\[attachment\\] .*attachments${sep === '/' ? '\\/' : '\\\\'}v1${sep === '/' ? '\\/' : '\\\\'}`).test(fact.message?.body ?? ''))).toBe(true)
    const rejected = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-protocol-bad-${++callNumber}`), name: 'team_message', arguments: { action: 'start', channelRef: channel.channel.channelRef, body: 'Never committed', attachments: ['relative/shot.png'] }, agent })
    expect(rejected.isError).toBe(true)
    expect(rejected.error?.message ?? rejected.value).toMatch(/must be absolute/)
    expect(ctx.agentTeam.threadHistory({ workspaceId, threadRef: shotThreadRef as never }).facts.some(fact => fact.kind === 'message' && fact.message?.body === 'Never committed')).toBe(false)

    const agentStarted = await call('team_message', { action: 'start', channelRef: channel.channel.channelRef,
      body: 'Agent-created task for @human' })
    expect(agentStarted).toMatchObject({ kind: 'committed' })
    expect(ctx.agentTeam.inbox({ workspaceId })).toMatchObject({ totalDirectCount: 1,
      items: [expect.objectContaining({ directCount: 1 })] })
    expect(await call('team_thread', { action: 'unfollow', threadRef: agentStarted.threadRef })).toMatchObject({ kind: 'unfollow', following: false })
    expect(await call('team_thread', { action: 'follow', threadRef: agentStarted.threadRef })).toMatchObject({ kind: 'follow', following: true })

    const enrolled = await call('team_message', { action: 'start', channelRef: channel.channel.channelRef,
      body: 'Agent-led task for @reviewer' })
    expect(enrolled).toMatchObject({ kind: 'committed', threadRef: expect.any(String) })
    const enrolledThreadRef = (enrolled as { threadRef: string }).threadRef
    const reviewerAgent = ctx.agents.get(reviewer.status.member.sessionId)!
    const reviewerInbox = ctx.agentTeam.inboxForAgent(reviewerAgent, { workspaceId })
    expect(reviewerInbox).toMatchObject({ totalDirectCount: 1,
      items: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: enrolledThreadRef }), directCount: 1 })] })
    expect(reviewerInbox.items[0]!.task).toBeUndefined()
    expect(ctx.agentTeam.attentionStatusForAgent(reviewerAgent, { workspaceId, threadRef: enrolledThreadRef as never }).attention).toBeDefined()

    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('protocol-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Investigate the pull protocol' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const background = await ctx.agentTeam.reply({ requestId: requestId('protocol-background'), workspaceId, taskRef: started.task!.taskRef, body: 'Older context', baseRevision: started.thread.revision })
    if (background.kind !== 'committed') throw new Error(`expected committed background, received ${background.kind}`)
    const held = await ctx.agentTeam.reply({ requestId: requestId('protocol-invite'), workspaceId, taskRef: started.task!.taskRef, body: 'Builder, please investigate', baseRevision: background.thread.revision, recipients: [builder.status.member.memberId] })
    if (held.kind !== 'confirmation_required') throw new Error(`expected confirmation, received ${held.kind}`)
    const invitation = await ctx.agentTeam.reply({ requestId: requestId('protocol-invite-confirmed'), workspaceId, taskRef: started.task!.taskRef, body: 'Builder, please investigate', baseRevision: background.thread.revision, recipients: [builder.status.member.memberId], confirmationToken: held.confirmationToken })
    if (invitation.kind !== 'committed') throw new Error(`expected committed invitation, received ${invitation.kind}`)

    const inbox = await call('team_inbox', {})
    expect(inbox).toMatchObject({ totalDirectCount: 1, items: [expect.objectContaining({ taskRef: started.task!.taskRef, directCount: 1 })] })
    expect(JSON.stringify(inbox)).not.toContain('Builder, please investigate')

    const firstRead = await call('team_thread', { action: 'read', taskRef: started.task!.taskRef })
    expect(firstRead).toMatchObject({
      kind: 'read', taskRef: started.task!.taskRef, status: 'todo', resolution: 'open', following: true,
      anchor: { body: 'Investigate the pull protocol' }, claims: [],
    })
    expect(firstRead.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: 'Older context', unread: false }),
      expect.objectContaining({ body: 'Builder, please investigate', unread: true, direct: true }),
    ]))

    const update = await ctx.agentTeam.reply({ requestId: requestId('protocol-update'), workspaceId, taskRef: started.task!.taskRef, body: 'New evidence', baseRevision: invitation.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)
    expect(await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'Premature reply', baseRevision: invitation.thread.revision }))
      .toMatchObject({ kind: 'unread_required', revision: update.thread.revision, unreadCount: 1 })
    await call('team_thread', { action: 'read', taskRef: started.task!.taskRef })
    expect(await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'Stale reply', baseRevision: invitation.thread.revision }))
      .toMatchObject({ kind: 'stale_revision', expectedRevision: invitation.thread.revision, revision: update.thread.revision })
    const reply = await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'Current reply', baseRevision: update.thread.revision })
    expect(reply).toMatchObject({ kind: 'committed', taskRef: started.task!.taskRef })

    // A reply naming an Agent who has never taken part in this Thread commits:
    // a text mention never fails the write, nothing reaches that Agent, and
    // the result reports the undelivered name — inviting a Member into an
    // existing Thread stays a Human decision. Asserted at execute/result level,
    // not only through a hand-written render fixture.
    const dropped = await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: '@reviewer, please look', baseRevision: reply.revision })
    expect(dropped).toMatchObject({ kind: 'committed', taskRef: started.task!.taskRef, threadRef: started.thread.threadRef,
      undeliveredMentions: [reviewer.status.member.memberId] })
    expect(ctx.agentTeam.inboxForAgent(reviewerAgent, { workspaceId }).items.map(item => item.thread.threadRef)).toEqual([enrolledThreadRef])

    expect(await call('team_thread', { action: 'unfollow', taskRef: started.task!.taskRef })).toMatchObject({ following: false })
    const claim = await call('team_claim', { action: 'claim', taskRef: started.task!.taskRef, direction: 'implementation', baseRevision: dropped.revision })
    // A committed Claim mutation returns the authoritative affected Claim;
    // the structured claims archive and Task status stay real (compat) —
    // the render is what omits the archive, never the structured value.
    expect(claim).toMatchObject({ kind: 'committed', action: 'claim', threadRef: started.thread.threadRef, status: 'in_progress',
      claim: expect.objectContaining({ owner: builder.status.member.memberId, direction: 'implementation', state: 'active' }),
      claims: [expect.objectContaining({ owner: builder.status.member.memberId, direction: 'implementation', state: 'active' })] })
    expect(await call('team_thread', { action: 'status', taskRef: started.task!.taskRef })).toMatchObject({ following: true })
    expect(await call('team_claim', { action: 'list', taskRef: started.task!.taskRef })).toMatchObject({ kind: 'listed', claims: [expect.objectContaining({ direction: 'implementation' })] })
    const done = await call('team_claim', { action: 'done', taskRef: started.task!.taskRef, claimRef: claim.claim.claimRef, baseRevision: claim.revision })
    expect(done).toMatchObject({ kind: 'committed', action: 'done', status: 'in_review', claim: expect.objectContaining({ state: 'done' }),
      claims: [expect.objectContaining({ direction: 'implementation', state: 'done' })] })
    const secondClaim = await call('team_claim', { action: 'claim', taskRef: started.task!.taskRef, direction: 'follow-up', baseRevision: done.revision })
    const released = await call('team_claim', { action: 'release', taskRef: started.task!.taskRef, claimRef: secondClaim.claim.claimRef, baseRevision: secondClaim.revision })
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
    expect(await call('team_inbox', {})).toMatchObject({ totalUnreadCount: 1, items: [expect.objectContaining({ taskRef: started.task!.taskRef })] })
    expect(await call('team_message', { action: 'reply', taskRef: started.task!.taskRef, body: 'History did not read', baseRevision: unreadAfterClaims.thread.revision }))
      .toMatchObject({ kind: 'unread_required', unreadCount: 1 })
    await call('team_thread', { action: 'read', taskRef: started.task!.taskRef })
    expect(await call('team_inbox', {})).toMatchObject({ totalUnreadCount: 0, items: [] })
  })

  it('delivers a direct message through the tool and injects it into the live recipient session', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('dm-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('dm-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('dm-reviewer'), workspaceId, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
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
    const sent = await call('team_message', { action: 'dm', memberRef: reviewer.status.member.memberId, body: 'quick check: is the build green?' })
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

    // Audit-only: no Thread or Message appears in the Channel, and neither
    // Member's Inbox gains unread work from the DM.
    const view = ctx.agentTeam.view({ workspaceId })
    expect(view.threads).toHaveLength(0)
    expect(view.items).toHaveLength(0)
    expect(ctx.agentTeam.inboxForAgent(recipient, { workspaceId })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0 })
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()

    // A second DM carries the bounded adjacent context of the first exchange:
    // the context line cites the prior DM's body, never the one being sent.
    // Direction is from the reader's perspective: the cited DM came from the
    // other Member (the sender), so the reviewer reads (them → you).
    const second = await call('team_message', { action: 'dm', memberRef: reviewer.status.member.memberId, body: 'still green?' })
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
    const replyFromReviewer = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-mirror-${++callNumber}`), name: 'team_message', arguments: { action: 'dm', memberRef: builder.status.member.memberId, body: 'yes, all green' }, agent: recipient })
    expect(replyFromReviewer.isError).toBe(false)
    adapter.enqueue(textResponse('Noted.'))
    await waitForIdle(ctx, sender)
    const senderRelays = sender.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { form?: string } }).source?.form === 'relay')
    expect(senderRelays).toHaveLength(1)
    const mirrorText = (senderRelays[0]!.data as { content: Array<{ type: string; text: string }> }).content[0]!.text
    expect(mirrorText).toMatch(/\(you → them, at [^)]+\+08:00\) still green\?/)

    // Parameter matrix: human recipients, unknown Members, and stray fields.
    const bad = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-bad-${++callNumber}`), name: 'team_message', arguments: { action: 'dm', memberRef: AGENT_TEAM_HUMAN_MEMBER_ID, body: 'hi' }, agent: sender })
    expect(bad.isError).toBe(true)
    expect(bad.error?.message ?? '').toMatch(/Agent Member/)
    const unknown = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-unknown-${++callNumber}`), name: 'team_message', arguments: { action: 'dm', memberRef: 'member:nobody', body: 'hi' }, agent: sender })
    expect(unknown.isError).toBe(true)
    const stray = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-stray-${++callNumber}`), name: 'team_message', arguments: { action: 'dm', memberRef: reviewer.status.member.memberId, body: 'hi', channelRef: channel.channel.channelRef }, agent: sender })
    expect(stray.isError).toBe(true)
    expect(stray.error?.message ?? '').toMatch(/does not accept/)

    // A suspended peer is not a sendable target: the ledger rejects the send
    // outright (nothing is recorded), which is the pre-delivery guard.
    await ctx.agentTeam.suspendMember({ requestId: requestId('dm-suspend'), memberId: reviewer.status.member.memberId })
    const suspended = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(`team-dm-suspended-${++callNumber}`), name: 'team_message', arguments: { action: 'dm', memberRef: reviewer.status.member.memberId, body: 'are you back?' }, agent: sender })
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('clock-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('clock-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('clock-start'), workspaceId, channelRef: channel.channel.channelRef,
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('loop-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('loop-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('loop-start'), workspaceId, channelRef: channel.channel.channelRef, body: 'Investigate the rejection flow' })
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('safe-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('safe-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('safe-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Investigate safe delivery' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('safe-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    let revision = (await ctx.agentTeam.readThread({ requestId: requestId('safe-human-read'), workspaceId, taskRef: started.task!.taskRef })).thread.revision
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start ordinary project work.' }], source: { kind: 'user' } }))
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('top-level-wake-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('top-level-wake-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const committed = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('top-level-wake'), workspaceId, channelRef: channel.channel.channelRef,
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

  it('delivers an agent-created top-level mention to the mentioned Member', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('peer-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const starter = await ctx.agentTeam.addMember({ requestId: requestId('peer-starter'), workspaceId, handle: 'starter', description: 'Starts work', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const peer = await ctx.agentTeam.addMember({ requestId: requestId('peer-peer'), workspaceId, handle: 'peer', description: 'Peers in', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const starterAgent = ctx.agents.get(starter.status.member.sessionId)!
    const peerAgent = ctx.agents.get(peer.status.member.sessionId)!
    let callNumber = 0
    const call = async (name: string, args: unknown) => {
      const result = await ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId(`peer-mention-${++callNumber}`), name, arguments: args, agent: starterAgent })
      if (result.isError) throw new Error(result.error.message)
      return result.value as Record<string, any>
    }

    const started = await call('team_message', { action: 'start', channelRef: channel.channel.channelRef,
      body: '@peer please verify the export path' })
    expect(started).toMatchObject({ kind: 'committed' })

    expect(ctx.agentTeam.inboxForAgent(peerAgent, { workspaceId })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1,
      items: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.threadRef }), directCount: 1 })] })
    expect(ctx.agentTeam.inboxForAgent(peerAgent, { workspaceId }).items[0]!.task).toBeUndefined()

    adapter.enqueue(textResponse('I will verify the export path.'))
    await peerAgent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('Direct Team mention')
    expect(request).toContain('@peer please verify the export path')
    expect(request).toContain('starter')
    expect(request).toContain(started.threadRef)
    expect(request).not.toContain('Task undefined')
    expect(request).toContain('relevant workspace and threadRef')
    expect(request).toMatch(/Occurred at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00/)
  })

  it('bounds automatic direct context while retaining omitted Messages in durable Inbox', async () => {
    const adapter = new GatedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('bounded-channel'), workspaceId,
      name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('bounded-builder'), workspaceId, handle: 'builder',
      description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue current project work.' }], source: { kind: 'user' } }))
    await adapter.started.promise

    const started = []
    for (let index = 1; index <= 5; index++) {
      const body = `${`x${index}`.repeat(4_500)}\nDIRECT-END-${index}`
      const result = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId(`bounded-direct-${index}`), workspaceId,
        channelRef: channel.channel.channelRef, body, recipients: [builder.status.member.memberId] })
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('task-update-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('task-update-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('task-update-start'), workspaceId,
      channelRef: channel.channel.channelRef, body: 'Prepare a close notification test' })
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('wake-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('wake-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('wake-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Investigate the wake path' })
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('resume-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('resume-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('resume-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Investigate resume recovery' })
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
      const channel = await ctx.agentTeam.createChannel({ requestId: requestId('automatic-recovery-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('automatic-recovery-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!
      const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('automatic-recovery-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Investigate automatic recovery' })
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

  it('cancels an automatic wakeup when a Member is suspended before the delay', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new ScriptedAdapter()
      const { ctx, workspaceId } = await realHarness(adapter)
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('suspend-recovery-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [] })
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
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('structured-transport-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [] })
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
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('structured-terminal-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [] })
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
      const channel = await ctx.agentTeam.createChannel({ requestId: requestId('manual-recovery-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
      const builder = await ctx.agentTeam.addMember({ requestId: requestId('manual-recovery-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
      const agent = ctx.agents.get(builder.status.member.sessionId)!
      const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('manual-recovery-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Investigate manual recovery' })
      if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
      await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('manual-recovery-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
      const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('manual-recovery-read'), workspaceId, taskRef: started.task!.taskRef })
      const update = await ctx.agentTeam.reply({ requestId: requestId('manual-recovery-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread through manual recovery', baseRevision: humanRead.thread.revision })
      if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)
      await agent.whenIdle()

      adapter.enqueue(textResponse('I will continue the interrupted work.'))
      await ctx.agentTeam.recoverMember({ requestId: requestId('manual-recovery'), workspaceId, memberId: builder.status.member.memberId })
      await agent.whenIdle()
      await vi.advanceTimersByTimeAsync(RECOVERY_DELAY_MS)

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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('error-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('error-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('error-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Investigate error recovery' })
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('remount-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('remount-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const agent = ctx.agents.get(builder.status.member.sessionId)!
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('remount-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Investigate remount recovery' })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    await ctx.agentTeam.changeAttentionForAgent(agent, { requestId: requestId('remount-follow'), workspaceId, taskRef: started.task!.taskRef, action: 'follow' })
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('remount-human-read'), workspaceId, taskRef: started.task!.taskRef })
    const update = await ctx.agentTeam.reply({ requestId: requestId('remount-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Unread across Host remount', baseRevision: humanRead.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed reply, received ${update.kind}`)
    await agent.whenIdle()
    expect(ctx.agentTeam.inboxForAgent(agent, { workspaceId }).totalUnreadCount).toBe(1)

    adapter.enqueue(textResponse('I will inspect remounted Inbox work.'))
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    const restored = ctx.agents.get(builder.status.member.sessionId)!
    await restored.whenIdle()
    const lastRequest = JSON.stringify(adapter.requests.at(-1)!.messages)
    expect(lastRequest).toContain('Team Inbox has unread work')
    expect(lastRequest).not.toContain('Unread across Host remount')
  })

  it('validates the final Team tool marker during unpublished setup', async () => {
    expect(AGENT_TEAM_TOOL_NAMES).toEqual(['team_inbox', 'team_thread', 'team_message', 'team_claim', 'team_view', 'context_rollover', 'context_checkpoint', 'context_status', 'context_compact'])
    const definition = markAgentTeamPreset({ name: 'team_message' })
    expect(Reflect.get(definition, Symbol.for('@wowyuarm/dsh-agent-team.preset'))).toBe(true)
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

  it('detects the tsx loader in the process launch flags', () => {
    const originalArgv = process.execArgv
    const originalNodeOptions = process.env.NODE_OPTIONS
    try {
      process.env.NODE_OPTIONS = '--import tsx/esm'
      expect(isTsxDevMode()).toBe(true)
      process.env.NODE_OPTIONS = undefined
      process.execArgv = ['--import', 'tsx/esm']
      expect(isTsxDevMode()).toBe(true)
      process.execArgv = []
      expect(isTsxDevMode()).toBe(false)
    } finally {
      process.execArgv = originalArgv
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = originalNodeOptions
    }
  })

  it('keeps a persisted Member session active after switching its model and restarting', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, teamFiber } = await realHarness(adapter)
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('persisted-model-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member', channelRefs: [],
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('model-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('model-add'), workspaceId, handle: 'builder',
      description: 'Builds the implementation', presetId: 'team-member',
      channelRefs: [channel.channel.channelRef], model: { provider: 'mock', model: 'pinned-model' },
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
    const cleared = await ctx.agentTeam.updateMember({ requestId: requestId('clear-model'), memberId: added.status.member.memberId, handle: 'builder', description: 'Builds things' })
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

describe('Agent Team fresh context_rollover rollover (ticket 01)', () => {
  it('rolls a Member over end to end: handoff first, fresh Session, archive, facts survive', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, archived, pressureState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('rollover-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('rollover-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const previousSessionId = added.status.member.sessionId
    const memberId = added.status.member.memberId
    await writeFile(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'), 'persistent note')

    // One direct prompt drives a turn whose only tool call is context_rollover.
    const handoff = 'Objective: land the parser feature. Verified: tests pass. Next: run the browser check.'
    adapter.enqueue(toolCallResponse('call-nc', 'context_rollover', { handoff }))
    // The generation after the rollover consumes the handoff and replies.
    adapter.enqueue(textResponse('Continuing from the handoff.'))
    const liveBefore = ctx.agents.get(previousSessionId)!
    // The retired generation's own source shape, captured while it is still
    // live: this is exactly what the timeline hands the Host to price a row.
    const retiredSource = {
      sessionId: previousSessionId,
      header: liveBefore.session.header,
      inheritedEventCount: liveBefore.session.inheritedEventCount,
      events: liveBefore.session.ownEvents(),
    }
    liveBefore.followup(createUserMessage({ content: [{ type: 'text', text: 'Please hand off now.' }], source: { kind: 'user' } }))

    // The rollover completes asynchronously after the containing turn ends.
    const renewedStatus = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== previousSessionId ? current : undefined
    })
    const newSessionId = renewedStatus.member.sessionId

    // Fresh generation: nothing inherited from the old log, and the lineage
    // parent points at the previous active Session. The swap's commit order is
    // binding flip → retire (dispose + archive) → activate, and only the flip
    // is published first, so the previous Agent's disappearance still races
    // this probe; wait for it instead of sampling straight after the flip.
    await waitFor(() => ctx.agents.get(previousSessionId) === undefined ? true : undefined)
    // The ledger binding flips before the new Session activates; wait for
    // the published handle AND the delivered handoff — the swap commits the
    // binding first, activates and steers the handoff afterwards.
    const liveAfter = await waitFor(() => ctx.agents.get(newSessionId)!)
    expect(liveAfter).not.toBe(liveBefore)
    expect(liveAfter.session.header.parentSession).toBe(previousSessionId)
    expect(liveAfter.session.inheritedEventCount).toBe(0)
    await waitFor(() => liveAfter.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    const ownEvents = liveAfter.session.ownEvents()
    // The only pre-handoff events are the constructor seed marker; the
    // handoff leads every model-facing event of the new generation.
    const firstUserIndex = ownEvents.findIndex(event => event.type === 'user/message')
    expect(ownEvents.slice(0, firstUserIndex).some(event => event.type === 'tool/call' || event.type === 'assistant/message')).toBe(false)

    // The old Session archived; private memory and binding survive.
    expect(archived).toContain(previousSessionId)
    expect(archived).not.toContain(newSessionId)
    await expect(access(join(added.status.member.privateMemoryPath, 'notes', 'kept.md'))).resolves.toBeUndefined()
    expect(ctx.agentTeam.memberForAgent(liveAfter)?.sessionId).toBe(newSessionId)

    // The durable ledger records the Member-actor rollover and replays cleanly.
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    // The handoff message is the first model-facing context of the new generation.
    const firstUserEvent = liveAfter.session.ownEvents().find(event => event.type === 'user/message')
    expect(firstUserEvent?.type).toBe('user/message')
    if (firstUserEvent?.type !== 'user/message') throw new Error('expected handoff user message')
    expect(firstUserEvent.data.source).toMatchObject({ kind: AGENT_TEAM_PLUGIN_ID, form: 'snapshot' })
    expect(handoffOf(firstUserEvent.data)).toMatchObject({
      previousSessionId, newSessionId, trigger: 'model',
    })
    expect(firstUserEvent.data.content[0]).toMatchObject({ type: 'text' })
    const handoffText = (firstUserEvent.data.content[0] as { text: string }).text
    expect(handoffText).toContain(handoff)
    // The generation consumed the handoff and answered.
    expect(adapter.requests.length).toBeGreaterThanOrEqual(2)

    // The timeline folds its sources with the same configuration the
    // projection folds with, legacy rollover alias included.
    const foldConfig = ctx.agentTeam.contextFoldConfig()
    expect(foldConfig.rolloverToolNames).toContain('context_rollover')
    expect(foldConfig.checkpointToolName).toBe('context_checkpoint')

    // A live source is priced in the live Session's own tokens and a retired one
    // through its own detached replay — never the current generation's.
    pressureState.bySession.set(newSessionId, 777)
    pressureState.bySession.set(previousSessionId, 4242)
    expect(ctx.agentTeam.measureContextSourceForAgent(liveAfter, {
      sessionId: newSessionId,
      header: liveAfter.session.header,
      inheritedEventCount: liveAfter.session.inheritedEventCount,
      events: liveAfter.session.ownEvents(),
    })).toBe(777)
    expect(ctx.agentTeam.measureContextSourceForAgent(liveAfter, retiredSource)).toBe(4242)
  })

  it('an ordinary Session never receives the context_rollover tool', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx } = await realHarness(adapter)
    const plain = await ctx.agents.create({ sessionId: SessionId('plain-session'), meta: { cwd: process.cwd() } })
    try {
      const names = ctx.tools.schemas(plain.agent).map(tool => tool.name)
      expect(names).not.toContain('context_rollover')
      expect(names).not.toContain('team_message')
    } finally {
      await plain.dispose()
    }
  })

  it('fails a checkpointRef rollover whose ref resolves nowhere, leaving the Member recoverable', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('cpref-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('cpref-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const sessionId = added.status.member.sessionId

    // A well-formed ref that resolves to no checkpoint in the Member's
    // lineage rejects at the tool boundary: the engine's gate answers from the
    // timeline the Member can read and refuses before any Host call, so the
    // failure is model-visible as an error result instead of a fake
    // `scheduled` whose async swap always fails. No pending intent, no turn
    // conclusion, and the Member stays bound — recoverable by construction.
    const vanishedRef = checkpointRefFor(sessionId, 'call-that-never-recorded')
    const live = ctx.agents.get(sessionId)!
    adapter.enqueue(toolCallResponse('call-cp-ref', 'context_rollover', { handoff: 'attempted checkpoint return', checkpointRef: vanishedRef }))
    adapter.enqueue(textResponse('the anchor does not resolve; picking another path.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'try returning to a checkpoint' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, live)
    await new Promise(resolve => setTimeout(resolve, 100))

    const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)!
    expect(current.member.sessionId).toBe(sessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    // The rejection is durable and model-visible, and no pending intent was
    // recorded from the refused call. The sentence belongs to the engine; what
    // the contract needs is an error result that names the ref the model cited,
    // which is what lets the next attempt drop it.
    const refused = live.session.ownEvents().find(event => {
      if (event.type !== 'tool/result') return false
      return event.data.message.isError === true && JSON.stringify(event.data.message.content).includes(vanishedRef)
    })
    expect(refused).toBeDefined()
    const poisoned = foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id, inheritedEventCount: live.session.inheritedEventCount })
    expect(poisoned.pending).toBeNull()

    // An explicit later-turn fresh rollover still succeeds: the refused
    // checkpoint call left nothing locked.
    adapter.enqueue(toolCallResponse('call-cp-ref-retry', 'context_rollover', { handoff: 'explicit fresh retry after the refused return' }))
    // The generation the retry swaps in consumes the handoff and answers.
    adapter.enqueue(textResponse('Continuing from the fresh retry handoff.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over fresh instead' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.member.sessionId !== sessionId ? status : undefined
    })
    expect(renewed.member.sessionId).not.toBe(sessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('recovers from a transition that fails at the commit seam after a successful rollover result', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, jobsState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('seam-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('seam-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // A rollover that PASSES tool-time validation can still fail at the
    // lifecycle commit seam: a job may start between the tool result and the
    // swap. Inject exactly that TOCTOU window through the seam the real Host
    // rechecks — the turn/end observer fires after the successful result is
    // durable and before the coordinator's idle-waited swap runs.
    let injected = false
    const disposeObserver = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId || event.type !== 'turn/end' || injected) return
      injected = true
      jobsState.jobs = [{ id: 'bash-seam', label: 'racing job', status: 'running', reported: false }]
    })
    adapter.enqueue(toolCallResponse('call-seam-nc', 'context_rollover', { handoff: 'seam-failing fresh rollover' }))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over while a job races the seam' }], source: { kind: 'user' } }))
    // The turn ends; the swap runs after idle and fails at the seam guard,
    // leaving the old generation bound and a SPENT pending intent in the
    // projection — the recoverable poison state.
    await waitForIdle(ctx, live)
    await new Promise(resolve => setTimeout(resolve, 100))
    disposeObserver()
    expect(injected).toBe(true)

    const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)!
    expect(current.member.sessionId).toBe(sessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
    const poisoned = foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id, inheritedEventCount: live.session.inheritedEventCount })
    expect(poisoned.pending).toMatchObject({ toolCallId: 'call-seam-nc' })
    expect(poisoned.pending?.turnEndSeq).not.toBe(-1)

    // The blocking job settles; an explicit later-turn fresh rollover must
    // replace the spent pending intent and complete the swap.
    jobsState.jobs = []
    adapter.enqueue(toolCallResponse('call-seam-retry', 'context_rollover', { handoff: 'explicit fresh retry after the seam failure' }))
    // The generation the retry swaps in consumes the handoff and answers.
    adapter.enqueue(textResponse('Continuing from the fresh retry handoff.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'the job settled; roll over fresh now' }], source: { kind: 'user' } }))
    // First gate: the retry's successful result must land durably and REPLACE
    // the spent pending intent in the projection — the poison state is
    // provably undone at the fold before the binding moves.
    const replaced = await waitFor(() => {
      const state = foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id, inheritedEventCount: live.session.inheritedEventCount })
      return state.pending?.toolCallId === 'call-seam-retry' && state.pending.turnEndSeq !== -1 ? state : undefined
    })
    expect(replaced.pending).toMatchObject({ handoff: 'explicit fresh retry after the seam failure' })

    const renewed = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.member.sessionId !== sessionId ? status : undefined
    })
    expect(renewed.member.sessionId).not.toBe(sessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('rejects any supplied non-string checkpointRef value at the tool boundary', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('cpref2-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('cpref2-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // A declared parameter carries its schema validation (a non-string
    // rejects at the execute boundary with a harness validator message), and
    // the body adds the blank-string check the schema cannot express. Either
    // layer rejecting is correct: no value may be silently treated as an
    // absent ref, because absent means fresh.
    const supplied: Array<string | number | null> = [7, null, '']
    for (const [attempt, value] of supplied.entries()) {
      adapter.enqueue(toolCallResponse(`call-cp-any-${attempt}`, 'context_rollover', { handoff: `attempt ${attempt}`, checkpointRef: value }))
      adapter.enqueue(textResponse(`attempt ${attempt} rejected; continuing.`))
      live.followup(createUserMessage({ content: [{ type: 'text', text: `try checkpointRef ${JSON.stringify(value)}` }], source: { kind: 'user' } }))
      await waitForIdle(ctx, live)
    }

    const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)!
    expect(current.member.sessionId).toBe(sessionId)
    const results = live.session.ownEvents().filter(event => event.type === 'tool/result')
    const rejections = results.filter(event => {
      if (event.type !== 'tool/result') return false
      const text = JSON.stringify(event.data.message.content)
      return text.includes('checkpointRef must be a non-empty string when supplied') || text.includes('\\"checkpointRef\\" must be a string')
    })
    expect(rejections).toHaveLength(supplied.length)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('rejects malformed relatedFiles entries instead of seeding the handoff envelope with undefined fields', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('badfiles-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('badfiles-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // Tool argument validation is layered: the Harness schema validator
    // rejects missing/non-string/object violations at the execute boundary,
    // and the tool's own execute check catches the blank string the schema
    // cannot express.
    const malformed: Array<Record<string, unknown> | null> = [
      { reason: 'missing path' },
      { path: 'src/index.ts', reason: 7 },
      null,
      { path: '   ', reason: 'blank path' },
    ]
    for (const [attempt, entry] of malformed.entries()) {
      adapter.enqueue(toolCallResponse(`call-bad-files-${attempt}`, 'context_rollover', { handoff: `attempt ${attempt}`, relatedFiles: [entry] }))
      adapter.enqueue(textResponse(`attempt ${attempt} rejected; continuing.`))
      live.followup(createUserMessage({ content: [{ type: 'text', text: `try malformed relatedFiles ${attempt}` }], source: { kind: 'user' } }))
      await waitForIdle(ctx, live)
    }

    // Every malformed call rejected: the binding never moved, no rollover
    // operation committed, and each attempt surfaced an explicit error. Each
    // attempt submits a single-entry array, so every error addresses
    // relatedFiles[0]. Defense is layered: the Harness schema validator
    // rejects missing/non-string/object violations at the boundary, and the
    // tool's own execute check catches the blank string the schema cannot
    // express.
    const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)!
    expect(current.member.sessionId).toBe(sessionId)
    const results = live.session.ownEvents().filter(event => event.type === 'tool/result')
    if (process.env.DSH_DEBUG_TOOL_RESULTS !== undefined) {
      for (const event of results) {
        if (event.type !== 'tool/result') continue
        console.log('TOOL_RESULT', JSON.stringify(event.data.message.content).slice(0, 220))
      }
    }
    const expectedDetails: Array<string> = [
      'missing required property "relatedFiles[0].path"',
      '"relatedFiles[0].reason" must be a string',
      '"relatedFiles[0]" must be an object',
      'context_rollover relatedFiles[0].path must be a non-empty string',
    ]
    for (const [attempt, detail] of expectedDetails.entries()) {
      const rejected = results.find(event => {
        if (event.type !== 'tool/result') return false
        return JSON.stringify(event.data.message.content).includes(JSON.stringify(detail).slice(1, -1))
      })
      expect(rejected, `attempt ${attempt} (${JSON.stringify(malformed[attempt])}) should reject with ${detail}`).toBeDefined()
    }
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })
})

/**
 * Wait until the predicate holds or the deadline passes. The default budget
 * mirrors the file-level testTimeout: multi-generation rollover chains take
 * real driver turns on slow CI machines and can exceed a tight 5s poll.
 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before the deadline')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Wait until every given Session id has been archived. Archiving rides
 * retirement, which a rollover publishes only after its durable binding flip,
 * so observing the flip (or a later generation's registration) can still
 * sample the archive list too early. The assertion stays exactly as strong —
 * an id that is never archived still fails — but stops depending on the order
 * inside the commit sequence.
 */
async function waitForArchived(archived: readonly SessionId[], ...sessionIds: readonly SessionId[]): Promise<void> {
  await waitFor(() => sessionIds.every(sessionId => archived.includes(sessionId)) ? true : undefined)
}

  it('carries later direct input across a rollover and rederives Team notices from the ledger', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('gate-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('gate-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const previousSessionId = added.status.member.sessionId
    const memberId = added.status.member.memberId

    adapter.enqueue(toolCallResponse('call-nc', 'context_rollover', { handoff: 'handoff for the gate test' }))
    adapter.enqueue(textResponse('Continuing after the handoff.'))
    const liveBefore = ctx.agents.get(previousSessionId)!
    liveBefore.followup(createUserMessage({ content: [{ type: 'text', text: 'Start the rollover.' }], source: { kind: 'user' } }))

    // Deterministic race injection: deliver the later direct input inside the
    // old generation's own turn/end observer — after turn-stopping, at the
    // boundary where a queued follow-up can slip in between turn end and
    // idle convergence, before the driver converges or opens a new turn.
    // The turn/end observer fires inside the append publication, so the
    // injected follow-up defers one microtask — the same discipline the Host
    // uses for steer-from-observer — while still landing deterministically
    // before the driver can converge to idle or open a new turn.
    const raced = Promise.withResolvers<void>()
    let injected = false
    const disposeObserver = ctx.on('session/event', (session, event) => {
      if (session.id !== previousSessionId || event.type !== 'turn/end' || injected) return
      injected = true
      queueMicrotask(() => {
        liveBefore.followup(createUserMessage({ content: [{ type: 'text', text: 'Direct follow-up that arrived during the transition.' }], source: { kind: 'user' } }))
        raced.resolve()
      })
    })
    // The ledger binding moves first, activation follows; wait for the new
    // generation's live handle before asserting on it (the commit window's
    // readiness semantics are locked separately below).
    const newSessionId = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== previousSessionId ? current.member.sessionId : undefined
    })
    const liveAfter = await waitFor(() => ctx.agents.get(newSessionId)!)

    // Old-generation invariant: the rollover turn is the only turn that ran a
    // step; the racing follow-up never reached a second model request.
    const oldEvents = liveBefore.session.ownEvents()
    expect(oldEvents.filter(event => event.type === 'step/start').length).toBe(1)
    disposeObserver()
    await raced.promise

    // The carried input is delivered after the handoff; wait for the new
    // generation to surface it before asserting.
    await waitFor(() => {
      const surfaced = liveAfter.session.ownEvents().filter(event => event.type === 'user/message')
      return surfaced.some(event => JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content).includes('Direct follow-up that arrived during the transition')) ? surfaced : undefined
    })
    const userEvents = liveAfter.session.ownEvents().filter(event => event.type === 'user/message')
    const bodies = userEvents.map(event => (event as { data: { content: ReadonlyArray<{ type: string; text?: string }> } }).data.content
      .filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
    const followUpCount = bodies.filter(body => body.includes('Direct follow-up that arrived during the transition')).length
    expect(followUpCount).toBe(1)
    const handoffIndex = bodies.findIndex(body => body.includes('handoff for the gate test'))
    const followUpIndex = bodies.findIndex(body => body.includes('Direct follow-up'))
    expect(handoffIndex).toBeGreaterThanOrEqual(0)
    expect(followUpIndex).toBeGreaterThan(handoffIndex)
  })

  it('rolls the same Member over twice with identical result sequences without id collisions', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, archived } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('twice-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('twice-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Both generations call context_rollover as their first tool call with the
    // same provider call id, so the folded result seq repeats exactly.
    adapter.enqueue(toolCallResponse('same-call-id', 'context_rollover', { handoff: 'first handoff' }))
    adapter.enqueue(textResponse('first continuation.'))
    ctx.agents.get(firstSessionId)!.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    const first = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId ? current : undefined
    })
    const secondSessionId = first.member.sessionId

    // Generation 2: wait for the ledger flip AND the new agent's
    // registration before steering input at it — the flip precedes the
    // retire/activate span, so the agent is not yet in ctx.agents when
    // members() first reports the new sessionId.
    adapter.enqueue(toolCallResponse('same-call-id', 'context_rollover', { handoff: 'second handoff' }))
    adapter.enqueue(textResponse('second continuation.'))
    const secondSessionAgent = await waitFor(() => ctx.agents.get(secondSessionId))
    secondSessionAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    const second = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== secondSessionId ? current : undefined
    })

    // Distinct generations, both archives preserved, and the ledger holds
    // exactly two rollover operations with distinct ids. Archiving rides
    // retirement, which follows the durable flip, so wait for both archives
    // rather than sampling the list straight after the flip.
    expect(second.member.sessionId).not.toBe(firstSessionId)
    expect(second.member.sessionId).not.toBe(secondSessionId)
    await waitForArchived(archived, firstSessionId, secondSessionId)
    expect(archived).not.toContain(second.member.sessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('derives bounded url-safe rollover identities from hostile provider call ids', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('hostile-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('hostile-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Path metacharacters, traversal segments, control characters, and an
    // unbounded length are all legal provider call ids; none of them may
    // reach the derived Session id, and the `:` separator merge must not
    // collide `x:y` with `x-y`.
    const hostileCallId = `../..\\x07${'\u0000'.repeat(3)}~ ${'a'.repeat(5000)}:tail`
    adapter.enqueue(toolCallResponse(hostileCallId, 'context_rollover', { handoff: 'hostile id handoff' }))
    adapter.enqueue(textResponse('continuing after the hostile id.'))
    ctx.agents.get(firstSessionId)!.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over now' }], source: { kind: 'user' } }))
    const first = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId ? current : undefined
    })
    const hostileSessionId = first.member.sessionId
    // Bounded and url-safe: a fixed prefix plus one sha256 hex digest, never
    // the provider id verbatim.
    expect(hostileSessionId).toMatch(/^agent-team-rollover-[0-9a-f]{64}$/)
    expect(hostileSessionId).not.toContain('..')
    expect(hostileSessionId.length).toBeLessThan(120)

    // The `:` merge collision: `x:y` and `x-y` must derive distinct
    // generations even though a naive `replaceAll(':', '-')` would alias them.
    const secondSessionId = hostileSessionId
    // The ledger flip precedes the retire/activate span: wait for the new
    // agent's registration, not just the members() projection.
    adapter.enqueue(toolCallResponse('x:y', 'context_rollover', { handoff: 'colon pair' }))
    adapter.enqueue(textResponse('colon continuation.'))
    const secondSessionAgent = await waitFor(() => ctx.agents.get(secondSessionId))
    secondSessionAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'colon' }], source: { kind: 'user' } }))
    const colon = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== secondSessionId ? current : undefined
    })
    const thirdSessionId = colon.member.sessionId
    // Same flip-to-registration window as above: wait for the agent itself.
    adapter.enqueue(toolCallResponse('x-y', 'context_rollover', { handoff: 'dash pair' }))
    adapter.enqueue(textResponse('dash continuation.'))
    const thirdSessionAgent = await waitFor(() => ctx.agents.get(thirdSessionId))
    thirdSessionAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'dash' }], source: { kind: 'user' } }))
    const dash = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== thirdSessionId ? current : undefined
    })
    expect(dash.member.sessionId).not.toBe(thirdSessionId)
    expect(dash.member.sessionId).toMatch(/^agent-team-rollover-[0-9a-f]{64}$/)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('delivers the handoff first even when unread Team facts exist at rollover time', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('unread-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('unread-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const previousSessionId = added.status.member.sessionId

    // An unread Team fact lands while the rollover turn is still settling:
    // its Inbox notice would ordinarily wake the next turn first, so this is
    // the discriminating window for handoff-first delivery.
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('unread-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Unread work that must not preempt the handoff', recipients: [memberId] })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    adapter.enqueue(textResponse('acknowledged.'))
    const live = ctx.agents.get(previousSessionId)!
    await waitForIdle(ctx, live)
    await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('unread-read'), workspaceId, taskRef: started.task!.taskRef })

    adapter.enqueue(toolCallResponse('call-nc', 'context_rollover', { handoff: 'handoff under unread pressure' }))
    adapter.enqueue(textResponse('continuing.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'hand off now' }], source: { kind: 'user' } }))
    // Once the rollover intent is durable, a fresh unread fact arrives; its
    // notice steers the old inbox, which the admission gate must hold back
    // while the handoff leads the new generation.
    const seenResult = Promise.withResolvers<void>()
    let seen = false
    const disposeSeen = ctx.on('session/event', (session, event) => {
      if (session.id !== previousSessionId || event.type !== 'tool/result' || seen) return
      seen = true
      seenResult.resolve()
    })
    await seenResult.promise
    disposeSeen()
    const update = await ctx.agentTeam.reply({ requestId: requestId('unread-update'), workspaceId, taskRef: started.task!.taskRef, body: 'Second unread update', baseRevision: (await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('unread-read-2'), workspaceId, taskRef: started.task!.taskRef })).thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed update, received ${update.kind}`)

    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== previousSessionId ? current : undefined
    })
    // The flip precedes the retire/activate span: wait for the new agent's
    // registration before reading its session log.
    const liveAfter = await waitFor(() => ctx.agents.get(renewed.member.sessionId))
    await waitFor(() => liveAfter.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    // The first model-facing user message of the new generation is the
    // handoff snapshot, not the rederived Team Inbox notice.
    const firstUser = liveAfter.session.ownEvents().find(event => event.type === 'user/message')
    expect(firstUser?.type).toBe('user/message')
    if (firstUser?.type !== 'user/message') throw new Error('expected first user message')
    expect(firstUser.data.source).toMatchObject({ kind: AGENT_TEAM_PLUGIN_ID, form: 'snapshot' })
    // The rederived Inbox still arrives afterwards — unread work is not lost.
    await waitFor(() => {
      const events = liveAfter.session.ownEvents().filter(event => event.type === 'user/message')
      return events.some(event => JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content).includes('Team Inbox has unread work')) ? true : undefined
    })
  })

  it('never reports the new Session as active during the rollover commit window', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('window-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('window-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const previousSessionId = added.status.member.sessionId

    adapter.enqueue(toolCallResponse('call-nc', 'context_rollover', { handoff: 'window handoff' }))
    adapter.enqueue(textResponse('continuing.'))
    ctx.agents.get(previousSessionId)!.followup(createUserMessage({ content: [{ type: 'text', text: 'hand off' }], source: { kind: 'user' } }))

    // Observe the exact commit window: the durable rollover operation is
    // visible while the old generation still runs and the new Session does
    // not exist yet. The Member must not report the new binding as active.
    const windowProbe = Promise.withResolvers<void>()
    let probed = false
    const disposeCommitted = ctx.on('agent-team/committed', () => {
      if (probed) return
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      if (status === undefined || status.member.sessionId === previousSessionId) return
      probed = true
      expect(status.availability).not.toBe('active')
      expect(status.presence).toBe('unavailable')
      expect(status.diagnostic).toMatchObject({ class: 'rollover', detail: 'context rollover in progress' })
      windowProbe.resolve()
    })
    const renewedSessionId = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== previousSessionId ? current.member.sessionId : undefined
    })
    await waitFor(() => ctx.agents.get(renewedSessionId)!)
    disposeCommitted()
    await windowProbe.promise
    // Once activation completes, the same Member reports active again.
    const settled = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!
    expect(settled.member.sessionId).toBe(renewedSessionId)
    expect(settled.availability).toBe('active')
  })

describe('Agent Team checkpoint selection and return (ticket 02)', () => {
  it('records a checkpoint at turn N and continues quietly in turn N+1 without an extra model request', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('cp-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('cp-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // The checkpoint tool result lands in turn 1; concludeTurn closes the
    // turn; the quiet Host continuation opens turn 2; its reply completes it.
    // The scripted adapter answers exactly one model request per turn, so a
    // checkpoint may not add any request beyond the ordinary continuation.
    adapter.enqueue(toolCallResponse('call-cp-1', 'context_checkpoint', { name: 'before-rewrite' }))
    adapter.enqueue(textResponse('continuing after the checkpoint.'))
    const requestCountBefore = adapter.requests.length
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'record a checkpoint' }], source: { kind: 'user' } }))
    // Wait until the continuation turn's reply lands, then for true idle.
    await waitFor(() => live.session.ownEvents().some(event => event.type === 'assistant/message') ? true : undefined)
    await live.whenIdle()

    const events = live.session.ownEvents()
    const turns = events.filter(event => event.type === 'turn/start').map(event => (event as { data: { turn: number } }).data.turn)
    expect(turns).toEqual([1, 2])
    // Exactly two model requests: the checkpoint turn and the continuation.
    expect(adapter.requests.length - requestCountBefore).toBe(2)
    // The continuation is the quiet Host notice, delivered as the first
    // message of turn 2.
    const turn2Index = events.findIndex(event => event.type === 'turn/start' && (event as { data: { turn: number } }).data.turn === 2)
    const afterTurn2 = events.slice(turn2Index + 1)
    const firstUser = afterTurn2.find(event => event.type === 'user/message')
    expect(firstUser?.type).toBe('user/message')
    if (firstUser?.type !== 'user/message') throw new Error('expected continuation user message')
    expect(firstUser.data.source).toMatchObject({ kind: AGENT_TEAM_PLUGIN_ID, form: 'snapshot' })
    expect(continuationCheckpointRefOf(firstUser.data)).toBeDefined()
  })

  it('records a checkpoint alongside sibling calls with results settling in model order', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('sib-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('sib-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // One step carrying two tool calls: the checkpoint plus a sibling
    // team_view. Both results commit in model order before the turn closes,
    // and the checkpoint anchor is that shared turn end. A single streamed
    // response carries both call blocks on distinct block indexes.
    const cpId = ToolCallId('call-sib-cp')
    const viewId = ToolCallId('call-sib-view')
    const cpArguments = JSON.stringify({ name: 'with-sibling' })
    const viewArguments = JSON.stringify({})
    const both = [
      { type: 'block-start', index: 0, blockType: 'tool-call' } as const,
      { type: 'tool-call-delta', index: 0, id: cpId, name: 'context_checkpoint', argumentsDelta: cpArguments } as never,
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: cpId, name: 'context_checkpoint', arguments: cpArguments } } as never,
      { type: 'block-start', index: 1, blockType: 'tool-call' } as const,
      { type: 'tool-call-delta', index: 1, id: viewId, name: 'team_view', argumentsDelta: viewArguments } as never,
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: viewId, name: 'team_view', arguments: viewArguments } } as never,
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } } as const,
      { type: 'finish', reason: { kind: 'tool-calls' } } as const,
    ]
    adapter.enqueue([...both] as never)
    adapter.enqueue(textResponse('both settled.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'checkpoint with a sibling' }], source: { kind: 'user' } }))
    await live.whenIdle()

    const events = live.session.ownEvents()
    const turnEnds = events.filter(event => event.type === 'turn/end')
    expect(turnEnds).toHaveLength(1)
    const results = events.filter(event => event.type === 'tool/result')
    expect(results.length).toBe(2)
    const state = foldTeamContextProjection(events, { sessionId: live.session.id })
    expect(state.checkpoints).toHaveLength(1)
    expect(state.checkpoints[0]!.turnEndSeq).toBe(turnEnds[0]!.seq)
  })

  it('a failed or dangling checkpoint call produces no checkpoint and no quiet follow-up', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('failcp-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('failcp-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // Malformed arguments (missing name) reject at the schema layer; the
    // turn completes with no checkpoint and no continuation turn opens.
    adapter.enqueue(toolCallResponse('call-fail-cp', 'context_checkpoint', {}))
    adapter.enqueue(textResponse('the checkpoint was rejected; continuing.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'try a broken checkpoint' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, live)
    await new Promise(resolve => setTimeout(resolve, 60))

    const events = live.session.ownEvents()
    const turns = events.filter(event => event.type === 'turn/start')
    expect(turns).toHaveLength(1)
    const state = foldTeamContextProjection(events, { sessionId: live.session.id })
    expect(state.checkpoints).toHaveLength(0)
    expect(state.continuations).toHaveLength(0)
  })

  it('returns the bounded structural timeline with restorable checkpoints and priced boundaries', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('tl-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('tl-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // Record two checkpoints, then read the timeline through the tool. Each
    // checkpoint turn is followed by a quiet continuation turn, so wait for
    // the continuation's reply before recording the next anchor.
    const continuationReplies = (text: string) => () => live.session.ownEvents().some(event => {
      if (event.type !== 'assistant/message') return false
      return JSON.stringify(event.data.message.content).includes(text)
    }) ? true : undefined
    adapter.enqueue(toolCallResponse('call-tl-cp1', 'context_checkpoint', { name: 'first anchor' }))
    adapter.enqueue(textResponse('one.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'checkpoint one' }], source: { kind: 'user' } }))
    await waitFor(continuationReplies('one.'))
    await live.whenIdle()
    adapter.enqueue(toolCallResponse('call-tl-cp2', 'context_checkpoint', { name: 'second anchor' }))
    adapter.enqueue(textResponse('two.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'checkpoint two' }], source: { kind: 'user' } }))
    await waitFor(continuationReplies('two.'))
    await live.whenIdle()

    const timeline = await ctx.agentTeam.contextTimelineForAgent(live, { memberId: added.status.member.memberId })
    expect(timeline.items.length).toBeGreaterThanOrEqual(2)
    const refs = timeline.items.map(item => item.checkpointRef)
    expect(refs).toContain(checkpointRefFor(sessionId, 'call-tl-cp1'))
    expect(refs).toContain(checkpointRefFor(sessionId, 'call-tl-cp2'))
    // Newest first, head present, every agent checkpoint restorable.
    const first = timeline.items.find(item => item.checkpointRef === checkpointRefFor(sessionId, 'call-tl-cp1'))!
    const second = timeline.items.find(item => item.checkpointRef === checkpointRefFor(sessionId, 'call-tl-cp2'))!
    expect(first.restorable).toBe(true)
    expect(second.restorable).toBe(true)
    expect(timeline.items.findIndex(item => item.checkpointRef === checkpointRefFor(sessionId, 'call-tl-cp2'))).toBeLessThan(timeline.items.findIndex(item => item.checkpointRef === checkpointRefFor(sessionId, 'call-tl-cp1')))
    const head = timeline.items.find(item => item.source === 'head')
    expect(head).toBeDefined()
    expect(head!.restorable).toBe(false)
    // A current-generation anchor's discarded estimate is the measured usage
    // beyond the anchor (the suffix a return would drop), never the whole
    // current usage; retained + discarded equals the measurement.
    expect(first.discardedTokens).toBe(Math.max(0, timeline.usageTokens - first.retainedTokens))
    expect(first.retainedTokens + first.discardedTokens).toBeLessThanOrEqual(timeline.usageTokens)
    // The limit bounds the list.
    const limited = await ctx.agentTeam.contextTimelineForAgent(live, { memberId: added.status.member.memberId, limit: 1 })
    expect(limited.items).toHaveLength(1)
  })

  it('marks the timeline incomplete at an unreadable ancestor without touching Member availability', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('tl-inc-channel'), workspaceId, name: 'engineering', description: 'Engineering Work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('tl-inc-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Generation 1 runs a turn, then a fresh rollover archives it as the
    // new generation's lineage ancestor.
    const live = ctx.agents.get(firstSessionId)!
    adapter.enqueue(textResponse('gen1 work.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'gen1 work' }], source: { kind: 'user' } }))
    await waitFor(() => live.session.ownEvents().some(event => event.type === 'assistant/message') ? true : undefined)
    await live.whenIdle()
    adapter.enqueue(toolCallResponse('call-tl-inc-nc', 'context_rollover', { handoff: 'gen2 handoff' }))
    adapter.enqueue(textResponse('gen2 starting.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId ? current : undefined
    })
    const next = await waitFor(() => ctx.agents.get(renewed.member.sessionId)!)
    await waitFor(() => next.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    await next.whenIdle()

    // The archived ancestor becomes unreadable: the timeline must record
    // where and why history stopped instead of silently ending, and the
    // Member's availability must not change — an ancestor read is history,
    // not a current-binding fact.
    const realOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.open = async (id, access, options) => {
      if (id === firstSessionId) throw new SessionFormatUnsupportedError('cannot safely transform unclassified message source (test seam)')
      return realOpen(id, access, options)
    }
    const timeline = await ctx.agentTeam.contextTimelineForAgent(next, { memberId, limit: 24 })
    expect(timeline.incompleteFrom).toMatchObject({ sessionId: firstSessionId, reason: expect.stringMatching(/^refused: /) })
    expect(timeline.items.length).toBeGreaterThan(0)
    // A generation opens on its handoff boundary: it is read with Team's own
    // source vocabulary and is never a return target, so a return into the
    // generation's opening is refused with a reason that names the source.
    const handoff = timeline.items.find(item => item.source === 'handoff')
    expect(handoff).toMatchObject({ name: 'context handoff', restorable: false, reason: "source 'handoff' is not a restorable checkpoint" })
    const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!
    expect(status.availability).toBe('active')
    expect(status.presence).not.toBe('unavailable')
  })

  it('returns to a checkpoint through context_rollover: exact seed prefix, handoff first, seed lineage', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, archived } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('ret-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('ret-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Turn 1 records the anchor; the continuation answers; turn 3+ makes
    // noise worth discarding; then the model returns to the anchor. Wait on
    // the continuation's reply text so the anchor turn is fully resolved
    // before its prefix is captured.
    adapter.enqueue(toolCallResponse('call-ret-cp', 'context_checkpoint', { name: 'good state' }))
    adapter.enqueue(textResponse('anchored.'))
    const live = ctx.agents.get(firstSessionId)!
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'record the anchor' }], source: { kind: 'user' } }))
    await waitFor(() => live.session.ownEvents().some(event => {
      if (event.type !== 'assistant/message') return false
      return JSON.stringify(event.data.message.content).includes('anchored.')
    }) ? true : undefined)
    await live.whenIdle()
    const anchorEvents = live.session.ownEvents().length
    const anchorTurnEndSeq = foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id }).checkpoints[0]!.turnEndSeq

    adapter.enqueue(textResponse('noisy branch work.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'now make some noise' }], source: { kind: 'user' } }))
    await waitFor(() => live.session.ownEvents().filter(event => event.type === 'assistant/message').length >= 2 ? true : undefined)
    await live.whenIdle()
    expect(live.session.ownEvents().length).toBeGreaterThan(anchorEvents)

    // Return to the anchor with a handoff bridging the discarded branch.
    adapter.enqueue(toolCallResponse('call-ret-nc', 'context_rollover', { handoff: 'The noisy branch failed; resume from the anchor.', checkpointRef: checkpointRefFor(firstSessionId, 'call-ret-cp') }))
    adapter.enqueue(textResponse('resumed from the anchor.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'return to the anchor' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId ? current : undefined
    })
    const newSessionId = renewed.member.sessionId
    const next = await waitFor(() => ctx.agents.get(newSessionId)!)

    // Seeded lineage: parent is the seed source (the same Session here),
    // isSeeded is set, and the inherited prefix is exactly the anchor cut.
    expect(next.session.header.parentSession).toBe(firstSessionId)
    expect(next.session.inheritedEventCount).toBe(anchorTurnEndSeq + 1)
    const own = next.session.ownEvents()
    const inherited = next.session.snapshotEvents(0 as never, next.session.inheritedEventCount)
    // The inherited prefix ends on the anchor's turn end; nothing later.
    expect(inherited.at(-1)!.seq).toBe(anchorTurnEndSeq)
    // The handoff is the first own model-facing context. The binding flip
    // precedes the handoff delivery (the swap steers it after activation);
    // wait for the delivered event before asserting on it. Probe ownEvents()
    // fresh each round — the snapshot taken above predates the handoff append
    // whenever the agent registers before the steering lands, and polling a
    // stale snapshot would never observe it.
    await waitFor(() => next.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    const firstUser = next.session.ownEvents().find(event => event.type === 'user/message')
    expect(firstUser?.type).toBe('user/message')
    if (firstUser?.type !== 'user/message') throw new Error('expected handoff')
    expect(handoffOf(firstUser.data)).toMatchObject({ checkpointRef: checkpointRefFor(firstSessionId, 'call-ret-cp') })
    expect((firstUser.data.content[0] as { text: string }).text).toContain('resume from the anchor')
    // Inherited historical intent stays inert: the inherited prefix's
    // checkpoint history is visible, but no continuation or rollover is
    // rescheduled from it.
    const state = foldTeamContextProjection(own, { sessionId: next.session.id, inheritedEventCount: next.session.inheritedEventCount })
    expect(state.pending).toBeNull()
    expect(state.continuations).toHaveLength(0)
    // The old generation archived; the ledger records the seed fields.
    await waitForArchived(archived, firstSessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })
})

describe('Agent Team checkpoint lineage (ticket 02 ancestors)', () => {
  it('returns to a checkpoint in an archived ancestor: seed from the ancestor, archive only the previous active', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, archived } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('anc-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('anc-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Generation 1: record the anchor, let its continuation settle.
    adapter.enqueue(toolCallResponse('call-anc-cp', 'context_checkpoint', { name: 'gen1 anchor' }))
    adapter.enqueue(textResponse('gen1 anchored.'))
    const gen1 = ctx.agents.get(firstSessionId)!
    gen1.followup(createUserMessage({ content: [{ type: 'text', text: 'record the gen1 anchor' }], source: { kind: 'user' } }))
    await waitFor(() => gen1.session.ownEvents().some(event => {
      if (event.type !== 'assistant/message') return false
      return JSON.stringify(event.data.message.content).includes('gen1 anchored.')
    }) ? true : undefined)
    await gen1.whenIdle()

    // Fresh rollover into generation 2 (no checkpoint): the anchor stays in
    // generation 1, which becomes an archived ancestor.
    adapter.enqueue(toolCallResponse('call-anc-fresh', 'context_rollover', { handoff: 'gen2 handoff' }))
    adapter.enqueue(textResponse('gen2 running.'))
    gen1.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over fresh' }], source: { kind: 'user' } }))
    const gen2Status = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId ? current : undefined
    })
    const secondSessionId = gen2Status.member.sessionId
    const gen2 = await waitFor(() => ctx.agents.get(secondSessionId)!)
    await waitFor(() => gen2.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    await gen2.whenIdle()
    expect(archived).toContain(firstSessionId)

    // Generation 2 makes noise, then returns to the archived ancestor's
    // anchor. The seed source is generation 1 (the ancestor), while the
    // previous active Session (generation 2) archives separately.
    adapter.enqueue(textResponse('gen2 noise.'))
    gen2.followup(createUserMessage({ content: [{ type: 'text', text: 'gen2 noise' }], source: { kind: 'user' } }))
    await waitFor(() => gen2.session.ownEvents().filter(event => event.type === 'assistant/message').length >= 2 ? true : undefined)
    await gen2.whenIdle()

    adapter.enqueue(toolCallResponse('call-anc-return', 'context_rollover', { handoff: 'Return to the gen1 anchor; the gen2 branch is discarded.', checkpointRef: checkpointRefFor(firstSessionId, 'call-anc-cp') }))
    adapter.enqueue(textResponse('resumed from the ancestor anchor.'))
    gen2.followup(createUserMessage({ content: [{ type: 'text', text: 'return to the ancestor anchor' }], source: { kind: 'user' } }))
    const gen3Status = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== secondSessionId ? current : undefined
    })
    const thirdSessionId = gen3Status.member.sessionId
    const gen3 = await waitFor(() => ctx.agents.get(thirdSessionId)!)

    // Lineage: the seed parent is the archived ancestor (generation 1),
    // and both the ancestor and the previous active generation stay
    // archived — the ledger keeps them distinct.
    expect(gen3.session.header.parentSession).toBe(firstSessionId)
    expect(gen3.session.inheritedEventCount).toBeGreaterThan(0)
    await waitForArchived(archived, firstSessionId, secondSessionId)
    expect(archived).not.toContain(thirdSessionId)
    // The inherited prefix is exactly the ancestor's anchor cut.
    const gen1Fold = foldTeamContextProjection(gen1.session.ownEvents(), { sessionId: firstSessionId })
    const anchor = gen1Fold.checkpoints.find(entry => entry.checkpointRef === checkpointRefFor(firstSessionId, 'call-anc-cp'))!
    expect(gen3.session.inheritedEventCount).toBe(anchor.turnEndSeq + 1)
    // The handoff is the first own model-facing context of generation 3.
    // The binding flip precedes the handoff delivery; wait for the event.
    await waitFor(() => gen3.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    const firstOwnUser = gen3.session.ownEvents().find(event => event.type === 'user/message')
    expect(firstOwnUser?.type).toBe('user/message')
    if (firstOwnUser?.type !== 'user/message') throw new Error('expected handoff')
    expect(handoffOf(firstOwnUser.data)).toMatchObject({ checkpointRef: checkpointRefFor(firstSessionId, 'call-anc-cp') })
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('delivers a checkpoint continuation exactly once across Host restarts', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('repair-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('repair-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const sessionId = added.status.member.sessionId

    // Record a checkpoint; its quiet continuation may deliver before or
    // after the crash point — the discriminating invariant is that restarts
    // never duplicate it, because the projection's delivery record is
    // durable and the repair path reads it before scheduling.
    adapter.enqueue(toolCallResponse('call-repair-cp', 'context_checkpoint', { name: 'pre-crash anchor' }))
    const live = ctx.agents.get(sessionId)!
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'checkpoint before the crash' }], source: { kind: 'user' } }))
    await waitFor(() => foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id }).checkpoints.some(entry => entry.turnEndSeq !== -1) ? true : undefined)
    await live.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 50))
    const deliveredBeforeRestart = live.session.ownEvents().filter(event => event.type === 'user/message'
      && isCheckpointContinuationMessage(event.data)).length
    expect(deliveredBeforeRestart).toBeLessThanOrEqual(1)

    // Host restart on the same harness: the plugin remounts, the persisted
    // session replays, and the repair path may deliver one continuation for
    // a resolved-but-undelivered checkpoint — never a second one on top of
    // a delivered record. Each remount returns its own fiber; dispose the
    // current one, not the stale first-generation handle.
    adapter.enqueue(textResponse('repaired continuation.'))
    await ctx.agentTeam.suspendMember({ requestId: requestId('repair-suspend'), memberId: added.status.member.memberId })
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    const secondFiber = await ctx.plugin(AgentTeam)
    await ctx.agentTeam.resumeMember({ requestId: requestId('repair-resume'), memberId: added.status.member.memberId })
    const resumed = await waitFor(() => {
      const agent = ctx.agents.get(sessionId)
      return agent !== undefined && agent.status === 'idle' ? agent : undefined
    })
    await waitFor(() => resumed.session.ownEvents().some(event => event.type === 'user/message'
      && isCheckpointContinuationMessage(event.data)) ? true : undefined)
    await resumed.whenIdle()
    const continuations = resumed.session.ownEvents().filter(event => event.type === 'user/message'
      && isCheckpointContinuationMessage(event.data))
    expect(continuations).toHaveLength(1)

    // Restarting again does not duplicate the delivered continuation: the
    // projection's delivery record is durable.
    await ctx.agentTeam.suspendMember({ requestId: requestId('repair-suspend2'), memberId: added.status.member.memberId })
    await secondFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    await ctx.agentTeam.resumeMember({ requestId: requestId('repair-resume2'), memberId: added.status.member.memberId })
    const resumed2 = await waitFor(() => {
      const agent = ctx.agents.get(sessionId)
      return agent !== undefined && agent.status === 'idle' ? agent : undefined
    })
    await new Promise(resolve => setTimeout(resolve, 150))
    const continuations2 = resumed2.session.ownEvents().filter(event => event.type === 'user/message'
      && isCheckpointContinuationMessage(event.data))
    expect(continuations2).toHaveLength(1)
  })
})

describe('Agent Team pressure policy integration (ticket 03)', () => {
  it('steers the one-shot pressure notice into a running Member turn at the handoff budget', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('press-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('press-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // Below the handoff budget: no notice at all.
    pressureState.usageTokens = 150_000
    adapter.enqueue(textResponse('ordinary work.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'ordinary turn' }], source: { kind: 'user' } }))
    await live.whenIdle()
    expect(live.session.ownEvents().some(event => event.type === 'user/message'
      && (event.data as { source?: { summary?: string } }).source?.summary === 'Context pressure: prepare a handoff')).toBe(false)

    // At the handoff budget: exactly one structured notice rides the next
    // turn, and further turns in the same generation do not repeat it.
    pressureState.usageTokens = 200_000
    adapter.enqueue(textResponse('under pressure.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'another turn' }], source: { kind: 'user' } }))
    await live.whenIdle()
    const notices = () => live.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { summary?: string } }).source?.summary === 'Context pressure: prepare a handoff')
    expect(notices()).toHaveLength(1)
    const notice = notices()[0]!
    expect((notice.data as { content: ReadonlyArray<{ type: string; text?: string }> }).content[0]?.text).toContain('context_rollover')

    adapter.enqueue(textResponse('still under pressure.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'third turn' }], source: { kind: 'user' } }))
    await live.whenIdle()
    expect(notices()).toHaveLength(1)
    // The Member stays available throughout: a notice is not a failure.
    const status = ctx.agentTeam.members().find(entry => entry.member.memberId === added.status.member.memberId)!
    expect(status.availability).toBe('active')
  })

  it('a fresh rollover re-arms the pressure notice for the new generation', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('rearm-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('rearm-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const previousSessionId = added.status.member.sessionId

    pressureState.usageTokens = 200_000
    adapter.enqueue(textResponse('pressured turn.'))
    const live = ctx.agents.get(previousSessionId)!
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'turn one' }], source: { kind: 'user' } }))
    await live.whenIdle()
    const noticesIn = (agent: ReturnType<typeof ctx.agents.get>) => agent!.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { summary?: string } }).source?.summary === 'Context pressure: prepare a handoff')
    expect(noticesIn(live)).toHaveLength(1)

    // Fresh rollover: the new generation gets its own notice budget.
    pressureState.usageTokens = 200_000
    adapter.enqueue(toolCallResponse('call-rearm-nc', 'context_rollover', { handoff: 'rearm handoff' }))
    adapter.enqueue(textResponse('new generation.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'hand off' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== previousSessionId ? current : undefined
    })
    const next = await waitFor(() => ctx.agents.get(renewed.member.sessionId)!)
    await waitFor(() => next.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    await next.whenIdle()
    // The new generation observes the budget again on its next turn.
    pressureState.usageTokens = 200_000
    adapter.enqueue(textResponse('next generation turn.'))
    next.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await next.whenIdle()
    expect(noticesIn(next)).toHaveLength(1)
  })

  it('task acceptance no longer schedules standalone auto compaction', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('noauto-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('noauto-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    pressureState.usageTokens = 0
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('noauto-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Investigate the release', recipients: [memberId] })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const live = ctx.agents.get(added.status.member.sessionId)!
    await waitForIdle(ctx, live)
    const read = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('noauto-read'), workspaceId, taskRef: started.task!.taskRef })
    const claim = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('noauto-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: read.thread.revision, direction: 'own the fix' })
    if (claim.kind !== 'committed') throw new Error(`expected committed claim, received ${claim.kind}`)
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('noauto-human-read'), workspaceId, taskRef: started.task!.taskRef })
    const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('noauto-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
    if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)
    // The Member stays available with no compaction failure: acceptance is
    // a semantic cue, never an unconditional summarization job. The
    // compaction diagnostic surface is empty (no memberFailures entry).
    const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!
    expect(status.availability).toBe('active')
    expect(status.presence === 'available' || status.presence === 'working').toBe(true)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('enriches an unread accept read with three-tier context advice priced by the current route', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('advice-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('advice-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('advice-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Ship the feature', recipients: [memberId] })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const live = ctx.agents.get(added.status.member.sessionId)!
    await waitForIdle(ctx, live)
    const memberRead = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-member-read'), workspaceId, taskRef: started.task!.taskRef })
    const claimed = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('advice-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: memberRead.thread.revision, direction: 'own it' })
    if (claimed.kind !== 'committed') throw new Error(`expected committed claim, received ${claimed.kind}`)
    const readDone = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-done-read'), workspaceId, taskRef: started.task!.taskRef })
    const done = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('advice-done'), workspaceId, taskRef: started.task!.taskRef, action: 'done', claimRef: (claimed as { claim: { claimRef: AgentTeamClaimRef } }).claim.claimRef, baseRevision: readDone.thread.revision })
    if (done.kind !== 'committed') throw new Error(`expected committed done, received ${done.kind}`)
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('advice-human-read'), workspaceId, taskRef: started.task!.taskRef })
    const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('advice-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
    if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)

    // Tier boundary: 127,999 (just below the 128K task-boundary threshold on
    // a 320K window route) keeps the context.
    pressureState.usageTokens = 127_999
    const keep = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-read-keep'), workspaceId, taskRef: started.task!.taskRef })
    expect(keep.contextAdvice).toMatchObject({ action: 'keep', usageTokens: 127_999, taskBoundaryThreshold: 128_000, handoffAt: 200_000 })
    expect(keep.contextAdvice?.guidance).toContain('do not create a redundant checkpoint')

    // A repeat read after the unread batch was consumed carries no advice:
    // one acceptance advises once, through the read that acknowledged it.
    const repeat = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-read-repeat'), workspaceId, taskRef: started.task!.taskRef })
    expect(repeat.contextAdvice).toBeUndefined()

    // 128,000 exactly: advise a fresh rollover after closeout. Each tier is
    // priced through its own acceptance: the Task is reopened and accepted
    // again so the acknowledging read re-establishes the trigger.
    pressureState.usageTokens = 128_000
    const reopenedForRollover = await ctx.agentTeam.changeTask({ requestId: requestId('advice-reopen-rollover'), workspaceId, taskRef: started.task!.taskRef, action: 'reopen', baseRevision: repeat.thread.revision })
    if (reopenedForRollover.kind !== 'committed') throw new Error(`expected committed reopen, received ${reopenedForRollover.kind}`)
    const memberReadRollover = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-member-read-rollover'), workspaceId, taskRef: started.task!.taskRef })
    const claimedRollover = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('advice-claim-rollover'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: memberReadRollover.thread.revision, direction: 'own it for rollover' })
    if (claimedRollover.kind !== 'committed') throw new Error(`expected committed claim, received ${claimedRollover.kind}`)
    const readDoneRollover = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-done-read-rollover'), workspaceId, taskRef: started.task!.taskRef })
    const doneRollover = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('advice-done-rollover'), workspaceId, taskRef: started.task!.taskRef, action: 'done', claimRef: (claimedRollover as { claim: { claimRef: AgentTeamClaimRef } }).claim.claimRef, baseRevision: readDoneRollover.thread.revision })
    if (doneRollover.kind !== 'committed') throw new Error(`expected committed done, received ${doneRollover.kind}`)
    const humanReadRollover = await ctx.agentTeam.readThread({ requestId: requestId('advice-human-read-rollover'), workspaceId, taskRef: started.task!.taskRef })
    const acceptedRollover = await ctx.agentTeam.changeTask({ requestId: requestId('advice-accept-rollover'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanReadRollover.thread.revision })
    if (acceptedRollover.kind !== 'committed') throw new Error(`expected committed accept, received ${acceptedRollover.kind}`)
    const rollover = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-read-rollover'), workspaceId, taskRef: started.task!.taskRef })
    expect(rollover.contextAdvice?.action).toBe('rollover')
    expect(rollover.contextAdvice?.guidance).toContain('context_rollover')

    // At the handoff budget the tier escalates to compact-now.
    pressureState.usageTokens = 200_000
    const rolloverRepeat = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-read-rollover-repeat'), workspaceId, taskRef: started.task!.taskRef })
    expect(rolloverRepeat.contextAdvice).toBeUndefined()
    const reopened = await ctx.agentTeam.changeTask({ requestId: requestId('advice-reopen'), workspaceId, taskRef: started.task!.taskRef, action: 'reopen', baseRevision: rolloverRepeat.thread.revision })
    if (reopened.kind !== 'committed') throw new Error(`expected committed reopen, received ${reopened.kind}`)
    const memberRead2 = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-member-read-2'), workspaceId, taskRef: started.task!.taskRef })
    const claimed2 = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('advice-claim-2'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: memberRead2.thread.revision, direction: 'own it again' })
    if (claimed2.kind !== 'committed') throw new Error(`expected committed claim, received ${claimed2.kind}`)
    const readDone2 = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-done-read-2'), workspaceId, taskRef: started.task!.taskRef })
    const done2 = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('advice-done-2'), workspaceId, taskRef: started.task!.taskRef, action: 'done', claimRef: (claimed2 as { claim: { claimRef: AgentTeamClaimRef } }).claim.claimRef, baseRevision: readDone2.thread.revision })
    if (done2.kind !== 'committed') throw new Error(`expected committed done, received ${done2.kind}`)
    const humanRead2 = await ctx.agentTeam.readThread({ requestId: requestId('advice-human-read-2'), workspaceId, taskRef: started.task!.taskRef })
    const accepted2 = await ctx.agentTeam.changeTask({ requestId: requestId('advice-accept-2'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead2.thread.revision })
    if (accepted2.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted2.kind}`)
    const compactNow = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-read-now'), workspaceId, taskRef: started.task!.taskRef })
    expect(compactNow.contextAdvice?.action).toBe('compact-now')
    expect(compactNow.contextAdvice?.guidance).toContain('context_compact')

    // A reopen-after-accept that is still unread must NOT advise: the Task is
    // open again, the acceptance no longer stands.
    const reopened2 = await ctx.agentTeam.changeTask({ requestId: requestId('advice-reopen-2'), workspaceId, taskRef: started.task!.taskRef, action: 'reopen', baseRevision: compactNow.thread.revision })
    if (reopened2.kind !== 'committed') throw new Error(`expected committed reopen, received ${reopened2.kind}`)
    const staleAcceptRead = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('advice-read-stale'), workspaceId, taskRef: started.task!.taskRef })
    expect(staleAcceptRead.contextAdvice).toBeUndefined()

    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('prices the accept advice threshold from a narrow route and degrades to unavailable when measurement fails', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('narrow-advice-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('narrow-advice-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    adapter.resolveModelWindow = (model: string) => model === 'narrow' ? 112_000 : 320_000
    await ctx.agentTeam.updateMember({ requestId: requestId('narrow-advice-pin'), memberId, handle: 'builder', description: 'Builds the implementation', model: { provider: 'mock', model: 'narrow' } })
    pressureState.usageTokens = 0
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('narrow-advice-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Ship it', recipients: [memberId] })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const live = ctx.agents.get(added.status.member.sessionId)!
    await waitForIdle(ctx, live)
    const memberRead = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('narrow-advice-read-claim'), workspaceId, taskRef: started.task!.taskRef })
    const claimed = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('narrow-advice-claim'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: memberRead.thread.revision, direction: 'narrow route' })
    if (claimed.kind !== 'committed') throw new Error(`expected committed claim, received ${claimed.kind}`)
    const readDone = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('narrow-advice-read-done'), workspaceId, taskRef: started.task!.taskRef })
    const done = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('narrow-advice-done'), workspaceId, taskRef: started.task!.taskRef, action: 'done', claimRef: (claimed as { claim: { claimRef: AgentTeamClaimRef } }).claim.claimRef, baseRevision: readDone.thread.revision })
    if (done.kind !== 'committed') throw new Error(`expected committed done, received ${done.kind}`)
    const humanRead = await ctx.agentTeam.readThread({ requestId: requestId('narrow-advice-human-read'), workspaceId, taskRef: started.task!.taskRef })
    const accepted = await ctx.agentTeam.changeTask({ requestId: requestId('narrow-advice-accept'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
    if (accepted.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted.kind}`)

    // Narrow route (112K window → 88K handoff): the threshold is
    // min(128K, 88K) = 88K — 87,999 keeps, the fixed 128K number would be
    // too late for this route.
    pressureState.usageTokens = 87_999
    const keep = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('narrow-advice-read-keep'), workspaceId, taskRef: started.task!.taskRef })
    expect(keep.contextAdvice).toMatchObject({ action: 'keep', taskBoundaryThreshold: 88_000 })
    expect(keep.contextAdvice?.usageTokens).toBe(87_999)

    // Meter failure degrades to an explicit unavailable advice, never a
    // fabricated threshold verdict and never a failed read.
    const reopened = await ctx.agentTeam.changeTask({ requestId: requestId('narrow-advice-reopen'), workspaceId, taskRef: started.task!.taskRef, action: 'reopen', baseRevision: keep.thread.revision })
    if (reopened.kind !== 'committed') throw new Error(`expected committed reopen, received ${reopened.kind}`)
    const memberRead2 = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('narrow-advice-read-2'), workspaceId, taskRef: started.task!.taskRef })
    const claimed2 = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('narrow-advice-claim-2'), workspaceId, taskRef: started.task!.taskRef, action: 'claim', baseRevision: memberRead2.thread.revision, direction: 'again' })
    if (claimed2.kind !== 'committed') throw new Error(`expected committed claim, received ${claimed2.kind}`)
    const readDone2 = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('narrow-advice-read-done-2'), workspaceId, taskRef: started.task!.taskRef })
    const done2 = await ctx.agentTeam.changeClaimForAgent(live, { requestId: requestId('narrow-advice-done-2'), workspaceId, taskRef: started.task!.taskRef, action: 'done', claimRef: (claimed2 as { claim: { claimRef: AgentTeamClaimRef } }).claim.claimRef, baseRevision: readDone2.thread.revision })
    if (done2.kind !== 'committed') throw new Error(`expected committed done, received ${done2.kind}`)
    const humanRead2 = await ctx.agentTeam.readThread({ requestId: requestId('narrow-advice-human-read-2'), workspaceId, taskRef: started.task!.taskRef })
    const accepted2 = await ctx.agentTeam.changeTask({ requestId: requestId('narrow-advice-accept-2'), workspaceId, taskRef: started.task!.taskRef, action: 'accept', baseRevision: humanRead2.thread.revision })
    if (accepted2.kind !== 'committed') throw new Error(`expected committed accept, received ${accepted2.kind}`)
    pressureState.failFor.add(added.status.member.sessionId)
    const degraded = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('narrow-advice-read-degraded'), workspaceId, taskRef: started.task!.taskRef })
    // The read still succeeded (durable watermark advanced) with an
    // explicit unavailable advice instead of numbers.
    expect(degraded.thread.revision).toBeGreaterThanOrEqual(accepted2.thread.revision)
    expect(degraded.contextAdvice?.action).toBe('unavailable')
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('wakes a normal-accept contributor with both the accepted and completed Claim semantics', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('notify-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('notify-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const reviewer = await ctx.agentTeam.addMember({ requestId: requestId('notify-reviewer'), workspaceId, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('notify-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Ship both semantics', recipients: [builder.status.member.memberId, reviewer.status.member.memberId] })
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('emptyclause-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('emptyclause-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('emptyclause-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Ship the early accept', recipients: [builder.status.member.memberId] })
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

  it('derives the pressure budgets from the Member\'s current pinned route, honoring route changes', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('route-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    // A Member pinned to a narrow-window model: the mock adapter reports one
    // context window, the pinned-model resolution must reflect the pinned
    // route rather than whatever the last request happened to use.
    const added = await ctx.agentTeam.addMember({ requestId: requestId('route-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!
    pressureState.usageTokens = 0
    adapter.enqueue(textResponse('first turn on the default route.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'warm up' }], source: { kind: 'user' } }))
    await live.whenIdle()

    // Pin a different route with a much smaller context window; the budgets
    // must follow the pinned selection at the next pre-step even though the
    // last persisted request/context still names the old default route.
    await ctx.agentTeam.updateMember({ requestId: requestId('route-edit'), memberId, handle: 'builder', description: 'Builds the implementation', model: { provider: 'mock', model: 'narrow' } })
    adapter.resolveModelWindow = (model: string) => model === 'narrow' ? 112_000 : 320_000
    // 90K usage: below the wide-route handoff budget (200K) but above the
    // narrow route's effective budgets (112K window → 96K hard, 88K handoff).
    // The notice must fire for the NARROW budgets because the pinned route
    // changed — and quote them, not the default route's.
    pressureState.usageTokens = 90_000
    adapter.enqueue(textResponse('under the narrow budget now.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'check the narrow budget' }], source: { kind: 'user' } }))
    await live.whenIdle()
    const notices = live.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { summary?: string } }).source?.summary === 'Context pressure: prepare a handoff')
    expect(notices).toHaveLength(1)
    const notice = notices[0] as { type: 'user/message'; data: { content: ReadonlyArray<{ type: string; text?: string }> } }
    const noticeText = notice.data.content[0]?.text ?? ''
    // The notice quotes the NARROW route's budgets, not the default's.
    expect(noticeText).toContain('the handoff budget is 88000')
    expect(noticeText).toContain('the hard limit is 96000')
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('does not repeat the pressure notice after a Host restart within the same generation', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('prestart-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('prestart-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // At the handoff budget, exactly one notice lands in this generation.
    pressureState.usageTokens = 200_000
    adapter.enqueue(textResponse('working under pressure.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'under pressure' }], source: { kind: 'user' } }))
    await live.whenIdle()
    const noticeCount = () => live.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { summary?: string } }).source?.summary === 'Context pressure: prepare a handoff').length
    expect(noticeCount()).toBe(1)

    // Host restart on the same Session: the durable notice (delivered or
    // still spliced into the inbox) latches — no second notice in the same
    // generation, and the Member stays available.
    adapter.enqueue(textResponse('still going after the restart.'))
    await ctx.agentTeam.suspendMember({ requestId: requestId('prestart-suspend'), memberId })
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    await ctx.agentTeam.resumeMember({ requestId: requestId('prestart-resume'), memberId })
    const resumed = await waitFor(() => {
      const agent = ctx.agents.get(sessionId)
      return agent !== undefined && agent.status === 'idle' ? agent : undefined
    })
    pressureState.usageTokens = 210_000
    adapter.enqueue(textResponse('one more turn after the restart.'))
    resumed.followup(createUserMessage({ content: [{ type: 'text', text: 'keep working' }], source: { kind: 'user' } }))
    await resumed.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 100))
    const after = resumed.session.ownEvents().filter(event => event.type === 'user/message'
      && (event.data as { source?: { summary?: string } }).source?.summary === 'Context pressure: prepare a handoff').length
    expect(after).toBe(1)
    const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)!
    expect(status.availability).toBe('active')
  })
})

describe('Agent Team recovery hardening (ticket 04)', () => {
  it('refuses context_rollover while the Member owns jobs that would not survive the switch', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, jobsState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('jobs-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('jobs-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // A running job blocks the rollover; the rejection names it.
    jobsState.jobs = [{ id: 'bash-1', label: 'long build', status: 'running', reported: false }]
    adapter.enqueue(toolCallResponse('call-jobs-nc-1', 'context_rollover', { handoff: 'blocked by a running job' }))
    adapter.enqueue(textResponse('collecting the job first.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'try switching with a running job' }], source: { kind: 'user' } }))
    await live.whenIdle()
    const firstResult = live.session.ownEvents().findLast(event => event.type === 'tool/result' && JSON.stringify((event as { data: { message: { content: unknown } } }).data.message.content).includes('long build'))
    expect(firstResult).toBeDefined()

    // A terminal-but-unreported job also blocks: disposal would discard its
    // unreported output.
    jobsState.jobs = [{ id: 'bash-2', label: 'finished silently', status: 'completed', reported: false }]
    adapter.enqueue(toolCallResponse('call-jobs-nc-2', 'context_rollover', { handoff: 'blocked by unreported output' }))
    adapter.enqueue(textResponse('reading the output first.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'try again with unreported output' }], source: { kind: 'user' } }))
    await live.whenIdle()
    const secondResult = live.session.ownEvents().findLast(event => event.type === 'tool/result' && JSON.stringify((event as { data: { message: { content: unknown } } }).data.message.content).includes('finished silently'))
    expect(secondResult).toBeDefined()

    // A reported terminal job does not block: the Member may switch.
    jobsState.jobs = [{ id: 'bash-3', label: 'reported done', status: 'completed', reported: true }]
    adapter.enqueue(toolCallResponse('call-jobs-nc-3', 'context_rollover', { handoff: 'clean switch' }))
    adapter.enqueue(textResponse('switched.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'try now that everything is reported' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === added.status.member.memberId)
      return current !== undefined && current.member.sessionId !== sessionId ? current : undefined
    })
    expect(renewed.member.sessionId).not.toBe(sessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('keeps a delivered rollover handoff durable across a Host restart without duplicating it', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('hfix-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('hfix-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // One fresh rollover whose handoff delivers normally.
    adapter.enqueue(toolCallResponse('call-hfix-nc', 'context_rollover', { handoff: 'the reconstructed handoff text' }))
    adapter.enqueue(textResponse('continuing.'))
    const live = ctx.agents.get(firstSessionId)!
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId ? current : undefined
    })
    const next = await waitFor(() => ctx.agents.get(renewed.member.sessionId)!)
    await waitFor(() => next.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    await next.whenIdle()
    expect(archivedHandoffs(next)).toHaveLength(1)

    // Host restart on the same ledger and Session store: the delivered
    // handoff is durable in the new Session's own log, and the restart must
    // not reconstruct a second one on top of it. This is also the race the
    // write-behind retire drain runs against — the persisted decision goes
    // through inspection (which awaits the drain), never a bare listing.
    await ctx.agentTeam.suspendMember({ requestId: requestId('hfix-suspend'), memberId })
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    await ctx.agentTeam.resumeMember({ requestId: requestId('hfix-resume'), memberId })
    const resumedStatus = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    const resumed = await waitFor(() => ctx.agents.get(resumedStatus.member.sessionId)!)
    await resumed.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(resumed.session.id).toBe(renewed.member.sessionId)
    expect(archivedHandoffs(resumed)).toHaveLength(1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('reconstructs the handoff when a restart lands between the rollover commit and its delivery', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, presets, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('hgap-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('hgap-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Crash the rollover between its durable ledger commit and the handoff
    // delivery: the new Session's activation fails (preset mount throws), so
    // the binding is committed, the old generation is retired, and the
    // handoff never lands in any log. The ledger's previous-Session record
    // is the only remaining lineage fact.
    presets.failingMount = true
    adapter.enqueue(toolCallResponse('call-hgap-nc', 'context_rollover', { handoff: 'the handoff that never delivered' }))
    adapter.enqueue(textResponse('rolling over into the crash.'))
    const live = ctx.agents.get(firstSessionId)!
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over now' }], source: { kind: 'user' } }))
    const committed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId
        && current.availability === 'unavailable'
        && current.diagnostic?.class === 'preset-composition' ? current : undefined
    })
    expect(committed.member.sessionId).not.toBe(firstSessionId)
    expect(ctx.agents.get(committed.member.sessionId)).toBeUndefined()
    expect(ctx.agents.get(firstSessionId)).toBeUndefined()

    // Host restart on the same ledger: activation of the never-materialized
    // Session goes through the create path with the ledger lineage, and the
    // missing handoff is reconstructed from the previous Session's durable
    // pending intent — delivered exactly once, before anything else.
    presets.failingMount = false
    adapter.enqueue(textResponse('picked up from the reconstructed handoff.'))
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    const restarted = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    const resumed = await waitFor(() => ctx.agents.get(restarted.member.sessionId)!)
    await resumed.whenIdle()
    await waitFor(() => archivedHandoffs(resumed).length > 0 ? true : undefined)
    await resumed.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(archivedHandoffs(resumed)).toHaveLength(1)
    const handoff = archivedHandoffs(resumed)[0] as { data: { content: Array<{ type: string; text: string }> } }
    expect(handoff.data.content[0]?.text).toContain('the handoff that never delivered')
    // The reconstructed Session carries its lineage for future restarts.
    expect(resumed.session.header.parentSession).toBe(firstSessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('reconstructs a recorded checkpoint seed when a crash lands between the rollover commit and the new Session', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, presets, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('seedcut-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('seedcut-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Record the anchor, then make noise past it.
    adapter.enqueue(toolCallResponse('call-seedcut-cp', 'context_checkpoint', { name: 'stable anchor' }))
    adapter.enqueue(textResponse('anchored.'))
    const live = ctx.agents.get(firstSessionId)!
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'record the anchor' }], source: { kind: 'user' } }))
    await waitFor(() => foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id }).checkpoints.some(entry => entry.turnEndSeq !== -1) ? true : undefined)
    await live.whenIdle()
    const anchorTurnEndSeq = foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id }).checkpoints[0]!.turnEndSeq

    adapter.enqueue(textResponse('noise past the anchor.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'make some noise' }], source: { kind: 'user' } }))
    await waitFor(() => live.session.ownEvents().filter(event => event.type === 'assistant/message').length >= 2 ? true : undefined)
    await live.whenIdle()

    // Checkpoint return whose activation crashes after the ledger commit:
    // the recorded seed envelope (source Session, exclusive prefix length,
    // checkpoint ref) is the only surviving seed fact.
    presets.failingMount = true
    adapter.enqueue(toolCallResponse('call-seedcut-nc', 'context_rollover', { handoff: 'resume from the anchor', checkpointRef: checkpointRefFor(firstSessionId, 'call-seedcut-cp') }))
    adapter.enqueue(textResponse('returning to the anchor.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'return to the anchor' }], source: { kind: 'user' } }))
    await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId
        && current.availability === 'unavailable'
        && current.diagnostic?.class === 'preset-composition' ? current : undefined
    })

    // Host restart: the never-materialized Session is recreated from the
    // ledger's recorded seed — never a blank child.
    presets.failingMount = false
    adapter.enqueue(textResponse('resumed from the recorded seed.'))
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    const restarted = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    const resumed = await waitFor(() => ctx.agents.get(restarted.member.sessionId)!)
    await waitFor(() => archivedHandoffs(resumed).length > 0 ? true : undefined)
    await resumed.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 100))

    // Seeded child, not blank: the lineage parent is the seed source (the
    // same Session here) and the inherited prefix is exactly the recorded
    // exclusive cut through the anchor's turn end.
    expect(resumed.session.header.parentSession).toBe(firstSessionId)
    expect(resumed.session.header.isSeeded).toBe(true)
    expect(resumed.session.inheritedEventCount).toBe(anchorTurnEndSeq + 1)
    const inherited = resumed.session.snapshotEvents(0 as never, resumed.session.inheritedEventCount)
    expect(inherited.at(-1)!.seq).toBe(anchorTurnEndSeq)
    expect(inherited.length).toBeGreaterThan(0)
    // The handoff is reconstructed exactly once on top of the seed.
    expect(archivedHandoffs(resumed)).toHaveLength(1)
    const handoff = archivedHandoffs(resumed)[0] as { data: { content: Array<{ type: string; text: string }> } }
    expect(handoff.data.content[0]?.text).toContain('resume from the anchor')
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('redelivers the old generation\'s carried input after a crash between the rollover commit and the new Session', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, presets, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('carry-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('carry-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Crash the rollover after its commit; the racing direct input lands in
    // the old generation's inbox after the intent (durable splice → carried
    // candidate in the old fold) and must survive the crash.
    presets.failingMount = true
    adapter.enqueue(toolCallResponse('call-carry-nc', 'context_rollover', { handoff: 'the crash handoff' }))
    adapter.enqueue(textResponse('rolling into the crash.'))
    const live = ctx.agents.get(firstSessionId)!
    let injected = false
    const disposeObserver = ctx.on('session/event', (session, event) => {
      if (session.id !== firstSessionId || event.type !== 'turn/end' || injected) return
      injected = true
      queueMicrotask(() => {
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'Direct input that arrived right before the crash.' }], source: { kind: 'user' } }))
      })
    })
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over into the crash' }], source: { kind: 'user' } }))
    const committed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId
        && current.availability === 'unavailable'
        && current.diagnostic?.class === 'preset-composition' ? current : undefined
    })
    disposeObserver()
    expect(injected).toBe(true)
    expect(ctx.agents.get(committed.member.sessionId)).toBeUndefined()

    // Host restart: the recreated generation receives the reconstructed
    // handoff first, then the carried direct input behind it — exactly once,
    // never before the handoff.
    presets.failingMount = false
    adapter.enqueue(textResponse('carrying on after the crash.'))
    adapter.enqueue(textResponse('handled the carried input.'))
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    const restarted = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    const resumed = await waitFor(() => ctx.agents.get(restarted.member.sessionId)!)
    await waitFor(() => {
      const bodies = resumed.session.ownEvents().filter(event => event.type === 'user/message')
        .map(event => JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content))
      return bodies.some(body => body.includes('Direct input that arrived right before the crash')) ? true : undefined
    })
    await resumed.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 100))

    const userEvents = resumed.session.ownEvents().filter(event => event.type === 'user/message')
    const bodies = userEvents.map(event => (event as { data: { content: ReadonlyArray<{ type: string; text?: string }> } }).data.content
      .filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
    const carried = bodies.filter(body => body.includes('Direct input that arrived right before the crash'))
    expect(carried).toHaveLength(1)
    const carriedIndex = bodies.findIndex(body => body.includes('Direct input that arrived right before the crash'))
    const handoffPos = bodies.findIndex(body => body.includes('Context handoff'))
    expect(handoffPos).toBeGreaterThanOrEqual(0)
    expect(carriedIndex).toBeGreaterThan(handoffPos)
    expect(archivedHandoffs(resumed)).toHaveLength(1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('finishes a spent rollover intent at activation when a restart lands after the turn ended but before the swap', async () => {
    // The crash window no other test reaches: the rollover result is durable,
    // the containing turn HAS ended, the lifecycle commit seam refused the
    // swap, and the process died before any retry. Activation then replays the
    // Session, re-derives the spent intent, and must complete the transition
    // itself — commenting the recovery hook out of the activation path leaves
    // every other test in this suite green, so this case is its only guard.
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, jobsState, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('recb-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('recb-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // A job that starts between the durable result and the swap makes the seam
    // refuse the transition, leaving a SPENT pending intent in the projection
    // while the old generation stays bound — the recoverable poison state.
    const disposeObserver = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId || event.type !== 'turn/end') return
      jobsState.jobs = [{ id: 'bash-recb', label: 'racing job', status: 'running', reported: false }]
    })
    adapter.enqueue(toolCallResponse('call-recb-nc', 'context_rollover', { handoff: 'the handoff a restart must finish' }))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over while a job races the seam' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, live)
    await new Promise(resolve => setTimeout(resolve, 100))
    disposeObserver()

    const poisoned = foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id, inheritedEventCount: live.session.inheritedEventCount })
    expect(poisoned.pending).toMatchObject({ toolCallId: 'call-recb-nc', handoff: 'the handoff a restart must finish' })
    expect(poisoned.pending?.turnEndSeq).not.toBe(-1)
    expect(ctx.agentTeam.members().find(status => status.member.memberId === memberId)!.member.sessionId).toBe(sessionId)

    // Host restart over the same ledger and Session store, with the job
    // settled: activation alone must finish the interrupted transition.
    jobsState.jobs = []
    adapter.enqueue(textResponse('continuing after the recovered swap.'))
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)

    const renewed = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.member.sessionId !== sessionId ? status : undefined
    })
    const next = await waitFor(() => ctx.agents.get(renewed.member.sessionId)!)
    await waitFor(() => next.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    await next.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 100))

    // The recovered swap delivers the ORIGINAL intent's handoff exactly once.
    const delivered = next.session.ownEvents().flatMap(event => event.type === 'user/message' && isHandoffMessage(event.data) ? [handoffOf(event.data)] : [])
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.previousSessionId).toBe(sessionId)
    expect(delivered[0]?.newSessionId).toBe(renewed.member.sessionId)
    expect(delivered[0]?.sections.find(section => section.name === 'HANDOFF')?.text).toBe('the handoff a restart must finish')
    expect(archivedHandoffs(next)).toHaveLength(1)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('skips the carried-input replay once the current generation already ran, even when the previous Session log is corrupt', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, presets, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('p1-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('p1-add'), workspaceId, handle: 'p1member', description: 'P1 replay skip', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const previousSessionId = added.status.member.sessionId

    // Crash the rollover after its commit with racing direct input in the old
    // generation's inbox (durable splice -> carried candidate).
    presets.failingMount = true
    adapter.enqueue(toolCallResponse('call-p1-nc', 'context_rollover', { handoff: 'the P1 crash handoff' }))
    adapter.enqueue(textResponse('rolling into the P1 crash.'))
    const live = ctx.agents.get(previousSessionId)!
    let injected = false
    const disposeObserver = ctx.on('session/event', (session, event) => {
      if (session.id !== previousSessionId || event.type !== 'turn/end' || injected) return
      injected = true
      queueMicrotask(() => {
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'P1 carried input.' }], source: { kind: 'user' } }))
      })
    })
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over into the P1 crash' }], source: { kind: 'user' } }))
    await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== previousSessionId
        && current.availability === 'unavailable'
        && current.diagnostic?.class === 'preset-composition' ? current : undefined
    })
    disposeObserver()
    expect(injected).toBe(true)
    const currentSessionId = ctx.agentTeam.members().find(status => status.member.memberId === memberId)!.member.sessionId

    // First restart: the current generation heals, runs the handoff turn, and
    // receives the carried input exactly once — it now has own turn activity.
    presets.failingMount = false
    adapter.enqueue(textResponse('carrying on after the P1 crash.'))
    adapter.enqueue(textResponse('handled the P1 carried input.'))
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    const secondFiber = await ctx.plugin(AgentTeam)
    const firstRestart = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    expect(firstRestart.member.sessionId).toBe(currentSessionId)
    const firstRestartAgent = await waitFor(() => ctx.agents.get(currentSessionId)!)
    await waitFor(() => firstRestartAgent.session.ownEvents().some(event => event.type === 'turn/start') ? true : undefined)
    await firstRestartAgent.whenIdle()

    // The retired previous Session now reads as corrupt. The current
    // generation already ran, so activation must skip the previous-Session
    // inspect entirely instead of failing closed on every restart.
    const realOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    let inspectedPrevious = 0
    const info = vi.spyOn(ctx.logger, 'info')
    ctx.sessionPersistence.open = async (id, access, options) => {
      if (id === previousSessionId) {
        inspectedPrevious += 1
        throw new Error('corrupt session log: seq gap in committed region at line 2 (expected 3, got 2)')
      }
      return realOpen(id, access, options)
    }
    // Retire the Session cleanly before the restart, as a Host restart would
    // find it: a raw fiber dispose races the JSONL retirement drain and can
    // recreate the Session blank, which would mask the P1 skip behind the
    // create path.
    await ctx.agentTeam.suspendMember({ requestId: requestId('p1-suspend'), memberId })
    await secondFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    adapter.enqueue(textResponse('p1 resumed after the corrupt previous Session.'))
    await ctx.agentTeam.resumeMember({ requestId: requestId('p1-resume'), memberId })
    const restarted = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    expect(restarted.member.sessionId).toBe(currentSessionId)
    expect(restarted.diagnostic).toBeUndefined()
    expect(inspectedPrevious).toBe(0)
    expect(info.mock.calls.some(args => String(args[0]).includes('skipping carried-input replay'))).toBe(true)
    info.mockRestore()

    // No redelivery: the carried input stays at exactly one occurrence.
    const resumed = await waitFor(() => ctx.agents.get(currentSessionId)!)
    await resumed.whenIdle()
    const bodies = resumed.session.ownEvents().filter(event => event.type === 'user/message')
      .map(event => JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content))
    expect(bodies.filter(body => body.includes('P1 carried input.'))).toHaveLength(1)
  })

  it('fails open with a warning when the previous Session log is corrupt and the new generation never ran', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, presets, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('p2-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('p2-add'), workspaceId, handle: 'p2member', description: 'P2 fail-open', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const previousSessionId = added.status.member.sessionId

    // Crash the rollover after its commit with racing direct input in the old
    // generation's inbox: the new Session never runs before the restart.
    presets.failingMount = true
    adapter.enqueue(toolCallResponse('call-p2-nc', 'context_rollover', { handoff: 'the P2 crash handoff' }))
    adapter.enqueue(textResponse('rolling into the P2 crash.'))
    const live = ctx.agents.get(previousSessionId)!
    let injected = false
    const disposeObserver = ctx.on('session/event', (session, event) => {
      if (session.id !== previousSessionId || event.type !== 'turn/end' || injected) return
      injected = true
      queueMicrotask(() => {
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'P2 carried input that must be skipped.' }], source: { kind: 'user' } }))
      })
    })
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over into the P2 crash' }], source: { kind: 'user' } }))
    await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== previousSessionId
        && current.availability === 'unavailable'
        && current.diagnostic?.class === 'preset-composition' ? current : undefined
    })
    disposeObserver()
    expect(injected).toBe(true)

    // The retired previous Session is corrupt; the fresh current Session has
    // no own turn activity, so the replay's inspect hits the corruption and
    // must fail open with a warning instead of blocking activation.
    const realOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.sessionPersistence.open = async (id, access, options) => {
      if (id === previousSessionId) throw new Error('corrupt session log: seq gap in committed region at line 2 (expected 3, got 2)')
      return realOpen(id, access, options)
    }
    presets.failingMount = false
    adapter.enqueue(textResponse('carrying on after the P2 crash.'))
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    const restarted = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    expect(restarted.diagnostic).toBeUndefined()
    const resumed = await waitFor(() => ctx.agents.get(restarted.member.sessionId)!)
    const replayWarnings = warn.mock.calls.map(args => String(args[0])).filter(text => text.includes('skipping the replay'))
    expect(replayWarnings.length).toBeGreaterThan(0)
    expect(replayWarnings.some(text => text.includes(previousSessionId) && text.includes('p2member'))).toBe(true)
    // The corrupt Session's carried input is deliberately skipped: the direct
    // input that would have ridden behind the handoff never surfaces.
    await resumed.whenIdle()
    const bodies = resumed.session.ownEvents().filter(event => event.type === 'user/message')
      .map(event => JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content))
    expect(bodies.some(body => body.includes('P2 carried input that must be skipped.'))).toBe(false)
    warn.mockRestore()
  })

  it('fails open with a warning when the previous Session is refused by the session-format migration', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, presets, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('p4-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('p4-add'), workspaceId, handle: 'p4member', description: 'P4 format refusal', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const previousSessionId = added.status.member.sessionId

    // Same crash shape as the corruption case: the rollover committed, the new
    // Session never ran, and direct input was racing in the old generation.
    presets.failingMount = true
    adapter.enqueue(toolCallResponse('call-p4-nc', 'context_rollover', { handoff: 'the P4 refusal handoff' }))
    adapter.enqueue(textResponse('rolling into the P4 crash.'))
    const live = ctx.agents.get(previousSessionId)!
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over into the P4 crash' }], source: { kind: 'user' } }))
    await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== previousSessionId
        && current.availability === 'unavailable'
        && current.diagnostic?.class === 'preset-composition' ? current : undefined
    })

    // The retired Session is refused by the candidate's own migration audit:
    // deterministic, so no retry can ever read it. Activation must fail open
    // with a warning rather than leave the Member permanently unavailable.
    const realOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.sessionPersistence.open = async (id, access, options) => {
      if (id === previousSessionId) throw new SessionFormatUnsupportedError('cannot safely transform unclassified message source; source v0 artifact remains unchanged (test seam)')
      return realOpen(id, access, options)
    }
    presets.failingMount = false
    adapter.enqueue(textResponse('carrying on after the P4 refusal.'))
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    const restarted = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    expect(restarted.diagnostic).toBeUndefined()
    const replayWarnings = warn.mock.calls.map(args => String(args[0])).filter(text => text.includes('refused by the session-format migration'))
    expect(replayWarnings.length).toBeGreaterThan(0)
    expect(replayWarnings.some(text => text.includes(previousSessionId) && text.includes('p4member'))).toBe(true)
    warn.mockRestore()
  })

  it('keeps the carried-input replay fail-closed for a non-corruption unreadable previous Session', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, presets, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('p2f-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('p2f-add'), workspaceId, handle: 'p2fmember', description: 'P2 fail-closed boundary', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const previousSessionId = added.status.member.sessionId

    // Same crash shape as the fail-open case, but the unreadable cause is a
    // missing file (ENOENT), not log corruption: the bounded fail-open must
    // NOT apply, and activation stays blocked with a diagnostic.
    presets.failingMount = true
    adapter.enqueue(toolCallResponse('call-p2f-nc', 'context_rollover', { handoff: 'the fail-closed handoff' }))
    adapter.enqueue(textResponse('rolling into the fail-closed crash.'))
    const live = ctx.agents.get(previousSessionId)!
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over into the fail-closed crash' }], source: { kind: 'user' } }))
    await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== previousSessionId
        && current.availability === 'unavailable'
        && current.diagnostic?.class === 'preset-composition' ? current : undefined
    })

    const realOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.open = async (id, access, options) => {
      if (id === previousSessionId) throw Object.assign(new Error(`ENOENT: no such file or directory, scandir 'sessions/${previousSessionId}' (test seam)`), { code: 'ENOENT' })
      return realOpen(id, access, options)
    }
    presets.failingMount = false
    adapter.enqueue(textResponse('this turn must never run.'))
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    const failed = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.availability === 'unavailable' && status.diagnostic?.class === 'session-unreadable' ? status : undefined
    })
    expect(failed.member.sessionId).not.toBe(previousSessionId)
    expect(ctx.agents.get(failed.member.sessionId)).toBeUndefined()
  })

  it('blocks activation with a session-refused diagnostic when the current binding is refused, and a restart replays the deterministic refusal', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('ref-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('ref-add'), workspaceId, handle: 'refused', description: 'Refused binding', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('heal-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('heal-add'), workspaceId, handle: 'healing', description: 'Heal retry', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('p3-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('p3-add'), workspaceId, handle: 'p3member', description: 'P3 failure visibility', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
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

  it('offers a delivered single-Thread Team boundary as a default checkpoint and rejects multi-Thread boundaries', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, archived } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('tbound-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('tbound-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // Thread A: a direct mention wakes the Member; the delivered notice
    // quotes `Thread: <ref>` — one Thread's facts enter the context.
    const started = await ctx.agentTeam.sendMessage({ requestId: requestId('tbound-a'), workspaceId, channelRef: channel.channel.channelRef, body: 'Builder, thread A work', recipients: [memberId] })
    if (started.kind !== 'committed') throw new Error(`expected committed send, received ${started.kind}`)
    const threadA = started.thread.threadRef
    adapter.enqueue(textResponse('thread A acknowledged.'))
    await waitFor(() => live.session.ownEvents().some(event => event.type === 'user/message'
      && JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content).includes('thread A work')) ? true : undefined)
    await live.whenIdle()

    // The timeline marks the Thread-A delivery boundary as a selectable
    // default checkpoint with exactly that Thread attributed.
    const timelineA = await ctx.agentTeam.contextTimelineForAgent(live, { memberId })
    const boundaryA = timelineA.items.find(item => item.source === 'team-boundary')
    expect(boundaryA).toBeDefined()
    expect(boundaryA!.affectedThreads).toEqual([threadA])
    expect(boundaryA!.restorable).toBe(true)

    // Thread B arrives later: its boundary's RETAINED prefix spans both
    // Threads, so it must not be selectable — the reason says so.
    const second = await ctx.agentTeam.sendMessage({ requestId: requestId('tbound-b'), workspaceId, channelRef: channel.channel.channelRef, body: 'Builder, thread B work', recipients: [memberId] })
    if (second.kind !== 'committed') throw new Error(`expected committed send, received ${second.kind}`)
    const threadB = second.thread.threadRef
    adapter.enqueue(textResponse('thread B acknowledged.'))
    await waitFor(() => live.session.ownEvents().some(event => event.type === 'user/message'
      && JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content).includes('thread B work')) ? true : undefined)
    await live.whenIdle()
    const timelineB = await ctx.agentTeam.contextTimelineForAgent(live, { memberId })
    const boundaries = timelineB.items.filter(item => item.source === 'team-boundary')
    // The newest boundary (thread B delivery) retains both Threads.
    const newest = boundaries.find(item => item.affectedThreads.includes(threadB))
    expect(newest).toBeDefined()
    expect(newest!.restorable).toBe(false)
    expect(newest!.reason).toContain('multiple Threads')
    // The older single-Thread boundary stays restorable with its one Thread.
    const older = boundaries.find(item => item.affectedThreads.length === 1)
    expect(older).toBeDefined()
    expect(older!.restorable).toBe(true)
    expect(older!.checkpointRef).toBe(boundaryA!.checkpointRef)

    // Return through the single-Thread boundary: exact seed prefix, handoff
    // first, and the discarded suffix carries the thread-B noise.
    adapter.enqueue(toolCallResponse('call-tbound-nc', 'context_rollover', { handoff: 'Back to the thread-A anchor.', checkpointRef: boundaryA!.checkpointRef }))
    adapter.enqueue(textResponse('returned to the thread-A boundary.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'return to the thread-A boundary' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== sessionId ? current : undefined
    })
    const next = await waitFor(() => ctx.agents.get(renewed.member.sessionId)!)
    await waitFor(() => next.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    await next.whenIdle()
    // Seeded at the boundary's completed-turn cut, in the same Session.
    expect(next.session.header.parentSession).toBe(sessionId)
    expect(next.session.header.isSeeded).toBe(true)
    expect(next.session.inheritedEventCount).toBeGreaterThan(0)
    const inherited = next.session.snapshotEvents(0 as never, next.session.inheritedEventCount)
    // The retained prefix still contains thread A's delivered facts…
    expect(JSON.stringify(inherited)).toContain('thread A work')
    // …and discards everything after the boundary, including thread B.
    expect(JSON.stringify(inherited)).not.toContain('thread B work')
    expect(archived).toContain(sessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('keeps default-boundary refs distinct across generations with the same event seq', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('xseq-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('xseq-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Generation 1 receives a direct mention; its notice delivery becomes a
    // team boundary at some event seq in generation 1.
    const first = await ctx.agentTeam.sendMessage({ requestId: requestId('xseq-a'), workspaceId, channelRef: channel.channel.channelRef, body: 'Gen1 thread work', recipients: [memberId] })
    if (first.kind !== 'committed') throw new Error(`expected committed send, received ${first.kind}`)
    const live = ctx.agents.get(firstSessionId)!
    adapter.enqueue(textResponse('gen1 acknowledged.'))
    await waitFor(() => live.session.ownEvents().some(event => event.type === 'user/message'
      && JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content).includes('Gen1 thread work')) ? true : undefined)
    await live.whenIdle()

    // Fresh rollover; generation 2 receives its own mention whose notice
    // delivery lands at the SAME event seq (both generations start at 0).
    adapter.enqueue(toolCallResponse('call-xseq-nc', 'context_rollover', { handoff: 'gen2 handoff' }))
    adapter.enqueue(textResponse('gen2 starting.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId ? current : undefined
    })
    const secondSessionId = renewed.member.sessionId
    const next = await waitFor(() => ctx.agents.get(secondSessionId)!)
    await waitFor(() => next.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    await next.whenIdle()

    const second = await ctx.agentTeam.sendMessage({ requestId: requestId('xseq-b'), workspaceId, channelRef: channel.channel.channelRef, body: 'Gen2 thread work', recipients: [memberId] })
    if (second.kind !== 'committed') throw new Error(`expected committed send, received ${second.kind}`)
    adapter.enqueue(textResponse('gen2 acknowledged.'))
    await waitFor(() => next.session.ownEvents().some(event => event.type === 'user/message'
      && JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content).includes('Gen2 thread work')) ? true : undefined)
    await next.whenIdle()

    // The generation-2 timeline walks the archived ancestor: BOTH
    // generations' boundaries appear with distinct refs (no `seen`
    // deduplication swallowing the ancestor), and returning through the
    // ancestor's ref seeds from the ANCESTOR's events, not generation 2's.
    const timeline = await ctx.agentTeam.contextTimelineForAgent(next, { memberId, limit: 24 })
    const boundaries = timeline.items.filter(item => item.source === 'team-boundary')
    expect(boundaries.length).toBeGreaterThanOrEqual(2)
    const refs = boundaries.map(item => item.checkpointRef)
    expect(new Set(refs).size).toBe(refs.length)
    // Each boundary names its own source Session; their refs must differ
    // even when the two deliveries anchor at the same event seq in their
    // own Sessions.
    const gen2Boundary = boundaries.find(item => item.sourceSessionId === secondSessionId)
    const gen1Boundary = boundaries.find(item => item.sourceSessionId === firstSessionId)
    expect(gen1Boundary).toBeDefined()
    expect(gen2Boundary).toBeDefined()
    expect(gen1Boundary!.checkpointRef).not.toBe(gen2Boundary!.checkpointRef)

    // Returning through the ancestor boundary seeds generation 1's prefix:
    // the retained context contains the gen1 delivery and NOT gen2's.
    adapter.enqueue(toolCallResponse('call-xseq-return', 'context_rollover', { handoff: 'Back to the gen1 anchor.', checkpointRef: gen1Boundary!.checkpointRef }))
    adapter.enqueue(textResponse('returned to gen1.'))
    next.followup(createUserMessage({ content: [{ type: 'text', text: 'return to gen1' }], source: { kind: 'user' } }))
    const returned = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== secondSessionId ? current : undefined
    })
    const third = await waitFor(() => ctx.agents.get(returned.member.sessionId)!)
    await waitFor(() => third.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    await third.whenIdle()
    const inherited = third.session.snapshotEvents(0 as never, third.session.inheritedEventCount)
    expect(JSON.stringify(inherited)).toContain('Gen1 thread work')
    expect(JSON.stringify(inherited)).not.toContain('Gen2 thread work')
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('rejects a second consecutive start boundary as multi-Thread — preserved, not a defect', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('twostart-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('twostart-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // A delivered mention seeds Thread A's first-arrival boundary; then the
    // Member starts a second Thread B of its own. Thread B's start boundary
    // retains facts from BOTH Threads, so it must be refused — the
    // multi-Thread rejection is the designed behavior (a return would drop
    // the other Thread's knowledge), never something to "fix".
    const notice = await ctx.agentTeam.sendMessage({ requestId: requestId('twostart-a'), workspaceId, channelRef: channel.channel.channelRef, body: 'Thread A context', recipients: [memberId] })
    if (notice.kind !== 'committed') throw new Error(`expected committed send, received ${notice.kind}`)
    adapter.enqueue(textResponse('thread A context read.'))
    await waitFor(() => live.session.ownEvents().some(event => event.type === 'user/message'
      && JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content).includes('Thread A context')) ? true : undefined)
    await live.whenIdle()

    await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('twostart-read'), workspaceId, threadRef: notice.thread.threadRef })
    adapter.enqueue(toolCallResponse('call-twostart-b', 'team_message', { action: 'start', channelRef: channel.channel.channelRef, body: 'Member starts thread B' }))
    adapter.enqueue(textResponse('started thread B.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'start thread B' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, live)
    await new Promise(resolve => setTimeout(resolve, 50))

    const timeline = await ctx.agentTeam.contextTimelineForAgent(live, { memberId, limit: 24 })
    const boundaries = timeline.items.filter(item => item.source === 'team-boundary')
    // The start of Thread B is labeled by action class.
    const startBoundary = boundaries.find(item => item.name === 'Team message')
    expect(startBoundary).toBeDefined()
    // Its retained prefix spans both Threads' facts, so it is refused.
    expect(startBoundary!.affectedThreads).toContain(notice.thread.threadRef)
    expect(startBoundary!.restorable).toBe(false)
    expect(startBoundary!.reason).toContain('multiple Threads')
    // The first-arrival boundary of Thread A stays single-Thread and restorable.
    const firstArrival = boundaries.find(item => item.affectedThreads.length === 1)
    expect(firstArrival).toBeDefined()
    expect(firstArrival!.restorable).toBe(true)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('attributes a claim-mutation boundary through its Task and rejects the cross-Thread mix', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('mix-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('mix-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const sessionId = added.status.member.sessionId
    const live = ctx.agents.get(sessionId)!

    // Thread A delivers a notice first; then the Member claims a Task on a
    // DIFFERENT Thread B. The claim boundary must attribute BOTH Threads
    // (A's delivered facts + B's claimed Task) and refuse selection — the
    // old notice-text-only attribution would have wrongly seen one Thread.
    const notice = await ctx.agentTeam.sendMessage({ requestId: requestId('mix-a'), workspaceId, channelRef: channel.channel.channelRef, body: 'Thread A context', recipients: [memberId] })
    if (notice.kind !== 'committed') throw new Error(`expected committed send, received ${notice.kind}`)
    adapter.enqueue(textResponse('thread A context read.'))
    await waitFor(() => live.session.ownEvents().some(event => event.type === 'user/message'
      && JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content).includes('Thread A context')) ? true : undefined)
    await live.whenIdle()

    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('mix-b-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Task B on another thread', recipients: [memberId] })
    if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
    const read = await ctx.agentTeam.readThreadForAgent(live, { requestId: requestId('mix-b-read'), workspaceId, taskRef: started.task!.taskRef })
    adapter.enqueue(toolCallResponse('call-mix-claim', 'team_claim', { action: 'claim', taskRef: started.task!.taskRef, baseRevision: read.thread.revision, direction: 'own task B' }))
    adapter.enqueue(textResponse('claimed task B.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'claim task B' }], source: { kind: 'user' } }))
    await live.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 50))

    const timeline = await ctx.agentTeam.contextTimelineForAgent(live, { memberId, limit: 24 })
    const boundaries = timeline.items.filter(item => item.source === 'team-boundary')
    // The claim boundary (newest team boundary) carries both Threads.
    const claimBoundary = boundaries[0]
    expect(claimBoundary).toBeDefined()
    expect(claimBoundary!.affectedThreads).toContain(notice.thread.threadRef)
    expect(claimBoundary!.affectedThreads).toContain(started.thread.threadRef)
    expect(claimBoundary!.restorable).toBe(false)
    expect(claimBoundary!.reason).toContain('multiple Threads')
    // And the boundary is refused as a return target.
    adapter.enqueue(toolCallResponse('call-mix-return', 'context_rollover', { handoff: 'cross-thread attempt', checkpointRef: claimBoundary!.checkpointRef }))
    adapter.enqueue(textResponse('the return was refused.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'try returning' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, live)
    await new Promise(resolve => setTimeout(resolve, 100))
    const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)!
    expect(current.member.sessionId).toBe(sessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('delivers handoff, carried input, then the rederived Inbox in order across a live swap', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('order-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('order-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Unread Team facts exist at rollover time AND racing direct input
    // arrives in the transition window: the new generation must read the
    // handoff first, the carried input second, and the rederived Inbox
    // third — the steer lane may never leapfrog the carried messages.
    const unread = await ctx.agentTeam.sendMessage({ requestId: requestId('order-unread'), workspaceId, channelRef: channel.channel.channelRef, body: 'Unread thread facts before the swap', recipients: [memberId] })
    if (unread.kind !== 'committed') throw new Error(`expected committed send, received ${unread.kind}`)

    // Response budget: the pre-swap Inbox wake, the rollover tool turn, the
    // carried-input turn, and the sequenced Inbox turn each consume one.
    adapter.enqueue(textResponse('reading the unread facts first.'))
    adapter.enqueue(toolCallResponse('call-order-nc', 'context_rollover', { handoff: 'order handoff' }))
    adapter.enqueue(textResponse('carrying the input over.'))
    adapter.enqueue(textResponse('inbox turn after the carried input.'))
    const live = ctx.agents.get(firstSessionId)!
    let injected = false
    const disposeObserver = ctx.on('session/event', (session, event) => {
      if (session.id !== firstSessionId || event.type !== 'turn/end' || injected) return
      // Only the rollover turn counts: the pending intent must already be
      // durable, or the injected input would be consumed by that same turn
      // instead of riding behind the handoff.
      const state = foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id })
      if (state.pending === null) return
      injected = true
      queueMicrotask(() => {
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'Carried direct input in the transition window.' }], source: { kind: 'user' } }))
      })
    })
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over now' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId ? current : undefined
    })
    const next = await waitFor(() => ctx.agents.get(renewed.member.sessionId)!)
    disposeObserver()
    await waitFor(() => {
      const bodies = next.session.ownEvents().filter(event => event.type === 'user/message')
        .map(event => JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content))
      return bodies.some(body => body.includes('Team Inbox has unread work')) ? true : undefined
    })
    await next.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 100))

    const bodies = next.session.ownEvents().filter(event => event.type === 'user/message')
      .map(event => (event as { data: { content: ReadonlyArray<{ type: string; text?: string }> } }).data.content
        .filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
    const handoffIndex = bodies.findIndex(body => body.includes('order handoff'))
    const carriedIndex = bodies.findIndex(body => body.includes('Carried direct input in the transition window'))
    const inboxIndex = bodies.findIndex(body => body.includes('Team Inbox has unread work'))
    expect(handoffIndex).toBeGreaterThanOrEqual(0)
    expect(carriedIndex).toBeGreaterThan(handoffIndex)
    expect(inboxIndex).toBeGreaterThan(carriedIndex)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('does not duplicate carried input that a restart replays from a pending inbox splice, and keeps delivery order', async () => {
    // Call 1 is the pre-crash rollover turn; call 2 is the recovered
    // handoff turn — gated mid-request so the carried input stays observably
    // PENDING (spliced, unclaimed, unsurfaced) while the handoff turn runs.
    const adapter = new GatedAdapter(2)
    const { ctx, workspaceId, presets, teamFiber: initialFiber } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('pendc-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('pendc-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Crash the rollover after its commit with racing direct input in the
    // old generation's inbox (durable splice → carried candidate).
    presets.failingMount = true
    adapter.enqueue(toolCallResponse('call-pendc-nc', 'context_rollover', { handoff: 'the pending-carried handoff' }))
    adapter.enqueue(textResponse('rolling into the crash.'))
    const live = ctx.agents.get(firstSessionId)!
    let injected = false
    const disposeObserver = ctx.on('session/event', (session, event) => {
      if (session.id !== firstSessionId || event.type !== 'turn/end' || injected) return
      const state = foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id })
      if (state.pending === null) return
      injected = true
      queueMicrotask(() => {
        live.followup(createUserMessage({ content: [{ type: 'text', text: 'Pending-splice carried input.' }], source: { kind: 'user' } }))
      })
    })
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over into the crash' }], source: { kind: 'user' } }))
    await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId
        && current.availability === 'unavailable'
        && current.diagnostic?.class === 'preset-composition' ? current : undefined
    })
    disposeObserver()
    expect(injected).toBe(true)
    const newSessionId = ctx.agentTeam.members().find(status => status.member.memberId === memberId)!.member.sessionId

    // First restart: recovery steers the handoff (call 2, gated mid-request)
    // and the carried input rides the follow-up lane behind it. While the
    // handoff model call blocks, the carried input is provably in the
    // PENDING state: queued in the live inbox, claimed by no turn, surfaced
    // as no `user/message` — the exact claim-before-surface seam a crash
    // between the two turns would hit.
    presets.failingMount = false
    await initialFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    const secondFiber = await ctx.plugin(AgentTeam)
    const firstRestart = await waitFor(() => {
      const status = ctx.agentTeam.members().find(entry => entry.member.memberId === memberId)
      return status !== undefined && status.availability === 'active' ? status : undefined
    })
    expect(firstRestart.member.sessionId).toBe(newSessionId)
    await adapter.started.promise
    const firstRestartAgent = (await waitFor(() => ctx.agents.get(newSessionId)!))!
    const pendingCarried = [...firstRestartAgent.inbox.nextStep, ...firstRestartAgent.inbox.nextTurn]
      .filter(message => JSON.stringify(message.content).includes('Pending-splice carried input'))
    const surfacedCarried = firstRestartAgent.session.ownEvents().filter(event => event.type === 'user/message'
      && JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content).includes('Pending-splice carried input'))
    expect(pendingCarried.length).toBeGreaterThanOrEqual(1)
    expect(surfacedCarried).toHaveLength(0)

    // Release the gate: the handoff turn completes, the carried turn claims
    // and surfaces the input exactly once. A crash HERE would replay the
    // splice; a later restart must never duplicate the delivered message.
    adapter.release.resolve()
    await waitFor(() => {
      const surfaced = firstRestartAgent.session.ownEvents().filter(event => event.type === 'user/message')
        .map(event => JSON.stringify((event as { data: { content: readonly unknown[] } }).data.content))
      return surfaced.some(body => body.includes('Pending-splice carried input')) ? true : undefined
    })
    await firstRestartAgent.whenIdle()

    // Second Host restart after the carried input landed: delivered-id
    // dedupe keeps it at exactly one, and the order stays stable.
    await ctx.agentTeam.suspendMember({ requestId: requestId('pendc-suspend'), memberId })
    await secondFiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    await ctx.plugin(AgentTeam)
    adapter.enqueue(textResponse('carried input handled.'))
    await ctx.agentTeam.resumeMember({ requestId: requestId('pendc-resume'), memberId })
    const resumed = await waitFor(() => {
      const agent = ctx.agents.get(newSessionId)
      return agent !== undefined && agent.status === 'idle' ? agent : undefined
    })
    await resumed.whenIdle()
    await new Promise(resolve => setTimeout(resolve, 100))

    const bodies = resumed.session.ownEvents().filter(event => event.type === 'user/message')
      .map(event => (event as { data: { content: ReadonlyArray<{ type: string; text?: string }> } }).data.content
        .filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
    const carried = bodies.filter(body => body.includes('Pending-splice carried input'))
    expect(carried).toHaveLength(1)
    const handoffPos = bodies.findIndex(body => body.includes('the pending-carried handoff'))
    const carriedPos = bodies.findIndex(body => body.includes('Pending-splice carried input'))
    expect(handoffPos).toBeGreaterThanOrEqual(0)
    expect(carriedPos).toBeGreaterThan(handoffPos)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('rejects returning a small current child to an ancestor seed priced above the handoff budget', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('biga-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('biga-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Generation 1's only work turn records an anchor while "large": the
    // meter reads far above the handoff budget for GENERATION 1's own
    // replayed measurement. The current generation stays small (5K) so only
    // the source-replayed pricing can catch the oversized ancestor seed —
    // the old current-usage pricing would have estimated a few thousand
    // tokens and waved the return through.
    pressureState.usageTokens = 5_000
    adapter.enqueue(toolCallResponse('call-biga-cp', 'context_checkpoint', { name: 'big anchor' }))
    adapter.enqueue(textResponse('big anchor recorded.'))
    const live = ctx.agents.get(firstSessionId)!
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'record the big anchor' }], source: { kind: 'user' } }))
    await waitFor(() => foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id }).checkpoints.some(entry => entry.turnEndSeq !== -1) ? true : undefined)
    await live.whenIdle()

    // Fresh rollover into a small generation 2: the current child is cheap,
    // but the ANCESTOR's anchor retains the ancestor's real size.
    adapter.enqueue(toolCallResponse('call-biga-nc', 'context_rollover', { handoff: 'small fresh generation' }))
    adapter.enqueue(textResponse('small generation running.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over fresh' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId ? current : undefined
    })
    const next = await waitFor(() => ctx.agents.get(renewed.member.sessionId)!)
    await waitFor(() => next.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    await next.whenIdle()
    // The ancestor grew large by the time it is REPLAYED — no live
    // generation sees the big number; only the source-replayed pricing
    // (timeline and return guard) reads it.
    pressureState.bySession.set(firstSessionId, 500_000)

    // The timeline prices the ancestor anchor against the ANCESTOR's own
    // measurement (replayed through the meter): the retained estimate stays
    // above the handoff budget even though the current generation is tiny.
    const timeline = await ctx.agentTeam.contextTimelineForAgent(next, { memberId })
    const anchor = timeline.items.find(item => item.checkpointRef === checkpointRefFor(firstSessionId, 'call-biga-cp'))
    expect(anchor).toBeDefined()
    expect(anchor!.restorable).toBe(false)
    expect(anchor!.reason).toContain('handoff budget')
    // And the return is refused: a small child must not adopt an
    // over-budget ancestor seed.
    adapter.enqueue(toolCallResponse('call-biga-return', 'context_rollover', { handoff: 'attempt the big return', checkpointRef: anchor!.checkpointRef }))
    adapter.enqueue(textResponse('the big return was refused.'))
    next.followup(createUserMessage({ content: [{ type: 'text', text: 'try returning to the big anchor' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, next)
    await new Promise(resolve => setTimeout(resolve, 100))
    const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)!
    expect(current.member.sessionId).toBe(renewed.member.sessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('fails closed when the ancestor seed source cannot be measured', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId, pressureState } = await realHarness(adapter)
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('unmeas-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('unmeas-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const memberId = added.status.member.memberId
    const firstSessionId = added.status.member.sessionId

    // Generation 1 records an anchor; a fresh rollover follows.
    adapter.enqueue(toolCallResponse('call-unmeas-cp', 'context_checkpoint', { name: 'ancestor anchor' }))
    adapter.enqueue(textResponse('anchor recorded.'))
    const live = ctx.agents.get(firstSessionId)!
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'record the anchor' }], source: { kind: 'user' } }))
    await waitFor(() => foldTeamContextProjection(live.session.ownEvents(), { sessionId: live.session.id }).checkpoints.some(entry => entry.turnEndSeq !== -1) ? true : undefined)
    await live.whenIdle()

    adapter.enqueue(toolCallResponse('call-unmeas-nc', 'context_rollover', { handoff: 'fresh generation' }))
    adapter.enqueue(textResponse('fresh generation running.'))
    live.followup(createUserMessage({ content: [{ type: 'text', text: 'roll over fresh' }], source: { kind: 'user' } }))
    const renewed = await waitFor(() => {
      const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)
      return current !== undefined && current.member.sessionId !== firstSessionId ? current : undefined
    })
    const next = await waitFor(() => ctx.agents.get(renewed.member.sessionId)!)
    await waitFor(() => next.session.ownEvents().some(event => event.type === 'user/message') ? true : undefined)
    await next.whenIdle()

    // The ancestor's measurement now fails (the meter throws for it): the
    // ancestor anchor must become non-restorable with an explicit reason —
    // never priced as zero — and the return must be refused outright.
    pressureState.failFor.add(firstSessionId)
    const timeline = await ctx.agentTeam.contextTimelineForAgent(next, { memberId })
    const anchor = timeline.items.find(item => item.checkpointRef === checkpointRefFor(firstSessionId, 'call-unmeas-cp'))
    expect(anchor).toBeDefined()
    expect(anchor!.restorable).toBe(false)
    expect(anchor!.reason).toContain('cannot be measured')

    adapter.enqueue(toolCallResponse('call-unmeas-return', 'context_rollover', { handoff: 'attempt the unmeasurable return', checkpointRef: anchor!.checkpointRef }))
    adapter.enqueue(textResponse('the unmeasurable return was refused.'))
    next.followup(createUserMessage({ content: [{ type: 'text', text: 'try returning to the unmeasurable anchor' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, next)
    await new Promise(resolve => setTimeout(resolve, 100))
    const current = ctx.agentTeam.members().find(status => status.member.memberId === memberId)!
    expect(current.member.sessionId).toBe(renewed.member.sessionId)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  /** Count handoff-sourced user messages in one agent's own log. */
  function archivedHandoffs(agent: ReturnType<Context['agents']['get']>): readonly unknown[] {
    return agent!.session.ownEvents().filter(event => event.type === 'user/message'
      && isHandoffMessage(event.data))
  }
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
    await ctx.agentTeam.createChannel({ requestId: requestId('san-channel'), workspaceId, name: 'engineering', description: 'Engineering work' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('san-add'), workspaceId, handle: 'builder', description: 'Builds the implementation', presetId: 'team-member', channelRefs: [] })
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
    // The twin is NOT the ledger legacy directory: it is a directory the
    // Member's own tool call created under the identity-ref spelling after
    // the sanitized root already existed (the live Vera incident: 6 days of
    // colon-form habit, the fix-migration renamed the old root, then a fresh
    // colon write created a new twin beside it). No ledger path names it, so
    // only activation-time twin detection can find it.
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
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('presence-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [] })
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
    // projection cursors alone: channel creation must refresh the sidebar
    // catalog, never the presence rows.
    const committedWaiter = nextChange(ctx.agentTeam, { kind: 'presence', workspaceId })
    const committedWorkspaceWaiter = nextChange(ctx.agentTeam, { kind: 'workspace', workspaceId })
    await ctx.agentTeam.createChannel({ requestId: requestId('presence-channel'), workspaceId, name: 'presence-check', description: 'Presence work' })
    expect(await committedWorkspaceWaiter).toMatchObject({ version: expect.any(Number) })
    expect(await staysPending(committedWaiter)).toBe(true)
  })

  it('reports Agent runtime failures through the presence scope only', async () => {
    const { ctx, workspaceId } = await realHarness(new EmptyAdapter())
    const builder = await ctx.agentTeam.addMember({ requestId: requestId('presence-error-builder'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [] })
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
    const channel = await ctx.agentTeam.createChannel({ requestId: requestId('domain-channel'), workspaceId, name: 'engineering', description: 'Version domains' })
    const added = await ctx.agentTeam.addMember({ requestId: requestId('domain-add'), workspaceId, handle: 'builder', description: 'Reads work', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const live = ctx.agents.get(added.status.member.sessionId)!
    const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('domain-task'), workspaceId, channelRef: channel.channel.channelRef, body: 'Unread work', recipients: [added.status.member.memberId] })
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
    const added = await ctx.agentTeam.addMember({ requestId: requestId('domain-presence-add'), workspaceId, handle: 'builder', description: 'Builds changes', presetId: 'team-member', channelRefs: [] })
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
