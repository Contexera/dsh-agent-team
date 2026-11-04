/**
 * The subscription ledger: the lifecycle records, the append-only
 * deduplication waterline, event acceptance, and publication with the
 * recipient markers it freezes. Every case also proves replay still validates
 * the bytes it just wrote.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamLedger, agentTeamHostActor, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { snapshotScript, SUBSCRIPTION_PENDING_MAX, type SubscriptionTriggers } from '../src/subscriptions.ts'
import { webhookTokenHash } from '../src/subscription-webhook.ts'
import type {
  AgentTeamAgentMember,
  AgentTeamMemberActor,
  AgentTeamMemberId,
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamProjectRef,
  AgentTeamRequestId,
  AgentTeamSubscriptionRef,
} from '../src/types.ts'

const alpha = WorkspaceId('workspace:alpha')
const human = agentTeamHumanActor()
const host = agentTeamHostActor()
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

let counter = 0
const requestId = (label: string) => `test:${label}:${++counter}` as AgentTeamRequestId

type Table = KvTable<AgentTeamOperationId, AgentTeamOperation>

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

const snapshot = snapshotScript('printf \'{"id":"a","title":"A"}\\n\'\n', 'bash')
if (!snapshot.ok) throw new Error('the fixture script must be valid')
const script = snapshot.script
const replacement = snapshotScript('printf \'{"id":"b","title":"B"}\\n\'\n', 'bash')
if (!replacement.ok) throw new Error('the second fixture script must be valid')
const otherScript = replacement.script

interface Agent { readonly memberId: AgentTeamMemberId; readonly actor: AgentTeamMemberActor }

async function addAgent(ledger: AgentTeamLedger, handle: string, projectRefs: AgentTeamProjectRef[] = []): Promise<Agent> {
  const memberId = `member:${handle}` as AgentTeamMemberId
  const member: AgentTeamAgentMember = { memberId, sessionId: SessionId(`session:${handle}`), workspaceId: alpha, handle, description: '',
    presetId: 'team-member', privateMemoryPath: `/tmp/${handle}`, state: 'enabled' }
  await ledger.addMember({ requestId: requestId(`add-${handle}`), actor: human, member, handle, description: '', presetId: 'team-member', workspaceId: alpha, projectRefs })
  return { memberId, actor: { kind: 'member', memberId, handle } }
}

/** One Project with an Agent owner, an enrolled Agent writer, and an Agent that never joined. */
async function seed(options: { readonly webhookToken?: () => string } = {}) {
  const pool = new MemoryMediaPool()
  const table = await openTable(pool)
  const ledger = new AgentTeamLedger(table, { rulesVersion: 2, ...options })
  await ledger.initialize()
  const projectRef = (await ledger.createProject({ requestId: requestId('project'), actor: human, workspaceId: alpha,
    name: 'alpha', description: '', memberIds: [] })).value.project.projectRef
  const owner = await addAgent(ledger, 'owner', [projectRef])
  const writer = await addAgent(ledger, 'writer', [projectRef])
  const outsider = await addAgent(ledger, 'outsider')
  await ledger.addProjectOwner({ requestId: requestId('owner'), actor: human, workspaceId: alpha, projectRef, memberId: owner.memberId })
  const create = (actor: Agent['actor'] | typeof human, overrides: { name?: string; baselineIds?: readonly string[] } = {}) =>
    ledger.createSubscription({ requestId: requestId('create'), actor, workspaceId: alpha, projectRef,
      name: overrides.name ?? 'main CI', triggers: { interval: { minutes: 10 } }, script, credentials: [],
      baselineIds: overrides.baselineIds ?? [] })
  return { pool, table, ledger, projectRef, owner, writer, outsider, create, scriptHash: script.sha256 }
}

type Seeded = Awaited<ReturnType<typeof seed>>

const subscriptionRefOf = (result: Awaited<ReturnType<Seeded['create']>>): AgentTeamSubscriptionRef => {
  if (!result.committed || result.value.subscription === undefined) throw new Error('expected a committed subscription write')
  return result.value.subscription.subscriptionRef
}

/** Replay the same stored records through a cold ledger, which validates every one of them. */
function replayed(table: Table): AgentTeamLedger {
  return new AgentTeamLedger(table, { rulesVersion: 2 })
}

/** A memory pool already holding one stored operations table, so a tampered record can be replayed from disk. */
function poolOf(records: Array<[string, unknown]>): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('agent_team', agentTeamDomainSpec.version)
  pool.media.set('agent_team', { tables: new Map([['operations', new Map(records)]]), global: null })
  return pool
}

