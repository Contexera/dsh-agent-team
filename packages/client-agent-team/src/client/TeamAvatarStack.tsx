import type { CSSProperties } from 'react'
import type { AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { useAvatarImage } from './avatar-image.ts'
import { memberHue } from './team-formatters.ts'
import css from './avatar-stack.module.css'

/** Distinct owners past this count collapse into one `+N` chip. */
const MAX_VISIBLE = 3

/** One owner as the stack draws it: the id carries the hue, the name the initial. */
export interface TeamAvatarOwner {
  readonly memberId: AgentTeamMemberId
  /** Public handle, or the raw Member id when the roster no longer names them. */
  readonly name: string
}

/**
 * The reader's own identity, as the Client's one Human projection holds it.
 *
 * The stack draws every owner from the shared Member language — hue plus
 * initial — which is the whole identity an Agent has. The Human is the one
 * Member with a picture, so that one chip draws the picture and falls back to
 * this name's initial, exactly as the timeline already does.
 */
export interface TeamAvatarHuman {
  readonly memberId: AgentTeamMemberId
  readonly name: string
  readonly avatarUrl?: string | undefined
}

/**
 * Owners as a seat names them: the Client's Human identity outranks the name
 * the Host projected for that actor, so a rename moves label and initial
 * together in every seat that draws the stack.
 */
export function namedAvatarOwners(owners: readonly TeamAvatarOwner[], human: TeamAvatarHuman | undefined): readonly TeamAvatarOwner[] {
  if (human === undefined) return owners
  return owners.map(owner => owner.memberId === human.memberId ? { memberId: owner.memberId, name: human.name } : owner)
}

/**
 * The compact "who is on this work" stack: overlapping 18px Member circles in
 * the shared identity language, capped at three plus a `+N` chip. The circles
 * are presentational, so the stack is one `role="img"` whose label carries the
 * whole roster — three anonymous initials would read as noise.
 */
export function TeamAvatarStack({ owners, label, human }: {
  readonly owners: readonly TeamAvatarOwner[]
  readonly label: string
  /** The reader's own identity; one owner matching it draws the Human's picture. */
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

/**
 * One circle. Only an owner the seat identifies as the Human consults an image
 * at all, and those bytes keep the initial whenever they do not decode — the
 * same promise, and the same hook, the timeline avatar makes.
 */
function OwnerAvatar({ owner, human }: {
  readonly owner: TeamAvatarOwner
  readonly human: TeamAvatarHuman | undefined
}) {
  const image = useAvatarImage(human !== undefined && owner.memberId === human.memberId ? human.avatarUrl : undefined)
  const hue = { '--team-avatar-hue': memberHue(owner.memberId) } as CSSProperties
  if (image.src === undefined) return <span className={css.avatar} style={hue}>{initial(owner.name)}</span>
  return <img className={css.avatarImage} style={hue} src={image.src} alt="" aria-hidden="true" onError={image.failed} />
}

/** First visible character of a handle — and of a raw Member id when that is all there is. */
function initial(name: string): string {
  return name.replace(/^@/, '').replace(/^member:/, '').slice(0, 1).toUpperCase()
}
