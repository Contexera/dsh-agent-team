import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentTeamClientMemberStatus } from '@contexera/dsh-agent-team/types'
import type { TeamSidebarProps } from './slots.ts'
import { TeamMemberAvatar } from './TeamMemberAvatar.tsx'
import css from './member-row.module.css'

export interface TeamMemberAction {
  readonly label: string
  readonly onSelect: () => void
  readonly disabled?: boolean
}

/**
 * The one place a Member's identity is drawn, so identity, tone and truncation cannot drift between surfaces. A fragment, not a
 * row: each surface owns its row element and grid and places this in the first two tracks. The handle spelling is the surface's call.
 */
export function TeamMemberIdentity({ status, name, className, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly name?: string | undefined
  readonly className?: string | undefined
  readonly t: TeamSidebarProps['t']
}) {
  return <>
    <TeamMemberAvatar status={status} t={t} />
    <span className={className === undefined ? css.copy : `${css.copy} ${className}`}>
      <strong>{name ?? `@${status.member.handle.replace(/^@/, '')}`}</strong>
      <small>{status.member.description}</small>
    </span>
  </>
}

/** The action is the row's only chrome; a row without one collapses the trailing track, handing its width to the description. */
export function TeamMemberRow({ status, action, error, className, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly action?: TeamMemberAction | undefined
  readonly error?: string | undefined
  readonly className?: string | undefined
  readonly t: TeamSidebarProps['t']
}) {
  return <div className={className === undefined ? css.row : `${css.row} ${className}`} data-team-member-row>
    <TeamMemberIdentity status={status} t={t} />
    {action !== undefined && <Button size="sm" variant="outline" className={css.action} disabled={action.disabled === true} onClick={action.onSelect}>{action.label}</Button>}
    {error !== undefined && <p className={css.error} role="alert">{error}</p>}
  </div>
}
