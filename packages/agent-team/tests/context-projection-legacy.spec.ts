/**
 * Frozen-shape fence for Team's own context projection.
 *
 * Durable logs written before this build — under the retired rollover and
 * checkpoint tool names, and under the `team_thread` attention name — are still
 * read back through this fold. The assertions here are golden values, not
 * comparisons against a live writer: the ref digest and the whole folded state
 * are what the recorded history contains, so a refactor that changes any of
 * them would silently make old sessions unreadable. Recompute a golden only
 * when the change is meant to cut history off, and say so where it happens.
 */
import { describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  CONTEXT_CONTINUITY_PROJECTION_KEY,
  isRedeliverableTeamNotice,
  checkpointRefFor,
  contextProjectionStateSchema,
  createTeamContextProjectionDefinition,
  foldTeamContextProjection,
} from '../src/context-projection.ts'
import { createHandoffMessage } from './helpers/legacy-context-envelopes.ts'
import { createCheckpointContinuationMessage } from '../src/context-codec.ts'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'

const SID = 'agent-team-legacy-session'
/** The pre-rename rollover name a log written by that line carries. */
const NEW_CONTEXT_TOOL_NAME = 'new_context'

let eventSeq = 0
const seq = (): SessionSeq => SessionSeq(++eventSeq)

const turnStart = (turn: number): SessionEvent => ({ type: 'turn/start', seq: seq(), time: 0, data: { turn } } as SessionEvent)
const turnEnd = (turn: number): SessionEvent => ({ type: 'turn/end', seq: seq(), time: 0, data: { turn, reason: { kind: 'completed' } } } as SessionEvent)
const toolCall = (turn: number, callId: string, name: string, args: object): SessionEvent => ({
  type: 'tool/call', seq: seq(), time: 0, data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
} as never)
const toolResult = (turn: number, callId: string, meta?: object): SessionEvent => ({
  type: 'tool/result', seq: seq(), time: 0, data: {
    turn,
    step: 1,
    message: createToolResultMessage({ callId: callId as never, content: [{ type: 'text', text: 'ok' }], isError: false }),
    ...(meta === undefined ? {} : { meta }),
  },
} as SessionEvent)
const inboxSpliced = (messages: readonly UserMessage[]): SessionEvent => ({ type: 'agent/inbox/spliced', seq: seq(), time: 0, data: { inserted: messages } } as never)
const assistantMessage = (turn: number): SessionEvent => ({
  type: 'assistant/message', seq: seq(), time: 0, data: {
    turn, step: 1, message: { id: 'assistant', role: 'assistant', content: [], source: { kind: 'model' } }, stream: [],
  },
} as never)
const userMessage = (message: UserMessage): SessionEvent => ({ type: 'user/message', seq: seq(), time: 0, data: message } as SessionEvent)

/** One structured Team notice as the released line wrote it: the V3 `plugin` source, read back renamed. */
function renamedV3Notice(summary: string, body: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: `plugin:${AGENT_TEAM_PLUGIN_ID}`, form: 'notice', summary } })
}

/**
 * A log in the shape the pre-rename line recorded: a `new_context` rollover, a
 * V3-renamed notice, and a call under the retired `team_thread` name that the
 * fold must leave alone.
 */
function legacyLog(): SessionEvent[] {
  return [
    turnStart(1),
    toolCall(1, 'call-legacy-rollover', NEW_CONTEXT_TOOL_NAME, {
      handoff: 'carry the parser rewrite over',
      relatedFiles: [{ path: 'src/parser.ts', reason: 'rewritten' }],
    }),
    toolResult(1, 'call-legacy-rollover'),
    userMessage(renamedV3Notice('Team Inbox has unread work.', 'Task handover\nThread: thread:4d5e6f70-8b9c-4d5e-0f1a-2b3c4d5e6f70')),
    turnEnd(1),
    turnStart(2),
    toolCall(2, 'call-legacy-follow', 'team_thread', { action: 'follow', threadRef: 'thread:4d5e6f70-8b9c-4d5e-0f1a-2b3c4d5e6f70' }),
    toolResult(2, 'call-legacy-follow'),
    turnEnd(2),
  ]
}

