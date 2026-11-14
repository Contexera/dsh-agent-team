import { vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type AgentTeam from '@contexera/dsh-agent-team/host'
import type {
  AgentTeamActivityRef,
  AgentTeamClaimRef,
  AgentTeamMemberId,
  AgentTeamMemberReminder,
  AgentTeamMemberReminderView,
  AgentTeamMessageRef,
  AgentTeamOperationId,
  AgentTeamOperationReceipt,
  AgentTeamProjectRef,
  AgentTeamReminderRef,
  AgentTeamRequestId,
  AgentTeamSubscriptionRef,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
  AgentTeamWorkerRef,
} from '@contexera/dsh-agent-team/types'
import { renderText } from './render-text.ts'

type ToolWorkspaceId = ReturnType<AgentTeam['workspacesForAgent']>[number]['workspaceId']
type ToolSubscriptionRun = ReturnType<AgentTeam['subscriptionLogsForAgent']>['runs'][number]
type ToolSubscriptionRunRef = ToolSubscriptionRun['runRef']
type ToolSubscriptionDeliveryRef = ToolSubscriptionRun['deliveryRef']

export const TEST_WORKSPACE = 'workspace:alpha' as ToolWorkspaceId
export const TEST_PROJECT = 'project:046dd831-c679-4279-b6aa-7813476cf12e' as AgentTeamProjectRef
export const TEST_THREAD = 'thread:d78400e4-4925-4065-87b1-3f81b4a4b5fb' as AgentTeamThreadRef
export const TEST_TASK = 'task:3245ad40-43fd-4191-a416-7dcaf3a340f2' as AgentTeamTaskRef
export const TEST_OWNER = 'member:6e8a5b10-df16-4ec0-943a-63738010953f' as AgentTeamMemberId
export const TEST_REVIEWER = 'member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5' as AgentTeamMemberId
export const TEST_SUBSCRIPTION = 'subscription:8f14e45f-ceea-467f-a7d3-9b0f1a4c7e21' as AgentTeamSubscriptionRef
export const TEST_REMINDER = 'reminder:0f0a1b2c-3d4e-4f50-8a9b-0c1d2e3f4a5b' as AgentTeamReminderRef
export const TEST_WORKER = 'worker:00000000-0000-4000-8000-000000000002' as AgentTeamWorkerRef
export const TEST_RUN = 'run:6b1f2c3d-0000-4000-8000-000000000001' as ToolSubscriptionRunRef

const OCCURRED_AT = '2026-10-25T03:00:00.000Z'
const SCRIPT_HASH = 'a'.repeat(64)

export function committedReceipt(occurredAt = OCCURRED_AT): AgentTeamOperationReceipt {
  return {
    operationId: 'op:1' as AgentTeamOperationId,
    requestId: 'req:1' as AgentTeamRequestId,
    sequence: 9101,
    occurredAt,
  }
}

type ToolHostMethod =
  | 'workspacesForAgent'
  | 'humanHandle'
  | 'members'
  | 'memberForAgent'
  | 'resolveTaskRefs'
  | 'attentionStatusForAgent'
  | 'listClaimsForAgent'
  | 'startThreadForAgent'
  | 'transferTaskForAgent'
  | 'changeTaskForAgent'
  | 'subscriptionsForAgent'
  | 'subscriptionLogsForAgent'
  | 'replaySubscriptionDeliveryForAgent'
  | 'createSubscriptionForAgent'
  | 'updateSubscriptionForAgent'
  | 'readThreadForAgent'
  | 'threadHistoryForAgent'
  | 'memberRemindersForAgent'
  | 'createMemberReminderForAgent'
  | 'cancelMemberReminderForAgent'
  | 'workerStartForAgent'
  | 'workerStopForAgent'
  | 'workerInspectForAgent'
  | 'workerSteerForAgent'

export type ToolHostSurface = Pick<AgentTeam, ToolHostMethod>

export function testMemberStatus(
  memberId: AgentTeamMemberId,
  handle: string,
): ReturnType<AgentTeam['members']>[number] {
  return {
    member: {
      memberId,
      handle,
      description: handle,
      presetId: 'team-member',
      sessionId: SessionId(`session:${handle.toLowerCase()}`),
      workspaceId: TEST_WORKSPACE,
      privateMemoryPath: `/tmp/memory/${handle.toLowerCase()}`,
      state: 'enabled',
    },
    availability: 'active',
    presence: 'available',
    capabilityState: 'applied',
  }
}

export function testSubscription(
  overrides: Partial<ReturnType<AgentTeam['subscriptionLogsForAgent']>['subscription']> = {},
): ReturnType<AgentTeam['subscriptionLogsForAgent']>['subscription'] {
  return {
    subscriptionRef: TEST_SUBSCRIPTION,
    projectRef: TEST_PROJECT,
    name: 'main CI',
    revision: 2,
    state: 'active',
    triggers: { interval: { minutes: 10 } },
    notify: [],
    createdBy: TEST_OWNER,
    createdAt: OCCURRED_AT,
    script: { content: 'true\n', sha256: SCRIPT_HASH, shell: 'bash' },
    credentials: [],
    ...overrides,
  }
}

export function testSubscriptionActivity(
  overrides: Partial<Extract<Awaited<ReturnType<AgentTeam['createSubscriptionForAgent']>>, { kind: 'changed' }>['activity']> = {},
): Extract<Awaited<ReturnType<AgentTeam['createSubscriptionForAgent']>>, { kind: 'changed' }>['activity'] {
  return {
    activityRef: 'activity:sub' as AgentTeamActivityRef,
    projectRef: TEST_PROJECT,
    kind: 'subscription-created',
    subscriptionRef: TEST_SUBSCRIPTION,
    subscriptionName: 'main CI',
    revision: 1,
    actor: TEST_OWNER,
    sequence: 9101,
    occurredAt: OCCURRED_AT,
    ...overrides,
  }
}

export type ToolTestTask = ReturnType<AgentTeam['listClaimsForAgent']>['task']

export function testTask(overrides: Partial<ToolTestTask> = {}): ToolTestTask {
  return {
    taskRef: TEST_TASK,
    projectRef: TEST_PROJECT,
    threadRef: TEST_THREAD,
    status: 'in_review',
    resolution: 'open',
    accountable: TEST_OWNER,
    sourceThreadRefs: [],
    ...overrides,
  }
}

export function testReminder(overrides: Partial<AgentTeamMemberReminder> = {}): AgentTeamMemberReminder {
  return {
    reminderRef: TEST_REMINDER,
    memberId: TEST_OWNER,
    schedule: { kind: 'once', at: '2026-11-04T02:00:00.000Z' },
    note: 'check the build',
    state: 'active',
    createdAt: '2026-11-03T08:00:00.000Z',
    ...overrides,
  }
}

export type ToolTestWorkerRun = Awaited<ReturnType<AgentTeam['workerStartForAgent']>>

export function testWorkerRun(overrides: Partial<ToolTestWorkerRun> = {}): ToolTestWorkerRun {
  return {
    workerRef: TEST_WORKER,
    projectRef: TEST_PROJECT,
    engine: 'codex',
    state: 'running',
    startedAt: '2026-11-09T07:00:00.000Z',
    cwd: '/tmp/worker',
    initiatedBy: TEST_OWNER,
    ...overrides,
  }
}

export type ToolTestWorkerInspection = Awaited<ReturnType<AgentTeam['workerInspectForAgent']>>

export function testWorkerInspection(overrides: Partial<ToolTestWorkerInspection> = {}): ToolTestWorkerInspection {
  return {
    workerRef: TEST_WORKER,
    projectRef: TEST_PROJECT,
    engine: 'codex',
    state: 'failed',
    unconfirmed: false,
    startedAt: '2026-11-09T07:00:00.000Z',
    settledAt: '2026-11-09T07:10:00.000Z',
    summary: 'Team Worker failure (stage: turn; category: unknown).',
    stage: 'turn',
    native: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      turnIds: ['native-turn', 'native-steer'],
      inputIds: ['native-turn', 'native-steer'],
      storage: '/tmp/home/sessions/2026/11/09/rollout-x.jsonl',
    },
    history: {
      kind: 'read',
      withheld: 0,
      truncated: false,
      fragments: [
        { kind: 'session', text: 'Native session record: engine 0.167.0' },
        { kind: 'failure', text: 'Native turn failed after 15674 ms: unexpected status 401 Unauthorized' },
      ],
    },
    ...overrides,
  }
}

