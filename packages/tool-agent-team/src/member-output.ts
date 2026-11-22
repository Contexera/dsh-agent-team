import type { DefineToolOptions } from '@deepseek-ai/dsh-tools'
import { teamMessageSurface } from '@contexera/dsh-agent-team/host'
import { formatTeamTimestamp } from '@contexera/dsh-agent-team/time-format'
import { recoveryFor } from '@contexera/dsh-agent-team/recovery-hints'
import type { AgentTeamAttentionSource, AgentTeamReminderSchedule, AgentTeamTaskBoardItem } from '@contexera/dsh-agent-team/types'
import { MAIN_ENTRY_SCHEMA, mainEntryLine } from './main-stream.ts'
import type { MainEntryView } from './main-stream.ts'
import { activityFromView } from './activity-view.ts'
import { activityBindings, nextWriteLine, taskStanding, FACT_SCHEMA, messageIdentities, REMINDER_SCHEMA, factLine, claimLine } from './thread-output.ts'
import type { FactView, RejectedFact } from './thread-output.ts'

const REJECTION_FACT_LIMIT = 20

const REJECTION_BODY_MAX_CHARACTERS = 8 * 1024

const REJECTION_MAX_CHARACTERS = 16 * 1024

const REJECTION_BODY_TRUNCATION_MARKER = '[Message body truncated; the full change is not shown here.]'

interface ThreadRejection {
  readonly kind: string
  readonly threadRef?: string
  readonly taskRef?: string
  readonly unreadCount?: number
  readonly directCount?: number
  readonly revision?: number
  readonly staleTokenKind?: 'unknown' | 'unrecognized'
  readonly facts?: readonly RejectedFact[]
}

function renderRejection(value: ThreadRejection) {
  const identity = [value.threadRef, value.taskRef].filter(part => part !== undefined).join(' · ')
  if (value.kind !== 'unread_required' && value.kind !== 'stale_revision') {
    return { text: [`Not committed — ${value.kind}.`, identity === '' ? 'No message was added.' : `${identity} — no message was added.`].join('\n'), messages: [] }
  }
  const facts = value.facts ?? []
  const unrecognized = value.staleTokenKind === 'unrecognized'
  const shown: RejectedFact[] = []
  const completeFacts: RejectedFact[] = []
  let truncated = false
  const lines = () => {
    const allShown = !unrecognized && !truncated && shown.length === facts.length
      && (value.kind !== 'unread_required' || facts.length === value.unreadCount)
    // A token only helps if the reader has a known baseline and can bind every shown fact.
    const canReconsider = allShown && value.staleTokenKind === undefined
      && facts.every(fact => fact.kind === 'message' ? fact.messageRef !== undefined : activityFromView(fact) !== undefined)
    const headline = value.kind === 'unread_required' ? 'Not committed — unread_required.'
      : unrecognized ? 'Not committed — that write token was never a revision this Thread reached (stale_revision).'
        : value.staleTokenKind === 'unknown' ? 'Not committed — the write token does not establish a known Thread baseline (stale_revision).'
          : 'Not committed — the Thread changed after your last read (stale_revision).'
    return [headline,
      value.kind === 'unread_required' ? `${identity} · ${value.unreadCount ?? 0} unread, ${value.directCount ?? 0} direct` : identity,
      ...(unrecognized || facts.length === 0 ? [] : ['', allShown
        ? `${facts.length} pending fact(s), shown in full:`
        : `${shown.length} of ${facts.length} pending fact(s) included; some content is truncated or omitted:`,
      ...shown.map(fact => factLine(fact as FactView))]),
      recoveryFor(unrecognized ? 'stale_revision_token_unrecognized' : value.kind)
        .sentence({ threadRef: value.threadRef, taskRef: value.taskRef, completeFacts: canReconsider }),
      ...(canReconsider && value.revision !== undefined ? [nextWriteLine(value.revision)]
        : ['No write token is provided; the required reading is not satisfied by this result.']),
    ]
  }
  if (!unrecognized) {
    for (const fact of facts.slice(0, REJECTION_FACT_LIMIT)) {
      const cut = fact.kind === 'message' && (fact.body?.length ?? 0) > REJECTION_BODY_MAX_CHARACTERS
      const rendered = cut ? { ...fact, body: `${fact.body!.slice(0, REJECTION_BODY_MAX_CHARACTERS)}\n${REJECTION_BODY_TRUNCATION_MARKER}` } : fact
      shown.push(rendered)
      truncated ||= cut
      if (lines().join('\n').length > REJECTION_MAX_CHARACTERS) {
        shown.pop()
        break
      }
      if (!cut && (fact.kind === 'message' || activityFromView(fact) !== undefined)) completeFacts.push(fact)
    }
  }
  return { text: lines().join('\n'), messages: messageIdentities(value.threadRef, completeFacts),
    activities: activityBindings(completeFacts) }
}

