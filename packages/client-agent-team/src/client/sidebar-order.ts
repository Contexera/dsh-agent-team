/**
 * Human presentation preference for the Team sidebar row order of Projects and Agents: the Host row's `sidebarOrder`
 * setting, cached in this browser so the first paint never waits for a read. Reconcile drops removed refs, keeps the
 * user's relative order, and appends newcomers. The Host is the durable copy; `localStorage` is the cache and the
 * offline fallback, and an order this browser arranged before the setting existed is migrated up on the first read.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

export type TeamSidebarListKind = 'projects' | 'agents'

export type SidebarDropMarker = 'before' | 'after'

const STORAGE_KEY = 'dsh.agent-team.sidebar-order'

interface StoredOrders {
  readonly [workspaceListKey: string]: readonly string[]
}

/** The Host Remote pair this module persists through, injected once by the Client wiring. */
export interface SidebarOrderHost {
  readonly load: () => Promise<RemoteResult<{ readonly lists: Readonly<Record<string, readonly string[]>> }>>
  readonly save: (request: {
    readonly key: string
    readonly refs: readonly string[]
  }) => Promise<RemoteResult<{ readonly lists: Readonly<Record<string, readonly string[]>> }>>
}

function listKey(workspaceId: WorkspaceId | undefined, kind: TeamSidebarListKind): string | undefined {
  return workspaceId === undefined ? undefined : `${workspaceId}|${kind}`
}

/** Whether a stored key names one Workspace's one list; anything else is not this preference's. */
function isListKey(key: string): boolean {
  return key.endsWith('|projects') || key.endsWith('|agents')
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
      // Projects were called Channels; an order saved before the rename keeps applying.
      if (key.endsWith('|channels')) clean[key.replace(/\|channels$/, '|projects')] ??= value.map(ref => ref.replace(/^channel:/, 'project:'))
      else clean[key] = value
    }
    cachedRaw = raw
    cachedOrders = clean
    return cachedOrders
  } catch {
    return {}
  }
}

/** Write one list into the cache (and `localStorage` when it accepts the write). */
function writeOrder(key: string, refs: readonly string[]): void {
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

function fingerprintOf(refs: readonly string[]): string {
  return `f${refs.length}:${refs.join(',')}`
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

let host: SidebarOrderHost | undefined
let hydration: Promise<void> | undefined
/** Lists whose latest local order the Host has not confirmed yet; a failed write retries on the next read. */
const unconfirmed = new Set<string>()
/** Lists this page has written itself. Its own drag is never older than a Host answer that may have raced it. */
const writtenHere = new Set<string>()

/** Point this module at the Host Remote pair (once per Client wiring); passing `undefined` detaches it. */
export function attachSidebarOrderHost(next: SidebarOrderHost | undefined): void {
  host = next
  hydration = undefined
  unconfirmed.clear()
  writtenHere.clear()
}

async function flushOrder(current: SidebarOrderHost, key: string, refs: readonly string[]): Promise<void> {
  try {
    const result = await current.save({ key, refs })
    if (result.ok) unconfirmed.delete(key)
  } catch {
    // The local order keeps serving; the next gesture retries the write.
  }
}

async function hydrate(current: SidebarOrderHost): Promise<void> {
  const before = { ...structuredClone(storedOrders()) } as Readonly<Record<string, readonly string[]>>
  let remote: Readonly<Record<string, readonly string[]>>
  try {
    const result = await current.load()
    if (!result.ok) return
    remote = result.value.lists
  } catch {
    // An unreachable Host leaves the cache in charge; a later gesture still tries to write.
    return
  }
  let adopted = false
  for (const [key, refs] of Object.entries(remote)) {
    // A list this page already dragged outranks the answer, which may have been
    // read before that write landed.
    if (writtenHere.has(key) || !isListKey(key) || !Array.isArray(refs) || refs.length === 0) continue
    if (savedFingerprint(key) === fingerprintOf(refs)) continue
    writeOrder(key, refs)
    adopted = true
  }
  // An order this browser arranged before the Host carried one moves up once, so
  // the upgrade costs nobody their arrangement. A drag during the read flushed itself.
  for (const [key, refs] of Object.entries(before)) {
    if (refs.length === 0 || key in remote) continue
    await flushOrder(current, key, refs)
  }
  for (const key of [...unconfirmed]) {
    const refs = storedOrders()[key]
    if (refs !== undefined && refs.length > 0) await flushOrder(current, key, refs)
  }
  if (adopted) emitChange()
}

/** Read the Host's saved order once per attached Host; the first list to render starts it. */
export function ensureSidebarOrderHydrated(): Promise<void> {
  if (host === undefined) return Promise.resolve()
  hydration ??= hydrate(host)
  return hydration
}

function persistOrder(key: string, refs: readonly string[]): void {
  const current = host
  if (current === undefined) return
  writtenHere.add(key)
  unconfirmed.add(key)
  void flushOrder(current, key, refs)
}

/** Identity-stable across renders while neither the data nor this browser's preference changes. */
export function useSidebarOrder<R extends string>(workspaceId: WorkspaceId | undefined, kind: TeamSidebarListKind, refs: readonly R[]): readonly R[] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  useEffect(() => { void ensureSidebarOrderHydrated() }, [])
  return useSyncExternalStore(subscribe,
    () => orderedSnapshot(workspaceId, kind, refs),
    () => orderedSnapshot(workspaceId, kind, refs))
}

/**
 * The only mutation path. Returns the new order, or `undefined` when nothing would change (unknown refs, dropping a row
 * onto itself, or an adjacent marker). The cache, a Host write, and subscriber notification happen here.
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
  writeOrder(key, next)
  snapshots.delete(key)
  emitChange()
  persistOrder(key, next)
  return next
}
