import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { realHarness, requestId } from './helpers/member-harness.ts'
import { renderText, teamTools } from '../../tool-agent-team/tests/render-text.ts'
import { AgentTeamLedger } from '../src/ledger.ts'


/** The live manager Agent for one Host. */
async function openManager(ctx: Context): Promise<Agent> {
  const opened = await ctx.agentTeam.openManagerSession({})
  if (opened.status !== 'ready') throw new Error(`expected a ready manager Session, received '${opened.status}'`)
  const agent = ctx.agents.get(opened.sessionId)
  if (agent === undefined) throw new Error('expected the manager Agent to be registered')
  return agent
}

/** The models these specs route to, all offered by the one mock provider. */
const CATALOG_MODELS = ['mock', 'first', 'second', 'patched', 'moved', 'repaired']

/** The one catalog the manager's writes are validated against, with a provider whose lookup failed. */
function provideModelCatalog(ctx: Context): void {
  ctx.provide('sessionController', {
    modelCatalog: async () => ({
      default: { provider: 'mock', model: 'mock' },
      routableProviders: ['mock'],
      groups: [{
        id: 'mock', name: 'Mock',
        models: CATALOG_MODELS.map(id => ({ id, name: id, reasoning: { efforts: [{ id: 'low', name: 'Low' }] } })),
      }],
      failures: [{ id: 'broken', name: 'Broken', message: 'catalog lookup failed' }],
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
async function createMember(ctx: Context, manager: Agent, workspaceId: WorkspaceId, handle: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await runTool(ctx, manager, 'member_create', `create-${handle}`, {
    workspaceId, handle, description: `${handle} standing`, model: mockRoute, ...extra,
  })
  expect(created.isError).toBe(false)
  if (created.isError) throw created.error
  return (created.value as { memberRef: string }).memberRef
}

/** The stored Member record the ordinary Client projection reads. */
function memberOf(ctx: Context, workspaceId: WorkspaceId, memberRef: string) {
  return ctx.agentTeam.membersForClient({ workspaceId }).find(status => status.member.memberId === memberRef)
}

describe('Team manager Member adjustment', () => {
  it('patches one field at a time and keeps every stored value the call left out', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'adjust', { model: { provider: 'mock', model: 'first' } })

    const described = await runTool(ctx, manager, 'member_update', 'adjust-description', {
      memberRef, description: '长期负责交付质量', requestId: 'adjust-description-1',
    })
    expect(described.isError).toBe(false)
    expect(memberOf(ctx, workspaceId, memberRef)?.member).toMatchObject({
      handle: 'adjust', description: '长期负责交付质量', model: { provider: 'mock', model: 'first' },
    })

    // A model-only patch keeps the description it never named, and the answer
    // reports the route reaching the live runtime.
    const rerouted = await runTool(ctx, manager, 'member_update', 'adjust-model', {
      memberRef, model: { provider: 'mock', model: 'second' }, requestId: 'adjust-model-1',
    })
    expect(rerouted.isError).toBe(false)
    if (rerouted.isError) return
    expect((rerouted.value as { effect: string }).effect).toBe('applied')
    expect(memberOf(ctx, workspaceId, memberRef)?.member).toMatchObject({
      handle: 'adjust', description: '长期负责交付质量', model: { provider: 'mock', model: 'second' },
    })

    // The handle is not editable through this tool, and an explicit blank
    // standing is refused before any write.
    const blank = await runTool(ctx, manager, 'member_update', 'adjust-blank', { memberRef, description: '   ' })
    expect(blank.isError).toBe(true)
    if (blank.isError) expect(blank.error.message).toContain('non-empty description')
    expect(memberOf(ctx, workspaceId, memberRef)?.member.handle).toBe('adjust')
  })

  it('replays the same patch to its original receipt after a later edit, and refuses a changed patch', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'replay')

    const first = await runTool(ctx, manager, 'member_update', 'replay-first', {
      memberRef, model: { provider: 'mock', model: 'patched' }, requestId: 'replay-patch-1',
    })
    expect(first.isError).toBe(false)
    if (first.isError) return
    const receipt = (first.value as { receipt: { operationId: string } }).receipt

    // A later edit changes the fields the patch never stated. The replay must
    // still resolve to its own receipt instead of colliding on the new values.
    await ctx.agentTeam.updateMember({
      requestId: requestId('replay-rename'), memberId: memberRef as never, handle: 'renamed', description: 'renamed standing',
    })
    const replayed = await runTool(ctx, manager, 'member_update', 'replay-second', {
      memberRef, model: { provider: 'mock', model: 'patched' }, requestId: 'replay-patch-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    expect((replayed.value as { receipt: { operationId: string } }).receipt.operationId).toBe(receipt.operationId)
    expect(memberOf(ctx, workspaceId, memberRef)?.member).toMatchObject({
      handle: 'renamed', description: 'renamed standing', model: { provider: 'mock', model: 'patched' },
    })

    // A changed patch under the same id is a collision: nothing is rewritten.
    const collided = await runTool(ctx, manager, 'member_update', 'replay-third', {
      memberRef, description: 'different patch', requestId: 'replay-patch-1',
    })
    expect(collided.isError).toBe(true)
    if (collided.isError) expect(collided.error.message).toContain('replay-patch-1')
    expect(memberOf(ctx, workspaceId, memberRef)?.member.description).toBe('renamed standing')
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
          groups: [{ id: 'mock', name: 'Mock', models: CATALOG_MODELS.map(id => ({ id, name: id })) }],
          failures: [],
        }
      },
    })
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'catalog')
    const committed = await runTool(ctx, manager, 'member_update', 'catalog-first', {
      memberRef, model: { provider: 'mock', model: 'moved' }, requestId: 'catalog-patch-1',
    })
    expect(committed.isError).toBe(false)
    if (committed.isError) return
    const receipt = (committed.value as { receipt: { operationId: string } }).receipt

    catalogReadable = false
    const replayed = await runTool(ctx, manager, 'member_update', 'catalog-second', {
      memberRef, model: { provider: 'mock', model: 'moved' }, requestId: 'catalog-patch-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    expect((replayed.value as { receipt: { operationId: string } }).receipt.operationId).toBe(receipt.operationId)
  })

  it('clears a capability override only when asked, and keeps it otherwise', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'caps', {
      capabilities: { tools: { allow: ['team_view'] } },
    })

    const kept = await runTool(ctx, manager, 'member_update', 'caps-kept', { memberRef, description: 'kept override' })
    expect(kept.isError).toBe(false)
    expect(memberOf(ctx, workspaceId, memberRef)?.member.capabilities?.tools?.allow).toEqual(['team_view'])

    const cleared = await runTool(ctx, manager, 'member_update', 'caps-cleared', { memberRef, clearCapabilities: true })
    expect(cleared.isError).toBe(false)
    expect(memberOf(ctx, workspaceId, memberRef)?.member.capabilities).toBeUndefined()

    const both = await runTool(ctx, manager, 'member_update', 'caps-both', {
      memberRef, capabilities: { tools: { allow: ['team_view'] } }, clearCapabilities: true,
    })
    expect(both.isError).toBe(true)
    if (both.isError) expect(both.error.message).toContain('either capabilities or clearCapabilities')
  })

  it('answers a committed write whose live capability apply failed, then finishes it on a replay', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'apply', {
      capabilities: { tools: { allow: ['team_view'] } },
    })
    const member = memberOf(ctx, workspaceId, memberRef)!
    const agent = ctx.agents.get(member.member.sessionId)!
    const restrict = vi.spyOn(agent.ctx.tools, 'restrict').mockImplementationOnce(() => {
      throw new Error('temporary restriction failure (test)')
    })
    try {
      const failed = await runTool(ctx, manager, 'member_update', 'apply-failed', {
        memberRef, capabilities: { tools: { allow: ['team_view', 'team_inbox'] } }, requestId: 'apply-patch-1',
      })
      // The write stands: the answer is committed with the failure named, never
      // an uncommitted rejection that would invite a duplicate retry.
      expect(failed.isError).toBe(false)
      if (failed.isError) return
      const value = failed.value as { effect: string; status: { presence: string; capabilityState: string; diagnostic?: { class: string } } }
      expect(value.effect).toBe('failed:capability-apply')
      expect(value.status.presence).toBe('error')
      expect(value.status.capabilityState).toBe('pending')
      expect(value.status.diagnostic?.class).toBe('capability-apply')
      expect(renderText(teamTools().get('member_update')!, {}, failed.value)).toContain('Saved, but the capability restriction could not be applied')
      expect(memberOf(ctx, workspaceId, memberRef)?.member.capabilities?.tools?.allow).toEqual(['team_view', 'team_inbox'])
    } finally {
      restrict.mockRestore()
    }

    // The same requestId and patch now replays its receipt and finishes the
    // apply, so the stored intent and the live surface converge.
    const replayed = await runTool(ctx, manager, 'member_update', 'apply-replayed', {
      memberRef, capabilities: { tools: { allow: ['team_view', 'team_inbox'] } }, requestId: 'apply-patch-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    expect((replayed.value as { status: { capabilityState: string } }).status.capabilityState).toBe('applied')
  })

  it('answers a committed model edit whose live route apply failed, then retries it on a replay', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'route')
    const member = memberOf(ctx, workspaceId, memberRef)!
    const agent = ctx.agents.get(member.member.sessionId)!
    const select = vi.spyOn(agent.model, 'select').mockImplementationOnce(() => {
      throw new Error('temporary route seam failure (test)')
    })
    try {
      const failed = await runTool(ctx, manager, 'member_update', 'route-failed', {
        memberRef, model: { provider: 'mock', model: 'second' }, requestId: 'route-patch-1',
      })
      expect(failed.isError).toBe(false)
      if (failed.isError) return
      const value = failed.value as { effect: string; status: { presence: string; diagnostic?: { class: string; detail: string } } }
      // The stage that failed names the answer: a route failure is never
      // reported as a capability failure, and the write itself stands.
      expect(value.effect).toBe('failed:model-apply')
      expect(value.status.presence).toBe('error')
      expect(value.status.diagnostic?.class).toBe('model-apply')
      expect(value.status.diagnostic?.detail).toContain('stage=model-apply')
      expect(renderText(teamTools().get('member_update')!, {}, failed.value)).toContain('Saved, but the model route could not be applied')
      expect(select).toHaveBeenCalledTimes(1)
      expect(memberOf(ctx, workspaceId, memberRef)?.member.model).toMatchObject({ provider: 'mock', model: 'second' })
    } finally {
      select.mockRestore()
    }

    // The same id and patch answers its receipt and retries the effect the
    // stored route still owes: the diff is against the live generation, not
    // against the record this request started from.
    const replayed = await runTool(ctx, manager, 'member_update', 'route-replayed', {
      memberRef, model: { provider: 'mock', model: 'second' }, requestId: 'route-patch-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    const replayValue = replayed.value as { effect: string; status: { availability: string; presence: string } }
    expect(replayValue.effect).toBe('applied')
    expect(replayValue.status).toMatchObject({ availability: 'active', presence: 'available' })
    expect(agent.model.current()).toMatchObject({ provider: 'mock', model: 'second' })
  })

  it('never re-applies an old route patch after the route moved on', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'moved-route')
    const member = memberOf(ctx, workspaceId, memberRef)!
    const agent = ctx.agents.get(member.member.sessionId)!
    const select = vi.spyOn(agent.model, 'select').mockImplementationOnce(() => {
      throw new Error('temporary route seam failure (test)')
    })
    try {
      await runTool(ctx, manager, 'member_update', 'moved-failed', {
        memberRef, model: { provider: 'mock', model: 'second' }, requestId: 'moved-patch-1',
      })
    } finally {
      select.mockRestore()
    }
    // A later edit moves the route again; replaying the older patch must not
    // put the route it named back.
    const later = await runTool(ctx, manager, 'member_update', 'moved-later', {
      memberRef, model: { provider: 'mock', model: 'patched' }, requestId: 'moved-patch-2',
    })
    expect(later.isError).toBe(false)
    const replayed = await runTool(ctx, manager, 'member_update', 'moved-replay', {
      memberRef, model: { provider: 'mock', model: 'second' }, requestId: 'moved-patch-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    expect((replayed.value as { effect: string }).effect).toBe('already-applied')
    expect(agent.model.current()).toMatchObject({ provider: 'mock', model: 'patched' })
    expect(memberOf(ctx, workspaceId, memberRef)?.member.model).toMatchObject({ provider: 'mock', model: 'patched' })
  })

  it('suspends, resumes, and archives through the lifecycle tool', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'lifecycle')

    const suspended = await runTool(ctx, manager, 'member_state', 'state-suspend', {
      action: 'suspend', memberRef, requestId: 'state-suspend-1',
    })
    expect(suspended.isError).toBe(false)
    if (suspended.isError) return
    expect((suspended.value as { outcome: string; status: { availability: string } }).outcome).toBe('committed')
    expect((suspended.value as { status: { availability: string } }).status.availability).toBe('suspended')
    expect(renderText(teamTools().get('member_state')!, {}, suspended.value)).toContain('Member suspended')

    const resumed = await runTool(ctx, manager, 'member_state', 'state-resume', {
      action: 'resume', memberRef, requestId: 'state-resume-1',
    })
    expect(resumed.isError).toBe(false)
    if (resumed.isError) return
    expect((resumed.value as { status: { availability: string } }).status.availability).toBe('active')

    const archived = await runTool(ctx, manager, 'member_state', 'state-archive', {
      action: 'archive', memberRef, requestId: 'state-archive-1',
    })
    expect(archived.isError).toBe(false)
    if (archived.isError) return
    const archivedValue = archived.value as { status: { availability: string }; releasedClaims: number; removedAttention: number }
    expect(archivedValue.status.availability).toBe('archived')
    expect(archivedValue.releasedClaims).toBe(0)
    expect(archivedValue.removedAttention).toBe(0)
    expect(renderText(teamTools().get('member_state')!, {}, archived.value)).toContain('nothing was deleted')

    // A suspended Member cannot be restarted: the refusal names the state.
    await expect(ctx.agentTeam.recoverMember({ requestId: requestId('state-recover-archived'), workspaceId, memberId: memberRef as never }))
      .rejects.toThrow(/archived/)
  })

  it('recovers a Member whose activation failed, including after a model repair', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    let activationRefused = false
    vi.spyOn(ctx.agents, 'create').mockImplementation(async options => {
      if (!activationRefused) {
        activationRefused = true
        throw new Error('activation refused by the test seam')
      }
      return originalCreate(options)
    })
    const created = await runTool(ctx, manager, 'member_create', 'recover-create', {
      workspaceId, handle: 'broken', description: '激活失败后恢复', model: mockRoute, requestId: 'recover-create-1',
    })
    expect(created.isError).toBe(false)
    if (created.isError) return
    const memberRef = (created.value as { memberRef: string }).memberRef
    expect((created.value as { status: { availability: string; diagnostic?: { class: string } } }).status).toMatchObject({
      availability: 'unavailable', diagnostic: { class: 'activation' },
    })

    // The repair first: a model edit is accepted while the Member is down.
    const repaired = await runTool(ctx, manager, 'member_update', 'recover-repair', {
      memberRef, model: { provider: 'mock', model: 'repaired' }, requestId: 'recover-repair-1',
    })
    expect(repaired.isError).toBe(false)

    const recovered = await runTool(ctx, manager, 'member_state', 'recover-run', {
      action: 'recover', memberRef, workspaceId, requestId: 'recover-run-1',
    })
    expect(recovered.isError).toBe(false)
    if (recovered.isError) return
    const value = recovered.value as { outcome: string; receipt?: unknown; status: { availability: string; presence: string } }
    expect(value.outcome).toBe('runtime-only')
    expect(value.receipt).toBeUndefined()
    expect(value.status).toMatchObject({ availability: 'active', presence: 'available' })
    expect(memberOf(ctx, workspaceId, memberRef)?.member.model).toEqual({ provider: 'mock', model: 'repaired' })
    expect(renderText(teamTools().get('member_state')!, {}, recovered.value)).toContain('Runtime-only')
  })

  it('requires a Workspace for recover and verifies the Member participates in it', async () => {
    const { ctx, workspaceId, workspaces, root } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'recover-scope')
    const second = WorkspaceId('workspace:second')
    workspaces.set(second, { id: second, path: `${root}/second`, attachSession: async () => {} })

    const missing = await runTool(ctx, manager, 'member_state', 'recover-missing', { action: 'recover', memberRef })
    expect(missing.isError).toBe(true)
    if (missing.isError) expect(missing.error.message).toContain('needs workspaceId')

    const foreign = await runTool(ctx, manager, 'member_state', 'recover-foreign', {
      action: 'recover', memberRef, workspaceId: second,
    })
    expect(foreign.isError).toBe(true)
    if (foreign.isError) expect(foreign.error.message).toContain('unknown Member')

    const scoped = await runTool(ctx, manager, 'member_state', 'recover-suspend-scope', {
      action: 'suspend', memberRef, workspaceId,
    })
    expect(scoped.isError).toBe(true)
    if (scoped.isError) expect(scoped.error.message).toContain('only with recover')
  })

  it('joins and leaves another Workspace without moving the Session', async () => {
    const { ctx, workspaceId, workspaces, root } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'traveller')
    const second = WorkspaceId('workspace:second')
    workspaces.set(second, { id: second, path: `${root}/second`, attachSession: async () => {} })
    const sessionId = memberOf(ctx, workspaceId, memberRef)!.member.sessionId

    const joined = await runTool(ctx, manager, 'member_workspace', 'workspace-join', {
      action: 'join', workspaceId: second, memberRef, requestId: 'workspace-join-1',
    })
    expect(joined.isError).toBe(false)
    if (joined.isError) return
    expect((joined.value as { workspaceIds: string[] }).workspaceIds).toEqual([workspaceId, second])
    expect(memberOf(ctx, workspaceId, memberRef)?.member.sessionId).toBe(sessionId)
    expect(renderText(teamTools().get('member_workspace')!, {}, joined.value)).toContain('Session did not move')

    const left = await runTool(ctx, manager, 'member_workspace', 'workspace-leave', {
      action: 'leave', workspaceId: second, memberRef, requestId: 'workspace-leave-1',
    })
    expect(left.isError).toBe(false)
    if (left.isError) return
    expect((left.value as { workspaceIds: string[] }).workspaceIds).toEqual([workspaceId])
    expect(memberOf(ctx, workspaceId, memberRef)?.member.sessionId).toBe(sessionId)

    const creation = await runTool(ctx, manager, 'member_workspace', 'workspace-leave-creation', {
      action: 'leave', workspaceId, memberRef, requestId: 'workspace-leave-creation-1',
    })
    expect(creation.isError).toBe(true)
    if (creation.isError) expect(creation.error.message).toContain('cannot leave its default Workspace')
  })

  it('replays a suspend without undoing a resume that landed after it', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'replay-suspend')

    const suspended = await runTool(ctx, manager, 'member_state', 'replay-suspend-1', {
      action: 'suspend', memberRef, requestId: 'replay-suspend-1',
    })
    expect(suspended.isError).toBe(false)
    if (suspended.isError) return
    expect((suspended.value as { status: { availability: string } }).status.availability).toBe('suspended')
    const resumed = await runTool(ctx, manager, 'member_state', 'replay-resume-1', {
      action: 'resume', memberRef, requestId: 'replay-resume-1',
    })
    expect(resumed.isError).toBe(false)
    if (resumed.isError) return
    expect((resumed.value as { status: { availability: string } }).status.availability).toBe('active')

    // The replay answers its own receipt, and the ledger, the answer and the
    // live runtime all read the state that stands now — a late retry of the
    // suspend must not dispose the generation the resume activated.
    const replayed = await runTool(ctx, manager, 'member_state', 'replay-suspend-2', {
      action: 'suspend', memberRef, requestId: 'replay-suspend-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    const value = replayed.value as { receipt: { operationId: string }; status: { availability: string } }
    expect(value.receipt.operationId).toBe((suspended.value as { receipt: { operationId: string } }).receipt.operationId)
    expect(memberOf(ctx, workspaceId, memberRef)?.member.state).toBe('enabled')
    expect(value.status.availability).toBe('active')
    expect(memberOf(ctx, workspaceId, memberRef)?.availability).toBe('active')
    expect(ctx.agents.get(memberOf(ctx, workspaceId, memberRef)!.member.sessionId)).toBeDefined()
  })

  it('replays a resume without reviving a suspend that landed after it', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'replay-resume')
    const sessionId = memberOf(ctx, workspaceId, memberRef)!.member.sessionId

    await runTool(ctx, manager, 'member_state', 'replay-resume-suspend-1', { action: 'suspend', memberRef, requestId: 'replay-resume-suspend-1' })
    const resumed = await runTool(ctx, manager, 'member_state', 'replay-resume-1', { action: 'resume', memberRef, requestId: 'replay-resume-resume-1' })
    expect(resumed.isError).toBe(false)
    if (resumed.isError) return
    const suspendedAgain = await runTool(ctx, manager, 'member_state', 'replay-resume-suspend-2', {
      action: 'suspend', memberRef, requestId: 'replay-resume-suspend-2',
    })
    expect(suspendedAgain.isError).toBe(false)

    const replayed = await runTool(ctx, manager, 'member_state', 'replay-resume-2', { action: 'resume', memberRef, requestId: 'replay-resume-resume-1' })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    const value = replayed.value as { receipt: { operationId: string }; status: { availability: string } }
    expect(value.receipt.operationId).toBe((resumed.value as { receipt: { operationId: string } }).receipt.operationId)
    expect(memberOf(ctx, workspaceId, memberRef)?.member.state).toBe('suspended')
    expect(value.status.availability).toBe('suspended')
    expect(memberOf(ctx, workspaceId, memberRef)?.availability).toBe('suspended')
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('replays a suspend after the Member was archived', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'replay-archive')

    const suspended = await runTool(ctx, manager, 'member_state', 'replay-archive-suspend', {
      action: 'suspend', memberRef, requestId: 'replay-archive-suspend-1',
    })
    expect(suspended.isError).toBe(false)
    if (suspended.isError) return
    const archived = await runTool(ctx, manager, 'member_state', 'replay-archive-1', {
      action: 'archive', memberRef, requestId: 'replay-archive-1',
    })
    expect(archived.isError).toBe(false)

    const replayed = await runTool(ctx, manager, 'member_state', 'replay-archive-2', {
      action: 'suspend', memberRef, requestId: 'replay-archive-suspend-1',
    })
    expect(replayed.isError).toBe(false)
    if (replayed.isError) return
    const value = replayed.value as { receipt: { operationId: string }; status: { availability: string } }
    expect(value.receipt.operationId).toBe((suspended.value as { receipt: { operationId: string } }).receipt.operationId)
    expect(memberOf(ctx, workspaceId, memberRef)?.member.state).toBe('archived')
    expect(value.status.availability).toBe('archived')
    expect(memberOf(ctx, workspaceId, memberRef)?.availability).toBe('archived')
  })

  it('refuses every new call site for a replaced manager, including writes already queued in the ledger', async () => {
    const { ctx, workspaceId, workspaces, root } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'queued')
    const second = WorkspaceId('workspace:second')
    workspaces.set(second, { id: second, path: `${root}/second`, attachSession: async () => {} })
    const ledger = (ctx.agentTeam as unknown as { ledger: AgentTeamLedger }).ledger
    const table = (ledger as unknown as { table: { put(key: string, value: unknown): Promise<void> } }).table
    const originalPut = table.put.bind(table)
    const holding = Promise.withResolvers<void>()
    let held = 0
    vi.spyOn(table, 'put').mockImplementation(async (key, value) => {
      if ((value as { requestId?: string }).requestId === requestId('queue-hold')) {
        held += 1
        await holding.promise
      }
      return originalPut(key, value)
    })

    // One write holds the ledger's serialized section open, so the three below
    // are genuinely queued behind it rather than merely in flight.
    const heldWrite = ctx.agentTeam.managerCreateMemberForAgent(manager, {
      requestId: requestId('queue-hold'), workspaceId, handle: 'holder', description: '占住账本临界区', model: mockRoute,
    })
    await vi.waitFor(() => { expect(held).toBe(1) })

    const queued = [
      ctx.agentTeam.managerUpdateMemberForAgent(manager, {
        requestId: requestId('queue-update'), memberRef: memberRef as never, description: '排队后撤权',
      }),
      ctx.agentTeam.managerSetMemberStateForAgent(manager, {
        requestId: requestId('queue-state'), memberRef: memberRef as never, action: 'suspend',
      }),
      ctx.agentTeam.managerChangeMemberWorkspaceForAgent(manager, {
        requestId: requestId('queue-workspace'), memberRef: memberRef as never, action: 'join', workspaceId: second,
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
    for (const id of ['queue-update', 'queue-state', 'queue-workspace']) {
      expect(ledger.hasCommitted(requestId(id)), id).toBe(false)
    }
    expect(memberOf(ctx, workspaceId, memberRef)?.member.description).toBe('queued standing')
  })

  it('re-checks the manager inside the lifecycle section a recovery runs in', async () => {
    const { ctx, workspaceId } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'recover-race')
    const team = ctx.agentTeam as unknown as { convergeMemberEffects: (member: unknown) => Promise<void> }
    const originalConverge = team.convergeMemberEffects.bind(team)
    const held = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    vi.spyOn(team, 'convergeMemberEffects').mockImplementation(async member => {
      held.resolve()
      await release.promise
      return originalConverge(member)
    })

    // The suspend holds the Member's lifecycle section; the recovery queues
    // behind it, so its own re-check is what must refuse.
    const suspending = ctx.agentTeam.suspendMember({ requestId: requestId('recover-race-suspend'), memberId: memberRef as never })
    await held.promise
    const recovery = ctx.agentTeam.managerSetMemberStateForAgent(manager, {
      requestId: requestId('recover-race-recover'), memberRef: memberRef as never, action: 'recover', workspaceId,
    })
    await new Promise(resolve => setImmediate(resolve))
    const replaced = await ctx.agentTeam.newManagerSession({ expectedSessionId: manager.id })
    expect(replaced.status).toBe('ready')
    release.resolve()

    await suspending
    await expect(recovery).rejects.toThrow('team manager tool requires the live Team manager Session')
  })

  it('refuses the new tools on a Session that is not the live manager', async () => {
    const { ctx, workspaceId, checkout } = await realHarness()
    provideModelCatalog(ctx)
    const manager = await openManager(ctx)
    const memberRef = await createMember(ctx, manager, workspaceId, 'auth')
    const ordinary = await ctx.agents.create({
      sessionId: SessionId('session-adjust-ordinary'),
      meta: { cwd: checkout, agentPreset: 'standard' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    onTestFinished(async () => { await ordinary.dispose() })
    const calls: Array<[string, Record<string, unknown>]> = [
      ['member_update', { memberRef, description: '越权修改' }],
      ['member_state', { action: 'suspend', memberRef }],
      ['member_workspace', { action: 'join', workspaceId: 'workspace:second', memberRef }],
    ]
    for (const [name, args] of calls) {
      ordinary.agent.ctx.tools.register(teamTools().get(name)!)
      const refused = await runTool(ctx, ordinary.agent, name, `auth-${name}`, args)
      expect(refused.isError, name).toBe(true)
      if (refused.isError) expect(refused.error.message, name).toContain('team manager tool requires the live Team manager Session')
    }
    const memberAgent = ctx.agents.get(memberOf(ctx, workspaceId, memberRef)!.member.sessionId)!
    const memberTools = ctx.tools.schemas(memberAgent as never).map(schema => schema.name)
    for (const absent of ['member_update', 'member_state', 'member_workspace']) expect(memberTools).not.toContain(absent)
  })
})

describe('Member edit idempotency order', () => {
  it('answers an update replay after the provider registry moved', async () => {
    const { ctx, workspaceId } = await realHarness()
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('order-add'), workspaceId, handle: 'order', description: 'route order',
      presetId: 'team-member', model: { provider: 'mock', model: 'first' }, projectRefs: [],
    })
    const memberId = added.status.member.memberId
    const first = await ctx.agentTeam.updateMember({
      requestId: requestId('order-update'), memberId, handle: 'order', description: 'route order',
      model: { provider: 'mock', model: 'second' },
    })

    // The provider registry the Host checks first no longer lists the route.
    const llm = ctx.get('llm') as { listProviders: () => readonly { id: string }[] }
    const providers = vi.spyOn(llm, 'listProviders').mockReturnValue([])
    try {
      const replayed = await ctx.agentTeam.updateMember({
        requestId: requestId('order-update'), memberId, handle: 'order', description: 'route order',
        model: { provider: 'mock', model: 'second' },
      })
      expect(replayed.receipt).toEqual(first.receipt)
    } finally {
      providers.mockRestore()
    }
  })
})
