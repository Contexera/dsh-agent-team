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
import { AGENT_TEAM_HUMAN_MEMBER_ID, AGENT_TEAM_RULES_VERSION, AgentTeamLedger, agentTeamHostActor, agentTeamHumanActor } from '../src/ledger.ts'
import { agentTeamDomainSpec } from '../src/spec.ts'
import { snapshotScript, SUBSCRIPTION_PENDING_MAX, type SubscriptionTriggers } from '../src/subscriptions.ts'
import { webhookTokenHash } from '../src/subscription-webhook.ts'
import type {
  AgentTeamAgentMember,
  AgentTeamHumanActor,
  AgentTeamMainTimelineEntry,
  AgentTeamMemberActor,
  AgentTeamMemberId,
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamProjectRef,
  AgentTeamRequestId,
  AgentTeamSubscription,
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
    presetId: 'team-member', model: { provider: 'mock', model: 'mock' }, privateMemoryPath: `/tmp/${handle}`, state: 'enabled' }
  await ledger.addMember({ requestId: requestId(`add-${handle}`), actor: human, member, handle, description: '', presetId: 'team-member', workspaceId: alpha, projectRefs, model: { provider: 'mock', model: 'mock' }})
  return { memberId, actor: { kind: 'member', memberId, handle } }
}

/** One Project with an Agent owner, an enrolled Agent writer, and an Agent that never joined. */
async function seed(options: { readonly webhookToken?: () => string; readonly rulesVersion?: number } = {}) {
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

  it('allows Workspace-wide metadata discovery without widening full reads', async () => {
    const team = await seed()
    expect(() => team.ledger.assertSubscriptionMetadataAuthority(team.outsider.actor, team.projectRef, alpha)).not.toThrow()
    expect(() => team.ledger.assertSubscriptionReadAuthority(team.outsider.actor, team.projectRef, alpha)).toThrow(/not_project_member/)
    expect(() => team.ledger.assertSubscriptionMetadataAuthority(host, team.projectRef, alpha)).toThrow(/Human or Agent Member/)
  })
})

