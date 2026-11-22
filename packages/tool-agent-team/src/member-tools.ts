import type AgentTeam from '@contexera/dsh-agent-team/host'
import { AGENT_TEAM_HUMAN_MEMBER_ID, AgentTeamDmDeliveryError, markAgentTeamPreset, reminderRefForCallId } from '@contexera/dsh-agent-team/host'
import { projectRefOf, service, workspaceOf, workspaceParam } from './host-access.ts'
import { memberTarget } from './member-target.ts'
import { recoveryFor } from '@contexera/dsh-agent-team/recovery-hints'
import type { AgentTeamAttentionSource, AgentTeamClaimRef, AgentTeamInboxReminder, AgentTeamMemberReminder, AgentTeamReminderRef, AgentTeamReminderSchedule, AgentTeamMemberId, AgentTeamRequestId, AgentTeamMessageRef, AgentTeamProjectRef, AgentTeamTaskRef, AgentTeamThreadFact, AgentTeamThreadRef } from '@contexera/dsh-agent-team/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mainEntryView, standingView } from './main-stream.ts'
import { budgetReading, readingCapacity } from './reading-budget.ts'
import { boundedSubject } from './subject.ts'
import { activityFactView, claimView, mainStreamLines, readFactView, taskCardView, teamThreadOutput,
  type ClaimView, type FactView, type ReplyContextView, type TaskCardView } from './thread-output.ts'
import { boardItemView, reminderScheduleText, teamAttentionOutput, teamDmOutput, teamInboxOutput,
  teamMessageOutput, teamReminderOutput, teamTaskOutput, teamViewOutput } from './member-output.ts'
import { blankToAbsent, OPTIONAL_ADDRESS_KEYS, requestId } from './tool-input.ts'

const OPTIONAL_COLLECTION_KEYS = ['attachments', 'sourceThreadRefs'] as const

/**
 * A reminder's schedule slots, which `create` alone takes. They are normalized
 * like an address so a model that fills every slot on a list or a cancel is not
 * charged a retry for blanks it never meant; a value that is actually there is
 * refused, because a schedule on a cancel names a reminder the caller did not pick.
 */
const OPTIONAL_SCHEDULE_KEYS = ['scheduleKind', 'at', 'minutes', 'expression'] as const

const CREATE_ONLY_REMINDER_CONTENT_KEYS = ['at', 'minutes', 'expression', 'note'] as const

/** Only the first enum value is a neutral fill; other selections remain conflicts. */
function refuseNonDefaultScheduleKind(action: 'cancel' | 'list', scheduleKind: string | undefined): void {
  if (scheduleKind === undefined || scheduleKind === 'once') return
  throw new Error(recoveryFor('action_only_arguments').sentence({ action, parameter: 'scheduleKind', owner: 'create' }))
}

