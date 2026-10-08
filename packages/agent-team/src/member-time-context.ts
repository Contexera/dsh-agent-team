/**
 * Team Member turn-level clock context.
 *
 * The first model step of every eligible Team Member turn appends one
 * durable, source-attributed clock snapshot: the current instant in the
 * fixed Team coordination zone (UTC+8), the elapsed time since the
 * preceding model-visible event, and the ordering authority note. Later
 * steps of the same turn stay quiet unless the turn runs longer than the
 * refresh interval, in which case one snapshot lands per elapsed interval —
 * a tool-dense turn of quick steps produces exactly one line, while a turn
 * that outlives the interval still shows its real span. The snapshot is an
 * observation, never ledger authority: sequence and revision, not
 * wall-clock time, order Team facts.
 *
 * This plugin deliberately does not mount the shipped
 * `@deepseek-ai/dsh-time-context`: its browser-zone policy asks the model to
 * confirm dates with the user whenever a request carries no unique browser
 * zone, which is the normal case for background Member wakes (Inbox, DM,
 * recovery, continuation). The Team coordination zone is fixed instead. If
 * the harness grows a public non-browser/canonical-zone policy, retire this
 * row in favor of configuring that plugin.
 *
 * State is folded from the Member Session's own events — the same
 * manual-fold pattern the Host's context projection uses — so restart,
 * request reconstruction, and compaction all derive identical baselines
 * without a second durable store.
 * @module @contexera/dsh-agent-team/member-time-context
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { matchesProducerKind } from './context-source.ts'
import { formatTeamDuration, formatTeamTimestamp } from './time-format.ts'
import { advanceOwnedSessionEventCursor, type OwnedSessionEventCursor, type SessionEventFold } from './session-event-cursor.ts'

export const name = 'wowyuarm-agent-team-member-time-context'

/** This producer's own attribution. `kind` must be producer-owned (Session format
 * V4); the second member is the read-time conversion's rename of this
 * producer's released V3 history (`plugin:` + id, `plugin` key dropped) —
 * read-side only. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'wowyuarm-agent-team-member-time-context': { kind: 'wowyuarm-agent-team-member-time-context' } & ContextFormed
    'plugin:wowyuarm-agent-team-member-time-context': { kind: 'plugin:wowyuarm-agent-team-member-time-context' } & ContextFormed
  }
}

/** Default minimum spacing between two snapshots within one turn, in ms. */
export const CLOCK_REFRESH_INTERVAL_MS = 1_800_000

/** Plugin configuration: the snapshot refresh interval, overridable per preset. */
export interface Config {
  /** Minimum spacing between two snapshots within one turn, in ms. Default 1_800_000 (30 minutes). */
  refreshIntervalMs?: number
}

/** Folded clock baselines for one Member Session. */
interface ClockBaseline {
  /** Event time of the latest model-visible event (user/assistant message or tool result), or null. */
  readonly lastMessageTime: number | null
  /** Event time of this plugin's latest durable snapshot, or null. */
  readonly lastInjectionTime: number | null
  /** Latest snapshot time within the currently open turn, or null before one lands. */
  readonly lastTurnInjectionTime: number | null
  /** The open turn, or -1 between turns; a new turn clears the turn-local baseline. */
  readonly openTurn: number
}

function emptyBaseline(): ClockBaseline {
  return { lastMessageTime: null, lastInjectionTime: null, lastTurnInjectionTime: null, openTurn: -1 }
}

/**
 * Fold one session event into the clock baseline. Uninterested events return
 * the same state reference.
 * @internal exported for tests.
 */
export function applyClockEvent(state: ClockBaseline, event: { readonly type: string; readonly time: number; readonly data?: unknown }): ClockBaseline {
  switch (event.type) {
    case 'turn/start':
      return (event.data as { turn: number }).turn === state.openTurn ? state
        : { ...state, lastTurnInjectionTime: null, openTurn: (event.data as { turn: number }).turn }
    case 'turn/end':
      return state.openTurn === -1 ? state : { ...state, lastTurnInjectionTime: null, openTurn: -1 }
    case 'user/message': {
      const source = (event.data as UserMessage).source
      const injected = matchesProducerKind(source.kind, name)
      const withMessage = state.lastMessageTime === event.time ? state : { ...state, lastMessageTime: event.time }
      if (!injected) return withMessage
      return { ...withMessage, lastInjectionTime: event.time, lastTurnInjectionTime: event.time }
    }
    case 'assistant/message':
    case 'tool/result':
      return state.lastMessageTime === event.time ? state : { ...state, lastMessageTime: event.time }
    default:
      return state
  }
}

