import { beforeEach, describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  checkpointRefFor,
  carriedInputOf,
  createTeamContextProjectionDefinition,
  foldTeamContextProjection,
  type TeamContextProjectionState,
} from '../src/context-projection.ts'
import { AGENT_TEAM_PLUGIN_ID, continuationCheckpointRefOf } from '../src/context-source.ts'
import { createCheckpointContinuationMessage } from '../src/context-codec.ts'

/** Fixed Session identity for every fold in this spec; checkpoint refs key on it. */
const SID = 'agent-team-test-session'

/** Recorded tool names of the retired context tools: literals, because the logs carry them. */
const CONTEXT_ROLLOVER_TOOL_NAME = 'context_rollover'
const CONTEXT_CHECKPOINT_TOOL_NAME = 'context_checkpoint'
const NEW_CONTEXT_TOOL_NAME = 'new_context'

/** Fold one log through the unit Team registers, with no Host attached. */
function fold(events: readonly SessionEvent[], inheritedEventCount?: SessionLogOffset, sessionId: string = SID): TeamContextProjectionState {
  return foldTeamContextProjection(
    events,
    { sessionId, ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }) },
  )
}

let eventSeq = 0
function nextSeq(): SessionSeq {
  eventSeq += 1
  return SessionSeq(eventSeq)
}

function turnStart(turn: number): SessionEvent {
  return { type: 'turn/start', seq: nextSeq(), time: 0, data: { turn } } as SessionEvent
}

function turnEnd(turn: number, reason: 'completed' | 'aborted' = 'completed'): SessionEvent {
  return { type: 'turn/end', seq: nextSeq(), time: 0, data: { turn, reason: { kind: reason } } } as SessionEvent
}

function contextToolCall(turn: number, callId: string, name: string, args: object): SessionEvent {
  return { type: 'tool/call', seq: nextSeq(), time: 0,
    data: { turn, step: 1, callId: callId as never, name, arguments: JSON.stringify(args) } } as SessionEvent
}

function toolResult(turn: number, callId: string, options: { isError?: boolean; internalError?: boolean } = {}): SessionEvent {
  const message = createToolResultMessage({
    callId: callId as never,
    content: [{ type: 'text', text: options.isError === true ? 'Error: rejected' : 'ok' }],
    isError: options.isError === true,
  })
  return { type: 'tool/result', seq: nextSeq(), time: 0,
    data: { turn, step: 1, message, ...(options.internalError === true ? { error: { name: 'ToolError', code: 'BOOM' } } : {}) } } as SessionEvent
}

function userMessageEvent(message: UserMessage): SessionEvent {
  return { type: 'user/message', seq: nextSeq(), time: 0, data: message } as SessionEvent
}

/**
 * Call/result pair under the LEGACY `new_context` name: the pre-rename events
 * crash recovery still folds.
 */
function legacyNewContextPair(turn: number, callId: string, args: { handoff: string; checkpointRef?: string; relatedFiles?: Array<{ path: string; reason: string }> }): SessionEvent[] {
  return [
    contextToolCall(turn, callId, NEW_CONTEXT_TOOL_NAME, args),
    toolResult(turn, callId),
  ]
}

function checkpointPair(turn: number, callId: string, name: string): SessionEvent[] {
  return [
    contextToolCall(turn, callId, CONTEXT_CHECKPOINT_TOOL_NAME, { name }),
    toolResult(turn, callId),
  ]
}

beforeEach(() => { eventSeq = 0 })

