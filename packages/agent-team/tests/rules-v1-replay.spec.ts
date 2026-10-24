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
import type { AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamProjectRef, AgentTeamRequestId, AgentTeamThreadRef } from '../src/types.ts'
import { rulesV1Ledger } from './fixtures/rules-v1-ledger.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
const cleanups: Array<() => Promise<void>> = []
const projectRef = rulesV1Ledger.projectRef as AgentTeamProjectRef
const threadRef = (value: string) => value as AgentTeamThreadRef
let counter = 0
const requestId = (label: string) => `replay:${label}:${++counter}` as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>

async function openTable(pool: MemoryMediaPool): Promise<Table> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  return domain.table('operations') as unknown as Table
}

function frozenPool(): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('agent_team', agentTeamDomainSpec.version)
  pool.media.set('agent_team', { tables: new Map([['operations', new Map(structuredClone(rulesV1Ledger.records))]]), global: null })
  return pool
}

const storedKinds = (pool: MemoryMediaPool) => [...pool.media.get('agent_team')!.tables.get('operations')!.values()]
  .map(record => record as AgentTeamOperation).sort((left, right) => left.sequence - right.sequence).map(operation => operation.kind)

const memberActor = (handle: keyof typeof rulesV1Ledger.members): AgentTeamMemberActor =>
  ({ kind: 'member', memberId: rulesV1Ledger.members[handle] as AgentTeamMemberId, handle })

/** A version 1 ledger over the frozen history, then a version 2 build over the same records. */
async function openBoth() {
  const pool = frozenPool()
  const table = await openTable(pool)
  const v1 = new AgentTeamLedger(table, { rulesVersion: 1 })
  await v1.initialize()
  const adopt = async () => {
    const v2 = new AgentTeamLedger(table)
    await v2.initialize()
    return v2
  }
  return { pool, v1, adopt }
}

/** Everything a reader sees of one Member that the rules version could change. */
function standing(ledger: AgentTeamLedger, handle: keyof typeof rulesV1Ledger.members, refs: readonly string[]) {
  const actor = memberActor(handle)
  return {
    inbox: ledger.inbox(actor, { workspaceId: alpha }),
    attention: refs.map(ref => ledger.attentionStatus(actor, { workspaceId: alpha, threadRef: threadRef(ref) }).attention),
    projects: ledger.view({ workspaceId: alpha }, actor.memberId).projects.map(project => project.projectRef),
  }
}

const handles = ['alice', 'bob', 'carol', 'dave'] as const
const threadRefs = [rulesV1Ledger.task.threadRef, rulesV1Ledger.discussion.threadRef, rulesV1Ledger.standup.threadRef, rulesV1Ledger.outsider.threadRef]

