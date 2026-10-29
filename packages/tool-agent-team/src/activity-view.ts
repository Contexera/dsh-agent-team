import { activityFact, type ActivityFact } from '@contexera/dsh-agent-team/host'
import type { AgentTeamActivity, AgentTeamMainActivity } from '@contexera/dsh-agent-team/types'

/** The immutable Activity fields a tool result carries; no current Task or Claim state is among them. */
export interface ActivityViewFields {
  readonly kind?: string
  readonly activity?: string
  readonly activityRef?: string
  readonly sequence: number
  readonly actor?: string
  readonly threadRef?: string
  readonly taskRef?: string
  readonly memberId?: string
  readonly claimRef?: string
  readonly claimRefs?: readonly string[]
  readonly completedClaimRefs?: readonly string[]
  readonly acceptedClaimRefs?: readonly string[]
  readonly releasedClaimRefs?: readonly string[]
  readonly from?: string
  readonly to?: string
  readonly refollowedMembers?: readonly string[]
}

/** Rebuild the exact Host Activity fact a view came from; a view missing its identity yields none, so it can never bind. */
export function activityFromView(value: ActivityViewFields, projectRef?: string): ActivityFact | undefined {
  if (value.kind !== 'activity' || value.activityRef === undefined || value.actor === undefined || value.activity === undefined) return undefined
  const base = { activityRef: value.activityRef, sequence: value.sequence, actor: value.actor }
  if (projectRef !== undefined) {
    if (value.memberId === undefined || (value.activity !== 'owner-added' && value.activity !== 'owner-removed')) return undefined
    return activityFact({ ...base, kind: value.activity, memberId: value.memberId, projectRef } as AgentTeamMainActivity)
  }
  if (value.threadRef === undefined || value.taskRef === undefined) return undefined
  const thread = { ...base, taskRef: value.taskRef, threadRef: value.threadRef }
  switch (value.activity) {
    case 'claim':
    case 'done':
    case 'release':
      return value.claimRef === undefined ? undefined
        : activityFact({ ...thread, kind: value.activity, claimRef: value.claimRef } as unknown as AgentTeamActivity)
    case 'claims_released':
      return value.claimRefs === undefined ? undefined
        : activityFact({ ...thread, kind: value.activity, claimRefs: [...value.claimRefs] } as unknown as AgentTeamActivity)
    case 'promote':
    case 'accept':
    case 'close':
    case 'reopen':
    case 'transfer':
      return activityFact({ ...thread, kind: value.activity, from: value.from, to: value.to,
        releasedClaimRefs: value.releasedClaimRefs === undefined ? undefined : [...value.releasedClaimRefs],
        completedClaimRefs: value.completedClaimRefs === undefined ? undefined : [...value.completedClaimRefs],
        acceptedClaimRefs: value.acceptedClaimRefs === undefined ? undefined : [...value.acceptedClaimRefs],
        refollowedMembers: value.refollowedMembers === undefined ? undefined : [...value.refollowedMembers] } as unknown as AgentTeamActivity)
    default:
      return undefined
  }
}
