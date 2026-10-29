import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { renderText, teamTools, occurrences } from './render-text.ts'

const THREAD = 'thread:d78400e4-4925-4065-87b1-3f81b4a4b5fb'
const TASK = 'task:3245ad40-43fd-4191-a416-7dcaf3a340f2'
const PROJECT = 'project:046dd831-c679-4279-b6aa-7813476cf12e'
const WORKSPACES = [{ workspaceId: 'workspace:alpha', default: true }]
const CLAIM = 'claim:326f0b21-a41c-4c47-be18-ad0d4ecfc139'

describe('team_view renders one address book', () => {
  it('names each Project\'s owners and the reader\'s role once the ledger has Project owners', () => {
    const text = renderText(teamTools().get('team_view')!, {}, {
      workspaces: WORKSPACES,
      projects: [
        { projectRef: PROJECT, name: 'general', owners: ['human', 'Tars'], role: 'owner' },
        { projectRef: 'project:aaaa1111-0000-4000-8000-000000000002', name: 'ops', owners: ['human'], role: 'member' },
      ],
      members: [], threads: [], tasks: [], cursor: 1, hasMore: false,
    })
    expect(text).toContain(`${PROJECT} · general · owners @human, @Tars · you: owner`)
    expect(text).toContain('project:aaaa1111-0000-4000-8000-000000000002 · ops · owners @human · you: member')
  })

  it('first page: labelled sections, newest-first subjects, Task inline — no Task index, message count, or revision label', () => {
    const text = renderText(teamTools().get('team_view')!, {}, {
      workspaces: WORKSPACES,
      projects: [{ projectRef: PROJECT, name: 'general' }],
      members: [{ memberId: 'member:6e8a5b10-df16-4ec0-943a-63738010953f', kind: 'agent', handle: 'Tars', description: 'builder', presence: 'available' }],
      threads: [
        { threadRef: THREAD, projectRef: PROJECT, revision: 8394, messageCount: 120, subject: 'Review the render contract', taskRef: TASK, status: 'in_progress', taskNumber: 7 },
        { threadRef: 'thread:aaaa1111-0000-4000-8000-000000000001', projectRef: PROJECT, revision: 100, messageCount: 3, subject: 'Should Member descriptions change after the rename?' },
      ],
      tasks: [{ taskRef: TASK, threadRef: THREAD, projectRef: PROJECT, status: 'in_progress', revision: 8394 }],
      cursor: 8394, hasMore: true,
    })
    expect(text).toContain('Team directory')
    expect(text).toContain('Projects — current')
    expect(text).toContain('Members — current')
    // Sections come in order: Projects, Threads, Members.
    expect(text.indexOf('Projects — current')).toBeLessThan(text.indexOf('Threads'))
    expect(text.indexOf('Threads')).toBeLessThan(text.indexOf('Members — current'))
    // Each Thread row carries its bounded subject and inline Task standing.
    expect(text).toContain(`${THREAD} · ${PROJECT} · ${TASK} (#7), in_progress — Review the render contract`)
    expect(text).toContain('thread:aaaa1111-0000-4000-8000-000000000001 · project:046dd831-c679-4279-b6aa-7813476cf12e · taskless — Should Member descriptions change after the rename?')
    // Work in flight lives on the Task board, not in the address book.
    expect(text).toContain('team_task board')
    // No second Task index: the taskful Thread appears once.
    expect(occurrences(text, THREAD)).toBe(1)
    // No revision-labelled field, no message count, no write token.
    expect(text).not.toContain('revision')
    expect(text).not.toContain('message')
    expect(text).not.toContain('baseRevision')
  })

  it('the footer names the Thread cursor and whether older anchors remain', () => {
    const text = renderText(teamTools().get('team_view')!, {}, {
      workspaces: WORKSPACES, projects: [], members: [], threads: [], tasks: [], cursor: 0, hasMore: false,
    })
    expect(text).toContain('Thread cursor 0; hasMore=false — no older Threads remain.')
    const more = renderText(teamTools().get('team_view')!, {}, {
      workspaces: WORKSPACES, projects: [], members: [], threads: [], tasks: [], cursor: 8394, hasMore: true,
    })
    expect(more).toContain('Thread cursor 8394; hasMore=true — older Thread anchors exist; page again with this cursor.')
  })

  it('a continuation page renders only the Threads section', () => {
    const text = renderText(teamTools().get('team_view')!, { cursor: 8394 }, {
      workspaces: WORKSPACES,
      projects: [{ projectRef: PROJECT, name: 'general' }],
      members: [{ memberId: 'member:6e8a5b10-df16-4ec0-943a-63738010953f', kind: 'agent', handle: 'Tars', description: 'builder', presence: 'available' }],
      threads: [{ threadRef: THREAD, projectRef: PROJECT, revision: 8394, messageCount: 120, subject: 'Review the render contract' }],
      tasks: [], cursor: 100, hasMore: false, page: 'threads',
    })
    expect(text).toContain('Threads')
    expect(text).not.toContain('Projects — current')
    expect(text).not.toContain('Members — current')
    expect(text).not.toContain('team_task board')
    expect(text).toContain('Thread cursor 100; hasMore=false')
  })

  it('the shared subject formatter collapses whitespace and truncates deterministically (read C-branch)', () => {
    const longBody = `Systematically   review\n\tthe five model-facing  Team tool ${'x'.repeat(120)} results tail-that-must-not-appear`
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      kind: 'read', threadRef: THREAD, revision: 9010, following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: longBody, sequence: 8888 },
      claims: [],
      facts: [{ sequence: 9010, kind: 'message', messageRef: 'message:9010', body: 'one new fact', sender: 'human', mentions: [], unread: true, direct: true }],
      readThroughSequence: 9010, remainingUnreadCount: 0,
    })
    expect(text).toContain('  — Systematically review the five model-facing Team tool ')
    expect(text).toMatch(/…$/m)
    expect(text).not.toContain('tail-that-must-not-appear')
    expect(text).not.toContain('\t')
  })
})

describe('team_task board renders the board projection', () => {
  const item = (status: string, extra: Record<string, unknown> = {}) => ({ workspaceId: 'ws1', projectRef: PROJECT, projectName: 'general', taskRef: TASK, taskNumber: 7,
    threadRef: THREAD, status, subject: 'Review the render contract', members: [], lastActivityAt: '2026-09-27T10:00:00.000Z', relation: 'none',
    accountable: 'member:6e8a5b10-df16-4ec0-943a-63738010953f', needsAcceptance: false, ...extra })

  it('groups open Tasks by status, lists finished work, and carries no write token', () => {
    const text = renderText(teamTools().get('team_task')!, { action: 'board' }, {
      kind: 'board', open: [item('in_progress', { members: ['Tars'], relation: 'executor' })], finished: [item('done')],
    })
    expect(text).toContain('To do (0)')
    expect(text).toContain(`In progress (1)\n${TASK} (#7) · general ${PROJECT} · ${THREAD} · @Tars · you: executor · accountable member:6e8a5b10-df16-4ec0-943a-63738010953f — Review the render contract · last activity 2026-09-27T18:00:00+08:00`)
    expect(text).toContain('In review (0)')
    expect(text).toContain('Recently finished (1)')
    expect(text).not.toContain('baseRevision')
  })

  // The finished column is a page of the Project's resolved history, never the
  // whole column. Without the Host's truncation signal the reader counts the
  // page as the total and stops looking.
  it('says when the finished column was cut, rather than passing the page off as the total', () => {
    const truncated = renderText(teamTools().get('team_task')!, { action: 'board' }, {
      kind: 'board', open: [], finished: [item('done')], finishedTruncated: true,
    })
    expect(truncated).toContain('Recently finished (1 shown, more exist)')
    const whole = renderText(teamTools().get('team_task')!, { action: 'board' }, {
      kind: 'board', open: [], finished: [item('done')], finishedTruncated: false,
    })
    expect(whole).toContain('Recently finished (1)')
    expect(whole).not.toContain('more exist')
  })

  it('names the accountable owner, and says so when the reader owes the acceptance', () => {
    const text = renderText(teamTools().get('team_task')!, { action: 'board' }, {
      kind: 'board', open: [item('in_review', { relation: 'project-owner', needsAcceptance: true, accountable: 'member:human' })], finished: [],
    })
    expect(text).toContain('· you: project-owner · accountable member:human · needs your acceptance — Review the render contract')
  })

  it('a Task nobody is accountable to the reader for renders no acceptance claim', () => {
    const text = renderText(teamTools().get('team_task')!, { action: 'board' }, {
      kind: 'board', open: [item('in_review', { accountable: 'member:other' })], finished: [],
    })
    expect(text).toContain('· accountable member:other —')
    expect(text).not.toContain('needs your acceptance')
  })
})