describe('AgentTeam context projection — legacy rollover intent decode', () => {
  it('a legacy context_rollover call/result pair still creates pending intent', () => {
    const events = [
      turnStart(1),
      ...legacyNewContextPair(1, 'call-1', { handoff: 'continue from here' }),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.pending).toMatchObject({ handoff: 'continue from here', turn: 1, turnEndSeq: events.at(-1)!.seq })
    expect(state.pending?.resultSeq).toBe(events[2]!.seq)
    expect(state.pending?.relatedFiles).toEqual([])
  })

  it('the renamed decoder name folds identically to its predecessor', () => {
    // No current build produces either name; both must fold, because a log
    // written under the renamed tool still has to resolve after an upgrade.
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-rollover', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'new name, same swap' }),
      toolResult(1, 'call-rollover'),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.pending).toMatchObject({ handoff: 'new name, same swap', turn: 1 })
  })

  it('the legacy new_context name still folds into pending intent — crash recovery of old logs', () => {
    // Sessions recorded before the rename carry durable `new_context`
    // call/result pairs. The projection must keep recognizing them: this is
    // the legacy decoder for pending rollovers and checkpoint returns, not a
    // tool alias — no new tool call can carry the old name, but recovery of
    // an existing Member generation depends on the old events still folding.
    const legacy = [
      turnStart(1),
      contextToolCall(1, 'call-legacy', NEW_CONTEXT_TOOL_NAME, { handoff: 'legacy intent', checkpointRef: 'context-checkpoint-' + 'e'.repeat(64) }),
      toolResult(1, 'call-legacy'),
      turnEnd(1),
    ]
    const legacyState = fold(legacy)
    expect(legacyState.pending).toMatchObject({ handoff: 'legacy intent' })
    expect(legacyState.pending?.checkpointRef).toBe('context-checkpoint-' + 'e'.repeat(64))
    // Mixed-era same-Session log: one Session's durable events carry the
    // legacy call from before the rename and a later-turn modern call — the
    // fold never stitches lineage across Sessions, and the later turn's
    // intent takes the slot after the ended legacy one.
    const modern = [
      turnStart(2),
      contextToolCall(2, 'call-modern', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'modern intent' }),
      toolResult(2, 'call-modern'),
      turnEnd(2),
    ]
    const mixedState = fold([...legacy, ...modern], undefined, SID)
    expect(mixedState.pending).toMatchObject({ toolCallId: 'call-modern', handoff: 'modern intent', turn: 2 })
  })

  it('failed, dangling, or malformed results never create intent', () => {
    // Model-visible error result.
    const failed = fold([
      turnStart(1),
      contextToolCall(1, 'call-err', NEW_CONTEXT_TOOL_NAME, { handoff: 'x' }),
      toolResult(1, 'call-err', { isError: true }),
      turnEnd(1),
    ])
    expect(failed.pending).toBeNull()
    // The landed error result consumed its paired open call: nothing stays
    // dangling, so a provider retry reusing the callId cannot pair a fresh
    // success result with these stale arguments.
    expect(failed.openCalls).toEqual([])
    // Internal failure identity on the result event.
    const internal = fold([
      turnStart(1),
      contextToolCall(1, 'call-int', NEW_CONTEXT_TOOL_NAME, { handoff: 'x' }),
      toolResult(1, 'call-int', { internalError: true }),
      turnEnd(1),
    ])
    expect(internal.pending).toBeNull()
    // Dangling call: result never landed before the cut.
    const dangling = fold([
      turnStart(1),
      contextToolCall(1, 'call-open', NEW_CONTEXT_TOOL_NAME, { handoff: 'x' }),
      turnEnd(1),
    ])
    expect(dangling.pending).toBeNull()
    // Malformed arguments: empty handoff after trim.
    const malformed = fold([
      turnStart(1),
      contextToolCall(1, 'call-bad', NEW_CONTEXT_TOOL_NAME, { handoff: '   ' }),
      toolResult(1, 'call-bad'),
      turnEnd(1),
    ])
    expect(malformed.pending).toBeNull()
  })

  it('a second successful call before the turn ends does not replace the first intent', () => {
    const events = [
      turnStart(1),
      ...legacyNewContextPair(1, 'call-1', { handoff: 'first' }),
      ...legacyNewContextPair(1, 'call-2', { handoff: 'second' }),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.pending?.handoff).toBe('first')
  })

  it('a successful later-turn rollover replaces a spent pending intent', () => {
    // A pending whose turn ended is the ready/recoverable intent — the
    // coordinator's process lock rejects a later call on the normal path.
    // But once that lock is gone (the transition failed or never ran) the
    // ended intent is spent: locking it forever poisons the Member — the
    // tool keeps answering `scheduled` while the coordinator never sees a
    // new intent. A later-turn successful rollover must replace it so an
    // explicit retry can recover the Member.
    const events = [
      turnStart(1),
      ...legacyNewContextPair(1, 'call-invalid-checkpoint', { handoff: 'attempted checkpoint return', checkpointRef: 'context-checkpoint-' + 'f'.repeat(64) }),
      turnEnd(1),
      turnStart(2),
      ...legacyNewContextPair(2, 'call-fresh-retry', { handoff: 'explicit fresh retry' }),
      turnEnd(2),
    ]
    const state = fold(events)
    expect(state.pending).toMatchObject({ toolCallId: 'call-fresh-retry', handoff: 'explicit fresh retry', turn: 2 })
    expect(state.pending?.checkpointRef).toBeUndefined()
  })

  it('a spent pending from the legacy new_context name is replaceable by a modern-name retry', () => {
    // Mixed lineage across the rename: an old-generation ended pending
    // (legacy name, failed swap — process lock gone) must not block a later
    // rollover pair from taking over the intent slot.
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-legacy-spent', NEW_CONTEXT_TOOL_NAME, { handoff: 'legacy failed swap' }),
      toolResult(1, 'call-legacy-spent'),
      turnEnd(1),
      turnStart(2),
      contextToolCall(2, 'call-modern-retry', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'modern retry' }),
      toolResult(2, 'call-modern-retry'),
      turnEnd(2),
    ]
    const state = fold(events)
    expect(state.pending).toMatchObject({ toolCallId: 'call-modern-retry', handoff: 'modern retry', turn: 2 })
  })

  it('a provider retry reusing a callId after its error result folds the fresh arguments, not the stale ones', () => {
    // The error result consumed its paired open call at landing; when the
    // provider reuses the SAME callId for a later fresh retry in another
    // turn, the successful result pairs with the retry's own arguments.
    // Without the consumption, the stale invalid-checkpoint arguments would
    // poison the fresh retry's intent. Both calls carry the current
    // model-facing name: this is the live error-then-retry path, not the
    // legacy decoder.
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-reused', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'invalid checkpoint attempt', checkpointRef: 'context-checkpoint-' + 'a'.repeat(64) }),
      toolResult(1, 'call-reused', { isError: true }),
      turnEnd(1),
      turnStart(2),
      contextToolCall(2, 'call-reused', CONTEXT_ROLLOVER_TOOL_NAME, { handoff: 'fresh retry' }),
      toolResult(2, 'call-reused'),
      turnEnd(2),
    ]
    const state = fold(events)
    expect(state.pending).toMatchObject({ toolCallId: 'call-reused', handoff: 'fresh retry', turn: 2 })
    expect(state.pending?.checkpointRef).toBeUndefined()
    expect(state.openCalls).toEqual([])
  })

  it('inherited fork-prefix calls never produce intent in a seeded child', () => {
    const parentEvents = [
      turnStart(1),
      ...legacyNewContextPair(1, 'call-parent', { handoff: 'old generation' }),
      turnEnd(1),
    ]
    const childEvents: SessionEvent[] = [...parentEvents, turnStart(2), turnEnd(2)]
    // The child inherited the whole parent prefix: the same events fold to no
    // pending intent once every one of them is inside the inherited cut.
    const state = fold(childEvents, SessionLogOffset(parentEvents.length))
    expect(state.pending).toBeNull()
    expect(state.checkpoints).toEqual([])
  })

  it('the live unit folds event-by-event to the same state as the cold fold', () => {
    const events = [
      turnStart(1),
      ...legacyNewContextPair(1, 'call-1', { handoff: 'live', relatedFiles: [{ path: 'src/index.ts', reason: 'in progress' }] }),
      turnEnd(1),
    ]
    const definition = createTeamContextProjectionDefinition()
    // `init` seeds the Session identity and the inherited cut from the
    // header — the definition itself closes over neither.
    let live = definition.init({ id: SID } as never, 0 as never)
    for (const event of events) live = definition.apply(live, event)
    expect(live).toEqual(fold(events))
  })
})

