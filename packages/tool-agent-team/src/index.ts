import type { Context } from '@deepseek-ai/cordis'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamDmDeliveryError, markAgentTeamPreset } from '@contexera/dsh-agent-team/host'
import { formatTeamTimestamp } from '@contexera/dsh-agent-team/time-format'
import { projectRefOf, service, workspaceOf, workspaceParam } from './host-access.ts'
import { recoveryFor } from '@contexera/dsh-agent-team/recovery-hints'
import type {
  AgentTeamClaimRef,
  AgentTeamInboxReminder,
  AgentTeamMemberId,
  AgentTeamRequestId,
  AgentTeamMessageRef,
  AgentTeamProjectRef,
  AgentTeamTaskRef,
  AgentTeamTaskBoardItem,
  AgentTeamThreadFact,
  AgentTeamThreadRef,
  AgentTeamThreadTaskCard,
} from '@contexera/dsh-agent-team/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MAIN_ENTRY_SCHEMA, MAIN_STANDING_SCHEMA, mainEntryLine, mainEntryView, standingView } from './main-stream.ts'
import type { MainEntryView } from './main-stream.ts'

export const name = 'wowyuarm-agent-team-tools'
export const inject = ['tools']

/** One shared bound for every bounded anchor subject a render shows. */
const SUBJECT_BOUND = 80

/** Model-facing view of one structured Thread activity fact, shared by read and history. */
interface ActivityFactView {
  readonly sequence: number
  readonly kind: 'activity'
  readonly activity: string
  readonly actor: string
  readonly taskRef: string
  readonly occurredAt?: string
  readonly claimRef?: string
  readonly claimRefs?: string[]
  readonly completedClaimRefs?: string[]
  readonly acceptedClaimRefs?: string[]
  readonly releasedClaimRefs?: string[]
  readonly unread?: boolean
  readonly direct?: boolean
}

