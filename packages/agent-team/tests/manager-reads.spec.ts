import { sep } from 'node:path'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import type { AgentTeamProjectRef } from '../src/types/entities.ts'
import { renderText, teamTools } from '../../tool-agent-team/tests/render-text.ts'
import { realHarness, requestId } from './helpers/member-harness.ts'

/** The live manager Agent for one Host. */
async function openManager(ctx: Context): Promise<Agent> {
  const opened = await ctx.agentTeam.openManagerSession({})
  if (opened.status !== 'ready') throw new Error(`expected a ready manager Session, received '${opened.status}'`)
  const agent = ctx.agents.get(opened.sessionId)
  if (agent === undefined) throw new Error('expected the manager Agent to be registered')
  return agent
}

function memberAgent(ctx: Context, sessionId: SessionId): Agent {
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('expected the Member Agent to be registered')
  return agent
}

/** One Task Thread, started as the Human, with the revision a later mutation needs. */
async function startTask(ctx: Context, workspaceId: WorkspaceId, projectRef: string, body: string, requestIdValue: string) {
  const started = await ctx.agentTeam.startThread({
    requestId: requestId(requestIdValue), workspaceId, projectRef: projectRef as never, kind: 'task', body,
  })
  if (started.kind !== 'committed' || started.task === undefined) throw new Error(`expected a committed Task, received '${started.kind}'`)
  const read = await ctx.agentTeam.readThread({ requestId: requestId(`${requestIdValue}-read`), workspaceId, taskRef: started.task.taskRef })
  return { taskRef: started.task.taskRef, revision: read.thread.revision }
}

