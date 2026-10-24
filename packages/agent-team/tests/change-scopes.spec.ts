import { changeBaseline, nextChange } from './helpers/change-stream.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { provideQuietTokenMeter } from './helpers/team-host-fixture.ts'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID, agentTeamDomainSpec } from '../src/index.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { AgentTeamChangeScope, AgentTeamProjectRef, AgentTeamMemberActor, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTaskRef, AgentTeamThreadRef } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness(): Promise<{ readonly ctx: Context; readonly facility: DomainFacility }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
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
  return { ctx, facility }
}

function ledgerAtBoot(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

async function commitMemberRecordDirectlyOnLedger(ledger: AgentTeamLedger, projectRef: AgentTeamProjectRef): Promise<AgentTeamMemberActor> {
  const memberId = `member:agent-${crypto.randomUUID()}` as AgentTeamMemberActor['memberId']
  const handle = 'reader'
  await ledger.addMember({
    requestId: requestId(`ledger-member-${memberId}`), workspaceId: alpha, handle, description: 'Reads work', presetId: 'team-member',
    projectRefs: [projectRef], actor: agentTeamHumanActor(),
    member: {
      memberId, sessionId: SessionId(`session:${memberId}`), workspaceId: alpha, handle, description: 'Reads work',
      presetId: 'team-member', privateMemoryPath: '/tmp/reader', state: 'enabled' as const,
    },
  })
  return { kind: 'member', memberId, handle }
}

/**
 * One Team service plus its storage pool, exposed so a test can dispose the
 * service and boot a second one over the same durable records.
 */
async function restartHarness(pool: MemoryMediaPool): Promise<{ readonly ctx: Context; readonly facility: DomainFacility; readonly fiber: { dispose: () => Promise<void> } }> {
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
  return { ctx, facility, fiber }
}

/** Resolve only after a macrotask so a premature wake-up cannot hide behind microtasks. */
async function staysPendingAcrossMacrotask(promise: Promise<unknown>, ms = 15): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, ms))
  return !settled
}

async function startThread(ctx: Context, label: string): Promise<{ readonly threadRef: AgentTeamThreadRef; readonly taskRef: AgentTeamTaskRef; readonly projectRef: AgentTeamProjectRef; readonly revision: number }> {
  const project = await ctx.agentTeam.createProject({ requestId: requestId(`project-${label}`), workspaceId: alpha, name: label, description: `${label} work` })
  const started = await ctx.agentTeam.startThread({ kind: 'task', requestId: requestId(`start-${label}`), workspaceId: alpha, projectRef: project.project.projectRef, body: `Task ${label}` })
  if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
  return { threadRef: started.thread.threadRef, taskRef: started.task!.taskRef, projectRef: project.project.projectRef, revision: started.thread.revision }
}

