import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import type {
  AgentTeamAgentMember, AgentTeamMainTimelineEntry, AgentTeamMemberActor, AgentTeamMemberId, AgentTeamMessageRef, AgentTeamOperation,
  AgentTeamOperationId, AgentTeamProjectRef, AgentTeamRequestId, AgentTeamThreadRef,
} from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>
let counter = 0
const requestId = (label: string) => `test:${label}:${++counter}` as AgentTeamRequestId

async function openTable(pool: MemoryMediaPool): Promise<Table> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  return domain.table('operations') as unknown as Table
}

function storedRecords(pool: MemoryMediaPool): AgentTeamOperation[] {
  return [...pool.media.get('agent_team')!.tables.get('operations')!.values()]
    .map(record => record as AgentTeamOperation)
    .sort((left, right) => left.sequence - right.sequence)
}

function appendStored(pool: MemoryMediaPool, record: AgentTeamOperation): void {
  const head = storedRecords(pool).at(-1)!
  const sequence = head.sequence + 1
  const operationId = `operation:appended-${sequence}` as AgentTeamOperationId
  pool.media.get('agent_team')!.tables.get('operations')!.set(operationId, { ...record, sequence, operationId, previousOperationId: head.operationId })
}

const actorOf = (memberId: AgentTeamMemberId, handle: string): AgentTeamMemberActor => ({ kind: 'member', memberId, handle })

interface Agent { readonly memberId: AgentTeamMemberId; readonly actor: AgentTeamMemberActor }

async function addAgent(ledger: AgentTeamLedger, handle: string, projectRefs: AgentTeamProjectRef[] = []): Promise<Agent> {
  const memberId = `member:${handle}` as AgentTeamMemberId
  const member: AgentTeamAgentMember = { memberId, sessionId: SessionId(`session:${handle}`), workspaceId: alpha, handle, description: '',
    presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled' }
  await ledger.addMember({ requestId: requestId(`add-${handle}`), actor: human, member, handle, description: '', presetId: 'team-member', workspaceId: alpha, projectRefs })
  return { memberId, actor: actorOf(memberId, handle) }
}

/** A version-2 Team: one Project, the Human, an Agent owner, an enrolled Agent member, and an Agent that never joined. */
async function seed(rulesVersion = 2) {
  const pool = new MemoryMediaPool()
  const table = await openTable(pool)
  const ledger = new AgentTeamLedger(table, { rulesVersion })
  await ledger.initialize()
  const projectRef = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'alpha', description: '', memberIds: [] })).value.project.projectRef
  const owner = await addAgent(ledger, 'owner', [projectRef])
  const writer = await addAgent(ledger, 'writer', [projectRef])
  const outsider = await addAgent(ledger, 'outsider')
  if (rulesVersion >= 2) await ledger.addProjectOwner({ requestId: requestId('owner'), actor: human, workspaceId: alpha, projectRef, memberId: owner.memberId })
  return { pool, table, ledger, projectRef, owner, writer, outsider }
}

type Seeded = Awaited<ReturnType<typeof seed>>
type Poster = typeof human | AgentTeamMemberActor

const post = (team: Seeded, actor: Poster, body: string, extra: { replyToMessageRef?: AgentTeamMessageRef; recipients?: AgentTeamMemberId[] } = {}) =>
  team.ledger.postMainMessage({ requestId: requestId('post'), actor, workspaceId: alpha, projectRef: team.projectRef, body, ...extra })
const readMain = (team: Seeded, actor: Poster, readThroughSequence?: number) =>
  team.ledger.readMainStream({ requestId: requestId('read'), actor, workspaceId: alpha, projectRef: team.projectRef, ...(readThroughSequence === undefined ? {} : { readThroughSequence }) })
