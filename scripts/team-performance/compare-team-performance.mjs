import { readFile } from 'node:fs/promises'

const usage = 'Usage: node scripts/team-performance/compare-team-performance.mjs [--json] [--max-regression <percent>] <before-summary-or-matrix> <after-summary-or-matrix>'
const rawArgs = process.argv.slice(2)
const json = rawArgs.includes('--json')
const args = rawArgs.filter(value => value !== '--json')
let maxRegression
const positional = []
for (let index = 0; index < args.length; index += 1) {
  const value = args[index]
  if (value === '--max-regression') {
    const next = args[++index]
    maxRegression = Number(next)
  } else if (value.startsWith('--max-regression=')) {
    maxRegression = Number(value.slice('--max-regression='.length))
  } else {
    positional.push(value)
  }
}
if (positional.length !== 2 || (maxRegression !== undefined && (!Number.isFinite(maxRegression) || maxRegression < 0))) {
  console.error(usage)
  process.exit(2)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function summaryEntries(document, source) {
  if (Array.isArray(document.summary)) return document.summary.map(entry => ({ key: entry.scenario, summary: entry }))
  if (Array.isArray(document.results)) {
    return document.results.flatMap(result => {
      const summaries = result.summary?.summary
      if (!Array.isArray(summaries)) return []
      const key = `${result.scenario}:${result.threads}:${result.followers}`
      return summaries.map(summary => ({ key, summary }))
    })
  }
  throw new Error(`${source} is neither a run summary.json nor a matrix results.json`)
}

async function load(path) {
  return summaryEntries(await readJson(path), path)
}

function metricRows(beforeEntries, afterEntries) {
  const before = new Map(beforeEntries.map(entry => [entry.key, entry.summary]))
  const after = new Map(afterEntries.map(entry => [entry.key, entry.summary]))
  const rows = []
  const missingInAfter = []
  const missingInBefore = []
  const invalidMetrics = []
  const validMetric = (metric) => metric !== undefined
    && metric.count > 0
    && ['p50', 'p95', 'p99'].every(percentile => typeof metric[percentile] === 'number' && Number.isFinite(metric[percentile]))
  for (const [key, beforeSummary] of before) {
    const afterSummary = after.get(key)
    if (afterSummary === undefined) continue
    const metrics = new Set([...Object.keys(beforeSummary.metrics ?? {}), ...Object.keys(afterSummary.metrics ?? {})])
    for (const metric of metrics) {
      const inBefore = beforeSummary.metrics?.[metric] !== undefined
      const inAfter = afterSummary.metrics?.[metric] !== undefined
      if (inBefore && !inAfter) missingInAfter.push({ key, metric })
      if (!inBefore && inAfter) missingInBefore.push({ key, metric })
    }
    for (const metric of metrics) {
      const beforeMetric = beforeSummary.metrics?.[metric]
      const afterMetric = afterSummary.metrics?.[metric]
      if (beforeMetric !== undefined && !validMetric(beforeMetric)) invalidMetrics.push({ key, metric, side: 'before', reason: 'no valid measured percentiles' })
      if (afterMetric !== undefined && !validMetric(afterMetric)) invalidMetrics.push({ key, metric, side: 'after', reason: 'no valid measured percentiles' })
      for (const percentile of ['p50', 'p95', 'p99']) {
        const beforeValue = beforeSummary.metrics?.[metric]?.[percentile]
        const afterValue = afterSummary.metrics?.[metric]?.[percentile]
        if (typeof beforeValue !== 'number' || typeof afterValue !== 'number') continue
        const deltaMs = afterValue - beforeValue
        const deltaPercent = beforeValue === 0 ? null : (deltaMs / beforeValue) * 100
        rows.push({ key, metric, percentile, before: beforeValue, after: afterValue, deltaMs, deltaPercent,
          zeroBaselineIncrease: beforeValue === 0 && afterValue > 0 })
      }
    }
  }
  return { rows, missingInAfter, missingInBefore, invalidMetrics }
}

const beforeEntries = await load(positional[0])
const afterEntries = await load(positional[1])
const beforeKeys = new Set(beforeEntries.map(entry => entry.key))
const afterKeys = new Set(afterEntries.map(entry => entry.key))
const metricComparison = metricRows(beforeEntries, afterEntries)
const { rows } = metricComparison
const regressions = maxRegression === undefined
  ? []
  : rows.filter(row => row.zeroBaselineIncrease || (row.deltaPercent !== null && row.deltaPercent > maxRegression))
const report = {
  before: positional[0],
  after: positional[1],
  maxRegressionPercent: maxRegression ?? null,
  missingInAfter: [...beforeKeys].filter(key => !afterKeys.has(key)),
  missingInBefore: [...afterKeys].filter(key => !beforeKeys.has(key)),
  missingMetricsInAfter: metricComparison.missingInAfter,
  missingMetricsInBefore: metricComparison.missingInBefore,
  invalidMetrics: metricComparison.invalidMetrics,
  noComparableMeasurements: rows.length === 0,
  rows,
  regressions,
}

if (json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`before: ${report.before}`)
  console.log(`after:  ${report.after}`)
  if (report.missingInAfter.length > 0) console.log(`missing in after: ${report.missingInAfter.join(', ')}`)
  if (report.missingInBefore.length > 0) console.log(`missing in before: ${report.missingInBefore.join(', ')}`)
  if (report.missingMetricsInAfter.length > 0) console.log(`missing metrics in after: ${report.missingMetricsInAfter.map(entry => `${entry.key}.${entry.metric}`).join(', ')}`)
  if (report.missingMetricsInBefore.length > 0) console.log(`missing metrics in before: ${report.missingMetricsInBefore.map(entry => `${entry.key}.${entry.metric}`).join(', ')}`)
  if (report.invalidMetrics.length > 0) console.log(`invalid metrics: ${report.invalidMetrics.map(entry => `${entry.side} ${entry.key}.${entry.metric} (${entry.reason})`).join(', ')}`)
  for (const row of rows) {
    const delta = row.zeroBaselineIncrease ? 'from zero' : row.deltaPercent === null ? 'n/a' : `${row.deltaPercent >= 0 ? '+' : ''}${row.deltaPercent.toFixed(1)}%`
    console.log(`${row.key} ${row.metric}.${row.percentile}: ${row.before.toFixed(3)}ms -> ${row.after.toFixed(3)}ms (${delta})`)
  }
  if (report.noComparableMeasurements) console.log('no comparable measurements')
  if (maxRegression !== undefined) console.log(`regressions over ${maxRegression}%: ${regressions.length}`)
}
if (maxRegression !== undefined && (rows.length === 0 || regressions.length > 0 || report.missingInAfter.length > 0 || report.missingInBefore.length > 0
  || report.missingMetricsInAfter.length > 0 || report.missingMetricsInBefore.length > 0 || report.invalidMetrics.length > 0)) process.exitCode = 1
