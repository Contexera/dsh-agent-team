/**
 * The interval scheduler against a fake clock and a controllable runner: the
 * four slots, the merged wait queue, the first-run spread, the failure pause,
 * and the per-minute publication budget with its restart persistence.
 */
import { describe, expect, it } from 'vitest'
import { SubscriptionScheduler, INITIAL_CHECKPOINT, shellMismatchReason, type SubscriptionCheckpoint,
  type SubscriptionRunOutcome, type SubscriptionRuntimePorts } from '../src/subscription-runtime.ts'
import { SUBSCRIPTION_CONCURRENT_RUNS, SUBSCRIPTION_PENDING_MAX, SUBSCRIPTION_PUBLISH_PER_MINUTE } from '../src/subscriptions.ts'
import type { AgentTeamSubscription, AgentTeamSubscriptionRef } from '../src/types.ts'

const MINUTE = 60_000

function subscription(name: string, minutes = 5): AgentTeamSubscription {
  return {
    subscriptionRef: `subscription:${name}` as AgentTeamSubscriptionRef,
    projectRef: 'project:p' as never,
    name,
    triggers: { interval: { minutes } },
    script: { content: 'true\n', sha256: 'a'.repeat(64), shell: 'bash' },
    credentials: [],
    revision: 1,
    state: 'active',
    createdBy: 'member:owner' as never,
    createdAt: '2026-11-03T00:00:00.000Z',
  }
}

interface Harness {
  readonly scheduler: SubscriptionScheduler
  readonly checkpoints: Map<string, SubscriptionCheckpoint>
  readonly runs: string[]
  readonly published: string[]
  advance(ms: number): void
  /** Resolve every run the scheduler launched and let its continuations settle. */
  settle(): Promise<void>
  readonly paused: string[]
  readonly logs: string[]
  /**
   * Seams: a checkpoint write that rejects, a pass that throws while it reads
   * the backlog, and the ledger record admission re-reads — mutable, so a test
   * can delete or archive behind a queued entry.
   */
  readonly control: {
    saveThrows: boolean
    pendingThrows: boolean
    archived: boolean
    readonly stored: Map<string, AgentTeamSubscription>
  }
  /** Every checkpoint the scheduler wrote, in order, so a terminal record's absence is provable. */
  readonly saves: string[]
  /** Release the runs blocked right now without driving another pass. */
  releaseAll(): void
  /** Fire the scheduled timer tick the way the Host's own loop does. */
  tick(): void
}

