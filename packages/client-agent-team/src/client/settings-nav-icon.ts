/**
 * The shipped settings shell draws its nav glyph per section id (`navIcon(id)`) and
 * `settings.section` carries no icon option, so a feature's own row falls back to the
 * generic gear. Installed third-party themes close that gap the same way: tag the row
 * inside the shell's portalled dialog and paint the mark over the shell glyph with CSS.
 *
 * This is a DOM-level workaround, not a supported extension point, so it stays one effect
 * and cleans up after itself. A body mutation observer only notices the dialog opening or
 * closing; while a dialog is open a second observer watches its subtree, so a re-render
 * inside it (a locale switch re-registering the rows) re-tags the row. Remove the whole
 * thing once the Harness exposes an icon on `settings.section`.
 */
import { teamMarkMaskUrl } from './team-mark.ts'
import './settings-nav-icon.module.css'

const FLAG = 'data-agent-team-settings-icon'
const DIALOG = '[role="dialog"][data-shortcut-modal="settings"]'
const ROW = `${DIALOG} nav button`

export function installSettingsNavIcon(document: Document, label: () => string): () => void {
  const mask = teamMarkMaskUrl()
  const tag = (button: HTMLElement): void => {
    button.setAttribute(FLAG, '')
    button.style.setProperty('--team-settings-mark', mask)
  }
  const untag = (button: HTMLElement): void => {
    button.removeAttribute(FLAG)
    button.style.removeProperty('--team-settings-mark')
  }
  const update = (): void => {
    const text = label()
    const marked = new Set<HTMLElement>()
    for (const button of document.querySelectorAll<HTMLElement>(ROW)) {
      if ((button.textContent ?? '').trim() !== text) continue
      tag(button)
      marked.add(button)
    }
    for (const stale of document.querySelectorAll<HTMLElement>(`[${FLAG}]`)) {
      if (!marked.has(stale)) untag(stale)
    }
  }

  // The dialog is portalled to `body`, so its appearance and removal reach the body
  // observer directly; while it is open its own subtree carries the row re-renders.
  let open: HTMLElement | null = null
  const inner = new MutationObserver(update)
  const sync = (): void => {
    const dialog = document.querySelector<HTMLElement>(DIALOG)
    if (dialog !== open) {
      inner.disconnect()
      open = dialog
      if (dialog !== null) inner.observe(dialog, { childList: true, subtree: true, characterData: true })
    }
    update()
  }
  const outside = new MutationObserver(sync)
  outside.observe(document.body, { childList: true })
  sync()

  return () => {
    outside.disconnect()
    inner.disconnect()
    open = null
    for (const marked of document.querySelectorAll<HTMLElement>(`[${FLAG}]`)) untag(marked)
  }
}