function renderMainRejection(value: { projectRef?: string; unreadCount?: number; directCount?: number; entries?: readonly MainEntryView[] }) {
  const entries = value.entries ?? []
  const shown: MainEntryView[] = []
  const complete: MainEntryView[] = []
  let truncated = false
  const lines = () => {
    const canReconsider = !truncated && shown.length === entries.length && entries.length === value.unreadCount
      && entries.every(entry => entry.kind === 'message' ? entry.messageRef !== undefined && entry.body !== undefined
        : activityFromView(entry, value.projectRef) !== undefined)
    return ['Not committed — main_unread_required.', `${value.projectRef ?? ''} · ${value.unreadCount ?? 0} unread, ${value.directCount ?? 0} direct`,
      ...(entries.length === 0 ? [] : ['', canReconsider ? `${shown.length} pending Main stream entries, shown in full:`
        : `${shown.length} of ${entries.length} Main stream entries included; some content is truncated or omitted:`, ...shown.map(mainEntryLine)]),
      recoveryFor('main_unread_required').sentence({ projectRef: value.projectRef, completeFacts: canReconsider })]
  }
  for (const entry of entries.slice(0, REJECTION_FACT_LIMIT)) {
    const cut = entry.kind === 'message' && (entry.body?.length ?? 0) > REJECTION_BODY_MAX_CHARACTERS
    shown.push(cut ? { ...entry, body: `${entry.body!.slice(0, REJECTION_BODY_MAX_CHARACTERS)}\n${REJECTION_BODY_TRUNCATION_MARKER}` } : entry)
    truncated ||= cut
    if (lines().join('\n').length > REJECTION_MAX_CHARACTERS) { shown.pop(); break }
    if (!cut) complete.push(entry)
  }
  return { text: lines().join('\n'), messages: complete.flatMap(entry => value.projectRef === undefined || entry.kind !== 'message' || entry.messageRef === undefined || entry.body === undefined
    ? [] : [{ projectRef: value.projectRef, messageRef: entry.messageRef, body: entry.body }]),
    activities: complete.flatMap(entry => { const fact = activityFromView(entry, value.projectRef); return fact === undefined ? [] : [fact] }) }
}

/** One rejection's meta: its outcome kind plus the facts its rendered text carries, bound so a reconsidered write needs no second read. */
function rejectionMeta(value: { kind: string }, rendered: { text: string; messages: Parameters<typeof teamMessageSurface>[1]; activities?: Parameters<typeof teamMessageSurface>[2] }) {
  return { kind: value.kind, teamFacts: teamMessageSurface(rendered.text, rendered.messages, rendered.activities ?? []) }
}

const CAUSE_OF_SOURCE: Record<AgentTeamAttentionSource, string> = {
  'thread-author': 'because you started it',
  claim: 'because you claimed its Task',
  accountable: 'because you are accountable for its Task',
  'project-owner': 'because you own the Project',
  mention: 'because you were named in it',
  self: 'because you chose to follow',
}

function causeOf(source: string | undefined): string {
  if (source === undefined) return ''
  const phrase = CAUSE_OF_SOURCE[source as AgentTeamAttentionSource]
  return phrase === undefined ? '' : `(${phrase})`
}

const BOARD_ITEM_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  workspaceId: { type: 'string', required: true }, projectRef: { type: 'string', required: true }, projectName: { type: 'string', required: true },
  taskRef: { type: 'string', required: true }, taskNumber: { type: 'number', required: true }, threadRef: { type: 'string', required: true },
  status: { type: 'string', required: true }, subject: { type: 'string', required: true }, members: { type: 'array', required: true, items: { type: 'string' } },
  lastActivityAt: { type: 'string', required: true }, relation: { type: 'string', required: true },
  accountable: { type: 'string', required: true }, needsAcceptance: { type: 'boolean', required: true },
} } as const

