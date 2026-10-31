import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const execFile = promisify(execFileCallback)
const samples = process.env.DSH_BENCH_MATRIX_SAMPLES ?? process.env.DSH_BENCH_SAMPLES ?? '3'
const warmups = process.env.DSH_BENCH_MATRIX_WARMUPS ?? process.env.DSH_BENCH_WARMUPS ?? '1'
const defaultCases = [
  'member-activation-batch:8:1',
  'ledger-read-memory:1:1', 'ledger-read-memory:20:1', 'ledger-read-memory:100:1',
  'ledger-replay-sqlite:1:1', 'ledger-replay-sqlite:20:1', 'ledger-replay-sqlite:100:1',
  'collaboration-fanout:1:1', 'collaboration-fanout:1:2', 'collaboration-fanout:1:4',
  'collaboration-fanout:1:8', 'collaboration-fanout:20:4', 'collaboration-fanout:1:32',
  'session-fold:10000:1', 'session-replay-jsonl:10000:1',
]
const cases = (process.env.DSH_BENCH_MATRIX_CASES ?? defaultCases.join(','))
  .split(',').map(value => value.trim()).filter(Boolean).map((value, index) => {
    const [scenario, threads, followers] = value.split(':')
    if (scenario === undefined || threads === undefined || followers === undefined
      || !Number.isInteger(Number(threads)) || !Number.isInteger(Number(followers))) {
      throw new Error(`Invalid matrix case '${value}' at index ${index}; use scenario:threads:followers`)
    }
    return { scenario, threads: Number(threads), followers: Number(followers) }
  })
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const outputRoot = resolve(root, 'artifacts/team-perf/matrices', runId)
const baseline = join(root, 'scripts/team-performance/team-performance-baseline.ts')

await mkdir(outputRoot, { recursive: true })
await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify({ runId, startedAt: new Date().toISOString(), samples, warmups, cases, node: process.version }, null, 2)}\n`)

const results = []
for (const [index, current] of cases.entries()) {
  const env = {
    ...process.env,
    DSH_BENCH_TEAM: '1', DSH_BENCH_SAMPLES: samples, DSH_BENCH_WARMUPS: warmups,
    DSH_BENCH_SCENARIOS: current.scenario, DSH_BENCH_THREADS: String(current.threads), DSH_BENCH_FOLLOWERS: String(current.followers),
    ...(current.scenario === 'member-activation-batch' ? { DSH_BENCH_MEMBERS: String(current.threads) } : {}),
    ...(current.scenario === 'session-fold' || current.scenario === 'session-replay-jsonl' ? { DSH_BENCH_SESSION_EVENTS: String(current.threads) } : {}),
  }
  try {
    const result = await execFile(process.execPath, ['--import', 'tsx', baseline], { cwd: root, env, maxBuffer: 4 * 1024 * 1024 })
    const match = result.stdout.match(/"outputRoot":\s*"([^"]+)"/)
    if (match?.[1] === undefined) throw new Error('benchmark output did not report outputRoot')
    const summary = JSON.parse(await readFile(join(match[1], 'summary.json'), 'utf8'))
    results.push({ index, ...current, status: 'passed', outputRoot: match[1], summary })
  } catch (error) {
    results.push({ index, ...current, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    await writeFile(join(outputRoot, 'results.json'), `${JSON.stringify({ runId, results }, null, 2)}\n`)
    throw new Error(`matrix case ${index} (${current.scenario}:${current.threads}:${current.followers}) failed`, { cause: error })
  }
  await writeFile(join(outputRoot, 'results.json'), `${JSON.stringify({ runId, results }, null, 2)}\n`)
}

console.log(JSON.stringify({ runId, outputRoot, results }, null, 2))
