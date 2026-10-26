import type { TeamChangeListener, TeamChangeScope, TeamChangeUpdate } from './team-changes.ts'
import type { TeamChangeStream } from './team-changes.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** The scope kinds a rule can name; `scopeLess` is the stream without a scope, whose deliveries already woke every Workspace. */
export type TeamQueryScopeKind = 'workspace' | 'presence' | 'project' | 'thread' | 'scopeLess'

/**
 * A query's invalidation policy in comparable form. `covers` closures are rebuilt on every render, so the rule that
 * decides them carries its own identity: two reads of one key must name the same kinds and the same Workspace.
 */
export interface TeamQueryRule {
  readonly kinds: readonly TeamQueryScopeKind[]
  /** The Workspace whose `workspace` and `presence` scopes the rule admits; other kinds are not Workspace-scoped. */
  readonly workspaceId: WorkspaceId | undefined
}

/**
 * The stable identity of a rule: what it admits, not which closure computed it. Sorted so the order a factory lists
 * kinds in cannot make two equivalent rules look different.
 */
export function describeRule(rule: TeamQueryRule): string {
  return `${[...rule.kinds].sort().join(',')}|${rule.workspaceId ?? '*'}`
}

/** `key` is what concurrent consumers agree on to share an in-flight read; `rule` names the change scopes that can change its data. */
export interface TeamQueryIdentity<Result> {
  readonly key: TeamQueryKey<Result>
  readonly rule: TeamQueryRule
}

declare const teamQueryResult: unique symbol

/**
 * A query key branded with the result type it reads. The brand exists only at compile time — at runtime the key is the
 * plain string consumers agree on — so a key typed for one result cannot be read through a loader that returns another.
 */
export type TeamQueryKey<Result> = string & { readonly [teamQueryResult]: Result }

/** The only way to brand a key: the production query factories call this, so every key's result type is stated once. */
export function teamQueryKey<Result>(key: string): TeamQueryKey<Result> {
  return key as TeamQueryKey<Result>
}

export type WorkspaceScopeKind = 'workspace' | 'presence'

/**
 * Whether a change scope names one of the query's scope kinds in its Workspace. The scope-less stream is excluded:
 * every delivery touching such data has already woken the Workspace scope, so admitting it only adds redundant reads.
 */
export function coversWorkspaceScope(scope: TeamChangeScope, workspaceId: WorkspaceId | undefined, kind: WorkspaceScopeKind): boolean {
  return scope !== undefined && scope.kind === kind && scope.workspaceId === workspaceId
}

