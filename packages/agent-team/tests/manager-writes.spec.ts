import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { renderText, teamTools } from '../../tool-agent-team/tests/render-text.ts'
import { realHarness, requestId } from './helpers/member-harness.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/index.ts'
import type { AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamOperationReceipt, AgentTeamProjectRef } from '../src/types.ts'


/** The live manager Agent for one Host. */
async function openManager(ctx: Context): Promise<Agent> {
  const opened = await ctx.agentTeam.openManagerSession({})
  if (opened.status !== 'ready') throw new Error(`expected a ready manager Session, received '${opened.status}': ${JSON.stringify(opened.status === 'unavailable' ? opened.diagnostic : opened)}`)
  const agent = ctx.agents.get(opened.sessionId)
  if (agent === undefined) throw new Error('expected the manager Agent to be registered')
  return agent
}

/** The one catalog the manager's writes are validated against, with a provider whose lookup failed. */
function provideModelCatalog(ctx: Context): void {
  ctx.provide('sessionController', {
    modelCatalog: async () => ({
      default: { provider: 'mock', model: 'mock' },
      routableProviders: ['mock'],
      groups: [{ id: 'mock', name: 'Mock', models: [{ id: 'mock', name: 'Mock', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }] }],
      failures: [{ id: 'broken', name: 'Broken', message: 'catalog lookup failed' }],
    }),
  })
}

const mockRoute = { provider: 'mock', model: 'mock' }

/** Run one manager write tool as the manager Session. */
function runTool(ctx: Context, agent: Agent, name: string, callId: string, args: Record<string, unknown>) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal, agent, name,
    callId: ToolCallId(callId), arguments: args,
  })
}