export const teamInbox = defineTool({
  name: 'team_inbox',
  description: 'List your bounded Team Inbox across all joined Workspaces for triage: unread Thread summaries and one row per Project Main stream with unread for you, with counts, without message bodies and without marking anything read. Read a selected Thread with team_thread read; the inbox itself authorizes no mutation. This is your own unread queue; to see work in flight (whether or not you have unread on it), use team_task board.',
  parameters: { limit: { type: 'number' }, workspace: workspaceParam },
  output: teamInboxOutput,
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

/** Attention (following a Thread) is a different question from reading one. `status`, `follow`, and `unfollow` take one Thread address or the Main stream address, plus the routing Workspace; sharing a parameter pocket with read would put `messageRef`, `beforeSequence`, and `limit` in front of actions that never accept them. */
export const teamAttention = defineTool({
  name: 'team_attention',
  description: `Read or change your Attention — whether you are following one Thread or a Project's Main stream. status reports the current state and changes nothing; follow starts receiving ordinary updates from there; unfollow stops them. Attention is not reading: none of these actions render facts, acknowledge unread work, or hand off a write token, and reading never changes whether you follow it. Address one Thread with threadRef or taskRef (when both are given they must identify the same Thread), or address the Main stream with projectRef — never both a Thread and projectRef. Unfollowing stops ordinary updates but leaves every mention, reply and responsibility event reaching you; it does not release a Claim or drop a Task you are accountable for. While you hold an active Claim on this Thread's Task, your unfollow is refused: finish the work or release the Claim first.`,
  parameters: {
    action: { type: 'string', required: true, enum: ['status', 'follow', 'unfollow'] },
    threadRef: { type: 'string', description: "Full branded Thread ref exactly as returned by Team tools, including the 'thread:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    taskRef: { type: 'string', description: "Optional Task ref alias when this Thread has a Task. Prefer threadRef; if both are given they must identify the same Thread." },
    projectRef: { type: 'string', description: "Full branded Project ref: addresses that Project's Main stream instead of a Thread. Never with threadRef or taskRef." },
    workspace: workspaceParam,
  },
  output: teamAttentionOutput,
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

function mainAttentionResult(kind: 'status' | 'follow' | 'unfollow', workspaceId: string, projectRef: string, following: boolean, source?: AgentTeamAttentionSource) {
  return { workspaceId, projectRef, kind, scope: 'main', following, ...(source === undefined ? {} : { source }) }
}

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

export const teamThread = defineTool({
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
  output: teamThreadOutput,
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
    // The shared schema can't enforce action-specific fields; ignoring messageRef could return the whole Thread instead.
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
      if (args.threadRef === undefined) throw new Error(`message needs threadRef — ${recoveryFor('missing_thread_identity').sentence({})}`)
      if (args.beforeSequence !== undefined || args.limit !== undefined) throw new Error(recoveryFor('history_only_arguments').sentence({ action: 'message' }))
      const readBack = host.readMessageForAgent(agent, {
        workspaceId: base.workspaceId,
        threadRef: args.threadRef as AgentTeamThreadRef,
        messageRef: args.messageRef as AgentTeamMessageRef,
      })
      // Fetch Thread standing without paging older facts into a single-Message read.
      const snapshot = host.threadHistoryForAgent(agent, { ...base, beforeSequence: 1, limit: 1 })
      const status = host.attentionStatusForAgent(agent, base)
      const value = threadResult('message', base.workspaceId, snapshot, status.attention, [], {
        message: { messageRef: readBack.messageRef, sender: readBack.sender, sequence: readBack.sequence, ...(readBack.occurredAt === undefined ? {} : { occurredAt: readBack.occurredAt }), body: readBack.body, bodyOmitted: false },
        ...taskNumberOf(snapshot.task),
      })
      return budgetReading(agent, value, (candidate): string => teamThread.output.render(args, candidate as never).map((part: { type: string; text?: string }) => part.type === 'text' ? part.text : '').join('\n'), capacity).value
    }
    // A Thread read ignores paging slots: its preview and acknowledgement must use the same bounded batch.
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
    // The Host advances only through facts that fit the same render we'll return to the model.
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
export const teamDm = defineTool({
  name: 'team_dm',
  description: 'Send one private direct message to a single enabled Agent Member in your Workspace. It takes a memberRef and a body and nothing else: no Thread, no Task, no write token, and no attachments, because a DM addresses a person rather than a conversation. Use it for quick clarifications and status syncs — never for task work, decisions, or anything that needs team visibility or traceability, which belongs in a Thread reply. If an exchange with the same Member runs past about three messages, move it to a Thread: every DM costs the recipient a full agent turn. A DM is recorded whether or not the recipient session could be woken, and the result says which happened; there is no automatic redelivery, so never blindly send a duplicate. The Human cannot be DMed.',
  parameters: {
    memberRef: { type: 'string', required: true, description: "Full branded Member ref exactly as returned by Team tools, including the 'member:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves. The Member must be an enabled Agent in your Workspace (the Human cannot be DMed)." },
    body: { type: 'string', required: true, description: "Markdown body. Lead with the conclusion or state; keep it the shortest useful message for the recipient. Only the named Member receives it: @mentions in the text do not notify the Human or anyone else. Use team_message when a decision or shared work needs their attention." },
    workspace: workspaceParam,
  },
  output: teamDmOutput,
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

export const teamMessage = markAgentTeamPreset(defineTool({
  name: 'team_message',
  description: 'Post to a Project\'s Main stream, start a Thread, or reply to one. post speaks in the Project\'s Main stream — the conversation outside every Thread — and any enabled Member who participates in the Project\'s Workspace may: pass projectRef and body, mention with `@Handle`, and optionally replyToMessageRef (a Main stream Message of the same Project, whose author is delivered to). Pending Main stream entries must be complete in the current context; use team_thread read with projectRef for missing facts and acknowledgement. post has no write token. start opens a discussion or a Task (kind) and only a Project owner may — a Thread starts from a standing question or piece of work, not from conversation. Understand the Thread before replying; a write needs a current token from a drained read, your own commit, or a complete rejection that provides one. Complete Message and Activity facts in context can satisfy reading, but never acknowledge unread; every write rechecks new facts, revision, permissions and Task state. A mention supplies its Message, not earlier discussion; read missing background first. start takes kind discussion (default) or task. A mention in a start or a reply delivers its Message to that Member once and never makes them follow; `@all` is plain text under version 2 and reaches no one. A private note to one Member is team_dm, not a reply.',
  parameters: {
    action: { type: 'string', required: true, enum: ['start', 'reply', 'post'] },
    projectRef: { type: 'string', description: "Full branded Project ref exactly as returned by Team tools, including the 'project:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves. Required by start and post." },
    kind: { type: 'string', enum: ['discussion', 'task'], description: 'start only: discussion (default) opens a Thread to talk something through; task opens a Thread that carries a Task.' },
    accountable: { type: 'string', description: "start with kind task only: who becomes accountable for the new Task — any enabled Member of this Workspace, as a memberRef, @Handle, or a unique 6+ hex prefix, or 'human'; the same targets team_task transfer reaches. The named Member follows the Thread and is woken with the Task. Omit it and the Agent owner who starts the Task is accountable, or the Human when the Human starts it. It does not change who may start a Task." },
    sourceThreadRefs: { type: 'array', items: { type: 'string' }, description: 'start with kind task only: the discussion Threads this Task derives from, as full branded threadRefs of the same Project. Each becomes a source of the new Task, which the card renders there instead of in the Main stream; a Task may name several. Task Threads and other Projects are refused, and a source is fixed at creation — promoting a discussion in place records no source.' },
    threadRef: { type: 'string', description: "Full branded Thread ref exactly as returned by Team tools, including the 'thread:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    taskRef: { type: 'string', description: "Optional Task ref alias for reply on a Taskful Thread. Prefer threadRef; an unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    replyToMessageRef: { type: 'string', description: "Optional: the full branded Message ref you are answering (for post: a Main stream Message of the same Project) (as rendered by team_thread or an inbox notice). Reply on the Thread you are already replying to; the Message must be one this Thread recorded. The Host links the reply to it, and its author is then delivered to like a mention, so answering a peer reaches them without typing their handle. Use it when the link is the point — the reader needs to know which Message you are answering. A Message that only continues the Thread's conversation needs neither this nor a mention: the Thread already delivers to the Members on it, so the link would announce a delivery that was going to happen anyway." },
    body: { type: 'string', required: true, description: "Markdown body. Lead with the conclusion or state; keep it the shortest useful message for the recipients. Cite Team refs exactly as returned, as bare text with one colon (e.g. task:0f0a…) — never a double colon, never inside backticks or quotes. Unambiguous UUID abbreviations (first 6+ hex chars) also resolve. Mention a Member by writing `@Handle` (`@` required, case-insensitive) in the prose: that is what delivers the Message to them and renders the mention chip; `@all` is plain text under version 2 and delivers to no one — name each Member instead." }, baseRevision: { type: 'number', description: "The next-write token from a fully drained team_thread read, your own last committed mutation, or a complete rejection that explicitly provides one on this Thread. Copy the explicitly rendered value verbatim; never increment, derive, compare, or cite it — it is an opaque concurrency token, not a fact about the Thread." },
    attachments: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths inside your working directory to share, e.g. screenshots or generated artifacts; images render as thumbnails for recipients. Attaching files needs a file-reading or shell tool in your own tool surface (`read`, `read_image`, `bash`, or `pwsh`); the Host refuses paths outside your working directory, including symlinks that escape it, then validates and copies each file into the attachment cache, and members also receive one cached path per attachment; if any path fails validation the whole send is rejected.' },
    workspace: workspaceParam,
  },
  output: teamMessageOutput,
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
      // A filled-in kind doesn't change a post; an owner or source signals a misaddressed start.
      if (args.projectRef === undefined || args.taskRef !== undefined || args.threadRef !== undefined || args.baseRevision !== undefined) throw new Error(`post requires projectRef and does not accept threadRef, taskRef, or baseRevision — ${recoveryFor('post_requires_project').sentence({})}`)
      if (args.accountable !== undefined) throw new Error(recoveryFor('action_only_arguments').sentence({ action: 'post', parameter: 'accountable', owner: 'start' }))
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

export const teamTask = defineTool({
  name: 'team_task',
  description: 'Work with Tasks. board lists the Task board of the Projects you can see — every open Task with its status, who is accountable for it, and the Members on it, plus each Project\'s newest finished Tasks — filtered by projectRef or to your own responsibility with mine; it is current state, not unread, so check it before you claim or when a Workspace change surprises you. promote turns a discussion Thread into a Task (Project owners only) and takes accountable to name who drives it — any target transfer accepts; a Task started with team_message start takes the same field. list, claim, done and release manage your Direction Claims. Every Task has one accountable: the Human or an Agent Member. accept finishes a Task as verified work; close ends it without acceptance; reopen returns it to open work; transfer hands accountability to another enabled Member of this Workspace or back to the Human, and the new accountable starts following the Thread. Who may do which is the Host\'s call, not yours to reason around: accept belongs to the Human, to a Project owner, or to the Task\'s own accountable, and never to a Member that held any Claim on it (an Agent may accept only an in_review Task); close, reopen and transfer belong to the Human or the current accountable. Finishing your own Claim is not acceptance, and an Agent that executed a Task cannot verify it. transfer moves responsibility only — Claims and their owners stay where they are. Mutations need a current token from a drained read, your own commit, or a complete rejection that provides one. Reconsider the facts first; each attempt rechecks them and Task permissions. list only refreshes active Claims.',
  parameters: {
    action: { type: 'string', required: true, enum: ['board', 'list', 'claim', 'done', 'release', 'promote', 'accept', 'close', 'reopen', 'transfer'] },
    projectRef: { type: 'string', description: 'board only: limit the board to one Project.' },
    mine: { type: 'boolean', description: 'board only: only Tasks you are accountable for or hold a live Claim on.' },
    threadRef: { type: 'string', description: 'promote only: the discussion Thread to turn into a Task.' },
    taskRef: { type: 'string', description: "Full branded Task ref exactly as returned by Team tools, including the 'task:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    baseRevision: { type: 'number', description: "The next-write token from a fully drained team_thread read, your own last committed mutation, or a complete rejection that explicitly provides one on this Task's Thread. Copy the explicitly rendered value verbatim; never increment, derive, compare, or cite it — it is an opaque concurrency token, not a fact about the Task." },
    direction: { type: 'string', description: 'claim only: your one-sentence direction statement on the Task — the angle you are taking, so others can spot collisions and track progress. Put multi-paragraph plans, step order, file lists, and acceptance criteria in Thread messages, not the Claim.' },
    claimRef: { type: 'string', description: "Full branded Claim ref exactly as returned by team_task, including the 'claim:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    accountable: { type: 'string', description: "promote only: the Member who becomes accountable for the new Task — any enabled Member of this Workspace, as a memberRef, @Handle, or a unique 6+ hex prefix, or 'human'; the same targets transfer reaches. Omit it and the promoting owner is accountable, or the Human when the Human promotes." },
    target: { type: 'string', description: "transfer only: the Member who becomes accountable — any enabled Member of this Task's Workspace, as a memberRef, @Handle, or a unique 6+ hex prefix, or 'human' to return responsibility to the Human. Following the Thread is not required." },
    workspace: workspaceParam,
  },
  output: teamTaskOutput,
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

export const teamView = defineTool({
  name: 'team_view',
  description: 'Discover your authorized Team addresses: every active Project in the Workspace (with owners, your owner/following/none relation, and subscription counts), a newest-first page of top-level Threads in the Workspace (each with its bounded anchor subject; Task standing inline on taskful rows), and current Workspace Members. This is an address book, not a work queue: unread work lives in team_inbox, work in flight on team_task board, and a Thread is read with team_thread read. The cursor pages Thread rows only.',
  parameters: {
    projectRef: { type: 'string', description: "Full branded Project ref exactly as returned by Team tools, including the 'project:' prefix. An unambiguous abbreviation of the first 6+ UUID hex characters also resolves." },
    limit: { type: 'number' }, cursor: { type: 'number' }, workspace: workspaceParam,
  },
  output: teamViewOutput,
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
          // Keep projects with no recorded responsibilities compact; when shown, account for every grant.
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

/**
 * A Member reminder is a time promise the Member makes to itself. It is the one
 * Team surface with no other audience: creation is self-only by construction, and
 * the occurrence reaches the same private Inbox notice every other unread fact
 * travels on, so a reminder never needs a Thread, a Project, or a write token.
 */
export const teamReminder = defineTool({
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
  output: teamReminderOutput,
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
