/**
 * Operation protocol coverage — a test contract, never a runtime authority.
 *
 * One row per `AgentTeamOperation['kind']`, closed at compile time by the
 * `Record<...>` annotation below: adding or dropping a kind in the union fails
 * typecheck until this table declares its row. Each row pins the five surfaces
 * that express that kind's protocol:
 *
 * - `stored` round-trips through the durable Zod schema, and is typed against
 *   the union member, so a required field added to the type breaks its fixture;
 * - `retry` drives the kind's real public request path twice: the same request
 *   id must resolve the stored record (running the request comparator and the
 *   committed-result mapper exactly as production does), and a mutated payload
 *   under that id must collide;
 * - `legacy` declares which load stage may rewrite the record (`normalize`
 *   vs prior-projection `repair`), verified behaviorally as rewrite/identity;
 * - `intent` declares the change-scope and Inbox effect, so an intentional
 *   no-op is a stated row rather than an empty-looking omission.
 *
 * Deliberately not covered here: projection apply, change-scope derivation,
 * thread-ref indexing and replay validation keep their own suites. These
 * fixtures are durable *shapes*, never a replayable history — which is why
 * retry coverage injects the stored record under its request id instead of
 * committing it: the idempotent branch reads `byRequest` before any
 * authorization or projection work, so comparator and mapper run against the
 * protocol shape without fabricating a valid ledger history around it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { AgentTeamLedger, agentTeamHumanActor, threadReadTargetOf } from '../src/ledger.ts'
import { AGENT_TEAM_HUMAN_MEMBER_ID } from '../src/index.ts'
import type { AgentTeamLedgerResult } from '../src/ledger.ts'
import { agentTeamDomainSpec, agentTeamOperationSchema } from '../src/spec.ts'
import type {
  AgentTeamActivityRef,
  AgentTeamActor,
  AgentTeamAgentMember,
  AgentTeamProject,
  AgentTeamProjectRef,
  AgentTeamChangeScope,
  AgentTeamClaim,
  AgentTeamHostActor,
  AgentTeamHumanActor,
  AgentTeamInboxDelta,
  AgentTeamMainActivity,
  AgentTeamMemberActor,
  AgentTeamMemberId,
  AgentTeamMessageRef,
  AgentTeamOperation,
  AgentTeamOperationId,
  AgentTeamOperationReceipt,
  AgentTeamRequestId,
  AgentTeamTask,
  AgentTeamTaskRef,
  AgentTeamThread,
  AgentTeamThreadReadReceipt,
  AgentTeamThreadRef,
} from '../src/types.ts'

type Op<K extends AgentTeamOperation['kind']> = Extract<AgentTeamOperation, { readonly kind: K }>

const alpha = WorkspaceId('workspace:alpha')
const beta = WorkspaceId('workspace:beta')
const gamma = WorkspaceId('workspace:gamma')
const instant = '2026-01-01T00:00:00.000Z'
const human = agentTeamHumanActor()
const requestId = (value: string): AgentTeamRequestId => value as AgentTeamRequestId
const previousOperationId = 'operation:protocol-seed' as AgentTeamOperationId
const memberId = 'member:protocol' as AgentTeamMemberId
const memberHandle = 'protocol-agent'
const memberActor: AgentTeamMemberActor = { kind: 'member', memberId, handle: memberHandle }
const hostActor: AgentTeamHostActor = { kind: 'host', handle: 'agent-team' }
const otherMemberId = 'member:protocol-other' as AgentTeamMemberId

/**
 * Deterministic seed refs: the seeded ledger counts one ref per kind, so the
 * first Project and the first two Threads in the seed take exactly these
 * values, and every fixture below can pin them without knowing random ids.
 * `seedLedger` asserts each one so a seed-order change fails loudly.
 */
const projectRef = 'project:protocol-1' as AgentTeamProjectRef
const humanThread = 'thread:protocol-1' as AgentTeamThreadRef
const memberThread = 'thread:protocol-2' as AgentTeamThreadRef

const emptyInbox: AgentTeamInboxDelta = {
  attention: { set: [], removed: [] },
  directMarkers: { added: [], removed: [] },
  activityMarkers: { added: [], removed: [] },
}
const fixtureMember: AgentTeamAgentMember = {
  memberId,
  sessionId: SessionId('session:protocol'),
  workspaceId: alpha,
  handle: memberHandle,
  description: 'Protocol fixture Agent',
  presetId: 'team-member',
  privateMemoryPath: '/tmp/protocol-member',
  state: 'enabled',
}
const fixtureProject: AgentTeamProject = {
  projectRef,
  workspaceId: alpha,
  name: 'protocol',
  description: 'Protocol seed Project',
  createdAtSequence: 2,
  state: 'active',
}
const fixtureTask: AgentTeamTask = {
  taskRef: 'task:protocol-fixture' as AgentTeamTaskRef,
  projectRef,
  threadRef: humanThread,
  status: 'in_progress',
  resolution: 'open',
}
const taskfulThread: AgentTeamThread = { threadRef: humanThread, taskRef: fixtureTask.taskRef, revision: 6 }
const plainThread: AgentTeamThread = { threadRef: humanThread, revision: 6 }
const fixtureClaimRef = 'claim:protocol-fixture' as AgentTeamClaim['claimRef']

function opBase<A extends AgentTeamActor>(operationId: string, value: string, sequence: number, actor: A = human as A) {
  return {
    sequence,
    operationId: operationId as AgentTeamOperationId,
    requestId: requestId(value),
    occurredAt: instant,
    actor,
  }
}

const initialized: Op<'team/initialized'> = {
  ...opBase('operation:protocol-01', 'request:protocol-initialized', 1),
  previousOperationId: null,
  kind: 'team/initialized',
  data: { humanMemberId: human.memberId },
}

const projectCreated: Op<'team/project-created'> = {
  ...opBase('operation:protocol-02', 'request:protocol-project-created', 2),
  previousOperationId,
  kind: 'team/project-created',
  data: { workspaceId: alpha, project: fixtureProject, memberIds: [memberId] },
}

const memberAdded: Op<'team/member-added'> = {
  ...opBase('operation:protocol-03', 'request:protocol-member-added', 3),
  previousOperationId,
  kind: 'team/member-added',
  data: { member: fixtureMember, projectRefs: [] },
}

const memberSuspended: Op<'team/member-suspended'> = {
  ...opBase('operation:protocol-04', 'request:protocol-member-suspended', 4),
  previousOperationId,
  kind: 'team/member-suspended',
  data: { member: { ...fixtureMember, state: 'suspended' } },
}

