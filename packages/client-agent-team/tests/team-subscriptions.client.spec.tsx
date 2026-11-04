// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { AgentTeamMemberId, AgentTeamProjectRef, AgentTeamSubscription, AgentTeamSubscriptionListEntry, AgentTeamSubscriptionStateRequest } from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { zh } from '../src/client/locales.ts'
import type { TeamConversationProps } from '../src/client/slots.ts'
import { TeamSubscriptionsTab, type TeamSubscriptionsTabProps } from '../src/client/TeamSubscriptionsTab.tsx'

afterEach(cleanup)

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as TeamConversationProps['t']

const workspaceId = 'w1' as WorkspaceId
const projectRef = 'project:engineering' as AgentTeamProjectRef
const memberOf = (memberId: AgentTeamMemberId) => ({ handle: memberId === 'member:human' ? 'human' : 'vera' })

function subscription(overrides: Partial<AgentTeamSubscription> = {}): AgentTeamSubscription {
  return {
    subscriptionRef: 'subscription:1' as AgentTeamSubscription['subscriptionRef'],
    projectRef,
    name: 'main CI',
    triggers: { interval: { minutes: 10 } },
    script: { content: '#!/usr/bin/env bash\nprintf events\n', sha256: 'a'.repeat(64), shell: 'bash' },
    credentials: [],
    revision: 3,
    state: 'active',
    createdBy: 'member:human' as AgentTeamMemberId,
    createdAt: '2026-11-03T01:00:00.000Z',
    ...overrides,
  }
}

function entry(overrides: Partial<AgentTeamSubscriptionListEntry> = {}, subscriptionOverrides: Partial<AgentTeamSubscription> = {}): AgentTeamSubscriptionListEntry {
  const stored = subscription(subscriptionOverrides)
  return { subscription: stored, unpublished: 0, eventCount: 0, ...overrides }
}

const runs = [{
  runRef: 'run:1', trigger: 'interval' as const, startedAt: '2026-11-03T02:00:00.000Z', durationMs: 1200,
  category: 'accepted' as const, succeeded: true, eventCount: 1, exitCode: 0, timedOut: false, subscriptionRevision: 3,
  stdoutTail: '{"id":"a","title":"A"}', stderrTail: '', reason: undefined,
}]

const writeResult = { ok: false as const, error: { message: 'not used' } } as never

function host(overrides: Partial<TeamSubscriptionsTabProps['host']> = {}): TeamSubscriptionsTabProps['host'] {
  return {
    loadSubscriptionLogs: vi.fn(async () => ({ ok: true as const, value: { subscription: subscription(), runs } })),
    pauseSubscription: vi.fn(async () => writeResult),
    resumeSubscription: vi.fn(async () => writeResult),
    deleteSubscription: vi.fn(async () => writeResult),
    ...overrides,
  }
}

function renderTab(overrides: Partial<TeamSubscriptionsTabProps> = {}) {
  const onRetry = vi.fn()
  const onChanged = vi.fn()
  const view = render(<TeamSubscriptionsTab
    workspaceId={workspaceId}
    projectRef={projectRef}
    host={host()}
    entries={[]}
    loading={false}
    error={undefined}
    onRetry={onRetry}
    onChanged={onChanged}
    canManage
    memberOf={memberOf}
    panelId="panel"
    labelledBy="tab"
    t={t}
    {...overrides}
  />)
  return { view, onRetry, onChanged }
}

/** The controls only an authoring surface would carry: a Project owner arms subscriptions through `team_subscription`. */
const AUTHORING_CONTROLS = /^(新建订阅|编辑|失败投递|重置地址)/