interface BoardItemView {
  readonly workspaceId: string
  readonly projectRef: string
  readonly projectName: string
  readonly taskRef: string
  readonly taskNumber: number
  readonly threadRef: string
  readonly status: string
  readonly subject: string
  readonly members: string[]
  readonly lastActivityAt: string
  readonly relation: string
  readonly accountable: string
  readonly needsAcceptance: boolean
}

export function boardItemView(item: AgentTeamTaskBoardItem): BoardItemView {
  return { workspaceId: item.workspaceId, projectRef: item.projectRef, projectName: item.projectName, taskRef: item.task.taskRef, taskNumber: item.taskNumber,
    threadRef: item.threadRef, status: item.task.status, subject: item.subject, members: item.liveClaimOwners.map(owner => owner.name),
    lastActivityAt: item.lastActivityAt, relation: item.relation, accountable: item.task.accountable, needsAcceptance: item.needsAcceptance }
}

function boardLines(open: readonly BoardItemView[], finished: readonly BoardItemView[], finishedTruncated: boolean): string[] {
  const line = (item: BoardItemView) => [`${item.taskRef} (#${item.taskNumber})`, `${item.projectName} ${item.projectRef}`, item.threadRef,
    ...(item.members.length === 0 ? [] : [item.members.map(name => `@${name}`).join(', ')]),
    ...(item.relation === 'none' ? [] : [`you: ${item.relation}`]),
    `accountable ${item.accountable}`,
    ...(item.needsAcceptance ? ['needs your acceptance'] : []),
  ].join(' · ') + ` — ${item.subject} · last activity ${formatTeamTimestamp(item.lastActivityAt)}`
  const column = (title: string, status: string) => {
    const items = open.filter(item => item.status === status)
    return [`${title} (${items.length})`, ...(items.length === 0 ? ['—'] : items.map(line))]
  }
  return ['Task board — current state; reading it changes no read state and supplies no write token.',
    ...column('To do', 'todo'), ...column('In progress', 'in_progress'), ...column('In review', 'in_review'),
    // The page is not the column: without this conclusion the reader takes the
    // page size for the Project's whole resolved history.
    `Recently finished (${finished.length}${finishedTruncated ? ' shown, more exist' : ''})`,
    ...(finished.length === 0 ? ['—'] : finished.map(item => `${line(item)} · ${item.status}`)),
    'Read a Task\'s Thread with team_thread read before you claim or reply.']
}

export function reminderScheduleText(schedule: AgentTeamReminderSchedule): string {
  if (schedule.kind === 'once') return `once at ${formatTeamTimestamp(schedule.at)}`
  if (schedule.kind === 'every') return `every ${schedule.minutes} minutes`
  return `cron '${schedule.expression}' read in UTC+8`
}

const REMINDER_VIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  reminderRef: { type: 'string', required: true }, state: { type: 'string', required: true },
  schedule: { type: 'string', required: true }, note: { type: 'string', required: true }, createdAt: { type: 'string', required: true },
  lastOccurrenceAt: { type: 'string' }, pendingOccurrenceAt: { type: 'string' }, nextOccurrenceAt: { type: 'string' },
} } as const

const TEAM_INBOX_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  totalUnreadCount: { type: 'number', required: true }, totalDirectCount: { type: 'number', required: true },
  hasMore: { type: 'boolean', required: true },
  items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    workspaceId: { type: 'string', required: true }, threadRef: { type: 'string', required: true }, projectRef: { type: 'string', required: true },
    taskRef: { type: 'string' }, status: { type: 'string' }, accountable: { type: 'string' }, revision: { type: 'number', required: true }, unreadCount: { type: 'number', required: true }, directCount: { type: 'number', required: true },
    taskNumber: { type: 'number' }, newestOccurredAt: { type: 'string' }, reminders: { type: 'array', items: REMINDER_SCHEMA },
  } } },
  main: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    workspaceId: { type: 'string', required: true }, projectRef: { type: 'string', required: true }, projectName: { type: 'string', required: true },
    unreadCount: { type: 'number', required: true }, directCount: { type: 'number', required: true }, newestOccurredAt: { type: 'string', required: true },
  } } },
} } as const

