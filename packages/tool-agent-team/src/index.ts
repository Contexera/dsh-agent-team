import type { Context } from '@deepseek-ai/cordis'
import AgentTeam, { AgentTeamDmDeliveryError, markAgentTeamPreset } from '@contexera/dsh-agent-team/host'
import { formatTeamTimestamp } from '@contexera/dsh-agent-team/time-format'
import { registerContextTools } from './context-tools.ts'
import { service, workspaceOf, workspaceParam } from './host-access.ts'
import type {
  AgentTeamClaimRef,
  AgentTeamMemberId,
  AgentTeamRequestId,
  AgentTeamMessageRef,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
} from '@contexera/dsh-agent-team/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentTeamContextAdvice } from '@contexera/dsh-agent-team/types'

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
  /**
   * The same target, resolved for reading: who wrote it and its first line.
   *
   * Kept apart from `replyToMessageRef` on purpose — that is the ref you pass
   * back to `team_message.reply`, this is what a reader sees, and one field
   * carrying both meanings would make each of them wrong half the time.
   */
  readonly replyTo?: ReplyContextView
}

/** One Message's answer target, as the Agent surfaces print it. */
interface ReplyContextView {
  readonly sender: string
  readonly excerpt: string
}

type FactView = MessageFactView | ActivityFactView

/** Model-facing view of read-time context advice; absent fields mean unmeasured. */
interface ContextAdviceView {
  readonly usageTokens?: number
  readonly taskBoundaryThreshold?: number
  readonly handoffAt?: number
  readonly hardLimit?: number
  readonly action: string
  readonly guidance: string
}

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

function adviceView(advice: AgentTeamContextAdvice): ContextAdviceView {
  return {
    ...(advice.usageTokens === undefined ? {} : { usageTokens: advice.usageTokens }),
    ...(advice.taskBoundaryThreshold === undefined ? {} : { taskBoundaryThreshold: advice.taskBoundaryThreshold }),
    ...(advice.handoffAt === undefined ? {} : { handoffAt: advice.handoffAt }),
    ...(advice.hardLimit === undefined ? {} : { hardLimit: advice.hardLimit }),
    action: advice.action, guidance: advice.guidance,
  }
}

/**
 * The one deterministic bounded subject, shared by directory rows and Thread
 * orientation: whitespace collapses to one line, then one bounded cut with an
 * explicit truncation mark. Directory, read, and history orientation must
 * never disagree about what a Thread is about.
 */
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

/** Task standing inline on a Thread identity line; absent on taskless Threads. */
function taskStanding(value: { taskRef?: string; status?: string; resolution?: string; taskNumber?: number }): string {
  if (value.taskRef === undefined) return ''
  return `${value.taskRef}${value.taskNumber === undefined ? '' : ` (#${value.taskNumber})`}${value.status === undefined ? '' : `, ${value.status}${value.resolution === undefined ? '' : `/${value.resolution}`}`}`
}

function requestId(agentId: string, callId: string): AgentTeamRequestId {
  return `agent-team:tool:${agentId}:${callId}` as AgentTeamRequestId
}

/**
 * One typed-rejection renderer parameterized by the mutation noun, shared by
 * team_message and team_claim. Outcome first, action-local recovery facts,
 * then the single recovery route: read the named Thread and reconsider — a
 * rejection carries no changed facts, so it never renders a numeric revision
 * or a next-write token.
 */
function rejectionLines(
  noun: 'message' | 'Claim mutation',
  value: { readonly kind: string; readonly threadRef?: string; readonly taskRef?: string; readonly unreadCount?: number; readonly directCount?: number; readonly memberIds?: string[] },
): string[] {
  const identity = [
    value.threadRef === undefined ? '' : value.threadRef,
    value.taskRef === undefined ? '' : value.taskRef,
  ].filter(part => part !== '').join(' · ')
  if (value.kind === 'unread_required') {
    return [
      'Not committed — unread_required.',
      `${identity}${identity === '' ? '' : ' · '}${value.unreadCount ?? 0} unread, ${value.directCount ?? 0} direct`,
      `Read the pending updates with team_thread read before reconsidering this ${noun}.`,
    ]
  }
  if (value.kind === 'stale_revision') {
    return [
      'Not committed — the Thread changed after your last read (stale_revision).',
      identity,
      `Read the Thread, reconsider the new facts, then retry this ${noun} with the token that read returns.`,
    ]
  }
  return [
    'Not committed — member_not_following.',
    `${(value.memberIds ?? []).join(', ')} not following${value.threadRef === undefined ? '' : ` ${value.threadRef}`}${value.taskRef === undefined ? '' : ` (${value.taskRef})`}; no message was added.`,
    'Only a Human can invite an unfollowed Agent — retry without mentioning them, or ask the Human.',
  ]
}

const teamInbox = defineTool({
  name: 'team_inbox',
  description: 'List your bounded Team Inbox across all joined Workspaces for triage: unread Thread summaries with counts, without message bodies and without marking anything read. Read a selected Thread with team_thread read; the inbox itself authorizes no mutation. This is your own unread queue; to see work others have in flight (whether or not you have unread on it), use the active-task-threads section of team_view.',
  parameters: { limit: { type: 'number' }, workspace: workspaceParam },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      totalUnreadCount: { type: 'number', required: true }, totalDirectCount: { type: 'number', required: true },
      items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        workspaceId: { type: 'string', required: true }, threadRef: { type: 'string', required: true }, channelRef: { type: 'string', required: true },
        taskRef: { type: 'string' }, status: { type: 'string' }, revision: { type: 'number', required: true }, unreadCount: { type: 'number', required: true }, directCount: { type: 'number', required: true },
        taskNumber: { type: 'number' }, newestOccurredAt: { type: 'string' },
      } } },
    } },
    // Triage surface only: totals plus both counters per row (direct renders
    // even when zero), a bounded-list conclusion so truncation can never read
    // as drained, and one route to the tool that can actually acknowledge the
    // work. No subject, no body, no revision label, no write token: the inbox
    // routes to a required current read, which supplies the write basis.
    render: (_args, value) => {
      if (value.items.length === 0) {
        return [{ type: 'text', text: value.totalUnreadCount > 0
          ? `Inbox — ${value.totalUnreadCount} unread update(s) on Threads beyond this bounded list — call again with a larger limit.`
          : 'Inbox empty — no unread Team work.' }]
      }
      const shown = value.items.reduce((sum, item) => sum + item.unreadCount, 0)
      return [{ type: 'text', text: [
        `Inbox — ${value.totalUnreadCount} unread update(s) total, ${value.totalDirectCount} direct, across ${value.items.length} Thread(s) shown${value.totalUnreadCount > shown ? `; ${value.totalUnreadCount - shown} more on Threads beyond this bounded list — call again with a larger limit.` : '.'}`,
        ...value.items.map(item => `${item.workspaceId} · ${item.threadRef}${item.channelRef === undefined ? '' : ` · ${item.channelRef}`}${item.taskRef === undefined ? '' : ` · ${taskStanding(item)}`} · ${item.unreadCount} unread, ${item.directCount} direct${item.newestOccurredAt === undefined ? '' : ` · newest ${formatTeamTimestamp(item.newestOccurredAt)}`}`),
        'Read a selected Thread with team_thread read. Listing changes no read state and supplies no write token.',
      ].join('\n') }]
    },
  },
  async execute(args, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_inbox requires an Agent session')
    const host = service(agent)
    const inbox = host.inboxForAgent(agent, { ...(args.workspace === undefined ? {} : { workspaceId: workspaceOf(args, agent) }), ...(args.limit === undefined ? {} : { limit: args.limit }) })
    return {
      totalUnreadCount: inbox.totalUnreadCount, totalDirectCount: inbox.totalDirectCount,
      items: inbox.items.map(item => {
        const taskNumber = item.taskNumber
        return { workspaceId: item.workspaceId, threadRef: item.thread.threadRef, channelRef: item.channelRef,
          ...(item.task === undefined ? {} : { taskRef: item.task.taskRef, status: item.task.status }),
          revision: item.thread.revision, unreadCount: item.unreadCount, directCount: item.directCount, newestOccurredAt: item.newestOccurredAt,
          ...(taskNumber === undefined ? {} : { taskNumber }) }
      }),
    }
  },
})

