import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { ClientRemote, RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@contexera/dsh-agent-team/remote'
import type { AgentTeamChangeScope, AgentTeamChangesResult } from '@contexera/dsh-agent-team/types'

export type TeamChangeScope = AgentTeamChangeScope | undefined

export type TeamChangeUpdate =
  /** `baseline` marks the first item of a stream (re)open: it invalidates no matter its version. */
  | { readonly type: 'changed'; readonly version: number; readonly baseline?: true }
  | { readonly type: 'failed'; readonly message: string }

export type TeamChangeListener = (update: TeamChangeUpdate) => void

function scopeKey(scope: TeamChangeScope): string {
  return scope === undefined ? 'all'
    : scope.kind === 'workspace' ? `workspace:${scope.workspaceId}`
    : scope.kind === 'channel' ? `channel:${scope.channelRef}`
    : scope.kind === 'presence' ? `presence:${scope.workspaceId}`
    : `thread:${scope.threadRef}`
}

interface ScopeSubscription {
  readonly scope: TeamChangeScope
  readonly stream: RemoteStream<AgentTeamChangesResult>
  readonly listeners: Set<TeamChangeListener>
  failure: string | undefined
  /** Set on failure: the retried stream's first item is a reopening baseline even though the run loop never restarted. */
  pendingBaseline: boolean
}

/** One logical stream per scope per page; Harness owns the shared transport and recovery. */
export class TeamChangeStream {
  private readonly subscriptions = new Map<string, ScopeSubscription>()

  constructor(private readonly remote: Pick<ClientRemote, '$stream' | 'agentTeam'>) {}

  subscribe(scope: TeamChangeScope, listener: TeamChangeListener): () => void {
    const key = scopeKey(scope)
    let subscription = this.subscriptions.get(key)
    if (subscription === undefined) {
      subscription = this.open(scope, new Set([listener]))
      this.subscriptions.set(key, subscription)
      void this.run(key, subscription)
    } else {
      subscription.listeners.add(listener)
      if (subscription.failure !== undefined) listener({ type: 'failed', message: subscription.failure })
    }
    const owned = subscription
    return () => {
      if (!owned.listeners.delete(listener) || owned.listeners.size !== 0) return
      if (this.subscriptions.get(key) === owned) this.subscriptions.delete(key)
      void owned.stream.dispose()
    }
  }

  /**
   * Reopen every scope whose stream already ended for good. The Harness resumes a
   * live generation across reconnects, but a terminated one is gone for good: a new
   * Host generation is the moment the scope was waiting for can come back, and the
   * listeners keep their seats, so only the stream is replaced.
   */
  recover(): void {
    // Replacing an existing key's value is safe during Map iteration: the entry keeps
    // its place, and a scope that never failed is left untouched.
    for (const [key, subscription] of this.subscriptions) {
      if (subscription.failure === undefined) continue
      const replacement = this.open(subscription.scope, subscription.listeners)
      this.subscriptions.set(key, replacement)
      void subscription.stream.dispose()
      void this.run(key, replacement)
    }
  }

  private open(scope: TeamChangeScope, listeners: Set<TeamChangeListener>): ScopeSubscription {
    const key = scopeKey(scope)
    const stream = this.remote.$stream({
      name: `Team changes ${key}`,
      open: signal => this.remote.agentTeam.changes(scope === undefined ? {} : { scope }, signal),
      // A normal end after the baseline is an outage, not a verdict: the Harness
      // retries a carrier loss and reports it through `carrierFailed`, while every
      // other error stays terminal. Only an end before the opening baseline is a
      // protocol violation — this stream never yields nothing before it ends.
      ended: accepted => accepted
        ? new RemoteStreamCarrierError('Team change subscription ended without a terminal result')
        : new Error('Team change subscription ended before its opening baseline'),
      carrierFailed: error => this.fail(key, error.message),
    })
    return { scope, stream, listeners, failure: undefined, pendingBaseline: false }
  }

  async dispose(): Promise<void> {
    const subscriptions = [...this.subscriptions.values()]
    this.subscriptions.clear()
    await Promise.all(subscriptions.map(subscription => subscription.stream.dispose()))
  }

  private fail(key: string, message: string): void {
    const subscription = this.subscriptions.get(key)
    if (subscription === undefined || subscription.failure !== undefined) return
    subscription.failure = message
    subscription.pendingBaseline = true
    for (const listener of subscription.listeners) listener({ type: 'failed', message })
  }

  private async run(key: string, subscription: ScopeSubscription): Promise<void> {
    try {
      // One update object per dispatch: every co-subscriber of this scope
      // receives the identical value, which is what lets the read layer fold
      // one dispatch into one invalidation. A baseline marks the stream's
      // opening — its start, or its first item after a carrier outage the
      // Harness retried inside this same loop — so readers can tell a fresh
      // stream position from a version that merely repeats.
      let opening = true
      for await (const item of subscription.stream) {
        if (this.subscriptions.get(key) !== subscription) return
        item.accept()
        subscription.failure = undefined
        const baseline = opening || subscription.pendingBaseline
        subscription.pendingBaseline = false
        opening = false
        const update: TeamChangeUpdate = { type: 'changed', version: item.value.version, ...(baseline ? { baseline: true as const } : {}) }
        for (const listener of subscription.listeners) listener(update)
      }
    } catch (error) {
      if (this.subscriptions.get(key) === subscription) this.fail(key, error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * The Host's `changes` stream never wakes on a Thread read — a read advances
 * only the reader's private watermark, so no shared projection changes. A
 * durable read does consume the reader's own mention markers, so the Human's
 * badge and Inbox page refresh from the completed read itself instead of
 * waiting for the next unrelated commit.
 */
export class TeamReadStream {
  private version = 0
  private readonly listeners = new Set<() => void>()

  bump(): void {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
