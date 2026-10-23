import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type { AgentTeamAgentMember, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamProjectRef, AgentTeamRequestId } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')
const human = agentTeamHumanActor()
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>
let counter = 0
const requestId = (label: string) => `test:${label}:${++counter}` as AgentTeamRequestId

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

async function addAgent(ledger: AgentTeamLedger, handle: string): Promise<AgentTeamMemberId> {
  const memberId = `member:${handle}` as AgentTeamMemberId
  const member: AgentTeamAgentMember = { memberId, sessionId: SessionId(`session:${handle}`), workspaceId: alpha, handle, description: '',
    presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled' }
  await ledger.addMember({ requestId: requestId(`add-${handle}`), actor: human, member, handle, description: '', presetId: 'team-member', workspaceId: alpha, projectRefs: [] })
  return memberId
}

async function seed(rulesVersion: number) {
  const pool = new MemoryMediaPool()
  const table = await openTable(pool)
  const ledger = new AgentTeamLedger(table, { rulesVersion })
  await ledger.initialize()
  const owner = await addAgent(ledger, 'owner')
  const other = await addAgent(ledger, 'other')
  const project = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'alpha', description: '', memberIds: [] })).value.project
  const change = (memberId: AgentTeamMemberId, projectRef: AgentTeamProjectRef = project.projectRef) => ({ requestId: requestId('owner'), actor: human, workspaceId: alpha, projectRef, memberId })
  return { table, ledger, owner, other, projectRef: project.projectRef, change }
}

const visible = (ledger: AgentTeamLedger, memberId: AgentTeamMemberId) => ledger.view({ workspaceId: alpha }, memberId).projects.map(project => project.projectRef)

