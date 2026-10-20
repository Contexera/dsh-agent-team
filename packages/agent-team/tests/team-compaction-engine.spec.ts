import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { resolveCompactSpec, resolveConfig, resolveTargetPolicy } from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { createUserMessage, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import TeamCompactionEngine, { TEAM_COMPACTION_TEMPLATE } from '../src/team-compaction-engine.ts'
import type { TeamSummarizationInput } from '../src/team-compaction-engine.ts'

/**
 * The measured seven-section template, frozen as the expected text: the
 * wording is a contract with every summary already written under it, so a
 * silent reword changes what a successor generation reads back.
 */
const EXPECTED_TEMPLATE = [
  'You are now acting as a compaction engine for this agent. Condense the conversation ABOVE into a structured checkpoint that lets another generation of the same agent resume the work with nothing essential lost.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  'Budget rule: spend your length on what a successor CANNOT recover by itself. Files, code and command output can be read again at any time — name them and say why they matter, do not reproduce them. Decisions, obligations, and the reasons behind a choice exist nowhere but this conversation; lose them and they are gone.',
  '',
  '## Objective and Current Action',
  "- [the goal in the requester's own words, quoted verbatim where exact wording matters, plus corrections that changed it]",
  '- [the single action in flight at this checkpoint, precisely enough to resume mid-step]',
  '',
  '## Established Facts',
  '- [each durable finding this work produced, with its evidence]',
  '- [MARK EACH as verified (checked first-hand here — say how) or as trusted (reported by someone else, relayed, or assumed) — never leave the distinction implicit]',
  '',
  '## Open Loops and Obligations',
  '- [what this agent owes another participant: a reply, a review, a handoff, a decision — name the participant and what they are waiting for]',
  '- [what this agent is itself waiting on, and from whom]',
  '- [explicitly requested work not yet done]',
  '',
  '## Decisions and Constraints',
  '- [decision: the reasoning behind it, and what would have to change to revisit it]',
  '- [standing instructions, preferences and prohibitions stated by the requester]',
  '- [unresolved disagreements or contradictions, stated as such rather than silently resolved]',
  '',
  '## External Side Effects',
  '- [every change already made outside this conversation — files written, commands run, commits, pushes, running jobs, remote calls — and whether each was verified to have taken effect]',
  '',
  '## Working Material',
  '- [exact paths, identifiers, refs, commands, signatures and numeric values needed to continue: name them, do not reproduce their contents]',
  '- [errors encountered and how each was resolved, or that it is still open]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, concrete enough to start without re-deriving it, or "(none)"]',
  '',
  'Rules:',
  '- Write concise engineering prose. Preserve exact paths, commands, error strings, identifiers, refs, numeric values and signatures verbatim.',
  '- Capture instructions and feedback from the requester faithfully, especially corrections and anything they explicitly refused.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a prior checkpoint block, do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n')

const root = resolve(import.meta.dirname, '../../..')
const MODEL = 'team-model'
const SIGNAL = new AbortController().signal

class CannedAdapter extends LlmAdapter {
  lastOptions: GenerateOptions | undefined

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider, id: model, name: model, context: { contextWindow: 1_000_000 },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    const block: ContentBlock = { type: 'text', text: 'checkpoint' }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: block.text }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ExposedEngine extends TeamCompactionEngine {
  runSummarize(input: TeamSummarizationInput, signal?: AbortSignal) {
    return this['summarize'](input, {
      session: Session.create(SessionId('summarize-probe')),
      options: { provider: MODEL, model: MODEL },
    } as never, signal)
  }
}

async function context(adapter: CannedAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], adapter)
  return ctx
}

