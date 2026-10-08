import { describe, expect, it } from 'vitest'
import { evaluateEnvironment, reportEnvironment, supportRangeOf } from '../src/environment-check.ts'

/**
 * The environment check decides one of exactly three shapes from three facts,
 * and this suite locks the boundaries that make those facts meaningful.
 *
 * The two version boundaries are the reason the verdict rides the Harness's own
 * `evaluatePluginCompatibility` instead of a comparison written here:
 * `0.1.7-alpha.1` sorts *below* `0.1.7-rc.1`, so a string comparison or a plain
 * `semver.satisfies` without prereleases would call a genuinely unsupported
 * line supported. `0.1.7-rc.2` sorting *inside* the same range is the other
 * half: the certified baseline advances without the peer range moving, which is
 * why the range's lower bound — not the newest cut — is what the page states.
 */

const RANGE = '>=0.1.7-rc.1 <0.1.8'

/** A manifest shaped like the installed bundle's, with the DSH peers given. */
const manifestWith = (peers: Record<string, string>): object => Object.freeze({
  name: '@contexera/dsh-agent-team',
  version: '0.1.15',
  peerDependencies: Object.freeze({ '@deepseek-ai/cordis': '^4.0.1', ...peers }),
})

const TWO_PEERS = manifestWith({
  '@deepseek-ai/dsh-app-boot': RANGE,
  '@deepseek-ai/dsh-workspace': RANGE,
})

describe('the declared support range', () => {
  it('is the one range every dsh peer states', () => {
    expect(supportRangeOf(TWO_PEERS)).toEqual({ lower: '0.1.7-rc.1', upper: '0.1.8' })
  })

  it('ignores a same-scope peer that is not on the dsh version line', () => {
    // `@deepseek-ai/cordis` shares the scope and carries a range of its own; it
    // is not a DSH version and must never participate.
    expect(supportRangeOf(manifestWith({ '@deepseek-ai/dsh-workspace': RANGE }))?.lower).toBe('0.1.7-rc.1')
  })

  it('is withheld when the peers disagree, which is the drifted-manifest cause', () => {
    expect(supportRangeOf(manifestWith({
      '@deepseek-ai/dsh-workspace': RANGE,
      '@deepseek-ai/dsh-agent': '>=0.1.6 <0.1.7',
    }))).toBeUndefined()
  })

  it('is withheld when no dsh peer states one at all', () => {
    expect(supportRangeOf(manifestWith({}))).toBeUndefined()
    expect(supportRangeOf(Object.freeze({ name: 'x' }))).toBeUndefined()
  })

  it('is withheld when the range is not a two-sided series', () => {
    // A caret or a bare version cannot state an upper bound, so the page has
    // nothing it could render honestly as a support line.
    expect(supportRangeOf(manifestWith({ '@deepseek-ai/dsh-workspace': '^0.1.7-rc.1' }))).toBeUndefined()
    expect(supportRangeOf(manifestWith({ '@deepseek-ai/dsh-workspace': '0.1.7-rc.1' }))).toBeUndefined()
  })
})

describe('the three verdicts', () => {
  it('is ok when the running dsh is inside the declared range', () => {
    expect(evaluateEnvironment(TWO_PEERS, '0.1.7-rc.1', '0.1.15')).toEqual({
      verdict: 'ok', bundleVersion: '0.1.15', dshVersion: '0.1.7-rc.1',
      certifiedDshVersion: '0.1.7-rc.1', supportRange: { lower: '0.1.7-rc.1', upper: '0.1.8' },
    })
  })

  it('is ok for a later cut certified inside the same range', () => {
    // The baseline moved to rc.2 without the peers moving; the page still names
    // the range's lower bound, so this must not read as out-of-range.
    expect(evaluateEnvironment(TWO_PEERS, '0.1.7-rc.2', '0.1.15').verdict).toBe('ok')
    expect(evaluateEnvironment(TWO_PEERS, '0.1.7', '0.1.15').verdict).toBe('ok')
  })

  it('is out-of-range below the lower bound, including a lower prerelease', () => {
    expect(evaluateEnvironment(TWO_PEERS, '0.1.7-alpha.1', '0.1.15').verdict).toBe('out-of-range')
    expect(evaluateEnvironment(TWO_PEERS, '0.1.6', '0.1.15').verdict).toBe('out-of-range')
  })

  it('is out-of-range at the exclusive upper bound and above it', () => {
    expect(evaluateEnvironment(TWO_PEERS, '0.1.8', '0.1.15').verdict).toBe('out-of-range')
    expect(evaluateEnvironment(TWO_PEERS, '0.1.9-rc.1', '0.1.15').verdict).toBe('out-of-range')
  })

  it('admits a prerelease of the upper bound, which is what "before 0.1.8" says', () => {
    // `<0.1.8` in semver reaches prereleases of 0.1.8 — they sort below it — so
    // a candidate for the next line is inside the declared range, and the page
    // would contradict its own words if it called that unsupported.
    expect(evaluateEnvironment(TWO_PEERS, '0.1.8-rc.1', '0.1.15').verdict).toBe('ok')
  })

  it('keeps the facts on an out-of-range verdict, which is what that page states', () => {
    expect(evaluateEnvironment(TWO_PEERS, '0.1.6', '0.1.15')).toEqual({
      verdict: 'out-of-range', bundleVersion: '0.1.15', dshVersion: '0.1.6',
      certifiedDshVersion: '0.1.7-rc.1', supportRange: { lower: '0.1.7-rc.1', upper: '0.1.8' },
    })
  })
})