const teamThread = defineTool({
  name: 'team_thread',
  description: 'Read or manage your Attention on one Thread. message reads one Message back verbatim by ref — the way to answer a `Replies to:` line or a `(replies to …)` marker whose original sits outside the facts you have. read acknowledges one chronological batch of unread facts and is the only read-side source of a next-write token — and only once no unread remains; your own committed public mutations hand off the token as well. A read orients on the Thread anchor and that batch, never the whole Thread: a Member re-entering one it has read before gets no background at all, so the facts between are its own to page back to. history pages older facts without changing read state; status, follow, and unfollow change or report Attention only and render no Thread timeline. beforeSequence and limit are history-only: read, status, follow, and unfollow reject them — drop them, or call history to page older facts. Prefer threadRef; taskRef is a compatibility alias when the Thread has a Task.',
  parameters: {
    action: { type: 'string', required: true, enum: ['status', 'follow', 'unfollow', 'read', 'history', 'message'] },
    threadRef: { type: 'string', description: "Full branded Thread ref exactly as returned by Team tools, including the 'thread:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    taskRef: { type: 'string', description: "Optional Task ref alias for released clients. Prefer threadRef; if both are given they must identify the same Thread." },
    messageRef: { type: 'string', description: "For action `message`: the full branded Message ref to read back, exactly as rendered by this tool or by an inbox notice — including the `message:` prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    beforeSequence: { type: 'number', description: 'history only: the oldest fact sequence to page before (exclusive). read, status, follow, unfollow, and message reject it.' }, limit: { type: 'number', description: 'history only: max older facts to return. read, status, follow, unfollow, and message reject it.' }, workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      workspaceId: { type: 'string', required: true }, channelRef: { type: 'string', required: true },
      kind: { type: 'string', required: true }, threadRef: { type: 'string', required: true }, taskRef: { type: 'string' },
      message: { type: 'object', additionalProperties: false, properties: {
        messageRef: { type: 'string', required: true }, sender: { type: 'string', required: true }, sequence: { type: 'number', required: true }, occurredAt: { type: 'string' }, body: { type: 'string', required: true },
      } },
      revision: { type: 'number', required: true }, status: { type: 'string' }, resolution: { type: 'string' }, taskNumber: { type: 'number' },
      following: { type: 'boolean', required: true }, readThroughSequence: { type: 'number' }, remainingUnreadCount: { type: 'number' }, earlierFactCount: { type: 'number' }, cursor: { type: 'number' }, hasMore: { type: 'boolean' },
      anchor: { type: 'object', required: true, additionalProperties: false, properties: {
        messageRef: { type: 'string', required: true }, sender: { type: 'string', required: true }, body: { type: 'string', required: true }, sequence: { type: 'number', required: true }, occurredAt: { type: 'string' },
        replyToMessageRef: { type: 'string' },
        replyTo: { type: 'object', additionalProperties: false, properties: { sender: { type: 'string', required: true }, excerpt: { type: 'string', required: true } } },
      } },
      claims: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        claimRef: { type: 'string', required: true }, direction: { type: 'string', required: true }, state: { type: 'string', required: true }, owner: { type: 'string', required: true },
      } } },
      facts: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        sequence: { type: 'number', required: true }, kind: { type: 'string', required: true }, body: { type: 'string' }, sender: { type: 'string' }, occurredAt: { type: 'string' }, mentions: { type: 'array', items: { type: 'string' } }, replyToMessageRef: { type: 'string' }, replyTo: { type: 'object', additionalProperties: false, properties: { sender: { type: 'string', required: true }, excerpt: { type: 'string', required: true } } }, activity: { type: 'string' }, actor: { type: 'string' }, taskRef: { type: 'string' }, claimRef: { type: 'string' }, claimRefs: { type: 'array', items: { type: 'string' } }, completedClaimRefs: { type: 'array', items: { type: 'string' } }, acceptedClaimRefs: { type: 'array', items: { type: 'string' } }, releasedClaimRefs: { type: 'array', items: { type: 'string' } }, unread: { type: 'boolean' }, direct: { type: 'boolean' },
      } } },
      contextAdvice: { type: 'object', additionalProperties: false, properties: {
        usageTokens: { type: 'number' }, taskBoundaryThreshold: { type: 'number' }, handoffAt: { type: 'number' }, hardLimit: { type: 'number' },
        action: { type: 'string', required: true }, guidance: { type: 'string', required: true },
      } },
    } },
    // Renders are the only channel a tool result reaches the model through.
    // status/follow/unfollow answer only the Attention question. read renders
    // outcome → context → orientation → active collision surface → facts →
    // watermark/advice, and hands off the opaque next-write token only when
    // no unread remains. history renders deep orientation and never the
    // current collision surface or any write token.
    render: (args, value) => {
      const standing = taskStanding(value)
      const source = `Workspace: ${value.workspaceId} · Channel: ${value.channelRef}`
      if (value.kind === 'status') {
        return [{ type: 'text', text: `${source}\nAttention status — ${value.following ? 'following' : 'not following'} ${value.threadRef}${standing === '' ? '' : ` · ${standing}`}.` }]
      }
      if (value.kind === 'follow' || value.kind === 'unfollow') {
        return [{ type: 'text', text: `${source}\nAttention changed — ${value.following ? 'now following' : 'no longer following'} ${value.threadRef}${standing === '' ? '' : ` · ${standing}`}.` }]
      }
      if (value.kind === 'message') {
        // Verbatim, and the only action that is: the reader asked for this one
        // Message because it has to answer it, so nothing is trimmed here.
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
        // First page (no beforeSequence supplied) orients on the full
        // anchor; a continuation orients on the shared bounded subject. An
        // anchor already selected as a fact never repeats.
        if (!facts.some(fact => fact.sequence === value.anchor.sequence)) {
          if (args.beforeSequence === undefined) lines.push('', `Anchor ${value.anchor.sequence}${value.anchor.occurredAt === undefined ? '' : ` ${formatTeamTimestamp(value.anchor.occurredAt)}`} [${value.anchor.sender}]${repliesToClause(value.anchor.replyToMessageRef, value.anchor.replyTo)}`, value.anchor.body)
          else lines.push(`  — ${boundedSubject(value.anchor.body)}`)
        }
        lines.push('', 'Facts')
        if (facts.length === 0) lines.push('No facts before this cursor.')
        else lines.push(...facts.map(fact => factLine(fact)))
        lines.push('', `History cursor ${value.cursor}; hasMore=${value.hasMore ? 'true' : 'false'}${value.hasMore ? ' — older facts exist; page again with beforeSequence set to the cursor.' : ' — no older facts remain.'}`)
        return [{ type: 'text', text: lines.join('\n') }]
      }
      // kind === 'read': outcome → context → orientation → collision
      // surface → facts → watermark → token (iff nothing unread remains).
      const facts = value.facts as FactView[]
      const acknowledged = facts.filter(fact => fact.unread === true).length
      const remaining = value.remainingUnreadCount ?? 0
      // A read with nothing unread writes no durable operation, so the opening
      // line claims a commit only when unread facts were actually acknowledged.
      const lines = [
        source,
        acknowledged === 0
          ? `Read — no unread updates on ${value.threadRef}; nothing remains.`
          : `Read committed — acknowledged ${acknowledged} unread update(s) on ${value.threadRef}; ${remaining} remain.`,
        `${value.threadRef}${standing === '' ? '' : ` · ${standing}`} · ${value.following ? 'following' : 'not following'}`,
      ]
      // Orientation: A the anchor is one of the returned facts (renders as
      // that fact once, no separate anchor); B any Host-supplied background
      // fact carries positive `unread === false`, so the full anchor renders
      // before the facts; C otherwise (continuation or unfollowed ad-hoc
      // read) the shared bounded subject — never the full anchor.
      const anchorInFacts = facts.some(fact => fact.sequence === value.anchor.sequence)
      const hasBackground = facts.some(fact => fact.unread === false)
      if (!anchorInFacts && hasBackground) lines.push('', `Anchor ${value.anchor.sequence}${value.anchor.occurredAt === undefined ? '' : ` ${formatTeamTimestamp(value.anchor.occurredAt)}`} [${value.anchor.sender}]${repliesToClause(value.anchor.replyToMessageRef, value.anchor.replyTo)}`, value.anchor.body)
      if (!anchorInFacts && !hasBackground) lines.push(`  — ${boundedSubject(value.anchor.body)}`)
      const activeClaims = value.claims.filter(claim => claim.state === 'active')
      if (activeClaims.length > 0) {
        lines.push('', 'Active Claims')
        for (const claim of activeClaims) lines.push(claimLine(claim))
      }
      lines.push('', 'Facts')
      if (facts.length === 0) lines.push('No new facts to acknowledge.')
      else lines.push(...facts.map(fact => factLine(fact)))
      lines.push('', `Read through sequence ${value.readThroughSequence}; ${remaining} unread update(s) remaining${remaining > 0 ? ' — call team_thread read again.' : '.'}`)
      // What this bounded read answered with is the newest batch; the span
      // before the watermark is the orientation it did not supply. Rendering
      // the count is what lets a returning reader see the size of that span
      // instead of assuming the batch is the Thread.
      const earlier = value.earlierFactCount ?? 0
      if (earlier > 0) lines.push(`Earlier facts: ${earlier} — read older ones with team_thread.history.`)
      if (value.contextAdvice !== undefined) lines.push('', ...adviceLines(value.contextAdvice))
      if (remaining === 0) lines.push('', nextWriteLine(value.revision))
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_thread requires an Agent session')
    const host = service(agent)
    if (args.threadRef === undefined && args.taskRef === undefined) throw new Error('team_thread needs threadRef (or taskRef on a Taskful Thread); copy one from team_inbox or team_view, then retry')
    const base = { workspaceId: workspaceOf(args, agent), ...(args.threadRef === undefined ? {} : { threadRef: args.threadRef as AgentTeamThreadRef }), ...(args.taskRef === undefined ? {} : { taskRef: args.taskRef as AgentTeamTaskRef }) }
    const taskNumberOf = (task: { taskRef: AgentTeamTaskRef } | undefined): { taskNumber?: number } => {
      if (task === undefined) return {}
      const resolved = host.resolveTaskRefs({ workspaceId: base.workspaceId, taskRefs: [task.taskRef] }).resolved[0]
      return resolved === undefined ? {} : { taskNumber: resolved.taskNumber }
    }
    if (args.action === 'status') {
      if (args.beforeSequence !== undefined || args.limit !== undefined) throw new Error('status takes no beforeSequence or limit — drop them and retry')
      const status = host.attentionStatusForAgent(agent, base)
      const snapshot = host.threadHistoryForAgent(agent, { ...base, beforeSequence: 1, limit: 1 })
      return threadResult('status', base.workspaceId, snapshot, status.attention, [], taskNumberOf(snapshot.task))
    }
    if (args.action === 'follow' || args.action === 'unfollow') {
      if (args.beforeSequence !== undefined || args.limit !== undefined) throw new Error(`${args.action} takes no beforeSequence or limit — drop them and retry`)
      const result = await host.changeAttentionForAgent(agent, { requestId: requestId(agent.id, exec.callId), ...base, action: args.action })
      const snapshot = host.threadHistoryForAgent(agent, { ...base, beforeSequence: 1, limit: 1 })
      return threadResult(args.action, base.workspaceId, snapshot, result.attention, [], taskNumberOf(snapshot.task))
    }
    if (args.action === 'history') {
      const history = host.threadHistoryForAgent(agent, { ...base, ...(args.beforeSequence === undefined ? {} : { beforeSequence: args.beforeSequence }), ...(args.limit === undefined ? {} : { limit: args.limit }) })
      const status = host.attentionStatusForAgent(agent, base)
      return threadResult('history', base.workspaceId, history, status.attention, history.facts.map(fact => fact.kind === 'message'
          ? { sequence: fact.sequence, kind: 'message', body: fact.message.body, sender: fact.message.sender, mentions: [...fact.mentions], ...(fact.message.replyToMessageRef === undefined ? {} : { replyToMessageRef: fact.message.replyToMessageRef }), ...(fact.replyTo === undefined ? {} : { replyTo: fact.replyTo }), occurredAt: fact.occurredAt }
          : activityFactView(fact.sequence, fact.activity, undefined, fact.occurredAt)), { cursor: history.cursor, hasMore: history.hasMore, ...taskNumberOf(history.task) })
    }
    if (args.action === 'message') {
      if (args.messageRef === undefined) throw new Error('message needs messageRef; copy one from team_thread or an inbox notice, then retry')
      // Reading one Message is authorized by the Thread that carries it, so the
      // Thread ref is required here even though taskRef addresses the same
      // Thread elsewhere in this tool.
      if (args.threadRef === undefined) throw new Error('message needs threadRef; copy one from team_inbox or team_view, then retry')
      if (args.beforeSequence !== undefined || args.limit !== undefined) throw new Error('message takes no beforeSequence or limit — drop them and retry')
      const readBack = host.readMessageForAgent(agent, {
        workspaceId: base.workspaceId,
        threadRef: args.threadRef as AgentTeamThreadRef,
        messageRef: args.messageRef as AgentTeamMessageRef,
      })
      // The ordinary orientation is still returned, so every action of this tool
      // answers with one shape; the Message read back rides alongside it.
      const snapshot = host.threadHistoryForAgent(agent, { ...base, beforeSequence: 1, limit: 1 })
      const status = host.attentionStatusForAgent(agent, base)
      return threadResult('message', base.workspaceId, snapshot, status.attention, [], {
        message: { messageRef: readBack.messageRef, sender: readBack.sender, sequence: readBack.sequence, ...(readBack.occurredAt === undefined ? {} : { occurredAt: readBack.occurredAt }), body: readBack.body },
        ...taskNumberOf(snapshot.task),
      })
    }
    if (args.beforeSequence !== undefined || args.limit !== undefined) throw new Error('read does not accept history arguments')
    const read = await host.readThreadForAgent(agent, { requestId: requestId(agent.id, exec.callId), ...base })
    return threadResult('read', base.workspaceId, read, read.attention, read.facts.map(entry => entry.fact.kind === 'message'
        ? { sequence: entry.fact.sequence, kind: 'message', body: entry.fact.message.body, sender: entry.fact.message.sender, mentions: [...entry.fact.mentions], ...(entry.fact.message.replyToMessageRef === undefined ? {} : { replyToMessageRef: entry.fact.message.replyToMessageRef }), ...(entry.fact.replyTo === undefined ? {} : { replyTo: entry.fact.replyTo }), unread: entry.unread, direct: entry.direct, occurredAt: entry.fact.occurredAt }
        : activityFactView(entry.fact.sequence, entry.fact.activity, { unread: entry.unread, direct: entry.direct }, entry.fact.occurredAt)), { readThroughSequence: read.readThroughSequence, remainingUnreadCount: read.remainingUnreadCount, ...(read.earlierFactCount === undefined ? {} : { earlierFactCount: read.earlierFactCount }), ...(read.contextAdvice === undefined ? {} : { contextAdvice: adviceView(read.contextAdvice) }), ...taskNumberOf(read.task) })
  },
})

