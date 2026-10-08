import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamReplySettings } from '@contexera/dsh-agent-team/types'

/**
 * Whether this deployment offers quote-replies, as one Client-side projection.
 *
 * The switch itself lives in the Team Host row's settings, which the settings
 * page writes. Every surface that offers or renders a reply needs the same
 * answer, and needs it the moment the switch moves — so the store is created
 * once per Client and shared, and the settings page refreshes it after a landed
 * write. Without that, turning the switch off would leave a reply button on
 * screen that the Host refuses.
 *
 * Reads are demand-driven: the first subscriber starts the one read, and the
 * snapshot starts at the Host's own default so a surface never flashes the
 * wrong state before the answer lands.
 */

/** What the Team surfaces know about quote-replies. */
export interface TeamReplyCapabilitiesSnapshot {
  /**
   * `loading` until the first read settles, `ready` once the Host has answered,
   * `unavailable` when no answer was ever accepted — the state that leaves the
   * default standing rather than hiding a working feature.
   */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** The Host's answer; the Host default (on) until one arrives. */
  readonly enabled: boolean
}

/** Read-side face every reply surface binds. */
export interface TeamReplyCapabilitiesSource {
  getSnapshot(): TeamReplyCapabilitiesSnapshot
  subscribe(listener: () => void): () => void
}

/** The settings page's extra face: publish the switch it just moved. */
export interface TeamReplyCapabilitiesFace extends TeamReplyCapabilitiesSource {
  refresh(): Promise<void>
}

export class TeamReplyCapabilities implements TeamReplyCapabilitiesFace {
  private snapshot: TeamReplyCapabilitiesSnapshot = { status: 'loading', enabled: true }
  private readonly listeners = new Set<() => void>()
  private pending: Promise<void> | undefined

  /** @param load - the Host read that answers whether replies are offered. */
  constructor(private readonly load: () => Promise<RemoteResult<AgentTeamReplySettings>>) {}

  readonly getSnapshot = (): TeamReplyCapabilitiesSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.pending === undefined) void this.refresh()
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Ask the Host again and publish the answer.
   *
   * A failed read keeps the last accepted value and only marks the store
   * unavailable when nothing was ever accepted: a dropped carrier must not
   * silently remove an affordance the Team still offers.
   */
  async refresh(): Promise<void> {
    if (this.pending !== undefined) return this.pending
    this.pending = (async () => {
      try {
        const result = await this.load()
        this.publish(result.ok
          ? { status: 'ready', enabled: result.value.enabled }
          : { status: this.snapshot.status === 'ready' ? 'ready' : 'unavailable', enabled: this.snapshot.enabled })
      } catch {
        this.publish({ status: this.snapshot.status === 'ready' ? 'ready' : 'unavailable', enabled: this.snapshot.enabled })
      } finally {
        this.pending = undefined
      }
    })()
    return this.pending
  }

  private publish(next: TeamReplyCapabilitiesSnapshot): void {
    if (next.status === this.snapshot.status && next.enabled === this.snapshot.enabled) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
