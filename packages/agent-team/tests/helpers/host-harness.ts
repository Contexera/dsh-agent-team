/**
 * Shared boot helpers for the Host ledger specs.
 *
 * Every spec in this directory boots the real `AgentTeam` plugin over a
 * throwaway storage domain, so the two builders here are the one copy of that
 * arrangement: a spec picks the backend it needs and describes behavior. They
 * are deliberately not a fixture registry — a spec that needs a different
 * arrangement builds it locally and keeps it local.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './memory-backend.ts'
import { provideQuietTokenMeter } from './team-host-fixture.ts'
import { SqliteStorageBackend } from '../../src/vendor/storage-sqlite/index.ts'
import AgentTeam from '../../src/index.ts'
import { agentTeamDomainSpec } from '../../src/spec.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../../src/ledger.ts'
import type { AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTask } from '../../src/types.ts'

export interface TeamHarness {
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly facility: DomainFacility
}

export interface SqliteTeamHarness extends TeamHarness {
  readonly backend: SqliteStorageBackend
}

/** The two Workspaces the Host specs address; a third is built locally where a spec needs one. */
export const alpha = WorkspaceId('workspace:alpha')
export const beta = WorkspaceId('workspace:beta')

/** One stable request id per logical write, so a replay asserts the same id. */
export const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

/** Boot the Team over a memory pool: the default for anything that does not survive a restart. */
export async function harness(
  pool = new MemoryMediaPool(),
  workspaceIds = [alpha],
  config?: { readonly gate?: { readonly tokens?: number; readonly idleMs?: number; readonly judgeTimeoutMs?: number } },
): Promise<TeamHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => workspaceIds.includes(id) ? { id, path: process.cwd(), attachSession: async () => {} } : undefined,
    list: () => workspaceIds.map(id => ({ id, path: process.cwd() })),
    archiveSession: async () => {},
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  provideQuietTokenMeter(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = config === undefined ? await ctx.plugin(AgentTeam) : await ctx.plugin(AgentTeam, config)
  return { ctx, fiber, facility }
}

/** Boot the Team over a SQLite file: the shape that survives a dispose and a reopen. */
export async function sqliteHarness(path: string): Promise<SqliteTeamHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path, journalMode: 'delete' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', { get: (id: WorkspaceId) => ({ id, path: process.cwd(), attachSession: async () => {}, archiveSession: async () => {} }), list: () => [] })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  provideQuietTokenMeter(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  return { ctx, fiber, facility, backend }
}

/**
 * The ledger a cold boot builds over the table a harness already wrote. The
 * handle is reached through the facility rather than cached, so a reopened
 * harness is read through its own domain instance.
 */
export function ledgerAtBoot(test: TeamHarness): AgentTeamLedger {
  return new AgentTeamLedger(test.facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

/** One enabled Agent Member in one Workspace, plus the actor that speaks as it. */
export async function addLedgerMember(
  ledger: AgentTeamLedger,
  projectRef: string | undefined,
  memberId = `member:agent-${crypto.randomUUID()}`,
  description = 'Test Agent',
  handle = memberId.slice('member:'.length),
): Promise<{ readonly member: AgentTeamAgentMember; readonly actor: AgentTeamMemberActor }> {
  const member: AgentTeamAgentMember = {
    memberId: memberId as never,
    sessionId: SessionId(`session:${memberId}`),
    workspaceId: alpha,
    handle,
    description,
    presetId: 'team-member',
    privateMemoryPath: `/tmp/${memberId}`,
    state: 'enabled',
  }
  await ledger.addMember({ requestId: requestId(`add:${memberId}`), actor: agentTeamHumanActor(), member, handle: member.handle,
    description: member.description, presetId: member.presetId, workspaceId: alpha,
    projectRefs: projectRef === undefined ? [] : [projectRef as never] })
  return { member, actor: { kind: 'member', memberId: member.memberId, handle: member.handle } }
}

/** Starting a Thread is a Project owner's act; the Human grants the standing. */
export const makeOwner = (ledger: AgentTeamLedger, projectRef: string, memberId: string, workspaceId: WorkspaceId = alpha) =>
  ledger.addProjectOwner({ requestId: requestId(`owner:${workspaceId}:${projectRef}:${memberId}`), actor: agentTeamHumanActor(),
    workspaceId, projectRef: projectRef as never, memberId: memberId as never })

/** The in-progress and in-review rows of a Member's Task board, shaped like the address-book radar the board replaced. */
export function inFlight(ledger: AgentTeamLedger, workspaceId: WorkspaceId, memberId: AgentTeamAgentMember['memberId']) {
  const actor = { kind: 'member' as const, memberId, handle: ledger.getMember(memberId)!.handle }
  return ledger.taskBoard(actor, { workspaceId }).open.filter(item => item.task.status === 'in_progress' || item.task.status === 'in_review')
    .map(item => ({ threadRef: item.threadRef, taskRef: item.task.taskRef, status: item.task.status, subject: item.subject, taskNumber: item.taskNumber, members: item.liveClaimOwners }))
}

/** Narrow one result to its committed variant, naming the kind that refused it. */
export function committed<T extends { readonly kind: string }>(result: T): Extract<T, { readonly kind: 'committed' }> {
  if (result.kind !== 'committed') throw new Error(`expected committed result, received ${result.kind}`)
  return result as Extract<T, { readonly kind: 'committed' }>
}

/** Narrow one result to the shape that carries a Task. */
export function withTask<T extends { readonly task?: AgentTeamTask }>(result: T): T & { readonly task: AgentTeamTask } {
  if (result.task === undefined) throw new Error('expected Task overlay')
  return result as T & { readonly task: AgentTeamTask }
}

/** A memory pool already holding one stored operations table, for replay-only specs. */
export function storedPool(records: Array<[string, unknown]>, version: number = agentTeamDomainSpec.version): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('agent_team', version)
  pool.media.set('agent_team', { tables: new Map([['operations', new Map(records)]]), global: null })
  return pool
}

export { agentTeamHumanActor }
