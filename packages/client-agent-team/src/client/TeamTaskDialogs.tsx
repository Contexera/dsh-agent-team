import type { AgentTeamClaim, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamConversationProps } from './slots.ts'
import css from './conversation.module.css'

// Choosing a candidate must not dismiss the dialog: the page keeps the current accountable until the Host commits.
export function TeamTaskTransferDialog({ open, pending, candidates, memberName, humanMemberId, failure, onClose, onTransfer, t }: {
  readonly open: boolean
  readonly pending: boolean
  readonly candidates: readonly AgentTeamMemberId[]
  readonly memberName: (memberId: AgentTeamMemberId) => string
  readonly humanMemberId: AgentTeamMemberId | undefined
  readonly failure: string | undefined
  readonly onClose: () => void
  readonly onTransfer: (memberId: AgentTeamMemberId) => void
  readonly t: TeamConversationProps['t']
}) {
  return <Modal
    open={open}
    onClose={() => { if (!pending) onClose() }}
    title={t('transferTitle')}
    closeLabel={t('cancel')}
    footer={<Button variant="outline" disabled={pending} onClick={onClose}>{t('cancel')}</Button>}
  >
    <p className={css.confirmBody}>{t('transferBody')}</p>
    {candidates.length === 0
      ? <p className={css.transferEmpty} role="status">{t('transferEmpty')}</p>
      : <ul className={css.transferList}>
          {candidates.map(memberId => <li key={memberId}>
            <button type="button" className={css.transferCandidate} disabled={pending}
              onClick={() => { onTransfer(memberId) }}>
              {memberId === humanMemberId ? t('transferTargetYou') : t('transferTargetLabel', { name: memberName(memberId) })}
            </button>
          </li>)}
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