export type ToolTestWorkerSteer = Awaited<ReturnType<AgentTeam['workerSteerForAgent']>>

export function testWorkerSteer(overrides: Partial<ToolTestWorkerSteer> = {}): ToolTestWorkerSteer {
  return {
    workerRef: TEST_WORKER,
    engine: 'codex',
    state: 'submitted',
    turnId: 'native-turn',
    runState: 'running',
    ...overrides,
  }
}

type ToolTestThreadAnchor = ReturnType<AgentTeam['threadHistoryForAgent']>['anchor']
type ToolTestThreadHeader = ReturnType<AgentTeam['threadHistoryForAgent']>['thread']
type ToolTestReadThreadResult = Awaited<ReturnType<AgentTeam['readThreadForAgent']>>

const DEFAULT_ANCHOR: ToolTestThreadAnchor = {
  messageRef: 'message:anchor' as AgentTeamMessageRef,
  projectRef: TEST_PROJECT,
  threadRef: TEST_THREAD,
  topLevel: true,
  sender: TEST_OWNER,
  body: 'Can we unify the importers?',
  sequence: 1,
  occurredAt: OCCURRED_AT,
}

const DEFAULT_THREAD_HEADER: ToolTestThreadHeader = {
  threadRef: TEST_THREAD,
  taskRef: TEST_TASK,
  revision: 9100,
}

