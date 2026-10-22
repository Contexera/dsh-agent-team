/** Public domain types for the Agent Team Host: ./types/entities.ts (ids, actors, entities), ./types/operations.ts (ledger operation records), ./types/requests-results.ts (receipts, requests, results, views). */
import type { AgentTeamAttachmentId } from './types/entities.ts'

export type * from "./types/entities.ts"
export type * from "./types/operations.ts"
export type * from "./types/requests-results.ts"

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Read of a cached attachment whose entry is gone (expired or collected): the Client settles on the expired chip instead of retrying. */
    'team/attachment-not-found': { readonly attachmentId: AgentTeamAttachmentId }
  }
}