describe('the subscription lifecycle', () => {
  it('creates, pauses, resumes, edits, and deletes through durable records a replay still accepts', async () => {
    const team = await seed()
    const created = await team.create(team.owner.actor)
    const subscriptionRef = subscriptionRefOf(created)
    if (!created.committed) throw new Error('expected a commit')
    expect(created.value.subscription).toMatchObject({ revision: 1, state: 'active', name: 'main CI', createdBy: team.owner.memberId })
    expect(created.value.activity.kind).toBe('subscription-created')
    expect(team.ledger.subscriptionsOfProject(team.projectRef).map(entry => entry.subscriptionRef)).toEqual([subscriptionRef])

    const paused = await team.ledger.pauseSubscription({ requestId: requestId('pause'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, reason: 'manual' })
    expect(paused.committed).toBe(true)
    expect(team.ledger.subscription(subscriptionRef)).toMatchObject({ state: 'paused', pausedReason: 'manual', revision: 1 })

    const resumed = await team.ledger.resumeSubscription({ requestId: requestId('resume'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1 })
    expect(resumed.committed).toBe(true)

    const updated = await team.ledger.updateSubscription({ requestId: requestId('update'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, name: 'main CI (2)', triggers: { interval: { minutes: 5 } },
      script, credentials: [{ ref: 'GH_TOKEN', env: 'GH_TOKEN' }] })
    expect(updated.committed).toBe(true)
    expect(team.ledger.subscription(subscriptionRef)).toMatchObject({ revision: 2, name: 'main CI (2)' })

    const deleted = await team.ledger.deleteSubscription({ requestId: requestId('delete'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 2 })
    expect(deleted.committed).toBe(true)
    expect(team.ledger.subscription(subscriptionRef)?.state).toBe('deleted')

    expect(() => replayed(team.table)).not.toThrow()
  })

  it('answers project_owner_required to a Member who does not own the Project, even one who is in it', async () => {
    const team = await seed()
    await expect(team.create(team.writer.actor)).rejects.toThrow(/project_owner_required/)
    await expect(team.create(team.outsider.actor)).rejects.toThrow(/project_owner_required/)
  })

  it('refuses a stale expectedRevision instead of overwriting a concurrent edit', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    await team.ledger.updateSubscription({ requestId: requestId('update'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, name: 'first', triggers: { interval: { minutes: 5 } },
      script, credentials: [] })
    await expect(team.ledger.updateSubscription({ requestId: requestId('update'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, name: 'second', triggers: { interval: { minutes: 5 } },
      script, credentials: [] })).rejects.toThrow(/stale_revision/)
  })

  it('bounds a Project at twenty live subscriptions and counts a deleted one as gone', async () => {
    const team = await seed()
    const refs: AgentTeamSubscriptionRef[] = []
    for (let index = 0; index < 20; index += 1) refs.push(subscriptionRefOf(await team.create(team.owner.actor, { name: `s${index}` })))
    await expect(team.create(team.owner.actor, { name: 'overflow' })).rejects.toThrow(/already has 20 subscriptions/)
    await team.ledger.deleteSubscription({ requestId: requestId('delete'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef: refs[0]!, expectedRevision: 1 })
    expect(subscriptionRefOf(await team.create(team.owner.actor, { name: 'room again' }))).toBeDefined()
  })

  it('records each lifecycle line in the Main stream, naming the operator', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    const lines = team.ledger.mainStreamHistory(team.owner.actor, { workspaceId: alpha, projectRef: team.projectRef }).entries
      .flatMap(entry => entry.kind === 'activity' && entry.activity.kind.startsWith('subscription-') ? [entry.activity] : [])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ kind: 'subscription-created', actor: team.owner.memberId, subscriptionRef, subscriptionName: 'main CI' })
    // The Human reads the same line: a lifecycle record is an ordinary Main stream update.
    const humanPage = team.ledger.mainStreamHistory(human, { workspaceId: alpha, projectRef: team.projectRef })
    expect(humanPage.entries.some(entry => entry.kind === 'activity' && entry.activity.kind === 'subscription-created')).toBe(true)
  })
})

describe('the deduplication waterline', () => {
  it('stores the trial ids as the initial baseline and never accepts them again', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor, { baselineIds: ['a', 'b'] }))
    expect([...team.ledger.subscriptionKnownIds(subscriptionRef)].sort()).toEqual(['a', 'b'])
    await expect(team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash,
      events: [{ id: 'a', title: 'A' }] })).rejects.toThrow(/already known/)
  })

  it('appends a re-baseline without clearing earlier ids or refusing an already accepted event', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor, { baselineIds: ['a'] }))
    await team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash, events: [{ id: 'b', title: 'B' }] })
    await team.ledger.baselineSubscription({ requestId: requestId('baseline'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, ids: ['c', 'd'] })
    expect([...team.ledger.subscriptionKnownIds(subscriptionRef)].sort()).toEqual(['a', 'b', 'c', 'd'])
    // The accepted, unpublished event survives the re-baseline and still publishes.
    expect(team.ledger.pendingSubscriptionEvents(subscriptionRef).map(entry => entry.event.id)).toEqual(['b'])
    await expect(team.ledger.baselineSubscription({ requestId: requestId('baseline'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, ids: ['a'] })).rejects.toThrow(/already known/)
    expect(() => replayed(team.table)).not.toThrow()
  })

  it('keeps deduplication inside one subscription: two subscriptions publish the same id', async () => {
    const team = await seed()
    const first = subscriptionRefOf(await team.create(team.owner.actor, { name: 'first' }))
    const second = subscriptionRefOf(await team.create(team.owner.actor, { name: 'second' }))
    for (const subscriptionRef of [first, second]) {
      const accepted = await team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
        projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash, events: [{ id: 'shared', title: 'Same' }] })
      expect(accepted.committed).toBe(true)
    }
    expect(team.ledger.pendingSubscriptionEvents(first)).toHaveLength(1)
    expect(team.ledger.pendingSubscriptionEvents(second)).toHaveLength(1)
  })
})

