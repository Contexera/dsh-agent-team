import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec, agentTeamOperationSchema } from '../src/spec.ts'
import { reminderRefForCallId } from '../src/member-reminders.ts'
import type {
  AgentTeamAgentMember,
  AgentTeamMemberActor,
  AgentTeamMemberId,
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamReminderRef,
  AgentTeamReminderSchedule,
  AgentTeamRequestId,
} from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
const cleanups: Array<() => Promise<void>> = []
let counter = 0
const requestId = (label: string) => `test:member-reminder:${label}:${++counter}` as AgentTeamRequestId
const NOW = Date.parse('2026-11-03T01:30:00.000Z')
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>

/** A ledger with a controllable clock, so occurrence timing is asserted, never waited for. */
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
  const add = async (name: string) => {
    const memberId = `member:${name}` as AgentTeamMemberId
    const member: AgentTeamAgentMember = { memberId, sessionId: SessionId(`session:${name}`), workspaceId: alpha, handle: name,
      description: '', presetId: 'team-member', model: { provider: 'mock', model: 'mock' }, privateMemoryPath: `/tmp/${name}`, state: 'enabled' }
    await ledger.addMember({ requestId: requestId(`add-${name}`), actor: human, member, handle: name, description: '', presetId: 'team-member', workspaceId: alpha, projectRefs: [], model: { provider: 'mock', model: 'mock' }})
    return { memberId, actor: { kind: 'member', memberId, handle: name } as AgentTeamMemberActor }
  }
  return {
    table, ledger, setNow: (value: number) => { instant = value },
    aster: await add('aster'), cole: await add('cole'),
  }
}

type Seeded = Awaited<ReturnType<typeof seed>>

/** Reopen the same durable records: the projection every later Host start rebuilds by replay. */
async function reopen(table: Table, nowMs: number): Promise<AgentTeamLedger> {
  const ledger = new AgentTeamLedger(table, { rulesVersion: 2, occurredAt: () => new Date(nowMs).toISOString() })
  await ledger.initialize()
  return ledger
}

async function create(team: Seeded, actor: AgentTeamMemberActor, schedule: AgentTeamReminderSchedule, note = 'check the CI run'): Promise<AgentTeamReminderRef> {
  const out = await team.ledger.createMemberReminder({
    requestId: requestId(`create-${actor.handle}`), actor, workspaceId: alpha,
    reminderRef: `reminder:${actor.handle}-${++counter}` as AgentTeamReminderRef, schedule, note,
  })
  if (!out.committed) throw new Error('reminder creation did not commit')
  return out.value.reminder.reminderRef
}

const dueRefs = (ledger: AgentTeamLedger, nowMs: number) => ledger.planMemberReminders(nowMs).map(candidate => candidate.reminderRef)

/** The occurrence identities a notice for this Member's unread carries, exactly as the Host builds them. */
const occurrencesOf = (ledger: AgentTeamLedger, memberId: AgentTeamMemberId) =>
  ledger.unreadMemberRemindersFor(memberId).map(entry => ({ reminderRef: entry.reminder.reminderRef, sequence: entry.sequence }))

