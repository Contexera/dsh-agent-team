import type { CSSProperties } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamClientMemberStatus } from '@contexera/dsh-agent-team/types'
import type { TeamSidebarProps } from './slots.ts'
import { identityInitial, memberHue } from './team-formatters.ts'
import { presenceDotState, presenceLabel } from './TeamPresenceDot.tsx'
import { TeamStateDot } from './TeamStateDot.tsx'
import css from './sidebar.module.css'

export function TeamMemberAvatar({ status, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly t: TeamSidebarProps['t']
}) {
  const label = presenceLabel(status, t)
  const state = presenceDotState(status.presence)
  return (
    <Tooltip label={label} delayMs={300}>
      <span
        className={css.agentAvatar}
        style={{ '--team-avatar-hue': memberHue(status.member.memberId) } as CSSProperties}
        role="img"
        aria-label={label}
      >
        {identityInitial(status.member.handle)}
        <span className={css.agentAvatarBadge} aria-hidden="true">
          <TeamStateDot state={state} />
        </span>
      </span>
    </Tooltip>
  )
}