describe('acceptance and publication', () => {
  it('accepts a run under the revision it pinned, even after an edit crossed it', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    const pinnedHash = team.scriptHash
    await team.ledger.updateSubscription({ requestId: requestId('update'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, name: 'renamed', triggers: { interval: { minutes: 5 } },
      script, credentials: [] })
    const accepted = await team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: pinnedHash, events: [{ id: 'late', title: 'Late' }] })
    if (!accepted.committed) throw new Error('expected a commit')
    expect(accepted.value.accepted[0]).toMatchObject({ subscriptionRevision: 1, scriptHash: pinnedHash })
    expect(() => replayed(team.table)).not.toThrow()
  })

  it('freezes every owner — the Human included — as a recipient of the published event', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    await team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash, events: [{ id: 'e1', title: 'Build failed', url: 'https://example.test/1' }] })
    const pending = team.ledger.pendingSubscriptionEvents(subscriptionRef)
    expect(pending).toHaveLength(1)
    const published = await team.ledger.publishSubscriptionEvent({ requestId: requestId('publish'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, acceptedSequence: pending[0]!.acceptedSequence, eventId: 'e1' })
    if (!published.committed) throw new Error('expected a commit')
    expect(published.value.published).toMatchObject({ subscriptionName: 'main CI', sequence: expect.any(Number) })
    expect(published.value.published.event).toEqual({ id: 'e1', title: 'Build failed', url: 'https://example.test/1' })
    expect(team.ledger.pendingSubscriptionEvents(subscriptionRef)).toHaveLength(0)

    // The owner's Main stream carries the event as a direct marker; the Human's
    // marker is stored too, because the Human owns every Project.
    const ownerPage = team.ledger.mainStreamHistory(team.owner.actor, { workspaceId: alpha, projectRef: team.projectRef })
    const marked = ownerPage.entries.filter(entry => entry.kind === 'subscription-event' && entry.direct)
    expect(marked).toHaveLength(1)
    expect(marked[0]?.kind === 'subscription-event' && marked[0].event.subscriptionName).toBe('main CI')
    const humanPublic = team.ledger.mainStreamHistory(human, { workspaceId: alpha, projectRef: team.projectRef })
    expect(humanPublic.entries.some(entry => entry.kind === 'subscription-event' && entry.event.event.id === 'e1')).toBe(true)
    expect(() => replayed(team.table)).not.toThrow()
  })

  it('refuses to publish twice, to publish an event it never accepted, or to publish after deletion', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    await team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash, events: [{ id: 'e1', title: 'One' }] })
    const acceptedSequence = team.ledger.pendingSubscriptionEvents(subscriptionRef)[0]!.acceptedSequence
    await team.ledger.publishSubscriptionEvent({ requestId: requestId('publish'), actor: host, workspaceId: alpha, projectRef: team.projectRef,
      subscriptionRef, acceptedSequence, eventId: 'e1' })
    await expect(team.ledger.publishSubscriptionEvent({ requestId: requestId('publish'), actor: host, workspaceId: alpha, projectRef: team.projectRef,
      subscriptionRef, acceptedSequence, eventId: 'e1' })).rejects.toThrow(/already published/)
    await expect(team.ledger.publishSubscriptionEvent({ requestId: requestId('publish'), actor: host, workspaceId: alpha, projectRef: team.projectRef,
      subscriptionRef, acceptedSequence, eventId: 'never' })).rejects.toThrow(/never accepted/)
    await team.ledger.deleteSubscription({ requestId: requestId('delete'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1 })
    await expect(team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash, events: [{ id: 'e2', title: 'Two' }] }))
      .rejects.toThrow(/deleted/)
  })

  it('refuses a batch that would cross the unpublished ceiling and reports the backlog', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    const full = Array.from({ length: SUBSCRIPTION_PENDING_MAX }, (_, index) => ({ id: `e${index}`, title: `E${index}` }))
    await team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash, events: full })
    await expect(team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash,
      events: [{ id: 'one-more', title: 'Over' }] })).rejects.toThrow(/subscription_backlog_full/)
  })

  it('publishes an event while the subscription is paused, as the state machine allows', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    await team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash, events: [{ id: 'e1', title: 'One' }] })
    await team.ledger.pauseSubscription({ requestId: requestId('pause'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, reason: 'manual' })
    const acceptedSequence = team.ledger.pendingSubscriptionEvents(subscriptionRef)[0]!.acceptedSequence
    const published = await team.ledger.publishSubscriptionEvent({ requestId: requestId('publish'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, acceptedSequence, eventId: 'e1' })
    expect(published.committed).toBe(true)
  })
})

