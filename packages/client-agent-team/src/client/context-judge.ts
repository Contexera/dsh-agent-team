import { useSyncExternalStore } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamContextJudgeResult } from '@contexera/dsh-agent-team/types'

/**
 * The Client's one projection of the long-gap gate's judge.
 *
 * The settings page stages the row configuration that mounts the judge, but it
 * cannot state whether a judge is actually reachable: `enabled` is a fact about
 * the running Host, and a deployment may mount one from configuration the page
 * never sees. So this projection is read rather than derived, and every write
 * that can mount or unmount the judge re-reads it instead of predicting the
 * outcome.
 *
 * Reads are demand-driven off the first subscriber, so an ordinary conversation
 * never calls the Remote.
 */

/** One read of the judge status, replaced wholesale on every change. */
export interface TeamContextJudgeSnapshot {
  /** `loading` until the first read settles, `ready` once it has. */
  readonly status: 'loading' | 'ready'
  /** The status to render; undefined until the first read settles. */
  readonly report?: AgentTeamContextJudgeResult | undefined
}

/** Read-side face the settings page binds. */
export interface TeamContextJudgeSource {
  getSnapshot(): TeamContextJudgeSnapshot
  subscribe(listener: () => void): () => void
}

/** Host call the projection reads through; one loader per Client context. */
export interface TeamContextJudgeLoader {
  loadContextJudge: () => Promise<RemoteResult<AgentTeamContextJudgeResult>>
}

const INITIAL: TeamContextJudgeSnapshot = { status: 'loading' }

export class TeamContextJudgeCheck implements TeamContextJudgeSource {
  private snapshot: TeamContextJudgeSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private reading: Promise<void> | undefined
  private readonly loader: TeamContextJudgeLoader

  constructor(loader: TeamContextJudgeLoader) {
    this.loader = loader
  }

  readonly getSnapshot = (): TeamContextJudgeSnapshot => this.snapshot

  /**
   * Observe the status, starting the first read when nobody has read yet.
   * @param listener - invoked after every snapshot replacement.
   * @returns the disposer removing this listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.snapshot.status === 'loading' && this.reading === undefined) void this.refresh()
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read the Host status. Concurrent callers share one round trip, and a failed
   * read keeps the last accepted report — the block never blanks out over a
   * background read.
   * @returns settlement of this read (or of the read already in flight).
   */
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
    let report: AgentTeamContextJudgeResult
    try {
      const result = await this.loader.loadContextJudge()
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

  /**
   * Settle a read that produced no report, so a reader stops waiting on a
   * `loading` that will never finish. A report that already stands is left
   * untouched: a failed background read never blanks the block.
   */
  private fail(): void {
    if (this.snapshot.report === undefined) this.commit({ status: 'ready' })
  }

  private commit(snapshot: TeamContextJudgeSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

/** Subscribe one rendered block to the judge status. */
export function useContextJudge(judge: TeamContextJudgeSource): TeamContextJudgeSnapshot {
  return useSyncExternalStore(judge.subscribe, judge.getSnapshot, judge.getSnapshot)
}
