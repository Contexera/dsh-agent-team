/**
 * Run history and failed deliveries: what a subscription records about each
 * run, who may read which half of a record, when a run counts as a success, how
 * repeated failures pause it, and how a spent delivery is replayed.
 *
 * The records are private state, so every case drives the Host's own surfaces
 * and reads the storage domain directly only to prove what was written or
 * dropped.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { MemoryMediaPool, MemoryStorageBackend, type MemoryWriteFault } from './helpers/memory-backend.ts'
import { addLedgerMember, ledgerAtBoot, makeOwner, requestId } from './helpers/host-harness.ts'
import AgentTeam from '../src/index.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, agentTeamHumanActor } from '../src/ledger.ts'
import { subscriptionDomainSpec } from '../src/subscription-store.ts'
import type { SubscriptionCheckpoint } from '../src/subscription-runtime.ts'
import {
  deliveryExpiresAt, deliveryKey, deliveryRecordOf, replayKey, SUBSCRIPTION_DELIVERY_LIMIT, SUBSCRIPTION_RUN_HISTORY_LIMIT,
  subscriptionRunKey, type SubscriptionDeliveryInput, type SubscriptionDeliveryRecord, type SubscriptionReplayRecord,
  type SubscriptionRunRecord,
} from '../src/subscription-runs.ts'
import { SUBSCRIPTION_FAILURES_BEFORE_PAUSE, SUBSCRIPTION_PENDING_MAX } from '../src/subscriptions.ts'
import type {
  AgentTeamActor, AgentTeamCreateSubscriptionRequest, AgentTeamOperation, AgentTeamProjectRef, AgentTeamRequestId,
  AgentTeamSubscription, AgentTeamSubscriptionDeliveriesRequest, AgentTeamSubscriptionDeliveriesResult,
  AgentTeamSubscriptionLogsRequest, AgentTeamSubscriptionLogsResult, AgentTeamSubscriptionRef,
  AgentTeamSubscriptionReplayRequest, AgentTeamSubscriptionReplayResult, AgentTeamSubscriptionReplayVersion,
} from '../src/types.ts'

const workspaceId = WorkspaceId('workspace:alpha')
const credentialValues: Record<string, string> = { GH_TOKEN: 'secret-value' }

interface FakeShell {
  readonly requests: ShellExecSpec[]
  stdout: string
  exitCode: number
  /** Held open while set: a run that must still be in flight when the test looks at the Host. */
  block: (() => Promise<void>) | undefined
  readonly service: {
    resolve(request: ShellExecSpec): ShellExecSpec
    execute(spec: ShellExecSpec): Promise<{ result(): Promise<ShellRunResult> }>
  }
}

/** A shell whose answer the test sets: probes identify the family, every script run returns the current state. */
function fakeShell(options: { readonly stdout: string; readonly exitCode?: number }): FakeShell {
  const requests: ShellExecSpec[] = []
  const state: { stdout: string; exitCode: number; block: (() => Promise<void>) | undefined } =
    { stdout: options.stdout, exitCode: options.exitCode ?? 0, block: undefined }
  return {
    requests,
    get stdout() { return state.stdout },
    set stdout(value) { state.stdout = value },
    get exitCode() { return state.exitCode },
    set exitCode(value) { state.exitCode = value },
    get block() { return state.block },
    set block(value) { state.block = value },
    service: {
      resolve: (request: ShellExecSpec) => request,
      execute: async (spec: ShellExecSpec) => {
        requests.push(spec)
        const isProbe = spec.command.includes('BASH_VERSION')
        // Only a script run can be held: the family probe decides what the run is.
        if (!isProbe && state.block !== undefined) await state.block()
        return { result: async () => ({
          exitCode: isProbe ? 0 : state.exitCode,
          signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: isProbe ? '5.2.15' : state.stdout, truncated: false },
          stderr: { text: '', truncated: false },
        }) }
      },
    },
  }
}

async function boot(pool: MemoryMediaPool, shell: Pick<FakeShell, 'service'>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === workspaceId ? { id, path: process.cwd(), attachSession: async () => {} } : undefined,
    list: () => [],
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  ctx.provide('shell', shell.service)
  ctx.provide('credentials', {
    resolve: async (ref: string) => credentialValues[ref] === undefined ? undefined : { value: credentialValues[ref], source: 'fixture' },
    describe: async (ref: string) => ({ configured: credentialValues[ref] !== undefined, writable: false }),
  })
  ctx.provide('tokenMeter', { estimateMessage: () => 0, measure: () => ({ totalTokens: 0, nodes: [] }) })
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  return { ctx, fiber, facility }
}

type Booted = Awaited<ReturnType<typeof boot>>

interface Disposable { dispose(): Promise<void> }
const live: Disposable[] = []
afterEach(async () => {
  await Promise.all(live.splice(0).map(handle => handle.dispose()))
})

/** A boot the test leaves to this file's teardown, in place of disposing it by hand. */
function keep(booted: Booted): Booted {
  live.push({ dispose: async () => { await booted.fiber.dispose() } })
  return booted
}

async function project(booted: Booted): Promise<AgentTeamProjectRef> {
  const created = await booted.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId, name: 'alpha', description: '' })
  return created.project.projectRef
}

const createRequest = (projectRef: AgentTeamProjectRef, scriptContent: string,
  overrides: Partial<AgentTeamCreateSubscriptionRequest> = {}): AgentTeamCreateSubscriptionRequest => ({
    requestId: requestId('subscription'), workspaceId, projectRef, name: 'main CI', intervalMinutes: 10,
    script: { scriptContent }, credentials: [{ ref: 'GH_TOKEN', env: 'GH_TOKEN' }], ...overrides,
  })

async function created(booted: Booted, projectRef: AgentTeamProjectRef, scriptContent: string): Promise<AgentTeamSubscription> {
  const result = await booted.ctx.agentTeam.createSubscription(createRequest(projectRef, scriptContent))
  if (result.kind !== 'changed') throw new Error('expected a created subscription')
  return result.subscription
}

const logsOf = (booted: Booted, projectRef: AgentTeamProjectRef, subscriptionRef: AgentTeamSubscriptionRef) =>
  booted.ctx.agentTeam.subscriptionLogsForClient({ workspaceId, projectRef, subscriptionRef })

/** The private run store, read directly to prove what was written, capped, or dropped. */
function runsTable(booted: Booted): KvTable<string, SubscriptionRunRecord> {
  return booted.facility.get('agent_team_subscriptions')!.table('runs') as KvTable<string, SubscriptionRunRecord>
}

function deliveriesTable(booted: Booted): KvTable<string, unknown> {
  return booted.facility.get('agent_team_subscriptions')!.table('deliveries') as KvTable<string, unknown>
}

function checkpointsTable(booted: Booted): KvTable<AgentTeamSubscriptionRef, SubscriptionCheckpoint> {
  return booted.facility.get('agent_team_subscriptions')!.table('checkpoints') as KvTable<AgentTeamSubscriptionRef, SubscriptionCheckpoint>
}

function replaysTable(booted: Booted): KvTable<string, unknown> {
  return booted.facility.get('agent_team_subscriptions')!.table('replays') as KvTable<string, unknown>
}

function operationsTable(booted: Booted): KvTable<string, AgentTeamOperation> {
  return booted.facility.get('agent_team')!.table('operations') as KvTable<string, AgentTeamOperation>
}

/** The Host's own seams: the ingress delivery record, the split read, and the checkpoint the scheduler owns. */
interface HostSeams {
  checkpointFor(subscriptionRef: AgentTeamSubscriptionRef): SubscriptionCheckpoint
  updateCheckpoint(subscriptionRef: AgentTeamSubscriptionRef,
    change: (checkpoint: SubscriptionCheckpoint) => SubscriptionCheckpoint): Promise<unknown>
  clearSubscriptionFailuresLocked(subscriptionRef: AgentTeamSubscriptionRef, accepted: boolean): Promise<void>
  recordFailedDelivery(subscription: AgentTeamSubscription, input: SubscriptionDeliveryInput): Promise<void>
  recordReplayIntent(subscription: AgentTeamSubscription, record: SubscriptionDeliveryRecord,
    requestId: AgentTeamRequestId, version: AgentTeamSubscriptionReplayVersion): Promise<void>
  subscriptionLogs(actor: AgentTeamActor, request: AgentTeamSubscriptionLogsRequest): AgentTeamSubscriptionLogsResult
  subscriptionDeliveries(actor: AgentTeamActor, request: AgentTeamSubscriptionDeliveriesRequest): AgentTeamSubscriptionDeliveriesResult
  replaySubscriptionDelivery(actor: AgentTeamActor, request: AgentTeamSubscriptionReplayRequest): Promise<AgentTeamSubscriptionReplayResult>
  serializeSubscriptionWrite<T>(subscriptionRef: AgentTeamSubscriptionRef, task: () => Promise<T>): Promise<T>
  readonly subscriptionReplaysTable: { put(key: string, value: unknown): Promise<void> } | undefined
  readonly subscriptionRunsTable: { put(key: string, value: unknown): Promise<void> } | undefined
}

