import { describe, expect, it } from 'vitest'
import { formatTeamDuration, formatTeamTimestamp } from '../src/time-format.ts'

/**
 * The fixed-offset formatter is the load-bearing piece of the cache
 * invariant: the same stored instant must render byte-identically on every
 * reread path. These tests lock the exact rendering, the fixed offset, and
 * the never-fabricate fallback for unparseable input.
 */
describe('formatTeamTimestamp renders the fixed UTC+8 coordination zone', () => {
  it('renders one stored UTC instant with an explicit +08:00 offset', () => {
    expect(formatTeamTimestamp('2026-09-08T09:00:00.000Z')).toBe('2026-09-08T17:00:00+08:00')
  })

  it('crosses the date boundary in the coordination zone, not UTC', () => {
    expect(formatTeamTimestamp('2026-09-08T16:30:00.000Z')).toBe('2026-09-09T00:30:00+08:00')
  })

  it('preserves second granularity without sub-second noise', () => {
    expect(formatTeamTimestamp('2026-09-08T08:58:41.917Z')).toBe('2026-09-08T16:58:41+08:00')
  })

  it('returns unparseable input unchanged instead of fabricating a time', () => {
    expect(formatTeamTimestamp('')).toBe('')
    expect(formatTeamTimestamp('not-a-timestamp')).toBe('not-a-timestamp')
  })
})

describe('formatTeamDuration renders compact absolute elapsed units', () => {
  it('renders plain seconds', () => {
    expect(formatTeamDuration(8_500)).toBe('8s')
  })

  it('renders the README example span 2d 3h 12m 8s', () => {
    const span = ((2 * 24 + 3) * 60 * 60 + 12 * 60 + 8) * 1000
    expect(formatTeamDuration(span)).toBe('2d 3h 12m 8s')
  })

  it('clamps negative elapsed to 0s for wall-clock rollback without rewriting history', () => {
    expect(formatTeamDuration(-5_000)).toBe('0s')
  })

  it('drops zero middle units instead of printing 0h 0m', () => {
    expect(formatTeamDuration(61_000)).toBe('1m 1s')
    expect(formatTeamDuration(3_600_000)).toBe('1h 0s')
  })
})
