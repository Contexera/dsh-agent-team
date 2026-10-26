import { RemoteStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import type { AgentTeamChangesRequest } from '@contexera/dsh-agent-team/types'
import { afterEach, expect, vi } from 'vitest'
import { fireEvent, type RenderResult } from '@testing-library/react'
import { useState } from 'react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { AgentTeamAddMemberRequest, AgentTeamCreateProjectRequest, AgentTeamMemberDiagnostic, AgentTeamReplyRequest, AgentTeamTask } from '@contexera/dsh-agent-team/types'
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

// jsdom 30 implements no FontFaceSet at all, so `document.fonts` is absent
// while every real browser has one; the shipped composer control row subscribes
// to its 'loadingdone' event when it measures the two control groups.
if (document.fonts === undefined) {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  })
}

// A throwing slot entry is contained by the shipped SlotErrorBoundary and only
// reported through console.error: the surface disappears and the suite stays
// green. An incomplete `conversation` stub produced exactly that — 34 passing
// tests beside 51 `Invalid value used as weak map key` reports from
// 'conversation.composer.bar' — so a passing exit code is not evidence the page
// rendered. Collect those reports and fail the spec file that mounted them.
const slotCrashes: string[] = []
const consoleError = console.error.bind(console)
console.error = (...args: unknown[]): void => {
  const text = args.map(value => value instanceof Error ? `${value.name}: ${value.message}` : String(value)).join(' ')
  if (text.includes('slot entry crashed')) slotCrashes.push(text)
  consoleError(...args)
}
afterEach(() => {
  const crashes = slotCrashes.splice(0)
  expect(crashes, `slot entries crashed:\n${crashes.join('\n')}`).toEqual([])
})

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

type TeamView = Pick<RenderResult, 'getByRole'>

/** Opens the composer's thread-start mode; the next send creates a Thread instead of a Main stream message. */
export function pressStartThread(view: TeamView): void {
  fireEvent.click(view.getByRole('button', { name: '讨论/任务' }))
}

/** Thread-start mode with the Task box checked: the next send creates a Task. */
export function pressStartTask(view: TeamView): void {
  pressStartThread(view)
  fireEvent.click(view.getByRole('checkbox', { name: '作为任务' }))
}

/** One Main stream entry as the Host projects it; the harness fills the flags a spec does not care about. */
export type MainStreamSeedEntry = { readonly kind: 'message' | 'activity' | 'thread-card'; readonly sequence: number; readonly occurredAt: string; readonly unread?: boolean } & Record<string, unknown>

interface SeededMessage {
  readonly body: string
  readonly occurredAt: string
  readonly sender?: 'human' | 'agent'
  readonly mentions?: readonly string[]
}

