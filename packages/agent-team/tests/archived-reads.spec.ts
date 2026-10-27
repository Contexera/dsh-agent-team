import { afterEach, describe, expect, it, vi } from 'vitest'
// Every test here boots a Host over a throwaway tree, and the windows lane has
// stretched one cold replay to 2.7s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21). The SQLite case below keeps its own 30s argument.
vi.setConfig({ testTimeout: 30_000 })
import { agentTeamHumanActor } from '../src/ledger.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/index.ts'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { addLedgerMember, alpha, committed, harness, ledgerAtBoot, requestId, storedPool, withTask } from './helpers/host-harness.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})


describe('AgentTeam archived read surfaces', () => {
  it('hides archived-Project Tasks from ref resolution and rejects direct thread reads', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('reads-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('reads-start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await ledger.changeAttention({ requestId: requestId('reads-follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    await ledger.readThread({ requestId: requestId('reads-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })
    // Pre-archival everything resolves and reads.
    expect(ledger.resolveTaskRefs(alpha, [started.task.taskRef])).toHaveLength(1)
    expect(ledger.threadHistory(actor, { workspaceId: alpha, taskRef: started.task.taskRef })).toMatchObject({ thread: { threadRef: started.thread.threadRef } })
    expect(ledger.threadObservations(agentTeamHumanActor(), { workspaceId: alpha, threadRef: started.thread.threadRef })).toBeTruthy()

    await ledger.archiveProject({ requestId: requestId('reads-archive'), workspaceId: alpha, projectRef: project.project.projectRef, actor: agentTeamHumanActor() })

    // Archived Projects do not exist on Team API surfaces: refs stop
    // resolving and every ref-addressed read rejects with the explicit
    // archived error instead of an unknown-ref disguise.
    expect(ledger.resolveTaskRefs(alpha, [started.task.taskRef])).toEqual([])
    await expect(ledger.readThread({ requestId: requestId('reads-read-2'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).rejects.toThrow(/archived and no longer accepts Team work/)
    expect(() => ledger.threadHistory(actor, { workspaceId: alpha, taskRef: started.task.taskRef })).toThrow(/archived and no longer accepts Team work/)
    expect(() => ledger.threadObservations(agentTeamHumanActor(), { workspaceId: alpha, threadRef: started.thread.threadRef })).toThrow(/archived and no longer accepts Team work/)
    expect(() => ledger.view({ workspaceId: alpha, threadRef: started.thread.threadRef })).toThrow(/archived and no longer accepts Team work/)
    await expect(ledger.changeAttention({ requestId: requestId('reads-unfollow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'unfollow', actor })).rejects.toThrow(/archived and no longer accepts Team work/)
    expect(() => ledger.listClaims(actor, { workspaceId: alpha, taskRef: started.task.taskRef })).toThrow(/archived and no longer accepts Team work/)

    // The durable layer stays whole: replay validates every pre-archival
    // read against the then-active Project, and the facts survive intact.
    ledger.validate()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => ledgerAtBoot(replayed).validate()).not.toThrow()
    const cold = ledgerAtBoot(replayed)
    expect(cold.getTask(started.task.taskRef)).toMatchObject({ taskRef: started.task.taskRef })
    expect(cold.resolveTaskRefs(alpha, [started.task.taskRef])).toEqual([])
  })

  it('excludes archived-Project Threads from every Inbox slice', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('inbox-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('inbox-start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await ledger.readThread({ requestId: requestId('inbox-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })
    // Pre-archival the participated Thread is the Human recent tail's.
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toMatchObject({ items: [],
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.thread.threadRef }) })] })

    await ledger.archiveProject({ requestId: requestId('inbox-archive'), workspaceId: alpha, projectRef: project.project.projectRef, actor: agentTeamHumanActor() })

    // Archived Projects do not exist on Team API surfaces: neither the unread
    // queue nor the Human recent tail names their Threads, for the Human or
    // for a Member, and the picture survives a cold restart.
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [], recent: [], hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })
    expect(ledger.inbox(actor, { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [], recent: [], hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })
    expect(ledger.memberInbox(actor, {})).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [], recent: [], hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })
    expect(ledgerAtBoot(test).inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [], recent: [], hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })
  })
})
