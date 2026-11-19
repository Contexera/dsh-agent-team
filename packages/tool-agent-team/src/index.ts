import type { Context } from '@deepseek-ai/cordis'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamDmDeliveryError, markAgentTeamPreset, reminderRefForCallId, teamMessageSurface, activityText } from '@contexera/dsh-agent-team/host'
import { formatTeamTimestamp } from '@contexera/dsh-agent-team/time-format'
import { projectRefOf, service, workspaceOf, workspaceParam } from './host-access.ts'
import { memberTarget } from './member-target.ts'
import { recoveryFor } from '@contexera/dsh-agent-team/recovery-hints'
import type {
  AgentTeamActivity,
  AgentTeamAttentionSource,
  AgentTeamClaimRef,
  AgentTeamInboxReminder,
  AgentTeamMemberReminder,
  AgentTeamReminderRef,
  AgentTeamReminderSchedule,
  AgentTeamMemberId,
  AgentTeamModelSelection,
  AgentTeamManagerSessionEvidenceFailureKind,
  AgentTeamManagerSessionEvidenceLocator,
  AgentTeamManagerSessionEvidenceState,
  AgentTeamMemberCapabilities,
  AgentTeamOwnedProject,
  AgentTeamRequestId,
  AgentTeamMessageRef,
  AgentTeamProjectRef,
  AgentTeamTaskRef,
  AgentTeamTaskBoardItem,
  AgentTeamThreadFact,
  AgentTeamThreadRef,
  AgentTeamThreadTaskCard,
} from '@contexera/dsh-agent-team/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAIN_ENTRY_SCHEMA, MAIN_STANDING_SCHEMA, mainEntryLine, mainEntryView, standingView } from './main-stream.ts'
import { budgetReading, readingCapacity, messagePartText, MESSAGE_PART_SCHEMA, type MessagePart } from './reading-budget.ts'
import type { MainEntryView } from './main-stream.ts'
import { activityFromView } from './activity-view.ts'
import { teamSubscription } from './subscription.ts'

/** The complete Activity facts a rendered surface binds; an omitted identity is already bound by its original output. */
function activityBindings(views: readonly { readonly kind?: string; readonly activityOmitted?: boolean }[], projectRef?: string) {
  return views.flatMap(view => {
    if (view.kind !== 'activity' || view.activityOmitted === true) return []
    const complete = activityFromView(view as Parameters<typeof activityFromView>[0], projectRef)
    return complete === undefined ? [] : [complete]
  })
}

export const name = 'contexera-agent-team-tools'
export const inject = ['tools']

/** One shared bound for every bounded anchor subject a render shows. */
const SUBJECT_BOUND = 80

/** Model-facing view of one structured Thread activity fact, shared by read, history and rejections. */
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

/** Model-facing view of one message fact. */
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
  /** The Message this one answers, when it is a reply. */
  readonly replyToMessageRef?: string
  /** The same target resolved for reading: who wrote it and its first line. Separate from `replyToMessageRef` (the ref you pass back to `team_message.reply`) because one field carrying both meanings would be wrong half the time. */
  readonly replyTo?: ReplyContextView
}

/** One Message's answer target, as the Agent surfaces print it. */
interface ReplyContextView {
  readonly sender: string
  readonly excerpt: string
}

type FactView = MessageFactView | ActivityFactView

/** Model-facing view of one Claim, shared by the read collision surface and claim outcomes. */
interface ClaimView {
  readonly claimRef: string
  readonly direction: string
  readonly state: string
  readonly owner: string
}

function claimView(claim: { readonly claimRef: AgentTeamClaimRef; readonly direction: string; readonly state: string; readonly owner: string }): ClaimView {
  return { claimRef: claim.claimRef, direction: claim.direction, state: claim.state, owner: claim.owner }
}

/** The one Activity → view projection: every immutable field, so the view can rebuild the exact fact the Host bound. */
function activityFactView(
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

/** The one deterministic bounded subject for directory rows and Thread orientation: whitespace collapses to one line, then one bounded cut with an explicit truncation mark, so surfaces never disagree about what a Thread is about. */
function boundedSubject(body: string): string {
  const collapsed = body.replaceAll(/\s+/gu, ' ').trim()
  return collapsed.length <= SUBJECT_BOUND ? collapsed : `${collapsed.slice(0, SUBJECT_BOUND - 1)}…`
}

/** Unread/direct markers sit on the fact line itself; a fact carrying neither renders neither. */
function factMarkers(fact: FactView): string {
  if (fact.unread === undefined) return ''
  if (fact.direct === true) return ' [direct]'
  if (fact.unread === true) return ' [unread]'
  return ''
}

/** One complete Activity fact's line; the Host's shared formatter is the only Activity rendering. */
function activityLine(fact: ActivityFactView): string {
  const complete = activityFromView(fact)
  if (complete === undefined) throw new Error(`Activity view at sequence ${fact.sequence} lacks its immutable identity`)
  return activityText(complete)
}

/** The single explicit hand-off of a usable write token. */
function nextWriteLine(revision: number): string {
  return `Next write — baseRevision: ${revision} (copy exactly; never derive or cite).`
}

/** Task standing inline on a Thread identity line; absent on taskless Threads. Accountability rides along whenever the result carries it, because who is responsible for the Task changes what the reader may do next. */
function taskStanding(value: { taskRef?: string; status?: string; resolution?: string; taskNumber?: number; accountable?: string }): string {
  if (value.taskRef === undefined) return ''
  return `${value.taskRef}${value.taskNumber === undefined ? '' : ` (#${value.taskNumber})`}${value.status === undefined ? '' : `, ${value.status}${value.resolution === undefined ? '' : `/${value.resolution}`}`}${value.accountable === undefined ? '' : ` · accountable ${value.accountable}`}`
}

/** One Task a discussion spawned, as the card its Thread renders at the creation point: current state, never a fact, never unread. */
interface TaskCardView {
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

function taskCardView(entry: AgentTeamThreadTaskCard): TaskCardView {
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

/** The one model-facing schema for a Thread fact, shared by the read result and by the facts a rejected write carries back. */
const FACT_SCHEMA = {
  type: 'object', additionalProperties: false, properties: {
    sequence: { type: 'number', required: true }, kind: { type: 'string', required: true }, messageRef: { type: 'string' }, body: { type: 'string' }, bodyOmitted: { type: 'boolean' }, sender: { type: 'string' }, occurredAt: { type: 'string' }, mentions: { type: 'array', items: { type: 'string' } }, replyToMessageRef: { type: 'string' }, replyTo: { type: 'object', additionalProperties: false, properties: { sender: { type: 'string', required: true }, excerpt: { type: 'string', required: true } } }, activity: { type: 'string' }, activityRef: { type: 'string' }, actor: { type: 'string' }, taskRef: { type: 'string' }, threadRef: { type: 'string' }, projectRef: { type: 'string' }, workerRef: { type: 'string' }, engine: { type: 'string' }, state: { type: 'string' }, reason: { type: 'string' }, claimRef: { type: 'string' }, claimRefs: { type: 'array', items: { type: 'string' } }, completedClaimRefs: { type: 'array', items: { type: 'string' } }, acceptedClaimRefs: { type: 'array', items: { type: 'string' } }, releasedClaimRefs: { type: 'array', items: { type: 'string' } }, from: { type: 'string' }, to: { type: 'string' }, refollowedMembers: { type: 'array', items: { type: 'string' } }, unread: { type: 'boolean' }, direct: { type: 'boolean' }, activityOmitted: { type: 'boolean' },
  },
} as const

function requestId(agentId: string, callId: string): AgentTeamRequestId {
  return `agent-team:tool:${agentId}:${callId}` as AgentTeamRequestId
}

/**
 * Some models fill every optional parameter slot with `""` (or a zero count) instead
 * of omitting it, and every guard below asks `!== undefined`. Normalizing blanks to
 * "not passed" at the entry keeps those guards honest and the address parameters
 * resolvable, without weakening the guards for genuinely malformed values. Only
 * address/selection parameters are normalized — `body` is content, where an empty
 * string is a real error the tool must report, not a missing field. An empty
 * collection names nothing to honor, exactly as an empty address names no target.
 * An empty object is the same statement in object form: it selects nothing, so it
 * reads as "not passed" rather than as a value to forward.
 */
function blankToAbsent<T extends { readonly [key: string]: unknown }>(args: T, keys: readonly string[]): T {
  const copy: Record<string, unknown> = { ...args }
  for (const key of keys) {
    const value = copy[key]
    if (value === '' || value === 0 || value === false || (Array.isArray(value) && value.length === 0)
      || (typeof value === 'object' && value !== null && Object.keys(value).length === 0)) delete copy[key]
  }
  return copy as T
}

/** The address/selection parameters every Team tool treats as optional presence. */
const OPTIONAL_ADDRESS_KEYS = ['workspace', 'projectRef', 'threadRef', 'taskRef', 'messageRef', 'replyToMessageRef',
  'claimRef', 'memberRef', 'accountable', 'target', 'beforeSequence', 'limit', 'cursor', 'mine', 'baseRevision',
  'reminderRef'] as const

/** Optional collection parameters where `[]` names nothing and must not be read as a real argument. */
const OPTIONAL_COLLECTION_KEYS = ['attachments', 'sourceThreadRefs'] as const

/**
 * A reminder's schedule slots, which `create` alone takes. They are normalized
 * like an address so a model that fills every slot on a list or a cancel is not
 * charged a retry for blanks it never meant; a value that is actually there is
 * refused, because a schedule on a cancel names a reminder the caller did not pick.
 */
const OPTIONAL_SCHEDULE_KEYS = ['scheduleKind', 'at', 'minutes', 'expression'] as const

/** Non-create actions tolerate the default selector, but never real schedule content. */
const CREATE_ONLY_REMINDER_CONTENT_KEYS = ['at', 'minutes', 'expression', 'note'] as const

/** Only the first enum value is a neutral fill; other selections remain conflicts. */
function refuseNonDefaultScheduleKind(action: 'cancel' | 'list', scheduleKind: string | undefined): void {
  if (scheduleKind === undefined || scheduleKind === 'once') return
  throw new Error(recoveryFor('action_only_arguments').sentence({ action, parameter: 'scheduleKind', owner: 'create' }))
}

/** One fact as a rejection render receives it: the read fields with tag fields widened to plain strings, because the tool's output schema types `kind` as a string rather than a literal union. */
type RejectedFact = {
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

const REJECTION_FACT_LIMIT = 20
const REJECTION_BODY_MAX_CHARACTERS = 8 * 1024
const REJECTION_MAX_CHARACTERS = 16 * 1024
const REJECTION_BODY_TRUNCATION_MARKER = '[Message body truncated; the full change is not shown here.]'

function messageIdentities(threadRef: string | undefined, facts: readonly RejectedFact[]) {
  return threadRef === undefined ? [] : facts.flatMap(fact => fact.kind === 'message' && fact.messageRef !== undefined && fact.body !== undefined
    ? [{ threadRef, messageRef: fact.messageRef, body: fact.body }]
    : [])
}

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

/** Selection, recovery guidance and the surface binding describe the same bounded result. */
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

const REMINDER_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  taskRef: { type: 'string', required: true }, kind: { type: 'string', required: true }, recipient: { type: 'string', required: true },
  baselineSequence: { type: 'number', required: true }, sequence: { type: 'number', required: true }, occurredAt: { type: 'string', required: true },
} } as const

const teamInbox = defineTool({
  name: 'team_inbox',
  description: 'List your bounded Team Inbox across all joined Workspaces for triage: unread Thread summaries and one row per Project Main stream with unread for you, with counts, without message bodies and without marking anything read. Read a selected Thread with team_thread read; the inbox itself authorizes no mutation. This is your own unread queue; to see work in flight (whether or not you have unread on it), use team_task board.',
  parameters: { limit: { type: 'number' }, workspace: workspaceParam },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
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
    } },
        // Triage surface only: totals, both counters per row (direct renders even when zero), a bounded-list conclusion so truncation never reads as drained, and one route to the tool that acknowledges work. No subject, body, revision label, or write token: the required current read supplies the write basis.
    render: (_args, value) => {
      if (value.items.length === 0 && value.main.length === 0) {
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
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, OPTIONAL_ADDRESS_KEYS)
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_inbox requires an Agent session')
    const host = service(agent)
    const inbox = host.inboxForAgent(agent, { ...(args.workspace === undefined ? {} : { workspaceId: workspaceOf(args, agent) }), ...(args.limit === undefined ? {} : { limit: args.limit }) })
    return {
      totalUnreadCount: inbox.totalUnreadCount, totalDirectCount: inbox.totalDirectCount, hasMore: inbox.hasMore,
      main: inbox.main.map(row => ({ workspaceId: row.workspaceId, projectRef: row.projectRef, projectName: row.projectName,
        unreadCount: row.unreadCount, directCount: row.directCount, newestOccurredAt: row.newestOccurredAt })),
      items: inbox.items.map(item => {
        const taskNumber = item.taskNumber
        return { workspaceId: item.workspaceId, threadRef: item.thread.threadRef, projectRef: item.projectRef,
          ...(item.task === undefined ? {} : { taskRef: item.task.taskRef, status: item.task.status, accountable: item.task.accountable }),
          revision: item.thread.revision, unreadCount: item.unreadCount, directCount: item.directCount, newestOccurredAt: item.newestOccurredAt,
          ...(taskNumber === undefined ? {} : { taskNumber }), reminders: [...(item.reminders ?? [])] }
      }),
    }
  },
})

/** What each Attention source means to the reader, in the words the result uses. */
const CAUSE_OF_SOURCE: Record<AgentTeamAttentionSource, string> = {
  'thread-author': 'because you started it',
  claim: 'because you claimed its Task',
  accountable: 'because you are accountable for its Task',
  'project-owner': 'because you own the Project',
  mention: 'because you were named in it',
  self: 'because you chose to follow',
}

/**
 * The phrase for one source, or an empty string when the value is absent or is
 * not a source this build writes: a render never prints a raw enum value or the
 * word `undefined`, and a source added later cannot silently render as nothing.
 */
function causeOf(source: string | undefined): string {
  if (source === undefined) return ''
  const phrase = CAUSE_OF_SOURCE[source as AgentTeamAttentionSource]
  return phrase === undefined ? '' : `(${phrase})`
}

/** Attention (following a Thread) is a different question from reading one. `status`, `follow`, and `unfollow` take one Thread address or the Main stream address, plus the routing Workspace; sharing a parameter pocket with read would put `messageRef`, `beforeSequence`, and `limit` in front of actions that never accept them. */
const teamAttention = defineTool({
  name: 'team_attention',
  description: `Read or change your Attention — whether you are following one Thread or a Project's Main stream. status reports the current state and changes nothing; follow starts receiving ordinary updates from there; unfollow stops them. Attention is not reading: none of these actions render facts, acknowledge unread work, or hand off a write token, and reading never changes whether you follow it. Address one Thread with threadRef or taskRef (when both are given they must identify the same Thread), or address the Main stream with projectRef — never both a Thread and projectRef. Unfollowing stops ordinary updates but leaves every mention, reply and responsibility event reaching you; it does not release a Claim or drop a Task you are accountable for. While you hold an active Claim on this Thread's Task, your unfollow is refused: finish the work or release the Claim first.`,
  parameters: {
    action: { type: 'string', required: true, enum: ['status', 'follow', 'unfollow'] },
    threadRef: { type: 'string', description: "Full branded Thread ref exactly as returned by Team tools, including the 'thread:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    taskRef: { type: 'string', description: "Optional Task ref alias when this Thread has a Task. Prefer threadRef; if both are given they must identify the same Thread." },
    projectRef: { type: 'string', description: "Full branded Project ref: addresses that Project's Main stream instead of a Thread. Never with threadRef or taskRef." },
    workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      workspaceId: { type: 'string', required: true }, projectRef: { type: 'string', required: true },
      kind: { type: 'string', required: true }, threadRef: { type: 'string' }, taskRef: { type: 'string' },
      revision: { type: 'number' }, status: { type: 'string' }, resolution: { type: 'string' }, taskNumber: { type: 'number' }, accountable: { type: 'string' },
      following: { type: 'boolean', required: true }, scope: { type: 'string' }, source: { type: 'string' },
    } },
        // Renders are the only channel a tool result reaches the model through. One outcome line, what established the Attention, and the one consequence the model cannot infer from the verb alone.
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
      // Why the reader follows, stated only once the standing is there to support
      // it: a Member that never followed has no cause to name, and a row the
      // ledger cannot attribute is reported as the reader's own choice rather
      // than guessed at.
      const cause = value.following === false ? '' : causeOf(value.source)
      if (value.kind === 'follow' || value.kind === 'unfollow') {
        return [{ type: 'text', text: `${source}\nAttention changed — ${value.following ? 'now following' : 'no longer following'} ${subject}${standing === '' ? '' : ` · ${standing}`}${cause}.\n${consequence}` }]
      }
      return [{ type: 'text', text: `${source}\nAttention status — ${value.following ? 'following' : 'not following'} ${subject}${standing === '' ? '' : ` · ${standing}`}${cause}.\n${consequence}` }]
    },
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, OPTIONAL_ADDRESS_KEYS)
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_attention requires an Agent session')
    const host = service(agent)
    const threadAddressed = args.threadRef !== undefined || args.taskRef !== undefined
    if (!threadAddressed && args.projectRef === undefined) {
      throw new Error(`team_attention needs one of threadRef, taskRef, or projectRef (the Main stream) — ${recoveryFor('missing_thread_identity').sentence({})}`)
    }
    if (threadAddressed && args.projectRef !== undefined) {
      throw new Error(`team_attention takes either a Thread or a projectRef for the Main stream, never both — ${recoveryFor('main_stream_addressing').sentence({ refused: 'a Thread ref and projectRef' })}`)
    }
    if (args.projectRef !== undefined) {
      const base = { workspaceId: workspaceOf(args, agent), projectRef: args.projectRef as AgentTeamProjectRef }
      if (args.action === 'status') {
        const status = host.mainAttentionStatusForAgent(agent, base)
        return mainAttentionResult('status', base.workspaceId, status.project.projectRef, status.attention !== undefined, status.attention?.source)
      }
      const result = await host.changeAttentionForAgent(agent, { requestId: requestId(agent.id, exec.callId), ...base, action: args.action })
      if (!('project' in result)) throw new Error('expected a Main stream Attention result')
      return mainAttentionResult(args.action, base.workspaceId, result.project.projectRef, result.attention !== undefined, result.attention?.source)
    }
    const base = { workspaceId: workspaceOf(args, agent), ...(args.threadRef === undefined ? {} : { threadRef: args.threadRef as AgentTeamThreadRef }), ...(args.taskRef === undefined ? {} : { taskRef: args.taskRef as AgentTeamTaskRef }) }
    const taskNumberOf = (task: { taskRef: AgentTeamTaskRef } | undefined): { taskNumber?: number } => {
      if (task === undefined) return {}
      const resolved = host.resolveTaskRefs({ workspaceId: base.workspaceId, taskRefs: [task.taskRef] }).resolved[0]
      return resolved === undefined ? {} : { taskNumber: resolved.taskNumber }
    }
    if (args.action === 'status') {
      const status = host.attentionStatusForAgent(agent, base)
      const snapshot = host.threadHistoryForAgent(agent, { ...base, beforeSequence: 1, limit: 1 })
      return attentionResult('status', base.workspaceId, snapshot, status.attention, taskNumberOf(snapshot.task))
    }
    const result = await host.changeAttentionForAgent(agent, { requestId: requestId(agent.id, exec.callId), ...base, action: args.action })
    const snapshot = host.threadHistoryForAgent(agent, { ...base, beforeSequence: 1, limit: 1 })
    // A Thread request can only answer with the Thread face; the Main stream
    // face is reached through projectRef above.
    if (!('thread' in result)) throw new Error('expected a Thread Attention result')
    return attentionResult(args.action, base.workspaceId, snapshot, result.attention, taskNumberOf(snapshot.task))
  },
})

/** The one result shape a Main stream Attention action returns: address, scope, and the standing itself. */
function mainAttentionResult(kind: 'status' | 'follow' | 'unfollow', workspaceId: string, projectRef: string, following: boolean, source?: AgentTeamAttentionSource) {
  return { workspaceId, projectRef, kind, scope: 'main', following, ...(source === undefined ? {} : { source }) }
}

