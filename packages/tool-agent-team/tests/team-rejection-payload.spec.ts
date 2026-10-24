import { describe, expect, it } from 'vitest'
import { occurrences, renderText, teamTools } from './render-text.ts'

/**
 * Discriminating render tests for Project C: a rejected write renders the new
 * facts and the next write token in the SAME tool result, so the model never
 * pays a separate `team_thread read` round-trip to learn what changed.
 *
 * These lock the presence AND absence of exactly the fields the next decision
 * needs. The old contract — "a rejection carries no changed facts, so it never
 * renders a numeric revision or a next-write token" — is what this file
 * overturns, so the former `.not.toContain('8394')` assertions are gone here on
 * purpose and live inverted in `team-tools-render.spec.ts`.
 *
 * Absence assertions still target labels, never bare numbers: fact sequences,
 * read-through watermarks, and cursors legitimately render everywhere.
 */

const THREAD = 'thread:d78400e4-4925-4065-87b1-3f81b4a4b5fb'
const TASK = 'task:3245ad40-43fd-4191-a416-7dcaf3a340f2'
const CLAIM = 'claim:326f0b21-a41c-4c47-be18-ad0d4ecfc139'
const MEMBER = 'member:6e8a5b10-df16-4ec0-943a-63738010953f'

/** One unread message fact, shaped exactly as `read` returns it. */
function messageFact(sequence: number, body: string, options: { direct?: boolean; sender?: string } = {}) {
  return { sequence, kind: 'message', body, sender: options.sender ?? 'human', mentions: [],
    unread: true, direct: options.direct ?? false }
}

describe('unread_required renders the facts it is gating on', () => {
  it('renders every unread fact body, keeps the counts, and hands back the current revision', () => {
    const text = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8000, body: 'x' }, {
      kind: 'unread_required', threadRef: THREAD, taskRef: TASK, revision: 8394, unreadCount: 2, directCount: 1,
      facts: [messageFact(8393, 'First unread message'), messageFact(8394, 'The direct mention', { direct: true })],
    })
    // Outcome first, then the identity line that still carries the counts.
    expect(text).toContain('Not committed — unread_required.')
    expect(text).toContain(`${THREAD} · ${TASK} · 2 unread, 1 direct`)
    // The bodies arrive in the same result: this is the round-trip being removed.
    expect(text).toContain('First unread message')
    expect(text).toContain('The direct mention')
    // Unread/direct markers sit on the fact line itself, same as a read.
    expect(text).toContain('8394 [human] [direct] The direct mention')
    expect(text).toContain('8393 [human] [unread] First unread message')
    // And the current revision is written back as the next write token.
    expect(text).toContain('Next write — baseRevision: 8394')
    // Exactly one token: a second one would make the hand-off ambiguous.
    expect(occurrences(text, 'Next write — baseRevision:')).toBe(1)
  })

  it('renders activity facts, not just messages', () => {
    const text = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8000, body: 'x' }, {
      kind: 'unread_required', threadRef: THREAD, revision: 8400, unreadCount: 1, directCount: 0,
      facts: [{ sequence: 8400, kind: 'activity', activity: 'claim', actor: 'builder', taskRef: TASK,
        claimRef: CLAIM, unread: true, direct: false }],
    })
    expect(text).toContain('8400 builder claim')
    expect(text).toContain(`Task ${TASK}`)
    expect(text).toContain(`Claim ${CLAIM}`)
    expect(text).toContain('Next write — baseRevision: 8400')
  })

  it('a rejection carrying no facts still renders the token and the read route', () => {
    // A legacy or degenerate payload must not silently lose the hand-off: with
    // no bodies to show, the revision and the recovery route are all the model
    // has, so both must survive.
    const text = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8000, body: 'x' }, {
      kind: 'unread_required', threadRef: THREAD, revision: 8394, unreadCount: 0, directCount: 0, facts: [],
    })
    expect(text).toContain('Not committed — unread_required.')
    expect(text).toContain('Next write — baseRevision: 8394')
    expect(text).toContain('team_thread read')
  })
})

