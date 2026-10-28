import type { AgentTeamMainThreadCard } from '@contexera/dsh-agent-team/types'
import type { TeamConversationProps } from './slots.ts'
import { TeamAvatarStack, namedAvatarOwners, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import { claimersLabel, formatAbsoluteTime, formatInboxTime, formatTaskStatus, formatTaskTitle, taskStatusDot } from './team-formatters.ts'
import streamCss from './main-stream.module.css'

/**
 * One Thread as a card: the current state of the Thread at the place its anchor was written, rebuilt from the Host's
 * projection on every read. It is the door itself, so it carries no separate row.
 *
 * One component serves every face that shows this projection — the Project's Main stream, a taskless discussion's side
 * panel, and the discussion's own Thread page — because a Task's status, owners or reply count must not depend on which
 * surface the reader happened to open it from.
 */
export function TeamThreadCard({ card, unread, human, t, onOpen }: {
  readonly card: AgentTeamMainThreadCard
  readonly unread: boolean
  readonly human: TeamAvatarHuman | undefined
  readonly t: TeamConversationProps['t']
  readonly onOpen: () => void
}) {
  const task = card.task
  const title = formatTaskTitle(card.anchor.preview)
  const resolved = task?.status === 'done' || task?.status === 'closed'
  const owners = namedAvatarOwners(task?.liveClaimOwners ?? [], human)
  const replies = t('cardReplies', { count: card.replyCount })
  const people = card.participants.length === 0 || task !== undefined ? undefined : t('cardParticipants', { count: card.participants.length })
  const label = [
    task === undefined ? t('openDiscussionCard', { title }) : t('openTaskCard', { number: task.taskNumber, title }),
    task === undefined ? undefined : formatTaskStatus(task.status, t),
    task === undefined || resolved ? undefined : owners.length === 0 ? t('boardAwaitingClaim') : claimersLabel(owners, t),
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
      {task !== undefined && !resolved && owners.length === 0 && <span>{t('boardAwaitingClaim')}</span>}
      {task !== undefined && !resolved && owners.length > 0 && <TeamAvatarStack owners={owners} label={claimersLabel(owners, t)} human={human} />}
      <span className={streamCss.cardMeta}>
        <span>{replies}</span>
        {people !== undefined && <span>{people}</span>}
        <time dateTime={card.newestOccurredAt} title={formatAbsoluteTime(card.newestOccurredAt)}>{formatInboxTime(card.newestOccurredAt, t)}</time>
      </span>
    </span>
    <span className={streamCss.cardTitle}>{title}</span>
  </button>
}
