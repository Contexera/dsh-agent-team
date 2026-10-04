/**
 * Team's binding of the context-continuity engine: the message codec Team
 * writes through, the durable rollover identity the host derives, the notice
 * rule the engine consults, the projection state the host hands back
 * untranslated, and which recovery branch activation takes on a spent rollover
 * intent. The lifecycle behavior these feed — the swap, carried input, the
 * end-to-end restart repair — stays covered by the member-lifecycle and
 * context-projection suites.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isDroppedNotice, type ContextProjectionState, type PressureJudgement, type TransitionPlan } from '@wowyuarm/dsh-context-continuity'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { TEAM_CONTEXT_CODEC, TeamContextContinuityHost, TeamPressurePolicy, TeamPressurePolicyHost, createTeamContextManagement } from '../src/context-continuity-host.ts'
import type { AgentTeamAgentMember, AgentTeamMemberId } from '../src/types.ts'

const MEMBER_ID = 'member:one' as AgentTeamMemberId
const SESSION_ID = SessionId('session:one')

/** The model-facing text of one message. */
function bodyOf(message: { readonly content: readonly unknown[] }): string {
  const part = message.content[0] as { readonly type: string; readonly text: string }
  return part.text
}

/** The snapshot sections of one message, or undefined when another producer owns it. */
function sectionsOf(message: { readonly source: unknown }): readonly { readonly name: string; readonly text: string }[] | undefined {
  const source = message.source as { readonly kind?: string; readonly form?: string; readonly sections?: readonly { readonly name: string; readonly text: string }[] }
  return source.kind === AGENT_TEAM_PLUGIN_ID && source.form === 'snapshot' ? source.sections : undefined
}

describe('the Team context codec', () => {
  it('writes the frozen handoff envelope byte for byte', () => {
    const message = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: 'Handoff prose.',
      previousSessionId: 'session:one',
      newSessionId: 'session:two',
      trigger: 'model',
      handoffEventSeq: 7,
      checkpointRef: 'context-checkpoint-abc',
      relatedFiles: [{ path: 'a/b.ts', reason: 'first' }, { path: 'c.ts', reason: 'second' }],
    })

    expect(bodyOf(message)).toBe([
      'Context handoff: you are continuing as the same Team Member in a fresh private context.',
      'Previous session: session:one',
      'New session: session:two',
      'Trigger: model',
      'Continued from checkpoint: context-checkpoint-abc',
      'Related files: a/b.ts, c.ts',
      '',
      'Your handoff from the previous context follows. Verify external state before relying on it; a context change never rolls back files, processes, Team facts, or remote side effects.',
      '',
      'Handoff prose.',
    ].join('\n'))
    expect(sectionsOf(message)).toEqual([
      { name: 'HANDOFF', text: 'Handoff prose.' },
      { name: 'Previous session', text: 'session:one' },
      { name: 'New session', text: 'session:two' },
      { name: 'Trigger', text: 'model' },
      { name: 'Handoff event seq', text: '7' },
      { name: 'Continued from checkpoint', text: 'context-checkpoint-abc' },
      { name: 'Related files', text: '["a/b.ts","c.ts"]' },
    ])
    // The write shape is the producer kind itself: V4 refuses the retired
    // `{ kind: 'plugin', plugin: … }` wrapper, so a codec that regressed to it
    // would fail admission before anything read the sections above.
    const source = message.source as { readonly kind?: string }
    expect(source.kind).toBe(AGENT_TEAM_PLUGIN_ID)
    expect(source).not.toHaveProperty('plugin')
  })

  it('writes the frozen checkpoint continuation', () => {
    const message = TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage('context-checkpoint-abc')

    expect(bodyOf(message)).toBe('A context checkpoint was recorded at the end of the previous turn. Continue the work you were doing.')
    expect(sectionsOf(message)).toEqual([{ name: 'Checkpoint', text: 'context-checkpoint-abc' }])
  })

  it('reads back what it wrote, and only its own attribution', () => {
    const handoff = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: 'prose',
      previousSessionId: 'session:one',
      newSessionId: 'session:two',
      trigger: 'pressure',
      handoffEventSeq: 3,
    })

    expect(TEAM_CONTEXT_CODEC.isHandoffMessage(handoff)).toBe(true)
    expect(TEAM_CONTEXT_CODEC.handoffOf(handoff)?.handoffEventSeq).toBe(3)
    expect(TEAM_CONTEXT_CODEC.isContextSource(handoff)).toBe(true)
  })
})

