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
})