const page = (team: Seeded, actor: Poster) => team.ledger.mainStreamHistory(actor, { workspaceId: alpha, projectRef: team.projectRef })
const start = (team: Seeded, actor: Poster, kind: 'discussion' | 'task', body: string, recipients?: AgentTeamMemberId[]) =>
  team.ledger.startThread({ requestId: requestId('start'), actor, workspaceId: alpha, projectRef: team.projectRef, kind, body, ...(recipients === undefined ? {} : { recipients }) })

const committedMessage = (result: Awaited<ReturnType<typeof post>>) => {
  if (!result.committed || result.value.kind !== 'committed') throw new Error(`expected a committed post, got ${JSON.stringify(result.value).slice(0, 200)}`)
  return result.value.message
}
const cardOf = (entries: readonly AgentTeamMainTimelineEntry[], threadRef: AgentTeamThreadRef) => {
  const entry = entries.find(candidate => candidate.kind === 'thread-card' && candidate.card.threadRef === threadRef)
  if (entry?.kind !== 'thread-card') throw new Error(`no card for ${threadRef}`)
  return entry
}

describe('rules version gating of the Main stream kinds', () => {
  it('rejects every new kind in a version-1 segment and the old top-level send in a version-2 segment', async () => {
    const team = await seed(2)
    await post(team, human, 'hello')
    await readMain(team, team.owner.actor)
    await start(team, human, 'discussion', 'a topic')
    const copied = storedRecords(team.pool).filter(record => ['team/main-message-posted', 'team/main-stream-read', 'team/thread-started'].includes(record.kind))
    expect(copied.map(record => record.kind)).toEqual(['team/main-message-posted', 'team/main-stream-read', 'team/thread-started'])

    for (const record of copied) {
      const pool = new MemoryMediaPool()
      await new AgentTeamLedger(await openTable(pool)).initialize()
      appendStored(pool, record)
      const table = await openTable(pool)
      expect(() => new AgentTeamLedger(table), record.kind).toThrow(/needs rules version 2/)
    }

    const old = await seed(1)
    await old.ledger.sendMessage({ requestId: requestId('send'), actor: human, workspaceId: alpha, projectRef: old.projectRef, body: 'top level' })
    const sent = storedRecords(old.pool).find(record => record.kind === 'team/message-sent')!
    const pool = new MemoryMediaPool()
    await new AgentTeamLedger(await openTable(pool), { rulesVersion: 2 }).initialize()
    appendStored(pool, sent)
    const table = await openTable(pool)
    expect(() => new AgentTeamLedger(table, { rulesVersion: 2 })).toThrow(/is not written under rules version 2/)
  })

  it('refuses the Main stream and Thread start on a version-1 ledger, and keeps version-1 inbox deltas free of Main markers', async () => {
    const team = await seed(1)
    await expect(post(team, human, 'hello')).rejects.toThrow(/Main stream needs rules version 2; this ledger runs version 1/)
    await expect(readMain(team, human)).rejects.toThrow(/rules version 2/)
    await expect(start(team, human, 'discussion', 'topic')).rejects.toThrow(/rules version 2/)
    expect(() => page(team, human)).toThrow(/rules version 2/)
    await team.ledger.sendMessage({ requestId: requestId('send'), actor: human, workspaceId: alpha, projectRef: team.projectRef, body: 'hi @writer', recipients: [team.writer.memberId] })
    const sent = storedRecords(team.pool).find(record => record.kind === 'team/message-sent')!
    expect(Object.keys((sent.data as { inbox: object }).inbox)).toEqual(['attention', 'directMarkers', 'activityMarkers'])
  })

  it('refuses the top-level send once the ledger runs version 2', async () => {
    const team = await seed(2)
    await expect(team.ledger.sendMessage({ requestId: requestId('send'), actor: human, workspaceId: alpha, projectRef: team.projectRef, body: 'top level' }))
      .rejects.toThrow(/replaced by startThread/)
  })
})