/** The one result shape every Attention action returns: address, standing, and the state itself. */
function attentionResult(
  kind: 'status' | 'follow' | 'unfollow',
  workspaceId: string,
  snapshot: ReturnType<AgentTeam['threadHistoryForAgent']>,
  attention: Awaited<ReturnType<AgentTeam['readThreadForAgent']>>['attention'],
  task: { taskNumber?: number; accountable?: string },
): { workspaceId: string; projectRef: string; kind: string; threadRef: string; revision: number; following: boolean; source?: AgentTeamAttentionSource; taskRef?: string; status?: string; resolution?: string; taskNumber?: number; accountable?: string } {
  return {
    workspaceId, projectRef: snapshot.anchor.projectRef,
    kind, threadRef: snapshot.thread.threadRef, revision: snapshot.thread.revision,
    ...(snapshot.task === undefined ? {} : { taskRef: snapshot.task.taskRef, status: snapshot.task.status, resolution: snapshot.task.resolution, accountable: snapshot.task.accountable }),
    ...(task.taskNumber === undefined ? {} : { taskNumber: task.taskNumber }),
    following: attention !== undefined,
    // Present only once the Member follows, so a status or an unfollow does not
    // name a cause the standing cannot support.
    ...(attention === undefined ? {} : { source: attention.source }),
  }
}

const teamThread = defineTool({
  name: 'team_thread',
  description: `Read one Thread's facts, or a Project's Main stream (pass projectRef and omit Thread refs — a call addresses one or the other, never both). read acknowledges one chronological batch of unread facts and is the only read-side source of a next-write token — and only once no unread remains; your own committed public mutations hand off the token as well. Thread/Main read restores missing recent originals plus the Thread anchor, including after compaction with no unread. Complete Message bodies and Activity events already visible in context are acknowledged by identity only; missing facts are supplied. history pages older facts without changing read state. read/message output is capped at 32768 UTF-16 units including framing: a long Message returns ordered parts, and repeating the same request fills the first gap in current context. read confirms only after every part is present; message never confirms. A Message capacity error needs shorter Messages or a larger-context model, not retries. An Activity event cannot be split; a fixed output-limit error needs Human inspection. [attachment] paths are reading locators, not attachment contents. message reads one Message by ref to answer a \`Replies to:\` line; for a Thread it requires threadRef (if taskRef is also given, it must identify the same Thread), while projectRef addresses the Main stream. beforeSequence and limit page history: read ignores them, whose batch is bounded by design and names how much remains; message rejects them — ${recoveryFor('history_only_arguments').sentence({ action: 'message' })} For read/history, prefer threadRef; taskRef is a Task alias when both identify the same Thread. Attention is team_attention and never changes here. On the Main stream, read returns the oldest pending entries and missing recent background; it acknowledges only the delivered prefix — ordinary entries covered by your Main stream Attention and your direct markers — and a backlog is read oldest first, one page per read, until none remains; history pages older entries; Thread cards name the Thread to read.`,
  parameters: {
    action: { type: 'string', required: true, enum: ['read', 'history', 'message'] },
    threadRef: { type: 'string', description: "Full branded Thread ref exactly as returned by Team tools, including the 'thread:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    projectRef: { type: 'string', description: "Full branded Project ref: reads that Project's Main stream instead of a Thread. Never with threadRef or taskRef." },
    taskRef: { type: 'string', description: "Optional Task ref alias for read and history when this Thread has a Task. Prefer threadRef; if both are given they must identify the same Thread. For message on a Thread, pass threadRef; taskRef alone does not address a Message. projectRef addresses the Main stream." },
    messageRef: { type: 'string', description: "For action `message`: the full branded Message ref to read back, exactly as rendered by this tool or by an inbox notice — including the `message:` prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    beforeSequence: { type: 'number', description: 'history only: the oldest fact sequence to page before (exclusive). message rejects it; read ignores it, since a read batch is bounded by design.' }, limit: { type: 'number', description: 'history only: max older facts to return, 1–100, default 20. message rejects it; read ignores it, since a read batch is bounded by design.' }, workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
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
    } },
        // Renders are the only channel a tool result reaches the model through. read renders outcome → context → orientation → active collision surface → facts → watermark, handing off the next-write token only when no unread remains. history renders deep orientation and never the collision surface or a write token.
    render: (args, raw) => {
      if (raw.scope === 'main') return [{ type: 'text', text: mainStreamLines(args.action, raw).join('\n') }]
      const value = asThreadValue(raw)
      const standing = taskStanding(value)
      const source = `Workspace: ${value.workspaceId} · Project: ${value.projectRef}`
      if (value.kind === 'message') {
                // Verbatim, and the only action that is: the reader asked for this Message to answer it.
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
                // First page orients on the full anchor; a continuation on the shared bounded subject. An anchor already selected as a fact never repeats.
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
            // kind === 'read': outcome → context → orientation → collision surface → facts → watermark → token (iff nothing unread remains).
      const facts = value.facts as FactView[]
      const reminders = value.reminders ?? []
      const incomplete = (fact: FactView) => fact.kind === 'message' && value.messageParts?.some(part => part.messageRef === fact.messageRef && !part.complete)
      const renderedFact = (fact: FactView) => factLine(fact.kind === 'message'
        ? { ...fact, body: messagePartText(fact.body, value.messageParts?.find(part => part.messageRef === fact.messageRef)) } : fact)
      const acknowledged = facts.filter(fact => fact.unread === true && !incomplete(fact)).length + reminders.length
      const remaining = value.remainingUnreadCount ?? 0
            // A read with nothing unread writes no durable operation, so the opening line claims a commit only when unread facts were acknowledged.
      const lines = [
        source,
        acknowledged === 0
          ? remaining === 0 ? `Read — no unread updates on ${value.threadRef}; nothing remains.` : `Read — no facts acknowledged; ${remaining} unread update(s) remain.`
          : `Read committed — acknowledged ${acknowledged} unread update(s) on ${value.threadRef}; ${remaining} remain.`,
        `${value.threadRef}${standing === '' ? '' : ` · ${standing}`} · ${value.following ? 'following' : 'not following'}`,
        // Reading is not following: the one consequence a reader cannot infer
        // from the verb, stated where it can act on it.
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
            // The bounded read answered with the newest batch; the span before the watermark is orientation it did not supply, and rendering its count shows the returning reader the size of that span.
      const earlier = value.earlierFactCount ?? 0
      if (earlier > 0) lines.push(`Earlier facts: ${earlier} — read older ones with team_thread.history.`)
      if (remaining === 0) lines.push('', nextWriteLine(value.revision))
      return [{ type: 'text', text: lines.join('\n') }]
    },
    presentationMeta: (args, value): { teamFacts: ReturnType<typeof teamMessageSurface> } => {
      const text = teamThread.output.render(args, value).flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
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
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, OPTIONAL_ADDRESS_KEYS)
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_thread requires an Agent session')
    const host = service(agent)
    // Only `read` and `message` need the model's capacity: `history` pages by
    // count under its own bound, so it never resolves model info.
    const capacity = args.action === 'history' ? Number.POSITIVE_INFINITY : await readingCapacity(agent, exec.signal)
    if (args.projectRef !== undefined) return mainStreamOutcome(host, agent, args, requestId(agent.id, exec.callId), capacity)
    if (args.threadRef === undefined && args.taskRef === undefined) throw new Error(`team_thread needs threadRef (or taskRef on a Taskful Thread) — ${recoveryFor('missing_thread_identity').sentence({})}`)
    const base = { workspaceId: workspaceOf(args, agent), ...(args.threadRef === undefined ? {} : { threadRef: args.threadRef as AgentTeamThreadRef }), ...(args.taskRef === undefined ? {} : { taskRef: args.taskRef as AgentTeamTaskRef }) }
    const taskNumberOf = (task: { taskRef: AgentTeamTaskRef } | undefined): { taskNumber?: number } => {
      if (task === undefined) return {}
      const resolved = host.resolveTaskRefs({ workspaceId: base.workspaceId, taskRefs: [task.taskRef] }).resolved[0]
      return resolved === undefined ? {} : { taskNumber: resolved.taskNumber }
    }
        // `messageRef` belongs to the `message` action alone. The parameter schema is implicitly open, so nothing refuses it elsewhere and a silent drop would tell the model nothing. One guard before the branches covers every other action, including future read actions.
    if (args.action !== 'message' && args.messageRef !== undefined) {
      throw new Error(recoveryFor('action_only_arguments').sentence({ action: args.action, parameter: 'messageRef', owner: 'message' }))
    }
    if (args.action === 'history') {
      const history = host.threadHistoryForAgent(agent, { ...base, ...(args.beforeSequence === undefined ? {} : { beforeSequence: args.beforeSequence }), ...(args.limit === undefined ? {} : { limit: args.limit }) })
      const status = host.attentionStatusForAgent(agent, base)
      return threadResult('history', base.workspaceId, history, status.attention, history.facts.map(fact => fact.kind === 'message'
          ? { sequence: fact.sequence, kind: 'message', messageRef: fact.message.messageRef, body: fact.message.body, sender: fact.message.sender, mentions: [...fact.mentions], ...(fact.message.replyToMessageRef === undefined ? {} : { replyToMessageRef: fact.message.replyToMessageRef }), ...(fact.replyTo === undefined ? {} : { replyTo: fact.replyTo }), occurredAt: fact.occurredAt }
          : activityFactView(fact.activity, undefined, fact.occurredAt)), { cursor: history.cursor, hasMore: history.hasMore, taskCards: (history.taskCards ?? []).map(taskCardView), ...taskNumberOf(history.task) })
    }
    if (args.action === 'message') {
      if (args.messageRef === undefined) throw new Error(recoveryFor('missing_message_ref').sentence({ refused: 'for action message' }))
            // Reading one Message requires threadRef; taskRef alone cannot address it. The orientation lookup below still checks that both refs agree.
      if (args.threadRef === undefined) throw new Error(`message needs threadRef — ${recoveryFor('missing_thread_identity').sentence({})}`)
      if (args.beforeSequence !== undefined || args.limit !== undefined) throw new Error(recoveryFor('history_only_arguments').sentence({ action: 'message' }))
      const readBack = host.readMessageForAgent(agent, {
        workspaceId: base.workspaceId,
        threadRef: args.threadRef as AgentTeamThreadRef,
        messageRef: args.messageRef as AgentTeamMessageRef,
      })
            // The ordinary orientation is still returned so every action answers with one shape; the Message read back rides alongside.
      const snapshot = host.threadHistoryForAgent(agent, { ...base, beforeSequence: 1, limit: 1 })
      const status = host.attentionStatusForAgent(agent, base)
      const value = threadResult('message', base.workspaceId, snapshot, status.attention, [], {
        message: { messageRef: readBack.messageRef, sender: readBack.sender, sequence: readBack.sequence, ...(readBack.occurredAt === undefined ? {} : { occurredAt: readBack.occurredAt }), body: readBack.body, bodyOmitted: false },
        ...taskNumberOf(snapshot.task),
      })
      return budgetReading(agent, value, (candidate): string => teamThread.output.render(args, candidate as never).map((part: { type: string; text?: string }) => part.type === 'text' ? part.text : '').join('\n'), capacity).value
    }
        // `read` is the one action that returns a bounded batch by design — its Host request carries neither paging field, so a page size here cannot be honored. Refusing the whole call taught the model nothing: one real session retried the identical arguments twice. The batch it did get names what remains, which is the route to more.
    if (args.action !== 'read' && (args.beforeSequence !== undefined || args.limit !== undefined)) {
      throw new Error(recoveryFor('history_only_arguments').sentence({ action: args.action }))
    }
    const view = (read: Awaited<ReturnType<AgentTeam['readThreadForAgent']>>) => {
      const cards = read.task === undefined
        ? (host.threadHistoryForAgent(agent, { ...base, beforeSequence: 1, limit: 1 }).taskCards ?? []).map(taskCardView) : []
      return threadResult('read', base.workspaceId, read, read.attention, read.facts.map(entry => readFactView(entry,
        entry.fact.kind === 'message' && read.visibleMessageRefs.includes(entry.fact.message.messageRef),
        entry.fact.kind === 'activity' && read.visibleActivityRefs.includes(entry.fact.activity.activityRef))), {
        readThroughSequence: read.readThroughSequence, remainingUnreadCount: read.remainingUnreadCount, reminders: [...read.reminders],
        ...(read.earlierFactCount === undefined ? {} : { earlierFactCount: read.earlierFactCount }), taskCards: cards, ...taskNumberOf(read.task) })
    }
    let selected: ReturnType<typeof view> | undefined
    const read = await host.readThreadForAgent(agent, { requestId: requestId(agent.id, exec.callId), ...base }, preview => {
      const budget = budgetReading(agent, view(preview), value => teamThread.output.render(args, value as never).map(part => part.type === 'text' ? part.text : '').join('\n'), capacity)
      selected = budget.value
      return budget.through
    })
    if (selected === undefined) return budgetReading(agent, view(read),
      (value): string => teamThread.output.render(args, value as never).map((part: { type: string; text?: string }) => part.type === 'text' ? part.text : '').join('\n'), capacity).value
    return { ...selected, readThroughSequence: read.readThroughSequence, remainingUnreadCount: read.remainingUnreadCount }
  },
})

/** A Thread-scoped result always carries the Thread fields the shared schema leaves optional for the Main stream. */
function asThreadValue<V extends { anchor?: unknown; claims?: unknown; facts?: unknown; revision?: number | undefined; threadRef?: string | undefined; following?: boolean | undefined }>(value: V): V & {
  anchor: NonNullable<V['anchor']>; claims: NonNullable<V['claims']>; facts: NonNullable<V['facts']>; revision: number; threadRef: string; following: boolean
} {
  return value as never
}

/** The Main stream reads of `team_thread`, rendered from the Host's timeline entries. */
function mainStreamLines(action: string, value: {
  readonly workspaceId: string; readonly projectRef: string; readonly kind: string
  readonly entries?: readonly MainEntryView[] | undefined; readonly cursor?: number | undefined; readonly hasMore?: boolean | undefined
  readonly readThroughSequence?: number | undefined; readonly remainingUnreadCount?: number | undefined
  readonly messageParts?: readonly MessagePart[] | undefined; readonly continuation?: string | undefined
  readonly standing?: { following: boolean } | undefined
  readonly message?: { readonly messageRef: string; readonly sender: string; readonly sequence: number; readonly occurredAt?: string | undefined; readonly body: string; readonly bodyOmitted?: boolean } | undefined
}): string[] {
  const source = `Workspace: ${value.workspaceId} · Project: ${value.projectRef} · Main stream`
  // The standing names the reader's own Attention, which is the one fact this
  // read cannot show: reading is not following, and neither changes the other.
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

async function mainStreamOutcome(
  host: AgentTeam,
  agent: Parameters<typeof workspaceOf>[1],
  args: { readonly action: string; readonly projectRef?: string | undefined; readonly threadRef?: string | undefined; readonly taskRef?: string | undefined
    readonly messageRef?: string | undefined; readonly beforeSequence?: number | undefined; readonly limit?: number | undefined; readonly workspace?: string | undefined },
  readRequestId: AgentTeamRequestId,
  capacity: number,
) {
  if (args.threadRef !== undefined || args.taskRef !== undefined) throw new Error(recoveryFor('main_stream_addressing').sentence({ refused: 'a Thread ref and projectRef' }))
  const workspaceId = workspaceOf(args, agent)
  const projectRef = projectRefOf(args.projectRef!) as AgentTeamProjectRef
  const base = { workspaceId, scope: 'main' }
  if (args.action !== 'message' && args.messageRef !== undefined) {
    throw new Error(recoveryFor('action_only_arguments').sentence({ action: args.action, parameter: 'messageRef', owner: 'message' }))
  }
  if (args.action === 'message') {
    if (args.messageRef === undefined) throw new Error(recoveryFor('missing_message_ref').sentence({ refused: 'for action message' }))
    if (args.beforeSequence !== undefined || args.limit !== undefined) throw new Error(recoveryFor('history_only_arguments').sentence({ action: 'message' }))
    const read = host.readMessageForAgent(agent, { workspaceId, projectRef, messageRef: args.messageRef as AgentTeamMessageRef })
    const value = { ...base, projectRef: read.projectRef, kind: 'message', message: { messageRef: read.messageRef, sender: read.sender, sequence: read.sequence,
      ...(read.occurredAt === undefined ? {} : { occurredAt: read.occurredAt }), body: read.body, bodyOmitted: false } }
    return budgetReading(agent, value, candidate => mainStreamLines(args.action, candidate).join('\n'), capacity).value
  }
  if (args.action === 'history') {
    const history = host.mainStreamHistoryForAgent(agent, { workspaceId, projectRef,
      ...(args.beforeSequence === undefined ? {} : { beforeSequence: args.beforeSequence }), ...(args.limit === undefined ? {} : { limit: args.limit }) })
    return { ...base, projectRef: history.projectRef, kind: 'history', entries: history.entries.map(mainEntryView), cursor: history.cursor,
      hasMore: history.hasMore, standing: standingView(history.standing) }
  }
  if (args.action !== 'read' && (args.beforeSequence !== undefined || args.limit !== undefined)) throw new Error(recoveryFor('history_only_arguments').sentence({ action: args.action }))
  const view = (read: Awaited<ReturnType<AgentTeam['readMainStreamForAgent']>>) => ({ ...base, projectRef: read.projectRef, kind: 'read',
    entries: read.entries.map(entry => ({ ...mainEntryView(entry),
      ...(entry.kind === 'message' && read.visibleMessageRefs.includes(entry.message.messageRef) ? { bodyOmitted: true } : {}),
      ...(entry.kind === 'activity' && read.visibleActivityRefs.includes(entry.activity.activityRef) ? { activityOmitted: true } : {}) })),
    readThroughSequence: read.readThroughSequence, remainingUnreadCount: read.standing.unreadCount, standing: standingView(read.standing) })
  let selected: ReturnType<typeof view> | undefined
  const read = await host.readMainStreamForAgent(agent, { requestId: readRequestId, workspaceId, projectRef }, preview => {
    const budget = budgetReading(agent, view(preview), candidate => mainStreamLines(args.action, candidate).join('\n'), capacity)
    selected = budget.value
    return preview.entries.some(entry => entry.unread) ? budget.through : preview.readThroughSequence
  })
  return selected === undefined ? budgetReading(agent, view(read), candidate => mainStreamLines(args.action, candidate).join('\n'), capacity).value
    : { ...selected, readThroughSequence: read.readThroughSequence, remainingUnreadCount: read.standing.unreadCount, standing: standingView(read.standing) }
}

/** What a Message answers, as one bracketed clause: resolved context when the reader's window reaches it, otherwise the bare ref, which the reader can hand to `team_thread message` for the original text. */
function repliesToClause(replyToMessageRef: string | undefined, replyTo: ReplyContextView | undefined): string {
  if (replyToMessageRef === undefined) return ''
  return replyTo === undefined
    ? ` (replies to ${replyToMessageRef})`
    : ` (replies to @${replyTo.sender} — "${replyTo.excerpt}")`
}

/** The one Host-read-fact → view projection, shared by a Thread read and by the facts a rejected write carries back, so the two surfaces cannot drift. */
function readFactView(entry: {
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

/** One rendered fact line; markers are inline, never a separate ellipsis line. */
function factLine(fact: FactView): string {
  const at = fact.occurredAt === undefined ? '' : ` ${formatTeamTimestamp(fact.occurredAt)}`
  return fact.kind === 'message'
    ? `${fact.sequence}${at} [${fact.sender ?? 'unknown sender'}]${factMarkers(fact)}${repliesToClause(fact.replyToMessageRef, fact.replyTo)} ${fact.bodyOmitted ? `${fact.messageRef} — body already in current context; omitted.` : fact.body}`
    : fact.activityOmitted === true
      ? `${fact.sequence}${at} Activity ${fact.activityRef}${factMarkers(fact)} — complete event already in current context; omitted.`
      : `${activityLine(fact)}${at}${factMarkers(fact)}`
}

/** One collision-surface Claim line, shared by read and history-free listing. */
function claimLine(claim: { claimRef: string; owner: string; direction: string }): string {
  return `${claim.claimRef} — ${claim.owner}: ${claim.direction}`
}

function threadResult(
  kind: 'read' | 'history' | 'message',
  workspaceId: string,
  snapshot: Awaited<ReturnType<AgentTeam['readThreadForAgent']>> | ReturnType<AgentTeam['threadHistoryForAgent']>,
  attention: Awaited<ReturnType<AgentTeam['readThreadForAgent']>>['attention'],
  facts: FactView[],
  extra: { cursor?: number; hasMore?: boolean; readThroughSequence?: number; remainingUnreadCount?: number; earlierFactCount?: number; taskNumber?: number; taskCards?: TaskCardView[]; reminders?: AgentTeamInboxReminder[]; message?: { messageRef: string; sender: string; sequence: number; occurredAt?: string; body: string; bodyOmitted?: boolean } } = {},
): { workspaceId: string; projectRef: string; anchor: { messageRef: string; sender: string; body: string; sequence: number; occurredAt?: string; replyToMessageRef?: string; replyTo?: ReplyContextView }; message?: { messageRef: string; sender: string; sequence: number; occurredAt?: string; body: string; bodyOmitted?: boolean }; threadRef: string; revision: number; kind: string; following: boolean; taskRef?: string; status?: string; resolution?: string; taskNumber?: number; accountable?: string; readThroughSequence?: number; remainingUnreadCount?: number; earlierFactCount?: number; cursor?: number; hasMore?: boolean; taskCards?: TaskCardView[]; reminders?: AgentTeamInboxReminder[]; claims: ClaimView[]; facts: FactView[] } {
  return {
    workspaceId, projectRef: snapshot.anchor.projectRef,
    kind, threadRef: snapshot.thread.threadRef, revision: snapshot.thread.revision,
    ...(snapshot.task === undefined ? {} : { taskRef: snapshot.task.taskRef, status: snapshot.task.status, resolution: snapshot.task.resolution, accountable: snapshot.task.accountable }),
    ...(extra.taskNumber === undefined ? {} : { taskNumber: extra.taskNumber }),
    following: attention !== undefined,
    ...extra,
    ...(attention === undefined || extra.readThroughSequence !== undefined ? {} : { readThroughSequence: attention.readThroughSequence }),
    anchor: { messageRef: snapshot.anchor.messageRef, sender: snapshot.anchor.sender, body: snapshot.anchor.body, sequence: snapshot.anchor.sequence, occurredAt: snapshot.anchor.occurredAt, ...(snapshot.anchor.replyToMessageRef === undefined ? {} : { replyToMessageRef: snapshot.anchor.replyToMessageRef }), ...(snapshot.anchor.replyTo === undefined ? {} : { replyTo: snapshot.anchor.replyTo }) },
    claims: snapshot.claims.map(claimView),
    facts,
  }
}

/** A direct message is not a Thread fact: `dm` takes a Member ref and a body only (no Thread, Task, write token, or attachments). Sharing a pocket with `reply` would let a model hand a `threadRef` to a call with no Thread to address. A DM is a private note; shared work belongs in a Thread reply. */
const teamDm = defineTool({
  name: 'team_dm',
  description: 'Send one private direct message to a single enabled Agent Member in your Workspace. It takes a memberRef and a body and nothing else: no Thread, no Task, no write token, and no attachments, because a DM addresses a person rather than a conversation. Use it for quick clarifications and status syncs — never for task work, decisions, or anything that needs team visibility or traceability, which belongs in a Thread reply. If an exchange with the same Member runs past about three messages, move it to a Thread: every DM costs the recipient a full agent turn. A DM is recorded whether or not the recipient session could be woken, and the result says which happened; there is no automatic redelivery, so never blindly send a duplicate. The Human cannot be DMed.',
  parameters: {
    memberRef: { type: 'string', required: true, description: "Full branded Member ref exactly as returned by Team tools, including the 'member:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves. The Member must be an enabled Agent in your Workspace (the Human cannot be DMed)." },
    body: { type: 'string', required: true, description: "Markdown body. Lead with the conclusion or state; keep it the shortest useful message for the recipient. Only the named Member receives it: @mentions in the text do not notify the Human or anyone else. Use team_message when a decision or shared work needs their attention." },
    workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true },
      recipientMemberId: { type: 'string', required: true }, recipientHandle: { type: 'string', required: true },
      delivered: { type: 'boolean', required: true }, deliveryNote: { type: 'string' }, occurredAt: { type: 'string' },
    } },
        // Renders are the only channel a tool result reaches the model through. A DM is recorded either way, so the first line says whether it was delivered or recorded without a live session to wake.
    render: (_args, value) => {
      if (value.delivered === false) return [{ type: 'text', text: [
        `Recorded, not delivered — DM to @${value.recipientHandle} (${value.recipientMemberId}).`,
        'No automatic redelivery will occur; do not blindly send a duplicate.',
        `Reason: ${value.deliveryNote ?? 'the recipient session could not be woken'}`,
      ].join('\n') }]
      return [{ type: 'text', text: `Delivered — DM to @${value.recipientHandle} (${value.recipientMemberId})${value.occurredAt === undefined ? '' : ` at ${formatTeamTimestamp(value.occurredAt)}`}.` }]
    },
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, OPTIONAL_ADDRESS_KEYS)
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_dm requires an Agent session')
        // A stray field is refused rather than ignored: a model reaching for a Thread write's shape meant a Thread reply, and dropping the field would send a private note where shared work was intended. Hand-written because the harness compiles parameter tables to `{type, properties, required}` with no `additionalProperties`, so no schema can refuse an unnamed key. Not redundant.
    const stray = Object.keys(args).filter(key => key !== 'memberRef' && key !== 'body' && key !== 'workspace')
    if (stray.length > 0) throw new Error(`team_dm does not accept ${stray.join(', ')}; it takes memberRef and body only — a DM addresses a person, so shared work belongs in a team_message reply.`)
    if (args.memberRef === undefined) throw new Error(recoveryFor('dm_requires_member').sentence({}))
    if (typeof args.body !== 'string' || args.body.trim() === '') throw new Error(`team_dm needs the message text in its body parameter — a blank or missing body is usually the text landing in the reply channel instead. Put the full message in body and resend.`)
    try {
      const result = await service(agent).dmForAgent(agent, { requestId: requestId(agent.id, exec.callId), workspaceId: workspaceOf(args, agent),
        recipientMemberId: args.memberRef as AgentTeamMemberId, body: args.body })
      return { kind: 'dm-sent', recipientMemberId: result.recipient.memberId, recipientHandle: result.recipient.handle, delivered: true, occurredAt: result.receipt.occurredAt }
    } catch (error) {
      if (error instanceof AgentTeamDmDeliveryError) {
        return { kind: 'dm-sent', recipientMemberId: error.recipientMemberId, recipientHandle: error.recipientHandle, delivered: false, deliveryNote: error.message }
      }
      throw error
    }
  },
})

const teamMessage = markAgentTeamPreset(defineTool({
  name: 'team_message',
  description: 'Post to a Project\'s Main stream, start a Thread, or reply to one. post speaks in the Project\'s Main stream — the conversation outside every Thread — and any enabled Member who participates in the Project\'s Workspace may: pass projectRef and body, mention with `@Handle`, and optionally replyToMessageRef (a Main stream Message of the same Project, whose author is delivered to). Pending Main stream entries must be complete in the current context; use team_thread read with projectRef for missing facts and acknowledgement. post has no write token. start opens a discussion or a Task (kind) and only a Project owner may — a Thread starts from a standing question or piece of work, not from conversation. Understand the Thread before replying; a write needs a current token from a drained read, your own commit, or a complete rejection that provides one. Complete Message and Activity facts in context can satisfy reading, but never acknowledge unread; every write rechecks new facts, revision, permissions and Task state. A mention supplies its Message, not earlier discussion; read missing background first. start takes kind discussion (default) or task. A mention in a start or a reply delivers its Message to that Member once and never makes them follow; `@all` is plain text under version 2 and reaches no one. A private note to one Member is team_dm, not a reply.',
  parameters: {
    action: { type: 'string', required: true, enum: ['start', 'reply', 'post'] },
    projectRef: { type: 'string', description: "Full branded Project ref exactly as returned by Team tools, including the 'project:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves. Required by start and post." },
    kind: { type: 'string', enum: ['discussion', 'task'], description: 'start only: discussion (default) opens a Thread to talk something through; task opens a Thread that carries a Task.' },
    accountable: { type: 'string', description: "start with kind task only: who becomes accountable for the new Task — a current Project owner's memberRef or @Handle, or 'human'. Omit it and the Agent owner who starts the Task is accountable, or the Human when the Human starts it. It does not change who may start a Task." },
    sourceThreadRefs: { type: 'array', items: { type: 'string' }, description: 'start with kind task only: the discussion Threads this Task derives from, as full branded threadRefs of the same Project. Each becomes a source of the new Task, which the card renders there instead of in the Main stream; a Task may name several. Task Threads and other Projects are refused, and a source is fixed at creation — promoting a discussion in place records no source.' },
    threadRef: { type: 'string', description: "Full branded Thread ref exactly as returned by Team tools, including the 'thread:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    taskRef: { type: 'string', description: "Optional Task ref alias for reply on a Taskful Thread. Prefer threadRef; an unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    replyToMessageRef: { type: 'string', description: "Optional: the full branded Message ref you are answering (for post: a Main stream Message of the same Project) (as rendered by team_thread or an inbox notice). Reply on the Thread you are already replying to; the Message must be one this Thread recorded. The Host links the reply to it, and its author is then delivered to like a mention, so answering a peer reaches them without typing their handle. Use it when the link is the point — the reader needs to know which Message you are answering. A Message that only continues the Thread's conversation needs neither this nor a mention: the Thread already delivers to the Members on it, so the link would announce a delivery that was going to happen anyway." },
    body: { type: 'string', required: true, description: "Markdown body. Lead with the conclusion or state; keep it the shortest useful message for the recipients. Cite Team refs exactly as returned, as bare text with one colon (e.g. task:0f0a…) — never a double colon, never inside backticks or quotes. Unambiguous UUID abbreviations (first 6+ hex chars) also resolve. Mention a Member by writing `@Handle` (`@` required, case-insensitive) in the prose: that is what delivers the Message to them and renders the mention chip; `@all` is plain text under version 2 and delivers to no one — name each Member instead." }, baseRevision: { type: 'number', description: "The next-write token from a fully drained team_thread read, your own last committed mutation, or a complete rejection that explicitly provides one on this Thread. Copy the explicitly rendered value verbatim; never increment, derive, compare, or cite it — it is an opaque concurrency token, not a fact about the Thread." },
    attachments: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to share, e.g. screenshots or generated artifacts; images render as thumbnails for recipients. The Host validates each path and copies the file into the attachment cache, and members also receive one cached path per attachment; if any path fails validation the whole send is rejected.' },
    workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true }, action: { type: 'string' }, taskRef: { type: 'string' }, threadRef: { type: 'string' }, revision: { type: 'number' }, accountable: { type: 'string' }, sourceThreadRefs: { type: 'array', items: { type: 'string' } },
      expectedRevision: { type: 'number' }, messageRef: { type: 'string' }, memberIds: { type: 'array', items: { type: 'string' } }, unreadCount: { type: 'number' }, directCount: { type: 'number' },
      following: { type: 'boolean' },
      projectRef: { type: 'string' }, entries: { type: 'array', items: MAIN_ENTRY_SCHEMA },
      facts: { type: 'array', items: FACT_SCHEMA },
      occurredAt: { type: 'string' }, staleTokenKind: { type: 'string', enum: ['unknown', 'unrecognized'] },
      source: { type: 'string' },
    } },
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
        // Minimal durable projection for the Host's context timeline: the structured outcome identity, never render text. The effect-anchor fold reads `kind === 'committed'` + threadRef from the persisted tool/result meta; a start's Thread is born in the result.
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
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, [...OPTIONAL_ADDRESS_KEYS, ...OPTIONAL_COLLECTION_KEYS])
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_message requires an Agent session')
    const host = service(agent)
    const rawPaths = args.attachments
    const attachmentPaths = Array.isArray(rawPaths) ? rawPaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : undefined
    const paths = attachmentPaths !== undefined && attachmentPaths.length > 0 ? { attachmentPaths } : {}
    if (typeof args.body !== 'string' || args.body.trim() === '') throw new Error(`team_message needs the message text in its body parameter — a blank or missing body is usually the text landing in the reply channel instead. Put the full message in body and resend.`)
    if (args.action === 'post') {
      // `post` is a plain Main stream message, so `kind`, `sourceThreadRefs`, and `accountable` belong to `start` alone. A model that fills every optional slot declares `kind: 'discussion'` on a post that is a discussion by definition; dropping those here, rather than refusing, is what keeps a post from costing a retry — the same reason a read ignores its page size.
      if (args.projectRef === undefined || args.taskRef !== undefined || args.threadRef !== undefined || args.baseRevision !== undefined) throw new Error(`post requires projectRef and does not accept threadRef, taskRef, or baseRevision — ${recoveryFor('post_requires_project').sentence({})}`)
      if (args.accountable !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'post', parameter: 'accountable', owner: 'start' }))
      // An empty `sourceThreadRefs` names no source, exactly as `attachments: []` names no file: the parameter carries nothing to honor, so it is not a mis-sent `start` argument.
      if (args.sourceThreadRefs !== undefined && args.sourceThreadRefs.length > 0) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'post', parameter: 'sourceThreadRefs', owner: 'start' }))
      const result = await host.postMainMessageForAgent(agent, { requestId: requestId(agent.id, exec.callId), workspaceId: workspaceOf(args, agent),
        projectRef: projectRefOf(args.projectRef) as never,
        ...(args.replyToMessageRef === undefined ? {} : { replyToMessageRef: args.replyToMessageRef as AgentTeamMessageRef }), body: args.body, ...paths })
      if (result.kind === 'committed') {
        const attention = host.mainAttentionStatusForAgent(agent, { workspaceId: workspaceOf(args, agent), projectRef: result.message.projectRef })
        return { kind: result.kind, action: 'post', projectRef: result.message.projectRef, messageRef: result.message.messageRef, occurredAt: result.receipt.occurredAt,
          following: attention.attention !== undefined }
      }
      return { kind: result.kind, projectRef: result.projectRef, unreadCount: result.unreadCount, directCount: result.directCount, entries: result.entries.map(mainEntryView) }
    }
    if (args.action === 'start') {
      if (args.projectRef === undefined || args.taskRef !== undefined || args.threadRef !== undefined || args.baseRevision !== undefined) throw new Error(`start requires projectRef and does not accept threadRef, taskRef, or baseRevision — ${recoveryFor('start_requires_project').sentence({})}`)
      // The schema is implicitly open, so the removed `asTask` alias would otherwise be dropped silently and the
      // start would commit as a discussion — the model must learn it was not heard.
      if ((args as { readonly asTask?: unknown }).asTask !== undefined) throw new Error(`start does not accept asTask — pass kind: 'task' instead — ${recoveryFor('action_only_arguments').sentence({ action: 'start', parameter: 'asTask', owner: 'start' })}`)
      const kind = args.kind === 'task' ? 'task' : 'discussion'
      if (kind === 'discussion' && args.accountable !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'start (discussion)', parameter: 'accountable', owner: 'start' }))
      if (kind === 'discussion' && args.sourceThreadRefs !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'start (discussion)', parameter: 'sourceThreadRefs', owner: 'start' }))
      const request = { requestId: requestId(agent.id, exec.callId), workspaceId: workspaceOf(args, agent), projectRef: projectRefOf(args.projectRef) as never, body: args.body, ...paths }
      const result = await host.startThreadForAgent(agent, { ...request, kind,
        ...(args.accountable === undefined ? {} : { accountable: memberTarget(host, args.accountable) }),
        ...(args.sourceThreadRefs === undefined ? {} : { sourceThreadRefs: args.sourceThreadRefs.map(ref => ref as AgentTeamThreadRef) }) })
      return messageOutcome(result, 'start')
    }
    const baseRevision = args.baseRevision
    if (args.projectRef !== undefined) throw new Error(`reply does not take projectRef — ${recoveryFor('main_stream_addressing').sentence({ refused: 'projectRef on reply' })}`)
    if (args.threadRef === undefined && args.taskRef === undefined) throw new Error(`reply needs threadRef or taskRef — ${recoveryFor('missing_thread_identity').sentence({})}`)
    if (typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      throw new Error(`reply requires a positive baseRevision — ${recoveryFor('missing_write_token').sentence({})}`)
    }
    // `kind` belongs to `start`; a model filling every optional slot sends the
    // start default `kind: 'discussion'` on a reply. That value changes nothing
    // about the reply, so it must not be reported as a missing token; a genuine
    // `task` kind still gets named.
    if (args.kind !== undefined && args.kind !== 'discussion') throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'reply', parameter: 'kind', owner: 'start' }))
    if (args.accountable !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'reply', parameter: 'accountable', owner: 'start' }))
    if (args.sourceThreadRefs !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'reply', parameter: 'sourceThreadRefs', owner: 'start' }))
    const result = await host.replyForAgent(agent, { requestId: requestId(agent.id, exec.callId), workspaceId: workspaceOf(args, agent),
      ...(args.threadRef === undefined ? {} : { threadRef: args.threadRef as AgentTeamThreadRef }),
      ...(args.taskRef === undefined ? {} : { taskRef: args.taskRef as AgentTeamTaskRef }),
      ...(args.replyToMessageRef === undefined ? {} : { replyToMessageRef: args.replyToMessageRef as AgentTeamMessageRef }),
      body: args.body, baseRevision, ...paths })
    const outcome = messageOutcome(result, 'reply')
    if (result.kind === 'committed') {
      const status = host.attentionStatusForAgent(agent, { workspaceId: workspaceOf(args, agent), threadRef: result.thread.threadRef })
      return { ...outcome, following: status.attention !== undefined }
    }
    return outcome
  },
}))

