import type { AgentTeamChannelRef, AgentTeamMemberId, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'

/**
 * Keyed draft cache for the Channel/Thread composers. Drafts are local UI
 * convenience state — never Host-authoritative facts — so localStorage is the
 * right home: switching views unmounts the pages, and a refresh should not
 * cost the Human their half-written message.
 */
export type TeamDraftKey = `channel:${AgentTeamChannelRef}` | `thread:${AgentTeamThreadRef}`

/** One cached composer state; `recipients` mirrors the structured mention set. */
export interface TeamDraftState {
  readonly draft: string
  readonly recipients: ReadonlySet<AgentTeamMemberId>
}

interface StoredDraft {
  draft: string
  recipientIds: AgentTeamMemberId[]
  savedAt: number
}

const STORAGE_KEY = 'dsh.agent-team.drafts.v1'
/** Retention ceiling; the oldest savedAt entries fall out first. */
const LIMIT = 50

const EMPTY: TeamDraftState = Object.freeze({ draft: '', recipients: new Set<AgentTeamMemberId>() })

function isTeamDraftKey(value: string): value is TeamDraftKey {
  return value.startsWith('channel:') || value.startsWith('thread:')
}

function readStored(): Map<TeamDraftKey, StoredDraft> {
  if (typeof localStorage === 'undefined') return new Map()
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Record<string, unknown>
    const restored = new Map<TeamDraftKey, StoredDraft>()
    for (const [key, value] of Object.entries(parsed)) {
      if (!isTeamDraftKey(key) || typeof value !== 'object' || value === null) continue
      const candidate = value as Partial<StoredDraft>
      if (typeof candidate.draft !== 'string' || !Array.isArray(candidate.recipientIds) || typeof candidate.savedAt !== 'number') continue
      if (!candidate.recipientIds.every(id => typeof id === 'string')) continue
      restored.set(key, { draft: candidate.draft, recipientIds: candidate.recipientIds as AgentTeamMemberId[], savedAt: candidate.savedAt })
    }
    return restored
  } catch {
    // Local persistence is a convenience; malformed content just starts empty.
    return new Map()
  }
}

function persistStored(entries: ReadonlyMap<TeamDraftKey, StoredDraft>): void {
  if (typeof localStorage === 'undefined') return
  try {
    const payload = Object.fromEntries([...entries].map(([key, entry]) => [key, entry]))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Private mode and quota failures do not block composing.
  }
}

/**
 * Root-scoped draft cache, one instance per Client context (created in
 * `applyUi` and injected like the navigation service — never a module
 * singleton). Slot lifetimes subscribe per key.
 */
export class TeamDraftStore {
  private entries = readStored()
  private readonly snapshots = new Map<TeamDraftKey, TeamDraftState>()
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release listeners when the owning Client context disposes. */
  dispose(): void {
    this.listeners.clear()
  }

  /** Stable per-key snapshot identity for useSyncExternalStore. */
  readonly getSnapshot = (key: TeamDraftKey): TeamDraftState => {
    const cached = this.snapshots.get(key)
    if (cached !== undefined) return cached
    const entry = this.entries.get(key)
    if (entry === undefined) return EMPTY
    const snapshot: TeamDraftState = Object.freeze({ draft: entry.draft, recipients: new Set(entry.recipientIds) })
    this.snapshots.set(key, snapshot)
    return snapshot
  }

  writeDraft(key: TeamDraftKey, draft: string): void {
    this.write(key, { draft })
  }

  writeRecipients(key: TeamDraftKey, recipients: Iterable<AgentTeamMemberId>): void {
    this.write(key, { recipientIds: [...recipients] })
  }

  /** Drop one key entirely — the success path after a committed send. */
  clear(key: TeamDraftKey): void {
    if (!this.entries.delete(key)) return
    this.snapshots.delete(key)
    persistStored(this.entries)
    for (const listener of this.listeners) listener()
  }

  /** Test seam: forget everything, including what localStorage still holds. */
  reset(): void {
    this.entries = new Map()
    this.snapshots.clear()
    if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY)
    for (const listener of this.listeners) listener()
  }

  /** Re-read persisted content — what a fresh page load starts from. */
  reload(): void {
    this.entries = readStored()
    this.snapshots.clear()
    for (const listener of this.listeners) listener()
  }

  private write(key: TeamDraftKey, patch: Partial<Pick<StoredDraft, 'draft' | 'recipientIds'>>): void {
    const previous = this.entries.get(key)
    const next: StoredDraft = {
      draft: patch.draft ?? previous?.draft ?? '',
      recipientIds: patch.recipientIds ?? previous?.recipientIds ?? [],
      savedAt: Date.now(),
    }
    // Identical content must not bump savedAt or notify — convergence effects
    // re-run freely and would otherwise loop through persistence.
    if (previous !== undefined && previous.draft === next.draft
      && previous.recipientIds.length === next.recipientIds.length
      && previous.recipientIds.every((id, index) => id === next.recipientIds[index])) return
    // An emptied composer leaves nothing worth restoring behind.
    if (next.draft === '' && next.recipientIds.length === 0) {
      this.clear(key)
      return
    }
    this.entries.set(key, next)
    this.evict()
    this.snapshots.delete(key)
    persistStored(this.entries)
    for (const listener of this.listeners) listener()
  }

  private evict(): void {
    while (this.entries.size > LIMIT) {
      let oldestKey: TeamDraftKey | undefined
      let oldestSavedAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of this.entries) {
        if (entry.savedAt < oldestSavedAt) {
          oldestSavedAt = entry.savedAt
          oldestKey = key
        }
      }
      if (oldestKey === undefined) return
      this.entries.delete(oldestKey)
      this.snapshots.delete(oldestKey)
    }
  }
}

export { STORAGE_KEY as TEAM_DRAFTS_STORAGE_KEY }
