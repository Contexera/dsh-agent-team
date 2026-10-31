import type { ReactNode } from 'react'
import { IconChevronDownOutlineRegular, IconQuestionOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './sidebar.module.css'

export function TeamSidebarSection({ title, help, actions, open, onToggle, children }: {
  readonly title: string
  /** A model explanation on hover, to the right. Covering the row beside it is accepted; folding the section is not. */
  readonly help?: { readonly label: string; readonly body: string }
  /** Trailing header controls (the add button); never part of the toggle. */
  readonly actions?: ReactNode
  /** Controlled disclosure state; the caller owns persistence. */
  readonly open: boolean
  readonly onToggle: (open: boolean) => void
  readonly children: ReactNode
}) {
  return (
    <section className={css.section}>
      <div className={css.sectionHeader}>
        <button type="button" className={css.sectionToggle} aria-expanded={open} onClick={() => { onToggle(!open) }}>
          <IconChevronDownOutlineRegular className={css.sectionChevron} />
          <span className={css.sectionTitle}>{title}</span>
        </button>
        {help !== undefined && (
          <Tooltip label={help.body} side="right" delayMs={200} portal maxWidth={280}>
            <button type="button" className={css.sectionHint} aria-label={help.label}>
              <IconQuestionOutlineRegular size={12} />
            </button>
          </Tooltip>
        )}
        {actions !== undefined && <span className={css.sectionActions}>{actions}</span>}
      </div>
      {open && children}
    </section>
  )
}
