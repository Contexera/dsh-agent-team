import type { TeamChangeListener, TeamChangeScope, TeamChangeUpdate } from './team-changes.ts'
import type { TeamChangeStream } from './team-changes.ts'

/**
 * One data query's identity. `key` names the query in diagnostics and is what
 * concurrent consumers must agree on to share an in-flight read; `covers` says
 * which change scopes can change this query's data, so an unrelated wake never
 * invalidates it.
 */
export interface TeamQueryIdentity {
  readonly key: string
  readonly covers: (scope: TeamChangeScope) => boolean
}

/** Per-query read counters. Diagnostics record identity and counts only — never response bodies. */
export interface TeamQueryCounters {
  /** Underlying reads started for this query. */
  readonly issued: number
  /** Requests that joined a read instead of starting their own. */
  readonly shared: number
  /** Invalidations that made a read no longer joinable. */
  readonly superseded: number
  /** Responses dropped because a newer response for the same query already landed. */
  readonly droppedStale: number
  /** Responses dropped because an invalidation superseded the read before it landed. */
  readonly droppedSuperseded: number
  /** Reads that answered with an error or rejected. */
  readonly failed: number
}

/**
 * The Host keeps two version domains: presence scopes carry the process-local
 * presence epoch, every other scope carries the ledger's projection position.
 * Watermarks are tracked per domain because the two counters are unrelated —
 * comparing them across domains would both miss and invent invalidations.
 */
type VersionDomain = 'presence' | 'projection'

interface QueryState {
  identity: TeamQueryIdentity
  readonly counters: Mutable<TeamQueryCounters>
  /** Last invalidating version seen per domain; the same version carries no new data. */
  readonly invalidated: Partial<Record<VersionDomain, number>>
  /** Issuance of the response that last landed for this query. */
  applied: number
  /** The response that last landed; a stale drop hands waiters this instead of its own payload. */
  stored: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown } | undefined
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

interface Waiter {
  resolve(value: unknown): void
  reject(reason: unknown): void
}

type Outcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }

/**
 * A Remote answer that reports failure inside its payload: the `failed`
 * counter observes it like a rejection — that is the documented shape of the
 * counter — while delivery stays unchanged, because the consumer's own
 * `result.ok` face is what renders the error.
 */
const answeredFailure = (outcome: Outcome): boolean =>
  outcome.ok && typeof outcome.value === 'object' && outcome.value !== null && (outcome.value as { readonly ok?: unknown }).ok === false

interface InFlight {
  readonly key: string
  readonly issuance: number
  readonly state: QueryState
  /** Kept so an invalidation with no replacement read can re-issue the same request. */
  readonly load: () => Promise<unknown>
  superseded: boolean
  /** Set once the response landed: the entry still shares this response through the microtask drain. */
  outcome?: Outcome
  readonly waiters: Waiter[]
}

/**
 * The Client's one owner for Team data reads. Consumers ask by query identity;
 * the owner decides whether a request can share a read, drops responses a newer
 * response has superseded, and keeps per-query counters so duplicate reads and
 * stale drops are observable without logging any response body.
 *
 * Joining rules, in order:
 * - A request joins the read for its key unless that read has been invalidated
 *   (a wake the read predates) — the same invalidation's N consumers therefore
 *   share one underlying read. A landed response stays joinable through the
 *   rest of the microtask drain, so a consumer reacting one microtask after
 *   the dispatch shares it too; the next task reads Host state fresh.
 * - Every change dispatch invalidates once per (scope, version); the same
 *   version means no new data, and a stream-opening baseline always
 *   invalidates regardless of version (it is the reconnect's fresh start).
 * - A superseded response never applies: its waiters join the read that
 *   replaced it, or the owner issues that replacement itself when the wake
 *   left none — so an invalidation always ends in fresh data, not a failure.
 * - The response lands on the microtask that resolves it: no timer sits
 *   between Host answer and consumer, and the issuance guard drops any older
 *   response that arrives afterwards.
 */
