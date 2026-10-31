// Read-only usage summary for an explicit Agent Team SQLite copy.
// This intentionally folds raw Inbox deltas instead of current ledger replay so old channel records remain measurable.
import { DatabaseSync } from 'node:sqlite'

const QUEUE_THRESHOLD = 8
const DAY_MS = 86400000
const jsonOutput = process.argv.includes('--json')
const databasePath = process.argv.slice(2).find(argument => !argument.startsWith('--'))

if (databasePath === undefined) {
  console.error('Usage: node --import tsx scripts/team-performance/team-live-usage.ts <ledger-copy.sqlite> [--json]')
  process.exit(2)
}

interface Operation {
  readonly sequence: number
  readonly occurredAt: string
  readonly kind: string
  readonly actor?: { readonly kind?: string; readonly memberId?: string; readonly handle?: string }
  readonly data?: Record<string, any>
}

interface Member {
  readonly memberId: string
  readonly state?: string
}

function readOperations(path: string): Operation[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare('SELECT value FROM u_agent_team_operations').all()
      .map(row => JSON.parse((row as { value: string }).value) as Operation)
      .sort((left, right) => left.sequence - right.sequence)
  } finally {
    database.close()
  }
}

function touchedThreadRefs(operation: Operation): readonly string[] {
  const data = operation.data ?? {}
  switch (operation.kind) {
    case 'team/message-sent':
    case 'team/thread-replied':
      return data.message?.threadRef === undefined ? [] : [data.message.threadRef]
    case 'team/thread-started':
      return data.anchor?.threadRef === undefined ? [] : [data.anchor.threadRef]
    case 'team/thread-promoted':
    case 'team/claim-created':
    case 'team/claim-done':
    case 'team/claim-released':
    case 'team/task-changed':
    case 'team/task-accountable-changed':
    case 'team/thread-attention-changed':
      return data.thread?.threadRef === undefined ? [] : [data.thread.threadRef]
    default:
      return []
  }
}

function inboxMemberIds(inbox: Record<string, any> | undefined): Set<string> {
  const result = new Set<string>()
  if (inbox === undefined) return result
  for (const row of inbox.attention?.set ?? []) result.add(row.memberId)
  for (const row of inbox.attention?.removed ?? []) result.add(row.memberId)
  for (const field of ['directMarkers', 'activityMarkers', 'mainMarkers', 'reminderMarkers']) {
    for (const row of inbox[field]?.added ?? []) result.add(row.memberId)
    for (const row of inbox[field]?.removed ?? []) result.add(row.memberId)
  }
  return result
}

function applyAttention(inbox: Record<string, any> | undefined, attention: Map<string, Set<string>>): void {
  for (const row of inbox?.attention?.removed ?? []) attention.get(row.threadRef)?.delete(row.memberId)
  for (const row of inbox?.attention?.set ?? []) {
    const followers = attention.get(row.threadRef) ?? new Set<string>()
    followers.add(row.memberId)
    attention.set(row.threadRef, followers)
  }
}

function quantile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return lower === upper ? sorted[lower]! : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

function distribution(values: readonly number[]) {
  return {
    count: values.length,
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    max: values.length === 0 ? null : Math.max(...values),
    atLeast2: values.filter(value => value >= 2).length,
    atLeast4: values.filter(value => value >= 4).length,
    atLeast8: values.filter(value => value >= QUEUE_THRESHOLD).length,
  }
}

function percent(part: number, total: number): number | null {
  return total === 0 ? null : Math.round(part / total * 10000) / 100
}

const operations = readOperations(databasePath)
const members = new Map<string, Member>()
const attention = new Map<string, Set<string>>()
const operationKinds = new Map<string, number>()
const affectedRows: Array<{ readonly sequence: number; readonly occurredAt: string; readonly kind: string; readonly count: number }> = []
const replyRows: Array<{ readonly sequence: number; readonly occurredAt: string; readonly count: number }> = []
const threadWriteKinds = new Set([
  'team/message-sent', 'team/thread-replied', 'team/thread-started', 'team/thread-promoted',
  'team/claim-created', 'team/claim-done', 'team/claim-released', 'team/task-changed',
  'team/task-accountable-changed', 'team/thread-attention-changed',
])
// Every Member lifecycle record carries the full Member as it stands after the
// operation, so the fold reads that snapshot exactly as ledger replay does:
// resume moves a Member back to enabled, and removal persists `inactive`.
const memberSnapshotKinds = new Set([
  'team/member-added', 'team/member-updated', 'team/member-suspended', 'team/member-resumed',
  'team/member-archived', 'team/member-removed',
])

for (const operation of operations) {
  operationKinds.set(operation.kind, (operationKinds.get(operation.kind) ?? 0) + 1)
  const data = operation.data ?? {}
  if (memberSnapshotKinds.has(operation.kind) && data.member?.memberId !== undefined) members.set(data.member.memberId, data.member)

  applyAttention(data.inbox, attention)
  if (!threadWriteKinds.has(operation.kind)) continue

  const affected = inboxMemberIds(data.inbox)
  for (const threadRef of touchedThreadRefs(operation)) {
    for (const memberId of attention.get(threadRef) ?? []) affected.add(memberId)
  }
  if (operation.actor?.kind === 'member' && operation.actor.memberId !== undefined) affected.add(operation.actor.memberId)
  const row = { sequence: operation.sequence, occurredAt: operation.occurredAt, kind: operation.kind, count: affected.size }
  affectedRows.push(row)
  if (operation.kind === 'team/thread-replied') replyRows.push({ sequence: row.sequence, occurredAt: row.occurredAt, count: row.count })
}

