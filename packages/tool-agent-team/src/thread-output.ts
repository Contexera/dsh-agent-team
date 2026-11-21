import type { InferValue } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { teamMessageSurface, activityText } from '@contexera/dsh-agent-team/host'
import { formatTeamTimestamp } from '@contexera/dsh-agent-team/time-format'
import { recoveryFor } from '@contexera/dsh-agent-team/recovery-hints'
import type { AgentTeamActivity, AgentTeamClaimRef, AgentTeamThreadFact, AgentTeamThreadTaskCard } from '@contexera/dsh-agent-team/types'
import { MAIN_ENTRY_SCHEMA, MAIN_STANDING_SCHEMA, mainEntryLine, type MainEntryView } from './main-stream.ts'
import { messagePartText, MESSAGE_PART_SCHEMA, type MessagePart } from './reading-budget.ts'
import { activityFromView } from './activity-view.ts'
import { boundedSubject } from './subject.ts'

/** The complete Activity facts a rendered surface binds; an omitted identity is already bound by its original output. */
export function activityBindings(views: readonly { readonly kind?: string; readonly activityOmitted?: boolean }[], projectRef?: string) {
  return views.flatMap(view => {
    if (view.kind !== 'activity' || view.activityOmitted === true) return []
    const complete = activityFromView(view as Parameters<typeof activityFromView>[0], projectRef)
    return complete === undefined ? [] : [complete]
  })
}

interface ActivityFactView {
  readonly sequence: number
  readonly kind: 'activity'
  readonly activity: string
  readonly activityRef: string
  readonly actor: string
  /** Absent on a Worker run bound to a discussion Thread, which holds no Task. */
  readonly taskRef?: string
  readonly threadRef: string
  readonly projectRef?: string
  readonly workerRef?: string
  readonly engine?: string
  readonly state?: string
  readonly reason?: string
  readonly occurredAt?: string
  readonly claimRef?: string
  readonly claimRefs?: string[]
  readonly completedClaimRefs?: string[]
  readonly acceptedClaimRefs?: string[]
  readonly releasedClaimRefs?: string[]
  readonly from?: string
  readonly to?: string
  readonly refollowedMembers?: string[]
  readonly unread?: boolean
  readonly direct?: boolean
  /** The complete event is already in the current context, so only its identity is repeated. */
  readonly activityOmitted?: boolean
}

interface MessageFactView {
  readonly sequence: number
  readonly kind: 'message'
  readonly messageRef: string
  readonly body: string
  readonly bodyOmitted?: boolean
  readonly sender: string
  readonly occurredAt?: string
  readonly mentions: string[]
  readonly unread?: boolean
  readonly direct?: boolean
  readonly replyToMessageRef?: string
  /** Resolved context can be absent even when the reply target is known. */
  readonly replyTo?: ReplyContextView
}

export interface ReplyContextView {
  readonly sender: string
  readonly excerpt: string
}

export type FactView = MessageFactView | ActivityFactView

export interface ClaimView {
  readonly claimRef: string
  readonly direction: string
  readonly state: string
  readonly owner: string
}

export function claimView(claim: { readonly claimRef: AgentTeamClaimRef; readonly direction: string; readonly state: string; readonly owner: string }): ClaimView {
  return { claimRef: claim.claimRef, direction: claim.direction, state: claim.state, owner: claim.owner }
}

