/**
 * Team's projection contribution to the context-continuity engine: the durable
 * ref naming, the Team-notice rule, and the domain judgement that decides which
 * events anchor a timeline boundary and what each boundary is attributable to.
 *
 * The fold itself is the engine's (`createContextProjectionDefinition`): one
 * registered unit per Host folds every Session's durable log and owns the
 * universal structure — checkpoints, the pending rollover intent, quiet
 * continuation delivery, carry candidates, open calls, turn cursors. This
 * module supplies only what the engine deliberately refuses to know:
 *
 * - the durable refs Team's existing logs already carry
 *   (`context-checkpoint-<sha256>`, `team-boundary-<sha256>`), frozen because
 *   recorded history is read back through them;
 * - which queued messages are Team-owned notices the successor rederives;
 * - which successful Team calls anchor a boundary, and which Threads each
 *   boundary is attributable to. A claim mutation resolves its Task's Thread
 *   through the ledger; that binding is written once at Task creation, so a
 *   re-fold reproduces the same attribution, and a missing ledger or mapping
 *   yields no attribution instead of failing the fold.
 *
 * The remaining exports are read views over the engine's state that Team still
 * owns: the anchor lookups the rollover guard revalidates a cited ref through,
 * the accumulated Thread attribution that guard and the timeline both judge a
 * boundary by, and carried-message resolution — the engine keys carry
 * candidates by message id, and the durable log is where the message body
 * lives.
 * @module @contexera/dsh-agent-team/context-projection
 */

import { createHash } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  CONTEXT_CHECKPOINT_TOOL_NAME,
  CONTEXT_ROLLOVER_TOOL_NAME,
  createContextProjectionDefinition,
  foldContextProjection as foldEngineContextProjection,
  type ContextCheckpointEntry,
  type ContextFoldTarget,
  type ContextProjectionConfig,
  type ContextProjectionHost,
  type ContextProjectionState,
  type DomainBoundary,
  type DomainBoundaryContribution,
  type DomainBoundaryInput,
} from '@contexera/dsh-context-continuity'
import { handoffOf, isAgentTeamContextSource, isAgentTeamSource } from './context-source.ts'
import { TEAM_CONTEXT_CODEC } from './context-continuity-host.ts'
import type { AgentTeamContextCheckpointRef, AgentTeamTaskRef, AgentTeamThreadRef } from './types/entities.ts'

/** Summary marker of the pre-compaction memory hint. */
const PRE_COMPACTION_NOTICE_SUMMARY = 'Compaction is imminent; consider persisting key conclusions.'

/** Team tool whose successful mutations are semantic timeline candidates. */
const TEAM_CLAIM_TOOL_NAME = 'team_claim'

/** Team tools whose successful Thread effects are semantic timeline candidates. */
const TEAM_MESSAGE_TOOL_NAME = 'team_message'
const TEAM_THREAD_TOOL_NAME = 'team_thread'

/** Fixed action-category labels for effect boundaries (mirrors the claim label's shape). */
const TEAM_MESSAGE_BOUNDARY_LABEL = 'Team message'
const TEAM_ATTENTION_BOUNDARY_LABEL = 'Team attention change'
const TEAM_CLAIM_BOUNDARY_LABEL = 'Team task claim change'

/** The handoff boundary label; every generation opens with one. */
const HANDOFF_BOUNDARY_LABEL = 'context handoff'

/** The compaction boundary label. */
const COMPACTION_BOUNDARY_LABEL = 'compaction notice'

/**
 * The anchor kinds Team contributes. The engine treats a kind as opaque, but
 * Team's own read views map it back to the timeline source vocabulary, so the
 * three are named once here instead of as bare strings at each contribution.
 */
const TEAM_BOUNDARY_KINDS = ['team-boundary', 'handoff', 'compaction'] as const

/** One anchor kind Team contributes. */
type TeamBoundaryKind = typeof TEAM_BOUNDARY_KINDS[number]

