import { missingMessageRange, teamMessageSurface, visibleTeamSurface } from '@contexera/dsh-agent-team/host'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LlmError } from '@deepseek-ai/dsh-llm'

export const READ_MAX_CHARACTERS = 32 * 1024

export async function readingCapacity(agent: Agent, signal: AbortSignal): Promise<number> {
  const { provider, model } = agent.session.requestHeader()?.config ?? agent.options
  const llm = agent.ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return 256 * 1024
  try {
    const info = await llm.resolveModelInfo(provider, model, signal)
    signal.throwIfAborted()
    // One UTF-16 unit per available token is deliberately conservative, not a tokenizer claim.
    return Math.max(0, Math.min(256 * 1024, (info.context?.contextWindow ?? 320_000) - 16_384))
  } catch (error) {
    if (error instanceof LlmError && error.code === 'NO_ADAPTER') return 256 * 1024
    throw error
  }
}
export interface MessagePart {
  readonly messageRef: string
  readonly start: number
  readonly end: number
  readonly complete: boolean
}
export const MESSAGE_PART_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  messageRef: { type: 'string', required: true }, start: { type: 'number', required: true }, end: { type: 'number', required: true }, complete: { type: 'boolean', required: true },
} } as const

interface Entry {
  readonly sequence: number
  readonly kind: string
  readonly messageRef?: string | undefined
  readonly body?: string | undefined
  readonly bodyOmitted?: boolean | undefined
  readonly unread?: boolean | undefined
}
interface Reading {
  readonly projectRef: string
  readonly threadRef?: string | undefined
  readonly kind: string
  readonly facts?: readonly Entry[] | undefined
  readonly entries?: readonly Entry[] | undefined
  readonly message?: { readonly messageRef: string; readonly body: string; readonly sequence: number } | undefined
  readonly remainingUnreadCount?: number | undefined
  readonly reminders?: readonly unknown[] | undefined
  readonly messageParts?: readonly MessagePart[] | undefined
  readonly continuation?: string | undefined
}

export function messagePartText(body: string, part: MessagePart | undefined): string {
  if (part === undefined) return body
  return `Message part ${part.start}–${part.end} of ${body.length}${part.complete ? ' — complete in current context' : ' — incomplete; not acknowledged'}\n<message-part ref="${part.messageRef}" start="${part.start}" end="${part.end}">\n${body.slice(part.start, part.end)}\n</message-part>`
}

/** Select exactly the renderable prefix before the Host acknowledges it. Repeated calls fill the first gap on the live surface. */
export function budgetReading<V extends Reading>(agent: Agent, value: V, render: (value: V) => string, capacity: number): { value: V; through: number } {
  const surface = visibleTeamSurface(agent)
  const source = value.kind === 'message' && value.message !== undefined ? [{ ...value.message, kind: 'message' }]
    : value.facts ?? value.entries ?? []
  const unread = source.filter(entry => entry.unread)
  const background = source.filter(entry => !entry.unread)
  const key = value.facts !== undefined ? 'facts' : 'entries'
  const continuation = value.kind === 'message'
    ? 'Continue: repeat team_thread message with the same address and messageRef. Missing parts are recovered from current context; this query never acknowledges.'
    : 'Continue: repeat team_thread read with the same address. Missing parts are recovered from current context; incomplete Messages stay unread.'
  const fits = (candidate: V) => render(candidate).length <= READ_MAX_CHARACTERS - 64
  const make = (entries: readonly Entry[], parts: readonly MessagePart[] = []): V => {
    const acknowledged = entries.filter(entry => entry.unread && !parts.some(part => part.messageRef === entry.messageRef && !part.complete)).length
    return { ...value, ...(value.kind === 'message' ? {} : { [key]: entries }), messageParts: parts,
      ...(parts.some(part => !part.complete) ? { continuation } : {}),
      ...(value.kind !== 'read' ? {} : { remainingUnreadCount: (value.remainingUnreadCount ?? 0) + unread.length - acknowledged,
        ...(unread.length > 0 && acknowledged === 0 ? { reminders: [] } : {}) }) }
  }
  let selected = value.kind === 'message' ? [...source] : [...unread]
  let candidate = make(selected)
  while (!fits(candidate) && selected.length > 1) {
    selected.pop()
    candidate = make(selected)
  }
  if (value.kind !== 'message' && selected.length === 0 && background.length > 0) {
    selected = [background[0]!]
    candidate = make(selected)
  }
  const first = selected[0]
  if (first?.kind === 'message' && first.body !== undefined && first.messageRef !== undefined && !first.bodyOmitted && !fits(candidate)) {
    if (first.body.length > capacity) throw new Error(`Message exceeds the reading capacity (${first.body.length} > ${capacity} UTF-16 units): ${first.messageRef}. Nothing acknowledged. Ask the sender for shorter Messages or use a larger-context model; repeating this call cannot complete it.`)
    const address = value.threadRef === undefined ? { projectRef: value.projectRef } : { threadRef: value.threadRef }
    const missing = missingMessageRange(surface, { ...address, messageRef: first.messageRef, body: first.body })
    const start = missing?.start ?? first.body.length
    const gapEnd = missing?.end ?? first.body.length
    const target = { ...address, messageRef: first.messageRef, body: first.body }
    const complete = (end: number) => missing === undefined || missingMessageRange([
      ...surface, teamMessageSurface('', [{ ...target, part: { start, end } }]),
    ], target) === undefined
    let low = start, high = Math.min(gapEnd, start + READ_MAX_CHARACTERS)
    while (low < high) {
      const end = Math.ceil((low + high) / 2)
      if (fits(make(selected, [{ messageRef: first.messageRef, start, end, complete: complete(end) }]))) low = end
      else high = end - 1
    }
    let end = low
    if (end > start && end < first.body.length && /[\uD800-\uDBFF]/.test(first.body[end - 1]!)) end -= 1
    if (end === start && missing !== undefined) throw new Error('Message reading cannot fit its identity and one character in the output budget; nothing acknowledged.')
    candidate = make(selected, [{ messageRef: first.messageRef, start, end, complete: complete(end) }])
  }
  if (!fits(candidate)) throw new Error('Current reading metadata exceeds the output budget; nothing acknowledged. Use team_thread message with a Message ref for its body.')
  if (value.kind !== 'message' && (candidate.messageParts?.length ?? 0) === 0) {
    for (const entry of background) {
      if (selected.includes(entry)) continue
      const next = make([...selected, entry].sort((left, right) => left.sequence - right.sequence))
      if (!fits(next)) break
      selected.push(entry)
      candidate = next
    }
  }
  const acknowledged = selected.filter(entry => entry.unread && !candidate.messageParts?.some(part => part.messageRef === entry.messageRef && !part.complete))
  return { value: candidate, through: acknowledged.at(-1)?.sequence ?? 0 }
}
