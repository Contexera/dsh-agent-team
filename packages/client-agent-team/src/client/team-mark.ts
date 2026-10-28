/**
 * The Team mark in the shipped icon language (16px grid, 1px stroke, `currentColor`):
 * one source for the sidebar panel glyph and the settings nav mask, so the two can
 * never drift. The mask copy paints opaque shapes; the `mask` shorthand reads their
 * alpha, not their colour.
 */
export const TEAM_MARK_VIEW_BOX = '0 0 16 16'
export const TEAM_MARK_RING = 'M11.7 10.15A4.9 4.9 0 1 1 11.7 5.85'
export const TEAM_MARK_DOT = { cx: 12.7, cy: 8, r: 1.6 } as const

/** The same geometry as a `url("data:image/svg+xml,…")` for `mask-image`. */
export function teamMarkMaskUrl(): string {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='${TEAM_MARK_VIEW_BOX}' fill='none'>`
    + `<path d='${TEAM_MARK_RING}' stroke='black' stroke-width='1'/>`
    + `<circle cx='${TEAM_MARK_DOT.cx}' cy='${TEAM_MARK_DOT.cy}' r='${TEAM_MARK_DOT.r}' fill='black'/>`
    + '</svg>'
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}
