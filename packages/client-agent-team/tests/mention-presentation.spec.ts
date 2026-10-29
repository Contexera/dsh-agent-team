import { describe, expect, it } from 'vitest'
import type { AgentTeamClientMemberStatus, AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import { buildMentionGroups, enrollmentIds, mentionCandidatesFor, mentionSurfaceOf, type MentionGroup } from '../src/client/mention-presentation.ts'

function member(handle: string, opts: { presence?: 'available' | 'working' | 'error' | 'unavailable', state?: 'enabled' | 'suspended' | 'inactive' | 'archived', description?: string } = {}): AgentTeamClientMemberStatus {
  return {
    member: {
      memberId: `member:${handle}` as AgentTeamMemberId,
      sessionId: 'session:one' as never,
      workspaceId: 'workspace:alpha' as never,
      handle,
      description: opts.description ?? '',
      presetId: 'team-member',
      state: opts.state ?? 'enabled',
    },
    availability: 'active',
    presence: opts.presence ?? 'available',
    capabilityState: 'applied',
    workspaceIds: ['workspace:alpha' as never],
  }
}

const ids = (...handles: readonly string[]): ReadonlySet<AgentTeamMemberId> =>
  new Set(handles.map(handle => `member:${handle}` as AgentTeamMemberId))

const handlesOf = (groups: readonly MentionGroup[]): readonly string[] =>
  groups.flatMap(group => group.options.map(status => status.member.handle))

const keysOf = (groups: readonly MentionGroup[]): readonly string[] => groups.map(group => group.key)

describe('mention roster grouping', () => {
  it('reads the surface from the draft key the composer already writes to', () => {
    expect(mentionSurfaceOf('thread:thread:one' as never)).toBe('thread')
    expect(mentionSurfaceOf('project:project:one' as never)).toBe('project')
  })

  it('orders owners first, then this Thread, this Project, and the rest', () => {
    const groups = buildMentionGroups(
      [member('stranger'), member('peer'), member('follower'), member('owner')], '', 'thread',
      { owners: ids('owner'), followers: ids('follower'), projectMembers: ids('peer', 'follower', 'owner') })
    expect(keysOf(groups)).toEqual(['owner', 'thread', 'project', 'other'])
    expect(handlesOf(groups)).toEqual(['owner', 'follower', 'peer', 'stranger'])
  })

  it('leaves the Thread group out on a Project surface, which has no follow set', () => {
    const groups = buildMentionGroups(
      [member('peer'), member('follower')], '', 'project',
      { owners: ids(), followers: ids('follower'), projectMembers: ids('peer', 'follower') })
    expect(keysOf(groups)).toEqual(['project'])
    expect(handlesOf(groups)).toEqual(['follower', 'peer'])
  })

  it('keeps an offline Member, because a mention is a durable marker they read on return', () => {
    const offline = member('offline', { presence: 'unavailable' })
    expect(mentionCandidatesFor([offline], '').map(status => status.member.handle)).toEqual(['offline'])
    // Lifecycle, not presence, ends eligibility: an inactive Member cannot be addressed at the Host either.
    expect(mentionCandidatesFor([member('gone', { state: 'inactive' })], '')).toEqual([])
  })

  it('sorts a group online-first then by handle, independent of arrival order', () => {
    const rows = [member('zeta'), member('alpha', { presence: 'unavailable' }), member('beta')]
    const groups = buildMentionGroups(rows, '', 'project', { projectMembers: ids('zeta', 'alpha', 'beta') })
    expect(groups[0]!.options.map(status => status.member.handle)).toEqual(['beta', 'zeta', 'alpha'])
  })

  it('matches a handle substring and a description keyword, not only a handle prefix', () => {
    const rows = [member('builder', { description: '后端接口' }), member('reviewer')]
    expect(mentionCandidatesFor(rows, 'uild').map(status => status.member.handle)).toEqual(['builder'])
    expect(mentionCandidatesFor(rows, '后端').map(status => status.member.handle)).toEqual(['builder'])
  })

  it('names only the notified Members the Project does not already carry as enrollments', () => {
    expect(enrollmentIds(['member:peer' as never, 'member:stranger' as never], ids('peer'))).toEqual(['member:stranger'])
    // An unknown roster (empty set) is not the same as "everyone is new".
    expect(enrollmentIds(['member:stranger' as never], new Set())).toEqual([])
  })
})