/** One anchor Team contributes: the engine stores the kind opaquely, Team reads it back. */
type TeamBoundaryContribution = DomainBoundaryContribution & { readonly kind: TeamBoundaryKind }

/**
 * Notice summaries that are pure reminders, never semantic Team facts: a
 * recovery instruction must not become a return anchor. `Progress visibility
 * reminder` is a historical decoder — the progress-nudge system was removed,
 * but session logs recorded before its removal still carry those notices, and
 * the fold keeps recognizing them (same pattern as the legacy `new_context`
 * tool name below).
 */
const REMINDER_NOTICE_SUMMARIES = new Set(['Progress visibility reminder', 'Recovery: continue your interrupted work.'])

/** Whether one notice summary is a pure reminder (never a semantic Team fact). */
export function isReminderNoticeSummary(summary: string): boolean {
  return REMINDER_NOTICE_SUMMARIES.has(summary)
}

/** Stable tool names the fold recognizes under their current names. */
export { CONTEXT_CHECKPOINT_TOOL_NAME, CONTEXT_ROLLOVER_TOOL_NAME }

/**
 * Legacy decoder name: the rollover tool was renamed `new_context` →
 * `context_rollover`, and Sessions recorded before the rename still carry
 * durable `new_context` call/result pairs. The fold keeps decoding them —
 * pending rollovers and crash recovery of existing Members depend on old
 * events still resolving intent — but this is a log decoder, not a tool
 * alias: no new call can carry the old name.
 */
export const NEW_CONTEXT_TOOL_NAME = 'new_context'

/** Every recorded tool name a rollover call may carry, current name first. */
export const TEAM_ROLLOVER_TOOL_NAMES: readonly string[] = [CONTEXT_ROLLOVER_TOOL_NAME, NEW_CONTEXT_TOOL_NAME]

/**
 * Deterministic checkpoint ref from the recording session and tool call
 * identity: a bounded, collision-resistant opaque token. Provider call ids
 * are arbitrary-length free text that may repeat across generations and even
 * collide between Sessions, so the ref derives from the SHA-256 of the exact
 * `(sessionId, callId)` pair — same pair always reproduces the ref, any
 * other pair is overwhelmingly unlikely to collide, and the token can never
 * smuggle delimiters or unbounded content through a ref field.
 */
export function checkpointRefFor(sessionId: string, callId: string): AgentTeamContextCheckpointRef {
  return `context-checkpoint-${createHash('sha256').update(JSON.stringify([sessionId, callId])).digest('hex')}` as AgentTeamContextCheckpointRef
}

/**
 * Deterministic boundary ref for one delivered Team boundary: the same
 * session-scoped hash shape as checkpoint refs, keyed on the boundary's
 * anchoring event seq. Consecutive generations routinely repeat event seqs,
 * so the Session identity must be part of the key or two generations'
 * boundaries at the same seq collide — the timeline would silently drop the
 * ancestor item and a `context_rollover` return would resolve the wrong boundary.
 */
export function boundaryRefFor(sessionId: string, seq: number): AgentTeamContextCheckpointRef {
  return `team-boundary-${createHash('sha256').update(JSON.stringify([sessionId, seq])).digest('hex')}` as AgentTeamContextCheckpointRef
}

/**
 * Whether one queued message is a Team-owned notice the rederived Inbox
 * replaces. Handoff and continuation envelopes carry the same plugin
 * attribution but are ordinary delivered context the new generation keeps, so
 * they are excluded rather than dropped.
 */
export function isTeamNotice(message: UserMessage): boolean {
  const source = message.source
  return isAgentTeamSource(source) && !isAgentTeamContextSource(message)
}

/** Whether one tool name can produce a Team-effect boundary from a successful call. */
function isTeamEffectToolName(name: string): boolean {
  return name === TEAM_CLAIM_TOOL_NAME || name === TEAM_MESSAGE_TOOL_NAME || name === TEAM_THREAD_TOOL_NAME
}

/** One parsed JSON argument object, or undefined when the raw string carries none. */
function parseArguments(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
}