export const teamInboxOutput = {
  schema: TEAM_INBOX_SCHEMA,
  render: (_args, value) => {
    if (value.items.length === 0 && value.main.length === 0) {
      // An empty page does not mean the inbox is drained.
      return [{ type: 'text', text: value.totalUnreadCount > 0
        ? `Inbox — ${value.totalUnreadCount} unread update(s) on Threads beyond this bounded page — read these Threads to drain the queue.`
        : 'Inbox empty — no unread Team work.' }]
    }
    const more = value.hasMore
      ? '; the unread queue is bounded and more Threads sit beyond this page — read these to drain it, or ask for up to 100 rows.'
      : '.'
    return [{ type: 'text', text: [
      `Inbox — ${value.totalUnreadCount} unread update(s) total, ${value.totalDirectCount} direct, across ${value.main.length === 0 ? '' : `${value.main.length} Main stream(s) and `}${value.items.length} Thread(s) shown${more}`,
      ...value.main.map(row => `${row.workspaceId} · ${row.projectRef} Main stream (${row.projectName}) · ${row.unreadCount} unread, ${row.directCount} direct · newest ${formatTeamTimestamp(row.newestOccurredAt)}`),
      ...value.items.map(item => `${item.workspaceId} · ${item.threadRef}${item.projectRef === undefined ? '' : ` · ${item.projectRef}`}${item.taskRef === undefined ? '' : ` · ${taskStanding(item)}`} · ${item.unreadCount} unread, ${item.directCount} direct${(item.reminders?.length ?? 0) > 0 ? ` · reminder ${(item.reminders ?? []).map(reminder => reminder.kind).join(', ')}` : ''}${item.newestOccurredAt === undefined ? '' : ` · newest ${formatTeamTimestamp(item.newestOccurredAt)}`}`),
      `Read a selected ${value.main.length === 0 ? 'Thread with team_thread read' : 'Thread or Main stream with team_thread read (threadRef or projectRef)'}. Listing changes no read state and supplies no write token.`,
    ].join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof TEAM_INBOX_SCHEMA>['output']

const TEAM_ATTENTION_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  workspaceId: { type: 'string', required: true }, projectRef: { type: 'string', required: true },
  kind: { type: 'string', required: true }, threadRef: { type: 'string' }, taskRef: { type: 'string' },
  revision: { type: 'number' }, status: { type: 'string' }, resolution: { type: 'string' }, taskNumber: { type: 'number' }, accountable: { type: 'string' },
  following: { type: 'boolean', required: true }, scope: { type: 'string' }, source: { type: 'string' },
} } as const

export const teamAttentionOutput = {
  schema: TEAM_ATTENTION_SCHEMA,
  render: (_args, value) => {
    const source = `Workspace: ${value.workspaceId} · Project: ${value.projectRef}`
    const subject = value.scope === 'main' ? 'the Main stream' : `Thread ${value.threadRef}`
    const standing = value.scope === 'main' ? '' : taskStanding(value)
    const consequence = value.following
      ? value.kind === 'follow'
        ? 'Ordinary updates from there will interrupt you from now on; earlier content remains available through team_thread read or history. Mentions, replies and responsibility events already did.'
        : 'Ordinary updates from there will interrupt you; mentions, replies and responsibility events already did.'
      : value.kind === 'unfollow'
        ? 'Ordinary updates will no longer interrupt you. Mentions, replies and responsibility events still will; follow again to resume.'
        : 'Ordinary updates do not interrupt you. Mentions, replies and responsibility events still will; follow to resume them.'
    const cause = value.following === false ? '' : causeOf(value.source)
    if (value.kind === 'follow' || value.kind === 'unfollow') {
      return [{ type: 'text', text: `${source}\nAttention changed — ${value.following ? 'now following' : 'no longer following'} ${subject}${standing === '' ? '' : ` · ${standing}`}${cause}.\n${consequence}` }]
    }
    return [{ type: 'text', text: `${source}\nAttention status — ${value.following ? 'following' : 'not following'} ${subject}${standing === '' ? '' : ` · ${standing}`}${cause}.\n${consequence}` }]
  },
} satisfies DefineToolOptions<{}, typeof TEAM_ATTENTION_SCHEMA>['output']

const TEAM_DM_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', required: true },
  recipientMemberId: { type: 'string', required: true }, recipientHandle: { type: 'string', required: true },
  delivered: { type: 'boolean', required: true }, deliveryNote: { type: 'string' }, occurredAt: { type: 'string' },
} } as const

