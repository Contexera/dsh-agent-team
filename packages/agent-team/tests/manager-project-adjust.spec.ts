import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { realHarness, requestId } from './helpers/member-harness.ts'
import { renderText, teamTools } from '../../tool-agent-team/tests/render-text.ts'
import type { AgentTeamLedger } from '../src/ledger.ts'
import type { AgentTeamProjectRef } from '../src/types.ts'


const spillRoot = mkdtempSync(join(tmpdir(), 'dsh-team-manager-project-'))


afterAll(() => {
  rmSync(spillRoot, { recursive: true, force: true })
})

/** The shell executor a subscription script is snapshotted against. */
function provideShell(ctx: Context): void {
  ctx.provide('shell', {
    resolve: (request: unknown) => request,
    execute: async (spec: { command: string; timeoutMs: number }) => {
      const probe = spec.command.includes('BASH_VERSION')
      const path = join(spillRoot, `${crypto.randomUUID()}.log`)
      // A trial run reads the marker from the spilled stdout, so a script that
      // prints nothing still counts as a successful trial.
      writeFileSync(path, probe ? '5.2.15' : '__DSH_TEAM_RAW_STDOUT__')
      return {
        result: async () => ({
          exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: probe ? '5.2.15' : '', truncated: false, spillPath: path },
          stderr: { text: '', truncated: false },
        }),
      }
    },
  } as never)
}

/** The live manager Agent for one Host. */
async function openManager(ctx: Context): Promise<Agent> {
  const opened = await ctx.agentTeam.openManagerSession({})
  if (opened.status !== 'ready') throw new Error(`expected a ready manager Session, received '${opened.status}': ${JSON.stringify(opened)}`)
  const agent = ctx.agents.get(opened.sessionId)
  if (agent === undefined) throw new Error('expected the manager Agent to be registered')
  return agent
}

/** The one catalog the manager's Member writes are validated against. */
function provideModelCatalog(ctx: Context): void {
  ctx.provide('sessionController', {
    modelCatalog: async () => ({
      default: { provider: 'mock', model: 'mock' },
      routableProviders: ['mock'],
      groups: [{ id: 'mock', name: 'Mock', models: [{ id: 'mock', name: 'Mock' }] }],
      failures: [],
    }),
  })
}

const mockRoute = { provider: 'mock', model: 'mock' }

/** Run one manager tool as the manager Session. */
function runTool(ctx: Context, agent: Agent, name: string, callId: string, args: Record<string, unknown>) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal, agent, name,
    callId: ToolCallId(callId), arguments: args,
  })
}

/** Create one Member through the manager tool and answer its ref. */
async function createMember(ctx: Context, manager: Agent, workspaceId: WorkspaceId, handle: string): Promise<string> {
  const created = await runTool(ctx, manager, 'member_create', `create-${handle}`, {
    workspaceId, handle, description: `${handle} standing`, model: mockRoute,
  })
  expect(created.isError).toBe(false)
  if (created.isError) throw created.error
  return (created.value as { memberRef: string }).memberRef
}

/** Create one Project through the manager tool and answer its ref. */
async function createProject(ctx: Context, manager: Agent, workspaceId: WorkspaceId, name: string, description: string, memberIds: string[] = []): Promise<string> {
  const created = await runTool(ctx, manager, 'project_create', `create-project-${name}`, {
    workspaceId, name, description, ...(memberIds.length === 0 ? {} : { memberIds }),
  })
  expect(created.isError).toBe(false)
  if (created.isError) throw created.error
  return (created.value as { projectRef: string }).projectRef
}

/** The Project the ordinary Client projection reads. */
function projectOf(ctx: Context, workspaceId: WorkspaceId, projectRef: string) {
  return ctx.agentTeam.view({ workspaceId }).projects.find(project => project.projectRef === projectRef)
}

