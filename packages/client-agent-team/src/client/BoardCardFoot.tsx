import type { AgentTeamMemberId, AgentTeamTaskBoardItem } from '@contexera/dsh-agent-team/types'
import type { TeamConversationProps } from './slots.ts'
import { namedAvatarOwners, TeamAvatarStack, type TeamAvatarHuman } from './TeamAvatarStack.tsx'
import { TeamOwnerSeat } from './TeamOwnerSeat.tsx'
import { claimersBeyond, claimersLabel, formatAbsoluteTime, formatInboxTime } from './team-formatters.ts'
import css from './project.module.css'

/**
 * The one foot every Task card wears: who owns the outcome, who is executing it, and when.
 *
 * The two roles take two shapes because their counts differ: the accountable is exactly one person, drawn as the
 * `TeamOwnerSeat` every other face draws them with; executors are 0–N people read at a glance, so they are the avatar
 * stack under their own caption — the claimants other than the accountable, who is already drawn at the seat. Once the
 * Task is resolved nobody is executing it, so the executor slot is dropped rather than replaced with an "unassigned" word.
 */
export function BoardCardFoot({ item, human, humanMemberId, t }: {
  readonly item: AgentTeamTaskBoardItem
  readonly human: TeamAvatarHuman | undefined
  readonly humanMemberId: AgentTeamMemberId | undefined
  readonly t: TeamConversationProps['t']
}) {
  const task = item.task
  const resolved = task.status === 'done' || task.status === 'closed'
  const claimers = namedAvatarOwners(item.liveClaimOwners, human)
  const executors = claimersBeyond(claimers, task.accountable)
  return <span className={css.boardCardFoot}>
    <TeamOwnerSeat owner={item.accountableOwner} human={human} humanMemberId={humanMemberId} t={t} />
    {!resolved && (claimers.length === 0
      ? <span className={css.boardCardAwaiting}>{t('taskAwaitingClaim')}</span>
      : executors.length > 0 && <span className={css.boardCardExecutor}>
        <TeamAvatarStack owners={executors} label={claimersLabel(executors, t)} human={human} />
        <span className={css.boardCardRole}>{t('taskClaimRole')}</span>
      </span>)}
    <time dateTime={item.lastActivityAt} title={formatAbsoluteTime(item.lastActivityAt)}>{formatInboxTime(item.lastActivityAt, t)}</time>
  </span>
}