function messageOutcome(result: Awaited<ReturnType<AgentTeam['startThreadForAgent']>> | Awaited<ReturnType<AgentTeam['replyForAgent']>>, action: 'start' | 'reply') {
  if (result.kind === 'committed') {
    // Starting a Thread follows its author, so the start result names the
    // Attention the writer just acquired. A reply never starts one.
    const own = action === 'start' ? result.attention.find(attention => attention.memberId === result.message.sender) : undefined
    return { kind: result.kind, action, threadRef: result.thread.threadRef,
      ...(result.task === undefined ? {} : { taskRef: result.task.taskRef, accountable: result.task.accountable }),
      ...(result.task === undefined || result.task.sourceThreadRefs.length === 0 ? {} : { sourceThreadRefs: [...result.task.sourceThreadRefs] }),
      revision: result.thread.revision, messageRef: result.message.messageRef, occurredAt: result.receipt.occurredAt,
      ...(own === undefined ? {} : { source: own.source }) }
  }
  if (result.kind === 'unread_required') return { kind: result.kind, ...(result.taskRef === undefined ? {} : { taskRef: result.taskRef }), threadRef: result.threadRef,
    revision: result.revision, unreadCount: result.unreadCount, directCount: result.directCount,
    ...(result.facts === undefined ? {} : { facts: result.facts.map(entry => readFactView(entry)) }) }
  if (result.kind === 'stale_revision') return { kind: result.kind, ...(result.taskRef === undefined ? {} : { taskRef: result.taskRef }), threadRef: result.threadRef,
    expectedRevision: result.expectedRevision, revision: result.revision,
    ...(result.staleTokenKind === undefined ? {} : { staleTokenKind: result.staleTokenKind }),
    ...(result.facts === undefined ? {} : { facts: result.facts.map(entry => readFactView(entry)) }) }
  throw new Error(`Agents cannot receive a ${result.kind} message outcome`)
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

function boardItemView(item: AgentTeamTaskBoardItem): BoardItemView {
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

/** Who a Task refusal should name: the Human by their role, an Agent by its stable ref, so the reader can address a transfer. */
function accountableLabel(host: AgentTeam, memberId: string): string {
  if (memberId === AGENT_TEAM_HUMAN_MEMBER_ID) return 'the Human'
  const handle = host.members().find(status => status.member.memberId === memberId)?.member.handle
  return handle === undefined ? memberId : `@${handle} (${memberId})`
}

/**
 * The ledger names the refusal and its way out, but it cannot say what the Task looks like now: only the caller can read the projection after the refusal. So a Task-authority refusal gains one sentence naming the current state and who holds responsibility.
 */
function withTaskAuthorityHint(error: unknown, host: AgentTeam, agent: Parameters<typeof service>[0], base: { readonly workspaceId: Parameters<AgentTeam['listClaimsForAgent']>[1]['workspaceId']; readonly taskRef: AgentTeamTaskRef }): unknown {
  const message = error instanceof Error ? error.message : String(error)
  if (!/\((?:self_acceptance_forbidden|accountable_owner_required)\)/u.test(message)) return error
  let listed: ReturnType<AgentTeam['listClaimsForAgent']>
  try {
    listed = host.listClaimsForAgent(agent, base)
  } catch {
    return error
  }
  return new Error(`${message} Currently ${base.taskRef} is ${listed.task.status}${listed.task.resolution === 'open' ? '' : ` (${listed.task.resolution})`}, accountable to ${accountableLabel(host, listed.task.accountable)}.`)
}

const teamTask = defineTool({
  name: 'team_task',
  description: 'Work with Tasks. board lists the Task board of the Projects you can see — every open Task with its status, who is accountable for it, and the Members on it, plus each Project\'s newest finished Tasks — filtered by projectRef or to your own responsibility with mine; it is current state, not unread, so check it before you claim or when a Workspace change surprises you. promote turns a discussion Thread into a Task (Project owners only) and takes accountable to name the owner responsible for it; a Task started with team_message start takes the same field. list, claim, done and release manage your Direction Claims. Every Task has one accountable: the Human or an Agent Member. accept finishes a Task as verified work; close ends it without acceptance; reopen returns it to open work; transfer hands accountability to another enabled Member of this Workspace or back to the Human, and the new accountable starts following the Thread. Who may do which is the Host\'s call, not yours to reason around: accept belongs to the Human, to a Project owner, or to the Task\'s own accountable, and never to a Member that held any Claim on it (an Agent may accept only an in_review Task); close, reopen and transfer belong to the Human or the current accountable. Finishing your own Claim is not acceptance, and an Agent that executed a Task cannot verify it. transfer moves responsibility only — Claims and their owners stay where they are. Mutations need a current token from a drained read, your own commit, or a complete rejection that provides one. Reconsider the facts first; each attempt rechecks them and Task permissions. list only refreshes active Claims.',
  parameters: {
    action: { type: 'string', required: true, enum: ['board', 'list', 'claim', 'done', 'release', 'promote', 'accept', 'close', 'reopen', 'transfer'] },
    projectRef: { type: 'string', description: 'board only: limit the board to one Project.' },
    mine: { type: 'boolean', description: 'board only: only Tasks you are accountable for or hold a live Claim on.' },
    threadRef: { type: 'string', description: 'promote only: the discussion Thread to turn into a Task.' },
    taskRef: { type: 'string', description: "Full branded Task ref exactly as returned by Team tools, including the 'task:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    baseRevision: { type: 'number', description: "The next-write token from a fully drained team_thread read, your own last committed mutation, or a complete rejection that explicitly provides one on this Task's Thread. Copy the explicitly rendered value verbatim; never increment, derive, compare, or cite it — it is an opaque concurrency token, not a fact about the Task." },
    direction: { type: 'string', description: 'claim only: your one-sentence direction statement on the Task — the angle you are taking, so others can spot collisions and track progress. Put multi-paragraph plans, step order, file lists, and acceptance criteria in Thread messages, not the Claim.' },
    claimRef: { type: 'string', description: "Full branded Claim ref exactly as returned by team_task, including the 'claim:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    accountable: { type: 'string', description: "promote only: the Member who becomes accountable for the new Task — a current Project owner's memberRef or @Handle, or 'human'. Omit it and the promoting owner is accountable, or the Human when the Human promotes." },
    target: { type: 'string', description: "transfer only: the Member who becomes accountable — any enabled member of this Task's Project, as a memberRef, @Handle, or a unique 6+ hex prefix, or 'human' to return responsibility to the Human. Following the Thread is not required." },
    workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
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
    } },
        // A committed mutation renders the authoritative affected Claim first; the full archive is never appended. list renders the collision surface and no write token (a current Thread read remains the mutation basis). Rejections share the outcome-first recovery form and carry the gating facts plus the current revision as the next write token.
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
  },
  async execute(rawArgs, exec) {
    // `direction` is meaningful only for `claim`; a model that fills every slot
    // sends `direction: ""` on board/list/resolution actions too. Treat that empty
    // slot as absent here, while the claim guard still refuses a genuinely missing
    // direction with its own route.
    const args = blankToAbsent(rawArgs, [...OPTIONAL_ADDRESS_KEYS, 'direction'])
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_task requires an Agent session')
    const host = service(agent)
    if (args.action === 'board') {
      if (args.taskRef !== undefined || args.threadRef !== undefined || args.baseRevision !== undefined || args.direction !== undefined || args.claimRef !== undefined) throw new Error(recoveryFor('board_takes_no_task').sentence({}))
      if (args.accountable !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'board', parameter: 'accountable', owner: 'promote' }))
      if (args.target !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'board', parameter: 'target', owner: 'transfer' }))
      const board = host.taskBoardForAgent(agent, { ...(args.workspace === undefined ? {} : { workspaceId: workspaceOf(args, agent) }),
        ...(args.projectRef === undefined ? {} : { projectRef: projectRefOf(args.projectRef) as AgentTeamProjectRef }), ...(args.mine === true ? { mine: true } : {}) })
      return { kind: 'board', open: board.open.map(boardItemView), finished: board.finished.map(boardItemView), finishedTruncated: board.finishedTruncated }
    }
    if (args.action === 'promote') {
      if (args.taskRef !== undefined || args.direction !== undefined || args.claimRef !== undefined) throw new Error(recoveryFor('promote_takes_thread').sentence({}))
      if (args.target !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'promote', parameter: 'target', owner: 'transfer' }))
      if (args.threadRef === undefined) throw new Error(recoveryFor('promote_requires_thread').sentence({}))
      const baseRevision = args.baseRevision
      if (typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 1) throw new Error(recoveryFor('missing_write_token').sentence({}))
      const result = await host.promoteThreadForAgent(agent, { requestId: requestId(agent.id, exec.callId), workspaceId: workspaceOf(args, agent),
        threadRef: args.threadRef as AgentTeamThreadRef, baseRevision,
        ...(args.accountable === undefined ? {} : { accountable: memberTarget(host, args.accountable) }) })
      if (result.kind === 'committed') return { kind: result.kind, action: 'promote', taskRef: result.task.taskRef, threadRef: result.thread.threadRef,
        revision: result.thread.revision, status: result.task.status, accountable: result.task.accountable, occurredAt: result.receipt.occurredAt }
      if (result.kind === 'unread_required') return { kind: result.kind, threadRef: result.threadRef, revision: result.revision,
        unreadCount: result.unreadCount, directCount: result.directCount, ...(result.facts === undefined ? {} : { facts: result.facts.map(entry => readFactView(entry)) }) }
      return { kind: result.kind, threadRef: result.threadRef, expectedRevision: result.expectedRevision, revision: result.revision,
        ...(result.staleTokenKind === undefined ? {} : { staleTokenKind: result.staleTokenKind }),
        ...(result.facts === undefined ? {} : { facts: result.facts.map(entry => readFactView(entry)) }) }
    }
    if (args.taskRef === undefined) throw new Error(recoveryFor('task_action_requires_task').sentence({ action: args.action }))
    const base = { workspaceId: workspaceOf(args, agent), taskRef: args.taskRef as AgentTeamTaskRef }
    if (args.action === 'list') {
      if (args.baseRevision !== undefined || args.direction !== undefined || args.claimRef !== undefined || args.threadRef !== undefined) throw new Error(recoveryFor('list_takes_task_only').sentence({}))
      if (args.accountable !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'list', parameter: 'accountable', owner: 'promote' }))
      if (args.target !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'list', parameter: 'target', owner: 'transfer' }))
      const listed = host.listClaimsForAgent(agent, base)
      return { kind: 'listed', taskRef: listed.task.taskRef, threadRef: listed.thread.threadRef, revision: listed.thread.revision, status: listed.task.status,
        accountable: listed.task.accountable, claims: listed.claims.map(claimView) }
    }
    if (args.threadRef !== undefined || args.projectRef !== undefined) throw new Error(recoveryFor('task_action_requires_task').sentence({ action: args.action }))
    if (args.accountable !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: args.action, parameter: 'accountable', owner: 'promote' }))
    if (args.target !== undefined && args.action !== 'transfer') throw new Error(recoveryFor('action_only_arguments').sentence({ action: args.action, parameter: 'target', owner: 'transfer' }))
    const baseRevision = args.baseRevision
    if (typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 1) throw new Error(recoveryFor('missing_write_token').sentence({}))
    if (args.action === 'transfer') {
      if (args.direction !== undefined || args.claimRef !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'transfer', parameter: args.direction === undefined ? 'claimRef' : 'direction', owner: args.direction === undefined ? 'done' : 'claim' }))
      if (args.target === undefined || args.target.trim() === '') throw new Error('transfer needs target — the enabled Member of this Workspace who becomes accountable for this Task, or human.')
      const target = memberTarget(host, args.target)
      let transferred: Awaited<ReturnType<AgentTeam['transferTaskForAgent']>>
      try {
        transferred = await host.transferTaskForAgent(agent, { requestId: requestId(agent.id, exec.callId), ...base, target, baseRevision })
      } catch (error) {
        throw withTaskAuthorityHint(error, host, agent, base)
      }
      const listed = host.listClaimsForAgent(agent, base)
      if (transferred.kind === 'committed') return { kind: transferred.kind, action: 'transfer', taskRef: transferred.task.taskRef,
        threadRef: transferred.thread.threadRef, revision: transferred.thread.revision, status: transferred.task.status,
        resolution: transferred.task.resolution, accountable: transferred.task.accountable,
        ...(transferred.activity.from === undefined ? {} : { from: transferred.activity.from }),
        ...(transferred.activity.to === undefined ? {} : { to: transferred.activity.to }), occurredAt: transferred.receipt.occurredAt }
      return taskRejection(transferred, listed)
    }
    if (args.action === 'accept' || args.action === 'close' || args.action === 'reopen') {
      if (args.direction !== undefined || args.claimRef !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: args.action, parameter: args.direction === undefined ? 'claimRef' : 'direction', owner: args.direction === undefined ? 'done' : 'claim' }))
      let resolved: Awaited<ReturnType<AgentTeam['changeTaskForAgent']>>
      try {
        resolved = await host.changeTaskForAgent(agent, { requestId: requestId(agent.id, exec.callId), ...base, action: args.action, baseRevision })
      } catch (error) {
        throw withTaskAuthorityHint(error, host, agent, base)
      }
      const listed = host.listClaimsForAgent(agent, base)
      if (resolved.kind === 'committed') return { kind: resolved.kind, action: args.action, taskRef: resolved.task.taskRef,
        threadRef: resolved.thread.threadRef, revision: resolved.thread.revision, status: resolved.task.status,
        resolution: resolved.task.resolution, accountable: resolved.task.accountable,
        ...(resolved.activity.acceptedClaimRefs === undefined ? {} : { acceptedClaimRefs: [...resolved.activity.acceptedClaimRefs] }),
        ...(resolved.activity.releasedClaimRefs === undefined ? {} : { releasedClaimRefs: [...resolved.activity.releasedClaimRefs] }),
        occurredAt: resolved.receipt.occurredAt }
      return taskRejection(resolved, listed)
    }
    if (args.action === 'claim' && (args.direction === undefined || args.claimRef !== undefined)) throw new Error(recoveryFor('claim_requires_direction').sentence({}))
    if ((args.action === 'done' || args.action === 'release') && (args.claimRef === undefined || args.direction !== undefined)) throw new Error(recoveryFor('claim_close_requires_ref').sentence({ action: args.action }))
    const result = await host.changeClaimForAgent(agent, { requestId: requestId(agent.id, exec.callId), ...base, action: args.action,
      baseRevision, ...(args.direction === undefined ? {} : { direction: args.direction }), ...(args.claimRef === undefined ? {} : { claimRef: args.claimRef as AgentTeamClaimRef }) })
        // Every mutation outcome re-reads the real Claim archive and Task status; the render layer omits the archive, never the structured value.
    const listed = host.listClaimsForAgent(agent, base)
    const claims = listed.claims.map(claimView)
    if (result.kind === 'committed') return { kind: result.kind, action: args.action, taskRef: result.task.taskRef, threadRef: result.thread.threadRef,
      revision: result.thread.revision, status: result.task.status, accountable: result.task.accountable, claim: claimView(result.claim), claims,
      // Present when the Claim started the executor's own Attention, which is the
      // one cause this result can state without asking the projection again.
      ...(result.attention === undefined ? {} : { source: result.attention.source }),
      occurredAt: result.receipt.occurredAt }
    return taskRejection(result, listed)
  },
})

