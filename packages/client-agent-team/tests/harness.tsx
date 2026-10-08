import { RemoteStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { AgentTeamChangesRequest } from '@contexera/dsh-agent-team/types'
import { vi } from 'vitest'
import { useState } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamAddMemberRequest, AgentTeamCreateChannelRequest, AgentTeamMemberDiagnostic, AgentTeamReplyRequest, AgentTeamSendMessageRequest, AgentTeamTask } from '@contexera/dsh-agent-team/types'
import { COMMON_NS, LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn, zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as applySidebar, inject as injectSidebar } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { apply, inject } from '../src/client/index.ts'

// jsdom has no ResizeObserver; the shipped ConversationRoot publishes the
// composer seat's height through one on every mount.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub)

type FrameProps = PropsRuntime<'root'> & PropsRenderSlots<'sidebar' | 'main'>
function Frame({ renderSlot, usePanelInfo }: FrameProps) {
  const [collapsed, setCollapsed] = useState(false)
  // The shipped frame renders the keyed main cell for the selected global panel
  // and falls back to the conversation seat, so the bench follows the same rule
  // instead of pinning that seat.
  const panelId = usePanelInfo(info => info.activePanelId)
  return <>
    <button type="button" data-test-control onClick={() => { setCollapsed(value => !value) }}>Toggle fixture sidebar</button>
    {renderSlot('sidebar', { collapsed, width: collapsed ? 56 : 280 })}
    {renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })}
  </>
}

function BaselineWorkspace() { return <div data-baseline-workspaces>普通工作区</div> }
function BaselineSettings() { return <div data-baseline-settings>设置</div> }
interface HumanProfileSeed {
  readonly name?: string
  readonly avatarRef?: string
  readonly version?: string
  readonly repoUrl?: string
  readonly updateAvailable?: boolean
  readonly latestVersion?: string
}

interface EnvironmentSeed {
  readonly verdict?: 'ok' | 'out-of-range' | 'undetermined'
  readonly reason?: string
  readonly bundleVersion?: string
  readonly dshVersion?: string
  readonly certifiedDshVersion?: string
  readonly supportRange?: { readonly lower: string; readonly upper: string }
}

interface SeededMessage {
  readonly body: string
  readonly occurredAt: string
  readonly sender?: 'human' | 'agent'
  readonly mentions?: readonly string[]
}