/**
 * What a Message answers, as one bracketed clause.
 *
 * Resolved context when the reader's window could reach it, and the bare ref
 * otherwise: a ref is still the honest answer, and it is the one the reader can
 * hand to `team_thread message` to get the original text.
 */
function repliesToClause(replyToMessageRef: string | undefined, replyTo: ReplyContextView | undefined): string {
  if (replyToMessageRef === undefined) return ''
  return replyTo === undefined
    ? ` (replies to ${replyToMessageRef})`
    : ` (replies to @${replyTo.sender} — "${replyTo.excerpt}")`
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
  kind: 'status' | 'follow' | 'unfollow' | 'read' | 'history' | 'message',
  workspaceId: string,
  snapshot: Awaited<ReturnType<AgentTeam['readThreadForAgent']>> | ReturnType<AgentTeam['threadHistoryForAgent']>,
  attention: Awaited<ReturnType<AgentTeam['readThreadForAgent']>>['attention'],
  facts: FactView[],
  extra: { cursor?: number; hasMore?: boolean; readThroughSequence?: number; remainingUnreadCount?: number; earlierFactCount?: number; contextAdvice?: ContextAdviceView; taskNumber?: number; message?: { messageRef: string; sender: string; sequence: number; occurredAt?: string; body: string } } = {},
): { workspaceId: string; channelRef: string; anchor: { messageRef: string; sender: string; body: string; sequence: number; occurredAt?: string; replyToMessageRef?: string; replyTo?: ReplyContextView }; message?: { messageRef: string; sender: string; sequence: number; occurredAt?: string; body: string }; threadRef: string; revision: number; kind: string; following: boolean; taskRef?: string; status?: string; resolution?: string; taskNumber?: number; readThroughSequence?: number; remainingUnreadCount?: number; earlierFactCount?: number; cursor?: number; hasMore?: boolean; claims: ClaimView[]; facts: FactView[]; contextAdvice?: ContextAdviceView } {
  return {
    workspaceId, channelRef: snapshot.anchor.channelRef,
    kind, threadRef: snapshot.thread.threadRef, revision: snapshot.thread.revision,
    ...(snapshot.task === undefined ? {} : { taskRef: snapshot.task.taskRef, status: snapshot.task.status, resolution: snapshot.task.resolution }),
    ...(extra.taskNumber === undefined ? {} : { taskNumber: extra.taskNumber }),
    following: attention !== undefined,
    ...extra,
    ...(attention === undefined || extra.readThroughSequence !== undefined ? {} : { readThroughSequence: attention.readThroughSequence }),
    anchor: { messageRef: snapshot.anchor.messageRef, sender: snapshot.anchor.sender, body: snapshot.anchor.body, sequence: snapshot.anchor.sequence, occurredAt: snapshot.anchor.occurredAt, ...(snapshot.anchor.replyToMessageRef === undefined ? {} : { replyToMessageRef: snapshot.anchor.replyToMessageRef }), ...(snapshot.anchor.replyTo === undefined ? {} : { replyTo: snapshot.anchor.replyTo }) },
    claims: snapshot.claims.map(claimView),
    facts,
  }
}