/** The two typed Task rejections, in the shared outcome-first form: gating facts, the affected Task's standing, and the current revision as the next write token. */
function taskRejection(
  result: { readonly kind: 'unread_required' | 'stale_revision'; readonly threadRef: AgentTeamThreadRef; readonly revision: number
    readonly unreadCount?: number; readonly directCount?: number; readonly expectedRevision?: number
    readonly staleTokenKind?: 'unknown' | 'unrecognized'
    readonly facts?: readonly { readonly fact: AgentTeamThreadFact; readonly unread: boolean; readonly direct: boolean }[] },
  listed: ReturnType<AgentTeam['listClaimsForAgent']>,
) {
  const claims = listed.claims.map(claimView)
  const facts = result.facts === undefined ? {} : { facts: result.facts.map(entry => readFactView(entry)) }
  if (result.kind === 'unread_required') return { kind: result.kind, taskRef: listed.task.taskRef, threadRef: result.threadRef,
    revision: result.revision, status: listed.task.status, accountable: listed.task.accountable,
    unreadCount: result.unreadCount ?? 0, directCount: result.directCount ?? 0, claims, ...facts }
  return { kind: result.kind, taskRef: listed.task.taskRef, threadRef: result.threadRef,
    ...(result.expectedRevision === undefined ? {} : { expectedRevision: result.expectedRevision }),
    revision: result.revision, status: listed.task.status, accountable: listed.task.accountable, claims,
    ...(result.staleTokenKind === undefined ? {} : { staleTokenKind: result.staleTokenKind }), ...facts }
}

const teamView = defineTool({
  name: 'team_view',
  description: 'Discover your authorized Team addresses: every active Project in the Workspace (with owners, your owner/following/none relation, and subscription counts), a newest-first page of top-level Threads in the Workspace (each with its bounded anchor subject; Task standing inline on taskful rows), and current Workspace Members. This is an address book, not a work queue: unread work lives in team_inbox, work in flight on team_task board, and a Thread is read with team_thread read. The cursor pages Thread rows only.',
  parameters: {
    projectRef: { type: 'string', description: "Full branded Project ref exactly as returned by Team tools, including the 'project:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    limit: { type: 'number' }, cursor: { type: 'number' }, workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      projects: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        projectRef: { type: 'string', required: true }, name: { type: 'string', required: true },
        // Present only once the ledger has Project owners (rules version 2).
        owners: { type: 'array', items: { type: 'string' } },
        // What each Agent owner answers for here; `unspecified` is a neutral
        // statement about the grant, not a fault to report.
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
    } },
        // Address book, newest Thread first: labelled sections, one bounded subject per Thread row, Task standing inline (no second Task index), and a footer naming the value a Thread cursor. Continuation pages repeat only Threads. No message count or revision label: neither changes the next legal action, which is reading, never writing from a directory snapshot.
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
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, OPTIONAL_ADDRESS_KEYS)
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_view requires an Agent session')
    const host = service(agent)
    const workspaceId = workspaceOf(args, agent)
        // `includeCatalog` makes this the address book: the radar and Task/Thread catalog of the whole Workspace scope, not just this page's Threads. Other `view` callers keep the bounded page projection.
    const view = host.viewForAgent(agent, { workspaceId, ...(args.projectRef === undefined ? {} : { projectRef: projectRefOf(args.projectRef) as never }), ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.cursor === undefined ? {} : { cursor: args.cursor }), topLevelOnly: true, includeActivities: false, direction: 'before', includeCatalog: true })
    if (view.directory === undefined) throw new Error('team_view requires the Workspace directory projection')
    const visibleMemberIds = new Set(view.directory.memberIds)
    const self = host.memberForAgent(agent)
    const handles = new Map(host.members().map(status => [status.member.memberId, status.member.handle]))
    const ownership = view.rulesVersion >= 2
    return {
      workspaceId,
      workspaces: view.workspaces.map(participation => ({ workspaceId: participation.workspaceId,
        ...(participation.title === undefined ? {} : { title: participation.title }), default: participation.default })),
      projects: view.directory.projects.map(entry => {
        const { project, ownerIds, participating, followingMain, subscriptions } = entry
        if (!ownership) return { projectRef: project.projectRef, name: project.name, subscriptions,
          role: participating ? 'member' : 'directory only' }
        const projectOwners = view.owners.filter(owner => owner.projectRef === project.projectRef)
        // Rules version 9 keeps only what an owner owns and what a follower
        // follows: the role is the grant, the Main stream Attention, or none.
        const role = view.rulesVersion >= 9
          ? (self !== undefined && ownerIds.includes(self.memberId) ? 'owner' : followingMain === true ? 'following' : 'none')
          : participating ? (self !== undefined && ownerIds.includes(self.memberId) ? 'owner' : 'member') : 'directory only'
        return { projectRef: project.projectRef, name: project.name, subscriptions,
          owners: [host.humanHandle(), ...ownerIds.map(memberId => handles.get(memberId) ?? memberId)],
          // Only when at least one owner recorded text: a Project whose every grant
          // is unspecified adds no field and no token, and a pre-version-8 ledger
          // answers exactly as it did before the field existed. Once it appears, an
          // owner without text reads `unspecified` rather than being left out.
          ...(projectOwners.every(owner => owner.responsibility === undefined) ? {} : { ownerResponsibilities: projectOwners
            .map(owner => ({ handle: handles.get(owner.memberId) ?? owner.memberId, responsibility: owner.responsibility ?? 'unspecified' })) }),
          role }
      }),
      members: [
        { memberId: view.humanMemberId, kind: 'human', handle: host.humanHandle(), description: 'Human Team Member', presence: 'available' },
        ...host.members().filter(status => visibleMemberIds.has(status.member.memberId)).map(status => ({ memberId: status.member.memberId,
          kind: 'agent', handle: status.member.handle, description: status.member.description, presence: status.presence })),
      ],
      threads: view.items.map(item => {
        const thread = item.thread
        const task = item.task
        return { threadRef: thread.threadRef, projectRef: item.message.projectRef, revision: thread.revision, messageCount: item.messageCount,
          subject: boundedSubject(item.message.body), lastActivityAt: item.lastActivityAt,
          ...(task === undefined ? {} : { taskRef: task.taskRef, status: task.status, accountable: task.accountable, ...(item.taskNumber === undefined ? {} : { taskNumber: item.taskNumber }) }) }
      }),
            // A Task's revision is its Thread's; omitted rather than reported as `0` when the Thread is outside this page's scope, since `0` would read as "never written".
      tasks: view.tasks.map(task => {
        const revision = view.threads.find(thread => thread.threadRef === task.threadRef)?.revision
        return { taskRef: task.taskRef, threadRef: task.threadRef, projectRef: task.projectRef, status: task.status,
          ...(revision === undefined ? {} : { revision }) }
      }),
      cursor: view.cursor, hasMore: view.hasMore,
      ...(args.cursor === undefined ? {} : { page: 'threads' as const }),
    }
  },
})

/** One schedule as the model names it, and the ledger stores it. */
function reminderScheduleOf(args: { readonly scheduleKind?: string | undefined; readonly at?: string | undefined; readonly minutes?: number | undefined; readonly expression?: string | undefined }): AgentTeamReminderSchedule {
  if (args.scheduleKind === 'once') {
    if (args.at === undefined) throw new Error(`team_reminder create with scheduleKind 'once' needs \`at\` as an ISO 8601 instant — ${recoveryFor('reminder_schedule_incomplete').sentence({})}`)
    return { kind: 'once', at: args.at }
  }
  if (args.scheduleKind === 'every') {
    if (args.minutes === undefined) throw new Error(`team_reminder create with scheduleKind 'every' needs \`minutes\` as a whole number of minutes, at least 10 — ${recoveryFor('reminder_schedule_incomplete').sentence({})}`)
    return { kind: 'every', minutes: args.minutes }
  }
  if (args.scheduleKind === 'cron') {
    if (args.expression === undefined) throw new Error(`team_reminder create with scheduleKind 'cron' needs \`expression\` as five cron fields (minute hour day-of-month month day-of-week) — ${recoveryFor('reminder_schedule_incomplete').sentence({})}`)
    return { kind: 'cron', expression: args.expression }
  }
  throw new Error(`team_reminder create needs scheduleKind as 'once', 'every' or 'cron' — ${recoveryFor('reminder_schedule_incomplete').sentence({})}`)
}

/** One schedule as the result renders it: the stored form, with cron naming the zone it is read in. */
function reminderScheduleText(schedule: AgentTeamReminderSchedule): string {
  if (schedule.kind === 'once') return `once at ${formatTeamTimestamp(schedule.at)}`
  if (schedule.kind === 'every') return `every ${schedule.minutes} minutes`
  return `cron '${schedule.expression}' read in UTC+8`
}

/** One Project's board summary as the overview renders it; the full board stays a `team_task board` read. */
function managerBoardText(board: { readonly open: number; readonly inReview: number }): string {
  const parts: string[] = []
  if (board.open > 0) parts.push(`${board.open} open`)
  if (board.inReview > 0) parts.push(`${board.inReview} awaiting acceptance`)
  return parts.length === 0 ? 'board clear' : parts.join(', ')
}

/**
 * One ownership grant's responsibility as the overview renders it. A grant that
 * recorded none reads `unspecified` — the same word `team_view` and the Project
 * dialog use — because the render is the only channel that reaches the model,
 * so an absent field that prints nothing would leave the promise in the
 * description unfulfillable. It is a fact about the grant, never a defect.
 */
function managerResponsibilityText(responsibility: string | undefined): string {
  return responsibility === undefined ? ' (unspecified)' : ` (${responsibility})`
}

/** One Member's runtime standing as the overview renders it: the diagnostic is the only part a reader acts on. */
function managerStandingText(member: { readonly availability: string; readonly presence: string; readonly diagnostic?: { readonly class: string; readonly detail: string } }): string {
  const base = `${member.availability}/${member.presence}`
  return member.diagnostic === undefined ? base : `${base} · ${member.diagnostic.class}: ${member.diagnostic.detail}`
}

