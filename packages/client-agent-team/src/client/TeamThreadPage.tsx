import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  AgentTeamClientMemberStatus,
  AgentTeamThreadTaskCard,
  AgentTeamProjectRef,
  AgentTeamMemberId,
  AgentTeamMessageRef,
  AgentTeamTaskRef,
  AgentTeamThreadFact,
  AgentTeamThreadReadFact,
  AgentTeamThreadRef,
  AgentTeamView,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconChevronLeftOutlineRegular, Menu, Modal, Pill, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import type { TeamDraftStore } from './drafts.ts'
import { TeamComposer } from './TeamComposer.tsx'
import { diagnosticText, TeamPresenceDot } from './TeamPresenceDot.tsx'
import { TeamMessage } from './TeamMessage.tsx'
import { firstSentence, formatActivity, formatRiskClass, formatTaskStatus, formatTaskTitle, taskStatusDot } from './team-formatters.ts'
import { TeamStateDot } from './TeamStateDot.tsx'
import { TeamThreadCard } from './TeamThreadCard.tsx'
import type { TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { daySeparatorLabel, localDateKey } from './team-separators.ts'
import { useTaskTransfer, useThreadFollow } from './thread-actions.ts'
import { useTeamThreadController } from './thread-controller.ts'
import { cachedResolvedMessageRef, useResolvedMessageRefVersion } from './refs.ts'
import { factKey, firstUnreadMention, mergeFacts, messageFact, stableMentionNames, type ThreadFactKey } from './thread-facts.ts'
import { hostTaskRefLookup, jumpToTaskThread } from './refs.ts'
import { hostThreadRefLookup, jumpToThread, resolvedThreadDestination } from './refs.ts'
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
  readonly selectDiscussion: TeamConversationProps['selectDiscussion']
  readonly resolveTaskRefs: TeamConversationProps['resolveTaskRefs']
  readonly resolveThreadRefs: TeamConversationProps['resolveThreadRefs']
  readonly resolveMessageRefs: TeamConversationProps['resolveMessageRefs']
  readonly openMemberSession: TeamConversationProps['openMemberSession']
  readonly t: TeamConversationProps['t']
}

function readMeta(facts: readonly AgentTeamThreadReadFact[]): ReadonlyMap<ThreadFactKey, AgentTeamThreadReadFact> {
  return new Map(facts.map(fact => [factKey(fact.fact), fact]))
}

