/**
 * Team's own context-generation coordinator: turns a Member's durable rollover
 * intent into its next generation, at an idle boundary only — a swap under an
 * open turn would retire the generation still running it. Owns process locks
 * only; everything else is reconstructible from the ledger and the Session log.
 * @module @contexera/dsh-agent-team/team-context-management
 */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { SessionId as SessionIdBrand } from '@deepseek-ai/dsh-session'
import type { AgentTeamAgentMember, AgentTeamMemberId } from './types.ts'
import { wakeRecycleIdentity } from './wake-recycle.ts'

export interface TeamPendingIntent {
  readonly toolCallId: string
  readonly resultSeq: number
  readonly turn: number
  readonly turnEndSeq: number
}

/** The fields this coordinator reads from a Session's fold; the projection unit owns its full shape. */
export interface TeamContextState {
  readonly pending: TeamPendingIntent | null
  readonly checkpoints: readonly { readonly checkpointRef: string; readonly turnEndSeq: number }[]
  readonly continuations: readonly { readonly checkpointRef: string; readonly deliveredSeq: number }[]
}

export interface TeamTransitionPlan {
  readonly previousSessionId: SessionId
  readonly newSessionId: SessionId
  readonly requestId: string
  readonly carriedInput: readonly UserMessage[]
}

/** The generation-boundary messages, built by the wiring that owns the codec. */
export interface TeamContextMessages {
  readonly continuation: (checkpointRef: string) => UserMessage
}

export interface TeamContextManagementOptions {
  readonly agentForMember: (memberId: AgentTeamMemberId) => Agent | undefined
  readonly memberForAgent: (agent: Agent) => AgentTeamAgentMember | undefined
  readonly projectionForMember: (memberId: AgentTeamMemberId, sessionId: SessionId) => TeamContextState | undefined
  readonly executeTransition: (memberId: AgentTeamMemberId, plan: TeamTransitionPlan) => Promise<void>
  readonly messages: TeamContextMessages
  readonly log: (message: string) => void
}

interface MemberTransition {
  /** Absent for a requestRecycle swap: no live Agent opened it. */
  readonly agent: Agent | undefined
  readonly intent: TeamPendingIntent | undefined
  turnEnded: boolean
}

/** Durable identity of one rollover: a result seq is session-local and collides across generations. */
export function teamRolloverIdentity(previousSessionId: SessionId, toolCallId: string): { readonly newSessionId: SessionId; readonly requestId: string } {
  const digest = createHash('sha256').update(JSON.stringify([previousSessionId, toolCallId])).digest('hex')
  return { newSessionId: SessionIdBrand(`agent-team-rollover-${digest}`), requestId: `agent-team:rollover:${digest}` }
}

export class TeamContextManagement {
  private readonly members = new Map<AgentTeamMemberId, MemberTransition>()
  private readonly settleWaiters = new Map<AgentTeamMemberId, Array<() => void>>()
  private readonly scheduledContinuations = new Set<string>()
  private readonly spentIntents = new Set<string>()
  private disposed = false

  constructor(private readonly options: TeamContextManagementOptions) {}

  isTransitioning(memberId: AgentTeamMemberId): boolean {
    return this.members.has(memberId)
  }

