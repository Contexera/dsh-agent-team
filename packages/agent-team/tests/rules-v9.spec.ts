import { describe, expect, it } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { openTestTable } from './helpers/ledger-harness.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { snapshotScript } from '../src/subscriptions.ts'
import type {
  AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId,
  AgentTeamProjectRef, AgentTeamRequestId, AgentTeamTaskRef, AgentTeamThreadRef,
} from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
const snapshot = snapshotScript('printf \'{"id":"a","title":"A"}\n\'\n', 'bash')
if (!snapshot.ok) throw new Error('the fixture script must be valid')
const script = snapshot.script

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>
let counter = 0
const requestId = (label: string) => `v9:${label}:${++counter}` as AgentTeamRequestId

async function openTable(pool: MemoryMediaPool): Promise<Table> {
  return (await openTestTable({ pool })).table
}

const actorOf = (memberId: AgentTeamMemberId, handle: string): AgentTeamMemberActor => ({ kind: 'member', memberId, handle })

interface Agent { readonly memberId: AgentTeamMemberId; readonly actor: AgentTeamMemberActor }

async function addAgent(ledger: AgentTeamLedger, handle: string): Promise<Agent> {
  const memberId = `member:${handle}` as AgentTeamMemberId
  const member: AgentTeamAgentMember = { memberId, sessionId: SessionId(`session:${handle}`), workspaceId: alpha, handle, description: '',
    presetId: 'team-member', model: { provider: 'mock', model: 'mock' }, privateMemoryPath: `/tmp/${handle}`, state: 'enabled' }
  await ledger.addMember({ requestId: requestId(`add-${handle}`), actor: human, member, handle, description: '', presetId: 'team-member', workspaceId: alpha, projectRefs: [], model: { provider: 'mock', model: 'mock' }})
  return { memberId, actor: actorOf(memberId, handle) }
}

/** A version-9 Team: one Project, an Agent owner, and Workspace Members that never touched the Project. */
async function seed(rulesVersion = 9) {
  const pool = new MemoryMediaPool()
  const table: Table = await openTable(pool)
  const ledger = new AgentTeamLedger(table, { rulesVersion })
  await ledger.initialize()
  const projectRef = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'alpha', description: '' })).value.project.projectRef
  const owner = await addAgent(ledger, 'owner')
  const member = await addAgent(ledger, 'member')
  const stranger = await addAgent(ledger, 'stranger')
  await ledger.addProjectOwner({ requestId: requestId('owner'), actor: human, workspaceId: alpha, projectRef, memberId: owner.memberId })
  return { pool, table, ledger, projectRef, owner, member, stranger }
}

type Seeded = Awaited<ReturnType<typeof seed>>

async function post(team: Seeded, actor: AgentTeamMemberActor | typeof human, body: string, projectRef: AgentTeamProjectRef = team.projectRef) {
  const result = await team.ledger.postMainMessage({ requestId: requestId('post'), actor, workspaceId: alpha, projectRef, body })
  if (result.value.kind !== 'committed') throw new Error(`expected a committed Main post, received ${result.value.kind}`)
  return result.value
}

async function readMain(team: Seeded, actor: AgentTeamMemberActor | typeof human, projectRef: AgentTeamProjectRef = team.projectRef) {
  return (await team.ledger.readMainStream({ requestId: requestId('read-main'), actor, workspaceId: alpha, projectRef })).value
}

async function acknowledgeMain(team: Seeded, actor: AgentTeamMemberActor | typeof human, projectRef: AgentTeamProjectRef = team.projectRef) {
  for (;;) {
    const read = await readMain(team, actor, projectRef)
    if (read.standing.unreadCount === 0) return read
  }
}

async function acknowledgeThread(team: Seeded, actor: AgentTeamMemberActor, taskRef: AgentTeamTaskRef) {
  for (;;) {
    const read = (await team.ledger.readThread({ requestId: requestId('read-thread'), actor, workspaceId: alpha, taskRef })).value
    if (read.remainingUnreadCount === 0) return read
  }
}

async function revisionOf(team: Seeded, taskRef: AgentTeamTaskRef): Promise<number> {
  return team.ledger.threadHistory(human, { workspaceId: alpha, taskRef }).thread.revision
}

async function startTask(team: Seeded, actor: AgentTeamMemberActor | typeof human, subject: string, accountable?: AgentTeamMemberId) {
  const result = await team.ledger.startThread({ requestId: requestId('start'), actor, workspaceId: alpha, projectRef: team.projectRef,
    kind: 'task', body: subject, ...(accountable === undefined ? {} : { accountable }) })
  if (result.value.kind !== 'committed') throw new Error(`expected a committed Task, received ${result.value.kind}`)
  return result.value
}