describe('Main stream posting and the unread gate', () => {
  it('asks an owner with unread to read first, and lets the read clear the gate', async () => {
    const team = await seed()
    await post(team, human, 'first')
    const blocked = await post(team, team.owner.actor, 'my turn')
    expect(blocked.committed).toBe(false)
    expect(blocked.value).toMatchObject({ kind: 'main_unread_required', projectRef: team.projectRef, unreadCount: 2, directCount: 1 })
    expect(blocked.value.kind === 'main_unread_required' && blocked.value.entries.map(entry => entry.kind)).toEqual(['activity', 'message'])
    await readMain(team, team.owner.actor)
    expect((await post(team, team.owner.actor, 'my turn')).committed).toBe(true)
    expect(page(team, team.owner.actor).standing).toMatchObject({ owner: true, unreadCount: 0 })
    // The Human is an owner too: the Agent's post is unread for them.
    expect((await post(team, human, 'reply')).value).toMatchObject({ kind: 'main_unread_required', unreadCount: 1 })
  })

  it('reads an unread backlog longer than one page page by page instead of acknowledging what was not shown', async () => {
    const team = await seed()
    await readMain(team, team.owner.actor)
    for (let index = 1; index <= 25; index += 1) await post(team, human, `note ${index}`)
    const first = await readMain(team, team.owner.actor)
    if (!first.committed) throw new Error('expected the first read to commit')
    expect(first.value.entries.map(entry => entry.kind === 'message' && entry.message.body)).toEqual(Array.from({ length: 20 }, (_, index) => `note ${index + 1}`))
    expect(first.value.standing.unreadCount).toBe(5)
    const second = await readMain(team, team.owner.actor)
    expect(second.value.entries.filter(entry => entry.unread).map(entry => entry.kind === 'message' && entry.message.body)).toEqual(['note 21', 'note 22', 'note 23', 'note 24', 'note 25'])
    expect(second.value.standing.unreadCount).toBe(0)
  })

  it('lets a non-owner member post without reading, and refuses a stranger', async () => {
    const team = await seed()
    await post(team, human, 'first')
    const posted = await post(team, team.writer.actor, 'from a member')
    expect(posted.committed).toBe(true)
    expect(page(team, team.writer.actor).standing).toMatchObject({ owner: false, unreadCount: 0, markers: [] })
    await expect(post(team, team.outsider.actor, 'let me in')).rejects.toThrow(/not_project_member/)
    await expect(readMain(team, team.outsider.actor)).rejects.toThrow(/not_project_member/)
  })

  it('delivers a marker to a mentioned Member and to the author of the answered Message, the Human included', async () => {
    const team = await seed()
    const first = committedMessage(await post(team, team.writer.actor, 'Question for the Human and @outsider'))
    expect(first.scope).toBe('main')
    // A mention makes the Agent a Project member: it can now take part.
    const mentioned = page(team, team.outsider.actor).standing
    expect(mentioned).toMatchObject({ owner: false, unreadCount: 1, directCount: 1 })
    await readMain(team, human)
    const answered = committedMessage(await post(team, human, 'Answer', { replyToMessageRef: first.messageRef }))
    expect(answered.replyToMessageRef).toBe(first.messageRef)
    expect(page(team, team.writer.actor).standing.markers).toMatchObject([{ messageRef: answered.messageRef }])

    // A non-owner reads only to consume markers: no watermark, and an empty second read writes nothing.
    const before = storedRecords(team.pool).length
    const read = await readMain(team, team.writer.actor)
    expect(read.committed).toBe(true)
    expect(read.value.consumedMarkers).toHaveLength(1)
    expect(page(team, team.writer.actor).standing).toMatchObject({ unreadCount: 0, markers: [] })
    const again = await readMain(team, team.writer.actor)
    expect(again.committed).toBe(false)
    expect(storedRecords(team.pool)).toHaveLength(before + 1)
    await expect(readMain(team, team.writer.actor, page(team, team.writer.actor).standing.head + 1)).rejects.toThrow(/head/)
  })

  it('does not take a Thread Message or another Project Message as a Main stream reply target', async () => {
    const team = await seed()
    const started = await start(team, human, 'discussion', 'thread topic')
    if (started.value.kind !== 'committed') throw new Error('start did not commit')
    await expect(post(team, human, 'wrong target', { replyToMessageRef: started.value.message.messageRef })).rejects.toThrow(/is a Thread Message/)
    await expect(post(team, human, 'wrong target', { replyToMessageRef: 'message:nothing' as AgentTeamMessageRef })).rejects.toThrow(/not a recorded Message/)
  })
})

