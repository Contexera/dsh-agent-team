import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { renderText, teamTools } from './render-text.ts'

/**
 * A discussion that spawned a Task renders that Task as a card at its creation
 * point — the same projection the Human's Thread page draws. It is current
 * state, never a fact: no unread/direct marker, no count, and no write token.
 */

const THREAD = 'thread:aaaa1111-0000-4000-8000-000000000001'
const TASK = 'task:3245ad40-43fd-4191-a416-7dcaf3a340f2'
const PROJECT = 'project:046dd831-c679-4279-b6aa-7813476cf12e'
const OWNER = 'member:6e8a5b10-df16-4ec0-943a-63738010953f'
const CARD_THREAD = 'thread:bbbb2222-0000-4000-8000-000000000002'

/** What the Host projects: the shared Main stream card, stamped with the sequence of the fact that created the Task. */
const HOST_CARD = {
  sequence: 12,
  card: {
    threadRef: CARD_THREAD,
    anchor: { messageRef: 'message:created', sender: OWNER, preview: 'Ship the importer', sequence: 12, occurredAt: '2026-10-25T03:00:00.000Z' },
    task: { taskRef: TASK, taskNumber: 7, status: 'in_review', resolution: 'open', accountable: OWNER, liveClaimOwners: [] },
    replyCount: 0, participants: [], newestSequence: 18, newestOccurredAt: '2026-10-26T09:30:00.000Z',
    newestActor: { memberId: OWNER, name: 'reeve' },
  },
}

/** What the tool hands the renderer: the model-facing fields it flattens that card down to. */
const CARD = {
  taskRef: TASK, taskNumber: 7, threadRef: CARD_THREAD,
  sequence: 12, occurredAt: '2026-10-25T03:00:00.000Z', subject: 'Ship the importer',
  status: 'in_review', resolution: 'open', accountable: OWNER,
}

const BASE = {
  workspaceId: 'workspace:alpha', projectRef: PROJECT, threadRef: THREAD, revision: 20, following: true,
  anchor: { messageRef: 'message:anchor', sender: 'member:reeve', body: 'Can we unify the importers?', sequence: 1 },
  claims: [],
}

describe('team_thread renders a discussion\'s derived Task cards', () => {
  it('a read separates current cards from acknowledged facts and background', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      ...BASE, kind: 'read', facts: [
        { sequence: 5, kind: 'message', body: 'before the Task', sender: 'member:reeve', mentions: [], unread: false, direct: false },
        { sequence: 20, kind: 'message', body: 'after the Task', sender: 'member:tars', mentions: [], unread: true, direct: true },
      ],
      taskCards: [CARD], readThroughSequence: 20, remainingUnreadCount: 0,
    })
    const lines = text.split('\n')
    const card = lines.find(line => line.includes('[task card]'))!
    // The card names the Task, its ordinal, its current state, who is accountable, and the Thread that holds it.
    expect(card).toContain(`[task card] Task ${TASK} (#7), in_review/open`)
    expect(card).toContain(`accountable ${OWNER}`)
    expect(card).toContain('Ship the importer')
    expect(card).toContain(CARD_THREAD)
    expect(text).toContain('Current Task cards — not Thread reading')
    expect(lines.indexOf(card)).toBeGreaterThan(lines.findIndex(line => line.includes('after the Task')))
    // A card is not a fact: it carries no unread/direct marker and changes no count.
    expect(card).not.toContain('[unread]')
    expect(card).not.toContain('[direct]')
    expect(text).toContain('acknowledged 1 unread update(s)')
    expect(text).toContain('0 unread update(s) remaining')
  })

  it('a card past the batch renders after the facts, because the read orients on current state', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      ...BASE, kind: 'read',
      facts: [{ sequence: 5, kind: 'message', body: 'the only fact', sender: 'member:reeve', mentions: [], unread: true, direct: false }],
      taskCards: [CARD], readThroughSequence: 5, remainingUnreadCount: 0,
    })
    const lines = text.split('\n')
    expect(lines.findIndex(line => line.includes('[task card]'))).toBeGreaterThan(lines.findIndex(line => line.includes('the only fact')))
  })

  it('a discussion with no derived Task renders no card line', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      ...BASE, kind: 'read', facts: [], taskCards: [], readThroughSequence: 1, remainingUnreadCount: 0,
    })
    expect(text).not.toContain('[task card]')
  })

  it('history draws only the cards its own sequence window reaches, so paging never repeats one', () => {
    const tool = teamTools().get('team_thread')!
    // The newest page starts above the card's creation point, so it does not carry it yet.
    const newestPage = renderText(tool, { action: 'history', threadRef: THREAD }, {
      ...BASE, kind: 'history', facts: [{ sequence: 20, kind: 'message', body: 'newest fact', sender: 'member:tars', mentions: [] }],
      taskCards: [CARD], cursor: 20, hasMore: true,
    })
    expect(newestPage).not.toContain('[task card]')
    // The page whose window spans the creation point carries it, at that point.
    const spanning = renderText(tool, { action: 'history', threadRef: THREAD, beforeSequence: 20 }, {
      ...BASE, kind: 'history', facts: [{ sequence: 5, kind: 'message', body: 'older fact', sender: 'member:reeve', mentions: [] }],
      taskCards: [CARD], cursor: 5, hasMore: false,
    })
    const lines = spanning.split('\n')
    expect(lines.some(line => line.includes('[task card]'))).toBe(true)
    expect(lines.findIndex(line => line.includes('[task card]'))).toBeGreaterThan(lines.findIndex(line => line.includes('older fact')))
  })

  it('declares the card fields the render reads, because an undeclared value throws', () => {
    const schema = teamTools().get('team_thread')!.output.schema as Record<string, any>
    for (const field of ['taskRef', 'taskNumber', 'threadRef', 'sequence', 'occurredAt', 'subject', 'status', 'resolution', 'accountable']) {
      expect(schema.properties.taskCards.items.properties[field]).toBeDefined()
      expect(schema.properties.taskCards.items.required).toContain(field)
    }
  })
})

