import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentTeamMainStreamHistory, AgentTeamMainStreamReadResult, AgentTeamMainStreamStanding, AgentTeamMainTimelineEntry, AgentTeamProjectRef,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TeamConversationProps } from './slots.ts'
import { mintRequestId } from './requests.ts'

const PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

/** How long an arrival keeps its mark: long enough to be noticed, short enough to stay information rather than furniture. */
export const ARRIVAL_MARK_MS = 3000

interface MainStreamSnapshot {
  readonly entries: readonly AgentTeamMainTimelineEntry[]
  readonly cursor: number
  readonly hasMore: boolean
  readonly standing: AgentTeamMainStreamStanding
  /** Keys first shown unread in this visit, with the instant they were shown. See {@link liveArrivals}. */
  readonly arrivals: ReadonlyMap<string, number>
}

export function mainEntryKey(entry: AgentTeamMainTimelineEntry): string {
  return `${entry.kind}:${entry.sequence}`
}

const NO_ARRIVALS: ReadonlyMap<string, number> = new Map()

/** Every key first shown unread is stamped once, when it is first shown. */
function withArrivals(arrivals: ReadonlyMap<string, number>, entries: readonly AgentTeamMainTimelineEntry[], now: number): ReadonlyMap<string, number> {
  let stamped: Map<string, number> | undefined
  for (const entry of entries) {
    // The mark records an arrival, not the Host's live flag: a read can answer in the same frame as the arrival, so a mark
    // read off the current flag would be erased before the reader ever saw it. Once stamped, a key keeps its instant.
    if (entry.unread !== true) continue
    const key = mainEntryKey(entry)
    if (arrivals.has(key)) continue
    stamped ??= new Map(arrivals)
    stamped.set(key, now)
  }
  return stamped ?? arrivals
}

/**
 * The keys still inside their arriving hold. The hold is what makes the mark information: an entry arrives marked, stays
 * marked long enough to be noticed, and is released on its own clock — never held until the reader leaves the page.
 */
export function liveArrivals(arrivals: ReadonlyMap<string, number>, now: number): ReadonlySet<string> {
  const live = new Set<string>()
  for (const [key, stamp] of arrivals) if (now - stamp < ARRIVAL_MARK_MS) live.add(key)
  return live
}

/** A fresh page is authoritative for the sequences it covers; loaded entries outside it stay. */
export function mergeMainStream(current: MainStreamSnapshot | undefined, fresh: AgentTeamMainStreamHistory, now = Date.now()): MainStreamSnapshot {
  if (current === undefined) {
    return { entries: fresh.entries, cursor: fresh.cursor, hasMore: fresh.hasMore, standing: fresh.standing, arrivals: withArrivals(NO_ARRIVALS, fresh.entries, now) }
  }
  const floor = fresh.entries[0]?.sequence ?? Number.POSITIVE_INFINITY
  const ceiling = fresh.entries.at(-1)?.sequence ?? 0
  const entries = [
    ...current.entries.filter(entry => entry.sequence < floor),
    ...fresh.entries,
    ...current.entries.filter(entry => entry.sequence > ceiling),
  ]
  const reachedOlder = current.cursor < fresh.cursor
  return {
    entries,
    cursor: Math.min(current.cursor, fresh.cursor),
    hasMore: fresh.hasMore || reachedOlder,
    standing: fresh.standing,
    arrivals: withArrivals(current.arrivals, fresh.entries, now),
  }
}

/**
 * A read's answer is authoritative for the entries it carries, flagged as the reader saw them before the read. Unlike a history page it is not
 * contiguous — it adds any older entry whose marker the read consumes — so entries overlay by key instead of replacing a range.
 */
export function mergeMainRead(current: MainStreamSnapshot, read: AgentTeamMainStreamReadResult, now = Date.now()): MainStreamSnapshot {
  const merged = new Map(current.entries.map(entry => [mainEntryKey(entry), entry]))
  for (const entry of read.entries) merged.set(mainEntryKey(entry), entry)
  const entries = [...merged.values()].sort((left, right) => left.sequence - right.sequence)
  return { ...current, entries, standing: read.standing, arrivals: withArrivals(current.arrivals, read.entries, now) }
}

/**
 * The marked keys of one render, and a timer for the next release: entries can arrive in a burst, so the earliest deadline
 * schedules the re-render and the following one takes over from there.
 */
export function useArrivalMarks(arrivals: ReadonlyMap<string, number>): ReadonlySet<string> {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const clock = Date.now()
    let soonest = Number.POSITIVE_INFINITY
    for (const stamp of arrivals.values()) {
      const deadline = stamp + ARRIVAL_MARK_MS
      if (deadline > clock) soonest = Math.min(soonest, deadline)
    }
    // Released stamps stay in the map as history, so a deadline already past must schedule nothing: it would spin.
    if (!Number.isFinite(soonest)) return
    const timer = setTimeout(() => { setNow(Date.now()) }, soonest - clock)
    return () => { clearTimeout(timer) }
  }, [arrivals, now])
  return liveArrivals(arrivals, now)
}

