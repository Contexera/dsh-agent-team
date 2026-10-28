import { afterEach, describe, expect, it, vi } from 'vitest'
// Every test here boots a Host over a throwaway tree, and the windows lane has
// stretched one cold replay to 2.7s against vitest's 5s default (worst of 11 CI
// runs, 2026-09-17..21). The SQLite case below keeps its own 30s argument.
vi.setConfig({ testTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentTeam from '../src/index.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { fabricateLegacyThreadReadSnapshot } from './helpers/legacy-thread-read.ts'
import { rulesV1Ledger } from './fixtures/rules-v1-ledger.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import { AgentTeamLedger, agentTeamHumanActor, isThreadReadSnapshot } from '../src/ledger.ts'
import { AGENT_TEAM_HUMAN_HANDLE, AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_INITIALIZE_REQUEST_ID } from '../src/index.ts'
import type { AgentTeamThreadAttentionResult } from '../src/types.ts'
import { addLedgerMember, alpha, beta, committed, harness, inFlight, ledgerAtBoot, makeOwner, requestId, sqliteHarness, storedPool, withTask } from './helpers/host-harness.ts'
import type { AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTask, AgentTeamTaskRef, AgentTeamThreadReadData, AgentTeamThreadReadOperation, AgentTeamThreadReadReceipt, AgentTeamThreadReadResult, AgentTeamThreadRef } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** One Thread Attention change: a request addressing a `threadRef` or `taskRef` answers with the Thread face, whose result carries the Thread. */
function threadAttentionOf(result: { readonly value: object }): AgentTeamThreadAttentionResult {
  if (!('thread' in result.value)) throw new Error('expected a Thread Attention result')
  return result.value as AgentTeamThreadAttentionResult
}


/**
 * A frozen old ledger whose Member was enrolled into the Project by hand and
 * never wrote a word — the historical explicit membership that membership
 * derivation still has to keep visible.
 */
const legacyJoinLedger = JSON.parse("{\"records\":[[\"operation:8898b8c4-9487-4fe3-bf50-7b69e6bb54b3\",{\"sequence\":1,\"operationId\":\"operation:8898b8c4-9487-4fe3-bf50-7b69e6bb54b3\",\"requestId\":\"agent-team:initialize:v1\",\"occurredAt\":\"2026-10-12T11:38:19.890Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":null,\"kind\":\"team/initialized\",\"data\":{\"humanMemberId\":\"member:human\"}}],[\"operation:5e6e01e1-3382-4a5e-aca3-af5bec36cad0\",{\"sequence\":2,\"operationId\":\"operation:5e6e01e1-3382-4a5e-aca3-af5bec36cad0\",\"requestId\":\"cap3-project\",\"occurredAt\":\"2026-10-12T11:38:19.892Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":\"operation:8898b8c4-9487-4fe3-bf50-7b69e6bb54b3\",\"kind\":\"team/project-created\",\"data\":{\"workspaceId\":\"workspace:alpha\",\"project\":{\"projectRef\":\"project:faf3838a-8b87-45fb-aa3d-3b9722c61027\",\"workspaceId\":\"workspace:alpha\",\"name\":\"engineering\",\"description\":\"\",\"createdAtSequence\":2,\"state\":\"active\"},\"memberIds\":[]}}],[\"operation:9b80f06c-d220-454f-b89d-0897030a7669\",{\"sequence\":3,\"operationId\":\"operation:9b80f06c-d220-454f-b89d-0897030a7669\",\"requestId\":\"add:member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\",\"occurredAt\":\"2026-10-12T11:38:19.894Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":\"operation:5e6e01e1-3382-4a5e-aca3-af5bec36cad0\",\"kind\":\"team/member-added\",\"data\":{\"member\":{\"memberId\":\"member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\",\"sessionId\":\"session:member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\",\"workspaceId\":\"workspace:alpha\",\"handle\":\"silent3\",\"description\":\"Test Agent\",\"presetId\":\"team-member\",\"privateMemoryPath\":\"/tmp/member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\",\"state\":\"enabled\"},\"projectRefs\":[]}}],[\"operation:ef94c3ad-2c33-4f80-95ea-649ad7b125ea\",{\"sequence\":4,\"operationId\":\"operation:ef94c3ad-2c33-4f80-95ea-649ad7b125ea\",\"requestId\":\"cap3-join\",\"occurredAt\":\"2026-10-12T11:38:19.894Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":\"operation:9b80f06c-d220-454f-b89d-0897030a7669\",\"kind\":\"team/project-member-added\",\"data\":{\"workspaceId\":\"workspace:alpha\",\"projectRef\":\"project:faf3838a-8b87-45fb-aa3d-3b9722c61027\",\"memberId\":\"member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\"}}]],\"projectRef\":\"project:faf3838a-8b87-45fb-aa3d-3b9722c61027\",\"memberId\":\"member:agent-fe323dab-364c-44a5-aa60-77b85911f3e2\"}") as {
  readonly records: Array<[string, unknown]>
  readonly projectRef: string
  readonly memberId: string
}

/**
 * A frozen old ledger: Project membership was still granted and revoked by
 * hand, so it carries `team/project-member-removed` with its real cleanup
 * payload. Nothing writes these operations any more — membership is derived
 * from participation — so the replay-side tests load the history instead of
 * committing it.
 */
const legacyRemovalLedger = JSON.parse("{\"records\":[[\"operation:0c1feff4-292a-4734-bc55-5f9ee1da7fd3\",{\"sequence\":1,\"operationId\":\"operation:0c1feff4-292a-4734-bc55-5f9ee1da7fd3\",\"requestId\":\"agent-team:initialize:v1\",\"occurredAt\":\"2026-10-12T11:32:27.794Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":null,\"kind\":\"team/initialized\",\"data\":{\"humanMemberId\":\"member:human\"}}],[\"operation:90650574-c253-459a-bf9f-78a43409277e\",{\"sequence\":2,\"operationId\":\"operation:90650574-c253-459a-bf9f-78a43409277e\",\"requestId\":\"cap2-project\",\"occurredAt\":\"2026-10-12T11:32:27.796Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":\"operation:0c1feff4-292a-4734-bc55-5f9ee1da7fd3\",\"kind\":\"team/project-created\",\"data\":{\"workspaceId\":\"workspace:alpha\",\"project\":{\"projectRef\":\"project:a71b388d-1dbf-41eb-ae5d-7f7e80a93358\",\"workspaceId\":\"workspace:alpha\",\"name\":\"engineering\",\"description\":\"\",\"createdAtSequence\":2,\"state\":\"active\"},\"memberIds\":[]}}],[\"operation:0eef8f04-2f1e-4ffc-97de-8639d7164506\",{\"sequence\":3,\"operationId\":\"operation:0eef8f04-2f1e-4ffc-97de-8639d7164506\",\"requestId\":\"add:cap-agent\",\"occurredAt\":\"2026-10-12T11:32:27.797Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":\"operation:90650574-c253-459a-bf9f-78a43409277e\",\"kind\":\"team/member-added\",\"data\":{\"member\":{\"memberId\":\"member:cap-agent\",\"sessionId\":\"session:cap-agent\",\"workspaceId\":\"workspace:alpha\",\"handle\":\"cap-agent\",\"description\":\"Test Agent\",\"presetId\":\"team-member\",\"privateMemoryPath\":\"/tmp/dsh-agent-team-cap-agent\",\"state\":\"enabled\"},\"projectRefs\":[\"project:a71b388d-1dbf-41eb-ae5d-7f7e80a93358\"]}}],[\"operation:ee943931-dbc2-4c3f-8e86-9b57bc87011b\",{\"sequence\":4,\"operationId\":\"operation:ee943931-dbc2-4c3f-8e86-9b57bc87011b\",\"requestId\":\"cap2-chat\",\"occurredAt\":\"2026-10-12T11:32:27.798Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":\"operation:0eef8f04-2f1e-4ffc-97de-8639d7164506\",\"kind\":\"team/message-sent\",\"data\":{\"workspaceId\":\"workspace:alpha\",\"mentions\":[\"member:cap-agent\"],\"message\":{\"messageRef\":\"message:8046d83c-1f01-4f48-89b7-82bf5e52727e\",\"projectRef\":\"project:a71b388d-1dbf-41eb-ae5d-7f7e80a93358\",\"threadRef\":\"thread:5e4bd95e-d0d8-43aa-a5be-f02d9027f05e\",\"sender\":\"member:human\",\"body\":\"plain conversation\",\"topLevel\":true,\"sequence\":4,\"occurredAt\":\"2026-10-12T11:32:27.798Z\"},\"thread\":{\"threadRef\":\"thread:5e4bd95e-d0d8-43aa-a5be-f02d9027f05e\",\"revision\":4},\"inbox\":{\"attention\":{\"set\":[{\"memberId\":\"member:human\",\"threadRef\":\"thread:5e4bd95e-d0d8-43aa-a5be-f02d9027f05e\",\"startSequence\":4,\"readThroughSequence\":3},{\"memberId\":\"member:cap-agent\",\"threadRef\":\"thread:5e4bd95e-d0d8-43aa-a5be-f02d9027f05e\",\"startSequence\":4,\"readThroughSequence\":3}],\"removed\":[]},\"directMarkers\":{\"added\":[{\"memberId\":\"member:cap-agent\",\"threadRef\":\"thread:5e4bd95e-d0d8-43aa-a5be-f02d9027f05e\",\"messageRef\":\"message:8046d83c-1f01-4f48-89b7-82bf5e52727e\",\"sequence\":4}],\"removed\":[]},\"activityMarkers\":{\"added\":[],\"removed\":[]}}}}],[\"operation:3300fba5-7ca8-456f-90b8-fb4de741066f\",{\"sequence\":5,\"operationId\":\"operation:3300fba5-7ca8-456f-90b8-fb4de741066f\",\"requestId\":\"cap2-remove\",\"occurredAt\":\"2026-10-12T11:32:27.799Z\",\"actor\":{\"kind\":\"human\",\"memberId\":\"member:human\",\"handle\":\"human\"},\"previousOperationId\":\"operation:ee943931-dbc2-4c3f-8e86-9b57bc87011b\",\"kind\":\"team/project-member-removed\",\"data\":{\"workspaceId\":\"workspace:alpha\",\"projectRef\":\"project:a71b388d-1dbf-41eb-ae5d-7f7e80a93358\",\"memberId\":\"member:cap-agent\",\"claims\":[],\"activities\":[],\"tasks\":[],\"threads\":[],\"inbox\":{\"attention\":{\"set\":[],\"removed\":[{\"memberId\":\"member:cap-agent\",\"threadRef\":\"thread:5e4bd95e-d0d8-43aa-a5be-f02d9027f05e\"}]},\"directMarkers\":{\"added\":[],\"removed\":[{\"memberId\":\"member:cap-agent\",\"threadRef\":\"thread:5e4bd95e-d0d8-43aa-a5be-f02d9027f05e\",\"messageRef\":\"message:8046d83c-1f01-4f48-89b7-82bf5e52727e\",\"sequence\":4}]},\"activityMarkers\":{\"added\":[],\"removed\":[]}}}}]],\"threadRef\":\"thread:5e4bd95e-d0d8-43aa-a5be-f02d9027f05e\",\"operationId\":\"operation:3300fba5-7ca8-456f-90b8-fb4de741066f\",\"projectRef\":\"project:a71b388d-1dbf-41eb-ae5d-7f7e80a93358\",\"memberId\":\"member:cap-agent\"}") as {
  readonly records: Array<[string, unknown]>
  readonly threadRef: string
  readonly operationId: string
  readonly projectRef: string
  readonly memberId: string
}

describe('AgentTeam durable Thread Attention ledger', () => {
  it('replays Workspace participation without moving the default Workspace or Session', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    const joinRequest = { requestId: requestId('workspace-join'), workspaceId: beta, memberId: member.memberId, actor: agentTeamHumanActor() }
    expect(ledger.workspacesOf(member.memberId)).toEqual([alpha])
    expect(() => ledger.view({ workspaceId: beta }, member.memberId)).toThrow(/another Workspace/)
    const joined = await ledger.joinWorkspace(joinRequest)
    expect(joined.committed).toBe(true)
    expect((await ledger.joinWorkspace(joinRequest)).committed).toBe(false)
    await expect(ledger.joinWorkspace({ ...joinRequest, workspaceId: alpha })).rejects.toThrow()
    expect(ledger.getMember(member.memberId)).toEqual(member)
    expect(ledger.view({ workspaceId: beta }, member.memberId).workspaces).toEqual([
      { workspaceId: alpha, default: true }, { workspaceId: beta, default: false },
    ])
    const project = (await ledger.createProject({ requestId: requestId('joined-project'), workspaceId: beta,
      name: 'joined', description: '', memberIds: [member.memberId], actor: agentTeamHumanActor() })).value.project
    await makeOwner(ledger, project.projectRef, member.memberId, beta)
    const sent = committed((await ledger.startThread({ requestId: requestId('joined-message'), workspaceId: beta,
      projectRef: project.projectRef, body: 'Working in beta', kind: 'discussion', actor })).value)
    expect(sent.message.sender).toBe(member.memberId)
    const replay = ledgerAtBoot(test)
    expect(replay.workspacesOf(member.memberId)).toEqual([alpha, beta])
    expect(replay.getMember(member.memberId)).toEqual(member)
    expect(replay.view({ workspaceId: beta }, member.memberId).projects).toContainEqual(project)
    replay.validate()
  })

  it('withdraws only the target Workspace and rejects subsequent work there', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    await ledger.joinWorkspace({ requestId: requestId('join-beta'), workspaceId: beta, memberId: member.memberId, actor: agentTeamHumanActor() })
    const claims = []
    for (const workspaceId of [alpha, beta]) {
      const project = (await ledger.createProject({ requestId: requestId(`project-${workspaceId}`), workspaceId,
        name: 'work', description: '', memberIds: [member.memberId], actor: agentTeamHumanActor() })).value.project
      await makeOwner(ledger, project.projectRef, member.memberId, workspaceId)
      const sent = withTask(committed((await ledger.startThread({ requestId: requestId(`message-${workspaceId}`), workspaceId,
        projectRef: project.projectRef, body: 'Task', kind: 'task', actor })).value))
      const claim = committed((await ledger.changeClaim({ requestId: requestId(`claim-${workspaceId}`), workspaceId,
        taskRef: sent.task.taskRef, baseRevision: sent.thread.revision, action: 'claim', direction: 'Implement', actor })).value)
      claims.push({ workspaceId, project, sent, claim })
    }
    const leaveRequest = { requestId: requestId('leave-beta'), workspaceId: beta, memberId: member.memberId, actor: agentTeamHumanActor() }
    const left = await ledger.leaveWorkspace(leaveRequest)
    expect(left.value.releasedClaims.map(claim => claim.claimRef)).toEqual([claims[1]!.claim.claim.claimRef])
    expect(left.value.removedAttention).toContainEqual({ memberId: member.memberId, threadRef: claims[1]!.sent.thread.threadRef })
    expect((await ledger.leaveWorkspace(leaveRequest)).committed).toBe(false)
    expect(ledger.workspacesOf(member.memberId)).toEqual([alpha])
    expect(ledger.getMember(member.memberId)).toEqual(member)
    expect(ledger.listClaims(actor, { workspaceId: alpha, taskRef: claims[0]!.sent.task.taskRef }).claims[0]?.state).toBe('active')
    expect(() => ledger.view({ workspaceId: beta }, member.memberId)).toThrow(/another Workspace/)
    expect(ledger.view({ workspaceId: beta }).members).not.toContainEqual({ projectRef: claims[1]!.project.projectRef, memberId: member.memberId })
    await expect(ledger.reply({ requestId: requestId('reply-after-leave'), workspaceId: beta,
      threadRef: claims[1]!.sent.thread.threadRef, baseRevision: claims[1]!.claim.thread.revision, body: 'Late reply', actor })).rejects.toThrow(/another Workspace/)
    await expect(ledger.leaveWorkspace({ ...leaveRequest, requestId: requestId('leave-default'), workspaceId: alpha })).rejects.toThrow(/default Workspace/)
    const replay = ledgerAtBoot(test)
    expect(replay.workspacesOf(member.memberId)).toEqual([alpha])
    replay.validate()
    await replay.joinWorkspace({ ...leaveRequest, requestId: requestId('rejoin-beta') })
    // Rejoining restores the derived half of visibility: this Member wrote in
    // that Project's Thread before leaving, so "has taken part" brings it back
    // — Project participation is derived from Threads now, not re-enrolled.
    expect(replay.view({ workspaceId: beta }, member.memberId).projects.map(project => project.projectRef))
      .toEqual([claims[1]!.project.projectRef])
  })

  it('checks handle collisions across all participations, including suspended Members', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const ledger = ledgerAtBoot(test)
    const first = await addLedgerMember(ledger, undefined, 'member:first', '', 'builder')
    const second = await addLedgerMember(ledger, undefined, 'member:second', '', 'reviewer')
    await ledger.suspendMember({ requestId: requestId('suspend'), memberId: first.member.memberId, actor: agentTeamHumanActor() })
    await ledger.joinWorkspace({ requestId: requestId('join-first'), workspaceId: beta, memberId: first.member.memberId, actor: agentTeamHumanActor() })
    expect(ledger.getMember(first.member.memberId)?.state).toBe('suspended')
    const other = { ...second.member, memberId: 'member:beta-peer' as AgentTeamAgentMember['memberId'], workspaceId: beta, sessionId: SessionId('session:beta-peer') }
    await ledger.addMember({ requestId: requestId('beta-peer'), workspaceId: beta, member: other,
      handle: 'peer', description: '', presetId: 'team-member', projectRefs: [], actor: agentTeamHumanActor() })
    await expect(ledger.updateMember({ requestId: requestId('rename-collision'), memberId: first.member.memberId,
      handle: 'PEER', description: '', actor: agentTeamHumanActor() })).rejects.toThrow(/already active/)
    await ledger.updateMember({ requestId: requestId('rename-second'), memberId: second.member.memberId,
      handle: 'peer', description: '', actor: agentTeamHumanActor() })
    await expect(ledger.joinWorkspace({ requestId: requestId('join-collision'), workspaceId: beta,
      memberId: second.member.memberId, actor: agentTeamHumanActor() })).rejects.toThrow(/already active/)
    ledgerAtBoot(test).validate()
  })

  it('boots an empty Team on rules version 2 and rejects old ledger media', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    expect(first.ctx.agentTeam.status()).toEqual({ initialized: true, sequence: 2, operationCount: 2, projectCount: 0, agentMemberCount: 0, humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, rulesVersion: 2 })
    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.values()]
    await first.fiber.dispose()
    const replay = await first.ctx.plugin(AgentTeam)
    expect(first.ctx.agentTeam.status()).toMatchObject({ sequence: 2 })
    expect([...pool.media.get('agent_team')!.tables.get('operations')!.values()]).toEqual(records)
    await replay.dispose()
    await expect(harness(storedPool([], 9))).rejects.toThrow(/stamped v9, descriptor wants v1/)
  })

  it('creates a top-level Task, starts creator Attention, and returns no own unread work', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const sent = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Investigate the regression' })))
    expect(sent).toMatchObject({ message: { topLevel: true, sender: AGENT_TEAM_HUMAN_MEMBER_ID }, task: { status: 'todo' }, attention: [expect.objectContaining({ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, startSequence: sent.message.sequence, readThroughSequence: sent.message.sequence - 1 })] })
    // The creator's own Message is not unread for them, and the Thread they
    // started is already theirs to step back into: participation — writing a
    // Message there — is what admits the recent slice, so it is in the tail
    // from its first Message on, with nobody else in it yet.
    expect(test.ctx.agentTeam.inbox({ workspaceId: alpha })).toMatchObject({ items: [], totalUnreadCount: 0, totalDirectCount: 0,
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: sent.task.threadRef }) })] })
    const attention = await test.ctx.agentTeam.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: sent.task.taskRef, action: 'unfollow' })
    expect(attention.attention).toBeUndefined()
    await expect(test.ctx.agentTeam.changeAttention({ requestId: requestId('again'), workspaceId: alpha, taskRef: sent.task.taskRef, action: 'unfollow' })).rejects.toThrow(/already unfollowed/)
    // Unfollowing stops the notifications, not the record: the Thread stays in
    // the tail of a reader who wrote in it.
    expect(test.ctx.agentTeam.inbox({ workspaceId: alpha })).toMatchObject({ recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: sent.task.threadRef }) })] })
  })

  it('accepts a Task early and completes active Claims inside the same operation', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, project.project.projectRef)
    const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    expect(claimed.task.status).toBe('in_progress')

    const afterClaimRead = (await ledger.readThread({ requestId: requestId('read1'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    const accepted = committed((await ledger.changeTask({ requestId: requestId('accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: afterClaimRead.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(accepted.task).toMatchObject({ status: 'done', resolution: 'accepted' })
    expect(accepted.claims).toHaveLength(1)
    expect(accepted.claims[0]).toMatchObject({ claimRef: claimed.claim.claimRef, owner: member.memberId, state: 'done' })
    expect(accepted.activity.kind).toBe('accept')
    expect(accepted.activity.completedClaimRefs).toEqual([claimed.claim.claimRef])

    // The completed Claim's owner wakes with an activity marker telling them
    // the Human accepted over their open Claim.
    const inbox = ledger.inbox(actor, { workspaceId: alpha })
    expect(inbox.totalUnreadCount).toBeGreaterThan(0)

    // Cold replay reproduces the same markers and validates the transition.
    const cold = ledgerAtBoot(test)
    expect(() => cold.validate()).not.toThrow()
    const replayed = cold.inbox(actor, { workspaceId: alpha })
    expect(replayed.items.map(item => item.thread.threadRef)).toEqual(inbox.items.map(item => item.thread.threadRef))
  })

  it('accepts an unclaimed todo Task directly and stays honest about the empty Claim list', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    expect(started.task.status).toBe('todo')
    const ledger = ledgerAtBoot(test)

    const accepted = committed((await ledger.changeTask({ requestId: requestId('accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).value)
    // Direct acceptance of work finished outside the ledger: no Claims to
    // complete, so the activity carries no completion list. The acceptance
    // list is still written (explicitly empty): it is the durable
    // discriminator every done Claim owner is notified from, even when the
    // list is empty, and its presence distinguishes new accepts from legacy
    // records that carry neither list.
    expect(accepted.task).toMatchObject({ status: 'done', resolution: 'accepted' })
    expect(accepted.claims).toEqual([])
    expect(accepted.activity.kind).toBe('accept')
    expect(accepted.activity.completedClaimRefs).toBeUndefined()
    expect(accepted.activity.acceptedClaimRefs).toEqual([])

    const view = ledger.view({ workspaceId: alpha })
    // Task creation itself is a public fact now: the promote activity names
    // the accountable the Task was created with, ahead of its later history.
    expect(view.activities).toEqual([expect.objectContaining({ kind: 'promote', taskRef: started.task.taskRef }),
      expect.objectContaining({ kind: 'accept', taskRef: started.task.taskRef })])
    expect(view.tasks.find(task => task.taskRef === started.task.taskRef)).toMatchObject({ status: 'done', resolution: 'accepted' })
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toMatchObject({ items: [], totalUnreadCount: 0, totalDirectCount: 0,
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.task.threadRef }) })] })
    const cold = ledgerAtBoot(test)
    expect(() => cold.validate()).not.toThrow()
    expect(cold.view({ workspaceId: alpha }).tasks.find(task => task.taskRef === started.task.taskRef)).toMatchObject({ status: 'done', resolution: 'accepted' })
  })

  it('notifies every done Claim owner on a normal accept and dedupes multi-claim owners into one marker', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef, 'member:agent-ship', 'ship')
    const { actor: actorTwo } = await addLedgerMember(ledger, project.project.projectRef, 'member:agent-fix', 'fix')
    // Two Claims: the same owner finished one earlier (normal flow, the claim
    // was done BEFORE the accept), another member still holds an active one.
    const firstRead = (await ledger.readThread({ requestId: requestId('read-claim-1'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    const firstClaim = committed((await ledger.changeClaim({ requestId: requestId('claim-1'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'one', baseRevision: firstRead.thread.revision, actor })).value)
    const readDone1 = (await ledger.readThread({ requestId: requestId('read-done-1'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    committed((await ledger.changeClaim({ requestId: requestId('done-1'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'done', claimRef: firstClaim.claim.claimRef, baseRevision: readDone1.thread.revision, actor })).value)
    const secondRead = (await ledger.readThread({ requestId: requestId('read-claim-2'), workspaceId: alpha, taskRef: started.task.taskRef, actor: actorTwo })).value
    const activeClaim = committed((await ledger.changeClaim({ requestId: requestId('claim-2'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'two', baseRevision: secondRead.thread.revision, actor: actorTwo })).value)
    // The finished owner claims a second direction and finishes it too: both
    // done Claims belong to the same owner and must produce ONE marker.
    const thirdRead = (await ledger.readThread({ requestId: requestId('read-claim-3'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    const secondOwnClaim = committed((await ledger.changeClaim({ requestId: requestId('claim-3'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'three', baseRevision: thirdRead.thread.revision, actor })).value)
    const readDone3 = (await ledger.readThread({ requestId: requestId('read-done-3'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    committed((await ledger.changeClaim({ requestId: requestId('done-3'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'done', claimRef: secondOwnClaim.claim.claimRef, baseRevision: readDone3.thread.revision, actor })).value)

    const humanRead = (await ledger.readThread({ requestId: requestId('human-read-accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    const accepted = committed((await ledger.changeTask({ requestId: requestId('normal-accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    // Early acceptance still completes the active Claim; the acceptance list
    // covers every done Claim at commit time — both the pre-finished pair and
    // the atomically completed one.
    expect(accepted.activity.completedClaimRefs).toEqual([activeClaim.claim.claimRef])
    expect(accepted.activity.acceptedClaimRefs).toEqual([firstClaim.claim.claimRef, activeClaim.claim.claimRef, secondOwnClaim.claim.claimRef].sort())

    // The previously-done owner wakes from a normal accept — the old ledger
    // stayed silent here — with exactly one unread item for this Thread.
    const inbox = ledger.inbox(actor, { workspaceId: alpha })
    expect(inbox.totalUnreadCount).toBe(1)
    expect(inbox.items[0]?.thread.threadRef).toBe(started.task.threadRef)
    const cold = ledgerAtBoot(test)
    expect(() => cold.validate()).not.toThrow()
    expect(cold.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(1)
  })

  it('cold-replays a legacy plain accept without the acceptance discriminator and keeps it silent', async () => {
    // The pre-discriminator ledger shape: a plain accept whose activity
    // carries NEITHER claim list and whose inbox delta is empty. The
    // validator must verify this shape exactly as recorded — computing the
    // marker recipients from today's all-done rule would fail the replay of
    // every existing ledger. The done owner has unfollowed after finishing
    // (legal once its Claim is no longer active), so the accept marker is
    // its only possible wake: the discriminator is what makes the
    // difference between the new shape (1 unread) and the legacy shape
    // (silent, exactly as recorded).
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef, 'member:agent-done', 'done-owner')
    const memberRead = (await ledger.readThread({ requestId: requestId('member-legacy-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    const claim = committed((await ledger.changeClaim({ requestId: requestId('legacy-claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'legacy', baseRevision: memberRead.thread.revision, actor })).value)
    const readDone = (await ledger.readThread({ requestId: requestId('legacy-done-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    committed((await ledger.changeClaim({ requestId: requestId('legacy-done'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'done', claimRef: claim.claim.claimRef, baseRevision: readDone.thread.revision, actor })).value)
    // The finished owner steps back from the Thread before the accept. The
    // attention change does not advance the Thread revision, so the accept
    // below still bases on the human read.
    const unfollowed = (await ledger.changeAttention({ requestId: requestId('legacy-unfollow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'unfollow', actor })).value
    expect(unfollowed.attention).toBeUndefined()
    const humanRead = (await ledger.readThread({ requestId: requestId('legacy-human-read'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    const accepted = committed((await ledger.changeTask({ requestId: requestId('legacy-accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(accepted.activity.completedClaimRefs).toBeUndefined()
    expect(accepted.activity.acceptedClaimRefs).toEqual([claim.claim.claimRef])
    // New-shape accept: the unfollowed done owner still learns about the
    // acceptance through the discriminator's marker; assert that here so
    // the rewrite below is a real downgrade to the legacy shape.
    expect(ledger.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(1)

    // Rewrite the recorded operation to the legacy shape: strip the
    // discriminator and empty the inbox delta, as an old ledger recorded it.
    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.entries()]
    await test.fiber.dispose()
    cleanups.pop()
    const legacy = records.map(([key, operation]) => {
      if (typeof operation !== 'object' || operation === null || (operation as AgentTeamOperation).kind !== 'team/task-changed') return [key, operation] as [string, unknown]
      const changed = operation as Extract<AgentTeamOperation, { kind: 'team/task-changed' }>
      if (changed.data.activity.activityRef !== accepted.activity.activityRef) return [key, operation] as [string, unknown]
      const { acceptedClaimRefs: _stripped, ...activity } = changed.data.activity as { acceptedClaimRefs?: unknown }
      return [key, { ...changed, data: { ...changed.data, activity, inbox: { attention: { set: [], removed: [] }, directMarkers: { added: [], removed: [] }, activityMarkers: { added: [], removed: [] } } } }] as [string, unknown]
    })
    const revived = await harness(storedPool(legacy))
    expect(() => ledgerAtBoot(revived).validate()).not.toThrow()
    // Legacy plain accept: the unfollowed done owner stays silent, exactly
    // as recorded — no discriminator, no marker, no ordinary visibility.
    const revivedLedger = ledgerAtBoot(revived)
    expect(revivedLedger.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(0)
    // Adopting a later rules version afterwards must not re-judge the legacy accept recorded before it.
    const table = revived.facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
    await new AgentTeamLedger(table, { rulesVersion: 2 }).initialize()
    const upgraded = new AgentTeamLedger(table, { rulesVersion: 2 })
    expect(() => upgraded.validate()).not.toThrow()
    expect(upgraded.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(0)
  })

  it('cold-replays a legacy Thread read snapshot whose activity facts were flagged by the mention-only rule', async () => {
    // The pre-receipt read record stored its whole picture, `direct` flags
    // included. Those flags were computed when only a mention marked a fact
    // direct, so a close that woke a follower reads `direct: false` in every
    // stored snapshot — responsibility events did not exist yet. Replay must
    // judge those flags by the era's rule; judging them by today's would
    // refuse the ledger of every release before the change.
    const pool = new MemoryMediaPool()
    const test = await harness(pool)
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { member, actor: follower } = await addLedgerMember(ledger, project.project.projectRef, 'member:follower', 'follower')
    await ledger.changeAttention({ requestId: requestId('legacy-follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor: follower })
    const humanRead = (await ledger.readThread({ requestId: requestId('legacy-close-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    committed((await ledger.changeTask({ requestId: requestId('legacy-close'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'close', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    const read = (await ledger.readThread({ requestId: requestId('legacy-snapshot-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: follower })).value
    expect(read.facts.some(entry => entry.fact.kind === 'activity' && entry.fact.activity.kind === 'close' && entry.unread)).toBe(true)

    const records = [...pool.media.get('agent_team')!.tables.get('operations')!.entries()]
    await test.fiber.dispose()
    cleanups.pop()
    const legacy = records.map(([key, operation]) => {
      const changed = operation as AgentTeamOperation
      if (changed.kind !== 'team/thread-read') return [key, operation] as [string, unknown]
      const receipt = changed.data as { readonly inbox: unknown }
      return [key, { ...changed, data: {
        workspaceId: alpha,
        memberId: member.memberId,
        task: read.task,
        thread: read.thread,
        claims: read.claims,
        anchor: read.anchor,
        anchorMentions: read.anchorMentions,
        facts: read.facts.map(entry => entry.fact.kind === 'activity' ? { ...entry, direct: false } : entry),
        readThroughSequence: read.readThroughSequence,
        remainingUnreadCount: read.remainingUnreadCount,
        inbox: receipt.inbox,
      } }] as [string, unknown]
    })
    const revived = await harness(storedPool(legacy))
    const revivedLedger = ledgerAtBoot(revived)
    expect(() => revivedLedger.validate()).not.toThrow()
    expect(revivedLedger.inbox(follower, { workspaceId: alpha }).totalUnreadCount).toBe(0)
  })

  it('records DMs as audit-only operations with idempotent retries and unchanged projections', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const sender = await addLedgerMember(ledger, project.project.projectRef, 'member:sender', 'sender')
    const receiver = await addLedgerMember(ledger, project.project.projectRef, 'member:receiver', 'receiver')

    const before = ledger.view({ workspaceId: alpha })
    const beforeInbox = ledger.inbox(receiver.actor, { workspaceId: alpha })
    const beforeStatus = ledger.status()

    const dm = (await ledger.sendDm({ requestId: requestId('dm-1'), workspaceId: alpha,
      recipientMemberId: receiver.member.memberId, body: 'quick check: is the build green?', actor: sender.actor })).value
    expect(dm.receipt).toMatchObject({ sequence: beforeStatus.sequence + 1 })
    expect(dm.recipient.memberId).toBe(receiver.member.memberId)

    // Audit-only: no Thread, Task, Message, or project membership appears.
    const after = ledger.view({ workspaceId: alpha })
    expect(after.threads).toHaveLength(before.threads.length)
    expect(after.items).toHaveLength(before.items.length)
    expect(after.claims).toHaveLength(before.claims.length)
    // No Inbox semantics: unread/direct counts stay untouched for both sides.
    expect(ledger.inbox(receiver.actor, { workspaceId: alpha })).toEqual(beforeInbox)
    expect(ledger.inbox(sender.actor, { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [], recent: [], hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })

    // Idempotent retry: same requestId resolves the same receipt, no second append.
    const retry = (await ledger.sendDm({ requestId: requestId('dm-1'), workspaceId: alpha,
      recipientMemberId: receiver.member.memberId, body: 'quick check: is the build green?', actor: sender.actor })).value
    expect(retry.receipt).toEqual(dm.receipt)
    expect(ledger.status().operationCount).toBe(beforeStatus.operationCount + 1)

    // The adjacent-context lookup finds the exchange in both directions.
    expect(ledger.dmHistoryBetween(receiver.member.sessionId, sender.member.memberId)).toContain('quick check')
    expect(ledger.dmHistoryBetween(sender.member.sessionId, receiver.member.memberId)).toContain('quick check')

    const cold = ledgerAtBoot(test)
    expect(() => cold.validate()).not.toThrow()
    expect(cold.dmHistoryBetween(receiver.member.sessionId, sender.member.memberId)).toContain('quick check')
  })

  it('rejects DMs to other Workspaces, the Human, and the sender itself', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    // A second Workspace with its own Member: cross-workspace DM must fail.
    const betaProject = await test.ctx.agentTeam.createProject({ requestId: requestId('beta-project'), workspaceId: beta, name: 'beta', description: '' })
    const ledger = ledgerAtBoot(test)
    const sender = await addLedgerMember(ledger, project.project.projectRef, 'member:sender', 'sender')
    const betaLedgerMember = {
      memberId: 'member:beta-peer' as never,
      sessionId: SessionId('session:beta-peer'),
      workspaceId: beta,
      handle: 'beta-peer', description: 'Beta peer', presetId: 'team-member',
      privateMemoryPath: '/tmp/beta-peer', state: 'enabled' as const,
    }
    await ledger.addMember({ requestId: requestId('add-beta'), actor: agentTeamHumanActor(), member: betaLedgerMember, handle: betaLedgerMember.handle,
      description: betaLedgerMember.description, presetId: betaLedgerMember.presetId, workspaceId: beta,
      projectRefs: [betaProject.project.projectRef] })
    const receiver = await addLedgerMember(ledger, project.project.projectRef, 'member:receiver', 'receiver')

    await expect(ledger.sendDm({ requestId: requestId('dm-cross'), workspaceId: alpha,
      recipientMemberId: 'member:beta-peer' as never, body: 'hi', actor: sender.actor })).rejects.toThrow(/not in Workspace/)
    await expect(ledger.sendDm({ requestId: requestId('dm-human'), workspaceId: alpha,
      recipientMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, body: 'hi', actor: sender.actor })).rejects.toThrow(/Agent Member/)
    await expect(ledger.sendDm({ requestId: requestId('dm-self'), workspaceId: alpha,
      recipientMemberId: sender.member.memberId, body: 'hi', actor: sender.actor })).rejects.toThrow(/themselves/)
    await expect(ledger.sendDm({ requestId: requestId('dm-empty'), workspaceId: alpha,
      recipientMemberId: receiver.member.memberId, body: '   ', actor: sender.actor })).rejects.toThrow(/empty/)
  })

  it('closes an unclaimed todo Task through the close path, not acceptance', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const closed = committed((await ledger.changeTask({ requestId: requestId('close'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'close', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(closed.task).toMatchObject({ status: 'closed', resolution: 'closed' })
    expect(closed.activity.kind).toBe('close')
    const reopened = committed((await ledger.changeTask({ requestId: requestId('reopen'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'reopen', baseRevision: closed.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(reopened.task).toMatchObject({ status: 'todo', resolution: 'open' })
    expect(reopened.activity.refollowedMembers).toEqual([])
    await ledger.changeAttention({ requestId: requestId('follow-after-reopen'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'follow', actor: agentTeamHumanActor() })
    expect(ledger.attentionStatus(agentTeamHumanActor(), { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toBeDefined()
    const accepted = committed((await ledger.changeTask({ requestId: requestId('accept-before-reopen'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: reopened.thread.revision, actor: agentTeamHumanActor() })).value)
    const reopenedAccepted = committed((await ledger.changeTask({ requestId: requestId('reopen-after-accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'reopen', baseRevision: accepted.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(reopenedAccepted.activity.refollowedMembers).toEqual([])
    expect(ledgerAtBoot(test).attentionStatus(agentTeamHumanActor(), { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toBeDefined()
    ledger.validate()
  })

  it('resolves branded Task refs to navigation facts and omits unknown refs', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const first = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('first'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'first task' })))
    const second = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('second'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'second task' })))
    const resolved = test.ctx.agentTeam.resolveTaskRefs({ workspaceId: alpha, taskRefs: [first.task.taskRef, second.task.taskRef, 'task:00000000-0000-4000-8000-000000000000' as AgentTeamTaskRef] })
    expect(resolved.resolved).toEqual([
      { taskRef: first.task.taskRef, projectRef: project.project.projectRef, threadRef: first.thread.threadRef, taskNumber: 1 },
      { taskRef: second.task.taskRef, projectRef: project.project.projectRef, threadRef: second.thread.threadRef, taskNumber: 2 },
    ])
    // Display numbers are per home Project: a second Project's first Task
    // resolves as #1 even though it is the workspace's third Task, and a
    // Project-less view (inbox renders) numbers it the same way.
    const other = await test.ctx.agentTeam.createProject({ requestId: requestId('other'), workspaceId: alpha, name: 'audit', description: 'Audit trail' })
    const audit = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('audit'), workspaceId: alpha, projectRef: other.project.projectRef, body: 'audit task' })))
    const crossProject = test.ctx.agentTeam.resolveTaskRefs({ workspaceId: alpha, taskRefs: [audit.task.taskRef, second.task.taskRef] })
    expect(crossProject.resolved).toEqual([
      { taskRef: audit.task.taskRef, projectRef: other.project.projectRef, threadRef: audit.thread.threadRef, taskNumber: 1 },
      { taskRef: second.task.taskRef, projectRef: project.project.projectRef, threadRef: second.thread.threadRef, taskNumber: 2 },
    ])
    const projectless = test.ctx.agentTeam.view({ workspaceId: alpha })
    expect(projectless.taskNumbers).toContainEqual({ taskRef: audit.task.taskRef, taskNumber: 1 })
    expect(projectless.taskNumbers).toContainEqual({ taskRef: second.task.taskRef, taskNumber: 2 })
    // An unregistered workspace is rejected before any lookup.
    expect(() => test.ctx.agentTeam.resolveTaskRefs({ workspaceId: beta, taskRefs: [first.task.taskRef] })).toThrow(/unknown Workspace/)
  })

  it('resolves branded Thread refs to navigation facts and omits unknown refs', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('thread-refs-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const first = committed(await test.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('thread-refs-first'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'alpha discussion opens here' }))
    const second = committed(await test.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('thread-refs-second'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'beta discussion opens here' }))
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('thread-refs-task'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'task work' })))
    // Taskless Threads resolve with their opening-line title and no Task
    // overlay; taskful Threads carry the Task home alongside the same title.
    // Unknown refs are omitted so message bodies render them as plain text.
    const resolved = test.ctx.agentTeam.resolveThreadRefs({ workspaceId: alpha, threadRefs: [first.thread.threadRef, second.thread.threadRef, started.thread.threadRef, 'thread:00000000-0000-4000-8000-000000000000' as AgentTeamThreadRef] })
    expect(resolved.resolved).toEqual([
      { threadRef: first.thread.threadRef, projectRef: project.project.projectRef, title: 'alpha discussion opens here' },
      { threadRef: second.thread.threadRef, projectRef: project.project.projectRef, title: 'beta discussion opens here' },
      { threadRef: started.thread.threadRef, projectRef: project.project.projectRef, taskRef: started.task.taskRef, taskNumber: 1, title: 'task work' },
    ])
    // The abbreviated spelling from the report (8 hex chars) resolves when
    // unambiguous, answering with the full ref the click path navigates by.
    const abbreviated = `thread:${first.thread.threadRef.slice('thread:'.length).replaceAll('-', '').slice(0, 8).toLowerCase()}` as AgentTeamThreadRef
    expect(test.ctx.agentTeam.resolveThreadRefs({ workspaceId: alpha, threadRefs: [abbreviated] }).resolved).toEqual([
      { threadRef: first.thread.threadRef, projectRef: project.project.projectRef, title: 'alpha discussion opens here' },
    ])
    // The same abbreviation addresses the bounded Thread view: the filter
    // compares the resolved full key, not the authored spelling (task #17 root
    // cause — an empty view here is what made chip clicks silently no-op).
    expect(test.ctx.agentTeam.view({ workspaceId: alpha, threadRef: abbreviated }).items).toHaveLength(1)
    // An unregistered workspace is rejected before any lookup.
    expect(() => test.ctx.agentTeam.resolveThreadRefs({ workspaceId: beta, threadRefs: [first.thread.threadRef] })).toThrow(/unknown Workspace/)
  })

  it('caps resolved Thread chip titles at 40 characters', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('thread-title-project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const exact = `x${'y'.repeat(38)}z`
    const exactThread = committed(await test.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('thread-title-exact'), workspaceId: alpha, projectRef: project.project.projectRef, body: exact }))
    // A 40-character opening line passes through untouched; anything longer
    // is cut to 39 characters plus the mark so chips share the line with prose.
    expect(test.ctx.agentTeam.resolveThreadRefs({ workspaceId: alpha, threadRefs: [exactThread.thread.threadRef] }).resolved).toEqual([
      { threadRef: exactThread.thread.threadRef, projectRef: project.project.projectRef, title: exact },
    ])
    const longThread = committed(await test.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('thread-title-long'), workspaceId: alpha, projectRef: project.project.projectRef, body: `${'a'.repeat(100)}\nsecond line` }))
    expect(test.ctx.agentTeam.resolveThreadRefs({ workspaceId: alpha, threadRefs: [longThread.thread.threadRef] }).resolved).toEqual([
      { threadRef: longThread.thread.threadRef, projectRef: project.project.projectRef, title: `${'a'.repeat(39)}…` },
    ])
  })

  it('adds an Agent with initial Project membership and persists no Inbox delivery facts', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const member = await test.ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: alpha, handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member', projectRefs: [project.project.projectRef] })
    expect(member.status.member).toMatchObject({ workspaceId: alpha, handle: 'reviewer' })
    expect(test.ctx.agentTeam.view({ workspaceId: alpha }).members).toEqual([{ projectRef: project.project.projectRef, memberId: member.status.member.memberId }])
    const records = [...(test.facility.get('agent_team')?.table('operations').entries() ?? [])].map(([, operation]) => JSON.stringify(operation))
    expect(records.join('\n')).not.toContain('delivery')
    expect(records.join('\n')).not.toContain('follow-changed')
  })

  it('opens a persisted Member with no initial Projects in a fresh Host', async () => {
    const first = await harness()
    const ledger = ledgerAtBoot(first)
    await addLedgerMember(ledger, undefined, 'member:bare', '')
    const records = [...first.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const revived = await harness(storedPool(records))
    expect(revived.ctx.agentTeam.status()).toMatchObject({ agentMemberCount: 1 })
    expect(() => ledgerAtBoot(revived).validate()).not.toThrow()
  })

  it('opens a persisted Project with no initial Members in a fresh Host', async () => {
    const first = await harness()
    await first.ctx.agentTeam.createProject({ requestId: requestId('bare-project'), workspaceId: alpha, name: 'ops', description: '' })
    const records = [...first.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const revived = await harness(storedPool(records))
    expect(revived.ctx.agentTeam.status()).toMatchObject({ projectCount: 1, agentMemberCount: 0 })
    expect(() => ledgerAtBoot(revived).validate()).not.toThrow()
  })

  it('delivers a direct Inbox notice for a mention in a Thread start without making the Member follow it', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, project.project.projectRef, 'member:builder')
    const before = ledger.status().sequence
    const sent = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('mention'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: '@builder please investigate this', actor: agentTeamHumanActor() })).value))
    expect(ledger.status().sequence).toBe(before + 1)
    expect(sent.attention.map(attention => attention.memberId)).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])
    expect(ledger.attentionStatus(actor, { workspaceId: alpha, threadRef: sent.thread.threadRef }).attention).toBeUndefined()
    expect(sent.directMarkers).toEqual([expect.objectContaining({ memberId: member.memberId, messageRef: sent.message.messageRef })])
    expect(ledger.inbox(actor, { workspaceId: alpha })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1,
      items: [expect.objectContaining({ task: expect.objectContaining({ taskRef: sent.task.taskRef }), directCount: 1 })] })
    ledger.validate()
    expect(ledgerAtBoot(test).inbox(actor, { workspaceId: alpha })).toMatchObject({ totalUnreadCount: 1, totalDirectCount: 1 })
  })

  it('records the Message a reply answers and delivers to that Message author', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor: builderActor } = await addLedgerMember(ledger, project.project.projectRef, 'member:builder')
    const { actor: reviewerActor } = await addLedgerMember(ledger, project.project.projectRef, 'member:reviewer')

    const sent = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('anchor'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'Please investigate this', actor: agentTeamHumanActor() })).value))
    // The anchor mentions the builder, so the unread fence stands until the
    // builder acknowledges it; an unread mutation would be refused.
    await ledger.readThread({ requestId: requestId('builder-read'), workspaceId: alpha, taskRef: sent.task.taskRef, actor: builderActor })
    const builderReply = committed((await ledger.reply({ requestId: requestId('builder-reply'), workspaceId: alpha,
      taskRef: sent.task.taskRef, baseRevision: sent.thread.revision, body: 'Looking now',
      replyToMessageRef: sent.message.messageRef, actor: builderActor })).value)
    expect(builderReply.message.replyToMessageRef).toBe(sent.message.messageRef)

    // A fresh replay resolves the parent from the stored operations alone: the
    // reviewer's write below is refused outright if the link did not survive.
    const replayed = ledgerAtBoot(test)
    const before = replayed.inbox(builderActor, { workspaceId: alpha })
    const reviewerReply = committed((await replayed.reply({ requestId: requestId('reviewer-reply'), workspaceId: alpha,
      taskRef: sent.task.taskRef, baseRevision: builderReply.thread.revision, body: 'One correction',
      replyToMessageRef: builderReply.message.messageRef, actor: reviewerActor })).value)
    expect(reviewerReply.message.replyToMessageRef).toBe(builderReply.message.messageRef)

    // Answering a Member reaches them without a hand-written `@handle`.
    const after = replayed.inbox(builderActor, { workspaceId: alpha })
    expect(after.totalUnreadCount).toBe(before.totalUnreadCount + 1)
    expect(after.totalDirectCount).toBe(before.totalDirectCount + 1)

    // The quote block's context is resolved from the ledger, so a parent far
    // outside the reader's loaded window still resolves; unknown refs are
    // omitted rather than faked.
    const resolvable = replayed.resolveMessageRefs(alpha, [sent.message.messageRef, 'message:missing' as never])
    expect(resolvable).toHaveLength(1)
    expect(resolvable[0]).toMatchObject({
      messageRef: sent.message.messageRef,
      threadRef: sent.thread.threadRef,
      sender: AGENT_TEAM_HUMAN_MEMBER_ID,
      excerpt: 'Please investigate this',
    })
    replayed.validate()
  })

  it('refuses a reply target that is unknown or belongs to another Thread', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef, 'member:builder')
    const first = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('first'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'First thread', actor: agentTeamHumanActor() })).value))
    const second = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('second'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'Second thread', actor: agentTeamHumanActor() })).value))

    await expect(ledger.reply({ requestId: requestId('unknown-target'), workspaceId: alpha, taskRef: first.task.taskRef,
      baseRevision: first.thread.revision, body: 'Answering nothing', replyToMessageRef: 'message:missing' as never, actor }))
      .rejects.toThrow(/not a recorded Message/)
    await expect(ledger.reply({ requestId: requestId('foreign-target'), workspaceId: alpha, taskRef: first.task.taskRef,
      baseRevision: first.thread.revision, body: 'Answering another thread', replyToMessageRef: second.message.messageRef, actor }))
      .rejects.toThrow(/another Thread/)
    // Nothing was written by either refusal.
    const facts = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: first.task.taskRef, actor })).value.facts
    expect(facts).toHaveLength(0)
  })

  it('reads one Message back verbatim, by identity rather than by its neighbours', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef, 'member:builder')
    // A body whose summary cannot stand in for it: a short first line, a
    // mention, and more than the quote's 120-character bound behind it.
    const longBody = `Please investigate this\n第二行 @reviewer 提到别人\n${'x'.repeat(200)}`
    const sent = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('anchor'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: longBody, actor: agentTeamHumanActor() })).value)
    const middle = committed((await ledger.reply({ requestId: requestId('middle'), workspaceId: alpha,
      threadRef: sent.thread.threadRef, baseRevision: sent.thread.revision, body: 'A middle message', actor: agentTeamHumanActor() })).value)
    const last = committed((await ledger.reply({ requestId: requestId('last'), workspaceId: alpha,
      threadRef: sent.thread.threadRef, baseRevision: middle.thread.revision, body: 'The newest message', actor: agentTeamHumanActor() })).value)

    const readBack = ledger.readMessage(actor, { workspaceId: alpha, threadRef: sent.thread.threadRef, messageRef: sent.message.messageRef })
    // Verbatim: no ellipsis, no first-line-only summary, nothing trimmed.
    expect(readBack.body).toBe(longBody)
    expect(readBack.body.length).toBeGreaterThan(120)
    expect(readBack.body).not.toContain('…')
    expect(readBack).toMatchObject({ messageRef: sent.message.messageRef, threadRef: sent.thread.threadRef, projectRef: project.project.projectRef, sender: AGENT_TEAM_HUMAN_MEMBER_ID, sequence: sent.message.sequence })


    // Identity, not position: the Message before and the Message after come
    // back as themselves, so a ref can never quietly resolve to a neighbour.
    expect(ledger.readMessage(actor, { workspaceId: alpha, threadRef: sent.thread.threadRef, messageRef: middle.message.messageRef }).body).toBe('A middle message')
    expect(ledger.readMessage(actor, { workspaceId: alpha, threadRef: sent.thread.threadRef, messageRef: last.message.messageRef }).body).toBe('The newest message')
    // The quote's own bound still applies to the quote: the two are different
    // things and neither is derived from the other.
    expect(ledger.resolveMessageRefs(alpha, [sent.message.messageRef])[0]!.excerpt).toBe('Please investigate this')
  })

  it('reads one Message back through the Client Remote, on the Host\'s own ledger', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const longBody = `Please investigate this\n${'y'.repeat(200)}`
    const sent = committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('remote-anchor'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: longBody }))
    const readBack = test.ctx.agentTeam.readMessage({ workspaceId: alpha, threadRef: sent.thread.threadRef, messageRef: sent.message.messageRef })
    expect(readBack.body).toBe(longBody)
    expect(readBack).toMatchObject({ threadRef: sent.thread.threadRef, projectRef: project.project.projectRef, sender: AGENT_TEAM_HUMAN_MEMBER_ID, sequence: sent.message.sequence })
  })

  it('refuses an unknown Message, another Thread\'s Message, and an archived Project\'s — distinguishably', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef, 'member:builder')
    const first = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('first'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'First thread', actor: agentTeamHumanActor() })).value)
    const second = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('second'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'Second thread', actor: agentTeamHumanActor() })).value)

    // Each refusal names its own cause, so a reader can tell a wrong ref from a
    // closed Thread — and none of them returns a substitute body. Each refusal
    // also names the way out: a live model passed a fact sequence as a messageRef
    // and, told only that the Message was not recorded, abandoned the action.
    expect(() => ledger.readMessage(actor, { workspaceId: alpha, threadRef: first.thread.threadRef, messageRef: 'message:missing' as never }))
      .toThrow(/is not a recorded Message — copy a messageRef rendered by/)
    expect(() => ledger.readMessage(actor, { workspaceId: alpha, threadRef: first.thread.threadRef, messageRef: second.message.messageRef }))
      .toThrow(/belongs to another Thread — read that Thread first, or copy a messageRef/)
    expect(() => ledger.readMessage(actor, { workspaceId: alpha, threadRef: 'thread:missing' as never, messageRef: first.message.messageRef }))
      .toThrow(/unknown Thread ref/)

    await ledger.archiveProject({ requestId: requestId('archive'), workspaceId: alpha, projectRef: project.project.projectRef, actor: agentTeamHumanActor() })
    expect(() => ledger.readMessage(actor, { workspaceId: alpha, threadRef: first.thread.threadRef, messageRef: first.message.messageRef }))
      .toThrow(/is archived/)
  })

  it('serves the Human Inbox with row previews and whole-unread totals', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    // One ledger instance commits and projects every step below: a second
    // instance's state is its construction-time replay, so mixing instances
    // would resolve refs against a stale snapshot.
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef, 'member:builder')

    // A followed Thread carrying BOTH an unread mention and ordinary follow
    // unread: one row, and the badge counts every unread fact on it.
    const followed = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('followed'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Followed thread anchor', actor: agentTeamHumanActor() })).value))
    const mentioned = committed((await ledger.reply({ requestId: requestId('mention'), workspaceId: alpha, taskRef: followed.task.taskRef, body: '@human decision needed on the rollout', baseRevision: followed.thread.revision, actor })).value)
    committed((await ledger.reply({ requestId: requestId('ordinary'), workspaceId: alpha, taskRef: followed.task.taskRef, body: 'Ordinary progress reply', baseRevision: mentioned.thread.revision, actor })).value)

    // An unfollowed Thread whose fresh mention must still surface: direct
    // markers never depended on Human follow. Its anchor's first line exceeds
    // the 120-character preview bound the Thread page applies to Task titles.
    const unfollowed = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('unfollowed'), workspaceId: alpha, projectRef: project.project.projectRef, body: `${'x'.repeat(130)}\nsecond line`, actor: agentTeamHumanActor() })).value))
    await ledger.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: unfollowed.task.taskRef, action: 'unfollow', actor: agentTeamHumanActor() })
    committed((await ledger.reply({ requestId: requestId('ping'), workspaceId: alpha, taskRef: unfollowed.task.taskRef, body: '@human blocking on your call', baseRevision: unfollowed.thread.revision, actor })).value)

    const inbox = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    // Rows: both Threads carry one mention, so newest unread first — the ping
    // (seq 8) over the followed Thread's ordinary reply (seq 5).
    expect(inbox.items.map(item => item.thread.threadRef)).toEqual([unfollowed.task.threadRef, followed.task.threadRef])
    // The badge counts every unread fact, mentions included rather than alone.
    expect(inbox.totalUnreadCount).toBe(3)
    expect(inbox.totalDirectCount).toBe(2)
    expect(inbox.items[1]).toMatchObject({
      projectRef: project.project.projectRef, projectName: 'engineering', taskNumber: 1,
      directCount: 1, unreadCount: 2, previewText: 'Followed thread anchor',
    })
    expect(inbox.items[0]).toMatchObject({
      projectName: 'engineering', taskNumber: 2, directCount: 1, unreadCount: 1,
      previewText: `${'x'.repeat(119)}…`,
    })
    expect(inbox.items[0]?.newestOccurredAt).not.toBe('')
    const cold = ledgerAtBoot(test)
    expect(cold.inbox(agentTeamHumanActor(), { workspaceId: alpha }).totalUnreadCount).toBe(3)

    // The durable Thread read consumes the mention marker and the unread
    // behind it, so the next call no longer offers the Thread — while the
    // followed Thread keeps both its mention and its ordinary unread.
    await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: unfollowed.task.taskRef, actor: agentTeamHumanActor() })
    const after = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    expect(after.items.map(item => item.thread.threadRef)).toEqual([followed.task.threadRef])
    expect(after.totalUnreadCount).toBe(2)
    expect(after.totalDirectCount).toBe(1)
  })

  it('discloses a capped unread queue instead of letting a full page read as all of it', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef, 'member:builder')
    let lastTaskRef: AgentTeamTaskRef | undefined
    for (const [index, body] of ['First thread anchor', 'Second thread anchor'].entries()) {
      const started = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId(`capped-${index}`), workspaceId: alpha, projectRef: project.project.projectRef, body, actor: agentTeamHumanActor() })).value))
      committed((await ledger.reply({ requestId: requestId(`capped-reply-${index}`), workspaceId: alpha, taskRef: started.task.taskRef, body: `Progress on thread ${index}`, baseRevision: started.thread.revision, actor })).value)
      lastTaskRef = started.task.taskRef
    }
    // Two Threads hold unread; a page with room for one must say the queue goes on.
    const capped = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha, limit: 1 })
    expect(capped.items).toHaveLength(1)
    expect(capped.hasMore).toBe(true)
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha, limit: 2 })).toMatchObject({ hasMore: false })
    // Reading a Thread drains it from the queue, which is the way back to the
    // row the capped page hid — no cursor, no guessing.
    await ledger.readThread({ requestId: requestId('capped-read'), workspaceId: alpha, taskRef: lastTaskRef!, actor: agentTeamHumanActor() })
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha, limit: 1 }).hasMore).toBe(false)
  })

  it('serves pure follow unread on the same data', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef, 'member:builder')
    // The Human creates the Thread and therefore follows it; the Agent's reply
    // carries NO mentions parameter, so the only unread it produces is the
    // ordinary follow unread — which is exactly what the Inbox now admits,
    // with no mention marker behind it.
    const started = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Pure follow thread anchor', actor: agentTeamHumanActor() })).value))
    committed((await ledger.reply({ requestId: requestId('progress'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Ordinary progress, nobody mentioned', baseRevision: started.thread.revision, actor })).value)

    const inbox = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    expect(inbox.totalUnreadCount).toBe(1)
    expect(inbox.totalDirectCount).toBe(0)
    expect(inbox.items).toHaveLength(1)
    expect(inbox.items[0]).toMatchObject({ thread: { threadRef: started.task.threadRef }, unreadCount: 1, directCount: 0 })
    expect(ledgerAtBoot(test).inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual(inbox)
  })

  it('keeps the later follow watermark when an older direct marker is consumed', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    const unfollowed = threadAttentionOf(await ledger.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'unfollow', actor: agentTeamHumanActor() }))
    const mentioned = committed((await ledger.reply({ requestId: requestId('mention'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: '@human please check this', baseRevision: unfollowed.thread.revision, actor })).value)
    const ordinary = committed((await ledger.reply({ requestId: requestId('ordinary'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Later reply', baseRevision: mentioned.thread.revision, actor })).value)
    const followed = threadAttentionOf(await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'follow', actor: agentTeamHumanActor() }))
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    expect(followed.attention).toMatchObject({ readThroughSequence: ordinary.message.sequence })
    expect(read.readThroughSequence).toBe(ordinary.message.sequence)
    expect(read.consumedDirectMarkers).toEqual([expect.objectContaining({ messageRef: mentioned.message.messageRef })])
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [],
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.task.threadRef }), unreadCount: 0, directCount: 0 })],
      hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })
    const replay = ledgerAtBoot(test)
    expect(replay.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [],
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.task.threadRef }), unreadCount: 0, directCount: 0 })],
      hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })
  })

  it('moves a participated Thread from the unread queue into the Human recent slice once it is read', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Rollout plan' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    committed((await ledger.reply({ requestId: requestId('reply'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'On it', baseRevision: started.thread.revision, actor })).value)
    // One Thread is never in both slices: while the reply is unread the row is
    // the queue's, and the tail admits nothing.
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })).toMatchObject({ items: [expect.objectContaining({ unreadCount: 1 })], recent: [] })
    await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })
    const inbox = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    expect(inbox).toMatchObject({ items: [], totalUnreadCount: 0,
      recent: [expect.objectContaining({ projectName: 'engineering', taskNumber: 1, previewText: 'Rollout plan', unreadCount: 0, directCount: 0,
        thread: expect.objectContaining({ threadRef: started.task.threadRef }) })] })
    expect(ledgerAtBoot(test).inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual(inbox)
    // The tail is a Human surface: an Agent's Inbox stays exactly its unread
    // queue however much that Agent took part in the Thread.
    expect(ledger.inbox(actor, { workspaceId: alpha })).toMatchObject({ recent: [] })
  })

  it('admits every Thread the reader wrote in and nothing they only arrived at', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await makeOwner(ledger, project.project.projectRef, actor.memberId)
    // Three Threads, three ways a Human reader meets one. Their own Thread with
    // nobody else in it is theirs from the start; somebody else's Thread they
    // replied to is theirs too, even though a reply does not follow a Thread —
    // that gap is exactly what reading Attention as the candidate set used to
    // hide; and a Thread they were told about but never wrote in stays out,
    // because participation, not arrival, is the admission rule.
    const alone = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('alone'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Notes to self', actor: agentTeamHumanActor() })).value)
    const theirs = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('theirs'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Agent thread', actor })).value)
    committed((await ledger.reply({ requestId: requestId('join'), workspaceId: alpha, threadRef: theirs.thread.threadRef, body: 'Looking now', baseRevision: theirs.thread.revision, actor: agentTeamHumanActor() })).value)
    const told = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId('told'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Status only', actor })).value)
    for (const [name, threadRef] of [['alone', alone.thread.threadRef], ['theirs', theirs.thread.threadRef], ['told', told.thread.threadRef]] as const) {
      await ledger.readThread({ requestId: requestId(`read-${name}`), workspaceId: alpha, threadRef, actor: agentTeamHumanActor() })
    }
    const inbox = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    expect(inbox.items).toEqual([])
    // Newest activity first: the reader's reply on somebody else's Thread is the
    // freshest, their own unanswered Thread follows.
    expect(inbox.recent.map(item => item.thread.threadRef)).toEqual([theirs.thread.threadRef, alone.thread.threadRef])
    // A row draws the actor by name, and the Human is the one Member the Agent
    // roster never holds: the row reads the runtime display name instead of
    // falling back to the durable id, and a rename moves it without touching
    // that id.
    expect(inbox.recent.map(item => item.newestActor)).toEqual([
      { memberId: AGENT_TEAM_HUMAN_MEMBER_ID, name: AGENT_TEAM_HUMAN_HANDLE },
      { memberId: AGENT_TEAM_HUMAN_MEMBER_ID, name: AGENT_TEAM_HUMAN_HANDLE },
    ])
    ledger.setHumanDisplayHandle('Ada')
    expect(ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha }).recent.map(item => item.newestActor))
      .toEqual([{ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, name: 'Ada' }, { memberId: AGENT_TEAM_HUMAN_MEMBER_ID, name: 'Ada' }])
    expect(ledgerAtBoot(test).inbox(agentTeamHumanActor(), { workspaceId: alpha })).toEqual(inbox)
  })

  it('bounds the Human recent slice to the ten newest participated Threads', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    for (let index = 0; index < 11; index += 1) {
      const started = committed((await ledger.startThread({ kind: 'discussion', requestId: requestId(`start-${index}`), workspaceId: alpha, projectRef: project.project.projectRef, body: `Thread ${index}`, actor: agentTeamHumanActor() })).value)
      committed((await ledger.reply({ requestId: requestId(`reply-${index}`), workspaceId: alpha, threadRef: started.thread.threadRef, body: 'Ack', baseRevision: started.thread.revision, actor })).value)
      await ledger.readThread({ requestId: requestId(`read-${index}`), workspaceId: alpha, threadRef: started.thread.threadRef, actor: agentTeamHumanActor() })
    }
    const inbox = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
    expect(inbox.recent).toHaveLength(10)
    expect(inbox.recent[0]).toMatchObject({ previewText: 'Thread 10', unreadCount: 0 })
    expect(inbox.recent.some(item => item.previewText === 'Thread 0')).toBe(false)
  })

  it('lists every active Task Thread in the view radar for an Agent reader, whoever took part', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, project.project.projectRef)
    const { actor: bystander } = await addLedgerMember(ledger, project.project.projectRef, 'member:bystander', 'Bystander', 'Bystander')
    // A claimed Task (in_progress), a done Task still in review, and an untouched
    // Task with no Claim. The radar should carry the first two and drop the third.
    const claimed = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('claimed'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Claimed work', actor: agentTeamHumanActor() })).value))
    committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: claimed.task.taskRef, action: 'claim', direction: 'building it', baseRevision: claimed.thread.revision, actor })).value)
    const reviewed = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('reviewed'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Reviewed work', actor: agentTeamHumanActor() })).value))
    const reviewClaim = committed((await ledger.changeClaim({ requestId: requestId('review-claim'), workspaceId: alpha, taskRef: reviewed.task.taskRef, action: 'claim', direction: 'reviewing it', baseRevision: reviewed.thread.revision, actor })).value)
    committed((await ledger.changeClaim({ requestId: requestId('review-done'), workspaceId: alpha, taskRef: reviewed.task.taskRef, action: 'done', claimRef: reviewClaim.claim.claimRef, baseRevision: reviewClaim.thread.revision, actor })).value)
    withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('idle'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Idle work', actor: agentTeamHumanActor() })).value))
    // The bystander never wrote in either active Thread, yet the radar surfaces
    // both to them: admission is the Task being active, not participation.
    const radar = inFlight(ledger, alpha, bystander.memberId)
    expect(radar.map(row => row.threadRef).sort()).toEqual([claimed.task.threadRef, reviewed.task.threadRef].sort())
    const claimedRow = radar.find(row => row.threadRef === claimed.task.threadRef)!
    expect(claimedRow).toMatchObject({ status: 'in_progress', subject: 'Claimed work', taskNumber: 1 })
    expect(claimedRow.members.map(m => m.memberId)).toEqual([member.memberId])
    expect(radar.find(row => row.threadRef === reviewed.task.threadRef)).toMatchObject({ status: 'in_review', subject: 'Reviewed work' })
  })

  it('keeps an active Task Thread in the radar even while the reader has it unread', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await makeOwner(ledger, project.project.projectRef, actor.memberId)
    const { actor: reader } = await addLedgerMember(ledger, project.project.projectRef, 'member:reader', 'Reader', 'Reader')
    const started = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: '@Reader active task', actor })).value))
    committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'claim', direction: 'on it', baseRevision: started.thread.revision, actor })).value)
    // The reader was mentioned and has an unread on this Thread — the unread
    // queue carries it, and so does the radar, independently.
    const inbox = ledger.inbox(reader, { workspaceId: alpha })
    expect(inbox.items.some(item => item.thread.threadRef === started.task.threadRef)).toBe(true)
    const radar = inFlight(ledger, alpha, reader.memberId)
    expect(radar.map(row => row.threadRef)).toEqual([started.task.threadRef])
  })

  it('excludes archived-Project Tasks and isolates Workspaces in the view radar', async () => {
    const test = await harness(new MemoryMediaPool(), [alpha, beta])
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, undefined)
    await ledger.joinWorkspace({ requestId: requestId('join-beta'), workspaceId: beta, memberId: member.memberId, actor: agentTeamHumanActor() })
    const alphaProject = (await ledger.createProject({ requestId: requestId('alpha-ch'), workspaceId: alpha, name: 'alpha', description: '', memberIds: [member.memberId], actor: agentTeamHumanActor() })).value.project
    const betaProject = (await ledger.createProject({ requestId: requestId('beta-ch'), workspaceId: beta, name: 'beta', description: '', memberIds: [member.memberId], actor: agentTeamHumanActor() })).value.project
    await makeOwner(ledger, betaProject.projectRef, member.memberId, beta)
    await makeOwner(ledger, alphaProject.projectRef, member.memberId)
    const betaTask = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('beta-task'), workspaceId: beta, projectRef: betaProject.projectRef, body: 'Beta work', actor })).value))
    committed((await ledger.changeClaim({ requestId: requestId('beta-claim'), workspaceId: beta, taskRef: betaTask.task.taskRef, action: 'claim', direction: 'beta angle', baseRevision: betaTask.thread.revision, actor })).value)
    // Beta's active Task does not leak into the alpha radar.
    expect(inFlight(ledger, alpha, member.memberId)).toEqual([])
    // An active Task whose Project is then archived leaves the radar.
    const alphaTask = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('alpha-task'), workspaceId: alpha, projectRef: alphaProject.projectRef, body: 'Alpha work', actor })).value))
    committed((await ledger.changeClaim({ requestId: requestId('alpha-claim'), workspaceId: alpha, taskRef: alphaTask.task.taskRef, action: 'claim', direction: 'alpha angle', baseRevision: alphaTask.thread.revision, actor })).value)
    expect(inFlight(ledger, alpha, member.memberId).map(row => row.threadRef)).toEqual([alphaTask.task.threadRef])
    await ledger.archiveProject({ requestId: requestId('alpha-arch'), workspaceId: alpha, projectRef: alphaProject.projectRef, actor: agentTeamHumanActor() })
    expect(inFlight(ledger, alpha, member.memberId)).toEqual([])
  })

  it('leaves the view radar empty when no Task has an active Claim', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await makeOwner(ledger, project.project.projectRef, actor.memberId)
    // A taskful Thread with no Claim stays at todo and never enters the radar.
    withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('todo'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Unclaimed task', actor })).value))
    expect(inFlight(ledger, alpha, actor.memberId)).toEqual([])
  })

  it('boards an in-progress Task that has been untouched for longer than a read window', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor, member } = await addLedgerMember(ledger, project.project.projectRef)
    const busy = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('busy'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Moving target', actor: agentTeamHumanActor() })).value))
    const quiet = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('quiet'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Quiet task', actor: agentTeamHumanActor() })).value))
    committed((await ledger.changeClaim({ requestId: requestId('quiet-claim'), workspaceId: alpha, taskRef: quiet.task.taskRef, action: 'claim', direction: 'on it', baseRevision: quiet.thread.revision, actor })).value)
    // Forty later Messages push the claim far outside any bounded read window.
    let revision = busy.thread.revision
    for (let index = 0; index < 40; index += 1) {
      const reply = committed((await ledger.reply({ requestId: requestId(`busy-${index}`), workspaceId: alpha, taskRef: busy.task.taskRef,
        body: `Progress ${index}`, baseRevision: revision, actor: agentTeamHumanActor() })).value)
      revision = reply.thread.revision
    }
    const board = ledger.taskBoard(actor, { workspaceId: alpha }).open.filter(item => item.task.taskRef === quiet.task.taskRef)
    expect(board).toHaveLength(1)
    expect(board[0]).toMatchObject({ task: { status: 'in_progress' }, liveClaimOwners: [expect.objectContaining({ memberId: member.memberId })] })
  })

  // State-requests 04: a bounded read returns the catalog of what it shows, not
  // the Workspace's whole Task/Thread/Claim history. `includeCatalog` is the one
  // way to ask for the address-book projection `team_view` renders.
  it('bounds the view catalog to the page unless the caller asks for the whole scope', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, project.project.projectRef)
    const started = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'First task', actor: agentTeamHumanActor() })).value))
    committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'claim', direction: 'on it', baseRevision: started.thread.revision, actor })).value)
    // 39 more Tasks behind it: a newest-first page of one cannot cover them.
    let newest = started
    for (let index = 1; index < 40; index += 1) {
      newest = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId(`task-${index}`), workspaceId: alpha,
        projectRef: project.project.projectRef, body: `Task ${index}`, actor: agentTeamHumanActor() })).value))
      committed((await ledger.changeClaim({ requestId: requestId(`claim-${index}`), workspaceId: alpha, taskRef: newest.task.taskRef, action: 'claim',
        direction: `on ${index}`, baseRevision: newest.thread.revision, actor })).value)
    }

    // A one-item catalog read describes that item's own Thread and Task, and
    // still names the requested Thread even when the page shows no fact of it.
    const page = ledger.view({ workspaceId: alpha, limit: 1 })
    expect(page.items).toHaveLength(1)
    const shown = page.items[0]!
    expect(page.threads.map(thread => thread.threadRef)).toEqual([shown.thread.threadRef])
    expect(page.tasks.map(task => task.taskRef)).toEqual([shown.task!.taskRef])
    expect(page.taskNumbers).toEqual([{ taskRef: shown.task!.taskRef, taskNumber: shown.taskNumber }])
    expect(page.claims.map(claim => claim.taskRef)).toEqual([shown.task!.taskRef])
    const named = ledger.view({ workspaceId: alpha, threadRef: started.thread.threadRef, limit: 1 })
    expect(named.threads.map(thread => thread.threadRef)).toEqual([started.thread.threadRef])
    expect(named.taskNumbers).toEqual([{ taskRef: started.task.taskRef, taskNumber: 1 }])

    // The whole-scope catalog is one explicit request away, and it is complete.
    const catalog = ledger.view({ workspaceId: alpha, limit: 1, includeCatalog: true })
    expect(catalog.items).toHaveLength(1)
    expect(catalog.threads).toHaveLength(40)
    expect(catalog.tasks).toHaveLength(40)
    expect(catalog.taskNumbers).toHaveLength(40)
    expect(catalog.claims).toHaveLength(40)
    expect(catalog.claims.every(claim => claim.owner === member.memberId)).toBe(true)
  })

  // The Inbox totals rank and count every unread Thread, while only the rows the
  // response returns are materialized: a one-row badge still reports the whole
  // unread queue instead of the slice it happened to keep.
  it('reports whole-queue Inbox totals from a bounded one-row read', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    for (let index = 0; index < 6; index += 1) {
      const started = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId(`task-${index}`), workspaceId: alpha,
        projectRef: project.project.projectRef, body: `Task ${index}`, actor: agentTeamHumanActor() })).value))
      await ledger.reply({ requestId: requestId(`reply-${index}`), workspaceId: alpha, taskRef: started.task.taskRef,
        body: `Update ${index}`, baseRevision: started.thread.revision, actor })
    }
    const badge = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha, limit: 1 })
    expect(badge.items).toHaveLength(1)
    expect(badge.totalUnreadCount).toBe(6)
    expect(badge.totalDirectCount).toBe(0)
    expect(badge.items[0]!.unreadCount).toBe(1)
    // The returned row is still the ranked first row of the whole queue.
    const full = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha, limit: 100 })
    expect(full.items).toHaveLength(6)
    expect(badge.items[0]!.thread.threadRef).toBe(full.items[0]!.thread.threadRef)
    expect(badge.items[0]!.previewText).toBe(full.items[0]!.previewText)
  })

  it('does not duplicate a direct marker when follow starts after the marker', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    const unfollowed = threadAttentionOf(await ledger.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'unfollow', actor: agentTeamHumanActor() }))
    const mentioned = committed((await ledger.reply({ requestId: requestId('mention'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: '@human please check this', baseRevision: unfollowed.thread.revision, actor })).value)
    const followed = threadAttentionOf(await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'follow', actor: agentTeamHumanActor() }))
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    expect(mentioned.directMarkers).toEqual([expect.objectContaining({ memberId: AGENT_TEAM_HUMAN_MEMBER_ID })])
    expect(followed.attention).toBeDefined()
    expect(read.facts.filter(fact => fact.fact.kind === 'message' && fact.fact.message.messageRef === mentioned.message.messageRef)).toHaveLength(1)
  })

  it('returns Human-only follow observations without changing public Thread facts or Inbox state', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    await test.ctx.agentTeam.changeAttention({ requestId: requestId('unfollow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'unfollow' })
    await test.ctx.agentTeam.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow' })

    expect(test.ctx.agentTeam.threadObservations({ workspaceId: alpha, taskRef: started.task.taskRef })).toEqual({
      items: [
        expect.objectContaining({ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, action: 'unfollow', taskRef: started.task.taskRef }),
        expect.objectContaining({ memberId: AGENT_TEAM_HUMAN_MEMBER_ID, action: 'follow', taskRef: started.task.taskRef }),
      ],
      // The observation history keeps both transitions; followers is the current state they lead to.
      followers: [AGENT_TEAM_HUMAN_MEMBER_ID],
      // Both transitions fit the default window, so nothing older is hidden.
      hasMore: false,
    })
    expect(test.ctx.agentTeam.view({ workspaceId: alpha, threadRef: started.thread.threadRef }).activities)
      .toEqual([expect.objectContaining({ kind: 'promote', taskRef: started.task.taskRef })])
    // Observations are Inbox-invisible: they change who gets notified, never
    // which Threads a reader took part in, so the Thread the Human started is
    // still the tail's only row after the unfollow/follow pair.
    expect(test.ctx.agentTeam.inbox({ workspaceId: alpha })).toMatchObject({ items: [], totalUnreadCount: 0, totalDirectCount: 0,
      recent: [expect.objectContaining({ thread: expect.objectContaining({ threadRef: started.task.threadRef }) })] })
  })

  it('reports how much of a Thread a bounded read left behind, so a returning reader can size what it has not read', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Thread anchor' })))
    const history = committed(await test.ctx.agentTeam.reply({ requestId: requestId('history'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Older discussion', baseRevision: started.thread.revision }))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef, 'member:reviewer', 'Reviews changes', 'reviewer')
    // Joining takes the watermark to the tail, so the two facts already in the
    // Thread stay behind an Attention period this member has never read through.
    const joined = threadAttentionOf(await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor }))
    expect(joined.attention).toMatchObject({ readThroughSequence: history.receipt.sequence })

    // The Thread moves on, and this member is answered with the background
    // window plus the new fact — while the count states the span behind both.
    const moved = committed((await ledger.reply({ requestId: requestId('moved-on'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Two days later', baseRevision: joined.thread.revision, actor: agentTeamHumanActor() })).value)
    const returning = (await ledger.readThread({ requestId: requestId('returning-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    expect(returning.facts.filter(entry => entry.unread).map(entry => entry.fact.sequence)).toEqual([moved.receipt.sequence])
    // Three facts exist before that batch — the creation's promote activity,
    // the anchor, and the older reply — all inside the response's own
    // background window, which is why the count is measured from what the
    // response starts at rather than from the watermark it advances to.
    expect(returning.earlierFactCount).toBe(3)
  })

  it('a read that reached a Thread\'s first fact reports nothing left behind it', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Only task' })))
    // The Thread holds one fact and this read acknowledges it, so the span
    // before what it was shown is empty and the render stays silent about it.
    const read = await test.ctx.agentTeam.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef })
    expect(read.earlierFactCount).toBe(0)
  })

  it('gates existing Thread mutations on unread work before revision and makes reads idempotent', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    const follow = await ledger.changeAttention({ requestId: requestId('agent-follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    expect(follow.value.attention).toMatchObject({ readThroughSequence: started.thread.revision })
    const update = committed((await ledger.reply({ requestId: requestId('human-update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'New evidence', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).value)
    const blocked = (await ledger.reply({ requestId: requestId('blocked'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Reply without read', baseRevision: started.thread.revision, actor })).value
    expect(blocked).toMatchObject({ kind: 'unread_required', revision: update.thread.revision })
    const readRequest = { requestId: requestId('agent-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor }
    const first = (await ledger.readThread(readRequest)).value
    expect(first.facts).toContainEqual(expect.objectContaining({ unread: true, fact: expect.objectContaining({ sequence: update.message.sequence }) }))
    // A retry republishes the original receipt — one durable record, one
    // watermark advance — and answers with the picture the current projection
    // derives, which the first read already drained.
    const retry = (await ledger.readThread(readRequest)).value
    expect(retry.receipt).toEqual(first.receipt)
    expect(retry.readThroughSequence).toBe(first.readThroughSequence)
    expect(retry.remainingUnreadCount).toBe(0)
    expect(retry.facts).toEqual([])
    expect([...test.facility.get('agent_team')!.table('operations').entries()]
      .filter(([, operation]) => (operation as AgentTeamOperation).kind === 'team/thread-read')).toHaveLength(1)
    const stale = (await ledger.reply({ requestId: requestId('stale'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Reply with obsolete revision', baseRevision: started.thread.revision, actor })).value
    expect(stale).toMatchObject({ kind: 'stale_revision', revision: update.thread.revision })
    expect(committed((await ledger.reply({ requestId: requestId('current'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Reply after read', baseRevision: update.thread.revision, actor })).value).message.body).toBe('Reply after read')
    ledger.validate()
  })

  it('a rejected write carries the facts it gated on and the token to retry with', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    const followed = await ledger.changeAttention({ requestId: requestId('agent-follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    expect(followed.value.attention).toMatchObject({ readThroughSequence: started.thread.revision })
    const update = committed((await ledger.reply({ requestId: requestId('human-update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'New evidence', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).value)

    // The unread gate answers with the very facts that gated it, in the same
    // shape a read returns — so the rejected writer sees WHAT is unread without
    // paying a separate read round-trip.
    const blocked = (await ledger.reply({ requestId: requestId('blocked'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Reply without read', baseRevision: started.thread.revision, actor })).value
    expect(blocked).toMatchObject({ kind: 'unread_required', revision: update.thread.revision, unreadCount: 1 })
    expect(blocked.kind === 'unread_required' && blocked.facts?.map(entry => entry.fact.sequence)).toEqual([update.message.sequence])
    expect(blocked.kind === 'unread_required' && blocked.facts?.[0]?.unread).toBe(true)

    // Reading drains the gate, so the NEXT write is gated by revision alone —
    // and that rejection answers with the increment past the obsolete token.
    const drained = (await ledger.readThread({ requestId: requestId('agent-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    expect(drained.remainingUnreadCount).toBe(0)
    // A member write advances the revision without adding unread for that same
    // member, so the only thing left to gate on is the stale token.
    const own = committed((await ledger.reply({ requestId: requestId('own-write'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'My own reply', baseRevision: update.thread.revision, actor })).value)
    const stale = (await ledger.reply({ requestId: requestId('stale'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Reply with obsolete revision', baseRevision: update.thread.revision, actor })).value
    expect(stale).toMatchObject({ kind: 'stale_revision', expectedRevision: update.thread.revision, revision: own.thread.revision })
    // The increment is exactly the facts committed after the token the writer
    // used — nothing before it, nothing the writer already knew about.
    expect(stale.kind === 'stale_revision' && stale.facts?.map(entry => entry.fact.sequence)).toEqual([own.message.sequence])
    // A retry with the revision the rejection named succeeds without any
    // further read: the round-trip the rejection used to force is gone.
    const readCount = () => [...test.facility.get('agent_team')!.table('operations').entries()]
      .filter(([, operation]) => (operation as AgentTeamOperation).kind === 'team/thread-read').length
    const readsBeforeRetry = readCount()
    expect(committed((await ledger.reply({ requestId: requestId('retry'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Retry with the named revision', baseRevision: own.thread.revision, actor })).value).message.body).toBe('Retry with the named revision')
    // The whole point of the project: the retry committed with zero additional
    // read operations, so the reject → read → write chain is now reject → write.
    expect(readCount()).toBe(readsBeforeRetry)
    ledger.validate()
  })

  it('makes a 21-update read continue explicit with a remaining unread count', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    const followed = await ledger.changeAttention({ requestId: requestId('follow-21'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    let revision = followed.value.attention?.readThroughSequence ?? started.thread.revision
    for (let index = 0; index < 21; index++) {
      const sent = committed((await ledger.reply({ requestId: requestId(`update-21-${index}`), workspaceId: alpha, taskRef: started.task.taskRef,
        body: `Update ${index + 1}`, baseRevision: revision, actor: agentTeamHumanActor() })).value)
      revision = sent.thread.revision
    }
    const firstRequest = { requestId: requestId('read-21-first'), workspaceId: alpha, taskRef: started.task.taskRef, actor }
    const first = (await ledger.readThread(firstRequest)).value
    expect(first.facts.filter(fact => fact.unread)).toHaveLength(20)
    expect(first.remainingUnreadCount).toBe(1)
    // The retry changes nothing durable, so it answers from the current
    // projection: the 21st update is still the one unread fact and the receipt
    // stays exactly the one the first read committed — a continuation a frozen
    // picture could not show.
    const retry = (await ledger.readThread(firstRequest)).value
    expect(retry.receipt).toEqual(first.receipt)
    expect(retry.facts.filter(fact => fact.unread)).toHaveLength(1)
    expect(retry.remainingUnreadCount).toBe(0)
    // A fresh read of that unchanged state derives the identical picture and
    // commits it as the explicit continuation.
    const second = (await ledger.readThread({ requestId: requestId('read-21-second'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    const { receipt: _retryReceipt, ...retryPicture } = retry
    const { receipt: _secondReceipt, ...secondPicture } = second
    expect(retryPicture).toEqual(secondPicture)
    expect(second.remainingUnreadCount).toBe(0)
  })

  it('counts remaining unread from the reader own marker state, not the whole ledger', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'First task' })))
    const other = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start-other'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Second task' })))
    const ledger = ledgerAtBoot(test)
    const { actor: reader, member: readerMember } = await addLedgerMember(ledger, project.project.projectRef)
    const { actor: bystander, member: bystanderMember } = await addLedgerMember(ledger, project.project.projectRef)
    await ledger.changeAttention({ requestId: requestId('follow-first'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor: reader })
    await ledger.changeAttention({ requestId: requestId('follow-second'), workspaceId: alpha, taskRef: other.task.taskRef, action: 'follow', actor: reader })
    // Following keeps the mention a plain marker: an unfollowed Member would
    // need a confirmation token, which is a different contract.
    await ledger.changeAttention({ requestId: requestId('follow-bystander'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor: bystander })
    // Every marker lives in exactly one Thread and belongs to exactly one
    // Member, so reading one Thread must consume that reader's own marker and
    // leave the other Thread's and the other Member's alone. The remaining
    // count is the reader-visible consequence of that consumption.
    let firstRevision = started.thread.revision
    const mentioned = committed((await ledger.reply({ requestId: requestId('mention-reader'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: `@${readerMember.handle} check this`, baseRevision: firstRevision, actor: agentTeamHumanActor() })).value)
    firstRevision = mentioned.thread.revision
    const bystanderMention = committed((await ledger.reply({ requestId: requestId('mention-bystander'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: `@${bystanderMember.handle} and this one`, baseRevision: firstRevision, actor: agentTeamHumanActor() })).value)
    firstRevision = bystanderMention.thread.revision
    const update = committed((await ledger.reply({ requestId: requestId('update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Ordinary update', baseRevision: firstRevision, actor: agentTeamHumanActor() })).value)
    firstRevision = update.thread.revision
    committed((await ledger.reply({ requestId: requestId('mention-other-thread'), workspaceId: alpha, taskRef: other.task.taskRef,
      body: `@${readerMember.handle} mention in the other Thread`, baseRevision: other.thread.revision, actor: agentTeamHumanActor() })).value)

    const first = await ledger.readThread({ requestId: requestId('read-first'), workspaceId: alpha, taskRef: started.task.taskRef, actor: reader })
    expect(first.committed).toBe(true)
    expect(first.value.remainingUnreadCount).toBe(0)
    expect(first.value.facts.filter(fact => fact.unread && fact.direct)).toHaveLength(1)

    // The other Thread still holds its own marker: reading the first Thread
    // consumed nothing outside the reader's own Attention row and markers.
    const second = await ledger.readThread({ requestId: requestId('read-second'), workspaceId: alpha, taskRef: other.task.taskRef, actor: reader })
    expect(second.committed).toBe(true)
    expect(second.value.remainingUnreadCount).toBe(0)
    expect(second.value.facts.filter(fact => fact.unread && fact.direct)).toHaveLength(1)
    expect((await ledger.readThread({ requestId: requestId('read-second-again'), workspaceId: alpha, taskRef: other.task.taskRef, actor: reader })).committed).toBe(false)

    // The bystander's marker in the first Thread is untouched by the reader's read.
    const bystanderView = await ledger.readThread({ requestId: requestId('read-bystander'), workspaceId: alpha, taskRef: started.task.taskRef, actor: bystander })
    expect(bystanderView.committed).toBe(true)
    expect(bystanderView.value.remainingUnreadCount).toBe(0)
    expect(bystanderView.value.facts.filter(fact => fact.unread && fact.direct)).toHaveLength(1)
    ledger.validate()
  })

  it('releases Claims on close and restores only the accountable follow on reopen', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await makeOwner(ledger, project.project.projectRef, actor.memberId)
    await ledger.transferTask({ requestId: requestId('assign-accountable'), workspaceId: alpha, taskRef: started.task.taskRef,
      target: actor.memberId, baseRevision: started.thread.revision, actor: agentTeamHumanActor() })
    const transferredRead = await ledger.readThread({ requestId: requestId('human-read-transfer'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })
    await ledger.readThread({ requestId: requestId('member-read-transfer'), workspaceId: alpha, taskRef: started.task.taskRef, actor })
    const claim = committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: transferredRead.value.thread.revision, actor })).value)
    await ledger.readThread({ requestId: requestId('human-read-claim'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })
    const humanRead = (await ledger.readThread({ requestId: requestId('human-read'), workspaceId: alpha, taskRef: started.task.taskRef,
      actor: agentTeamHumanActor() })).value
    const closed = committed((await ledger.changeTask({ requestId: requestId('close'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'close', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(closed).toMatchObject({ task: { resolution: 'closed', status: 'closed' }, claims: [expect.objectContaining({ claimRef: claim.claim.claimRef, state: 'released' })] })
    expect(ledger.attentionStatus(actor, { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toBeUndefined()
    expect(ledger.inbox(actor, { workspaceId: alpha })).toMatchObject({ totalUnreadCount: 2, items: [
      expect.objectContaining({ task: expect.objectContaining({ taskRef: started.task.taskRef }), unreadCount: 1 }),
    ] })
    const terminalRead = (await ledger.readThread({ requestId: requestId('terminal-read'), workspaceId: alpha,
      taskRef: started.task.taskRef, actor })).value
    expect(terminalRead.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ unread: true, fact: expect.objectContaining({ kind: 'activity', activity: expect.objectContaining({ kind: 'close' }) }) }),
    ]))
    expect(ledger.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(1)
    const reopened = committed((await ledger.changeTask({ requestId: requestId('reopen'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'reopen', baseRevision: closed.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(reopened.task).toMatchObject({ resolution: 'open', status: 'todo' })
    expect(reopened.activity.refollowedMembers).toEqual([actor.memberId])
    expect(ledger.attentionStatus(actor, { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toBeDefined()
    expect(ledgerAtBoot(test).attentionStatus(actor, { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toBeDefined()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const legacy = records.map(([key, value]) => {
      const operation = value as AgentTeamOperation
      if (operation.kind !== 'team/task-changed' || operation.data.activity.activityRef !== reopened.activity.activityRef) return [key, value] as [string, unknown]
      const { refollowedMembers: _stripped, ...activity } = operation.data.activity
      return [key, { ...operation, data: { ...operation.data, activity,
        inbox: { ...operation.data.inbox, attention: { set: [], removed: [] } } } }] as [string, unknown]
    })
    const revived = ledgerAtBoot(await harness(storedPool(legacy)))
    expect(revived.attentionStatus(actor, { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toBeUndefined()
    revived.validate()
    ledger.validate()
  })

  it('retains a later reopen update for Members that have not read the close', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('reopen-project'), workspaceId: alpha,
      name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('reopen-start'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await ledger.changeAttention({ requestId: requestId('reopen-follow'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'follow', actor })
    const humanRead = (await ledger.readThread({ requestId: requestId('reopen-human-read'), workspaceId: alpha,
      taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    const closed = committed((await ledger.changeTask({ requestId: requestId('reopen-close'), workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'close', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    committed((await ledger.changeTask({ requestId: requestId('reopen-again'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'reopen', baseRevision: closed.thread.revision, actor: agentTeamHumanActor() })).value)

    expect(ledger.inbox(actor, { workspaceId: alpha })).toMatchObject({ totalUnreadCount: 2, items: [
      expect.objectContaining({ task: expect.objectContaining({ resolution: 'open' }), unreadCount: 2 }),
    ] })
    const read = (await ledger.readThread({ requestId: requestId('reopen-member-read'), workspaceId: alpha,
      taskRef: started.task.taskRef, actor })).value
    expect(read.facts.filter(fact => fact.unread).map(fact => fact.fact.kind === 'activity' ? fact.fact.activity.kind : 'message'))
      .toEqual(['close', 'reopen'])
    expect(ledger.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(0)
  })

  // Removal from a single Project is retired (membership is derived from
  // participation now), so the live side of this cleanup is the whole-Team
  // removal; the Project case survives as the frozen-history replay above.
  it('replays terminal Activity marker cleanup after Team removal', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('cleanup-team-project'), workspaceId: alpha,
      name: 'cleanup-team', description: 'Cleanup replay' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('cleanup-team-start'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, project.project.projectRef)
    await ledger.changeAttention({ requestId: requestId('cleanup-team-follow'), workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'follow', actor })
    const humanRead = (await ledger.readThread({ requestId: requestId('cleanup-team-human-read'), workspaceId: alpha,
      taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    committed((await ledger.changeTask({ requestId: requestId('cleanup-team-close'), workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'close', baseRevision: humanRead.thread.revision, actor: agentTeamHumanActor() })).value)
    expect(ledger.inbox(actor, { workspaceId: alpha }).totalUnreadCount).toBe(1)

    await ledger.removeMember({ requestId: requestId('cleanup-team-remove'),
      memberId: member.memberId, actor: agentTeamHumanActor() })
    ledger.validate()
    const records = [...test.facility.get('agent_team')!.table('operations').entries()] as Array<[string, unknown]>
    const replayed = await harness(storedPool(records))
    expect(() => ledgerAtBoot(replayed).validate()).not.toThrow()
  })

  it('replays a historical Project member-removal that cleaned a taskless Thread', async () => {
    // Membership is derived now and nothing writes a removal any more, so this
    // history is loaded rather than committed: the cleanup it carries is what
    // old ledgers still depend on.
    const ledger = ledgerAtBoot(await harness(storedPool(legacyRemovalLedger.records)))
    const operation = ledger.getOperation(legacyRemovalLedger.operationId as never)!
    expect(operation.kind === 'team/project-member-removed' ? operation.data.inbox.attention.removed : [])
      .toEqual(expect.arrayContaining([{ memberId: legacyRemovalLedger.memberId, threadRef: legacyRemovalLedger.threadRef }]))
    ledger.validate()
  })

  it('repairs a legacy Project member-removal record that omitted taskless-Thread cleanup on load', async () => {
    // The removal is historical, so the ledger is loaded from the frozen
    // history and then rewritten into the 0.1.7-0.1.9 shape: cleanup scoped to
    // taskful Threads only.
    const records = legacyRemovalLedger.records.map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/project-member-removed') return [id, typed] as [string, unknown]
      const dropTaskless = (entries: readonly { threadRef: string }[]) => entries.filter(entry => entry.threadRef !== legacyRemovalLedger.threadRef)
      return [id, { ...typed, data: { ...typed.data, inbox: {
        attention: { set: [], removed: dropTaskless(typed.data.inbox.attention.removed) },
        directMarkers: { added: [], removed: dropTaskless(typed.data.inbox.directMarkers.removed) },
        activityMarkers: { added: [], removed: dropTaskless(typed.data.inbox.activityMarkers.removed) },
      } } }] as [string, unknown]
    })
    const legacyLedger = ledgerAtBoot(await harness(storedPool(records)))
    expect(() => legacyLedger.validate()).not.toThrow()
    const repaired = legacyLedger.getOperation(legacyRemovalLedger.operationId as never)!
    expect(repaired.kind === 'team/project-member-removed' ? repaired.data.inbox.attention.removed : [])
      .toEqual(expect.arrayContaining([{ memberId: legacyRemovalLedger.memberId, threadRef: legacyRemovalLedger.threadRef }]))
  })

  it('rejects a structurally valid Thread read receipt with a forged watermark during replay', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'Task' })))
    const updated = committed(await test.ctx.agentTeam.reply({ requestId: requestId('update'), workspaceId: alpha,
      taskRef: started.task.taskRef, body: 'Unread update', baseRevision: started.thread.revision }))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await ledger.reply({ requestId: requestId('agent-update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Unread agent update', baseRevision: updated.thread.revision, actor })
    // The Human has an unseen reply, so this read advances the watermark and
    // commits the record the replay below must reject once it is forged.
    await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-read' || isThreadReadSnapshot(typed.data)) return [id, typed] as [string, unknown]
      // Watermark and the Attention row that carries it are forged together, so
      // no consistency check inside the record can catch this: only the
      // independent derivation from the record's own prior projection can.
      const forgedWatermark = updated.thread.revision + 100
      const attention = { ...typed.data.inbox.attention.set[0]!, readThroughSequence: forgedWatermark }
      return [id, { ...typed, data: { ...typed.data, readThroughSequence: forgedWatermark,
        inbox: { ...typed.data.inbox, attention: { ...typed.data.inbox.attention, set: [attention] } } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid Thread read receipt/)
  })

  it('rejects a pre-receipt Thread read snapshot with a forged watermark during replay', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha,
      projectRef: project.project.projectRef, body: 'Task' })))
    const updated = committed(await test.ctx.agentTeam.reply({ requestId: requestId('update'), workspaceId: alpha,
      taskRef: started.task.taskRef, body: 'Unread update', baseRevision: started.thread.revision }))
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await ledger.reply({ requestId: requestId('agent-update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Unread agent update', baseRevision: updated.thread.revision, actor })
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-read' || isThreadReadSnapshot(typed.data)) return [id, typed] as [string, unknown]
      // The legacy form still loads and still gets the full derivation, so the
      // same forgery must be caught there — a snapshot is not a trusted record
      // just because it is old.
      const data = fabricateLegacyThreadReadSnapshot(typed.data, read)
      const forgedWatermark = updated.thread.revision + 100
      return [id, { ...typed, data: { ...data, readThroughSequence: forgedWatermark,
        attention: { ...data.attention!, readThroughSequence: forgedWatermark },
        inbox: { ...data.inbox, attention: { ...data.inbox.attention, set: [{ ...data.attention!, readThroughSequence: forgedWatermark }] } } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid Thread read projection/)
  })

  it('rejects forged member cleanup snapshots during replay', async () => {
    // A historical removal carries the cleanup snapshot; forging a released
    // Task into it must still fail the replay, since old ledgers are validated
    // on load.
    const forgedTask = Object.freeze({ taskRef: 'task:forged' as never, projectRef: legacyRemovalLedger.projectRef as never,
      threadRef: legacyRemovalLedger.threadRef as never, status: 'todo' as const, resolution: 'open' as const })
    const records = legacyRemovalLedger.records.map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/project-member-removed') return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, tasks: [forgedTask] } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid released Claim Task or Thread projection/)
  })

  it('rejects a forged direct marker that does not match its Message during replay', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor, member } = await addLedgerMember(ledger, project.project.projectRef)
    const followed = threadAttentionOf(await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor }))
    committed((await ledger.reply({ requestId: requestId('mention'), workspaceId: alpha, taskRef: started.task.taskRef, body: `@${member.handle} check this`, baseRevision: followed.thread.revision, actor: agentTeamHumanActor() })).value)
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-replied') return [id, typed] as [string, unknown]
      const marker = typed.data.inbox.directMarkers.added[0]!
      return [id, { ...typed, data: { ...typed.data, inbox: { ...typed.data.inbox, directMarkers: {
        ...typed.data.inbox.directMarkers, added: [{ ...marker, sequence: marker.sequence + 1 }],
      } } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid direct marker addition/)
  })

  it('rejects a direct marker that resolves only against a later record during replay', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    const { actor, member } = await addLedgerMember(ledger, project.project.projectRef)
    const followed = threadAttentionOf(await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor }))
    const mentioned = committed((await ledger.reply({ requestId: requestId('mention'), workspaceId: alpha, taskRef: started.task.taskRef, body: `@${member.handle} check this`, baseRevision: followed.thread.revision, actor: agentTeamHumanActor() })).value)
    const later = committed((await ledger.reply({ requestId: requestId('later'), workspaceId: alpha, taskRef: started.task.taskRef, body: 'Later update', baseRevision: mentioned.thread.revision, actor: agentTeamHumanActor() })).value)
    // The marker is rewritten to a Message that is real, in the same Thread, with
    // the sequence it carries — everything a linear scan of the ledger's whole
    // Message set would accept. Only resolution against the state replayed up to
    // this record rejects it, which is what the marker lookup must stay bound to.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-replied') return [id, typed] as [string, unknown]
      const marker = typed.data.inbox.directMarkers.added[0]
      if (marker === undefined) return [id, typed] as [string, unknown]
      return [id, { ...typed, data: { ...typed.data, inbox: { ...typed.data.inbox, directMarkers: {
        ...typed.data.inbox.directMarkers, added: [{ ...marker, messageRef: later.message.messageRef, sequence: later.message.sequence }],
      } } } }] as [string, unknown]
    })
    await expect(harness(storedPool(records))).rejects.toThrow(/invalid direct marker addition/)
  })

  // The only case that boots two SQLite-backed Hosts over one file, so it pays
  // cold start, a full replay and a validate twice. Windows runners vary from
  // 465ms to over 5s on identical code, so it needs headroom over the default.
  it('replays an Agent Attention read watermark from SQLite across a Host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-sqlite-'))
    const path = join(root, 'team.sqlite')
    const harnesses: Array<Awaited<ReturnType<typeof sqliteHarness>>> = []
    cleanups.push(async () => {
      for (const test of harnesses) {
        await test.fiber.dispose()
        await test.facility.closeAll()
        await test.backend.close()
      }
      await rm(root, { recursive: true, force: true })
    })
    const first = await sqliteHarness(path)
    harnesses.push(first)
    const project = await first.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await first.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Persistent task' })))
    const ledger = ledgerAtBoot(first)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef: started.task.taskRef, action: 'follow', actor })
    const update = committed((await ledger.reply({ requestId: requestId('update'), workspaceId: alpha, taskRef: started.task.taskRef,
      body: 'Persistent update', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).value)
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    expect(read.readThroughSequence).toBe(update.thread.revision)
    await first.fiber.dispose(); await first.facility.closeAll(); await first.backend.close()
    const second = await sqliteHarness(path)
    harnesses.push(second)
    const replay = ledgerAtBoot(second)
    expect(replay.inbox(actor, { workspaceId: alpha })).toEqual({ humanMemberId: AGENT_TEAM_HUMAN_MEMBER_ID, items: [], main: [], recent: [], hasMore: false, totalUnreadCount: 0, totalDirectCount: 0 })
    expect(second.ctx.agentTeam.view({ workspaceId: alpha, threadRef: started.thread.threadRef }).items.map(item => item.message.body)).toEqual(['Persistent task', 'Persistent update'])
    expect(replay.attentionStatus(actor, { workspaceId: alpha, taskRef: started.task.taskRef }).attention).toMatchObject({ readThroughSequence: update.thread.revision })
    replay.validate()
    second.ctx.agentTeam.validateLedger()
  }, 30_000)

  it('normalizes bare pre-occurredAt messages with the wrapping operation instant during replay', async () => {
    const test = await harness(storedPool([...rulesV1Ledger.records]))
    const started = { task: { taskRef: rulesV1Ledger.task.taskRef as AgentTeamTaskRef }, thread: { threadRef: rulesV1Ledger.task.threadRef as AgentTeamThreadRef } }
    const ledger = ledgerAtBoot(test)
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind === 'team/message-sent') {
        const { occurredAt: _dropped, ...message } = typed.data.message
        return [id, { ...typed, data: { ...typed.data, message } }] as [string, unknown]
      }
      if (typed.kind === 'team/thread-read' && !isThreadReadSnapshot(typed.data)) {
        // Rewrite the committed receipt as the snapshot a pre-B2 ledger holds,
        // then strip every message instant only the load path can restore.
        const data = fabricateLegacyThreadReadSnapshot(typed.data, read)
        const { occurredAt: _anchorDropped, ...anchor } = data.anchor
        const facts = data.facts.map(fact => fact.fact.kind === 'message'
          ? (() => {
            const { occurredAt: _factDropped, ...message } = fact.fact.message
            return { ...fact, fact: { kind: 'message' as const, sequence: fact.fact.sequence, message, mentions: fact.fact.mentions } }
          })()
          : fact)
        return [id, { ...typed, data: { ...data, anchor, facts } }] as [string, unknown]
      }
      return [id, typed] as [string, unknown]
    })
    const storedMessage = records.map(([, operation]) => operation as AgentTeamOperation)
      .find(operation => operation.kind === 'team/message-sent')!
    const revived = await harness(storedPool(records))
    const view = revived.ctx.agentTeam.view({ workspaceId: alpha, threadRef: started.thread.threadRef })
    expect(view.items.map(item => item.message.body)).toEqual(['Investigate the regression', '@carol, please look', '@dave, over to you'])
    expect(view.items[0]!.message.occurredAt).toBe(storedMessage.occurredAt)
    expect(() => ledgerAtBoot(revived).validate()).not.toThrow()
  })

  it('normalizes bare pre-occurredAt Activity facts with their committing operation instant during replay', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Legacy task' })))
    const ledger = ledgerAtBoot(test)
    const { member, actor } = await addLedgerMember(ledger, project.project.projectRef)
    const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    const memberReadId = requestId('member-read-claim')
    const humanReadId = requestId('human-read-claim')
    const memberRead = (await ledger.readThread({ requestId: memberReadId, workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    const humanRead = (await ledger.readThread({ requestId: humanReadId, workspaceId: alpha, taskRef: started.task.taskRef, actor: agentTeamHumanActor() })).value
    // Each read answers with the picture of its own moment, so a stored snapshot
    // can only be rebuilt from the picture of the read that wrote it.
    const pictures = new Map<AgentTeamRequestId, Omit<AgentTeamThreadReadResult, 'receipt'>>([
      [memberReadId, memberRead],
      [humanReadId, humanRead],
    ])
    const accepted = committed((await ledger.changeTask({ requestId: requestId('accept'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'accept', baseRevision: claimed.thread.revision, actor: agentTeamHumanActor() })).value)
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind === 'team/thread-read' && !isThreadReadSnapshot(typed.data)) {
        // Rewrite the committed receipt as the snapshot a pre-B2 ledger holds,
        // then strip every fact instant only the load path can restore.
        const data = fabricateLegacyThreadReadSnapshot(typed.data, pictures.get(typed.requestId)!)
        const facts = data.facts.map(fact => {
          if (fact.fact.kind === 'message') {
            const { occurredAt: _factDropped, ...message } = fact.fact.message
            return { ...fact, fact: { kind: 'message' as const, sequence: fact.fact.sequence, message, mentions: fact.fact.mentions } }
          }
          const { occurredAt: _envelopeDropped, ...activityFact } = fact.fact
          return { ...fact, fact: { kind: 'activity' as const, sequence: activityFact.sequence, activity: activityFact.activity } }
        })
        return [id, { ...typed, data: { ...data, facts } }] as [string, unknown]
      }
      return [id, typed] as [string, unknown]
    })
    const revived = await harness(storedPool(records))
    const replayed = ledgerAtBoot(revived)
    expect(() => replayed.validate()).not.toThrow()
    const read = (await replayed.readThread({ requestId: requestId('revived-read'), workspaceId: alpha, taskRef: started.task.taskRef, actor })).value
    expect(read.facts.filter(fact => fact.unread).map(fact => fact.fact.kind === 'activity' ? fact.fact.activity.kind : 'message')).toEqual(['accept'])
    expect(read.facts.find(fact => fact.fact.kind === 'activity' && fact.unread)!.fact.occurredAt).toBe(accepted.receipt.occurredAt)
    expect(read.attention).toMatchObject({ memberId: member.memberId, readThroughSequence: read.readThroughSequence })
  })

  it('fails loud on malformed durable records and an invariant catches projection divergence', async () => {
    await expect(harness(storedPool([['operation:bad', { sequence: 'one' }]]))).rejects.toThrow(/does not match its schema/)
    const test = await harness()
    await test.ctx.plugin(agentTeamInvariant)
    const domain = test.facility.get('agent_team')!
    const table = domain.table('operations')
    const [id, operation] = [...table.entries()][0]!
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 2 })
    const receipt = { operationId: id as AgentTeamOperationId, requestId: AGENT_TEAM_INITIALIZE_REQUEST_ID, sequence: 2, occurredAt: (operation as AgentTeamOperation).occurredAt }
    // The commit path records and schedules; the replay runs after the I/O
    // turn, so the divergence surfaces as the latched failure the next commit
    // raises on a caller-owned frame.
    const logError = vi.spyOn(test.ctx.logger, 'error').mockImplementation(() => {})
    test.ctx.emit('agent-team/committed', { receipt })
    await new Promise(resolve => setImmediate(resolve))
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('diverged'))
    expect(() => test.ctx.emit('agent-team/committed', { receipt })).toThrow(/invariant violated/)
    logError.mockRestore()
  })

  it('fails the companion load when the mount replay finds a diverged ledger', async () => {
    const test = await harness()
    const table = test.facility.get('agent_team')!.table('operations')
    const [id, operation] = [...table.entries()][0]!
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 9 })
    // Mounting is the boot gate: a ledger the projection cannot re-derive must
    // reject the companion's own plugin load, not arm a later check.
    await expect(test.ctx.plugin(agentTeamInvariant)).rejects.toThrow(/invariant violated/)
  })

  it('keeps the commit-path replay off the commit call and coalesces a burst', async () => {
    const test = await harness()
    await test.ctx.plugin(agentTeamInvariant)
    const validate = vi.spyOn(test.ctx.agentTeam, 'validateLedger')
    validate.mockClear()
    const [id, operation] = [...test.facility.get('agent_team')!.table('operations').entries()][0]!
    const receipt = { operationId: id as AgentTeamOperationId, requestId: AGENT_TEAM_INITIALIZE_REQUEST_ID, sequence: 1, occurredAt: (operation as AgentTeamOperation).occurredAt }
    test.ctx.emit('agent-team/committed', { receipt })
    test.ctx.emit('agent-team/committed', { receipt })
    expect(validate).not.toHaveBeenCalled()
    await new Promise(resolve => setImmediate(resolve))
    expect(validate).toHaveBeenCalledTimes(1)
    validate.mockRestore()
  })

  it('adopts the boot record-level replay at the invariant mount', async () => {
    // An existing profile boots by replaying its records; initialize() commits
    // only on a fresh one, so seed the storage to reach the case that matters.
    const seeded = await harness()
    const project = await seeded.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    await seeded.ctx.agentTeam.startThread({ kind: 'discussion', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })
    const records = [...seeded.facility.get('agent_team')!.table('operations').entries()]
    const test = await harness(storedPool(records as Array<[string, unknown]>))
    const entries = vi.spyOn(test.facility.get('agent_team')!.table('operations'), 'entries')
    await test.ctx.plugin(agentTeamInvariant)
    // The constructor already re-derived every durable record against its own
    // scratch projection; the mount must not read and re-derive it again.
    expect(entries).not.toHaveBeenCalled()
    entries.mockRestore()
  })

  it('replays the durable records at the mount once a commit landed after boot', async () => {
    const seeded = await harness()
    const records = [...seeded.facility.get('agent_team')!.table('operations').entries()]
    const test = await harness(storedPool(records as Array<[string, unknown]>))
    await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const entries = vi.spyOn(test.facility.get('agent_team')!.table('operations'), 'entries')
    await test.ctx.plugin(agentTeamInvariant)
    // A commit invalidates the boot conclusion, so the mount reads the table again.
    expect(entries).toHaveBeenCalledTimes(1)
    entries.mockRestore()
  })

  it('fails closed at the mount when a commit excludes adoption and the records are invalid', async () => {
    const test = await harness()
    await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const table = test.facility.get('agent_team')!.table('operations')
    const [id, operation] = [...table.entries()].at(-1)!
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 9 })
    expect(() => test.ctx.agentTeam.validateLedgerAtMount()).toThrow(/expected sequence 3, found 9/)
  })

  it('keeps the mount adoption one-shot and every later validation a full replay', async () => {
    const seeded = await harness()
    const records = [...seeded.facility.get('agent_team')!.table('operations').entries()]
    const test = await harness(storedPool(records as Array<[string, unknown]>))
    await test.ctx.plugin(agentTeamInvariant)
    const table = test.facility.get('agent_team')!.table('operations')
    const [id, operation] = [...table.entries()][0]!
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 2 })
    const entries = vi.spyOn(table, 'entries')
    // The adopted conclusion is spent: the next mount check has no boot replay
    // left to reuse, so it replays the durable records and reports the
    // divergence it finds there.
    expect(() => test.ctx.agentTeam.validateLedgerAtMount()).toThrow(/expected sequence 1, found 2/)
    expect(entries).toHaveBeenCalledTimes(1)
    entries.mockRestore()
  })

  it('releases the deferred failure once a replay comes back clean', async () => {
    const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
    const test = await harness()
    await test.ctx.plugin(agentTeamInvariant)
    const table = test.facility.get('agent_team')!.table('operations')
    const [id, operation] = [...table.entries()][0]!
    const receipt = { operationId: id as AgentTeamOperationId, requestId: AGENT_TEAM_INITIALIZE_REQUEST_ID, sequence: 2, occurredAt: (operation as AgentTeamOperation).occurredAt }
    await table.put(id, { ...(operation as AgentTeamOperation), sequence: 2 })
    test.ctx.emit('agent-team/committed', { receipt })
    await settle()
    expect(() => test.ctx.emit('agent-team/committed', { receipt })).toThrow(/invariant violated/)
    await table.put(id, operation)
    // Whatever the commit above did, the next replay reads the repaired ledger.
    try { test.ctx.emit('agent-team/committed', { receipt }) } catch { /* still latched */ }
    await settle()
    expect(() => test.ctx.emit('agent-team/committed', { receipt })).not.toThrow()
  })

  it('rejects cross-Workspace refs and preserves durability before projection mutation', async () => {
    const pool = new MemoryMediaPool()
    const test = await harness(pool, [alpha, beta])
    pool.injectedWriteFailuresRemaining = 1
    await expect(test.ctx.agentTeam.createProject({ requestId: requestId('failed'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })).rejects.toThrow(/injected write failure/)
    expect(test.ctx.agentTeam.status()).toMatchObject({ projectCount: 0, sequence: 2 })
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    expect(() => test.ctx.agentTeam.view({ workspaceId: beta, projectRef: project.project.projectRef })).toThrow(/does not belong to Workspace/)
  })

  it('explains a missing branded prefix when a Task ref lookup fails', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const bare = started.task.taskRef.replace(/^task:/, '') as AgentTeamTaskRef
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: bare })).rejects.toThrow(/unknown Task ref '.+' A Task ref must start with 'task:'/)
    expect(() => test.ctx.agentTeam.threadHistory({ workspaceId: alpha, taskRef: bare })).toThrow(/must start with 'task:'/)
    expect(() => test.ctx.agentTeam.view({ workspaceId: alpha, projectRef: 'engineering' as never })).toThrow(/unknown Project ref 'engineering' A Project ref must start with 'project:'/)
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha,
      taskRef: started.task.taskRef, action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await expect(ledger.changeClaim({ requestId: requestId('done'), workspaceId: alpha, taskRef: started.task.taskRef,
      action: 'done', baseRevision: claimed.thread.revision, claimRef: 'abc' as never, actor })).rejects.toThrow(/unknown Claim ref 'abc' A Claim ref must start with 'claim:'/)
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: started.task.taskRef })).resolves.toBeDefined()
  })

  it('resolves unambiguous UUID-prefix refs across ledger entry points', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const taskRef = started.task.taskRef
    const threadRef = started.thread.threadRef
    // Plain 6-hex prefix, a hyphenated truncated form, and the full ref all resolve.
    const taskPrefix = `${taskRef.slice(0, 'task:'.length + 6)}` as never
    const hyphenated = `${taskRef.slice(0, taskRef.indexOf('-') + 7)}` as never
    const threadPrefix = `${threadRef.slice(0, threadRef.indexOf('-') + 7)}` as never
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-prefix'), workspaceId: alpha, taskRef: taskPrefix })).resolves.toBeDefined()
    expect(() => test.ctx.agentTeam.threadHistory({ workspaceId: alpha, taskRef: taskPrefix })).not.toThrow()
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-hyphen'), workspaceId: alpha, taskRef: hyphenated })).resolves.toBeDefined()
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-thread'), workspaceId: alpha, threadRef: threadPrefix })).resolves.toBeDefined()
    const ledger = ledgerAtBoot(test)
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    const claimed = committed((await ledger.changeClaim({ requestId: requestId('claim-prefix'), workspaceId: alpha,
      taskRef: taskPrefix, action: 'claim', direction: 'review', baseRevision: started.thread.revision, actor })).value)
    await expect(ledger.changeClaim({ requestId: requestId('done-prefix'), workspaceId: alpha, taskRef: taskPrefix,
      action: 'done', baseRevision: claimed.thread.revision, claimRef: `${claimed.claim.claimRef.slice(0, 'claim:'.length + 10)}` as never, actor })).resolves.toBeDefined()
  })

  it('rejects refs that are too short, unknown, or from another Workspace', async () => {
    const test = await harness(undefined, [alpha, beta])
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const taskRef = started.task.taskRef
    const shortPrefix = `${taskRef.slice(0, 'task:'.length + 5)}` as never
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-short'), workspaceId: alpha, taskRef: shortPrefix }))
      .rejects.toThrow(/unknown Task ref '.+' A Task ref needs at least 6 hex characters/)
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-miss'), workspaceId: alpha, taskRef: 'task:deadbe' as never }))
      .rejects.toThrow(/No Task matches this UUID prefix/)
    await expect(test.ctx.agentTeam.readThread({ requestId: requestId('read-beta'), workspaceId: beta, taskRef: `${taskRef.slice(0, 'task:'.length + 6)}` as never }))
      .rejects.toThrow(/does not belong to Workspace/)
  })

  it('reports ambiguous abbreviated refs with candidate full refs', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    let refs = 0
    const ledger = new AgentTeamLedger(test.facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>, {
      ref: kind => `${kind}:aaaaaa${String(refs++).padStart(2, '0')}-0000-0000-0000-000000000000` as never,
    })
    const { actor } = await addLedgerMember(ledger, project.project.projectRef)
    await makeOwner(ledger, project.project.projectRef, actor.memberId)
    await ledger.startThread({ requestId: requestId('first'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'First', kind: 'task', actor })
    await ledger.startThread({ requestId: requestId('second'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Second', kind: 'task', actor })
    await expect(ledger.readThread({ requestId: requestId('amb'), workspaceId: alpha, taskRef: 'task:aaaaaa' as never, actor }))
      .rejects.toThrow(/ambiguous Task ref 'task:aaaaaa' matches 'task:aaaaaa\d\d-0000-0000-0000-000000000000', 'task:aaaaaa\d\d-0000-0000-0000-000000000000'/)
    await expect(ledger.readThread({ requestId: requestId('amb-thread'), workspaceId: alpha, threadRef: 'thread:aaaaaa' as never, actor }))
      .rejects.toThrow(/ambiguous Thread ref 'thread:aaaaaa' matches/)
  })

  it('keeps archived Project Task and Thread refs unreachable under abbreviation', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Task' })))
    const ledger = ledgerAtBoot(test)
    await ledger.archiveProject({ requestId: requestId('ch-arch'), workspaceId: alpha, projectRef: project.project.projectRef, actor: agentTeamHumanActor() })
    const taskPrefix = `${started.task.taskRef.slice(0, 'task:'.length + 6)}` as never
    const threadPrefix = `${started.thread.threadRef.slice(0, 'thread:'.length + 6)}` as never
    await expect(ledger.readThread({ requestId: requestId('read-task'), workspaceId: alpha, taskRef: taskPrefix, actor: agentTeamHumanActor() })).rejects.toThrow(/archived/)
    await expect(ledger.readThread({ requestId: requestId('read-thread'), workspaceId: alpha, threadRef: threadPrefix, actor: agentTeamHumanActor() })).rejects.toThrow(/archived/)
    expect(ledger.resolveTaskRefs(alpha, [taskPrefix])).toEqual([])
  })

  it('creates a taskless Thread, keeps Inbox visible, and promotes with a Task activity', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
    const ledger = ledgerAtBoot(test)
    const { actor, member } = await addLedgerMember(ledger, project.project.projectRef)
    const sent = committed((await ledger.startThread({
      requestId: requestId('chat'), workspaceId: alpha, projectRef: project.project.projectRef,
      body: `plain conversation for @${member.handle}`, kind: 'discussion', actor: agentTeamHumanActor(),
    })).value)
    expect(sent.task).toBeUndefined()
    expect(sent.thread.taskRef).toBeUndefined()
    expect(sent.message.taskRef).toBeUndefined()
    expect(sent.message.topLevel).toBe(true)
    const inbox = ledger.inbox(actor, { workspaceId: alpha })
    expect(inbox.totalDirectCount).toBe(1)
    expect(inbox.items[0]!.task).toBeUndefined()
    expect(inbox.items[0]!.thread.threadRef).toBe(sent.thread.threadRef)
    // A mention delivers but does not follow, and only followers are notified of the promotion below.
    await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, threadRef: sent.thread.threadRef, action: 'follow', actor })
    await expect(ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef: 'task:missing' as AgentTeamTaskRef,
      action: 'claim', direction: 'work', baseRevision: sent.thread.revision, actor })).rejects.toThrow(/unknown Task/)
    const later = withTask(committed((await ledger.startThread({ kind: 'task', requestId: requestId('later-task'),
      workspaceId: alpha, projectRef: project.project.projectRef, body: 'later Task', actor: agentTeamHumanActor() })).value))
    const promoted = committed((await ledger.promoteThread({
      requestId: requestId('promote'), workspaceId: alpha, threadRef: sent.thread.threadRef,
      baseRevision: sent.thread.revision, actor: agentTeamHumanActor(),
    })).value)
    expect(promoted.task.status).toBe('todo')
    expect(promoted.thread.taskRef).toBe(promoted.task.taskRef)
    expect(promoted.activity).toMatchObject({ kind: 'promote', taskRef: promoted.task.taskRef, threadRef: sent.thread.threadRef, actor: AGENT_TEAM_HUMAN_MEMBER_ID })
    const after = ledger.inbox(actor, { workspaceId: alpha })
    expect(after.items[0]!.task?.taskRef).toBe(promoted.task.taskRef)
    const notificationFacts = ledger.notificationFacts(actor.memberId, { workspaceId: alpha })
    const promotedNotification = notificationFacts.find(entry => entry.item.thread.threadRef === sent.thread.threadRef)
    expect(promotedNotification?.facts.some(entry => entry.fact.kind === 'activity' && entry.fact.activity.kind === 'promote')).toBe(true)
    const history = ledger.threadHistory(actor, { workspaceId: alpha, threadRef: sent.thread.threadRef })
    expect(history.anchor.messageRef).toBe(sent.message.messageRef)
    expect(history.facts.map(fact => fact.kind === 'message' ? fact.message.body : fact.activity.kind)).toEqual([
      `plain conversation for @${member.handle}`, 'promote',
    ])
    const view = ledger.view({ workspaceId: alpha, projectRef: project.project.projectRef, topLevelOnly: true, includeActivities: false })
    const promotedItem = view.items.find(item => item.thread.threadRef === sent.thread.threadRef)
    expect(promotedItem?.message.taskRef).toBeUndefined()
    expect(promotedItem?.task?.taskRef).toBe(promoted.task.taskRef)
    expect(promotedItem?.taskNumber).toBe(2)
    expect(view.taskNumbers).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskRef: later.task.taskRef, taskNumber: 1 }),
      expect.objectContaining({ taskRef: promoted.task.taskRef, taskNumber: 2 }),
    ]))
    expect(ledger.affectedMembersOf(ledgerAtBoot(test).getOperation(promoted.receipt.operationId)!)).toEqual(expect.arrayContaining([actor.memberId]))
    expect(() => ledgerAtBoot(test).validate()).not.toThrow()
  })
})

/** One stored operations table over a seeded memory pool, opened the way a Host restart opens it. */
async function openLegacy(records: Array<[string, unknown]>): Promise<KvTable<AgentTeamOperationId, AgentTeamOperation>> {
  const pool = new MemoryMediaPool()
  pool.versions.set('agent_team', agentTeamDomainSpec.version)
  pool.media.set('agent_team', { tables: new Map([['operations', new Map(records)]]), global: null })
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  return await (await ctx.storageDomain.open(agentTeamDomainSpec)).table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
}

describe('what established an Attention period', () => {
  /** The source the ledger now holds for one Member's row on one Thread. */
  const sourceOn = (ledger: AgentTeamLedger, actor: AgentTeamMemberActor, threadRef: AgentTeamThreadRef) =>
    ledger.attentionStatus(actor, { workspaceId: alpha, threadRef }).attention?.source

  it('names the Thread author, the Claim owner, and the Member own choice', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('source-project'), workspaceId: alpha, name: 'engineering', description: '' })
    const ledger = ledgerAtBoot(test)
    const { actor: author, member: authorMember } = await addLedgerMember(ledger, project.project.projectRef, 'member:author', 'Writes', 'author')
    const { actor: claimer } = await addLedgerMember(ledger, project.project.projectRef, 'member:claimer', 'Claims', 'claimer')
    const { actor: chooser } = await addLedgerMember(ledger, project.project.projectRef, 'member:chooser', 'Chooses', 'chooser')
    await makeOwner(ledger, project.project.projectRef, authorMember.memberId)

    // Starting a Thread follows its author.
    const discussion = committed((await ledger.startThread({ requestId: requestId('source-discussion'), actor: author, workspaceId: alpha,
      projectRef: project.project.projectRef, kind: 'discussion', body: 'A question' })).value)
    expect(sourceOn(ledger, author, discussion.thread.threadRef)).toBe('thread-author')

    // Claiming a Task follows the executor.
    const task = withTask(committed((await ledger.startThread({ requestId: requestId('source-task'), actor: author, workspaceId: alpha,
      projectRef: project.project.projectRef, kind: 'task', body: 'Investigate' })).value))
    committed((await ledger.changeClaim({ requestId: requestId('source-claim'), workspaceId: alpha, taskRef: task.task.taskRef,
      baseRevision: task.thread.revision, action: 'claim', direction: 'Implement', actor: claimer })).value)
    expect(sourceOn(ledger, claimer, task.thread.threadRef)).toBe('claim')

    // An explicit follow is the Member's own choice, which is the one source
    // that claims no cause: nothing established it but the request itself.
    const followed = (await ledger.changeAttention({ requestId: requestId('source-follow'), workspaceId: alpha,
      threadRef: discussion.thread.threadRef, action: 'follow', actor: chooser })).value
    expect(followed.attention?.source).toBe('self')
    expect(sourceOn(ledger, chooser, discussion.thread.threadRef)).toBe('self')
    expect(() => ledgerAtBoot(test).validate()).not.toThrow()
  })

  it('names the accountable a transfer and a reopen establish', async () => {
    const test = await harness()
    const project = await test.ctx.agentTeam.createProject({ requestId: requestId('transfer-project'), workspaceId: alpha, name: 'engineering', description: '' })
    const ledger = ledgerAtBoot(test)
    const { actor: owner } = await addLedgerMember(ledger, project.project.projectRef, 'member:owner', 'Owns', 'owner')
    const { actor: target } = await addLedgerMember(ledger, project.project.projectRef, 'member:target', 'Receives', 'target')
    await makeOwner(ledger, project.project.projectRef, owner.memberId)
    // The Human starts the Task, so it is accountable to the Human and the
    // transfer moves accountability onto the Agent owner.
    const task = withTask(committed((await ledger.startThread({ requestId: requestId('transfer-task'), actor: agentTeamHumanActor(), workspaceId: alpha,
      projectRef: project.project.projectRef, kind: 'task', body: 'Investigate' })).value))
    const transferred = committed((await ledger.transferTask({ requestId: requestId('transfer-do'), workspaceId: alpha, taskRef: task.task.taskRef,
      baseRevision: task.thread.revision, target: owner.memberId, actor: agentTeamHumanActor() })).value)
    expect(transferred.task.accountable).toBe(owner.memberId)
    // A transfer follows its new accountable, and a reopen re-establishes that
    // same Attention rather than inventing a sixth kind of cause.
    expect(sourceOn(ledger, owner, task.thread.threadRef)).toBe('accountable')
    // Close it first, so the reopen is legal: it re-establishes the
    // accountable's Attention without inventing a sixth kind of cause.
    const closeRead = (await ledger.readThread({ requestId: requestId('transfer-read'), workspaceId: alpha, taskRef: task.task.taskRef,
      actor: agentTeamHumanActor() })).value
    committed((await ledger.changeTask({ requestId: requestId('transfer-close'), workspaceId: alpha, taskRef: task.task.taskRef,
      baseRevision: closeRead.thread.revision, action: 'close', actor: agentTeamHumanActor() })).value)
    const reopenRead = (await ledger.readThread({ requestId: requestId('transfer-read-2'), workspaceId: alpha, taskRef: task.task.taskRef,
      actor: agentTeamHumanActor() })).value
    committed((await ledger.changeTask({ requestId: requestId('transfer-reopen'), workspaceId: alpha, taskRef: task.task.taskRef,
      baseRevision: reopenRead.thread.revision, action: 'reopen', actor: agentTeamHumanActor() })).value)
    expect(sourceOn(ledger, owner, task.thread.threadRef)).toBe('accountable')
    expect(() => ledgerAtBoot(test).validate()).not.toThrow()
  })

  it('reads a row written before the source existed as the cause that segment had', async () => {
    // A rules-version-1 ledger establishes Attention through the mention rule,
    // and its rows carry no source. They replay as written, and read back as the
    // rule that established them rather than as the Member's own choice.
    const version1 = new AgentTeamLedger(await openLegacy(rulesV1Ledger.records as Array<[string, unknown]>), { rulesVersion: 1 })
    await version1.initialize()
    version1.validateAtMount()
    // Every row in the segment came from the mention rule, and none of them
    // claims a cause the stored bytes never had.
    const sources = [...version1['state'].attention.values()].map(attention => attention.source)
    expect(sources.length).toBeGreaterThan(0)
    expect([...new Set(sources)]).toEqual(['mention'])
  })

  it('replays a source-less legacy Thread read snapshot using the existing Attention cause', async () => {
    const test = await harness(storedPool([...rulesV1Ledger.records]))
    const ledger = ledgerAtBoot(test)
    const actor: AgentTeamMemberActor = { kind: 'member', memberId: rulesV1Ledger.members.carol as never, handle: 'carol' }
    const read = (await ledger.readThread({ requestId: requestId('legacy-source-read'), workspaceId: alpha,
      taskRef: rulesV1Ledger.task.taskRef as AgentTeamTaskRef, actor })).value
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-read' || isThreadReadSnapshot(typed.data)) return [id, typed] as [string, unknown]
      const data = fabricateLegacyThreadReadSnapshot(typed.data, read)
      const attention = data.attention === undefined ? undefined : { ...data.attention, source: undefined }
      const inbox = { ...data.inbox, attention: { ...data.inbox.attention,
        set: data.inbox.attention.set.map(row => ({ ...row, source: undefined })) } }
      return [id, { ...typed, data: { ...data, ...(attention === undefined ? {} : { attention }), inbox } }] as [string, unknown]
    })
    const revived = await harness(storedPool(records))
    const replayed = ledgerAtBoot(revived)
    expect(() => replayed.validate()).not.toThrow()
    expect(replayed.attentionStatus(actor, { workspaceId: alpha, taskRef: rulesV1Ledger.task.taskRef as AgentTeamTaskRef }).attention)
      .toMatchObject({ source: 'mention' })
  })
})
