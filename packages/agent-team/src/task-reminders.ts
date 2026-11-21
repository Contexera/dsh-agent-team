import type { AgentTeamClaim, AgentTeamMemberId, AgentTeamTask, AgentTeamTaskRef } from './types/entities.ts'

export const REVIEW_BACKLOG_IDLE_MS = 30 * 60 * 1000
export const STALLED_PUBLIC_MS = 24 * 60 * 60 * 1000
export const STALLED_IDLE_MS = 24 * 60 * 60 * 1000

export type ReminderKind = 'review-backlog' | 'stalled'

export interface ReminderClaimFacts {
  readonly claim: AgentTeamClaim
  readonly createdSequence: number
}

export interface ReminderTaskFacts {
  readonly task: AgentTeamTask
  readonly projectActive: boolean
  readonly statusBaselineSequence: number
  readonly statusBaselineOccurredAt: string
  readonly latestPublicSequence: number
  readonly latestPublicOccurredAt: string
  readonly claims: readonly ReminderClaimFacts[]
}

export interface ReminderEvaluationInput {
  readonly nowMs: number
  readonly tasks: readonly ReminderTaskFacts[]
  /** The Member a Task's review belongs to: its accountable when that Member may verify, otherwise the Human. */
  readonly verifierOf: (task: AgentTeamTask) => AgentTeamMemberId
  readonly isAvailable: (memberId: AgentTeamMemberId) => boolean
  /** Milliseconds idle, or undefined when this Host has not observed a complete running → idle interval. */
  readonly idleMs: (memberId: AgentTeamMemberId) => number | undefined
  readonly episodeExists: (taskRef: AgentTeamTaskRef, kind: ReminderKind, recipient: AgentTeamMemberId, baselineSequence: number) => boolean
  readonly hasUnreadResponsibility: (taskRef: AgentTeamTaskRef, recipient: AgentTeamMemberId) => boolean
}

export interface ReminderCandidate {
  readonly taskRef: AgentTeamTaskRef
  readonly kind: ReminderKind
  readonly recipient: AgentTeamMemberId
  readonly baselineSequence: number
}

function reviewBacklog(input: ReminderEvaluationInput, facts: ReminderTaskFacts): ReminderCandidate | undefined {
  const recipient = input.verifierOf(facts.task)
  const idleMs = input.idleMs(recipient)
  // Human reviewers have no Agent idle interval; use the durable status change instead.
  const ready = recipient === 'member:human'
    ? input.nowMs - Date.parse(facts.statusBaselineOccurredAt) >= REVIEW_BACKLOG_IDLE_MS
    : idleMs !== undefined && idleMs >= REVIEW_BACKLOG_IDLE_MS
  if (!ready) return undefined
  return { taskRef: facts.task.taskRef, kind: 'review-backlog', recipient, baselineSequence: facts.statusBaselineSequence }
}

function stalledTask(input: ReminderEvaluationInput, facts: ReminderTaskFacts): ReminderCandidate | undefined {
  const activeClaims = facts.claims.filter(entry => entry.claim.state === 'active')
  const quiet = input.nowMs - Date.parse(facts.latestPublicOccurredAt) > STALLED_PUBLIC_MS
  const executorIdle = activeClaims.some(entry => {
    const idleMs = input.idleMs(entry.claim.owner)
    return idleMs !== undefined && idleMs > STALLED_IDLE_MS
  })
  if (!quiet && !executorIdle) return undefined
  const baselineSequence = Math.max(facts.latestPublicSequence, ...activeClaims.map(entry => entry.createdSequence))
  return { taskRef: facts.task.taskRef, kind: 'stalled', recipient: facts.task.accountable, baselineSequence }
}

function canDeliver(input: ReminderEvaluationInput, { taskRef, kind, recipient, baselineSequence }: ReminderCandidate): boolean {
  return input.isAvailable(recipient)
    && !input.episodeExists(taskRef, kind, recipient, baselineSequence)
    && !input.hasUnreadResponsibility(taskRef, recipient)
}

export function planTaskReminders(input: ReminderEvaluationInput): readonly ReminderCandidate[] {
  const candidates: ReminderCandidate[] = []
  for (const facts of input.tasks) {
    const { task } = facts
    if (!facts.projectActive || task.resolution !== 'open') continue
    const candidate = task.status === 'in_review' ? reviewBacklog(input, facts)
      : task.status === 'in_progress' ? stalledTask(input, facts) : undefined
    if (candidate !== undefined && canDeliver(input, candidate)) candidates.push(candidate)
  }
  return candidates
}
