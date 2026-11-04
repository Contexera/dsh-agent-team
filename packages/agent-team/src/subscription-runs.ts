/**
 * Run history and failed deliveries: the records an owner reads back after a
 * run, and the queue entry a delivery becomes when its retries are spent.
 *
 * Neither is a Team fact. Both live in the private subscription domain, are
 * evicted on their own schedule, and are dropped with the subscription that
 * owns them; the ledger's accepted and published events stay the only record of
 * what a subscription really delivered.
 * @module @contexera/dsh-agent-team/subscription-runs
 */

import { randomUUID } from 'node:crypto'
import { failureTail, runSucceeded, type SubscriptionRunCategory, type SubscriptionRunReport } from './subscription-runner.ts'
import type { AgentTeamSubscription, AgentTeamSubscriptionRef } from './types/entities.ts'
import type { AgentTeamSubscriptionDeliveryEntry, AgentTeamSubscriptionReplayVersion } from './types/requests-results.ts'

/** What started one run. Only `interval` and `webhook` count towards the failure pause. */
export type SubscriptionRunTrigger = 'interval' | 'webhook' | 'test'

/** How many runs one subscription keeps. Older records are evicted, newest first. */
export const SUBSCRIPTION_RUN_HISTORY_LIMIT = 50

/** How many failed deliveries one subscription keeps, and how long each survives. */
export const SUBSCRIPTION_DELIVERY_LIMIT = 10
export const SUBSCRIPTION_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000

/** The backoff a delivery takes between attempts: 1, 5, then 30 minutes, three attempts in total. */
export const SUBSCRIPTION_DELIVERY_RETRY_MS: readonly number[] = Object.freeze([60_000, 300_000, 1_800_000])
export const SUBSCRIPTION_DELIVERY_ATTEMPTS = SUBSCRIPTION_DELIVERY_RETRY_MS.length

/** One recorded run: what the tool and the Remote answer, minus what the caller may not see. */
export interface SubscriptionRunRecord {
  readonly runRef: string
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly projectRef: string
  readonly trigger: SubscriptionRunTrigger
  /** ISO instant the script started. */
  readonly startedAt: string
  readonly durationMs: number
  readonly category: SubscriptionRunCategory
  /** The owner-facing sentence a failure explains itself with. */
  readonly reason?: string | undefined
  readonly exitCode: number | null
  readonly timedOut: boolean
  /** Events this run had accepted into the ledger; a trial or a refused batch is 0. */
  readonly eventCount: number
  /** The last 8 KiB of each stream; the part that explains a failure. */
  readonly stdoutTail: string
  readonly stderrTail: string
  readonly subscriptionRevision: number
  readonly scriptHash: string
  readonly deliveryRef?: string | undefined
  readonly attempt: number
}

/**
 * The storage key of one run: subscription, start instant, run id. The instant
 * is zero-padded so key order is start order, which is what eviction reads.
 */
export function subscriptionRunKey(record: Pick<SubscriptionRunRecord, 'subscriptionRef' | 'startedAt' | 'runRef'>): string {
  const started = Date.parse(record.startedAt)
  return `${record.subscriptionRef}|${String(started).padStart(15, '0')}|${record.runRef}`
}

/** Keys of one subscription's runs, oldest first. */
export function subscriptionRunKeysOf(keys: Iterable<string>, subscriptionRef: AgentTeamSubscriptionRef): readonly string[] {
  const prefix = `${subscriptionRef}|`
  return [...keys].filter(key => key.startsWith(prefix)).sort()
}

/** The keys an insert has to evict so that at most `limit` runs stay, oldest first. */
export function evictedRunKeys(keys: readonly string[], limit: number = SUBSCRIPTION_RUN_HISTORY_LIMIT): readonly string[] {
  return keys.length <= limit ? [] : [...keys].sort().slice(0, keys.length - limit)
}

/** The tail a record keeps: the same 8 KiB cap a refusal shows. */
export function runTail(text: string): string {
  return failureTail(text)
}

/** Everything the Host knows about one finished run when it records it. */
export interface SubscriptionRunInput {
  readonly subscription: AgentTeamSubscription
  readonly trigger: SubscriptionRunTrigger
  /** The instant the script started, in epoch milliseconds. */
  readonly startedAt: number
  readonly durationMs: number
  readonly category: SubscriptionRunCategory
  readonly report: SubscriptionRunReport
  /**
   * How many events this run had accepted into the ledger. Never the count the
   * script printed: a trial publishes nothing, an over-ceiling batch is refused
   * whole, and a repeated id was already known.
   */
  readonly eventCount: number
  readonly delivery?: { readonly deliveryRef: string; readonly attempt: number } | undefined
}

