import { vi } from 'vitest'
import type {
  AgentTeamReplyRequest,
  AgentTeamTask,
  AgentTeamWorkerStateView,
} from '@contexera/dsh-agent-team/types'
import type { MainStreamSeedEntry } from './inbox-and-stream.ts'

export interface SeededMessage {
  readonly body: string
  readonly occurredAt: string
  readonly sender?: 'human' | 'agent'
  readonly mentions?: readonly string[]
}

export function buildInitialSeedState(options?: {
  readonly seedTaskRef?: string
  readonly seedThreadRef?: string
  readonly seedTaskless?: boolean
  readonly seedsAsMainMessages?: boolean
  readonly seedTaskStatus?: AgentTeamTask['status']
  readonly seededMessages?: readonly SeededMessage[]
  readonly mainStreamEntries?: readonly MainStreamSeedEntry[]
}) {
  const seedTaskRef = options?.seedTaskRef ?? 'task:1'
  const seedThreadRef = options?.seedThreadRef ?? 'thread:1'
  const taskless = options?.seedTaskless === true

  const viewItems: Array<Record<string, unknown>> = (options?.seededMessages ?? []).map((seed, index) => ({
    message: {
      messageRef: `message:seed-${index}`,
      projectRef: 'project:engineering',
      threadRef: seedThreadRef,
      ...(taskless ? {} : { taskRef: seedTaskRef }),
      sender: seed.sender === 'agent' ? 'member:builder' : 'member:human',
      body: seed.body,
      topLevel: true,
      sequence: index + 1,
      occurredAt: seed.occurredAt,
    },
    mentions: seed.mentions ?? [],
    ...(taskless ? {} : {
      task: {
        taskRef: seedTaskRef,
        projectRef: 'project:engineering',
        threadRef: seedThreadRef,
        status: options?.seedTaskStatus ?? 'todo',
        resolution: 'open',
        accountable: 'member:human',
        sourceThreadRefs: [],
      },
      taskNumber: 1,
    }),
    thread: { threadRef: seedThreadRef, ...(taskless ? {} : { taskRef: seedTaskRef }), revision: 2 },
    liveClaimOwners: [],
    reminders: [],
    messageCount: 1,
    lastActivityAt: seed.occurredAt,
  }))

  const seededCards: MainStreamSeedEntry[] = viewItems.map(item => {
    const message = item.message as { messageRef: string; sender: string; body: string; sequence: number; occurredAt: string }
    return {
      kind: 'thread-card',
      sequence: message.sequence,
      occurredAt: message.occurredAt,
      card: {
        threadRef: seedThreadRef,
        anchor: { messageRef: message.messageRef, sender: message.sender, preview: message.body, sequence: message.sequence, occurredAt: message.occurredAt },
        ...(taskless ? {} : { task: { taskRef: seedTaskRef, taskNumber: 1, status: options?.seedTaskStatus ?? 'todo', resolution: 'open', accountable: 'member:human', liveClaimOwners: [] } }),
        replyCount: 0,
        participants: [],
        newestSequence: message.sequence,
        newestOccurredAt: message.occurredAt,
        newestActor: { memberId: message.sender, name: message.sender === 'member:builder' ? 'builder' : 'human' },
      },
    }
  })

  const seededMessageEntries: MainStreamSeedEntry[] = (options?.seededMessages ?? []).map((seed, index) => ({
    kind: 'message',
    sequence: index + 1,
    occurredAt: seed.occurredAt,
    message: {
      messageRef: `message:main-seed-${index}`,
      projectRef: 'project:engineering',
      scope: 'main',
      sender: seed.sender === 'agent' ? 'member:builder' : 'member:human',
      body: seed.body,
      sequence: index + 1,
      occurredAt: seed.occurredAt,
    },
    mentions: seed.mentions ?? [],
  }))

  const initialMainEntries = [...(options?.mainStreamEntries ?? (options?.seedsAsMainMessages === true ? seededMessageEntries : seededCards))]
  return { viewItems, initialMainEntries }
}