/** The `action` one raw tool-call argument string declares, when it declares one. */
function actionOf(raw: string): unknown {
  return parseArguments(raw)?.action
}

/** Whether one raw Team-claim arguments string is a mutation (not `list`). */
function argumentsAreClaimMutation(raw: string): boolean {
  const action = actionOf(raw)
  return action === 'claim' || action === 'done' || action === 'release'
}

/** Whether one raw team_thread arguments string is an attention mutation (follow/unfollow). */
function argumentsAreAttentionMutation(raw: string): boolean {
  const action = actionOf(raw)
  return action === 'follow' || action === 'unfollow'
}

/** Whether one raw team_message arguments string is a Thread-effect attempt (start/reply — dm is not a Thread fact). */
function argumentsAreMessageCommit(raw: string): boolean {
  const action = actionOf(raw)
  return action === 'start' || action === 'reply'
}

/** The Thread ref one raw argument string names, when it names one. */
function threadRefIn(raw: string): AgentTeamThreadRef | undefined {
  const threadRef = parseArguments(raw)?.threadRef
  return typeof threadRef === 'string' && threadRef !== '' ? threadRef as AgentTeamThreadRef : undefined
}

/** Thread refs structurally quoted in one delivered message body (`Thread: <ref>` lines). */
function threadsQuotedInMessage(message: UserMessage): readonly string[] {
  const refs: string[] = []
  const text = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  for (const match of text.matchAll(/Thread: (thread:[0-9a-f-]{6,})/g)) {
    if (!refs.includes(match[1]!)) refs.push(match[1]!)
  }
  return refs
}

/** What Team's fold needs from the rest of the Host. */
export interface TeamContextProjectionOptions {
  /**
   * Resolve the Thread one Task's facts belong to, for claim-boundary
   * attribution. Absent (or returning undefined) leaves the boundary
   * unattributed: it still anchors the timeline, it is simply not selectable
   * as a single-Thread return target.
   */
  readonly threadForTask?: (taskRef: AgentTeamTaskRef) => AgentTeamThreadRef | undefined
}

/**
 * Team's domain half of the context-continuity projection. Every method is a
 * pure judgement over the event the engine hands it plus Team's own durable
 * vocabulary; the engine keeps the state machine.
 */
export class TeamContextProjectionHost implements ContextProjectionHost {
  constructor(private readonly options: TeamContextProjectionOptions = {}) {}

  /** Durable checkpoint ref: Team's existing log vocabulary, unchanged. */
  checkpointRefFor(sessionId: string, toolCallId: string): AgentTeamContextCheckpointRef {
    return checkpointRefFor(sessionId, toolCallId)
  }

  /** Durable boundary ref: the same session-scoped hash shape. */
  boundaryRefFor(sessionId: string, seq: number): AgentTeamContextCheckpointRef {
    return boundaryRefFor(sessionId, seq)
  }

  /** A Team-owned notice the successor generation rederives from ledger facts. */
  isEphemeralNotice(message: UserMessage): boolean {
    return isTeamNotice(message)
  }

  /**
   * Only a Team-effect call that can produce a boundary is tracked at all:
   * `list` on a claim, `read` on a Thread, and `dm` are not semantic timeline
   * candidates, so their results must never open an anchor.
   */
  tracksCall(name: string, raw: string): boolean {
    if (!isTeamEffectToolName(name)) return false
    if (name === TEAM_CLAIM_TOOL_NAME) return argumentsAreClaimMutation(raw)
    if (name === TEAM_THREAD_TOOL_NAME) return argumentsAreAttentionMutation(raw)
    return argumentsAreMessageCommit(raw)
  }

  /** Team's boundary for one event, or undefined when the event anchors nothing. */
  domainBoundaryOf(input: DomainBoundaryInput): DomainBoundaryContribution | undefined {
    return input.source === 'user-message'
      ? this.boundaryFromUserMessage(input)
      : this.boundaryFromToolResult(input)
  }

