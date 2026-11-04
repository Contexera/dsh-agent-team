import type { AgentTeamMemberReminderState, AgentTeamReminderRef, AgentTeamReminderSchedule } from './types/entities.ts'

/**
 * Member reminders are time promises bound to a Member, not to a Session: the
 * Team ledger keeps them, so a Session being recycled, rolled over or restarted
 * never costs the Member its reminder. Everything here is pure — the schedule
 * is parsed once at creation and replayed from the ledger afterwards, and the
 * plan answers "what is due now" without touching durable state.
 */

/** Active reminders one Member may carry. */
export const MAX_ACTIVE_REMINDERS_PER_MEMBER = 50

/**
 * The ref shape the durable schema admits: the `reminder:` prefix and one value
 * with no further colon. Every ref the Host or a tool derives is checked against
 * it, because a record that fails it cannot be parsed back on replay.
 */
export const MEMBER_REMINDER_REF_PATTERN = /^reminder:[^:]+$/

/** The note is handed to the creating Member when the occurrence fires. */
export const MAX_REMINDER_NOTE_CHARACTERS = 2000

/** Floor on the gap between two consecutive fires of a recurring reminder. */
export const MIN_RECURRING_MINUTES = 10

/** The fixed Team coordination offset from UTC, in minutes; no daylight-saving component. */
const TEAM_ZONE_OFFSET_MINUTES = 8 * 60

/** How far ahead a cron expression is searched before it is called never-firing. February 29 can sit eight years from any instant (2096→2104), so the horizon must outreaches that gap. */
const CRON_SEARCH_HORIZON_MS = 9 * 366 * 24 * 60 * 60 * 1000

/**
 * 2000-01-01 opens the Gregorian cycle the cron floor is judged over, and falls
 * on a Saturday in cron's `0 = Sunday` numbering. 400 years is 146097 days, which
 * is 20871 whole weeks, so the calendar and its weekdays repeat exactly there.
 */
const CRON_CYCLE_START_YEAR = 2000
const CRON_CYCLE_YEARS = 400
const CRON_CYCLE_START_WEEKDAY = 6
const MONTH_LENGTHS: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const MINUTE_MS = 60_000
const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR

export type ReminderScheduleParse =
  | { readonly ok: true; readonly schedule: AgentTeamReminderSchedule }
  | { readonly ok: false; readonly reason: string }

export type ReminderNoteParse =
  | { readonly ok: true; readonly note: string }
  | { readonly ok: false; readonly reason: string }

interface CronFields {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly daysOfMonth: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly daysOfWeek: ReadonlySet<number>
  /** Vixie cron unions the two day fields only when both are restricted. */
  readonly dayOfMonthRestricted: boolean
  readonly dayOfWeekRestricted: boolean
}

const CRON_FIELD_RANGES: readonly { readonly name: string; readonly min: number; readonly max: number }[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
]

function parseCronField(field: string, min: number, max: number): ReadonlySet<number> | undefined {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    if (part === '') return undefined
    const stepSplit = part.split('/')
    if (stepSplit.length > 2) return undefined
    const [range, stepText] = stepSplit as [string, string | undefined]
    let step = 1
    if (stepText !== undefined) {
      step = Number(stepText)
      if (!Number.isInteger(step) || step < 1) return undefined
    }
    let from = min
    let to = max
    if (range !== '*') {
      const bounds = range.split('-')
      if (bounds.length > 2) return undefined
      const [first, second] = bounds as [string, string | undefined]
      from = Number(first)
      if (!Number.isInteger(from) || from < min || from > max) return undefined
      if (second === undefined) {
        to = stepText === undefined ? from : max
      } else {
        to = Number(second)
        if (!Number.isInteger(to) || to < min || to > max || to < from) return undefined
      }
    }
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return values.size === 0 ? undefined : values
}

function parseCronExpression(expression: string): CronFields | undefined {
  const trimmed = expression.trim()
  if (trimmed === '') return undefined
  const fields = trimmed.split(/\s+/)
  if (fields.length !== CRON_FIELD_RANGES.length) return undefined
  const parsed = fields.map((field, index) => {
    const range = CRON_FIELD_RANGES[index]!
    return parseCronField(field, range.min, range.max)
  })
  if (parsed.some(field => field === undefined)) return undefined
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as readonly ReadonlySet<number>[]
  // 7 is Sunday, as standard cron has it; it folds into 0 so the weekday lookup stays one set.
  const weekdays = new Set([...daysOfWeek!].map(day => day === 7 ? 0 : day))
  return {
    minutes: minutes!, hours: hours!, daysOfMonth: daysOfMonth!, months: months!, daysOfWeek: weekdays,
    dayOfMonthRestricted: fields[2] !== '*', dayOfWeekRestricted: fields[4] !== '*',
  }
}