/** Render one read-time acceptance advice; unavailable never prints a fabricated number. */
function adviceLines(advice: ContextAdviceView): string[] {
  const measured = advice.usageTokens !== undefined && advice.taskBoundaryThreshold !== undefined && advice.handoffAt !== undefined && advice.hardLimit !== undefined
  const summary = measured
    ? `${advice.usageTokens!.toLocaleString('en-US')} tokens used; Task-boundary threshold ${advice.taskBoundaryThreshold!.toLocaleString('en-US')}; normal handoff at ${advice.handoffAt!.toLocaleString('en-US')}; hard limit ${advice.hardLimit!.toLocaleString('en-US')}.`
    : 'Context usage could not be measured for this acceptance.'
  return [`Context guidance — ${summary}`, `Action: ${advice.action}. ${advice.guidance}`]
}

const teamMessage = markAgentTeamPreset(defineTool({
  name: 'team_message',
  description: 'Start a top-level Thread, reply to an existing Thread, or send a direct message (DM). Read the Thread first: a reply needs the current next-write token from a fully drained team_thread read (or your own last committed mutation), and unread work rejects before staleness is even checked — and a mention only delivers its Message and restores Attention, never the Thread\'s earlier facts, so entering a Thread whose facts have left your context means reading back through it first. start defaults to a taskless Thread; pass asTask true to create a Task in the same send. A top-level start may mention related Agents directly; in replies, only a Human can invite a Member the Thread has never carried. Mention by writing `@Handle` in body — the `@` is required, matching ignores case, and each named Member is delivered to and renders as a mention chip; `@all` reaches every Member of the Channel. Naming a Member this Thread has never carried still commits, delivers nothing to that Member, and reports them under undeliveredMentions: ask the Human to invite them, or reach them with a dm. dm sends a private direct message to one enabled Agent Member in your Workspace: use it for quick clarifications and status syncs — never for task work, decisions, or anything that needs team visibility or traceability (use a Thread); if a DM exchange with the same Member exceeds about 3 exchanges, move it to a Thread, because every DM costs the recipient a full agent turn.',
  parameters: {
    action: { type: 'string', required: true, enum: ['start', 'reply', 'dm'] },
    channelRef: { type: 'string', description: "Full branded Channel ref exactly as returned by Team tools, including the 'channel:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    threadRef: { type: 'string', description: "Full branded Thread ref exactly as returned by Team tools, including the 'thread:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    taskRef: { type: 'string', description: "Optional Task ref alias for reply on a Taskful Thread. Prefer threadRef; an unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    replyToMessageRef: { type: 'string', description: "Optional: the full branded Message ref you are answering (as rendered by team_thread or an inbox notice). Reply on the Thread you are already replying to; the Message must be one this Thread recorded. The Host links the reply to it, and its author is then delivered to like a mention, so answering a peer reaches them without typing their handle." },
    memberRef: { type: 'string', description: "Full branded Member ref exactly as returned by Team tools, including the 'member:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves. Required for dm; the Member must be an enabled Agent in your Workspace (the Human cannot be DMed)." },
    asTask: { type: 'boolean', description: 'When true, start creates a Task with the Thread. Default false creates a taskless Thread.' },
    body: { type: 'string', required: true, description: "Markdown body. Lead with the conclusion or state. Mention the Human only when they must know or decide; when a decision is owed, say plainly what needs deciding and what happens by default if nobody answers — no fixed template. Keep it the shortest useful message for the recipients; mechanical detail follows below. Cite Team refs exactly as returned, as bare text with one colon (e.g. task:0f0a…) — never a double colon, never inside backticks or quotes. Unambiguous UUID abbreviations (first 6+ hex chars) also resolve. Mention a Member by writing `@Handle` (`@` required, case-insensitive) in the prose: that is what delivers the Message to them and renders the mention chip, and `@all` reaches the whole Channel." }, baseRevision: { type: 'number', description: "The next-write token from your latest fully drained team_thread read (or your own last committed mutation) on this Thread. Copy the explicitly rendered value verbatim; never increment, derive, compare, or cite it — it is an opaque concurrency token, not a fact about the Thread." },
    attachments: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to share, e.g. screenshots or generated artifacts; images render as thumbnails for recipients. The Host validates each path and copies the file into the attachment cache, and members also receive one cached path per attachment; if any path fails validation the whole send is rejected.' },
    workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true }, action: { type: 'string' }, taskRef: { type: 'string' }, threadRef: { type: 'string' }, revision: { type: 'number' },
      expectedRevision: { type: 'number' }, messageRef: { type: 'string' }, memberIds: { type: 'array', items: { type: 'string' } }, unreadCount: { type: 'number' }, directCount: { type: 'number' },
      recipientMemberId: { type: 'string' }, recipientHandle: { type: 'string' }, delivered: { type: 'boolean' }, deliveryNote: { type: 'string' }, occurredAt: { type: 'string' },
      undeliveredMentions: { type: 'array', items: { type: 'string' } },
    } },
    render: (_args, value) => {
      if (value.kind === 'dm-sent') {
        if (value.delivered === false) return [{ type: 'text', text: [
          `Recorded, not delivered — DM to @${value.recipientHandle} (${value.recipientMemberId}).`,
          'No automatic redelivery will occur; do not blindly send a duplicate.',
          `Reason: ${value.deliveryNote ?? 'the recipient session could not be woken'}`,
        ].join('\n') }]
        return [{ type: 'text', text: `Delivered — DM to @${value.recipientHandle} (${value.recipientMemberId})${value.occurredAt === undefined ? '' : ` at ${formatTeamTimestamp(value.occurredAt)}`}.` }]
      }
      if (value.kind === 'committed' && value.messageRef !== undefined && value.threadRef !== undefined && value.revision !== undefined) {
        return [{ type: 'text', text: [
          value.action === 'start' ? 'Committed — Thread created.' : 'Committed — reply added.',
          [value.messageRef, value.threadRef, ...(value.taskRef === undefined ? [] : [value.taskRef])].join(' · '),
          ...(value.occurredAt === undefined ? [] : [`Committed at ${formatTeamTimestamp(value.occurredAt)}`]),
          ...(value.undeliveredMentions === undefined || value.undeliveredMentions.length === 0 ? [] : [
            `Mention not delivered — ${value.undeliveredMentions.join(', ')} never took part in this Thread, so nothing reached them. Only a Human can invite a Member: reach them with a dm, or ask the Human.`,
          ]),
          nextWriteLine(value.revision),
        ].join('\n') }]
      }
      return [{ type: 'text', text: rejectionLines('message', value).join('\n') }]
    },
    // Minimal durable projection for the Host's context timeline: the
    // structured outcome identity (never the render text). The effect-anchor
    // fold reads `kind === 'committed'` + threadRef from the persisted
    // tool/result meta — a start's Thread is born here, in the result.
    presentationMeta: (_args, value): Record<string, string> => value.kind === 'committed' && value.threadRef !== undefined
      ? { kind: value.kind, threadRef: value.threadRef, ...(value.taskRef === undefined ? {} : { taskRef: value.taskRef }) }
      : { kind: value.kind },
  },
  async execute(args, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_message requires an Agent session')
    const host = service(agent)
    const rawPaths = args.attachments
    const attachmentPaths = Array.isArray(rawPaths) ? rawPaths.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : undefined
    const paths = attachmentPaths !== undefined && attachmentPaths.length > 0 ? { attachmentPaths } : {}
    if (args.action === 'start') {
      if (args.channelRef === undefined || args.taskRef !== undefined || args.threadRef !== undefined || args.baseRevision !== undefined) throw new Error('start requires channelRef and does not accept threadRef, taskRef, or baseRevision')
      const result = await host.sendMessageForAgent(agent, { requestId: requestId(agent.id, exec.callId), workspaceId: workspaceOf(args, agent),
        channelRef: args.channelRef as never, body: args.body, asTask: args.asTask === true, ...paths })
      return messageOutcome(result, 'start')
    }
    if (args.action === 'dm') {
      if (args.memberRef === undefined || args.channelRef !== undefined || args.threadRef !== undefined || args.taskRef !== undefined
        || args.baseRevision !== undefined || args.asTask !== undefined || attachmentPaths !== undefined) {
        throw new Error('dm requires memberRef and body only; it does not accept channelRef, threadRef, taskRef, baseRevision, asTask, or attachments')
      }
      try {
        const result = await host.dmForAgent(agent, { requestId: requestId(agent.id, exec.callId), workspaceId: workspaceOf(args, agent),
          recipientMemberId: args.memberRef as AgentTeamMemberId, body: args.body })
        return { kind: 'dm-sent', recipientMemberId: result.recipient.memberId, recipientHandle: result.recipient.handle, delivered: true, occurredAt: result.receipt.occurredAt }
      } catch (error) {
        if (error instanceof AgentTeamDmDeliveryError) {
          return { kind: 'dm-sent', recipientMemberId: error.recipientMemberId, recipientHandle: error.recipientHandle, delivered: false, deliveryNote: error.message }
        }
        throw error
      }
    }
    const baseRevision = args.baseRevision
    if ((args.threadRef === undefined && args.taskRef === undefined) || args.channelRef !== undefined || args.asTask !== undefined || typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 1) {
      throw new Error('reply requires threadRef and a positive baseRevision; drain the Thread with team_thread read and copy the token it renders, or reuse the one your own last committed mutation rendered')
    }
    const result = await host.replyForAgent(agent, { requestId: requestId(agent.id, exec.callId), workspaceId: workspaceOf(args, agent),
      ...(args.threadRef === undefined ? {} : { threadRef: args.threadRef as AgentTeamThreadRef }),
      ...(args.taskRef === undefined ? {} : { taskRef: args.taskRef as AgentTeamTaskRef }),
      ...(args.replyToMessageRef === undefined ? {} : { replyToMessageRef: args.replyToMessageRef as AgentTeamMessageRef }),
      body: args.body, baseRevision, ...paths })
    return messageOutcome(result, 'reply')
  },
}))