const seams = (booted: Booted): HostSeams => booted.ctx.agentTeam as unknown as HostSeams

const deliveriesOf = (booted: Booted, projectRef: AgentTeamProjectRef, subscriptionRef: AgentTeamSubscriptionRef) =>
  seams(booted).subscriptionDeliveries(agentTeamHumanActor(), { workspaceId, projectRef, subscriptionRef }).deliveries

/** One replay as an owner asks for it: the delivery by its stable ref, and which version to run. */
const replayOf = (seam: HostSeams, projectRef: AgentTeamProjectRef, subscription: AgentTeamSubscription,
  deliveryRef: string, label: string, version?: AgentTeamSubscriptionReplayVersion): Promise<AgentTeamSubscriptionReplayResult> =>
  seam.replaySubscriptionDelivery(agentTeamHumanActor(), { requestId: requestId(label), workspaceId, projectRef,
    subscriptionRef: subscription.subscriptionRef, deliveryRef, ...(version === undefined ? {} : { version }) })

/** One delivery as ingress hands it over: the received version, the body, and what the last attempt said. */
function deliveryInput(subscription: AgentTeamSubscription, overrides: Partial<SubscriptionDeliveryInput> = {}): SubscriptionDeliveryInput {
  return {
    deliveryRef: 'delivery:d1', receivedRevision: subscription.revision, receivedAt: Date.now(),
    script: subscription.script, credentials: subscription.credentials, body: '{"headers":{},"body":"payload"}',
    attempts: 3, lastError: 'the script exited with code 1', ...overrides,
  }
}

/** Seed a checkpoint before boot: a due instant in the past is exactly what a restart after a missed run reads. */
async function seedCheckpoint(pool: MemoryMediaPool, subscriptionRef: AgentTeamSubscriptionRef,
  checkpoint: Partial<SubscriptionCheckpoint>): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  const domain = await facility.open(subscriptionDomainSpec)
  await domain.table('checkpoints').put(subscriptionRef, { subscriptionRef, consecutiveFailures: 0, publishedInWindow: 0, ...checkpoint })
  await domain.close()
}

/**
 * The write that clears the failure streak: the only checkpoint put that moves
 * the success waterline. A scheduler tick or a due instant writes the same row,
 * so a test that held "the next checkpoint write" would race the timer loop.
 */
const isSuccessCheckpoint = (fault: MemoryWriteFault): boolean =>
  fault.table === 'checkpoints' && fault.operation === 'put'
  && (fault.value as SubscriptionCheckpoint | undefined)?.lastSuccessAt !== undefined

/**
 * The replay request record is written twice: the intent before the run (state
 * `running`) and the answer after it (state `settled`). Naming the settled one
 * is how a test fails the answer alone, with the intent it depends on intact.
 */
const isSettledAnswer = (fault: MemoryWriteFault): boolean =>
  fault.table === 'replays' && fault.operation === 'put'
  && (fault.value as SubscriptionReplayRecord | undefined)?.state === 'settled'

/** The delivery's own row, rewritten with the answer it was replayed under: the tombstone. */
const isTombstone = (fault: MemoryWriteFault): boolean =>
  fault.table === 'deliveries' && fault.operation === 'put'
  && (fault.value as SubscriptionDeliveryRecord | undefined)?.replay !== undefined

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** The scheduler the Host owns, read only for what it is doing right now. */
const schedulerOf = (booted: Booted): { state(): { readonly running: readonly string[]; readonly queued: readonly string[] } } =>
  (booted.ctx.agentTeam as unknown as { subscriptionScheduler: { state(): { readonly running: readonly string[]; readonly queued: readonly string[] } } }).subscriptionScheduler

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the scheduler')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('the records a subscription keeps of its runs', () => {
  it('records a timer run with its identity and both tails, and keeps it across a restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' }))
    const projectRef = await project(first)
    const subscription = await created(first, projectRef, 'printf events\n')
    // A create's trial runs as a draft the ledger never stored: nothing to keep, no place to keep it.
    expect(logsOf(first, projectRef, subscription.subscriptionRef).runs).toHaveLength(0)
    await first.fiber.dispose()

    await seedCheckpoint(pool, subscription.subscriptionRef, { dueAt: Date.now() - 1 })
    const second = keep(await boot(pool, fakeShell({ stdout: '{"id":"b","title":"B"}\n' })))
    const recorded = await waitFor(() => {
      const runs = logsOf(second, projectRef, subscription.subscriptionRef).runs
      return runs.length === 1 ? runs : undefined
    })
    expect(recorded[0]).toMatchObject({
      trigger: 'interval', category: 'accepted', succeeded: true, eventCount: 1, exitCode: 0, timedOut: false,
      subscriptionRevision: 1, scriptHash: subscription.script.sha256, stderrTail: '',
    })
    expect(recorded[0]!.stdoutTail).toContain('"id":"b"')
    expect(Number.isNaN(Date.parse(recorded[0]!.startedAt))).toBe(false)
    expect(recorded[0]!.durationMs).toBeGreaterThanOrEqual(0)
    await second.fiber.dispose()

    // The records live in the private domain, so a third boot reads the same run.
    const third = keep(await boot(pool, fakeShell({ stdout: '' })))
    expect(logsOf(third, projectRef, subscription.subscriptionRef).runs.map(run => run.runRef))
      .toEqual(recorded.map(run => run.runRef))
  })

  it(`keeps the newest ${SUBSCRIPTION_RUN_HISTORY_LIMIT} runs and evicts the rest`, async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    // A trial is recorded too, so the cap is provable without waiting for timers.
    for (let index = 0; index < SUBSCRIPTION_RUN_HISTORY_LIMIT + 2; index += 1) {
      await booted.ctx.agentTeam.testSubscriptionForClient({ workspaceId, projectRef, subscriptionRef: subscription.subscriptionRef })
    }
    const runs = logsOf(booted, projectRef, subscription.subscriptionRef).runs
    expect(runs).toHaveLength(SUBSCRIPTION_RUN_HISTORY_LIMIT)
    expect(runs[0]).toMatchObject({ trigger: 'test', category: 'verified', succeeded: true })
    // Newest first, and the store holds exactly the cap.
    const starts = runs.map(run => Date.parse(run.startedAt))
    expect([...starts].sort((left, right) => right - left)).toEqual(starts)
    expect(runsTable(booted).size).toBe(SUBSCRIPTION_RUN_HISTORY_LIMIT)
    // A limit narrows the answer without changing what is kept.
    expect(booted.ctx.agentTeam.subscriptionLogsForClient({ workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, limit: 2 }).runs).toHaveLength(2)
  })

  it('drops the run records and the failed deliveries with the subscription', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    await booted.ctx.agentTeam.testSubscriptionForClient({ workspaceId, projectRef, subscriptionRef: subscription.subscriptionRef })
    expect(runsTable(booted).size).toBe(1)
    await seams(booted).recordFailedDelivery(subscription, deliveryInput(subscription))
    expect(deliveriesTable(booted).size).toBe(1)

    const deleted = await booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1 })
    expect(deleted.kind).toBe('changed')
    // The cleanup is awaited: the call that reports the deletion has already
    // dropped the rows, so nothing here waits for a background removal.
    expect(runsTable(booted).size).toBe(0)
    expect(deliveriesTable(booted).size).toBe(0)
    // Reading a deleted subscription's history is refused, like every other read that names it.
    expect(() => logsOf(booted, projectRef, subscription.subscriptionRef)).toThrow(/subscription_deleted/)
  })

  it('counts no events when a run printed only ids the subscription already knew', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const first = await boot(pool, shell)
    const projectRef = await project(first)
    // The create trial's id becomes the baseline...
    const subscription = await created(first, projectRef, 'printf events\n')
    await first.fiber.dispose()

    // ...so a live run that prints the same id has nothing left to accept. The
    // count is what reached the ledger, not the one line the script printed.
    await seedCheckpoint(pool, subscription.subscriptionRef, { dueAt: Date.now() - 1 })
    const second = keep(await boot(pool, shell))
    const record = await waitFor(() => logsOf(second, projectRef, subscription.subscriptionRef).runs[0])
    expect(record).toMatchObject({ trigger: 'interval', category: 'empty', succeeded: true, eventCount: 0 })
    expect(seams(second).checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(0)
  })

  it('drops the private rows of subscriptions the ledger no longer serves, at boot', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const first = await boot(pool, shell)
    const projectRef = await project(first)
    const kept = await created(first, projectRef, 'printf events\n')
    const discarded = await first.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf other\n',
      { requestId: requestId('subscription:second') }))
    if (discarded.kind !== 'changed') throw new Error('expected a second subscription')
    const gone = discarded.subscription
    for (const subscription of [kept, gone]) {
      await first.ctx.agentTeam.testSubscriptionForClient({ workspaceId, projectRef, subscriptionRef: subscription.subscriptionRef })
    }
    await first.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef,
      subscriptionRef: gone.subscriptionRef, expectedRevision: 1 })
    // A crash between the ledger commit and the cleanup leaves the rows behind.
    // Put them back the way an interrupted deletion would: for the deleted
    // subscription, and for one the ledger never held at all.
    const template = logsOf(first, projectRef, kept.subscriptionRef).runs[0]!
    const templateRun = [...runsTable(first).entries()].find(([, record]) => record.runRef === template.runRef)![1]
    const ghost = 'subscription:ghost-left-behind' as AgentTeamSubscriptionRef
    for (const subscriptionRef of [gone.subscriptionRef, ghost]) {
      const run = { ...templateRun, subscriptionRef, runRef: `run:leftover-${subscriptionRef.slice(-8)}` }
      await runsTable(first).put(subscriptionRunKey(run), run)
      const delivery = deliveryRecordOf({ ...gone, subscriptionRef }, deliveryInput(gone), undefined)
      await deliveriesTable(first).put(deliveryKey(subscriptionRef, delivery.deliveryRef), delivery)
      await replaysTable(first).put(replayKey(subscriptionRef, 'req:leftover'), { subscriptionRef, projectRef,
        requestId: 'req:leftover', deliveryRef: delivery.deliveryRef, version: 'current', runRef: run.runRef,
        succeeded: false, eventCount: 0, expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
      await checkpointsTable(first).put(subscriptionRef, { subscriptionRef, consecutiveFailures: 2, publishedInWindow: 0 })
    }
    await first.fiber.dispose()

    const second = keep(await boot(pool, shell))
    const names = (keys: Iterable<string>): readonly string[] => [...keys].filter(key => !key.startsWith(`${kept.subscriptionRef}|`)
      && key !== kept.subscriptionRef)
    // Nothing survives for either dead subscription, and the live one keeps both
    // its run record and its checkpoint.
    for (const table of [runsTable(second), deliveriesTable(second), replaysTable(second), checkpointsTable(second)]) {
      expect(names(table.keys())).toEqual([])
    }
    expect(logsOf(second, projectRef, kept.subscriptionRef).runs).toHaveLength(1)
  })
})