describe('team_inbox renders triage, not a read', () => {
  it('header totals, both per-row counters (including zero direct), truncation conclusion, and a read route', () => {
    const text = renderText(teamTools().get('team_inbox')!, {}, {
      totalUnreadCount: 9, totalDirectCount: 2, hasMore: false, main: [],
      items: [
        { threadRef: 'thread:aaaa1111-0000-4000-8000-000000000001', projectRef: PROJECT, taskRef: TASK, status: 'in_progress', revision: 100, unreadCount: 4, directCount: 2, taskNumber: 7 },
        { threadRef: 'thread:bbbb2222-0000-4000-8000-000000000002', projectRef: PROJECT, revision: 101, unreadCount: 3, directCount: 0 },
      ],
    })
    expect(text).toContain('Inbox — 9 unread update(s) total, 2 direct, across 2 Thread(s) shown')
    expect(text).toContain('thread:aaaa1111-0000-4000-8000-000000000001 · project:046dd831-c679-4279-b6aa-7813476cf12e · task:3245ad40-43fd-4191-a416-7dcaf3a340f2 (#7), in_progress · 4 unread, 2 direct')
    expect(text).toContain('thread:bbbb2222-0000-4000-8000-000000000002 · project:046dd831-c679-4279-b6aa-7813476cf12e · 3 unread, 0 direct')
    expect(text).toContain('team_thread read')
    expect(text).toContain('no write token')
  })

  it('a capped page says the queue goes on; a complete one does not', () => {
    // The Host's own verdict drives the conclusion, not a comparison the model
    // would have to reconstruct from two differently-shaped numbers.
    const capped = renderText(teamTools().get('team_inbox')!, {}, {
      totalUnreadCount: 12, totalDirectCount: 5, hasMore: true, main: [],
      items: [{ threadRef: 'thread:aaaa1111-0000-4000-8000-000000000001', projectRef: PROJECT, revision: 100, unreadCount: 7, directCount: 3 }],
    })
    expect(capped).toContain('more Threads sit beyond this page')
    expect(capped).toContain('up to 100 rows')
    const complete = renderText(teamTools().get('team_inbox')!, {}, {
      totalUnreadCount: 2, totalDirectCount: 0, hasMore: false, main: [],
      items: [{ threadRef: 'thread:aaaa1111-0000-4000-8000-000000000001', projectRef: PROJECT, revision: 100, unreadCount: 2, directCount: 0 }],
    })
    expect(complete).not.toContain('beyond this page')
  })

  it('empty inbox states there is no unread Team work', () => {
    const text = renderText(teamTools().get('team_inbox')!, {}, { totalUnreadCount: 0, totalDirectCount: 0, hasMore: false, main: [], items: [] })
    expect(text).toContain('Inbox empty — no unread Team work.')
  })

  it('lists a Main stream row with its Project and routes the read through projectRef', () => {
    const text = renderText(teamTools().get('team_inbox')!, {}, {
      totalUnreadCount: 3, totalDirectCount: 1, hasMore: false, items: [],
      main: [{ workspaceId: 'ws1', projectRef: PROJECT, projectName: 'Payments', unreadCount: 3, directCount: 1, newestOccurredAt: '2026-09-08T08:58:41.000Z' }],
    })
    expect(text).toContain('across 1 Main stream(s) and 0 Thread(s) shown')
    expect(text).toContain(`ws1 · ${PROJECT} Main stream (Payments) · 3 unread, 1 direct · newest 2026-09-08T16:58:41+08:00`)
    expect(text).toContain('team_thread read (threadRef or projectRef)')
  })

  it('renders no subject, body, revision label, or write token', () => {
    const text = renderText(teamTools().get('team_inbox')!, {}, {
      totalUnreadCount: 1, totalDirectCount: 1, hasMore: false, main: [],
      items: [{ threadRef: 'thread:aaaa1111-0000-4000-8000-000000000001', projectRef: PROJECT, revision: 100, unreadCount: 1, directCount: 1 }],
    })
    expect(text).not.toContain('revision')
    expect(text).not.toContain('baseRevision')
    expect(text).not.toContain('Subject')
  })
})

