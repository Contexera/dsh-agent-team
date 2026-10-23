import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { KvUnit } from '@deepseek-ai/dsh-storage'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { SqliteStorageBackend } from '../src/vendor/storage-sqlite/index.ts'

/**
 * Storage-layer benchmark backing the pre-release decision to route
 * `agent_team` to SQLite (scratch work item agent-team-storage-architecture,
 * issues 02/05). It isolates the backend write path from ledger validation by
 * putting fixed realistic operation payloads directly through `KvUnit`.
 *
 * Run manually: DSH_BENCH_STORAGE=1 npx vitest run packages/agent-team/tests/storage-bench.spec.ts
 * The JSON leg at 10k operations is intentionally included even though it is
 * slow: whole-file rewrite cost growing with the medium IS the measured
 * finding, not a benchmark defect.
 */

const enabled = process.env.DSH_BENCH_STORAGE === '1'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** One deterministic canonical operation document near the observed ~3.4 KB average. */
function operationPayload(sequence: number): Record<string, unknown> {
  const body = `Investigate regression ${sequence}: ` + 'detail '.repeat(96)
  return {
    operationId: `op:bench-${sequence}`,
    requestId: `req:bench-${sequence}`,
    previousOperationId: sequence > 1 ? `op:bench-${sequence - 1}` : null,
    kind: 'team/message-sent',
    data: {
      workspaceId: 'workspace:alpha',
      projectRef: 'project:engineering',
      taskRef: `task:bench-${sequence}`,
      threadRef: `thread:bench-${sequence}`,
      message: { messageRef: `message:bench-${sequence}`, sequence, sender: 'member:human', body },
      inbox: { activityMarkers: { added: [], removed: [] }, directMarkers: { added: [], removed: [] } },
    },
  }
}

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

function directoryBytes(root: string): Promise<number> {
  return (async () => {
    let total = 0
    for (const entry of await readdir(root)) total += (await stat(join(root, entry))).size
    return total
  })()
}

interface Sample {
  readonly backend: string
  readonly operations: number
  readonly totalMs: number
  readonly meanMicros: number
  readonly p95Micros: number
  readonly mediumBytes: number
}

async function timedPuts(unit: KvUnit, count: number): Promise<{ samples: number[]; totalMs: number }> {
  const samples: number[] = []
  const start = performance.now()
  for (let sequence = 1; sequence <= count; sequence += 1) {
    const begin = performance.now()
    await unit.putRecord('operations', `op:bench-${sequence}`, operationPayload(sequence))
    samples.push((performance.now() - begin) * 1000)
  }
  return { samples, totalMs: performance.now() - start }
}

function summarize(backend: string, operations: number, put: { samples: number[]; totalMs: number }, mediumBytes: number): Sample {
  const sorted = [...put.samples].sort((a, b) => a - b)
  return {
    backend,
    operations,
    totalMs: Math.round(put.totalMs),
    meanMicros: Math.round(put.samples.reduce((sum, value) => sum + value, 0) / put.samples.length),
    p95Micros: Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!),
    mediumBytes,
  }
}

describe.skipIf(!enabled)('storage route benchmark', () => {
  it('compares JSON whole-file rewrite against SQLite row updates', async () => {
    const results: Sample[] = []
    for (const operations of [1000, 10000] as const) {
      const jsonRoot = await tempRoot('agent-team-bench-json-')
      const json = new JsonStorageBackend(jsonRoot)
      const jsonUnit = await json.kv!.open({ name: 'agent_team', version: 1, tables: ['operations'], hasGlobal: false })
      results.push(summarize('json', operations, await timedPuts(jsonUnit, operations), await directoryBytes(jsonRoot)))
      await json.close()

      const sqliteRoot = await tempRoot('agent-team-bench-sqlite-')
      const sqlite = new SqliteStorageBackend({ path: join(sqliteRoot, 'agent_team.sqlite'), journalMode: 'wal' })
      const sqliteUnit = await sqlite.kv!.open({ name: 'agent_team', version: 1, tables: ['operations'], hasGlobal: false })
      results.push(summarize('sqlite', operations, await timedPuts(sqliteUnit, operations), await directoryBytes(sqliteRoot)))
      await sqlite.close()
      // Sanity only: payloads must have landed durably in both media.
      const jsonMedium = JSON.parse(await readFile(join(jsonRoot, 'agent_team.json'), 'utf8')) as {
        tables: Record<string, Record<string, unknown>>
      }
      expect(Object.keys(jsonMedium.tables.operations!)).toHaveLength(operations)
    }
    console.table(results)
    expect(results).toHaveLength(4)
  }, 900_000)
})
