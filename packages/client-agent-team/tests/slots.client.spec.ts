import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'

function workspaceFeed() {
  return {
    getSnapshot: () => ({ items: [{ workspaceId: 'workspace:one' as never, title: 'One', path: '/one', sessionIds: [], createdAt: '', updatedAt: '' }], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined }),
    subscribe: () => () => {},
  }
}

async function bench(persisted: string | null = null) {
  vi.stubGlobal('localStorage', {
    getItem: () => persisted,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('remote', { $mount: async () => async () => {} } as never)
  ctx.provide('remote.agentTeam', {})
  // rc.1: the client declares the model-catalog sub-namespace; the bench
  // supplies it so the takeover fiber is not left pending on inject.
  ctx.provide('remote.session', { modelCatalog: vi.fn(async () => ({ ok: true, value: { groups: [], failures: [] } })) })
  ctx.provide('conversation', { input: { for: () => ({ submit: vi.fn() }) } } as never)
  // The plugin declares these runtime services; the takeover bench only mounts
  // them, it never drives sessions or the model catalog.
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
    search: vi.fn(async () => ({ items: [], hasMore: false })),
    searchResultLimit: 20,
  } as never)
  const uiWorkspace = { openSession: vi.fn(), startSession: vi.fn(), connectWorkspace: vi.fn(async () => 'workspace:one') }
  ctx.provide('uiWorkspace', uiWorkspace as never)
  // The layout face behind ctx.layout: the plugin injects it to own the shell's
  // main panel, so the bench supplies panel selection plus the store the shipped
  // frame's usePanelInfo hook reads.
  let activePanelId: string | null = null
  const panelListeners = new Set<() => void>()
  const panelInfo = {
    getSnapshot: () => ({ activePanelId }),
    subscribe: (listener: () => void) => { panelListeners.add(listener); return () => { panelListeners.delete(listener) } },
  }
  const selectPanel = vi.fn((panelId: string | null): void => {
    activePanelId = panelId
    for (const listener of panelListeners) listener()
  })
  ctx.provide('layout', { toggleSidebar: vi.fn(), selectPanel, panelInfo } as never)
  ctx.provide('connection', { api: { llm: { models: vi.fn(async () => ({ result: { ok: true, value: { groups: [], failures: [] } } })) } } } as never)
  ctx.provide('workspaces', {
    list: workspaceFeed(),
    pickDirectory: vi.fn(async () => null),
    create: vi.fn(),
  } as never)
  const slots = ctx.get('slots') as SlotRegistry
  const root = () => null
  slots.register({ name: 'root', children: {
    sidebar: { kind: 'single', scope: 'root' },
    main: { kind: 'keyed', scope: 'root' },
  } } as never, root)
  slots.register({ name: 'sidebar', children: {
    'sidebar.workspaces': { kind: 'single', scope: 'root' },
    'sidebar.settings': { kind: 'single', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  } } as never, root)
  slots.register({ name: 'sidebar.workspaces', priority: 0 }, root)
  slots.register({ name: 'sidebar.settings', priority: 0 }, root)
  // The shipped Conversation occupies the keyed main panel under the reserved
  // 'conversation' key and declares the composer seats below it, mirroring
  // the 0.1.5 ui-layout + ui-conversation tree.
  slots.register({ name: 'main', key: 'conversation', priority: 0, children: {
    'main.conversation': { kind: 'single', scope: 'session-maybe' },
  } } as never, root)
  slots.register({ name: 'main.conversation', priority: 0, children: {
    'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
    'conversation.input.dock': { kind: 'list', scope: 'session' },
  } } as never, root)
  return { ctx, slots, uiWorkspace }
}

describe('Team Client slot takeover', () => {
  it('enters and leaves Team mode by shadowing and restoring the three primary seats', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    expect(slots.entriesOfSlot('sidebar.workspaces')).toHaveLength(1)
    // The Team panel's own main seat is registered for the life of the client,
    // beside the shipped conversation seat the mode shadows when it opens.
    expect(slots.entriesOfSlot('main')).toHaveLength(2)
    expect(slots.entriesOfSlot('sidebar.settings')).toHaveLength(1)
    expect(slots.entries('sidebar.panellist')).toHaveLength(1)

    ctx.teamNavigation.actions().enterTeam()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(2)
    expect(slots.entries('main')).toHaveLength(3)
    expect(slots.entries('sidebar.settings')).toHaveLength(2)
    expect(slots.entriesOfSlot('sidebar.workspaces')[0]!.options.priority).toBe(-100)
    expect(slots.spec('sidebar.workspaces.directoryFlow')).toBeUndefined()

    ctx.teamNavigation.actions().leaveTeam()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(1)
    expect(slots.entries('main')).toHaveLength(2)
    expect(slots.entries('sidebar.settings')).toHaveLength(1)

    await fiber.dispose()
    expect(slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(slots.spec('sidebar.workspaces.directoryFlow')).toBeUndefined()
  })

  it('fails loudly when another takeover claims a Team primary seat at the same priority', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    ctx.teamNavigation.actions().enterTeam()
    expect(() => slots.register({ name: 'main', key: 'conversation', priority: -100 }, () => null))
      .toThrow(/already has an (?:registration|entry).*priority -100/i)
  })

  it('repeats enter and leave without leaking shadows, then restores every shipped seat on unload', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (let index = 0; index < 3; index += 1) {
      ctx.teamNavigation.actions().enterTeam()
      expect(slots.entriesOfSlot('main')[0]!.options.priority).toBe(-100)
      ctx.teamNavigation.actions().leaveTeam()
      expect(slots.entries('sidebar.workspaces')).toHaveLength(1)
      expect(slots.entries('main')).toHaveLength(2)
      expect(slots.entries('sidebar.settings')).toHaveLength(1)
    }
    ctx.teamNavigation.actions().enterTeam()
    await fiber.dispose()
    expect(slots.entries('sidebar.workspaces')).toHaveLength(1)
    expect(slots.entries('main')).toHaveLength(1)
    expect(slots.entries('sidebar.settings')).toHaveLength(1)
    expect(slots.entries('sidebar.panellist')).toHaveLength(0)
  })

  it('mounts Team shadows immediately when persisted mode is Team', async () => {
    const { ctx, slots } = await bench(JSON.stringify({ mode: 'team', workspaceId: 'workspace:one' }))
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.teamNavigation.getSnapshot().mode).toBe('team')
    expect(slots.entries('main')).toHaveLength(3)
    await fiber.dispose()
    expect(slots.entries('main')).toHaveLength(1)
  })

  it('keeps Team chrome mounted for a Member Session view and restores the return session on leave', async () => {
    const { ctx, slots, uiWorkspace } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const sessions = ctx.get('sessions') as unknown as {
      list: { getSnapshot: () => { byId?: Record<string, unknown> } }
    }
    // The root restore owner reads the list snapshot's `mainView` retention
    // (the 0.1.7 selection projection) before rebinding, so the bench's list
    // double carries the selected row.
    sessions.list.getSnapshot = () => ({ byId: { 'session:human-origin': { id: 'session:human-origin', retainedBy: { mainView: 1 } } } })

    ctx.teamNavigation.actions().selectWorkspace('workspace:one' as never)
    ctx.teamNavigation.actions().enterTeam()

    // Drive the real wiring through the workspaces shadow's injected remotes —
    // the same payload the Agent card button consumes.
    const shadow = slots.entriesOfSlot('sidebar.workspaces').find(entry => entry.options.priority === -100)
    expect(shadow).toBeDefined()
    const injected = (shadow!.inject as () => Record<string, unknown>)()
    ;(injected.openMemberSession as (sessionId: string) => void)('session:builder')

    expect(uiWorkspace.openSession).toHaveBeenCalledWith('session:builder')
    expect(ctx.teamNavigation.getSnapshot()).toMatchObject({ mode: 'team', memberSessionId: 'session:builder', returnToSessionId: 'session:human-origin' })
    // The conversation shadow yields to the shipped root while both sidebars
    // stay; the panel's own seat is not the shadow and keeps its registration.
    expect(slots.entries('main')).toHaveLength(2)
    // The Member view registers no composer surface at all: the shipped
    // InputBar owns the bar, its trigger overlay, and the dock — the Team
    // chrome is sidebar-only around the embedded session.
    expect(slots.entries('conversation.composer.bar')).toHaveLength(0)
    expect(slots.entries('conversation.input.dock')).toHaveLength(0)
    // Direct Member-to-Member navigation keeps the zero-surface invariant.
    sessions.list.getSnapshot = () => ({ byId: { 'session:reviewer': { id: 'session:reviewer', retainedBy: { mainView: 1 } }, 'session:human-origin': {} } })
    ctx.teamNavigation.actions().enterMemberSession('session:reviewer' as never)
    expect(slots.entries('conversation.input.dock')).toHaveLength(0)
    expect(slots.entries('sidebar.workspaces')).toHaveLength(2)
    expect(slots.entriesOfSlot('sidebar.workspaces')[0]!.options.priority).toBe(-100)
    expect(slots.entriesOfSlot('sidebar.settings')[0]!.options.priority).toBe(-100)

    // The Team foot's wrapped leave closes the Member view, clears the panel,
    // and restores the Human's original session before deregistering the chrome.
    const foot = slots.entriesOfSlot('sidebar.settings').find(entry => entry.options.priority === -100)!
    const footActions = (foot.inject as () => Record<string, unknown>)()
    ;(footActions.leaveTeam as () => void)()

    expect(uiWorkspace.openSession).toHaveBeenLastCalledWith('session:human-origin')
    expect(ctx.teamNavigation.getSnapshot()).toEqual({ mode: 'conversation', workspaceId: 'workspace:one' })
    expect(slots.entries('conversation.input.dock')).toHaveLength(0)
    expect(slots.entriesOfSlot('main')).toHaveLength(2)
    expect(slots.entries('sidebar.workspaces')).toHaveLength(1)

    await fiber.dispose()
  })

  it('never captures a Member Session as the return target when the main view still retains one', async () => {
    const { ctx, slots, uiWorkspace } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const sessions = ctx.get('sessions') as unknown as {
      list: { getSnapshot: () => { byId?: Record<string, unknown> } }
    }
    ctx.teamNavigation.actions().selectWorkspace('workspace:one' as never)
    ctx.teamNavigation.actions().enterTeam()
    const shadow = slots.entriesOfSlot('sidebar.workspaces').find(entry => entry.options.priority === -100)
    const injected = (shadow!.inject as () => Record<string, unknown>)()

    // Nothing is retained yet, so this first entry has no return target at all.
    ;(injected.openMemberSession as (sessionId: string) => void)('session:builder')
    expect(uiWorkspace.openSession).toHaveBeenCalledWith('session:builder')
    expect(ctx.teamNavigation.getSnapshot()).toMatchObject({ mode: 'team', memberSessionId: 'session:builder' })
    expect(ctx.teamNavigation.getSnapshot().returnToSessionId).toBeUndefined()

    // The workspace service retains the Member's session, and leaving the view
    // restores nothing (there was no return target), so the retention stays on
    // the departed Member — the state the next entry must not read as the
    // Human's own conversation.
    sessions.list.getSnapshot = () => ({ byId: { 'session:builder': { id: 'session:builder', retainedBy: { mainView: 1 } } } })
    ctx.teamNavigation.actions().exitMemberSession()
    expect(uiWorkspace.openSession).toHaveBeenCalledTimes(1)

    // A second Member entry therefore captures no return target: returning into
    // another Member's session would strand the Human one view deeper instead
    // of back at their own conversation.
    ;(injected.openMemberSession as (sessionId: string) => void)('session:reviewer')
    expect(ctx.teamNavigation.getSnapshot()).toMatchObject({ mode: 'team', memberSessionId: 'session:reviewer' })
    expect(ctx.teamNavigation.getSnapshot().returnToSessionId).toBeUndefined()
    expect(uiWorkspace.openSession).toHaveBeenLastCalledWith('session:reviewer')

    await fiber.dispose()
  })

  it('exits an embedded Member Session view when explicit Team navigation arrives', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    ctx.teamNavigation.actions().enterTeam()
    ctx.teamNavigation.actions().enterMemberSession('session:builder' as never, 'session:return' as never)
    expect(slots.entries('main')).toHaveLength(2)

    ctx.teamNavigation.actions().selectChannel('channel:engineering' as never)
    expect(ctx.teamNavigation.getSnapshot().memberSessionId).toBeUndefined()
    expect(slots.entries('main')).toHaveLength(3)

    await fiber.dispose()
  })
})
