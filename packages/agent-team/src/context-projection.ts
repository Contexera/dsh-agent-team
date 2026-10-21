/**
 * Team's own Session projection: the durable ref naming and the fold every Host
 * registers.
 *
 * The state shape, the projection key, the persisted schema, and the ref
 * identities are frozen: cached rows and durable logs written by earlier builds
 * are read back through them. Every tool name here is a log decoder, never a
 * tool alias: `context_rollover`, its predecessor `new_context`, and
 * `context_checkpoint` no longer exist as tools, but a Member's Session log
 * written under them still folds — a pending intent parked by an earlier build
 * has to keep decoding so a live generation can finish or discard its swap.
 * @module @contexera/dsh-agent-team/context-projection
 */

import { createHash } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { TeamContextCodec } from './context-codec.ts'
import { TEAM_CONTEXT_CODEC } from './context-codec.ts'
import { handoffOf, isAgentTeamContextSource, isAgentTeamSource } from './context-source.ts'
import type { AgentTeamContextCheckpointRef, AgentTeamTaskRef, AgentTeamThreadRef } from './types/entities.ts'

export const CONTEXT_CONTINUITY_PROJECTION_KEY = 'contextContinuity'

/** Decoder name of the retired rollover tool. */
export const CONTEXT_ROLLOVER_TOOL_NAME = 'context_rollover'

/** Decoder name of the retired checkpoint tool. */
export const CONTEXT_CHECKPOINT_TOOL_NAME = 'context_checkpoint'

/** Legacy decoder name of the rollover tool, before it was renamed. */
export const NEW_CONTEXT_TOOL_NAME = 'new_context'

/** Every recorded name a retired rollover call may carry. */
export const TEAM_ROLLOVER_TOOL_NAMES: readonly string[] = [CONTEXT_ROLLOVER_TOOL_NAME, NEW_CONTEXT_TOOL_NAME]

export const TEAM_INBOX_NOTICE_SUMMARY = 'Team Inbox has unread work.'

export const TEAM_RECOVERY_NOTICE_SUMMARY = 'Recovery: continue your interrupted work.'

const PRE_COMPACTION_NOTICE_SUMMARY = 'Compaction is imminent; consider persisting key conclusions.'

const TEAM_CLAIM_TOOL_NAME = 'team_claim'
const TEAM_MESSAGE_TOOL_NAME = 'team_message'

/** `team_thread` is the legacy decoder name: attention moved to `team_attention`. */
const ATTENTION_TOOL_NAMES: readonly string[] = ['team_attention', 'team_thread']

const TEAM_MESSAGE_BOUNDARY_LABEL = 'Team message'
const TEAM_ATTENTION_BOUNDARY_LABEL = 'Team attention change'
const TEAM_CLAIM_BOUNDARY_LABEL = 'Team task claim change'
const HANDOFF_BOUNDARY_LABEL = 'context handoff'
const COMPACTION_BOUNDARY_LABEL = 'compaction notice'

/**
 * Pure reminders are never semantic Team facts. `Progress visibility reminder`
 * is a historical decoder: the nudge system is gone, old logs still carry it.
 */
const REMINDER_NOTICE_SUMMARIES = new Set(['Progress visibility reminder', TEAM_RECOVERY_NOTICE_SUMMARY])

export interface ContextCheckpointEntry {
  /** Opaque stable ref; the selection authority for a seeded return. */
  readonly checkpointRef: string
  readonly name: string
  readonly resultSeq: number
  readonly turn: number
  /** Seq of the resolving `turn/end`; -1 until resolved. */
  readonly turnEndSeq: number
}

export interface PendingRolloverIntent {
  readonly handoff: string
  readonly checkpointRef?: string | undefined
  readonly relatedFiles: readonly {
    readonly path: string
    readonly reason: string
  }[]
  readonly toolCallId: string
  readonly resultSeq: number
  readonly turn: number
  /** Seq of the `turn/end` that released the intent; -1 until observed. */
  readonly turnEndSeq: number
}