/** The one Activity → view projection: every immutable field, so the view can rebuild the exact fact the Host bound. */
export function activityFactView(
  activity: AgentTeamActivity,
  markers?: { readonly unread: boolean; readonly direct: boolean } | undefined,
  occurredAt?: string | undefined,
): ActivityFactView {
  return {
    sequence: activity.sequence, kind: 'activity', activity: activity.kind, activityRef: activity.activityRef,
    actor: activity.actor, threadRef: activity.threadRef,
    ...(activity.taskRef === undefined ? {} : { taskRef: activity.taskRef }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...('workerRef' in activity ? { workerRef: activity.workerRef, projectRef: activity.projectRef, engine: activity.engine } : {}),
    ...('state' in activity ? { state: activity.state } : {}),
    ...('reason' in activity && activity.reason !== undefined ? { reason: activity.reason } : {}),
    ...('claimRef' in activity ? { claimRef: activity.claimRef } : {}),
    ...('claimRefs' in activity ? { claimRefs: [...activity.claimRefs] } : {}),
    ...('completedClaimRefs' in activity && (activity.completedClaimRefs?.length ?? 0) > 0 ? { completedClaimRefs: [...activity.completedClaimRefs!] } : {}),
    ...('acceptedClaimRefs' in activity && (activity.acceptedClaimRefs?.length ?? 0) > 0 ? { acceptedClaimRefs: [...activity.acceptedClaimRefs!] } : {}),
    ...('releasedClaimRefs' in activity && (activity.releasedClaimRefs?.length ?? 0) > 0 ? { releasedClaimRefs: [...activity.releasedClaimRefs!] } : {}),
    ...('from' in activity && activity.from !== undefined ? { from: activity.from } : {}),
    ...('to' in activity && activity.to !== undefined ? { to: activity.to } : {}),
    ...('refollowedMembers' in activity && (activity.refollowedMembers?.length ?? 0) > 0 ? { refollowedMembers: [...activity.refollowedMembers!] } : {}),
    ...(markers === undefined ? {} : { unread: markers.unread, direct: markers.direct }),
  }
}

function factMarkers(fact: FactView): string {
  if (fact.unread === undefined) return ''
  if (fact.direct === true) return ' [direct]'
  if (fact.unread === true) return ' [unread]'
  return ''
}

function activityLine(fact: ActivityFactView): string {
  const complete = activityFromView(fact)
  if (complete === undefined) throw new Error(`Activity view at sequence ${fact.sequence} lacks its immutable identity`)
  return activityText(complete)
}

export function nextWriteLine(revision: number): string {
  return `Next write — baseRevision: ${revision} (copy exactly; never derive or cite).`
}

/** Task standing inline on a Thread identity line; absent on taskless Threads. Accountability rides along whenever the result carries it, because who is responsible for the Task changes what the reader may do next. */
export function taskStanding(value: { taskRef?: string; status?: string; resolution?: string; taskNumber?: number; accountable?: string }): string {
  if (value.taskRef === undefined) return ''
  return `${value.taskRef}${value.taskNumber === undefined ? '' : ` (#${value.taskNumber})`}${value.status === undefined ? '' : `, ${value.status}${value.resolution === undefined ? '' : `/${value.resolution}`}`}${value.accountable === undefined ? '' : ` · accountable ${value.accountable}`}`
}

/** One Task a discussion spawned, as the card its Thread renders at the creation point: current state, never a fact, never unread. */
export interface TaskCardView {
  readonly taskRef: string
  readonly taskNumber: number
  readonly threadRef: string
  readonly sequence: number
  readonly occurredAt: string
  readonly subject: string
  readonly status: string
  readonly resolution: string
  readonly accountable: string
}

const TASK_CARD_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    taskRef: { type: 'string', required: true }, taskNumber: { type: 'number', required: true }, threadRef: { type: 'string', required: true },
    sequence: { type: 'number', required: true }, occurredAt: { type: 'string', required: true }, subject: { type: 'string', required: true },
    status: { type: 'string', required: true }, resolution: { type: 'string', required: true }, accountable: { type: 'string', required: true },
  },
} as const

export function taskCardView(entry: AgentTeamThreadTaskCard): TaskCardView {
  // Flattened from the shared card: the model-facing view keeps its own stable field set, so the Host projection can
  // grow without changing what a tool result declares.
  const card = entry.card
  return { taskRef: card.task.taskRef, taskNumber: card.task.taskNumber, threadRef: card.threadRef, sequence: entry.sequence,
    occurredAt: card.anchor.occurredAt, subject: card.anchor.preview, status: card.task.status, resolution: card.task.resolution,
    accountable: card.task.accountable }
}

/** One card line, marked as a projection so it never reads as a fact: where the Task was created, its current state, and the Thread to open it on. */
function taskCardLine(card: TaskCardView): string {
  return `${card.sequence} ${formatTeamTimestamp(card.occurredAt)} [task card] Task ${card.taskRef} (#${card.taskNumber}), ${card.status}/${card.resolution} · accountable ${card.accountable} — ${card.subject} · ${card.threadRef}`
}

