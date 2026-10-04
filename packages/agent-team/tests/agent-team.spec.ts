import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// Every test here boots a Host over a throwaway tree, and the windows lane has
// stretched one cold replay to 2.7s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21). The SQLite case below keeps its own 30s argument.
vi.setConfig({ testTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '../src/vendor/storage-sqlite/index.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { DEFAULT_GATE_IDLE_MS, DEFAULT_GATE_TOKENS } from '@wowyuarm/dsh-context-continuity'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { snapshotReadData, receiptReadData } from './helpers/legacy-thread-read.ts'
import AgentTeam, { AGENT_TEAM_HUMAN_HANDLE, AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_INITIALIZE_REQUEST_ID } from '../src/index.ts'
import { AgentTeamLedger, agentTeamHumanActor, isThreadReadSnapshot } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTask, AgentTeamTaskRef, AgentTeamThreadReadData, AgentTeamThreadReadOperation, AgentTeamThreadReadReceipt, AgentTeamThreadReadResult, AgentTeamThreadRef } from '../src/types.ts'

interface TeamHarness {
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly facility: DomainFacility
}

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness(
  pool = new MemoryMediaPool(),
  workspaceIds = [alpha],
  config?: { readonly gate?: { readonly tokens?: number; readonly idleMs?: number; readonly judgeTimeoutMs?: number } },
): Promise<TeamHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => workspaceIds.includes(id) ? { id, path: process.cwd(), attachSession: async () => {} } : undefined,
    list: () => workspaceIds.map(id => ({ id, path: process.cwd() })),
    archiveSession: async () => {},
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = config === undefined ? await ctx.plugin(AgentTeam) : await ctx.plugin(AgentTeam, config)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx, fiber, facility }
}

async function sqliteHarness(path: string): Promise<TeamHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path, journalMode: 'delete' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', { get: (id: WorkspaceId) => ({ id, path: process.cwd(), attachSession: async () => {}, archiveSession: async () => {} }), list: () => [] })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll(); await backend.close() })
  return { ctx, fiber, facility }
}

function storedPool(records: Array<[string, unknown]>, version: number = agentTeamDomainSpec.version): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('agent_team', version)
  pool.media.set('agent_team', { tables: new Map([['operations', new Map(records)]]), global: null })
  return pool
}

function committed<T extends { readonly kind: string }>(result: T): Extract<T, { readonly kind: 'committed' }> {
  if (result.kind !== 'committed') throw new Error(`expected committed result, received ${result.kind}`)
  return result as Extract<T, { readonly kind: 'committed' }>
}

function withTask<T extends { readonly task?: AgentTeamTask }>(result: T): T & { readonly task: AgentTeamTask } {
  if (result.task === undefined) throw new Error('expected Task overlay')
  return result as T & { readonly task: AgentTeamTask }
}