describe('undetermined, the one answer for a fact that is not established', () => {
  it('covers an unreadable running dsh version', () => {
    const report = evaluateEnvironment(TWO_PEERS, 'unknown', '0.1.15', 'the manifest could not be read')
    expect(report.verdict).toBe('undetermined')
    expect(report.reason).toBe('the manifest could not be read')
    // The range is still stated: it is known, and a reader asking why no
    // verdict was reached is better served by the line than by its absence.
    expect(report.supportRange).toEqual({ lower: '0.1.7-rc.1', upper: '0.1.8' })
  })

  it('covers an unreadable support range', () => {
    expect(evaluateEnvironment(manifestWith({}), '0.1.7-rc.1', '0.1.15').verdict).toBe('undetermined')
  })

  it('covers a drifted dsh peer declaration that nothing actually violates', () => {
    // Two ranges, both satisfied by the running version: there is nothing to
    // report as a violation, and no single line the page could state.
    const drifted = manifestWith({
      '@deepseek-ai/dsh-workspace': RANGE,
      '@deepseek-ai/dsh-agent': '>=0.1.7-rc.1 <0.2.0',
    })
    expect(evaluateEnvironment(drifted, '0.1.7-rc.1', '0.1.15').verdict).toBe('undetermined')
  })

  it('prefers a real violation over an unstatable range', () => {
    // The drifted peer is genuinely unsatisfied. That is a real "not
    // satisfied", so it must not be downgraded to `undetermined` merely
    // because the peer set no longer yields one line to print.
    // The drifted peer has moved its lower bound past the running version, so
    // it is genuinely unsatisfied.
    const drifted = manifestWith({
      '@deepseek-ai/dsh-workspace': RANGE,
      '@deepseek-ai/dsh-agent': '>=0.1.7-rc.2 <0.1.8',
    })
    const report = evaluateEnvironment(drifted, '0.1.7-rc.1', '0.1.15')
    expect(report.verdict).toBe('out-of-range')
    expect(report.supportRange).toBeUndefined()
  })

  it('never invents a certified version it could not derive', () => {
    for (const manifest of [manifestWith({}), TWO_PEERS]) {
      const report = evaluateEnvironment(manifest, 'unknown', '0.1.15')
      expect(report.certifiedDshVersion).toBe(manifest === TWO_PEERS ? '0.1.7-rc.1' : undefined)
    }
  })

  it('carries an unreadable bundle version through as unknown rather than dropping it', () => {
    expect(evaluateEnvironment(TWO_PEERS, '0.1.7-rc.1', 'unknown').bundleVersion).toBe('unknown')
  })
})

describe('this checkout', () => {
  it('reads its own installed manifest and running dsh and reaches a verdict', () => {
    const report = reportEnvironment()
    expect(['ok', 'out-of-range', 'undetermined']).toContain(report.verdict)
    // The repository is the linked development install: its manifest names a
    // version and one uniform dsh range, so the value sources are exercised for
    // real here rather than only through injected fixtures.
    expect(report.bundleVersion).not.toBe('unknown')
    expect(report.supportRange?.lower).toBe(report.certifiedDshVersion)
  })
})
