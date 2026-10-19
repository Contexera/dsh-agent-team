import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { AGENT_TEAM_PLUGIN_ID, matchesProducerKind } from './context-source.ts'
import type { AgentTeamMemberId } from './types.ts'
import type { AgentTeamThreadReadFact } from './types.ts'

/**
 * Whether one unread fact is already on its Member's model-visible surface.
 *
 * The write gate refuses a write while the reader has unread work, on the
 * theory that only an explicit `team_thread read` proves the reader saw it. But
 * some Team messages are delivered INTO the visible surface as notices, and a
 * direct mention or a DM carries the message body in full. When that body is
 * on the surface, the model has read the content, and refusing the write buys
 * nothing but a round-trip.
 *
 * The probe is deliberately narrow, because a false positive is expensive: a
 * write the model was never ready to make. It answers true only when the
 * surface holds a Team-authored event whose rendered text contains this fact's
 * body verbatim, which is exactly the shape `notificationText` and
 * `dmRelayText` write. An ordinary notice carries only a count — "Thread X: 2
 * unread update(s) · newest at …" — and so can never match, by construction
 * rather than by a rule someone has to remember. A body the writer had to cut
 * likewise never appears in full, so it never matches either.
 *
 * Nothing here consults or writes ledger state: this reads a live session and
 * answers a question about it. The caller decides what to do with the answer.
 */

/** The notice's own truncation marker, which means the body was cut. */
export const NOTIFICATION_TRUNCATION_MARKER = '[Message body truncated; use team_thread read for the full Message.]'

/**
 * How much of one Message body a notice carries before it is cut and marked.
 * The writer below and the reader that decides whether a fact was delivered
 * whole must agree on both the budget and the mark.
 */
export const NOTIFICATION_BODY_MAX_CHARACTERS = 8 * 1024

/**
 * The text of every Team-authored user message currently on this agent's
 * surface, newest first.
 *
 * This is the same observation `member-context.ts` makes, and it inherits that
 * module's number-domain discipline: `surface.nodes` holds SessionSeq values
 * (event identities) while `snapshotEvents` takes SessionLogOffsets, and the
 * two line up only through the seq = log.length contiguity contract. Going
 * through the validating constructor keeps the conversion explicit at the one
 * place it happens — a silent mismatch here would not throw, it would just
 * quietly read the wrong events.
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
 * The body must appear verbatim inside a Team-authored surface text. Presence
 * of the text is not enough on its own: a body the writer had to cut appears
 * only as its {@link NOTIFICATION_BODY_MAX_CHARACTERS}-character prefix
 * followed by {@link NOTIFICATION_TRUNCATION_MARKER}, so the fact's own notice
 * never attests it even though the prefix is right there.
 *
 * The marker is scoped to the body's own rendering, not to the whole text. One
 * notice can carry several detail blocks and truncates each body independently,
 * so a cut sibling must not disqualify an untruncated one — otherwise a single
 * oversized body would silently un-exempt every other fact in the same notice.
 */
export function isFactOnSurface(texts: readonly string[], fact: AgentTeamThreadReadFact): boolean {
  if (fact.fact.kind !== 'message') return false
  const body = fact.fact.message.body
  if (body === '') return false
  return texts.some(text => isBodyRenderedInFull(text, body))
}

/**
 * Whether one text carries this body verbatim AND in full.
 *
 * The body is attested when the text contains it and what follows is not this
 * plugin's truncation marker — which the renderer appends, after one newline,
 * exactly when it cut that body, and only then.
 */
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
