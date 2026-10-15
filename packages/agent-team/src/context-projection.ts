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
  type AnchorCandidate,
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

const PRE_COMPACTION_NOTICE_SUMMARY = 'Compaction is imminent; consider persisting key conclusions.'

const TEAM_CLAIM_TOOL_NAME = 'team_claim'

const TEAM_MESSAGE_TOOL_NAME = 'team_message'

const TEAM_ATTENTION_TOOL_NAME = 'team_attention'

/**
 * Legacy decoder name: attention moved `team_thread` → `team_attention`, and
 * Sessions recorded before the split still carry durable `team_thread`
 * follow/unfollow call/result pairs. The fold keeps decoding them — cold refolds
 * and crash recovery of existing Members depend on old events still resolving
 * intent — but this is a log decoder, not a tool alias: no new call can carry
 * the old name, because `team_thread` no longer registers `follow`/`unfollow`.
 */
const LEGACY_TEAM_THREAD_TOOL_NAME = 'team_thread'

const TEAM_MESSAGE_BOUNDARY_LABEL = 'Team message'
const TEAM_ATTENTION_BOUNDARY_LABEL = 'Team attention change'
const TEAM_CLAIM_BOUNDARY_LABEL = 'Team task claim change'

const HANDOFF_BOUNDARY_LABEL = 'context handoff'

const COMPACTION_BOUNDARY_LABEL = 'compaction notice'

const TEAM_BOUNDARY_KINDS = ['team-boundary', 'handoff', 'compaction'] as const

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

export function checkpointRefFor(sessionId: string, callId: string): AgentTeamContextCheckpointRef {
  return `context-checkpoint-${createHash('sha256').update(JSON.stringify([sessionId, callId])).digest('hex')}` as AgentTeamContextCheckpointRef
}

export function boundaryRefFor(sessionId: string, seq: number): AgentTeamContextCheckpointRef {
  return `team-boundary-${createHash('sha256').update(JSON.stringify([sessionId, seq])).digest('hex')}` as AgentTeamContextCheckpointRef
}

export function isTeamNotice(message: UserMessage): boolean {
  const source = message.source
  return isAgentTeamSource(source) && !isAgentTeamContextSource(message)
}

function isTeamEffectToolName(name: string): boolean {
  return name === TEAM_CLAIM_TOOL_NAME || name === TEAM_MESSAGE_TOOL_NAME || name === TEAM_ATTENTION_TOOL_NAME || name === LEGACY_TEAM_THREAD_TOOL_NAME
}

function isAttentionToolName(name: string): boolean {
  return name === TEAM_ATTENTION_TOOL_NAME || name === LEGACY_TEAM_THREAD_TOOL_NAME
}

function parseArguments(raw: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
}

function actionOf(raw: string): unknown {
  return parseArguments(raw)?.action
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
  const threadRef = parseArguments(raw)?.threadRef
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

export class TeamContextProjectionHost implements ContextProjectionHost {
  constructor(private readonly options: TeamContextProjectionOptions = {}) {}

  checkpointRefFor(sessionId: string, toolCallId: string): AgentTeamContextCheckpointRef {
    return checkpointRefFor(sessionId, toolCallId)
  }

  boundaryRefFor(sessionId: string, seq: number): AgentTeamContextCheckpointRef {
    return boundaryRefFor(sessionId, seq)
  }

  isEphemeralNotice(message: UserMessage): boolean {
    return isTeamNotice(message)
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

  boundaryRestorableFor(candidate: AnchorCandidate): string | undefined {
    return candidate.kind === 'handoff' || candidate.kind === 'compaction'
      ? `source '${candidate.kind}' is not a restorable checkpoint`
      : undefined
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
      const taskRef = parseArguments(raw)?.taskRef
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
      if (meta === undefined || typeof meta !== 'object' || meta === null) return undefined
      const { kind, threadRef } = meta as { kind?: unknown; threadRef?: unknown }
      if (kind !== 'committed' || typeof threadRef !== 'string' || threadRef === '') return undefined
      return { kind: 'team-boundary', label: TEAM_MESSAGE_BOUNDARY_LABEL, topics: [threadRef] }
    }
    return undefined
  }
}

export function createTeamContextProjectionConfig(host: ContextProjectionHost): ContextProjectionConfig {
  return {
    codec: TEAM_CONTEXT_CODEC,
    host,
    rolloverToolNames: TEAM_ROLLOVER_TOOL_NAMES,
    checkpointToolName: CONTEXT_CHECKPOINT_TOOL_NAME,
  }
}

export function foldTeamContextProjection(
  events: readonly SessionEvent[],
  target: ContextFoldTarget,
  host: ContextProjectionHost = new TeamContextProjectionHost(),
): ContextProjectionState {
  return foldEngineContextProjection(events, createTeamContextProjectionConfig(host), target)
}

export function createTeamContextProjectionDefinition(host: ContextProjectionHost): ReturnType<typeof createContextProjectionDefinition> {
  return createContextProjectionDefinition(createTeamContextProjectionConfig(host))
}

export function checkpointByRef(state: ContextProjectionState, checkpointRef: string): ContextCheckpointEntry | undefined {
  return state.checkpoints.find(entry => entry.checkpointRef === checkpointRef && entry.turnEndSeq !== -1)
}

export function boundaryByRef(state: ContextProjectionState, ref: string): DomainBoundary | undefined {
  return state.boundaries.find(boundary => boundaryRefFor(state.sessionId, boundary.resultSeq) === ref)
}

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
