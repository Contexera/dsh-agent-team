import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
// Every test here boots a whole Host harness over a throwaway tree. The windows
// lane stretched that boot to 4.1s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21) and on 2026-09-21 a run crossed it, painting master red
// while the same commit passed on a rerun. Headroom, not a retry.
// Shared boot now runs inside `beforeAll`, whose default 10s hook budget is
// smaller than the 30s each per-test boot used to get — carry the same
// headroom to the hook or the slowest lane times out before any test runs.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime, { ToolCallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam, { AGENT_TEAM_TOOL_NAMES } from '../src/index.ts'
import type { AgentTeamMemberCapabilities, AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'
// @ts-expect-error untyped shared resolution module
import { harnessDir } from '../../../scripts/harness-dir.mjs'
import { MemoryStorageBackend } from './helpers/memory-backend.ts'

const sharedCleanups: Array<() => Promise<void>> = []
/** Per-test disposers (LLM adapter registrations, ordinary sessions): drained after each test. */
let testCleanups: Array<() => Promise<void> | void> = []
const originalDshHome = process.env.DSH_HOME
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(testCleanups.splice(0).map(cleanup => cleanup()))
})

afterAll(async () => {
  await Promise.all(sharedCleanups.splice(0).map(cleanup => cleanup()))
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

class EmptyAdapter extends LlmAdapter {
  // The pressure policy resolves the current route's context capacity through
  // the LLM service; the mock route reports a large window so the zero-usage
  // meter stays the only pressure input.
  override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 320_000 } }) }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { yield* [] }
}

class ScriptedAdapter extends EmptyAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly responses: StreamChunk[][] = []

  enqueue(response: StreamChunk[]): void {
    this.responses.push(response)
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('ScriptedAdapter response queue is empty')
    for (const chunk of response) yield chunk
  }
}

/** Holds the first turn open until the test releases it. */
class GatedAdapter extends ScriptedAdapter {
  private gate = Promise.withResolvers<void>()
  private first = true

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!this.first) {
      yield* super.stream(options)
      return
    }
    this.first = false
    this.requests.push(options)
    await this.gate.promise
    for (const chunk of toolCallResponse('gated-call', 'ordinary_tool', {})) yield chunk
  }

  release(): void {
    this.gate.resolve()
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

function toolNames(ctx: Context, agent: Agent): readonly string[] {
  return ctx.tools.schemas(agent as never).map(schema => schema.name).sort()
}

async function catalogNames(ctx: Context, agent: Agent): Promise<readonly string[]> {
  const skills = await ctx.skills.list({ scope: agent as never })
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

function waitForRunning(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'running') return
      dispose()
      resolve()
    })
  })
}

/**
 * File-shared harness: booted once in `beforeAll`, torn down once in
 * `afterAll`. Previously every test paid the full boot (temp tree, preset
 * file, a dozen plugin installs with disk reads through the loader) and the
 * windows lane stretched one boot to 4.1s+ — 7 boots per file meant 7 chances
 * to hit a slow tail. The ledger is append-only, so tests stay isolated
 * through unique handles/requestIds (see the invariant below); the LLM
 * adapter is the one per-test registration because `registerAdapter` throws
 * on duplicate routes — each test registers its own and `afterEach`
 * disposes it.
 */
async function buildSharedHarness(): Promise<{
  readonly ctx: Context
  readonly workspaceId: WorkspaceId
  readonly teamFiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-agent-team-policy-'))
  const project = join(root, 'project')
  const persistence = join(root, 'sessions')
  await Promise.all([mkdir(project), mkdir(persistence)])
  process.env.DSH_HOME = join(root, 'dsh-home')
  // The team-member definition as one declarative row; the
  // distinguishable-tool fixture is a real module beside this spec, where its
  // own imports resolve.
  const teamMemberPlugins = [
    { id: 'member-context', name: '@contexera/dsh-agent-team/member-context' },
    { id: 'team-tools', name: pathToFileURL(join(import.meta.dirname, 'helpers', 'team-tools-fixture.mjs')).href },
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
  await ctx.plugin(SessionStore)
  // The registry injects 'sessionProjections'; the roster stays PENDING without it.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  // The Team pressure policy reads the token meter at every Member pre-step;
  // these tests exercise tool policy, so a zero-usage fake keeps it quiet.
  ctx.provide('tokenMeter', { measure: () => ({ totalTokens: 0 }) })
  await ctx.plugin(JsonlSessionPersistence, { root: persistence })
  await ctx.plugin(AgentPresetRegistry, { default: 'team-member' })
  await ctx.plugin(AgentPreset, { id: 'team-member', plugins: teamMemberPlugins })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const workspaceId = WorkspaceId('workspace:policy-test')
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === workspaceId ? { id, path: project, attachSession: async () => {} } : undefined,
    list: () => [],
    archiveSession: async () => {},
  })
  const teamFiber = await ctx.plugin(AgentTeam)
  sharedCleanups.push(async () => { await ctx.fiber.dispose(); await facility.closeAll(); await rm(root, { recursive: true, force: true }) })
  return { ctx, workspaceId, teamFiber }
}