export interface ContinuationDeliveryState {
  readonly checkpointRef: string
  /** Seq of the delivered notice; -1 until delivered. */
  readonly deliveredSeq: number
}

export interface CarriedCandidate {
  readonly messageId: string
  readonly surfacedTurn: number
  readonly consumed: boolean
}

/** One host-contributed timeline anchor; the fold stores `kind` opaquely. */
export interface DomainBoundary {
  readonly kind: string
  readonly label: string
  readonly resultSeq: number
  readonly turn: number
  /** Seq of the resolving `turn/end`; -1 until resolved. */
  readonly turnEndSeq: number
  readonly attributions: readonly string[]
}

export interface TeamContextProjectionState {
  /** The Session this state folds; it keys every durable ref the fold derives. */
  readonly sessionId: string
  /** Fork-inherited prefix length; events below it belong to the ancestor. */
  readonly inheritedEventCount: number
  readonly checkpoints: readonly ContextCheckpointEntry[]
  /** Rollover intent awaiting its containing turn end, at most one. */
  readonly pending: PendingRolloverIntent | null
  readonly continuations: readonly ContinuationDeliveryState[]
  readonly carriedCandidates: readonly CarriedCandidate[]
  /** The most recently opened turn; `user/message` carries no turn of its own. */
  readonly lastTurn: number
  readonly openCalls: readonly {
    readonly callId: string
    readonly name: string
    readonly arguments: string
  }[]
  readonly boundaries: readonly DomainBoundary[]
  readonly seenTopics: readonly string[]
  /** Seq of the latest resolved `turn/end`; the timeline's head anchor. */
  readonly lastTurnEndSeq: number
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextContinuity: TeamContextProjectionState
  }
}

const relatedFileSchema = z.object({ path: z.string().min(1), reason: z.string() }).strict()
const openCallSchema = z.object({ callId: z.string().min(1), name: z.string(), arguments: z.string() }).strict()
const checkpointEntrySchema = z.object({
  checkpointRef: z.string().min(1),
  name: z.string(),
  resultSeq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  turnEndSeq: z.number().int(),
}).strict()
const pendingIntentSchema = z.object({
  handoff: z.string(),
  checkpointRef: z.string().min(1).optional(),
  relatedFiles: z.array(relatedFileSchema),
  toolCallId: z.string().min(1),
  resultSeq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  turnEndSeq: z.number().int(),
}).strict()
const carriedCandidateSchema = z.object({
  messageId: z.string().min(1),
  surfacedTurn: z.number().int(),
  consumed: z.boolean(),
}).strict()
const domainBoundarySchema = z.object({
  kind: z.string().min(1),
  label: z.string(),
  resultSeq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  turnEndSeq: z.number().int(),
  attributions: z.array(z.string()),
}).strict()

/** Cached rows are validated with this before seeding a fold, so an older shape is discarded, never forward-applied. */
export const contextProjectionStateSchema: z.ZodType<TeamContextProjectionState> = z.object({
  sessionId: z.string().min(1),
  inheritedEventCount: z.number().int().nonnegative(),
  checkpoints: z.array(checkpointEntrySchema),
  pending: pendingIntentSchema.nullable(),
  continuations: z.array(z.object({ checkpointRef: z.string().min(1), deliveredSeq: z.number().int() }).strict()),
  carriedCandidates: z.array(carriedCandidateSchema),
  lastTurn: z.number().int().nonnegative(),
  openCalls: z.array(openCallSchema),
  boundaries: z.array(domainBoundarySchema),
  seenTopics: z.array(z.string()),
  lastTurnEndSeq: z.number().int(),
}).strict()

export interface ContextFoldTarget {
  readonly sessionId: string
  /** Omit for a Session whose log inherited no prefix. */
  readonly inheritedEventCount?: number
}

