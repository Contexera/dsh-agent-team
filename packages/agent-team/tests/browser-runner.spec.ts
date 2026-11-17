import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  LANE_ALIASES,
  aggregateTestSummaries,
  allowsPhaseMarker,
  buildSummary,
  formatLaneList,
  formatSummaryText,
  parseLaneContracts,
  parseRunnerArgs,
  planLaneBatches,
  resolveLanes,
} from '../../../scripts/browser-runner.mjs'

describe('browser-runner', () => {
  it('parses --list, file filters, and vitest flags without leaking --list to vitest', () => {
    expect(parseRunnerArgs(['--list'])).toEqual({
      list: true,
      deep: false,
      fileFilters: [],
      vitestFlags: [],
      narrowed: false,
    })

    expect(parseRunnerArgs(['team-manager', '-t', 'replacement', '--bail=1'])).toEqual({
      list: false,
      deep: false,
      fileFilters: ['team-manager'],
      vitestFlags: ['-t', 'replacement', '--bail=1'],
      narrowed: true,
    })

    expect(parseRunnerArgs(['-t', 'only-one'])).toEqual({
      list: false,
      deep: false,
      fileFilters: [],
      vitestFlags: ['-t', 'only-one'],
      narrowed: true,
    })

    expect(parseRunnerArgs(['--deep'])).toEqual({
      list: false,
      deep: true,
      fileFilters: [],
      vitestFlags: [],
      narrowed: false,
    })

    expect(parseRunnerArgs(['--fileParallelism', '--maxWorkers', '2'])).toEqual({
      list: false,
      deep: false,
      fileFilters: [],
      vitestFlags: ['--fileParallelism', '--maxWorkers', '2'],
      narrowed: false,
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
      batches: [{ name: 'default', status: 'passed', durationMs: 5000, lanes: ['team-manager'] }],
      screenshots: 6,
      artifactPath: join('/tmp', 'artifacts', 'browser'),
    })
    expect(passed.needsFullAcceptance).toBe(true)
    expect(passed.duration.totalMs).toBe(5135)
    expect(formatSummaryText(passed)).toContain('needsFullAcceptance=true')
    expect(formatSummaryText(passed)).toContain('batch=default status=passed')

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

  it('keeps heavy lanes serial and bounds the light lane batch', () => {
    const selected = [
      { name: 'team-journey', file: 'team-journey.e2e.ts', contract: '' },
      { name: 'team-manager', file: 'team-manager.e2e.ts', contract: '' },
      { name: 'team-inbox-and-recovery', file: 'team-inbox-and-recovery.e2e.ts', contract: '' },
    ]
    expect(planLaneBatches(selected, { shard: true, maxWorkers: 2 }).map(batch => ({
      name: batch.name,
      lanes: batch.lanes.map(lane => lane.name),
      flags: batch.vitestFlags,
    }))).toEqual([
      { name: 'serial-heavy', lanes: ['team-journey', 'team-manager'], flags: [] },
      { name: 'parallel-light', lanes: ['team-inbox-and-recovery'], flags: ['--fileParallelism', '--maxWorkers=2'] },
    ])
    expect(planLaneBatches(selected, { shard: false })).toHaveLength(1)

    expect(planLaneBatches([
      { name: 'team-journey-deep', file: 'team-journey-deep.e2e.ts', contract: '' },
      { name: 'team-subscriptions', file: 'team-subscriptions.e2e.ts', contract: '' },
    ], { shard: true, maxWorkers: 2 }).map(batch => ({
      name: batch.name,
      lanes: batch.lanes.map(lane => lane.name),
    }))).toEqual([
      { name: 'serial-heavy', lanes: ['team-journey-deep'] },
      { name: 'parallel-light', lanes: ['team-subscriptions'] },
    ])

    expect(planLaneBatches([
      { name: 'team-journey', file: 'team-journey.e2e.ts', contract: '' },
      { name: 'team-manager', file: 'team-manager.e2e.ts', contract: '' },
    ], { shard: true })).toHaveLength(1)

    expect(planLaneBatches([
      { name: 'team-subscriptions', file: 'team-subscriptions.e2e.ts', contract: '' },
      { name: 'team-worker-lifecycle', file: 'team-worker-lifecycle.e2e.ts', contract: '' },
    ], { shard: true })).toHaveLength(1)
  })

  it('enables the single-writer phase marker only for serial batches', () => {
    expect(allowsPhaseMarker([])).toBe(true)
    expect(allowsPhaseMarker(['--fileParallelism', '--maxWorkers=2'])).toBe(false)
    expect(allowsPhaseMarker(['--fileParallelism', '--maxWorkers', '1'])).toBe(true)
    expect(allowsPhaseMarker(['--fileParallelism'])).toBe(false)
    expect(allowsPhaseMarker(['--fileParallelism', '--no-fileParallelism'])).toBe(true)
  })

  it('aggregates test counts across scheduled batches', () => {
    expect(aggregateTestSummaries([
      { total: 3, passed: 3, failed: 0 },
      null,
      { total: 17, passed: 16, failed: 1 },
    ])).toEqual({ total: 20, passed: 19, failed: 1 })
  })
})