describe('team_attention renders Attention only', () => {
  const base = {
    workspaceId: 'workspace:alpha', projectRef: PROJECT,
    kind: 'status', threadRef: THREAD, taskRef: TASK, taskNumber: 7, revision: 8394, status: 'in_progress', resolution: 'open', following: true,
  }
  const follows = 'Ordinary updates from there will interrupt you; mentions, replies and responsibility events already did.'
  const followResult = 'Ordinary updates from there will interrupt you from now on; earlier content remains available through team_thread read or history. Mentions, replies and responsibility events already did.'
  const stopped = 'Ordinary updates will no longer interrupt you. Mentions, replies and responsibility events still will; follow again to resume.'
  const statusStopped = 'Ordinary updates do not interrupt you. Mentions, replies and responsibility events still will; follow to resume them.'

  it('status renders one Attention outcome line under its Workspace/Project source', () => {
    const text = renderText(teamTools().get('team_attention')!, { action: 'status', threadRef: THREAD }, base)
    expect(text).toBe(`Workspace: workspace:alpha · Project: ${PROJECT}\nAttention status — following Thread ${THREAD} · ${TASK} (#7), in_progress/open.\n${follows}`)
  })

  it('follow/unfollow render one Attention-changed line; no anchor, Claims, facts, revision label, or token', () => {
    const follow = renderText(teamTools().get('team_attention')!, { action: 'follow', threadRef: THREAD }, { ...base, kind: 'follow' })
    expect(follow).toBe(`Workspace: workspace:alpha · Project: ${PROJECT}\nAttention changed — now following Thread ${THREAD} · ${TASK} (#7), in_progress/open.\n${followResult}`)
    const unfollow = renderText(teamTools().get('team_attention')!, { action: 'unfollow', threadRef: THREAD }, { ...base, kind: 'unfollow', following: false })
    expect(unfollow).toBe(`Workspace: workspace:alpha · Project: ${PROJECT}\nAttention changed — no longer following Thread ${THREAD} · ${TASK} (#7), in_progress/open.\n${stopped}`)
    for (const text of [follow, unfollow]) {
      expect(text).not.toContain('revision')
      expect(text).not.toContain('baseRevision')
    }
  })

  it('a taskless Attention render omits Task standing', () => {
    const text = renderText(teamTools().get('team_attention')!, { action: 'status', threadRef: THREAD }, {
      workspaceId: 'workspace:alpha', projectRef: PROJECT,
      kind: 'status', threadRef: THREAD, revision: 8394, following: false,
    })
    expect(text).toBe(`Workspace: workspace:alpha · Project: ${PROJECT}\nAttention status — not following Thread ${THREAD}.\n${statusStopped}`)
  })

  it('a Main stream Attention render names the Main stream, not a Thread', () => {
    const main = { workspaceId: 'workspace:alpha', projectRef: PROJECT, kind: 'follow', scope: 'main', following: true }
    const text = renderText(teamTools().get('team_attention')!, { action: 'follow', projectRef: PROJECT }, main)
    expect(text).toBe(`Workspace: workspace:alpha · Project: ${PROJECT}\nAttention changed — now following the Main stream.\n${followResult}`)
    // Unfollowing names what survives it, which is the one thing the verb alone does not say.
    const stoppedText = renderText(teamTools().get('team_attention')!, { action: 'unfollow', projectRef: PROJECT }, { ...main, kind: 'unfollow', following: false })
    expect(stoppedText).toContain('no longer following the Main stream')
    expect(stoppedText).toContain('Mentions, replies and responsibility events still will')
    expect(stoppedText).not.toContain(THREAD)
  })

  it('the output schema carries no read surface at all, because Attention is not reading', () => {
    // The whole point of the split: the Attention result shape cannot name a
    // fact, an anchor, a watermark, or a write token, so no render of it can
    // drift into showing Thread content.
    const schema = teamTools().get('team_attention')!.output.schema as Record<string, any>
    for (const absent of ['facts', 'anchor', 'claims', 'readThroughSequence', 'remainingUnreadCount', 'message', 'cursor', 'hasMore']) {
      expect(schema.properties[absent]).toBeUndefined()
    }
    // The Attention state itself is the one required field: an Attention result
    // that does not say whether you follow the Thread answers nothing.
    // `required` is hoisted onto the schema's top-level list, not the field.
    expect(schema.required).toContain('following')
  })
})

describe('team_thread read orients by structured facts', () => {
  const anchor = { messageRef: 'message:anchor', sender: 'human', body: 'Systematically review the five model-facing Team tool results', sequence: 8888 }

  it('branch A: the anchor among the facts renders once, with no separate anchor line', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      kind: 'read', threadRef: THREAD, taskRef: TASK, revision: 9004, status: 'in_progress', resolution: 'open', following: true,
      anchor,
      claims: [{ claimRef: CLAIM, direction: 'renderer fidelity', state: 'active', owner: 'member:6e8a5b10-df16-4ec0-943a-63738010953f' }],
      facts: [
        { sequence: 8888, kind: 'message', messageRef: 'message:8888', body: anchor.body, sender: 'human', mentions: [], unread: false, direct: false },
        { sequence: 9004, kind: 'message', messageRef: 'message:9004', body: 'Trace audit is ready', sender: 'member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5', mentions: [], unread: true, direct: true },
      ],
      readThroughSequence: 9004, remainingUnreadCount: 0,
    })
    expect(occurrences(text, anchor.body)).toBe(1)
    expect(text).not.toContain(`Anchor ${anchor.sequence}`)
    expect(text).not.toContain('Subject —')
    expect(text).toContain('Active Claims')
    expect(text).toContain(`${CLAIM} — member:6e8a5b10-df16-4ec0-943a-63738010953f: renderer fidelity`)
    // Exactly one token hand-off at zero unread.
    expect(occurrences(text, 'baseRevision')).toBe(1)
    expect(text).toContain('Next write — baseRevision: 9004 (copy exactly; never derive or cite).')
  })

  it('background does not repeat a visible anchor; done Claims stay out of current context', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      kind: 'read', threadRef: THREAD, taskRef: TASK, revision: 8402, status: 'in_progress', resolution: 'open', following: true,
      anchor,
      claims: [
        { claimRef: 'claim:old', direction: 'prior direction', state: 'done', owner: 'member:6e8a5b10-df16-4ec0-943a-63738010953f' },
        { claimRef: CLAIM, direction: 'renderer fidelity', state: 'active', owner: 'member:6e8a5b10-df16-4ec0-943a-63738010953f' },
      ],
      facts: [
        { sequence: 8387, kind: 'message', messageRef: 'message:8387', body: 'already-read background', sender: 'human', mentions: [], unread: false, direct: false },
        { sequence: 8402, kind: 'message', messageRef: 'message:8402', body: 'decision', sender: 'member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5', mentions: [], unread: true, direct: true },
      ],
      readThroughSequence: 8402, remainingUnreadCount: 3,
    })
    expect(text).not.toContain(`Anchor ${anchor.sequence} [human]`)
    expect(text).toContain(`  — ${anchor.body}`)
    expect(text).toContain('Background — not newly acknowledged')
    // Only the active Claim is current collision surface.
    expect(text).toContain(CLAIM)
    expect(text).not.toContain('claim:old')
    // Partial read: no token, told to read again.
    expect(text).not.toContain('baseRevision')
    expect(text).toContain('3 unread update(s) remaining — call team_thread read again.')
  })

  it('branch C: continuation read (no unread===false background) renders only the bounded subject', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      kind: 'read', threadRef: THREAD, taskRef: TASK, revision: 9010, status: 'in_progress', resolution: 'open', following: true,
      anchor,
      claims: [],
      facts: [
        { sequence: 9010, kind: 'message', messageRef: 'message:9010', body: 'Show me the expected result, not a field table.', sender: 'human', mentions: [], unread: true, direct: true },
      ],
      readThroughSequence: 9010, remainingUnreadCount: 0,
    })
    expect(text).toContain(`  — ${'Systematically review the five model-facing Team tool results'}`)
    expect(text).not.toContain(`Anchor ${anchor.sequence} [`)
    expect(occurrences(text, 'baseRevision')).toBe(1)
  })

  it('unread Activity markers render inline on the fact line; no ellipsis-only second line exists', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      kind: 'read', threadRef: THREAD, taskRef: TASK, revision: 8190, status: 'done', resolution: 'accepted', following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor body', sequence: 1 },
      claims: [],
      facts: [{ sequence: 8190, kind: 'activity', activity: 'accept', activityRef: 'activity:accept', actor: 'human', taskRef: TASK, threadRef: THREAD, completedClaimRefs: [CLAIM], acceptedClaimRefs: [CLAIM], unread: true, direct: false }],
      readThroughSequence: 8190, remainingUnreadCount: 0,
    })
    expect(text).toContain(`8190 human accept Task ${TASK} · Thread ${THREAD} · activity:accept · completed claims ${CLAIM} · accepted claims ${CLAIM} [unread]`)
    expect(text).not.toContain('…')
    expect(text).not.toContain('(unread activity)')
  })

  it('a read with no new facts states it explicitly and still hands off the token', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      kind: 'read', threadRef: THREAD, revision: 9010, following: true,
      anchor, claims: [], facts: [],
      readThroughSequence: 9010, remainingUnreadCount: 0,
    })
    expect(text).toContain('no unread updates on')
    expect(text).toContain('No new facts to acknowledge.')
    expect(text).toContain('Next write — baseRevision: 9010')
    expect(text).not.toContain('Active Claims')
  })
})