describe('Project owners', () => {
  it('are refused while the ledger runs rules version 1', async () => {
    const { ledger, owner, change } = await seed(1)
    await expect(ledger.addProjectOwner(change(owner))).rejects.toThrow(/need rules version 2; this ledger runs version 1/)
  })

  it('are granted and withdrawn by the Human, survive replay, and make the owner see the Project', async () => {
    const { table, ledger, owner, other, projectRef, change } = await seed(2)
    expect(visible(ledger, owner)).toEqual([])
    const request = change(owner)
    const added = await ledger.addProjectOwner(request)
    expect(added.committed).toBe(true)
    expect(added.value.ownerIds).toEqual([owner])
    expect((await ledger.addProjectOwner(request)).committed).toBe(false)
    expect(ledger.view({ workspaceId: alpha }).owners).toEqual([{ projectRef, memberId: owner }])
    expect(ledger.ownedProjects(owner).map(project => project.projectRef)).toEqual([projectRef])
    expect(visible(ledger, owner)).toEqual([projectRef])
    expect(visible(ledger, other)).toEqual([])

    const replayed = new AgentTeamLedger(table, { rulesVersion: 2 })
    expect(replayed.projectOwnerIds(projectRef)).toEqual([owner])

    await ledger.removeProjectOwner(change(owner))
    expect(ledger.projectOwnerIds(projectRef)).toEqual([])
    expect(new AgentTeamLedger(table, { rulesVersion: 2 }).projectOwnerIds(projectRef)).toEqual([])
  })

  it('refuse the Human, repeats, strangers, departed Members, and Member actors', async () => {
    const { ledger, owner, change } = await seed(2)
    await expect(ledger.addProjectOwner(change(AGENT_TEAM_HUMAN_MEMBER_ID))).rejects.toThrow(/already owns every Project/)
    await expect(ledger.removeProjectOwner(change(AGENT_TEAM_HUMAN_MEMBER_ID))).rejects.toThrow(/cannot be removed/)
    await expect(ledger.removeProjectOwner(change(owner))).rejects.toThrow(/does not own/)
    await ledger.addProjectOwner(change(owner))
    await expect(ledger.addProjectOwner(change(owner))).rejects.toThrow(/already owns/)
    await expect(ledger.addProjectOwner(change('member:nobody' as AgentTeamMemberId))).rejects.toThrow(/unknown Agent Member/)
    const outsider = await addAgent(ledger, 'outsider')
    const betaProject = (await ledger.createProject({ requestId: requestId('beta'), actor: human, workspaceId: beta, name: 'beta', description: '', memberIds: [] })).value.project
    await expect(ledger.addProjectOwner({ ...change(outsider), workspaceId: beta, projectRef: betaProject.projectRef })).rejects.toThrow(/does not participate/)
    const archived = await addAgent(ledger, 'archived')
    await ledger.archiveMember({ requestId: requestId('archive'), memberId: archived, actor: human })
    await expect(ledger.addProjectOwner(change(archived))).rejects.toThrow(/is archived/)
    await expect(ledger.addProjectOwner({ ...change(outsider), actor: { kind: 'member', memberId: owner, handle: 'owner' } as never })).rejects.toThrow()
  })

  it('end when the Member leaves the Workspace or is archived, but not when it is suspended', async () => {
    const { table, ledger, owner, other, projectRef, change } = await seed(2)
    await ledger.addProjectOwner(change(owner))
    await ledger.addProjectOwner(change(other))
    await ledger.suspendMember({ requestId: requestId('suspend'), memberId: owner, actor: human })
    expect(ledger.projectOwnerIds(projectRef)).toEqual([other, owner].sort())
    await ledger.archiveMember({ requestId: requestId('archive'), memberId: owner, actor: human })
    expect(ledger.projectOwnerIds(projectRef)).toEqual([other])

    await ledger.joinWorkspace({ requestId: requestId('join'), workspaceId: beta, memberId: other, actor: human })
    const betaProject = (await ledger.createProject({ requestId: requestId('beta'), actor: human, workspaceId: beta, name: 'beta', description: '', memberIds: [] })).value.project
    await ledger.addProjectOwner({ ...change(other), workspaceId: beta, projectRef: betaProject.projectRef })
    await ledger.leaveWorkspace({ requestId: requestId('leave'), workspaceId: beta, memberId: other, actor: human })
    expect(ledger.projectOwnerIds(betaProject.projectRef)).toEqual([])
    expect(ledger.projectOwnerIds(projectRef)).toEqual([other])
    expect(new AgentTeamLedger(table, { rulesVersion: 2 }).projectOwnerIds(projectRef)).toEqual([other])
  })

  it('ends ownership when the Member is removed', async () => {
    const { table, ledger, owner, projectRef, change } = await seed(2)
    await ledger.addProjectOwner(change(owner))
    await ledger.removeMember({ requestId: requestId('remove'), memberId: owner, actor: human })
    expect(ledger.projectOwnerIds(projectRef)).toEqual([])
    expect(new AgentTeamLedger(table, { rulesVersion: 2 }).projectOwnerIds(projectRef)).toEqual([])
  })

  it('counts an archived enrolled Member as a Project member at version 1 but not at version 2', async () => {
    const enrolled = async (rulesVersion: number) => {
      const pool = new MemoryMediaPool()
      const ledger = new AgentTeamLedger(await openTable(pool), { rulesVersion })
      await ledger.initialize()
      const enrolledId = await addAgent(ledger, 'enrolled')
      const project = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'alpha', description: '', memberIds: [enrolledId] })).value.project
      await ledger.archiveMember({ requestId: requestId('archive'), memberId: enrolledId, actor: human })
      // No public read distinguishes an archived Member's membership, so the probe reaches the private helper.
      return (ledger as unknown as { isProjectMember(projectRef: AgentTeamProjectRef, memberId: AgentTeamMemberId): boolean }).isProjectMember(project.projectRef, enrolledId)
    }
    expect(await enrolled(1)).toBe(true)
    expect(await enrolled(2)).toBe(false)
  })
})
