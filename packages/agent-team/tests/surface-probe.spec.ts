import { describe, expect, it } from 'vitest'
import { createToolResultMessage, createUserMessage, freezeMessage, ToolCallId, type Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionMessageProjection } from '@deepseek-ai/dsh-session/surface'
import { AGENT_TEAM_PLUGIN_ID } from '../src/context-source.ts'
import { isFactOnSurface, teamMessageSurface, visibleTeamSurface } from '../src/surface-visibility.ts'
import type { AgentTeamThreadReadFact, AgentTeamThreadRef } from '../src/types.ts'
import { teamTools } from '../../tool-agent-team/tests/render-text.ts'

const THREAD = 'thread:alpha' as AgentTeamThreadRef
const OTHER_THREAD = 'thread:beta' as AgentTeamThreadRef

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/prune-team-fact': { readonly seq: number; readonly text: string }
  }
}

const prune: SessionMessageProjection<'test/prune-team-fact'> = {
  type: 'test/prune-team-fact',
  project(event, context) {
    const seq = SessionSeq(event.data.seq)
    const source = context.events[seq - context.baseSeq]
    const message = context.messages.get(seq) ?? (source?.type === 'tool/result' ? source.data.message : source?.type === 'user/message' ? source.data : undefined)
    return new Map<SessionSeq, Message>(message === undefined ? [] : [[seq, freezeMessage({ ...message, content: [{ type: 'text', text: event.data.text }] })]])
  },
}

function session() {
  return Session.create(SessionId('session:surface-probe'), undefined, undefined, undefined, [prune])
}

function factOf(body: string, messageRef = 'message:a'): AgentTeamThreadReadFact {
  return { fact: { kind: 'message', sequence: 12, message: { messageRef, body } as never, mentions: [], occurredAt: '2026-10-14T00:00:00.000Z' }, unread: true, direct: true }
}

function result(target: Session, body: string, threadRef = THREAD, messageRef = 'message:a', name = 'team_message') {
  const tool = teamTools().get('team_message')!
  const args = { action: 'reply', threadRef, body: 'response', baseRevision: 10 }
  const value = { kind: 'unread_required', threadRef, revision: 12, unreadCount: 1, directCount: 0,
    facts: [{ kind: 'message', sequence: 12, sender: 'human', messageRef, body }] }
  const callId = ToolCallId(`call:${target.snapshotEvents().length}`)
  const call = target.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
  return target.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: tool.output.render(args, value), isError: false }),
    meta: tool.output.presentationMeta!(args, value),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

function sees(target: Session, body: string, threadRef = THREAD, messageRef = 'message:a') {
  return isFactOnSurface(visibleTeamSurface({ session: target }), factOf(body, messageRef), threadRef)
}

