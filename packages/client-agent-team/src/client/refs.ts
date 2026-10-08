import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamChannel, AgentTeamChannelRef, AgentTeamClientMemberStatus, AgentTeamMemberId,
  AgentTeamMessageRef,
  AgentTeamResolveMessageRefsRequest, AgentTeamResolveMessageRefsResult,
  AgentTeamResolveTaskRefsRequest, AgentTeamResolveTaskRefsResult, AgentTeamResolveThreadRefsRequest, AgentTeamResolveThreadRefsResult,
  AgentTeamTaskRef, AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'

/** Navigation facts for one branded Task ref, resolved once per session. */
export interface ResolvedTaskRef {
  readonly taskRef: AgentTeamTaskRef
  readonly channelRef: AgentTeamChannelRef
  readonly threadRef: AgentTeamThreadRef
  readonly taskNumber: number
}

/** Navigation facts for one branded Thread ref, resolved once per session. */
export interface ResolvedThreadRef {
  readonly threadRef: AgentTeamThreadRef
  readonly channelRef: AgentTeamChannelRef
  readonly taskRef?: AgentTeamTaskRef
  readonly taskNumber?: number
  /** Opening-line gist distinguishing one Thread chip from another. */
  readonly title: string
}

/**
 * The resolved context of the Message one reply answers. A reply stores only
 * its parent's ref, so the author and the excerpt a quote block renders come
 * from the Host, which holds the whole ledger — a parent outside the reader's
 * loaded history window therefore still resolves.
 */
export interface ResolvedMessageRef {
  readonly messageRef: AgentTeamMessageRef
  readonly threadRef: AgentTeamThreadRef
  readonly sender: AgentTeamMemberId
  /** Body gist for the quote block, already bounded by the Host. */
  readonly excerpt: string
}

/** One roster-resolved Member behind a `member:` chip. */
export interface ResolvedMemberRef {
  readonly memberId: AgentTeamMemberId
  /** Bare handle without the `@`; the chip renders it. */
  readonly handle: string
  /** Present for agent Members; absent for the Human (no session to open). */
  readonly sessionId?: SessionId
  /** Only active agent Members open a session — mirrors the agent card rule. */
  readonly openable: boolean
}

/** Compare refs by branded prefix plus hyphen-stripped UUID, so abbreviated spellings line up with their full form. */
export function refKeyOf(ref: string): string {
  return ref.toLowerCase().replaceAll('-', '')
}

type Listener = () => void

/** Session cache behind one Host-resolved ref kind: resolved entries, in-flight refs, and parked unknowns. */
interface RefStore<TEntry, TRef extends string> {
  readonly useVersion: () => number
  readonly cached: (ref: TRef) => TEntry | undefined
  readonly remember: (entry: TEntry) => void
  readonly resolveUnknown: (refs: readonly TRef[], lookup: (refs: readonly TRef[]) => Promise<readonly TEntry[]>) => Promise<void>
}

/**
 * One versioned resolution cache per Host-resolved ref kind. Concurrent
 * callers deduplicate through the pending set; refs the Host does not know
 * are parked for the session so renders never retry-loop; a landing
 * resolution wakes every rendered link through the version token.
 */
function createRefStore<TEntry, TRef extends string>(refOf: (entry: TEntry) => TRef): RefStore<TEntry, TRef> {
  const resolved = new Map<TRef, TEntry>()
  const pending = new Set<TRef>()
  /** Refs the Host did not recognize; never re-queried (no retry loops). */
  const unresolvable = new Set<TRef>()
  const listeners = new Set<Listener>()
  let version = 0

  const emit = (): void => {
    version += 1
    for (const listener of listeners) listener()
  }

  const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /** Stable snapshot token; the map is read directly after this changes. */
  const getSnapshot = (): number => version

  /** React binding: re-renders the caller when any ref resolution lands. */
  const useVersion = (): number => useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const cached = (ref: TRef): TEntry | undefined => resolved.get(ref)

  /** Store one resolution (click path) and wake every rendered link. */
  const remember = (entry: TEntry): void => {
    resolved.set(refOf(entry), entry)
    pending.delete(refOf(entry))
    emit()
  }

  /**
   * Batch-resolve unknown refs through the Host lookup. Concurrent callers
   * deduplicate through the pending set; failures just clear the pending mark
   * so a later interaction can retry.
   */
  const resolveUnknown = async (
    refs: readonly TRef[],
    lookup: (refs: readonly TRef[]) => Promise<readonly TEntry[]>,
  ): Promise<void> => {
    const missing = refs.filter(ref => !resolved.has(ref) && !pending.has(ref) && !unresolvable.has(ref))
    if (missing.length === 0) return
    for (const ref of missing) pending.add(ref)
    try {
      const entries = await lookup(missing)
      for (const entry of entries) {
        resolved.set(refOf(entry), entry)
        pending.delete(refOf(entry))
      }
      // Refs the Host does not know are parked for the session: re-querying
      // them on every render would loop and hammer the Host.
      for (const ref of missing) {
        if (!resolved.has(ref)) unresolvable.add(ref)
      }
      if (entries.length > 0) emit()
    } finally {
      for (const ref of missing) pending.delete(ref)
    }
  }

  return { useVersion, cached, remember, resolveUnknown }
}

