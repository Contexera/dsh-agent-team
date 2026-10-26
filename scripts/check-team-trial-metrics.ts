import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { AgentTeamLedger, agentTeamHumanActor } from '../packages/agent-team/src/ledger.ts'
import type { AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId } from '../packages/agent-team/src/types.ts'
import { calculateTrialMetrics } from './team-trial-metrics.ts'

const workspaceId = WorkspaceId('workspace:metrics')
const human = agentTeamHumanActor()
const actor = (memberId: AgentTeamMemberId) => ({ kind: 'member' as const, memberId, handle: 'worker' })
const operationId = (sequence: number) => `operation:${sequence}` as AgentTeamOperationId
const reminder = (sequence: number, memberId: AgentTeamMemberId): AgentTeamOperation => ({ sequence, operationId: operationId(sequence), previousOperationId: null,
  requestId: `metrics:${sequence}` as AgentTeamRequestId, occurredAt: '2026-10-26T00:00:00.000Z', actor: { kind: 'host', handle: 'host' }, kind: 'team/reminder-raised',
  data: { taskRef: 'task:1', kind: 'stalled', recipient: memberId, baselineSequence: 1,
    inbox: { attention: { set: [], removed: [] }, directMarkers: { added: [], removed: [] }, activityMarkers: { added: [], removed: [] },
      reminderMarkers: { added: [{ memberId, threadRef: 'thread:1', taskRef: 'task:1', kind: 'stalled', sequence, baselineSequence: 1 }], removed: [] } } } } as AgentTeamOperation)

