import { describe, expect, it } from 'vitest'
import { renderText, teamTools } from './render-text.ts'

const ACCEPT_FACT = {
  sequence: 8190,
  kind: 'activity',
  activity: 'accept',
  actor: 'human',
  taskRef: 'task:205a8ba6-f3c6-4fbc-95b7-c3448191f730',
  completedClaimRefs: ['claim:7ad04d38-3889-4414-ac0c-23f73c0b962a'],
  acceptedClaimRefs: ['claim:7ad04d38-3889-4414-ac0c-23f73c0b962a'],
  unread: true,
  direct: false,
}

describe('team_thread renders Task accountability with the Task standing', () => {
  it('a read of a Taskful Thread names its accountable owner on the identity line', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: 'thread:x' }, {
      workspaceId: 'workspace:alpha', projectRef: 'project:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:x', taskRef: 'task:205a8ba6-f3c6-4fbc-95b7-c3448191f730', taskNumber: 7,
      revision: 100, status: 'in_review', resolution: 'open', accountable: 'member:6e8a5b10-df16-4ec0-943a-63738010953f', following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [], facts: [], readThroughSequence: 100, remainingUnreadCount: 0,
    })
    expect(text.split('\n')[2]).toBe('thread:x · task:205a8ba6-f3c6-4fbc-95b7-c3448191f730 (#7), in_review/open · accountable member:6e8a5b10-df16-4ec0-943a-63738010953f · following')
  })

  it('a taskless Thread renders no accountability, because there is no Task to be responsible for', () => {
    const text = renderText(teamTools().get('team_thread')!, { action: 'read', threadRef: 'thread:x' }, {
      workspaceId: 'workspace:alpha', projectRef: 'project:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:x', revision: 100, following: false,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [], facts: [], readThroughSequence: 100, remainingUnreadCount: 0,
    })
    expect(text).not.toContain('accountable')
  })
})

describe('team_thread renders the model-facing decision surface', () => {
  it('an accept activity renders actor, Task ref, and the Claims it concluded — not a bare kind', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', projectRef: 'project:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:cb7e5eca-9a73-4fa6-9fdf-260996597e7d',
      taskRef: 'task:205a8ba6-f3c6-4fbc-95b7-c3448191f730',
      revision: 8190, status: 'done', resolution: 'accepted', following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [{ claimRef: 'claim:7ad04d38-3889-4414-ac0c-23f73c0b962a', direction: 'ship it', state: 'done', owner: 'member:6e8a5b10-df16-4ec0-943a-63738010953f' }],
      facts: [ACCEPT_FACT],
      readThroughSequence: 8190, remainingUnreadCount: 0,
    })
    // The outcome line names the Thread, and the context line carries the
    // Task's standing — never just the Thread revision.
    expect(text).toContain('thread:cb7e5eca-9a73-4fa6-9fdf-260996597e7d')
    expect(text.split('\n')[1]).toContain('thread:cb7e5eca-9a73-4fa6-9fdf-260996597e7d')
    expect(text).toContain('task:205a8ba6-f3c6-4fbc-95b7-c3448191f730')
    expect(text).toContain('accepted')
    // The activity line names the actor and every Claim the acceptance
    // concluded, so the owner can see its own Claim completed.
    expect(text).toContain('8190')
    expect(text).toContain('human')
    expect(text).toContain('accept')
    expect(text).toContain('claim:7ad04d38-3889-4414-ac0c-23f73c0b962a')
  })

  it('a read states its facts and never recommends a context action', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', projectRef: 'project:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:x', revision: 100, following: false,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [],
      facts: [{ sequence: 12, kind: 'message', body: 'plain message', sender: 'human', mentions: [], unread: false, direct: false }],
      readThroughSequence: 12, remainingUnreadCount: 0,
    })
    // Taskless results keep the identifying surface: the outcome line still
    // names the Thread even when there is no Task standing to state.
    expect(text).toContain('thread:x')
    expect(text.split('\n')[1]).toContain('thread:x')
    expect(text).not.toContain('Context guidance')
    expect(text).not.toContain('usageTokens')
    // The empty-facts status path keeps the same identifying header.
    const statusText = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', projectRef: 'project:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'status', threadRef: 'thread:x', revision: 100, following: false,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [],
      facts: [],
      readThroughSequence: 12, remainingUnreadCount: 0,
    })
    expect(statusText).toContain('thread:x')
    expect(statusText.split('\n')[1]).toContain('thread:x')
    // Advice never appears for a non-accept activity even when unread.
    const activityText = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', projectRef: 'project:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:x', revision: 100, following: false,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [],
      facts: [{ sequence: 13, kind: 'activity', activity: 'claim', actor: 'builder', taskRef: 'task:x', claimRef: 'claim:x', unread: true, direct: false }],
      readThroughSequence: 13, remainingUnreadCount: 0,
    })
    expect(activityText).not.toContain('Context guidance')
  })

  it('history renders structured activities and no context section', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      kind: 'history', threadRef: 'thread:x', taskRef: 'task:x', revision: 100, status: 'done', resolution: 'accepted', following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [],
      facts: [ACCEPT_FACT],
      cursor: 8190, hasMore: false,
    })
    expect(text).toContain('claim:7ad04d38-3889-4414-ac0c-23f73c0b962a')
    expect(text).not.toContain('Context guidance')
  })

  it('a read that left facts behind states how many, so a returning reader sees the span it is not looking at', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', projectRef: 'project:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:x', revision: 400, following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [],
      facts: [{ sequence: 400, kind: 'message', body: 'the mention', sender: 'human', mentions: [], unread: true, direct: true, occurredAt: '2026-09-15T06:00:00.000Z' }],
      readThroughSequence: 400, remainingUnreadCount: 0, earlierFactCount: 137,
    })
    // The watermark alone never said how much the reader had not seen: the
    // count is what turns "you are here" into "this much precedes you".
    expect(text).toContain('Read through sequence 400')
    expect(text).toContain('Earlier facts: 137')
    expect(text).toContain('team_thread.history')
  })

  it('a read that reached everything renders no earlier-facts line, and an absent count stays valid', () => {
    const reached = renderText(teamTools().get('team_thread')!, {}, {
      kind: 'read', threadRef: 'thread:x', revision: 12, following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [],
      facts: [{ sequence: 12, kind: 'message', body: 'caught up', sender: 'human', mentions: [], unread: true, direct: false, occurredAt: '2026-09-15T06:00:00.000Z' }],
      readThroughSequence: 12, remainingUnreadCount: 0, earlierFactCount: 0,
    })
    expect(reached).not.toContain('Earlier facts')
    // A legacy read snapshot carries no count at all; the render must stay
    // valid and silent rather than inventing one.
    const legacy = renderText(teamTools().get('team_thread')!, {}, {
      kind: 'read', threadRef: 'thread:x', revision: 12, following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [], facts: [],
      readThroughSequence: 12, remainingUnreadCount: 0,
    })
    expect(legacy).not.toContain('Earlier facts')
    expect(legacy).toContain('Read through sequence 12')
  })
})

