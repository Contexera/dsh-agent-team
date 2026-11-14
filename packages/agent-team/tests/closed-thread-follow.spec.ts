import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { openTestLedger } from './helpers/ledger-harness.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_RULES_VERSION, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import type { AgentTeamAgentMember, AgentTeamMemberId, AgentTeamRequestId, AgentTeamTask } from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
let counter = 0
const requestId = (label: string) => `test:closed-follow:${label}:${++counter}` as AgentTeamRequestId

/** A ledger at the rules version under test, with one Project and one Reviewer the Task can be handed to. */
async function seed(options?: { rulesVersion?: number }) {
  const { pool, table, ledger } = await openTestLedger({
    ledgerOptions: { rulesVersion: options?.rulesVersion ?? AGENT_TEAM_RULES_VERSION },
    initialize: true,
  })
  const projectRef = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'delivery', description: '', memberIds: [] })).value.project.projectRef
  const memberId = 'member:reviewer' as AgentTeamMemberId
  const member: AgentTeamAgentMember = { memberId, sessionId: SessionId('session:reviewer'), workspaceId: alpha, handle: 'reviewer',
    description: '', presetId: 'team-member', model: { provider: 'mock', model: 'mock' }, privateMemoryPath: '/tmp/reviewer', state: 'enabled' }
  await ledger.addMember({ requestId: requestId('add-reviewer'), actor: human, member, handle: 'reviewer', description: '', presetId: 'team-member',
    workspaceId: alpha, projectRefs: [projectRef], model: { provider: 'mock', model: 'mock' }})
  return { pool, table, projectRef, reviewer: memberId, get ledger() { return ledger } }
}

type Seeded = Awaited<ReturnType<typeof seed>>

async function startTask(team: Seeded) {
  const result = await team.ledger.startThread({ requestId: requestId('task'), actor: human, workspaceId: alpha, projectRef: team.projectRef,
    kind: 'task', body: 'Ship the change' })
  const value = result.value
  if (value.kind !== 'committed' || value.task === undefined) throw new Error('Task did not commit')
  return value.task
}

function followersOf(team: Seeded, task: AgentTeamTask) {
  return team.ledger.threadObservations(human, { workspaceId: alpha, taskRef: task.taskRef }).followers
}

async function closeTask(team: Seeded, task: Awaited<ReturnType<typeof startTask>>) {
  const read = (await team.ledger.readThread({ requestId: requestId('read'), actor: human, workspaceId: alpha, taskRef: task.taskRef })).value
  const closed = await team.ledger.changeTask({ requestId: requestId('close'), actor: human, workspaceId: alpha,
    taskRef: task.taskRef, action: 'close', baseRevision: read.thread.revision })
  expect(closed.value.kind).toBe('committed')
}

async function handOver(team: Seeded, task: Awaited<ReturnType<typeof startTask>>, target: AgentTeamMemberId) {
  const read = (await team.ledger.readThread({ requestId: requestId('transfer-read'), actor: human, workspaceId: alpha, taskRef: task.taskRef })).value
  return (await team.ledger.transferTask({ requestId: requestId('transfer'), actor: human, workspaceId: alpha,
    taskRef: task.taskRef, target, baseRevision: read.thread.revision })).value
}

describe('following a closed Task Thread', () => {
  it('returns the Human to the follower set, so a finished Task can still be handed back', async () => {
    const team = await seed()
    const task = await startTask(team)
    const moved = await handOver(team, task, team.reviewer)
    expect(moved.kind === 'committed' && moved.task.accountable).toBe(team.reviewer)
    await closeTask(team, task)
    // Closing ends every Attention row, which is what left a closed Thread with no candidate at all. The
    // follow is the one write a closed Thread still takes besides its own resolution.
    expect(followersOf(team, task)).toEqual([])
    const followed = await team.ledger.changeAttention({ requestId: requestId('follow'), actor: human, workspaceId: alpha,
      taskRef: task.taskRef, action: 'follow' })
    expect(followed.value.receipt.sequence).toBeGreaterThan(0)
    expect(followersOf(team, task)).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])
    // The follower set is the transfer dialog's offer, so the Human is now a target for a finished Task whose
    // accountable left, and the move lands where the Host says it lands.
    const back = await handOver(team, task, AGENT_TEAM_HUMAN_MEMBER_ID)
    expect(back.kind === 'committed' && back.task.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    // The record replays from cold: the follow is legal in a closed segment written under this version.
    expect(() => new AgentTeamLedger(team.table).validate()).not.toThrow()
  })

  it('keeps a version-3 ledger refusing the follow, so the older rule still decides its own records', async () => {
    const team = await seed({ rulesVersion: 3 })
    const task = await startTask(team)
    await closeTask(team, task)
    await expect(team.ledger.changeAttention({ requestId: requestId('v3-follow'), actor: human, workspaceId: alpha,
      taskRef: task.taskRef, action: 'follow' })).rejects.toThrow(/closed; reopen it before following/)
    expect(followersOf(team, task)).toEqual([])
  })

  it('refuses a ledger whose follow a newer build recorded, instead of re-judging it under the older rule', async () => {
    const team = await seed()
    const task = await startTask(team)
    await closeTask(team, task)
    await team.ledger.changeAttention({ requestId: requestId('follow'), actor: human, workspaceId: alpha, taskRef: task.taskRef, action: 'follow' })
    // A build one rules version behind refuses the storage rather than replaying a transition its own rules
    // reject: the marker is what makes the downgrade loud.
    expect(() => new (AgentTeamLedger)(team.table, { rulesVersion: AGENT_TEAM_RULES_VERSION - 1 }))
      .toThrow(new RegExp(`adopted rules version ${AGENT_TEAM_RULES_VERSION}, but this build implements up to ${AGENT_TEAM_RULES_VERSION - 1}`))
  })
})
