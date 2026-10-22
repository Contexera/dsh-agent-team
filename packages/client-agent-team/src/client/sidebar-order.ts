/**
 * Human presentation preference for the Team sidebar row order of Channels and Agents. The order lives in this browser
 * only; it is never a shared Team fact. Reconcile drops removed refs, keeps the user's relative order, and appends newcomers.
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

export type TeamSidebarListKind = 'channels' | 'agents'

export type SidebarDropMarker = 'before' | 'after'

const STORAGE_KEY = 'dsh.agent-team.sidebar-order'

interface StoredOrders {
  readonly [workspaceListKey: string]: readonly string[]
}

function listKey(workspaceId: WorkspaceId | undefined, kind: TeamSidebarListKind): string | undefined {
  return workspaceId === undefined ? undefined : `${workspaceId}|${kind}`
}

const MEMORY_ONLY = Symbol('sidebar-order.memory')

let cachedRaw: string | null | typeof MEMORY_ONLY | undefined
let cachedOrders: StoredOrders = {}

/** Private mode, quota errors, and stale or corrupted payloads degrade to "no preference". */
function storedOrders(): StoredOrders {
  let raw: string | null = null
  try {
    raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
  } catch {
    raw = null
  }
  if (cachedRaw !== undefined && raw !== null && raw === (cachedRaw as string)) return cachedOrders
  if (raw === null) {
    if (cachedRaw === MEMORY_ONLY) return cachedOrders
    cachedRaw = raw
    cachedOrders = {}
    return cachedOrders
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    const clean: Record<string, readonly string[]> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) continue
      clean[key] = value
    }
    cachedRaw = raw
    cachedOrders = clean
    return cachedOrders
  } catch {
    return {}
  }
}

function saveOrder(key: string, refs: readonly string[]): void {
  const next: Record<string, readonly string[]> = { ...structuredClone(storedOrders()), [key]: refs }
  cachedOrders = next
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = JSON.stringify(next)
      localStorage.setItem(STORAGE_KEY, raw)
      cachedRaw = raw
      return
    }
  } catch {
    // Private mode and quota failures do not block reordering; the in-memory order keeps serving.
  }
  cachedRaw = MEMORY_ONLY
}

/** Removed refs disappear; new refs join in their Remote default positions after the known ones. */
export function reconcileSidebarOrder<R extends string>(saved: readonly string[], current: readonly R[]): readonly R[] {
  const present = new Set(current)
  const seen = new Set<string>()
  const merged: R[] = []
  for (const ref of saved) {
    if (seen.has(ref) || !present.has(ref as R)) continue
    seen.add(ref)
    merged.push(ref as R)
  }
  for (const ref of current) {
    if (seen.has(ref)) continue
    seen.add(ref)
    merged.push(ref)
  }
  return merged
}

let revision = 0
const listeners = new Set<() => void>()
interface SnapshotEntry {
  atRevision: number
  signature: string
  savedFingerprint: string
  result: readonly string[]
}
const snapshots = new Map<string, SnapshotEntry>()

function savedFingerprint(key: string): string {
  const saved = storedOrders()[key]
  return saved === undefined ? '' : `f${saved.length}:${saved.join(',')}`
}

function emitChange(): void {
  revision += 1
  for (const listener of listeners) listener()
}

function orderedSnapshot<R extends string>(workspaceId: WorkspaceId | undefined, kind: TeamSidebarListKind, refs: readonly R[]): readonly R[] {
  const key = listKey(workspaceId, kind)
  if (key === undefined) return refs
  const signature = refs.join('\u0000')
  const fingerprint = savedFingerprint(key)
  const hit = snapshots.get(key)
  if (hit !== undefined && hit.atRevision === revision && hit.signature === signature && hit.savedFingerprint === fingerprint) {
    return hit.result as readonly R[]
  }
  const result = reconcileSidebarOrder(storedOrders()[key] ?? [], refs)
  snapshots.set(key, { atRevision: revision, signature, savedFingerprint: fingerprint, result })
  return result as readonly R[]
}

/** Identity-stable across renders while neither the data nor this browser's preference changes. */
export function useSidebarOrder<R extends string>(workspaceId: WorkspaceId | undefined, kind: TeamSidebarListKind, refs: readonly R[]): readonly R[] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  return useSyncExternalStore(subscribe,
    () => orderedSnapshot(workspaceId, kind, refs),
    () => orderedSnapshot(workspaceId, kind, refs))
}

/**
 * The only mutation path. Returns the new order, or `undefined` when nothing would change (unknown refs, dropping a row
 * onto itself, or an adjacent marker). Persistence and subscriber notification happen here.
 */
export function moveSidebarItem<R extends string>(
  workspaceId: WorkspaceId | undefined,
  kind: TeamSidebarListKind,
  refs: readonly R[],
  movedRef: R,
  targetRef: R,
  marker: SidebarDropMarker,
): readonly R[] | undefined {
  const key = listKey(workspaceId, kind)
  const from = refs.indexOf(movedRef)
  const nextFromTarget = refs.indexOf(targetRef)
  if (key === undefined || from < 0 || nextFromTarget < 0 || movedRef === targetRef) return undefined
  const next = [...refs]
  const [item] = next.splice(from, 1)
  if (item === undefined) return undefined
  const insertAt = next.indexOf(targetRef) + (marker === 'after' ? 1 : 0)
  if (insertAt === from) return undefined
  next.splice(insertAt, 0, item)
  saveOrder(key as string, next)
  snapshots.delete(key)
  emitChange()
  return next
}