  /**
   * Resolve once no swap is in flight for this Member — immediately when none
   * is. A caller holding a message for the generation being replaced awaits
   * this instead of delivering into a Session about to be disposed.
   */
  whenSettled(memberId: AgentTeamMemberId): Promise<void> {
    if (!this.members.has(memberId)) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.settleWaiters.set(memberId, [...this.settleWaiters.get(memberId) ?? [], resolve])
    })
  }

  onSessionEvent(memberId: AgentTeamMemberId, agent: Agent, event: SessionEvent): void {
    if (this.disposed) return
    if (event.type === 'tool/result') {
      this.onToolResult(memberId, agent, event)
      return
    }
    if (event.type === 'turn/end') this.onTurnEnd(memberId, agent)
  }

  dispose(): void {
    this.disposed = true
    this.settleAll()
    this.members.clear()
    this.scheduledContinuations.clear()
    this.spentIntents.clear()
  }

  private onToolResult(memberId: AgentTeamMemberId, agent: Agent, event: SessionEvent & { readonly type: 'tool/result' }): void {
    if (event.data.error !== undefined) return
    const member = this.options.memberForAgent(agent)
    if (member === undefined) return
    const pending = this.options.projectionForMember(memberId, member.sessionId)?.pending
    // Only the intent's own result landing durably starts a transition, and only once.
    if (pending == null || pending.resultSeq !== event.seq) return
    if (this.members.has(memberId)) return
    this.members.set(memberId, { agent, intent: pending, turnEnded: false })
  }

  private onTurnEnd(memberId: AgentTeamMemberId, agent: Agent): void {
    this.scheduleCheckpointContinuations(memberId, agent)
    const transition = this.members.get(memberId)
    const intent = transition?.intent
    if (transition === undefined || intent === undefined || transition.turnEnded) return
    const member = this.options.memberForAgent(agent)
    if (member === undefined || transition.agent !== agent) return
    transition.turnEnded = true
    // The turn-end event precedes driver convergence, so the swap waits for idle.
    void agent.whenIdle().then(() => {
      if (this.disposed) return
      if (this.members.get(memberId) !== transition) return
      if (this.options.agentForMember(memberId) !== agent) {
        // The Member moved to another generation while this one finished its
        // turn: drop the lock, or every later swap for it would be refused.
        this.members.delete(memberId)
        this.settleMember(memberId)
        return
      }
      void this.performTransition(memberId, member, teamRolloverIdentity(member.sessionId, intent.toolCallId))
    }, error => {
      this.options.log(`context rollover idle wait failed: ${failureText(error)} (member ${memberId})`)
      this.members.delete(memberId)
    })
  }

  /**
   * Start the generation swap a Host wake decision asked for. Unlike the
   * retired tool path there is no durable intent to wait for: the decision is
   * already taken, and the identity derives from the retired Session so a
   * crash between commit and activation converges on the same successor.
   */
  requestRecycle(memberId: AgentTeamMemberId, member: AgentTeamAgentMember): Promise<void> {
    if (this.disposed || this.members.has(memberId)) return Promise.resolve()
    this.members.set(memberId, { agent: undefined, intent: undefined, turnEnded: true })
    return this.performTransition(memberId, member, wakeRecycleIdentity(member.sessionId))
  }

  private async performTransition(
    memberId: AgentTeamMemberId,
    member: AgentTeamAgentMember,
    identity: { readonly newSessionId: SessionId; readonly requestId: string },
  ): Promise<void> {
    try {
      // Inside the guard as well as the await: a host that throws before
      // returning a promise loses the swap just as completely.
      await this.options.executeTransition(memberId, {
        previousSessionId: member.sessionId,
        newSessionId: identity.newSessionId,
        requestId: identity.requestId,
        // No process-local capture exists: the successor's Inbox and any queued
        // input are rederived from the durable log.
        carriedInput: [],
      })
    } catch (error) {
      this.options.log(`context rollover failed, leaving the previous generation recoverable: ${failureText(error)} (member ${memberId})`)
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
    for (const memberId of [...this.settleWaiters.keys()]) this.settleMember(memberId)
  }

  /** Crash-recovery hook the Host runs during activation: finish a swap a restart interrupted. */
  recoverPendingTransition(memberId: AgentTeamMemberId, agent: Agent, sessionId: SessionId): void {
    if (this.disposed || this.members.has(memberId)) return
    const state = this.options.projectionForMember(memberId, sessionId)
    const pending = state?.pending
    if (state === undefined || pending == null) return
    // An intent whose turn never ended durably is spent: no live event can
    // complete it, and honouring it would leave the generation un-swappable.
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
    this.members.set(memberId, { agent, intent: pending, turnEnded: true })
    void this.performTransition(memberId, member, teamRolloverIdentity(member.sessionId, pending.toolCallId))
  }

  /** Crash repair for quiet continuations: schedule the follow-up a durable result still owes. */
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

  /** Quiet follow-ups owed to checkpoints the turn just resolved; each waits for idle so its wake latches. */
  private scheduleCheckpointContinuations(memberId: AgentTeamMemberId, agent: Agent): void {
    const state = this.options.projectionForMember(memberId, agent.session.id)
    if (state === undefined) return
    for (const checkpoint of state.checkpoints) {
      if (!this.claimContinuationLatch(memberId, state, checkpoint)) continue
      const latch = latchKey(memberId, checkpoint.checkpointRef)
      void agent.whenIdle().then(() => {
        if (this.disposed) return
        try {
          agent.followup(this.options.messages.continuation(checkpoint.checkpointRef))
        } catch (error) {
          this.scheduledContinuations.delete(latch)
          this.options.log(`context continuation scheduling failed: ${failureText(error)} (member ${memberId})`)
        }
      }, () => {
        this.scheduledContinuations.delete(latch)
      })
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
