/**
 * Private pointer for the Team manager's current Session. This is metadata
 * outside the append-only Team ledger: it records which Session the manager
 * entry currently resolves to, never a Team fact.
 * @module @contexera/dsh-agent-team/manager-session-store
 */

import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** The one row in the manager pointer table. */
export const MANAGER_SESSION_POINTER_KEY = 'current' as const

/** Durable manager destination. `workspaceId` is metadata for restoration and display, not a second existence authority. */
export interface ManagerSessionPointer {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  /** Earlier generations stay Team-owned history, never ordinary reusable blanks. */
  readonly previousSessionIds?: readonly SessionId[]
}

const pointerSchema = z.object({
  sessionId: z.string().min(1).transform(value => value as SessionId),
  workspaceId: z.string().min(1).transform(value => value as WorkspaceId),
  previousSessionIds: z.array(z.string().min(1).transform(value => value as SessionId)).readonly().optional(),
}).strict().transform((value): ManagerSessionPointer => Object.freeze({
  sessionId: value.sessionId,
  workspaceId: value.workspaceId,
  ...value.previousSessionIds === undefined ? {} : { previousSessionIds: value.previousSessionIds },
}))

/** The manager's private storage domain, separate from the Team operation ledger. */
export const managerSessionDomainSpec = defineDomain({
  name: 'agent_team_manager',
  version: 1,
  tables: {
    pointer: domainTable<typeof MANAGER_SESSION_POINTER_KEY, ManagerSessionPointer>(pointerSchema),
  },
})

/** Test-facing storage seam: production uses the DomainFacility table, tests can inject their own implementation. */
export interface ManagerSessionStoreLike {
  read(): ManagerSessionPointer | undefined
  ownedSessionIds(): readonly SessionId[]
  writeIfExpected(expectedSessionId: SessionId | undefined, pointer: ManagerSessionPointer): Promise<boolean>
}

/** One typed singleton pointer over the private domain table. */
export class ManagerSessionStore implements ManagerSessionStoreLike {
  constructor(
    private readonly table: KvTable<typeof MANAGER_SESSION_POINTER_KEY, ManagerSessionPointer>,
  ) {}

  read(): ManagerSessionPointer | undefined {
    return this.table.get(MANAGER_SESSION_POINTER_KEY)
  }

  ownedSessionIds(): readonly SessionId[] {
    const pointer = this.read()
    return pointer === undefined ? [] : [...pointer.previousSessionIds ?? [], pointer.sessionId]
  }

  /**
   * Persist only while the caller's observed Session is still current. The
   * runtime's global chain supplies all in-process serialization; a second
   * writer to this home would need that same lock, not just a domain write.
   */
  async writeIfExpected(
    expectedSessionId: SessionId | undefined,
    pointer: ManagerSessionPointer,
  ): Promise<boolean> {
    const current = this.read()
    if (current?.sessionId !== expectedSessionId) return false
    await this.table.put(MANAGER_SESSION_POINTER_KEY, Object.freeze({ ...pointer }))
    return true
  }
}
