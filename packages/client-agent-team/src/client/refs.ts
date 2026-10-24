import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamProject, AgentTeamProjectRef, AgentTeamClientMemberStatus, AgentTeamMemberId,
  AgentTeamMessageRef,
  AgentTeamResolveMessageRefsRequest, AgentTeamResolveMessageRefsResult,
  AgentTeamResolveTaskRefsRequest, AgentTeamResolveTaskRefsResult, AgentTeamResolveThreadRefsRequest, AgentTeamResolveThreadRefsResult,
  AgentTeamTaskRef, AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'

/** Navigation facts for one branded Task ref, resolved once per session. */
export interface ResolvedTaskRef {
  readonly taskRef: AgentTeamTaskRef
  readonly projectRef: AgentTeamProjectRef
  readonly threadRef: AgentTeamThreadRef
  readonly taskNumber: number
}

/** Navigation facts for one branded Thread ref, resolved once per session. */
export interface ResolvedThreadRef {
  readonly threadRef: AgentTeamThreadRef
  readonly projectRef: AgentTeamProjectRef
  readonly taskRef?: AgentTeamTaskRef
  readonly taskNumber?: number
  readonly title: string
}

/** Author and excerpt come from the Host, which holds the whole ledger, so a parent outside the loaded history window still resolves. */
export interface ResolvedMessageRef {
  readonly messageRef: AgentTeamMessageRef
  /** Absent for a Main stream Message. */
  readonly threadRef?: AgentTeamThreadRef
  readonly sender: AgentTeamMemberId
  readonly excerpt: string
}

