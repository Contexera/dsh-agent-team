// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamClientMemberStatus } from '@contexera/dsh-agent-team/types'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { TeamAgentsPanel } from '../src/client/TeamAgentsPanel.tsx'
import { zh } from '../src/client/locales.ts'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

type Runtime = Awaited<ReturnType<typeof runtimeWithTeam>>

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof TeamAgentsPanel>[0]['t']

async function enterTeam(b: Runtime): Promise<void> {
  fireEvent.click(b.view.getByRole('button', { name: '团队' }))
  await b.view.findByText('# engineering')
}

async function openAgentEditor(b: Runtime): Promise<HTMLElement> {
  await b.view.findByText('builder')
  fireEvent.click(b.view.getByRole('button', { name: 'builder 的操作' }))
  fireEvent.click(await within(document.body).findByRole('menuitem', { name: '编辑 Agent' }))
  return b.view.getByRole('dialog', { name: '编辑 Agent' })
}

async function openProjectEditor(b: Runtime): Promise<HTMLElement> {
  fireEvent.click(b.view.getByRole('button', { name: 'engineering 的操作' }))
  fireEvent.click(await within(document.body).findByRole('menuitem', { name: '编辑项目' }))
  return b.view.getByRole('dialog', { name: '编辑项目' })
}

