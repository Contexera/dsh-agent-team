// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { AgentTeamCreateSubscriptionRequest, AgentTeamMemberId, AgentTeamProjectRef, AgentTeamSubscription, AgentTeamSubscriptionDeliveriesRequest, AgentTeamSubscriptionDraftTrialRequest, AgentTeamSubscriptionListEntry, AgentTeamSubscriptionReplayRequest, AgentTeamSubscriptionStateRequest } from '@contexera/dsh-agent-team/types'
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

function host(overrides: Partial<TeamSubscriptionsTabProps['host']> = {}): TeamSubscriptionsTabProps['host'] {
  return {
    loadSubscriptionLogs: vi.fn(async () => ({ ok: true as const, value: { subscription: subscription(), runs } })),
    testSubscriptionDraft: vi.fn(async () => ({ ok: true as const, value: { kind: 'tested' as const, events: [], stdoutTail: '', stderrTail: '', scriptHash: 'b'.repeat(64), revision: 3 } })),
    createSubscription: vi.fn(async () => ({ ok: false as const, error: { message: 'not used' } } as never)),
    updateSubscription: vi.fn(async () => ({ ok: false as const, error: { message: 'not used' } } as never)),
    pauseSubscription: vi.fn(async () => ({ ok: false as const, error: { message: 'not used' } } as never)),
    resumeSubscription: vi.fn(async () => ({ ok: false as const, error: { message: 'not used' } } as never)),
    deleteSubscription: vi.fn(async () => ({ ok: false as const, error: { message: 'not used' } } as never)),
    resetSubscriptionWebhook: vi.fn(async () => ({ ok: false as const, error: { message: 'not used' } } as never)),
    loadSubscriptionDeliveries: vi.fn(async () => ({ ok: true as const, value: { deliveries: [] } })),
    replaySubscriptionDelivery: vi.fn(async () => ({ ok: false as const, error: { message: 'not used' } } as never)),
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

    const empty = renderTab()
    expect(empty.view.getByText('还没有订阅')).toBeTruthy()
    fireEvent.click(empty.view.getByRole('button', { name: '新建订阅' }))
    expect(empty.view.getByRole('dialog', { name: '新建订阅' })).toBeTruthy()
    cleanup()

    // An empty list still says why nothing can be created here.
    const readOnly = renderTab({ canManage: false })
    expect(readOnly.view.getByText('只读：这个项目已归档，不能修改订阅。')).toBeTruthy()
    expect(readOnly.view.queryByRole('button', { name: '新建订阅' })).toBeNull()
  })

  it('reads a card from the Host projection and hides every write from a read-only viewer', () => {
    const seeded = entry({
      eventCount: 3, lastEventAt: '2026-11-03T02:10:00.000Z',
      lastRun: { ...runs[0]!, runRef: 'run:2', startedAt: '2026-11-03T02:20:00.000Z', category: 'exit-code', succeeded: false },
      nextRunAt: '2026-11-03T02:30:00.000Z',
    }, { pausedReason: 'failures', state: 'paused' })
    const { view } = renderTab({ entries: [seeded], canManage: false })
    expect(view.getByRole('heading', { name: 'main CI' })).toBeTruthy()
    expect(view.getByText('每 10 分钟')).toBeTruthy()
    expect(view.getByText('建立者 human')).toBeTruthy()
    expect(view.getByText('共 3 条事件')).toBeTruthy()
    expect(view.getByText('已暂停：连续运行失败（退出码非 0）')).toBeTruthy()
    expect(view.queryByRole('button', { name: /^编辑 ·/ })).toBeNull()
    expect(view.queryByRole('button', { name: /^暂停 ·/ })).toBeNull()
    expect(view.queryByRole('button', { name: /^删除 ·/ })).toBeNull()
    expect(view.getByRole('button', { name: '运行记录 · main CI' })).toBeTruthy()
    expect(view.getByRole('button', { name: '脚本 · main CI' })).toBeTruthy()
    expect(view.getByText('只读：这个项目已归档，不能修改订阅。')).toBeTruthy()
  })

  it('expands a run into its output tails, and shows no expander when the Host withheld them', async () => {
    const { view } = renderTab({ entries: [entry()] })
    fireEvent.click(view.getByRole('button', { name: '运行记录 · main CI' }))
    const dialog = await view.findByRole('dialog', { name: '运行记录 · main CI' })
    await waitFor(() => expect(dialog.textContent).toContain('成功'))
    fireEvent.click(view.getByRole('button', { name: /^展开 ·/ }))
    expect(dialog.textContent).toContain('stdout 末尾')
    expect(dialog.textContent).toContain('{"id":"a","title":"A"}')
    expect(dialog.textContent).toContain('（空）')
    fireEvent.click(view.getByRole('button', { name: /^收起 ·/ }))
    expect(dialog.textContent).not.toContain('stdout 末尾')
    cleanup()

    const summaries = renderTab({
      entries: [entry()],
      host: host({ loadSubscriptionLogs: vi.fn(async () => ({ ok: true as const, value: { subscription: subscription(), runs: [{
        runRef: 'run:1', trigger: 'interval' as const, startedAt: '2026-11-03T02:00:00.000Z', durationMs: 1200,
        category: 'accepted' as const, succeeded: true, eventCount: 1, exitCode: 0, timedOut: false, subscriptionRevision: 3,
      }] } })) }),
    })
    fireEvent.click(summaries.view.getByRole('button', { name: '运行记录 · main CI' }))
    await summaries.view.findByRole('dialog', { name: '运行记录 · main CI' })
    await waitFor(() => expect(summaries.view.queryByRole('button', { name: /^展开 ·/ })).toBeNull())
  })

  it('keeps Save behind a trial of the current form and retires that pass on the next edit', async () => {
    const testDraft = vi.fn(async () => ({ ok: true as const, value: { kind: 'tested' as const, events: [], stdoutTail: '', stderrTail: '', scriptHash: 'b'.repeat(64), revision: 1 } }))
    const create = vi.fn(async (_request: AgentTeamCreateSubscriptionRequest) => ({ ok: true as const, value: { kind: 'changed' as const, subscription: subscription(), activity: {} } } as never))
    const { view, onChanged } = renderTab({ host: host({ testSubscriptionDraft: testDraft, createSubscription: create }) })
    fireEvent.click(view.getByRole('button', { name: '新建订阅' }))
    const dialog = view.getByRole('dialog', { name: '新建订阅' })
    const save = view.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(dialog.querySelector('input')!, { target: { value: 'nightly' } })
    fireEvent.change(dialog.querySelector('input[type="number"]')!, { target: { value: '15' } })
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'printf events\n' } })
    expect(save.disabled).toBe(true)
    fireEvent.click(view.getByRole('button', { name: '试运行' }))
    await waitFor(() => expect(save.disabled).toBe(false))
    // One keystroke after the pass: the old verdict cannot save this form.
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'printf other\n' } })
    expect(save.disabled).toBe(true)
    fireEvent.click(view.getByRole('button', { name: '试运行' }))
    await waitFor(() => expect(save.disabled).toBe(false))
    fireEvent.click(save)
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![0]).toMatchObject({ name: 'nightly', intervalMinutes: 15, script: { scriptContent: 'printf other\n' } })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  /**
   * A pass describes the latest trial, not any trial: the same form passing and
   * then failing (or not being answerable at all) must leave Save locked, or the
   * button would still be unlocked by a verdict the reader has just replaced.
   */
  it('retires a passing trial the moment the next attempt fails or cannot be asked', async () => {
    const testDraft = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, value: { kind: 'tested' as const, events: [], stdoutTail: '', stderrTail: '', scriptHash: 'b'.repeat(64), revision: 1 } })
      .mockResolvedValueOnce({ ok: true as const, value: { kind: 'trial-failed' as const, failure: { reason: 'gh: HTTP 502', stdoutTail: '', stderrTail: '' }, scriptHash: 'b'.repeat(64), revision: 1 } })
      .mockResolvedValueOnce({ ok: false as const, error: { message: 'offline' } })
    const create = vi.fn(async () => ({ ok: true as const, value: { kind: 'changed' as const, subscription: subscription(), activity: {} } } as never))
    const { view } = renderTab({ host: host({ testSubscriptionDraft: testDraft, createSubscription: create }) })
    fireEvent.click(view.getByRole('button', { name: '新建订阅' }))
    const dialog = view.getByRole('dialog', { name: '新建订阅' })
    fireEvent.change(dialog.querySelector('input')!, { target: { value: 'nightly' } })
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'printf events\n' } })
    const save = view.getByRole('button', { name: '保存' }) as HTMLButtonElement
    fireEvent.click(view.getByRole('button', { name: '试运行' }))
    await waitFor(() => expect(save.disabled).toBe(false))

    fireEvent.click(view.getByRole('button', { name: '试运行' }))
    await waitFor(() => expect(dialog.textContent).toContain('gh: HTTP 502'))
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(create).not.toHaveBeenCalled()

    fireEvent.click(view.getByRole('button', { name: '试运行' }))
    await waitFor(() => expect(dialog.textContent).toContain('offline'))
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(create).not.toHaveBeenCalled()
  })

  it('leaves the form intact and shows the tails when the trial refuses it', async () => {
    const testDraft = vi.fn(async () => ({ ok: true as const, value: { kind: 'trial-failed' as const, failure: {
      reason: 'the script exited with 1', stdoutTail: 'partial', stderrTail: 'boom',
    }, scriptHash: 'c'.repeat(64), revision: 1 } }))
    const create = vi.fn(async () => ({ ok: false as const, error: { message: 'not reached' } } as never))
    const { view } = renderTab({ host: host({ testSubscriptionDraft: testDraft, createSubscription: create }) })
    fireEvent.click(view.getByRole('button', { name: '新建订阅' }))
    const dialog = view.getByRole('dialog', { name: '新建订阅' })
    fireEvent.change(dialog.querySelector('input')!, { target: { value: 'nightly' } })
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'exit 1\n' } })
    fireEvent.click(view.getByRole('button', { name: '试运行' }))
    await waitFor(() => expect(dialog.textContent).toContain('the script exited with 1'))
    expect((dialog.querySelector('textarea') as HTMLTextAreaElement).value).toBe('exit 1\n')
    expect((view.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true)
    expect(create).not.toHaveBeenCalled()
  })

  it('names both triggers on a card, and arms a webhook-only subscription from the form', async () => {
    const arm = { tokenHash: 'b'.repeat(64), generation: 1, armedAt: '2026-11-04T02:00:00.000Z' }
    const both = entry({}, { triggers: { interval: { minutes: 10 }, webhook: true }, webhook: arm })
    const readOnly = renderTab({ entries: [both], canManage: false })
    expect(readOnly.view.getByText('每 10 分钟 · webhook')).toBeTruthy()
    // Nobody but an owner can move the address, and a subscription without one has no button.
    expect(readOnly.view.queryByRole('button', { name: /^重置地址/ })).toBeNull()
    cleanup()
    const armed = renderTab({ entries: [{ ...both, subscription: { ...both.subscription, triggers: { webhook: true } } }] })
    expect(armed.view.getByText('webhook')).toBeTruthy()
    expect(armed.view.getByRole('button', { name: '重置地址 · main CI' })).toBeTruthy()
    cleanup()

    const testDraft = vi.fn(async (_request: AgentTeamSubscriptionDraftTrialRequest) => ({ ok: true as const, value: { kind: 'tested' as const, events: [], stdoutTail: '', stderrTail: '', scriptHash: 'b'.repeat(64), revision: 1 } }))
    const create = vi.fn(async (_request: AgentTeamCreateSubscriptionRequest) => ({ ok: true as const, value: { kind: 'changed' as const,
      subscription: subscription(), activity: {}, webhookAddress: 'https://team.example.com/team/hooks/abc' } } as never))
    const form = renderTab({ host: host({ testSubscriptionDraft: testDraft, createSubscription: create }) })
    fireEvent.click(form.view.getByRole('button', { name: '新建订阅' }))
    const dialog = form.view.getByRole('dialog', { name: '新建订阅' })
    // Untick the timer and tick the webhook: the form asks for one trigger, not a made-up interval.
    fireEvent.click(dialog.querySelectorAll('input[type="checkbox"]')[0]!)
    fireEvent.click(dialog.querySelectorAll('input[type="checkbox"]')[1]!)
    expect(dialog.querySelector('input[type="number"]')).toBeNull()
    fireEvent.change(dialog.querySelector('input:not([type])')!, { target: { value: 'hooks only' } })
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'json-body\n' } })
    fireEvent.click(form.view.getByRole('button', { name: '试运行' }))
    await waitFor(() => expect((form.view.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false))
    expect(testDraft.mock.calls[0]![0]).toMatchObject({ webhook: true, name: 'hooks only' })
    expect(testDraft.mock.calls[0]![0]).not.toHaveProperty('intervalMinutes')
    fireEvent.click(form.view.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    // The address the save armed is shown once, with the way to keep it.
    const address = await form.view.findByRole('dialog', { name: 'Webhook 地址 · hooks only' })
    expect(address.textContent).toContain('https://team.example.com/team/hooks/abc')
    expect(address.textContent).toContain('完整地址只显示这一次')
    // The dialog carries its own close control beside the header's.
    fireEvent.click(form.view.getAllByRole('button', { name: '关闭' })[0]!)
    await waitFor(() => expect(form.view.queryByRole('dialog', { name: 'Webhook 地址 · hooks only' })).toBeNull())
    expect(form.view.queryByText('https://team.example.com/team/hooks/abc')).toBeNull()
  })

  it('tells the reader a retried save cannot fetch the address again', async () => {
    const testDraft = vi.fn(async (_request: AgentTeamSubscriptionDraftTrialRequest) => ({ ok: true as const, value: { kind: 'tested' as const, events: [], stdoutTail: '', stderrTail: '', scriptHash: 'b'.repeat(64), revision: 1 } }))
    const create = vi.fn(async (_request: AgentTeamCreateSubscriptionRequest) => ({ ok: true as const, value: { kind: 'changed' as const,
      subscription: subscription(), activity: {}, webhookAddressGone: true } } as never))
    const form = renderTab({ host: host({ testSubscriptionDraft: testDraft, createSubscription: create }) })
    fireEvent.click(form.view.getByRole('button', { name: '新建订阅' }))
    const dialog = form.view.getByRole('dialog', { name: '新建订阅' })
    fireEvent.click(dialog.querySelectorAll('input[type="checkbox"]')[0]!)
    fireEvent.click(dialog.querySelectorAll('input[type="checkbox"]')[1]!)
    fireEvent.change(dialog.querySelector('input:not([type])')!, { target: { value: 'hooks only' } })
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'json-body\n' } })
    fireEvent.click(form.view.getByRole('button', { name: '试运行' }))
    await waitFor(() => expect((form.view.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(form.view.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const gone = await form.view.findByRole('dialog', { name: 'Webhook 地址已不可取回 · hooks only' })
    expect(gone.textContent).toContain('无法再次取回')
  })

  it('lists the deliveries whose retries are spent, and replays one into the ledger', async () => {
    const delivery = { deliveryRef: 'delivery:d1', receivedRevision: 3, receivedScriptHash: 'a'.repeat(64),
      receivedAt: '2026-11-04T02:00:00.000Z', expiresAt: '2026-11-11T02:00:00.000Z', attempts: 4,
      lastError: 'the script exited with code 1' }
    const load = vi.fn(async (_request: AgentTeamSubscriptionDeliveriesRequest) => ({ ok: true as const, value: { deliveries: [delivery] } }))
    const replay = vi.fn(async (_request: AgentTeamSubscriptionReplayRequest) => ({ ok: true as const, value: {
      kind: 'replayed' as const, delivery, runRef: 'run:9', eventCount: 2 } }))
    const { view, onChanged } = renderTab({ entries: [entry()], host: host({ loadSubscriptionDeliveries: load, replaySubscriptionDelivery: replay }) })
    fireEvent.click(view.getByRole('button', { name: '失败投递 · main CI' }))
    const dialog = await view.findByRole('dialog', { name: '失败投递 · main CI' })
    await waitFor(() => expect(dialog.textContent).toContain('delivery:d1'))
    expect(dialog.textContent).toContain('4 次尝试')
    expect(dialog.textContent).toContain('最后一次错误：the script exited with code 1')
    fireEvent.click(view.getByRole('button', { name: '重放 · delivery:d1' }))
    await waitFor(() => expect(replay).toHaveBeenCalledTimes(1))
    expect(replay.mock.calls[0]![0]).toMatchObject({ subscriptionRef: 'subscription:1', deliveryRef: 'delivery:d1' })
    await waitFor(() => expect(dialog.textContent).toContain('重放成功：2 条事件'))
    expect(onChanged).toHaveBeenCalled()
    cleanup()

    // A read-only viewer has no list to open: a record carries the request body.
    const readOnly = renderTab({ entries: [entry()], canManage: false })
    expect(readOnly.view.queryByRole('button', { name: /^失败投递/ })).toBeNull()
    cleanup()

    const empty = renderTab({ entries: [entry()] })
    fireEvent.click(empty.view.getByRole('button', { name: '失败投递 · main CI' }))
    const none = await empty.view.findByRole('dialog', { name: '失败投递 · main CI' })
    await waitFor(() => expect(none.textContent).toContain('没有失败投递'))
  })

  it('lets an owner replay a delivery under the version it arrived with', async () => {
    const delivery = { deliveryRef: 'delivery:d1', receivedRevision: 3, receivedScriptHash: 'a'.repeat(64),
      receivedAt: '2026-11-04T02:00:00.000Z', expiresAt: '2026-11-11T02:00:00.000Z', attempts: 4, lastError: 'the script exited with code 1' }
    const load = vi.fn(async () => ({ ok: true as const, value: { deliveries: [delivery] } }))
    const replay = vi.fn(async (_request: AgentTeamSubscriptionReplayRequest) => ({ ok: true as const, value: {
      kind: 'replayed' as const, delivery, runRef: 'run:9', eventCount: 2 } }))
    const { view } = renderTab({ entries: [entry()], host: host({ loadSubscriptionDeliveries: load, replaySubscriptionDelivery: replay }) })
    fireEvent.click(view.getByRole('button', { name: '失败投递 · main CI' }))
    await view.findByRole('dialog', { name: '失败投递 · main CI' })
    fireEvent.click(view.getByLabelText('接收时的版本（复现当时的行为）'))
    fireEvent.click(view.getByRole('button', { name: '重放 · delivery:d1' }))
    await waitFor(() => expect(replay).toHaveBeenCalledTimes(1))
    expect(replay.mock.calls[0]![0]).toMatchObject({ version: 'received', deliveryRef: 'delivery:d1' })
  })

  it('moves the address under the revision it read, and keeps the dialog shut when the Host refuses', async () => {
    const hooked = entry({}, { triggers: { webhook: true },
      webhook: { tokenHash: 'b'.repeat(64), generation: 1, armedAt: '2026-11-04T02:00:00.000Z' } })
    const reset = vi.fn(async (_request: AgentTeamSubscriptionStateRequest) => ({ ok: true as const, value: { kind: 'changed' as const,
      subscription: subscription(), activity: {}, webhookAddress: 'https://team.example.com/team/hooks/next' } } as never))
    const { view, onChanged } = renderTab({ entries: [hooked], host: host({ resetSubscriptionWebhook: reset }) })
    fireEvent.click(view.getByRole('button', { name: '重置地址 · main CI' }))
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1))
    expect(reset.mock.calls[0]![0]).toMatchObject({ subscriptionRef: 'subscription:1', expectedRevision: 3 })
    const dialog = await view.findByRole('dialog', { name: 'Webhook 地址 · main CI' })
    expect(dialog.textContent).toContain('https://team.example.com/team/hooks/next')
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    cleanup()

    const refused = vi.fn(async () => ({ ok: false as const, error: { message: 'stale_revision' } } as never))
    const failing = renderTab({ entries: [hooked], host: host({ resetSubscriptionWebhook: refused }) })
    fireEvent.click(failing.view.getByRole('button', { name: '重置地址 · main CI' }))
    await waitFor(() => expect(failing.view.getByRole('alert').textContent).toContain('重置失败：stale_revision'))
    expect(failing.view.queryByRole('dialog', { name: /Webhook 地址/ })).toBeNull()
  })

  it('keeps the delete dialog open with the Host error when the write is refused', async () => {
    const del = vi.fn(async () => ({ ok: false as const, error: { message: 'stale_revision' } } as never))
    const { view, onChanged } = renderTab({ entries: [entry()], host: host({ deleteSubscription: del }) })
    fireEvent.click(view.getByRole('button', { name: '删除 · main CI' }))
    const dialog = view.getByRole('dialog', { name: '删除订阅：main CI' })
    fireEvent.click(view.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(dialog.textContent).toContain('stale_revision'))
    expect(onChanged).not.toHaveBeenCalled()
  })
})
