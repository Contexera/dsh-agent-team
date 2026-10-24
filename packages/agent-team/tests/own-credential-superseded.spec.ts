import { describe, expect, it, vi } from 'vitest'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import type { AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTaskRef } from '../src/types.ts'
import type { WorkspaceId as TeamWorkspaceId } from '@deepseek-ai/dsh-workspace'
import { harness } from './helpers/surface-harness.ts'

vi.setConfig({ testTimeout: 30_000 })

function ledgerFor(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>, {})
}

function operationsOf(facility: DomainFacility): readonly AgentTeamOperation[] {
  return [...facility.get('agent_team')!.table('operations').entries()].map(([, operation]) => operation) as AgentTeamOperation[]
}

async function addLedgerMember(ledger: AgentTeamLedger, workspaceId: TeamWorkspaceId, handle: string): Promise<{ readonly actor: AgentTeamMemberActor }> {
  const memberId = `member:${crypto.randomUUID()}` as AgentTeamAgentMember['memberId']
  const member: AgentTeamAgentMember = {
    memberId, sessionId: `session:${memberId}` as AgentTeamAgentMember['sessionId'], workspaceId, handle,
    description: 'Test Agent', presetId: 'team-member', privateMemoryPath: `/tmp/${memberId}`, state: 'enabled',
  }
  const added = (await ledger.addMember({ requestId: `add:${memberId}` as AgentTeamRequestId, actor: agentTeamHumanActor(), member,
    handle, description: member.description, presetId: member.presetId, workspaceId, projectRefs: [] })).value
  return { actor: { kind: 'member', memberId: added.member.memberId, handle } }
}

async function followedThread(ledger: AgentTeamLedger, workspaceId: TeamWorkspaceId, actor: AgentTeamMemberActor) {
  const project = (await ledger.createProject({ requestId: 'project' as AgentTeamRequestId, workspaceId,
    name: 'engineering', description: 'Engineering work', memberIds: [actor.memberId], actor: agentTeamHumanActor() })).value.project
  const started = (await ledger.startThread({ requestId: 'start' as AgentTeamRequestId, workspaceId,
    projectRef: project.projectRef, body: 'Thread anchor', kind: 'task', actor: agentTeamHumanActor() })).value
  if (started.kind !== 'committed' || started.task === undefined) throw new Error('setup failed')
  await ledger.changeAttention({ requestId: 'follow' as AgentTeamRequestId, workspaceId,
    taskRef: started.task.taskRef, action: 'follow', actor })
  return started.task.taskRef
}

async function committedToken(ledger: AgentTeamLedger, workspaceId: TeamWorkspaceId, taskRef: AgentTeamTaskRef, body: string, baseRevision: number, actor: AgentTeamMemberActor): Promise<number> {
  const written = await ledger.reply({ requestId: `write:${body}` as AgentTeamRequestId, workspaceId, taskRef, body, baseRevision, actor })
  if (!written.committed || written.value.kind !== 'committed') throw new Error('setup write failed')
  return written.value.thread.revision
}

