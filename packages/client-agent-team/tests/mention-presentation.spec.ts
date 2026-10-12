import { describe, expect, it } from 'vitest'
import { mentionSurfaceOf, mentionTierIsParticipant } from '../src/client/mention-presentation.ts'

describe('mention row weight', () => {
  it('reads the surface from the draft key the composer already writes to', () => {
    // One authority: the key's discriminant names the conversation, so the
    // row's weight cannot disagree with the draft it belongs to.
    expect(mentionSurfaceOf('thread:thread:one' as never)).toBe('thread')
    expect(mentionSurfaceOf('channel:channel:one' as never)).toBe('channel')
  })

  it('puts a Thread\'s followers inside it and every other tier outside', () => {
    expect(mentionTierIsParticipant(0, 'thread')).toBe(true)
    // A Channel peer takes part in the Channel, yet not in this Thread.
    expect(mentionTierIsParticipant(1, 'thread')).toBe(false)
    expect(mentionTierIsParticipant(2, 'thread')).toBe(false)
  })

  it('puts a Channel peer inside the Channel, because the Channel is the conversation', () => {
    // A Channel row never carries tier 0 — the Channel surface is handed no
    // follower set — so membership is what separates its two reachable tiers.
    expect(mentionTierIsParticipant(1, 'channel')).toBe(true)
    expect(mentionTierIsParticipant(2, 'channel')).toBe(false)
  })
})
