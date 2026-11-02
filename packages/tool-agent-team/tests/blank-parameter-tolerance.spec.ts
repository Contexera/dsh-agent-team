import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { teamTools } from './render-text.ts'

/**
 * Execution-level tests for blank-parameter edge cases. The blanket
 * fill-every-slot success shapes are covered by optional-slot-matrix.spec.ts;
 * these tests keep the blanks that still need their own outcome: a genuine
 * missing direction, real kind/sourceThreadRefs misuse, a stray projectRef,
 * an empty body, and the page-size split between read and history.
 */

const THREAD = 'thread:d78400e4-4925-4065-87b1-3f81b4a4b5fb'
const PROJECT = 'project:046dd831-c679-4279-b6aa-7813476cf12e'
const OWNER = 'member:6e8a5b10-df16-4ec0-943a-63738010953f'
const REVIEWER = 'member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5'

const READ_RESULT = { thread: { threadRef: THREAD, revision: 20 },
  anchor: { messageRef: 'message:anchor', sender: 'member:reeve', body: 'Can we unify the importers?', sequence: 1 },
  anchorMentions: [], claims: [], facts: [], readThroughSequence: 1, remainingUnreadCount: 0, consumedDirectMarkers: [], reminders: [] }

function threadHost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspacesForAgent: () => [{ workspaceId: 'workspace:alpha', path: undefined, default: true }],
    humanHandle: () => 'human',
    members: () => [],
    resolveTaskRefs: () => ({ resolved: [] }),
    attentionStatusForAgent: () => ({ attention: undefined }),
    readThreadForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => READ_RESULT),
    threadHistoryForAgent: vi.fn(() => ({ thread: READ_RESULT.thread, anchor: READ_RESULT.anchor, anchorMentions: [], claims: [],
      facts: [], cursor: 1, hasMore: false, taskCards: [] })),
    ...overrides,
  }
}

function messageHost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspacesForAgent: () => [{ workspaceId: 'workspace:alpha', path: undefined, default: true }],
    humanHandle: () => 'human',
    members: () => [
      { member: { memberId: OWNER, handle: 'Tars' } },
      { member: { memberId: REVIEWER, handle: 'Cole' } },
    ],
    startThreadForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({
      kind: 'committed', receipt: { occurredAt: '2026-10-27T06:00:00.000Z' },
      message: { messageRef: 'message:anchor' }, thread: { threadRef: THREAD, revision: 20 }, task: undefined, attention: [], directMarkers: [],
    })),
    replyForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({
      kind: 'committed', receipt: { occurredAt: '2026-10-27T06:00:00.000Z' },
      message: { messageRef: 'message:reply' }, thread: { threadRef: THREAD, revision: 21 }, task: undefined,
    })),
    postMainMessageForAgent: vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({
      kind: 'committed', receipt: { occurredAt: '2026-10-27T06:00:00.000Z' }, message: { messageRef: 'message:post', projectRef: PROJECT },
    })),
    ...overrides,
  }
}

async function call(tool: ToolDefinition, args: Record<string, unknown>, host: Record<string, unknown>): Promise<unknown> {
  const agent = { id: 'agent:tool-test', options: {}, session: Session.create(SessionId('session:tool-test')), ctx: { get: (name: string) => name === 'agentTeam' ? host : undefined } }
  return await tool.execute(args, { agent, callId: 'call:1', signal: new AbortController().signal } as never)
}

describe('a blank slot still fails where the action needs a value', () => {
  it('a claim with a blank direction still reports the missing direction rather than writing', async () => {
    const change = vi.fn()
    const host = threadHost({ changeClaimForAgent: change })
    await expect(call(teamTools().get('team_task')!, { action: 'claim', taskRef: 'task:missing', baseRevision: 20, direction: '' }, host))
      .rejects.toThrow(/direction/i)
    expect(change).not.toHaveBeenCalled()
  })
})

describe('start-only parameters keep their owning action', () => {
  it('a reply that really asks for kind: task is still told kind belongs to start', async () => {
    const host = messageHost()
    const refusal = await call(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 20, body: 'x', kind: 'task' }, host)
      .then(() => { throw new Error('the refusal was not thrown') }, (error: Error) => error)
    expect(refusal.message).toContain('kind')
    expect(refusal.message).toContain('action: start')
    expect(host.replyForAgent).not.toHaveBeenCalled()
  })

  it('a post that really names sources is still told they belong to start', async () => {
    const host = messageHost()
    const refusal = await call(teamTools().get('team_message')!, { action: 'post', projectRef: PROJECT, body: 'x', sourceThreadRefs: [THREAD] }, host)
      .then(() => { throw new Error('the refusal was not thrown') }, (error: Error) => error)
    expect(refusal.message).toContain('sourceThreadRefs')
    expect(refusal.message).toContain('action: start')
    expect(host.postMainMessageForAgent).not.toHaveBeenCalled()
  })

  it('a start still reads kind, because there it decides the Thread kind', async () => {
    const start = vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({
      kind: 'committed', receipt: { occurredAt: '2026-10-27T06:00:00.000Z' },
      message: { messageRef: 'message:anchor' }, thread: { threadRef: THREAD, revision: 20 }, task: undefined, attention: [], directMarkers: [],
    }))
    const host = messageHost({ startThreadForAgent: start })
    await call(teamTools().get('team_message')!, { action: 'start', projectRef: PROJECT, body: 'open a Task', kind: 'task' }, host)
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0]![1]).toMatchObject({ kind: 'task' })
  })
})