describe('legacy durable logs still cold-fold', () => {
  it('a new_context rollover resolves to a pending intent closed by its turn end', () => {
    eventSeq = 0
    const events = legacyLog()
    const state = foldTeamContextProjection(events, { sessionId: SID })

    expect(state.pending).toMatchObject({
      toolCallId: 'call-legacy-rollover',
      handoff: 'carry the parser rewrite over',
      relatedFiles: [{ path: 'src/parser.ts', reason: 'rewritten' }],
      turn: 1,
      resultSeq: events[2]!.seq,
      turnEndSeq: events[4]!.seq,
    })
    expect(state.pending?.checkpointRef).toBeUndefined()
    expect(state.openCalls).toEqual([])
  })

  it('the inherited prefix of a seeded generation folds none of the ancestor facts', () => {
    eventSeq = 0
    const ancestor = legacyLog()
    const child = [...ancestor, turnStart(3), turnEnd(3)]
    const state = foldTeamContextProjection(child, { sessionId: 'agent-team-legacy-child', inheritedEventCount: SessionLogOffset(ancestor.length) })
    expect(state.pending).toBeNull()
    expect(state.checkpoints).toEqual([])
    expect(state.continuations).toEqual([])
  })

  it('a pending whose turn already ended is replaceable; an unresolved one is not', () => {
    eventSeq = 0
    const unresolved = foldTeamContextProjection([
      turnStart(1),
      toolCall(1, 'call-first', NEW_CONTEXT_TOOL_NAME, { handoff: 'first' }),
      toolResult(1, 'call-first'),
      toolCall(1, 'call-second', NEW_CONTEXT_TOOL_NAME, { handoff: 'second' }),
      toolResult(1, 'call-second'),
    ], { sessionId: SID })
    expect(unresolved.pending?.handoff).toBe('first')
  })

  it('a later turn end never resolves an intent whose own turn never ended', () => {
    // The log was cut after the rollover result and before its turn end: the
    // intent is spent, and the coordinator discards it. Resolving it from the
    // next turn's end — or from a fresh generation's turn 1 — would revive a
    // swap the Member was told to drop, on the next restart.
    eventSeq = 0
    const crashed = [
      turnStart(1),
      toolCall(1, 'call-spent', NEW_CONTEXT_TOOL_NAME, { handoff: 'spent' }),
      toolResult(1, 'call-spent'),
    ]
    const first = foldTeamContextProjection(crashed, { sessionId: SID })
    expect(first.pending?.turnEndSeq).toBe(-1)
    const nextTurn = foldTeamContextProjection([...crashed, turnStart(2), turnEnd(2)], { sessionId: SID })
    expect(nextTurn.pending?.turnEndSeq).toBe(-1)
    // The intent's own turn end still resolves it.
    const close = turnEnd(1)
    const ownTurn = foldTeamContextProjection([...crashed, close], { sessionId: SID })
    expect(ownTurn.pending?.turnEndSeq).toBe(close.seq)
  })
})

describe('durable refs keep the shapes recorded history carries', () => {
  it('a checkpoint ref is the same digest it has always been', () => {
    // sha256 over JSON.stringify([sessionId, callId]). This literal is recorded
    // in Team's durable logs: a changed derivation orphans every
    // checkpointRef a Member's ledger holds.
    expect(checkpointRefFor('agent-team-parity-session', 'call-cp')).toBe('context-checkpoint-b342d938eb29e9c056e2bb2cf384f3cb8b31b01f221a6ea28acfeb4abdc6764f')
    expect(checkpointRefFor(SID, 'call-legacy-rollover')).toMatch(/^context-checkpoint-[0-9a-f]{64}$/)
  })
})

describe('the envelopes earlier builds wrote still decode', () => {
  it('a handoff envelope decodes section by section', () => {
    const message = createHandoffMessage({
      handoff: 'objective: finish the parser',
      previousSessionId: 'agent-team-previous',
      newSessionId: 'agent-team-next',
      trigger: 'pressure',
      handoffEventSeq: 42,
      checkpointRef: 'context-checkpoint-abc',
      relatedFiles: [{ path: 'src/a.ts', reason: 'r' }, { path: 'src/b,c.ts' }],
    })
    expect(message.source).toEqual({
      kind: AGENT_TEAM_PLUGIN_ID,
      form: 'snapshot',
      sections: [
        { name: 'HANDOFF', text: 'objective: finish the parser' },
        { name: 'Previous session', text: 'agent-team-previous' },
        { name: 'New session', text: 'agent-team-next' },
        { name: 'Trigger', text: 'pressure' },
        { name: 'Handoff event seq', text: '42' },
        { name: 'Continued from checkpoint', text: 'context-checkpoint-abc' },
        { name: 'Related files', text: '["src/a.ts","src/b,c.ts"]' },
      ],
    })
  })

  it('a checkpoint continuation keeps its fixed text and one-section envelope', () => {
    const message = createCheckpointContinuationMessage('context-checkpoint-abc')
    expect(message.content).toEqual([{
      type: 'text',
      text: 'A context checkpoint was recorded at the end of the previous turn. Continue the work you were doing.',
    }])
    expect(message.source).toEqual({
      kind: AGENT_TEAM_PLUGIN_ID,
      form: 'snapshot',
      sections: [{ name: 'Checkpoint', text: 'context-checkpoint-abc' }],
    })
  })
})

