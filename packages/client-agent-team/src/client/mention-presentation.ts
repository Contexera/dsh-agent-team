import type { TeamDraftKey } from './drafts.ts'

export type MentionSurface = 'thread' | 'channel'

/**
 * How directly a mention reaches a Member, in delivery order: a follower's pick
 * delivers at once, a Channel peer is pulled in by the Host, and the rest of
 * the Workspace may need the Human's confirmation. Ranking subtracts these, so
 * the numbers are an order rather than labels; every consumer names one.
 */
export const MENTION_TIER = { follower: 0, peer: 1, other: 2 } as const

export type MentionTier = typeof MENTION_TIER[keyof typeof MENTION_TIER]

/**
 * The surface a composer is on, read from the draft key it already writes to:
 * that key's discriminant names the conversation the draft belongs to, so a
 * second prop could only restate — or contradict — it.
 */
export function mentionSurfaceOf(draftKey: TeamDraftKey): MentionSurface {
  return draftKey.startsWith('thread:') ? 'thread' : 'channel'
}

/**
 * Whether a tier already takes part in the conversation being written into.
 * A Thread's own followers are in it. A Channel send counts every Member
 * taking part in that Channel through any of its Threads, because the Channel
 * is the conversation there.
 */
export function mentionTierIsParticipant(tier: MentionTier, surface: MentionSurface): boolean {
  return surface === 'thread' ? tier === MENTION_TIER.follower : tier !== MENTION_TIER.other
}
