import { formatTeamTimestamp } from '@contexera/dsh-agent-team/time-format'
import type { AgentTeamMainStreamStanding, AgentTeamMainTimelineEntry } from '@contexera/dsh-agent-team/types'

/** Model-facing view of one Main stream entry: the Host's timeline entry with identities as plain strings. */
export interface MainEntryView {
  readonly sequence: number
  readonly kind: string
  readonly occurredAt: string
  readonly unread: boolean
  readonly direct: boolean
  readonly sender?: string
  readonly messageRef?: string
  readonly body?: string
  readonly mentions?: string[]
  readonly replyToMessageRef?: string
  readonly replyTo?: { readonly sender: string; readonly excerpt: string }
  readonly activity?: string
  readonly actor?: string
  readonly memberId?: string
  readonly threadRef?: string
  readonly preview?: string
  readonly taskRef?: string
  readonly taskNumber?: number
  readonly status?: string
  readonly resolution?: string
  readonly replyCount?: number
  readonly participants?: string[]
  readonly liveClaimOwners?: string[]
}

export const MAIN_ENTRY_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    sequence: { type: 'number', required: true }, kind: { type: 'string', required: true }, occurredAt: { type: 'string', required: true },
    unread: { type: 'boolean', required: true }, direct: { type: 'boolean', required: true },
    sender: { type: 'string' }, messageRef: { type: 'string' }, body: { type: 'string' }, mentions: { type: 'array', items: { type: 'string' } },
    replyToMessageRef: { type: 'string' },
    replyTo: { type: 'object', additionalProperties: false, properties: { sender: { type: 'string', required: true }, excerpt: { type: 'string', required: true } } },
    activity: { type: 'string' }, actor: { type: 'string' }, memberId: { type: 'string' },
    threadRef: { type: 'string' }, preview: { type: 'string' }, taskRef: { type: 'string' }, taskNumber: { type: 'number' },
    status: { type: 'string' }, resolution: { type: 'string' }, replyCount: { type: 'number' },
    participants: { type: 'array', items: { type: 'string' } }, liveClaimOwners: { type: 'array', items: { type: 'string' } },
  },
} as const

export const MAIN_STANDING_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    owner: { type: 'boolean', required: true }, head: { type: 'number', required: true },
    unreadCount: { type: 'number', required: true }, directCount: { type: 'number', required: true },
  },
} as const

export function mainEntryView(entry: AgentTeamMainTimelineEntry): MainEntryView {
  const flags = { sequence: entry.sequence, occurredAt: entry.occurredAt, unread: entry.unread, direct: entry.direct }
  if (entry.kind === 'message') {
    const { message } = entry
    return { ...flags, kind: 'message', sender: message.sender, messageRef: message.messageRef, body: message.body, mentions: [...entry.mentions],
      ...(message.replyToMessageRef === undefined ? {} : { replyToMessageRef: message.replyToMessageRef }),
      ...(entry.replyTo === undefined ? {} : { replyTo: { sender: entry.replyTo.sender, excerpt: entry.replyTo.excerpt } }) }
  }
  if (entry.kind === 'activity') {
    return { ...flags, kind: 'activity', activity: entry.activity.kind, actor: entry.activity.actor, memberId: entry.activity.memberId }
  }
  const { card } = entry
  return { ...flags, kind: 'thread-card', threadRef: card.threadRef, preview: card.anchor.preview, sender: card.anchor.sender,
    replyCount: card.replyCount, participants: card.participants.map(actor => actor.name),
    ...(card.task === undefined ? {} : { taskRef: card.task.taskRef, taskNumber: card.task.taskNumber, status: card.task.status,
      resolution: card.task.resolution, liveClaimOwners: card.task.liveClaimOwners.map(actor => actor.name) }) }
}

export function standingView(standing: AgentTeamMainStreamStanding): { owner: boolean; head: number; unreadCount: number; directCount: number } {
  return { owner: standing.owner, head: standing.head, unreadCount: standing.unreadCount, directCount: standing.directCount }
}

function markers(entry: MainEntryView): string {
  return entry.direct ? ' [direct]' : entry.unread ? ' [unread]' : ''
}

/** One rendered Main stream line; a Thread card names the Thread to read and its current state, never a transition. */
export function mainEntryLine(entry: MainEntryView): string {
  const at = ` ${formatTeamTimestamp(entry.occurredAt)}`
  if (entry.kind === 'message') {
    const replies = entry.replyToMessageRef === undefined ? ''
      : entry.replyTo === undefined ? ` (replies to ${entry.replyToMessageRef})` : ` (replies to @${entry.replyTo.sender} — "${entry.replyTo.excerpt}")`
    return `${entry.sequence}${at} [${entry.sender}]${markers(entry)}${replies} ${entry.messageRef} ${entry.body}`
  }
  if (entry.kind === 'activity') {
    return `${entry.sequence}${at} ${entry.actor} ${entry.activity === 'owner-added' ? 'made' : 'removed'} ${entry.memberId} ${entry.activity === 'owner-added' ? 'an owner' : 'as an owner'}${markers(entry)}`
  }
  const subject = entry.taskRef === undefined
    ? `Discussion ${entry.threadRef}`
    : `Task ${entry.taskRef} (#${entry.taskNumber}), ${entry.status}/${entry.resolution}${entry.liveClaimOwners === undefined || entry.liveClaimOwners.length === 0 ? '' : ` — working: ${entry.liveClaimOwners.join(', ')}`}`
  return `${entry.sequence}${at} [thread card]${markers(entry)} ${subject} — ${entry.preview} · ${entry.threadRef} · ${entry.replyCount} repl${entry.replyCount === 1 ? 'y' : 'ies'} · by ${(entry.participants ?? []).join(', ')}`
}
