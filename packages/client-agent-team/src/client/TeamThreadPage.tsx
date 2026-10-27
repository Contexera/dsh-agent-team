import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AgentTeamClientMemberStatus,
  AgentTeamThreadTaskCard,
  AgentTeamProjectRef,
  AgentTeamMemberId,
  AgentTeamMessageRef,
  AgentTeamRequestId,
  AgentTeamTaskRef,
  AgentTeamThreadFact,
  AgentTeamThreadReadFact,
  AgentTeamThreadRef,
  AgentTeamView,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconChevronLeftOutlineRegular, Menu, Modal, Pill, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import { TeamComposer } from './TeamComposer.tsx'
import { diagnosticText, TeamPresenceDot } from './TeamPresenceDot.tsx'
import { TeamMessage } from './TeamMessage.tsx'
import { bodyMentionsHuman, firstSentence, formatActivity, formatRiskClass, formatTaskStatus, formatTaskTitle, mentionedMemberIds, taskStatusDot } from './team-formatters.ts'
import { TeamStateDot } from './TeamStateDot.tsx'
import { mintRequestId, uploadComposerFiles } from './requests.ts'
import { daySeparatorLabel, localDateKey } from './team-separators.ts'
import { useTimelineScroll } from './timeline-scroll.ts'
import { useTaskTransfer, useThreadFollow } from './thread-actions.ts'
import { cachedResolvedMessageRef, hostMessageRefLookup, resolveUnknownMessageRefs, useResolvedMessageRefVersion } from './refs.ts'
import { factKey, mergeFacts, messageFact, minSequence, stableMentionNames, type ThreadFactKey } from './thread-facts.ts'
import { hostTaskRefLookup, jumpToTaskThread } from './refs.ts'
import { hostThreadRefLookup, jumpToThread } from './refs.ts'
import { rosterProjectName, rosterMember } from './refs.ts'
import css from './conversation.module.css'
import threadCss from './thread.module.css'

interface TeamThreadPageProps {
  readonly workspaceId: WorkspaceId
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly projectRef?: AgentTeamProjectRef
  readonly taskRef?: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly taskNumber?: number
  readonly backToWorkspace: TeamConversationProps['backToWorkspace']
  readonly loadProjects: TeamConversationProps['loadProjects']
  readonly readThread: TeamConversationProps['readThread']
  readonly loadThreadHistory: TeamConversationProps['loadThreadHistory']
  readonly threadObservations: TeamConversationProps['threadObservations']
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly loadMembers: TeamConversationProps['loadMembers']
  readonly drafts: TeamDraftStore
  readonly getAttachment: TeamConversationProps['getAttachment']
  readonly reply: TeamConversationProps['reply']
  readonly changeAttention: TeamConversationProps['changeAttention']
  readonly transferTask: TeamConversationProps['transferTask']
  readonly changeTask: TeamConversationProps['changeTask']
  readonly promoteThread: TeamConversationProps['promoteThread']
  readonly putAttachment: TeamConversationProps['putAttachment']
  readonly selectProject: TeamConversationProps['selectProject']
  readonly selectThread: TeamConversationProps['selectThread']
  readonly resolveTaskRefs: TeamConversationProps['resolveTaskRefs']
  readonly resolveThreadRefs: TeamConversationProps['resolveThreadRefs']
  readonly resolveMessageRefs: TeamConversationProps['resolveMessageRefs']
  readonly openMemberSession: TeamConversationProps['openMemberSession']
  readonly t: TeamConversationProps['t']
}

type ReadProjection = Awaited<ReturnType<TeamThreadPageProps['readThread']>> extends infer Result
  ? Result extends { ok: true; value: infer Value } ? Value : never
  : never

function readMeta(facts: readonly AgentTeamThreadReadFact[]): ReadonlyMap<ThreadFactKey, AgentTeamThreadReadFact> {
  return new Map(facts.map(fact => [factKey(fact.fact), fact]))
}

/** First unread Message that names the Human reader; flags come from the read that produced these facts, since opening a Thread acknowledges them. */
function firstUnreadMention(facts: readonly AgentTeamThreadReadFact[], humanName: string): AgentTeamMessageRef | undefined {
  for (const entry of facts) {
    if (entry.unread !== true || entry.fact.kind !== 'message') continue
    // The same body scan the card chip answers by: a Thread reaches its Human in every row, so "delivered" cannot decide where an opening lands.
    if (!bodyMentionsHuman(entry.fact.message.body, humanName)) continue
    return entry.fact.message.messageRef
  }
  return undefined
}