export type DomainBoundaryInput = {
  readonly sessionId: string
  readonly seq: number
  /** -1 when the event carries no turn. */
  readonly turn: number
  readonly seenTopics: readonly string[]
} & ({
  readonly source: 'user-message'
  readonly message: UserMessage
} | {
  readonly source: 'tool-result'
  readonly name: string
  readonly arguments: string
  readonly meta: unknown
})

export interface DomainBoundaryContribution {
  readonly kind: string
  readonly label: string
  readonly topics: readonly string[]
}

export interface ContextProjectionHost {
  /** Derived from the recording Session and the successful call id, so two Sessions repeating one call id never collide. */
  checkpointRefFor(sessionId: string, toolCallId: string): string
  /** Session identity is part of the key: generations repeat event seqs. */
  boundaryRefFor(sessionId: string, seq: number): string
  /** Whether one queued message is a Team notice the successor rederives. */
  isEphemeralNotice(message: UserMessage): boolean
  /** Whether one open call is a Team effect call whose success may anchor a boundary. */
  tracksCall?(name: string, raw: string): boolean
  domainBoundaryOf?(input: DomainBoundaryInput): DomainBoundaryContribution | undefined
}

export interface TeamContextProjectionConfig {
  /** The fold only reads these two: what an envelope is, and which checkpoint a continuation names. */
  readonly codec: Pick<TeamContextCodec, 'isContextSource' | 'continuationCheckpointRefOf'>
  readonly host: ContextProjectionHost
  /** Every recorded name a rollover call may carry, so old logs still fold. */
  readonly rolloverToolNames?: readonly string[]
  readonly checkpointToolName?: string
}

export function isReminderNoticeSummary(summary: string): boolean {
  return REMINDER_NOTICE_SUMMARIES.has(summary)
}

export function checkpointRefFor(sessionId: string, callId: string): AgentTeamContextCheckpointRef {
  return `context-checkpoint-${createHash('sha256').update(JSON.stringify([sessionId, callId])).digest('hex')}` as AgentTeamContextCheckpointRef
}

export function boundaryRefFor(sessionId: string, seq: number): AgentTeamContextCheckpointRef {
  return `team-boundary-${createHash('sha256').update(JSON.stringify([sessionId, seq])).digest('hex')}` as AgentTeamContextCheckpointRef
}

export function isRedeliverableTeamNotice(message: UserMessage): boolean {
  return isAgentTeamSource(message.source) && !isAgentTeamContextSource(message)
}

export function emptyContextProjectionState(target: ContextFoldTarget): TeamContextProjectionState {
  return {
    sessionId: target.sessionId,
    inheritedEventCount: target.inheritedEventCount ?? 0,
    checkpoints: [],
    pending: null,
    continuations: [],
    carriedCandidates: [],
    lastTurn: 0,
    openCalls: [],
    boundaries: [],
    seenTopics: [],
    lastTurnEndSeq: -1,
  }
}

export function continuationDelivered(state: TeamContextProjectionState, checkpointRef: string): boolean {
  return state.continuations.some(entry => entry.checkpointRef === checkpointRef && entry.deliveredSeq !== -1)
}

const nonBlankString = z.string().refine(value => value.trim() !== '')
const rolloverArgumentsSchema = z.object({
  handoff: nonBlankString,
  checkpointRef: z.string().min(1).optional(),
  relatedFiles: z.array(relatedFileSchema).optional(),
}).passthrough()
const checkpointArgumentsSchema = z.object({ name: nonBlankString }).passthrough()

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function parseRolloverArguments(raw: string): { handoff: string; checkpointRef?: string; relatedFiles: readonly { path: string; reason: string }[] } | undefined {
  const parsed = rolloverArgumentsSchema.safeParse(parseArguments(raw))
  if (!parsed.success) return undefined
  return {
    handoff: parsed.data.handoff,
    ...(parsed.data.checkpointRef === undefined ? {} : { checkpointRef: parsed.data.checkpointRef }),
    relatedFiles: parsed.data.relatedFiles ?? [],
  }
}