describe("a write whose credential was superseded by the writer's own previous write", () => {
  it("accepts the token the previous write rendered, and refuses the read's older one", async () => {
    const test = await harness()
    const ledger = ledgerFor(test.facility)
    const { actor } = await addLedgerMember(ledger, test.workspaceId, 'writer')
    const taskRef = await followedThread(ledger, test.workspaceId, actor)

    const read = await ledger.readThread({ requestId: 'read' as AgentTeamRequestId, workspaceId: test.workspaceId, actor, taskRef })
    const readToken = read.value.thread.revision
    const firstWriteToken = await committedToken(ledger, test.workspaceId, taskRef, 'first write', readToken, actor)
    expect(firstWriteToken).toBeGreaterThan(readToken)

    const second = await ledger.reply({ requestId: 'second-from-write-token' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'second write using the previous write token', baseRevision: firstWriteToken, actor })
    expect(second.committed).toBe(true)
    expect(second.value.kind).toBe('committed')

    const before = operationsOf(test.facility).length
    const stale = await ledger.reply({ requestId: 'second-from-read-token' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'second write holding the read token', baseRevision: readToken, actor })
    expect(stale.committed).toBe(false)
    expect(stale.value.kind).toBe('stale_revision')
    expect(operationsOf(test.facility).length).toBe(before)
  })

  it('renders the increment the stale writer missed, so the refusal teaches what changed', async () => {
    const test = await harness()
    const ledger = ledgerFor(test.facility)
    const { actor } = await addLedgerMember(ledger, test.workspaceId, 'writer')
    const taskRef = await followedThread(ledger, test.workspaceId, actor)

    const read = await ledger.readThread({ requestId: 'read' as AgentTeamRequestId, workspaceId: test.workspaceId, actor, taskRef })
    const readToken = read.value.thread.revision
    await committedToken(ledger, test.workspaceId, taskRef, 'first write', readToken, actor)
    const stale = await ledger.reply({ requestId: 'stale-write' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'holding an old token', baseRevision: readToken, actor })

    expect(stale.value.kind === 'stale_revision' && stale.value.expectedRevision).toBe(readToken)
    expect(stale.value.kind === 'stale_revision' && stale.value.revision).toBeGreaterThan(readToken)
    expect(stale.value.kind === 'stale_revision' && stale.value.facts?.map(fact => fact.fact.kind)).toContain('message')
  })

  it('a token the Thread did reach stays the ordinary race, so the copied-token wording is not over-applied', async () => {
    const test = await harness()
    const ledger = ledgerFor(test.facility)
    const { actor } = await addLedgerMember(ledger, test.workspaceId, 'writer')
    const taskRef = await followedThread(ledger, test.workspaceId, actor)

    const read = await ledger.readThread({ requestId: 'read' as AgentTeamRequestId, workspaceId: test.workspaceId, actor, taskRef })
    const readToken = read.value.thread.revision
    const second = await committedToken(ledger, test.workspaceId, taskRef, 'a write that moves the Thread', readToken, actor)
    const stale = await ledger.reply({ requestId: 'stale-after-real-insert' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'holding the read token a real insert passed', baseRevision: readToken, actor })

    expect(stale.committed).toBe(false)
    expect(stale.value.kind).toBe('stale_revision')
    expect(stale.value.kind === 'stale_revision' && stale.value.revision).toBe(second)
    expect(stale.value.kind === 'stale_revision' && stale.value.staleTokenKind).toBeUndefined()
  })

  it('a token older than the Thread\'s first fact is reported as unknown rather than as a race', async () => {
    const test = await harness()
    const ledger = ledgerFor(test.facility)
    const { actor } = await addLedgerMember(ledger, test.workspaceId, 'writer')
    const project = (await ledger.createProject({ requestId: 'project' as AgentTeamRequestId, workspaceId: test.workspaceId,
      name: 'engineering', description: 'Engineering work', memberIds: [actor.memberId], actor: agentTeamHumanActor() })).value.project
    const older = (await ledger.startThread({ kind: 'discussion', requestId: 'older' as AgentTeamRequestId, workspaceId: test.workspaceId,
      projectRef: project.projectRef, body: 'An older Thread', actor: agentTeamHumanActor() }))
    if (older.value.kind !== 'committed') throw new Error('setup failed')
    const olderToken = older.value.thread.revision

    const newer = (await ledger.startThread({ requestId: 'newer' as AgentTeamRequestId, workspaceId: test.workspaceId,
      projectRef: project.projectRef, body: 'A newer Thread', kind: 'task', actor: agentTeamHumanActor() }))
    if (newer.value.kind !== 'committed' || newer.value.task === undefined) throw new Error('setup failed')
    await ledger.changeAttention({ requestId: 'follow' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef: newer.value.task.taskRef, action: 'follow', actor })
    const read = await ledger.readThread({ requestId: 'read' as AgentTeamRequestId, workspaceId: test.workspaceId, actor, taskRef: newer.value.task.taskRef })
    expect(read.value.thread.revision).toBeGreaterThan(olderToken)

    const stale = await ledger.reply({ requestId: 'old-token' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef: newer.value.task.taskRef, body: 'write carrying a token from the older Thread', baseRevision: olderToken, actor })

    expect(stale.committed).toBe(false)
    expect(stale.value.kind).toBe('stale_revision')
    expect(stale.value.kind === 'stale_revision' && stale.value.staleTokenKind).toBe('unknown')
  })

  it('a token this Thread never reached is named as a copied token, not as an insertion race', async () => {
    const test = await harness()
    const ledger = ledgerFor(test.facility)
    const { actor } = await addLedgerMember(ledger, test.workspaceId, 'writer')
    const taskRef = await followedThread(ledger, test.workspaceId, actor)
    const read = await ledger.readThread({ requestId: 'read' as AgentTeamRequestId, workspaceId: test.workspaceId, actor, taskRef })
    const here = await ledger.reply({ requestId: 'here' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'a write on this Thread', baseRevision: read.value.thread.revision, actor })
    if (!here.committed || here.value.kind !== 'committed') throw new Error('setup write failed')

    const foreignToken = here.value.thread.revision + 10_000
    const stale = await ledger.reply({ requestId: 'foreign-token' as AgentTeamRequestId, workspaceId: test.workspaceId,
      taskRef, body: 'write with a copied token', baseRevision: foreignToken, actor })

    expect(stale.committed).toBe(false)
    expect(stale.value.kind).toBe('stale_revision')
    expect(stale.value.kind === 'stale_revision' && stale.value.staleTokenKind).toBe('unrecognized')
  })
})
