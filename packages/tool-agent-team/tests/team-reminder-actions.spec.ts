import { describe, expect, it, vi } from 'vitest'
import type { AgentTeamMemberReminder } from '@contexera/dsh-agent-team/types'
import { teamTools, renderText } from './render-text.ts'
import {
  TEST_REMINDER,
  TEST_WORKSPACE,
  callTool,
  createTestToolHost,
  testReminder,
} from './tool-test-host.ts'

/**
 * Execution-level tests for the Member reminder surface: the schedule a model
 * names must reach the Host request in the form the ledger stores it, and the
 * tool must not invent a recipient, because a reminder has exactly one. Renders
 * are covered in `team-tools-render.spec.ts`; these lock the call shape between
 * the tool and the Host, plus the refusals that keep a half-named schedule from
 * becoming a silent reminder that never fires.
 */

const WORKSPACE = TEST_WORKSPACE
const REF = TEST_REMINDER

function reminder(overrides: Partial<AgentTeamMemberReminder> = {}): AgentTeamMemberReminder {
  return testReminder(overrides)
}

const fakeHost = createTestToolHost
const call = callTool

const tool = teamTools().get('team_reminder')!

describe('team_reminder create builds the stored schedule', () => {
  it('passes each schedule kind through as the ledger stores it', async () => {
    for (const [args, schedule] of [
      [{ action: 'create', scheduleKind: 'once', at: '2026-11-04T02:00:00.000Z', note: 'check' }, { kind: 'once', at: '2026-11-04T02:00:00.000Z' }],
      [{ action: 'create', scheduleKind: 'every', minutes: 30, note: 'check' }, { kind: 'every', minutes: 30 }],
      [{ action: 'create', scheduleKind: 'cron', expression: '0 9 * * 1-5', note: 'check' }, { kind: 'cron', expression: '0 9 * * 1-5' }],
    ] as const) {
      const host = fakeHost()
      await call(tool, args, host)
      expect(host.createMemberReminderForAgent.mock.calls[0]![1]).toMatchObject({ schedule, note: 'check', workspaceId: WORKSPACE })
    }
  })

  it('derives a branded reminderRef from the call, because the Host owns identity', async () => {
    const host = fakeHost()
    await call(tool, { action: 'create', scheduleKind: 'once', at: '2026-11-04T02:00:00.000Z', note: 'check' }, host)
    expect(host.createMemberReminderForAgent.mock.calls[0]![1]).toMatchObject({ reminderRef: 'reminder:call%3A1' })
  })

  it('escapes a nested sub-call id, so the derived ref survives the durable schema', async () => {
    // A parallel sub-call's public form is `<parent>:ptc:<n>`; a raw concatenation
    // would put a second colon in the ref, which `agentTeamOperationSchema` refuses.
    const host = fakeHost()
    await call(tool, { action: 'create', scheduleKind: 'once', at: '2026-11-04T02:00:00.000Z', note: 'check' }, host, 'call-1:ptc:2')
    const request = host.createMemberReminderForAgent.mock.calls[0]![1] as { reminderRef: string }
    expect(request.reminderRef).toBe('reminder:call-1%3Aptc%3A2')
    expect(request.reminderRef).toMatch(/^reminder:[^:]+$/)
  })

  it('never sends an actor: the Host reads the caller from the Agent itself', async () => {
    const host = fakeHost()
    await call(tool, { action: 'create', scheduleKind: 'once', at: '2026-11-04T02:00:00.000Z', note: 'check' }, host)
    expect(host.createMemberReminderForAgent.mock.calls[0]![1]).not.toHaveProperty('actor')
  })

  it('reports the reminder it created and how many stay active', async () => {
    const host = fakeHost()
    const result = await call(tool, { action: 'create', scheduleKind: 'once', at: '2026-11-04T02:00:00.000Z', note: 'check' }, host)
    expect(result).toMatchObject({ action: 'create', created: true, cancelled: false, activeCount: 3,
      reminders: [{ reminderRef: REF, state: 'active', schedule: 'once at 2026-11-04T10:00:00+08:00', note: 'check the build' }] })
  })
})

