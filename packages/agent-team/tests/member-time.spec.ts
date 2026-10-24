import { describe, expect, it } from 'vitest'
import { afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import AgentTeam from '../src/index.ts'
import { agentTeamHumanActor, AgentTeamLedger, isThreadReadSnapshot } from '../src/ledger.ts'
import { formatTeamTimestamp } from '../src/time-format.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { fabricateLegacyThreadReadSnapshot } from './helpers/legacy-thread-read.ts'
import { provideQuietTokenMeter } from './helpers/team-host-fixture.ts'
import type {
  AgentTeamAgentMember,
  AgentTeamMemberActor,
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamRequestId,
  AgentTeamTask,
  AgentTeamThreadReadResult,
} from '../src/types.ts'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

const alpha = WorkspaceId('workspace:alpha')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

interface TeamHarness {
  readonly ctx: Context
  readonly fiber: Awaited<ReturnType<Context['plugin']>>
  readonly facility: DomainFacility
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness(pool = new MemoryMediaPool(), workspaceIds = [alpha]): Promise<TeamHarness> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('workspaceRegistry', {
    get: (id: WorkspaceId) => workspaceIds.includes(id) ? { id, path: process.cwd(), attachSession: async () => {} } : undefined,
    list: () => workspaceIds.map(id => ({ id, path: process.cwd() })),
    archiveSession: async () => {},
  })
  ctx.provide('agents', { create: async () => { throw new Error('unused') }, resume: async () => { throw new Error('unused') } })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }) })
  ctx.provide('agentPresets', { mount: async () => { throw new Error('unused') } })
  ctx.provide('tools', { schemas: () => [] })
  ctx.provide('sessionPersistence', { list: async () => [] })
  provideQuietTokenMeter(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx, fiber, facility }
}

function committed<T extends { readonly kind: string }>(result: T): Extract<T, { readonly kind: 'committed' }> {
  if (result.kind !== 'committed') throw new Error(`expected committed result, received ${result.kind}`)
  return result as Extract<T, { readonly kind: 'committed' }>
}

function withTask<T extends { readonly task?: AgentTeamTask }>(result: T): T & { readonly task: AgentTeamTask } {
  if (result.task === undefined) throw new Error('expected Task overlay')
  return result as T & { readonly task: AgentTeamTask }
}