/** Facts and the cards their discussion spawned in one chronological order: a card sits at its creation sequence and breaks a fact run, the way the Client timeline draws it. */
function factTimelineLines(facts: readonly FactView[], cards: readonly TaskCardView[]): string[] {
  const lines: string[] = []
  let next = 0
  for (const fact of facts) {
    while (next < cards.length && cards[next]!.sequence < fact.sequence) lines.push(taskCardLine(cards[next++]!))
    lines.push(factLine(fact))
  }
  while (next < cards.length) lines.push(taskCardLine(cards[next++]!))
  return lines
}

export const FACT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    sequence: { type: 'number', required: true }, kind: { type: 'string', required: true }, messageRef: { type: 'string' }, body: { type: 'string' }, bodyOmitted: { type: 'boolean' }, sender: { type: 'string' }, occurredAt: { type: 'string' }, mentions: { type: 'array', items: { type: 'string' } }, replyToMessageRef: { type: 'string' }, replyTo: { type: 'object', additionalProperties: false, properties: { sender: { type: 'string', required: true }, excerpt: { type: 'string', required: true } } }, activity: { type: 'string' }, activityRef: { type: 'string' }, actor: { type: 'string' }, taskRef: { type: 'string' }, threadRef: { type: 'string' }, projectRef: { type: 'string' }, workerRef: { type: 'string' }, engine: { type: 'string' }, state: { type: 'string' }, reason: { type: 'string' }, claimRef: { type: 'string' }, claimRefs: { type: 'array', items: { type: 'string' } }, completedClaimRefs: { type: 'array', items: { type: 'string' } }, acceptedClaimRefs: { type: 'array', items: { type: 'string' } }, releasedClaimRefs: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, to: { type: 'string' }, refollowedMembers: { type: 'array', items: { type: 'string' } }, unread: { type: 'boolean' }, direct: { type: 'boolean' }, activityOmitted: { type: 'boolean' },
  },
} as const

/** One fact as a rejection render receives it: the read fields with tag fields widened to plain strings, because the tool's output schema types `kind` as a string rather than a literal union. */
export type RejectedFact = {
  readonly sequence: number
  readonly kind: string
  readonly messageRef?: string
  readonly body?: string
  readonly sender?: string
  readonly occurredAt?: string
  readonly mentions?: readonly string[]
  readonly replyToMessageRef?: string
  readonly replyTo?: ReplyContextView
  readonly activity?: string
  readonly actor?: string
  readonly taskRef?: string
  readonly claimRef?: string
  readonly claimRefs?: readonly string[]
  readonly completedClaimRefs?: readonly string[]
  readonly acceptedClaimRefs?: readonly string[]
  readonly releasedClaimRefs?: readonly string[]
  readonly unread?: boolean
  readonly direct?: boolean
}

export function messageIdentities(threadRef: string | undefined, facts: readonly RejectedFact[]) {
  return threadRef === undefined ? [] : facts.flatMap(fact => fact.kind === 'message' && fact.messageRef !== undefined && fact.body !== undefined
    ? [{ threadRef, messageRef: fact.messageRef, body: fact.body }]
    : [])
}

export const REMINDER_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  taskRef: { type: 'string', required: true }, kind: { type: 'string', required: true }, recipient: { type: 'string', required: true },
  baselineSequence: { type: 'number', required: true }, sequence: { type: 'number', required: true }, occurredAt: { type: 'string', required: true },
} } as const

/** A Thread-scoped result always carries the Thread fields the shared schema leaves optional for the Main stream. */
function asThreadValue<V extends { anchor?: unknown; claims?: unknown; facts?: unknown; revision?: number | undefined; threadRef?: string | undefined; following?: boolean | undefined }>(value: V): V & {
  anchor: NonNullable<V['anchor']>; claims: NonNullable<V['claims']>; facts: NonNullable<V['facts']>; revision: number; threadRef: string; following: boolean
} {
  return value as never
}

