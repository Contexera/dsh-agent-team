import type { TeamDraftKey, TeamDraftKind } from './drafts.ts'
import { draftKindOf } from './drafts.ts'
import type { MentionTier } from './TeamComposer.tsx'

export type MentionSurface = TeamDraftKind

/** Read from the draft key the composer already writes to, so a second prop could only restate or contradict it. */
export function mentionSurfaceOf(draftKey: TeamDraftKey): MentionSurface {
  return draftKindOf(draftKey)
}

/** A Thread's own followers are in it; a Channel send counts every Member taking part in that Channel through any Thread. */
export function mentionTierIsParticipant(tier: MentionTier, surface: MentionSurface): boolean {
  return surface === 'thread' ? tier === 'thread-follower' : tier !== 'workspace'
}
