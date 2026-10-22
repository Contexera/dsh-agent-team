import type { TeamChangeListener, TeamChangeScope, TeamChangeUpdate } from './team-changes.ts'
import type { TeamChangeStream } from './team-changes.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** `key` is what concurrent consumers agree on to share an in-flight read; `covers` lists the change scopes that can change its data. */
export interface TeamQueryIdentity {
  readonly key: string
  readonly covers: (scope: TeamChangeScope) => boolean
}

export type WorkspaceScopeKind = 'workspace' | 'presence'

/**
 * Whether a change scope names one of the query's scope kinds in its Workspace. The scope-less stream is excluded:
 * every delivery touching such data has already woken the Workspace scope, so admitting it only adds redundant reads.
 */
export function coversWorkspaceScope(scope: TeamChangeScope, workspaceId: WorkspaceId | undefined, kind: WorkspaceScopeKind): boolean {
  return scope !== undefined && scope.kind === kind && scope.workspaceId === workspaceId
}

/** Per-query read counters. Diagnostics record identity and counts only — never response bodies. */
export interface TeamQueryCounters {
  readonly issued: number
  /** Requests that joined a read instead of starting their own. */
  readonly shared: number
  /** Invalidations that made a read no longer joinable. */
  readonly superseded: number
  /** Responses dropped because a newer response for the same query already landed. */
  readonly droppedStale: number
  /** Responses dropped because an invalidation superseded the read before it landed. */
  readonly droppedSuperseded: number
  /** Reads that failed in any shape (rejected, error result, error payload); delivery is unchanged and the consumer renders its own `result.ok` face. */
  readonly failed: number
}

/**
 * Presence scopes carry the process-local presence epoch; every other scope carries the ledger's projection position.
 * Watermarks are per domain: comparing the unrelated counters would miss and invent invalidations.
 */
type VersionDomain = 'presence' | 'projection'

interface QueryState {
  identity: TeamQueryIdentity
  readonly counters: Mutable<TeamQueryCounters>
  /** Last invalidating version seen per domain; the same version carries no new data. */
  readonly invalidated: Partial<Record<VersionDomain, number>>
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

const answeredFailure = (outcome: Outcome): boolean =>
  outcome.ok && typeof outcome.value === 'object' && outcome.value !== null && (outcome.value as { readonly ok?: unknown }).ok === false

interface InFlight {
  readonly key: string
  readonly issuance: number
  readonly state: QueryState
  readonly load: () => Promise<unknown>
  superseded: boolean
  /** Set once the response landed: the entry still shares this response through the microtask drain. */
  outcome?: Outcome
  readonly waiters: Waiter[]
}

/**
 * The Client's one owner for Team data reads, with per-query counters so duplicate reads and stale drops are observable.
 *
 * - A request joins the read for its key unless a wake it predates has invalidated it. A landed response stays joinable
 *   through the rest of the microtask drain; the next task reads Host state fresh.
 * - Each change dispatch invalidates once per (scope, version); a stream-opening baseline always invalidates.
 * - A superseded response never applies: waiters join its replacement, or the owner issues one, so an invalidation
 *   always ends in fresh data.
 * - The response lands on the microtask that resolves it; the issuance guard drops any older response arriving later.
 */
export class TeamQueries {
  private readonly states = new Map<string, QueryState>()
  private readonly inFlight = new Map<string, InFlight>()
  /** Dispatches already folded into invalidations, so co-subscribers of one dispatch mark once. */
  private readonly folded = new WeakSet<TeamChangeUpdate>()
  private issuance = 0
  private disposed = false

  constructor(private readonly changes: Pick<TeamChangeStream, 'subscribe'>) {}

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
   * Folds each dispatch into invalidations before the consumer's own listener runs, so the first requesting consumer
   * issues the shared read and the rest join it.
   */
  subscribeChanges(scope: TeamChangeScope, listener: TeamChangeListener): () => void {
    return this.changes.subscribe(scope, update => {
      if (update.type === 'changed') this.invalidate(scope, update)
      listener(update)
    })
  }

  /**
   * A new generation restarts the presence epoch and supersedes every read, pending or landed; otherwise a low presence
   * version would collide with the old watermark and a pre-reset response could reach a post-reset reader.
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
      this.dropStale(entry, current)
      return
    }
    if (entry.superseded) {
      this.deliverSuperseded(entry, current)
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
      queueMicrotask(() => {
        if (this.inFlight.get(entry.key) === entry) this.inFlight.delete(entry.key)
      })
    }
    this.deliver(entry, outcome)
  }

  /** The stale payload is dropped whole, failure included, so an old error never masks newer data. */
  private dropStale(entry: InFlight, current: boolean): void {
    entry.state.counters.droppedStale += 1
    this.logDrop(entry, 'stale')
    if (current) this.inFlight.delete(entry.key)
    this.deliver(entry, entry.state.stored)
  }

  /**
   * An invalidation superseded this read: its payload must never become the query's state. Waiters move to the
   * replacement read; when the wake left none, issue it here so the invalidation still ends in fresh data.
   */
  private deliverSuperseded(entry: InFlight, current: boolean): void {
    entry.state.counters.droppedSuperseded += 1
    this.logDrop(entry, 'superseded')
    if (current) this.inFlight.delete(entry.key)
    const target = this.inFlight.get(entry.key)
    if (target !== undefined && target !== entry) {
      if (target.outcome !== undefined) this.deliver(entry, target.outcome)
      else target.waiters.push(...entry.waiters.splice(0, entry.waiters.length))
      return
    }
    if (!this.disposed) {
      const retry = this.issue(entry.state.identity, entry.load)
      retry.waiters.push(...entry.waiters.splice(0, entry.waiters.length))
      return
    }
    this.deliver(entry, entry.state.stored)
  }

  private logDrop(entry: InFlight, reason: 'stale' | 'superseded'): void {
    console.info('[agent-team] stale read response dropped', { query: entry.key, issuance: entry.issuance, landed: entry.state.applied, reason })
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
