/**
 * Team's own generation coordinator: the idle-boundary swap, the crash-resume
 * branches, and the quiet continuation this Host still owes after a restart.
 * The end-to-end swap itself belongs to the Member-lifecycle suite; what this
 * file pins is the process-lock half, which has no durable trace to inspect.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TeamContextManagement, teamRolloverIdentity, type TeamContextState, type TeamTransitionPlan } from '../src/team-context-management.ts'
import type { AgentTeamAgentMember, AgentTeamMemberId } from '../src/types.ts'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'

const MEMBER_ID = 'member:one' as AgentTeamMemberId
const SESSION_ID = SessionId('session:one')
const member = { memberId: MEMBER_ID, sessionId: SESSION_ID } as AgentTeamAgentMember

/** One message body, for asserting which envelope the coordinator built. */
const continuationFor = (checkpointRef: string): UserMessage => createUserMessage({
  content: [{ type: 'text', text: `continuation:${checkpointRef}` }],
  source: { kind: 'user' },
})

/** A live Agent exposing exactly what the coordinator touches. */
function fakeAgent(): { readonly agent: Agent; readonly followed: UserMessage[]; readonly idler: () => void } {
  const followed: UserMessage[] = []
  let releaseIdle: () => void = () => {}
  const idle = new Promise<void>(resolve => { releaseIdle = resolve })
  const agent = {
    id: 'agent:one',
    session: { id: SESSION_ID },
    whenIdle: () => idle,
    followup: (message: UserMessage) => { followed.push(message) },
  } as unknown as Agent
  return { agent, followed, idler: () => { releaseIdle() } }
}

/** A coordinator over one fake Member, with the state its fold would answer. */
function management(options: {
  readonly agent: Agent
  readonly states: readonly TeamContextState[]
  readonly executeTransition?: (memberId: AgentTeamMemberId, plan: TeamTransitionPlan) => Promise<void>
  readonly logs?: string[]
}) {
  let reads = 0
  return new TeamContextManagement({
    agentForMember: id => (id === MEMBER_ID ? options.agent : undefined),
    memberForAgent: candidate => (candidate === options.agent ? member : undefined),
    projectionForMember: () => options.states[Math.min(reads++, options.states.length - 1)],
    executeTransition: options.executeTransition ?? (() => Promise.resolve()),
    messages: { continuation: continuationFor },
    log: message => { options.logs?.push(message) },
  })
}

const idleState: TeamContextState = { pending: null, checkpoints: [], continuations: [] }

