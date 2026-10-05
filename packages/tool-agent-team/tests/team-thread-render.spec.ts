import { describe, expect, it } from 'vitest'
import { renderText, teamTools } from './render-text.ts'

/**
 * Render-layer discriminating tests for the Team collaboration tools.
 * Renders are the only channel a tool result reaches the model through:
 * a bare `accept` activity string left the model unable to see who
 * accepted what, or that its own Claim was completed by the acceptance —
 * the regression this suite locks out.
 */

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

describe('team_thread renders the model-facing decision surface', () => {
  it('an accept activity renders actor, Task ref, and the Claims it concluded — not a bare kind', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', channelRef: 'channel:046dd831-c679-4279-b6aa-7813476cf12e',
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

  it('an unread accept with usage below the task-boundary threshold advises keeping the context', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', channelRef: 'channel:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:x', taskRef: 'task:x', revision: 100, status: 'done', resolution: 'accepted', following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [], facts: [ACCEPT_FACT],
      readThroughSequence: 8190, remainingUnreadCount: 0,
      contextAdvice: {
        usageTokens: 96_000, taskBoundaryThreshold: 128_000, handoffAt: 200_000, hardLimit: 256_000,
        action: 'keep',
        guidance: 'Keep the current context for possible acceptance follow-up. This acceptance is already a timeline boundary; do not create a redundant checkpoint. Record a checkpoint only before the next noisy or risky phase.',
      },
    })
    expect(text).toContain('96,000')
    expect(text).toContain('128,000')
    expect(text).toContain('200,000')
    expect(text).toContain('keep')
    expect(text).toContain('do not create a redundant checkpoint')
  })

  it('an unread accept at or above the threshold advises a fresh rollover after closeout', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', channelRef: 'channel:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:x', taskRef: 'task:x', revision: 100, status: 'done', resolution: 'accepted', following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [], facts: [ACCEPT_FACT],
      readThroughSequence: 8190, remainingUnreadCount: 0,
      contextAdvice: {
        usageTokens: 156_000, taskBoundaryThreshold: 128_000, handoffAt: 200_000, hardLimit: 256_000,
        action: 'rollover',
        guidance: 'Finish the acceptance closeout, persist only durable reusable conclusions, collect or stop jobs, then call context_rollover with a fresh handoff covering every other active Claim. Do not return to an old checkpoint solely because this Task was accepted.',
      },
    })
    expect(text).toContain('156,000')
    expect(text).toContain('context_rollover')
    expect(text).toContain('covering every other active Claim')
  })

  it('an unread accept already at handoffAt advises handing off now', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', channelRef: 'channel:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:x', taskRef: 'task:x', revision: 100, status: 'done', resolution: 'accepted', following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [], facts: [ACCEPT_FACT],
      readThroughSequence: 8190, remainingUnreadCount: 0,
      contextAdvice: {
        usageTokens: 203_000, taskBoundaryThreshold: 128_000, handoffAt: 200_000, hardLimit: 256_000,
        action: 'compact-now',
        guidance: 'You are at or above the handoff budget. Finish the current atomic action and unsettled evidence, then call context_compact with a summary you write yourself — that shortens this generation in place, keeps your recent work verbatim, and is the default. Roll over only when the work has turned a page.',
      },
    })
    expect(text).toContain('203,000')
    expect(text).toContain('compact-now')
  })

  it('a read without unread accepts renders no context advice section', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', channelRef: 'channel:046dd831-c679-4279-b6aa-7813476cf12e',
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
      workspaceId: 'workspace:alpha', channelRef: 'channel:046dd831-c679-4279-b6aa-7813476cf12e',
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
      workspaceId: 'workspace:alpha', channelRef: 'channel:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:x', revision: 100, following: false,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [],
      facts: [{ sequence: 13, kind: 'activity', activity: 'claim', actor: 'builder', taskRef: 'task:x', claimRef: 'claim:x', unread: true, direct: false }],
      readThroughSequence: 13, remainingUnreadCount: 0,
    })
    expect(activityText).not.toContain('Context guidance')
  })

  it('history renders structured activities but never context advice', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      kind: 'history', threadRef: 'thread:x', taskRef: 'task:x', revision: 100, status: 'done', resolution: 'accepted', following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [],
      facts: [ACCEPT_FACT],
      cursor: 8190, hasMore: false,
      contextAdvice: undefined,
    })
    expect(text).toContain('claim:7ad04d38-3889-4414-ac0c-23f73c0b962a')
    expect(text).not.toContain('Context guidance')
  })

  it('an unavailable measurement renders an explicit fallback, never a fabricated threshold verdict', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', channelRef: 'channel:046dd831-c679-4279-b6aa-7813476cf12e',
      kind: 'read', threadRef: 'thread:x', taskRef: 'task:x', revision: 100, status: 'done', resolution: 'accepted', following: true,
      anchor: { messageRef: 'message:anchor', sender: 'human', body: 'anchor', sequence: 1 },
      claims: [], facts: [ACCEPT_FACT],
      readThroughSequence: 8190, remainingUnreadCount: 0,
      contextAdvice: {
        usageTokens: undefined as never, taskBoundaryThreshold: undefined as never, handoffAt: 200_000, hardLimit: 256_000,
        action: 'unavailable',
        guidance: 'Context usage could not be measured for this acceptance; manage context by your existing pressure policy.',
      },
    })
    expect(text).toContain('could not be measured')
    expect(text).not.toContain('usageTokens')
  })

  it('a read that left facts behind states how many, so a returning reader sees the span it is not looking at', () => {
    const text = renderText(teamTools().get('team_thread')!, {}, {
      workspaceId: 'workspace:alpha', channelRef: 'channel:046dd831-c679-4279-b6aa-7813476cf12e',
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
