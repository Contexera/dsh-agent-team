import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import { renderInboxNotice, type InboxNoticeInput } from '../src/inbox-notice.ts'
import type {
  AgentTeamMainTimelineEntry, AgentTeamMemberId, AgentTeamMessageRef, AgentTeamProjectRef,
  AgentTeamReminderRef, AgentTeamUnreadMemberReminder,
} from '../src/types.ts'

const workspaceId = 'workspace-1' as WorkspaceId
const projectRef = 'project:pack' as AgentTeamProjectRef
const readerId = 'member:builder' as AgentTeamMemberId
const sender = 'member:human' as AgentTeamMemberId
const reminderRef = 'reminder:review' as AgentTeamReminderRef
const occurredAt = '2026-11-03T16:00:00.000Z'

const reminder: AgentTeamUnreadMemberReminder = {
  reminder: { reminderRef, memberId: readerId, note: 'Review the package', state: 'active', createdAt: occurredAt,
    schedule: { kind: 'every', minutes: 30 } },
  scheduledAt: occurredAt, sequence: 3,
}

const emptyNotice: InboxNoticeInput = {
  notifications: [], main: [], memberReminders: [], surface: [], readerId,
  lookup: {
    printableSender: () => '@human', isProjectOwner: () => false, isFollowingMain: () => true,
    repliesToLine: () => undefined, claimOwner: () => undefined,
  },
}

function mainMessage(sequence: number, body: string, direct: boolean): AgentTeamMainTimelineEntry {
  return { kind: 'message', sequence, occurredAt, unread: true, direct, mentions: direct ? [readerId] : [],
    message: { messageRef: `message:${sequence}` as AgentTeamMessageRef, projectRef, scope: 'main', sender, body, sequence, occurredAt } }
}

describe('Inbox notice output', () => {
  it('keeps the exact mixed-priority copy and attests only the full direct Message', () => {
    const notice = renderInboxNotice({
      ...emptyNotice,
      memberReminders: [reminder],
      main: [{
        project: { projectRef, workspaceId, name: 'Packaging', description: '', createdAtSequence: 1, state: 'active' },
        entries: [mainMessage(1, 'first   ordinary update', false), mainMessage(2, '@builder review now', true)],
      }],
    })

    expect(notice.text).toBe([
      'Team Inbox has unread work.',
      [
        'Workspace: workspace-1',
        'Project: project:pack — Main stream',
        'Scope: Main stream',
        'Your role: follower of this Main stream',
        'Read: team_thread read with workspace workspace-1 and projectRef project:pack',
      ].join('\n'),
      [
        'Direct Main stream mention',
        'Occurred at: 2026-11-04T00:00:00+08:00',
        'From: @human',
        'Project: project:pack',
        'Message ref: message:2',
        'Message: @builder review now',
      ].join('\n'),
      'Team reminder, private to you',
      [
        'You asked to be reminded of this yourself, with team_reminder.',
        'Note: Review the package',
        'Schedule: every 30 minutes',
        'Occurred at: 2026-11-04T00:00:00+08:00',
        'Reminder: reminder:review',
        'This reminder is now in your context; act on it, and nothing further is owed for this occurrence.',
      ].join('\n'),
      'Main stream: 1 unread update · Project project:pack · newest at 2026-11-04T00:00:00+08:00.\n- @human: first ordinary update · 2026-11-04T00:00:00+08:00',
      'Use team_thread read with the relevant workspace and projectRef for missing Main stream context and to acknowledge updates. Complete facts shown here can support a post, but do not mark them read.',
    ].join('\n\n'))
    expect(notice.messages).toEqual([{ projectRef, messageRef: 'message:2', body: '@builder review now' }])
    expect(notice.deliveredReminders).toEqual([{ reminderRef, sequence: 3 }])
  })

  it('does not consume a private reminder when only its header fits after the recovery prefix', () => {
    const notice = renderInboxNotice({ ...emptyNotice, memberReminders: [reminder], prefix: '🧰'.repeat(15_310) })

    expect(notice.text).toBe([
      'Team Inbox has unread work.',
      'Team reminder, private to you',
      'More unread work remains in team_inbox; the automatic context is bounded.',
    ].join('\n\n'))
    expect(notice.deliveredReminders).toEqual([])
  })
})