describe('a Member creates, lists and cancels its own reminders', () => {
  it('stores the reminder under its creator and lists it back with the derived state', async () => {
    const team = await seed()
    const at = new Date(NOW + 30 * 60_000).toISOString()
    const ref = await create(team, team.aster.actor, { kind: 'once', at })
    const [view] = team.ledger.memberRemindersOf(team.aster.memberId)
    expect(view?.reminder).toMatchObject({ reminderRef: ref, memberId: team.aster.memberId, schedule: { kind: 'once', at },
      note: 'check the CI run', state: 'active' })
    expect(view?.nextOccurrenceAt).toBe(at)
    expect(view?.pendingOccurrenceAt).toBeUndefined()
    // Another Member's list never carries it.
    expect(team.ledger.memberRemindersOf(team.cole.memberId)).toEqual([])
  })

  it('refuses a duplicate reminder ref', async () => {
    const team = await seed()
    const schedule: AgentTeamReminderSchedule = { kind: 'every', minutes: 30 }
    const ref = await create(team, team.aster.actor, schedule)
    await expect(team.ledger.createMemberReminder({ requestId: requestId('dup'), actor: team.aster.actor, workspaceId: alpha, reminderRef: ref, schedule, note: 'again' }))
      .rejects.toThrow(/already exists/)
  })

  it('answers a replayed request id only for the same promise, and calls a change a collision', async () => {
    const team = await seed()
    const request = { requestId: requestId('idempotent'), actor: team.aster.actor, workspaceId: alpha,
      reminderRef: 'reminder:idempotent' as AgentTeamReminderRef }
    const first = await team.ledger.createMemberReminder({ ...request, schedule: { kind: 'once', at: '2026-11-04T02:00:00.000Z' }, note: 'check the build' })
    expect(first.committed).toBe(true)

    // The same request again, with the same promise spelled differently: the
    // parser normalized the instant, so the original operation stands.
    const again = await team.ledger.createMemberReminder({ ...request, schedule: { kind: 'once', at: '2026-11-04T02:00:00Z' }, note: 'check the build' })
    expect(again.committed).toBe(false)
    expect(again.value.reminder.schedule).toEqual({ kind: 'once', at: '2026-11-04T02:00:00.000Z' })
    expect(team.ledger.memberRemindersOf(team.aster.memberId)).toHaveLength(1)

    // A moved instant, a moved interval and a rewritten note are different
    // promises wearing a reused request id: none of them may return the original.
    for (const [label, schedule, note] of [
      ['moved-at', { kind: 'once', at: '2026-11-05T02:00:00.000Z' }, 'check the build'],
      ['moved-minutes', { kind: 'every', minutes: 45 }, 'check the build'],
      ['changed-note', { kind: 'once', at: '2026-11-04T02:00:00.000Z' }, 'check the tests'],
    ] as const) {
      await expect(team.ledger.createMemberReminder({ ...request, schedule, note }), label)
        .rejects.toThrow(/reused with a different operation or payload/)
    }
    // A different request id for a different promise is a fresh reminder.
    await expect(team.ledger.createMemberReminder({ requestId: requestId('fresh'), actor: team.aster.actor, workspaceId: alpha,
      reminderRef: 'reminder:fresh' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 30 }, note: 'check the build' }))
      .resolves.toMatchObject({ committed: true })
    expect(team.ledger.memberRemindersOf(team.aster.memberId)).toHaveLength(2)
  })

  it('cancels only the owner\'s own reminder, and refuses a second cancel', async () => {
    const team = await seed()
    const ref = await create(team, team.aster.actor, { kind: 'every', minutes: 30 })
    await expect(team.ledger.cancelMemberReminder({ requestId: requestId('cross'), actor: team.cole.actor, workspaceId: alpha, reminderRef: ref }))
      .rejects.toThrow(/belongs to Member/)
    const out = await team.ledger.cancelMemberReminder({ requestId: requestId('own'), actor: team.aster.actor, workspaceId: alpha, reminderRef: ref })
    expect(out.value.reminder.state).toBe('cancelled')
    expect(team.ledger.memberRemindersOf(team.aster.memberId)[0]?.reminder.state).toBe('cancelled')
    await expect(team.ledger.cancelMemberReminder({ requestId: requestId('again'), actor: team.aster.actor, workspaceId: alpha, reminderRef: ref }))
      .rejects.toThrow(/already cancelled/)
  })

  it('lets the Human cancel a Member reminder, which is the Member detail control', async () => {
    const team = await seed()
    const ref = await create(team, team.aster.actor, { kind: 'every', minutes: 30 })
    const out = await team.ledger.cancelMemberReminder({ requestId: requestId('human'), actor: human, workspaceId: alpha, reminderRef: ref })
    expect(out.value.reminder.state).toBe('cancelled')
  })

  it('replays every written record, so the durable ledger validates the new kinds', async () => {
    const team = await seed()
    const ref = await create(team, team.aster.actor, { kind: 'every', minutes: 30 })
    team.setNow(NOW)
    await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(NOW)[0]!)
    await team.ledger.consumeMemberReminders(team.aster.memberId, occurrencesOf(team.ledger, team.aster.memberId))
    await team.ledger.cancelMemberReminder({ requestId: requestId('cancel'), actor: team.aster.actor, workspaceId: alpha, reminderRef: ref })
    // Reopening replays validation over all four kinds; a bad record throws here.
    const reopened = await reopen(team.table, NOW)
    const [view] = reopened.memberRemindersOf(team.aster.memberId)
    expect(view?.reminder.state).toBe('cancelled')
    expect(reopened.unreadMemberRemindersFor(team.aster.memberId)).toEqual([])
  })

  it('refuses a reminder ref the durable schema could not parse back', async () => {
    const team = await seed()
    // A raw call id concatenated onto the prefix is what a nested sub-call produces.
    await expect(team.ledger.createMemberReminder({ requestId: requestId('nested'), actor: team.aster.actor, workspaceId: alpha,
      reminderRef: 'reminder:call:1' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 30 }, note: 'nested call' }))
      .rejects.toThrow(/not storable/)
    expect(team.ledger.memberRemindersOf(team.aster.memberId)).toEqual([])
    // The ref a nested call id derives is storable, and every record it writes replays.
    const nested = reminderRefForCallId('call-1:ptc:2')
    expect(nested).toBe('reminder:call-1%3Aptc%3A2')
    const created = await team.ledger.createMemberReminder({ requestId: requestId('nested-2'), actor: team.aster.actor, workspaceId: alpha,
      reminderRef: nested, schedule: { kind: 'every', minutes: 30 }, note: 'nested call' })
    expect(created.value.reminder.reminderRef).toBe(nested)
    team.setNow(NOW)
    await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(NOW)[0]!)
    await team.ledger.consumeMemberReminders(team.aster.memberId, occurrencesOf(team.ledger, team.aster.memberId))
    for (const [, operation] of team.table.entries()) {
      expect(agentTeamOperationSchema.safeParse(operation).success, `${operation.kind} must parse back`).toBe(true)
    }
    const reopened = await reopen(team.table, NOW)
    expect(reopened.memberRemindersOf(team.aster.memberId).map(view => view.reminder.reminderRef)).toEqual([nested])
  })
})

