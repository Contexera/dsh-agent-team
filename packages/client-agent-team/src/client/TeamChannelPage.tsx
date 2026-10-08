import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamChannelRef, AgentTeamInbox, AgentTeamMemberId, AgentTeamSendMessageRequest, AgentTeamTask, AgentTeamView, AgentTeamViewItem,
  AgentTeamTaskRef, AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { mintRequestId, uploadComposerFiles } from './requests.ts'
import type { TeamDraftKey, TeamDraftStore } from './drafts.ts'
import { TeamComposer } from './TeamComposer.tsx'
import { TeamMemberRow } from './TeamMemberRow.tsx'
import { TeamMessage } from './TeamMessage.tsx'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman, type TeamAvatarOwner } from './TeamAvatarStack.tsx'
import { TeamCountBadge } from './TeamCountBadge.tsx'
import { TeamRunDivider } from './TeamRunDivider.tsx'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, formatTaskStatus, taskStatusDot, mentionNamesOf } from './team-formatters.ts'
import { TeamStateDot } from './TeamStateDot.tsx'
import { useChannelMembership } from './team-membership.ts'
import { useTimelineScroll } from './timeline-scroll.ts'
import { hostTaskRefLookup, jumpToTaskThread } from './refs.ts'
import { hostThreadRefLookup, jumpToThread } from './refs.ts'
import { rosterChannelName, rosterMember } from './refs.ts'
import { chunkRunsWithDays, isRunGap } from './team-separators.ts'
import channelCss from './channel.module.css'
import css from './conversation.module.css'
import threadCss from './thread.module.css'

interface TeamChannelPageProps {
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  /** The Human's own display name and avatar, from the shared identity projection. */
  readonly humanName: string
  readonly humanAvatarUrl?: string | undefined
  readonly loadChannels: TeamConversationProps['loadChannels']
  readonly subscribeChanges: TeamConversationProps['subscribeChanges']
  readonly loadMembers: TeamConversationProps['loadMembers']
  /** The Human's own unread per Thread: the Host's three-class judgement, never a Client guess. */
  readonly loadInbox: TeamConversationProps['loadInbox']
  readonly drafts: TeamDraftStore
  readonly getAttachment: TeamConversationProps['getAttachment']
  readonly putAttachment: TeamConversationProps['putAttachment']
  readonly sendMessage: TeamConversationProps['sendMessage']
  readonly joinChannel: TeamConversationProps['joinChannel']
  readonly removeChannelMember: TeamConversationProps['removeChannelMember']
  readonly selectThread: TeamConversationProps['selectThread']
  readonly selectChannel: TeamConversationProps['selectChannel']
  readonly resolveTaskRefs: TeamConversationProps['resolveTaskRefs']
  readonly resolveThreadRefs: TeamConversationProps['resolveThreadRefs']
  readonly openMemberSession: TeamConversationProps['openMemberSession']
  readonly backToChannels: TeamConversationProps['backToChannels']
  readonly t: TeamConversationProps['t']
}

/**
 * Merge the freshest top-level window over what the reader already has. The
 * fresh window is authoritative for every Message it covers — a change wake
 * must move that row's live Task state, newest instant, and unread with it —
 * while older Messages loaded earlier are retained instead of discarded.
 */
function mergeChannelView(current: AgentTeamView, fresh: AgentTeamView): AgentTeamView {
  const freshRefs = new Set(fresh.items.map(item => item.message.messageRef))
  const items = [...current.items.filter(item => !freshRefs.has(item.message.messageRef)), ...fresh.items]
    .sort((left, right) => left.message.sequence - right.message.sequence)
  return {
    ...fresh,
    items,
    cursor: Math.min(fresh.cursor, current.cursor),
    // Older retained items may precede even a saturated fresh window.
    hasMore: fresh.hasMore || current.cursor < fresh.cursor,
  }
}

/**
 * The newest fact instant, or nothing when the entry's own Message is still the
 * newest fact on its Thread. That difference is exactly what "has follow-up
 * activity" means, and the Host projects both instants from the ledger.
 */
