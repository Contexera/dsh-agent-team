import { describe, expect, it, vi } from 'vitest'
import {
  MAX_REMINDER_NOTE_CHARACTERS,
  MEMBER_REMINDER_REF_PATTERN,
  MIN_RECURRING_MINUTES,
  nextOccurrenceAt,
  parseReminderNote,
  parseReminderSchedule,
  planMemberReminders,
  reminderRefForCallId,
  reminderRefIsStorable,
  sameReminderIntent,
} from '../src/member-reminders.ts'
import type { MemberReminderPlanEntry } from '../src/member-reminders.ts'
import type { AgentTeamReminderRef, AgentTeamReminderSchedule } from '../src/types/entities.ts'

/** 2026-11-03T01:30:00Z, i.e. 09:30 on 2026-11-03 in the fixed Team zone (UTC+8). */
const NOW = Date.parse('2026-11-03T01:30:00.000Z')

/**
 * Instants around the boundaries the old floor check tripped over: the first five
 * minutes of an hour, the minute it stopped passing, a different hour, and a day
 * boundary. The floor is a property of the expression, so every one of them must
 * reach the same verdict.
 */
const FLOOR_CLOCK_INSTANTS: readonly string[] = [
  '2026-11-03T15:59:00.000Z',
  '2026-11-03T16:00:00.000Z',
  '2026-11-03T16:01:30.000Z',
  '2026-11-03T16:04:59.999Z',
  '2026-11-03T16:05:00.000Z',
  '2026-11-03T16:07:00.000Z',
  '2026-11-03T23:58:00.000Z',
  '2026-11-04T15:59:59.999Z',
  '2026-11-04T16:00:00.001Z',
]

/** Run with the clock pinned, so a verdict that still reads it cannot hide. */
function atClock<T>(iso: string, run: () => T): T {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
  try {
    return run()
  } finally {
    vi.useRealTimers()
  }
}

const ref = (value: string): AgentTeamReminderRef => `reminder:${value}` as AgentTeamReminderRef

const plan = (reminders: readonly MemberReminderPlanEntry[], nowMs = NOW) =>
  planMemberReminders({ nowMs, reminders }).map(candidate => `${candidate.reminderRef}@${candidate.scheduledAt}`)

const reminder = (overrides: Omit<Partial<MemberReminderPlanEntry>, 'schedule'> & { readonly reminderRef: string; readonly schedule: AgentTeamReminderSchedule }): MemberReminderPlanEntry => ({
  memberId: 'member:aster',
  state: 'active',
  memberState: 'enabled',
  createdAtMs: Date.parse('2026-11-01T00:00:00.000Z'),
  lastOccurrenceAtMs: undefined,
  ...overrides,
  reminderRef: ref(overrides.reminderRef),
})

