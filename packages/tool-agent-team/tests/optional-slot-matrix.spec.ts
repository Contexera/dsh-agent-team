import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { teamTools } from './render-text.ts'

/**
 * Model-behaviour matrix: some models fill every optional slot in a tool's
 * parameter pocket — blank strings and empty collections included — before they
 * know which action they are actually taking. The failure is combinatorial:
 * every action × every slot that action does not own is a distinct shape, and
 * per-bug regression tests only cover the shapes a real session happened to
 * produce. This suite derives the slot list from each tool's live parameter
 * schema, fills every slot the action does not require with its neutral value,
 * and asserts the call still succeeds.
 *
 * Every registered tool must have a row; action enums are checked against the
 * rows rather than a hand-maintained tool allowlist. Meaningful defaults (such
 * as subscription notify: [] and webhook: false, or a Worker start's engine)
 * belong in the baseline, not in the neutral fill. The filled call must produce
 * the same Host requests as the clean call, not merely avoid throwing.
 */

const THREAD = 'thread:d78400e4-4925-4065-87b1-3f81b4a4b5fb'
const TASK = 'task:2f23a1d0-4e5c-4a1b-9f0e-6d7c8b9a0e1f'
const CLAIM = 'claim:5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f'
const PROJECT = 'project:046dd831-c679-4279-b6aa-7813476cf12e'
const MEMBER = 'member:6e8a5b10-df16-4ec0-943a-63738010953f'
const MESSAGE = 'message:4bf83cfd-2a1b-4c3d-9e4f-5a6b7c8d9e0f'
const WORKSPACE = 'workspace:alpha'
const REMINDER = 'reminder:00000000-0000-4000-8000-000000000001'
const WORKER = 'worker:00000000-0000-4000-8000-000000000002'
const SUBSCRIPTION = 'subscription:00000000-0000-4000-8000-000000000003'
const SIGNAL = new AbortController().signal
const REMINDER_STATE = { reminderRef: REMINDER, state: 'active', schedule: { kind: 'every', minutes: 30 },
  note: 'follow up', createdAt: '2026-11-10T00:00:00.000Z' }
const SUBSCRIPTION_STATE = { subscriptionRef: SUBSCRIPTION, name: 'watch', revision: 1, state: 'active', triggers: { interval: { minutes: 10 } } }
const WORKER_STATE = { workerRef: WORKER, projectRef: PROJECT, engine: 'codex', state: 'running', startedAt: '2026-11-10T00:00:00.000Z', cwd: '/tmp' }

const THREAD_STATE = { threadRef: THREAD, revision: 20 }
const ANCHOR = { messageRef: 'message:anchor', sender: MEMBER, body: 'subject', sequence: 1, occurredAt: '2026-10-29T00:00:00.000Z' }
const TASK_STATE = { taskRef: TASK, threadRef: THREAD, projectRef: PROJECT, status: 'in_progress', resolution: 'open', accountable: MEMBER, sourceThreadRefs: [] }
const CLAIM_STATE = { claimRef: CLAIM, direction: 'angle', state: 'active', owner: MEMBER }
const RECEIPT = { occurredAt: '2026-10-29T00:00:00.000Z' }

function historyResult() {
  return { thread: THREAD_STATE, anchor: ANCHOR, anchorMentions: [], claims: [], facts: [], cursor: 1, hasMore: false, taskCards: [] }
}

