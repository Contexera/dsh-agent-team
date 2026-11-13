import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { addLedgerMember, alpha, harness, requestId } from './helpers/host-harness.ts'
import type { AgentTeamMemberId, AgentTeamReminderRef, AgentTeamThreadRef } from '../src/types.ts'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { TEAM_INBOX_NOTICE_SUMMARY, TEAM_RECOVERY_NOTICE_SUMMARY } from '../src/context-projection.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'

/**
 * Delivery-level tests for Member reminders: what a queued notice actually
 * rendered decides what it may consume, so the wake carries occurrence
 * identities rather than reminder refs, and a recovery instruction renders
 * reminders like any other durable unread. The ledger's own occurrence identity
 * rules are covered in `member-reminder-ledger.spec.ts`.
 */

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** The text of one queued Team message. */
function textOf(message: UserMessage): string {
  return message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
}

function isNotice(message: UserMessage, summary: string): boolean {
  const source = message.source
  return source.kind === AGENT_TEAM_PLUGIN_ID && source.form === 'notice' && source.summary === summary
}

/**
 * One fake live Agent whose inbox really holds what was steered or queued, so a
 * delivery can find the notice a previous one left behind. `claim` is the
 * framework event the Host records consumption from.
 */
function wakeSeam(ctx: { emit: (event: string, payload: unknown) => void }): {
  readonly agent: Agent
  readonly calls: UserMessage[]
  readonly claim: (message: UserMessage) => Promise<void>
} {
  const calls: UserMessage[] = []
  const nextStep: UserMessage[] = []
  const nextTurn: UserMessage[] = []
  const sessionId = SessionId('session:member-reminder-delivery')
  const remove = (id: string): boolean => {
    const step = nextStep.findIndex(message => message.id === id)
    if (step >= 0) { nextStep.splice(step, 1); return true }
    const turn = nextTurn.findIndex(message => message.id === id)
    if (turn >= 0) { nextTurn.splice(turn, 1); return true }
    return false
  }
  const agent = {
    id: sessionId,
    session: Session.create(sessionId),
    status: 'idle',
    inbox: { nextStep, nextTurn, remove },
    steer: (message: UserMessage) => { calls.push(message); nextStep.push(message) },
    followup: (message: UserMessage) => { calls.push(message); nextTurn.push(message) },
  } as unknown as Agent
  return {
    agent, calls,
    // The Host records consumption when a notice enters a turn, so the claim is
    // what makes an occurrence stop being owed — and the message leaves the
    // inbox, exactly as the framework's own claim leaves it.
    claim: async (message: UserMessage) => {
      remove(message.id)
      ctx.emit('agent/inbox/claimed', { message })
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
}

/** One enabled Member with a live fake session, plus the ledger it is stored in. */
async function boot(tag: string) {
  const test = await harness()
  cleanups.push(async () => { await test.fiber.dispose(); await test.facility.closeAll() })
  const project = await test.ctx.agentTeam.createProject({ requestId: requestId(`${tag}-project`), workspaceId: alpha,
    name: 'engineering', description: 'Engineering work' })
  const added = await addLedgerMember(test.ctx.agentTeam['ledger']!, project.project.projectRef, `member:${tag}`, 'Reminded', tag)
  const seam = wakeSeam(test.ctx as never)
  test.ctx.agentTeam['handles'].set(added.member.memberId, { agent: seam.agent, dispose: async () => {} })
  return { ctx: test.ctx, ledger: test.ctx.agentTeam['ledger']!, memberId: added.member.memberId, actor: added.actor,
    projectRef: project.project.projectRef, seam }
}

/** A one-shot reminder that is already due, so the next evaluation raises it. */
async function dueOnce(ledger: Awaited<ReturnType<typeof boot>>['ledger'], actor: Awaited<ReturnType<typeof boot>>['actor'],
  memberId: AgentTeamMemberId, ref: string, note: string): Promise<AgentTeamReminderRef> {
  const reminderRef = `reminder:${ref}` as AgentTeamReminderRef
  await ledger.createMemberReminder({ requestId: requestId(`create-${ref}`), actor, workspaceId: alpha, reminderRef,
    schedule: { kind: 'once', at: new Date(Date.now() - 60_000).toISOString() }, note })
  await ledger.raiseMemberReminder(ledger.planMemberReminders(Date.now()).find(candidate => candidate.reminderRef === reminderRef)!)
  const unread = ledger.unreadMemberRemindersFor(memberId)
  expect(unread.map(entry => entry.reminder.reminderRef)).toContain(reminderRef)
  return reminderRef
}

/** The occurrences a queued notice carries, as the Host recorded them. */
function carried(team: { ['memberReminderWakes']: Map<string, { reminders: readonly { readonly reminderRef: string; readonly sequence: number }[] }> },
  seam: ReturnType<typeof wakeSeam>, summary: string): readonly { readonly reminderRef: string; readonly sequence: number }[] {
  const notice = seam.calls.filter(message => isNotice(message, summary)).at(-1)
  return notice === undefined ? [] : team['memberReminderWakes'].get(notice.id)?.reminders ?? []
}

describe('a notice consumes only the occurrences it rendered', () => {
  it('leaves an occurrence the detail cap dropped unread and uncovered', async () => {
    const { ctx, ledger, memberId, actor, seam } = await boot('budget-cap')
    // Twenty-five due reminders: the notice renders at most twenty details.
    const refs: AgentTeamReminderRef[] = []
    for (let index = 0; index < 25; index += 1) {
      refs.push(await dueOnce(ledger, actor, memberId, `cap-${index}`, `note-${index} check the build`))
    }
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const notice = seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY)).at(-1)!
    const rendered = textOf(notice).match(/note-\d+ check the build/g) ?? []
    expect(rendered).toHaveLength(20)
    // The queued message carries exactly the occurrences its text contains.
    expect(carried(ctx.agentTeam as never, seam, TEAM_INBOX_NOTICE_SUMMARY)).toHaveLength(20)
    expect(ledger.unreadMemberRemindersFor(memberId)).toHaveLength(25)
    // Coverage is what this notice rendered: the five the cap dropped are not in it.
    const covered = ctx.agentTeam['inboxNoticeDeliveries'].get(memberId)?.covered ?? ''
    for (const entry of ledger.unreadMemberRemindersFor(memberId).slice(20)) {
      expect(covered).not.toContain(`"member-reminder","${entry.reminder.reminderRef}",${entry.sequence}`)
    }
    for (const entry of ledger.unreadMemberRemindersFor(memberId).slice(0, 20)) {
      expect(covered).toContain(`"member-reminder","${entry.reminder.reminderRef}",${entry.sequence}`)
    }

    await seam.claim(notice)
    // The five the cap dropped were never delivered, so they are still owed.
    expect(ledger.unreadMemberRemindersFor(memberId)).toHaveLength(5)

    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const second = seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY)).at(-1)!
    expect(second).not.toBe(notice)
    expect(textOf(second).match(/note-\d+ check the build/g) ?? []).toHaveLength(5)
    await seam.claim(second)
    expect(ledger.unreadMemberRemindersFor(memberId)).toEqual([])
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('leaves occurrences the character budget dropped unread when every note is long', async () => {
    const { ctx, ledger, memberId, actor, seam } = await boot('budget-note')
    const padding = 'x'.repeat(1900)
    for (let index = 0; index < 18; index += 1) {
      await dueOnce(ledger, actor, memberId, `long-${index}`, `long-${index} ${padding}`)
    }
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const notice = seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY)).at(-1)!
    const rendered = textOf(notice).match(/long-\d+ /g) ?? []
    // The budget is what bounds this notice, so some notes never made it in.
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(18)
    expect(carried(ctx.agentTeam as never, seam, TEAM_INBOX_NOTICE_SUMMARY)).toHaveLength(rendered.length)
    expect(textOf(notice).length).toBeLessThanOrEqual(32 * 1024)
    // Coverage is what this notice rendered, so the dropped notes are not in it.
    const covered = ctx.agentTeam['inboxNoticeDeliveries'].get(memberId)?.covered ?? ''
    for (const entry of ledger.unreadMemberRemindersFor(memberId).slice(rendered.length)) {
      expect(covered).not.toContain(`"member-reminder","${entry.reminder.reminderRef}",${entry.sequence}`)
    }

    await seam.claim(notice)
    const owed = ledger.unreadMemberRemindersFor(memberId)
    expect(owed).toHaveLength(18 - rendered.length)
    // The claim's own commit rederives the Inbox, so the follow-up notice carries
    // exactly the occurrences this one could not render.
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const followUp = seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY)).at(-1)!
    expect(followUp).not.toBe(notice)
    expect(textOf(followUp).match(/long-\d+ /g) ?? []).toHaveLength(18 - rendered.length)
  })

  it('does not let a stale notice consume the occurrence that replaced it', async () => {
    const { ctx, ledger, memberId, actor, seam } = await boot('interleaved')
    const base = Date.now()
    const reminderRef = 'reminder:interleaved' as AgentTeamReminderRef
    await ledger.createMemberReminder({ requestId: requestId('create-interleaved'), actor, workspaceId: alpha, reminderRef,
      schedule: { kind: 'every', minutes: 10 }, note: 'check the build' })
    // The Host reads its clock from `Date.now`, so the two occurrences are raised
    // by moving that clock rather than by waiting ten minutes.
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(base + 11 * 60_000)
    await ledger.raiseMemberReminder(ledger.planMemberReminders(Date.now())[0]!)
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const first = seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY)).at(-1)!
    expect(textOf(first)).toContain('check the build')
    const firstOccurrence = ledger.unreadMemberRemindersFor(memberId)[0]!

    // The Member never read it, and the next interval comes due: the newer
    // occurrence replaces the one that notice rendered.
    now.mockReturnValue(base + 22 * 60_000)
    await ledger.raiseMemberReminder(ledger.planMemberReminders(Date.now())[0]!)
    const secondOccurrence = ledger.unreadMemberRemindersFor(memberId)[0]!
    expect(secondOccurrence.sequence).toBeGreaterThan(firstOccurrence.sequence)
    expect(carried(ctx.agentTeam as never, seam, TEAM_INBOX_NOTICE_SUMMARY)).toEqual([{ reminderRef, sequence: firstOccurrence.sequence }])

    // The stale notice finally enters a turn: it answers for the occurrence it
    // rendered, which the replacement already superseded.
    await seam.claim(first)
    expect(ledger.unreadMemberRemindersFor(memberId).map(entry => entry.sequence)).toEqual([secondOccurrence.sequence])

    // The current occurrence is still owed, and the next notice carries it.
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const second = seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY)).at(-1)!
    expect(second).not.toBe(first)
    expect(carried(ctx.agentTeam as never, seam, TEAM_INBOX_NOTICE_SUMMARY)).toEqual([{ reminderRef, sequence: secondOccurrence.sequence }])
    await seam.claim(second)
    expect(ledger.unreadMemberRemindersFor(memberId)).toEqual([])
    now.mockRestore()
  })
})

