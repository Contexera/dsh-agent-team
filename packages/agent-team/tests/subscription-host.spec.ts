/**
 * The Host side of a subscription: the trial that gates a write, the request a
 * timer run really builds, the ledger facts it produces, and the Main stream
 * entry the Human then reads. The executor and the credential store are fakes,
 * so this spec proves the Host's own decisions; what a real executor does with
 * the policy it is handed is the cross-platform enforcement probe's job.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { subscriptionDomainSpec } from '../src/subscription-store.ts'
import type { AgentTeamCreateSubscriptionRequest, AgentTeamProjectRef, AgentTeamRequestId, AgentTeamSubscriptionRef } from '../src/types.ts'

const workspaceId = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

interface FakeShell {
  readonly requests: ShellExecSpec[]
  /** What the next script run prints, per trigger; the trial and a timer run read different answers here. */
  stdout: string
  exitCode: number
  readonly service: {
    resolve(request: ShellExecSpec): ShellExecSpec
    execute(spec: ShellExecSpec): Promise<{ result(): Promise<ShellRunResult> }>
  }
}

function fakeShell(options: { readonly stdout: string; readonly exitCode?: number }): FakeShell {
  const requests: ShellExecSpec[] = []
  const state = { stdout: options.stdout, exitCode: options.exitCode ?? 0 }
  return {
    requests,
    get stdout() { return state.stdout },
    set stdout(value: string) { state.stdout = value },
    get exitCode() { return state.exitCode },
    set exitCode(value: number) { state.exitCode = value },
    service: {
      // The Host resolves and then hands the spec straight to `execute`; a real
      // executor fills defaults here, and the assertions below cover what the
      // Host itself must specify.
      resolve: (request: ShellExecSpec) => request,
      execute: async (spec: ShellExecSpec) => {
        requests.push(spec)
        const isProbe = spec.command.includes('BASH_VERSION')
        const answer = (): ShellRunResult => ({
          exitCode: isProbe ? 0 : state.exitCode,
          signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: isProbe ? '5.2.15' : state.stdout, truncated: false },
          stderr: { text: '', truncated: false },
        })
        return { result: async () => answer() }
      },
    },
  }
}

/**
 * A shell whose script runs block until released, so a test can watch how many
 * of them the Host really starts at once. Probes answer immediately.
 */
interface GatedShell {
  /** Every execution the Host asked for, so a script that must not run is provably absent. */
  readonly requests: ShellExecSpec[]
  /** Script executions holding the shell right now. */
  running(): number
  /** The most that ever ran together. */
  peak(): number
  /** Open one blocked run. */
  release(): void
  readonly service: FakeShell['service']
}

function gatedShell(stdout: string): GatedShell {
  let active = 0
  let peak = 0
  const requests: ShellExecSpec[] = []
  const gates: Array<() => void> = []
  return {
    requests,
    running: () => active,
    peak: () => peak,
    release: () => { gates.shift()?.() },
    service: {
      resolve: (request: ShellExecSpec) => request,
      execute: async (spec: ShellExecSpec) => {
        requests.push(spec)
        const isProbe = spec.command.includes('BASH_VERSION')
        if (!isProbe) {
          active += 1
          peak = Math.max(peak, active)
          await new Promise<void>(resolve => { gates.push(resolve) })
          active -= 1
        }
        return { result: async () => ({
          exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
          stdout: { text: isProbe ? '5.2.15' : stdout, truncated: false },
          stderr: { text: '', truncated: false },
        }) }
      },
    },
  }
}

const credentialValues: Record<string, string> = { GH_TOKEN: 'secret-value' }

async function boot(pool: MemoryMediaPool, shell: Pick<FakeShell, 'service'>, workspaceRoot = process.cwd()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', { get: (id: WorkspaceId) => id === workspaceId ? { id, path: workspaceRoot, attachSession: async () => {} } : undefined,
    list: () => [] })
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

interface Disposable { dispose(): Promise<void> }
const live: Disposable[] = []
afterEach(async () => {
  await Promise.all(live.splice(0).map(handle => handle.dispose()))
})

