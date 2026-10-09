import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { classifyRecoverableError, RecoveryCoordinator, RECOVERY_DELAY_MS, RECOVERY_MAX_CONSECUTIVE_ERRORS, type RecoveryFact } from '../src/recovery.ts'
import type { AgentTeamMemberId } from '../src/types.ts'

describe('recoverable error classification', () => {
  it.each([
    ['fetch failed', 'transient network'],
    ['request to https://example.com failed: ECONNRESET', 'transient network'],
    ['ETIMEDOUT after 30000ms', 'transient network'],
    ['upstream socket hang up', 'transient network'],
    ['HTTP 429 too many requests', 'rate limiting'],
    ['provider rate limit exceeded', 'rate limiting'],
    ['gateway returned 503 service unavailable', 'rate limiting'],
    ['model is overloaded, try again', 'rate limiting'],
  ])('classifies %j as %j', (message, kind) => {
    expect(classifyRecoverableError(message)).toBe(kind)
  })

  it.each([
    ['prompt is too long: context length exceeded'],
    ['401 unauthorized: bad api key'],
    ['403 forbidden for this model'],
    ['TypeError: cannot read properties of undefined'],
  ])('leaves %j manual (no auto recovery)', message => {
    expect(classifyRecoverableError(message)).toBeUndefined()
  })

  it('reads the structured Harness failure before any message text', () => {
    expect(classifyRecoverableError(new LlmError('DeepSeek Messages transport failed', 'TRANSPORT'))).toBe('transient network')
    expect(classifyRecoverableError(new LlmError('DeepSeek Messages stream idle timeout', 'TIMEOUT'))).toBe('transient network')
    expect(classifyRecoverableError(new LlmError('DeepSeek rate limited', 'RATE_LIMIT', { status: 429 }))).toBe('rate limiting')
    expect(classifyRecoverableError(new LlmError('DeepSeek Messages request failed', 'SERVER', { status: 503 }))).toBe('rate limiting')
  })

  it('trusts a structurally carried code even without the Harness class identity', () => {
    // A cross-package copy preserves own data but not `instanceof`; the code
    // field alone must classify.
    expect(classifyRecoverableError({ message: 'slow down please', code: 'RATE_LIMIT', failure: { message: 'slow down please', code: 'RATE_LIMIT' } })).toBe('rate limiting')
    expect(classifyRecoverableError({ message: 'connection reset by peer', failure: { message: 'connection reset by peer', code: 'TRANSPORT' } })).toBe('transient network')
  })

  it('lets a structured terminal code outweigh misleading message text', () => {
    expect(classifyRecoverableError(new LlmError('upstream answered 429 while settling quota', 'QUOTA', { status: 402 }))).toBeUndefined()
    expect(classifyRecoverableError(new LlmError('context length exceeded after the provider mentioned rate limits', 'CONTEXT_WINDOW_EXCEEDED'))).toBeUndefined()
    expect(classifyRecoverableError(new LlmError('credential rejected; 503 was the gateway page', 'AUTH'))).toBeUndefined()
  })

  it('falls back to narrow message matching only when no structured code exists', () => {
    expect(classifyRecoverableError(new Error('fetch failed'))).toBe('transient network')
    expect(classifyRecoverableError(new Error('gateway returned 503 service unavailable'))).toBe('rate limiting')
    expect(classifyRecoverableError(new Error('cannot read properties of undefined'))).toBeUndefined()
    expect(classifyRecoverableError({ message: 'unknown failure shape' })).toBeUndefined()
  })
})

