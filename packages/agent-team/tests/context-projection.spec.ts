import { beforeEach, describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'

/** Fixed Session identity for every fold in this spec; checkpoint refs key on it. */
const SID = 'agent-team-test-session'
import { continuationDelivered, readContextTimeline, type ContextProjectionState, type ContextTimelineItem } from '@wowyuarm/dsh-context-continuity'
import {
  CONTEXT_CHECKPOINT_TOOL_NAME,
  CONTEXT_ROLLOVER_TOOL_NAME,
  NEW_CONTEXT_TOOL_NAME,
  boundaryRefFor,
  checkpointRefFor,
  createTeamContextProjectionConfig,
  createTeamContextProjectionDefinition,
  foldTeamContextProjection,
  TeamContextProjectionHost,
} from '../src/context-projection.ts'
import { AGENT_TEAM_PLUGIN_ID, continuationCheckpointRefOf, handoffOf } from '../src/context-source.ts'
import { TEAM_CONTEXT_CODEC } from '../src/context-continuity-host.ts'

/**
 * Team's projection host with no ledger attached: boundary attribution that
 * resolves through the ledger (a claim mutation's Task→Thread) stays empty,
 * exactly as it does before the domain is open. Cases that need a resolved
 * attribution build their own host.
 */
const PROJECTION_HOST = new TeamContextProjectionHost()

/** Fold one log through the engine's unit with Team's config — the production path. */
function fold(events: readonly SessionEvent[], inheritedEventCount?: SessionLogOffset, sessionId: string = SID): ContextProjectionState {
  return foldTeamContextProjection(
    events,
    { sessionId, ...(inheritedEventCount === undefined ? {} : { inheritedEventCount }) },
    PROJECTION_HOST,
  )
}

/** A root generation's header: the engine's lineage walk only reads `parentSession`. */
function headerOf(sessionId: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: sessionId as SessionId, createdAt: 0, isSeeded: false }
}

/**
 * Read one log through the engine's production timeline read with Team's fold
 * config — the same path `context_status` takes, so a case here pins the
 * refs, kinds, and order the model is actually offered.
 */
