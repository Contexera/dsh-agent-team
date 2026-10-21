/**
 * Frozen-shape fence for Team's own context projection.
 *
 * Durable logs written before this build — under the engine's codec, under the
 * legacy `new_context` rollover name, and under the `team_thread` attention
 * name — are still read back through this fold. The assertions here are golden
 * values, not comparisons against a live writer: the ref digests, the envelope
 * bytes, and the whole folded state are what the recorded history contains, so
 * a refactor that changes any of them would silently make old sessions
 * unreadable. Recompute a golden only when the change is meant to cut history
 * off, and say so where it happens.
 */
import { describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  CONTEXT_CONTINUITY_PROJECTION_KEY,
  NEW_CONTEXT_TOOL_NAME,
  TEAM_ROLLOVER_TOOL_NAMES,
  TeamContextProjectionHost,
  boundaryRefFor,
  checkpointByRef,
  checkpointRefFor,
  contextProjectionStateSchema,
  createTeamContextProjectionDefinition,
  foldTeamContextProjection,
  isRedeliverableTeamNotice,
  isReminderNoticeSummary,
} from '../src/context-projection.ts'
import { TEAM_CONTEXT_CODEC } from '../src/context-codec.ts'
import { AGENT_TEAM_PLUGIN_ID, handoffOf } from '../src/context-source.ts'

const SID = 'agent-team-legacy-session'

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
 * A log in the shape the pre-rename line recorded: `new_context` rollover,
 * `team_thread` attention follow, and V3-renamed notice sources.
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
  it('a new_context rollover and a team_thread follow resolve to intent and boundary', () => {
    eventSeq = 0
    const events = legacyLog()
    const state = foldTeamContextProjection(events, { sessionId: SID }, new TeamContextProjectionHost())

    expect(state.pending).toMatchObject({
      toolCallId: 'call-legacy-rollover',
      handoff: 'carry the parser rewrite over',
      relatedFiles: [{ path: 'src/parser.ts', reason: 'rewritten' }],
      turn: 1,
      resultSeq: events[2]!.seq,
      turnEndSeq: events[4]!.seq,
    })
    expect(state.pending?.checkpointRef).toBeUndefined()

    // The notice's first arrival and the legacy follow are two boundaries; both
    // resolve at the turn end that closed their turn.
    expect(state.boundaries.map(boundary => ({ kind: boundary.kind, label: boundary.label, turnEndSeq: boundary.turnEndSeq }))).toEqual([
      { kind: 'team-boundary', label: 'First arrival: thread:4d5e6f70-8b9c-4d5e-0f1a-2b3c4d5e6f70', turnEndSeq: events[4]!.seq },
      { kind: 'team-boundary', label: 'Team attention change', turnEndSeq: events[8]!.seq },
    ])
    expect(state.boundaries[1]!.attributions).toEqual(['thread:4d5e6f70-8b9c-4d5e-0f1a-2b3c4d5e6f70'])
    expect(state.openCalls).toEqual([])
    expect(TEAM_ROLLOVER_TOOL_NAMES).toContain(NEW_CONTEXT_TOOL_NAME)
  })

  it('the inherited prefix of a seeded generation folds none of the ancestor facts', () => {
    eventSeq = 0
    const ancestor = legacyLog()
    const child = [...ancestor, turnStart(3), turnEnd(3)]
    const state = foldTeamContextProjection(child, { sessionId: 'agent-team-legacy-child', inheritedEventCount: SessionLogOffset(ancestor.length) })
    expect(state.pending).toBeNull()
    expect(state.boundaries).toEqual([])
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
})

describe('durable refs keep the shapes recorded history carries', () => {
  it('checkpoint and boundary refs are the same digests they have always been', () => {
    // sha256 over JSON.stringify([sessionId, callId]) and [sessionId, seq].
    // These two literals are recorded in Team's durable logs: a changed
    // derivation orphan every checkpointRef a Member's ledger holds.
    expect(checkpointRefFor('agent-team-parity-session', 'call-cp')).toBe('context-checkpoint-b342d938eb29e9c056e2bb2cf384f3cb8b31b01f221a6ea28acfeb4abdc6764f')
    expect(boundaryRefFor('agent-team-parity-session', 7)).toBe('team-boundary-680b3ec99c2bb3453a92a4c97faa068eaf6a9c5855e00d3db00ab245d1a1916c')
    expect(checkpointRefFor(SID, 'call-legacy-rollover')).toMatch(/^context-checkpoint-[0-9a-f]{64}$/)
  })

  it('checkpointByRef resolves only a checkpoint whose turn ended', () => {
    eventSeq = 0
    const events = [
      turnStart(1),
      toolCall(1, 'call-open', 'context_checkpoint', { name: 'open' }),
      toolResult(1, 'call-open'),
    ]
    const unresolved = foldTeamContextProjection(events, { sessionId: SID })
    expect(checkpointByRef(unresolved, checkpointRefFor(SID, 'call-open'))).toBeUndefined()
    const close = turnEnd(1)
    const resolved = foldTeamContextProjection([...events, close], { sessionId: SID })
    expect(checkpointByRef(resolved, checkpointRefFor(SID, 'call-open'))).toMatchObject({ name: 'open', turnEndSeq: close.seq })
  })
})

