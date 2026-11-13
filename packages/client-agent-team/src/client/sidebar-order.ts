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

interface OrderWrite {
  refs: readonly string[]
  confirmed?: readonly string[]
  pending?: Promise<void> | undefined
}

interface SidebarOrderBinding {
  readonly host: SidebarOrderHost
  readonly writes: Map<string, OrderWrite>
  hydration?: Promise<void>
}

let binding: SidebarOrderBinding | undefined

/** Point this module at the Host Remote pair (once per Client wiring); passing `undefined` detaches it. */
export function attachSidebarOrderHost(next: SidebarOrderHost | undefined): void {
  binding = next === undefined ? undefined : { host: next, writes: new Map() }
}

function drainOrder(owner: SidebarOrderBinding, key: string, write: OrderWrite): Promise<void> {
  return write.pending ??= Promise.resolve().then(async () => {
    try {
      while (binding === owner && write.confirmed !== write.refs) {
        const refs = write.refs
        try {
          if ((await owner.host.save({ key, refs })).ok) write.confirmed = refs
        } catch {
          // The local order remains usable if the Host cannot save it.
        }
        // An older failure must not hold a newer drag. Do not retry an unchanged failure here.
        if (write.refs === refs) return
      }
    } finally {
      write.pending = undefined
    }
  })
}

function saveOrder(owner: SidebarOrderBinding, key: string, refs: readonly string[]): Promise<void> {
  const write = owner.writes.get(key) ?? { refs }
  write.refs = refs
  owner.writes.set(key, write)
  return drainOrder(owner, key, write)
}

async function hydrate(owner: SidebarOrderBinding): Promise<void> {
  const before = { ...structuredClone(storedOrders()) } as Readonly<Record<string, readonly string[]>>
  let remote: Readonly<Record<string, readonly string[]>>
  try {
    const result = await owner.host.load()
    if (!result.ok || binding !== owner) return
    remote = result.value.lists
  } catch {
    // An unreachable Host leaves the cache in charge; a later gesture still tries to write.
    return
  }
  let adopted = false
  for (const [key, refs] of Object.entries(remote)) {
    // A list this page already dragged outranks the answer, which may have been
    // read before that write landed.
    if (owner.writes.has(key) || !isListKey(key) || !Array.isArray(refs) || refs.length === 0) continue
    if (savedFingerprint(key) === fingerprintOf(refs)) continue
    writeOrder(key, refs)
    adopted = true
  }
  if (adopted) emitChange()

  const queued = [...owner.writes].filter(([, write]) => write.confirmed !== write.refs)
  // An order this browser arranged before the Host carried one moves up once, so
  // the upgrade costs nobody their arrangement. A drag during the read owns the key.
  const migrations: Promise<void>[] = []
  for (const [key, refs] of Object.entries(before)) {
    if (isListKey(key) && !owner.writes.has(key) && refs.length > 0 && !(key in remote)) migrations.push(saveOrder(owner, key, refs))
  }
  await Promise.all([...migrations, ...queued.map(([key, write]) => drainOrder(owner, key, write))])
}

/** Read the Host's saved order once per attached Host; the first list to render starts it. */
export function ensureSidebarOrderHydrated(): Promise<void> {
  if (binding === undefined) return Promise.resolve()
  binding.hydration ??= hydrate(binding)
  return binding.hydration
}

function persistOrder(key: string, refs: readonly string[]): void {
  const owner = binding
  if (owner !== undefined) void saveOrder(owner, key, refs)
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
