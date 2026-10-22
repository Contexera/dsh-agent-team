import css from './countBadge.module.css'

/** Every count the Human reads is capped at this, so one wide number never widens the capsule. */
const COUNT_CAP = 99

/** The one count capsule shared by the Inbox entry, the Thread entry and the queue row. Zero renders nothing. */
export function TeamCountBadge({ count, tone = 'solid', label, className }: {
  readonly count: number
  /** `hairline` is unread that merely arrived; the solid fill is unread that names this reader. */
  readonly tone?: 'solid' | 'hairline' | undefined
  /** The accessible name while the count is the only thing saying it; omit it when the surrounding control already carries the number. */
  readonly label?: string | undefined
  readonly className?: string | undefined
}) {
  if (count <= 0) return null
  const text = count > COUNT_CAP ? `${COUNT_CAP}+` : String(count)
  const classes = `${css.badge}${tone === 'hairline' ? ` ${css.hairline}` : ''}${className === undefined ? '' : ` ${className}`}`
  // Tests read the capsule by this attribute rather than a CSS-module hash.
  return label === undefined
    ? <span className={classes} data-team-count-badge={tone} aria-hidden="true">{text}</span>
    : <span className={classes} data-team-count-badge={tone} role="img" aria-label={label} title={label}>{text}</span>
}