describe('team_reminder refuses a half-named schedule instead of guessing one', () => {
  it('names the missing field of the chosen kind', async () => {
    for (const [args, missing] of [
      [{ action: 'create', scheduleKind: 'once', note: 'check' }, '`at`'],
      [{ action: 'create', scheduleKind: 'every', note: 'check' }, '`minutes`'],
      [{ action: 'create', scheduleKind: 'cron', note: 'check' }, '`expression`'],
      [{ action: 'create', note: 'check' }, 'scheduleKind'],
    ] as const) {
      const host = fakeHost()
      await expect(call(tool, args, host)).rejects.toThrow(new RegExp(`team_reminder create .*needs ${missing}`))
      expect(host.createMemberReminderForAgent).not.toHaveBeenCalled()
    }
  })

  it('leaves a schedule kind outside the three the ledger stores to the parameter schema', async () => {
    const host = fakeHost()
    await expect(call(tool, { action: 'create', scheduleKind: 'yearly', note: 'check' }, host))
      .rejects.toThrow(/"scheduleKind" must be one of \["once","every","cron"\]/)
    expect(host.createMemberReminderForAgent).not.toHaveBeenCalled()
  })

  it('carries the way out with the refusal, so the model can retry the same call', async () => {
    const host = fakeHost()
    await expect(call(tool, { action: 'create', scheduleKind: 'once', note: 'check' }, host))
      .rejects.toThrow(/Choose scheduleKind with that kind's own fields/)
  })

  it('requires a note, since an occurrence with no note is an interruption with no content', async () => {
    const host = fakeHost()
    await expect(call(tool, { action: 'create', scheduleKind: 'once', at: '2026-11-04T02:00:00.000Z' }, host))
      .rejects.toThrow(/team_reminder create needs `note`/)
    await expect(call(tool, { action: 'create', scheduleKind: 'once', at: '2026-11-04T02:00:00.000Z' }, host))
      .rejects.toThrow(/Use the `note` parameter of team_reminder create/)
    expect(host.createMemberReminderForAgent).not.toHaveBeenCalled()
  })

  it('requires a reminderRef to cancel, because a cancel with no target would be a guess', async () => {
    const host = fakeHost()
    await expect(call(tool, { action: 'cancel' }, host)).rejects.toThrow(/team_reminder cancel needs reminderRef/)
    await expect(call(tool, { action: 'cancel' }, host)).rejects.toThrow(/Copy a reminderRef from team_reminder list/)
    expect(host.cancelMemberReminderForAgent).not.toHaveBeenCalled()
  })

  it('rejects the schedule fields on list and cancel, which take no schedule', async () => {
    const host = fakeHost()
    await expect(call(tool, { action: 'cancel', reminderRef: REF, minutes: 30 }, host)).rejects.toThrow(/cancel does not accept minutes/)
    await expect(call(tool, { action: 'list', scheduleKind: 'every' }, host)).rejects.toThrow(/list does not accept scheduleKind/)
  })
})

describe('team_reminder list and cancel', () => {
  it('reads the caller own reminders with no request the Member could redirect', async () => {
    const host = fakeHost()
    await call(tool, { action: 'list' }, host)
    expect(host.memberRemindersForAgent).toHaveBeenCalledTimes(1)
    expect(host.memberRemindersForAgent.mock.calls[0]?.[1]).toEqual({ workspaceId: WORKSPACE })
  })

  it('reports the occurrence facts a view carries', async () => {
    const host = fakeHost({ memberRemindersForAgent: vi.fn((_agent: unknown, _request: unknown) => [{
      reminder: reminder({ schedule: { kind: 'cron', expression: '0 9 * * 1-5' } }),
      lastOccurrenceAt: '2026-11-03T01:00:00.000Z',
      nextOccurrenceAt: '2026-11-04T01:00:00.000Z',
    }]) })
    const result = await call(tool, { action: 'list' }, host) as { reminders: Record<string, string>[] }
    expect(result.reminders[0]).toMatchObject({
      schedule: "cron '0 9 * * 1-5' read in UTC+8",
      lastOccurrenceAt: '2026-11-03T01:00:00.000Z',
      nextOccurrenceAt: '2026-11-04T01:00:00.000Z',
    })
    expect(result.reminders[0]).not.toHaveProperty('pendingOccurrenceAt')
  })

  it('cancels by reminderRef and re-reads how many reminders stay active', async () => {
    const host = fakeHost({ memberRemindersForAgent: vi.fn((_agent: unknown, _request: unknown) => [{ reminder: reminder() }]) })
    const result = await call(tool, { action: 'cancel', reminderRef: REF }, host)
    expect(host.cancelMemberReminderForAgent.mock.calls[0]![1]).toMatchObject({ reminderRef: REF, workspaceId: WORKSPACE })
    expect(host.memberRemindersForAgent).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ action: 'cancel', cancelled: true, created: false, activeCount: 1,
      reminders: [{ reminderRef: REF, state: 'cancelled' }] })
  })

  it('leaves a blank reminderRef to the refusal rather than sending an empty ref', async () => {
    const host = fakeHost()
    await expect(call(tool, { action: 'cancel', reminderRef: '' }, host)).rejects.toThrow(/needs reminderRef/)
    expect(host.cancelMemberReminderForAgent).not.toHaveBeenCalled()
  })
})