export const teamDmOutput = {
  schema: TEAM_DM_SCHEMA,
  render: (_args, value) => {
    if (value.delivered === false) return [{ type: 'text', text: [
      `Recorded, not delivered — DM to @${value.recipientHandle} (${value.recipientMemberId}).`,
      'No automatic redelivery will occur; do not blindly send a duplicate.',
      `Reason: ${value.deliveryNote ?? 'the recipient session could not be woken'}`,
    ].join('\n') }]
    return [{ type: 'text', text: `Delivered — DM to @${value.recipientHandle} (${value.recipientMemberId})${value.occurredAt === undefined ? '' : ` at ${formatTeamTimestamp(value.occurredAt)}`}.` }]
  },
} satisfies DefineToolOptions<{}, typeof TEAM_DM_SCHEMA>['output']

const TEAM_MESSAGE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', required: true }, action: { type: 'string' }, taskRef: { type: 'string' }, threadRef: { type: 'string' }, revision: { type: 'number' }, accountable: { type: 'string' }, sourceThreadRefs: { type: 'array', items: { type: 'string' } },
  expectedRevision: { type: 'number' }, messageRef: { type: 'string' }, memberIds: { type: 'array', items: { type: 'string' } }, unreadCount: { type: 'number' }, directCount: { type: 'number' },
  following: { type: 'boolean' },
  projectRef: { type: 'string' }, entries: { type: 'array', items: MAIN_ENTRY_SCHEMA },
  facts: { type: 'array', items: FACT_SCHEMA },
  occurredAt: { type: 'string' }, staleTokenKind: { type: 'string', enum: ['unknown', 'unrecognized'] },
  source: { type: 'string' },
} } as const

export const teamMessageOutput = {
  schema: TEAM_MESSAGE_SCHEMA,
  render: (_args, value) => {
    if (value.kind === 'committed' && value.action === 'post' && value.messageRef !== undefined) {
      return [{ type: 'text', text: [
        'Committed — Main stream message posted.',
        [value.messageRef, ...(value.projectRef === undefined ? [] : [value.projectRef])].join(' · '),
        ...(value.following === false ? [`You do not follow this Main stream: later ordinary updates will not wake you; to keep participating, team_attention follow with projectRef ${value.projectRef ?? ''}`] : []),
        ...(value.occurredAt === undefined ? [] : [`Committed at ${formatTeamTimestamp(value.occurredAt)}`]),
      ].join('\n') }]
    }
    if (value.kind === 'main_unread_required') {
      return [{ type: 'text', text: renderMainRejection(value).text }]
    }
    if (value.kind === 'committed' && value.messageRef !== undefined && value.threadRef !== undefined && value.revision !== undefined) {
      return [{ type: 'text', text: [
        value.action === 'start' ? 'Committed — Thread created.' : 'Committed — reply added.',
        [value.messageRef, value.threadRef, ...(value.taskRef === undefined ? [] : [value.taskRef])].join(' · '),
        ...(value.accountable === undefined ? [] : [`Accountable for ${value.taskRef}: ${value.accountable}.`]),
        ...(value.sourceThreadRefs === undefined || value.sourceThreadRefs.length === 0 ? [] : [`Derived from ${value.sourceThreadRefs.join(', ')} — its card renders there, not in the Main stream.`]),
        // A start follows its author, so the result states the Attention it
        // just acquired: ordinary updates from this Thread will now interrupt.
        ...(value.action !== 'start' || value.source === undefined ? [] : [`You now follow this Thread ${causeOf(value.source)}. Ordinary updates from here will interrupt you; team_attention unfollow with threadRef stops them.`]),
        ...(value.action === 'reply' && value.following === false ? [`You do not follow this Thread: later ordinary updates will not wake you; to keep participating, team_attention follow with threadRef ${value.threadRef}`] : []),
        ...(value.occurredAt === undefined ? [] : [`Committed at ${formatTeamTimestamp(value.occurredAt)}`]),
        nextWriteLine(value.revision),
      ].join('\n') }]
    }
    return [{ type: 'text', text: renderRejection(value).text }]
  },
  // The Host restores the Thread anchor from the persisted commit identity, not from render text.
  presentationMeta: (_args, value): { kind: string; threadRef?: string; taskRef?: string; teamFacts?: ReturnType<typeof teamMessageSurface> } => {
    if (value.kind === 'committed' && value.threadRef !== undefined) {
      return { kind: value.kind, threadRef: value.threadRef, ...(value.taskRef === undefined ? {} : { taskRef: value.taskRef }) }
    }
    if (value.kind === 'unread_required' || value.kind === 'stale_revision') {
      return rejectionMeta(value, renderRejection(value))
    }
    if (value.kind === 'main_unread_required') {
      return rejectionMeta(value, renderMainRejection(value))
    }
    return { kind: value.kind }
  },
} satisfies DefineToolOptions<{}, typeof TEAM_MESSAGE_SCHEMA>['output']

