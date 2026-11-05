import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
// The vendored-vs-upstream byte diff writes and re-reads a real SQLite file, and
// the windows lane has stretched it to 2.2s against vitest's 5s default (worst
// of 11 CI runs, 2026-09-17..21), so the file keeps headroom.
vi.setConfig({ testTimeout: 30_000 })
// Byte-compatibility anchor for the vendored fork (GitHub issue #28): the
// upstream package stays a devDependency as the declared reference, while the
// import itself resolves through the tsconfig path alias to the adjacent
// Harness checkout's source for that package — the same tree the rest of the
// suite compiles against. The vendor headers name 0.2.2-rc.1, and the
// candidate checkout carries exactly that version, so the fork is always
// diffed against the source its headers claim.
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

/**
 * The 0.2.2 storage contracts the fork had to adopt, each against a real
 * SQLite medium and the fork the Team ships: a batch delete behind one
 * transaction, the version stamp a changing write advances inside that same
 * transaction, `compatibleVersions` as the only way an older stamp opens, and
 * the `unknown-state` a denied rollback leaves behind. The stamp assertions
 * read the medium back through the upstream backend too, so the two writers
 * stay interchangeable on the new contract and not only on v1 records.
 */
describe('vendored sqlite backend 0.2.2 storage contracts', () => {
  /** A second connection to the same medium, to install a refusal or read the stamp. */
  function intruderAt(path: string): DatabaseSync {
    return new DatabaseSync(path)
  }

  /** The version the medium currently stamps this unit with. */
  function stampOf(path: string, unit: string): number {
    const db = intruderAt(path)
    try {
      return (db.prepare('SELECT version FROM units WHERE name = ?').get(unit) as { version: number }).version
    } finally {
      db.close()
    }
  }

  it('applies a batch delete as one transaction, restoring it when one row refuses', async () => {
    const path = await freshDbPath()
    const vendored = new VendoredSqliteStorageBackend({ path, journalMode: 'delete' })
    const unit = await vendored.kv.open({ ...DESCRIPTOR, tables: [...DESCRIPTOR.tables] })
    await unit.putRecord('operations', 'op:0001', { n: 1 })
    await unit.putRecord('operations', 'op:0002', { n: 2 })

    const intruder = intruderAt(path)
    try {
      // The batch dies on its second key, after the first delete already ran.
      intruder.exec('CREATE TRIGGER block_second BEFORE DELETE ON "u_agent_team_operations"'
        + " WHEN old.key = 'op:0002' BEGIN SELECT RAISE(ABORT, 'blocked'); END")
      await expect(unit.deleteRecords('operations', ['op:0001', 'op:0002'])).rejects.toThrow(/blocked/)
      // One transaction, so the row deleted before the failing one is back.
      expect((await unit.loadAll()).tables['operations']).toEqual({ 'op:0001': { n: 1 }, 'op:0002': { n: 2 } })
      intruder.exec('DROP TRIGGER block_second')
    } finally {
      intruder.close()
    }

    // A repeated key deletes once, and a key that is not there is not an error.
    await unit.deleteRecords('operations', ['op:0001', 'op:0002', 'op:0001', 'op:absent'])
    expect((await unit.loadAll()).tables['operations']).toEqual({})
    // An empty batch is a no-op rather than a needless transaction.
    await expect(unit.deleteRecords('operations', [])).resolves.toBeUndefined()
    expect((await unit.loadAll()).tables['operations']).toEqual({})
    await vendored.close()
  })

  it('re-stamps the medium inside the write that adopts a newer version, and the older version is then refused', async () => {
    const path = await freshDbPath()
    const writer = new VendoredSqliteStorageBackend({ path, journalMode: 'delete' })
    const v1 = await writer.kv.open({ ...DESCRIPTOR, tables: [...DESCRIPTOR.tables] })
    for (const [key, value] of seedRecords()) await v1.putRecord('operations', key, value)
    await writer.close()
    expect(stampOf(path, DESCRIPTOR.name)).toBe(1)

    // Without the compatibility list the newer descriptor refuses the older stamp outright.
    const refusing = new VendoredSqliteStorageBackend({ path, journalMode: 'delete' })
    await expect(refusing.kv.open({ ...DESCRIPTOR, version: 2, tables: [...DESCRIPTOR.tables] }))
      .rejects.toMatchObject({ code: 'version-mismatch' })
    await refusing.close()
    expect(stampOf(path, DESCRIPTOR.name)).toBe(1)

    // Reading the older stamp is free; so is a delete that removes nothing.
    const vendored = new VendoredSqliteStorageBackend({ path, journalMode: 'delete' })
    const adopted = await vendored.kv.open({ ...DESCRIPTOR, version: 2, compatibleVersions: [1], tables: [...DESCRIPTOR.tables] })
    expect((await adopted.loadAll()).tables['operations']).toEqual(Object.fromEntries(seedRecords()))
    await adopted.deleteRecords('operations', [])
    await adopted.deleteRecords('operations', ['op:absent'])
    expect(stampOf(path, DESCRIPTOR.name)).toBe(1)

    // The first write that changes a row adopts the new version in its own transaction.
    await adopted.putRecord('operations', 'op:0004', { adopted: true })
    expect(stampOf(path, DESCRIPTOR.name)).toBe(2)
    await vendored.close()

    // The stamp moved with that write, so a v1 reader is now the refused one.
    const reopened = new VendoredSqliteStorageBackend({ path, journalMode: 'delete' })
    await expect(reopened.kv.open({ ...DESCRIPTOR, tables: [...DESCRIPTOR.tables] }))
      .rejects.toMatchObject({ code: 'version-mismatch' })
    await reopened.close()

    // And the upstream backend still reads what the fork wrote under v2.
    const upstream = new UpstreamSqliteStorageBackend({ path, journalMode: 'delete' })
    const reader = await upstream.kv.open({ ...DESCRIPTOR, version: 2, compatibleVersions: [1], tables: [...DESCRIPTOR.tables] })
    expect((await reader.loadAll()).tables['operations']).toEqual({ ...Object.fromEntries(seedRecords()), 'op:0004': { adopted: true } })
    await upstream.close()
  })

  it('reports unknown-state when a failed batch cannot roll back, and refuses later use', async () => {
    const path = await freshDbPath()
    const vendored = new VendoredSqliteStorageBackend({ path, journalMode: 'delete' })
    const unit = await vendored.kv.open({ ...DESCRIPTOR, tables: [...DESCRIPTOR.tables] })
    await unit.putRecord('operations', 'op:0001', { n: 1 })
    await unit.putRecord('operations', 'op:0002', { n: 2 })

    const intruder = intruderAt(path)
    intruder.exec('CREATE TRIGGER block_second BEFORE DELETE ON "u_agent_team_operations"'
      + " WHEN old.key = 'op:0002' BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    // oxlint-disable-next-line typescript/unbound-method -- Delegated through Reflect.apply with the spy's receiver.
    const original = DatabaseSync.prototype.exec
    const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === 'ROLLBACK') throw new Error('rollback denied')
      Reflect.apply(original, this, [sql])
    })
    try {
      await expect(unit.deleteRecords('operations', ['op:0001', 'op:0002'])).rejects.toMatchObject({ code: 'unknown-state' })
      // The connection is still inside the abandoned transaction, so nothing may run on it again.
      await expect(unit.putRecord('operations', 'op:0003', { n: 3 })).rejects.toMatchObject({ code: 'unknown-state' })
      await expect(unit.loadAll()).rejects.toMatchObject({ code: 'unknown-state' })
    } finally {
      execSpy.mockRestore()
      intruder.close()
    }
    // The denied rollback leaves the connection in a transaction; the backend close is what releases it.
    await expect(unit.close()).resolves.toBeUndefined()
    await vendored.close()
  })
})
