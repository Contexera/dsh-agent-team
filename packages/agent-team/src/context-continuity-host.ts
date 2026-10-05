/**
 * The Agent Team's binding of the context-continuity engine: how one Member
 * resolves to its live Agent and back, how a Member Session's fold state is
 * read, how a prepared generation swap runs in the Member lifecycle, and the
 * two domain dimensions the engine refuses to own (which queued messages are
 * Team notices, and how a rollover's durable identity is named).
 *
 * The engine owns every mechanic this module does not state: the idle-boundary
 * swap, carried input, checkpoint continuations, crash repair, and the
 * context-pressure policy itself. Team owns the Member vocabulary and the
 * ledger-backed lifecycle behind
 * {@link TeamContextContinuityOptions.executeTransition}, and the per-Member
 * readings the pressure policy asks for.
 *
 * The projection state this host hands the coordinator is the engine's own
 * (`ContextProjectionState`), read from the unit `context-projection.ts`
 * registers once per Host — one state shape, one fold, no translation.
 * @module @wowyuarm/dsh-agent-team/context-continuity-host
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import {
  ContextContinuityCoordinator,
  ContextMessageCodec,
  ContextPressurePolicy,
  type ContextContinuityHost,
  type ContextProjectionState,
  type ContextSubject,
  type PressureCompaction,
  type PressureGate,
  type PressureInHand,
  type PressureJudgement,
  type PressureLimits,
  type PressureLogSpan,
  type PressureNoticeText,
  type PressurePolicyHost,
  type PressureRelatedness,
  type PressureStepDecision,
  type PressureSurface,
  type RolloverIdentity,
  type TransitionPlan,
} from '@wowyuarm/dsh-context-continuity'
import { SessionId as SessionIdBrand } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { AGENT_TEAM_PLUGIN_ID, isAgentTeamSource } from './context-source.ts'
import type { AgentTeamAgentMember, AgentTeamMemberId, AgentTeamRolloverSessionRequest } from './types.ts'

/**
 * The one writer of context-continuity messages for Team. Section names are
 * the engine's fixed vocabulary; only the plugin identity and the two
 * subject-facing prose lines are Team's, and both are frozen by history —
 * durable logs written by earlier generations are read back through this same
 * identity, so `handoffIntro` and `handoffVerifyNote` reproduce them byte for
 * byte.
 */
export const TEAM_CONTEXT_CODEC = new ContextMessageCodec({
  pluginId: AGENT_TEAM_PLUGIN_ID,
  handoffIntro: 'Context handoff: you are continuing as the same Team Member in a fresh private context.',
  handoffVerifyNote: 'Your handoff from the previous context follows. Verify external state before relying on it; a context change never rolls back files, processes, Team facts, or remote side effects.',
})

export interface TeamContextContinuityOptions {
  /** Resolve the live Agent of one Member; undefined leaves intent parked. */
  readonly agentForMember: (memberId: AgentTeamMemberId) => Agent | undefined
  /** Resolve the durable Member of one live Agent. */
  readonly memberForAgent: (agent: Agent) => AgentTeamAgentMember | undefined
  /**
   * Read one Member Session's engine-folded continuity state: the unit
   * registered by `context-projection.ts`, or undefined when the Member has no
   * live Session with that id (the coordinator leaves intent parked).
   */
  readonly projectionForMember: (memberId: AgentTeamMemberId, sessionId: SessionId) => ContextProjectionState | undefined
  /**
   * Execute one prepared Member generation swap at a true idle boundary:
   * commit, dispose, archive, create/activate, deliver the handoff first,
   * then carried input and the rederived Inbox. Returns once the Member runs
   * its new generation.
   */
  readonly executeTransition: (memberId: AgentTeamMemberId, plan: TransitionPlan) => Promise<void>
  /** Log one coordinator diagnostic. */
  readonly log: (message: string) => void
}

/**
 * Team's `ContextContinuityHost`. Every method is a straight delegation except
 * the three that decide domain meaning: the durable rollover identity, which
 * queued messages are rederived Team notices, and the projection bridge.
 */
export class TeamContextContinuityHost implements ContextContinuityHost<AgentTeamMemberId> {
  constructor(private readonly options: TeamContextContinuityOptions) {}