function replayLedgerAtConstruction(test: TeamHarness): AgentTeamLedger {
  return new AgentTeamLedger(test.facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

async function addLedgerMember(
  ledger: AgentTeamLedger,
  projectRef: string | undefined,
  memberId = `member:agent-${crypto.randomUUID()}`,
): Promise<{ readonly member: AgentTeamAgentMember; readonly actor: AgentTeamMemberActor }> {
  const member: AgentTeamAgentMember = {
    memberId: memberId as never,
    sessionId: SessionId(`session:${memberId}`),
    workspaceId: alpha,
    handle: memberId.slice('member:'.length),
    description: 'Test Agent',
    presetId: 'team-member',
    privateMemoryPath: `/tmp/${memberId}`,
    state: 'enabled',
  }
  await ledger.addMember({ requestId: requestId(`add:${memberId}`), actor: agentTeamHumanActor(), member, handle: member.handle,
    description: member.description, presetId: member.presetId, workspaceId: alpha,
    projectRefs: projectRef === undefined ? [] : [projectRef as never] })
  return { member, actor: { kind: 'member', memberId: member.memberId, handle: member.handle } }
}

async function seededThread(): Promise<{ readonly test: TeamHarness; readonly ledger: AgentTeamLedger; readonly actor: AgentTeamMemberActor; readonly taskRef: AgentTeamTask['taskRef']; readonly humanRead: AgentTeamThreadReadResult }> {
  const test = await harness()
  const project = await test.ctx.agentTeam.createProject({ requestId: requestId('project'), workspaceId: alpha, name: 'engineering', description: 'Engineering work' })
  const started = withTask(committed(await test.ctx.agentTeam.startThread({ kind: 'task', requestId: requestId('start'), workspaceId: alpha, projectRef: project.project.projectRef, body: 'Implement member time awareness' })))
  const taskRef = started.task.taskRef
  const ledger = replayLedgerAtConstruction(test)
  const { actor } = await addLedgerMember(ledger, project.project.projectRef)
  await ledger.changeAttention({ requestId: requestId('follow'), workspaceId: alpha, taskRef, action: 'follow', actor })
  committed((await ledger.changeClaim({ requestId: requestId('claim'), workspaceId: alpha, taskRef,
    action: 'claim', direction: 'fold the clock baseline', baseRevision: started.thread.revision, actor })).value)
  // The Human must drain the claim activity before replying; the drained
  // read also supplies the fresh baseRevision the reply needs.
  const humanRead = (await ledger.readThread({ requestId: requestId('human-read'), workspaceId: alpha, taskRef, actor: agentTeamHumanActor() })).value
  committed((await ledger.reply({ requestId: requestId('reply'), workspaceId: alpha, taskRef, body: 'First reply', baseRevision: humanRead.readThroughSequence, actor: agentTeamHumanActor() })).value)
  return { test, ledger, actor, taskRef, humanRead }
}

describe('fact envelope instants project from the committing operation', () => {
  it('every read fact carries an occurredAt equal to its committing operation instant', async () => {
    const { ledger, actor, taskRef } = await seededThread()
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef, actor })).value
    expect(read.facts.length).toBeGreaterThan(0)
    for (const entry of read.facts) {
      expect(entry.fact.occurredAt).not.toBe('')
      const operation = (ledger as unknown as { state: { ordered: readonly AgentTeamOperation[] } }).state.ordered[entry.fact.sequence - 1]!
      expect(entry.fact.occurredAt).toBe(operation.occurredAt)
    }
  })

  it('message facts and activity facts share one envelope contract', async () => {
    const { ledger, actor, taskRef } = await seededThread()
    // History projects both kinds: the anchor and reply messages plus the
    // claim activity. Every fact carries an envelope instant; a message
    // fact's instant equals its message's own committed instant.
    const history = ledger.threadHistory(actor, { workspaceId: alpha, taskRef })
    expect(history.facts.some(fact => fact.kind === 'message')).toBe(true)
    expect(history.facts.some(fact => fact.kind === 'activity')).toBe(true)
    for (const fact of history.facts) {
      expect(fact.occurredAt).not.toBe('')
      if (fact.kind === 'message') expect(fact.occurredAt).toBe(fact.message.occurredAt)
    }
  })

  it('the anchor instant equals the committing operation instant', async () => {
    const { ledger, actor, taskRef } = await seededThread()
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef, actor })).value
    const operation = (ledger as unknown as { state: { ordered: readonly AgentTeamOperation[] } }).state.ordered[read.anchor.sequence - 1]!
    expect(read.anchor.occurredAt).toBe(operation.occurredAt)
    expect(read.anchor.occurredAt).toBe(read.facts.find(entry => entry.fact.sequence === read.anchor.sequence)?.fact.occurredAt ?? read.anchor.occurredAt)
  })
})