const TEAM_TASK_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  kind: { type: 'string', required: true }, action: { type: 'string' }, taskRef: { type: 'string' }, threadRef: { type: 'string' },
  revision: { type: 'number' }, expectedRevision: { type: 'number' }, status: { type: 'string' }, resolution: { type: 'string' },
  accountable: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  releasedClaimRefs: { type: 'array', items: { type: 'string' } }, acceptedClaimRefs: { type: 'array', items: { type: 'string' } },
  open: { type: 'array', items: BOARD_ITEM_SCHEMA }, finished: { type: 'array', items: BOARD_ITEM_SCHEMA }, finishedTruncated: { type: 'boolean' },
  unreadCount: { type: 'number' }, directCount: { type: 'number' }, occurredAt: { type: 'string' },
  claim: { type: 'object', additionalProperties: false, properties: {
    claimRef: { type: 'string', required: true }, direction: { type: 'string', required: true }, state: { type: 'string', required: true }, owner: { type: 'string', required: true },
  } },
  claims: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { claimRef: { type: 'string', required: true }, direction: { type: 'string', required: true }, state: { type: 'string', required: true }, owner: { type: 'string', required: true } } } },
  facts: { type: 'array', items: FACT_SCHEMA }, staleTokenKind: { type: 'string', enum: ['unknown', 'unrecognized'] },
  // Present when the action started the caller's own Attention, which is the
  // one cause a result can state without asking the projection again.
  source: { type: 'string' },
} } as const

export const teamTaskOutput = {
  schema: TEAM_TASK_SCHEMA,
  render: (_args, value) => {
    if (value.kind === 'board') return [{ type: 'text', text: boardLines(value.open ?? [], value.finished ?? [], value.finishedTruncated === true).join('\n') }]
    if (value.kind === 'committed' && value.action === 'promote') {
      return [{ type: 'text', text: [
        `Committed — Thread promoted to Task ${value.taskRef} (${value.status}).`,
        `${value.threadRef} · ${value.taskRef}${value.accountable === undefined ? '' : ` · accountable ${value.accountable}`}`,
        ...(value.occurredAt === undefined ? [] : [`Committed at ${formatTeamTimestamp(value.occurredAt)}`]),
        nextWriteLine(value.revision!),
      ].join('\n') }]
    }
    if (value.kind === 'listed') {
      const active = (value.claims ?? []).filter(claim => claim.state === 'active')
      return [{ type: 'text', text: [
        `Claims for ${value.taskRef} · ${value.threadRef} · ${value.status}${value.accountable === undefined ? '' : ` · accountable ${value.accountable}`}`,
        'Active Claims',
        ...(active.length === 0 ? ['No active Claims.'] : active.map(claim => claimLine(claim))),
      ].join('\n') }]
    }
    if (value.kind === 'committed' && value.claim !== undefined) {
      // A new Claim follows the Thread it executes, so the result says so: the
      // reader now holds Attention it did not ask for.
      const follows = value.source === undefined ? [] : [`You now follow this Thread ${causeOf(value.source)}. Ordinary updates from here will interrupt you; team_attention unfollow with threadRef stops them and releases no Claim.`]
      return [{ type: 'text', text: [
        `Committed — Claim ${value.action === 'claim' ? 'created' : value.action === 'done' ? 'completed' : 'released'}.`,
        `${value.claim.claimRef} · ${value.claim.state} — ${value.claim.owner}: ${value.claim.direction}`,
        `${value.threadRef} · ${value.taskRef} · ${value.status}${value.accountable === undefined ? '' : ` · accountable ${value.accountable}`}`,
        ...follows,
        ...(value.occurredAt === undefined ? [] : [`Committed at ${formatTeamTimestamp(value.occurredAt)}`]),
        nextWriteLine(value.revision!),
      ].join('\n') }]
    }
    if (value.kind === 'committed' && (value.action === 'accept' || value.action === 'close' || value.action === 'reopen')) {
      return [{ type: 'text', text: [
        `Committed — Task ${value.action === 'accept' ? 'accepted' : value.action === 'close' ? 'closed' : 'reopened'}.`,
        `${value.threadRef} · ${value.taskRef} · ${value.status}${value.resolution === undefined ? '' : `/${value.resolution}`}${value.accountable === undefined ? '' : ` · accountable ${value.accountable}`}`,
        ...(value.acceptedClaimRefs === undefined || value.acceptedClaimRefs.length === 0 ? [] : [`accepted claims ${value.acceptedClaimRefs.join(', ')}`]),
        ...(value.releasedClaimRefs === undefined || value.releasedClaimRefs.length === 0 ? [] : [`released claims ${value.releasedClaimRefs.join(', ')}`]),
        ...(value.occurredAt === undefined ? [] : [`Committed at ${formatTeamTimestamp(value.occurredAt)}`]),
        nextWriteLine(value.revision!),
      ].join('\n') }]
    }
    if (value.kind === 'committed' && value.action === 'transfer') {
      return [{ type: 'text', text: [
        'Committed — Task transferred.',
        `${value.threadRef} · ${value.taskRef} · ${value.status}${value.accountable === undefined ? '' : ` · accountable ${value.accountable}`}`,
        ...(value.from === undefined || value.to === undefined ? [] : [`responsibility ${value.from} → ${value.to}; Claims stay with their owners.`]),
        ...(value.occurredAt === undefined ? [] : [`Committed at ${formatTeamTimestamp(value.occurredAt)}`]),
        nextWriteLine(value.revision!),
      ].join('\n') }]
    }
    return [{ type: 'text', text: renderRejection(value).text }]
  },
  // A Claim or Task rejection can carry the same complete Thread facts; binding them lets a reconsidered write pass without a second read. Non-rejection results carry only the outcome kind.
  presentationMeta: (_args, value): { kind: string; threadRef?: string; taskRef?: string; teamFacts?: ReturnType<typeof teamMessageSurface> } => {
    if ((value.kind === 'unread_required' || value.kind === 'stale_revision') && value.threadRef !== undefined) {
      return rejectionMeta(value, renderRejection(value))
    }
    return { kind: value.kind }
  },
} satisfies DefineToolOptions<{}, typeof TEAM_TASK_SCHEMA>['output']