  agentForSubject(memberId: AgentTeamMemberId): Agent | undefined {
    return this.options.agentForMember(memberId)
  }

  subjectForAgent(agent: Agent): ContextSubject<AgentTeamMemberId> | undefined {
    const member = this.options.memberForAgent(agent)
    if (member === undefined) return undefined
    return { id: member.memberId, sessionId: member.sessionId }
  }

  projectionForSubject(memberId: AgentTeamMemberId, sessionId: SessionId): ContextProjectionState | undefined {
    return this.options.projectionForMember(memberId, sessionId)
  }

  executeTransition(memberId: AgentTeamMemberId, plan: TransitionPlan): Promise<void> {
    return this.options.executeTransition(memberId, plan)
  }

  /**
   * Rollover identity, unchanged from the in-repo coordinator: stable key over
   * the previous Session and the successful tool call, JSON-encoded so no
   * delimiter can alias across the two unconstrained fields, then hashed to a
   * fixed-length digest. Both names are durable — in-flight recovery converges
   * on `agent-team-rollover-<digest>`, and the ledger records the request id.
   */
  rolloverIdentity(previousSessionId: SessionId, toolCallId: string): RolloverIdentity {
    const stableKey = createHash('sha256').update(JSON.stringify([previousSessionId, toolCallId])).digest('hex')
    return {
      newSessionId: SessionIdBrand(`agent-team-rollover-${stableKey}`),
      requestId: `agent-team:rollover:${stableKey}` as AgentTeamRolloverSessionRequest['requestId'],
    }
  }

  /**
   * A queued message the successor generation rederives from ledger facts: any
   * Team-attributed message. The engine excludes the handoff and continuation
   * envelopes before consulting this, so the two are ordinary delivered
   * context the next generation keeps.
   */
  isEphemeralNotice(message: UserMessage): boolean {
    return isAgentTeamSource(message.source)
  }

  log(message: string): void {
    this.options.log(message)
  }
}

/** Build the engine coordinator over Team's Member lifecycle. */
export function createTeamContextManagement(options: TeamContextContinuityOptions): ContextContinuityCoordinator<AgentTeamMemberId> {
  return new ContextContinuityCoordinator(new TeamContextContinuityHost(options), TEAM_CONTEXT_CODEC)
}

/**
 * Team's wording for the engine's pressure notice: the two labels name work in
 * Team's own vocabulary, while the numbers, the ordering and the default action
 * stay the engine's. A label is presentation; the notice's substance is not a
 * knob.
 */
const TEAM_PRESSURE_TEXT: PressureNoticeText = {
  inHandLabel: 'Active Claims',
  jobsLabel: 'Owner jobs',
}

/** How many of the generation's earlier user inputs one judgement is given. */
const RECENT_INPUT_LIMIT = 8

/**
 * The long-gap gate as row configuration: every field is optional, so a
 * deployment states only the thresholds it disagrees with and the engine's own
 * default answers the rest. The three answer different questions — how large a
 * context the gate applies to, what counts as a long gap, and how long one
 * judgement may take before the step proceeds without one — and the last is the
 * one that decides whether a configured judge is ever heard, because a judge
 * whose own budget is longer than this deadline never answers in time.
 *
 * All three are volatile, and the engine is what makes that safe: it reads
 * every field at the step it applies to, never at construction, so a Host that
 * keeps one gate object and refreshes its fields in place changes the policy a
 * running generation is judged by. `judgeTimeoutMs` is the field that needs it
 * most — the deadline a judge can answer within is a property of the endpoint,
 * not of the bundle, and a deployment that discovers its endpoint is slow must
 * be able to raise it without editing a patch layer and restarting.
 */
export const TEAM_PRESSURE_GATE_SCHEMA = z.object({
  tokens: z.natural().volatile().description('Context size at or above which the long-gap gate may hold a step. Default: 128000.'),
  idleMs: z.natural().volatile().description('How long a generation must have been idle for a step to count as a long gap. Default: 1800000 (30 minutes).'),
  judgeTimeoutMs: z.natural().volatile().description("How long one relatedness judgement may take before the step proceeds without one. Default: 10000, not the engine's own 5000."),
})

