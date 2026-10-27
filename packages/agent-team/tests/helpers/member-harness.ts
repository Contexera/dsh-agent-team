/**
 * The real Host harness the Member lifecycle specs share.
 *
 * These specs boot the actual plugin stack — a real Cordis Context, the real
 * agent loop, a real preset registry, a real Session store — over a throwaway
 * tree, because everything they assert is a consequence of that composition
 * rather than of one service in isolation. The harness here is the one copy of
 * that arrangement; a spec chooses its adapter and its persistence backend and
 * describes behavior.
 *
 * `cleanups` is intentionally NOT owned here: vitest lifecycle hooks are
 * per-file, so each spec registers its own `afterEach` and drains its own
 * disposals through the array this module exposes.
 */

/** Per-file teardown list: a spec drains this in its own `afterEach`. */
export const cleanups: Array<() => Promise<void>> = []

export const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, basename, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { vi } from 'vitest'

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
import { AgentTeamLedger } from '../../src/ledger.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID, teamPresetScopeMismatchMessage } from '../../src/index.ts'
import { AGENT_TEAM_PLUGIN_ID } from '../../src/context-source.ts'
import { isAcceptanceNotice } from '../../src/context-projection.ts'
import { ACCEPTANCE_COMPACT_TOKENS } from '../../src/acceptance-context.ts'
import { MEMBER_COMPACT_TOKENS } from '../../src/member-compaction.ts'
import { RECOVERY_DELAY_MS } from '../../src/recovery.ts'
import type { AgentTeamProjectRef, AgentTeamClaimRef, AgentTeamMemberId, AgentTeamRequestId } from '../../src/types.ts'
import { MemoryStorageBackend } from './memory-backend.ts'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'

/** The ENOENT shape the JSONL backend raises when a walk hits a win32 staging directory mid-rename. */
export const persistenceRaceError = (): Error =>
  Object.assign(new Error("scandir ENOENT: transient win32 staging directory raced the walk (test seam)"), { code: 'ENOENT' })



export class EmptyAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 320_000 } }) }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield* [] }
}

export class ScriptedAdapter extends EmptyAdapter {
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

export class GatedAdapter extends ScriptedAdapter {
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

export function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
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

export function textResponse(text: string): StreamChunk[] {
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
export function waitForArchive(ctx: Context, sessionId: SessionId): Promise<void> {
  return vi.waitFor(() => {
    if (!ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)) throw new Error(`Session '${sessionId}' is not archived yet`)
  }, { timeout: 20_000 })
}

export function waitForIdle(ctx: Context, agent: NonNullable<ReturnType<Context['agents']['get']>>): Promise<void> {
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
export function acceptanceReminders(agent: NonNullable<ReturnType<Context['agents']['get']>>): string[] {
  return agent.session.ownEvents().flatMap(event => event.type === 'user/message' && isAcceptanceNotice(event.data)
    ? [event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
    : [])
}

export type PersistenceBackend = 'jsonl'

export class TestablePresets extends AgentPresetRegistry {
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

export async function realHarness(
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
    ? `export { default } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dirname, '../../src/member-compaction-engine.ts')).href)}`
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

export async function waitFor<T>(probe: () => T | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before the deadline')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