async function project(booted: Awaited<ReturnType<typeof boot>>): Promise<AgentTeamProjectRef> {
  const created = await booted.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId, name: 'alpha', description: '' })
  return created.project.projectRef
}

const createRequest = (projectRef: AgentTeamProjectRef, scriptContent: string, overrides: Partial<AgentTeamCreateSubscriptionRequest> = {}): AgentTeamCreateSubscriptionRequest => ({
  requestId: requestId('subscription'), workspaceId, projectRef, name: 'main CI', intervalMinutes: 10,
  script: { scriptContent }, credentials: [{ ref: 'GH_TOKEN', env: 'GH_TOKEN' }], ...overrides,
})

describe('creating a subscription', () => {
  it('runs the trial under the production request, then stores what that trial printed as the baseline', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    shell.requests.length = 0
    const result = await booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n'))
    expect(result.kind).toBe('changed')
    const trial = shell.requests.at(-1)!
    expect(trial.workdir).toBe(process.cwd())
    expect(trial.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: process.cwd() })
    expect(trial.timeoutMs).toBe(60_000)
    expect(trial.stdoutMaxBytes).toBe(65_536)
    expect(trial.env).toMatchObject({ DSH_TEAM_TRIGGER: 'test', DSH_TEAM_PROJECT: projectRef, GH_TOKEN: 'secret-value' })
    expect(JSON.parse(trial.stdin ?? '{}')).toMatchObject({ body: '{"test":true}' })
    // The trial's ids are the waterline: the first live run publishes nothing new.
    const listed = booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef })
    expect(listed.entries).toHaveLength(1)
    expect(listed.entries[0]!.unpublished).toBe(0)
    expect(listed.entries[0]!.subscription.state).toBe('active')
  })

  it('refuses the write when the trial fails, and returns the tails that explain it', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: 'not json\n' })
    const booted = await boot(pool, shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const result = await booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n'))
    expect(result.kind).toBe('trial-failed')
    if (result.kind !== 'trial-failed') throw new Error('expected a refused trial')
    expect(result.failure.reason).toMatch(/line 1/)
    expect(result.failure.stdoutTail).toBe('not json\n')
    expect(booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries).toHaveLength(0)
  })

  it('refuses a credential the Host has not been given, before the script runs', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    shell.requests.length = 0
    await expect(booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n',
      { credentials: [{ ref: 'MISSING_TOKEN', env: 'MISSING_TOKEN' }] }))).rejects.toThrow(/'MISSING_TOKEN'/)
    // The shell probe may have run; the script itself never did.
    expect(shell.requests.filter(spec => spec.command === 'printf events\n')).toHaveLength(0)
  })
})

describe('a page trial of a draft', () => {
  it('runs the form definition through the production path without storing anything', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"draft","title":"Draft"}\n' })
    const booted = await boot(pool, shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    shell.requests.length = 0
    const script = 'printf draft\n'
    const result = await booted.ctx.agentTeam.testSubscriptionDraft({
      workspaceId, projectRef, name: 'draft', intervalMinutes: 10, scriptContent: script, credentials: [],
    })
    expect(result.kind).toBe('tested')
    if (result.kind !== 'tested') throw new Error('expected a passing trial')
    expect(result.revision).toBe(1)
    expect(result.scriptHash).toBe(createHash('sha256').update(script, 'utf8').digest('hex'))
    expect(result.events.map(event => event.id)).toEqual(['draft'])
    expect(shell.requests.find(spec => spec.command === script)!.env).toMatchObject({ DSH_TEAM_TRIGGER: 'test' })
    // Nothing durable: no subscription, and the throwaway create ref left no run record behind.
    expect(booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries).toHaveLength(0)
  })

  it('tests an edit against its stored revision and records only the test run', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"stored","title":"Stored"}\n' })
    const booted = await boot(pool, shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf stored\n'))
    if (created.kind !== 'changed') throw new Error('expected a created subscription')
    const subscriptionRef = created.subscription.subscriptionRef
    shell.requests.length = 0
    const result = await booted.ctx.agentTeam.testSubscriptionDraft({
      workspaceId, projectRef, subscriptionRef, expectedRevision: 1, name: 'renamed', intervalMinutes: 15,
      scriptContent: 'printf edited\n', credentials: [],
    })
    expect(result.kind).toBe('tested')
    expect(result.revision).toBe(1)
    const stored = booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!
    expect(stored.subscription.name).toBe('main CI')
    expect(stored.subscription.revision).toBe(1)
    const logs = booted.ctx.agentTeam.subscriptionLogsForClient({ workspaceId, projectRef, subscriptionRef })
    expect(logs.runs[0]!.trigger).toBe('test')
    expect(logs.runs[0]!.category).toBe('verified')
    expect(logs.runs).toHaveLength(1)
    await expect(booted.ctx.agentTeam.testSubscriptionDraft({
      workspaceId, projectRef, subscriptionRef, expectedRevision: 2, name: 'renamed', intervalMinutes: 15,
      scriptContent: 'printf edited\n', credentials: [],
    })).rejects.toThrow(/stale_revision/)
  })
})

