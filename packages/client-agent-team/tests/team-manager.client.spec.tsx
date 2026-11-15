// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

function mainViewSessionId(b: Awaited<ReturnType<typeof runtimeWithTeam>>): string | undefined {
  return Object.values(b.runtime.sessions.list.getSnapshot().byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

describe('Team manager Session entry', () => {
  it('resolves the Host id before yielding to shipped Conversation and restores the ordinary Session on Team navigation', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    const entry = b.view.getByRole('button', { name: '团队管理' })
    fireEvent.click(entry)

    await waitFor(() => { expect(b.openSession).toHaveBeenCalledWith('manager-session') })
    await waitFor(() => { expect(b.view.container.querySelector('[data-phase]')).toBeTruthy() })
    expect(b.managerSession).toHaveBeenCalledWith({})
    expect(b.runtime.ctx.teamNavigation.getSnapshot()).toMatchObject({ manager: true, managerSessionId: 'manager-session' })
    expect(entry.getAttribute('aria-current')).toBe('page')
    expect(b.view.container.querySelector('[data-team-manager-gate]')).toBeNull()

    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-project]')).toBeTruthy() })
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    expect(b.runtime.ctx.teamNavigation.getSnapshot().manager).toBeUndefined()
    await b.runtime.dispose()
  })

  it('shows a diagnostic and retries without exposing a sendable blank Team composer', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.managerSession.mockResolvedValueOnce({ ok: true, value: {
      status: 'unavailable', diagnostic: { class: 'session-refused', detail: 'damaged manager log' },
    } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '团队管理' }))

    expect((await b.view.findByRole('alert')).textContent).toContain('damaged manager log')
    expect(b.view.container.querySelector('[data-team-manager-gate]')).toBeTruthy()
    expect(b.view.queryByRole('textbox', { name: '消息内容' })).toBeNull()
    expect(b.openSession).not.toHaveBeenCalledWith('manager-session')

    fireEvent.click(b.view.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-phase]')).toBeTruthy() })
    expect(b.managerSession).toHaveBeenCalledTimes(2)
    expect(b.openSession).toHaveBeenCalledWith('manager-session')
    await act(async () => { await new Promise(finish => requestAnimationFrame(() => { finish(undefined) })) })
    expect(document.activeElement).toBe(document.querySelector('[data-composer-input][contenteditable="true"]'))
    await b.runtime.dispose()
  })

  it('drops a late resolution after the reader leaves the manager destination', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    let settle!: (value: unknown) => void
    const pending = new Promise(resolve => { settle = resolve })
    b.managerSession.mockReturnValueOnce(pending as never)
    fireEvent.click(b.view.getByRole('button', { name: '团队管理' }))
    expect(await b.view.findByRole('status')).toBeTruthy()

    fireEvent.click(b.view.getByRole('button', { name: /^收件箱/ }))
    settle({ ok: true, value: { status: 'ready', sessionId: 'manager-session', workspaceId: 'w1' } })
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-inbox]')).toBeTruthy() })
    await new Promise(finish => setTimeout(finish, 0))
    expect(b.openSession).not.toHaveBeenCalledWith('manager-session')
    expect(b.runtime.ctx.teamNavigation.getSnapshot()).toMatchObject({ inbox: true })
    expect(b.runtime.ctx.teamNavigation.getSnapshot().manager).toBeUndefined()
    await b.runtime.dispose()
  })

  it('cold-restores the manager token without selecting the Team rail and starts a replacement conversation', async () => {
    const b = await runtimeWithTeam({ mode: 'team', manager: true, workspaceId: 'w1' })
    await waitFor(() => { expect(b.openSession).toHaveBeenCalledWith('manager-session') })
    await waitFor(() => { expect(b.view.container.querySelector('[data-phase]')).toBeTruthy() })
    expect(b.runtime.ctx.teamNavigation.getSnapshot().manager).toBe(true)
    expect(b.panelInfo.getSnapshot().activePanelId).toBeNull()

    fireEvent.click(await b.view.findByRole('button', { name: '新开对话' }))
    await waitFor(() => { expect(b.openSession).toHaveBeenCalledWith('manager-session-2') })
    expect(b.newManagerSession).toHaveBeenCalledWith({ expectedSessionId: 'manager-session' })
    expect(b.runtime.ctx.teamNavigation.getSnapshot().managerSessionId).toBe('manager-session-2')
    await waitFor(() => {
      expect(b.runtime.slots.entriesOfSlot('conversation.hero.agentPreset').map(entry => entry.options.priority)).toEqual([-200])
      expect(b.runtime.slots.entriesOfSlot('conversation.input.permission').map(entry => entry.options.priority)).toEqual([-200])
      expect(b.runtime.slots.entriesOfSlot('conversation.session.header.actions').map(entry => entry.options.id)).toEqual(['agent-preset'])
    })

    b.selectPanel('agent-team')
    await waitFor(() => { expect(b.runtime.ctx.teamNavigation.getSnapshot().manager).toBeUndefined() })
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    await waitFor(() => {
      expect(b.runtime.slots.entriesOfSlot('conversation.hero.agentPreset')).toHaveLength(1)
      expect(b.runtime.slots.entriesOfSlot('conversation.input.permission')).toHaveLength(1)
      expect(b.runtime.slots.entriesOfSlot('conversation.session.header.actions')).toHaveLength(1)
    })
    await b.runtime.dispose()
  })

  it('cold-restores an ordinary return target when the shell had already selected the manager', async () => {
    const b = await runtimeWithTeam({ mode: 'team', manager: true, managerCurrent: true, workspaceId: 'w1' })
    await waitFor(() => { expect(b.view.container.querySelector('[data-phase]')).toBeTruthy() })
    expect(b.runtime.ctx.teamNavigation.getSnapshot()).toMatchObject({
      manager: true, managerSessionId: 'manager-session', returnToSessionId: 'ordinary-session',
    })

    b.selectPanel('agent-team')
    await waitFor(() => { expect(mainViewSessionId(b)).toBe('ordinary-session') })
    expect(b.runtime.ctx.teamNavigation.getSnapshot().manager).toBeUndefined()
    await b.runtime.dispose()
  })

  it('replaces preset chrome for retired manager history and restores it for an ordinary Session', async () => {
    const b = await runtimeWithTeam({ workspaceId: 'w1' })
    b.sessionOwnership.mockImplementation(async ({ sessionIds }: { sessionIds: readonly string[] }) => ({
      ok: true as const,
      value: sessionIds.filter(id => id === 'manager-session-2').map(id => ({ sessionId: id, kind: 'manager' as const })),
    }))
    b.openSession('manager-session-2')
    await waitFor(() => {
      expect(b.runtime.slots.entriesOfSlot('conversation.hero.agentPreset').map(entry => entry.options.priority)).toEqual([-200])
      expect(b.runtime.slots.entriesOfSlot('conversation.input.permission').map(entry => entry.options.priority)).toEqual([-200])
    })
    expect(b.view.queryByRole('button', { name: '新开对话' })).toBeNull()

    b.openSession('ordinary-session')
    await waitFor(() => {
      expect(b.runtime.slots.entriesOfSlot('conversation.hero.agentPreset')).toHaveLength(1)
      expect(b.runtime.slots.entriesOfSlot('conversation.input.permission')).toHaveLength(1)
      expect(b.runtime.slots.entriesOfSlot('conversation.session.header.actions')).toHaveLength(1)
    })
    await b.runtime.dispose()
  })

  it('does not reuse a blank manager when its ordinary return target has disappeared', async () => {
    const b = await runtimeWithTeam({ mode: 'team', manager: true, workspaceId: 'w1' })
    await waitFor(() => { expect(b.view.container.querySelector('[data-phase]')).toBeTruthy() })
    await b.runtime.sessions.remove('ordinary-session')

    b.selectPanel('agent-team')
    await waitFor(() => { expect(b.startSession).toHaveBeenCalledWith() })
    await b.runtime.dispose()
  })

  it('drops only a Team-owned implicit-preset blank at the Session Controller boundary', async () => {
    const b = await runtimeWithTeam({ mode: 'team', manager: true, managerCurrent: true, workspaceId: 'w1' })
    const create = b.runtime.sessions.create.bind(b.runtime.sessions)
    const calls: unknown[] = []
    b.runtime.sessions.stubCreate(async options => {
      calls.push(options)
      return 'ordinary-session' as never
    })
    await b.runtime.sessions.list.update(draft => {
      const manager = draft.byId['manager-session' as never]
      if (manager !== undefined) manager.blank = true
    })
    await expect(create({ workspaceId: 'w1' as never, sessionId: 'manager-session' as never }))
      .resolves.toBe('ordinary-session')
    expect(calls).toEqual([{ workspaceId: 'w1' }])

    await expect(create({ workspaceId: 'w1' as never, sessionId: 'manager-session' as never, agentPreset: 'custom' }))
      .resolves.toBe('ordinary-session')
    expect(calls.at(-1)).toEqual({ workspaceId: 'w1', sessionId: 'manager-session', agentPreset: 'custom' })

    await b.runtime.sessions.list.update(draft => {
      const ordinary = draft.byId['ordinary-session' as never]
      if (ordinary !== undefined) ordinary.blank = true
    })
    await expect(create({ workspaceId: 'w1' as never, sessionId: 'ordinary-session' as never }))
      .resolves.toBe('ordinary-session')
    expect(calls.at(-1)).toEqual({ workspaceId: 'w1', sessionId: 'ordinary-session' })
    await b.runtime.dispose()
  })

  it('fails closed when Team ownership cannot be read', async () => {
    const b = await runtimeWithTeam({ mode: 'team', manager: true, managerCurrent: true, workspaceId: 'w1' })
    b.sessionOwnership.mockResolvedValueOnce({ ok: false, error: { message: 'ownership unavailable' } } as never)
    await b.runtime.sessions.list.update(draft => {
      const manager = draft.byId['manager-session' as never]
      if (manager !== undefined) manager.blank = true
    })
    const create = vi.fn()
    b.runtime.sessions.stubCreate(create)
    await expect(b.runtime.sessions.create({ workspaceId: 'w1' as never, sessionId: 'manager-session' as never }))
      .rejects.toThrow('ownership unavailable')
    expect(create).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })

  it('settles a pending ownership check when the Team plugin is disposed without creating a Session', async () => {
    const b = await runtimeWithTeam({ mode: 'team', manager: true, managerCurrent: true, workspaceId: 'w1' })
    await b.runtime.sessions.list.update(draft => {
      const manager = draft.byId['manager-session' as never]
      if (manager !== undefined) manager.blank = true
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    b.sessionOwnership.mockImplementationOnce(async () => {
      await gate
      return { ok: true, value: [{ sessionId: 'manager-session' as never, kind: 'manager' as const }] }
    })
    const create = vi.fn()
    b.runtime.sessions.stubCreate(create)
    const guarded = b.runtime.sessions.create
    let settled: string | undefined
    void guarded({ workspaceId: 'w1' as never, sessionId: 'manager-session' as never }).then(
      () => { settled = 'created' },
      (error: Error) => { settled = error.message },
    )
    await b.runtime.dispose()
    release()
    await waitFor(() => { expect(settled).toBe('会话创建已中断，请重试') })
    expect(create).not.toHaveBeenCalled()
    expect(b.runtime.sessions.create).not.toBe(guarded)
  })

  it('auto-dismisses a failed new-conversation Toast and restores the enabled action', async () => {
    vi.useFakeTimers()
    try {
      const b = await runtimeWithTeam({ mode: 'team', manager: true, workspaceId: 'w1' })
      await act(async () => { await Promise.resolve() })
      b.newManagerSession.mockResolvedValueOnce({ ok: false, error: { message: 'new conversation unavailable' } } as never)
      fireEvent.click(b.view.getByRole('button', { name: '新开对话' }))
      await act(async () => { await Promise.resolve() })
      expect(b.view.getByRole('alert').textContent).toContain('new conversation unavailable')
      expect(b.view.getByRole('button', { name: '新开对话' }).hasAttribute('disabled')).toBe(false)
      act(() => { vi.advanceTimersByTime(6999) })
      expect(b.view.queryByRole('alert')).not.toBeNull()
      act(() => { vi.advanceTimersByTime(1) })
      expect(b.view.queryByRole('alert')).toBeNull()
      await b.runtime.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes a fresh catalog pull when reload left the joined pull without the manager', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await b.runtime.sessions.remove('manager-session')
    const refresh = vi.spyOn(b.runtime.sessions, 'refresh')
    refresh.mockImplementationOnce(async () => {})
    refresh.mockImplementationOnce(async () => {
      await b.runtime.sessions.add({ id: 'manager-session', summary: { title: '团队管理', cwd: '/work/alpha' } })
    })
    const unknown = (): never => { throw new Error('sessions.retain: unknown session manager-session') }
    b.openSession.mockImplementationOnce(unknown).mockImplementationOnce(unknown)

    fireEvent.click(b.view.getByRole('button', { name: '团队管理' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-phase]')).toBeTruthy() })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(b.openSession).toHaveBeenCalledTimes(3)
    expect(b.runtime.ctx.teamNavigation.getSnapshot().managerSessionId).toBe('manager-session')
    await b.runtime.dispose()
  })

  it('uses the shipped no-Workspace flow and keeps the collapsed rail entry available', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.managerSession.mockResolvedValueOnce({ ok: true, value: { status: 'no-workspace' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: 'Toggle fixture sidebar' }))
    const entry = await b.view.findByRole('button', { name: '团队管理' })
    fireEvent.click(entry)

    await waitFor(() => { expect(b.startSession).toHaveBeenCalled() })
    expect(b.runtime.ctx.teamNavigation.getSnapshot()).toMatchObject({ mode: 'conversation' })
    expect(b.runtime.ctx.teamNavigation.getSnapshot().manager).toBeUndefined()
    expect(b.openSession).not.toHaveBeenCalledWith('manager-session')
    await b.runtime.dispose()
  })
})