describe('a recovery instruction renders and consumes reminders', () => {
  it('leaves a Thread fact that arrives after the instruction uncovered until the recovery turn', async () => {
    const { ctx, ledger, memberId, projectRef, seam } = await boot('recovery-thread-later')
    ctx.agentTeam['steerResume'](ledger.getMember(memberId)!, 'Resume the interrupted work.', 'operator recovery')
    const recovery = seam.calls.filter(message => isNotice(message, TEAM_RECOVERY_NOTICE_SUMMARY)).at(-1)!

    const started = await ledger.startThread({ requestId: requestId('recovery-late-thread'), actor: agentTeamHumanActor(), workspaceId: alpha,
      projectRef, kind: 'discussion', body: '@recovery-thread-later please review this' })
    expect(started.value.kind).toBe('committed')
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    expect(seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY))).toHaveLength(0)

    await seam.claim(recovery)
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const notice = seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY)).at(-1)!
    expect(textOf(notice)).toContain(started.value.thread.threadRef)
  })

  it('keeps work omitted from a recovery notice available for a later delivery', async () => {
    const { ctx, ledger, memberId, actor, projectRef, seam } = await boot('recovery-overflow')
    const threads: Array<{ ref: AgentTeamThreadRef; text: string }> = []
    for (let index = 0; index < 9; index += 1) {
      const text = `review item ${index}`
      const started = await ledger.startThread({ requestId: requestId(`recovery-overflow-${index}`), actor: agentTeamHumanActor(), workspaceId: alpha,
        projectRef, kind: 'discussion', body: `@recovery-overflow ${text}` })
      expect(started.value.kind).toBe('committed')
      threads.push({ ref: started.value.thread.threadRef, text })
    }

    const notify = () => ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const notices = () => seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY))
    ctx.agentTeam['steerResume'](ledger.getMember(memberId)!, 'Resume the interrupted work.', 'operator recovery')
    const initial = seam.calls.at(-1)!
    const initialText = textOf(initial)
    const omitted = threads.find(thread => !initialText.includes(thread.text))!
    const rendered = threads.find(thread => initialText.includes(thread.text))!

    await seam.claim(initial)
    notify()
    expect(notices()).toHaveLength(0)

    await ledger.readThread({ requestId: requestId('recovery-overflow-read'), actor, workspaceId: alpha, threadRef: rendered.ref })
    notify()
    expect(notices()).toHaveLength(1)
    expect(textOf(notices().at(-1)!)).toContain(omitted.text)
  })

  it('carries a reminder that is the only unread fact, and consumes it when it enters a turn', async () => {
    const { ctx, ledger, memberId, actor, seam } = await boot('recovery-only')
    const reminderRef = await dueOnce(ledger, actor, memberId, 'recovery-only', 'check the CI run before reviewing')
    // Nothing else is unread, so the recovery instruction is the whole delivery.
    ctx.agentTeam['steerResume'](ledger.getMember(memberId)!, 'Resume the interrupted work.', 'operator recovery')
    const recovery = seam.calls.filter(message => isNotice(message, TEAM_RECOVERY_NOTICE_SUMMARY)).at(-1)!
    expect(textOf(recovery)).toContain('Resume the interrupted work.')
    expect(textOf(recovery)).toContain('check the CI run before reviewing')
    expect(textOf(recovery)).toContain(reminderRef)
    // Its claim consumes the occurrence it rendered, exactly as an Inbox notice's does.
    expect(carried(ctx.agentTeam as never, seam, TEAM_RECOVERY_NOTICE_SUMMARY)).toHaveLength(1)

    await seam.claim(recovery)
    expect(ledger.unreadMemberRemindersFor(memberId)).toEqual([])
    expect(ledger.memberRemindersOf(memberId)[0]?.reminder.state).toBe('done')
  })

  it('does not let a queued recovery instruction answer a reminder raised after it', async () => {
    const { ctx, ledger, memberId, actor, seam } = await boot('recovery-later')
    const first = await dueOnce(ledger, actor, memberId, 'recovery-first', 'check the build')
    ctx.agentTeam['steerResume'](ledger.getMember(memberId)!, 'Resume the interrupted work.', 'operator recovery')
    const recovery = seam.calls.filter(message => isNotice(message, TEAM_RECOVERY_NOTICE_SUMMARY)).at(-1)!
    expect(textOf(recovery)).toContain('check the build')

    // A second reminder comes due while that instruction is still queued. It was
    // never in the instruction's text, so it must stay owed.
    const second = await dueOnce(ledger, actor, memberId, 'recovery-second', 'check the tests')
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    expect(seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY))).toHaveLength(0)
    expect(ledger.unreadMemberRemindersFor(memberId).map(entry => entry.reminder.reminderRef)).toEqual([first, second])
    // The instruction answers for the occurrence it rendered and nothing else.
    const covered = ctx.agentTeam['inboxNoticeDeliveries'].get(memberId)?.covered ?? ''
    const owed = ledger.unreadMemberRemindersFor(memberId)
    expect(covered).toContain(`"member-reminder","${owed[0]!.reminder.reminderRef}",${owed[0]!.sequence}`)
    expect(covered).not.toContain(`"member-reminder","${owed[1]!.reminder.reminderRef}",${owed[1]!.sequence}`)

    // The instruction enters a turn: it consumes what it rendered, and the
    // commit that writes rederives the Inbox and delivers what it did not.
    await seam.claim(recovery)
    expect(ledger.unreadMemberRemindersFor(memberId).map(entry => entry.reminder.reminderRef)).toEqual([second])
    const delivered = seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY)).at(-1)
    expect(delivered).toBeDefined()
    expect(textOf(delivered!)).toContain('check the tests')
    await seam.claim(delivered!)
    expect(ledger.unreadMemberRemindersFor(memberId)).toEqual([])
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })
})

