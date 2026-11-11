/** Public domain types for the Agent Team Host: ./types/entities.ts (ids, actors, entities), ./types/operations.ts (ledger operation records), ./types/requests-results.ts (receipts, requests, results, views). */
import type { AgentTeamAttachmentId } from './types/entities.ts'

export type * from "./types/entities.ts"
export type * from "./types/operations.ts"
export type * from "./types/requests-results.ts"

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Read of a cached attachment whose entire entry is absent (expired or collected): the Client shows expiry for this mount and may reread it later. */
    'team/attachment-not-found': { readonly attachmentId: AgentTeamAttachmentId }
    /** A Human-profile write read an older settings revision than the Host now holds. */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /** The settings provider refused a Human-profile write before committing it. */
    'settings/rejected': { readonly ns: string }
    /** A Human-profile write did not settle at the revision it read; the Client must re-read before another write. */
    'team/human-profile-write-uncertain': { readonly expectedFence: string }
  }
}
