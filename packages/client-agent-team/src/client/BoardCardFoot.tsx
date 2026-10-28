import type { AgentTeamMemberId, AgentTeamTaskBoardItem } from '@contexera/dsh-agent-team/types'
import type { TeamConversationProps } from './slots.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { claimersLabel, formatAbsoluteTime, formatInboxTime } from './team-formatters.ts'
import css from './project.module.css'

/**
 * The one foot every Task card wears: who owns the outcome (text), who is executing it (avatars), and when.
 *
 * The two roles take two shapes because their counts differ: the accountable is always one person whose name has to be
 * read, so it stays text; executors are 0–N people read at a glance, so they are the avatar stack. Once the Task is
 * resolved nobody is executing it, so the executor slot is dropped rather than replaced with an "unassigned" word.
 */
export function BoardCardFoot({ item, human, humanMemberId, t }: {
  readonly item: AgentTeamTaskBoardItem
  readonly human: TeamAvatarHuman | undefined
  readonly humanMemberId: AgentTeamMemberId | undefined
  readonly t: TeamConversationProps['t']
}) {
  const task = item.task
  const resolved = task.status === 'done' || task.status === 'closed'
  const ownerLabel = item.accountableOwner?.state === 'suspended'
    ? t('boardAccountableSuspended')
    : task.accountable === humanMemberId ? t('boardAccountableYou') : t('boardAccountable', { name: item.accountableOwner?.name ?? task.accountable })
  const executors = namedAvatarOwners(item.liveClaimOwners, human)
  return <span className={css.boardCardFoot}>
    <span className={css.boardCardOwner}>{ownerLabel}</span>
    {!resolved && (executors.length === 0
      ? <span className={css.boardCardOwner}>{t('boardAwaitingClaim')}</span>
      : <span className={css.boardCardExecutor}>
        <span className={css.boardCardRole}>{t('boardExecutorRole')}</span>
        <TeamAvatarStack owners={executors} label={claimersLabel(executors, t)} human={human} />
      </span>)}
    <time dateTime={item.lastActivityAt} title={formatAbsoluteTime(item.lastActivityAt)}>{formatInboxTime(item.lastActivityAt, t)}</time>
  </span>
}
