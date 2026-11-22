import { describe, expect, it } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool } from './helpers/memory-backend.ts'
import { openTestTable } from './helpers/ledger-harness.ts'
import { ScriptedAdapter, realHarness, requestId as harnessRequestId } from './helpers/member-harness.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import type {
  AgentTeamAgentMember, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId,
  AgentTeamRequestId, AgentTeamThreadRef,
} from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
let counter = 0
const requestId = (label: string) => `v10:${label}:${++counter}` as AgentTeamRequestId

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>

async function addAgent(ledger: AgentTeamLedger, handle: string) {
  const memberId = `member:${handle}` as AgentTeamMemberId
  const member: AgentTeamAgentMember = { memberId, sessionId: SessionId(`session:${handle}`), workspaceId: alpha, handle, description: '',
    presetId: 'team-member', model: { provider: 'mock', model: 'mock' }, privateMemoryPath: `/tmp/${handle}`, state: 'enabled' }
  await ledger.addMember({ requestId: requestId(`add-${handle}`), actor: human, member, handle, description: '', presetId: 'team-member', workspaceId: alpha, projectRefs: [], model: { provider: 'mock', model: 'mock' }})
  return { memberId, actor: { kind: 'member', memberId, handle } as AgentTeamMemberActor }
}

/** One Project with an Agent owner, a reviewer that owns nothing and never touched the Project, and an outsider in no Workspace. */
async function seed(rulesVersion = 10) {
  const pool = new MemoryMediaPool()
  const table: Table = (await openTestTable({ pool })).table
  const ledger = new AgentTeamLedger(table, { rulesVersion })
  await ledger.initialize()
  const projectRef = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'alpha', description: '' })).value.project.projectRef
  const owner = await addAgent(ledger, 'owner')
  const reviewer = await addAgent(ledger, 'reviewer')
  await ledger.addProjectOwner({ requestId: requestId('owner'), actor: human, workspaceId: alpha, projectRef, memberId: owner.memberId })
  return { pool, table, ledger, projectRef, owner, reviewer }
}
type Seeded = Awaited<ReturnType<typeof seed>>

async function startTask(team: Seeded, actor: AgentTeamMemberActor | typeof human, accountable?: AgentTeamMemberId) {
  const result = await team.ledger.startThread({ requestId: requestId('start'), actor, workspaceId: alpha, projectRef: team.projectRef,
    kind: 'task', body: 'Ship the change', ...(accountable === undefined ? {} : { accountable }) })
  if (result.value.kind !== 'committed' || result.value.task === undefined) throw new Error('Task did not commit')
  return { ...result.value, task: result.value.task }
}

async function startDiscussion(team: Seeded, actor: AgentTeamMemberActor | typeof human) {
  const result = await team.ledger.startThread({ requestId: requestId('discuss'), actor, workspaceId: alpha, projectRef: team.projectRef,
    kind: 'discussion', body: 'Should we ship this?' })
  if (result.value.kind !== 'committed') throw new Error('discussion did not commit')
  return result.value.thread
}

async function promote(team: Seeded, actor: AgentTeamMemberActor | typeof human, thread: { threadRef: AgentTeamThreadRef; revision: number }, accountable?: AgentTeamMemberId) {
  const result = await team.ledger.promoteThread({ requestId: requestId('promote'), actor, workspaceId: alpha, threadRef: thread.threadRef,
    baseRevision: thread.revision, ...(accountable === undefined ? {} : { accountable }) })
  if (result.value.kind !== 'committed') throw new Error('promotion did not commit')
  return result.value
}

const follows = (team: Seeded, memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef) =>
  team.ledger.attentionStatus({ kind: 'member', memberId, handle: memberId.slice('member:'.length) }, { workspaceId: alpha, threadRef }).attention

const responsibilityWake = (team: Seeded, memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef) =>
  team.ledger.notificationFacts(memberId).find(entry => entry.item.thread.threadRef === threadRef)
    ?.facts.some(entry => entry.direct && entry.fact.kind === 'activity' && entry.fact.activity.kind === 'promote') === true

