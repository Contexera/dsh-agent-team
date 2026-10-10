// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

/** 0.1.7 selection read: the conversation follows the session holding the workspace service's `mainView` reference. */
function mainViewSessionId(b: Awaited<ReturnType<typeof runtimeWithTeam>>): string | undefined {
  return Object.values(b.runtime.sessions.list.getSnapshot().byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
}

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('Team agent surfaces', () => {
  it('imports a global Member without copying it, retries the same join, and withdraws only here', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w2' })
    await b.view.findByText('builder')
    const trigger = b.view.getByRole('button', { name: '添加 Agent' })
    fireEvent.click(trigger)
    fireEvent.click(b.view.getByRole('button', { name: '从其他 Workspace 引入' }))
    const dialog = await b.view.findByRole('dialog', { name: '添加 Agent' })
    const worker = (await within(dialog).findByText('@worker')).closest('[data-team-member-row]') as HTMLElement
    expect(within(dialog).getAllByRole('button', { name: '引入' })).toHaveLength(4)
    const held = Promise.withResolvers<Awaited<ReturnType<typeof b.joinWorkspace>>>()
    b.joinWorkspace.mockReturnValueOnce(held.promise)
    fireEvent.click(within(worker).getByRole('button', { name: '引入' }))
    expect(within(worker).getByRole('button', { name: '引入中…' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.view.getByRole('dialog', { name: '添加 Agent' })).toBeTruthy()
    held.resolve({ ok: false, error: { message: 'join connection lost' } } as never)
    expect((await within(dialog).findByRole('alert')).textContent).toContain('join connection lost')
    fireEvent.click(within(worker).getByRole('button', { name: '引入' }))
    await waitFor(() => expect(b.view.queryByRole('dialog')).toBeNull())
    expect(await b.view.findByText('worker')).toBeTruthy()
    expect(b.joinWorkspace).toHaveBeenLastCalledWith(expect.objectContaining({ memberId: 'member:worker', workspaceId: 'w2' }))
    expect(b.joinWorkspace.mock.calls[0]![0]).toEqual(b.joinWorkspace.mock.calls[1]![0])
    expect(b.addMember).not.toHaveBeenCalled()
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    fireEvent.click(b.view.getByRole('button', { name: 'worker 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '从此 Workspace 撤回' }))
    const confirmation = await b.view.findByRole('dialog', { name: '撤回 worker？' })
    expect(confirmation.textContent).toContain('其他 Workspace 的工作')
    expect(b.leaveWorkspace).not.toHaveBeenCalled()
    fireEvent.click(within(confirmation).getByRole('button', { name: '从此 Workspace 撤回' }))
    await waitFor(() => expect(b.view.queryByText('worker')).toBeNull())
    expect(b.leaveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'member:worker', workspaceId: 'w2' }))
    expect(b.archiveMember).not.toHaveBeenCalled()
    expect((await b.members({ workspaceId: 'w1' })).value.some(row => row.member.memberId === 'member:worker')).toBe(true)
    await b.runtime.dispose()
  })

  it('shows import loading, read failure with retry, and a truthful empty state', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await b.view.findByText('builder')
    // Suspended Members are importable too: joining does not depend on
    // availability. The import roster shows them with their paused state.
    fireEvent.click(b.view.getByRole('button', { name: '添加 Agent' }))
    const suspended = { ...b.status('member:paused', 'w2', 'paused', 'unavailable'), workspaceIds: ['w2'] }
    Object.assign(suspended.member, { state: 'suspended' })
    b.members.mockResolvedValueOnce({ ok: true, value: [suspended] } as never)
    fireEvent.click(b.view.getByRole('button', { name: '从其他 Workspace 引入' }))
    const dialog = b.view.getByRole('dialog', { name: '添加 Agent' })
    expect(await within(dialog).findByText('@paused')).toBeTruthy()
    // The failure line replaces the roster without masquerading as empty.
    const held = Promise.withResolvers<Awaited<ReturnType<typeof b.members>>>()
    b.members.mockReturnValueOnce(held.promise)
    fireEvent.click(within(dialog).getByRole('button', { name: '创建 Agent' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '从其他 Workspace 引入' }))
    held.resolve({ ok: false, error: { message: 'catalog offline' } } as never)
    expect((await within(dialog).findByRole('alert')).textContent).toContain('catalog offline')
    expect(within(dialog).queryByText('没有可引入的 Agent。')).toBeNull()
    // Retry issues a fresh read: an empty catalog renders the true empty state.
    b.members.mockResolvedValueOnce({ ok: true, value: [] })
    fireEvent.click(within(dialog).getByRole('button', { name: '重试' }))
    expect(await within(dialog).findByText('没有可引入的 Agent。')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(b.view.queryByRole('dialog')).toBeNull())
    await b.runtime.dispose()
  })

  it('warns about other participations before global archive and preserves the dialog on failure', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await b.joinWorkspace({ memberId: 'member:worker', workspaceId: 'w2' })
    await b.view.findByText('worker')
    fireEvent.click(b.view.getByRole('button', { name: 'worker 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档' }))
    const dialog = await b.view.findByRole('dialog', { name: '归档 Agent：worker' })
    expect(dialog.textContent).toContain('其他 1 个 Workspace')
    b.archiveMember.mockResolvedValueOnce({ ok: false, error: { message: 'archive offline' } } as never)
    fireEvent.click(within(dialog).getByRole('button', { name: '归档' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('archive offline')
    fireEvent.click(within(dialog).getByRole('button', { name: '归档' }))
    await waitFor(() => expect(b.view.queryByText('worker')).toBeNull())
    expect(b.archiveMember.mock.calls[0]![0]).toEqual(b.archiveMember.mock.calls[1]![0])
    expect(b.leaveWorkspace).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })

  it('renders agent rows draggable with the saved personal order folded in', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    await waitFor(() => expect(b.view.container.querySelectorAll('[draggable="true"]').length).toBeGreaterThanOrEqual(4))
    const rows = b.view.container.querySelectorAll('[draggable="true"]')
    for (const row of rows) expect(row.querySelector('[class*="agentSelect"]')).not.toBeNull()
    await b.runtime.dispose()
  })

  it('enters Team with existing Workspaces and restores the shipped seats', async () => {
    const b = await runtimeWithTeam()
    expect(b.view.getByText('普通工作区')).toBeTruthy()
    // The conversation seat carries the shipped ConversationRoot; its
    // resident [data-composer-seat] node stands in for the old baseline text.
    expect(b.view.container.querySelector('[data-composer-seat]')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await waitFor(() => expect(document.documentElement.dataset.agentTeamMode).toBe('team'))
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    expect(await b.view.findByRole('heading', { name: '频道' })).toBeTruthy()
    expect(b.view.getAllByText('Alpha')).toHaveLength(2)
    expect(b.view.queryByText('设置')).toBeNull()
    const membersTrigger = b.view.getByRole('button', { name: '成员' })
    const delayedMembers = Promise.withResolvers<Awaited<ReturnType<typeof b.members>>>()
    b.members.mockReturnValueOnce(delayedMembers.promise)
    fireEvent.click(membersTrigger)
    const membersDialog = await b.view.findByRole('dialog', { name: '成员' })
    expect(within(membersDialog).getByRole('status').textContent).toContain('正在加载 Agent')
    delayedMembers.resolve({ ok: true, value: [b.status('member:builder', 'w1', 'builder', 'available')] } as never)
    await waitFor(() => expect(within(membersDialog).getAllByText('@builder')).toHaveLength(2))
    expect(within(membersDialog).getByText('Alpha')).toBeTruthy()
    expect(within(membersDialog).getByText('Beta')).toBeTruthy()
    const membersContent = membersDialog.querySelector('[tabindex="-1"]')
    await waitFor(() => expect(document.activeElement).toBe(membersContent))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.view.queryByRole('dialog', { name: '成员' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(membersTrigger))
    b.members.mockRejectedValueOnce(new Error('members transport failed'))
    fireEvent.click(membersTrigger)
    expect((await b.view.findByRole('alert')).textContent).toContain('members transport failed')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(membersTrigger))

    fireEvent.click(b.view.getByRole('button', { name: '对话' }))
    await waitFor(() => expect(document.documentElement.dataset.agentTeamMode).toBeUndefined())
    expect(await b.view.findByText('普通工作区')).toBeTruthy()
    expect(b.view.container.querySelector('[data-composer-seat]')).toBeTruthy()
    expect(await b.view.findByText('设置')).toBeTruthy()
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    await b.runtime.dispose()
  })

  it('loads Workspace Agents and creates a durable Member without optimistic rows', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('从左侧选择一个频道开始协作')).toBeTruthy()

    expect(await b.view.findByText('builder')).toBeTruthy()
    expect(b.view.getByRole('img', { name: '可用' })).toBeTruthy()
    expect(b.view.getByRole('img', { name: '工作中' })).toBeTruthy()
    expect(b.view.getByRole('img', { name: '错误: model failed' })).toBeTruthy()
    expect(b.view.getByRole('img', { name: '不可用: preset missing' })).toBeTruthy()
    expect(b.members).toHaveBeenCalledWith({ workspaceId: 'w1' })

    const addAgentTrigger = b.view.getByRole('button', { name: '添加 Agent' })
    fireEvent.click(addAgentTrigger)
    expect(b.view.getByRole('dialog', { name: '添加 Agent' })).toBeTruthy()
    const agentName = b.view.getByLabelText('名称')
    await waitFor(() => expect(document.activeElement).toBe(agentName))
    fireEvent.change(agentName, { target: { value: 'reviewer' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'Reviews changes' } })
    // Creation has no Channel page: the Member joins Channels later from the
    // Channel side and stays reachable through its DM view meanwhile.
    expect(b.view.queryByRole('button', { name: /初始频道/ })).toBeNull()
    b.addMember.mockResolvedValueOnce({ ok: false, error: { message: 'connection lost' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '创建 Agent' }))
    expect((await b.view.findByRole('alert')).textContent).toContain('connection lost')
    expect((b.view.getByLabelText('名称') as HTMLInputElement).value).toBe('reviewer')
    expect(b.view.queryByText('reviewer')).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: '创建 Agent' }))

    expect(await b.view.findByText('reviewer')).toBeTruthy()
    expect(b.addMember).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'w1', channelRefs: [], handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member',
    }))
    expect(b.addMember.mock.calls[0]![0].requestId).toBe(b.addMember.mock.calls[1]![0].requestId)
    await waitFor(() => expect(document.activeElement).toBe(addAgentTrigger))
    fireEvent.click(addAgentTrigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.view.queryByRole('dialog', { name: '添加 Agent' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(addAgentTrigger))
    await b.runtime.dispose()
  })

  it('creates an Agent with empty description, no Channels, and an optional model', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')
    fireEvent.click(b.view.getByRole('button', { name: '添加 Agent' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'bare' } })
    // Description stays optional; the hint shows an example instead of saying so.
    expect(b.view.getByPlaceholderText('例如：负责后端接口与数据模型')).toBeTruthy()
    // Pick a model through the capped menu; pinning reveals the effort row.
    fireEvent.click(await b.view.findByRole('button', { name: '模型' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: 'DeepSeek Chat' }))
    fireEvent.click(b.view.getByRole('button', { name: /推理强度/ }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: 'high' }))
    // No Channel picker exists at creation; Channels join later from the Channel side.
    expect(b.view.queryByText('选择初始频道')).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: '创建 Agent' }))
    expect(await b.view.findByText('bare')).toBeTruthy()
    expect(b.addMember).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'w1', handle: 'bare', description: '', presetId: 'team-member', channelRefs: [],
      model: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' },
    }))
    await b.runtime.dispose()
  })

  it('creates a Channel atomically with selected available Members and manages committed membership', async () => {
    const b = await runtimeWithTeam()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('还没有频道')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '新建频道' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'API implementation' } })
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    const unavailable = await within(document.body).findByRole('menuitem', { name: /offline/ }) as HTMLButtonElement
    expect(unavailable.disabled).toBe(true)
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    b.createChannel.mockResolvedValueOnce({ ok: false, error: { message: 'connection lost' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))
    expect((await b.view.findByRole('alert')).textContent).toContain('connection lost')
    fireEvent.click(b.view.getByRole('button', { name: '创建频道' }))

    expect(await b.view.findByText('# backend')).toBeTruthy()
    expect(b.createChannel).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'w1', name: 'backend', description: 'API implementation', memberIds: ['member:builder'],
    }))
    expect(b.createChannel.mock.calls[0]![0].requestId).toBe(b.createChannel.mock.calls[1]![0].requestId)
    fireEvent.click(b.view.getByRole('button', { name: '# backend' }))
    fireEvent.click(await b.view.findByRole('button', { name: '管理成员' }))
    const manager = b.view.getByRole('dialog', { name: '频道成员' })
    expect(within(manager).getByText('@builder')).toBeTruthy()
    fireEvent.click(within(manager).getByRole('button', { name: '移除' }))
    await waitFor(() => { expect(b.removeChannelMember).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'member:builder' })) })
    await b.runtime.dispose()
  })

  it('edits Channel membership from the sidebar row menu with idempotent retries', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('# engineering')).toBeTruthy()

    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑频道' }))
    const editor = b.view.getByRole('dialog', { name: '编辑频道' })
    expect(within(editor).getByText('@builder')).toBeTruthy()
    // The fixture starts with an empty membership: builder's row offers Add.
    const builderRow = within(editor).getByText('@builder').closest('div') as HTMLElement
    expect(within(builderRow).getByRole('button', { name: '添加' })).toBeTruthy()
    // Offline members cannot join from here; their row stays disabled.
    const offlineRow = within(editor).getByText('@offline').closest('div') as HTMLElement
    expect((within(offlineRow).getByRole('button', { name: '添加' }) as HTMLButtonElement).disabled).toBe(true)

    b.joinChannel.mockResolvedValueOnce({ ok: false, error: { message: 'membership failed' } } as never)
    fireEvent.click(within(builderRow).getByRole('button', { name: '添加' }))
    expect(within(builderRow).getByRole('button', { name: '更新中…' })).toBeTruthy()
    expect((await within(builderRow).findByRole('alert')).textContent).toContain('membership failed')
    fireEvent.click(within(builderRow).getByRole('button', { name: '添加' }))
    await waitFor(() => { expect(b.joinChannel).toHaveBeenCalledTimes(2) })
    // The retry reuses the committed direction's request id until success.
    expect(b.joinChannel.mock.calls[0]![0].requestId).toBe(b.joinChannel.mock.calls[1]![0].requestId)
    await waitFor(() => { expect(within(builderRow).getByRole('button', { name: '移除' })).toBeTruthy() })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.view.queryByRole('dialog', { name: '编辑频道' })).toBeNull()
    await b.runtime.dispose()
  })

  it('renames Channel display facts from the editor and refreshes the row', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('# engineering')).toBeTruthy()

    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑频道' }))
    const editor = b.view.getByRole('dialog', { name: '编辑频道' })
    // Save stays disabled until something actually changes.
    expect(((within(editor).getByRole('button', { name: '保存' }) as HTMLButtonElement)).disabled).toBe(true)
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'platform' } })
    fireEvent.change(within(editor).getByLabelText(/说明/), { target: { value: 'Infrastructure work' } })
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.updateChannel).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1', channelRef: 'channel:engineering', name: 'platform', description: 'Infrastructure work',
    })) })
    // The committed rename rides the projection refresh, not an optimistic row edit.
    expect(await b.view.findByText('# platform')).toBeTruthy()
    expect(b.view.queryByText('# engineering')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('offers 恢复 and 重启 in the row menu only where they apply and routes both through the Host remote', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    // A healthy Member's menu carries only the editor entry.
    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    const healthyMenu = await within(document.body).findByRole('menu')
    expect(within(healthyMenu).getByRole('menuitem', { name: '编辑 Agent' })).toBeTruthy()
    expect(within(healthyMenu).queryAllByRole('menuitem', { name: '恢复' })).toEqual([])
    expect(within(healthyMenu).queryAllByRole('menuitem', { name: '重启' })).toEqual([])
    // The error Member additionally gets the recovery entry.
    fireEvent.click(b.view.getByRole('button', { name: 'failed 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '恢复' }))
    await waitFor(() => {
      expect(b.recoverMember).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', memberId: 'member:failed' }))
    })
    // The unavailable Member gets the restart entry for a failed activation.
    fireEvent.click(b.view.getByRole('button', { name: 'offline 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '重启' }))
    await waitFor(() => {
      expect(b.recoverMember).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', memberId: 'member:offline' }))
    })
    // A restart that leaves the Member unavailable surfaces the diagnostic on the row.
    const alert = await b.view.findByRole('alert')
    expect(alert.textContent).toContain('重启已执行，成员仍不可用：preset missing')
    // A transport rejection surfaces as the row alert too.
    b.recoverMember.mockRejectedValueOnce(new Error('connection lost'))
    fireEvent.click(b.view.getByRole('button', { name: 'offline 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '重启' }))
    await waitFor(() => { expect(b.view.getByRole('alert').textContent).toContain('重启执行失败：connection lost') })
    await b.runtime.dispose()
  })

  it('retires the manual clear-context action and follows a Member rollover exactly once', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    // The manual clear-context row action is retired: Members manage their
    // own context through the context_rollover tool, and every row menu —
    // available, working, error, unavailable — omits the entry entirely.
    for (const handle of ['builder', 'worker', 'failed', 'offline']) {
      fireEvent.click(b.view.getByRole('button', { name: `${handle} 的操作` }))
      const menu = await within(document.body).findByRole('menu')
      expect(within(menu).queryByRole('menuitem', { name: '从全新上下文开始' })).toBeNull()
      fireEvent.keyDown(document, { key: 'Escape' })
    }

    // While no Member page is embedded, a rollover binding change never
    // redirects the conversation seat.
    // Prime the change stream: the first wake advances the probe loop so
    // later publishes reach the listener (no roster change is attached to it).
    b.publishChannelUpdate()
    await new Promise(resolve => setTimeout(resolve, 30))
    b.members.mockImplementation(async () => ({ ok: true, value: [
      b.status('member:builder', 'w1', 'builder', 'available'),
    ].map(entry => ({ ...entry, member: { ...entry.member, sessionId: 'session:builder-next' } })) }))
    b.publishChannelUpdate()
    // The roster now reports only builder on the new binding: wait for the
    // refresh to land (worker's row disappears) before opening the page.
    await waitFor(() => { expect(b.view.queryByRole('button', { name: '打开 worker 的会话' })).toBeNull() }, { timeout: 3000 })
    expect(b.openSession.mock.calls.some(([id]) => String(id).includes('builder-next'))).toBe(false)

    // Open the Member's live page: the conversation seat embeds the
    // post-rollover Session the roster now reports.
    await b.runtime.sessions.add({ id: 'session:builder-next' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => {
      expect(b.view.getByRole('button', { name: '打开 builder 的会话' }).getAttribute('aria-current')).toBe('page')
    })
    const opened = b.openSession.mock.calls.length

    // A rollover that lands while the commit window still reports the Member
    // unavailable does not redirect — the new Session does not exist for the
    // client yet.
    b.members.mockImplementation(async () => ({ ok: true, value: [
      { ...b.status('member:builder', 'w1', 'builder', 'unavailable', { class: 'rollover', detail: 'context rollover in progress' }), member: { ...b.status('member:builder', 'w1', 'builder', 'unavailable').member, sessionId: 'session:builder-next-2' } },
    ] }))
    b.publishChannelUpdate()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(b.openSession.mock.calls.length).toBe(opened)

    // Navigating away during the commit window cancels the follow: leaving
    // the Member page (back onto a Channel) rebinds the seat, so the later
    // active refresh must not yank the pane onto the new Session.
    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    await waitFor(() => { expect(b.view.getByRole('button', { name: '打开 builder 的会话' }).getAttribute('aria-current')).toBe(null) })
    b.members.mockImplementation(async () => ({ ok: true, value: [
      b.status('member:builder', 'w1', 'builder', 'available'),
    ].map(entry => ({ ...entry, member: { ...entry.member, sessionId: 'session:builder-next-2' } })) }))
    b.publishChannelUpdate()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(b.openSession.mock.calls.filter(([id]) => String(id).includes('builder-next-2')).length).toBe(0)

    // Returning to the Member page after the rollover settled opens the
    // post-rollover generation directly — the observation baseline has
    // already absorbed the change, so no pending follow remains.
    await b.runtime.sessions.add({ id: 'session:builder-next-2' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => {
      expect(b.openSession.mock.calls.filter(([id]) => String(id).includes('builder-next-2')).length).toBe(1)
    })
    await b.runtime.dispose()
  })

  it('edits Agent identity and pins a Member model through the editor', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑 Agent' }))
    const editor = b.view.getByRole('dialog', { name: '编辑 Agent' })
    // The Host catalog arrives session-independently; the picker rides the
    // shared Menu primitive with the default entry leading each open.
    const modelTrigger = await within(editor).findByRole('button', { name: '模型' })
    await waitFor(() => { expect(modelTrigger.textContent).toContain('跟随全局默认') })
    fireEvent.click(modelTrigger)
    const modelMenu = within(document.body).getByRole('menu')
    expect(within(modelMenu).getByText('DeepSeek')).toBeTruthy()
    fireEvent.click(within(modelMenu).getByRole('menuitem', { name: 'DeepSeek Reasoner' }))
    await waitFor(() => { expect(modelTrigger.textContent).toContain('DeepSeek Reasoner') })
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'architect' } })
    fireEvent.change(within(editor).getByLabelText(/说明/), { target: { value: 'System design owner' } })
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.updateMember).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'member:builder', handle: 'architect', description: 'System design owner',
      model: { provider: 'deepseek-official', model: 'deepseek-reasoner' },
    })) })
    // The renamed handle reaches the roster through the refreshed projection.
    expect(await b.view.findByText('architect')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('opens the Member Session inside Team mode from the Agent card', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await b.runtime.sessions.add({ id: 'session:member:builder' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    expect(await b.view.findByRole('heading', { name: '# engineering' })).toBeTruthy()
    expect(document.documentElement.dataset.agentTeamMode).toBe('team')
    // Team views own the conversation seat before the card click.
    expect(b.view.container.querySelector('[data-phase]')).toBeNull()

    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => {
      expect(b.openSession).toHaveBeenCalledWith('session:member:builder')
    })
    // The card stays inside Team mode: the chrome remains mounted and the
    // conversation seat yields to the shipped root rendering the Member Session.
    expect(document.documentElement.dataset.agentTeamMode).toBe('team')
    await waitFor(() => { expect(b.view.container.querySelector('[data-phase]')).toBeTruthy() })
    expect(b.view.container.querySelector('[data-team-conversation]')).toBeNull()
    // The single positioning highlight moves to the selected Agent card; the
    // workspace overview row goes quiet.
    const card = b.view.getByRole('button', { name: '打开 builder 的会话' })
    await waitFor(() => { expect(card.getAttribute('aria-current')).toBe('page') })
    for (const row of b.view.container.querySelectorAll('[aria-current="page"]')) {
      expect(row).toBe(card)
    }

    // Explicit Team navigation closes the embedded Member view again.
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-channel]')).toBeTruthy() })
    expect(b.view.container.querySelector('[data-phase]')).toBeNull()
    expect(card.getAttribute('aria-current')).toBeNull()
    await b.runtime.dispose()
  })

  it('lends the Agent card the marker while the Inbox page stands under it', async () => {
    // The Inbox page is a Team face the reader can be standing on when they open
    // an Agent, and the overlay embeds that Session over the page rather than
    // replacing it: the page keeps its place while exactly one row — the Agent
    // card — wears the marker, and the entry takes the marker back on the way out.
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await b.runtime.sessions.add({ id: 'session:member:builder' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')
    const entry = b.view.getByRole('button', { name: /^收件箱/ })
    fireEvent.click(entry)
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-inbox]')).toBeTruthy() })
    await waitFor(() => { expect(entry.getAttribute('aria-current')).toBe('page') })

    const card = b.view.getByRole('button', { name: '打开 builder 的会话' })
    fireEvent.click(card)
    await waitFor(() => { expect(b.view.container.querySelector('[data-phase]')).toBeTruthy() })
    // The page left the seat with the overlay, and only the card is marked: the
    // Inbox entry is a remembered location, not a second current page.
    expect(b.view.container.querySelector('[data-team-inbox]')).toBeNull()
    await waitFor(() => { expect(card.getAttribute('aria-current')).toBe('page') })
    expect(entry.getAttribute('aria-current')).toBeNull()
    for (const row of b.view.container.querySelectorAll('[aria-current="page"]')) expect(row).toBe(card)

    // Leaving the overlay puts the reader back on the page they were reading,
    // and the marker goes home with them.
    fireEvent.click(entry)
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-inbox]')).toBeTruthy() })
    expect(entry.getAttribute('aria-current')).toBe('page')
    expect(card.getAttribute('aria-current')).toBeNull()
    await b.runtime.dispose()
  })

  it('rebinds the underlying session when leaving an embedded Member view, so an off-seat rollover never blanks the seat', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    // Added without taking the selection: the Human's ordinary session stays
    // the workspace service's `mainView` retention, the way a real Member
    // session exists beside it on the Host.
    await b.runtime.sessions.add({ id: 'session:member:builder' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))

    // Enter the Member page: the seat embeds the Member session while the
    // underlying DSH current still points at the Human's ordinary session
    // only until open() moves it.
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => { expect(mainViewSessionId(b)).toBe('session:member:builder') })

    // Leaving the Member page through Team navigation must rebind the
    // underlying selection back to the Human's original session exactly once —
    // a stale Member retention would otherwise become the next entry's
    // return target.
    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-channel]')).toBeTruthy() })
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    expect(b.openSession.mock.calls.filter(([id]) => id === 'ordinary-session')).toHaveLength(1)
    const seat = b.view.container.querySelector('[data-team-channel]') as HTMLElement

    // The later rollover disposal of the Member session is now invisible to
    // the seat: the selection was already rebound, so no undefined gap, no
    // remount.
    await b.runtime.sessions.remove('session:member:builder')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    expect(b.view.container.querySelector('[data-team-channel]')).toBe(seat)
    expect(b.view.getByRole('heading', { name: '# engineering' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps the departed Member retention when the return target is gone, without reopening the dead id', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialChannels: true })
    await b.runtime.sessions.add({ id: 'session:member:builder' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')
    fireEvent.click(await b.view.findByRole('button', { name: '# engineering' }))
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => { expect(mainViewSessionId(b)).toBe('session:member:builder') })

    // The return target dies while the Member page is embedded (the Host
    // disposed the Human's ordinary session). 0.1.7 exposes no public clear,
    // so leaving the view keeps the departed Member retention behind the Team
    // seat; the member-session exclusion in the next capture keeps it from
    // becoming a false return target.
    await b.runtime.sessions.remove('ordinary-session')
    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-channel]')).toBeTruthy() })
    expect(mainViewSessionId(b)).toBe('session:member:builder')
    // The dead target is never opened: unknown ids fail loud in the service.
    expect(b.openSession).not.toHaveBeenCalledWith('ordinary-session')
    await b.runtime.dispose()
  })

  it('edits Agent facts without a Channel membership section', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑 Agent' }))
    const editor = b.view.getByRole('dialog', { name: '编辑 Agent' })
    // Channel membership is managed from the Channel side: the editor carries
    // only handle, description, and model.
    expect(within(editor).queryByRole('button', { name: '添加' })).toBeNull()
    expect(within(editor).queryByRole('button', { name: '移除' })).toBeNull()
    expect(within(editor).queryByText(/频道成员/)).toBeNull()
    expect(within(editor).getByLabelText('名称')).toBeTruthy()
    fireEvent.change(within(editor).getByLabelText(/说明/), { target: { value: 'Edited description' } })
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.updateMember).toHaveBeenCalledWith(expect.objectContaining({
      memberId: 'member:builder', handle: 'builder', description: 'Edited description',
    })) })
    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '编辑 Agent' })).toBeNull())
    await b.runtime.dispose()
  })

})