describe('scoped Team change notifications', () => {
  it('derives member-workspace join/leave scopes and affected members', async () => {
    const { ctx, facility } = await harness()
    const thread = await startThread(ctx, 'derive-participation')
    const ledger = ledgerAtBoot(facility)
    const actor = await commitMemberRecordDirectlyOnLedger(ledger, thread.projectRef)
    const joinRequest = { requestId: requestId('derive-join'), workspaceId: beta,
      memberId: actor.memberId, actor: agentTeamHumanActor() }
    const joined = await ledger.joinWorkspace(joinRequest)
    expect(joined.committed).toBe(true)
    const joinOperation = ledger.getOperation(joined.value.receipt.operationId)
    expect(joinOperation).toBeDefined()
    expect(ledger.changeScopesOf(joinOperation!)).toEqual([{ kind: 'workspace', workspaceId: beta }])
    expect(ledger.affectedMembersOf(joinOperation!)).toEqual([actor.memberId])
    const left = await ledger.leaveWorkspace({ requestId: requestId('derive-leave'), workspaceId: beta,
      memberId: actor.memberId, actor: agentTeamHumanActor() })
    expect(left.committed).toBe(true)
    const leaveOperation = ledger.getOperation(left.value.receipt.operationId)
    expect(leaveOperation).toBeDefined()
    expect(ledger.changeScopesOf(leaveOperation!)).toEqual([{ kind: 'workspace', workspaceId: beta }])
    expect(ledger.affectedMembersOf(leaveOperation!)).toEqual([actor.memberId])
  })

  it('does not wake or advance any waiter when a Human Thread read makes no progress', async () => {
    const { ctx } = await harness()
    const thread = await startThread(ctx, 'read-scope')
    const baseline = await changeBaseline(ctx.agentTeam)
    const threadWaiter = nextChange(ctx.agentTeam, { kind: 'thread', threadRef: thread.threadRef })
    const globalWaiter = nextChange(ctx.agentTeam)
    expect(await staysPendingAcrossMacrotask(threadWaiter)).toBe(true)
    expect(await staysPendingAcrossMacrotask(globalWaiter)).toBe(true)

    await ctx.agentTeam.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: thread.taskRef })

    // Nothing was unread for the reader, so the read writes no operation and
    // publishes no new version: no parked waiter can mistake it for a change.
    const after = await changeBaseline(ctx.agentTeam)
    expect(after.version).toBe(baseline.version)
    expect(await staysPendingAcrossMacrotask(threadWaiter)).toBe(true)
    expect(await staysPendingAcrossMacrotask(globalWaiter)).toBe(true)

    // A real content change on the same Thread still wakes both, at the
    // durable position of the commit itself.
    const reply = await ctx.agentTeam.reply({ requestId: requestId('reply'), workspaceId: alpha, taskRef: thread.taskRef, body: 'Update', baseRevision: thread.revision })
    if (reply.kind !== 'committed') throw new Error(`expected committed reply, received ${reply.kind}`)
    expect(await threadWaiter).toMatchObject({ version: reply.receipt.sequence })
    expect(await globalWaiter).toMatchObject({ version: reply.receipt.sequence })
  })

  it('wakes a Thread waiter only for changes of that Thread', async () => {
    const { ctx } = await harness()
    const first = await startThread(ctx, 'alpha-thread')
    const second = await startThread(ctx, 'beta-thread')
    const firstWaiter = nextChange(ctx.agentTeam, { kind: 'thread', threadRef: first.threadRef })
    expect(await staysPendingAcrossMacrotask(firstWaiter)).toBe(true)

    await ctx.agentTeam.reply({ requestId: requestId('other-reply'), workspaceId: alpha, taskRef: second.taskRef, body: 'Unrelated', baseRevision: second.revision })
    expect(await staysPendingAcrossMacrotask(firstWaiter)).toBe(true)

    const own = await ctx.agentTeam.reply({ requestId: requestId('own-reply'), workspaceId: alpha, taskRef: first.taskRef, body: 'Related', baseRevision: first.revision })
    if (own.kind !== 'committed') throw new Error(`expected committed reply, received ${own.kind}`)
    expect(await firstWaiter).toMatchObject({ version: own.receipt.sequence })
  })

  it('wakes Project and Workspace waiters through their own scopes', async () => {
    const { ctx } = await harness()
    const thread = await startThread(ctx, 'mixed')
    const baseline = await changeBaseline(ctx.agentTeam)
    const projectWaiter = nextChange(ctx.agentTeam, { kind: 'project', projectRef: thread.projectRef })
    const workspaceWaiter = nextChange(ctx.agentTeam, { kind: 'workspace', workspaceId: alpha })
    expect(await staysPendingAcrossMacrotask(projectWaiter)).toBe(true)
    expect(await staysPendingAcrossMacrotask(workspaceWaiter)).toBe(true)

    await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: alpha, handle: 'scout', description: 'Scouts work', presetId: 'team-member', projectRefs: [thread.projectRef] })
    // Member lifecycle is workspace-scoped: the workspace waiter wakes, the
    // Project content waiter stays parked until Project data changes.
    expect(await workspaceWaiter).toMatchObject({ version: expect.any(Number) })
    expect(await staysPendingAcrossMacrotask(projectWaiter)).toBe(true)

    await ctx.agentTeam.reply({ requestId: requestId('project-reply'), workspaceId: alpha, taskRef: thread.taskRef, body: 'Content', baseRevision: thread.revision })
    const woken = await projectWaiter
    expect(woken.version).toBeGreaterThan(baseline.version)
  })

  it('rejects an aborted waiter and keeps later commits working', async () => {
    const { ctx } = await harness()
    const thread = await startThread(ctx, 'abort')
    const controller = new AbortController()
    const aborted = nextChange(ctx.agentTeam, { kind: 'thread', threadRef: thread.threadRef }, controller.signal)
    const survivor = nextChange(ctx.agentTeam)
    controller.abort()
    await expect(aborted).rejects.toThrow(/aborted/)

    const afterAbort = await ctx.agentTeam.reply({ requestId: requestId('after-abort'), workspaceId: alpha, taskRef: thread.taskRef, body: 'Still works', baseRevision: thread.revision })
    if (afterAbort.kind !== 'committed') throw new Error(`expected committed reply, received ${afterAbort.kind}`)
    expect(await survivor).toMatchObject({ version: afterAbort.receipt.sequence })
  })

  it('re-derives the projection cursor from the durable records across a restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await restartHarness(pool)
    const thread = await startThread(first.ctx, 'cursor-restart')

    // A Member record and its reply land outside the service (the bare harness
    // has no live Agent): both are shared-projection commits, and the reply
    // leaves the Human's own Thread unread.
    const ledger = ledgerAtBoot(first.facility)
    const actor = await commitMemberRecordDirectlyOnLedger(ledger, thread.projectRef)
    const reply = (await ledger.reply({ requestId: requestId('restart-reply'), workspaceId: alpha, taskRef: thread.taskRef,
      body: 'Member work', baseRevision: thread.revision, actor })).value
    if (reply.kind !== 'committed') throw new Error(`expected committed member reply, received ${reply.kind}`)
    await first.fiber.dispose()

    // The Human's read through the service really commits (there is something
    // unread) and yet moves no cursor: it is private read progress.
    const second = await restartHarness(pool)
    expect((await changeBaseline(second.ctx.agentTeam)).version).toBe(reply.receipt.sequence)
    const read = await second.ctx.agentTeam.readThread({ requestId: requestId('restart-read'), workspaceId: alpha, taskRef: thread.taskRef })
    expect(read.receipt).toBeDefined()
    expect((await changeBaseline(second.ctx.agentTeam)).version).toBe(reply.receipt.sequence)
    await second.fiber.dispose()

    // A further restart re-derives the same position from the records: neither
    // zero (a process counter) nor the record count (which the private read
    // advanced). A Client that parked before it is not answered by the restart.
    const third = await restartHarness(pool)
    const after = (await changeBaseline(third.ctx.agentTeam)).version
    expect(after).toBe(reply.receipt.sequence)
    const parked = nextChange(third.ctx.agentTeam)
    expect(await staysPendingAcrossMacrotask(parked)).toBe(true)

    const update = await third.ctx.agentTeam.reply({ requestId: requestId('restart-update'), workspaceId: alpha, taskRef: thread.taskRef,
      body: 'After restart', baseRevision: reply.thread.revision })
    if (update.kind !== 'committed') throw new Error(`expected committed reply, received ${update.kind}`)
    expect(await parked).toMatchObject({ version: update.receipt.sequence })
  })

  it('streams the opening version immediately and later commits without polling', async () => {
    const { ctx } = await harness()
    const thread = await startThread(ctx, 'stream-opening')
    const controller = new AbortController()
    const stream = ctx.agentTeam.changes({ scope: { kind: 'thread', threadRef: thread.threadRef } }, controller.signal)
    const iterator = stream[Symbol.asyncIterator]()
    try {
      const opening = await iterator.next()
      expect(opening).toMatchObject({ done: false, value: { version: expect.any(Number) } })
      const reply = await ctx.agentTeam.reply({ requestId: requestId('stream-reply'), workspaceId: alpha, taskRef: thread.taskRef, body: 'Streamed', baseRevision: thread.revision })
      if (reply.kind !== 'committed') throw new Error(`expected committed reply, received ${reply.kind}`)
      expect(await iterator.next()).toMatchObject({ done: false, value: { version: reply.receipt.sequence } })
    } finally {
      controller.abort()
      await iterator.return?.()
    }
  })

  it('coalesces commits while the consumer pauses and cancels a pending pull', async () => {
    const { ctx } = await harness()
    const thread = await startThread(ctx, 'coalescing')
    const controller = new AbortController()
    const iterator = ctx.agentTeam.changes({}, controller.signal)[Symbol.asyncIterator]()
    await iterator.next()
    let revision = thread.revision
    let sequence = 0
    for (let index = 0; index < 5; index++) {
      const reply = await ctx.agentTeam.reply({ requestId: requestId(`coalesce-${index}`), workspaceId: alpha, taskRef: thread.taskRef, body: `Reply ${index}`, baseRevision: revision })
      if (reply.kind !== 'committed') throw new Error('expected reply')
      revision = reply.thread.revision
      sequence = reply.receipt.sequence
    }
    expect(await iterator.next()).toMatchObject({ done: false, value: { version: sequence } })
    const pending = iterator.next()
    expect(await staysPendingAcrossMacrotask(pending)).toBe(true)
    controller.abort()
    expect(await pending).toMatchObject({ done: true })
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  it('does not open an already canceled stream and closes live streams on Host disposal', async () => {
    const { ctx, fiber } = await restartHarness(new MemoryMediaPool())
    const canceled = ctx.agentTeam.changes({}, AbortSignal.abort())[Symbol.asyncIterator]()
    expect(await canceled.next()).toMatchObject({ done: true })
    const live = ctx.agentTeam.changes({})[Symbol.asyncIterator]()
    await live.next()
    const pending = live.next()
    await fiber.dispose()
    expect(await pending).toMatchObject({ done: true })
  })

  it('validates change scopes before parking', async () => {
    const { ctx } = await harness()
    await expect(changeBaseline(ctx.agentTeam, { kind: 'project', projectRef: '' } as unknown as AgentTeamChangeScope)).rejects.toThrow(/non-empty ref/)
  })
})

