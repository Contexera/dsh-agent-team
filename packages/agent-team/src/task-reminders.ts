import type { AgentTeamClaim, AgentTeamMemberId, AgentTeamProjectRef, AgentTeamTask, AgentTeamTaskRef } from './types/entities.ts'

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
  readonly isOwner: (projectRef: AgentTeamProjectRef, memberId: AgentTeamMemberId) => boolean
  readonly isAvailable: (memberId: AgentTeamMemberId) => boolean
  /** Milliseconds idle, or undefined when this Host has not observed a complete running → idle interval. */
  readonly idleMs: (memberId: AgentTeamMemberId) => number | undefined
  readonly heldEver: (taskRef: AgentTeamTaskRef, memberId: AgentTeamMemberId) => boolean
  readonly episodeExists: (taskRef: AgentTeamTaskRef, kind: ReminderKind, recipient: AgentTeamMemberId, baselineSequence: number) => boolean
  readonly hasUnreadResponsibility: (taskRef: AgentTeamTaskRef, recipient: AgentTeamMemberId) => boolean
}

export interface ReminderCandidate {
  readonly taskRef: AgentTeamTaskRef
  readonly kind: ReminderKind
  readonly recipient: AgentTeamMemberId
  readonly baselineSequence: number
}

function eligible(input: ReminderEvaluationInput, candidate: ReminderCandidate): boolean {
  return !input.episodeExists(candidate.taskRef, candidate.kind, candidate.recipient, candidate.baselineSequence)
    && !input.hasUnreadResponsibility(candidate.taskRef, candidate.recipient)
}

/** Evaluate every open Task once. Unknown runtime presence never becomes an idle duration. */
export function planTaskReminders(input: ReminderEvaluationInput): readonly ReminderCandidate[] {
  const candidates: ReminderCandidate[] = []
  for (const facts of input.tasks) {
    const { task } = facts
    if (!facts.projectActive || task.resolution !== 'open') continue
    if (task.status === 'in_review') {
      const recipient = task.accountable === 'member:human'
        || !input.isOwner(task.projectRef, task.accountable)
        || input.heldEver(task.taskRef, task.accountable)
        ? 'member:human' as AgentTeamMemberId : task.accountable
      const idleMs = input.idleMs(recipient)
      const ready = recipient === 'member:human'
        ? input.nowMs - Date.parse(facts.statusBaselineOccurredAt) >= REVIEW_BACKLOG_IDLE_MS
        : idleMs !== undefined && idleMs >= REVIEW_BACKLOG_IDLE_MS
      const candidate = { taskRef: task.taskRef, kind: 'review-backlog' as const, recipient, baselineSequence: facts.statusBaselineSequence }
      if (ready && input.isAvailable(recipient) && eligible(input, candidate)) candidates.push(candidate)
      continue
    }
    if (task.status !== 'in_progress') continue
    const activeClaims = facts.claims.filter(entry => entry.claim.state === 'active')
    const quiet = input.nowMs - Date.parse(facts.latestPublicOccurredAt) > STALLED_PUBLIC_MS
    const executorIdle = activeClaims.some(entry => {
      const idleMs = input.idleMs(entry.claim.owner)
      return idleMs !== undefined && idleMs > STALLED_IDLE_MS
    })
    const baselineSequence = Math.max(facts.latestPublicSequence, ...activeClaims.map(entry => entry.createdSequence))
    const candidate = { taskRef: task.taskRef, kind: 'stalled' as const, recipient: task.accountable, baselineSequence }
    if ((quiet || executorIdle) && input.isAvailable(task.accountable) && eligible(input, candidate)) candidates.push(candidate)
  }
  return candidates
}