function harness(options: {
  readonly subscriptions: AgentTeamSubscription[]
  readonly pending?: Record<string, Array<{ acceptedSequence: number; eventId: string }>>
  readonly outcomes?: SubscriptionRunOutcome[]
  readonly random?: () => number
}): Harness {
  let now = Date.parse('2026-11-03T00:00:00.000Z')
  const checkpoints = new Map<string, SubscriptionCheckpoint>()
  const runs: string[] = []
  const published: string[] = []
  const paused: string[] = []
  const pending = { ...options.pending }
  const outcomes = [...(options.outcomes ?? [])]
  const logs: string[] = []
  const saves: string[] = []
  const stored = new Map<string, AgentTeamSubscription>(options.subscriptions.map(entry => [entry.subscriptionRef, entry]))
  const control = { saveThrows: false, pendingThrows: false, archived: false, stored }
  let release: Array<() => void> = []
  let scheduled: (() => void) | undefined
  const ports: SubscriptionRuntimePorts = {
    now: () => now,
    random: options.random ?? (() => 0),
    schedule: callback => { scheduled = callback; return 0 },
    cancel: () => {},
    log: message => { logs.push(message) },
    subscriptions: () => options.subscriptions,
    current: ref => stored.get(ref),
    projectActive: () => !control.archived,
    workspacePath: () => '/tmp/workspace',
    pending: ref => {
      if (control.pendingThrows) throw new Error('injected backlog failure')
      return pending[ref] ?? []
    },
    run: async (entry) => {
      runs.push(entry.subscriptionRef)
      // A run only settles once the test releases it, so slot occupancy is exact.
      await new Promise<void>(resolve => { release.push(resolve) })
      const outcome = outcomes.shift() ?? 'empty'
      if (outcome === 'accepted') {
        const list = pending[entry.subscriptionRef] ?? []
        list.push({ acceptedSequence: 10 + published.length, eventId: `e${published.length}` })
        pending[entry.subscriptionRef] = list
      }
      return outcome
    },
    publish: async (entry, _acceptedSequence, eventId) => {
      published.push(`${entry.subscriptionRef}:${eventId}`)
      pending[entry.subscriptionRef] = (pending[entry.subscriptionRef] ?? []).filter(queued => queued.eventId !== eventId)
    },
    pauseForFailures: async entry => { paused.push(entry.subscriptionRef) },
    checkpoint: ref => checkpoints.get(ref) ?? { subscriptionRef: ref, ...INITIAL_CHECKPOINT },
    save: async (ref, change) => {
      if (control.saveThrows) throw new Error('injected checkpoint failure')
      const checkpoint = change(checkpoints.get(ref) ?? { subscriptionRef: ref, ...INITIAL_CHECKPOINT })
      saves.push(ref)
      checkpoints.set(ref, checkpoint)
      return checkpoint
    },
  }
  const scheduler = new SubscriptionScheduler(ports)
  const releaseAll = (): void => {
    const waiting = release
    release = []
    for (const open of waiting) open()
  }
  return {
    scheduler, checkpoints, runs, published, paused, logs, saves, control, releaseAll,
    advance: ms => { now += ms },
    tick: () => { scheduled?.() },
    settle: async () => {
      // Drive scheduler passes until no pass admits anything: each pass may admit
      // a queued run, and a finished run frees the slot for the next one.
      for (let round = 0; round < 20; round += 1) {
        await scheduler.runTick()
        const waiting = release.length
        if (waiting === 0) break
        releaseAll()
        for (let flush = 0; flush < 10; flush += 1) await Promise.resolve()
      }
    },
  }
}

describe('the first run after boot', () => {
  it('spreads timer subscriptions inside one minute instead of firing them together', async () => {
    const many = Array.from({ length: 5 }, (_, index) => subscription(`s${index}`))
    const random = () => 0.5
    const test = harness({ subscriptions: many, random })
    await test.scheduler.settleBoot()
    const now = Date.parse('2026-11-03T00:00:00.000Z')
    for (const entry of many) expect(test.checkpoints.get(entry.subscriptionRef)?.dueAt).toBe(now + 30_000)
  })

  it('leaves a persisted due instant alone, so a restart catches up once instead of resetting', async () => {
    const entry = subscription('s0')
    const test = harness({ subscriptions: [entry] })
    const past = Date.parse('2026-11-02T23:00:00.000Z')
    await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: past })
    await test.scheduler.settleBoot()
    expect(test.checkpoints.get(entry.subscriptionRef)?.dueAt).toBe(past)
    await test.scheduler.runTick()
    expect(test.runs).toEqual([entry.subscriptionRef])
  })
})

