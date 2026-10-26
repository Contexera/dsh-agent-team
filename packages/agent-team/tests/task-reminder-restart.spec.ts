import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { provideQuietTokenMeter } from './helpers/team-host-fixture.ts'
import AgentTeam from '../src/index.ts'
import { agentTeamHumanActor } from '../src/ledger.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamProjectRef, AgentTeamRequestId, AgentTeamTaskRef } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const REVIEW_BACKLOG_MS = 30 * 60 * 1000
const START = Date.parse('2026-10-26T09:00:00.000Z')

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/**
 * One Team service over a caller-owned medium. Disposing the service and booting
 * a second one over the same pool is a Host restart: the ledger replays, the
 * process-local pieces (idle observations, delivery state) start empty.
 */
async function restartHarness(pool: MemoryMediaPool): Promise<{ readonly ctx: Context; readonly fiber: { dispose: () => Promise<void> } }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => id === alpha ? { id, path: process.cwd(), attachSession: async () => {}, archiveSession: async () => {} } : undefined,
    list: () => [{ id: alpha, path: process.cwd() }],
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  provideQuietTokenMeter(ctx)
  await ctx.plugin(agentTeamInvariant)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx, fiber }
}

/** Reminder records as the medium holds them: the durable evidence, not a runtime counter. */
function raisedReminders(pool: MemoryMediaPool): Extract<AgentTeamOperation, { kind: 'team/reminder-raised' }>[] {
  const table = pool.media.get('agent_team')?.tables.get('operations')
  return [...(table?.values() ?? [])]
    .map(value => value as AgentTeamOperation)
    .filter((operation): operation is Extract<AgentTeamOperation, { kind: 'team/reminder-raised' }> => operation.kind === 'team/reminder-raised')
    .sort((left, right) => left.sequence - right.sequence)
}

function remindersFor(pool: MemoryMediaPool, taskRef: AgentTeamTaskRef): Extract<AgentTeamOperation, { kind: 'team/reminder-raised' }>[] {
  return raisedReminders(pool).filter(operation => operation.data.taskRef === taskRef)
}

/**
 * Takes one Human-owned Task into `in_review` with an independent executor, then
 * clears the Human's unread responsibility marker so the review condition — and
 * not the suppression rule — decides whether a reminder is due.
 */
async function taskAwaitingHumanReview(ctx: Context, projectRef: AgentTeamProjectRef): Promise<AgentTeamTaskRef> {
  const label = crypto.randomUUID().slice(0, 8)
  const started = await ctx.agentTeam.startThread({ requestId: requestId(`task-start-${label}`), workspaceId: alpha, projectRef,
    kind: 'task', body: 'Ship the change' })
  if (started.kind !== 'committed' || started.task === undefined) throw new Error('Task did not start')
  const taskRef = started.task.taskRef
  const ledger = ctx.agentTeam['ledger']!
  const suffix = label
  const memberId = `member:executor-${suffix}` as AgentTeamMemberId
  const handle = `executor-${suffix}`
  const executor: AgentTeamMemberActor = { kind: 'member', memberId, handle }
  await ledger.addMember({
    requestId: requestId(`executor-${memberId}`), actor: agentTeamHumanActor(), workspaceId: alpha, handle,
    description: 'Executes the work', presetId: 'team-member', projectRefs: [projectRef],
    member: { memberId, sessionId: SessionId(`session:${memberId}`), workspaceId: alpha, handle,
      description: 'Executes the work', presetId: 'team-member', privateMemoryPath: `/tmp/${memberId}`, state: 'enabled' },
  })
  const claimRead = await ledger.readThread({ requestId: requestId(`claim-read-${label}`), actor: executor, workspaceId: alpha, taskRef })
  const claimed = await ledger.changeClaim({ requestId: requestId(`claim-${label}`), actor: executor, workspaceId: alpha, taskRef,
    action: 'claim', direction: 'implement the change', baseRevision: claimRead.value.thread.revision })
  if (claimed.value.kind !== 'committed') throw new Error('Claim did not start')
  const doneRead = await ledger.readThread({ requestId: requestId(`done-read-${label}`), actor: executor, workspaceId: alpha, taskRef })
  const done = await ledger.changeClaim({ requestId: requestId(`done-${label}`), actor: executor, workspaceId: alpha, taskRef,
    action: 'done', claimRef: claimed.value.claim.claimRef, baseRevision: doneRead.value.thread.revision })
  if (done.value.kind !== 'committed') throw new Error('Claim did not finish')
  await ctx.agentTeam.readThread({ requestId: requestId(`human-responsibility-read-${label}`), workspaceId: alpha, taskRef })
  return taskRef
}

/** Advance the Host clock past the review threshold, then run the evaluation one Inbox read triggers. */
async function evaluateAtInbox(ctx: Context): Promise<void> {
  await vi.advanceTimersByTimeAsync(REVIEW_BACKLOG_MS + 60_000)
  ctx.agentTeam.inbox({ workspaceId: alpha })
  await ctx.agentTeam['reminderEvaluationTail']
}

describe('Task reminder episodes across a Host restart', () => {
  it('keeps one review reminder for the same baseline, and still raises one for a new Task, after replay', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(START)
      const pool = new MemoryMediaPool()
      const first = await restartHarness(pool)
      const project = await first.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha,
        name: 'engineering', description: 'Engineering work' })
      const projectRef = project.project.projectRef
      const firstTask = await taskAwaitingHumanReview(first.ctx, projectRef)
      await evaluateAtInbox(first.ctx)
      expect(remindersFor(pool, firstTask)).toHaveLength(1)
      const deliveredInbox = first.ctx.agentTeam.inbox({ workspaceId: alpha })
      expect(deliveredInbox.items.find(item => item.task?.taskRef === firstTask)?.reminders).toHaveLength(1)

      await first.fiber.dispose()

      // Restart: the episode is only what the medium recorded, so a second
      // evaluation over the same baseline must not raise a second reminder.
      const second = await restartHarness(pool)
      const replayedInbox = second.ctx.agentTeam.inbox({ workspaceId: alpha })
      expect(replayedInbox.items.find(item => item.task?.taskRef === firstTask)?.reminders).toHaveLength(1)
      await evaluateAtInbox(second.ctx)
      expect(remindersFor(pool, firstTask)).toHaveLength(1)

      // The control that makes the assertion above mean something: the same
      // restarted Host does raise a reminder for a baseline it never saw.
      const secondTask = await taskAwaitingHumanReview(second.ctx, projectRef)
      await evaluateAtInbox(second.ctx)
      expect(remindersFor(pool, secondTask)).toHaveLength(1)
      expect(remindersFor(pool, firstTask)).toHaveLength(1)
      expect(raisedReminders(pool).map(operation => operation.data.kind)).toEqual(['review-backlog', 'review-backlog'])
      second.ctx.agentTeam.validateLedger()
    } finally {
      vi.useRealTimers()
    }
  })
})