describe('a read carrying a page size still returns its batch', () => {
  it('a Thread read with limit and beforeSequence reads one page instead of refusing the call', async () => {
    const host = threadHost()
    await call(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD, limit: 200, beforeSequence: 0, workspace: 'workspace:alpha' }, host)
    const read = host.readThreadForAgent as ReturnType<typeof vi.fn>
    expect(read).toHaveBeenCalledTimes(1)
    // The Host read request has no limit field, so the page size must not reach it.
    expect(read.mock.calls[0]![1]).toMatchObject({ threadRef: THREAD })
    expect(read.mock.calls[0]![1]).not.toHaveProperty('limit')
    expect(read.mock.calls[0]![1]).not.toHaveProperty('beforeSequence')
  })

  it('a Main stream read with limit and beforeSequence reads one page instead of refusing the call', async () => {
    const read = vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({
      projectRef: PROJECT, entries: [], readThroughSequence: 12,
      standing: { unreadCount: 3, directCount: 0 }, consumedDirectMarkers: [], reminders: [],
    }))
    const host = threadHost({ readMainStreamForAgent: read })
    await call(teamTools().get('team_thread')!, { action: 'read', projectRef: PROJECT, limit: 200, beforeSequence: 0, workspace: 'workspace:alpha' }, host)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![1]).not.toHaveProperty('limit')
  })

  it('the rendered page still names how much is left, so paging stays the way to get more', async () => {
    const read = vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({
      thread: { threadRef: THREAD, revision: 20 },
      anchor: { messageRef: 'message:anchor', sender: 'member:reeve', body: 'Can we unify the importers?', sequence: 1 },
      anchorMentions: [], claims: [], facts: [], readThroughSequence: 40, remainingUnreadCount: 57,
      earlierFactCount: 57, consumedDirectMarkers: [], reminders: [],
    }))
    const host = threadHost({ readThreadForAgent: read })
    const result = await call(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD, limit: 200, workspace: 'workspace:alpha' }, host) as never
    const blocks = teamTools().get('team_thread')!.output.render({ action: 'read', threadRef: THREAD, limit: 200 }, result)
    const text = blocks.map(block => block.type === 'text' ? block.text : '').join('\n')
    expect(text).toContain('57')
  })

  it('history still honors the page size, because its request really carries one', async () => {
    const history = vi.fn((_agent: unknown, _request: Record<string, unknown>) => ({ thread: { threadRef: THREAD, revision: 20 }, anchor: READ_RESULT.anchor, anchorMentions: [],
      claims: [], facts: [], cursor: 1, hasMore: false, taskCards: [] }))
    const host = threadHost({ threadHistoryForAgent: history })
    await call(teamTools().get('team_thread')!, { action: 'history', threadRef: THREAD, limit: 50, workspace: 'workspace:alpha' }, host)
    expect(history).toHaveBeenCalledTimes(1)
    // The same parameter that a read ignores is a real request field here, so the
    // Host (which bounds it to 1..100) must still receive it.
    expect(history.mock.calls[0]![1]).toMatchObject({ threadRef: THREAD, limit: 50 })
  })
})

describe('a reply with a stray projectRef is told to drop it, not to fetch a token', () => {
  it('reports the addressing conflict and never claims the token is missing', async () => {
    const host = messageHost()
    const refusal = await call(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 20, body: 'x', projectRef: PROJECT }, host)
      .then(() => { throw new Error('the refusal was not thrown') }, (error: Error) => error)
    expect(refusal.message).toContain('reply does not take projectRef')
    expect(refusal.message).toContain('address different things')
    expect(refusal.message).not.toContain('missing_write_token')
    expect(refusal.message).not.toContain('reply requires threadRef and a positive baseRevision')
    expect(host.replyForAgent).not.toHaveBeenCalled()
  })
})

describe('a blank body is named for what it is', () => {
  it('team_message refuses an empty body with the channel-mistake hint', async () => {
    const host = messageHost()
    const refusal = await call(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 20, body: '' }, host)
      .then(() => { throw new Error('the refusal was not thrown') }, (error: Error) => error)
    expect(refusal.message).toContain('needs the message text in its body parameter')
    expect(host.replyForAgent).not.toHaveBeenCalled()
    await expect(call(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 20, body: '   ' }, host))
      .rejects.toThrow(/body parameter/)
  })

  it('team_dm refuses an empty body the same way', async () => {
    const dm = vi.fn(async (_agent: unknown, _request: Record<string, unknown>) => ({ recipient: { memberId: REVIEWER, handle: 'Cole' }, receipt: { occurredAt: '2026-10-27T06:00:00.000Z' } }))
    const host = messageHost({ dmForAgent: dm })
    await expect(call(teamTools().get('team_dm')!, { memberRef: REVIEWER, body: '' }, host))
      .rejects.toThrow(/body parameter/)
    expect(dm).not.toHaveBeenCalled()
  })
})
