import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type { AgentTeamHumanActor, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTask } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
const cleanups: Array<() => Promise<void>> = []
let counter = 0
const requestId = (label: string) => `test:accountability:${label}:${++counter}` as AgentTeamRequestId
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>
async function seed() {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const table = await (await ctx.storageDomain.open(agentTeamDomainSpec)).table('operations') as unknown as Table
  const ledger = new AgentTeamLedger(table, { rulesVersion: 2 })
  await ledger.initialize()
  const projectRef = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'delivery', description: '', memberIds: [] })).value.project.projectRef
  const add = async (name: string) => {
    const memberId = `member:${name}` as AgentTeamMemberId
    const member = { memberId, sessionId: SessionId(`session:${name}`), workspaceId: alpha, handle: name, description: '', presetId: 'team-member', privateMemoryPath: `/tmp/${name}`, state: 'enabled' as const }
    await ledger.addMember({ requestId: requestId(`add-${name}`), actor: human, member, handle: name, description: '', presetId: 'team-member', workspaceId: alpha, projectRefs: [projectRef] })
    await ledger.addProjectOwner({ requestId: requestId(`own-${name}`), actor: human, workspaceId: alpha, projectRef, memberId })
    return { memberId, actor: { kind: 'member', memberId, handle: name } as AgentTeamMemberActor }
  }
  return { pool, table, ledger, projectRef, owner: await add('owner'), reviewer: await add('reviewer') }
}

type Seeded = Awaited<ReturnType<typeof seed>>
async function startTask(team: Seeded, actor: AgentTeamHumanActor | AgentTeamMemberActor = human, accountable?: AgentTeamMemberId) {
  const result = await team.ledger.startThread({ requestId: requestId('task'), actor, workspaceId: alpha, projectRef: team.projectRef,
    kind: 'task', body: 'Ship the change', ...(accountable === undefined ? {} : { accountable }) })
  const value = result.value
  if (value.kind !== 'committed' || value.task === undefined) throw new Error('Task did not commit')
  return { ...value, task: value.task }
}
async function readTask(team: Seeded, task: AgentTeamTask, actor: AgentTeamMemberActor | typeof human) {
  return (await team.ledger.readThread({ requestId: requestId('read'), actor, workspaceId: alpha, taskRef: task.taskRef })).value
}
async function claim(team: Seeded, task: AgentTeamTask, actor: AgentTeamMemberActor, state: 'active' | 'done' | 'released' = 'active') {
  const read = await readTask(team, task, actor)
  const created = await team.ledger.changeClaim({ requestId: requestId('claim'), actor, workspaceId: alpha, taskRef: task.taskRef,
    baseRevision: read.thread.revision, action: 'claim', direction: `work by ${actor.handle}` })
  if (created.value.kind !== 'committed') throw new Error('Claim did not commit')
  if (state === 'active') return created.value
  const readAgain = await readTask(team, created.value.task, actor)
  const changed = await team.ledger.changeClaim({ requestId: requestId(state), actor, workspaceId: alpha, taskRef: task.taskRef,
    baseRevision: readAgain.thread.revision, action: state === 'released' ? 'release' : state, claimRef: created.value.claim.claimRef })
  if (changed.value.kind !== 'committed') throw new Error('Claim close did not commit')
  return changed.value
}