describe('Thread start permission', () => {
  it('gives non-owners project_owner_required and starts a discussion for an owner with Attention for the creator alone', async () => {
    const team = await seed()
    await expect(start(team, team.writer.actor, 'discussion', 'let me start')).rejects.toThrow(/project_owner_required/)
    await expect(start(team, team.outsider.actor, 'task', 'let me start')).rejects.toThrow(/not_project_member/)

    const started = await start(team, team.owner.actor, 'discussion', 'Topic for @writer', [])
    if (started.value.kind !== 'committed') throw new Error('start did not commit')
    expect(started.value.attention.map(attention => attention.memberId)).toEqual([team.owner.memberId])
    expect(started.value.directMarkers.map(marker => marker.memberId)).toEqual([team.writer.memberId])
    expect(team.ledger.attentionStatus(team.writer.actor, { workspaceId: alpha, threadRef: started.value.thread.threadRef }).attention).toBeUndefined()
    expect(team.ledger.inbox(team.writer.actor, { workspaceId: alpha }).items).toMatchObject([{ directCount: 1 }])
  })

  it('lets an owner start a Task whose card shows its current state, and keeps cards out of the unread unless they are discussions', async () => {
    const team = await seed()
    const discussion = await start(team, human, 'discussion', 'A discussion')
    const task = await start(team, human, 'task', 'Do the thing')
    if (discussion.value.kind !== 'committed' || task.value.kind !== 'committed') throw new Error('start did not commit')
    expect(task.value.task).toMatchObject({ status: 'todo', resolution: 'open' })

    const ownerView = page(team, team.owner.actor)
    expect(cardOf(ownerView.entries, discussion.value.thread.threadRef)).toMatchObject({ unread: true, card: { replyCount: 0 } })
    expect(cardOf(ownerView.entries, task.value.thread.threadRef)).toMatchObject({ unread: false, card: { task: { status: 'todo', taskNumber: 1, liveClaimOwners: [] } } })
    // The Human wrote both, so nothing of them is unread for the Human.
    expect(page(team, human).standing.unreadCount).toBe(0)

    const claimed = await team.ledger.changeClaim({ requestId: requestId('claim'), actor: team.writer.actor, workspaceId: alpha, taskRef: task.value.task!.taskRef,
      baseRevision: task.value.thread.revision, action: 'claim', direction: 'build it' })
    expect(claimed.value.kind).toBe('committed')
    expect(cardOf(page(team, team.owner.actor).entries, task.value.thread.threadRef).card.task).toMatchObject({ status: 'in_progress', liveClaimOwners: [{ name: 'writer' }] })
    await expect(team.ledger.changeClaim({ requestId: requestId('claim'), actor: team.outsider.actor, workspaceId: alpha, taskRef: task.value.task!.taskRef,
      baseRevision: task.value.thread.revision, action: 'claim', direction: 'also me' })).rejects.toThrow(/not_project_member/)
  })

  it('lets a Project owner promote a Thread and refuses other Agents', async () => {
    const team = await seed()
    const started = await start(team, human, 'discussion', 'to be work')
    if (started.value.kind !== 'committed') throw new Error('start did not commit')
    const base = { workspaceId: alpha, threadRef: started.value.thread.threadRef, baseRevision: started.value.thread.revision }
    await expect(team.ledger.promoteThread({ requestId: requestId('promote'), actor: team.writer.actor, ...base })).rejects.toThrow(/project_owner_required/)
    const promoted = await team.ledger.promoteThread({ requestId: requestId('promote'), actor: team.owner.actor, ...base })
    expect(promoted.value.kind).toBe('committed')
    const replayed = new AgentTeamLedger(team.table, { rulesVersion: 2 })
    expect(replayed.getTask(started.value.thread.taskRef ?? (promoted.value.kind === 'committed' ? promoted.value.task.taskRef : undefined)!)).toBeDefined()
  })
})

