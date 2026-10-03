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
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID, agentTeamDomainSpec } from '../src/index.ts'
import { AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import * as agentTeamInvariant from '../src/invariant.ts'
import type { AgentTeamChangeScope, AgentTeamChannelRef, AgentTeamMemberActor, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTaskRef, AgentTeamThreadRef } from '../src/types.ts'

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
  await ctx.plugin(agentTeamInvariant)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx, facility }
}

function replayLedger(facility: DomainFacility): AgentTeamLedger {
  return new AgentTeamLedger(facility.get('agent_team')!.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>)
}

/** Durable Member record plus its actor, for commits the service cannot make without a live Agent. */
async function addLedgerMember(ledger: AgentTeamLedger, channelRef: AgentTeamChannelRef): Promise<AgentTeamMemberActor> {
  const memberId = `member:agent-${crypto.randomUUID()}` as AgentTeamMemberActor['memberId']
  const handle = 'reader'
  await ledger.addMember({
    requestId: requestId(`ledger-member-${memberId}`), workspaceId: alpha, handle, description: 'Reads work', presetId: 'team-member',
    channelRefs: [channelRef], actor: agentTeamHumanActor(),
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
  await ctx.plugin(agentTeamInvariant)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(AgentTeam)
  cleanups.push(async () => { await fiber.dispose(); await facility.closeAll() })
  return { ctx, facility, fiber }
}

/** Resolve only after a macrotask so a premature wake-up cannot hide behind microtasks. */
async function staysPending(promise: Promise<unknown>, ms = 15): Promise<boolean> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, ms))
  return !settled
}

async function startThread(ctx: Context, label: string): Promise<{ readonly threadRef: AgentTeamThreadRef; readonly taskRef: AgentTeamTaskRef; readonly channelRef: AgentTeamChannelRef; readonly revision: number }> {
  const channel = await ctx.agentTeam.createChannel({ requestId: requestId(`channel-${label}`), workspaceId: alpha, name: label, description: `${label} work` })
  const started = await ctx.agentTeam.sendMessage({ asTask: true, requestId: requestId(`start-${label}`), workspaceId: alpha, channelRef: channel.channel.channelRef, body: `Task ${label}` })
  if (started.kind !== 'committed') throw new Error(`expected committed start, received ${started.kind}`)
  return { threadRef: started.thread.threadRef, taskRef: started.task!.taskRef, channelRef: channel.channel.channelRef, revision: started.thread.revision }
}

describe('scoped Team change notifications', () => {
  it('derives member-workspace join/leave scopes and affected members', async () => {
    const { ctx, facility } = await harness()
    const thread = await startThread(ctx, 'derive-participation')
    const ledger = replayLedger(facility)
    const actor = await addLedgerMember(ledger, thread.channelRef)
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
    expect(await staysPending(threadWaiter)).toBe(true)
    expect(await staysPending(globalWaiter)).toBe(true)

    await ctx.agentTeam.readThread({ requestId: requestId('read'), workspaceId: alpha, taskRef: thread.taskRef })

    // Nothing was unread for the reader, so the read writes no operation and
    // publishes no new version: no parked waiter can mistake it for a change.
    const after = await changeBaseline(ctx.agentTeam)
    expect(after.version).toBe(baseline.version)
    expect(await staysPending(threadWaiter)).toBe(true)
    expect(await staysPending(globalWaiter)).toBe(true)

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
    expect(await staysPending(firstWaiter)).toBe(true)

    await ctx.agentTeam.reply({ requestId: requestId('other-reply'), workspaceId: alpha, taskRef: second.taskRef, body: 'Unrelated', baseRevision: second.revision })
    expect(await staysPending(firstWaiter)).toBe(true)

    const own = await ctx.agentTeam.reply({ requestId: requestId('own-reply'), workspaceId: alpha, taskRef: first.taskRef, body: 'Related', baseRevision: first.revision })
    if (own.kind !== 'committed') throw new Error(`expected committed reply, received ${own.kind}`)
    expect(await firstWaiter).toMatchObject({ version: own.receipt.sequence })
  })

  it('wakes Channel and Workspace waiters through their own scopes', async () => {
    const { ctx } = await harness()
    const thread = await startThread(ctx, 'mixed')
    const baseline = await changeBaseline(ctx.agentTeam)
    const channelWaiter = nextChange(ctx.agentTeam, { kind: 'channel', channelRef: thread.channelRef })
    const workspaceWaiter = nextChange(ctx.agentTeam, { kind: 'workspace', workspaceId: alpha })
    expect(await staysPending(channelWaiter)).toBe(true)
    expect(await staysPending(workspaceWaiter)).toBe(true)

    await ctx.agentTeam.addMember({ requestId: requestId('member'), workspaceId: alpha, handle: 'scout', description: 'Scouts work', presetId: 'team-member', channelRefs: [thread.channelRef] })
    // Member lifecycle is workspace-scoped: the workspace waiter wakes, the
    // Channel content waiter stays parked until Channel data changes.
    expect(await workspaceWaiter).toMatchObject({ version: expect.any(Number) })
    expect(await staysPending(channelWaiter)).toBe(true)

    await ctx.agentTeam.reply({ requestId: requestId('channel-reply'), workspaceId: alpha, taskRef: thread.taskRef, body: 'Content', baseRevision: thread.revision })
    const woken = await channelWaiter
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
    const ledger = replayLedger(first.facility)
    const actor = await addLedgerMember(ledger, thread.channelRef)
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
    expect(await staysPending(parked)).toBe(true)

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
    expect(await staysPending(pending)).toBe(true)
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
    await expect(changeBaseline(ctx.agentTeam, { kind: 'channel', channelRef: '' } as unknown as AgentTeamChangeScope)).rejects.toThrow(/non-empty ref/)
  })
})

describe('ledger change scope and affected member derivation', () => {
  it('derives empty scopes for reads and precise scopes plus members for replies', async () => {
    const { ctx, facility } = await harness()
    const thread = await startThread(ctx, 'derive')
    // Replay after every commit so the derived indexes include all operations.
    const ledger = replayLedger(facility)
    const actor = await addLedgerMember(ledger, thread.channelRef)
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
      { kind: 'channel', channelRef: thread.channelRef },
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

    const created = (await ledger.createChannel({
      requestId: requestId('iso-channel'), workspaceId: alpha, name: 'isolated', description: 'Isolated work',
      memberIds: [], actor: agentTeamHumanActor(),
    })).value
    const started = (await ledger.sendMessage({ asTask: true,
      requestId: requestId('iso-start'), workspaceId: alpha, channelRef: created.channel.channelRef, body: 'Task', actor: agentTeamHumanActor(),
    }))
    if (started.value.kind !== 'committed') throw new Error('expected committed start')
    const memberId = `member:agent-${crypto.randomUUID()}` as AgentTeamMemberActor['memberId']
    await ledger.addMember({
      requestId: requestId('iso-member'), workspaceId: alpha, handle: 'follower', description: 'Follows work', presetId: 'team-member',
      channelRefs: [created.channel.channelRef], actor: agentTeamHumanActor(),
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
