/**
 * What a Member is told after a read acknowledges the acceptance of a Task it
 * contributed to.
 *
 * Acceptance is the one moment where the Team knows a Member's context has
 * turned a page: the work it was holding is finished, and anything worth
 * keeping has to move into its own memory first. Below the budget the Member is
 * only asked to write that down; at or above it the Host also compacts the
 * generation once the Agent settles, because a finished Task is not a reason to
 * keep carrying its transcript.
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

/**
 * Decide what an acknowledged acceptance does to the reader's context.
 *
 * Both halves are required for `compact`: an unmeasurable context only reminds,
 * because a meter failure is not evidence that the generation is large, and a
 * preset with no engine only reminds, because the reminder must never promise a
 * compaction that cannot happen.
 * @param facts - the measurement and whether compaction is available.
 * @returns the action and the measurement behind it.
 */
export function planAcceptanceContext(facts: AcceptanceContextFacts): AcceptanceContextPlan {
  const { usageTokens } = facts
  if (usageTokens === undefined) return { action: 'remind' }
  return {
    action: facts.canCompact && usageTokens >= ACCEPTANCE_COMPACT_TOKENS ? 'compact' : 'remind',
    usageTokens,
  }
}

/**
 * The reminder body. The compaction clause is stated only when it is true: a
 * Member that is told its context will be replaced plans around that, and one
 * that is told so falsely loses work it thought it had written down.
 * @param action - whether the Host will compact after this turn.
 * @returns the model-facing text, framed as the Harness frames injected context.
 */
export function acceptanceReminderText(action: AcceptanceContextAction): string {
  const lines = [
    '<system-reminder>',
    'A Task you contributed to was accepted. This is a natural boundary: record what is durable and reusable before moving on. Put the conclusions that will matter again in your private memory.md index, and the detail behind them in the note that index names. Accepted work is not a reason to keep this conversation.',
  ]
  if (action === 'compact') {
    lines.push('', 'This context is over the Team acceptance budget, so it will be compacted once the Agent settles. Anything not written down by then is gone.')
  }
  lines.push('</system-reminder>')
  return lines.join('\n')
}

export function createAcceptanceReminder(action: AcceptanceContextAction): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: acceptanceReminderText(action) }],
    source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: TEAM_ACCEPTANCE_NOTICE_SUMMARY },
  })
}
