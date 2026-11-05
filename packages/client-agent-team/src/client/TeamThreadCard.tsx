import type { AgentTeamInboxActor, AgentTeamMainThreadCard, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import type { TeamConversationProps } from './slots.ts'
import { TeamAvatarStack, namedAvatarOwners, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamOwnerSeat } from './TeamOwnerSeat.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import { accountableLabel, claimersBeyond, claimersLabel, formatAbsoluteTime, formatInboxTime, formatTaskStatus, plainGist, taskStatusDot } from './team-formatters.ts'
import streamCss from './main-stream.module.css'

/**
 * One Thread as a card: the current state of the Thread at the place its anchor was written, rebuilt from the Host's
 * projection on every read. It is the door itself, so it carries no separate row.
 *
 * One component serves every face that shows this projection — the Project's Main stream, a taskless discussion's side
 * panel, and the discussion's own Thread page — because a Task's status, owners or reply count must not depend on which
 * surface the reader happened to open it from.
 */
export function TeamThreadCard({ card, unread, human, humanMemberId, accountableOwner, t, onOpen }: {
  readonly card: AgentTeamMainThreadCard
  readonly unread: boolean
  readonly human: TeamAvatarHuman | undefined
  readonly humanMemberId: AgentTeamMemberId | undefined
  /** The board's own person, resolved by the caller's roster: a Task's card names who holds it. */
  readonly accountableOwner: AgentTeamInboxActor | undefined
  readonly t: TeamConversationProps['t']
  readonly onOpen: () => void
}) {
  const task = card.task
  const title = plainGist(card.anchor.preview)
  const resolved = task?.status === 'done' || task?.status === 'closed'
  const owners = namedAvatarOwners(task?.liveClaimOwners ?? [], human)
  // Only a seat that was actually drawn stands for its person; an unresolved owner keeps their face in the group.
  const executors = claimersBeyond(owners, accountableOwner === undefined ? undefined : task?.accountable)
  const replies = t('cardReplies', { count: card.replyCount })
  const people = card.participants.length === 0 || task !== undefined ? undefined : t('cardParticipants', { count: card.participants.length })
  const label = [
    task === undefined ? t('openDiscussionCard', { title }) : t('openTaskCard', { number: task.taskNumber, title }),
    task === undefined ? undefined : formatTaskStatus(task.status, t),
    accountableOwner === undefined ? undefined : accountableLabel(accountableOwner, humanMemberId, t),
    task === undefined || resolved ? undefined : owners.length === 0 ? t('taskAwaitingClaim') : claimersLabel(owners, t),
    replies,
    people,
    unread ? t('cardUnread') : undefined,
  ].filter((part): part is string => part !== undefined).join(' · ')
  return <button
    type="button"
    className={streamCss.card}
    data-main-card={task === undefined ? 'discussion' : 'task'}
    {...(resolved ? { 'data-resolved': '' } : {})}
    aria-label={label}
    onClick={onOpen}
  >
    <span className={streamCss.cardHead}>
      <span className={streamCss.cardKind}>
        {task === undefined ? t('discussionLabel') : <>
          <TeamStateDot size={8} state={taskStatusDot(task.status)} />
          {t('taskLabel', { number: task.taskNumber })}
        </>}
      </span>
      {task !== undefined && <span className={streamCss.cardStatus}>{formatTaskStatus(task.status, t)}</span>}
      {accountableOwner !== undefined && <TeamOwnerSeat owner={accountableOwner} human={human} humanMemberId={humanMemberId} t={t} />}
      {task !== undefined && !resolved && owners.length === 0 && <span>{t('taskAwaitingClaim')}</span>}
      {task !== undefined && !resolved && executors.length > 0 && <span className={streamCss.cardExecutor}>
        <TeamAvatarStack owners={executors} label={claimersLabel(executors, t)} human={human} />
        <span>{t('taskClaimRole')}</span>
      </span>}
      <span className={streamCss.cardMeta}>
        <span>{replies}</span>
        {people !== undefined && <span>{people}</span>}
        <time dateTime={card.newestOccurredAt} title={formatAbsoluteTime(card.newestOccurredAt)}>{formatInboxTime(card.newestOccurredAt, t)}</time>
      </span>
    </span>
    <span className={streamCss.cardTitle}>{title}</span>
  </button>
}
