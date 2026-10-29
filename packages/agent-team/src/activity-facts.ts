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
} from './types.ts'

/** One Thread Activity projected from its ledger fact alone. Absent arrays have already become empty. */
export interface ThreadActivityFact {
  readonly scope: 'thread'
  readonly activityRef: AgentTeamActivityRef
  readonly sequence: number
  readonly kind: AgentTeamActivity['kind']
  readonly actor: AgentTeamMemberId
  readonly taskRef: AgentTeamTaskRef
  readonly threadRef: AgentTeamThreadRef
  readonly claimRef: AgentTeamClaimRef | null
  readonly claimRefs: readonly AgentTeamClaimRef[]
  readonly completedClaimRefs: readonly AgentTeamClaimRef[]
  readonly acceptedClaimRefs: readonly AgentTeamClaimRef[]
  readonly releasedClaimRefs: readonly AgentTeamClaimRef[]
  readonly from: AgentTeamMemberId | null
  readonly to: AgentTeamMemberId | null
  readonly refollowedMembers: readonly AgentTeamMemberId[]
}

/** One Main stream Activity projected from its ledger fact alone. */
export interface MainActivityFact {
  readonly scope: 'main'
  readonly activityRef: AgentTeamActivityRef
  readonly sequence: number
  readonly kind: AgentTeamMainActivity['kind']
  readonly actor: AgentTeamMemberId
  readonly projectRef: AgentTeamProjectRef
  readonly memberId: AgentTeamMemberId
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
      taskRef: activity.taskRef,
      threadRef: activity.threadRef,
      claimRef: 'claimRef' in activity ? activity.claimRef : null,
      claimRefs: 'claimRefs' in activity ? [...activity.claimRefs] : [],
      completedClaimRefs: 'completedClaimRefs' in activity ? [...(activity.completedClaimRefs ?? [])] : [],
      acceptedClaimRefs: 'acceptedClaimRefs' in activity ? [...(activity.acceptedClaimRefs ?? [])] : [],
      releasedClaimRefs: 'releasedClaimRefs' in activity ? [...(activity.releasedClaimRefs ?? [])] : [],
      from: 'from' in activity ? activity.from ?? null : null,
      to: 'to' in activity ? activity.to ?? null : null,
      refollowedMembers: 'refollowedMembers' in activity ? [...(activity.refollowedMembers ?? [])] : [],
    }
  }
  return {
    scope: 'main',
    activityRef: activity.activityRef,
    sequence: activity.sequence,
    kind: activity.kind,
    actor: activity.actor,
    projectRef: activity.projectRef,
    memberId: activity.memberId,
  }
}

export function activityIdentity(fact: ActivityFact): ActivityIdentity {
  return fact.scope === 'thread'
    ? { scope: 'thread', activityRef: fact.activityRef, threadRef: fact.threadRef }
    : { scope: 'main', activityRef: fact.activityRef, projectRef: fact.projectRef }
}

/** Complete immutable event fields, without current Task/Claim state or empty optional lists. */
export function activityText(fact: ActivityFact): string {
  if (fact.scope === 'main') return `${fact.sequence} ${fact.actor} ${fact.kind} Member ${fact.memberId} · Project ${fact.projectRef} · ${fact.activityRef}`
  const fields = [`${fact.sequence} ${fact.actor} ${fact.kind} Task ${fact.taskRef} · Thread ${fact.threadRef} · ${fact.activityRef}`]
  if (fact.claimRef !== null) fields.push(`Claim ${fact.claimRef}`)
  if (fact.claimRefs.length > 0) fields.push(`claims released ${fact.claimRefs.join(', ')}`)
  if (fact.completedClaimRefs.length > 0) fields.push(`completed claims ${fact.completedClaimRefs.join(', ')}`)
  if (fact.acceptedClaimRefs.length > 0) fields.push(`accepted claims ${fact.acceptedClaimRefs.join(', ')}`)
  if (fact.releasedClaimRefs.length > 0) fields.push(`released claims ${fact.releasedClaimRefs.join(', ')}`)
  if (fact.from !== null) fields.push(`from ${fact.from}`)
  if (fact.to !== null) fields.push(`to ${fact.to}`)
  if (fact.refollowedMembers.length > 0) fields.push(`following restored for ${fact.refollowedMembers.join(', ')}`)
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
    fact.from, fact.to, fact.refollowedMembers,
  ])
}

export function activityFactDigest(fact: ActivityFact): string {
  return createHash('sha256').update(canonicalActivityFact(fact)).digest('hex')
}
