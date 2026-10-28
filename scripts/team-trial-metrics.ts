// Usage: node --import tsx scripts/team-trial-metrics.ts <ledger-copy.sqlite> [--json]
// Requires an explicit SQLite copy. The ledger owns replay, projection and reminder filtering; this script only aggregates facts.
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { AgentTeamLedger } from '../packages/agent-team/src/ledger.ts'
import { agentTeamOperationSchema } from '../packages/agent-team/src/spec.ts'
import type { AgentTeamMemberId, AgentTeamProjectRef, AgentTeamReminderMarker, AgentTeamTaskRef, AgentTeamThreadRef } from '../packages/agent-team/src/types/entities.ts'
import type { AgentTeamOperation } from '../packages/agent-team/src/types/operations.ts'

const HUMAN = 'member:human'
const DAY_MS = 86400000
const percent = (part: number, total: number) => total === 0 ? null : Math.round(part / total * 1000) / 10
const increment = (map: Map<string, number>, key: string, amount = 1) => map.set(key, (map.get(key) ?? 0) + amount)
const keyOf = (marker: AgentTeamReminderMarker) => [marker.memberId, marker.taskRef, marker.kind, marker.baselineSequence].join('|')
const utcDay = (occurredAt: string) => Math.floor(Date.parse(occurredAt) / DAY_MS)

type OperationRecord = [AgentTeamOperation['operationId'], AgentTeamOperation]
interface ReminderEntry {
  readonly marker: AgentTeamReminderMarker
  readonly operation: AgentTeamOperation
  invalid?: { readonly sequence: number; readonly occurredAt: string }
}
interface MetricProjection {
  readonly ordered: readonly { readonly sequence: number }[]
  readonly tasks: Map<AgentTeamTaskRef, { readonly threadRef: AgentTeamThreadRef }>
  readonly reminderMarkers: Map<string, AgentTeamReminderMarker>
  readonly attentionByThread: Map<AgentTeamThreadRef, Set<AgentTeamMemberId>>
  readonly mainAttention: Map<string, { readonly memberId: AgentTeamMemberId; readonly projectRef: AgentTeamProjectRef }>
}
interface MetricLedger {
  readonly state: MetricProjection
  applyTo(target: MetricProjection, operation: AgentTeamOperation): void
  sortedRecords(): OperationRecord[]
  liveReminderMarkersFrom(projection: MetricProjection, memberId: AgentTeamMemberId, threadRef: AgentTeamThreadRef): readonly AgentTeamReminderMarker[]
}
const internals = (ledger: AgentTeamLedger) => ledger as unknown as MetricLedger

function readOperations(path: string): OperationRecord[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare('SELECT key, value FROM u_agent_team_operations').all()
      .map(row => {
        const { key, value } = row as { key: string; value: string }
        return [key as AgentTeamOperation['operationId'], agentTeamOperationSchema.parse(JSON.parse(value))] as OperationRecord
      })
      .sort((left, right) => left[1].sequence - right[1].sequence)
  } finally { database.close() }
}

function replay(records: readonly OperationRecord[]): AgentTeamLedger {
  // Constructor replay reads entries repeatedly; values() creates a fresh iterator each time.
  return new AgentTeamLedger({ entries: () => records.values() } as ConstructorParameters<typeof AgentTeamLedger>[0])
}

function agentReplyMetric(state: { messageSenders: Map<string, AgentTeamMemberId> }, operation: AgentTeamOperation,
  scope: 'thread' | 'main', message: { sender: AgentTeamMemberId; replyToMessageRef?: string | undefined },
  mentions: readonly AgentTeamMemberId[]) {
  const recipients = new Set(mentions)
  if (message.replyToMessageRef !== undefined) {
    const sender = state.messageSenders.get(message.replyToMessageRef)
    if (sender !== undefined && sender !== message.sender) recipients.add(sender)
  }
  return { scope, sequence: operation.sequence, occurredAt: operation.occurredAt,
    agentToAgent: [...recipients].some(memberId => memberId !== HUMAN) }
}

