import { vi } from 'vitest'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { AgentTeamChangesRequest } from '@contexera/dsh-agent-team/types'

/** One Main stream entry as the Host projects it; the harness fills the flags a spec does not care about. */
export type MainStreamSeedEntry = {
  readonly kind: 'message' | 'activity' | 'thread-card' | 'subscription-event'
  readonly sequence: number
  readonly occurredAt: string
  readonly unread?: boolean
} & Record<string, unknown>

export function createInboxAndStreamDouble(options?: {
  readonly initialEntries?: readonly MainStreamSeedEntry[] | undefined
  readonly mainStreamUnread?: number | undefined
}) {
  let mainEntries: MainStreamSeedEntry[] = [...(options?.initialEntries ?? [])]
  let mainUnread = options?.mainStreamUnread ?? 0
  let mainUnreadRequiredOnce = false

  let inboxRows: Array<{ readonly workspaceId: string; readonly item: Record<string, unknown> }> = []
  let inboxHasMore = false
  let mainInboxRows: Array<Record<string, unknown> & { readonly workspaceId: string }> = []

  let changeVersion = 0
  let changeFailure: string | undefined
  const generationListeners = new Set<() => void>()
  const changeWaiters = new Set<{ request: AgentTeamChangesRequest; wake(): void }>()
  const changeWaiterRegistrations = new Set<() => void>()
  let changeRegistrations = 0
  let changeOpens = 0

  const changeSubscriptionsReady = async (): Promise<void> => {
    while (changeOpens > changeRegistrations) {
      await new Promise<void>(resolve => {
        changeWaiterRegistrations.add(resolve)
      })
    }
    await Promise.resolve()
  }

  const wakeAll = (): void => {
    changeVersion += 1
    for (const waiter of changeWaiters) waiter.wake()
  }

  const publishPresence = (): void => {
    changeVersion += 1
    for (const waiter of changeWaiters) if (waiter.request.scope?.kind === 'presence') waiter.wake()
  }

  const publishWorkspaceUpdate = (): void => {
    changeVersion += 1
    for (const waiter of changeWaiters) if (waiter.request.scope === undefined || waiter.request.scope.kind === 'workspace') waiter.wake()
  }

  const publishGlobalUpdate = (): void => {
    changeVersion += 1
    for (const waiter of changeWaiters) if (waiter.request.scope === undefined) waiter.wake()
  }

  const publishProjectUpdate = (): void => { wakeAll() }

  const connection = {
    generation: {
      getSnapshot: () => changeFailure === undefined ? {} as never : undefined,
      subscribe: (listener: () => void) => { generationListeners.add(listener); return () => { generationListeners.delete(listener) } },
    },
  }

  const changesStream = async function* (request: AgentTeamChangesRequest, signal?: AbortSignal) {
    let pending = false
    let resume: (() => void) | undefined
    const waiter = { request, wake: () => { pending = true; resume?.() } }
    const abort = () => resume?.()
    changeWaiters.add(waiter)
    changeRegistrations += 1
    for (const resolve of changeWaiterRegistrations) resolve()
    changeWaiterRegistrations.clear()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (changeFailure !== undefined) throw new RemoteStreamCarrierError(changeFailure)
      yield { version: changeVersion }
      while (!signal?.aborted) {
        if (!pending) await new Promise<void>(resolve => { resume = resolve })
        resume = undefined
        if (signal?.aborted) return
        if (changeFailure !== undefined) throw new RemoteStreamCarrierError(changeFailure)
        pending = false
        yield { version: changeVersion }
      }
    } finally {
      changeWaiters.delete(waiter)
      signal?.removeEventListener('abort', abort)
    }
  }

  const changes = vi.fn((request: AgentTeamChangesRequest, signal?: AbortSignal) => {
    changeOpens += 1
    return changesStream(request, signal)
  })

  const failChanges = (message = 'transport down'): void => { changeFailure = message; wakeAll() }
  const recoverChanges = (): void => {
    changeFailure = undefined
    for (const listener of generationListeners) listener()
  }

  const threadHoldsUnread = (threadRef: string): boolean =>
    inboxRows.some(row => ((row.item as { thread?: { threadRef?: string }; unreadCount?: number }).thread?.threadRef === threadRef) && ((row.item as { unreadCount?: number }).unreadCount ?? 0) > 0)

  const mainStanding = () => ({ owner: true, head: mainEntries.at(-1)?.sequence ?? 0, unreadCount: mainUnread, directCount: 0, markers: [] })

  const mainStreamHistory = vi.fn(async (request: { beforeSequence?: number; limit?: number }) => {
    const older = mainEntries.filter(entry => request.beforeSequence === undefined || entry.sequence < request.beforeSequence)
    const page = older.slice(-(request.limit ?? 20))
    return {
      ok: true as const,
      value: {
        projectRef: 'project:engineering',
        entries: page.map(entry => ({
          direct: false,
          unread: entry.kind === 'thread-card' && threadHoldsUnread((entry.card as { threadRef: string }).threadRef),
          ...entry,
        })),
        cursor: page[0]?.sequence ?? 1,
        hasMore: older.length > page.length,
        standing: mainStanding(),
      },
    }
  })

  const readMainStream = vi.fn(async () => {
    mainUnread = 0
    mainInboxRows = mainInboxRows.filter(row => row.projectRef !== 'project:engineering')
    return {
      ok: true as const,
      value: {
        projectRef: 'project:engineering',
        readThroughSequence: mainEntries.at(-1)?.sequence ?? 0,
        entries: [],
        consumedMarkers: [],
        standing: mainStanding(),
      },
    }
  })

  const requireMainRead = (): void => { mainUnreadRequiredOnce = true }

  const appendMainMessage = (body: string, replyToMessageRef?: string, attachmentIds: readonly string[] = []) => {
    const sequence = (mainEntries.at(-1)?.sequence ?? 0) + 1
    const attachments = attachmentIds.map(id => ({ attachmentId: id, name: `file-${id}.png`, byteSize: 8, mediaType: 'image/png' }))
    const message = {
      messageRef: `message:main-${sequence}`,
      projectRef: 'project:engineering',
      scope: 'main',
      sender: 'member:human',
      body,
      ...(replyToMessageRef === undefined ? {} : { replyToMessageRef }),
      ...(attachments.length === 0 ? {} : { attachments }),
      sequence,
      occurredAt: '2026-10-20T10:00:00.000Z',
    }
    mainEntries = [...mainEntries, { kind: 'message', sequence, occurredAt: message.occurredAt, message, mentions: [] }]
    return message
  }

  const postMainMessage = vi.fn(async (request: { requestId: string; body: string; replyToMessageRef?: string; attachments?: readonly string[] }) => {
    if (mainUnreadRequiredOnce) {
      mainUnreadRequiredOnce = false
      mainUnread = 1
      return {
        ok: true as const,
        value: {
          kind: 'main_unread_required' as const,
          projectRef: 'project:engineering',
          unreadCount: 1,
          directCount: 0,
          head: mainEntries.at(-1)?.sequence ?? 0,
          entries: [],
        },
      }
    }
    return {
      ok: true as const,
      value: {
        kind: 'committed' as const,
        receipt: {},
        message: appendMainMessage(request.body, request.replyToMessageRef, request.attachments),
        markers: [],
      },
    }
  })

  const inbox = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
    const scoped = inboxRows.filter(row => row.workspaceId === workspaceId)
    const holdsUnread = (row: { readonly item: Record<string, unknown> }): boolean => ((row.item as { unreadCount?: number }).unreadCount ?? 0) > 0
    const items = scoped.filter(holdsUnread).map(row => row.item)
    const recent = scoped.filter(row => !holdsUnread(row)).map(row => row.item)
    const main = mainInboxRows.filter(row => row.workspaceId === workspaceId)
    const unread = [...items, ...main].reduce((sum, item) => sum + ((item as { unreadCount?: number }).unreadCount ?? 0), 0)
    const direct = [...items, ...main].reduce((sum, item) => sum + ((item as { directCount?: number }).directCount ?? 0), 0)
    return {
      ok: true as const,
      value: { humanMemberId: 'member:human', items, main, recent, hasMore: inboxHasMore, totalUnreadCount: unread, totalDirectCount: direct },
    }
  })

  const seedInbox = (rows: ReadonlyArray<{ readonly workspaceId: string } & Record<string, unknown>>, opts?: { readonly hasMore?: boolean }): void => {
    inboxRows = rows.map(row => ({ workspaceId: row.workspaceId, item: row as Record<string, unknown> }))
    inboxHasMore = opts?.hasMore ?? false
    wakeAll()
  }

  const seedMainInbox = (rows: ReadonlyArray<Record<string, unknown> & { readonly workspaceId: string }>): void => {
    mainInboxRows = [...rows]
    wakeAll()
  }

  return {
    connection,
    changes,
    changeSubscriptionsReady,
    wakeAll,
    publishPresence,
    publishWorkspaceUpdate,
    publishGlobalUpdate,
    publishProjectUpdate,
    failChanges,
    recoverChanges,
    mainStreamHistory,
    readMainStream,
    postMainMessage,
    requireMainRead,
    inbox,
    seedInbox,
    seedMainInbox,
    getMainEntries: () => mainEntries,
    setMainEntries: (next: MainStreamSeedEntry[]) => { mainEntries = next },
    clearInboxForThread: (threadRef: string | undefined) => {
      inboxRows = inboxRows.filter(row => ((row.item as { thread?: { threadRef?: string } }).thread?.threadRef) !== threadRef)
    },
  }
}
