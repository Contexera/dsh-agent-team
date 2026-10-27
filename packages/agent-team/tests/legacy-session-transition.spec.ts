import { afterEach, describe, expect, it, vi } from 'vitest'
// Every test here boots a Host over a throwaway tree, and the windows lane has
// stretched one cold replay to 2.7s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21). The SQLite case below keeps its own 30s argument.
vi.setConfig({ testTimeout: 30_000 })
import { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { addLedgerMember, alpha, committed, harness, ledgerAtBoot, requestId, storedPool, type TeamHarness } from './helpers/host-harness.ts'
import type { AgentTeamHostActor, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})


describe('AgentTeam legacy session-transition records', () => {
  /**
   * Append one durable operation to the harness's operation table as an earlier
   * build would have written it. Boot replay, not a live writer, is what has to
   * accept it: the retired renewal and rollover request paths are gone.
   */
  async function appendRecord(test: TeamHarness, operation: AgentTeamOperation): Promise<void> {
    await test.facility.get('agent_team')!.table('operations').put(operation.operationId, operation)
  }

  function rolledOverRecord(
    sequence: number,
    previousOperationId: AgentTeamOperationId,
    actor: AgentTeamOperation['actor'],
    data: Extract<AgentTeamOperation, { kind: 'team/member-session-rolled-over' }>['data'],
  ): AgentTeamOperation {
    return {
      sequence,
      operationId: `operation:legacy-rollover-${sequence}` as AgentTeamOperationId,
      requestId: `legacy:rollover:${sequence}` as AgentTeamRequestId,
      occurredAt: '2026-01-01T00:00:00.000Z',
      actor,
      previousOperationId,
      kind: 'team/member-session-rolled-over',
      data,
    }
  }

  it('replays a Member-authored rollover that moves exactly the sessionId', async () => {
    const test = await harness()
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    const newSessionId = SessionId(`agent-team-rollover-${crypto.randomUUID()}`)
    const head = ledger.status().sequence
    const previousOperationId = [...test.facility.get('agent_team')!.table('operations').keys()].at(-1) as AgentTeamOperationId
    await appendRecord(test, rolledOverRecord(head + 1, previousOperationId, actor, {
      member: { ...member, sessionId: newSessionId },
      previousSessionId: member.sessionId,
      newSessionId,
      handoffEventSeq: 42 as never,
      trigger: 'model',
    }))

    const replayed = ledgerAtBoot(test)
    // The recorded envelope moves exactly the binding; identity and memory stay.
    expect(replayed.getMember(member.memberId)).toMatchObject({
      memberId: member.memberId, handle: member.handle, state: 'enabled',
      privateMemoryPath: member.privateMemoryPath, sessionId: newSessionId,
    })
    expect(replayed.previousSessionForMember(member.memberId)).toBe(member.sessionId)
    expect(() => replayed.validate()).not.toThrow()
  })

  it('replays a checkpoint-seeded rollover and rejects one that moves more than the sessionId', async () => {
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    const newSessionId = SessionId(`agent-team-rollover-${crypto.randomUUID()}`)
    const head = ledger.status().sequence
    const previousOperationId = [...test.facility.get('agent_team')!.table('operations').keys()].at(-1) as AgentTeamOperationId
    await appendRecord(test, rolledOverRecord(head + 1, previousOperationId, actor, {
      member: { ...member, sessionId: newSessionId },
      previousSessionId: member.sessionId,
      newSessionId,
      handoffEventSeq: 5 as never,
      trigger: 'model',
      sourceSessionId: member.sessionId,
      sourceThroughSeq: 30 as never,
      checkpointRef: `context-checkpoint-${'a'.repeat(64)}` as never,
    }))
    expect(() => ledgerAtBoot(test).validate()).not.toThrow()
    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.entries()]
    await test.fiber.dispose()
    cleanups.pop()

    // Forging the recorded Member snapshot — the handle changed alongside the
    // sessionId — must not replay.
    const forged = records.map(([key, operation]) => {
      if (typeof operation !== 'object' || operation === null || (operation as AgentTeamOperation).kind !== 'team/member-session-rolled-over') return [key, operation] as [string, unknown]
      const rolled = operation as Extract<AgentTeamOperation, { kind: 'team/member-session-rolled-over' }>
      return [key, { ...rolled, data: { ...rolled.data, member: { ...rolled.data.member, handle: 'impostor' } } }] as [string, unknown]
    })
    await expect(harness(storedPool(forged))).rejects.toThrow(/invalid Member session rollover/)
  })

  it('rejects a forged rollover whose actor is not the target Member', async () => {
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const ledger = ledgerAtBoot(test)
    const { member } = await addLedgerMember(ledger, undefined)
    const { actor: other } = await addLedgerMember(ledger, undefined, `member:agent-${crypto.randomUUID()}`)
    const newSessionId = SessionId(`agent-team-rollover-${crypto.randomUUID()}`)
    const head = ledger.status().sequence
    const previousOperationId = [...test.facility.get('agent_team')!.table('operations').keys()].at(-1) as AgentTeamOperationId
    await appendRecord(test, rolledOverRecord(head + 1, previousOperationId, other, {
      member: { ...member, sessionId: newSessionId },
      previousSessionId: member.sessionId,
      newSessionId,
      handoffEventSeq: 1 as never,
      trigger: 'model',
    }))
    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.entries()]
    await test.fiber.dispose()
    cleanups.pop()
    await expect(harness(storedPool(records))).rejects.toThrow(/rolled-over Member must match its actor/)
  })
})
