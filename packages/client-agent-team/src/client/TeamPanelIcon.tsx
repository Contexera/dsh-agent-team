/** The bundle's own mark (a ring of collaborators, open where a new one joins) in the shipped icon language (16px grid, 1px stroke, `currentColor`). */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export function TeamPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d="M11.7 10.15A4.9 4.9 0 1 1 11.7 5.85" stroke="currentColor" />
      <circle cx="12.7" cy="8" r="1.6" fill="currentColor" />
    </svg>
  )
}