describe('team_thread history renders deep orientation only', () => {
  const anchor = { messageRef: 'message:anchor', sender: 'member:reeve', body: 'Systematically review the five model-facing Team tool results', sequence: 8888 }

  it('first page renders the full anchor unless the selected facts contain it', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'history', threadRef: THREAD }, {
      kind: 'history', threadRef: THREAD, taskRef: TASK, revision: 9100, status: 'in_progress', resolution: 'open', following: true,
      anchor,
      claims: [{ claimRef: CLAIM, direction: 'd', state: 'active', owner: 'member:x' }],
      facts: [
        { sequence: 8973, kind: 'message', messageRef: 'message:8973', body: 'Compared the two complete interface families.', sender: 'member:reeve', mentions: [] },
        { sequence: 8990, kind: 'message', messageRef: 'message:8990', body: 'Added an independent trace sample.', sender: 'member:tars', mentions: [] },
      ],
      cursor: 8973, hasMore: true,
    })
    expect(text).toContain(`History for ${THREAD} · ${TASK}`)
    expect(text).toContain(`Anchor ${anchor.sequence} [member:reeve]`)
    expect(text).toContain(anchor.body)
    expect(text).toContain('History cursor 8973; hasMore=true — older facts exist; page again with beforeSequence set to the cursor.')
    // No current Claims snapshot, no context recommendation, no token.
    expect(text).not.toContain('Active Claims')
    expect(text).not.toContain('Context guidance')
    expect(text).not.toContain('baseRevision')
    // When the anchor IS among the selected facts, it never duplicates.
    const withAnchor = renderText(teamTools().get('team_thread')!, { action: 'history', threadRef: THREAD }, {
      kind: 'history', threadRef: THREAD, revision: 9100, following: true,
      anchor,
      claims: [],
      facts: [{ sequence: 8888, kind: 'message', messageRef: 'message:8888', body: anchor.body, sender: 'member:reeve', mentions: [] }],
      cursor: 8888, hasMore: true,
    })
    expect(occurrences(withAnchor, anchor.body)).toBe(1)
    expect(withAnchor).not.toContain(`Anchor ${anchor.sequence} [`)
  })

  it('continuation pages render only the bounded subject', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'history', threadRef: THREAD, beforeSequence: 8973 }, {
      kind: 'history', threadRef: THREAD, revision: 9100, following: true,
      anchor,
      claims: [],
      facts: [{ sequence: 8900, kind: 'message', messageRef: 'message:8900', body: 'An older fact.', sender: 'human', mentions: [] }],
      cursor: 8900, hasMore: false,
    })
    expect(text).toContain(`  — ${anchor.body.slice(0, 60)}`)
    expect(text).not.toContain(`Anchor ${anchor.sequence} [`)
    expect(text).toContain('History cursor 8900; hasMore=false — no older facts remain.')
  })

  it('an empty page states no facts before the cursor', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'history', threadRef: THREAD }, {
      kind: 'history', threadRef: THREAD, revision: 9100, following: true,
      anchor,
      claims: [],
      facts: [],
      cursor: 8879, hasMore: false,
    })
    expect(text).toContain('No facts before this cursor.')
    expect(text).toContain('History cursor 8879; hasMore=false')
  })
})

describe('team_message renders its outcome', () => {
  it('start: Committed — Thread created with refs and exactly one token', () => {
    const text = renderText(teamTools().get('team_message')!, { action: 'start', projectRef: PROJECT, body: 'x' }, {
      kind: 'committed', action: 'start', messageRef: 'message:9a1c', threadRef: THREAD, taskRef: TASK, revision: 8201,
    })
    expect(text).toContain('Committed — Thread created.')
    expect(text).toContain(`message:9a1c · ${THREAD} · ${TASK}`)
    expect(occurrences(text, 'baseRevision')).toBe(1)
    expect(text).toContain('Next write — baseRevision: 8201 (copy exactly; never derive or cite).')
  })

  it('a Task start states its accountable owner and where its card renders', () => {
    const source = 'thread:aaaa1111-0000-4000-8000-000000000001'
    const text = renderText(teamTools().get('team_message')!, { action: 'start', kind: 'task', projectRef: PROJECT, body: 'x' }, {
      kind: 'committed', action: 'start', messageRef: 'message:9a1c', threadRef: THREAD, taskRef: TASK, revision: 8201,
      accountable: 'member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5', sourceThreadRefs: [source],
    })
    expect(text).toContain(`Accountable for ${TASK}: member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5.`)
    expect(text).toContain(`Derived from ${source} — its card renders there, not in the Main stream.`)
    // Accountability is an annotation, never a second token.
    expect(occurrences(text, 'baseRevision')).toBe(1)
  })

  it('a discussion start renders neither line, because it carries no Task', () => {
    const text = renderText(teamTools().get('team_message')!, { action: 'start', projectRef: PROJECT, body: 'x' }, {
      kind: 'committed', action: 'start', messageRef: 'message:9a1c', threadRef: THREAD, revision: 8201,
    })
    expect(text).not.toContain('Accountable for')
    expect(text).not.toContain('Derived from')
  })

  it('reply: Committed — reply added with a different identity line', () => {
    const text = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8201, body: 'x' }, {
      kind: 'committed', action: 'reply', messageRef: 'message:9a1d', threadRef: THREAD, revision: 8202,
    })
    expect(text).toContain('Committed — reply added.')
    expect(text).toContain(`message:9a1d · ${THREAD}`)
    expect(text).not.toContain('Thread created')
    expect(occurrences(text, 'baseRevision')).toBe(1)
  })

  it('reply: an undelivered mention is reported beside the commit, never instead of it', () => {
    const text = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8201, body: 'x' }, {
      kind: 'committed', action: 'reply', messageRef: 'message:9a1e', threadRef: THREAD, revision: 8203,
      undeliveredMentions: ['member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5'],
    })
    expect(text).toContain('Committed — reply added.')
    expect(text).toContain(`message:9a1e · ${THREAD}`)
    expect(text).toContain('Mention not delivered — member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5 never took part in this Thread')
    expect(text).toContain('ask the Human')
    // The Message committed, so the next-write token is still handed over.
    expect(occurrences(text, 'baseRevision')).toBe(1)
    expect(text).toContain('Next write — baseRevision: 8203')
  })

  it('dm: Delivered vs Recorded-not-delivered with the no-blind-duplicate warning', () => {
    const delivered = renderText(teamTools().get('team_dm')!, { memberRef: 'member:peer', body: 'x' }, {
      kind: 'dm-sent', recipientMemberId: 'member:peer', recipientHandle: 'Cole', delivered: true,
    })
    expect(delivered).toBe('Delivered — DM to @Cole (member:peer).')
    const recorded = renderText(teamTools().get('team_dm')!, { memberRef: 'member:peer', body: 'x' }, {
      kind: 'dm-sent', recipientMemberId: 'member:peer', recipientHandle: 'Cole', delivered: false, deliveryNote: 'no live session',
    })
    expect(recorded).toContain('Recorded, not delivered — DM to @Cole (member:peer).')
    expect(recorded).toContain('No automatic redelivery will occur; do not blindly send a duplicate.')
    expect(recorded).toContain('Reason: no live session')
  })

  it('team_dm takes no Thread, Task, token, or attachment parameter at all', () => {
    // The split's whole point, asserted rather than assumed: a private note has
    // no Thread to address, so the parameter pocket cannot invite one. A model
    // that reaches for a threadRef here gets a schema refusal, not a runtime one.
    const parameters = teamTools().get('team_dm')!.parameters as Record<string, any>
    for (const absent of ['threadRef', 'taskRef', 'projectRef', 'baseRevision', 'asTask', 'attachments', 'replyToMessageRef', 'action']) {
      expect(parameters.properties[absent]).toBeUndefined()
    }
    expect(parameters.required).toContain('memberRef')
    expect(parameters.required).toContain('body')
  })

  it('typed rejections begin Not committed, keep refs/counts/recovery, and hand back the current revision', () => {
    const unread = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8000, body: 'x' }, {
      kind: 'unread_required', threadRef: THREAD, taskRef: TASK, revision: 8394, unreadCount: 2, directCount: 1,
      facts: [{ sequence: 8394, kind: 'message', messageRef: 'message:8394', body: 'the gated fact', sender: 'human', mentions: [], unread: true, direct: true },
        { sequence: 8395, kind: 'message', messageRef: 'message:8395', body: 'another update', sender: 'human', mentions: [], unread: true, direct: false }],
    })
    expect(unread).toContain('Not committed — unread_required.')
    expect(unread).toContain(`${THREAD} · ${TASK} · 2 unread, 1 direct`)
    expect(unread).toContain('team_thread read')
    // Project C: the gated facts render in the rejection itself, and the
    // current revision comes back as the next write token. This inverted the
    // old contract, which held that a rejection carried no facts and no token.
    expect(unread).toContain('the gated fact')
    expect(unread).toContain('Next write — baseRevision: 8394')

    const stale = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8387, body: 'x' }, {
      kind: 'stale_revision', threadRef: THREAD, expectedRevision: 8387, revision: 8394,
      facts: [{ sequence: 8394, kind: 'message', messageRef: 'message:8394', body: 'the increment', sender: 'human', mentions: [], unread: true, direct: false }],
    })
    expect(stale).toContain('Not committed — the Thread changed after your last read (stale_revision).')
    expect(stale).toContain('Reconsider the new facts above')
    expect(stale).toContain('the increment')
    expect(stale).toContain('Next write — baseRevision: 8394')

    // A token this Thread never reached is not a race. The ordinary sentence
    // would send a model re-reading to find an insertion that never happened,
    // so the refusal names the copying mistake and drops the increment lines,
    // which would otherwise present facts as missed when none were.
    const copied = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 4711, body: 'x' }, {
      kind: 'stale_revision', threadRef: THREAD, expectedRevision: 4711, revision: 8394, staleTokenKind: 'unrecognized',
      facts: [{ sequence: 8394, kind: 'message', messageRef: 'message:8394', body: 'the increment', sender: 'human', mentions: [], unread: true, direct: false }],
    })
    expect(copied).toContain('Not committed — that write token was never a revision this Thread reached (stale_revision).')
    expect(copied).toContain('not a revision this Thread reached')
    // The headline must not contradict the way out: the first line can no
    // longer claim the Thread changed, and the race sentence is gone with it.
    expect(copied).not.toContain('the Thread changed')
    expect(copied).not.toContain('Reconsider the new facts above')
    expect(copied).not.toContain('the increment')
    expect(copied).not.toContain('Next write — baseRevision: 8394')

    // member_not_following is a version-1 result the Host can no longer produce
    // for a tool call: the fallback render names the kind and the Thread without
    // inventing a recovery route for a state that cannot occur.
    const legacyNotFollowing = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8394, body: 'x' }, {
      kind: 'member_not_following', memberIds: ['member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5'], threadRef: THREAD, revision: 8394,
    } as never)
    expect(legacyNotFollowing).toContain('Not committed — member_not_following.')
    expect(legacyNotFollowing).toContain(THREAD)
    expect(legacyNotFollowing).not.toContain('baseRevision')
  })
})