async function wakeOf(team: Seeded, kind: string) {
  const records: AgentTeamOperation[] = []
  for await (const [, operation] of await team.table.entries()) records.push(operation as AgentTeamOperation)
  const found = records.filter(operation => operation.kind === kind)
  return team.ledger.affectedMembersOf(found.at(-1)!)
}

const threadStanding = (team: Seeded, actor: AgentTeamMemberActor, threadRef: AgentTeamThreadRef) =>
  team.ledger.attentionStatus(actor, { workspaceId: alpha, threadRef }).attention

describe('rules version 9: a Project keeps only own and follow', () => {
  it('lets a Workspace participant who neither owns nor follows read, post and mention the owner on the Main stream', async () => {
    const team = await seed()
    await post(team, human, 'seed message')
    // No grant, no follow, no prior Thread: Workspace participation alone opens the stream.
    const read = await readMain(team, team.stranger.actor)
    expect(read.entries.length).toBeGreaterThan(0)
    const posted = await post(team, team.stranger.actor, 'flagging @owner on this')
    expect(posted.message.sender).toBe(team.stranger.memberId)
    // The mention is a direct marker, independent of follow.
    expect(posted.markers.map(marker => marker.memberId)).toEqual([team.owner.memberId])
  })

  it('transfers a Task to a Workspace Member who never appeared in the Project', async () => {
    const team = await seed()
    const task = await startTask(team, human, 'hand me over', team.owner.memberId)
    const moved = await team.ledger.transferTask({ requestId: requestId('transfer'), actor: human, workspaceId: alpha,
      taskRef: task.task!.taskRef, target: team.stranger.memberId, baseRevision: await revisionOf(team, task.task!.taskRef) })
    expect(moved.value.kind).toBe('committed')
    if (moved.value.kind !== 'committed') throw new Error('expected a committed transfer')
    expect(moved.value.task.accountable).toBe(team.stranger.memberId)
  })

  it('does not wake a non-follower for an ordinary Main post, and does wake them for a mention', async () => {
    const team = await seed()
    await acknowledgeMain(team, team.owner.actor)
    await post(team, team.owner.actor, 'ordinary update')
    expect(await wakeOf(team, 'team/main-message-posted')).not.toContain(team.stranger.memberId)

    await acknowledgeMain(team, team.owner.actor)
    const mentioned = await post(team, team.owner.actor, 'direct ping @stranger')
    expect(mentioned.markers.map(marker => marker.memberId)).toEqual([team.stranger.memberId])
    expect(await wakeOf(team, 'team/main-message-posted')).toContain(team.stranger.memberId)
  })

  it('auto-follows the Main stream on an owner grant and still delivers a mention after unfollow', async () => {
    const team = await seed()
    // The grant in `seed` already ran: the owner follows the stream through its own row.
    expect(team.ledger.isFollowingMain(team.owner.memberId, team.projectRef)).toBe(true)

    await team.ledger.changeAttention({ requestId: requestId('unfollow-main'), actor: team.owner.actor,
      workspaceId: alpha, projectRef: team.projectRef, action: 'unfollow' })
    expect(team.ledger.isFollowingMain(team.owner.memberId, team.projectRef)).toBe(false)

    await acknowledgeMain(team, team.member.actor)
    const mentioned = await post(team, team.member.actor, 'still pings @owner')
    expect(mentioned.markers.map(marker => marker.memberId)).toEqual([team.owner.memberId])
  })

  it('keeps an ex-owner accountable on its Tasks while the Member still participates in the Workspace', async () => {
    const team = await seed()
    const task = await startTask(team, human, 'owner keeps it', team.owner.memberId)
    await team.ledger.removeProjectOwner({ requestId: requestId('revoke'), actor: human, workspaceId: alpha,
      projectRef: team.projectRef, memberId: team.owner.memberId })
    const board = team.ledger.taskBoard(human, { workspaceId: alpha, projectRef: team.projectRef })
    expect(board.open.find(item => item.task.taskRef === task.task!.taskRef)?.task.accountable).toBe(team.owner.memberId)
  })

  it('ends only the accountable-source follow on transfer and keeps a self follow', async () => {
    const team = await seed()
    // Task one: member becomes accountable through a grant-less transfer, gaining the `accountable` follow.
    const first = await startTask(team, human, 'first task', team.owner.memberId)
    await team.ledger.transferTask({ requestId: requestId('transfer-in'), actor: human, workspaceId: alpha,
      taskRef: first.task!.taskRef, target: team.member.memberId, baseRevision: await revisionOf(team, first.task!.taskRef) })
    expect(threadStanding(team, team.member.actor, first.thread.threadRef)).toMatchObject({ source: 'accountable' })
    await team.ledger.transferTask({ requestId: requestId('transfer-out'), actor: human, workspaceId: alpha,
      taskRef: first.task!.taskRef, target: team.stranger.memberId, baseRevision: await revisionOf(team, first.task!.taskRef) })
    expect(threadStanding(team, team.member.actor, first.thread.threadRef)).toBeUndefined()

    // Task two: the member followed before taking responsibility, so the row is `self` and survives.
    const second = await startTask(team, human, 'second task', team.owner.memberId)
    await team.ledger.changeAttention({ requestId: requestId('self-follow'), actor: team.member.actor,
      workspaceId: alpha, threadRef: second.thread.threadRef, action: 'follow' })
    await team.ledger.transferTask({ requestId: requestId('transfer-in-2'), actor: human, workspaceId: alpha,
      taskRef: second.task!.taskRef, target: team.member.memberId, baseRevision: await revisionOf(team, second.task!.taskRef) })
    await team.ledger.transferTask({ requestId: requestId('transfer-out-2'), actor: human, workspaceId: alpha,
      taskRef: second.task!.taskRef, target: team.stranger.memberId, baseRevision: await revisionOf(team, second.task!.taskRef) })
    expect(threadStanding(team, team.member.actor, second.thread.threadRef)).toMatchObject({ source: 'self' })
  })

  it('keeps the accountable follow while the Member still holds an active Claim on the Task', async () => {
    const team = await seed()
    const task = await startTask(team, human, 'claimed task', team.owner.memberId)
    await team.ledger.transferTask({ requestId: requestId('transfer-in'), actor: human, workspaceId: alpha,
      taskRef: task.task!.taskRef, target: team.member.memberId, baseRevision: await revisionOf(team, task.task!.taskRef) })
    await acknowledgeThread(team, team.member.actor, task.task!.taskRef)
    const claimed = await team.ledger.changeClaim({ requestId: requestId('claim'), actor: team.member.actor, workspaceId: alpha,
      taskRef: task.task!.taskRef, action: 'claim', direction: 'part of it', baseRevision: await revisionOf(team, task.task!.taskRef) })
    expect(claimed.value.kind).toBe('committed')
    await team.ledger.transferTask({ requestId: requestId('transfer-out'), actor: human, workspaceId: alpha,
      taskRef: task.task!.taskRef, target: team.stranger.memberId, baseRevision: await revisionOf(team, task.task!.taskRef) })
    expect(threadStanding(team, team.member.actor, task.thread.threadRef)).toBeDefined()
  })

  it('accepts a never-before-seen Workspace Member as a notify recipient and refuses a suspended one with the new code', async () => {
    const team = await seed()
    const accepted = await team.ledger.createSubscription({ requestId: requestId('sub'), actor: human, workspaceId: alpha,
      projectRef: team.projectRef, name: 'watch', triggers: { interval: { minutes: 15 } },
      script, credentials: [], notify: [team.stranger.memberId], baselineIds: [] })
    expect(accepted.value.subscription).toBeDefined()

    await team.ledger.suspendMember({ requestId: requestId('suspend'), actor: human, memberId: team.stranger.memberId })
    await expect(team.ledger.createSubscription({ requestId: requestId('sub-2'), actor: human, workspaceId: alpha,
      projectRef: team.projectRef, name: 'watch2', triggers: { interval: { minutes: 15 } },
      script, credentials: [], notify: [team.stranger.memberId], baselineIds: [] })).rejects.toThrow(/notify_recipient_invalid/)
  })

  it('replays a version-8 segment unchanged and keeps its membership refusals', async () => {
    const v8 = await seed(8)
    // Version 8 seeds members without grants: a Member that never took part in the Project cannot write to its stream.
    await expect(post(v8, v8.stranger.actor, 'not a member')).rejects.toThrow(/not_project_member/)
    // Reopening the same records under the current build replays every
    // committed record byte-identically before the version-9 adoption marker.
    const before: AgentTeamOperation[] = []
    for await (const [, operation] of await v8.table.entries()) before.push(operation as AgentTeamOperation)
    const reopened = new AgentTeamLedger(v8.table, { rulesVersion: 9 })
    await reopened.initialize()
    const after: AgentTeamOperation[] = []
    for await (const [, operation] of await v8.table.entries()) after.push(operation as AgentTeamOperation)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(reopened.status().rulesVersion).toBe(9)
  })
})