describe('what a run record shows whom', () => {
  it('gives the Human and the owners the output, and other members the summary only', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const first = await boot(pool, shell)
    const projectRef = await project(first)
    const subscription = await created(first, projectRef, 'printf events\n')
    // The trial that gates nothing this time fails, so the record carries a
    // reason and both tails for the readers below.
    shell.stdout = 'boom\n'
    shell.exitCode = 1
    await first.ctx.agentTeam.testSubscriptionForClient({ workspaceId, projectRef, subscriptionRef: subscription.subscriptionRef })
    const owner = await addLedgerMember(ledgerAtBoot(first), projectRef, 'member:agent-owner', 'Owner', 'owner')
    await makeOwner(ledgerAtBoot(first), projectRef, owner.member.memberId)
    const writer = await addLedgerMember(ledgerAtBoot(first), projectRef, 'member:agent-writer', 'Writer', 'writer')
    await first.fiber.dispose()

    // The second boot replays the ledger, so both members are Project members now.
    const second = keep(await boot(pool, shell))
    const asHuman = logsOf(second, projectRef, subscription.subscriptionRef).runs[0]!
    expect(asHuman.stdoutTail).toBe('boom\n')
    expect(asHuman.reason).toBe('the script exited with code 1')

    const asOwner = seams(second).subscriptionLogs(owner.actor, { workspaceId, projectRef, subscriptionRef: subscription.subscriptionRef }).runs[0]!
    expect(asOwner.stdoutTail).toBe('boom\n')
    expect(asOwner.reason).toBe('the script exited with code 1')

    // A Project member who owns nothing reads the summary: what happened, never what it printed.
    const asWriter = seams(second).subscriptionLogs(writer.actor, { workspaceId, projectRef, subscriptionRef: subscription.subscriptionRef }).runs[0]!
    expect(asWriter).toMatchObject({ category: 'exit-code', succeeded: false, eventCount: 0, exitCode: 1 })
    expect(asWriter.stdoutTail).toBeUndefined()
    expect(asWriter.stderrTail).toBeUndefined()
    expect(asWriter.reason).toBeUndefined()
    expect(asWriter.scriptHash).toBeUndefined()
  })
})