describe('team_task renders the affected Claim', () => {
  it('list: active collision surface only, no token', () => {
    const text = renderText(teamTools().get('team_task')!, { action: 'list', taskRef: TASK }, {
      kind: 'listed', taskRef: TASK, threadRef: THREAD, revision: 9024, status: 'in_progress',
      claims: [
        { claimRef: CLAIM, direction: 'Audit the render recovery paths', state: 'active', owner: 'member:owner' },
        { claimRef: 'claim:done', direction: 'finished angle', state: 'done', owner: 'member:owner' },
      ],
    })
    expect(text).toContain(`Claims for ${TASK} · ${THREAD} · in_progress`)
    expect(text).toContain('Active Claims')
    expect(text).toContain(`${CLAIM} — member:owner: Audit the render recovery paths`)
    expect(text).not.toContain('claim:done')
    expect(text).not.toContain('baseRevision')
    expect(text).not.toContain('revision')
  })

  it('list with no active Claims states it', () => {
    const text = renderText(teamTools().get('team_task')!, { action: 'list', taskRef: TASK }, {
      kind: 'listed', taskRef: TASK, threadRef: THREAD, revision: 9024, status: 'todo',
      claims: [{ claimRef: 'claim:done', direction: 'finished', state: 'done', owner: 'member:owner' }],
    })
    expect(text).toContain('No active Claims.')
  })

  it('claim/done/release name different actions, render the affected Claim first, and hand off exactly one token', () => {
    const created = renderText(teamTools().get('team_task')!, { action: 'claim', taskRef: TASK, baseRevision: 9024, direction: 'Audit the render recovery paths' }, {
      kind: 'committed', action: 'claim', taskRef: TASK, threadRef: THREAD, revision: 9028, status: 'in_progress',
      claim: { claimRef: CLAIM, direction: 'Audit the render recovery paths', state: 'active', owner: 'member:owner' },
      claims: [{ claimRef: CLAIM, direction: 'Audit the render recovery paths', state: 'active', owner: 'member:owner' }],
    })
    expect(created).toContain('Committed — Claim created.')
    expect(created.indexOf(CLAIM)).toBeLessThan(created.indexOf(THREAD))
    expect(created).toContain(`${CLAIM} · active — member:owner: Audit the render recovery paths`)
    expect(occurrences(created, 'baseRevision')).toBe(1)
    // Structured claims stay real (compat), yet the render never appends the archive.
    expect(occurrences(created, 'claim:')).toBe(1)

    const done = renderText(teamTools().get('team_task')!, { action: 'done', taskRef: TASK, baseRevision: 9028, claimRef: CLAIM }, {
      kind: 'committed', action: 'done', taskRef: TASK, threadRef: THREAD, revision: 9024, status: 'in_review',
      claim: { claimRef: CLAIM, direction: 'd', state: 'done', owner: 'member:owner' },
      claims: [{ claimRef: CLAIM, direction: 'd', state: 'done', owner: 'member:owner' }],
    })
    expect(done).toContain('Committed — Claim completed.')
    expect(done).toContain('in_review')

    const released = renderText(teamTools().get('team_task')!, { action: 'release', taskRef: TASK, baseRevision: 9028, claimRef: CLAIM }, {
      kind: 'committed', action: 'release', taskRef: TASK, threadRef: THREAD, revision: 9030, status: 'todo',
      claim: { claimRef: CLAIM, direction: 'd', state: 'released', owner: 'member:owner' },
      claims: [{ claimRef: CLAIM, direction: 'd', state: 'released', owner: 'member:owner' }],
    })
    expect(released).toContain('Committed — Claim released.')
    // A committed mutation appends no Claim archive: only the affected Claim renders.
    for (const text of [created, done, released]) {
      expect(occurrences(text, 'claim:')).toBe(1)
      expect(text).not.toContain('Active Claims')
    }
  })

  it('claim rejections share the outcome-first form and hand back the current revision', () => {
    const unread = renderText(teamTools().get('team_task')!, { action: 'claim', taskRef: TASK, baseRevision: 8000, direction: 'd' }, {
      kind: 'unread_required', taskRef: TASK, threadRef: THREAD, revision: 8394, status: 'in_progress', unreadCount: 2, directCount: 1,
      claims: [{ claimRef: CLAIM, direction: 'Audit the render recovery paths', state: 'active', owner: 'member:owner' }],
      facts: [{ sequence: 8394, kind: 'message', messageRef: 'message:8394', body: 'the gated fact', sender: 'human', mentions: [], unread: true, direct: true },
        { sequence: 8395, kind: 'message', messageRef: 'message:8395', body: 'another update', sender: 'human', mentions: [], unread: true, direct: false }],
    })
    expect(unread).toContain('Not committed — unread_required.')
    expect(unread).toContain(`${THREAD} · ${TASK} · 2 unread, 1 direct`)
    expect(unread).toContain('team_thread read')
    expect(unread).toContain('the gated fact')
    expect(unread).toContain('Next write — baseRevision: 8394')
    // The Claim archive still never rides along with a rejection: the affected
    // Claim and the facts are the decision surface, not the whole history.
    expect(unread).not.toContain('Active Claims')

    const stale = renderText(teamTools().get('team_task')!, { action: 'done', taskRef: TASK, baseRevision: 8387, claimRef: CLAIM }, {
      kind: 'stale_revision', taskRef: TASK, threadRef: THREAD, expectedRevision: 8387, revision: 8394, status: 'in_progress',
      claims: [{ claimRef: CLAIM, direction: 'Audit the render recovery paths', state: 'active', owner: 'member:owner' }],
      facts: [{ sequence: 8394, kind: 'message', messageRef: 'message:8394', body: 'the increment', sender: 'human', mentions: [], unread: true, direct: false }],
    })
    expect(stale).toContain('Not committed — the Thread changed after your last read (stale_revision).')
    expect(stale).toContain('the increment')
    expect(stale).toContain('Next write — baseRevision: 8394')

    // The copied-token refusal on the Claim side, because the Claim tool
    // renders its own rejections: a member that closes a Claim with a token
    // from another Thread gets the same correction, not the race sentence.
    const copied = renderText(teamTools().get('team_task')!, { action: 'done', taskRef: TASK, baseRevision: 4711, claimRef: CLAIM }, {
      kind: 'stale_revision', taskRef: TASK, threadRef: THREAD, expectedRevision: 4711, revision: 8394, status: 'in_progress', staleTokenKind: 'unrecognized',
      claims: [{ claimRef: CLAIM, direction: 'Audit the render recovery paths', state: 'active', owner: 'member:owner' }],
      facts: [{ sequence: 8394, kind: 'message', messageRef: 'message:8394', body: 'the increment', sender: 'human', mentions: [], unread: true, direct: false }],
    })
    expect(copied).toContain('Not committed — that write token was never a revision this Thread reached (stale_revision).')
    expect(copied).not.toContain('the Thread changed')
    expect(copied).not.toContain('the increment')
    expect(copied).not.toContain('Next write — baseRevision: 8394')
  })
})

