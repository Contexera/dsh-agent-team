import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_RULES_VERSION, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { ScriptedAdapter, realHarness, requestId as harnessRequestId, textResponse } from './helpers/member-harness.ts'
import type { AgentTeamAgentMember, AgentTeamHumanActor, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamProjectRef, AgentTeamRequestId, AgentTeamTask } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
const cleanups: Array<() => Promise<void>> = []
let counter = 0
const requestId = (label: string) => `test:transfer-v3:${label}:${++counter}` as AgentTeamRequestId
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>

/**
 * A ledger at the rules version under test, plus the one helper each case needs: a Member enrolled with
 * or without a Project membership and with or without an owner grant.
 */
async function seed(options?: { rulesVersion?: number }) {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const table = await (await ctx.storageDomain.open(agentTeamDomainSpec)).table('operations') as unknown as Table
  let ledger = new AgentTeamLedger(table, { rulesVersion: options?.rulesVersion ?? AGENT_TEAM_RULES_VERSION })
  await ledger.initialize()
  const projectRef = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'delivery', description: '', memberIds: [] })).value.project.projectRef
  const add = async (name: string, options2: { owner?: boolean; projectRefs?: readonly AgentTeamProjectRef[] } = {}) => {
    const memberId = `member:${name}` as AgentTeamMemberId
    const member: AgentTeamAgentMember = { memberId, sessionId: SessionId(`session:${name}`), workspaceId: alpha, handle: name,
      description: '', presetId: 'team-member', privateMemoryPath: `/tmp/${name}`, state: 'enabled' }
    await ledger.addMember({ requestId: requestId(`add-${name}`), actor: human, member, handle: name, description: '', presetId: 'team-member',
      workspaceId: alpha, projectRefs: [...(options2.projectRefs ?? [projectRef])] })
    if (options2.owner === true) {
      await ledger.addProjectOwner({ requestId: requestId(`own-${name}`), actor: human, workspaceId: alpha, projectRef, memberId })
    }
    return { memberId, actor: { kind: 'member', memberId, handle: name } as AgentTeamMemberActor }
  }
  // A build that implements version 3 opens a version-2 ledger and adopts version 3 in place; from here on
  // both reads and writes go through that instance, exactly as the Host's own ledger would.
  const reopen = async (): Promise<void> => {
    ledger = new AgentTeamLedger(table)
    await ledger.initialize()
  }
  return { pool, table, projectRef, add, reopen, get ledger() { return ledger } }
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
async function handOver(team: Seeded, task: AgentTeamTask, actor: AgentTeamMemberActor | typeof human, target: AgentTeamMemberId) {
  const read = await readTask(team, task, actor)
  return (await team.ledger.transferTask({ requestId: requestId('transfer'), actor, workspaceId: alpha,
    taskRef: task.taskRef, target, baseRevision: read.thread.revision })).value
}