function followUpAt(item: AgentTeamViewItem): string | undefined {
  const lastActivityAt: string | undefined = item.lastActivityAt
  return lastActivityAt === undefined || lastActivityAt === item.message.occurredAt ? undefined : lastActivityAt
}

/**
 * What the door prints about follow-up activity, or nothing. A resolved Task
 * stops printing it: the status word beside the door already says nothing is
 * moving, and the instant it would print is the moment it resolved — repeated
 * on every finished row. The precise instant stays on the control's title, one
 * hover away. A taskless Thread never resolves, so a discussion keeps the
 * recency that is the whole of its state line: it wears no status word, dot, or
 * owner stack.
 */
function printedActivityAt(item: AgentTeamViewItem): string | undefined {
  const status = item.task?.status
  return status === 'done' || status === 'closed' ? undefined : followUpAt(item)
}

/** Host unread per Thread, keyed for the feed's rows: zero unread is the absence of a badge, not a row. */
function unreadCounts(inbox: AgentTeamInbox): ReadonlyMap<AgentTeamThreadRef, number> {
  return new Map(inbox.items.filter(item => item.unreadCount > 0).map(item => [item.thread.threadRef, item.unreadCount]))
}

export function TeamChannelPage({ workspaceId, channelRef, humanName, humanAvatarUrl, loadChannels, subscribeChanges, loadMembers, loadInbox, drafts, putAttachment, getAttachment, sendMessage, joinChannel, removeChannelMember, selectThread, selectChannel, backToChannels, resolveTaskRefs, resolveThreadRefs, openMemberSession, t }: TeamChannelPageProps) {
  const [view, setView] = useState<AgentTeamView>()
  const [members, setMembers] = useState<readonly AgentTeamClientMemberStatus[]>([])
  const [unreadByThread, setUnreadByThread] = useState<ReadonlyMap<AgentTeamThreadRef, number>>(new Map())
  const [actionError, setError] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const error = actionError ?? loadError
  const [pendingFiles, setPendingFiles] = useState<readonly File[]>([])
  const [statusMessage, setStatusMessage] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [asTask, setAsTask] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [managingMembers, setManagingMembers] = useState(false)
  // The composer draft lives in the keyed draft cache: view switches unmount
  // this page, and a refresh must not cost the half-written message either.
  // The composer owns the subscription — this page only reads a snapshot when
  // it sends, so typing never re-renders the timeline.
  const draftKey: TeamDraftKey = `channel:${channelRef}`
  const manageTriggerRef = useRef<HTMLSpanElement>(null)
  const memberListRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(false)
  // Flips after the first successful timeline load; later change wakes
  // refresh in place instead of showing the loading surface again.
  const loadedRef = useRef(false)
  const refreshSequenceRef = useRef(0)
  const channelLastItem = view?.items[view.items.length - 1]
  // Branded-ref navigation for message bodies: channel refs hop directly,
  // task and thread refs resolve against this Channel's loaded timeline and
  // fall back to the Host resolver, which also accepts abbreviated spellings.
  // Unresolvable refs never become links (see TeamMessage), so this path only
  // fires for refs the Host already confirmed.
  const openRef = (ref: string): void => {
    if (ref.startsWith('channel:')) {
      if (ref !== channelRef) selectChannel(ref as AgentTeamChannelRef)
      return
    }
    if (ref.startsWith('thread:')) {
      const match = view?.items.find(item => item.thread.threadRef === ref)
      if (match !== undefined) {
        selectThread(match.thread.threadRef, channelRef, match.task?.taskRef, match.taskNumber)
        return
      }
      // Not in the loaded timeline (or cited by abbreviation): resolve through
      // the Host and jump to the Thread's home Channel.
      jumpToThread(resolveThreadRefs, workspaceId, ref as AgentTeamThreadRef, selectThread)
      return
    }
    if (ref.startsWith('task:')) {
      const match = view?.items.find(item => item.task?.taskRef === ref)
      if (match !== undefined) {
        selectThread(match.thread.threadRef, channelRef, match.task?.taskRef, match.taskNumber)
        return
      }
      // Not in the loaded timeline: resolve through the Host and jump to the
      // Task's home Channel.
      jumpToTaskThread(resolveTaskRefs, workspaceId, ref as AgentTeamTaskRef, selectThread)
    }
  }

  const lookupTaskRefs = hostTaskRefLookup(resolveTaskRefs, workspaceId)
  const lookupThreadRefs = hostThreadRefLookup(resolveThreadRefs, workspaceId)
  // Roster chips resolve synchronously from loaded data: channel names from
  // the loaded feed windows, member facts from the member list. Anything
  // outside stays plain text — the same rule unresolvable refs follow. The
  // lookups key on roster content, not array identity: every refresh hands
  // over fresh arrays, and the memoized rows must survive change bursts that
  // leave the roster itself untouched.
  const rosterKey = useMemo(() => [
    (view?.channels ?? []).map(channel => `${channel.channelRef}=${channel.name}=${channel.state}`).join(','),
    members.map(status => `${status.member.memberId}=${status.member.handle}=${status.member.sessionId}=${status.availability}`).join(','),
    view?.humanMemberId ?? '',
  ].join(';'), [view, members])
  const channelNameOf = useMemo(() => {
    const channels = view?.channels ?? []
    return (ref: AgentTeamChannelRef): string | undefined => rosterChannelName(channels, ref)
  }, [rosterKey])
  const memberOf = useMemo(() => {
    const humanMemberId = view?.humanMemberId
    return (ref: AgentTeamMemberId) => rosterMember(members, humanMemberId, humanName, ref)
  }, [rosterKey, humanName])
  // The Thread entry row's owner stack speaks the same grammar as the Inbox
  // row's, Human included: the Host names which actor is the reader, the
  // Client's identity projection says what that actor looks like.
  const humanMemberId = view?.humanMemberId
  const humanIdentity: TeamAvatarHuman | undefined = humanMemberId === undefined
    ? undefined
    : { memberId: humanMemberId, name: humanName, ...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl }) }

  const timeline = useTimelineScroll(`${view?.items.length ?? 0}:${channelLastItem?.message.messageRef ?? ''}`)
  const channel = view?.channels.find(item => item.channelRef === channelRef)
  const channelMemberIds = new Set(view?.members.filter(item => item.channelRef === channelRef).map(item => item.memberId) ?? [])
  const channelMembers = members.filter(status => channelMemberIds.has(status.member.memberId) && status.member.state !== 'inactive' && status.member.state !== 'archived')
  // Presence counts ride the header meta line; error and unavailable do not count as online.
  const onlineCount = channelMembers.filter(status => status.presence === 'available' || status.presence === 'working').length
  const messageSender = (item: AgentTeamViewItem): AgentTeamMemberId => item.message.sender
  const handleByMember = new Map(members.map(status => [status.member.memberId, status.member.handle.replace(/^@/, '')]))

  const refresh = async (clearError = false) => {
    if (!mountedRef.current) return false
    const sequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = sequence
    // Only the first refresh owns the loading surface; change wakes refresh
    // the rendered timeline in place instead of flashing it back to skeleton.
    if (!loadedRef.current) setLoading(true)
    if (clearError) {
      setLoadError(undefined)
      setStatusMessage(undefined)
    }
    try {
      const [loaded, loadedMembers, loadedInbox] = await Promise.all([
        loadChannels({ workspaceId, channelRef, direction: 'before', topLevelOnly: true, includeActivities: false, limit: 20 }),
        loadMembers({ workspaceId }),
        // The non-direct slice of the Host's own Inbox is the authority for
        // "what needs me on this Thread" — following activity, mentions, and my
        // Task/Claim changes alike. Nothing here re-derives unread from message
        // mentions.
        loadInbox({ workspaceId, limit: 100 }),
      ])
      if (!mountedRef.current || sequence !== refreshSequenceRef.current) return false
      if (loaded.ok) { setView(current => current === undefined ? loaded.value : mergeChannelView(current, loaded.value)); loadedRef.current = true } else setLoadError(loaded.error.message)
      if (loadedMembers.ok) setMembers(loadedMembers.value); else setLoadError(loadedMembers.error.message)
      // A failed unread read drops the badges instead of leaving counts the
      // reader can no longer trust; the failure surfaces like any other read.
      if (loadedInbox.ok) setUnreadByThread(unreadCounts(loadedInbox.value))
      else { setUnreadByThread(new Map()); setLoadError(loadedInbox.error.message) }
      if (loaded.ok && loadedMembers.ok && loadedInbox.ok) setLoadError(undefined)
      return loaded.ok && loadedMembers.ok && loadedInbox.ok
    } catch (cause) {
      if (mountedRef.current && sequence === refreshSequenceRef.current) setLoadError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      if (mountedRef.current && sequence === refreshSequenceRef.current) setLoading(false)
    }
  }

  // Presence and membership live in the workspace projection; they never need
  // the Channel timeline refetch that a full refresh performs.
  const refreshMembers = async () => {
    if (!mountedRef.current) return
    try {
      const loaded = await loadMembers({ workspaceId })
      if (!mountedRef.current) return
      if (loaded.ok) setMembers(loaded.value); else setLoadError(loaded.error.message)
    } catch (cause) {
      if (mountedRef.current) setLoadError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    mountedRef.current = true
    loadedRef.current = false
    setView(undefined)
    setLoadError(undefined)
    setLoading(true)
    setManagingMembers(false)
    void refresh()
    const disposers = [
      subscribeChanges({ kind: 'channel', channelRef }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setLoadError(update.message); return }
        void refresh()
      }),
      subscribeChanges({ kind: 'workspace', workspaceId }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setLoadError(update.message); return }
        void refreshMembers()
      }),
      // Presence transitions commit nothing: only the member rows move, so
      // the header presence counts refresh without a timeline refetch.
      subscribeChanges({ kind: 'presence', workspaceId }, update => {
        if (!mountedRef.current) return
        if (update.type === 'failed') { setLoadError(update.message); return }
        void refreshMembers()
      }),
    ]
    return () => {
      mountedRef.current = false
      refreshSequenceRef.current += 1
      for (const dispose of disposers) dispose()
    }
  }, [workspaceId, channelRef])

  useEffect(() => {
    if (!managingMembers) return
    queueMicrotask(() => { memberListRef.current?.querySelector('button')?.focus() })
  }, [managingMembers])

  const loadOlder = async () => {
    if (view === undefined || !view.hasMore || loadingOlder) return
    setLoadingOlder(true)
    try {
      const result = await loadChannels({ workspaceId, channelRef, direction: 'before', topLevelOnly: true, includeActivities: false, cursor: view.cursor, limit: 20 })
      if (!mountedRef.current) return
      if (!result.ok) { setError(result.error.message); return }
      setView(current => current === undefined ? result.value : mergeChannelView(current, result.value))
    } catch (cause) {
      if (mountedRef.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mountedRef.current) setLoadingOlder(false)
    }
  }

  const closeMembers = () => {
    setManagingMembers(false)
    queueMicrotask(() => { manageTriggerRef.current?.querySelector('button')?.focus() })
  }

  const membership = useChannelMembership(
    { joinChannel, removeChannelMember },
    change => change.memberId,
    async () => { await refresh() },
  )

  // Retained across transport failures so a replayed send dedupes on the Host;
  // definitive outcomes (committed or rejected) start the next send fresh.
  const pendingSendId = useRef<AgentTeamSendMessageRequest['requestId']>()

  // Editing the draft invalidates the one-shot status line. The setter returns
  // the same state when there is nothing to clear, so a keystroke does not
  // re-render the timeline now that the composer owns the draft.
  const clearSendState = useCallback((): void => {
    setStatusMessage(current => current === undefined ? current : undefined)
  }, [])

  const send = async () => {
    // Read the draft at send time: this page no longer subscribes to it, so a
    // captured render value would be stale after the composer's own edits.
    const { draft, recipients } = drafts.getSnapshot(draftKey)
    if (pending || draft.trim() === '') return
    const recipientIds = [...recipients].sort()
    const requestId = pendingSendId.current ?? mintRequestId()
    pendingSendId.current = requestId
    setPending(true); setError(undefined); setStatusMessage(undefined)
    try {
      // Upload chosen files first; any failure aborts the send with the
      // existing error surface and keeps the chips for a retry.
      const upload = await uploadComposerFiles(putAttachment, workspaceId, pendingFiles)
      if (!upload.ok) {
        pendingSendId.current = undefined
        setError(upload.error)
        return
      }
      const attachmentIds = upload.attachmentIds
      const request: AgentTeamSendMessageRequest = {
        requestId, workspaceId,
        channelRef, body: draft.trim(), recipients: recipientIds,
        asTask,
        ...(attachmentIds.length === 0 ? {} : { attachments: attachmentIds }),
      }
      const result = await sendMessage(request)
      if (!result.ok) {
        pendingSendId.current = undefined
        setError(result.error.message)
      } else if (result.value.kind === 'committed') {
        pendingSendId.current = undefined
        setAsTask(false)
        await refresh()
        drafts.clear(draftKey)
        setPendingFiles([])
        setStatusMessage(undefined)
      } else if (result.value.kind === 'confirmation_required') {
        // Same-requestId resend continues the pending operation.
        setStatusMessage(t('mentionConfirmation'))
      } else {
        // Rejections are final for this draft; editing it must mint a new operation.
        pendingSendId.current = undefined
        setError(t('memberNotFollowing', { ids: result.value.memberIds.map(memberId => `@${members.find(candidate => candidate.member.memberId === memberId)?.member.handle ?? memberId}`).join(', ') }))
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }

  return <main className={css.surface} data-team-channel={channelRef}>
    <div className={css.surfaceHeader}>
      <div className={css.backRow}><Button size="sm" icon={<IconChevronLeftOutlineRegular />} onClick={backToChannels}>{t('backToChannels')}</Button></div>
      <header className={css.headerRow}>
        <div className={css.headerCopy}>
          <h1>{channel === undefined ? '# …' : `# ${channel.name}`}</h1>
          {channel !== undefined && <p>{channel.description}</p>}
          {channel !== undefined && <div className={channelCss.headerMeta}>
            <span>{t('memberCount', { count: channelMembers.length })}</span>
            <span>{t('onlineCount', { count: onlineCount })}</span>
          </div>}
        </div>
        {channel !== undefined && <span ref={manageTriggerRef}><Button size="sm" variant="outline" aria-haspopup="dialog" onClick={() => { setManagingMembers(true) }}>{t('manageMembers')}</Button></span>}
      </header>
    </div>

    <Modal open={managingMembers} onClose={closeMembers} title={t('channelMembers')} {...(channel === undefined ? {} : { description: `# ${channel.name} · ${t('memberCount', { count: channelMembers.length })}` })} closeLabel={t('close')} contentClassName={channelCss.modalBody!}>
      <div ref={memberListRef} className={channelCss.memberList}>
        {members.filter(status => status.member.state !== 'inactive' && status.member.state !== 'archived').map(status => {
          const joined = channelMemberIds.has(status.member.memberId)
          const rowPending = membership.pending.has(status.member.memberId)
          // Joining needs an active Member — the Host refuses any other
          // availability. Leaving only needs the Membership fact, so removal
          // stays offered while a joined Member is down.
          const disabled = rowPending || (!joined && status.availability !== 'active')
          const rowError = membership.errors.get(status.member.memberId)
          return <TeamMemberRow
            key={status.member.memberId}
            status={status}
            action={{
              label: rowPending ? t('membershipUpdating') : joined ? t('removeFromChannel') : t('addToChannel'),
              disabled,
              onSelect: () => { void membership.change({ workspaceId, channelRef, memberId: status.member.memberId, joined }) },
            }}
            {...(rowError === undefined ? {} : { error: rowError })}
            t={t}
          />
        })}
      </div>
    </Modal>

    <section ref={timeline.ref} onScroll={timeline.onScroll} className={css.timeline} aria-label={t('timelineLabel')}>
      <div className={css.timelineContent}>
        {loading && channel === undefined && error === undefined && <div className={css.emptySurface}><p className={css.loadingState}><span className={css.loadingMark} aria-hidden="true" />{t('loadingChannels')}</p></div>}
        {!loading && channel === undefined && error === undefined && <div className={css.emptySurface}><p className={css.emptyState}>{t('emptyChannels')}</p></div>}
        {!loading && channel === undefined && error !== undefined && <div className={css.errorState} role="alert"><span>{error}</span><Button size="sm" variant="outline" onClick={() => { void refresh(true) }}>{t('retry')}</Button></div>}
        {view?.hasMore && <div className={css.timelineAction}><Button size="sm" disabled={loadingOlder} onClick={() => { void loadOlder() }}>{t('loadOlder')}</Button></div>}
        {channel !== undefined && view?.items.length === 0 && <div className={css.emptySurface}>
          <div className={css.emptyState}>
            <strong>{t('emptyMessages')}</strong>
            <span>{t('emptyMessagesHint')}</span>
          </div>
        </div>}
        {(view?.items.length ?? 0) > 0 && chunkRunsWithDays(view!.items, messageSender, item => item.message.occurredAt).map((block, blockIndex) => block.kind === 'day'
          ? <p className={threadCss.daySeparator} key={`day-${blockIndex}-${block.label}`}><span>{block.label}</span></p>
          : <div className={css.messageRun} key={`run-${block.items[0]!.message.messageRef}`}>
          {block.items.map((item, index) => {
            const senderStatus = members.find(member => member.member.memberId === item.message.sender)
            const human = item.message.sender === view!.humanMemberId
            const sender = human ? humanName : senderStatus?.member.handle ?? item.message.sender
            const turnGap = isRunGap(index > 0 ? block.items[index - 1]!.message.occurredAt : undefined, item.message.occurredAt)
            const task = item.task
            // The entry's own line is the gate under the body, and its state
            // leads that line: ownership, status, and unread answer the reader
            // where they are already reading. A reply inside a Thread has none
            // of it — the Thread page owns that surface.
            const unread = unreadByThread.get(item.thread.threadRef) ?? 0
            // A turn divider already labels the gapped entry; its row stays chrome-free.
            return <Fragment key={item.message.messageRef}>
              {turnGap && <TeamRunDivider occurredAt={item.message.occurredAt} />}
              <TeamMessage
                senderName={sender}
                memberId={item.message.sender}
                human={human}
                {...(humanAvatarUrl === undefined ? {} : { avatarUrl: humanAvatarUrl })}
                body={item.message.body}
                attachments={item.message.attachments}
                loadAttachment={getAttachment}
                t={t}
                occurredAt={item.message.occurredAt}
                mentionNames={mentionNamesOf(item.mentions, handleByMember, humanName)}
                onOpenRef={openRef}
                onResolveTaskRefs={lookupTaskRefs}
                onResolveThreadRefs={lookupThreadRefs}
                channelNameOf={channelNameOf}
                memberOf={memberOf}
                onOpenMemberSession={openMemberSession}
                grouped={index > 0}
                showGroupedTime={item.message.topLevel === true && !turnGap}
                {...(senderStatus === undefined ? {} : { senderTitle: senderStatus.member.description })}
              >
                {item.message.topLevel && <ThreadEntryRow
                  item={item}
                  owners={item.claimOwners}
                  unread={unread}
                  human={humanIdentity}
                  t={t}
                  onOpen={() => { selectThread(item.thread.threadRef, channelRef, task?.taskRef, item.taskNumber) }}
                />}
              </TeamMessage>
            </Fragment>
          })}
        </div>)}
      </div>
    </section>

    {channel !== undefined ? <TeamComposer
      key={draftKey}
      members={channelMembers}
      drafts={drafts}
      draftKey={draftKey}
      pending={pending}
      {...(statusMessage === undefined ? {} : { confirmation: statusMessage })}
      {...(error === undefined ? {} : { error })}
      onEdit={clearSendState}
      onSubmit={() => { void send() }}
      pendingFiles={pendingFiles}
      onFilesChange={setPendingFiles}
      asTask={asTask}
      onAsTaskChange={setAsTask}
      t={t}
    /> : <div />}
  </main>
}

/**
 * One entry's state: who is on the work, where it stands, and how much of it
 * needs the reader. It leads the entry's own line rather than trailing the
 * identity line, so a reader meets it where they are already reading instead of
 * crossing the column for it — and the same placement holds whether this
 * Message opened its run or continued one, where an identity line would have
 * carried nothing else. The unread capsule is the only member a taskless
 * discussion can carry: it needs no Task.
 */
function ThreadStateCluster({ task, owners, unread, human, t }: {
  readonly task: AgentTeamTask | undefined
  readonly owners: readonly TeamAvatarOwner[]
  readonly unread: number
  readonly human: TeamAvatarHuman | undefined
  readonly t: TeamConversationProps['t']
}) {
  if (task === undefined && unread === 0) return null
  const namedOwners = namedAvatarOwners(owners, human)
  return <span className={css.stateCluster}>
    {task !== undefined && <TeamAvatarStack owners={namedOwners} label={claimersLabel(namedOwners, t)} human={human} />}
    {task !== undefined && <TeamStateDot size={8} state={taskStatusDot(task.status)} />}
    {task !== undefined && <span className={css.statusWord}>{formatTaskStatus(task.status, t)}</span>}
    {/* The capsule is decoration inside the control whose label already carries
        the count, so the number is never pixels-only — the same shared capsule
        the Inbox entry and the Inbox queue's own rows wear. */}
    <TeamCountBadge count={unread} />
  </span>
}

/**
 * The gate under one top-level Message: the single row that opens its Thread,
 * and the one line that says what stands there. State leads it, then what the
 * entry is: a Task entry keeps its number so the status word never floats free
 * of the Task it describes, follow-up activity adds when the work last moved —
 * while the work is still unfinished — and an unanswered Thread says only 回复.
 * The instant uses the Inbox's own 今天/昨天 form with the precise local time on
 * the control's title, and an unread Thread says so in the control's label
 * rather than only in pixels.
 */
function ThreadEntryRow({ item, owners, unread, human, t, onOpen }: {
  readonly item: AgentTeamViewItem
  readonly owners: readonly TeamAvatarOwner[]
  readonly unread: number
  readonly human: TeamAvatarHuman | undefined
  readonly t: TeamConversationProps['t']
  readonly onOpen: () => void
}) {
  const taskNumber = item.taskNumber
  const followUp = followUpAt(item)
  const printedActivity = printedActivityAt(item)
  const label = taskNumber !== undefined
    ? t('taskLabel', { number: taskNumber })
    : followUp === undefined ? t('replyAction') : t('threadLabel')
  const text = printedActivity === undefined ? label : `${label} · ${t('recentActivity', { time: formatInboxTime(printedActivity, t) })}`
  const openLabel = taskNumber === undefined
    ? unread > 0 ? t('openThreadUnread', { count: unread }) : t('openThread')
    : unread > 0 ? t('openTaskUnread', { number: taskNumber, count: unread }) : t('openTask', { number: taskNumber })
  // The state is a label, not a control: it stays outside the button so the
  // owner stack keeps its own accessible name — a labeled button prunes its
  // descendants from the accessibility tree — and so the control's name says
  // exactly what clicking it does.
  return <span className={css.entryLine} data-thread-entry="">
    <ThreadStateCluster task={item.task} owners={owners} unread={unread} human={human} t={t} />
    <button
      type="button"
      className={css.entryRow}
      aria-label={openLabel}
      {...(followUp === undefined ? {} : { title: formatAbsoluteTime(followUp) })}
      onClick={onOpen}
    >
      <span>{text}</span>
      <span className={css.entryArrow} aria-hidden="true"><IconChevronRightOutlineRegular size={12} /></span>
    </button>
  </span>
}