describe('parseReminderSchedule reads the three schedule kinds', () => {
  it('accepts a one-shot instant, an interval and a cron expression', () => {
    expect(parseReminderSchedule({ kind: 'once', at: '2026-11-04T02:00:00.000Z' }))
      .toEqual({ ok: true, schedule: { kind: 'once', at: '2026-11-04T02:00:00.000Z' } })
    expect(parseReminderSchedule({ kind: 'every', minutes: 30 }))
      .toEqual({ ok: true, schedule: { kind: 'every', minutes: 30 } })
    expect(parseReminderSchedule({ kind: 'cron', expression: '0 9 * * 1' }))
      .toEqual({ ok: true, schedule: { kind: 'cron', expression: '0 9 * * 1' } })
  })

  it('rejects an unparsable one-shot instant instead of inventing a time', () => {
    const parsed = parseReminderSchedule({ kind: 'once', at: 'next tuesday' })
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.reason).toMatch(/ISO 8601 instant/)
  })

  it('rejects an interval below the floor, a fraction and a non-number', () => {
    for (const minutes of [9, 10.5, '10', Number.NaN]) {
      const parsed = parseReminderSchedule({ kind: 'every', minutes })
      expect(parsed.ok).toBe(false)
      expect(parsed.ok === false && parsed.reason).toMatch(/whole number of minutes/)
    }
    expect(parseReminderSchedule({ kind: 'every', minutes: MIN_RECURRING_MINUTES }).ok).toBe(true)
  })

  it('rejects a cron expression with the wrong field count or an out-of-range field', () => {
    for (const expression of ['0 9 * *', '0 9 * * 1 2', '60 9 * * *', '0 24 * * *', '0 9 32 * *', '0 9 * 13 *', '*/0 9 * * *', '9-8 9 * * *', 'a 9 * * *']) {
      const parsed = parseReminderSchedule({ kind: 'cron', expression })
      expect(parsed.ok, expression).toBe(false)
      expect(parsed.ok === false && parsed.reason, expression).toMatch(/cron/)
    }
  })

  it('accepts 7 as Sunday in the day-of-week field, as standard cron does', () => {
    expect(parseReminderSchedule({ kind: 'cron', expression: '0 9 * * 7' }).ok).toBe(true)
    expect(nextOccurrenceAt({ kind: 'cron', expression: '0 9 * * 7' }, NOW)).toBe(Date.parse('2026-11-08T01:00:00.000Z'))
  })

  it('rejects a cron whose consecutive fires are closer than the interval floor', () => {
    for (const expression of ['* * * * *', '*/5 * * * *', '0,5 * * * *']) {
      const parsed = parseReminderSchedule({ kind: 'cron', expression })
      expect(parsed.ok, expression).toBe(false)
      expect(parsed.ok === false && parsed.reason, expression).toMatch(/10 minutes apart/)
    }
    expect(parseReminderSchedule({ kind: 'cron', expression: '*/15 * * * *' }).ok).toBe(true)
    expect(parseReminderSchedule({ kind: 'cron', expression: '0 */6 * * *' }).ok).toBe(true)
    expect(parseReminderSchedule({ kind: 'cron', expression: '0,30 * * * *' }).ok).toBe(true)
  })

  it('rejects a dense cron at every instant, including the window the clock used to hide it', () => {
    // `0,5 * * * *` fires at :00 and :05, so its own closest pair is five
    // minutes. A check that started at "now" saw :05 then the next :00 — 55
    // minutes — for the whole first five minutes of every hour.
    for (const iso of FLOOR_CLOCK_INSTANTS) {
      for (const expression of ['* * * * *', '*/5 * * * *', '0,5 * * * *', '*/9 * * * *', '59,0 * * * *']) {
        const parsed = atClock(iso, () => parseReminderSchedule({ kind: 'cron', expression }))
        expect(parsed.ok, `${expression} at ${iso}`).toBe(false)
        expect(parsed.ok === false && parsed.reason, `${expression} at ${iso}`).toMatch(/minutes apart/)
      }
    }
  })

  it('accepts a legal cron at every instant', () => {
    for (const iso of FLOOR_CLOCK_INSTANTS) {
      for (const expression of ['*/10 * * * *', '0,30 * * * *', '0 */6 * * *', '0 9 * * 1', '30,40 22 * * *']) {
        expect(atClock(iso, () => parseReminderSchedule({ kind: 'cron', expression })).ok, `${expression} at ${iso}`).toBe(true)
      }
    }
  })

  it('answers one expression the same way whatever the clock says', () => {
    for (const expression of ['0,5 * * * *', '*/10 * * * *', '2,58 23,0 * * *', '2,58 23,0 * * 1',
      '0 0 30 2 *', '0 0 29 2 *', '0 9 * * 1', '59,0 * * * *']) {
      const verdicts = new Set(FLOOR_CLOCK_INSTANTS.map(iso =>
        JSON.stringify(atClock(iso, () => parseReminderSchedule({ kind: 'cron', expression })))))
      expect(verdicts.size, expression).toBe(1)
    }
  })

  it('measures the closest pair across a midnight only when two matching days are adjacent', () => {
    // Every day matches, so 23:58 to the next 00:02 is four minutes apart.
    expect(parseReminderSchedule({ kind: 'cron', expression: '2,58 23,0 * * *' }).ok).toBe(false)
    // Only Monday matches, so the same two minutes sit almost a day apart.
    expect(parseReminderSchedule({ kind: 'cron', expression: '2,58 23,0 * * 1' }).ok).toBe(true)
    // The gap within one matching day is what the floor measures when days are apart.
    expect(parseReminderSchedule({ kind: 'cron', expression: '0,5 9 * * 1' }).ok).toBe(false)
    expect(parseReminderSchedule({ kind: 'cron', expression: '30,40 22 * * *' }).ok).toBe(true)
  })

  it('decides never-firing from the calendar instead of from a search window', () => {
    for (const expression of ['0 0 30 2 *', '0 0 31 2,4 *', '0 0 31 4,6,9,11 *']) {
      const parsed = parseReminderSchedule({ kind: 'cron', expression })
      expect(parsed.ok, expression).toBe(false)
      expect(parsed.ok === false && parsed.reason, expression).toMatch(/never fire/)
    }
    for (const expression of ['0 0 29 2 *', '0 0 31 1,3,5,7,8,10,12 *', '0 0 1 1 *']) {
      expect(parseReminderSchedule({ kind: 'cron', expression }).ok, expression).toBe(true)
    }
  })

  it('rejects a cron expression that can never fire again', () => {
    const parsed = parseReminderSchedule({ kind: 'cron', expression: '0 0 30 2 *' })
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.reason).toMatch(/never fire/)
  })

  it('rejects an unknown schedule kind', () => {
    expect(parseReminderSchedule({ kind: 'hourly' }).ok).toBe(false)
    expect(parseReminderSchedule(undefined).ok).toBe(false)
  })
})

