import { createHash } from 'node:crypto'
import type {
  AgentTeamActivity,
  AgentTeamActivityRef,
  AgentTeamClaimRef,
  AgentTeamMainActivity,
  AgentTeamMemberId,
  AgentTeamProjectRef,
  AgentTeamTaskRef,
  AgentTeamThreadRef,
  AgentTeamWorkerRef,
  AgentTeamWorkerState,
} from './types.ts'
import type { WorkerEngine } from './worker-settings.ts'

/** One Thread Activity projected from its ledger fact alone. Absent arrays have already become empty. */
export interface ThreadActivityFact {
  readonly scope: 'thread'
  readonly activityRef: AgentTeamActivityRef
  readonly sequence: number
  readonly kind: AgentTeamActivity['kind']
  readonly actor: AgentTeamMemberId
  /** The Task this Activity is about; null on a discussion Thread, which holds no Task. */
  readonly taskRef: AgentTeamTaskRef | null
  readonly threadRef: AgentTeamThreadRef
  readonly claimRef: AgentTeamClaimRef | null
  readonly claimRefs: readonly AgentTeamClaimRef[]
  readonly completedClaimRefs: readonly AgentTeamClaimRef[]
  readonly acceptedClaimRefs: readonly AgentTeamClaimRef[]
  readonly releasedClaimRefs: readonly AgentTeamClaimRef[]
  readonly from: AgentTeamMemberId | null
  readonly to: AgentTeamMemberId | null
  readonly refollowedMembers: readonly AgentTeamMemberId[]
  readonly workerRef: AgentTeamWorkerRef | null
  readonly workerEngine: WorkerEngine | null
  readonly workerState: Exclude<AgentTeamWorkerState, 'running'> | null
  readonly workerReason: string | null
}

/** One Main stream Activity projected from its ledger fact alone. */
export interface MainActivityFact {
  readonly scope: 'main'
  readonly activityRef: AgentTeamActivityRef
  readonly sequence: number
  readonly kind: AgentTeamMainActivity['kind']
  /** The Member who acted, or the Host handle when the Host itself paused a subscription. */
  readonly actor: AgentTeamMemberId | 'agent-team'
  readonly projectRef: AgentTeamProjectRef
  /** The Agent whose ownership changed; absent on a subscription lifecycle line. */
  readonly memberId?: AgentTeamMemberId | undefined
  /** The subscription a lifecycle line concerns; absent on an ownership change. */
  readonly subscriptionRef?: import('./types.ts').AgentTeamSubscriptionRef | undefined
}

export type ActivityFact = ThreadActivityFact | MainActivityFact

/** What a surface must match before a fact digest is even considered. */
export type ActivityIdentity =
  | {
    readonly scope: 'thread'
    readonly activityRef: AgentTeamActivityRef
    readonly threadRef: AgentTeamThreadRef
  }
  | {
    readonly scope: 'main'
    readonly activityRef: AgentTeamActivityRef
    readonly projectRef: AgentTeamProjectRef
  }

export function activityFact(activity: AgentTeamActivity): ThreadActivityFact
export function activityFact(activity: AgentTeamMainActivity): MainActivityFact
export function activityFact(activity: AgentTeamActivity | AgentTeamMainActivity): ActivityFact
export function activityFact(activity: AgentTeamActivity | AgentTeamMainActivity): ActivityFact {
  if ('threadRef' in activity) {
    return {
      scope: 'thread',
      activityRef: activity.activityRef,
      sequence: activity.sequence,
      kind: activity.kind,
      actor: activity.actor,
      taskRef: activity.taskRef ?? null,
      threadRef: activity.threadRef,
      claimRef: 'claimRef' in activity ? activity.claimRef : null,
      claimRefs: 'claimRefs' in activity ? [...activity.claimRefs] : [],
      completedClaimRefs: 'completedClaimRefs' in activity ? [...(activity.completedClaimRefs ?? [])] : [],
      acceptedClaimRefs: 'acceptedClaimRefs' in activity ? [...(activity.acceptedClaimRefs ?? [])] : [],
      releasedClaimRefs: 'releasedClaimRefs' in activity ? [...(activity.releasedClaimRefs ?? [])] : [],
      from: 'from' in activity ? activity.from ?? null : null,
      to: 'to' in activity ? activity.to ?? null : null,
      refollowedMembers: 'refollowedMembers' in activity ? [...(activity.refollowedMembers ?? [])] : [],
      workerRef: 'workerRef' in activity ? activity.workerRef : null,
      workerEngine: 'engine' in activity ? activity.engine : null,
      workerState: 'state' in activity ? activity.state : null,
      workerReason: 'reason' in activity ? activity.reason ?? null : null,
    }
  }
  return {
    scope: 'main',
    activityRef: activity.activityRef,
    sequence: activity.sequence,
    kind: activity.kind,
    // A Host pause has no Member behind it; the handle names the Host itself.
    actor: activity.actor ?? 'agent-team',
    projectRef: activity.projectRef,
    ...('memberId' in activity ? { memberId: activity.memberId } : { subscriptionRef: activity.subscriptionRef }),
  }
}

