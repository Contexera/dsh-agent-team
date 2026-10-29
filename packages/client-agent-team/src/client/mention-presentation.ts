import type { AgentTeamClientMemberStatus, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import type { TeamDraftKey, TeamDraftKind } from './drafts.ts'
import { draftKindOf } from './drafts.ts'

/** The composer surfaces a mention can be written on; read from the draft key so it cannot be restated wrong. */
export type MentionSurface = TeamDraftKind

export function mentionSurfaceOf(draftKey: TeamDraftKey): MentionSurface {
  return draftKindOf(draftKey)
}

/**
 * How a candidate relates to what is being written. `owner` is a Project owner
 * (the Members who decide and can start work, so they lead the list); `thread`
 * is a follower of this Thread; `project` a Member taking part in this Project;
 * `other` a Workspace peer the Project does not yet carry — picking one enrolls
 * it into the Project, because a mention is a Project-membership fact.
 */
export type MentionGroupKey = 'owner' | 'thread' | 'project' | 'other'

export interface MentionGroup {
  readonly key: MentionGroupKey
  readonly options: readonly AgentTeamClientMemberStatus[]
}

export interface MentionRoster {
  readonly followers?: ReadonlySet<AgentTeamMemberId> | undefined
  readonly projectMembers?: ReadonlySet<AgentTeamMemberId> | undefined
  readonly owners?: ReadonlySet<AgentTeamMemberId> | undefined
}

/** Owners lead, then the conversation the reader is writing into, then the wider Workspace. */
const GROUP_ORDER: readonly MentionGroupKey[] = ['owner', 'thread', 'project', 'other']

/** Presence is the live signal; `unavailable` means offline, which no longer hides a durable mention target. */
function isOnline(status: AgentTeamClientMemberStatus): boolean {
  return status.presence !== 'unavailable'
}

function matchesQuery(status: AgentTeamClientMemberStatus, query: string): boolean {
  if (query === '') return true
  const needle = query.toLocaleLowerCase()
  return status.member.handle.toLocaleLowerCase().includes(needle)
    || status.member.description.toLocaleLowerCase().includes(needle)
}

/**
 * Every Member a mention can address, narrowed by the typed query. A Member
 * leaves the roster only by lifecycle (`inactive`/`archived` reject a mention
 * at the Host too); an offline Member stays — the mention is a durable marker
 * they read when they return.
 */
export function mentionCandidatesFor(members: readonly AgentTeamClientMemberStatus[], query: string): readonly AgentTeamClientMemberStatus[] {
  return members.filter(status => status.member.state !== 'inactive'
    && status.member.state !== 'archived'
    && matchesQuery(status, query))
}

function groupOf(status: AgentTeamClientMemberStatus, surface: MentionSurface, roster: MentionRoster): MentionGroupKey {
  const id = status.member.memberId
  if (roster.owners?.has(id) === true) return 'owner'
  if (surface === 'thread' && roster.followers?.has(id) === true) return 'thread'
  if (roster.projectMembers?.has(id) === true) return 'project'
  return 'other'
}

/** Online first, then handle order — deterministic, so the order no longer drifts with the roster's arrival order. */
function compareRows(left: AgentTeamClientMemberStatus, right: AgentTeamClientMemberStatus): number {
  const leftOnline = isOnline(left)
  const rightOnline = isOnline(right)
  if (leftOnline !== rightOnline) return leftOnline ? -1 : 1
  const a = left.member.handle.toLocaleLowerCase()
  const b = right.member.handle.toLocaleLowerCase()
  return a < b ? -1 : a > b ? 1 : 0
}

export function buildMentionGroups(members: readonly AgentTeamClientMemberStatus[], query: string, surface: MentionSurface, roster: MentionRoster): readonly MentionGroup[] {
  const buckets = new Map<MentionGroupKey, AgentTeamClientMemberStatus[]>()
  for (const status of mentionCandidatesFor(members, query)) {
    const key = groupOf(status, surface, roster)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [status])
    else bucket.push(status)
  }
  const groups: MentionGroup[] = []
  for (const key of GROUP_ORDER) {
    const bucket = buckets.get(key)
    if (bucket === undefined || bucket.length === 0) continue
    groups.push({ key, options: Object.freeze([...bucket].sort(compareRows)) })
  }
  return groups
}

/**
 * Members a pick would enroll: notified, yet not already taking part in the
 * Project. Empty when the roster is unknown (an empty set) rather than claiming
 * everyone is new.
 */
export function enrollmentIds(notified: readonly AgentTeamMemberId[], projectMembers: ReadonlySet<AgentTeamMemberId> | undefined): readonly AgentTeamMemberId[] {
  if (projectMembers === undefined || projectMembers.size === 0) return []
  return notified.filter(memberId => !projectMembers.has(memberId))
}
