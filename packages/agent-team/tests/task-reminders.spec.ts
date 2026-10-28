import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { MemberIdleTracker } from '../src/member-idle.ts'
import { planTaskReminders, REVIEW_BACKLOG_IDLE_MS, STALLED_PUBLIC_MS, type ReminderCandidate } from '../src/task-reminders.ts'
import { planInboxDelivery } from '../src/inbox-delivery.ts'
import type { AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTask } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
const cleanups: Array<() => Promise<void>> = []
let counter = 0
const requestId = (label: string) => `test:reminder:${label}:${++counter}` as AgentTeamRequestId
const NOW = Date.parse('2026-10-25T12:00:00.000Z')
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
  let instant = NOW - 48 * 60 * 60 * 1000
  const ledger = new AgentTeamLedger(table, { rulesVersion: 2, occurredAt: () => new Date(instant++).toISOString() })
  await ledger.initialize()
  const projectRef = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'delivery', description: '', memberIds: [] })).value.project.projectRef
  const add = async (name: string) => {
    const memberId = `member:${name}` as AgentTeamMemberId
    const member: AgentTeamAgentMember = { memberId, sessionId: SessionId(`session:${name}`), workspaceId: alpha, handle: name, description: '', presetId: 'team-member', privateMemoryPath: `/tmp/${name}`, state: 'enabled' }
    await ledger.addMember({ requestId: requestId(`add-${name}`), actor: human, member, handle: name, description: '', presetId: 'team-member', workspaceId: alpha, projectRefs: [projectRef] })
    await ledger.addProjectOwner({ requestId: requestId(`own-${name}`), actor: human, workspaceId: alpha, projectRef, memberId })
    return { memberId, actor: { kind: 'member', memberId, handle: name } as AgentTeamMemberActor }
  }
  const setNow = (value: number) => { instant = value }
  return { pool, table, ledger, projectRef, owner: await add('owner'), reviewer: await add('reviewer'), setNow }
}

type Seeded = Awaited<ReturnType<typeof seed>>
async function startTask(team: Seeded, actor: AgentTeamMemberActor | typeof human = human, accountable?: AgentTeamMemberId) {
  const result = await team.ledger.startThread({ requestId: requestId('task'), actor, workspaceId: alpha, projectRef: team.projectRef,
    kind: 'task', body: 'Ship the change', ...(accountable === undefined ? {} : { accountable }) })
  if (result.value.kind !== 'committed' || result.value.task === undefined) throw new Error('Task did not commit')
  return { ...result.value, task: result.value.task }
}
async function readTask(team: Seeded, task: AgentTeamTask, actor: AgentTeamMemberActor | typeof human) {
  return (await team.ledger.readThread({ requestId: requestId('read'), actor, workspaceId: alpha, taskRef: task.taskRef })).value
}
async function claim(team: Seeded, task: AgentTeamTask, actor: AgentTeamMemberActor, state: 'active' | 'done' = 'active') {
  const read = await readTask(team, task, actor)
  const created = await team.ledger.changeClaim({ requestId: requestId('claim'), actor, workspaceId: alpha, taskRef: task.taskRef,
    baseRevision: read.thread.revision, action: 'claim', direction: `work by ${actor.handle}` })
  if (created.value.kind !== 'committed') throw new Error('Claim did not commit')
  if (state === 'active') return created.value
  const readAgain = await readTask(team, created.value.task, actor)
  const changed = await team.ledger.changeClaim({ requestId: requestId('done'), actor, workspaceId: alpha, taskRef: task.taskRef,
    baseRevision: readAgain.thread.revision, action: 'done', claimRef: created.value.claim.claimRef })
  if (changed.value.kind !== 'committed') throw new Error('Claim did not finish')
  return changed.value
}