const TEAM_VIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  projects: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    projectRef: { type: 'string', required: true }, name: { type: 'string', required: true },
    owners: { type: 'array', items: { type: 'string' } },
    ownerResponsibilities: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      handle: { type: 'string', required: true }, responsibility: { type: 'string', required: true },
    } } },
    role: { type: 'string' },
    subscriptions: { type: 'object', additionalProperties: false, properties: {
      active: { type: 'number', required: true }, paused: { type: 'number', required: true },
    } },
  } } },
  workspaceId: { type: 'string', required: true },
  workspaces: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { workspaceId: { type: 'string', required: true }, title: { type: 'string' }, default: { type: 'boolean', required: true } } } },
  members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    memberId: { type: 'string', required: true }, kind: { type: 'string', required: true }, handle: { type: 'string', required: true }, description: { type: 'string', required: true }, presence: { type: 'string', required: true },
  } } },
  threads: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    threadRef: { type: 'string', required: true }, projectRef: { type: 'string', required: true }, revision: { type: 'number', required: true }, messageCount: { type: 'number', required: true }, subject: { type: 'string', required: true },
    taskRef: { type: 'string' }, status: { type: 'string' }, taskNumber: { type: 'number' }, accountable: { type: 'string' }, lastActivityAt: { type: 'string' },
  } } },
  tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { taskRef: { type: 'string', required: true }, threadRef: { type: 'string', required: true }, projectRef: { type: 'string', required: true }, status: { type: 'string', required: true }, revision: { type: 'number' } } } },
  cursor: { type: 'number', required: true }, hasMore: { type: 'boolean', required: true }, page: { type: 'string' },
} } as const

