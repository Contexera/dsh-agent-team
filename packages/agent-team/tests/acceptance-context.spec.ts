import { describe, expect, it } from 'vitest'
import {
  ACCEPTANCE_COMPACT_TOKENS,
  acceptanceReminderText,
  createAcceptanceReminder,
  planAcceptanceContext,
} from '../src/acceptance-context.ts'
import { TEAM_ACCEPTANCE_NOTICE_SUMMARY, isAcceptanceNotice } from '../src/context-projection.ts'

const plan = (usageTokens: number | undefined, canCompact = true) => planAcceptanceContext({ usageTokens, canCompact })

describe('the acceptance context boundary', () => {
  it('reminds below the budget and compacts at or above it', () => {
    expect(plan(ACCEPTANCE_COMPACT_TOKENS - 1)).toEqual({
      action: 'remind',
      usageTokens: ACCEPTANCE_COMPACT_TOKENS - 1,
    })
    expect(plan(ACCEPTANCE_COMPACT_TOKENS)).toEqual({
      action: 'compact',
      usageTokens: ACCEPTANCE_COMPACT_TOKENS,
    })
    expect(plan(ACCEPTANCE_COMPACT_TOKENS * 4).action).toBe('compact')
  })

  it('only reminds when the context cannot be priced', () => {
    expect(plan(undefined)).toEqual({ action: 'remind' })
  })

  it('never promises a compaction the preset cannot run', () => {
    expect(plan(ACCEPTANCE_COMPACT_TOKENS * 4, false)).toEqual({
      action: 'remind',
      usageTokens: ACCEPTANCE_COMPACT_TOKENS * 4,
    })
  })

  it('promises compaction only when the Host will actually compact', () => {
    expect(acceptanceReminderText('remind')).not.toContain('compacted')
    expect(acceptanceReminderText('compact')).toContain('compacted once the Agent settles')
  })

  it('frames the reminder as injected context and stays readable back from the log', () => {
    const message = createAcceptanceReminder('compact')
    expect(message.content).toEqual([{ type: 'text', text: acceptanceReminderText('compact') }])
    expect(acceptanceReminderText('remind').startsWith('<system-reminder>')).toBe(true)
    expect(acceptanceReminderText('remind').endsWith('</system-reminder>')).toBe(true)
    expect(isAcceptanceNotice(message)).toBe(true)
    expect(message.source).toMatchObject({ form: 'notice', summary: TEAM_ACCEPTANCE_NOTICE_SUMMARY })
  })

  it('does not claim another Team notice as an acceptance reminder', () => {
    const reminder = createAcceptanceReminder('remind')
    expect(isAcceptanceNotice({ ...reminder, source: { kind: 'user' } } as never)).toBe(false)
    expect(isAcceptanceNotice({ ...reminder, source: { kind: '@wowyuarm/dsh-agent-team', form: 'notice', summary: 'Team Inbox has unread work.' } } as never)).toBe(false)
  })
})