/**
 * One capability warning in the model's words. The runtime drops a name it does
 * not know instead of failing the write, so the warning is the only fact that
 * tells the manager its stored list is narrower than it reads — and the names
 * the Member can actually hold are the only way to correct it, because no
 * manager tool enumerates them. Bounded here: the digest is a whole surface.
 */
function managerCapabilityWarningText(warning: { readonly name: string; readonly knownNames?: readonly string[] | undefined }): string {
  const known = warning.knownNames ?? []
  const digest = known.length === 0 ? '' : ` — names it can hold: ${known.slice(0, 24).join(', ')}${known.length > 24 ? ', …' : ''}`
  return `'${warning.name}' is not a name this Member can hold, so the runtime ignores it${digest}`
}

/**
 * One Member's capability standing as a row renders it: a pending state means
 * the live surface is behind the stored configuration, and a warning means the
 * stored list is ahead of what the Member can actually hold. Both are silent
 * divergences the manager would otherwise read as a clean apply.
 */
function managerCapabilityParts(member: {
  readonly capabilityState: string
  readonly capabilityWarnings?: readonly { readonly name: string; readonly knownNames?: readonly string[] | undefined }[] | undefined
}): string[] {
  const parts: string[] = []
  if (member.capabilityState !== 'applied') parts.push(`capabilities ${member.capabilityState}`)
  for (const warning of member.capabilityWarnings ?? []) parts.push(`capability warning: ${managerCapabilityWarningText(warning)}`)
  return parts
}

/**
 * The manager overview's structured answer. A Project's `state` is kept as a
 * fact rather than pruned: every entry the Host emits is already active, since
 * an archived Project is invisible to any projection.
 */
const MANAGER_OVERVIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  workspaces: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    workspaceId: { type: 'string', required: true }, title: { type: 'string' }, path: { type: 'string' },
    projectCount: { type: 'number', required: true }, memberCount: { type: 'number', required: true },
  } } },
  projects: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    workspaceId: { type: 'string', required: true }, projectRef: { type: 'string', required: true },
    name: { type: 'string', required: true }, description: { type: 'string', required: true }, state: { type: 'string', required: true },
    owners: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      memberRef: { type: 'string', required: true }, handle: { type: 'string', required: true }, responsibility: { type: 'string' },
    } } },
    subscriptions: { type: 'object', additionalProperties: false, required: true, properties: {
      active: { type: 'number', required: true }, paused: { type: 'number', required: true },
    } },
    board: { type: 'object', additionalProperties: false, required: true, properties: {
      open: { type: 'number', required: true }, inReview: { type: 'number', required: true },
    } },
  } } },
  members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    memberRef: { type: 'string', required: true }, handle: { type: 'string', required: true },
    description: { type: 'string', required: true },
    workspaceIds: { type: 'array', required: true, items: { type: 'string' } },
    availability: { type: 'string', required: true }, presence: { type: 'string', required: true },
    diagnostic: { type: 'object', additionalProperties: false, properties: {
      class: { type: 'string', required: true }, detail: { type: 'string', required: true },
      location: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true }, path: { type: 'string', required: true } } },
      sessionId: { type: 'string' }, source: { type: 'string' }, occurredAt: { type: 'string' },
    } },
    model: { type: 'object', additionalProperties: false, properties: {
      provider: { type: 'string', required: true }, model: { type: 'string', required: true }, reasoningEffort: { type: 'string' },
    } },
    capabilityState: { type: 'string', required: true },
    capabilityWarnings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', required: true }, knownNames: { type: 'array', items: { type: 'string' } },
    } } },
    owns: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      projectRef: { type: 'string', required: true }, name: { type: 'string', required: true },
      description: { type: 'string', required: true }, state: { type: 'string', required: true },
      responsibility: { type: 'string' },
    } } },
  } } },
  switches: { type: 'object', additionalProperties: false, required: true, properties: {
    worker: { type: 'boolean', required: true },
  } },
  truncated: { type: 'object', additionalProperties: false, required: true, properties: {
    workspaces: { type: 'boolean', required: true }, projects: { type: 'boolean', required: true }, members: { type: 'boolean', required: true },
  } },
  member: { type: 'object', additionalProperties: false, properties: {
    memberRef: { type: 'string', required: true }, handle: { type: 'string', required: true },
    description: { type: 'string', required: true },
    privateMemoryPath: { type: 'string', required: true },
    owns: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      projectRef: { type: 'string', required: true }, name: { type: 'string', required: true },
      description: { type: 'string', required: true }, state: { type: 'string', required: true },
      responsibility: { type: 'string' },
    } } },
    sessionEvidence: { type: 'object', additionalProperties: false, required: true, properties: {
      sessionId: { type: 'string', required: true },
      state: { type: 'string', required: true, enum: ['stored', 'pending', 'missing', 'unreadable'] },
      location: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true }, path: { type: 'string', required: true },
      } },
      reader: { type: 'object', additionalProperties: false, required: true, properties: {
        script: { type: 'string', required: true }, anchor: { type: 'string' },
      } },
      failure: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true }, detail: { type: 'string', required: true },
        location: { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', required: true }, path: { type: 'string', required: true },
        } },
      } },
    } },
  } },
} } as const

/** The Session locator the member detail renders; mirrors the schema. */
interface ManagerSessionLocatorView {
  readonly sessionId: string
  readonly state: 'stored' | 'pending' | 'missing' | 'unreadable'
  readonly location?: { readonly kind: string; readonly path: string }
  readonly reader: { readonly script: string; readonly anchor?: string }
  readonly failure?: { readonly kind: string; readonly detail: string; readonly location?: { readonly kind: string; readonly path: string } }
}

/**
 * The Session locator lines a memberRef read adds. The locator is where the
 * evidence is, not the evidence: the manager runs the shipped reader for a
 * bounded index and window, and never opens the log path by hand.
 */
function managerSessionLocatorLines(locator: ManagerSessionLocatorView): string[] {
  const lines = [`Session evidence: session ${locator.sessionId} · ${locator.state}`]
  if (locator.location !== undefined) lines.push(`Stored log: ${locator.location.kind} · ${locator.location.path} (backend-resolved provenance; never open it directly)`)
  if (locator.state === 'missing') lines.push('No durable log yet: the Session may be live and not flushed, so this is not evidence that the Member did no work.')
  if (locator.state === 'pending') lines.push('The Session exists but has no materialized log yet.')
  if (locator.failure !== undefined) {
    lines.push(`Unreadable: ${locator.failure.kind} — ${locator.failure.detail}${locator.failure.location === undefined ? '' : ` (${locator.failure.location.kind} · ${locator.failure.location.path})`}`)
  }
  lines.push(`Reader: node ${locator.reader.script}${locator.reader.anchor === undefined ? '' : ` --anchor ${locator.reader.anchor}`} — load the manager-session-evidence skill for the bounded index and window commands.`)
  return lines
}

/**
 * The Team manager's read of the whole Team. It is not `team_view` for the
 * manager: the manager holds no Member identity, so participation, Project
 * membership and message visibility mean nothing here, and no message body or
 * Thread fact belongs in the answer. The refs it returns are the ones a later
 * write addresses, and a Project whose owner recorded no responsibility reads
 * `unspecified` — a fact about the grant, never a defect to repair.
 */
const teamOverview = defineTool({
  name: 'team_overview',
  description: "Read the whole Agent Team as the manager: every Workspace in the Host directory with its checkout path, every Project with its shared goal, its owners and what each answers for, its live subscription counts and board summary, and every Member with its standing, where it participates, which model route it is configured to run, how it runs, what its capability configuration mounted, and what it owns. Read-only: no message bodies, no Thread facts, no credentials, no private file contents. Narrow with workspaceId, projectRef, or memberRef (a memberRef read adds that Member's full standing, its actual private directory, and the locator for its current Session — the Session id, the backend-resolved stored-log location, and the shipped read-only reader that inspects it — and nothing beyond them). The same handle in two Workspaces is two Members, so address one by its memberRef. An owner with no recorded responsibility reads `unspecified`, a Project with only the Human as owner is a fact rather than a fault, and a long-standing Member with no owner relation is reported the same way. A capability warning means the stored configuration named a tool this Member cannot hold: the write succeeded and the stored entry stays, but the runtime ignores it, so the Member runs narrower than the list reads, and the warning names the tools it can hold. Each collection is bounded by `limit` and a cut collection says so through `truncated`, so a large Team is paged by scope instead of silently shortened. An empty answer means the Team is empty; a directory that could not be read refuses instead. Full Thread and Task detail stays team_thread read and team_task board; creating a Member, a Project, or an owner grant rides member_create, project_create and project_owner.",
  parameters: {
    workspaceId: { type: 'string', description: "Narrow to one Workspace id exactly as listed in the overview. An unknown id is refused rather than answered as empty." },
    projectRef: { type: 'string', description: "Full branded Project ref exactly as returned by Team tools, including the 'project:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves; an unknown ref is refused rather than answered as empty." },
    memberRef: { type: 'string', description: "Full branded Member ref exactly as returned by Team tools, including the 'member:' prefix. Reading one adds its full standing, its private directory path, its owned Projects, and the locator for its current Session." },
    limit: { type: 'number', description: 'Maximum entries per collection — Workspaces, Projects and Members are each bounded separately — as an integer from 1 to 100; the default is 50. A collection the bound cuts is reported in `truncated`, so raise this or narrow the scope instead of assuming the Team is that small.' },
  },
  output: { schema: MANAGER_OVERVIEW_SCHEMA,
    render: (_args, value) => {
      const lines: string[] = ['Team overview — every Workspace in this installation']
      lines.push('', 'Workspaces')
      if (value.workspaces.length === 0) lines.push('No Workspaces in the Host directory.')
      else lines.push(...value.workspaces.map(workspace => `${workspace.workspaceId}${workspace.title === undefined ? '' : ` · ${workspace.title}`} · ${workspace.path ?? 'no checkout path'} · ${workspace.projectCount} Project(s), ${workspace.memberCount} Member(s)`))
      lines.push('', 'Projects')
      if (value.projects.length === 0) lines.push('No Projects.')
      else lines.push(...value.projects.map(project => {
        const owners = project.owners.length === 0 ? 'owners: the Human only'
          : `owners ${project.owners.map(owner => `@${owner.handle}${managerResponsibilityText(owner.responsibility)}`).join(', ')}`
        const subscriptions = project.subscriptions.active === 0 && project.subscriptions.paused === 0
          ? ' · subscriptions 0'
          : ` · subscriptions ${project.subscriptions.active === 0 ? '' : `${project.subscriptions.active} active`}${project.subscriptions.active > 0 && project.subscriptions.paused > 0 ? ', ' : ''}${project.subscriptions.paused === 0 ? '' : `${project.subscriptions.paused} paused`}`
        return `${project.projectRef} · ${project.name}${project.description === '' ? '' : ` — ${boundedSubject(project.description)}`} · ${owners} · ${managerBoardText(project.board)}${subscriptions}`
      }))
      lines.push('', 'Members')
      if (value.members.length === 0) lines.push('No Members.')
      else lines.push(...value.members.map(member => {
        // The standing is what the manager wrote when it created or edited the
        // Member, so it is the one fact that lets the manager check its own
        // design instead of guessing what each Member is for.
        const standing = member.description === '' ? '' : ` — ${boundedSubject(member.description)}`
        const capability = managerCapabilityParts(member)
        // The route is a design decision the manager made or inherited, so it
        // reads back beside the runtime state instead of only in the editor. It
        // is the stored selection: a failed live apply leaves the running route
        // behind it, which is why the row names it as configured.
        const model = member.model === undefined
          ? 'configured model: the deployment default'
          : `configured model: ${member.model.provider}/${member.model.model}${member.model.reasoningEffort === undefined ? '' : ` · effort ${member.model.reasoningEffort}`}`
        return `${member.memberRef} · @${member.handle}${standing} · ${managerStandingText(member)} · ${model}${capability.length === 0 ? '' : ` · ${capability.join(' · ')}`} · Workspaces ${member.workspaceIds.join(', ') || 'none'}${member.owns.length === 0 ? '' : ` · owns ${member.owns.map(owned => `${owned.projectRef}${managerResponsibilityText(owned.responsibility)}`).join(', ')}`}`
      }))
      lines.push('', `Switches — Worker delegation ${value.switches.worker ? 'on' : 'off'}`)
      const cut = [value.truncated.workspaces ? 'Workspaces' : '', value.truncated.projects ? 'Projects' : '', value.truncated.members ? 'Members' : ''].filter(part => part !== '')
      if (cut.length > 0) lines.push(`Truncated: ${cut.join(', ')} — narrow the scope or raise limit; nothing was dropped silently.`)
      if (value.member !== undefined) {
        lines.push('', `Member detail — ${value.member.memberRef} · @${value.member.handle}`,
          `Standing: ${value.member.description === '' ? '(none recorded)' : value.member.description}`,
          `Private directory: ${value.member.privateMemoryPath} — its path only; contents, credentials and Session bodies are not read.`,
          value.member.owns.length === 0 ? 'Owns no Project.' : `Owns ${value.member.owns.map(owned => `${owned.projectRef}${managerResponsibilityText(owned.responsibility)}`).join(', ')}.`,
          ...managerSessionLocatorLines(value.member.sessionEvidence))
      }
      lines.push('', 'Creating a Member, a Project, or an owner grant rides member_create, project_create and project_owner; Thread and Task detail stays team_thread read and team_task board.')
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, ['workspaceId', 'projectRef', 'memberRef', 'limit'])
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_overview requires an Agent session')
    const host = service(agent)
    const overview = host.managerOverviewForAgent(agent, {
      ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId as WorkspaceId }),
      ...(args.projectRef === undefined ? {} : { projectRef: projectRefOf(args.projectRef) as AgentTeamProjectRef }),
      ...(args.memberRef === undefined ? {} : { memberRef: args.memberRef as AgentTeamMemberId }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    })
    // The locator is a second read because it is a Session fact, not a ledger
    // one: the Host resolves the Member's current Session and asks the backend
    // where its log is. The overview itself stays synchronous and unchanged.
    const detail = overview.member === undefined ? undefined : {
      memberRef: overview.member.memberRef, handle: overview.member.handle, description: overview.member.description,
      privateMemoryPath: overview.member.privateMemoryPath,
      owns: overview.member.owns.map(owned => managerOwnedProject(owned)),
      sessionEvidence: managerSessionEvidence(await host.managerSessionLocatorForAgent(agent, overview.member.memberRef)),
    }
    return {
      workspaces: overview.workspaces.map(workspace => ({ workspaceId: workspace.workspaceId,
        ...(workspace.title === undefined ? {} : { title: workspace.title }),
        path: workspace.path ?? '', projectCount: workspace.projectCount, memberCount: workspace.memberCount })),
      projects: overview.projects.map(project => ({ workspaceId: project.workspaceId, projectRef: project.projectRef,
        name: project.name, description: project.description, state: project.state,
        owners: project.owners.map(owner => ({ memberRef: owner.memberRef, handle: owner.handle,
          ...(owner.responsibility === undefined ? {} : { responsibility: owner.responsibility }) })),
        subscriptions: { active: project.subscriptions.active, paused: project.subscriptions.paused },
        board: { open: project.board.open, inReview: project.board.inReview } })),
      members: overview.members.map(member => ({ memberRef: member.memberRef, handle: member.handle,
        description: member.description, availability: member.availability, presence: member.presence,
        workspaceIds: [...member.workspaceIds],
        ...(member.diagnostic === undefined ? {} : { diagnostic: {
          class: member.diagnostic.class, detail: member.diagnostic.detail,
          ...(member.diagnostic.location === undefined ? {} : { location: { kind: member.diagnostic.location.kind, path: member.diagnostic.location.path } }),
          ...(member.diagnostic.sessionId === undefined ? {} : { sessionId: member.diagnostic.sessionId }),
          ...(member.diagnostic.source === undefined ? {} : { source: member.diagnostic.source }),
          ...(member.diagnostic.occurredAt === undefined ? {} : { occurredAt: member.diagnostic.occurredAt }),
        } }),
        ...(member.model === undefined ? {} : { model: {
          provider: member.model.provider, model: member.model.model,
          ...(member.model.reasoningEffort === undefined ? {} : { reasoningEffort: member.model.reasoningEffort }),
        } }),
        capabilityState: member.capabilityState,
        ...(member.capabilityWarnings === undefined ? {} : { capabilityWarnings: member.capabilityWarnings.map(warning => ({
          name: warning.name, knownNames: [...warning.knownNames],
        })) }),
        owns: member.owns.map(owned => managerOwnedProject(owned)) })),
      switches: { worker: overview.switches.worker },
      truncated: { workspaces: overview.truncated.workspaces, projects: overview.truncated.projects, members: overview.truncated.members },
      ...(detail === undefined ? {} : { member: detail }),
    }
  },
})

/** One owned Project as the overview result carries it: the write-side refs plus the responsibility, if the grant recorded one. */
function managerOwnedProject(owned: AgentTeamOwnedProject): { projectRef: string; name: string; description: string; state: string; responsibility?: string } {
  return {
    projectRef: owned.project.projectRef, name: owned.project.name,
    description: owned.project.description, state: owned.project.state,
    ...(owned.responsibility === undefined ? {} : { responsibility: owned.responsibility }),
  }
}

/** One Member's Session locator as the overview result carries it: the id, the state the backend reported, and the reader that can inspect it. */
function managerSessionEvidence(locator: AgentTeamManagerSessionEvidenceLocator): {
  sessionId: string
  state: AgentTeamManagerSessionEvidenceState
  location?: { kind: string; path: string }
  reader: { script: string; anchor?: string }
  failure?: { kind: AgentTeamManagerSessionEvidenceFailureKind; detail: string; location?: { kind: string; path: string } }
} {
  return {
    sessionId: locator.sessionId, state: locator.state,
    ...(locator.location === undefined ? {} : { location: { kind: locator.location.kind, path: locator.location.path } }),
    reader: { script: locator.reader.script, ...(locator.reader.anchor === undefined ? {} : { anchor: locator.reader.anchor }) },
    ...(locator.failure === undefined ? {} : { failure: {
      kind: locator.failure.kind, detail: locator.failure.detail,
      ...(locator.failure.location === undefined ? {} : { location: { kind: locator.failure.location.kind, path: locator.failure.location.path } }),
    } }),
  }
}

const MANAGER_MODELS_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  default: { type: 'object', additionalProperties: false, required: true, properties: {
    provider: { type: 'string', required: true }, model: { type: 'string', required: true }, reasoningEffort: { type: 'string' },
  } },
  routableProviders: { type: 'array', required: true, items: { type: 'string' } },
  groups: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true }, name: { type: 'string', required: true },
    models: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, name: { type: 'string', required: true }, description: { type: 'string' },
      reasoning: { type: 'object', additionalProperties: false, properties: {
        efforts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          id: { type: 'string', required: true }, name: { type: 'string', required: true },
        } } },
      } },
    } } },
  } } },
  failures: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
    id: { type: 'string', required: true }, name: { type: 'string', required: true }, message: { type: 'string', required: true },
  } } },
  memberPresets: { type: 'array', required: true, items: { type: 'string' } },
} } as const

/**
 * The model routes a Member may run. This reads the Session controller's own
 * catalog rather than restating it, so the manager can never offer a route the
 * Web member editor does not, and a provider whose lookup failed is reported as
 * a failure rather than folded into an empty list.
 */
