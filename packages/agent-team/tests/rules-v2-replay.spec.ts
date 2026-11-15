import { describe, expect, it } from 'vitest'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { openTestTable } from './helpers/ledger-harness.ts'
import { AgentTeamLedger, agentTeamHumanActor, AGENT_TEAM_RULES_VERSION } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type { AgentTeamMemberActor, AgentTeamMemberId, AgentTeamRequestId } from '../src/types.ts'
import { rulesV2Ledger } from './fixtures/rules-v2-ledger.ts'

const owner = rulesV2Ledger.members.owner as AgentTeamMemberId
const ownerActor: AgentTeamMemberActor = { kind: 'member', memberId: owner, handle: 'owner' }

async function openTable(pool: MemoryMediaPool) {
  return (await openTestTable({ pool })).table
}

/** The captured table, stamped for the domain version the build under test speaks. */
function frozenPool(): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('agent_team', agentTeamDomainSpec.version)
  pool.media.set('agent_team', { tables: new Map([['operations', new Map(structuredClone(rulesV2Ledger.records) as Iterable<[string, unknown]>)]])!, global: null })
  return pool
}

describe('replaying the captured rules version 2 ledger', () => {
  it('keeps a suspended accountable as the member its Claim change concerns', async () => {
    const ledger = new AgentTeamLedger(await openTable(frozenPool()), { rulesVersion: 2 })
    await ledger.initialize()
    expect(ledger.status().rulesVersion).toBe(2)
    // The record was written by the version 2 rules: the claim-done marker names the accountable, and a
    // suspended accountable is still that member. Judging it by today's "who can verify" would expect the
    // Human and refuse the whole storage.
    expect(() => ledger.validate()).not.toThrow()
    // Reading a suspended Member's Inbox needs the Member back: resuming writes nothing the marker depends
    // on, so what the Inbox then holds is the version 2 answer itself — an unread row for the accountable.
    await ledger.resumeMember({ requestId: 'fixture:v2:resume-owner' as AgentTeamRequestId, actor: agentTeamHumanActor(), memberId: owner })
    const items = ledger.memberInbox(ownerActor, {}).items
    expect(items).toHaveLength(1)
    expect(items[0]?.thread.threadRef).toBe(rulesV2Ledger.task.threadRef)
    // The claim-done marker is this member's unread work, which is what the version 2 rule decided.
    expect(items[0]?.directCount).toBeGreaterThan(0)
  })

  it('upgrades the same records without re-judging them under the version that adopts them', async () => {
    const table = await openTable(frozenPool())
    const upgraded = new AgentTeamLedger(table)
    await upgraded.initialize()
    expect(upgraded.status().rulesVersion).toBe(AGENT_TEAM_RULES_VERSION)
    // Adoption appends a marker and re-reads the whole table: the version 2 segment keeps its own answer,
    // so the frozen record still names the suspended accountable rather than the Human.
    expect(() => upgraded.validate()).not.toThrow()
    await upgraded.resumeMember({ requestId: 'fixture:v2:resume-owner-again' as AgentTeamRequestId, actor: agentTeamHumanActor(), memberId: owner })
    const upgradedItems = upgraded.memberInbox(ownerActor, {}).items
    expect(upgradedItems).toHaveLength(1)
    expect(upgradedItems[0]?.directCount).toBeGreaterThan(0)
  })
})
