import { afterEach, describe, expect, it, vi } from 'vitest'
// Booting a real Storage-backed Host per test has reached 3.2s on the windows
// lane (worst of 11 CI runs, 2026-09-17..21) against vitest's 5s default, so the
// file keeps headroom rather than betting on runner throughput.
vi.setConfig({ testTimeout: 30_000 })
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type { AgentTeamChannelRef, AgentTeamClaimRef, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamOperation, AgentTeamOperationId, AgentTeamRequestId, AgentTeamTaskRef, AgentTeamThreadRef } from '../src/types.ts'

/**
 * Issue #21: the read projections must keep byte-identical semantics while
 * the Host replaces full-table scans with replay-derived indexes. This suite
 * builds one large ledger (100+ Threads/facts), pins the projection values,
 * and cross-checks every read against an independent replay of the same
 * operation table — the replay rebuilds the indexes through `applyTo` alone,
 * so any drift between the live indexes and the replay-derived ones fails.
 */

const cleanups: Array<() => Promise<void>> = []
const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const human = agentTeamHumanActor()

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function openLedger(): Promise<{ readonly ledger: AgentTeamLedger; readonly table: KvTable<AgentTeamOperationId, AgentTeamOperation> }> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  const table = domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
  return { ledger: new AgentTeamLedger(table), table }
}

function memberActor(memberId: string, handle: string): AgentTeamMemberActor {
  return { kind: 'member', memberId: memberId as AgentTeamMemberId, handle }
}