describe('team_task renders Task resolutions and transfers', () => {
  const accountable = 'member:6e8a5b10-df16-4ec0-943a-63738010953f'

  it('accept names the conclusion, the standing, and the Claims it completed, with one token', () => {
    const text = renderText(teamTools().get('team_task')!, { action: 'accept', taskRef: TASK, baseRevision: 9024 }, {
      kind: 'committed', action: 'accept', taskRef: TASK, threadRef: THREAD, revision: 9030, status: 'done', resolution: 'accepted',
      accountable, acceptedClaimRefs: [CLAIM], claims: [{ claimRef: CLAIM, direction: 'd', state: 'done', owner: 'member:owner' }],
    })
    expect(text).toContain('Committed — Task accepted.')
    expect(text).toContain(`${THREAD} · ${TASK} · done/accepted · accountable ${accountable}`)
    expect(text).toContain(`accepted claims ${CLAIM}`)
    expect(occurrences(text, 'baseRevision')).toBe(1)
    // A Task resolution is not a Claim mutation: no Claim is rendered as "the affected" one.
    expect(text).not.toContain('Committed — Claim')
  })

  it('close and reopen are separate outcomes and name the Claims each concluded', () => {
    const closed = renderText(teamTools().get('team_task')!, { action: 'close', taskRef: TASK, baseRevision: 9024 }, {
      kind: 'committed', action: 'close', taskRef: TASK, threadRef: THREAD, revision: 9030, status: 'closed', resolution: 'closed',
      accountable, releasedClaimRefs: [CLAIM],
    })
    expect(closed).toContain('Committed — Task closed.')
    expect(closed).toContain('closed/closed')
    expect(closed).toContain(`released claims ${CLAIM}`)
    expect(closed).not.toContain('accepted claims')
    const reopened = renderText(teamTools().get('team_task')!, { action: 'reopen', taskRef: TASK, baseRevision: 9024 }, {
      kind: 'committed', action: 'reopen', taskRef: TASK, threadRef: THREAD, revision: 9031, status: 'todo', resolution: 'open', accountable,
    })
    expect(reopened).toContain('Committed — Task reopened.')
    expect(reopened).toContain('todo/open')
    expect(reopened).not.toContain('claims')
  })

  it('transfer renders who handed responsibility to whom, and says Claims did not move', () => {
    const text = renderText(teamTools().get('team_task')!, { action: 'transfer', taskRef: TASK, baseRevision: 9024, target: 'member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5' }, {
      kind: 'committed', action: 'transfer', taskRef: TASK, threadRef: THREAD, revision: 9032, status: 'in_review', resolution: 'open',
      accountable: 'member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5', from: accountable, to: 'member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5',
    })
    expect(text).toContain('Committed — Task transferred.')
    expect(text).toContain(`responsibility ${accountable} → member:6d5ac10d-3ef6-4466-a1f7-d105ca1b6da5; Claims stay with their owners.`)
    expect(occurrences(text, 'baseRevision')).toBe(1)
  })

  it('a rejection on a resolution keeps the shared form and the Task standing', () => {
    const text = renderText(teamTools().get('team_task')!, { action: 'accept', taskRef: TASK, baseRevision: 8000 }, {
      kind: 'unread_required', taskRef: TASK, threadRef: THREAD, revision: 8394, status: 'in_review', accountable,
      unreadCount: 1, directCount: 1,
      facts: [{ sequence: 8394, kind: 'message', messageRef: 'message:8394', body: 'the work is ready for review', sender: 'human', mentions: [], unread: true, direct: true }],
    })
    expect(text).toContain('Not committed — unread_required.')
    expect(text).toContain('the work is ready for review')
    expect(text).toContain('Next write — baseRevision: 8394')
  })
})