export const teamViewOutput = {
  schema: TEAM_VIEW_SCHEMA,
  render: (_args, value) => {
    const continuation = value.page === 'threads'
    const lines: string[] = [`Workspace: ${value.workspaceId}`]
    if (!continuation) {
      lines.push('Team directory', '', 'Projects — Workspace directory')
      if (value.projects.length === 0) lines.push('No active Projects in this Workspace.')
      else lines.push(...value.projects.map(project => {
        const counts = project.subscriptions === undefined ? '' : project.subscriptions.active === 0 && project.subscriptions.paused === 0
          ? ' · subscriptions 0'
          : ` · subscriptions ${project.subscriptions.active === 0 ? '' : `${project.subscriptions.active} active`}${project.subscriptions.active > 0 && project.subscriptions.paused > 0 ? ', ' : ''}${project.subscriptions.paused === 0 ? '' : `${project.subscriptions.paused} paused`}`
        const responsibilities = project.ownerResponsibilities === undefined || project.ownerResponsibilities.length === 0 ? ''
          : ` · responsibility ${project.ownerResponsibilities.map(owner => `@${owner.handle}: ${owner.responsibility}`).join('; ')}`
        return `${project.projectRef} · ${project.name}${project.owners === undefined ? '' : ` · owners ${project.owners.map(handle => `@${handle}`).join(', ')} · you: ${project.role}`}${responsibilities}${counts}`
      }))
      lines.push('')
    }
    lines.push('Threads — this Workspace')
    if (value.threads.length === 0) lines.push('No top-level Threads in this Workspace at this cursor.')
    else lines.push(...value.threads.map(thread => `${thread.threadRef} · ${thread.projectRef}${thread.taskRef === undefined ? ' · taskless' : ` · ${taskStanding(thread)}`} — ${thread.subject}${thread.lastActivityAt === undefined ? '' : ` · last activity ${formatTeamTimestamp(thread.lastActivityAt)}`}`))
    lines.push(`Thread cursor ${value.cursor}; hasMore=${value.hasMore ? 'true' : 'false'}${value.hasMore ? ' — older Thread anchors exist; page again with this cursor.' : ' — no older Threads remain.'}`)
    if (!continuation && value.workspaces.length > 1) {
      lines.push('', 'Workspaces — you participate in')
      lines.push(...value.workspaces.map(workspace => `${workspace.workspaceId}${workspace.title === undefined ? '' : ` · ${workspace.title}`}${workspace.default ? ' · default — your Session and cwd live here' : ' — address it with the workspace argument; file work needs absolute paths'}`))
    }
    if (!continuation) {
      lines.push('', 'Members — current')
      if (value.members.length === 0) lines.push('No visible Members.')
      else lines.push(...value.members.map(m => `${m.memberId} · @${m.handle} (${m.kind}, ${m.presence})${m.description === '' ? '' : ` — ${m.description}`}`))
      lines.push('', 'Subscription details: team_subscription list. Work in flight: team_task board.')
    }
    return [{ type: 'text', text: lines.join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof TEAM_VIEW_SCHEMA>['output']

const TEAM_REMINDER_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  action: { type: 'string', required: true }, workspaceId: { type: 'string', required: true },
  created: { type: 'boolean', required: true }, cancelled: { type: 'boolean', required: true },
  activeCount: { type: 'number', required: true },
  reminders: { type: 'array', required: true, items: REMINDER_VIEW_SCHEMA },
} } as const

export const teamReminderOutput = {
  schema: TEAM_REMINDER_SCHEMA,
  render: (_args, value) => {
    const head = `Reminders — ${value.action} · ${value.activeCount} active`
    const rows = value.reminders.map(reminder => [
      `${reminder.reminderRef} · ${reminder.state} · ${reminder.schedule}`,
      `Note: ${reminder.note}`,
      `Created at: ${formatTeamTimestamp(reminder.createdAt)}`,
      ...(reminder.lastOccurrenceAt === undefined ? [] : [`Last occurrence: ${formatTeamTimestamp(reminder.lastOccurrenceAt)}`]),
      ...(reminder.pendingOccurrenceAt === undefined ? [] : [`Waiting to be read since: ${formatTeamTimestamp(reminder.pendingOccurrenceAt)}`]),
      ...(reminder.nextOccurrenceAt === undefined ? [] : [`Next occurrence: ${formatTeamTimestamp(reminder.nextOccurrenceAt)}`]),
    ].join('\n'))
    const tail = value.action === 'create'
      ? `Reminder created for you alone; it reaches your Team Inbox when it comes due. ${value.activeCount} of at most 50 active.`
      : value.action === 'cancel'
        ? 'Reminder cancelled; no further occurrence will fire for it.'
        : 'These are your own reminders. Create one with team_reminder create, or cancel one by reminderRef.'
    return [{ type: 'text', text: [head, ...rows, tail].join('\n') }]
  },
} satisfies DefineToolOptions<{}, typeof TEAM_REMINDER_SCHEMA>['output']
