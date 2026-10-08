import { describe, expect, it } from 'vitest'
import { contextTools, renderText } from './render-text.ts'
import { engineTimelineItems } from '../src/context-tools.ts'
import { AGENT_TEAM_TOOL_NAMES } from '@contexera/dsh-agent-team/host'

/**
 * Render-layer discriminating tests: renders are the only channel a tool
 * result reaches the model through, so every field the model must act on
 * (the checkpoint ref, per-anchor verdicts) has to appear in the rendered
 * text — a schema field the render drops is model-invisible (this exact
 * regression made seeded returns unusable in live dogfooding).
 *
 * All four context tools are the engine's own definitions, so what these tests
 * pin is the Team's half of the contract: the vocabulary spliced in as
 * `timelineGuidance`, and the one Team rule the adapter enforces — a row that is
 * not restorable answers with a short digest instead of its ref, because the
 * engine's render prints that field on every row.
 */

const STATUS_VALUE = {
  usageTokens: 55577,
  hardLimit: 256000,
  handoffAt: 200000,
  compactible: { compactibleTokens: 48000, retainedTailTokens: 32000 },
  items: [
    {
      ref: 'context-checkpoint-' + 'a'.repeat(64),
      label: 'live smoke before context rollover',
      source: 'checkpoint',
      retainedTokens: 84971,
      discardedTokens: 0,
      affectedTopics: ['thread:bce6b8c6-f781-47e6-8e87-4e99c7f446d1'],
      restorable: true,
    },
    {
      ref: '2f1c9a',
      label: 'team delivery',
      source: 'boundary',
      kind: 'handoff',
      retainedTokens: 12000,
      discardedTokens: 8000,
      affectedTopics: ['thread:one', 'thread:two'],
      restorable: false,
      reason: 'multiple Threads entered the context through this boundary; write a fresh handoff instead',
      sourceSessionId: 'session-ancestor',
    },
    {
      ref: '9a0b1c',
      label: 'current head',
      source: 'head',
      retainedTokens: 55577,
      discardedTokens: 0,
      affectedTopics: [],
      restorable: false,
      reason: 'the head is the current working set; returning to it discards nothing',
    },
  ],
} as const