describe('the Project subscription tab', () => {
  it('states loading, failure and the empty projection as three different faces', async () => {
    const loading = renderTab({ entries: undefined, loading: true })
    expect(loading.view.getByText('正在加载订阅…')).toBeTruthy()
    cleanup()

    const failed = renderTab({ entries: undefined, loading: false, error: 'offline' })
    expect(failed.view.getByRole('alert').textContent).toContain('offline')
    fireEvent.click(failed.view.getByRole('button', { name: '重试' }))
    expect(failed.onRetry).toHaveBeenCalledTimes(1)
    cleanup()

    // An empty projection says who can start one instead of offering the Human a form.
    const empty = renderTab()
    expect(empty.view.getByText('还没有订阅')).toBeTruthy()
    expect(empty.view.getByText(/项目负责人可以订阅事件/)).toBeTruthy()
    expect(empty.view.queryByRole('button')).toBeNull()
  })

  it('reads a card from the Host projection and offers no write control', () => {
    const seeded = entry({
      eventCount: 3,
      lastRun: { ...runs[0]!, runRef: 'run:2', startedAt: '2026-11-03T02:20:00.000Z', category: 'exit-code', succeeded: false },
      nextRunAt: '2026-11-03T02:30:00.000Z',
    }, { pausedReason: 'failures', state: 'paused' })
    const { view } = renderTab({ entries: [seeded] })
    expect(view.getByRole('heading', { name: 'main CI' })).toBeTruthy()
    expect(view.getByText('每 10 分钟')).toBeTruthy()
    expect(view.getByText('负责人 human')).toBeTruthy()
    expect(view.getByText('共 3 条事件')).toBeTruthy()
    expect(view.getByText('已暂停：连续运行失败（退出码非 0）')).toBeTruthy()
    expect(view.getByRole('button', { name: '运行记录 · main CI' })).toBeTruthy()
    expect(view.getByRole('button', { name: '脚本 · main CI' })).toBeTruthy()
    const labels = view.getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent ?? '')
    expect(labels.filter(label => AUTHORING_CONTROLS.test(label))).toEqual([])
    expect(view.getByText(/订阅由项目负责人维护/)).toBeTruthy()
  })

  it('keeps the fact line free of a zero count it would otherwise state twice', () => {
    const fresh = renderTab({ entries: [entry()] })
    expect(fresh.view.getByText('还没有运行记录')).toBeTruthy()
    expect(fresh.view.queryByText(/共 0 条事件/)).toBeNull()
    cleanup()

    const published = renderTab({ entries: [entry({ eventCount: 2 })] })
    expect(published.view.getByText('共 2 条事件')).toBeTruthy()
  })

  it('expands a run into its output tails, and shows no expander when the Host withheld them', async () => {
    const { view } = renderTab({ entries: [entry()] })
    fireEvent.click(view.getByRole('button', { name: '运行记录 · main CI' }))
    const dialog = await view.findByRole('dialog', { name: '运行记录 · main CI' })
    await waitFor(() => expect(dialog.textContent).toContain('成功'))
    // The row is the disclosure: its accessible name is the run it describes,
    // not a verb parked at the row's far edge.
    const row = dialog.querySelector('[data-team-subscription-run]') as HTMLElement
    const head = within(row).getByRole('button')
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.textContent).toContain('成功')
    expect(head.textContent).not.toMatch(/展开|收起/)
    fireEvent.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(dialog.textContent).toContain('stdout 末尾')
    expect(dialog.textContent).toContain('{"id":"a","title":"A"}')
    // An empty stream is one line of text, not a code block saying nothing ran.
    expect(dialog.textContent).toContain('stderr 末尾（空）')
    expect(dialog.querySelectorAll('pre')).toHaveLength(1)
    fireEvent.click(head)
    expect(dialog.textContent).not.toContain('stdout 末尾')
    expect(dialog.textContent).not.toContain('stderr 末尾（空）')
    cleanup()

    const summaries = renderTab({
      entries: [entry()],
      host: host({ loadSubscriptionLogs: vi.fn(async () => ({ ok: true as const, value: { subscription: subscription(), runs: [{
        runRef: 'run:1', trigger: 'interval' as const, startedAt: '2026-11-03T02:00:00.000Z', durationMs: 1200,
        category: 'accepted' as const, succeeded: true, eventCount: 1, exitCode: 0, timedOut: false, subscriptionRevision: 3,
      }] } })) }),
    })
    fireEvent.click(summaries.view.getByRole('button', { name: '运行记录 · main CI' }))
    const summaryDialog = await summaries.view.findByRole('dialog', { name: '运行记录 · main CI' })
    await waitFor(() => expect(summaryDialog.querySelector('[data-team-subscription-run] button')).toBeNull())
  })

  it('reports a withheld stream as withheld, never as one that printed nothing', async () => {
    const withheld = renderTab({
      entries: [entry()],
      host: host({ loadSubscriptionLogs: vi.fn(async () => ({ ok: true as const, value: { subscription: subscription(), runs: [{
        ...runs[0]!, stderrTail: undefined,
      }] } })) }),
    })
    fireEvent.click(withheld.view.getByRole('button', { name: '运行记录 · main CI' }))
    const dialog = await withheld.view.findByRole('dialog', { name: '运行记录 · main CI' })
    await waitFor(() => expect(dialog.textContent).toContain('成功'))
    fireEvent.click(within(dialog.querySelector('[data-team-subscription-run]') as HTMLElement).getByRole('button'))
    expect(dialog.textContent).toContain('stdout 末尾')
    expect(dialog.textContent).toContain('{"id":"a","title":"A"}')
    expect(dialog.textContent).not.toContain('stderr')
  })

  /**
   * A test run's outcome already reads `试运行通过`, so naming the trigger there
   * prints the same word twice; a scheduled or webhook run still needs its trigger,
   * because the outcome alone does not say which door the run came through.
   */
  it('names a run trigger only when the outcome does not already name it', async () => {
    const logsWith = (trigger: 'interval' | 'test') => host({
      loadSubscriptionLogs: vi.fn(async () => ({ ok: true as const, value: { subscription: subscription(), runs: [{
        ...runs[0]!, trigger, category: trigger === 'test' ? 'verified' as const : 'accepted' as const, eventCount: 0,
      }] } })),
    })

    const scheduled = renderTab({ entries: [entry()], host: logsWith('interval') })
    fireEvent.click(scheduled.view.getByRole('button', { name: '运行记录 · main CI' }))
    const first = await scheduled.view.findByRole('dialog', { name: '运行记录 · main CI' })
    await waitFor(() => expect(first.textContent).toContain('定时'))
    cleanup()

    const trialled = renderTab({ entries: [entry()], host: logsWith('test') })
    fireEvent.click(trialled.view.getByRole('button', { name: '运行记录 · main CI' }))
    const second = await trialled.view.findByRole('dialog', { name: '运行记录 · main CI' })
    await waitFor(() => expect(second.textContent).toContain('试运行通过'))
    expect(second.textContent).not.toContain('试运行试运行通过')
  })

  it('stops what an owner armed, under the revision it read', async () => {
    const pause = vi.fn(async (_request: AgentTeamSubscriptionStateRequest) => ({ ok: true as const, value: { kind: 'changed' as const, subscription: subscription(), activity: {} } } as never))
    const { view, onChanged } = renderTab({ entries: [entry()], host: host({ pauseSubscription: pause }) })
    fireEvent.click(view.getByRole('button', { name: '暂停 · main CI' }))
    await waitFor(() => expect(pause).toHaveBeenCalledTimes(1))
    expect(pause.mock.calls[0]![0]).toMatchObject({ subscriptionRef: 'subscription:1', expectedRevision: 3 })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    cleanup()

    // A paused subscription offers the one state control that applies.
    const paused = renderTab({ entries: [entry({}, { state: 'paused' })] })
    expect(paused.view.getByRole('button', { name: '恢复 · main CI' })).toBeTruthy()
    expect(paused.view.queryByRole('button', { name: '暂停 · main CI' })).toBeNull()
    cleanup()

    // An archived Project is read-only: the list stays, the controls do not.
    const archived = renderTab({ entries: [entry()], canManage: false })
    expect(archived.view.getByRole('button', { name: '运行记录 · main CI' })).toBeTruthy()
    expect(archived.view.queryByRole('button', { name: '暂停 · main CI' })).toBeNull()
    expect(archived.view.queryByRole('button', { name: '删除 · main CI' })).toBeNull()
  })

  it('keeps the delete dialog open with the Host error when the write is refused', async () => {
    const del = vi.fn(async () => ({ ok: false as const, error: { message: 'stale_revision' } } as never))
    const { view, onChanged } = renderTab({ entries: [entry()], host: host({ deleteSubscription: del }) })
    fireEvent.click(view.getByRole('button', { name: '删除 · main CI' }))
    const dialog = view.getByRole('dialog', { name: '删除订阅：main CI' })
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(dialog.textContent).toContain('stale_revision'))
    expect(onChanged).not.toHaveBeenCalled()
  })
})
