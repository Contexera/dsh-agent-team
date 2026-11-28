import { describe, expect, it } from 'vitest'
import {
  admissionAttemptRequestId, admissionDeliveryRef, admissionKey, admissionKeysOf, admissionRefFor, dueAdmissions,
  type SubscriptionAdmissionRecord,
} from '../src/subscription-admissions.ts'
import { subscriptionDomainSpec } from '../src/subscription-store.ts'
import type { SubscriptionCredential, SubscriptionEvent, SubscriptionScriptSnapshot } from '../src/subscriptions.ts'
import type { AgentTeamProjectRef, AgentTeamSubscriptionRef } from '../src/types/entities.ts'

/**
 * One admission record is one durable row per webhook delivery, and its storage
 * schema already refuses an `exhausted` row that carries a retry instant or a
 * held batch. These cases pin the type to the same rule: a record built here
 * cannot claim what storage would reject, while the states that legitimately
 * hold either field still do.
 */
describe('an admission record', () => {
  const subscriptionRef = 'subscription:11111111-1111-4111-8111-111111111111' as AgentTeamSubscriptionRef
  const projectRef = 'project:22222222-2222-4222-8222-222222222222' as AgentTeamProjectRef
  const script: SubscriptionScriptSnapshot = Object.freeze({
    content: 'echo hi\n', sha256: 'a'.repeat(64), shell: 'bash',
  })
  const credentials: readonly SubscriptionCredential[] = Object.freeze([
    Object.freeze({ ref: 'GH_TOKEN', env: 'GITHUB_TOKEN' }),
  ])
  const base = Object.freeze({
    admissionRef: 'admission:33333333-3333-4333-8333-333333333333',
    subscriptionRef,
    projectRef,
    deliveryRef: 'delivery:44444444-4444-4444-8444-444444444444',
    receivedRevision: 1,
    receivedScriptHash: 'b'.repeat(64),
    script,
    credentials,
    headers: Object.freeze({ 'x-hub-signature-256': 'sha256=stub' }),
    body: '{}',
    receivedAt: '2026-11-10T11:35:40.000Z',
    attempts: 0,
  })
  const batch: readonly SubscriptionEvent[] = Object.freeze([{ id: 'a', title: 'A' }])

  it('lets a retrying row hold its retry instant and a waiting row hold its batch', () => {
    const retrying: SubscriptionAdmissionRecord = Object.freeze({
      ...base, attempts: 1, state: 'retrying', nextAttemptAt: '2026-11-10T11:36:40.000Z', lastError: 'the run failed',
    })
    const waiting: SubscriptionAdmissionRecord = Object.freeze({ ...base, state: 'queued', heldEvents: batch })
    expect(retrying).toMatchObject({ state: 'retrying', attempts: 1, nextAttemptAt: '2026-11-10T11:36:40.000Z' })
    expect(waiting).toMatchObject({ state: 'queued', heldEvents: [{ id: 'a', title: 'A' }] })
  })

  it('takes both state-only fields off a row before it becomes spent', () => {
    const retrying: SubscriptionAdmissionRecord = Object.freeze({
      ...base, attempts: 3, state: 'retrying', nextAttemptAt: '2026-11-10T11:36:40.000Z', lastError: 'the run failed',
    })
    const { nextAttemptAt: _due, heldEvents: _held, ...rest } = retrying
    const spent: SubscriptionAdmissionRecord = Object.freeze({
      ...rest, attempts: 4, state: 'exhausted', lastError: 'the run failed',
    })
    expect(spent).toMatchObject({ state: 'exhausted', attempts: 4, lastError: 'the run failed' })
    expect(spent.nextAttemptAt).toBeUndefined()
    expect(spent.heldEvents).toBeUndefined()
  })

  it('refuses a spent delivery that still claims a retry instant or a held batch', () => {
    const spent = { ...base, attempts: 4, state: 'exhausted', lastError: 'the run failed' } as const
    // @ts-expect-error -- a spent delivery carries no retry instant: the storage schema refuses one.
    const withDue: SubscriptionAdmissionRecord = { ...spent, nextAttemptAt: '2026-11-10T11:36:40.000Z' }
    // @ts-expect-error -- a spent delivery carries no held batch either.
    const withBatch: SubscriptionAdmissionRecord = { ...spent, heldEvents: batch }
    // Neither row is reachable at run time; the two cases exist for the compiler,
    // and reading their state is what keeps them from being dead code.
    expect(withDue.state + withBatch.state).toBe('exhaustedexhausted')
  })

  it('builds stable admission keys, attempt request ids, and filters by subscription', () => {
    const otherRef = 'subscription:99999999-9999-4999-8999-999999999999' as AgentTeamSubscriptionRef
    const ref = admissionRefFor('abc')
    expect(ref).toBe('admission:abc')
    expect(admissionAttemptRequestId(ref, 2)).toBe('admission:abc:attempt-2')
    const k1 = admissionKey(subscriptionRef, ref)
    const k2 = admissionKey(otherRef, 'admission:other')
    expect(k1).toBe(`${subscriptionRef}|admission:abc`)
    expect(admissionKeysOf([k1, k2], subscriptionRef)).toEqual([k1])
  })

  it('derives delivery refs from valid provider headers and falls back on malformed values', () => {
    expect(admissionDeliveryRef('admission:a1', { 'x-github-delivery': '  gh-123  ' })).toBe('delivery:gh-123')
    expect(admissionDeliveryRef('admission:a1', { 'x-custom-delivery': 'bad:colon', 'x-github-delivery': 'ok-2' })).toBe('delivery:ok-2')
    expect(admissionDeliveryRef('admission:a1', { 'x-empty-delivery': '   ', 'x-long-delivery': 'x'.repeat(201) })).toBe('delivery:a1')
    expect(admissionDeliveryRef('admission:a1', { 'x-other-header': 'ignored' })).toBe('delivery:a1')
  })

  it('selects due non-running admissions ordered oldest arrival first without mutating input', () => {
    const now = Date.parse('2026-11-10T12:00:00.000Z')
    const newerQueued: SubscriptionAdmissionRecord = Object.freeze({ ...base, admissionRef: 'admission:newer', receivedAt: '2026-11-10T11:40:00.000Z', state: 'queued' })
    const olderRetrying: SubscriptionAdmissionRecord = Object.freeze({ ...base, admissionRef: 'admission:older', receivedAt: '2026-11-10T11:30:00.000Z', state: 'retrying', nextAttemptAt: '2026-11-10T12:00:00.000Z' })
    const futureRetrying: SubscriptionAdmissionRecord = Object.freeze({ ...base, admissionRef: 'admission:future', receivedAt: '2026-11-10T11:20:00.000Z', state: 'retrying', nextAttemptAt: '2026-11-10T12:00:01.000Z' })
    const running: SubscriptionAdmissionRecord = Object.freeze({ ...base, admissionRef: 'admission:running', receivedAt: '2026-11-10T11:10:00.000Z', state: 'running' })
    const input = [newerQueued, futureRetrying, running, olderRetrying]
    expect(dueAdmissions(input, now).map(r => r.admissionRef)).toEqual(['admission:older', 'admission:newer'])
    expect(input.map(r => r.admissionRef)).toEqual(['admission:newer', 'admission:future', 'admission:running', 'admission:older'])
  })

  it('enforces admission and replay schema invariants in subscriptionDomainSpec', () => {
    const admissionSchema = subscriptionDomainSpec.tables.admissions.valueSchema
    expect(admissionSchema.safeParse({ ...base, state: 'exhausted', lastError: 'failed' }).success).toBe(true)
    expect(admissionSchema.safeParse({ ...base, state: 'exhausted' }).success).toBe(false)
    expect(admissionSchema.safeParse({ ...base, state: 'exhausted', lastError: 'failed', nextAttemptAt: '2026-11-10T11:36:40.000Z' }).success).toBe(false)
    expect(admissionSchema.safeParse({ ...base, state: 'exhausted', lastError: 'failed', heldEvents: batch }).success).toBe(false)
    expect(admissionSchema.safeParse({ ...base, state: 'queued', failureStreak: { resumeSequence: 1, successEpoch: 0 } }).success).toBe(false)

    const replaySchema = subscriptionDomainSpec.tables.replays.valueSchema
    const legacyReplay = replaySchema.parse({
      subscriptionRef, projectRef, requestId: 'req-1', deliveryRef: base.deliveryRef,
      version: 'current', expiresAt: '2026-11-11T11:35:40.000Z',
    })
    expect(legacyReplay.state).toBe('settled')
  })
})
