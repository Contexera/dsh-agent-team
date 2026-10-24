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
    expect(await b.view.findByRole('heading', { name: '项目' })).toBeTruthy()
    expect(b.view.getAllByText('Alpha')).toHaveLength(2)
    // The mode shadows the browser seat only: the shipped Settings row keeps the
    // footer in both modes, and the Team's own exit rides the browser seat.
    expect(b.view.getByText('设置')).toBeTruthy()
    const leaveTrigger = b.view.getByRole('button', { name: '对话' })
    expect(leaveTrigger.getAttribute('data-team-action')).toBe('leave')
    // The exit stands above the Inbox card, first in the browsing region.
    const browser = b.view.container.querySelector('[data-slot="sidebar.workspaces"]')!
    const browserRows = [...browser.querySelectorAll('button')]
    expect(browserRows.indexOf(leaveTrigger as HTMLButtonElement))
      .toBeLessThan(browserRows.findIndex(row => row.className.includes('inboxCard')))

    fireEvent.click(leaveTrigger)
    await waitFor(() => expect(document.documentElement.dataset.agentTeamMode).toBeUndefined())
    expect(await b.view.findByText('普通工作区')).toBeTruthy()
    expect(b.view.container.querySelector('[data-composer-seat]')).toBeTruthy()
    expect(await b.view.findByText('设置')).toBeTruthy()
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    await b.runtime.dispose()
  })

  it('loads Workspace Agents and creates a durable Member without optimistic rows', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('从左侧选择一个项目开始协作')).toBeTruthy()

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
    expect(b.view.queryByRole('button', { name: /初始项目/ })).toBeNull()
    b.addMember.mockResolvedValueOnce({ ok: false, error: { message: 'connection lost' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '创建 Agent' }))
    expect((await b.view.findByRole('alert')).textContent).toContain('connection lost')
    expect((b.view.getByLabelText('名称') as HTMLInputElement).value).toBe('reviewer')
    expect(b.view.queryByText('reviewer')).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: '创建 Agent' }))

    expect(await b.view.findByText('reviewer')).toBeTruthy()
    expect(b.addMember).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'w1', projectRefs: [], handle: 'reviewer', description: 'Reviews changes', presetId: 'team-member',
    }))
    expect(b.addMember.mock.calls[0]![0].requestId).toBe(b.addMember.mock.calls[1]![0].requestId)
    await waitFor(() => expect(document.activeElement).toBe(addAgentTrigger))
    fireEvent.click(addAgentTrigger)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(b.view.queryByRole('dialog', { name: '添加 Agent' })).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(addAgentTrigger))
    await b.runtime.dispose()
  })

  it('creates an Agent with empty description, no Projects, and an optional model', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
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
    // No Project picker exists at creation; Projects join later from the Project side.
    expect(b.view.queryByText('选择初始项目')).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: '创建 Agent' }))
    expect(await b.view.findByText('bare')).toBeTruthy()
    expect(b.addMember).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'w1', handle: 'bare', description: '', presetId: 'team-member', projectRefs: [],
      model: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' },
    }))
    await b.runtime.dispose()
  })

  it('creates a Project atomically with selected available Members and manages committed membership', async () => {
    const b = await runtimeWithTeam()
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('还没有项目')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: '新建项目' }))
    fireEvent.change(b.view.getByLabelText('名称'), { target: { value: 'backend' } })
    fireEvent.change(b.view.getByLabelText(/说明/), { target: { value: 'API implementation' } })
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    const unavailable = await within(document.body).findByRole('menuitem', { name: /offline/ }) as HTMLButtonElement
    expect(unavailable.disabled).toBe(true)
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: /builder/ }))
    b.createProject.mockResolvedValueOnce({ ok: false, error: { message: 'connection lost' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '创建项目' }))
    expect((await b.view.findByRole('alert')).textContent).toContain('connection lost')
    fireEvent.click(b.view.getByRole('button', { name: '创建项目' }))

    expect(await b.view.findByText('# backend')).toBeTruthy()
    expect(b.createProject).toHaveBeenLastCalledWith(expect.objectContaining({
      workspaceId: 'w1', name: 'backend', description: 'API implementation', memberIds: ['member:builder'],
    }))
    expect(b.createProject.mock.calls[0]![0].requestId).toBe(b.createProject.mock.calls[1]![0].requestId)
    // Membership is derived from participation now, so a created Project has
    // no membership controls to drive.
    fireEvent.click(b.view.getByRole('button', { name: '# backend' }))
    expect(b.view.queryByRole('button', { name: '管理成员' })).toBeNull()
    await b.runtime.dispose()
  })

  it('renames Project display facts from the editor and refreshes the row', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('# engineering')).toBeTruthy()

    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑项目' }))
    const editor = b.view.getByRole('dialog', { name: '编辑项目' })
    // Save stays disabled until something actually changes.
    expect(((within(editor).getByRole('button', { name: '保存' }) as HTMLButtonElement)).disabled).toBe(true)
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'platform' } })
    fireEvent.change(within(editor).getByLabelText(/说明/), { target: { value: 'Infrastructure work' } })
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.updateProject).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1', projectRef: 'project:engineering', name: 'platform', description: 'Infrastructure work',
    })) })
    // The committed rename rides the projection refresh, not an optimistic row edit.
    expect(await b.view.findByText('# platform')).toBeTruthy()
    expect(b.view.queryByText('# engineering')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  async function openProjectEditor(b: Awaited<ReturnType<typeof runtimeWithTeam>>): Promise<HTMLElement> {
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    expect(await b.view.findByText('# engineering')).toBeTruthy()
    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑项目' }))
    return b.view.getByRole('dialog', { name: '编辑项目' })
  }

  it('grants and withdraws Agent owners non-optimistically beside the fixed Human owner', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    const editor = await openProjectEditor(b)
    const owners = await within(editor).findByRole('group', { name: '负责人' })
    // The Human always owns the Project: named, marked, and without a remove control.
    expect(within(owners).getByText('human')).toBeTruthy()
    expect(within(owners).getByText('始终是负责人')).toBeTruthy()
    expect(within(owners).queryByRole('button', { name: /移除负责人/ })).toBeNull()
    expect(within(owners).queryByRole('button', { name: '移除负责人 @human' })).toBeNull()

    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const commit = b.addProjectOwner.getMockImplementation()!
    b.addProjectOwner.mockImplementationOnce(async request => { await gate; return commit(request) })
    fireEvent.click(within(owners).getByRole('button', { name: '添加负责人 @builder' }))
    await waitFor(() => { expect(b.addProjectOwner).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1', projectRef: 'project:engineering', memberId: 'member:builder', requestId: expect.any(String),
    })) })
    // Pending: every owner control is disabled and nothing has moved yet.
    expect((within(owners).getByRole('button', { name: '添加负责人 @worker' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(owners).queryByRole('button', { name: '移除负责人 @builder' })).toBeNull()
    release()
    const remove = await within(owners).findByRole('button', { name: '移除负责人 @builder' })
    expect(within(owners).queryByRole('button', { name: '添加负责人 @builder' })).toBeNull()

    fireEvent.click(remove)
    await waitFor(() => { expect(b.removeProjectOwner).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'w1', projectRef: 'project:engineering', memberId: 'member:builder',
    })) })
    expect(await within(owners).findByRole('button', { name: '添加负责人 @builder' })).toBeTruthy()
    expect(b.addProjectOwner.mock.calls[0]![0].requestId).not.toBe(b.removeProjectOwner.mock.calls[0]![0].requestId)
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('keeps a Host owner error visible and leaves the owners unchanged', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    const editor = await openProjectEditor(b)
    const owners = await within(editor).findByRole('group', { name: '负责人' })
    b.failProjectOwnerWrite('Project owner write refused')
    fireEvent.click(within(owners).getByRole('button', { name: '添加负责人 @builder' }))
    expect((await within(owners).findByRole('alert')).textContent).toBe('Project owner write refused')
    expect(within(owners).queryByRole('button', { name: '移除负责人 @builder' })).toBeNull()
    expect((within(owners).getByRole('button', { name: '添加负责人 @builder' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.keyDown(document, { key: 'Escape' })
    await b.runtime.dispose()
  })

  it('offers 恢复 and 重启 in the row menu only where they apply and routes both through the Host remote', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
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
    const b = await runtimeWithTeam({ initialProjects: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    // The manual clear-context row action is retired: the Host recycles a
    // generation at the wake boundary, and every row menu — available,
    // working, error, unavailable — omits the entry entirely.
    for (const handle of ['builder', 'worker', 'failed', 'offline']) {
      fireEvent.click(b.view.getByRole('button', { name: `${handle} 的操作` }))
      const menu = await within(document.body).findByRole('menu')
      expect(within(menu).queryByRole('menuitem', { name: '从全新上下文开始' })).toBeNull()
      fireEvent.keyDown(document, { key: 'Escape' })
    }

    b.publishProjectUpdate()
    await new Promise(resolve => setTimeout(resolve, 30))
    b.members.mockImplementation(async () => ({ ok: true, value: [
      b.status('member:builder', 'w1', 'builder', 'available'),
    ].map(entry => ({ ...entry, member: { ...entry.member, sessionId: 'session:builder-next' } })) }))
    b.publishProjectUpdate()
    await waitFor(() => { expect(b.view.queryByRole('button', { name: '打开 worker 的会话' })).toBeNull() }, { timeout: 3000 })
    expect(b.openSession.mock.calls.some(([id]) => String(id).includes('builder-next'))).toBe(false)

    await b.runtime.sessions.add({ id: 'session:builder-next' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => {
      expect(b.view.getByRole('button', { name: '打开 builder 的会话' }).getAttribute('aria-current')).toBe('page')
    })
    const opened = b.openSession.mock.calls.length

    b.members.mockImplementation(async () => ({ ok: true, value: [
      { ...b.status('member:builder', 'w1', 'builder', 'unavailable', { class: 'rollover', detail: 'context rollover in progress' }), member: { ...b.status('member:builder', 'w1', 'builder', 'unavailable').member, sessionId: 'session:builder-next-2' } },
    ] }))
    b.publishProjectUpdate()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(b.openSession.mock.calls.length).toBe(opened)

    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    await waitFor(() => { expect(b.view.getByRole('button', { name: '打开 builder 的会话' }).getAttribute('aria-current')).toBe(null) })
    b.members.mockImplementation(async () => ({ ok: true, value: [
      b.status('member:builder', 'w1', 'builder', 'available'),
    ].map(entry => ({ ...entry, member: { ...entry.member, sessionId: 'session:builder-next-2' } })) }))
    b.publishProjectUpdate()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(b.openSession.mock.calls.filter(([id]) => String(id).includes('builder-next-2')).length).toBe(0)

    await b.runtime.sessions.add({ id: 'session:builder-next-2' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    fireEvent.click(b.view.getByRole('button', { name: '打开 builder 的会话' }))
    await waitFor(() => {
      expect(b.openSession.mock.calls.filter(([id]) => String(id).includes('builder-next-2')).length).toBe(1)
    })
    await b.runtime.dispose()
  })

  it('edits Agent identity and pins a Member model through the editor', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
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
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
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
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-project]')).toBeTruthy() })
    expect(b.view.container.querySelector('[data-phase]')).toBeNull()
    expect(card.getAttribute('aria-current')).toBeNull()
    await b.runtime.dispose()
  })

  it('lends the Agent card the marker while the Inbox page stands under it', async () => {
    // The Inbox page is a Team face the reader can be standing on when they open
    // an Agent, and the overlay embeds that Session over the page rather than
    // replacing it: the page keeps its place while exactly one row — the Agent
    // card — wears the marker, and the entry takes the marker back on the way out.
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
    await b.runtime.sessions.add({ id: 'session:member:builder' as never, summary: { title: 'builder', cwd: '/work/alpha' } } as never)
    await b.view.findByText('builder')
    const entry = b.view.getByRole('button', { name: /^收件箱/ })
    fireEvent.click(entry)
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-inbox]')).toBeTruthy() })
    await waitFor(() => { expect(entry.getAttribute('aria-current')).toBe('page') })

    const card = b.view.getByRole('button', { name: '打开 builder 的会话' })
    fireEvent.click(card)
    await waitFor(() => { expect(b.view.container.querySelector('[data-phase]')).toBeTruthy() })
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
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
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

    fireEvent.click(b.view.getByRole('button', { name: '# engineering' }))
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-project]')).toBeTruthy() })
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    expect(b.openSession.mock.calls.filter(([id]) => id === 'ordinary-session')).toHaveLength(1)
    const seat = b.view.container.querySelector('[data-team-project]') as HTMLElement

    await b.runtime.sessions.remove('session:member:builder')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mainViewSessionId(b)).toBe('ordinary-session')
    expect(b.view.container.querySelector('[data-team-project]')).toBe(seat)
    expect(b.view.getByRole('heading', { name: '# engineering' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('keeps the departed Member retention when the return target is gone, without reopening the dead id', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
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
    await waitFor(() => { expect(b.view.container.querySelector('[data-team-project]')).toBeTruthy() })
    expect(mainViewSessionId(b)).toBe('session:member:builder')
    // The dead target is never opened: unknown ids fail loud in the service.
    expect(b.openSession).not.toHaveBeenCalledWith('ordinary-session')
    await b.runtime.dispose()
  })

  it('edits Agent facts without a Project membership section', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')

    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑 Agent' }))
    const editor = b.view.getByRole('dialog', { name: '编辑 Agent' })
    // Project membership is managed from the Project side: the editor carries
    // only handle, description, and model.
    expect(within(editor).queryByRole('button', { name: '添加' })).toBeNull()
    expect(within(editor).queryByRole('button', { name: '移除' })).toBeNull()
    expect(within(editor).queryByText(/项目成员/)).toBeNull()
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
    const b = await runtimeWithTeam({ initialProjects: true })
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
    await b.publishProjectUpdate()
    await waitFor(() => expect(b.view.queryByRole('button', { name: 'builder 的操作' })).toBeNull())
    await b.runtime.dispose()
  })

  it('replaces the rail empty claims with one error line when the connection drops', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const readProjects = b.viewProjects.getMockImplementation()!
    const readMembers = b.members.getMockImplementation()!
    await b.view.findByText('还没有项目')
    // The roster refresh the panels read on wake, here with an emptied roster.
    await b.changeSubscriptionsReady()
    b.members.mockResolvedValue({ ok: true, value: [] } as never)
    b.publishProjectUpdate()
    await b.view.findByText('还没有 Agent')

    // The Host connection drops: each Panel reports the failure on the rail,
    // and a failed load must not additionally read as an empty workspace. The
    // reads fail too, exactly as they do when the transport is gone.
    b.viewProjects.mockResolvedValue({ ok: false, error: { message: 'transport down' } } as never)
    b.members.mockResolvedValue({ ok: false, error: { message: 'transport down' } } as never)
    b.failChanges()
    expect((await b.view.findAllByText('transport down')).length).toBeGreaterThanOrEqual(2)
    expect(b.view.queryByText('还没有项目')).toBeNull()
    expect(b.view.queryByText('还没有 Agent')).toBeNull()

    b.seedProject({ projectRef: 'project:recovery', workspaceId: 'w1', name: 'recovery', description: 'created while cut off', createdAtSequence: 2 })
    b.viewProjects.mockImplementation(readProjects)
    b.members.mockImplementation(readMembers)
    b.recoverChanges()
    await b.view.findByRole('button', { name: '# recovery' })
    expect(b.view.queryByText('transport down')).toBeNull()
    await b.runtime.dispose()
  })

  it('archives a Project from the row menu behind a destructive confirm', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('# engineering')

    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档项目' }))
    expect(b.view.getByRole('dialog', { name: '归档项目：engineering' })).toBeTruthy()
    expect(b.view.getByRole('dialog', { name: '归档项目：engineering' }).textContent).toContain('暂无恢复入口')
    expect(b.archiveProject).not.toHaveBeenCalled()
    fireEvent.click(b.view.getByRole('button', { name: '取消' }))
    expect(b.view.queryByRole('dialog', { name: '归档项目：engineering' })).toBeNull()
    fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
    fireEvent.click(await within(document.body).findByRole('menuitem', { name: '归档项目' }))
    fireEvent.click(await b.view.findByRole('button', { name: /^归档项目$/ }))
    await waitFor(() => {
      expect(b.archiveProject).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w1', projectRef: 'project:engineering' }))
    })
    await b.publishProjectUpdate()
    await waitFor(() => expect(b.view.queryByRole('button', { name: 'engineering 的操作' })).toBeNull())
    await b.runtime.dispose()
  })
})

describe('Team member editor partial update payload', () => {
  it('states the model explicitly and leaves capabilities alone', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))
    await b.view.findByText('builder')
    fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑 Agent' }))
    const editor = b.view.getByRole('dialog', { name: '编辑 Agent' })
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'architect' } })
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(b.updateMember).toHaveBeenCalled() })
    const payload = b.updateMember.mock.calls.at(-1)?.[0] as Record<string, unknown>
    // "Follow global default" is an explicit clear now; an omitted field would
    // keep a stuck pin. Capabilities stay out: an absent field no longer clears.
    expect(payload.model).toBeNull()
    expect('capabilities' in payload).toBe(false)
  })
})