export function createThreadsAndTasksDouble(deps: {
  initialViewItems: Array<Record<string, unknown>>
  seededWorkerActivities?: readonly Record<string, unknown>[] | undefined
  seededWorkerStates?: readonly AgentTeamWorkerStateView[] | undefined
  remainingUnreadCounts?: readonly number[] | undefined
  seedFollowers?: readonly string[] | undefined
  getProjects: () => Array<Record<string, unknown>>
  getMemberships: () => Array<Record<string, unknown>>
  getOwners: () => Array<{ projectRef: string; memberId: string }>
  getMainEntries: () => MainStreamSeedEntry[]
  setMainEntries: (next: MainStreamSeedEntry[]) => void
  clearInboxForThread: (threadRef: string | undefined) => void
  wakeAll: () => void
}) {
  let viewItems = [...deps.initialViewItems]
  const viewClaims: Array<Record<string, unknown>> = []
  let viewActivities: Array<Record<string, unknown>> = [...(deps.seededWorkerActivities ?? [])]

  const viewProjects = vi.fn(async (request: { threadRef?: string; topLevelOnly?: boolean }) => ({
    ok: true,
    value: {
      humanMemberId: 'member:human',
      projects: deps.getProjects(),
      members: deps.getMemberships(),
      owners: deps.getOwners(),
      rulesVersion: 2,
      tasks: viewItems.flatMap(item => item.task === undefined ? [] : [item.task]),
      threads: viewItems.length === 0 ? [] : [viewItems[0]!.thread],
      taskNumbers: viewItems.flatMap(item => item.task === undefined || item.taskNumber === undefined ? [] : [{ taskRef: (item.task as { taskRef: string }).taskRef, taskNumber: item.taskNumber }]),
      items: request.threadRef !== undefined || !request.topLevelOnly ? viewItems : viewItems.filter(item => (item.message as { topLevel?: boolean }).topLevel),
      claims: viewClaims,
      activities: request.topLevelOnly ? [] : viewActivities,
      cursor: 0,
      hasMore: false,
    },
  }))

  let startedThreadCount = 0
  const startThread = vi.fn(async (request: { requestId: string; kind: 'discussion' | 'task'; body: string; projectRef: string; attachments?: readonly string[] }) => {
    startedThreadCount += 1
    const mainEntries = deps.getMainEntries()
    const sequence = (mainEntries.at(-1)?.sequence ?? 0) + 1
    const asTask = request.kind === 'task'
    const attachments = (request.attachments ?? []).map(id => ({ attachmentId: id, name: `file-${id}.png`, byteSize: 8, mediaType: 'image/png' }))
    const message = {
      messageRef: `message:${1 + startedThreadCount}`,
      projectRef: request.projectRef,
      threadRef: 'thread:1',
      ...(asTask ? { taskRef: 'task:1' } : {}),
      sender: 'member:human',
      body: request.body,
      ...(attachments.length === 0 ? {} : { attachments }),
      topLevel: true,
      sequence,
      occurredAt: '2026-08-21T10:00:00.000Z',
    }
    const task = asTask ? { taskRef: 'task:1', projectRef: request.projectRef, threadRef: 'thread:1', status: 'todo', resolution: 'open', accountable: 'member:human' } : undefined
    const thread = { threadRef: 'thread:1', ...(asTask ? { taskRef: 'task:1' } : {}), revision: sequence }
    viewItems = [{ message, mentions: [], ...(task === undefined ? {} : { task, taskNumber: 1 }), thread, liveClaimOwners: [], messageCount: 1, lastActivityAt: message.occurredAt }]
    const card = {
      threadRef: 'thread:1',
      anchor: { messageRef: message.messageRef, sender: 'member:human', preview: request.body, sequence, occurredAt: message.occurredAt },
      ...(task === undefined ? {} : { task: { taskRef: 'task:1', taskNumber: 1, status: 'todo', resolution: 'open', accountable: 'member:human', liveClaimOwners: [] } }),
      replyCount: 0,
      participants: [],
      newestSequence: sequence,
      newestOccurredAt: message.occurredAt,
      newestActor: { memberId: 'member:human', name: 'human' },
    }
    deps.setMainEntries([...mainEntries, { kind: 'thread-card', sequence, occurredAt: message.occurredAt, card }])
    return { ok: true as const, value: { kind: 'committed' as const, receipt: {}, message, ...(task === undefined ? {} : { task }), thread, attention: [], directMarkers: [] } }
  })

  const reply = vi.fn(async (request: AgentTeamReplyRequest) => {
    const top = viewItems[0]!
    const message = { ...(top.message as object), messageRef: 'message:human-reply', sender: 'member:human', body: request.body, topLevel: false, sequence: request.baseRevision + 1 }
    const thread = { ...(top.thread as object), revision: request.baseRevision + 1 }
    viewItems = [{ ...top, thread, mentions: [], messageCount: 2 }, { ...top, message, thread, mentions: [], messageCount: 2 }]
    return { ok: true as const, value: { kind: 'committed', receipt: {}, message, task: top.task, thread, attention: [], directMarkers: [] } }
  })

  const promoteThread = vi.fn(async (request: { requestId: string; workspaceId: string; threadRef: string; baseRevision: number }) => {
    const top = viewItems.find(item => (item.thread as { threadRef: string }).threadRef === request.threadRef) ?? viewItems[0]
    if (top === undefined) return { ok: false as const, error: { message: 'thread missing' } }
    const task = { taskRef: 'task:1', projectRef: 'project:engineering', threadRef: request.threadRef, status: 'todo', resolution: 'open', accountable: 'member:human' }
    const thread = { ...(top.thread as object), taskRef: task.taskRef, revision: request.baseRevision + 1 }
    const activity = { activityRef: 'activity:promoted', kind: 'promote' as const, taskRef: task.taskRef, threadRef: request.threadRef, actor: 'member:human', sequence: request.baseRevision + 1 }
    viewItems = viewItems.map(item => ({ ...item, task, thread, taskNumber: 1, liveClaimOwners: [] }))
    deps.setMainEntries(deps.getMainEntries().map(entry =>
      entry.kind === 'thread-card' && (entry.card as { threadRef: string }).threadRef === request.threadRef
        ? { ...entry, card: { ...(entry.card as object), task: { taskRef: task.taskRef, taskNumber: 1, status: 'todo', resolution: 'open', accountable: task.accountable, liveClaimOwners: [] } } }
        : entry))
    deps.wakeAll()
    return { ok: true as const, value: { kind: 'committed' as const, receipt: {}, activity, task, thread } }
  })

  const threadFollowers = [...(deps.seedFollowers ?? ['member:human'])]
  let attentionFailure: string | undefined
  const failAttention = (message?: string): void => { attentionFailure = message }
  const attentionByRequest = new Map<string, { readonly receipt: {}; readonly thread: { revision: number }; readonly attention?: unknown }>()

  const changeAttention = vi.fn(async (request: { requestId: string; workspaceId: string; threadRef?: string; taskRef?: string; action: 'follow' | 'unfollow' }) => {
    if (attentionFailure !== undefined) return { ok: false as const, error: { message: attentionFailure } }
    const replayed = attentionByRequest.get(request.requestId)
    if (replayed !== undefined) return { ok: true as const, value: replayed }
    const followed = threadFollowers.includes('member:human')
    if (request.action === 'follow' && !followed) threadFollowers.push('member:human')
    if (request.action === 'unfollow' && followed) threadFollowers.splice(0, threadFollowers.length, ...threadFollowers.filter(id => id !== 'member:human'))
    const topThread = viewItems[0]?.thread as { revision?: number } | undefined
    const thread = { ...(topThread as object), revision: topThread?.revision ?? 0 }
    deps.wakeAll()
    const committed = {
      receipt: {},
      thread,
      ...(request.action === 'follow' ? { attention: { threadRef: request.threadRef, taskRef: request.taskRef, memberId: 'member:human', action: 'follow' } } : {}),
    }
    attentionByRequest.set(request.requestId, committed)
    return { ok: true as const, value: committed }
  })

  let transferOutcome: 'committed' | 'unread_required' | 'stale_revision' | 'failure' = 'committed'
  const seedTransferOutcome = (next: typeof transferOutcome): void => { transferOutcome = next }
  const transferTask = vi.fn(async (request: { requestId: string; workspaceId: string; taskRef: string; target: string; baseRevision: number }) => {
    if (transferOutcome === 'failure') return { ok: false as const, error: { message: 'transfer unavailable (spec)' } }
    if (transferOutcome === 'unread_required') return { ok: true as const, value: { kind: 'unread_required' as const, unreadCount: 2 } }
    if (transferOutcome === 'stale_revision') return { ok: true as const, value: { kind: 'stale_revision' as const } }
    const top = viewItems.find(item => (item.task as { taskRef?: string } | undefined)?.taskRef === request.taskRef) ?? viewItems[0]
    if (top === undefined) return { ok: false as const, error: { message: 'task missing' } }
    const task = { ...(top.task as object), accountable: request.target }
    const thread = { ...(top.thread as object), revision: request.baseRevision + 1 }
    viewItems = viewItems.map(item => ({ ...item, task, thread }))
    const activity = { activityRef: 'activity:transfer', kind: 'transfer' as const, taskRef: request.taskRef, threadRef: (top.thread as { threadRef: string }).threadRef, actor: 'member:human', from: 'member:human', to: request.target, sequence: request.baseRevision + 1 }
    viewActivities = [...viewActivities, activity]
    deps.wakeAll()
    return { ok: true as const, value: { kind: 'committed' as const, receipt: {}, activity, task, thread } }
  })

  const changeTask = vi.fn(async (request: { action: 'accept' | 'close' | 'reopen' }) => {
    const top = viewItems[0]!
    const task = {
      ...(top.task as object),
      status: request.action === 'reopen' ? 'todo' : request.action === 'accept' ? 'done' : 'closed',
      resolution: request.action === 'reopen' ? 'open' : request.action === 'accept' ? 'accepted' : 'closed',
    }
    const thread = { ...(top.thread as object), revision: (top.thread as { revision: number }).revision + 1 }
    viewItems = viewItems.map(item => ({ ...item, task, thread, liveClaimOwners: [] }))
    return { ok: true as const, value: { kind: 'committed', receipt: {}, activity: { activityRef: `activity:${request.action}`, taskRef: 'task:1', threadRef: 'thread:1', actor: 'member:human', kind: request.action, sequence: (thread.revision as number) + 10 }, task, thread, claims: viewClaims } }
  })

  const remainingUnreadCounts = [...(deps.remainingUnreadCounts ?? [])]
  const readThread = vi.fn(async ({ requestId, taskRef, threadRef }: { requestId?: string; taskRef?: string; threadRef?: string }) => {
    void requestId
    const top = viewItems.find(item => (threadRef !== undefined && (item.thread as { threadRef: string }).threadRef === threadRef)
      || (taskRef !== undefined && (item.task as { taskRef?: string } | undefined)?.taskRef === taskRef)) ?? viewItems[0]
    if (top === undefined) return { ok: false as const, error: { message: 'thread missing' } }
    const remainingUnreadCount = remainingUnreadCounts.length > 0 ? remainingUnreadCounts.shift()! : 0
    deps.clearInboxForThread((top.thread as { threadRef?: string }).threadRef)
    return {
      ok: true as const,
      value: {
        receipt: {},
        task: top.task,
        thread: top.thread,
        claims: viewClaims,
        anchor: top.message,
        anchorMentions: [],
        facts: [
          ...viewItems.map(item => ({ fact: { kind: 'message' as const, sequence: (item.message as { sequence: number }).sequence, message: item.message, mentions: (item as { mentions?: string[] }).mentions ?? [] }, unread: false, direct: false })),
          ...viewActivities.map(activity => ({ fact: { kind: 'activity' as const, sequence: activity.sequence as number, activity }, unread: false, direct: false })),
        ],
        readThroughSequence: (top.thread as { revision: number }).revision,
        remainingUnreadCount,
        consumedDirectMarkers: [],
        reminders: [],
        ...(deps.seededWorkerStates === undefined ? {} : { workerStates: deps.seededWorkerStates }),
      },
    }
  })

  let threadHistoryFailure: string | undefined
  let taskBoardFailure: string | undefined
  const failThreadHistory = (message?: string): void => { threadHistoryFailure = message }
  const failTaskBoard = (message?: string): void => { taskBoardFailure = message }

  const loadThreadHistory = vi.fn(async ({ taskRef, threadRef }: { taskRef?: string; threadRef?: string }) => {
    const top = viewItems.find(item => (threadRef !== undefined && (item.thread as { threadRef: string }).threadRef === threadRef)
      || (taskRef !== undefined && (item.task as { taskRef?: string } | undefined)?.taskRef === taskRef)) ?? viewItems[0]
    if (threadHistoryFailure !== undefined) return { ok: false as const, error: { message: threadHistoryFailure } }
    if (top === undefined) return { ok: false as const, error: { message: 'thread missing' } }
    return {
      ok: true as const,
      value: {
        task: top.task,
        thread: top.thread,
        anchor: top.message,
        anchorMentions: [],
        claims: viewClaims,
        facts: [],
        cursor: 0,
        hasMore: false,
        ...(deps.seededWorkerStates === undefined ? {} : { workerStates: deps.seededWorkerStates }),
      },
    }
  })

  const threadObservations = vi.fn(async ({ taskRef, threadRef }: { taskRef?: string; threadRef?: string }) => {
    void taskRef
    void threadRef
    return { ok: true as const, value: { items: [], followers: threadFollowers } }
  })

  const resolveTaskRefs = vi.fn(async (request: { workspaceId: string; taskRefs: readonly string[] }) => {
    const numbers = new Map(viewItems.flatMap((item, index) => {
      const taskRef = (item.task as { taskRef?: string } | undefined)?.taskRef
      return taskRef === undefined ? [] : [[taskRef, index + 1] as const]
    }))
    const known = new Map(viewItems.flatMap(item => {
      const taskRef = (item.task as { taskRef?: string } | undefined)?.taskRef
      return taskRef === undefined ? [] : [[taskRef, item] as const]
    }))
    known.set('task:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6c', {
      task: { taskRef: 'task:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6c', projectRef: 'project:engineering', threadRef: 'thread:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6d', status: 'todo', resolution: 'open', accountable: 'member:human' },
    })
    const resolved = request.taskRefs.flatMap(taskRef => {
      const item = known.get(taskRef) ?? [...known.values()].find(candidate => {
        const candidateRef = (candidate.task as { taskRef?: string } | undefined)?.taskRef
        return candidateRef !== undefined && candidateRef.startsWith(taskRef)
      })
      if (item === undefined) return []
      const task = item.task as { taskRef: string; projectRef: string; threadRef: string }
      return [{ taskRef: task.taskRef, projectRef: task.projectRef, threadRef: task.threadRef, taskNumber: numbers.get(task.taskRef) ?? 2 }]
    })
    return { ok: true as const, value: { resolved } }
  })

  const resolveThreadRefs = vi.fn(async (request: { workspaceId: string; threadRefs: readonly string[] }) => {
    interface Resolved { threadRef: string; projectRef: string; title: string; taskRef?: string; taskNumber?: number }
    const known = new Map<string, Resolved>(viewItems.map(item => {
      const thread = item.thread as { threadRef: string }
      return [thread.threadRef, { threadRef: thread.threadRef, projectRef: 'project:engineering', title: '已加载的讨论' }]
    }))
    known.set('thread:c0a1b2c3', { threadRef: 'thread:c0a1b2c3', projectRef: 'project:delivery', title: '另一个项目的讨论' })
    known.set('thread:d0e1f2a3', { threadRef: 'thread:d0e1f2a3', projectRef: 'project:delivery', title: '另一个项目的 Task', taskRef: 'task:s1b11000', taskNumber: 4 })
    const resolved = request.threadRefs.flatMap(threadRef => {
      const hit = known.get(threadRef)
      return hit === undefined ? [] : [hit]
    })
    return { ok: true as const, value: { resolved } }
  })

  const resolveMessageRefs = vi.fn(async (request: { workspaceId: string; messageRefs: readonly string[] }) => ({
    ok: true as const,
    value: {
      resolved: request.messageRefs.flatMap(messageRef => {
        const item = viewItems.find(candidate => (candidate.message as { messageRef?: string }).messageRef === messageRef)
        if (item === undefined) return []
        const message = item.message as { sender: string; body: string; threadRef: string }
        return [{ messageRef, threadRef: message.threadRef, sender: message.sender, excerpt: message.body.split('\n')[0]!.slice(0, 120) }]
      }),
    },
  }))

  const loadTaskBoard = vi.fn(async ({ workspaceId, projectRef, finishedLimit }: { workspaceId: string; projectRef?: string; finishedLimit?: number }) => {
    if (taskBoardFailure !== undefined) return { ok: false as const, error: { message: taskBoardFailure } }
    if (workspaceId !== 'w1') return { ok: true as const, value: { humanMemberId: 'member:human', open: [], finished: [], finishedTruncated: false } }
    const byTask = new Map<string, Record<string, unknown>>()
    for (const item of viewItems) {
      const task = item.task as { taskRef: string; status: string } | undefined
      if (task === undefined) continue
      const thread = item.thread as { threadRef: string }
      const message = item.message as { body: string; sequence: number }
      byTask.set(task.taskRef, {
        workspaceId: 'w1',
        projectRef,
        projectName: 'engineering',
        task,
        taskNumber: item.taskNumber ?? 1,
        threadRef: thread.threadRef,
        subject: message.body.split('\n')[0]!.slice(0, 120),
        liveClaimOwners: item.liveClaimOwners,
        accountableOwner: { memberId: 'member:human', name: 'human' },
        lastActivitySequence: message.sequence,
        lastActivityAt: item.lastActivityAt,
        relation: 'project-owner',
        needsAcceptance: task.status === 'in_review',
      })
    }
    const items = [...byTask.values()] as Array<{ readonly task: { readonly status: string }; readonly lastActivitySequence: number }>
    const newestFirst = (left: typeof items[number], right: typeof items[number]) => right.lastActivitySequence - left.lastActivitySequence
    const finished = items.filter(item => ['done', 'closed'].includes(item.task.status)).sort(newestFirst)
    const finishedLimitOrDefault = finishedLimit ?? 5
    return {
      ok: true as const,
      value: {
        humanMemberId: 'member:human',
        open: items.filter(item => !['done', 'closed'].includes(item.task.status)).sort(newestFirst),
        finished: finished.slice(0, finishedLimitOrDefault),
        finishedTruncated: finished.length > finishedLimitOrDefault,
      },
    }
  })

  const publishAgentReply = () => {
    const top = viewItems[0]!
    const activityAt = '2026-08-21T10:03:00.000Z'
    viewClaims.splice(0, viewClaims.length, {
      claimRef: 'claim:1', taskRef: 'task:1', threadRef: 'thread:1', owner: 'member:builder', direction: 'Implement API', normalizedDirection: 'implement api', state: 'active',
    })
    const taskStatus = (top.task as { status?: string } | undefined)?.status
    const liveClaimOwners = taskStatus === 'in_progress' || taskStatus === 'in_review'
      ? [{ memberId: 'member:builder', name: 'builder' }]
      : []
    viewItems = [
      { ...top, messageCount: 2, lastActivityAt: activityAt, liveClaimOwners },
      { ...top, messageCount: 2, lastActivityAt: activityAt, liveClaimOwners, message: { ...(top.message as object), messageRef: 'message:reply', sender: 'member:builder', body: 'agent reply', topLevel: false, sequence: 3, occurredAt: activityAt } },
    ]
    viewActivities = [{ activityRef: 'activity:claim', taskRef: 'task:1', threadRef: 'thread:1', actor: 'member:builder', kind: 'claim', claimRef: 'claim:1', sequence: 4 }]
    deps.wakeAll()
  }

  return {
    viewProjects,
    startThread,
    reply,
    promoteThread,
    changeAttention,
    failAttention,
    transferTask,
    seedTransferOutcome,
    changeTask,
    readThread,
    loadThreadHistory,
    failThreadHistory,
    threadObservations,
    resolveTaskRefs,
    resolveThreadRefs,
    resolveMessageRefs,
    loadTaskBoard,
    failTaskBoard,
    publishAgentReply,
  }
}
