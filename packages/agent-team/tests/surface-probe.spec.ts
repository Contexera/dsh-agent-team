import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { isFactOnSurface, visibleTeamTexts } from '../src/surface-visibility.ts'
import type { AgentTeamThreadReadFact } from '../src/types.ts'

/**
 * The surface probe: whether one unread fact is already on a Member's
 * model-visible surface, in full.
 *
 * This is the half of Channel B that decides *what counts as read*. The three
 * properties that make the whole channel safe are locked here, because the
 * integration suite can only prove what the probe is handed:
 *
 *  1. A Team-authored event whose text carries the body verbatim is a hit.
 *  2. A truncated notice is never a hit — the model never saw the whole body.
 *  3. An ordinary notice, which carries a count and not a character of body,
 *     is never a hit; and another producer's events are not this plugin's.
 */

/** One user message as the Session log holds it, reduced to what the probe reads. */
interface FakeEvent {
  readonly type: 'user/message'
  readonly data: {
    readonly source: { readonly kind: string }
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }
}

/**
 * A Session-shaped object exposing only what the probe touches: the surface
 * node identities and a one-event window read. Built from a list of events, so
 * node `i` resolves to event `i` exactly as the seq = log.length contract says.
 */
function fakeAgent(events: readonly FakeEvent[]): Agent {
  const nodes = events.map((_, index) => index)
  return {
    session: {
      surface: { nodes },
      snapshotEvents: (from: unknown, to: unknown) => {
        const start = from as number
        const end = to as number
        return events.slice(start, end)
      },
    },
  } as never
}

/** A user message from this plugin, as a notice or DM relay renders one. */
function teamEvent(text: string): FakeEvent {
  return { type: 'user/message', data: { source: { kind: AGENT_TEAM_PLUGIN_ID }, content: [{ type: 'text', text }] } }
}

/** A message from any other producer, which must never be read as Team's own. */
function foreignEvent(text: string): FakeEvent {
  return { type: 'user/message', data: { source: { kind: 'plugin:someone-else' }, content: [{ type: 'text', text }] } }
}

/** The unread fact the gate is refusing over. */
function factOf(body: string, sequence = 12): AgentTeamThreadReadFact {
  return { fact: { kind: 'message', sequence, message: { messageRef: 'message:a', body } as never, mentions: [], occurredAt: '2026-10-14T00:00:00.000Z' }, unread: true, direct: true } as never
}

describe('the probe reads only this plugin own surface events', () => {
  it('collects the text of Team-authored events and ignores every other producer', () => {
    const agent = fakeAgent([teamEvent('Team notice body'), foreignEvent('another producer body')])
    expect(visibleTeamTexts(agent)).toEqual(['Team notice body'])
  })

  it('ignores non-message events and non-text content parts', () => {
    const agent = fakeAgent([
      { type: 'tool/result', data: { source: { kind: AGENT_TEAM_PLUGIN_ID }, content: [{ type: 'text', text: 'not a user message' }] } } as never,
      teamEvent(''),
    ])
    expect(visibleTeamTexts(agent)).toEqual([''])
  })

  it('reads newest first, so a later notice is examined before an older one', () => {
    const agent = fakeAgent([teamEvent('older'), teamEvent('newer')])
    expect(visibleTeamTexts(agent)).toEqual(['newer', 'older'])
  })
})

describe('the probe answers true only for a body the model saw in full', () => {
  it('matches a direct mention notice that carries the body verbatim', () => {
    const notice = ['Direct Team mention', 'From: reviewer', 'Message: please review this'].join('\n')
    expect(isFactOnSurface([notice], factOf('please review this'))).toBe(true)
  })

  it('matches a DM relay, which carries the body under its header', () => {
    const relay = 'Direct message from @peer at 12:00:\nWorkspace: workspace:alpha\n\nprivate note'
    expect(isFactOnSurface([relay], factOf('private note'))).toBe(true)
  })

  it('never matches an ordinary notice, which carries only a count', () => {
    // The rendering is "Thread X: 2 unread update(s) · newest at …" — not one
    // character of body, so no arrangement of facts can make it a hit. The
    // asserted body is the unread Message's own text, which the notice never
    // reproduces.
    const ordinary = 'Thread task:abc123: 2 unread updates · newest at 2026-10-14T00:00:00.000Z.'
    expect(isFactOnSurface([ordinary], factOf('please review this'))).toBe(false)
  })

  it('never matches a truncated notice, because the model never saw the whole body', () => {
    const truncated = `Message: please review this\n[Message body truncated; use team_thread read for the full Message.]`
    expect(isFactOnSurface([truncated], factOf('please review this'))).toBe(false)
  })

  it('does not let a truncated sibling disqualify an untruncated body in the same notice', () => {
    // The renderer truncates each body independently, so one notice can hold a
    // cut detail block beside an intact one. The marker must scope to the body
    // it cut: a cut sibling cannot un-exempt the body that was delivered whole.
    const cut = `Direct Team mention\nFrom: noisy\nMessage: ${'x'.repeat(9 * 1024)}\n[Message body truncated; use team_thread read for the full Message.]`
    const intact = 'Direct Team mention\nFrom: quiet\nMessage: short body that was never cut'
    const text = [cut, intact].join('\n\n')
    expect(isFactOnSurface([text], factOf('short body that was never cut'))).toBe(true)
    // And the cut body is still correctly refused, in that same text.
    expect(isFactOnSurface([text], factOf('x'.repeat(9 * 1024)))).toBe(false)
  })

  it('refuses a body whose only occurrence is the cut prefix of a longer body', () => {
    // The 8 KiB prefix is on the surface, but the marker says it was cut, so the
    // fact is not attested — even though the prefix itself contains the body.
    const long = 'y'.repeat(12 * 1024)
    const truncated = `Message: ${long.slice(0, 8 * 1024)}\n[Message body truncated; use team_thread read for the full Message.]`
    expect(isFactOnSurface([truncated], factOf(long))).toBe(false)
  })

  it('never matches a body that differs in any character', () => {
    const notice = 'Message: please review this'
    expect(isFactOnSurface([notice], factOf('please review this '))).toBe(false)
    expect(isFactOnSurface([notice], factOf('please review THIS'))).toBe(false)
    expect(isFactOnSurface([notice], factOf('review this please'))).toBe(false)
  })

  it('never matches an empty body, which no notice would attest', () => {
    expect(isFactOnSurface(['Message: '], factOf(''))).toBe(false)
  })

  it('never matches an activity fact, which carries no body to attest', () => {
    const activity = { fact: { kind: 'activity', sequence: 12, activity: { kind: 'claim-changed' }, occurredAt: '2026-10-14T00:00:00.000Z' }, unread: true, direct: false } as never
    expect(isFactOnSurface(['claim changed'], activity)).toBe(false)
  })

  it('matches only when the body is present, not when the surface is empty', () => {
    expect(isFactOnSurface([], factOf('please review this'))).toBe(false)
  })
})
