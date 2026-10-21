/**
 * The wake-swap decision: every gate that fails must resolve to a resume, and
 * only the fully-established case may replace a generation.
 */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  decideWakeRecycle,
  DEFAULT_WAKE_RECYCLE,
  wakeRecycleIdentity,
  type WakeRecycleConfig,
  type WakeRecycleFacts,
} from '../src/wake-recycle.ts'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60_000
const warm: WakeRecycleConfig = { enabled: true, idleMs: HOUR, minContextTokens: 128_000 }

function plan(facts: Partial<WakeRecycleFacts> = {}, config: WakeRecycleConfig = warm, nowMs = NOW): ReturnType<typeof decideWakeRecycle> {
  return decideWakeRecycle({
    config,
    facts: { hasPriorGeneration: true, lastActivityAtMs: NOW - HOUR - 60_000, contextTokens: 130_000, ...facts },
    nowMs,
  })
}

describe('the wake-swap decision', () => {
  it('resumes when the mechanism is switched off', () => {
    expect(plan({}, { ...warm, enabled: false })).toEqual({ action: 'resume', reason: 'disabled' })
  })

  it('resumes when there is no generation to replace', () => {
    expect(plan({ hasPriorGeneration: false })).toEqual({ action: 'resume', reason: 'no_prior_generation' })
  })

  it('resumes when the facts cannot be read', () => {
    // The conservative direction: unknown is never evidence of a cold cache.
    expect(plan({ lastActivityAtMs: null })).toEqual({ action: 'resume', reason: 'facts_unavailable' })
  })

  it('resumes while the prompt cache may still be warm', () => {
    expect(plan({ lastActivityAtMs: NOW - HOUR })).toEqual({ action: 'resume', reason: 'cache_possibly_warm' })
    expect(plan({ lastActivityAtMs: NOW - HOUR + 1 })).toEqual({ action: 'resume', reason: 'cache_possibly_warm' })
  })

  it('asks for a measurement once every cheap gate passed and the context is unknown', () => {
    expect(plan({ contextTokens: null })).toEqual({ action: 'measure-context' })
  })

  it('resumes a small context even after a long idle gap', () => {
    expect(plan({ contextTokens: 128_000 })).toEqual({ action: 'resume', reason: 'context_below_threshold' })
    expect(plan({ contextTokens: 40_000 })).toEqual({ action: 'resume', reason: 'context_below_threshold' })
  })

  it('recycles a cold, large generation and carries the facts it decided on', () => {
    expect(plan()).toEqual({
      action: 'recycle',
      reason: 'cold_gap_large_context',
      idleMs: HOUR + 60_000,
      contextTokens: 130_000,
      thresholds: warm,
    })
  })

  it('takes the thresholds from the live config rather than a constant', () => {
    const custom: WakeRecycleConfig = { enabled: true, idleMs: 5_000, minContextTokens: 10 }
    const decision = plan({ lastActivityAtMs: NOW - 6_000, contextTokens: 11 }, custom)
    expect(decision).toMatchObject({ action: 'recycle', idleMs: 6_000, contextTokens: 11, thresholds: custom })
  })

  it('defaults to the measured cache TTL and the cost-insensitive waterline', () => {
    expect(DEFAULT_WAKE_RECYCLE).toEqual({ enabled: true, idleMs: HOUR, minContextTokens: 128_000 })
  })

  it('derives a durable successor identity from the retired Session alone', () => {
    const identity = wakeRecycleIdentity(SessionId('session:one'))
    const again = wakeRecycleIdentity(SessionId('session:one'))
    // A crash between the commit and the activation must converge on the same
    // successor instead of minting a second one.
    expect(again).toEqual(identity)
    expect(identity.newSessionId).toMatch(/^agent-team-recycle-[0-9a-f]{64}$/)
    expect(identity.requestId).toBe(`agent-team:recycle:${String(identity.newSessionId).replace('agent-team-recycle-', '')}`)
    expect(wakeRecycleIdentity(SessionId('session:two'))).not.toEqual(identity)
  })
})
