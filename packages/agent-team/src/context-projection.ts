import { createHash } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { continuationCheckpointRefOf, isAgentTeamContextSource, isAgentTeamSource, matchesProducerKind } from './context-source.ts'
import type { AgentTeamContextCheckpointRef } from './types/entities.ts'

export const CONTEXT_CONTINUITY_PROJECTION_KEY = 'contextContinuity'

const CONTEXT_ROLLOVER_TOOL_NAME = 'context_rollover'

const CONTEXT_CHECKPOINT_TOOL_NAME = 'context_checkpoint'

const NEW_CONTEXT_TOOL_NAME = 'new_context'

export const TEAM_INBOX_NOTICE_SUMMARY = 'Team Inbox has unread work.'

export const TEAM_RECOVERY_NOTICE_SUMMARY = 'Recovery: continue your interrupted work.'

export const TEAM_ACCEPTANCE_NOTICE_SUMMARY = 'Task accepted: record what is durable.'

export function isAcceptanceNotice(message: UserMessage): boolean {
  const source = message.source
  return isAgentTeamSource(source) && source.form === 'notice' && source.summary === TEAM_ACCEPTANCE_NOTICE_SUMMARY
}

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
}).strict()

export interface ContextFoldTarget {
  readonly sessionId: string
  /** Omit for a Session whose log inherited no prefix. */
  readonly inheritedEventCount?: number
  /** Committed wake-swap boundary; omitted for legacy-only folds. */
  readonly inputFromSeq?: number
}

export function checkpointRefFor(sessionId: string, callId: string): AgentTeamContextCheckpointRef {
  return `context-checkpoint-${createHash('sha256').update(JSON.stringify([sessionId, callId])).digest('hex')}` as AgentTeamContextCheckpointRef
}

export function isRedeliverableTeamNotice(message: UserMessage): boolean {
  return isAgentTeamSource(message.source) && !isAgentTeamContextSource(message)
}