describe('descriptions state the cross-tool workflow', () => {
  it('baseRevision parameter descriptions say copy verbatim and never increment/derive', () => {
    const tools = teamTools()
    for (const name of ['team_message', 'team_task']) {
      const tool = tools.get(name)!
      const parameter = (tool.parameters as { properties?: Record<string, { description?: string }> }).properties?.baseRevision
      expect(parameter?.description).toContain('Copy the explicitly rendered value verbatim')
      expect(parameter?.description).toContain('never increment, derive, compare, or cite')
    }
  })

  it('team_thread description names read as the only read-side token source; team_view says address book', () => {
    const tools = teamTools()
    expect(tools.get('team_thread')!.description).toContain('only read-side source of a next-write token')
    expect(tools.get('team_thread')!.description).toContain('committed public mutations hand off the token as well')
    expect(tools.get('team_view')!.description).toContain('address book')
    expect(tools.get('team_inbox')!.description).toContain('without marking anything read')
    expect(tools.get('team_task')!.description).toContain('list only refreshes active Claims')
    expect(tools.get('team_task')!.description).toContain('from a drained read, your own commit, or a complete rejection that provides one')
    expect(tools.get('team_message')!.description).toContain('never acknowledge unread')
  })
})

describe('team tools render absolute event instants in UTC+8', () => {
  it('fact lines and the anchor carry the fixed-offset instant; absent occurredAt renders none', () => {
    const withInstants = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      kind: 'read', threadRef: THREAD, taskRef: TASK, revision: 9010, status: 'in_progress', resolution: 'open', following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'Investigate startup failure', sequence: 101, occurredAt: '2026-08-20T03:11:00.000Z' },
      claims: [],
      facts: [
        { sequence: 101, kind: 'message', messageRef: 'message:anchor', body: 'Investigate startup failure', sender: 'human', mentions: [], occurredAt: '2026-08-20T03:11:00.000Z', unread: false, direct: false },
        { sequence: 118, kind: 'message', messageRef: 'message:118', body: 'Reproduced on Windows', sender: 'member:builder', mentions: [], occurredAt: '2026-08-20T04:06:12.000Z', unread: false, direct: false },
        { sequence: 126, kind: 'activity', activity: 'accept', activityRef: 'activity:accept', actor: 'human', taskRef: TASK, threadRef: THREAD, occurredAt: '2026-08-21T01:30:44.000Z', unread: true, direct: false },
      ],
      readThroughSequence: 126, remainingUnreadCount: 0,
    })
    expect(withInstants).toContain('101 2026-08-20T11:11:00+08:00 [human]')
    expect(withInstants).toContain('118 2026-08-20T12:06:12+08:00 [member:builder] Reproduced on Windows')
    expect(withInstants).toContain(`126 human accept Task ${TASK} · Thread ${THREAD} · activity:accept 2026-08-21T09:30:44+08:00 [unread]`)
    // No relative time text: the render carries absolute instants only.
    expect(withInstants).not.toContain('ago')
    expect(withInstants).not.toContain('yesterday')
    // Absent occurredAt (pre-envelope fixtures) renders no timestamp column.
    const withoutInstants = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      kind: 'read', threadRef: THREAD, revision: 9010, following: false,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [],
      facts: [{ sequence: 12, kind: 'message', messageRef: 'message:12', body: 'plain message', sender: 'human', mentions: [] }],
      readThroughSequence: 12, remainingUnreadCount: 0,
    })
    expect(withoutInstants).toContain('12 [human] plain message')
    expect(withoutInstants).not.toContain('+08:00')
  })

  it('history renders the same fact instants as read — the cache invariant at the render layer', () => {
    const anchor = { messageRef: 'message:anchor', sender: 'human', body: 'Investigate startup failure', sequence: 101, occurredAt: '2026-08-20T03:11:00.000Z' }
    const facts = [
      { ...anchor, kind: 'message', mentions: [], unread: false, direct: false },
      { sequence: 118, kind: 'message', messageRef: 'message:118', body: 'Reproduced on Windows', sender: 'member:builder', mentions: [], occurredAt: '2026-08-20T04:06:12.000Z', unread: false, direct: false },
      { sequence: 126, kind: 'activity', activity: 'accept', activityRef: 'activity:accept', actor: 'human', taskRef: TASK, threadRef: THREAD, occurredAt: '2026-08-21T01:30:44.000Z', unread: false, direct: false },
    ] as never
    const read = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: THREAD }, {
      kind: 'read', threadRef: THREAD, revision: 9010, following: true, anchor, claims: [], facts,
      readThroughSequence: 126, remainingUnreadCount: 0,
    })
    const history = renderText(teamTools().get('team_thread')!, { action: 'history', threadRef: THREAD }, {
      kind: 'history', threadRef: THREAD, revision: 9010, following: true, anchor, claims: [], facts,
      cursor: 118, hasMore: true,
    })
    expect(read).toContain('118 2026-08-20T12:06:12+08:00 [member:builder] Reproduced on Windows')
    expect(history).toContain('118 2026-08-20T12:06:12+08:00 [member:builder] Reproduced on Windows')
    expect(read).toContain(`126 human accept Task ${TASK} · Thread ${THREAD} · activity:accept 2026-08-21T09:30:44+08:00`)
    expect(history).toContain(`126 human accept Task ${TASK} · Thread ${THREAD} · activity:accept 2026-08-21T09:30:44+08:00`)
    expect(read).toContain('101 2026-08-20T11:11:00+08:00 [human]')
    expect(history).toContain('101 2026-08-20T11:11:00+08:00 [human]')
  })

  it('inbox rows carry the newest unread instant; view rows carry last activity', () => {
    const inbox = renderText(teamTools().get('team_inbox')!, {}, {
      totalUnreadCount: 4, totalDirectCount: 1, hasMore: false, main: [],
      items: [{ threadRef: THREAD, projectRef: PROJECT, taskRef: TASK, status: 'in_progress', revision: 100, unreadCount: 4, directCount: 1, taskNumber: 7, newestOccurredAt: '2026-09-08T08:58:41.000Z' }],
    })
    expect(inbox).toContain(`4 unread, 1 direct · newest 2026-09-08T16:58:41+08:00`)
    const view = renderText(teamTools().get('team_view')!, {}, {
      workspaces: WORKSPACES, projects: [], members: [],
      threads: [{ threadRef: THREAD, projectRef: PROJECT, revision: 1, messageCount: 3, subject: 'Investigate startup failure', lastActivityAt: '2026-08-21T01:30:44.000Z' }],
      tasks: [], cursor: 0, hasMore: false,
    })
    expect(view).toContain('— Investigate startup failure · last activity 2026-08-21T09:30:44+08:00')
  })

  it('committed mutations and delivered DMs state their commit instant', () => {
    const reply = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8201, body: 'x' }, {
      kind: 'committed', action: 'reply', messageRef: 'message:9a1d', threadRef: THREAD, revision: 8202, occurredAt: '2026-09-08T09:00:00.000Z',
    })
    expect(reply).toContain('Committed at 2026-09-08T17:00:00+08:00')
    const claim = renderText(teamTools().get('team_task')!, { action: 'claim', taskRef: TASK, baseRevision: 8201, direction: 'x' }, {
      kind: 'committed', action: 'claim', taskRef: TASK, threadRef: THREAD, revision: 8202, status: 'in_progress',
      claim: { claimRef: CLAIM, direction: 'x', state: 'active', owner: 'member:me' }, claims: [], occurredAt: '2026-09-08T09:00:00.000Z',
    })
    expect(claim).toContain('Committed at 2026-09-08T17:00:00+08:00')
    const dm = renderText(teamTools().get('team_dm')!, { memberRef: 'member:peer', body: 'x' }, {
      kind: 'dm-sent', recipientMemberId: 'member:peer', recipientHandle: 'Cole', delivered: true, occurredAt: '2026-09-08T09:00:00.000Z',
    })
    expect(dm).toBe('Delivered — DM to @Cole (member:peer) at 2026-09-08T17:00:00+08:00.')
  })

  it('absent instants on committed outcomes render no timestamp line, keeping old fixtures stable', () => {
    const reply = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8201, body: 'x' }, {
      kind: 'committed', action: 'reply', messageRef: 'message:9a1d', threadRef: THREAD, revision: 8202,
    })
    expect(reply).not.toContain('Committed at')
    expect(reply).not.toContain('+08:00')
  })
})