describe('Team compaction engine', () => {
  it('sends the Team template as the final instruction, byte for byte', async () => {
    const adapter = new CannedAdapter()
    const engine = new ExposedEngine(await context(adapter), { auto: false })
    const prefix = createUserMessage({ content: [{ type: 'text', text: 'earlier work' }], source: { kind: 'user' } })
    await engine.runSummarize({ messages: [prefix] }, SIGNAL)

    const messages = adapter.lastOptions?.messages ?? []
    expect(messages.slice(0, -1)).toEqual([prefix])
    const instruction = messages.at(-1)
    expect(instruction).toMatchObject({ role: 'user' })
    expect(instruction?.content[0]).toEqual({ type: 'text', text: TEAM_COMPACTION_TEMPLATE })
    // The wording is the measured template, frozen so a summary written under
    // an earlier owner still asks for the same seven sections.
    expect(TEAM_COMPACTION_TEMPLATE).toBe(EXPECTED_TEMPLATE)
    for (const section of [
      '## Objective and Current Action',
      '## Established Facts',
      '## Open Loops and Obligations',
      '## Decisions and Constraints',
      '## External Side Effects',
      '## Working Material',
      '## Next Step',
    ]) expect(TEAM_COMPACTION_TEMPLATE).toContain(section)
    expect(adapter.lastOptions).toMatchObject({ purpose: 'compaction', maxTokens: 65_536 })
  })

  it('carries the preset row thresholds onto each routed family', () => {
    const row = compactionRow()
    // The Loader validates a row against its plugin's Config before mounting,
    // so the shipped text has to be a legal engine config on its own.
    const resolved = resolveConfig(TeamCompactionEngine.Config(row.config))
    // `auto` is the engine default: dropping the old explicit false is what
    // turns automatic compaction on for every Member.
    expect(resolved.auto).toBe(true)
    expect(resolved.thresholdRatio).toBe(0.256)
    expect(resolved.retainRatio).toBe(0.08)
    expect(resolved.headroomTokens).toBe(65_536)

    // (contextWindow, reserved output, expected trigger) per family, priced by
    // the engine's own formula rather than restated here.
    const spec = (provider: string, model: string, window: number, output: number): number =>
      resolveCompactSpec(resolveTargetPolicy(resolved, { provider, model }), window, output).thresholdTokens
    // 0.2441 and 0.2779 are roundings of the same waterline, so each family
    // lands within a thousand tokens of it instead of exactly on it.
    const nearWaterline = (tokens: number): void => expect(Math.abs(tokens - 256_000)).toBeLessThan(1_000)
    nearWaterline(spec('magpie', 'auto/deepseek-v4.1-flash', 1_000_000, 128_000))
    expect(spec('magpie', 'auto/deepseek-v4.1-flash', 1_000_000, 128_000)).toBe(256_000)
    nearWaterline(spec('opencode-go-flash', 'deepseek-v4.1-flash', 1_000_000, 384_000))
    nearWaterline(spec('magpie', 'auto/gpt-6.1-sol', 922_000, 128_000))
    nearWaterline(spec('magpie', 'volcengine/deepseek-v4.1-flash', 1_048_576, 384_000))
    nearWaterline(spec('magpie', 'group/kimi', 1_048_576, 131_072))
    nearWaterline(spec('magpie', 'auto/glm-5.3', 1_000_000, 131_072))

    // Capacity-capped families claim the earliest trigger their reserved output
    // and headroom allow: 272,000 - 128,000 - 65,536 and 200,000 - 32,000 - 65,536.
    expect(spec('openai', 'gpt-6.1-sol', 272_000, 128_000)).toBe(78_464)
    expect(spec('magpie', 'opencode-zen-free/deepseek-v4.1-flash-free', 200_000, 32_000)).toBe(102_000)
  })

  it('inherits the global ratio on a route the preset does not name', () => {
    const resolved = resolveConfig(compactionRow().config)
    // A model id alone is not a match: `modelPolicies` compares provider and
    // model exactly, so a route under another provider keeps the 1M default.
    expect(resolveTargetPolicy(resolved, { provider: 'unlisted', model: 'group/kimi' }).thresholdRatio).toBe(0.256)
    expect(resolveConfig({}).thresholdRatio).toBe(0.8)
    expect(TeamCompactionEngine.prototype).not.toBe(BasicCompactionEngine.prototype)
  })
})

/** The preset's compaction-basic row, read through the same patch loader the Host boots with. */
function compactionRow(): { name?: string; config: Record<string, unknown> } {
  const row = entries()
    .find(entry => entry.id === 'compaction-basic')
  expect(row?.name).toBe('@contexera/dsh-agent-team/team-compaction-engine')
  return row as { config: Record<string, unknown> }
}

/** Every loader entry in the preset tree, including rows nested in groups and preset plugin lists. */
function entries(): Array<{ id?: string; name?: string; config?: unknown }> {
  const found: Array<{ id?: string; name?: string; config?: unknown }> = []
  const visit = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return
    found.push(entry)
    for (const value of Object.values(entry)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value !== null && typeof value === 'object') visit(value)
    }
  }
  loadOverlayPatches('team-compaction-engine spec', resolve(root, 'cordis.patch.yml')).forEach(visit)
  return found
}