describe('an occurrence is delivered once and consumed when it is read', () => {
  it('raises a due occurrence into the Member private inbox and records it consumed', async () => {
    const team = await seed()
    const ref = await create(team, team.aster.actor, { kind: 'once', at: new Date(NOW - 60_000).toISOString() })
    team.setNow(NOW)
    expect(dueRefs(team.ledger, NOW)).toEqual([ref])
    const receipt = await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(NOW)[0]!)
    expect(receipt?.sequence).toBeGreaterThan(0)
    const unread = team.ledger.unreadMemberRemindersFor(team.aster.memberId)
    expect(unread.map(entry => entry.reminder.reminderRef)).toEqual([ref])
    expect(unread[0]?.scheduledAt).toBe(new Date(NOW - 60_000).toISOString())
    // A one-shot reminder has fired its last occurrence.
    expect(team.ledger.memberRemindersOf(team.aster.memberId)[0]?.reminder.state).toBe('done')
    // Nothing is due again until the schedule says so.
    expect(dueRefs(team.ledger, NOW + 60_000)).toEqual([])

    await team.ledger.consumeMemberReminders(team.aster.memberId, occurrencesOf(team.ledger, team.aster.memberId))
    expect(team.ledger.unreadMemberRemindersFor(team.aster.memberId)).toEqual([])
    const [view] = team.ledger.memberRemindersOf(team.aster.memberId)
    expect(view?.pendingOccurrenceAt).toBeUndefined()
    expect(view?.lastOccurrenceAt).toBe(new Date(NOW - 60_000).toISOString())
  })

  it('redelivers an occurrence the Host never recorded as consumed', async () => {
    const team = await seed()
    const ref = await create(team, team.aster.actor, { kind: 'every', minutes: 30 })
    team.setNow(NOW)
    await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(NOW)[0]!)
    // The Host dies before recording the consumption: reopening rederives the same unread.
    const reopened = await reopen(team.table, NOW + 60_000)
    expect(reopened.unreadMemberRemindersFor(team.aster.memberId).map(entry => entry.reminder.reminderRef)).toEqual([ref])
    // Consuming once removes it; a second consumption is a no-op, never a second delivery.
    await reopened.consumeMemberReminders(team.aster.memberId, occurrencesOf(reopened, team.aster.memberId))
    await reopened.consumeMemberReminders(team.aster.memberId, occurrencesOf(reopened, team.aster.memberId))
    expect(reopened.unreadMemberRemindersFor(team.aster.memberId)).toEqual([])
  })

  it('consumes the occurrence the notice named, not the newer one that replaced it', async () => {
    const team = await seed()
    const ref = await create(team, team.aster.actor, { kind: 'every', minutes: 10 })
    team.setNow(NOW)
    await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(NOW)[0]!)
    // The first notice named this occurrence and is still waiting unread in the Session.
    const first = occurrencesOf(team.ledger, team.aster.memberId)
    expect(first).toHaveLength(1)
    // The Member never read it, and the next interval comes due: the newer occurrence replaces it.
    team.setNow(NOW + 11 * 60_000)
    await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(NOW + 11 * 60_000)[0]!)
    const second = occurrencesOf(team.ledger, team.aster.memberId)
    expect(second).toHaveLength(1)
    expect(second[0]!.sequence).toBeGreaterThan(first[0]!.sequence)

    // The stale notice finally enters a turn. It answers for the occurrence it
    // named, which the replacement already superseded, so nothing is consumed.
    await team.ledger.consumeMemberReminders(team.aster.memberId, first)
    const stillUnread = team.ledger.unreadMemberRemindersFor(team.aster.memberId)
    expect(stillUnread.map(entry => entry.sequence)).toEqual(second.map(entry => entry.sequence))
    expect(stillUnread[0]?.scheduledAt).toBe(new Date(NOW + 11 * 60_000).toISOString())
    // The notice for the current occurrence consumes it.
    await team.ledger.consumeMemberReminders(team.aster.memberId, second)
    expect(team.ledger.unreadMemberRemindersFor(team.aster.memberId)).toEqual([])
    // Replay reaches the same standing, and the marker is gone with the occurrence.
    const reopened = await reopen(team.table, NOW + 12 * 60_000)
    expect(reopened.unreadMemberRemindersFor(team.aster.memberId)).toEqual([])
    expect(reopened.memberRemindersOf(team.aster.memberId)[0]?.lastOccurrenceAt).toBe(new Date(NOW + 11 * 60_000).toISOString())
    expect(ref).toMatch(/^reminder:/)
  })

  it('replaces an unconsumed occurrence instead of stacking a second one', async () => {
    const team = await seed()
    const ref = await create(team, team.aster.actor, { kind: 'every', minutes: 10 })
    team.setNow(NOW)
    await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(NOW)[0]!)
    // The Member never read it, and the next interval comes due.
    team.setNow(NOW + 11 * 60_000)
    const second = team.ledger.planMemberReminders(NOW + 11 * 60_000)
    expect(second.map(candidate => candidate.reminderRef)).toEqual([ref])
    await team.ledger.raiseMemberReminder(second[0]!)
    const unread = team.ledger.unreadMemberRemindersFor(team.aster.memberId)
    expect(unread).toHaveLength(1)
    expect(unread[0]?.scheduledAt).toBe(new Date(NOW + 11 * 60_000).toISOString())
    // One marker per reminder is the replacement: the raised operation removed the previous marker.
    const raised = [...team.table.entries()].map(([, operation]) => operation).filter(operation => operation.kind === 'team/member-reminder-raised')
    expect(raised).toHaveLength(2)
    expect(raised[1]?.data.inbox.memberReminderMarkers?.removed).toHaveLength(1)
    const reopened = await reopen(team.table, NOW + 12 * 60_000)
    expect(reopened.unreadMemberRemindersFor(team.aster.memberId).map(entry => entry.scheduledAt)).toEqual([new Date(NOW + 11 * 60_000).toISOString()])
  })

  it('accepts a cron occurrence raised later than its own fire, which lands closer than the cadence', async () => {
    const team = await seed()
    // Fires at :00 and :10 of every hour, so two fires are ten minutes apart.
    const ref = await create(team, team.aster.actor, { kind: 'cron', expression: '0,10 * * * *' })
    // The Host noticed one minute before the fire, so the raise lands one minute after the previous one.
    const first = Date.parse('2026-11-03T01:59:00.000Z')
    team.setNow(first)
    expect(dueRefs(team.ledger, first)).toEqual([ref])
    await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(first)[0]!)
    const second = Date.parse('2026-11-03T02:00:00.000Z')
    expect(dueRefs(team.ledger, second)).toEqual([ref])
    await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(second)[0]!)
    // Replay judges the instants it recorded, not the clock it was written on.
    const reopened = await reopen(team.table, second + 60_000)
    const unread = reopened.unreadMemberRemindersFor(team.aster.memberId)
    expect(unread).toHaveLength(1)
    expect(unread[0]?.scheduledAt).toBe(new Date(second).toISOString())
  })

  it('wakes the Member the occurrence belongs to and nobody else', async () => {
    const team = await seed()
    const ref = await create(team, team.aster.actor, { kind: 'once', at: new Date(NOW - 60_000).toISOString() })
    team.setNow(NOW)
    const receipt = await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(NOW)[0]!)
    const operation = [...team.table.entries()].map(([, entry]) => entry).find(entry => entry.operationId === receipt?.operationId)!
    expect(team.ledger.affectedMembersOf(operation)).toEqual([team.aster.memberId])
    expect(team.ledger.changeScopesOf(operation)).toEqual([{ kind: 'workspace', workspaceId: alpha }])
    expect(ref).toMatch(/^reminder:/)
  })
})