export interface TeamPressurePolicyOptions {
  /** Resolve the live Agent of one Member; absent means nothing to read. */
  readonly agentForMember: (memberId: AgentTeamMemberId) => Agent | undefined
  /** Effective budgets for one Member's current route; undefined means unknown. */
  readonly limitsForAgent: (agent: Agent) => PressureLimits | undefined | Promise<PressureLimits | undefined>
  /** The reduction capability in one Member's preset scope, or absent when it mounts none. */
  readonly compactionForAgent: (agent: Agent) => PressureCompaction | undefined
  /** The model-visible active-Claim labels for one Member's notice. */
  readonly activeClaimLabels: (memberId: AgentTeamMemberId) => readonly string[]
  /** The model-visible running-job labels for one Member's notice. */
  readonly runningJobLabels: (memberId: AgentTeamMemberId) => readonly string[]
  /** The long-gap gate's thresholds; an omitted field keeps the engine's default. */
  readonly gate?: PressureGate | undefined
  /**
   * The relatedness judge in one Member's scope, when the deployment installed
   * one. Absent — the member itself, or the whole deployment — switches the
   * long-gap gate off; a missing judge is a deployment choice, never a failure.
   */
  readonly judgeForAgent?: ((agent: Agent) => PressureJudgement | undefined) | undefined
  /** Report a blocked request with a recoverable diagnostic. */
  readonly failed: (memberId: AgentTeamMemberId, diagnostic: string) => void
  /** Log one engine diagnostic, attributable to the Member it names. */
  readonly log: (message: string, memberId: AgentTeamMemberId) => void
}

/**
 * Team's `PressurePolicyHost`. Every member is resolved per Member at call
 * time, because one policy serves every Member this Host runs. The readings
 * that need the step's own argument are fed for exactly one policy call —
 * {@link beginStep} to {@link endStep} — so a judgement is never made from a
 * neighbour Member's messages.
 */
export class TeamPressurePolicyHost implements PressurePolicyHost<AgentTeamMemberId> {
  readonly pluginId = AGENT_TEAM_PLUGIN_ID
  private readonly admitting = new Map<AgentTeamMemberId, readonly UserMessage[]>()

  constructor(private readonly options: TeamPressurePolicyOptions) {}

  /** Record the input one step is admitting: the host's own pre-step argument. */
  beginStep(memberId: AgentTeamMemberId, messages: readonly UserMessage[]): void {
    this.admitting.set(memberId, messages)
  }

  /** Forget that input again: the view lives only while its policy call runs. */
  endStep(memberId: AgentTeamMemberId): void {
    this.admitting.delete(memberId)
  }

  limitsFor(memberId: AgentTeamMemberId): PressureLimits | undefined | Promise<PressureLimits | undefined> {
    const agent = this.options.agentForMember(memberId)
    return agent === undefined ? undefined : this.options.limitsForAgent(agent)
  }

  /**
   * The Member's durable surface, for proving a reduction. Without a live Agent
   * there is nothing to measure; the policy reaches this only for a Member whose
   * limits resolved, which already requires one.
   */
  surfaceFor(memberId: AgentTeamMemberId): PressureSurface {
    const agent = this.options.agentForMember(memberId)
    if (agent === undefined) return { generation: 0 }
    const tokens = agent.ctx.get('tokenMeter')?.measure(agent.session)?.totalTokens
    return { generation: agent.session.surface.replaceGeneration, ...(tokens === undefined ? {} : { tokens }) }
  }

  compactionFor(memberId: AgentTeamMemberId): PressureCompaction | undefined {
    const agent = this.options.agentForMember(memberId)
    return agent === undefined ? undefined : this.options.compactionForAgent(agent)
  }

  /**
   * The Member's durable log, as the notice latch and the idle gap read it. The
   * engine's contract asks for the span's own events and the inherited count
   * beside them; the `ownEvents()` reader is what states that boundary today.
   */
  logSpanFor(memberId: AgentTeamMemberId): PressureLogSpan {
    const agent = this.options.agentForMember(memberId)
    if (agent === undefined) return { sessionId: '', inheritedEventCount: 0, events: [] }
    return { sessionId: agent.session.id, inheritedEventCount: agent.session.inheritedEventCount, events: agent.session.ownEvents() }
  }

