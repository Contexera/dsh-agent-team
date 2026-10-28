import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type { AgentTeamInboxDelta, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
const cleanups: Array<() => Promise<void>> = []
let counter = 0
const requestId = (label: string) => `test:legacy-main-attention:${label}:${++counter}` as AgentTeamRequestId
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>

async function openTable(): Promise<Table> {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  return await (await ctx.storageDomain.open(agentTeamDomainSpec)).table('operations') as unknown as Table
}

async function seed() {
  const table = await openTable()
  const ledger = new AgentTeamLedger(table, { rulesVersion: 2 })
  await ledger.initialize()
  const projectRef = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'delivery', description: '', memberIds: [] })).value.project.projectRef
  const memberId = `member:owner` as AgentTeamMemberId
  const member = { memberId, sessionId: SessionId('session:owner'), workspaceId: alpha, handle: 'owner', description: '', presetId: 'team-member', privateMemoryPath: '/tmp/owner', state: 'enabled' as const }
  await ledger.addMember({ requestId: requestId('add'), actor: human, member, handle: 'owner', description: '', presetId: 'team-member', workspaceId: alpha, projectRefs: [projectRef] })
  await ledger.addProjectOwner({ requestId: requestId('own'), actor: human, workspaceId: alpha, projectRef, memberId })
  return { table, ledger, projectRef, memberId, actor: { kind: 'member', memberId, handle: 'owner' } as AgentTeamMemberActor }
}

type Seeded = Awaited<ReturnType<typeof seed>>

/** Strip the field a pre-Attention release never wrote, as that release stored it. */
function stripMainAttention(delta: AgentTeamInboxDelta): AgentTeamInboxDelta {
  const { mainAttention: _dropped, ...rest } = delta as AgentTeamInboxDelta & { mainAttention?: unknown }
  return rest
}

async function rewrite(team: Seeded, kind: string, rewriteInbox: (delta: AgentTeamInboxDelta) => AgentTeamInboxDelta): Promise<void> {
  const stored = [...team.table.entries()].map(([, operation]) => operation)
    .filter((operation): operation is Extract<AgentTeamOperation, { readonly data: { readonly inbox: AgentTeamInboxDelta } }> => operation.kind === kind)
  for (const operation of stored) {
    await team.table.delete(operation.operationId)
    const data = { ...operation.data, inbox: rewriteInbox(operation.data.inbox) }
    await team.table.put(operation.operationId, { ...operation, data } as typeof operation)
  }
}

/** Reopen the same table the way a Host restart does, against the rewritten records. */
async function reopen(team: Seeded): Promise<AgentTeamLedger> {
  const ledger = new AgentTeamLedger(team.table, { rulesVersion: 2 })
  await ledger.initialize()
  ledger.validateAtMount()
  return ledger
}

const standingOf = (ledger: AgentTeamLedger, projectRef: Seeded['projectRef'], actor: AgentTeamMemberActor | typeof human) =>
  ledger.mainStreamHistory(actor, { workspaceId: alpha, projectRef }).standing