export function TeamThreadPage(props: TeamThreadPageProps) {
  const {
    workspaceId, humanName, humanAvatarUrl, projectRef, taskRef, threadRef, taskNumber, backToWorkspace, selectProject, selectThread, selectDiscussion, resolveTaskRefs, resolveThreadRefs, openMemberSession, putAttachment,
    loadProjects, readThread, loadThreadHistory, threadObservations,
    subscribeChanges, loadMembers, drafts, getAttachment, reply, changeAttention, transferTask, changeTask, promoteThread, resolveMessageRefs, t,
  } = props
  const threadRequest = { threadRef, ...(taskRef === undefined ? {} : { taskRef }) }
  const [projectView, setProjectView] = useState<AgentTeamView>()
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  // Early acceptance: the Human may accept while Claims are still open; the
  // confirm dialog lists exactly what will be completed with the Task.
  const [confirmingAccept, setConfirmingAccept] = useState(false)
  const [openCard, setOpenCard] = useState<AgentTeamMessageRef>()
  // Label source for the promote/accept buttons only: a reply send also raises
  // the shared `pending` gate, and must not retitle those buttons.
  const [mutating, setMutating] = useState<'promote' | 'accept' | undefined>()
  const [transferMenuOpen, setTransferMenuOpen] = useState(false)
  const mountedRef = useRef(false)
  const supplementalRef = useRef<Promise<void>>()
  const supplementalPendingRef = useRef(false)

  const memberName = (memberId: AgentTeamMemberId): string => {
    if (memberId === projectView?.humanMemberId) return humanName
    const status = members.find(candidate => candidate.member.memberId === memberId)
    return status === undefined ? t('memberUnknown') : `@${status.member.handle}`
  }

  const controller = useTeamThreadController({
    workspaceId, threadRef, ...(taskRef === undefined ? {} : { taskRef }), readThread, loadThreadHistory, threadObservations, subscribeChanges,
    resolveMessageRefs, reply, drafts, putAttachment,
    projectMembers: () => projectMembers,
    memberName, t,
    openingTarget: facts => firstUnreadMention(facts, humanName),
    afterWrite: () => refreshSupplemental(),
  })

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
      if (failure !== undefined && !failure.ok) controller.reportError(failure.error.message)
      return true
    } catch (cause) {
      if (mountedRef.current) controller.reportError(cause instanceof Error ? cause.message : String(cause))
      return mountedRef.current
    }
  }

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
      if (loaded.ok) setMembers(loaded.value); else controller.reportError(loaded.error.message)
    } catch (cause) {
      if (mountedRef.current) controller.reportError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const {
    projection: activeProjection, task, thread,
    currentFacts, readFacts, olderFacts, taskCards, followerIds, historyHasMore, loading, error, pending,
    autoReadExhausted, newFactsCount, replyTarget, replyTo, pendingFiles, draftKey, flashedMessage, timelineRef,
    readCurrent, loadOlder, refreshAfterFence, refreshPassiveFacts, retryAutoRead, onTimelineScroll, jumpToNewest,
    flashMessage, setReplyTarget, setPendingFiles, clearSendState, sendReply, commit, applyTaskCommit,
  } = controller

  useEffect(() => {
    if (confirmingAccept && task?.resolution === 'accepted') setConfirmingAccept(false)
  }, [confirmingAccept, task?.resolution])

  useEffect(() => {
    mountedRef.current = true
    supplementalRef.current = undefined
    supplementalPendingRef.current = false
    setProjectView(undefined)
    setMembers([])
    setOpenCard(undefined)
    void refreshSupplemental()
    const disposers = [
      subscribeChanges({ kind: 'workspace', workspaceId }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { controller.reportError(update.message); return }
        void refreshSupplemental()
      }),
      // Presence commits nothing: refresh the roster alone; the project view is reserved for workspace membership changes.
      subscribeChanges({ kind: 'presence', workspaceId }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { controller.reportError(update.message); return }
        void refreshMembers()
      }),
    ]
    return () => {
      mountedRef.current = false
      for (const dispose of disposers) dispose()
    }
  }, [workspaceId, taskRef, threadRef])

  const resolvedTaskNumber = taskNumber ?? projectView?.taskNumbers.find(entry => entry.taskRef === task?.taskRef)?.taskNumber
  const taskTitle = activeProjection === undefined ? undefined : formatTaskTitle(activeProjection.anchor.body)
  const taskClaims = activeProjection?.claims ?? []
  const effectiveProjectRef = task?.projectRef ?? projectRef
  const projectMemberIds = useMemo(() => new Set(projectView?.members.filter(item => item.projectRef === effectiveProjectRef).map(item => item.memberId) ?? []), [projectView, effectiveProjectRef])
  const projectMembers = members.filter(status => projectMemberIds.size === 0 || projectMemberIds.has(status.member.memberId))
  const mentionHandlesMap = useMemo(() => new Map(members.map(status => [status.member.memberId, status.member.handle.replace(/^@/, '')])), [members])
  const humanIdentity: TeamAvatarHuman | undefined = projectView?.humanMemberId === undefined
    ? undefined
    : { memberId: projectView.humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) }
  const metadata = useMemo(() => readMeta(readFacts), [readFacts])
  const unreadIndex = useMemo(() => {
    const all = mergeFacts(
      ...(activeProjection === undefined ? [] : [[messageFact(activeProjection.anchor, activeProjection.anchorMentions)]]),
      readFacts.map(fact => fact.fact),
      currentFacts,
    )
    return all.findIndex(fact => metadata.get(factKey(fact))?.unread === true)
  }, [activeProjection?.anchor, readFacts, currentFacts, metadata])

  const messageSender = (fact: AgentTeamThreadFact): AgentTeamMemberId | undefined =>
    fact.kind === 'message' ? fact.message.sender : undefined

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

  // Identity-stable: `openRef` feeds every row's props, so a fresh destination per render would re-render the timeline.
  const openThreadRef = useMemo(() => resolvedThreadDestination(selectThread, next => {
    // A discussion is a face of its own Project; a cross-Project ref moves the seat with it.
    if (projectRef === undefined) selectThread(next, task?.projectRef)
    else selectDiscussion(next, projectRef)
  }), [selectThread, selectDiscussion, projectRef, task?.projectRef])

  // Unresolvable refs never become links (see TeamMessage), so only Host-confirmed refs reach here. Identity-stable: a fresh
  // closure per render would defeat TeamMessage's memo.
  const openRef = useCallback((ref: string): void => {
    if (ref.startsWith('project:') && ref !== projectRef) {
      selectProject(ref as AgentTeamProjectRef)
      return
    }
    if (ref.startsWith('thread:') && ref !== threadRef) {
      jumpToThread(resolveThreadRefs, workspaceId, ref as AgentTeamThreadRef, openThreadRef)
      return
    }
    if (ref.startsWith('task:') && ref !== taskRef) {
      jumpToTaskThread(resolveTaskRefs, workspaceId, ref as AgentTeamTaskRef, selectThread)
    }
  }, [projectRef, threadRef, taskRef, workspaceId, selectProject, openThreadRef, resolveTaskRefs, resolveThreadRefs])

  const lookupTaskRefs = useMemo(() => hostTaskRefLookup(resolveTaskRefs, workspaceId), [resolveTaskRefs, workspaceId])
  const lookupThreadRefs = useMemo(() => hostThreadRefLookup(resolveThreadRefs, workspaceId), [resolveThreadRefs, workspaceId])

  const jumpToMessage = useCallback((messageRef: AgentTeamMessageRef): void => {
    const node = document.querySelector(`[data-message-ref="${messageRef}"]`)
    if (node === null) return
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    flashMessage(messageRef)
  }, [flashMessage])
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

  const messageRefVersion = useResolvedMessageRefVersion()
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

  /**
   * One derived Task card: the discussion's own projection of work it spawned, jumping to the Task Thread. It renders the
   * same component the Main stream and the side panel use, so the three faces cannot describe one Task differently.
   */
  const renderTaskCard = (entry: AgentTeamThreadTaskCard): ReactNode => {
    const task = entry.card.task
    return <TeamThreadCard
      key={`task-card-${task.taskRef}`}
      card={entry.card}
      unread={false}
      human={humanIdentity}
      t={t}
      onOpen={() => selectThread(entry.card.threadRef, projectRef, task.taskRef, task.taskNumber)}
    />
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
  // The page hands in the same follower set it refreshes for the composer, so a change another face or
  // another client makes reaches the control: the set is re-read on every subscription tick, not only on
  // the mount read that seeded it.
  const follow = useThreadFollow(changeAttention, threadObservations, { workspaceId, ...threadRequest }, followerIds, projectView?.humanMemberId)
  const transfer = useTaskTransfer(transferTask, {
    workspaceId,
    taskRef: task?.taskRef as AgentTeamTaskRef,
    revisionOf: () => thread?.revision,
    onCommitted: async (committed) => {
      setTransferMenuOpen(false)
      await applyTaskCommit(committed)
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

  const convertToTask = async (): Promise<void> => {
    if (pending || thread === undefined || task !== undefined) return
    setMutating('promote')
    try {
      await commit({
        key: 'promote',
        write: requestId => promoteThread({ requestId, workspaceId, threadRef, baseRevision: thread.revision }),
        onCommitted: async committed => { await applyTaskCommit(committed) },
      })
    } finally {
      setMutating(undefined)
    }
  }

  const mutateTask = async (action: 'accept' | 'close' | 'reopen'): Promise<void> => {
    if (pending || task === undefined || thread === undefined) return
    if (action === 'accept') setMutating('accept')
    try {
      await commit({
        key: `task:${action}`,
        write: requestId => changeTask({ requestId, workspaceId, taskRef: task.taskRef, action, baseRevision: thread.revision }),
        onCommitted: async committed => { await applyTaskCommit(committed) },
      })
    } finally {
      setMutating(undefined)
    }
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
  const activeClaimCount = activeProjection?.claims.filter(claim => claim.taskRef === task?.taskRef && claim.state === 'active').length ?? 0
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
        const activeClaims = activeProjection?.claims.filter(claim => claim.taskRef === task.taskRef && claim.state === 'active') ?? []
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

    <section ref={timelineRef} onScroll={onTimelineScroll} className={css.timeline} aria-label={t('timelineLabel')}>
      <div className={css.timelineContent}>
        {loading && activeProjection === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingThread')}</p></div>}
        {activeProjection === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void readCurrent() }}>{t('retry')}</Button></div>}
        {olderFacts.length > 0 && <section className={threadCss.historySection} aria-label={t('olderHistory')}><h2>{t('olderHistory')}</h2>{renderFactBlocks(olderFacts, undefined, taskCards.filter(card => card.sequence < (currentFactsWithAnchor[0]?.sequence ?? Number.POSITIVE_INFINITY)))}</section>}
        {historyHasMore && <div className={css.timelineAction}><Button size="sm" onClick={() => { void loadOlder() }}>{t('loadOlder')}</Button></div>}
        {currentFactsWithAnchor.length > 0 && <section className={threadCss.publicSection}>
          {renderFactBlocks(currentFactsWithAnchor, unreadBoundary, taskCards.filter(card => card.sequence >= (currentFactsWithAnchor[0]?.sequence ?? 0)))}
        </section>}
        {autoReadExhausted && <div className={css.timelineAction} role="alert">
          <span>{t('autoReadIncomplete')}</span>
          <Button size="sm" onClick={retryAutoRead} disabled={loading}>{t('retry')}</Button>
        </div>}
        {newFactsCount > 0 && <div className={threadCss.newUpdates} role="status">
          <button type="button" className={threadCss.newUpdatesJump} onClick={jumpToNewest}>{t('newUpdatesJump', { count: newFactsCount })}</button>
        </div>}
      </div>
    </section>

    {activeProjection !== undefined && thread !== undefined ? (
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
      {...(replyTo === undefined ? {} : {
        replyTo,
        onCancelReply: () => { setReplyTarget(undefined) },
      })}
      t={t}
    />
    ) : <div />}
  </main>
}