describe('cron reads UTC+8 and downtime makes up exactly one occurrence', () => {
  it('fires on the UTC+8 wall-clock time the expression names', async () => {
    const team = await seed()
    // 09:00 every day, read in the fixed Team zone: 01:00 UTC.
    const ref = await create(team, team.aster.actor, { kind: 'cron', expression: '0 9 * * *' })
    const [view] = team.ledger.memberRemindersOf(team.aster.memberId)
    expect(view?.nextOccurrenceAt).toBe('2026-11-02T01:00:00.000Z')

    // Two days after the last fire: the missed cadence collapses into one make-up.
    const later = Date.parse('2026-11-05T04:00:00.000Z')
    expect(dueRefs(team.ledger, later)).toEqual([ref])
    await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(later)[0]!)
    const [after] = team.ledger.memberRemindersOf(team.aster.memberId)
    // The next fire is one day after the make-up, not the two days the downtime skipped.
    expect(after?.nextOccurrenceAt).toBe('2026-11-06T01:00:00.000Z')
    expect(dueRefs(team.ledger, later + 60 * 60_000)).toEqual([])
  })

  it('refuses a cron expression under the ten-minute floor', async () => {
    const team = await seed()
    await expect(team.ledger.createMemberReminder({ requestId: requestId('fast-cron'), actor: team.aster.actor, workspaceId: alpha,
      reminderRef: 'reminder:fast-cron' as AgentTeamReminderRef, schedule: { kind: 'cron', expression: '*/5 * * * *' }, note: 'too fast' }))
      .rejects.toThrow(/at least 10/)
  })
})