describe('a failed consumption write rederives the notice instead of silencing it', () => {
  /** Every queued Inbox notice so far, newest last. */
  const notices = (seam: ReturnType<typeof wakeSeam>) => seam.calls.filter(message => isNotice(message, TEAM_INBOX_NOTICE_SUMMARY))

  it('redelivers and consumes on the next claim after the first write fails', async () => {
    const { ctx, ledger, memberId, actor, seam } = await boot('consume-retry')
    await dueOnce(ledger, actor, memberId, 'retry', 'check the build')
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const first = notices(seam).at(-1)!
    expect(carried(ctx.agentTeam as never, seam, TEAM_INBOX_NOTICE_SUMMARY)).toHaveLength(1)

    // The claim's consumption write fails, so the occurrence is still owed.
    const write = vi.spyOn(ledger, 'consumeMemberReminders').mockRejectedValueOnce(new Error('storage write failed'))
    await seam.claim(first)
    expect(ledger.unreadMemberRemindersFor(memberId)).toHaveLength(1)
    // The failed attempt drops the coverage this notice earned and rederives the
    // notice now, rather than waiting for an unrelated Team fact or a restart.
    const second = notices(seam).at(-1)!
    expect(second).not.toBe(first)
    expect(textOf(second)).toContain('check the build')
    expect(carried(ctx.agentTeam as never, seam, TEAM_INBOX_NOTICE_SUMMARY)).toHaveLength(1)
    write.mockRestore()

    // The rederived notice claims again and the write succeeds this time.
    await seam.claim(second)
    expect(ledger.unreadMemberRemindersFor(memberId)).toEqual([])
    expect(ledger.memberRemindersOf(memberId)[0]?.reminder.state).toBe('done')
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })

  it('stands down after repeated write failures and still delivers on the next Team fact', async () => {
    const { ctx, ledger, memberId, actor, seam } = await boot('consume-stand-down')
    await dueOnce(ledger, actor, memberId, 'stand-down', 'check the build')
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const write = vi.spyOn(ledger, 'consumeMemberReminders').mockRejectedValue(new Error('storage write failed'))

    // Every failure rederives one notice, and the Member spends one turn on it.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await seam.claim(notices(seam).at(-1)!)
      expect(ledger.unreadMemberRemindersFor(memberId)).toHaveLength(1)
      expect(notices(seam)).toHaveLength(attempt + 1)
    }
    // The fourth failure stands down: the occurrence stays owed, and no further
    // notice is spent on it until something else touches this Member.
    await seam.claim(notices(seam).at(-1)!)
    expect(notices(seam)).toHaveLength(4)
    expect(ledger.unreadMemberRemindersFor(memberId)).toHaveLength(1)
    expect(ctx.agentTeam['inboxNoticeDeliveries'].get(memberId)?.covered).toBe('')

    // The next Team fact touching this Member delivers it again, because the
    // standing-down path dropped the coverage too.
    write.mockRestore()
    ctx.agentTeam['notifyMember'](seam.agent, { kind: 'running' })
    const redelivered = notices(seam).at(-1)!
    expect(textOf(redelivered)).toContain('check the build')
    await seam.claim(redelivered)
    expect(ledger.unreadMemberRemindersFor(memberId)).toEqual([])
    expect(() => ctx.agentTeam.validateLedger()).not.toThrow()
  })
})