const READ_RESULT = {
  thread: { threadRef: THREAD, revision: 20 },
  anchor: { messageRef: 'message:anchor', sender: 'member:reeve', body: 'Can we unify the importers?', sequence: 1 },
  anchorMentions: [], claims: [], facts: [], readThroughSequence: 1, remainingUnreadCount: 0, consumedDirectMarkers: [], reminders: [],
}

const TASK_READ_RESULT = { ...READ_RESULT, task: { taskRef: TASK, projectRef: PROJECT, threadRef: THREAD, status: 'todo', resolution: 'open', accountable: OWNER, sourceThreadRefs: [] } }

/** The Host surface a Thread read touches, recorded so the assertion is on the request the tool built. */
function fakeHost(overrides: Record<string, unknown> = {}) {
  return {
    workspacesForAgent: () => [{ workspaceId: 'workspace:alpha', path: undefined, default: true }],
    humanHandle: () => 'human',
    members: () => [],
    resolveTaskRefs: () => ({ resolved: [] }),
    attentionStatusForAgent: () => ({ attention: undefined }),
    readThreadForAgent: vi.fn(async () => READ_RESULT),
    threadHistoryForAgent: vi.fn(() => ({ thread: READ_RESULT.thread, anchor: READ_RESULT.anchor, anchorMentions: [], claims: [],
      facts: [], cursor: 1, hasMore: false, taskCards: [HOST_CARD] })),
    ...overrides,
  }
}

async function call(tool: ToolDefinition, args: Record<string, unknown>, host: ReturnType<typeof fakeHost>): Promise<Record<string, unknown>> {
  const agent = { id: 'agent:tool-test', ctx: { get: (name: string) => name === 'agentTeam' ? host : undefined } }
  return await tool.execute(args, { agent, callId: 'call:1', signal: new AbortController().signal } as never) as Record<string, unknown>
}

describe('team_thread acknowledges private Task reminders', () => {
  it('renders a reminder-only read as committed work, not an empty Thread', async () => {
    const reminder = { taskRef: TASK, kind: 'review-backlog', recipient: OWNER, baselineSequence: 8, sequence: 20, occurredAt: '2026-10-25T04:00:00.000Z' }
    const host = fakeHost({ readThreadForAgent: vi.fn(async () => ({ ...TASK_READ_RESULT, reminders: [reminder] })) })
    const tool = teamTools().get('team_thread')!
    const result = await call(tool, { action: 'read', threadRef: THREAD }, host)
    expect(result.reminders).toEqual([reminder])
    const text = renderText(tool, { action: 'read', threadRef: THREAD }, result)
    expect(text).toContain('acknowledged 1 unread update(s)')
    expect(text).toContain('Acknowledged Task reminders')
    expect(text).toContain(`Review backlog · ${TASK} · baseline 8`)
    expect(text).not.toContain('no unread updates')
  })
})

describe('team_thread carries the derived Task cards from the Host projection', () => {
  it('a discussion read asks the history projection for the cards and returns them', async () => {
    const host = fakeHost()
    const result = await call(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, host)
    expect(host.threadHistoryForAgent).toHaveBeenCalledTimes(1)
    expect(result.taskCards).toEqual([CARD])
    // The fixture's newest activity is later than its creation, so the rendered line must carry the creation instant.
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, result)
    const card = text.split('\n').find(line => line.includes('[task card]'))!
    expect(card).toContain('12 2026-10-25T11:00:00+08:00 [task card]')
    expect(card).not.toContain('2026-10-26T17:30:00+08:00')
  })

  it('a Task Thread returns no cards, because it has none of its own', async () => {
    const host = fakeHost({ readThreadForAgent: vi.fn(async () => TASK_READ_RESULT) })
    const result = await call(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, host)
    expect(result.taskCards).toEqual([])
    expect(host.threadHistoryForAgent).not.toHaveBeenCalled()
  })

  it('a history page returns the cards the Host projected', async () => {
    const host = fakeHost()
    const result = await call(teamTools().get('team_thread')!, { action: 'history', threadRef: THREAD }, host)
    expect(result.taskCards).toEqual([CARD])
  })
})
