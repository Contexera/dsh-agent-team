import { useState } from 'react'
import { IconEllipsisOutlineRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './sidebar.module.css'

/** Overflow menu shared by sidebar Project and Agent rows; the owning row stays pinned to its hover fill while open. */
export function TeamRowMenu({ label, items, onSelect, onOpenChange }: {
  readonly label: string
  readonly items: readonly MenuEntry[]
  readonly onSelect: (id: string) => void
  /** Lets the row pin its hover styling while the portal list is up. */
  readonly onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const toggle = (): void => {
    setOpen(current => {
      onOpenChange?.(!current)
      return !current
    })
  }
  const close = (): void => {
    setOpen(false)
    onOpenChange?.(false)
  }
  return (
    <Menu
      open={open}
      onClose={close}
      items={items}
      onSelect={(id) => { close(); onSelect(id) }}
      portal
      closeOnPointerLeave
      anchor={(
        <button
          type="button"
          className={css.rowMenuButton}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={(event) => { event.stopPropagation(); toggle() }}
        >
          <IconEllipsisOutlineRegular />
        </button>
      )}
    />
  )
}