export function calculateTrialMetrics(records: readonly OperationRecord[]) {
  const ledger = replay(records)
  // Replay once for schema/legacy normalization, then fold the normalized
  // operations into a genuinely empty projection. Reusing the constructor's
  // final state here would count historical Attention rows before their
  // establishing operation and overstate delivery during the trial.
  const projectionLedger = new AgentTeamLedger({ entries: () => [].values() } as ConstructorParameters<typeof AgentTeamLedger>[0])
  const projection = internals(projectionLedger).state
  const operations = internals(ledger).sortedRecords().map(([, operation]) => operation)
  const adoption = operations.find(operation => operation.kind === 'team/rules-version-adopted' && operation.data.version >= 2)
  const baselineSequence = adoption?.sequence ?? operations[0]?.sequence ?? 0
  const baselineMs = Date.parse(adoption?.occurredAt ?? operations[0]?.occurredAt ?? new Date(0).toISOString())
  const trialOperations = operations.filter(operation => operation.sequence >= baselineSequence)
  const state = { messageSenders: new Map<string, AgentTeamMemberId>() }
  const replies: ReturnType<typeof agentReplyMetric>[] = []
  const mainPostsByNonOwner: number[] = []
  const resolutions: { sequence: number; occurredAt: string; kind: string; byHuman: boolean; taskRef: string }[] = []
  const immediate = new Map<string, number>()
  const dailyByMember = new Map<string, Map<string, number>>()
  const reminders = new Map<string, ReminderEntry>()
  const consumedAfterInvalidation: ReminderEntry[] = []
  let consumed = 0
  const notify = (memberId: AgentTeamMemberId, operation: AgentTeamOperation, owners: ReadonlySet<string>, amount = 1) => {
    if (memberId === HUMAN || ledger.getMember(memberId) === undefined) return
    increment(immediate, memberId, amount)
    if (owners.has(memberId)) {
      const byDay = dailyByMember.get(memberId) ?? new Map<string, number>()
      dailyByMember.set(memberId, byDay)
      increment(byDay, operation.occurredAt.slice(0, 10), amount)
    }
  }
  for (const operation of operations) {
    const inTrial = operation.sequence >= baselineSequence
    const data = operation.data
    const projectRef = data.projectRef ?? data.project?.projectRef ?? data.task?.projectRef ?? data.anchor?.projectRef ?? data.message?.projectRef
    const actor = operation.actor.kind === 'host' ? undefined : operation.actor.memberId
    const owners = new Set(projectRef === undefined ? [] : ledger.projectOwnerIds(projectRef as AgentTeamProjectRef))
    if (inTrial && operation.kind === 'team/project-owner-added' && data.memberId !== HUMAN && !dailyByMember.has(data.memberId)) dailyByMember.set(data.memberId, new Map())
    if (inTrial && operation.kind === 'team/reminder-raised') {
      const marker = data.inbox.reminderMarkers.added[0]!
      notify(marker.memberId, operation, owners)
      reminders.set(keyOf(marker), { marker, operation })
    } else if (inTrial && data.inbox !== undefined) {
      for (const marker of data.inbox.directMarkers.added) notify(marker.memberId, operation, owners)
      for (const marker of data.inbox.activityMarkers.added) notify(marker.memberId, operation, owners)
      for (const marker of data.inbox.mainMarkers?.added ?? []) notify(marker.memberId, operation, owners)
      if (operation.kind === 'team/main-message-posted' || (operation.kind === 'team/thread-started' && data.kind === 'discussion')
        || operation.kind === 'team/project-owner-added' || operation.kind === 'team/project-owner-removed') {
        const followers = new Set<AgentTeamMemberId>([HUMAN as AgentTeamMemberId])
        for (const attention of projection.mainAttention.values()) {
          if (attention.projectRef === projectRef) followers.add(attention.memberId)
        }
        for (const memberId of followers) if (memberId !== actor) notify(memberId, operation, owners)
      }
      if (operation.kind === 'team/thread-replied') {
        for (const memberId of internals(ledger).state.attentionByThread.get(data.thread.threadRef) ?? []) {
          if (memberId === actor) continue
          notify(memberId, operation, owners)
        }
      }
    }
    if (inTrial && (operation.kind === 'team/thread-replied' || operation.kind === 'team/main-message-posted') && data.message.sender !== HUMAN) {
      replies.push(agentReplyMetric(state, operation, operation.kind === 'team/thread-replied' ? 'thread' : 'main', data.message, data.mentions))
    }
    if (inTrial && operation.kind === 'team/main-message-posted' && actor !== undefined && actor !== HUMAN && !owners.has(actor)) mainPostsByNonOwner.push(operation.sequence)
    if (inTrial && operation.kind === 'team/task-changed' && (data.activity.kind === 'accept' || data.activity.kind === 'close')) {
      resolutions.push({ sequence: operation.sequence, occurredAt: operation.occurredAt, kind: data.activity.kind,
        byHuman: operation.actor.kind === 'human', taskRef: data.task.taskRef })
    }
    if (operation.kind === 'team/message-sent' || operation.kind === 'team/thread-replied' || operation.kind === 'team/thread-started' || operation.kind === 'team/main-message-posted') {
      const message = operation.kind === 'team/thread-started' ? data.anchor : data.message
      state.messageSenders.set(message.messageRef, message.sender)
    }
    for (const marker of data.inbox?.reminderMarkers?.removed ?? []) {
      const pending = reminders.get(keyOf(marker))
      if (pending !== undefined) {
        consumed += 1
        if (pending.invalid !== undefined) consumedAfterInvalidation.push(pending)
      }
      reminders.delete(keyOf(marker))
    }
    internals(ledger).applyTo(projection, operation)
    for (const pending of reminders.values()) {
      if (pending.invalid !== undefined) continue
      const threadRef = projection.tasks.get(pending.marker.taskRef)?.threadRef
      const live = threadRef !== undefined && internals(ledger).liveReminderMarkersFrom(projection, pending.marker.memberId, threadRef).includes(pending.marker)
      if (!live) pending.invalid = { sequence: operation.sequence, occurredAt: operation.occurredAt }
    }
  }
  const reminderOperations = trialOperations.filter(operation => operation.kind === 'team/reminder-raised')
  const historicalReminders = [...reminders.values()]
  const staleUnread = historicalReminders.filter(entry => entry.invalid !== undefined)
  const lastSequence = trialOperations.at(-1)?.sequence ?? 0
  const lastMs = Date.parse(trialOperations.at(-1)?.occurredAt ?? new Date(baselineMs).toISOString())
  const utcCalendarDays = trialOperations.length === 0 ? 0 : utcDay(new Date(lastMs).toISOString()) - utcDay(new Date(baselineMs).toISOString()) + 1
  const ownerDaily = [...dailyByMember].flatMap(([memberId, byDay]) => [...byDay].sort().map(([date, count]) => ({ date, memberId, immediateNotificationFacts: count })))
  const deliveryCounts = (selected: Map<string, number>) => ({
    immediateNotificationFactsByMember: Object.fromEntries([...selected].sort()),
    immediateNotificationFactsPerUtcCalendarDayByMember: Object.fromEntries([...selected].sort().map(([memberId, count]) => [memberId, utcCalendarDays === 0 ? 0 : Math.round(count / utcCalendarDays * 100) / 100])),
  })
  return {
    range: { baselineSequence, lastSequence, baselineOccurredAt: new Date(baselineMs).toISOString(),
      lastOccurredAt: new Date(lastMs).toISOString(), utcCalendarDays },
    agentReplies: { total: replies.length, agentToAgent: replies.filter(reply => reply.agentToAgent).length,
      agentToAgentPercent: percent(replies.filter(reply => reply.agentToAgent).length, replies.length),
      byScope: Object.fromEntries(['thread', 'main'].map(scope => [scope, {
        total: replies.filter(reply => reply.scope === scope).length,
        agentToAgent: replies.filter(reply => reply.scope === scope && reply.agentToAgent).length }])) },
    resolutions: { total: resolutions.length, byHuman: resolutions.filter(entry => entry.byHuman).length,
      byHumanPercent: percent(resolutions.filter(entry => entry.byHuman).length, resolutions.length),
      acceptsByHuman: resolutions.filter(entry => entry.byHuman && entry.kind === 'accept').length,
      closesByHuman: resolutions.filter(entry => entry.byHuman && entry.kind === 'close').length },
    delivery: { allMembers: deliveryCounts(immediate),
      owners: { ...deliveryCounts(new Map([...immediate].filter(([memberId]) => dailyByMember.has(memberId)))), byUtcDay: ownerDaily } },
    mainStream: { nonOwnerPosts: mainPostsByNonOwner.length },
    reminders: { raised: reminderOperations.length,
      byKind: Object.fromEntries(['review-backlog', 'stalled'].map(kind => [kind, reminderOperations.filter(operation => operation.data.kind === kind).length])),
      byRecipient: Object.fromEntries(reminderOperations.reduce((map, operation) => increment(map, operation.data.recipient), new Map<string, number>())),
      unread: historicalReminders.length, visibleUnread: historicalReminders.length - staleUnread.length, staleUnread: staleUnread.length,
      consumed, consumedAfterInvalidation: consumedAfterInvalidation.length,
      staleUnreadSamples: staleUnread.slice(0, 20).map(entry => ({
        ...entry.marker, reminderSequence: entry.operation.sequence, invalidAtSequence: entry.invalid!.sequence })) },
    limitations: [
      'The ledger has no delivery-attempt or wake receipt. Immediate notification facts are not measured Agent interruptions; ordinary facts are counted when the reader holds the relevant Attention.',
      'Daily buckets are UTC calendar days, including the partial first and last days; owner rows omit zero days.',
      'The owners delivery subset covers Agents who held ownership during the trial; per-day rows count only facts produced while they owned the Project.',
      'A reminder superseded before its marker was consumed is a review lead, not a confirmed false positive. Confirm false positives manually.',
    ],
  }
}