/** Model-facing view of one message fact. */
interface MessageFactView {
  readonly sequence: number
  readonly kind: 'message'
  readonly body: string
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

function activityFactView(
  sequence: number,
  activity: { readonly kind: string; readonly actor: string; readonly taskRef: AgentTeamTaskRef
    readonly claimRef?: AgentTeamClaimRef | undefined; readonly claimRefs?: readonly AgentTeamClaimRef[] | undefined
    readonly completedClaimRefs?: readonly AgentTeamClaimRef[] | undefined; readonly acceptedClaimRefs?: readonly AgentTeamClaimRef[] | undefined
    readonly releasedClaimRefs?: readonly AgentTeamClaimRef[] | undefined },
  markers?: { readonly unread: boolean; readonly direct: boolean } | undefined,
  occurredAt?: string | undefined,
): ActivityFactView {
  return {
    sequence, kind: 'activity', activity: activity.kind, actor: activity.actor, taskRef: activity.taskRef,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(activity.claimRef === undefined ? {} : { claimRef: activity.claimRef }),
    ...(activity.claimRefs === undefined || activity.claimRefs.length === 0 ? {} : { claimRefs: [...activity.claimRefs] }),
    ...(activity.completedClaimRefs === undefined || activity.completedClaimRefs.length === 0 ? {} : { completedClaimRefs: [...activity.completedClaimRefs] }),
    ...(activity.acceptedClaimRefs === undefined || activity.acceptedClaimRefs.length === 0 ? {} : { acceptedClaimRefs: [...activity.acceptedClaimRefs] }),
    ...(activity.releasedClaimRefs === undefined || activity.releasedClaimRefs.length === 0 ? {} : { releasedClaimRefs: [...activity.releasedClaimRefs] }),
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

/** Render one structured activity fact as a self-describing decision-surface line. */
function activityLine(fact: ActivityFactView): string {
  const segments = [`${fact.sequence}`, fact.actor, fact.activity]
  segments.push(`Task ${fact.taskRef}`)
  if (fact.claimRef !== undefined) segments.push(`Claim ${fact.claimRef}`)
  if (fact.claimRefs !== undefined) segments.push(`claims released ${fact.claimRefs.join(', ')}`)
  if (fact.completedClaimRefs !== undefined) segments.push(`completed claims ${fact.completedClaimRefs.join(', ')}`)
  if (fact.acceptedClaimRefs !== undefined) segments.push(`accepted claims ${fact.acceptedClaimRefs.join(', ')}`)
  if (fact.releasedClaimRefs !== undefined) segments.push(`released claims ${fact.releasedClaimRefs.join(', ')}`)
  return segments.join(' ')
}

/** The one hand-off line a fully drained read or a committed public mutation may render. */
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
    occurredAt: card.newestOccurredAt, subject: card.anchor.preview, status: card.task.status, resolution: card.task.resolution,
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
    sequence: { type: 'number', required: true }, kind: { type: 'string', required: true }, body: { type: 'string' }, sender: { type: 'string' }, occurredAt: { type: 'string' }, mentions: { type: 'array', items: { type: 'string' } }, replyToMessageRef: { type: 'string' }, replyTo: { type: 'object', additionalProperties: false, properties: { sender: { type: 'string', required: true }, excerpt: { type: 'string', required: true } } }, activity: { type: 'string' }, actor: { type: 'string' }, taskRef: { type: 'string' }, claimRef: { type: 'string' }, claimRefs: { type: 'array', items: { type: 'string' } }, completedClaimRefs: { type: 'array', items: { type: 'string' } }, acceptedClaimRefs: { type: 'array', items: { type: 'string' } }, releasedClaimRefs: { type: 'array', items: { type: 'string' } }, unread: { type: 'boolean' }, direct: { type: 'boolean' },
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
 * address/selection parameters are normalized — `body` and `direction` are content,
 * where an empty string is a real error the tool must report, not a missing field.
 */
function blankToAbsent<T extends { readonly [key: string]: unknown }>(args: T, keys: readonly string[]): T {
  const copy: Record<string, unknown> = { ...args }
  for (const key of keys) {
    const value = copy[key]
    if (value === '' || value === 0 || value === false) delete copy[key]
  }
  return copy as T
}

/** The address/selection parameters every Team tool treats as optional presence. */
const OPTIONAL_ADDRESS_KEYS = ['projectRef', 'threadRef', 'taskRef', 'messageRef', 'replyToMessageRef',
  'claimRef', 'memberRef', 'accountable', 'target', 'beforeSequence', 'limit', 'cursor', 'mine', 'baseRevision'] as const

/** One fact as a rejection render receives it: the read fields with tag fields widened to plain strings, because the tool's output schema types `kind` as a string rather than a literal union. */
type RejectedFact = {
  readonly sequence: number
  readonly kind: string
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

/** The typed-rejection renderer shared by team_message and team_task: outcome, action-local recovery facts, the facts that gated the write, and the single recovery route. The current revision is written back as the next write token, so a rejected writer needs no separate read round-trip. */
function rejectionLines(
  value: { readonly kind: string; readonly threadRef?: string; readonly taskRef?: string; readonly unreadCount?: number; readonly directCount?: number; readonly memberIds?: string[]; readonly revision?: number; readonly staleTokenKind?: 'unknown' | 'unrecognized'; readonly facts?: readonly RejectedFact[] },
): string[] {
  const identity = [
    value.threadRef === undefined ? '' : value.threadRef,
    value.taskRef === undefined ? '' : value.taskRef,
  ].filter(part => part !== '').join(' · ')
  if (value.kind === 'unread_required') {
    const facts = value.facts ?? []
    return [
      'Not committed — unread_required.',
      `${identity}${identity === '' ? '' : ' · '}${value.unreadCount ?? 0} unread, ${value.directCount ?? 0} direct`,
      ...rejectedFactLines(facts),
      recoveryFor('unread_required').sentence({ threadRef: value.threadRef, taskRef: value.taskRef }),
      ...(value.revision === undefined ? [] : [nextWriteLine(value.revision)]),
    ]
  }
  if (value.kind === 'stale_revision') {
    const facts = value.facts ?? []
        // A token this Thread never reached is not a race (it was copied from another Thread or invented), so the way out and the headline say that instead of claiming the Thread changed and then saying nothing was inserted.
    const unrecognized = value.staleTokenKind === 'unrecognized'
    return [
      ...(unrecognized ? ['Not committed — that write token was never a revision this Thread reached (stale_revision).']
        : ['Not committed — the Thread changed after your last read (stale_revision).']),
      identity,
      ...(unrecognized ? [] : rejectedFactLines(facts)),
      recoveryFor(unrecognized ? 'stale_revision_token_unrecognized' : 'stale_revision')
        .sentence({ threadRef: value.threadRef, taskRef: value.taskRef }),
      ...(value.revision === undefined ? [] : [nextWriteLine(value.revision)]),
    ]
  }
  return [
    `Not committed — ${value.kind}.`,
    identity === '' ? 'No message was added.' : `${identity} — no message was added.`,
  ]
}

/** The facts a rejection carries, rendered by the same `factLine` as a Thread read. Nothing to show stays silent, and the count states the span so a truncated batch never reads as the whole increment. */
function rejectedFactLines(facts: readonly RejectedFact[]): string[] {
  if (facts.length === 0) return []
  return ['', `${facts.length} new fact(s) since your last write:`, ...facts.map(fact => factLine(fact as FactView))]
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

/** Attention (following a Thread) is a different question from reading one. `status`, `follow`, and `unfollow` take exactly the Thread address and routing Workspace; sharing a parameter pocket with read would put `messageRef`, `beforeSequence`, and `limit` in front of actions that never accept them. */
const teamAttention = defineTool({
  name: 'team_attention',
  description: `Read or change your Attention on one Thread — whether you are following it. status reports the current state and changes nothing; follow starts receiving that Thread's updates; unfollow stops them. Attention is not reading: none of these actions render the Thread's facts, acknowledge unread work, or hand off a write token, and reading a Thread never changes whether you follow it. Prefer threadRef; taskRef is a compatibility alias when the Thread has a Task.`,
  parameters: {
    action: { type: 'string', required: true, enum: ['status', 'follow', 'unfollow'] },
    threadRef: { type: 'string', description: "Full branded Thread ref exactly as returned by Team tools, including the 'thread:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    taskRef: { type: 'string', description: "Optional Task ref alias for released clients. Prefer threadRef; if both are given they must identify the same Thread." },
    workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      workspaceId: { type: 'string', required: true }, projectRef: { type: 'string', required: true },
      kind: { type: 'string', required: true }, threadRef: { type: 'string', required: true }, taskRef: { type: 'string' },
      revision: { type: 'number', required: true }, status: { type: 'string' }, resolution: { type: 'string' }, taskNumber: { type: 'number' }, accountable: { type: 'string' },
      following: { type: 'boolean', required: true },
    } },
        // Renders are the only channel a tool result reaches the model through. One outcome line plus the Attention state; a yes/no on one Thread needs no orientation, facts, or write token (a status read authorizes no mutation).
    render: (args, value) => {
      const standing = taskStanding(value)
      const source = `Workspace: ${value.workspaceId} · Project: ${value.projectRef}`
      if (value.kind === 'follow' || value.kind === 'unfollow') {
        return [{ type: 'text', text: `${source}\nAttention changed — ${value.following ? 'now following' : 'no longer following'} ${value.threadRef}${standing === '' ? '' : ` · ${standing}`}.` }]
      }
      return [{ type: 'text', text: `${source}\nAttention status — ${value.following ? 'following' : 'not following'} ${value.threadRef}${standing === '' ? '' : ` · ${standing}`}.` }]
    },
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, OPTIONAL_ADDRESS_KEYS)
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_attention requires an Agent session')
    const host = service(agent)
    if (args.threadRef === undefined && args.taskRef === undefined) throw new Error(`team_attention needs threadRef (or taskRef on a Taskful Thread) — ${recoveryFor('missing_thread_identity').sentence({})}`)
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
    return attentionResult(args.action, base.workspaceId, snapshot, result.attention, taskNumberOf(snapshot.task))
  },
})

/** The one result shape every Attention action returns: address, standing, and the state itself. */
function attentionResult(
  kind: 'status' | 'follow' | 'unfollow',
  workspaceId: string,
  snapshot: ReturnType<AgentTeam['threadHistoryForAgent']>,
  attention: Awaited<ReturnType<AgentTeam['readThreadForAgent']>>['attention'],
  task: { taskNumber?: number; accountable?: string },
): { workspaceId: string; projectRef: string; kind: string; threadRef: string; revision: number; following: boolean; taskRef?: string; status?: string; resolution?: string; taskNumber?: number; accountable?: string } {
  return {
    workspaceId, projectRef: snapshot.anchor.projectRef,
    kind, threadRef: snapshot.thread.threadRef, revision: snapshot.thread.revision,
    ...(snapshot.task === undefined ? {} : { taskRef: snapshot.task.taskRef, status: snapshot.task.status, resolution: snapshot.task.resolution, accountable: snapshot.task.accountable }),
    ...(task.taskNumber === undefined ? {} : { taskNumber: task.taskNumber }),
    following: attention !== undefined,
  }
}

const teamThread = defineTool({
  name: 'team_thread',
  description: `Read one Thread's facts, or a Project's Main stream (pass projectRef instead of threadRef — exactly one). read acknowledges one chronological batch of unread facts and is the only read-side source of a next-write token — and only once no unread remains; your own committed public mutations hand off the token as well. A read orients on the Thread anchor and that batch, never the whole Thread: a Member re-entering one it has read before gets no background at all, so the facts between are its own to page back to. history pages older facts without changing read state. message reads one Message back verbatim by ref — the way to answer a \`Replies to:\` line or a \`(replies to …)\` marker whose original sits outside the facts you have. beforeSequence and limit page history and are ignored by read, whose batch is bounded by design and names how much remains — message rejects them — ${recoveryFor('history_only_arguments').sentence({ action: 'message' })} Prefer threadRef; taskRef is a compatibility alias when the Thread has a Task. Attention — whether you follow this Thread — is team_attention, and never changes here. On the Main stream, read answers with its newest entries (plus any entry carrying a mention of you) and acknowledges through them — an owner's unread and the mentions of every Member; a backlog longer than one page is read oldest first, one page per read, until none remains; history pages older entries; Thread cards in it name the Thread to read.`,
  parameters: {
    action: { type: 'string', required: true, enum: ['read', 'history', 'message'] },
    threadRef: { type: 'string', description: "Full branded Thread ref exactly as returned by Team tools, including the 'thread:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    projectRef: { type: 'string', description: "Full branded Project ref: reads that Project's Main stream instead of a Thread. Give this or threadRef, never both." },
    taskRef: { type: 'string', description: "Optional Task ref alias for released clients. Prefer threadRef; if both are given they must identify the same Thread." },
    messageRef: { type: 'string', description: "For action `message`: the full branded Message ref to read back, exactly as rendered by this tool or by an inbox notice — including the `message:` prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    beforeSequence: { type: 'number', description: 'history only: the oldest fact sequence to page before (exclusive). message rejects it; read ignores it, since a read batch is bounded by design.' }, limit: { type: 'number', description: 'history only: max older facts to return, 1–100, default 20. message rejects it; read ignores it, since a read batch is bounded by design.' }, workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      workspaceId: { type: 'string', required: true }, projectRef: { type: 'string', required: true },
      kind: { type: 'string', required: true }, scope: { type: 'string' }, threadRef: { type: 'string' }, taskRef: { type: 'string' },
      entries: { type: 'array', items: MAIN_ENTRY_SCHEMA }, standing: MAIN_STANDING_SCHEMA,
      message: { type: 'object', additionalProperties: false, properties: {
        messageRef: { type: 'string', required: true }, sender: { type: 'string', required: true }, sequence: { type: 'number', required: true }, occurredAt: { type: 'string' }, body: { type: 'string', required: true },
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
          message.body,
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
      const acknowledged = facts.filter(fact => fact.unread === true).length + reminders.length
      const remaining = value.remainingUnreadCount ?? 0
            // A read with nothing unread writes no durable operation, so the opening line claims a commit only when unread facts were acknowledged.
      const lines = [
        source,
        acknowledged === 0
          ? `Read — no unread updates on ${value.threadRef}; nothing remains.`
          : `Read committed — acknowledged ${acknowledged} unread update(s) on ${value.threadRef}; ${remaining} remain.`,
        `${value.threadRef}${standing === '' ? '' : ` · ${standing}`} · ${value.following ? 'following' : 'not following'}`,
      ]
            // Orientation: A) the anchor is a returned fact (renders once, no separate anchor); B) a Host-supplied background fact carries `unread === false`, so the full anchor renders before the facts; C) otherwise (continuation or unfollowed ad-hoc read) the shared bounded subject, never the full anchor.
      const anchorInFacts = facts.some(fact => fact.sequence === value.anchor.sequence)
      const hasBackground = facts.some(fact => fact.unread === false)
      if (!anchorInFacts && hasBackground) lines.push('', `Anchor ${value.anchor.sequence}${value.anchor.occurredAt === undefined ? '' : ` ${formatTeamTimestamp(value.anchor.occurredAt)}`} [${value.anchor.sender}]${repliesToClause(value.anchor.replyToMessageRef, value.anchor.replyTo)}`, value.anchor.body)
      if (!anchorInFacts && !hasBackground) lines.push(`  — ${boundedSubject(value.anchor.body)}`)
      const activeClaims = value.claims.filter(claim => claim.state === 'active')
      if (activeClaims.length > 0) {
        lines.push('', 'Active Claims')
        for (const claim of activeClaims) lines.push(claimLine(claim))
      }
      if (reminders.length > 0) {
        lines.push('', 'Acknowledged Task reminders')
        for (const reminder of reminders) lines.push(`${reminder.kind === 'review-backlog' ? 'Review backlog' : 'Stalled Task'} · ${reminder.taskRef} · baseline ${reminder.baselineSequence} · raised ${formatTeamTimestamp(reminder.occurredAt)}`)
      }
      lines.push('', 'Facts')
      if (facts.length === 0) lines.push('No new facts to acknowledge.')
      // Read orients on current derived Tasks; cards are projections, never unread facts.
      lines.push(...factTimelineLines(facts, value.taskCards ?? []))
      lines.push('', `Read through sequence ${value.readThroughSequence}; ${remaining} unread update(s) remaining${remaining > 0 ? ` — ${recoveryFor('unread_remaining').sentence({})}` : '.'}`)
            // The bounded read answered with the newest batch; the span before the watermark is orientation it did not supply, and rendering its count shows the returning reader the size of that span.
      const earlier = value.earlierFactCount ?? 0
      if (earlier > 0) lines.push(`Earlier facts: ${earlier} — read older ones with team_thread.history.`)
      if (remaining === 0) lines.push('', nextWriteLine(value.revision))
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, OPTIONAL_ADDRESS_KEYS)
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_thread requires an Agent session')
    const host = service(agent)
    if (args.projectRef !== undefined) return mainStreamOutcome(host, agent, args, requestId(agent.id, exec.callId))
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
          ? { sequence: fact.sequence, kind: 'message', body: fact.message.body, sender: fact.message.sender, mentions: [...fact.mentions], ...(fact.message.replyToMessageRef === undefined ? {} : { replyToMessageRef: fact.message.replyToMessageRef }), ...(fact.replyTo === undefined ? {} : { replyTo: fact.replyTo }), occurredAt: fact.occurredAt }
          : activityFactView(fact.sequence, fact.activity, undefined, fact.occurredAt)), { cursor: history.cursor, hasMore: history.hasMore, taskCards: (history.taskCards ?? []).map(taskCardView), ...taskNumberOf(history.task) })
    }
    if (args.action === 'message') {
      if (args.messageRef === undefined) throw new Error(recoveryFor('missing_message_ref').sentence({ refused: 'for action message' }))
            // Reading one Message is authorized by the Thread that carries it, so threadRef is required even though taskRef addresses the same Thread elsewhere in this tool.
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
      return threadResult('message', base.workspaceId, snapshot, status.attention, [], {
        message: { messageRef: readBack.messageRef, sender: readBack.sender, sequence: readBack.sequence, ...(readBack.occurredAt === undefined ? {} : { occurredAt: readBack.occurredAt }), body: readBack.body },
        ...taskNumberOf(snapshot.task),
      })
    }
        // `read` is the one action that returns a bounded batch by design — its Host request carries neither paging field, so a page size here cannot be honored. Refusing the whole call taught the model nothing: one real session retried the identical arguments twice. The batch it did get names what remains, which is the route to more.
    if (args.action !== 'read' && (args.beforeSequence !== undefined || args.limit !== undefined)) {
      throw new Error(recoveryFor('history_only_arguments').sentence({ action: args.action }))
    }
    const read = await host.readThreadForAgent(agent, { requestId: requestId(agent.id, exec.callId), ...base })
    // Only a discussion needs the extra history projection for its derived cards.
    const cards = read.task === undefined
      ? (host.threadHistoryForAgent(agent, { ...base, beforeSequence: 1, limit: 1 }).taskCards ?? []).map(taskCardView)
      : []
    return threadResult('read', base.workspaceId, read, read.attention, read.facts.map(entry => readFactView(entry)), { readThroughSequence: read.readThroughSequence, remainingUnreadCount: read.remainingUnreadCount, reminders: [...read.reminders], ...(read.earlierFactCount === undefined ? {} : { earlierFactCount: read.earlierFactCount }), taskCards: cards, ...taskNumberOf(read.task) })
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
  readonly message?: { readonly messageRef: string; readonly sender: string; readonly sequence: number; readonly occurredAt?: string | undefined; readonly body: string } | undefined
}): string[] {
  const source = `Workspace: ${value.workspaceId} · Project: ${value.projectRef} · Main stream`
  if (value.kind === 'message') {
    const message = value.message!
    return [source, `Message ${message.messageRef}`, `${message.sequence}${message.occurredAt === undefined ? '' : ` ${formatTeamTimestamp(message.occurredAt)}`} [${message.sender}]`, '', message.body]
  }
  const entries = value.entries ?? []
  if (value.kind === 'history') {
    return [source, `History for ${value.projectRef}`, '', 'Entries', ...(entries.length === 0 ? ['No entries before this cursor.'] : entries.map(mainEntryLine)), '',
      `History cursor ${value.cursor}; hasMore=${value.hasMore ? 'true' : 'false'}${value.hasMore ? ' — older entries exist; page again with beforeSequence set to the cursor.' : ' — no older entries remain.'}`]
  }
  const acknowledged = entries.filter(entry => entry.unread).length
  const remaining = value.remainingUnreadCount ?? 0
  return [source,
    acknowledged === 0 ? `Read — no unread updates on the Main stream of ${value.projectRef}.`
      : `Read committed — acknowledged ${acknowledged} unread update(s) on the Main stream of ${value.projectRef}; ${remaining} remain.`,
    '', 'Entries', ...(entries.length === 0 ? ['The Main stream is empty.'] : entries.map(mainEntryLine)), '',
    `Read through sequence ${value.readThroughSequence}; ${remaining} unread update(s) remaining${remaining > 0 ? ' — read again for the next page before you post.' : '.'} Speak here with team_message post; read a Thread card's Thread with team_thread read.`]
}

async function mainStreamOutcome(
  host: AgentTeam,
  agent: Parameters<typeof workspaceOf>[1],
  args: { readonly action: string; readonly projectRef?: string | undefined; readonly threadRef?: string | undefined; readonly taskRef?: string | undefined
    readonly messageRef?: string | undefined; readonly beforeSequence?: number | undefined; readonly limit?: number | undefined; readonly workspace?: string | undefined },
  readRequestId: AgentTeamRequestId,
) {
  if (args.threadRef !== undefined || args.taskRef !== undefined) throw new Error(recoveryFor('main_stream_addressing').sentence({ refused: 'threadRef and projectRef' }))
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
    return { ...base, projectRef: read.projectRef, kind: 'message', message: { messageRef: read.messageRef, sender: read.sender, sequence: read.sequence,
      ...(read.occurredAt === undefined ? {} : { occurredAt: read.occurredAt }), body: read.body } }
  }
  if (args.action === 'history') {
    const history = host.mainStreamHistoryForAgent(agent, { workspaceId, projectRef,
      ...(args.beforeSequence === undefined ? {} : { beforeSequence: args.beforeSequence }), ...(args.limit === undefined ? {} : { limit: args.limit }) })
    return { ...base, projectRef: history.projectRef, kind: 'history', entries: history.entries.map(mainEntryView), cursor: history.cursor,
      hasMore: history.hasMore, standing: standingView(history.standing) }
  }
  if (args.action !== 'read' && (args.beforeSequence !== undefined || args.limit !== undefined)) throw new Error(recoveryFor('history_only_arguments').sentence({ action: args.action }))
  const read = await host.readMainStreamForAgent(agent, { requestId: readRequestId, workspaceId, projectRef })
  return { ...base, projectRef: read.projectRef, kind: 'read', entries: read.entries.map(mainEntryView), readThroughSequence: read.readThroughSequence,
    remainingUnreadCount: read.standing.unreadCount, standing: standingView(read.standing) }
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
}): FactView {
  return entry.fact.kind === 'message'
    ? { sequence: entry.fact.sequence, kind: 'message', body: entry.fact.message.body, sender: entry.fact.message.sender,
      mentions: [...entry.fact.mentions],
      ...(entry.fact.message.replyToMessageRef === undefined ? {} : { replyToMessageRef: entry.fact.message.replyToMessageRef }),
      ...(entry.fact.replyTo === undefined ? {} : { replyTo: entry.fact.replyTo }),
      unread: entry.unread, direct: entry.direct, occurredAt: entry.fact.occurredAt }
    : activityFactView(entry.fact.sequence, entry.fact.activity, { unread: entry.unread, direct: entry.direct }, entry.fact.occurredAt)
}

/** One rendered fact line; markers are inline, never a separate ellipsis line. */
function factLine(fact: FactView): string {
  const at = fact.occurredAt === undefined ? '' : ` ${formatTeamTimestamp(fact.occurredAt)}`
  return fact.kind === 'message'
    ? `${fact.sequence}${at} [${fact.sender ?? 'unknown sender'}]${factMarkers(fact)}${repliesToClause(fact.replyToMessageRef, fact.replyTo)} ${fact.body}`
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
  extra: { cursor?: number; hasMore?: boolean; readThroughSequence?: number; remainingUnreadCount?: number; earlierFactCount?: number; taskNumber?: number; taskCards?: TaskCardView[]; reminders?: AgentTeamInboxReminder[]; message?: { messageRef: string; sender: string; sequence: number; occurredAt?: string; body: string } } = {},
): { workspaceId: string; projectRef: string; anchor: { messageRef: string; sender: string; body: string; sequence: number; occurredAt?: string; replyToMessageRef?: string; replyTo?: ReplyContextView }; message?: { messageRef: string; sender: string; sequence: number; occurredAt?: string; body: string }; threadRef: string; revision: number; kind: string; following: boolean; taskRef?: string; status?: string; resolution?: string; taskNumber?: number; accountable?: string; readThroughSequence?: number; remainingUnreadCount?: number; earlierFactCount?: number; cursor?: number; hasMore?: boolean; taskCards?: TaskCardView[]; reminders?: AgentTeamInboxReminder[]; claims: ClaimView[]; facts: FactView[] } {
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
    body: { type: 'string', required: true, description: "Markdown body. Lead with the conclusion or state. Mention the Human only when they must know or decide; when a decision is owed, say plainly what needs deciding and what happens by default if nobody answers — no fixed template. Keep it the shortest useful message for the recipient; mechanical detail follows below. Cite Team refs exactly as returned, as bare text with one colon (e.g. task:0f0a…) — never a double colon, never inside backticks or quotes. Unambiguous UUID abbreviations (first 6+ hex chars) also resolve." },
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
  description: 'Post to a Project\'s Main stream, start a Thread, or reply to one. post speaks in the Project\'s Main stream — the conversation outside every Thread — and any Project member may: pass projectRef and body, mention with `@Handle`, and optionally replyToMessageRef (a Main stream Message of the same Project, whose author is delivered to). An owner holding unread Main stream, or any Member holding a mention, reads it first (team_thread read with projectRef); post has no write token. start opens a discussion or a Task (kind) and only a Project owner may — a Thread starts from a standing question or piece of work, not from conversation. Read the Thread first: a reply needs the current next-write token from a fully drained team_thread read (or your own last committed mutation), and unread work rejects before staleness is even checked — and a mention only delivers its Message, never the Thread\'s earlier facts, so entering a Thread whose facts have left your context means reading back through it first. start takes kind discussion (default) or task. A mention in a start or a reply delivers its Message to that Member once and never makes them follow. Mention by writing `@Handle` in body — the `@` is required, matching ignores case, and each named Member is delivered to and renders as a mention chip; `@all` is plain text under version 2 — it delivers to no one, so name each Member you need to reach. A private note to one Member is team_dm, not a reply.',
  parameters: {
    action: { type: 'string', required: true, enum: ['start', 'reply', 'post'] },
    projectRef: { type: 'string', description: "Full branded Project ref exactly as returned by Team tools, including the 'project:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves. Required by start and post." },
    kind: { type: 'string', enum: ['discussion', 'task'], description: 'start only: discussion (default) opens a Thread to talk something through; task opens a Thread that carries a Task.' },
    accountable: { type: 'string', description: "start with kind task only: who becomes accountable for the new Task — a current Project owner's memberRef or @Handle, or 'human'. Omit it and the Agent owner who starts the Task is accountable, or the Human when the Human starts it. It does not change who may start a Task." },
    sourceThreadRefs: { type: 'array', items: { type: 'string' }, description: 'start with kind task only: the discussion Threads this Task derives from, as full branded threadRefs of the same Project. Each becomes a source of the new Task, which the card renders there instead of in the Main stream; a Task may name several. Task Threads and other Projects are refused, and a source is fixed at creation — promoting a discussion in place records no source.' },
    threadRef: { type: 'string', description: "Full branded Thread ref exactly as returned by Team tools, including the 'thread:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    taskRef: { type: 'string', description: "Optional Task ref alias for reply on a Taskful Thread. Prefer threadRef; an unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    replyToMessageRef: { type: 'string', description: "Optional: the full branded Message ref you are answering (for post: a Main stream Message of the same Project) (as rendered by team_thread or an inbox notice). Reply on the Thread you are already replying to; the Message must be one this Thread recorded. The Host links the reply to it, and its author is then delivered to like a mention, so answering a peer reaches them without typing their handle. Use it when the link is the point — the reader needs to know which Message you are answering. A Message that only continues the Thread's conversation needs neither this nor a mention: the Thread already delivers to the Members on it, so the link would announce a delivery that was going to happen anyway." },
    body: { type: 'string', required: true, description: "Markdown body. Lead with the conclusion or state. Mention the Human only when they must know or decide; when a decision is owed, say plainly what needs deciding and what happens by default if nobody answers — no fixed template. Keep it the shortest useful message for the recipients; mechanical detail follows below. Cite Team refs exactly as returned, as bare text with one colon (e.g. task:0f0a…) — never a double colon, never inside backticks or quotes. Unambiguous UUID abbreviations (first 6+ hex chars) also resolve. Mention a Member by writing `@Handle` (`@` required, case-insensitive) in the prose: that is what delivers the Message to them and renders the mention chip; `@all` is plain text under version 2 and delivers to no one — name each Member instead." }, baseRevision: { type: 'number', description: "The next-write token from your latest fully drained team_thread read (or your own last committed mutation) on this Thread. Copy the explicitly rendered value verbatim; never increment, derive, compare, or cite it — it is an opaque concurrency token, not a fact about the Thread." },
    attachments: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to share, e.g. screenshots or generated artifacts; images render as thumbnails for recipients. The Host validates each path and copies the file into the attachment cache, and members also receive one cached path per attachment; if any path fails validation the whole send is rejected.' },
    workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true }, action: { type: 'string' }, taskRef: { type: 'string' }, threadRef: { type: 'string' }, revision: { type: 'number' }, accountable: { type: 'string' }, sourceThreadRefs: { type: 'array', items: { type: 'string' } },
      expectedRevision: { type: 'number' }, messageRef: { type: 'string' }, memberIds: { type: 'array', items: { type: 'string' } }, unreadCount: { type: 'number' }, directCount: { type: 'number' },
      projectRef: { type: 'string' }, entries: { type: 'array', items: MAIN_ENTRY_SCHEMA },
      facts: { type: 'array', items: FACT_SCHEMA },
      undeliveredMentions: { type: 'array', items: { type: 'string' } }, occurredAt: { type: 'string' }, staleTokenKind: { type: 'string', enum: ['unknown', 'unrecognized'] },
    } },
    render: (_args, value) => {
      if (value.kind === 'committed' && value.action === 'post' && value.messageRef !== undefined) {
        return [{ type: 'text', text: [
          'Committed — Main stream message posted.',
          [value.messageRef, ...(value.projectRef === undefined ? [] : [value.projectRef])].join(' · '),
          ...(value.occurredAt === undefined ? [] : [`Committed at ${formatTeamTimestamp(value.occurredAt)}`]),
        ].join('\n') }]
      }
      if (value.kind === 'main_unread_required') {
        const entries = (value.entries ?? []) as MainEntryView[]
        return [{ type: 'text', text: [
          'Not committed — main_unread_required.',
          `${value.projectRef ?? ''} · ${value.unreadCount ?? 0} unread, ${value.directCount ?? 0} direct`,
          ...(entries.length === 0 ? [] : ['', `${entries.length} unread Main stream entr${entries.length === 1 ? 'y' : 'ies'}:`, ...entries.map(mainEntryLine)]),
          recoveryFor('main_unread_required').sentence({ projectRef: value.projectRef }),
        ].join('\n') }]
      }
      if (value.kind === 'committed' && value.messageRef !== undefined && value.threadRef !== undefined && value.revision !== undefined) {
        return [{ type: 'text', text: [
          value.action === 'start' ? 'Committed — Thread created.' : 'Committed — reply added.',
          [value.messageRef, value.threadRef, ...(value.taskRef === undefined ? [] : [value.taskRef])].join(' · '),
          ...(value.accountable === undefined ? [] : [`Accountable for ${value.taskRef}: ${value.accountable}.`]),
          ...(value.sourceThreadRefs === undefined || value.sourceThreadRefs.length === 0 ? [] : [`Derived from ${value.sourceThreadRefs.join(', ')} — its card renders there, not in the Main stream.`]),
          ...(value.occurredAt === undefined ? [] : [`Committed at ${formatTeamTimestamp(value.occurredAt)}`]),
          ...(value.undeliveredMentions === undefined || value.undeliveredMentions.length === 0 ? [] : [
            `Mention not delivered — ${value.undeliveredMentions.join(', ')} never took part in this Thread, so nothing reached them. Only a Human can invite a Member: reach them with a dm, or ask the Human.`,
          ]),
          nextWriteLine(value.revision),
        ].join('\n') }]
      }
      return [{ type: 'text', text: rejectionLines(value).join('\n') }]
    },
        // Minimal durable projection for the Host's context timeline: the structured outcome identity, never render text. The effect-anchor fold reads `kind === 'committed'` + threadRef from the persisted tool/result meta; a start's Thread is born in the result.
    presentationMeta: (_args, value): Record<string, string> => value.kind === 'committed' && value.threadRef !== undefined
      ? { kind: value.kind, threadRef: value.threadRef, ...(value.taskRef === undefined ? {} : { taskRef: value.taskRef }) }
      : { kind: value.kind },
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, OPTIONAL_ADDRESS_KEYS)
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
        return { kind: result.kind, action: 'post', projectRef: result.message.projectRef, messageRef: result.message.messageRef, occurredAt: result.receipt.occurredAt }
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
        ...(args.accountable === undefined ? {} : { accountable: accountableTarget(host, args.accountable) }),
        ...(args.sourceThreadRefs === undefined ? {} : { sourceThreadRefs: args.sourceThreadRefs.map(ref => ref as AgentTeamThreadRef) }) })
      return messageOutcome(result, 'start')
    }
    const baseRevision = args.baseRevision
    if (args.projectRef !== undefined) throw new Error(`reply does not take projectRef — ${recoveryFor('main_stream_addressing').sentence({ refused: 'projectRef on reply' })}`)
    if ((args.threadRef === undefined && args.taskRef === undefined) || args.kind !== undefined || typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      throw new Error(`reply requires threadRef and a positive baseRevision — ${recoveryFor('missing_write_token').sentence({})}`)
    }
    if (args.accountable !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'reply', parameter: 'accountable', owner: 'start' }))
    if (args.sourceThreadRefs !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'reply', parameter: 'sourceThreadRefs', owner: 'start' }))
    const result = await host.replyForAgent(agent, { requestId: requestId(agent.id, exec.callId), workspaceId: workspaceOf(args, agent),
      ...(args.threadRef === undefined ? {} : { threadRef: args.threadRef as AgentTeamThreadRef }),
      ...(args.taskRef === undefined ? {} : { taskRef: args.taskRef as AgentTeamTaskRef }),
      ...(args.replyToMessageRef === undefined ? {} : { replyToMessageRef: args.replyToMessageRef as AgentTeamMessageRef }),
      body: args.body, baseRevision, ...paths })
    return messageOutcome(result, 'reply')
  },
}))