describe('pre-Main-stream-Attention records', () => {
  it('reopens an owner grant that never carried a Main stream Attention row', async () => {
    const team = await seed()
    await rewrite(team, 'team/project-owner-added', stripMainAttention)
    expect(standingOf(await reopen(team), team.projectRef, team.actor).following).toBe(true)
  })

  it('restores the read progress an owner grant used to overwrite', async () => {
    const team = await seed()
    // A Member that followed and read, then was granted ownership by a build
    // that overwrote the row unconditionally: its watermark was reset to the
    // grant and its unread silently cleared. The correct durable result of that
    // grant is no row at all, so the overwriting row is dropped on replay and
    // the Member's own progress stands.
    const readerId = `member:reader` as AgentTeamMemberId
    await team.ledger.addMember({ requestId: requestId('add-reader'), actor: human,
      member: { memberId: readerId, sessionId: SessionId('session:reader'), workspaceId: alpha, handle: 'reader', description: '', presetId: 'team-member', privateMemoryPath: '/tmp/reader', state: 'enabled' },
      handle: 'reader', description: '', presetId: 'team-member', workspaceId: alpha, projectRefs: [team.projectRef] })
    const reader = { kind: 'member', memberId: readerId, handle: 'reader' } as AgentTeamMemberActor
    await team.ledger.postMainMessage({ requestId: requestId('one'), actor: human, workspaceId: alpha, projectRef: team.projectRef, body: 'one' })
    await team.ledger.changeAttention({ requestId: requestId('follow'), actor: reader, workspaceId: alpha, projectRef: team.projectRef, action: 'follow' })
    await team.ledger.readMainStream({ requestId: requestId('read'), actor: reader, workspaceId: alpha, projectRef: team.projectRef })
    // The overwriting grant, exactly as the old build wrote it.
    await team.ledger.addProjectOwner({ requestId: requestId('own'), actor: human, workspaceId: alpha, projectRef: team.projectRef, memberId: readerId })
    const reopened = await reopen(team)
    // The reader's own watermark stands, so the only unread left is the one the
    // grant itself appended as a marker: its owner-added activity. Without the
    // repair the watermark would sit at the grant and the count would be 2.
    expect(standingOf(reopened, team.projectRef, reader)).toMatchObject({ following: true, unreadCount: 1, directCount: 1 })
    await reopened.readMainStream({ requestId: requestId('read-2'), actor: reader, workspaceId: alpha, projectRef: team.projectRef })
    expect(standingOf(reopened, team.projectRef, reader).unreadCount).toBe(0)
    // A later ordinary update is still ordinary unread, so the watermark the
    // repair restored is the reader's own and not the grant's.
    await reopened.postMainMessage({ requestId: requestId('later'), actor: human, workspaceId: alpha, projectRef: team.projectRef, body: 'later' })
    expect(standingOf(reopened, team.projectRef, reader).unreadCount).toBe(1)
  })

  it('reopens an Agent Main stream read whose watermark was not a row yet', async () => {
    const team = await seed()
    await team.ledger.postMainMessage({ requestId: requestId('post-1'), actor: team.actor, workspaceId: alpha, projectRef: team.projectRef, body: 'first update' })
    await team.ledger.postMainMessage({ requestId: requestId('post-2'), actor: team.actor, workspaceId: alpha, projectRef: team.projectRef, body: 'second update' })
    await team.ledger.readMainStream({ requestId: requestId('read'), actor: team.actor, workspaceId: alpha, projectRef: team.projectRef })
    await rewrite(team, 'team/main-stream-read', stripMainAttention)
    const reopened = await reopen(team)
    // The watermark survived the rewrite, so the read still holds.
    expect(standingOf(reopened, team.projectRef, team.actor).unreadCount).toBe(0)
    // Someone else's post is the only thing that can be ordinary unread here:
    // a Member never sees its own output as unread. It is posted on the
    // reopened ledger, because each instance projects its own writes.
    await reopened.postMainMessage({ requestId: requestId('post-3'), actor: human, workspaceId: alpha, projectRef: team.projectRef, body: 'third update' })
    expect(standingOf(reopened, team.projectRef, team.actor).unreadCount).toBeGreaterThan(0)
  })

  it('leaves a receipt that differs from the era shape to fail validation', async () => {
    const team = await seed()
    await team.ledger.postMainMessage({ requestId: requestId('post'), actor: team.actor, workspaceId: alpha, projectRef: team.projectRef, body: 'an update' })
    await team.ledger.readMainStream({ requestId: requestId('read'), actor: team.actor, workspaceId: alpha, projectRef: team.projectRef })
    // A forged watermark: not the era's shape, so the repair must not launder it.
    await rewrite(team, 'team/main-stream-read', delta => ({
      ...delta,
      mainAttention: { set: [{ memberId: team.memberId, projectRef: team.projectRef, startSequence: 1, readThroughSequence: 999999 }], removed: [] },
    } as AgentTeamInboxDelta))
    await expect(reopen(team)).rejects.toThrow()
  })

  it('leaves an owner grant that already carries a row untouched', async () => {
    const team = await seed()
    expect(standingOf(await reopen(team), team.projectRef, team.actor).following).toBe(true)
  })

  it('leaves a current-format read that consumed only markers alone', async () => {
    const team = await seed()
    // A Member that is not the owner, so its follow is its own: a mention
    // before it followed, then a read. The read consumes the marker and advances
    // no watermark, so this build writes exactly the shape the pre-Attention era
    // wrote. Repairing it anyway would mint a row the current replay expectation
    // refuses, and the ledger would not reopen.
    const readerId = `member:reader` as AgentTeamMemberId
    await team.ledger.addMember({ requestId: requestId('add-reader'), actor: human,
      member: { memberId: readerId, sessionId: SessionId('session:reader'), workspaceId: alpha, handle: 'reader', description: '', presetId: 'team-member', privateMemoryPath: '/tmp/reader', state: 'enabled' },
      handle: 'reader', description: '', presetId: 'team-member', workspaceId: alpha, projectRefs: [team.projectRef] })
    const reader = { kind: 'member', memberId: readerId, handle: 'reader' } as AgentTeamMemberActor
    await team.ledger.postMainMessage({ requestId: requestId('mention'), actor: human, workspaceId: alpha, projectRef: team.projectRef, body: '@reader please look' })
    await team.ledger.changeAttention({ requestId: requestId('follow'), actor: reader, workspaceId: alpha, projectRef: team.projectRef, action: 'follow' })
    const read = await team.ledger.readMainStream({ requestId: requestId('read'), actor: reader, workspaceId: alpha, projectRef: team.projectRef })
    expect(read.committed).toBe(true)
    const reopened = await reopen(team)
    // The marker is consumed and the watermark was never there to advance.
    expect(standingOf(reopened, team.projectRef, reader)).toMatchObject({ following: true, unreadCount: 0, markers: [] })
    // The next ordinary post is ordinary unread, exactly as it was before.
    await reopened.postMainMessage({ requestId: requestId('later'), actor: human, workspaceId: alpha, projectRef: team.projectRef, body: 'later' })
    expect(standingOf(reopened, team.projectRef, reader).unreadCount).toBe(1)
  })
})
