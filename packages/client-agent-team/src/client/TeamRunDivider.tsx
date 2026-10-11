import css from './conversation.module.css'

/**
 * Boundary between two same-sender Messages of one run separated by a real
 * waiting gap: the hairline restores the block boundary that grouping removed.
 * It never states the instant — every row states its own time under the
 * pointer, in the avatar seat — so the line stays a line.
 *
 * Only the Channel feed draws it: the feed states blocks, where the Thread
 * reads as one flow. The divider is a sibling of the rows it separates, so it
 * insets its own hairline to hug the text column every Message shares.
 */
export function TeamRunDivider() {
  return <div className={css.runDivider} role="separator" />
}