function parseCheckpointName(raw: string): string | undefined {
  const parsed = checkpointArgumentsSchema.safeParse(parseArguments(raw))
  return parsed.success ? parsed.data.name : undefined
}

type TeamContextStep = (state: TeamContextProjectionState, event: SessionEvent) => TeamContextProjectionState

function createStep(config: TeamContextProjectionConfig): TeamContextStep {
  const { codec, host } = config
  const rolloverToolNames = config.rolloverToolNames ?? [CONTEXT_ROLLOVER_TOOL_NAME]
  const checkpointToolName = config.checkpointToolName ?? CONTEXT_CHECKPOINT_TOOL_NAME
  const isRolloverCall = (name: string): boolean => rolloverToolNames.includes(name)

  const withContribution = (
    state: TeamContextProjectionState,
    contribution: DomainBoundaryContribution,
    seq: number,
    turn: number,
  ): TeamContextProjectionState => {
    const unseen = contribution.topics.filter(topic => !state.seenTopics.includes(topic))
    return {
      ...state,
      boundaries: [...state.boundaries, {
        kind: contribution.kind,
        label: contribution.label,
        resultSeq: seq,
        turn,
        turnEndSeq: -1,
        attributions: contribution.topics,
      }],
      seenTopics: unseen.length === 0 ? state.seenTopics : [...state.seenTopics, ...unseen],
    }
  }

  const applyToolResult = (state: TeamContextProjectionState, event: SessionEvent & { type: 'tool/result' }): TeamContextProjectionState => {
    const message = event.data.message
    const index = state.openCalls.findIndex(call => call.callId === message.toolCallId)
    if (index === -1) return state
    const recorded = state.openCalls[index]!
    const openCalls = state.openCalls.filter(call => call.callId !== recorded.callId)
    if (message.isError === true || event.data.error !== undefined) return { ...state, openCalls }
    const seq = event.seq
    const turn = event.data.turn
    if (isRolloverCall(recorded.name)) {
      const parsed = parseRolloverArguments(recorded.arguments)
      if (parsed === undefined) return { ...state, openCalls }
      // One intent per unresolved turn; an intent whose turn already ended is
      // ready, not spent, so a later-turn success can replace it once the
      // in-process lock is gone — that is the retry path.
      if (state.pending !== null && state.pending.turnEndSeq === -1) return { ...state, openCalls }
      return {
        ...state,
        openCalls,
        pending: {
          handoff: parsed.handoff,
          ...(parsed.checkpointRef === undefined ? {} : { checkpointRef: parsed.checkpointRef }),
          relatedFiles: parsed.relatedFiles,
          toolCallId: recorded.callId,
          resultSeq: seq,
          turn,
          turnEndSeq: -1,
        },
      }
    }
    if (recorded.name === checkpointToolName) {
      const name = parseCheckpointName(recorded.arguments)
      if (name === undefined) return { ...state, openCalls }
      const entry: ContextCheckpointEntry = {
        checkpointRef: host.checkpointRefFor(state.sessionId, recorded.callId),
        name,
        resultSeq: seq,
        turn,
        turnEndSeq: -1,
      }
      return { ...state, openCalls, checkpoints: [...state.checkpoints, entry] }
    }
    const contribution = host.domainBoundaryOf?.({
      sessionId: state.sessionId,
      seq,
      turn,
      seenTopics: state.seenTopics,
      source: 'tool-result',
      name: recorded.name,
      arguments: recorded.arguments,
      meta: event.data.meta,
    })
    if (contribution === undefined) return { ...state, openCalls }
    return withContribution({ ...state, openCalls }, contribution, seq, turn)
  }

  const applyInboxSpliced = (state: TeamContextProjectionState, inserted: readonly UserMessage[]): TeamContextProjectionState => {
    if (state.pending === null || inserted.length === 0) return state
    const fresh: CarriedCandidate[] = []
    for (const message of inserted) {
      if (!codec.isContextSource(message) && host.isEphemeralNotice(message)) continue
      if (state.carriedCandidates.some(candidate => candidate.messageId === message.id)) continue
      if (fresh.some(candidate => candidate.messageId === message.id)) continue
      fresh.push({ messageId: message.id, surfacedTurn: -1, consumed: false })
    }
    if (fresh.length === 0) return state
    return { ...state, carriedCandidates: [...state.carriedCandidates, ...fresh] }
  }

  const applyUserMessage = (state: TeamContextProjectionState, event: SessionEvent & { type: 'user/message' }): TeamContextProjectionState => {
    let next = state
    // Surfaced is not consumed: the loop appends `user/message` before the step
    // runs, so a cancellation can still land between them.
    if (next.carriedCandidates.some(candidate => !candidate.consumed && candidate.messageId === event.data.id)) {
      next = {
        ...next,
        carriedCandidates: next.carriedCandidates.map(candidate => candidate.messageId === event.data.id && !candidate.consumed
          ? { ...candidate, surfacedTurn: next.lastTurn }
          : candidate),
      }
    }
    const contribution = host.domainBoundaryOf?.({
      sessionId: state.sessionId,
      seq: event.seq,
      turn: next.lastTurn,
      seenTopics: next.seenTopics,
      source: 'user-message',
      message: event.data,
    })
    if (contribution !== undefined) next = withContribution(next, contribution, event.seq, next.lastTurn)
    const continuationRef = codec.continuationCheckpointRefOf(event.data)
    if (continuationRef === undefined) return next
    const existing = next.continuations.find(entry => entry.checkpointRef === continuationRef)
    if (existing !== undefined) {
      if (existing.deliveredSeq !== -1) return next
      return {
        ...next,
        continuations: next.continuations.map(entry => entry.checkpointRef === continuationRef ? { ...entry, deliveredSeq: event.seq } : entry),
      }
    }
    return { ...next, continuations: [...next.continuations, { checkpointRef: continuationRef, deliveredSeq: event.seq }] }
  }

  const applyAssistantMessage = (state: TeamContextProjectionState, event: SessionEvent & { type: 'assistant/message' }): TeamContextProjectionState => {
    if (state.carriedCandidates.length === 0 || event.data.interrupted === true) return state
    let changed = false
    const carriedCandidates = state.carriedCandidates.map(candidate => {
      if (candidate.consumed || candidate.surfacedTurn !== event.data.turn) return candidate
      changed = true
      return { ...candidate, consumed: true }
    })
    return changed ? { ...state, carriedCandidates } : state
  }

  const applyTurnEnd = (state: TeamContextProjectionState, seq: number, turn: number): TeamContextProjectionState => {
    let changed = state.lastTurnEndSeq !== seq
    const checkpoints = state.checkpoints.map(entry => {
      if (entry.turnEndSeq !== -1) return entry
      changed = true
      return { ...entry, turnEndSeq: seq }
    })
    let pending = state.pending
    if (pending !== null && pending.turnEndSeq === -1) {
      pending = { ...pending, turnEndSeq: seq }
      changed = true
    }
    const boundaries = state.boundaries.map(entry => {
      if (entry.turnEndSeq !== -1) return entry
      changed = true
      return { ...entry, turnEndSeq: seq, turn: entry.turn === -1 ? turn : entry.turn }
    })
    return changed ? { ...state, checkpoints, pending, boundaries, lastTurnEndSeq: seq } : state
  }

  return (state, event) => {
    // The ancestor's events are that generation's facts: folding them here would
    // key its checkpoints to this Session and arm its intent as this one's.
    if (event.seq < state.inheritedEventCount) return state
    switch (event.type) {
      case 'tool/call': {
        const { name, arguments: raw } = event.data
        const tracked = isRolloverCall(name) || name === checkpointToolName || host.tracksCall?.(name, raw) === true
        if (!tracked) return state
        return { ...state, openCalls: [...state.openCalls, { callId: event.data.callId, name, arguments: raw }] }
      }
      case 'tool/result':
        return applyToolResult(state, event)
      case 'turn/start':
        return event.data.turn === state.lastTurn ? state : { ...state, lastTurn: event.data.turn }
      case 'turn/end':
        return applyTurnEnd(state, event.seq, event.data.turn)
      case 'user/message':
        return applyUserMessage(state, event)
      case 'assistant/message':
        return applyAssistantMessage(state, event)
      case 'agent/inbox/spliced':
        return applyInboxSpliced(state, event.data.inserted)
      default:
        return state
    }
  }
}