function run(path: string) {
  const records = readOperations(path)
  const started = performance.now()
  replay(records)
  const result = { ...calculateTrialMetrics(records),
    validation: { records: records.length, replayValidationMs: Math.round(performance.now() - started), result: 'passed' } }
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`账本副本 ${path}`)
    console.log(`重放校验：${result.validation.records} 条通过；统计范围 ${result.range.baselineSequence}–${result.range.lastSequence}；覆盖 ${result.range.utcCalendarDays} 个 UTC 自然日（含首尾不完整日）`)
    console.log(`Agent 回复：${result.agentReplies.total} 条，Agent 之间 ${result.agentReplies.agentToAgent} 条（${result.agentReplies.agentToAgentPercent ?? 'n/a'}%）`)
    console.log(`accept/close：${result.resolutions.total} 次，Human 执行 ${result.resolutions.byHuman} 次（${result.resolutions.byHumanPercent ?? 'n/a'}%）`)
    console.log(`非 owner 的 Main stream 发言：${result.mainStream.nonOwnerPosts} 条`)
    console.log(`提醒：${result.reminders.raised} 条；未读 ${result.reminders.unread} 条；当前有效 ${result.reminders.visibleUnread} 条；已失效未读 ${result.reminders.staleUnread} 条；失效后才消费 ${result.reminders.consumedAfterInvalidation} 条`)
    console.log('owner 每个 UTC 自然日的 immediate 候选事实：')
    console.log(JSON.stringify(result.delivery.owners.byUtcDay, null, 2))
    console.log(`注意：${result.limitations.join('\n')}`)
    console.log('确认误报数：人工复查 staleUnreadSamples 与已消费提醒后另行记录，本脚本不自动判定。')
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) console.log('usage: node --import tsx scripts/team-trial-metrics.ts <ledger-copy.sqlite> [--json]')
  else {
    const path = process.argv.slice(2).find(argument => !argument.startsWith('--'))
    if (path === undefined) throw new Error('Pass a SQLite backup copy explicitly; the live ledger is never selected by default. Use --help for usage.')
    run(path)
  }
}
