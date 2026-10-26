import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// The vendored-vs-upstream byte diff writes and re-reads a real SQLite file, and
// the windows lane has stretched it to 2.2s against vitest's 5s default (worst
// of 11 CI runs, 2026-09-17..21), so the file keeps headroom.
vi.setConfig({ testTimeout: 30_000 })
// Byte-compatibility anchor for the vendored fork (GitHub issue #28): the
// upstream package stays a devDependency as the fixture reference, so this
// test always diffs the fork against the exact source version named in the
// vendor headers (0.1.5-rc.2).
import { SqliteStorageBackend as UpstreamSqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { SqliteStorageBackend as VendoredSqliteStorageBackend } from '../src/vendor/storage-sqlite/index.ts'

/**
 * Existing CLI users already own an `agent_team.sqlite` written by the
 * upstream backend. The fork must open that medium without migration, in both
 * directions, under the real ledger descriptor shape (`agent_team` v1,
 * `operations` table). Record-level equality is the contract: byte identity
 * of the file is deliberately NOT asserted (page layout, WAL state and
 * freelist placement are allowed to differ between writers).
 */

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function freshDbPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-team-sqlite-compat-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return join(root, 'agent_team.sqlite')
}

const DESCRIPTOR = { name: 'agent_team', version: 1, tables: ['operations'], hasGlobal: false } as const

/** Varied JSON payloads: nesting, unicode, and an empty-string key edge. */
function seedRecords(): Array<[string, unknown]> {
  return [
    ['op:0001', { kind: 'team/message-sent', body: 'Hello 世界 🌍', nested: { list: [1, 'two', null] } }],
    ['op:0002', { kind: 'team/task-created', count: 0, flags: { urgent: false } }],
    ['op:0003', { kind: 'team/claim', note: '' }],
  ]
}

describe('vendored sqlite backend byte compatibility', () => {
  it('reads a medium written by the upstream backend', async () => {
    const path = await freshDbPath()
    const upstream = new UpstreamSqliteStorageBackend({ path, journalMode: 'delete' })
    const writer = await upstream.kv.open({ ...DESCRIPTOR, tables: [...DESCRIPTOR.tables] })
    for (const [key, value] of seedRecords()) await writer.putRecord('operations', key, value)
    await upstream.close()

    const vendored = new VendoredSqliteStorageBackend({ path, journalMode: 'delete' })
    const reader = await vendored.kv.open({ ...DESCRIPTOR, tables: [...DESCRIPTOR.tables] })
    const loaded = await reader.loadAll()
    expect(loaded.tables['operations']).toEqual(Object.fromEntries(seedRecords()))
    await vendored.close()
  })

  it('writes a medium the upstream backend still reads', async () => {
    const path = await freshDbPath()
    const vendored = new VendoredSqliteStorageBackend({ path, journalMode: 'delete' })
    const writer = await vendored.kv.open({ ...DESCRIPTOR, tables: [...DESCRIPTOR.tables] })
    for (const [key, value] of seedRecords()) await writer.putRecord('operations', key, value)
    await vendored.close()

    const upstream = new UpstreamSqliteStorageBackend({ path, journalMode: 'delete' })
    const reader = await upstream.kv.open({ ...DESCRIPTOR, tables: [...DESCRIPTOR.tables] })
    const loaded = await reader.loadAll()
    expect(loaded.tables['operations']).toEqual(Object.fromEntries(seedRecords()))
    await upstream.close()
  })
})

describe('vendored sqlite backend teardown', () => {
  // Teardown coverage the fork had none of: only `await close()` appeared
  // before, with nothing asserting that units are released or that repeated
  // and concurrent closes resolve once. It also pins the behavior `doClose`'s
  // snapshot-iteration preserves — every open unit still closes — so a future
  // restructuring of that loop is measured against real teardown, not lint.
  it('closes every open unit and refuses new ones once closing', async () => {
    const path = await freshDbPath()
    const backend = new VendoredSqliteStorageBackend({ path, journalMode: 'delete' })
    const descriptors = [DESCRIPTOR, { ...DESCRIPTOR, name: 'agent_team_second' }]
    const units = await Promise.all(descriptors.map(d => backend.kv.open({ ...d, tables: [...d.tables] })))
    for (const [index, unit] of units.entries()) await unit.putRecord('operations', `op:${index}`, { index })

    await backend.close()

    for (const [index, unit] of units.entries()) {
      // The unit released itself: a later primitive rejects with the closed code.
      await expect(unit.loadAll()).rejects.toMatchObject({ code: 'closed' })
      await expect(unit.putRecord('operations', `op:late`, { index })).rejects.toMatchObject({ code: 'closed' })
    }
    // The backend closed its whole table, so the double-open guard is empty and
    // `openUnit` refuses on the closing flag rather than on a stale entry.
    await expect(backend.kv.open({ ...DESCRIPTOR, tables: [...DESCRIPTOR.tables] })).rejects.toMatchObject({
      code: 'closed',
    })
  })

  it('resolves repeated and concurrent close calls once', async () => {
    const path = await freshDbPath()
    const backend = new VendoredSqliteStorageBackend({ path, journalMode: 'delete' })
    const unit = await backend.kv.open({ ...DESCRIPTOR, tables: [...DESCRIPTOR.tables] })
    await unit.putRecord('operations', 'op:0001', { ok: true })

    const first = backend.close()
    const second = backend.close()
    expect(second).toBe(first)
    await Promise.all([first, second])
    await expect(backend.close()).resolves.toBeUndefined()
  })
})