describe('the Team generation coordinator', () => {
  it('derives the same durable rollover identity the Host records', () => {
    const identity = teamRolloverIdentity(SessionId('session:one'), 'call-1')
    // The digest is durable: in-flight recovery converges on the Session id and
    // the ledger records the request id, so both must stay byte-identical.
    const digest = '57207ab4cee751e63f481d7e232f2ba9a73efdacd4a0021173b874998bd38dc4'
    expect(String(identity.newSessionId)).toBe(`agent-team-rollover-${digest}`)
    expect(identity.requestId).toBe(`agent-team:rollover:${digest}`)
  })

  it('swaps on the live turn end, and only after idle', async () => {
    // The live path: the intent's own durable result opens the transition and
    // the containing turn's end releases it. The turn-end event precedes driver
    // convergence, so nothing may swap until the Agent reports idle.
    const executeTransition = vi.fn((_memberId: AgentTeamMemberId, _plan: TeamTransitionPlan) => Promise.resolve())
    const { agent, idler } = fakeAgent()
    const pending = { toolCallId: 'call-live', resultSeq: 4, turn: 2, turnEndSeq: -1 }
    const coordinator = management({ agent, states: [{ ...idleState, pending }], executeTransition })

    coordinator.onSessionEvent(MEMBER_ID, agent, { type: 'tool/result', seq: 4, data: {} } as unknown as SessionEvent)
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(true)

    coordinator.onSessionEvent(MEMBER_ID, agent, { type: 'turn/end' } as SessionEvent)
    expect(executeTransition).not.toHaveBeenCalled()
    idler()
    await new Promise(resolve => setImmediate(resolve))

    expect(executeTransition).toHaveBeenCalledTimes(1)
    expect(executeTransition.mock.calls[0]?.[0]).toBe(MEMBER_ID)
    expect(executeTransition.mock.calls[0]?.[1]).toMatchObject({ previousSessionId: SESSION_ID, carriedInput: [] })
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(false)
  })

  it('discards a legacy intent whose turn never ended instead of blocking the generation forever', async () => {
    // A log written by an earlier build can still hold a parked intent whose
    // containing turn never ended. No live event can complete it, so honouring
    // it would leave this generation permanently un-swappable.
    const executeTransition = vi.fn((_memberId: AgentTeamMemberId, _plan: TeamTransitionPlan) => Promise.resolve())
    const { agent } = fakeAgent()
    const pending = { toolCallId: 'call-spent', resultSeq: 4, turn: 2, turnEndSeq: -1 }
    const logs: string[] = []
    const coordinator = management({ agent, states: [{ ...idleState, pending }], executeTransition, logs })

    coordinator.recoverPendingTransition(MEMBER_ID, agent, SESSION_ID)

    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(false)
    expect(executeTransition).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('discarded a spent rollover intent call-spent')
    // A second activation of the same log reports nothing new: the line is
    // diagnostic, not a per-boot alarm.
    coordinator.recoverPendingTransition(MEMBER_ID, agent, SESSION_ID)
    expect(logs).toHaveLength(1)
  })

  it('finishes a recovered intent whose turn ended before the crash, carrying no captured input', async () => {
    const executeTransition = vi.fn((_memberId: AgentTeamMemberId, _plan: TeamTransitionPlan) => Promise.resolve())
    const { agent } = fakeAgent()
    const pending = { toolCallId: 'call-done', resultSeq: 9, turn: 3, turnEndSeq: 12 }
    const coordinator = management({ agent, states: [{ ...idleState, pending }], executeTransition })

    coordinator.recoverPendingTransition(MEMBER_ID, agent, SESSION_ID)
    await new Promise(resolve => setImmediate(resolve))

    expect(executeTransition).toHaveBeenCalledTimes(1)
    const plan = executeTransition.mock.calls[0]![1]
    // A recovered swap carries the durable envelope only: nothing was captured
    // in process, so the successor starts from its own durable context.
    expect(plan).toMatchObject({ previousSessionId: SESSION_ID })
    expect(plan.carriedInput).toEqual([])
    expect(String(plan.newSessionId)).toMatch(/^agent-team-rollover-[0-9a-f]{64}$/)
  })

  it('leaves the generation recoverable when the swap rejects', async () => {
    const logs: string[] = []
    const { agent } = fakeAgent()
    const pending = { toolCallId: 'call-fail', resultSeq: 1, turn: 0, turnEndSeq: 3 }
    const coordinator = management({
      agent,
      states: [{ ...idleState, pending }],
      executeTransition: () => Promise.reject(new Error('still running')),
      logs,
    })

    coordinator.recoverPendingTransition(MEMBER_ID, agent, SESSION_ID)
    await new Promise(resolve => setImmediate(resolve))

    // The lock is released so a later turn can retry; the durable binding is
    // untouched, which is what makes the previous generation recoverable.
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(false)
    expect(logs.join('\n')).toContain('still running')
  })

  it('starts a transition only on the intent\'s own durable result', () => {
    const { agent } = fakeAgent()
    const pending = { toolCallId: 'call-x', resultSeq: 7, turn: 1, turnEndSeq: -1 }
    const coordinator = management({ agent, states: [{ ...idleState, pending }] })

    coordinator.onSessionEvent(MEMBER_ID, agent, { type: 'tool/result', seq: 6, data: {} } as unknown as SessionEvent)
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(false)
    coordinator.onSessionEvent(MEMBER_ID, agent, { type: 'tool/result', seq: 7, data: { error: 'failed' } } as unknown as SessionEvent)
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(false)
    coordinator.onSessionEvent(MEMBER_ID, agent, { type: 'tool/result', seq: 7, data: {} } as unknown as SessionEvent)
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(true)
  })

  it('refuses the swap once the Agent behind the intent has already been replaced', async () => {
    // The delivery target is read at swap time, not when the intent landed:
    // between the two the Member may have moved to another generation, and
    // swapping for the old Agent would retire the wrong generation.
    const executeTransition = vi.fn((_memberId: AgentTeamMemberId, _plan: TeamTransitionPlan) => Promise.resolve())
    const first = fakeAgent()
    const second = fakeAgent()
    const pending = { toolCallId: 'call-replaced', resultSeq: 4, turn: 2, turnEndSeq: -1 }
    const coordinator = new TeamContextManagement({
      // The delivery target is read at swap time, not when the intent landed:
      // between the two the Member may have moved to another generation, and
      // swapping for the old Agent would retire the wrong generation.
      agentForMember: id => (id === MEMBER_ID ? second.agent : undefined),
      memberForAgent: candidate => (candidate === undefined ? undefined : member),
      projectionForMember: () => ({ ...idleState, pending }),
      executeTransition,
      messages: { continuation: continuationFor },
      log: () => {},
    })

    coordinator.onSessionEvent(MEMBER_ID, first.agent, { type: 'tool/result', seq: 4, data: {} } as unknown as SessionEvent)
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(true)
    coordinator.onSessionEvent(MEMBER_ID, first.agent, { type: 'turn/end' } as SessionEvent)
    first.idler()
    await new Promise(resolve => setImmediate(resolve))

    expect(executeTransition).not.toHaveBeenCalled()
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(false)
  })

  it('starts a Host-requested swap immediately, with a successor derived from the retired Session', async () => {
    const executeTransition = vi.fn((_memberId: AgentTeamMemberId, _plan: TeamTransitionPlan) => Promise.resolve())
    const { agent } = fakeAgent()
    const coordinator = management({ agent, states: [idleState], executeTransition })

    await coordinator.requestRecycle(MEMBER_ID, member)

    expect(executeTransition).toHaveBeenCalledTimes(1)
    expect(executeTransition.mock.calls[0]![1]).toMatchObject({ previousSessionId: SESSION_ID, carriedInput: [] })
    expect(String(executeTransition.mock.calls[0]![1].newSessionId)).toMatch(/^agent-team-recycle-[0-9a-f]{64}$/)
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(false)
  })

  it('ignores a second Host request while one swap is in flight and settles its waiters', async () => {
    const gate = Promise.withResolvers<void>()
    const executeTransition = vi.fn((_memberId: AgentTeamMemberId, _plan: TeamTransitionPlan) => gate.promise)
    const { agent } = fakeAgent()
    const coordinator = management({ agent, states: [idleState], executeTransition })

    const first = coordinator.requestRecycle(MEMBER_ID, member)
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(true)
    // A second request (a message racing the swap) must not start a third
    // generation; it joins the one already running.
    await coordinator.requestRecycle(MEMBER_ID, member)
    expect(executeTransition).toHaveBeenCalledTimes(1)

    const settled = coordinator.whenSettled(MEMBER_ID)
    let settledYet = false
    void settled.then(() => { settledYet = true })
    await Promise.resolve()
    expect(settledYet).toBe(false)

    gate.resolve()
    await first
    await settled
    expect(coordinator.isTransitioning(MEMBER_ID)).toBe(false)
  })

  it('settles every waiter when the Host disposes the coordinator mid-swap', async () => {
    const gate = Promise.withResolvers<void>()
    const { agent } = fakeAgent()
    const coordinator = management({ agent, states: [idleState], executeTransition: () => gate.promise })

    void coordinator.requestRecycle(MEMBER_ID, member)
    const settled = coordinator.whenSettled(MEMBER_ID)
    coordinator.dispose()
    await settled
  })

  it('repairs exactly one quiet continuation per resolved, undelivered checkpoint', () => {
    const { agent, followed } = fakeAgent()
    const state: TeamContextState = {
      pending: null,
      checkpoints: [
        { checkpointRef: 'context-checkpoint-a', turnEndSeq: 4 },
        { checkpointRef: 'context-checkpoint-b', turnEndSeq: 5 },
        { checkpointRef: 'context-checkpoint-c', turnEndSeq: -1 },
      ],
      continuations: [{ checkpointRef: 'context-checkpoint-b', deliveredSeq: 6 }],
    }
    const coordinator = management({ agent, states: [state] })

    coordinator.repairContinuations(agent, state)
    // A second repair in the same process never re-sends: the latch covers the
    // window before the delivery event lands in the log.
    coordinator.repairContinuations(agent, state)

    expect(followed.map(message => (message.content[0] as { readonly text: string }).text))
      .toEqual(['continuation:context-checkpoint-a'])
  })
})