describe('the Team context-continuity host', () => {
  const member = { memberId: MEMBER_ID, sessionId: SESSION_ID } as AgentTeamAgentMember
  const agent = { id: 'agent:one' } as Agent

  it('derives the durable rollover identity unchanged', () => {
    const host = new TeamContextContinuityHost({
      agentForMember: () => undefined,
      memberForAgent: () => undefined,
      projectionForMember: () => undefined,
      executeTransition: () => Promise.resolve(),
      log: () => {},
    })

    const identity = host.rolloverIdentity(SessionId('session:one'), 'call-1')

    // The naming scheme is durable: in-flight rollover recovery converges on
    // it, and the ledger records the request id.
    const digest = '57207ab4cee751e63f481d7e232f2ba9a73efdacd4a0021173b874998bd38dc4'
    expect(identity.newSessionId).toBe(`agent-team-rollover-${digest}`)
    expect(identity.requestId).toBe(`agent-team:rollover:${digest}`)
  })

  it('resolves subjects and Agents in both directions', () => {
    const host = new TeamContextContinuityHost({
      agentForMember: id => (id === MEMBER_ID ? agent : undefined),
      memberForAgent: candidate => (candidate === agent ? member : undefined),
      projectionForMember: () => undefined,
      executeTransition: () => Promise.resolve(),
      log: () => {},
    })

    expect(host.agentForSubject(MEMBER_ID)).toBe(agent)
    expect(host.subjectForAgent(agent)).toEqual({ id: MEMBER_ID, sessionId: SESSION_ID })
    expect(host.subjectForAgent({ id: 'agent:other' } as Agent)).toBeUndefined()
  })

  it('treats Team notices as rederived and foreign messages as real input', () => {
    const host = new TeamContextContinuityHost({
      agentForMember: () => undefined,
      memberForAgent: () => undefined,
      projectionForMember: () => undefined,
      executeTransition: () => Promise.resolve(),
      log: () => {},
    })
    const teamNotice = createUserMessage({
      content: [{ type: 'text', text: 'inbox notice' }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'notice' },
    })
    // A foreign producer's notice: same form and payload, another kind. V4 has
    // no producer registry, so attribution can only ever be exact identity.
    const foreign = createUserMessage({
      content: [{ type: 'text', text: 'operator input' }],
      source: { kind: 'tool-jobs', form: 'notice', summary: 'notice' },
    })
    const handoff = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: 'prose',
      previousSessionId: 'session:one',
      newSessionId: 'session:two',
      trigger: 'model',
      handoffEventSeq: 1,
    })

    expect(host.isEphemeralNotice(teamNotice)).toBe(true)
    expect(host.isEphemeralNotice(foreign)).toBe(false)
    // The engine excludes its own envelopes before the host's judgement runs,
    // so a handoff is carried, never dropped as a stale notice.
    expect(isDroppedNotice(TEAM_CONTEXT_CODEC, host, handoff)).toBe(false)
    expect(isDroppedNotice(TEAM_CONTEXT_CODEC, host, teamNotice)).toBe(true)
    expect(isDroppedNotice(TEAM_CONTEXT_CODEC, host, foreign)).toBe(false)
  })

  it('parks a recovered intent whose turn never ended, then finishes it on the live turn end', async () => {
    // The two branches `recoverPendingTransition` can take on a spent rollover
    // intent. Team's Member-lifecycle suite reaches the "turn already ended"
    // one end to end through a real restart; the "turn still open" one — a
    // restart landing before the containing turn ends durably — has no other
    // guard, and swapping a generation under an open turn is exactly the
    // mistake it exists to prevent.
    const executeTransition = vi.fn((_memberId: AgentTeamMemberId, _plan: TransitionPlan) => Promise.resolve())
    const live = { id: 'agent:one', whenIdle: () => Promise.resolve() } as unknown as Agent
    const management = createTeamContextManagement({
      agentForMember: id => (id === MEMBER_ID ? live : undefined),
      memberForAgent: candidate => (candidate === live ? member : undefined),
      projectionForMember: () => ({
        pending: { toolCallId: 'call-1', resultSeq: 4, turn: 2, handoff: 'Handoff prose.', relatedFiles: [], turnEndSeq: -1 },
        checkpoints: [],
      }) as unknown as ContextProjectionState,
      executeTransition,
      log: () => {},
    })

    management.recoverPendingTransition(MEMBER_ID, live, SESSION_ID)

    // Nothing ended the containing turn durably, so recovery is registration
    // alone: the intent waits for the live turn end, and no swap may run yet.
    expect(management.isTransitioning(MEMBER_ID)).toBe(true)
    expect(executeTransition).not.toHaveBeenCalled()

    management.onSessionEvent(MEMBER_ID, live, { type: 'turn/end' } as SessionEvent)
    await new Promise(resolve => setImmediate(resolve))

    // The parked intent then completes through the ordinary idle-boundary
    // path, carrying the ORIGINAL intent's handoff rather than a re-derived one.
    expect(executeTransition).toHaveBeenCalledTimes(1)
    expect(executeTransition.mock.calls[0]?.[0]).toBe(MEMBER_ID)
    expect(executeTransition.mock.calls[0]?.[1]).toMatchObject({ handoff: 'Handoff prose.', trigger: 'model' })
    expect(management.isTransitioning(MEMBER_ID)).toBe(false)
  })
})

