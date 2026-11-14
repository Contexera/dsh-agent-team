/**
 * Shared boot helper for pure Ledger specs.
 *
 * Boots `Context + Storage + MemoryStorageBackend + DomainFacility + AgentTeamLedger`
 * without starting the full `AgentTeam` Host service, registers automatic teardown
 * via `onTestFinished`, and validates the ledger on close unless `{ validateLedger: false }`.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { AgentTeamLedger } from '../../src/ledger.ts'
import { agentTeamDomainSpec } from '../../src/spec.ts'
import type { AgentTeamOperation, AgentTeamOperationId } from '../../src/types.ts'
import { TestLedgerHuman } from './domain-handles.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './memory-backend.ts'
import { registerAutoCleanup, runCleanupSteps } from './team-host-fixture.ts'

export interface OpenTestLedgerOptions {
  readonly pool?: MemoryMediaPool
  readonly workspaceId?: WorkspaceId
  readonly ledgerOptions?: ConstructorParameters<typeof AgentTeamLedger>[1]
  readonly initialize?: boolean
  readonly validateLedger?: boolean
  readonly registerCleanup?: (fn: () => Promise<void>) => void
}

export interface TestTable {
  readonly ctx: Context
  readonly pool: MemoryMediaPool
  readonly facility: DomainFacility
  readonly table: KvTable<AgentTeamOperationId, AgentTeamOperation>
  readonly close: () => Promise<void>
}

export interface TestLedger extends TestTable {
  readonly ledger: AgentTeamLedger
  readonly human: TestLedgerHuman
}

export async function openTestTable(options?: {
  readonly pool?: MemoryMediaPool
  readonly registerCleanup?: (fn: () => Promise<void>) => void
}): Promise<TestTable> {
  const pool = options?.pool ?? new MemoryMediaPool()
  let ctx: Context | undefined
  let facility: DomainFacility | undefined
  let closed = false

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await runCleanupSteps([
      () => ctx?.fiber.dispose(),
      () => facility?.closeAll(),
    ])
  }

  registerAutoCleanup(close, options?.registerCleanup)

  try {
    ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    const domain = await facility.open(agentTeamDomainSpec)
    const table = domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
    return { ctx, pool, facility, table, close }
  } catch (initError) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([initError, cleanupError], 'openTestTable initialization and cleanup both failed')
    }
    throw initError
  }
}

export async function openTestLedger(options?: OpenTestLedgerOptions): Promise<TestLedger> {
  const pool = options?.pool ?? new MemoryMediaPool()
  const workspaceId = options?.workspaceId ?? WorkspaceId('workspace:alpha')
  const shouldValidate = options?.validateLedger ?? true
  let ctx: Context | undefined
  let facility: DomainFacility | undefined
  let ledger: AgentTeamLedger | undefined
  let closed = false

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await runCleanupSteps([
      () => {
        if (!shouldValidate || ledger === undefined) return
        ledger.validate()
      },
      () => ctx?.fiber.dispose(),
      () => facility?.closeAll(),
    ])
  }

  registerAutoCleanup(close, options?.registerCleanup)

  try {
    ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    const domain = await facility.open(agentTeamDomainSpec)
    const table = domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
    ledger = new AgentTeamLedger(table, options?.ledgerOptions)
    if (options?.initialize) await ledger.initialize()
    const human = new TestLedgerHuman(ledger, workspaceId)
    return { ctx, pool, facility, table, ledger, human, close }
  } catch (initError) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([initError, cleanupError], 'openTestLedger initialization and cleanup both failed')
    }
    throw initError
  }
}
