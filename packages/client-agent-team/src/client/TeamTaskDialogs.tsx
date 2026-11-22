import type { CSSProperties } from 'react'
import type { AgentTeamClaim, AgentTeamClientMemberStatus, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import { TeamMemberIdentity } from './TeamMemberRow.tsx'
import { useAvatarImage } from './avatar-image.ts'
import { HUMAN_MEMBER_ID, identityInitial, memberHue } from './team-formatters.ts'
import css from './conversation.module.css'
import rowCss from './member-row.module.css'
import sidebarCss from './sidebar.module.css'

// Choosing a candidate must not dismiss the dialog: the page keeps the current accountable until the Host commits.
export function TeamTaskTransferDialog({ open, pending, accountableName, members, human, humanName, humanAvatarUrl, memberName, humanMemberId, failure, onClose, onTransfer, t }: {
  readonly open: boolean
  readonly pending: boolean
  readonly accountableName: string
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly human: boolean
  readonly humanName: string
  readonly humanAvatarUrl: string | undefined
  readonly memberName: (memberId: AgentTeamMemberId) => string
  readonly humanMemberId: AgentTeamMemberId | undefined
  readonly failure: string | undefined
  readonly onClose: () => void
  readonly onTransfer: (memberId: AgentTeamMemberId) => void
  readonly t: TeamConversationProps['t']
}) {
  const humanImage = useAvatarImage(humanAvatarUrl)
  return <Modal
    open={open}
    onClose={() => { if (!pending) onClose() }}
    title={t('transferTitle')}
    description={t('transferBody')}
    closeLabel={t('cancel')}
    footer={<Button variant="outline" disabled={pending} onClick={onClose}>{t('cancel')}</Button>}
  >
    <p className={css.transferAccountable}>{t('transferAccountable', { name: accountableName })}</p>
    {members.length === 0 && !human
      ? <p className={css.transferEmpty} role="status">{t('transferEmpty')}</p>
      : <ul className={css.transferList}>
          {members.map(status => <li key={status.member.memberId}>
            <button type="button" className={css.transferCandidate} disabled={pending}
              aria-label={t('transferTargetLabel', { name: memberName(status.member.memberId) })}
              onClick={() => { onTransfer(status.member.memberId) }}>
              <TeamMemberIdentity status={status} t={t} />
            </button>
          </li>)}
          {human && humanMemberId !== undefined && <li>
            <button type="button" className={css.transferCandidate} disabled={pending}
              aria-label={t('transferTargetYou')}
              onClick={() => { onTransfer(humanMemberId) }}>
              <span className={sidebarCss.agentAvatar} style={{ '--team-avatar-hue': memberHue(HUMAN_MEMBER_ID), overflow: 'hidden' } as CSSProperties} aria-hidden="true">
                {humanImage.image.kind === 'image'
                  ? <img src={humanImage.image.src} alt="" width={34} height={34} onError={humanImage.failed} />
                  : identityInitial(humanName)}
              </span>
              <span className={rowCss.copy}>
                <strong>{humanName}</strong>
                <small>{t('transferHumanHint')}</small>
              </span>
            </button>
          </li>}
        </ul>}
    {/* While open, the dialog owns the failure line because the action band's line sits behind the modal. */}
    {failure !== undefined && <p className={css.actionError} role="alert">{failure}</p>}
  </Modal>
}

// Early acceptance completes open Claims with the Task, so the Human must see exactly which work will end.
export function TeamTaskEarlyAcceptDialog({ open, pending, accepting, claims, memberName, onClose, onConfirm, t }: {
  readonly open: boolean
  readonly pending: boolean
  readonly accepting: boolean
  readonly claims: readonly AgentTeamClaim[]
  readonly memberName: (memberId: AgentTeamMemberId) => string
  readonly onClose: () => void
  readonly onConfirm: () => void
  readonly t: TeamConversationProps['t']
}) {
  return <Modal
    open={open}
    onClose={() => { if (!pending) onClose() }}
    title={t('acceptEarlyTitle')}
    closeLabel={t('cancel')}
    footer={<>
      <Button variant="outline" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={pending} onClick={onConfirm}>{accepting ? t('acceptingTask') : t('acceptTask')}</Button>
    </>}
  >
    <p className={css.confirmBody}>{t('acceptEarlyBody', { count: claims.length })}</p>
    <ul className={css.confirmList}>
      {claims.map(claim => (
        <li key={claim.claimRef}>{memberName(claim.owner)} · {claim.direction}</li>
      ))}
    </ul>
  </Modal>
}