describe('stale_revision renders the increment it rejected against', () => {
  it('renders the facts added since the stale baseRevision and the current revision', () => {
    const text = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8387, body: 'x' }, {
      kind: 'stale_revision', threadRef: THREAD, expectedRevision: 8387, revision: 8394,
      facts: [messageFact(8394, 'A teammate replied while you were writing')],
    })
    expect(text).toContain('Not committed — the Thread changed after your last read (stale_revision).')
    expect(text).toContain('A teammate replied while you were writing')
    // The revision the model actually needs next is the CURRENT one, not the
    // obsolete token it just tried — naming the stale value would invite a
    // second rejection.
    expect(text).toContain('Next write — baseRevision: 8394')
    expect(occurrences(text, 'Next write — baseRevision:')).toBe(1)
  })

  it('names the increment window so the model knows what the span covers', () => {
    const text = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8387, body: 'x' }, {
      kind: 'stale_revision', threadRef: THREAD, expectedRevision: 8387, revision: 8394,
      facts: [messageFact(8388, 'first'), messageFact(8389, 'second'), messageFact(8394, 'third')],
    })
    expect(text).toContain('3')
    expect(text).toContain('third')
    expect(text).toContain('Next write — baseRevision: 8394')
  })

  it('an empty increment still hands back the current revision', () => {
    // Nothing new to show, but the token must still move forward — otherwise
    // the retry repeats the same rejection forever.
    const text = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8387, body: 'x' }, {
      kind: 'stale_revision', threadRef: THREAD, expectedRevision: 8387, revision: 8394, facts: [],
    })
    expect(text).toContain('Next write — baseRevision: 8394')
  })
})

describe('the claim mutation shares the same rejection shape', () => {
  it('unread_required on team_task renders the bodies and the token too', () => {
    const text = renderText(teamTools().get('team_task')!, { action: 'claim', taskRef: TASK, baseRevision: 8000, direction: 'd' }, {
      kind: 'unread_required', taskRef: TASK, threadRef: THREAD, revision: 8394, unreadCount: 1, directCount: 0,
      facts: [messageFact(8394, 'Discussion to read first')],
    })
    expect(text).toContain('Not committed — unread_required.')
    expect(text).toContain('Discussion to read first')
    expect(text).toContain('Next write — baseRevision: 8394')
  })

  it('stale_revision on team_task renders the increment and the token', () => {
    const text = renderText(teamTools().get('team_task')!, { action: 'done', taskRef: TASK, baseRevision: 8387, claimRef: CLAIM }, {
      kind: 'stale_revision', taskRef: TASK, threadRef: THREAD, expectedRevision: 8387, revision: 8394,
      facts: [messageFact(8394, 'New fact in the way')],
    })
    expect(text).toContain('New fact in the way')
    expect(text).toContain('Next write — baseRevision: 8394')
  })
})

describe('the rejection render never invents a second write token', () => {
  it('the recovery sentence stays a route to read, and does not repeat the token', () => {
    const text = renderText(teamTools().get('team_message')!, { action: 'reply', threadRef: THREAD, baseRevision: 8000, body: 'x' }, {
      kind: 'unread_required', threadRef: THREAD, revision: 8394, unreadCount: 1, directCount: 1,
      facts: [messageFact(8394, 'the mention', { direct: true, sender: MEMBER })],
    })
    // The old recovery sentence told the model to go read; it must still name
    // the tool that drains the queue, because the facts here are the gate, not
    // a replacement for acknowledging them.
    expect(text).toContain('team_thread read')
    // One token only, and it is the current revision.
    expect(occurrences(text, 'Next write — baseRevision:')).toBe(1)
    expect(text).toContain('Next write — baseRevision: 8394')
  })
})
