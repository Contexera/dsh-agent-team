// The discussion panel's width axis: the panel is the reader's main surface once
// opened, so its seat is adjustable. A width is local convenience, not a Host fact.

const STORAGE_KEY = 'dsh.agent-team.panel-width.v1'

export const PANEL_MIN = 420
export const PANEL_MAX = 960
const PANEL_DEFAULT_SHARE = 0.52
const FEED_FLOOR = 420

// The panel never takes the whole stage: the feed keeps FEED_FLOOR, and on a
// stage too narrow for both the panel settles at its own floor rather than the
// clamp inverting. Width is measured on the stage's own box, never its padding
// box — an open panel shrinks the padding box, which would ratchet the seat down.
export function clampPanelWidth(requested: number, stageWidth: number): number {
  const ceiling = Math.min(PANEL_MAX, Math.max(PANEL_MIN, stageWidth - FEED_FLOOR))
  return Math.round(Math.min(Math.max(requested, PANEL_MIN), ceiling))
}

export function resolvePanelWidth(stageWidth: number, preference: number | null): number {
  if (preference !== null) return clampPanelWidth(preference, stageWidth)
  return clampPanelWidth(Math.round(stageWidth * PANEL_DEFAULT_SHARE), stageWidth)
}

export function readPanelWidthPreference(): number | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch { return null }
}

export function writePanelWidthPreference(width: number): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, `${width}`)
  } catch {}
}