describe('AgentTeam context projection — checkpoints', () => {
  it('a successful checkpoint pair resolves at its containing turn end', () => {
    const events = [
      turnStart(1),
      ...checkpointPair(1, 'call-cp', 'before-rewrite'),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.checkpoints).toHaveLength(1)
    expect(state.checkpoints[0]).toMatchObject({
      checkpointRef: checkpointRefFor(SID, 'call-cp'),
      name: 'before-rewrite',
      turn: 1,
      turnEndSeq: events.at(-1)!.seq,
      resultSeq: events[2]!.seq,
    })
  })

  it('duplicate names stay unambiguous through opaque refs', () => {
    const events = [
      turnStart(1),
      ...checkpointPair(1, 'call-a', 'same-name'),
      turnEnd(1),
      turnStart(2),
      ...checkpointPair(2, 'call-b', 'same-name'),
      turnEnd(2),
    ]
    const state = fold(events)
    expect(state.checkpoints.map(entry => entry.name)).toEqual(['same-name', 'same-name'])
    expect(state.checkpoints[0]!.checkpointRef).not.toBe(state.checkpoints[1]!.checkpointRef)
  })

  it('an unresolved checkpoint stays at turnEndSeq -1 until its turn ends', () => {
    const events = [
      turnStart(1),
      ...checkpointPair(1, 'call-cp', 'open'),
    ]
    const state = fold(events)
    expect(state.checkpoints[0]!.turnEndSeq).toBe(-1)
  })

  it('hostile provider call ids produce bounded delimiter-free refs that still resolve', () => {
    // A 3019-char call id packed with colons, newlines, and unicode — the
    // exact shape a hostile or broken provider can emit.
    const hostile = `${'x:'.repeat(500)}${'x'.repeat(2019)}\n\`\`\`json {"a":1}\u0000`
    const ref = checkpointRefFor(SID, hostile)
    expect(ref).toMatch(/^context-checkpoint-[0-9a-f]{64}$/)
    expect(ref.length).toBe('context-checkpoint-'.length + 64)
    const events = [
      turnStart(1),
      ...checkpointPair(1, hostile, 'hostile-anchor'),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.checkpoints[0]!.checkpointRef).toBe(ref)
    // The same pair reproduces the ref; a different call id never collides.
    expect(checkpointRefFor(SID, hostile)).toBe(ref)
    expect(checkpointRefFor(SID, `${hostile}!`)).not.toBe(ref)
  })

  it('the same call id in two different Sessions derives two distinct refs', () => {
    const callId = 'call-repeat'
    const first = checkpointRefFor('agent-team-generation-one', callId)
    const second = checkpointRefFor('agent-team-generation-two', callId)
    expect(first).not.toBe(second)
    // Consecutive generations using one repeated provider call id keep both
    // checkpoints distinct and each resolves in its own Session's fold.
    const firstEvents = [turnStart(1), ...checkpointPair(1, callId, 'gen-one'), turnEnd(1)]
    const secondEvents = [turnStart(1), ...checkpointPair(1, callId, 'gen-two'), turnEnd(1)]
    const firstState = fold(firstEvents, undefined, 'agent-team-generation-one')
    const secondState = fold(secondEvents, undefined, 'agent-team-generation-two')
    expect(firstState.checkpoints[0]!.checkpointRef).toBe(first)
    expect(secondState.checkpoints[0]!.checkpointRef).toBe(second)
  })
})