export async function runtimeWithTeam(options?: { mode?: 'team'; mainPanelId?: string; workspaceId?: string; initialChannels?: boolean; remainingUnreadCounts?: readonly number[]; seededMessages?: readonly SeededMessage[]; seedTaskRef?: string; seedThreadRef?: string; seedTaskStatus?: AgentTeamTask['status']; seedFollowers?: readonly string[]; humanProfile?: HumanProfileSeed; humanProfileFailure?: string; environment?: EnvironmentSeed; environmentFailure?: string }) {
  if (options?.mode !== undefined) {
    localStorage.setItem('dsh.agent-team.navigation', JSON.stringify({ mode: options.mode, ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }) }))
  }
  const runtime = await SlotTestRuntime.create()
  // A selected global panel is part of the state a reload restores: the shipped
  // plugin page was open, the persisted Team mode comes back with it.
  if (options?.mainPanelId !== undefined) runtime.panelInfo.set({ activePanelId: options.mainPanelId as never })
  const locale = new LocaleRuntime(runtime.ctx)
  // rc.1: shipped sidebar chrome (brand row) reads the common namespace.
  locale.register(COMMON_NS, { zh: commonZh, en: commonEn })
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  // The layout face: the shipped frame's panel store is the runtime's own
  // panelInfo source (the same one `usePanelInfo` reads), so a spec selects a
  // global panel exactly the way the shipped sidebar and plugin manager do.
  const selectPanel = vi.fn((panelId: string | null): void => { runtime.panelInfo.set({ activePanelId: panelId as never }) })
  runtime.ctx.provide('layout', {
    toggleSidebar: vi.fn(),
    selectPanel,
    panelInfo: runtime.panelInfo,
  } as never)
  // rc.2: the shipped layout and sidebar inject 'shortcuts'. The takeover bench
  // mounts both, so it provides an empty command catalog for the sidebar's
  // keycap reads and a registrer that only reports success — no keyboard
  // adapter exists behind either.
  runtime.ctx.provide('shortcuts', {
    catalog: createSnapshotStore<readonly never[]>([]),
    register: () => () => {},
  } as never)
  // rc.1: the shipped sidebar injects 'uiWorkspace'; the takeover bench
  // provides a minimal navigation double whose openSession mirrors the
  // shipped selection contract — retire the previous `mainView` reference,
  // retain the next — so retention-based reads see one main session.
  let mainReference: { release(): void } | undefined
  const openSession = vi.fn((sessionId: string): void => {
    mainReference?.release()
    mainReference = runtime.sessions.retain(sessionId as never, { source: 'mainView' })
  })
  runtime.ctx.provide('uiWorkspace', { startSession: vi.fn(), connectWorkspace: vi.fn(async () => 'ordinary-session'), openSession })
  // The shipped conversation reads the developer-tools switch and per-domain
  // config scopes through the config-form registry.
  const developerTools = createSnapshotStore(true)
  runtime.ctx.provide('configForms', {
    developerTools: {
      enabled: developerTools,
      setEnabled: async (enabled: boolean) => { developerTools.set(enabled) },
    },
    get: () => stubConfigForm().scope,
  } as never)
  runtime.ctx.provide('conversation', {
    input: { for: () => ({ submit: vi.fn() }) },
    createDraftImages: () => [],
    draftImages: () => [],
    releaseDraftImage: () => {},
    releaseDraftImages: () => {},
    updateQueue: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    loadOlder: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  } as never)
  const status = (memberId: string, workspaceId: string, handle: string, presence: 'available' | 'working' | 'error' | 'unavailable', diagnostic?: AgentTeamMemberDiagnostic) => ({
    member: {
      memberId, workspaceId, handle, description: `${handle} description`,
      presetId: 'team-member', state: 'enabled', sessionId: `session:${memberId}`,
    },
    workspaceIds: [workspaceId],
    availability: presence === 'unavailable' ? 'unavailable' : 'active',
    presence,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  })
  let memberRows = [
    status('member:builder', 'w1', 'builder', 'available'),
    status('member:worker', 'w1', 'worker', 'working'),
    status('member:failed', 'w1', 'failed', 'error', { class: 'runtime', detail: 'model failed' }),
    status('member:offline', 'w1', 'offline', 'unavailable', { class: 'preset-composition', detail: 'preset missing' }),
    status('member:builder-beta', 'w2', 'builder', 'available'),
  ]
  const members = vi.fn(async ({ workspaceId }: { workspaceId?: string }) => ({ ok: true, value: memberRows.filter(entry => workspaceId === undefined || entry.workspaceIds.includes(workspaceId)) }))
  const joinWorkspace = vi.fn(async (request: { memberId: string; workspaceId: string }) => {
    const member = memberRows.find(entry => entry.member.memberId === request.memberId)!
    if (!member.workspaceIds.includes(request.workspaceId)) member.workspaceIds.push(request.workspaceId)
    return { ok: true as const, value: {} }
  })
  const leaveWorkspace = vi.fn(async (request: { memberId: string; workspaceId: string }) => {
    const member = memberRows.find(entry => entry.member.memberId === request.memberId)!
    member.workspaceIds = member.workspaceIds.filter(id => id !== request.workspaceId)
    return { ok: true as const, value: {} }
  })
  const addMember = vi.fn(async (request: AgentTeamAddMemberRequest) => ({ ok: true, value: {
    receipt: {},
    status: {
      member: {
        memberId: 'member:new', workspaceId: request.workspaceId, handle: request.handle, description: request.description,
        presetId: request.presetId, state: 'enabled', sessionId: 'session:new',
      },
      availability: 'active', presence: 'available',
    },
    workspaceIds: [request.workspaceId],
  } }))
  let channels: Array<Record<string, unknown>> = options?.initialChannels === true
    ? [{ channelRef: 'channel:engineering', workspaceId: 'w1', name: 'engineering', description: 'Engineering work', createdAtSequence: 1 }]
    : []
  let memberships: Array<Record<string, unknown>> = []
  const seedTaskRef = options?.seedTaskRef ?? 'task:1'
  const seedThreadRef = options?.seedThreadRef ?? 'thread:1'
  let viewItems: Array<Record<string, unknown>> = (options?.seededMessages ?? []).map((seed, index) => ({
    message: { messageRef: `message:seed-${index}`, channelRef: 'channel:engineering', threadRef: seedThreadRef, taskRef: seedTaskRef, sender: seed.sender === 'agent' ? 'member:builder' : 'member:human', body: seed.body, topLevel: true, sequence: index + 1, occurredAt: seed.occurredAt },
    mentions: seed.mentions ?? [],
    task: { taskRef: seedTaskRef, channelRef: 'channel:engineering', threadRef: seedThreadRef,
      status: options?.seedTaskStatus ?? 'todo', resolution: 'open' },
    thread: { threadRef: seedThreadRef, taskRef: seedTaskRef, revision: 2 },
    taskNumber: 1,
    // A seed carries no Claims, so the Host would project no owners either.
    claimOwners: [],
    messageCount: 1,
    // A seed is the only fact on its Thread, so the newest fact instant is the
    // Message's own: the feed reads that equality as "no follow-up yet".
    lastActivityAt: seed.occurredAt,
  }))
  let viewClaims: Array<Record<string, unknown>> = []
  let viewActivities: Array<Record<string, unknown>> = []
  const viewChannels = vi.fn(async (request: { threadRef?: string; topLevelOnly?: boolean }) => ({ ok: true, value: {
    humanMemberId: 'member:human', channels, members: memberships,
    tasks: viewItems.flatMap(item => item.task === undefined ? [] : [item.task]), threads: viewItems.length === 0 ? [] : [viewItems[0]!.thread],
    taskNumbers: viewItems.flatMap(item => item.task === undefined || item.taskNumber === undefined ? [] : [{ taskRef: (item.task as { taskRef: string }).taskRef, taskNumber: item.taskNumber }]),
    items: request.threadRef !== undefined || !request.topLevelOnly ? viewItems : viewItems.filter(item => (item.message as { topLevel?: boolean }).topLevel), claims: viewClaims, activities: request.topLevelOnly ? [] : viewActivities, cursor: 0, hasMore: false,
  } }))
  const createChannel = vi.fn(async (request: AgentTeamCreateChannelRequest) => {
    const channel = { channelRef: 'channel:new', workspaceId: request.workspaceId, name: request.name,
      description: request.description, createdAtSequence: 1 }
    channels = [...channels, channel]
    memberships = (request.memberIds ?? []).map(memberId => ({ channelRef: channel.channelRef, memberId }))
    return { ok: true, value: { receipt: {}, channel, memberIds: request.memberIds ?? [] } }
  })
  const joinChannel = vi.fn(async (request: { requestId: string; channelRef: string; memberId: string }) => {
    memberships = [...memberships, { channelRef: request.channelRef, memberId: request.memberId }]
    return { ok: true, value: {} }
  })
  const removeChannelMember = vi.fn(async (request: { requestId: string; channelRef: string; memberId: string }) => {
    memberships = memberships.filter(item => item.channelRef !== request.channelRef || item.memberId !== request.memberId)
    return { ok: true, value: {} }
  })
  const updateChannel = vi.fn(async (request: { requestId: string; workspaceId: string; channelRef: string; name: string; description: string }) => {
    channels = channels.map(channel => channel.channelRef === request.channelRef
      ? { ...channel, name: request.name, description: request.description } : channel)
    return { ok: true as const, value: { receipt: {}, channel: channels.find(channel => channel.channelRef === request.channelRef) } }
  })
  const updateMember = vi.fn(async (request: { requestId: string; memberId: string; handle: string; description: string; model?: { provider: string; model: string } }) => {
    memberRows = memberRows.map(entry => entry.member.memberId === request.memberId
      ? { ...entry, member: { ...entry.member, handle: request.handle, description: request.description, ...(request.model === undefined ? {} : { model: request.model }) } }
      : entry)
    const status = memberRows.find(entry => entry.member.memberId === request.memberId)
    return { ok: true as const, value: { receipt: {}, ...(status === undefined ? {} : { status }) } }
  })
  const recoverMember = vi.fn(async (request: { requestId: string; memberId: string }) => ({
    ok: true as const,
    value: { status: memberRows.find(entry => entry.member.memberId === request.memberId) },
  }))
  // The Host moves a renewed Member onto a freshly minted Session id, so the
  // mock transitions the row the way the real renewal does.
  let renewCounter = 0
  const clearMemberContext = vi.fn(async (request: { requestId: string; memberId: string }) => {
    renewCounter += 1
    memberRows = memberRows.map(entry => entry.member.memberId === request.memberId
      ? { ...entry, member: { ...entry.member, sessionId: `${entry.member.sessionId}-renewed-${renewCounter}` } }
      : entry)
    return {
      ok: true as const,
      value: { receipt: {}, status: memberRows.find(entry => entry.member.memberId === request.memberId) },
    }
  })
  // Archival hides the row: the mock transitions the member the way the real
  // archiveMember remote does (state archived, availability archived).
  const archiveMember = vi.fn(async (request: { requestId: string; memberId: string }) => {
    memberRows = memberRows.map(entry => entry.member.memberId === request.memberId
      ? { ...entry, member: { ...entry.member, state: 'archived' }, availability: 'archived', presence: 'unavailable' }
      : entry)
    const archived = memberRows.find(entry => entry.member.memberId === request.memberId)
    return {
      ok: true as const,
      value: { receipt: {}, member: archived?.member, releasedClaims: [], removedAttention: [] },
    }
  })
  // Channel archival hides the row from every view; the mock drops it like
  // the Host's workspace-scoped wake refetch would.
  const archiveChannel = vi.fn(async (request: { requestId: string; workspaceId: string; channelRef: string }) => {
    const archived = channels.find(channel => channel.channelRef === request.channelRef)
    channels = channels.filter(channel => channel.channelRef !== request.channelRef)
    return { ok: true as const, value: { receipt: {}, channel: archived, releasedClaims: [] } }
  })
  const modelCatalog = vi.fn(async () => ({ ok: true as const, value: {
    groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] } },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ] }],
    failures: [],
  } }))
  const putAttachment = vi.fn(async (request: { requestId: string; name: string; mediaType?: string; bytesBase64: string }) => ({
    ok: true as const,
    value: { attachmentId: `attachment:${putAttachmentCounter += 1}`, path: `/cache/${request.name}`, name: request.name, byteSize: request.bytesBase64.length, mediaType: request.mediaType ?? 'application/octet-stream' },
  }))
  let putAttachmentCounter = 0
  const getAttachment = vi.fn(async (request: { attachmentId: string }) => {
    if (request.attachmentId === 'attachment:2') return { ok: false as const, error: new Error('no longer cached') }
    return { ok: true as const, value: { name: 'x', mediaType: 'image/png', byteSize: 8, bytesBase64: 'aGVsbG8=' } }
  })
  let sentMessageCount = 0
  const sendMessage = vi.fn(async (request: AgentTeamSendMessageRequest) => {
    sentMessageCount += 1
    const sequence = 1 + sentMessageCount
    const asTask = request.asTask === true
    const task = asTask ? { taskRef: 'task:1', channelRef: request.channelRef, threadRef: 'thread:1', status: 'todo', resolution: 'open' } : undefined
    const thread = { threadRef: 'thread:1', ...(asTask ? { taskRef: 'task:1' } : {}), revision: sequence }
    const attachments = request.attachments === undefined ? [] : request.attachments.map(id => ({ attachmentId: id, name: `file-${id}.png`, byteSize: 8, mediaType: 'image/png' }))
    const message = { messageRef: `message:${sequence}`, channelRef: request.channelRef, threadRef: 'thread:1', ...(asTask ? { taskRef: 'task:1' } : {}), sender: 'member:human', body: request.body, ...(attachments.length === 0 ? {} : { attachments }), topLevel: true, sequence, occurredAt: '2026-08-21T10:00:00.000Z' }
    viewItems = [{ message, mentions: [], ...(task === undefined ? {} : { task, taskNumber: 1 }), thread, claimOwners: [], messageCount: 1, lastActivityAt: message.occurredAt }]
    return { ok: true as const, value: { kind: 'committed' as const, receipt: {}, message, ...(task === undefined ? {} : { task }), thread, attention: [], directMarkers: [] } }
  })
  let changeVersion = 0
  let changeFailure: string | undefined
  const generationListeners = new Set<() => void>()
  const changeWaiters = new Set<{ request: AgentTeamChangesRequest; wake(): void }>()
  const wakeAll = (): void => {
    changeVersion += 1
    for (const waiter of changeWaiters) waiter.wake()
  }
  const publishPresence = (): void => {
    changeVersion += 1
    for (const waiter of changeWaiters) if (waiter.request.scope?.kind === 'presence') waiter.wake()
  }
  const connection = {
    generation: {
      getSnapshot: () => changeFailure === undefined ? {} as never : undefined,
      subscribe: (listener: () => void) => { generationListeners.add(listener); return () => { generationListeners.delete(listener) } },
    },
  }
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
    const task = { taskRef: 'task:1', channelRef: 'channel:engineering', threadRef: request.threadRef, status: 'todo', resolution: 'open' }
    const thread = { ...(top.thread as object), taskRef: task.taskRef, revision: request.baseRevision + 1 }
    const activity = { activityRef: 'activity:promoted', kind: 'promote' as const, taskRef: task.taskRef, threadRef: request.threadRef, actor: 'member:human', sequence: request.baseRevision + 1 }
    // A promoted Task is brand-new with no Claims, so the Host projects no owners.
    viewItems = viewItems.map(item => ({ ...item, task, thread, taskNumber: 1, claimOwners: [] }))
    return { ok: true as const, value: { kind: 'committed' as const, receipt: {}, activity, task, thread } }
  })
  const changeTask = vi.fn(async (request: { action: 'accept' | 'close' | 'reopen' }) => {
    const top = viewItems[0]!
    const task = { ...(top.task as object),
      status: request.action === 'reopen' ? 'todo' : request.action === 'accept' ? 'done' : 'closed',
      resolution: request.action === 'reopen' ? 'open' : request.action === 'accept' ? 'accepted' : 'closed' }
    const thread = { ...(top.thread as object), revision: (top.thread as { revision: number }).revision + 1 }
    // Accept, close, and reopen all land outside the live statuses, so the
    // Host projects no owners after any of them.
    viewItems = viewItems.map(item => ({ ...item, task, thread, claimOwners: [] }))
    return { ok: true as const, value: { kind: 'committed', receipt: {}, activity: { activityRef: `activity:${request.action}`, taskRef: 'task:1', threadRef: 'thread:1', actor: 'member:human', kind: request.action, sequence: (thread.revision as number) + 10 }, task, thread, claims: viewClaims } }
  })
  // Each read consumes the queue head as its remainingUnreadCount: the page's
  // auto-drain loop keeps issuing fresh-requestId reads until a zero, so the
  // queue supplies every round the way the Host's bounded batches would.
  const remainingUnreadCounts = [...(options?.remainingUnreadCounts ?? [])]
  const readThread = vi.fn(async ({ requestId, taskRef, threadRef }: { requestId?: string; taskRef?: string; threadRef?: string }) => {
    void requestId
    const top = viewItems.find(item => (threadRef !== undefined && (item.thread as { threadRef: string }).threadRef === threadRef)
      || (taskRef !== undefined && (item.task as { taskRef?: string } | undefined)?.taskRef === taskRef)) ?? viewItems[0]
    if (top === undefined) return { ok: false as const, error: { message: 'thread missing' } }
    const remainingUnreadCount = remainingUnreadCounts.length > 0 ? remainingUnreadCounts.shift()! : 0
    // A durable read consumes this reader's mention markers: the direct-only
    // Inbox double drops the read Thread's rows, like the Host's projection.
    const readThreadRef = (top.thread as { threadRef?: string }).threadRef
    inboxRows = inboxRows.filter(row => ((row.item as { thread?: { threadRef?: string } }).thread?.threadRef) !== readThreadRef)
    return { ok: true as const, value: {
      receipt: {}, task: top.task, thread: top.thread, claims: viewClaims,
      anchor: top.message, anchorMentions: [], facts: [...viewItems.map(item => ({ fact: { kind: 'message' as const, sequence: (item.message as { sequence: number }).sequence, message: item.message, mentions: (item as { mentions?: string[] }).mentions ?? [] }, unread: false, direct: false })), ...viewActivities.map(activity => ({ fact: { kind: 'activity' as const, sequence: activity.sequence as number, activity }, unread: false, direct: false }))],
      readThroughSequence: (top.thread as { revision: number }).revision, remainingUnreadCount, consumedDirectMarkers: [],
    } }
  })
  const loadThreadHistory = vi.fn(async ({ taskRef, threadRef }: { taskRef?: string; threadRef?: string }) => {
    const top = viewItems.find(item => (threadRef !== undefined && (item.thread as { threadRef: string }).threadRef === threadRef)
      || (taskRef !== undefined && (item.task as { taskRef?: string } | undefined)?.taskRef === taskRef)) ?? viewItems[0]
    if (top === undefined) return { ok: false as const, error: { message: 'thread missing' } }
    return { ok: true as const, value: { task: top.task, thread: top.thread, anchor: top.message, anchorMentions: [], claims: viewClaims, facts: [], cursor: 0, hasMore: false } }
  })
  // The Human author follows every seeded Thread; tests override the set to
  // drive the mention-candidate ranking.
  const threadFollowers = [...(options?.seedFollowers ?? ['member:human'])]
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
    // One Host-known Task lives outside the loaded channel timeline, so the
    // click fallback path has something real to resolve.
    const known = new Map(viewItems.flatMap(item => {
      const taskRef = (item.task as { taskRef?: string } | undefined)?.taskRef
      return taskRef === undefined ? [] : [[taskRef, item] as const]
    }))
    known.set('task:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6c', {
      task: { taskRef: 'task:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6c', channelRef: 'channel:engineering', threadRef: 'thread:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6d', status: 'todo', resolution: 'open' },
    })
    const resolved = request.taskRefs.flatMap(taskRef => {
      const item = known.get(taskRef) ?? [...known.values()].find(candidate => {
        const candidateRef = (candidate.task as { taskRef?: string } | undefined)?.taskRef
        return candidateRef !== undefined && candidateRef.startsWith(taskRef)
      })
      if (item === undefined) return []
      const task = item.task as { taskRef: string; channelRef: string; threadRef: string }
      return [{ taskRef: task.taskRef, channelRef: task.channelRef, threadRef: task.threadRef, taskNumber: numbers.get(task.taskRef) ?? 2 }]
    })
    return { ok: true as const, value: { resolved } }
  })
  // The Human Inbox double: rows are tagged per Workspace, and one call shape
  // serves every surface that reads the Inbox — the sidebar badge, the Inbox
  // page, and the Channel feed's Thread entries. It returns the Host's two
  // slices: `items` is the unread queue (mentions inside it, not alone, so
  // `totalUnreadCount` is the badge number while `directCount` stays the row's
  // own mention count), and a row seeded with no unread stands for the
  // 「最近活跃」 tail the Host admits by participation instead.
  let inboxRows: Array<{ readonly workspaceId: string; readonly item: Record<string, unknown> }> = []
  const inbox = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
    const scoped = inboxRows.filter(row => row.workspaceId === workspaceId)
    const holdsUnread = (row: { readonly item: Record<string, unknown> }): boolean => ((row.item as { unreadCount?: number }).unreadCount ?? 0) > 0
    const items = scoped.filter(holdsUnread).map(row => row.item)
    const recent = scoped.filter(row => !holdsUnread(row)).map(row => row.item)
    const unread = items.reduce((sum, item) => sum + ((item as { unreadCount?: number }).unreadCount ?? 0), 0)
    const direct = items.reduce((sum, item) => sum + ((item as { directCount?: number }).directCount ?? 0), 0)
    return { ok: true as const, value: { humanMemberId: 'member:human', items, recent, totalUnreadCount: unread, totalDirectCount: direct } }
  })
  const seedInbox = (rows: ReadonlyArray<{ readonly workspaceId: string } & Record<string, unknown>>): void => {
    inboxRows = rows.map(row => ({ workspaceId: row.workspaceId, item: row as Record<string, unknown> }))
    wakeAll()
  }
  const changes = vi.fn(async function* (request: AgentTeamChangesRequest, signal?: AbortSignal) {
    let pending = false
    let resume: (() => void) | undefined
    const waiter = { request, wake: () => { pending = true; resume?.() } }
    const abort = () => resume?.()
    changeWaiters.add(waiter)
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
  })
  const failChanges = (message = 'transport down'): void => { changeFailure = message; wakeAll() }
  const recoverChanges = (): void => {
    changeFailure = undefined
    for (const listener of generationListeners) listener()
  }
  const publishAgentReply = () => {
    const top = viewItems[0]!
    // The reply and the Claim it carries are newer facts than the opener, so
    // the Thread's newest instant moves: that difference is what the feed's
    // "last activity" reads.
    const activityAt = '2026-08-21T10:03:00.000Z'
    viewClaims = [{ claimRef: 'claim:1', taskRef: 'task:1', threadRef: 'thread:1', owner: 'member:builder', direction: 'Implement API', normalizedDirection: 'implement api', state: 'active' }]
    // The feed reads owners off the item the way the Host projects them — the
    // active Claim's owner while its Task is still live — so the fake carries
    // the same owners instead of leaving the seeded empty set behind.
    const taskStatus = (top.task as { status?: string } | undefined)?.status
    const claimOwners = taskStatus === 'in_progress' || taskStatus === 'in_review'
      ? [{ memberId: 'member:builder', name: 'builder' }]
      : []
    viewItems = [{ ...top, messageCount: 2, lastActivityAt: activityAt, claimOwners }, { ...top, messageCount: 2, lastActivityAt: activityAt, claimOwners, message: { ...(top.message as object), messageRef: 'message:reply', sender: 'member:builder', body: 'agent reply', topLevel: false, sequence: 3, occurredAt: activityAt } }]
    viewActivities = [{ activityRef: 'activity:claim', taskRef: 'task:1', threadRef: 'thread:1', actor: 'member:builder', kind: 'claim', claimRef: 'claim:1', sequence: 4 }]
    wakeAll()
  }
  /** Simulates an externally driven channel/membership commit reaching every workspace waiter. */
  const seedChannel = (channel: Record<string, unknown>) => { channels = [...channels, channel] }
  const publishChannelUpdate = () => { wakeAll() }
  // The Human profile doubles: the profile page and every seat that names or
  // draws the Human read the same Remotes, and the Host writes the page makes
  // land in the same seeded value — so one rename visibly moves the page, the
  // timeline, and the member refs together.
  let humanProfileValue: { name: string; avatarRef?: string; version: string; repoUrl: string; updateAvailable: boolean; latestVersion?: string } = {
    name: 'human',
    version: '0.1.13',
    repoUrl: 'https://github.com/Contexera/dsh-agent-team',
    updateAvailable: false,
    ...options?.humanProfile,
  }
  // Both seeded before the Team Client mounts, so the first demand-driven read
  // answers with exactly what the test asked for.
  let humanProfileFailure: string | undefined = options?.humanProfileFailure
  let humanProfileWriteFailure: string | undefined
  const humanProfile = vi.fn(async () => humanProfileFailure === undefined
    ? { ok: true as const, value: { ...humanProfileValue } }
    : { ok: false as const, error: { message: humanProfileFailure } })
  const getHumanAvatar = vi.fn(async (_request: { avatarRef: string }) => ({
    ok: true as const,
    value: { name: 'avatar.png', mediaType: 'image/png', byteSize: 3, bytesBase64: 'AAAA' },
  }))
  const putHumanAvatar = vi.fn(async (_request: { name: string; mediaType?: string; bytesBase64: string }) => ({
    ok: true as const,
    value: { avatarRef: 'avatar:1', path: '/human/v1/avatar:1/avatar.png', name: 'avatar.png', byteSize: 3, mediaType: 'image/png' },
  }))
  const removeHumanAvatar = vi.fn(async (_request: { avatarRef: string }) => ({ ok: true as const, value: { removed: true } }))
  // The Host owns the profile write and answers with the resolved name +
  // avatarRef, so the bench refuses exactly where the Host refuses: before
  // anything is stored.
  const setHumanProfile = vi.fn(async (request: { name?: string; avatarRef?: string | null }) => {
    if (humanProfileWriteFailure !== undefined) return { ok: false as const, error: { message: humanProfileWriteFailure } }
    if (typeof request.name === 'string') humanProfileValue = { ...humanProfileValue, name: request.name }
    if (request.avatarRef === null) {
      const { avatarRef: _avatarRef, ...rest } = humanProfileValue
      humanProfileValue = rest
    } else if (typeof request.avatarRef === 'string') humanProfileValue = { ...humanProfileValue, avatarRef: request.avatarRef }
    const { version: _version, repoUrl: _repoUrl, updateAvailable: _updateAvailable, latestVersion: _latestVersion, ...profile } = humanProfileValue
    return { ok: true as const, value: profile }
  })
  /** Seed the Human profile every identity read answers with. */
  const seedHumanProfile = (next: Partial<typeof humanProfileValue>): void => {
    humanProfileValue = { ...humanProfileValue, ...next }
  }
  /** Make the next profile reads fail, or clear the failure. */
  const failHumanProfile = (message?: string): void => {
    humanProfileFailure = message
  }
  /** Make the next profile writes fail, or clear the failure. */
  const failHumanProfileWrite = (message?: string): void => {
    humanProfileWriteFailure = message
  }
  // The environment check double: one read, no write, seeded before the Team
  // Client mounts because its projection reads on the first subscriber.
  let environmentValue: EnvironmentSeed & { readonly verdict: 'ok' | 'out-of-range' | 'undetermined' } = {
    verdict: 'ok',
    bundleVersion: '0.1.15',
    dshVersion: '0.1.7-rc.1',
    certifiedDshVersion: '0.1.7-rc.1',
    supportRange: { lower: '0.1.7-rc.1', upper: '0.1.8' },
    ...options?.environment,
  }
  let environmentFailure: string | undefined = options?.environmentFailure
  const environment = vi.fn(async () => environmentFailure === undefined
    ? { ok: true as const, value: { ...environmentValue } }
    : { ok: false as const, error: { message: environmentFailure } })
  /** Seed the environment report every check read answers with. */
  const seedEnvironment = (next: Partial<typeof environmentValue>): void => {
    environmentValue = { ...environmentValue, ...next }
  }
  /** Make the next environment reads fail, or clear the failure. */
  const failEnvironment = (message?: string): void => {
    environmentFailure = message
  }

  // rc.1: the runtime owns one TestRemote; the bench scripts the namespaces
  // the mounted features reach (remote.<name> injects included) and attaches
  // the change-stream and generated-remote-mount faces the shipped double
  // refuses by contract.
  runtime.remote.provideNamespaces({
    session: { modelCatalog },
    agentTeam: { members, joinWorkspace, leaveWorkspace, addMember, view: viewChannels, inbox, readThread, threadHistory: loadThreadHistory, threadObservations, putAttachment, getAttachment, createChannel, updateChannel, archiveChannel, updateMember, recoverMember, clearMemberContext, archiveMember, joinChannel, removeChannelMember, sendMessage, reply, changeTask, promoteThread, resolveTaskRefs, changes, environment, humanProfile, setHumanProfile, putHumanAvatar, getHumanAvatar, removeHumanAvatar },
  })
  Object.assign(runtime.remote, {
    $stream: <T,>(options: ConstructorParameters<typeof RemoteStream<T>>[1]) => new RemoteStream(connection, options),
    $mount: async () => async () => {},
  })
  runtime.ctx.provide('connection', { isLoopback: true, generation: { getSnapshot: () => ({}) }, state: { getSnapshot: () => ({}) }, rpc: {}, reconnect: vi.fn(), registerGenerationSource: vi.fn(), start: vi.fn(), stop: vi.fn() })
  await runtime.sessions.add({ id: 'ordinary-session', summary: { title: 'Ordinary', cwd: '/work/alpha' } })
  // The workspace service restores the Human's saved selection at boot; the
  // bench seeds the same `mainView` retention so return-target captures see
  // a live selection.
  mainReference = runtime.sessions.retain('ordinary-session' as never, { source: 'mainView' })
  await runtime.workspaces.update((draft) => {
    draft.items = [
      { workspaceId: 'w1' as WorkspaceId, title: 'Alpha', path: '/work/alpha', sessionIds: [], createdAt: '', updatedAt: '' },
      { workspaceId: 'w2' as WorkspaceId, title: 'Beta', path: '/work/beta', sessionIds: [], createdAt: '', updatedAt: '' },
    ] as never
  })
  await runtime.root.declare({
    sidebar: { kind: 'single', scope: 'root' },
    main: { kind: 'keyed', scope: 'root' },
  } as never, Frame as never)
  await runtime.mount({ inject: [...injectSidebar], apply: applySidebar })
  // The shipped ConversationRoot occupies the conversation seat — the same
  // surface production mounts — so member-session specs assert the
  // session-maybe seat's adoption semantics (remount on no-session) through
  // real element identity of the root's [data-phase] node.
  await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
  const disposeWorkspace = runtime.slots.register({ name: 'sidebar.workspaces', priority: 0 }, BaselineWorkspace as never)
  const disposeSettings = runtime.slots.register({ name: 'sidebar.settings', priority: 0 }, BaselineSettings as never)
  const team = await runtime.mount({ inject: [...inject], apply })
  const view = runtime.renderRoot()
  return { runtime, team, view, panelInfo: runtime.panelInfo, selectPanel, disposeWorkspace, disposeSettings, members, humanProfile, setHumanProfile, getHumanAvatar, putHumanAvatar, removeHumanAvatar, seedHumanProfile, failHumanProfile, failHumanProfileWrite, environment, seedEnvironment, failEnvironment, joinWorkspace, leaveWorkspace, addMember, status, viewChannels, createChannel, updateChannel, archiveChannel, putAttachment, getAttachment, updateMember, recoverMember, clearMemberContext, archiveMember, modelCatalog, joinChannel, removeChannelMember, sendMessage, reply, changeTask, promoteThread, resolveTaskRefs, publishAgentReply, publishPresence, seedChannel, publishChannelUpdate, failChanges, recoverChanges, readThread, loadThreadHistory, threadObservations, changes, inbox, seedInbox, openSession }
}