describe('replaying a rules version 1 ledger', () => {
  it('adopts version 2 after the old records and keeps what each Member was following and saw', async () => {
    const { pool, v1, adopt } = await openBoth()
    const bystander: AgentTeamAgentMember = { memberId: 'member:bystander' as AgentTeamMemberId, sessionId: SessionId('session:bystander'), workspaceId: alpha,
      handle: 'bystander', description: 'Test Agent', presetId: 'team-member', privateMemoryPath: '/tmp/bystander', state: 'enabled' }
    await v1.addMember({ requestId: requestId('bystander'), actor: human, member: bystander, handle: 'bystander', description: 'Test Agent', presetId: 'team-member', workspaceId: alpha, projectRefs: [] })
    const before = Object.fromEntries(handles.map(handle => [handle, standing(v1, handle, threadRefs)]))

    const v2 = await adopt()
    expect(storedKinds(pool).slice(-2)).toEqual(['team/member-added', 'team/rules-version-adopted'])
    expect(v2.status().rulesVersion).toBe(2)
    expect(() => v2.validate()).not.toThrow()
    for (const handle of handles) expect(standing(v2, handle, threadRefs), `${handle} after adoption`).toEqual(before[handle])

    // The old rules' outcomes stand: authors and explicit recipients follow, `@all` was expanded to the Project roster when written,
    // and a mention of a Workspace participant outside the Project reached them.
    const following = (handle: keyof typeof rulesV1Ledger.members) => standing(v2, handle, threadRefs).attention.map(attention => attention !== undefined)
    expect(following('alice')).toEqual([false, true, true, false])
    expect(following('bob')).toEqual([false, true, true, false])
    expect(following('carol')).toEqual([false, false, true, false])
    expect(following('dave')).toEqual([false, false, false, true])
    expect(standing(v2, 'dave', threadRefs).projects).toEqual([projectRef])
    expect(v2.view({ workspaceId: alpha }, bystander.memberId).projects).toEqual([])
  })

  it('replays an invitation and an undelivered mention written under version 1', async () => {
    const { pool, v1, adopt } = await openBoth()
    const task = rulesV1Ledger.task
    const held = (await v1.reply({ requestId: requestId('invite'), workspaceId: alpha, taskRef: task.taskRef as never, body: '@carol, please look',
      baseRevision: task.revision, actor: human })).value
    if (held.kind !== 'confirmation_required') throw new Error(`expected confirmation, received ${held.kind}`)
    const invited = (await v1.reply({ requestId: requestId('invite-confirmed'), workspaceId: alpha, taskRef: task.taskRef as never, body: '@carol, please look',
      baseRevision: task.revision, actor: human, confirmationToken: held.confirmationToken })).value
    if (invited.kind !== 'committed') throw new Error(`expected committed invitation, received ${invited.kind}`)
    expect(invited.attention).toEqual([expect.objectContaining({ memberId: rulesV1Ledger.members.carol, startSequence: invited.message.sequence })])

    const unheard = (await v1.reply({ requestId: requestId('undelivered'), workspaceId: alpha, taskRef: task.taskRef as never, body: '@dave, over to you',
      baseRevision: invited.thread.revision, actor: memberActor('alice') })).value
    if (unheard.kind !== 'committed') throw new Error(`expected committed reply, received ${unheard.kind}`)
    expect(unheard.undeliveredMentions).toEqual([rulesV1Ledger.members.dave])

    const before = Object.fromEntries(handles.map(handle => [handle, standing(v1, handle, threadRefs)]))
    const history = (ledger: AgentTeamLedger) => ledger.threadHistory(human, { workspaceId: alpha, threadRef: threadRef(task.threadRef) }).facts
      .map(fact => fact.kind === 'message' ? fact.message.body : fact.activity.kind)

    const v2 = await adopt()
    expect(storedKinds(pool).filter(kind => kind === 'team/thread-replied')).toHaveLength(2)
    expect(() => v2.validate()).not.toThrow()
    expect(history(v2)).toEqual(['Investigate the regression', '@carol, please look', '@dave, over to you'])
    for (const handle of handles) expect(standing(v2, handle, threadRefs), `${handle} after adoption`).toEqual(before[handle])
    expect(standing(v2, 'dave', threadRefs).attention[0]).toBeUndefined()
  })

  it('replays a Human promotion of a taskless Thread written under version 1', async () => {
    const { pool, v1, adopt } = await openBoth()
    const promoted = (await v1.promoteThread({ requestId: requestId('promote'), workspaceId: alpha, threadRef: threadRef(rulesV1Ledger.discussion.threadRef),
      baseRevision: rulesV1Ledger.discussion.revision, actor: human })).value
    if (promoted.kind !== 'committed') throw new Error(`expected committed promotion, received ${promoted.kind}`)
    await expect(v1.promoteThread({ requestId: requestId('promote-again'), workspaceId: alpha, threadRef: threadRef(rulesV1Ledger.standup.threadRef),
      baseRevision: rulesV1Ledger.standup.revision, actor: memberActor('alice') })).rejects.toThrow()

    const v2 = await adopt()
    expect(storedKinds(pool).filter(kind => kind === 'team/thread-promoted')).toHaveLength(1)
    expect(() => v2.validate()).not.toThrow()
    const history = v2.threadHistory(human, { workspaceId: alpha, threadRef: threadRef(rulesV1Ledger.discussion.threadRef) })
    expect(history.task?.taskRef).toBe(promoted.task.taskRef)
    expect(history.facts.map(fact => fact.kind === 'message' ? fact.message.body : fact.activity.kind)).toEqual(['Notes from alice', 'promote'])
  })
})
