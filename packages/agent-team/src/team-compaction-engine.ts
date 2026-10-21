/**
 * The Team's checkpoint template, replacing the backend's general coding-session one.
 * Measured over the 133 real compactions one deployment accumulated by 2026-10-05:
 * the stock template spent 30% of every summary restating files and code and 2% on
 * the next step, and dropped who was waiting on the subject in 41% of them. Files
 * can be read back and an obligation cannot, so sections are ordered by what a
 * successor cannot reconstruct. `summarize()` re-issues the call because the base
 * appends its own directive last, and a model follows the last one.
 * @module @contexera/dsh-agent-team/team-compaction-engine
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, LlmCallConfig, Message, RequestMessage, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'

export const TEAM_COMPACTION_TEMPLATE = [
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

export interface TeamSummarizationInput {
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

export interface TeamSummaryResult {
  readonly summary: ContentBlock[]
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
  readonly usage?: TokenUsage
  readonly rawOutput: ContentBlock[]
  readonly llmStreamCall: true
}

export class TeamCompactionEngine extends BasicCompactionEngine {
  protected override async summarize(
    input: TeamSummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<TeamSummaryResult> {
    const target = summarizationTarget(this.config, agent)
    const maxTokens = this.config.modelPolicies
      .find(policy => policy.provider === target.provider && policy.model === target.model)
      ?.maxTokens ?? this.config.maxTokens
    const assembler = new BlockAssembler()
    const messages: RequestMessage[] = [
      ...input.messages,
      { role: 'user', content: [{ type: 'text', text: TEAM_COMPACTION_TEMPLATE }] },
    ]
    const options: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...input.tools === undefined ? {} : { tools: [...input.tools] },
      maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const failure = finishError(assembler.finish)
    if (failure !== undefined) throw failure
    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    if (!summary.some(block => block.text.trim().length > 0)) {
      throw new Error('summarization produced no text summary content')
    }
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }
}

function summarizationTarget(
  config: ResolvedConfig,
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> {
  if (config.summarizationProvider.length > 0) {
    return { provider: config.summarizationProvider, model: config.summarizationModel }
  }
  const routed = agent.session.requestHeader()?.config
  if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) return routed
  const { provider, model } = agent.options
  if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
    return { provider, model }
  }
  throw new Error(
    'no provider/model available for summarization: set both BasicCompactionConfig summarization fields, '
    + 'route one request, or set both AgentOptions fields',
  )
}

function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted':
      return new LlmError(finish.failure.message, finish.failure.code, finish.failure)
    case 'max-tokens': {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

function summaryText(blocks: readonly ContentBlock[]): Array<Extract<ContentBlock, { type: 'text' }>> {
  if (contentHasImage(blocks)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
}

export default TeamCompactionEngine