function instantOf(wallMs: number): number {
  return wallMs - TEAM_ZONE_OFFSET_MINUTES * MINUTE_MS
}

function cronDayMatches(fields: CronFields, wall: Date): boolean {
  return cronDateMatches(fields, fields.daysOfMonth.has(wall.getUTCDate()), fields.daysOfWeek.has(wall.getUTCDay()))
}

function cronNextAfter(fields: CronFields, fromMs: number): number | undefined {
  // Start at the next whole minute strictly after `fromMs`: a fire belongs to its
  // minute boundary, and an occurrence is never the instant that produced it.
  let wall = Math.floor((fromMs + TEAM_ZONE_OFFSET_MINUTES * MINUTE_MS) / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  const horizon = wall + CRON_SEARCH_HORIZON_MS
  while (wall < horizon) {
    const current = new Date(wall)
    if (!fields.months.has(current.getUTCMonth() + 1)) {
      const next = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1, 0, 0, 0, 0))
      wall = next.getTime()
      continue
    }
    if (!cronDayMatches(fields, current)) {
      wall = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, 0, 0, 0, 0)
      continue
    }
    if (!fields.hours.has(current.getUTCHours())) {
      wall = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate(), current.getUTCHours() + 1, 0, 0, 0)
      continue
    }
    if (!fields.minutes.has(current.getUTCMinutes())) {
      wall += MINUTE_MS
      continue
    }
    return instantOf(wall)
  }
  return undefined
}

/** The instant a schedule next fires after `fromMs`, or undefined when it never will. */
export function nextOccurrenceAt(schedule: AgentTeamReminderSchedule, fromMs: number): number | undefined {
  if (schedule.kind === 'once') return Date.parse(schedule.at)
  if (schedule.kind === 'every') return fromMs + schedule.minutes * MINUTE_MS
  const fields = parseCronExpression(schedule.expression)
  return fields === undefined ? undefined : cronNextAfter(fields, fromMs)
}

/** The fires of one matching day, as minutes from that day's midnight, ascending. */
function cronFiresOfDay(fields: CronFields): readonly number[] {
  const minutes = [...fields.minutes].sort((left, right) => left - right)
  const fires: number[] = []
  for (const hour of [...fields.hours].sort((left, right) => left - right)) {
    for (const minute of minutes) fires.push(hour * MINUTES_PER_HOUR + minute)
  }
  return fires
}

function monthLength(year: number, month: number): number {
  if (month !== 2) return MONTH_LENGTHS[month - 1]!
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
}

/** The Vixie rule for one date, from whether its day-of-month and day-of-week matched. */
function cronDateMatches(fields: CronFields, dayOfMonth: boolean, dayOfWeek: boolean): boolean {
  return fields.dayOfMonthRestricted && fields.dayOfWeekRestricted ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek
}

/**
 * What the calendar says about a cron expression, decided on its own terms and
 * never from the clock: does it fire on any date at all, and can two consecutive
 * dates both fire?
 *
 * The Gregorian calendar and its weekdays repeat exactly every 400 years — 146097
 * days, 20871 whole weeks — so one fixed cycle answers both questions for every
 * date that will ever exist. That is what makes the floor below a property of the
 * expression instead of a property of the moment it was created.
 */
function cronDatePattern(fields: CronFields): { readonly fires: boolean; readonly adjacent: boolean } {
  if (!fields.dayOfMonthRestricted && !fields.dayOfWeekRestricted) return { fires: true, adjacent: true }
  // The cycle repeats, so its last date is followed by its first: read the first
  // date before walking, because a skipped month must not stand in for it.
  const firstDateMatches = fields.months.has(1)
    && cronDateMatches(fields, fields.daysOfMonth.has(1), fields.daysOfWeek.has(CRON_CYCLE_START_WEEKDAY))
  let weekday = CRON_CYCLE_START_WEEKDAY
  let previousMatched = false
  let fires = false
  let adjacent = false
  for (let year = CRON_CYCLE_START_YEAR; year < CRON_CYCLE_START_YEAR + CRON_CYCLE_YEARS; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const length = monthLength(year, month)
      if (!fields.months.has(month)) {
        weekday = (weekday + length) % 7
        previousMatched = false
        continue
      }
      for (let day = 1; day <= length; day += 1) {
        const matched = cronDateMatches(fields, fields.daysOfMonth.has(day), fields.daysOfWeek.has(weekday))
        if (matched) {
          fires = true
          if (previousMatched) adjacent = true
        }
        previousMatched = matched
        weekday = (weekday + 1) % 7
      }
    }
  }
  return { fires, adjacent: adjacent || (firstDateMatches && previousMatched) }
}

