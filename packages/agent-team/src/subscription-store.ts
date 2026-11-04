/**
 * The private scheduling state one timer subscription keeps outside the
 * ledger: the next due instant, the failure count, and the publication budget
 * window. Deleting every row changes no domain result — the ledger's accepted
 * and published records remain the authority for what happened.
 * @module @contexera/dsh-agent-team/subscription-store
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { AgentTeamSubscriptionRef } from './types/entities.ts'
import type { SubscriptionCheckpoint } from './subscription-runtime.ts'

const subscriptionRefSchema = z.string().regex(/^subscription:[^:]+$/).transform(value => value as AgentTeamSubscriptionRef)

const checkpointSchema = z.object({
  subscriptionRef: subscriptionRefSchema,
  dueAt: z.number().int().nonnegative().optional(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastSuccessAt: z.string().datetime().optional(),
  publishWindowMinute: z.number().int().nonnegative().optional(),
  publishedInWindow: z.number().int().nonnegative(),
}).strict().transform((value): SubscriptionCheckpoint => Object.freeze(value as SubscriptionCheckpoint))

export const subscriptionDomainSpec = defineDomain({
  name: 'agent_team_subscriptions',
  version: 1,
  tables: {
    checkpoints: domainTable<AgentTeamSubscriptionRef, SubscriptionCheckpoint>(checkpointSchema),
  },
})
