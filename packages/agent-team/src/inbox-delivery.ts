import type { AgentTeamProjectRef, AgentTeamThreadReadFact, AgentTeamThreadRef } from './types/entities.ts'
import type { AgentTeamInboxItem, AgentTeamInboxReminder, AgentTeamMainTimelineEntry } from './types/requests-results.ts'

/**
 * Every unread fact interrupts: there is one delivery class. An ordinary Thread
 * update reaches a reader only because it follows that Thread, a mention or a
 * reply carries a direct marker, and a responsibility Activity or live Task
 * reminder arrives through its own marker — so what decides whether ordinary
 * work exists at all is Attention, never how fast it travels. No identity
 * chooses a slower class here. `covered` is what keeps an unchanged
 * rederivation from spending a second attempt on the same durable facts.
 */
export type InboxDelivery = 'immediate'

/** The reader's role in one notice scope, as the notice states it. */
export type InboxScopeRole = 'follower' | 'member'

export interface InboxThreadUnread {
  readonly item: AgentTeamInboxItem
  readonly facts: readonly AgentTeamThreadReadFact[]
  readonly reminders?: readonly AgentTeamInboxReminder[]
}

export interface InboxMainUnread {
  readonly projectRef: AgentTeamProjectRef
  readonly entries: readonly AgentTeamMainTimelineEntry[]
}

export interface InboxDeliveryInput {
  readonly threads: readonly InboxThreadUnread[]
  readonly main: readonly InboxMainUnread[]
  /** Signature of the immediate facts the last delivery attempt answered. */
  readonly covered: string | undefined
  /**
   * Threads the last notice could not render, so its facts were never delivered.
   * Their facts still enter this signature — otherwise an unchanged
   * rederivation would look identical to the delivered one — but the facts the
   * last attempt actually answered are the ones `covered` may match.
   */
  readonly undelivered?: readonly AgentTeamThreadRef[] | undefined
}

export interface InboxThreadPlan {
  readonly threadRef: AgentTeamThreadRef
  readonly role: InboxScopeRole
  readonly delivery: InboxDelivery
}

export interface InboxDeliveryPlan {
  /** Why a notice goes out now, or `undefined` when nothing may interrupt the reader. */
  readonly trigger: InboxDelivery | undefined
  readonly signature: string
  /** The signature the next rederivation compares `covered` against: everything the notice can actually render. */
  readonly delivered: string
  readonly threads: readonly InboxThreadPlan[]
}

export function planInboxDelivery(input: InboxDeliveryInput): InboxDeliveryPlan {
  const immediate: (string | number)[][] = []
  const delivered: (string | number)[][] = []
  const threads: InboxThreadPlan[] = []
  const undelivered = new Set(input.undelivered ?? [])
  for (const { item, facts, reminders = [] } of input.threads) {
    const threadRef = item.thread.threadRef
    // A reminder is always delivered: it is the whole reason the notice exists
    // when the Thread holds no ordinary unread.
    if (reminders.length > 0) {
      const reminderFacts = [threadRef, 'reminder', ...reminders.map(reminder => `${reminder.kind}:${reminder.baselineSequence}`)]
      immediate.push(reminderFacts)
      delivered.push(reminderFacts)
    }
    const now = facts.map(entry => entry.fact.sequence)
    if (now.length > 0) immediate.push([threadRef, ...now])
    // A Thread the notice cannot render is not delivered by this attempt, so its
    // facts are not what `covered` records: an unchanged rederivation still sees
    // them as owed and re-attempts instead of standing down.
    if (now.length > 0 && !undelivered.has(threadRef)) delivered.push([threadRef, ...now])
    threads.push(Object.freeze({ threadRef, role: item.attention === undefined ? 'member' : 'follower', delivery: 'immediate' as const }))
  }
  for (const { projectRef, entries } of input.main) {
    if (entries.length > 0) { immediate.push([projectRef, ...entries.map(entry => entry.sequence)]); delivered.push([projectRef, ...entries.map(entry => entry.sequence)]) }
  }
  const signature = immediate.length === 0 ? '' : JSON.stringify(immediate)
  const covered = delivered.length === 0 ? '' : JSON.stringify(delivered)
  const trigger = signature !== '' && covered !== input.covered ? 'immediate' : undefined
  return Object.freeze({ trigger, signature, delivered: covered, threads: Object.freeze(threads) })
}