describe('limits hold', () => {
  it('refuses a fifty-first active reminder', async () => {
    const team = await seed()
    for (let index = 0; index < 50; index += 1) await create(team, team.aster.actor, { kind: 'every', minutes: 30 })
    expect(team.ledger.activeMemberReminderCount(team.aster.memberId)).toBe(50)
    await expect(team.ledger.createMemberReminder({ requestId: requestId('over'), actor: team.aster.actor, workspaceId: alpha,
      reminderRef: 'reminder:over' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 30 }, note: 'one too many' }))
      .rejects.toThrow(/maximum of 50/)
    // Cancelling one makes room again.
    const [first] = team.ledger.memberRemindersOf(team.aster.memberId)
    await team.ledger.cancelMemberReminder({ requestId: requestId('free'), actor: team.aster.actor, workspaceId: alpha, reminderRef: first!.reminder.reminderRef })
    await expect(team.ledger.createMemberReminder({ requestId: requestId('room'), actor: team.aster.actor, workspaceId: alpha,
      reminderRef: 'reminder:room' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 30 }, note: 'room again' }))
      .resolves.toMatchObject({ committed: true })
  })

  it('refuses a recurring interval under ten minutes and an over-long or empty note', async () => {
    const team = await seed()
    for (const [label, schedule] of [['fast', { kind: 'every', minutes: 9 }], ['zero', { kind: 'every', minutes: 0 }]] as const) {
      await expect(team.ledger.createMemberReminder({ requestId: requestId(label), actor: team.aster.actor, workspaceId: alpha,
        reminderRef: `reminder:${label}` as AgentTeamReminderRef, schedule, note: 'too fast' })).rejects.toThrow(/at least 10/)
    }
    await expect(team.ledger.createMemberReminder({ requestId: requestId('long'), actor: team.aster.actor, workspaceId: alpha,
      reminderRef: 'reminder:long' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 30 }, note: 'x'.repeat(2001) }))
      .rejects.toThrow(/2000 characters/)
    await expect(team.ledger.createMemberReminder({ requestId: requestId('blank'), actor: team.aster.actor, workspaceId: alpha,
      reminderRef: 'reminder:blank' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 30 }, note: '   ' }))
      .rejects.toThrow(/what this reminder is for/)
  })
})