describe('the cache invariant: one fact, one instant, on every reread path', () => {
  it('read, history paging, and a fresh replay agree byte-for-byte on every fact instant', async () => {
    const { test, ledger, actor, taskRef } = await seededThread()
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef, actor })).value
    const history = ledger.threadHistory(actor, { workspaceId: alpha, taskRef })
    const readInstants = read.facts.map(entry => `${entry.fact.sequence}:${entry.fact.occurredAt}`)
    const historyInstants = history.facts.map(fact => `${fact.sequence}:${fact.occurredAt}`)
    // History covers the full thread including every read fact.
    for (const instant of readInstants) expect(historyInstants).toContain(instant)
    expect(history.anchor.occurredAt).toBe(read.anchor.occurredAt)
    // A cold second ledger replays the same durable records and must project
    // the identical instants on every reread path — the post-compaction and
    // restart path. History is read-state independent, so the comparison
    // covers the whole thread, not only the one drained batch.
    const replay = replayLedgerAtConstruction(test)
    const replayedHistory = replay.threadHistory(actor, { workspaceId: alpha, taskRef })
    expect(replayedHistory.facts.map(fact => `${fact.sequence}:${fact.occurredAt}`)).toEqual(historyInstants)
    expect(replayedHistory.anchor.occurredAt).toBe(history.anchor.occurredAt)
    // The replayed read of an already-drained follower still renders the
    // background anchor with its identical instant.
    const replayedRead = (await replay.readThread({ requestId: requestId('reread'), workspaceId: alpha, taskRef, actor })).value
    expect(replayedRead.anchor.occurredAt).toBe(read.anchor.occurredAt)
    replay.validate()
  })

  it('history continuation pages project the same instants as the first page', async () => {
    const { ledger, actor, taskRef } = await seededThread()
    const first = ledger.threadHistory(actor, { workspaceId: alpha, taskRef })
    const paged = ledger.threadHistory(actor, { workspaceId: alpha, taskRef, beforeSequence: first.cursor, limit: 1 })
    const firstInstants = new Map(first.facts.map(fact => [fact.sequence, fact.occurredAt]))
    for (const fact of paged.facts) expect(fact.occurredAt).toBe(firstInstants.get(fact.sequence))
  })

  it('pre-envelope ledgers normalize activity instants from the committing operation on replay', async () => {
    const { test, ledger, actor, taskRef, humanRead } = await seededThread()
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef, actor })).value
    const storedInstants = new Map(read.facts.map(entry => [entry.fact.sequence, entry.fact.occurredAt]))
    // Each read answered with the picture of its own moment, so a stored
    // snapshot can only be rebuilt from the picture of the read that wrote it.
    const pictures = new Map<AgentTeamRequestId, Omit<AgentTeamThreadReadResult, 'receipt'>>([
      [requestId('human-read'), humanRead],
      [requestId('read'), read],
    ])
    // Strip every envelope instant from every thread-read record, exactly as
    // a pre-occurredAt ledger would store them; the read results themselves
    // are durable records and the replay must rebuild identical instants.
    const records = [...test.facility.get('agent_team')!.table('operations').entries()].map(([id, operation]) => {
      const typed = operation as AgentTeamOperation
      if (typed.kind !== 'team/thread-read' || isThreadReadSnapshot(typed.data)) return [id, typed] as [string, unknown]
      const data = fabricateLegacyThreadReadSnapshot(typed.data, pictures.get(typed.requestId)!)
      const facts = data.facts.map(entry => ({ ...entry, fact: { ...entry.fact, occurredAt: undefined } }))
      return [id, { ...typed, data: { ...data, facts } }] as [string, unknown]
    })
    const pool = new MemoryMediaPool()
    pool.versions.set('agent_team', agentTeamDomainSpec.version)
    pool.media.set('agent_team', { tables: new Map([['operations', new Map(records)]]), global: null })
    const revived = await harness(pool)
    const replay = replayLedgerAtConstruction(revived)
    const replayed = (await replay.readThread({ requestId: requestId('legacy-reread'), workspaceId: alpha, taskRef, actor })).value
    for (const entry of replayed.facts) expect(entry.fact.occurredAt).toBe(storedInstants.get(entry.fact.sequence))
    expect(() => replay.validate()).not.toThrow()
  })
})