/**
 * The closest two consecutive fires of a cron expression come, in minutes, or
 * `undefined` when no date matches. Every matching day repeats the same set of
 * minutes, so the closest pair is either two fires inside one day or a day's last
 * fire and the next matching day's first — and the second only exists when two
 * matching dates sit side by side in the calendar.
 */
function cronClosestFireGap(fields: CronFields): number | undefined {
  const pattern = cronDatePattern(fields)
  if (!pattern.fires) return undefined
  const fires = cronFiresOfDay(fields)
  let closest = MINUTES_PER_DAY
  for (let index = 1; index < fires.length; index += 1) closest = Math.min(closest, fires[index]! - fires[index - 1]!)
  if (pattern.adjacent) closest = Math.min(closest, MINUTES_PER_DAY - fires[fires.length - 1]! + fires[0]!)
  return closest
}

export function parseReminderSchedule(input: unknown): ReminderScheduleParse {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'Reminder schedule must be an object.' }
  const schedule = input as Record<string, unknown>
  if (schedule.kind === 'once') {
    const at = typeof schedule.at === 'string' ? Date.parse(schedule.at) : Number.NaN
    if (!Number.isFinite(at)) return { ok: false, reason: 'A one-shot reminder needs `at` as an ISO 8601 instant, for example 2026-11-04T02:00:00.000Z.' }
    return { ok: true, schedule: { kind: 'once', at: new Date(at).toISOString() } }
  }
  if (schedule.kind === 'every') {
    const minutes = schedule.minutes
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < MIN_RECURRING_MINUTES) {
      return { ok: false, reason: `An interval reminder needs \`minutes\` as a whole number of minutes, at least ${MIN_RECURRING_MINUTES}.` }
    }
    return { ok: true, schedule: { kind: 'every', minutes } }
  }
  if (schedule.kind === 'cron') {
    if (typeof schedule.expression !== 'string') return { ok: false, reason: 'A cron reminder needs `expression` as a string.' }
    const fields = parseCronExpression(schedule.expression)
    if (fields === undefined) {
      return { ok: false, reason: `Reminder cron expression '${schedule.expression}' is not a five-field cron expression (minute hour day-of-month month day-of-week).` }
    }
    const closest = cronClosestFireGap(fields)
    if (closest === undefined) {
      return { ok: false, reason: `Reminder cron expression '${schedule.expression.trim()}' can never fire: no date matches its month and day fields.` }
    }
    if (closest < MIN_RECURRING_MINUTES) {
      return { ok: false, reason: `Reminder cron expression '${schedule.expression.trim()}' fires every ${closest} minute(s); a recurring reminder must fire at least ${MIN_RECURRING_MINUTES} minutes apart.` }
    }
    return { ok: true, schedule: { kind: 'cron', expression: schedule.expression.trim().replace(/\s+/g, ' ') } }
  }
  return { ok: false, reason: "Reminder schedule `kind` must be 'once', 'every' or 'cron'." }
}

export function parseReminderNote(input: unknown): ReminderNoteParse {
  if (typeof input !== 'string') return { ok: false, reason: 'Reminder note must be a string.' }
  const note = input.trim()
  if (note === '') return { ok: false, reason: 'Reminder note must say what this reminder is for.' }
  if ([...note].length > MAX_REMINDER_NOTE_CHARACTERS) {
    return { ok: false, reason: `Reminder note must be at most ${MAX_REMINDER_NOTE_CHARACTERS} characters.` }
  }
  return { ok: true, note }
}

/** Whether a ref can be stored at all: anything else is refused at the create boundary, not on replay. */
export function reminderRefIsStorable(reminderRef: string): boolean {
  return MEMBER_REMINDER_REF_PATTERN.test(reminderRef)
}

/**
 * The identity one tool call's reminder carries. A call id is opaque and a
 * parallel sub-call's public form is `<parent>:ptc:<n>`, so the two characters
 * the ref shape reserves are percent-escaped. The escape is injective, so two
 * different calls never collapse onto one reminder, and the same call derives
 * the same ref forever, which is what makes a replayed create idempotent.
 */
export function reminderRefForCallId(callId: string): AgentTeamReminderRef {
  return `reminder:${callId.replace(/%/g, '%25').replace(/:/g, '%3A')}` as AgentTeamReminderRef
}

function sameReminderSchedule(left: AgentTeamReminderSchedule, right: AgentTeamReminderSchedule): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'once') return right.kind === 'once' && left.at === right.at
  if (left.kind === 'every') return right.kind === 'every' && left.minutes === right.minutes
  return right.kind === 'cron' && left.expression === right.expression
}

