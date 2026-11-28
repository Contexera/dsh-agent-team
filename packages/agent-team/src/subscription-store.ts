/**
 * The ledger owns accepted and published events. This store owns scheduling
 * checkpoints, bounded run history, failed deliveries and replay receipts, and
 * admitted webhook requests that still owe work. Removing these rows can lose
 * accepted deliveries or change scheduling and recovery.
 * @module @contexera/dsh-agent-team/subscription-store
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentTeamSubscriptionRef } from './types/entities.ts'
import { SUBSCRIPTION_ADMISSION_STATES, type SubscriptionAdmissionRecord, type SubscriptionAdmissionState } from './subscription-admissions.ts'
import type { SubscriptionCheckpoint } from './subscription-runtime.ts'
import { SUBSCRIPTION_RUN_CATEGORIES, type SubscriptionRunCategory } from './subscription-runner.ts'
import {
  SUBSCRIPTION_REPLAY_STATES,
  type SubscriptionDeliveryRecord, type SubscriptionReplayRecord, type SubscriptionReplayState, type SubscriptionRunRecord,
} from './subscription-runs.ts'

const subscriptionRefSchema = z.string().regex(/^subscription:[^:]+$/).transform(value => value as AgentTeamSubscriptionRef)
const projectRefSchema = z.string().regex(/^project:[^:]+$/)
const runRefSchema = z.string().regex(/^run:[^:]+$/)
const deliveryRefSchema = z.string().regex(/^delivery:[^:]+$/)
const admissionRefSchema = z.string().regex(/^admission:[^:]+$/)
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const nonNegativeInt = z.number().int().nonnegative()

const checkpointSchema = z.object({
  subscriptionRef: subscriptionRefSchema,
  dueAt: nonNegativeInt.optional(),
  consecutiveFailures: nonNegativeInt,
  failureResumeSequence: nonNegativeInt.optional(),
  failureSuccessEpoch: nonNegativeInt.optional(),
  countedAdmissionRef: admissionRefSchema.optional(),
  lastSuccessAt: z.string().datetime().optional(),
  publishWindowMinute: nonNegativeInt.optional(),
  publishedInWindow: nonNegativeInt,
}).strict().transform((value): SubscriptionCheckpoint => Object.freeze(value as SubscriptionCheckpoint))

const scriptSchema = z.object({
  content: z.string(),
  sha256: sha256Schema,
  shell: z.union([z.literal('bash'), z.literal('pwsh')]),
}).strict()

const credentialSchema = z.object({
  ref: z.string().min(1),
  env: z.string().min(1),
}).strict()

const runCategorySchema = z.enum(SUBSCRIPTION_RUN_CATEGORIES as unknown as readonly [SubscriptionRunCategory, ...SubscriptionRunCategory[]])

/**
 * One run as it is read back: the summary every member sees and the tails only
 * an owner does. The tails are already capped at 8 KiB each by the recorder.
 */
