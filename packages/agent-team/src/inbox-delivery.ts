import type { AgentTeamProjectRef, AgentTeamThreadReadFact, AgentTeamThreadRef } from './types/entities.ts'
import type { AgentTeamInboxItem, AgentTeamMainTimelineEntry } from './types/requests-results.ts'

/** Ordinary Thread updates an owner accumulates per Thread before they interrupt it; a runtime parameter, never stored. */
export const INBOX_THRESHOLD_UPDATES = 5

export type InboxDelivery = 'immediate' | 'threshold'

/** The reader's role in one notice scope, as the notice states it. */
export type InboxScopeRole = 'owner' | 'follower' | 'member'

export interface InboxThreadUnread {
  readonly item: AgentTeamInboxItem
  readonly facts: readonly AgentTeamThreadReadFact[]
}

export interface InboxMainUnread {
  readonly projectRef: AgentTeamProjectRef
  readonly entries: readonly AgentTeamMainTimelineEntry[]
}

export interface InboxDeliveryInput {
  readonly threads: readonly InboxThreadUnread[]
  readonly main: readonly InboxMainUnread[]
  readonly owns: (projectRef: AgentTeamProjectRef) => boolean
  /** Newest ordinary sequence each Thread's threshold updates were last delivered through. */
  readonly summarizedThrough: ReadonlyMap<AgentTeamThreadRef, number>
  /** Signature of the immediate facts the last delivery attempt answered. */
  readonly covered: string | undefined
}

export interface InboxThreadPlan {
  readonly threadRef: AgentTeamThreadRef
  readonly role: InboxScopeRole
  readonly delivery: InboxDelivery
  /** Ordinary facts that wait for the threshold; zero unless the reader owns the Project. */
  readonly thresholdCount: number
}

export interface InboxDeliveryPlan {
  /** Why a notice goes out now, or `undefined` when nothing may interrupt the reader. */
  readonly trigger: InboxDelivery | undefined
  readonly signature: string
  /** `summarizedThrough` as it stands once this plan's notice is delivered. */
  readonly summarizedThrough: ReadonlyMap<AgentTeamThreadRef, number>
  readonly threads: readonly InboxThreadPlan[]
}

function isThresholdFact(entry: AgentTeamThreadReadFact, owner: boolean): boolean {
  return owner && entry.fact.kind === 'message' && !entry.direct
}

/**
 * Decide whether the reader's current unread interrupts it. Mentions, replies to the reader, activities, Main stream unread and
 * a non-owner follower's ordinary updates are immediate; an owner's ordinary Thread updates wait until one Thread holds
 * `INBOX_THRESHOLD_UPDATES` undelivered ones, and otherwise ride along with the next immediate notice.
 */
export function planInboxDelivery(input: InboxDeliveryInput): InboxDeliveryPlan {
  const immediate: (string | number)[][] = []
  const summarizedThrough = new Map<AgentTeamThreadRef, number>()
  const threads: InboxThreadPlan[] = []
  let thresholdReached = false
  for (const { item, facts } of input.threads) {
    const threadRef = item.thread.threadRef
    const owner = input.owns(item.projectRef)
    const waiting = facts.filter(entry => isThresholdFact(entry, owner))
    const now = facts.filter(entry => !isThresholdFact(entry, owner)).map(entry => entry.fact.sequence)
    if (now.length > 0) immediate.push([threadRef, ...now])
    const through = input.summarizedThrough.get(threadRef) ?? 0
    if (waiting.filter(entry => entry.fact.sequence > through).length >= INBOX_THRESHOLD_UPDATES) thresholdReached = true
    if (waiting.length > 0) summarizedThrough.set(threadRef, waiting.at(-1)!.fact.sequence)
    threads.push(Object.freeze({ threadRef, role: owner ? 'owner' : item.attention === undefined ? 'member' : 'follower',
      delivery: now.length > 0 ? 'immediate' : 'threshold', thresholdCount: waiting.length }))
  }
  for (const { projectRef, entries } of input.main) {
    if (entries.length > 0) immediate.push([projectRef, ...entries.map(entry => entry.sequence)])
  }
  const signature = immediate.length === 0 ? '' : JSON.stringify(immediate)
  const trigger = signature !== '' && signature !== input.covered ? 'immediate' : thresholdReached ? 'threshold' : undefined
  return Object.freeze({ trigger, signature, summarizedThrough, threads: Object.freeze(threads) })
}