describe('Team manager Project adjustment', () => {
  it('patches one display field at a time and keeps the other', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const projectRef = await createProject(ctx, manager, workspaceId, 'Parser', '把解析收敛到一个权威实现')

    const renamed = await runTool(ctx, manager, 'project_update', 'project-rename', {
      action: 'update', workspaceId, projectRef, name: 'Parser v2', requestId: 'project-rename-1',
    })
    expect(renamed.isError).toBe(false)
    if (renamed.isError) return
    expect(renderText(teamTools().get('project_update')!, {}, renamed.value)).toContain('Project updated')
    expect(projectOf(ctx, workspaceId, projectRef)).toMatchObject({ name: 'Parser v2', description: '把解析收敛到一个权威实现' })

    // A goal-only patch keeps the name it never named, and an explicit empty
    // goal clears it exactly as the Web editor does.
    const reworded = await runTool(ctx, manager, 'project_update', 'project-goal', {
      action: 'update', workspaceId, projectRef, description: '新的共同目标', requestId: 'project-goal-1',
    })
    expect(reworded.isError).toBe(false)
    expect(projectOf(ctx, workspaceId, projectRef)).toMatchObject({ name: 'Parser v2', description: '新的共同目标' })

    const cleared = await runTool(ctx, manager, 'project_update', 'project-goal-clear', {
      action: 'update', workspaceId, projectRef, description: '', requestId: 'project-goal-clear-1',
    })
    expect(cleared.isError).toBe(false)
    expect(projectOf(ctx, workspaceId, projectRef)).toMatchObject({ name: 'Parser v2', description: '' })

    const blank = await runTool(ctx, manager, 'project_update', 'project-blank', {
      action: 'update', workspaceId, projectRef, name: '   ',
    })
    expect(blank.isError).toBe(true)
    if (blank.isError) expect(blank.error.message).toContain('non-empty name')
    const nothing = await runTool(ctx, manager, 'project_update', 'project-nothing', { action: 'update', workspaceId, projectRef })
    expect(nothing.isError).toBe(true)
    if (nothing.isError) expect(nothing.error.message).toContain('needs a name or a description')
  })

  it('keeps a rename that landed while a goal-only patch was queued', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const projectRef = await createProject(ctx, manager, workspaceId, 'Parser', '原共同目标')

    // The rename is held inside its own ledger write, so the goal patch queues
    // behind it and must merge against the committed name, not a snapshot.
    const ledger = (ctx.agentTeam as unknown as { ledger: AgentTeamLedger }).ledger
    const table = (ledger as unknown as { table: { put(key: string, value: unknown): Promise<void> } }).table
    const originalPut = table.put.bind(table)
    const holding = Promise.withResolvers<void>()
    let held = 0
    vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
      if ((value as { requestId?: string }).requestId === requestId('project-rename-hold')) {
        held += 1
        await holding.promise
      }
      return originalPut(key, value)
    })

    const renaming = ctx.agentTeam.managerUpdateProjectForAgent(manager, {
      requestId: requestId('project-rename-hold'), workspaceId, projectRef: projectRef as AgentTeamProjectRef, action: 'update', name: 'Renamed',
    })
    await vi.waitFor(() => { expect(held).toBe(1) })
    const reworded = ctx.agentTeam.managerUpdateProjectForAgent(manager, {
      requestId: requestId('project-goal-queued'), workspaceId, projectRef: projectRef as AgentTeamProjectRef, action: 'update', description: '排队后的共同目标',
    })
    await new Promise(resolve => setImmediate(resolve))
    holding.resolve()
    await renaming
    await reworded

    expect(projectOf(ctx, workspaceId, projectRef)).toMatchObject({ name: 'Renamed', description: '排队后的共同目标' })
  })

  it('replays the original receipt after a later edit and refuses a changed patch', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const projectRef = await createProject(ctx, manager, workspaceId, 'Parser', '原共同目标')

    const first = await runTool(ctx, manager, 'project_update', 'project-replay-first', {
      action: 'update', workspaceId, projectRef, name: 'Renamed', requestId: 'project-patch-1',
    })
    expect(first.isError).toBe(false)
    if (first.isError) return
    const receipt = (first.value as { receipt: { operationId: string } }).receipt

    // A later edit changes the field the patch never stated. The replay still
    // resolves to its own receipt instead of colliding on the new goal.
    await ctx.agentTeam.updateProject({ requestId: requestId('project-goal-later'), workspaceId, projectRef: projectRef as AgentTeamProjectRef, description: '后来改的共同目标' })
    const replayed = await runTool(ctx, manager, 'project_update', 'project-replay-second', {
      action: 'update', workspaceId, projectRef, name: 'Renamed', requestId: 'project-patch-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    expect((replayed.value as { receipt: { operationId: string } }).receipt.operationId).toBe(receipt.operationId)
    // The answer reads the row as it stands: the receipt is the original one,
    // and the goal it reports is the one the later edit left there.
    expect(replayed.value).toMatchObject({ name: 'Renamed', description: '后来改的共同目标' })
    expect(projectOf(ctx, workspaceId, projectRef)).toMatchObject({ name: 'Renamed', description: '后来改的共同目标' })

    const collided = await runTool(ctx, manager, 'project_update', 'project-replay-third', {
      action: 'update', workspaceId, projectRef, name: 'Different', requestId: 'project-patch-1',
    })
    expect(collided.isError).toBe(true)
    if (collided.isError) expect(collided.error.message).toContain('project-patch-1')
    expect(projectOf(ctx, workspaceId, projectRef)).toMatchObject({ name: 'Renamed' })
  })

  it('archives a Project: claims release, subscriptions clear, history stays', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    provideShell(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'archiver')
    const projectRef = await createProject(ctx, manager, workspaceId, 'Parser', '归档前的共同目标', [memberRef])
    const member = ctx.agentTeam.membersForClient({ workspaceId }).find(entry => entry.member.memberId === memberRef)!.member
    const memberAgent = ctx.agents.get(member.sessionId)!
    const started = await ctx.agentTeam.startThread({
      kind: 'task', requestId: requestId('archive-task'), workspaceId, projectRef: projectRef as AgentTeamProjectRef, body: '归档前仍开放的任务',
    })
    if (started.kind !== 'committed' || started.task === undefined) throw new Error('expected a committed Task thread')
    const claimed = await ctx.agentTeam.changeClaimForAgent(memberAgent, {
      requestId: requestId('archive-claim'), workspaceId, taskRef: started.task.taskRef, action: 'claim',
      baseRevision: started.thread.revision, direction: '归档前的方向',
    })
    expect(claimed.kind).toBe('committed')
    const subscription = await ctx.agentTeam.createSubscription({
      requestId: requestId('archive-subscription'), workspaceId, projectRef: projectRef as AgentTeamProjectRef,
      name: 'CI watch', intervalMinutes: 15, script: { scriptContent: 'printf events\n' },
    })
    expect(subscription.kind).toBe('changed')

    // One committed rename, then a later goal edit, so the replay below has a
    // real record to answer from.
    const renamed = await runTool(ctx, manager, 'project_update', 'project-archive-rename', {
      action: 'update', workspaceId, projectRef, name: 'Parser v2', requestId: 'project-archive-rename-1',
    })
    expect(renamed.isError).toBe(false)
    const reworded = await runTool(ctx, manager, 'project_update', 'project-archive-goal', {
      action: 'update', workspaceId, projectRef, description: '后来改的共同目标', requestId: 'project-archive-goal-1',
    })
    expect(reworded.isError).toBe(false)
    expect(projectOf(ctx, workspaceId, projectRef)).toMatchObject({ name: 'Parser v2', description: '后来改的共同目标' })

    // Archival names nothing: a call that carries a name or a goal is refused
    // rather than archived with a field it would have to drop.
    const named = await runTool(ctx, manager, 'project_update', 'project-archive-named', {
      action: 'archive', workspaceId, projectRef, name: '归档时改名',
    })
    expect(named.isError).toBe(true)
    if (named.isError) expect(named.error.message).toContain('belongs to the update action')
    expect(projectOf(ctx, workspaceId, projectRef)).toMatchObject({ name: 'Parser v2', state: 'active' })

    const archived = await runTool(ctx, manager, 'project_update', 'project-archive', {
      action: 'archive', workspaceId, projectRef, requestId: 'project-archive-1',
    })
    expect(archived.isError).toBe(false)
    if (archived.isError) return
    const value = archived.value as { receipt: { operationId: string }; releasedClaims: number; subscriptionsCleared: number; state: string }
    expect(value.state).toBe('archived')
    expect(value.releasedClaims).toBe(1)
    expect(value.subscriptionsCleared).toBe(1)
    expect(renderText(teamTools().get('project_update')!, {}, archived.value)).toContain('nothing was deleted')
    expect(projectOf(ctx, workspaceId, projectRef)).toBeUndefined()
    expect(ctx.agentTeam.view({ workspaceId }).tasks).toEqual([])

    // The same id answers the original receipt; a new one is refused, and an
    // archived Project accepts no further edit.
    const replayed = await runTool(ctx, manager, 'project_update', 'project-archive-replay', {
      action: 'archive', workspaceId, projectRef, requestId: 'project-archive-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    expect((replayed.value as { receipt: { operationId: string } }).receipt.operationId).toBe(value.receipt.operationId)
    const again = await runTool(ctx, manager, 'project_update', 'project-archive-again', {
      action: 'archive', workspaceId, projectRef, requestId: 'project-archive-2',
    })
    expect(again.isError).toBe(true)
    if (again.isError) expect(again.error.message).toContain('already archived')
    const edit = await runTool(ctx, manager, 'project_update', 'project-archive-edit', {
      action: 'update', workspaceId, projectRef, name: 'Too late',
    })
    expect(edit.isError).toBe(true)
    // A replay of the earlier rename answers the row as it stands: the archived
    // state and the goal the later edit left, never its own historical snapshot.
    const staleReplay = await runTool(ctx, manager, 'project_update', 'project-archive-stale-replay', {
      action: 'update', workspaceId, projectRef, name: 'Parser v2', requestId: 'project-archive-rename-1',
    })
    expect(staleReplay.isError).toBe(false)
    if (staleReplay.isError) return
    expect(staleReplay.value).toMatchObject({ state: 'archived', name: 'Parser v2', description: '后来改的共同目标' })
  })

  it('answers a committed archival whose subscription cleanup failed', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    provideShell(ctx)
    const manager = await openManager(ctx)
    const projectRef = await createProject(ctx, manager, workspaceId, 'Parser', '清理失败的共同目标')
    await ctx.agentTeam.createSubscription({
      requestId: requestId('cleanup-subscription'), workspaceId, projectRef: projectRef as AgentTeamProjectRef,
      name: 'CI watch', intervalMinutes: 15, script: { scriptContent: 'printf events\n' },
    })
    const team = ctx.agentTeam as unknown as { forgetSubscriptionPrivateState: (ref: unknown) => Promise<void> }
    const forget = vi.spyOn(team, 'forgetSubscriptionPrivateState').mockImplementationOnce(async () => {
      throw new Error('private state store unavailable (test seam)')
    })
    try {
      const archived = await runTool(ctx, manager, 'project_update', 'project-cleanup-failed', {
        action: 'archive', workspaceId, projectRef, requestId: 'project-cleanup-1',
      })
      // The archival is durable: the answer keeps its receipt and names the
      // cleanup that did not finish, instead of an uncommitted rejection.
      expect(archived.isError).toBe(false)
      if (archived.isError) return
      const value = archived.value as { receipt: { operationId: string }; subscriptionsCleared: number; cleanupWarning?: string }
      expect(value.subscriptionsCleared).toBe(0)
      expect(value.cleanupWarning).toContain('private state store unavailable')
      expect(renderText(teamTools().get('project_update')!, {}, archived.value)).toContain('clearing subscription state failed')
      expect(projectOf(ctx, workspaceId, projectRef)).toBeUndefined()
    } finally {
      forget.mockRestore()
    }
  })

  it('replaces an owner responsibility without withdrawing the grant', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'owner')
    const projectRef = await createProject(ctx, manager, workspaceId, 'Parser', '共同目标')

    const granted = await runTool(ctx, manager, 'project_owner', 'owner-add', {
      action: 'add', workspaceId, projectRef, memberRef, responsibility: '对解析器的根因诊断负责', requestId: 'owner-add-1',
    })
    expect(granted.isError).toBe(false)
    if (granted.isError) return
    expect(renderText(teamTools().get('project_owner')!, {}, granted.value)).toContain('Owner granted')
    const grantedSince = (ctx.agentTeam as unknown as { ledger: { state: { owners: Map<string, Map<string, { since: number }>> } } })
      .ledger.state.owners.get(projectRef)!.get(memberRef)!.since

    const updated = await runTool(ctx, manager, 'project_owner', 'owner-update', {
      action: 'update', workspaceId, projectRef, memberRef, responsibility: '对解析器的交付节奏负责', requestId: 'owner-update-1',
    })
    expect(updated.isError).toBe(false)
    if (updated.isError) return
    expect(renderText(teamTools().get('project_owner')!, {}, updated.value)).toContain('Responsibility updated')
    // The ownership itself is untouched: one owner, the same Member, and the
    // responsibility replaced everywhere it is read.
    expect(ctx.agentTeam.view({ workspaceId }).owners).toEqual([{ projectRef, memberId: memberRef, responsibility: '对解析器的交付节奏负责' }])
    // One appended record, not a withdrawal followed by a new grant: the grant
    // itself and the sequence that made the Member an owner stay as they were.
    const ledgerState = (ctx.agentTeam as unknown as { ledger: { state: { byRequest: Map<string, { kind: string }>; owners: Map<string, Map<string, { since: number }>> } } }).ledger.state
    expect(ledgerState.byRequest.get(requestId('owner-update-1'))?.kind).toBe('team/project-owner-responsibility-updated')
    expect(ledgerState.owners.get(projectRef)?.get(memberRef)?.since).toBe(grantedSince)
    const overview = await runTool(ctx, manager, 'team_overview', 'owner-overview', { memberRef })
    expect(overview.isError).toBe(false)
    if (overview.isError) return
    expect((overview.value as { member: { owns: { responsibility?: string }[] } }).member.owns[0]?.responsibility).toBe('对解析器的交付节奏负责')
    // The Member's own standing is a different field and stays as it was.
    expect(ctx.agentTeam.membersForClient({ workspaceId }).find(entry => entry.member.memberId === memberRef)?.member.description).toBe('owner standing')

    const replayed = await runTool(ctx, manager, 'project_owner', 'owner-update-replay', {
      action: 'update', workspaceId, projectRef, memberRef, responsibility: '对解析器的交付节奏负责', requestId: 'owner-update-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    expect((replayed.value as { receipt: { operationId: string } }).receipt.operationId)
      .toBe((updated.value as { receipt: { operationId: string } }).receipt.operationId)
    const collided = await runTool(ctx, manager, 'project_owner', 'owner-update-collision', {
      action: 'update', workspaceId, projectRef, memberRef, responsibility: '另一个责任', requestId: 'owner-update-1',
    })
    expect(collided.isError).toBe(true)
    if (collided.isError) expect(collided.error.message).toContain('owner-update-1')
  })

  it('records an unspecified responsibility when the update clears it', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'clearing')
    const projectRef = await createProject(ctx, manager, workspaceId, 'Parser', '共同目标')
    await runTool(ctx, manager, 'project_owner', 'clear-add', {
      action: 'add', workspaceId, projectRef, memberRef, responsibility: '对解析器负责', requestId: 'clear-add-1',
    })

    const cleared = await runTool(ctx, manager, 'project_owner', 'clear-update', {
      action: 'update', workspaceId, projectRef, memberRef, clearResponsibility: true, requestId: 'clear-update-1',
    })
    expect(cleared.isError).toBe(false)
    if (cleared.isError) return
    expect(renderText(teamTools().get('project_owner')!, {}, cleared.value)).toContain('Responsibility: unspecified')
    expect(ctx.agentTeam.view({ workspaceId }).owners).toEqual([{ projectRef, memberId: memberRef }])

    // The documented empty value is how a model records "unspecified" directly;
    // it is the same record `clearResponsibility` writes.
    const direct = await runTool(ctx, manager, 'project_owner', 'clear-direct', {
      action: 'update', workspaceId, projectRef, memberRef, responsibility: '', requestId: 'clear-direct-1',
    })
    expect(direct.isError).toBe(false)
    if (direct.isError) return
    expect((direct.value as { responsibility?: string }).responsibility).toBe('')
    expect(ctx.agentTeam.view({ workspaceId }).owners).toEqual([{ projectRef, memberId: memberRef }])

    const both = await runTool(ctx, manager, 'project_owner', 'clear-both', {
      action: 'update', workspaceId, projectRef, memberRef, responsibility: '又写了一个', clearResponsibility: true,
    })
    expect(both.isError).toBe(true)
    if (both.isError) expect(both.error.message).toContain('either responsibility or clearResponsibility')
    const onAdd = await runTool(ctx, manager, 'project_owner', 'clear-add-flag', {
      action: 'add', workspaceId, projectRef, memberRef, clearResponsibility: true,
    })
    expect(onAdd.isError).toBe(true)
    if (onAdd.isError) expect(onAdd.error.message).toContain('nothing to clear')
    const onRemove = await runTool(ctx, manager, 'project_owner', 'clear-remove', {
      action: 'remove', workspaceId, projectRef, memberRef, responsibility: '撤权不该带责任',
    })
    expect(onRemove.isError).toBe(true)
    if (onRemove.isError) expect(onRemove.error.message).toContain('only with add or update')
    // A blank slot on remove names nothing, so it is tolerated rather than
    // refused: the model that fills every optional field still withdraws.
    const blankRemove = await runTool(ctx, manager, 'project_owner', 'clear-remove-blank', {
      action: 'remove', workspaceId, projectRef, memberRef, responsibility: '', requestId: 'clear-remove-1',
    })
    expect(blankRemove.isError).toBe(false)
    if (blankRemove.isError) return
    expect(blankRemove.value).toMatchObject({ action: 'remove' })
    expect(ctx.agentTeam.view({ workspaceId }).owners).toEqual([])
  })

  it('keeps a Task with a Member that still participates, and returns it to the Human otherwise', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)

    // Case one: the Member is a Project member in its own right, so losing the
    // ownership leaves its Task responsibility where it was.
    const stayingRef = await createMember(ctx, manager, workspaceId, 'staying')
    const stayingProject = await createProject(ctx, manager, workspaceId, 'Staying', '共同目标', [stayingRef])
    const stayingTask = await ctx.agentTeam.startThread({
      kind: 'task', requestId: requestId('staying-task'), workspaceId, projectRef: stayingProject as AgentTeamProjectRef, body: '仍由成员负责的任务',
    })
    if (stayingTask.kind !== 'committed' || stayingTask.task === undefined) throw new Error('expected a committed Task thread')
    const stayingTaskRef = stayingTask.task.taskRef
    await ctx.agentTeam.transferTask({
      requestId: requestId('staying-transfer'), workspaceId, taskRef: stayingTaskRef,
      target: stayingRef as never, baseRevision: stayingTask.thread.revision,
    })
    await runTool(ctx, manager, 'project_owner', 'staying-add', {
      action: 'add', workspaceId, projectRef: stayingProject, memberRef: stayingRef, responsibility: '对 Staying 负责', requestId: 'staying-add-1',
    })
    const removed = await runTool(ctx, manager, 'project_owner', 'staying-remove', {
      action: 'remove', workspaceId, projectRef: stayingProject, memberRef: stayingRef, requestId: 'staying-remove-1',
    })
    expect(removed.isError).toBe(false)
    if (removed.isError) return
    expect(renderText(teamTools().get('project_owner')!, {}, removed.value)).toContain('Owner withdrawn')
    expect(ctx.agentTeam.view({ workspaceId }).owners).toEqual([])
    expect(ctx.agentTeam.view({ workspaceId }).tasks.find(task => task.taskRef === stayingTaskRef)?.accountable).toBe(stayingRef)

    // Case two: the grant was the Member's only tie to the Project until the
    // Task named it. The removal records the Member as named in the Project, so
    // the Task stays (the v3 rule the ledger already states); only ending its
    // participation — archiving the Member — returns responsibility to the Human.
    const leavingRef = await createMember(ctx, manager, workspaceId, 'leaving')
    const leavingProject = await createProject(ctx, manager, workspaceId, 'Leaving', '共同目标')
    await runTool(ctx, manager, 'project_owner', 'leaving-add', {
      action: 'add', workspaceId, projectRef: leavingProject, memberRef: leavingRef, responsibility: '对 Leaving 负责', requestId: 'leaving-add-1',
    })
    const leavingAgent = ctx.agents.get(ctx.agentTeam.membersForClient({ workspaceId }).find(entry => entry.member.memberId === leavingRef)!.member.sessionId)!
    const discussion = await ctx.agentTeam.startThread({
      kind: 'discussion', requestId: requestId('leaving-discussion'), workspaceId, projectRef: leavingProject as AgentTeamProjectRef, body: '待提升为任务的讨论',
    })
    if (discussion.kind !== 'committed') throw new Error('expected a committed discussion thread')
    const promoted = await ctx.agentTeam.promoteThreadForAgent(leavingAgent, {
      requestId: requestId('leaving-promote'), workspaceId, threadRef: discussion.thread.threadRef,
      baseRevision: discussion.thread.revision, accountable: leavingRef as never,
    })
    expect(promoted.kind).toBe('committed')
    const withdrawn = await runTool(ctx, manager, 'project_owner', 'leaving-remove', {
      action: 'remove', workspaceId, projectRef: leavingProject, memberRef: leavingRef, requestId: 'leaving-remove-1',
    })
    expect(withdrawn.isError).toBe(false)
    const taskRef = ctx.agentTeam.view({ workspaceId }).tasks.find(entry => entry.projectRef === leavingProject)?.taskRef
    expect(taskRef).toBeDefined()
    expect(ctx.agentTeam.view({ workspaceId }).tasks.find(entry => entry.taskRef === taskRef)?.accountable).toBe(leavingRef)

    await ctx.agentTeam.archiveMember({ requestId: requestId('leaving-archive'), memberId: leavingRef as never })
    expect(ctx.agentTeam.view({ workspaceId }).tasks.find(entry => entry.taskRef === taskRef)?.accountable).toBe('member:human')
  })

  it('refuses a stale ref and an archived Project, and serializes a concurrent withdrawal', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'stale')
    const projectRef = await createProject(ctx, manager, workspaceId, 'Stale', '共同目标')

    const unknown = await runTool(ctx, manager, 'project_update', 'stale-unknown', {
      action: 'update', workspaceId, projectRef: 'project:missing', name: 'No such Project',
    })
    expect(unknown.isError).toBe(true)
    if (unknown.isError) expect(unknown.error.message).toContain('unknown Project')

    // The grant this Project needs for the withdrawal below.
    const granted = await runTool(ctx, manager, 'project_owner', 'stale-owner-add', {
      action: 'add', workspaceId, projectRef, memberRef, responsibility: '排队前的责任', requestId: 'stale-owner-add-1',
    })
    expect(granted.isError).toBe(false)

    const updating = ctx.agentTeam.managerChangeProjectOwnerForAgent(manager, {
      requestId: requestId('stale-owner-update'), workspaceId, projectRef: projectRef as AgentTeamProjectRef,
      memberRef: memberRef as never, action: 'update', responsibility: '并发更新后的责任',
    })
    const removing = ctx.agentTeam.managerChangeProjectOwnerForAgent(manager, {
      requestId: requestId('stale-owner-remove'), workspaceId, projectRef: projectRef as AgentTeamProjectRef,
      memberRef: memberRef as never, action: 'remove',
    })
    await Promise.all([updating, removing])
    expect(ctx.agentTeam.view({ workspaceId }).owners).toEqual([])

    // An archived Project accepts no ownership change either.
    await runTool(ctx, manager, 'project_update', 'stale-archive', { action: 'archive', workspaceId, projectRef, requestId: 'stale-archive-1' })
    const archivedOwner = await runTool(ctx, manager, 'project_owner', 'stale-archived-owner', {
      action: 'add', workspaceId, projectRef, memberRef, responsibility: '归档后不该再授予', requestId: 'stale-archived-owner-1',
    })
    expect(archivedOwner.isError).toBe(true)
    if (archivedOwner.isError) expect(archivedOwner.error.message).toContain('archived')
  })

  it('refuses the new call sites for a replaced manager, including writes already queued', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'queued-owner')
    const projectRef = await createProject(ctx, manager, workspaceId, 'Queued', '共同目标')
    await runTool(ctx, manager, 'project_owner', 'queued-owner-add', {
      action: 'add', workspaceId, projectRef, memberRef, responsibility: '排队前的责任', requestId: 'queued-owner-add-1',
    })
    const ledger = (ctx.agentTeam as unknown as { ledger: AgentTeamLedger }).ledger
    const table = (ledger as unknown as { table: { put(key: string, value: unknown): Promise<void> } }).table
    const originalPut = table.put.bind(table)
    const holding = Promise.withResolvers<void>()
    let held = 0
    vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
      if ((value as { requestId?: string }).requestId === requestId('project-queue-hold')) {
        held += 1
        await holding.promise
      }
      return originalPut(key, value)
    })

    const heldWrite = ctx.agentTeam.managerCreateProjectForAgent(manager, {
      requestId: requestId('project-queue-hold'), workspaceId, name: 'Holder', description: '占住账本临界区',
    })
    await vi.waitFor(() => { expect(held).toBe(1) })

    const queued = [
      ctx.agentTeam.managerUpdateProjectForAgent(manager, {
        requestId: requestId('queue-project-update'), workspaceId, projectRef: projectRef as AgentTeamProjectRef, action: 'update', name: '排队后撤权',
      }),
      ctx.agentTeam.managerChangeProjectOwnerForAgent(manager, {
        requestId: requestId('queue-owner-update'), workspaceId, projectRef: projectRef as AgentTeamProjectRef, memberRef: memberRef as never,
        action: 'update', responsibility: '排队后撤权',
      }),
      ctx.agentTeam.managerChangeProjectOwnerForAgent(manager, {
        requestId: requestId('queue-owner-remove'), workspaceId, projectRef: projectRef as AgentTeamProjectRef, memberRef: memberRef as never,
        action: 'remove',
      }),
    ]
    await new Promise(resolve => setImmediate(resolve))

    const replaced = await ctx.agentTeam.newManagerSession({ expectedSessionId: manager.id })
    expect(replaced.status).toBe('ready')
    holding.resolve()

    for (const pending of queued) {
      await expect(pending).rejects.toThrow('team manager tool requires the live Team manager Session')
    }
    await heldWrite
    for (const id of ['queue-project-update', 'queue-owner-update', 'queue-owner-remove']) {
      expect(ledger.hasCommitted(requestId(id)), id).toBe(false)
    }
    expect(projectOf(ctx, workspaceId, projectRef)).toMatchObject({ name: 'Queued' })
    expect(ctx.agentTeam.view({ workspaceId }).owners).toEqual([{ projectRef, memberId: memberRef, responsibility: '排队前的责任' }])
  })

  it('refuses the new tools on a Session that is not the live manager', async () => {
    const { ctx, workspaceId, checkout } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const projectRef = await createProject(ctx, manager, workspaceId, 'Guard', '共同目标')
    const memberRef = await createMember(ctx, manager, workspaceId, 'guard')
    const ordinary = await ctx.agents.create({
      sessionId: SessionId('session-project-ordinary'),
      meta: { cwd: checkout, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    onTestFinished(async () => { await ordinary.dispose() })
    const calls: Array<[string, Record<string, unknown>]> = [
      ['project_update', { action: 'update', workspaceId, projectRef, name: '越权改名' }],
      ['project_owner', { action: 'remove', workspaceId, projectRef, memberRef }],
    ]
    for (const [name, args] of calls) {
      ordinary.agent.ctx.tools.register(teamTools().get(name)!)
      const refused = await runTool(ctx, ordinary.agent, name, `guard-${name}`, args)
      expect(refused.isError, name).toBe(true)
      if (refused.isError) expect(refused.error.message, name).toContain('team manager tool requires the live Team manager Session')
    }
    const memberAgent = ctx.agents.get(ctx.agentTeam.membersForClient({ workspaceId }).find(entry => entry.member.memberId === memberRef)!.member.sessionId)!
    const memberTools = ctx.tools.schemas(memberAgent as never).map(schema => schema.name)
    for (const absent of ['project_update', 'project_owner']) expect(memberTools).not.toContain(absent)
  })
})

describe('Project edit idempotency order', () => {
  it('answers a Project update replay after the Project moved on', async () => {
    const { ctx, workspaceId } = await realHarness()
    const created = await ctx.agentTeam.createProject({ requestId: requestId('order-project'), workspaceId, name: 'Order', description: 'first goal' })
    const projectRef = created.project.projectRef
    const first = await ctx.agentTeam.updateProject({ requestId: requestId('order-update'), workspaceId, projectRef, name: 'Order v2' })
    const replayed = await ctx.agentTeam.updateProject({ requestId: requestId('order-update'), workspaceId, projectRef, name: 'Order v2' })
    expect(replayed.receipt.operationId).toBe(first.receipt.operationId)
    // The field the request never stated is the one the later edit owns.
    await ctx.agentTeam.updateProject({ requestId: requestId('order-goal'), workspaceId, projectRef, description: 'second goal' })
    const again = await ctx.agentTeam.updateProject({ requestId: requestId('order-update'), workspaceId, projectRef, name: 'Order v2' })
    expect(again.receipt.operationId).toBe(first.receipt.operationId)
    expect(projectOf(ctx, workspaceId, projectRef)).toMatchObject({ name: 'Order v2', description: 'second goal' })
  })
})