describe('the pause the Host writes after repeated failures', () => {
  /** The stored pause, read back from the ledger head so the markers can be asserted or rewritten. */
  async function pauseForFailures(team: Seeded): Promise<AgentTeamSubscriptionRef> {
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    const paused = await team.ledger.pauseSubscription({ requestId: requestId('pause'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, reason: 'failures' })
    expect(paused.committed).toBe(true)
    return subscriptionRef
  }

  const head = (table: Table): [string, AgentTeamOperation] => [...table.entries()].sort((left, right) => left[1].sequence - right[1].sequence).at(-1)!

  it('notifies the Human and every owner, in bytes a cold replay still accepts', async () => {
    const team = await seed()
    const subscriptionRef = await pauseForFailures(team)
    expect(team.ledger.subscription(subscriptionRef)).toMatchObject({ state: 'paused', pausedReason: 'failures' })
    const [key, operation] = head(team.table)
    expect(key).toBe(operation.operationId)
    if (operation.kind !== 'team/subscription-paused') throw new Error('expected the pause at the ledger head')
    const notified = operation.data.inbox?.mainMarkers?.added ?? []
    // Owners as they stood at this commit, the Human included, whatever their attention state.
    expect(notified.map(marker => marker.memberId).sort()).toEqual([AGENT_TEAM_HUMAN_MEMBER_ID, team.owner.memberId].sort())
    // An enrolled Member who owns nothing is not an owner.
    expect(notified.map(marker => marker.memberId)).not.toContain(team.writer.memberId)
    expect(notified.every(marker => marker.projectRef === team.projectRef && 'activityRef' in marker
      && marker.activityRef === operation.data.activity.activityRef)).toBe(true)
    expect(() => replayed(team.table)).not.toThrow()
  })

  it('refuses a pause whose markers miss an owner', async () => {
    const team = await seed()
    await pauseForFailures(team)
    const records = [...team.table.entries()].sort((left, right) => left[1].sequence - right[1].sequence)
    const [key, last] = records.at(-1)!
    if (last.kind !== 'team/subscription-paused') throw new Error('expected the pause at the ledger head')
    const tampered = { ...last, data: { ...last.data, inbox: { ...last.data.inbox!, mainMarkers: {
      added: last.data.inbox!.mainMarkers!.added.filter(marker => marker.memberId !== AGENT_TEAM_HUMAN_MEMBER_ID), removed: [] } } } }
    const reloaded = await openTable(poolOf([...records.slice(0, -1), [key, tampered]]))
    expect(() => replayed(reloaded)).toThrow(/does not notify exactly the Project owners/)
  })

  it('writes no markers when a person pauses it', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    await team.ledger.pauseSubscription({ requestId: requestId('pause'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, reason: 'manual' })
    const [, operation] = head(team.table)
    if (operation.kind !== 'team/subscription-paused') throw new Error('expected the pause at the ledger head')
    expect(operation.data.inbox).toBeUndefined()
    expect(() => replayed(team.table)).not.toThrow()
  })
})

describe('the webhook address', () => {
  /** Two address-shaped tokens, distinguishable in a failure message. */
  const firstToken = `${'A'.repeat(42)}1`
  const secondToken = `${'A'.repeat(42)}2`

  /** A mint that hands out the named tokens in order, so an arm's identity is the test's choice. */
  const minted = (...tokens: string[]): () => string => {
    const queue = [...tokens]
    return () => {
      const next = queue.shift()
      if (next === undefined) throw new Error('the fixture minted more tokens than it named')
      return next
    }
  }

  const createWebhook = (team: Seeded, label = 'create-webhook') =>
    team.ledger.createSubscription({ requestId: requestId(label), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, name: 'GitHub PR activity', triggers: { webhook: true }, script, credentials: [], baselineIds: [] })

  const edit = (team: Seeded, subscriptionRef: AgentTeamSubscriptionRef, revision: number,
    triggers: SubscriptionTriggers, label: string) =>
    team.ledger.updateSubscription({ requestId: requestId(label), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: revision, name: 'GitHub PR activity', triggers, script, credentials: [] })

  const reset = (team: Seeded, subscriptionRef: AgentTeamSubscriptionRef, revision: number, label = 'reset', actor = team.owner.actor) =>
    team.ledger.resetSubscriptionWebhook({ requestId: requestId(label), actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: revision })

  const storedRecords = (pool: MemoryMediaPool): string =>
    JSON.stringify([...(pool.media.get('agent_team')?.tables.get('operations') ?? new Map())])

  it('arms the address once, stores only its hash, and resolves the token back to its subscription', async () => {
    const team = await seed({ webhookToken: minted(firstToken, secondToken) })
    const created = await createWebhook(team)
    if (!created.committed) throw new Error('expected a commit')
    const subscriptionRef = created.value.subscription.subscriptionRef
    expect(created.value.webhookToken, 'the token exists in exactly this answer').toBe(firstToken)
    expect(created.value.subscription.webhook).toEqual({ tokenHash: webhookTokenHash(firstToken), generation: 1,
      armedAt: created.value.subscription.createdAt })
    expect(team.ledger.subscriptionByWebhookToken(firstToken)?.subscriptionRef).toBe(subscriptionRef)
    expect(team.ledger.subscriptionByWebhookToken(secondToken), 'a token nobody minted names nothing').toBeUndefined()
    const stored = storedRecords(team.pool)
    expect(stored, 'the plaintext token is what the ledger must never persist').not.toContain(firstToken)
    expect(stored, 'the hash is what a reader finds instead').toContain(webhookTokenHash(firstToken))
  })

  it('leaves a subscription without the trigger unarmed', async () => {
    const team = await seed({ webhookToken: minted(firstToken, secondToken) })
    const created = await team.create(team.owner.actor)
    expect(created.value.webhookToken).toBeUndefined()
    expect(created.value.subscription.webhook).toBeUndefined()
  })

  it('answers a same-request retry with the stored write and says the address cannot be shown again', async () => {
    // A second token is minted by nothing here: if a resolved retry ever handed
    // one out, the fixture would prove it rather than run dry.
    const team = await seed({ webhookToken: minted(firstToken, secondToken) })
    const first = await createWebhook(team)
    const again = await team.ledger.createSubscription({ requestId: first.value.receipt.requestId, actor: team.owner.actor,
      workspaceId: alpha, projectRef: team.projectRef, name: 'GitHub PR activity', triggers: { webhook: true }, script,
      credentials: [], baselineIds: [] })
    expect(again.committed).toBe(false)
    expect(again.value.webhookToken, 'the token is not recoverable a second time').toBeUndefined()
    expect(again.value.subscription.webhook).toEqual(first.value.subscription.webhook)
  })

  it('keeps the armed address across an edit and drops it with the trigger', async () => {
    const team = await seed({ webhookToken: minted(firstToken, secondToken) })
    const created = await createWebhook(team)
    const subscriptionRef = created.value.subscription.subscriptionRef
    const kept = await edit(team, subscriptionRef, 1, { interval: { minutes: 5 }, webhook: true }, 'edit-keep')
    expect(kept.value.webhookToken, 'an edit never rotates the address').toBeUndefined()
    expect(kept.value.subscription.webhook).toEqual(created.value.subscription.webhook)
    expect(team.ledger.subscriptionByWebhookToken(firstToken)?.subscriptionRef).toBe(subscriptionRef)

    const dropped = await edit(team, subscriptionRef, 2, { interval: { minutes: 5 } }, 'edit-drop')
    expect(dropped.value.subscription.webhook).toBeUndefined()
    expect(team.ledger.subscriptionByWebhookToken(firstToken), 'a dropped trigger stops resolving its address').toBeUndefined()
  })

  it('mints a first address when an edit enables the trigger', async () => {
    const team = await seed({ webhookToken: minted(secondToken) })
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    const enabled = await edit(team, subscriptionRef, 1, { webhook: true }, 'enable')
    expect(enabled.value.webhookToken).toBe(secondToken)
    expect(enabled.value.subscription.webhook).toMatchObject({ generation: 1, tokenHash: webhookTokenHash(secondToken) })
  })

  it('rotates the address on reset: a new generation, the same revision, and an old token that stops resolving', async () => {
    const team = await seed({ webhookToken: minted(firstToken, secondToken) })
    const created = await createWebhook(team)
    const subscriptionRef = created.value.subscription.subscriptionRef
    const rotated = await reset(team, subscriptionRef, 1)
    if (!rotated.committed) throw new Error('expected a commit')
    expect(rotated.value.webhookToken).toBe(secondToken)
    expect(rotated.value.subscription).toMatchObject({ revision: 1, name: 'GitHub PR activity' })
    expect(rotated.value.subscription.webhook).toEqual({ tokenHash: webhookTokenHash(secondToken), generation: 2,
      armedAt: rotated.value.receipt.occurredAt })
    expect(rotated.value.activity.kind).toBe('subscription-webhook-reset')
    expect(team.ledger.subscriptionByWebhookToken(firstToken), 'the old address is gone at once').toBeUndefined()
    expect(team.ledger.subscriptionByWebhookToken(secondToken)?.subscriptionRef).toBe(subscriptionRef)
    expect(storedRecords(team.pool)).not.toContain(secondToken)
    expect(() => replayed(team.table)).not.toThrow()
  })

  it('answers a same-request reset retry with the stored record, and refuses a reset without an address', async () => {
    const team = await seed({ webhookToken: minted(firstToken, secondToken) })
    const created = await createWebhook(team)
    const subscriptionRef = created.value.subscription.subscriptionRef
    const done = await reset(team, subscriptionRef, 1)
    const again = await team.ledger.resetSubscriptionWebhook({ requestId: done.value.receipt.requestId, actor: team.owner.actor,
      workspaceId: alpha, projectRef: team.projectRef, subscriptionRef, expectedRevision: 1 })
    expect(again.committed).toBe(false)
    expect(again.value.webhookToken).toBeUndefined()
    expect(again.value.subscription.webhook).toEqual(done.value.subscription.webhook)

    const plain = subscriptionRefOf(await team.create(team.owner.actor, { name: 'timer only' }))
    await expect(reset(team, plain, 1, 'reset-plain')).rejects.toThrow(/no webhook address to reset/)
  })

  it('refuses a reset from a Member who does not own the Project and one on a stale revision', async () => {
    const team = await seed({ webhookToken: minted(firstToken, secondToken) })
    const subscriptionRef = (await createWebhook(team)).value.subscription.subscriptionRef
    await expect(reset(team, subscriptionRef, 1, 'reset-writer', team.writer.actor)).rejects.toThrow(/project_owner_required/)
    await expect(reset(team, subscriptionRef, 2, 'reset-stale')).rejects.toThrow(/stale_revision/)
  })

  it('refuses a stored reset that keeps the token it claims to replace or skips a generation', async () => {
    const team = await seed({ webhookToken: minted(firstToken, secondToken) })
    const created = await createWebhook(team)
    await reset(team, created.value.subscription.subscriptionRef, 1)
    const records = [...team.table.entries()].sort((left, right) => left[1].sequence - right[1].sequence)
    const [key, last] = records.at(-1)!
    if (last.kind !== 'team/subscription-webhook-reset') throw new Error('expected the reset at the ledger head')
    const rewrite = (arm: { readonly tokenHash: string; readonly generation: number; readonly armedAt: string }) =>
      poolOf([...records.slice(0, -1), [key, { ...last, data: { ...last.data,
        subscription: { ...last.data.subscription, webhook: arm } } }]])
    const kept = await openTable(rewrite({ ...last.data.subscription.webhook!, tokenHash: webhookTokenHash(firstToken) }))
    expect(() => replayed(kept)).toThrow(/keeps the token it resets/)
    // A fresh hash with a generation that skips one is the other forgery a
    // reset must never accept: the old address would still resolve.
    const skipped = await openTable(rewrite({ ...last.data.subscription.webhook!, generation: 3,
      tokenHash: webhookTokenHash(`${'A'.repeat(42)}3`) }))
    expect(() => replayed(skipped)).toThrow(/next webhook address generation/)
  })
})

describe('replay refusal', () => {
  it('refuses a publication whose markers are not exactly the current owners', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    await team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash, events: [{ id: 'e1', title: 'One' }] })
    const acceptedSequence = team.ledger.pendingSubscriptionEvents(subscriptionRef)[0]!.acceptedSequence
    await team.ledger.publishSubscriptionEvent({ requestId: requestId('publish'), actor: host, workspaceId: alpha, projectRef: team.projectRef,
      subscriptionRef, acceptedSequence, eventId: 'e1' })
    // Drop the Human's marker: a forger's shape this build never writes.
    const records = [...team.table.entries()].sort((left, right) => left[1].sequence - right[1].sequence)
    const last = records.at(-1)!
    const publish = last[1]
    if (publish.kind !== 'team/subscription-event-published') throw new Error('expected the publication at the ledger head')
    const tampered = { ...publish, data: { ...publish.data, inbox: { ...publish.data.inbox, mainMarkers: {
      added: publish.data.inbox.mainMarkers!.added.filter(marker => marker.memberId !== AGENT_TEAM_HUMAN_MEMBER_ID),
      removed: [] } } } }
    const pool = poolOf([...records.slice(0, -1), [last[0], tampered]])
    const reloaded = await openTable(pool)
    expect(() => replayed(reloaded)).toThrow(/does not mark exactly/)
  })

  it('refuses an acceptance that repeats an id already accepted', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    const accept = (events: Array<{ id: string; title: string }>) => team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'),
      actor: host, workspaceId: alpha, projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1,
      scriptHash: team.scriptHash, events })
    await accept([{ id: 'e1', title: 'One' }])
    const before = [...team.table.entries()].sort((left, right) => left[1].sequence - right[1].sequence)
    await accept([{ id: 'e2', title: 'Two' }])
    // Rewrite the second acceptance so it repeats the first event, then replay.
    const stored = [...team.table.entries()].sort((left, right) => left[1].sequence - right[1].sequence)
    const [key, second] = stored.at(-1)!
    if (second.kind !== 'team/subscription-events-accepted') throw new Error('expected an acceptance at the ledger head')
    const pool = poolOf([...stored.slice(0, -1), [key, { ...second, data: { ...second.data, events: [{ id: 'e1', title: 'One' }] } }]])
    expect(before.length).toBeGreaterThan(0)
    const reloaded = await openTable(pool)
    expect(() => replayed(reloaded)).toThrow(/already known/)
  })
})

