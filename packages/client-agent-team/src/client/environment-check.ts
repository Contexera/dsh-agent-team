import { useSyncExternalStore } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamEnvironmentResult } from '@contexera/dsh-agent-team/types'

export interface TeamEnvironmentSnapshot {
  readonly status: 'loading' | 'ready'
  readonly report?: AgentTeamEnvironmentResult | undefined
}

export interface TeamEnvironmentSource {
  getSnapshot(): TeamEnvironmentSnapshot
  subscribe(listener: () => void): () => void
}

export interface TeamEnvironmentLoader {
  loadEnvironment: () => Promise<RemoteResult<AgentTeamEnvironmentResult>>
}

const INITIAL: TeamEnvironmentSnapshot = { status: 'loading' }

export class TeamEnvironmentCheck implements TeamEnvironmentSource {
  private snapshot: TeamEnvironmentSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private reading: Promise<void> | undefined
  private readonly loader: TeamEnvironmentLoader

  constructor(loader: TeamEnvironmentLoader) {
    this.loader = loader
  }

  readonly getSnapshot = (): TeamEnvironmentSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.snapshot.status === 'loading' && this.reading === undefined) void this.refresh()
    return () => { this.listeners.delete(listener) }
  }

  /** Concurrent callers share one round trip; a failed read keeps the last accepted report. */
  refresh(): Promise<void> {
    if (this.reading !== undefined) return this.reading
    const reading = this.read().finally(() => {
      if (this.reading === reading) this.reading = undefined
    })
    this.reading = reading
    return reading
  }

  dispose(): void {
    this.listeners.clear()
  }

  private async read(): Promise<void> {
    let report: AgentTeamEnvironmentResult
    try {
      const result = await this.loader.loadEnvironment()
      if (!result.ok) {
        this.fail()
        return
      }
      report = result.value
    } catch {
      // A dropped connection surfaces as a thrown carrier error, not a result:
      // both are read failures and both keep whatever report already stands.
      this.fail()
      return
    }
    this.commit({ status: 'ready', report })
  }

  /** Settle a read that produced no report so a reader stops waiting on a `loading` that never finishes; a standing report is untouched. */
  private fail(): void {
    if (this.snapshot.report === undefined) this.commit({ status: 'ready' })
  }

  private commit(snapshot: TeamEnvironmentSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

export function useEnvironmentCheck(environment: TeamEnvironmentSource): TeamEnvironmentSnapshot {
  return useSyncExternalStore(environment.subscribe, environment.getSnapshot, environment.getSnapshot)
}
