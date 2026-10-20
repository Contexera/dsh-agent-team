/**
 * Whether an idle Member generation is swapped before anything is delivered
 * into it.
 *
 * Ported from raft's `decideWakeRecycle`. Past the provider's prompt-cache TTL
 * a resumed context is rewritten at cache-write prices, so a large enough
 * generation is cheaper to replace than to resume. Every uncertain fact
 * resolves to `resume`: a swap that should not have happened costs a Member
 * its working trail, while a resume that should have swapped costs only
 * tokens.
 * @module @contexera/dsh-agent-team/wake-recycle
 */

import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as SessionIdBrand } from '@deepseek-ai/dsh-session'

export interface WakeRecycleConfig {
  readonly enabled: boolean
  /** Measured prompt-cache TTL; past it a resume pays the full context again. */
  readonly idleMs: number
  /** Below this the context is cheap to resume, so continuity wins. */
  readonly minContextTokens: number
}

/** Schema defaults: the fleet-measured TTL and the cost-insensitive waterline. */
export const DEFAULT_WAKE_RECYCLE: WakeRecycleConfig = Object.freeze({
  enabled: true,
  idleMs: 60 * 60_000,
  minContextTokens: 128_000,
})

export interface WakeRecycleFacts {
  /** Whether a generation exists to swap away from. */
  readonly hasPriorGeneration: boolean
  /** Epoch ms of the generation's last durable activity; null when unreadable. */
  readonly lastActivityAtMs: number | null
  /** Measured context of that generation; null when it has not been priced yet. */
  readonly contextTokens: number | null
}

export type WakeRecycleResumeReason =
  | 'disabled'
  | 'no_prior_generation'
  | 'facts_unavailable'
  | 'cache_possibly_warm'
  | 'context_below_threshold'

export type WakeRecyclePlan =
  | { readonly action: 'resume'; readonly reason: WakeRecycleResumeReason }
  /**
   * Every cheap gate passed and only the context size is unknown: pricing it
   * needs a full replay, so the caller may only now spend that read.
   */
  | { readonly action: 'measure-context' }
  | {
      readonly action: 'recycle'
      readonly reason: 'cold_gap_large_context'
      readonly idleMs: number
      readonly contextTokens: number
      readonly thresholds: WakeRecycleConfig
    }

export interface WakeRecycleInput {
  readonly config: WakeRecycleConfig
  readonly facts: WakeRecycleFacts
  readonly nowMs: number
}

/** Pure gate ladder, in raft's order; the first failure is the reason. */
export function decideWakeRecycle(input: WakeRecycleInput): WakeRecyclePlan {
  const { config, facts } = input
  if (!config.enabled) return { action: 'resume', reason: 'disabled' }
  if (!facts.hasPriorGeneration) return { action: 'resume', reason: 'no_prior_generation' }
  if (facts.lastActivityAtMs === null) return { action: 'resume', reason: 'facts_unavailable' }
  const idleMs = input.nowMs - facts.lastActivityAtMs
  if (idleMs <= config.idleMs) return { action: 'resume', reason: 'cache_possibly_warm' }
  if (facts.contextTokens === null) return { action: 'measure-context' }
  if (facts.contextTokens <= config.minContextTokens) return { action: 'resume', reason: 'context_below_threshold' }
  return {
    action: 'recycle',
    reason: 'cold_gap_large_context',
    idleMs,
    contextTokens: facts.contextTokens,
    thresholds: config,
  }
}

/**
 * Durable identity of one wake swap. Derived from the retired Session alone:
 * the Host may crash between the commit and the activation, and the recovery
 * must converge on the same successor instead of minting a second one.
 */
export function wakeRecycleIdentity(previousSessionId: SessionId): { readonly newSessionId: SessionId; readonly requestId: string } {
  const digest = createHash('sha256').update(JSON.stringify(['wake-recycle', previousSessionId])).digest('hex')
  return { newSessionId: SessionIdBrand(`agent-team-recycle-${digest}`), requestId: `agent-team:recycle:${digest}` }
}