describe('large-ledger projection equivalence (issue #21)', () => {
  it('keeps inbox, view, taskNumbers and observations identical on a 100+ fact ledger and across replay', async () => {
    const { ledger, table } = await openLedger()
    await ledger.initialize()

    const channelA = (await ledger.createChannel({ requestId: requestId('channel-a'), workspaceId: alpha, name: 'alpha-one', description: 'Alpha one', memberIds: [], actor: human })).value.channel
    const channelB = (await ledger.createChannel({ requestId: requestId('channel-b'), workspaceId: alpha, name: 'alpha-two', description: 'Alpha two', memberIds: [], actor: human })).value.channel
    const channelC = (await ledger.createChannel({ requestId: requestId('channel-c'), workspaceId: beta, name: 'beta-one', description: 'Beta one', memberIds: [], actor: human })).value.channel

    const agentA = 'member:agent-a' as AgentTeamMemberId
    const agentB = 'member:agent-b' as AgentTeamMemberId
    const agentC = 'member:agent-c' as AgentTeamMemberId
    const agentMember = (memberId: string, handle: string, workspaceId: typeof alpha | typeof beta) => ({
      memberId: memberId as AgentTeamMemberId, sessionId: SessionId(`session:${memberId}`), workspaceId, handle,
      description: `${handle} description`, presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled' as const,
    })
    await ledger.addMember({ requestId: requestId('member-a'), workspaceId: alpha, handle: 'scout', description: 'Scout work', presetId: 'team-member', channelRefs: [channelA.channelRef], actor: human, member: agentMember(agentA, 'scout', alpha) })
    await ledger.addMember({ requestId: requestId('member-b'), workspaceId: alpha, handle: 'planner', description: 'Planner work', presetId: 'team-member', channelRefs: [channelA.channelRef, channelB.channelRef], actor: human, member: agentMember(agentB, 'planner', alpha) })
    await ledger.addMember({ requestId: requestId('member-c'), workspaceId: beta, handle: 'builder', description: 'Builder work', presetId: 'team-member', channelRefs: [channelC.channelRef], actor: human, member: agentMember(agentC, 'builder', beta) })

    interface StartedThread {
      readonly label: string
      readonly channelRef: AgentTeamChannelRef
      readonly workspaceId: typeof alpha | typeof beta
      readonly taskRef: AgentTeamTaskRef
      readonly threadRef: AgentTeamThreadRef
      revision: number
      /** Display ordinal inside its home Channel, in creation order. */
      readonly taskNumber: number
      /** Message refs in ledger order, anchors and replies alike. */
      readonly messageRefs: string[]
      /** Sequence of every fact of the Thread, anchors and replies alike. */
      readonly factSequences: number[]
    }
    const threads: StartedThread[] = []
    const byLabel = new Map<string, StartedThread>()
    /** Every Message fact in true ledger order — anchors first, replies later. */
    const factOrder: { readonly channelRef: AgentTeamChannelRef; readonly messageRef: string }[] = []

    const startThread = async (label: string, channel: AgentTeamChannelRef, workspaceId: typeof alpha | typeof beta): Promise<StartedThread> => {
      const started = await ledger.sendMessage({ asTask: true, requestId: requestId(`start-${label}`), workspaceId, channelRef: channel, body: `Task ${label}\nsecond line`, actor: human })
      if (started.value.kind !== 'committed') throw new Error(`expected committed start for ${label}`)
      const entry: StartedThread = {
        label, channelRef: channel, workspaceId, taskRef: started.value.task!.taskRef, threadRef: started.value.thread.threadRef,
        revision: started.value.thread.revision, taskNumber: threads.filter(thread => thread.channelRef === channel).length + 1,
        messageRefs: [started.value.message.messageRef], factSequences: [started.value.message.sequence],
      }
      threads.push(entry)
      byLabel.set(label, entry)
      factOrder.push({ channelRef: channel, messageRef: started.value.message.messageRef })
      return entry
    }
    const reply = async (label: string, body: string, actor: typeof human | AgentTeamMemberActor, recipients?: readonly AgentTeamMemberId[]): Promise<void> => {
      const thread = byLabel.get(label)!
      const replied = await ledger.reply({ requestId: requestId(`reply-${label}-${body}`), workspaceId: thread.workspaceId, taskRef: thread.taskRef, body, baseRevision: thread.revision, actor, ...(recipients === undefined ? {} : { recipients }) })
      if (replied.value.kind !== 'committed') throw new Error(`expected committed reply on ${label}: ${replied.value.kind}`)
      thread.revision = replied.value.thread.revision
      thread.messageRefs.push(replied.value.message.messageRef)
      thread.factSequences.push(replied.value.message.sequence)
      factOrder.push({ channelRef: thread.channelRef, messageRef: replied.value.message.messageRef })
    }
    const follow = async (label: string, actor: typeof human | AgentTeamMemberActor, action: 'follow' | 'unfollow'): Promise<void> => {
      const thread = byLabel.get(label)!
      const changed = await ledger.changeAttention({ requestId: requestId(`${action}-${label}-${actor.memberId}`), workspaceId: thread.workspaceId, taskRef: thread.taskRef, action, actor })
      if (changed.committed !== true) throw new Error(`expected committed ${action} on ${label}`)
    }

    for (let index = 0; index < 30; index += 1) await startThread(`a${index}`, channelA.channelRef, alpha)
    for (let index = 0; index < 25; index += 1) await startThread(`b${index}`, channelB.channelRef, alpha)
    for (let index = 0; index < 20; index += 1) await startThread(`c${index}`, channelC.channelRef, beta)

    // Follows first, so later replies and mentions ride them.
    await follow('a0', memberActor(agentA, 'scout'), 'follow')
    await follow('a0', memberActor(agentB, 'planner'), 'follow')
    for (const label of ['a1', 'a2', 'a3', 'a4']) await follow(label, memberActor(agentB, 'planner'), 'follow')
    for (const label of ['a5', 'a6', 'a7', 'a8', 'a9']) await follow(label, memberActor(agentA, 'scout'), 'follow')

    // Replies: 3 per leading alpha Thread, plus the beta tail. agentB sends
    // the a-Thread replies, so its own followed Threads (a0..a4) stay
    // unread-free while agentA's follow on a0 accumulates unread.
    for (let index = 0; index < 10; index += 1) for (let round = 0; round < 3; round += 1) await reply(`a${index}`, `agent progress ${round}`, memberActor(agentB, 'planner'))
    for (let index = 0; index < 8; index += 1) for (let round = 0; round < 2; round += 1) await reply(`b${index}`, `human progress ${round}`, human)
    for (let index = 0; index < 5; index += 1) await reply(`c${index}`, 'beta progress', memberActor(agentC, 'builder'))
    // Thread starters follow their own Thread: the Human must catch up on a2
    // before the deferred-write gate lets them reply again.
    await ledger.readThread({ requestId: requestId('read-a2'), workspaceId: alpha, taskRef: byLabel.get('a2')!.taskRef, actor: human })
    await reply('a2', 'plain human update', human)

    // Mentions: the Human mentions the following scout (direct markers for
    // agentA), and planner mentions the Human on the b-Threads (direct
    // markers for the Human — the cross-member mention path). The Human
    // catches up on each mentioned Thread first: the deferred-write gate
    // refuses replies while the sender still holds unread.
    for (const label of ['a5', 'a6', 'a7', 'a8', 'a9']) await ledger.readThread({ requestId: requestId(`read-${label}`), workspaceId: alpha, taskRef: byLabel.get(label)!.taskRef, actor: human })
    for (const label of ['a5', 'a6', 'a7', 'a8', 'a9']) await reply(label, 'scout, please look', human, [agentA])
    for (const label of ['b0', 'b1', 'b2', 'b3', 'b4']) await reply(label, 'noting the operator', memberActor(agentB, 'planner'), [AGENT_TEAM_HUMAN_MEMBER_ID])

    // A durable read consumes the Human's own markers on b0/b1 only.
    await ledger.readThread({ requestId: requestId('read-b0'), workspaceId: alpha, taskRef: byLabel.get('b0')!.taskRef, actor: human })
    await ledger.readThread({ requestId: requestId('read-b1'), workspaceId: alpha, taskRef: byLabel.get('b1')!.taskRef, actor: human })

    // One departure exercises Attention removal on a mentioned Thread: the
    // direct marker survives, the ordinary unread stops growing.
    await follow('a5', memberActor(agentA, 'scout'), 'unfollow')

    expect(threads).toHaveLength(75)
    expect(threads.reduce((sum, thread) => sum + thread.factSequences.length, 0)).toBeGreaterThanOrEqual(100)

    // ---- taskNumbers: per-Channel creation ordinals, workspace-filtered. ----
    const viewA = ledger.view({ workspaceId: alpha, channelRef: channelA.channelRef, limit: 1, includeCatalog: true })
    expect(viewA.taskNumbers).toEqual(threads.filter(thread => thread.channelRef === channelA.channelRef).map(thread => ({ taskRef: thread.taskRef, taskNumber: thread.taskNumber })))
    const viewB = ledger.view({ workspaceId: alpha, channelRef: channelB.channelRef, limit: 1, includeCatalog: true })
    expect(viewB.taskNumbers).toEqual(threads.filter(thread => thread.channelRef === channelB.channelRef).map(thread => ({ taskRef: thread.taskRef, taskNumber: thread.taskNumber })))
    const viewWhole = ledger.view({ workspaceId: alpha, limit: 1, includeCatalog: true })
    expect(viewWhole.taskNumbers).toHaveLength(55)
    // limit bounds only items; the catalog slices stay complete.
    expect(viewWhole.channels).toHaveLength(2)
    expect(viewWhole.threads).toHaveLength(55)

    // ---- view(): the walk from the matching end with an early hasMore. ----
    const channelAFacts = factOrder.filter(fact => fact.channelRef === channelA.channelRef).map(fact => fact.messageRef)
    // 30 anchors + 30 agent replies + 5 Human mention replies + 1 catch-up update.
    expect(channelAFacts).toHaveLength(66)
    const first = ledger.view({ workspaceId: alpha, channelRef: channelA.channelRef, limit: 1 })
    expect(first.items.map(item => item.message.messageRef)).toEqual([channelAFacts[0]])
    expect(first.hasMore).toBe(true)

    // The first fact already came back in `first`; the cursor pages continue
    // strictly after it and must rebuild the whole Channel timeline.
    const paged: string[] = first.items.map(item => item.message.messageRef)
    let cursor = first.cursor
    let hasMore = true
    let guard = 0
    while (hasMore && guard < 100) {
      guard += 1
      const page = ledger.view({ workspaceId: alpha, channelRef: channelA.channelRef, limit: 7, cursor })
      paged.push(...page.items.map(item => item.message.messageRef))
      hasMore = page.hasMore
      cursor = page.cursor
    }
    for (let index = 0; index < Math.max(paged.length, channelAFacts.length); index += 1) {
      if (paged[index] !== channelAFacts[index]) console.log('DIFF at', index, paged[index], channelAFacts[index])
    }
    expect(paged).toEqual(channelAFacts)
    expect(ledger.view({ workspaceId: alpha, channelRef: channelA.channelRef, limit: 66 }).hasMore).toBe(false)
    expect(ledger.view({ workspaceId: alpha, channelRef: channelA.channelRef, limit: 65 }).hasMore).toBe(true)
    // Reading backwards from the live tail returns the newest window, then
    // walks to the empty head where hasMore finally falls.
    const latest = ledger.view({ workspaceId: alpha, channelRef: channelA.channelRef, direction: 'before', limit: 20 })
    expect(latest.items.map(item => item.message.messageRef)).toEqual(channelAFacts.slice(-20))
    expect(latest.hasMore).toBe(true)
    const backwards: string[] = latest.items.map(item => item.message.messageRef)
    cursor = latest.cursor
    hasMore = true
    guard = 0
    while (hasMore && guard < 100) {
      guard += 1
      const page = ledger.view({ workspaceId: alpha, channelRef: channelA.channelRef, direction: 'before', limit: 7, cursor })
      backwards.unshift(...page.items.map(item => item.message.messageRef))
      hasMore = page.hasMore
      cursor = page.cursor
    }
    expect(backwards).toEqual(channelAFacts)
    // topLevelOnly keeps exactly the Thread anchors.
    const topLevel = ledger.view({ workspaceId: alpha, channelRef: channelA.channelRef, topLevelOnly: true, limit: 100 })
    expect(topLevel.items.map(item => item.message.messageRef)).toEqual(threads.filter(thread => thread.channelRef === channelA.channelRef).map(thread => thread.messageRefs[0]))

    // ---- inbox(): one unread slice per reader, mentions counted inside it. ----
    const humanInbox = ledger.inbox(human, { workspaceId: alpha, limit: 100 })
    // What the Human's own reads did not consume: the planner's mentions on
    // b2..b4 (markers, still unread) and the agent progress on a0/a1/a3/a4 —
    // the ordinary follow unread the mention-only slice used to hide. Mentions
    // sort first, each class newest unread first.
    const humanRows = ['b4', 'b3', 'b2', 'a4', 'a3', 'a1', 'a0']
    expect(humanInbox.items.map(item => item.thread.threadRef)).toEqual(humanRows.map(label => byLabel.get(label)!.threadRef))
    expect(humanInbox.totalUnreadCount).toBe(15)
    expect(humanInbox.totalDirectCount).toBe(3)
    for (const item of humanInbox.items) {
      const source = threads.find(thread => thread.threadRef === item.thread.threadRef)!
      const mentioned = ['b2', 'b3', 'b4'].includes(source.label)
      expect(item).toMatchObject(mentioned ? { unreadCount: 1, directCount: 1 } : { unreadCount: 3, directCount: 0 })
      expect(item.channelName).toBe(mentioned ? 'alpha-two' : 'alpha-one')
      expect(item.previewText).toBe(`Task ${source.label}`)
      expect(item.taskNumber).toBe(source.taskNumber)
    }
    // limit still bounds only items; the total collapses the whole slice.
    const humanBadge = ledger.inbox(human, { workspaceId: alpha, limit: 1 })
    expect(humanBadge.items).toHaveLength(1)
    expect(humanBadge.totalUnreadCount).toBe(15)
    // The beta Workspace holds ordinary follow unread with no mention at all,
    // which is admission enough now.
    const betaInbox = ledger.inbox(human, { workspaceId: beta, limit: 100 })
    expect(betaInbox.items.map(item => item.thread.threadRef)).toEqual(['c4', 'c3', 'c2', 'c1', 'c0'].map(label => byLabel.get(label)!.threadRef))
    expect(betaInbox.totalUnreadCount).toBe(5)
    expect(betaInbox.totalDirectCount).toBe(0)

    // ---- inbox(): the same slice for an Agent reader. ----
    const agentAInbox = ledger.inbox(memberActor(agentA, 'scout'), { workspaceId: alpha, limit: 100 })
    const unreadA = Object.fromEntries(agentAInbox.items.map(item => [item.thread.threadRef, { unreadCount: item.unreadCount, directCount: item.directCount }]))
    // a0: followed before three agent replies; a6..a9: the mention plus the
    // same three replies; a5 dropped out entirely — the unfollow consumed
    // its marker and ended the ordinary watermark.
    expect(unreadA[byLabel.get('a0')!.threadRef]).toEqual({ unreadCount: 3, directCount: 0 })
    for (const label of ['a6', 'a7', 'a8', 'a9']) expect(unreadA[byLabel.get(label)!.threadRef]).toEqual({ unreadCount: 4, directCount: 1 })
    expect(Object.keys(unreadA)).toHaveLength(5)
    // Row material rides every slice now: the agent-facing rows carry their
    // Channel name, Task ordinal, and opening line exactly like the Human
    // slice, so both render from one shape.
    for (const item of agentAInbox.items) {
      const source = threads.find(thread => thread.threadRef === item.thread.threadRef)!
      expect(item.channelName).toBe('alpha-one')
      expect(item.previewText).toBe(`Task ${source.label}`)
      expect(item.taskNumber).toBe(source.taskNumber)
    }
    const agentBInbox = ledger.inbox(memberActor(agentB, 'planner'), { workspaceId: alpha, limit: 100 })
    // planner's own replies never count; the plain Human update on a2 does.
    expect(agentBInbox.items.map(item => item.thread.threadRef)).toEqual([byLabel.get('a2')!.threadRef])
    expect(agentBInbox.totalUnreadCount).toBe(1)
    // The beta Channel never leaks into an alpha Member's slice.
    expect(ledger.inbox(memberActor(agentC, 'builder'), { workspaceId: beta, limit: 100 }).items).toEqual([])

    // ---- threadObservations(): replay-order history plus live followers. ----
    const a0Observations = ledger.threadObservations(human, { workspaceId: alpha, taskRef: byLabel.get('a0')!.taskRef })
    // The Thread starter's Attention rides the message-sent anchor (no
    // observation event); the explicit follow ops after it do.
    expect(a0Observations.followers).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID, agentA, agentB])
    expect(a0Observations.items.map(item => [item.memberId, item.action])).toEqual([[agentA, 'follow'], [agentB, 'follow']])
    for (const item of a0Observations.items) expect(item.taskRef).toBe(byLabel.get('a0')!.taskRef)
    const a5Observations = ledger.threadObservations(human, { workspaceId: alpha, taskRef: byLabel.get('a5')!.taskRef })
    expect(a5Observations.followers).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])
    expect(a5Observations.items.map(item => [item.memberId, item.action])).toEqual([[agentA, 'follow'], [agentA, 'unfollow']])
    // limit bounds the history window, not the follower set.
    const a0Limited = ledger.threadObservations(human, { workspaceId: alpha, taskRef: byLabel.get('a0')!.taskRef, limit: 1 })
    expect(a0Limited.followers).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID, agentA, agentB])
    expect(a0Limited.items.map(item => [item.memberId, item.action])).toEqual([[agentB, 'follow']])

    // ---- Independent replay: the derived indexes rebuild identically. ----
    expect(() => ledger.validate()).not.toThrow()
    const fresh = new AgentTeamLedger(table)
    expect(projectionSnapshot(fresh, channelA.channelRef)).toEqual(projectionSnapshot(ledger, channelA.channelRef))
  })

  function projectionSnapshot(source: AgentTeamLedger, channelRef: AgentTeamChannelRef): Record<string, unknown> {
    const thread = source.view({ workspaceId: alpha, channelRef, limit: 1, includeCatalog: true }).threads[0]!
    return {
      inboxA: source.inbox(memberActor('member:agent-a', 'scout'), { workspaceId: alpha, limit: 100 }),
      inboxHuman: source.inbox(human, { workspaceId: alpha, limit: 100 }),
      viewA: source.view({ workspaceId: alpha, channelRef, limit: 7 }),
      viewTail: source.view({ workspaceId: alpha, channelRef, direction: 'before', limit: 5 }),
      observationsA0: source.threadObservations(human, { workspaceId: alpha, taskRef: thread.taskRef! }),
      observationsA5: source.threadObservations(human, { workspaceId: alpha, threadRef: thread.threadRef }),
      taskNumbers: source.view({ workspaceId: alpha, limit: 1, includeCatalog: true }).taskNumbers,
    }
  }

  // The previous-Session index feeds crash recovery, so it must be derived
  // without reading a Session log — and a restart must rebuild it from the
  // operation table alone.
  it('derives each Member\'s previous Session and last transition from the transition records', async () => {
    const { ledger, table } = await openLedger()
    await ledger.initialize()
    const channel = (await ledger.createChannel({ requestId: requestId('lineage-channel'), workspaceId: alpha, name: 'lineage', description: 'Lineage', memberIds: [], actor: human })).value.channel
    const memberId = 'member:lineage' as AgentTeamMemberId
    const session = (generation: string): SessionId => SessionId(`session:lineage-${generation}`)
    await ledger.addMember({
      requestId: requestId('lineage-member'), workspaceId: alpha, handle: 'lineage', description: 'Lineage member', presetId: 'team-member',
      channelRefs: [channel.channelRef], actor: human,
      member: { memberId, sessionId: session('0'), workspaceId: alpha, handle: 'lineage', description: 'Lineage member', presetId: 'team-member', privateMemoryPath: '/tmp/lineage', state: 'enabled' },
    })
    // A Member that never moved has left no Session behind.
    expect(ledger.previousSessionForMember(memberId)).toBeUndefined()

    // Human renewal, then a Member's own rollover, then another renewal: both
    // writers feed the same index.
    await ledger.renewMemberSession({ requestId: requestId('lineage-renew-1'), workspaceId: alpha, memberId, sessionId: session('1'), actor: human })
    await ledger.rolloverMemberSession({ requestId: requestId('lineage-rollover'), workspaceId: alpha, memberId, actor: memberActor(memberId, 'lineage'),
      previousSessionId: session('1'), newSessionId: session('2'), handoffEventSeq: 7 as never, trigger: 'model' })
    await ledger.renewMemberSession({ requestId: requestId('lineage-renew-2'), workspaceId: alpha, memberId, sessionId: session('3'), actor: human })

    expect(ledger.previousSessionForMember(memberId)).toBe(session('2'))
    expect(ledger.lastTransitionForMember(memberId)).toEqual({ previousSessionId: session('2'), targetSessionId: session('3') })

    // Independent replay over the same table rebuilds the identical index.
    expect(() => ledger.validate()).not.toThrow()
    const fresh = new AgentTeamLedger(table)
    expect(fresh.previousSessionForMember(memberId)).toBe(session('2'))
    // An unknown Member owns nothing rather than failing the read.
    expect(fresh.previousSessionForMember('member:unknown' as AgentTeamMemberId)).toBeUndefined()
  })

  // State-requests 04: a per-Task Claim read is a bucket lookup, not a walk
  // over every Claim in the ledger. The bucket is derived like the other
  // indexes — first-write order, a state change rewrites the Claim in place —
  // and a replay rebuilds it from the operation table alone.
  it('answers per-Task Claim reads from a replay-derived Task bucket', async () => {
    const { ledger, table } = await openLedger()
    await ledger.initialize()
    const channel = (await ledger.createChannel({ requestId: requestId('bucket-channel'), workspaceId: alpha, name: 'bucket', description: 'Bucket', memberIds: [], actor: human })).value.channel
    const memberId = 'member:bucket-owner' as AgentTeamMemberId
    const actor = memberActor(memberId, 'bucket-owner')
    await ledger.addMember({
      requestId: requestId('bucket-member'), workspaceId: alpha, handle: 'bucket-owner', description: 'Bucket owner', presetId: 'team-member',
      channelRefs: [channel.channelRef], actor: human,
      member: { memberId, sessionId: SessionId('session:bucket-owner'), workspaceId: alpha, handle: 'bucket-owner', description: 'Bucket owner',
        presetId: 'team-member', privateMemoryPath: '/tmp/bucket-owner', state: 'enabled' },
    })

    // 24 in-flight Tasks with two Claims each: enough shared Claim history
    // that a per-Task read walking every Claim would show cross-Task leakage.
    const expected = new Map<AgentTeamTaskRef, AgentTeamClaimRef[]>()
    const revisions = new Map<AgentTeamTaskRef, number>()
    for (let index = 0; index < 24; index += 1) {
      const started = await ledger.sendMessage({ asTask: true, requestId: requestId(`bucket-task-${index}`), workspaceId: alpha, channelRef: channel.channelRef,
        body: `Claim bucket task ${index}`, actor: human })
      if (started.value.kind !== 'committed') throw new Error(`expected committed Task start ${index}`)
      const taskRef = started.value.task!.taskRef
      let revision = started.value.thread.revision
      const refs: AgentTeamClaimRef[] = []
      for (const direction of ['first pass', 'second pass']) {
        const claimed = await ledger.changeClaim({ requestId: requestId(`bucket-claim-${index}-${direction}`), workspaceId: alpha, taskRef,
          action: 'claim', direction, baseRevision: revision, actor })
        if (claimed.value.kind !== 'committed') throw new Error(`expected committed Claim on Task ${index}`)
        revision = claimed.value.thread.revision
        refs.push(claimed.value.claim.claimRef)
      }
      expected.set(taskRef, refs)
      revisions.set(taskRef, revision)
    }
    const taskRefs = [...expected.keys()]
    const described = (source: AgentTeamLedger): Map<AgentTeamTaskRef, AgentTeamClaimRef[]> => new Map(taskRefs.map(taskRef =>
      [taskRef, source.listClaims(human, { workspaceId: alpha, taskRef }).claims.map(claim => claim.claimRef)]))

    // The Human started these Threads, so the Members' Claim activities leave
    // the Human unread: the mutation fence requires the read before accepting.
    for (const taskRef of taskRefs.slice(0, 3)) {
      const read = await ledger.readThread({ requestId: requestId(`bucket-read-${taskRef}`), workspaceId: alpha, taskRef, actor: human })
      revisions.set(taskRef, read.value.thread.revision)
    }

    // A state change must not move the Claim: completing the first of two
    // Claims, accepting a Task and closing one all rewrite Claims in place.
    const done = await ledger.changeClaim({ requestId: requestId('bucket-done'), workspaceId: alpha, taskRef: taskRefs[0]!, action: 'done',
      claimRef: expected.get(taskRefs[0]!)![0]!, baseRevision: revisions.get(taskRefs[0]!)!, actor })
    if (done.value.kind !== 'committed') throw new Error('expected committed Claim completion')
    const accepted = await ledger.changeTask({ requestId: requestId('bucket-accept'), workspaceId: alpha, taskRef: taskRefs[1]!, action: 'accept',
      baseRevision: revisions.get(taskRefs[1]!)!, actor: human })
    if (accepted.value.kind !== 'committed') throw new Error('expected committed acceptance')
    const closed = await ledger.changeTask({ requestId: requestId('bucket-close'), workspaceId: alpha, taskRef: taskRefs[2]!, action: 'close',
      baseRevision: revisions.get(taskRefs[2]!)!, actor: human })
    if (closed.value.kind !== 'committed') throw new Error('expected committed close')

    const live = described(ledger)
    for (const taskRef of taskRefs) expect(live.get(taskRef)).toEqual(expected.get(taskRef))

    // The same bucket feeds 「who is on this Task」: the radar names the owner
    // while a live Claim exists, and stops naming a Task whose Claims are all
    // finished, released, or closed.
    const radarOwners = (taskRef: AgentTeamTaskRef): string[] => ledger.view({ workspaceId: alpha, topLevelOnly: true, includeActivities: false, direction: 'before', includeCatalog: true })
      .activeTaskThreads.find(row => row.taskRef === taskRef)?.members.map(member => member.memberId) ?? []
    expect(radarOwners(taskRefs[0]!)).toEqual([memberId])
    expect(radarOwners(taskRefs[1]!)).toEqual([])
    expect(radarOwners(taskRefs[3]!)).toEqual([memberId])

    // Removing the Member replays the departure snapshot, which rewrites every
    // remaining Claim of that Member through the same bucket.
    const removed = await ledger.removeMember({ requestId: requestId('bucket-remove'), memberId, actor: human })
    if (removed.committed !== true) throw new Error('expected committed Member removal')
    for (const taskRef of taskRefs) expect(described(ledger).get(taskRef)).toEqual(expected.get(taskRef))
    expect(described(ledger).get(taskRefs[3]!)!.every(ref => ledger.getClaim(ref)?.state === 'released')).toBe(true)
    expect(radarOwners(taskRefs[3]!)).toEqual([])

    // Independent replay over the same table rebuilds the identical bucket.
    expect(() => ledger.validate()).not.toThrow()
    const fresh = new AgentTeamLedger(table)
    expect(described(fresh)).toEqual(described(ledger))
  })
})