function matrixHost(): Record<string, unknown> {
  return {
    workspacesForAgent: () => [{ workspaceId: WORKSPACE, path: undefined, default: true }],
    humanHandle: () => 'human',
    members: () => [],
    memberForAgent: () => ({ memberId: MEMBER }),
    resolveTaskRefs: () => ({ resolved: [] }),
    attentionStatusForAgent: vi.fn(() => ({ attention: undefined })),
    changeAttentionForAgent: vi.fn(async () => ({ thread: THREAD_STATE, attention: undefined })),
    readThreadForAgent: vi.fn(async () => ({ thread: THREAD_STATE, anchor: ANCHOR, anchorMentions: [], claims: [], facts: [],
      readThroughSequence: 1, remainingUnreadCount: 0, consumedDirectMarkers: [], reminders: [] })),
    threadHistoryForAgent: vi.fn(() => historyResult()),
    readMessageForAgent: vi.fn(() => ({ messageRef: MESSAGE, sender: MEMBER, sequence: 3, body: 'text' })),
    inboxForAgent: vi.fn(() => ({ totalUnreadCount: 0, totalDirectCount: 0, hasMore: false, items: [], main: [] })),
    memberRemindersForAgent: vi.fn(() => []),
    createMemberReminderForAgent: vi.fn(async () => ({ reminder: REMINDER_STATE, activeCount: 1 })),
    cancelMemberReminderForAgent: vi.fn(async () => ({ reminder: { ...REMINDER_STATE, state: 'cancelled' } })),
    workerStartForAgent: vi.fn(async () => WORKER_STATE),
    workerStopForAgent: vi.fn(async () => ({ ...WORKER_STATE, state: 'stopped' })),
    workerInspectForAgent: vi.fn(async () => ({ ...WORKER_STATE, native: {}, history: { kind: 'unavailable', reason: 'running' }, unconfirmed: false })),
    workerSteerForAgent: vi.fn(async () => ({ workerRef: WORKER, engine: 'codex', state: 'submitted', runState: 'running' })),
    subscriptionsForAgent: vi.fn(() => ({ entries: [] })),
    createSubscriptionForAgent: vi.fn(async () => ({ kind: 'changed', subscription: SUBSCRIPTION_STATE })),
    updateSubscriptionForAgent: vi.fn(async () => ({ kind: 'changed', subscription: SUBSCRIPTION_STATE })),
    testSubscriptionForAgent: vi.fn(async () => ({ kind: 'tested', events: [], stdoutTail: '', stderrTail: '' })),
    pauseSubscriptionForAgent: vi.fn(async () => ({ kind: 'changed', subscription: SUBSCRIPTION_STATE })),
    resumeSubscriptionForAgent: vi.fn(async () => ({ kind: 'changed', subscription: SUBSCRIPTION_STATE })),
    deleteSubscriptionForAgent: vi.fn(async () => ({ kind: 'changed', subscription: SUBSCRIPTION_STATE })),
    baselineSubscriptionForAgent: vi.fn(async () => ({ subscription: SUBSCRIPTION_STATE, added: ['event:1'] })),
    subscriptionLogsForAgent: vi.fn(() => ({ subscription: SUBSCRIPTION_STATE, runs: [] })),
    subscriptionDeliveriesForAgent: vi.fn(() => ({ subscription: SUBSCRIPTION_STATE, deliveries: [] })),
    replaySubscriptionDeliveryForAgent: vi.fn(async () => ({ kind: 'replayed', eventCount: 0 })),
    resetSubscriptionWebhookForAgent: vi.fn(async () => ({ kind: 'changed', subscription: SUBSCRIPTION_STATE })),
    dmForAgent: vi.fn(async () => ({ recipient: { memberId: MEMBER, handle: 'Ben' }, receipt: RECEIPT })),
    startThreadForAgent: vi.fn(async () => ({ kind: 'committed', receipt: RECEIPT, message: { messageRef: 'message:start', sender: MEMBER },
      thread: THREAD_STATE, attention: [] })),
    replyForAgent: vi.fn(async () => ({ kind: 'committed', receipt: RECEIPT, message: { messageRef: 'message:reply', sender: MEMBER },
      thread: THREAD_STATE, attention: [] })),
    postMainMessageForAgent: vi.fn(async () => ({ kind: 'committed', receipt: RECEIPT, message: { messageRef: 'message:post', projectRef: PROJECT } })),
    taskBoardForAgent: vi.fn(() => ({ open: [], finished: [], finishedTruncated: false })),
    listClaimsForAgent: vi.fn(() => ({ task: TASK_STATE, thread: THREAD_STATE, claims: [] })),
    changeClaimForAgent: vi.fn(async () => ({ kind: 'committed', receipt: RECEIPT, task: TASK_STATE, thread: THREAD_STATE, claim: CLAIM_STATE })),
    promoteThreadForAgent: vi.fn(async () => ({ kind: 'committed', receipt: RECEIPT, task: TASK_STATE, thread: THREAD_STATE })),
    changeTaskForAgent: vi.fn(async () => ({ kind: 'committed', receipt: RECEIPT, task: TASK_STATE, thread: THREAD_STATE, activity: {} })),
    transferTaskForAgent: vi.fn(async () => ({ kind: 'committed', receipt: RECEIPT, task: TASK_STATE, thread: THREAD_STATE,
      activity: { from: MEMBER, to: 'human' } })),
    viewForAgent: vi.fn(() => ({ humanMemberId: 'member:human', workspaces: [{ workspaceId: WORKSPACE, default: true }], projects: [],
      directory: { projects: [], memberIds: [] }, members: [], owners: [], rulesVersion: 2, tasks: [], threads: [], taskNumbers: [], items: [], claims: [], activities: [], cursor: 0, hasMore: false })),
  }
}

