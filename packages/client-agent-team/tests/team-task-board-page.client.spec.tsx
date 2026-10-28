// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.setConfig({ testTimeout: 30_000 })
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

describe('Team task board page', () => {
  it('groups every Workspace\'s open Tasks by state, marks itself current, and opens a card at the Thread level', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true, seedTaskStatus: 'todo', seededMessages: [
      { body: '实现 API 网关\n细节在 Thread 里', occurredAt: '2026-10-14T09:00:00.000Z' },
    ] })
    // The board is a global face: its sidebar row sits beside the Inbox and,
    // while the page stands, it — not the Workspace selector — carries
    // aria-current, because no Workspace overview is open underneath.
    const boardButton = await b.view.findByRole('button', { name: '任务看板' })
    fireEvent.click(boardButton)
    const surface = await waitFor(() => {
      const element = b.view.container.querySelector('[data-team-task-board]')
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    expect(within(surface).getByRole('heading', { name: '任务看板' })).toBeTruthy()
    expect(within(surface).getByText('所有项目中待处理、进行中和待验收的任务')).toBeTruthy()
    await waitFor(() => { expect(boardButton.getAttribute('aria-current')).toBe('page') })
    expect(b.view.getByRole('button', { name: '收件箱' }).getAttribute('aria-current')).toBeNull()
    const trigger = b.view.container.querySelector<HTMLButtonElement>('[data-team-workspace-trigger]')
    expect(trigger?.getAttribute('aria-current')).toBeNull()

    // The seeded Task lands in its state column; the entry names its Project,
    // its opener line, the accountable owner, and nobody executing it. The
    // bounded subject drops the body: the detail lives in the Thread.
    const card = await within(surface).findByRole('button', { name: /Task #1/ })
    expect(card.textContent).toContain('engineering')
    expect(card.textContent).toContain('实现 API 网关')
    expect(card.textContent).not.toContain('细节在 Thread 里')
    expect(card.textContent).toContain('你负责')
    expect(card.textContent).toContain('待认领')
    expect(card.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-14T09:00:00.000Z')

    // A card opens the Task's own Thread level and leaves the global face,
    // so the sidebar marker moves off the board row.
    fireEvent.click(card)
    expect(await b.view.findByRole('heading', { name: /Task #1/ })).toBeTruthy()
    await waitFor(() => { expect(boardButton.getAttribute('aria-current')).toBeNull() })
    expect(b.view.container.querySelector('[data-team-task-board]')).toBeNull()
  })

  it('states the empty board alone: no column heads stand beside the empty message', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
    fireEvent.click(await b.view.findByRole('button', { name: '任务看板' }))
    const surface = await waitFor(() => {
      const element = b.view.container.querySelector('[data-team-task-board]')
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    expect(await within(surface).findByText('还没有待处理的任务')).toBeTruthy()
    // The empty state is the whole story: the Project board hides its columns
    // when every one of them is empty, and this page answers to the same rule.
    expect(within(surface).queryByText('待处理')).toBeNull()
    expect(within(surface).queryByText('进行中')).toBeNull()
    expect(within(surface).queryByText('待验收')).toBeNull()
  })

  it('reports a failed board load through the Host error and keeps the page alive', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1', initialProjects: true })
    b.failTaskBoard('看板不可用')
    fireEvent.click(await b.view.findByRole('button', { name: '任务看板' }))
    const surface = await waitFor(() => {
      const element = b.view.container.querySelector('[data-team-task-board]')
      expect(element).toBeTruthy()
      return element as HTMLElement
    })
    expect(await within(surface).findByRole('alert')).toBeTruthy()
    expect(within(surface).getByText('看板不可用')).toBeTruthy()
  })
})