export function activityIdentity(fact: ActivityFact): ActivityIdentity {
  return fact.scope === 'thread'
    ? { scope: 'thread', activityRef: fact.activityRef, threadRef: fact.threadRef }
    : { scope: 'main', activityRef: fact.activityRef, projectRef: fact.projectRef }
}

/** Complete immutable event fields, without current Task/Claim state or empty optional lists. */
export function activityText(fact: ActivityFact): string {
  if (fact.scope === 'main') {
    const subject = fact.memberId === undefined ? `Subscription ${fact.subscriptionRef ?? 'unknown'}` : `Member ${fact.memberId}`
    return `${fact.sequence} ${fact.actor} ${fact.kind} ${subject} · Project ${fact.projectRef} · ${fact.activityRef}`
  }
  const subject = fact.taskRef === null ? `Thread ${fact.threadRef}` : `Task ${fact.taskRef} · Thread ${fact.threadRef}`
  const fields = [`${fact.sequence} ${fact.actor} ${fact.kind} ${subject} · ${fact.activityRef}`]
  if (fact.claimRef !== null) fields.push(`Claim ${fact.claimRef}`)
  if (fact.claimRefs.length > 0) fields.push(`claims released ${fact.claimRefs.join(', ')}`)
  if (fact.completedClaimRefs.length > 0) fields.push(`completed claims ${fact.completedClaimRefs.join(', ')}`)
  if (fact.acceptedClaimRefs.length > 0) fields.push(`accepted claims ${fact.acceptedClaimRefs.join(', ')}`)
  if (fact.releasedClaimRefs.length > 0) fields.push(`released claims ${fact.releasedClaimRefs.join(', ')}`)
  if (fact.from !== null) fields.push(`from ${fact.from}`)
  if (fact.to !== null) fields.push(`to ${fact.to}`)
  if (fact.refollowedMembers.length > 0) fields.push(`following restored for ${fact.refollowedMembers.join(', ')}`)
  if (fact.workerRef !== null) fields.push(`Worker ${fact.workerRef}`)
  if (fact.workerEngine !== null) fields.push(`engine ${fact.workerEngine}`)
  if (fact.workerState !== null) fields.push(`state ${fact.workerState}`)
  if (fact.workerReason !== null) fields.push(`reason ${fact.workerReason}`)
  return fields.join(' · ')
}

/** Explicit field order, so a JSON round trip's property order cannot change the digest. */
function canonicalActivityFact(fact: ActivityFact): string {
  if (fact.scope === 'main') {
    return JSON.stringify([fact.scope, fact.activityRef, fact.sequence, fact.kind, fact.actor, fact.projectRef, fact.memberId])
  }
  return JSON.stringify([
    fact.scope, fact.activityRef, fact.sequence, fact.kind, fact.actor, fact.taskRef, fact.threadRef,
    fact.claimRef, fact.claimRefs, fact.completedClaimRefs, fact.acceptedClaimRefs, fact.releasedClaimRefs,
    fact.from, fact.to, fact.refollowedMembers, fact.workerRef, fact.workerEngine, fact.workerState, fact.workerReason,
  ])
}

export function activityFactDigest(fact: ActivityFact): string {
  return createHash('sha256').update(canonicalActivityFact(fact)).digest('hex')
}
