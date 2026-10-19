import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_MAX, PANEL_MIN, clampPanelWidth, readPanelWidthPreference, resolvePanelWidth, writePanelWidthPreference } from '../src/client/panel-width.ts'

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => { values.clear() },
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('panel width', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', storage())
  })

  it('defaults the panel to the larger half of the stage', () => {
    // The reader turned to the panel, so it leads; the feed keeps a scannable
    // measure beside it rather than the other way round.
    expect(resolvePanelWidth(1160, null)).toBe(603)
    expect(resolvePanelWidth(1160, null)).toBeGreaterThan(1160 / 2)
  })

  it('never takes the whole stage, so the feed beside it stays readable', () => {
    for (const stage of [700, 900, 1160, 1440, 1920, 2560]) {
      const width = clampPanelWidth(Number.MAX_SAFE_INTEGER, stage)
      expect(width).toBeLessThanOrEqual(stage)
      expect(stage - width).toBeGreaterThanOrEqual(1)
    }
  })

  it('settles at the panel floor on a stage too narrow for both floors', () => {
    // Below PANEL_MIN + FEED_FLOOR the two floors cannot both be met, so the
    // panel holds its own floor instead of the clamp inverting to the ceiling.
    for (const stage of [500, 600, 700, 800, 839]) {
      expect(clampPanelWidth(PANEL_MAX, stage)).toBe(PANEL_MIN)
    }
  })

  it('clamps both ends of a dragged width', () => {
    expect(clampPanelWidth(10, 1440)).toBe(PANEL_MIN)
    expect(clampPanelWidth(5000, 1440)).toBe(PANEL_MAX)
    expect(clampPanelWidth(700, 1440)).toBe(700)
  })

  it('re-clamps a saved seat to a stage that has since narrowed', () => {
    // A width saved on a wide window must not overflow a narrow one.
    expect(resolvePanelWidth(600, 900)).toBeLessThanOrEqual(600)
  })

  it('round-trips the saved seat and survives a broken store', () => {
    expect(readPanelWidthPreference()).toBeNull()
    writePanelWidthPreference(723)
    expect(readPanelWidthPreference()).toBe(723)
    localStorage.setItem('dsh.agent-team.panel-width.v1', 'not-a-number')
    expect(readPanelWidthPreference()).toBeNull()
    expect(() => { writePanelWidthPreference(500) }).not.toThrow()
  })
})
