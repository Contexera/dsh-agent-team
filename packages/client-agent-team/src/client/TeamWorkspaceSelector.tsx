import { useEffect, useState } from 'react'
import { IconChevronDownOutlineRegular, IconFolderOpenRegular, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import css from './sidebar.module.css'

export interface TeamWorkspaceChoice {
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly path: string
}

/**
 * The single-line Workspace selector scoping the Team sidebar: Channels and Agents belong to one Workspace, so a selector
 * reads as "you are in X". Cross-Workspace unread is summarized by the Inbox entry, which stays outside the selector.
 *
 * The trigger is a field, not a row, so it does not read as the first Channels entry; its accessible name states the shown
 * Workspace. The menu is the only way to switch, so it takes focus on open and returns it to the trigger on Escape.
 */
export function TeamWorkspaceSelector({ workspaces, selectedId, current, onSelect, t }: {
  readonly workspaces: readonly TeamWorkspaceChoice[]
  readonly selectedId: WorkspaceId | undefined
  readonly current: boolean
  readonly onSelect: (workspaceId: WorkspaceId) => void
  readonly t: (key: 'empty' | 'workspaceSelectorWithValue', params?: { title: string }) => string
}) {
  const [open, setOpen] = useState(false)
  // A portaled Menu list is hidden until the primitive's layout effect places it, so its `autoFocus` runs one render too early
  // and `focus()` on a hidden row is a no-op; arrow keys (indexed from `document.activeElement`) would stay dead.
  // Focus the opened row once the list is on screen; no-op when focus is already inside.
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      // The list this open mounted is the last portaled child.
      const lists = document.querySelectorAll<HTMLElement>('body > [role="menu"]')
      const list = lists[lists.length - 1]
      if (list === undefined || list.contains(document.activeElement)) return
      list.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    return () => { cancelAnimationFrame(frame) }
  }, [open])
  const selected = workspaces.find(workspace => workspace.workspaceId === selectedId)
  // Nothing to select: say so in the selector's own seat instead of a dead field.
  if (selected === undefined) return <p className={css.emptyState}>{t('empty')}</p>
  const items: MenuEntry[] = workspaces.map(workspace => ({
    id: workspace.workspaceId,
    label: workspace.title,
  }))
  return (
    <Menu
      open={open}
      portal
      autoFocus
      items={items}
      selectedIds={[selected.workspaceId]}
      onSelect={id => { setOpen(false); onSelect(id as WorkspaceId) }}
      onClose={() => { setOpen(false) }}
      anchor={(
        <button
          type="button"
          className={css.workspaceTrigger}
          data-team-workspace-trigger
          aria-label={t('workspaceSelectorWithValue', { title: selected.title })}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-current={current ? 'page' : undefined}
          title={`${selected.title} · ${selected.path}`}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className={css.workspaceIcon} aria-hidden="true"><IconFolderOpenRegular size={16} /></span>
          <span className={css.workspaceValue}>{selected.title}</span>
          <span className={`${css.workspaceChevron!} ${open ? css.workspaceChevronOpen! : ''}`} aria-hidden="true"><IconChevronDownOutlineRegular /></span>
        </button>
      )}
    />
  )
}