describe('the projection read', () => {
  it('hands the engine the registered unit\'s own state, with no translation layer', () => {
    // The engine's fold is the only fold: the host returns the very state the
    // registered projection unit produced, never a mapped copy. A translation
    // would be a second authority for the same facts.
    const state: ContextProjectionState = {
      sessionId: 'session:one',
      inheritedEventCount: 3,
      checkpoints: [{ checkpointRef: 'context-checkpoint-' + 'a'.repeat(64), name: 'anchor', resultSeq: 4, turn: 1, turnEndSeq: 6 }],
      pending: null,
      continuations: [],
      carriedCandidates: [],
      lastTurn: 3,
      openCalls: [],
      boundaries: [{ kind: 'team-boundary', label: 'Thread facts', resultSeq: 2, turn: 0, turnEndSeq: 5, attributions: ['thread:abc'] }],
      seenTopics: ['thread:abc'],
      lastTurnEndSeq: 6,
    }
    const host = new TeamContextContinuityHost({
      agentForMember: () => undefined,
      memberForAgent: () => undefined,
      projectionForMember: (memberId, sessionId) => (memberId === MEMBER_ID && sessionId === SESSION_ID ? state : undefined),
      executeTransition: () => Promise.resolve(),
      log: () => {},
    })

    expect(host.projectionForSubject(MEMBER_ID, SESSION_ID)).toBe(state)
    expect(host.projectionForSubject(MEMBER_ID, SessionId('session:two'))).toBeUndefined()
  })
})

/** One Team notice: attributed to the plugin, so the gate must not judge it. */
function teamNotice(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Anything' } })
}

