import { useState, type CSSProperties } from 'react'
import { IconQuestionOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamClientMemberStatus,
  AgentTeamMemberId,
  AgentTeamProject,
  AgentTeamProjectOwnerRequest,
  AgentTeamProjectOwnerResult,
} from '@contexera/dsh-agent-team/types'
import type { TeamSidebarProps } from './slots.ts'
import { TeamMemberRow } from './TeamMemberRow.tsx'
import { HUMAN_MEMBER_ID, memberHue } from './team-formatters.ts'
import { useAvatarImage } from './avatar-image.ts'
import { mintRequestId } from './requests.ts'
import { useHumanIdentity } from './human-identity.ts'
import createCss from './create.module.css'
import rowCss from './member-row.module.css'
import sidebarCss from './sidebar.module.css'

type OwnerWrite = (request: AgentTeamProjectOwnerRequest) => Promise<RemoteResult<AgentTeamProjectOwnerResult>>

/** The Human owns every Project and is fixed; Agent owners are written through the Host and appear only after the projection refresh. */
export function TeamProjectOwners({ project, members, ownerIds, addProjectOwner, removeProjectOwner, humanIdentity, onCommitted, t }: {
  readonly project: AgentTeamProject
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly ownerIds: ReadonlySet<AgentTeamMemberId>
  readonly addProjectOwner: OwnerWrite
  readonly removeProjectOwner: OwnerWrite
  readonly humanIdentity: TeamSidebarProps['humanIdentity']
  readonly onCommitted: () => Promise<void> | void
  readonly t: TeamSidebarProps['t']
}) {
  const identity = useHumanIdentity(humanIdentity)
  const humanName = identity.name ?? t('human')
  const humanImage = useAvatarImage(identity.avatarUrl)
  const [pending, setPending] = useState<AgentTeamMemberId>()
  const [error, setError] = useState<string>()
  const owners = members.filter(status => ownerIds.has(status.member.memberId))
  const eligible = members.filter(status => !ownerIds.has(status.member.memberId)
    && (status.member.state === 'enabled' || status.member.state === 'suspended')
    && status.workspaceIds.includes(project.workspaceId))

  const write = async (write: OwnerWrite, status: AgentTeamClientMemberStatus): Promise<void> => {
    if (pending !== undefined) return
    setPending(status.member.memberId)
    setError(undefined)
    try {
      const result = await write({
        requestId: mintRequestId(),
        workspaceId: project.workspaceId,
        projectRef: project.projectRef,
        memberId: status.member.memberId,
      })
      if (result.ok) await onCommitted()
      else setError(result.error.message)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(undefined)
    }
  }
  const action = (kind: 'Add' | 'Remove', status: AgentTeamClientMemberStatus) => {
    const handle = status.member.handle.replace(/^@/, '')
    return {
      label: pending === status.member.memberId ? t('projectOwnerPending') : t(`projectOwner${kind}`),
      ariaLabel: t(`projectOwner${kind}Label`, { handle }),
      disabled: pending !== undefined,
      onSelect: () => { void write(kind === 'Add' ? addProjectOwner : removeProjectOwner, status) },
    }
  }

  return (
    <div className={createCss.ownersSection} role="group" aria-label={t('projectOwners')} data-team-project-owners>
      <span className={createCss.sectionLabel}>
        {t('projectOwners')}
        <Tooltip label={t('projectOwnerHelp')} side="right" delayMs={200} portal maxWidth={280}>
          <button type="button" className={createCss.sectionHint} aria-label={t('projectOwnerHelpLabel')}>
            <IconQuestionOutlineRegular size={12} />
          </button>
        </Tooltip>
      </span>
      <div className={createCss.roster}>
        <div className={rowCss.row} data-team-project-owner-human>
          {/* Same seat as the Agent rows' avatar, so the fixed Human row lines up with them. */}
          <span className={sidebarCss.agentAvatar} style={{ '--team-avatar-hue': memberHue(HUMAN_MEMBER_ID), overflow: 'hidden' } as CSSProperties} aria-hidden="true">
            {humanImage.image.kind === 'image'
              ? <img src={humanImage.image.src} alt="" width={34} height={34} onError={humanImage.failed} />
              : humanName.slice(0, 1).toUpperCase()}
          </span>
          <span className={rowCss.copy}>
            <strong>{humanName}</strong>
            <small>{t('projectOwnerHumanHint')}</small>
          </span>
        </div>
        {owners.map(status => <TeamMemberRow key={status.member.memberId} status={status} t={t} action={action('Remove', status)} />)}
      </div>
      <span className={createCss.sectionLabel}>{t('projectOwnersAddable')}</span>
      {eligible.length === 0
        ? <p className={createCss.state}>{t('projectOwnersNoneEligible')}</p>
        : <div className={createCss.roster}>
          {eligible.map(status => <TeamMemberRow key={status.member.memberId} status={status} t={t} action={action('Add', status)} />)}
        </div>}
      {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
    </div>
  )
}
