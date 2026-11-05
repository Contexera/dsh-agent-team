/**
 * Pending agent input reconstructed from a Session's durable inbox splices.
 *
 * @module agent-team/cold-inbox
 */

import type { InboxState } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Fold one Session's `agent/inbox/spliced` history for a generation that has no
 * live Agent. Coordinates are validated exactly as the driver's own fold
 * validates them, so an unsafe range or a message pending in both lists yields
 * undefined instead of a repaired guess.
 * @param events - events of one Session, in log order.
 * @returns pending input by boundary, or undefined when the history is invalid.
 */
export function coldInboxOf(events: readonly SessionEvent[]): InboxState | undefined {
  let state: InboxState = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const { target, start, inserted } = event.data
    const removedCount = event.data.removedCount ?? 0
    const list = state[target]
    if (!Number.isSafeInteger(start) || start < 0 || start > list.length
      || !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > list.length) return undefined
    const next = list.toSpliced(start, removedCount, ...inserted)
    const ids = new Set<string>()
    for (const message of target === 'next-turn' ? [...next, ...state['next-step']] : [...state['next-turn'], ...next]) {
      if (ids.has(message.id)) return undefined
      ids.add(message.id)
    }
    state = target === 'next-turn'
      ? { 'next-turn': next, 'next-step': state['next-step'] }
      : { 'next-turn': state['next-turn'], 'next-step': next }
  }
  return state
}