const memberResumed: Op<'team/member-resumed'> = {
  ...opBase('operation:protocol-05', 'request:protocol-member-resumed', 5),
  previousOperationId,
  kind: 'team/member-resumed',
  data: { member: fixtureMember },
}

const memberArchived: Op<'team/member-archived'> = {
  ...opBase('operation:protocol-06', 'request:protocol-member-archived', 6),
  previousOperationId,
  kind: 'team/member-archived',
  data: {
    member: { ...fixtureMember, state: 'archived' },
    claims: [],
    activities: [],
    tasks: [],
    threads: [],
    inbox: emptyInbox,
  },
}

const memberSessionRestarted: Op<'team/member-session-restarted'> = {
  ...opBase('operation:protocol-07', 'request:protocol-member-session-restarted', 7),
  previousOperationId,
  kind: 'team/member-session-restarted',
  data: { member: fixtureMember },
}

const memberContextCleared: Op<'team/member-context-cleared'> = {
  ...opBase('operation:protocol-08', 'request:protocol-member-context-cleared', 8),
  previousOperationId,
  kind: 'team/member-context-cleared',
  data: { member: fixtureMember },
}

const memberSessionRenewed: Op<'team/member-session-renewed'> = {
  ...opBase('operation:protocol-09', 'request:protocol-member-session-renewed', 9),
  previousOperationId,
  kind: 'team/member-session-renewed',
  data: { member: { ...fixtureMember, sessionId: SessionId('session:protocol-next') }, previousSessionId: SessionId('session:protocol') },
}

const memberSessionRolledOver: Op<'team/member-session-rolled-over'> = {
  ...opBase('operation:protocol-10', 'request:protocol-member-session-rolled-over', 10, memberActor),
  previousOperationId,
  kind: 'team/member-session-rolled-over',
  data: {
    member: { ...fixtureMember, sessionId: SessionId('session:protocol-next') },
    previousSessionId: SessionId('session:protocol'),
    newSessionId: SessionId('session:protocol-next'),
    handoffEventSeq: SessionSeq(7),
    trigger: 'model',
  },
}

const memberSessionRecycled: Op<'team/member-session-recycled'> = {
  ...opBase('operation:protocol-28', 'request:protocol-member-session-recycled', 28, hostActor),
  previousOperationId,
  kind: 'team/member-session-recycled',
  data: {
    member: { ...fixtureMember, sessionId: SessionId('session:protocol-fresh') },
    previousSessionId: SessionId('session:protocol'),
    newSessionId: SessionId('session:protocol-fresh'),
  },
}

const projectUpdated: Op<'team/project-updated'> = {
  ...opBase('operation:protocol-11', 'request:protocol-project-updated', 11),
  previousOperationId,
  kind: 'team/project-updated',
  data: { workspaceId: alpha, project: fixtureProject },
}

const memberUpdated: Op<'team/member-updated'> = {
  ...opBase('operation:protocol-12', 'request:protocol-member-updated', 12),
  previousOperationId,
  kind: 'team/member-updated',
  data: { member: fixtureMember },
}

const projectMemberAdded: Op<'team/project-member-added'> = {
  ...opBase('operation:protocol-13', 'request:protocol-project-member-added', 13),
  previousOperationId,
  kind: 'team/project-member-added',
  data: { workspaceId: alpha, projectRef, memberId },
}

const projectMemberRemoved: Op<'team/project-member-removed'> = {
  ...opBase('operation:protocol-14', 'request:protocol-project-member-removed', 14),
  previousOperationId,
  kind: 'team/project-member-removed',
  data: {
    workspaceId: alpha,
    projectRef,
    memberId,
    claims: [],
    activities: [],
    tasks: [],
    threads: [],
    inbox: emptyInbox,
  },
}

const memberWorkspaceJoined: Op<'team/member-workspace-joined'> = {
  ...opBase('operation:protocol-15', 'request:protocol-member-workspace-joined', 15),
  previousOperationId,
  kind: 'team/member-workspace-joined',
  data: { workspaceId: beta, memberId },
}

const memberWorkspaceLeft: Op<'team/member-workspace-left'> = {
  ...opBase('operation:protocol-16', 'request:protocol-member-workspace-left', 16),
  previousOperationId,
  kind: 'team/member-workspace-left',
  data: {
    workspaceId: beta,
    memberId,
    claims: [],
    activities: [],
    tasks: [],
    threads: [],
    inbox: emptyInbox,
  },
}

const projectArchived: Op<'team/project-archived'> = {
  ...opBase('operation:protocol-17', 'request:protocol-project-archived', 17),
  previousOperationId,
  kind: 'team/project-archived',
  data: {
    workspaceId: alpha,
    project: { ...fixtureProject, state: 'archived' },
    claims: [],
    activities: [],
    tasks: [],
    threads: [],
    inbox: emptyInbox,
  },
}

const messageSent: Op<'team/message-sent'> = {
  ...opBase('operation:protocol-18', 'request:protocol-message-sent', 18),
  previousOperationId,
  kind: 'team/message-sent',
  data: {
    workspaceId: alpha,
    mentions: [],
    message: {
      messageRef: 'message:protocol-fixture-1' as AgentTeamMessageRef,
      projectRef,
      threadRef: humanThread,
      sender: human.memberId,
      body: 'protocol fixture message',
      topLevel: true,
      sequence: 4,
      occurredAt: instant,
    },
    thread: plainThread,
    inbox: emptyInbox,
  },
}

const threadReplied: Op<'team/thread-replied'> = {
  ...opBase('operation:protocol-19', 'request:protocol-thread-replied', 19),
  previousOperationId,
  kind: 'team/thread-replied',
  data: {
    workspaceId: alpha,
    baseRevision: 4,
    mentions: [],
    message: {
      messageRef: 'message:protocol-fixture-2' as AgentTeamMessageRef,
      projectRef,
      threadRef: humanThread,
      sender: human.memberId,
      body: 'protocol fixture reply',
      topLevel: false,
      sequence: 5,
      occurredAt: instant,
    },
    thread: { threadRef: humanThread, revision: 5 },
    inbox: emptyInbox,
  },
}

const threadPromoted: Op<'team/thread-promoted'> = {
  ...opBase('operation:protocol-20', 'request:protocol-thread-promoted', 20),
  previousOperationId,
  kind: 'team/thread-promoted',
  data: {
    workspaceId: alpha,
    baseRevision: 4,
    activity: {
      activityRef: 'activity:protocol-promote' as AgentTeamActivityRef,
      kind: 'promote',
      taskRef: fixtureTask.taskRef,
      threadRef: humanThread,
      actor: human.memberId,
      sequence: 20,
    },
    task: fixtureTask,
    thread: taskfulThread,
    inbox: emptyInbox,
  },
}