describe('Task responsibility under rules version 3', () => {
  it('hands a Task to a plain Project member, follows it there, and replays the move from cold', async () => {
    const team = await seed()
    expect(team.ledger.status().rulesVersion).toBe(AGENT_TEAM_RULES_VERSION)
    const reviewer = await team.add('reviewer')
    const executor = await team.add('executor')
    const started = await startTask(team, human)
    const working = await claim(team, started.task, executor.actor)
    const moved = await handOver(team, started.task, human, reviewer.memberId)
    if (moved.kind !== 'committed') throw new Error(`transfer did not commit, received ${moved.kind}`)
    expect(moved.task.accountable).toBe(reviewer.memberId)
    // Responsibility moved; the work did not: the executor still owns the one Claim on the Task.
    expect(team.ledger.getClaim(working.claim.claimRef)).toMatchObject({ owner: executor.memberId, state: 'active' })
    expect(team.ledger.getTask(started.task.taskRef)?.accountable).toBe(reviewer.memberId)
    // The new accountable takes part in the conversation from here, and the Host woke it directly.
    expect(team.ledger.attentionStatus(reviewer.actor, { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toBeDefined()
    expect(team.ledger.memberInbox(reviewer.actor, {}).items[0]).toMatchObject({ directCount: 1 })
    expect(() => new AgentTeamLedger(team.table).validate()).not.toThrow()
  })

  it('refuses a transfer target that takes no part in the Project or is no longer enabled', async () => {
    const team = await seed()
    const outsider = await team.add('outsider', { projectRefs: [] })
    const retired = await team.add('retired')
    await team.ledger.archiveMember({ requestId: requestId('archive-retired'), actor: human, memberId: retired.memberId })
    const started = await startTask(team, human)
    await expect(handOver(team, started.task, human, outsider.memberId)).rejects.toThrow(/accountable_target_invalid/)
    await expect(handOver(team, started.task, human, retired.memberId)).rejects.toThrow(/accountable_target_invalid/)
    // Neither refusal moved the Task.
    expect(team.ledger.getTask(started.task.taskRef)?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
  })

  it('lets the transferred accountable verify the Task, and still bars it once it ever held a Claim', async () => {
    const team = await seed()
    const reviewer = await team.add('reviewer')
    const executor = await team.add('executor')
    const started = await startTask(team, human)
    const finished = await claim(team, started.task, executor.actor, 'done')
    expect(finished.task.status).toBe('in_review')
    const moved = await handOver(team, started.task, human, reviewer.memberId)
    if (moved.kind !== 'committed') throw new Error('transfer did not commit')
    // The board tells the new accountable that the review is now its own.
    expect(team.ledger.taskBoard(reviewer.actor, { workspaceId: alpha }).open[0])
      .toMatchObject({ relation: 'accountable', needsAcceptance: true })
    const read = await readTask(team, moved.task, reviewer.actor)
    const accepted = await team.ledger.changeTask({ requestId: requestId('accept'), actor: reviewer.actor, workspaceId: alpha,
      taskRef: moved.task.taskRef, action: 'accept', baseRevision: read.thread.revision })
    expect(accepted.value.kind === 'committed' && accepted.value.task.status).toBe('done')
    expect(() => new AgentTeamLedger(team.table).validate()).not.toThrow()

    // The same shape, one Claim later: a reviewer that worked on the Task cannot verify it.
    const second = await startTask(team, human)
    const worked = await claim(team, second.task, reviewer.actor, 'released')
    void worked
    const secondFinished = await claim(team, second.task, executor.actor, 'done')
    const secondMoved = await handOver(team, second.task, human, reviewer.memberId)
    if (secondMoved.kind !== 'committed') throw new Error('second transfer did not commit')
    expect(secondFinished.task.status).toBe('in_review')
    const secondRead = await readTask(team, secondMoved.task, reviewer.actor)
    await expect(team.ledger.changeTask({ requestId: requestId('accept-after-claim'), actor: reviewer.actor, workspaceId: alpha,
      taskRef: secondMoved.task.taskRef, action: 'accept', baseRevision: secondRead.thread.revision })).rejects.toThrow(/self_acceptance_forbidden/)
  })

  it('keeps acceptance away from a Project member who is neither an owner nor the accountable', async () => {
    const team = await seed()
    const reviewer = await team.add('reviewer')
    const bystander = await team.add('bystander')
    const executor = await team.add('executor')
    const started = await startTask(team, human)
    await claim(team, started.task, executor.actor, 'done')
    const moved = await handOver(team, started.task, human, reviewer.memberId)
    if (moved.kind !== 'committed') throw new Error('transfer did not commit')
    const read = await readTask(team, moved.task, bystander.actor)
    await expect(team.ledger.changeTask({ requestId: requestId('stray-accept'), actor: bystander.actor, workspaceId: alpha,
      taskRef: moved.task.taskRef, action: 'accept', baseRevision: read.thread.revision })).rejects.toThrow(/project_owner_required/)
  })

  it('keeps a Task with a former owner who still takes part, where version 2 took it back', async () => {
    const team = await seed()
    const member = await team.add('member', { owner: true })
    const heir = await team.add('heir')
    const kept = await startTask(team, human, member.memberId)
    await team.ledger.removeProjectOwner({ requestId: requestId('drop-grant'), actor: human, workspaceId: alpha, projectRef: team.projectRef, memberId: member.memberId })
    // Being made accountable named and followed this Member, so the Project participation outlives the
    // grant: the Task stays where it is, and the former owner still drives it to acceptance.
    expect(team.ledger.getTask(kept.task.taskRef)?.accountable).toBe(member.memberId)
    expect(team.ledger.taskBoard(member.actor, { workspaceId: alpha }).open[0]).toMatchObject({ relation: 'accountable' })
    // Handing it on is still the accountable's move once the grant is gone, and the heir can then close it.
    const moved = await handOver(team, kept.task, member.actor, heir.memberId)
    expect(moved.kind === 'committed' && moved.task.accountable).toBe(heir.memberId)
    const heirRead = await readTask(team, kept.task, heir.actor)
    const closed = await team.ledger.changeTask({ requestId: requestId('close-kept'), actor: heir.actor, workspaceId: alpha,
      taskRef: kept.task.taskRef, action: 'close', baseRevision: heirRead.thread.revision })
    expect(closed.value.kind).toBe('committed')
    expect(() => new AgentTeamLedger(team.table).validate()).not.toThrow()
  })

  it('keeps a former owner its Task while the removal leaves it in the Project, and returns it once participation ends', async () => {
    const team = await seed()
    // The Member joins the Workspace only, so the owner grant is its one tie to the Project until the Task
    // names it. Version 2 answered this removal with a sweep over owner grants and put the Task back on the
    // Human; version 3 asks what participation the Member has left instead.
    const member = await team.add('member', { owner: true, projectRefs: [] })
    const kept = await startTask(team, human, member.memberId)
    await team.ledger.removeProjectOwner({ requestId: requestId('drop-grant'), actor: human, workspaceId: alpha, projectRef: team.projectRef, memberId: member.memberId })
    // The removal itself records the Member as named in the Project — version 2's membership rule — so the
    // Task stays, and the Member keeps driving it.
    expect(team.ledger.getTask(kept.task.taskRef)?.accountable).toBe(member.memberId)
    expect(team.ledger.taskBoard(member.actor, { workspaceId: alpha }).open[0]).toMatchObject({ relation: 'accountable' })
    // Participation is what the retention hangs on: taking the Member out of the Workspace leaves no Project
    // tie at all, and only then does responsibility go back to the Human.
    await team.ledger.removeMember({ requestId: requestId('leave'), actor: human, memberId: member.memberId })
    expect(team.ledger.getTask(kept.task.taskRef)?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(() => new AgentTeamLedger(team.table).validate()).not.toThrow()
  })

  it('returns every Task in the scope when the Project archives, including one handed to a plain member', async () => {
    const team = await seed()
    const reviewer = await team.add('reviewer')
    const started = await startTask(team, human)
    const moved = await handOver(team, started.task, human, reviewer.memberId)
    if (moved.kind !== 'committed') throw new Error('transfer did not commit')
    const archived = await team.ledger.archiveProject({ requestId: requestId('archive'), actor: human, workspaceId: alpha, projectRef: team.projectRef })
    expect(archived.value.project.state).toBe('archived')
    // Nothing is left to hand the Task to, so it returns to the Human — an owner-grant sweep would have
    // missed a Task whose accountable never owned the Project.
    expect(team.ledger.getTask(started.task.taskRef)?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(() => new AgentTeamLedger(team.table).validate()).not.toThrow()
  })

  it('returns a handed-over Task when its accountable leaves the Workspace', async () => {
    const team = await seed()
    const reviewer = await team.add('reviewer')
    const started = await startTask(team, human)
    const moved = await handOver(team, started.task, human, reviewer.memberId)
    if (moved.kind !== 'committed') throw new Error('transfer did not commit')
    await team.ledger.removeMember({ requestId: requestId('remove-reviewer'), actor: human, memberId: reviewer.memberId })
    expect(team.ledger.getTask(started.task.taskRef)?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(() => new AgentTeamLedger(team.table).validate()).not.toThrow()
  })

  it('sends the review reminder to the transferred accountable instead of the Human', async () => {
    const team = await seed()
    const reviewer = await team.add('reviewer')
    const executor = await team.add('executor')
    const started = await startTask(team, human)
    await claim(team, started.task, executor.actor, 'done')
    const moved = await handOver(team, started.task, human, reviewer.memberId)
    if (moved.kind !== 'committed') throw new Error('transfer did not commit')
    // The handover row itself counts as unread responsibility, which suppresses the reminder; the
    // accountable reads it, and from then on the review backlog is its own to answer.
    await readTask(team, moved.task, reviewer.actor)
    const idle = 31 * 60 * 1000
    const candidates = team.ledger.planReminders(Date.parse(moved.receipt.occurredAt) + idle, () => idle, moved.task.taskRef)
    expect(candidates).toEqual([expect.objectContaining({ kind: 'review-backlog', recipient: reviewer.memberId })])
  })

  it('replays version-2 records under version-2 rules after the ledger adopts version 3', async () => {
    const team = await seed({ rulesVersion: 2 })
    const former = await team.add('former', { owner: true })
    const kept = await startTask(team, human, former.memberId)
    // Version 2 returns every open Task when an owner loses the grant, whether or not it still takes part.
    await team.ledger.removeProjectOwner({ requestId: requestId('v2-drop-grant'), actor: human, workspaceId: alpha, projectRef: team.projectRef, memberId: former.memberId })
    expect(team.ledger.getTask(kept.task.taskRef)?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(team.ledger.status().rulesVersion).toBe(2)

    // A version-3 build opens the same ledger, adopts version 3, and keeps the older segment as written.
    await team.reopen()
    expect(team.ledger.status().rulesVersion).toBe(AGENT_TEAM_RULES_VERSION)
    const reviewer = await team.add('reviewer')
    const second = await startTask(team, human)
    const moved = await handOver(team, second.task, human, reviewer.memberId)
    expect(moved.kind === 'committed' && moved.task.accountable).toBe(reviewer.memberId)
    // Cold replay reads both segments: the version-2 return stays legal although the Member still takes
    // part, and the version-3 handover stays legal although the target owns nothing.
    expect(() => new AgentTeamLedger(team.table).validate()).not.toThrow()
  })

  it('a version-2 ledger still refuses the version-3 widenings', async () => {
    const team = await seed({ rulesVersion: 2 })
    const member = await team.add('member')
    const started = await startTask(team, human)
    await expect(handOver(team, started.task, human, member.memberId)).rejects.toThrow(/accountable_target_invalid/)
    expect(team.ledger.getTask(started.task.taskRef)?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
  })
})

describe('The handover prompt under rules version 3', () => {
  it('wakes the new accountable with what the Task now asks of it', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const project = await ctx.agentTeam.createProject({ requestId: harnessRequestId('handover-project'), workspaceId, name: 'Packaging', description: 'Release work' })
    const projectRef = project.project.projectRef
    const reviewer = await ctx.agentTeam.addMember({ requestId: harnessRequestId('handover-reviewer'), workspaceId,
      handle: 'reviewer', description: 'Verifies releases', presetId: 'team-member', projectRefs: [projectRef] })
    const finished = await ctx.agentTeam.startThread({ kind: 'task', requestId: harnessRequestId('handover-task'), workspaceId, projectRef, body: 'Cut the release' })
    if (finished.kind !== 'committed' || finished.task === undefined) throw new Error('Task did not commit')
    const humanRead = await ctx.agentTeam.readThread({ requestId: harnessRequestId('handover-read'), workspaceId, taskRef: finished.task.taskRef })
    const moved = await ctx.agentTeam.transferTask({ requestId: harnessRequestId('handover-transfer'), workspaceId,
      taskRef: finished.task.taskRef, target: reviewer.status.member.memberId, baseRevision: humanRead.thread.revision })
    expect(moved).toMatchObject({ kind: 'committed', task: { accountable: reviewer.status.member.memberId } })
    const ledger = ctx.agentTeam['ledger']!
    const agent = ctx.agents.get(reviewer.status.member.sessionId)!
    const notice = ctx.agentTeam['notificationText'](agent, ledger.notificationFacts(reviewer.status.member.memberId), reviewer.status.member.memberId)
    // The handover is the one Task change that hands somebody work it did not choose, so the wake says what
    // the Task now asks of it — and which way verification goes when the new accountable worked on it.
    expect(notice.text).toContain(`You are the accountable for Task ${finished.task.taskRef} now`)
    expect(notice.text).toContain('accept it when the work stands')
    expect(notice.text).toContain('another Project owner or the Human verifies it')
    adapter.enqueue(textResponse('Reviewing the Task I now own.'))
    await agent.whenIdle()
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('You are the accountable for Task')
  })
})
