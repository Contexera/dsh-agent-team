/**
 * Reminder a Member receives at an acceptance boundary: a read that acknowledges an acceptance of work it owned, or the accept it committed itself.
 * @module @contexera/dsh-agent-team/acceptance-context
 */

import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { AGENT_TEAM_PLUGIN_ID } from './context-source.ts'
import { TEAM_ACCEPTANCE_NOTICE_SUMMARY } from './context-projection.ts'

/** Context size at or above which an acceptance also triggers compaction. */
export const ACCEPTANCE_COMPACT_TOKENS = 128_000

export type AcceptanceContextAction = 'remind' | 'compact'

export interface AcceptanceContextPlan {
  readonly action: AcceptanceContextAction
  /** Measured context; absent when the meter could not price the Session. */
  readonly usageTokens?: number
}

export interface AcceptanceContextFacts {
  readonly usageTokens: number | undefined
  /** Whether the Member's preset resolves a compaction engine at all. */
  readonly canCompact: boolean
}

/** Plans `compact` only when usage is measurable, at or above the budget, and an engine exists; otherwise `remind`. */
export function planAcceptanceContext(facts: AcceptanceContextFacts): AcceptanceContextPlan {
  const { usageTokens } = facts
  if (usageTokens === undefined) return { action: 'remind' }
  return {
    action: facts.canCompact && usageTokens >= ACCEPTANCE_COMPACT_TOKENS ? 'compact' : 'remind',
    usageTokens,
  }
}

/** Which standing the reader had in the accepted Task; it names the boundary in the reminder. */
export type AcceptancePerspective = 'contributor' | 'verifier' | 'accountable'

const OPENING: Readonly<Record<AcceptancePerspective, string>> = Object.freeze({
  contributor: 'A Task you contributed to was accepted.',
  verifier: 'You accepted a Task.',
  accountable: 'A Task you were accountable for was accepted.',
})

/** Reminder text; the compaction clause appears only when compaction will happen. */
export function acceptanceReminderText(action: AcceptanceContextAction, perspective: AcceptancePerspective = 'contributor'): string {
  const lines = [
    '<system-reminder>',
    `${OPENING[perspective]} This is a natural boundary: record what is durable and reusable before moving on. Put the conclusions that will matter again in your private memory.md index, and the detail behind them in the note that index names. Accepted work is not a reason to keep this conversation.`,
  ]
  if (action === 'compact') {
    lines.push('', 'This context is over the Team acceptance budget, so it will be compacted once the Agent settles. Anything not written down by then is gone.')
  }
  lines.push('</system-reminder>')
  return lines.join('\n')
}

export function createAcceptanceReminder(action: AcceptanceContextAction, perspective: AcceptancePerspective = 'contributor'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: acceptanceReminderText(action, perspective) }],
    source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: TEAM_ACCEPTANCE_NOTICE_SUMMARY },
  })
}
