import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import { isAgentTeamSource } from './context-source.ts'
import type { AgentTeamMemberId, AgentTeamThreadReadFact, AgentTeamThreadRef } from './types.ts'

export const NOTIFICATION_TRUNCATION_MARKER = '[Message body truncated; use team_thread read for the full Message.]'
export const NOTIFICATION_BODY_MAX_CHARACTERS = 8 * 1024

export type ThreadMessageSurface = {
  readonly textDigest: string
  readonly messages: readonly { readonly threadRef: string; readonly messageRef: string; readonly bodyDigest: string }[]
}

export interface RenderedThreadMessage {
  readonly threadRef: string
  readonly messageRef: string
  readonly body: string
}

const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Bind only messages the producer rendered in full, to the exact text it emitted. */
export function threadMessageSurface(text: string, messages: readonly RenderedThreadMessage[]) {
  return { textDigest: digest(text), messages: messages.map(message => ({
    threadRef: message.threadRef, messageRef: message.messageRef, bodyDigest: digest(message.body),
  })) }
}

/** A live projection, not a read receipt. Cropped text cannot attest through retained metadata. */
export function visibleTeamSurface(agent: Pick<Agent, 'session'>): readonly ThreadMessageSurface[] {
  const entries: ThreadMessageSurface[] = []
  for (const sequence of agent.session.surface.nodes) {
    const event = agent.session.snapshotEvents(SessionLogOffset(sequence), SessionLogOffset(sequence + 1))[0]
    if (event === undefined) continue
    const message = agent.session.deriveEventMessage(event)
    if (message === null) continue
    let binding: unknown
    if (event.type === 'user/message' && message.role === 'user' && isAgentTeamSource(message.source) && message.source.form === 'notice') {
      binding = message.source.threadFacts
    } else if (event.type === 'tool/result' && message.role === 'tool' && !message.isError) {
      const ownCall = event.sourceEventSeqs?.some(sequence => {
        const call = agent.session.snapshotEvents(SessionLogOffset(sequence), SessionLogOffset(sequence + 1))[0]
        return call?.type === 'tool/call' && call.data.callId === message.toolCallId
          && (call.data.name === 'team_thread' || call.data.name === 'team_message' || call.data.name === 'team_task')
      })
      if (!ownCall) continue
      const meta = event.data.meta
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) continue
      binding = meta['threadFacts']
    }
    const surface = surfaceOf(binding)
    if (surface === undefined || message.content.some(part => part.type !== 'text')) continue
    const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
    if (digest(text) === surface.textDigest) entries.push(surface)
  }
  return entries
}

function surfaceOf(value: unknown): ThreadMessageSurface | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const surface = value as Partial<ThreadMessageSurface>
  if (typeof surface.textDigest !== 'string' || !Array.isArray(surface.messages)) return undefined
  if (!surface.messages.every(message => message !== null && typeof message === 'object'
    && typeof message.threadRef === 'string' && typeof message.messageRef === 'string' && typeof message.bodyDigest === 'string')) return undefined
  return surface as ThreadMessageSurface
}

export function isFactOnSurface(entries: readonly ThreadMessageSurface[], fact: AgentTeamThreadReadFact, threadRef: AgentTeamThreadRef): boolean {
  if (fact.fact.kind !== 'message' || fact.fact.message.body === '') return false
  const { messageRef, body } = fact.fact.message
  const bodyDigest = digest(body)
  return entries.some(entry => entry.messages.some(message => message.threadRef === threadRef
    && message.messageRef === messageRef && message.bodyDigest === bodyDigest))
}

export function surfaceVisibilityProbe(agentFor: (memberId: AgentTeamMemberId) => Agent | undefined) {
  return (memberId: AgentTeamMemberId, facts: readonly AgentTeamThreadReadFact[], threadRef: AgentTeamThreadRef): boolean => {
    const agent = agentFor(memberId)
    if (agent === undefined) return false
    const entries = visibleTeamSurface(agent)
    return facts.every(fact => isFactOnSurface(entries, fact, threadRef))
  }
}