/** One human input, as it arrives from outside Team. */
function humanInput(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * One fake Member Agent exposing exactly what the pressure host reads: its own
 * Session (id, inherited count, surface generation, derived messages, own
 * event span), the token meter, and `steer`.
 */
function pressureAgent(options?: {
  readonly sessionId?: string
  readonly inheritedEventCount?: number
  readonly generation?: number
  readonly tokens?: number
  readonly messages?: readonly Message[]
  readonly ownEvents?: readonly SessionEvent[]
}): { readonly agent: Agent; readonly steered: UserMessage[] } {
  const steered: UserMessage[] = []
  const agent = {
    ctx: { get: (name: string) => (name === 'tokenMeter' ? { measure: () => ({ totalTokens: options?.tokens ?? 1_000 }) } : undefined) },
    session: {
      id: options?.sessionId ?? 'session:one',
      inheritedEventCount: options?.inheritedEventCount ?? 0,
      surface: { replaceGeneration: options?.generation ?? 0 },
      ownEvents: () => options?.ownEvents ?? [],
      deriveMessages: () => options?.messages ?? [],
    },
    steer: (message: UserMessage) => { steered.push(message) },
  } as unknown as Agent
  return { agent, steered }
}

/** A host over one fake Member, with the labels the Host would supply. */
function pressureHost(agent: Agent | undefined, options?: {
  readonly compaction?: boolean
  readonly judge?: PressureJudgement | undefined
  readonly limits?: { readonly usageTokens: number; readonly hardLimit: number; readonly handoffAt: number } | undefined
}): { readonly host: TeamPressurePolicyHost; readonly failures: string[]; readonly logs: string[] } {
  const failures: string[] = []
  const logs: string[] = []
  const host = new TeamPressurePolicyHost({
    agentForMember: id => (id === MEMBER_ID ? agent : undefined),
    limitsForAgent: () => options?.limits,
    compactionForAgent: () => (options?.compaction === true ? { reduce: () => Promise.resolve(null) } : undefined),
    activeClaimLabels: () => ['claim:a (unify forms)'],
    runningJobLabels: () => ['build'],
    judgeForAgent: () => options?.judge,
    failed: (_memberId, diagnostic) => { failures.push(diagnostic) },
    log: (message, memberId) => { logs.push(`${message} (member ${memberId})`) },
  })
  return { host, failures, logs }
}

describe('the Team pressure host', () => {
  it('reads the admitted input and the generation\'s earlier input, with no Team notice on either side', () => {
    const admitted = [teamNotice('Team: you were mentioned'), humanInput('what about the other one?')]
    const { agent } = pressureAgent({
      messages: [humanInput('unify the four dialogs'), teamNotice('Team: claim accepted'), humanInput('now the tests'), ...admitted],
    })
    const { host } = pressureHost(agent)

    host.beginStep(MEMBER_ID, admitted)
    const view = host.relatednessFor(MEMBER_ID)

    // The judged input is the human's, never the rederived Team notice beside
    // it; the earlier input is the generation's, and the messages this very
    // step is admitting are not part of their own evidence.
    expect(view).toEqual({ input: 'what about the other one?', recent: ['unify the four dialogs', 'now the tests'] })
  })

  it('offers no relatedness view outside a step, and never another Member\'s', () => {
    const { agent } = pressureAgent({ messages: [humanInput('earlier')] })
    const { host } = pressureHost(agent)

    expect(host.relatednessFor(MEMBER_ID)).toBeUndefined()
    host.beginStep(MEMBER_ID, [humanInput('held')])
    expect(host.relatednessFor('member:two' as AgentTeamMemberId)).toBeUndefined()
    host.endStep(MEMBER_ID)
    expect(host.relatednessFor(MEMBER_ID)).toBeUndefined()
  })

  it('offers no view for a step that admits only Team notices', () => {
    const { agent } = pressureAgent()
    const { host } = pressureHost(agent)

    host.beginStep(MEMBER_ID, [teamNotice('Team: a Thread moved')])

    // Nothing a human asked for is arriving, so there is nothing to judge: the
    // gate stays off rather than asking about Team's own bookkeeping.
    expect(host.relatednessFor(MEMBER_ID)).toBeUndefined()
  })

  it('resolves limits, surface, log span and in-hand work from the Member\'s own Agent', () => {
    const own = [{ type: 'turn/end', seq: 3, time: 1 } as unknown as SessionEvent]
    const { agent } = pressureAgent({ sessionId: 'session:seven', inheritedEventCount: 2, generation: 5, tokens: 210_000, ownEvents: own })
    const limits = { usageTokens: 210_000, hardLimit: 256_000, handoffAt: 200_000 }
    const { host } = pressureHost(agent, { limits })

    expect(host.limitsFor(MEMBER_ID)).toEqual(limits)
    expect(host.surfaceFor(MEMBER_ID)).toEqual({ generation: 5, tokens: 210_000 })
    expect(host.logSpanFor(MEMBER_ID)).toEqual({ sessionId: 'session:seven', inheritedEventCount: 2, events: own })
    expect(host.inHandFor(MEMBER_ID)).toEqual({ inHand: ['claim:a (unify forms)'], jobs: ['build'] })
    expect(host.limitsFor('member:two' as AgentTeamMemberId)).toBeUndefined()
  })

  it('refuses to report a steered notice that had no live Agent to reach', () => {
    const { host } = pressureHost(undefined)

    // The engine holds a step on the strength of this call: reporting success
    // without delivering would stall the Member behind a message that does not
    // exist, which is the one outcome the gate's own guard names.
    expect(() => host.steer(MEMBER_ID, teamNotice('instruction'))).toThrow(/no live Agent/)
  })
})

describe('the Team pressure policy over the engine', () => {
  it('carries Team\'s own labels into the engine\'s notice', async () => {
    const { agent, steered } = pressureAgent({ ownEvents: [] })
    const policy = new TeamPressurePolicy({
      agentForMember: () => agent,
      limitsForAgent: () => ({ usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }),
      compactionForAgent: () => undefined,
      activeClaimLabels: () => ['claim:a (unify forms)'],
      runningJobLabels: () => ['build'],
      failed: () => {},
      log: () => {},
    })

    const decision = await policy.onPreStep(MEMBER_ID, [humanInput('carry on')], new AbortController().signal)

    expect(decision.kind).toBe('notice')
    const text = (steered[0]?.content[0] as { readonly text: string }).text
    expect(text).toContain('Active Claims: claim:a (unify forms)')
    expect(text).toContain('Owner jobs: 1 running')
    expect(text).toContain('context_rollover')
    // Without a compaction capability the notice must not name the in-place
    // tool: a model told to call one it does not have would waste the turn.
    expect(text).not.toContain('context_compact')
  })

  it('holds a long-gap step whose input the judge reads as unrelated, and admits the related one', async () => {
    const idle = [{ type: 'turn/end', seq: 3, time: Date.now() - 33 * 60_000 } as unknown as SessionEvent]
    const judge = (noul: number): PressureJudgement => ({
      decide: async () => ({ answers: { related: { type: 'noul', noul } } }) as never,
    })
    const build = (noul: number) => {
      const { agent, steered } = pressureAgent({ ownEvents: idle })
      const policy = new TeamPressurePolicy({
        agentForMember: () => agent,
        limitsForAgent: () => ({ usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }),
        compactionForAgent: () => undefined,
        activeClaimLabels: () => [],
        runningJobLabels: () => [],
        judgeForAgent: () => judge(noul),
        failed: () => {},
        log: () => {},
      })
      return { policy, steered }
    }

    const unrelated = build(0.1)
    const held = await unrelated.policy.onPreStep(MEMBER_ID, [humanInput('the other one?')], new AbortController().signal)
    expect(held.kind).toBe('hold')
    // The instruction quotes the held request, because the held request is the
    // one thing the model writing the handoff cannot otherwise see.
    expect((unrelated.steered[0]?.content[0] as { readonly text: string }).text).toContain('the other one?')

    const related = build(0.9)
    const admitted = await related.policy.onPreStep(MEMBER_ID, [humanInput('keep going')], new AbortController().signal)
    expect(admitted.kind).toBe('notice')
  })

  it('switches the gate off when the deployment installed no judge', async () => {
    const idle = [{ type: 'turn/end', seq: 3, time: Date.now() - 33 * 60_000 } as unknown as SessionEvent]
    const { agent } = pressureAgent({ ownEvents: idle })
    const policy = new TeamPressurePolicy({
      agentForMember: () => agent,
      limitsForAgent: () => ({ usageTokens: 200_000, hardLimit: 256_000, handoffAt: 200_000 }),
      compactionForAgent: () => undefined,
      activeClaimLabels: () => [],
      runningJobLabels: () => [],
      failed: () => {},
      log: () => {},
    })

    const decision = await policy.onPreStep(MEMBER_ID, [humanInput('the other one?')], new AbortController().signal)

    // A missing judge is a deployment choice, not a failure: the step is
    // admitted and only the ordinary handoff notice is steered.
    expect(decision.kind).toBe('notice')
  })
})