describe('Team manager write path', () => {
  it('creates a Member, a Project and an owner grant through the same Host path the Web Client uses', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)

    const created = await runTool(ctx, manager, 'member_create', 'write-member', {
      workspaceId, handle: 'tome', description: '长期负责交付质量', model: mockRoute,
      requestId: 'write-member-1',
    })
    expect(created.isError).toBe(false)
    if (created.isError) return
    const memberResult = created.value as { memberRef: string; receipt: { operationId: string }; status: { availability: string } }
    expect(memberResult.status.availability).toBe('active')
    expect(memberResult.memberRef.startsWith('member:')).toBe(true)
    expect(renderText(teamTools().get('member_create')!, {}, created.value)).toContain('Member created')

    // The record is the ordinary one: the Web Client projection carries it.
    const listed = ctx.agentTeam.membersForClient({}).map(entry => entry.member)
    expect(listed.some(member => member.memberId === memberResult.memberRef && member.handle === 'tome')).toBe(true)

    const project = await runTool(ctx, manager, 'project_create', 'write-project', {
      workspaceId, name: 'Delivery', description: '长期交付质量与节奏',
      requestId: 'write-project-1',
    })
    expect(project.isError).toBe(false)
    if (project.isError) return
    const projectResult = project.value as { projectRef: string }
    expect(projectResult.projectRef.startsWith('project:')).toBe(true)

    const granted = await runTool(ctx, manager, 'project_owner', 'write-owner', {
      action: 'add', workspaceId, projectRef: projectResult.projectRef, memberRef: memberResult.memberRef,
      responsibility: '对交付质量与评审纪律负责', requestId: 'write-owner-1',
    })
    expect(granted.isError).toBe(false)
    if (granted.isError) return
    const ownerResult = granted.value as { responsibility: string }
    expect(ownerResult.responsibility).toBe('对交付质量与评审纪律负责')
    expect(renderText(teamTools().get('project_owner')!, {}, granted.value)).toContain('Owner granted')

    // The grant is the ordinary ledger fact: the Member projection reports it.
    const overview = await runTool(ctx, manager, 'team_overview', 'write-overview', { memberRef: memberResult.memberRef })
    expect(overview.isError).toBe(false)
    if (overview.isError) return
    expect((overview.value as { member: { owns: { projectRef: string; responsibility?: string }[] } }).member.owns)
      .toEqual([{ projectRef: projectResult.projectRef, name: 'Delivery', description: '长期交付质量与节奏', state: 'active', responsibility: '对交付质量与评审纪律负责' }])
  })

  it('refuses the manager-layer standing rules before any ledger write', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)

    const blankDescription = await runTool(ctx, manager, 'member_create', 'write-blank-description', {
      workspaceId, handle: 'blank', description: '   ', model: mockRoute,
    })
    expect(blankDescription.isError).toBe(true)
    if (blankDescription.isError) expect(blankDescription.error.message).toContain('needs a description of its standing')

    const blankGoal = await runTool(ctx, manager, 'project_create', 'write-blank-goal', {
      workspaceId, name: 'No goal', description: '',
    })
    expect(blankGoal.isError).toBe(true)
    if (blankGoal.isError) expect(blankGoal.error.message).toContain('shared goal')

    const blankResponsibility = await runTool(ctx, manager, 'project_owner', 'write-blank-responsibility', {
      action: 'add', workspaceId, projectRef: 'project:missing', memberRef: 'member:missing', responsibility: ' ',
    })
    expect(blankResponsibility.isError).toBe(true)
    if (blankResponsibility.isError) expect(blankResponsibility.error.message).toContain('responsibility it answers for')

    // Nothing reached the ledger: the Team is exactly as empty as it was.
    expect(ctx.agentTeam.membersForClient({})).toEqual([])
  })

  it('validates the model route against the catalog after the idempotency answer, with each failure named', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)

    const cases: Array<{ readonly name: string; readonly model: Record<string, unknown>; readonly reason: string }> = [
      { name: 'unknown provider', model: { provider: 'nope', model: 'mock' }, reason: 'is not in the model catalog' },
      { name: 'unknown model', model: { provider: 'mock', model: 'ghost' }, reason: 'is not offered by provider' },
      { name: 'invalid effort', model: { provider: 'mock', model: 'mock', reasoningEffort: 'high' }, reason: 'is not supported by' },
      { name: 'unreadable catalog', model: { provider: 'broken', model: 'mock' }, reason: "the model catalog for provider 'broken' could not be read: catalog lookup failed" },
    ]
    for (const [index, testCase] of cases.entries()) {
      const refused = await runTool(ctx, manager, 'member_create', `write-model-${index}`, {
        workspaceId, handle: `route-${index}`, description: '路线校验', model: testCase.model,
      })
      expect(refused.isError, testCase.name).toBe(true)
      if (refused.isError) expect(refused.error.message, testCase.name).toContain(testCase.reason)
    }
    // Every refusal happened before the append, so no Member row exists.
    expect(ctx.agentTeam.membersForClient({})).toEqual([])
  })

  it.each([
    { label: 'an empty update name', fields: { action: 'update', name: '  ' }, reason: 'needs a non-empty name' },
    { label: 'an update without fields', fields: { action: 'update' }, reason: 'needs a name or a description to change' },
    { label: 'an archive with a name', fields: { action: 'archive', name: 'Renamed' }, reason: 'archives a Project by ref alone' },
    { label: 'an archive with a description', fields: { action: 'archive', description: 'Changed goal' }, reason: 'archives a Project by ref alone' },
  ] as const)('refuses project_update with $label without writing', async ({ fields, reason }) => {
    const { ctx, workspaceId } = await realHarness()
    const manager = await openManager(ctx)
    const created = await ctx.agentTeam.managerCreateProjectForAgent(manager, {
      requestId: requestId('validation-project'), workspaceId, name: 'Original', description: 'Original goal',
    })
    const ledger = ctx.agentTeam['ledger']!
    const before = ctx.agentTeam.status().sequence
    const project = ledger.getProject(created.projectRef)
    const id = requestId('invalid-project-update')

    await expect(ctx.agentTeam.managerUpdateProjectForAgent(manager, {
      requestId: id, workspaceId, projectRef: created.projectRef, ...fields,
    })).rejects.toThrow(reason)

    expect(ledger.hasCommitted(id)).toBe(false)
    expect(ctx.agentTeam.status().sequence).toBe(before)
    expect(ledger.getProject(created.projectRef)).toEqual(project)
  })

  it.each(['non-manager', 'replaced manager'] as const)('checks authorization before validation for every write from a %s', async kind => {
    const { ctx, workspaceId, checkout } = await realHarness()
    const manager = await openManager(ctx)
    let caller = manager
    if (kind === 'non-manager') {
      const ordinary = await ctx.agents.create({ sessionId: SessionId('session-auth-first'),
        meta: { cwd: checkout, agentPreset: 'standard' }, agentOptions: mockRoute })
      onTestFinished(async () => { await ordinary.dispose() })
      caller = ordinary.agent
    } else {
      const replaced = await ctx.agentTeam.newManagerSession({ expectedSessionId: manager.id })
      expect(replaced.status).toBe('ready')
    }
    const memberRef = 'member:missing' as AgentTeamMemberId
    const projectRef = 'project:missing' as AgentTeamProjectRef
    const calls = [
      (id: ReturnType<typeof requestId>) => ctx.agentTeam.managerCreateMemberForAgent(caller, {
        requestId: id, workspaceId, handle: 'invalid', description: ' ', model: mockRoute,
      }),
      (id: ReturnType<typeof requestId>) => ctx.agentTeam.managerCreateProjectForAgent(caller, {
        requestId: id, workspaceId, name: 'Invalid', description: ' ',
      }),
      (id: ReturnType<typeof requestId>) => ctx.agentTeam.managerChangeProjectOwnerForAgent(caller, {
        requestId: id, workspaceId, projectRef, memberRef, action: 'add', responsibility: ' ',
      }),
      (id: ReturnType<typeof requestId>) => ctx.agentTeam.managerUpdateProjectForAgent(caller, {
        requestId: id, workspaceId, projectRef, action: 'update', name: ' ',
      }),
      (id: ReturnType<typeof requestId>) => ctx.agentTeam.managerUpdateMemberForAgent(caller, {
        requestId: id, memberRef, description: ' ',
      }),
      (id: ReturnType<typeof requestId>) => ctx.agentTeam.managerSetMemberStateForAgent(caller, {
        requestId: id, memberRef, action: 'recover',
      }),
      (id: ReturnType<typeof requestId>) => ctx.agentTeam.managerChangeMemberWorkspaceForAgent(caller, {
        requestId: id, workspaceId: WorkspaceId('workspace:missing'), memberRef, action: 'join',
      }),
    ]
    const before = ctx.agentTeam.status().sequence
    for (const [index, call] of calls.entries()) {
      const id = requestId(`auth-first-${index}`)
      await expect(call(id)).rejects.toThrow('team manager tool requires the live Team manager Session')
      expect(ctx.agentTeam['ledger']!.hasCommitted(id)).toBe(false)
    }
    expect(ctx.agentTeam.status().sequence).toBe(before)
    expect(ctx.agentTeam.membersForClient({})).toEqual([])
  })

  it('answers the original receipt after a post-commit projection throws and never appends it twice', async () => {
    const { ctx, workspaceId } = await realHarness()
    const manager = await openManager(ctx)
    const ledger = ctx.agentTeam['ledger']!
    const request = { requestId: requestId('effect-throws'), workspaceId, name: 'Once', description: 'One durable Project' }
    const receipts: AgentTeamOperationReceipt[] = []
    ctx.on('agent-team/committed', ({ receipt }) => {
      if (receipt.requestId === request.requestId) receipts.push(receipt)
    })
    const getOperation = ledger.getOperation.bind(ledger)
    let projectedRequest: ReturnType<typeof requestId> | undefined
    let committedAtFault = false
    const projection = vi.spyOn(ledger, 'getOperation').mockImplementationOnce(operationId => {
      projectedRequest = getOperation(operationId)?.requestId
      committedAtFault = ledger.hasCommitted(request.requestId)
      throw new Error('post-commit projection failed')
    })
    const info = vi.spyOn(ctx.logger, 'info')
    const before = ctx.agentTeam.status().sequence

    const first = await ctx.agentTeam.managerCreateProjectForAgent(manager, request)
    const replay = await ctx.agentTeam.managerCreateProjectForAgent(manager, request)

    expect(projection).toHaveBeenCalledTimes(1)
    expect(projectedRequest).toBe(request.requestId)
    expect(committedAtFault).toBe(true)
    expect(receipts).toHaveLength(1)
    expect(first.outcome).toBe('committed')
    expect(first.receipt).toEqual(receipts[0])
    expect(replay.outcome).toBe('committed')
    expect(replay.receipt).toEqual(first.receipt)
    expect(replay.projectRef).toBe(first.projectRef)
    expect(ctx.agentTeam.status().sequence).toBe(before + 1)
    expect(info.mock.calls.some(([line]) => String(line).includes(`manager write replayed sessionId=${manager.id} requestId=${request.requestId}`))).toBe(true)
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('replays one requestId as the original receipt and refuses a changed parameter as a collision', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)

    const first = await runTool(ctx, manager, 'member_create', 'write-replay-1', {
      workspaceId, handle: 'replay', description: '幂等重放', model: mockRoute, requestId: 'replay-1',
    })
    expect(first.isError).toBe(false)
    if (first.isError) return
    const receipt = (first.value as { receipt: { operationId: string; sequence: number } }).receipt

    const replayed = await runTool(ctx, manager, 'member_create', 'write-replay-2', {
      workspaceId, handle: 'replay', description: '幂等重放', model: mockRoute, requestId: 'replay-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    expect((replayed.value as { receipt: { operationId: string; sequence: number } }).receipt).toEqual(receipt)
    expect(ctx.agentTeam.membersForClient({}).filter(entry => entry.member.handle === 'replay')).toHaveLength(1)

    const collided = await runTool(ctx, manager, 'member_create', 'write-replay-3', {
      workspaceId, handle: 'replay-renamed', description: '幂等重放', model: mockRoute, requestId: 'replay-1',
    })
    expect(collided.isError).toBe(true)
    if (collided.isError) expect(collided.error.message).toContain('replay-1')
    expect(ctx.agentTeam.membersForClient({}).filter(entry => entry.member.handle === 'replay')).toHaveLength(1)
  })

  it('keeps the Host admission and eligibility rules for Project creation and owner grants', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const member = await runTool(ctx, manager, 'member_create', 'write-admit-member', {
      workspaceId, handle: 'admit', description: '准入校验', model: mockRoute,
    })
    expect(member.isError).toBe(false)
    if (member.isError) return
    const memberRef = (member.value as { memberRef: string }).memberRef

    // A new Project enrolls nobody — version 9 removed creation-time
    // membership — so admission rules live on the owner grant, not on create.
    const project = await runTool(ctx, manager, 'project_create', 'write-admit-project', {
      workspaceId, name: 'Admitted', description: '准入后的共同目标',
    })
    expect(project.isError).toBe(false)
    if (project.isError) return
    const projectRef = (project.value as { projectRef: string }).projectRef

    // A suspended Member still owns Projects: the ledger's own rule.
    await ctx.agentTeam.suspendMember({ requestId: requestId('write-admit-suspend'), memberId: memberRef as never })

    const granted = await runTool(ctx, manager, 'project_owner', 'write-admit-owner', {
      action: 'add', workspaceId, projectRef, memberRef, responsibility: '暂停期间仍负责准入',
    })
    expect(granted.isError).toBe(false)

    const duplicate = await runTool(ctx, manager, 'project_owner', 'write-admit-duplicate', {
      action: 'add', workspaceId, projectRef, memberRef, responsibility: '重复授予',
    })
    expect(duplicate.isError).toBe(true)
    if (duplicate.isError) expect(duplicate.error.message).toContain('already owns')

    await ctx.agentTeam.archiveMember({ requestId: requestId('write-admit-archive'), memberId: memberRef as never })
    const afterArchive = await runTool(ctx, manager, 'project_owner', 'write-admit-archived', {
      action: 'add', workspaceId, projectRef, memberRef, responsibility: '归档后授予',
    })
    expect(afterArchive.isError).toBe(true)
    if (afterArchive.isError) expect(afterArchive.error.message).toContain('archived')

    const oversized = await runTool(ctx, manager, 'project_owner', 'write-admit-oversized', {
      action: 'add', workspaceId, projectRef, memberRef, responsibility: 'x'.repeat(2001),
    })
    expect(oversized.isError).toBe(true)
    if (oversized.isError) expect(oversized.error.message).toContain('at most 2000 characters')
  })

  it('refuses every write tool for a Session that is not the live manager, and never mounts them on a Member', async () => {
    const { ctx, workspaceId, checkout } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const member = await runTool(ctx, manager, 'member_create', 'write-auth-member', {
      workspaceId, handle: 'auth', description: '鉴权校验', model: mockRoute,
    })
    expect(member.isError).toBe(false)
    if (member.isError) return
    const memberRef = (member.value as { memberRef: string }).memberRef

    const ordinary = await ctx.agents.create({
      sessionId: SessionId('session-write-tool-ordinary'),
      meta: { cwd: checkout, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    onTestFinished(async () => { await ordinary.dispose() })
    for (const name of ['member_create', 'project_create', 'project_owner']) {
      ordinary.agent.ctx.tools.register(teamTools().get(name)!)
      const refused = await runTool(ctx, ordinary.agent, name, `write-auth-${name}`, {
        workspaceId, handle: 'intruder', description: '越权写', model: mockRoute,
        ...(name === 'project_create' ? { name: 'Intruder', description: '越权建项目' } : {}),
        ...(name === 'project_owner' ? { action: 'add', projectRef: 'project:x', memberRef, responsibility: '越权授权' } : {}),
      })
      expect(refused.isError, name).toBe(true)
      if (refused.isError) expect(refused.error.message, name).toContain('team manager tool requires the live Team manager Session')
    }

    const memberAgent = ctx.agents.get(ctx.agentTeam.membersForClient({}).find(entry => entry.member.memberId === memberRef)!.member.sessionId)!
    const memberTools = ctx.tools.schemas(memberAgent as never).map(schema => schema.name)
    for (const absent of ['member_create', 'project_create', 'project_owner', 'team_overview', 'team_models']) {
      expect(memberTools).not.toContain(absent)
    }
  })

  it('refuses a replaced manager generation and leaves no second Member behind', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const replaced = await ctx.agentTeam.newManagerSession({ expectedSessionId: manager.id })
    expect(replaced.status).toBe('ready')
    await expect(ctx.agentTeam.managerCreateMemberForAgent(manager, {
      requestId: requestId('write-replaced'), workspaceId, handle: 'stale', description: '旧世代写入', model: mockRoute,
    })).rejects.toThrow('team manager tool requires the live Team manager Session')
    expect(ctx.agentTeam.membersForClient({})).toEqual([])
  })

  it('keeps no live handle when a Member is archived while its activation runs', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    // The archive lands between the ledger commit and the handle write-back:
    // `attachSession` is the last await before the guard reads the ledger
    // again, and the registry hands out a fresh wrapper per call, so the spy
    // sits on `get` itself.
    const registry = ctx.workspaceRegistry
    const originalGet = registry.get.bind(registry)
    const get = vi.spyOn(registry, 'get')
    get.mockImplementation((id) => {
      const workspace = originalGet(id)
      if (workspace === undefined) return undefined
      return {
        ...workspace,
        attachSession: async (sessionId: SessionId) => {
          const listed = ctx.agentTeam.membersForClient({}).find(entry => entry.member.handle === 'racy')
          if (listed !== undefined) {
            await ctx.agentTeam.archiveMember({ requestId: requestId('write-racy-archive'), memberId: listed.member.memberId })
          }
          await workspace.attachSession(sessionId)
        },
      } as typeof workspace
    })
    const created = await ctx.agentTeam.managerCreateMemberForAgent(manager, {
      requestId: requestId('write-racy'), workspaceId, handle: 'racy', description: '激活途中归档', model: mockRoute,
    })
    // The write stands — it is committed — and the row the caller sees is the
    // archived one, with no live handle seeded behind it.
    expect(created.outcome).toBe('committed')
    expect(created.status.availability).toBe('archived')
    expect(created.status.presence).toBe('unavailable')
    expect(ctx.agents.get(created.status.member.sessionId)).toBeUndefined()
  })

  it('answers committed with an activation diagnostic, then finishes the Member on a replay', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)

    // The ledger records the Member and its activation then fails once. The
    // answer is the durable result with its diagnostic — the ticket's "committed
    // but not yet in effect" case — never a retry that would create a second
    // Member.
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    let activationRefused = false
    vi.spyOn(ctx.agents, 'create').mockImplementation(async options => {
      if (!activationRefused) {
        activationRefused = true
        throw new Error('activation refused by the test seam')
      }
      return originalCreate(options)
    })
    const committed = await ctx.agentTeam.managerCreateMemberForAgent(manager, {
      requestId: requestId('write-activation-failed'), workspaceId, handle: 'unlive', description: '激活失败后续做', model: mockRoute,
    })
    expect(committed.outcome).toBe('committed')
    expect(committed.status.availability).toBe('unavailable')
    expect(committed.status.diagnostic?.detail).toContain('activation refused by the test seam')
    expect(renderText(teamTools().get('member_create')!, {}, committed as never))
      .toContain('Committed, but the Member is not live')

    // With the cause repaired, the same requestId and parameters continue from
    // the receipt instead of creating anything new.
    const replayed = await ctx.agentTeam.managerCreateMemberForAgent(manager, {
      requestId: requestId('write-activation-failed'), workspaceId, handle: 'unlive', description: '激活失败后续做', model: mockRoute,
    })
    expect(replayed.receipt).toEqual(committed.receipt)
    expect(replayed.status.availability).toBe('active')
    expect(ctx.agentTeam.membersForClient({}).filter(entry => entry.member.handle === 'unlive')).toHaveLength(1)
  })

  it('answers the original receipt when the model catalog moved after the commit', async () => {
    const { ctx, workspaceId } = await realHarness()
    let catalogReadable = true
    ctx.provide('sessionController', {
      modelCatalog: async () => {
        if (!catalogReadable) throw new Error('catalog lookup failed')
        return {
          default: { provider: 'mock', model: 'mock' },
          routableProviders: ['mock'],
          groups: [{ id: 'mock', name: 'Mock', models: [{ id: 'mock', name: 'Mock', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }] }],
          failures: [{ id: 'broken', name: 'Broken', message: 'catalog lookup failed' }],
        }
      },
    })
    const manager = await openManager(ctx)
    const committed = await ctx.agentTeam.managerCreateMemberForAgent(manager, {
      requestId: requestId('write-catalog-moved'), workspaceId, handle: 'moved', description: '目录事后变化', model: mockRoute,
    })
    expect(committed.outcome).toBe('committed')

    // The catalog the Session controller can read now fails outright. A replay
    // of a committed request must still answer with the receipt the commit
    // produced, which is why the route check sits after the idempotency answer.
    catalogReadable = false
    const replayed = await ctx.agentTeam.managerCreateMemberForAgent(manager, {
      requestId: requestId('write-catalog-moved'), workspaceId, handle: 'moved', description: '目录事后变化', model: mockRoute,
    })
    expect(replayed.receipt).toEqual(committed.receipt)
    expect(ctx.agentTeam.membersForClient({}).filter(entry => entry.member.handle === 'moved')).toHaveLength(1)
  })

  it('refuses writes still queued in the ledger when the manager was replaced, at every write call site', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const ledger = (ctx.agentTeam as unknown as { ledger: AgentTeamLedger }).ledger
    const table = (ledger as unknown as { table: { put(key: string, value: unknown): Promise<void> } }).table
    const originalPut = table.put.bind(table)
    let release = () => {}
    const holding = new Promise<void>(resolve => { release = resolve })
    let held = 0
    vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
      if ((value as { requestId?: string }).requestId === requestId('queue-hold')) {
        held += 1
        await holding
      }
      return originalPut(key, value)
    })

    // One write that holds the ledger's serialized section open, so the three
    // below are genuinely queued behind it rather than merely in flight.
    const heldWrite = ctx.agentTeam.managerCreateMemberForAgent(manager, {
      requestId: requestId('queue-hold'), workspaceId, handle: 'holder', description: '占住账本临界区', model: mockRoute,
    })
    await vi.waitFor(() => { expect(held).toBe(1) })

    // Each passed its own entry check while the manager was still live, and is
    // now waiting to enter the write critical section.
    const queued = [
      ctx.agentTeam.managerCreateMemberForAgent(manager, {
        requestId: requestId('queue-member'), workspaceId, handle: 'queued', description: '排队后撤权', model: mockRoute,
      }),
      ctx.agentTeam.managerCreateProjectForAgent(manager, {
        requestId: requestId('queue-project'), workspaceId, name: 'Queued', description: '排队后撤权',
      }),
      ctx.agentTeam.managerChangeProjectOwnerForAgent(manager, {
        requestId: requestId('queue-owner'), workspaceId, projectRef: 'project:missing' as never, memberRef: 'member:missing' as never,
        action: 'add', responsibility: '排队后撤权',
      }),
    ]
    await new Promise(resolve => setImmediate(resolve))

    const replaced = await ctx.agentTeam.newManagerSession({ expectedSessionId: manager.id })
    expect(replaced.status).toBe('ready')
    release()

    for (const pending of queued) {
      await expect(pending).rejects.toThrow('team manager tool requires the live Team manager Session')
    }
    await heldWrite
    for (const id of ['queue-member', 'queue-project', 'queue-owner']) {
      expect(ledger.hasCommitted(requestId(id)), id).toBe(false)
    }
    // Only the write that was already inside the critical section stands.
    expect(ctx.agentTeam.membersForClient({}).map(entry => entry.member.handle)).toEqual(['holder'])
    expect(ctx.agentTeam.view({ workspaceId }).projects).toEqual([])
    expect(ctx.agentTeam.view({ workspaceId }).owners).toEqual([])
  })
})