describe('Team archival surfaces', () => {
  it('archives an Agent from the row menu behind a destructive confirm', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    // The danger entry sits in every Member's row menu.
    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档' }))
    expect(b.view.getByRole('dialog', { name: '归档 Agent：builder' })).toBeTruthy()
    // The notice states the recoverability contract: data kept, no restore
    // entry point yet.
    expect(b.view.getByRole('dialog', { name: '归档 Agent：builder' }).textContent).toContain('暂无恢复入口')
    expect(b.archiveMember).not.toHaveBeenCalled()
    // Cancel closes without routing.
    fireEvent.click(b.view.getByRole('button', { name: '取消' }))
    expect(b.view.queryByRole('dialog', { name: '归档 Agent：builder' })).toBeNull()
    expect(b.archiveMember).not.toHaveBeenCalled()
    // Confirm routes the durable archive; the archived state arrives through
    // the workspace refetch and the row disappears.
    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档' }))
    fireEvent.click(await b.view.findByRole('button', { name: /^归档$/ }))
    await waitFor(() => {
      expect(b.archiveMember).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'member:builder' }))
    })
    await b.publishChannelUpdate()
    await waitFor(() => expect(b.view.queryByRole('button', { name: 'builder 的操作' })).toBeNull())
    await b.runtime.dispose()
  })

  it('replaces the rail empty claims with one error line when the connection drops', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const readChannels = b.viewChannels.getMockImplementation()!
    const readMembers = b.members.getMockImplementation()!
    await b.view.findByText('还没有频道')
    // The opening probe consumes the first publish silently, so the second one
    // is what refreshes the mounted Panels — here with an emptied roster.
    b.publishChannelUpdate()
    b.members.mockResolvedValue({ ok: true, value: [] } as never)
    b.publishChannelUpdate()
    await b.view.findByText('还没有 Agent')

    // The Host connection drops: each Panel reports the failure on the rail,
    // and a failed load must not additionally read as an empty workspace. The
    // reads fail too, exactly as they do when the transport is gone.
    b.viewChannels.mockResolvedValue({ ok: false, error: { message: 'transport down' } } as never)
    b.members.mockResolvedValue({ ok: false, error: { message: 'transport down' } } as never)
    b.failChanges()
    expect((await b.view.findAllByText('transport down')).length).toBeGreaterThanOrEqual(2)
    expect(b.view.queryByText('还没有频道')).toBeNull()
    expect(b.view.queryByText('还没有 Agent')).toBeNull()

    // The transport returns and the wake that follows carries a new version:
    // the still-mounted rail drops the error line and picks up the Channel
    // created while it was cut off — no remount, no page reload.
    b.seedChannel({ channelRef: 'channel:recovery', workspaceId: 'w1', name: 'recovery', description: 'created while cut off', createdAtSequence: 2 })
    b.viewChannels.mockImplementation(readChannels)
    b.members.mockImplementation(readMembers)
    b.recoverChanges()
    await b.view.findByRole('button', { name: '# recovery' })
    expect(b.view.queryByText('transport down')).toBeNull()
    await b.runtime.dispose()
  })

  it('archives a Channel from the row menu behind a destructive confirm', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('# engineering')

    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档频道' }))
    expect(b.view.getByRole('dialog', { name: '归档频道：engineering' })).toBeTruthy()
    expect(b.view.getByRole('dialog', { name: '归档频道：engineering' }).textContent).toContain('暂无恢复入口')
    expect(b.archiveChannel).not.toHaveBeenCalled()
    fireEvent.click(b.view.getByRole('button', { name: '取消' }))
    expect(b.view.queryByRole('dialog', { name: '归档频道：engineering' })).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档频道' }))
    fireEvent.click(await b.view.findByRole('button', { name: /^归档频道$/ }))
    await waitFor(() => {
      expect(b.archiveChannel).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', channelRef: 'channel:engineering' }))
    })
    await b.publishChannelUpdate()
    await waitFor(() => expect(b.view.queryByRole('button', { name: 'engineering 的操作' })).toBeNull())
    await b.runtime.dispose()
  })
})
