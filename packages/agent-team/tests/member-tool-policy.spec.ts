import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  defineContentToolFixture, executeModelToolFixture, executeToolFixture,
} from '@deepseek-ai/dsh-tool-testkit'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { TeamService as OfficialTeamService } from '@deepseek-ai/dsh-experimental-agent-team'
import * as OfficialTeamTools from '@deepseek-ai/dsh-experimental-tool-agent-team'
import AgentTeam, { AGENT_TEAM_TOOL_NAMES } from '../src/index.ts'
import { TOOL_AVAILABILITY_SECTION } from '../src/tool-availability-guidance.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'
import type { AgentTeamMemberCapabilities, AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'
import { mountTeamMemberHost, provideQuietTokenMeter } from './helpers/team-host-fixture.ts'
import { cleanups as realHarnessCleanups, realHarness } from './helpers/member-harness.ts'

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

/**
 * The tools every Member surface carries whatever its allow-list says, with the
 * Worker switch off (the Host row's default): `team_worker` is not declared
 * until the switch is on, and the spec below covers that flip.
 */
const MEMBER_TOOL_NAMES = [...AGENT_TEAM_TOOL_NAMES.filter(name => name !== 'team_worker'), 'working_directory'].sort()

async function catalogNames(ctx: Context, agent: Agent): Promise<readonly string[]> {
  const skills = await ctx.skills.list({ scope: agent as never })
  return skills.map(skill => skill.name).sort()
}

/**
 * Flip the Host row's Worker switch the way the settings form does: the row's
 * volatile value changes and the loader announces it, so live Member surfaces
 * follow the same seam a deployment uses.
 */
function setWorkerSwitch(ctx: Context, enabled: boolean): void {
  const config = ctx.agentTeam.config as unknown as { worker: { get(): { enabled: boolean } } }
  const current = config.worker.get()
  config.worker = { get: () => ({ ...current, enabled }) }
  ctx.emit('loader/volatile-update', [])
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
 * Replace only the live extra-tool list, the same seam the volatile settings
 * row exposes. The Host reads it synchronously at each `turn/start`; no loader
 * event is needed because this feature deliberately does not wake Member turns.
 */
function useExtraToolGrants(ctx: Context, initial: readonly string[]): (names: readonly string[]) => void {
  const config = ctx.agentTeam.config as unknown as { extraToolGrants: { get(): readonly string[] } }
  const original = config.extraToolGrants
  testCleanups.push(() => { config.extraToolGrants = original })
  const set = (names: readonly string[]): void => {
    config.extraToolGrants = { get: () => [...names] }
  }
  set(initial)
  return set
}

function stopResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * File-shared harness: booted once in `beforeAll`, torn down once in
 * `afterAll`. The ledger is append-only, so tests stay isolated through unique
 * handles/requestIds (see the invariant below); the LLM adapter is the one
 * per-test registration because `registerAdapter` throws on duplicate routes —
 * each test registers its own and `afterEach` disposes it.
 */
function buildSharedHarness(cleanups: Array<() => Promise<void>> = sharedCleanups) {
  return mountTeamMemberHost({
    cleanups,
    prepare: provideQuietTokenMeter,
    // The distinguishable-tool fixture is a real module beside this spec,
    // where its own imports resolve.
    presetPlugins: [
      { id: 'member-context', name: '@contexera/dsh-agent-team/member-context' },
      { id: 'team-tools', name: pathToFileURL(join(import.meta.dirname, 'helpers', 'team-tools-fixture.mjs')).href },
    ],
    // working_directory is mounted for real: the allow-list union keeps it, and
    // the policy case below enters a second checkout through it.
    workingDirectory: 'real',
    otherCheckouts: 1,
  })
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
  readonly model: { provider: 'mock', model: 'mock' }, privateMemoryPath: string
}

async function addMember(ctx: Context, workspaceId: WorkspaceId, handle: string, capabilities?: AgentTeamMemberCapabilities): Promise<MemberFacts> {
  const added = await ctx.agentTeam.addMember({
    requestId: requestId(`add-${handle}`), workspaceId, handle, description: 'Policy member',
    presetId: 'team-member', projectRefs: [], ...(capabilities === undefined ? {} : { capabilities }),
    model: { provider: 'mock', model: 'mock' },
  })
  expect(added.status.availability, JSON.stringify(added.status)).toBe('active')
  return { memberId: added.status.member.memberId, sessionId: added.status.member.sessionId, model: { provider: 'mock', model: 'mock' }, privateMemoryPath: added.status.member.privateMemoryPath }
}

function liveAgent(ctx: Context, facts: MemberFacts): Agent {
  const agent = ctx.agents.get(facts.sessionId)
  expect(agent).toBeDefined()
  return agent!
}

describe('Agent Team member tool policy', () => {
  it('excludes Host tools by default and cannot opt into them through a Member allow-list', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const dispose = ctx.tools.register(defineContentToolFixture({
      name: 'foreign_global', description: 'foreign', parameters: {},
      execute: async () => [{ type: 'text', text: 'foreign executed' }],
    }))
    testCleanups.push(dispose)
    const base = await addMember(ctx, workspaceId, 't16-default')
    expect(toolNames(ctx, liveAgent(ctx, base))).not.toContain('foreign_global')
    const narrow = await addMember(ctx, workspaceId, 't16-narrow', { tools: { allow: ['foreign_global', 'ordinary_tool'] } })
    expect(toolNames(ctx, liveAgent(ctx, narrow))).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool'].sort())
    expect(ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === narrow.memberId)
      ?.capabilityWarnings?.map(warning => warning.name)).toEqual(['foreign_global'])
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('foreign_global')
  })

  it('declares team_worker only while the Host Worker switch is on, and withdraws it live', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const original = (ctx.agentTeam.config as unknown as { worker: unknown }).worker
    testCleanups.push(() => {
      ;(ctx.agentTeam.config as unknown as { worker: unknown }).worker = original
      ctx.emit('loader/volatile-update', [])
    })
    const member = await addMember(ctx, workspaceId, 't21-worker-switch')
    const agent = liveAgent(ctx, member)
    // Off by default: the Member never sees a tool the Host would refuse.
    expect(toolNames(ctx, agent)).not.toContain('team_worker')
    expect(toolNames(ctx, agent)).toEqual(expect.arrayContaining(['team_message', 'team_task', 'ordinary_tool']))

    // On: the existing Session's next step sees it, with no restart.
    setWorkerSwitch(ctx, true)
    await vi.waitFor(() => {
      expect(toolNames(ctx, agent)).toContain('team_worker')
    })

    // Declaration alone is insufficient: the per-Member execution guard must
    // admit the same live switch. Use a non-owning Member so Host authorization
    // proves the call reached Worker policy rather than its own guard.
    const attempted = await executeToolFixture(ctx, {
      signal: new AbortController().signal, agent, name: 'team_worker', callId: ToolCallId('t21-worker-execute'),
      arguments: { task: 'check the live tool policy', projectRef: 'project:missing', threadRef: 'thread:missing' },
    })
    expect(JSON.stringify(attempted)).not.toContain('not declared for this Team Member')
    expect(JSON.stringify(attempted)).toContain('not a Thread in this Team')

    // Off again: withdrawn, and the rest of the Team surface stays.
    setWorkerSwitch(ctx, false)
    await vi.waitFor(() => {
      expect(toolNames(ctx, agent)).not.toContain('team_worker')
    })
    expect(toolNames(ctx, agent)).toEqual(expect.arrayContaining(['team_message', 'team_task', 'ordinary_tool']))
  })

  it('declares a late own-scope registration to the model but still denies its direct and nested calls', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const body = vi.fn(async () => [{ type: 'text' as const, text: 'foreign executed' }])
    const install = ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.register(defineContentToolFixture({
        name: 'foreign_late', description: 'foreign', parameters: {}, execute: body,
      }))
      return undefined
    })
    testCleanups.push(() => { install() })
    const member = await addMember(ctx, workspaceId, 't17-late')
    const agent = liveAgent(ctx, member)
    const call = { signal: new AbortController().signal, agent, name: 'foreign_late', arguments: {} }
    expect((await executeToolFixture(ctx, { ...call, callId: ToolCallId('t17-direct') })).isError).toBe(true)
    const nested = ctx.on('tools/pre-execute', async (execution, next) => {
      if (execution.agent === agent && execution.name === 'ordinary_tool') {
        const result = await executeToolFixture(ctx, { ...call, callId: ToolCallId('t17-nested'), parent: execution.token })
        expect(result.isError).toBe(true)
      }
      return next()
    })
    testCleanups.push(() => { nested() })
    adapter.enqueue(toolCallResponse('t17-model', 'ordinary_tool', {}))
    adapter.enqueue([{ type: 'finish', reason: { kind: 'stop' } }])
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await idle
    expect(adapter.requests).toHaveLength(2)
    // A restriction has always filtered global tools only and left scoped registrations alone; what changed is that the Team no longer has an assembly-time hook that hid a Member's own late row from the declarations. It is declared now, and the guard below is what refuses to run it.
    const declaredTools = [...MEMBER_TOOL_NAMES, 'ordinary_tool', 'spare_tool', 'foreign_late'].sort()
    for (const request of adapter.requests) {
      expect(request.tools?.map(tool => tool.name).sort()).toEqual(declaredTools)
    }
    expect(agent.session.requestHeader()?.tools?.map(tool => tool.name).sort())
      .toEqual(adapter.requests.at(-1)?.tools?.map(tool => tool.name).sort())
    expect(body).not.toHaveBeenCalled()
    const ordinary = await ctx.agents.create({ sessionId: SessionId('t17-ordinary') })
    testCleanups.push(async () => { await ordinary.dispose() })
    expect((await executeToolFixture(ctx, { ...call, agent: ordinary.agent, callId: ToolCallId('t17-other') })).isError).not.toBe(true)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('rejects a same-name replacement without adopting it during a capability edit', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    const member = await addMember(ctx, workspaceId, 't18-shadow')
    const agent = liveAgent(ctx, member)
    const body = vi.fn(async () => [{ type: 'text' as const, text: 'replacement executed' }])
    testCleanups.push(agent.ctx.tools.register(defineContentToolFixture({
      name: 'ordinary_tool', description: 'replacement', parameters: {}, execute: body,
    })))
    await ctx.agentTeam.updateMember({
      requestId: requestId('t18-edit'), memberId: member.memberId, handle: 't18-shadow', description: 'Policy member',
      capabilities: { tools: { allow: ['ordinary_tool'] } },
    })
    // Without the assembly-time filter the Team used to run, a same-name replacement reaches the request's declarations and surfaces where the Member's guard runs it — at the call, not while the prompt is assembled.
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal, agent, name: 'ordinary_tool', arguments: {}, callId: ToolCallId('t18-call'),
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/replaced.*ordinary_tool/)
    expect(body).not.toHaveBeenCalled()
  })

  it.each(['before', 'after'] as const)('keeps Members usable when the official Team plugin loads %s Member activation', async timing => {
    const cleanups: Array<() => Promise<void>> = []
    testCleanups.push(async () => { for (const cleanup of cleanups) await cleanup() })
    const { ctx, workspaceId } = await mountTeamMemberHost({
      cleanups, prepare: provideQuietTokenMeter,
      presetPlugins: [{ id: 'team-tools', name: pathToFileURL(join(import.meta.dirname, 'helpers', 'team-tools-fixture.mjs')).href }],
    })
    const adapter = new ScriptedAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    // No delegation is attempted; membership and tool installation use the
    // real official services, with only their unused provider dependency stubbed.
    ctx.provide('subagents', {})
    if (timing === 'before') {
      await ctx.plugin(OfficialTeamService)
      await ctx.plugin(OfficialTeamTools)
    }
    const member = await addMember(ctx, workspaceId, 't20-official')
    const agent = liveAgent(ctx, member)
    if (timing === 'after') {
      await ctx.plugin(OfficialTeamService)
      await ctx.plugin(OfficialTeamTools)
    }
    expect(ctx.agentTeam.toolCatalogForClient({}).names).toContain('list_agents')
    const denied = await executeToolFixture(ctx, {
      signal: new AbortController().signal, agent, name: 'list_agents', arguments: {}, callId: ToolCallId('t20-foreign'),
    })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).toContain('not declared for this Team Member')
    adapter.enqueue(toolCallResponse('t20-model', 'ordinary_tool', {}))
    adapter.enqueue([{ type: 'finish', reason: { kind: 'stop' } }])
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } }))
    await idle
    expect(agent.session.ownEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('completed')
    expect(adapter.requests).toHaveLength(2)
    for (const request of adapter.requests) {
      // A restriction filters global tools only and leaves scoped registrations alone, and the official Team tools register in the Agent's exact scope — so, with no assembly-time hook left to hide them, they are declared alongside the Member's own set. The guard, not the declaration, is what refuses them: the direct `list_agents` call above is already denied.
      const declared = new Set(request.tools?.map(tool => tool.name))
      expect([...AGENT_TEAM_TOOL_NAMES.filter(name => name !== 'team_worker'), 'ordinary_tool', 'spare_tool'].every(name => declared.has(name))).toBe(true)
      expect(declared.has('list_agents')).toBe(true)
    }
    const memberAssembly = await agent.ctx.systemPrompt.assemble({ scope: agent })
    const guidance = memberAssembly.sections.find(section => section.name === TOOL_AVAILABILITY_SECTION)?.text ?? ''
    expect(guidance).toContain('`list_agents`')
    expect(guidance).toContain('Do not invoke them while they are ungranted')
    expect(guidance).toContain('Schema visibility is not execution permission')
    const ordinary = await ctx.agents.create({ sessionId: SessionId('t20-ordinary') })
    testCleanups.push(async () => { await ordinary.dispose() })
    expect(toolNames(ctx, ordinary.agent)).toContain('spawn_teammate')
    const assembly = await ordinary.agent.ctx.systemPrompt.assemble({ scope: ordinary.agent })
    expect(assembly.contexts.find(context => context.name === 'team:identity')?.text).toContain('Team Lead')
    expect(assembly.sections.map(section => section.name)).not.toContain(TOOL_AVAILABILITY_SECTION)
    await ctx.agentTeam.suspendMember({ requestId: requestId('t20-suspend'), memberId: member.memberId })
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('t20-resume'), memberId: member.memberId })
    expect(resumed.status.availability).toBe('active')
    const resumedAgent = liveAgent(ctx, member)
    adapter.enqueue([{ type: 'finish', reason: { kind: 'stop' } }])
    const resumedIdle = waitForIdle(ctx, resumedAgent)
    resumedAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await resumedIdle
    expect(resumedAgent.session.ownEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('completed')
    expect(adapter.requests).toHaveLength(3)
    // The resumed Member keeps its own tool set; the official Team rows stay declared too, because a restriction leaves scoped registrations alone, and the guard still refuses them.
    const resumedDeclared = new Set(adapter.requests.at(-1)?.tools?.map(tool => tool.name))
    expect([...AGENT_TEAM_TOOL_NAMES.filter(name => name !== 'team_worker'), 'ordinary_tool', 'spare_tool'].every(name => resumedDeclared.has(name))).toBe(true)
    expect(resumedDeclared.has('list_agents')).toBe(true)
    const resumedAssembly = await resumedAgent.ctx.systemPrompt.assemble({ scope: resumedAgent })
    expect(resumedAssembly.sections.find(section => section.name === TOOL_AVAILABILITY_SECTION)?.text).toContain('`list_agents`')
  })

  it('admits an official Agent-scoped tool behind a profile grant', async () => {
    const cleanups: Array<() => Promise<void>> = []
    testCleanups.push(async () => { for (const cleanup of cleanups) await cleanup() })
    const { ctx, workspaceId } = await mountTeamMemberHost({
      cleanups, prepare: provideQuietTokenMeter,
      presetPlugins: [{ id: 'team-tools', name: pathToFileURL(join(import.meta.dirname, 'helpers', 'team-tools-fixture.mjs')).href }],
    })
    const adapter = new ScriptedAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.provide('subagents', {})
    await ctx.plugin(OfficialTeamService)
    await ctx.plugin(OfficialTeamTools)
    useExtraToolGrants(ctx, ['list_agents'])
    const member = await addMember(ctx, workspaceId, 't20-official-grant')
    const agent = liveAgent(ctx, member)

    expect(ctx.agentTeam.toolCatalogForClient({}).names).toContain('list_agents')
    const assembly = await agent.ctx.systemPrompt.assemble({ scope: agent })
    const guidance = assembly.sections.find(section => section.name === TOOL_AVAILABILITY_SECTION)?.text ?? ''
    expect(guidance).not.toContain('`list_agents`')
    expect(guidance).toContain('`spawn_teammate`')
    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'mock', model: 'mock' }, signal })
    testCleanups.push(() => { toolSet.dispose() })
    const granted = await executeModelToolFixture(ctx, {
      signal, agent, toolSet, name: 'list_agents', arguments: {}, callId: ToolCallId('t20-official-granted'),
    })
    expect(granted.isError, JSON.stringify(granted)).not.toBe(true)
    expect(JSON.stringify(granted)).toContain('lead')
  })

  it('restricts each Member to its own allow-list without affecting siblings', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    // Baseline: an unrestricted Member sees the five Team tools and both fixtures.
    const base = await addMember(ctx, workspaceId, 't1-baseline')
    const baseAgent = liveAgent(ctx, base)
    expect(toolNames(ctx, baseAgent)).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())

    const narrow = await addMember(ctx, workspaceId, 't1-narrow', { tools: { allow: ['ordinary_tool'] } })
    const narrowAgent = liveAgent(ctx, narrow)
    // The five Team tools are force-unioned; spare_tool disappears.
    expect(toolNames(ctx, narrowAgent)).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool'].sort())
    // The sibling surface is unchanged by the restriction, and the hidden
    // tool resolves as absent rather than callable.
    expect(toolNames(ctx, baseAgent)).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())
    expect(ctx.tools.get('spare_tool', narrowAgent as never)).toBeUndefined()
    const status = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === narrow.memberId)
    expect(status?.capabilityWarnings).toBeUndefined()
  })

  it('keeps working_directory on a narrowed Member so it can enter a joined Workspace', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId, otherCheckouts } = shared
    const otherWorkspace = otherCheckouts[0]!
    const narrow = await addMember(ctx, workspaceId, 't15-narrow', { tools: { allow: ['ordinary_tool'] } })
    const agent = liveAgent(ctx, narrow)
    // An allow-list narrows capability, never the Member's ability to be in the
    // directory it was invited to work in.
    expect(toolNames(ctx, agent)).toContain('working_directory')
    const entered = await executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId('t15-cd'), name: 'working_directory',
      arguments: { cd: otherWorkspace }, agent,
    })
    // `tmpdir()` hands back the 8.3 short form on the windows lane
    // (`RUNNER~1`) while the tool reports the directory it entered under its
    // long name (`runneradmin`), so the two spellings must not be compared as
    // strings: the assertion is about which directory was entered, so both
    // sides are resolved first.
    const enteredCwd = (entered.value as { cwd?: string } | null)?.cwd
    expect(enteredCwd).toBeTypeOf('string')
    expect(await realpath(enteredCwd!)).toBe(await realpath(otherWorkspace))
    expect(await realpath(ctx.workingDirectory.get(agent.session)!)).toBe(await realpath(otherWorkspace))
  })

  it('drops unknown allow-list names at activation with a diagnostic warning digest', async () => {
    useAdapter(new EmptyAdapter())
    const { ctx, workspaceId } = shared
    // 'tool-renamed-away' simulates a Harness upgrade rename: committed as
    // pure intent, dropped at activation, never fatal.
    const drifted = await addMember(ctx, workspaceId, 't2-drifted', { tools: { allow: ['tool-renamed-away', 'ordinary_tool'] } })
    const driftedAgent = liveAgent(ctx, drifted)
    expect(toolNames(ctx, driftedAgent)).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool'].sort())
    const status = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === drifted.memberId)
    expect(status?.availability).toBe('active')
    expect(status?.capabilityWarnings).toEqual([
      expect.objectContaining({
        name: 'tool-renamed-away',
        knownNames: expect.arrayContaining([...AGENT_TEAM_TOOL_NAMES, 'ordinary_tool', 'spare_tool']),
      }),
    ])
    // A clean re-edit clears the warnings together with the override.
    const edited = await ctx.agentTeam.updateMember({ requestId: requestId('clear-drift'), memberId: drifted.memberId, handle: 't2-drifted', description: 'Cleaned up', capabilities: null })
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
    expect(toolNames(ctx, liveAgent(ctx, narrow))).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool'].sort())
    // The sibling never moved.
    expect(toolNames(ctx, liveAgent(ctx, other))).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())

    // Host restart: disposal releases restriction state; replay plus
    // reactivation rebuild the same restricted surface from durable intent.
    await teamFiber.dispose()
    await ctx.plugin(AgentTeam)
    const restored = ctx.agentTeam.membersForClient({ workspaceId }).find(item => item.member.memberId === narrow.memberId)
    expect(restored?.availability, JSON.stringify(restored)).toBe('active')
    expect(restored?.capabilityState).toBe('applied')
    expect(toolNames(ctx, liveAgent(ctx, narrow))).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool'].sort())
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
    expect(toolNames(ctx, agent)).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())

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
    expect(toolNames(ctx, agent)).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())
    const suspended = await suspending
    expect(suspended.status.availability).toBe('suspended')
    await turnDone

    // Resume applies the stored intent at the next activation.
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume-after-wait'), memberId: narrow.memberId })
    expect(resumed.status.availability).toBe('active')
    expect(toolNames(ctx, liveAgent(ctx, narrow))).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())
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
    expect(toolNames(ctx, agent)).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())

    // Retrying the stale request is idempotent in effect: it replays its own
    // receipt but must neither re-apply its own historical configuration over
    // the newer accepted one nor report the historical state back.
    const replayed = await ctx.agentTeam.updateMember(stale)
    expect(replayed.status.member.capabilities?.tools?.allow).toEqual(['ordinary_tool', 'spare_tool'])
    expect(replayed.status.availability).toBe('active')
    expect(toolNames(ctx, agent)).toEqual([...MEMBER_TOOL_NAMES, 'ordinary_tool', 'spare_tool'].sort())
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
      expect(toolNames(ctx, agent)).toEqual([...MEMBER_TOOL_NAMES, 'spare_tool'].sort())
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

  it('pins a model edit onto the live turn route and replaces it without clearing', async () => {
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

    // A Member always runs an explicit route: clearing is refused, and the stored pin stays in force.
    await expect(ctx.agentTeam.updateMember({
      requestId: requestId('t13-unpin'), memberId: member.memberId, handle: 't13-model',
      description: 'Policy member', model: null,
    })).rejects.toThrow(/cannot be cleared/)

    // Replacing the route is the same live effect: the next turn in the same Session runs the new model.
    const replaced = await ctx.agentTeam.updateMember({
      requestId: requestId('t13-replace'), memberId: member.memberId, handle: 't13-model',
      description: 'Policy member', model: { provider: 'mock', model: 'replaced' },
    })
    expect(replaced.effect).toBe('applied')
    expect(replaced.status.member.model).toEqual({ provider: 'mock', model: 'replaced' })

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
    expect(adapter.requests.at(-1)?.model).toBe('replaced')
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

describe('profile extra tool-name grants', () => {
  it('declares a granted global tool, executes it as the Member, and withdraws it on the next turn', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const body = vi.fn(async () => [{ type: 'text' as const, text: 'granted execution' }])
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't23_foreign', description: 'foreign', parameters: {}, execute: body,
    })))
    const setGrants = useExtraToolGrants(ctx, [])
    const member = await addMember(ctx, workspaceId, 't23-granted')
    const agent = liveAgent(ctx, member)

    expect(toolNames(ctx, agent)).not.toContain('t23_foreign')
    setGrants(['t23_foreign'])
    const noAdmission = await executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId('t23-no-admission'),
      name: 't23_foreign', arguments: {}, agent,
    })
    expect(noAdmission.isError).toBe(true)
    expect(body).not.toHaveBeenCalled()

    adapter.enqueue(toolCallResponse('t23-model-call', 't23_foreign', {}))
    adapter.enqueue(stopResponse('granted run complete'))
    const grantedIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the granted tool' }], source: { kind: 'user' } }))
    await grantedIdle
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('t23_foreign')
    expect(body).toHaveBeenCalledTimes(1)

    setGrants([])
    adapter.enqueue(stopResponse('withdrawn'))
    const withdrawnIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run without it' }], source: { kind: 'user' } }))
    await withdrawnIdle
    expect(adapter.requests.at(-1)?.tools?.map(tool => tool.name)).not.toContain('t23_foreign')
    const withdrawn = await executeToolFixture(ctx, {
      signal: new AbortController().signal, callId: ToolCallId('t23-withdrawn'),
      name: 't23_foreign', arguments: {}, agent,
    })
    expect(withdrawn.isError).toBe(true)
  })

  it('reopens a baseline name omitted by the Member allow-list without reopening the Worker switch', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const setGrants = useExtraToolGrants(ctx, [])
    const member = await addMember(ctx, workspaceId, 't23b-reopen', {
      tools: { allow: ['spare_tool'] },
    })
    const agent = liveAgent(ctx, member)
    expect(toolNames(ctx, agent)).not.toContain('ordinary_tool')
    expect(toolNames(ctx, agent)).not.toContain('team_worker')

    setGrants(['ordinary_tool', 'team_worker', 'working_directory'])
    adapter.enqueue(stopResponse('allow-list reopened'))
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the reopened tool' }], source: { kind: 'user' } }))
    await idle
    const declared = adapter.requests.at(-1)?.tools?.map(tool => tool.name) ?? []
    expect(declared).toContain('ordinary_tool')
    expect(declared).toContain('working_directory')
    expect(declared).not.toContain('team_worker')

    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'mock', model: 'mock' }, signal })
    testCleanups.push(() => { toolSet.dispose() })
    const reopened = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('t23b-reopened'), name: 'ordinary_tool', arguments: {}, agent, toolSet,
    })
    expect(reopened.isError).not.toBe(true)
  })

  it('uses the same grant list after create and suspend/resume reactivation', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't23c_reactivated', description: 'reactivated', parameters: {},
      execute: async () => [{ type: 'text', text: 'ok' }],
    })))
    useExtraToolGrants(ctx, ['t23c_reactivated'])
    const member = await addMember(ctx, workspaceId, 't23c-reactivation')
    expect(toolNames(ctx, liveAgent(ctx, member))).toContain('t23c_reactivated')

    await ctx.agentTeam.suspendMember({ requestId: requestId('t23c-suspend'), memberId: member.memberId })
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('t23c-resume'), memberId: member.memberId })
    expect(resumed.status.availability).toBe('active')
    const agent = liveAgent(ctx, member)
    expect(toolNames(ctx, agent)).toContain('t23c_reactivated')

    adapter.enqueue(stopResponse('resumed grant'))
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await idle
    expect(adapter.requests.at(-1)?.tools?.map(tool => tool.name)).toContain('t23c_reactivated')
  })

  it('reapplies the profile grant to a swapped-in generation', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-20T08:00:00Z'))
      const adapter = new ScriptedAdapter()
      const host = await realHarness(adapter)
      testCleanups.push(async () => {
        for (const cleanup of realHarnessCleanups.splice(0)) await cleanup()
      })
      const { ctx, workspaceId, pressureState } = host
      const body = vi.fn(async () => [{ type: 'text' as const, text: 'successor grant' }])
      testCleanups.push(ctx.tools.register(defineContentToolFixture({
        name: 't23d_successor', description: 'successor generation', parameters: {}, execute: body,
      })))
      useExtraToolGrants(ctx, ['t23d_successor'])
      const project = await ctx.agentTeam.createProject({
        requestId: requestId('t23d-project'), workspaceId, name: 'engineering', description: 'Generation swap',
      })
      const added = await ctx.agentTeam.addMember({
        requestId: requestId('t23d-add'), workspaceId, handle: 't23d-generation',
        description: 'Policy member', presetId: 'team-member',
        projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' },
      })
      const member = {
        memberId: added.status.member.memberId,
        sessionId: added.status.member.sessionId,
        model: { provider: 'mock' as const, model: 'mock' as const },
        privateMemoryPath: added.status.member.privateMemoryPath,
      }
      const first = liveAgent(ctx, member)
      expect(toolNames(ctx, first)).toContain('t23d_successor')
      adapter.enqueue(stopResponse('first generation'))
      const firstIdle = waitForIdle(ctx, first)
      first.followup(createUserMessage({ content: [{ type: 'text', text: 'open the generation' }], source: { kind: 'user' } }))
      await firstIdle

      pressureState.bySession.set(member.sessionId, 130_000)
      await vi.advanceTimersByTimeAsync(61 * 60_000)
      adapter.enqueue(toolCallResponse('t23d-successor-call', 't23d_successor', {}))
      adapter.enqueue(stopResponse('successor complete'))
      await ctx.agentTeam.startThread({
        kind: 'discussion', requestId: requestId('t23d-wake'), workspaceId,
        projectRef: project.project.projectRef, body: '@t23d-generation continue here',
      })
      const successorId = await vi.waitFor(() => {
        const current = ctx.agentTeam.members().find(entry => entry.member.memberId === member.memberId)
        if (current === undefined || current.member.sessionId === member.sessionId) throw new Error('swap not applied yet')
        return current.member.sessionId
      }, { timeout: 20_000 })
      const successor = await vi.waitFor(() => {
        const live = ctx.agents.get(successorId)
        if (live === undefined) throw new Error('successor not live yet')
        return live
      }, { timeout: 20_000 })
      // A new generation is idle before its wake arrives; wait for actual work first.
      await vi.waitFor(() => {
        expect(adapter.requests.some(request => request.sessionId === successorId)).toBe(true)
      }, { timeout: 20_000 })
      for (let index = 0; index < 1000 && successor.status !== 'idle'; index += 1) {
        await vi.advanceTimersByTimeAsync(10)
      }
      expect(
        successor.status,
        `successor status; requests=${adapter.requests.map(request => request.sessionId).join(',')}`,
      ).toBe('idle')

      const successorRequests = adapter.requests.filter(request => request.sessionId === successorId)
      expect(successorRequests).not.toHaveLength(0)
      expect(successorRequests[0]?.tools?.map(tool => tool.name)).toContain('t23d_successor')
      expect(body).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)

  it('uses the latest grants for a second turn that starts without an idle boundary', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't24_next_turn', description: 'next turn', parameters: {}, execute: async () => [{ type: 'text', text: 'ok' }],
    })))
    const setGrants = useExtraToolGrants(ctx, [])
    const member = await addMember(ctx, workspaceId, 't24-consecutive')
    const agent = liveAgent(ctx, member)
    const statuses: string[] = []
    const observeStatus = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent) statuses.push(status)
    })
    testCleanups.push(() => { observeStatus() })

    const firstRequest = Promise.withResolvers<void>()
    const baseStream = adapter.stream.bind(adapter)
    vi.spyOn(adapter, 'stream').mockImplementation(async function* (options) {
      const requestNumber = adapter.requests.length + 1
      if (requestNumber === 1) firstRequest.resolve()
      yield* baseStream(options)
    })
    adapter.enqueue(stopResponse('first'))
    adapter.enqueue(stopResponse('second'))
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await firstRequest.promise
    setGrants(['t24_next_turn'])
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).not.toContain('t24_next_turn')
    expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toContain('t24_next_turn')
    // Both turns ran under one continuous running phase; the queued next-turn
    // message never materialized an idle boundary between them.
    expect(statuses.filter(status => status === 'running')).toHaveLength(1)
    expect(statuses.filter(status => status === 'idle')).toHaveLength(1)
  })

  it('does not let a delayed boundary apply overwrite the grants frozen by a new turn', async () => {
    const adapter = new GatedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const executedA = vi.fn(async () => [{ type: 'text' as const, text: 'a' }])
    const executedB = vi.fn(async () => [{ type: 'text' as const, text: 'b' }])
    const executedC = vi.fn(async () => [{ type: 'text' as const, text: 'c' }])
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't32_frozen_a', description: 'frozen a', parameters: {}, execute: executedA,
    })))
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't32_frozen_b', description: 'frozen b', parameters: {}, execute: executedB,
    })))
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't32_frozen_c', description: 'frozen c', parameters: {}, execute: executedC,
    })))
    const setGrants = useExtraToolGrants(ctx, ['t32_frozen_a'])
    const member = await addMember(ctx, workspaceId, 't32-frozen-turn')
    const agent = liveAgent(ctx, member)
    const service = ctx.agentTeam as unknown as { applyWorkerExposure(enabled: boolean): Promise<void> }
    const config = ctx.agentTeam.config as unknown as { worker: { get(): { enabled: boolean } } }
    const originalWorker = config.worker
    testCleanups.push(() => { config.worker = originalWorker })
    const currentWorker = config.worker.get()
    config.worker = { get: () => ({ ...currentWorker, enabled: true }) }

    const running = waitForRunning(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold the first turn' }], source: { kind: 'user' } }))
    await running
    const applying = service.applyWorkerExposure(true)
    let scheduled = false
    const observe = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle' || scheduled) return
      scheduled = true
      setGrants(['t32_frozen_b'])
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start the frozen turn' }], source: { kind: 'user' } }))
      // The new turn has already frozen B at its turn/start. A delayed boundary
      // apply now reads C; it must not replace that turn's frozen list.
      setGrants(['t32_frozen_c'])
    })
    testCleanups.push(() => { observe() })

    adapter.enqueue(stopResponse('first turn complete'))
    adapter.enqueue(toolCallResponse('t32-frozen-b', 't32_frozen_b', {}))
    adapter.enqueue(stopResponse('second turn complete'))
    adapter.release()
    await vi.waitFor(() => {
      expect(scheduled).toBe(true)
      expect(adapter.requests).toHaveLength(4)
    })
    await applying

    const frozenTurnRequest = adapter.requests[2]
    expect(frozenTurnRequest?.tools?.map(tool => tool.name)).toContain('t32_frozen_b')
    expect(frozenTurnRequest?.tools?.map(tool => tool.name)).not.toContain('t32_frozen_c')
    expect(executedA).not.toHaveBeenCalled()
    expect(executedB).toHaveBeenCalledTimes(1)
    expect(executedC).not.toHaveBeenCalled()
  })

  it('does not let a delayed capability apply overwrite the grants frozen by a new turn', async () => {
    const adapter = new GatedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const executedA = vi.fn(async () => [{ type: 'text' as const, text: 'a' }])
    const executedB = vi.fn(async () => [{ type: 'text' as const, text: 'b' }])
    const executedC = vi.fn(async () => [{ type: 'text' as const, text: 'c' }])
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't34_edit_a', description: 'edit a', parameters: {}, execute: executedA,
    })))
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't34_edit_b', description: 'edit b', parameters: {}, execute: executedB,
    })))
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't34_edit_c', description: 'edit c', parameters: {}, execute: executedC,
    })))
    const setGrants = useExtraToolGrants(ctx, ['t34_edit_a'])
    const member = await addMember(ctx, workspaceId, 't34-edit-turn', { tools: { allow: ['ordinary_tool'] } })
    const agent = liveAgent(ctx, member)

    const running = waitForRunning(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hold the first turn' }], source: { kind: 'user' } }))
    await running
    const editing = ctx.agentTeam.updateMember({
      requestId: requestId('t34-edit'), memberId: member.memberId, handle: 't34-edit-turn',
      description: 'Policy member', capabilities: { tools: { allow: ['spare_tool'] } },
    })
    let scheduled = false
    const observe = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle' || scheduled) return
      scheduled = true
      setGrants(['t34_edit_b'])
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start the frozen turn' }], source: { kind: 'user' } }))
      // The capability apply may resume only after the new turn has frozen B.
      // Its delayed grant read C must not replace B in that turn.
      setGrants(['t34_edit_c'])
    })
    testCleanups.push(() => { observe() })

    adapter.enqueue(stopResponse('first turn complete'))
    adapter.enqueue(toolCallResponse('t34-edit-b', 't34_edit_b', {}))
    adapter.enqueue(stopResponse('second turn complete'))
    adapter.release()
    await vi.waitFor(() => {
      expect(scheduled).toBe(true)
      expect(adapter.requests).toHaveLength(4)
    })
    const settled = await editing

    const frozenTurnRequest = adapter.requests[2]
    expect(frozenTurnRequest?.tools?.map(tool => tool.name)).toContain('t34_edit_b')
    expect(frozenTurnRequest?.tools?.map(tool => tool.name)).not.toContain('t34_edit_c')
    expect(executedA).not.toHaveBeenCalled()
    expect(executedB).toHaveBeenCalledTimes(1)
    expect(executedC).not.toHaveBeenCalled()
    expect(settled.effect).toBe('applied')
    expect(settled.status.member.capabilities?.tools?.allow).toEqual(['spare_tool'])
  })

  it.each(['capability', 'worker'] as const)('releases a pending %s boundary apply when the Host shuts down', async (kind) => {
    const cleanups: Array<() => Promise<void>> = []
    testCleanups.push(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
    })
    const host = await buildSharedHarness(cleanups)
    const adapter = new GatedAdapter()
    testCleanups.push(host.ctx.llm.registerAdapter(['mock'], adapter))
    const member = await addMember(host.ctx, host.workspaceId, `t35-shutdown-${kind}`)
    const agent = liveAgent(host.ctx, member)
    const service = host.ctx.agentTeam as unknown as {
      applyWorkerExposure(enabled: boolean): Promise<void>
      memberRuntime: {
        turnWaitResolvers: Set<unknown>
        awaitTurnBoundary(active: unknown): Promise<string>
      }
    }
    const boundaries = vi.spyOn(service.memberRuntime, 'awaitTurnBoundary')
    const running = waitForRunning(host.ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'keep this request pending' }], source: { kind: 'user' } }))
    await running
    const applying = kind === 'worker'
      ? service.applyWorkerExposure(false)
      : host.ctx.agentTeam.updateMember({
        requestId: requestId('t35-shutdown-edit'), memberId: member.memberId,
        handle: `t35-shutdown-${kind}`, description: 'Changed while running', capabilities: { tools: { allow: ['spare_tool'] } },
      })
    let settled = false
    let failure: unknown
    const observed = applying.then(
      () => { settled = true },
      (error: unknown) => { failure = error; settled = true },
    )
    await vi.waitFor(() => expect(service.memberRuntime.turnWaitResolvers.size).toBe(1))
    const disposing = host.teamFiber.dispose()
    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 })
      expect(failure).toBeUndefined()
      expect(boundaries).toHaveBeenCalledTimes(1)
    } finally {
      adapter.release()
      await observed
      await disposing
      boundaries.mockRestore()
    }
  })

  it('keeps the selected registration’s when condition, Member identity, and step admission', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const activationAgents: Agent[] = []
    const body = vi.fn(async () => [{ type: 'text' as const, text: 'admitted' }])
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't25_conditioned', description: 'conditioned', parameters: {}, execute: body,
    }), {
      when: ({ agent }) => {
        activationAgents.push(agent)
        return true
      },
    }))
    const hiddenBody = vi.fn(async () => [{ type: 'text' as const, text: 'must not run' }])
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't25_hidden', description: 'hidden', parameters: {}, execute: hiddenBody,
    }), { when: () => false }))
    const guardedBody = vi.fn(async () => [{ type: 'text' as const, text: 'must not run' }])
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't25_pre_execute_denied', description: 'plugin guard', parameters: {}, execute: guardedBody,
    })))
    useExtraToolGrants(ctx, ['t25_conditioned', 't25_hidden', 't25_pre_execute_denied'])
    const member = await addMember(ctx, workspaceId, 't25-admission')
    const agent = liveAgent(ctx, member)
    const preExecuteDeny = ctx.on('tools/pre-execute', async (execution, next) => {
      if (execution.agent === agent && execution.name === 't25_pre_execute_denied') {
        return { kind: 'deny' as const, reason: 'plugin-owned execution guard' }
      }
      return next()
    })
    testCleanups.push(() => { preExecuteDeny() })

    adapter.enqueue(stopResponse('conditioned'))
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'prepare a step' }], source: { kind: 'user' } }))
    await idle
    const declared = adapter.requests.at(-1)?.tools?.map(tool => tool.name) ?? []
    expect(declared).toContain('t25_conditioned')
    expect(declared).toContain('t25_pre_execute_denied')
    expect(declared).not.toContain('t25_hidden')
    expect(activationAgents).toContain(agent)

    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'mock', model: 'mock' }, signal })
    testCleanups.push(() => { toolSet.dispose() })
    const admitted = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('t25-admitted'), name: 't25_conditioned', arguments: {}, agent, toolSet,
    })
    expect(admitted.isError).not.toBe(true)
    expect(body).toHaveBeenCalledTimes(1)
    let nested: Awaited<ReturnType<typeof executeToolFixture>> | undefined
    const nestedCall = ctx.on('tools/pre-execute', async (execution, next) => {
      if (execution.agent === agent && execution.name === 'ordinary_tool' && nested === undefined) {
        nested = await executeToolFixture(ctx, {
          signal, callId: ToolCallId('t25-nested'), name: 't25_conditioned', arguments: {}, agent,
          parent: execution.token, toolSet,
        })
      }
      return next()
    })
    testCleanups.push(() => { nestedCall() })
    const outer = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('t25-outer'), name: 'ordinary_tool', arguments: {}, agent, toolSet,
    })
    expect(outer.isError).not.toBe(true)
    expect(nested?.isError).not.toBe(true)
    expect(body).toHaveBeenCalledTimes(2)
    const hidden = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('t25-hidden'), name: 't25_hidden', arguments: {}, agent, toolSet,
    })
    expect(hidden.isError).toBe(true)
    expect(hiddenBody).not.toHaveBeenCalled()
    const guarded = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('t25-pre-execute'), name: 't25_pre_execute_denied', arguments: {}, agent, toolSet,
    })
    expect(guarded.isError).toBe(true)
    expect(guardedBody).not.toHaveBeenCalled()

    const ordinary = await ctx.agents.create({ sessionId: SessionId('t25-ordinary') })
    testCleanups.push(async () => { await ordinary.dispose() })
    const foreign = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('t25-foreign'), name: 't25_conditioned', arguments: {}, agent: ordinary.agent, toolSet,
    })
    expect(foreign.isError).toBe(true)
    expect(body).toHaveBeenCalledTimes(2)
  })

  it('keeps a nearer same-definition registration independent of a farther when:false', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const body = vi.fn(async () => [{ type: 'text' as const, text: 'near registration' }])
    const definition = defineContentToolFixture({
      name: 't25b_near_shadow', description: 'same definition near', parameters: {}, execute: body,
    })
    const far = ctx.tools.register(definition, { when: () => false })
    testCleanups.push(() => { far() })
    const setGrants = useExtraToolGrants(ctx, [])
    const member = await addMember(ctx, workspaceId, 't25b-shadow')
    const agent = liveAgent(ctx, member)
    const whenAgents: Agent[] = []
    const near = agent.ctx.tools.register(definition, {
      when: ({ agent: subject }) => {
        whenAgents.push(subject)
        return true
      },
    })
    testCleanups.push(() => { near() })
    setGrants(['t25b_near_shadow'])

    adapter.enqueue(stopResponse('near shadow'))
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the near registration' }], source: { kind: 'user' } }))
    await idle
    expect(adapter.requests.at(-1)?.tools?.map(tool => tool.name)).toContain('t25b_near_shadow')
    expect(whenAgents).toContain(agent)

    const signal = new AbortController().signal
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'mock', model: 'mock' }, signal })
    testCleanups.push(() => { toolSet.dispose() })
    const admitted = await executeModelToolFixture(ctx, {
      signal, callId: ToolCallId('t25b-near'), name: 't25b_near_shadow', arguments: {}, agent, toolSet,
    })
    expect(admitted.isError).not.toBe(true)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it.each(['same', 'different'] as const)(
    'invalidates step admission after a %s-object re-registration and admits the replacement next step',
    async kind => {
      const adapter = new ScriptedAdapter()
      useAdapter(adapter)
      const { ctx, workspaceId } = shared
      const calls: string[] = []
      const definition = defineContentToolFixture({
        name: 't26_replaceable', description: 'replaceable', parameters: {},
        execute: async () => {
          calls.push('definition')
          return [{ type: 'text', text: 'definition' }]
        },
      })
      let unregister = ctx.tools.register(definition)
      testCleanups.push(() => { unregister() })
      useExtraToolGrants(ctx, ['t26_replaceable'])
      const member = await addMember(ctx, workspaceId, `t26-${kind}`)
      const agent = liveAgent(ctx, member)

      adapter.enqueue(stopResponse('granted'))
      const idle = waitForIdle(ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'grant it' }], source: { kind: 'user' } }))
      await idle
      const signal = new AbortController().signal
      const staleSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'mock', model: 'mock' }, signal })
      testCleanups.push(() => { staleSet.dispose() })

      unregister()
      const replacement = kind === 'same' ? definition : defineContentToolFixture({
        name: 't26_replaceable', description: 'replacement', parameters: {},
        execute: async () => {
          calls.push('replacement')
          return [{ type: 'text', text: 'replacement' }]
        },
      })
      unregister = ctx.tools.register(replacement)
      const stale = await executeModelToolFixture(ctx, {
        signal, callId: ToolCallId(`t26-stale-${kind}`), name: 't26_replaceable', arguments: {}, agent, toolSet: staleSet,
      })
      expect(stale.isError).toBe(true)
      expect(calls).toEqual([])

      const freshSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'mock', model: 'mock' }, signal })
      testCleanups.push(() => { freshSet.dispose() })
      const fresh = await executeModelToolFixture(ctx, {
        signal, callId: ToolCallId(`t26-fresh-${kind}`), name: 't26_replaceable', arguments: {}, agent, toolSet: freshSet,
      })
      expect(fresh.isError).not.toBe(true)
      expect(calls).toEqual([kind === 'same' ? 'definition' : 'replacement'])
    },
  )

  it('materializes a selected name registered after turn start into the next step declaration', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const lateBody = vi.fn(async () => [{ type: 'text' as const, text: 'late executed' }])
    useExtraToolGrants(ctx, ['t27_late'])
    const member = await addMember(ctx, workspaceId, 't27-late-granted')
    const agent = liveAgent(ctx, member)
    const executed: string[] = []
    const observeExecution = agent.ctx.on('tools/pre-execute', async (execution, next) => {
      if (execution.agent === agent) executed.push(execution.name)
      return next()
    })
    testCleanups.push(() => { observeExecution() })
    let unregisterLate: (() => void) | undefined
    const observe = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'turn/start' || unregisterLate !== undefined) return
      unregisterLate = ctx.tools.register(defineContentToolFixture({
        name: 't27_late', description: 'late', parameters: {}, execute: lateBody,
      }))
    })
    testCleanups.push(() => {
      observe()
      unregisterLate?.()
    })

    adapter.enqueue(toolCallResponse('t27-first-step', 'ordinary_tool', {}))
    adapter.enqueue(toolCallResponse('t27-late-step', 't27_late', {}))
    adapter.enqueue(stopResponse('late complete'))
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run two steps' }], source: { kind: 'user' } }))
    await idle
    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).not.toContain('t27_late')
    expect(adapter.requests[1]?.tools?.map(tool => tool.name)).toContain('t27_late')
    expect(executed).toEqual(['ordinary_tool', 't27_late'])
    expect(lateBody).toHaveBeenCalledTimes(1)
  })

  it('tightens to the no-grant baseline when a grant install fails, then retries the saved grant next turn', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't28_fragile', description: 'fragile', parameters: {}, execute: async () => [{ type: 'text', text: 'ok' }],
    })))
    useExtraToolGrants(ctx, ['t28_fragile'])
    const member = await addMember(ctx, workspaceId, 't28-fallback')
    const agent = liveAgent(ctx, member)
    const originalRestrict = agent.ctx.tools.restrict.bind(agent.ctx.tools)
    const restrict = vi.spyOn(agent.ctx.tools, 'restrict').mockImplementation((filter) => {
      if (filter.allow?.includes('t28_fragile') === true) throw new Error('t28 grant install failed')
      return originalRestrict(filter)
    })

    adapter.enqueue(stopResponse('fallback baseline'))
    const fallbackIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'fallback' }], source: { kind: 'user' } }))
    await fallbackIdle
    expect(adapter.requests.at(-1)?.tools?.map(tool => tool.name)).not.toContain('t28_fragile')
    expect(toolNames(ctx, agent)).toEqual(expect.arrayContaining([...MEMBER_TOOL_NAMES, 'ordinary_tool']))
    restrict.mockRestore()

    adapter.enqueue(stopResponse('retry'))
    const retryIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'retry' }], source: { kind: 'user' } }))
    await retryIdle
    expect(adapter.requests.at(-1)?.tools?.map(tool => tool.name)).toContain('t28_fragile')
  })

  it('spends no model request when even the no-grant baseline cannot be established, then retries normally', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't29_retry', description: 'retry', parameters: {}, execute: async () => [{ type: 'text', text: 'ok' }],
    })))
    useExtraToolGrants(ctx, ['t29_retry'])
    const member = await addMember(ctx, workspaceId, 't29-zero-request')
    const agent = liveAgent(ctx, member)
    const restrict = vi.spyOn(agent.ctx.tools, 'restrict').mockImplementation(() => {
      throw new Error('t29 every restriction failed')
    })

    const blockedIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'must not reach the model' }], source: { kind: 'user' } }))
    await blockedIdle
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.ownEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.ownEvents().filter(event => event.type === 'step/start')).toHaveLength(0)

    restrict.mockRestore()
    adapter.enqueue(stopResponse('recovered'))
    const retryIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'retry normally' }], source: { kind: 'user' } }))
    await retryIdle
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('t29_retry')
  })

  it('refuses the step before a model request when its pre-step refresh cannot restore even the baseline', async () => {
    const adapter = new ScriptedAdapter()
    useAdapter(adapter)
    const { ctx, workspaceId } = shared
    const body = vi.fn(async () => [{ type: 'text' as const, text: 'must not execute' }])
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't33_refresh_fragile', description: 'fragile refresh', parameters: {}, execute: body,
    })))
    useExtraToolGrants(ctx, ['t33_refresh_fragile'])
    const member = await addMember(ctx, workspaceId, 't33-refresh-failure')
    const agent = liveAgent(ctx, member)
    const originalRestrict = agent.ctx.tools.restrict.bind(agent.ctx.tools)
    let restrictCalls = 0
    const restrict = vi.spyOn(agent.ctx.tools, 'restrict').mockImplementation(filter => {
      restrictCalls += 1
      if (restrictCalls === 1) return originalRestrict(filter)
      throw new Error('t33 refresh restriction failed')
    })

    try {
      adapter.enqueue(toolCallResponse('t33-model', 't33_refresh_fragile', {}))
      adapter.enqueue(stopResponse('must not reach the model'))
      const idle = waitForIdle(ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'refresh must fail closed' }], source: { kind: 'user' } }))
      await idle

      expect(restrictCalls).toBe(3)
      expect(adapter.requests).toHaveLength(0)
      expect(body).not.toHaveBeenCalled()
      expect(agent.session.ownEvents().filter(event => event.type === 'step/start')).toHaveLength(0)
      expect(agent.session.ownEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('blocked')
    } finally {
      restrict.mockRestore()
    }
  })

  it('lists exact grant candidates outside activated baselines and protected controls', async () => {
    const { ctx } = shared
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 'team_worker', description: 'not the Team switch', parameters: {}, execute: async () => [{ type: 'text', text: 'never' }],
    })))
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't30_catalogued', description: 'catalogued', parameters: {}, execute: async () => [{ type: 'text', text: 'ok' }],
    })))
    testCleanups.push(ctx.tools.register(defineContentToolFixture({
      name: 't30_not a grant name', description: 'registered with a space', parameters: {}, execute: async () => [{ type: 'text', text: 'never' }],
    })))
    const catalog = ctx.agentTeam.toolCatalogForClient({})
    expect(catalog.names).toContain('t30_catalogued')
    expect(catalog.names).toContain('t30_not a grant name')
    expect(catalog.names).not.toContain('ordinary_tool')
    expect(catalog.names).not.toContain('spare_tool')
    expect(catalog.names).not.toContain('team_worker')
    expect(catalog.names).not.toContain('working_directory')
    for (const name of AGENT_TEAM_TOOL_NAMES) expect(catalog.names).not.toContain(name)
    expect(catalog.names).toEqual([...catalog.names].sort())
  })
})