export async function runtimeWithTeam(options?: { mode?: 'team'; mainPanelId?: string; workspaceId?: string; initialProjects?: boolean; remainingUnreadCounts?: readonly number[]; seededMessages?: readonly SeededMessage[]; seedTaskRef?: string; seedThreadRef?: string; seedTaskless?: boolean; seedsAsMainMessages?: boolean; seedTaskStatus?: AgentTeamTask['status']; seedFollowers?: readonly string[]; humanProfile?: HumanProfileSeed; humanProfileFailure?: string; mainStreamEntries?: readonly MainStreamSeedEntry[]; mainStreamUnread?: number; environment?: EnvironmentSeed; environmentFailure?: string }) {
  if (options?.mode !== undefined) {
    localStorage.setItem('dsh.agent-team.navigation', JSON.stringify({ mode: options.mode, ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }) }))
  }
  const runtime = await SlotTestRuntime.create()
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
  // The shipped layout store drops a selection once no live `main` entry owns
  // its key (ui-layout's `retainMainPanels`, subscribed to the main slot): that
  // is what returns ordinary DSH when a plugin unloads while its panel stands.
  // The double mirrors the reconciliation instead of keeping a dangling id.
  const retainMainPanels = (): void => {
    const keys = runtime.slots.entries('main').flatMap(entry => entry.options.key === undefined ? [] : [entry.options.key])
    const active = runtime.panelInfo.getSnapshot().activePanelId
    if (active !== null && !keys.includes(active)) runtime.panelInfo.set({ activePanelId: null })
  }
  runtime.slots.subscribe('main', retainMainPanels)
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
  // config scopes through the config-form registry. The Team settings page also
  // reads the Host row's own form there, so the registry answers per entry id
  // and the Host row's page is seeded as a served document.
  const developerTools = createSnapshotStore(true)
  const configForms = new Map<string, ReturnType<typeof stubConfigForm>>()
  const configFormFor = (entryId: string): ReturnType<typeof stubConfigForm> => {
    let form = configForms.get(entryId)
    if (form === undefined) {
      form = stubConfigForm()
      configForms.set(entryId, form)
    }
    return form
  }
  const teamConfigForm = configFormFor('wowyuarm-agent-team-host')
  teamConfigForm.publish({
    status: 'ready',
    writable: true,
    revision: 1,
    value: { memberCompaction: { enabled: true, tokens: 256_000 } },
    base: { memberCompaction: { tokens: 256_000 } },
    user: {},
  })
  runtime.ctx.provide('configForms', {
    developerTools: {
      enabled: developerTools,
      setEnabled: async (enabled: boolean) => { developerTools.set(enabled) },
    },
    get: (entryId: string) => configFormFor(entryId).scope,
  } as never)
  // The shipped Conversation core reads its whole outward face here, and two of
  // those reads are not calls: the composer bar injects `fileUploads` as a live
  // observable hook, which the renderer caches by identity — an absent member
  // therefore crashes the entry instead of failing a call. Mirror the published
  // controller face (verbs, draft attachments, upload states), not just the
  // verbs our own surfaces use.
  runtime.ctx.provide('conversation', {
    input: { for: () => ({ submit: vi.fn() }) },
    send: vi.fn(async () => {}),
    updateQueue: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    loadOlder: vi.fn(async () => {}),
    fileUploads: createSnapshotStore<Record<string, unknown>>({}),
    createDrafts: () => [],
    resolveDraftAttachments: () => [],
    retryFileUpload: () => {},
    releaseDraftAttachment: () => {},
    releaseDraftAttachments: () => {},
    rebindDraftFiles: () => {},
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
  let projects: Array<Record<string, unknown>> = options?.initialProjects === true
    ? [{ projectRef: 'project:engineering', workspaceId: 'w1', name: 'engineering', description: 'Engineering work', createdAtSequence: 1 }]
    : []
  let memberships: Array<Record<string, unknown>> = []
  let owners: Array<{ projectRef: string; memberId: string }> = []
  const seedTaskRef = options?.seedTaskRef ?? 'task:1'
  const seedThreadRef = options?.seedThreadRef ?? 'thread:1'
  // A taskless seed grows a discussion instead of a Task: no Task fact and no
  // number, and the Message and Thread carry no taskRef. The projections below
  // already filter undefined Tasks out of tasks/taskNumbers, and the read /
  // reply / promote doubles all key on threadRef, so every double downstream
  // stays unchanged.
  const taskless = options?.seedTaskless === true
  let viewItems: Array<Record<string, unknown>> = (options?.seededMessages ?? []).map((seed, index) => ({
    message: { messageRef: `message:seed-${index}`, projectRef: 'project:engineering', threadRef: seedThreadRef, ...(taskless ? {} : { taskRef: seedTaskRef }), sender: seed.sender === 'agent' ? 'member:builder' : 'member:human', body: seed.body, topLevel: true, sequence: index + 1, occurredAt: seed.occurredAt },
    mentions: seed.mentions ?? [],
    ...(taskless ? {} : { task: { taskRef: seedTaskRef, projectRef: 'project:engineering', threadRef: seedThreadRef,
      status: options?.seedTaskStatus ?? 'todo', resolution: 'open', accountable: 'member:human', sourceThreadRefs: [] }, taskNumber: 1 }),
    thread: { threadRef: seedThreadRef, ...(taskless ? {} : { taskRef: seedTaskRef }), revision: 2 },
    // A seed carries no Claims, so the Host would project no owners either.
    liveClaimOwners: [], reminders: [],
    messageCount: 1,
    // A seed is the only fact on its Thread, so the newest fact instant is the
    // Message's own: the feed reads that equality as "no follow-up yet".
    lastActivityAt: seed.occurredAt,
  }))
  let viewClaims: Array<Record<string, unknown>> = []
  let viewActivities: Array<Record<string, unknown>> = []
  const viewProjects = vi.fn(async (request: { threadRef?: string; topLevelOnly?: boolean }) => ({ ok: true, value: {
    humanMemberId: 'member:human', projects, members: memberships, owners, rulesVersion: 2,
    tasks: viewItems.flatMap(item => item.task === undefined ? [] : [item.task]), threads: viewItems.length === 0 ? [] : [viewItems[0]!.thread],
    taskNumbers: viewItems.flatMap(item => item.task === undefined || item.taskNumber === undefined ? [] : [{ taskRef: (item.task as { taskRef: string }).taskRef, taskNumber: item.taskNumber }]),
    items: request.threadRef !== undefined || !request.topLevelOnly ? viewItems : viewItems.filter(item => (item.message as { topLevel?: boolean }).topLevel), claims: viewClaims, activities: request.topLevelOnly ? [] : viewActivities, cursor: 0, hasMore: false,
  } }))
  const createProject = vi.fn(async (request: AgentTeamCreateProjectRequest) => {
    const project = { projectRef: 'project:new', workspaceId: request.workspaceId, name: request.name,
      description: request.description, createdAtSequence: 1 }
    projects = [...projects, project]
    memberships = (request.memberIds ?? []).map(memberId => ({ projectRef: project.projectRef, memberId }))
    return { ok: true, value: { receipt: {}, project, memberIds: request.memberIds ?? [] } }
  })
  const updateProject = vi.fn(async (request: { requestId: string; workspaceId: string; projectRef: string; name: string; description: string }) => {
    projects = projects.map(project => project.projectRef === request.projectRef
      ? { ...project, name: request.name, description: request.description } : project)
    return { ok: true as const, value: { receipt: {}, project: projects.find(project => project.projectRef === request.projectRef) } }
  })
  let projectOwnerFailure: string | undefined
  const failProjectOwnerWrite = (message?: string): void => { projectOwnerFailure = message }
  const writeProjectOwner = (add: boolean) => async (request: { requestId: string; workspaceId: string; projectRef: string; memberId: string }) => {
    if (projectOwnerFailure !== undefined) return { ok: false as const, error: { message: projectOwnerFailure } }
    owners = owners.filter(owner => !(owner.projectRef === request.projectRef && owner.memberId === request.memberId))
    if (add) owners = [...owners, { projectRef: request.projectRef, memberId: request.memberId }]
    return { ok: true as const, value: { receipt: {}, projectRef: request.projectRef, ownerIds: owners.filter(owner => owner.projectRef === request.projectRef).map(owner => owner.memberId) } }
  }
  const addProjectOwner = vi.fn(writeProjectOwner(true))
  const removeProjectOwner = vi.fn(writeProjectOwner(false))
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
  // Project archival hides the row from every view; the mock drops it like
  // the Host's workspace-scoped wake refetch would.
  const archiveProject = vi.fn(async (request: { requestId: string; workspaceId: string; projectRef: string }) => {
    const archived = projects.find(project => project.projectRef === request.projectRef)
    projects = projects.filter(project => project.projectRef !== request.projectRef)
    return { ok: true as const, value: { receipt: {}, project: archived, releasedClaims: [] } }
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
  // Seeded Threads reach the Main stream as the cards the Host would draw for them, so a spec that seeds a Thread reads it from the stream.
  const seededCards: MainStreamSeedEntry[] = viewItems.map(item => {
    const message = item.message as { messageRef: string; sender: string; body: string; sequence: number; occurredAt: string }
    return { kind: 'thread-card', sequence: message.sequence, occurredAt: message.occurredAt, card: {
      threadRef: seedThreadRef,
      anchor: { messageRef: message.messageRef, sender: message.sender, preview: message.body, sequence: message.sequence, occurredAt: message.occurredAt },
      ...(taskless ? {} : { task: { taskRef: seedTaskRef, taskNumber: 1, status: options?.seedTaskStatus ?? 'todo', resolution: 'open', liveClaimOwners: [] } }),
      replyCount: 0, participants: [], newestSequence: message.sequence, newestOccurredAt: message.occurredAt,
      newestActor: { memberId: message.sender, name: message.sender === 'member:builder' ? 'builder' : 'human' },
    } }
  })
  const seededMessageEntries: MainStreamSeedEntry[] = (options?.seededMessages ?? []).map((seed, index) => ({
    kind: 'message', sequence: index + 1, occurredAt: seed.occurredAt,
    message: { messageRef: `message:main-seed-${index}`, projectRef: 'project:engineering', scope: 'main', sender: seed.sender === 'agent' ? 'member:builder' : 'member:human', body: seed.body, sequence: index + 1, occurredAt: seed.occurredAt },
    mentions: seed.mentions ?? [],
  }))
  let mainEntries = [...(options?.mainStreamEntries ?? (options?.seedsAsMainMessages === true ? seededMessageEntries : seededCards))]
  // A card is unread while its Thread's Inbox row is, as the Host derives it.
  const threadHoldsUnread = (threadRef: string): boolean => inboxRows.some(row => ((row.item as { thread?: { threadRef?: string }; unreadCount?: number }).thread?.threadRef === threadRef) && ((row.item as { unreadCount?: number }).unreadCount ?? 0) > 0)
  let mainUnread = options?.mainStreamUnread ?? 0
  let mainUnreadRequiredOnce = false
  const mainStanding = () => ({ owner: true, head: mainEntries.at(-1)?.sequence ?? 0, unreadCount: mainUnread, directCount: 0, markers: [] })
  const mainStreamHistory = vi.fn(async (request: { beforeSequence?: number; limit?: number }) => {
    const older = mainEntries.filter(entry => request.beforeSequence === undefined || entry.sequence < request.beforeSequence)
    const page = older.slice(-(request.limit ?? 20))
    return { ok: true as const, value: { projectRef: 'project:engineering', entries: page.map(entry => ({ direct: false, unread: entry.kind === 'thread-card' && threadHoldsUnread((entry.card as { threadRef: string }).threadRef), ...entry })), cursor: page[0]?.sequence ?? 1, hasMore: older.length > page.length, standing: mainStanding() } }
  })
  const readMainStream = vi.fn(async () => {
    mainUnread = 0
    // A Main stream read consumes this reader's markers, so the Project's Inbox
    // row leaves the queue — the same projection move a Thread read makes.
    mainInboxRows = mainInboxRows.filter(row => row.projectRef !== 'project:engineering')
    return { ok: true as const, value: { projectRef: 'project:engineering', readThroughSequence: mainEntries.at(-1)?.sequence ?? 0, entries: [], consumedMarkers: [], standing: mainStanding() } }
  })
  const requireMainRead = (): void => { mainUnreadRequiredOnce = true }
  const appendMainMessage = (body: string, replyToMessageRef?: string, attachmentIds: readonly string[] = []) => {
    const sequence = (mainEntries.at(-1)?.sequence ?? 0) + 1
    const attachments = attachmentIds.map(id => ({ attachmentId: id, name: `file-${id}.png`, byteSize: 8, mediaType: 'image/png' }))
    const message = { messageRef: `message:main-${sequence}`, projectRef: 'project:engineering', scope: 'main', sender: 'member:human', body, ...(replyToMessageRef === undefined ? {} : { replyToMessageRef }), ...(attachments.length === 0 ? {} : { attachments }), sequence, occurredAt: '2026-10-20T10:00:00.000Z' }
    mainEntries = [...mainEntries, { kind: 'message', sequence, occurredAt: message.occurredAt, message, mentions: [] }]
    return message
  }
  const postMainMessage = vi.fn(async (request: { requestId: string; body: string; replyToMessageRef?: string; attachments?: readonly string[] }) => {
    if (mainUnreadRequiredOnce) {
      mainUnreadRequiredOnce = false
      mainUnread = 1
      return { ok: true as const, value: { kind: 'main_unread_required' as const, projectRef: 'project:engineering', unreadCount: 1, directCount: 0, head: mainEntries.at(-1)?.sequence ?? 0, entries: [] } }
    }
    return { ok: true as const, value: { kind: 'committed' as const, receipt: {}, message: appendMainMessage(request.body, request.replyToMessageRef, request.attachments), markers: [] } }
  })
  let startedThreadCount = 0
  const startThread = vi.fn(async (request: { requestId: string; kind: 'discussion' | 'task'; body: string; projectRef: string; attachments?: readonly string[] }) => {
    startedThreadCount += 1
    const sequence = (mainEntries.at(-1)?.sequence ?? 0) + 1
    const asTask = request.kind === 'task'
    const attachments = (request.attachments ?? []).map(id => ({ attachmentId: id, name: `file-${id}.png`, byteSize: 8, mediaType: 'image/png' }))
    const message = { messageRef: `message:${1 + startedThreadCount}`, projectRef: request.projectRef, threadRef: 'thread:1', ...(asTask ? { taskRef: 'task:1' } : {}), sender: 'member:human', body: request.body, ...(attachments.length === 0 ? {} : { attachments }), topLevel: true, sequence, occurredAt: '2026-08-21T10:00:00.000Z' }
    const task = asTask ? { taskRef: 'task:1', projectRef: request.projectRef, threadRef: 'thread:1', status: 'todo', resolution: 'open' } : undefined
    const thread = { threadRef: 'thread:1', ...(asTask ? { taskRef: 'task:1' } : {}), revision: sequence }
    viewItems = [{ message, mentions: [], ...(task === undefined ? {} : { task, taskNumber: 1 }), thread, liveClaimOwners: [], messageCount: 1, lastActivityAt: message.occurredAt }]
    const card = { threadRef: 'thread:1', anchor: { messageRef: message.messageRef, sender: 'member:human', preview: request.body, sequence, occurredAt: message.occurredAt }, ...(task === undefined ? {} : { task: { taskRef: 'task:1', taskNumber: 1, status: 'todo', resolution: 'open', liveClaimOwners: [] } }), replyCount: 0, participants: [], newestSequence: sequence, newestOccurredAt: message.occurredAt, newestActor: { memberId: 'member:human', name: 'human' } }
    mainEntries = [...mainEntries, { kind: 'thread-card', sequence, occurredAt: message.occurredAt, card }]
    return { ok: true as const, value: { kind: 'committed' as const, receipt: {}, message, ...(task === undefined ? {} : { task }), thread, attention: [], directMarkers: [] } }
  })
  let changeVersion = 0
  let changeFailure: string | undefined
  const generationListeners = new Set<() => void>()
  const changeWaiters = new Set<{ request: AgentTeamChangesRequest; wake(): void }>()
  const changeWaiterRegistrations = new Set<() => void>()
  let changeRegistrations = 0
  let changeOpens = 0
  /**
   * Resolves once every `changes` stream that has opened has also parked —
   * registered its waiter and delivered the opening baseline. Until then a
   * publish can be consumed by a stream still opening and seen by nobody. A
   * spec awaiting this needs no sacrificial first publish: the badge's
   * subscription from mount is already parked, so the wait is usually a
   * no-op that returns after one microtask.
   */
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
  // One projection-domain wake shaped like a workspace commit: workspace and
  // scope-less projection waiters wake, presence waiters stay parked (the Host
  // only advances the presence epoch for presence scopes).
  const publishWorkspaceUpdate = (): void => {
    changeVersion += 1
    for (const waiter of changeWaiters) if (waiter.request.scope === undefined || waiter.request.scope.kind === 'workspace') waiter.wake()
  }
  // One projection wake whose narrow scopes match nothing this app subscribed
  // to — a commit in another Workspace: only the scope-less waiters wake.
  const publishGlobalUpdate = (): void => {
    changeVersion += 1
    for (const waiter of changeWaiters) if (waiter.request.scope === undefined) waiter.wake()
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
    const task = { taskRef: 'task:1', projectRef: 'project:engineering', threadRef: request.threadRef, status: 'todo', resolution: 'open' }
    const thread = { ...(top.thread as object), taskRef: task.taskRef, revision: request.baseRevision + 1 }
    const activity = { activityRef: 'activity:promoted', kind: 'promote' as const, taskRef: task.taskRef, threadRef: request.threadRef, actor: 'member:human', sequence: request.baseRevision + 1 }
    // A promoted Task is brand-new with no Claims, so the Host projects no owners.
    viewItems = viewItems.map(item => ({ ...item, task, thread, taskNumber: 1, liveClaimOwners: [] }))
    mainEntries = mainEntries.map(entry => entry.kind === 'thread-card' && (entry.card as { threadRef: string }).threadRef === request.threadRef
      ? { ...entry, card: { ...(entry.card as object), task: { taskRef: task.taskRef, taskNumber: 1, status: 'todo', resolution: 'open', liveClaimOwners: [] } } }
      : entry)
    wakeAll()
    return { ok: true as const, value: { kind: 'committed' as const, receipt: {}, activity, task, thread } }
  })
  // The Human Attention double keeps the follower set every observation read
  // answers from, so a follow or unfollow is visible on both faces of the Thread
  // the way the Host's own projection makes it visible.
  let attentionFailure: string | undefined
  const failAttention = (message?: string): void => { attentionFailure = message }
  // The Host's idempotency: a repeated requestId answers the result that request
  // first committed, rather than the state a fresh write would produce now. The
  // double has to honour that, or a Client bug that reuses an id after the
  // standing changed reads here as a success.
  const attentionByRequest = new Map<string, { readonly receipt: {}; readonly thread: { revision: number }; readonly attention?: unknown }>()
  const changeAttention = vi.fn(async (request: { requestId: string; workspaceId: string; threadRef?: string; taskRef?: string; action: 'follow' | 'unfollow' }) => {
    if (attentionFailure !== undefined) return { ok: false as const, error: { message: attentionFailure } }
    const replayed = attentionByRequest.get(request.requestId)
    if (replayed !== undefined) return { ok: true as const, value: replayed }
    const followed = threadFollowers.includes('member:human')
    if (request.action === 'follow' && !followed) threadFollowers.push('member:human')
    // Mutated in place: an observation read holds this same array, so a
    // reassignment here would leave the double answering from a stale copy.
    if (request.action === 'unfollow' && followed) threadFollowers.splice(0, threadFollowers.length, ...threadFollowers.filter(id => id !== 'member:human'))
    const topThread = viewItems[0]?.thread as { revision?: number } | undefined
    const thread = { ...(topThread as object), revision: topThread?.revision ?? 0 }
    wakeAll()
    // An Attention write is not a Thread revision: the Host's own result carries the Thread
    // unchanged, which is why the control's own state comes from the row and the re-read.
    const committed = {
      receipt: {}, thread,
      // Present after follow, absent after unfollow: the result's own answer to what happened.
      ...(request.action === 'follow' ? { attention: { threadRef: request.threadRef, taskRef: request.taskRef, memberId: 'member:human', action: 'follow' } } : {}),
    }
    attentionByRequest.set(request.requestId, committed)
    return { ok: true as const, value: committed }
  })
  // The Task transfer double answers one seeded outcome per call, so a spec drives the
  // committed, unread, stale, and failed branches without a second Host double.
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
    wakeAll()
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
    viewItems = viewItems.map(item => ({ ...item, task, thread, liveClaimOwners: [] }))
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
      readThroughSequence: (top.thread as { revision: number }).revision, remainingUnreadCount, consumedDirectMarkers: [], reminders: [],
    } }
  })
  const loadThreadHistory = vi.fn(async ({ taskRef, threadRef }: { taskRef?: string; threadRef?: string }) => {
    const top = viewItems.find(item => (threadRef !== undefined && (item.thread as { threadRef: string }).threadRef === threadRef)
      || (taskRef !== undefined && (item.task as { taskRef?: string } | undefined)?.taskRef === taskRef)) ?? viewItems[0]
    if (threadHistoryFailure !== undefined) return { ok: false as const, error: { message: threadHistoryFailure } }
    if (top === undefined) return { ok: false as const, error: { message: 'thread missing' } }
    return { ok: true as const, value: { task: top.task, thread: top.thread, anchor: top.message, anchorMentions: [], claims: viewClaims, facts: [], cursor: 0, hasMore: false } }
  })
  /** Sticky history-read failure: every read fails with this message until a spec clears it by passing undefined. */
  let threadHistoryFailure: string | undefined
  let taskBoardFailure: string | undefined
  // The Human author follows every seeded Thread; tests override the set to
  // drive the mention-candidate ranking. One follower set backs every observation
  // read, exactly as the Host projects one state rather than a per-read answer.
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
    // One Host-known Task lives outside the loaded project timeline, so the
    // click fallback path has something real to resolve.
    const known = new Map(viewItems.flatMap(item => {
      const taskRef = (item.task as { taskRef?: string } | undefined)?.taskRef
      return taskRef === undefined ? [] : [[taskRef, item] as const]
    }))
    known.set('task:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6c', {
      task: { taskRef: 'task:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6c', projectRef: 'project:engineering', threadRef: 'thread:9c1b02aa-5d3e-4f0a-8b7c-1e2d3f4a5b6d', status: 'todo', resolution: 'open' },
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
  // A `thread:` ref outside the loaded window resolves through the Host, which answers with the Thread's own Project —
  // the fact that decides whether a citation opens beside another Project's feed. One discussion is seeded in a sibling
  // Project so a cross-Project ref has something real to resolve.
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
  // Quoting a Message needs its author and gist, which only the Host can answer:
  // a quote target the Client has not resolved carries no `memberId`, so the
  // composer's notify row stays silent about a delivery that is really coming.
  // The double answers from the facts already loaded, like the Host does.
  const resolveMessageRefs = vi.fn(async (request: { workspaceId: string; messageRefs: readonly string[] }) => ({
    ok: true as const,
    value: { resolved: request.messageRefs.flatMap(messageRef => {
      const item = viewItems.find(candidate => (candidate.message as { messageRef?: string }).messageRef === messageRef)
      if (item === undefined) return []
      const message = item.message as { sender: string; body: string; threadRef: string }
      return [{ messageRef, threadRef: message.threadRef, sender: message.sender, excerpt: message.body.split('\n')[0]!.slice(0, 120) }]
    }) },
  }))
  // The Human Inbox double: rows are tagged per Workspace, and one call shape
  // serves every surface that reads the Inbox — the sidebar badge, the Inbox
  // page, and the Project feed's Thread entries. It returns the Host's two
  // slices: `items` is the unread queue (mentions inside it, not alone, so
  // `totalUnreadCount` is the badge number while `directCount` stays the row's
  // own mention count), and a row seeded with no unread stands for the
  // 「最近活跃」 tail the Host admits by participation instead.
  let inboxRows: Array<{ readonly workspaceId: string; readonly item: Record<string, unknown> }> = []
  // The Host's own verdict on the bounded unread queue; specs flip it to prove
  // the page discloses a capped page instead of reading as the whole queue.
  let inboxHasMore = false
  let mainInboxRows: Array<Record<string, unknown> & { readonly workspaceId: string }> = []
  const inbox = vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
    const scoped = inboxRows.filter(row => row.workspaceId === workspaceId)
    const holdsUnread = (row: { readonly item: Record<string, unknown> }): boolean => ((row.item as { unreadCount?: number }).unreadCount ?? 0) > 0
    const items = scoped.filter(holdsUnread).map(row => row.item)
    const recent = scoped.filter(row => !holdsUnread(row)).map(row => row.item)
    const main = mainInboxRows.filter(row => row.workspaceId === workspaceId)
    const unread = [...items, ...main].reduce((sum, item) => sum + ((item as { unreadCount?: number }).unreadCount ?? 0), 0)
    const direct = [...items, ...main].reduce((sum, item) => sum + ((item as { directCount?: number }).directCount ?? 0), 0)
    return { ok: true as const, value: { humanMemberId: 'member:human', items, main, recent, hasMore: inboxHasMore, totalUnreadCount: unread, totalDirectCount: direct } }
  })
  const seedInbox = (rows: ReadonlyArray<{ readonly workspaceId: string } & Record<string, unknown>>, options?: { readonly hasMore?: boolean }): void => {
    inboxRows = rows.map(row => ({ workspaceId: row.workspaceId, item: row as Record<string, unknown> }))
    inboxHasMore = options?.hasMore ?? false
    wakeAll()
  }
  const seedMainInbox = (rows: ReadonlyArray<Record<string, unknown> & { readonly workspaceId: string }>): void => {
    mainInboxRows = [...rows]
    wakeAll()
  }
  const loadTaskBoard = vi.fn(async ({ workspaceId, projectRef, finishedLimit }: { workspaceId: string; projectRef?: string; finishedLimit?: number }) => {
    // One card per Task, like the Host projection: a feed window may hold
    // several Messages of the same Task Thread, and the board keeps the
    // newest. The subject is the anchor's first line, as the Host bounds it.
    // The seeded facts live in w1 only, so the other Workspaces project no
    // rows — the global board reads every Workspace and must not double-count
    // one Workspace's Task into another's.
    if (taskBoardFailure !== undefined) return { ok: false as const, error: { message: taskBoardFailure } }
    if (workspaceId !== 'w1') return { ok: true as const, value: { humanMemberId: 'member:human', open: [], finished: [], finishedTruncated: false } }
    const byTask = new Map<string, Record<string, unknown>>()
    for (const item of viewItems) {
      const task = item.task as { taskRef: string; status: string } | undefined
      if (task === undefined) continue
      const thread = item.thread as { threadRef: string }
      const message = item.message as { body: string; sequence: number }
      byTask.set(task.taskRef, {
        workspaceId: 'w1', projectRef, projectName: 'engineering', task, taskNumber: item.taskNumber ?? 1,
        threadRef: thread.threadRef, subject: message.body.split('\n')[0]!.slice(0, 120), liveClaimOwners: item.liveClaimOwners,
        accountableOwner: { memberId: 'member:human', name: 'human' },
        lastActivitySequence: message.sequence, lastActivityAt: item.lastActivityAt,
        relation: 'project-owner', needsAcceptance: task.status === 'in_review',
      })
    }
    const items = [...byTask.values()] as Array<{ readonly task: { readonly status: string }; readonly lastActivitySequence: number }>
    const newestFirst = (left: typeof items[number], right: typeof items[number]) => right.lastActivitySequence - left.lastActivitySequence
    // The finished column honours the same per-Project page the Host applies, so a
    // spec that expands it is exercising the real contract rather than a stub that
    // always returns everything. The truncation signal is the Host's own answer,
    // never re-derived here from the page being full.
    const finished = items.filter(item => ['done', 'closed'].includes(item.task.status)).sort(newestFirst)
    const finishedLimitOrDefault = finishedLimit ?? 5
    return { ok: true as const, value: { humanMemberId: 'member:human', open: items.filter(item => !['done', 'closed'].includes(item.task.status)).sort(newestFirst),
      finished: finished.slice(0, finishedLimitOrDefault), finishedTruncated: finished.length > finishedLimitOrDefault } }
  })
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
    const liveClaimOwners = taskStatus === 'in_progress' || taskStatus === 'in_review'
      ? [{ memberId: 'member:builder', name: 'builder' }]
      : []
    viewItems = [{ ...top, messageCount: 2, lastActivityAt: activityAt, liveClaimOwners }, { ...top, messageCount: 2, lastActivityAt: activityAt, liveClaimOwners, message: { ...(top.message as object), messageRef: 'message:reply', sender: 'member:builder', body: 'agent reply', topLevel: false, sequence: 3, occurredAt: activityAt } }]
    viewActivities = [{ activityRef: 'activity:claim', taskRef: 'task:1', threadRef: 'thread:1', actor: 'member:builder', kind: 'claim', claimRef: 'claim:1', sequence: 4 }]
    wakeAll()
  }
  /** Simulates an externally driven project/membership commit reaching every workspace waiter. */
  const seedProject = (project: Record<string, unknown>) => { projects = [...projects, project] }
  const publishProjectUpdate = () => { wakeAll() }
  // The Human profile doubles: the profile page and every seat that names or
  // draws the Human read the same Remotes, and the Host writes the page makes
  // land in the same seeded value — so one rename visibly moves the page, the
  // timeline, and the member refs together.
  let humanProfileValue: { name: string; avatarRef?: string; version: string; repoUrl: string; latestVersion?: string } = {
    name: 'human',
    version: '0.1.13',
    repoUrl: 'https://github.com/Contexera/dsh-agent-team',
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
    const { version: _version, repoUrl: _repoUrl, latestVersion: _latestVersion, ...profile } = humanProfileValue
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
    agentTeam: { members, joinWorkspace, leaveWorkspace, addMember, view: viewProjects, inbox, taskBoard: loadTaskBoard, readThread, threadHistory: loadThreadHistory, threadObservations, putAttachment, getAttachment, createProject, updateProject, archiveProject, addProjectOwner, removeProjectOwner, updateMember, recoverMember, archiveMember, postMainMessage, startThread, readMainStream, mainStreamHistory, reply, changeTask, promoteThread, changeAttention, transferTask, resolveTaskRefs, resolveThreadRefs, resolveMessageRefs, changes, environment, humanProfile, setHumanProfile, putHumanAvatar, getHumanAvatar, removeHumanAvatar },
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
  // The shipped store keeps a selection only while a live `main` entry owns that
  // key, so a requested panel gets a stand-in entry of its own instead of a
  // dangling id no page backs. The selection itself is set here rather than at
  // runtime creation: it is the state a reload restores — the shipped plugin
  // page was open, and the persisted Team mode comes back with it — so it must
  // stand before the Team mounts and meets the mode's boot restore.
  if (options?.mainPanelId !== undefined) {
    runtime.slots.register({ name: 'main', key: options.mainPanelId }, (() => null) as never)
    runtime.panelInfo.set({ activePanelId: options.mainPanelId as never })
  }
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
  const failThreadHistory = (message?: string): void => { threadHistoryFailure = message }
  const failTaskBoard = (message?: string): void => { taskBoardFailure = message }
  return { runtime, team, view, seedMainInbox, loadTaskBoard, failTaskBoard, panelInfo: runtime.panelInfo, selectPanel, disposeWorkspace, disposeSettings, members, humanProfile, setHumanProfile, getHumanAvatar, putHumanAvatar, removeHumanAvatar, seedHumanProfile, failHumanProfile, failHumanProfileWrite, environment, seedEnvironment, failEnvironment, joinWorkspace, leaveWorkspace, addMember, status, viewProjects, createProject, updateProject, archiveProject, addProjectOwner, removeProjectOwner, failProjectOwnerWrite, putAttachment, getAttachment, updateMember, recoverMember, archiveMember, modelCatalog, postMainMessage, startThread, readMainStream, mainStreamHistory, requireMainRead, reply, changeTask, promoteThread, changeAttention, transferTask, failAttention, seedTransferOutcome, resolveTaskRefs, resolveThreadRefs, resolveMessageRefs, publishAgentReply, publishPresence, publishWorkspaceUpdate, publishGlobalUpdate, seedProject, publishProjectUpdate, failChanges, recoverChanges, readThread, loadThreadHistory, threadObservations, changes, inbox, seedInbox, openSession, failThreadHistory, changeSubscriptionsReady }
}