async function main() {
  assert.throws(() => calculateTrialMetrics([reminder(1, 'member:worker' as AgentTeamMemberId)]))
  assert.equal(calculateTrialMetrics([]).range.utcCalendarDays, 0)

  const records = new Map<AgentTeamOperationId, AgentTeamOperation>()
  const table = { entries: () => records.entries(), put: async (key: AgentTeamOperationId, operation: AgentTeamOperation) => { records.set(key, operation) } }
  let instant = Date.parse('2026-10-24T23:59:00.000Z')
  const ledger = new AgentTeamLedger(table, { rulesVersion: 2, occurredAt: () => new Date(instant++).toISOString() })
  await ledger.initialize()
  const projectRef = (await ledger.createProject({ requestId: 'metrics:project' as AgentTeamRequestId, actor: human, workspaceId, name: 'metrics', description: '', memberIds: [] })).value.project.projectRef
  const memberId = 'member:worker' as AgentTeamMemberId
  await ledger.addMember({ requestId: 'metrics:member' as AgentTeamRequestId, actor: human, workspaceId, handle: 'worker', description: '', presetId: 'team-member',
    member: { memberId, sessionId: SessionId('session:worker'), workspaceId, handle: 'worker', description: '', presetId: 'team-member', privateMemoryPath: '/tmp/worker', state: 'enabled' }, projectRefs: [projectRef] })
  await ledger.addProjectOwner({ requestId: 'metrics:owner' as AgentTeamRequestId, actor: human, workspaceId, projectRef, memberId })
  const started = await ledger.startThread({ requestId: 'metrics:thread' as AgentTeamRequestId, actor: actor(memberId), workspaceId, projectRef, kind: 'discussion', body: 'Start' })
  const threadRef = started.value.thread!.threadRef
  await ledger.readThread({ requestId: 'metrics:read' as AgentTeamRequestId, actor: human, workspaceId, threadRef })
  instant = Date.parse('2026-10-26T00:01:00.000Z')
  await ledger.readMainStream({ requestId: 'metrics:main-read' as AgentTeamRequestId, actor: human, workspaceId, projectRef })
  const posted = await ledger.postMainMessage({ requestId: 'metrics:main' as AgentTeamRequestId, actor: human, workspaceId, projectRef, body: '@worker hello' })
  assert.equal(posted.committed, true)
  await ledger.readMainStream({ requestId: 'metrics:agent-main-read' as AgentTeamRequestId, actor: actor(memberId), workspaceId, projectRef })
  const reply = await ledger.postMainMessage({ requestId: 'metrics:reply' as AgentTeamRequestId, actor: actor(memberId), workspaceId, projectRef,
    body: 'Done', replyToMessageRef: posted.value.kind === 'committed' ? posted.value.message.messageRef : undefined })
  assert.equal(reply.committed, true)
  const operations = [...records.values()]
  const result = calculateTrialMetrics(operations.map(operation => [operation.operationId, operation]))
  assert.equal(result.range.utcCalendarDays, 3, JSON.stringify({ range: result.range, operations: operations.map(operation => [operation.sequence, operation.kind, operation.occurredAt]) }))
  assert.equal(result.delivery.allMembers.immediateNotificationFactsByMember[memberId], 3)
  assert.deepEqual(result.delivery.owners.byUtcDay, [
    { date: '2026-10-24', memberId, immediateNotificationFacts: 1 },
    { date: '2026-10-26', memberId, immediateNotificationFacts: 2 },
  ])
  assert.equal(result.agentReplies.total, 1)
  assert.equal(result.agentReplies.agentToAgent, 0)

  const task = await ledger.startThread({ requestId: 'metrics:task' as AgentTeamRequestId, actor: human, workspaceId, projectRef,
    kind: 'task', body: 'Work', accountable: memberId })
  if (task.value.kind !== 'committed' || task.value.task === undefined) throw new Error('Task did not commit')
  const taskRef = task.value.task.taskRef
  const read = await ledger.readThread({ requestId: 'metrics:task-read' as AgentTeamRequestId, actor: actor(memberId), workspaceId, taskRef })
  const claimed = await ledger.changeClaim({ requestId: 'metrics:claim' as AgentTeamRequestId, actor: actor(memberId), workspaceId, taskRef,
    baseRevision: read.value.thread.revision, action: 'claim', direction: 'Work' })
  if (claimed.value.kind !== 'committed') throw new Error('Claim did not commit')
  const raised = await ledger.raiseReminder({ taskRef, kind: 'stalled', recipient: memberId, baselineSequence: claimed.value.receipt.sequence },
    Date.parse(claimed.value.receipt.occurredAt) + 86400001, () => 0)
  assert.notEqual(raised, undefined)
  const progress = await ledger.reply({ requestId: 'metrics:progress' as AgentTeamRequestId, actor: actor(memberId), workspaceId, taskRef,
    baseRevision: claimed.value.thread.revision, body: 'Progress' })
  assert.equal(progress.committed, true)
  const stale = calculateTrialMetrics([...records.values()].map(operation => [operation.operationId, operation]))
  assert.equal(stale.reminders.staleUnread, 1)
  assert.equal(stale.reminders.visibleUnread, 0)
  await ledger.readThread({ requestId: 'metrics:stale-read' as AgentTeamRequestId, actor: actor(memberId), workspaceId, taskRef })
  const consumed = calculateTrialMetrics([...records.values()].map(operation => [operation.operationId, operation]))
  assert.equal(consumed.reminders.consumedAfterInvalidation, 1)
  assert.equal(consumed.reminders.unread, 0)

  const databasePath = process.argv[2]
  if (databasePath !== undefined) {
    const database = new DatabaseSync(databasePath)
    database.exec('CREATE TABLE IF NOT EXISTS u_agent_team_operations (key TEXT PRIMARY KEY, value TEXT NOT NULL); DELETE FROM u_agent_team_operations')
    const insert = database.prepare('INSERT INTO u_agent_team_operations VALUES (?, ?)')
    for (const operation of operations) insert.run(operation.operationId, JSON.stringify(operation))
    database.close()
  }
  console.log('team-trial-metrics: empty, malformed, reply, UTC boundary and stale reminder checks passed')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