describe('who may read a Project\'s subscriptions', () => {
  it('answers the Human and every Project member, and refuses a Member who only shares the Workspace', async () => {
    const team = await seed()
    await team.create(team.owner.actor)
    expect(() => team.ledger.assertSubscriptionReadAuthority(human, team.projectRef, alpha)).not.toThrow()
    expect(() => team.ledger.assertSubscriptionReadAuthority(team.owner.actor, team.projectRef, alpha)).not.toThrow()
    // A writer is enrolled but owns nothing: reading is not a write.
    expect(() => team.ledger.assertSubscriptionReadAuthority(team.writer.actor, team.projectRef, alpha)).not.toThrow()
    // Same Workspace, no Project membership: the scripts are not theirs to read.
    expect(() => team.ledger.assertSubscriptionReadAuthority(team.outsider.actor, team.projectRef, alpha)).toThrow(/not_project_member/)
    expect(() => team.ledger.assertSubscriptionReadAuthority(host, team.projectRef, alpha)).toThrow(/Human or Agent Member/)
  })
})

describe('a request id means one payload', () => {
  it('replays a legacy create with a pasted script and refuses a path it cannot verify', async () => {
    const team = await seed()
    const legacyRequestId = requestId('legacy-create')
    const created = await team.ledger.createSubscription({ requestId: legacyRequestId, actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, name: 'main CI', triggers: { interval: { minutes: 10 } }, script, credentials: [], baselineIds: [] })
    const subscriptionRef = subscriptionRefOf(created)
    const common = { requestId: legacyRequestId, actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, name: 'main CI', intervalMinutes: 10, credentials: [] }
    const pasted = team.ledger.subscriptionWriteReplay({ kind: 'create', ...common, script: { scriptContent: script.content }, baseline: 'current-output' })
    expect(pasted?.value.subscription.subscriptionRef).toBe(subscriptionRef)
    expect(() => team.ledger.subscriptionWriteReplay({ kind: 'create', ...common, script: { scriptPath: 'not-in-the-old-record.sh' }, baseline: 'current-output' }))
      .toThrow(new RegExp(`read committed subscription '${subscriptionRef}'`))
    expect(() => team.ledger.subscriptionWriteReplay({ kind: 'create', ...common, script: { scriptContent: 'printf different\n' }, baseline: 'current-output' }))
      .toThrow(/reused with a different operation or payload/)
  })

  it('refuses a create retried under the same id with any other field, and resolves the identical retry', async () => {
    const team = await seed()
    const first = { requestId: requestId('create-collision'), actor: team.owner.actor, workspaceId: alpha, projectRef: team.projectRef,
      name: 'main CI', triggers: { interval: { minutes: 10 } }, script, credentials: [], baselineIds: [] }
    const created = await team.ledger.createSubscription(first)
    expect(created.committed).toBe(true)
    // Same bytes: the retry resolves against the stored operation.
    const retry = await team.ledger.createSubscription(first)
    expect(retry.committed).toBe(false)
    expect(retry.value.receipt.operationId).toBe(created.value.receipt.operationId)
    for (const mutated of [{ name: 'renamed' }, { baselineIds: ['x'] }, { triggers: { interval: { minutes: 5 } } }, { credentials: [{ ref: 'GH_TOKEN', env: 'GH_TOKEN' }] }]) {
      await expect(team.ledger.createSubscription({ ...first, ...mutated })).rejects.toThrow(/reused with a different operation or payload/)
    }
  })

  it('refuses an update, baseline, pause, resume, delete, acceptance, and publication retried with other arguments', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    const updateId = requestId('update-collision')
    const update = { requestId: updateId, actor: team.owner.actor, workspaceId: alpha, projectRef: team.projectRef, subscriptionRef,
      expectedRevision: 1, name: 'edited', triggers: { interval: { minutes: 10 } }, script, credentials: [] }
    expect((await team.ledger.updateSubscription(update)).committed).toBe(true)
    expect((await team.ledger.updateSubscription(update)).committed).toBe(false)
    await expect(team.ledger.updateSubscription({ ...update, expectedRevision: 2 })).rejects.toThrow(/reused with a different operation or payload/)
    await expect(team.ledger.updateSubscription({ ...update, name: 'other' })).rejects.toThrow(/reused with a different operation or payload/)

    const baselineId = requestId('baseline-collision')
    const baseline = { requestId: baselineId, actor: team.owner.actor, workspaceId: alpha, projectRef: team.projectRef, subscriptionRef, ids: ['x'] }
    expect((await team.ledger.baselineSubscription(baseline)).committed).toBe(true)
    expect((await team.ledger.baselineSubscription(baseline)).committed).toBe(false)
    await expect(team.ledger.baselineSubscription({ ...baseline, ids: ['y'] })).rejects.toThrow(/reused with a different operation or payload/)

    const pauseId = requestId('pause-collision')
    const pause = { requestId: pauseId, actor: team.owner.actor, workspaceId: alpha, projectRef: team.projectRef, subscriptionRef,
      expectedRevision: 2, reason: 'manual' as const }
    expect((await team.ledger.pauseSubscription(pause)).committed).toBe(true)
    expect((await team.ledger.pauseSubscription(pause)).committed).toBe(false)
    await expect(team.ledger.pauseSubscription({ ...pause, reason: 'failures' })).rejects.toThrow(/reused with a different operation or payload/)

    const resumeId = requestId('resume-collision')
    const resume = { requestId: resumeId, actor: team.owner.actor, workspaceId: alpha, projectRef: team.projectRef, subscriptionRef, expectedRevision: 2 }
    expect((await team.ledger.resumeSubscription(resume)).committed).toBe(true)
    expect((await team.ledger.resumeSubscription(resume)).committed).toBe(false)
    await expect(team.ledger.resumeSubscription({ ...resume, expectedRevision: 3 })).rejects.toThrow(/reused with a different operation or payload/)

    const acceptId = requestId('accept-collision')
    const accept = { requestId: acceptId, actor: host, workspaceId: alpha, projectRef: team.projectRef, subscriptionRef,
      subscriptionRevision: 2, scriptHash: team.scriptHash, events: [{ id: 'one', title: 'One' }] }
    expect((await team.ledger.acceptSubscriptionEvents(accept)).committed).toBe(true)
    expect((await team.ledger.acceptSubscriptionEvents(accept)).committed).toBe(false)
    await expect(team.ledger.acceptSubscriptionEvents({ ...accept, events: [{ id: 'two', title: 'Two' }] })).rejects.toThrow(/reused with a different operation or payload/)
    await expect(team.ledger.acceptSubscriptionEvents({ ...accept, scriptHash: 'c'.repeat(64) })).rejects.toThrow(/reused with a different operation or payload/)

    const publishId = requestId('publish-collision')
    const accepted = team.ledger.pendingSubscriptionEvents(subscriptionRef)[0]!
    const publish = { requestId: publishId, actor: host, workspaceId: alpha, projectRef: team.projectRef, subscriptionRef,
      acceptedSequence: accepted.acceptedSequence, eventId: accepted.event.id }
    expect((await team.ledger.publishSubscriptionEvent(publish)).committed).toBe(true)
    expect((await team.ledger.publishSubscriptionEvent(publish)).committed).toBe(false)
    await expect(team.ledger.publishSubscriptionEvent({ ...publish, eventId: 'other' })).rejects.toThrow(/reused with a different operation or payload/)

    const deleteId = requestId('delete-collision')
    const remove = { requestId: deleteId, actor: team.owner.actor, workspaceId: alpha, projectRef: team.projectRef, subscriptionRef, expectedRevision: 2 }
    expect((await team.ledger.deleteSubscription(remove)).committed).toBe(true)
    expect((await team.ledger.deleteSubscription(remove)).committed).toBe(false)
    await expect(team.ledger.deleteSubscription({ ...remove, expectedRevision: 3 })).rejects.toThrow(/reused with a different operation or payload/)
  })
})