const lastOccurredAt = operations.at(-1)?.occurredAt
const recentCutoff = lastOccurredAt === undefined ? 0 : Date.parse(lastOccurredAt) - 30 * DAY_MS
const recent = <T extends { readonly occurredAt: string }>(rows: readonly T[]): T[] => rows.filter(row => Date.parse(row.occurredAt) >= recentCutoff)
const currentMembers = [...members.values()].filter(member => member.state !== 'archived' && member.state !== 'inactive').length
const enabledMemberIds = new Set([...members.values()].filter(member => member.state === undefined || member.state === 'enabled').map(member => member.memberId))
const memberStates = Object.fromEntries([...members.values()].reduce((counts, member) => {
  const state = member.state ?? 'unknown'
  counts.set(state, (counts.get(state) ?? 0) + 1)
  return counts
}, new Map<string, number>()))
const allFollowerCounts = [...attention.values()].map(followers => followers.size)
const enabledFollowerCounts = [...attention.values()].map(followers => [...followers].filter(memberId => enabledMemberIds.has(memberId)).length)
const thresholdRows = affectedRows.filter(row => row.count >= QUEUE_THRESHOLD)
const recentThresholdRows = recent(thresholdRows)
const thresholdByKind = Object.fromEntries([...new Set(thresholdRows.map(row => row.kind))].sort()
  .map(kind => [kind, thresholdRows.filter(row => row.kind === kind).length]))
const report = {
  databasePath,
  operationRange: operations.length === 0 ? null : { firstSequence: operations[0]!.sequence, lastSequence: operations.at(-1)!.sequence, firstOccurredAt: operations[0]!.occurredAt, lastOccurredAt },
  operationCount: operations.length,
  operationKinds: Object.fromEntries([...operationKinds].sort(([left], [right]) => left.localeCompare(right))),
  members: { current: currentMembers, enabled: enabledMemberIds.size, byState: memberStates },
  attention: {
    threadCount: attention.size,
    allMembers: distribution(allFollowerCounts),
    enabledMembers: distribution(enabledFollowerCounts),
  },
  affectedMemberEstimate: {
    threshold: QUEUE_THRESHOLD,
    allThreadWrites: distribution(affectedRows.map(row => row.count)),
    recent30dThreadWrites: distribution(recent(affectedRows).map(row => row.count)),
    thresholdHits: thresholdRows.length,
    thresholdHitPercent: percent(thresholdRows.length, affectedRows.length),
    recent30dThresholdHits: recentThresholdRows.length,
    recent30dThresholdHitPercent: percent(recentThresholdRows.length, recent(affectedRows).length),
    thresholdByKind,
  },
  replies: {
    all: distribution(replyRows.map(row => row.count)),
    recent30d: distribution(recent(replyRows).map(row => row.count)),
  },
  limitations: [
    'This report reads raw operations and Inbox deltas without current AgentTeamLedger replay, so legacy operation kinds remain measurable.',
    'Affected Member counts are conservative estimates from stored Inbox recipients, current Thread Attention after each operation, and the actor; Main stream recipient derivation is not included.',
    'The report contains counts only and never reads or prints Message bodies, handles, or operation request payloads.',
  ],
}

if (jsonOutput) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`ledger copy: ${databasePath}`)
  console.log(`operations: ${report.operationCount} (${report.operationRange?.firstOccurredAt ?? 'n/a'} – ${report.operationRange?.lastOccurredAt ?? 'n/a'})`)
  console.log(`members: ${report.members.current} current, ${report.members.enabled} enabled; Attention threads: ${report.attention.threadCount}`)
  console.log(`enabled follower count: p50 ${report.attention.enabledMembers.p50 ?? 'n/a'}, p95 ${report.attention.enabledMembers.p95 ?? 'n/a'}, max ${report.attention.enabledMembers.max ?? 'n/a'}; all durable Attention rows max ${report.attention.allMembers.max ?? 'n/a'}`)
  console.log(`thread-write affected estimate: p50 ${report.affectedMemberEstimate.allThreadWrites.p50 ?? 'n/a'}, p95 ${report.affectedMemberEstimate.allThreadWrites.p95 ?? 'n/a'}, max ${report.affectedMemberEstimate.allThreadWrites.max ?? 'n/a'}`)
  console.log(`queue threshold ${QUEUE_THRESHOLD}: ${report.affectedMemberEstimate.thresholdHits}/${report.affectedMemberEstimate.allThreadWrites.count} (${report.affectedMemberEstimate.thresholdHitPercent ?? 'n/a'}%); recent 30d ${report.affectedMemberEstimate.recent30dThresholdHits}/${report.affectedMemberEstimate.recent30dThreadWrites.count} (${report.affectedMemberEstimate.recent30dThresholdHitPercent ?? 'n/a'}%)`)
  console.log(`reply affected estimate: all p95 ${report.replies.all.p95 ?? 'n/a'}, max ${report.replies.all.max ?? 'n/a'}; recent 30d p95 ${report.replies.recent30d.p95 ?? 'n/a'}, max ${report.replies.recent30d.max ?? 'n/a'}`)
}
