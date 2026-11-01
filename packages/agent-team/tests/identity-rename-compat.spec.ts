/**
 * The `@wowyuarm` → `@contexera` identity rename, from the READ side.
 *
 * Three independent producer identities carry Agent Team attribution in durable
 * Session logs, and each is matched by exact equality somewhere different:
 *
 *  1. `AGENT_TEAM_PLUGIN_ID` (`@wowyuarm/dsh-agent-team`) — noticed and relayed
 *     messages plus handoff/checkpoint snapshots, matched through
 *     `isAgentTeamSource`.
 *  2. The `member-context` plugin's own `name` — matched through
 *     `matchesProducerKind(kind, name)` inside that module.
 *  3. The `member-time-context` plugin's own `name` — same, in its own fold.
 *
 * The 2026-10-08 rename commit deliberately changed only each row's `name`
 * (the package path) and left the ids alone, so they are still the keys of
 * existing data: a sampled 40 Member Sessions held 1569 rows under the old
 * plugin id, 163 member-context rows and 320 time-context rows.
 *
 * WHY THESE ASSERTIONS SPELL THE OLD IDS AS LITERALS: most of the suite imports
 * `AGENT_TEAM_PLUGIN_ID` and friends, so it follows whatever the constant says
 * and stays green even if the legacy branch were deleted outright. Only a
 * literal old string can prove the dual read exists. Every case below therefore
 * pairs a literal legacy kind (bare AND `plugin:`-converted) with the current
 * one, and the negative control proves the matcher still refuses a third-party
 * producer — the exact-equality rule that a `plugin:` prefix test would break.
 */
import { describe, expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  AGENT_TEAM_LEGACY_PLUGIN_IDS,
  AGENT_TEAM_PLUGIN_ID,
  AGENT_TEAM_PLUGIN_IDS,
  HANDOFF_SECTION_NAME,
  isAgentTeamSource,
  matchesAnyProducerKind,
  matchesProducerKind,
  v3RenamedSourceKind,
} from '../src/context-source.ts'
import { handoffOf } from '../src/context-source.ts'
import { LEGACY_NAME as LEGACY_MEMBER_CONTEXT, PRODUCER_NAMES as MEMBER_CONTEXT_PRODUCERS } from '../src/member-context.ts'
import { applyClockEvent, LEGACY_NAME as LEGACY_TIME_CONTEXT, PRODUCER_NAMES as TIME_CONTEXT_PRODUCERS } from '../src/member-time-context.ts'

/** The pre-rename plugin id, spelled out: importing the constant would test the new value only. */
const OLD_PLUGIN_ID = '@wowyuarm/dsh-agent-team'
/** The pre-rename per-Member producer ids, likewise literal. */
const OLD_MEMBER_CONTEXT = 'wowyuarm-agent-team-member-context'
const OLD_TIME_CONTEXT = 'wowyuarm-agent-team-member-time-context'

describe('producer identity constants', () => {
  it('writes the @contexera identity and keeps the old one as read-only history', () => {
    expect(AGENT_TEAM_PLUGIN_ID).toBe('@contexera/dsh-agent-team')
    expect(AGENT_TEAM_LEGACY_PLUGIN_IDS).toEqual([OLD_PLUGIN_ID])
    expect(AGENT_TEAM_PLUGIN_IDS).toEqual(['@contexera/dsh-agent-team', OLD_PLUGIN_ID])
  })

  it('names each per-Member producer under @contexera and remembers its old name', () => {
    expect(LEGACY_MEMBER_CONTEXT).toBe(OLD_MEMBER_CONTEXT)
    expect(LEGACY_TIME_CONTEXT).toBe(OLD_TIME_CONTEXT)
    expect(MEMBER_CONTEXT_PRODUCERS).toEqual(['contexera-agent-team-member-context', OLD_MEMBER_CONTEXT])
    expect(TIME_CONTEXT_PRODUCERS).toEqual(['contexera-agent-team-member-time-context', OLD_TIME_CONTEXT])
  })
})

