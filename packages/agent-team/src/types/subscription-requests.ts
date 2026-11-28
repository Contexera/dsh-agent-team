/** Remote contracts for subscriptions: management, logs, deliveries, replay, trials and webhook intake. */
import type { WorkspaceId } from "@deepseek-ai/dsh-workspace"
import type {
  AgentTeamMemberId,
  AgentTeamProjectRef,
  AgentTeamRequestId,
  AgentTeamSubscription,
  AgentTeamSubscriptionActivity,
  AgentTeamSubscriptionEventAccepted,
  AgentTeamSubscriptionEventPublished,
  AgentTeamSubscriptionRef,
} from "./entities.ts"
import type { AgentTeamOperationReceipt } from "./operation-receipt.ts"

/** One subscription write answered: the state it committed and the Main stream line that announced it. */
export interface AgentTeamSubscriptionChangeResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly subscription: AgentTeamSubscription
  readonly activity: AgentTeamSubscriptionActivity
  /**
   * The webhook token this write armed, present exactly once: the ledger keeps
   * only its hash, so a resolved retry of the same request id answers without
   * it and the caller must say the address cannot be shown again.
   */
  readonly webhookToken?: string | undefined
}

/** One accepted batch of events, already durable and waiting only for publishing. */
export interface AgentTeamSubscriptionAcceptResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly accepted: readonly AgentTeamSubscriptionEventAccepted[]
}

/** One published event, as the Main stream now holds it. */
export interface AgentTeamSubscriptionPublishResult {
  readonly receipt: AgentTeamOperationReceipt
  readonly published: AgentTeamSubscriptionEventPublished
}

/** Where a create or update takes its script from: the Agent's own file, or content a page pasted. */
export type AgentTeamSubscriptionScriptSource =
  | { readonly scriptPath: string }
  | { readonly scriptContent: string }

/**
 * One recorded run's summary. Every Project member reads this much; the tails
 * and the failure reason stay with an owner.
 */
export interface AgentTeamSubscriptionRunSummary {
  readonly runRef: string
  readonly trigger: 'interval' | 'webhook' | 'test'
  /** ISO instant the script started. */
  readonly startedAt: string
  readonly durationMs: number
  /** The structured outcome: `accepted` and `empty` succeeded, `verified` is a passing trial. */
  readonly category: import('../subscription-runner.ts').SubscriptionRunCategory
  readonly succeeded: boolean
  readonly eventCount: number
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly subscriptionRevision: number
}

/**
 * One stored subscription as the Project page lists it: its backlog, what the
 * ledger counts as events, and the timestamps a reader scans for.
 */
export type AgentTeamSubscriptionMetadata = Omit<AgentTeamSubscription, 'script' | 'credentials' | 'webhook'>

export interface AgentTeamSubscriptionListEntry<TSubscription = AgentTeamSubscription> {
  readonly subscription: TSubscription
  readonly unpublished: number
  /** Events this subscription's runs had accepted into the ledger, published or waiting. */
  readonly eventCount: number
  /** When the newest accepted event was accepted; absent before the first. */
  readonly lastEventAt?: string | undefined
  /** The newest recorded run, trial runs included; absent before the first. */
  readonly lastRun?: AgentTeamSubscriptionRunSummary | undefined
  /** The persisted instant the Host will next consider a timer run; absent while it waits for boot scheduling. */
  readonly nextRunAt?: string | undefined
}

export interface AgentTeamSubscriptionListRequest {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
}

export interface AgentTeamSubscriptionListResult<TSubscription = AgentTeamSubscription> {
  readonly entries: readonly AgentTeamSubscriptionListEntry<TSubscription>[]
}

/** One recorded run as a log read returns it: the summary everyone sees, the tails only an owner does. */
export interface AgentTeamSubscriptionLogEntry extends AgentTeamSubscriptionRunSummary {
  /** Owner-only: why a failed run failed, in the words the run itself used. */
  readonly reason?: string | undefined
  /** Owner-only: the last 8 KiB of each stream, exactly what a refusal would show. */
  readonly stdoutTail?: string | undefined
  readonly stderrTail?: string | undefined
  readonly scriptHash?: string | undefined
  readonly attempt?: number | undefined
  readonly deliveryRef?: string | undefined
}

