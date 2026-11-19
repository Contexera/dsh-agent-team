import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Button, IconQuestionOutlineRegular, Input, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  AgentTeamClientMemberStatus,
  AgentTeamMemberId,
  AgentTeamProject,
  AgentTeamProjectOwnerRequest,
  AgentTeamProjectOwnerResult,
  AgentTeamProjectOwnerUpdateRequest,
} from '@contexera/dsh-agent-team/types'
import type { TeamSidebarProps } from './slots.ts'
import { TeamMemberRow } from './TeamMemberRow.tsx'
import { HUMAN_MEMBER_ID, identityInitial, memberHue } from './team-formatters.ts'
import { useAvatarImage } from './avatar-image.ts'
import { mintRequestId } from './requests.ts'
import { useHumanIdentity } from './human-identity.ts'
import createCss from './create.module.css'
import rowCss from './member-row.module.css'
import sidebarCss from './sidebar.module.css'

/** A responsibility long enough to dominate the roster folds to a three-line preview, the same
 *  threshold the Member editor's reminder notes use. */
const OWNER_RESPONSIBILITY_EXPAND_CHARS = 120

type OwnerWrite = (request: AgentTeamProjectOwnerRequest) => Promise<RemoteResult<AgentTeamProjectOwnerResult>>
type OwnerUpdate = (request: AgentTeamProjectOwnerUpdateRequest) => Promise<RemoteResult<AgentTeamProjectOwnerResult>>