async function records(table: Table): Promise<AgentTeamOperation[]> {
  const out: AgentTeamOperation[] = []
  for await (const [, operation] of await table.entries()) out.push(operation as AgentTeamOperation)
  return out
}

describe('rules version 10: a new Task names the accountable a transfer could reach', () => {
  it('lets an Agent owner start a Task accountable to a Member that owns nothing, who follows it and is woken', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor, team.reviewer.memberId)
    expect(started.task.accountable).toBe(team.reviewer.memberId)
    expect(follows(team, team.reviewer.memberId, started.thread.threadRef)).toMatchObject({ source: 'accountable' })
    // The creator still follows as the Thread's author; the named accountable receives the creation as a responsibility wake.
    expect(follows(team, team.owner.memberId, started.thread.threadRef)).toMatchObject({ source: 'thread-author' })
    expect(responsibilityWake(team, team.reviewer.memberId, started.thread.threadRef)).toBe(true)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 10 })).not.toThrow()
  })

  it('lets an Agent owner name the Human, and still defaults to itself when it names nobody', async () => {
    const team = await seed()
    expect((await startTask(team, team.owner.actor, AGENT_TEAM_HUMAN_MEMBER_ID)).task.accountable).toBe(AGENT_TEAM_HUMAN_MEMBER_ID)
    expect((await startTask(team, team.owner.actor)).task.accountable).toBe(team.owner.memberId)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 10 })).not.toThrow()
  })

  it('lets the Human start a Task accountable to a Member that owns nothing', async () => {
    const team = await seed()
    expect((await startTask(team, human, team.reviewer.memberId)).task.accountable).toBe(team.reviewer.memberId)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 10 })).not.toThrow()
  })

  it('records a named accountable on promotion, for an Agent owner and for the Human, and replays both', async () => {
    const team = await seed()
    const byOwner = await promote(team, team.owner.actor, await startDiscussion(team, team.owner.actor), team.reviewer.memberId)
    expect(byOwner.task.accountable).toBe(team.reviewer.memberId)
    expect(follows(team, team.reviewer.memberId, byOwner.thread.threadRef)).toMatchObject({ source: 'accountable' })
    // The Human naming an owner was refused on replay before version 10 although the write committed it.
    const byHuman = await promote(team, human, await startDiscussion(team, human), team.owner.memberId)
    expect(byHuman.task.accountable).toBe(team.owner.memberId)
    expect((await promote(team, team.owner.actor, await startDiscussion(team, team.owner.actor))).task.accountable).toBe(team.owner.memberId)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 10 })).not.toThrow()
  })

  it('refuses the targets a transfer refuses: a suspended Member and one outside the Workspace', async () => {
    const team = await seed()
    await team.ledger.suspendMember({ requestId: requestId('suspend'), actor: human, memberId: team.reviewer.memberId })
    await expect(startTask(team, team.owner.actor, team.reviewer.memberId)).rejects.toThrow(/accountable_target_invalid/)
    const discussion = await startDiscussion(team, team.owner.actor)
    await expect(promote(team, team.owner.actor, discussion, team.reviewer.memberId)).rejects.toThrow(/accountable_target_invalid/)
    await expect(startTask(team, team.owner.actor, 'member:outsider' as AgentTeamMemberId)).rejects.toThrow()
  })

  it('refuses on replay a version-10 start whose accountable a transfer could not reach', async () => {
    const team = await seed()
    const started = await startTask(team, team.owner.actor, team.reviewer.memberId)
    const stored = (await records(team.table)).find(operation => operation.kind === 'team/thread-started'
      && operation.data.thread.threadRef === started.thread.threadRef)!
    if (stored.kind !== 'team/thread-started') throw new Error('unreachable')
    await team.table.put(stored.operationId, { ...stored, data: { ...stored.data,
      task: { ...stored.data.task!, accountable: 'member:outsider' as AgentTeamMemberId } } } as AgentTeamOperation)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 10 })).toThrow(/invalid Task accountable/)
  })

  it('refuses on replay a version-10 promotion whose accountable a transfer could not reach', async () => {
    const team = await seed()
    const promoted = await promote(team, team.owner.actor, await startDiscussion(team, team.owner.actor), team.reviewer.memberId)
    const stored = (await records(team.table)).find(operation => operation.kind === 'team/thread-promoted'
      && operation.data.task.taskRef === promoted.task.taskRef)!
    if (stored.kind !== 'team/thread-promoted') throw new Error('unreachable')
    await team.table.put(stored.operationId, { ...stored, data: { ...stored.data,
      task: { ...stored.data.task, accountable: 'member:outsider' as AgentTeamMemberId } } } as AgentTeamOperation)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 10 })).toThrow(/invalid Task accountability on promotion/)
  })

  it('keeps the version-9 refusals for an Agent naming another accountable and replays that segment byte-identically', async () => {
    const team = await seed(9)
    await expect(startTask(team, team.owner.actor, team.reviewer.memberId)).rejects.toThrow(/accountable_target_invalid/)
    await expect(promote(team, team.owner.actor, await startDiscussion(team, team.owner.actor), team.reviewer.memberId)).rejects.toThrow(/accountable_target_invalid/)
    await expect(promote(team, human, await startDiscussion(team, human), team.owner.memberId)).rejects.toThrow(/accountable_target_invalid/)
    // A version-9 Human start may still name an enabled Project owner.
    expect((await startTask(team, human, team.owner.memberId)).task.accountable).toBe(team.owner.memberId)
    const before = await records(team.table)
    const reopened = new AgentTeamLedger(team.table, { rulesVersion: 10 })
    await reopened.initialize()
    const after = await records(team.table)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.at(-1)).toMatchObject({ kind: 'team/rules-version-adopted', data: { version: 10 } })
    expect(reopened.status().rulesVersion).toBe(10)
  })

  it('wakes the named accountable with what the new Task asks of it, and goes quiet once the Task is handed on', async () => {
    const adapter = new ScriptedAdapter()
    const { ctx, workspaceId } = await realHarness(adapter)
    const projectRef = (await ctx.agentTeam.createProject({ requestId: harnessRequestId('v10-project'), workspaceId, name: 'Packaging', description: '' })).project.projectRef
    const add = async (handle: string) => (await ctx.agentTeam.addMember({ requestId: harnessRequestId(`v10-${handle}`), workspaceId,
      handle, description: '', presetId: 'team-member', projectRefs: [], model: { provider: 'mock', model: 'mock' }})).status.member
    const reviewer = await add('reviewer')
    const other = await add('other')
    const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: harnessRequestId('v10-task'), workspaceId, projectRef,
      body: 'Cut the release', accountable: reviewer.memberId })
    if (started.kind !== 'committed' || started.task === undefined) throw new Error('Task did not commit')
    const ledger = ctx.agentTeam['ledger']!
    const noticeFor = (member: typeof reviewer) =>
      ctx.agentTeam['notificationText'](ctx.agents.get(member.sessionId)!, ledger.notificationFacts(member.memberId), member.memberId).text
    expect(noticeFor(reviewer)).toContain(`You are the accountable for Task ${started.task.taskRef}: `)
    expect(noticeFor(reviewer)).toContain('named you to drive it to acceptance')
    const humanRead = await ctx.agentTeam.readThread({ requestId: harnessRequestId('v10-read'), workspaceId, taskRef: started.task.taskRef })
    await ctx.agentTeam.transferTask({ requestId: harnessRequestId('v10-transfer'), workspaceId,
      taskRef: started.task.taskRef, target: other.memberId, baseRevision: humanRead.thread.revision })
    // The creation is judged against the current accountable, so the earlier name no longer prompts a review.
    expect(noticeFor(reviewer)).not.toContain('named you to drive it to acceptance')
    expect(noticeFor(other)).toContain(`You are the accountable for Task ${started.task.taskRef} now`)
  })

  it('stops a version-9 build at the version-10 marker before it reads a widened start', async () => {
    const team = await seed()
    await startTask(team, team.owner.actor, team.reviewer.memberId)
    expect(() => new AgentTeamLedger(team.table, { rulesVersion: 9 }))
      .toThrow(/adopted rules version 10, but this build implements up to 9; open it with a newer release/)
  })
})