describe('a timer run', () => {
  it('executes the stored snapshot, accepts its new events, and publishes them to the Main stream', async () => {
    const pool = new MemoryMediaPool()
    const trialShell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const first = await boot(pool, trialShell)
    const projectRef = await project(first)
    const created = await first.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n'))
    if (created.kind !== 'changed') throw new Error('expected a created subscription')
    const subscriptionRef = created.subscription.subscriptionRef
    await first.fiber.dispose()

    // The second boot inherits the ledger and the checkpoint: a due instant in
    // the past is exactly what a Host restart after a missed run reads.
    const runShell = fakeShell({ stdout: '{"id":"b","title":"B"}\n' })
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    const domain = await facility.open(subscriptionDomainSpec)
    await domain.table('checkpoints').put(subscriptionRef as AgentTeamSubscriptionRef,
      { subscriptionRef: subscriptionRef as AgentTeamSubscriptionRef, dueAt: Date.now() - 1, consecutiveFailures: 0, publishedInWindow: 0 })
    // The plugin opens the domain itself at boot; a seeded row must not hold it.
    await domain.close()
    ctx.provide('storageDomain', facility)
    ctx.provide('workspaceRegistry', { get: (id: WorkspaceId) => id === workspaceId ? { id, path: process.cwd(), attachSession: async () => {} } : undefined, list: () => [] })
    ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
    ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
    ctx.provide('tools', { schemas: () => [] })
    ctx.provide('sessionPersistence', { list: async () => [] })
    ctx.provide('shell', runShell.service)
    ctx.provide('credentials', {
      resolve: async (ref: string) => credentialValues[ref] === undefined ? undefined : { value: credentialValues[ref], source: 'fixture' },
      describe: async (ref: string) => ({ configured: credentialValues[ref] !== undefined, writable: false }),
    })
    ctx.provide('tokenMeter', { estimateMessage: () => 0, measure: () => ({ totalTokens: 0, nodes: [] }) })
    await ctx.plugin(SessionProjectionRegistry)
    const fiber = await ctx.plugin(AgentTeam)
    live.push({ dispose: async () => { await fiber.dispose() } })

    const published = await waitFor(() => {
      const entries = ctx.agentTeam.mainStreamHistory({ workspaceId, projectRef, limit: 20 }).entries
      return entries.filter(entry => entry.kind === 'subscription-event').length > 0 ? entries : undefined
    })
    const event = published.find(entry => entry.kind === 'subscription-event')
    if (event === undefined || event.kind !== 'subscription-event') throw new Error('expected a subscription event')
    expect(event.event.event.id).toBe('b')
    expect(event.event.event.title).toBe('B')
    expect(event.direct).toBe(true)
    const run = runShell.requests.find(spec => spec.command === 'printf events\n')!
    expect(run.workdir).toBe(process.cwd())
    expect(run.env).toMatchObject({ DSH_TEAM_TRIGGER: 'interval' })
    const listed = ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!
    expect(listed.lastRun).toMatchObject({ trigger: 'interval', succeeded: true, eventCount: 1 })
    expect(listed.eventCount).toBe(1)
    expect(listed.lastEventAt).toBeDefined()
    expect(listed.nextRunAt).toBeDefined()
  })
})