/** The Human owns every Project and is fixed; Agent owners are written through the Host and appear only after the projection refresh. */
export function TeamProjectOwners({ project, members, ownerIds, responsibilities, addProjectOwner, removeProjectOwner, updateProjectOwner, humanIdentity, onCommitted, t }: {
  readonly project: AgentTeamProject
  readonly members: readonly AgentTeamClientMemberStatus[]
  readonly ownerIds: ReadonlySet<AgentTeamMemberId>
  /** What each Agent owner answers for; a missing entry is unspecified, which is a fact about the grant and not a fault. */
  readonly responsibilities: ReadonlyMap<AgentTeamMemberId, string>
  readonly addProjectOwner: OwnerWrite
  readonly removeProjectOwner: OwnerWrite
  readonly updateProjectOwner: OwnerUpdate
  readonly humanIdentity: TeamSidebarProps['humanIdentity']
  readonly onCommitted: () => Promise<void> | void
  readonly t: TeamSidebarProps['t']
}) {
  const identity = useHumanIdentity(humanIdentity)
  const humanName = identity.name ?? t('human')
  const humanImage = useAvatarImage(identity.avatarUrl)
  const [pending, setPending] = useState<AgentTeamMemberId>()
  const [error, setError] = useState<string>()
  // The seat being edited, and the text on its way to the Host. Both are local:
  // the projection stays the one authority, so a committed edit shows only after
  // the refresh returns the record the Host actually stored.
  const [editing, setEditing] = useState<AgentTeamMemberId>()
  const [draft, setDraft] = useState('')
  // What the next grant will record. Blank is allowed here and means unspecified,
  // which is why the management tool asks for it and this entry point does not.
  const [addDraft, setAddDraft] = useState('')
  // Which owner's long responsibility text is unfolded; one seat at a time, cleared
  // when that seat opens its edit form because the form replaces the text block.
  const [expandedResponsibility, setExpandedResponsibility] = useState<AgentTeamMemberId>()
  // The form replaces the control that opened it, so it owns the focus move in both directions: the field
  // takes focus as it mounts, and closing the form returns it to that row's own Edit control once the row
  // is interactive again — a committed save keeps the row disabled until its refresh lands.
  const editButtons = useRef(new Map<AgentTeamMemberId, HTMLButtonElement>())
  const closedEdit = useRef<AgentTeamMemberId>()
  useEffect(() => {
    const closed = closedEdit.current
    if (editing !== undefined || closed === undefined || pending !== undefined) return
    closedEdit.current = undefined
    editButtons.current.get(closed)?.focus()
  }, [editing, pending])
  const owners = members.filter(status => ownerIds.has(status.member.memberId))
  const eligible = members.filter(status => !ownerIds.has(status.member.memberId)
    && (status.member.state === 'enabled' || status.member.state === 'suspended')
    && status.workspaceIds.includes(project.workspaceId))

  const write = async (write: OwnerWrite, status: AgentTeamClientMemberStatus, responsibility?: string): Promise<boolean> => {
    if (pending !== undefined) return false
    setPending(status.member.memberId)
    setError(undefined)
    try {
      const result = await write({
        requestId: mintRequestId(),
        workspaceId: project.workspaceId,
        projectRef: project.projectRef,
        memberId: status.member.memberId,
        ...(responsibility === undefined ? {} : { responsibility }),
      })
      if (!result.ok) {
        setError(result.error.message)
        return false
      }
      await onCommitted()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setPending(undefined)
    }
  }
  const submitResponsibility = async (event: FormEvent<HTMLFormElement>, status: AgentTeamClientMemberStatus): Promise<void> => {
    event.preventDefault()
    if (pending !== undefined) return
    setPending(status.member.memberId)
    setError(undefined)
    try {
      const result = await updateProjectOwner({
        requestId: mintRequestId(),
        workspaceId: project.workspaceId,
        projectRef: project.projectRef,
        memberId: status.member.memberId,
        responsibility: draft,
      })
      if (result.ok) {
        closedEdit.current = status.member.memberId
        setEditing(undefined)
        await onCommitted()
      } else setError(result.error.message)
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
      // The text was written into this grant, so it does not silently ride along
      // to the next one; a refused write keeps it, because nothing consumed it.
      onSelect: () => { void write(kind === 'Add' ? addProjectOwner : removeProjectOwner, status, kind === 'Add' ? addDraft : undefined)
        .then(committed => { if (committed && kind === 'Add') setAddDraft('') }) },
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
              : identityInitial(humanName)}
          </span>
          <span className={rowCss.copy}>
            <strong>{humanName}</strong>
            <small>{t('projectOwnerHumanHint')}</small>
          </span>
        </div>
        {owners.map(status => {
          const memberId = status.member.memberId
          const responsibility = responsibilities.get(memberId)
          const handle = status.member.handle.replace(/^@/, '')
          const clampable = responsibility !== undefined && responsibility.length > OWNER_RESPONSIBILITY_EXPAND_CHARS
          const expanded = expandedResponsibility === memberId
          return (
            <div key={memberId} className={createCss.ownerEntry} data-team-project-owner={memberId}>
              <TeamMemberRow status={status} t={t} action={action('Remove', status)} />
              {editing === memberId
                ? <form className={`${createCss.field} ${createCss.ownerEditForm}`} onSubmit={event => { void submitResponsibility(event, status) }}>
                  <label className={createCss.sectionLabel} htmlFor={`owner-responsibility-${memberId}`}>{t('projectOwnerResponsibilityLabel', { handle })}</label>
                  <textarea autoFocus id={`owner-responsibility-${memberId}`} className={createCss.textarea} rows={3} value={draft}
                    disabled={pending !== undefined} placeholder={t('projectOwnerResponsibilityPlaceholder')}
                    onChange={event => { setDraft(event.target.value) }} />
                  <div className={createCss.responsibilityActions}>
                    <Button type="button" size="sm" variant="outline" disabled={pending !== undefined}
                      onClick={() => { closedEdit.current = memberId; setEditing(undefined) }}>{t('projectOwnerResponsibilityCancel')}</Button>
                    <Button type="submit" size="sm" variant="primary" disabled={pending !== undefined}>{t('projectOwnerResponsibilitySave')}</Button>
                  </div>
                </form>
                : <div className={createCss.ownerBlock} data-team-project-owner-responsibility={memberId}>
                  {/* The recorded text takes the whole line it was written on; a text long enough to
                      dominate the roster folds to a three-line preview behind the same alpha-mask fade
                      the reminder note uses, and never shares a row with a control again — the last
                      wrap fight is what broke this seat in the first place. */}
                  <p className={`${createCss.ownerText}${responsibility === undefined ? ` ${createCss.ownerTextUnspecified}` : ''}` +
                    `${clampable && !expanded ? ` ${createCss.ownerTextClamped}` : ''}`}>{responsibility ?? t('projectOwnerResponsibilityUnspecified')}</p>
                  <div className={createCss.ownerFoot}>
                    {clampable && <button type="button" className={createCss.reminderExpand} aria-expanded={expanded}
                      onClick={() => { setExpandedResponsibility(expanded ? undefined : memberId) }}>
                      {expanded ? t('collapseMessage') : t('expandMessage')}
                    </button>}
                    <Button type="button" size="sm" variant="ghost" disabled={pending !== undefined} aria-label={t('projectOwnerResponsibilityEditLabel', { handle })}
                      ref={node => { if (node === null) editButtons.current.delete(memberId); else editButtons.current.set(memberId, node) }}
                      onClick={() => { setEditing(memberId); setDraft(responsibility ?? ''); setExpandedResponsibility(undefined) }}>{t('projectOwnerResponsibilityEdit')}</Button>
                  </div>
                </div>}
            </div>
          )
        })}
      </div>
      <span className={createCss.sectionLabel}>{t('projectOwnersAddable')}</span>
      {eligible.length === 0
        ? <p className={createCss.state}>{t('projectOwnersNoneEligible')}</p>
        : <>
          <label className={createCss.sectionLabel} htmlFor="team-owner-add-responsibility">{t('projectOwnerResponsibilityAddLabel')}</label>
          <Input id="team-owner-add-responsibility" className={createCss.input!} value={addDraft} disabled={pending !== undefined}
            placeholder={t('projectOwnerResponsibilityPlaceholder')} onChange={event => { setAddDraft(event.target.value) }} />
          <div className={createCss.roster}>
            {eligible.map(status => <TeamMemberRow key={status.member.memberId} status={status} t={t} action={action('Add', status)} />)}
          </div>
        </>}
      {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
    </div>
  )
}
