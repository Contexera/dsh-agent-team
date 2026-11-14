import { describe, expect, it } from 'vitest'
// A boot replay followed by a full Member activation over the real Host, so this file keeps the per-test budget the
// sibling lifecycle specs use.
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { realHarness, requestId, ScriptedAdapter, textResponse, waitFor } from './helpers/member-harness.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, agentTeamHumanActor } from '../src/ledger.ts'
import type { AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId } from '../src/types.ts'

describe('A Member recorded before the explicit route contract (issue #131)', () => {
  it('wakes on the Host default instead of being refused or pinned', async () => {
    const adapter = new ScriptedAdapter()
    const memberId = `member:agent-${crypto.randomUUID()}` as AgentTeamMemberId
    const sessionId = SessionId(`agent-team-legacy-${crypto.randomUUID()}`)
    // The ledger older builds wrote: its initialization, then a Member with no route at all. Nothing here goes through
    // `addMember`; boot replay is what has to read it, and activation is what has to run it on the Host default.
    const { ctx } = await realHarness(adapter, 'jsonl', undefined, false, async (seeded, workspaceId) => {
      const domain = await seeded.storageDomain.open(agentTeamDomainSpec)
      const table = domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
      const initialized = `operation:${crypto.randomUUID()}` as AgentTeamOperationId
      await table.put(initialized, {
        sequence: 1, operationId: initialized, requestId: requestId('agent-team:initialize:v1'),
        occurredAt: '2026-01-01T00:00:00.000Z', actor: agentTeamHumanActor(), previousOperationId: null,
        kind: 'team/initialized', data: { humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID },
      })
      const added = `operation:${crypto.randomUUID()}` as AgentTeamOperationId
      await table.put(added, {
        sequence: 2, operationId: added, requestId: requestId('legacy:add-member'),
        occurredAt: '2026-01-01T00:00:00.000Z', actor: agentTeamHumanActor(), previousOperationId: initialized,
        kind: 'team/member-added',
        data: {
          member: {
            memberId, sessionId, workspaceId, handle: 'legacy', description: '', presetId: 'team-member',
            privateMemoryPath: join(process.env.DSH_HOME!, 'agent-team', 'members', memberId), state: 'enabled',
          },
          projectRefs: [],
        },
      })
      await domain.close()
    })

    const status = await waitFor(() => {
      const found = ctx.agentTeam.members().find(item => item.member.memberId === memberId)
      return found !== undefined && found.availability === 'active' ? found : undefined
    })
    expect(status.member.model).toBeUndefined()
    const agent = ctx.agents.get(sessionId)
    expect(agent?.model.current()).toMatchObject({ provider: 'mock', model: 'mock' })

    // The route is the Host default, not a recorded one; the request proves the Member really runs there.
    adapter.enqueue(textResponse('Noted.'))
    agent!.followup(createUserMessage({ content: [{ type: 'text', text: 'Carry on.' }], source: { kind: 'user' } }))
    await agent!.whenIdle()
    const sent = adapter.requests.at(-1)
    expect({ provider: sent?.provider, model: sent?.model }).toEqual({ provider: 'mock', model: 'mock' })
    // Adoption compares against that same default and writes nothing, so the old record stays exactly as it was.
    expect(ctx.agentTeam.members().find(item => item.member.memberId === memberId)?.member.model).toBeUndefined()
  })
})