function claimOperation(
  kind: 'team/claim-created' | 'team/claim-done' | 'team/claim-released',
  operationId: string,
  value: string,
  sequence: number,
  activityKind: 'claim' | 'done' | 'release',
  state: 'active' | 'done' | 'released',
): Op<typeof kind> {
  return {
    ...opBase(operationId, value, sequence, memberActor),
    previousOperationId,
    kind,
    data: {
      workspaceId: alpha,
      baseRevision: 4,
      activity: {
        activityRef: `activity:protocol-claim-${activityKind}` as AgentTeamActivityRef,
        kind: activityKind,
        taskRef: fixtureTask.taskRef,
        threadRef: humanThread,
        actor: memberId,
        sequence,
        claimRef: fixtureClaimRef,
      },
      claim: {
        claimRef: fixtureClaimRef,
        taskRef: fixtureTask.taskRef,
        threadRef: humanThread,
        owner: memberId,
        direction: 'finish the protocol guard',
        normalizedDirection: 'finish the protocol guard',
        state,
      },
      task: fixtureTask,
      thread: taskfulThread,
      inbox: emptyInbox,
    },
  }
}

const claimCreated = claimOperation('team/claim-created', 'operation:protocol-21', 'request:protocol-claim-created', 21, 'claim', 'active')
const claimDone = claimOperation('team/claim-done', 'operation:protocol-22', 'request:protocol-claim-done', 22, 'done', 'done')
const claimReleased = claimOperation('team/claim-released', 'operation:protocol-23', 'request:protocol-claim-released', 23, 'release', 'released')

const taskChanged: Op<'team/task-changed'> = {
  ...opBase('operation:protocol-24', 'request:protocol-task-changed', 24),
  previousOperationId,
  kind: 'team/task-changed',
  data: {
    workspaceId: alpha,
    baseRevision: 4,
    activity: {
      activityRef: 'activity:protocol-task-accept' as AgentTeamActivityRef,
      kind: 'accept',
      taskRef: fixtureTask.taskRef,
      threadRef: humanThread,
      actor: human.memberId,
      sequence: 24,
    },
    task: fixtureTask,
    thread: taskfulThread,
    claims: [],
    inbox: emptyInbox,
  },
}

const threadAttentionChanged: Op<'team/thread-attention-changed'> = {
  ...opBase('operation:protocol-25', 'request:protocol-thread-attention-changed', 25),
  previousOperationId,
  kind: 'team/thread-attention-changed',
  data: { workspaceId: alpha, action: 'follow', memberId: human.memberId, thread: plainThread, inbox: emptyInbox },
}

/** The receipt form every current read writes: the record's current shape. */
const threadReadReceipt: AgentTeamThreadReadReceipt = {
  workspaceId: alpha,
  memberId: human.memberId,
  threadRef: humanThread,
  readThroughSequence: 3,
  inbox: emptyInbox,
}

const threadRead: Op<'team/thread-read'> = {
  ...opBase('operation:protocol-26', 'request:protocol-thread-read', 26),
  previousOperationId,
  kind: 'team/thread-read',
  data: threadReadReceipt,
}

/**
 * The pre-receipt snapshot: the same protocol kind in its legacy stored shape,
 * with a bare anchor Message (no `occurredAt`) exactly as ledgers written
 * before the envelope stored it, so load-time stamping stays observable.
 */
const threadReadSnapshot: Op<'team/thread-read'> = {
  ...opBase('operation:protocol-26-legacy', 'request:protocol-thread-read-snapshot', 26),
  previousOperationId,
  kind: 'team/thread-read',
  data: {
    workspaceId: alpha,
    memberId: human.memberId,
    thread: plainThread,
    claims: [],
    anchor: {
      messageRef: 'message:protocol-legacy-anchor' as AgentTeamMessageRef,
      projectRef,
      threadRef: humanThread,
      sender: human.memberId,
      body: 'legacy anchor without an envelope instant',
      topLevel: true,
      sequence: 3,
    },
    anchorMentions: [],
    facts: [],
    readThroughSequence: 3,
    remainingUnreadCount: 0,
    inbox: emptyInbox,
  },
}

const memberRemoved: Op<'team/member-removed'> = {
  ...opBase('operation:protocol-27', 'request:protocol-member-removed', 27),
  previousOperationId,
  kind: 'team/member-removed',
  data: {
    member: { ...fixtureMember, state: 'inactive' },
    claims: [],
    activities: [],
    tasks: [],
    threads: [],
    inbox: emptyInbox,
  },
}

const rulesVersionAdopted: Op<'team/rules-version-adopted'> = {
  ...opBase('operation:protocol-29', 'agent-team:rules-version-2', 29, hostActor),
  previousOperationId,
  kind: 'team/rules-version-adopted',
  data: { version: 2 },
}

const ownerActivity = (kind: 'owner-added' | 'owner-removed', sequence: number): AgentTeamMainActivity => ({
  activityRef: `activity:protocol-${kind}` as AgentTeamActivityRef, projectRef, kind, memberId, actor: human.memberId, sequence, occurredAt: instant,
})
const ownerInbox = (activity: AgentTeamMainActivity): AgentTeamInboxDelta => ({
  ...emptyInbox,
  mainMarkers: { added: [{ memberId, projectRef, activityRef: activity.activityRef, sequence: activity.sequence }], removed: [] },
})

const projectOwnerAdded: Op<'team/project-owner-added'> = {
  ...opBase('operation:protocol-30', 'request:protocol-project-owner-added', 30),
  previousOperationId,
  kind: 'team/project-owner-added',
  data: { workspaceId: alpha, projectRef, memberId, activity: ownerActivity('owner-added', 30), inbox: ownerInbox(ownerActivity('owner-added', 30)) },
}

const projectOwnerRemoved: Op<'team/project-owner-removed'> = {
  ...opBase('operation:protocol-31', 'request:protocol-project-owner-removed', 31),
  previousOperationId,
  kind: 'team/project-owner-removed',
  data: { workspaceId: alpha, projectRef, memberId, activity: ownerActivity('owner-removed', 31), inbox: ownerInbox(ownerActivity('owner-removed', 31)) },
}

const mainMessagePosted: Op<'team/main-message-posted'> = {
  ...opBase('operation:protocol-32', 'request:protocol-main-message-posted', 32),
  previousOperationId,
  kind: 'team/main-message-posted',
  data: {
    workspaceId: alpha,
    mentions: [memberId],
    message: { messageRef: 'message:protocol-main-1' as AgentTeamMessageRef, projectRef, scope: 'main', sender: human.memberId,
      body: 'protocol fixture main message', sequence: 32, occurredAt: instant },
    inbox: { ...emptyInbox, mainMarkers: { added: [{ memberId, projectRef, messageRef: 'message:protocol-main-1' as AgentTeamMessageRef, sequence: 32 }], removed: [] } },
  },
}

