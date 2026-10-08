import { useSyncExternalStore } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamHumanProfileResult } from '@contexera/dsh-agent-team/types'

/**
 * The Client's one projection of the Human identity.
 *
 * The durable facts live in the Host: the display name and the avatar
 * reference in the Team Host row's own Config, the avatar bytes in the
 * persistent avatar store. This store is the only place the Team Client reads
 * them, so every seat that names or draws the Human — message rows, member
 * refs, mention chips, the settings page — shows one rename and one face, and a
 * single refresh after a write moves all of them together. Writes go back
 * through the Host's `setHumanProfile` Remote, which owns the profile entry the
 * Client would otherwise have to name.
 *
 * Seats render before the first read settles; `name` stays undefined until then
 * and every caller falls back to its own localized name for the Human. Reads
 * are demand-driven: the first subscriber starts the read, so a Client that
 * never opens Team mode or the profile page never calls the Remote.
 */

/** One read of the Human identity, replaced wholesale on every change. */
export interface TeamHumanIdentitySnapshot {
  /**
   * `loading` until the first read settles, `ready` while an accepted value
   * stands (also when a later refresh failed), `unavailable` when no value was
   * ever accepted — the one state that hands the page a retry.
   */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** Host-resolved display name; undefined before the first accepted read. */
  readonly name?: string | undefined
  /** Configured avatar reference; undefined means the identity fallback is the avatar. */
  readonly avatarRef?: string | undefined
  /** Avatar bytes as a data URL for `<img>`; undefined renders the fallback. */
  readonly avatarUrl?: string | undefined
  /** Bundle version for the settings footnote. */
  readonly version?: string | undefined
  /** Repository home the footnote links to. */
  readonly repoUrl?: string | undefined
  readonly updateAvailable: boolean
  readonly latestVersion?: string | undefined
  /** Last failure, kept beside the last accepted value so a page can report it. */
  readonly error?: string | undefined
}

/** Read-side face every consumer binds: the seats' hook and the settings page alike. */
export interface TeamHumanIdentitySource {
  getSnapshot(): TeamHumanIdentitySnapshot
  subscribe(listener: () => void): () => void
}

/** The settings page's extra face: re-read after a failed or superseded read. */
export interface TeamHumanIdentityFace extends TeamHumanIdentitySource {
  refresh(): Promise<void>
}

/** Host calls the store reads through; one loader per Client context. */
export interface TeamHumanIdentityLoader {
  loadProfile: () => Promise<RemoteResult<AgentTeamHumanProfileResult>>
  /** Resolve one avatar reference to a displayable URL; null falls back to the initial. */
  loadAvatarUrl: (avatarRef: string) => Promise<string | null>
}

const INITIAL: TeamHumanIdentitySnapshot = { status: 'loading', updateAvailable: false }

export class TeamHumanIdentity implements TeamHumanIdentityFace {
  private snapshot: TeamHumanIdentitySnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private reading: Promise<void> | undefined
  private readonly loader: TeamHumanIdentityLoader

  constructor(loader: TeamHumanIdentityLoader) {
    this.loader = loader
  }

  readonly getSnapshot = (): TeamHumanIdentitySnapshot => this.snapshot

  /**
   * Observe the identity, starting the first read when nobody has read yet.
   * @param listener - invoked after every snapshot replacement.
   * @returns the disposer removing this listener.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.snapshot.status === 'loading' && this.reading === undefined) void this.refresh()
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Re-read the Host projection. Concurrent callers share one round trip, and a
   * failed refresh keeps the last accepted value beside the reported error —
   * the seats never blank out because a background read failed.
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
    let profile: AgentTeamHumanProfileResult
    try {
      const result = await this.loader.loadProfile()
      if (!result.ok) {
        this.fail(result.error.message)
        return
      }
      profile = result.value
    } catch (error) {
      // A dropped connection surfaces as a thrown carrier error, not a result:
      // both are read failures and both keep whatever value already stands.
      this.fail(error instanceof Error ? error.message : String(error))
      return
    }
    // Bytes are immutable per reference, so one fetch serves every later
    // refresh that still carries the same avatar.
    const avatarUrl = profile.avatarRef === undefined
      ? undefined
      : profile.avatarRef === this.snapshot.avatarRef && this.snapshot.avatarUrl !== undefined
        ? this.snapshot.avatarUrl
        : (await this.loader.loadAvatarUrl(profile.avatarRef)) ?? undefined
    this.commit({
      status: 'ready',
      name: profile.name,
      ...(profile.avatarRef === undefined ? {} : { avatarRef: profile.avatarRef }),
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      version: profile.version,
      repoUrl: profile.repoUrl,
      updateAvailable: profile.updateAvailable,
      ...(profile.latestVersion === undefined ? {} : { latestVersion: profile.latestVersion }),
    })
  }

  /**
   * Record one read failure. A value that was already accepted stays on screen
   * (the seats never blank out over a background read), and only an identity
   * that never loaded becomes `unavailable` — the state that offers a retry.
   */
  private fail(message: string): void {
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

/** Subscribe one rendered seat to the identity. */
export function useHumanIdentity(identity: TeamHumanIdentitySource): TeamHumanIdentitySnapshot {
  return useSyncExternalStore(identity.subscribe, identity.getSnapshot, identity.getSnapshot)
}
