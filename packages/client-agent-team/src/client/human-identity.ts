import { useSyncExternalStore } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamHumanProfileResult,
  AgentTeamPutHumanAvatarResult,
  AgentTeamRemoveHumanAvatarResult,
  AgentTeamSetHumanProfileResult,
} from '@contexera/dsh-agent-team/types'

/**
 * The Client's one projection of the Human identity, so every seat that names or draws the Human shows one rename and one face.
 * Durable facts live in the Host (name and avatar reference in the Team Host row's Config, bytes in the avatar store);
 * writes go through the Host's profile and avatar Remotes.
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
  /** Opaque Host-instance plus settings-revision fence; returned verbatim on the next write. */
  readonly settingsFence?: string | undefined
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
  /** Invalidate any in-flight read and start a fresh one after a durable profile write. */
  refreshAfterWrite(): Promise<void>
}

export interface TeamHumanIdentityLoader {
  loadProfile: () => Promise<RemoteResult<AgentTeamHumanProfileResult>>
  /** Resolve one avatar reference to a displayable URL; null falls back to the initial. */
  loadAvatarUrl: (avatarRef: string) => Promise<string | null>
}

export interface TeamHumanProfileWriterLoader {
  readonly setHumanName: (name: string, expectedFence: string) => Promise<RemoteResult<AgentTeamSetHumanProfileResult>>
  readonly replaceAvatar: (request: {
    readonly name: string
    readonly mediaType?: string | undefined
    readonly bytesBase64: string
  }, expectedFence: string) => Promise<RemoteResult<AgentTeamPutHumanAvatarResult>>
  readonly removeAvatar: (expectedFence: string) => Promise<RemoteResult<AgentTeamRemoveHumanAvatarResult>>
}

/** One settings-page write result. A saved write may still need a profile re-read before its new value is visible. */
export type TeamHumanProfileActionOutcome =
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'uncertain'; readonly message: string }
  | { readonly kind: 'saved'; readonly warning: string }
  | undefined

const INITIAL: TeamHumanIdentitySnapshot = { status: 'loading' }

export class TeamHumanIdentity implements TeamHumanIdentityFace {
  private snapshot: TeamHumanIdentitySnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private reading: Promise<void> | undefined
  private generation = 0
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
    return this.startRead(false)
  }

  async refreshAfterWrite(): Promise<void> {
    this.generation += 1
    await this.startRead(true)
  }

  private startRead(force: boolean): Promise<void> {
    if (!force && this.reading !== undefined) return this.reading
    const generation = this.generation
    const reading = this.read(generation).finally(() => {
      if (this.reading === reading) this.reading = undefined
    })
    this.reading = reading
    return reading
  }

  dispose(): void {
    this.listeners.clear()
  }

  private async read(generation: number): Promise<void> {
    let profile: AgentTeamHumanProfileResult
    try {
      const result = await this.loader.loadProfile()
      if (!result.ok) {
        this.recordReadFailure(generation, result.error.message)
        return
      }
      profile = result.value
    } catch (error) {
      // A dropped connection surfaces as a thrown carrier error, not a result:
      // both are read failures and both keep whatever value already stands.
      this.recordReadFailure(generation, error instanceof Error ? error.message : String(error))
      return
    }
    let avatarUrl: string | undefined
    try {
      avatarUrl = await this.avatarUrlFor(profile.avatarRef)
    } catch {
      // The name and version facts already succeeded. A broken avatar transport
      // must not hold the whole identity at loading or prevent a later retry.
      avatarUrl = undefined
    }
    if (generation !== this.generation) return
    this.commit({
      status: 'ready',
      name: profile.name,
      ...(profile.avatarRef === undefined ? {} : { avatarRef: profile.avatarRef }),
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      ...(profile.settingsFence === undefined ? {} : { settingsFence: profile.settingsFence }),
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
  private recordReadFailure(generation: number, message: string): void {
    if (generation !== this.generation) return
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

/** Settings-page writes share one rule: a successful durable write is never reported as a save failure. */
export class TeamHumanProfileWriter {
  constructor(
    private readonly identity: TeamHumanIdentityFace,
    private readonly loader: TeamHumanProfileWriterLoader,
  ) {}

  async setName(name: string, expectedFence: string): Promise<TeamHumanProfileActionOutcome> {
    return this.finish(() => this.loader.setHumanName(name, expectedFence))
  }

  async replaceAvatar(
    request: { readonly name: string; readonly mediaType?: string | undefined; readonly bytesBase64: string },
    expectedFence: string,
  ): Promise<TeamHumanProfileActionOutcome> {
    return this.finish(() => this.loader.replaceAvatar(request, expectedFence))
  }

  async removeAvatar(expectedFence: string): Promise<TeamHumanProfileActionOutcome> {
    return this.finish(() => this.loader.removeAvatar(expectedFence))
  }

  private async finish(write: () => Promise<RemoteResult<unknown>>): Promise<TeamHumanProfileActionOutcome> {
    let result: RemoteResult<unknown>
    try {
      result = await write()
    } catch (error) {
      await this.identity.refreshAfterWrite()
      return { kind: 'uncertain', message: errorMessage(error) }
    }
    if (!result.ok) {
      const code = result.error.code
      if (code === 'settings/conflict') {
        await this.identity.refreshAfterWrite()
        return { kind: 'conflict', message: result.error.message }
      }
      if (code === 'team/human-profile-write-uncertain' || code === 'gateway/internal' || code === 'gateway/cancelled') {
        await this.identity.refreshAfterWrite()
        return { kind: 'uncertain', message: result.error.message }
      }
      return { kind: 'rejected', message: result.error.message }
    }
    await this.identity.refreshAfterWrite()
    const warning = this.identity.getSnapshot().error
    return warning === undefined ? undefined : { kind: 'saved', warning }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useHumanIdentity(identity: TeamHumanIdentitySource): TeamHumanIdentitySnapshot {
  return useSyncExternalStore(identity.subscribe, identity.getSnapshot, identity.getSnapshot)
}