describe('Ledger write authorization seam', () => {
  async function isolatedLedger(): Promise<AgentTeamLedger> {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    onTestFinished(async () => { await facility.closeAll() })
    const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
    const ledger = new AgentTeamLedger(domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
    await ledger.initialize()
    return ledger
  }

  const alpha = WorkspaceId('workspace:alpha')

  it('re-checks the caller authorization inside the serialized section and writes nothing when it refuses', async () => {
    const ledger = await isolatedLedger()
    const request = {
      requestId: requestId('seam-project'), workspaceId: alpha, name: 'Seam', description: '临界区鉴权',
      memberIds: [], actor: agentTeamHumanActor(),
    }
    await expect(ledger.createProject(request, { authorize: () => { throw new Error('the caller lost the right to write') } }))
      .rejects.toThrow('the caller lost the right to write')
    expect(ledger.hasCommitted(request.requestId)).toBe(false)
    // The refused write left the ledger writable: a fresh request still lands.
    const committed = (await ledger.createProject({ ...request, requestId: requestId('seam-project-2') })).value
    expect(committed.project.name).toBe('Seam')
  })

  it('lets an already-received replay finish without consulting the authorization again', async () => {
    const ledger = await isolatedLedger()
    const request = {
      requestId: requestId('seam-replay'), workspaceId: alpha, name: 'Replay', description: '已接收可收尾',
      memberIds: [], actor: agentTeamHumanActor(),
    }
    const first = (await ledger.createProject(request)).value
    const replayed = (await ledger.createProject(request, { authorize: () => { throw new Error('revoked after receipt') } })).value
    expect(replayed.receipt).toEqual(first.receipt)
  })
})
