
import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import createCss from './create.module.css'
import css from './sidebar.module.css'

export interface MultiMenuOption {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
  readonly icon?: ReactNode
  readonly hint?: string
}

/** `label` doubles as the trigger's accessible name; `disabled` disables the trigger while a mutation is in flight. */
export function MultiMenuField<I extends string>({ label, options, selected, onToggle, disabled = false, emptyText, triggerEmptyLabel, formatCount }: {
  readonly label: string
  readonly options: readonly MultiMenuOption[]
  readonly selected: readonly I[]
  readonly onToggle: (id: I) => void
  readonly disabled?: boolean
  readonly emptyText?: string
  readonly triggerEmptyLabel: string
  readonly formatCount: (count: number) => string
}) {
  const [open, setOpen] = useState(false)
  const items: MenuEntry[] = options.map(option => ({
    id: option.id,
    label: option.hint === undefined ? option.label : <>{option.label}<small className={css.menuHint}>{` ${option.hint}`}</small></>,
    ...(option.disabled === true ? { disabled: true } : {}),
    ...(option.icon === undefined ? {} : { icon: option.icon }),
  }))
  return (
    <div className={createCss.field}>
      <span>{label}</span>
      {options.length === 0 && emptyText !== undefined ? <small className={css.editHint}>{emptyText}</small> : (
        <Menu
          open={open}
          portal
          className={createCss.menuCap!}
          items={items}
          selectedIds={selected}
          onSelect={id => { onToggle(id as I) }}
          onClose={() => { setOpen(false) }}
          anchor={
            <button
              type="button"
              className={createCss.selectTrigger!}
              aria-label={label}
              aria-haspopup="menu"
              aria-expanded={open}
              disabled={disabled}
              onClick={() => { setOpen(value => !value) }}
            >
              <span className={createCss.selectValue}>{selected.length === 0 ? triggerEmptyLabel : formatCount(selected.length)}</span>
              <span className={`${createCss.chevron!} ${open ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutlineRegular /></span>
            </button>
          }
        />
      )}
    </div>
  )
}