interface ParameterSpec {
  readonly type?: string
  readonly enum?: readonly string[]
}

/** The neutral value for a slot: the value a model sends when it means "I have nothing for this slot". */
function neutralValue(spec: ParameterSpec): unknown {
  if (spec.enum !== undefined && spec.enum.length > 0) return spec.enum[0]
  switch (spec.type) {
    case 'number': return 0
    case 'boolean': return false
    case 'array': return []
    default: return ''
  }
}

interface MatrixCase {
  readonly tool: string
  readonly action: string
  readonly baseline: Record<string, unknown>
  readonly hostMethod: string
}

const CASES: readonly MatrixCase[] = [
  { tool: 'team_view', action: 'view', baseline: {}, hostMethod: 'viewForAgent' },
  { tool: 'team_inbox', action: 'inbox', baseline: {}, hostMethod: 'inboxForAgent' },
  { tool: 'team_dm', action: 'send', baseline: { memberRef: MEMBER, body: 'text' }, hostMethod: 'dmForAgent' },
  { tool: 'team_attention', action: 'status', baseline: { action: 'status', threadRef: THREAD }, hostMethod: 'attentionStatusForAgent' },
  { tool: 'team_attention', action: 'follow', baseline: { action: 'follow', threadRef: THREAD }, hostMethod: 'changeAttentionForAgent' },
  { tool: 'team_attention', action: 'unfollow', baseline: { action: 'unfollow', threadRef: THREAD }, hostMethod: 'changeAttentionForAgent' },
  { tool: 'team_reminder', action: 'create', baseline: { action: 'create', scheduleKind: 'once', at: '2026-11-11T00:00:00.000Z', note: 'follow up' }, hostMethod: 'createMemberReminderForAgent' },
  { tool: 'team_reminder', action: 'create', baseline: { action: 'create', scheduleKind: 'every', minutes: 30, note: 'follow up' }, hostMethod: 'createMemberReminderForAgent' },
  { tool: 'team_reminder', action: 'create', baseline: { action: 'create', scheduleKind: 'cron', expression: '0 9 * * *', note: 'follow up' }, hostMethod: 'createMemberReminderForAgent' },
  { tool: 'team_reminder', action: 'list', baseline: { action: 'list' }, hostMethod: 'memberRemindersForAgent' },
  { tool: 'team_reminder', action: 'cancel', baseline: { action: 'cancel', reminderRef: REMINDER }, hostMethod: 'cancelMemberReminderForAgent' },
  // Engine selection on a start is meaningful, unlike an unused control-call slot.
  { tool: 'team_worker', action: 'start', baseline: { task: 'review the parser', projectRef: PROJECT, engine: 'codex' }, hostMethod: 'workerStartForAgent' },
  { tool: 'team_worker', action: 'stop', baseline: { stop: WORKER }, hostMethod: 'workerStopForAgent' },
  { tool: 'team_worker', action: 'inspect', baseline: { inspect: WORKER }, hostMethod: 'workerInspectForAgent' },
  { tool: 'team_worker', action: 'steer', baseline: { steer: WORKER, instruction: 'check the tests' }, hostMethod: 'workerSteerForAgent' },
  { tool: 'team_subscription', action: 'list', baseline: { action: 'list', projectRef: PROJECT }, hostMethod: 'subscriptionsForAgent' },
  // [] clears recipients and false disarms a webhook: neither is an absent value.
  { tool: 'team_subscription', action: 'create', baseline: { action: 'create', projectRef: PROJECT, name: 'watch', intervalMinutes: 10,
    scriptContent: 'true\n', notify: [], webhook: false }, hostMethod: 'createSubscriptionForAgent' },
  { tool: 'team_subscription', action: 'update', baseline: { action: 'update', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION, name: 'watch',
    expectedRevision: 1, intervalMinutes: 10, scriptContent: 'true\n', notify: [], webhook: false }, hostMethod: 'updateSubscriptionForAgent' },
  { tool: 'team_subscription', action: 'test', baseline: { action: 'test', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION }, hostMethod: 'testSubscriptionForAgent' },
  { tool: 'team_subscription', action: 'pause', baseline: { action: 'pause', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION, expectedRevision: 1 }, hostMethod: 'pauseSubscriptionForAgent' },
  { tool: 'team_subscription', action: 'resume', baseline: { action: 'resume', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION, expectedRevision: 1 }, hostMethod: 'resumeSubscriptionForAgent' },
  { tool: 'team_subscription', action: 'delete', baseline: { action: 'delete', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION, expectedRevision: 1 }, hostMethod: 'deleteSubscriptionForAgent' },
  { tool: 'team_subscription', action: 'baseline', baseline: { action: 'baseline', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION, ids: ['event:1'] }, hostMethod: 'baselineSubscriptionForAgent' },
  { tool: 'team_subscription', action: 'logs', baseline: { action: 'logs', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION }, hostMethod: 'subscriptionLogsForAgent' },
  { tool: 'team_subscription', action: 'deliveries', baseline: { action: 'deliveries', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION }, hostMethod: 'subscriptionDeliveriesForAgent' },
  { tool: 'team_subscription', action: 'replay', baseline: { action: 'replay', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION,
    deliveryRef: 'delivery:1', version: 'current' }, hostMethod: 'replaySubscriptionDeliveryForAgent' },
  { tool: 'team_subscription', action: 'reset_webhook', baseline: { action: 'reset_webhook', projectRef: PROJECT, subscriptionRef: SUBSCRIPTION, expectedRevision: 1 }, hostMethod: 'resetSubscriptionWebhookForAgent' },
  { tool: 'team_thread', action: 'read', baseline: { action: 'read', threadRef: THREAD }, hostMethod: 'readThreadForAgent' },
  { tool: 'team_thread', action: 'history', baseline: { action: 'history', threadRef: THREAD }, hostMethod: 'threadHistoryForAgent' },
  { tool: 'team_thread', action: 'message', baseline: { action: 'message', threadRef: THREAD, messageRef: MESSAGE }, hostMethod: 'readMessageForAgent' },
  { tool: 'team_message', action: 'start', baseline: { action: 'start', projectRef: PROJECT, body: 'text' }, hostMethod: 'startThreadForAgent' },
  // The neutral fill adds `kind` and `sourceThreadRefs` to reply/post; neither is a start, so both must be dropped.
  { tool: 'team_message', action: 'reply', baseline: { action: 'reply', threadRef: THREAD, baseRevision: 20, body: 'text' }, hostMethod: 'replyForAgent' },
  { tool: 'team_message', action: 'post', baseline: { action: 'post', projectRef: PROJECT, body: 'text' }, hostMethod: 'postMainMessageForAgent' },
  { tool: 'team_task', action: 'board', baseline: { action: 'board' }, hostMethod: 'taskBoardForAgent' },
  { tool: 'team_task', action: 'list', baseline: { action: 'list', taskRef: TASK }, hostMethod: 'listClaimsForAgent' },
  { tool: 'team_task', action: 'claim', baseline: { action: 'claim', taskRef: TASK, baseRevision: 20, direction: 'angle' }, hostMethod: 'changeClaimForAgent' },
  { tool: 'team_task', action: 'done', baseline: { action: 'done', taskRef: TASK, baseRevision: 20, claimRef: CLAIM }, hostMethod: 'changeClaimForAgent' },
  { tool: 'team_task', action: 'release', baseline: { action: 'release', taskRef: TASK, baseRevision: 20, claimRef: CLAIM }, hostMethod: 'changeClaimForAgent' },
  { tool: 'team_task', action: 'promote', baseline: { action: 'promote', threadRef: THREAD, baseRevision: 20 }, hostMethod: 'promoteThreadForAgent' },
  { tool: 'team_task', action: 'accept', baseline: { action: 'accept', taskRef: TASK, baseRevision: 20 }, hostMethod: 'changeTaskForAgent' },
  { tool: 'team_task', action: 'close', baseline: { action: 'close', taskRef: TASK, baseRevision: 20 }, hostMethod: 'changeTaskForAgent' },
  { tool: 'team_task', action: 'reopen', baseline: { action: 'reopen', taskRef: TASK, baseRevision: 20 }, hostMethod: 'changeTaskForAgent' },
  { tool: 'team_task', action: 'transfer', baseline: { action: 'transfer', taskRef: TASK, baseRevision: 20, target: 'member:human' }, hostMethod: 'transferTaskForAgent' },
]