export function mainStreamLines(action: string, value: {
  readonly workspaceId: string; readonly projectRef: string; readonly kind: string
  readonly entries?: readonly MainEntryView[] | undefined; readonly cursor?: number | undefined; readonly hasMore?: boolean | undefined
  readonly readThroughSequence?: number | undefined; readonly remainingUnreadCount?: number | undefined
  readonly messageParts?: readonly MessagePart[] | undefined; readonly continuation?: string | undefined
  readonly standing?: { following: boolean } | undefined
  readonly message?: { readonly messageRef: string; readonly sender: string; readonly sequence: number; readonly occurredAt?: string | undefined; readonly body: string; readonly bodyOmitted?: boolean } | undefined
}): string[] {
  const source = `Workspace: ${value.workspaceId} · Project: ${value.projectRef} · Main stream`
  const attention = value.standing === undefined ? [] : [value.standing.following
    ? 'Attention: following — ordinary updates here will interrupt you.'
    : 'Attention: not following — ordinary updates here will not interrupt you. team_attention follow with projectRef starts them.']
  if (value.kind === 'message') {
    const message = value.message!
    const body = message.bodyOmitted === true
      ? `${message.messageRef} — body already in current context; omitted.`
      : messagePartText(message.body, value.messageParts?.find(part => part.messageRef === message.messageRef))
    return [source, `Message ${message.messageRef}`, `${message.sequence}${message.occurredAt === undefined ? '' : ` ${formatTeamTimestamp(message.occurredAt)}`} [${message.sender}]`, '', body,
      ...(value.continuation === undefined ? [] : [value.continuation])]
  }
  const entries = value.entries ?? []
  if (value.kind === 'history') {
    return [source, `History for ${value.projectRef}`, '', 'Entries', ...(entries.length === 0 ? ['No entries before this cursor.'] : entries.map(mainEntryLine)), '',
      `History cursor ${value.cursor}; hasMore=${value.hasMore ? 'true' : 'false'}${value.hasMore ? ' — older entries exist; page again with beforeSequence set to the cursor.' : ' — no older entries remain.'}`]
  }
  const incomplete = (entry: MainEntryView) => value.messageParts?.some(part => part.messageRef === entry.messageRef && !part.complete)
  const renderedEntry = (entry: MainEntryView) => mainEntryLine(entry.body === undefined ? entry
    : { ...entry, body: messagePartText(entry.body, value.messageParts?.find(part => part.messageRef === entry.messageRef)) })
  const acknowledged = entries.filter(entry => entry.unread && !incomplete(entry)).length
  const remaining = value.remainingUnreadCount ?? 0
  const background = entries.filter(entry => !entry.unread && entry.kind !== 'thread-card')
  const facts = entries.filter(entry => entry.unread && entry.kind !== 'thread-card' && !incomplete(entry))
  const partial = entries.filter(entry => entry.unread && incomplete(entry))
  const cards = entries.filter(entry => entry.kind === 'thread-card')
  return [source, ...attention,
    acknowledged === 0 ? remaining === 0 ? `Read — no unread updates on the Main stream of ${value.projectRef}.` : `Read — no facts acknowledged; ${remaining} unread update(s) remain.`
      : `Read committed — acknowledged ${acknowledged} unread update(s) on the Main stream of ${value.projectRef}; ${remaining} remain.`,
    ...(background.length === 0 ? [] : ['', 'Background — not newly acknowledged', ...background.map(renderedEntry),
      'Background is bounded; use team_thread history for older entries or message with messageRef for an original reply target.']),
    '', 'Acknowledged facts', ...(facts.length === 0 ? ['No new Message or Activity facts to acknowledge.'] : facts.map(renderedEntry)),
    ...(partial.length === 0 ? [] : ['', 'Incomplete Message — not acknowledged', ...partial.map(renderedEntry)]),
    ...(value.continuation === undefined ? [] : ['', value.continuation]),
    ...(cards.length === 0 ? [] : ['', 'Thread cards — Main entry acknowledged, not its Thread', ...cards.map(mainEntryLine)]), '',
    `Read through sequence ${value.readThroughSequence}; ${remaining} unread update(s) remaining${remaining > 0 ? ' — read again for the next page before you post.' : '.'} Speak here with team_message post; read a Thread card's Thread with team_thread read.`]
}

/** What a Message answers, as one bracketed clause: resolved context when the reader's window reaches it, otherwise the bare ref, which the reader can hand to `team_thread message` for the original text. */
function repliesToClause(replyToMessageRef: string | undefined, replyTo: ReplyContextView | undefined): string {
  if (replyToMessageRef === undefined) return ''
  return replyTo === undefined
    ? ` (replies to ${replyToMessageRef})`
    : ` (replies to @${replyTo.sender} — "${replyTo.excerpt}")`
}