describe('Agent and Project edit refresh recovery', () => {
  it('keeps a confirmed Agent save closed when the roster refresh throws, then retries that refresh', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    await enterTeam(b)
    const editor = await openAgentEditor(b)
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'architect' } })

    b.members.mockRejectedValueOnce(new Error('roster refresh unavailable'))
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '编辑 Agent' })).toBeNull())
    expect(b.updateMember).toHaveBeenCalledTimes(1)
    const alert = (await b.view.findByText(/roster refresh unavailable/)).closest<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toContain('已保存，列表刷新失败')
    fireEvent.click(within(alert).getByRole('button', { name: '重试刷新' }))

    expect(await b.view.findByRole('button', { name: '打开 architect 的会话' })).toBeTruthy()
    expect(b.view.queryByText('roster refresh unavailable')).toBeNull()
    await b.runtime.dispose()
  })

  it('classifies an answered Agent refusal as final and starts a new request on retry', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    await enterTeam(b)
    const editor = await openAgentEditor(b)
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'architect' } })
    b.updateMember.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/bad-request', 'Host refused the edit', {}),
    } as never)

    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    expect((await within(editor).findByText('Host refused the edit')).textContent).toContain('Host refused the edit')
    expect(b.view.getByRole('dialog', { name: '编辑 Agent' })).toBe(editor)

    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '编辑 Agent' })).toBeNull())
    expect(b.updateMember.mock.calls[0]![0].requestId).not.toBe(b.updateMember.mock.calls[1]![0].requestId)
    await b.runtime.dispose()
  })

  it('reuses the uncertain Agent write ID and proves the retry adds no second Host write', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    await enterTeam(b)
    const editor = await openAgentEditor(b)
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'architect' } })

    const commit = b.updateMember.getMockImplementation()!
    const replies = new Map<string, Awaited<ReturnType<typeof commit>>>()
    let hostWrites = 0
    // The first call commits and loses its response; replaying the ID returns that stored answer without another write.
    b.updateMember.mockImplementation(async request => {
      const replay = replies.get(request.requestId)
      if (replay !== undefined) return replay
      const result = await commit(request)
      hostWrites += 1
      replies.set(request.requestId, result)
      if (hostWrites === 1) throw new Error('response lost after Host write')
      return result
    })

    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    expect((await within(editor).findByText('response lost after Host write')).textContent).toContain('response lost after Host write')
    const firstRequestId = b.updateMember.mock.calls[0]![0].requestId

    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '编辑 Agent' })).toBeNull())
    expect(b.updateMember.mock.calls[1]![0].requestId).toBe(firstRequestId)
    expect(b.updateMember).toHaveBeenCalledTimes(2)
    expect(hostWrites).toBe(1)
    await b.runtime.dispose()
  })

  it.each([
    ['gateway/internal', () => new RemoteError('gateway/internal', 'response lost after Host write', {})],
    ['unclassified', () => ({ message: 'response lost after Host write' })],
  ])('keeps the Agent write ID when a committed response is reported as %s', async (_kind, failure) => {
    const b = await runtimeWithTeam({ initialProjects: true })
    await enterTeam(b)
    const editor = await openAgentEditor(b)
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'architect' } })

    const commit = b.updateMember.getMockImplementation()!
    const replies = new Map<string, Awaited<ReturnType<typeof commit>>>()
    let hostWrites = 0
    b.updateMember.mockImplementation(async request => {
      const replay = replies.get(request.requestId)
      if (replay !== undefined) return replay
      const result = await commit(request)
      hostWrites += 1
      replies.set(request.requestId, result)
      if (hostWrites === 1) {
        return { ok: false, error: failure() } as never
      }
      return result
    })

    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    expect((await within(editor).findByText('response lost after Host write')).textContent).toContain('response lost after Host write')
    const firstRequestId = b.updateMember.mock.calls[0]![0].requestId

    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '编辑 Agent' })).toBeNull())
    expect(b.updateMember.mock.calls[1]![0].requestId).toBe(firstRequestId)
    expect(hostWrites).toBe(1)
    await b.runtime.dispose()
  })

  it('lands the successful member half of a Project refresh when the Project read fails', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    await enterTeam(b)
    const roster = await b.members({ workspaceId: 'w1' })
    expect(roster.ok).toBe(true)
    const editor = await openProjectEditor(b)
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'platform' } })

    b.viewProjects.mockImplementationOnce(() => { throw new Error('Project refresh unavailable') })
    b.members.mockResolvedValueOnce({
      ok: true,
      value: [...roster.value, b.status('member:fresh', 'w1', 'fresh', 'available')],
    } as never)
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '编辑项目' })).toBeNull())
    const alert = (await b.view.findByText(/Project refresh unavailable/)).closest<HTMLElement>('[role="alert"]')!
    expect(alert.textContent).toContain('已保存，列表刷新失败')
    expect(within(alert).getByRole('button', { name: '重试刷新' })).toBeTruthy()
    expect(b.view.getByRole('button', { name: '# engineering' })).toBeTruthy()

    fireEvent.click(b.view.getByRole('button', { name: '新建项目' }))
    fireEvent.click(b.view.getByRole('button', { name: /初始成员/ }))
    expect(await within(document.body).findByRole('menuitem', { name: /fresh/ })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('lands the successful Project half of a refresh when the member read fails, then retries the read', async () => {
    const b = await runtimeWithTeam({ initialProjects: true })
    await enterTeam(b)
    const editor = await openProjectEditor(b)
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'platform' } })

    b.members.mockResolvedValueOnce({ ok: false, error: { message: 'Member refresh unavailable' } } as never)
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '编辑项目' })).toBeNull())
    expect(await b.view.findByRole('button', { name: '# platform' })).toBeTruthy()
    const alert = (await b.view.findByText(/Member refresh unavailable/)).closest<HTMLElement>('[role="alert"]')!
    fireEvent.click(within(alert).getByRole('button', { name: '重试刷新' }))
    await waitFor(() => expect(b.view.queryByText('Member refresh unavailable')).toBeNull())
    await b.runtime.dispose()
  })

  it.each(['succeeds', 'fails'])('drops a save refresh when the newer workspace read %s', async outcome => {
    const b = await runtimeWithTeam({ initialProjects: true })
    await enterTeam(b)
    const readProjects = b.viewProjects.getMockImplementation()!
    const older = Promise.withResolvers<unknown>()
    const newer = Promise.withResolvers<unknown>()
    let issued = 0
    b.viewProjects.mockImplementation(async request => {
      const position = issued
      issued += 1
      if (position === 0) return await older.promise as never
      if (position === 1) return await newer.promise as never
      return await readProjects(request)
    })
    const staleView = await readProjects({})
    const editor = await openProjectEditor(b)
    fireEvent.change(within(editor).getByLabelText('名称'), { target: { value: 'platform' } })
    fireEvent.click(within(editor).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(issued).toBe(1))

    await b.changeSubscriptionsReady()
    b.publishWorkspaceUpdate()
    await waitFor(() => expect(issued).toBe(2))
    if (outcome === 'fails') {
      newer.resolve({ ok: false, error: { message: 'Newer refresh unavailable' } })
      const alert = (await b.view.findByText(/Newer refresh unavailable/)).closest<HTMLElement>('[role="alert"]')!
      expect(alert.textContent).toContain('已保存，列表刷新失败')
      await act(async () => { older.resolve(staleView) })
      fireEvent.click(within(alert).getByRole('button', { name: '重试刷新' }))
    } else {
      newer.resolve(await readProjects({}))
      expect(await b.view.findByRole('button', { name: '# platform' })).toBeTruthy()
      await act(async () => { older.resolve(staleView) })
    }

    await waitFor(() => expect(b.view.queryByRole('button', { name: '# engineering' })).toBeNull())
    expect(b.view.getByRole('button', { name: '# platform' })).toBeTruthy()
    expect(b.updateProject).toHaveBeenCalledTimes(1)
    await b.runtime.dispose()
  })

  it('lets the newest Agent refresh win over a late thrown read', async () => {
    const initial = Promise.withResolvers<RemoteResult<readonly AgentTeamClientMemberStatus[]>>()
    const older = Promise.withResolvers<RemoteResult<readonly AgentTeamClientMemberStatus[]>>()
    const newer = Promise.withResolvers<RemoteResult<readonly AgentTeamClientMemberStatus[]>>()
    const loadMembers = vi.fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const listeners = new Map<string, (update: unknown) => void>()
    const subscribeChanges = vi.fn((scope: { readonly kind?: string }, listener: (update: unknown) => void) => {
      if (scope.kind !== undefined) listeners.set(scope.kind, listener)
      return () => {}
    })
    const status = (handle: string): AgentTeamClientMemberStatus => ({
      member: {
        memberId: `member:${handle}` as AgentTeamClientMemberStatus['member']['memberId'],
        workspaceId: 'w1' as AgentTeamClientMemberStatus['member']['workspaceId'],
        handle,
        description: '',
        presetId: 'team-member',
        state: 'enabled',
        sessionId: `session:${handle}` as AgentTeamClientMemberStatus['member']['sessionId'],
      },
      workspaceIds: ['w1' as AgentTeamClientMemberStatus['member']['workspaceId']],
      availability: 'active',
      presence: 'available',
      capabilityState: 'applied',
    })
    const props = {
      workspaceId: 'w1' as Parameters<typeof TeamAgentsPanel>[0]['workspaceId'],
      loadMembers,
      subscribeChanges,
      t,
      loadModels: vi.fn(async () => ({ ok: true, value: { groups: [], failures: [] } })),
    } as unknown as Parameters<typeof TeamAgentsPanel>[0]
    render(createElement(TeamAgentsPanel, props))

    await act(async () => { initial.resolve({ ok: true, value: [status('builder')] }) })
    expect(await screen.findByText('builder')).toBeTruthy()
    act(() => { listeners.get('workspace')!({ type: 'changed', version: 1 }) })
    await waitFor(() => expect(loadMembers).toHaveBeenCalledTimes(2))
    act(() => { listeners.get('presence')!({ type: 'changed', version: 2 }) })
    await waitFor(() => expect(loadMembers).toHaveBeenCalledTimes(3))

    await act(async () => { newer.resolve({ ok: true, value: [status('architect')] }) })
    expect(await screen.findByText('architect')).toBeTruthy()
    await act(async () => { older.reject(new Error('late roster failure')) })
    expect(screen.queryByText('late roster failure')).toBeNull()
    expect(screen.getByText('architect')).toBeTruthy()
    expect(screen.queryByText('builder')).toBeNull()
  })
})