describe('only complete Team-sourced facts on the current Session surface satisfy the gate', () => {
  it('recognizes an actual rendered rejection, with the exact Thread, Message and body', () => {
    const target = session()
    result(target, 'ok')
    expect(sees(target, 'ok')).toBe(true)
    expect(sees(target, 'ok', OTHER_THREAD)).toBe(false)
    expect(sees(target, 'ok', THREAD, 'message:b')).toBe(false)
    expect(sees(target, 'OK')).toBe(false)
    expect(sees(target, 'o')).toBe(false)
  })

  it('rejects a projected summary that retains meta and repeats the same short body', () => {
    const target = session()
    const original = result(target, 'ok')
    target.append('test/prune-team-fact', { seq: original.seq, text: 'Summary: ok\n' })
    expect(original.data.message.content[0]).toMatchObject({ text: expect.stringContaining('ok') })
    expect(target.deriveEventMessage(original)?.content[0]).toMatchObject({ text: 'Summary: ok\n' })
    expect(sees(target, 'ok')).toBe(false)
  })

  it('does not borrow the same text from a different Message after cropping', () => {
    const target = session()
    const first = result(target, 'ok')
    target.append('test/prune-team-fact', { seq: first.seq, text: '[removed]' })
    result(target, 'ok', THREAD, 'message:b')
    expect(sees(target, 'ok')).toBe(false)
    expect(sees(target, 'ok', THREAD, 'message:b')).toBe(true)
  })

  it('requires a Team tool call, not just metadata on an unrelated tool', () => {
    const target = session()
    result(target, 'ok', THREAD, 'message:a', 'bash')
    expect(sees(target, 'ok')).toBe(false)
  })

  it('rejects a truncated tool result even while it remains unchanged', () => {
    const target = session()
    result(target, 'x'.repeat(12 * 1024))
    expect(sees(target, 'x'.repeat(12 * 1024))).toBe(false)
  })

  it('keeps valid bindings through Session restore, not through surface replacement', () => {
    const target = session()
    const original = result(target, 'ok')
    const restored = Session.fromRestore(target.id, [...target.snapshotEvents()], target.header,
      target.inheritedEventCount, 'shared-frozen', [prune])
    expect(sees(restored, 'ok')).toBe(true)
    restored.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Summary: ok' }] }), {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq],
    })
    expect(sees(restored, 'ok')).toBe(false)
  })

  it('recognizes a bound notice but not a forged body, retained source, or foreign producer', () => {
    const target = session()
    const text = 'Direct Team mention\nThread: thread:alpha\nMessage ref: message:a\nMessage: ok'
    const source = { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice' as const, summary: 'Team Inbox',
      teamFacts: teamMessageSurface(text, [{ threadRef: THREAD, messageRef: 'message:a', body: 'ok' }]) } as const
    const original = target.append('user/message', createUserMessage({ source, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    expect(sees(target, 'ok')).toBe(true)
    target.append('test/prune-team-fact', { seq: original.seq, text: 'Summary: ok' })
    expect(sees(target, 'ok')).toBe(false)
    target.append('user/message', createUserMessage({ source: { ...source, kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    expect(sees(target, 'ok')).toBe(false)
    target.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: 'Summary: ok' }] }), { surfaceOp: 'append' })
    expect(sees(target, 'ok')).toBe(false)
  })

  it('requires every exact part after restore and rejects a clipped part with retained metadata', () => {
    const target = session()
    const tool = teamTools().get('team_thread')!
    const args = { action: 'message', threadRef: THREAD, messageRef: 'message:a' }
    const appendPart = (start: number, end: number) => {
      const value = { kind: 'message', workspaceId: 'workspace:alpha', projectRef: 'project:alpha', threadRef: THREAD,
        message: { messageRef: 'message:a', sequence: 12, sender: 'human', body: 'abcdef' },
        messageParts: [{ messageRef: 'message:a', start, end, complete: false }] }
      const callId = ToolCallId(`part:${start}`)
      const call = target.append('tool/call', { turn: 1, step: 1, callId, name: 'team_thread', arguments: JSON.stringify(args) })
      return target.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: tool.output.render(args, value), isError: false }),
        meta: tool.output.presentationMeta!(args, value),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    appendPart(4, 6)
    expect(sees(target, 'abcdef')).toBe(false)
    appendPart(0, 2)
    expect(sees(target, 'abcdef')).toBe(false)
    const middle = appendPart(2, 4)
    const restored = Session.fromRestore(target.id, [...target.snapshotEvents()], target.header,
      target.inheritedEventCount, 'shared-frozen', [prune])
    expect(sees(restored, 'abcdef')).toBe(true)
    restored.append('test/prune-team-fact', { seq: middle.seq, text: 'Summary: cd' })
    expect(sees(restored, 'abcdef')).toBe(false)
    expect(sees(restored, 'abcdef', OTHER_THREAD)).toBe(false)
  })

  it('does not parse nested notification syntax in another message body', () => {
    const target = session()
    const text = 'Direct Team mention\nThread: thread:alpha\nMessage ref: message:a\nMessage: ok'
    target.append('user/message', createUserMessage({ source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Team Inbox',
      teamFacts: teamMessageSurface(text, [{ threadRef: OTHER_THREAD, messageRef: 'message:b', body: text }]) },
      content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    expect(sees(target, 'ok')).toBe(false)
  })
})