const teamModels = defineTool({
  name: 'team_models',
  description: 'List the model routes a Team Member may run: every provider group with its models, each model\'s own description and reasoning efforts, the deployment default, and the providers whose catalog lookup failed. This is the same catalog the Web member editor offers, so a route named here is selectable there. A failed provider is reported in `failures` and is never read as an empty catalog. `memberPresets` names the one preset a Member may compose; the manager\'s own preset is deliberately not member-selectable and never appears here.',
  parameters: {},
  output: { schema: MANAGER_MODELS_SCHEMA,
    render: (_args, value) => {
      const lines: string[] = ['Model catalog — what a Member may run',
        `Default: ${value.default.provider}/${value.default.model}${value.default.reasoningEffort === undefined ? '' : ` · effort ${value.default.reasoningEffort}`}`]
      if (value.groups.length === 0 && value.failures.length === 0) lines.push('', 'No provider returned a model.')
      for (const group of value.groups) {
        lines.push('', `${group.name} (${group.id})`)
        if (group.models.length === 0) lines.push('  no model available')
        else lines.push(...group.models.map(model => `  ${model.id} · ${model.name}${model.description === undefined || model.description === '' ? '' : ` — ${boundedSubject(model.description)}`}${model.reasoning?.efforts === undefined || model.reasoning.efforts.length === 0 ? '' : ` · efforts ${model.reasoning.efforts.map(effort => effort.id).join(', ')}`}`))
      }
      if (value.failures.length > 0) {
        lines.push('', 'Failures — providers whose catalog could not be read; a failure, never an empty list:')
        lines.push(...value.failures.map(failure => `  ${failure.id} · ${failure.name} — ${failure.message}`))
      }
      lines.push('', `Member presets: ${value.memberPresets.join(', ') || 'none'}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(_rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_models requires an Agent session')
    const host = service(agent)
    const models = await host.managerModelsForAgent(agent)
    const defaultRoute = models.catalog.default
    return {
      default: { provider: defaultRoute.provider, model: defaultRoute.model,
        ...(defaultRoute.reasoningEffort === undefined ? {} : { reasoningEffort: defaultRoute.reasoningEffort }) },
      routableProviders: [...models.catalog.routableProviders],
      groups: models.catalog.groups.map(group => ({
        id: group.id,
        name: group.name,
        models: group.models.map(model => {
          const modelRow: { id: string; name: string; description?: string; reasoning?: { efforts: { id: string; name: string }[] } } = { id: model.id, name: model.name }
          if (model.description !== undefined) modelRow.description = model.description
          if (model.reasoning !== undefined) modelRow.reasoning = { efforts: model.reasoning.efforts.map(effort => ({ id: effort.id, name: effort.name })) }
          return modelRow
        }),
      })),
      failures: models.catalog.failures.map(failure => ({ id: failure.id, name: failure.name, message: failure.message })),
      memberPresets: [...models.memberPresets],
    }
  },
})

/** One committed operation's receipt, the durable handle a later read or replay addresses. */
const MANAGER_RECEIPT_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  operationId: { type: 'string', required: true }, requestId: { type: 'string', required: true },
  sequence: { type: 'number', required: true }, occurredAt: { type: 'string', required: true },
} } as const

/** The live standing a committed Member reads after its write: a failed activation is a committed fact with a diagnostic. */
const MANAGER_MEMBER_STATUS_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  availability: { type: 'string', required: true }, presence: { type: 'string', required: true },
  capabilityState: { type: 'string', required: true },
  diagnostic: { type: 'object', additionalProperties: false, properties: {
    class: { type: 'string', required: true }, detail: { type: 'string', required: true },
  } },
  capabilityWarnings: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    name: { type: 'string', required: true }, knownNames: { type: 'array', items: { type: 'string' } },
  } } },
} } as const

/**
 * One Member's live standing as every manager write answers it. The projection
 * is shared so a write can never answer a narrower standing than its sibling:
 * the diagnostic and the capability warnings are the two facts a manager acts
 * on, and dropping either turns a divergence into a clean-looking success.
 */
function managerStatusView(status: {
  readonly availability: string
  readonly presence: string
  readonly capabilityState: string
  readonly diagnostic?: { readonly class: string; readonly detail: string } | undefined
  readonly capabilityWarnings?: readonly { readonly name: string; readonly knownNames?: readonly string[] | undefined }[] | undefined
}): {
  availability: string; presence: string; capabilityState: string
  diagnostic?: { class: string; detail: string }
  capabilityWarnings?: { name: string; knownNames?: string[] }[]
} {
  return {
    availability: status.availability, presence: status.presence, capabilityState: status.capabilityState,
    ...(status.diagnostic === undefined ? {} : { diagnostic: { class: status.diagnostic.class, detail: status.diagnostic.detail } }),
    ...(status.capabilityWarnings === undefined ? {} : { capabilityWarnings: status.capabilityWarnings.map(warning => ({
      name: warning.name,
      ...(warning.knownNames === undefined ? {} : { knownNames: [...warning.knownNames] }),
    })) }),
  }
}

const MEMBER_CREATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  memberRef: { type: 'string', required: true },
  workspaceIds: { type: 'array', required: true, items: { type: 'string' } },
  status: { ...MANAGER_MEMBER_STATUS_SCHEMA, required: true },
} } as const

/**
 * Create one Member as the manager. The write rides the Host's own addition
 * path — the same queue, activation and receipt the Web Client uses — so the
 * record it answers with is the record every other surface reads. The
 * description of the tool is the operational contract: the refs it returns are
 * the ones every later write addresses, and the receipt plus requestId are
 * what makes a retry a replay instead of a second Member.
 */
const memberCreate = defineTool({
  name: 'member_create',
  description: "Create one Agent Member in one Workspace as the Team manager. The Member is a durable Team record: it appears in the Web Client, answers in its own Session, and is addressed from now on by its memberRef — never by its handle, because the same handle in two Workspaces is two different Members. Requires the handle (free in that Workspace), a description of the Member's global standing, and an explicit model route exactly as team_models listed it; the Member preset is fixed and is not a choice. Capabilities are optional; absent means the full standard surface. Every write carries a requestId: pass your own when the write matters enough to retry — the same id with the same parameters answers with the original receipt instead of writing twice, while a changed parameter under a reused id is refused as a collision. A refusal names its reason and wrote nothing. A committed Member whose activation failed is still committed: the answer keeps its receipt, ref and activation diagnostic, so continue from there instead of creating it again. Only the live Team manager Session holds this tool.",
  parameters: {
    workspaceId: { type: 'string', required: true, description: "Target Workspace id exactly as team_overview listed it. The Member is created in this Workspace and its Session runs in that Workspace's checkout." },
    handle: { type: 'string', required: true, description: 'The Member handle, unique within the target Workspace. It names the Member to the Human; it is never an address for a later write.' },
    description: { type: 'string', required: true, description: "The Member's global standing — what it is for across every Project. Required here; an empty standing is refused." },
    model: { type: 'object', additionalProperties: false, required: true, properties: {
      provider: { type: 'string', required: true, description: 'Provider id exactly as team_models listed it.' },
      model: { type: 'string', required: true, description: 'Model id exactly as team_models listed it under that provider.' },
      reasoningEffort: { type: 'string', description: 'Reasoning effort id exactly as team_models listed it for that model; absent uses the provider default.' },
    } },
    capabilities: { type: 'object', additionalProperties: false, properties: {
      tools: { type: 'object', additionalProperties: false, properties: { allow: { type: 'array', items: { type: 'string' } } } },
      skills: { type: 'object', additionalProperties: false, properties: { allow: { type: 'array', items: { type: 'string' } } } },
    }, description: 'Optional durable capability intent; absent means the full standard surface. Unknown names drop with a warning rather than failing the write.' },
    requestId: { type: 'string', description: 'Your own idempotency key for this write. Omit it and the Host derives one per call — but then a lost answer cannot be retried by id, so read back with team_overview instead.' },
  },
  output: { schema: MEMBER_CREATE_SCHEMA,
    render: (_args, value) => {
      const lines = [`Member created — ${value.memberRef}`, `Workspaces ${value.workspaceIds.join(', ') || 'none'} · receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`]
      const diagnostic = value.status.diagnostic
      if (diagnostic === undefined) {
        lines.push(`Availability ${value.status.availability} · presence ${value.status.presence} · capabilities ${value.status.capabilityState}`)
      } else {
        lines.push(`Committed, but the Member is not live: ${diagnostic.class} — ${diagnostic.detail}`,
          'The write stands; continue from this receipt and ref instead of creating it again.')
      }
      // A name the stored capability list could not hold is dropped rather than
      // refused, so the warning is the only fact that keeps "created as asked"
      // from being a false reading.
      for (const warning of value.status.capabilityWarnings ?? []) lines.push(`Capability warning: ${managerCapabilityWarningText(warning)}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('member_create requires an Agent session')
    const host = service(agent)
    // A blank capability intent names no intent, exactly as a blank requestId
    // names no retry key: both drop rather than reach the Host as a value.
    const args = blankToAbsent(rawArgs, ['requestId', 'capabilities'])
    const result = await host.managerCreateMemberForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      workspaceId: args.workspaceId as WorkspaceId,
      handle: args.handle,
      description: args.description,
      model: args.model as AgentTeamModelSelection,
      ...(args.capabilities === undefined ? {} : { capabilities: args.capabilities as AgentTeamMemberCapabilities }),
    })
    return {
      requestId: result.requestId, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      memberRef: result.memberRef, workspaceIds: [...result.workspaceIds],
      status: managerStatusView(result.status),
    }
  },
})

const PROJECT_CREATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  projectRef: { type: 'string', required: true },
} } as const

/**
 * Record one Project's shared goal for the manager. Creation brings no Members
 * in — Project membership gates nothing, and ownership is granted separately
 * through project_owner.
 */
const projectCreate = defineTool({
  name: 'project_create',
  description: "Create one Project in an existing Workspace as the Team manager, recording its shared goal as the description. A Project is a durable Team record addressed from now on by its projectRef; any Member that participates in the Workspace can already read and write in it, so owners are granted afterwards with project_owner. An empty shared goal is refused: a Project exists for a continuing result someone answers for. Every write carries a requestId with the same replay rule as member_create — the same id and parameters answer with the original receipt, a changed parameter under a reused id is a collision. A refusal names its reason and wrote nothing. Only the live Team manager Session holds this tool.",
  parameters: {
    workspaceId: { type: 'string', required: true, description: "Target Workspace id exactly as team_overview listed it. The Project is created in this Workspace." },
    name: { type: 'string', required: true, description: 'Short display name for the Project.' },
    description: { type: 'string', required: true, description: "The Project's shared goal — the continuing result its owners answer for. Required here; an empty goal is refused." },
    requestId: { type: 'string', description: 'Your own idempotency key for this write, with the same replay rule as member_create.' },
  },
  output: { schema: PROJECT_CREATE_SCHEMA,
    render: (_args, value) => [
      { type: 'text', text: [
        `Project created — ${value.projectRef}`,
        `receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`,
      ].join('\n') },
    ],
  },
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('project_create requires an Agent session')
    const host = service(agent)
    const args = blankToAbsent(rawArgs, ['requestId'])
    const result = await host.managerCreateProjectForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      workspaceId: args.workspaceId as WorkspaceId,
      name: args.name,
      description: args.description,
    })
    return {
      requestId: result.requestId, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      projectRef: result.projectRef,
    }
  },
})

const PROJECT_OWNER_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, action: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  projectRef: { type: 'string', required: true },
  memberRef: { type: 'string', required: true },
  responsibility: { type: 'string' },
} } as const

/** What one ownership change answered, in the model's own words. */
function projectOwnerHead(action: string): string {
  return action === 'add' ? 'Owner granted' : action === 'update' ? 'Responsibility updated' : 'Owner withdrawn'
}

/**
 * Grant, re-describe, or withdraw one Agent Member's ownership of one Project.
 * Eligibility is the ledger's own rule and the grant itself is the Member's
 * Project participation, so every action reuses the Host's own ownership path
 * rather than restating either rule here.
 */
const projectOwner = defineTool({
  name: 'project_owner',
  description: "Change one Agent Member's ownership of one Project as the Team manager. `add` grants it and records what the owner answers for there; `update` replaces that responsibility without withdrawing and re-granting, so the Member keeps its grant, its Main stream following and its history; `remove` withdraws the ownership. The grantee must already participate in the Project's Workspace and be enabled or suspended — an archived Member is refused with its reason — and a grant itself is that Member's Project participation. The responsibility is what this owner answers for in this Project: a bounded statement, distinct from the Member's global description and the Project's shared goal. `add` refuses an empty one; `update` accepts an explicit empty one and records that the responsibility is unspecified, exactly as the Web entry does; `remove` takes none. Withdrawing an owner keeps the Task responsibility of a Member that still participates in the Project in another way, and returns open Tasks to the Human only when the ownership was its last participation. Every write carries a requestId with the same replay rule as member_create — the same id and parameters answer with the original receipt, a changed parameter under a reused id is a collision. A refusal names its reason and wrote nothing. Only the live Team manager Session holds this tool.",
  parameters: {
    action: { type: 'string', required: true, enum: ['add', 'update', 'remove'], description: "The ownership change to make: 'add' grants it, 'update' replaces its responsibility, 'remove' withdraws it." },
    workspaceId: { type: 'string', required: true, description: "The Project's Workspace id exactly as team_overview listed it." },
    projectRef: { type: 'string', required: true, description: "Full branded Project ref exactly as team_overview returned it, including the 'project:' prefix." },
    memberRef: { type: 'string', required: true, description: "Full branded Member ref exactly as team_overview returned it, including the 'member:' prefix. Never a handle: the same handle in two Workspaces is two Members." },
    responsibility: { type: 'string', description: "add and update only: what this owner answers for in this Project, at most 2,000 characters. 'add' refuses an empty one; on 'update' an empty one is the same as clearResponsibility. Refused on 'remove', which describes nothing." },
    clearResponsibility: { type: 'boolean', description: "update only: record that this owner's responsibility is unspecified, exactly as the Web entry does when it is left empty. Refused together with a non-empty responsibility, and refused on add or remove." },
    requestId: { type: 'string', description: 'Your own idempotency key for this write, with the same replay rule as member_create.' },
  },
  output: { schema: PROJECT_OWNER_SCHEMA,
    render: (_args, value) => {
      const lines = [`${projectOwnerHead(value.action)} — ${value.memberRef} ${value.action === 'remove' ? 'no longer owns' : 'owns'} ${value.projectRef}`]
      if (value.responsibility !== undefined) {
        lines.push(`Responsibility: ${value.responsibility === '' ? 'unspecified' : value.responsibility}`)
      }
      if (value.action === 'add') lines.push('The grant itself is this Member\'s Project participation')
      if (value.action === 'remove') lines.push('A Member that still participates in this Project in another way keeps its Task responsibility')
      lines.push(`Receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('project_owner requires an Agent session')
    const host = service(agent)
    // A blank requestId names no retry key and `false` names no clearing. A
    // blank responsibility is different on `update`: the documented empty value
    // is how a model records "unspecified", so it survives here and only the
    // actions that describe nothing drop it.
    const args = blankToAbsent(rawArgs, ['clearResponsibility', 'requestId'])
    const action = args.action as 'add' | 'update' | 'remove'
    if (action !== 'update' && typeof args.responsibility === 'string' && args.responsibility.trim() === '') {
      delete (args as { responsibility?: unknown }).responsibility
    }
    if (action === 'remove' && (args.responsibility !== undefined || args.clearResponsibility === true)) {
      throw new Error("project_owner takes responsibility only with add or update; a withdrawn ownership describes nothing.")
    }
    if (action === 'add' && args.clearResponsibility === true) {
      throw new Error('project_owner add needs the responsibility the owner answers for; there is nothing to clear on a new grant.')
    }
    if (args.clearResponsibility === true && typeof args.responsibility === 'string' && args.responsibility.trim() !== '') {
      throw new Error('project_owner takes either responsibility or clearResponsibility, not both: clearing records that it is unspecified.')
    }
    const responsibility = args.clearResponsibility === true ? '' : args.responsibility as string | undefined
    const result = await host.managerChangeProjectOwnerForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      workspaceId: args.workspaceId as WorkspaceId,
      projectRef: projectRefOf(args.projectRef) as AgentTeamProjectRef,
      memberRef: args.memberRef as AgentTeamMemberId,
      action,
      ...(responsibility === undefined ? {} : { responsibility }),
    })
    return {
      requestId: result.requestId, action: result.action, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      projectRef: result.projectRef, memberRef: result.memberRef,
      ...(result.responsibility === undefined ? {} : { responsibility: result.responsibility }),
    }
  },
})

const PROJECT_UPDATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, action: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  projectRef: { type: 'string', required: true },
  name: { type: 'string', required: true }, description: { type: 'string', required: true }, state: { type: 'string', required: true },
  releasedClaims: { type: 'number' }, subscriptionsCleared: { type: 'number' }, cleanupWarning: { type: 'string' },
} } as const

/**
 * Edit one Project's display facts or archive it. The update is a patch: a
 * field the call leaves out keeps the value stored when the ledger's serialized
 * section runs, so a rename never writes back a goal the Human changed while it
 * was queued. Archival is the lifecycle decision, not a deletion.
 */
const projectUpdate = defineTool({
  name: 'project_update',
  description: "Edit one Project as the Team manager: rename it, restate its shared goal, or archive it. `update` is a partial patch — every field you leave out keeps the value stored at the moment the write runs, so a rename cannot overwrite a goal that landed while it was queued — and it needs at least one of `name` or `description`. `archive` takes the refs alone: the Project disappears from every Team surface with its history kept, its active Claims release, the related Attention clears, and every subscription it owns stops with its private state cleared; open Tasks return to the Human under the ledger's own rules. Archiving is the end state this version offers — there is no permanent-removal tool, and the Project's facts stay readable. A refusal names its reason and wrote nothing, including a repeated archive and an archived Project ref. A cleanup that fails after the archival committed is named in the answer as a cleanup warning, and the receipt still stands. Only the live Team manager Session holds this tool.",
  parameters: {
    action: { type: 'string', required: true, enum: ['update', 'archive'], description: "The change to make: 'update' patches the display facts, 'archive' ends the Project's life without deleting it." },
    workspaceId: { type: 'string', required: true, description: "The Project's Workspace id exactly as team_overview listed it." },
    projectRef: { type: 'string', required: true, description: "Full branded Project ref exactly as team_overview returned it, including the 'project:' prefix." },
    name: { type: 'string', description: "update only: the Project's new name, non-empty. Omit to keep the stored one; refused on archive." },
    description: { type: 'string', description: "update only: the shared goal, which may be an explicit empty string. Omit to keep the stored one; refused on archive." },
    requestId: { type: 'string', description: 'Your own idempotency key for this write, with the same replay rule as member_create.' },
  },
  output: { schema: PROJECT_UPDATE_SCHEMA,
    render: (_args, value) => {
      if (value.action === 'update') {
        return [{ type: 'text', text: [
          `Project updated — ${value.projectRef}`,
          `Name: ${value.name}`,
          `Shared goal: ${value.description === '' ? '(none recorded)' : value.description}`,
          `Receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`,
        ].join('\n') }]
      }
      const lines = [
        `Project archived — ${value.projectRef} (${value.name})`,
        `${value.releasedClaims ?? 0} active Claim(s) released · ${value.subscriptionsCleared ?? 0} subscription(s) stopped and cleared`,
        'History is kept and the Project is hidden from every Team surface; nothing was deleted.',
        `Receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`,
      ]
      if (value.cleanupWarning !== undefined) {
        lines.push(`Cleanup warning: the archival is durable, but clearing subscription state failed — ${value.cleanupWarning}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('project_update requires an Agent session')
    const host = service(agent)
    // A blank name names no rename. A description is different: an explicit
    // empty one clears the shared goal, so it is only meaningless on archive.
    const args = blankToAbsent(rawArgs, ['name', 'requestId'])
    const action = args.action as 'update' | 'archive'
    const description = typeof rawArgs.description === 'string' ? rawArgs.description : undefined
    if (action === 'archive' && (args.name !== undefined || (description !== undefined && description !== ''))) {
      throw new Error('project_update archives a Project by ref alone; a name or shared goal belongs to the update action.')
    }
    // A blank goal on archive names nothing; on update it is an explicit clear.
    const statedDescription = action === 'archive' ? undefined : description
    const result = await host.managerUpdateProjectForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      workspaceId: args.workspaceId as WorkspaceId,
      projectRef: projectRefOf(args.projectRef) as AgentTeamProjectRef,
      action,
      ...(args.name === undefined ? {} : { name: args.name as string }),
      ...(statedDescription === undefined ? {} : { description: statedDescription }),
    })
    return {
      requestId: result.requestId, action: result.action, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      projectRef: result.projectRef, name: result.name, description: result.description, state: result.state,
      ...(result.releasedClaims === undefined ? {} : { releasedClaims: result.releasedClaims }),
      ...(result.subscriptionsCleared === undefined ? {} : { subscriptionsCleared: result.subscriptionsCleared }),
      ...(result.cleanupWarning === undefined ? {} : { cleanupWarning: result.cleanupWarning }),
    }
  },
})

const MEMBER_UPDATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  memberRef: { type: 'string', required: true },
  effect: { type: 'string', required: true },
  status: { ...MANAGER_MEMBER_STATUS_SCHEMA, required: true },
} } as const

/**
 * Edit one Member's mutable facts as the manager. The write is a patch: every
 * field the call leaves out keeps the value stored when the ledger's serialized
 * section runs, so a concurrent rename or description edit is never written
 * back over. A capability override is cleared only by `clearCapabilities`,
 * which is why "unchanged" and "cleared" stay different calls.
 */