// Isolation invariant: the shared ledger never forgets, so every handle and
// every requestId in this file must be unique per test (suffixed t1..t7) — a
// reused `add-<handle>` requestId would idempotently return another test's
// Member, and a reused handle would fail availability. Grep `t[1-7]-` to audit.
let shared: Awaited<ReturnType<typeof buildSharedHarness>>

beforeAll(async () => {
  shared = await buildSharedHarness()
})

/** Register one adapter for this test only; disposed in `afterEach`. */
function useAdapter(adapter: LlmAdapter): void {
  const dispose = shared.ctx.llm.registerAdapter(['mock'], adapter)
  testCleanups.push(() => { dispose() })
}

interface MemberFacts {
  readonly memberId: AgentTeamMemberId
  readonly sessionId: SessionId
  readonly privateMemoryPath: string
}

async function addMember(ctx: Context, workspaceId: WorkspaceId, handle: string, capabilities?: AgentTeamMemberCapabilities): Promise<MemberFacts> {
  const added = await ctx.agentTeam.addMember({
    requestId: requestId(`add-${handle}`), workspaceId, handle, description: 'Policy member',
    presetId: 'team-member', channelRefs: [], ...(capabilities === undefined ? {} : { capabilities }),
  })
  expect(added.status.availability).toBe('active')
  return { memberId: added.status.member.memberId, sessionId: added.status.member.sessionId, privateMemoryPath: added.status.member.privateMemoryPath }
}

function liveAgent(ctx: Context, facts: MemberFacts): Agent {
  const agent = ctx.agents.get(facts.sessionId)
  expect(agent).toBeDefined()
  return agent!
}