function messageOutcome(result: Awaited<ReturnType<AgentTeam['startThreadForAgent']>> | Awaited<ReturnType<AgentTeam['replyForAgent']>>, action: 'start' | 'reply') {
  if (result.kind === 'committed') {
        // A start always delivers to the Members it names (they begin following the new Thread), so only a reply can report names the Thread has never carried.
    const undelivered = 'undeliveredMentions' in result ? result.undeliveredMentions : undefined
    return { kind: result.kind, action, threadRef: result.thread.threadRef,
      ...(result.task === undefined ? {} : { taskRef: result.task.taskRef, accountable: result.task.accountable }),
      ...(result.task === undefined || result.task.sourceThreadRefs.length === 0 ? {} : { sourceThreadRefs: [...result.task.sourceThreadRefs] }),
      revision: result.thread.revision, messageRef: result.message.messageRef, occurredAt: result.receipt.occurredAt,
      ...(undelivered === undefined || undelivered.length === 0 ? {} : { undeliveredMentions: [...undelivered] }) }
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

/**
 * The Human is addressable by role — by the configured handle or the literal `human` — because `member:human` is the one id no roster lists.
 * A bare Agent handle resolves too: a model reading a board row or a message body has handles in front of it, and the ledger only resolves refs.
 */
function accountableTarget(host: AgentTeam, raw: string): AgentTeamMemberId {
  const trimmed = raw.trim()
  const lower = trimmed.replace(/^@/u, '').toLowerCase()
  if (trimmed === AGENT_TEAM_HUMAN_MEMBER_ID || lower === 'human' || lower === host.humanHandle().toLowerCase()) return AGENT_TEAM_HUMAN_MEMBER_ID
  const member = host.members().find(status => status.member.handle.toLowerCase() === lower)
  if (member === undefined && !trimmed.startsWith('member:')) {
    throw new Error(recoveryFor('unknown_ref').sentence({ refused: trimmed }))
  }
  return member === undefined ? trimmed as AgentTeamMemberId : member.member.memberId
}

const teamTask = defineTool({
  name: 'team_task',
  description: 'Work with Tasks. board lists the Task board of the Projects you can see — every open Task with its status, who is accountable for it, and the Members on it, plus each Project\'s newest finished Tasks — filtered by projectRef or to your own responsibility with mine; it is current state, not unread, so check it before you claim or when a Workspace change surprises you. promote turns a discussion Thread into a Task (Project owners only) and takes accountable to name the owner responsible for it; a Task started with team_message start takes the same field. list, claim, done and release manage your Direction Claims. A Claim is your one-sentence direction statement on a Task — "the angle I am taking" — so others can spot collisions and track progress: Tasks define scope, Claims declare the angle (owned by you). Good direction: "Unify the four form dialogs on shared field components before wiring submits." Bad direction: a multi-paragraph plan with step order, file lists, or acceptance criteria — those belong in Thread messages, not the Claim. Every Task has one accountable owner: the Human, or an Agent Project owner. accept finishes a Task as verified work; close ends it without acceptance; reopen returns it to open work; transfer hands accountability to another Project owner or back to the Human. Who may do which is the Host\'s call, not yours to reason around: accept belongs to the Human or to a Project owner who never held a Claim on this Task (an Agent may accept only an in_review Task), while close, reopen and transfer belong to the Human or the current accountable. Acceptance, closing, and reopening are three separate decisions: finishing your own Claim is not acceptance, and an Agent that executed a Task cannot verify it. transfer moves responsibility only — Claims and their owners stay where they are. Mutations require the current next-write token from a fully drained team_thread read (or your own last committed mutation); list refreshes the collision surface only and authorizes no mutation.',
  parameters: {
    action: { type: 'string', required: true, enum: ['board', 'list', 'claim', 'done', 'release', 'promote', 'accept', 'close', 'reopen', 'transfer'] },
    projectRef: { type: 'string', description: 'board only: limit the board to one Project.' },
    mine: { type: 'boolean', description: 'board only: only Tasks you are accountable for or hold a live Claim on.' },
    threadRef: { type: 'string', description: 'promote only: the discussion Thread to turn into a Task.' },
    taskRef: { type: 'string', description: "Full branded Task ref exactly as returned by Team tools, including the 'task:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    baseRevision: { type: 'number', description: "The next-write token from your latest fully drained team_thread read (or your own last committed mutation) on this Task's Thread. Copy the explicitly rendered value verbatim; never increment, derive, compare, or cite it — it is an opaque concurrency token, not a fact about the Task." }, direction: { type: 'string' },
    claimRef: { type: 'string', description: "Full branded Claim ref exactly as returned by team_task, including the 'claim:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    accountable: { type: 'string', description: "promote only: the Member who becomes accountable for the new Task — a current Project owner's memberRef or @Handle, or 'human'. Omit it and the promoting owner is accountable, or the Human when the Human promotes." },
    target: { type: 'string', description: "transfer only: the Member who becomes accountable — a current Project owner of this Task's Project, as a memberRef, @Handle, or a unique 6+ hex prefix, or 'human' to return responsibility to the Human." },
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
        return [{ type: 'text', text: [
          `Committed — Claim ${value.action === 'claim' ? 'created' : value.action === 'done' ? 'completed' : 'released'}.`,
          `${value.claim.claimRef} · ${value.claim.state} — ${value.claim.owner}: ${value.claim.direction}`,
          `${value.threadRef} · ${value.taskRef} · ${value.status}${value.accountable === undefined ? '' : ` · accountable ${value.accountable}`}`,
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
      return [{ type: 'text', text: rejectionLines(value as Parameters<typeof rejectionLines>[0]).join('\n') }]
    },
  },
  async execute(rawArgs, exec) {
    const args = blankToAbsent(rawArgs, OPTIONAL_ADDRESS_KEYS)
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
        ...(args.accountable === undefined ? {} : { accountable: accountableTarget(host, args.accountable) }) })
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
      if (args.target === undefined || args.target.trim() === '') throw new Error('transfer needs target — the Project owner who becomes accountable for this Task, or human.')
      const target = accountableTarget(host, args.target)
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
      revision: result.thread.revision, status: result.task.status, accountable: result.task.accountable, claim: claimView(result.claim), claims, occurredAt: result.receipt.occurredAt }
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
  description: 'Discover your authorized Team addresses: current Projects (with their owners and your role), a newest-first page of top-level Threads (each with its bounded anchor subject; Task standing inline on taskful rows), and current Members. This is an address book, not a work queue: unread work lives in team_inbox, work in flight on team_task board, and a Thread is read with team_thread read. The cursor pages Thread rows only.',
  parameters: {
    projectRef: { type: 'string', description: "Full branded Project ref exactly as returned by Team tools, including the 'project:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    limit: { type: 'number' }, cursor: { type: 'number' }, workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      projects: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        projectRef: { type: 'string', required: true }, name: { type: 'string', required: true },
        // Present only once the ledger has Project owners (rules version 2).
        owners: { type: 'array', items: { type: 'string' } }, role: { type: 'string' },
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
        lines.push('Team directory', '', 'Projects — current')
        if (value.projects.length === 0) lines.push('No authorized Projects.')
        else lines.push(...value.projects.map(project => `${project.projectRef} · ${project.name}${project.owners === undefined ? '' : ` · owners ${project.owners.map(handle => `@${handle}`).join(', ')} · you: ${project.role}`}`))
        lines.push('')
      }
      lines.push('Threads')
      if (value.threads.length === 0) lines.push(`No top-level Threads${!continuation && value.projects.length === 1 ? ` in ${value.projects[0]!.projectRef}` : ''} at this cursor.`)
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
        lines.push('', 'Work in flight lives on the Task board: team_task board.')
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
    const visibleMemberIds = new Set(view.members.map(membership => membership.memberId))
    const self = host.memberForAgent(agent)
    const handles = new Map(host.members().map(status => [status.member.memberId, status.member.handle]))
    const ownership = view.rulesVersion >= 2
    return {
      workspaceId,
      workspaces: view.workspaces.map(participation => ({ workspaceId: participation.workspaceId,
        ...(participation.title === undefined ? {} : { title: participation.title }), default: participation.default })),
      projects: view.projects.map(project => {
        if (!ownership) return { projectRef: project.projectRef, name: project.name }
        const ownerIds = view.owners.filter(owner => owner.projectRef === project.projectRef).map(owner => owner.memberId)
        return { projectRef: project.projectRef, name: project.name,
          owners: [host.humanHandle(), ...ownerIds.map(memberId => handles.get(memberId) ?? memberId)],
          role: self !== undefined && ownerIds.includes(self.memberId) ? 'owner' : 'member' }
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

export function apply(ctx: Context): void {
  ctx.tools.register(teamInbox)
  ctx.tools.register(teamThread)
  ctx.tools.register(teamAttention)
  ctx.tools.register(teamMessage)
  ctx.tools.register(teamDm)
  ctx.tools.register(teamTask)
  ctx.tools.register(teamView)
}