/** Fold a whole event log into the clock baseline. @internal exported for tests. */
export function foldClockBaseline(events: readonly { readonly type: string; readonly time: number; readonly data?: unknown }[]): ClockBaseline {
  let state = emptyBaseline()
  for (const event of events) state = applyClockEvent(state, event)
  return state
}

/**
 * Whether this step should append a clock snapshot: the first step of a turn
 * always does (every wake starts with a fresh instant), and a later step
 * does only when the turn has run longer than the refresh interval since
 * the last landed snapshot. Skipped steps produce nothing and never
 * backfill — their span folds into the next snapshot's elapsed.
 * @internal exported for tests.
 */
export function shouldSampleClock(step: number, now: number, baseline: ClockBaseline, refreshIntervalMs: number): boolean {
  if (step === 1) return true
  return baseline.lastTurnInjectionTime === null || now - baseline.lastTurnInjectionTime >= refreshIntervalMs
}

/** Render one durable clock snapshot text. @internal exported for tests. */
export function renderClockSnapshot(input: { readonly now: number; readonly turn: number; readonly step: number; readonly previous: number | undefined }): string {
  // A wall-clock rollback clamps elapsed to 0s without rewriting history.
  const elapsed = input.previous === undefined ? 'unavailable' : formatTeamDuration(input.now - input.previous)
  const baseline = input.step === 1 ? 'model-visible event' : 'step context'
  return `Team clock sampled while preparing turn ${input.turn}, step ${input.step}: ${formatTeamTimestamp(new Date(input.now).toISOString())}\n`
    + `Elapsed since the preceding ${baseline}: ${elapsed}.\n`
    + 'Team collaboration timestamps use UTC+8. Sequence and revision, not wall-clock time, determine ordering and concurrency.'
}

/**
 * The clock baseline folded incrementally over one Session's own events. A
 * rollover starts a fresh Session log, and the cache below is keyed by Session
 * id, so the fold never guesses elapsed across generations: a missing prior
 * event renders `unavailable`, not a fabricated baseline.
 */
const CLOCK_FOLD: SessionEventFold<ClockBaseline, SessionEvent> = {
  start: emptyBaseline(),
  step: (state, event) => applyClockEvent(state, event),
}

export function apply(ctx: Context, config: Config = {}): void {
  const refreshIntervalMs = config.refreshIntervalMs ?? CLOCK_REFRESH_INTERVAL_MS
  // Per-step fold state, reused for this plugin lifecycle: one entry per
  // Member, replaced when that Member's Session changes, so a rollover neither
  // resumes across generations nor retains every generation it leaves behind.
  const cursors = new Map<string, OwnedSessionEventCursor<ClockBaseline>>()
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    // The Host service is resolved at step time, never through plugin inject
    // (same reason as member-context: the row mounts while the Host itself
    // is still restoring Members).
    const host = ctx.get('agentTeam')
    if (host === undefined) return decision
    const member = (host as { memberForAgent(subject: unknown): { readonly memberId: string } | undefined }).memberForAgent(agent)
    if (member === undefined) return decision
    const now = Date.now()
    const owned = advanceOwnedSessionEventCursor(
      cursors.get(member.memberId),
      agent.session.id,
      CLOCK_FOLD,
      agent.session.ownEvents(),
      agent.session.inheritedEventCount,
    )
    cursors.set(member.memberId, owned)
    const baseline = owned.cursor.value
    // Turn-first-step always samples; later steps sample only at the refresh
    // interval, so a quick tool-dense turn stays at one line.
    if (!shouldSampleClock(step, now, baseline, refreshIntervalMs)) return decision
    const previous = step === 1
      ? baseline.lastMessageTime ?? undefined
      : baseline.lastTurnInjectionTime ?? undefined
    const text = renderClockSnapshot({ now, turn, step, previous })
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
    })
    return { kind: 'enter', messages: [...decision.messages, message] }
  }, { prepend: true })
}