function replayLedger(test: TeamHarness): AgentTeamLedger {
  return new AgentTeamLedger(test.facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

async function addLedgerMember(
  ledger: AgentTeamLedger,
  channelRef: string | undefined,
  memberId = `member:agent-${crypto.randomUUID()}`,
  description = 'Test Agent',
  handle = memberId.slice('member:'.length),
): Promise<{ readonly member: AgentTeamAgentMember; readonly actor: AgentTeamMemberActor }> {
  const member: AgentTeamAgentMember = {
    memberId: memberId as never,
    sessionId: SessionId(`session:${memberId}`),
    workspaceId: alpha,
    handle,
    description,
    presetId: 'team-member',
    privateMemoryPath: `/tmp/${memberId}`,
    state: 'enabled',
  }
  await ledger.addMember({ requestId: requestId(`add:${memberId}`), actor: agentTeamHumanActor(), member, handle: member.handle,
    description: member.description, presetId: member.presetId, workspaceId: alpha,
    channelRefs: channelRef === undefined ? [] : [channelRef as never] })
  return { member, actor: { kind: 'member', memberId: member.memberId, handle: member.handle } }
}

describe('AgentTeam durable Thread Attention ledger', () => {
  it('replays Workspace participation without moving the default Workspace or Session', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    const joinRequest = { requestId: requestId('workspace-join'), workspaceId: beta, memberId: member.memberId, actor: agentTeamHumanActor() }
    expect(ledger.workspacesOf(member.memberId)).toEqual([alpha])
    expect(() => ledger.view({ workspaceId: beta }, member.memberId)).toThrow(/another Workspace/)
    const joined = await ledger.joinWorkspace(joinRequest)
    expect(joined.committed).toBe(true)
    expect((await ledger.joinWorkspace(joinRequest)).committed).toBe(false)
    await expect(ledger.joinWorkspace({ ...joinRequest, workspaceId: alpha })).rejects.toThrow()
    expect(ledger.getMember(member.memberId)).toEqual(member)
    expect(ledger.view({ workspaceId: beta }, member.memberId).workspaces).toEqual([
      { workspaceId: alpha, default: true }, { workspaceId: beta, default: false },
    ])
    const channel = (await ledger.createChannel({ requestId: requestId('joined-channel'), workspaceId: beta,
      name: 'joined', description: '', memberIds: [member.memberId], actor: agentTeamHumanActor() })).value.channel
    const sent = committed((await ledger.sendMessage({ requestId: requestId('joined-message'), workspaceId: beta,
      channelRef: channel.channelRef, body: 'Working in beta', asTask: false, actor })).value)
    expect(sent.message.sender).toBe(member.memberId)
    const replay = replayLedger(test)
    expect(replay.workspacesOf(member.memberId)).toEqual([alpha, beta])
    expect(replay.getMember(member.memberId)).toEqual(member)
    expect(replay.view({ workspaceId: beta }, member.memberId).channels).toContainEqual(channel)
    replay.validate()
  })

  it('withdraws only the target Workspace and rejects subsequent work there', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    await ledger.joinWorkspace({ requestId: requestId('join-beta'), workspaceId: beta, memberId: member.memberId, actor: agentTeamHumanActor() })
    const claims = []
    for (const workspaceId of [alpha, beta]) {
      const channel = (await ledger.createChannel({ requestId: requestId(`channel-${workspaceId}`), workspaceId,
        name: 'work', description: '', memberIds: [member.memberId], actor: agentTeamHumanActor() })).value.channel
      const sent = withTask(committed((await ledger.sendMessage({ requestId: requestId(`message-${workspaceId}`), workspaceId,
        channelRef: channel.channelRef, body: 'Task', asTask: true, actor })).value))
      const claim = committed((await ledger.changeClaim({ requestId: requestId(`claim-${workspaceId}`), workspaceId,
        taskRef: sent.task.taskRef, baseRevision: sent.thread.revision, action: 'claim', direction: 'Implement', actor })).value)
      claims.push({ workspaceId, channel, sent, claim })
    }
    const leaveRequest = { requestId: requestId('leave-beta'), workspaceId: beta, memberId: member.memberId, actor: agentTeamHumanActor() }
    const left = await ledger.leaveWorkspace(leaveRequest)
    expect(left.value.releasedClaims.map(claim => claim.claimRef)).toEqual([claims[1]!.claim.claim.claimRef])
    expect(left.value.removedAttention).toContainEqual({ memberId: member.memberId, threadRef: claims[1]!.sent.thread.threadRef })
    expect((await ledger.leaveWorkspace(leaveRequest)).committed).toBe(false)
    expect(ledger.workspacesOf(member.memberId)).toEqual([alpha])
    expect(ledger.getMember(member.memberId)).toEqual(member)
    expect(ledger.listClaims(actor, { workspaceId: alpha, taskRef: claims[0]!.sent.task.taskRef }).claims[0]?.state).toBe('active')
    expect(() => ledger.view({ workspaceId: beta }, member.memberId)).toThrow(/another Workspace/)
    expect(ledger.view({ workspaceId: beta }).members).not.toContainEqual({ channelRef: claims[1]!.channel.channelRef, memberId: member.memberId })
    await expect(ledger.reply({ requestId: requestId('reply-after-leave'), workspaceId: beta,
      threadRef: claims[1]!.sent.thread.threadRef, baseRevision: claims[1]!.claim.thread.revision, body: 'Late reply', actor })).rejects.toThrow(/another Workspace/)
    await expect(ledger.leaveWorkspace({ ...leaveRequest, requestId: requestId('leave-default'), workspaceId: alpha })).rejects.toThrow(/default Workspace/)
    const replay = replayLedger(test)
    expect(replay.workspacesOf(member.memberId)).toEqual([alpha])
    replay.validate()
    await replay.joinWorkspace({ ...leaveRequest, requestId: requestId('rejoin-beta') })
    expect(replay.view({ workspaceId: beta }, member.memberId).channels).toEqual([])
  })

  it('checks handle collisions across all participations, including suspended Members', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const ledger = replayLedger(test)
    const first = await addLedgerMember(ledger, undefined, 'member:first', '', 'builder')
    const second = await addLedgerMember(ledger, undefined, 'member:second', '', 'reviewer')
    await ledger.suspendMember({ requestId: requestId('suspend'), memberId: first.member.memberId, actor: agentTeamHumanActor() })
    await ledger.joinWorkspace({ requestId: requestId('join-first'), workspaceId: beta, memberId: first.member.memberId, actor: agentTeamHumanActor() })
    expect(ledger.getMember(first.member.memberId)?.state).toBe('suspended')
    const other = { ...second.member, memberId: 'member:beta-peer' as AgentTeamAgentMember['memberId'], workspaceId: beta, sessionId: SessionId('session:beta-peer') }
    await ledger.addMember({ requestId: requestId('beta-peer'), workspaceId: beta, member: other,
      handle: 'peer', description: '', presetId: 'team-member', channelRefs: [], actor: agentTeamHumanActor() })
    await expect(ledger.updateMember({ requestId: requestId('rename-collision'), memberId: first.member.memberId,
      handle: 'PEER', description: '', actor: agentTeamHumanActor() })).rejects.toThrow(/already active/)
    await ledger.updateMember({ requestId: requestId('rename-second'), memberId: second.member.memberId,
      handle: 'peer', description: '', actor: agentTeamHumanActor() })
    await expect(ledger.joinWorkspace({ requestId: requestId('join-collision'), workspaceId: beta,
      memberId: second.member.memberId, actor: agentTeamHumanActor() })).rejects.toThrow(/already active/)
    replayLedger(test).validate()
  })

  it('boots a v1 empty Team and rejects old ledger media', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    expect(first.ctx.agentTeam.status()).toEqual({ initialized: true, sequence: 1, operationCount: 1, channelCount: 0, agentMemberCount: 0, humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID })
    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.values()]
    await first.fiber.dispose()
    const replay = await first.ctx.plugin(AgentTeam)
    expect(first.ctx.agentTeam.status()).toMatchObject({ sequence: 1 })
    expect([...pool.media.get('agent_team')!.tables.get('operations')!.values()]).toEqual(records)
    await replay.dispose()
    await expect(harness(storedPool([], 9))).rejects.toThrow(/stamped v9, descriptor wants v1/)
  })

  it('creates a top-level Task, starts creator Attention, and returns no own unread work', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Investigate the regression' })))
    expect(sent).toMatchObject({ message: { topLevel: true, sender: AGENT_TEAM_HUMAN_MEMBER_ID }, task: { status: 'todo' }, attention: [expect.objectContaining({ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, startSequence: sent.message.sequence, readThroughSequence: sent.message.sequence - 1 })] })
    // The creator's own Message is not unread for them, and the Thread they
    // started is already theirs to step back into: participation — writing a
    // Message there — is what admits the recent slice, so it is in the tail
    // from its first Message on, with nobody else in it yet.
    expect(test.ctx.agentTeam.inbox({ workspaceId: alpha })).toMatchObject({ items: [], totalUnreadCount: 0, totalDirectCount: 0,
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: sent.task.threadRef }) })] })
    const attention = await test.ctx.agentTeam.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: sent.task.taskRef, action: 'unfollow' })
    expect(attention.attention).toBeUndefined()
    await expect(test.ctx.agentTeam.changeAttention({ requestId: requestId('again'), workspaceId: alpha, taskRef: sent.task.taskRef, action: 'unfollow' })).rejects.toThrow(/already unfollowed/)
    // Unfollowing stops the notifications, not the record: the Thread stays in
    // the tail of a reader who wrote in it.
    expect(test.ctx.agentTeam.inbox({ workspaceId: alpha })).toMatchObject({ recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: sent.task.threadRef }) })] })
  })

  it('accepts a Task early and completes active Claims inside the same operation', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    expect(claimed.task.status).toBe('in_progress')

    const afterClaimRead = (await ledger.readThread({ requestId: requestId('read1'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    const accepted = committed((await ledger.changeTask({ requestId: requestId('accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: afterClaimRead.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(accepted.task).toMatchObject({ status: 'done', resolution: 'accepted' })
    expect(accepted.claims).toHaveLength(1)
    expect(accepted.claims[0]).toMatchObject({ claimRef: claimed.claim.claimRef, owner: member.memberId, state: 'done' })
    expect(accepted.activity.kind).toBe('accept')
    expect(accepted.activity.completedClaimRefs).toEqual([claimed.claim.claimRef])

    // The completed Claim's owner wakes with an activity marker telling them
    // the Human accepted over their open Claim.
    const inbox = ledger.inbox(actor, { workspaceId: alpha })
    expect(inbox.totalUnreadCount).toBeGreaterThan(0)

    // Cold replay reproduces the same markers and validates the transition.
    const cold = replayLedger(test)
    expect(() => cold.validate()).not.toThrow()
    const replayed = cold.inbox(actor, { workspaceId: alpha })
    expect(replayed.items.map(item => item.thread.threadRef)).toEqual(inbox.items.map(item => item.thread.threadRef))
  })

  it('accepts an unclaimed todo Task directly and stays honest about the empty Claim list', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    expect(started.task.status).toBe('todo')
    const ledger = replayLedger(test)

    const accepted = committed((await ledger.changeTask({ requestId: requestId('accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).value)
    // Direct acceptance of work finished outside the ledger: no Claims to
    // complete, so the activity carries no completion list. The acceptance
    // list is still written (explicitly empty): it is the durable
    // discriminator every done Claim owner is notified from, even when the
    // list is empty, and its presence distinguishes new accepts from legacy
    // records that carry neither list.
    expect(accepted.task).toMatchObject({ status: 'done', resolution: 'accepted' })
    expect(accepted.claims).toEqual([])
    expect(accepted.activity.kind).toBe('accept')
    expect(accepted.activity.completedClaimRefs).toBeUndefined()
    expect(accepted.activity.acceptedClaimRefs).toEqual([])

    const view = ledger.view({ workspaceId: alpha })
    expect(view.activities).toEqual([expect.objectContaining({ kind: 'accept', taskRef: started.task.taskRef })])
    expect(view.tasks.find(task => task.taskRef === started.task.taskRef)).toMatchObject({ status: 'done', resolution: 'accepted' })
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toMatchObject({ items: [], totalUnreadCount: 0, totalDirectCount: 0,
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.task.threadRef }) })] })
    // Cold replay reproduces the same projection and validates the transition.
    const cold = replayLedger(test)
    expect(() => cold.validate()).not.toThrow()
    expect(cold.view({ workspaceId: alpha }).tasks.find(task => task.taskRef === started.task.taskRef)).toMatchObject({ status: 'done', resolution: 'accepted' })
  })

  it('notifies every done Claim owner on a normal accept and dedupes multi-claim owners into one marker', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef, 'member:agent-ship', 'ship')
    const { actor: actorTwo } = await addLedgerMember(ledger, channel.channel.channelRef, 'member:agent-fix', 'fix')
    // Two Claims: the same owner finished one earlier (normal flow, the claim
    // was done BEFORE the accept), another member still holds an active one.
    const firstRead = (await ledger.readThread({ requestId: requestId('read-claim-1'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    const firstClaim = committed((await ledger.changeClaim({ requestId: requestId('claim-1'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'one', baseRevision: firstRead.thread.revision, actor })).value)
    const readDone1 = (await ledger.readThread({ requestId: requestId('read-done-1'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    committed((await ledger.changeClaim({ requestId: requestId('done-1'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'done', claimRef: firstClaim.claim.claimRef, baseRevision: readDone1.thread.revision, actor })).value)
    const secondRead = (await ledger.readThread({ requestId: requestId('read-claim-2'), workspaceId: alpha, taskRef: started.task.taskRef, actor: actorTwo })).value
    const activeClaim = committed((await ledger.changeClaim({ requestId: requestId('claim-2'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'two', baseRevision: secondRead.thread.revision, actor: actorTwo })).value)
    // The finished owner claims a second direction and finishes it too: both
    // done Claims belong to the same owner and must produce ONE marker.
    const thirdRead = (await ledger.readThread({ requestId: requestId('read-claim-3'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    const secondOwnClaim = committed((await ledger.changeClaim({ requestId: requestId('claim-3'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'three', baseRevision: thirdRead.thread.revision, actor })).value)
    const readDone3 = (await ledger.readThread({ requestId: requestId('read-done-3'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    committed((await ledger.changeClaim({ requestId: requestId('done-3'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'done', claimRef: secondOwnClaim.claim.claimRef, baseRevision: readDone3.thread.revision, actor })).value)

    const humanRead = (await ledger.readThread({ requestId: requestId('human-read-accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    const accepted = committed((await ledger.changeTask({ requestId: requestId('normal-accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    // Early acceptance still completes the active Claim; the acceptance list
    // covers every done Claim at commit time — both the pre-finished pair and
    // the atomically completed one.
    expect(accepted.activity.completedClaimRefs).toEqual([activeClaim.claim.claimRef])
    expect(accepted.activity.acceptedClaimRefs).toEqual([firstClaim.claim.claimRef, activeClaim.claim.claimRef, secondOwnClaim.claim.claimRef].sort())

    // The previously-done owner wakes from a normal accept — the old ledger
    // stayed silent here — with exactly one unread item for this Thread.
    const inbox = ledger.inbox(actor, { workspaceId: alpha })
    expect(inbox.totalUnreadCount).toBe(1)
    expect(inbox.items[0]?.thread.threadRef).toBe(started.task.threadRef)
    const cold = replayLedger(test)
    expect(() => cold.validate()).not.toThrow()
    expect(cold.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(1)
  })

  it('cold-replays a legacy plain accept without the acceptance discriminator and keeps it silent', async () => {
    // The pre-discriminator ledger shape: a plain accept whose activity
    // carries NEITHER claim list and whose inbox delta is empty. The
    // validator must verify this shape exactly as recorded — computing the
    // marker recipients from today's all-done rule would fail the replay of
    // every existing ledger. The done owner has unfollowed after finishing
    // (legal once its Claim is no longer active), so the accept marker is
    // its only possible wake: the discriminator is what makes the
    // difference between the new shape (1 unread) and the legacy shape
    // (silent, exactly as recorded).
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef, 'member:agent-done', 'done-owner')
    const memberRead = (await ledger.readThread({ requestId: requestId('member-legacy-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    const claim = committed((await ledger.changeClaim({ requestId: requestId('legacy-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'legacy', baseRevision: memberRead.thread.revision, actor })).value)
    const readDone = (await ledger.readThread({ requestId: requestId('legacy-done-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    committed((await ledger.changeClaim({ requestId: requestId('legacy-done'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'done', claimRef: claim.claim.claimRef, baseRevision: readDone.thread.revision, actor })).value)
    // The finished owner steps back from the Thread before the accept. The
    // attention change does not advance the Thread revision, so the accept
    // below still bases on the human read.
    const unfollowed = (await ledger.changeAttention({ requestId: requestId('legacy-unfollow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'unfollow', actor })).value
    expect(unfollowed.attention).toBeUndefined()
    const humanRead = (await ledger.readThread({ requestId: requestId('legacy-human-read'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    const accepted = committed((await ledger.changeTask({ requestId: requestId('legacy-accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(accepted.activity.completedClaimRefs).toBeUndefined()
    expect(accepted.activity.acceptedClaimRefs).toEqual([claim.claim.claimRef])
    // New-shape accept: the unfollowed done owner still learns about the
    // acceptance through the discriminator's marker; assert that here so
    // the rewrite below is a real downgrade to the legacy shape.
    expect(ledger.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(1)

    // Rewrite the recorded operation to the legacy shape: strip the
    // discriminator and empty the inbox delta, as an old ledger recorded it.
    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.entries()]
    await test.fiber.dispose()
    cleanups.pop()
    const legacy = records.map(([key, operation]) => {
      if (typeof operation !== 'object' || operation === null || (operation as AgentTeamOperation).kind !== 'team/task-changed') return [key, operation] as [string, unknown]
      const changed = operation as Extract<AgentTeamOperation, { kind: 'team/task-changed' }>
      if (changed.data.activity.activityRef !== accepted.activity.activityRef) return [key, operation] as [string, unknown]
      const { acceptedClaimRefs: _stripped, ...activity } = changed.data.activity as { acceptedClaimRefs?: unknown }
      return [key, { ...changed, data: { ...changed.data, activity, inbox: { attention: { set: [], removed: [] }, directMarkers: { added: [], removed: [] }, activityMarkers: { added: [], removed: [] } } } }] as [string, unknown]
    })
    const revived = await harness(storedPool(legacy))
    expect(() => replayLedger(revived).validate()).not.toThrow()
    // Legacy plain accept: the unfollowed done owner stays silent, exactly
    // as recorded — no discriminator, no marker, no ordinary visibility.
    const revivedLedger = replayLedger(revived)
    expect(revivedLedger.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(0)
  })

  it('records DMs as audit-only operations with idempotent retries and unchanged projections', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const sender = await addLedgerMember(ledger, channel.channel.channelRef, 'member:sender', 'sender')
    const receiver = await addLedgerMember(ledger, channel.channel.channelRef, 'member:receiver', 'receiver')

    const before = ledger.view({ workspaceId: alpha })
    const beforeInbox = ledger.inbox(receiver.actor, { workspaceId: alpha })
    const beforeStatus = ledger.status()

    const dm = (await ledger.sendDm({ requestId: requestId('dm-1'), workspaceId: alpha,
      recipientMemberId: receiver.member.memberId, body: 'quick check: is the build green?', actor: sender.actor })).value
    expect(dm.receipt).toMatchObject({ sequence: beforeStatus.sequence + 1 })
    expect(dm.recipient.memberId).toBe(receiver.member.memberId)

    // Audit-only: no Thread, Task, Message, or channel membership appears.
    const after = ledger.view({ workspaceId: alpha })
    expect(after.threads).toHaveLength(before.threads.length)
    expect(after.items).toHaveLength(before.items.length)
    expect(after.claims).toHaveLength(before.claims.length)
    // No Inbox semantics: unread/direct counts stay untouched for both sides.
    expect(ledger.inbox(receiver.actor, { workspaceId: alpha })).toEqual(beforeInbox)
    expect(ledger.inbox(sender.actor, { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0 })

    // Idempotent retry: same requestId resolves the same receipt, no second append.
    const retry = (await ledger.sendDm({ requestId: requestId('dm-1'), workspaceId: alpha,
      recipientMemberId: receiver.member.memberId, body: 'quick check: is the build green?', actor: sender.actor })).value
    expect(retry.receipt).toEqual(dm.receipt)
    expect(ledger.status().operationCount).toBe(beforeStatus.operationCount + 1)

    // The adjacent-context lookup finds the exchange in both directions.
    expect(ledger.dmHistoryBetween(receiver.member.sessionId, sender.member.memberId)).toContain('quick check')
    expect(ledger.dmHistoryBetween(sender.member.sessionId, receiver.member.memberId)).toContain('quick check')

    // Cold replay validates the audit-only record.
    const cold = replayLedger(test)
    expect(() => cold.validate()).not.toThrow()
    expect(cold.dmHistoryBetween(receiver.member.sessionId, sender.member.memberId)).toContain('quick check')
  })

  it('rejects DMs to other Workspaces, the Human, and the sender itself', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    // A second Workspace with its own Member: cross-workspace DM must fail.
    const betaChannel = await test.ctx.agentTeam.createChannel({ requestId: requestId('beta-channel'), workspaceId: beta, name: 'beta', description: '' })
    const ledger = replayLedger(test)
    const sender = await addLedgerMember(ledger, channel.channel.channelRef, 'member:sender', 'sender')
    const betaLedgerMember = {
      memberId: 'member:beta-peer' as never,
      sessionId: SessionId('session:beta-peer'),
      workspaceId: beta,
      handle: 'beta-peer', description: 'Beta peer', presetId: 'team-member',
      privateMemoryPath: '/tmp/beta-peer', state: 'enabled' as const,
    }
    await ledger.addMember({ requestId: requestId('add-beta'), actor: agentTeamHumanActor(), member: betaLedgerMember, handle: betaLedgerMember.handle,
      description: betaLedgerMember.description, presetId: betaLedgerMember.presetId, workspaceId: beta,
      channelRefs: [betaChannel.channel.channelRef] })
    const receiver = await addLedgerMember(ledger, channel.channel.channelRef, 'member:receiver', 'receiver')

    await expect(ledger.sendDm({ requestId: requestId('dm-cross'), workspaceId: alpha,
      recipientMemberId: 'member:beta-peer' as never, body: 'hi', actor: sender.actor })).rejects.toThrow(/not in Workspace/)
    await expect(ledger.sendDm({ requestId: requestId('dm-human'), workspaceId: alpha,
      recipientMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, body: 'hi', actor: sender.actor })).rejects.toThrow(/Agent Member/)
    await expect(ledger.sendDm({ requestId: requestId('dm-self'), workspaceId: alpha,
      recipientMemberId: sender.member.memberId, body: 'hi', actor: sender.actor })).rejects.toThrow(/themselves/)
    await expect(ledger.sendDm({ requestId: requestId('dm-empty'), workspaceId: alpha,
      recipientMemberId: receiver.member.memberId, body: '   ', actor: sender.actor })).rejects.toThrow(/empty/)
  })

  it('closes an unclaimed todo Task through the close path, not acceptance', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const closed = committed((await ledger.changeTask({ requestId: requestId('close'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'close', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(closed.task).toMatchObject({ status: 'closed', resolution: 'closed' })
    expect(closed.activity.kind).toBe('close')
    const reopened = committed((await ledger.changeTask({ requestId: requestId('reopen'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'reopen', baseRevision: closed.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(reopened.task).toMatchObject({ status: 'todo', resolution: 'open' })
  })

  it('resolves branded Task refs to navigation facts and omits unknown refs', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const first = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('first'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'first task' })))
    const second = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('second'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'second task' })))
    const resolved = test.ctx.agentTeam.resolveTaskRefs({ workspaceId: alpha, taskRefs: [first.task.taskRef, second.task.taskRef, 'task:00000000-0000-4000-8000-000000000000' as AgentTeamTaskRef] })
    expect(resolved.resolved).toEqual([
      { taskRef: first.task.taskRef, channelRef: channel.channel.channelRef, threadRef: first.thread.threadRef, taskNumber: 1 },
      { taskRef: second.task.taskRef, channelRef: channel.channel.channelRef, threadRef: second.thread.threadRef, taskNumber: 2 },
    ])
    // Display numbers are per home Channel: a second Channel's first Task
    // resolves as #1 even though it is the workspace's third Task, and a
    // Channel-less view (inbox renders) numbers it the same way.
    const other = await test.ctx.agentTeam.createChannel({ requestId: requestId('other'), workspaceId: alpha, name: 'audit', description: 'Audit trail' })
    const audit = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('audit'), workspaceId: alpha, channelRef: other.channel.channelRef, body: 'audit task' })))
    const crossChannel = test.ctx.agentTeam.resolveTaskRefs({ workspaceId: alpha, taskRefs: [audit.task.taskRef, second.task.taskRef] })
    expect(crossChannel.resolved).toEqual([
      { taskRef: audit.task.taskRef, channelRef: other.channel.channelRef, threadRef: audit.thread.threadRef, taskNumber: 1 },
      { taskRef: second.task.taskRef, channelRef: channel.channel.channelRef, threadRef: second.thread.threadRef, taskNumber: 2 },
    ])
    const channelless = test.ctx.agentTeam.view({ workspaceId: alpha })
    expect(channelless.taskNumbers).toContainEqual({ taskRef: audit.task.taskRef, taskNumber: 1 })
    expect(channelless.taskNumbers).toContainEqual({ taskRef: second.task.taskRef, taskNumber: 2 })
    // An unregistered workspace is rejected before any lookup.
    expect(() => test.ctx.agentTeam.resolveTaskRefs({ workspaceId: beta, taskRefs: [first.task.taskRef] })).toThrow(/unknown Workspace/)
  })

  it('resolves branded Thread refs to navigation facts and omits unknown refs', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('thread-refs-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const first = committed(await test.ctx.agentTeam.sendMessage({ asTask: false, requestId: requestId('thread-refs-first'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'alpha discussion opens here' }))
    const second = committed(await test.ctx.agentTeam.sendMessage({ asTask: false, requestId: requestId('thread-refs-second'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'beta discussion opens here' }))
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('thread-refs-task'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'task work' })))
    // Taskless Threads resolve with their opening-line title and no Task
    // overlay; taskful Threads carry the Task home alongside the same title.
    // Unknown refs are omitted so message bodies render them as plain text.
    const resolved = test.ctx.agentTeam.resolveThreadRefs({ workspaceId: alpha, threadRefs: [first.thread.threadRef, second.thread.threadRef, started.thread.threadRef, 'thread:00000000-0000-4000-8000-000000000000' as AgentTeamThreadRef] })
    expect(resolved.resolved).toEqual([
      { threadRef: first.thread.threadRef, channelRef: channel.channel.channelRef, title: 'alpha discussion opens here' },
      { threadRef: second.thread.threadRef, channelRef: channel.channel.channelRef, title: 'beta discussion opens here' },
      { threadRef: started.thread.threadRef, channelRef: channel.channel.channelRef, taskRef: started.task.taskRef, taskNumber: 1, title: 'task work' },
    ])
    // The abbreviated spelling from the report (8 hex chars) resolves when
    // unambiguous, answering with the full ref the click path navigates by.
    const abbreviated = `thread:${first.thread.threadRef.slice('thread:'.length).replaceAll('-', '').slice(0, 8).toLowerCase()}` as AgentTeamThreadRef
    expect(test.ctx.agentTeam.resolveThreadRefs({ workspaceId: alpha, threadRefs: [abbreviated] }).resolved).toEqual([
      { threadRef: first.thread.threadRef, channelRef: channel.channel.channelRef, title: 'alpha discussion opens here' },
    ])
    // The same abbreviation addresses the bounded Thread view: the filter
    // compares the resolved full key, not the authored spelling (task #17 root
    // cause — an empty view here is what made chip clicks silently no-op).
    expect(test.ctx.agentTeam.view({ workspaceId: alpha, threadRef: abbreviated }).items).toHaveLength(1)
    // An unregistered workspace is rejected before any lookup.
    expect(() => test.ctx.agentTeam.resolveThreadRefs({ workspaceId: beta, threadRefs: [first.thread.threadRef] })).toThrow(/unknown Workspace/)
  })

  it('caps resolved Thread chip titles at 40 characters', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('thread-title-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const exact = `x${'y'.repeat(38)}z`
    const exactThread = committed(await test.ctx.agentTeam.sendMessage({ asTask: false, requestId: requestId('thread-title-exact'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: exact }))
    // A 40-character opening line passes through untouched; anything longer
    // is cut to 39 characters plus the mark so chips share the line with prose.
    expect(test.ctx.agentTeam.resolveThreadRefs({ workspaceId: alpha, threadRefs: [exactThread.thread.threadRef] }).resolved).toEqual([
      { threadRef: exactThread.thread.threadRef, channelRef: channel.channel.channelRef, title: exact },
    ])
    const longThread = committed(await test.ctx.agentTeam.sendMessage({ asTask: false, requestId: requestId('thread-title-long'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: `${'a'.repeat(100)}\nsecond line` }))
    expect(test.ctx.agentTeam.resolveThreadRefs({ workspaceId: alpha, threadRefs: [longThread.thread.threadRef] }).resolved).toEqual([
      { threadRef: longThread.thread.threadRef, channelRef: channel.channel.channelRef, title: `${'a'.repeat(39)}…` },
    ])
  })

  it('adds an Agent with initial Channel membership and persists no Inbox delivery facts', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const member = await test.ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: alpha, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    expect(member.status.member).toMatchObject({ workspaceId: alpha, handle: 'reviewer' })
    expect(test.ctx.agentTeam.view({ workspaceId: alpha }).members).toEqual([{ channelRef: channel.channel.channelRef, memberId: member.status.member.memberId }])
    const records = [...(test.facility.get('agent_team')?.table('operations').entries() ?? [])].map(([, operation]) => JSON.stringify(operation))
    expect(records.join('\n')).not.toContain('delivery')
    expect(records.join('\n')).not.toContain('follow-changed')
  })

  it('opens a persisted Member with no initial Channels in a fresh Host', async () => {
    const first = await harness()
    const ledger = replayLedger(first)
    await addLedgerMember(ledger, undefined, 'member:bare', '')
    const records = [...first.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const revived = await harness(storedPool(records))
    expect(revived.ctx.agentTeam.status()).toMatchObject({ agentMemberCount: 1 })
    expect(() => replayLedger(revived).validate()).not.toThrow()
  })

  it('opens a persisted Channel with no initial Members in a fresh Host', async () => {
    const first = await harness()
    await first.ctx.agentTeam.createChannel({ requestId: requestId('bare-channel'), workspaceId: alpha, name: 'ops', description: '' })
    const records = [...first.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const revived = await harness(storedPool(records))
    expect(revived.ctx.agentTeam.status()).toMatchObject({ channelCount: 1, agentMemberCount: 0 })
    expect(() => replayLedger(revived).validate()).not.toThrow()
  })

  it('starts Agent Attention and direct Inbox delivery after a top-level mention without confirmation', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef, 'member:builder')
    const before = ledger.status().sequence
    const sent = withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('mention'), workspaceId: alpha, channelRef: channel.channel.channelRef,
      body: 'Please investigate this', recipients: [member.memberId], actor: agentTeamHumanActor() })).value))
    expect(ledger.status().sequence).toBe(before + 1)
    expect(sent.attention).toEqual(expect.arrayContaining([expect.objectContaining({ memberId: member.memberId,
      startSequence: sent.message.sequence, readThroughSequence: sent.message.sequence - 1 })]))
    expect(sent.directMarkers).toEqual([expect.objectContaining({ memberId: member.memberId, messageRef: sent.message.messageRef })])
    expect(ledger.inbox(actor, { workspaceId: alpha })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1,
      items: [expect.objectContaining({ task: expect.objectContaining({ taskRef: sent.task.taskRef }), directCount: 1 })] })
    ledger.validate()
    expect(replayLedger(test).inbox(actor, { workspaceId: alpha })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1 })
  })

  it('serves the Human Inbox with row previews and whole-unread totals', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    // One ledger instance commits and projects every step below: a second
    // instance's state is its construction-time replay, so mixing instances
    // would resolve refs against a stale snapshot.
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef, 'member:builder')

    // A followed Thread carrying BOTH an unread mention and ordinary follow
    // unread: one row, and the badge counts every unread fact on it.
    const followed = withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('followed'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Followed thread anchor', actor: agentTeamHumanActor() })).value))
    const mentioned = committed((await ledger.reply({ requestId: requestId('mention'), workspaceId: alpha, taskRef: followed.task.taskRef, body: 'Decision needed on the rollout', baseRevision: followed.thread.revision, recipients: [AGENT_TEAM_HUMAN_MEMBER_ID], actor })).value)
    committed((await ledger.reply({ requestId: requestId('ordinary'), workspaceId: alpha, taskRef: followed.task.taskRef, body: 'Ordinary progress reply', baseRevision: mentioned.thread.revision, actor })).value)

    // An unfollowed Thread whose fresh mention must still surface: direct
    // markers never depended on Human follow. Its anchor's first line exceeds
    // the 120-character preview bound the Thread page applies to Task titles.
    const unfollowed = withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('unfollowed'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: `${'x'.repeat(130)}\nsecond line`, actor: agentTeamHumanActor() })).value))
    await ledger.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: unfollowed.task.taskRef, action: 'unfollow', actor: agentTeamHumanActor() })
    committed((await ledger.reply({ requestId: requestId('ping'), workspaceId: alpha, taskRef: unfollowed.task.taskRef, body: 'Blocking on your call', baseRevision: unfollowed.thread.revision, recipients: [AGENT_TEAM_HUMAN_MEMBER_ID], actor })).value)

    const inbox = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    // Rows: both Threads carry one mention, so newest unread first — the ping
    // (seq 8) over the followed Thread's ordinary reply (seq 5).
    expect(inbox.items.map(item => item.thread.threadRef)).toEqual([unfollowed.task.threadRef, followed.task.threadRef])
    // The badge counts every unread fact, mentions included rather than alone.
    expect(inbox.totalUnreadCount).toBe(3)
    expect(inbox.totalDirectCount).toBe(2)
    expect(inbox.items[1]).toMatchObject({
      channelRef: channel.channel.channelRef, channelName: 'engineering', taskNumber: 1,
      directCount: 1, unreadCount: 2, previewText: 'Followed thread anchor',
    })
    expect(inbox.items[0]).toMatchObject({
      channelName: 'engineering', taskNumber: 2, directCount: 1, unreadCount: 1,
      previewText: `${'x'.repeat(119)}…`,
    })
    expect(inbox.items[0]?.newestOccurredAt).not.toBe('')
    const cold = replayLedger(test)
    expect(cold.inbox(agentTeamHumanActor(), { workspaceId: alpha }).totalUnreadCount).toBe(3)

    // The durable Thread read consumes the mention marker and the unread
    // behind it, so the next call no longer offers the Thread — while the
    // followed Thread keeps both its mention and its ordinary unread.
    await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: unfollowed.task.taskRef, actor: agentTeamHumanActor() })
    const after = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    expect(after.items.map(item => item.thread.threadRef)).toEqual([followed.task.threadRef])
    expect(after.totalUnreadCount).toBe(2)
    expect(after.totalDirectCount).toBe(1)
  })

  it('serves pure follow unread on the same data', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef, 'member:builder')
    // The Human creates the Thread and therefore follows it; the Agent's reply
    // carries NO mentions parameter, so the only unread it produces is the
    // ordinary follow unread — which is exactly what the Inbox now admits,
    // with no mention marker behind it.
    const started = withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Pure follow thread anchor', actor: agentTeamHumanActor() })).value))
    committed((await ledger.reply({ requestId: requestId('progress'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Ordinary progress, nobody mentioned', baseRevision: started.thread.revision, actor })).value)

    const inbox = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    expect(inbox.totalUnreadCount).toBe(1)
    expect(inbox.totalDirectCount).toBe(0)
    expect(inbox.items).toHaveLength(1)
    expect(inbox.items[0]).toMatchObject({ thread: { threadRef: started.task.threadRef }, unreadCount: 1, directCount: 0 })
    expect(replayLedger(test).inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual(inbox)
  })

  it('keeps the later follow watermark when an older direct marker is consumed', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const unfollowed = (await ledger.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'unfollow', actor: agentTeamHumanActor() })).value
    const mentioned = committed((await ledger.reply({ requestId: requestId('mention'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Please check this', baseRevision: unfollowed.thread.revision, recipients: [AGENT_TEAM_HUMAN_MEMBER_ID], actor })).value)
    const ordinary = committed((await ledger.reply({ requestId: requestId('ordinary'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Later reply', baseRevision: mentioned.thread.revision, actor })).value)
    const followed = (await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'follow', actor: agentTeamHumanActor() })).value
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    expect(followed.attention).toMatchObject({ readThroughSequence: ordinary.message.sequence })
    expect(read.readThroughSequence).toBe(ordinary.message.sequence)
    expect(read.consumedDirectMarkers).toEqual([expect.objectContaining({ messageRef: mentioned.message.messageRef })])
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [],
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.task.threadRef }), unreadCount: 0, directCount: 0 })],
      totalUnreadCount: 0, totalDirectCount: 0 })
    const replay = replayLedger(test)
    expect(replay.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [],
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.task.threadRef }), unreadCount: 0, directCount: 0 })],
      totalUnreadCount: 0, totalDirectCount: 0 })
  })

  it('moves a participated Thread from the unread queue into the Human recent slice once it is read', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Rollout plan' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    committed((await ledger.reply({ requestId: requestId('reply'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'On it', baseRevision: started.thread.revision, actor })).value)
    // One Thread is never in both slices: while the reply is unread the row is
    // the queue's, and the tail admits nothing.
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toMatchObject({ items: [expect.objectContaining({ unreadCount: 1 })], recent: [] })
    await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })
    const inbox = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    expect(inbox).toMatchObject({ items: [], totalUnreadCount: 0,
      recent: [expect.objectContaining({ channelName: 'engineering', taskNumber: 1, previewText: 'Rollout plan', unreadCount: 0, directCount: 0,
        thread: expect.objectContaining({ threadRef: started.task.threadRef }) })] })
    expect(replayLedger(test).inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual(inbox)
    // The tail is a Human surface: an Agent's Inbox stays exactly its unread
    // queue however much that Agent took part in the Thread.
    expect(ledger.inbox(actor, { workspaceId: alpha })).toMatchObject({ recent: [] })
  })

  it('admits every Thread the reader wrote in and nothing they only arrived at', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    // Three Threads, three ways a Human reader meets one. Their own Thread with
    // nobody else in it is theirs from the start; somebody else's Thread they
    // replied to is theirs too, even though a reply does not follow a Thread —
    // that gap is exactly what reading Attention as the candidate set used to
    // hide; and a Thread they were told about but never wrote in stays out,
    // because participation, not arrival, is the admission rule.
    const alone = committed((await ledger.sendMessage({ requestId: requestId('alone'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Notes to self', actor: agentTeamHumanActor() })).value)
    const theirs = committed((await ledger.sendMessage({ requestId: requestId('theirs'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Agent thread', actor })).value)
    committed((await ledger.reply({ requestId: requestId('join'), workspaceId: alpha, threadRef: theirs.thread.threadRef, body: 'Looking now', baseRevision: theirs.thread.revision, actor: agentTeamHumanActor() })).value)
    const told = committed((await ledger.sendMessage({ requestId: requestId('told'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Status only', recipients: [AGENT_TEAM_HUMAN_MEMBER_ID], actor })).value)
    for (const [name, threadRef] of [['alone', alone.thread.threadRef], ['theirs', theirs.thread.threadRef], ['told', told.thread.threadRef]] as const) {
      await ledger.readThread({ requestId: requestId(`read-${name}`), workspaceId: alpha, threadRef, actor: agentTeamHumanActor() })
    }
    const inbox = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    expect(inbox.items).toEqual([])
    // Newest activity first: the reader's reply on somebody else's Thread is the
    // freshest, their own unanswered Thread follows.
    expect(inbox.recent.map(item => item.thread.threadRef)).toEqual([theirs.thread.threadRef, alone.thread.threadRef])
    // A row draws the actor by name, and the Human is the one Member the Agent
    // roster never holds: the row reads the runtime display name instead of
    // falling back to the durable id, and a rename moves it without touching
    // that id.
    expect(inbox.recent.map(item => item.newestActor)).toEqual([
      { memberId: AGENT_TEAM_HUMAN_MEMBER_ID, name: AGENT_TEAM_HUMAN_HANDLE },
      { memberId: AGENT_TEAM_HUMAN_MEMBER_ID, name: AGENT_TEAM_HUMAN_HANDLE },
    ])
    ledger.setHumanDisplayHandle('Ada')
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha }).recent.map(item => item.newestActor))
      .toEqual([{ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, name: 'Ada' }, { memberId: AGENT_TEAM_HUMAN_MEMBER_ID, name: 'Ada' }])
    expect(replayLedger(test).inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual(inbox)
  })

  it('bounds the Human recent slice to the ten newest participated Threads', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    for (let index = 0; index < 11; index += 1) {
      const started = committed((await ledger.sendMessage({ requestId: requestId(`start-${index}`), workspaceId: alpha, channelRef: channel.channel.channelRef, body: `Thread ${index}`, actor: agentTeamHumanActor() })).value)
      committed((await ledger.reply({ requestId: requestId(`reply-${index}`), workspaceId: alpha, threadRef: started.thread.threadRef, body: 'Ack', baseRevision: started.thread.revision, actor })).value)
      await ledger.readThread({ requestId: requestId(`read-${index}`), workspaceId: alpha, threadRef: started.thread.threadRef, actor: agentTeamHumanActor() })
    }
    const inbox = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    expect(inbox.recent).toHaveLength(10)
    expect(inbox.recent[0]).toMatchObject({ previewText: 'Thread 10', unreadCount: 0 })
    expect(inbox.recent.some(item => item.previewText === 'Thread 0')).toBe(false)
  })

  it('lists every active Task Thread in the view radar for an Agent reader, whoever took part', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const { actor: bystander } = await addLedgerMember(ledger, channel.channel.channelRef, 'member:bystander', 'Bystander', 'Bystander')
    // A claimed Task (in_progress), a done Task still in review, and an untouched
    // Task with no Claim. The radar should carry the first two and drop the third.
    const claimed = withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('claimed'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Claimed work', actor: agentTeamHumanActor() })).value))
    committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: claimed.task.taskRef, action: 'claim', direction: 'building it', baseRevision: claimed.thread.revision, actor })).value)
    const reviewed = withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('reviewed'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Reviewed work', actor: agentTeamHumanActor() })).value))
    const reviewClaim = committed((await ledger.changeClaim({ requestId: requestId('review-claim'), workspaceId: alpha, taskRef: reviewed.task.taskRef, action: 'claim', direction: 'reviewing it', baseRevision: reviewed.thread.revision, actor })).value)
    committed((await ledger.changeClaim({ requestId: requestId('review-done'), workspaceId: alpha, taskRef: reviewed.task.taskRef, action: 'done', claimRef: reviewClaim.claim.claimRef, baseRevision: reviewClaim.thread.revision, actor })).value)
    withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('idle'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Idle work', actor: agentTeamHumanActor() })).value))
    // The bystander never wrote in either active Thread, yet the radar surfaces
    // both to them: admission is the Task being active, not participation.
    const radar = ledger.view({ workspaceId: alpha, topLevelOnly: true, includeActivities: false, direction: 'before' }, bystander.memberId).activeTaskThreads
    expect(radar.map(row => row.threadRef).sort()).toEqual([claimed.task.threadRef, reviewed.task.threadRef].sort())
    const claimedRow = radar.find(row => row.threadRef === claimed.task.threadRef)!
    expect(claimedRow).toMatchObject({ status: 'in_progress', subject: 'Claimed work', taskNumber: 1 })
    expect(claimedRow.members.map(m => m.memberId)).toEqual([member.memberId])
    expect(radar.find(row => row.threadRef === reviewed.task.threadRef)).toMatchObject({ status: 'in_review', subject: 'Reviewed work' })
  })

  it('keeps an active Task Thread in the radar even while the reader has it unread', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const { actor: reader } = await addLedgerMember(ledger, channel.channel.channelRef, 'member:reader', 'Reader', 'Reader')
    const started = withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Active task', recipients: [reader.memberId], actor })).value))
    committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'claim', direction: 'on it', baseRevision: started.thread.revision, actor })).value)
    // The reader was mentioned and has an unread on this Thread — the unread
    // queue carries it, and so does the radar, independently.
    const inbox = ledger.inbox(reader, { workspaceId: alpha })
    expect(inbox.items.some(item => item.thread.threadRef === started.task.threadRef)).toBe(true)
    const radar = ledger.view({ workspaceId: alpha, topLevelOnly: true, includeActivities: false, direction: 'before' }, reader.memberId).activeTaskThreads
    expect(radar.map(row => row.threadRef)).toEqual([started.task.threadRef])
  })

  it('excludes archived-Channel Tasks and isolates Workspaces in the view radar', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    await ledger.joinWorkspace({ requestId: requestId('join-beta'), workspaceId: beta, memberId: member.memberId, actor: agentTeamHumanActor() })
    const alphaChannel = (await ledger.createChannel({ requestId: requestId('alpha-ch'), workspaceId: alpha, name: 'alpha', description: '', memberIds: [member.memberId], actor: agentTeamHumanActor() })).value.channel
    const betaChannel = (await ledger.createChannel({ requestId: requestId('beta-ch'), workspaceId: beta, name: 'beta', description: '', memberIds: [member.memberId], actor: agentTeamHumanActor() })).value.channel
    const betaTask = withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('beta-task'), workspaceId: beta, channelRef: betaChannel.channelRef, body: 'Beta work', actor })).value))
    committed((await ledger.changeClaim({ requestId: requestId('beta-claim'), workspaceId: beta, taskRef: betaTask.task.taskRef, action: 'claim', direction: 'beta angle', baseRevision: betaTask.thread.revision, actor })).value)
    // Beta's active Task does not leak into the alpha radar.
    expect(ledger.view({ workspaceId: alpha, topLevelOnly: true, direction: 'before' }, member.memberId).activeTaskThreads).toEqual([])
    // An active Task whose Channel is then archived leaves the radar.
    const alphaTask = withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('alpha-task'), workspaceId: alpha, channelRef: alphaChannel.channelRef, body: 'Alpha work', actor })).value))
    committed((await ledger.changeClaim({ requestId: requestId('alpha-claim'), workspaceId: alpha, taskRef: alphaTask.task.taskRef, action: 'claim', direction: 'alpha angle', baseRevision: alphaTask.thread.revision, actor })).value)
    expect(ledger.view({ workspaceId: alpha, topLevelOnly: true, direction: 'before' }, member.memberId).activeTaskThreads.map(row => row.threadRef)).toEqual([alphaTask.task.threadRef])
    await ledger.archiveChannel({ requestId: requestId('alpha-arch'), workspaceId: alpha, channelRef: alphaChannel.channelRef, actor: agentTeamHumanActor() })
    expect(ledger.view({ workspaceId: alpha, topLevelOnly: true, direction: 'before' }, member.memberId).activeTaskThreads).toEqual([])
  })

  it('leaves the view radar empty when no Task has an active Claim', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    // A taskful Thread with no Claim stays at todo and never enters the radar.
    withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('todo'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Unclaimed task', actor })).value))
    expect(ledger.view({ workspaceId: alpha, topLevelOnly: true, direction: 'before' }, actor.memberId).activeTaskThreads).toEqual([])
  })

  it('does not duplicate a direct marker when follow starts after the marker', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const unfollowed = (await ledger.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'unfollow', actor: agentTeamHumanActor() })).value
    const mentioned = committed((await ledger.reply({ requestId: requestId('mention'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Please check this', baseRevision: unfollowed.thread.revision, recipients: [AGENT_TEAM_HUMAN_MEMBER_ID], actor })).value)
    const followed = (await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'follow', actor: agentTeamHumanActor() })).value
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    expect(mentioned.directMarkers).toEqual([expect.objectContaining({ memberId: AGENT_TEAM_HUMAN_MEMBER_ID })])
    expect(followed.attention).toBeDefined()
    expect(read.facts.filter(fact => fact.fact.kind === 'message' && fact.fact.message.messageRef === mentioned.message.messageRef)).toHaveLength(1)
  })

  it('returns Human-only follow observations without changing public Thread facts or Inbox state', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    await test.ctx.agentTeam.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'unfollow' })
    await test.ctx.agentTeam.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow' })

    expect(test.ctx.agentTeam.threadObservations({ workspaceId: alpha, taskRef: started.task.taskRef })).toEqual({
      items: [
        expect.objectContaining({ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, action: 'unfollow', taskRef: started.task.taskRef }),
        expect.objectContaining({ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, action: 'follow', taskRef: started.task.taskRef }),
      ],
      // The observation history keeps both transitions; followers is the current state they lead to.
      followers: [AGENT_TEAM_HUMAN_MEMBER_ID],
    })
    expect(test.ctx.agentTeam.view({ workspaceId: alpha, threadRef: started.thread.threadRef }).activities).toEqual([])
    // Observations are Inbox-invisible: they change who gets notified, never
    // which Threads a reader took part in, so the Thread the Human started is
    // still the tail's only row after the unfollow/follow pair.
    expect(test.ctx.agentTeam.inbox({ workspaceId: alpha })).toMatchObject({ items: [], totalUnreadCount: 0, totalDirectCount: 0,
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.task.threadRef }) })] })
  })

  it('invites an unfollowed Agent only after Human confirmation and leaves old history background-only', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const member = await test.ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: alpha, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Old task' })))
    const history = committed(await test.ctx.agentTeam.reply({ requestId: requestId('history'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Old discussion', baseRevision: started.thread.revision }))
    const held = await test.ctx.agentTeam.reply({ requestId: requestId('invite'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Please review this', baseRevision: history.thread.revision, recipients: [member.status.member.memberId] })
    expect(held).toMatchObject({ kind: 'confirmation_required', recipients: [member.status.member.memberId] })
    expect(test.ctx.agentTeam.status().sequence).toBe(history.receipt.sequence)
    if (held.kind !== 'confirmation_required') throw new Error('expected invitation confirmation')
    const invite = committed(await test.ctx.agentTeam.reply({ requestId: requestId('invite-confirmed'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Please review this', baseRevision: history.thread.revision, recipients: [member.status.member.memberId], confirmationToken: held.confirmationToken }))
    expect(invite.attention).toEqual([expect.objectContaining({ memberId: member.status.member.memberId, startSequence: invite.message.sequence })])
    expect(invite.directMarkers).toEqual([expect.objectContaining({ memberId: member.status.member.memberId, messageRef: invite.message.messageRef })])
    expect(test.ctx.agentTeam.view({ workspaceId: alpha, threadRef: started.thread.threadRef }).items.map(item => item.message.body))
      .toEqual(['Old task', 'Old discussion', 'Please review this'])
  })

  it('reports how much of a Thread a bounded read left behind, so a returning reader can size what it has not read', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Thread anchor' })))
    committed(await test.ctx.agentTeam.reply({ requestId: requestId('history'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Older discussion', baseRevision: started.thread.revision }))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef, 'member:reviewer', 'Reviews changes', 'reviewer')
    // Joining takes the watermark to the tail, so the two facts already in the
    // Thread stay behind an Attention period this member has never read through.
    const joined = (await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })).value
    expect(joined.attention).toMatchObject({ readThroughSequence: 4 })

    // The Thread moves on, and this member is answered with the background
    // window plus the new fact — while the count states the span behind both.
    const moved = committed((await ledger.reply({ requestId: requestId('moved-on'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Two days later', baseRevision: joined.thread.revision, actor: agentTeamHumanActor() })).value)
    const returning = (await ledger.readThread({ requestId: requestId('returning-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    expect(returning.facts.filter(entry => entry.unread).map(entry => entry.fact.sequence)).toEqual([moved.receipt.sequence])
    // Two facts exist before that batch; both are inside the response's own
    // background window, which is why the count is measured from what the
    // response starts at rather than from the watermark it advances to.
    expect(returning.earlierFactCount).toBe(2)
  })

  it('a read that reached a Thread\'s first fact reports nothing left behind it', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Only task' })))
    // The Thread holds one fact and this read acknowledges it, so the span
    // before what it was shown is empty and the render stays silent about it.
    const read = await test.ctx.agentTeam.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef })
    expect(read.earlierFactCount).toBe(0)
  })

  it('gates existing Thread mutations on unread work before revision and makes reads idempotent', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const follow = await ledger.changeAttention({ requestId: requestId('agent-follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    expect(follow.value.attention).toMatchObject({ readThroughSequence: started.thread.revision })
    const update = committed((await ledger.reply({ requestId: requestId('human-update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'New evidence', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).value)
    const blocked = (await ledger.reply({ requestId: requestId('blocked'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Reply without read', baseRevision: started.thread.revision, actor })).value
    expect(blocked).toMatchObject({ kind: 'unread_required', revision: update.thread.revision })
    const readRequest = { requestId: requestId('agent-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor }
    const first = (await ledger.readThread(readRequest)).value
    expect(first.facts).toContainEqual(expect.objectContaining({ unread: true, fact: expect.objectContaining({ sequence: update.message.sequence }) }))
    // A retry republishes the original receipt — one durable record, one
    // watermark advance — and answers with the picture the current projection
    // derives, which the first read already drained.
    const retry = (await ledger.readThread(readRequest)).value
    expect(retry.receipt).toEqual(first.receipt)
    expect(retry.readThroughSequence).toBe(first.readThroughSequence)
    expect(retry.remainingUnreadCount).toBe(0)
    expect(retry.facts).toEqual([])
    expect([...test.facility.get('agent_team')!.table('operations').entries()]
      .filter(([, operation]) => (operation as AgentTeamOperation).kind === 'team/thread-read')).toHaveLength(1)
    const stale = (await ledger.reply({ requestId: requestId('stale'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Reply with obsolete revision', baseRevision: started.thread.revision, actor })).value
    expect(stale).toMatchObject({ kind: 'stale_revision', revision: update.thread.revision })
    expect(committed((await ledger.reply({ requestId: requestId('current'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Reply after read', baseRevision: update.thread.revision, actor })).value).message.body).toBe('Reply after read')
    ledger.validate()
  })

  it('makes a 21-update read continue explicit with a remaining unread count', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const followed = await ledger.changeAttention({ requestId: requestId('follow-21'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    let revision = followed.value.attention?.readThroughSequence ?? started.thread.revision
    for (let index = 0; index < 21; index++) {
      const sent = committed((await ledger.reply({ requestId: requestId(`update-21-${index}`), workspaceId: alpha, taskRef: started.task.taskRef,
        body: `Update ${index + 1}`, baseRevision: revision, actor: agentTeamHumanActor() })).value)
      revision = sent.thread.revision
    }
    const firstRequest = { requestId: requestId('read-21-first'), workspaceId: alpha, taskRef: started.task.taskRef, actor }
    const first = (await ledger.readThread(firstRequest)).value
    expect(first.facts.filter(fact => fact.unread)).toHaveLength(20)
    expect(first.remainingUnreadCount).toBe(1)
    // The retry changes nothing durable, so it answers from the current
    // projection: the 21st update is still the one unread fact and the receipt
    // stays exactly the one the first read committed — a continuation a frozen
    // picture could not show.
    const retry = (await ledger.readThread(firstRequest)).value
    expect(retry.receipt).toEqual(first.receipt)
    expect(retry.facts.filter(fact => fact.unread)).toHaveLength(1)
    expect(retry.remainingUnreadCount).toBe(0)
    // A fresh read of that unchanged state derives the identical picture and
    // commits it as the explicit continuation.
    const second = (await ledger.readThread({ requestId: requestId('read-21-second'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    const { receipt: _retryReceipt, ...retryPicture } = retry
    const { receipt: _secondReceipt, ...secondPicture } = second
    expect(retryPicture).toEqual(secondPicture)
    expect(second.remainingUnreadCount).toBe(0)
  })

  it('counts remaining unread from the reader own marker state, not the whole ledger', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'First task' })))
    const other = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start-other'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Second task' })))
    const ledger = replayLedger(test)
    const { actor: reader } = await addLedgerMember(ledger, channel.channel.channelRef)
    const { actor: bystander } = await addLedgerMember(ledger, channel.channel.channelRef)
    await ledger.changeAttention({ requestId: requestId('follow-first'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor: reader })
    await ledger.changeAttention({ requestId: requestId('follow-second'), workspaceId: alpha, taskRef: other.task.taskRef, action: 'follow', actor: reader })
    // Following keeps the mention a plain marker: an unfollowed Member would
    // need a confirmation token, which is a different contract.
    await ledger.changeAttention({ requestId: requestId('follow-bystander'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor: bystander })
    // Every marker lives in exactly one Thread and belongs to exactly one
    // Member, so reading one Thread must consume that reader's own marker and
    // leave the other Thread's and the other Member's alone. The remaining
    // count is the reader-visible consequence of that consumption.
    let firstRevision = started.thread.revision
    const mentioned = committed((await ledger.reply({ requestId: requestId('mention-reader'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Check this', baseRevision: firstRevision, recipients: [reader.memberId], actor: agentTeamHumanActor() })).value)
    firstRevision = mentioned.thread.revision
    const bystanderMention = committed((await ledger.reply({ requestId: requestId('mention-bystander'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'And this one', baseRevision: firstRevision, recipients: [bystander.memberId], actor: agentTeamHumanActor() })).value)
    firstRevision = bystanderMention.thread.revision
    const update = committed((await ledger.reply({ requestId: requestId('update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Ordinary update', baseRevision: firstRevision, actor: agentTeamHumanActor() })).value)
    firstRevision = update.thread.revision
    committed((await ledger.reply({ requestId: requestId('mention-other-thread'), workspaceId: alpha, taskRef: other.task.taskRef,
      body: 'Mention in the other Thread', baseRevision: other.thread.revision, recipients: [reader.memberId], actor: agentTeamHumanActor() })).value)

    const first = await ledger.readThread({ requestId: requestId('read-first'), workspaceId: alpha, taskRef: started.task.taskRef, actor: reader })
    expect(first.committed).toBe(true)
    expect(first.value.remainingUnreadCount).toBe(0)
    expect(first.value.facts.filter(fact => fact.unread && fact.direct)).toHaveLength(1)

    // The other Thread still holds its own marker: reading the first Thread
    // consumed nothing outside the reader's own Attention row and markers.
    const second = await ledger.readThread({ requestId: requestId('read-second'), workspaceId: alpha, taskRef: other.task.taskRef, actor: reader })
    expect(second.committed).toBe(true)
    expect(second.value.remainingUnreadCount).toBe(0)
    expect(second.value.facts.filter(fact => fact.unread && fact.direct)).toHaveLength(1)
    expect((await ledger.readThread({ requestId: requestId('read-second-again'), workspaceId: alpha, taskRef: other.task.taskRef, actor: reader })).committed).toBe(false)

    // The bystander's marker in the first Thread is untouched by the reader's read.
    const bystanderView = await ledger.readThread({ requestId: requestId('read-bystander'), workspaceId: alpha, taskRef: started.task.taskRef, actor: bystander })
    expect(bystanderView.committed).toBe(true)
    expect(bystanderView.value.remainingUnreadCount).toBe(0)
    expect(bystanderView.value.facts.filter(fact => fact.unread && fact.direct)).toHaveLength(1)
    ledger.validate()
  })

  it('releases Claims and clears Attention on close without restoring it on reopen', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const claim = committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    expect(claim.attention).toMatchObject({ memberId: actor.memberId })
    const humanRead = (await ledger.readThread({ requestId: requestId('human-read'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    const closed = committed((await ledger.changeTask({ requestId: requestId('close'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'close', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(closed).toMatchObject({ task: { resolution: 'closed', status: 'closed' }, claims: [expect.objectContaining({ claimRef: claim.claim.claimRef, state: 'released' })] })
    expect(ledger.attentionStatus(actor, { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toBeUndefined()
    expect(ledger.inbox(actor, { workspaceId: alpha })).toMatchObject({ totalUnreadCount: 1, items: [
      expect.objectContaining({ task: expect.objectContaining({ taskRef: started.task.taskRef }), unreadCount: 1 }),
    ] })
    const terminalRead = (await ledger.readThread({ requestId: requestId('terminal-read'), workspaceId: alpha,
      taskRef: started.task.taskRef, actor })).value
    expect(terminalRead.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ unread: true, fact: expect.objectContaining({ kind: 'activity', activity: expect.objectContaining({ kind: 'close' }) }) }),
    ]))
    expect(ledger.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(0)
    const reopened = committed((await ledger.changeTask({ requestId: requestId('reopen'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'reopen', baseRevision: closed.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(reopened.task).toMatchObject({ resolution: 'open', status: 'todo' })
    expect(ledger.attentionStatus(actor, { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toBeUndefined()
    ledger.validate()
  })

  it('retains a later reopen update for Members that have not read the close', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('reopen-channel'), workspaceId: alpha,
      name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('reopen-start'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    await ledger.changeAttention({ requestId: requestId('reopen-follow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'follow', actor })
    const humanRead = (await ledger.readThread({ requestId: requestId('reopen-human-read'), workspaceId: alpha,
      taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    const closed = committed((await ledger.changeTask({ requestId: requestId('reopen-close'), workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'close', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    committed((await ledger.changeTask({ requestId: requestId('reopen-again'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'reopen', baseRevision: closed.thread.revision, actor: agentTeamHumanActor() })).value)

    expect(ledger.inbox(actor, { workspaceId: alpha })).toMatchObject({ totalUnreadCount: 2, items: [
      expect.objectContaining({ task: expect.objectContaining({ resolution: 'open' }), unreadCount: 2 }),
    ] })
    const read = (await ledger.readThread({ requestId: requestId('reopen-member-read'), workspaceId: alpha,
      taskRef: started.task.taskRef, actor })).value
    expect(read.facts.filter(fact => fact.unread).map(fact => fact.fact.kind === 'activity' ? fact.fact.activity.kind : 'message'))
      .toEqual(['close', 'reopen'])
    expect(ledger.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(0)
  })

  it.each(['channel', 'team'] as const)('replays terminal Activity marker cleanup after %s removal', async (scope) => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId(`cleanup-${scope}-channel`), workspaceId: alpha,
      name: `cleanup-${scope}`, description: 'Cleanup replay' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId(`cleanup-${scope}-start`), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    await ledger.changeAttention({ requestId: requestId(`cleanup-${scope}-follow`), workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'follow', actor })
    const humanRead = (await ledger.readThread({ requestId: requestId(`cleanup-${scope}-human-read`), workspaceId: alpha,
      taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    committed((await ledger.changeTask({ requestId: requestId(`cleanup-${scope}-close`), workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'close', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(ledger.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(1)

    if (scope === 'channel') {
      await ledger.removeChannelMember({ requestId: requestId('cleanup-channel-remove'), workspaceId: alpha,
        channelRef: channel.channel.channelRef, memberId: member.memberId, actor: agentTeamHumanActor() })
    } else {
      await ledger.removeMember({ requestId: requestId('cleanup-team-remove'),
        memberId: member.memberId, actor: agentTeamHumanActor() })
    }
    ledger.validate()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => replayLedger(replayed).validate()).not.toThrow()
  })

  it('cleans a removed Member Attention on taskless Threads of the Channel and replays', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('taskless-remove-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const chat = committed((await ledger.sendMessage({ requestId: requestId('taskless-remove-chat'), workspaceId: alpha, channelRef: channel.channel.channelRef,
      body: 'plain conversation', asTask: false, actor: agentTeamHumanActor(), recipients: [actor.memberId] })).value)

    const removed = (await ledger.removeChannelMember({ requestId: requestId('taskless-remove'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, memberId: member.memberId, actor: agentTeamHumanActor() })).value
    const operation = ledger.getOperation(removed.receipt.operationId)!
    expect(operation.kind === 'team/channel-member-removed' ? operation.data.inbox.attention.removed : [])
      .toEqual(expect.arrayContaining([{ memberId: member.memberId, threadRef: chat.thread.threadRef }]))
    ledger.validate()

    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => replayLedger(replayed)).not.toThrow()
  })

  it('repairs a legacy Channel member-removal record that omitted taskless-Thread cleanup on load', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('legacy-remove-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const chat = committed((await ledger.sendMessage({ requestId: requestId('legacy-remove-chat'), workspaceId: alpha, channelRef: channel.channel.channelRef,
      body: 'plain conversation', asTask: false, actor: agentTeamHumanActor(), recipients: [actor.memberId] })).value)
    const removed = (await ledger.removeChannelMember({ requestId: requestId('legacy-remove'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, memberId: member.memberId, actor: agentTeamHumanActor() })).value
    // Rewrite the removal to the 0.1.7-0.1.9 shape: cleanup scoped to taskful Threads only.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/channel-member-removed') return [id, typed] as [string, unknown]
      const dropTaskless = (entries: readonly { threadRef: string }[]) => entries.filter(entry => entry.threadRef !== chat.thread.threadRef)
      return [id, { ...typed, data: { ...typed.data, inbox: {
        attention: { set: [], removed: dropTaskless(typed.data.inbox.attention.removed) },
        directMarkers: { added: [], removed: dropTaskless(typed.data.inbox.directMarkers.removed) },
        activityMarkers: { added: [], removed: dropTaskless(typed.data.inbox.activityMarkers.removed) },
      } } }] as [string, unknown]
    })
    const legacy = await harness(storedPool(records))
    const legacyLedger = replayLedger(legacy)
    expect(() => legacyLedger.validate()).not.toThrow()
    const repaired = legacyLedger.getOperation(removed.receipt.operationId)!
    expect(repaired.kind === 'team/channel-member-removed' ? repaired.data.inbox.attention.removed : [])
      .toEqual(expect.arrayContaining([{ memberId: member.memberId, threadRef: chat.thread.threadRef }]))
  })

  it('rejects a structurally valid Thread read receipt with a forged watermark during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Task' })))
    const updated = committed(await test.ctx.agentTeam.reply({ requestId: requestId('update'), workspaceId: alpha,
      taskRef: started.task.taskRef, body: 'Unread update', baseRevision: started.thread.revision }))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    await ledger.reply({ requestId: requestId('agent-update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Unread agent update', baseRevision: updated.thread.revision, actor })
    // The Human has an unseen reply, so this read advances the watermark and
    // commits the record the replay below must reject once it is forged.
    await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-read' || isThreadReadSnapshot(typed.data)) return [id, typed] as [string, unknown]
      // Watermark and the Attention row that carries it are forged together, so
      // no consistency check inside the record can catch this: only the
      // independent derivation from the record's own prior projection can.
      const forgedWatermark = updated.thread.revision + 100
      const attention = { ...typed.data.inbox.attention.set[0]!, readThroughSequence: forgedWatermark }
      return [id, { ...typed, data: { ...typed.data, readThroughSequence: forgedWatermark,
        inbox: { ...typed.data.inbox, attention: { ...typed.data.inbox.attention, set: [attention] } } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid Thread read receipt/)
  })

  it('rejects a pre-receipt Thread read snapshot with a forged watermark during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Task' })))
    const updated = committed(await test.ctx.agentTeam.reply({ requestId: requestId('update'), workspaceId: alpha,
      taskRef: started.task.taskRef, body: 'Unread update', baseRevision: started.thread.revision }))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    await ledger.reply({ requestId: requestId('agent-update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Unread agent update', baseRevision: updated.thread.revision, actor })
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-read' || isThreadReadSnapshot(typed.data)) return [id, typed] as [string, unknown]
      // The legacy form still loads and still gets the full derivation, so the
      // same forgery must be caught there — a snapshot is not a trusted record
      // just because it is old.
      const data = snapshotReadData(typed.data, read)
      const forgedWatermark = updated.thread.revision + 100
      return [id, { ...typed, data: { ...data, readThroughSequence: forgedWatermark,
        attention: { ...data.attention!, readThroughSequence: forgedWatermark },
        inbox: { ...data.inbox, attention: { ...data.inbox.attention, set: [{ ...data.attention!, readThroughSequence: forgedWatermark }] } } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid Thread read projection/)
  })

  it('rejects forged member cleanup snapshots during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const member = await test.ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: alpha, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', channelRefs: [channel.channel.channelRef] })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    await test.ctx.agentTeam.removeChannelMember({ requestId: requestId('remove'), workspaceId: alpha, channelRef: channel.channel.channelRef, memberId: member.status.member.memberId })
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/channel-member-removed') return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, tasks: [started.task] } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid released Claim Task or Thread projection/)
  })

  it('rejects a forged direct marker that does not match its Message during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const followed = await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    committed((await ledger.reply({ requestId: requestId('mention'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Check this', baseRevision: followed.value.thread.revision, recipients: [actor.memberId], actor: agentTeamHumanActor() })).value)
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-replied') return [id, typed] as [string, unknown]
      const marker = typed.data.inbox.directMarkers.added[0]!
      return [id, { ...typed, data: { ...typed.data, inbox: { ...typed.data.inbox, directMarkers: {
        ...typed.data.inbox.directMarkers, added: [{ ...marker, sequence: marker.sequence + 1 }],
      } } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid direct marker addition/)
  })

  it('rejects a direct marker that resolves only against a later record during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const followed = await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    const mentioned = committed((await ledger.reply({ requestId: requestId('mention'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Check this', baseRevision: followed.value.thread.revision, recipients: [actor.memberId], actor: agentTeamHumanActor() })).value)
    const later = committed((await ledger.reply({ requestId: requestId('later'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Later update', baseRevision: mentioned.thread.revision, actor: agentTeamHumanActor() })).value)
    // The marker is rewritten to a Message that is real, in the same Thread, with
    // the sequence it carries — everything a linear scan of the ledger's whole
    // Message set would accept. Only resolution against the state replayed up to
    // this record rejects it, which is what the marker lookup must stay bound to.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-replied') return [id, typed] as [string, unknown]
      const marker = typed.data.inbox.directMarkers.added[0]
      if (marker === undefined) return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, inbox: { ...typed.data.inbox, directMarkers: {
        ...typed.data.inbox.directMarkers, added: [{ ...marker, messageRef: later.message.messageRef, sequence: later.message.sequence }],
      } } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid direct marker addition/)
  })

  // The only case that boots two SQLite-backed Hosts over one file, so it pays
  // cold start, a full replay and a validate twice. Windows runners vary from
  // 465ms to over 5s on identical code, so it needs headroom over the default.
  it('replays an Agent Attention read watermark from SQLite across a Host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-sqlite-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const path = join(root, 'team.sqlite')
    const first = await sqliteHarness(path)
    const channel = await first.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await first.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Persistent task' })))
    const ledger = replayLedger(first)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    const update = committed((await ledger.reply({ requestId: requestId('update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Persistent update', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).value)
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    expect(read.readThroughSequence).toBe(update.thread.revision)
    await first.fiber.dispose(); await first.facility.closeAll()
    const second = await sqliteHarness(path)
    const replay = replayLedger(second)
    expect(replay.inbox(actor, { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0 })
    expect(second.ctx.agentTeam.view({ workspaceId: alpha, threadRef: started.thread.threadRef }).items.map(item => item.message.body)).toEqual(['Persistent task', 'Persistent update'])
    expect(replay.attentionStatus(actor, { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toMatchObject({ readThroughSequence: update.thread.revision })
    replay.validate()
    second.ctx.agentTeam.validateLedger()
  }, 30_000)

  it('normalizes bare pre-occurredAt messages with the wrapping operation instant during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Legacy' })))
    const ledger = replayLedger(test)
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind === 'team/message-sent') {
        const { occurredAt: _dropped, ...message } = typed.data.message
        return [id, { ...typed, data: { ...typed.data, message } }] as [string, unknown]
      }
      if (typed.kind === 'team/thread-read' && !isThreadReadSnapshot(typed.data)) {
        // Rewrite the committed receipt as the snapshot a pre-B2 ledger holds,
        // then strip every message instant only the load path can restore.
        const data = snapshotReadData(typed.data, read)
        const { occurredAt: _anchorDropped, ...anchor } = data.anchor
        const facts = data.facts.map(fact => fact.fact.kind === 'message'
          ? (() => {
            const { occurredAt: _factDropped, ...message } = fact.fact.message
            return { ...fact, fact: { kind: 'message' as const, sequence: fact.fact.sequence, message } }
          })()
          : fact)
        return [id, { ...typed, data: { ...data, anchor, facts } }] as [string, unknown]
      }
      return [id, typed] as [string, unknown]
    })
    const storedMessage = records.map(([, operation]) => operation as AgentTeamOperation)
      .find(operation => operation.kind === 'team/message-sent')!
    const revived = await harness(storedPool(records))
    const view = revived.ctx.agentTeam.view({ workspaceId: alpha, threadRef: started.thread.threadRef })
    expect(view.items.map(item => item.message.body)).toEqual(['Legacy'])
    expect(view.items[0]!.message.occurredAt).toBe(storedMessage.occurredAt)
    expect(() => replayLedger(revived).validate()).not.toThrow()
  })

  it('normalizes bare pre-occurredAt Activity facts with their committing operation instant during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Legacy task' })))
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    const memberReadId = requestId('member-read-claim')
    const humanReadId = requestId('human-read-claim')
    const memberRead = (await ledger.readThread({ requestId: memberReadId, workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    const humanRead = (await ledger.readThread({ requestId: humanReadId, workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    // Each read answers with the picture of its own moment, so a stored snapshot
    // can only be rebuilt from the picture of the read that wrote it.
    const pictures = new Map<AgentTeamRequestId, Omit<AgentTeamThreadReadResult, 'receipt'>>([
      [memberReadId, memberRead],
      [humanReadId, humanRead],
    ])
    const accepted = committed((await ledger.changeTask({ requestId: requestId('accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: claimed.thread.revision, actor: agentTeamHumanActor() })).value)
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind === 'team/thread-read' && !isThreadReadSnapshot(typed.data)) {
        // Rewrite the committed receipt as the snapshot a pre-B2 ledger holds,
        // then strip every fact instant only the load path can restore.
        const data = snapshotReadData(typed.data, pictures.get(typed.requestId)!)
        const facts = data.facts.map(fact => {
          if (fact.fact.kind === 'message') {
            const { occurredAt: _factDropped, ...message } = fact.fact.message
            return { ...fact, fact: { kind: 'message' as const, sequence: fact.fact.sequence, message, mentions: fact.fact.mentions } }
          }
          const { occurredAt: _envelopeDropped, ...activityFact } = fact.fact
          return { ...fact, fact: { kind: 'activity' as const, sequence: activityFact.sequence, activity: activityFact.activity } }
        })
        return [id, { ...typed, data: { ...data, facts } }] as [string, unknown]
      }
      return [id, typed] as [string, unknown]
    })
    const revived = await harness(storedPool(records))
    const replayed = replayLedger(revived)
    expect(() => replayed.validate()).not.toThrow()
    const read = (await replayed.readThread({ requestId: requestId('revived-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    expect(read.facts.filter(fact => fact.unread).map(fact => fact.fact.kind === 'activity' ? fact.fact.activity.kind : 'message')).toEqual(['accept'])
    expect(read.facts.find(fact => fact.fact.kind === 'activity' && fact.unread)!.fact.occurredAt).toBe(accepted.receipt.occurredAt)
    expect(read.attention).toMatchObject({ memberId: member.memberId, readThroughSequence: read.readThroughSequence })
  })

  it('fails loud on malformed durable records and an invariant catches projection divergence', async () => {
    await expect(harness(storedPool([['operation:bad', { sequence: 'one' }]]))).rejects.toThrow(/does not match its schema/)
    const test = await harness()
    await test.ctx.plugin(agentTeamInvariant)
    const domain = test.facility.get('agent_team')!
    const table = domain.table('operations')
    const [id, operation] = [...table.entries()][0]!
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 2 })
    const receipt = { operationId: id as AgentTeamOperationId, requestId: AGENT_TEAM_INITIALIZE_REQUEST_ID, sequence: 2, occurredAt: (operation as AgentTeamOperation).occurredAt }
    // The commit path records and schedules; the replay runs after the I/O
    // turn, so the divergence surfaces as the latched failure the next commit
    // raises on a caller-owned frame.
    const logError = vi.spyOn(test.ctx.logger, 'error').mockImplementation(() => {})
    test.ctx.emit('agent-team/committed', { receipt })
    await new Promise(resolve => setImmediate(resolve))
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('diverged'))
    expect(() => test.ctx.emit('agent-team/committed', { receipt })).toThrow(/invariant violated/)
    logError.mockRestore()
  })

  it('fails the companion load when the mount replay finds a diverged ledger', async () => {
    const test = await harness()
    const table = test.facility.get('agent_team')!.table('operations')
    const [id, operation] = [...table.entries()][0]!
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 9 })
    // Mounting is the boot gate: a ledger the projection cannot re-derive must
    // reject the companion's own plugin load, not arm a later check.
    await expect(test.ctx.plugin(agentTeamInvariant)).rejects.toThrow(/invariant violated/)
  })

  it('keeps the commit-path replay off the commit call and coalesces a burst', async () => {
    const test = await harness()
    await test.ctx.plugin(agentTeamInvariant)
    const validate = vi.spyOn(test.ctx.agentTeam, 'validateLedger')
    validate.mockClear()
    const [id, operation] = [...test.facility.get('agent_team')!.table('operations').entries()][0]!
    const receipt = { operationId: id as AgentTeamOperationId, requestId: AGENT_TEAM_INITIALIZE_REQUEST_ID, sequence: 1, occurredAt: (operation as AgentTeamOperation).occurredAt }
    test.ctx.emit('agent-team/committed', { receipt })
    test.ctx.emit('agent-team/committed', { receipt })
    expect(validate).not.toHaveBeenCalled()
    await new Promise(resolve => setImmediate(resolve))
    expect(validate).toHaveBeenCalledTimes(1)
    validate.mockRestore()
  })

  it('adopts the boot record-level replay at the invariant mount', async () => {
    // An existing profile boots by replaying its records; initialize() commits
    // only on a fresh one, so seed the storage to reach the case that matters.
    const seeded = await harness()
    const channel = await seeded.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    await seeded.ctx.agentTeam.sendMessage({ requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })
    const records = [...seeded.facility.get('agent_team')!.table('operations').entries()]
    const test = await harness(storedPool(records as Array<[string, unknown]>))
    const entries = vi.spyOn(test.facility.get('agent_team')!.table('operations'), 'entries')
    await test.ctx.plugin(agentTeamInvariant)
    // The constructor already re-derived every durable record against its own
    // scratch projection; the mount must not read and re-derive it again.
    expect(entries).not.toHaveBeenCalled()
    entries.mockRestore()
  })

  it('replays the durable records at the mount once a commit landed after boot', async () => {
    const seeded = await harness()
    const records = [...seeded.facility.get('agent_team')!.table('operations').entries()]
    const test = await harness(storedPool(records as Array<[string, unknown]>))
    await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const entries = vi.spyOn(test.facility.get('agent_team')!.table('operations'), 'entries')
    await test.ctx.plugin(agentTeamInvariant)
    // A commit invalidates the boot conclusion, so the mount reads the table again.
    expect(entries).toHaveBeenCalledTimes(1)
    entries.mockRestore()
  })

  it('fails closed at the mount when a commit excludes adoption and the records are invalid', async () => {
    const test = await harness()
    await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const table = test.facility.get('agent_team')!.table('operations')
    const [id, operation] = [...table.entries()].at(-1)!
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 9 })
    expect(() => test.ctx.agentTeam.validateLedgerAtMount()).toThrow(/expected sequence 2, found 9/)
  })

  it('keeps the mount adoption one-shot and every later validation a full replay', async () => {
    const seeded = await harness()
    const records = [...seeded.facility.get('agent_team')!.table('operations').entries()]
    const test = await harness(storedPool(records as Array<[string, unknown]>))
    await test.ctx.plugin(agentTeamInvariant)
    const table = test.facility.get('agent_team')!.table('operations')
    const [id, operation] = [...table.entries()][0]!
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 2 })
    const entries = vi.spyOn(table, 'entries')
    // The adopted conclusion is spent: the next mount check has no boot replay
    // left to reuse, so it replays the durable records and reports the
    // divergence it finds there.
    expect(() => test.ctx.agentTeam.validateLedgerAtMount()).toThrow(/expected sequence 1, found 2/)
    expect(entries).toHaveBeenCalledTimes(1)
    entries.mockRestore()
  })

  it('releases the deferred failure once a replay comes back clean', async () => {
    const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
    const test = await harness()
    await test.ctx.plugin(agentTeamInvariant)
    const table = test.facility.get('agent_team')!.table('operations')
    const [id, operation] = [...table.entries()][0]!
    const receipt = { operationId: id as AgentTeamOperationId, requestId: AGENT_TEAM_INITIALIZE_REQUEST_ID, sequence: 2, occurredAt: (operation as AgentTeamOperation).occurredAt }
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 2 })
    test.ctx.emit('agent-team/committed', { receipt })
    await settle()
    expect(() => test.ctx.emit('agent-team/committed', { receipt })).toThrow(/invariant violated/)
    await table.put(id, operation)
    // Whatever the commit above did, the next replay reads the repaired ledger.
    try { test.ctx.emit('agent-team/committed', { receipt }) } catch { /* still latched */ }
    await settle()
    expect(() => test.ctx.emit('agent-team/committed', { receipt })).not.toThrow()
  })

  it('rejects cross-Workspace refs and preserves durability before projection mutation', async () => {
    const pool = new MemoryMediaPool()
    const test = await harness(pool, [alpha, beta])
    pool.failNextWrites = 1
    await expect(test.ctx.agentTeam.createChannel({ requestId: requestId('failed'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })).rejects.toThrow(/injected write failure/)
    expect(test.ctx.agentTeam.status()).toMatchObject({ channelCount: 0, sequence: 1 })
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    expect(() => test.ctx.agentTeam.view({ workspaceId: beta, channelRef: channel.channel.channelRef })).toThrow(/does not belong to Workspace/)
  })

  it('explains a missing branded prefix when a Task ref lookup fails', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const bare = started.task.taskRef.replace(/^task:/, '') as AgentTeamTaskRef
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: bare })).rejects.toThrow(/unknown Task ref '.+' A Task ref must start with 'task:'/)
    expect(() => test.ctx.agentTeam.threadHistory({ workspaceId: alpha, taskRef: bare })).toThrow(/must start with 'task:'/)
    expect(() => test.ctx.agentTeam.view({ workspaceId: alpha, channelRef: 'engineering' as never })).toThrow(/unknown Channel ref 'engineering' A Channel ref must start with 'channel:'/)
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await expect(ledger.changeClaim({ requestId: requestId('done'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'done', baseRevision: claimed.thread.revision, claimRef: 'abc' as never, actor })).rejects.toThrow(/unknown Claim ref 'abc' A Claim ref must start with 'claim:'/)
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef })).resolves.toBeDefined()
  })

  it('resolves unambiguous UUID-prefix refs across ledger entry points', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const taskRef = started.task.taskRef
    const threadRef = started.thread.threadRef
    // Plain 6-hex prefix, a hyphenated truncated form, and the full ref all resolve.
    const taskPrefix = `${taskRef.slice(0, 'task:'.length + 6)}` as never
    const hyphenated = `${taskRef.slice(0, taskRef.indexOf('-') + 7)}` as never
    const threadPrefix = `${threadRef.slice(0, threadRef.indexOf('-') + 7)}` as never
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-prefix'), workspaceId: alpha, taskRef: taskPrefix })).resolves.toBeDefined()
    expect(() => test.ctx.agentTeam.threadHistory({ workspaceId: alpha, taskRef: taskPrefix })).not.toThrow()
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-hyphen'), workspaceId: alpha, taskRef: hyphenated })).resolves.toBeDefined()
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-thread'), workspaceId: alpha, threadRef: threadPrefix })).resolves.toBeDefined()
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim-prefix'), workspaceId: alpha,
      taskRef: taskPrefix, action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await expect(ledger.changeClaim({ requestId: requestId('done-prefix'), workspaceId: alpha, taskRef: taskPrefix,
      action: 'done', baseRevision: claimed.thread.revision, claimRef: `${claimed.claim.claimRef.slice(0, 'claim:'.length + 10)}` as never, actor })).resolves.toBeDefined()
  })

  it('rejects refs that are too short, unknown, or from another Workspace', async () => {
    const test = await harness(undefined, [alpha, beta])
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const taskRef = started.task.taskRef
    const shortPrefix = `${taskRef.slice(0, 'task:'.length + 5)}` as never
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-short'), workspaceId: alpha, taskRef: shortPrefix }))
      .rejects.toThrow(/unknown Task ref '.+' A Task ref needs at least 6 hex characters/)
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-miss'), workspaceId: alpha, taskRef: 'task:deadbe' as never }))
      .rejects.toThrow(/No Task matches this UUID prefix/)
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-beta'), workspaceId: beta, taskRef: `${taskRef.slice(0, 'task:'.length + 6)}` as never }))
      .rejects.toThrow(/does not belong to Workspace/)
  })

  it('reports ambiguous abbreviated refs with candidate full refs', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    let refs = 0
    const ledger = new AgentTeamLedger(test.facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>, {
      ref: kind => `${kind}:aaaaaa${String(refs++).padStart(2, '0')}-0000-0000-0000-000000000000` as never,
    })
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    await ledger.sendMessage({ requestId: requestId('first'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'First', actor })
    await ledger.sendMessage({ requestId: requestId('second'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Second', actor })
    await expect(ledger.readThread({ requestId: requestId('amb'), workspaceId: alpha, taskRef: 'task:aaaaaa' as never, actor }))
      .rejects.toThrow(/ambiguous Task ref 'task:aaaaaa' matches 'task:aaaaaa\d\d-0000-0000-0000-000000000000', 'task:aaaaaa\d\d-0000-0000-0000-000000000000'; reuse a longer prefix or the full ref exactly as returned by Team tools/)
    await expect(ledger.readThread({ requestId: requestId('amb-thread'), workspaceId: alpha, threadRef: 'thread:aaaaaa' as never, actor }))
      .rejects.toThrow(/ambiguous Thread ref 'thread:aaaaaa' matches/)
  })

  it('keeps archived Channel Task and Thread refs unreachable under abbreviation', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    await ledger.archiveChannel({ requestId: requestId('ch-arch'), workspaceId: alpha, channelRef: channel.channel.channelRef, actor: agentTeamHumanActor() })
    const taskPrefix = `${started.task.taskRef.slice(0, 'task:'.length + 6)}` as never
    const threadPrefix = `${started.thread.threadRef.slice(0, 'thread:'.length + 6)}` as never
    await expect(ledger.readThread({ requestId: requestId('read-task'), workspaceId: alpha, taskRef: taskPrefix, actor: agentTeamHumanActor() })).rejects.toThrow(/archived/)
    await expect(ledger.readThread({ requestId: requestId('read-thread'), workspaceId: alpha, threadRef: threadPrefix, actor: agentTeamHumanActor() })).rejects.toThrow(/archived/)
    expect(ledger.resolveTaskRefs(alpha, [taskPrefix])).toEqual([])
  })

  it('creates a taskless Thread, keeps Inbox visible, and promotes with a Task activity', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const sent = committed((await ledger.sendMessage({
      requestId: requestId('chat'), workspaceId: alpha, channelRef: channel.channel.channelRef,
      body: 'plain conversation', asTask: false, actor: agentTeamHumanActor(), recipients: [actor.memberId],
    })).value)
    expect(sent.task).toBeUndefined()
    expect(sent.thread.taskRef).toBeUndefined()
    expect(sent.message.taskRef).toBeUndefined()
    expect(sent.message.topLevel).toBe(true)
    const inbox = ledger.inbox(actor, { workspaceId: alpha })
    expect(inbox.totalDirectCount).toBe(1)
    expect(inbox.items[0]!.task).toBeUndefined()
    expect(inbox.items[0]!.thread.threadRef).toBe(sent.thread.threadRef)
    await expect(ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: 'task:missing' as AgentTeamTaskRef,
      action: 'claim', direction: 'work', baseRevision: sent.thread.revision, actor })).rejects.toThrow(/unknown Task/)
    const later = withTask(committed((await ledger.sendMessage({ asTask: true, requestId: requestId('later-task'),
      workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'later Task', actor: agentTeamHumanActor() })).value))
    const promoted = committed((await ledger.promoteThread({
      requestId: requestId('promote'), workspaceId: alpha, threadRef: sent.thread.threadRef,
      baseRevision: sent.thread.revision, actor: agentTeamHumanActor(),
    })).value)
    expect(promoted.task.status).toBe('todo')
    expect(promoted.thread.taskRef).toBe(promoted.task.taskRef)
    expect(promoted.activity).toMatchObject({ kind: 'promote', taskRef: promoted.task.taskRef, threadRef: sent.thread.threadRef, actor: AGENT_TEAM_HUMAN_MEMBER_ID })
    const after = ledger.inbox(actor, { workspaceId: alpha })
    expect(after.items[0]!.task?.taskRef).toBe(promoted.task.taskRef)
    const notificationFacts = ledger.notificationFacts(actor.memberId, { workspaceId: alpha })
    const promotedNotification = notificationFacts.find(entry => entry.item.thread.threadRef === sent.thread.threadRef)
    expect(promotedNotification?.facts.some(entry => entry.fact.kind === 'activity' && entry.fact.activity.kind === 'promote')).toBe(true)
    const history = ledger.threadHistory(actor, { workspaceId: alpha, threadRef: sent.thread.threadRef })
    expect(history.anchor.messageRef).toBe(sent.message.messageRef)
    expect(history.facts.map(fact => fact.kind === 'message' ? fact.message.body : fact.activity.kind)).toEqual([
      'plain conversation', 'promote',
    ])
    const view = ledger.view({ workspaceId: alpha, channelRef: channel.channel.channelRef, topLevelOnly: true, includeActivities: false })
    const promotedItem = view.items.find(item => item.thread.threadRef === sent.thread.threadRef)
    expect(promotedItem?.message.taskRef).toBeUndefined()
    expect(promotedItem?.task?.taskRef).toBe(promoted.task.taskRef)
    expect(promotedItem?.taskNumber).toBe(2)
    expect(view.taskNumbers).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskRef: later.task.taskRef, taskNumber: 1 }),
      expect.objectContaining({ taskRef: promoted.task.taskRef, taskNumber: 2 }),
    ]))
    expect(ledger.affectedMembersOf(replayLedger(test).getOperation(promoted.receipt.operationId)!)).toEqual(expect.arrayContaining([actor.memberId]))
    expect(() => replayLedger(test).validate()).not.toThrow()
  })
})

describe('AgentTeam Member archival ledger', () => {
  it('archives a Member: claims release, attention clears, view hides, removal still available', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('archive-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('archive-start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    committed((await ledger.changeClaim({ requestId: requestId('archive-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    expect(ledger.view({ workspaceId: alpha }).members).toEqual([expect.objectContaining({ memberId: member.memberId })])
    expect(ledger.view({ workspaceId: alpha }).tasks[0]).toMatchObject({ status: 'in_progress' })
    const archived = (await ledger.archiveMember({ requestId: requestId('archive'), memberId: member.memberId, actor: agentTeamHumanActor() })).value
    expect(archived.member.state).toBe('archived')
    expect(archived.member.sessionId).toBe(member.sessionId)
    expect(archived.releasedClaims).toEqual([expect.objectContaining({ claimRef: expect.any(String), owner: member.memberId, state: 'released' })])
    expect(archived.removedAttention).toEqual([expect.objectContaining({ memberId: member.memberId, threadRef: started.thread.threadRef })])

    // Hidden from the view members projection; the released claim drops the
    // Task back to todo; the archived Member's attention and markers are gone.
    expect(ledger.view({ workspaceId: alpha }).members).toEqual([])
    expect(ledger.view({ workspaceId: alpha }).tasks[0]).toMatchObject({ status: 'todo' })
    const activity = ledger.view({ workspaceId: alpha }).activities.find(fact => fact.kind === 'claims_released')
    expect(activity).toMatchObject({ kind: 'claims_released', actor: member.memberId })

    // Guards: double archive, suspend/resume, edit, mention, and DM all reject.
    await expect(ledger.archiveMember({ requestId: requestId('archive-again'), memberId: member.memberId, actor: agentTeamHumanActor() })).rejects.toThrow(/already archived/)
    await expect(ledger.suspendMember({ requestId: requestId('archive-suspend'), memberId: member.memberId, actor: agentTeamHumanActor() })).rejects.toThrow(/already archived/)
    await expect(ledger.resumeMember({ requestId: requestId('archive-resume'), memberId: member.memberId, actor: agentTeamHumanActor() })).rejects.toThrow(/already archived/)
    await expect(ledger.updateMember({ requestId: requestId('archive-edit'), memberId: member.memberId, handle: member.handle, description: 'new', actor: agentTeamHumanActor() })).rejects.toThrow(/archived and can no longer be edited/)
    const second = await addLedgerMember(ledger, channel.channel.channelRef, 'member:blocker')
    await expect(ledger.sendMessage({ requestId: requestId('archive-mention'), workspaceId: alpha, channelRef: channel.channel.channelRef,
      body: 'ping', recipients: [member.memberId], actor: agentTeamHumanActor() })).rejects.toThrow(/not authorized for Channel/)
    await expect(ledger.sendDm({ requestId: requestId('archive-dm'), workspaceId: alpha, recipientMemberId: member.memberId,
      body: 'still there?', actor: second.actor })).rejects.toThrow(/archived; DM delivery requires an enabled Member/)

    // Removal stays available from archived: the data hygiene path.
    const removed = (await ledger.removeMember({ requestId: requestId('archive-remove'), memberId: member.memberId, actor: agentTeamHumanActor() })).value
    expect(removed.member.state).toBe('inactive')
    ledger.validate()
  })

  it('archives a suspended Member and replays archival across a cold restart', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('susp-archive-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering Work' })
    const ledger = replayLedger(test)
    const { member } = await addLedgerMember(ledger, channel.channel.channelRef)
    await ledger.suspendMember({ requestId: requestId('susp-archive-suspend'), memberId: member.memberId, actor: agentTeamHumanActor() })
    const archived = (await ledger.archiveMember({ requestId: requestId('susp-archive'), memberId: member.memberId, actor: agentTeamHumanActor() })).value
    expect(archived.member.state).toBe('archived')
    ledger.validate()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => replayLedger(replayed).validate()).not.toThrow()
    const cold = replayLedger(replayed)
    expect(cold.getMember(member.memberId)?.state).toBe('archived')
  })

  it('rejects a forged archival release snapshot during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('forge-archive-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('forge-archive-start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    committed((await ledger.changeClaim({ requestId: requestId('forge-archive-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await ledger.archiveMember({ requestId: requestId('forge-archive'), memberId: member.memberId, actor: agentTeamHumanActor() })
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/member-archived') return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, claims: [] } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid released Claim projection/)
  })

  it('archives a Member that also follows a taskless Thread: attention clears there too', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('taskless-archive-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    // One taskful Thread (for the Claim) and one taskless Thread the Member
    // follows: leaving must clear Attention on BOTH, not just taskful ones —
    // the replay validator scopes cleanup to every Thread.
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('taskless-archive-task'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const plain = committed((await ledger.sendMessage({ requestId: requestId('taskless-archive-plain'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Plain conversation', asTask: false, actor: agentTeamHumanActor() })).value)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    committed((await ledger.changeClaim({ requestId: requestId('taskless-archive-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await ledger.changeAttention({ requestId: requestId('taskless-archive-follow'), workspaceId: alpha,
      threadRef: plain.thread.threadRef, action: 'follow', actor })
    const archived = (await ledger.archiveMember({ requestId: requestId('taskless-archive'), memberId: member.memberId, actor: agentTeamHumanActor() })).value
    expect(archived.removedAttention.map(entry => entry.threadRef).sort())
      .toEqual([plain.thread.threadRef, started.task.threadRef].sort())
    // The commit and the replay validator agree: cold replay validates clean.
    ledger.validate()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => replayLedger(replayed).validate()).not.toThrow()
  })

  it('rejects a forged Member departure inbox during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('forge-member-inbox-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('forge-member-inbox-task'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const plain = committed((await ledger.sendMessage({ requestId: requestId('forge-member-inbox-plain'), workspaceId: alpha,
      channelRef: channel.channel.channelRef, body: 'Plain conversation', asTask: false, actor: agentTeamHumanActor() })).value)
    const { member, actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    committed((await ledger.changeClaim({ requestId: requestId('forge-member-inbox-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await ledger.changeAttention({ requestId: requestId('forge-member-inbox-follow'), workspaceId: alpha,
      threadRef: plain.thread.threadRef, action: 'follow', actor })
    await ledger.archiveMember({ requestId: requestId('forge-member-inbox-archive'), memberId: member.memberId, actor: agentTeamHumanActor() })
    // The Channel archival path's own message is pinned by its test above; this
    // is the only place the Member-scoped wording and filter are asserted at all.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/member-archived') return [id, typed] as [string, unknown]
      const removed = typed.data.inbox.attention.removed.filter(entry => entry.threadRef !== plain.thread.threadRef)
      // Fail closed: a forge that removed nothing would vacuously "pass".
      expect(removed).toHaveLength(typed.data.inbox.attention.removed.length - 1)
      return [id, { ...typed, data: { ...typed.data, inbox: { ...typed.data.inbox, attention: { ...typed.data.inbox.attention, removed } } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid Member inbox cleanup/)
  })
})

describe('AgentTeam Channel archival ledger', () => {
  it('archives a Channel: every owner releases, attention clears, view hides, mutations reject', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('ch-arch-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const channelRef = channel.channel.channelRef
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('ch-arch-start'), workspaceId: alpha, channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const first = await addLedgerMember(ledger, channelRef, 'member:first')
    const second = await addLedgerMember(ledger, channelRef, 'member:second')
    const firstClaim = committed((await ledger.changeClaim({ requestId: requestId('ch-arch-claim-1'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'first direction', baseRevision: started.thread.revision, actor: first.actor })).value)
    committed((await ledger.changeClaim({ requestId: requestId('ch-arch-claim-2'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'second direction', baseRevision: firstClaim.thread.revision, actor: second.actor })).value)
    expect(ledger.view({ workspaceId: alpha }).tasks[0]).toMatchObject({ status: 'in_progress' })
    expect(ledger.view({ workspaceId: alpha }).channels).toEqual([expect.objectContaining({ channelRef })])

    const archived = (await ledger.archiveChannel({ requestId: requestId('ch-arch'), workspaceId: alpha, channelRef, actor: agentTeamHumanActor() })).value
    expect(archived.channel).toMatchObject({ channelRef, state: 'archived' })
    expect(archived.releasedClaims).toHaveLength(2)
    expect(archived.releasedClaims.map(claim => claim.owner).sort()).toEqual([first.member.memberId, second.member.memberId].sort())

    // Hidden from view: channel, threads, and tasks all leave the projection.
    // The per-owner release activities stay as durable audit facts on the
    // hidden Threads (replay validation in the cold-restart test recomputes
    // them exactly).
    expect(ledger.view({ workspaceId: alpha }).channels).toEqual([])
    expect(ledger.view({ workspaceId: alpha }).threads).toEqual([])
    expect(ledger.view({ workspaceId: alpha }).tasks).toEqual([])
    const operation = ledger.getOperation(archived.receipt.operationId)!
    expect(operation.kind === 'team/channel-archived' ? operation.data.activities.map(activity => activity.actor).sort()
      : []).toEqual([first.member.memberId, second.member.memberId].sort())

    // Idempotent retry; mutation guards reject with the archived message.
    const again = (await ledger.archiveChannel({ requestId: requestId('ch-arch'), workspaceId: alpha, channelRef, actor: agentTeamHumanActor() })).value
    expect(again.receipt.operationId).toBe(archived.receipt.operationId)
    await expect(ledger.archiveChannel({ requestId: requestId('ch-arch-2'), workspaceId: alpha, channelRef, actor: agentTeamHumanActor() })).rejects.toThrow(/already archived/)
    await expect(ledger.updateChannel({ requestId: requestId('ch-arch-rename'), workspaceId: alpha, channelRef, name: 'renamed', description: '', actor: agentTeamHumanActor() })).rejects.toThrow(/archived and no longer accepts Team work/)
    await expect(ledger.sendMessage({ requestId: requestId('ch-arch-send'), workspaceId: alpha, channelRef, body: 'hello', actor: agentTeamHumanActor() })).rejects.toThrow(/archived and no longer accepts Team work/)
    await expect(ledger.joinChannel({ requestId: requestId('ch-arch-join'), workspaceId: alpha, channelRef, memberId: first.member.memberId, actor: agentTeamHumanActor() })).rejects.toThrow(/archived and no longer accepts Team work/)
    // A brand-new Member cannot be created into the archived Channel, and
    // existing Members (Memberships survive archival) cannot follow or
    // mutate its Tasks.
    await expect((async () => addLedgerMember(ledger, channelRef, 'member:third'))()).rejects.toThrow(/archived and no longer accepts Team work/)
    await expect(ledger.changeAttention({ requestId: requestId('ch-arch-follow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'follow', actor: first.actor })).rejects.toThrow(/archived and no longer accepts Team work/)
    await expect(ledger.changeTask({ requestId: requestId('ch-arch-close'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'close', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).rejects.toThrow(/archived and no longer accepts Team work/)
    ledger.validate()
  })

  it('replays Channel archival across a cold restart', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('ch-replay-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('ch-replay-start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    committed((await ledger.changeClaim({ requestId: requestId('ch-replay-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await ledger.archiveChannel({ requestId: requestId('ch-replay-archive'), workspaceId: alpha, channelRef: channel.channel.channelRef, actor: agentTeamHumanActor() })
    ledger.validate()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => replayLedger(replayed).validate()).not.toThrow()
    expect(replayLedger(replayed).view({ workspaceId: alpha }).channels).toEqual([])
  })

  it('normalizes legacy channel records without state to active on load', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('ch-legacy-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('ch-legacy-start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' }))
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/channel-created') return [id, typed] as [string, unknown]
      const { state: _state, ...legacyChannel } = typed.data.channel
      return [id, { ...typed, data: { ...typed.data, channel: legacyChannel } }] as [string, unknown]
    })
    const legacy = await harness(storedPool(records))
    const legacyLedger = replayLedger(legacy)
    expect(() => legacyLedger.validate()).not.toThrow()
    expect(legacyLedger.view({ workspaceId: alpha }).channels[0]).toMatchObject({ channelRef: channel.channel.channelRef, state: 'active' })
  })

  it('rejects a forged Channel archival snapshot during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('ch-forge-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('ch-forge-start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    committed((await ledger.changeClaim({ requestId: requestId('ch-forge-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await ledger.archiveChannel({ requestId: requestId('ch-forge-archive'), workspaceId: alpha, channelRef: channel.channel.channelRef, actor: agentTeamHumanActor() })
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/channel-archived') return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, claims: [] } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid released Claim projection/)
  })

  it('archives a Channel containing a taskless Thread: cleanup covers it and cold restart replays', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('taskless-arch-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const channelRef = channel.channel.channelRef
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channelRef)
    // A taskless Thread carries Human and Member Attention that archival must clear.
    const chat = committed((await ledger.sendMessage({ requestId: requestId('taskless-arch-chat'), workspaceId: alpha, channelRef,
      body: 'plain conversation', asTask: false, actor: agentTeamHumanActor(), recipients: [actor.memberId] })).value)
    // A taskful Thread keeps the archival snapshot meaningful (claim release).
    const started = withTask(committed((await ledger.sendMessage({ requestId: requestId('taskless-arch-start'), workspaceId: alpha, channelRef,
      body: 'Task', actor: agentTeamHumanActor() })).value))
    committed((await ledger.changeClaim({ requestId: requestId('taskless-arch-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'work', baseRevision: started.thread.revision, actor })).value)

    const archived = (await ledger.archiveChannel({ requestId: requestId('taskless-arch-archive'), workspaceId: alpha, channelRef, actor: agentTeamHumanActor() })).value
    const operation = ledger.getOperation(archived.receipt.operationId)!
    const removed = operation.kind === 'team/channel-archived' ? operation.data.inbox.attention.removed : []
    expect(removed.map(entry => entry.threadRef)).toEqual(expect.arrayContaining([chat.thread.threadRef, started.thread.threadRef]))
    ledger.validate()

    // Cold restart: replay must accept the archive snapshot it wrote itself.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => replayLedger(replayed)).not.toThrow()
    expect(replayLedger(replayed).view({ workspaceId: alpha }).channels).toEqual([])
  })

  it('repairs a legacy Channel archival record that omitted taskless-Thread cleanup on load', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('legacy-arch-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    const chat = committed((await ledger.sendMessage({ requestId: requestId('legacy-arch-chat'), workspaceId: alpha, channelRef: channel.channel.channelRef,
      body: 'plain conversation', asTask: false, actor: agentTeamHumanActor(), recipients: [actor.memberId] })).value)
    const archived = (await ledger.archiveChannel({ requestId: requestId('legacy-arch-archive'), workspaceId: alpha, channelRef: channel.channel.channelRef, actor: agentTeamHumanActor() })).value
    // Rewrite the archive to the 0.1.7-0.1.9 shape: cleanup scoped to taskful Threads only.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/channel-archived') return [id, typed] as [string, unknown]
      const dropTaskless = (removed: readonly { threadRef: string }[]) => removed.filter(entry => entry.threadRef !== chat.thread.threadRef)
      return [id, { ...typed, data: { ...typed.data, inbox: {
        attention: { set: [], removed: dropTaskless(typed.data.inbox.attention.removed) },
        directMarkers: { added: [], removed: dropTaskless(typed.data.inbox.directMarkers.removed) },
        activityMarkers: { added: [], removed: dropTaskless(typed.data.inbox.activityMarkers.removed) },
      } } }] as [string, unknown]
    })
    const legacy = await harness(storedPool(records))
    const legacyLedger = replayLedger(legacy)
    expect(() => legacyLedger.validate()).not.toThrow()
    const repaired = legacyLedger.getOperation(archived.receipt.operationId)!
    expect(repaired.kind === 'team/channel-archived' ? repaired.data.inbox.attention.removed.map(entry => entry.threadRef) : [])
      .toContain(chat.thread.threadRef)
  })

  it('still rejects a forged Channel archival inbox during replay', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('forged-inbox-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    committed((await ledger.sendMessage({ requestId: requestId('forged-inbox-chat'), workspaceId: alpha, channelRef: channel.channel.channelRef,
      body: 'plain conversation', asTask: false, actor: agentTeamHumanActor(), recipients: [actor.memberId] })).value)
    const started = withTask(committed((await ledger.sendMessage({ requestId: requestId('forged-inbox-start'), workspaceId: alpha, channelRef: channel.channel.channelRef,
      body: 'Task', actor: agentTeamHumanActor() })).value))
    committed((await ledger.changeClaim({ requestId: requestId('forged-inbox-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'work', baseRevision: started.thread.revision, actor })).value)
    await ledger.archiveChannel({ requestId: requestId('forged-inbox-archive'), workspaceId: alpha, channelRef: channel.channel.channelRef, actor: agentTeamHumanActor() })
    // Forge the opposite omission (drop a taskful-Thread cleanup entry): not the legacy shape, so it must still fail.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/channel-archived') return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, inbox: {
        ...typed.data.inbox,
        attention: { set: [], removed: typed.data.inbox.attention.removed.filter(entry => entry.threadRef !== started.thread.threadRef) },
      } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid Channel archival inbox cleanup/)
  })
})

describe('AgentTeam archived read surfaces', () => {
  it('hides archived-Channel Tasks from ref resolution and rejects direct thread reads', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('reads-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('reads-start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    await ledger.changeAttention({ requestId: requestId('reads-follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    await ledger.readThread({ requestId: requestId('reads-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })
    // Pre-archival everything resolves and reads.
    expect(ledger.resolveTaskRefs(alpha, [started.task.taskRef])).toHaveLength(1)
    expect(ledger.threadHistory(actor, { workspaceId: alpha, taskRef: started.task.taskRef })).toMatchObject({ thread: { threadRef: started.thread.threadRef } })
    expect(ledger.threadObservations(agentTeamHumanActor(), { workspaceId: alpha, threadRef: started.thread.threadRef })).toBeTruthy()

    await ledger.archiveChannel({ requestId: requestId('reads-archive'), workspaceId: alpha, channelRef: channel.channel.channelRef, actor: agentTeamHumanActor() })

    // Archived Channels do not exist on Team API surfaces: refs stop
    // resolving and every ref-addressed read rejects with the explicit
    // archived error instead of an unknown-ref disguise.
    expect(ledger.resolveTaskRefs(alpha, [started.task.taskRef])).toEqual([])
    await expect(ledger.readThread({ requestId: requestId('reads-read-2'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).rejects.toThrow(/archived and no longer accepts Team work/)
    expect(() => ledger.threadHistory(actor, { workspaceId: alpha, taskRef: started.task.taskRef })).toThrow(/archived and no longer accepts Team work/)
    expect(() => ledger.threadObservations(agentTeamHumanActor(), { workspaceId: alpha, threadRef: started.thread.threadRef })).toThrow(/archived and no longer accepts Team work/)
    expect(() => ledger.view({ workspaceId: alpha, threadRef: started.thread.threadRef })).toThrow(/archived and no longer accepts Team work/)
    await expect(ledger.changeAttention({ requestId: requestId('reads-unfollow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'unfollow', actor })).rejects.toThrow(/archived and no longer accepts Team work/)
    expect(() => ledger.listClaims(actor, { workspaceId: alpha, taskRef: started.task.taskRef })).toThrow(/archived and no longer accepts Team work/)

    // The durable layer stays whole: replay validates every pre-archival
    // read against the then-active Channel, and the facts survive intact.
    ledger.validate()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => replayLedger(replayed).validate()).not.toThrow()
    const cold = replayLedger(replayed)
    expect(cold.getTask(started.task.taskRef)).toMatchObject({ taskRef: started.task.taskRef })
    expect(cold.resolveTaskRefs(alpha, [started.task.taskRef])).toEqual([])
  })

  it('excludes archived-Channel Threads from every Inbox slice', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('inbox-channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('inbox-start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Task' })))
    const ledger = replayLedger(test)
    const { actor } = await addLedgerMember(ledger, channel.channel.channelRef)
    await ledger.readThread({ requestId: requestId('inbox-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })
    // Pre-archival the participated Thread is the Human recent tail's.
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toMatchObject({ items: [],
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.thread.threadRef }) })] })

    await ledger.archiveChannel({ requestId: requestId('inbox-archive'), workspaceId: alpha, channelRef: channel.channel.channelRef, actor: agentTeamHumanActor() })

    // Archived Channels do not exist on Team API surfaces: neither the unread
    // queue nor the Human recent tail names their Threads, for the Human or
    // for a Member, and the picture survives a cold restart.
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0 })
    expect(ledger.inbox(actor, { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0 })
    expect(ledger.memberInbox(actor, {})).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0 })
    expect(replayLedger(test).inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0 })
  })
})

describe('AgentTeam Member session rollover ledger command', () => {
  it('commits a model-actor rollover, moves exactly the sessionId, and keeps every other fact', async () => {
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    const newSessionId = SessionId(`agent-team-rollover-${crypto.randomUUID()}`)
    const rolled = (await ledger.rolloverMemberSession({
      requestId: requestId('rollover'), workspaceId: alpha, memberId: member.memberId, actor,
      previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 42 as never, trigger: 'model',
    })).value
    expect(rolled.member.sessionId).toBe(newSessionId)
    expect(rolled.member).toMatchObject({ memberId: member.memberId, handle: member.handle, state: 'enabled', privateMemoryPath: member.privateMemoryPath })
    expect(ledger.getMember(member.memberId)?.sessionId).toBe(newSessionId)
    // The durable envelope records anchors and trigger, never handoff prose.
    const operation = [...pool.media.get('agent_team')!.tables.get('operations')!.values() as Iterable<AgentTeamOperation>]
      .find(op => op.kind === 'team/member-session-rolled-over')
    expect(operation).toMatchObject({
      kind: 'team/member-session-rolled-over',
      data: { previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 42, trigger: 'model' },
    })
    if (operation?.kind !== 'team/member-session-rolled-over') throw new Error('expected rollover operation')
    expect(operation.data.member.sessionId).toBe(newSessionId)
    expect(operation.data.sourceSessionId).toBeUndefined()
    expect(operation.data.checkpointRef).toBeUndefined()
    expect(() => replayLedger(test).validate()).not.toThrow()
  })

  it('rejects another Member, a stale previous binding, human actors, and mismatched replay data', async () => {
    const test = await harness()
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    const { actor: other } = await addLedgerMember(ledger, undefined, `member:agent-${crypto.randomUUID()}`)
    const newSessionId = SessionId(`agent-team-rollover-${crypto.randomUUID()}`)
    // A Member cannot roll over another Member's Session.
    await expect(ledger.rolloverMemberSession({
      requestId: requestId('cross'), workspaceId: alpha, memberId: member.memberId, actor: other,
      previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 7 as never, trigger: 'model',
    })).rejects.toThrow(/cannot roll over another Member/)
    // Human authority is reserved for renewals; the rollover is Member-authored.
    await expect(ledger.rolloverMemberSession({
      requestId: requestId('human'), workspaceId: alpha, memberId: member.memberId, actor: agentTeamHumanActor() as never,
      previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 7 as never, trigger: 'model',
    })).rejects.toThrow(/requires Member authority/)
    // The previous binding must still be current at commit time.
    await expect(ledger.rolloverMemberSession({
      requestId: requestId('stale'), workspaceId: alpha, memberId: member.memberId, actor,
      previousSessionId: SessionId('agent-team-stale'), newSessionId, handoffEventSeq: 7 as never, trigger: 'model',
    })).rejects.toThrow(/no longer bound/)
    const rolled = (await ledger.rolloverMemberSession({
      requestId: requestId('rollover'), workspaceId: alpha, memberId: member.memberId, actor,
      previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 7 as never, trigger: 'pressure',
    })).value
    // An exact retry resolves the recorded outcome with the same receipt.
    const again = (await ledger.rolloverMemberSession({
      requestId: requestId('rollover'), workspaceId: alpha, memberId: member.memberId, actor,
      previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 7 as never, trigger: 'pressure',
    })).value
    expect(again.receipt.operationId).toBe(rolled.receipt.operationId)
    // The same requestId with different data collides instead of resolving.
    await expect(ledger.rolloverMemberSession({
      requestId: requestId('rollover'), workspaceId: alpha, memberId: member.memberId, actor,
      previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 9 as never, trigger: 'model',
    })).rejects.toThrow(/request id/)
    expect(() => replayLedger(test).validate()).not.toThrow()
  })

  it('requires checkpoint seed fields to appear together and replays a seeded rollover', async () => {
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const ledger = replayLedger(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    const newSessionId = SessionId(`agent-team-rollover-${crypto.randomUUID()}`)
    // A through sequence without a source Session is incomplete lineage.
    await expect(ledger.rolloverMemberSession({
      requestId: requestId('orphan-seq'), workspaceId: alpha, memberId: member.memberId, actor,
      previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 5 as never, trigger: 'model',
      sourceThroughSeq: 30 as never,
    })).rejects.toThrow(/requires a source Session/)
    // A checkpoint ref without a source Session is likewise incomplete.
    await expect(ledger.rolloverMemberSession({
      requestId: requestId('orphan-ref'), workspaceId: alpha, memberId: member.memberId, actor,
      previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 5 as never, trigger: 'model',
      checkpointRef: 'context-checkpoint:abc' as never,
    })).rejects.toThrow(/must appear together/)
    const rolled = (await ledger.rolloverMemberSession({
      requestId: requestId('seeded'), workspaceId: alpha, memberId: member.memberId, actor,
      previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 5 as never, trigger: 'model',
      sourceSessionId: member.sessionId, sourceThroughSeq: 30 as never, checkpointRef: 'context-checkpoint:abc' as never,
    })).value
    expect(rolled.member.sessionId).toBe(newSessionId)
    const operation = [...pool.media.get('agent_team')!.tables.get('operations')!.values() as Iterable<AgentTeamOperation>]
      .find(op => op.kind === 'team/member-session-rolled-over')
    if (operation?.kind !== 'team/member-session-rolled-over') throw new Error('expected seeded rollover operation')
    expect(operation.data.sourceSessionId).toBe(member.sessionId)
    expect(operation.data.sourceThroughSeq).toBe(30)
    expect(operation.data.checkpointRef).toBe('context-checkpoint:abc')
    expect(() => replayLedger(test).validate()).not.toThrow()
  })

  it('rejects a forged rollover that moves more than the sessionId during replay', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const ledger = replayLedger(first)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    const newSessionId = SessionId(`agent-team-rollover-${crypto.randomUUID()}`)
    await ledger.rolloverMemberSession({
      requestId: requestId('rollover'), workspaceId: alpha, memberId: member.memberId, actor,
      previousSessionId: member.sessionId, newSessionId, handoffEventSeq: 1 as never, trigger: 'model',
    })
    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.entries()]
    await first.fiber.dispose()
    cleanups.pop()
    // Forge the recorded member snapshot: the handle changed alongside the
    // sessionId, which a real rollover never does.
    const forged = records.map(([key, operation]) => {
      if (typeof operation !== 'object' || operation === null || (operation as AgentTeamOperation).kind !== 'team/member-session-rolled-over') return [key, operation] as [string, unknown]
      const rolled = operation as Extract<AgentTeamOperation, { kind: 'team/member-session-rolled-over' }>
      return [key, { ...rolled, data: { ...rolled.data, member: { ...rolled.data.member, handle: 'impostor' } } }] as [string, unknown]
    })
    await expect(harness(storedPool(forged))).rejects.toThrow(/invalid Member session rollover/)
  })
})

describe('AgentTeam durable Thread read progress', () => {
  /**
   * A live facility holding one committed Human Thread read — a reply from a
   * Member the Human had not seen — plus the picture that read answered with,
   * which the legacy snapshot form needs to rebuild the record it used to write.
   */
  async function committedHumanRead(): Promise<{ readonly test: TeamHarness; readonly read: AgentTeamThreadReadResult; readonly records: Array<[string, unknown]> }> {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Investigate the regression' })))
    const writer = replayLedger(test)
    const { actor } = await addLedgerMember(writer, channel.channel.channelRef)
    let revision = sent.thread.revision
    for (const body of ['Working on it', 'Pushed a fix']) {
      revision = committed((await writer.reply({ requestId: requestId(body), workspaceId: alpha, taskRef: sent.task.taskRef, body, baseRevision: revision, actor })).value).thread.revision
    }
    const outcome = await writer.readThread({ requestId: requestId('human-read'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
    if (!outcome.committed) throw new Error('expected the Human read to commit a receipt')
    return { test, read: outcome.value, records: [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]> }
  }

  /** Rewrite every slim Thread read record of one ledger through `shape`. */
  function reshapeReads(records: Array<[string, unknown]>, shape: (operation: AgentTeamThreadReadOperation) => AgentTeamThreadReadData): Array<[string, unknown]> {
    return records.map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-read') return [id, typed] as [string, unknown]
      return [id, { ...typed, data: shape(typed) }] as [string, unknown]
    })
  }

  it('answers a Thread with nothing unread for its reader without writing a receipt', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Investigate the regression' })))
    const table = test.facility.get('agent_team')!.table('operations')
    const committedOperations = table.size
    const commits: unknown[] = []
    test.ctx.on('agent-team/committed', payload => commits.push(payload))

    // The creator's own opening is never unread for the creator, so this read
    // has no watermark to advance and no marker to consume.
    const read = await test.ctx.agentTeam.readThread({ requestId: requestId('read-nothing'), workspaceId: alpha, taskRef: sent.task.taskRef })

    // Nothing changed, so nothing is written: no record, no commit event (and
    // therefore no deferred replay), and no receipt for an operation that does
    // not exist.
    expect(table.size).toBe(committedOperations)
    expect(commits).toEqual([])
    expect(read.receipt).toBeUndefined()
    // The picture is still the whole Thread state, not a stub: a no-op read
    // shares the committed read's derivation.
    expect(read.task).toEqual(sent.task)
    expect(read.thread).toEqual(sent.thread)
    expect(read.anchor.messageRef).toBe(sent.message.messageRef)
    expect(read.remainingUnreadCount).toBe(0)
    expect(read.facts.some(fact => fact.unread)).toBe(false)
  })

  it('keeps the watermark a progress read advanced across a restart', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Investigate the regression' })))
    const writer = replayLedger(test)
    const { actor } = await addLedgerMember(writer, channel.channel.channelRef)
    committed((await writer.reply({ requestId: requestId('agent-reply'), workspaceId: alpha, taskRef: sent.task.taskRef, body: 'Working on it', baseRevision: sent.thread.revision, actor })).value)

    // A reply the reader has not seen is real progress: it commits a watermark.
    const first = await writer.readThread({ requestId: requestId('human-read'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
    expect(first.committed).toBe(true)
    expect(first.value.remainingUnreadCount).toBe(0)
    const records = [...test.facility.get('agent_team')!.table('operations').entries()]

    const revived = await harness(storedPool(records as Array<[string, unknown]>))
    const reader = replayLedger(revived)
    const again = await reader.readThread({ requestId: requestId('human-read-after-restart'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })

    // The acknowledged reply stayed acknowledged: a restart that lost the
    // recorded progress would have to write it again here.
    expect(again.value.remainingUnreadCount).toBe(0)
    expect(again.committed).toBe(false)
  })

  it('drains unread replies by remainingUnreadCount and stops writing once caught up', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Investigate the regression' })))
    const writer = replayLedger(test)
    const { actor } = await addLedgerMember(writer, channel.channel.channelRef)
    let revision = sent.thread.revision
    for (const body of ['first reply', 'second reply', 'third reply']) {
      const replied = committed((await writer.reply({ requestId: requestId(body), workspaceId: alpha, taskRef: sent.task.taskRef, body, baseRevision: revision, actor })).value)
      revision = replied.thread.revision
    }

    const reader = replayLedger(test)
    const table = test.facility.get('agent_team')!.table('operations')
    let rounds = 0
    while (rounds < 10) {
      const read = await reader.readThread({ requestId: requestId(`drain-${rounds}`), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
      if (!read.committed) throw new Error('expected every unread round to commit')
      rounds += 1
      if (read.value.remainingUnreadCount === 0) break
    }
    expect(rounds).toBeGreaterThan(0)
    expect((await reader.readThread({ requestId: requestId('drain-final'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })).value.remainingUnreadCount).toBe(0)

    // Caught up: the drain stops on the unread count, and the next read writes
    // nothing at all — including a retry of that same request id, which is not
    // a durable operation and so is answered from the current projection.
    const settled = table.size
    const extra = await reader.readThread({ requestId: requestId('drain-extra'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
    expect(extra.committed).toBe(false)
    expect(extra.value.receipt).toBeUndefined()
    const retry = await reader.readThread({ requestId: requestId('drain-extra'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
    expect(retry.committed).toBe(false)
    expect(retry.value.remainingUnreadCount).toBe(0)
    expect(table.size).toBe(settled)
  })

  it('stores a committing read as the slim receipt: progress and its Inbox, with no Thread picture', async () => {
    const { records, read } = await committedHumanRead()
    const record = records.map(([, operation]) => operation as AgentTeamOperation).find(operation => operation.kind === 'team/thread-read')
    if (record?.kind !== 'team/thread-read') throw new Error('expected a durable Thread read record')

    // The durable content is exactly the progress the read made and the Inbox
    // delta it consumed. The Thread, its facts, the anchor, the Attention row
    // and the count it left behind are projection state a replay re-derives for
    // every surface that needs them, so freezing them here only adds weight
    // nothing reads back.
    expect(isThreadReadSnapshot(record.data)).toBe(false)
    expect(Object.keys(record.data).sort()).toEqual(['inbox', 'memberId', 'readThroughSequence', 'taskRef', 'threadRef', 'workspaceId'])
    expect(record.data.readThroughSequence).toBe(read.readThroughSequence)
    expect(record.data.inbox).toEqual(expect.objectContaining({ attention: expect.objectContaining({ set: expect.any(Array) }) }))
  })

  it('refuses to open a slim Thread read record that grows a picture field or loses its watermark', async () => {
    const { records } = await committedHumanRead()
    const record = records.map(([, operation]) => operation as AgentTeamOperation).find(operation => operation.kind === 'team/thread-read')
    if (record?.kind !== 'team/thread-read' || isThreadReadSnapshot(record.data)) throw new Error('expected one slim Thread read record')
    const attention = record.data.inbox.attention.set[0]
    if (attention === undefined) throw new Error('expected the read to record an Attention advance')

    // Both forms are strict and disjoint, so a stored record parses as exactly
    // one of them. A field that only the frozen picture form ever carried is
    // therefore not "extra data" a newer reader may ignore: it makes the record
    // neither form, and the whole domain refuses to open rather than guess.
    await expect(harness(storedPool(reshapeReads(records, operation => ({ ...operation.data as AgentTeamThreadReadReceipt, attention }))))).rejects.toThrow(/does not match its schema/)
    // Progress is the receipt's whole content, so a read that reports none is
    // not a receipt either.
    await expect(harness(storedPool(reshapeReads(records, operation => {
      const { readThroughSequence: _dropped, ...rest } = operation.data as AgentTeamThreadReadReceipt
      return rest as AgentTeamThreadReadData
    })))).rejects.toThrow(/does not match its schema/)
  })

  it('rejects a slim Thread read receipt that under-reports the progress it made or the Task it belongs to', async () => {
    const { records } = await committedHumanRead()
    // Forging the watermark down keeps the record internally consistent — the
    // Inbox delta still advances Attention to the real watermark — so only the
    // independent derivation from the record's own prior projection can catch
    // a read that claims less progress than the ledger already gave it.
    await expect(harness(storedPool(reshapeReads(records, operation => ({
      ...operation.data as AgentTeamThreadReadReceipt, readThroughSequence: (operation.data as AgentTeamThreadReadReceipt).readThroughSequence - 1,
    }))))).rejects.toThrow(/invalid Thread read receipt/)
    // Identity is derived too: a Task Thread read that drops the Task it
    // belongs to would otherwise shrink its own claim unchecked, because the
    // Thread alone still resolves the same read.
    await expect(harness(storedPool(reshapeReads(records, operation => {
      const { taskRef: _dropped, ...rest } = operation.data as AgentTeamThreadReadReceipt
      return rest as AgentTeamThreadReadData
    })))).rejects.toThrow(/invalid Thread read receipt/)
  })

  it('rejects a legacy Thread read snapshot whose recorded facts were trimmed', async () => {
    const { read, records } = await committedHumanRead()
    const snapshots = reshapeReads(records, operation => snapshotReadData(operation.data as AgentTeamThreadReadReceipt, read))
    const stored = snapshots.map(([, operation]) => operation as AgentTeamOperation).find(operation => operation.kind === 'team/thread-read')
    if (stored?.kind !== 'team/thread-read' || !isThreadReadSnapshot(stored.data)) throw new Error('expected one legacy Thread read snapshot')
    expect(stored.data.facts.length).toBeGreaterThan(1)

    // A snapshot is not a trusted record just because it is old: the legacy
    // form still gets the full picture derivation, so trimming one fact the
    // read answered with is a forged projection, not a smaller record.
    await expect(harness(storedPool(reshapeReads(records, operation => {
      const snapshot = snapshotReadData(operation.data as AgentTeamThreadReadReceipt, read)
      return { ...snapshot, facts: snapshot.facts.slice(0, -1) }
    })))).rejects.toThrow(/invalid Thread read projection/)
  })

  it('opens and validates a legacy Thread read snapshot without rewriting one stored byte', async () => {
    const { read, records } = await committedHumanRead()
    const snapshots = reshapeReads(records, operation => snapshotReadData(operation.data as AgentTeamThreadReadReceipt, read))
    const pool = storedPool(snapshots)
    const revived = await harness(pool)
    revived.ctx.agentTeam.validateLedger()

    // Loading normalizes the projection, never the record: an installation that
    // upgrades keeps every ledger byte it already committed, and the legacy
    // read stays a legacy read.
    expect([...pool.media.get('agent_team')!.tables.get('operations')!.entries()]).toEqual(snapshots)
    const stored = [...pool.media.get('agent_team')!.tables.get('operations')!.values()]
      .map(operation => operation as AgentTeamOperation).find(operation => operation.kind === 'team/thread-read')
    if (stored?.kind !== 'team/thread-read') throw new Error('expected the Thread read record to survive the boot')
    expect(isThreadReadSnapshot(stored.data)).toBe(true)
  })

  it('replays frozen snapshots and slim receipts into the same projections, mixed or uniform', async () => {
    const test = await harness()
    const channel = await test.ctx.agentTeam.createChannel({ requestId: requestId('channel'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId('start'), workspaceId: alpha, channelRef: channel.channel.channelRef, body: 'Investigate the regression' })))
    const writer = replayLedger(test)
    const { actor } = await addLedgerMember(writer, channel.channel.channelRef)
    await writer.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: sent.task.taskRef, action: 'follow', actor })
    const claimed = committed((await writer.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: sent.task.taskRef,
      action: 'claim', direction: 'read the regression', baseRevision: sent.thread.revision, actor })).value)
    committed((await writer.reply({ requestId: requestId('agent-reply'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: 'Working on it', baseRevision: claimed.thread.revision, actor })).value)
    const humanReadId = requestId('human-read')
    const memberReadId = requestId('member-read')
    // The Human drains the claim and the reply, replies in turn, and the Member
    // drains that: two committed reads over one Thread, at different points.
    const humanOutcome = await writer.readThread({ requestId: humanReadId, workspaceId: alpha, taskRef: sent.task.taskRef, actor: agentTeamHumanActor() })
    if (!humanOutcome.committed) throw new Error('expected the Human read to commit a receipt')
    committed((await writer.reply({ requestId: requestId('human-reply'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: 'Please continue', baseRevision: humanOutcome.value.readThroughSequence, actor: agentTeamHumanActor() })).value)
    const memberOutcome = await writer.readThread({ requestId: memberReadId, workspaceId: alpha, taskRef: sent.task.taskRef, actor })
    if (!memberOutcome.committed) throw new Error('expected the Member read to commit a receipt')
    const pictures = new Map<AgentTeamRequestId, Omit<AgentTeamThreadReadResult, 'receipt'>>([[humanReadId, humanOutcome.value], [memberReadId, memberOutcome.value]])
    const base = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const asSnapshot = (operation: AgentTeamThreadReadOperation): AgentTeamThreadReadData => isThreadReadSnapshot(operation.data)
      ? operation.data : snapshotReadData(operation.data, pictures.get(operation.requestId)!)
    const asReceipt = (operation: AgentTeamThreadReadOperation): AgentTeamThreadReadData => isThreadReadSnapshot(operation.data)
      ? receiptReadData(operation.data) : operation.data

    // Three ledgers that record the same two reads three ways: the pre-slim
    // shape, the slim shape, and one of each. Every other record is identical.
    const variants = [reshapeReads(base, asSnapshot), reshapeReads(base, asReceipt),
      reshapeReads(base, operation => operation.requestId === humanReadId ? asSnapshot(operation) : asReceipt(operation))]
    const summary = (instance: TeamHarness) => {
      const ledger = replayLedger(instance)
      return {
        status: instance.ctx.agentTeam.status(),
        view: instance.ctx.agentTeam.view({ workspaceId: alpha, threadRef: sent.thread.threadRef }),
        inbox: ledger.inbox(actor, { workspaceId: alpha }),
        attention: ledger.attentionStatus(actor, { workspaceId: alpha, taskRef: sent.task.taskRef }),
        history: ledger.threadHistory(actor, { workspaceId: alpha, taskRef: sent.task.taskRef }),
      }
    }
    const booted: unknown[] = []
    for (const records of variants) {
      const revived = await harness(storedPool(records))
      replayLedger(revived).validate()
      booted.push(summary(revived))
    }
    expect(booted[0]).toBeDefined()
    expect(booted[1]).toEqual(booted[0])
    expect(booted[2]).toEqual(booted[0])
  })
})

describe('body-authored mentions', () => {
  /** One Channel and every write in it run through the same ledger projection. */
  async function channelOf(test: TeamHarness) {
    const ledger = replayLedger(test)
    const created = (await ledger.createChannel({ requestId: requestId('channel'), actor: agentTeamHumanActor(), workspaceId: alpha,
      name: 'engineering', description: 'Engineering work' })).value
    return { ledger, channelRef: created.channel.channelRef }
  }

  /** A Member with a readable handle and a realistic branded id. */
  const enroll = (ledger: AgentTeamLedger, channelRef: string, handle: string) =>
    addLedgerMember(ledger, channelRef, `member:${crypto.randomUUID()}`, 'Test Agent', handle)

  const start = async (ledger: AgentTeamLedger, channelRef: string, body: string) =>
    withTask(committed((await ledger.sendMessage({ requestId: requestId(`start:${crypto.randomUUID()}`), actor: agentTeamHumanActor(),
      asTask: true, workspaceId: alpha, channelRef: channelRef as never, body })).value))

  it('drops a body mention the Thread has never carried and reports it as undelivered', async () => {
    const test = await harness()
    const { ledger, channelRef } = await channelOf(test)
    const sent = await start(ledger, channelRef, 'Investigate the regression')
    const author = await enroll(ledger, channelRef, 'author')
    const stranger = await enroll(ledger, channelRef, 'stranger')

    // A text mention never fails the write. Inviting a Member into an existing
    // Thread stays a Human decision, so the named Member is reported instead.
    const reply = committed((await ledger.reply({ requestId: requestId('reply'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@stranger, please look at this', baseRevision: sent.thread.revision, actor: author.actor })).value)
    expect(reply.message.body).toBe('@stranger, please look at this')
    expect(reply.undeliveredMentions).toEqual([stranger.member.memberId])
    expect(reply.directMarkers).toEqual([])
    expect(ledger.attentionStatus(stranger.actor, { workspaceId: alpha, threadRef: sent.thread.threadRef }).attention).toBeUndefined()
    expect(ledger.inbox(stranger.actor, { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0 })
  })

  it('delivers to a Member the Thread already carried, even after it unfollowed', async () => {
    const test = await harness()
    const { ledger, channelRef } = await channelOf(test)
    const peer = await enroll(ledger, channelRef, 'peer')
    const author = await enroll(ledger, channelRef, 'author')

    // A body mention on a new Thread enrolls the peer: they follow it.
    const sent = await start(ledger, channelRef, '@peer, please join')
    expect(ledger.attentionStatus(peer.actor, { workspaceId: alpha, taskRef: sent.task.taskRef }).attention).toBeDefined()
    await ledger.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: sent.task.taskRef, action: 'unfollow', actor: peer.actor })
    expect(ledger.attentionStatus(peer.actor, { workspaceId: alpha, taskRef: sent.task.taskRef }).attention).toBeUndefined()

    // Having taken part once is what makes the mention deliverable: re-joining a
    // Thread a Member already belonged to is not an invitation.
    const reply = committed((await ledger.reply({ requestId: requestId('reply'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@peer, back on this please', baseRevision: sent.thread.revision, actor: author.actor })).value)
    expect(reply.undeliveredMentions).toBeUndefined()
    expect(reply.directMarkers).toEqual([expect.objectContaining({ memberId: peer.member.memberId })])
    expect(ledger.attentionStatus(peer.actor, { workspaceId: alpha, threadRef: sent.thread.threadRef }).attention).toBeDefined()
    expect(ledger.inbox(peer.actor, { workspaceId: alpha })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1 })
  })

  it('keeps the Human confirmation step for a body mention, then delivers once confirmed', async () => {
    const test = await harness()
    const { ledger, channelRef } = await channelOf(test)
    const sent = await start(ledger, channelRef, 'Investigate the regression')
    const stranger = await enroll(ledger, channelRef, 'stranger')

    const held = (await ledger.reply({ requestId: requestId('reply'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@stranger, please look', baseRevision: sent.thread.revision, actor: agentTeamHumanActor() })).value
    if (held.kind !== 'confirmation_required') throw new Error(`expected confirmation, received ${held.kind}`)
    // Nothing commits while the Human has not confirmed, and the Flow survives
    // re-resolution of the same body.
    expect(ledger.attentionStatus(stranger.actor, { workspaceId: alpha, threadRef: sent.thread.threadRef }).attention).toBeUndefined()

    const invited = committed((await ledger.reply({ requestId: requestId('reply-confirmed'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@stranger, please look', baseRevision: sent.thread.revision, actor: agentTeamHumanActor(), confirmationToken: held.confirmationToken })).value)
    expect(invited.directMarkers).toEqual([expect.objectContaining({ memberId: stranger.member.memberId })])
    expect(ledger.attentionStatus(stranger.actor, { workspaceId: alpha, threadRef: sent.thread.threadRef }).attention).toBeDefined()
  })

  it('expands @all to the roster as of that write', async () => {
    const test = await harness()
    const { ledger, channelRef } = await channelOf(test)
    const first = await enroll(ledger, channelRef, 'first')
    const second = await enroll(ledger, channelRef, 'second')

    const sent = committed((await ledger.sendMessage({ requestId: requestId('all'), actor: agentTeamHumanActor(), workspaceId: alpha,
      channelRef: channelRef as never, body: '@all, standup in ten minutes' })).value)
    const late = await enroll(ledger, channelRef, 'late')

    // The expansion is snapshotted into the operation: a Member who joins the
    // Channel afterwards is not retroactively addressed by this write.
    expect(sent.directMarkers.map(marker => marker.memberId).sort()).toEqual([first.member.memberId, second.member.memberId].sort())
    expect(ledger.inbox(late.actor, { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], recent: [], totalUnreadCount: 0, totalDirectCount: 0 })
  })

  it('merges explicit recipients with body mentions without duplicating a Member', async () => {
    const test = await harness()
    const { ledger, channelRef } = await channelOf(test)
    const first = await enroll(ledger, channelRef, 'first')
    const second = await enroll(ledger, channelRef, 'second')

    const sent = committed((await ledger.sendMessage({ requestId: requestId('merge'), actor: agentTeamHumanActor(), workspaceId: alpha,
      channelRef: channelRef as never, body: '@first please look', recipients: [first.member.memberId, second.member.memberId] })).value)
    expect(sent.directMarkers.map(marker => marker.memberId).sort()).toEqual([first.member.memberId, second.member.memberId].sort())
  })

  it('keeps @human deliverable after the human renames, under any casing', async () => {
    const test = await harness()
    const { ledger, channelRef } = await channelOf(test)
    const sent = await start(ledger, channelRef, 'Investigate the regression')
    const author = await enroll(ledger, channelRef, 'author')
    ledger.setHumanDisplayHandle('YuCreate')

    // The historic literal survives as a permanent alias: every casing reaches
    // the same human, and the inbox counts it as a direct mention.
    const aliased = committed((await ledger.reply({ requestId: requestId('reply-alias'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@human and @Human, heads up', baseRevision: sent.thread.revision, actor: author.actor })).value)
    expect(aliased.undeliveredMentions).toBeUndefined()
    expect(aliased.directMarkers.map(marker => marker.memberId)).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toMatchObject({ totalDirectCount: 1 })

    const renamed = committed((await ledger.reply({ requestId: requestId('reply-renamed'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@YuCreate, same thing', baseRevision: aliased.thread.revision, actor: author.actor })).value)
    expect(renamed.directMarkers.map(marker => marker.memberId)).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])

    // Both names in one body still notify the human exactly once.
    const both = committed((await ledger.reply({ requestId: requestId('reply-both'), workspaceId: alpha, taskRef: sent.task.taskRef,
      body: '@human aka @YuCreate, once please', baseRevision: renamed.thread.revision, actor: author.actor })).value)
    expect(both.directMarkers.map(marker => marker.memberId)).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toMatchObject({ totalDirectCount: 3 })
  })

  it('reserves the historic human literal against agent handles even after a rename', async () => {
    const test = await harness()
    const { ledger, channelRef } = await channelOf(test)
    ledger.setHumanDisplayHandle('YuCreate')
    await expect(enroll(ledger, channelRef, 'human')).rejects.toThrow('reserved human alias')
    await expect(enroll(ledger, channelRef, 'Human')).rejects.toThrow('reserved human alias')
  })
})

/**
 * The gate's thresholds are row configuration the settings document omits, so
 * the Host resolves an omitted field rather than publishing a second copy of a
 * number nobody chose. Two of the three are the engine's to answer; the judge's
 * budget is Team's, because a judge is reached over a network and the engine's
 * default is sized for one beside the Host.
 */
describe('AgentTeam gate thresholds as the settings surface reports them', () => {
  it('answers the judge\'s budget itself and leaves the other two to the engine', async () => {
    const plain = await harness()

    expect(plain.ctx.agentTeam.contextJudgeForClient({}).gate).toEqual({
      tokens: DEFAULT_GATE_TOKENS,
      idleMs: DEFAULT_GATE_IDLE_MS,
      judgeTimeoutMs: 10_000,
    })
  })

  it('keeps every threshold a deployment states, including a judge budget below Team\'s own', async () => {
    const stated = await harness(undefined, undefined, { gate: { tokens: 64_000, idleMs: 60_000, judgeTimeoutMs: 3_000 } })

    expect(stated.ctx.agentTeam.contextJudgeForClient({}).gate).toEqual({ tokens: 64_000, idleMs: 60_000, judgeTimeoutMs: 3_000 })
  })
})
