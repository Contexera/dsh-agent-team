import { afterEach, describe, expect, it, vi } from 'vitest'
// Every test here boots a Host over a throwaway tree, and the windows lane has
// stretched one cold replay to 2.7s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21). The SQLite case below keeps its own 30s argument.
vi.setConfig({ testTimeout: 30_000 })
import { agentTeamHumanActor } from '../src/ledger.ts'
import type { AgentTeamOperation } from '../src/types.ts'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { addLedgerMember, alpha, committed, harness, ledgerAtBoot, requestId, storedPool, withTask } from './helpers/host-harness.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})


describe('AgentTeam Member archival ledger', () => {
  it('archives a Member: claims release, attention clears, view hides, removal still available', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('archive-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('archive-start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, project.project.projectRef)
    committed((await ledger.changeClaim({ requestId: requestId('archive-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    expect(ledger.view({ workspaceId: alpha }).members).toEqual([expect.objectContaining({ memberId: member.memberId })])
    expect(ledger.view({ workspaceId: alpha }).tasks[0]).toMatchObject({ status: 'in_progress' })
    const archived = (await ledger.archiveMember({ requestId: requestId('archive'), memberId: member.memberId, actor: agentTeamHumanActor() })).value
    expect(archived.member.state).toBe('archived')
    expect(archived.member.sessionId).toBe(member.sessionId)
    expect(archived.releasedClaims).toEqual([expect.objectContaining({ claimRef: expect.any(String), owner: member.memberId, state: 'released' })])
    expect(archived.removedAttention).toEqual([expect.objectContaining({ memberId: member.memberId, threadRef: started.thread.threadRef })])

    // Hidden from the view members projection; the released claim drops the
    // Task back to todo; the archived Member's attention and markers are gone.
    expect(ledger.view({ workspaceId: alpha }).members).toEqual([])
    expect(ledger.view({ workspaceId: alpha }).tasks[0]).toMatchObject({ status: 'todo' })
    const activity = ledger.view({ workspaceId: alpha }).activities.find(fact => fact.kind === 'claims_released')
    expect(activity).toMatchObject({ kind: 'claims_released', actor: member.memberId })

    // Guards: double archive, suspend/resume, edit, and DM all reject.
    await expect(ledger.archiveMember({ requestId: requestId('archive-again'), memberId: member.memberId, actor: agentTeamHumanActor() })).rejects.toThrow(/already archived/)
    await expect(ledger.suspendMember({ requestId: requestId('archive-suspend'), memberId: member.memberId, actor: agentTeamHumanActor() })).rejects.toThrow(/already archived/)
    await expect(ledger.resumeMember({ requestId: requestId('archive-resume'), memberId: member.memberId, actor: agentTeamHumanActor() })).rejects.toThrow(/already archived/)
    await expect(ledger.updateMember({ requestId: requestId('archive-edit'), memberId: member.memberId, handle: member.handle, description: 'new', actor: agentTeamHumanActor() })).rejects.toThrow(/archived and can no longer be edited/)
    const second = await addLedgerMember(ledger, project.project.projectRef, 'member:blocker')
    // An archived Member is gone from the addressable names, so writing their
    // handle is ordinary prose: the start commits and reaches nobody.
    const afterArchive = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('archive-mention'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: `@${member.handle} ping`, actor: agentTeamHumanActor() })).value)
    expect(afterArchive.directMarkers).toEqual([])
    await expect(ledger.sendDm({ requestId: requestId('archive-dm'), workspaceId: alpha, recipientMemberId: member.memberId,
      body: 'still there?', actor: second.actor })).rejects.toThrow(/archived; DM delivery requires an enabled Member/)

    // Removal stays available from archived: the data hygiene path.
    const removed = (await ledger.removeMember({ requestId: requestId('archive-remove'), memberId: member.memberId, actor: agentTeamHumanActor() })).value
    expect(removed.member.state).toBe('inactive')
    ledger.validate()
  })

  it('archives a suspended Member and replays archival across a cold restart', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('susp-archive-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering Work' })
    const ledger = ledgerAtBoot(test)
    const { member } = await addLedgerMember(ledger, project.project.projectRef)
    await ledger.suspendMember({ requestId: requestId('susp-archive-suspend'), memberId: member.memberId, actor: agentTeamHumanActor() })
    const archived = (await ledger.archiveMember({ requestId: requestId('susp-archive'), memberId: member.memberId, actor: agentTeamHumanActor() })).value
    expect(archived.member.state).toBe('archived')
    ledger.validate()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => ledgerAtBoot(replayed).validate()).not.toThrow()
    const cold = ledgerAtBoot(replayed)
    expect(cold.getMember(member.memberId)?.state).toBe('archived')
  })

  it('rejects a forged archival release snapshot during replay', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('forge-archive-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('forge-archive-start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, project.project.projectRef)
    committed((await ledger.changeClaim({ requestId: requestId('forge-archive-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await ledger.archiveMember({ requestId: requestId('forge-archive'), memberId: member.memberId, actor: agentTeamHumanActor() })
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/member-archived') return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, claims: [] } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid released Claim projection/)
  })

  it('archives a Member that also follows a taskless Thread: attention clears there too', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('taskless-archive-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    // One taskful Thread (for the Claim) and one taskless Thread the Member
    // follows: leaving must clear Attention on BOTH, not just taskful ones —
    // the replay validator scopes cleanup to every Thread.
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('taskless-archive-task'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const plain = committed((await ledger.startThread({ requestId: requestId('taskless-archive-plain'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'Plain conversation', kind: 'discussion', actor: agentTeamHumanActor() })).value)
    const { member, actor } = await addLedgerMember(ledger, project.project.projectRef)
    committed((await ledger.changeClaim({ requestId: requestId('taskless-archive-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await ledger.changeAttention({ requestId: requestId('taskless-archive-follow'), workspaceId: alpha,
      threadRef: plain.thread.threadRef, action: 'follow', actor })
    const archived = (await ledger.archiveMember({ requestId: requestId('taskless-archive'), memberId: member.memberId, actor: agentTeamHumanActor() })).value
    expect(archived.removedAttention.map(entry => entry.threadRef).sort())
      .toEqual([plain.thread.threadRef, started.task.threadRef].sort())
    // The commit and the replay validator agree: cold replay validates clean.
    ledger.validate()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => ledgerAtBoot(replayed).validate()).not.toThrow()
  })

  it('rejects a forged Member departure inbox during replay', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('forge-member-inbox-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('forge-member-inbox-task'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const plain = committed((await ledger.startThread({ requestId: requestId('forge-member-inbox-plain'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'Plain conversation', kind: 'discussion', actor: agentTeamHumanActor() })).value)
    const { member, actor } = await addLedgerMember(ledger, project.project.projectRef)
    committed((await ledger.changeClaim({ requestId: requestId('forge-member-inbox-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await ledger.changeAttention({ requestId: requestId('forge-member-inbox-follow'), workspaceId: alpha,
      threadRef: plain.thread.threadRef, action: 'follow', actor })
    await ledger.archiveMember({ requestId: requestId('forge-member-inbox-archive'), memberId: member.memberId, actor: agentTeamHumanActor() })
    // The Project archival path's own message is pinned by its test above; this
    // is the only place the Member-scoped wording and filter are asserted at all.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/member-archived') return [id, typed] as [string, unknown]
      const removed = typed.data.inbox.attention.removed.filter(entry => entry.threadRef !== plain.thread.threadRef)
      // Fail closed: a forge that removed nothing would vacuously "pass".
      expect(removed).toHaveLength(typed.data.inbox.attention.removed.length - 1)
      return [id, { ...typed, data: { ...typed.data, inbox: { ...typed.data.inbox, attention: { ...typed.data.inbox.attention, removed } } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid Member inbox cleanup/)
  })
})
