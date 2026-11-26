import type { AgentTeamOperationId, AgentTeamRequestId } from "./entities.ts"

/** Receipt returned after an operation is durable or an identical retry resolves it. */
export interface AgentTeamOperationReceipt {
  readonly operationId: AgentTeamOperationId
  readonly requestId: AgentTeamRequestId
  readonly sequence: number
  /** Wall-clock instant of the committing operation; the one source results carry for optimistic fact instants. */
  readonly occurredAt: string
}
