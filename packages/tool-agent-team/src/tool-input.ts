import type { AgentTeamRequestId } from '@contexera/dsh-agent-team/types'

export function requestId(agentId: string, callId: string): AgentTeamRequestId {
  return `agent-team:tool:${agentId}:${callId}` as AgentTeamRequestId
}

/** Models may fill unused slots with blank values. Opt in only when blank means no intent, never for explicit clears or content. */
export function blankToAbsent<T extends { readonly [key: string]: unknown }>(args: T, keys: readonly string[]): T {
  const copy: Record<string, unknown> = { ...args }
  for (const key of keys) {
    const value = copy[key]
    if (value === '' || value === 0 || value === false || (Array.isArray(value) && value.length === 0)
      || (typeof value === 'object' && value !== null && Object.keys(value).length === 0)) delete copy[key]
  }
  return copy as T
}

export const OPTIONAL_ADDRESS_KEYS = ['workspace', 'projectRef', 'threadRef', 'taskRef', 'messageRef', 'replyToMessageRef',
  'claimRef', 'memberRef', 'accountable', 'target', 'beforeSequence', 'limit', 'cursor', 'mine', 'baseRevision',
  'reminderRef'] as const