/** One roster-resolved Member behind a `member:` chip. */
export interface ResolvedMemberRef {
  readonly memberId: AgentTeamMemberId
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

interface RefStore<TEntry, TRef extends string> {
  readonly useVersion: () => number
  readonly cached: (ref: TRef) => TEntry | undefined
  readonly remember: (entry: TEntry) => void
  readonly resolveUnknown: (refs: readonly TRef[], lookup: (refs: readonly TRef[]) => Promise<readonly TEntry[]>) => Promise<void>
}

/** Concurrent callers deduplicate through the pending set; refs the Host does not know are parked so renders never retry-loop. */
function createRefStore<TEntry, TRef extends string>(refOf: (entry: TEntry) => TRef): RefStore<TEntry, TRef> {
  const resolved = new Map<TRef, TEntry>()
  const pending = new Set<TRef>()
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

  const useVersion = (): number => useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const cached = (ref: TRef): TEntry | undefined => resolved.get(ref)

  const remember = (entry: TEntry): void => {
    resolved.set(refOf(entry), entry)
    pending.delete(refOf(entry))
    emit()
  }

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
      // Parked for the session: re-querying on every render would hammer the Host.
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

export const useResolvedTaskRefVersion = taskStore.useVersion
export const cachedResolvedTaskRef = taskStore.cached
const rememberResolvedTaskRef = taskStore.remember
export const resolveUnknownTaskRefs = taskStore.resolveUnknown

export const useResolvedThreadRefVersion = threadStore.useVersion
export const cachedResolvedThreadRef = threadStore.cached
export const rememberResolvedThreadRef = threadStore.remember
export const resolveUnknownThreadRefs = threadStore.resolveUnknown

export const useResolvedMessageRefVersion = messageStore.useVersion
export const cachedResolvedMessageRef = messageStore.cached
const rememberResolvedMessageRef = messageStore.remember
export const resolveUnknownMessageRefs = messageStore.resolveUnknown

/**
 * Pair each resolved entry with the ref that requested it. The Host returns `resolved` in input order, unknowns omitted,
 * with full refs even for abbreviated inputs; an entry whose full ref does not extend the requested one marks an unknown
 * input and is skipped without consuming the entry. Each authored spelling is remembered as an alias.
 */
function rememberAliasedResolutions<TEntry, TRef extends string>(
  entries: readonly TEntry[],
  refs: readonly TRef[],
  remember: (entry: TEntry) => void,
  refOf: (entry: TEntry) => TRef,
  alias: (entry: TEntry, ref: TRef) => TEntry,
): void {
  let entryIndex = 0
  for (const requested of refs) {
    const entry = entries[entryIndex]
    if (entry === undefined || !refKeyOf(refOf(entry)).startsWith(refKeyOf(requested))) continue
    if (refOf(entry) !== requested) remember(alias(entry, requested))
    remember(entry)
    entryIndex += 1
  }
}

/** Click-path Host lookup shared by both ref kinds; relies on the ordering contract of {@link rememberAliasedResolutions}. */
async function hostRefLookup<TEntry, TRef extends string>(
  remember: (entry: TEntry) => void,
  refOf: (entry: TEntry) => TRef,
  alias: (entry: TEntry, ref: TRef) => TEntry,
  request: (refs: readonly TRef[]) => Promise<RemoteResult<readonly TEntry[]>>,
  refs: readonly TRef[],
): Promise<readonly TEntry[]> {
  const result = await request(refs)
  if (!result.ok) return []
  rememberAliasedResolutions(result.value, refs, remember, refOf, alias)
  return result.value
}

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

/** Reply parents are read-only context: fill quotes in place and leave unknown ones unresolved rather than render a quote of nothing. */
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

export const jumpToTaskThread = (
  resolveTaskRefs: (request: AgentTeamResolveTaskRefsRequest) => Promise<RemoteResult<AgentTeamResolveTaskRefsResult>>,
  workspaceId: AgentTeamResolveTaskRefsRequest['workspaceId'],
  taskRef: AgentTeamTaskRef,
  selectThread: (threadRef: AgentTeamThreadRef, projectRef?: AgentTeamProjectRef, taskRef?: AgentTeamTaskRef, taskNumber?: number) => void,
): void => {
  void resolveTaskRefs({ workspaceId, taskRefs: [taskRef] }).then(result => {
    if (!result.ok) return
    const hit = result.value.resolved[0]
    if (hit !== undefined) selectThread(hit.threadRef, hit.projectRef, hit.taskRef, hit.taskNumber)
  })
}

export const jumpToThread = (
  resolveThreadRefs: (request: AgentTeamResolveThreadRefsRequest) => Promise<RemoteResult<AgentTeamResolveThreadRefsResult>>,
  workspaceId: AgentTeamResolveThreadRefsRequest['workspaceId'],
  threadRef: AgentTeamThreadRef,
  selectThread: (threadRef: AgentTeamThreadRef, projectRef?: AgentTeamProjectRef, taskRef?: AgentTeamTaskRef, taskNumber?: number) => void,
): void => {
  void resolveThreadRefs({ workspaceId, threadRefs: [threadRef] }).then(result => {
    if (!result.ok) return
    const hit = result.value.resolved[0]
    if (hit !== undefined) selectThread(hit.threadRef, hit.projectRef, hit.taskRef, hit.taskNumber)
  })
}

/** Exactly one roster entry whose full key extends the authored spelling; ambiguity resolves to nothing. */
function uniqueByPrefix<T>(entries: readonly T[], keyOf: (entry: T) => string, authored: string): T | undefined {
  const key = refKeyOf(authored)
  const hits = entries.filter(entry => refKeyOf(keyOf(entry)).startsWith(key))
  return hits.length === 1 ? hits[0] : undefined
}

/** Undefined when the loaded roster does not know the ref (the caller keeps plain text). Archived Projects never resolve. */
export const rosterProjectName = (
  projects: readonly AgentTeamProject[],
  projectRef: AgentTeamProjectRef,
): string | undefined =>
  uniqueByPrefix(projects.filter(project => project.state === 'active'), project => project.projectRef, projectRef)?.name

/** Undefined when nobody on the roster answers to it. The Human resolves to a handle with no session, never a link. */
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
