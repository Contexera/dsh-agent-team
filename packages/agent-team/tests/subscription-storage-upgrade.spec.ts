import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { admissionKey } from '../src/subscription-admissions.ts'
import { deliveryKey, replayKey, subscriptionRunKey } from '../src/subscription-runs.ts'
import { subscriptionDomainSpec } from '../src/subscription-store.ts'
import type { AgentTeamSubscriptionRef } from '../src/types.ts'
import { SqliteStorageBackend } from '../src/vendor/storage-sqlite/index.ts'

// The v0.2.7 declaration and on-disk rows are independent of the current schemas.
const released = {
  name: 'agent_team_subscriptions', version: 4, compatibleVersions: [1, 2, 3],
  hasGlobal: false, tables: ['checkpoints', 'runs', 'deliveries', 'replays', 'admissions'],
}
const subscriptionRef = 'subscription:ci' as AgentTeamSubscriptionRef
const projectRef = 'project:alpha'
const receivedAt = '2026-11-11T00:00:00.000Z'
const expiresAt = '2026-11-12T00:00:00.000Z'
const sha256 = 'a'.repeat(64)
const script = { content: 'exit 1', sha256, shell: 'bash' }
const checkpoint = { subscriptionRef, dueAt: Date.parse(receivedAt), consecutiveFailures: 2, publishedInWindow: 0 }
const admission = {
  admissionRef: 'admission:pending', subscriptionRef, projectRef, deliveryRef: 'delivery:pending',
  receivedRevision: 1, receivedScriptHash: sha256, script, credentials: [], headers: {},
  body: '{"job":1}', receivedAt, attempts: 3, state: 'retrying',
  nextAttemptAt: '2026-11-11T00:30:00.000Z', lastError: 'exit 1',
}
const delivery = {
  deliveryRef: 'delivery:spent', subscriptionRef, projectRef, receivedRevision: 1, receivedScriptHash: sha256,
  script, credentials: [], body: '{"job":2}', receivedAt, expiresAt, attempts: 4, lastError: 'exit 1',
}
const replay = {
  subscriptionRef, projectRef, requestId: 'replay-1', deliveryRef: delivery.deliveryRef, version: 'received',
  runRef: 'run:one', succeeded: false, eventCount: 0, reason: 'exit 1', expiresAt,
}
const run = {
  runRef: 'run:one', subscriptionRef, projectRef, trigger: 'webhook', startedAt: receivedAt, durationMs: 1,
  category: 'empty', exitCode: 0, timedOut: false, eventCount: 0, stdoutTail: '', stderrTail: '',
  subscriptionRevision: 1, scriptHash: sha256, deliveryRef: delivery.deliveryRef, attempt: 4,
}
const key = admissionKey(subscriptionRef, admission.admissionRef)
const runKey = subscriptionRunKey(run)
const failedKey = deliveryKey(subscriptionRef, delivery.deliveryRef)
const replayRequestKey = replayKey(subscriptionRef, replay.requestId)
const initialized = {
  kind: 'team/initialized', operationId: 'operation:upgrade-fixture', sequence: 1,
  requestId: 'agent-team:initialize:v1', previousOperationId: null, occurredAt: receivedAt,
  actor: { kind: 'human', memberId: 'member:human' }, data: { humanMemberId: 'member:human' },
}

let root: string
let path: string
const backends: SqliteStorageBackend[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'team-subscription-upgrade-'))
  path = join(root, 'agent_team.sqlite')
})
afterEach(async () => {
  await Promise.all(backends.splice(0).map(backend => backend.close()))
  await rm(root, { recursive: true, force: true })
})

function connect(): SqliteStorageBackend {
  const backend = new SqliteStorageBackend({ path, journalMode: 'delete' })
  backends.push(backend)
  return backend
}

function unitVersion(name = released.name): number {
  const db = new DatabaseSync(path)
  try {
    return (db.prepare('SELECT version FROM units WHERE name = ?').get(name) as { version: number }).version
  } finally {
    db.close()
  }
}

async function openCurrent() {
  const backend = connect()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  const domain = await facility.open(subscriptionDomainSpec)
  return { backend, domain, close: async () => { await domain.close(); await backend.close() } }
}