/**
 * Whether a replay carries the intent the stored create recorded. Both sides are
 * already normalized — the schedule by the parser, the note trimmed — so a
 * respelling of the same promise is the same request, while a moved time or a
 * rewritten note is a different one wearing a reused request id.
 */
export function sameReminderIntent(reminder: { readonly schedule: AgentTeamReminderSchedule; readonly note: string },
  schedule: AgentTeamReminderSchedule, note: string): boolean {
  return reminder.note === note && sameReminderSchedule(reminder.schedule, schedule)
}

/** One reminder as the planner sees it: durable facts plus the Member lifecycle that still governs it. */
export interface MemberReminderPlanEntry {
  readonly reminderRef: string
  readonly memberId: string
  readonly schedule: AgentTeamReminderSchedule
  readonly state: AgentTeamMemberReminderState
  /** `archived` and `inactive` cancel every reminder the Member owns; `suspended` keeps timing. */
  readonly memberState: 'enabled' | 'suspended' | 'inactive' | 'archived'
  readonly createdAtMs: number
  /** Instant of the last occurrence, or undefined when this reminder has never fired. */
  readonly lastOccurrenceAtMs: number | undefined
}

export interface MemberReminderPlanInput {
  readonly nowMs: number
  readonly reminders: readonly MemberReminderPlanEntry[]
}

/** One occurrence to raise. The instant is when it is raised, not when it was scheduled: a missed cadence collapses into a single make-up. */
export interface MemberReminderCandidate {
  readonly reminderRef: string
  readonly memberId: string
  readonly scheduledAt: string
}

/**
 * What is due now, at most one occurrence per reminder. A recurring reminder
 * whose previous occurrence is still unconsumed is still due: replacement is
 * the delivery's business, so the plan never suppresses an occurrence because
 * the last one was never read.
 */
export function planMemberReminders(input: MemberReminderPlanInput): readonly MemberReminderCandidate[] {
  const candidates: MemberReminderCandidate[] = []
  for (const entry of input.reminders) {
    if (entry.state !== 'active') continue
    if (entry.memberState !== 'enabled' && entry.memberState !== 'suspended') continue
    const baseline = entry.lastOccurrenceAtMs ?? entry.createdAtMs
    if (entry.schedule.kind === 'once') {
      const at = Date.parse(entry.schedule.at)
      if (!Number.isFinite(at) || at > input.nowMs || entry.lastOccurrenceAtMs !== undefined) continue
      candidates.push({ reminderRef: entry.reminderRef, memberId: entry.memberId, scheduledAt: new Date(at).toISOString() })
      continue
    }
    const dueAt = nextOccurrenceAt(entry.schedule, baseline)
    if (dueAt === undefined || dueAt > input.nowMs) continue
    candidates.push({ reminderRef: entry.reminderRef, memberId: entry.memberId, scheduledAt: new Date(input.nowMs).toISOString() })
  }
  return Object.freeze(candidates)
}

/**
 * Structural validity of one schedule, with no clock in it: replay must reach the
 * same verdict for the same record forever, so the time-dependent policy (a cron
 * that never fires, a gap under the floor) is enforced at creation instead.
 */
export function reminderScheduleIsSound(schedule: unknown): boolean {
  if (typeof schedule !== 'object' || schedule === null) return false
  const shape = schedule as Record<string, unknown>
  if (shape.kind === 'once') {
    return typeof shape.at === 'string' && Number.isFinite(Date.parse(shape.at))
  }
  if (shape.kind === 'every') {
    return typeof shape.minutes === 'number' && Number.isInteger(shape.minutes) && shape.minutes >= MIN_RECURRING_MINUTES
  }
  if (shape.kind === 'cron') {
    if (typeof shape.expression !== 'string') return false
    const fields = parseCronExpression(shape.expression)
    return fields !== undefined && cronNextAfter(fields, 0) !== undefined
  }
  return false
}

/** Next instant any active reminder of this Member fires, for arming the Host timer. */
export function nextReminderWakeAt(reminders: readonly MemberReminderPlanEntry[], nowMs: number): number | undefined {
  let soonest: number | undefined
  for (const entry of reminders) {
    if (entry.state !== 'active') continue
    if (entry.memberState !== 'enabled' && entry.memberState !== 'suspended') continue
    const baseline = entry.lastOccurrenceAtMs ?? entry.createdAtMs
    const at = entry.schedule.kind === 'once'
      ? (entry.lastOccurrenceAtMs === undefined ? Date.parse(entry.schedule.at) : undefined)
      : nextOccurrenceAt(entry.schedule, baseline)
    if (at === undefined || !Number.isFinite(at)) continue
    if (soonest === undefined || at < soonest) soonest = at
  }
  return soonest === undefined || soonest <= nowMs ? undefined : soonest
}
