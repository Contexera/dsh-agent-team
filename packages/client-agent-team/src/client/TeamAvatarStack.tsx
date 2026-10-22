import type { CSSProperties } from 'react'
import type { AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { useAvatarImage } from './avatar-image.ts'
import { memberHue } from './team-formatters.ts'
import css from './avatar-stack.module.css'

/** Distinct owners past this count collapse into one `+N` chip. */
const MAX_VISIBLE = 3

export interface TeamAvatarOwner {
  readonly memberId: AgentTeamMemberId
  readonly name: string
}

/** The Human is the one Member with a picture; that chip draws it and falls back to this name's initial. */
export interface TeamAvatarHuman {
  readonly memberId: AgentTeamMemberId
  readonly name: string
  readonly avatarUrl?: string | undefined
}

/** The Client's Human identity outranks the Host-projected name, so a rename moves label and initial together. */
export function namedAvatarOwners(owners: readonly TeamAvatarOwner[], human: TeamAvatarHuman | undefined): readonly TeamAvatarOwner[] {
  if (human === undefined) return owners
  return owners.map(owner => owner.memberId === human.memberId ? { memberId: owner.memberId, name: human.name } : owner)
}

/** The circles are presentational, so the stack is one `role="img"` whose label carries the whole roster. */
export function TeamAvatarStack({ owners, label, human }: {
  readonly owners: readonly TeamAvatarOwner[]
  readonly label: string
  readonly human?: TeamAvatarHuman | undefined
}) {
  if (owners.length === 0) return null
  const shown = owners.slice(0, MAX_VISIBLE)
  const overflow = owners.length - shown.length
  return <span className={css.stack} role="img" aria-label={label}>
    {shown.map(owner => <OwnerAvatar key={owner.memberId} owner={owner} human={human} />)}
    {overflow > 0 && <span className={css.overflow}>{`+${overflow}`}</span>}
  </span>
}

/** Only an owner the seat identifies as the Human consults an image; undecodable bytes keep the initial. */
function OwnerAvatar({ owner, human }: {
  readonly owner: TeamAvatarOwner
  readonly human: TeamAvatarHuman | undefined
}) {
  const image = useAvatarImage(human !== undefined && owner.memberId === human.memberId ? human.avatarUrl : undefined)
  const hue = { '--team-avatar-hue': memberHue(owner.memberId) } as CSSProperties
  if (image.image.kind === 'initial') return <span className={css.avatar} style={hue}>{initial(owner.name)}</span>
  return <img className={css.avatarImage} style={hue} src={image.image.src} alt="" aria-hidden="true" onError={image.failed} />
}

function initial(name: string): string {
  return name.replace(/^@/, '').replace(/^member:/, '').slice(0, 1).toUpperCase()
}
