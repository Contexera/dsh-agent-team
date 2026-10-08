/**
 * The Team entry's glyph in the sidebar's panel list: the bundle's own mark —
 * one ring of collaborators, open where a new one joins — drawn in the shipped
 * icon language (16px grid, 1px stroke, `currentColor`) instead of borrowing a
 * shipped glyph that means something else. The sidebar owns the button, the
 * label, and the selected state around it.
 */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the Team mark at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function TeamPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M11.7 10.15A4.9 4.9 0 1 1 11.7 5.85" stroke="currentColor" />
      <circle cx="12.7" cy="8" r="1.6" fill="currentColor" />
    </svg>
  )
}