function emptyContextProjectionState(target: ContextFoldTarget): TeamContextProjectionState {
  return {
    sessionId: target.sessionId,
    inheritedEventCount: target.inheritedEventCount ?? 0,
    checkpoints: [],
    pending: null,
    continuations: [],
    carriedCandidates: [],
    lastTurn: 0,
    openCalls: [],
  }
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

// These names decode durable logs; the tools themselves are no longer offered.
function isRolloverCall(name: string): boolean {
  return name === CONTEXT_ROLLOVER_TOOL_NAME || name === NEW_CONTEXT_TOOL_NAME
}

function applyToolResult(state: TeamContextProjectionState, event: SessionEvent & { type: 'tool/result' }): TeamContextProjectionState {
  const message = event.data.message
  const recorded = state.openCalls.find(call => call.callId === message.toolCallId)
  if (recorded === undefined) return state
  const next = { ...state, openCalls: state.openCalls.filter(call => call.callId !== recorded.callId) }
  if (message.isError === true || event.data.error !== undefined) return next
  const seq = event.seq
  const turn = event.data.turn
  if (isRolloverCall(recorded.name)) {
    const parsed = parseRolloverArguments(recorded.arguments)
    if (parsed === undefined) return next
    // A later turn can retry a failed swap, but not replace an intent whose turn still owns it.
    if (state.pending !== null && state.pending.turnEndSeq === -1) return next
    return {
      ...next,
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
  if (recorded.name === CONTEXT_CHECKPOINT_TOOL_NAME) {
    const name = parseCheckpointName(recorded.arguments)
    if (name === undefined) return next
    const entry: ContextCheckpointEntry = {
      checkpointRef: checkpointRefFor(state.sessionId, recorded.callId),
      name,
      resultSeq: seq,
      turn,
      turnEndSeq: -1,
    }
    return { ...next, checkpoints: [...state.checkpoints, entry] }
  }
  return next
}

function isWakeSwapInput(message: UserMessage): boolean {
  const source = message.source
  if (matchesProducerKind(source.kind, 'agent-instructions') || isAgentTeamContextSource(message)) return false
  // The Host regenerates its notices after a swap; relays are real input and must survive it.
  return !(isAgentTeamSource(source) && source.form === 'notice'
    && (source.summary === TEAM_INBOX_NOTICE_SUMMARY
      || source.summary === TEAM_RECOVERY_NOTICE_SUMMARY
      || source.summary === TEAM_ACCEPTANCE_NOTICE_SUMMARY))
}

function applyInboxSpliced(state: TeamContextProjectionState, inserted: readonly UserMessage[], afterWakeBoundary: boolean): TeamContextProjectionState {
  if ((state.pending === null && !afterWakeBoundary) || inserted.length === 0) return state
  const seen = new Set(state.carriedCandidates.map(candidate => candidate.messageId))
  const fresh: CarriedCandidate[] = []
  for (const message of inserted) {
    if (afterWakeBoundary ? !isWakeSwapInput(message) : isRedeliverableTeamNotice(message)) continue
    if (seen.has(message.id)) continue
    seen.add(message.id)
    fresh.push({ messageId: message.id, surfacedTurn: -1, consumed: false })
  }
  if (fresh.length === 0) return state
  return { ...state, carriedCandidates: [...state.carriedCandidates, ...fresh] }
}

function applyUserMessage(state: TeamContextProjectionState, event: SessionEvent & { type: 'user/message' }): TeamContextProjectionState {
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
  const continuationRef = continuationCheckpointRefOf(event.data)
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

function applyAssistantMessage(state: TeamContextProjectionState, event: SessionEvent & { type: 'assistant/message' }): TeamContextProjectionState {
  if (state.carriedCandidates.length === 0 || event.data.interrupted === true) return state
  let changed = false
  const carriedCandidates = state.carriedCandidates.map(candidate => {
    if (candidate.consumed || candidate.surfacedTurn !== event.data.turn) return candidate
    changed = true
    return { ...candidate, consumed: true }
  })
  return changed ? { ...state, carriedCandidates } : state
}

function applyTurnEnd(state: TeamContextProjectionState, seq: number, turn: number): TeamContextProjectionState {
  let changed = false
  // A later turn must not make an abandoned intent eligible for restart recovery.
  const checkpoints = state.checkpoints.map(entry => {
    if (entry.turnEndSeq !== -1 || entry.turn !== turn) return entry
    changed = true
    return { ...entry, turnEndSeq: seq }
  })
  let pending = state.pending
  if (pending !== null && pending.turnEndSeq === -1 && pending.turn === turn) {
    pending = { ...pending, turnEndSeq: seq }
    changed = true
  }
  return changed ? { ...state, checkpoints, pending } : state
}

function applyContextEvent(state: TeamContextProjectionState, event: SessionEvent, inputFromSeq?: number): TeamContextProjectionState {
  // The ancestor's events are that generation's facts: folding them here would
  // key its checkpoints to this Session and arm its intent as this one's.
  if (event.seq < state.inheritedEventCount) return state
  switch (event.type) {
    case 'tool/call': {
      const { name, arguments: raw } = event.data
      if (!isRolloverCall(name) && name !== CONTEXT_CHECKPOINT_TOOL_NAME) return state
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
      return applyInboxSpliced(state, event.data.inserted, inputFromSeq !== undefined && event.seq >= inputFromSeq)
    default:
      return state
  }
}

export function foldTeamContextProjection(
  events: readonly SessionEvent[],
  target: ContextFoldTarget,
): TeamContextProjectionState {
  let state = emptyContextProjectionState(target)
  for (const event of events) state = applyContextEvent(state, event, target.inputFromSeq)
  return state
}

export function createTeamContextProjectionDefinition(): ProjectionDefinition<typeof CONTEXT_CONTINUITY_PROJECTION_KEY, TeamContextProjectionState> {
  return {
    key: CONTEXT_CONTINUITY_PROJECTION_KEY,
    stateVersion: 3,
    stateSchema: contextProjectionStateSchema,
    init: (header: SessionHeader, inheritedEventCount: SessionLogOffset) => emptyContextProjectionState({
      sessionId: header.id,
      inheritedEventCount: Number(inheritedEventCount),
    }),
    apply: (state, event) => applyContextEvent(state, event),
  }
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