interface UseMainStreamOptions {
  readonly workspaceId: WorkspaceId
  readonly projectRef: AgentTeamProjectRef
  readonly mainStreamHistory: TeamConversationProps['mainStreamHistory']
  readonly readMainStream: TeamConversationProps['readMainStream']
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
}

export interface MainStreamState {
  readonly entries: readonly AgentTeamMainTimelineEntry[]
  /** Entries still inside their arriving hold: the mark a reader sees, on its own clock. */
  readonly marked: ReadonlySet<string>
  readonly hasMore: boolean
  readonly loading: boolean
  readonly loadingOlder: boolean
  readonly error: string | undefined
  readonly refresh: () => Promise<boolean>
  readonly loadOlder: () => Promise<void>
  /** Acknowledge everything loaded so far; the Host-owned standing decides what is still unread. */
  readonly markRead: () => Promise<void>
}

/**
 * Newest page first, older pages on demand. The page is mounted only while the Main stream is the visible reading, so a
 * standing with unread entries or markers is acknowledged as soon as it is on screen.
 */
export function useMainStream({ workspaceId, projectRef, mainStreamHistory, readMainStream, subscribeChanges }: UseMainStreamOptions): MainStreamState {
  const [snapshot, setSnapshot] = useState<MainStreamSnapshot>()
  const [loading, setLoading] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [error, setError] = useState<string>()
  const mountedRef = useRef(false)
  const snapshotRef = useRef<MainStreamSnapshot>()
  const refreshSequenceRef = useRef(0)
  const attemptedReadRef = useRef<string>()

  const apply = useCallback((update: (current: MainStreamSnapshot | undefined) => MainStreamSnapshot): void => {
    const next = update(snapshotRef.current)
    snapshotRef.current = next
    setSnapshot(next)
  }, [])

  const refresh = useCallback(async (): Promise<boolean> => {
    if (!mountedRef.current) return false
    const sequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = sequence
    try {
      // A refresh re-covers what is already loaded, so a card whose Thread moved on never goes stale in place.
      const limit = Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, snapshotRef.current?.entries.length ?? 0))
      const result = await mainStreamHistory({ workspaceId, projectRef, limit })
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return false
      if (!result.ok) { setError(result.error.message); return false }
      apply(current => mergeMainStream(current, result.value))
      setError(undefined)
      return true
    } catch (cause) {
      if (mountedRef.current && sequence === refreshSequenceRef.current) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (mountedRef.current && sequence === refreshSequenceRef.current) setLoading(false)
    }
  }, [workspaceId, projectRef, mainStreamHistory, apply])

  const loadOlder = useCallback(async (): Promise<void> => {
    const current = snapshotRef.current
    if (current === undefined || !current.hasMore || loadingOlder) return
    setLoadingOlder(true)
    try {
      const result = await mainStreamHistory({ workspaceId, projectRef, beforeSequence: current.cursor, limit: PAGE_SIZE })
      if (!mountedRef.current) return
      if (!result.ok) { setError(result.error.message); return }
      apply(latest => mergeMainStream(latest, result.value))
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setLoadingOlder(false)
    }
  }, [workspaceId, projectRef, mainStreamHistory, apply, loadingOlder])

  const markRead = useCallback(async (): Promise<void> => {
    const current = snapshotRef.current
    const through = current?.entries.at(-1)?.sequence
    if (current === undefined || through === undefined) return
    try {
      const result = await readMainStream({ requestId: mintRequestId(), workspaceId, projectRef, readThroughSequence: through })
      if (!mountedRef.current) return
      if (!result.ok) { setError(result.error.message); return }
      apply(latest => mergeMainRead(latest ?? current, result.value))
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [workspaceId, projectRef, readMainStream, apply])

  useEffect(() => {
    mountedRef.current = true
    snapshotRef.current = undefined
    attemptedReadRef.current = undefined
    setSnapshot(undefined)
    setLoading(true)
    setError(undefined)
    void refresh()
    const dispose = subscribeChanges({ kind: 'project', projectRef }, update => {
      if (!mountedRef.current) return
      if (update.type === 'failed') { setError(update.message); return }
      void refresh()
    })
    return () => {
      mountedRef.current = false
      refreshSequenceRef.current += 1
      dispose()
    }
  }, [workspaceId, projectRef])

  // A read never wakes the change stream, so one attempt per (newest entry, standing) keeps a stalled Host from spinning this.
  useEffect(() => {
    if (snapshot === undefined) return
    const { standing, entries } = snapshot
    const through = entries.at(-1)?.sequence
    if (through === undefined || (standing.unreadCount === 0 && standing.markers.length === 0)) return
    const attempt = `${through}:${standing.unreadCount}:${standing.markers.length}`
    if (attemptedReadRef.current === attempt) return
    attemptedReadRef.current = attempt
    void markRead()
  }, [snapshot, markRead])

  const marked = useArrivalMarks(snapshot?.arrivals ?? NO_ARRIVALS)
  return { entries: snapshot?.entries ?? [], marked, hasMore: snapshot?.hasMore ?? false, loading, loadingOlder, error, refresh, loadOlder, markRead }
}