  /**
   * Structural boundary from one delivered user message: a rollover handoff
   * starts a generation; a compaction notice rewrites the visible surface. A
   * structured Team notification is a boundary ONLY on the first arrival of
   * each Thread's facts into this Session — the preserved "work just arrived"
   * anchor; every later re-delivery of the same Thread is noise. Reminder
   * notices (progress nudges, recovery instructions) never anchor. Plain
   * Human/agent prose and quiet checkpoint continuations are not boundaries.
   */
  private boundaryFromUserMessage(input: DomainBoundaryInput & { source: 'user-message' }): TeamBoundaryContribution | undefined {
    const { message, seenTopics } = input
    if (handoffOf(message) !== undefined) {
      return { kind: 'handoff', label: HANDOFF_BOUNDARY_LABEL, topics: [] }
    }
    const source = message.source
    if (!isAgentTeamSource(source)) return undefined
    if (source.form === 'relay') return undefined
    if (source.form === 'notice' && source.summary === PRE_COMPACTION_NOTICE_SUMMARY) {
      return { kind: 'compaction', label: COMPACTION_BOUNDARY_LABEL, topics: [] }
    }
    if (source.form === 'notice' && source.summary !== undefined && isReminderNoticeSummary(source.summary)) return undefined
    // The Threads this delivery first introduces anchor the boundary; a
    // delivery that introduces none (pure re-delivery) is noise.
    const firstArrivals = threadsQuotedInMessage(message).filter(ref => !seenTopics.includes(ref))
    if (firstArrivals.length === 0) return undefined
    // The label states WHAT first arrived — the Thread refs this delivery
    // introduced into the context — never the notice's own generic account
    // (e.g. "unread work"): the timeline's decision surface needs the
    // attribution before a checkpointRef pick, and it is only knowable here,
    // at the fold, where first arrival is computed.
    return { kind: 'team-boundary', label: `First arrival: ${firstArrivals.join(', ')}`, topics: firstArrivals }
  }

  /**
   * Effect boundary from one successful Team-effect call — the attribution
   * matrix: claim mutation → the Thread its Task was created in (resolved
   * through the ledger, whose binding is immutable); team_message committed →
   * the Thread from the call arguments or, for a start, from the structured
   * presentation meta (`kind === 'committed'` guards every typed rejection; no
   * meta means no boundary — old logs refold without start anchors by design,
   * never by parsing render text); team_thread follow/unfollow → the threadRef
   * from its call arguments. An unresolvable attribution leaves the boundary
   * anchored but not single-Thread selectable.
   */
  private boundaryFromToolResult(input: DomainBoundaryInput & { source: 'tool-result' }): TeamBoundaryContribution | undefined {
    const { name, arguments: raw, meta } = input
    if (name === TEAM_CLAIM_TOOL_NAME) {
      const taskRef = parseArguments(raw)?.taskRef
      const threadRef = typeof taskRef === 'string' && taskRef !== ''
        ? this.options.threadForTask?.(taskRef as AgentTeamTaskRef)
        : undefined
      return { kind: 'team-boundary', label: TEAM_CLAIM_BOUNDARY_LABEL, topics: threadRef === undefined ? [] : [threadRef] }
    }
    if (name === TEAM_THREAD_TOOL_NAME) {
      const threadRef = threadRefIn(raw)
      return { kind: 'team-boundary', label: TEAM_ATTENTION_BOUNDARY_LABEL, topics: threadRef === undefined ? [] : [threadRef] }
    }
    if (name === TEAM_MESSAGE_TOOL_NAME) {
      // The structured meta projection is the single attribution source for a
      // start (the Thread is born in the result); replies carry their ref in
      // the call arguments already, but the committed guard is meta-side for
      // every action — typed rejections are successful calls, not errors.
      if (meta === undefined || typeof meta !== 'object' || meta === null) return undefined
      const { kind, threadRef } = meta as { kind?: unknown; threadRef?: unknown }
      if (kind !== 'committed' || typeof threadRef !== 'string' || threadRef === '') return undefined
      return { kind: 'team-boundary', label: TEAM_MESSAGE_BOUNDARY_LABEL, topics: [threadRef] }
    }
    return undefined
  }
}