/** One run as it is stored: the summary plus the capped tails and the identity that explains it. */
export function runRecordOf(input: SubscriptionRunInput): SubscriptionRunRecord {
  const { subscription, report } = input
  return Object.freeze({
    runRef: `run:${randomUUID()}`,
    subscriptionRef: subscription.subscriptionRef,
    projectRef: subscription.projectRef,
    trigger: input.trigger,
    startedAt: new Date(input.startedAt).toISOString(),
    durationMs: input.durationMs,
    category: input.category,
    ...(report.reason === undefined ? {} : { reason: report.reason }),
    exitCode: report.exitCode,
    timedOut: report.timedOut,
    eventCount: input.eventCount,
    stdoutTail: runTail(report.stdout),
    stderrTail: runTail(report.stderr),
    subscriptionRevision: subscription.revision,
    scriptHash: subscription.script.sha256,
    ...(input.delivery === undefined ? {} : { deliveryRef: input.delivery.deliveryRef }),
    attempt: input.delivery?.attempt ?? 0,
  })
}

/** The summary every Project member may read: what happened, never what it printed. */
export interface SubscriptionRunSummary {
  readonly runRef: string
  readonly trigger: SubscriptionRunTrigger
  readonly startedAt: string
  readonly durationMs: number
  readonly category: SubscriptionRunCategory
  readonly succeeded: boolean
  readonly eventCount: number
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly subscriptionRevision: number
}

export function runSummaryOf(record: SubscriptionRunRecord): SubscriptionRunSummary {
  return Object.freeze({ runRef: record.runRef, trigger: record.trigger, startedAt: record.startedAt,
    durationMs: record.durationMs, category: record.category, succeeded: runSucceeded(record.category),
    eventCount: record.eventCount, exitCode: record.exitCode, timedOut: record.timedOut,
    subscriptionRevision: record.subscriptionRevision })
}

/**
 * A delivery whose retries are spent. It keeps the script it was received under,
 * so an owner can replay exactly the bytes that failed, and the body the script
 * reads on stdin, so the replay needs no other copy.
 */
export interface SubscriptionDeliveryRecord {
  readonly deliveryRef: string
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly projectRef: string
  /** The subscription as it stood when the delivery arrived: the version to replay. */
  readonly receivedRevision: number
  readonly receivedScriptHash: string
  readonly script: AgentTeamSubscription['script']
  readonly credentials: AgentTeamSubscription['credentials']
  /** The stdin envelope the replayed run reads. */
  readonly body: string
  readonly receivedAt: string
  readonly expiresAt: string
  readonly attempts: number
  readonly lastError: string
  /** The last replay's request id and answer, so a retried call never runs the script twice. */
  /**
   * The request that replayed this delivery, once it delivered. `runRef` is absent
   * when the answer was recovered from the ledger after its run record was lost:
   * the marker's fact is the delivery, not the run that produced it.
   */
  readonly replay?: {
    readonly requestId: string
    readonly runRef?: string | undefined
    readonly succeeded: boolean
    readonly reason?: string | undefined
  } | undefined
}

/** What an ingress proves about one delivery when its automatic retries are spent. */
export interface SubscriptionDeliveryInput {
  readonly deliveryRef: string
  /** The subscription as it stood when the delivery arrived: the version a pinned replay runs. */
  readonly receivedRevision: number
  /** The instant it arrived, in epoch milliseconds. */
  readonly receivedAt: number
  readonly script: AgentTeamSubscription['script']
  readonly credentials: AgentTeamSubscription['credentials']
  /** The stdin envelope the script reads, kept so a replay needs no other copy. */
  readonly body: string
  readonly attempts: number
  readonly lastError: string
}

/**
 * One delivery as it is stored. A retried admission of the same `deliveryRef`
 * replaces the earlier attempt count and error but keeps the received version
 * and the first arrival instant, so a pinned replay always runs what arrived.
 */
export function deliveryRecordOf(subscription: AgentTeamSubscription, input: SubscriptionDeliveryInput,
  earlier: SubscriptionDeliveryRecord | undefined): SubscriptionDeliveryRecord {
  const receivedAt = earlier?.receivedAt ?? new Date(input.receivedAt).toISOString()
  return Object.freeze({
    deliveryRef: input.deliveryRef,
    subscriptionRef: subscription.subscriptionRef,
    projectRef: subscription.projectRef,
    receivedRevision: earlier?.receivedRevision ?? input.receivedRevision,
    receivedScriptHash: earlier?.receivedScriptHash ?? input.script.sha256,
    script: earlier?.script ?? input.script,
    credentials: earlier?.credentials ?? input.credentials,
    body: earlier?.body ?? input.body,
    receivedAt,
    expiresAt: earlier?.expiresAt ?? deliveryExpiresAt(input.receivedAt),
    attempts: input.attempts,
    lastError: input.lastError,
    ...(earlier?.replay === undefined ? {} : { replay: earlier.replay }),
  })
}