function messageOutcome(result: Awaited<ReturnType<AgentTeam['sendMessageForAgent']>> | Awaited<ReturnType<AgentTeam['replyForAgent']>>, action: 'start' | 'reply') {
  if (result.kind === 'committed') {
    // A start always delivers to the Members it names — they begin following the
    // new Thread — so only a reply can report names the Thread has never carried.
    const undelivered = 'undeliveredMentions' in result ? result.undeliveredMentions : undefined
    return { kind: result.kind, action, threadRef: result.thread.threadRef,
      ...(result.task === undefined ? {} : { taskRef: result.task.taskRef }),
      revision: result.thread.revision, messageRef: result.message.messageRef, occurredAt: result.receipt.occurredAt,
      ...(undelivered === undefined || undelivered.length === 0 ? {} : { undeliveredMentions: [...undelivered] }) }
  }
  if (result.kind === 'member_not_following') return { kind: result.kind, memberIds: [...result.memberIds],
    ...(result.taskRef === undefined ? {} : { taskRef: result.taskRef }), ...(result.threadRef === undefined ? {} : { threadRef: result.threadRef, revision: result.revision }) }
  if (result.kind === 'unread_required') return { kind: result.kind, ...(result.taskRef === undefined ? {} : { taskRef: result.taskRef }), threadRef: result.threadRef,
    revision: result.revision, unreadCount: result.unreadCount, directCount: result.directCount }
  if (result.kind === 'stale_revision') return { kind: result.kind, ...(result.taskRef === undefined ? {} : { taskRef: result.taskRef }), threadRef: result.threadRef,
    expectedRevision: result.expectedRevision, revision: result.revision }
  throw new Error('Agents cannot receive invitation confirmations')
}

