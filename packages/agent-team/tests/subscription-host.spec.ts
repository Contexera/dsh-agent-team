/**
 * The Host side of a subscription: the trial that gates a write, the request a
 * timer run really builds, the ledger facts it produces, and the Main stream
 * entry the Human then reads. The executor and the credential store are fakes,
 * so this spec proves the Host's own decisions; what a real executor does with
 * the policy it is handed is the cross-platform enforcement probe's job.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi as fakeTimers } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import AgentTeam from '../src/index.ts'
import { admissionKey } from '../src/subscription-admissions.ts'
import { subscriptionDomainSpec } from '../src/subscription-store.ts'
import type { SubscriptionCheckpoint, SubscriptionScheduler } from '../src/subscription-runtime.ts'
import { subscriptionTestStdin } from '../src/subscriptions.ts'
import type { AgentTeamCreateSubscriptionRequest, AgentTeamProjectRef, AgentTeamRequestId, AgentTeamSubscriptionRef } from '../src/types.ts'

const workspaceId = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const capturedBashScript = (script: string): string => `printf '__DSH_TEAM_RAW_STDOUT__'; ${script}`
const shellSpillRoot = mkdtempSync(join(tmpdir(), 'dsh-team-host-spill-'))
let shellSpillId = 0
const shellSpill = (stdout: string): string => {
  const path = join(shellSpillRoot, `${shellSpillId++}.log`)
  writeFileSync(path, `__DSH_TEAM_RAW_STDOUT__${stdout}`)
  return path
}
afterAll(() => { rmSync(shellSpillRoot, { recursive: true, force: true }) })

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
          stdout: { text: isProbe ? '5.2.15' : state.stdout, truncated: false,
            ...(isProbe ? {} : { spillPath: shellSpill(state.stdout) }) },
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
          stdout: { text: isProbe ? '5.2.15' : stdout, truncated: false,
            ...(isProbe ? {} : { spillPath: shellSpill(stdout) }) },
          stderr: { text: '', truncated: false },
        }) }
      },
    },
  }
}

const credentialValues: Record<string, string> = { GH_TOKEN: 'secret-value' }

async function boot(pool: MemoryMediaPool, shell: Pick<FakeShell, 'service'>, workspaceRoot = process.cwd(),
  config?: Readonly<Record<string, unknown>>) {
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
  const fiber = config === undefined ? await ctx.plugin(AgentTeam) : await ctx.plugin(AgentTeam, config as never)
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
    expect(trial.stdoutMaxBytes, 'one byte requests the public raw spill; the Team byte cap is applied after recovery').toBe(1)
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
    expect(shell.requests.filter(spec => spec.command === capturedBashScript('printf events\n'))).toHaveLength(0)
  })

  it('resolves a committed create after its credential is removed', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const request = createRequest(projectRef, 'printf events\n')
    const created = await booted.ctx.agentTeam.createSubscription(request)
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const credential = credentialValues.GH_TOKEN
    delete credentialValues.GH_TOKEN
    try {
      shell.requests.length = 0
      const retried = await booted.ctx.agentTeam.createSubscription(request)
      if (retried.kind !== 'changed') throw new Error('the retry resolves the committed create')
      expect(retried.subscription.subscriptionRef).toBe(created.subscription.subscriptionRef)
      expect(shell.requests, 'the committed request neither reads credentials nor runs the script again').toHaveLength(0)
    } finally {
      credentialValues.GH_TOKEN = credential!
    }
  })

  it('rejects a create retried under the same request id with another baseline choice', async () => {
    const shell = fakeShell({ stdout: '' })
    const booted = await boot(new MemoryMediaPool(), shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const request = createRequest(projectRef, 'printf events\n')
    const created = await booted.ctx.agentTeam.createSubscription(request)
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const same = await booted.ctx.agentTeam.createSubscription({ ...request, baseline: 'current-output' })
    if (same.kind !== 'changed') throw new Error('the default and explicit current-output are one intent')
    expect(same.subscription.subscriptionRef).toBe(created.subscription.subscriptionRef)
    await expect(booted.ctx.agentTeam.createSubscription({ ...request, baseline: 'ignore-history' }))
      .rejects.toThrow(/reused with a different operation or payload/)
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
    expect(shell.requests.find(spec => spec.command === capturedBashScript(script))!.env).toMatchObject({ DSH_TEAM_TRIGGER: 'test' })
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
    const run = runShell.requests.find(spec => spec.command === capturedBashScript('printf events\n'))!
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

  const executions = (shell: GatedShell): number =>
    shell.requests.filter(spec => spec.command === capturedBashScript('printf victim-script\n')).length

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

describe('the webhook trigger', () => {
  const origin = 'https://team.example.com'
  const configured = { webhook: { publicOrigin: origin } }
  const addressPattern = new RegExp(`^${origin.replaceAll('.', '\\.')}/team/hooks/[A-Za-z0-9_-]{43}$`)
  const addressToken = (address: string | undefined): string => {
    const token = address?.split('/team/hooks/')[1]
    if (token === undefined) throw new Error(`expected a hook address, received '${String(address)}'`)
    return token
  }
  const webhookOnly = (projectRef: AgentTeamProjectRef, overrides: Partial<AgentTeamCreateSubscriptionRequest> = {}) =>
    createRequest(projectRef, 'printf events\n', { intervalMinutes: undefined, webhook: true, ...overrides })

  it('refuses to arm an address while no public origin is configured, and runs no script for it', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    shell.requests.length = 0
    await expect(booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef)))
      .rejects.toThrow(/set webhook\.publicOrigin in the Team settings/)
    // The shell-family probe is the only thing that may run: the trial envelope
    // is what a stored script would have read, and it never happens.
    expect(shell.requests.filter(request => request.stdin !== undefined), 'a write that cannot carry an address runs no script')
      .toHaveLength(0)
    expect(booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries).toHaveLength(0)
  })

  it('answers the arming write with the complete address once, and a retry of it with none', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const request = webhookOnly(projectRef)
    const created = await booted.ctx.agentTeam.createSubscription(request)
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    expect(created.webhookAddress).toMatch(addressPattern)
    expect(created.subscription.webhook?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    // The address the owner was handed is the one the entry resolves, so a
    // provider posting to it really does reach this subscription.
    await expect(booted.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress), headers: {}, body: '{}' }))
      .resolves.toMatchObject({ kind: 'queued' })
    shell.requests.length = 0
    const retried = await booted.ctx.agentTeam.createSubscription(request)
    if (retried.kind !== 'changed') throw new Error('a retried create resolves the stored subscription')
    expect(retried.webhookAddress, 'the ledger keeps only the hash, so a retry cannot show the address').toBeUndefined()
    expect(retried.webhookAddressGone, 'and the retry says the address is gone instead of staying silent').toBe(true)
    expect(shell.requests, 'a retried create never runs the script again').toHaveLength(0)
  })

  it('answers a retried edit from the ledger, so the script runs once', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n'))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const request = { requestId: requestId('edit-retry'), workspaceId, projectRef,
      subscriptionRef: created.subscription.subscriptionRef, expectedRevision: 1,
      name: 'renamed', intervalMinutes: 10, script: { scriptContent: 'printf events\n' } }
    const first = await booted.ctx.agentTeam.updateSubscription(request)
    if (first.kind !== 'changed') throw new Error('expected a committed edit')
    shell.requests.length = 0
    const retried = await booted.ctx.agentTeam.updateSubscription(request)
    if (retried.kind !== 'changed') throw new Error('a retried edit resolves the stored subscription')
    expect(retried.subscription.name).toBe('renamed')
    expect(shell.requests, 'the retry never runs the script again').toHaveLength(0)
  })

  it('returns the address once when an edit enables the trigger, and never on an edit that keeps it', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n', { name: 'timer only' }))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const subscriptionRef = created.subscription.subscriptionRef
    expect(created.webhookAddress).toBeUndefined()
    const edit = (value: string, expectedRevision: number, webhook: boolean) => booted.ctx.agentTeam.updateSubscription({
      requestId: requestId(value), workspaceId, projectRef, subscriptionRef, expectedRevision, name: 'timer only',
      intervalMinutes: 10, webhook, script: { scriptContent: 'printf events\n' } })
    const enabled = await edit('enable', 1, true)
    if (enabled.kind !== 'changed') throw new Error('expected a committed edit')
    expect(enabled.webhookAddress).toMatch(addressPattern)
    const kept = await edit('keep', 2, true)
    if (kept.kind !== 'changed') throw new Error('expected a committed edit')
    expect(kept.webhookAddress, 'an edit that keeps the trigger keeps the address it already had').toBeUndefined()
    expect(kept.subscription.webhook).toEqual(enabled.subscription.webhook)
  })

  it('marks a retried edit that first armed the address as unable to show it again', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n', { name: 'timer only' }))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const request = { requestId: requestId('enable-retry'), workspaceId, projectRef,
      subscriptionRef: created.subscription.subscriptionRef, expectedRevision: 1, name: 'timer only', intervalMinutes: 10,
      webhook: true, script: { scriptContent: 'printf events\n' } }
    const first = await booted.ctx.agentTeam.updateSubscription(request)
    if (first.kind !== 'changed') throw new Error('expected a committed edit')
    expect(first.webhookAddress).toMatch(addressPattern)
    const retried = await booted.ctx.agentTeam.updateSubscription(request)
    if (retried.kind !== 'changed') throw new Error('the retry resolves the committed edit')
    expect(retried.webhookAddress, 'the full address was shown once').toBeUndefined()
    expect(retried.webhookAddressGone, 'the retry says the newly armed address cannot be fetched again').toBe(true)
  })

  it('does not mark an edit that keeps the existing address as gone', async () => {
    fakeTimers.useFakeTimers({ toFake: ['Date'] })
    live.push({ dispose: async () => { fakeTimers.useRealTimers() } })
    fakeTimers.setSystemTime(new Date('2026-11-04T12:00:00.000Z'))
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n', { name: 'webhook feed', webhook: true }))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const request = { requestId: requestId('keep-retry'), workspaceId, projectRef,
      subscriptionRef: created.subscription.subscriptionRef, expectedRevision: 1, name: 'renamed', intervalMinutes: 10,
      webhook: true, script: { scriptContent: 'printf events\n' } }
    const first = await booted.ctx.agentTeam.updateSubscription(request)
    if (first.kind !== 'changed') throw new Error('expected a committed edit')
    const retried = await booted.ctx.agentTeam.updateSubscription(request)
    if (retried.kind !== 'changed') throw new Error('the retry resolves the committed edit')
    expect(retried.webhookAddressGone, 'keeping an existing address is not an arming response').toBeUndefined()
  })

  it('answers each refusal the status table names: unknown, paused, full, and gone with the subscription', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const subscriptionRef = created.subscription.subscriptionRef
    const token = addressToken(created.webhookAddress)
    const intake = () => booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
    expect(await booted.ctx.agentTeam.intakeWebhookDelivery({ token: 'B'.repeat(43), headers: {}, body: '{}' }), 'a token nobody minted')
      .toEqual({ kind: 'not-found' })

    await booted.ctx.agentTeam.pauseSubscription({ requestId: requestId('pause'), workspaceId, projectRef, subscriptionRef, expectedRevision: 1 })
    expect(await intake(), 'a paused subscription refuses rather than queueing').toEqual({ kind: 'paused' })
    await booted.ctx.agentTeam.resumeSubscription({ requestId: requestId('resume'), workspaceId, projectRef, subscriptionRef, expectedRevision: 1 })

    const queued = []
    for (let index = 0; index < 10; index += 1) queued.push(await intake())
    expect(queued.every(answer => answer.kind === 'queued')).toBe(true)
    expect(new Set(queued.map(answer => (answer as { admissionRef: string }).admissionRef)).size, 'every delivery is its own admission').toBe(10)
    expect(await intake(), 'the eleventh delivery waits for the queue to drain').toEqual({ kind: 'queue-full', retryAfterSeconds: 60 })

    await booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete'), workspaceId, projectRef, subscriptionRef, expectedRevision: 1 })
    expect(await intake(), 'a deleted subscription leaves no address behind').toEqual({ kind: 'not-found' })
  })

  /** The Host's own queue pass, driven directly so a test never waits on the interval. */
  const pump = (booted: Awaited<ReturnType<typeof boot>>): Promise<void> =>
    (booted.ctx.agentTeam as unknown as { pumpWebhookAdmissions(): Promise<void> }).pumpWebhookAdmissions()

  const admissionRows = (pool: MemoryMediaPool): Array<Record<string, unknown>> =>
    [...(pool.media.get('agent_team_subscriptions')?.tables.get('admissions')?.values() ?? [])] as Array<Record<string, unknown>>

  const checkpointRow = (pool: MemoryMediaPool, ref: AgentTeamSubscriptionRef) =>
    pool.media.get('agent_team_subscriptions')?.tables.get('checkpoints')?.get(ref) as
      { consecutiveFailures: number; dueAt?: number; countedAdmissionRef?: string } | undefined

  const tooManyEvents = Array.from({ length: 501 }, (_, index) => `{"id":"e${index}","title":"Event ${index}"}`).join('\n') + '\n'

  it('validates a webhook-only subscription under the trial envelope, so a script that parses stdin can be created', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    shell.requests.length = 0
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const trials = shell.requests.filter(request => request.stdin !== undefined)
    expect(trials, 'a webhook-only subscription has no request to replay, so its trial reads the sample').toHaveLength(1)
    expect(trials[0]!.stdin).toBe(subscriptionTestStdin())
    expect(trials[0]!.env?.DSH_TEAM_TRIGGER, 'a trial is a trial, not a delivery').toBe('test')
    expect(trials[0]!.env?.DSH_TEAM_DELIVERY_ID, 'no delivery exists yet, so no delivery id').toBeUndefined()
    // The live delivery replaces that sample with the request it actually arrived with.
    const queued = await booted.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress), headers: {}, body: '{"zen":"real"}' })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')
    shell.stdout = '{"id":"b","title":"B"}\n'
    shell.requests.length = 0
    await (booted.ctx.agentTeam as unknown as { pumpWebhookAdmissions(): Promise<void> }).pumpWebhookAdmissions()
    const run = shell.requests.filter(request => request.stdin !== undefined).at(-1)
    expect(JSON.parse(run!.stdin ?? '{}'), 'the run reads the request, not the sample').toEqual({ headers: {}, body: '{"zen":"real"}' })
  })

  it('trials a webhook-only draft, and refuses to arm one the Host has nowhere to publish', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    shell.requests.length = 0
    const tested = await booted.ctx.agentTeam.testSubscriptionDraft({ workspaceId, projectRef, name: 'draft', webhook: true,
      scriptContent: 'json-body\n', credentials: [] })
    expect(tested.kind).toBe('tested')
    expect(shell.requests.filter(request => request.stdin !== undefined), 'the draft reads the trial envelope, like the create would')
      .toHaveLength(1)
    // A Host with no public origin cannot arm anything, and says so before the
    // script runs rather than after a trial that could never be saved.
    const bare = await boot(new MemoryMediaPool(), shell)
    live.push({ dispose: async () => { await bare.fiber.dispose() } })
    const bareProject = await project(bare)
    shell.requests.length = 0
    await expect(bare.ctx.agentTeam.testSubscriptionDraft({ workspaceId, projectRef: bareProject, name: 'draft', webhook: true,
      scriptContent: 'json-body\n', credentials: [] })).rejects.toThrow(/webhook\.publicOrigin/)
    expect(shell.requests.filter(request => request.stdin !== undefined)).toHaveLength(0)
  }, 30_000)

  it('runs a queued delivery under the Host admission id and retires it once its output is accepted', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    // The trial printed 'a' and its ids are the baseline, so the live run must
    // print something the subscription has not seen.
    shell.stdout = '{"id":"pr-1","title":"PR opened"}\n'
    const queued = await booted.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress),
      headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' }, body: '{"action":"opened"}' })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')
    shell.requests.length = 0
    await pump(booted)
    const run = shell.requests.filter(request => request.stdin !== undefined).at(-1)
    expect(run, 'the pass runs the delivery').toBeDefined()
    expect(run!.env).toMatchObject({ DSH_TEAM_TRIGGER: 'webhook', DSH_TEAM_DELIVERY_ID: queued.admissionRef })
    expect(JSON.parse(run!.stdin ?? '{}')).toEqual({ headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' },
      body: '{"action":"opened"}' })
    // The accepted output is ledger fact, and the row is gone: no work is owed.
    await waitFor(() => admissionRows(pool).length === 0 ? true : undefined)
    expect(booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!.eventCount).toBe(1)
  }, 30_000)

  it('runs the definition the delivery arrived under, not the one an edit replaced it with', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const subscriptionRef = created.subscription.subscriptionRef
    const queued = await booted.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress), headers: {}, body: '{}' })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')
    // The owner rewrites the script while the request is still in the queue.
    const edited = await booted.ctx.agentTeam.updateSubscription({ requestId: requestId('edit'), workspaceId, projectRef,
      subscriptionRef, expectedRevision: 1, name: 'main CI', webhook: true, script: { scriptContent: 'printf edited\n' } })
    if (edited.kind !== 'changed') throw new Error('expected a committed edit')
    expect(edited.subscription.revision).toBe(2)
    shell.stdout = '{"id":"pr-1","title":"PR opened"}\n'
    shell.requests.length = 0
    await pump(booted)
    const run = shell.requests.filter(request => request.stdin !== undefined).at(-1)
    expect(run?.command, 'the payload replays the bytes it was queued against').toBe(capturedBashScript('printf events\n'))
    const logs = booted.ctx.agentTeam.subscriptionLogsForClient({ workspaceId, projectRef, subscriptionRef })
    expect(logs.runs.find(entry => entry.trigger === 'webhook'),
      'the delivery run says which revision it pinned').toMatchObject({ subscriptionRevision: 1, eventCount: 1 })
  }, 30_000)

  it('keeps the armed address when an edit says nothing about the trigger', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n', { name: 'timer only' }))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const subscriptionRef = created.subscription.subscriptionRef
    const edit = (request: string, expectedRevision: number, extra: { readonly webhook?: boolean }) => booted.ctx.agentTeam.updateSubscription({
      requestId: requestId(request), workspaceId, projectRef, subscriptionRef, expectedRevision, name: 'renamed',
      intervalMinutes: 10, ...extra, script: { scriptContent: 'printf events\n' } })
    const armed = await edit('arm', 1, { webhook: true })
    if (armed.kind !== 'changed') throw new Error('expected a committed edit')
    const token = addressToken(armed.webhookAddress)
    // A provider is already posting to this address, so an edit that does not
    // mention the trigger keeps it — only an explicit false drops it.
    const renamed = await edit('rename', 2, {})
    if (renamed.kind !== 'changed') throw new Error('expected a committed edit')
    expect(renamed.subscription.webhook, 'an unnamed trigger is kept, not disarmed').toEqual(armed.subscription.webhook)
    expect(renamed.webhookAddress, 'and an address that is only kept is not shown again').toBeUndefined()
    await expect(booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })).resolves.toMatchObject({ kind: 'queued' })
    const disarmed = await edit('disarm', 3, { webhook: false })
    if (disarmed.kind !== 'changed') throw new Error('expected a committed edit')
    expect(disarmed.subscription.webhook, 'the explicit false is what drops it').toBeUndefined()
    expect(await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' }), 'and the address stops resolving')
      .toEqual({ kind: 'not-found' })
  }, 30_000)

  it('finishes a delivery already accepted when the subscription stops receiving them', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const token = addressToken(created.webhookAddress)
    const queued = await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')
    // The owner turns the subscription into a timer: the address goes, the queue
    // does not — the provider already has a 202 for this request.
    const edited = await booted.ctx.agentTeam.updateSubscription({ requestId: requestId('timer-only'), workspaceId, projectRef,
      subscriptionRef: created.subscription.subscriptionRef, expectedRevision: 1, name: 'main CI', intervalMinutes: 10, webhook: false,
      script: { scriptContent: 'printf events\n' } })
    if (edited.kind !== 'changed') throw new Error('expected a committed edit')
    expect(await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })).toEqual({ kind: 'not-found' })
    shell.stdout = '{"id":"pr-1","title":"PR opened"}\n'
    shell.requests.length = 0
    await pump(booted)
    expect(shell.requests.filter(request => request.stdin !== undefined),
      'the queued request still owes its run, under the definition it arrived with').toHaveLength(1)
    expect(admissionRows(pool), 'and it leaves the queue once its output is accepted').toHaveLength(0)
    expect(booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!.eventCount).toBe(1)
  }, 30_000)

  it('holds a batch with no room yet, and retries only the accept', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const token = addressToken(created.webhookAddress)
    const listed = () => booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!
    const failures = () => (booted.ctx.agentTeam as unknown as {
      checkpointFor(ref: AgentTeamSubscriptionRef): { consecutiveFailures: number } }).checkpointFor(created.subscription.subscriptionRef).consecutiveFailures
    // 490 unpublished events leave room for ten more, not for the twenty the
    // next request brings.
    shell.stdout = Array.from({ length: 490 }, (_, index) => `{"id":"f${index}","title":"fill ${index}"}`).join('\n') + '\n'
    const fill = await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
    if (fill.kind !== 'queued') throw new Error('expected a queued delivery')
    await pump(booted)
    expect(listed()).toMatchObject({ unpublished: 490, eventCount: 490 })
    shell.stdout = Array.from({ length: 20 }, (_, index) => `{"id":"late${index}","title":"late ${index}"}`).join('\n') + '\n'
    const late = await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
    if (late.kind !== 'queued') throw new Error('expected a queued delivery')
    shell.requests.length = 0
    await pump(booted)
    expect(shell.requests.filter(request => request.stdin !== undefined), 'the request is one run').toHaveLength(1)
    const held = await waitFor(() => admissionRows(pool).find(row => row.heldEvents !== undefined))
    expect(held.heldEvents, 'the validated batch waits beside the delivery it arrived with').toHaveLength(20)
    expect(listed(), 'and nothing is accepted past the ceiling yet').toMatchObject({ unpublished: 490, eventCount: 490 })
    expect(failures(), 'no room yet is not a failure of the run').toBe(0)
    expect(held.attempts, 'and it spends none of the delivery retries').toBe(0)
    expect(pool.media.get('agent_team_subscriptions')?.tables.get('deliveries')?.size ?? 0, 'and it is not a failed delivery').toBe(0)
    // Still no room: the next pass retries the accept, never the script.
    shell.requests.length = 0
    await pump(booted)
    expect(shell.requests.filter(request => request.stdin !== undefined)).toHaveLength(0)
    expect(admissionRows(pool)).toHaveLength(1)
    // An update lands while the batch waits: the accept must still attribute
    // the batch to the definition the payload arrived under, not the new one.
    const updated = await booted.ctx.agentTeam.updateSubscription({ requestId: requestId('update-held'), workspaceId, projectRef,
      subscriptionRef: created.subscription.subscriptionRef, expectedRevision: 1, name: 'main CI', webhook: true,
      script: { scriptContent: 'printf "later version"\n' } })
    if (updated.kind !== 'changed') throw new Error('expected a committed update')
    shell.requests.length = 0
    // One publication pass frees exactly the room the batch needs.
    await (booted.ctx.agentTeam as unknown as { subscriptionScheduler: { runTick(): Promise<void> } })
      .subscriptionScheduler.runTick()
    await pump(booted)
    expect(shell.requests.filter(request => request.stdin !== undefined), 'the accept is retried without the script').toHaveLength(0)
    expect(admissionRows(pool), 'the batch is in the ledger, so the delivery is done').toHaveLength(0)
    expect(listed(), 'all twenty events are accepted and waiting their turn').toMatchObject({ unpublished: 490, eventCount: 510 })
    expect(failures(), 'a held batch never counts against the subscription').toBe(0)
    const operations = [...(pool.media.get('agent_team')?.tables.get('operations')?.values() ?? [])] as Array<{
      kind?: string
      data?: { subscriptionRevision?: number, scriptHash?: string, events?: Array<{ id?: string }> }
    }>
    const lateAccept = operations.find(record => record.kind === 'team/subscription-events-accepted'
      && record.data?.events?.some(event => event.id === 'late0'))
    expect(lateAccept?.data?.subscriptionRevision, 'the batch is attributed to the revision it ran under').toBe(1)
    expect(lateAccept?.data?.scriptHash).toBe(created.subscription.script.sha256)
  }, 30_000)

  it('refuses a batch no queue could ever take instead of holding it', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    // Five hundred and one events do not fit even into an empty queue, so the
    // batch is refused outright rather than held for room that never comes.
    shell.stdout = Array.from({ length: 501 }, (_, index) => `{"id":"e${index}","title":"event ${index}"}`).join('\n') + '\n'
    const queued = await booted.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress), headers: {}, body: '{}' })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')
    await pump(booted)
    const deliveries = [...(pool.media.get('agent_team_subscriptions')?.tables.get('deliveries')?.values() ?? [])] as Array<Record<string, unknown>>
    expect(deliveries[0], 'the request becomes a failed delivery an owner can replay').toMatchObject({ attempts: 1 })
    expect(admissionRows(pool), 'not a held batch').toHaveLength(0)
  }, 30_000)

  it.each([
    { table: 'deliveries', operation: 'put', paused: false },
    { table: 'admissions', operation: 'delete', paused: false },
    { table: 'admissions', operation: 'delete', paused: true },
  ] as const)('recovers an exhausted webhook after $table $operation fails (paused: $paused)', async ({ table, operation, paused }) => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const first = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await first.fiber.dispose() } })
    const projectRef = await project(first)
    const created = await first.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const { subscriptionRef, revision: expectedRevision } = created.subscription
    const body = '{"delivery":"original"}'
    const queued = await first.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress),
      headers: {}, body })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')

    shell.stdout = Array.from({ length: 501 }, (_, index) => `{"id":"e${index}","title":"event ${index}"}`).join('\n') + '\n'
    const fault = fakeTimers.fn(() => new Error('injected webhook settlement write failure'))
    pool.writeFault = write => write.table === table && write.operation === operation ? fault() : undefined
    await pump(first)
    expect(fault).toHaveBeenCalled()
    if (paused) await first.ctx.agentTeam.pauseSubscription({ requestId: requestId('pause-before-restart'),
      workspaceId, projectRef, subscriptionRef, expectedRevision })
    await first.fiber.dispose()
    await first.facility.closeAll()

    pool.writeFault = undefined
    shell.requests.length = 0
    shell.stdout = '{"id":"replayed","title":"Replayed"}\n'
    const second = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await second.fiber.dispose() } })
    const list = () => second.ctx.agentTeam.subscriptionDeliveriesForClient({ workspaceId, projectRef, subscriptionRef }).deliveries
    await expect.poll(list, { timeout: 500 }).toHaveLength(1)
    await expect.poll(() => admissionRows(pool), { timeout: 500 }).toHaveLength(0)
    expect(shell.requests.filter(request => request.stdin !== undefined), 'recovery does not rerun the script').toHaveLength(0)
    if (paused) {
      await second.ctx.agentTeam.resumeSubscription({ requestId: requestId('resume-after-restart'),
        workspaceId, projectRef, subscriptionRef, expectedRevision })
      shell.requests.length = 0
    }
    const replayed = await second.ctx.agentTeam.replaySubscriptionDeliveryForClient({ requestId: requestId('replay-after-restart'),
      workspaceId, projectRef, subscriptionRef, deliveryRef: list()[0]!.deliveryRef })
    expect(replayed).toMatchObject({ kind: 'replayed', eventCount: 1 })
    const [run] = shell.requests.filter(request => request.stdin !== undefined)
    expect(run?.env?.DSH_TEAM_DELIVERY_ID).toBe(queued.admissionRef)
    expect(run?.stdin).toBe(JSON.stringify({ headers: {}, body }))
  })

  it('continues a count, a pause, and a queue deletion after successive restarts', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '' })
    const open = async () => {
      const host = await boot(pool, shell, process.cwd(), configured)
      live.push({ dispose: async () => { await host.fiber.dispose() } })
      return host
    }
    let host = await open()
    const projectRef = await project(host)
    const created = await host.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const { subscriptionRef } = created.subscription
    const token = addressToken(created.webhookAddress)
    shell.stdout = tooManyEvents
    const writes = pool.media.get('agent_team')!.tables.get('operations')!
    const pauses = () => [...writes.values()].filter(value =>
      (value as { kind: string }).kind === 'team/subscription-paused')
    const rows = () => host.ctx.agentTeam.subscriptionDeliveriesForClient({ workspaceId, projectRef, subscriptionRef }).deliveries
    const state = () => host.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!.subscription.state
    const exhaust = async () => {
      await expect(host.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' }))
        .resolves.toMatchObject({ kind: 'queued' })
      await pump(host)
    }

    for (const [index, table, operation, countBeforeRestart] of [
      [1, 'checkpoints', 'put', 0], [2, 'admissions', 'delete', 2], [3, 'operations', 'put', 3],
    ] as const) {
      pool.writeFault = write => write.table === table && write.operation === operation ? new Error('interrupted') : undefined
      await exhaust()
      expect(admissionRows(pool)).toHaveLength(1)
      expect(rows()).toHaveLength(index)
      expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures ?? 0).toBe(countBeforeRestart)
      expect(state()).toBe('active')
      await host.fiber.dispose()

      const runsBeforeRecovery = shell.requests.length
      // After the third failure, commit the pause but interrupt the next write.
      pool.writeFault = index === 3
        ? write => write.table === 'admissions' && write.operation === 'delete' ? new Error('interrupted after pause') : undefined
        : undefined
      host = await open()
      if (index === 3) {
        await expect.poll(pauses).toHaveLength(1)
        await host.fiber.dispose()
        pool.writeFault = undefined
        host = await open()
      }
      await expect.poll(() => admissionRows(pool)).toHaveLength(0)
      await expect.poll(() => checkpointRow(pool, subscriptionRef)?.countedAdmissionRef).toBeUndefined()
      expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(index)
      expect(rows()).toHaveLength(index)
      expect(state()).toBe(index === 3 ? 'paused' : 'active')
      expect(pauses()).toHaveLength(index === 3 ? 1 : 0)
      expect(host.ctx.agentTeam.inbox({ workspaceId }).main.filter(item => item.projectRef === projectRef))
        .toMatchObject(index === 3 ? [{ unreadCount: 1, directCount: 1 }] : [])
      expect(shell.requests).toHaveLength(runsBeforeRecovery)
    }
  })

  it('repairs a committed resume whose count reset failed, without counting the old settlement again', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '' })
    const first = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await first.fiber.dispose() } })
    const projectRef = await project(first)
    const created = await first.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const { subscriptionRef } = created.subscription
    const token = addressToken(created.webhookAddress)
    const request = { requestId: requestId('repair-resume'), workspaceId, projectRef, subscriptionRef, expectedRevision: 1 }
    shell.stdout = tooManyEvents
    for (let index = 1; index <= 3; index++) {
      if (index === 3) {
        pool.writeFault = write => write.table === 'admissions' && write.operation === 'delete'
          ? new Error('keep settled admission') : undefined
      }
      await first.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
      await pump(first)
    }
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(3)
    expect(admissionRows(pool)).toHaveLength(1)

    pool.writeFault = write => write.table === 'checkpoints' &&
      (write.value as { consecutiveFailures?: number } | undefined)?.consecutiveFailures === 0
      ? new Error('resume reset failed') : undefined
    shell.stdout = ''
    await expect(first.ctx.agentTeam.resumeSubscription(request)).rejects.toThrow('resume reset failed')
    expect(first.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]?.subscription.state).toBe('active')
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(3)
    await first.fiber.dispose()

    pool.writeFault = undefined
    const resumed = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await resumed.fiber.dispose() } })
    await expect.poll(() => admissionRows(pool)).toHaveLength(0)
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(0)
    const beforeRetry = shell.requests.length
    await resumed.ctx.agentTeam.resumeSubscription(request)
    expect(shell.requests).toHaveLength(beforeRetry)
    shell.stdout = tooManyEvents
    await resumed.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
    await pump(resumed)
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(1)
    expect(resumed.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]?.subscription.state).toBe('active')
  })

  it('does not restore an old failure after a successful replay clears its streak', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '' })
    const host = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await host.fiber.dispose() } })
    const projectRef = await project(host)
    const created = await host.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const { subscriptionRef } = created.subscription
    const token = addressToken(created.webhookAddress)
    shell.stdout = tooManyEvents
    pool.writeFault = write => write.table === 'checkpoints'
      && (write.value as { consecutiveFailures?: number } | undefined)?.consecutiveFailures === 3
      ? new Error('hold the third failure open') : undefined
    for (let index = 0; index < 3; index++) {
      await host.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
      await pump(host)
    }
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(2)
    const spent = admissionRows(pool)[0]!
    const deliveries = host.ctx.agentTeam.subscriptionDeliveriesForClient({ workspaceId, projectRef, subscriptionRef }).deliveries
    const first = deliveries.find(delivery => delivery.deliveryRef !== spent.deliveryRef)!
    shell.stdout = '{"id":"recovered","title":"Recovered"}\n'
    await expect(host.ctx.agentTeam.replaySubscriptionDeliveryForClient({
      requestId: requestId('successful-replay'), workspaceId, projectRef, subscriptionRef, deliveryRef: first.deliveryRef,
    })).resolves.toMatchObject({ kind: 'replayed', eventCount: 1 })
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(0)
    pool.writeFault = undefined
    await pump(host)
    expect(admissionRows(pool)).toHaveLength(0)
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(0)
    expect(host.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]?.subscription.state).toBe('active')
  })

  it('refuses an address a reset moved while the request waited for the write lock', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const oldToken = addressToken(created.webhookAddress)
    const internals = booted.ctx.agentTeam as unknown as {
      serializeSubscriptionWrite<T>(ref: AgentTeamSubscriptionRef, task: () => Promise<T>): Promise<T>
    }
    // Hold the subscription's write lock, then let a reset take its place in the
    // queue before a request that already resolved the old address.
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const holding = internals.serializeSubscriptionWrite(created.subscription.subscriptionRef, () => gate)
    const reset = booted.ctx.agentTeam.resetSubscriptionWebhook({ requestId: requestId('reset'), workspaceId, projectRef,
      subscriptionRef: created.subscription.subscriptionRef, expectedRevision: 1 })
    const raced = booted.ctx.agentTeam.intakeWebhookDelivery({ token: oldToken, headers: {}, body: '{}' })
    release()
    await holding
    const resetResult = await reset
    if (resetResult.kind !== 'changed') throw new Error('expected a committed reset')
    expect(await raced, 'the address it carried stopped resolving under the lock').toEqual({ kind: 'not-found' })
    expect(admissionRows(pool)).toHaveLength(0)
    const fresh = addressToken(resetResult.webhookAddress)
    expect(fresh, 'the reset moved the address').not.toBe(oldToken)
    await expect(booted.ctx.agentTeam.intakeWebhookDelivery({ token: fresh, headers: {}, body: '{}' })).resolves.toMatchObject({ kind: 'queued' })
  }, 30_000)

  it('retries a failed delivery on the 1/5/30 ladder and hands every attempt the same id', async () => {
    fakeTimers.useFakeTimers({ toFake: ['Date'] })
    live.push({ dispose: async () => { fakeTimers.useRealTimers() } })
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    // The trial has to pass, so the address arms; every live attempt then fails
    // on its own output.
    shell.stdout = 'not json\n'
    const queued = await booted.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress), headers: {}, body: '{}' })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')
    const ids: Array<string | undefined> = []
    shell.requests.length = 0
    for (const [index, waitMs] of [60_000, 300_000, 1_800_000].entries()) {
      await pump(booted)
      const run = shell.requests.filter(request => request.stdin !== undefined).at(-1)
      ids.push(run?.env?.DSH_TEAM_DELIVERY_ID)
      const failed = await waitFor(() => admissionRows(pool).find(row => row.state === 'retrying'))
      expect(failed.attempts, `attempt ${index + 1} is on the row`).toBe(index + 1)
      const nextAt = Date.parse(String(failed.nextAttemptAt))
      expect(nextAt - Date.now(), `retry ${index + 1} waits its own delay`).toBe(waitMs)
      expect(admissionRows(pool), 'a retry is still the same delivery, not a second row').toHaveLength(1)
      fakeTimers.setSystemTime(new Date(Date.now() + waitMs))
    }
    // The fourth failure is the one that spends the retries: the request becomes
    // the failed delivery an owner replays, and the row leaves the queue.
    await pump(booted)
    const failure = await waitFor(() => (pool.media.get('agent_team_subscriptions')?.tables.get('deliveries')?.size ?? 0) > 0 ? true : undefined)
    expect(failure).toBe(true)
    expect(admissionRows(pool), 'the exhausted delivery is no longer queued').toHaveLength(0)
    expect(new Set(ids), 'every attempt ran under the id the first one had').toEqual(new Set([queued.admissionRef]))
    const deliveries = [...(pool.media.get('agent_team_subscriptions')?.tables.get('deliveries')?.values() ?? [])] as Array<Record<string, unknown>>
    expect(deliveries[0]).toMatchObject({ admissionRef: queued.admissionRef, attempts: 4 })
    expect(String(deliveries[0]!.lastError)).toMatch(/line 1/)
  }, 30_000)

  it('accepts a batch of several hundred events once, and publishes it without running the script again', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    // 300 new events: past the per-minute publish budget with room left under the
    // 500-event ceiling, which is the whole point of the pending queue.
    shell.stdout = Array.from({ length: 300 }, (_, index) => `{"id":"e${index}","title":"event ${index}"}`).join('\n') + '\n'
    const queued = await booted.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress), headers: {}, body: '{}' })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')
    shell.requests.length = 0
    await pump(booted)
    expect(shell.requests.filter(request => request.stdin !== undefined), 'the batch is one run').toHaveLength(1)
    const listed = () => booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!
    expect(listed(), 'every accepted event waits for its turn to publish').toMatchObject({ unpublished: 300, eventCount: 300 })
    expect(admissionRows(pool), 'the delivery is done: publication is the ledger queue, not the request').toHaveLength(0)
    // Publication is throttled and lagging, so a later pass finds accepted work —
    // and still no reason to run the script for it.
    await pump(booted)
    expect(shell.requests.filter(request => request.stdin !== undefined), 'a lagging publication never re-runs the script').toHaveLength(1)
    expect(listed().unpublished, 'the events are still the ledger queue, not a second run').toBe(300)
  }, 30_000)

  it('turns one run past the unpublished ceiling into a failed delivery instead of retrying it', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    // One more event than the ceiling allows: the spec refuses the whole batch
    // rather than publishing part of it.
    shell.stdout = Array.from({ length: 501 }, (_, index) => `{"id":"e${index}","title":"event ${index}"}`).join('\n') + '\n'
    shell.requests.length = 0
    const token = addressToken(created.webhookAddress)
    const queueOne = async () => {
      const answer = await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
      if (answer.kind !== 'queued') throw new Error('expected a queued delivery')
      await pump(booted)
      return answer.admissionRef
    }
    await queueOne()
    expect(shell.requests.filter(request => request.stdin !== undefined), 'a refused batch is not retried').toHaveLength(1)
    const listed = () => booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!
    expect(listed(), 'nothing is accepted past the ceiling').toMatchObject({ unpublished: 0, eventCount: 0 })
    const failureRows = () => [...(pool.media.get('agent_team_subscriptions')?.tables.get('deliveries')?.values() ?? [])] as Array<Record<string, unknown>>
    expect(failureRows()[0]).toMatchObject({ attempts: 1 })
    expect(String(failureRows()[0]!.lastError)).toMatch(/more events than the Project can hold/)
    // Retrying would print the same output again, so the delivery spends its three
    // attempts at once: the third such delivery pauses the subscription, which
    // only one counted failure each can explain.
    await queueOne()
    expect(listed().subscription.state).toBe('active')
    await queueOne()
    expect(listed().subscription).toMatchObject({ state: 'paused', pausedReason: 'failures' })
  }, 30_000)

  it('finishes the bookkeeping of an accepted delivery without running its script again', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    shell.stdout = '{"id":"pr-1","title":"PR opened"}\n'
    const queued = await booted.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress), headers: {}, body: '{}' })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')
    const admissions = pool.media.get('agent_team_subscriptions')!.tables.get('admissions')!
    const owed = [...admissions.entries()]
    shell.requests.length = 0
    await pump(booted)
    expect(admissions.size, 'the accepted delivery is retired').toBe(0)
    // The Host stops between the ledger accept and its own bookkeeping: the
    // output is durable, the row that owed it is still on disk, and the accept
    // itself names the attempt that produced it.
    const rows = (booted.ctx.agentTeam as unknown as { subscriptionAdmissionsTable: {
      put(key: string, record: unknown): Promise<unknown> } }).subscriptionAdmissionsTable
    for (const [key, row] of owed) await rows.put(key, row)
    expect(admissions.size, 'the row is back where the crash left it').toBe(1)
    await pump(booted)
    expect(admissions.size, 'the next pass retires the row the crash left behind').toBe(0)
    expect(shell.requests.filter(request => request.stdin !== undefined),
      'the accept is the run: the script is not executed a second time for it').toHaveLength(1)
    expect(booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!.eventCount,
      'the same output is not accepted a second time').toBe(1)
  }, 30_000)

  it('settles one spent delivery per pass, and runs nothing while one is still owed', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const subscriptionRef = created.subscription.subscriptionRef
    const token = addressToken(created.webhookAddress)
    shell.stdout = tooManyEvents
    await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
    await pump(booted)
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(1)
    for (let index = 0; index < 2; index += 1) {
      expect(await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })).toMatchObject({ kind: 'queued' })
    }
    const rows = (booted.ctx.agentTeam as unknown as { subscriptionAdmissionsTable: {
      put(key: string, record: unknown): Promise<unknown> } }).subscriptionAdmissionsTable
    // Legacy spent rows carry no accounting progress to resume.
    for (const [index, row] of admissionRows(pool).entries()) {
      await rows.put(admissionKey(subscriptionRef, String(row.admissionRef)),
        Object.freeze({ ...row, deliveryRef: `delivery:probe-${index}`, attempts: 4, state: 'exhausted', lastError: 'the run failed' }))
    }
    expect(admissionRows(pool), 'both spent deliveries are waiting').toHaveLength(2)
    shell.requests.length = 0
    await pump(booted)
    expect(admissionRows(pool), 'one pass settles one spent delivery').toHaveLength(1)
    expect(shell.requests.filter(request => request.stdin !== undefined),
      'settling a spent delivery runs no script for it').toHaveLength(0)
    await pump(booted)
    expect(admissionRows(pool), 'the next pass takes the one still owed').toHaveLength(0)
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures, 'legacy rows do not backfill failures').toBe(1)
    expect(booted.ctx.agentTeam.subscriptionDeliveriesForClient({ workspaceId, projectRef, subscriptionRef }).deliveries)
      .toHaveLength(3)
  }, 30_000)

  it('drops queued deliveries when the subscription is deleted, so a late result cannot revive the queue', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const subscriptionRef = created.subscription.subscriptionRef
    const token = addressToken(created.webhookAddress)
    for (let index = 0; index < 3; index += 1) {
      expect(await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })).toMatchObject({ kind: 'queued' })
    }
    expect(admissionRows(pool)).toHaveLength(3)
    await booted.ctx.agentTeam.deleteSubscription({ requestId: requestId('delete-queued'), workspaceId, projectRef,
      subscriptionRef, expectedRevision: 1 })
    expect(admissionRows(pool), 'the queue goes with the subscription').toHaveLength(0)
    shell.requests.length = 0
    await pump(booted)
    expect(shell.requests.filter(request => request.stdin !== undefined), 'no script runs for a delivery nobody owes').toHaveLength(0)
    expect(await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' }), 'and the address is gone with it')
      .toEqual({ kind: 'not-found' })
  })

  it('drops queued deliveries when the Project is archived, and answers its address with 404', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const token = addressToken(created.webhookAddress)
    expect(await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })).toMatchObject({ kind: 'queued' })
    await booted.ctx.agentTeam.archiveProject({ requestId: requestId('archive-project'), workspaceId, projectRef })
    expect(admissionRows(pool), 'an archived Project owes nothing').toHaveLength(0)
    shell.requests.length = 0
    await pump(booted)
    expect(shell.requests.filter(request => request.stdin !== undefined)).toHaveLength(0)
    expect(await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })).toEqual({ kind: 'not-found' })
  }, 30_000)

  it('keeps the list readable over an archived Project, while its writes refuse', async () => {
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(new MemoryMediaPool(), shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    await booted.ctx.agentTeam.archiveProject({ requestId: requestId('archive-readable'), workspaceId, projectRef })
    // The list is the audit surface of what the Project ran, so archiving
    // keeps it readable instead of answering the page with an error.
    const listed = booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef })
    expect(listed.entries.map(entry => entry.subscription.subscriptionRef)).toEqual([created.subscription.subscriptionRef])
    await expect(booted.ctx.agentTeam.pauseSubscription({ requestId: requestId('pause-archived'), workspaceId, projectRef,
      subscriptionRef: created.subscription.subscriptionRef, expectedRevision: created.subscription.revision }))
      .rejects.toThrow(/is archived/)
  }, 30_000)

  it('ends a delivery on its retry succeeding, without counting a failure against it', async () => {
    fakeTimers.useFakeTimers({ toFake: ['Date'] })
    live.push({ dispose: async () => { fakeTimers.useRealTimers() } })
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const subscriptionRef = created.subscription.subscriptionRef
    shell.stdout = 'not json\n'
    const queued = await booted.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress), headers: {}, body: '{}' })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')
    shell.requests.length = 0
    await pump(booted)
    expect(admissionRows(pool)[0]).toMatchObject({ state: 'retrying', attempts: 1 })
    // The retry succeeds: the delivery is delivered, so it owes nothing more and
    // the streak it never spent stays where it was.
    shell.stdout = '{"id":"pr-1","title":"PR opened"}\n'
    fakeTimers.setSystemTime(new Date(Date.now() + 60_000))
    await pump(booted)
    expect(admissionRows(pool)).toHaveLength(0)
    const listed = booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]!
    expect(listed).toMatchObject({ eventCount: 1, unpublished: 1 })
    expect(listed.subscription.state, 'one failed attempt is not a failure of the subscription').toBe('active')
    expect(booted.ctx.agentTeam.subscriptionDeliveriesForClient({ workspaceId, projectRef, subscriptionRef }).deliveries).toHaveLength(0)
  }, 30_000)

  it('replays an exhausted delivery under the id its first attempt saw, and refuses one while paused', async () => {
    fakeTimers.useFakeTimers({ toFake: ['Date'] })
    live.push({ dispose: async () => { fakeTimers.useRealTimers() } })
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const subscriptionRef = created.subscription.subscriptionRef
    shell.stdout = 'not json\n'
    const queued = await booted.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress), headers: {}, body: '{}' })
    if (queued.kind !== 'queued') throw new Error('expected a queued delivery')
    shell.requests.length = 0
    // Four failing attempts: three retries on the ladder, then the record an owner reads.
    for (const waitMs of [0, 60_000, 300_000, 1_800_000]) {
      fakeTimers.setSystemTime(new Date(Date.now() + waitMs))
      await pump(booted)
    }
    expect(admissionRows(pool), 'the exhausted delivery leaves the queue').toHaveLength(0)
    const listed = () => booted.ctx.agentTeam.subscriptionDeliveriesForClient({ workspaceId, projectRef, subscriptionRef })
    expect(listed().deliveries, 'and becomes the record the page shows').toHaveLength(1)
    const deliveryRef = listed().deliveries[0]!.deliveryRef
    await booted.ctx.agentTeam.pauseSubscription({ requestId: requestId('pause'), workspaceId, projectRef, subscriptionRef, expectedRevision: 1 })
    await expect(booted.ctx.agentTeam.replaySubscriptionDeliveryForClient({ requestId: requestId('replay-paused'), workspaceId,
      projectRef, subscriptionRef, deliveryRef })).rejects.toThrow(/paused/)
    shell.stdout = '{"id":"pr-1","title":"PR opened"}\n'
    await booted.ctx.agentTeam.resumeSubscription({ requestId: requestId('resume'), workspaceId, projectRef, subscriptionRef, expectedRevision: 1 })
    shell.requests.length = 0
    const replayed = await booted.ctx.agentTeam.replaySubscriptionDeliveryForClient({ requestId: requestId('replay'), workspaceId,
      projectRef, subscriptionRef, deliveryRef })
    expect(replayed).toMatchObject({ kind: 'replayed', eventCount: 1 })
    // The third identity: the script reads the same Host admission id it saw on
    // its first attempt, so a script keyed on it stays idempotent.
    const run = shell.requests.filter(request => request.stdin !== undefined).at(-1)
    expect(run!.env?.DSH_TEAM_DELIVERY_ID).toBe(queued.admissionRef)
    expect(listed().deliveries, 'a delivery that replayed successfully leaves the list').toHaveLength(0)
  }, 30_000)

  it('keeps the queue across a restart, so an accepted delivery is never lost', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const first = await boot(pool, shell, process.cwd(), configured)
    const projectRef = await project(first)
    const created = await first.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const token = addressToken(created.webhookAddress)
    const intake = (host: typeof first) => host.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
    for (let index = 0; index < 10; index += 1) expect(await intake(first)).toMatchObject({ kind: 'queued' })
    // A restart, not a reload: the store closes and a new Host opens the same medium.
    await first.fiber.dispose()
    await first.facility.closeAll()
    const second = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await second.fiber.dispose() } })
    expect(await intake(second), 'ten deliveries were durable before their 202, so none of them died with the process')
      .toEqual({ kind: 'queue-full', retryAfterSeconds: 60 })
  })

  it('keeps the old failure count when an edit commits during the failed-delivery write', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const booted = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await booted.fiber.dispose() } })
    const projectRef = await project(booted)
    const created = await booted.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const { subscriptionRef } = created.subscription
    const token = addressToken(created.webhookAddress)
    shell.stdout = tooManyEvents
    expect(await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' }))
      .toMatchObject({ kind: 'queued' })
    await pump(booted)
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(1)

    const updateAtCommit = Promise.withResolvers<void>()
    const deliveryAtWrite = Promise.withResolvers<void>()
    const releaseUpdate = Promise.withResolvers<void>()
    const releaseDelivery = Promise.withResolvers<void>()
    pool.writeStall = write => {
      const kind = (write.value as { readonly kind?: string } | undefined)?.kind
      if (write.table === 'operations' && write.operation === 'put' && kind === 'team/subscription-updated') {
        updateAtCommit.resolve()
        return releaseUpdate.promise
      }
      if (write.table === 'deliveries' && write.operation === 'put') {
        deliveryAtWrite.resolve()
        return releaseDelivery.promise
      }
      return undefined
    }

    // The edit's trial records are already durable when its ledger write stalls.
    shell.stdout = ''
    const editing = booted.ctx.agentTeam.updateSubscription({ requestId: requestId('edit-during-settlement'),
      workspaceId, projectRef, subscriptionRef, expectedRevision: 1, name: 'renamed', webhook: true,
      script: { scriptContent: 'printf events\n' } })
    await updateAtCommit.promise
    shell.stdout = tooManyEvents
    expect(await booted.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' }))
      .toMatchObject({ kind: 'queued' })
    const settling = pump(booted)
    await deliveryAtWrite.promise

    // Commit the edit while the failure table write is held, then let settlement
    // continue against the new ledger revision.
    releaseUpdate.resolve()
    const edited = await editing
    if (edited.kind !== 'changed') throw new Error('expected a committed edit')
    expect(edited.subscription.revision).toBe(2)
    releaseDelivery.resolve()
    await settling

    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures,
      'the delivery arrived under revision 1, so revision 2 does not count it').toBe(1)
    expect(checkpointRow(pool, subscriptionRef)?.countedAdmissionRef).toBeUndefined()
    expect(booted.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]?.subscription.state).toBe('active')
    expect(admissionRows(pool)).toHaveLength(0)
    expect(pool.media.get('agent_team_subscriptions')?.tables.get('deliveries')?.size).toBe(2)
  }, 30_000)

  it('waits for a stalled webhook admission pass before closing the stores', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const host = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await host.fiber.dispose() } })
    const projectRef = await project(host)
    const created = await host.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')

    // Leave an exhausted row for the next pass, where settlement no longer owns a scheduler slot.
    shell.stdout = tooManyEvents
    pool.writeFault = write => write.table === 'deliveries' && write.operation === 'put' ? new Error('injected settlement failure') : undefined
    await host.ctx.agentTeam.intakeWebhookDelivery({ token: addressToken(created.webhookAddress), headers: {}, body: '{}' })
    await pump(host)
    expect(admissionRows(pool)).toMatchObject([{ state: 'exhausted' }])
    pool.writeFault = undefined

    const atWrite = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    pool.writeStall = write => {
      if (write.table !== 'deliveries' || write.operation !== 'put') return undefined
      atWrite.resolve()
      return release.promise
    }
    const settling = pump(host)
    await atWrite.promise

    let disposed = false
    const disposal = host.fiber.dispose().then(() => { disposed = true })
    try {
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(disposed, 'the Host must not close while its admission pass still owns a write').toBe(false)
    } finally {
      release.resolve()
    }
    await Promise.all([settling, disposal])
    expect(admissionRows(pool)).toEqual([])
  })

  it.each(['delete', 'archive'] as const)('does not resurrect an exhausted delivery after %s commits', async action => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '' })
    const host = await boot(pool, shell, process.cwd(), configured)
    live.push({ dispose: async () => { await host.fiber.dispose() } })
    const projectRef = await project(host)
    const created = await host.ctx.agentTeam.createSubscription(webhookOnly(projectRef))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const { subscriptionRef } = created.subscription
    const token = addressToken(created.webhookAddress)
    const atWrite = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    pool.writeStall = write => {
      if (write.table !== 'deliveries' || write.operation !== 'put') return undefined
      atWrite.resolve()
      return release.promise
    }
    shell.stdout = tooManyEvents
    await host.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
    const settlement = pump(host)
    await atWrite.promise
    const terminal = action === 'delete'
      ? host.ctx.agentTeam.deleteSubscription({ workspaceId, projectRef, subscriptionRef, expectedRevision: 1, requestId: requestId('delete-exhausted') })
      : host.ctx.agentTeam.archiveProject({ workspaceId, projectRef, requestId: requestId('archive-exhausted') })
    const operation = action === 'delete' ? 'team/subscription-deleted' : 'team/project-archived'
    try {
      await expect.poll(() => [...pool.media.get('agent_team')!.tables.get('operations')!.values()]
        .some(value => (value as { kind: string }).kind === operation)).toBe(true)
    } finally {
      release.resolve()
    }
    await Promise.all([settlement, terminal])
    expect(admissionRows(pool)).toHaveLength(0)
    expect(pool.media.get('agent_team_subscriptions')?.tables.get('deliveries')?.size ?? 0).toBe(0)
    expect(checkpointRow(pool, subscriptionRef)).toBeUndefined()
  })

  it('keeps a queued interval behind the live Webhook settlement that pauses it', async () => {
    const pool = new MemoryMediaPool()
    const shell = fakeShell({ stdout: '' })
    const scriptStarted = Promise.withResolvers<void>()
    const finishScript = Promise.withResolvers<void>()
    const writingFailure = Promise.withResolvers<void>()
    const finishWrite = Promise.withResolvers<void>()
    let gate = false
    const host = await boot(pool, { service: {
      ...shell.service,
      execute: async spec => {
        const handle = await shell.service.execute(spec)
        if (!gate || spec.env?.DSH_TEAM_TRIGGER !== 'webhook') return handle
        scriptStarted.resolve()
        return { result: async () => { await finishScript.promise; return handle.result() } }
      },
    } }, process.cwd(), configured)
    live.push({ dispose: async () => { await host.fiber.dispose() } })
    const projectRef = await project(host)
    const created = await host.ctx.agentTeam.createSubscription(webhookOnly(projectRef, { intervalMinutes: 10 }))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const { subscriptionRef } = created.subscription
    const token = addressToken(created.webhookAddress)
    const exhaust = async () => {
      await host.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' })
      await pump(host)
    }
    shell.stdout = tooManyEvents
    await exhaust()
    await exhaust()
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(2)
    gate = true
    pool.writeStall = write => {
      if (write.table !== 'deliveries' || write.operation !== 'put') return undefined
      writingFailure.resolve()
      return finishWrite.promise
    }
    const settling = exhaust()
    const runtime = host.ctx.agentTeam as unknown as {
      updateCheckpoint(ref: AgentTeamSubscriptionRef, change: (checkpoint: SubscriptionCheckpoint) => SubscriptionCheckpoint): Promise<unknown>
      subscriptionScheduler: SubscriptionScheduler
    }
    try {
      await scriptStarted.promise
      await runtime.updateCheckpoint(subscriptionRef, checkpoint => ({ ...checkpoint, dueAt: Date.now() - 1 }))
      await runtime.subscriptionScheduler.runTick()
      finishScript.resolve()
      await writingFailure.promise
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(shell.requests.filter(request => request.env?.DSH_TEAM_TRIGGER === 'interval')).toHaveLength(0)
    } finally {
      finishScript.resolve()
      finishWrite.resolve()
      await settling
    }
    expect(host.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]?.subscription.state).toBe('paused')
    expect(shell.requests.filter(request => request.env?.DSH_TEAM_TRIGGER === 'interval')).toHaveLength(0)
  })

  it('holds an overdue interval behind a Webhook pause recovered at startup', async () => {
    const pool = new MemoryMediaPool()
    const firstShell = fakeShell({ stdout: '{"id":"a","title":"A"}\n' })
    const first = await boot(pool, firstShell, process.cwd(), configured)
    live.push({ dispose: async () => { await first.fiber.dispose() } })
    const projectRef = await project(first)
    const created = await first.ctx.agentTeam.createSubscription(createRequest(projectRef, 'printf events\n', { webhook: true }))
    if (created.kind !== 'changed') throw new Error('expected a committed create')
    const { subscriptionRef } = created.subscription
    const token = addressToken(created.webhookAddress)
    firstShell.stdout = tooManyEvents
    pool.writeFault = write => write.table === 'operations' && write.operation === 'put'
      && (write.value as { readonly kind?: string } | undefined)?.kind === 'team/subscription-paused'
      ? new Error('leave the Webhook pause pending') : undefined
    for (let index = 0; index < 3; index += 1) {
      expect(await first.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' }))
        .toMatchObject({ kind: 'queued' })
      await pump(first)
    }
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(3)
    expect(first.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]?.subscription.state).toBe('active')
    expect(admissionRows(pool)[0]?.failureStreak, 'the exhausted admission still owns the pending pause').toBeDefined()

    const checkpoint = checkpointRow(pool, subscriptionRef)
    if (checkpoint === undefined) throw new Error('expected a checkpoint')
    const checkpointTable = (first.ctx.agentTeam as unknown as { subscriptionTable: {
      put(key: AgentTeamSubscriptionRef, value: unknown): Promise<void> } }).subscriptionTable
    await checkpointTable.put(subscriptionRef, Object.freeze({ ...checkpoint, dueAt: Date.now() - 1 }))
    await first.fiber.dispose()
    await first.facility.closeAll()
    pool.writeFault = undefined

    const pauseAtWrite = Promise.withResolvers<void>()
    const releasePause = Promise.withResolvers<void>()
    pool.writeStall = write => write.table === 'operations' && write.operation === 'put'
      && (write.value as { readonly kind?: string } | undefined)?.kind === 'team/subscription-paused'
      ? (pauseAtWrite.resolve(), releasePause.promise) : undefined
    const secondShell = fakeShell({ stdout: '{"id":"interval","title":"must not run"}\n' })
    const second = await boot(pool, secondShell, process.cwd(), configured)
    live.push({ dispose: async () => { await second.fiber.dispose() } })
    await pauseAtWrite.promise
    await new Promise(resolve => setTimeout(resolve, 1_200))
    expect(secondShell.requests.filter(request => request.env?.DSH_TEAM_TRIGGER === 'interval'),
      'the overdue interval waits until the Webhook pause is committed').toHaveLength(0)
    expect(second.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]?.subscription.state).toBe('active')

    releasePause.resolve()
    await expect.poll(() => second.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef })
      .entries[0]?.subscription.state).toBe('paused')
    await new Promise(resolve => setTimeout(resolve, 1_100))
    expect(secondShell.requests.filter(request => request.env?.DSH_TEAM_TRIGGER === 'interval'),
      'the committed pause keeps the interval stopped').toHaveLength(0)
    expect(admissionRows(pool)).toHaveLength(0)
    pool.writeStall = undefined

    secondShell.stdout = ''
    await second.ctx.agentTeam.resumeSubscription({ requestId: requestId('resume-empty'), workspaceId, projectRef,
      subscriptionRef, expectedRevision: 1 })
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(0)
    secondShell.requests.length = 0

    secondShell.stdout = tooManyEvents
    expect(await second.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' }))
      .toMatchObject({ kind: 'queued' })
    await pump(second)
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures).toBe(1)
    const successEpoch = (checkpointRow(pool, subscriptionRef) as { readonly failureSuccessEpoch?: number } | undefined)
      ?.failureSuccessEpoch ?? 0

    secondShell.stdout = ''
    expect(await second.ctx.agentTeam.intakeWebhookDelivery({ token, headers: {}, body: '{}' }))
      .toMatchObject({ kind: 'queued' })
    await pump(second)
    expect(checkpointRow(pool, subscriptionRef)?.consecutiveFailures,
      'an empty result is a successful run and clears the streak').toBe(0)
    expect((checkpointRow(pool, subscriptionRef) as { readonly failureSuccessEpoch?: number } | undefined)
      ?.failureSuccessEpoch).toBeGreaterThan(successEpoch)
    expect(second.ctx.agentTeam.subscriptionsForClient({ workspaceId, projectRef }).entries[0]?.subscription.state).toBe('active')
    expect(secondShell.requests.filter(request => request.env?.DSH_TEAM_TRIGGER === 'interval')).toHaveLength(0)
  }, 30_000)
})