describe('Task accountability in final rules version 2', () => {
  it('separates the accountable, the executor and an independent verifier through accept, reopen and transfer', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor)
    expect(started.task).toMatchObject({ accountable: team.owner.memberId, sourceThreadRefs: [], status: 'todo' })
    expect(team.ledger.threadHistory(human, { workspaceId: alpha, taskRef: started.task.taskRef }).facts
      .map(fact => fact.kind === 'message' ? 'message' : fact.activity.kind))
      .toEqual(['message', 'promote'])
    expect(team.ledger.taskBoard(team.owner.actor, { workspaceId: alpha, mine: true }).open[0])
      .toMatchObject({ relation: 'accountable', needsAcceptance: false, accountableOwner: { memberId: team.owner.memberId, name: 'owner' } })

    await expect(team.ledger.changeTask({ requestId: requestId('early-agent-accept'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'accept', baseRevision: started.thread.revision })).rejects.toThrow(/only an in_review/)
    const done = await claim(team, started.task, team.owner.actor, 'done')
    expect(done.task.status).toBe('in_review')
    await expect(team.ledger.changeTask({ requestId: requestId('self-accept'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: done.task.taskRef, action: 'accept', baseRevision: done.thread.revision })).rejects.toThrow(/self_acceptance_forbidden/)
    expect(team.ledger.inbox(human, { workspaceId: alpha }).items[0]).toMatchObject({ directCount: 1 })

    const humanRead = await readTask(team, done.task, human)
    const accepted = await team.ledger.changeTask({ requestId: requestId('human-accept'), actor: human, workspaceId: alpha,
      taskRef: done.task.taskRef, action: 'accept', baseRevision: humanRead.thread.revision })
    expect(accepted.value.kind === 'committed' && accepted.value.task.status).toBe('done')
    const humanReopenRead = await readTask(team, done.task, human)
    const ownerReopenAttempt = await team.ledger.changeTask({ requestId: requestId('owner-reopen'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: done.task.taskRef, action: 'reopen', baseRevision: humanReopenRead.thread.revision })
    expect(ownerReopenAttempt.value.kind).toBe('unread_required')
    const ownerRead = await readTask(team, done.task, team.owner.actor)
    const reopened = await team.ledger.changeTask({ requestId: requestId('owner-reopen-2'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: done.task.taskRef, action: 'reopen', baseRevision: ownerRead.thread.revision })
    if (reopened.value.kind !== 'committed') throw new Error('reopen did not commit')

    const ownerTransferRead = await readTask(team, reopened.value.task, team.owner.actor)
    const transferId = requestId('transfer')
    const transferred = await team.ledger.transferTask({ requestId: transferId, actor: team.owner.actor, workspaceId: alpha,
      taskRef: reopened.value.task.taskRef, target: team.reviewer.memberId, baseRevision: ownerTransferRead.thread.revision })
    if (transferred.value.kind !== 'committed') throw new Error('transfer did not commit')
    expect(transferred.value.task.accountable).toBe(team.reviewer.memberId)
    expect(team.ledger.attentionStatus(team.reviewer.actor, { workspaceId: alpha, taskRef: reopened.value.task.taskRef }).attention).toBeDefined()
    expect(team.ledger.memberInbox(team.reviewer.actor, {}).items[0]).toMatchObject({ directCount: 1 })
    const retry = await team.ledger.transferTask({ requestId: transferId, actor: team.owner.actor, workspaceId: alpha,
      taskRef: reopened.value.task.taskRef, target: team.reviewer.memberId, baseRevision: ownerTransferRead.thread.revision })
    expect(retry.committed).toBe(false)
    expect(retry.value).toMatchObject({ task: { accountable: team.reviewer.memberId } })
    new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()
    const cold = new AgentTeamLedger(team.table, { rulesVersion: 2 })
    expect(() => cold.validate()).not.toThrow()
    expect(cold.taskBoard(team.reviewer.actor, { workspaceId: alpha, mine: true }).open[0]?.task.accountable).toBe(team.reviewer.memberId)
  })

  it('notifies only the eligible verifier and returns open Tasks atomically when an owner leaves', async () => {
    const team = await seed()
    const started = await startTask(team, human, team.owner.memberId)
    await claim(team, started.task, team.owner.actor, 'released')
    const second = await startTask(team, team.owner.actor)
    await team.ledger.removeProjectOwner({ requestId: requestId('remove-owner'), actor: human, workspaceId: alpha,
      projectRef: team.projectRef, memberId: team.owner.memberId })
    for (const taskRef of [started.task.taskRef, second.task.taskRef]) expect(team.ledger.getTask(taskRef)?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    const facts = team.ledger.threadHistory(human, { workspaceId: alpha, taskRef: second.task.taskRef }).facts
    expect(facts.at(-1)).toMatchObject({ kind: 'activity', activity: { kind: 'transfer', from: team.owner.memberId, to: AGENT_TEAM_HUMAN_MEMBER_ID } })
    new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()
  })

  it('bars a released executor from accepting, gates close on the accountable, and refuses invalid transfer targets', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor)
    // The owner claims, hands the work off, and takes it back done by another executor:
    // holding a Claim EVER — released included — bars acceptance for good.
    await claim(team, started.task, team.owner.actor, 'released')
    const done = await claim(team, started.task, team.reviewer.actor, 'done')
    expect(done.task.status).toBe('in_review')
    await expect(team.ledger.changeTask({ requestId: requestId('released-accept'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'accept', baseRevision: done.thread.revision })).rejects.toThrow(/self_acceptance_forbidden/)
    // Close belongs to the Human or the current accountable: a fellow owner is neither.
    await expect(team.ledger.changeTask({ requestId: requestId('stray-close'), actor: team.reviewer.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'close', baseRevision: done.thread.revision })).rejects.toThrow(/accountable_owner_required/)
    const ownerRead = await readTask(team, done.task, team.owner.actor)
    const closed = await team.ledger.changeTask({ requestId: requestId('owner-close'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'close', baseRevision: ownerRead.thread.revision })
    expect(closed.value.kind === 'committed' && closed.value.task.resolution).toBe('closed')
    // A transfer target must be a current Project owner or the Human.
    await team.ledger.addMember({ requestId: requestId('add-outsider'), actor: human, workspaceId: alpha,
      member: { memberId: 'member:outsider' as AgentTeamMemberId, sessionId: SessionId('session:outsider'), workspaceId: alpha,
        handle: 'outsider', description: '', presetId: 'team-member', privateMemoryPath: '/tmp/outsider', state: 'enabled' },
      handle: 'outsider', description: '', presetId: 'team-member', projectRefs: [team.projectRef] })
    const humanRead = await readTask(team, closed.value.kind === 'committed' ? closed.value.task : started.task, human)
    await expect(team.ledger.transferTask({ requestId: requestId('bad-target'), actor: human, workspaceId: alpha,
      taskRef: started.task.taskRef, target: 'member:outsider' as AgentTeamMemberId, baseRevision: humanRead.thread.revision })).rejects.toThrow(/accountable_target_invalid/)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()
  })

  it('keeps accountability through suspension, returns Tasks from every owner when a Project archives, and mends an invalid accountable before reopen', async () => {
    const team = await seed()
    const suspendedTask = await startTask(team, team.owner.actor)
    await team.ledger.suspendMember({ requestId: requestId('suspend'), actor: human, memberId: team.owner.memberId })
    expect(team.ledger.getTask(suspendedTask.task.taskRef)?.accountable).toBe(team.owner.memberId)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()

    const reviewerTask = await startTask(team, human, team.reviewer.memberId)
    await team.ledger.archiveProject({ requestId: requestId('archive'), actor: human, workspaceId: alpha, projectRef: team.projectRef })
    expect(team.ledger.getTask(suspendedTask.task.taskRef)?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(team.ledger.getTask(reviewerTask.task.taskRef)?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()

    // A finished Task keeps its accountable through owner removal; reopen then
    // refuses until the Human mends the responsibility by transferring it.
    const second = await seed()
    const finished = await startTask(second, second.owner.actor)
    const done = await claim(second, finished.task, second.owner.actor, 'done')
    const readForAccept = await readTask(second, done.task, human)
    await second.ledger.changeTask({ requestId: requestId('accept'), actor: human, workspaceId: alpha,
      taskRef: finished.task.taskRef, action: 'accept', baseRevision: readForAccept.thread.revision })
    await second.ledger.removeProjectOwner({ requestId: requestId('remove'), actor: human, workspaceId: alpha,
      projectRef: second.projectRef, memberId: second.owner.memberId })
    expect(second.ledger.getTask(finished.task.taskRef)?.accountable).toBe(second.owner.memberId)
    const blockedRead = await readTask(second, second.ledger.getTask(finished.task.taskRef)!, human)
    await expect(second.ledger.changeTask({ requestId: requestId('blocked-reopen'), actor: human, workspaceId: alpha,
      taskRef: finished.task.taskRef, action: 'reopen', baseRevision: blockedRead.thread.revision })).rejects.toThrow(/accountable_target_invalid/)
    await second.ledger.transferTask({ requestId: requestId('mend'), actor: human, workspaceId: alpha,
      taskRef: finished.task.taskRef, target: second.reviewer.memberId, baseRevision: blockedRead.thread.revision })
    const mended = await readTask(second, second.ledger.getTask(finished.task.taskRef)!, second.reviewer.actor)
    const reopened = await second.ledger.changeTask({ requestId: requestId('reopen'), actor: second.reviewer.actor, workspaceId: alpha,
      taskRef: finished.task.taskRef, action: 'reopen', baseRevision: mended.thread.revision })
    expect(reopened.value.kind === 'committed' && reopened.value.task.resolution).toBe('open')
    expect(() => new AgentTeamLedger(second.table, { rulesVersion: 2 }).validate()).not.toThrow()
  })

  it('places a sourced Task card in its discussion without making it unread or revising that discussion', async () => {
    const team = await seed()
    const discussion = await team.ledger.startThread({ requestId: requestId('discussion'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, kind: 'discussion', body: 'Discuss the approach' })
    if (discussion.value.kind !== 'committed') throw new Error('discussion did not commit')
    const sourceRef = discussion.value.thread.threadRef
    const revision = discussion.value.thread.revision
    const task = await team.ledger.startThread({ requestId: requestId('sourced-task'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, kind: 'task', body: 'Implement it', sourceThreadRefs: [sourceRef] })
    if (task.value.kind !== 'committed' || task.value.task === undefined) throw new Error('Task did not commit')
    const committedTask = { ...task.value, task: task.value.task }
    const discussionHistory = team.ledger.threadHistory(team.owner.actor, { workspaceId: alpha, threadRef: sourceRef })
    expect(discussionHistory.thread.revision).toBe(revision)
    expect(discussionHistory.taskCards).toEqual([expect.objectContaining({ taskRef: committedTask.task.taskRef, taskNumber: 1,
      threadRef: committedTask.thread.threadRef, sequence: committedTask.message.sequence, subject: 'Implement it',
      status: 'todo', accountable: team.owner.memberId })])
    expect(team.ledger.mainStreamHistory(team.owner.actor, { workspaceId: alpha, projectRef: team.projectRef }).entries
      .some(entry => entry.kind === 'thread-card' && entry.card.threadRef === task.value.thread.threadRef)).toBe(false)
    await expect(team.ledger.startThread({ requestId: requestId('invalid-source'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, kind: 'task', body: 'Invalid source', sourceThreadRefs: [committedTask.thread.threadRef] })).rejects.toThrow(/must be a discussion/)
  })

  it('refuses source Threads from another Project', async () => {
    const team = await seed()
    const otherRef = (await team.ledger.createProject({ requestId: requestId('other'), actor: human, workspaceId: alpha,
      name: 'elsewhere', description: '', memberIds: [] })).value.project.projectRef
    const foreign = await team.ledger.startThread({ requestId: requestId('foreign'), actor: human, workspaceId: alpha,
      projectRef: otherRef, kind: 'discussion', body: 'Another Project discussion' })
    if (foreign.value.kind !== 'committed') throw new Error('discussion did not commit')
    await expect(team.ledger.startThread({ requestId: requestId('cross-source'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, kind: 'task', body: 'Cross-source', sourceThreadRefs: [foreign.value.thread.threadRef] })).rejects.toThrow(/must be a discussion/)
  })
})
