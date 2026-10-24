import { describe, expect, it, vi } from 'vitest'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import type { AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTaskRef, AgentTeamThreadReadFact } from '../src/types.ts'
import type { WorkspaceId as TeamWorkspaceId } from '@deepseek-ai/dsh-workspace'
import { harness } from './helpers/surface-harness.ts'

/**
 * Project B: the visible-surface exemption, exercised through the real write
 * gate rather than a stand-in for it.
 *
 * The gate refuses a write while the reader has unread work. This suite proves
 * the three properties the design rests on, against the real
 * `deferredThreadWrite` path, with the probe injected exactly the way the Host
 * injects it:
 *
 *  1. When every unread fact is on the Member's surface, the write COMMITS —
 *     the round-trip the gate used to force is gone.
 *  2. That exemption persists no read state: no `team/thread-read` operation,
 *     the attention watermark unmoved, no direct marker consumed. "Has this
 *     been read" keeps its one durable meaning.
 *  3. One fact off the surface keeps the write refused, and a ledger with no
 *     probe at all is exactly the old behaviour.
 */

vi.setConfig({ testTimeout: 30_000 })

/** A ledger over the same durable table, with an injected surface probe. */
function ledgerWithProbe(facility: DomainFacility, probe: (memberId: string, fact: AgentTeamThreadReadFact) => boolean): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>, {
    isFactVisible: (memberId, fact) => probe(memberId, fact),
  })
}

/** Every durable operation, so "the exemption wrote nothing" is checked against the log itself. */
function operationsOf(facility: DomainFacility): readonly AgentTeamOperation[] {
  return [...facility.get('agent_team')!.table('operations').entries()].map(([, operation]) => operation) as AgentTeamOperation[]
}

/** One Agent Member, registered through the ledger so the durable row is real. */
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

/**
 * A Task Thread the Member follows, plus one human reply that makes unread work
 * for them. Every step goes through the ledger, so the durable table and the
 * projection under test are one state.
 */
async function threadWithUnreadReply(
  ledger: AgentTeamLedger,
  workspaceId: TeamWorkspaceId,
  actor: AgentTeamMemberActor,
): Promise<{ readonly taskRef: AgentTeamTaskRef; readonly revision: number }> {
  const project = (await ledger.createProject({ requestId: 'project' as AgentTeamRequestId, workspaceId,
    name: 'engineering', description: 'Engineering work', memberIds: [actor.memberId], actor: agentTeamHumanActor() })).value.project
  // The human anchors the Thread: a Member that writes the anchor auto-follows
  // it, which would already satisfy the unread gate and hide what is under test.
  const started = (await ledger.startThread({ requestId: 'start' as AgentTeamRequestId, workspaceId,
    projectRef: project.projectRef, body: 'Thread anchor', kind: 'task', actor: agentTeamHumanActor() })).value
  if (started.kind !== 'committed' || started.task === undefined) throw new Error('setup failed')
  await ledger.changeAttention({ requestId: 'follow' as AgentTeamRequestId, workspaceId,
    taskRef: started.task.taskRef, action: 'follow', actor })
  const reply = await ledger.reply({ requestId: 'update' as AgentTeamRequestId, workspaceId, taskRef: started.task.taskRef,
    body: 'New evidence for the reader', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })
  if (!reply.committed || reply.value.kind !== 'committed') throw new Error('setup reply failed')
  // The revision the writer must use is the current one: the update reply just
  // moved it, so the returned revision is the post-update position.
  return { taskRef: started.task.taskRef, revision: reply.value.thread.revision }
}

