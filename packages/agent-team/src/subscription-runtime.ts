/**
 * The interval scheduler: admission, the wait queue, failure counting, and the
 * publication budget. Every decision here is made from injected ports, so a
 * fake clock and a fake executor can prove the boundaries the ticket names
 * without a real shell, a real timer, or a real ledger.
 * @module @contexera/dsh-agent-team/subscription-runtime
 */

import {
  nextDueAfter,
  scheduleAction,
  SUBSCRIPTION_CONCURRENT_RUNS,
  SUBSCRIPTION_FAILURES_BEFORE_PAUSE,
  SUBSCRIPTION_FIRST_RUN_MAX_DELAY_MS,
  SUBSCRIPTION_PUBLISH_PER_MINUTE,
  type SubscriptionShell,
} from './subscriptions.ts'
import type { AgentTeamSubscription, AgentTeamSubscriptionRef } from './types/entities.ts'

/**
 * What one run turned into, as the scheduler needs it. `accepted` and `empty`
 * are successful runs (the second found nothing new); `failed`, `backlog` and
 * `deferred` — a valid batch with no room in the unpublished queue — count
 * towards the pause; `dropped` means the subscription stopped being live while
 * the script ran.
 */
export type SubscriptionRunOutcome = 'accepted' | 'empty' | 'failed' | 'backlog' | 'deferred' | 'dropped'

/** Durable scheduler state for one subscription. It is not a Team fact: deleting it changes no domain result. */
export interface SubscriptionCheckpoint {
  readonly subscriptionRef: AgentTeamSubscriptionRef
  /** Absolute UTC instant the next timer run is due; absent before the Host ever scheduled it. */
  readonly dueAt?: number | undefined
  /** Failed runs in a row. Independent of the run records, which are diagnostics. */
  readonly consecutiveFailures: number
  /** When this subscription's output was last accepted. */
  readonly lastSuccessAt?: string | undefined
  /** The publish rate window: the minute it counts and how many events left the queue inside it. */
  readonly publishWindowMinute?: number | undefined
  readonly publishedInWindow: number
}

export const INITIAL_CHECKPOINT = { consecutiveFailures: 0, publishedInWindow: 0 } as const

/** The narrow host surface the scheduler drives. */
export interface SubscriptionRuntimePorts {
  readonly now: () => number
  readonly random: () => number
  readonly schedule: (run: () => void, delayMs: number) => unknown
  readonly cancel: (handle: unknown) => void
  readonly log: (message: string) => void
  /** Every subscription the ledger holds, deleted ones included. */
  readonly subscriptions: () => readonly AgentTeamSubscription[]
  /**
   * The definition the ledger holds for one ref right now, or `undefined` when
   * the ref was never stored — a create's draft trial. A queue entry holds a
   * snapshot, so this is how admission sees a delete that happened meanwhile.
   */
  readonly current: (subscriptionRef: AgentTeamSubscriptionRef) => AgentTeamSubscription | undefined
  /** Whether the Project that owns a subscription still runs. */
  readonly projectActive: (subscription: AgentTeamSubscription) => boolean
  readonly workspacePath: (subscription: AgentTeamSubscription) => string | undefined
  /** Accepted-but-unpublished events of one subscription, oldest first. */
  readonly pending: (subscriptionRef: AgentTeamSubscriptionRef) => readonly { readonly acceptedSequence: number; readonly eventId: string }[]
  /** Execute one timer run end to end (execute, validate, accept). */
  readonly run: (subscription: AgentTeamSubscription) => Promise<SubscriptionRunOutcome>
  /** Publish one accepted event; resolves when it is durable. */
  readonly publish: (subscription: AgentTeamSubscription, acceptedSequence: number, eventId: string) => Promise<void>
  /** Stop a subscription after repeated failures; the reason is the ledger's own. */
  readonly pauseForFailures: (subscription: AgentTeamSubscription) => Promise<void>
  readonly checkpoint: (subscriptionRef: AgentTeamSubscriptionRef) => SubscriptionCheckpoint
  /**
   * Change one checkpoint. `change` receives the record as it stands *at the
   * moment of the write*, under the subscription's write lock, and the settled
   * value comes back — or `undefined` when the subscription the ledger no longer
   * serves, where nothing is written. Callers pass a field, never the record
   * they read earlier: a whole-record write from a stale read drops what another
   * writer committed meanwhile.
   */
  readonly save: (subscriptionRef: AgentTeamSubscriptionRef,
    change: (checkpoint: SubscriptionCheckpoint) => SubscriptionCheckpoint) => Promise<SubscriptionCheckpoint | undefined>
}

