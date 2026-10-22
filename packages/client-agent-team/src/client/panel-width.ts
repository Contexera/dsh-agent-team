// A width is local convenience, not a Host fact.

const STORAGE_KEY = 'dsh.agent-team.panel-width.v1'

export const PANEL_MIN = 420
export const PANEL_MAX = 960
const PANEL_DEFAULT_SHARE = 0.52
const FEED_FLOOR = 420

// The feed keeps FEED_FLOOR; on a surface too narrow for both the panel settles at its own floor rather than inverting the clamp.
// The panel is out of flow, so opening it cannot widen the box its seat is a share of.
export function clampPanelWidth(requested: number, surfaceWidth: number): number {
  const ceiling = Math.min(PANEL_MAX, Math.max(PANEL_MIN, surfaceWidth - FEED_FLOOR))
  return Math.round(Math.min(Math.max(requested, PANEL_MIN), ceiling))
}

export function resolvePanelWidth(surfaceWidth: number, preference: number | null): number {
  if (preference !== null) return clampPanelWidth(preference, surfaceWidth)
  return clampPanelWidth(Math.round(surfaceWidth * PANEL_DEFAULT_SHARE), surfaceWidth)
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