describe('parseReminderNote bounds the note the Member leaves for itself', () => {
  it('accepts a note up to the limit and rejects a longer one', () => {
    expect(parseReminderNote('check the CI run')).toEqual({ ok: true, note: 'check the CI run' })
    expect(parseReminderNote('x'.repeat(MAX_REMINDER_NOTE_CHARACTERS)).ok).toBe(true)
    const parsed = parseReminderNote('x'.repeat(MAX_REMINDER_NOTE_CHARACTERS + 1))
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.reason).toMatch(/2000/)
  })

  it('rejects a blank or non-string note', () => {
    for (const note of ['', '   ', 42, undefined]) {
      expect(parseReminderNote(note).ok, String(note)).toBe(false)
    }
  })
})

describe('cron reads the fixed UTC+8 wall clock', () => {
  it('fires on the weekday the expression names, in Team-zone terms', () => {
    // 09:00 every Monday. 2026-11-03 is a Tuesday, so the next fire is 2026-11-09T09:00+08:00.
    const next = nextOccurrenceAt({ kind: 'cron', expression: '0 9 * * 1' }, NOW)
    expect(next).toBe(Date.parse('2026-11-09T01:00:00.000Z'))
  })

  it('treats a restricted day-of-month and day-of-week as a union, as standard cron does', () => {
    // 00:30 on the 1st of the month OR on any Sunday; 2026-11-03 is a Tuesday.
    const schedule = { kind: 'cron' as const, expression: '30 0 1 * 0' }
    expect(nextOccurrenceAt(schedule, NOW)).toBe(Date.parse('2026-11-07T16:30:00.000Z'))
  })

  it('steps over a month with no matching day', () => {
    // 03:00 on the 31st: November has 30 days, so the next fire is 2026-12-31T03:00+08:00.
    expect(nextOccurrenceAt({ kind: 'cron', expression: '0 3 31 * *' }, NOW)).toBe(Date.parse('2026-12-30T19:00:00.000Z'))
  })

  it('returns undefined when no fire exists inside the search horizon', () => {
    expect(nextOccurrenceAt({ kind: 'cron', expression: '0 0 30 2 *' }, NOW)).toBeUndefined()
  })

  it('finds a February 29 fire across the eight-year leap gap', () => {
    // 2096-02-29 09:00 just fired; the next February 29 is 2104-02-29 09:00.
    expect(nextOccurrenceAt({ kind: 'cron', expression: '0 9 29 2 *' }, Date.parse('2096-02-29T01:00:00.000Z')))
      .toBe(Date.parse('2104-02-29T01:00:00.000Z'))
  })
})

