/**
 * Serializes Host-requested generation swaps and restores legacy rollover
 * intents and checkpoint continuations. Owns process locks only; committed
 * transitions remain recoverable from the ledger and Session log.
 * @module @contexera/dsh-agent-team/team-context-management
 */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as SessionIdBrand } from '@deepseek-ai/dsh-session'
import type { AgentTeamAgentMember, AgentTeamMemberId, AgentTeamRequestId } from './types.ts'
import type { TeamContextProjectionState } from './context-projection.ts'
import { wakeRecycleIdentity, type TransitionIdentity } from './wake-recycle.ts'

export type TeamContextState = Pick<TeamContextProjectionState, 'pending' | 'checkpoints' | 'continuations'>

export interface TeamTransitionPlan extends TransitionIdentity {
  readonly previousSessionId: SessionId
}

/** The generation-boundary messages, built by the wiring that owns the codec. */
export interface TeamContextMessages {
  readonly continuation: (checkpointRef: string) => UserMessage
}

export interface TeamContextManagementOptions {
  readonly memberForAgent: (agent: Agent) => AgentTeamAgentMember | undefined
  readonly projectionForMember: (memberId: AgentTeamMemberId, sessionId: SessionId) => TeamContextState | undefined
  readonly executeTransition: (memberId: AgentTeamMemberId, plan: TeamTransitionPlan) => Promise<void>
  readonly messages: TeamContextMessages
  readonly log: (message: string) => void
}

/** Durable identity of one rollover: a result seq is session-local and collides across generations. */
export function teamRolloverIdentity(previousSessionId: SessionId, toolCallId: string): TransitionIdentity {
  const digest = createHash('sha256').update(JSON.stringify([previousSessionId, toolCallId])).digest('hex')
  return { newSessionId: SessionIdBrand(`agent-team-rollover-${digest}`), requestId: `agent-team:rollover:${digest}` as AgentTeamRequestId }
}

export class TeamContextManagement {
  private readonly members = new Set<AgentTeamMemberId>()
  private readonly settleWaiters = new Map<AgentTeamMemberId, Array<() => void>>()
  private readonly scheduledContinuations = new Set<string>()
  private readonly spentIntents = new Set<string>()
  private disposed = false

  constructor(private readonly options: TeamContextManagementOptions) {}

  isTransitioning(memberId: AgentTeamMemberId): boolean {
    return this.members.has(memberId)
  }

/** Resolves once no swap is in flight for this Member (immediately if none), so callers don't deliver into a Session about to be disposed. */
  whenSettled(memberId: AgentTeamMemberId): Promise<void> {
    if (!this.members.has(memberId)) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.settleWaiters.set(memberId, [...this.settleWaiters.get(memberId) ?? [], resolve])
    })
  }

  dispose(): void {
    this.disposed = true
    this.settleAll()
    this.members.clear()
    this.scheduledContinuations.clear()
    this.spentIntents.clear()
  }

  /**
   * Start the generation swap a Host wake decision asked for. There is no
   * durable intent to wait for: the decision is already taken, and the
   * identity derives from the retired Session so a crash between commit and
   * activation converges on the same successor.
   */
  requestRecycle(memberId: AgentTeamMemberId, member: AgentTeamAgentMember): Promise<void> {
    if (this.disposed || this.members.has(memberId)) return Promise.resolve()
    this.members.add(memberId)
    return this.performTransition(memberId, member, wakeRecycleIdentity(member.sessionId))
  }

  private async performTransition(
    memberId: AgentTeamMemberId,
    member: AgentTeamAgentMember,
    identity: TransitionIdentity,
  ): Promise<void> {
    try {
      await this.options.executeTransition(memberId, {
        previousSessionId: member.sessionId,
        newSessionId: identity.newSessionId,
        requestId: identity.requestId,
      })
    } catch (error) {
      this.options.log(`context swap did not complete: ${failureText(error)} (member ${memberId})`)
    } finally {
      this.members.delete(memberId)
      this.settleMember(memberId)
    }
  }

  private settleMember(memberId: AgentTeamMemberId): void {
    for (const resolve of this.settleWaiters.get(memberId) ?? []) resolve()
    this.settleWaiters.delete(memberId)
  }

  private settleAll(): void {
    for (const memberId of this.settleWaiters.keys()) this.settleMember(memberId)
  }

  /**
   * Crash-recovery hook the Host runs during activation: finish a rollover a
   * restart interrupted. Only a log written by the retired tool path can carry
   * an intent; its turn must have ended durably, because no live event can
   * complete it afterwards.
   */
  recoverPendingTransition(memberId: AgentTeamMemberId, agent: Agent, sessionId: SessionId): void {
    if (this.disposed || this.members.has(memberId)) return
    const state = this.options.projectionForMember(memberId, sessionId)
    const pending = state?.pending
    if (state === undefined || pending == null) return
    if (pending.turnEndSeq === -1) {
      const spent = `${memberId}:${sessionId}:${pending.toolCallId}`
      if (!this.spentIntents.has(spent)) {
        this.spentIntents.add(spent)
        this.options.log(`discarded a spent rollover intent ${pending.toolCallId}: its turn never ended durably (member ${memberId})`)
      }
      return
    }
    const member = this.options.memberForAgent(agent)
    if (member === undefined) return
    this.members.add(memberId)
    void this.performTransition(memberId, member, teamRolloverIdentity(member.sessionId, pending.toolCallId))
  }

  repairContinuations(agent: Agent, state: TeamContextState): void {
    if (this.disposed) return
    const memberId = this.options.memberForAgent(agent)?.memberId
    if (memberId === undefined) return
    for (const checkpoint of state.checkpoints) {
      if (!this.claimContinuationLatch(memberId, state, checkpoint)) continue
      try {
        agent.followup(this.options.messages.continuation(checkpoint.checkpointRef))
      } catch (error) {
        this.scheduledContinuations.delete(latchKey(memberId, checkpoint.checkpointRef))
        this.options.log(`context continuation repair failed: ${failureText(error)}`)
      }
    }
  }

  private claimContinuationLatch(memberId: AgentTeamMemberId, state: TeamContextState, checkpoint: { readonly checkpointRef: string; readonly turnEndSeq: number }): boolean {
    if (checkpoint.turnEndSeq === -1) return false
    if (state.continuations.some(entry => entry.checkpointRef === checkpoint.checkpointRef && entry.deliveredSeq !== -1)) return false
    const latch = latchKey(memberId, checkpoint.checkpointRef)
    if (this.scheduledContinuations.has(latch)) return false
    this.scheduledContinuations.add(latch)
    return true
  }
}

function latchKey(memberId: AgentTeamMemberId, checkpointRef: string): string {
  return `${memberId}:${checkpointRef}`
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
