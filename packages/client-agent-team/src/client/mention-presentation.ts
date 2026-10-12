import type { TeamDraftKey } from './drafts.ts'
import type { MentionTier } from './TeamComposer.tsx'

/**
 * Which surface the composer is writing into. A tier means something different
 * on each — tier 1 takes part in the Channel conversation yet not in a given
 * Thread's — so the weight cannot be derived from the tier alone.
 */
export type MentionSurface = 'thread' | 'channel'

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
  return surface === 'thread' ? tier === 0 : tier !== 2
}
