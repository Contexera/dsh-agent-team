/**
 * Session format V4 admission and read-time conversion fence for Agent Team
 * message sources.
 *
 * Format V4 requires every durable message source to carry its producer's own
 * kind (non-empty, and not the retired `plugin` wrapper) and refuses the
 * wrapper at write time. Released V3 history is not rewritten on disk: the
 * V3→V4 read-time conversion renames one released `plugin` source into
 * `plugin:<producer>` (dropping the `plugin` key, keeping `form`/`sections`/
 * `summary`), so the read side must recognize both shapes by exact identity.
 *
 * This spec drives the official admission and conversion functions over the
 * sources this package actually writes, with the retired shapes kept as
 * negative controls so the assertions cannot silently stop testing anything.
 *
 * The migration packages resolve through the sibling Harness checkout that
 * `scripts/link-harness-packages.mjs` links, like the other Harness imports in
 * this suite — they are the contract under test, not a build dependency.
 */
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tool-jobs'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { rewriteV3MessageSource } from '@deepseek-ai/dsh-session-format-v3-to-v4/src/sources.ts'
import {
  AGENT_TEAM_PLUGIN_ID,
  CHECKPOINT_SECTION_NAME,
  HANDOFF_SECTION_NAME,
  continuationCheckpointRefOf,
  handoffOf,
  isAgentTeamSource,
  matchesProducerKind,
  isCheckpointContinuationMessage,
  isHandoffMessage,
} from '../src/context-source.ts'
import { createCheckpointContinuationMessage } from '../src/context-codec.ts'
import { createHandoffMessage } from './helpers/legacy-context-envelopes.ts'

const handoffInput = {
  handoff: 'objective: finish the parser\nnext step: run tests',
  previousSessionId: 'agent-team-previous',
  newSessionId: 'agent-team-next',
  trigger: 'model' as const,
  handoffEventSeq: 42,
  checkpointRef: 'context-checkpoint-abc',
  relatedFiles: [{ path: 'src/parser.ts', reason: 'rewritten' }],
}

/** One durable user-message row carrying `source`, in the shape the jsonl writer hands the V4 admission. */
function userRow(source: unknown): unknown {
  return {
    type: 'user/message',
    data: { id: 'message', role: 'user', content: [{ type: 'text', text: 'body' }], source },
  }
}

/** The official V3→V4 conversion of one released V3 `plugin` source. */
function convertV3(source: SessionFormatJsonObject): SessionFormatJsonObject {
  return rewriteV3MessageSource(source, 1, undefined)
}

describe('Agent Team message sources satisfy format V4 admission', () => {
  it('admits every source this package writes', () => {
    // The three producer ids this bundle claims: the plugin's own id for its
    // delivered notices and relays, plus the two per-Member producers, which
    // carry their own id as the kind (`member-context`, `member-time-context`).
    expect(() => assertV4RowAdmission(userRow({ kind: AGENT_TEAM_PLUGIN_ID, form: 'notice', summary: 'Team Inbox has unread work.' }))).not.toThrow()
    expect(() => assertV4RowAdmission(userRow({ kind: AGENT_TEAM_PLUGIN_ID, form: 'relay' }))).not.toThrow()
    expect(() => assertV4RowAdmission(userRow({ kind: 'wowyuarm-agent-team-member-context', form: 'instructions' }))).not.toThrow()
    expect(() => assertV4RowAdmission(userRow({ kind: 'wowyuarm-agent-team-member-time-context', form: 'snapshot', sections: [{ name: 'Team clock', text: 'now' }] }))).not.toThrow()
    expect(() => assertV4RowAdmission(userRow({ kind: AGENT_TEAM_PLUGIN_ID, form: 'snapshot', sections: [{ name: HANDOFF_SECTION_NAME, text: 'prose' }] }))).not.toThrow()
  })

  it('admits the checkpoint continuation this build writes and the handoff shape old logs carry', () => {
    // This package's own codec writes the continuation, so the row fences the
    // producer kind it must keep writing. The handoff has no writer left; the
    // row fences the old-log shape the read side still decodes.
    const handoff = createHandoffMessage(handoffInput)
    expect(handoff.source.kind).toBe(AGENT_TEAM_PLUGIN_ID)
    expect(() => assertV4RowAdmission(userRow(handoff.source))).not.toThrow()
    const continuation = createCheckpointContinuationMessage('context-checkpoint-abc')
    expect(continuation.source.kind).toBe(AGENT_TEAM_PLUGIN_ID)
    expect(() => assertV4RowAdmission(userRow(continuation.source))).not.toThrow()
  })

  it('refuses the retired plugin wrapper at write time, so this fence still has teeth', () => {
    // The shape every released line before V4 wrote; V4 refuses it at the
    // write/admission boundary, not at display time.
    expect(() => assertV4RowAdmission(userRow({
      kind: 'plugin',
      plugin: AGENT_TEAM_PLUGIN_ID,
      form: 'snapshot',
      sections: [{ name: HANDOFF_SECTION_NAME, text: 'prose' }],
    }))).toThrow(/producer-owned source kind/)
    expect(() => assertV4RowAdmission(userRow({ kind: 'plugin' }))).toThrow(/producer-owned source kind/)
  })
})