describe('a run is pinned to the script its revision carried', () => {
  it('refuses an acceptance whose revision and script hash never belonged together', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    await team.ledger.updateSubscription({ requestId: requestId('update'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, name: 'main CI (2)', triggers: { interval: { minutes: 10 } },
      script: otherScript, credentials: [] })
    const accept = (revision: number, hash: string, id: string) => team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'),
      actor: host, workspaceId: alpha, projectRef: team.projectRef, subscriptionRef, subscriptionRevision: revision, scriptHash: hash,
      events: [{ id, title: id }] })
    // Revision 2 carries the replacement script; the pinned hash must be that one.
    await expect(accept(2, team.scriptHash, 'r2-old')).rejects.toThrow(/subscription_script_mismatch/)
    await expect(accept(1, otherScript.sha256, 'r1-new')).rejects.toThrow(/subscription_script_mismatch/)
    // The pairs that did exist are accepted, and replay agrees.
    expect((await accept(1, team.scriptHash, 'r1-old')).committed).toBe(true)
    expect((await accept(2, otherScript.sha256, 'r2-new')).committed).toBe(true)
    expect(() => replayed(team.table)).not.toThrow()

    // A hand-written record that pairs revision 1 with revision 2's script is refused on replay.
    const stored = [...team.table.entries()].sort((left, right) => left[1].sequence - right[1].sequence)
    const [key, last] = stored.at(-1)!
    if (last.kind !== 'team/subscription-events-accepted') throw new Error('expected an acceptance at the ledger head')
    const tampered = { ...last, data: { ...last.data, subscriptionRevision: 1 } }
    const reloaded = await openTable(poolOf([...stored.slice(0, -1), [key, tampered]]))
    expect(() => replayed(reloaded)).toThrow(/pairs revision 1 with a script that revision never carried/)
  })
})
