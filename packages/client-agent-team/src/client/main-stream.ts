import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentTeamMainStreamHistory, AgentTeamMainStreamStanding, AgentTeamMainTimelineEntry, AgentTeamProjectRef,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { TeamConversationProps } from './slots.ts'
import { mintRequestId } from './requests.ts'

const PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100

interface MainStreamSnapshot {
  readonly entries: readonly AgentTeamMainTimelineEntry[]
  readonly cursor: number
  readonly hasMore: boolean
  readonly standing: AgentTeamMainStreamStanding
}

export function mainEntryKey(entry: AgentTeamMainTimelineEntry): string {
  return `${entry.kind}:${entry.sequence}`
}

/**
 * A fresh page is authoritative for the sequences it covers; loaded entries outside it stay. An entry that was unread
 * when first shown stays marked for this visit, so reading it on arrival does not erase what the Human is looking at.
 */
export function mergeMainStream(current: MainStreamSnapshot | undefined, fresh: AgentTeamMainStreamHistory): MainStreamSnapshot {
  if (current === undefined) return { entries: fresh.entries, cursor: fresh.cursor, hasMore: fresh.hasMore, standing: fresh.standing }
  const floor = fresh.entries[0]?.sequence ?? Number.POSITIVE_INFINITY
  const ceiling = fresh.entries.at(-1)?.sequence ?? 0
  const wasUnread = new Set(current.entries.filter(entry => entry.unread).map(mainEntryKey))
  const entries = [
    ...current.entries.filter(entry => entry.sequence < floor),
    ...fresh.entries.map(entry => !entry.unread && wasUnread.has(mainEntryKey(entry)) ? { ...entry, unread: true } : entry),
    ...current.entries.filter(entry => entry.sequence > ceiling),
  ]
  const reachedOlder = current.cursor < fresh.cursor
  return {
    entries,
    cursor: Math.min(current.cursor, fresh.cursor),
    hasMore: fresh.hasMore || reachedOlder,
    standing: fresh.standing,
  }
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
      apply(latest => ({ ...(latest ?? current), standing: result.value.standing }))
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

  return { entries: snapshot?.entries ?? [], hasMore: snapshot?.hasMore ?? false, loading, loadingOlder, error, refresh, loadOlder, markRead }
}