describe('Thread replies at rules version 2', () => {
  it('lets a Project member who never took part reply, delivers a mention as one direct marker, and never confirms', async () => {
    const team = await seed()
    const started = await start(team, human, 'discussion', 'open question')
    if (started.value.kind !== 'committed') throw new Error('start did not commit')
    const threadRef = started.value.thread.threadRef
    const reply = await team.ledger.reply({ requestId: requestId('reply'), actor: team.writer.actor, workspaceId: alpha, threadRef,
      body: 'Looping in @owner', baseRevision: started.value.thread.revision })
    expect(reply.value.kind).toBe('committed')
    if (reply.value.kind !== 'committed') return
    expect(reply.value.attention).toEqual([])
    expect(reply.value.directMarkers.map(marker => marker.memberId)).toEqual([team.owner.memberId])
    expect(reply.value.undeliveredMentions).toBeUndefined()
    expect(team.ledger.attentionStatus(team.owner.actor, { workspaceId: alpha, threadRef }).attention).toBeUndefined()

    // The Human may mention a Member that never followed: it delivers directly, with no confirmation round trip.
    await team.ledger.readThread({ requestId: requestId('read'), actor: human, workspaceId: alpha, threadRef })
    const human2 = await team.ledger.reply({ requestId: requestId('reply'), actor: human, workspaceId: alpha, threadRef, body: 'And @outsider',
      baseRevision: reply.value.thread.revision })
    expect(human2.value.kind).toBe('committed')
    await expect(team.ledger.reply({ requestId: requestId('reply'), actor: human, workspaceId: alpha, threadRef, body: 'x', baseRevision: 1,
      confirmationToken: 'token' as never })).rejects.toThrow(/does not exist at rules version 2/)
  })

  it('answers the Human by marker and refuses a stranger', async () => {
    const team = await seed()
    const started = await start(team, human, 'discussion', 'open question')
    if (started.value.kind !== 'committed') throw new Error('start did not commit')
    const reply = await team.ledger.reply({ requestId: requestId('reply'), actor: team.writer.actor, workspaceId: alpha, threadRef: started.value.thread.threadRef,
      body: 'Answer', baseRevision: started.value.thread.revision, replyToMessageRef: started.value.message.messageRef })
    if (reply.value.kind !== 'committed') throw new Error('reply did not commit')
    expect(reply.value.directMarkers.map(marker => marker.memberId)).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID])
    await expect(team.ledger.reply({ requestId: requestId('reply'), actor: team.outsider.actor, workspaceId: alpha, threadRef: started.value.thread.threadRef,
      body: 'Me too', baseRevision: reply.value.thread.revision })).rejects.toThrow(/not_project_member/)
  })
})

describe('owner changes in the Main stream', () => {
  it('gives the new owner a marker, and starts its ordinary unread at the grant', async () => {
    const team = await seed(2)
    const earlier = await addAgent(team.ledger, 'later')
    await post(team, human, 'before the grant')
    await team.ledger.addProjectOwner({ requestId: requestId('owner'), actor: human, workspaceId: alpha, projectRef: team.projectRef, memberId: earlier.memberId })
    const standing = page(team, earlier.actor).standing
    expect(standing).toMatchObject({ owner: true, unreadCount: 1, directCount: 1 })
    expect(standing.markers).toMatchObject([{ activityRef: expect.stringMatching(/^activity:/) }])
  })

  it('drops ordinary unread when ownership ends but keeps the markers, and the member stays in the Project', async () => {
    const team = await seed(2)
    await post(team, human, 'ordinary')
    expect(page(team, team.owner.actor).standing.unreadCount).toBe(2)
    await team.ledger.removeProjectOwner({ requestId: requestId('owner'), actor: human, workspaceId: alpha, projectRef: team.projectRef, memberId: team.owner.memberId })
    const standing = page(team, team.owner.actor).standing
    expect(standing).toMatchObject({ owner: false, unreadCount: 2, directCount: 2 })
    expect(standing.markers).toHaveLength(2)
    expect((await readMain(team, team.owner.actor)).committed).toBe(true)
    expect(page(team, team.owner.actor).standing.unreadCount).toBe(0)
  })
})