export function readFactView(entry: {
  readonly fact: AgentTeamThreadFact
  readonly unread: boolean
  readonly direct: boolean
}, bodyOmitted = false, activityOmitted = false): FactView {
  return entry.fact.kind === 'message'
    ? { sequence: entry.fact.sequence, kind: 'message', messageRef: entry.fact.message.messageRef, body: entry.fact.message.body, sender: entry.fact.message.sender,
      ...(bodyOmitted ? { bodyOmitted: true } : {}),
      mentions: [...entry.fact.mentions],
      ...(entry.fact.message.replyToMessageRef === undefined ? {} : { replyToMessageRef: entry.fact.message.replyToMessageRef }),
      ...(entry.fact.replyTo === undefined ? {} : { replyTo: entry.fact.replyTo }),
      unread: entry.unread, direct: entry.direct, occurredAt: entry.fact.occurredAt }
    : { ...activityFactView(entry.fact.activity, { unread: entry.unread, direct: entry.direct }, entry.fact.occurredAt),
      ...(activityOmitted ? { activityOmitted: true } : {}) }
}

export function factLine(fact: FactView): string {
  const at = fact.occurredAt === undefined ? '' : ` ${formatTeamTimestamp(fact.occurredAt)}`
  return fact.kind === 'message'
    ? `${fact.sequence}${at} [${fact.sender ?? 'unknown sender'}]${factMarkers(fact)}${repliesToClause(fact.replyToMessageRef, fact.replyTo)} ${fact.bodyOmitted ? `${fact.messageRef} — body already in current context; omitted.` : fact.body}`
    : fact.activityOmitted === true
      ? `${fact.sequence}${at} Activity ${fact.activityRef}${factMarkers(fact)} — complete event already in current context; omitted.`
      : `${activityLine(fact)}${at}${factMarkers(fact)}`
}

export function claimLine(claim: { claimRef: string; owner: string; direction: string }): string {
  return `${claim.claimRef} — ${claim.owner}: ${claim.direction}`
}

const TEAM_THREAD_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  workspaceId: { type: 'string', required: true }, projectRef: { type: 'string', required: true },
  kind: { type: 'string', required: true }, scope: { type: 'string' }, threadRef: { type: 'string' }, taskRef: { type: 'string' },
  entries: { type: 'array', items: MAIN_ENTRY_SCHEMA }, standing: MAIN_STANDING_SCHEMA,
  messageParts: { type: 'array', items: MESSAGE_PART_SCHEMA }, continuation: { type: 'string' },
  message: { type: 'object', additionalProperties: false, properties: {
    messageRef: { type: 'string', required: true }, sender: { type: 'string', required: true }, sequence: { type: 'number', required: true }, occurredAt: { type: 'string' }, body: { type: 'string', required: true }, bodyOmitted: { type: 'boolean' },
  } },
  revision: { type: 'number' }, status: { type: 'string' }, resolution: { type: 'string' }, taskNumber: { type: 'number' }, accountable: { type: 'string' },
  following: { type: 'boolean' }, readThroughSequence: { type: 'number' }, remainingUnreadCount: { type: 'number' }, earlierFactCount: { type: 'number' }, cursor: { type: 'number' }, hasMore: { type: 'boolean' },
  taskCards: { type: 'array', items: TASK_CARD_SCHEMA },
  reminders: { type: 'array', items: REMINDER_SCHEMA },
  anchor: { type: 'object', additionalProperties: false, properties: {
    messageRef: { type: 'string', required: true }, sender: { type: 'string', required: true }, body: { type: 'string', required: true }, sequence: { type: 'number', required: true }, occurredAt: { type: 'string' },
    replyToMessageRef: { type: 'string' },
    replyTo: { type: 'object', additionalProperties: false, properties: { sender: { type: 'string', required: true }, excerpt: { type: 'string', required: true } } },
  } },
  claims: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    claimRef: { type: 'string', required: true }, direction: { type: 'string', required: true }, state: { type: 'string', required: true }, owner: { type: 'string', required: true },
  } } },
  facts: { type: 'array', items: FACT_SCHEMA },
} } as const