export class TeamQueries {
  private readonly states = new Map<string, QueryState>()
  private readonly inFlight = new Map<string, InFlight>()
  /** Dispatches already folded into invalidations, so co-subscribers of one dispatch mark once. */
  private readonly folded = new WeakSet<TeamChangeUpdate>()
  private issuance = 0
  private disposed = false

  constructor(private readonly changes: Pick<TeamChangeStream, 'subscribe'>) {}

  /** Read one query, sharing the current read when it is still joinable. */
  read<T>(identity: TeamQueryIdentity, load: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(identity.key)
    if (existing !== undefined && !existing.superseded) {
      existing.state.counters.shared += 1
      return new Promise<T>((resolve, reject) => {
        const waiter = { resolve: resolve as unknown as (value: unknown) => void, reject }
        if (existing.outcome !== undefined) {
          if (existing.outcome.ok) waiter.resolve(existing.outcome.value)
          else waiter.reject(existing.outcome.error)
          return
        }
        existing.waiters.push(waiter)
      })
    }
    return new Promise<T>((resolve, reject) => {
      this.issue(identity, load).waiters.push({ resolve: resolve as unknown as (value: unknown) => void, reject })
    })
  }

  private issue(identity: TeamQueryIdentity, load: () => Promise<unknown>): InFlight {
    const state = this.state(identity)
    const issuance = (this.issuance += 1)
    const entry: InFlight = { key: identity.key, issuance, state, load, superseded: false, waiters: [] }
    this.inFlight.set(identity.key, entry)
    state.counters.issued += 1
    let started: Promise<unknown>
    try {
      started = load()
    } catch (error) {
      started = Promise.reject(error)
    }
    void started.then(
      value => this.settle(entry, { ok: true, value }),
      error => this.settle(entry, { ok: false, error }),
    )
    return entry
  }

  /**
   * Subscribe to a change scope, folding each dispatch into query
   * invalidations before the consumer's own listener runs — that order is
   * what makes the first requesting consumer issue the shared read and the
   * rest join it.
   */
  subscribeChanges(scope: TeamChangeScope, listener: TeamChangeListener): () => void {
    return this.changes.subscribe(scope, update => {
      if (update.type === 'changed') this.invalidate(scope, update)
      listener(update)
    })
  }

  /**
   * A new connection generation restarts the presence epoch and supersedes
   * every read — pending or landed: without this, a restarted Host's low
   * presence version would collide with the old watermark, and a pre-reset
   * response could still be handed to a post-reset reader.
   */
  newGeneration(): void {
    for (const state of this.states.values()) {
      delete state.invalidated.presence
      delete state.invalidated.projection
    }
    for (const entry of this.inFlight.values()) {
      this.supersede(entry)
      if (entry.outcome !== undefined && this.inFlight.get(entry.key) === entry) this.inFlight.delete(entry.key)
    }
  }

  /** Per-query read counters for diagnostics. */
  diagnostics(): Record<string, Readonly<TeamQueryCounters>> {
    const snapshot: Record<string, Readonly<TeamQueryCounters>> = {}
    for (const [key, state] of this.states) snapshot[key] = { ...state.counters }
    return snapshot
  }

  dispose(): void {
    this.disposed = true
    this.states.clear()
    this.inFlight.clear()
  }

  private state(identity: TeamQueryIdentity): QueryState {
    const existing = this.states.get(identity.key)
    if (existing !== undefined) {
      existing.identity = identity
      return existing
    }
    const state: QueryState = {
      identity,
      counters: { issued: 0, shared: 0, superseded: 0, droppedStale: 0, droppedSuperseded: 0, failed: 0 },
      invalidated: {},
      applied: 0,
      stored: undefined,
    }
    this.states.set(identity.key, state)
    return state
  }