const taskStore = createRefStore((entry: ResolvedTaskRef) => entry.taskRef)
const threadStore = createRefStore((entry: ResolvedThreadRef) => entry.threadRef)
const messageStore = createRefStore((entry: ResolvedMessageRef) => entry.messageRef)

/** React binding: re-renders the caller when any Task ref resolution lands. */
export const useResolvedTaskRefVersion = taskStore.useVersion
export const cachedResolvedTaskRef = taskStore.cached
/** Store one Task resolution (click path) and wake every rendered link. */
export const rememberResolvedTaskRef = taskStore.remember
export const resolveUnknownTaskRefs = taskStore.resolveUnknown

/** React binding: re-renders the caller when any Thread ref resolution lands. */
export const useResolvedThreadRefVersion = threadStore.useVersion
export const cachedResolvedThreadRef = threadStore.cached
/** Store one Thread resolution (click path) and wake every rendered link. */
export const rememberResolvedThreadRef = threadStore.remember
export const resolveUnknownThreadRefs = threadStore.resolveUnknown

/** React binding: re-renders the caller when any reply parent resolution lands. */
export const useResolvedMessageRefVersion = messageStore.useVersion
export const cachedResolvedMessageRef = messageStore.cached
/** Store one reply-parent resolution and wake every rendered quote. */
export const rememberResolvedMessageRef = messageStore.remember
export const resolveUnknownMessageRefs = messageStore.resolveUnknown

/**
 * Click-path Host lookup shared by both ref kinds: remember every resolved
 * entry and hand them back for immediate navigation. The Host keeps
 * `resolved` in the same order as the input refs (one entry per resolvable
 * input, unknowns omitted); the pairing walk below relies on that contract,
 * so it must be preserved together with this implementation. The Host
 * answers with full refs even for abbreviated inputs; the returned entries
 * keep the input order, so the walk remembers each authored spelling as an
 * alias of its resolution.
 */
async function hostRefLookup<TEntry, TRef extends string>(
  remember: (entry: TEntry) => void,
  refOf: (entry: TEntry) => TRef,
  alias: (entry: TEntry, ref: TRef) => TEntry,
  request: (refs: readonly TRef[]) => Promise<RemoteResult<readonly TEntry[]>>,
  refs: readonly TRef[],
): Promise<readonly TEntry[]> {
  const result = await request(refs)
  if (!result.ok) return []
  const entries = result.value
  let entryIndex = 0
  for (const requested of refs) {
    const entry = entries[entryIndex]
    if (entry === undefined || !refKeyOf(refOf(entry)).startsWith(refKeyOf(requested))) continue
    if (refOf(entry) !== requested) remember(alias(entry, requested))
    remember(entry)
    entryIndex += 1
  }
  return entries
}

/**
 * Click-path Task lookup: remember every resolved entry and hand them back
 * for immediate navigation (see hostRefLookup for the ordering contract).
 */
export const hostTaskRefLookup = (
  resolveTaskRefs: (request: AgentTeamResolveTaskRefsRequest) => Promise<RemoteResult<AgentTeamResolveTaskRefsResult>>,
  workspaceId: AgentTeamResolveTaskRefsRequest['workspaceId'],
): ((taskRefs: readonly AgentTeamTaskRef[]) => Promise<readonly ResolvedTaskRef[]>) =>
  async taskRefs => hostRefLookup(
    rememberResolvedTaskRef,
    entry => entry.taskRef,
    (entry, taskRef) => ({ ...entry, taskRef }),
    async refs => {
      const result = await resolveTaskRefs({ workspaceId, taskRefs: refs })
      return result.ok ? { ok: true as const, value: result.value.resolved } : result
    },
    taskRefs,
  )

/**
 * Click-path Thread lookup: remember every resolved entry and hand them back
 * for immediate navigation (see hostRefLookup for the ordering contract).
 */
export const hostThreadRefLookup = (
  resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => Promise<RemoteResult<AgentTeamResolveThreadRefsResult>>,
  workspaceId: AgentTeamResolveThreadRefsRequest['workspaceId'],
): ((threadRefs: readonly AgentTeamThreadRef[]) => Promise<readonly ResolvedThreadRef[]>) =>
  async threadRefs => hostRefLookup(
    rememberResolvedThreadRef,
    entry => entry.threadRef,
    (entry, threadRef) => ({ ...entry, threadRef }),
    async refs => {
      const result = await resolveThreadRefs({ workspaceId, threadRefs: refs })
      return result.ok ? { ok: true as const, value: result.value.resolved } : result
    },
    threadRefs,
  )