describe('the Main stream through team_thread and team_message', () => {
  const entries = [
    { sequence: 5, kind: 'message', occurredAt: '2026-09-08T09:00:00.000Z', unread: true, direct: true, sender: 'member:human', messageRef: 'message:main-1',
      body: 'Ship the draft today', mentions: ['member:me'] },
    { sequence: 6, kind: 'thread-card', occurredAt: '2026-09-08T09:05:00.000Z', unread: false, direct: false, sender: 'member:human', threadRef: THREAD,
      preview: 'Fix the importer', replyCount: 2, participants: ['human', 'Tars'], taskRef: TASK, taskNumber: 3, status: 'in_progress', resolution: 'open',
      accountable: 'member:6e8a5b10-df16-4ec0-943a-63738010953f', liveClaimOwners: ['Tars'] },
  ]

  it('renders a Main stream read with markers on entries and cards as current state, with no write token', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', projectRef: PROJECT }, {
      workspaceId: 'workspace:alpha', projectRef: PROJECT, scope: 'main', kind: 'read', entries, readThroughSequence: 6, remainingUnreadCount: 0,
    })
    expect(text).toContain('Read committed — acknowledged 1 unread update(s) on the Main stream')
    expect(text).toContain('5 2026-09-08T17:00:00+08:00 [member:human] [direct]')
    expect(text).toContain(`[thread card] Task ${TASK} (#3), in_progress/open, accountable member:6e8a5b10-df16-4ec0-943a-63738010953f — working: Tars — Fix the importer · ${THREAD} · 2 replies`)
    expect(text).not.toContain('baseRevision')
  })

  it('renders posted messages and the owner-read rejection with its single way out', () => {
    const tool = teamTools().get('team_message')!
    const committed = renderText(tool, { action: 'post', projectRef: PROJECT, body: 'x' }, { kind: 'committed', action: 'post', projectRef: PROJECT, messageRef: 'message:main-2' })
    expect(committed).toContain('Committed — Main stream message posted.')
    expect(committed).not.toContain('baseRevision')
    const blocked = renderText(tool, { action: 'post', projectRef: PROJECT, body: 'x' }, { kind: 'main_unread_required', projectRef: PROJECT, unreadCount: 1, directCount: 1, entries })
    expect(blocked).toContain('Not committed — main_unread_required.')
    expect(blocked).toContain(`team_thread read and projectRef ${PROJECT}`)
  })
})

describe('an Attention result names what established it', () => {
  it('states the cause once the reader follows, and no cause once it does not', () => {
    const tool = teamTools().get('team_attention')!
    // A status on a stream the reader follows names the cause of its Attention.
    const following = renderText(tool, {}, {
      workspaceId: 'workspace:alpha', projectRef: PROJECT, kind: 'status', scope: 'main', following: true, source: 'project-owner',
    })
    expect(following).toContain('following the Main stream')
    expect(following).toContain('because you own the Project')
    // A status on a stream the reader does not follow has no cause to name.
    const unfollowed = renderText(tool, {}, {
      workspaceId: 'workspace:alpha', projectRef: PROJECT, kind: 'status', scope: 'main', following: false,
    })
    expect(unfollowed).toContain('not following the Main stream')
    expect(unfollowed).not.toContain('because')
    // Every cause has words, so no source ever renders as a raw enum value.
    for (const source of ['thread-author', 'claim', 'accountable', 'project-owner', 'mention', 'self']) {
      const text = renderText(tool, {}, {
        workspaceId: 'workspace:alpha', projectRef: PROJECT, threadRef: THREAD, kind: 'status', scope: 'thread',
        following: true, source, revision: 12,
      })
      expect(text).toContain(`Thread ${THREAD}`)
      expect(text).toMatch(/\(because [a-z]/)
      expect(text).not.toContain(`(${source})`)
    }
  })

  it('tells a new Claim owner that it now follows the Thread', () => {
    const text = renderText(teamTools().get('team_task')!, {}, {
      kind: 'committed', action: 'claim', taskRef: TASK, threadRef: THREAD, revision: 12,
      status: 'in_progress', claim: { claimRef: CLAIM, state: 'active', owner: 'Tars', direction: 'Implement' },
      claims: [], source: 'claim',
    })
    expect(text).toContain('You now follow this Thread (because you claimed its Task)')
    expect(text).toContain('team_attention unfollow with threadRef stops them and releases no Claim')
  })

  it('tells a Thread author that starting it follows it', () => {
    const text = renderText(teamTools().get('team_message')!, {}, {
      kind: 'committed', action: 'start', threadRef: THREAD, messageRef: 'message:1', revision: 12, source: 'thread-author',
    })
    expect(text).toContain('You now follow this Thread (because you started it)')
    // A reply never starts Attention, so it carries no cause.
    const reply = renderText(teamTools().get('team_message')!, {}, {
      kind: 'committed', action: 'reply', threadRef: THREAD, messageRef: 'message:2', revision: 13,
    })
    expect(reply).not.toContain('You now follow')
  })
})

describe('every declared output shape accepts what its tool returns', () => {
  /**
   * The render harness renders directly, so it never sees the schema the Host
   * validates a result against. A property the tool returns but the schema does
   * not declare fails at runtime with `additionalProperties: false` — which is
   * how the Claim's `source` reached the model as an error rather than a result.
   */
  const validate = (tool: Parameters<typeof renderText>[0], value: unknown): void => {
    // The Host throws on any violation, so the assertion is on the returned list.
    expect(validateJsonSchemaValue(tool.output.schema as never, value as never)).toEqual([])
  }

  it('accepts the Claim result that carries the Attention it started', () => {
    const tool = teamTools().get('team_task')!
    validate(tool, {
      kind: 'committed', action: 'claim', taskRef: TASK, threadRef: THREAD, revision: 12,
      status: 'in_progress', claim: { claimRef: CLAIM, state: 'active', owner: 'Tars', direction: 'Implement' },
      claims: [], source: 'claim',
    })
  })

  it('accepts every Attention result shape, with and without a cause', () => {
    const tool = teamTools().get('team_attention')!
    for (const source of ['thread-author', 'claim', 'accountable', 'project-owner', 'mention', 'self']) {
      validate(tool, { workspaceId: 'workspace:alpha', projectRef: PROJECT, threadRef: THREAD,
        kind: 'follow', scope: 'thread', following: true, source, revision: 12 })
    }
    validate(tool, { workspaceId: 'workspace:alpha', projectRef: PROJECT, kind: 'status', scope: 'main', following: false })
    validate(tool, { workspaceId: 'workspace:alpha', projectRef: PROJECT, kind: 'status', scope: 'main', following: true, source: 'project-owner' })
  })

  it('accepts a Thread start that names its own Attention, and a reply that names none', () => {
    const tool = teamTools().get('team_message')!
    validate(tool, { kind: 'committed', action: 'start', threadRef: THREAD, messageRef: 'message:1', revision: 12, source: 'thread-author' })
    validate(tool, { kind: 'committed', action: 'reply', threadRef: THREAD, messageRef: 'message:2', revision: 13 })
  })
})