describe('RecoveryCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const memberId = 'member:builder' as AgentTeamMemberId

  function harness(options?: { readonly wake?: (memberId: AgentTeamMemberId) => void; readonly maxConsecutiveErrors?: number }) {
    const wakeups: AgentTeamMemberId[] = []
    const facts: RecoveryFact[] = []
    const coordinator = new RecoveryCoordinator({
      wake: id => { wakeups.push(id); options?.wake?.(id) },
      report: fact => { facts.push(fact) },
      ...(options?.maxConsecutiveErrors === undefined ? {} : { maxConsecutiveErrors: options.maxConsecutiveErrors }),
    })
    return { coordinator, wakeups, facts }
  }

  it('wakes once after each of the first two consecutive recoverable errors', () => {
    const { coordinator, wakeups } = harness()
    coordinator.onError(memberId, 'fetch failed')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    coordinator.onError(memberId, 'HTTP 429')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)

    expect(wakeups).toEqual([memberId, memberId])
  })

  it('counts every agent/error occurrence, including repeated equal errors', () => {
    const { coordinator, facts } = harness()
    coordinator.onError(memberId, 'fetch failed')
    coordinator.onError(memberId, 'fetch failed')
    expect(vi.getTimerCount()).toBe(2)

    coordinator.onError(memberId, 'fetch failed')
    expect(facts.filter(fact => fact.kind === 'stood-down')).toEqual([{
      kind: 'stood-down', memberId, errorKind: 'transient network',
      consecutiveFailures: RECOVERY_MAX_CONSECUTIVE_ERRORS, maxConsecutiveErrors: RECOVERY_MAX_CONSECUTIVE_ERRORS,
    }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stands down immediately on the third consecutive recoverable error', () => {
    const { coordinator, wakeups } = harness()
    coordinator.onError(memberId, 'fetch failed')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    coordinator.onError(memberId, 'HTTP 429')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)

    coordinator.onError(memberId, 'socket hang up')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS * 2)
    expect(wakeups).toEqual([memberId, memberId])
  })

  it('counts changing messages and recoverable kinds as one uninterrupted error run', () => {
    const { coordinator, wakeups } = harness()
    coordinator.onError(memberId, 'ECONNRESET')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    coordinator.onError(memberId, 'HTTP 429')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    coordinator.onError(memberId, 'socket hang up')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS * 2)

    expect(wakeups).toEqual([memberId, memberId])
  })

  it('clears the consecutive error count when a turn ends cleanly', () => {
    const { coordinator, wakeups } = harness()
    coordinator.onError(memberId, 'ETIMEDOUT')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    coordinator.onCleanTurnEnd(memberId)

    coordinator.onError(memberId, 'ETIMEDOUT')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    expect(wakeups).toEqual([memberId, memberId])
  })

  it('cancels automatic recovery tracking when a non-recoverable error arrives', () => {
    const { coordinator, wakeups } = harness()
    coordinator.onError(memberId, 'fetch failed')
    coordinator.onError(memberId, 'context length exceeded')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS * 3)
    expect(wakeups).toEqual([])
  })

  it('stops tracking when the wake target is gone', () => {
    const coordinator = new RecoveryCoordinator({
      wake: () => { throw new Error('member disposed') },
    })
    coordinator.onError(memberId, 'fetch failed')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    coordinator.onError(memberId, 'fetch failed')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('notifies stand-down exactly once per error run', () => {
    const { coordinator, facts } = harness({ maxConsecutiveErrors: 2 })
    coordinator.onError(memberId, 'HTTP 429')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    coordinator.onError(memberId, 'HTTP 429')
    coordinator.onError(memberId, 'HTTP 429')
    expect(facts.filter(fact => fact.kind === 'stood-down')).toEqual([{
      kind: 'stood-down', memberId, errorKind: 'rate limiting', consecutiveFailures: 2, maxConsecutiveErrors: 2,
    }])
  })

  it('dispose cancels every pending timer', () => {
    const { coordinator } = harness()
    coordinator.onError('member:a' as AgentTeamMemberId, 'fetch failed')
    coordinator.onError('member:b' as AgentTeamMemberId, 'HTTP 429')
    expect(vi.getTimerCount()).toBe(2)
    coordinator.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('counts a structured recoverable failure like any other occurrence', () => {
    const { coordinator, wakeups } = harness()
    coordinator.onError(memberId, new LlmError('DeepSeek Messages transport failed', 'TRANSPORT'))
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    expect(wakeups).toEqual([memberId])
  })

  it('a structured terminal failure stops tracking despite recoverable wording in its message', () => {
    const { coordinator, wakeups } = harness()
    coordinator.onError(memberId, new LlmError('DeepSeek Messages transport failed', 'TRANSPORT'))
    coordinator.onError(memberId, new LlmError('upstream answered 429 while settling quota', 'QUOTA', { status: 402 }))
    vi.advanceTimersByTime(RECOVERY_DELAY_MS * 3)
    expect(wakeups).toEqual([])
  })

  it('reports the classification, count, wait, wakeup, and clean-turn clear of one episode', () => {
    const { coordinator, facts } = harness()
    coordinator.onError(memberId, 'fetch failed')
    expect(facts).toEqual([{
      kind: 'scheduled', memberId, errorKind: 'transient network',
      consecutiveFailures: 1, maxConsecutiveErrors: RECOVERY_MAX_CONSECUTIVE_ERRORS, delayMs: RECOVERY_DELAY_MS,
    }])

    vi.advanceTimersByTime(RECOVERY_DELAY_MS)
    expect(facts.at(-1)).toEqual({ kind: 'woke', memberId, consecutiveFailures: 1 })

    coordinator.onCleanTurnEnd(memberId)
    expect(facts.at(-1)).toEqual({
      kind: 'cleared', memberId, reason: 'clean-turn', consecutiveFailures: 1, pendingWakes: 0, stoodDown: false,
    })
  })

  it('reports a wake whose target is gone instead of stopping silently', () => {
    const { coordinator, facts } = harness({ wake: () => { throw new Error('member disposed') } })
    coordinator.onError(memberId, 'fetch failed')
    vi.advanceTimersByTime(RECOVERY_DELAY_MS)

    expect(facts.at(-1)).toEqual({
      kind: 'cleared', memberId, reason: 'wake-failed', consecutiveFailures: 1, pendingWakes: 0, stoodDown: false,
      detail: 'Error: member disposed',
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a non-recoverable error as a clear only when it cancels a live episode', () => {
    const idle = harness()
    idle.coordinator.onError(memberId, 'context length exceeded')
    expect(idle.facts).toEqual([])

    const live = harness()
    live.coordinator.onError(memberId, 'fetch failed')
    live.coordinator.onError(memberId, 'context length exceeded')
    expect(live.facts.at(-1)).toEqual({
      kind: 'cleared', memberId, reason: 'non-recoverable', consecutiveFailures: 1, pendingWakes: 1, stoodDown: false,
    })
  })

  it('reports a stood-down episode when a clean turn clears it', () => {
    const { coordinator, facts } = harness({ maxConsecutiveErrors: 2 })
    coordinator.onError(memberId, 'HTTP 429')
    coordinator.onError(memberId, 'HTTP 429')
    coordinator.onCleanTurnEnd(memberId)
    expect(facts.at(-1)).toEqual({
      kind: 'cleared', memberId, reason: 'clean-turn', consecutiveFailures: 2, pendingWakes: 0, stoodDown: true,
    })
  })

  it('reports one host-disposed clear per tracked Member', () => {
    const { coordinator, facts } = harness()
    coordinator.onError(memberId, 'fetch failed')
    coordinator.onError('member:other' as AgentTeamMemberId, 'fetch failed')
    coordinator.dispose()
    const cleared = facts.filter(fact => fact.kind === 'cleared')
    expect(cleared.map(fact => fact.kind === 'cleared' ? fact.reason : '')).toEqual(['host-disposed', 'host-disposed'])
  })
})
