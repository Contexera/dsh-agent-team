import type { ReactNode } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './sidebar.module.css'

export function TeamSidebarSection({ title, actions, open, onToggle, children }: {
  readonly title: string
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
        {actions !== undefined && <span className={css.sectionActions}>{actions}</span>}
      </div>
      {open && children}
    </section>
  )
}
