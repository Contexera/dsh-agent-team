/**
 * The private state a Project subscription keeps outside the ledger: the
 * scheduling checkpoint, the last fifty runs, the failed deliveries waiting for
 * an owner, and the answers already given to a replay request. Deleting every
 * row changes no domain result — the ledger's accepted and published records
 * remain the authority for what happened.
 * @module @contexera/dsh-agent-team/subscription-store
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentTeamSubscriptionRef } from './types/entities.ts'
import type { SubscriptionCheckpoint } from './subscription-runtime.ts'
import { SUBSCRIPTION_RUN_CATEGORIES, type SubscriptionRunCategory } from './subscription-runner.ts'
import {
  SUBSCRIPTION_REPLAY_STATES,
  type SubscriptionDeliveryRecord, type SubscriptionReplayRecord, type SubscriptionReplayState, type SubscriptionRunRecord,
} from './subscription-runs.ts'

const subscriptionRefSchema = z.string().regex(/^subscription:[^:]+$/).transform(value => value as AgentTeamSubscriptionRef)

const checkpointSchema = z.object({
  subscriptionRef: subscriptionRefSchema,
  dueAt: z.number().int().nonnegative().optional(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastSuccessAt: z.string().datetime().optional(),
  publishWindowMinute: z.number().int().nonnegative().optional(),
  publishedInWindow: z.number().int().nonnegative(),
}).strict().transform((value): SubscriptionCheckpoint => Object.freeze(value as SubscriptionCheckpoint))

const scriptSchema = z.object({
  content: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
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
  runRef: z.string().regex(/^run:[^:]+$/),
  subscriptionRef: subscriptionRefSchema,
  projectRef: z.string().regex(/^project:[^:]+$/),
  trigger: z.union([z.literal('interval'), z.literal('webhook'), z.literal('test')]),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  category: runCategorySchema,
  reason: z.string().optional(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  eventCount: z.number().int().nonnegative(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
  subscriptionRevision: z.number().int().positive(),
  scriptHash: z.string().regex(/^[0-9a-f]{64}$/),
  deliveryRef: z.string().min(1).optional(),
  attempt: z.number().int().nonnegative(),
}).strict().transform((value): SubscriptionRunRecord => Object.freeze(value as SubscriptionRunRecord))

const deliverySchema = z.object({
  deliveryRef: z.string().regex(/^delivery:[^:]+$/),
  subscriptionRef: subscriptionRefSchema,
  projectRef: z.string().regex(/^project:[^:]+$/),
  receivedRevision: z.number().int().positive(),
  receivedScriptHash: z.string().regex(/^[0-9a-f]{64}$/),
  script: scriptSchema,
  credentials: z.array(credentialSchema).max(8),
  body: z.string(),
  receivedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  attempts: z.number().int().nonnegative(),
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
  projectRef: z.string().regex(/^project:[^:]+$/),
  requestId: z.string().min(1),
  deliveryRef: z.string().regex(/^delivery:[^:]+$/),
  version: z.union([z.literal('current'), z.literal('received')]),
  state: z.enum(SUBSCRIPTION_REPLAY_STATES as unknown as readonly [SubscriptionReplayState, ...SubscriptionReplayState[]])
    .optional().transform(value => value ?? 'settled'),
  runRef: z.string().regex(/^run:[^:]+$/).optional(),
  succeeded: z.boolean().optional(),
  eventCount: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
  expiresAt: z.string().datetime(),
}).strict().transform((value): SubscriptionReplayRecord => Object.freeze(value as SubscriptionReplayRecord))

export const subscriptionDomainSpec = defineDomain({
  name: 'agent_team_subscriptions',
  // Version 2 added the run history and the failed deliveries; version 3 adds
  // the replay index that makes a request id a whole idempotency key. An older
  // document only lacks tables, and the current schemas still accept its rows.
  version: 3,
  compatibleVersions: [1, 2],
  tables: {
    checkpoints: domainTable<AgentTeamSubscriptionRef, SubscriptionCheckpoint>(checkpointSchema),
    runs: domainTable<string, SubscriptionRunRecord>(runSchema),
    deliveries: domainTable<string, SubscriptionDeliveryRecord>(deliverySchema),
    replays: domainTable<string, SubscriptionReplayRecord>(replaySchema),
  },
})