describe('admission', () => {
  it('waits for a slot instead of dropping the run, and merges repeated due instants of one subscription', async () => {
    const entries = Array.from({ length: SUBSCRIPTION_CONCURRENT_RUNS + 2 }, (_, index) => subscription(`s${index}`))
    const test = harness({ subscriptions: entries })
    for (const entry of entries) {
      await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    }
    await test.scheduler.runTick()
    expect(test.runs).toHaveLength(SUBSCRIPTION_CONCURRENT_RUNS)
    expect(test.scheduler.state().queued).toHaveLength(2)

    // One of the waiting subscriptions comes due again while it waits: the
    // queue keeps one entry, never two.
    test.advance(5 * MINUTE)
    await test.scheduler.runTick()
    expect(test.scheduler.state().queued).toHaveLength(2)

    await test.settle()
    expect(test.runs).toHaveLength(entries.length)
    // Each subscription ran exactly once; the merged due instants did not stack.
    expect(new Set(test.runs).size).toBe(entries.length)
  })

  it('skips an overdue run while the unpublished backlog is at its ceiling, without counting a failure', async () => {
    const entry = subscription('s0')
    const backlog = Array.from({ length: SUBSCRIPTION_PENDING_MAX }, (_, index) => ({ acceptedSequence: index + 1, eventId: `e${index}` }))
    const test = harness({ subscriptions: [entry], pending: { [entry.subscriptionRef]: backlog }, outcomes: ['failed'] })
    // The publication budget of this minute is already spent, so the backlog
    // stays at its ceiling for this pass instead of draining first.
    await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT,
      dueAt: 0, publishWindowMinute: Math.floor(Date.parse('2026-11-03T00:00:00.000Z') / MINUTE),
      publishedInWindow: SUBSCRIPTION_PUBLISH_PER_MINUTE })
    await test.scheduler.runTick()
    expect(test.runs).toEqual([])
    expect(test.checkpoints.get(entry.subscriptionRef)?.consecutiveFailures).toBe(0)
  })
})

describe('failure handling', () => {
  it('counts failed runs and pauses the subscription after the third', async () => {
    const entry = subscription('s0')
    const test = harness({ subscriptions: [entry], outcomes: ['failed', 'failed', 'failed'] })
    await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    for (let round = 0; round < 2; round += 1) {
      await test.scheduler.runTick()
      await test.settle()
      test.advance(5 * MINUTE)
    }
    expect(test.runs).toHaveLength(2)
    expect(test.paused).toEqual([])
    expect(test.checkpoints.get(entry.subscriptionRef)?.consecutiveFailures).toBe(2)
    // The third failure crosses the threshold, and the count it reads is the one
    // the previous settle committed.
    await test.scheduler.runTick()
    await test.settle()
    expect(test.checkpoints.get(entry.subscriptionRef)?.consecutiveFailures).toBe(3)
    expect(test.paused).toEqual([entry.subscriptionRef])
  })

  it('settles a success only as the next due instant, because the accept clears the count itself', async () => {
    const entry = subscription('s0')
    const test = harness({ subscriptions: [entry], outcomes: ['accepted'] })
    // A streak stands when the run settles: clearing it belongs to the accept,
    // which reads the count the streak had when the output became durable.
    await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT,
      dueAt: 0, consecutiveFailures: 2 })
    await test.scheduler.runTick()
    await test.settle()
    const settled = test.checkpoints.get(entry.subscriptionRef)
    expect(settled?.consecutiveFailures).toBe(2)
    expect(settled?.lastSuccessAt).toBeUndefined()
    expect(settled?.dueAt).toBeGreaterThan(0)
  })
})

