import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { AgentTeamLedger } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { AgentTeamChannelRef, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness(pool = new MemoryMediaPool()): Promise<{ readonly ctx: Context; readonly facility: DomainFacility }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === alpha ? { id, path: process.cwd(), attachSession: async () => {}, archiveSession: async () => {} } : undefined,
    list: () => [{ id: alpha, path: process.cwd() }],
    archiveSession: async () => {},
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  await ctx.plugin(agentTeamInvariant)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx, facility }
}

/** A cold ledger over the same table: sequential-replay validation must accept the update records. */
function replayLedger(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

/** A media pool preloaded with stored operations, standing in for Host restart. */
function storedPool(records: Array<[string, unknown]>): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('agent_team', agentTeamDomainSpec.version)
  pool.media.set('agent_team', { tables: new Map([['operations', new Map(records)]]), global: null })
  return pool
}

async function seedMember(ctx: Context, channelRef: AgentTeamChannelRef, label: string) {
  return ctx.agentTeam.addMember({
    requestId: requestId(`${label}-add`), workspaceId: alpha,
    handle: label, description: `${label} member`, presetId: 'team-member',
    channelRefs: [channelRef],
  })
}

describe('Agent Team display-fact updates', () => {
  it('renames a Channel durably, resolves retries by request id, and replays cleanly', async () => {
    const { ctx, facility } = await harness()
    const created = await ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })

    // The rename keeps the Channel's immutable identity facts intact.
    const renamed = await ctx.agentTeam.updateChannel({ requestId: requestId('rename'), workspaceId: alpha, channelRef: created.channel.channelRef, name: 'platform', description: 'Infrastructure work' })
    expect(renamed.channel.name).toBe('platform')
    expect(renamed.channel.description).toBe('Infrastructure work')
    expect(renamed.channel.channelRef).toBe(created.channel.channelRef)
    expect(renamed.channel.createdAtSequence).toBe(created.channel.createdAtSequence)

    // Same request id with the same payload resolves without a second record;
    // reusing it with different content collides loudly instead.
    const retried = await ctx.agentTeam.updateChannel({ requestId: requestId('rename'), workspaceId: alpha, channelRef: created.channel.channelRef, name: 'platform', description: 'Infrastructure work' })
    expect(retried.channel.name).toBe('platform')
    await expect(ctx.agentTeam.updateChannel({ requestId: requestId('rename'), workspaceId: alpha, channelRef: created.channel.channelRef, name: 'other', description: 'Infrastructure work' })).rejects.toThrow(/was reused with a different operation or payload/)

    const view = await ctx.agentTeam.view({ workspaceId: alpha, topLevelOnly: true, limit: 10 })
    expect(view.channels.find(channel => channel.channelRef === created.channel.channelRef)?.name).toBe('platform')

    // A cold replay accepts the update record and reproduces the projection.
    const replayed = replayLedger(facility)
    expect(() => replayed.validate()).not.toThrow()
    const replayView = replayed.view({ workspaceId: alpha, topLevelOnly: true })
    expect(replayView.channels.find(channel => channel.channelRef === created.channel.channelRef)).toMatchObject({ name: 'platform', description: 'Infrastructure work' })

    // Blank display facts and unknown refs are rejected before any record lands;
    // clearing the description is a legal edit, matching optional creation.
    await expect(ctx.agentTeam.updateChannel({ requestId: requestId('blank-name'), workspaceId: alpha, channelRef: created.channel.channelRef, name: '   ', description: 'x' })).rejects.toThrow(/name must not be empty/)
    await expect(ctx.agentTeam.updateChannel({ requestId: requestId('unknown-ref'), workspaceId: alpha, channelRef: 'channel:missing' as AgentTeamChannelRef, name: 'x', description: 'y' })).rejects.toThrow(/unknown Channel ref/)
    const cleared = await ctx.agentTeam.updateChannel({ requestId: requestId('clear-description'), workspaceId: alpha, channelRef: created.channel.channelRef, name: 'platform', description: '' })
    expect(cleared.channel.description).toBe('')
    const replayedCleared = replayLedger(facility)
    expect(() => replayedCleared.validate()).not.toThrow()
    expect(replayedCleared.view({ workspaceId: alpha, topLevelOnly: true }).channels.find(channel => channel.channelRef === created.channel.channelRef)).toMatchObject({ name: 'platform', description: '' })
  })

  it('creates a Channel with an empty description and no initial Members', async () => {
    const { ctx } = await harness()
    const created = await ctx.agentTeam.createChannel({ requestId: requestId('bare-channel'), workspaceId: alpha, name: 'ops', description: '' })
    expect(created.channel.description).toBe('')
    expect(created.memberIds).toEqual([])
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('edits Member facts with handle uniqueness, model pinning, and replay validation', async () => {
    const { ctx, facility } = await harness()
    const created = await ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const builder = await seedMember(ctx, created.channel.channelRef, 'builder')
    const reviewer = await seedMember(ctx, created.channel.channelRef, 'reviewer')

    // One durable edit renames the handle, updates the description, and pins
    // a per-Member model while identity and memory paths stay untouched.
    const edited = await ctx.agentTeam.updateMember({ requestId: requestId('edit-builder'), memberId: builder.status.member.memberId, handle: 'architect', description: 'System design owner', model: { provider: 'mock', model: 'pinned' } })
    expect(edited.status.member.handle).toBe('architect')
    expect(edited.status.member.model).toEqual({ provider: 'mock', model: 'pinned' })
    expect(edited.status.member.presetId).toBe(builder.status.member.presetId)
    expect(edited.status.member.sessionId).toBe(builder.status.member.sessionId)
    expect(edited.status.member.privateMemoryPath).toBe(builder.status.member.privateMemoryPath)

    // Handle uniqueness covers every other live Member, case-insensitively;
    // keeping one's own handle is not a collision.
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('collide'), memberId: reviewer.status.member.memberId, handle: 'ARCHITECT', description: 'x' })).rejects.toThrow(/is already active in Workspace/)
    const kept = await ctx.agentTeam.updateMember({ requestId: requestId('keep-handle'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Designs systems' })
    expect(kept.status.member.description).toBe('Designs systems')

    // An absent model clears any override back to Host-default inheritance.
    const cleared = await ctx.agentTeam.updateMember({ requestId: requestId('clear-model'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Designs systems', model: null })
    expect(cleared.status.member.model).toBeUndefined()

    // Retry semantics mirror every other op: same payload replays, drift collides.
    const retried = await ctx.agentTeam.updateMember({ requestId: requestId('clear-model'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Designs systems', model: null })
    expect(retried.status.member.model).toBeUndefined()
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('clear-model'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Changed after commit' })).rejects.toThrow(/was reused with a different operation or payload/)
    // Clearing the description is a legal edit, matching optional creation.
    const clearedDescription = await ctx.agentTeam.updateMember({ requestId: requestId('clear-description'), memberId: builder.status.member.memberId, handle: 'architect', description: '' })
    expect(clearedDescription.status.member.description).toBe('')

    // A pinned reasoning effort rides the model selection and clears with it.
    const pinned = await ctx.agentTeam.updateMember({ requestId: requestId('pin-effort'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Designs systems', model: { provider: 'mock', model: 'pinned', reasoningEffort: 'high' as ReasoningEffortId } })
    expect(pinned.status.member.model).toEqual({ provider: 'mock', model: 'pinned', reasoningEffort: 'high' })
    // A cold replay must preserve a selected effort; this is the path used by
    // Host restart before any Member can be activated again.
    const replayedWithEffort = replayLedger(facility)
    expect(() => replayedWithEffort.validate()).not.toThrow()
    expect(replayedWithEffort.getMember(builder.status.member.memberId)?.model).toEqual({ provider: 'mock', model: 'pinned', reasoningEffort: 'high' })
    const unpinned = await ctx.agentTeam.updateMember({ requestId: requestId('unpin-effort'), memberId: builder.status.member.memberId, handle: 'architect', description: 'Designs systems', model: null })
    expect(unpinned.status.member.model).toBeUndefined()

    // A removed Member freezes against further edits, including its old handle.
    await ctx.agentTeam.removeMember({ requestId: requestId('remove-reviewer'), memberId: reviewer.status.member.memberId })
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('edit-inactive'), memberId: reviewer.status.member.memberId, handle: 'reviewer2', description: 'x' })).rejects.toThrow(/is inactive and can no longer be edited/)

    const replayed = replayLedger(facility)
    expect(() => replayed.validate()).not.toThrow()
    const stored = replayed.listMembers().find(member => member.memberId === builder.status.member.memberId)
    expect(stored).toMatchObject({ handle: 'architect', description: 'Designs systems' })
    expect(stored?.model).toBeUndefined()
    expect(replayed.listMembers().find(member => member.memberId === reviewer.status.member.memberId)?.state).toBe('inactive')
  })

  it('carries Member capabilities through lifecycle operations, edits, replay, and Host restart', async () => {
    const { ctx, facility } = await harness()
    const created = await ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const capabilities = {
      tools: { allow: ['bash', 'read', 'web-search'] },
      skills: { allow: ['code-review'] },
    } as const
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('capabilities-add'), workspaceId: alpha, handle: 'builder', description: 'Builds changes',
      presetId: 'team-member', channelRefs: [created.channel.channelRef], capabilities,
    })
    const memberId = added.status.member.memberId
    expect(added.status.member.capabilities).toEqual(capabilities)

    // Pure intent: unknown tool names commit anyway (divergence is derived at
    // activation, never rejected here), and the status projection exposes the
    // warnings channel empty while capabilities resolve cleanly.
    const hostile = await ctx.agentTeam.addMember({
      requestId: requestId('drift-add'), workspaceId: alpha, handle: 'drift', description: 'Old ledger entry',
      presetId: 'team-member', channelRefs: [], capabilities: { tools: { allow: ['tool-renamed-away'] } },
    })
    expect(hostile.status.member.capabilities).toEqual({ tools: { allow: ['tool-renamed-away'] } })
    expect(hostile.status.capabilityWarnings).toBeUndefined()

    // Lifecycle operations carry the overlay verbatim: suspend and resume
    // rebuild the entity without dropping or duplicating capabilities.
    const suspended = await ctx.agentTeam.suspendMember({ requestId: requestId('suspend'), memberId })
    expect(suspended.status.member.capabilities).toEqual(capabilities)
    const resumed = await ctx.agentTeam.resumeMember({ requestId: requestId('resume'), memberId })
    expect(resumed.status.member.capabilities).toEqual(capabilities)

    // An edit echoing the stored overlay keeps it; the collision guard
    // compares capabilities like model drift.
    const echoed = await ctx.agentTeam.updateMember({ requestId: requestId('echo'), memberId, handle: 'builder', description: 'Still builds', capabilities })
    expect(echoed.status.member.capabilities).toEqual(capabilities)
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('echo'), memberId, handle: 'builder', description: 'Different after commit', capabilities })).rejects.toThrow(/was reused with a different operation or payload/)

    // An explicit null clears the override, mirroring the model semantics;
    // an absent field would keep it. A second update then re-pins a
    // skills-only overlay.
    const kept = await ctx.agentTeam.updateMember({ requestId: requestId('keep-capabilities'), memberId, handle: 'builder', description: 'Still builds' })
    expect(kept.status.member.capabilities).toEqual(capabilities)
    const cleared = await ctx.agentTeam.updateMember({ requestId: requestId('clear-capabilities'), memberId, handle: 'builder', description: 'Still builds', capabilities: null })
    expect(cleared.status.member.capabilities).toBeUndefined()
    const pinned = await ctx.agentTeam.updateMember({ requestId: requestId('pin-skills'), memberId, handle: 'builder', description: 'Still builds', capabilities: { skills: { allow: ['code-review'] } } })
    expect(pinned.status.member.capabilities).toEqual({ skills: { allow: ['code-review'] } })

    // Whitespace-only allow-list names are rejected before any record lands.
    await expect(ctx.agentTeam.updateMember({ requestId: requestId('blank-name'), memberId, handle: 'builder', description: 'Still builds', capabilities: { skills: { allow: ['   '] } } })).rejects.toThrow(/must not be empty/)

    // Cold replay reproduces the overlay and validates the update records.
    const replayed = replayLedger(facility)
    expect(() => replayed.validate()).not.toThrow()
    expect(replayed.getMember(memberId)?.capabilities).toEqual({ skills: { allow: ['code-review'] } })
    expect(replayed.getMember(hostile.status.member.memberId)?.capabilities).toEqual({ tools: { allow: ['tool-renamed-away'] } })

    // Host restart: a fresh process replays the same ledger and restores the
    // durable intent, warnings channel still absent.
    const records = [...facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const revived = await harness(storedPool(records))
    expect(revived.ctx.agentTeam.status()).toMatchObject({ agentMemberCount: 2 })
    const restored = revived.ctx.agentTeam.membersForClient({ workspaceId: alpha }).find(status => status.member.memberId === memberId)
    expect(restored?.member.capabilities).toEqual({ skills: { allow: ['code-review'] } })
    expect(restored?.capabilityWarnings).toBeUndefined()
    expect(() => replayLedger(revived.facility).validate()).not.toThrow()
  })
})

describe('AgentTeam updateMember is a partial update (issue #43 #10)', () => {
  it('keeps an omitted override, clears on null, and updates on an explicit value', async () => {
    const { ctx } = await harness()
    const added = await ctx.agentTeam.addMember({
      requestId: requestId('partial-add'), workspaceId: alpha, handle: 'builder', description: 'Builds',
      presetId: 'team-member', channelRefs: [],
      model: { provider: 'mock', model: 'pinned' },
      capabilities: { skills: { allow: ['alpha'] } },
    })
    const memberId = added.status.member.memberId

    // Omitted fields keep what the Member has; only the handle changes.
    const handleOnly = await ctx.agentTeam.updateMember({
      requestId: requestId('partial-handle'), memberId, handle: 'architect', description: 'Builds',
    })
    expect(handleOnly.status.member.handle).toBe('architect')
    expect(handleOnly.status.member.model).toEqual({ provider: 'mock', model: 'pinned' })
    expect(handleOnly.status.member.capabilities).toEqual({ skills: { allow: ['alpha'] } })

    // An explicit value replaces the override.
    const replaced = await ctx.agentTeam.updateMember({
      requestId: requestId('partial-replace'), memberId, handle: 'architect', description: 'Builds',
      model: { provider: 'mock', model: 'other' },
    })
    expect(replaced.status.member.model).toEqual({ provider: 'mock', model: 'other' })
    expect(replaced.status.member.capabilities).toEqual({ skills: { allow: ['alpha'] } })

    // Explicit null clears only the named field.
    const cleared = await ctx.agentTeam.updateMember({
      requestId: requestId('partial-clear'), memberId, handle: 'architect', description: 'Builds',
      model: null,
    })
    expect(cleared.status.member.model).toBeUndefined()
    expect(cleared.status.member.capabilities).toEqual({ skills: { allow: ['alpha'] } })
  })
})