/**
 * Resolve the Messages that rendered replies answer. Reply parents are read-only
 * context, so this never navigates: it fills the quotes in place and leaves the
 * unknown ones unresolved rather than rendering a quote of nothing.
 */
export const hostMessageRefLookup = (
  resolveMessageRefs: (request: AgentTeamResolveMessageRefsRequest) => Promise<RemoteResult<AgentTeamResolveMessageRefsResult>>,
  workspaceId: AgentTeamResolveMessageRefsRequest['workspaceId'],
): ((messageRefs: readonly AgentTeamMessageRef[]) => Promise<readonly ResolvedMessageRef[]>) =>
  async messageRefs => {
    const result = await resolveMessageRefs({ workspaceId, messageRefs })
    if (!result.ok) throw new Error(result.error.message)
    for (const entry of result.value.resolved) rememberResolvedMessageRef(entry)
    return result.value.resolved
  }

/** Resolve one Task ref through the Host and jump to its home Channel Thread. */
export const jumpToTaskThread = (
  resolveTaskRefs: (request: AgentTeamResolveTaskRefsRequest) => Promise<RemoteResult<AgentTeamResolveTaskRefsResult>>,
  workspaceId: AgentTeamResolveTaskRefsRequest['workspaceId'],
  taskRef: AgentTeamTaskRef,
  selectThread: (threadRef: AgentTeamThreadRef, channelRef?: AgentTeamChannelRef, taskRef?: AgentTeamTaskRef, taskNumber?: number) => void,
): void => {
  void resolveTaskRefs({ workspaceId, taskRefs: [taskRef] }).then(result => {
    if (!result.ok) return
    const hit = result.value.resolved[0]
    if (hit !== undefined) selectThread(hit.threadRef, hit.channelRef, hit.taskRef, hit.taskNumber)
  })
}

/** Resolve one Thread ref through the Host and jump to its home Channel Thread. */
export const jumpToThread = (
  resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => Promise<RemoteResult<AgentTeamResolveThreadRefsResult>>,
  workspaceId: AgentTeamResolveThreadRefsRequest['workspaceId'],
  threadRef: AgentTeamThreadRef,
  selectThread: (threadRef: AgentTeamThreadRef, channelRef?: AgentTeamChannelRef, taskRef?: AgentTeamTaskRef, taskNumber?: number) => void,
): void => {
  void resolveThreadRefs({ workspaceId, threadRefs: [threadRef] }).then(result => {
    if (!result.ok) return
    const hit = result.value.resolved[0]
    if (hit !== undefined) selectThread(hit.threadRef, hit.channelRef, hit.taskRef, hit.taskNumber)
  })
}

/** Exactly one roster entry whose full key extends the authored spelling; ambiguity resolves to nothing. */
function uniqueByPrefix<T>(entries: readonly T[], keyOf: (entry: T) => string, authored: string): T | undefined {
  const key = refKeyOf(authored)
  const hits = entries.filter(entry => refKeyOf(keyOf(entry)).startsWith(key))
  return hits.length === 1 ? hits[0] : undefined
}

/**
 * Display name for one authored channel ref, or undefined when the loaded
 * roster does not know it — the caller keeps plain text. Archived Channels
 * never resolve: they are gone from every Team surface, so their refs are
 * not links either.
 */
export const rosterChannelName = (
  channels: readonly AgentTeamChannel[],
  channelRef: AgentTeamChannelRef,
): string | undefined =>
  uniqueByPrefix(channels.filter(channel => channel.state === 'active'), channel => channel.channelRef, channelRef)?.name

/**
 * Roster facts for one authored member ref, or undefined when nobody on the
 * roster answers to it — the caller keeps plain text. The Human resolves to
 * a handle with no session: informative, never a link.
 */
export const rosterMember = (
  members: readonly AgentTeamClientMemberStatus[],
  humanMemberId: AgentTeamMemberId | undefined,
  humanHandle: string,
  memberRef: AgentTeamMemberId,
): ResolvedMemberRef | undefined => {
  if (humanMemberId !== undefined && refKeyOf(memberRef) === refKeyOf(humanMemberId)) {
    return { memberId: humanMemberId, handle: humanHandle, openable: false }
  }
  const hit = uniqueByPrefix(members, status => status.member.memberId, memberRef)
  if (hit === undefined) return undefined
  const openable = hit.availability === 'active'
  return {
    memberId: hit.member.memberId,
    handle: hit.member.handle.replace(/^@/, ''),
    ...(openable ? { sessionId: hit.member.sessionId } : {}),
    openable,
  }
}