/** Whether a rule admits a change scope. Derived from the rule, so no per-read closure can disagree with it. */
export function coversRule(scope: TeamChangeScope, rule: TeamQueryRule): boolean {
  if (scope === undefined) return rule.kinds.includes('scopeLess')
  if (!rule.kinds.includes(scope.kind)) return false
  if (scope.kind !== 'workspace' && scope.kind !== 'presence') return true
  return rule.workspaceId === undefined || coversWorkspaceScope(scope, rule.workspaceId, scope.kind)
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

interface QueryState<Result> {
  readonly key: TeamQueryKey<Result>
  /** Registered once with the key; a later read naming a different rule fails rather than replacing it. */
  readonly rule: TeamQueryRule
  readonly counters: Mutable<TeamQueryCounters>
  /** Last invalidating version seen per domain; the same version carries no new data. */
  readonly invalidated: Partial<Record<VersionDomain, number>>
  applied: number
  /** The response that last landed; a stale drop hands waiters this instead of its own payload. */
  stored: Outcome<Result> | undefined
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

interface Waiter<Result> {
  resolve(value: Result): void
  reject(reason: unknown): void
}

type Outcome<Result> = { readonly ok: true; readonly value: Result } | { readonly ok: false; readonly error: unknown }

const answeredFailure = (outcome: Outcome<unknown>): boolean =>
  outcome.ok && typeof outcome.value === 'object' && outcome.value !== null && (outcome.value as { readonly ok?: unknown }).ok === false

interface InFlight<Result> {
  readonly key: TeamQueryKey<Result>
  readonly issuance: number
  readonly state: QueryState<Result>
  readonly load: () => Promise<Result>
  superseded: boolean
  /** Set once the response landed: the entry still shares this response through the microtask drain. */
  outcome?: Outcome<Result>
  readonly waiters: Waiter<Result>[]
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
  private readonly states = new Map<string, QueryState<unknown>>()
  private readonly inFlight = new Map<string, InFlight<unknown>>()
  /** Dispatches already folded into invalidations, so co-subscribers of one dispatch mark once. */
  private readonly folded = new WeakSet<TeamChangeUpdate>()
  private issuance = 0
  private disposed = false

  constructor(private readonly changes: Pick<TeamChangeStream, 'subscribe'>) {}

  read<Result>(identity: TeamQueryIdentity<Result>, load: () => Promise<Result>): Promise<Result> {
    const state = this.state(identity)
    const existing = this.inFlight.get(identity.key)
    if (existing !== undefined && !existing.superseded) {
      existing.state.counters.shared += 1
      // The key's brand is what makes this re-type sound: `state` already confirmed this key's result type matches.
      const entry = existing as InFlight<Result>
      return new Promise<Result>((resolve, reject) => {
        const waiter: Waiter<Result> = { resolve, reject }
        if (entry.outcome !== undefined) {
          if (entry.outcome.ok) waiter.resolve(entry.outcome.value)
          else waiter.reject(entry.outcome.error)
          return
        }
        entry.waiters.push(waiter as Waiter<unknown>)
      })
    }
    return new Promise<Result>((resolve, reject) => {
      this.issue(identity, state, load).waiters.push({ resolve, reject } as Waiter<unknown>)
    })
  }

  private issue<Result>(identity: TeamQueryIdentity<Result>, state: QueryState<Result>, load: () => Promise<Result>): InFlight<Result> {
    const issuance = (this.issuance += 1)
    const entry: InFlight<Result> = { key: identity.key, issuance, state, load, superseded: false, waiters: [] }
    this.inFlight.set(identity.key, entry as InFlight<unknown>)
    state.counters.issued += 1
    let started: Promise<Result>
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

  /**
   * The state for a key, registering its rule on first use. A later read that names a different rule is a programming
   * error the type system cannot catch — the rule is data, not a type — so it fails here instead of silently replacing
   * the policy every later invalidation would then follow.
   */
  private state<Result>(identity: TeamQueryIdentity<Result>): QueryState<Result> {
    const existing = this.states.get(identity.key)
    if (existing !== undefined) {
      if (describeRule(existing.rule) !== describeRule(identity.rule)) {
        throw new Error(`query ${identity.key} was registered with a different invalidation rule: ${describeRule(existing.rule)} then ${describeRule(identity.rule)}`)
      }
      return existing as QueryState<Result>
    }
    const state: QueryState<Result> = {
      key: identity.key,
      rule: identity.rule,
      counters: { issued: 0, shared: 0, superseded: 0, droppedStale: 0, droppedSuperseded: 0, failed: 0 },
      invalidated: {},
      applied: 0,
      stored: undefined,
    }
    this.states.set(identity.key, state as QueryState<unknown>)
    return state
  }

  private invalidate(scope: TeamChangeScope, update: TeamChangeUpdate & { readonly type: 'changed' }): void {
    if (this.folded.has(update)) return
    this.folded.add(update)
    const domain: VersionDomain = scope?.kind === 'presence' ? 'presence' : 'projection'
    for (const state of this.states.values()) {
      if (!coversRule(scope, state.rule)) continue
      if (update.baseline !== true && state.invalidated[domain] === update.version) continue
      state.invalidated[domain] = update.version
      const entry = this.inFlight.get(state.key)
      if (entry !== undefined) this.supersede(entry)
    }
  }

  private supersede(entry: InFlight<unknown>): void {
    if (entry.superseded) return
    entry.superseded = true
    entry.state.counters.superseded += 1
  }

  private settle<Result>(entry: InFlight<Result>, outcome: Outcome<Result>): void {
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
  private dropStale<Result>(entry: InFlight<Result>, current: boolean): void {
    entry.state.counters.droppedStale += 1
    this.logDrop(entry, 'stale')
    if (current) this.inFlight.delete(entry.key)
    this.deliver(entry, entry.state.stored)
  }

  /**
   * An invalidation superseded this read: its payload must never become the query's state. Waiters move to the
   * replacement read; when the wake left none, issue it here so the invalidation still ends in fresh data.
   */
  private deliverSuperseded<Result>(entry: InFlight<Result>, current: boolean): void {
    entry.state.counters.droppedSuperseded += 1
    this.logDrop(entry, 'superseded')
    if (current) this.inFlight.delete(entry.key)
    const target = this.inFlight.get(entry.key)
    if (target !== undefined && target !== entry) {
      if (target.outcome !== undefined) this.deliver(entry, target.outcome as Outcome<Result>)
      else target.waiters.push(...entry.waiters.splice(0, entry.waiters.length))
      return
    }
    if (!this.disposed) {
      const retry = this.issue({ key: entry.state.key, rule: entry.state.rule }, entry.state, entry.load)
      retry.waiters.push(...entry.waiters.splice(0, entry.waiters.length))
      return
    }
    this.deliver(entry, entry.state.stored)
  }

  private logDrop(entry: InFlight<unknown>, reason: 'stale' | 'superseded'): void {
    console.info('[agent-team] stale read response dropped', { query: entry.key, issuance: entry.issuance, landed: entry.state.applied, reason })
  }

  private deliver<Result>(entry: InFlight<Result>, outcome: Outcome<Result> | undefined): void {
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