describe('the visible-surface exemption lets a write through', () => {
  it('commits a write whose unread facts are all on the surface, and persists no read state', async () => {
    const test = await harness()
    const seed = ledgerWithProbe(test.facility, () => false)
    const { actor } = await addLedgerMember(seed, test.workspaceId, 'reviewer')
    const thread = await threadWithUnreadReply(seed, test.workspaceId, actor)
    const exempting = ledgerWithProbe(test.facility, () => true)
    const watermarkBefore = exempting.attentionStatus(actor, { workspaceId: test.workspaceId, taskRef: thread.taskRef }).attention?.readThroughSequence
    const before = operationsOf(test.facility).length

    // The gate would refuse: one unread fact. The probe says it is on the
    // Member's surface, so the write commits.
    const written = await exempting.reply({ requestId: 'exempt-write' as AgentTeamRequestId, workspaceId: test.workspaceId, taskRef: thread.taskRef,
      body: 'Reply that needed no read', baseRevision: thread.revision, actor })
    expect(written.committed).toBe(true)
    expect(written.value.kind).toBe('committed')

    // The exemption is not a read: no durable read operation was appended, and
    // the watermark never advanced.
    expect(operationsOf(test.facility).filter(op => op.kind === 'team/thread-read')).toHaveLength(0)
    expect(operationsOf(test.facility).length).toBe(before + 1)
    const status = exempting.attentionStatus(actor, { workspaceId: test.workspaceId, taskRef: thread.taskRef })
    expect(status.attention?.readThroughSequence).toBe(watermarkBefore)
  })

  it('keeps refusing when even one unread fact is off the surface', async () => {
    const test = await harness()
    const seed = ledgerWithProbe(test.facility, () => false)
    const { actor } = await addLedgerMember(seed, test.workspaceId, 'reviewer')
    const thread = await threadWithUnreadReply(seed, test.workspaceId, actor)

    // Fail-closed: the probe refuses, so the gate refuses — and the refusal is
    // the ordinary one, carrying the facts back for the retry.
    const refusing = ledgerWithProbe(test.facility, () => false)
    const blocked = await refusing.reply({ requestId: 'blocked' as AgentTeamRequestId, workspaceId: test.workspaceId, taskRef: thread.taskRef,
      body: 'Reply without read', baseRevision: thread.revision, actor })
    expect(blocked.committed).toBe(false)
    expect(blocked.value.kind).toBe('unread_required')
    expect(blocked.value.kind === 'unread_required' && blocked.value.facts).toHaveLength(1)
  })

  it('keeps refusing with no probe at all, which is the Host without live sessions', async () => {
    const test = await harness()
    const seed = ledgerWithProbe(test.facility, () => false)
    const { actor } = await addLedgerMember(seed, test.workspaceId, 'reviewer')
    const thread = await threadWithUnreadReply(seed, test.workspaceId, actor)

    // A ledger built without the option is exactly the old behaviour.
    const plain = new AgentTeamLedger(test.facility.get('agent_team')!.table('operations') as never)
    const blocked = await plain.reply({ requestId: 'blocked' as AgentTeamRequestId, workspaceId: test.workspaceId, taskRef: thread.taskRef,
      body: 'Reply without read', baseRevision: thread.revision, actor })
    expect(blocked.value.kind).toBe('unread_required')
  })
})

describe('the exemption is scoped to the facts it was asked about', () => {
  it('exempts only when the probe answers for every fact, not the first', async () => {
    const test = await harness()
    const seed = ledgerWithProbe(test.facility, () => false)
    const { actor } = await addLedgerMember(seed, test.workspaceId, 'reviewer')
    const thread = await threadWithUnreadReply(seed, test.workspaceId, actor)
    const second = await seed.reply({ requestId: 'second' as AgentTeamRequestId, workspaceId: test.workspaceId, taskRef: thread.taskRef,
      body: 'Second unread update', baseRevision: thread.revision, actor: agentTeamHumanActor() })
    if (!second.committed) throw new Error('setup failed')

    // Two unread facts. A probe that knows only the first must not exempt the
    // write: `every`, not `some`.
    const answered = new Set<number>()
    const partial = ledgerWithProbe(test.facility, (_memberId, fact) => {
      const sequence = fact.fact.sequence
      if (answered.has(sequence)) return true
      answered.add(sequence)
      return answered.size === 1
    })
    const blocked = await partial.reply({ requestId: 'blocked' as AgentTeamRequestId, workspaceId: test.workspaceId, taskRef: thread.taskRef,
      body: 'Reply without read', baseRevision: thread.revision, actor })
    expect(blocked.value.kind).toBe('unread_required')
  })

  it('exempts a write when the probe answers for all of several facts', async () => {
    const test = await harness()
    const seed = ledgerWithProbe(test.facility, () => false)
    const { actor } = await addLedgerMember(seed, test.workspaceId, 'reviewer')
    const thread = await threadWithUnreadReply(seed, test.workspaceId, actor)
    const second = await seed.reply({ requestId: 'second' as AgentTeamRequestId, workspaceId: test.workspaceId, taskRef: thread.taskRef,
      body: 'Second unread update', baseRevision: thread.revision, actor: agentTeamHumanActor() })
    if (!second.committed || second.value.kind !== 'committed') throw new Error('setup failed')

    const exempting = ledgerWithProbe(test.facility, () => true)
    const written = await exempting.reply({ requestId: 'exempt-write' as AgentTeamRequestId, workspaceId: test.workspaceId, taskRef: thread.taskRef,
      body: 'Reply that needed no read', baseRevision: second.value.thread.revision, actor })
    expect(written.value.kind).toBe('committed')
  })
})