describe('when a run counts as a success', () => {
  it('records an over-ceiling batch as one failed run, with no last success', async () => {
    const pool = new MemoryMediaPool()
    const events = Array.from({ length: SUBSCRIPTION_PENDING_MAX + 1 }, (_, index) => `{"id":"i${index}","title":"T"}`).join('\n')
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const first = await boot(pool, shell)
    const projectRef = await project(first)
    const subscription = await created(first, projectRef, 'printf events\n')
    // The live run prints a batch the trial never saw, so every id in it is new.
    shell.stdout = `${events}\n`
    await first.fiber.dispose()

    // exit 0, and yet the batch is past the unpublished ceiling: the script
    // succeeded, the run did not.
    await seedCheckpoint(pool, subscription.subscriptionRef, { dueAt: Date.now() - 1 })
    const second = keep(await boot(pool, shell))
    const record = await waitFor(() => logsOf(second, projectRef, subscription.subscriptionRef).runs[0])
    expect(record).toMatchObject({ category: 'backlog-full', succeeded: false, exitCode: 0 })
    // The whole batch was refused, so nothing was accepted: the count is what
    // reached the ledger, not what the script printed.
    expect(record.eventCount).toBe(0)
    // The batch was refused, so the run failed: the script printed more than the
    // Project can still take. A subscription already at the ceiling is skipped
    // before it runs at all, which is the case that counts nothing.
    const checkpoint = seams(second).checkpointFor(subscription.subscriptionRef)
    expect(checkpoint.consecutiveFailures).toBe(1)
    expect(checkpoint.lastSuccessAt).toBeUndefined()
    expect(ledgerAtBoot(second).pendingSubscriptionEvents(subscription.subscriptionRef)).toHaveLength(0)
  })

  it('pauses after three failed runs and tells every owner, then clears the count only when a resume commits', async () => {
    const pool = new MemoryMediaPool()
    const failing = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const first = await boot(pool, failing)
    const projectRef = await project(first)
    const subscription = await created(first, projectRef, 'printf events\n')
    failing.exitCode = 1
    failing.stdout = ''
    const owner = await addLedgerMember(ledgerAtBoot(first), projectRef, 'member:agent-owner', 'Owner', 'owner')
    await makeOwner(ledgerAtBoot(first), projectRef, owner.member.memberId)
    const writer = await addLedgerMember(ledgerAtBoot(first), projectRef, 'member:agent-writer', 'Writer', 'writer')
    await first.fiber.dispose()

    await seedCheckpoint(pool, subscription.subscriptionRef, { dueAt: Date.now() - 1 })
    const second = keep(await boot(pool, failing))
    const seam = seams(second)
    for (let failures = 1; failures <= 3; failures += 1) {
      if (failures > 1) await seam.updateCheckpoint(subscription.subscriptionRef, checkpoint => ({ ...checkpoint, dueAt: Date.now() - 1 }))
      await waitFor(() => seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures === failures ? true : undefined)
    }
    // Three failures pause it, and only the ledger knows.
    const paused = await waitFor(() => {
      const current = second.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!.subscription
      return current.state === 'paused' ? current : undefined
    })
    expect(paused.pausedReason).toBe('failures')
    expect(logsOf(second, projectRef, subscription.subscriptionRef).runs.slice(0, 3).map(run => run.category))
      .toEqual(['exit-code', 'exit-code', 'exit-code'])

    // The Host's own pause is the one lifecycle line nobody asked for: every
    // owner and the Human get a marker, and a writer keeps only membership.
    const pause = [...operationsTable(second).entries()].map(entry => entry[1])
      .filter(operation => operation.kind === 'team/subscription-paused').at(-1)
    if (pause === undefined || pause.kind !== 'team/subscription-paused') throw new Error('expected the pause in the ledger')
    const notified = pause.data.inbox?.mainMarkers?.added ?? []
    expect(notified.map(marker => marker.memberId).sort()).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID, owner.member.memberId].sort())
    expect(notified.map(marker => marker.memberId)).not.toContain(writer.member.memberId)
    expect(notified.every(marker => 'activityRef' in marker && marker.activityRef === pause.data.activity.activityRef)).toBe(true)

    // A passing trial neither clears the count nor resumes the subscription.
    failing.exitCode = 0
    failing.stdout = '{"id":"a","title":"A"}\n'
    expect((await second.ctx.agentTeam.testSubscriptionForClient({ workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef })).kind).toBe('tested')
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(3)
    // A failing resume trial leaves both alone.
    failing.exitCode = 1
    failing.stdout = ''
    const refused = await second.ctx.agentTeam.resumeSubscription({ requestId: requestId('resume-refused'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: paused.revision })
    expect(refused.kind).toBe('trial-failed')
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(3)
    expect(second.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!.subscription.state).toBe('paused')
    // Only a committed resume clears it.
    failing.exitCode = 0
    failing.stdout = '{"id":"a","title":"A"}\n'
    expect((await second.ctx.agentTeam.resumeSubscription({ requestId: requestId('resume'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: paused.revision })).kind).toBe('changed')
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(0)
  })

  it('keeps the deduplication baseline across an update, so a trial id is never swallowed', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    expect(ledgerAtBoot(booted).subscriptionKnownIds(subscription.subscriptionRef).has('a')).toBe(true)

    shell.stdout = '{"id":"c","title":"C"}\n'
    const updated = await booted.ctx.agentTeam.updateSubscription({ requestId: requestId('update'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1, name: 'main CI', intervalMinutes: 10,
      script: { scriptContent: 'printf fixed\n' }, credentials: [] })
    expect(updated.kind).toBe('changed')
    // The trial ran the new script...
    expect(shell.requests.some(spec => spec.command === 'printf fixed\n')).toBe(true)
    // ...and its output is not the waterline: 'c' stays publishable.
    const known = ledgerAtBoot(booted).subscriptionKnownIds(subscription.subscriptionRef)
    expect(known.has('a')).toBe(true)
    expect(known.has('c')).toBe(false)
  })
})

describe('one ordered account of a success and a defeat', () => {
  it('accepts and clears in one segment, so a defeat counted beside it starts a new streak', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription, { deliveryRef: 'delivery:d1' }))
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(1)
    shell.stdout = '{"id":"c","title":"C"}\n'
    shell.requests.length = 0
    // The lock is taken once the intent is down and before the run's own segment
    // asks for it: the script still runs (a run holds a run slot, not this lock),
    // while the accept and the clear behind it wait.
    const realIntent = seam.recordReplayIntent.bind(seam)
    const held = deferred()
    const release = deferred()
    let holding: Promise<unknown> = Promise.resolve()
    seam.recordReplayIntent = async (target, record, requestId, replayVersion) => {
      await realIntent(target, record, requestId, replayVersion)
      holding = seam.serializeSubscriptionWrite(target.subscriptionRef, async () => {
        held.resolve()
        await release.promise
      })
    }
    const replay = replayOf(seam, projectRef, subscription, 'delivery:d1', 'once')
    await waitFor(() => shell.requests.some(spec => spec.command === 'printf events\n') ? true : undefined)
    await held.promise
    // Nothing the run printed has reached the ledger: the accept is inside the
    // segment the test is holding, together with the clear it belongs to.
    expect(ledgerAtBoot(booted).subscriptionKnownIds(subscription.subscriptionRef).has('c')).toBe(false)
    // A defeat that arrives now is counted after that segment, so it starts a
    // new streak instead of being cleared with the one the success ends.
    const second = seam.recordFailedDelivery(subscription, deliveryInput(subscription,
      { deliveryRef: 'delivery:d2', receivedAt: Date.now() + 60_000 }))
    release.resolve()
    await holding
    expect(await replay).toMatchObject({ kind: 'replayed', eventCount: 1 })
    await second
    expect(seam.checkpointFor(subscription.subscriptionRef)).toMatchObject({ consecutiveFailures: 1 })
    expect(seam.checkpointFor(subscription.subscriptionRef).lastSuccessAt).toBeDefined()
  })

  it('keeps the whole streak clear when the success comes after the defeat', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(1)
    shell.stdout = '{"id":"c","title":"C"}\n'
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'replay')).toMatchObject({ kind: 'replayed', eventCount: 1 })
    expect(seam.checkpointFor(subscription.subscriptionRef)).toMatchObject({ consecutiveFailures: 0 })
  })

  it('ends the streak for a run that printed nothing new, in the same segment', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    // 'a' is the create baseline: this replay accepts nothing, and it is still
    // the success that ends the streak.
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'replay')).toMatchObject({ kind: 'replayed', eventCount: 0 })
    expect(seam.checkpointFor(subscription.subscriptionRef)).toMatchObject({ consecutiveFailures: 0 })
  })
})