describe('discovery projections hang off the same per-fact source', () => {
  it('inbox newestOccurredAt is the newest unread fact instant from the same snapshot', async () => {
    const { ledger, actor, taskRef } = await seededThread()
    // Two inbox snapshots before any read agree — the value is stable per
    // durable state, not per call.
    const inbox = ledger.inbox(actor, { workspaceId: alpha })
    const again = ledger.inbox(actor, { workspaceId: alpha })
    expect(inbox.items).toHaveLength(1)
    expect(again.items).toHaveLength(1)
    expect(again.items[0]!.newestOccurredAt).toBe(inbox.items[0]!.newestOccurredAt)
    expect(again.items[0]!.newestSequence).toBe(inbox.items[0]!.newestSequence)
    const item = inbox.items[0]!
    // The unread batch the item summarizes, read independently, ends at the
    // fact the item names: same snapshot, same source, one value.
    const read = (await ledger.readThread({ requestId: requestId('inbox-read'), workspaceId: alpha, taskRef, actor })).value
    const newestUnread = read.facts.at(-1)
    expect(newestUnread).toBeDefined()
    expect(item.newestSequence).toBe(newestUnread!.fact.sequence)
    expect(item.newestOccurredAt).toBe(newestUnread!.fact.occurredAt)
  })

  it('the Inbox row carries the Task\'s live owners, and no owner once the work is gone', async () => {
    const { ledger, actor, taskRef } = await seededThread()
    const claimed = ledger.inbox(actor, { workspaceId: alpha }).items[0]!
    // The row answers 「谁在这个 Task 上」 with the ledger's own rule — the same one
    // the Project feed applies — resolved to handles here, because an Inbox row
    // has no Member roster of its own to turn ids into them.
    expect(claimed.liveClaimOwners).toEqual([{ memberId: actor.memberId, name: actor.handle }])
    // The claimant drains its own unread before writing, and a released Claim is
    // no longer work: the Task drops back to unclaimed, and the row stops naming
    // owners the moment there are none rather than keeping a stale roster.
    const drained = (await ledger.readThread({ requestId: requestId('owner-read'), workspaceId: alpha, taskRef, actor })).value
    const claim = ledger.listClaims(actor, { workspaceId: alpha, taskRef }).claims[0]!
    committed((await ledger.changeClaim({ requestId: requestId('owner-release'), workspaceId: alpha, taskRef,
      action: 'release', claimRef: claim.claimRef, baseRevision: drained.readThroughSequence, actor })).value)
    const humanItem = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha }).items
      .find(item => item.task?.taskRef === taskRef)!
    expect(humanItem.task?.status).toBe('todo')
    expect(humanItem.liveClaimOwners).toEqual([])
  })

  it('names every live Claim owner in claim order, and only those still on the Task', async () => {
    const { ledger, actor, taskRef } = await seededThread()
    const projectRef = ledger.inbox(actor, { workspaceId: alpha }).items[0]!.projectRef
    const { actor: second } = await addLedgerMember(ledger, projectRef)
    const secondRead = (await ledger.readThread({ requestId: requestId('second-read'), workspaceId: alpha, taskRef, actor: second })).value
    committed((await ledger.changeClaim({ requestId: requestId('second-claim'), workspaceId: alpha, taskRef,
      action: 'claim', direction: 'second direction', baseRevision: secondRead.thread.revision, actor: second })).value)
    // The Human reads the row here on purpose: a Member's queue is exactly their
    // unread, so the claimant's own row would be gone once it drained — and the
    // roster rule is a fact about the Thread, not about one reader's unread.
    const ownerRow = () => {
      const view = ledger.inbox(agentTeamHumanActor(), { workspaceId: alpha })
      return [...view.items, ...view.recent].find(item => item.task?.taskRef === taskRef)!
    }
    // A second Claim is a second face, and the roster is ordered by claim, not by
    // whichever Member the ledger happens to hold first.
    expect(ownerRow().liveClaimOwners).toEqual([
      { memberId: actor.memberId, name: actor.handle },
      { memberId: second.memberId, name: second.handle },
    ])
    // One owner leaving does not empty the row: the Claim still standing is what
    // the row names, so a released Claim drops out and the others stay.
    const drained = (await ledger.readThread({ requestId: requestId('owner-read-pair'), workspaceId: alpha, taskRef, actor })).value
    const ownClaim = ledger.listClaims(actor, { workspaceId: alpha, taskRef }).claims
      .find(claim => claim.owner === actor.memberId)!
    committed((await ledger.changeClaim({ requestId: requestId('owner-release-pair'), workspaceId: alpha, taskRef,
      action: 'release', claimRef: ownClaim.claimRef, baseRevision: drained.readThroughSequence, actor })).value)
    expect(ownerRow().liveClaimOwners).toEqual([{ memberId: second.memberId, name: second.handle }])
  })

  it('a taskless Thread names no owners at all', async () => {
    const { ledger, actor } = await seededThread()
    const projectRef = ledger.inbox(actor, { workspaceId: alpha }).items[0]!.projectRef
    // The claimant opens a discussion of its own — writing a Thread's anchor is
    // what follows it — and the Human's answer is what puts that Thread in the
    // claimant's own Inbox.
    await ledger.addProjectOwner({ requestId: requestId('taskless-owner'), actor: agentTeamHumanActor(), workspaceId: alpha, projectRef, memberId: actor.memberId })
    const started = committed((await ledger.startThread({ requestId: requestId('taskless'), workspaceId: alpha, projectRef,
      kind: 'discussion', body: 'A discussion nobody claimed', actor })).value)
    committed((await ledger.reply({ requestId: requestId('taskless-reply'), workspaceId: alpha, threadRef: started.thread.threadRef,
      body: 'An answer', baseRevision: started.thread.revision, actor: agentTeamHumanActor() })).value)
    const items = ledger.inbox(actor, { workspaceId: alpha }).items
    expect(items).toHaveLength(2)
    const taskless = items.find(item => item.thread.threadRef === started.thread.threadRef)!
    expect(taskless.task).toBeUndefined()
    expect(taskless.liveClaimOwners).toEqual([])
  })

  it('view lastActivityAt is the tail fact instant of each Thread', async () => {
    const { ledger, actor } = await seededThread()
    // The view runs on the ledger that owns the projection state — the one
    // that committed the seeded operations.
    const view = ledger.view({ workspaceId: alpha, topLevelOnly: true, includeActivities: false, direction: 'before' }, actor.memberId)
    expect(view.items.length).toBeGreaterThan(0)
    for (const item of view.items) {
      const facts = (ledger as unknown as { state: { factsByThread: Map<string, readonly { occurredAt: string }[]> } }).state.factsByThread.get(item.thread.threadRef)!
      expect(item.lastActivityAt).toBe(facts.at(-1)!.occurredAt)
    }
  })
})

describe('the render layer converts fixed UTC+8 deterministically', () => {
  it('the shared formatter maps the ledger instant to the coordination zone', async () => {
    const { ledger, actor, taskRef } = await seededThread()
    const read = (await ledger.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef, actor })).value
    const fact = read.facts[0]!
    expect(formatTeamTimestamp(fact.fact.occurredAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/u)
  })
})

describe('DM relay history carries the prior instant', () => {
  it('dmHistoryBetween cites the prior DM with its committed instant', async () => {
    const { ledger, actor } = await seededThread()
    const { member: second } = await addLedgerMember(ledger, undefined, 'member:agent-dm-partner')
    const first = (await ledger.sendDm({ requestId: requestId('dm-one'), workspaceId: alpha, actor,
      recipientMemberId: second.memberId, body: 'first DM body' })).value
    const history = ledger.dmHistoryBetween(SessionId(`session:${actor.memberId}`), second.memberId)
    expect(history).toContain('them → you')
    expect(history).toContain('first DM body')
    expect(history).toContain(formatTeamTimestamp(first.receipt.occurredAt))
  })
})
