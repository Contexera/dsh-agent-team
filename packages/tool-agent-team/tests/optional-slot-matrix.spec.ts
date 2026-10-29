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
 * `team_thread`, `team_message`, and `team_task` carry action-specific pockets;
 * the other four tools have a single action and add no new combinations. A new
 * optional parameter added to any of these three tools automatically enters
 * this matrix instead of waiting for the next production failure.
 */

const THREAD = 'thread:d78400e4-4925-4065-87b1-3f81b4a4b5fb'
const TASK = 'task:2f23a1d0-4e5c-4a1b-9f0e-6d7c8b9a0e1f'
const CLAIM = 'claim:5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f'
const PROJECT = 'project:046dd831-c679-4279-b6aa-7813476cf12e'
const MEMBER = 'member:6e8a5b10-df16-4ec0-943a-63738010953f'
const MESSAGE = 'message:4bf83cfd-2a1b-4c3d-9e4f-5a6b7c8d9e0f'
const WORKSPACE = 'workspace:alpha'

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
    attentionStatusForAgent: () => ({ attention: undefined }),
    changeAttentionForAgent: vi.fn(async () => ({ thread: THREAD_STATE, attention: undefined })),
    readThreadForAgent: vi.fn(async () => ({ thread: THREAD_STATE, anchor: ANCHOR, anchorMentions: [], claims: [], facts: [],
      readThroughSequence: 1, remainingUnreadCount: 0, consumedDirectMarkers: [], reminders: [] })),
    threadHistoryForAgent: vi.fn(() => historyResult()),
    readMessageForAgent: vi.fn(() => ({ messageRef: MESSAGE, sender: MEMBER, sequence: 3, body: 'text' })),
    inboxForAgent: () => ({ totalUnreadCount: 0, totalDirectCount: 0, hasMore: false, items: [], main: [] }),
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
      members: [], owners: [], rulesVersion: 2, tasks: [], threads: [], taskNumbers: [], items: [], claims: [], activities: [], cursor: 0, hasMore: false })),
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
  { tool: 'team_thread', action: 'read', baseline: { action: 'read', threadRef: THREAD }, hostMethod: 'readThreadForAgent' },
  { tool: 'team_thread', action: 'history', baseline: { action: 'history', threadRef: THREAD }, hostMethod: 'threadHistoryForAgent' },
  { tool: 'team_thread', action: 'message', baseline: { action: 'message', threadRef: THREAD, messageRef: MESSAGE }, hostMethod: 'readMessageForAgent' },
  { tool: 'team_message', action: 'start', baseline: { action: 'start', projectRef: PROJECT, body: 'text' }, hostMethod: 'startThreadForAgent' },
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
  { tool: 'team_task', action: 'transfer', baseline: { action: 'transfer', taskRef: TASK, baseRevision: 20, target: 'human' }, hostMethod: 'transferTaskForAgent' },
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
  return await tool.execute(args, { agent, callId: 'call:1', signal: new AbortController().signal } as never)
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
      const host = matrixHost()
      const filled = filledArgs(tool!, scenario.baseline)
      // The matrix is only meaningful if it actually fills at least one extra slot,
      // and it must never invent a key the tool's schema does not expose.
      expect(Object.keys(filled).length).toBeGreaterThan(Object.keys(scenario.baseline).length)
      for (const key of Object.keys(filled)) expect(schema.properties).toHaveProperty(key)
      await expect(call(tool!, filled, host)).resolves.toBeDefined()
      expect(host[scenario.hostMethod]).toHaveBeenCalledTimes(1)
    })
  }

  // A new action must not slip past the matrix: its action enum member and its
  // row in CASES have to move together, or this suite stops covering the tool.
  for (const toolName of ['team_thread', 'team_message', 'team_task']) {
    it(`${toolName} matrix covers its whole action enum`, () => {
      const tool = teamTools().get(toolName)!
      const actions = parameterProperties(tool).action?.enum ?? []
      const covered = CASES.filter(scenario => scenario.tool === toolName).map(scenario => scenario.action)
      expect([...covered].sort()).toEqual([...actions].sort())
    })
  }
})
