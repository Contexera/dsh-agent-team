import { useRef, useState } from 'react'
import { mintRequestId } from './requests.ts'
import type {
  AgentTeamChannelRef,
  AgentTeamJoinChannelRequest,
  AgentTeamJoinChannelResult,
  AgentTeamMemberId,
  AgentTeamRemoveChannelMemberRequest,
  AgentTeamRemoveChannelMemberResult,
  AgentTeamRequestId,
} from '@contexera/dsh-agent-team/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** One idempotent membership intent: `joined` rows leave, others join. */
export interface ChannelMembershipChange {
  readonly workspaceId: WorkspaceId
  readonly channelRef: AgentTeamChannelRef
  readonly memberId: AgentTeamMemberId
  readonly joined: boolean
}

export interface ChannelMembershipTransport {
  readonly joinChannel: (request: AgentTeamJoinChannelRequest) => Promise<RemoteResult<AgentTeamJoinChannelResult>>
  readonly removeChannelMember: (request: AgentTeamRemoveChannelMemberRequest) => Promise<RemoteResult<AgentTeamRemoveChannelMemberResult>>
}

/**
 * Shared Channel membership mutation. One stable requestId per direction,
 * Member, and Channel survives transport failures until the Host commits it;
 * rows observe pending flags and error text keyed by `rowKeyOf`.
 */
export function useChannelMembership(
  transport: ChannelMembershipTransport,
  rowKeyOf: (change: ChannelMembershipChange) => string,
  onCommitted: (change: ChannelMembershipChange) => void | Promise<void>,
): {
  readonly pending: ReadonlySet<string>
  readonly errors: ReadonlyMap<string, string>
  readonly change: (change: ChannelMembershipChange) => Promise<void>
} {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  const requestIds = useRef(new Map<string, AgentTeamRequestId>())

  const change = async (membership: ChannelMembershipChange): Promise<void> => {
    const rowKey = rowKeyOf(membership)
    if (pending.has(rowKey)) return
    setPending(current => new Set(current).add(rowKey))
    setErrors(current => { const next = new Map(current); next.delete(rowKey); return next })
    const key = `${membership.joined ? 'remove' : 'join'}:${membership.memberId}:${membership.channelRef}`
    const requestId = requestIds.current.get(key) ?? mintRequestId()
    requestIds.current.set(key, requestId)
    const request = { requestId, workspaceId: membership.workspaceId, channelRef: membership.channelRef, memberId: membership.memberId }
    try {
      const result = membership.joined ? await transport.removeChannelMember(request) : await transport.joinChannel(request)
      if (result.ok) {
        requestIds.current.delete(key)
        await onCommitted(membership)
      } else {
        setErrors(current => new Map(current).set(rowKey, result.error.message))
      }
    } catch (cause) {
      setErrors(current => new Map(current).set(rowKey, cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setPending(current => { const next = new Set(current); next.delete(rowKey); return next })
    }
  }
  return { pending, errors, change }
}