const mainStreamRead: Op<'team/main-stream-read'> = {
  ...opBase('operation:protocol-33', 'request:protocol-main-stream-read', 33),
  previousOperationId,
  kind: 'team/main-stream-read',
  data: { workspaceId: alpha, projectRef, memberId: human.memberId, readThroughSequence: 3, inbox: emptyInbox },
}

const threadStarted: Op<'team/thread-started'> = {
  ...opBase('operation:protocol-34', 'request:protocol-thread-started', 34),
  previousOperationId,
  kind: 'team/thread-started',
  data: {
    workspaceId: alpha,
    projectRef,
    kind: 'discussion',
    mentions: [],
    anchor: { messageRef: 'message:protocol-started-1' as AgentTeamMessageRef, projectRef, threadRef: 'thread:protocol-started' as AgentTeamThreadRef,
      sender: human.memberId, body: 'protocol fixture started thread', topLevel: true, sequence: 34, occurredAt: instant },
    thread: { threadRef: 'thread:protocol-started' as AgentTeamThreadRef, revision: 34 },
    inbox: emptyInbox,
  },
}

const dmSent: Op<'team/dm-sent'> = {
  ...opBase('operation:protocol-28', 'request:protocol-dm-sent', 28, memberActor),
  previousOperationId,
  kind: 'team/dm-sent',
  data: { workspaceId: alpha, senderMemberId: memberId, recipientMemberId: memberId, body: 'protocol fixture dm' },
}

/** What one same-request retry must produce: resolved, never a second commit. */
interface RetryOutcome {
  readonly committed: boolean
  readonly value: unknown
}

interface RetryCoverage {
  /** The exact retry that must resolve the stored record through comparator and mapper. */
  readonly same: () => Promise<RetryOutcome>
  /** The same request id with one payload field changed: must collide, not resolve. */
  readonly changed: () => Promise<unknown>
}

interface ProtocolRow {
  /** The current durable stored shape; must round-trip the schema and typecheck against its union member. */
  readonly stored: AgentTeamOperation
  /** Other stored shapes of the same kind the loader still accepts; none for current-only kinds. */
  readonly legacyShapes: readonly AgentTeamOperation[]
  /** Same-request comparison plus committed-result mapping, or an explicit replay-only absence. */
  readonly retry: RetryCoverage | { readonly replayOnly: string }
  /** Which load stage may rewrite this kind: `normalize` on decode, `repair` from a prior projection. */
  readonly legacy: { readonly normalize: 'none' | 'pre-receipt-stamp'; readonly repair: 'none' | 'project-inbox-legacy-scope' }
  /** Declared scope and Inbox effect; `no-op` and `wake-all` are statements, not omissions. */
  readonly intent: { readonly scopes: 'wake-all' | 'no-op' | 'derived'; readonly inbox: 'delta' | 'none' }
}

const mappedCommitted = <T extends { readonly kind: string }>(value: T): Extract<T, { readonly kind: 'committed' }> => {
  if (value.kind !== 'committed') throw new Error(`expected the committed-result mapping, received '${value.kind}'`)
  return value as Extract<T, { readonly kind: 'committed' }>
}

const receiptOf = (value: unknown): AgentTeamOperationReceipt => {
  const carrier = value as { readonly receipt?: unknown; readonly operationId?: unknown }
  if (carrier.receipt !== undefined) return carrier.receipt as AgentTeamOperationReceipt
  if (carrier.operationId !== undefined) return value as AgentTeamOperationReceipt
  throw new Error('committed-result mapping answered without a receipt')
}

const collision = /was reused with a different operation or payload/

interface LedgerInternals {
  readonly state: { readonly byRequest: Map<AgentTeamRequestId, AgentTeamOperation> }
  normalizeOperation(operation: AgentTeamOperation, occurrences: Map<AgentTeamMessageRef, string>, instants: Map<number, string>): AgentTeamOperation
  repairLegacyProjectCleanup(operation: AgentTeamOperation, projection: unknown): AgentTeamOperation
}

const internals = (target: AgentTeamLedger): LedgerInternals => target as unknown as LedgerInternals

let ledger: AgentTeamLedger

/**
 * Closed coverage table. The annotation is the contract: a kind added to (or
 * dropped from) `AgentTeamOperation` fails typecheck here until its row is
 * declared, and every declared surface below is asserted behaviorally.
 */
