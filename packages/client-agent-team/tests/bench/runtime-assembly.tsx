import { useState } from 'react'
import { vi } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { COMMON_NS, LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn, zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/index.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SlotTestRuntime, contextMenuHook, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as applySidebar, inject as injectSidebar } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { apply as applyConversation, inject as injectConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'

type FrameProps = PropsRuntime<'root'> & PropsRenderSlots<'sidebar' | 'main'>
function Frame({ renderSlot, usePanelInfo }: FrameProps) {
  const [collapsed, setCollapsed] = useState(false)
  // The shipped frame renders the keyed main cell for the selected global panel
  // and falls back to the conversation seat, so the bench follows the same rule
  // instead of pinning that seat.
  const panelId = usePanelInfo(info => info.activePanelId)
  return <>
    <button type="button" data-test-control onClick={() => { setCollapsed(value => !value) }}>Toggle fixture sidebar</button>
    {/* The bench never opens drawer mode: no Team surface reads that owner share. */}
    {renderSlot('sidebar', { collapsed, width: collapsed ? 56 : 280, drawer: false })}
    {renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })}
  </>
}

function BaselineWorkspace() { return <div data-baseline-workspaces>普通工作区</div> }
function BaselineSettings() { return <div data-baseline-settings>设置</div> }

export async function createBenchRuntime(
  onCreated: (runtime: SlotTestRuntime) => void,
) {
  const runtime = await SlotTestRuntime.create()
  onCreated(runtime)

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
  const teamConfigForm = configFormFor('contexera-agent-team-host')
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

  return {
    runtime,
    selectPanel,
    openSession,
    mountShell: async <T,>(
      connection: ConstructorParameters<typeof RemoteStream>[0],
      mainPanelId: string | undefined,
      mountTeam: () => Promise<T>,
    ) => {
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
      if (mainPanelId !== undefined) {
        runtime.slots.register({ name: 'main', key: mainPanelId }, (() => null) as never)
        runtime.panelInfo.set({ activePanelId: mainPanelId as never })
      }
      await runtime.mount({ inject: [...injectSidebar], apply: applySidebar })
      runtime.slots.provideRoot({ props: { useContextMenu: contextMenuHook() } })
      await runtime.mount({ inject: [...injectConversation], apply: applyConversation })
      const disposeWorkspace = runtime.slots.register({ name: 'sidebar.workspaces', priority: 0 }, BaselineWorkspace as never)
      const disposeSettings = runtime.slots.register({ name: 'sidebar.settings', priority: 0 }, BaselineSettings as never)
      const team = await mountTeam()
      const view = runtime.renderRoot()
      return { team, view, disposeWorkspace, disposeSettings }
    },
  }
}