describe('Agent Team member tool policy', () => {
  it('restricts each Member to its own allow-list without affecting siblings', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    // Baseline: an unrestricted Member sees the five Team tools and both fixtures.
    const base = await addMember(ctx, workspaceId, 't1-baseline')
    const baseAgent = liveAgent(ctx, base)
    expect(toolNames(ctx, baseAgent)).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())

    const narrow = await addMember(ctx, workspaceId, 't1-narrow', { tools: { allow: ['ordinary_tool'] } })
    const narrowAgent = liveAgent(ctx, narrow)
    // The five Team tools are force-unioned; spare_tool disappears.
    expect(toolNames(ctx, narrowAgent)).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool'].sort())
    // The sibling surface is unchanged by the restriction, and the hidden
    // tool resolves as absent rather than callable.
    expect(toolNames(ctx, baseAgent)).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())
    expect(ctx.tools.get('spare_tool', narrowAgent as never)).toBeUndefined()
    const status = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === narrow.memberId)
    expect(status?.capabilityWarnings).toBeUndefined()
  })

  it('drops unknown allow-list names at activation with a diagnostic warning digest', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    // 'tool-renamed-away' simulates a Harness upgrade rename: committed as
    // pure intent, dropped at activation, never fatal.
    const drifted = await addMember(ctx, workspaceId, 't2-drifted', { tools: { allow: ['tool-renamed-away', 'ordinary_tool'] } })
    const driftedAgent = liveAgent(ctx, drifted)
    expect(toolNames(ctx, driftedAgent)).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool'].sort())
    const status = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === drifted.memberId)
    expect(status?.availability).toBe('active')
    expect(status?.capabilityWarnings).toEqual([
      expect.objectContaining({
        name: 'tool-renamed-away',
        knownNames: expect.arrayContaining([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool', 'spare_tool']),
      }),
    ])
    // A clean re-edit clears the warnings together with the override.
    const edited = await ctx.agentTeam.updateMember({ requestId: requestId('clear-drift'), memberId: drifted.memberId, handle: 't2-drifted', description: 'Cleaned up' })
    expect(edited.status.member.capabilities).toBeUndefined()
    expect(edited.status.capabilityWarnings).toBeUndefined()
  })

  it('restores the same restricted surface across suspend, resume, and Host restart', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId, teamFiber } = shared
    const other = await addMember(ctx, workspaceId, 't3-other')
    const narrow = await addMember(ctx, workspaceId, 't3-narrow', { tools: { allow: ['ordinary_tool'] } })

    const suspended = await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId: narrow.memberId })
    expect(suspended.status.availability, JSON.stringify(suspended.status)).toBe('suspended')
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume'), memberId: narrow.memberId })
    // Carry the full status (diagnostic included) into the failure text: a
    // lifecycle race here is otherwise invisible in CI logs.
    expect(resumed.status.availability, JSON.stringify(resumed.status)).toBe('active')
    // Reactivation re-applied the stored intent: the roster says so from the
    // same real surface the schema read below verifies.
    expect(resumed.status.capabilityState).toBe('applied')
    expect(toolNames(ctx, liveAgent(ctx, narrow))).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool'].sort())
    // The sibling never moved.
    expect(toolNames(ctx, liveAgent(ctx, other))).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())

    // Host restart: disposal releases restriction state; replay plus
    // reactivation rebuild the same restricted surface from durable intent.
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    const restored = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === narrow.memberId)
    expect(restored?.availability, JSON.stringify(restored)).toBe('active')
    expect(restored?.capabilityState).toBe('applied')
    expect(toolNames(ctx, liveAgent(ctx, narrow))).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool'].sort())
  })

  it('live-applies an allow-list edit at the turn boundary in the same Session', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const narrow = await addMember(ctx, workspaceId, 't4-narrow', { tools: { allow: ['ordinary_tool'] } })
    const agent = liveAgent(ctx, narrow)

    // While the Member is idle, the edit applies immediately: same Session,
    // the next request schemas recomputed from the new restriction.
    const widened = await ctx.agentTeam.updateMember({
      requestId: requestId('widen'), memberId: narrow.memberId, handle: 't4-narrow', description: 'Policy member',
      capabilities: { tools: { allow: ['ordinary_tool', 'spare_tool'] } },
    })
    expect(widened.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool', 'spare_tool'] } })
    expect(widened.status.member.sessionId).toBe(narrow.sessionId)
    expect(toolNames(ctx, agent)).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())

    // The next model turn sees the widened surface in its request tools and
    // can call the newly visible tool.
    adapter.enqueue(toolCallResponse('call-1', 'spare_tool', {}))
    adapter.enqueue([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'done' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the spare tool' }], source: { kind: 'user' } }))
    await idle
    const lastRequest = adapter.requests.at(-1)
    expect(lastRequest?.tools?.map(tool => tool.name)).toContain('spare_tool')
  })

  it('waits for a running turn, then applies the swap in the same Session while later lifecycle operations queue behind it', async () => {
    const adapter = new GatedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const narrow = await addMember(ctx, workspaceId, 't5-narrow', { tools: { allow: ['ordinary_tool'] } })
    const agent = liveAgent(ctx, narrow)

    // Open a held turn so the edit lands while the agent is running.
    const turnDone = waitForIdle(ctx, agent)
    const running = waitForRunning(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await running

    const edit = ctx.agentTeam.updateMember({
      requestId: requestId('narrow-wait'), memberId: narrow.memberId, handle: 't5-narrow', description: 'Policy member',
      capabilities: { tools: { allow: ['ordinary_tool', 'spare_tool'] } },
    })
    // The edit is parked behind the running turn: it cannot resolve while the
    // agent is still working, and lifecycle operations queue behind the edit.
    const suspending = ctx.agentTeam.suspendMember({ requestId: requestId('suspend-after-edit'), memberId: narrow.memberId })
    const raced = await Promise.race([edit.then(() => 'settled'), new Promise<string>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(raced).toBe('pending')

    // Release the turn: the boundary applies the swap in the same Session,
    // then the queued suspend runs after it.
    adapter.release()
    const settled = await edit
    expect(settled.status.availability).toBe('active')
    expect(settled.status.member.sessionId).toBe(narrow.sessionId)
    expect(settled.status.member.capabilities).toEqual({ tools: { allow: ['ordinary_tool', 'spare_tool'] } })
    expect(toolNames(ctx, agent)).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())
    const suspended = await suspending
    expect(suspended.status.availability).toBe('suspended')
    await turnDone

    // Resume applies the stored intent at the next activation.
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume-after-wait'), memberId: narrow.memberId })
    expect(resumed.status.availability).toBe('active')
    expect(toolNames(ctx, liveAgent(ctx, narrow))).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())
  })

  it('keeps Team tools hidden from ordinary sessions outside the preset', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx } = shared
    const ordinary = await ctx.agents.create({ sessionId: SessionId('t6-ordinary') })
    testCleanups.push(async () => { await ordinary.dispose() })
    const names = toolNames(ctx, ordinary.agent)
    for (const teamTool of AGENT_TEAM_TOOL_NAMES) expect(names).not.toContain(teamTool)
    expect(names).not.toContain('ordinary_tool')
  })

  // Spike (no production code): prove the per-member MOUNT seam — mounting a
  // plugin through one Member's agent context registers its tools on that
  // agent's exact layer, invisible to siblings, with the injected service
  // resolving through the scope chain. The real @deepseek-ai/dsh-tool-session-query
  // plugin and a minimal SessionQueryEngine stand-in provide the payload.
  it('spike: mounts session-query per Member through the agent exact layer without sibling visibility', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const engine = await import('@deepseek-ai/dsh-session-query')
    // The tool plugin ships in the adjacent Harness checkout (read-only
    // reference); it is not a Team dependency, so the spike loads it by path.
    const toolPluginModule = await import(pathToFileURL(join(harnessDir, 'packages/session-query/tool-session-query/lib/index.js')).href)
    const toolPlugin = {
      name: 'tool-session-query',
      inject: toolPluginModule.inject as readonly string[],
      apply: toolPluginModule.apply as (ctx: Context, config: unknown) => void,
    }

    const holder = await addMember(ctx, workspaceId, 't7-holder')
    const sibling = await addMember(ctx, workspaceId, 't7-sibling')
    const holderAgent = liveAgent(ctx, holder)
    const siblingAgent = liveAgent(ctx, sibling)
    expect(toolNames(ctx, siblingAgent)).not.toContain('session_search')

    // A minimal engine: the abstract surface is two search methods; every
    // other behavior has a concrete default inside SessionQueryEngine.
    class StandInEngine extends engine.SessionQueryEngine {
      searches: string[] = []
      override async searchSessions() {
        this.searches.push('sessions')
        return { hits: [], nextCursor: undefined } as never
      }
      override async searchEvents() {
        this.searches.push('events')
        return { hits: [], nextCursor: undefined } as never
      }
    }

    // Mount the real plugin on ONE Member's agent context; provide the engine
    // on that same context so the plugin's injection resolves through it.
    const standIn = new StandInEngine(holderAgent.ctx)
    holderAgent.ctx.plugin(toolPlugin, {})
    await vi.waitFor(() => {
      expect(toolNames(ctx, holderAgent)).toContain('session_search')
    })

    // Sibling and ordinary surfaces stay clean — the mount is agent-exact.
    expect(toolNames(ctx, siblingAgent)).not.toContain('session_search')
    expect(toolNames(ctx, siblingAgent)).not.toContain('session_trace')
    const ordinary = await ctx.agents.create({ sessionId: SessionId('t7-ordinary-spike') })
    testCleanups.push(async () => { await ordinary.dispose() })
    expect(toolNames(ctx, ordinary.agent)).not.toContain('session_search')

    // The tool executes against the Member-scoped engine instance.
    const result = await holderAgent.ctx.tools.execute({
      callId: ToolCallId('spike-call'),
      name: 'session_search',
      arguments: { query: 'anything' },
      agent: holderAgent as never,
      signal: new AbortController().signal,
    })
    expect(standIn.searches).toEqual(['sessions'])
    expect(result).toBeDefined()
  })

  it('reports the stored configuration warnings after a failed apply, not the restored leftover', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    // Activation with a drifted name: stored intent already carries a warning.
    const member = await addMember(ctx, workspaceId, 't9-warn', { tools: { allow: ['tool-renamed-away', 'ordinary_tool'] } })
    const agent = liveAgent(ctx, member)
    const baseline = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === member.memberId)
    expect(baseline?.capabilityWarnings?.map(warning => warning.name)).toEqual(['tool-renamed-away'])

    const restrict = vi.spyOn(agent.ctx.tools, 'restrict').mockImplementationOnce(() => {
      throw new Error('temporary restriction failure (test)')
    })
    try {
      await expect(ctx.agentTeam.updateMember({
        requestId: requestId('t9-ghost'), memberId: member.memberId, handle: 't9-warn', description: 'Policy member',
        capabilities: { tools: { allow: ['ghost_tool', 'ordinary_tool'] } },
      })).rejects.toThrow('temporary restriction failure')

      // Warnings always describe the STORED configuration: the failed apply
      // restores the enforced surface, but the reported divergence is the one
      // the accepted edit carries — never a leftover from the restored state.
      const failed = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === member.memberId)
      expect(failed?.capabilityWarnings?.map(warning => warning.name)).toEqual(['ghost_tool'])
    } finally {
      restrict.mockRestore()
    }
  })

  it('does not let a stale retry roll a newer accepted configuration back', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't10-race', { tools: { allow: ['ordinary_tool'] } })
    const agent = liveAgent(ctx, member)

    // Edit A commits durably, but its runtime apply fails once.
    const restrict = vi.spyOn(agent.ctx.tools, 'restrict').mockImplementationOnce(() => {
      throw new Error('temporary restriction failure (test)')
    })
    const stale = {
      requestId: requestId('t10-stale'), memberId: member.memberId, handle: 't10-race',
      description: 'Policy member', capabilities: { tools: { allow: ['spare_tool'] } },
    }
    await expect(ctx.agentTeam.updateMember(stale)).rejects.toThrow('temporary restriction failure')
    restrict.mockRestore()

    // Edit B is accepted afterwards and applies fully.
    const current = await ctx.agentTeam.updateMember({
      requestId: requestId('t10-current'), memberId: member.memberId, handle: 't10-race',
      description: 'Policy member', capabilities: { tools: { allow: ['ordinary_tool', 'spare_tool'] } },
    })
    expect(current.status.member.capabilities?.tools?.allow).toEqual(['ordinary_tool', 'spare_tool'])
    expect(toolNames(ctx, agent)).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())

    // Retrying the stale request is idempotent in effect: it replays its own
    // receipt but must neither re-apply its own historical configuration over
    // the newer accepted one nor report the historical state back.
    const replayed = await ctx.agentTeam.updateMember(stale)
    expect(replayed.status.member.capabilities?.tools?.allow).toEqual(['ordinary_tool', 'spare_tool'])
    expect(replayed.status.availability).toBe('active')
    expect(toolNames(ctx, agent)).toEqual([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())
    ctx.agentTeam.validateLedger()
  })

  it('keeps the pre-edit tool surface when an apply fails, then lets a retry finish the pending effect', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't8-tighten', { tools: { allow: ['ordinary_tool'] } })
    const agent = liveAgent(ctx, member)
    const before = toolNames(ctx, agent)

    // The edit's ledger commit succeeds; only the first runtime apply of the
    // new restriction fails once.
    const restrict = vi.spyOn(agent.ctx.tools, 'restrict').mockImplementationOnce(() => {
      throw new Error('temporary restriction failure (test)')
    })
    const request = {
      requestId: requestId('t8-tighten'), memberId: member.memberId, handle: 't8-tighten',
      description: 'Policy member', capabilities: { tools: { allow: ['spare_tool'] } },
    }
    try {
      await expect(ctx.agentTeam.updateMember(request)).rejects.toThrow('temporary restriction failure')

      // A failed apply never widens the surface: the pre-edit restriction
      // stays in force until a new one is actually installed.
      expect(toolNames(ctx, agent)).toEqual(before)

      // The same-request retry performs no second business commit, yet it
      // completes the effect the first attempt left undone: one coherent
      // surface matching the currently accepted configuration.
      const retried = await ctx.agentTeam.updateMember(request)
      expect(retried.status.member.capabilities?.tools?.allow).toEqual(['spare_tool'])
      expect(toolNames(ctx, agent)).toEqual([...AGENT_TEAM_TOOL_NAMES, 'spare_tool'].sort())
      ctx.agentTeam.validateLedger()
    } finally {
      restrict.mockRestore()
    }
  })

  it('distinguishes applied, already-applied, and deferred edits on the response and the roster', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't11-effect', { tools: { allow: ['ordinary_tool'] } })
    const roster = () => ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === member.memberId)
    expect(ctx.agentTeam.members().find(item => item.member.memberId === member.memberId)?.capabilityState).toBe('applied')
    expect(roster()?.capabilityState).toBe('applied')

    // A live edit that installs effects reports them as applied.
    const first = await ctx.agentTeam.updateMember({
      requestId: requestId('t11-widen'), memberId: member.memberId, handle: 't11-effect',
      description: 'Policy member', capabilities: { tools: { allow: ['ordinary_tool', 'spare_tool'] } },
    })
    expect(first.effect).toBe('applied')
    expect(first.status.capabilityState).toBe('applied')

    // Re-submitting the accepted configuration under a new id changes nothing.
    const again = await ctx.agentTeam.updateMember({
      requestId: requestId('t11-same'), memberId: member.memberId, handle: 't11-effect',
      description: 'Policy member', capabilities: { tools: { allow: ['ordinary_tool', 'spare_tool'] } },
    })
    expect(again.effect).toBe('already-applied')
    expect(again.status.capabilityState).toBe('applied')

    // A suspended Member has no live surface: the edit is saved and deferred
    // explicitly, and both the response and the roster report pending.
    await ctx.agentTeam.suspendMember({ requestId: requestId('t11-suspend'), memberId: member.memberId })
    expect(roster()?.capabilityState).toBe('pending')
    const deferred = await ctx.agentTeam.updateMember({
      requestId: requestId('t11-deferred'), memberId: member.memberId, handle: 't11-effect',
      description: 'Policy member', capabilities: { tools: { allow: ['spare_tool'] } },
    })
    expect(deferred.effect).toBe('deferred:no-live-handle')
    expect(deferred.status.capabilityState).toBe('pending')
    expect(roster()?.capabilityState).toBe('pending')
    expect(roster()?.availability).toBe('suspended')
  })

  it('surfaces a failed apply as a routable diagnostic with correlation ids, cleared when the effect lands', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't12-diag', { tools: { allow: ['ordinary_tool'] } })
    const agent = liveAgent(ctx, member)
    const restrict = vi.spyOn(agent.ctx.tools, 'restrict').mockImplementationOnce(() => {
      throw new Error('temporary restriction failure (test)')
    })
    const request = {
      requestId: requestId('t12-fail'), memberId: member.memberId, handle: 't12-diag',
      description: 'Policy member', capabilities: { tools: { allow: ['ordinary_tool', 'spare_tool'] } },
    }
    try {
      await expect(ctx.agentTeam.updateMember(request)).rejects.toThrow('temporary restriction failure')

      // The failure stays a loud rejection for the caller, and is also kept as
      // a routable, member-visible diagnostic carrying the correlation ids.
      const failed = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === member.memberId)
      expect(failed?.diagnostic?.class).toBe('capability-apply')
      expect(failed?.diagnostic?.detail).toContain('t12-fail')
      expect(failed?.diagnostic?.detail).toMatch(/operationId=\S+/)
      expect(failed?.diagnostic?.detail).toContain('temporary restriction failure (test)')
      expect(failed?.capabilityState).toBe('pending')
      expect(failed?.availability).toBe('active')
      expect(failed?.presence).toBe('error')

      // The same-request retry finishes the effect and retires the diagnostic.
      const retried = await ctx.agentTeam.updateMember(request)
      expect(retried.effect).toBe('applied')
      expect(retried.status.diagnostic).toBeUndefined()
      expect(retried.status.capabilityState).toBe('applied')
      const cleared = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === member.memberId)
      expect(cleared?.diagnostic).toBeUndefined()
      expect(cleared?.capabilityState).toBe('applied')
      ctx.agentTeam.validateLedger()
    } finally {
      restrict.mockRestore()
    }
  })

  it('pins a model edit onto the live turn route and clears it back to the Host default', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't13-model')
    const agent = liveAgent(ctx, member)

    // Pinning a model is a live effect: the stored override is accepted, the
    // response says the effect landed, and the same Session's next turn runs
    // the pinned route.
    const pinned = await ctx.agentTeam.updateMember({
      requestId: requestId('t13-pin'), memberId: member.memberId, handle: 't13-model',
      description: 'Policy member', model: { provider: 'mock', model: 'pinned' },
    })
    expect(pinned.effect).toBe('applied')
    expect(pinned.status.member.model).toEqual({ provider: 'mock', model: 'pinned' })
    expect(pinned.status.member.sessionId).toBe(member.sessionId)
    expect(pinned.status.capabilityState).toBe('applied')

    adapter.enqueue([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'done' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const firstIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await firstIdle
    const firstRequest = adapter.requests.at(-1)
    expect(firstRequest?.provider).toBe('mock')
    expect(firstRequest?.model).toBe('pinned')
    expect(firstRequest?.sessionId).toBe(member.sessionId)

    // Dropping the pin clears the stored override and returns the next turn
    // to the Host default, still in the same Session.
    const cleared = await ctx.agentTeam.updateMember({
      requestId: requestId('t13-unpin'), memberId: member.memberId, handle: 't13-model',
      description: 'Policy member',
    })
    expect(cleared.effect).toBe('applied')
    expect(cleared.status.member.model).toBeUndefined()

    adapter.enqueue([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'again' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'again' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const secondIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await secondIdle
    expect(adapter.requests.at(-1)?.provider).toBe('mock')
    expect(adapter.requests.at(-1)?.model).toBe('mock')
    expect(adapter.requests.at(-1)?.sessionId).toBe(member.sessionId)
  })

  it('defers a skills edit to the turn boundary without interrupting the running turn', async () => {
    const adapter = new GatedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't14-skills')
    const agent = liveAgent(ctx, member)
    const skillsDir = join(member.privateMemoryPath, 'skills')
    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(skillsDir, 'alpha.md'), '---\nname: alpha\ndescription: Alpha skill\n---\n\nAlpha body.\n')
    await writeFile(join(skillsDir, 'beta.md'), '---\nname: beta\ndescription: Beta skill\n---\n\nBeta body.\n')
    await vi.waitFor(async () => {
      const names = await catalogNames(ctx, agent)
      expect(names).toContain('alpha')
      expect(names).toContain('beta')
    })

    // Selecting while idle applies immediately: the live catalog narrows.
    const selected = await ctx.agentTeam.updateMember({
      requestId: requestId('t14-select'), memberId: member.memberId, handle: 't14-skills',
      description: 'Policy member', capabilities: { skills: { allow: ['alpha'] } },
    })
    expect(selected.effect).toBe('applied')
    expect(await catalogNames(ctx, agent)).toEqual(['alpha'])

    // Widen while a turn is running: the edit parks at the boundary, the
    // running turn keeps its pre-edit catalog, and nothing interrupts it.
    const turnDone = waitForIdle(ctx, agent)
    const running = waitForRunning(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await running
    const edit = ctx.agentTeam.updateMember({
      requestId: requestId('t14-widen'), memberId: member.memberId, handle: 't14-skills',
      description: 'Policy member', capabilities: { skills: { allow: ['alpha', 'beta'] } },
    })
    const raced = await Promise.race([edit.then(() => 'settled'), new Promise<string>(resolve => { setTimeout(() => resolve('pending'), 50) })])
    expect(raced).toBe('pending')
    expect(await catalogNames(ctx, agent)).toEqual(['alpha'])

    adapter.release()
    const settled = await edit
    expect(settled.effect).toBe('applied')
    expect(settled.status.capabilityState).toBe('applied')
    expect(settled.status.member.sessionId).toBe(member.sessionId)
    await turnDone
    expect(await catalogNames(ctx, agent)).toEqual(['alpha', 'beta'])
    ctx.agentTeam.validateLedger()
  })
})