/**
 * The reply link as the model sees it: a bare ref says a Message answers
 * something, and nothing about what. These renders are the only place that
 * becomes legible, so the discriminating assertion is the one that fails when
 * only the ref is printed.
 */
describe('team_thread shows what a reply answers', () => {
  const READ_BASE = {
    workspaceId: 'workspace:alpha', projectRef: 'project:046dd831-c679-4279-b6aa-7813476cf12e',
    kind: 'read', threadRef: 'thread:cb7e5eca-9a73-4fa6-9fdf-260996597e7d',
    revision: 9, following: true,
    anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor body', sequence: 1 },
    claims: [], readThroughSequence: 9, remainingUnreadCount: 0,
  }
  const ANSWER = { sender: 'architect', excerpt: 'The stored schema never named the field' }

  it('names the author and the summary, not just the ref', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      ...READ_BASE,
      facts: [{ sequence: 9, kind: 'message', sender: 'member:builder', body: 'Looking now', mentions: [],
        replyToMessageRef: 'message:parent', replyTo: ANSWER, unread: true, direct: false }],
    })
    expect(text).toContain('(replies to @architect — "The stored schema never named the field")')
    // The ref alone is what the model could not read; it must not be the answer.
    expect(text).not.toContain('(replies to message:parent)')
  })

  it('falls back to the bare ref when the target could not be resolved', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      ...READ_BASE,
      facts: [{ sequence: 9, kind: 'message', sender: 'member:builder', body: 'Looking now', mentions: [],
        replyToMessageRef: 'message:parent', unread: true, direct: false }],
    })
    expect(text).toContain('(replies to message:parent)')
  })

  it('says it for the anchor too, which is a Message like any other', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      ...READ_BASE,
      anchor: { messageRef: 'message:anchor', sender: 'member:builder', body: 'anchor body', sequence: 1,
        replyToMessageRef: 'message:parent', replyTo: ANSWER },
      facts: [{ sequence: 1, kind: 'message', messageRef: 'message:anchor', sender: 'member:builder', body: 'anchor body',
        mentions: [], replyToMessageRef: 'message:parent', replyTo: ANSWER, unread: false, direct: false },
      { sequence: 2, kind: 'message', sender: 'human', body: 'earlier context', mentions: [], unread: false, direct: false }],
    })
    expect(text).toContain('(replies to @architect — "The stored schema never named the field")')
  })

  it('prints the whole body for the message action, never a summary', () => {
    const body = `First line is short\n第二行 @reviewer 提到别人\n${'z'.repeat(200)}`
    const text = renderText(teamTools().get('team_thread')!, {}, {
      ...READ_BASE,
      kind: 'message', facts: [],
      message: { messageRef: 'message:parent', sender: 'human', sequence: 1, body },
    })
    expect(text).toContain(body)
    expect(text).not.toContain('…')
    expect(text.length).toBeGreaterThan(200)
  })

  it('declares every field those renders read, because an undeclared value throws', () => {
    const tool = teamTools().get('team_thread')!
    const schema = tool.output.schema as Record<string, any>
    // `additionalProperties: false` is enforced against the returned value, so a
    // field a render reads and the schema does not name fails the whole call.
    expect(schema.properties.message.required).toContain('body')
    expect(schema.properties.message.required).toContain('messageRef')
    expect(schema.properties.facts.items.properties.replyTo).toBeDefined()
    expect(schema.properties.anchor.properties.replyTo).toBeDefined()
    expect(schema.properties.anchor.properties.replyToMessageRef).toBeDefined()
    // and the action is addressable at all (registered parameters are one
    // JSON-Schema object, not the flat map the definition is written as)
    const parameters = tool.parameters as Record<string, any>
    expect(parameters.properties.action.enum).toContain('message')
    expect(parameters.properties.messageRef).toBeDefined()
  })
})