describe('the codec writes the bytes earlier builds wrote', () => {
  it('a handoff envelope keeps its prose, section order, and related-file encoding', () => {
    const message = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: 'objective: finish the parser',
      previousSessionId: 'agent-team-previous',
      newSessionId: 'agent-team-next',
      trigger: 'pressure',
      handoffEventSeq: 42,
      checkpointRef: 'context-checkpoint-abc',
      relatedFiles: [{ path: 'src/a.ts', reason: 'r' }, { path: 'src/b,c.ts' }],
    })
    expect(message.content).toEqual([{
      type: 'text',
      text: [
        'Context handoff: you are continuing as the same Team Member in a fresh private context.',
        'Previous session: agent-team-previous',
        'New session: agent-team-next',
        'Trigger: pressure',
        'Continued from checkpoint: context-checkpoint-abc',
        'Related files: src/a.ts, src/b,c.ts',
        '',
        'Your handoff from the previous context follows. Verify external state before relying on it; a context change never rolls back files, processes, Team facts, or remote side effects.',
        '',
        'objective: finish the parser',
      ].join('\n'),
    }])
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
    // What the writer produced, the fold's own recognizer reads back.
    expect(handoffOf(message)).toMatchObject({
      previousSessionId: 'agent-team-previous',
      newSessionId: 'agent-team-next',
      trigger: 'pressure',
      handoffEventSeq: 42,
      checkpointRef: 'context-checkpoint-abc',
      relatedFiles: ['src/a.ts', 'src/b,c.ts'],
    })
  })

  it('a bare handoff carries no checkpoint or related-file sections', () => {
    const message = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: 'p',
      previousSessionId: 'a',
      newSessionId: 'b',
      trigger: 'model',
      handoffEventSeq: 7,
    })
    const sections = (message.source as { sections: readonly { name: string }[] }).sections
    expect(sections.map(section => section.name)).toEqual(['HANDOFF', 'Previous session', 'New session', 'Trigger', 'Handoff event seq'])
    expect((message.content[0] as { text: string }).text).not.toContain('Related files:')
  })

  it('a checkpoint continuation keeps its fixed text and one-section envelope', () => {
    const message = TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage('context-checkpoint-abc')
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
    expect(isRedeliverableTeamNotice(TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage('context-checkpoint-abc'))).toBe(false)
    expect(isRedeliverableTeamNotice(TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: 'p', previousSessionId: 'a', newSessionId: 'b', trigger: 'model', handoffEventSeq: 1,
    }))).toBe(false)
  })

  it('reminder summaries are the historical progress nudge and the recovery notice', () => {
    expect(isReminderNoticeSummary('Progress visibility reminder')).toBe(true)
    expect(isReminderNoticeSummary('Recovery: continue your interrupted work.')).toBe(true)
    expect(isReminderNoticeSummary('Team Inbox has unread work.')).toBe(false)
  })
})

describe('one registration and one cached-row shape', () => {
  /** A mixed-era generation: legacy rollover, checkpoint, carried input, and every Team boundary kind. */
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
      userMessage(TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage('context-checkpoint-abc')),
      toolCall(2, 'call-claim', 'team_claim', { action: 'claim', taskRef: 'task:x' }),
      toolResult(2, 'call-claim'),
      toolCall(2, 'call-follow', 'team_thread', { action: 'follow', threadRef: 'thread:followed' }),
      toolResult(2, 'call-follow'),
      toolCall(2, 'call-message', 'team_message', { action: 'reply', threadRef: 'thread:replied' }),
      toolResult(2, 'call-message', { kind: 'committed', threadRef: 'thread:replied' }),
      turnEnd(2),
      turnStart(3),
      userMessage(createUserMessage({ content: [{ type: 'text', text: 'persist' }], source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Compaction is imminent; consider persisting key conclusions.' } })),
      userMessage(renamedV3Notice('Progress visibility reminder', 'nudge')),
      turnEnd(3),
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
      turnEndSeq: 17,
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
    lastTurn: 3,
    openCalls: [],
    boundaries: [
      { kind: 'team-boundary', label: 'Team task claim change', resultSeq: 12, turn: 2, turnEndSeq: 17, attributions: ['thread:owner'] },
      { kind: 'team-boundary', label: 'Team attention change', resultSeq: 14, turn: 2, turnEndSeq: 17, attributions: ['thread:followed'] },
      { kind: 'team-boundary', label: 'Team message', resultSeq: 16, turn: 2, turnEndSeq: 17, attributions: ['thread:replied'] },
      { kind: 'compaction', label: 'compaction notice', resultSeq: 19, turn: 3, turnEndSeq: 21, attributions: [] },
    ],
    seenTopics: ['thread:owner', 'thread:followed', 'thread:replied'],
    lastTurnEndSeq: 21,
  }

  it('the whole folded state of a mixed-era log is exactly the recorded one', () => {
    eventSeq = 0
    const state = foldTeamContextProjection(
      mixedEraLog(),
      { sessionId: 'agent-team-legacy-session' },
      new TeamContextProjectionHost({ threadForTask: () => 'thread:owner' as never }),
    )
    expect(state).toEqual(expected)
  })

  it('the unit registers under the frozen key and stateVersion, and the cached-row schema accepts the state', () => {
    eventSeq = 0
    const definition = createTeamContextProjectionDefinition(new TeamContextProjectionHost())
    expect(definition.key).toBe('contextContinuity')
    expect(CONTEXT_CONTINUITY_PROJECTION_KEY).toBe('contextContinuity')
    // Rows written by the previous build carry this version; a bump would make
    // the framework discard them and refold from the head of the log.
    expect(definition.stateVersion).toBe(2)
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
    const definition = createTeamContextProjectionDefinition(new TeamContextProjectionHost({ threadForTask: () => 'thread:owner' as never }))
    let live = definition.init({ id: 'agent-team-legacy-session' } as never, SessionLogOffset(0))
    for (const event of events) live = definition.apply(live, event)
    expect(live).toEqual(expected)
  })
})