describe('publication', () => {
  it('publishes at most the per-minute budget and keeps the rest pending', async () => {
    const entry = subscription('s0')
    const pending = Array.from({ length: SUBSCRIPTION_PUBLISH_PER_MINUTE + 5 }, (_, index) => ({ acceptedSequence: index + 1, eventId: `e${index}` }))
    const test = harness({ subscriptions: [entry], pending: { [entry.subscriptionRef]: pending } })
    await test.scheduler.runTick()
    expect(test.published).toHaveLength(SUBSCRIPTION_PUBLISH_PER_MINUTE)
    expect(test.checkpoints.get(entry.subscriptionRef)?.publishedInWindow).toBe(SUBSCRIPTION_PUBLISH_PER_MINUTE)
    await test.scheduler.runTick()
    expect(test.published).toHaveLength(SUBSCRIPTION_PUBLISH_PER_MINUTE)
    test.advance(MINUTE)
    await test.scheduler.runTick()
    expect(test.published).toHaveLength(SUBSCRIPTION_PUBLISH_PER_MINUTE + 5)
  })

  it('keeps the budget across a restart, so a reboot cannot spend a second window', async () => {
    const entry = subscription('s0')
    const pending = Array.from({ length: SUBSCRIPTION_PUBLISH_PER_MINUTE + 1 }, (_, index) => ({ acceptedSequence: index + 1, eventId: `e${index}` }))
    const first = harness({ subscriptions: [entry], pending: { [entry.subscriptionRef]: pending } })
    await first.scheduler.runTick()
    expect(first.published).toHaveLength(SUBSCRIPTION_PUBLISH_PER_MINUTE)
    // The second Host boots on the same durable checkpoint, inside the same minute.
    const second = harness({ subscriptions: [entry], pending: { [entry.subscriptionRef]: pending } })
    await second.checkpoints.set(entry.subscriptionRef, first.checkpoints.get(entry.subscriptionRef)!)
    await second.scheduler.runTick()
    expect(second.published).toEqual([])
  })

  it('publishes nothing, and rewrites no checkpoint, for a deleted subscription', async () => {
    const entry = subscription('s0')
    const test = harness({ subscriptions: [entry], pending: { [entry.subscriptionRef]: [{ acceptedSequence: 1, eventId: 'e0' }] } })
    test.control.stored.set(entry.subscriptionRef, { ...entry, state: 'deleted' })
    await test.scheduler.runTick()
    // §4.4: a deleted subscription's accepted-but-unpublished output is not
    // delivered, and its checkpoint is not resurrected to retry it every tick.
    expect(test.published).toEqual([])
    expect(test.saves).toEqual([])
  })

  it('publishes nothing, and rewrites no checkpoint, once the Project is archived', async () => {
    const entry = subscription('s0')
    const test = harness({ subscriptions: [entry], pending: { [entry.subscriptionRef]: [{ acceptedSequence: 1, eventId: 'e0' }] } })
    test.control.archived = true
    await test.scheduler.runTick()
    expect(test.published).toEqual([])
    expect(test.saves).toEqual([])
  })

  it('still publishes what a paused subscription accepted before it paused', async () => {
    const entry = { ...subscription('s0'), state: 'paused' as const }
    const test = harness({ subscriptions: [entry], pending: { [entry.subscriptionRef]: [{ acceptedSequence: 1, eventId: 'e0' }] } })
    await test.scheduler.runTick()
    // Pausing stops runs, not delivery: the queue it already produced drains.
    expect(test.published).toEqual([`${entry.subscriptionRef}:e0`])
  })
})