/**
 * What a queued entry is allowed to start. A trial — create, update, test,
 * resume — still reaches a paused subscription, because testing and resuming one
 * is exactly how an owner brings it back. A `run` does not: it is a real
 * execution that would publish, so being paused refuses it, and a webhook replay
 * is admitted under this policy rather than beside the scheduler.
 */
export type SubscriptionAdmissionPolicy = 'trial' | 'run'

/** What a queue entry asks for: a timer run the loop found due, or an owner-requested execution. */
interface QueuedRun {
  readonly subscription: AgentTeamSubscription
  /** What this entry is allowed to start; the timer path carries `run` and gates itself before it queues. */
  readonly policy: SubscriptionAdmissionPolicy
  /**
   * Ordering key: the due instant a timer run answers, or the instant a trial
   * was requested. The queue is kept in this order, so a run that has waited
   * longest — whichever entry point produced it — goes first.
   */
  readonly orderAt: number
  /** Trial tasks carry the caller's own promise; timer runs report through the outcome port. */
  readonly task?: (() => Promise<unknown>) | undefined
  readonly settle?: ((outcome: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }) => void) | undefined
}

const TICK_MS = 1_000

/**
 * Owns the timer loop, the four run slots, and the per-minute publication
 * budget. A run and a publication are separate steps on purpose: a run that
 * succeeded only waits for budget, and is never executed twice for it.
 */
export class SubscriptionScheduler {
  private handle: unknown
  /** Whether the timer loop runs; a scheduler a test drives by hand is never started. */
  private stopped = true
  /** Set by {@link stop}: nothing new is admitted, and the queue is settled. */
  private draining = false
  private ticking: Promise<void> | undefined
  private readonly running = new Set<AgentTeamSubscriptionRef>()
  /** The due instant each executing timer run answers, so a tick can tell it is already spent. */
  private readonly runningDue = new Map<AgentTeamSubscriptionRef, number>()
  /** Admitted work, including publication after a run releases its slot; teardown does not wait for the queue. */
  private readonly inFlight = new Set<Promise<void>>()
  private readonly queue: QueuedRun[] = []
  /** One in-flight publication pass per subscription, so overlapping passes cannot spend the same budget. */
  private readonly publishing = new Map<AgentTeamSubscriptionRef, Promise<void>>()

  constructor(private readonly ports: SubscriptionRuntimePorts) {}

  /** Start the loop and give every timer subscription its first due instant. */
  start(): void {
    this.stopped = false
    this.handle = this.ports.schedule(() => { this.tick() }, TICK_MS)
  }