describe('Team notice judgement', () => {
  it('redeliverable notices are Team-authored but never a handoff or continuation', () => {
    expect(isRedeliverableTeamNotice(renamedV3Notice('Team Inbox has unread work.', 'body'))).toBe(true)
    expect(isRedeliverableTeamNotice(createUserMessage({ content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }))).toBe(false)
    expect(isRedeliverableTeamNotice(createCheckpointContinuationMessage('context-checkpoint-abc'))).toBe(false)
    expect(isRedeliverableTeamNotice(createHandoffMessage({
      handoff: 'p', previousSessionId: 'a', newSessionId: 'b', trigger: 'model', handoffEventSeq: 1,
    }))).toBe(false)
  })
})

describe('one registration and one cached-row shape', () => {
  /** A mixed-era generation: legacy rollover, checkpoint, carried input, and a delivered continuation. */
  function mixedEraLog(): SessionEvent[] {
    return [
      turnStart(1),
      toolCall(1, 'call-legacy-rollover', NEW_CONTEXT_TOOL_NAME, { handoff: 'legacy handoff', relatedFiles: [{ path: 'a.ts', reason: 'r' }] }),
      toolResult(1, 'call-legacy-rollover'),
      inboxSpliced([
        { ...createUserMessage({ content: [{ type: 'text', text: 'real input' }], source: { kind: 'user' } }), id: 'msg-carried' as never },
        renamedV3Notice('Team Inbox has unread work.', 'Thread: thread:aaaa1111-2222-4333-8444-555566667777'),
      ]),
      assistantMessage(1),
      turnEnd(1),
      turnStart(2),
      toolCall(2, 'call-checkpoint', 'context_checkpoint', { name: 'anchor' }),
      toolResult(2, 'call-checkpoint'),
      userMessage(createCheckpointContinuationMessage('context-checkpoint-abc')),
      turnEnd(2),
    ]
  }

  const expected = {
    sessionId: 'agent-team-legacy-session',
    inheritedEventCount: 0,
    checkpoints: [{
      checkpointRef: checkpointRefFor('agent-team-legacy-session', 'call-checkpoint'),
      name: 'anchor',
      resultSeq: 9,
      turn: 2,
      turnEndSeq: 11,
    }],
    pending: {
      handoff: 'legacy handoff',
      relatedFiles: [{ path: 'a.ts', reason: 'r' }],
      toolCallId: 'call-legacy-rollover',
      resultSeq: 3,
      turn: 1,
      turnEndSeq: 6,
    },
    continuations: [{ checkpointRef: 'context-checkpoint-abc', deliveredSeq: 10 }],
    carriedCandidates: [{ messageId: 'msg-carried', surfacedTurn: -1, consumed: false }],
    lastTurn: 2,
    openCalls: [],
  }

  it('the whole folded state of a mixed-era log is exactly the recorded one', () => {
    eventSeq = 0
    const state = foldTeamContextProjection(mixedEraLog(), { sessionId: 'agent-team-legacy-session' })
    expect(state).toEqual(expected)
  })

  it('the unit registers under the frozen key, and the cached-row schema accepts the state', () => {
    eventSeq = 0
    const definition = createTeamContextProjectionDefinition()
    expect(definition.key).toBe('contextContinuity')
    expect(definition.stateVersion).toBe(3)
    expect(CONTEXT_CONTINUITY_PROJECTION_KEY).toBe('contextContinuity')
    // The persisted row is the plain-JSON projection of this exact state.
    const state = foldTeamContextProjection(mixedEraLog(), { sessionId: 'agent-team-legacy-session' })
    expect(contextProjectionStateSchema.safeParse(JSON.parse(JSON.stringify(state))).success).toBe(true)
    // Header identity and the inherited cut come from `init`, not a closure.
    expect(definition.init({ id: 'agent-team-seeded' } as never, SessionLogOffset(4))).toMatchObject({
      sessionId: 'agent-team-seeded',
      inheritedEventCount: 4,
      pending: null,
    })
  })

  it('the live unit applying one event at a time equals the cold fold of the recorded log', () => {
    eventSeq = 0
    const events = mixedEraLog()
    const definition = createTeamContextProjectionDefinition()
    let live = definition.init({ id: 'agent-team-legacy-session' } as never, SessionLogOffset(0))
    for (const event of events) live = definition.apply(live, event)
    expect(live).toEqual(expected)
  })
})
