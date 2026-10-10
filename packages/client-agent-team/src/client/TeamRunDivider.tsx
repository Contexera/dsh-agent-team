import { formatMessageTime } from './team-formatters.ts'
import css from './conversation.module.css'

/**
 * Explicit boundary between two same-sender Messages of one run separated by
 * a real waiting gap: the hairline restores the block boundary that grouping
 * removed, and the label below it restores the instant that the suppressed
 * identity chrome would have shown.
 *
 * The divider is a sibling of the rows it separates, so it insets its own
 * hairline and label to hug the text column every Message shares.
 */
export function TeamRunDivider({ occurredAt }: { readonly occurredAt: string }) {
  return (
    <div className={css.runDivider} role="separator">
      <time dateTime={occurredAt}>{formatMessageTime(occurredAt)}</time>
    </div>
  )
}