describe('the Workspace directory', () => {
  it('lists every Project and subscription count without widening Thread or Task content', async () => {
    const team = await seed()
    await team.create(team.owner.actor)
    const pausedRef = subscriptionRefOf(await team.create(team.owner.actor))
    await team.ledger.pauseSubscription({ requestId: requestId('directory-pause'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef: pausedRef, expectedRevision: 1, reason: 'manual' })
    const deletedRef = subscriptionRefOf(await team.create(team.owner.actor))
    await team.ledger.deleteSubscription({ requestId: requestId('directory-delete'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef: deletedRef, expectedRevision: 1 })
    const otherProject = (await team.ledger.createProject({ requestId: requestId('directory-other-project'), actor: human,
      workspaceId: alpha, name: 'other', description: '', memberIds: [] })).value.project.projectRef
    await team.ledger.startThread({ requestId: requestId('directory-own-task'), actor: human, workspaceId: alpha,
      projectRef: team.projectRef, kind: 'task', body: 'own task' })
    await team.ledger.startThread({ requestId: requestId('directory-other-task'), actor: human, workspaceId: alpha,
      projectRef: otherProject, kind: 'task', body: 'other task' })

    const outsiderView = team.ledger.view({ workspaceId: alpha, includeWorkspaceDirectory: true, includeCatalog: true,
      topLevelOnly: true, includeActivities: false, direction: 'before' }, team.outsider.memberId)
    expect(outsiderView.projects).toEqual([])
    expect(outsiderView.items).toEqual([])
    expect(outsiderView.tasks).toEqual([])
    expect(outsiderView.directory?.projects.map(entry => entry.project.projectRef)).toEqual([team.projectRef, otherProject])
    expect(outsiderView.directory?.projects[0]).toMatchObject({
      participating: false, ownerIds: [team.owner.memberId], subscriptions: { active: 1, paused: 1 },
    })
    expect(outsiderView.directory?.memberIds).toEqual(expect.arrayContaining([team.owner.memberId, team.writer.memberId, team.outsider.memberId]))

    const filtered = team.ledger.view({ workspaceId: alpha, projectRef: team.projectRef, includeWorkspaceDirectory: true,
      includeCatalog: true }, team.outsider.memberId)
    expect(filtered.directory?.projects).toHaveLength(1)
    expect(filtered.tasks).toEqual([])
    expect(filtered.threads).toEqual([])
    expect(() => team.ledger.view({ workspaceId: alpha, projectRef: team.projectRef }, team.outsider.memberId)).toThrow(/not authorized/)

    const memberView = team.ledger.view({ workspaceId: alpha, includeWorkspaceDirectory: true, includeCatalog: true,
      topLevelOnly: true, includeActivities: false, direction: 'before' }, team.writer.memberId)
    expect(memberView.projects.map(project => project.projectRef)).toEqual([team.projectRef])
    expect(memberView.directory?.projects.map(entry => entry.project.projectRef)).toEqual([team.projectRef, otherProject])
    expect(memberView.directory?.projects.map(entry => entry.participating)).toEqual([true, false])
    expect(memberView.items.map(item => item.message.body)).toEqual(['own task'])
    expect(memberView.tasks.map(task => task.projectRef)).toEqual([team.projectRef])
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

describe('addressed subscription events', () => {
  const current = AGENT_TEAM_RULES_VERSION
  const replayedAt = (table: Table, rulesVersion: number) => new AgentTeamLedger(table, { rulesVersion })

  /** A publish-ready subscription whose events are addressed to `notify`. */
  const addressed = async (team: Seeded, notify: readonly AgentTeamMemberId[]): Promise<AgentTeamSubscriptionRef> => {
    const created = await team.ledger.createSubscription({ requestId: requestId('create'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, name: 'main CI', triggers: { interval: { minutes: 10 } }, script, credentials: [], notify, baselineIds: [] })
    if (!created.committed) throw new Error('expected a committed subscription')
    return created.value.subscription.subscriptionRef
  }

  /** Accept and publish one event, then answer the Main stream entry each reader gets for it. */
  const publishOne = async (team: Seeded, subscriptionRef: AgentTeamSubscriptionRef,
    eventId = 'e1'): Promise<(reader: AgentTeamHumanActor | AgentTeamMemberActor) => AgentTeamMainTimelineEntry | undefined> => {
    await team.ledger.acceptSubscriptionEvents({ requestId: requestId('accept'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, subscriptionRevision: 1, scriptHash: team.scriptHash, events: [{ id: eventId, title: 'Build failed' }] })
    const pending = team.ledger.pendingSubscriptionEvents(subscriptionRef)
    await team.ledger.publishSubscriptionEvent({ requestId: requestId('publish'), actor: host, workspaceId: alpha, projectRef: team.projectRef,
      subscriptionRef, acceptedSequence: pending[0]!.acceptedSequence, eventId })
    return reader => team.ledger.mainStreamHistory(reader, { workspaceId: alpha, projectRef: team.projectRef })
      .entries.find(entry => entry.kind === 'subscription-event' && entry.event.event.id === eventId)
  }

  it('marks only the addressed recipients, and leaves the owners and the Human no Inbox entry', async () => {
    const team = await seed({ rulesVersion: current })
    const subscriptionRef = await addressed(team, [team.writer.memberId])
    const entryFor = await publishOne(team, subscriptionRef)

    const writer = entryFor(team.writer.actor)
    expect(writer).toMatchObject({ unread: true, direct: true })
    const owner = entryFor(team.owner.actor)
    expect(owner).toMatchObject({ unread: false, direct: false })
    const humanView = entryFor(human)
    expect(humanView).toMatchObject({ unread: false, direct: false })
    // The event is still a readable timeline fact for everyone who was not addressed.
    expect(owner?.kind === 'subscription-event' && owner.event.event.title).toBe('Build failed')
    expect(() => replayedAt(team.table, current)).not.toThrow()
  })

  it('publishes an event with an empty recipient set and wakes nobody', async () => {
    const team = await seed({ rulesVersion: current })
    const subscriptionRef = await addressed(team, [])
    const entryFor = await publishOne(team, subscriptionRef)
    expect(entryFor(team.owner.actor)).toMatchObject({ unread: false, direct: false })
    expect(entryFor(team.writer.actor)).toMatchObject({ unread: false, direct: false })
    expect(entryFor(human)).toMatchObject({ unread: false, direct: false })
    expect(() => replayedAt(team.table, current)).not.toThrow()
  })

  it('drops a recipient who has left the Project instead of falling back to an owner', async () => {
    const team = await seed({ rulesVersion: current })
    const subscriptionRef = await addressed(team, [team.writer.memberId])
    await team.ledger.removeMember({ requestId: requestId('remove'), actor: human, memberId: team.writer.memberId })
    const entryFor = await publishOne(team, subscriptionRef)
    expect(entryFor(team.owner.actor)).toMatchObject({ unread: false, direct: false })
    expect(entryFor(human)).toMatchObject({ unread: false, direct: false })
    expect(() => replayedAt(team.table, current)).not.toThrow()
  })

  it('still delivers an automatic failure pause to every owner and the Human, whatever the recipients are', async () => {
    const team = await seed({ rulesVersion: current })
    const subscriptionRef = await addressed(team, [team.writer.memberId])
    await team.ledger.pauseSubscription({ requestId: requestId('pause'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, reason: 'failures' })
    // Addresses decide events, never the Host's own health report about them.
    const pauseOf = (reader: AgentTeamHumanActor | AgentTeamMemberActor): boolean => team.ledger.mainStreamHistory(reader, { workspaceId: alpha, projectRef: team.projectRef })
      .entries.some(entry => entry.kind === 'activity' && entry.activity.kind === 'subscription-paused' && entry.direct)
    expect(pauseOf(team.owner.actor)).toBe(true)
    expect(pauseOf(human)).toBe(true)
    expect(pauseOf(team.writer.actor)).toBe(false)
    expect(() => replayedAt(team.table, current)).not.toThrow()
  })

  it('replays the receipt a build wrote when the addressed event alone advanced the watermark', async () => {
    const team = await seed({ rulesVersion: current })
    const subscriptionRef = await addressed(team, [team.writer.memberId])
    await team.ledger.changeAttention({ requestId: requestId('follow'), actor: team.writer.actor, workspaceId: alpha,
      projectRef: team.projectRef, action: 'follow' })
    await publishOne(team, subscriptionRef)
    await team.ledger.readMainStream({ requestId: requestId('read'), actor: team.writer.actor, workspaceId: alpha, projectRef: team.projectRef })
    const records = [...team.table.entries()].sort((left, right) => left[1].sequence - right[1].sequence)
    const follow = records.find(([, operation]) => operation.kind === 'team/main-attention-changed' && operation.data.memberId === team.writer.memberId)
    if (follow?.[1].kind !== 'team/main-attention-changed') throw new Error('expected the follow record')
    const standing = follow[1].data.inbox.mainAttention?.set[0]
    if (standing === undefined) throw new Error('expected the standing row the follow established')
    const index = records.findIndex(([, operation]) => operation.kind === 'team/main-stream-read' && operation.data.memberId === team.writer.memberId)
    const [key, read] = records[index]!
    if (read.kind !== 'team/main-stream-read') throw new Error('expected the read record')
    // The marker it consumed plus the watermark the event used to move: what a
    // build wrote while a published event still counted as Project news.
    const receipt = (row: typeof standing) => ({ ...read, data: { ...read.data,
      inbox: { ...read.data.inbox, mainAttention: { set: [{ ...row, readThroughSequence: read.data.readThroughSequence }], removed: [] } } } })
    const replay = async (operation: AgentTeamOperation): Promise<AgentTeamLedger> =>
      new AgentTeamLedger(await openTable(poolOf([...records.slice(0, index), [key, operation], ...records.slice(index + 1)])), { rulesVersion: current })
    const replayed = await replay(receipt(standing))
    await replayed.initialize()
    // Replayed as written, so the read still holds and nothing is left unread.
    expect(replayed.mainStreamHistory(team.writer.actor, { workspaceId: alpha, projectRef: team.projectRef }).standing)
      .toMatchObject({ following: true, unreadCount: 0, directCount: 0 })
    // The acceptance is that one row: a standing row this read never moved still fails.
    await expect(replay(receipt({ ...standing, startSequence: standing.startSequence + 1 })))
      .rejects.toThrow('invalid Main stream read receipt')
  })

  it('drops a departed recipient before a lifecycle write carries the record forward', async () => {
    const team = await seed({ rulesVersion: current })
    const subscriptionRef = await addressed(team, [team.owner.memberId, team.writer.memberId])
    const written = new Set([...team.table.entries()].map(([key]) => key))
    await team.ledger.removeMember({ requestId: requestId('remove'), actor: human, memberId: team.writer.memberId })
    // Every transition stores the prior record whole, so an address that can no
    // longer receive has to be gone by the time the next one is written.
    await team.ledger.pauseSubscription({ requestId: requestId('pause'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, reason: 'manual' })
    await team.ledger.resumeSubscription({ requestId: requestId('resume'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1 })
    await team.ledger.updateSubscription({ requestId: requestId('update'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, name: 'main CI (2)', triggers: { interval: { minutes: 5 } },
      script, credentials: [] })
    await team.ledger.deleteSubscription({ requestId: requestId('delete'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 2 })

    expect(team.ledger.subscription(subscriptionRef)?.notify).toEqual([team.owner.memberId])
    // The create keeps the address it was written with; every record after the
    // removal must not, whatever transition wrote it.
    for (const [key, operation] of team.table.entries()) {
      if (written.has(key)) continue
      const record = (operation.data as { readonly subscription?: AgentTeamSubscription }).subscription
      if (record?.notify !== undefined) expect(record.notify).not.toContain(team.writer.memberId)
    }
    expect(() => replayedAt(team.table, current)).not.toThrow()
  })

  it('drops a departed recipient when a webhook reset carries the record forward', async () => {
    const team = await seed({ rulesVersion: current })
    const created = await team.ledger.createSubscription({ requestId: requestId('create'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, name: 'main CI', triggers: { webhook: true }, script, credentials: [],
      notify: [team.owner.memberId, team.writer.memberId], baselineIds: [] })
    if (!created.committed) throw new Error('expected a committed subscription')
    const subscriptionRef = created.value.subscription.subscriptionRef
    await team.ledger.removeMember({ requestId: requestId('remove'), actor: human, memberId: team.writer.memberId })
    await team.ledger.resetSubscriptionWebhook({ requestId: requestId('reset'), actor: team.owner.actor, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1 })

    expect(team.ledger.subscription(subscriptionRef)?.notify).toEqual([team.owner.memberId])
    expect(() => replayedAt(team.table, current)).not.toThrow()
  })

  it('drops a departed creator before the Host carries an upgraded record into a failure pause', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    const records = [...team.table.entries()].sort((left, right) => left[1].sequence - right[1].sequence)
    const [key, last] = records.at(-1)!
    if (last.kind !== 'team/subscription-created') throw new Error('expected the create at the ledger head')
    const { notify: _dropped, ...legacy } = last.data.subscription
    const table = await openTable(poolOf([...records.slice(0, -1), [key, { ...last, data: { ...last.data, subscription: legacy } }]]))
    const reloaded = new AgentTeamLedger(table, { rulesVersion: current })
    await reloaded.initialize()

    // The creator reads back as the only recipient of a record that predates
    // addressing; once it leaves, the Host's own pause must not store its
    // address, or the next boot cannot load the ledger.
    await reloaded.removeMember({ requestId: requestId('remove'), actor: human, memberId: team.owner.memberId })
    await reloaded.pauseSubscription({ requestId: requestId('pause'), actor: host, workspaceId: alpha,
      projectRef: team.projectRef, subscriptionRef, expectedRevision: 1, reason: 'failures' })

    expect(reloaded.subscription(subscriptionRef)?.notify).toEqual([])
    expect(() => replayedAt(table, current)).not.toThrow()
  })

  it('accepts the Human as an addressed recipient and wakes only them', async () => {
    const team = await seed({ rulesVersion: current })
    const subscriptionRef = await addressed(team, [AGENT_TEAM_HUMAN_MEMBER_ID])
    const entryFor = await publishOne(team, subscriptionRef)
    expect(entryFor(human)).toMatchObject({ unread: true, direct: true })
    expect(entryFor(team.owner.actor)).toMatchObject({ unread: false, direct: false })
    expect(() => replayedAt(team.table, current)).not.toThrow()
  })

  it('reads a record written before recipients existed as its Creating Member alone', async () => {
    const team = await seed()
    const subscriptionRef = subscriptionRefOf(await team.create(team.owner.actor))
    const records = [...team.table.entries()].sort((left, right) => left[1].sequence - right[1].sequence)
    const [key, last] = records.at(-1)!
    if (last.kind !== 'team/subscription-created') throw new Error('expected the create at the ledger head')
    const { notify: _dropped, ...legacy } = last.data.subscription
    const tampered = { ...last, data: { ...last.data, subscription: legacy } }
    const reloaded = new AgentTeamLedger(await openTable(poolOf([...records.slice(0, -1), [key, tampered]])), { rulesVersion: current })
    await reloaded.initialize()

    expect(reloaded.subscription(subscriptionRef)?.notify).toEqual([team.owner.memberId])
    // The legacy default is the creator, not the old owner-wide delivery: the
    // Human is the discriminator, since the previous rule always reached them.
    const legacyTeam = { ...team, ledger: reloaded }
    const entryFor = await publishOne(legacyTeam, subscriptionRef, 'legacy')
    expect(entryFor(team.owner.actor)).toMatchObject({ unread: true, direct: true })
    expect(entryFor(human)).toMatchObject({ unread: false, direct: false })
  })
})