async function readTimeline(
  events: readonly SessionEvent[],
  options: { readonly sessionId?: string; readonly inheritedEventCount?: SessionLogOffset; readonly limit?: number } = {},
): Promise<readonly ContextTimelineItem[]> {
  const sessionId = options.sessionId ?? SID
  const timeline = await readContextTimeline({
    current: {
      sessionId: sessionId as SessionId,
      header: headerOf(sessionId),
      inheritedEventCount: options.inheritedEventCount ?? SessionLogOffset(0),
      events,
    },
    config: createTeamContextProjectionConfig(PROJECTION_HOST),
    // This spec folds single generations: any ancestor walk would be a bug.
    readAncestor: async () => { throw new Error('this spec has no ancestry') },
    currentUsageTokens: 1000,
    handoffAt: 200_000,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  })
  return timeline.items
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

function toolResult(turn: number, callId: string, options: { isError?: boolean; internalError?: boolean; meta?: object } = {}): SessionEvent {
  const message = createToolResultMessage({
    callId: callId as never,
    content: [{ type: 'text', text: options.isError === true ? 'Error: rejected' : 'ok' }],
    isError: options.isError === true,
  })
  // Durable tool/result events persist the presentationMeta projection at
  // the DATA level (agent-loop appendToolResult), never inside the message
  // content blocks — tests that smuggle meta into content would fold green
  // against a wrong implementation reading the same wrong place.
  return { type: 'tool/result', seq: nextSeq(), time: 0,
    data: { turn, step: 1, message, ...(options.internalError === true ? { error: { name: 'ToolError', code: 'BOOM' } } : {}), ...(options.meta === undefined ? {} : { meta: options.meta }) } } as SessionEvent
}

function userMessageEvent(message: UserMessage): SessionEvent {
  return { type: 'user/message', seq: nextSeq(), time: 0, data: message } as SessionEvent
}

/**
 * Call/result pair under the LEGACY `new_context` name: the pre-rename
 * events crash recovery still folds. Tests of the current model-facing
 * error→retry path must emit `CONTEXT_ROLLOVER_TOOL_NAME` explicitly
 * instead of reusing this helper.
 */
function legacyRolloverPair(turn: number, callId: string, args: { handoff: string; checkpointRef?: string; relatedFiles?: Array<{ path: string; reason: string }> }): SessionEvent[] {
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

describe('AgentTeam context projection — rollover intent', () => {
  it('a successful context_rollover call/result pair creates pending intent', () => {
    const events = [
      turnStart(1),
      ...legacyRolloverPair(1, 'call-1', { handoff: 'continue from here' }),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.pending).toMatchObject({ handoff: 'continue from here', turn: 1, turnEndSeq: events.at(-1)!.seq })
    expect(state.pending?.resultSeq).toBe(events[2]!.seq)
    expect(state.pending?.relatedFiles).toEqual([])
  })

  it('the current tool name creates pending intent identically', () => {
    // The model-facing tool is `context_rollover`; a successful pair under
    // the new name produces the same pending intent shape.
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
      ...legacyRolloverPair(1, 'call-1', { handoff: 'first' }),
      ...legacyRolloverPair(1, 'call-2', { handoff: 'second' }),
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
      ...legacyRolloverPair(1, 'call-invalid-checkpoint', { handoff: 'attempted checkpoint return', checkpointRef: 'context-checkpoint-' + 'f'.repeat(64) }),
      turnEnd(1),
      turnStart(2),
      ...legacyRolloverPair(2, 'call-fresh-retry', { handoff: 'explicit fresh retry' }),
      turnEnd(2),
    ]
    const state = fold(events)
    expect(state.pending).toMatchObject({ toolCallId: 'call-fresh-retry', handoff: 'explicit fresh retry', turn: 2 })
    expect(state.pending?.checkpointRef).toBeUndefined()
  })

  it('a spent pending from the legacy new_context name is replaceable by a modern-name retry', () => {
    // Mixed lineage across the rename: an old-generation ended pending
    // (legacy name, failed swap — process lock gone) must not block the
    // current generation's fresh `context_rollover` from taking over the
    // intent slot.
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
      ...legacyRolloverPair(1, 'call-parent', { handoff: 'old generation' }),
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
      ...legacyRolloverPair(1, 'call-1', { handoff: 'live', relatedFiles: [{ path: 'src/index.ts', reason: 'in progress' }] }),
      turnEnd(1),
    ]
    const definition = createTeamContextProjectionDefinition(PROJECTION_HOST)
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
    expect(continuationDelivered(fold(events), checkpointRef)).toBe(false)
    const delivered = fold([
      ...events,
      userMessageEvent(TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage(checkpointRef as never)),
    ])
    expect(continuationDelivered(delivered, checkpointRef)).toBe(true)
  })

  it('a repeated continuation notice keeps the first delivery seq', () => {
    const checkpointRef = checkpointRefFor(SID, 'call-x')
    const continuation = TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage(checkpointRef as never)
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
    expect(continuationDelivered(state, checkpointRef)).toBe(true)
  })
})

describe('AgentTeam context sources', () => {
  it('the handoff message carries the snapshot form, envelope, and prose section', () => {
    const message = TEAM_CONTEXT_CODEC.createHandoffMessage({
      handoff: 'objective: finish the parser\nnext step: run tests',
      previousSessionId: 'agent-team-old',
      newSessionId: 'agent-team-new',
      trigger: 'model',
      handoffEventSeq: 42,
      relatedFiles: [{ path: 'src/parser.ts', reason: 'rewritten' }],
    })
    // The envelope rides the producer-owned `snapshot` source only: format
    // V4 admits exactly that shape, so a passing admission and a readable
    // envelope are the same assertion.
    expect(message.source).toMatchObject({ kind: AGENT_TEAM_PLUGIN_ID, form: 'snapshot' })
    expect(handoffOf(message)).toMatchObject({
      previousSessionId: 'agent-team-old',
      newSessionId: 'agent-team-new',
      trigger: 'model',
      handoffEventSeq: 42,
      relatedFiles: ['src/parser.ts'],
    })
    expect(handoffOf(message)?.sections[0]).toEqual({ name: 'HANDOFF', text: 'objective: finish the parser\nnext step: run tests' })
    expect(message.content[0]).toMatchObject({ type: 'text' })
  })

  it('checkpoint continuation notices recognize themselves regardless of body text', () => {
    const checkpointRef = checkpointRefFor(SID, 'call-cp')
    const message = TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage(checkpointRef as never)
    expect(message.source).toMatchObject({ kind: AGENT_TEAM_PLUGIN_ID, form: 'snapshot' })
    expect(continuationCheckpointRefOf(message)).toBe(checkpointRef)
  })
})