describe('failed deliveries', () => {
  it('keeps one stable record per delivery, with its last error and expiry, and caps the list', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    const receivedAt = Date.now() - 60_000
    // Three attempts at one delivery replace each other: one row, the last error.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // A provider that redelivers arrives later; the record keeps the first arrival.
      await seam.recordFailedDelivery(subscription, deliveryInput(subscription,
        { receivedAt: receivedAt + (attempt - 1) * 60_000, attempts: attempt, lastError: `attempt ${attempt}: the script exited with code 1` }))
    }
    const [delivery] = deliveriesOf(booted, projectRef, subscription.subscriptionRef)
    expect(deliveriesOf(booted, projectRef, subscription.subscriptionRef)).toHaveLength(1)
    expect(delivery).toMatchObject({ deliveryRef: 'delivery:d1', attempts: 3, lastError: 'attempt 3: the script exited with code 1',
      receivedAt: new Date(receivedAt).toISOString(), receivedRevision: 1, receivedScriptHash: subscription.script.sha256,
      expiresAt: deliveryExpiresAt(receivedAt) })

    // Ten stay, the oldest arrival goes first.
    for (let index = 0; index < SUBSCRIPTION_DELIVERY_LIMIT + 2; index += 1) {
      await seam.recordFailedDelivery(subscription, deliveryInput(subscription,
        { deliveryRef: `delivery:bulk-${index}`, receivedAt: Date.now() + index }))
    }
    const capped = deliveriesOf(booted, projectRef, subscription.subscriptionRef)
    expect(capped).toHaveLength(SUBSCRIPTION_DELIVERY_LIMIT)
    expect(capped.map(entry => entry.deliveryRef)).not.toContain('delivery:d1')
    expect(capped[0]!.deliveryRef).toBe(`delivery:bulk-${SUBSCRIPTION_DELIVERY_LIMIT + 1}`)
    // An expired delivery is not listed, even before the next write collects it.
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription,
      { deliveryRef: 'delivery:stale', receivedAt: Date.now() - 8 * 24 * 60 * 60_000 }))
    expect(deliveriesOf(booted, projectRef, subscription.subscriptionRef).map(entry => entry.deliveryRef))
      .not.toContain('delivery:stale')
  })

  it('outlives the run records that explain it', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    await seams(booted).recordFailedDelivery(subscription, deliveryInput(subscription))
    // Push the run history past its cap: the delivery is older than every remaining run.
    for (let index = 0; index < SUBSCRIPTION_RUN_HISTORY_LIMIT + 1; index += 1) {
      await booted.ctx.agentTeam.testSubscriptionForClient({ workspaceId, projectRef, subscriptionRef: subscription.subscriptionRef })
    }
    expect(runsTable(booted).size).toBe(SUBSCRIPTION_RUN_HISTORY_LIMIT)
    expect(deliveriesOf(booted, projectRef, subscription.subscriptionRef)).toHaveLength(1)
  })

  it('counts deliveries that arrive together one by one, so the third still pauses', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    // Three spent deliveries land in the same tick. Each is one failure, and
    // their read-modify-write on the shared checkpoint must not collapse.
    await Promise.all(['delivery:d1', 'delivery:d2', 'delivery:d3'].map(deliveryRef =>
      seam.recordFailedDelivery(subscription, deliveryInput(subscription, { deliveryRef }))))
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(SUBSCRIPTION_FAILURES_BEFORE_PAUSE)
    // The threshold it reached is a pause, not a fourth delivery's worth of waiting.
    expect(booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!.subscription)
      .toMatchObject({ state: 'paused', pausedReason: 'failures' })
  })

  it('counts one delivery once however many times it is admitted at the same time', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    // A provider that retries its webhook three times delivers one failure: the
    // first admission counts, and the two that arrive beside it see the row.
    await Promise.all([1, 2, 3].map(() => seam.recordFailedDelivery(subscription,
      deliveryInput(subscription, { deliveryRef: 'delivery:d1', attempts: 3 }))))
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(1)
    expect(deliveriesOf(booted, projectRef, subscription.subscriptionRef)).toHaveLength(1)
    expect(booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!.subscription.state).toBe('active')
  })

  it('clears the private state of every subscription when the Project is archived', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await booted.ctx.agentTeam.testSubscriptionForClient({ workspaceId, projectRef, subscriptionRef: subscription.subscriptionRef })
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    expect(runsTable(booted).size).toBe(1)
    expect(deliveriesTable(booted).size).toBe(1)
    // An archived Project runs nothing, so its queues and history are cleared at
    // the archive rather than at the next boot.
    await booted.ctx.agentTeam.archiveProject({ requestId: requestId('archive'), workspaceId, projectRef })
    expect(runsTable(booted).size).toBe(0)
    expect(deliveriesTable(booted).size).toBe(0)
    expect(checkpointsTable(booted).size).toBe(0)
    // The ingress seam agrees when a late delivery arrives: nothing is rebuilt.
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription, { deliveryRef: 'delivery:late' }))
    expect(deliveriesTable(booted).size).toBe(0)
  })

  it('drops a spent delivery that arrives after the subscription stopped being live', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1 })
    // Nothing admits this write but its caller, so the terminal barrier has to be
    // read here: a delivery that arrives late must not rebuild what the deletion
    // dropped, and must not start counting failures for a record nobody serves.
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    expect(deliveriesTable(booted).size).toBe(0)
    expect(runsTable(booted).size).toBe(0)
    expect(checkpointsTable(booted).size).toBe(0)
  })
})

