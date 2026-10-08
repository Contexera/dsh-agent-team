import { describe, expect, it } from 'vitest'
import type {
  AgentTeamChannel,
  AgentTeamChannelRef,
  AgentTeamClientMemberStatus,
  AgentTeamMemberId,
} from '@contexera/dsh-agent-team/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { rosterChannelName, rosterMember } from '../src/client/refs.ts'

const workspaceId = 'workspace:00000000-0000-4000-8000-000000000000' as WorkspaceId

function channel(channelRef: string, name: string, state: AgentTeamChannel['state'] = 'active'): AgentTeamChannel {
  return {
    channelRef: channelRef as AgentTeamChannelRef,
    workspaceId,
    name,
    description: `${name} work`,
    createdAtSequence: 1,
    state,
  }
}

function status(memberId: string, handle: string, availability: AgentTeamClientMemberStatus['availability']): AgentTeamClientMemberStatus {
  return {
    member: {
      memberId: memberId as AgentTeamMemberId,
      sessionId: `session-${handle}` as unknown as SessionId,
      workspaceId,
      handle,
      description: `${handle} work`,
      presetId: 'team-member',
      state: 'enabled',
    },
    availability,
    presence: 'available',
    workspaceIds: [workspaceId],
  }
}

describe('rosterChannelName', () => {
  const channels = [channel('channel:11111111-2222-4333-8333-111111111111', '工程'), channel('channel:11112222-2222-4333-8333-222222222222', '发布')]
  it('names full and unambiguous abbreviated refs', () => {
    expect(rosterChannelName(channels, 'channel:11111111-2222-4333-8333-111111111111' as AgentTeamChannelRef)).toBe('工程')
    expect(rosterChannelName(channels, 'channel:111122' as AgentTeamChannelRef)).toBe('发布')
  })
  it('leaves unknown, ambiguous, and archived channels unresolved', () => {
    expect(rosterChannelName(channels, 'channel:99999999-2222-4333-8333-999999999999' as AgentTeamChannelRef)).toBeUndefined()
    expect(rosterChannelName(channels, 'channel:1111' as AgentTeamChannelRef)).toBeUndefined()
    const archived = [channel('channel:33333333-2222-4333-8333-333333333333', '旧频道', 'archived')]
    expect(rosterChannelName(archived, 'channel:33333333-2222-4333-8333-333333333333' as AgentTeamChannelRef)).toBeUndefined()
  })
})

describe('rosterMember', () => {
  const members = [
    status('member:6e8a5b10-df16-4ec0-943a-63738010953f', 'tars', 'active'),
    status('member:6e8a99aa-d55a-40a0-b931-9f5b563feeba', 'ferry', 'suspended'),
  ]
  const humanMemberId = 'member:00000000-0000-4000-8000-000000000001' as AgentTeamMemberId
  it('resolves active members as openable with their session', () => {
    expect(rosterMember(members, humanMemberId, 'Human', 'member:6e8a5b10-df16-4ec0-943a-63738010953f' as AgentTeamMemberId)).toEqual({
      memberId: 'member:6e8a5b10-df16-4ec0-943a-63738010953f',
      handle: 'tars',
      sessionId: 'session-tars',
      openable: true,
    })
  })
  it('resolves suspended members as labelled but not openable, and the human without a session', () => {
    expect(rosterMember(members, humanMemberId, 'Human', 'member:6e8a99aa-d55a-40a0-b931-9f5b563feeba' as AgentTeamMemberId)).toEqual({
      memberId: 'member:6e8a99aa-d55a-40a0-b931-9f5b563feeba',
      handle: 'ferry',
      openable: false,
    })
    expect(rosterMember(members, humanMemberId, 'Human', humanMemberId)).toEqual({
      memberId: humanMemberId,
      handle: 'Human',
      openable: false,
    })
  })
  it('leaves unknown and ambiguous member refs unresolved', () => {
    expect(rosterMember(members, humanMemberId, 'Human', 'member:99999999-0000-4000-8000-000000000000' as AgentTeamMemberId)).toBeUndefined()
    expect(rosterMember(members, humanMemberId, 'Human', 'member:6e8a' as AgentTeamMemberId)).toBeUndefined()
  })
})