describe('planMemberReminders decides what is due now', () => {
  it('raises a one-shot reminder whose instant has passed, exactly once', () => {
    const due = { reminderRef: 'once', schedule: { kind: 'once' as const, at: '2026-11-03T01:00:00.000Z' } }
    expect(plan([reminder(due)])).toEqual(['reminder:once@2026-11-03T01:00:00.000Z'])
    // Already raised: no occurrence is pending, so nothing is due again.
    expect(plan([reminder({ ...due, lastOccurrenceAtMs: Date.parse('2026-11-03T01:00:00.000Z') })])).toEqual([])
  })

  it('does not raise a one-shot reminder that is still in the future', () => {
    expect(plan([reminder({ reminderRef: 'once', schedule: { kind: 'once' as const, at: '2026-11-04T01:00:00.000Z' } })])).toEqual([])
  })

  it('raises an interval reminder once per interval, measured from the last occurrence', () => {
    const due = { reminderRef: 'every', schedule: { kind: 'every' as const, minutes: 30 } }
    // The first occurrence is one interval after creation, which is already past.
    expect(plan([reminder(due)])).toEqual(['reminder:every@2026-11-03T01:30:00.000Z'])
    const last = Date.parse('2026-11-03T01:25:00.000Z')
    expect(plan([reminder({ ...due, lastOccurrenceAtMs: last })], Date.parse('2026-11-03T01:35:00.000Z'))).toEqual([])
    expect(plan([reminder({ ...due, lastOccurrenceAtMs: last })], Date.parse('2026-11-03T01:55:00.000Z')))
      .toEqual(['reminder:every@2026-11-03T01:55:00.000Z'])
  })

  it('raises at most one occurrence per reminder after downtime, so a gap makes up exactly one', () => {
    // A 10-minute reminder whose Host was down for three hours raises once, at the
    // moment of recovery, and the next occurrence is one interval after that.
    const due = { reminderRef: 'every', schedule: { kind: 'every' as const, minutes: 10 } }
    const last = Date.parse('2026-11-02T22:00:00.000Z')
    expect(plan([reminder({ ...due, lastOccurrenceAtMs: last })], Date.parse('2026-11-03T01:00:00.000Z')))
      .toEqual(['reminder:every@2026-11-03T01:00:00.000Z'])
    const raised = Date.parse('2026-11-03T01:00:00.000Z')
    expect(plan([reminder({ ...due, lastOccurrenceAtMs: raised })], Date.parse('2026-11-03T01:05:00.000Z'))).toEqual([])
  })

  it('raises a cron reminder on the cron time the ledger last recorded', () => {
    const due = { reminderRef: 'cron', schedule: { kind: 'cron' as const, expression: '0 9 * * *' } }
    const last = Date.parse('2026-11-02T01:00:00.000Z')
    // 13:00 in the Team zone: the next fire is still in the future.
    expect(plan([reminder({ ...due, lastOccurrenceAtMs: last })], Date.parse('2026-11-02T05:00:00.000Z'))).toEqual([])
    // 09:00 in the Team zone: the fire is due.
    expect(plan([reminder({ ...due, lastOccurrenceAtMs: last })], Date.parse('2026-11-03T01:00:00.000Z')))
      .toEqual(['reminder:cron@2026-11-03T01:00:00.000Z'])
  })

  it('keeps timing a suspended Member and stops an archived or removed one', () => {
    const due = { reminderRef: 'every', schedule: { kind: 'every' as const, minutes: 30 } }
    expect(plan([reminder({ ...due, memberState: 'suspended' })])).toEqual(['reminder:every@2026-11-03T01:30:00.000Z'])
    expect(plan([reminder({ ...due, memberState: 'archived' })])).toEqual([])
    expect(plan([reminder({ ...due, memberState: 'inactive' })])).toEqual([])
  })

  it('never raises a cancelled or already finished reminder', () => {
    const due = { reminderRef: 'every', schedule: { kind: 'every' as const, minutes: 30 } }
    expect(plan([reminder({ ...due, state: 'cancelled' })])).toEqual([])
    expect(plan([reminder({ ...due, state: 'done' })])).toEqual([])
  })

  it('plans one candidate per reminder, so a new occurrence replaces an unconsumed one', () => {
    const due = [
      reminder({ reminderRef: 'a', schedule: { kind: 'every' as const, minutes: 30 } }),
      reminder({ reminderRef: 'b', schedule: { kind: 'every' as const, minutes: 30 } }),
    ]
    expect(plan(due)).toEqual(['reminder:a@2026-11-03T01:30:00.000Z', 'reminder:b@2026-11-03T01:30:00.000Z'])
  })
})