export interface AgentTeamSubscriptionLogsRequest {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly subscriptionRef: AgentTeamSubscriptionRef
  /** How many of the newest runs to return, at most the fifty the Host keeps. */
  readonly limit?: number | undefined
}

export interface AgentTeamSubscriptionLogsResult {
  readonly subscription: AgentTeamSubscription
  /** Newest first. */
  readonly runs: readonly AgentTeamSubscriptionLogEntry[]
}

/** One delivery whose retries are spent, as an owner reads it in the failed list. */
export interface AgentTeamSubscriptionDeliveryEntry {
  readonly deliveryRef: string
  readonly receivedRevision: number
  readonly receivedScriptHash: string
  readonly receivedAt: string
  readonly expiresAt: string
  readonly attempts: number
  readonly lastError: string
}

export interface AgentTeamSubscriptionDeliveriesRequest {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly subscriptionRef: AgentTeamSubscriptionRef
}

export interface AgentTeamSubscriptionDeliveriesResult {
  readonly deliveries: readonly AgentTeamSubscriptionDeliveryEntry[]
}

/**
 * Which definition a replay runs: `current` (the default) so a fixed script can
 * handle an old request, or `received`, the version the delivery arrived under.
 */
export type AgentTeamSubscriptionReplayVersion = 'current' | 'received'

export interface AgentTeamSubscriptionReplayRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly deliveryRef: string
  readonly version?: AgentTeamSubscriptionReplayVersion | undefined
}

export interface AgentTeamSubscriptionReplayResult {
  readonly kind: 'replayed' | 'replay-failed'
  readonly delivery: AgentTeamSubscriptionDeliveryEntry
  /** The run this replay produced, absent when the subscription was already gone. */
  readonly runRef?: string | undefined
  /** Events this replay had accepted into the ledger; 0 when it printed nothing new or was refused. */
  readonly eventCount?: number | undefined
  readonly reason?: string | undefined
  readonly stdoutTail?: string | undefined
  readonly stderrTail?: string | undefined
}

/** Why a trial run refused a script, with enough of each stream to fix it. */
export interface AgentTeamSubscriptionTrialFailure {
  readonly reason: string
  readonly stdoutTail: string
  readonly stderrTail: string
}

/**
 * Which history a brand-new subscription ignores. `current-output` records the
 * ids the trial run printed as the deduplication baseline, so the first live
 * run does not republish what the script already found; `ignore-history`
 * starts empty, and the first live run publishes everything it sees.
 */
export type AgentTeamSubscriptionBaselineChoice = 'current-output' | 'ignore-history'

/** The script source form; content bytes stay only in the stored script snapshot. */
export type AgentTeamSubscriptionRequestScript =
  | { readonly kind: 'content' }
  | { readonly kind: 'path'; readonly path: string }

/** The request fields whose canonical values cannot be recovered from the stored subscription alone. */
export interface AgentTeamSubscriptionRequestIntent {
  readonly intervalMinutes?: number | undefined
  readonly webhook?: boolean | undefined
  readonly scriptSource: AgentTeamSubscriptionRequestScript
}

export interface AgentTeamCreateSubscriptionRequestIntent extends AgentTeamSubscriptionRequestIntent {
  readonly baseline: AgentTeamSubscriptionBaselineChoice
}

export interface AgentTeamCreateSubscriptionRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly name: string
  /** Timer interval; omitted for a webhook-only subscription. */
  readonly intervalMinutes?: number | undefined
  /** Enable the webhook trigger; the Host refuses when no public address is configured. */
  readonly webhook?: boolean | undefined
  readonly script: AgentTeamSubscriptionScriptSource
  readonly credentials?: readonly import('../subscriptions.ts').SubscriptionCredential[] | undefined
  /** Who its events are for; omitted means the Creating Member alone. Every id must be a current Project member. */
  readonly notify?: readonly AgentTeamMemberId[] | undefined
  readonly baseline?: AgentTeamSubscriptionBaselineChoice | undefined
}

