/** The bundle's own mark (a ring of collaborators, open where a new one joins) in the shipped icon language (16px grid, 1px stroke, `currentColor`). */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { TEAM_MARK_DOT, TEAM_MARK_RING, TEAM_MARK_VIEW_BOX } from './team-mark.ts'

export function TeamPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg width={size} height={size} viewBox={TEAM_MARK_VIEW_BOX} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d={TEAM_MARK_RING} stroke="currentColor" />
      <circle cx={TEAM_MARK_DOT.cx} cy={TEAM_MARK_DOT.cy} r={TEAM_MARK_DOT.r} fill="currentColor" />
    </svg>
  )
}