const memberUpdate = defineTool({
  name: 'member_update',
  description: "Edit one Agent Member's mutable facts as the Team manager: its description, its model route, and its capability configuration. The handle and the Member preset are not editable here. This is a partial update — every field you leave out keeps the value stored at the moment the write runs, so an edit cannot overwrite a rename or description change that landed while it was queued. An omitted `capabilities` keeps the stored override; pass `clearCapabilities: true` to restore the full standard surface (the two are refused together, because clearing is not the same as setting an empty list). A replacement model is checked against the same catalog team_models lists, and only while the request is new: the same requestId with the same patch replays to its original receipt even if the catalog or the Member's other fields changed since, while a changed patch under a reused id is refused as a collision. The answer keeps the durable receipt and reports how far the stored configuration reached the live runtime; a committed write whose live apply failed answers `effect: failed:model-apply` or `failed:capability-apply` with the Member's own diagnostic instead of pretending it took effect, and replaying the same requestId retries the effect the stored route still owes. Only the live Team manager Session holds this tool.",
  parameters: {
    memberRef: { type: 'string', required: true, description: "Full branded Member ref exactly as team_overview returned it, including the 'member:' prefix. Never a handle: the same handle in two Workspaces is two Members." },
    description: { type: 'string', description: "The Member's new global standing. Omit to keep the current one; an explicit blank is refused, because a Member is addressed by what it is for." },
    model: { type: 'object', additionalProperties: false, properties: {
      provider: { type: 'string', required: true, description: 'Provider id exactly as team_models listed it.' },
      model: { type: 'string', required: true, description: 'Model id exactly as team_models listed it under that provider.' },
      reasoningEffort: { type: 'string', description: 'Reasoning effort id exactly as team_models listed it for that model; absent uses the provider default.' },
    }, description: 'A replacement model route. Omit to keep the stored route; a Member always runs an explicit route, so a route cannot be cleared.' },
    capabilities: { type: 'object', additionalProperties: false, properties: {
      tools: { type: 'object', additionalProperties: false, properties: { allow: { type: 'array', items: { type: 'string' } } } },
      skills: { type: 'object', additionalProperties: false, properties: { allow: { type: 'array', items: { type: 'string' } } } },
    }, description: 'A replacement capability intent. Omit to keep the stored override; unknown names drop with a warning rather than failing the write.' },
    clearCapabilities: { type: 'boolean', description: 'Explicitly restore the full standard surface by clearing the stored capability override. Refused together with capabilities; omit (or false) to keep the override.' },
    requestId: { type: 'string', description: 'Your own idempotency key for this write. Omit it and the Host derives one per call — but then a lost answer cannot be retried by id, so read back with team_overview instead.' },
  },
  output: { schema: MEMBER_UPDATE_SCHEMA,
    render: (_args, value) => {
      const lines = [`Member updated — ${value.memberRef} · receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`]
      const diagnostic = value.status.diagnostic
      // The literal effect token is part of the contract the description names,
      // and the render is the only channel a model reads it through.
      const effect = `Runtime effect: ${value.effect} — ${memberEffectText(value.effect)}.`
      if (value.effect === 'failed:capability-apply') {
        lines.push(`Saved, but the capability restriction could not be applied: ${diagnostic?.detail ?? 'the live runtime refused it'}`,
          'The stored configuration stands; the next activation retries it.', effect)
      } else if (value.effect === 'failed:model-apply') {
        lines.push(`Saved, but the model route could not be applied: ${diagnostic?.detail ?? 'the live runtime refused it'}`,
          'The stored route stands; replaying this request retries it, and the next activation applies it.', effect)
      } else if (diagnostic !== undefined) {
        lines.push(`Committed, but the Member is not live: ${diagnostic.class} — ${diagnostic.detail}`, effect)
      } else {
        lines.push(`Availability ${value.status.availability} · presence ${value.status.presence} · capabilities ${value.status.capabilityState}`, effect)
      }
      for (const warning of value.status.capabilityWarnings ?? []) lines.push(`Capability warning: ${managerCapabilityWarningText(warning)}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('member_update requires an Agent session')
    const host = service(agent)
    // A blank field names no intent, exactly as a blank requestId names no retry key.
    const args = blankToAbsent(rawArgs, ['description', 'model', 'capabilities', 'clearCapabilities', 'requestId'])
    if (args.clearCapabilities === true && args.capabilities !== undefined) {
      throw new Error('member_update takes either capabilities or clearCapabilities, not both: clearing restores the full standard surface, while an empty capability list would mount nothing.')
    }
    const capabilities = args.clearCapabilities === true ? null : args.capabilities as AgentTeamMemberCapabilities | undefined
    const result = await host.managerUpdateMemberForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      memberRef: args.memberRef as AgentTeamMemberId,
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.model === undefined ? {} : { model: args.model as AgentTeamModelSelection }),
      ...(capabilities === undefined ? {} : { capabilities }),
    })
    return {
      requestId: result.requestId, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      memberRef: result.memberRef, effect: result.effect,
      status: managerStatusView(result.status),
    }
  },
})

/** One runtime effect in the model's own words; the enum stays the Host's contract. */
function memberEffectText(effect: string): string {
  switch (effect) {
    case 'applied': return 'the live runtime picked up the new configuration'
    case 'already-applied': return 'no runtime change was needed'
    case 'deferred:no-live-handle': return 'stored; it takes effect at the next activation'
    case 'deferred:generation-changed': return 'stored; the Member changed generation before it could apply'
    case 'failed:model-apply': return 'stored, but the live model route apply failed'
    case 'failed:capability-apply': return 'stored, but the live capability apply failed'
    default: return effect
  }
}

const MEMBER_STATE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, action: { type: 'string', required: true },
  outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA },
  memberRef: { type: 'string', required: true },
  status: { ...MANAGER_MEMBER_STATUS_SCHEMA, required: true },
  releasedClaims: { type: 'number' }, removedAttention: { type: 'number' },
} } as const

/**
 * Move one Member through its lifecycle as the manager. The three durable
 * actions ride the Host's own ledger operations; `recover` is the runtime
 * nudge with no ledger record, which is why it alone names a Workspace.
 */
const memberState = defineTool({
  name: 'member_state',
  description: "Change one Agent Member's lifecycle as the Team manager. `suspend` and `resume` are the Host's existing durable operations (a suspended Member keeps its Session and private data, and resume activates it again); `archive` hides the Member everywhere, releases its active Claims, clears its Attention, and keeps its private memory and Session log on disk — this version has no permanent-removal tool, and archived is the end state it offers. `recover` is a runtime-only repair with no ledger record: it finishes an interrupted generation swap or suspend cleanup, rebuilds a Member whose preset composition was orphaned by a reload, or restarts one whose activation failed; it needs the Workspace id whose participation the Host verifies, and it refuses a Member that is not enabled when a restart is the only path. A refusal names its reason and writes nothing; a committed write answers its receipt and the Member's standing after it. Only the live Team manager Session holds this tool.",
  parameters: {
    action: { type: 'string', required: true, enum: ['suspend', 'resume', 'archive', 'recover'], description: "The lifecycle change to make. 'recover' is runtime-only and takes workspaceId; the other three are ledger writes that take only memberRef." },
    memberRef: { type: 'string', required: true, description: "Full branded Member ref exactly as team_overview returned it, including the 'member:' prefix." },
    workspaceId: { type: 'string', description: "recover only: the Workspace id the Member must participate in, exactly as team_overview listed it. Refused on the other actions, which address the Member alone." },
    requestId: { type: 'string', description: 'Your own idempotency key for a durable action, with the same replay rule as member_create. Ignored by recover, which writes no ledger record.' },
  },
  output: { schema: MEMBER_STATE_SCHEMA,
    render: (_args, value) => {
      const head = value.action === 'suspend' ? `Member suspended — ${value.memberRef}`
        : value.action === 'resume' ? `Member resumed — ${value.memberRef}`
        : value.action === 'archive' ? `Member archived — ${value.memberRef}`
        : `Member recovery — ${value.memberRef}`
      const lines = [head]
      if (value.action === 'recover') {
        lines.push('Runtime-only: no ledger record was written.')
        const diagnostic = value.status.diagnostic
        lines.push(diagnostic === undefined
          ? `Availability ${value.status.availability} · presence ${value.status.presence}`
          : `Still not live: ${diagnostic.class} — ${diagnostic.detail}`)
        return [{ type: 'text', text: lines.join('\n') }]
      }
      lines.push(`Receipt ${value.receipt!.operationId} (sequence ${value.receipt!.sequence}) · availability ${value.status.availability} · presence ${value.status.presence}`)
      if (value.action === 'archive') {
        lines.push(`${value.releasedClaims ?? 0} active Claim(s) released · ${value.removedAttention ?? 0} Attention row(s) cleared`,
          'Private memory and the Session log stay on disk; nothing was deleted.')
      }
      if (value.status.diagnostic !== undefined) {
        lines.push(`Diagnostic: ${value.status.diagnostic.class} — ${value.status.diagnostic.detail}`)
      }
      for (const warning of value.status.capabilityWarnings ?? []) lines.push(`Capability warning: ${managerCapabilityWarningText(warning)}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('member_state requires an Agent session')
    const host = service(agent)
    const args = blankToAbsent(rawArgs, ['workspaceId', 'requestId'])
    const action = args.action as 'suspend' | 'resume' | 'archive' | 'recover'
    if (action === 'recover' && args.workspaceId === undefined) {
      throw new Error('member_state recover needs workspaceId: the Host verifies the Member participates in that Workspace before it repairs the runtime.')
    }
    if (action !== 'recover' && args.workspaceId !== undefined) {
      throw new Error("member_state takes workspaceId only with recover; suspend, resume and archive address the Member alone.")
    }
    const result = await host.managerSetMemberStateForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      memberRef: args.memberRef as AgentTeamMemberId,
      action,
      ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId as WorkspaceId }),
    })
    return {
      requestId: result.requestId, action: result.action, outcome: result.outcome,
      ...(result.receipt === undefined ? {} : { receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt } }),
      memberRef: result.memberRef,
      status: managerStatusView(result.status),
      ...(result.releasedClaims === undefined ? {} : { releasedClaims: result.releasedClaims }),
      ...(result.removedAttention === undefined ? {} : { removedAttention: result.removedAttention }),
    }
  },
})

const MEMBER_WORKSPACE_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  requestId: { type: 'string', required: true }, outcome: { type: 'string', required: true },
  receipt: { ...MANAGER_RECEIPT_SCHEMA, required: true },
  memberRef: { type: 'string', required: true }, workspaceId: { type: 'string', required: true },
  workspaceIds: { type: 'array', required: true, items: { type: 'string' } },
  releasedClaims: { type: 'number' }, removedAttention: { type: 'number' },
} } as const

/**
 * Change one Member's Workspace participation as the manager. Joining is the
 * same pure relation the Web Client grants — no Session is created or moved —
 * and leaving the creation Workspace is the ledger's own refusal, which points
 * at archival instead.
 */
const memberWorkspace = defineTool({
  name: 'member_workspace',
  description: "Change one Agent Member's Workspace participation as the Team manager. 'join' grants participation in another Workspace as a pure relation — the Member's Session is not created, copied, or moved, and it keeps working from its original checkout; the grant itself is what lets the Member be addressed there. 'leave' withdraws one non-default Workspace: its active Claims there release, its Attention and markers on those Threads clear, while identity, Session, and remaining participations stay. The creation Workspace cannot be left — archive the Member instead — and a Member that is inactive or archived is refused with its reason. Every write carries a requestId with the same replay rule as member_create. Only the live Team manager Session holds this tool.",
  parameters: {
    action: { type: 'string', required: true, enum: ['join', 'leave'], description: "The participation change to make: 'join' adds a Workspace, 'leave' withdraws one." },
    workspaceId: { type: 'string', required: true, description: "The Workspace id to join or leave, exactly as team_overview listed it. Leaving the Member's creation Workspace is refused." },
    memberRef: { type: 'string', required: true, description: "Full branded Member ref exactly as team_overview returned it, including the 'member:' prefix." },
    requestId: { type: 'string', description: 'Your own idempotency key for this write, with the same replay rule as member_create.' },
  },
  output: { schema: MEMBER_WORKSPACE_SCHEMA,
    render: (_args, value) => {
      const lines = [value.workspaceIds.length === 0
        ? `Member ${value.memberRef} now participates in no Workspace`
        : `Member ${value.memberRef} participates in ${value.workspaceIds.join(', ')}`]
      lines.push(`Receipt ${value.receipt.operationId} (sequence ${value.receipt.sequence})`)
      if (value.releasedClaims !== undefined || value.removedAttention !== undefined) {
        lines.push(`${value.releasedClaims ?? 0} active Claim(s) released · ${value.removedAttention ?? 0} Attention row(s) cleared in ${value.workspaceId}`)
      }
      lines.push('Its Session did not move: participation is a ledger relation, not a Session copy.')
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(rawArgs, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('member_workspace requires an Agent session')
    const host = service(agent)
    const args = blankToAbsent(rawArgs, ['requestId'])
    const result = await host.managerChangeMemberWorkspaceForAgent(agent, {
      requestId: (args.requestId as AgentTeamRequestId | undefined) ?? requestId(agent.id, exec.callId),
      action: args.action as 'join' | 'leave',
      memberRef: args.memberRef as AgentTeamMemberId,
      workspaceId: args.workspaceId as WorkspaceId,
    })
    return {
      requestId: result.requestId, outcome: result.outcome,
      receipt: { operationId: result.receipt.operationId, requestId: result.receipt.requestId, sequence: result.receipt.sequence, occurredAt: result.receipt.occurredAt },
      memberRef: result.memberRef, workspaceId: result.workspaceId, workspaceIds: [...result.workspaceIds],
      ...(result.releasedClaims === undefined ? {} : { releasedClaims: result.releasedClaims }),
      ...(result.removedAttention === undefined ? {} : { removedAttention: result.removedAttention }),
    }
  },
})


const REMINDER_VIEW_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  reminderRef: { type: 'string', required: true }, state: { type: 'string', required: true },
  schedule: { type: 'string', required: true }, note: { type: 'string', required: true }, createdAt: { type: 'string', required: true },
  lastOccurrenceAt: { type: 'string' }, pendingOccurrenceAt: { type: 'string' }, nextOccurrenceAt: { type: 'string' },
} } as const

/**
 * A Member reminder is a time promise the Member makes to itself. It is the one
 * Team surface with no other audience: creation is self-only by construction, and
 * the occurrence reaches the same private Inbox notice every other unread fact
 * travels on, so a reminder never needs a Thread, a Project, or a write token.
 */
const teamReminder = defineTool({
  name: 'team_reminder',
  description: `Create, list, or cancel a reminder for yourself. A reminder is a time promise bound to you as a Member, not to a Session: when it comes due it reaches your Team Inbox as a private notice and wakes you, and the Host records it consumed once it enters one of your turns. create takes scheduleKind with that kind's own fields: 'once' with \`at\` (an ISO 8601 instant), 'every' with \`minutes\` (a whole number, at least 10), or 'cron' with \`expression\` (five fields: minute hour day-of-month month day-of-week) read in the fixed Team zone UTC+8, which has no daylight-saving component. Every create also takes \`note\`: what the reminder is for, at most 2000 characters. At most 50 reminders may be active for you at once, and a recurring reminder never fires closer than 10 minutes. list reports every reminder you own with its state and occurrence facts; cancel withdraws one by reminderRef. You can only create reminders for yourself and only cancel your own. While your Member is suspended your reminders keep timing and deliver when it resumes; when it is archived or removed they are all cancelled. An occurrence missed while the Host was down is made up exactly once after recovery, and an unread occurrence of the same recurring reminder is replaced by the next one instead of stacking.`,
  parameters: {
    action: { type: 'string', required: true, enum: ['create', 'list', 'cancel'] },
    scheduleKind: { type: 'string', enum: ['once', 'every', 'cron'], description: "create only: 'once' for a single instant, 'every' for a fixed interval, or 'cron' for a five-field expression." },
    at: { type: 'string', description: "create with scheduleKind 'once' only: the instant to fire at, as ISO 8601 (for example 2026-11-04T02:00:00.000Z)." },
    minutes: { type: 'number', description: 'create with scheduleKind \'every\' only: the whole number of minutes between two fires, at least 10.' },
    expression: { type: 'string', description: "create with scheduleKind 'cron' only: five whitespace-separated fields (minute hour day-of-month month day-of-week), read in the fixed Team zone UTC+8." },
    note: { type: 'string', description: 'create only: what this reminder is for, at most 2000 characters. It is handed back to you when the occurrence fires.' },
    reminderRef: { type: 'string', description: "cancel only: the full branded ref of one of your own reminders, exactly as list or a create returned it (for example reminder:0f0a…)." },
    workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', required: true }, workspaceId: { type: 'string', required: true },
      created: { type: 'boolean', required: true }, cancelled: { type: 'boolean', required: true },
      activeCount: { type: 'number', required: true },
      reminders: { type: 'array', required: true, items: REMINDER_VIEW_SCHEMA },
    } },
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
  },
  async execute(rawArgs, exec) {
    // `note` is content, but an empty one names nothing: on create it must reach the
    // "needs note" refusal, and on list or cancel it must not read as a create's note.
    const args = blankToAbsent(rawArgs, [...OPTIONAL_ADDRESS_KEYS, ...OPTIONAL_SCHEDULE_KEYS, 'note'])
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_reminder requires an Agent session')
    const host = service(agent)
    const workspaceId = workspaceOf(args, agent)
    if (args.action === 'create') {
      // `reminderRef` is the Host's identity for a reminder that already exists; a create
      // carrying one would be a cancel wearing a create's clothes, so it is refused rather
      // than dropped into a request whose ref the tool derives itself.
      if (args.reminderRef !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'create', parameter: 'reminderRef', owner: 'cancel' }))
      if (args.note === undefined) throw new Error(`team_reminder create needs \`note\`, what this reminder is for — ${recoveryFor('reminder_note_required').sentence({})}`)
      const result = await host.createMemberReminderForAgent(agent, { requestId: requestId(agent.id, exec.callId), workspaceId,
        reminderRef: reminderRefForCallId(exec.callId), schedule: reminderScheduleOf(args), note: args.note })
      return reminderResult('create', workspaceId, [{ reminder: result.reminder }], result.activeCount)
    }
    if (args.action === 'cancel') {
      if (args.reminderRef === undefined) throw new Error(`team_reminder cancel needs reminderRef, one of your own reminders — ${recoveryFor('reminder_ref_required').sentence({})}`)
      // Real schedule content must never disappear just because the default selector is tolerated.
      refuseNonDefaultScheduleKind('cancel', args.scheduleKind)
      for (const parameter of CREATE_ONLY_REMINDER_CONTENT_KEYS) {
        if (args[parameter] !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'cancel', parameter, owner: 'create' }))
      }
      const result = await host.cancelMemberReminderForAgent(agent, { requestId: requestId(agent.id, exec.callId), workspaceId,
        reminderRef: args.reminderRef as AgentTeamReminderRef })
      const activeCount = host.memberRemindersForAgent(agent, { workspaceId }).filter(view => view.reminder.state === 'active').length
      return reminderResult('cancel', workspaceId, [{ reminder: result.reminder }], activeCount)
    }
    // A list reads; it writes nothing, so every write-only slot is a mis-send rather than a default.
    if (args.reminderRef !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'list', parameter: 'reminderRef', owner: 'cancel' }))
    refuseNonDefaultScheduleKind('list', args.scheduleKind)
    for (const parameter of CREATE_ONLY_REMINDER_CONTENT_KEYS) {
      if (args[parameter] !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'list', parameter, owner: 'create' }))
    }
    const reminders = host.memberRemindersForAgent(agent, { workspaceId })
    return reminderResult('list', workspaceId, reminders, reminders.filter(view => view.reminder.state === 'active').length)
  },
})

/** What a reminder action reports about each reminder it touched: the entity plus the occurrence facts a view carries. */
interface ReminderReport {
  readonly reminder: AgentTeamMemberReminder
  readonly lastOccurrenceAt?: string | undefined
  readonly pendingOccurrenceAt?: string | undefined
  readonly nextOccurrenceAt?: string | undefined
}

function reminderResult(action: 'create' | 'list' | 'cancel', workspaceId: string, reminders: readonly ReminderReport[], activeCount: number) {
  return {
    action, workspaceId, created: action === 'create', cancelled: action === 'cancel', activeCount,
    reminders: reminders.map(view => ({
      reminderRef: view.reminder.reminderRef, state: view.reminder.state, schedule: reminderScheduleText(view.reminder.schedule),
      note: view.reminder.note, createdAt: view.reminder.createdAt,
      ...(view.lastOccurrenceAt === undefined ? {} : { lastOccurrenceAt: view.lastOccurrenceAt }),
      ...(view.pendingOccurrenceAt === undefined ? {} : { pendingOccurrenceAt: view.pendingOccurrenceAt }),
      ...(view.nextOccurrenceAt === undefined ? {} : { nextOccurrenceAt: view.nextOccurrenceAt }),
    })),
  }
}

/**
 * What a stop call can honestly say about the run it addressed: only a
 * confirmed stop reports cleanup, an ending the run already had is reported as
 * that ending, and the Host's own diagnostic rides along when it has one.
 */