describe('Team manager read-only Team surface', () => {
  it('reads the whole Team for the manager: Workspaces, Projects, owners, Members and switches', async () => {
    const { ctx, workspaceId } = await realHarness()
    const manager = await openManager(ctx)
    const project = await ctx.agentTeam.createProject({
      requestId: requestId('read-project'), workspaceId, name: 'Alignment', description: '对齐讨论与任务拆解',
    })
    const projectRef = project.project.projectRef
    const member = await ctx.agentTeam.addMember({
      requestId: requestId('read-member'), workspaceId, handle: 'iris', description: '对齐讨论',
      presetId: 'team-member', projectRefs: [projectRef], model: { provider: 'mock', model: 'mock' },
    })
    await ctx.agentTeam.addProjectOwner({
      requestId: requestId('read-owner'), workspaceId, projectRef, memberId: member.status.member.memberId,
      responsibility: '对齐讨论与任务拆解',
    })
    await startTask(ctx, workspaceId, projectRef, '推进 03', 'read-task-open')
    const reported = await startTask(ctx, workspaceId, projectRef, '核验 02', 'read-task-reported')
    const agent = memberAgent(ctx, member.status.member.sessionId)
    const claim = await ctx.agentTeam.changeClaimForAgent(agent, {
      requestId: requestId('read-claim'), workspaceId, taskRef: reported.taskRef, action: 'claim',
      baseRevision: reported.revision, direction: '核验 02',
    })
    if (claim.kind !== 'committed') throw new Error(`expected a committed claim, received '${claim.kind}'`)
    const claimed = await ctx.agentTeam.readThread({ requestId: requestId('read-claim-read'), workspaceId, taskRef: reported.taskRef })
    const done = await ctx.agentTeam.changeClaimForAgent(agent, {
      requestId: requestId('read-done'), workspaceId, taskRef: reported.taskRef, action: 'done',
      claimRef: claim.claim.claimRef, baseRevision: claimed.thread.revision,
    })
    if (done.kind !== 'committed') throw new Error(`expected a committed done, received '${done.kind}'`)

    const overview = ctx.agentTeam.managerOverviewForAgent(manager, {})
    expect(overview.workspaces).toHaveLength(1)
    expect(overview.workspaces[0]).toMatchObject({ workspaceId, projectCount: 1, memberCount: 1 })
    expect(overview.projects).toHaveLength(1)
    expect(overview.projects[0]).toMatchObject({
      workspaceId, projectRef, name: 'Alignment', state: 'active', board: { open: 2, inReview: 1 },
      subscriptions: { active: 0, paused: 0 },
    })
    expect(overview.projects[0]!.owners).toEqual([{
      memberRef: member.status.member.memberId, handle: 'iris', responsibility: '对齐讨论与任务拆解',
    }])
    expect(overview.members).toHaveLength(1)
    expect(overview.members[0]).toMatchObject({ handle: 'iris', availability: 'active', presence: 'working' })
    expect(overview.members[0]!.workspaceIds).toEqual([workspaceId])
    expect(overview.members[0]!.owns).toEqual([{
      project: { projectRef, workspaceId, name: 'Alignment', description: '对齐讨论与任务拆解', createdAtSequence: expect.any(Number), state: 'active' },
      responsibility: '对齐讨论与任务拆解',
    }])
    expect(overview.switches).toEqual({ worker: false })
    expect(overview.truncated).toEqual({ workspaces: false, projects: false, members: false })
    // The read carries no message body, Thread fact, credential or private
    // file content: the directory, standing and switches a decision needs.
    expect(Object.keys(overview).sort()).toEqual(['members', 'projects', 'switches', 'truncated', 'workspaces'])
    expect(Object.keys(overview.members[0]!).sort()).not.toContain('privateMemoryPath')
  })

  it('reports a Project with only the Human as owner and an owner grant with no responsibility', async () => {
    const { ctx, workspaceId } = await realHarness()
    const manager = await openManager(ctx)
    const project = await ctx.agentTeam.createProject({
      requestId: requestId('read-human-project'), workspaceId, name: 'Unowned', description: '',
    })
    const member = await ctx.agentTeam.addMember({
      requestId: requestId('read-human-member'), workspaceId, handle: 'vera', description: '独立验收',
      presetId: 'team-member', projectRefs: [], model: { provider: 'mock', model: 'mock' },
    })
    await ctx.agentTeam.addProjectOwner({
      requestId: requestId('read-human-owner'), workspaceId, projectRef: project.project.projectRef, memberId: member.status.member.memberId,
    })

    const overview = ctx.agentTeam.managerOverviewForAgent(manager, { projectRef: project.project.projectRef })
    expect(overview.projects).toHaveLength(1)
    // An owner grant with no recorded responsibility is a fact about the grant,
    // never a defect to repair: the field is absent rather than invented.
    expect(overview.projects[0]!.owners).toEqual([{ memberRef: member.status.member.memberId, handle: 'vera' }])
    const rendered = renderText(teamTools().get('team_overview')!, {}, overview)
    expect(rendered).toContain('owners @vera (unspecified)')

    const empty = await ctx.agentTeam.createProject({
      requestId: requestId('read-empty-project'), workspaceId, name: 'Human only', description: '',
    })
    const humanOnly = ctx.agentTeam.managerOverviewForAgent(manager, { projectRef: empty.project.projectRef })
    expect(humanOnly.projects[0]!.owners).toEqual([])
    expect(renderText(teamTools().get('team_overview')!, {}, humanOnly)).toContain('owners: the Human only')
  })

  it('locates one Member Session for the manager and renders the reader that inspects it', async () => {
    const { ctx, root, workspaceId } = await realHarness()
    const manager = await openManager(ctx)
    const member = await ctx.agentTeam.addMember({
      requestId: requestId('read-evidence-member'), workspaceId, handle: 'vera', description: '独立验收',
      presetId: 'team-member', projectRefs: [], model: { provider: 'mock', model: 'mock' },
    })
    const memberRef = member.status.member.memberId
    const sessionId = member.status.member.sessionId

    // A live Session that has not flushed has no durable log yet: the locator
    // must say so instead of letting the manager read "no work" into it.
    const pending = await ctx.agentTeam.managerSessionLocatorForAgent(manager, memberRef)
    expect(pending).toMatchObject({ memberRef, handle: 'vera', sessionId, state: 'pending' })
    expect(pending.location).toBeUndefined()
    expect(pending.reader.script.endsWith(`${sep}manager-session-evidence${sep}scripts${sep}session-evidence.mjs`)).toBe(true)

    await ctx.sessionPersistence.flush()
    const stored = await ctx.agentTeam.managerSessionLocatorForAgent(manager, memberRef)
    expect(stored).toMatchObject({ sessionId, state: 'stored', location: { kind: 'jsonl' } })
    expect(stored.location!.path.startsWith(join(root, 'sessions'))).toBe(true)

    // The model-facing contract is the tool result, not the Host method: the
    // locator has to survive the schema and the render to be usable.
    const executed = await executeToolFixture(ctx, {
      signal: new AbortController().signal, agent: manager, name: 'team_overview',
      callId: ToolCallId('read-evidence-overview'), arguments: { memberRef },
    })
    expect(executed.isError).toBe(false)
    if (executed.isError) throw executed.error
    const value = executed.value as { member?: { sessionEvidence?: Record<string, unknown> } }
    expect(value.member?.sessionEvidence).toMatchObject({
      sessionId, state: 'stored', location: { kind: 'jsonl', path: stored.location!.path },
      reader: { script: stored.reader.script },
    })
    const rendered = renderText(teamTools().get('team_overview')!, { memberRef }, value)
    expect(rendered).toContain(`Session evidence: session ${sessionId} · stored`)
    expect(rendered).toContain(stored.location!.path)
    expect(rendered).toContain('never open it directly')
    expect(rendered).toContain(`Reader: node ${stored.reader.script}`)
    expect(rendered).toContain('manager-session-evidence')

    // Only the live manager may ask: a Member's own Session cannot address
    // another Member's log through this seam.
    const memberSession = memberAgent(ctx, sessionId)
    await expect(ctx.agentTeam.managerSessionLocatorForAgent(memberSession, memberRef))
      .rejects.toThrow(/live Team manager Session/)
  })

  it('refuses an unknown Project ref instead of answering empty', async () => {
    const { ctx, workspaceId } = await realHarness()
    const manager = await openManager(ctx)
    const project = await ctx.agentTeam.createProject({
      requestId: requestId('read-unknown-project'), workspaceId, name: 'Known', description: '',
    })
    expect(() => ctx.agentTeam.managerOverviewForAgent(manager, {
      projectRef: 'project:deadbeef' as AgentTeamProjectRef,
    })).toThrow(/unknown Project ref/)
    // A ref that resolves still narrows to it; only an unresolvable ref is
    // refused, so an honest empty answer is never confused with a typo.
    expect(ctx.agentTeam.managerOverviewForAgent(manager, {
      projectRef: project.project.projectRef,
    }).projects).toHaveLength(1)
  })

  it('refuses every Session that is not the live manager, including a replaced or archived one', async () => {
    const { ctx, workspaceId, checkout } = await realHarness()
    const manager = await openManager(ctx)
    const member = await ctx.agentTeam.addMember({
      requestId: requestId('read-refuse-member'), workspaceId, handle: 'tars', description: '实现',
      presetId: 'team-member', projectRefs: [], model: { provider: 'mock', model: 'mock' },
    })
    const ordinary = await ctx.agents.create({
      sessionId: SessionId('session-read-refuse-ordinary'),
      meta: { cwd: checkout, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    // A foreign Session that merely names the manager preset is not the manager:
    // authorization is the live Agent the runtime owns, not the composition id.
    const foreign = await ctx.agents.create({
      sessionId: SessionId('session-read-refuse-foreign'),
      meta: { cwd: checkout, agentPreset: 'team-manager' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    onTestFinished(async () => { await ordinary.dispose(); await foreign.dispose() })
    const refusal = 'team manager tool requires the live Team manager Session'

    for (const [label, agent] of [
      ['a Member', memberAgent(ctx, member.status.member.sessionId)],
      ['an ordinary Session', ordinary.agent],
      ['a Session that only names the manager preset', foreign.agent],
    ] as const) {
      expect(() => ctx.agentTeam.managerOverviewForAgent(agent, {}), label).toThrow(refusal)
    }

    await ctx.workspaceRegistry.archiveSession(manager.id, { stopActivity: true })
    expect(() => ctx.agentTeam.managerOverviewForAgent(manager, {})).toThrow(refusal)
    // A replaced generation still satisfies `ownsSession`, so lineage cannot
    // authorize the read: only the current Agent can.
    const replaced = await ctx.agentTeam.newManagerSession({ expectedSessionId: manager.id })
    if (replaced.status !== 'ready') throw new Error(`expected a ready replacement, received '${replaced.status}'`)
    expect(() => ctx.agentTeam.managerOverviewForAgent(manager, {})).toThrow(refusal)
    expect(() => ctx.agentTeam.managerOverviewForAgent(ctx.agents.get(replaced.sessionId)!, {})).not.toThrow()
  })

  it('refuses an unknown Workspace and an out-of-range limit instead of answering empty', async () => {
    const { ctx, workspaceId } = await realHarness()
    const manager = await openManager(ctx)
    const unknown = WorkspaceId('workspace:not-in-the-directory')
    expect(() => ctx.agentTeam.managerOverviewForAgent(manager, { workspaceId: unknown }))
      .toThrow(`unknown Workspace '${unknown}'`)
    for (const limit of [0, -1, 1.5, 101]) {
      expect(() => ctx.agentTeam.managerOverviewForAgent(manager, { limit }))
        .toThrow('overview limit must be an integer between 1 and 100')
    }
    // A narrow scope is a real answer, not a truncation.
    const scoped = ctx.agentTeam.managerOverviewForAgent(manager, { workspaceId, limit: 100 })
    expect(scoped.truncated).toEqual({ workspaces: false, projects: false, members: false })
    expect(scoped.workspaces).toHaveLength(1)
  })

  it('answers an empty Team as empty rather than as a failure', async () => {
    const { ctx, workspaces } = await realHarness()
    const manager = await openManager(ctx)
    workspaces.clear()
    const empty = ctx.agentTeam.managerOverviewForAgent(manager, {})
    expect(empty.workspaces).toEqual([])
    expect(empty.projects).toEqual([])
    expect(empty.members).toEqual([])
    expect(empty.truncated).toEqual({ workspaces: false, projects: false, members: false })
    // An empty answer and a directory that could not be read are different
    // results, so a manager never reads a failure as "the Team is empty".
    expect(renderText(teamTools().get('team_overview')!, {}, empty)).toContain('No Workspaces in the Host directory.')
  })

  it('reports the same handle in two Workspaces as two Members and truncates each collection by limit', async () => {
    const { ctx, workspaceId, workspaces } = await realHarness()
    const manager = await openManager(ctx)
    const beta = WorkspaceId('workspace:read-beta')
    workspaces.set(beta, { id: beta, path: '/tmp/read-beta-checkout', attachSession: async () => {} })
    await ctx.agentTeam.createProject({
      requestId: requestId('read-dup-project'), workspaceId, name: 'Shared', description: '两个 Workspace 同名成员',
    })
    await ctx.agentTeam.createProject({
      requestId: requestId('read-dup-project-beta'), workspaceId: beta, name: 'Beta only', description: '只在第二个 Workspace',
    })
    for (const [suffix, target] of [['alpha', workspaceId], ['beta', beta]] as const) {
      await ctx.agentTeam.addMember({
        requestId: requestId(`read-dup-${suffix}`), workspaceId: target, handle: 'iris', description: '同名不同人',
        presetId: 'team-member', projectRefs: [], model: { provider: 'mock', model: 'mock' },
      })
    }

    const overview = ctx.agentTeam.managerOverviewForAgent(manager, {})
    expect(overview.workspaces).toHaveLength(2)
    expect(overview.projects).toHaveLength(2)
    expect(overview.members.map(member => member.handle)).toEqual(['iris', 'iris'])
    // The same handle in two Workspaces is two Members, so a ref — not a
    // handle — is what addresses one.
    expect(new Set(overview.members.map(member => member.memberRef)).size).toBe(2)
    expect(overview.members.map(member => member.workspaceIds[0]!).sort()).toEqual([beta, workspaceId].sort())

    const cut = ctx.agentTeam.managerOverviewForAgent(manager, { limit: 1 })
    expect(cut.members).toHaveLength(1)
    expect(cut.workspaces).toHaveLength(1)
    expect(cut.truncated).toEqual({ workspaces: true, projects: true, members: true })
    expect(renderText(teamTools().get('team_overview')!, {}, cut)).toContain('Truncated: Workspaces, Projects, Members')
  })

  it('reads the model catalog from the Session controller and never offers the manager preset', async () => {
    const { ctx } = await realHarness()
    const manager = await openManager(ctx)
    ctx.provide('sessionController', {
      modelCatalog: async () => ({
        default: { provider: 'mock', model: 'mock' },
        routableProviders: ['mock'],
        groups: [{ id: 'mock', name: 'Mock', models: [{ id: 'mock', name: 'Mock', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }] }],
        failures: [{ id: 'broken', name: 'Broken', message: 'catalog lookup failed' }],
      }),
    })

    const models = await ctx.agentTeam.managerModelsForAgent(manager)
    expect(models.catalog.default).toEqual({ provider: 'mock', model: 'mock' })
    expect(models.catalog.groups[0]!.models[0]!.reasoning?.efforts).toEqual([{ id: 'low', name: 'Low' }])
    // A failed provider is reported as a failure and never folded into an
    // empty catalog a manager would read as "no models".
    expect(models.catalog.failures).toEqual([{ id: 'broken', name: 'Broken', message: 'catalog lookup failed' }])
    expect(models.memberPresets).toEqual(['team-member'])
  })

  it('executes both read tools through the manager Session and refuses them for any other Session', async () => {
    const { ctx, workspaceId, checkout } = await realHarness()
    ctx.provide('sessionController', {
      modelCatalog: async () => ({
        default: { provider: 'mock', model: 'mock' },
        routableProviders: ['mock'],
        groups: [{ id: 'mock', name: 'Mock', models: [{ id: 'mock', name: 'Mock', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }] }],
        failures: [{ id: 'broken', name: 'Broken', message: 'catalog lookup failed' }],
      }),
    })
    const manager = await openManager(ctx)
    const project = await ctx.agentTeam.createProject({
      requestId: requestId('read-tool-project'), workspaceId, name: 'Reads', description: '只读面',
    })
    const overview = await executeToolFixture(ctx, {
      signal: new AbortController().signal, agent: manager, name: 'team_overview',
      callId: ToolCallId('read-tool-overview'), arguments: {},
    })
    expect(overview.isError).toBe(false)
    const models = await executeToolFixture(ctx, {
      signal: new AbortController().signal, agent: manager, name: 'team_models',
      callId: ToolCallId('read-tool-models'), arguments: {},
    })
    expect(models.isError).toBe(false)
    if (overview.isError || models.isError) return
    const overviewText = (overview.content[0] as { text: string }).text
    const modelsText = (models.content[0] as { text: string }).text
    expect(overviewText).toContain('Team overview')
    expect(overviewText).toContain('Reads')
    expect(overviewText).toContain('Creating a Member, a Project, or an owner grant rides member_create, project_create and project_owner')
    // The manager's own preset is never a Member option, and a failed provider
    // is a failure rather than an empty list.
    expect(modelsText).toContain('Default: mock/mock')
    expect(modelsText).toContain('efforts low')
    expect(modelsText).toContain('catalog lookup failed')
    expect(modelsText).toContain('Member presets: team-member')
    expect(modelsText).not.toContain('team-manager')

    // The handler's own authorization, exercised on a Session that holds the
    // tool: an ordinary Session with the definition registered into its own
    // scope reaches the handler, and the handler refuses it.
    const ordinary = await ctx.agents.create({
      sessionId: SessionId('session-read-tool-ordinary'),
      meta: { cwd: checkout, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    onTestFinished(async () => { await ordinary.dispose() })
    ordinary.agent.ctx.tools.register(teamTools().get('team_overview')!)
    const refused = await executeToolFixture(ctx, {
      signal: new AbortController().signal, agent: ordinary.agent, name: 'team_overview',
      callId: ToolCallId('read-tool-refused'), arguments: {},
    })
    expect(refused.isError).toBe(true)
    if (refused.isError) expect(refused.error.message).toContain('team manager tool requires the live Team manager Session')

    // A Member never holds the tools at all: the member preset declares the
    // ten Member tools and neither the read nor the write surface.
    const member = await ctx.agentTeam.addMember({
      requestId: requestId('read-tool-member'), workspaceId, handle: 'no-reads', description: '无只读面',
      presetId: 'team-member', projectRefs: [project.project.projectRef], model: { provider: 'mock', model: 'mock' },
    })
    const memberAgent = ctx.agents.get(member.status.member.sessionId)!
    const memberTools = ctx.tools.schemas(memberAgent as never).map(schema => schema.name)
    for (const absent of ['team_overview', 'team_models', 'member_create', 'project_create', 'project_owner']) {
      expect(memberTools).not.toContain(absent)
    }
  })
})