describe('one admission for every entry point', () => {
  it('admits an owner-requested trial through the same four slots as a timer run', async () => {
    const entries = Array.from({ length: SUBSCRIPTION_CONCURRENT_RUNS }, (_, index) => subscription(`s${index}`))
    const test = harness({ subscriptions: entries })
    for (const entry of entries) await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    await test.scheduler.runTick()
    expect(test.runs).toHaveLength(SUBSCRIPTION_CONCURRENT_RUNS)

    // Every slot is busy, so a create's trial must queue instead of starting a
    // fifth script — the reason a burst of creates cannot outrun the limit.
    const trialEntry = subscription('trial')
    const started: string[] = []
    let closeTrial = (): void => {}
    const trialGate = new Promise<void>(resolve => { closeTrial = resolve })
    const trial = test.scheduler.runTrial(trialEntry, async () => {
      started.push(trialEntry.subscriptionRef)
      await trialGate
      return 'done'
    })
    await Promise.resolve()
    expect(started).toEqual([])
    expect(test.scheduler.state().queued).toEqual([trialEntry.subscriptionRef])

    // A freed slot admits the trial, and the trial's own answer reaches its caller.
    test.releaseAll()
    await test.scheduler.runTick()
    expect(started).toEqual([trialEntry.subscriptionRef])
    closeTrial()
    await expect(trial).resolves.toBe('done')
  })

  it('waits for its own trial instead of counting the timer run as a finished one', async () => {
    const entry = subscription('s0')
    const test = harness({ subscriptions: [entry] })
    await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0, consecutiveFailures: 2 })
    let open = (): void => {}
    const trial = test.scheduler.runTrial(entry, async () => {
      await new Promise<void>(resolve => { open = resolve })
      return 'ok'
    })
    await test.scheduler.runTick()
    // The due instant passed while the trial holds this subscription: the timer
    // run waits, which must not read as a success.
    expect(test.runs).toEqual([])
    expect(test.checkpoints.get(entry.subscriptionRef)?.consecutiveFailures).toBe(2)
    open()
    await trial
    await test.scheduler.runTick()
    expect(test.runs).toEqual([entry.subscriptionRef])
  })

  it('never starts a queued trial beside a timer run of the same subscription', async () => {
    const busy = Array.from({ length: SUBSCRIPTION_CONCURRENT_RUNS }, (_, index) => subscription(`busy${index}`))
    const shared = subscription('shared')
    const test = harness({ subscriptions: [...busy, shared] })
    for (const entry of [...busy, shared]) {
      await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    }
    await test.scheduler.runTick()
    expect(test.scheduler.state().queued).toEqual([shared.subscriptionRef])

    // The timer run and the trial of one subscription wait side by side, and the
    // slot they are waiting for is freed: the second one must keep waiting,
    // because two runs of one subscription would race over one checkpoint.
    const started: string[] = []
    const trial = test.scheduler.runTrial(shared, async () => {
      started.push(shared.subscriptionRef)
      return 'trial'
    })
    expect(test.scheduler.state().queued).toEqual([shared.subscriptionRef, shared.subscriptionRef])
    test.releaseAll()
    for (let flush = 0; flush < 50 && !test.runs.includes(shared.subscriptionRef); flush += 1) await Promise.resolve()
    expect(test.runs.at(-1)).toBe(shared.subscriptionRef)
    expect(started).toEqual([])
    expect(test.scheduler.state().running).toEqual([shared.subscriptionRef])

    // Only when that run finishes does the trial get its turn.
    test.releaseAll()
    await expect(trial).resolves.toBe('trial')
    expect(started).toEqual([shared.subscriptionRef])
  })

  it('refuses a queued trial once its subscription is deleted, before the script runs', async () => {
    const busy = Array.from({ length: SUBSCRIPTION_CONCURRENT_RUNS }, (_, index) => subscription(`busy${index}`))
    const victim = subscription('victim')
    const test = harness({ subscriptions: [...busy, victim] })
    for (const entry of busy) await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    await test.scheduler.runTick()
    let ran = false
    const trial = test.scheduler.runTrial(victim, async () => { ran = true; return 'ok' })
    expect(test.scheduler.state().queued).toEqual([victim.subscriptionRef])
    // The delete lands while the trial waits for a slot, so the queued snapshot
    // still says "active": admission has to read the ledger again.
    test.control.stored.set(victim.subscriptionRef, { ...victim, state: 'deleted' })
    test.releaseAll()
    await expect(trial).rejects.toThrow(/deleted while this trial waited/)
    expect(ran).toBe(false)
    expect(test.runs).toEqual(busy.map(entry => entry.subscriptionRef))
  })

  it('refuses a queued trial once its Project is archived, before the script runs', async () => {
    const busy = Array.from({ length: SUBSCRIPTION_CONCURRENT_RUNS }, (_, index) => subscription(`busy${index}`))
    const victim = subscription('victim')
    const test = harness({ subscriptions: [...busy, victim] })
    for (const entry of busy) await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    await test.scheduler.runTick()
    let ran = false
    const trial = test.scheduler.runTrial(victim, async () => { ran = true; return 'ok' })
    expect(test.scheduler.state().queued).toEqual([victim.subscriptionRef])
    test.control.archived = true
    test.releaseAll()
    await expect(trial).rejects.toThrow(/archived while this trial waited/)
    expect(ran).toBe(false)
  })

  it('keeps a trial of a paused subscription runnable, because test and resume reach one', async () => {
    const paused = { ...subscription('paused'), state: 'paused' as const }
    const test = harness({ subscriptions: [paused] })
    await expect(test.scheduler.runTrial(paused, async () => 'ok')).resolves.toBe('ok')
  })

  it('keeps a due run ahead of a request that arrived later, even while its own run is in flight', async () => {
    const busy = Array.from({ length: SUBSCRIPTION_CONCURRENT_RUNS - 1 }, (_, index) => subscription(`busy${index}`))
    const shared = subscription('shared')
    const late = subscription('late')
    const test = harness({ subscriptions: [...busy, shared, late] })
    for (const entry of [...busy, shared]) {
      await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    }
    // The 4th slot goes to this subscription's own trial, which is still running
    // when its timer comes due.
    let closeTrial = (): void => {}
    const trial = test.scheduler.runTrial(shared, async () => {
      await new Promise<void>(resolve => { closeTrial = resolve })
      return 'trial'
    })
    await test.scheduler.runTick()
    expect(test.runs).toEqual(busy.map(entry => entry.subscriptionRef))
    expect(test.scheduler.state().running).toHaveLength(SUBSCRIPTION_CONCURRENT_RUNS)

    // The due instant passes while its own trial holds the subscription: the
    // timer still takes its place now, and a request that arrives afterwards
    // queues behind it instead of overtaking an earlier due instant.
    test.advance(1_000)
    await test.scheduler.runTick()
    expect(test.scheduler.state().queued).toEqual([shared.subscriptionRef])
    const lateRequest = test.scheduler.runTrial(late, async () => 'late')
    expect(test.scheduler.state().queued).toEqual([shared.subscriptionRef, late.subscriptionRef])

    // The trial ends first, which frees exactly one slot: the earlier due run
    // takes it, not the later request.
    closeTrial()
    await trial
    for (let flush = 0; flush < 50 && test.scheduler.state().running.length < SUBSCRIPTION_CONCURRENT_RUNS; flush += 1) await Promise.resolve()
    expect(test.runs.at(-1)).toBe(shared.subscriptionRef)
    expect(test.scheduler.state().queued).toEqual([late.subscriptionRef])
    test.releaseAll()
    await expect(lateRequest).resolves.toBe('late')
  })

  it('records nothing for a run that was dropped, so a terminal record keeps no checkpoint', async () => {
    const entry = subscription('s0')
    const test = harness({ subscriptions: [entry], outcomes: ['dropped'] })
    await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0, consecutiveFailures: 2 })
    await test.scheduler.runTick()
    test.releaseAll()
    for (let flush = 0; flush < 50; flush += 1) await Promise.resolve()
    // Neither a success, a failure, nor a fresh due instant: a dropped run must
    // not revive the checkpoint a deletion already removed.
    expect(test.checkpoints.get(entry.subscriptionRef)).toMatchObject({ dueAt: 0, consecutiveFailures: 2 })
    expect(test.paused).toEqual([])
  })

  it('drops a queued timer run whose subscription was deleted while it waited', async () => {
    const busy = Array.from({ length: SUBSCRIPTION_CONCURRENT_RUNS }, (_, index) => subscription(`busy${index}`))
    const victim = subscription('victim')
    const test = harness({ subscriptions: [...busy, victim] })
    for (const entry of [...busy, victim]) {
      await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    }
    await test.scheduler.runTick()
    expect(test.scheduler.state().queued).toEqual([victim.subscriptionRef])
    test.control.stored.set(victim.subscriptionRef, { ...victim, state: 'deleted' })
    test.releaseAll()
    for (let flush = 0; flush < 50; flush += 1) await Promise.resolve()
    expect(test.runs).toEqual(busy.map(entry => entry.subscriptionRef))
  })

  it('admits the run that has waited longest first, whatever order the subscriptions are iterated in', async () => {
    const busy = Array.from({ length: SUBSCRIPTION_CONCURRENT_RUNS }, (_, index) => subscription(`busy${index}`))
    const late = subscription('late')
    const early = subscription('early')
    const test = harness({ subscriptions: [...busy, late, early] })
    for (const entry of busy) await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    await test.scheduler.runTick()
    // `late` is iterated before `early`, but `early` came due an hour earlier.
    await test.checkpoints.set(late.subscriptionRef, { subscriptionRef: late.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 1_000 })
    await test.checkpoints.set(early.subscriptionRef, { subscriptionRef: early.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 1_000 - 3_600_000 })
    await test.scheduler.runTick()
    expect(test.scheduler.state().queued).toEqual([early.subscriptionRef, late.subscriptionRef])
    test.releaseAll()
    await test.scheduler.runTick()
    expect(test.runs.slice(SUBSCRIPTION_CONCURRENT_RUNS)).toEqual([early.subscriptionRef, late.subscriptionRef])
  })

  it('stops admitting, rejects a trial that never started, and waits for the runs in flight', async () => {
    const entries = Array.from({ length: SUBSCRIPTION_CONCURRENT_RUNS }, (_, index) => subscription(`s${index}`))
    const test = harness({ subscriptions: entries })
    for (const entry of entries) await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    await test.scheduler.runTick()
    const queuedTrial = test.scheduler.runTrial(subscription('trial'), async () => 'never')
    let drained = false
    const stopping = test.scheduler.stop().then(() => { drained = true })
    await queuedTrial.catch(() => {})
    await expect(queuedTrial).rejects.toThrow(/shutting down/)
    await Promise.resolve()
    // The four executions still hold their slots, so teardown has not converged yet.
    expect(drained).toBe(false)
    test.releaseAll()
    await stopping
    expect(test.scheduler.state()).toEqual({ running: [], queued: [] })
    await expect(test.scheduler.runTrial(subscription('late'), async () => 'x')).rejects.toThrow(/shutting down/)
  })

  it('logs a failed checkpoint write instead of rejecting the tick that caused it', async () => {
    const entry = subscription('s0')
    const test = harness({ subscriptions: [entry], outcomes: ['accepted'] })
    await test.checkpoints.set(entry.subscriptionRef, { subscriptionRef: entry.subscriptionRef, ...INITIAL_CHECKPOINT, dueAt: 0 })
    test.control.saveThrows = true
    await expect(test.scheduler.runTick()).resolves.toBeUndefined()
    test.releaseAll()
    await test.settle()
    expect(test.logs.join('\n')).toMatch(/could not record its outcome: injected checkpoint failure/)
    // The failure does not become a success: no checkpoint was invented.
    expect(test.checkpoints.get(entry.subscriptionRef)).toMatchObject({ dueAt: 0, consecutiveFailures: 0 })
  })

  it('logs a rejected scheduler pass instead of leaving the rejection unhandled', async () => {
    const entry = subscription('s0')
    const test = harness({ subscriptions: [entry] })
    test.control.pendingThrows = true
    test.scheduler.start()
    // The Host's own loop is the only caller of the private tick: a pass that
    // throws must reach the log, because a floating rejection ends the Host.
    expect(() => { test.tick() }).not.toThrow()
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
    expect(test.logs.join('\n')).toMatch(/subscription tick failed: injected backlog failure/)
  })
})

describe('the shell a snapshot was recorded under', () => {
  it('fails the run when the live executor is a different shell family', () => {
    expect(shellMismatchReason('bash', 'bash')).toBeUndefined()
    expect(shellMismatchReason('bash', 'pwsh')).toBe('this subscription was created for bash, but the Host runs pwsh')
    expect(shellMismatchReason('pwsh', undefined)).toBe('no shell executor is available for unattended runs')
  })
})