  private invalidate(scope: TeamChangeScope, update: TeamChangeUpdate & { readonly type: 'changed' }): void {
    if (this.folded.has(update)) return
    this.folded.add(update)
    const domain: VersionDomain = scope?.kind === 'presence' ? 'presence' : 'projection'
    for (const state of this.states.values()) {
      if (!state.identity.covers(scope)) continue
      if (update.baseline !== true && state.invalidated[domain] === update.version) continue
      state.invalidated[domain] = update.version
      const entry = this.inFlight.get(state.identity.key)
      if (entry !== undefined) this.supersede(entry)
    }
  }

  private supersede(entry: InFlight): void {
    if (entry.superseded) return
    entry.superseded = true
    entry.state.counters.superseded += 1
  }

  private settle(entry: InFlight, outcome: Outcome): void {
    const current = this.inFlight.get(entry.key) === entry
    const state = entry.state
    if (!outcome.ok || answeredFailure(outcome)) state.counters.failed += 1
    if (entry.issuance <= state.applied) {
      // A newer response for this query already landed. The stale payload is
      // dropped whole — and so is its failure: the newest known result is the
      // one waiters receive, so an old error never masks newer data either.
      state.counters.droppedStale += 1
      // Counters and identity only; response bodies never reach the log.
      console.info('[agent-team] stale read response dropped', { query: entry.key, issuance: entry.issuance, landed: state.applied, reason: 'stale' })
      if (current) this.inFlight.delete(entry.key)
      this.deliver(entry, state.stored)
      return
    }
    if (entry.superseded) {
      // An invalidation — a wake, or a new connection generation — superseded
      // this read before anything newer landed. Its payload must never become
      // the query's state: that is exactly how a pre-reset response would be
      // handed to a post-reset reader. Waiters move to the read that took its
      // place; when the wake left no replacement — its own listener may sit on
      // a narrower scope, or the surface may already be gone — the layer
      // issues that replacement itself, so the invalidation still ends in
      // fresh data rather than a failure.
      state.counters.droppedSuperseded += 1
      console.info('[agent-team] stale read response dropped', { query: entry.key, issuance: entry.issuance, landed: state.applied, reason: 'superseded' })
      if (current) this.inFlight.delete(entry.key)
      const target = this.inFlight.get(entry.key)
      if (target !== undefined && target !== entry) {
        if (target.outcome !== undefined) this.deliver(entry, target.outcome)
        else target.waiters.push(...entry.waiters.splice(0, entry.waiters.length))
        return
      }
      if (!this.disposed) {
        const retry = this.issue(state.identity, entry.load)
        retry.waiters.push(...entry.waiters.splice(0, entry.waiters.length))
        return
      }
      this.deliver(entry, state.stored)
      return
    }
    state.applied = entry.issuance
    state.stored = outcome
    entry.outcome = outcome
    if (!outcome.ok) {
      // A failure is not shareable state: the next consumer retries Host state.
      if (current) this.inFlight.delete(entry.key)
      this.deliver(entry, outcome)
      return
    }
    if (current) {
      // The landed response stays shareable through the rest of this microtask
      // drain — a consumer reacting to the same change a microtask later still
      // joins it instead of paying a second read. The next task reads fresh.
      queueMicrotask(() => {
        if (this.inFlight.get(entry.key) === entry) this.inFlight.delete(entry.key)
      })
    }
    this.deliver(entry, outcome)
  }

  private deliver(entry: InFlight, outcome: Outcome | undefined): void {
    const waiters = entry.waiters.splice(0, entry.waiters.length)
    if (outcome === undefined) {
      // Only a drop after dispose lands here: live drops hand waiters the
      // replacement read's result. Rejected rather than left pending so no waiter hangs.
      for (const waiter of waiters) waiter.reject(new Error('read superseded before any result landed'))
      return
    }
    for (const waiter of waiters) {
      if (outcome.ok) waiter.resolve(outcome.value)
      else waiter.reject(outcome.error)
    }
  }
}
