import { formatMessageTime } from './team-formatters.ts'
import css from './conversation.module.css'

/**
 * Explicit boundary between two same-sender Messages of one run separated by
 * a real waiting gap: the hairline restores the block boundary that grouping
 * removed, and the label below it restores the instant that the suppressed
 * identity chrome would have shown.
 *
 * The divider is a sibling of the rows it separates, so it carries the run's
 * side itself: the hairline and the label hug the text column, which sits on
 * the reader's opposite side for the reader's own turns.
 */
export function TeamRunDivider({ occurredAt, side }: { readonly occurredAt: string; readonly side: 'start' | 'end' }) {
  return (
    <div className={css.runDivider} data-side={side} role="separator">
      <time dateTime={occurredAt}>{formatMessageTime(occurredAt)}</time>
    </div>
  )
}
