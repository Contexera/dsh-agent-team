import { afterEach, describe, expect, it, vi } from 'vitest'
// Every test here boots a Host over a throwaway tree, and the windows lane has
// stretched one cold replay to 2.7s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21). The SQLite case below keeps its own 30s argument.
vi.setConfig({ testTimeout: 30_000 })
import { AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_INITIALIZE_REQUEST_ID } from '../src/index.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { addLedgerMember, alpha, committed, harness, ledgerAtBoot, makeOwner, requestId, storedPool, withTask } from './helpers/host-harness.ts'
import { AgentTeamLedger } from '../src/ledger.ts'
import type { AgentTeamMemberActor } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})


describe('AgentTeam Human Task transfer Remote', () => {
  /** One Task with a second Project owner to hand it to. */
  async function seedTransfer() {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('transfer-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const added = await test.ctx.agentTeam.addMember({ requestId: requestId('transfer-member'), workspaceId: alpha,
      handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    await test.ctx.agentTeam.addProjectOwner({ requestId: requestId('transfer-owner'), workspaceId: alpha,
      projectRef: project.project.projectRef, memberId: added.status.member.memberId })
    const actor = { kind: 'member' as const, memberId: added.status.member.memberId, handle: added.status.member.handle }
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('transfer-start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Hand this over' })))
    return { test, project, actor, started }
  }

  it('hands an open Task to another Project owner through the Human Remote and replays the same operation', async () => {
    const { test, actor, started } = await seedTransfer()
    expect(started.task.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    const transferred = await test.ctx.agentTeam.transferTask({ requestId: requestId('transfer'), workspaceId: alpha,
      taskRef: started.task.taskRef, target: actor.memberId, baseRevision: started.thread.revision })
    if (transferred.kind !== 'committed') throw new Error(`transfer did not commit, received ${transferred.kind}`)
    expect(transferred.task.accountable).toBe(actor.memberId)
    expect(transferred.activity).toMatchObject({ kind: 'transfer', from: AGENT_TEAM_HUMAN_MEMBER_ID, to: actor.memberId })
    // The new accountable is followed and notified exactly as an Agent-initiated transfer would leave them.
    const ledger = ledgerAtBoot(test)
    expect(ledger.attentionStatus(actor, { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toBeDefined()
    expect(ledger.memberInbox(actor, {}).items[0]).toMatchObject({ directCount: 1 })
    expect(ledger.getTask(started.task.taskRef)?.accountable).toBe(actor.memberId)
    expect(() => ledgerAtBoot(test).validate()).not.toThrow()
  })

  it('replays a repeated requestId from the idempotency cache instead of transferring twice', async () => {
    const { test, actor, started } = await seedTransfer()
    const request = { requestId: requestId('transfer-replay'), workspaceId: alpha, taskRef: started.task.taskRef, target: actor.memberId, baseRevision: started.thread.revision }
    const first = await test.ctx.agentTeam.transferTask(request)
    if (first.kind !== 'committed') throw new Error(`first transfer did not commit, received ${first.kind}`)
    const second = await test.ctx.agentTeam.transferTask(request)
    // A retry after a lost answer is answered from the cache: same accountable, no second operation.
    if (second.kind !== 'committed') throw new Error(`retry did not commit, received ${second.kind}`)
    expect(second.task.accountable).toBe(actor.memberId)
    expect(second.receipt).toEqual(first.receipt)
    expect(() => ledgerAtBoot(test).validate()).not.toThrow()
  })

  it('refuses a target that is not a current Project owner, and reports a stale revision as a business outcome', async () => {
    const { test, actor: seedOwner, started } = await seedTransfer()
    const outsider = await test.ctx.agentTeam.addMember({ requestId: requestId('outsider'), workspaceId: alpha,
      handle: 'outsider', description: 'Not an owner', presetId: 'team-member', projectRefs: [] })
    await expect(test.ctx.agentTeam.transferTask({ requestId: requestId('bad-target'), workspaceId: alpha,
      taskRef: started.task.taskRef, target: outsider.status.member.memberId, baseRevision: started.thread.revision })).rejects.toThrow(/accountable_target_invalid/)
    // The stale case is the normal control flow the Client already models: it comes back as a result, not a Remote error. A legal target keeps the illegal one from masking it.
    const stale = await test.ctx.agentTeam.transferTask({ requestId: requestId('stale'), workspaceId: alpha,
      taskRef: started.task.taskRef, target: seedOwner.memberId, baseRevision: started.thread.revision + 99 })
    expect(stale.kind).toBe('stale_revision')
    expect(stale.kind === 'stale_revision' && stale.revision).toBe(started.thread.revision)
    // Neither refusal moved the Task: the accountable is still the Human's.
    expect(ledgerAtBoot(test).getTask(started.task.taskRef)?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
  })

  it('fences a transfer behind the unread gate and answers it once the Human has read', async () => {
    const { test, actor, started } = await seedTransfer()
    // The Member's reply lands while the Human still follows the Thread, so ordinary unread stands between the Human and the next write.
    // It is written through the Host's own ledger, because a boot snapshot would replay from the table and never reach the running service instance.
    const serviceLedger = (test.ctx.agentTeam as unknown as { ledger: AgentTeamLedger }).ledger
    const reply = committed((await serviceLedger.reply({ requestId: requestId('unread-reply'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'A reply the Human has not read', baseRevision: started.thread.revision, actor })).value)
    expect(serviceLedger.inbox(agentTeamHumanActor(), { workspaceId: alpha }).totalUnreadCount).toBe(1)
    // The gate refuses on the revision the reply produced, and the retry after the Human's read commits with the target accountable.
    const request = { requestId: requestId('gated'), workspaceId: alpha, taskRef: started.task.taskRef, target: actor.memberId, baseRevision: started.thread.revision }
    const blocked = await test.ctx.agentTeam.transferTask(request)
    expect(blocked.kind).toBe('unread_required')
    expect(blocked.kind === 'unread_required' && blocked.revision).toBe(reply.thread.revision)
    const read = await test.ctx.agentTeam.readThread({ requestId: requestId('human-read'), workspaceId: alpha, taskRef: started.task.taskRef })
    const transferred = await test.ctx.agentTeam.transferTask({ ...request, baseRevision: read.thread.revision })
    if (transferred.kind !== 'committed') throw new Error(`transfer after read did not commit, received ${transferred.kind}`)
    expect(transferred.task.accountable).toBe(actor.memberId)
  })

  it('mends a finished Task whose accountable is no longer a Project owner', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('finish-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const added = await test.ctx.agentTeam.addMember({ requestId: requestId('finish-member'), workspaceId: alpha,
      handle: 'builder', description: 'Builds changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    await test.ctx.agentTeam.addProjectOwner({ requestId: requestId('finish-owner'), workspaceId: alpha,
      projectRef: project.project.projectRef, memberId: added.status.member.memberId })
    // The Task is accountable to the second owner, who then finishes it: the grant that made them accountable ends afterwards.
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('finish-start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Finish then mend', accountable: added.status.member.memberId })))
    expect(started.task.accountable).toBe(added.status.member.memberId)
    await test.ctx.agentTeam.changeTask({ requestId: requestId('accept'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'accept', baseRevision: started.thread.revision })
    await test.ctx.agentTeam.removeProjectOwner({ requestId: requestId('remove-owner'), workspaceId: alpha,
      projectRef: project.project.projectRef, memberId: added.status.member.memberId })
    // The finished Task keeps its accountable across the grant ending, so the removed owner stays named until the Human mends it.
    expect(ledgerAtBoot(test).getTask(started.task.taskRef)?.accountable).toBe(added.status.member.memberId)
    const read = await test.ctx.agentTeam.readThread({ requestId: requestId('mend-read'), workspaceId: alpha, taskRef: started.task.taskRef })
    // The Human repair is a transfer back to the Human, which reopen then follows.
    const mended = await test.ctx.agentTeam.transferTask({ requestId: requestId('mend'), workspaceId: alpha,
      taskRef: started.task.taskRef, target: AGENT_TEAM_HUMAN_MEMBER_ID, baseRevision: read.thread.revision })
    if (mended.kind !== 'committed') throw new Error(`mend did not commit, received ${mended.kind}`)
    expect(mended.task.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(mended.activity).toMatchObject({ kind: 'transfer', from: added.status.member.memberId, to: AGENT_TEAM_HUMAN_MEMBER_ID })
    // The mend transferred the Task into the Human's Inbox, so the Human reads before reopening it — which then lands open again.
    const reopenRead = await test.ctx.agentTeam.readThread({ requestId: requestId('reopen-read'), workspaceId: alpha, taskRef: started.task.taskRef })
    const reopened = await test.ctx.agentTeam.changeTask({ requestId: requestId('reopen'), workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'reopen', baseRevision: reopenRead.thread.revision })
    expect(reopened.kind).toBe('committed')
    expect(reopened.kind === 'committed' && reopened.task.resolution).toBe('open')
    expect(() => ledgerAtBoot(test).validate()).not.toThrow()
  })
})