type ThreadResultValue = InferValue<typeof TEAM_THREAD_SCHEMA>
type ThreadRenderArgs = { action: string; beforeSequence?: number | undefined }

function renderThread(args: ThreadRenderArgs, raw: ThreadResultValue): ContentBlock[] {
  if (raw.scope === 'main') return [{ type: 'text', text: mainStreamLines(args.action, raw).join('\n') }]
  const value = asThreadValue(raw)
  const standing = taskStanding(value)
  const source = `Workspace: ${value.workspaceId} · Project: ${value.projectRef}`
  if (value.kind === 'message') {
    const message = value.message!
    const at = message.occurredAt === undefined ? '' : ` ${formatTeamTimestamp(message.occurredAt)}`
    return [{ type: 'text', text: [
      source,
      `Message ${message.messageRef}`,
      `${message.sequence}${at} [${message.sender}]`,
      '',
      message.bodyOmitted === true
        ? `${message.messageRef} — body already in current context; omitted.`
        : messagePartText(message.body, value.messageParts?.find(part => part.messageRef === message.messageRef)),
      ...(value.continuation === undefined ? [] : [value.continuation]),
    ].join('\n') }]
  }
  if (value.kind === 'history') {
    const facts = value.facts as FactView[]
    const lines = [source, `History for ${value.threadRef}${standing === '' ? '' : ` · ${standing}`}`]
    // The first page can bind the full anchor; a continuation only orients the reader.
    if (!facts.some(fact => fact.sequence === value.anchor.sequence)) {
      if (args.beforeSequence === undefined) lines.push('', `Anchor ${value.anchor.sequence}${value.anchor.occurredAt === undefined ? '' : ` ${formatTeamTimestamp(value.anchor.occurredAt)}`} [${value.anchor.sender}]${repliesToClause(value.anchor.replyToMessageRef, value.anchor.replyTo)}`, value.anchor.body)
      else lines.push(`  — ${boundedSubject(value.anchor.body)}`)
    }
    lines.push('', 'Facts')
    if (facts.length === 0) lines.push('No facts before this cursor.')
    // A card belongs to the page whose sequence window holds its creation point, so paging never repeats one.
    const windowStart = facts[0]?.sequence ?? Number.POSITIVE_INFINITY
    const windowEnd = args.beforeSequence ?? Number.POSITIVE_INFINITY
    lines.push(...factTimelineLines(facts, (value.taskCards ?? []).filter(card => card.sequence >= windowStart && card.sequence < windowEnd)))
    lines.push('', `History cursor ${value.cursor}; hasMore=${value.hasMore ? 'true' : 'false'}${value.hasMore ? ' — older facts exist; page again with beforeSequence set to the cursor.' : ' — no older facts remain.'}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const facts = value.facts as FactView[]
  const reminders = value.reminders ?? []
  const incomplete = (fact: FactView) => fact.kind === 'message' && value.messageParts?.some(part => part.messageRef === fact.messageRef && !part.complete)
  const renderedFact = (fact: FactView) => factLine(fact.kind === 'message'
    ? { ...fact, body: messagePartText(fact.body, value.messageParts?.find(part => part.messageRef === fact.messageRef)) } : fact)
  const acknowledged = facts.filter(fact => fact.unread === true && !incomplete(fact)).length + reminders.length
  const remaining = value.remainingUnreadCount ?? 0
  // A read that acknowledges nothing has no durable receipt to report.
  const lines = [
    source,
    acknowledged === 0
      ? remaining === 0 ? `Read — no unread updates on ${value.threadRef}; nothing remains.` : `Read — no facts acknowledged; ${remaining} unread update(s) remain.`
      : `Read committed — acknowledged ${acknowledged} unread update(s) on ${value.threadRef}; ${remaining} remain.`,
    `${value.threadRef}${standing === '' ? '' : ` · ${standing}`} · ${value.following ? 'following' : 'not following'}`,
    ...(value.following ? [] : ['Not following — ordinary updates here will not interrupt you. team_attention follow with threadRef starts them.']),
  ]
  // The Host includes a missing anchor as background; the subject alone is enough when it is already visible.
  const anchorInFacts = facts.some(fact => fact.sequence === value.anchor.sequence)
  if (!anchorInFacts) lines.push(`  — ${boundedSubject(value.anchor.body)}`)
  const activeClaims = value.claims.filter(claim => claim.state === 'active')
  if (activeClaims.length > 0) {
    lines.push('', 'Active Claims')
    for (const claim of activeClaims) lines.push(claimLine(claim))
  }
  if (reminders.length > 0) {
    lines.push('', 'Acknowledged Task reminders')
    for (const reminder of reminders) lines.push(`${reminder.kind === 'review-backlog' ? 'Review backlog' : 'Stalled Task'} · ${reminder.taskRef} · baseline ${reminder.baselineSequence} · raised ${formatTeamTimestamp(reminder.occurredAt)}`)
  }
  const background = facts.filter(fact => fact.unread === false)
  if (background.length > 0) lines.push('', 'Background — not newly acknowledged', ...background.map(renderedFact),
    'Background is bounded; use team_thread history for older facts or message with messageRef for an original reply target.')
  const acknowledgedFacts = facts.filter(fact => fact.unread !== false && !incomplete(fact))
  lines.push('', 'Acknowledged facts')
  if (acknowledgedFacts.length === 0) lines.push('No new facts to acknowledge.')
  lines.push(...acknowledgedFacts.map(renderedFact))
  const partial = facts.filter(fact => fact.unread === true && incomplete(fact))
  if (partial.length > 0) lines.push('', 'Incomplete Message — not acknowledged', ...partial.map(renderedFact))
  if (value.continuation !== undefined) lines.push('', value.continuation)
  if ((value.taskCards?.length ?? 0) > 0) lines.push('', 'Current Task cards — not Thread reading', ...value.taskCards!.map(taskCardLine))
  lines.push('', `Read through sequence ${value.readThroughSequence}; ${remaining} unread update(s) remaining${remaining > 0 ? ` — ${recoveryFor('unread_remaining').sentence({})}` : '.'}`)
  const earlier = value.earlierFactCount ?? 0
  if (earlier > 0) lines.push(`Earlier facts: ${earlier} — read older ones with team_thread.history.`)
  if (remaining === 0) lines.push('', nextWriteLine(value.revision))
  return [{ type: 'text', text: lines.join('\n') }]
}

export const teamThreadOutput = {
  schema: TEAM_THREAD_SCHEMA,
  render: renderThread,
  presentationMeta: (args: ThreadRenderArgs, value: ThreadResultValue): { teamFacts: ReturnType<typeof teamMessageSurface> } => {
    // The Host only trusts a binding whose digest matches the text the model actually saw.
    const text = renderThread(args, value).flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    if (value.scope === 'main') {
      const messages = value.kind === 'message' ? value.message === undefined || value.message.bodyOmitted === true ? [] : [value.message]
        : (value.entries ?? []).filter(entry => entry.kind === 'message' && !entry.bodyOmitted)
      return { teamFacts: teamMessageSurface(text, messages.flatMap(message => message.messageRef === undefined || message.body === undefined
        ? [] : [{ projectRef: value.projectRef, messageRef: message.messageRef, body: message.body,
          ...(value.messageParts?.find(part => part.messageRef === message.messageRef) === undefined ? {}
            : { part: value.messageParts!.find(part => part.messageRef === message.messageRef)! }) }]),
        activityBindings(value.entries ?? [], value.projectRef)) }
    }
    const facts = value.kind === 'message'
      ? value.message === undefined ? [] : [{ ...value.message, kind: 'message' as const }]
      : [...value.facts ?? []]
    const anchorInFacts = facts.some(fact => fact.sequence === value.anchor?.sequence)
    const fullAnchor = value.kind === 'history' && args.beforeSequence === undefined
    if (value.kind !== 'message' && !anchorInFacts && fullAnchor && value.anchor !== undefined) {
      facts.push({ ...value.anchor, kind: 'message' })
    }
    return { teamFacts: teamMessageSurface(text, messageIdentities(value.threadRef, facts.filter(fact => !('bodyOmitted' in fact && fact.bodyOmitted)))
      .map(message => { const part = value.messageParts?.find(part => part.messageRef === message.messageRef)
        return { ...message, ...(part === undefined ? {} : { part: { start: part.start, end: part.end } }) } }), activityBindings(facts)) }
  },
}