export function foldTeamContextProjection(
  events: readonly SessionEvent[],
  target: ContextFoldTarget,
  host: ContextProjectionHost = new TeamContextProjectionHost(),
): TeamContextProjectionState {
  const step = createStep(createTeamContextProjectionConfig(host))
  let state = emptyContextProjectionState(target)
  for (const event of events) state = step(state, event)
  return state
}

/** Register once per Host: the framework keeps one unit per key for every Session. */
export function createTeamContextProjectionDefinition(
  host: ContextProjectionHost,
): ProjectionDefinition<typeof CONTEXT_CONTINUITY_PROJECTION_KEY, TeamContextProjectionState> {
  const step = createStep(createTeamContextProjectionConfig(host))
  return {
    key: CONTEXT_CONTINUITY_PROJECTION_KEY,
    stateVersion: 2,
    stateSchema: contextProjectionStateSchema,
    init: (header: SessionHeader, inheritedEventCount: SessionLogOffset) => emptyContextProjectionState({
      sessionId: header.id,
      inheritedEventCount: Number(inheritedEventCount),
    }),
    apply: (state, event) => step(state, event),
  }
}

export function createTeamContextProjectionConfig(host: ContextProjectionHost): TeamContextProjectionConfig {
  return {
    codec: TEAM_CONTEXT_CODEC,
    host,
    rolloverToolNames: TEAM_ROLLOVER_TOOL_NAMES,
    checkpointToolName: CONTEXT_CHECKPOINT_TOOL_NAME,
  }
}

