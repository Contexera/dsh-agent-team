import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamClientMemberStatus } from '@contexera/dsh-agent-team/types'
import type { TeamSidebarProps } from './slots.ts'
import { TeamStateDot } from './TeamStateDot.tsx'
import type { TeamStateDotState } from './TeamStateDot.tsx'
import css from './presence.module.css'

export function presenceLabel(status: AgentTeamClientMemberStatus, t: TeamSidebarProps['t']): string {
  const label = status.presence === 'available' ? t('statusAvailable')
    : status.presence === 'working' ? t('statusWorking')
      : status.presence === 'error' ? t('statusError') : t('statusUnavailable')
  return status.diagnostic === undefined ? label : `${label}: ${diagnosticText(status)}`
}

/** One line of human-readable diagnostic text: the reason, plus the refused artifact path when one was reported. */
export function diagnosticText(status: Pick<AgentTeamClientMemberStatus, 'diagnostic'>): string {
  const diagnostic = status.diagnostic
  if (diagnostic === undefined) return ''
  return diagnostic.location === undefined ? diagnostic.detail : `${diagnostic.detail} (${diagnostic.location.path})`
}

/**
 * Whether the restart action can help an unavailable Member: it heals
 * transient and repairable failures, but not a transient rollover window
 * (which resolves on its own).
 */
export function restartOffered(status: AgentTeamClientMemberStatus): boolean {
  return status.diagnostic?.class !== 'rollover'
}

/** Shared presence → indicator mapping for dots and avatar badges. */
export function presenceDotState(presence: AgentTeamClientMemberStatus['presence']): TeamStateDotState {
  return presence === 'available' ? 'done' : presence === 'working' ? 'ongoing' : presence === 'error' ? 'error' : 'quiet'
}

export function TeamPresenceDot({ status, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly t: TeamSidebarProps['t']
}) {
  const label = presenceLabel(status, t)
  return (
    <Tooltip label={label} delayMs={300}>
      <span className={css.target} role="img" aria-label={label}>
        <TeamStateDot state={presenceDotState(status.presence)} />
      </span>
    </Tooltip>
  )
}
