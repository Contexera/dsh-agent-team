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


describe('AgentTeam Project archival ledger', () => {
  it('archives a Project: every owner releases, attention clears, view hides, mutations reject', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('ch-arch-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const projectRef = project.project.projectRef
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('ch-arch-start'), workspaceId: alpha, projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const first = await addLedgerMember(ledger, projectRef, 'member:first')
    const second = await addLedgerMember(ledger, projectRef, 'member:second')
    const firstClaim = committed((await ledger.changeClaim({ requestId: requestId('ch-arch-claim-1'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'first direction', baseRevision: started.thread.revision, actor: first.actor })).value)
    committed((await ledger.changeClaim({ requestId: requestId('ch-arch-claim-2'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'second direction', baseRevision: firstClaim.thread.revision, actor: second.actor })).value)
    expect(ledger.view({ workspaceId: alpha }).tasks[0]).toMatchObject({ status: 'in_progress' })
    expect(ledger.view({ workspaceId: alpha }).projects).toEqual([expect.objectContaining({ projectRef })])

    const archived = (await ledger.archiveProject({ requestId: requestId('ch-arch'), workspaceId: alpha, projectRef, actor: agentTeamHumanActor() })).value
    expect(archived.project).toMatchObject({ projectRef, state: 'archived' })
    expect(archived.releasedClaims).toHaveLength(2)
    expect(archived.releasedClaims.map(claim => claim.owner).sort()).toEqual([first.member.memberId, second.member.memberId].sort())

    // Hidden from view: project, threads, and tasks all leave the projection.
    // The per-owner release activities stay as durable audit facts on the
    // hidden Threads (replay validation in the cold-restart test recomputes
    // them exactly).
    expect(ledger.view({ workspaceId: alpha }).projects).toEqual([])
    expect(ledger.view({ workspaceId: alpha }).threads).toEqual([])
    expect(ledger.view({ workspaceId: alpha }).tasks).toEqual([])
    const operation = ledger.getOperation(archived.receipt.operationId)!
    expect(operation.kind === 'team/project-archived' ? operation.data.activities.map(activity => activity.actor).sort()
      : []).toEqual([first.member.memberId, second.member.memberId].sort())

    // Idempotent retry; mutation guards reject with the archived message.
    const again = (await ledger.archiveProject({ requestId: requestId('ch-arch'), workspaceId: alpha, projectRef, actor: agentTeamHumanActor() })).value
    expect(again.receipt.operationId).toBe(archived.receipt.operationId)
    await expect(ledger.archiveProject({ requestId: requestId('ch-arch-2'), workspaceId: alpha, projectRef, actor: agentTeamHumanActor() })).rejects.toThrow(/already archived/)
    await expect(ledger.updateProject({ requestId: requestId('ch-arch-rename'), workspaceId: alpha, projectRef, name: 'renamed', description: '', actor: agentTeamHumanActor() })).rejects.toThrow(/archived and no longer accepts Team work/)
    await expect(ledger.startThread({ kind: 'discussion', requestId: requestId('ch-arch-send'), workspaceId: alpha, projectRef, body: 'hello', actor: agentTeamHumanActor() })).rejects.toThrow(/archived and no longer accepts Team work/)
    // A brand-new Member cannot be created into the archived Project, and
    // existing Members (Memberships survive archival) cannot follow or
    // mutate its Tasks.
    await expect((async () => addLedgerMember(ledger, projectRef, 'member:third'))()).rejects.toThrow(/archived and no longer accepts Team work/)
    await expect(ledger.changeAttention({ requestId: requestId('ch-arch-follow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'follow', actor: first.actor })).rejects.toThrow(/archived and no longer accepts Team work/)
    await expect(ledger.changeTask({ requestId: requestId('ch-arch-close'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'close', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).rejects.toThrow(/archived and no longer accepts Team work/)
    ledger.validate()
  })

  it('replays Project archival across a cold restart', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('ch-replay-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('ch-replay-start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    committed((await ledger.changeClaim({ requestId: requestId('ch-replay-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await ledger.archiveProject({ requestId: requestId('ch-replay-archive'), workspaceId: alpha, projectRef: project.project.projectRef, actor: agentTeamHumanActor() })
    ledger.validate()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => ledgerAtBoot(replayed).validate()).not.toThrow()
    expect(ledgerAtBoot(replayed).view({ workspaceId: alpha }).projects).toEqual([])
  })

  it('normalizes legacy project records without state to active on load', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('ch-legacy-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('ch-legacy-start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' }))
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/project-created') return [id, typed] as [string, unknown]
      const { state: _state, ...legacyProject } = typed.data.project
      return [id, { ...typed, data: { ...typed.data, project: legacyProject } }] as [string, unknown]
    })
    const legacy = await harness(storedPool(records))
    const legacyLedger = ledgerAtBoot(legacy)
    expect(() => legacyLedger.validate()).not.toThrow()
    expect(legacyLedger.view({ workspaceId: alpha }).projects[0]).toMatchObject({ projectRef: project.project.projectRef, state: 'active' })
  })

  it('rejects a forged Project archival snapshot during replay', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('ch-forge-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('ch-forge-start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    committed((await ledger.changeClaim({ requestId: requestId('ch-forge-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await ledger.archiveProject({ requestId: requestId('ch-forge-archive'), workspaceId: alpha, projectRef: project.project.projectRef, actor: agentTeamHumanActor() })
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/project-archived') return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, claims: [] } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid released Claim projection/)
  })

  it('archives a Project containing a taskless Thread: cleanup covers it and cold restart replays', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('taskless-arch-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const projectRef = project.project.projectRef
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, projectRef)
    // A taskless Thread carries Human and Member Attention that archival must clear.
    const chat = committed((await ledger.startThread({ requestId: requestId('taskless-arch-chat'), workspaceId: alpha, projectRef,
      body: 'plain conversation', kind: 'discussion', actor: agentTeamHumanActor() })).value)
    // A taskful Thread keeps the archival snapshot meaningful (claim release).
    const started = withTask(committed((await ledger.startThread({ requestId: requestId('taskless-arch-start'), workspaceId: alpha, projectRef,
      body: 'Task', kind: 'task', actor: agentTeamHumanActor() })).value))
    committed((await ledger.changeClaim({ requestId: requestId('taskless-arch-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'work', baseRevision: started.thread.revision, actor })).value)

    const archived = (await ledger.archiveProject({ requestId: requestId('taskless-arch-archive'), workspaceId: alpha, projectRef, actor: agentTeamHumanActor() })).value
    const operation = ledger.getOperation(archived.receipt.operationId)!
    const removed = operation.kind === 'team/project-archived' ? operation.data.inbox.attention.removed : []
    expect(removed.map(entry => entry.threadRef)).toEqual(expect.arrayContaining([chat.thread.threadRef, started.thread.threadRef]))
    ledger.validate()

    // Cold restart: replay must accept the archive snapshot it wrote itself.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => ledgerAtBoot(replayed)).not.toThrow()
    expect(ledgerAtBoot(replayed).view({ workspaceId: alpha }).projects).toEqual([])
  })

  it('repairs a legacy Project archival record that omitted taskless-Thread cleanup on load', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('legacy-arch-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    await addLedgerMember(ledger, project.project.projectRef)
    const chat = committed((await ledger.startThread({ requestId: requestId('legacy-arch-chat'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: 'plain conversation', kind: 'discussion', actor: agentTeamHumanActor() })).value)
    const archived = (await ledger.archiveProject({ requestId: requestId('legacy-arch-archive'), workspaceId: alpha, projectRef: project.project.projectRef, actor: agentTeamHumanActor() })).value
    // Rewrite the archive to the 0.1.7-0.1.9 shape: cleanup scoped to taskful Threads only.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/project-archived') return [id, typed] as [string, unknown]
      const dropTaskless = (removed: readonly { threadRef: string }[]) => removed.filter(entry => entry.threadRef !== chat.thread.threadRef)
      return [id, { ...typed, data: { ...typed.data, inbox: {
        attention: { set: [], removed: dropTaskless(typed.data.inbox.attention.removed) },
        directMarkers: { added: [], removed: dropTaskless(typed.data.inbox.directMarkers.removed) },
        activityMarkers: { added: [], removed: dropTaskless(typed.data.inbox.activityMarkers.removed) },
      } } }] as [string, unknown]
    })
    const legacy = await harness(storedPool(records))
    const legacyLedger = ledgerAtBoot(legacy)
    expect(() => legacyLedger.validate()).not.toThrow()
    const repaired = legacyLedger.getOperation(archived.receipt.operationId)!
    expect(repaired.kind === 'team/project-archived' ? repaired.data.inbox.attention.removed.map(entry => entry.threadRef) : [])
      .toContain(chat.thread.threadRef)
  })

  it('still rejects a forged Project archival inbox during replay', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('forged-inbox-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    committed((await ledger.startThread({ requestId: requestId('forged-inbox-chat'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: 'plain conversation', kind: 'discussion', actor: agentTeamHumanActor() })).value)
    const started = withTask(committed((await ledger.startThread({ requestId: requestId('forged-inbox-start'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: 'Task', kind: 'task', actor: agentTeamHumanActor() })).value))
    committed((await ledger.changeClaim({ requestId: requestId('forged-inbox-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'work', baseRevision: started.thread.revision, actor })).value)
    await ledger.archiveProject({ requestId: requestId('forged-inbox-archive'), workspaceId: alpha, projectRef: project.project.projectRef, actor: agentTeamHumanActor() })
    // Forge the opposite omission (drop a taskful-Thread cleanup entry): not the legacy shape, so it must still fail.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/project-archived') return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, inbox: {
        ...typed.data.inbox,
        attention: { set: [], removed: typed.data.inbox.attention.removed.filter(entry => entry.threadRef !== started.thread.threadRef) },
      } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid Project archival inbox cleanup/)
  })
})
