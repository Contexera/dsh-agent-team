import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const script = 'scripts/team-performance/team-performance-baseline.ts'

describe('performance scenario contracts', () => {
  it('does not run without explicit opt-in', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
      cwd: root, encoding: 'utf8', env: { ...process.env, DSH_BENCH_TEAM: '0' }, timeout: 20_000,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Set DSH_BENCH_TEAM=1')
  })

  it('rejects empty comparisons, unavailable metrics, and zero-to-positive regressions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'team-compare-'))
    const metric = (value: number | null) => ({ summary: [{ scenario: 'probe', metrics: {
      elapsedMs: { count: value === null ? 0 : 1, p50: value, p95: value, p99: value },
    } }] })
    try {
      for (const [before, after, status] of [
        [metric(10), metric(10), 0], [metric(10), metric(20), 1], [metric(10), metric(null), 1],
        [metric(0), metric(20), 1], [{ summary: [] }, { summary: [] }, 1],
      ] as const) {
        await writeFile(join(directory, 'before.json'), JSON.stringify(before))
        await writeFile(join(directory, 'after.json'), JSON.stringify(after))
        const result = spawnSync(process.execPath, ['scripts/team-performance/compare-team-performance.mjs', '--json', '--max-regression', '20',
          join(directory, 'before.json'), join(directory, 'after.json')], { cwd: root, encoding: 'utf8' })
        expect(result.status, result.stderr).toBe(status)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('records fresh-process boot and real cold/warm Team tool replies', async () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, DSH_BENCH_TEAM: '1', DSH_BENCH_SAMPLES: '1', DSH_BENCH_WARMUPS: '0',
        DSH_BENCH_SCENARIOS: 'host-boot,collaboration-agent-turn,collaboration-fanout', DSH_BENCH_THREADS: '20', DSH_BENCH_FOLLOWERS: '1' },
    })
    expect(result.status, result.stderr).toBe(0)
    const summary = JSON.parse(result.stdout)
    expect(summary.sampleCount).toBe(3)
    const directory = resolve(summary.outputRoot)
    expect(directory.startsWith(join(root, 'artifacts/team-perf/runs/'))).toBe(true)
    try {
      const samples = (await readFile(join(directory, 'samples.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const fanout = samples.find(sample => sample.scenario === 'collaboration-fanout')
      expect(fanout.counters).toMatchObject({ unreadThreads: 20, notificationDispatches: 2, expectedDispatches: 2 })
      const boot = samples.find(sample => sample.scenario === 'host-boot')
      expect(boot.counters).toMatchObject({ bootMembers: 0, restoredMembers: 2 })
      expect(boot.stages.processToHostReadyMs).toBeGreaterThan(boot.stages.hostBootMs)
      expect(boot.stages.restoreActivationMs).toBeGreaterThan(0)
      const collaboration = samples.find(sample => sample.scenario === 'collaboration-agent-turn')
      expect(collaboration.counters).toMatchObject({ reads: 2, replies: 2, modelRequests: 6 })
      expect(collaboration.workload.response).toBe('team-tool-read-reply')
      for (const prefix of ['', 'warm']) {
        const key = (name: string) => prefix === '' ? name : prefix + name[0]!.toUpperCase() + name.slice(1)
        for (const name of ['noticeMessageId', 'turnId', 'readCallId', 'replyCallId', 'readOperationId', 'replyOperationId']) {
          expect(collaboration.ids[key(name)]).toBeTypeOf('string')
        }
        expect(collaboration.stages[key('triggerToAgentIdleMs')]).toBeGreaterThanOrEqual(collaboration.stages[key('triggerToReplyCommittedMs')])
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 35_000)
})