  inHandFor(memberId: AgentTeamMemberId): PressureInHand {
    return {
      inHand: this.options.activeClaimLabels(memberId),
      jobs: this.options.runningJobLabels(memberId),
    }
  }

  /**
   * The input this step is admitting, and the generation's earlier user input
   * beside it. Both sides exclude Team's own notices: what the gate judges is
   * what a human sent, and a rederived Team notification is neither the request
   * being held nor evidence of what the request continues.
   */
  relatednessFor(memberId: AgentTeamMemberId): PressureRelatedness | undefined {
    const agent = this.options.agentForMember(memberId)
    const admitted = this.admitting.get(memberId)
    if (agent === undefined || admitted === undefined) return undefined
    const input = externalInputText(admitted)
    if (input.trim().length === 0) return undefined
    return { input, recent: this.recentInput(agent, admitted) }
  }

  /**
   * The generation's earlier human input, oldest first, without the messages
   * this step is admitting: the judge is asked what the arriving request
   * continues, so the arriving request is not also part of its own evidence.
   */
  private recentInput(agent: Agent, admitted: readonly UserMessage[]): readonly string[] {
    const admittedIds = new Set(admitted.map(message => message.id))
    return agent.session.deriveMessages()
      .flatMap(message => message.role === 'user' && !admittedIds.has(message.id) && !isAgentTeamSource(message.source)
        ? [messageText(message)]
        : [])
      .filter(text => text.trim().length > 0)
      .slice(-RECENT_INPUT_LIMIT)
  }

  judgeFor(memberId: AgentTeamMemberId): PressureJudgement | undefined {
    const resolve = this.options.judgeForAgent
    const agent = this.options.agentForMember(memberId)
    if (resolve === undefined || agent === undefined) return undefined
    return resolve(agent)
  }

  /**
   * Steer one notice into the Member's running turn. A Member with no live
   * Agent throws rather than reporting success: the caller holds a step on the
   * strength of this call, and a held step whose instruction never arrived
   * would stall the Member behind a message that does not exist.
   */
  steer(memberId: AgentTeamMemberId, notice: UserMessage): void {
    const agent = this.options.agentForMember(memberId)
    if (agent === undefined) throw new Error('the Member has no live Agent to steer the notice into')
    agent.steer(notice)
  }

  failedFor(memberId: AgentTeamMemberId, diagnostic: string): void {
    this.options.failed(memberId, diagnostic)
  }

  log(message: string, memberId: AgentTeamMemberId): void {
    this.options.log(message, memberId)
  }
}

/**
 * The engine's context-pressure policy over Team's Member lifecycle: the one
 * place the two sides meet. It owns no decision of its own — the ordering, the
 * notice latch, the fail-closed reduction proof and the long-gap gate are all
 * the engine's — and adds only the step-scoped input view that only the host
 * can have.
 */
export class TeamPressurePolicy {
  private readonly host: TeamPressurePolicyHost
  private readonly policy: ContextPressurePolicy<AgentTeamMemberId>

  constructor(options: TeamPressurePolicyOptions) {
    this.host = new TeamPressurePolicyHost(options)
    this.policy = new ContextPressurePolicy(this.host, TEAM_PRESSURE_TEXT, options.gate)
  }

  /** The pre-step decision for one Member, with the input that step claims. */
  async onPreStep(memberId: AgentTeamMemberId, messages: readonly UserMessage[], signal: AbortSignal): Promise<PressureStepDecision> {
    this.host.beginStep(memberId, messages)
    try {
      return await this.policy.onPreStep(memberId, signal)
    } finally {
      this.host.endStep(memberId)
    }
  }

  onRequestError(memberId: AgentTeamMemberId, failure: { readonly code?: string | undefined }, signal: AbortSignal): Promise<boolean> {
    return this.policy.onRequestError(memberId, failure, signal)
  }

  onAssistantMessage(memberId: AgentTeamMemberId): void {
    this.policy.onAssistantMessage(memberId)
  }

  dispose(): void {
    this.policy.dispose()
  }
}

/** The text a step is admitting that came from outside Team, in arrival order. */
function externalInputText(messages: readonly UserMessage[]): string {
  return messages.flatMap(message => isAgentTeamSource(message.source) ? [] : [messageText(message)]).join('\n')
}

/** One message's visible text, blocks in order. */
function messageText(message: Message): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}