describe('subscription storage upgrade', () => {
  it('keeps v4 records through a read and a rolled-back write, and stamps the first committed settlement', async () => {
    const writer = connect()
    const old = await writer.kv.open(released)
    await old.putRecord('checkpoints', subscriptionRef, checkpoint)
    await old.putRecord('runs', runKey, run)
    await old.putRecord('deliveries', failedKey, delivery)
    await old.putRecord('replays', replayRequestKey, replay)
    await old.putRecord('admissions', key, admission)
    const ledgerDescriptor = descriptorOf(agentTeamDomainSpec)
    const seededLedger = await writer.kv.open(ledgerDescriptor)
    await seededLedger.putRecord('operations', initialized.operationId, initialized)
    await writer.close()

    const { domain, close } = await openCurrent()
    expect(domain.table('checkpoints').get(subscriptionRef)).toEqual(checkpoint)
    expect(domain.table('runs').get(runKey)).toEqual(run)
    expect(domain.table('deliveries').get(failedKey)).toEqual(delivery)
    expect(domain.table('replays').get(replayRequestKey)).toEqual({ ...replay, state: 'settled' })
    const queued = domain.table('admissions').get(key)!
    expect(queued).toEqual(admission)
    await domain.table('admissions').delete('absent')
    expect(unitVersion()).toBe(4)

    const newRef = 'admission:spent'
    const newKey = admissionKey(subscriptionRef, newRef)
    const { nextAttemptAt: _next, heldEvents: _held, ...original } = queued
    const exhausted = {
      ...original, admissionRef: newRef, deliveryRef: 'delivery:other', state: 'exhausted' as const,
      attempts: 4, lastError: 'exit 1', failureStreak: { resumeSequence: 0, successEpoch: 0 },
    }
    const db = new DatabaseSync(path)
    try {
      db.exec(`CREATE TRIGGER refuse_upgrade BEFORE UPDATE ON units WHEN OLD.name = 'agent_team_subscriptions'
        BEGIN SELECT RAISE(ABORT, 'upgrade refused'); END`)
      await expect(domain.table('admissions').put(newKey, exhausted)).rejects.toThrow(/upgrade refused/)
      expect(unitVersion()).toBe(4)
      expect(db.prepare('SELECT value FROM u_agent_team_subscriptions_admissions WHERE key = ?').get(newKey)).toBeUndefined()
      expect(domain.table('admissions').get(newKey)).toBeUndefined()
      db.exec('DROP TRIGGER refuse_upgrade')
    } finally {
      db.close()
    }

    await domain.table('admissions').put(newKey, exhausted)
    expect(unitVersion()).toBe(5)
    await close()
    const reopened = await openCurrent()
    expect(reopened.domain.table('admissions').get(key)).toEqual(admission)
    expect(reopened.domain.table('admissions').get(newKey)).toEqual(exhausted)
    await reopened.domain.table('admissions').delete(newKey)
    const ledger = await reopened.backend.kv.open(ledgerDescriptor)
    expect((await ledger.loadAll()).tables.operations).toEqual({ [initialized.operationId]: initialized })
    expect(unitVersion(ledgerDescriptor.name)).toBe(1)
    await reopened.close()

    await expect(connect().kv.open(released)).rejects.toMatchObject({
      code: 'version-mismatch', message: expect.stringContaining('version 5'),
    })
  })

  it.each([1, 2, 3])('can skip from v%i and write while leaving earlier rows readable', async version => {
    const writer = connect()
    const tableCount = version === 1 ? 1 : version + 1
    const old = await writer.kv.open({ ...released, version, compatibleVersions: [], tables: released.tables.slice(0, tableCount) })
    await old.putRecord('checkpoints', subscriptionRef, checkpoint)
    await writer.close()

    const { domain, close } = await openCurrent()
    expect(domain.table('checkpoints').get(subscriptionRef)).toEqual(checkpoint)
    expect(unitVersion()).toBe(version)
    await domain.table('runs').put(runKey, subscriptionDomainSpec.tables.runs.valueSchema.parse(run))
    expect(unitVersion()).toBe(5)
    await close()
    const reopened = await openCurrent()
    expect(reopened.domain.table('checkpoints').get(subscriptionRef)).toEqual(checkpoint)
    expect(reopened.domain.table('runs').get(runKey)).toEqual(run)
    await reopened.close()
  })
})