describe('the Member lifecycle governs its reminders', () => {
  it('keeps timing a suspended Member and stops an archived one', async () => {
    const team = await seed()
    const ref = await create(team, team.aster.actor, { kind: 'every', minutes: 30 })
    await team.ledger.suspendMember({ requestId: requestId('suspend'), actor: human, memberId: team.aster.memberId })
    team.setNow(NOW)
    expect(dueRefs(team.ledger, NOW)).toEqual([ref])
    await team.ledger.raiseMemberReminder(team.ledger.planMemberReminders(NOW)[0]!)
    // The suspended Member still accumulates the private unread it reads on resume.
    expect(team.ledger.unreadMemberRemindersFor(team.aster.memberId)).toHaveLength(1)

    await team.ledger.archiveMember({ requestId: requestId('archive'), actor: human, memberId: team.aster.memberId })
    expect(team.ledger.memberRemindersOf(team.aster.memberId)[0]?.reminder.state).toBe('cancelled')
    expect(dueRefs(team.ledger, NOW + 60 * 60_000)).toEqual([])
    expect(team.ledger.unreadMemberRemindersFor(team.aster.memberId)).toEqual([])
  })

  it('keeps the reminder when the Member Session is recycled', async () => {
    const team = await seed()
    const ref = await create(team, team.aster.actor, { kind: 'every', minutes: 30 })
    await team.ledger.recycleMemberSession({ requestId: requestId('recycle'), actor: { kind: 'host', handle: 'agent-team' }, workspaceId: alpha,
      memberId: team.aster.memberId, previousSessionId: SessionId('session:aster'), newSessionId: SessionId('session:aster-2') })
    expect(team.ledger.memberRemindersOf(team.aster.memberId).map(view => view.reminder.reminderRef)).toEqual([ref])
    expect(team.ledger.memberRemindersOf(team.aster.memberId)[0]?.reminder.state).toBe('active')
  })

  it('never hands a reminder to the Human, who cannot create one either', async () => {
    const team = await seed()
    // The create request names a Member actor, so the Human has no way in; a forged caller is refused by the ledger.
    await expect(team.ledger.createMemberReminder({ requestId: requestId('human-create'), actor: human as never, workspaceId: alpha,
      reminderRef: 'reminder:human' as AgentTeamReminderRef, schedule: { kind: 'every', minutes: 30 }, note: 'for me' }))
      .rejects.toThrow()
    expect(team.ledger.memberRemindersOf('member:human' as AgentTeamMemberId)).toEqual([])
  })
})