function evaluate(team: Seeded, nowMs: number, idle: ReadonlyMap<AgentTeamMemberId, number> = new Map()) {
  return planTaskReminders({ nowMs, tasks: team.ledger.reminderFacts(),
    isOwner: (projectRef, memberId) => memberId === AGENT_TEAM_HUMAN_MEMBER_ID || team.ledger.projectOwnerIds(projectRef).includes(memberId),
    isAvailable: memberId => memberId === AGENT_TEAM_HUMAN_MEMBER_ID || team.ledger.getMember(memberId)?.state === 'enabled',
    idleMs: memberId => idle.get(memberId),
    heldEver: (taskRef, memberId) => team.ledger.heldTaskClaim(taskRef, memberId),
    episodeExists: (taskRef, kind, recipient, baselineSequence) => team.ledger.reminderEpisodeExists(taskRef, kind, recipient, baselineSequence),
    hasUnreadResponsibility: (taskRef, recipient) => team.ledger.hasUnreadResponsibility(taskRef, recipient),
  })
}
async function raise(team: Seeded, candidate: ReminderCandidate, idle: ReadonlyMap<AgentTeamMemberId, number> = new Map()) {
  const receipt = await team.ledger.raiseReminder(candidate, NOW, memberId => idle.get(memberId))
  expect(receipt).toBeDefined()
  return receipt!
}
function records(team: Seeded): AgentTeamOperation[] {
  return [...team.pool.media.get('agent_team')!.tables.get('operations')!.values()].map(value => value as AgentTeamOperation)
}