const teamClaim = defineTool({
  name: 'team_claim',
  description: 'List or mutate your Direction Claims. A Claim is your one-sentence direction statement on a Task — "the angle I am taking" — so others can spot collisions and track progress: Tasks define scope (owned by Humans), Claims declare the angle (owned by you). Good direction: "Unify the four form dialogs on shared field components before wiring submits." Bad direction: a multi-paragraph plan with step order, file lists, or acceptance criteria — those belong in Thread messages, not the Claim. Mutations require the current next-write token from a fully drained team_thread read (or your own last committed mutation); list refreshes the collision surface only and authorizes no mutation.',
  parameters: {
    action: { type: 'string', required: true, enum: ['list', 'claim', 'done', 'release'] },
    taskRef: { type: 'string', required: true, description: "Full branded Task ref exactly as returned by Team tools, including the 'task:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    baseRevision: { type: 'number', description: "The next-write token from your latest fully drained team_thread read (or your own last committed mutation) on this Task's Thread. Copy the explicitly rendered value verbatim; never increment, derive, compare, or cite it — it is an opaque concurrency token, not a fact about the Task." }, direction: { type: 'string' },
    claimRef: { type: 'string', description: "Full branded Claim ref exactly as returned by team_claim, including the 'claim:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      kind: { type: 'string', required: true }, action: { type: 'string' }, taskRef: { type: 'string', required: true }, threadRef: { type: 'string', required: true },
      revision: { type: 'number', required: true }, expectedRevision: { type: 'number' }, status: { type: 'string', required: true },
      unreadCount: { type: 'number' }, directCount: { type: 'number' }, occurredAt: { type: 'string' },
      claim: { type: 'object', additionalProperties: false, properties: {
        claimRef: { type: 'string', required: true }, direction: { type: 'string', required: true }, state: { type: 'string', required: true }, owner: { type: 'string', required: true },
      } },
      claims: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { claimRef: { type: 'string', required: true }, direction: { type: 'string', required: true }, state: { type: 'string', required: true }, owner: { type: 'string', required: true } } } },
    } },
    // A committed mutation renders the authoritative affected Claim first —
    // the Host result carries it; the full archive is never appended. list
    // renders the active collision surface and no write token: a current
    // Thread read remains the required mutation basis. Rejections share the
    // outcome-first recovery form and never a numeric revision.
    render: (_args, value) => {
      if (value.kind === 'listed') {
        const active = value.claims.filter(claim => claim.state === 'active')
        return [{ type: 'text', text: [
          `Claims for ${value.taskRef} · ${value.threadRef} · ${value.status}`,
          'Active Claims',
          ...(active.length === 0 ? ['No active Claims.'] : active.map(claim => claimLine(claim))),
        ].join('\n') }]
      }
      if (value.kind === 'committed' && value.claim !== undefined) {
        return [{ type: 'text', text: [
          `Committed — Claim ${value.action === 'claim' ? 'created' : value.action === 'done' ? 'completed' : 'released'}.`,
          `${value.claim.claimRef} · ${value.claim.state} — ${value.claim.owner}: ${value.claim.direction}`,
          `${value.threadRef} · ${value.taskRef} · ${value.status}`,
          ...(value.occurredAt === undefined ? [] : [`Committed at ${formatTeamTimestamp(value.occurredAt)}`]),
          nextWriteLine(value.revision),
        ].join('\n') }]
      }
      return [{ type: 'text', text: rejectionLines('Claim mutation', value).join('\n') }]
    },
  },
  async execute(args, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_claim requires an Agent session')
    const host = service(agent)
    const base = { workspaceId: workspaceOf(args, agent), taskRef: args.taskRef as AgentTeamTaskRef }
    if (args.action === 'list') {
      if (args.baseRevision !== undefined || args.direction !== undefined || args.claimRef !== undefined) throw new Error('list takes only taskRef — drop baseRevision, direction, and claimRef, then retry')
      const listed = host.listClaimsForAgent(agent, base)
      return { kind: 'listed', taskRef: listed.task.taskRef, threadRef: listed.thread.threadRef, revision: listed.thread.revision, status: listed.task.status,
        claims: listed.claims.map(claimView) }
    }
    const baseRevision = args.baseRevision
    if (typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 1) throw new Error('claim mutation requires a positive baseRevision; drain the Thread with team_thread read and copy the token it renders, or reuse the one your own last committed mutation rendered')
    if (args.action === 'claim' && (args.direction === undefined || args.claimRef !== undefined)) throw new Error('claim requires direction and does not accept claimRef')
    if ((args.action === 'done' || args.action === 'release') && (args.claimRef === undefined || args.direction !== undefined)) throw new Error(`${args.action} requires claimRef and does not accept direction`)
    const result = await host.changeClaimForAgent(agent, { requestId: requestId(agent.id, exec.callId), ...base, action: args.action,
      baseRevision, ...(args.direction === undefined ? {} : { direction: args.direction }), ...(args.claimRef === undefined ? {} : { claimRef: args.claimRef as AgentTeamClaimRef }) })
    // Structured compatibility: every mutation outcome re-reads the real
    // Claim archive and Task status, exactly as the parent version did —
    // the render layer is what omits the archive, never the structured value.
    const listed = host.listClaimsForAgent(agent, base)
    const claims = listed.claims.map(claimView)
    if (result.kind === 'committed') return { kind: result.kind, action: args.action, taskRef: result.task.taskRef, threadRef: result.thread.threadRef,
      revision: result.thread.revision, status: result.task.status, claim: claimView(result.claim), claims, occurredAt: result.receipt.occurredAt }
    if (result.kind === 'unread_required') return { kind: result.kind, taskRef: listed.task.taskRef, threadRef: result.threadRef,
      revision: result.revision, status: listed.task.status, unreadCount: result.unreadCount, directCount: result.directCount, claims }
    return { kind: result.kind, taskRef: listed.task.taskRef, threadRef: result.threadRef, expectedRevision: result.expectedRevision,
      revision: result.revision, status: listed.task.status, claims }
  },
})