describe('a production plugin behind a profile grant', () => {
  it('resolves a production plugin’s relative target against the Member checkout', async () => {
    const cleanups: Array<() => Promise<void>> = []
    testCleanups.push(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
    })
    const host = await mountTeamMemberHost({
      cleanups,
      prepare: provideQuietTokenMeter,
      presetPlugins: [{ id: 'team-tools', name: pathToFileURL(join(import.meta.dirname, 'helpers', 'team-tools-fixture.mjs')).href }],
      workingDirectory: 'real',
    })
    const adapter = new ScriptedAdapter()
    const disposeAdapter = host.ctx.llm.registerAdapter(['mock'], adapter)
    testCleanups.push(() => { disposeAdapter() })
    const member = await addMember(host.ctx, host.workspaceId, 't31-production-plugin')
    const agent = liveAgent(host.ctx, member)
    // The plugin is a real production package, mounted globally after Member
    // activation: the next turn's grant has to expose the late registration.
    const plugin = await host.ctx.plugin(ToolFs, {
      read: false, readImage: false, write: true, edit: false, applyPatch: false,
    })
    testCleanups.push(async () => { await plugin.dispose() })
    useExtraToolGrants(host.ctx, ['write'])
    expect(host.ctx.agentTeam.toolCatalogForClient({}).names).toContain('write')

    const checkout = join(host.root, 'checkout')
    const target = 'pr83-production.txt'
    const callers: Agent[] = []
    const observe = host.ctx.on('tools/pre-execute', async (execution, next) => {
      if (execution.name === 'write') callers.push(execution.agent!)
      return next()
    })
    testCleanups.push(() => { observe() })
    adapter.enqueue(toolCallResponse('t31-create', 'write', {
      file_path: target,
      content: 'written through the production plugin\n',
    }))
    adapter.enqueue(stopResponse('created'))
    const idle = waitForIdle(host.ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'create the file' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toContain('write')
    expect(callers).toEqual([agent])
    expect(await realpath(host.ctx.workingDirectory.get(agent.session)!)).toBe(await realpath(checkout))
    expect(await readFile(join(checkout, target), 'utf8')).toBe('written through the production plugin\n')
    // This certifies one named production package, not the unknown plugin that
    // originally motivated issue #82.
    expect(String(ToolFs.name)).toBe('tool-fs')
  })
})

