import { afterEach, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { CHROME, HOME, STAGED_BUNDLE, closeScenario, connectFreshWorkspaceZh, installLocalBundle, launchWebScaffold, watchConsole } from '../tests/__external-agent-team-support.ts'
import type { WebScaffold } from '../tests/__external-agent-team-support.ts'

const TEAM_ROOT = '__TEAM_ROOT__'

let browser: Browser | undefined
let activeScaffold: WebScaffold | undefined

afterEach(async () => {
  await browser?.close(); browser = undefined
  await activeScaffold?.close(); activeScaffold = undefined
  await closeScenario()
})

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]!
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

it('measures the assembled Web loading path', async () => {
  await installLocalBundle()
  const sampleCount = Number(process.env.DSH_BENCH_BROWSER_SAMPLES ?? 1)
  if (!Number.isInteger(sampleCount) || sampleCount < 1) throw new Error('DSH_BENCH_BROWSER_SAMPLES must be a positive integer')
  const samples: Array<{
    readonly scenario: 'browser-loading'
    readonly sample: number
    readonly startedAt: string
    readonly node: string
    readonly teamCommit: string
    readonly harnessCommit: string
    readonly stages: { readonly pageLoadMs: number; readonly workspaceConnectionMs: number; readonly ordinaryReadyMs: number; readonly teamModeReadyMs: number }
    readonly navigation: { readonly domInteractiveMs: number; readonly domContentLoadedMs: number; readonly loadEventMs: number; readonly transferBytes: number } | null
    readonly bundle: string
    readonly console: { readonly warnings: readonly string[]; readonly pageErrors: readonly string[] }
  }> = []
  for (let sample = 1; sample <= sampleCount; sample += 1) {
    activeScaffold = await launchWebScaffold({ harnessHome: HOME, profile: { packages: [{ dir: STAGED_BUNDLE, enabled: true }] } })
    browser = await chromium.launch({ headless: true, executablePath: CHROME })
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
      const consoleWatch = watchConsole(page)
      const navigationBegin = performance.now()
      await page.goto(activeScaffold.authenticatedUrl, { waitUntil: 'load' })
      const loadMs = performance.now() - navigationBegin
      const navigation = await page.evaluate(() => {
        const entry = window.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
        return entry === undefined ? null : { domInteractiveMs: entry.domInteractive, domContentLoadedMs: entry.domContentLoadedEventEnd, loadEventMs: entry.loadEventEnd, transferBytes: entry.transferSize }
      })
      const workspaceBegin = performance.now()
      await connectFreshWorkspaceZh(page, activeScaffold.workspaceCwd, 'team-performance')
      const workspaceMs = performance.now() - workspaceBegin
      await expect.poll(() => page.locator('[data-composer-input]').count()).toBeGreaterThan(0)
      const ordinaryReadyMs = performance.now() - workspaceBegin
      const teamBegin = performance.now()
      await page.getByRole('button', { name: '团队', exact: true }).click()
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.agentTeamMode ?? null)).toBe('team')
      const teamReadyMs = performance.now() - teamBegin
      samples.push({
        scenario: 'browser-loading', sample, startedAt: new Date().toISOString(), node: process.version,
        teamCommit: process.env.DSH_TEAM_COMMIT ?? 'unknown', harnessCommit: process.env.DSH_HARNESS_COMMIT ?? 'unknown',
        stages: { pageLoadMs: Math.round(loadMs * 1000) / 1000, workspaceConnectionMs: Math.round(workspaceMs * 1000) / 1000,
          ordinaryReadyMs: Math.round(ordinaryReadyMs * 1000) / 1000, teamModeReadyMs: Math.round(teamReadyMs * 1000) / 1000 },
        navigation, bundle: 'packages/client-agent-team/lib/client.js', console: consoleWatch,
      })
    } finally {
      await browser.close(); browser = undefined
      const scaffold = activeScaffold
      activeScaffold = undefined
      await scaffold?.close()
      await rm(join(HOME, 'profiles', 'scaffold'), { recursive: true, force: true })
    }
  }
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const output = join(TEAM_ROOT, 'artifacts/team-perf/browser/runs', runId)
  await mkdir(output, { recursive: true })
  const metrics = ['pageLoadMs', 'workspaceConnectionMs', 'ordinaryReadyMs', 'teamModeReadyMs'] as const
  const summary = Object.fromEntries(metrics.map(metric => [metric, {
    count: samples.length, p50: percentile(samples.map(sample => sample.stages[metric]), 0.5),
    p95: percentile(samples.map(sample => sample.stages[metric]), 0.95), p99: percentile(samples.map(sample => sample.stages[metric]), 0.99),
  }]))
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify({ runId, node: process.version, teamCommit: samples[0]?.teamCommit ?? 'unknown', harnessCommit: samples[0]?.harnessCommit ?? 'unknown', chrome: CHROME, viewport: { width: 1440, height: 960 }, sampleCount }, null, 2)}\n`)
  await writeFile(join(output, 'samples.jsonl'), `${samples.map(sample => JSON.stringify(sample)).join('\n')}\n`)
  await writeFile(join(output, 'summary.json'), `${JSON.stringify({ runId, sampleCount, summary }, null, 2)}\n`)
  console.log(JSON.stringify({ scenario: 'browser-loading', runId, sampleCount, summary, latest: samples.at(-1) }))
}, 180_000)
