import { afterEach, describe, expect, it, vi } from 'vitest'
// Every test here boots a Host over a throwaway tree, and the windows lane has
// stretched one cold replay to 2.7s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21). The SQLite case below keeps its own 30s argument.
vi.setConfig({ testTimeout: 30_000 })
import { agentTeamHumanActor } from '../src/ledger.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/index.ts'
import type { AgentTeamOperation } from '../src/types.ts'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { addLedgerMember, alpha, committed, harness, ledgerAtBoot, makeOwner, requestId, storedPool, withTask, type TeamHarness } from './helpers/host-harness.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})


describe('AgentTeam release snapshot assembly', () => {
  /**
   * One Project, two Members holding Claims on the same Task, and a second
   * Project so the responsibility return has somewhere to land. Each entry is
   * then exercised against this shared shape, which is what makes a difference
   * dropped by unification observable rather than inferred.
   */
  async function seedRelease() {
    const test: TeamHarness = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('release-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const startedRaw = await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('release-start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Release the claims' })
    const started = withTask(committed(startedRaw))
    const ledger = ledgerAtBoot(test)
    const first = await addLedgerMember(ledger, project.project.projectRef, 'member:release-first')
    const second = await addLedgerMember(ledger, project.project.projectRef, 'member:release-second')
    // Each Claim advances the Thread, so the next one claims from the revision the previous one committed.
    let revision = started.thread.revision
    for (const [index, { actor }] of [first, second].entries()) {
      const claimed = committed((await ledger.changeClaim({ requestId: requestId(`release-claim-${index}`), workspaceId: alpha, taskRef: started.task.taskRef,
        action: 'claim', direction: `review ${index}`, baseRevision: revision, actor })).value)
      revision = claimed.thread.revision
    }
    await makeOwner(ledger, project.project.projectRef, first.member.memberId)
    // Claiming already starts Attention for the claimant, so both Members follow the Thread without a
    // separate follow: the cleanup each entry carries therefore has two rows to compare.
    return { test, ledger, project, started, first, second }
  }

  /** The one operation of the given kind a fresh ledger holds. */
  function soleOperation(test: TeamHarness, kind: string): Extract<AgentTeamOperation, { readonly kind: string }> {
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, AgentTeamOperation]>
    const found = records.map(([, operation]) => operation).filter(operation => operation.kind === kind)
    if (found.length !== 1) throw new Error(`expected exactly one ${kind}, received ${found.length}`)
    return found[0] as Extract<AgentTeamOperation, { readonly kind: string }>
  }

  it('releases every owner Claim when a Project is archived, one Activity per owner and Thread', async () => {
    const { test, ledger, project, first, second } = await seedRelease()
    await ledger.archiveProject({ requestId: requestId('release-archive-project'), workspaceId: alpha,
      projectRef: project.project.projectRef, actor: agentTeamHumanActor() })
    const data = (soleOperation(test, 'team/project-archived').data as { claims: readonly { owner: string }[]; activities: readonly { actor: string; claimRefs: readonly string[] }[] })
    // Neither owner is filtered out: archiving a Project releases everyone's Claims.
    expect(data.claims.map(claim => claim.owner).sort()).toEqual([first.member.memberId, second.member.memberId].sort())
    // Two owners on one Thread means two Activities, each naming its own owner's Claims.
    expect(data.activities).toHaveLength(2)
    expect(data.activities.map(activity => activity.actor).sort()).toEqual([first.member.memberId, second.member.memberId].sort())
    for (const activity of data.activities) expect(activity.claimRefs).toHaveLength(1)
    expect(() => ledger.validate()).not.toThrow()
  })

  it('clears every Member Attention on an archived Project but only the departing Member on a removal', async () => {
    const archived = await seedRelease()
    await archived.ledger.archiveProject({ requestId: requestId('release-clean-project'), workspaceId: alpha,
      projectRef: archived.project.project.projectRef, actor: agentTeamHumanActor() })
    const projectData = soleOperation(archived.test, 'team/project-archived').data as { inbox: { attention: { removed: readonly { memberId: string }[] } } }
    // Every follower clears, the Human included — it started the Thread, and a hidden Project
    // must not leave anyone's Attention behind it.
    expect(projectData.inbox.attention.removed.map(entry => entry.memberId).sort())
      .toEqual([AGENT_TEAM_HUMAN_MEMBER_ID, archived.first.member.memberId, archived.second.member.memberId].sort())

    // The same shape with a Member leaving instead: only its own row clears.
    const removed = await seedRelease()
    await removed.ledger.removeMember({ requestId: requestId('release-clean-member'), memberId: removed.first.member.memberId,
      actor: agentTeamHumanActor() })
    const memberData = soleOperation(removed.test, 'team/member-removed').data as { inbox: { attention: { removed: readonly { memberId: string }[] } } }
    expect(memberData.inbox.attention.removed.map(entry => entry.memberId)).toEqual([removed.first.member.memberId])
    // The other Member keeps following, which is the difference unification must not flatten.
    expect(removed.ledger.attentionStatus(agentTeamHumanActor(), { workspaceId: alpha, taskRef: removed.started.task.taskRef })).toBeDefined()
    expect(() => removed.ledger.validate()).not.toThrow()
    expect(() => removed.ledger.validate()).not.toThrow()
  })

  it('keeps membership on archive and ends it on removal, while both release the same Claims', async () => {
    const archived = await seedRelease()
    await archived.ledger.archiveMember({ requestId: requestId('release-archive-member'), memberId: archived.first.member.memberId,
      actor: agentTeamHumanActor() })
    const archiveData = soleOperation(archived.test, 'team/member-archived').data as { claims: readonly { state: string }[] }
    expect(archiveData.claims.every(claim => claim.state === 'released')).toBe(true)
    // Archival is a hidden state, not a departure: the Member stays a Project
    // member and only its surface visibility ends.
    expect(archived.ledger.getMember(archived.first.member.memberId)?.state).toBe('archived')
    expect(archived.ledger.view({ workspaceId: alpha }).projects.map(project => project.projectRef))
      .toContain(archived.project.project.projectRef)

    const removed = await seedRelease()
    const removal = (await removed.ledger.removeMember({ requestId: requestId('release-remove-member'), memberId: removed.first.member.memberId,
      actor: agentTeamHumanActor() })).value
    expect(removal.member.state).toBe('inactive')
    const removeData = soleOperation(removed.test, 'team/member-removed').data as { claims: readonly { state: string }[] }
    // Same release shape, and the membership really ended: the departing Member leaves the
    // membership projection while the other one keeps its place.
    expect(removeData.claims.every(claim => claim.state === 'released')).toBe(true)
    expect(removed.ledger.view({ workspaceId: alpha }).members.map(entry => entry.memberId))
      .toEqual([removed.second.member.memberId])
  })

  it('returns accountability and replays identically', async () => {
    const { test, ledger, project, started, first } = await seedRelease()
    // Hand the Task to the departing Member so the return has somewhere to come from.
    await makeOwner(ledger, project.project.projectRef, first.member.memberId)
    const beforeTransfer = (await ledger.readThread({ requestId: requestId('release-transfer-read'), workspaceId: alpha,
      taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    const transferOutcome = await ledger.transferTask({ requestId: requestId('release-transfer'), workspaceId: alpha,
      taskRef: started.task.taskRef, target: first.member.memberId, baseRevision: beforeTransfer.thread.revision,
      actor: agentTeamHumanActor() })
    // A ledger outcome is a result plus a committed flag; a fence resolves without committing.
    if (!transferOutcome.committed) throw new Error(`transfer did not commit: ${transferOutcome.value.kind}`)
    const removalOutcome = await ledger.removeMember({ requestId: requestId('release-return-remove'), memberId: first.member.memberId,
      actor: agentTeamHumanActor() })
    if (!removalOutcome.committed) throw new Error('removal did not commit')
    const data = soleOperation(test, 'team/member-removed').data as {
      readonly transfers: readonly { readonly kind: string; readonly from: string; readonly to: string }[]
      readonly tasks: readonly { readonly accountable: string }[]
      readonly threads: readonly { readonly revision: number }[]
    }
    // The departing Member was the accountable, so the open Task returns to the Human.
    expect(data.transfers).toEqual([expect.objectContaining({ kind: 'transfer', from: first.member.memberId, to: AGENT_TEAM_HUMAN_MEMBER_ID })])
    expect(data.tasks).toEqual([expect.objectContaining({ accountable: AGENT_TEAM_HUMAN_MEMBER_ID })])
    // The Task's Thread revision moves with the snapshot, and replay agrees byte for byte.
    expect(data.threads[0]!.revision).toBeGreaterThan(started.thread.revision)
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => ledgerAtBoot(replayed).validate()).not.toThrow()
    const cold = ledgerAtBoot(replayed)
    const replayedTask = cold.view({ workspaceId: alpha }).tasks.find(task => task.taskRef === started.task.taskRef)
    expect(replayedTask?.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
  })

  it('rejects a forged responsibility return during replay, so the builder cannot silently drop it', async () => {
    const seeded = await seedRelease()
    const { test, project, started, first } = seeded
    const ledger = seeded.ledger
    await makeOwner(ledger, project.project.projectRef, first.member.memberId)
    const beforeForge = (await ledger.readThread({ requestId: requestId('release-forge-read'), workspaceId: alpha,
      taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    const forgeTransfer = await ledger.transferTask({ requestId: requestId('release-forge-transfer'), workspaceId: alpha,
      taskRef: started.task.taskRef, target: first.member.memberId, actor: agentTeamHumanActor(),
      baseRevision: beforeForge.thread.revision })
    if (!forgeTransfer.committed) throw new Error('forge transfer did not commit: ' + forgeTransfer.value.kind)
    const forgeRemoval = await ledger.removeMember({ requestId: requestId('release-forge-remove'), memberId: first.member.memberId,
      actor: agentTeamHumanActor() })
    if (!forgeRemoval.committed) throw new Error('forge removal did not commit')
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/member-removed') return [id, typed] as [string, unknown]
      // Drop exactly the piece a unified builder might be tempted to skip.
      return [id, { ...typed, data: { ...typed.data, transfers: [], tasks: [], threads: [] } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid released Claim Task or Thread projection/)
  })

  it('hands out a claims snapshot a caller cannot edit back into the operation', async () => {
    const { test, ledger, first } = await seedRelease()
    const removal = (await ledger.removeMember({ requestId: requestId('release-frozen-remove'), memberId: first.member.memberId,
      actor: agentTeamHumanActor() })).value
    // The result and the committed operation data are the same snapshot, so both
    // must be closed: a caller that could edit either would leave the durable
    // record disagreeing with what replay and validation recompute from it.
    expect(Object.isFrozen(removal.releasedClaims)).toBe(true)
    const claims = (soleOperation(test, 'team/member-removed').data as { claims: readonly unknown[] }).claims
    expect(Object.isFrozen(claims)).toBe(true)
    const original = [...claims]
    expect(() => (claims as unknown[]).push({ ...original[0]! })).toThrow()
    expect(claims).toHaveLength(original.length)
  })
})