export function testReadThreadResult(overrides: Partial<ToolTestReadThreadResult> = {}): ToolTestReadThreadResult {
  return {
    thread: DEFAULT_THREAD_HEADER,
    anchor: DEFAULT_ANCHOR,
    anchorMentions: [],
    claims: [],
    facts: [],
    readThroughSequence: 1,
    remainingUnreadCount: 0,
    consumedDirectMarkers: [],
    reminders: [],
    visibleMessageRefs: [],
    visibleActivityRefs: [],
    ...overrides,
  }
}

type AgentArg<K extends ToolHostMethod> = Parameters<AgentTeam[K]>[0]
type RequestArg<K extends ToolHostMethod> = Parameters<AgentTeam[K]>[1]

function buildDefaultToolHost() {
  const defaultSubscription = {
    subscriptionRef: TEST_SUBSCRIPTION,
    projectRef: TEST_PROJECT,
    name: 'main CI',
    revision: 2,
    state: 'active' as const,
    triggers: { interval: { minutes: 10 } },
    notify: [] as readonly AgentTeamMemberId[],
    createdBy: TEST_OWNER,
    createdAt: OCCURRED_AT,
    script: { content: 'true\n', sha256: SCRIPT_HASH, shell: 'bash' as const },
    credentials: [],
  }

  const defaultSubscriptionActivity = {
    activityRef: 'activity:sub' as AgentTeamActivityRef,
    projectRef: TEST_PROJECT,
    kind: 'subscription-created' as const,
    subscriptionRef: TEST_SUBSCRIPTION,
    subscriptionName: 'main CI',
    revision: 1,
    actor: TEST_OWNER,
    sequence: 9101,
    occurredAt: OCCURRED_AT,
  }

  return {
    workspacesForAgent: (_agent: AgentArg<'workspacesForAgent'>) => [
      { workspaceId: TEST_WORKSPACE, path: undefined, default: true },
    ],
    humanHandle: () => 'human',
    members: () => [
      {
        member: {
          memberId: TEST_OWNER,
          handle: 'Tars',
          description: 'Architect',
          presetId: 'team-member',
          sessionId: SessionId('session:owner'),
          workspaceId: TEST_WORKSPACE,
          privateMemoryPath: '/tmp/memory/owner',
          state: 'enabled' as const,
        },
        availability: 'active' as const,
        presence: 'available' as const,
        capabilityState: 'applied' as const,
      },
      {
        member: {
          memberId: TEST_REVIEWER,
          handle: 'Cole',
          description: 'Reviewer',
          presetId: 'team-member',
          sessionId: SessionId('session:reviewer'),
          workspaceId: TEST_WORKSPACE,
          privateMemoryPath: '/tmp/memory/reviewer',
          state: 'enabled' as const,
        },
        availability: 'active' as const,
        presence: 'available' as const,
        capabilityState: 'applied' as const,
      },
    ],
    memberForAgent: (_agent: AgentArg<'memberForAgent'>) => ({
      memberId: TEST_OWNER,
      handle: 'Tars',
      state: 'enabled' as const,
      sessionId: SessionId('session:owner'),
      workspaceId: TEST_WORKSPACE,
      description: 'Architect',
      presetId: 'team-member',
      privateMemoryPath: '/tmp/memory/owner',
    }),
    resolveTaskRefs: (_refs: Parameters<AgentTeam['resolveTaskRefs']>[0]) => ({ resolved: [], missing: [] }),
    attentionStatusForAgent: (_agent: AgentArg<'attentionStatusForAgent'>, _request: RequestArg<'attentionStatusForAgent'>) => ({
      following: true,
      thread: DEFAULT_THREAD_HEADER,
    }),
    listClaimsForAgent: (_agent: AgentArg<'listClaimsForAgent'>, _request: RequestArg<'listClaimsForAgent'>) => ({
      task: testTask(),
      thread: DEFAULT_THREAD_HEADER,
      claims: [],
    }),
    startThreadForAgent: vi.fn(async (_agent: AgentArg<'startThreadForAgent'>, request: RequestArg<'startThreadForAgent'>) => ({
      kind: 'committed' as const,
      receipt: committedReceipt(),
      message: {
        messageRef: 'message:anchor' as AgentTeamMessageRef,
        threadRef: TEST_THREAD,
        projectRef: TEST_PROJECT,
        topLevel: true,
        sender: TEST_OWNER,
        body: request.body,
        mentions: [],
        sequence: 1,
        occurredAt: OCCURRED_AT,
      },
      thread: DEFAULT_THREAD_HEADER,
      task: testTask({
        status: 'todo',
        resolution: 'open',
        ...(request.accountable === undefined ? {} : { accountable: request.accountable }),
        ...(request.sourceThreadRefs === undefined ? {} : { sourceThreadRefs: request.sourceThreadRefs }),
      }),
      attention: [],
      directMarkers: [],
    })),
    transferTaskForAgent: vi.fn(async (_agent: AgentArg<'transferTaskForAgent'>, request: RequestArg<'transferTaskForAgent'>) => ({
      kind: 'committed' as const,
      receipt: committedReceipt(),
      activity: {
        activityRef: 'activity:transfer' as AgentTeamActivityRef,
        kind: 'transfer' as const,
        taskRef: TEST_TASK,
        threadRef: TEST_THREAD,
        actor: TEST_OWNER,
        from: TEST_OWNER,
        to: request.target,
        sequence: 9101,
        occurredAt: OCCURRED_AT,
      },
      task: testTask({ accountable: request.target }),
      thread: { ...DEFAULT_THREAD_HEADER, revision: 9101 },
    })),
    changeTaskForAgent: vi.fn(async (_agent: AgentArg<'changeTaskForAgent'>, request: RequestArg<'changeTaskForAgent'>) => ({
      kind: 'committed' as const,
      receipt: committedReceipt(),
      activity: {
        activityRef: 'activity:accept' as AgentTeamActivityRef,
        kind: request.action,
        taskRef: TEST_TASK,
        threadRef: TEST_THREAD,
        actor: TEST_OWNER,
        acceptedClaimRefs: ['claim:7ad04d38-3889-4414-ac0c-23f73c0b962a' as AgentTeamClaimRef],
        sequence: 9101,
        occurredAt: OCCURRED_AT,
      },
      task: testTask({ status: 'done', resolution: 'accepted' }),
      thread: { ...DEFAULT_THREAD_HEADER, revision: 9101 },
      claims: [],
    })),
    subscriptionsForAgent: vi.fn((_agent: AgentArg<'subscriptionsForAgent'>, _request: RequestArg<'subscriptionsForAgent'>) => ({
      entries: [{ subscription: defaultSubscription, unpublished: 0, eventCount: 0 }],
    })),
    subscriptionLogsForAgent: vi.fn((_agent: AgentArg<'subscriptionLogsForAgent'>, _request: RequestArg<'subscriptionLogsForAgent'>) => ({
      subscription: defaultSubscription,
      runs: [
        {
          runRef: TEST_RUN,
          trigger: 'webhook' as const,
          startedAt: '2026-11-03T09:00:00.000Z',
          durationMs: 42,
          category: 'accepted' as const,
          succeeded: true,
          eventCount: 1,
          exitCode: 0,
          timedOut: false,
          subscriptionRevision: 2,
          scriptHash: SCRIPT_HASH,
          deliveryRef: 'delivery:d1' as ToolSubscriptionDeliveryRef,
          attempt: 3,
          stdoutTail: '{"id":"a","title":"A"}',
          stderrTail: '',
        },
      ],
    })),
    replaySubscriptionDeliveryForAgent: vi.fn(async (_agent: AgentArg<'replaySubscriptionDeliveryForAgent'>, _request: RequestArg<'replaySubscriptionDeliveryForAgent'>) => ({
      kind: 'replayed' as const,
      runRef: TEST_RUN,
      eventCount: 1,
      delivery: {
        deliveryRef: 'delivery:d1' as NonNullable<ToolSubscriptionDeliveryRef>,
        receivedRevision: 1,
        receivedScriptHash: SCRIPT_HASH,
        receivedAt: '2026-11-01T00:00:00.000Z',
        expiresAt: '2026-11-08T00:00:00.000Z',
        attempts: 3,
        lastError: 'exit 1',
      },
    })),
    createSubscriptionForAgent: vi.fn(async (_agent: AgentArg<'createSubscriptionForAgent'>, _request: RequestArg<'createSubscriptionForAgent'>) => ({
      kind: 'changed' as const,
      subscription: defaultSubscription,
      activity: defaultSubscriptionActivity,
    })),
    updateSubscriptionForAgent: vi.fn(async (_agent: AgentArg<'updateSubscriptionForAgent'>, _request: RequestArg<'updateSubscriptionForAgent'>) => ({
      kind: 'changed' as const,
      subscription: defaultSubscription,
      activity: defaultSubscriptionActivity,
    })),
    readThreadForAgent: vi.fn(async (_agent: AgentArg<'readThreadForAgent'>, _request: RequestArg<'readThreadForAgent'>) => testReadThreadResult()),
    threadHistoryForAgent: vi.fn((_agent: AgentArg<'threadHistoryForAgent'>, _request: RequestArg<'threadHistoryForAgent'>) => ({
      thread: DEFAULT_THREAD_HEADER,
      anchor: DEFAULT_ANCHOR,
      anchorMentions: [],
      claims: [],
      facts: [],
      cursor: 1,
      hasMore: false,
      taskCards: [],
    })),
    memberRemindersForAgent: vi.fn((_agent: AgentArg<'memberRemindersForAgent'>, _request: RequestArg<'memberRemindersForAgent'>): readonly AgentTeamMemberReminderView[] => []),
    createMemberReminderForAgent: vi.fn(async (_agent: AgentArg<'createMemberReminderForAgent'>, request: RequestArg<'createMemberReminderForAgent'>) => ({
      receipt: committedReceipt('2026-11-03T08:00:00.000Z'),
      workspaceId: request.workspaceId,
      reminder: testReminder(),
      activeCount: 3,
    })),
    cancelMemberReminderForAgent: vi.fn(async (_agent: AgentArg<'cancelMemberReminderForAgent'>, request: RequestArg<'cancelMemberReminderForAgent'>) => ({
      receipt: committedReceipt('2026-11-03T08:00:00.000Z'),
      workspaceId: request.workspaceId,
      reminder: testReminder({ state: 'cancelled' }),
    })),
    workerStartForAgent: vi.fn(async (_agent: AgentArg<'workerStartForAgent'>, _request: RequestArg<'workerStartForAgent'>) => testWorkerRun()),
    workerStopForAgent: vi.fn(async (_agent: AgentArg<'workerStopForAgent'>, _request: RequestArg<'workerStopForAgent'>) => testWorkerRun({
      state: 'stopped',
      settledAt: '2026-11-09T07:10:00.000Z',
    })),
    workerInspectForAgent: vi.fn(async (_agent: AgentArg<'workerInspectForAgent'>, _request: RequestArg<'workerInspectForAgent'>) => testWorkerInspection()),
    workerSteerForAgent: vi.fn(async (_agent: AgentArg<'workerSteerForAgent'>, _request: RequestArg<'workerSteerForAgent'>) => testWorkerSteer()),
  } satisfies ToolHostSurface
}

export type DefaultToolHost = ReturnType<typeof buildDefaultToolHost>

export type MergedToolHost<O extends Partial<ToolHostSurface>> = {
  [K in keyof DefaultToolHost]: K extends keyof O
    ? undefined extends O[K]
      ? DefaultToolHost[K] | Exclude<O[K], undefined>
      : O[K]
    : DefaultToolHost[K]
}

export function createTestToolHost<O extends Partial<ToolHostSurface> = Record<never, never>>(
  overrides?: O,
): MergedToolHost<O> {
  return {
    ...buildDefaultToolHost(),
    ...overrides,
  } as MergedToolHost<O>
}

export type TestToolHost = DefaultToolHost

export async function callTool<T = unknown>(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  host: ToolHostSurface,
  callId = 'call:1',
): Promise<T> {
  const agent = {
    id: 'agent:tool-test',
    options: {},
    session: Session.create(SessionId('session:tool-test')),
    ctx: { get: (name: string) => (name === 'agentTeam' ? host : undefined) },
  }
  return (await tool.execute(args, { agent, callId, signal: new AbortController().signal } as never)) as T
}

export function renderTool(tool: ToolDefinition, args: Record<string, unknown>, value: unknown): string {
  return renderText(tool, args, value)
}