describe('replay', () => {
  it('runs the current definition, publishes what it prints, and answers a repeated request id once', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    // The delivery arrived under the definition that failed.
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    shell.stdout = '{"id":"c","title":"C"}\n'
    expect((await booted.ctx.agentTeam.updateSubscription({ requestId: requestId('update'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1, name: 'main CI', intervalMinutes: 10,
      script: { scriptContent: 'printf fixed\n' }, credentials: [] })).kind).toBe('changed')
    shell.requests.length = 0

    const request: AgentTeamSubscriptionReplayRequest = { requestId: requestId('replay'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, deliveryRef: 'delivery:d1' }
    const replayed = await seam.replaySubscriptionDelivery(agentTeamHumanActor(), request)
    expect(replayed.kind).toBe('replayed')
    // The current definition ran, with the delivery body on stdin, and its
    // output published exactly like a timer run's.
    const run = shell.requests.find(spec => !spec.command.includes('BASH_VERSION'))!
    expect(run.command).toBe('printf fixed\n')
    expect(JSON.parse(run.stdin ?? '{}')).toMatchObject({ body: 'payload' })
    expect(run.env).toMatchObject({ DSH_TEAM_TRIGGER: 'webhook', DSH_TEAM_DELIVERY_ID: 'delivery:d1' })
    const published = await waitFor(() => {
      const ids = booted.ctx.agentTeam.mainStreamHistory({ workspaceId, projectRef, limit: 20 }).entries
        .filter(entry => entry.kind === 'subscription-event')
        .map(entry => entry.kind === 'subscription-event' ? entry.event.event.id : '')
      return ids.includes('c') ? ids : undefined
    })
    expect(published).toContain('c')
    // The run record names the delivery and the attempt that spent its retries.
    const replayRun = logsOf(booted, projectRef, subscription.subscriptionRef).runs.find(run => run.trigger === 'webhook')
    expect(replayRun).toMatchObject({ category: 'accepted', deliveryRef: 'delivery:d1', attempt: 3 })
    // A delivered replay is no longer a failed delivery.
    expect(deliveriesOf(booted, projectRef, subscription.subscriptionRef)).toHaveLength(0)

    // The same request id answers with what the first call did and runs nothing.
    shell.requests.length = 0
    expect(await seam.replaySubscriptionDelivery(agentTeamHumanActor(), request))
      .toMatchObject({ kind: 'replayed', runRef: replayed.runRef })
    expect(shell.requests.filter(spec => !spec.command.includes('BASH_VERSION'))).toHaveLength(0)
  })

  it('pins the received definition when asked, and keeps a refused replay on the list', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    shell.stdout = '{"id":"c","title":"C"}\n'
    expect((await booted.ctx.agentTeam.updateSubscription({ requestId: requestId('update'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1, name: 'main CI', intervalMinutes: 10,
      script: { scriptContent: 'printf fixed\n' }, credentials: [] })).kind).toBe('changed')
    shell.requests.length = 0

    shell.exitCode = 1
    const refused = await seam.replaySubscriptionDelivery(agentTeamHumanActor(), { requestId: requestId('pinned'), workspaceId,
      projectRef, subscriptionRef: subscription.subscriptionRef, deliveryRef: 'delivery:d1', version: 'received' })
    expect(refused.kind).toBe('replay-failed')
    expect(refused.runRef).toBeDefined()
    // The version the delivery arrived under ran, not the fixed one.
    expect(shell.requests.find(spec => !spec.command.includes('BASH_VERSION'))!.command).toBe('printf events\n')
    // A refused replay stays on the list, so an owner can try again.
    expect(deliveriesOf(booted, projectRef, subscription.subscriptionRef)).toHaveLength(1)
    expect(logsOf(booted, projectRef, subscription.subscriptionRef).runs.find(run => run.trigger === 'webhook'))
      .toMatchObject({ category: 'exit-code', succeeded: false })
  })

  it('refuses a replay from a member who does not own the Project, and one for an unknown delivery', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const writer = await addLedgerMember(ledgerAtBoot(booted), projectRef, 'member:agent-writer', 'Writer', 'writer')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    const request: AgentTeamSubscriptionReplayRequest = { requestId: requestId('replay'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, deliveryRef: 'delivery:d1' }
    // The list is the owners' read: a delivery carries the body it arrived with.
    expect(() => seam.subscriptionDeliveries(writer.actor, { workspaceId, projectRef, subscriptionRef: subscription.subscriptionRef }))
      .toThrow(/project_owner_required/)
    await expect(seam.replaySubscriptionDelivery(writer.actor, request)).rejects.toThrow(/project_owner_required/)
    await expect(seam.replaySubscriptionDelivery(agentTeamHumanActor(), { ...request, deliveryRef: 'delivery:missing' }))
      .rejects.toThrow(/unknown or has expired/)
  })

  it('refuses a replay while the subscription is paused, and after it is deleted', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    const request: AgentTeamSubscriptionReplayRequest = { requestId: requestId('paused-replay'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, deliveryRef: 'delivery:d1' }
    const paused = await booted.ctx.agentTeam.pauseSubscription({ requestId: requestId('pause'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1 })
    if (paused.kind !== 'changed') throw new Error('expected a paused subscription')
    await expect(seam.replaySubscriptionDelivery(agentTeamHumanActor(), request)).rejects.toThrow(/subscription_paused/)
    // The list itself still reads while paused: it is how an owner decides whether to resume.
    expect(deliveriesOf(booted, projectRef, subscription.subscriptionRef)).toHaveLength(1)
    await booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: paused.subscription.revision })
    await expect(seam.replaySubscriptionDelivery(agentTeamHumanActor(), request)).rejects.toThrow(/subscription_deleted/)
  })

  it('counts one failure per spent delivery, and pauses at three however many retries ran', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    // Three automatic attempts at one delivery are still one failure.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await seam.recordFailedDelivery(subscription, deliveryInput(subscription, { attempts: attempt }))
    }
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(1)
    expect(seam.checkpointFor(subscription.subscriptionRef).lastSuccessAt).toBeUndefined()
    // Two more spent deliveries reach the threshold: the subscription pauses.
    for (const deliveryRef of ['delivery:d2', 'delivery:d3']) {
      await seam.recordFailedDelivery(subscription, deliveryInput(subscription, { deliveryRef }))
    }
    const paused = booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!.subscription
    expect(paused).toMatchObject({ state: 'paused', pausedReason: 'failures' })
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(SUBSCRIPTION_FAILURES_BEFORE_PAUSE)
  })

  it('clears the count when a replay delivers, and leaves it alone when the replay fails', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription, { deliveryRef: 'delivery:d1' }))
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription, { deliveryRef: 'delivery:d2' }))
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(2)
    // A refused replay changes nothing: the delivery already counted its failure.
    shell.exitCode = 1
    shell.stdout = ''
    expect((await seam.replaySubscriptionDelivery(agentTeamHumanActor(), { requestId: requestId('refused'), workspaceId,
      projectRef, subscriptionRef: subscription.subscriptionRef, deliveryRef: 'delivery:d2' })).kind).toBe('replay-failed')
    expect(seam.checkpointFor(subscription.subscriptionRef).consecutiveFailures).toBe(2)
    expect(seam.checkpointFor(subscription.subscriptionRef).lastSuccessAt).toBeUndefined()
    // A replay that delivers is a run that succeeded: the count clears and the
    // accepted output moves the last success.
    shell.exitCode = 0
    shell.stdout = '{"id":"b","title":"B"}\n'
    expect((await seam.replaySubscriptionDelivery(agentTeamHumanActor(), { requestId: requestId('delivered'), workspaceId,
      projectRef, subscriptionRef: subscription.subscriptionRef, deliveryRef: 'delivery:d1' })).kind).toBe('replayed')
    const checkpoint = seam.checkpointFor(subscription.subscriptionRef)
    expect(checkpoint.consecutiveFailures).toBe(0)
    expect(checkpoint.lastSuccessAt).toBeDefined()
  })

  it('is admitted like any other run: one at a time per subscription, and a pause that lands while it waits refuses it', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"c","title":"C"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription, { deliveryRef: 'delivery:d1' }))
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription,
      { deliveryRef: 'delivery:d2', receivedAt: Date.now() + 60_000 }))
    shell.requests.length = 0
    const release = deferred()
    shell.block = () => release.promise
    const scripts = (): number => shell.requests.filter(spec => !spec.command.includes('BASH_VERSION')).length

    const first = replayOf(seam, projectRef, subscription, 'delivery:d1', 'first')
    // A replay holds a run slot: the scheduler that admits timer runs sees it
    // running, and the script it started is the one blocked here.
    await waitFor(() => schedulerOf(booted).state().running.length === 1 && scripts() === 1 ? true : undefined)
    const second = replayOf(seam, projectRef, subscription, 'delivery:d2', 'second')
    // The second waits for the subscription's own slot instead of running beside it.
    await waitFor(() => schedulerOf(booted).state().queued.length === 1 ? true : undefined)
    expect(scripts()).toBe(1)

    // A pause that lands while the second one waits refuses it at admission, and
    // the first one — already executing — still finishes and records normally.
    expect((await booted.ctx.agentTeam.pauseSubscription({ requestId: requestId('pause'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1 })).kind).toBe('changed')
    release.resolve()
    expect((await first).kind).toBe('replayed')
    await expect(second).rejects.toThrow(/subscription_paused/)
    expect(scripts()).toBe(1)
    expect(logsOf(booted, projectRef, subscription.subscriptionRef).runs.filter(run => run.trigger === 'webhook')).toHaveLength(1)
  })

  it('reports a delivered replay as delivered even when only its run record cannot be written', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    // 'a' is the create baseline, so this replay prints nothing new: the only
    // private write the run performs is its own record.
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    // Targeted at the record alone: a counted fault would land on whichever write
    // came first, which is no longer this one.
    pool.writeFault = fault => fault.table === 'runs' && fault.operation === 'put' ? new Error('injected run write failure') : undefined
    const replayed = replayOf(seam, projectRef, subscription, 'delivery:d1', 'replay')
    const answered = await replayed
    // The record is a diagnostic copy. It failed; the run still succeeded, and a
    // caller told otherwise would run a delivery that already settled again.
    expect(answered).toMatchObject({ kind: 'replayed', eventCount: 0 })
    expect(answered.runRef).toBeDefined()
    expect(logsOf(booted, projectRef, subscription.subscriptionRef).runs.filter(run => run.trigger === 'webhook')).toHaveLength(0)
    // Everything that is not diagnostic did happen: the delivery left the failed
    // list, and the answer this request got is kept for a retry.
    expect(deliveriesOf(booted, projectRef, subscription.subscriptionRef)).toHaveLength(0)
    expect(replaysTable(booted).size).toBe(1)
  })

  it('treats the request id as the whole intent, and never runs a delivered replay again', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    // 'a' is what the create trial printed, so it is the baseline; 'c' is new.
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription, { deliveryRef: 'delivery:d1' }))
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription,
      { deliveryRef: 'delivery:d2', receivedAt: Date.now() + 60_000 }))
    shell.stdout = '{"id":"c","title":"C"}\n'
    shell.requests.length = 0
    const scripts = (): number => shell.requests.filter(spec => !spec.command.includes('BASH_VERSION')).length

    const first = await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once')
    expect(first).toMatchObject({ kind: 'replayed', eventCount: 1 })
    // The same id naming a second delivery is a collision, not a second run...
    await expect(replayOf(seam, projectRef, subscription, 'delivery:d2', 'once')).rejects.toThrow(/replay_request_conflict/)
    // ...and so is the same delivery asked for under the other version.
    await expect(replayOf(seam, projectRef, subscription, 'delivery:d1', 'once', 'received')).rejects.toThrow(/replay_request_conflict/)
    expect(scripts()).toBe(1)

    // A new request for a delivery that already delivered is refused: it left the
    // failed list, and running it again would publish the same output twice.
    await expect(replayOf(seam, projectRef, subscription, 'delivery:d1', 'twice')).rejects.toThrow(/delivery_replayed/)
    expect(scripts()).toBe(1)

    // The original request, retried, answers with what it did and runs nothing.
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once'))
      .toMatchObject({ kind: 'replayed', runRef: first.runRef, eventCount: 1 })
    expect(scripts()).toBe(1)
  })

  it('collides on the recorded intent even when no answer survived', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription, { deliveryRef: 'delivery:d1' }))
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription,
      { deliveryRef: 'delivery:d2', receivedAt: Date.now() + 60_000 }))
    shell.stdout = '{"id":"c","title":"C"}\n'
    // The answer never lands, so the record stays a running intent — and the
    // intent alone says which delivery and version this request named.
    pool.writeFault = fault => isSettledAnswer(fault) ? new Error('injected answer write failure') : undefined
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once'))
      .toMatchObject({ kind: 'replayed', eventCount: 1 })
    pool.writeFault = undefined
    // Nothing about the first attempt may be taken as "this request is free": it
    // named a delivery and a version, and a second naming is a collision.
    await expect(replayOf(seam, projectRef, subscription, 'delivery:d2', 'once')).rejects.toThrow(/replay_request_conflict/)
    await expect(replayOf(seam, projectRef, subscription, 'delivery:d1', 'once', 'received')).rejects.toThrow(/replay_request_conflict/)
  })

  it('does not rerun an empty replay whose answer was lost, and says so instead', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    // 'a' is the create baseline, so this replay accepts nothing: no ledger
    // record of it exists to recover, and the intent is the only thing left.
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    shell.requests.length = 0
    const scripts = (): number => shell.requests.filter(spec => !spec.command.includes('BASH_VERSION')).length
    pool.writeFault = fault => (isSettledAnswer(fault) || fault.table === 'deliveries' && fault.operation === 'put')
      ? new Error('injected answer write failure') : undefined
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once'))
      .toMatchObject({ kind: 'replayed', eventCount: 0 })
    expect(scripts()).toBe(1)
    pool.writeFault = undefined
    // Running it again would be a guess at what the first attempt did, and the
    // tool promises one request id is one run. The caller is told what happened.
    const retried = await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once')
    expect(retried).toMatchObject({ kind: 'replay-failed', eventCount: 0 })
    expect(retried.reason).toMatch(/never recorded its answer/)
    expect(scripts()).toBe(1)
  })

  it('keeps a request that died mid-run across a restart, and refuses to run it again', async () => {
    const pool = new MemoryMediaPool()
    const first = await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' }))
    const projectRef = await project(first)
    const subscription = await created(first, projectRef, 'printf events\n')
    const seam = seams(first)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    // A Host that dies between the script and its answer leaves the intent, and
    // nothing on disk says what that run did. The request id is the caller's.
    const request = requestId('once')
    await seam.recordReplayIntent(subscription, deliveryRecordOf(subscription, deliveryInput(subscription), undefined),
      request, 'received')
    const replayRow = replayKey(subscription.subscriptionRef, request)
    expect(replaysTable(first).get(replayRow)).toMatchObject({ requestId: request, deliveryRef: 'delivery:d1', state: 'running' })
    await first.fiber.dispose()

    const shell = fakeShell({ stdout: '{"id":"c","title":"C"}\n' })
    const second = keep(await boot(pool, shell))
    // The next boot keeps the row: its subscription is still served, and an
    // unanswered request is a pending fact, not garbage to collect.
    expect(replaysTable(second).get(replayRow)).toMatchObject({ state: 'running' })
    shell.requests.length = 0
    const retried = await replayOf(seams(second), projectRef, subscription, 'delivery:d1', 'once', 'received')
    expect(retried).toMatchObject({ kind: 'replay-failed' })
    expect(retried.reason).toMatch(/never recorded its answer/)
    expect(shell.requests.filter(spec => !spec.command.includes('BASH_VERSION'))).toHaveLength(0)
  })

  it('takes a delivery off the failed list when only its answer survived, and refuses a second request', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    shell.stdout = '{"id":"c","title":"C"}\n'
    shell.requests.length = 0
    const scripts = (): number => shell.requests.filter(spec => !spec.command.includes('BASH_VERSION')).length
    // The answer lands and the tombstone does not: the delivery row alone would
    // still look replayable, and running it again would publish this output twice.
    pool.writeFault = fault => isTombstone(fault) ? new Error('injected tombstone write failure') : undefined
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'replay'))
      .toMatchObject({ kind: 'replayed', eventCount: 1 })
    expect(scripts()).toBe(1)
    pool.writeFault = undefined
    expect(deliveriesOf(booted, projectRef, subscription.subscriptionRef)).toHaveLength(0)
    await expect(replayOf(seam, projectRef, subscription, 'delivery:d1', 'second')).rejects.toThrow(/delivery_replayed/)
    expect(scripts()).toBe(1)
  })

  it('takes a delivery off the failed list when only the ledger remembers it delivered', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    shell.stdout = '{"id":"c","title":"C"}\n'
    shell.requests.length = 0
    const scripts = (): number => shell.requests.filter(spec => !spec.command.includes('BASH_VERSION')).length
    // Both private copies go missing, so the request stays a `running` intent and
    // the accept is the only record that this delivery delivered. It is enough:
    // the ledger's own fact outranks a row that was never written.
    pool.writeFault = fault => (isSettledAnswer(fault) || isTombstone(fault))
      ? new Error('injected answer and tombstone write failure') : undefined
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'replay'))
      .toMatchObject({ kind: 'replayed', eventCount: 1 })
    expect(scripts()).toBe(1)
    pool.writeFault = undefined
    expect(deliveriesOf(booted, projectRef, subscription.subscriptionRef)).toHaveLength(0)
    await expect(replayOf(seam, projectRef, subscription, 'delivery:d1', 'second')).rejects.toThrow(/delivery_replayed/)
    expect(scripts()).toBe(1)
  })

  it('runs a repeated request id once when two calls arrive together', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    shell.stdout = '{"id":"c","title":"C"}\n'
    shell.requests.length = 0
    const release = deferred()
    shell.block = () => release.promise
    const first = replayOf(seam, projectRef, subscription, 'delivery:d1', 'together')
    await waitFor(() => schedulerOf(booted).state().running.length === 1 ? true : undefined)
    const second = replayOf(seam, projectRef, subscription, 'delivery:d1', 'together')
    await waitFor(() => schedulerOf(booted).state().queued.length === 1 ? true : undefined)
    release.resolve()
    const [answered, repeated] = await Promise.all([first, second])
    // The second one sees the first one's answer instead of starting a second
    // run: the tombstone it must read is written before the slot is released.
    expect(repeated).toMatchObject({ kind: 'replayed', runRef: answered.runRef })
    expect(shell.requests.filter(spec => !spec.command.includes('BASH_VERSION'))).toHaveLength(1)
  })

  it('writes nothing back for a replay that finishes after the deletion', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    // The replay prints an id the subscription has not accepted yet, so its run
    // really has an accept to attempt after the deletion.
    shell.stdout = '{"id":"c","title":"C"}\n'
    const release = deferred()
    shell.block = () => release.promise
    const replay = replayOf(seam, projectRef, subscription, 'delivery:d1', 'replay')
    await waitFor(() => schedulerOf(booted).state().running.length === 1 ? true : undefined)
    // The deletion drops every row while the script is still running.
    expect((await booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1 })).kind).toBe('changed')
    expect(deliveriesTable(booted).size).toBe(0)
    release.resolve()
    expect(await replay).toMatchObject({ kind: 'replay-failed' })
    // The run's output was dropped by the terminal barrier, and the answer it
    // would have kept did not rebuild a single row.
    expect(runsTable(booted).size).toBe(0)
    expect(deliveriesTable(booted).size).toBe(0)
    expect(replaysTable(booted).size).toBe(0)
    expect(checkpointsTable(booted).size).toBe(0)
  })

  it('answers a replay whose delivery answer cannot be written, and runs nothing when the request is retried', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    shell.stdout = '{"id":"c","title":"C"}\n'
    shell.requests.length = 0
    const scripts = (): number => shell.requests.filter(spec => !spec.command.includes('BASH_VERSION')).length
    // The output is accepted first; the row that remembers the delivery is not
    // written at all. The run still delivered, so the call must say so.
    pool.writeFault = fault => fault.table === 'deliveries' && fault.operation === 'put'
      ? new Error('injected delivery write failure') : undefined
    const first = await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once')
    expect(first).toMatchObject({ kind: 'replayed', eventCount: 1 })
    expect(scripts()).toBe(1)
    pool.writeFault = undefined
    // The request's own answer survived, so the retry reads it and never reruns.
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once'))
      .toMatchObject({ kind: 'replayed', eventCount: 1, runRef: first.runRef })
    expect(scripts()).toBe(1)
  })

  it('refuses to run a replay whose request cannot be recorded, and runs it once when the request is retried', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    shell.stdout = '{"id":"c","title":"C"}\n'
    shell.requests.length = 0
    const scripts = (): number => shell.requests.filter(spec => !spec.command.includes('BASH_VERSION')).length
    // The request record is what makes the id an intent. Without it the call
    // cannot promise anything, so it does not run the script at all.
    pool.writeFault = fault => fault.table === 'replays' && fault.operation === 'put'
      ? new Error('injected intent write failure') : undefined
    await expect(replayOf(seam, projectRef, subscription, 'delivery:d1', 'once')).rejects.toThrow(/injected intent write failure/)
    expect(scripts()).toBe(0)
    expect(replaysTable(booted).size).toBe(0)
    pool.writeFault = undefined
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once'))
      .toMatchObject({ kind: 'replayed', eventCount: 1 })
    expect(scripts()).toBe(1)
  })

  it('recovers the answer from the ledger when only the settled answer cannot be written', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    shell.stdout = '{"id":"c","title":"C"}\n'
    shell.requests.length = 0
    const scripts = (): number => shell.requests.filter(spec => !spec.command.includes('BASH_VERSION')).length
    // The first write of the request record is the intent; the second is the
    // answer. Only the answer fails, so the intent survives as `running`.
    pool.writeFault = fault => (isSettledAnswer(fault) || fault.table === 'deliveries' && fault.operation === 'put')
      ? new Error('injected answer write failure') : undefined
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once'))
      .toMatchObject({ kind: 'replayed', eventCount: 1 })
    expect(scripts()).toBe(1)
    pool.writeFault = undefined
    // The intent says the request started, and the ledger holds what it
    // accepted: that accept is the answer the retry reads back, so it neither
    // runs the script again nor reports a result nobody can retrieve.
    const recovered = await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once')
    expect(recovered).toMatchObject({ kind: 'replayed', eventCount: 1 })
    expect(scripts()).toBe(1)
    // Recovery settles the record too, so a third call reads it instead of
    // consulting the ledger again.
    expect(await replayOf(seam, projectRef, subscription, 'delivery:d1', 'once')).toMatchObject({ kind: 'replayed', eventCount: 1 })
    const settled = replaysTable(booted).get(replayKey(subscription.subscriptionRef, requestId('once'))) as { state?: string } | undefined
    expect(settled?.state).toBe('settled')
    expect(scripts()).toBe(1)
  })

  it('writes nothing back when the deletion lands while the success checkpoint is waiting', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    // A new id, so the accept clears the streak and that write is the one held.
    shell.stdout = '{"id":"c","title":"C"}\n'
    const stalled = deferred()
    const release = deferred()
    let caught = false
    pool.writeStall = fault => {
      if (!isSuccessCheckpoint(fault) || caught) return undefined
      caught = true
      stalled.resolve()
      return release.promise
    }
    const replay = replayOf(seam, projectRef, subscription, 'delivery:d1', 'replay')
    await stalled.promise
    // The deletion commits its ledger fact while the replay is inside the write
    // that clears its streak, so every write after it must read the barrier
    // again instead of trusting the one it passed at the top.
    const deleted = booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1 })
    release.resolve()
    // The output the ledger accepted before the deletion was delivered, and the
    // call says so; the rows, all of them, belong to the cleanup after it.
    expect(await replay).toMatchObject({ kind: 'replayed', eventCount: 1 })
    expect((await deleted).kind).toBe('changed')
    expect(runsTable(booted).size).toBe(0)
    expect(deliveriesTable(booted).size).toBe(0)
    expect(replaysTable(booted).size).toBe(0)
    expect(checkpointsTable(booted).size).toBe(0)
  })

  it('orders the deletion after the whole answer, so a write that came later cannot survive it', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    shell.stdout = '{"id":"c","title":"C"}\n'
    // Held at the request's own answer, before the delivery's tombstone and the
    // end of the segment: the deletion can complete inside this window, and the
    // writes it left pending must not outlive it.
    const stalled = deferred()
    const release = deferred()
    const table = seam.subscriptionReplaysTable
    if (table === undefined) throw new Error('expected the replay answers table')
    const put = table.put.bind(table)
    // Holds the settled answer, with the delivery's tombstone still to come
    // behind it: the intent itself has already been written.
    table.put = async (key, value) => {
      if ((value as SubscriptionReplayRecord | undefined)?.state === 'settled') {
        stalled.resolve()
        await release.promise
      }
      return put(key, value)
    }
    const replay = replayOf(seam, projectRef, subscription, 'delivery:d1', 'replay')
    await stalled.promise
    const deleted = booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1 })
    let settled = false
    void deleted.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    // The tombstone is already on the medium; the cleanup waits for the segment
    // that owns it instead of deleting around a write it cannot see.
    expect(settled).toBe(false)
    release.resolve()
    expect(await replay).toMatchObject({ kind: 'replayed', eventCount: 1 })
    expect((await deleted).kind).toBe('changed')
    expect(deliveriesTable(booted).size).toBe(0)
    expect(replaysTable(booted).size).toBe(0)
    expect(runsTable(booted).size).toBe(0)
    expect(checkpointsTable(booted).size).toBe(0)
  })

  it('takes the subscription write lock for the cleanup, so no private write can land inside it', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    expect(deliveriesTable(booted).size).toBe(1)
    // The replay's own answer commits under this lock, so the cleanup has to wait
    // on it: a cleanup that dropped the rows beside a pending write would be
    // undone by that write.
    const held = deferred()
    const release = deferred()
    const holding = seam.serializeSubscriptionWrite(subscription.subscriptionRef, async () => {
      held.resolve()
      await release.promise
    })
    await held.promise
    const deleted = booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1 })
    let settled = false
    void deleted.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    release.resolve()
    await holding
    expect((await deleted).kind).toBe('changed')
    // The rows the deletion owns are gone whether or not it had to wait, and the
    // report of it is only about the ledger fact.
    expect(deliveriesTable(booted).size).toBe(0)
    expect(checkpointsTable(booted).size).toBe(0)
  })

  it('drops a run whose record was already in the write queue when the deletion committed', async () => {
    const pool = new MemoryMediaPool()
    const booted = keep(await boot(pool, fakeShell({ stdout: '{"id":"a","title":"A"}\n' })))
    const projectRef = await project(booted)
    const subscription = await created(booted, projectRef, 'printf events\n')
    // The trial's record is the write in flight: it is decided after the deletion
    // has started cleaning up, and it is one of the rows that cleanup owns.
    const runs = seams(booted).subscriptionRunsTable
    if (runs === undefined) throw new Error('expected the run records table')
    const stalled = deferred()
    const release = deferred()
    const put = runs.put.bind(runs)
    runs.put = async (key, value) => {
      stalled.resolve()
      await release.promise
      return put(key, value)
    }
    const trial = booted.ctx.agentTeam.testSubscriptionForClient({ workspaceId, projectRef, subscriptionRef: subscription.subscriptionRef })
    await stalled.promise
    const deleted = booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1 })
    let settled = false
    void deleted.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 50))
    // The cleanup waits for the segment that is writing this subscription's
    // private state, so the record cannot land behind it.
    expect(settled).toBe(false)
    release.resolve()
    expect((await deleted).kind).toBe('changed')
    await trial
    expect(runsTable(booted).size).toBe(0)
    expect(deliveriesTable(booted).size).toBe(0)
    expect(replaysTable(booted).size).toBe(0)
    expect(checkpointsTable(booted).size).toBe(0)
  })

  it('does not report a run that printed nothing new as delivered when it finished after the deletion', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = keep(await boot(pool, shell))
    const projectRef = await project(booted)
    // 'a' is already the baseline, so this run has no accept to refuse: without a
    // barrier of its own it would look like a success and write its answer back.
    const subscription = await created(booted, projectRef, 'printf events\n')
    const seam = seams(booted)
    await seam.recordFailedDelivery(subscription, deliveryInput(subscription))
    const release = deferred()
    shell.block = () => release.promise
    const replay = replayOf(seam, projectRef, subscription, 'delivery:d1', 'replay')
    await waitFor(() => schedulerOf(booted).state().running.length === 1 ? true : undefined)
    expect((await booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef,
      subscriptionRef: subscription.subscriptionRef, expectedRevision: 1 })).kind).toBe('changed')
    release.resolve()
    expect(await replay).toMatchObject({ kind: 'replay-failed' })
    expect(runsTable(booted).size).toBe(0)
    expect(deliveriesTable(booted).size).toBe(0)
    expect(replaysTable(booted).size).toBe(0)
    expect(checkpointsTable(booted).size).toBe(0)
  })
})
