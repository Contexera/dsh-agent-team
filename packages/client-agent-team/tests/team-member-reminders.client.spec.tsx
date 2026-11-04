// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentTeamMemberId, AgentTeamMemberReminderView, AgentTeamReminderRef } from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { MemberRemindersSection } from '../src/client/TeamMemberEditor.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const WORKSPACE = 'workspace:40459c33-743d-4030-9e50-9419d72abe06' as WorkspaceId
const MEMBER = 'member:b138210c-6534-4e6d-a419-af161f54d459' as AgentTeamMemberId
const ACTIVE = 'reminder:0f0a1b2c-3d4e-4f50-8a9b-0c1d2e3f4a5b' as AgentTeamReminderRef
const DONE = 'reminder:aaaa1111-0000-4000-8000-000000000002' as AgentTeamReminderRef

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as Parameters<typeof MemberRemindersSection>[0]['t']

function view(overrides: Partial<AgentTeamMemberReminderView> = {}): AgentTeamMemberReminderView {
  return {
    reminder: {
      reminderRef: ACTIVE,
      memberId: MEMBER,
      schedule: { kind: 'every', minutes: 30 },
      note: 'check the build',
      state: 'active',
      createdAt: '2026-11-03T08:00:00.000Z',
    },
    nextOccurrenceAt: '2026-11-03T09:30:00.000Z',
    ...overrides,
  }
}

const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true, value }) as RemoteResult<T>
const refused = (message: string): RemoteResult<never> => ({ ok: false, error: { message } }) as RemoteResult<never>

function harness(overrides: { readonly load?: () => Promise<RemoteResult<readonly AgentTeamMemberReminderView[]>>, readonly cancel?: () => Promise<RemoteResult<unknown>> } = {}) {
  const load = vi.fn(async (_request: unknown) => (overrides.load ?? (async () => ok([view()])))())
  const cancel = vi.fn(async (_request: unknown) => (overrides.cancel ?? (async () => ok({ reminder: view({ reminder: { ...view().reminder, state: 'cancelled' } }) })))())
  render(
    <MemberRemindersSection
      workspaceId={WORKSPACE}
      memberId={MEMBER}
      loadMemberReminders={load as never}
      cancelMemberReminder={cancel as never}
      disabled={false}
      t={t}
    />,
  )
  return { load, cancel }
}

/** The declared facts of one row, read as the one line the row renders them as. */
const factLine = (note: string, index = 0): string => screen.getAllByText(note)[index]?.closest('li')?.querySelector('p')?.textContent ?? ''

describe('Member detail reminder list', () => {
  it('reads the Member own reminders with the Member and Workspace the detail is open on', async () => {
    const { load } = harness()
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(1) })
    expect(load.mock.calls[0]?.[0]).toMatchObject({ workspaceId: WORKSPACE, memberId: MEMBER })
  })

  it('renders the note, the stored schedule, the state and the next occurrence', async () => {
    harness()
    expect(await screen.findByText('check the build')).toBeTruthy()
    const facts = factLine('check the build')
    expect(facts).toContain('每 30 分钟')
    expect(facts).toContain('生效中')
    expect(facts).toContain('下次：2026-11-03 17:30')
  })

  it('names the zone a cron expression is read in, because the Member wrote it against UTC+8', async () => {
    harness({ load: async () => ok([view({ reminder: { ...view().reminder, schedule: { kind: 'cron', expression: '0 9 * * 1-5' } } })]) })
    await screen.findByText('check the build')
    const facts = factLine('check the build')
    expect(facts).toContain("cron '0 9 * * 1-5'，按 UTC+8 读取")
    expect(facts).toContain('生效中')
  })

  it('shows a pending occurrence as waiting to be read, since that is what wakes the Member', async () => {
    harness({ load: async () => ok([view({ pendingOccurrenceAt: '2026-11-03T01:00:00.000Z', nextOccurrenceAt: '2026-11-03T09:30:00.000Z' })]) })
    expect(await screen.findByText('待读取，始于：2026-11-03 09:00')).toBeTruthy()
  })

  it('offers a withdraw button only on a reminder that can still fire', async () => {
    harness({ load: async () => ok([view(), view({ reminder: { ...view().reminder, reminderRef: DONE, state: 'done' } })]) })
    await waitFor(() => { expect(screen.getAllByRole('button', { name: /^取消提醒 · / })).toHaveLength(1) })
    // The control names the row it withdraws, so two reminders never read alike.
    expect(screen.getByRole('button', { name: '取消提醒 · check the build' })).toBeTruthy()
    expect(factLine('check the build', 1)).toContain('已触发')
  })

  it('says so when the Member set no reminder at all', async () => {
    harness({ load: async () => ok([]) })
    expect(await screen.findByText('这个 Agent 还没有给自己设过提醒。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^取消提醒 · / })).toBeNull()
  })
})

describe('Member detail reminder withdrawal', () => {
  it('sends the reminderRef and re-reads the list, so no row is an optimistic guess', async () => {
    let read = 0
    const { cancel } = harness({
      load: async () => { read += 1; return ok(read === 1 ? [view()] : [view({ reminder: { ...view().reminder, state: 'cancelled' } })]) },
      cancel: async () => ok({}),
    })
    fireEvent.click(await screen.findByRole('button', { name: /^取消提醒 · / }))
    await waitFor(() => { expect(cancel).toHaveBeenCalledTimes(1) })
    expect(cancel.mock.calls[0]?.[0]).toMatchObject({ workspaceId: WORKSPACE, reminderRef: ACTIVE })
    // The row keeps its withdraw affordance until the Host answers with the cancelled state.
    await waitFor(() => { expect(screen.queryByRole('button', { name: /^取消提醒 · / })).toBeNull() })
    expect(factLine('check the build')).toContain('已取消')
  })

  it('keeps the answered refusal visible with a retry that re-reads, and leaves the row withdrawable', async () => {
    let read = 0
    const { cancel, load } = harness({
      load: async () => { read += 1; return ok([view()]) },
      cancel: async () => refused('Reminder is already cancelled'),
    })
    fireEvent.click(await screen.findByRole('button', { name: /^取消提醒 · / }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Reminder is already cancelled')
    // The failed withdrawal leaves the row as the Host still holds it.
    expect(screen.getByRole('button', { name: /^取消提醒 · / })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('Member detail reminder read failure', () => {
  it('turns a refused read into a retryable error instead of endless loading', async () => {
    const { load } = harness({ load: async () => refused('Member does not participate') })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('正在读取提醒…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  })

  it('reports a read that dies mid-call the same way', async () => {
    const { load } = harness({ load: async () => { throw new Error('transport died mid-call') } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('transport died mid-call')
    expect(load).toHaveBeenCalledTimes(1)
  })
})
