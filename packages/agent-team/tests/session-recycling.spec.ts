import { afterEach, describe, expect, it, vi } from 'vitest'
// Every test here boots a Host over a throwaway tree, and the windows lane has
// stretched one cold replay to 2.7s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21). The SQLite case below keeps its own 30s argument.
vi.setConfig({ testTimeout: 30_000 })
import { SessionId } from '@deepseek-ai/dsh-session'
import { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/index.ts'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { addLedgerMember, alpha, committed, harness, ledgerAtBoot, requestId, storedPool } from './helpers/host-harness.ts'
import type { AgentTeamHostActor, AgentTeamOperation } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})


describe('AgentTeam Host-initiated Session recycling ledger command', () => {
  const hostActor = (): AgentTeamHostActor => ({ kind: 'host', handle: 'agent-team' })

  it('commits a Host-actored recycling that moves exactly the sessionId', async () => {
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const ledger = ledgerAtBoot(test)
    const { member } = await addLedgerMember(ledger, undefined)
    const newSessionId = SessionId(`agent-team-${crypto.randomUUID()}`)

    const recycled = (await ledger.recycleMemberSession({
      requestId: requestId('recycle'), workspaceId: alpha, memberId: member.memberId, actor: hostActor(),
      previousSessionId: member.sessionId, newSessionId,
    })).value

    // Identity, memory, and binding survive; only the generation moves.
    expect(recycled.member.sessionId).toBe(newSessionId)
    expect(recycled.member).toMatchObject({
      memberId: member.memberId, handle: member.handle, state: 'enabled', privateMemoryPath: member.privateMemoryPath,
    })
    expect(ledger.previousSessionForMember(member.memberId)).toBe(member.sessionId)
    const operation = [...pool.media.get('agent_team')!.tables.get('operations')!.values() as Iterable<AgentTeamOperation>]
      .find(op => op.kind === 'team/member-session-recycled')
    // The Host records itself: no Member or Human authority is borrowed for a
    // decision neither of them made.
    expect(operation).toMatchObject({
      kind: 'team/member-session-recycled',
      actor: { kind: 'host', handle: 'agent-team' },
      data: { previousSessionId: member.sessionId, newSessionId },
    })
    expect(() => ledgerAtBoot(test).validate()).not.toThrow()
  })

  it('persists the input boundary across replay and rejects a retry changing it', async () => {
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const ledger = ledgerAtBoot(test)
    const { member } = await addLedgerMember(ledger, undefined)
    const request = {
      requestId: requestId('recycle-input'), workspaceId: alpha, memberId: member.memberId, actor: hostActor(),
      previousSessionId: member.sessionId, newSessionId: SessionId(`agent-team-${crypto.randomUUID()}`), inputFromSeq: 17 as never,
    }
    await ledger.recycleMemberSession(request)
    await expect(ledger.recycleMemberSession(request)).resolves.toMatchObject({ committed: false })
    await expect(ledger.recycleMemberSession({ ...request, inputFromSeq: 18 as never })).rejects.toThrow()
    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.entries()]
    const reopened = await harness(storedPool(records))
    expect(ledgerAtBoot(reopened).lastTransitionForMember(member.memberId)).toEqual({
      previousSessionId: member.sessionId, targetSessionId: request.newSessionId, inputFromSeq: 17,
    })
  })

  it('rejects a non-Host actor, a stale binding, and a forged replay', async () => {
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    const newSessionId = SessionId(`agent-team-${crypto.randomUUID()}`)

    // A Member may roll itself over, but recycling is the Host's decision.
    await expect(ledger.recycleMemberSession({
      requestId: requestId('member-actor'), workspaceId: alpha, memberId: member.memberId, actor: actor as never,
      previousSessionId: member.sessionId, newSessionId,
    })).rejects.toThrow(/requires Host authority/)
    await expect(ledger.recycleMemberSession({
      requestId: requestId('stale'), workspaceId: alpha, memberId: member.memberId, actor: hostActor(),
      previousSessionId: SessionId('agent-team-stale'), newSessionId,
    })).rejects.toThrow(/no longer bound/)
    await ledger.recycleMemberSession({
      requestId: requestId('recycle'), workspaceId: alpha, memberId: member.memberId, actor: hostActor(),
      previousSessionId: member.sessionId, newSessionId,
    })
    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.entries()]
    await test.fiber.dispose()
    cleanups.pop()
    // Forging a snapshot that moves more than the sessionId must not replay.
    const forged = records.map(([key, operation]) => {
      if (typeof operation !== 'object' || operation === null || (operation as AgentTeamOperation).kind !== 'team/member-session-recycled') return [key, operation] as [string, unknown]
      const recycled = operation as Extract<AgentTeamOperation, { kind: 'team/member-session-recycled' }>
      return [key, { ...recycled, data: { ...recycled.data, member: { ...recycled.data.member, handle: 'impostor' } } }] as [string, unknown]
    })
    await expect(harness(storedPool(forged))).rejects.toThrow(/invalid Member session recycling/)
  })

  it('rejects a replay whose actor is not the Host', async () => {
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const ledger = ledgerAtBoot(test)
    const { member } = await addLedgerMember(ledger, undefined)
    const newSessionId = SessionId(`agent-team-${crypto.randomUUID()}`)
    await ledger.recycleMemberSession({
      requestId: requestId('recycle'), workspaceId: alpha, memberId: member.memberId, actor: hostActor(),
      previousSessionId: member.sessionId, newSessionId,
    })
    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.entries()]
    await test.fiber.dispose()
    cleanups.pop()
    const forged = records.map(([key, operation]) => {
      if (typeof operation !== 'object' || operation === null || (operation as AgentTeamOperation).kind !== 'team/member-session-recycled') return [key, operation] as [string, unknown]
      const recycled = operation as Extract<AgentTeamOperation, { kind: 'team/member-session-recycled' }>
      return [key, { ...recycled, actor: { kind: 'human', memberId: AGENT_TEAM_HUMAN_MEMBER_ID, handle: 'human' } }] as [string, unknown]
    })
    await expect(harness(storedPool(forged))).rejects.toThrow(/invalid Member session recycling authority/)
  })
})