export function TeamThreadPage(props: TeamThreadPageProps) {
  const {
    workspaceId, humanName, humanAvatarUrl, projectRef, taskRef, threadRef, taskNumber, backToWorkspace, selectProject, selectThread, resolveTaskRefs, resolveThreadRefs, openMemberSession, putAttachment,
    loadProjects, readThread, loadThreadHistory, threadObservations,
    subscribeChanges, loadMembers, drafts, getAttachment, reply, changeAttention, transferTask, changeTask, promoteThread, resolveMessageRefs, t,
  } = props
  const threadRequest = { threadRef, ...(taskRef === undefined ? {} : { taskRef }) }
  const [projection, setProjection] = useState<ReadProjection>()
  const [projectView, setProjectView] = useState<AgentTeamView>()
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  // Current Thread followers; the composer ranks them first because they are already in the conversation.
  const [followerIds, setFollowerIds] = useState<ReadonlySet<AgentTeamMemberId>>(() => new Set())
  const [currentFacts, setCurrentFacts] = useState<readonly AgentTeamThreadFact[]>([])
  // Tasks derived from this discussion; projection rows, never facts or unread.
  const [taskCards, setTaskCards] = useState<readonly AgentTeamThreadTaskCard[]>([])
  const [olderFacts, setOlderFacts] = useState<readonly AgentTeamThreadFact[]>([])
  const [readFacts, setReadFacts] = useState<readonly AgentTeamThreadReadFact[]>([])
  const [historyCursor, setHistoryCursor] = useState<number>()
  const [historyHasMore, setHistoryHasMore] = useState(false)
  // A bounded read acknowledges at most 20 unread facts and reads never self-wake a change scope,
  // so larger backlogs need continuation reads; the cap stops a feed that outpaces reading.
  const MAX_AUTO_READ_ROUNDS = 50
  const [autoReadExhausted, setAutoReadExhausted] = useState(false)
  const [newFactsCount, setNewFactsCount] = useState(0)
  // The draft cache outlives this page across view switches; the composer owns the subscription so typing never re-renders the timeline.
  const draftKey: TeamDraftKey = `thread:${threadRef}`
  // Early acceptance: the Human may accept while Claims are still open; the
  // confirm dialog lists exactly what will be completed with the Task.
  const [confirmingAccept, setConfirmingAccept] = useState(false)
  useEffect(() => {
    if (confirmingAccept && projection?.task?.resolution === 'accepted') setConfirmingAccept(false)
  }, [confirmingAccept, projection?.task?.resolution])
  const [replyRequestId, setReplyRequestId] = useState<AgentTeamRequestId>()
  const [replyTarget, setReplyTarget] = useState<AgentTeamMessageRef>()
  const [flashedMessage, setFlashedMessage] = useState<AgentTeamMessageRef>()
  const [openCard, setOpenCard] = useState<AgentTeamMessageRef>()
  // The Message this opening lands on, held until its row exists: the jump is
  // decided from the first read, and rows render a paint later.
  const [pendingJump, setPendingJump] = useState<AgentTeamMessageRef>()
  const [pending, setPending] = useState(false)
  // Label source for the promote/accept buttons only: a reply send also raises
  // the shared `pending` gate, and must not retitle those buttons.
  const [mutating, setMutating] = useState<'promote' | 'accept' | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const mountedRef = useRef(false)
  const currentFactsRef = useRef<readonly AgentTeamThreadFact[]>([])
  const sequenceRef = useRef(0)
  const readRequestIdRef = useRef<AgentTeamRequestId>(mintRequestId())
  const projectionRef = useRef<ReadProjection>()
  const mutationRequests = useRef(new Map<string, AgentTeamRequestId>())
  const threadLastFact = currentFacts[currentFacts.length - 1]
  const timeline = useTimelineScroll(`${currentFacts.length}:${olderFacts.length}:${threadLastFact === undefined ? '' : factKey(threadLastFact)}`)
  // The hook returns a fresh object per render, but this callback is stable: the
  // opening jump depends on it without re-running on every render.
  const timelineOnScroll = timeline.onScroll

  const updateProjection = (next: ReadProjection): void => {
    projectionRef.current = next
    setProjection(next)
    setReadFacts(next.facts)
    const anchor = messageFact(next.anchor, next.anchorMentions)
    const batch = [anchor, ...next.facts.map(fact => fact.fact)]
    setCurrentFacts(current => {
      const merged = mergeFacts(current, batch)
      currentFactsRef.current = merged
      return merged
    })
  }

  // Each round mints a fresh requestId (the Host replays a repeated id from its idempotency cache). Terminates on a zero
  // remainder, a failed read, a superseding sequence, or the round cap.
  const drainUnread = async (): Promise<void> => {
    for (let round = 1; round <= MAX_AUTO_READ_ROUNDS; round += 1) {
      const snapshot = projectionRef.current
      if (snapshot === undefined || snapshot.remainingUnreadCount <= 0) return
      const beforeSequence = sequenceRef.current
      if (!await readCurrent(true)) return
      // A newer read or remount owns the tail now; it drains the remainder.
      if (!mountedRef.current || sequenceRef.current !== beforeSequence + 1) return
      // A stalled remainder (Host fault) must not spin the loop.
      if (projectionRef.current?.remainingUnreadCount === snapshot.remainingUnreadCount) return
    }
    setAutoReadExhausted(true)
  }

  const readCurrent = async (newRequest = false): Promise<boolean> => {
    if (!mountedRef.current) return false
    if (newRequest) readRequestIdRef.current = mintRequestId()
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    setLoading(true)
    try {
      const result = await readThread({ requestId: readRequestIdRef.current, workspaceId, ...threadRequest })
      if (!mountedRef.current || sequence !== sequenceRef.current) return false
      if (!result.ok) { setError(result.error.message); return false }
      updateProjection(result.value)
      setError(undefined)
      return true
    } catch (cause) {
      if (mountedRef.current && sequence === sequenceRef.current) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (mountedRef.current && sequence === sequenceRef.current) setLoading(false)
    }
  }

  const applySupplemental = async (): Promise<boolean> => {
    try {
      const [loadedMembers, loadedView] = await Promise.all([
        loadMembers({ workspaceId }),
        loadProjects({ workspaceId, ...(projectRef === undefined ? {} : { projectRef }), threadRef, includeActivities: false, limit: 1 }),
      ])
      if (!mountedRef.current) return false
      if (loadedMembers.ok) setMembers(loadedMembers.value)
      if (loadedView.ok) setProjectView(loadedView.value)
      const failure = [loadedMembers, loadedView].find(result => !result.ok)
      if (failure !== undefined && !failure.ok) setError(failure.error.message)
      return true
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
      return mountedRef.current
    }
  }

  const supplementalRef = useRef<Promise<void>>()
  const supplementalPendingRef = useRef(false)
  const refreshSupplemental = (): Promise<void> => {
    supplementalPendingRef.current = true
    if (supplementalRef.current !== undefined) return supplementalRef.current
    const round = (async () => {
      await Promise.resolve()
      while (mountedRef.current && supplementalPendingRef.current) {
        supplementalPendingRef.current = false
        if (!await applySupplemental()) return
      }
    })().finally(() => {
      if (supplementalRef.current === round) supplementalRef.current = undefined
    })
    supplementalRef.current = round
    return round
  }

  const refreshMembers = async (): Promise<void> => {
    if (!mountedRef.current) return
    try {
      const loaded = await loadMembers({ workspaceId })
      if (!mountedRef.current) return
      if (loaded.ok) setMembers(loaded.value); else setError(loaded.error.message)
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const refreshPassiveFacts = async (): Promise<void> => {
    try {
      const result = await loadThreadHistory({ workspaceId, ...threadRequest, limit: 100 })
      if (!mountedRef.current || !result.ok) return
      setTaskCards(result.value.taskCards ?? [])
      const incoming = result.value.facts
      const shown = currentFactsRef.current
      if (shown.length === 0) return
      const known = new Set(shown.map(fact => factKey(fact)))
      // Facts older than everything rendered are backfill of the wider history window, not new updates; counting them would re-flag read messages.
      const newestShown = shown.reduce((maximum, fact) => Math.max(maximum, fact.sequence), 0)
      const additions = incoming.filter(fact => !known.has(factKey(fact)) && fact.sequence > newestShown)
      setCurrentFacts(current => {
        const merged = mergeFacts(current, incoming)
        currentFactsRef.current = merged
        return merged
      })
      setProjection(current => {
        const next = current === undefined ? current : { ...current, ...(result.value.task === undefined ? {} : { task: result.value.task }), thread: result.value.thread, claims: result.value.claims }
        if (next !== undefined) projectionRef.current = next
        return next
      })
      if (additions.length === 0) return
      // Every arrival while the Thread is open is acknowledged durably. The count only feeds the
      // jump hint for a reader away from the tail.
      if (!timeline.isPinned()) setNewFactsCount(current => current + additions.length)
      // The acknowledgment outcome does not change what is on screen: a
      // failed read surfaces through the error surface, not through the count.
      await readCurrent(true)
    } catch {
    }
  }

  // Follower ranking is an enhancement, not a page fact: a failed observation
  // read leaves the roster order in place instead of surfacing an error.
  const refreshFollowers = async (): Promise<void> => {
    try {
      const result = await threadObservations({ workspaceId, ...threadRequest })
      if (!mountedRef.current || !result.ok) return
      setFollowerIds(new Set(result.value.followers))
    } catch {
    }
  }

  useEffect(() => {
    mountedRef.current = true
    supplementalRef.current = undefined
    supplementalPendingRef.current = false
    projectionRef.current = undefined
    setProjection(undefined)
    setProjectView(undefined)
    setMembers([])
    setFollowerIds(new Set())
    setObservedFollowers(new Set())
    setCurrentFacts([])
    setTaskCards([])
    currentFactsRef.current = []
    setOlderFacts([])
    setReadFacts([])
    setHistoryCursor(undefined)
    setHistoryHasMore(false)
    setAutoReadExhausted(false)
    setNewFactsCount(0)
    setPendingJump(undefined)
    setOpenCard(undefined)
    setError(undefined)
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    setLoading(true)
    void (async () => {
      const [read, history, observations] = await Promise.all([
        readThread({ requestId: readRequestIdRef.current, workspaceId, ...threadRequest }),
        loadThreadHistory({ workspaceId, ...threadRequest, limit: 20 }).catch(() => undefined),
        threadObservations({ workspaceId, ...threadRequest }).catch(() => undefined),
      ])
      if (!mountedRef.current || sequence !== sequenceRef.current) return
      if (history !== undefined && history.ok) setTaskCards(history.value.taskCards ?? [])
      if (!read.ok) {
        setError(read.error.message)
        setLoading(false)
        return
      }
      updateProjection(read.value)
      // Open on the first unread Message that names the reader, decided from this first read before the acknowledgement clears the
      // flags; with none, open at the latest fact.
      const addressed = firstUnreadMention(read.value.facts, humanName)
      if (addressed === undefined) timeline.scrollToBottom()
      else setPendingJump(addressed)
      if (history !== undefined && history.ok) {
        setCurrentFacts(current => {
          const merged = mergeFacts(current, history.value.facts)
          currentFactsRef.current = merged
          return merged
        })
        setHistoryCursor(history.value.cursor)
        setHistoryHasMore(history.value.hasMore)
      } else {
        // A rejected or refused history read must not take the only way back to older facts with it: pressing the affordance pages under its own error surface.
        setHistoryHasMore(true)
      }
      if (observations !== undefined && observations.ok) {
        const observed = new Set(observations.value.followers)
        setFollowerIds(observed)
        setObservedFollowers(observed)
      }
      setError(undefined)
      setLoading(false)
      await drainUnread()
    })()
    void refreshSupplemental()
    const disposers = [
      subscribeChanges({ kind: 'thread', threadRef }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setError(update.message); return }
        void refreshPassiveFacts()
        void refreshFollowers()
      }),
      subscribeChanges({ kind: 'workspace', workspaceId }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setError(update.message); return }
        void refreshSupplemental()
      }),
      // Presence commits nothing: refresh the roster alone; the project view is reserved for workspace membership changes.
      subscribeChanges({ kind: 'presence', workspaceId }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setError(update.message); return }
        void refreshMembers()
      }),
    ]
    return () => {
      mountedRef.current = false
      sequenceRef.current += 1
      for (const dispose of disposers) dispose()
    }
  }, [workspaceId, taskRef, threadRef])

  // Returning to the bottom answers the jump hint: arrivals are on screen and their durable read already happened or will be retried.
  useEffect(() => {
    if (newFactsCount > 0 && timeline.isPinned()) setNewFactsCount(0)
  }, [newFactsCount, currentFacts, olderFacts, timeline])

  // The hint must go away the moment the reader is back within the follow margin, even when no render follows the position change.
  const handleTimelineScroll = (): void => {
    timeline.onScroll()
    if (timeline.isPinned()) setNewFactsCount(0)
  }

  const loadOlder = async (): Promise<void> => {
    if (historyHasMore === false && historyCursor === undefined) return
    const beforeSequence = historyCursor ?? minSequence(currentFactsRef.current)
    if (beforeSequence === undefined) return
    setLoading(true)
    try {
      const result = await loadThreadHistory({ workspaceId, ...threadRequest, beforeSequence, limit: 20 })
      if (!mountedRef.current) return
      if (!result.ok) { setError(result.error.message); return }
      setOlderFacts(current => mergeFacts(current, result.value.facts))
      setHistoryCursor(result.value.cursor)
      setHistoryHasMore(result.value.hasMore)
      setError(undefined)
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  const activeProjection = projection
  const task = activeProjection?.task
  const thread = activeProjection?.thread
  const resolvedTaskNumber = taskNumber ?? projectView?.taskNumbers.find(entry => entry.taskRef === task?.taskRef)?.taskNumber
  const taskTitle = activeProjection === undefined ? undefined : formatTaskTitle(activeProjection.anchor.body)
  const taskClaims = activeProjection?.claims ?? []
  const effectiveProjectRef = task?.projectRef ?? projectRef
  const projectMemberIds = useMemo(() => new Set(projectView?.members.filter(item => item.projectRef === effectiveProjectRef).map(item => item.memberId) ?? []), [projectView, effectiveProjectRef])
  const projectMembers = members.filter(status => projectMemberIds.size === 0 || projectMemberIds.has(status.member.memberId))
  const mentionHandlesMap = useMemo(() => new Map(members.map(status => [status.member.memberId, status.member.handle.replace(/^@/, '')])), [members])
  const metadata = useMemo(() => readMeta(readFacts), [readFacts])
  const unreadIndex = useMemo(() => {
    const all = mergeFacts(
      ...(activeProjection === undefined ? [] : [[messageFact(activeProjection.anchor, activeProjection.anchorMentions)]]),
      readFacts.map(fact => fact.fact),
      currentFacts,
    )
    return all.findIndex(fact => metadata.get(factKey(fact))?.unread === true)
  }, [activeProjection?.anchor, readFacts, currentFacts, metadata])

  const memberName = (memberId: AgentTeamMemberId): string => {
    if (memberId === projectView?.humanMemberId) return humanName
    const status = members.find(candidate => candidate.member.memberId === memberId)
    return status === undefined ? t('memberUnknown') : `@${status.member.handle}`
  }

  const messageSender = (fact: AgentTeamThreadFact): AgentTeamMemberId | undefined =>
    fact.kind === 'message' ? fact.message.sender : undefined

  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([])

  // Transfer targets come from the Host's own Project projection: the Agent owners are the rows the
  // same view serves the Project settings page, and the Human owns every Project, so `humanMemberId`
  // is the Host's own answer for the Human target — `owners` never lists it. Handing a Task back to
  // the Human is what mends a finished Task whose accountable is no longer a Project owner. The
  // Client offers the union without re-implementing the Host's legality rule.
  // A finished Task still needs a mender: only a Member actor is confined to open Tasks, and this
  // surface is the Human's, whose Remote moves a finished Task whose accountable left the Project.
  const transferTargets = useMemo(() => {
    if (task === undefined) return []
    const projectOwners = (projectView?.owners ?? []).filter(owner => owner.projectRef === effectiveProjectRef).map(owner => owner.memberId)
    const human = projectView?.humanMemberId
    const targets = human === undefined ? projectOwners : [...projectOwners, human]
    return [...new Set(targets)].filter(memberId => memberId !== task.accountable)
  }, [projectView?.owners, projectView?.humanMemberId, effectiveProjectRef, task?.accountable])

  const transferMenuItems = useMemo<readonly MenuEntry[]>(() => transferTargets.map(memberId => ({
    id: memberId,
    label: memberId === projectView?.humanMemberId ? t('transferTargetYou') : t('transferTargetLabel', { name: memberName(memberId) }),
  })), [transferTargets, projectView?.humanMemberId, memberName, t])

  // Unresolvable refs never become links (see TeamMessage), so only Host-confirmed refs reach here. Identity-stable: a fresh
  // closure per render would defeat TeamMessage's memo.
  const openRef = useCallback((ref: string): void => {
    if (ref.startsWith('project:') && ref !== projectRef) {
      selectProject(ref as AgentTeamProjectRef)
      return
    }
    if (ref.startsWith('thread:') && ref !== threadRef) {
      jumpToThread(resolveThreadRefs, workspaceId, ref as AgentTeamThreadRef, selectThread)
      return
    }
    if (ref.startsWith('task:') && ref !== taskRef) {
      jumpToTaskThread(resolveTaskRefs, workspaceId, ref as AgentTeamTaskRef, selectThread)
    }
  }, [projectRef, threadRef, taskRef, workspaceId, selectProject, selectThread, resolveTaskRefs, resolveThreadRefs])

  const lookupTaskRefs = useMemo(() => hostTaskRefLookup(resolveTaskRefs, workspaceId), [resolveTaskRefs, workspaceId])
  const lookupThreadRefs = useMemo(() => hostThreadRefLookup(resolveThreadRefs, workspaceId), [resolveThreadRefs, workspaceId])

  // Reply parents resolve through the Host: a quote must fill in even when the
  // Message it answers sits far outside the facts this page has loaded.
  const lookupMessageRefs = useMemo(() => hostMessageRefLookup(resolveMessageRefs, workspaceId), [resolveMessageRefs, workspaceId])
  const messageRefVersion = useResolvedMessageRefVersion()
  useEffect(() => {
    // Every reply's parent (for its quote block) and the composer's current target (for its banner) need context; the target is usually not itself a reply.
    const refs = currentFacts.flatMap(fact => fact.kind === 'message' && fact.message.replyToMessageRef !== undefined ? [fact.message.replyToMessageRef] : [])
    if (replyTarget !== undefined && !refs.includes(replyTarget)) refs.push(replyTarget)
    if (refs.length > 0) void resolveUnknownMessageRefs(refs, lookupMessageRefs)
  }, [currentFacts, replyTarget, lookupMessageRefs, messageRefVersion])
  useEffect(() => {
    if (flashedMessage === undefined) return
    // The pulse is the opening jump's lifetime: releasing it releases the target, so a settling jump never outlives its mark or pulls a reader who moved on.
    const timer = setTimeout(() => { setFlashedMessage(undefined); setPendingJump(undefined) }, 1200)
    return () => { clearTimeout(timer) }
  }, [flashedMessage])
  // Centre the Message that names the reader and pulse its row once, with an instant scroll since this is where the page opens.
  // The target stays pending for the pulse: the first paint may still be growing and the pin-to-bottom policy would undo an early jump, so every commit re-centres it until the pulse releases it.
  useLayoutEffect(() => {
    if (pendingJump === undefined) return
    const node = document.querySelector(`[data-message-ref="${pendingJump}"]`)
    if (node === null) return
    node.scrollIntoView({ block: 'center' })
    // Tell the shared scroll policy the reader is off the tail, or the next arriving fact counts them as pinned and undoes the jump.
    timelineOnScroll()
    setFlashedMessage(pendingJump)
  }, [pendingJump, currentFacts, readFacts, timelineOnScroll])
  const jumpToMessage = useCallback((messageRef: AgentTeamMessageRef): void => {
    const node = document.querySelector(`[data-message-ref="${messageRef}"]`)
    if (node === null) return
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setFlashedMessage(messageRef)
  }, [])
  // One stable callback for every row: TeamMessage is memoized, so a fresh
  // closure per row would re-render the whole timeline on any page render.
  const handleReply = useCallback((messageRef: AgentTeamMessageRef): void => { setReplyTarget(messageRef) }, [])
  const handleToggleCard = useCallback((messageRef: AgentTeamMessageRef): void => {
    setOpenCard(current => current === messageRef ? undefined : messageRef)
  }, [])
  const handleOpenReplyTo = useCallback((messageRef: AgentTeamMessageRef): void => { jumpToMessage(messageRef) }, [jumpToMessage])
  // Keyed on roster content, not array identity, so memoized rows survive change bursts that leave the roster untouched.
  const rosterKey = useMemo(() => [
    (projectView?.projects ?? []).map(project => `${project.projectRef}=${project.name}=${project.state}`).join(','),
    members.map(status => `${status.member.memberId}=${status.member.handle}=${status.member.sessionId}=${status.availability}`).join(','),
    projectView?.humanMemberId ?? '',
  ].join(';'), [projectView, members])
  const projectNameOf = useMemo(() => {
    const projects = projectView?.projects ?? []
    return (ref: AgentTeamProjectRef): string | undefined => rosterProjectName(projects, ref)
  }, [rosterKey])
  const memberOf = useMemo(() => {
    const humanMemberId = projectView?.humanMemberId
    return (ref: AgentTeamMemberId) => rosterMember(members, humanMemberId, humanName, ref)
  }, [rosterKey, humanName])

  // One stable object per row: TeamMessage is memoized and an object literal per render would undo it.
  const replyContexts = useMemo(() => {
    const contexts = new Map<AgentTeamMessageRef, { readonly senderName: string; readonly excerpt: string; readonly messageRef: AgentTeamMessageRef }>()
    const nameOf = (memberId: AgentTeamMemberId): string => {
      if (memberId === projectView?.humanMemberId) return humanName
      const status = members.find(candidate => candidate.member.memberId === memberId)
      return status === undefined ? t('memberUnknown') : `@${status.member.handle}`
    }
    for (const fact of currentFacts) {
      if (fact.kind !== 'message' || fact.message.replyToMessageRef === undefined) continue
      const parent = cachedResolvedMessageRef(fact.message.replyToMessageRef)
      // The ref travels whether or not the parent is resolved: it is the fact's
      // own pointer, so the quote line can always name where it goes.
      contexts.set(fact.message.messageRef, parent === undefined
        ? { senderName: t('memberUnknown'), excerpt: '', messageRef: fact.message.replyToMessageRef }
        : { senderName: nameOf(parent.sender), excerpt: parent.excerpt, messageRef: parent.messageRef })
    }
    return contexts
  }, [currentFacts, messageRefVersion, members, projectView, humanName, t])

  const renderFact = (fact: AgentTeamThreadFact, grouped = false) => {
    if (fact.kind === 'message') {
      const sender = memberName(fact.message.sender)
      const senderStatus = members.find(candidate => candidate.member.memberId === fact.message.sender)
      const human = fact.message.sender === projectView?.humanMemberId
      return <TeamMessage
        key={factKey(fact)}
        senderName={sender}
        memberId={fact.message.sender}
        human={human}
        readerName={humanName}
        {...(human && humanAvatarUrl !== undefined ? { avatarUrl: humanAvatarUrl } : {})}
        body={fact.message.body}
        attachments={fact.message.attachments}
        loadAttachment={getAttachment}
        t={t}
        occurredAt={fact.message.occurredAt}
        mentionNames={stableMentionNames(fact.mentions, mentionHandlesMap, humanName)}
        onOpenRef={openRef}
        onResolveTaskRefs={lookupTaskRefs}
        onResolveThreadRefs={lookupThreadRefs}
        projectNameOf={projectNameOf}
        memberOf={memberOf}
        onOpenMemberSession={openMemberSession}
        grouped={grouped}
        showGroupedTime
        cardOpen={openCard === fact.message.messageRef}
        onToggleCard={handleToggleCard}
        messageRef={fact.message.messageRef}
        {...(replyContexts.has(fact.message.messageRef) ? { replyTo: replyContexts.get(fact.message.messageRef)!, onOpenReplyTo: handleOpenReplyTo } : {})}
        onReply={handleReply}
        rowActions="always"
        replyTarget={replyTarget === fact.message.messageRef}
        replyFlash={flashedMessage === fact.message.messageRef}
        {...(senderStatus === undefined ? {} : { senderTitle: senderStatus.member.description })}
      />
    }
    return <p className={threadCss.activityRow} key={factKey(fact)}><span className={threadCss.activityMark} aria-hidden="true" /><span className={threadCss.activityText}>{formatActivity(fact.activity, { t, actorName: memberName, claims: taskClaims })}</span></p>
  }

  /** One derived Task card: the discussion's own projection of work it spawned, jumping to the Task Thread. */
  const renderTaskCard = (card: AgentTeamThreadTaskCard): ReactNode => {
    const accountableName = memberName(card.accountable)
    const accountableSuspended = members.some(status => status.member.memberId === card.accountable && status.member.state === 'suspended')
    return <button type="button" key={`task-card-${card.taskRef}`} className={threadCss.derivedTaskCard}
      onClick={() => selectThread(card.threadRef, projectRef, card.taskRef, card.taskNumber)}>
      <TeamStateDot size={8} state={taskStatusDot(card.status)} />
      <span className={threadCss.derivedTaskCardTitle}>{t('derivedTaskCard', { number: card.taskNumber })}</span>
      <span className={threadCss.derivedTaskCardSubject} title={card.subject}>{card.subject}</span>
      <span className={threadCss.derivedTaskCardMeta}>{formatTaskStatus(card.status, t)} · {accountableName}{accountableSuspended ? ` · ${t('boardAccountableSuspended')}` : ''}</span>
    </button>
  }

  /** One run = one same-sender reply turn; activities, derived Task cards, the unread boundary, and day changes break runs. */
  const renderFactBlocks = (facts: readonly AgentTeamThreadFact[], boundaryIndex: number | undefined, cards: readonly AgentTeamThreadTaskCard[] = []): ReactNode[] => {
    const nodes: ReactNode[] = []
    let run: AgentTeamThreadFact[] = []
    let lastDay: string | undefined
    let nextCard = 0
    const flushRun = () => {
      if (run.length > 0) {
        nodes.push(
          <div className={css.messageRun} key={`run-${factKey(run[0]!)}`}>
            {run.map((entry, entryIndex) => <Fragment key={factKey(entry)}>
              {renderFact(entry, entryIndex > 0)}
            </Fragment>)}
          </div>,
        )
      }
      run = []
    }
    facts.forEach((fact, index) => {
      const occurredAt = fact.kind === 'message' ? fact.message.occurredAt : undefined
      if (occurredAt !== undefined) {
        const day = localDateKey(occurredAt)
        if (lastDay !== undefined && day !== lastDay) {
          flushRun()
          nodes.push(<p className={threadCss.daySeparator} key={`day-${index}`}><span>{daySeparatorLabel(occurredAt)}</span></p>)
        }
        lastDay = day
      }
      while (nextCard < cards.length && cards[nextCard]!.sequence < fact.sequence) {
        flushRun()
        nodes.push(renderTaskCard(cards[nextCard]!))
        nextCard += 1
      }
      const sender = messageSender(fact)
      if (sender !== undefined && run.length > 0 && sender === messageSender(run[run.length - 1]!)) {
        run.push(fact)
        return
      }
      flushRun()
      if (boundaryIndex === index) nodes.push(<p key={`boundary-${index}`} className={threadCss.unreadBoundary} role="separator"><span>{t('unreadBoundary')}</span></p>)
      if (sender !== undefined) run.push(fact)
      else nodes.push(<Fragment key={factKey(fact)}>{renderFact(fact)}</Fragment>)
    })
    while (nextCard < cards.length) {
      flushRun()
      nodes.push(renderTaskCard(cards[nextCard]!))
      nextCard += 1
    }
    flushRun()
    return nodes
  }

  // The follow control and the transfer menu share the same two hooks the discussion panel uses, so both
  // faces display the Host's current observation and recover from a refusal the same way. The page's mount
  // observation already answered the follower set, so the control starts from that answer instead of
  // issuing a second read for the same state. That set is every Member's Attention, so the control is also
  // told which id is the Human's: the Host projects it, and it is what keeps another Member's follow from
  // reading as the Human's own.
  const [observedFollowers, setObservedFollowers] = useState<ReadonlySet<AgentTeamMemberId>>(() => new Set())
  const follow = useThreadFollow(changeAttention, threadObservations, { workspaceId, ...threadRequest }, observedFollowers, projectView?.humanMemberId)
  const [transferMenuOpen, setTransferMenuOpen] = useState(false)
  const transfer = useTaskTransfer(transferTask, {
    workspaceId,
    taskRef: task?.taskRef as AgentTeamTaskRef,
    revisionOf: () => thread?.revision,
    onCommitted: async (committed) => {
      setProjection(current => current === undefined ? current : { ...current, task: committed.task, thread: committed.thread })
      // The Host's own transfer activity row, merged exactly as an accept or close merges its own.
      setCurrentFacts(current => {
        const merged = mergeFacts(current, [{ kind: 'activity', sequence: committed.activity.sequence, activity: committed.activity, occurredAt: committed.receipt.occurredAt }])
        currentFactsRef.current = merged
        return merged
      })
      setTransferMenuOpen(false)
      await readCurrent(true)
      await refreshSupplemental()
    },
    // A fence re-reads through the page's own recovery path, exactly as accept, close, and reopen do:
    // the unread gate drains, the stale revision re-projects the Thread, and the Task's current
    // accountable stays on screen untouched while it happens.
    onRefusal: async (refusal) => {
      setTransferMenuOpen(false)
      if (refusal.kind === 'unread_required') await refreshAfterFence()
      else await refreshPassiveFacts()
    },
  })

  const refreshAfterFence = async (): Promise<void> => {
    timeline.scrollToBottom()
    await readCurrent(true)
    await refreshSupplemental()
    await drainUnread()
  }

  const convertToTask = async (): Promise<void> => {
    if (pending || thread === undefined || task !== undefined) return
    setPending(true)
    setMutating('promote')
    setError(undefined)
    const key = 'promote'
    const requestId = mutationRequests.current.get(key) ?? mintRequestId()
    mutationRequests.current.set(key, requestId)
    try {
      const result = await promoteThread({ requestId, workspaceId, threadRef, baseRevision: thread.revision })
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.kind === 'committed') {
        mutationRequests.current.delete(key)
        const committed = result.value as Extract<typeof result.value, { kind: 'committed' }>
        setProjection(current => current === undefined ? current
          : { ...current, task: committed.task, thread: committed.thread })
        setCurrentFacts(current => {
          const merged = mergeFacts(current, [{ kind: 'activity', sequence: committed.activity.sequence, activity: committed.activity, occurredAt: committed.receipt.occurredAt }])
          currentFactsRef.current = merged
          return merged
        })
        await readCurrent(true)
        await refreshSupplemental()
      } else if (result.value.kind === 'unread_required') {
        setError(t('unreadRequired', { count: result.value.unreadCount }))
        mutationRequests.current.delete(key)
        await refreshAfterFence()
      } else {
        setError(t('staleRevision'))
        mutationRequests.current.delete(key)
        await refreshPassiveFacts()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
      setMutating(undefined)
    }
  }

  const mutateTask = async (action: 'accept' | 'close' | 'reopen'): Promise<void> => {
    if (pending || task === undefined || thread === undefined) return
    setPending(true)
    if (action === 'accept') setMutating('accept')
    setError(undefined)
    const key = `task:${action}`
    const requestId = mutationRequests.current.get(key) ?? mintRequestId()
    mutationRequests.current.set(key, requestId)
    try {
      const result = await changeTask({ requestId, workspaceId, taskRef: task.taskRef, action, baseRevision: thread.revision })
      if (!result.ok) { setError(result.error.message); return }
      if (result.value.kind === 'committed') {
        mutationRequests.current.delete(key)
        const committed = result.value as Extract<typeof result.value, { kind: 'committed' }>
        setProjection(current => current === undefined ? current : { ...current, task: committed.task, thread: committed.thread, claims: committed.claims })
        setCurrentFacts(current => {
          const merged = mergeFacts(current, [{ kind: 'activity', sequence: committed.activity.sequence, activity: committed.activity, occurredAt: committed.receipt.occurredAt }])
          currentFactsRef.current = merged
          return merged
        })
        await readCurrent(true)
        await refreshSupplemental()
      } else if (result.value.kind === 'unread_required') {
        setError(t('unreadRequired', { count: result.value.unreadCount }))
        mutationRequests.current.delete(key)
        await refreshAfterFence()
      } else {
        setError(t('staleRevision'))
        mutationRequests.current.delete(key)
        await refreshPassiveFacts()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
      setMutating(undefined)
    }
  }

  // Every setter returns the same state when there is nothing to clear, so a keystroke does not re-render the timeline.
  // Editing invalidates the retained requestId.
  const clearSendState = useCallback((): void => {
    setReplyRequestId(current => current === undefined ? current : undefined)
  }, [])

  const sendReply = async (): Promise<void> => {
    // Read at send time: this page does not subscribe to the draft.
    const { draft, recipients } = drafts.getSnapshot(draftKey)
    if (pending || thread === undefined || draft.trim() === '') return
    const id = replyRequestId ?? mintRequestId()
    setReplyRequestId(id)
    setPending(true)
    setError(undefined)
    try {
      const upload = await uploadComposerFiles(putAttachment, workspaceId, pendingFiles)
      if (!upload.ok) {
        setError(upload.error)
        return
      }
      const attachmentIds = upload.attachmentIds
      const result = await reply({ requestId: id, workspaceId, threadRef, ...(task === undefined ? {} : { taskRef: task.taskRef }), ...(replyTarget === undefined ? {} : { replyToMessageRef: replyTarget }), body: draft.trim(), baseRevision: thread.revision, recipients: [...recipients].sort(), ...(attachmentIds.length === 0 ? {} : { attachments: attachmentIds }) })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (result.value.kind === 'committed') {
        const committed = result.value as Extract<typeof result.value, { kind: 'committed' }>
        // A hand-typed `@Handle` delivers like a picked recipient; committed facts replace this row on arrival.
        const optimisticMentions = [...new Set([...recipients, ...mentionedMemberIds(draft, projectMembers)])].sort()
        setCurrentFacts(current => {
          const merged = mergeFacts(current, [{ kind: 'message', sequence: committed.message.sequence, message: committed.message, mentions: optimisticMentions, occurredAt: committed.receipt.occurredAt }])
          currentFactsRef.current = merged
          return merged
        })
        setProjection(current => current === undefined ? current : { ...current, ...(committed.task === undefined ? {} : { task: committed.task }), thread: committed.thread })
        drafts.clear(draftKey)
        setReplyTarget(undefined)
        setPendingFiles([])
        setReplyRequestId(undefined)
        await refreshSupplemental()
      } else if (result.value.kind === 'unread_required') {
        setError(t('unreadRequired', { count: result.value.unreadCount }))
        setReplyRequestId(undefined)
        await refreshAfterFence()
      } else if (result.value.kind === 'stale_revision') {
        setError(t('staleRevision'))
        setReplyRequestId(undefined)
        await refreshPassiveFacts()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setPending(false) }
  }

  const currentFactsWithAnchor = mergeFacts(activeProjection === undefined ? [] : [messageFact(activeProjection.anchor, activeProjection.anchorMentions)], currentFacts)
  const unreadBoundary = unreadIndex >= 0 ? unreadIndex : undefined
  // One row per erroring Member holding a live Claim: the diagnostic's structured class beside the first sentence of the Host's
  // reason; the full text rides the row's title.
  const risks = taskClaims.filter(claim => claim.state === 'active').flatMap(claim => {
    const status = members.find(candidate => candidate.member.memberId === claim.owner)
    if (status?.presence !== 'error') return []
    const risk = formatRiskClass(status, t)
    const detail = diagnosticText(status)
    return [{
      claim, status, ...risk,
      reason: detail === '' ? t('statusError') : firstSentence(detail),
      full: detail === '' ? t('statusError') : detail,
    }]
  })
  // Threads are always entered through a Project page, so a Project origin
  // returns to its timeline; a Thread restored without one returns further.
  const backLabel = projectRef === undefined ? t('backToWorkspace') : t('backToProject')

  // The action band's lifecycle group, decided once so the divider can ask whether that group renders:
  // a closed Task's reopen lives only in the composer-slot notice, so that state carries no group at all.
  const activeClaimCount = projection?.claims.filter(claim => claim.taskRef === task?.taskRef && claim.state === 'active').length ?? 0
  // Accepting early closes Claims with the Task, so it asks first; a todo Task's work finished outside
  // the ledger, so there is nothing to confirm and no Claims to list.
  const earlyAccept = task?.resolution === 'open' && task.status === 'in_progress' && activeClaimCount > 0
  const canAccept = task?.resolution === 'open' && (task.status === 'in_review' || task.status === 'todo' || earlyAccept)
  const showLifecycleGroup = task === undefined || task.resolution !== 'closed'
  // The transfer receipt stands only while the Host still shows the Task where the write put it, so a later
  // move — this band's or anyone else's — retires the line instead of contradicting the Task on screen.
  const transferLandedOn = transfer.landedOn !== undefined && task?.accountable === transfer.landedOn ? transfer.landedOn : undefined

  return <main className={css.surface} data-team-thread={threadRef}>
    <div className={`${css.surfaceHeader} ${css.surfaceHeaderStacked}`}>
      <div className={css.backRow}><Button size="sm" icon={<IconChevronLeftOutlineRegular />} onClick={backToWorkspace}>{backLabel}</Button></div>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <div className={threadCss.titleLine}>
            <h1>{task === undefined ? t('threadLabel') : t('taskLabel', { number: resolvedTaskNumber ?? '…' })}</h1>
            {task !== undefined && <Pill><TeamStateDot size={8} state={taskStatusDot(task.status)} />{formatTaskStatus(task.status, t)}</Pill>}
          </div>
          {taskTitle !== undefined && taskTitle !== '' && <p className={threadCss.taskTitle} title={taskTitle}>{taskTitle}</p>}
        </div>
        {/* One band, two groups: what the reader does with this Thread (following it, moving its
            responsibility), and what resolves it (promotion, acceptance, closing). The 1px rule
            between them states that hierarchy instead of the whitespace four siblings used to. */}
        {thread !== undefined && <div className={css.headerActions} data-team-action-band>
          <div className={css.actionGroup} data-team-action-group="thread">
            {/* The follow control stands on both faces of a Thread: a discussion and a Task alike. Its
                pressed state is the band's own fill, because a shipped outline button paints nothing
                for `aria-pressed` and "followed" and "not followed" would otherwise read alike. */}
            {/* The visible verb is the band's own grade; the accessible name keeps the full phrase, so the
                control still says what it follows while four actions share one line. While a write runs the
                name says so in the long form: the shortened visible word is not what a screen reader reads,
                and a control that stopped announcing its own progress would be a regression against the
                previous copy. */}
            <Button size="sm" variant="outline" className={follow.following === true ? css.toggleOn : undefined}
              disabled={follow.pending} aria-pressed={follow.following === true}
              aria-label={follow.pending ? t('followPending') : follow.following === true ? t('unfollowThread') : t('followThread')}
              onClick={() => { void follow.toggle(follow.following === true ? 'unfollow' : 'follow') }}>
              {follow.pending ? t('followPendingLabel') : follow.following === true ? t('unfollowLabel') : t('followLabel')}
            </Button>
            {/* A finished Task is mended from here: only a Member actor is confined to open Tasks, so the
                Human's transfer stands with the resolution. */}
            {task !== undefined && transferTargets.length > 0 && <Menu
              open={transferMenuOpen}
              onClose={() => { setTransferMenuOpen(false) }}
              items={transferMenuItems}
              onSelect={id => { void transfer.transfer(id as AgentTeamMemberId) }}
              anchor={<Button size="sm" variant="outline" disabled={transfer.pending} aria-haspopup="menu"
                aria-label={transfer.pending ? t('transferringTask') : t('transferTask')} onClick={() => { setTransferMenuOpen(value => !value) }}>
                {transfer.pending ? t('transferPendingLabel') : t('transferLabel')}
              </Button>}
            />}
          </div>
          {showLifecycleGroup && <div className={css.actionGroup} data-team-action-group="lifecycle">
            {task === undefined
              ? <Button size="sm" variant="primary" disabled={pending} onClick={() => { void convertToTask() }}>{mutating === 'promote' ? t('promotingTask') : t('promoteToTask')}</Button>
              : task.resolution === 'open'
                ? <>
                  {canAccept && <Button size="sm" variant="primary" disabled={pending}
                    onClick={() => { if (earlyAccept) { setConfirmingAccept(true) } else { void mutateTask('accept') } }}>{t('acceptTask')}</Button>}
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => { void mutateTask('close') }}>{t('closeTask')}</Button>
                </>
                : <Button size="sm" variant="primary" disabled={pending} onClick={() => { void mutateTask('reopen') }}>{t('reopenTask')}</Button>}
          </div>}
        </div>}
      </header>
      {/* Two failures, two lines: which control refused, and what to do next. A band's failure is not
          the whole-surface replacement `.errorState` draws, which would centre itself in the band. */}
      {follow.error !== undefined && <p className={css.actionError} role="alert">{follow.error}</p>}
      {(transfer.error !== undefined || transfer.refusal !== undefined) && <p className={css.actionError} role="alert">
        {transfer.error ?? (transfer.refusal?.kind === 'unread_required'
          ? t('transferUnreadRequired', { count: transfer.refusal.unreadCount })
          : t('transferStaleRevision'))}
      </p>}
      {/* What a committed transfer changed, where the control stands: the new accountable also lands in the
          feed as the Host's own activity row, but that row sits below the fold of a long Thread. The receipt
          is stated against the projection, so any later move of responsibility retires it instead of leaving
          a line that claims the Task went somewhere it no longer is. */}
      {transferLandedOn !== undefined && <p className={css.actionNotice} role="status">
        {transferLandedOn === projectView?.humanMemberId ? t('transferDoneYou') : t('transferDone', { name: memberName(transferLandedOn) })}
      </p>}
      {risks.length > 0 && <section className={threadCss.riskSection} aria-label={t('runtimeRisk')}>
        <h2>{t('runtimeRisk')}</h2>
        {risks.map(({ claim, status, label, sentenceKey, reason, full }) => <p className={threadCss.riskRow} key={claim.claimRef}>
          <TeamPresenceDot status={status} t={t} />
          <span title={full}><strong className={threadCss.riskClass}>{label}</strong> · {t(sentenceKey, { member: status.member.handle })} — {reason}</span>
        </p>)}
      </section>}
      {task !== undefined && thread !== undefined && (() => {
        const activeClaims = projection?.claims.filter(claim => claim.taskRef === task.taskRef && claim.state === 'active') ?? []
        return <Modal
          open={confirmingAccept}
          onClose={() => { if (!pending) setConfirmingAccept(false) }}
          title={t('acceptEarlyTitle')}
          closeLabel={t('cancel')}
          footer={<>
            <Button variant="outline" disabled={pending} onClick={() => { setConfirmingAccept(false) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={pending} onClick={() => { void mutateTask('accept') }}>{mutating === 'accept' ? t('acceptingTask') : t('acceptTask')}</Button>
          </>}
        >
          <p className={css.confirmBody}>{t('acceptEarlyBody', { count: activeClaims.length })}</p>
          <ul className={css.confirmList}>
            {activeClaims.map(claim => (
              <li key={claim.claimRef}>{memberName(claim.owner)} · {claim.direction}</li>
            ))}
          </ul>
        </Modal>
      })()}
    </div>

    <section ref={timeline.ref} onScroll={handleTimelineScroll} className={css.timeline} aria-label={t('timelineLabel')}>
      <div className={css.timelineContent}>
        {loading && projection === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingThread')}</p></div>}
        {projection === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void readCurrent() }}>{t('retry')}</Button></div>}
        {olderFacts.length > 0 && <section className={threadCss.historySection} aria-label={t('olderHistory')}><h2>{t('olderHistory')}</h2>{renderFactBlocks(olderFacts, undefined, taskCards.filter(card => card.sequence < (currentFactsWithAnchor[0]?.sequence ?? Number.POSITIVE_INFINITY)))}</section>}
        {historyHasMore && <div className={css.timelineAction}><Button size="sm" onClick={() => { void loadOlder() }}>{t('loadOlder')}</Button></div>}
        {currentFactsWithAnchor.length > 0 && <section className={threadCss.publicSection}>
          {renderFactBlocks(currentFactsWithAnchor, unreadBoundary, taskCards.filter(card => card.sequence >= (currentFactsWithAnchor[0]?.sequence ?? 0)))}
        </section>}
        {autoReadExhausted && <div className={css.timelineAction} role="alert">
          <span>{t('autoReadIncomplete')}</span>
          <Button size="sm" onClick={() => { setAutoReadExhausted(false); void drainUnread() }} disabled={loading}>{t('retry')}</Button>
        </div>}
        {newFactsCount > 0 && <div className={threadCss.newUpdates} role="status">
          <button type="button" className={threadCss.newUpdatesJump} onClick={() => { setNewFactsCount(0); timeline.scrollToBottom() }}>{t('newUpdatesJump', { count: newFactsCount })}</button>
        </div>}
      </div>
    </section>

    {projection !== undefined && thread !== undefined ? (
      task?.resolution === 'closed'
        ? <div className={threadCss.closedBar} data-team-closed>
            {error !== undefined && <p className={css.error} role="alert">{error}</p>}
            <div className={threadCss.closedNotice}>
              <span>{t('taskClosedNotice')}</span>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => { void mutateTask('reopen') }}>{t('reopenTask')}</Button>
            </div>
          </div>
        : <TeamComposer
      key={draftKey}
      members={members}
      followerMemberIds={followerIds}
      projectPeerMemberIds={projectMemberIds}
      drafts={drafts}
      draftKey={draftKey}
      pending={pending}
      {...(error === undefined ? {} : { error })}
      onEdit={clearSendState}
      onSubmit={() => { void sendReply() }}
      placeholder={t('replyPlaceholder')}
      pendingFiles={pendingFiles}
      onFilesChange={setPendingFiles}
      {...(replyTarget === undefined ? {} : {
        replyTo: (() => {
          const target = cachedResolvedMessageRef(replyTarget)
          // The member id lets the author join the composer's "will notify" row; an unresolved parent cannot name one, and the Host still delivers.
          return target === undefined
            ? { senderName: t('memberUnknown'), excerpt: '' }
            : { memberId: target.sender, senderName: memberName(target.sender), excerpt: target.excerpt }
        })(),
        onCancelReply: () => { setReplyTarget(undefined) },
      })}
      t={t}
    />
    ) : <div />}
  </main>
}
