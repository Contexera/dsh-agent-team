import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { AGENT_TEAM_PLUGIN_ID, matchesProducerKind } from './context-source.ts'
import type { AgentTeamMemberId } from './types.ts'
import type { AgentTeamThreadReadFact } from './types.ts'

/**
 * Whether one unread fact is already on its Member's model-visible surface.
 *
 * The write gate refuses writes while unread work exists, but a direct mention or DM notice delivers the message body in full; if that body is on the surface the Member has read it and refusing only costs a round-trip. The probe is narrow because a false positive lets through a write the model was never ready to make: it matches only a Team-authored surface text containing the fact's body verbatim, the shape `notificationText` and `dmRelayText` write. Count-only notices and truncated bodies never match. Reads a live session only; no ledger state.
 */

/** The notice's own truncation marker, which means the body was cut. */
export const NOTIFICATION_TRUNCATION_MARKER = '[Message body truncated; use team_thread read for the full Message.]'

/** Body budget of one notice before it is cut and marked; the writer and the full-delivery check must agree on it and on the mark. */
export const NOTIFICATION_BODY_MAX_CHARACTERS = 8 * 1024

/**
 * The text of every Team-authored user message on this agent's surface, newest first.
 *
 * As in `member-context.ts`, `surface.nodes` holds SessionSeq values while `snapshotEvents` takes SessionLogOffsets; they line up only through the seq = log.length contiguity contract, so the conversion goes through the validating constructor (a mismatch would silently read the wrong events).
 */
export function visibleTeamTexts(agent: Agent): readonly string[] {
  const texts: string[] = []
  for (const sequence of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.snapshotEvents(SessionLogOffset(sequence), SessionLogOffset(sequence + 1))[0]
    if (event?.type !== 'user/message') continue
    if (!matchesProducerKind(event.data.source.kind, AGENT_TEAM_PLUGIN_ID)) continue
    for (const part of event.data.content) {
      if (part.type === 'text') texts.push(part.text)
    }
  }
  return texts
}

/**
 * Whether one unread fact's body is on the surface, in full.
 *
 * A truncated body appears only as its {@link NOTIFICATION_BODY_MAX_CHARACTERS}-character prefix plus {@link NOTIFICATION_TRUNCATION_MARKER}, so it never attests. The marker is scoped to the body's own rendering: one notice can carry several detail blocks, each truncated independently, so one cut sibling must not un-exempt the others.
 */
export function isFactOnSurface(texts: readonly string[], fact: AgentTeamThreadReadFact): boolean {
  if (fact.fact.kind !== 'message') return false
  const body = fact.fact.message.body
  if (body === '') return false
  return texts.some(text => isBodyRenderedInFull(text, body))
}

/** Whether a text carries this body verbatim and in full: what follows is not the truncation marker the renderer appends after one newline exactly when it cut that body. */
function isBodyRenderedInFull(text: string, body: string): boolean {
  let cursor = text.indexOf(body)
  while (cursor !== -1) {
    if (!text.startsWith(`\n${NOTIFICATION_TRUNCATION_MARKER}`, cursor + body.length)) return true
    cursor = text.indexOf(body, cursor + 1)
  }
  return false
}

export function surfaceVisibilityProbe(agentFor: (memberId: AgentTeamMemberId) => Agent | undefined) {
  return (memberId: AgentTeamMemberId, fact: AgentTeamThreadReadFact): boolean => {
    const agent = agentFor(memberId)
    if (agent === undefined) return false
    return isFactOnSurface(visibleTeamTexts(agent), fact)
  }
}