describe('AgentTeam context projection — timeline boundaries', () => {
  it('a handoff delivery becomes a handoff boundary resolved by its turn end', async () => {
    const events = [
      turnStart(1),
      userMessageEvent(TEAM_CONTEXT_CODEC.createHandoffMessage({ handoff: 'seed text', previousSessionId: 'session:a' as never, newSessionId: 'session:b' as never, trigger: 'model', handoffEventSeq: 5 as never })),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]).toMatchObject({ kind: 'handoff', turnEndSeq: events.at(-1)!.seq })
    // The engine's read derives the ref through Team's host and carries the
    // host's own kind, so the timeline's identity vocabulary stays Team's.
    const boundaryRef = boundaryRefFor(SID, state.boundaries[0]!.resultSeq)
    const items = await readTimeline(events)
    expect(items.find(item => item.ref === boundaryRef)).toMatchObject({ source: 'boundary', kind: 'handoff', label: 'context handoff' })
  })

  it('a Team claim mutation result becomes a team boundary; list calls do not', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-claim', 'team_claim', { action: 'claim', taskRef: 'task:x', baseRevision: 1, direction: 'do it' }),
      toolResult(1, 'call-claim'),
      contextToolCall(1, 'call-list', 'team_claim', { action: 'list', taskRef: 'task:x' }),
      toolResult(1, 'call-list'),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]).toMatchObject({ kind: 'team-boundary', label: 'Team task claim change' })
  })

  it('a structured Team notice is a team boundary on its Thread\'s first arrival; a relay DM and a checkpoint continuation are not', () => {
    const notice = createUserMessage({ content: [{ type: 'text', text: 'Direct Team mention\nThread: thread:4d5e6f70-8b9c-4d5e-0f1a-2b3c4d5e6f70' }], source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Team Inbox has unread work.' } })
    // The relay rides the converted shape of released V3 history — the
    // read-time rename — proving the fold recognizes it identically.
    const relay = createUserMessage({ content: [{ type: 'text', text: 'dm' }], source: { kind: `plugin:${AGENT_TEAM_PLUGIN_ID}`, form: 'relay' } })
    const continuation = TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage(checkpointRefFor(SID, 'call-cp'))
    const events = [
      turnStart(1),
      userMessageEvent(notice),
      userMessageEvent(relay),
      userMessageEvent(continuation),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]!.kind).toBe('team-boundary')
    // The boundary label states WHAT first arrived (the Thread), not the
    // notice's own generic "unread work" account — that is the decision
    // surface a checkpointRef pick needs.
    expect(state.boundaries[0]!.label).toBe('First arrival: thread:4d5e6f70-8b9c-4d5e-0f1a-2b3c4d5e6f70')
  })

  it('a structured Team notice without a summary keeps the generic delivery label on first arrival', () => {
    // form: 'instructions' plugin messages carry no summary; they are still
    // Team-owned structured deliveries, so the label falls back generically.
    const instructions = createUserMessage({ content: [{ type: 'text', text: 'identity\nThread: thread:5e6f7081-9c0d-4e5f-1a2b-3c4d5e6f7081' }], source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'instructions' } })
    const events = [turnStart(1), userMessageEvent(instructions), turnEnd(1)]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]).toMatchObject({ kind: 'team-boundary', label: 'First arrival: thread:5e6f7081-9c0d-4e5f-1a2b-3c4d5e6f7081' })
  })

  it('a pre-compaction notice is a compaction boundary', () => {
    // The converted shape of released V3 history: the compaction boundary must
    // classify converted history exactly like a fresh write.
    const preCompaction = createUserMessage({ content: [{ type: 'text', text: 'persist conclusions' }], source: { kind: `plugin:${AGENT_TEAM_PLUGIN_ID}`, form: 'notice', summary: 'Compaction is imminent; consider persisting key conclusions.' } })
    const events = [turnStart(1), userMessageEvent(preCompaction), turnEnd(1)]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]).toMatchObject({ kind: 'compaction' })
  })

  it('timeline candidates order newest first, include the head, and respect the limit', async () => {
    // One checkpoint per completed turn, three turns total.
    const names = ['first', 'second', 'third']
    const events: SessionEvent[] = []
    for (const [index, name] of names.entries()) {
      const turn = index + 1
      events.push(turnStart(turn), ...checkpointPair(turn, `call-${name}`, name), turnEnd(turn))
    }
    const state = fold(events)
    const candidates = await readTimeline(events, { limit: 2 })
    expect(candidates).toHaveLength(2)
    // The head (latest completed turn) is newest; the third checkpoint is
    // the next-newest anchor.
    expect(candidates[0]!.ref).toBe(`head:${state.lastTurnEndSeq}`)
    expect(candidates[1]!.ref).toBe(checkpointRefFor(SID, 'call-third'))
    const all = await readTimeline(events)
    expect(all[1]!.ref).toBe(checkpointRefFor(SID, 'call-third'))
    expect(all[2]!.ref).toBe(checkpointRefFor(SID, 'call-second'))
    expect(all[3]!.ref).toBe(checkpointRefFor(SID, 'call-first'))
  })

  it('inherited boundaries and checkpoints are invisible to a seeded child fold', async () => {
    const parentEvents = [
      turnStart(1),
      ...checkpointPair(1, 'call-inherited', 'anchor'),
      turnEnd(1),
      turnStart(2),
      userMessageEvent(TEAM_CONTEXT_CODEC.createCheckpointContinuationMessage(checkpointRefFor(SID, 'call-inherited'))),
      turnEnd(2),
    ]
    const inherited = parentEvents.length
    const childEvents = [...parentEvents, turnStart(3), turnEnd(3)]
    const state = fold(childEvents, inherited as SessionLogOffset)
    expect(state.checkpoints).toHaveLength(0)
    expect(state.boundaries).toHaveLength(0)
    expect(state.continuations).toHaveLength(0)
    // The read applies the same cut, so the ancestor's anchors never reach
    // the model through the timeline either.
    const items = await readTimeline(childEvents, { inheritedEventCount: inherited as SessionLogOffset })
    expect(items.every(item => !item.ref.includes('call-inherited'))).toBe(true)
  })

  it('folding one event at a time matches the cold fold of the same log', () => {
    const events: SessionEvent[] = [
      turnStart(1),
      ...checkpointPair(1, 'call-live-cp', 'anchor'),
      turnEnd(1),
      turnStart(2),
      contextToolCall(2, 'call-live-claim', 'team_claim', { action: 'claim', taskRef: 'task:live', baseRevision: 1, direction: 'd' }),
      toolResult(2, 'call-live-claim'),
      turnEnd(2),
      turnStart(3),
      userMessageEvent(createUserMessage({ content: [{ type: 'text', text: 'notice' }], source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Team Inbox has unread work.' } })),
      turnEnd(3),
    ]
    const cold = fold(events)
    const definition = createTeamContextProjectionDefinition(PROJECTION_HOST)
    let live = definition.init({ id: SID } as never, 0 as never)
    for (const event of events) {
      live = definition.apply(live, event)
    }
    expect(live).toEqual(cold)
  })
})

describe('AgentTeam context projection — effect-anchored team boundaries', () => {
  /** One structured Team notice user message. */
  function teamNotice(summary: string, body = 'notice body'): UserMessage {
    return createUserMessage({ content: [{ type: 'text', text: body }], source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary } })
  }

  it('a Thread\'s FIRST delivered notice is a boundary; re-deliveries of the same Thread are not', () => {
    const events = [
      turnStart(1),
      userMessageEvent(teamNotice('Team Inbox has unread work.', 'Thread: thread:6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f task handover')),
      turnEnd(1),
      turnStart(2),
      userMessageEvent(teamNotice('Team Inbox has unread work.', 'Thread: thread:6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f another update')),
      turnEnd(2),
      turnStart(3),
      userMessageEvent(teamNotice('Team Inbox has unread work.', 'Thread: thread:6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f yet another update')),
      turnEnd(3),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]!.kind).toBe('team-boundary')
  })

  it('a second Thread\'s first notice is still a boundary; per-Thread first arrival only', () => {
    const events = [
      turnStart(1),
      userMessageEvent(teamNotice('Team Inbox has unread work.', 'Thread: thread:1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d first')),
      turnEnd(1),
      turnStart(2),
      userMessageEvent(teamNotice('Team Inbox has unread work.', 'Thread: thread:2b3c4d5e-6f7a-4b5c-9d0e-1f2a3b4c5d6e first')),
      turnEnd(2),
      turnStart(3),
      userMessageEvent(teamNotice('Team Inbox has unread work.', 'Thread: thread:1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a3b4c5d again — not a first arrival')),
      turnEnd(3),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(2)
  })

  it('a progress nudge and a recovery notice never produce boundaries', () => {
    const events = [
      turnStart(1),
      userMessageEvent(teamNotice('Progress visibility reminder', 'You have made 20 tool calls…')),
      turnEnd(1),
      turnStart(2),
      userMessageEvent(teamNotice('Recovery: continue your interrupted work.', 'recovery facts')),
      turnEnd(2),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(0)
  })

  it('a committed team_message reply produces a boundary; typed rejections do not', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-msg-ok', 'team_message', { action: 'reply', threadRef: 'thread:reply-target', baseRevision: 8, body: 'committed reply' }),
      toolResult(1, 'call-msg-ok', { meta: { kind: 'committed', threadRef: 'thread:reply-target', revision: 9, messageRef: 'message:m1' } }),
      turnEnd(1),
      turnStart(2),
      contextToolCall(2, 'call-msg-unread', 'team_message', { action: 'reply', threadRef: 'thread:reply-target', baseRevision: 8, body: 'blocked by unread' }),
      toolResult(2, 'call-msg-unread', { meta: { kind: 'unread_required', threadRef: 'thread:reply-target', revision: 9, unreadCount: 2, directCount: 0 } }),
      turnEnd(2),
      turnStart(3),
      contextToolCall(3, 'call-msg-stale', 'team_message', { action: 'reply', threadRef: 'thread:reply-target', baseRevision: 7, body: 'stale revision' }),
      toolResult(3, 'call-msg-stale', { meta: { kind: 'stale_revision', threadRef: 'thread:reply-target', expectedRevision: 7, revision: 9 } }),
      turnEnd(3),
      turnStart(4),
      contextToolCall(4, 'call-msg-notfollowing', 'team_message', { action: 'reply', threadRef: 'thread:reply-target', baseRevision: 9, body: 'mentions a non-follower', mentions: ['member:x'] }),
      toolResult(4, 'call-msg-notfollowing', { meta: { kind: 'member_not_following', memberIds: ['member:x'] } }),
      turnEnd(4),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]!.label).toBe('Team message')
  })

  it('a failed (error) team_message result produces no boundary — the failure-face contract', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-msg-err', 'team_message', { action: 'start', channelRef: 'channel:c', body: 'boom' }),
      toolResult(1, 'call-msg-err', { isError: true }),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(0)
  })

  it('a committed start attributes through its presentationMeta; no meta means no boundary', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-start-meta', 'team_message', { action: 'start', channelRef: 'channel:c', body: 'fresh thread' }),
      toolResult(1, 'call-start-meta', { meta: { kind: 'committed', threadRef: 'thread:born-here', revision: 1, messageRef: 'message:m2' } }),
      turnEnd(1),
      turnStart(2),
      contextToolCall(2, 'call-start-legacy', 'team_message', { action: 'start', channelRef: 'channel:c', body: 'pre-meta era log' }),
      toolResult(2, 'call-start-legacy'),
      turnEnd(2),
    ]
    const state = fold(events)
    // The meta-bearing start is a boundary; the legacy no-meta start is not —
    // old logs refold under the new semantics without their start boundaries.
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]!.label).toBe('Team message')
  })

  it('a dm-sent result produces no boundary — dm is not a Thread fact', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-dm', 'team_message', { action: 'dm', memberRef: 'member:peer', body: 'quick sync' }),
      toolResult(1, 'call-dm', { meta: { kind: 'dm-sent', recipientMemberId: 'member:peer', recipientHandle: 'peer', delivered: true } }),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(0)
  })

  it('successful follow and unfollow produce attention boundaries; a failed follow does not', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-follow', 'team_thread', { action: 'follow', threadRef: 'thread:follow-target' }),
      toolResult(1, 'call-follow'),
      turnEnd(1),
      turnStart(2),
      contextToolCall(2, 'call-unfollow', 'team_thread', { action: 'unfollow', threadRef: 'thread:follow-target' }),
      toolResult(2, 'call-unfollow'),
      turnEnd(2),
      turnStart(3),
      contextToolCall(3, 'call-follow-err', 'team_thread', { action: 'follow', threadRef: 'thread:gone' }),
      toolResult(3, 'call-follow-err', { isError: true }),
      turnEnd(3),
      turnStart(4),
      contextToolCall(4, 'call-read', 'team_thread', { action: 'read', threadRef: 'thread:follow-target' }),
      toolResult(4, 'call-read'),
      turnEnd(4),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(2)
    expect(state.boundaries.every(boundary => boundary.label === 'Team attention change')).toBe(true)
  })

  it('reads and views never produce boundaries — the read path is not an anchor', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-inbox', 'team_inbox', { limit: 10 }),
      toolResult(1, 'call-inbox'),
      turnEnd(1),
      turnStart(2),
      contextToolCall(2, 'call-view', 'team_view', {}),
      toolResult(2, 'call-view'),
      turnEnd(2),
      turnStart(3),
      contextToolCall(3, 'call-read', 'team_thread', { action: 'read', threadRef: 'thread:any' }),
      toolResult(3, 'call-read'),
      turnEnd(3),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(0)
  })

  it('a claim mutation still produces its boundary (preserved behavior, renamed label)', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-claim', 'team_claim', { action: 'claim', taskRef: 'task:x', baseRevision: 1, direction: 'do it' }),
      toolResult(1, 'call-claim'),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]!.label).toBe('Team task claim change')
  })

  it('cold-refold of a v2-shaped log (no seenThreads field) matches folding from empty', () => {
    // A log recorded under the OLD semantics: notice re-deliveries and a
    // claim mutation. After the stateVersion bump the persisted v2 row is
    // unusable (restoreFloor pulls the floor to 0) and the full log refolds
    // from empty under the NEW semantics — claim boundary preserved, notice
    // semantics converged. The assertion is state equality with a from-empty
    // fold of the same log, never a row transform.
    const events = [
      turnStart(1),
      userMessageEvent(teamNotice('Team Inbox has unread work.', 'Thread: thread:3c4d5e6f-7a8b-4c5d-0e1f-2a3b4c5d6e7f first')),
      turnEnd(1),
      turnStart(2),
      userMessageEvent(teamNotice('Team Inbox has unread work.', 'Thread: thread:3c4d5e6f-7a8b-4c5d-0e1f-2a3b4c5d6e7f repeat')),
      turnEnd(2),
      turnStart(3),
      contextToolCall(3, 'call-old-claim', 'team_claim', { action: 'claim', taskRef: 'task:old', baseRevision: 1, direction: 'd' }),
      toolResult(3, 'call-old-claim'),
      turnEnd(3),
    ]
    const refolded = fold(events)
    expect(refolded.boundaries).toHaveLength(2)
    expect(refolded.boundaries.some(boundary => boundary.label === 'Team task claim change')).toBe(true)
    expect(refolded.boundaries.filter(boundary => boundary.kind === 'team-boundary' && boundary.label === 'First arrival: thread:3c4d5e6f-7a8b-4c5d-0e1f-2a3b4c5d6e7f')).toHaveLength(1)
  })

  it('a first-arrival notice boundary labels the Thread it introduces, not the notice summary', () => {
    // The inbox notice summary says only "unread work" — the timeline's
    // decision surface needs WHAT arrived (which Thread first entered the
    // context), so the boundary label is rewritten from the first-arrival
    // facts, never the notice's own account.
    const events = [
      turnStart(1),
      userMessageEvent(teamNotice('Team Inbox has unread work.', 'Direct Team mention\nThread: thread:4d5e6f70-8b9c-4d5e-0f1a-2b3c4d5e6f70 task handover')),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]!.label).toBe('First arrival: thread:4d5e6f70-8b9c-4d5e-0f1a-2b3c4d5e6f70')
  })

  it('a first-arrival boundary introducing two Threads labels both, in delivery order', () => {
    // One delivered notice may quote two Threads that are both new to this
    // Session (e.g. a handover mention plus its Task thread); the label
    // carries both first arrivals so the model sees the full attribution
    // before deciding whether the anchor is single-Thread selectable.
    const events = [
      turnStart(1),
      userMessageEvent(teamNotice('Team Inbox has unread work.', 'Thread: thread:1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a2b4c5d and\nThread: thread:2b3c4d5e-6f7a-4b5c-9d0e-1f2a3b4c5d6e both new')),
      turnEnd(1),
    ]
    const state = fold(events)
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]!.label).toBe('First arrival: thread:1a2b3c4d-5e6f-4a5b-8c9d-0e1f2a2b4c5d, thread:2b3c4d5e-6f7a-4b5c-9d0e-1f2a3b4c5d6e')
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

  it('boundary refs are Session-scoped: an ancestor boundary never collides with this generation\'s', async () => {
    const seq = 7
    expect(boundaryRefFor('agent-team-generation-one', seq)).not.toBe(boundaryRefFor('agent-team-generation-two', seq))
    const notice = createUserMessage({ content: [{ type: 'text', text: 'Thread: thread:aaaa1111-2222-4333-8444-555566667777' }], source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Team Inbox has unread work.' } })
    const event = userMessageEvent(notice)
    const first = fold([turnStart(1), event, turnEnd(2)], undefined, 'agent-team-generation-one')
    const second = fold([turnStart(1), { ...event, seq: event.seq }, turnEnd(2)], undefined, 'agent-team-generation-two')
    // Both generations anchor the boundary at the same event seq; only the
    // Session identity in the ref keeps the two apart.
    expect(first.boundaries[0]!.resultSeq).toBe(second.boundaries[0]!.resultSeq)
    const firstRef = boundaryRefFor('agent-team-generation-one', first.boundaries[0]!.resultSeq)
    const secondRef = boundaryRefFor('agent-team-generation-two', second.boundaries[0]!.resultSeq)
    expect(firstRef).toBe(boundaryRefFor('agent-team-generation-one', event.seq))
    expect(secondRef).toBe(boundaryRefFor('agent-team-generation-two', event.seq))
    expect(firstRef).not.toBe(secondRef)
    // The engine's read derives each ref through the host of its own source.
    const items = await readTimeline([turnStart(1), event, turnEnd(2)], { sessionId: 'agent-team-generation-one' })
    expect(items.find(item => item.source === 'boundary')!.ref).toBe(firstRef)
  })

  it('a claim boundary is attributed to its Task\'s Thread through the ledger; without a resolution it stays unattributed', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-claim', 'team_claim', { action: 'claim', taskRef: 'task:x', baseRevision: 1, direction: 'do it' }),
      toolResult(1, 'call-claim'),
      turnEnd(1),
    ]
    const attributed = foldTeamContextProjection(
      events,
      { sessionId: SID },
      new TeamContextProjectionHost({ threadForTask: () => 'thread:owner' as never }),
    )
    expect(attributed.boundaries[0]!.attributions).toEqual(['thread:owner'])
    // The default host carries no ledger: the boundary still anchors the
    // timeline, it is simply not selectable as a single-Thread return target.
    expect(fold(events).boundaries[0]!.attributions).toEqual([])
  })

  it('a claim boundary with an unknown Task keeps its anchor and drops only the attribution', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-claim-unknown', 'team_claim', { action: 'done', taskRef: 'task:gone', baseRevision: 2 }),
      toolResult(1, 'call-claim-unknown'),
      turnEnd(1),
    ]
    const state = foldTeamContextProjection(events, { sessionId: SID }, new TeamContextProjectionHost({ threadForTask: () => undefined }))
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]!.attributions).toEqual([])
  })

  it('attention and committed-message boundaries carry the Thread they touched', () => {
    const events = [
      turnStart(1),
      contextToolCall(1, 'call-follow', 'team_thread', { action: 'follow', threadRef: 'thread:followed' }),
      toolResult(1, 'call-follow'),
      turnEnd(1),
      turnStart(2),
      contextToolCall(2, 'call-reply', 'team_message', { action: 'reply', threadRef: 'thread:replied', baseRevision: 3, body: 'x' }),
      toolResult(2, 'call-reply', { meta: { kind: 'committed', threadRef: 'thread:replied', revision: 4, messageRef: 'message:m' } }),
      turnEnd(2),
    ]
    const state = fold(events)
    expect(state.boundaries.map(boundary => boundary.attributions)).toEqual([['thread:followed'], ['thread:replied']])
  })

  it('a first-arrival notice records the Threads it introduced as seen topics', () => {
    const notice = createUserMessage({ content: [{ type: 'text', text: 'Thread: thread:aaaa1111-2222-4333-8444-555566667777 and\nThread: thread:bbbb2222-3333-4444-8555-666677778888' }], source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Team Inbox has unread work.' } })
    const state = fold([turnStart(1), userMessageEvent(notice), turnEnd(1)])
    expect(state.seenTopics).toEqual(['thread:aaaa1111-2222-4333-8444-555566667777', 'thread:bbbb2222-3333-4444-8555-666677778888'])
    expect(state.boundaries[0]!.attributions).toEqual(state.seenTopics)
  })
})
