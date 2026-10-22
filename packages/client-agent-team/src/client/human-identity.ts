import { useSyncExternalStore } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamHumanProfileResult } from '@contexera/dsh-agent-team/types'

/**
 * The Client's one projection of the Human identity, so every seat that names or draws the Human shows one rename and one face.
 * Durable facts live in the Host (name and avatar reference in the Team Host row's Config, bytes in the avatar store);
 * writes go through the Host's `setHumanProfile` Remote.
 *
 * `name` stays undefined until the first read settles, and callers fall back to their own localized name. Reads are
 * demand-driven: the first subscriber starts the read.
 */

export interface TeamHumanIdentitySnapshot {
  /** `unavailable` only when no value was ever accepted; it is the one state that offers a retry. */
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly name?: string | undefined
  /** Configured avatar reference; undefined means the identity fallback is the avatar. */
  readonly avatarRef?: string | undefined
  readonly avatarUrl?: string | undefined
  readonly version?: string | undefined
  readonly repoUrl?: string | undefined
  /** A newer published release, when one is known; the footnote stays version + link until then. */
  readonly latestVersion?: string | undefined
  /** Last failure, kept beside the last accepted value so a page can report it. */
  readonly error?: string | undefined
}

export interface TeamHumanIdentitySource {
  getSnapshot(): TeamHumanIdentitySnapshot
  subscribe(listener: () => void): () => void
}

/** The settings page's extra face: re-read after a failed or superseded read. */
export interface TeamHumanIdentityFace extends TeamHumanIdentitySource {
  refresh(): Promise<void>
}

export interface TeamHumanIdentityLoader {
  loadProfile: () => Promise<RemoteResult<AgentTeamHumanProfileResult>>
  /** Resolve one avatar reference to a displayable URL; null falls back to the initial. */
  loadAvatarUrl: (avatarRef: string) => Promise<string | null>
}

const INITIAL: TeamHumanIdentitySnapshot = { status: 'loading' }

export class TeamHumanIdentity implements TeamHumanIdentityFace {
  private snapshot: TeamHumanIdentitySnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private reading: Promise<void> | undefined
  private readonly loader: TeamHumanIdentityLoader

  constructor(loader: TeamHumanIdentityLoader) {
    this.loader = loader
  }

  readonly getSnapshot = (): TeamHumanIdentitySnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.snapshot.status === 'loading' && this.reading === undefined) void this.refresh()
    return () => { this.listeners.delete(listener) }
  }

  /** Concurrent callers share one round trip; a failed refresh keeps the last accepted value beside the error. */
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
    let profile: AgentTeamHumanProfileResult
    try {
      const result = await this.loader.loadProfile()
      if (!result.ok) {
        this.recordReadFailure(result.error.message)
        return
      }
      profile = result.value
    } catch (error) {
      // A dropped connection surfaces as a thrown carrier error, not a result:
      // both are read failures and both keep whatever value already stands.
      this.recordReadFailure(error instanceof Error ? error.message : String(error))
      return
    }
    const avatarUrl = await this.avatarUrlFor(profile.avatarRef)
    this.commit({
      status: 'ready',
      name: profile.name,
      ...(profile.avatarRef === undefined ? {} : { avatarRef: profile.avatarRef }),
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      version: profile.version,
      repoUrl: profile.repoUrl,
      ...(profile.latestVersion === undefined ? {} : { latestVersion: profile.latestVersion }),
    })
  }

  /** Bytes are immutable per reference, so one fetch serves every later refresh with the same avatar. */
  private async avatarUrlFor(avatarRef: string | undefined): Promise<string | undefined> {
    if (avatarRef === undefined) return undefined
    if (avatarRef === this.snapshot.avatarRef && this.snapshot.avatarUrl !== undefined) return this.snapshot.avatarUrl
    return (await this.loader.loadAvatarUrl(avatarRef)) ?? undefined
  }

  /** A previously accepted value stays on screen; only an identity that never loaded becomes `unavailable`. */
  private recordReadFailure(message: string): void {
    const held = this.snapshot
    this.commit(held.name === undefined
      ? { ...held, status: 'unavailable', error: message }
      : { ...held, status: 'ready', error: message })
  }

  private commit(snapshot: TeamHumanIdentitySnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

export function useHumanIdentity(identity: TeamHumanIdentitySource): TeamHumanIdentitySnapshot {
  return useSyncExternalStore(identity.subscribe, identity.getSnapshot, identity.getSnapshot)
}
