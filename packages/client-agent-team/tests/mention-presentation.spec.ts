import { describe, expect, it } from 'vitest'
import { MENTION_TIER, mentionSurfaceOf, mentionTierIsParticipant } from '../src/client/mention-presentation.ts'

describe('mention row weight', () => {
  it('reads the surface from the draft key the composer already writes to', () => {
    expect(mentionSurfaceOf('thread:thread:one' as never)).toBe('thread')
    expect(mentionSurfaceOf('channel:channel:one' as never)).toBe('channel')
  })

  it('puts a Thread\'s followers inside it and every other tier outside', () => {
    expect(mentionTierIsParticipant(MENTION_TIER.follower, 'thread')).toBe(true)
    // A Channel peer takes part in the Channel, yet not in this Thread.
    expect(mentionTierIsParticipant(MENTION_TIER.peer, 'thread')).toBe(false)
    expect(mentionTierIsParticipant(MENTION_TIER.other, 'thread')).toBe(false)
  })

  it('puts a Channel peer inside the Channel, because the Channel is the conversation', () => {
    // A Channel row never carries the follower tier — the Channel surface is
    // handed no follower set — so membership is what separates its two
    // reachable tiers.
    expect(mentionTierIsParticipant(MENTION_TIER.peer, 'channel')).toBe(true)
    expect(mentionTierIsParticipant(MENTION_TIER.other, 'channel')).toBe(false)
  })
})