describe('a reminder ref is derived so the durable schema can parse it back', () => {
  it('escapes the two characters the ref shape reserves, injectively', () => {
    // A parallel sub-call's public form is `<parent>:ptc:<n>`, which a raw
    // concatenation would turn into a second colon the schema refuses.
    expect(reminderRefForCallId('call-1')).toBe('reminder:call-1')
    expect(reminderRefForCallId('call-1:ptc:2')).toBe('reminder:call-1%3Aptc%3A2')
    expect(reminderRefForCallId('call%3A1:ptc:2')).toBe('reminder:call%253A1%3Aptc%3A2')
    // The escape is injective, so two different calls never share one reminder.
    const derived = ['call-1', 'call-1:ptc:2', 'call%3A1', 'call%3A1:ptc:2'].map(reminderRefForCallId)
    expect(new Set(derived).size).toBe(4)
    // The same call derives the same ref forever, which is what makes a replay idempotent.
    expect(reminderRefForCallId('call-1:ptc:2')).toBe('reminder:call-1%3Aptc%3A2')
    expect(derived.every(reminderRefIsStorable)).toBe(true)
  })

  it('rejects a ref the durable schema would refuse on replay', () => {
    expect(reminderRefIsStorable('reminder:call-1')).toBe(true)
    expect(reminderRefIsStorable('reminder:call-1%3Aptc%3A2')).toBe(true)
    expect(reminderRefIsStorable('reminder:call:1')).toBe(false)
    expect(reminderRefIsStorable('reminder:')).toBe(false)
    expect(reminderRefIsStorable('reminder:a:b')).toBe(false)
    expect(reminderRefIsStorable('member-reminder:a')).toBe(false)
    expect(MEMBER_REMINDER_REF_PATTERN.test('reminder:a')).toBe(true)
  })
})

describe('sameReminderIntent compares the normalized promise, not its spelling', () => {
  const stored = { schedule: { kind: 'once', at: '2026-11-04T02:00:00.000Z' } as AgentTeamReminderSchedule, note: 'check the build' }
  /** The ledger's order: the parser normalizes first, then the intent is compared. */
  const intent = (input: unknown, note: string) => {
    const parsed = parseReminderSchedule(input)
    return parsed.ok ? sameReminderIntent(stored, parsed.schedule, note) : 'unparseable'
  }

  it('accepts a respelling of the same instant and rejects a moved one', () => {
    expect(intent({ kind: 'once', at: '2026-11-04T02:00:00.000Z' }, 'check the build')).toBe(true)
    expect(intent({ kind: 'once', at: '2026-11-04T02:00:00Z' }, 'check the build')).toBe(true)
    expect(intent({ kind: 'once', at: '2026-11-05T02:00:00.000Z' }, 'check the build')).toBe(false)
    expect(intent({ kind: 'once', at: '2026-11-04T02:00:00.000Z' }, 'check the tests')).toBe(false)
    expect(intent({ kind: 'every', minutes: 30 }, 'check the build')).toBe(false)
  })

  it('separates two intervals that differ by one minute and two crons by whitespace', () => {
    const interval = { schedule: { kind: 'every', minutes: 30 } as AgentTeamReminderSchedule, note: 'standup' }
    expect(sameReminderIntent(interval, { kind: 'every', minutes: 30 }, 'standup')).toBe(true)
    expect(sameReminderIntent(interval, { kind: 'every', minutes: 31 }, 'standup')).toBe(false)
    const cron = { schedule: { kind: 'cron', expression: '0 9 * * 1-5' } as AgentTeamReminderSchedule, note: 'weekday' }
    expect(sameReminderIntent(cron, { kind: 'cron', expression: '0 9 * * 1-5' }, 'weekday')).toBe(true)
    // A run of whitespace inside the expression is not the same string, but the
    // parser normalizes it away, so the ledger compares equal intents.
    expect(sameReminderIntent(cron, { kind: 'cron', expression: '0  9 * * 1-5' }, 'weekday')).toBe(false)
    expect(parseReminderSchedule({ kind: 'cron', expression: '0  9 * * 1-5' })).toEqual({ ok: true, schedule: cron.schedule })
  })
})