  /**
   * Stop admitting work and converge: reject every trial that never started,
   * then wait for admitted work, including publication that outlives its run
   * slot. A Host closes its stores only after this resolves, so late work cannot
   * write a closed one.
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.draining = true
    if (this.handle !== undefined) this.ports.cancel(this.handle)
    this.handle = undefined
    for (const entry of this.queue.splice(0)) {
      entry.settle?.({ ok: false, error: new Error('the Host is shutting down, so this run never started') })
    }
    const pending = [...(this.ticking === undefined ? [] : [this.ticking]), ...this.inFlight]
    await Promise.allSettled(pending)
  }

  /** Timer entry point. A tick never overlaps itself: one slow await must not queue the next one behind it. */
  private tick(): void {
    if (this.stopped) return
    this.handle = this.ports.schedule(() => { this.tick() }, TICK_MS)
    if (this.ticking !== undefined) return
    this.ticking = this.runTick()
      .catch((error: unknown) => {
        this.ports.log(`subscription tick failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => { this.ticking = undefined })
  }

  /** Run one scheduler pass immediately; exposed so tests and a manual nudge share the production path. */
  async runTick(): Promise<void> {
    if (this.draining) return
    await this.settleBoot()
    await this.publishPass()
    await this.timerPass()
    await this.admit()
  }

  /**
   * One owner-requested execution — the trial behind create, update, test, and
   * resume, or a replay of a failed delivery — under the same four slots as a
   * timer run. A trial is not a second kind of capacity: without this, twenty
   * creates would start twenty scripts, and a replay would run beside them.
   */
  runAdmitted<T>(subscription: AgentTeamSubscription, policy: SubscriptionAdmissionPolicy, task: () => Promise<T>): Promise<T> {
    if (this.draining) return Promise.reject(new Error('the Host is shutting down, so this run never started'))
    return new Promise<T>((resolve, reject) => {
      this.enqueue({ subscription, policy, orderAt: this.ports.now(), task,
        settle: outcome => { if (outcome.ok) resolve(outcome.value as T); else reject(outcome.error) } })
      void this.admit()
    })
  }

  /** The trial path: the same admission, with the policy that still lets a paused subscription be tested. */
  runTrial<T>(subscription: AgentTeamSubscription, task: () => Promise<T>): Promise<T> {
    return this.runAdmitted(subscription, 'trial', task)
  }

  /** Give booted or newly created timers a first due instant, preserving every persisted one for catch-up. */
  async settleBoot(): Promise<void> {
    const now = this.ports.now()
    for (const subscription of this.ports.subscriptions()) {
      const live = this.ports.current(subscription.subscriptionRef) ?? subscription
      if (live.triggers.interval === undefined) continue
      if (live.state !== 'active' || !this.ports.projectActive(live)) continue
      if (this.ports.checkpoint(live.subscriptionRef).dueAt !== undefined) continue
      const delay = Math.floor(this.ports.random() * SUBSCRIPTION_FIRST_RUN_MAX_DELAY_MS)
      await this.ports.save(live.subscriptionRef, checkpoint => ({ ...checkpoint, dueAt: now + delay }))
    }
  }

  private timerPass(): Promise<void> {
    const work: Promise<void>[] = []
    const now = this.ports.now()
    for (const subscription of this.ports.subscriptions()) {
      // The ledger's current record, not the snapshot this iteration happens to
      // hold: a deletion must stop the timer at the moment it is decided, not
      // one admission later.
      const live = this.ports.current(subscription.subscriptionRef) ?? subscription
      const interval = live.triggers.interval
      if (interval === undefined) continue
      const checkpoint = this.ports.checkpoint(live.subscriptionRef)
      const queued = this.queue.some(entry => entry.task === undefined
        && entry.subscription.subscriptionRef === live.subscriptionRef)
      const action = scheduleAction({
        ...(checkpoint.dueAt === undefined ? {} : { dueAt: checkpoint.dueAt }),
        now,
        paused: live.state !== 'active',
        deleted: live.state === 'deleted',
        archived: !this.ports.projectActive(live),
        pending: this.ports.pending(live.subscriptionRef).length,
        // A due instant already being executed is spent, so it merges like a
        // queued one. A subscription that is merely busy with a trial still
        // takes its due place now — admission refuses to start it beside that
        // run — because waiting would hand its turn to a later request.
        busy: queued || this.runningDue.get(live.subscriptionRef) === checkpoint.dueAt,
      })
      if (action === 'wait') continue
      if (action === 'skip') {
        // A terminal record keeps no checkpoint: the deletion already removed
        // it and nothing will ever run again, so writing one here would only
        // revive a row nobody reads.
        if (live.state === 'deleted' || !this.ports.projectActive(live)) continue
        // A due instant still ahead already answers every later decision, so
        // a paused or backlogged subscription is re-decided each tick without
        // being re-written; the record advances only once the instant passes.
        if (checkpoint.dueAt !== undefined && checkpoint.dueAt > now) continue
        work.push(this.saveDue(live, nextDueAfter(now, interval.minutes)))
        continue
      }
      // Wait in due order: an entry waiting for its own trial to finish keeps
      // the instant it came due, so the fairness rule stays "longest wait first".
      this.enqueue({ subscription: live, policy: 'run', orderAt: checkpoint.dueAt ?? now })
    }
    return Promise.all(work).then(() => {})
  }

  private async admit(): Promise<void> {
    if (this.draining) return
    while (this.running.size < SUBSCRIPTION_CONCURRENT_RUNS) {
      // Skip entries whose own subscription is executing; they keep their place,
      // and blocking the whole queue behind one busy subscription would be worse.
      const index = this.queue.findIndex(entry => !this.running.has(entry.subscription.subscriptionRef))
      if (index === -1) return
      const [next] = this.queue.splice(index, 1)
      if (next === undefined) return
      // An entry waited with a snapshot, so the terminal barrier is read again
      // here from the ledger: one that was deleted or archived meanwhile must
      // not spend a slot, let alone run a script for a record that is gone.
      const stored = this.ports.current(next.subscription.subscriptionRef)
      const live = stored ?? next.subscription
      if (next.task !== undefined) {
        const refusal = this.admissionRefusal(next.policy, stored, live)
        if (refusal !== undefined) {
          next.settle?.({ ok: false, error: refusal })
          continue
        }
        this.track(this.launchAdmitted(next))
        continue
      }
      // A subscription deleted or paused while it waited loses its turn: the
      // terminal barrier is checked again at admission, not only at enqueue.
      if (live.state !== 'active' || !this.ports.projectActive(live)) continue
      this.track(this.launchTimer(live, next.orderAt))
    }
  }

  /**
   * Why a queued execution may no longer start, or `undefined` when it may.
   *
   * The terminal barrier is re-read from the ledger, not from the snapshot the
   * entry waited with. A draft — a create's trial, never stored — is judged by
   * its own snapshot, because it has no record to reconcile against. A stored
   * record is judged by the state it holds now: `test` and `resume` still reach
   * a paused subscription, while a paused one refuses a real run, since a run is
   * what pausing stops.
   */
  private admissionRefusal(policy: SubscriptionAdmissionPolicy, stored: AgentTeamSubscription | undefined,
    live: AgentTeamSubscription): Error | undefined {
    const ref = live.subscriptionRef
    const noun = policy === 'trial' ? 'trial' : 'run'
    if (stored !== undefined && stored.state === 'deleted') {
      return new Error(`subscription '${ref}' was deleted while this ${noun} waited, so the script never ran (subscription_deleted)`)
    }
    if (!this.ports.projectActive(live)) {
      return new Error(`the Project of subscription '${ref}' was archived while this ${noun} waited, so the script never ran (project_archived)`)
    }
    if (policy === 'run') {
      if (stored === undefined) return new Error(`subscription '${ref}' is no longer in the ledger, so the script never ran (subscription_deleted)`)
      if (stored.state !== 'active') {
        return new Error(`subscription '${ref}' is paused, so it cannot run this delivery (subscription_paused)`)
      }
    }
    return undefined
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work)
    void work
      .catch((error: unknown) => {
        this.ports.log(`subscription run failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => { this.inFlight.delete(work) })
  }

  private async launchAdmitted(entry: QueuedRun): Promise<void> {
    const ref = entry.subscription.subscriptionRef
    const task = entry.task!
    this.running.add(ref)
    try {
      entry.settle?.({ ok: true, value: await task() })
    } catch (error) {
      entry.settle?.({ ok: false, error })
    } finally {
      this.running.delete(ref)
      // A freed slot is admitted immediately: a queued create must not wait for
      // the next timer tick to start.
      void this.admit()
    }
  }

  private async launchTimer(subscription: AgentTeamSubscription, dueAt: number): Promise<void> {
    const ref = subscription.subscriptionRef
    // The spent-due marker outlives the execution: a tick that lands between
    // the run ending and its checkpoint write would re-execute the same due
    // instant if the marker were already gone.
    this.running.add(ref)
    this.runningDue.set(ref, dueAt)
    const interval = subscription.triggers.interval
    let outcome: SubscriptionRunOutcome = 'failed'
    try {
      try {
        outcome = await this.ports.run(subscription)
      } catch (error) {
        this.ports.log(`subscription '${ref}' run failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      // Recording the outcome and publishing are each best-effort steps of their
      // own: a checkpoint write or a publication that throws must not skip the
      // other, and must never surface as an unhandled rejection.
      await this.settleOutcome(subscription, outcome, interval).catch((error: unknown) => {
        this.ports.log(`subscription '${ref}' could not record its outcome: ${error instanceof Error ? error.message : String(error)}`)
      })
    } finally {
      this.running.delete(ref)
      this.runningDue.delete(ref)
      // A freed slot is admitted immediately: a queued create must not wait for
      // the next timer tick to start.
      void this.admit()
    }
    await this.publishPass().catch((error: unknown) => {
      this.ports.log(`subscription '${ref}' could not publish after its run: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * Record what the run decided.
   *
   * A success wrote its own half already: the run clears the streak at the
   * instant its output was accepted, because only the accept knows that instant
   * — so this advances the next due time and nothing else. A failure increments
   * the count it reads at the write, under the same lock, so the count it adds to
   * is the one the previous writer committed. `deferred` counts like a failure:
   * a timer pulls, so its next run prints the same output again.
   */
  private async settleOutcome(subscription: AgentTeamSubscription, outcome: SubscriptionRunOutcome,
    interval: AgentTeamSubscription['triggers']['interval']): Promise<void> {
    // Neither a success nor a failure, and no write either: the record it would
    // have updated is gone or archived, so saving here would revive a checkpoint
    // that the deletion already removed.
    if (outcome === 'dropped') return
    const ref = subscription.subscriptionRef
    const now = this.ports.now()
    const due = interval === undefined ? {} : { dueAt: nextDueAfter(now, interval.minutes) }
    const settled = await this.ports.save(ref, outcome === 'accepted' || outcome === 'empty'
      ? checkpoint => ({ ...checkpoint, ...due })
      : checkpoint => ({ ...checkpoint, consecutiveFailures: checkpoint.consecutiveFailures + 1, ...due }))
    if (settled === undefined) return
    if (outcome !== 'accepted' && outcome !== 'empty' && settled.consecutiveFailures >= SUBSCRIPTION_FAILURES_BEFORE_PAUSE) {
      await this.ports.pauseForFailures(subscription)
    }
  }

  private async saveDue(subscription: AgentTeamSubscription, dueAt: number): Promise<void> {
    await this.ports.save(subscription.subscriptionRef, checkpoint => ({ ...checkpoint, dueAt }))
  }

  /** Keep the wait queue in due order: the longest wait is admitted first, whatever produced it. */
  private enqueue(entry: QueuedRun): void {
    const index = this.queue.findIndex(queued => queued.orderAt > entry.orderAt)
    if (index === -1) this.queue.push(entry)
    else this.queue.splice(index, 0, entry)
  }

  /**
   * Publish what the budget allows, oldest accepted first, one subscription at
   * a time. A publication that fails leaves the event pending: the ledger has
   * no record of it, so the next pass retries from the same queue. One
   * subscription's storage failure must not abort the others' publications.
   */
  private async publishPass(): Promise<void> {
    for (const subscription of this.ports.subscriptions()) {
      try {
        await this.publishOne(subscription)
      } catch (error) {
        this.ports.log(`subscription '${subscription.subscriptionRef}' could not publish: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** One subscription's share of a publication pass. */
  private async publishOne(subscription: AgentTeamSubscription): Promise<void> {
    // Passes serialize per subscription: the tick's pass and a finishing run's
    // pass can overlap, and two of them reading the same budget and the same
    // pending head would double-spend the minute and republish one entry.
    const serialized = subscription.subscriptionRef
    const chained = (this.publishing.get(serialized) ?? Promise.resolve()).catch(() => {})
      .then(() => this.publishOnePass(subscription))
    this.publishing.set(serialized, chained)
    try {
      await chained
    } finally {
      if (this.publishing.get(serialized) === chained) this.publishing.delete(serialized)
    }
  }

  private async publishOnePass(subscription: AgentTeamSubscription): Promise<void> {
    // A terminal record publishes nothing, and its checkpoint is not rewritten
    // either: the accepted output stays unpublished, instead of being retried
    // and logged on every tick for a subscription that no longer exists. A
    // paused subscription still publishes — pausing stops runs, not delivery.
    const live = this.ports.current(subscription.subscriptionRef) ?? subscription
    if (live.state === 'deleted' || !this.ports.projectActive(live)) return
    // The window is per minute per subscription, and it survives a restart
    // because it lives in the checkpoint, not in memory. It resets only
    // forward: a clock that jumps back must not hand out the same minute's
    // budget twice.
    let checkpoint = this.ports.checkpoint(subscription.subscriptionRef)
    const minute = Math.floor(this.ports.now() / 60_000)
    if (checkpoint.publishWindowMinute === undefined || minute > checkpoint.publishWindowMinute) {
      checkpoint = await this.ports.save(subscription.subscriptionRef,
        current => ({ ...current, publishWindowMinute: minute, publishedInWindow: 0 })) ?? checkpoint
    }
    let budget = SUBSCRIPTION_PUBLISH_PER_MINUTE - checkpoint.publishedInWindow
    if (budget <= 0) return
    for (const entry of this.ports.pending(subscription.subscriptionRef)) {
      if (budget <= 0) break
      try {
        await this.ports.publish(live, entry.acceptedSequence, entry.eventId)
      } catch (error) {
        this.ports.log(`subscription '${subscription.subscriptionRef}' could not publish '${entry.eventId}': ${error instanceof Error ? error.message : String(error)}`)
        break
      }
      checkpoint = await this.ports.save(subscription.subscriptionRef, current => ({ ...current,
        publishedInWindow: current.publishedInWindow + 1 })) ?? checkpoint
      budget -= 1
    }
  }

  /** Live state for diagnostics and tests: what is running and what is waiting. */
  state(): { readonly running: readonly AgentTeamSubscriptionRef[]; readonly queued: readonly AgentTeamSubscriptionRef[] } {
    return Object.freeze({ running: Object.freeze([...this.running]), queued: Object.freeze(this.queue.map(entry => entry.subscription.subscriptionRef)) })
  }
}

/** The shell a snapshot was recorded under, as the executor reported itself; a different family fails the run with this. */
export function shellMismatchReason(recorded: SubscriptionShell, actual: SubscriptionShell): string | undefined {
  if (recorded === actual) return undefined
  return `this subscription was created for ${recorded}, but the Host runs ${actual}`
}