describe('event-evaluated Task reminders', () => {
  it('reminds the Human once after 30 minutes in review, without changing public Thread history', async () => {
    const team = await seed()
    const started = await startTask(team, human, team.owner.memberId)
    const done = await claim(team, started.task, team.owner.actor, 'done')
    const before = team.ledger.threadHistory(human, { workspaceId: alpha, taskRef: started.task.taskRef })
    const enteredReview = Date.parse(done.receipt.occurredAt)
    await readTask(team, done.task, human)
    expect(evaluate(team, enteredReview + REVIEW_BACKLOG_IDLE_MS - 1)).toEqual([])
    const candidates = evaluate(team, enteredReview + REVIEW_BACKLOG_IDLE_MS)
    expect(candidates).toEqual([{ taskRef: started.task.taskRef, kind: 'review-backlog', recipient: AGENT_TEAM_HUMAN_MEMBER_ID, baselineSequence: done.receipt.sequence }])
    await raise(team, candidates[0]!)
    expect(await team.ledger.raiseReminder(candidates[0]!, NOW, () => undefined)).toBeUndefined()
    // The Human Inbox learns about a reminder through its Task Thread scope; the public Thread picture stays untouched.
    const reminderOperation = records(team).find(operation => operation.kind === 'team/reminder-raised')!
    expect(team.ledger.changeScopesOf(reminderOperation)).toEqual([{ kind: 'thread', threadRef: started.task.threadRef }])
    const inbox = team.ledger.inbox(human, { workspaceId: alpha })
    expect(inbox.items.find(item => item.task?.taskRef === started.task.taskRef)).toMatchObject({ directCount: 1, unreadCount: 1,
      reminders: [{ kind: 'review-backlog', recipient: AGENT_TEAM_HUMAN_MEMBER_ID, baselineSequence: done.receipt.sequence }] })
    const after = team.ledger.threadHistory(human, { workspaceId: alpha, taskRef: started.task.taskRef })
    expect(after.thread.revision).toBe(before.thread.revision)
    expect(after.facts).toEqual(before.facts)
    const notice = team.ledger.notificationFacts(team.owner.memberId).find(entry => entry.item.task?.taskRef === started.task.taskRef)
    expect(notice).toBeUndefined()
    expect(planInboxDelivery({ threads: inbox.items.map(item => ({ item, facts: [], reminders: item.reminders })), main: [], covered: undefined }).trigger).toBe('immediate')
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()
  })

  it('uses an observed Agent idle interval, suppresses behind unread responsibility without spending the episode, and survives replay', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor)
    const done = await claim(team, started.task, team.reviewer.actor, 'done')
    const idle = new Map([[team.owner.memberId, REVIEW_BACKLOG_IDLE_MS]] as const)
    expect(evaluate(team, NOW, idle)).toEqual([])
    await readTask(team, done.task, team.owner.actor)
    const candidates = evaluate(team, NOW, idle)
    expect(candidates).toEqual([{ taskRef: started.task.taskRef, kind: 'review-backlog', recipient: team.owner.memberId, baselineSequence: done.receipt.sequence }])
    await raise(team, candidates[0]!, idle)
    expect(evaluate(team, NOW + 60_000, idle)).toEqual([])
    const cold = new AgentTeamLedger(team.table, { rulesVersion: 2 })
    expect(cold.inbox(team.owner.actor, { workspaceId: alpha }).items[0]?.reminders).toHaveLength(1)
    const read = await cold.readThread({ requestId: requestId('consume'), actor: team.owner.actor, workspaceId: alpha, taskRef: started.task.taskRef })
    expect(read.committed).toBe(true)
    expect(read.value.reminders).toHaveLength(1)
    expect(read.value.remainingUnreadCount).toBe(0)
    expect(cold.inbox(team.owner.actor, { workspaceId: alpha }).items.find(item => item.task?.taskRef === started.task.taskRef)).toBeUndefined()
    expect(evaluate({ ...team, ledger: cold }, NOW + 120_000, idle)).toEqual([])
    expect(records(team).filter(operation => operation.kind === 'team/reminder-raised')).toHaveLength(1)
  })

  it('reminds on public inactivity or active executor idleness, with a baseline unaffected by reminders', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor)
    const active = await claim(team, started.task, team.reviewer.actor)
    const before = evaluate(team, Date.parse(active.receipt.occurredAt))
    const stalled = evaluate(team, NOW + STALLED_PUBLIC_MS + 1)
    expect(stalled).toEqual([{ taskRef: started.task.taskRef, kind: 'stalled', recipient: team.owner.memberId, baselineSequence: active.receipt.sequence }])
    await raise(team, stalled[0]!)
    expect(evaluate(team, NOW + STALLED_PUBLIC_MS + 2)).toEqual([])
    const cold = new AgentTeamLedger(team.table, { rulesVersion: 2 })
    expect(cold.reminderFacts().find(facts => facts.task.taskRef === started.task.taskRef)?.latestPublicSequence).toBe(active.receipt.sequence)
    expect(cold.inbox(team.owner.actor, { workspaceId: alpha }).items[0]?.reminders[0]?.kind).toBe('stalled')
    expect(before).toEqual([])
  })

  it('keeps reminders private, consumes only the Task Thread, and clears them on acceptance', async () => {
    const team = await seed()
    const started = await startTask(team, human, team.owner.memberId)
    const done = await claim(team, started.task, team.owner.actor, 'done')
    await readTask(team, done.task, human)
    const candidate = evaluate(team, Date.parse(done.receipt.occurredAt) + REVIEW_BACKLOG_IDLE_MS)[0]!
    await raise(team, candidate)
    const beforeReads = records(team).length
    expect(team.ledger.taskBoard(human, { workspaceId: alpha }).open[0]?.task.status).toBe('in_review')
    expect(team.ledger.inbox(human, { workspaceId: alpha }).items[0]?.reminders).toHaveLength(1)
    expect(team.ledger.inbox(team.owner.actor, { workspaceId: alpha }).items.every(item => item.reminders.length === 0)).toBe(true)
    expect(records(team)).toHaveLength(beforeReads)
    const history = team.ledger.threadHistory(human, { workspaceId: alpha, taskRef: started.task.taskRef })
    expect(history.facts.every(fact => fact.kind === 'message' || fact.activity.kind !== 'transfer')).toBe(true)
    const read = await readTask(team, done.task, human)
    expect(read.reminders).toHaveLength(1)
    const reminderRead = records(team).at(-1)!
    expect(reminderRead.kind).toBe('team/thread-read')
    if (reminderRead.kind === 'team/thread-read') {
      expect(reminderRead.data.inbox.reminderMarkers?.removed).toHaveLength(1)
      expect(reminderRead.data.inbox.attention.set).toEqual([])
    }
    expect(await team.ledger.readThread({ requestId: requestId('second-read'), actor: human, workspaceId: alpha, taskRef: started.task.taskRef })).toMatchObject({ committed: false })
    const accepted = await team.ledger.changeTask({ requestId: requestId('accept'), actor: human, workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'accept', baseRevision: read.thread.revision })
    expect(accepted.value.kind).toBe('committed')
    expect(team.ledger.inbox(human, { workspaceId: alpha }).items.every(item => item.task?.taskRef !== started.task.taskRef)).toBe(true)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()
  })

  it('starts a new stalled episode after public progress, while an executor idle over 24 hours is sufficient', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor)
    const active = await claim(team, started.task, team.reviewer.actor)
    const recent = Date.parse(active.receipt.occurredAt)
    expect(evaluate(team, recent, new Map([[team.reviewer.memberId, STALLED_PUBLIC_MS + 1]])))
      .toEqual([{ taskRef: started.task.taskRef, kind: 'stalled', recipient: team.owner.memberId, baselineSequence: active.receipt.sequence }])
    await raise(team, evaluate(team, recent, new Map([[team.reviewer.memberId, STALLED_PUBLIC_MS + 1]]))[0]!, new Map([[team.reviewer.memberId, STALLED_PUBLIC_MS + 1]]))
    const read = await readTask(team, active.task, team.reviewer.actor)
    const replied = await team.ledger.reply({ requestId: requestId('progress'), actor: team.reviewer.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, baseRevision: read.thread.revision, body: 'Progress' })
    if (replied.value.kind !== 'committed') throw new Error('reply did not commit')
    const next = evaluate(team, Date.parse(replied.value.receipt.occurredAt) + STALLED_PUBLIC_MS + 1)
    expect(next[0]?.baselineSequence).toBe(replied.value.receipt.sequence)
    expect(next[0]?.baselineSequence).not.toBe(active.receipt.sequence)
  })

  it('rejects a stale candidate at the write boundary after public progress', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor)
    const active = await claim(team, started.task, team.reviewer.actor)
    const candidate = evaluate(team, NOW + STALLED_PUBLIC_MS + 1)[0]!
    const read = await readTask(team, active.task, team.reviewer.actor)
    const progress = await team.ledger.reply({ requestId: requestId('interleaved-progress'), actor: team.reviewer.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, baseRevision: read.thread.revision, body: 'Landed before the queued reminder' })
    expect(progress.value.kind).toBe('committed')
    expect(await team.ledger.raiseReminder(candidate, NOW + STALLED_PUBLIC_MS + 1, () => undefined)).toBeUndefined()
    expect(records(team).filter(operation => operation.kind === 'team/reminder-raised')).toEqual([])
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()
  })

  it('does not reset the review baseline for ordinary replies or re-remind a consumed episode', async () => {
    const team = await seed()
    const started = await startTask(team, human, team.owner.memberId)
    const done = await claim(team, started.task, team.owner.actor, 'done')
    await readTask(team, done.task, human)
    const read = await readTask(team, done.task, team.owner.actor)
    const reply = await team.ledger.reply({ requestId: requestId('review-note'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, baseRevision: read.thread.revision, body: 'One more acceptance note' })
    expect(reply.value.kind).toBe('committed')
    const candidates = evaluate(team, Date.parse(done.receipt.occurredAt) + REVIEW_BACKLOG_IDLE_MS)
    expect(candidates[0]?.baselineSequence).toBe(done.receipt.sequence)
    await raise(team, candidates[0]!)
    await readTask(team, done.task, human)
    expect(evaluate(team, NOW + 10 * STALLED_PUBLIC_MS)).toEqual([])
  })

  it('clears a recipient reminder on member removal and all Task reminders on close', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor)
    const done = await claim(team, started.task, team.reviewer.actor, 'done')
    await readTask(team, done.task, team.owner.actor)
    const candidate = evaluate(team, NOW, new Map([[team.owner.memberId, REVIEW_BACKLOG_IDLE_MS]]))[0]!
    await raise(team, candidate, new Map([[team.owner.memberId, REVIEW_BACKLOG_IDLE_MS]]))
    const removed = await team.ledger.removeMember({ requestId: requestId('remove-reminder-recipient'), actor: human, memberId: team.owner.memberId })
    const operation = team.ledger.getOperation(removed.value.receipt.operationId)
    expect(operation?.kind === 'team/member-removed' ? operation.data.inbox.reminderMarkers?.removed : []).toHaveLength(1)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()

    const second = await startTask(team, human, team.reviewer.memberId)
    const secondDone = await claim(team, second.task, team.reviewer.actor, 'done')
    await readTask(team, secondDone.task, human)
    const secondCandidate = evaluate(team, Date.parse(secondDone.receipt.occurredAt) + REVIEW_BACKLOG_IDLE_MS)[0]!
    await raise(team, secondCandidate)
    const closed = await team.ledger.changeTask({ requestId: requestId('close-reminder'), actor: human, workspaceId: alpha,
      taskRef: second.task.taskRef, action: 'close', baseRevision: secondDone.thread.revision })
    expect(closed.value.kind).toBe('committed')
    expect(team.ledger.inbox(human, { workspaceId: alpha }).items.every(item => item.reminders.length === 0)).toBe(true)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()
  })

  it('keeps the Human review reminder eligible when the accountable executor is suspended', async () => {
    const team = await seed()
    const started = await startTask(team, human, team.owner.memberId)
    const done = await claim(team, started.task, team.owner.actor, 'done')
    await readTask(team, done.task, human)
    await team.ledger.suspendMember({ requestId: requestId('suspend-accountable'), actor: human, memberId: team.owner.memberId })
    expect(evaluate(team, Date.parse(done.receipt.occurredAt) + REVIEW_BACKLOG_IDLE_MS)[0]).toMatchObject({ recipient: AGENT_TEAM_HUMAN_MEMBER_ID, kind: 'review-backlog' })
  })

  it('hides a stalled reminder after progress or transfer without rewriting its marker', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor)
    const active = await claim(team, started.task, team.reviewer.actor)
    const candidate = evaluate(team, NOW + STALLED_PUBLIC_MS + 1)[0]!
    await raise(team, candidate)
    const reminders = () => team.ledger.notificationFacts(team.owner.memberId)[0]?.reminders ?? []
    const delivery = () => planInboxDelivery({ threads: team.ledger.notificationFacts(team.owner.memberId), main: [], covered: undefined })
    expect(reminders()).toHaveLength(1)
    expect(delivery().trigger).toBe('immediate')
    await team.ledger.suspendMember({ requestId: requestId('suspend'), actor: human, memberId: team.owner.memberId })
    await team.ledger.resumeMember({ requestId: requestId('resume'), actor: human, memberId: team.owner.memberId })
    expect(reminders()).toHaveLength(1)

    const progress = await team.ledger.reply({ requestId: requestId('progress'), actor: team.reviewer.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, baseRevision: active.thread.revision, body: 'Progress supersedes the stalled condition' })
    if (progress.value.kind !== 'committed') throw new Error('progress did not commit')
    expect(reminders()).toEqual([])
    expect(delivery().signature).not.toContain('reminder')

    await raise(team, evaluate(team, NOW + 2 * STALLED_PUBLIC_MS)[0]!)
    expect(reminders()).toHaveLength(1)
    await readTask(team, active.task, team.owner.actor)
    await team.ledger.transferTask({ requestId: requestId('transfer'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, target: team.reviewer.memberId, baseRevision: progress.value.thread.revision })
    expect(reminders()).toEqual([])
    expect(team.ledger.inbox(team.reviewer.actor, { workspaceId: alpha }).items[0]?.reminders).toEqual([])

    await team.ledger.transferTask({ requestId: requestId('return'), actor: human, workspaceId: alpha,
      taskRef: started.task.taskRef, target: team.owner.memberId, baseRevision: progress.value.receipt.sequence + 1 })
    expect(records(team).filter(operation => operation.kind === 'team/reminder-raised')).toHaveLength(2)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()
  })

  it('hides a review reminder when its status episode or eligible reviewer changes', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor)
    const done = await claim(team, started.task, team.reviewer.actor, 'done')
    await readTask(team, done.task, team.owner.actor)
    const idle = new Map([[team.owner.memberId, REVIEW_BACKLOG_IDLE_MS]] as const)
    await raise(team, evaluate(team, NOW, idle)[0]!, idle)
    await team.ledger.changeAttention({ requestId: requestId('unfollow'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'unfollow' })
    await readTask(team, done.task, team.owner.actor)
    const transferred = await team.ledger.transferTask({ requestId: requestId('transfer-review'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, target: team.reviewer.memberId, baseRevision: done.thread.revision })
    if (transferred.value.kind !== 'committed') throw new Error('review transfer did not commit')
    expect(team.ledger.inbox(team.owner.actor, { workspaceId: alpha }).items.every(item => item.reminders.length === 0)).toBe(true)
    expect(team.ledger.notificationFacts(team.owner.memberId).every(item => item.reminders.length === 0)).toBe(true)
    expect(team.ledger.inbox(team.reviewer.actor, { workspaceId: alpha }).items.every(item => item.reminders.length === 0)).toBe(true)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()
    await readTask(team, done.task, team.owner.actor)
    const returned = await team.ledger.transferTask({ requestId: requestId('return-review'), actor: human, workspaceId: alpha,
      taskRef: started.task.taskRef, target: team.owner.memberId, baseRevision: transferred.value.thread.revision })
    if (returned.value.kind !== 'committed') throw new Error('return did not commit')
    const closed = await team.ledger.changeTask({ requestId: requestId('close'), actor: human, workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'close', baseRevision: returned.value.thread.revision })
    if (closed.value.kind !== 'committed') throw new Error('close did not commit')
    const reopened = await team.ledger.changeTask({ requestId: requestId('reopen'), actor: human, workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'reopen', baseRevision: closed.value.thread.revision })
    if (reopened.value.kind !== 'committed') throw new Error('reopen did not commit')
    const read = await readTask(team, reopened.value.task!, team.owner.actor)
    await team.ledger.changeClaim({ requestId: requestId('new-claim'), actor: team.owner.actor, workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'claim', direction: 'new review episode', baseRevision: read.thread.revision })
    expect(team.ledger.inbox(team.owner.actor, { workspaceId: alpha }).items.every(item => item.reminders.length === 0)).toBe(true)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 2 }).validate()).not.toThrow()
  })

  it('treats unknown and running presence as no idle signal', () => {
    const tracker = new MemberIdleTracker()
    const memberId = 'member:owner' as AgentTeamMemberId
    expect(tracker.idleMs(memberId, NOW)).toBeUndefined()
    tracker.status(memberId, 'idle', NOW)
    expect(tracker.idleMs(memberId, NOW + REVIEW_BACKLOG_IDLE_MS)).toBe(REVIEW_BACKLOG_IDLE_MS)
    tracker.status(memberId, 'running', NOW + REVIEW_BACKLOG_IDLE_MS + 1)
    expect(tracker.idleMs(memberId, NOW + 10 * STALLED_PUBLIC_MS)).toBeUndefined()
    tracker.status(memberId, 'idle', NOW + 10 * STALLED_PUBLIC_MS)
    expect(tracker.idleMs(memberId, NOW + 10 * STALLED_PUBLIC_MS + 1)).toBe(1)
  })
})