export function checkpointByRef(state: TeamContextProjectionState, checkpointRef: string): ContextCheckpointEntry | undefined {
  return state.checkpoints.find(entry => entry.checkpointRef === checkpointRef && entry.turnEndSeq !== -1)
}

export function boundaryByRef(state: TeamContextProjectionState, ref: string): DomainBoundary | undefined {
  return state.boundaries.find(boundary => boundaryRefFor(state.sessionId, boundary.resultSeq) === ref)
}

export function carriedInputOf(
  state: TeamContextProjectionState,
  events: readonly SessionEvent[],
): readonly UserMessage[] {
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

function isTeamEffectToolName(name: string): boolean {
  return name === TEAM_CLAIM_TOOL_NAME || name === TEAM_MESSAGE_TOOL_NAME || ATTENTION_TOOL_NAMES.includes(name)
}

function isAttentionToolName(name: string): boolean {
  return ATTENTION_TOOL_NAMES.includes(name)
}

function actionOf(raw: string): unknown {
  const parsed = parseArguments(raw)
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).action : undefined
}

function argumentsAreClaimMutation(raw: string): boolean {
  const action = actionOf(raw)
  return action === 'claim' || action === 'done' || action === 'release'
}

function argumentsAreAttentionMutation(raw: string): boolean {
  const action = actionOf(raw)
  return action === 'follow' || action === 'unfollow'
}