function stopReceipt(state: string, diagnostic: string | undefined): string {
  const caveat = diagnostic === undefined ? [] : [diagnostic]
  if (state === 'stopped') {
    return ['The engine confirmed this run\'s cleanup, so it is no longer running. '
      + 'Its ending appears in the Thread it reports into, if it has one.', ...caveat].join('\n')
  }
  if (state === 'completed' || state === 'failed') {
    return [`The run ended as ${state}; this stop did not change its ending.`, ...caveat].join('\n')
  }
  return [`The run is ${state}.`, ...caveat].join('\n')
}

/**
 * What a steer call can honestly say: the native session accepted the input for
 * this execution, or a linked execution started by resuming that same native
 * session. Neither receipt claims the model has read it.
 */
function steerReceipt(value: { readonly state: string; readonly workerRef: string; readonly landed?: string | undefined
  readonly turnId?: string | undefined
  readonly continuedFrom?: string | undefined; readonly runState?: string | undefined }): string {
  if (value.state === 'started') {
    return [
      `The previous execution ${value.continuedFrom ?? ''} had ended, so this instruction started a new execution in the same native session.`,
      `New Worker: ${value.workerRef}`,
      ...(value.runState === undefined
        ? [`The receipt does not record the run state; inspect Worker ${value.workerRef} for its current ending.`]
        : [`When this receipt was written, that run was ${value.runState}.`]),
      'The instruction is submitted, not confirmed read.',
    ].join('\n')
  }
  return [
    'The native session accepted the instruction into this execution. It may join the running turn or be queued for its next turn in the same native session.',
    ...(value.landed === undefined ? [] : [`Delivery: ${value.landed}.`]),
    ...(value.turnId === undefined ? [] : [`Turn: ${value.turnId}`]),
    'It is submitted, not confirmed read: the receipt does not promise which model request consumes it.',
    ...(value.runState === undefined || value.runState === 'running' ? []
      : [`By the time this answer was written the run was ${value.runState}, so the instruction may never have been read.`]),
  ].join('\n')
}

/** Keep native identities whole while bounding their share of the diagnostic. */
function workerIdentityList(ids: readonly string[]): string {
  const shown: string[] = []
  let length = 0
  for (const id of ids) {
    const next = length + id.length + (shown.length === 0 ? 0 : 2)
    if (next > 2_048) break
    shown.push(id)
    length = next
  }
  const omitted = ids.length - shown.length
  return shown.join(', ') + (omitted === 0 ? '' : ` … (${omitted} retained ids omitted)`)
}

/**
 * One run's diagnostic as its initiator reads it: the summary the Thread already
 * carries, the native identities the Host recorded, and the bounded fragments the
 * engine's own record still answers — or the reason it cannot.
 */
function inspectionReport(value: {
  readonly workerRef: string; readonly state: string; readonly engine?: string | undefined
  readonly projectRef?: string | undefined; readonly threadRef?: string | undefined
  readonly startedAt?: string | undefined; readonly settledAt?: string | undefined
  readonly summary?: string | undefined; readonly stage?: string | undefined
  readonly nativeThreadId?: string | undefined; readonly nativeTurnId?: string | undefined
  readonly nativeTurnIds?: readonly string[] | undefined; readonly nativeInputIds?: readonly string[] | undefined
  readonly nativeStorage?: string | undefined; readonly nativeRecord?: string | undefined
  readonly nativeReason?: string | undefined; readonly nativeWithheld?: number | undefined
  readonly nativeTruncated?: boolean | undefined
  readonly nativeFragments?: readonly { readonly kind: string; readonly text: string }[] | undefined
}): string {
  const lines = [
    `Worker ${value.workerRef} · ${value.engine ?? 'Worker'} · ${value.state}`,
    ...(value.projectRef === undefined ? [] : [`Project: ${value.projectRef}`]),
    ...(value.threadRef === undefined ? [] : [`Thread: ${value.threadRef}`]),
    ...(value.startedAt === undefined ? [] : [`Started at: ${formatTeamTimestamp(value.startedAt)}`]),
    ...(value.settledAt === undefined ? [] : [`Ended at: ${formatTeamTimestamp(value.settledAt)}`]),
    `Summary: ${value.summary ?? 'none recorded'}`,
    ...(value.stage === undefined ? [] : [`Failed at: ${value.stage}`]),
    ...(value.nativeThreadId === undefined ? [] : [`Native thread: ${value.nativeThreadId}`]),
    ...(value.nativeTurnId === undefined ? [] : [`Native turn: ${value.nativeTurnId}`]),
    ...(value.nativeTurnIds === undefined ? [] : [`Native turns: ${workerIdentityList(value.nativeTurnIds)}`]),
    ...(value.nativeInputIds === undefined ? [] : [`Native inputs: ${workerIdentityList(value.nativeInputIds)}`]),
    ...(value.nativeStorage === undefined ? [] : [`Native record: ${value.nativeStorage}`]),
  ]
  if (value.nativeRecord !== 'read') {
    lines.push(`No native fragment to show: ${value.nativeReason ?? 'the engine named no record this Team reads.'}`)
    return lines.join('\n')
  }
  const fragments = value.nativeFragments ?? []
  lines.push(fragments.length === 0
    ? 'The engine\'s record holds nothing this Team reads for that turn.'
    : 'The engine\'s own record:')
  for (const fragment of fragments) lines.push(`- ${fragment.kind}: ${fragment.text}`)
  if (value.nativeWithheld !== undefined) lines.push(`(${value.nativeWithheld} fragment(s) withheld: their text looks like a credential.)`)
  if (value.nativeTruncated === true) lines.push('(The native-history read or its fragment limit omitted content.)')
  return lines.join('\n')
}

/** Empty selectors must disappear before choosing a Worker action; real values still conflict. */
const WORKER_BLANK_KEYS = [...OPTIONAL_ADDRESS_KEYS, 'task', 'stop', 'inspect', 'steer', 'instruction', 'cwd', 'requestId'] as const

/** A control call may carry the first enum value as a neutral fill, but no other engine. */
function namesAnotherEngine(args: { readonly engine?: string | undefined }): boolean {
  return args.engine !== undefined && args.engine !== 'codex'
}

/**
 * The one delegation entry. A run bound to a Thread reports into it and wakes
 * this Member through the Inbox; an unbound Project delegation keeps the direct
 * result in this session. Neither creates a Task or a Main stream post, and the
 * Worker holds no Team identity of its own.
 */
const teamWorker = defineTool({
  name: 'team_worker',
  description: `Delegate one self-contained piece of work to a local Worker engine (Codex or Claude Code) that runs with its own tools, login, and settings, or steer, stop, or inspect a Worker this session delegated. Use it for work you can hand over completely: investigation, a scoped change in a prepared working directory, or a check that needs another engine. The Worker does not see this conversation, holds no Team identity, and cannot claim, accept, or answer for you, so the task text must carry the goal, the background, the scope, and what evidence to bring back. Name the Thread or Task the work belongs to and everything about the run is published there: the Thread shows when it started and how it ended, and its answer arrives in your Inbox — the other participants never see the raw output. Name only a Project and the result comes back to this session alone, published nowhere. The call returns as soon as the execution is accepted; keep working and do not poll. A Worker affects Project responsibility in no way: if you delegate work on a Task, the Claim stays yours and you still verify the result yourself, and a finished run never accepts a Task. Delegation needs the Team setting "allow Project owners to delegate Workers", your ownership of the Project the target belongs to, and an enabled engine; a refusal names which condition failed. To add one instruction, pass the original worker ref as steer with the instruction. A running Codex or Claude execution takes it into the same native session, possibly in its current turn or its next turn. If that execution has ended cleanly, steer resumes the same native conversation as one new linked execution; the receipt returns its new worker ref and says that a continuation started. A stopping execution, an unconfirmed ending, an archived or no-longer-owned Project, a disabled Member or engine setting, or a missing native record is refused instead of being revived. The receipt says submitted or continuation started, never that the model has read the instruction. To stop one execution, pass only its worker ref as stop; the call returns once the engine confirmed its cleanup, and a run that ended first answers with the state it really ended in. Another Member's run cannot be stopped this way. To read one execution's diagnostic, pass only its worker ref as inspect: the call answers with the same summary the Thread carries, the native identities the Host recorded, and whatever the engine's own record still answers after its process exited. The native record itself is never copied into the Team, and only the Member who delegated the run or the Human may read it.`,
  parameters: {
    threadRef: { type: 'string', description: 'The Thread this work reports into, as a thread: ref. The run\'s start, ending, and Inbox wake all point at it. Its Project authorizes the delegation.' },
    taskRef: { type: 'string', description: 'The Task this work is for, as a task: ref. It fixes the Thread as well; naming a Thread and a Task together is accepted only when the Task is in that Thread.' },
    projectRef: { type: 'string', description: 'The Project to delegate into, as a project: ref from team_view. Omit whenever threadRef or taskRef already names it; with none of the three there is no target to authorize.' },
    task: { type: 'string', description: 'The complete task for the Worker: goal, background it needs, working scope, and the evidence to return. It cannot ask you follow-up questions. Required unless stop names a run to end.' },
    stop: { type: 'string', description: 'A worker: ref this session delegated. With this the call stops that execution instead of starting one: pass it alone, with no task, target, engine, directory, or request id.' },
    inspect: { type: 'string', description: 'A worker: ref this session delegated. With this the call reads that execution\'s diagnostic instead of starting or stopping one: pass it alone, with no task, target, engine, directory, or request id. A run that has not ended answers with the summary alone.' },
    steer: { type: 'string', description: 'A worker: ref this session delegated. With this the call adds one instruction in that Worker\'s same native session: pass it with instruction, and with no task, target, engine, directory, stop, or inspect. A running execution may take it in the current turn or its next turn. An ended execution that ended cleanly is resumed as a new linked execution and the receipt returns its new worker ref.' },
    instruction: { type: 'string', description: 'The one instruction to submit with steer. It is deduplicated per execution while it is pending, submitted, or has an unknown delivery outcome. An explicit native refusal did not deliver it, so the same text may be retried under a fresh request id, and a later linked execution may receive it under a fresh id.' },
    engine: { type: 'string', enum: ['codex', 'claude'], description: 'Engine to run. Omit for the Project default the Host settings name.' },
    cwd: { type: 'string', description: 'Absolute working directory the Worker runs in. Omit to use this session\'s own directory.' },
    requestId: { type: 'string', description: 'Optional idempotency key for a start or steer: resending the same value with the same request returns the execution or receipt the first call produced, even when both calls arrive at once. A changed instruction, or a resend from another Member, is refused rather than applied to a run it did not ask for.' },
    workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      workerRef: { type: 'string', required: true }, state: { type: 'string', required: true },
      continuedFrom: { type: 'string' },
      landed: { type: 'string' },
      mode: { type: 'string' },
      projectRef: { type: 'string' }, engine: { type: 'string' },
      cwd: { type: 'string' }, startedAt: { type: 'string' }, settledAt: { type: 'string' },
      threadRef: { type: 'string' }, diagnostic: { type: 'string' },
      summary: { type: 'string' }, stage: { type: 'string' },
      nativeThreadId: { type: 'string' }, nativeTurnId: { type: 'string' },
      nativeTurnIds: { type: 'array', items: { type: 'string' } },
      nativeInputIds: { type: 'array', items: { type: 'string' } },
      nativeStorage: { type: 'string' },
      nativeRecord: { type: 'string' }, nativeReason: { type: 'string' },
      turnId: { type: 'string' }, runState: { type: 'string' },
      nativeWithheld: { type: 'number' }, nativeTruncated: { type: 'boolean' },
      nativeFragments: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true }, text: { type: 'string', required: true } } } },
    } },
    render: (_args, value) => [{
      type: 'text',
      text: value.mode === 'inspect' ? inspectionReport(value)
        : value.mode === 'steer' ? steerReceipt(value) : [
        `Worker ${value.workerRef} · ${value.engine ?? 'Worker'} · ${value.state}`,
        ...(value.projectRef === undefined ? [] : [`Project: ${value.projectRef}`]),
        ...(value.threadRef === undefined ? [] : [`Thread: ${value.threadRef} — the run's start, ending, and answer report there`]),
        ...(value.cwd === undefined ? [] : [`Working directory: ${value.cwd}`]),
        ...(value.startedAt === undefined ? [] : [`Started at: ${formatTeamTimestamp(value.startedAt)}`]),
        ...(value.settledAt === undefined ? [] : [`Ended at: ${formatTeamTimestamp(value.settledAt)}`]),
        value.startedAt === undefined
          ? stopReceipt(value.state, value.diagnostic)
          : value.threadRef === undefined
            ? 'The execution runs in the background and reports back to this session when it ends. Keep working; there is nothing to poll.'
            : 'The execution runs in the background. Its ending appears in that Thread and its answer reaches your Inbox; keep working, there is nothing to poll.',
      ].join('\n'),
    }],
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, WORKER_BLANK_KEYS)
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_worker requires an Agent session')
    const host = service(agent)
    if (args.stop !== undefined && args.inspect !== undefined) {
      throw new Error('team_worker takes one worker ref at a time: pass stop or inspect, not both.')
    }
    if (args.steer !== undefined && (args.stop !== undefined || args.inspect !== undefined)) {
      throw new Error('team_worker takes one worker ref at a time: pass steer, stop, or inspect — never two of them.')
    }
    if (args.inspect !== undefined) {
      // Reading a diagnostic is its own call: it names one run and nothing else,
      // so a half-filled start can never be read as a look-up.
      if (args.task !== undefined || args.threadRef !== undefined || args.taskRef !== undefined
        || args.projectRef !== undefined || namesAnotherEngine(args) || args.cwd !== undefined
        || args.requestId !== undefined || args.steer !== undefined || args.instruction !== undefined) {
        throw new Error('team_worker takes either a task to start or an inspect ref, not both: pass inspect alone.')
      }
      const inspection = await host.workerInspectForAgent(agent, { workerRef: args.inspect as Parameters<typeof host.workerInspectForAgent>[1]['workerRef'] })
      return {
        mode: 'inspect', workerRef: inspection.workerRef, state: inspection.state, engine: inspection.engine,
        projectRef: inspection.projectRef,
        ...(inspection.threadRef === undefined ? {} : { threadRef: inspection.threadRef }),
        ...(inspection.startedAt === undefined ? {} : { startedAt: inspection.startedAt }),
        ...(inspection.settledAt === undefined ? {} : { settledAt: inspection.settledAt }),
        summary: inspection.summary,
        ...(inspection.stage === undefined ? {} : { stage: inspection.stage }),
        ...(inspection.native.threadId === undefined ? {} : { nativeThreadId: inspection.native.threadId }),
        ...(inspection.native.turnId === undefined ? {} : { nativeTurnId: inspection.native.turnId }),
        ...(inspection.native.turnIds === undefined ? {} : { nativeTurnIds: [...inspection.native.turnIds] }),
        ...(inspection.native.inputIds === undefined ? {} : { nativeInputIds: [...inspection.native.inputIds] }),
        ...(inspection.native.storage === undefined ? {} : { nativeStorage: inspection.native.storage }),
        nativeRecord: inspection.history.kind,
        ...inspection.history.kind !== 'read' ? { nativeReason: inspection.history.reason } : {
          ...(inspection.history.fragments.length === 0 ? {} : {
            nativeFragments: inspection.history.fragments.map(fragment => ({ kind: fragment.kind, text: fragment.text })) }),
          ...(inspection.history.withheld === 0 ? {} : { nativeWithheld: inspection.history.withheld }),
          ...(inspection.history.truncated ? { nativeTruncated: true } : {}),
        },
      }
    }
    if (args.steer !== undefined) {
      // A steer names one run and one instruction, and nothing else: a
      // half-filled start must never be read as a steer to a live native session.
      if (args.task !== undefined || args.threadRef !== undefined || args.taskRef !== undefined
        || args.projectRef !== undefined || namesAnotherEngine(args) || args.cwd !== undefined
        || args.stop !== undefined || args.inspect !== undefined) {
        throw new Error('team_worker takes either a task to start, a stop ref, an inspect ref, or a steer ref with its instruction: pass steer alone with instruction.')
      }
      if (args.instruction === undefined || args.instruction.trim() === '') {
        throw new Error('team_worker needs the instruction to add when steer names a run: pass steer with instruction.')
      }
      const steered = await host.workerSteerForAgent(agent, {
        workerRef: args.steer as Parameters<typeof host.workerSteerForAgent>[1]['workerRef'],
        instruction: args.instruction,
        requestId: (args.requestId ?? requestId(agent.id, exec.callId)) as Parameters<typeof host.workerSteerForAgent>[1]['requestId'],
      })
      return {
        mode: 'steer', workerRef: steered.workerRef, state: steered.state, engine: steered.engine,
        ...(steered.continuedFrom === undefined ? {} : { continuedFrom: steered.continuedFrom }),
        ...(steered.landed === undefined ? {} : { landed: steered.landed }),
        ...(steered.turnId === undefined ? {} : { turnId: steered.turnId }),
        runState: steered.runState,
      }
    }
    if (args.instruction !== undefined && args.steer === undefined) {
      throw new Error('team_worker takes instruction only with steer: name the Worker execution whose native session should take it.')
    }
    if (args.stop !== undefined) {
      // Starting and stopping are different calls: a stop names one run and
      // nothing else, so a half-filled start can never be read as a stop.
      if (args.task !== undefined || args.threadRef !== undefined || args.taskRef !== undefined
        || args.projectRef !== undefined || namesAnotherEngine(args) || args.cwd !== undefined
        || args.requestId !== undefined || args.steer !== undefined || args.instruction !== undefined) {
        throw new Error('team_worker takes either a task to start or a stop ref, not both: pass stop alone.')
      }
      const stopped = await host.workerStopForAgent(agent, { workerRef: args.stop as Parameters<typeof host.workerStopForAgent>[1]['workerRef'] })
      return {
        workerRef: stopped.workerRef, state: stopped.state, engine: stopped.engine,
        ...(stopped.settledAt === undefined ? {} : { settledAt: stopped.settledAt }),
        // The Host's own sentence about a failure rides the receipt: a state
        // alone would drop the cleanup warning the model has to act on.
        ...(stopped.diagnostic === undefined ? {} : { diagnostic: stopped.diagnostic }),
      }
    }
    if (args.task === undefined || args.task.trim() === '') {
      throw new Error('team_worker needs a task to start a Worker, or a stop ref to end one.')
    }
    const request = {
      requestId: (args.requestId ?? requestId(agent.id, exec.callId)) as Parameters<typeof host.workerStartForAgent>[1]['requestId'],
      task: args.task,
      ...(args.projectRef === undefined ? {} : { projectRef: projectRefOf(args.projectRef) as Parameters<typeof host.workerStartForAgent>[1]['projectRef'] }),
      ...(args.threadRef === undefined ? {} : { threadRef: args.threadRef as NonNullable<Parameters<typeof host.workerStartForAgent>[1]['threadRef']> }),
      ...(args.taskRef === undefined ? {} : { taskRef: args.taskRef as NonNullable<Parameters<typeof host.workerStartForAgent>[1]['taskRef']> }),
      ...(args.engine === undefined ? {} : { engine: args.engine as 'codex' | 'claude' }),
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
    }
    const run = await host.workerStartForAgent(agent, request)
    return {
      workerRef: run.workerRef, projectRef: run.projectRef, engine: run.engine,
      state: run.state, cwd: run.cwd, startedAt: run.startedAt,
      ...(run.threadRef === undefined ? {} : { threadRef: run.threadRef }),
    }
  },
})

/**
 * Plugin configuration: which model-facing Team tools this preset scope mounts.
 *
 * The model's visible tool list is read from the registering scope's own schemas, so a narrower surface is only real when the narrower set is what gets declared: a tool registered here and hidden later is still listed to the model, and a tool refused in its handler is still spent on before it fails. Declaring the exact subset is therefore the only narrowing that holds.
 */
export interface Config {
  /**
   * Restrict registration to these tool names, matched exactly. Omitted registers all 19 Team tools; the `team-member` and `team-manager` presets each provide their own explicit whitelist. An unknown name is refused rather than skipped: a typo would otherwise mount an empty surface and surface only as a Session that cannot act.
   */
  only?: readonly string[]
}

export function apply(ctx: Context, config: Config = {}): void {
  const tools = [
    teamInbox, teamReminder, teamThread, teamAttention, teamMessage, teamDm,
    teamTask, teamView, teamOverview, teamModels, teamSubscription, teamWorker,
    memberCreate, projectCreate, projectOwner, projectUpdate, memberUpdate, memberState, memberWorkspace,
  ]
  if (config.only === undefined) {
    for (const tool of tools) ctx.tools.register(tool)
    return
  }
  const selected = new Set(config.only)
  for (const name of selected) {
    if (!tools.some(tool => tool.name === name)) {
      throw new Error(`team-tools config names an unknown Team tool: ${name}`)
    }
  }
  for (const tool of tools) {
    if (selected.has(tool.name)) ctx.tools.register(tool)
  }
}
