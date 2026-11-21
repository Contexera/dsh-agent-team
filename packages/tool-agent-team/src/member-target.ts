import type { AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID } from '@contexera/dsh-agent-team/host'
import { recoveryFor } from '@contexera/dsh-agent-team/recovery-hints'

export function memberTarget(host: AgentTeam, raw: string): AgentTeamMemberId {
  const trimmed = raw.trim()
  const handle = trimmed.replace(/^@/u, '').toLowerCase()
  if (trimmed === AGENT_TEAM_HUMAN_MEMBER_ID || handle === 'human' || handle === host.humanHandle().toLowerCase()) {
    return AGENT_TEAM_HUMAN_MEMBER_ID
  }
  const named = host.members().find(status => status.member.handle.toLowerCase() === handle)
  if (named !== undefined) return named.member.memberId
  const hex = trimmed.replace(/^member:/u, '').toLowerCase()
  if (/^[0-9a-f]{6,}$/u.test(hex)) {
    const matches = host.members().filter(status => status.member.memberId.slice('member:'.length).toLowerCase().startsWith(hex))
    if (matches.length === 1) return matches[0]!.member.memberId
    if (matches.length > 1) {
      const candidates = matches.map(status => status.member.memberId).join(', ')
      throw new Error(`${trimmed} matches ${matches.length} Members (${candidates}) — ${recoveryFor('ambiguous_ref').sentence({ refused: trimmed })}`)
    }
  }
  // Leave final validation of branded refs to the Host, which knows the operation's membership scope.
  if (trimmed.startsWith('member:')) return trimmed as AgentTeamMemberId
  throw new Error(`${trimmed} names no Member — pass a memberRef, an @Handle, a unique 6+ hex prefix, or 'human'. ${recoveryFor('unknown_ref').sentence({ refused: trimmed })}`)
}