describe('ledger change scope and affected member derivation', () => {
  it('derives empty scopes for reads and precise scopes plus members for replies', async () => {
    const { ctx, facility } = await harness()
    const thread = await startThread(ctx, 'derive')
    // Replay after every commit so the derived indexes include all operations.
    const ledger = ledgerAtBoot(facility)
    const actor = await commitMemberRecordDirectlyOnLedger(ledger, thread.projectRef)
    // The member's reply is unread for the Human who follows their own Thread,
    // so the Human's read below has a watermark to advance and commits.
    const memberReply = (await ledger.reply({ requestId: requestId('derive-member-reply'), workspaceId: alpha, taskRef: thread.taskRef,
      body: 'Unread work', baseRevision: thread.revision, actor })).value
    if (memberReply.kind !== 'committed') throw new Error(`expected committed member reply, received ${memberReply.kind}`)
    const recordsBeforeRead = ledger.status().sequence
    const positionBeforeRead = ledger.projectionSequence()
    expect(positionBeforeRead).toBe(memberReply.receipt.sequence)
    const read = await ledger.readThread({ requestId: requestId('derive-read'), workspaceId: alpha, taskRef: thread.taskRef, actor: agentTeamHumanActor() })
    if (!read.committed) throw new Error('expected a committed Thread read')

    // A committed private read appends a durable record and still moves the
    // shared-projection position nowhere: no waiter can mistake it for news.
    expect(ledger.status().sequence).toBe(recordsBeforeRead + 1)
    expect(ledger.projectionSequence()).toBe(positionBeforeRead)

    const reply = (await ledger.reply({ requestId: requestId('derive-reply'), workspaceId: alpha, taskRef: thread.taskRef,
      body: 'Derived', baseRevision: memberReply.thread.revision, actor: agentTeamHumanActor() })).value
    if (reply.kind !== 'committed') throw new Error(`expected committed reply, received ${reply.kind}`)
    expect(ledger.projectionSequence()).toBe(reply.receipt.sequence)

    const readOperation = ledger.getOperation(read.value.receipt.operationId)
    expect(readOperation).toBeDefined()
    expect(ledger.changeScopesOf(readOperation!)).toEqual([])

    const replyOperation = ledger.getOperation(reply.receipt.operationId)
    expect(replyOperation).toBeDefined()
    expect(ledger.changeScopesOf(replyOperation!)).toEqual([
      { kind: 'project', projectRef: thread.projectRef },
      { kind: 'thread', threadRef: thread.threadRef },
    ])
    // The Human sender has no live handle, and the member never followed the
    // Thread — replying does not enroll a follower.
    expect(ledger.affectedMembersOf(replyOperation!)).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])
  })

  it('derives follower membership from Attention state on an isolated ledger', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    cleanups.push(async () => { await facility.closeAll() })
    const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
    const ledger = new AgentTeamLedger(domain.table('operations'))
    await ledger.initialize()

    const created = (await ledger.createProject({
      requestId: requestId('iso-project'), workspaceId: alpha, name: 'isolated', description: 'Isolated work',
      memberIds: [], actor: agentTeamHumanActor(),
    })).value
    const started = (await ledger.startThread({ kind: 'task',
      requestId: requestId('iso-start'), workspaceId: alpha, projectRef: created.project.projectRef, body: 'Task', actor: agentTeamHumanActor(),
    }))
    if (started.value.kind !== 'committed') throw new Error('expected committed start')
    const memberId = `member:agent-${crypto.randomUUID()}` as AgentTeamMemberActor['memberId']
    await ledger.addMember({
      requestId: requestId('iso-member'), workspaceId: alpha, handle: 'follower', description: 'Follows work', presetId: 'team-member',
      projectRefs: [created.project.projectRef], actor: agentTeamHumanActor(),
      member: {
        memberId, sessionId: SessionId(`session:${memberId}`), workspaceId: alpha, handle: 'follower',
        description: 'Follows work', presetId: 'team-member', privateMemoryPath: '/tmp/follower', state: 'enabled' as const,
      },
    })
    await ledger.changeAttention({ requestId: requestId('iso-follow'), workspaceId: alpha, taskRef: started.value.task!.taskRef, action: 'follow', actor: { kind: 'member', memberId, handle: 'follower' } })

    const committed = started.value
    const reply = (await ledger.reply({
      requestId: requestId('iso-reply'), workspaceId: alpha, taskRef: committed.task!.taskRef, body: 'Wake the follower',
      baseRevision: committed.thread.revision, actor: agentTeamHumanActor(),
    })).value
    if (reply.kind !== 'committed') throw new Error(`expected committed reply, received ${reply.kind}`)
    const operation = ledger.getOperation(reply.receipt.operationId)
    expect(operation).toBeDefined()
    // The follower via Attention, plus the Human who follows their own Task.
    const affected = ledger.affectedMembersOf(operation!)
    expect(affected).toHaveLength(2)
    expect(affected).toContain(memberId)
    expect(affected).toContain(AGENT_TEAM_HUMAN_MEMBER_ID)
  })
})