const runSchema = z.object({
  runRef: runRefSchema,
  subscriptionRef: subscriptionRefSchema,
  projectRef: projectRefSchema,
  trigger: z.union([z.literal('interval'), z.literal('webhook'), z.literal('test')]),
  startedAt: z.string().datetime(),
  durationMs: nonNegativeInt,
  category: runCategorySchema,
  reason: z.string().optional(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  eventCount: nonNegativeInt,
  stdoutTail: z.string(),
  stderrTail: z.string(),
  subscriptionRevision: z.number().int().positive(),
  scriptHash: sha256Schema,
  deliveryRef: z.string().min(1).optional(),
  attempt: nonNegativeInt,
}).strict().transform((value): SubscriptionRunRecord => Object.freeze(value as SubscriptionRunRecord))

const deliverySchema = z.object({
  deliveryRef: deliveryRefSchema,
  /** The Host admission this delivery came from: the id a replay hands the script again. */
  admissionRef: z.string().min(1).optional(),
  subscriptionRef: subscriptionRefSchema,
  projectRef: projectRefSchema,
  receivedRevision: z.number().int().positive(),
  receivedScriptHash: sha256Schema,
  script: scriptSchema,
  credentials: z.array(credentialSchema).max(8),
  body: z.string(),
  receivedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  attempts: nonNegativeInt,
  lastError: z.string(),
  replay: z.object({
    requestId: z.string().min(1),
    runRef: z.string().min(1).optional(),
    succeeded: z.boolean(),
    reason: z.string().optional(),
  }).strict().optional(),
}).strict().transform((value): SubscriptionDeliveryRecord => Object.freeze(value as SubscriptionDeliveryRecord))

/**
 * One replay request as it is read back: which request asked for which delivery,
 * under which version, whether it is still running, and what it answered. It is
 * dropped with the delivery it names, because an answer about a delivery nobody
 * can see any more is not an answer. A row written before the state existed is a
 * settled answer — the only shape that was ever written.
 */
const replaySchema = z.object({
  subscriptionRef: subscriptionRefSchema,
  projectRef: projectRefSchema,
  requestId: z.string().min(1),
  deliveryRef: deliveryRefSchema,
  version: z.union([z.literal('current'), z.literal('received')]),
  state: z.enum(SUBSCRIPTION_REPLAY_STATES as unknown as readonly [SubscriptionReplayState, ...SubscriptionReplayState[]])
    .optional().transform(value => value ?? 'settled'),
  runRef: runRefSchema.optional(),
  succeeded: z.boolean().optional(),
  eventCount: nonNegativeInt.optional(),
  reason: z.string().optional(),
  expiresAt: z.string().datetime(),
}).strict().transform((value): SubscriptionReplayRecord => Object.freeze(value as SubscriptionReplayRecord))

/** One event a delivery kept for later acceptance: shape only, since the run already bounded its lengths. */
const heldEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: z.string().optional(),
  detail: z.string().optional(),
}).strict()

/**
 * One queued webhook delivery as it is read back. The header map is the narrowed
 * one the entry computed — lowercased, whitelisted, size-checked — so a row can
 * never carry a credential header a later version might learn to forward.
 */
const admissionSchema = z.object({
  admissionRef: admissionRefSchema,
  subscriptionRef: subscriptionRefSchema,
  projectRef: projectRefSchema,
  deliveryRef: deliveryRefSchema,
  receivedRevision: z.number().int().positive(),
  receivedScriptHash: sha256Schema,
  script: scriptSchema,
  credentials: z.array(credentialSchema).max(8),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  receivedAt: z.string().datetime(),
  attempts: nonNegativeInt,
  state: z.enum(SUBSCRIPTION_ADMISSION_STATES as unknown as readonly [SubscriptionAdmissionState, ...SubscriptionAdmissionState[]]),
  nextAttemptAt: z.string().datetime().optional(),
  lastError: z.string().optional(),
  heldEvents: z.array(heldEventSchema).optional(),
  failureStreak: z.object({
    resumeSequence: nonNegativeInt,
    successEpoch: nonNegativeInt,
  }).strict().optional(),
}).strict().refine(value => value.state === 'exhausted'
  ? value.lastError !== undefined && value.nextAttemptAt === undefined && value.heldEvents === undefined
  : value.failureStreak === undefined)
  .transform((value): SubscriptionAdmissionRecord => Object.freeze(value as unknown as SubscriptionAdmissionRecord))

export const subscriptionDomainSpec = defineDomain({
  name: 'agent_team_subscriptions',
  // Released v4 readers reject exhausted admissions. Older rows remain valid
  // in a mixed store; they do not need a rewrite before the first v5 write.
  version: 5,
  compatibleVersions: [1, 2, 3, 4],
  tables: {
    checkpoints: domainTable<AgentTeamSubscriptionRef, SubscriptionCheckpoint>(checkpointSchema),
    runs: domainTable<string, SubscriptionRunRecord>(runSchema),
    deliveries: domainTable<string, SubscriptionDeliveryRecord>(deliverySchema),
    replays: domainTable<string, SubscriptionReplayRecord>(replaySchema),
    admissions: domainTable<string, SubscriptionAdmissionRecord>(admissionSchema),
  },
})
