/**
 * The private row written before a webhook answers 202. It stays while the
 * delivery owes execution, acceptance, or a replayable failure record.
 * @module @contexera/dsh-agent-team/subscription-admissions
 */

import type { AgentTeamProjectRef, AgentTeamSubscriptionRef, AgentTeamRequestId } from './types/entities.ts'
import type { SubscriptionCredential, SubscriptionEvent, SubscriptionScriptSnapshot } from './subscriptions.ts'

/**
 * The states a queued delivery passes through. `accepted` is not one: a delivery writes
 * itself out of this table, so a row that exists is always work still owed.
 */
export const SUBSCRIPTION_ADMISSION_STATES = ['queued', 'running', 'retrying', 'exhausted'] as const

export type SubscriptionAdmissionState = typeof SUBSCRIPTION_ADMISSION_STATES[number]

/** One delivery's admission: what arrived, which definition it pins, and how far it got. */
export type SubscriptionAdmissionRecord = {
  /**
   * The Host's own identity for this delivery, minted at admission and handed to the
   * script as `DSH_TEAM_DELIVERY_ID` through every retry and replay — never the
   * provider's id, since a provider redelivery is a new admission.
   */
  readonly admissionRef: string
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly projectRef: AgentTeamProjectRef
  /** The failed-delivery ref this admission becomes if its retries are spent. */
  readonly deliveryRef: string
  /** The definition as it stood when the request arrived; retries replay these bytes. */
  readonly receivedRevision: number
  readonly receivedScriptHash: string
  readonly script: SubscriptionScriptSnapshot
  readonly credentials: readonly SubscriptionCredential[]
  /** Lowercased whitelisted headers, exactly as the script will read them. */
  readonly headers: Readonly<Record<string, string>>
  /** The raw request body: a signature hashes these bytes, not a re-encoded payload. */
  readonly body: string
  readonly receivedAt: string
  /** Run attempts that already finished, failed or not. */
  readonly attempts: number
  /** Set while `retrying`: the instant the next attempt may start. */
  readonly nextAttemptAt?: string
  /** The batch a run validated while the unpublished queue had no room: kept here, so only the accept is retried. */
  readonly heldEvents?: readonly SubscriptionEvent[]
} & (
  | { readonly state: Exclude<SubscriptionAdmissionState, 'exhausted'>; readonly lastError?: string }
  | { readonly state: 'exhausted'; readonly lastError: string }
)

/** The request id one attempt's accept commits under, so a restart can ask the ledger what it already accepted. */
export function admissionAttemptRequestId(admissionRef: string, attempt: number): AgentTeamRequestId {
  return `${admissionRef}:attempt-${attempt}` as AgentTeamRequestId
}

/** One admission's storage key: its subscription, then the Host's own delivery identity. */
export function admissionKey(subscriptionRef: AgentTeamSubscriptionRef, admissionRef: string): string {
  return `${subscriptionRef}|${admissionRef}`
}

/** Keys of one subscription's admissions. A ref never contains the separator. */
export function admissionKeysOf(keys: Iterable<string>, subscriptionRef: AgentTeamSubscriptionRef): readonly string[] {
  const prefix = `${subscriptionRef}|`
  return [...keys].filter(key => key.startsWith(prefix))
}

/**
 * The failed-delivery ref one admission becomes: the provider's own delivery name when
 * it has one, so a redelivery replaces its record instead of piling up beside it, and
 * otherwise the admission's own ref, unique per admission.
 */
export function admissionDeliveryRef(admissionRef: string, headers: Readonly<Record<string, string>>): string {
  for (const [name, value] of Object.entries(headers)) {
    if (!/^x-.*-delivery$/.test(name)) continue
    const provider = value.trim()
    // The key format admits one value with no separator; anything else is a quirk we skip.
    if (provider !== '' && !provider.includes(':') && provider.length <= 200) return `delivery:${provider}`
  }
  return `delivery:${admissionRef.replace(/^admission:/, '')}`
}

/** The admission identity minted for one request: random, stable for its whole life. */
export function admissionRefFor(id: string): string {
  return `admission:${id}`
}

/** The admissions due now, oldest arrival first: a fair order that does not starve an early delivery. */
export function dueAdmissions(records: readonly SubscriptionAdmissionRecord[], nowMs: number): readonly SubscriptionAdmissionRecord[] {
  return [...records]
    .filter(record => record.state !== 'running'
      && (record.nextAttemptAt === undefined || Date.parse(record.nextAttemptAt) <= nowMs))
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt))
}