describe('team_reminder render', () => {
  it('renders each reminder with its note, its schedule and its occurrence facts', () => {
    const text = renderText(tool, { action: 'list' }, {
      action: 'list', workspaceId: WORKSPACE, created: false, cancelled: false, activeCount: 2,
      reminders: [
        { reminderRef: REF, state: 'active', schedule: 'every 30 minutes', note: 'check the build', createdAt: '2026-11-03T08:00:00.000Z',
          lastOccurrenceAt: '2026-11-03T09:00:00.000Z', nextOccurrenceAt: '2026-11-03T09:30:00.000Z' },
        { reminderRef: 'reminder:aaaa1111-0000-4000-8000-000000000002', state: 'cancelled', schedule: "once at 2026-11-04 10:00",
          note: 'standup', createdAt: '2026-11-03T08:00:00.000Z' },
      ],
    })
    expect(text).toContain(`${REF} · active · every 30 minutes`)
    expect(text).toContain('Note: check the build')
    expect(text).toContain('Last occurrence:')
    expect(text).toContain('Next occurrence:')
    expect(text).toContain('These are your own reminders.')
  })

  it('names the ceiling on create and the withdrawal on cancel', () => {
    const value = (action: string) => ({ action, workspaceId: WORKSPACE, created: action === 'create', cancelled: action === 'cancel', activeCount: 1,
      reminders: [{ reminderRef: REF, state: action === 'create' ? 'active' : 'cancelled', schedule: 'every 30 minutes', note: 'check the build', createdAt: '2026-11-03T08:00:00.000Z' }] })
    expect(renderText(tool, { action: 'create' }, value('create'))).toContain('1 of at most 50 active')
    expect(renderText(tool, { action: 'cancel' }, value('cancel'))).toContain('no further occurrence will fire')
  })
})

describe('team_reminder tolerates the create-only slots a model fills on list and cancel', () => {
  it('still refuses a schedule value that names something the caller never picked', async () => {
    const host = fakeHost()
    for (const extra of [{ at: '2026-11-04T02:00:00.000Z' }, { scheduleKind: 'every' }, { note: 'check the build' }]) {
      await expect(call(tool, { action: 'cancel', reminderRef: REF, ...extra }, host))
        .rejects.toThrow(/cancel does not accept/)
    }
    expect(host.cancelMemberReminderForAgent).not.toHaveBeenCalled()
  })

  // The shape below is copied from a live session, not invented: one cancel sent
  // `minutes: 30` and was refused, then seven retries sent this one and were
  // refused identically, so the caller never left the window.
  it('cancels the retry shape a live session kept sending', async () => {
    const host = fakeHost({ memberRemindersForAgent: vi.fn(() => [{ reminder: reminder() }]) })
    const result = await call(tool, { action: 'cancel', reminderRef: REF, minutes: 0, scheduleKind: 'once', note: '' }, host)
    expect(host.cancelMemberReminderForAgent).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ action: 'cancel', cancelled: true })
    await call(tool, { action: 'list', minutes: 0, scheduleKind: 'once', note: '' }, host)
    // Cancel resolves its own ref through the same read, so the list is the second call.
    expect(host.memberRemindersForAgent).toHaveBeenCalledTimes(2)
  })

  it('still refuses the schedule content that rode beside those blanks', async () => {
    // Dropping blanks must not drop the refusal they travelled with: the same
    // request carrying a real interval is still a schedule this action cannot honor.
    const host = fakeHost()
    await expect(call(tool, { action: 'cancel', reminderRef: REF, minutes: 30, scheduleKind: 'once', note: '' }, host))
      .rejects.toThrow(/cancel does not accept/)
    await expect(call(tool, { action: 'list', minutes: 30, scheduleKind: 'once', note: '' }, host))
      .rejects.toThrow(/list does not accept/)
    expect(host.cancelMemberReminderForAgent).not.toHaveBeenCalled()
    expect(host.memberRemindersForAgent).not.toHaveBeenCalled()
  })
})