const protocol: Record<AgentTeamOperation['kind'], ProtocolRow> = {
  'team/initialized': {
    stored: initialized,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.initialize({ requestId: initialized.requestId, actor: human, humanMemberId: human.memberId })
        expect(out.value.operationId, 'the initialize mapping answers with the receipt itself').toBe(initialized.operationId)
        return out
      },
      changed: () => ledger.initialize({ requestId: initialized.requestId, actor: human, humanMemberId: otherMemberId }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'wake-all', inbox: 'none' },
  },
  'team/project-created': {
    stored: projectCreated,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.createProject({
          requestId: projectCreated.requestId,
          actor: human,
          workspaceId: projectCreated.data.workspaceId,
          name: projectCreated.data.project.name,
          description: projectCreated.data.project.description,
          memberIds: projectCreated.data.memberIds,
        })
        expect(out.value.project.projectRef, 'the create mapper answers with the stored Project identity').toBe(projectRef)
        return out
      },
      changed: () => ledger.createProject({
        requestId: projectCreated.requestId,
        actor: human,
        workspaceId: projectCreated.data.workspaceId,
        name: 'protocol-renamed',
        description: projectCreated.data.project.description,
        memberIds: projectCreated.data.memberIds,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/member-added': {
    stored: memberAdded,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.addMember({
          requestId: memberAdded.requestId,
          actor: human,
          workspaceId: memberAdded.data.member.workspaceId,
          handle: memberAdded.data.member.handle,
          description: memberAdded.data.member.description,
          presetId: memberAdded.data.member.presetId,
          projectRefs: memberAdded.data.projectRefs,
          member: memberAdded.data.member,
        })
        expect(out.value.member.memberId, 'the add mapper answers with the stored Member').toBe(memberId)
        return out
      },
      changed: () => ledger.addMember({
        requestId: memberAdded.requestId,
        actor: human,
        workspaceId: memberAdded.data.member.workspaceId,
        handle: memberAdded.data.member.handle,
        description: 'A different description',
        presetId: memberAdded.data.member.presetId,
        projectRefs: memberAdded.data.projectRefs,
        member: memberAdded.data.member,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/member-suspended': {
    stored: memberSuspended,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.suspendMember({ requestId: memberSuspended.requestId, actor: human, memberId })
        expect(out.value.member.state, 'the state mapper answers with the stored lifecycle state').toBe('suspended')
        return out
      },
      changed: () => ledger.suspendMember({ requestId: memberSuspended.requestId, actor: human, memberId: otherMemberId }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/member-resumed': {
    stored: memberResumed,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.resumeMember({ requestId: memberResumed.requestId, actor: human, memberId })
        expect(out.value.member.state, 'the state mapper answers with the stored lifecycle state').toBe('enabled')
        return out
      },
      changed: () => ledger.resumeMember({ requestId: memberResumed.requestId, actor: human, memberId: otherMemberId }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/member-archived': {
    stored: memberArchived,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.archiveMember({ requestId: memberArchived.requestId, actor: human, memberId })
        expect(out.value.member.memberId, 'the archive mapper answers with the stored Member').toBe(memberId)
        expect(out.value.removedAttention, 'the archive mapper answers with its release payload').toEqual([])
        return out
      },
      changed: () => ledger.archiveMember({ requestId: memberArchived.requestId, actor: human, memberId: otherMemberId }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/member-session-restarted': {
    stored: memberSessionRestarted,
    legacyShapes: [],
    retry: {
      replayOnly: 'legacy replay-only kind: no current request path writes it, so it has neither a request comparator nor a result mapper by design',
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/member-context-cleared': {
    stored: memberContextCleared,
    legacyShapes: [],
    retry: {
      replayOnly: 'legacy replay-only kind: no current request path writes it, so it has neither a request comparator nor a result mapper by design',
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/member-session-renewed': {
    stored: memberSessionRenewed,
    legacyShapes: [],
    retry: { replayOnly: 'legacy replay-only kind: the Human clear-context Remote and its renewal writer were removed, so only old-ledger replay reads it' },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/member-session-rolled-over': {
    stored: memberSessionRolledOver,
    legacyShapes: [],
    retry: { replayOnly: 'legacy replay-only kind: the Member-authored rollover path is gone, so only old-ledger replay reads it' },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/member-session-recycled': {
    stored: memberSessionRecycled,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.recycleMemberSession({
          requestId: memberSessionRecycled.requestId,
          actor: hostActor,
          workspaceId: alpha,
          memberId,
          previousSessionId: memberSessionRecycled.data.previousSessionId,
          newSessionId: memberSessionRecycled.data.newSessionId,
        })
        expect(out.value.member.sessionId, 'the recycle mapper answers with the stored Session move').toBe(memberSessionRecycled.data.newSessionId)
        return out
      },
      changed: () => ledger.recycleMemberSession({
        requestId: memberSessionRecycled.requestId,
        actor: hostActor,
        workspaceId: alpha,
        memberId,
        previousSessionId: memberSessionRecycled.data.previousSessionId,
        newSessionId: SessionId('session:protocol-other-fresh'),
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/rules-version-adopted': {
    stored: rulesVersionAdopted,
    legacyShapes: [],
    retry: { replayOnly: 'Host-internal: initialize appends it once per adopted version and skips it when the ledger already carries that version, so no caller request id can retry or collide' },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'no-op', inbox: 'none' },
  },
  'team/project-owner-added': {
    stored: projectOwnerAdded,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.addProjectOwner({ requestId: projectOwnerAdded.requestId, actor: human, ...projectOwnerAdded.data })
        expect(out.value.projectRef, 'the owner mapper answers with the stored Project').toBe(projectRef)
        return out
      },
      changed: () => ledger.addProjectOwner({ requestId: projectOwnerAdded.requestId, actor: human, ...projectOwnerAdded.data, memberId: AGENT_TEAM_HUMAN_MEMBER_ID }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/project-owner-removed': {
    stored: projectOwnerRemoved,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.removeProjectOwner({ requestId: projectOwnerRemoved.requestId, actor: human, ...projectOwnerRemoved.data })
        expect(out.value.projectRef, 'the owner mapper answers with the stored Project').toBe(projectRef)
        return out
      },
      changed: () => ledger.removeProjectOwner({ requestId: projectOwnerRemoved.requestId, actor: human, ...projectOwnerRemoved.data, memberId: AGENT_TEAM_HUMAN_MEMBER_ID }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/project-updated': {
    stored: projectUpdated,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.updateProject({
          requestId: projectUpdated.requestId,
          actor: human,
          workspaceId: projectUpdated.data.workspaceId,
          projectRef: projectUpdated.data.project.projectRef,
          name: projectUpdated.data.project.name,
          description: projectUpdated.data.project.description,
        })
        expect(out.value.project.projectRef, 'the update mapper answers with the stored Project identity').toBe(projectRef)
        return out
      },
      changed: () => ledger.updateProject({
        requestId: projectUpdated.requestId,
        actor: human,
        workspaceId: projectUpdated.data.workspaceId,
        projectRef: projectUpdated.data.project.projectRef,
        name: 'protocol-renamed',
        description: projectUpdated.data.project.description,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/member-updated': {
    stored: memberUpdated,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.updateMember({
          requestId: memberUpdated.requestId,
          actor: human,
          memberId,
          handle: memberUpdated.data.member.handle,
          description: memberUpdated.data.member.description,
        })
        expect(out.value.member.handle, 'the update mapper answers with the stored Member facts').toBe(memberUpdated.data.member.handle)
        return out
      },
      changed: () => ledger.updateMember({
        requestId: memberUpdated.requestId,
        actor: human,
        memberId,
        handle: 'protocol-agent-two',
        description: memberUpdated.data.member.description,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/project-member-added': {
    stored: projectMemberAdded,
    legacyShapes: [],
    retry: { replayOnly: 'retired request path: Project membership is derived from participation now, so nothing writes it — the apply/validate branches stay for old-ledger replay' },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/project-member-removed': {
    stored: projectMemberRemoved,
    legacyShapes: [],
    retry: { replayOnly: 'retired request path: Project membership is derived from participation now, so nothing writes it — the apply/validate branches stay for old-ledger replay' },
    legacy: { normalize: 'none', repair: 'project-inbox-legacy-scope' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/member-workspace-joined': {
    stored: memberWorkspaceJoined,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.joinWorkspace({
          requestId: memberWorkspaceJoined.requestId,
          actor: human,
          workspaceId: memberWorkspaceJoined.data.workspaceId,
          memberId: memberWorkspaceJoined.data.memberId,
        })
        expect(out.value.workspaceId, 'the join mapper answers with the stored Workspace').toBe(beta)
        return out
      },
      changed: () => ledger.joinWorkspace({
        requestId: memberWorkspaceJoined.requestId,
        actor: human,
        workspaceId: gamma,
        memberId: memberWorkspaceJoined.data.memberId,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'none' },
  },
  'team/member-workspace-left': {
    stored: memberWorkspaceLeft,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.leaveWorkspace({
          requestId: memberWorkspaceLeft.requestId,
          actor: human,
          workspaceId: memberWorkspaceLeft.data.workspaceId,
          memberId: memberWorkspaceLeft.data.memberId,
        })
        expect(out.value.workspaceId, 'the leave mapper answers with the stored Workspace').toBe(beta)
        expect(out.value.removedAttention, 'the leave mapper answers with its release payload').toEqual([])
        return out
      },
      changed: () => ledger.leaveWorkspace({
        requestId: memberWorkspaceLeft.requestId,
        actor: human,
        workspaceId: gamma,
        memberId: memberWorkspaceLeft.data.memberId,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/project-archived': {
    stored: projectArchived,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.archiveProject({
          requestId: projectArchived.requestId,
          actor: human,
          workspaceId: projectArchived.data.workspaceId,
          projectRef: projectArchived.data.project.projectRef,
        })
        expect(out.value.project.projectRef, 'the archival mapper answers with the stored Project').toBe(projectRef)
        return out
      },
      changed: () => ledger.archiveProject({
        requestId: projectArchived.requestId,
        actor: human,
        workspaceId: gamma,
        projectRef: projectArchived.data.project.projectRef,
      }),
    },
    legacy: { normalize: 'none', repair: 'project-inbox-legacy-scope' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/main-message-posted': {
    stored: mainMessagePosted,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.postMainMessage({
          requestId: mainMessagePosted.requestId,
          actor: human,
          workspaceId: alpha,
          projectRef,
          body: mainMessagePosted.data.message.body,
          recipients: [memberId],
        })
        expect(mappedCommitted(out.value).message.messageRef, 'the post mapper answers with the stored Message').toBe(mainMessagePosted.data.message.messageRef)
        return out
      },
      changed: () => ledger.postMainMessage({
        requestId: mainMessagePosted.requestId,
        actor: human,
        workspaceId: alpha,
        projectRef,
        body: 'a different body under the same request id',
        recipients: [memberId],
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/main-stream-read': {
    stored: mainStreamRead,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.readMainStream({
          requestId: mainStreamRead.requestId,
          actor: human,
          workspaceId: alpha,
          projectRef,
          readThroughSequence: mainStreamRead.data.readThroughSequence,
        })
        expect(out.value.projectRef, 'the read mapping answers with the Project it derived').toBe(projectRef)
        return out
      },
      changed: () => ledger.readMainStream({
        requestId: mainStreamRead.requestId,
        actor: human,
        workspaceId: alpha,
        projectRef,
        readThroughSequence: 4,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'no-op', inbox: 'delta' },
  },
  'team/thread-started': {
    stored: threadStarted,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.startThread({
          requestId: threadStarted.requestId,
          actor: human,
          workspaceId: alpha,
          projectRef,
          kind: 'discussion',
          body: threadStarted.data.anchor.body,
        })
        expect(mappedCommitted(out.value).message.messageRef, 'the start mapper answers with the stored anchor').toBe(threadStarted.data.anchor.messageRef)
        return out
      },
      changed: () => ledger.startThread({
        requestId: threadStarted.requestId,
        actor: human,
        workspaceId: alpha,
        projectRef,
        kind: 'task',
        body: threadStarted.data.anchor.body,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/message-sent': {
    stored: messageSent,
    legacyShapes: [],
    retry: { replayOnly: 'retired request path: rules version 1 wrote top-level sends and startThread replaced them, so only old-ledger replay reads it' },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/thread-replied': {
    stored: threadReplied,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.reply({
          requestId: threadReplied.requestId,
          actor: human,
          workspaceId: threadReplied.data.workspaceId,
          threadRef: threadReplied.data.thread.threadRef,
          body: threadReplied.data.message.body,
          baseRevision: threadReplied.data.baseRevision,
        })
        expect(mappedCommitted(out.value).message.messageRef, 'the reply mapper answers with the stored Message').toBe(threadReplied.data.message.messageRef)
        return out
      },
      changed: () => ledger.reply({
        requestId: threadReplied.requestId,
        actor: human,
        workspaceId: threadReplied.data.workspaceId,
        threadRef: threadReplied.data.thread.threadRef,
        body: threadReplied.data.message.body,
        baseRevision: threadReplied.data.baseRevision + 1,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/thread-promoted': {
    stored: threadPromoted,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.promoteThread({
          requestId: threadPromoted.requestId,
          actor: human,
          workspaceId: threadPromoted.data.workspaceId,
          threadRef: threadPromoted.data.thread.threadRef,
          baseRevision: threadPromoted.data.baseRevision,
        })
        expect(mappedCommitted(out.value).task.taskRef, 'the promotion mapper answers with the stored Task').toBe(fixtureTask.taskRef)
        return out
      },
      changed: () => ledger.promoteThread({
        requestId: threadPromoted.requestId,
        actor: human,
        workspaceId: threadPromoted.data.workspaceId,
        threadRef: threadPromoted.data.thread.threadRef,
        baseRevision: threadPromoted.data.baseRevision + 1,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/claim-created': {
    stored: claimCreated,
    legacyShapes: [],
    retry: claimRetry(claimCreated, 'claim'),
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/claim-done': {
    stored: claimDone,
    legacyShapes: [],
    retry: claimRetry(claimDone, 'done'),
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/claim-released': {
    stored: claimReleased,
    legacyShapes: [],
    retry: claimRetry(claimReleased, 'release'),
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/task-changed': {
    stored: taskChanged,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.changeTask({
          requestId: taskChanged.requestId,
          actor: human,
          workspaceId: taskChanged.data.workspaceId,
          taskRef: taskChanged.data.task.taskRef,
          action: taskChanged.data.activity.kind as 'accept' | 'close' | 'reopen',
          baseRevision: taskChanged.data.baseRevision,
        })
        expect(mappedCommitted(out.value).task.taskRef, 'the task mapper answers with the stored Task').toBe(fixtureTask.taskRef)
        return out
      },
      changed: () => ledger.changeTask({
        requestId: taskChanged.requestId,
        actor: human,
        workspaceId: taskChanged.data.workspaceId,
        taskRef: taskChanged.data.task.taskRef,
        action: taskChanged.data.activity.kind === 'close' ? 'accept' : 'close',
        baseRevision: taskChanged.data.baseRevision,
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/thread-attention-changed': {
    stored: threadAttentionChanged,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.changeAttention({
          requestId: threadAttentionChanged.requestId,
          actor: human,
          workspaceId: threadAttentionChanged.data.workspaceId,
          threadRef: threadAttentionChanged.data.thread.threadRef,
          action: threadAttentionChanged.data.action,
        })
        expect(out.value.thread.threadRef, 'the attention mapper answers with the stored Thread').toBe(humanThread)
        return out
      },
      changed: () => ledger.changeAttention({
        requestId: threadAttentionChanged.requestId,
        actor: human,
        workspaceId: threadAttentionChanged.data.workspaceId,
        threadRef: threadAttentionChanged.data.thread.threadRef,
        action: 'unfollow',
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/thread-read': {
    stored: threadRead,
    legacyShapes: [threadReadSnapshot],
    retry: {
      same: async () => {
        const out = await ledger.readThread({
          requestId: threadRead.requestId,
          actor: human,
          workspaceId: threadRead.data.workspaceId,
          threadRef: threadReadTargetOf(threadRead.data).threadRef,
        })
        expect(out.value.thread.threadRef, 'the read mapping answers with the picture it derived').toBe(humanThread)
        return out
      },
      changed: () => ledger.readThread({
        requestId: threadRead.requestId,
        actor: human,
        workspaceId: threadRead.data.workspaceId,
        threadRef: memberThread,
      }),
    },
    legacy: { normalize: 'pre-receipt-stamp', repair: 'none' },
    intent: { scopes: 'no-op', inbox: 'delta' },
  },
  'team/member-removed': {
    stored: memberRemoved,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.removeMember({ requestId: memberRemoved.requestId, actor: human, memberId })
        expect(out.value.member.memberId, 'the removal mapper answers with the stored Member').toBe(memberId)
        expect(out.value.removedAttention, 'the removal mapper answers with its release payload').toEqual([])
        return out
      },
      changed: () => ledger.removeMember({ requestId: memberRemoved.requestId, actor: human, memberId: otherMemberId }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'derived', inbox: 'delta' },
  },
  'team/dm-sent': {
    stored: dmSent,
    legacyShapes: [],
    retry: {
      same: async () => {
        const out = await ledger.sendDm({
          requestId: dmSent.requestId,
          actor: memberActor,
          workspaceId: dmSent.data.workspaceId,
          recipientMemberId: dmSent.data.recipientMemberId,
          body: dmSent.data.body,
        })
        expect(out.value.recipient.memberId, 'the DM mapper answers with the resolved stored recipient').toBe(memberId)
        return out
      },
      changed: () => ledger.sendDm({
        requestId: dmSent.requestId,
        actor: memberActor,
        workspaceId: dmSent.data.workspaceId,
        recipientMemberId: dmSent.data.recipientMemberId,
        body: 'a different dm body',
      }),
    },
    legacy: { normalize: 'none', repair: 'none' },
    intent: { scopes: 'no-op', inbox: 'none' },
  },
}

function claimRetry(claim: Op<'team/claim-created' | 'team/claim-done' | 'team/claim-released'>, action: 'claim' | 'done' | 'release'): RetryCoverage {
  return {
    same: async () => {
      const out = await ledger.changeClaim({
        requestId: claim.requestId,
        actor: memberActor,
        workspaceId: claim.data.workspaceId,
        taskRef: claim.data.task.taskRef,
        action,
        baseRevision: claim.data.baseRevision,
        ...(action === 'claim' ? { direction: claim.data.claim.direction } : { claimRef: claim.data.claim.claimRef }),
      })
      expect(mappedCommitted(out.value).claim.claimRef, 'the claim mapper answers with the stored Claim').toBe(fixtureClaimRef)
      return out
    },
    changed: () => ledger.changeClaim({
      requestId: claim.requestId,
      actor: memberActor,
      workspaceId: claim.data.workspaceId,
      taskRef: claim.data.task.taskRef,
      action,
      baseRevision: claim.data.baseRevision + 1,
      ...(action === 'claim' ? { direction: claim.data.claim.direction } : { claimRef: claim.data.claim.claimRef }),
    }),
  }
}

/** One Project, one enabled Member, and two followed taskless Threads — the projection the fixtures point at. */
async function seedLedger(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  cleanups.push(async () => { await facility.closeAll() })
  const domain = await ctx.storageDomain.open(agentTeamDomainSpec)
  const table = domain.table('operations') as unknown as KvTable<AgentTeamOperationId, AgentTeamOperation>
  const refCounts = new Map<string, number>()
  ledger = new AgentTeamLedger(table, {
    ref: kind => {
      const next = (refCounts.get(kind) ?? 0) + 1
      refCounts.set(kind, next)
      return `${kind}:protocol-${next}`
    },
  })
  await ledger.initialize()
  await ledger.addMember({
    requestId: requestId('seed:add-member'),
    actor: human,
    workspaceId: alpha,
    handle: memberHandle,
    description: fixtureMember.description,
    presetId: fixtureMember.presetId,
    projectRefs: [],
    member: fixtureMember,
  })
  const created = committedValue(await ledger.createProject({
    requestId: requestId('seed:create-project'),
    actor: human,
    workspaceId: alpha,
    name: fixtureProject.name,
    description: fixtureProject.description,
    memberIds: [memberId],
  }))
  expect(created.project.projectRef, 'seed Project must take the deterministic ref the fixtures pin').toBe(projectRef)
  const fromHuman = committedValue(await ledger.startThread({
    requestId: requestId('seed:human-message'), actor: human, workspaceId: alpha, projectRef, body: 'seed human thread', kind: 'discussion',
  }))
  if (fromHuman.kind !== 'committed') throw new Error(`seed message committed as '${fromHuman.kind}'`)
  expect(fromHuman.thread.threadRef, 'seed Thread must take the deterministic ref the fixtures pin').toBe(humanThread)
  const fromMember = committedValue(await ledger.startThread({
    requestId: requestId('seed:member-message'), actor: human, workspaceId: alpha, projectRef, body: 'seed member thread', kind: 'discussion',
  }))
  if (fromMember.kind !== 'committed') throw new Error(`seed message committed as '${fromMember.kind}'`)
  expect(fromMember.thread.threadRef, 'seed Thread must take the deterministic ref the fixtures pin').toBe(memberThread)
  await followThreadForLegacyRepair(human, humanThread, 'seed:follow-human')
  await followThreadForLegacyRepair(memberActor, memberThread, 'seed:follow-member')
}

async function followThreadForLegacyRepair(actor: AgentTeamHumanActor | AgentTeamMemberActor, threadRef: AgentTeamThreadRef, value: string): Promise<void> {
  if (ledger.attentionStatus(actor, { workspaceId: alpha, threadRef }).attention !== undefined) return
  await ledger.changeAttention({ requestId: requestId(value), actor, workspaceId: alpha, threadRef, action: 'follow' })
}

const cleanups: Array<() => Promise<void>> = []

function committedValue<T>(result: AgentTeamLedgerResult<T>): T {
  if (!result.committed) throw new Error(`seed operation did not commit: ${JSON.stringify(result.value)}`)
  return result.value
}

/** Kinds added after the rename: no record ever carried a Channel spelling of their name. */
const kindsBornAsProject: ReadonlySet<AgentTeamOperation['kind']> = new Set(['team/project-owner-added', 'team/project-owner-removed'])

describe('operation protocol coverage', () => {
  beforeAll(async () => { await seedLedger() })
  afterAll(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

  it.each(Object.entries(protocol))('durable schema round-trips the stored shapes of %s', (kind, row) => {
    for (const shape of [row.stored, ...row.legacyShapes]) {
      const parsed = agentTeamOperationSchema.parse(shape)
      expect(parsed, `${kind}: the durable schema must accept this stored shape unchanged`).toEqual(shape)
      expect(parsed.kind, `${kind}: the schema must map the shape back onto its own kind`).toBe(shape.kind)
    }
  })

  it.each(Object.entries(protocol))('the legacy Channel spelling of %s decodes to the same record', (kind, row) => {
    for (const shape of [row.stored, ...row.legacyShapes]) {
      const channelSpelled: unknown = JSON.parse(JSON.stringify(shape)
        .replace(/"team\/project-/g, kindsBornAsProject.has(shape.kind) ? '"team/project-' : '"team/channel-')
        .replace(/"project(Ref|Refs)?":/g, '"channel$1":')
        .replace(/"project:/g, '"channel:'))
      expect(agentTeamOperationSchema.parse(channelSpelled), `${kind}: both spellings must replay as one record`).toEqual(agentTeamOperationSchema.parse(shape))
    }
  })

  it('rejects a record that holds both spellings of one field', () => {
    const stored = row('team/project-member-added').stored as Extract<AgentTeamOperation, { kind: 'team/project-member-added' }>
    const ambiguous = { ...stored, data: { ...stored.data, channelRef: stored.data.projectRef } }
    expect(agentTeamOperationSchema.safeParse(ambiguous).success, 'two spellings of one field must not silently merge').toBe(false)
  })

  it.each(Object.entries(protocol))('same-request comparison and result mapping cover %s', async (kind, row) => {
    const coverage = row.retry
    if ('replayOnly' in coverage) {
      expect(coverage.replayOnly.trim().length, `${kind}: a replay-only row must state why no request path covers it`).toBeGreaterThan(0)
      return
    }
    internals(ledger).state.byRequest.set(row.stored.requestId, row.stored)
    const resolved = await coverage.same()
    expect(resolved.committed, `${kind}: a same-request retry must resolve the stored record, not commit again`).toBe(false)
    expect(receiptOf(resolved.value).operationId, `${kind}: the retry must answer with the stored record's receipt`).toBe(row.stored.operationId)
    await expect(coverage.changed(), `${kind}: a mutated payload under the same request id must collide`).rejects.toThrow(collision)
  })

  it.each(Object.entries(protocol))('declared legacy load policy holds for %s', (kind, row) => {
    const normalize = (shape: AgentTeamOperation): AgentTeamOperation => internals(ledger).normalizeOperation(shape, new Map(), new Map())
    const repair = (shape: AgentTeamOperation): AgentTeamOperation => internals(ledger).repairLegacyProjectCleanup(shape, internals(ledger).state)
    // The current stored shape is never rewritten on decode: normalization only
    // touches the pre-receipt shapes of an older format.
    expect(normalize(row.stored), `${kind}: normalize must leave the current stored shape untouched`).toEqual(row.stored)
    for (const shape of row.legacyShapes) {
      const decoded = normalize(shape)
      if (row.legacy.normalize === 'pre-receipt-stamp') {
        expect(decoded, `${kind}: the declared legacy shape must be stamped on load`).not.toEqual(shape)
      } else {
        expect(decoded, `${kind}: normalize must leave this legacy shape untouched`).toEqual(shape)
      }
    }
    if (row.legacy.normalize === 'pre-receipt-stamp') {
      expect(row.legacyShapes.length, `${kind}: a stamping policy must name the legacy shape it stamps`).toBeGreaterThan(0)
    }
    for (const shape of [row.stored, ...row.legacyShapes]) {
      const fixed = repair(shape)
      if (row.legacy.repair === 'project-inbox-legacy-scope') {
        expect(fixed, `${kind}: the legacy project-scoped inbox must be repaired to the current Thread scope`).not.toEqual(shape)
      } else {
        expect(fixed, `${kind}: prior-projection repair must leave this kind untouched`).toEqual(shape)
      }
    }
  })

  it.each(Object.entries(protocol))('declared scope and Inbox intent holds for %s', (kind, row) => {
    for (const shape of [row.stored, ...row.legacyShapes]) {
      const parsed = agentTeamOperationSchema.parse(shape)
      const scopes = ledger.changeScopesOf(parsed)
      if (row.intent.scopes === 'wake-all') {
        expect(scopes, `${kind}: declared wake-all must derive no scopes at all`).toBeUndefined()
      } else if (row.intent.scopes === 'no-op') {
        expect(scopes, `${kind}: a declared no-op must derive an explicit empty scope list`).toEqual([])
      } else {
        expect(scopes, `${kind}: derived scopes must stay scope objects`).not.toBeUndefined()
        const derived = scopes as readonly AgentTeamChangeScope[]
        expect(derived.length, `${kind}: a derived-scopes kind must wake at least one scope on this Team`).toBeGreaterThan(0)
        for (const scope of derived) expect(['workspace', 'project', 'thread'], `${kind}: scope kinds`).toContain(scope.kind)
      }
      expect('inbox' in parsed.data, `${kind}: declared Inbox intent`).toBe(row.intent.inbox === 'delta')
    }
  })

  it('rejects a stored kind no protocol row and no schema declare', () => {
    const alien = { ...row('team/dm-sent').stored, kind: 'team/protocol-uncovered' }
    expect(agentTeamOperationSchema.safeParse(alien).success, 'an unlisted kind must fail the durable schema').toBe(false)
  })

  it('rejects stored fields no protocol row declares', () => {
    const stored = row('team/initialized').stored
    expect(agentTeamOperationSchema.safeParse({ ...stored, protocolField: 'uncovered' }).success,
      'an unlisted top-level field must fail the durable schema').toBe(false)
    expect(agentTeamOperationSchema.safeParse({ ...stored, data: { ...stored.data, protocolField: 'uncovered' } }).success,
      'an unlisted data field must fail the durable schema').toBe(false)
  })
})

function row<K extends AgentTeamOperation['kind']>(kind: K): ProtocolRow {
  return protocol[kind]
}