function argumentsAreMessageCommit(raw: string): boolean {
  const action = actionOf(raw)
  return action === 'start' || action === 'reply'
}

function threadRefIn(raw: string): AgentTeamThreadRef | undefined {
  const parsed = parseArguments(raw)
  const threadRef = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).threadRef : undefined
  return typeof threadRef === 'string' && threadRef !== '' ? threadRef as AgentTeamThreadRef : undefined
}

function threadsQuotedInMessage(message: UserMessage): readonly string[] {
  const refs: string[] = []
  const text = message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
  for (const match of text.matchAll(/Thread: (thread:[0-9a-f-]{6,})/g)) {
    if (!refs.includes(match[1]!)) refs.push(match[1]!)
  }
  return refs
}

export interface TeamContextProjectionOptions {
  readonly threadForTask?: (taskRef: AgentTeamTaskRef) => AgentTeamThreadRef | undefined
}

type TeamBoundaryContribution = DomainBoundaryContribution & { readonly kind: 'team-boundary' | 'handoff' | 'compaction' }

export class TeamContextProjectionHost implements ContextProjectionHost {
  constructor(private readonly options: TeamContextProjectionOptions = {}) {}

  checkpointRefFor(sessionId: string, toolCallId: string): AgentTeamContextCheckpointRef {
    return checkpointRefFor(sessionId, toolCallId)
  }

  boundaryRefFor(sessionId: string, seq: number): AgentTeamContextCheckpointRef {
    return boundaryRefFor(sessionId, seq)
  }

  isEphemeralNotice(message: UserMessage): boolean {
    return isRedeliverableTeamNotice(message)
  }

  tracksCall(name: string, raw: string): boolean {
    if (!isTeamEffectToolName(name)) return false
    if (name === TEAM_CLAIM_TOOL_NAME) return argumentsAreClaimMutation(raw)
    if (isAttentionToolName(name)) return argumentsAreAttentionMutation(raw)
    return argumentsAreMessageCommit(raw)
  }

  domainBoundaryOf(input: DomainBoundaryInput): DomainBoundaryContribution | undefined {
    return input.source === 'user-message'
      ? this.boundaryFromUserMessage(input)
      : this.boundaryFromToolResult(input)
  }

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
    const firstArrivals = threadsQuotedInMessage(message).filter(ref => !seenTopics.includes(ref))
    if (firstArrivals.length === 0) return undefined
    return { kind: 'team-boundary', label: `First arrival: ${firstArrivals.join(', ')}`, topics: firstArrivals }
  }

  private boundaryFromToolResult(input: DomainBoundaryInput & { source: 'tool-result' }): TeamBoundaryContribution | undefined {
    const { name, arguments: raw, meta } = input
    if (name === TEAM_CLAIM_TOOL_NAME) {
      const parsed = parseArguments(raw)
      const taskRef = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).taskRef : undefined
      const threadRef = typeof taskRef === 'string' && taskRef !== ''
        ? this.options.threadForTask?.(taskRef as AgentTeamTaskRef)
        : undefined
      return { kind: 'team-boundary', label: TEAM_CLAIM_BOUNDARY_LABEL, topics: threadRef === undefined ? [] : [threadRef] }
    }
    if (isAttentionToolName(name)) {
      const threadRef = threadRefIn(raw)
      return { kind: 'team-boundary', label: TEAM_ATTENTION_BOUNDARY_LABEL, topics: threadRef === undefined ? [] : [threadRef] }
    }
    if (name === TEAM_MESSAGE_TOOL_NAME) {
      if (typeof meta !== 'object' || meta === null) return undefined
      const { kind, threadRef } = meta as { kind?: unknown; threadRef?: unknown }
      if (kind !== 'committed' || typeof threadRef !== 'string' || threadRef === '') return undefined
      return { kind: 'team-boundary', label: TEAM_MESSAGE_BOUNDARY_LABEL, topics: [threadRef] }
    }
    return undefined
  }
}