describe('Worker exposure at a pending turn boundary', () => {
  it('reads a capability edit accepted while the switch was waiting', async () => {
    const cleanups: Array<() => Promise<void>> = []
    testCleanups.push(async () => { for (const cleanup of cleanups) await cleanup() })
    const { ctx, workspaceId } = await mountTeamMemberHost({
      cleanups, prepare: provideQuietTokenMeter,
      presetPlugins: [{ id: 'team-tools', name: pathToFileURL(join(import.meta.dirname, 'helpers', 'team-tools-fixture.mjs')).href }],
    })
    const disposeAdapter = ctx.llm.registerAdapter(['mock'], new EmptyAdapter())
    testCleanups.push(() => { disposeAdapter() })
    const member = await addMember(ctx, workspaceId, 't22-worker-switch-edit')
    const agent = liveAgent(ctx, member)
    const service = ctx.agentTeam as unknown as {
      readonly memberRuntime: { awaitTurnBoundary(handle: unknown): Promise<'waited'> }
      readonly handles: Map<AgentTeamMemberId, { agent: Agent }>
      readonly ledger: { updateMember(request: unknown): Promise<unknown> }
      applyWorkerExposure(enabled: boolean): Promise<void>
    }
    const config = ctx.agentTeam.config as unknown as { worker: { get(): { enabled: boolean } } }
    const current = config.worker.get()
    config.worker = { get: () => ({ ...current, enabled: true }) }
    const gate = Promise.withResolvers<void>()
    const wait = vi.spyOn(service.memberRuntime, 'awaitTurnBoundary').mockImplementation(async () => {
      await gate.promise
      return 'waited'
    })
    const applying = service.applyWorkerExposure(true)

    // Commit through the ledger itself: updateMember must also wait on a running
    // Member, so mocking its boundary wait would deadlock this arrangement.
    await service.ledger.updateMember({
      requestId: requestId('t22-narrow'), memberId: member.memberId, handle: 't22-worker-switch-edit',
      description: 'Policy member', capabilities: { tools: { allow: ['ordinary_tool'] } },
      actor: agentTeamHumanActor(),
    })
    gate.resolve()
    await applying
    wait.mockRestore()

    // The switch started with unrestricted intent, but it must apply the edit
    // accepted during its wait rather than restoring the pre-wait tool list.
    expect(toolNames(ctx, agent)).toContain('team_worker')
    expect(toolNames(ctx, agent)).not.toContain('spare_tool')
    ctx.agentTeam.validateLedger()
  })
})
