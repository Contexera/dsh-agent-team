/** The bundle's own mark on the Team settings nav row, in the row's own ink. */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TEAM_MARK_DOT, TEAM_MARK_RING, TEAM_MARK_VIEW_BOX } from './team-mark.ts'

export function TeamSettingsNavIcon({ size }: PropsRuntime<'settings.section.icon'>): ReactNode {
  // The shell paints the selected row's ink and background; `active` names that
  // state for a registrant that wants its own selected glyph, and the shell's
  // own nav marks ignore it, so this one does too — `currentColor` is the ink.
  return (
    <svg width={size} height={size} viewBox={TEAM_MARK_VIEW_BOX} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" strokeWidth={1}>
      <path d={TEAM_MARK_RING} stroke="currentColor" />
      <circle cx={TEAM_MARK_DOT.cx} cy={TEAM_MARK_DOT.cy} r={TEAM_MARK_DOT.r} fill="currentColor" />
    </svg>
  )
}