describe('context tools render the model-facing decision surface', () => {
  it('context_checkpoint renders the full opaque ref the model must cite', () => {
    const tools = contextTools()
    expect(tools.has('context_checkpoint')).toBe(true)
    const text = renderText(tools.get('context_checkpoint')!, {}, {
      checkpointRef: 'context-checkpoint-' + 'd'.repeat(64),
      name: 'post-rollover smoke anchor',
    })
    // The ref is the context_rollover selection surface: without it in the text
    // the model has no legitimate way to reference the anchor it recorded.
    expect(text).toContain('context-checkpoint-' + 'd'.repeat(64))
    expect(text).toContain('post-rollover smoke anchor')
  })

  it('context_status renders the budgets, the compaction price, and every row verdict', () => {
    const tools = contextTools()
    expect(tools.has('context_status')).toBe(true)
    const text = renderText(tools.get('context_status')!, {}, STATUS_VALUE)
    // The three budget numbers and the anchor tally are the header the decision
    // starts from.
    expect(text).toContain('Context: 55,577 / 200,000 handoff / 256,000 hard limit')
    expect(text).toContain('Anchors: 3 rows · 1 restorable')
    // A compaction started now is priced where this scope can price one: the
    // member's two options have to be comparable from one read.
    expect(text).toContain('Compact now: about 48K compactible; keeps the last ~32K verbatim')
    // Each row renders its label, source, size estimates and Threads.
    for (const item of STATUS_VALUE.items) {
      expect(text).toContain(item.label)
      expect(text).toContain(`source: ${item.source}`)
      expect(text).toContain(`retained ~${item.retainedTokens}`)
      expect(text).toContain(`discarded ~${item.discardedTokens}`)
      if (item.affectedTopics.length === 0) {
        expect(text).toContain('no Threads')
      } else {
        for (const thread of item.affectedTopics) expect(text).toContain(thread)
      }
      if (item.restorable) {
        // A restorable anchor must carry its full ref for context_rollover.
        expect(text).toContain(item.ref)
        expect(text).toContain('restorable')
      } else {
        // A non-restorable anchor must state why, so the model writes a
        // fresh handoff instead of retrying the anchor.
        expect(text).toContain('not restorable')
        expect(text).toContain(item.reason)
        expect(text).toContain('not selectable')
      }
    }
    // A boundary's own kind survives the mapping onto the engine's three
    // sources: a handoff boundary is not flattened into a generic boundary.
    expect(text).toContain('source: boundary — handoff')
  })

  it('the adapter answers a non-restorable row with a digest, never a citable ref', () => {
    // Two boundaries that share a label and a price — exactly what two
    // deliveries resolved in the same turn produce — must still be
    // distinguishable, and a row that is not restorable must never hand the
    // engine a ref-shaped string: the engine prints this field on every row, so
    // a ref here is a ref the model can copy into checkpointRef.
    const anchor = {
      checkpointRef: 'team-boundary-' + '1'.repeat(64),
      name: 'Team message',
      source: 'team-boundary' as const,
      retainedTokens: 4242,
      discardedTokens: 0,
      affectedThreads: ['thread:one'],
      restorable: false,
      reason: 'retained context would not materially shrink the working set',
    }
    const other = { ...anchor, checkpointRef: 'team-boundary-' + '2'.repeat(64) }
    const rows = engineTimelineItems([anchor, other])
    for (const row of rows) {
      expect(row.ref).toMatch(/^[0-9a-f]{6}$/)
      expect(row.ref).not.toContain('team-boundary-')
      expect(row.restorable).toBe(false)
    }
    // Distinct rows stay distinct, and the digest is a function of the ref: a
    // repeated read of one anchor keeps its identity.
    expect(rows[0]!.ref).not.toBe(rows[1]!.ref)
    expect(engineTimelineItems([anchor])[0]!.ref).toBe(rows[0]!.ref)
    // A restorable row is the one row whose ref the rollover call may cite, so
    // it answers with the ref itself.
    const seeded = engineTimelineItems([{ ...anchor, restorable: true }])
    expect(seeded[0]!.ref).toBe(anchor.checkpointRef)
    // Team's own sources collapse onto the engine's kinds; the two that carry
    // meaning a reader needs ride its opaque `kind` field.
    expect(engineTimelineItems([{ ...anchor, source: 'agent' }])[0]!.source).toBe('checkpoint')
    expect(engineTimelineItems([{ ...anchor, source: 'head' }])[0]!.source).toBe('head')
    expect(engineTimelineItems([{ ...anchor, source: 'handoff' }])[0]!.kind).toBe('handoff')
    expect(engineTimelineItems([{ ...anchor, source: 'compaction' }])[0]!.kind).toBe('compaction')
    expect(engineTimelineItems([anchor])[0]!.kind).toBeUndefined()
  })

  it('context_status keeps the output bounded by the Host-supplied item list', () => {
    const tools = contextTools()
    // The Host bounds items (default 12, at most 24); the render mirrors
    // that list one line per item and nothing beyond it.
    const items = Array.from({ length: 24 }, (_, index) => ({
      ref: `context-checkpoint-${index.toString(16).padStart(64, '0')}`,
      label: `anchor-${index}`,
      source: 'checkpoint',
      retainedTokens: index * 100,
      discardedTokens: 0,
      affectedTopics: [],
      restorable: true,
    }))
    const text = renderText(tools.get('context_status')!, {}, { usageTokens: 1, hardLimit: 256000, handoffAt: 200000, items })
    for (const item of items) expect(text).toContain(item.ref)
    expect(text).toContain('anchor-23')
    expect(text).toContain('Anchors: 24 rows · 24 restorable')
  })

  it('registers the engine roster and retires the Team-authored timeline name', () => {
    const tools = contextTools()
    // The roster the Host validates against and the registered surface are one
    // list: a description naming a tool the surface lacks is exactly the defect
    // this swap removed (the engine's own copy names context_status and
    // context_compact).
    for (const name of ['context_rollover', 'context_checkpoint', 'context_status', 'context_compact']) {
      expect(tools.has(name)).toBe(true)
      expect([...AGENT_TEAM_TOOL_NAMES]).toContain(name)
    }
    // Hard retirement: the Team-authored timeline must not survive as a second
    // registration — two tools reading one lineage would let a stale session
    // cite a ref the other never offered.
    expect(tools.has('context_timeline')).toBe(false)
    expect([...AGENT_TEAM_TOOL_NAMES]).not.toContain('context_timeline')
    // The legacy rollover name stays retired too.
    expect(tools.has('new_context')).toBe(false)
    expect([...AGENT_TEAM_TOOL_NAMES]).not.toContain('new_context')
  })

  it('rollover guidance names what a fresh generation already carries, and asks for the unverified delta', () => {
    const tools = contextTools()
    const description = tools.get('context_rollover')!.description
    // The engine's own sentence "seeded only by your handoff" is true of the
    // conversation history and false of the prompt context: identity, the
    // memory index, the skills catalog and the ledger arrive on their own. Team
    // supplies that counterweight as the engine's `carriedContext`, so the
    // description cannot be read as "restate everything" — our corpus showed
    // exactly that reading (44% restated standing state).
    expect(description).toContain('the same Team Member')
    expect(description).toContain('your @handle and role')
    expect(description).toContain('Team ledger')
    expect(description).toContain('Do not restate any of it')
    // The delta framing is the engine's; the checklist is Team's, and it keeps
    // the one item our own measurement found missing — only 10.5% of handoffs
    // said which facts were unverified, against 70% that named side effects.
    expect(description).toContain('could not reconstruct on its own')
    expect(description).toContain('which items you verified and which you only trusted')
    // Team's rule about what a non-selectable row prints travels through the
    // engine's text seam, not through a Team-authored render.
    expect(tools.get('context_status')!.description).toContain('is a short digest, never a ref')
  })

  it('hardens the checkpointRef copy against fabricated refs (the seq-7709 misuse)', () => {
    const tools = contextTools()
    const rollover = tools.get('context_rollover')!
    // The tool description and the parameter description both instruct the
    // model to omit checkpointRef for ordinary rollovers and to cite only
    // an exact ref a context_status result listed as restorable — never
    // a synthesized one. Dogfood showed "optional" alone does not stop a
    // model from inventing `team-boundary-...` refs.
    expect(rollover.description).toContain('never synthesize, guess, or reconstruct one')
    // defineTool compiles parameter specs to JSON Schema: descriptions live
    // under properties.<name>.description.
    const parameter = (rollover.parameters as { properties?: Record<string, { description?: string }> }).properties?.checkpointRef
    expect(parameter?.description).toContain('never synthesize or guess a ref')
    expect(parameter?.description).toContain('Omit for the default fresh rollover')
    // The status description keeps fresh rollovers on the direct path:
    // reading it is for checkpointRef returns, not a prerequisite for the
    // default fresh handoff.
    expect(tools.get('context_status')!.description).toContain('never requires reading this status first')
  })

  it('status description states the effect-anchor boundary vocabulary (91c2299 labels)', () => {
    const tools = contextTools()
    const status = tools.get('context_status')!.description
    // The description is the model's map from timeline row labels to their
    // meaning when picking a checkpointRef. It must enumerate the labels the
    // fold actually renders — the three effect classes and first arrival —
    // and must not promise the retired push-side vocabulary (the live
    // seq-8666 mis-selection showed an unmapped label invites wrong picks).
    expect(status).toContain('Team message')
    expect(status).toContain('Team task claim change')
    expect(status).toContain('Team attention change')
    expect(status).toContain('First arrival')
    expect(status).toContain('first delivered notice')
    expect(status).not.toContain('claim changes and structured Team notifications')
    // The selectable-anchor sentence names the current boundary concept.
    expect(status).toContain('A Team boundary is a selectable default')
    // The retired "delivery anchor" noun must not survive either: the
    // pre-59ae952 wording lives on in shipped sessions' prompts, so a
    // half-reverted description would still read as plausible prose.
    expect(status).not.toContain('delivery anchor')
  })

  it('context_compact states what changed, and says so when nothing was safe to replace', () => {
    const tools = contextTools()
    expect(tools.has('context_compact')).toBe(true)
    const compacted = renderText(tools.get('context_compact')!, {}, { status: 'compacted', replaced: 12, replacedTokens: 40000, usageTokens: 60000 })
    expect(compacted).toContain('replaced 12')
    expect(compacted).toContain('Recent work kept verbatim')
    expect(compacted).toContain('about 60000 tokens')
    // "Nothing safe to compact" and "this scope has no engine" are different
    // facts, and both must leave the context provably unchanged.
    const nothing = renderText(tools.get('context_compact')!, {}, { status: 'nothing', reason: 'the recent tail already keeps this whole context verbatim' })
    expect(nothing).toContain('Nothing safe to compact')
    expect(nothing).toContain('This context is unchanged')
    const unavailable = renderText(tools.get('context_compact')!, {}, { status: 'unavailable', reason: 'this agent scope mounts no compaction engine' })
    expect(unavailable).toContain('not available in this scope')
  })

  it('context_rollover renders the scheduled swap and keeps render text self-describing', () => {
    const tools = contextTools()
    const text = renderText(tools.get('context_rollover')!, {}, { mode: 'fresh', status: 'scheduled' })
    expect(text).toContain('rollover')
    expect(text).toContain('fresh')
    const seeded = renderText(tools.get('context_rollover')!, {}, { mode: 'from-checkpoint', status: 'scheduled' })
    expect(seeded).toContain('from-checkpoint')
  })
})