/** The storage key of one delivery: its own subscription, then the ingress-issued ref. */
export function deliveryKey(subscriptionRef: AgentTeamSubscriptionRef, deliveryRef: string): string {
  return `${subscriptionRef}|${deliveryRef}`
}

/** Keys of one subscription's deliveries, newest last. */
export function deliveryKeysOf(keys: Iterable<string>, subscriptionRef: AgentTeamSubscriptionRef): readonly string[] {
  const prefix = `${subscriptionRef}|`
  return [...keys].filter(key => key.startsWith(prefix))
}

/**
 * The deliveries still worth an owner's attention: expired ones are gone, and a
 * delivery whose replay succeeded was handled even though its entry stays —
 * that entry is what makes a repeated replay idempotent. `replayed` names the
 * deliveries that delivered by whatever record survived, because the tombstone
 * on the delivery is only one of the records a replay leaves.
 */
export function failedDeliveries(records: readonly SubscriptionDeliveryRecord[], now: number,
  replayed: ReadonlySet<string> = new Set()): readonly SubscriptionDeliveryRecord[] {
  return [...records]
    .filter(record => Date.parse(record.expiresAt) > now && record.replay?.succeeded !== true && !replayed.has(record.deliveryRef))
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
}

/** The deliveries to drop so that at most `limit` stay: the longest-received first. */
export function evictedDeliveries(records: readonly SubscriptionDeliveryRecord[],
  limit: number = SUBSCRIPTION_DELIVERY_LIMIT): readonly SubscriptionDeliveryRecord[] {
  const byArrival = [...records].sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
  return byArrival.length <= limit ? [] : byArrival.slice(0, byArrival.length - limit)
}

/** One delivery as an owner reads it: identity, the error that spent its retries, and its expiry. */
export function deliveryEntryOf(record: SubscriptionDeliveryRecord): AgentTeamSubscriptionDeliveryEntry {
  return Object.freeze({
    deliveryRef: record.deliveryRef,
    receivedRevision: record.receivedRevision,
    receivedScriptHash: record.receivedScriptHash,
    receivedAt: record.receivedAt,
    expiresAt: record.expiresAt,
    attempts: record.attempts,
    lastError: record.lastError,
  })
}

/** The next attempt's delay, or `undefined` once the delivery has used its attempts. */
export function deliveryRetryDelayMs(attempts: number): number | undefined {
  return SUBSCRIPTION_DELIVERY_RETRY_MS[attempts]
}

/** The instant a delivery record expires; it is dropped with the subscription and after this. */
export function deliveryExpiresAt(receivedAt: number): string {
  return new Date(receivedAt + SUBSCRIPTION_DELIVERY_RETENTION_MS).toISOString()
}

/**
 * One requested replay, indexed by the request rather than by the delivery.
 *
 * The delivery row keeps the same answer for its own retention, but a delivery
 * row can only compare the request id of one delivery: the same id aimed at a
 * second delivery would run a second, different intent. This record is the whole
 * key — the request, the delivery it named, and the version it chose — so a
 * repeated call answers once, a concurrent one is refused, and reusing an id for
 * another intent collides instead of executing.
 */
/** Whether a request may still be executing, or its answer is recorded. */
export const SUBSCRIPTION_REPLAY_STATES = ['running', 'settled'] as const

export type SubscriptionReplayState = (typeof SUBSCRIPTION_REPLAY_STATES)[number]

/**
 * One replay request: what it named, and what it answered.
 *
 * The record exists twice in its life. It is written *before* the script runs,
 * carrying the delivery and version the request named — that is what makes one
 * request id one intent even when no answer survives — and it is settled after
 * the run with the outcome. A request still `running` is one whose answer never
 * landed: a retry cannot tell it from an attempt that died, so it is told what
 * happened instead of running the script again.
 */
export interface SubscriptionReplayRecord {
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly projectRef: string
  /** The replay request this record belongs to; with the subscription, its key. */
  readonly requestId: string
  readonly deliveryRef: string
  readonly version: AgentTeamSubscriptionReplayVersion
  readonly state: SubscriptionReplayState
  /** The run that answered it, when the answer has one. */
  readonly runRef?: string | undefined
  readonly succeeded?: boolean | undefined
  /** Events the replay had accepted, so a retried call reads the same answer. */
  readonly eventCount?: number | undefined
  readonly reason?: string | undefined
  /** The delivery's own expiry: an answer nobody could act on any more is not worth keeping. */
  readonly expiresAt: string
}

/** The storage key of one replay: its own subscription, then the request that asked for it. */
export function replayKey(subscriptionRef: AgentTeamSubscriptionRef, requestId: string): string {
  return `${subscriptionRef}|${requestId}`
}

/** Keys of one subscription's replays. */
export function replayKeysOf(keys: Iterable<string>, subscriptionRef: AgentTeamSubscriptionRef): readonly string[] {
  const prefix = `${subscriptionRef}|`
  return [...keys].filter(key => key.startsWith(prefix))
}