/**
 * The engine fold configured for Team: the codec Team's durable envelopes are
 * written with, Team's projection host, and every recorded rollover name
 * (current and legacy). One config drives both the registered unit and every
 * cold fold, so a replayed log and the live unit converge on one state.
 */
export function createTeamContextProjectionConfig(host: ContextProjectionHost): ContextProjectionConfig {
  return {
    codec: TEAM_CONTEXT_CODEC,
    host,
    rolloverToolNames: TEAM_ROLLOVER_TOOL_NAMES,
    checkpointToolName: CONTEXT_CHECKPOINT_TOOL_NAME,
  }
}

/**
 * Cold-fold one immutable Team Session log through the engine's fold with
 * Team's config. The registered unit uses the same config, so the two agree.
 */
export function foldTeamContextProjection(
  events: readonly SessionEvent[],
  target: ContextFoldTarget,
  host: ContextProjectionHost = new TeamContextProjectionHost(),
): ContextProjectionState {
  return foldEngineContextProjection(events, createTeamContextProjectionConfig(host), target)
}

/**
 * The host-only projection unit for Team Members. Register it **once per
 * Host**: the framework keeps one unit per projection key and drives it for
 * every Session, so the definition closes over no Session identity.
 */
export function createTeamContextProjectionDefinition(host: ContextProjectionHost): ReturnType<typeof createContextProjectionDefinition> {
  return createContextProjectionDefinition(createTeamContextProjectionConfig(host))
}

/**
 * The Threads Team's own fold attributed to boundaries resolved by one
 * completed turn, order-stable and deduplicated: a delivered notice's first
 * arrival, a claim mutation's Task→Thread binding, a committed Thread effect.
 *
 * This is the accumulated attribution of the RETAINED PREFIX through that
 * turn, and it is one set with two readers — the timeline publishes it as the
 * item's affected Threads, and the rollover guard refuses a boundary whose
 * prefix spans more than one Thread, so a ref the timeline offers is a ref
 * `context_rollover` accepts.
 */
export function retainedTopicsThrough(state: ContextProjectionState, turnEndSeq: number): readonly string[] {
  const topics: string[] = []
  for (const boundary of state.boundaries) {
    if (boundary.turnEndSeq === -1 || boundary.turnEndSeq > turnEndSeq) continue
    for (const topic of boundary.attributions) {
      if (!topics.includes(topic)) topics.push(topic)
    }
  }
  return topics
}

/** Find one resolved checkpoint entry by its stable ref, if it exists. */
export function checkpointByRef(state: ContextProjectionState, checkpointRef: string): ContextCheckpointEntry | undefined {
  return state.checkpoints.find(entry => entry.checkpointRef === checkpointRef && entry.turnEndSeq !== -1)
}

/** Whether one engine-held boundary is the recorded anchor of `ref` in this state's Session. */
export function boundaryByRef(state: ContextProjectionState, ref: string): DomainBoundary | undefined {
  return state.boundaries.find(boundary => boundaryRefFor(state.sessionId, boundary.resultSeq) === ref)
}

/**
 * The carried input one transition must deliver: unconsumed post-intent
 * candidates in queue order, resolved to their durable message bodies. The
 * engine keys carry candidates by message id (that is what the transition
 * dedupes on); the `agent/inbox/spliced` events that recorded them are where
 * the message itself lives, so the log stays the only authority.
 */
export function carriedInputOf(state: ContextProjectionState, events: readonly SessionEvent[]): readonly UserMessage[] {
  const outstanding = state.carriedCandidates.filter(candidate => !candidate.consumed)
  if (outstanding.length === 0) return []
  const byId = new Map<string, UserMessage>()
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    for (const message of event.data.inserted) byId.set(message.id, message)
  }
  const carried: UserMessage[] = []
  for (const candidate of outstanding) {
    const message = byId.get(candidate.messageId)
    if (message !== undefined) carried.push(message)
  }
  return carried
}