describe('one admission for trials and timer runs', () => {
  it('never runs more than four scripts at once across five concurrent creates', async () => {
    const pool = new MemoryMediaPool()
    const shell = gatedShell('{"id":"a","title":"A"}\n')
    const booted = await boot(pool, shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)

    // Five owners' worth of concurrent creates: every one of them runs a trial,
    // and a trial is a run slot, not a second kind of capacity.
    const creates = Array.from({ length: 5 }, (_, index) => booted.ctx.agentTeam.createSubscription(
      createRequest(projectRef, 'printf events\n', { requestId: requestId(`burst-${index}`), name: `burst ${index}` })))
    await waitFor(() => shell.running() === 4 ? true : undefined)
    expect(shell.peak()).toBe(4)
    for (let step = 0; step < 5; step += 1) {
      shell.release()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const results = await Promise.all(creates)
    expect(results.every(result => result.kind === 'changed')).toBe(true)
    expect(shell.peak()).toBe(4)
    expect(shell.running()).toBe(0)
  })
})

describe('the terminal barrier a queued trial obeys', () => {
  /** The scheduler's own state, so a test can wait for a trial to really be queued. */
  interface AdmissionSeam {
    readonly subscriptionScheduler: { state(): { readonly queued: readonly string[] } }
  }

  /** Hold all four slots with creates whose trials the test releases later. */
  async function occupyEverySlot(booted: Awaited<ReturnType<typeof boot>>, shell: GatedShell,
    projectRef: AgentTeamProjectRef): Promise<Array<Promise<unknown>>> {
    // Handled from the start: a create that loses to a delete or an archive
    // rejects while this helper is still waiting for the slots to fill.
    const burst = Array.from({ length: 4 }, (_, index) => booted.ctx.agentTeam.createSubscription(
      createRequest(projectRef, 'printf burst\n', { requestId: requestId(`burst-${index}`), name: `burst ${index}` }))
      .then(result => result as unknown, error => error as unknown))
    await waitFor(() => shell.running() === 4 ? true : undefined)
    return burst
  }

  /** Create one subscription and release the trial that gates it. */
  async function storeVictim(booted: Awaited<ReturnType<typeof boot>>, shell: GatedShell,
    projectRef: AgentTeamProjectRef): Promise<AgentTeamSubscriptionRef> {
    const created = booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf victim-script\n'))
    await waitFor(() => shell.running() === 1 ? true : undefined)
    shell.release()
    const victim = await created
    if (victim.kind !== 'changed') throw new Error('expected a created subscription')
    return victim.subscription.subscriptionRef
  }

  const executions = (shell: GatedShell): number => shell.requests.filter(spec => spec.command === 'printf victim-script\n').length

  it('refuses a trial that was still queued when the subscription was deleted, and never runs the script', async () => {
    const pool = new MemoryMediaPool()
    const shell = gatedShell('{"id":"a","title":"A"}\n')
    const booted = await boot(pool, shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const subscriptionRef = await storeVictim(booted, shell, projectRef)
    expect(executions(shell)).toBe(1)
    const burst = await occupyEverySlot(booted, shell, projectRef)

    const seam = booted.ctx.agentTeam as unknown as AdmissionSeam
    const tested = booted.ctx.agentTeam.testSubscriptionForClient({ workspaceId, projectRef, subscriptionRef })
    // The refusal lands between the releases below, so it is captured here
    // instead of left floating until the assertion attaches a handler.
    const refusal = tested.then(() => undefined, (error: unknown) => error)
    await waitFor(() => seam.subscriptionScheduler.state().queued.includes(subscriptionRef) ? true : undefined)

    // The delete lands while the trial waits for a slot.
    const deleted = await booted.ctx.agentTeam.deleteSubscription({
      requestId: requestId('delete-victim'), workspaceId, projectRef, subscriptionRef, expectedRevision: 1 })
    if (deleted.kind !== 'changed') throw new Error('expected a deleted subscription')
    expect(deleted.subscription.state).toBe('deleted')
    for (let step = 0; step < 4; step += 1) {
      shell.release()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(String(await refusal)).toMatch(/deleted while this trial waited/)
    // Refusing is not enough: the script itself never ran a second time.
    expect(executions(shell)).toBe(1)
    await Promise.all(burst)
  }, 30_000)

  it('refuses a trial that was still queued when the Project was archived, and never runs the script', async () => {
    const pool = new MemoryMediaPool()
    const shell = gatedShell('{"id":"a","title":"A"}\n')
    const booted = await boot(pool, shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const subscriptionRef = await storeVictim(booted, shell, projectRef)
    expect(executions(shell)).toBe(1)
    const burst = await occupyEverySlot(booted, shell, projectRef)

    const seam = booted.ctx.agentTeam as unknown as AdmissionSeam
    const tested = booted.ctx.agentTeam.testSubscriptionForClient({ workspaceId, projectRef, subscriptionRef })
    // The refusal lands between the releases below, so it is captured here
    // instead of left floating until the assertion attaches a handler.
    const refusal = tested.then(() => undefined, (error: unknown) => error)
    await waitFor(() => seam.subscriptionScheduler.state().queued.includes(subscriptionRef) ? true : undefined)

    await booted.ctx.agentTeam.archiveProject({ requestId: requestId('archive-alpha'), workspaceId, projectRef })
    for (let step = 0; step < 4; step += 1) {
      shell.release()
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(String(await refusal)).toMatch(/archived while this trial waited/)
    expect(executions(shell)).toBe(1)
    // The four creates that were already in flight lose their write to the same
    // archive; their trials ran, so only the victim's script matters here.
    await Promise.allSettled(burst)
  }, 30_000)
})

describe('the terminal barrier a run in flight obeys', () => {
  it('records nothing when the run is dropped, so a deleted subscription keeps no checkpoint', async () => {
    const pool = new MemoryMediaPool()
    const setupShell = fakeShell({ stdout: '{"id":"b","title":"B"}\n' })
    const first = await boot(pool, setupShell)
    const projectRef = await project(first)
    const created = await first.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n'))
    if (created.kind !== 'changed') throw new Error('expected a created subscription')
    const subscriptionRef = created.subscription.subscriptionRef as AgentTeamSubscriptionRef
    await first.fiber.dispose()

    const seededDueAt = Date.now() - 1
    const seedCtx = new Context()
    await seedCtx.plugin(Storage)
    seedCtx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const seedFacility = new DomainFacility(seedCtx, { backend: 'memory', routes: {} })
    seedCtx.storage.mount('domain', seedFacility)
    const seedDomain = await seedFacility.open(subscriptionDomainSpec)
    await seedDomain.table('checkpoints').put(subscriptionRef,
      { subscriptionRef, dueAt: seededDueAt, consecutiveFailures: 0, publishedInWindow: 0 })
    await seedDomain.close()

    const shell = gatedShell('{"id":"c","title":"C"}\n')
    const second = await boot(pool, shell)
    live.push({ dispose: async () => { await second.fiber.dispose() } })
    const seam = second.ctx.agentTeam as unknown as {
      subscriptionTable?: { get(ref: unknown): Promise<unknown> }
      checkpointFor(ref: unknown): { dueAt?: number }
      subscriptionScheduler: { state(): { readonly running: readonly unknown[] } }
    }
    await waitFor(() => shell.running() === 1 ? true : undefined)

    // The operator deletes the subscription while its script still runs.
    await second.ctx.agentTeam.deleteSubscription({
      requestId: requestId('delete-victim'), workspaceId, projectRef, subscriptionRef, expectedRevision: 1 })
    shell.release()
    await waitFor(() => seam.subscriptionScheduler.state().running.length === 0 ? true : undefined)

    // The dropped run must not revive what the deletion removed: no live
    // checkpoint, and no durable row advanced to a fresh due instant.
    expect(seam.checkpointFor(subscriptionRef).dueAt).toBeUndefined()
    const row = await seam.subscriptionTable?.get(subscriptionRef) as { readonly dueAt?: number } | undefined
    expect(row === undefined || row.dueAt === seededDueAt).toBe(true)
  }, 30_000)
})

describe('the scheduler checkpoint and Host shutdown', () => {
  /** The durability seam a Host keeps private: the write order is the contract under test. */
  interface CheckpointSeam {
    updateCheckpoint(ref: AgentTeamSubscriptionRef,
      change: (checkpoint: { readonly dueAt?: number | undefined; readonly consecutiveFailures: number }) => unknown): Promise<unknown>
    checkpointFor(ref: AgentTeamSubscriptionRef): { readonly dueAt?: number | undefined; readonly consecutiveFailures: number }
  }

  it('writes the checkpoint durably before the live projection, so a storage failure cannot fork them', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n'))
    if (created.kind !== 'changed') throw new Error('expected a created subscription')
    const seam = booted.ctx.agentTeam as unknown as CheckpointSeam
    const ref = created.subscription.subscriptionRef as AgentTeamSubscriptionRef
    const before = seam.checkpointFor(ref)

    pool.injectedWriteFailuresRemaining = 1
    await expect(seam.updateCheckpoint(ref, checkpoint => ({ ...checkpoint, dueAt: 123_456 })))
      .rejects.toThrow(/injected write failure/)
    // The durable write failed, so the live checkpoint must still hold the old value.
    expect(seam.checkpointFor(ref)).toEqual(before)
    expect(seam.checkpointFor(ref).dueAt).toBeUndefined()

    await seam.updateCheckpoint(ref, checkpoint => ({ ...checkpoint, dueAt: 123_456 }))
    expect(seam.checkpointFor(ref).dueAt).toBe(123_456)
  })

  it('finishes an in-flight run before it closes the stores', async () => {
    const pool = new MemoryMediaPool()
    const setupShell = fakeShell({ stdout: '{"id":"b","title":"B"}\n' })
    const first = await boot(pool, setupShell)
    const projectRef = await project(first)
    const created = await first.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n'))
    if (created.kind !== 'changed') throw new Error('expected a created subscription')
    const subscriptionRef = created.subscription.subscriptionRef as AgentTeamSubscriptionRef
    await first.fiber.dispose()

    // A restart whose stored due instant is already past: the timer run starts
    // at boot, and this shell holds it open until the test says so.
    const seedCtx = new Context()
    await seedCtx.plugin(Storage)
    seedCtx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const seedFacility = new DomainFacility(seedCtx, { backend: 'memory', routes: {} })
    seedCtx.storage.mount('domain', seedFacility)
    const seedDomain = await seedFacility.open(subscriptionDomainSpec)
    await seedDomain.table('checkpoints').put(subscriptionRef,
      { subscriptionRef, dueAt: Date.now() - 1, consecutiveFailures: 0, publishedInWindow: 0 })
    await seedDomain.close()
    const shell = gatedShell('{"id":"c","title":"C"}\n')
    const second = await boot(pool, shell)
    const seam = second.ctx.agentTeam as unknown as { checkpointFor(ref: unknown): { dueAt?: number } }
    expect(seam.checkpointFor(subscriptionRef).dueAt).toBeLessThan(Date.now())
    await waitFor(() => shell.running() === 1 ? true : undefined)

    let disposed = false
    const disposal = second.fiber.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 100))
    // The script still holds the slot, so shutdown has not converged yet.
    expect(disposed).toBe(false)
    shell.release()
    await disposal
    expect(disposed).toBe(true)

    // The run's acceptance reached the durable table before the store closed.
    const records = [...pool.media.get('agent_team')?.tables.get('operations')?.values() ?? []] as Array<{ kind?: string }>
    expect(records.filter(record => record.kind === 'team/subscription-events-accepted')).toHaveLength(1)
  }, 30_000)
})

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the scheduler')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
