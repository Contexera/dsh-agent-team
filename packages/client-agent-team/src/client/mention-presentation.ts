import type { TeamDraftKey, TeamDraftKind } from './drafts.ts'
import { draftKindOf } from './drafts.ts'
import type { MentionTier } from './TeamComposer.tsx'

export type MentionSurface = TeamDraftKind

/**
 * The surface a composer is on, read from the draft key it already writes to:
 * that key's discriminant names the conversation the draft belongs to, so a
 * second prop could only restate — or contradict — it.
 */
export function mentionSurfaceOf(draftKey: TeamDraftKey): MentionSurface {
  return draftKindOf(draftKey)
}

/**
 * Whether a tier already takes part in the conversation being written into.
 * A Thread's own followers are in it. A Channel send counts every Member
 * taking part in that Channel through any of its Threads, because the Channel
 * is the conversation there.
 */
export function mentionTierIsParticipant(tier: MentionTier, surface: MentionSurface): boolean {
  return surface === 'thread' ? tier === 'thread-follower' : tier !== 'workspace'
}