describe('earlier-version Threads and replay', () => {
  it('shows version-1 top-level Threads as cards that are not unread, and reproduces every projection on replay', async () => {
    const pool = new MemoryMediaPool()
    const table = await openTable(pool)
    const legacy = new AgentTeamLedger(table)
    await legacy.initialize()
    const projectRef = (await legacy.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha, name: 'alpha', description: '', memberIds: [] })).value.project.projectRef
    const sent = await legacy.sendMessage({ requestId: requestId('send'), actor: human, workspaceId: alpha, projectRef, body: 'old task', asTask: true })
    if (sent.value.kind !== 'committed') throw new Error('send did not commit')

    const upgraded = new AgentTeamLedger(table, { rulesVersion: 2 })
    await upgraded.initialize()
    const writer = await addAgent(upgraded, 'writer', [projectRef])
    await upgraded.addProjectOwner({ requestId: requestId('owner'), actor: human, workspaceId: alpha, projectRef, memberId: writer.memberId })
    const team: Seeded = { pool, table, ledger: upgraded, projectRef, owner: writer, writer, outsider: writer }
    const card = cardOf(page(team, human).entries, sent.value.thread.threadRef)
    expect(card).toMatchObject({ unread: false, card: { task: { taskNumber: 1, status: 'todo' }, replyCount: 0 } })
    // The older card is not unread for the Human or the new owner; the new owner only holds its grant marker.
    expect(page(team, human).standing.unreadCount).toBe(0)
    expect(page(team, writer.actor).standing).toMatchObject({ unreadCount: 1, directCount: 1 })

    await readMain(team, writer.actor)
    await post(team, writer.actor, 'Hello @human')
    await readMain(team, human)
    await start(team, human, 'discussion', 'new topic')
    expect(page(team, writer.actor).standing).toMatchObject({ unreadCount: 1, directCount: 0 })

    const fresh = new AgentTeamLedger(table, { rulesVersion: 2 })
    for (const actor of [human, writer.actor]) {
      expect(fresh.mainStreamHistory(actor, { workspaceId: alpha, projectRef })).toEqual(upgraded.mainStreamHistory(actor, { workspaceId: alpha, projectRef }))
    }
    expect(fresh.projectOwnerIds(projectRef)).toEqual([writer.memberId])
  })

  it('replays markers cleaned by a departing Member', async () => {
    const team = await seed(2)
    await post(team, human, 'Hello @writer')
    expect(page(team, team.writer.actor).standing.markers).toHaveLength(1)
    await team.ledger.archiveMember({ requestId: requestId('archive'), memberId: team.writer.memberId, actor: human })
    expect(team.ledger.mainNotificationFacts(team.writer.memberId)).toEqual([])
    const fresh = new AgentTeamLedger(team.table, { rulesVersion: 2 })
    expect(fresh.mainNotificationFacts(team.writer.memberId)).toEqual([])
    expect(fresh.mainStreamHistory(human, { workspaceId: alpha, projectRef: team.projectRef }).entries.map(entry => entry.kind))
      .toEqual(team.ledger.mainStreamHistory(human, { workspaceId: alpha, projectRef: team.projectRef }).entries.map(entry => entry.kind))
  })
})
