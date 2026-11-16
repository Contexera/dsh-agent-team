import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  LANE_ALIASES,
  buildSummary,
  formatLaneList,
  formatSummaryText,
  parseLaneContracts,
  parseRunnerArgs,
  resolveLanes,
} from '../../../scripts/browser-runner.mjs'

describe('browser-runner', () => {
  it('parses --list, file filters, and vitest flags without leaking --list to vitest', () => {
    expect(parseRunnerArgs(['--list'])).toEqual({
      list: true,
      fileFilters: [],
      vitestFlags: [],
      narrowed: false,
    })

    expect(parseRunnerArgs(['team-manager', '-t', 'replacement', '--bail=1'])).toEqual({
      list: false,
      fileFilters: ['team-manager'],
      vitestFlags: ['-t', 'replacement', '--bail=1'],
      narrowed: true,
    })

    expect(parseRunnerArgs(['-t', 'only-one'])).toEqual({
      list: false,
      fileFilters: [],
      vitestFlags: ['-t', 'only-one'],
      narrowed: true,
    })
  })

  it('resolves aliases, parses contracts from e2e-lanes.md, and rejects unknown filters', () => {
    const catalog = readFileSync(resolve('docs/development/e2e-lanes.md'), 'utf8')
    const contracts = parseLaneContracts(catalog)
    expect(contracts.get('team-manager')).toContain('team-manager')
    expect(contracts.get('team-settings-and-tools')).toContain('Settings')

    const allE2eFiles = ['team-manager.e2e.ts', 'team-settings-and-tools.e2e.ts']
    const resolved = resolveLanes({
      allE2eFiles,
      fileFilters: ['team-settings-nav-icon'],
      aliases: LANE_ALIASES,
      contracts,
    })
    expect(resolved.matchedE2eFiles).toEqual(['team-settings-and-tools.e2e.ts'])
    expect(resolved.selectedLanes[0]?.name).toBe('team-settings-and-tools')

    expect(() => resolveLanes({
      allE2eFiles,
      fileFilters: ['nonexistent-lane'],
      aliases: LANE_ALIASES,
      contracts,
    })).toThrow(/No E2E lane matched filter/)

    const listText = formatLaneList(allE2eFiles, contracts, LANE_ALIASES)
    expect(listText).toContain('team-settings-and-tools [aliases: team-settings-nav-icon]')
  })

  it('builds and formats passed and failed summaries with phases and nextAction', () => {
    const selectedLanes = [
      { name: 'team-manager', file: 'team-manager.e2e.ts', contract: 'Manager preset and restore' },
    ]
    const passed = buildSummary({
      status: 'passed',
      mode: 'targeted',
      selectedLanes,
      phases: { preflight: 10, staging: 100, vitest: 5000, evidence: 5, cleanup: 20 },
      tests: { total: 3, passed: 3, failed: 0 },
      screenshots: 6,
      artifactPath: join('/tmp', 'artifacts', 'browser'),
    })
    expect(passed.needsFullAcceptance).toBe(true)
    expect(passed.duration.totalMs).toBe(5135)
    expect(formatSummaryText(passed)).toContain('needsFullAcceptance=true')

    const failed = buildSummary({
      status: 'failed',
      mode: 'full',
      selectedLanes,
      phases: { preflight: 10 },
      failedPhase: 'preflight',
      environmentBlocker: 'Missing executable Chrome at /usr/bin/google-chrome',
      artifactPath: join('/tmp', 'artifacts', 'browser'),
      error: 'ENOENT',
    })
    expect(failed.phase.failed).toBe('preflight')
    expect(failed.environmentBlocker).toContain('Chrome')
    expect(formatSummaryText(failed)).toContain('failedPhase=preflight')
  })
})