/** The four editable parts, replaced whole; the revision moves by one. */
export interface AgentTeamUpdateSubscriptionRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly expectedRevision: number
  readonly name: string
  readonly intervalMinutes?: number | undefined
  /** Enabling mints and returns one address; keeping it enabled keeps that address. */
  readonly webhook?: boolean | undefined
  readonly script: AgentTeamSubscriptionScriptSource
  readonly credentials?: readonly import('../subscriptions.ts').SubscriptionCredential[] | undefined
  /** Who its events are for; omitted keeps the stored set, and `[]` clears it to the timeline alone. */
  readonly notify?: readonly AgentTeamMemberId[] | undefined
}

export interface AgentTeamTestSubscriptionRequest {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly subscriptionRef: AgentTeamSubscriptionRef
}

/**
 * A form's own definition, tried before anything is stored. An edit names the
 * subscription and the revision it started from, so the trial runs against the
 * same deduplication baseline the save would keep.
 */
export interface AgentTeamSubscriptionDraftTrialRequest {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  /** The stored subscription an edit starts from; absent for a create draft. */
  readonly subscriptionRef?: AgentTeamSubscriptionRef | undefined
  /** Required with `subscriptionRef`: the revision the form was filled from. */
  readonly expectedRevision?: number | undefined
  readonly name: string
  /** A draft keeps one trigger at least: a timer that runs every N minutes, or a webhook, or both. */
  readonly intervalMinutes?: number | undefined
  readonly webhook?: boolean | undefined
  readonly scriptContent: string
  readonly credentials?: readonly import('../subscriptions.ts').SubscriptionCredential[] | undefined
}

/** A draft trial's verdict plus the identity the Client binds its form to. */
export type AgentTeamSubscriptionDraftTrialResult = AgentTeamSubscriptionTrialResult & {
  /** The snapshot this trial executed: a form saved with other bytes was not tested. */
  readonly scriptHash: string
  /** The revision the trial ran under: the prior revision on an edit, 1 on a create draft. */
  readonly revision: number
}

export interface AgentTeamSubscriptionStateRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly expectedRevision: number
}

/** Append-only re-baselining: the ids to ignore from now on. */
export interface AgentTeamBaselineSubscriptionRequest {
  readonly requestId: AgentTeamRequestId
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly subscriptionRef: AgentTeamSubscriptionRef
  readonly ids: readonly string[]
}

/** One write that a trial run refused before it could commit. */
export type AgentTeamSubscriptionWriteResult =
  | { readonly kind: 'changed'; readonly subscription: AgentTeamSubscription; readonly activity: AgentTeamSubscriptionActivity
    /**
     * The complete webhook address, present only on the call that armed it —
     * a create, an edit that enables the trigger, or a reset. A resolved retry
     * of the same request id answers without it: the ledger keeps only the
     * token's hash, so the caller must report that the address is gone.
     */
    readonly webhookAddress?: string | undefined
    /** On a resolved retry of a create or reset that armed the address: it was shown once and cannot be fetched again. */
    readonly webhookAddressGone?: true | undefined }
  | { readonly kind: 'trial-failed'; readonly failure: AgentTeamSubscriptionTrialFailure }

export type AgentTeamSubscriptionTrialResult =
  | { readonly kind: 'tested'; readonly events: readonly import('../subscriptions.ts').SubscriptionEvent[]; readonly stdoutTail: string; readonly stderrTail: string }
  | { readonly kind: 'trial-failed'; readonly failure: AgentTeamSubscriptionTrialFailure }

/** One public webhook request as the entry proves it: a resolved token, forwarded headers, the raw body. */
export interface AgentTeamWebhookIntakeRequest {
  readonly token: string
  /** Lowercased, already whitelisted, each value within its limit. */
  readonly headers: Readonly<Record<string, string>>
  /** The raw request body, verbatim: a signature hashes these bytes. */
  readonly body: string
}

/**
 * What one intake decided. Each variant is a row of the contract's status
 * table; the entry maps it to a status code and never invents a reason.
 */
export type AgentTeamWebhookIntakeResult =
  | { readonly kind: 'queued'; readonly admissionRef: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'queue-full'; readonly retryAfterSeconds: number }

export interface AgentTeamSubscriptionBaselineResult {
  readonly kind: 'baselined'
  readonly subscription: AgentTeamSubscription
  readonly added: readonly string[]
}