describe('Released V3 history reads back through the official conversion', () => {
  it('renames this plugin’s wrapper rows exactly as the read side expects', () => {
    const handoff = createHandoffMessage(handoffInput)
    const converted = convertV3({
      kind: 'plugin',
      plugin: AGENT_TEAM_PLUGIN_ID,
      form: 'snapshot',
      sections: JSON.parse(JSON.stringify([...handoffOf(handoff)!.sections])) as SessionFormatJsonObject,
    })
    expect(converted['kind']).toBe(`plugin:${AGENT_TEAM_PLUGIN_ID}`)
    expect(converted).not.toHaveProperty('plugin')
    expect(converted['form']).toBe('snapshot')
    // The shape the read side receives: the converted kind with every payload
    // field preserved, and no `plugin` key.
    const restored = createUserMessage({
      content: [...handoff.content],
      source: {
        kind: `plugin:${AGENT_TEAM_PLUGIN_ID}`,
        form: 'snapshot',
        sections: [...handoffOf(handoff)!.sections],
      },
    })
    expect(isHandoffMessage(restored)).toBe(true)
    expect(restored.source.kind).toBe(`plugin:${AGENT_TEAM_PLUGIN_ID}`)
    expect(isAgentTeamSource(restored.source)).toBe(true)
  })

  it('keeps a two-field wrapper down to exactly its renamed kind', () => {
    expect(convertV3({ kind: 'plugin', plugin: 'wowyuarm-agent-team-member-context' })).toEqual({
      kind: 'plugin:wowyuarm-agent-team-member-context',
    })
  })

  it('does not claim a third-party producer’s converted row', () => {
    // A same-name whitelisted third-party producer keeps its own kind; a
    // fallback-renamed one becomes `plugin:<its own id>`. Exact identity
    // matching must leave both outside this plugin's attribution.
    expect(convertV3({ kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'job done' })['kind']).toBe('tool-jobs')
    expect(matchesProducerKind('tool-jobs', AGENT_TEAM_PLUGIN_ID)).toBe(false)
    const foreign = createUserMessage({
      content: [{ type: 'text', text: 'body' }],
      source: {
        kind: 'tool-jobs',
        form: 'snapshot',
        sections: [{ name: HANDOFF_SECTION_NAME, text: 'looks like a handoff' }],
      },
    })
    expect(isHandoffMessage(foreign)).toBe(false)
    expect(continuationCheckpointRefOf(foreign)).toBeUndefined()
  })

  it('reads the checkpoint ref from a converted continuation by exact identity', () => {
    const ref = 'context-checkpoint-0123456789abcdef'
    const continuation = createCheckpointContinuationMessage(ref)
    const restored = createUserMessage({
      content: [...continuation.content],
      source: {
        kind: `plugin:${AGENT_TEAM_PLUGIN_ID}`,
        form: 'snapshot',
        sections: [{ name: CHECKPOINT_SECTION_NAME, text: ref }],
      },
    })
    expect(restored.source).toMatchObject({
      kind: `plugin:${AGENT_TEAM_PLUGIN_ID}`,
      form: 'snapshot',
      sections: [{ name: CHECKPOINT_SECTION_NAME, text: ref }],
    })
    expect(continuationCheckpointRefOf(restored)).toBe(ref)
    expect(isCheckpointContinuationMessage(restored)).toBe(true)
    expect(isCheckpointContinuationMessage(restored, ref)).toBe(true)
    expect(isCheckpointContinuationMessage(restored, 'context-checkpoint-other')).toBe(false)
  })
})