const teamView = defineTool({
  name: 'team_view',
  description: 'Discover your authorized Team addresses: current Channels, a newest-first page of top-level Threads (each with its bounded anchor subject; Task standing inline on taskful rows), current Members, and an「active task threads」section listing the work in flight right now — every in_progress / in_review Task Thread in your Channels, with its subject and the Members already on it. This is an address book, not a work queue: unread work lives in team_inbox, and a Thread is read with team_thread read. Consult the active-task-threads section when a Workspace change surprises you, or before you claim or commit, to tell in-flight work from a real conflict and avoid riding onto someone else\'s unpushed work — it is independent of your own unread. The cursor pages Thread rows only.',
  parameters: {
    channelRef: { type: 'string', description: "Full branded Channel ref exactly as returned by Team tools, including the 'channel:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    limit: { type: 'number' }, cursor: { type: 'number' }, workspace: workspaceParam,
  },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: {
      channels: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { channelRef: { type: 'string', required: true }, name: { type: 'string', required: true } } } },
      workspaceId: { type: 'string', required: true },
      workspaces: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { workspaceId: { type: 'string', required: true }, title: { type: 'string' }, default: { type: 'boolean', required: true } } } },
      members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        memberId: { type: 'string', required: true }, kind: { type: 'string', required: true }, handle: { type: 'string', required: true }, description: { type: 'string', required: true }, presence: { type: 'string', required: true },
      } } },
      threads: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        threadRef: { type: 'string', required: true }, channelRef: { type: 'string', required: true }, revision: { type: 'number', required: true }, messageCount: { type: 'number', required: true }, subject: { type: 'string', required: true },
        taskRef: { type: 'string' }, status: { type: 'string' }, taskNumber: { type: 'number' }, lastActivityAt: { type: 'string' },
      } } },
      activeTaskThreads: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        taskRef: { type: 'string', required: true }, threadRef: { type: 'string', required: true }, channelRef: { type: 'string', required: true }, status: { type: 'string', required: true }, subject: { type: 'string', required: true },
        taskNumber: { type: 'number' }, lastActivityAt: { type: 'string', required: true },
        members: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { memberId: { type: 'string', required: true }, name: { type: 'string', required: true } } } },
      } } },
      tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { taskRef: { type: 'string', required: true }, threadRef: { type: 'string', required: true }, channelRef: { type: 'string', required: true }, status: { type: 'string', required: true }, revision: { type: 'number' } } } },
      cursor: { type: 'number', required: true }, hasMore: { type: 'boolean', required: true }, page: { type: 'string' },
    } },
    // Address book, newest Thread first: labelled sections, one bounded
    // anchor subject per Thread row, Task standing inline on its Thread (no
    // second Task index), and a footer that calls the value a Thread cursor.
    // Continuation pages repeat only Threads — Channels and Members are
    // current address context, not members of the Thread page. No message
    // count and no revision label: neither changes the next legal action,
    // which is reading, never writing from a directory snapshot.
    render: (_args, value) => {
      const continuation = value.page === 'threads'
      const lines: string[] = [`Workspace: ${value.workspaceId}`]
      if (!continuation) {
        lines.push('Team directory', '', 'Channels — current')
        if (value.channels.length === 0) lines.push('No authorized Channels.')
        else lines.push(...value.channels.map(channel => `${channel.channelRef} · ${channel.name}`))
        lines.push('')
      }
      lines.push('Threads')
      if (value.threads.length === 0) lines.push(`No top-level Threads${!continuation && value.channels.length === 1 ? ` in ${value.channels[0]!.channelRef}` : ''} at this cursor.`)
      else lines.push(...value.threads.map(thread => `${thread.threadRef} · ${thread.channelRef}${thread.taskRef === undefined ? ' · taskless' : ` · ${taskStanding(thread)}`} — ${thread.subject}${thread.lastActivityAt === undefined ? '' : ` · last activity ${formatTeamTimestamp(thread.lastActivityAt)}`}`))
      lines.push(`Thread cursor ${value.cursor}; hasMore=${value.hasMore ? 'true' : 'false'}${value.hasMore ? ' — older Thread anchors exist; page again with this cursor.' : ' — no older Threads remain.'}`)
      if (!continuation && value.workspaces.length > 1) {
        lines.push('', 'Workspaces — you participate in')
        lines.push(...value.workspaces.map(workspace => `${workspace.workspaceId}${workspace.title === undefined ? '' : ` · ${workspace.title}`}${workspace.default ? ' · default — your Session and cwd live here' : ' — address it with the workspace argument; file work needs absolute paths'}`))
      }
      if (!continuation) {
        lines.push('', 'Members — current')
        if (value.members.length === 0) lines.push('No visible Members.')
        else lines.push(...value.members.map(m => `${m.memberId} · @${m.handle} (${m.kind}, ${m.presence})${m.description === '' ? '' : ` — ${m.description}`}`))
        lines.push('', 'Active task threads — work in flight right now')
        if (value.activeTaskThreads.length === 0) lines.push('No task thread is in flight in this Workspace.')
        else lines.push(...value.activeTaskThreads.map(t => `${t.threadRef} · ${t.channelRef} · ${t.status}${t.taskNumber === undefined ? '' : ` · #${t.taskNumber}`}${t.members.length === 0 ? '' : ` · ${t.members.map(m => `@${m.name}`).join(', ')}`} — ${t.subject} · last activity ${formatTeamTimestamp(t.lastActivityAt)}`))
        lines.push('Use this when a Workspace change surprises you, or before you claim or commit — to see who is already on a Task rather than riding onto their in-flight work. It is not the unread queue; unread work still lives in team_inbox.')
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args, exec) {
    const agent = exec.agent
    if (agent === undefined) throw new Error('team_view requires an Agent session')
    const host = service(agent)
    const workspaceId = workspaceOf(args, agent)
    const view = host.viewForAgent(agent, { workspaceId, ...(args.channelRef === undefined ? {} : { channelRef: args.channelRef as never }), ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.cursor === undefined ? {} : { cursor: args.cursor }), topLevelOnly: true, includeActivities: false, direction: 'before' })
    const visibleMemberIds = new Set(view.members.map(membership => membership.memberId))
    return {
      workspaceId,
      workspaces: view.workspaces.map(participation => ({ workspaceId: participation.workspaceId,
        ...(participation.title === undefined ? {} : { title: participation.title }), default: participation.default })),
      channels: view.channels.map(channel => ({ channelRef: channel.channelRef, name: channel.name })),
      members: [
        { memberId: view.humanMemberId, kind: 'human', handle: host.humanHandle(), description: 'Human Team Member', presence: 'available' },
        ...host.members().filter(status => visibleMemberIds.has(status.member.memberId)).map(status => ({ memberId: status.member.memberId,
          kind: 'agent', handle: status.member.handle, description: status.member.description, presence: status.presence })),
      ],
      threads: view.items.map(item => {
        const thread = item.thread
        const task = item.task
        return { threadRef: thread.threadRef, channelRef: item.message.channelRef, revision: thread.revision, messageCount: item.messageCount,
          subject: boundedSubject(item.message.body), lastActivityAt: item.lastActivityAt,
          ...(task === undefined ? {} : { taskRef: task.taskRef, status: task.status, ...(item.taskNumber === undefined ? {} : { taskNumber: item.taskNumber }) }) }
      }),
      // A Task's revision is its Thread's; it is omitted rather than reported as
      // `0` when the Task's Thread is outside this directory page's scope. A
      // fabricated revision would read as "this Thread has never been written".
      tasks: view.tasks.map(task => {
        const revision = view.threads.find(thread => thread.threadRef === task.threadRef)?.revision
        return { taskRef: task.taskRef, threadRef: task.threadRef, channelRef: task.channelRef, status: task.status,
          ...(revision === undefined ? {} : { revision }) }
      }),
      activeTaskThreads: view.activeTaskThreads.map(t => ({ taskRef: t.taskRef, threadRef: t.threadRef, channelRef: t.channelRef,
        status: t.status, subject: t.subject, lastActivityAt: t.lastActivityAt,
        ...(t.taskNumber === undefined ? {} : { taskNumber: t.taskNumber }),
        members: t.members.map(m => ({ memberId: m.memberId, name: m.name })) })),
      cursor: view.cursor, hasMore: view.hasMore,
      ...(args.cursor === undefined ? {} : { page: 'threads' as const }),
    }
  },
})

export function apply(ctx: Context): void {
  ctx.tools.register(teamInbox)
  ctx.tools.register(teamThread)
  ctx.tools.register(teamMessage)
  ctx.tools.register(teamClaim)
  ctx.tools.register(teamView)
  registerContextTools(ctx)
}
