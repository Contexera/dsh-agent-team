/**
 * The restart affordance is the only operator action left for an unavailable
 * Member, and the row diagnostic is the only place the Client says why it is
 * unavailable. Both verdicts are projection-derived pure functions, so they are
 * pinned here; `team-mode-agents.client.spec.tsx` covers the row menu that
 * consumes them, and the artifact path a refusal carries is asserted below.
 */
import { describe, expect, it } from 'vitest'
import type { AgentTeamClientMemberStatus, AgentTeamMemberDiagnostic } from '@contexera/dsh-agent-team/types'
import { zh } from '../src/client/locales.ts'
import type { TeamSidebarProps } from '../src/client/slots.ts'
import { diagnosticText, presenceLabel, restartOffered } from '../src/client/TeamPresenceDot.tsx'

const t = ((key: keyof typeof zh, params?: Record<string, string | number>) => {
  let value: string = zh[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replace(`{${name}}`, String(replacement))
  return value
}) as TeamSidebarProps['t']

/** An unavailable Member carrying only the diagnostic facts these verdicts read. */
function unavailable(diagnostic?: AgentTeamMemberDiagnostic): AgentTeamClientMemberStatus {
  return { presence: 'unavailable', ...(diagnostic === undefined ? {} : { diagnostic }) } as unknown as AgentTeamClientMemberStatus
}

describe('Member restart affordance', () => {
  it('offers restart when the Member carries no diagnostic at all', () => {
    expect(restartOffered(unavailable())).toBe(true)
  })

  it('withholds restart inside a rollover window, which resolves on its own', () => {
    expect(restartOffered(unavailable({ class: 'rollover', detail: 'rolling over' }))).toBe(false)
  })

  it('keeps offering restart for a refused session, whose heal may still repair it', () => {
    // No write-side repair pass exists, so a restart re-runs the activation;
    // it is never withheld because a refusal looked deterministic.
    expect(restartOffered(unavailable({ class: 'session-refused', detail: 'cannot safely transform unclassified message source' }))).toBe(true)
    // No other class suppresses the action.
    for (const failureClass of ['session-unreadable', 'preset-composition', 'runtime', 'activation'] as const) {
      expect(restartOffered(unavailable({ class: failureClass, detail: 'failed' }))).toBe(true)
    }
  })

  it('renders the refused artifact path beside the reason', () => {
    const refused = unavailable({
      class: 'session-refused',
      detail: 'cannot safely transform unclassified message source',
      location: { kind: 'jsonl', path: '/tmp/sessions/x/session.v0.jsonl.zstd' },
    })
    expect(diagnosticText(refused)).toBe('cannot safely transform unclassified message source (/tmp/sessions/x/session.v0.jsonl.zstd)')
    expect(diagnosticText(unavailable({ class: 'runtime', detail: 'boom' }))).toBe('boom')
    expect(diagnosticText(unavailable())).toBe('')
  })

  it('labels an unavailable Member with the reason, not a bare state', () => {
    expect(presenceLabel(unavailable(), t)).toBe('不可用')
    expect(presenceLabel(unavailable({ class: 'session-refused', detail: 'refused' }), t)).toBe('不可用: refused')
  })
})