describe('Agent Team message sources read back through the admitted slots', () => {
  it('recovers the whole handoff envelope from its named sections, in both shapes', () => {
    const message = createHandoffMessage(handoffInput)
    expect(isHandoffMessage(message)).toBe(true)
    expect(handoffOf(message)).toMatchObject({
      previousSessionId: 'agent-team-previous',
      newSessionId: 'agent-team-next',
      trigger: 'model',
      handoffEventSeq: 42,
      checkpointRef: 'context-checkpoint-abc',
      relatedFiles: ['src/parser.ts'],
    })
    expect(handoffOf(message)?.sections[0]).toEqual({ name: HANDOFF_SECTION_NAME, text: handoffInput.handoff })

    const converted = createUserMessage({
      content: [...message.content],
      source: {
        kind: `plugin:${AGENT_TEAM_PLUGIN_ID}`,
        form: 'snapshot',
        sections: [...handoffOf(message)!.sections],
      },
    })
    expect(handoffOf(converted)).toMatchObject({
      previousSessionId: 'agent-team-previous',
      newSessionId: 'agent-team-next',
      trigger: 'model',
      handoffEventSeq: 42,
      checkpointRef: 'context-checkpoint-abc',
      relatedFiles: ['src/parser.ts'],
    })
  })

  it('omits absent optional envelope facts instead of inventing them', () => {
    const { checkpointRef: _checkpointRef, relatedFiles: _relatedFiles, ...bare } = handoffInput
    const message = createHandoffMessage(bare)
    const handoff = handoffOf(message)
    expect(handoff).toBeDefined()
    expect(handoff?.checkpointRef).toBeUndefined()
    expect(handoff?.relatedFiles).toBeUndefined()
  })

  it('round-trips a related path that contains a comma', () => {
    const message = createHandoffMessage({
      ...handoffInput,
      relatedFiles: [{ path: 'src/a, b.ts', reason: 'odd but legal name' }, { path: 'src/parser.ts' }],
    })
    expect(handoffOf(message)?.relatedFiles).toEqual(['src/a, b.ts', 'src/parser.ts'])
    // The exact-path encoding still rides the admitted section slot.
    expect(() => assertV4RowAdmission(userRow(message.source))).not.toThrow()
  })

  it('still reads the comma-joined related-files section old generations wrote', () => {
    // The converted shape of a released V3 handoff: renamed kind, no `plugin`
    // key, legacy comma-joined `Related files` section preserved verbatim.
    const legacy = createUserMessage({
      content: [{ type: 'text', text: 'handoff' }],
      source: {
        kind: `plugin:${AGENT_TEAM_PLUGIN_ID}`,
        form: 'snapshot',
        sections: [
          { name: HANDOFF_SECTION_NAME, text: 'prose' },
          { name: 'Previous session', text: 'agent-team-previous' },
          { name: 'New session', text: 'agent-team-next' },
          { name: 'Trigger', text: 'model' },
          { name: 'Handoff event seq', text: '42' },
          { name: 'Related files', text: 'src/parser.ts, src/lexer.ts' },
        ],
      },
    })
    expect(handoffOf(legacy)?.relatedFiles).toEqual(['src/parser.ts', 'src/lexer.ts'])
  })

  it('recovers the checkpoint ref from a continuation, exactly and by identity', () => {
    const ref = 'context-checkpoint-0123456789abcdef'
    const message = createCheckpointContinuationMessage(ref)
    expect(continuationCheckpointRefOf(message)).toBe(ref)
    expect(isCheckpointContinuationMessage(message)).toBe(true)
    expect(isCheckpointContinuationMessage(message, ref)).toBe(true)
    expect(isCheckpointContinuationMessage(message, 'context-checkpoint-other')).toBe(false)
    expect(isAgentTeamSource(message.source)).toBe(true)
  })

  it('does not claim another producer’s snapshot or a foreign plugin message', () => {
    const foreign = createUserMessage({
      content: [{ type: 'text', text: 'body' }],
      source: { kind: 'tool-jobs', form: 'snapshot', sections: [{ name: 'runtime', text: 'context' }] },
    })
    expect(isHandoffMessage(foreign)).toBe(false)
    expect(continuationCheckpointRefOf(foreign)).toBeUndefined()
    // Our own snapshot without the handoff marker is not a handoff either.
    expect(isHandoffMessage(createUserMessage({
      content: [{ type: 'text', text: 'body' }],
      source: { kind: AGENT_TEAM_PLUGIN_ID, form: 'snapshot', sections: [{ name: 'other', text: 'x' }] },
    }))).toBe(false)
  })
})