describe('the plugin id reads back under both identities', () => {
  /** A handoff snapshot under `kind`, in the shape this plugin has written. */
  function handoffRow(kind: string): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: 'prose' }],
      source: {
        kind,
        form: 'snapshot',
        sections: [
          { name: HANDOFF_SECTION_NAME, text: 'objective: ship it' },
          { name: 'Previous session', text: 'agent-team-previous' },
          { name: 'New session', text: 'agent-team-next' },
          { name: 'Trigger', text: 'model' },
          { name: 'Handoff event seq', text: '42' },
        ],
      },
    } as never)
  }

  for (const kind of [
    // The current kind, then the literal pre-rename kind and its V3 conversion.
    '@contexera/dsh-agent-team',
    OLD_PLUGIN_ID,
    `plugin:${OLD_PLUGIN_ID}`,
    v3RenamedSourceKind(AGENT_TEAM_PLUGIN_ID),
  ]) {
    it(`claims ${kind}`, () => {
      expect(isAgentTeamSource({ kind } as never)).toBe(true)
      // The envelope decoder runs on the same predicate, so an old handoff must
      // also still decode — otherwise a surviving Session loses its boundary.
      expect(handoffOf(handoffRow(kind))?.handoffEventSeq).toBe(42)
    })
  }

  it('still refuses another producer, whether whitelisted or V3-converted', () => {
    // A prefix test on `plugin:` would claim both of these; exact identity must not.
    expect(isAgentTeamSource({ kind: 'tool-jobs' } as never)).toBe(false)
    expect(isAgentTeamSource({ kind: 'plugin:tool-jobs' } as never)).toBe(false)
    expect(matchesAnyProducerKind('plugin:tool-jobs', AGENT_TEAM_PLUGIN_IDS)).toBe(false)
    // And the single-producer matcher keeps its own contract unchanged.
    expect(matchesProducerKind(OLD_PLUGIN_ID, AGENT_TEAM_PLUGIN_ID)).toBe(false)
  })
})

describe('each per-Member producer reads back under both of its own names', () => {
  for (const [producer, label, legacy, producers] of [
    ['member-context', 'member-context', LEGACY_MEMBER_CONTEXT, MEMBER_CONTEXT_PRODUCERS],
    ['member-time-context', 'time-context', LEGACY_TIME_CONTEXT, TIME_CONTEXT_PRODUCERS],
  ] as const) {
    it(`claims the pre-rename name of ${label}, bare and V3-converted`, () => {
      expect(matchesAnyProducerKind(legacy, producers)).toBe(true)
      expect(matchesAnyProducerKind(`plugin:${legacy}`, producers)).toBe(true)
      expect(matchesAnyProducerKind(producer === 'member-context' ? 'contexera-agent-team-member-context' : 'contexera-agent-team-member-time-context', producers)).toBe(true)
      // The neighbouring Team producer is NOT this one: each module matches only
      // its own name, so a shared prefix must not make them interchangeable.
      expect(matchesAnyProducerKind(OLD_MEMBER_CONTEXT === legacy ? OLD_TIME_CONTEXT : OLD_MEMBER_CONTEXT, producers)).toBe(false)
    })
  }

  it('folds a clock snapshot carrying the pre-rename kind', () => {
    // The baseline is folded from the Session's own events, so recognizing an
    // old snapshot is what stops a resumed Member from re-injecting its clock
    // and from mis-deriving the elapsed interval.
    const baseline = applyClockEvent(
      { lastMessageTime: null, lastInjectionTime: null, lastTurnInjectionTime: null, openTurn: 1 },
      { type: 'user/message', time: 1_800, data: { source: { kind: OLD_TIME_CONTEXT, form: 'snapshot', sections: [] } } },
    )
    expect(baseline.lastInjectionTime).toBe(1_800)
    expect(baseline.lastTurnInjectionTime).toBe(1_800)
  })

  it('does NOT treat a foreign producer as a clock snapshot', () => {
    const baseline = applyClockEvent(
      { lastMessageTime: null, lastInjectionTime: null, lastTurnInjectionTime: null, openTurn: 1 },
      { type: 'user/message', time: 1_800, data: { source: { kind: OLD_MEMBER_CONTEXT, form: 'snapshot', sections: [] } } },
    )
    expect(baseline.lastInjectionTime).toBeNull()
  })
})