function parameterProperties(tool: ToolDefinition): Record<string, ParameterSpec> {
  const schema = tool.parameters as unknown as { properties?: Record<string, ParameterSpec> }
  return schema.properties ?? {}
}

function filledArgs(tool: ToolDefinition, baseline: Record<string, unknown>): Record<string, unknown> {
  const filled = { ...baseline }
  for (const [name, spec] of Object.entries(parameterProperties(tool))) {
    if (name in baseline) continue
    filled[name] = neutralValue(spec)
  }
  return filled
}

async function call(tool: ToolDefinition, args: Record<string, unknown>, host: Record<string, unknown>): Promise<unknown> {
  const agent = { id: 'agent:matrix', options: {}, session: Session.create(SessionId('session:matrix')), ctx: { get: (name: string) => name === 'agentTeam' ? host : undefined } }
  return await tool.execute(args, { agent, callId: 'call:1', signal: SIGNAL } as never)
}

function requests(host: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(host).filter(([, method]) => vi.isMockFunction(method))
    .map(([name, method]) => [name, (method as ReturnType<typeof vi.fn>).mock.calls.map(args => args.slice(1)
      .map(arg => typeof arg === 'function' ? expect.any(Function) : arg))]))
}

describe('every action tolerates every optional slot filled with its neutral value', () => {
  for (const scenario of CASES) {
    it(`${scenario.tool} ${scenario.action}`, async () => {
      const tool = teamTools().get(scenario.tool)
      expect(tool, `${scenario.tool} is registered`).toBeDefined()
      const schema = tool!.parameters as unknown as { properties?: Record<string, unknown>; required?: readonly string[] }
      // The baseline must be schema-valid before the neutral fill can isolate
      // the optional slots: every schema-required key belongs in the baseline.
      expect(Object.keys(scenario.baseline)).toEqual(expect.arrayContaining([...(schema.required ?? [])]))
      const cleanHost = matrixHost()
      const host = matrixHost()
      const filled = filledArgs(tool!, scenario.baseline)
      // The matrix is only meaningful if it actually fills at least one extra slot,
      // and it must never invent a key the tool's schema does not expose.
      expect(Object.keys(filled).length).toBeGreaterThan(Object.keys(scenario.baseline).length)
      for (const key of Object.keys(filled)) expect(schema.properties).toHaveProperty(key)
      const clean = await call(tool!, scenario.baseline, cleanHost)
      await expect(call(tool!, filled, host)).resolves.toEqual(clean)
      expect(host[scenario.hostMethod]).toHaveBeenCalledTimes(1)
      expect(requests(host), 'neutral filling must neither change the Host payload nor call another action').toEqual(requests(cleanHost))
    })
  }

  it('covers every registered tool, including tools without an action enum', () => {
    expect([...new Set(CASES.map(scenario => scenario.tool))].sort()).toEqual([...teamTools().keys()].sort())
  })

  for (const [toolName, tool] of teamTools()) {
    const actions = parameterProperties(tool).action?.enum
    if (actions === undefined) continue
    it(`${toolName} matrix covers its whole action enum`, () => {
      const covered = new Set(CASES.filter(scenario => scenario.tool === toolName).map(scenario => scenario.action))
      expect([...covered].sort()).toEqual([...actions].sort())
    })
  }

  it('covers each reminder schedule and each Worker control selector', () => {
    const schedules = CASES.filter(row => row.tool === 'team_reminder' && row.action === 'create').map(row => row.baseline.scheduleKind)
    expect(schedules.sort()).toEqual([...parameterProperties(teamTools().get('team_reminder')!).scheduleKind!.enum!].sort())
    const selectors = Object.keys(parameterProperties(teamTools().get('team_worker')!)).filter(key => ['stop', 'inspect', 'steer'].includes(key))
    for (const selector of selectors) expect(CASES.some(row => row.tool === 'team_worker' && row.baseline[selector] === WORKER)).toBe(true)
  })
})
