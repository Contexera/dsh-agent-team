/**
 * One Member named by a caller, read the same way everywhere.
 *
 * Every field that takes a Member — a Task's `target` or `accountable`, a
 * subscription's event recipients — accepts what an Agent actually sees: a
 * branded ref, an `@Handle`, a unique 6+ hex prefix of the id, or the Human's
 * own alias. Accepting only refs would force every caller to look up ids for
 * names it already knows, and a rejection would then read as "not a member"
 * when the real problem was the written form.
 * @module @contexera/dsh-agent-team-tools/member-target
 */
import type { AgentTeamMemberId } from '@contexera/dsh-agent-team/types'
import AgentTeam, { AGENT_TEAM_HUMAN_MEMBER_ID } from '@contexera/dsh-agent-team/host'
import { recoveryFor } from '@contexera/dsh-agent-team/recovery-hints'

/** Resolve one written Member into its id, refusing an unknown form and an ambiguous prefix differently. */
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
  if (trimmed.startsWith('member:')) return trimmed as AgentTeamMemberId
  throw new Error(`${trimmed} names no Member — pass a memberRef, an @Handle, a unique 6+ hex prefix, or 'human'. ${recoveryFor('unknown_ref').sentence({ refused: trimmed })}`)
}