describe('AgentTeam committed wake-swap input recovery', () => {
  it('replays only unanswered post-boundary input without a legacy rollover intent', () => {
    const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const before = message('before boundary')
    const answered = message('already answered')
    const pending = message('arrived while committing')
    const relay = createUserMessage({ content: [{ type: 'text', text: 'direct relay' }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'relay' } })
    const instructions = createUserMessage({ content: [{ type: 'text', text: 'regenerated context' }],
      source: { kind: 'agent-instructions', form: 'instructions', changes: [] } as never })
    const notice = createUserMessage({ content: [{ type: 'text', text: 'unread' }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Team Inbox has unread work.' } })
    const inserted = (messages: UserMessage[]): SessionEvent => ({ type: 'agent/inbox/spliced', seq: nextSeq(), time: 0,
      data: { target: 'next-turn', start: 0, inserted: messages } }) as SessionEvent
    const events: SessionEvent[] = [inserted([before])]
    const boundary = eventSeq + 1
    events.push(inserted([answered]), turnStart(1), userMessageEvent(answered), {
      type: 'assistant/message', seq: nextSeq(), time: 0, data: { turn: 1, step: 1, message: {} },
    } as SessionEvent, turnEnd(1), inserted([pending, relay, notice, instructions]), {
      type: 'agent/inbox/spliced', seq: nextSeq(), time: 0,
      data: { target: 'next-turn', start: 0, removedCount: 2, inserted: [], outcome: 'canceled' },
    } as SessionEvent)
    const state = foldTeamContextProjection(events, { sessionId: SID, inputFromSeq: boundary })
    expect(state.pending).toBeNull()
    expect(carriedInputOf(state, events)).toEqual([pending, relay])
    expect(carriedInputOf(fold(events), events)).toEqual([])
  })
})

describe('AgentTeam context projection — quiet continuation delivery', () => {
  it('a delivered continuation notice marks delivery for its checkpoint', () => {
    const events: SessionEvent[] = [
      turnStart(1),
      ...checkpointPair(1, 'call-cp', 'anchor'),
      turnEnd(1),
    ]
    const checkpointRef = checkpointRefFor(SID, 'call-cp')
    // Nothing is delivered yet: the durable record is the message in the log,
    // never a scheduled-but-unwritten intent (the live latch is the
    // coordinator's, and it re-arms from this record after a restart).
    expect(fold(events).continuations).toEqual([])
    const delivered = fold([
      ...events,
      userMessageEvent(createCheckpointContinuationMessage(checkpointRef)),
    ])
    expect(delivered.continuations).toEqual([{ checkpointRef, deliveredSeq: events.at(-1)!.seq + 1 }])
  })

  it('a repeated continuation notice keeps the first delivery seq', () => {
    const checkpointRef = checkpointRefFor(SID, 'call-x')
    const continuation = createCheckpointContinuationMessage(checkpointRef)
    const events: SessionEvent[] = [
      turnStart(1),
      ...checkpointPair(1, 'call-x', 'anchor'),
      turnEnd(1),
      turnStart(2),
      userMessageEvent(continuation),
      turnEnd(2),
      turnStart(3),
      userMessageEvent(continuation),
      turnEnd(3),
    ]
    const state = fold(events)
    expect(state.continuations).toHaveLength(1)
    expect(state.continuations[0]!.deliveredSeq).toBe(events[5]!.seq)
  })
})

describe('AgentTeam context sources', () => {
  it('checkpoint continuation notices recognize themselves regardless of body text', () => {
    const checkpointRef = checkpointRefFor(SID, 'call-cp')
    const message = createCheckpointContinuationMessage(checkpointRef)
    expect(message.source).toMatchObject({ kind: AGENT_TEAM_PLUGIN_ID, form: 'snapshot' })
    expect(continuationCheckpointRefOf(message)).toBe(checkpointRef)
  })
})

describe('AgentTeam context projection — the engine unit Team registers', () => {
  it('one registration folds two Sessions and keys every ref to the Session that recorded it', () => {
    // The framework keeps one unit per projection key and drives it for every
    // Session, so the definition closes over no Session identity: identity and
    // the fork-inherited cut travel in the state.
    const events = [turnStart(1), ...checkpointPair(1, 'call-shared', 'anchor'), turnEnd(1)]
    const first = fold(events, undefined, 'agent-team-generation-one')
    const second = fold(events, undefined, 'agent-team-generation-two')
    expect(first.sessionId).toBe('agent-team-generation-one')
    expect(second.sessionId).toBe('agent-team-generation-two')
    expect(first.checkpoints[0]!.checkpointRef).toBe(checkpointRefFor('agent-team-generation-one', 'call-shared'))
    expect(second.checkpoints[0]!.checkpointRef).toBe(checkpointRefFor('agent-team-generation-two', 'call-shared'))
    expect(first.checkpoints[0]!.checkpointRef).not.toBe(second.checkpoints[0]!.checkpointRef)
  })

  it('records the inherited cut it was given, so a seeded child keeps none of the ancestor facts', () => {
    const parent = [turnStart(1), ...checkpointPair(1, 'call-parent', 'anchor'), turnEnd(1)]
    const child = fold([...parent, turnStart(2), turnEnd(2)], SessionLogOffset(parent.length), 'agent-team-child')
    expect(child.inheritedEventCount).toBe(parent.length)
    expect(child.checkpoints).toEqual([])
    expect(child.sessionId).toBe('agent-team-child')
  })
})
