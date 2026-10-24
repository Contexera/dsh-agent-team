import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type { AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>

async function openTable(pool: MemoryMediaPool): Promise<Table> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  return domain.table('operations') as unknown as Table
}

/** Close every open domain over this pool so the next open replays what the pool now holds. */
async function closeAll(): Promise<void> {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
}

function storedRecords(pool: MemoryMediaPool): AgentTeamOperation[] {
  return [...pool.media.get('agent_team')!.tables.get('operations')!.values()]
    .map(record => record as AgentTeamOperation)
    .sort((left, right) => left.sequence - right.sequence)
}

function storedKinds(pool: MemoryMediaPool): string[] {
  return storedRecords(pool).map(operation => operation.kind)
}

/** Append one hand-built record to the pool, linked after the current head. */
function appendStored(pool: MemoryMediaPool, record: Omit<AgentTeamOperation, 'sequence' | 'previousOperationId' | 'operationId'>): void {
  const head = storedRecords(pool).at(-1)!
  const sequence = head.sequence + 1
  const operationId = `operation:appended-${sequence}` as AgentTeamOperationId
  pool.media.get('agent_team')!.tables.get('operations')!.set(operationId, { ...record, sequence, operationId, previousOperationId: head.operationId })
}

function marker(version: number, actor: AgentTeamOperation['actor'] = { kind: 'host', handle: 'agent-team' }) {
  return { kind: 'team/rules-version-adopted', requestId: `test:rules-version-${version}-${crypto.randomUUID()}` as AgentTeamRequestId,
    occurredAt: '2026-10-23T00:00:00.000Z', actor, data: { version } } as Omit<AgentTeamOperation, 'sequence' | 'previousOperationId' | 'operationId'>
}

const createProject = (ledger: AgentTeamLedger, name: string) => ledger.createProject({
  requestId: `test:create-${name}` as AgentTeamRequestId, actor: agentTeamHumanActor(), workspaceId: alpha, name, description: '', memberIds: [],
})

describe('rules version markers', () => {
  it('writes no marker while a ledger is held at rules version 1', async () => {
    const pool = new MemoryMediaPool()
    const ledger = new AgentTeamLedger(await openTable(pool), { rulesVersion: 1 })
    await ledger.initialize()
    await createProject(ledger, 'plain')
    expect(storedKinds(pool)).toEqual(['team/initialized', 'team/project-created'])
  })

  it('records a later version right after initializing a fresh ledger', async () => {
    const pool = new MemoryMediaPool()
    const ledger = new AgentTeamLedger(await openTable(pool), { rulesVersion: 2 })
    await ledger.initialize()
    expect(storedKinds(pool)).toEqual(['team/initialized', 'team/rules-version-adopted'])
    expect(storedRecords(pool)[1]).toMatchObject({ actor: { kind: 'host', handle: 'agent-team' }, data: { version: 2 } })
  })

  it('adopts a later version once, ahead of every write queued behind initialize', async () => {
    const pool = new MemoryMediaPool()
    const before = new AgentTeamLedger(await openTable(pool), { rulesVersion: 1 })
    await before.initialize()
    await createProject(before, 'old')
    await closeAll()

    const upgraded = new AgentTeamLedger(await openTable(pool), { rulesVersion: 2 })
    // The Host awaits initialize before its startup writes, but a Remote call can queue in between; the marker must still lead.
    const initialized = upgraded.initialize()
    const queued = createProject(upgraded, 'new')
    await Promise.all([initialized, queued])
    expect(storedKinds(pool)).toEqual(['team/initialized', 'team/project-created', 'team/rules-version-adopted', 'team/project-created'])
    await closeAll()

    const reopened = new AgentTeamLedger(await openTable(pool), { rulesVersion: 2 })
    await reopened.initialize()
    expect(storedKinds(pool).filter(kind => kind === 'team/rules-version-adopted')).toHaveLength(1)
    await closeAll()

    const later = new AgentTeamLedger(await openTable(pool), { rulesVersion: 3 })
    await later.initialize()
    expect(storedRecords(pool).filter(operation => operation.kind === 'team/rules-version-adopted').map(operation => operation.data))
      .toEqual([{ version: 2 }, { version: 3 }])
  })

  it('refuses a ledger that a newer build has moved to a later version', async () => {
    const pool = new MemoryMediaPool()
    await new AgentTeamLedger(await openTable(pool), { rulesVersion: 3 }).initialize()
    await closeAll()
    const table = await openTable(pool)
    expect(() => new AgentTeamLedger(table)).toThrow(/adopted rules version 3, but this build implements up to 2; open it with a newer release/)
  })

  it.each([
    ['repeats a version', [marker(2), marker(2)], /adopts rules version 2 after version 2/],
    ['goes back to an earlier version', [marker(3), marker(2)], /adopts rules version 2 after version 3/],
    ['is not written by the Host', [marker(2, agentTeamHumanActor())], /invalid rules version authority/],
  ])('rejects a ledger whose marker %s', async (_label, markers, failure) => {
    const pool = new MemoryMediaPool()
    await new AgentTeamLedger(await openTable(pool), { rulesVersion: 1 }).initialize()
    await closeAll()
    for (const record of markers) appendStored(pool, record)
    const table = await openTable(pool)
    expect(() => new AgentTeamLedger(table, { rulesVersion: 3 })).toThrow(failure)
  })
})
