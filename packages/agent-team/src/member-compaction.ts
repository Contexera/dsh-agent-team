import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, LlmError, type LlmCallConfig, type LlmResolvedModelInfo, type Message, type ToolSchema, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { renderPrompt, type PromptPresentation } from '@deepseek-ai/dsh-system-prompt'
import MemberCompactionEngine, { type MemberStepRoute } from './member-compaction-engine.ts'

export interface MemberCompactionConfig {
  readonly enabled: boolean
  readonly tokens: number
}

export const MEMBER_COMPACT_TOKENS = 256_000
const MEMBER_WINDOW_RATIO = 0.8
const MEMBER_CONTEXT_RESERVE = 16_384
const MEMBER_OUTPUT_RESERVE = 4_096
export const MEMBER_SUMMARY_TOKENS = 32_768

export const DEFAULT_MEMBER_COMPACTION: MemberCompactionConfig = Object.freeze({
  enabled: true,
  tokens: MEMBER_COMPACT_TOKENS,
})

export function memberCompactionThreshold(tokens: number, contextWindow: number | undefined): number | undefined {
  if (contextWindow === undefined) return tokens
  // Too small for the fixed reserves: the Agent's own limits apply instead.
  if (contextWindow < MEMBER_CONTEXT_RESERVE + MEMBER_OUTPUT_RESERVE) return undefined
  return Math.floor(Math.min(tokens, contextWindow * MEMBER_WINDOW_RATIO, contextWindow - MEMBER_CONTEXT_RESERVE))
}

export function memberOutputTokens(inputTokens: number, contextWindow: number, requestedTokens: number | undefined): number {
  const available = Math.floor(contextWindow - inputTokens - MEMBER_OUTPUT_RESERVE)
  if (available < 1) throw new Error('agent-team: context leaves no safe output space after compaction')
  return Math.min(requestedTokens ?? available, available)
}

export function measureMemberInput(ctx: Context, agent: Agent, config: LlmCallConfig, pending: readonly Message[], assembly?: PromptPresentation, stepTools?: readonly ToolSchema[]): number {
  const meter = ctx.get('tokenMeter')
  if (meter === undefined) throw new Error('agent-team: token meter unavailable')
  const header = agent.session.requestHeader()
  const measurement = meter.measure(agent.session, {
    ...header,
    config,
    // The header names the previous request's tools; a captured step replaces them with the set the next request will actually declare.
    ...(assembly !== undefined && stepTools !== undefined ? { tools: [...stepTools] } : {}),
  })
  let inputTokens = measurement.totalTokens + pending.reduce((sum, message) => sum + meter.estimateMessage(message), 0)
  if (assembly !== undefined) {
    const head = agent.session.surface.nodes[0]
    const event = head === undefined ? undefined : agent.session.eventAt(head)
    const previous = event?.type === 'system/message' ? meter.estimateMessage(event.data.message) : 0
    // renderPrompt reads sections and variables only; tool declarations left the waterfall, so the presentation carries none.
    inputTokens += Math.max(0, meter.estimateMessage(createSystemMessage(renderPrompt({ ...assembly, tools: [] }))) - previous)
  }
  return inputTokens
}

export function installMemberCompaction(
  ctx: Context,
  agent: Agent,
  config: () => MemberCompactionConfig,
  engineFor: () => CompactionEngine | undefined,
  retiring: () => boolean,
): void {
  let pending: readonly Message[] = []
  let claimed: readonly UserMessage[] = []
  let assembly: PromptPresentation | undefined
  let stepTools: readonly ToolSchema[] | undefined
  type OutputClamp = { readonly provider: string; readonly model: string; readonly applied: number; readonly requested: number | undefined }
  let loggedClamp: OutputClamp | undefined
  let preparedClamp: OutputClamp | undefined
  let stepRoute: MemberStepRoute | undefined

  const memberEngine = (): MemberCompactionEngine | undefined => {
    const engine = engineFor()
    return engine instanceof MemberCompactionEngine ? engine : undefined
  }
  const bindStepRoute = (route: MemberStepRoute | undefined): void => {
    stepRoute = route
    memberEngine()?.useStepRoute(route)
  }

  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'step/end') {
      bindStepRoute(undefined)
      return
    }
    if (event.type !== 'request/header') return
    const actual = event.data.header.config
    // An adapter may clamp further; adopt what it logged to restore the original.
    loggedClamp = preparedClamp !== undefined && actual.provider === preparedClamp.provider
      && actual.model === preparedClamp.model && actual.maxTokens !== undefined
      ? { ...preparedClamp, applied: actual.maxTokens } : undefined
  })
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    assembly = await next()
    // 0.2.2 moved tool declarations out of the waterfall: the step's admitted set arrives on the context, and `schemas` projects it the way the request's own provider does.
    stepTools = context.toolSet === undefined ? undefined : ctx.tools.schemas(context.scope, context.toolSet)
    return assembly
  }, { prepend: true })
  ctx.on('agent/pre-step', async (payload, next) => {
    // The step's route is frozen before this waterfall; a hook may only adjust
    // controls, so the same route must reach every summary.
    bindStepRoute({ step: payload.step, provider: payload.modelSelection.provider, model: payload.modelSelection.model })
    let decision
    try {
      decision = await next()
    } catch (error) {
      bindStepRoute(undefined)
      throw error
    }
    if (decision.kind !== 'enter') bindStepRoute(undefined)
    pending = decision.kind === 'enter' ? decision.messages : []
    claimed = decision.kind === 'enter' ? payload.messages : []
    return decision
  }, { prepend: true })

  const prepareBudget = async (proposed: LlmCallConfig, offered: readonly Message[], signal: AbortSignal): Promise<LlmCallConfig> => {
    signal.throwIfAborted()
    if (retiring()) throw new Error('agent-team: cannot prepare a request for a retiring Member')
    const request = { ...proposed }
    if (loggedClamp !== undefined && request.maxTokens === loggedClamp.applied) {
      if (loggedClamp.requested === undefined) delete request.maxTokens
      else request.maxTokens = loggedClamp.requested
    }
    preparedClamp = undefined
    const step = stepRoute
    // One frozen selection: a hook rewriting the request makes the target a guess.
    if (step !== undefined && (step.provider !== request.provider || step.model !== request.model)) {
      throw new Error(`agent-team: the step's fixed route ${step.provider}/${step.model} disagrees with this request's ${request.provider}/${request.model}; refusing to summarize before the route contract is restored`)
    }
    const settings = config()
    if (!settings.enabled) return request
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('agent-team: LLM runtime unavailable')
    let info: LlmResolvedModelInfo | undefined
    try {
      info = await llm.resolveModelInfo(request.provider, request.model, signal)
    } catch (error) {
      if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
    }
    signal.throwIfAborted()
    const window = info?.context?.contextWindow
    const threshold = memberCompactionThreshold(settings.tokens, window)
    // No room to act: the Agent's own upstream limits still apply.
    if (threshold === undefined) return request
    const measure = (): number => measureMemberInput(ctx, agent, request, offered, assembly, stepTools)
    let inputTokens = measure()
    if (inputTokens >= threshold) {
      const engine = engineFor()
      if (engine === undefined) throw new Error('agent-team: Member reached its context budget without a compaction engine')
      const member = memberEngine()
      // No checkpoint this request; the clamp below still refuses an unholdable window.
      let passedThrough = member !== undefined && member.degraded(agent, request)
      if (passedThrough) {
        ctx.logger.warn(`agent-team: ${request.provider}/${request.model} summarized nothing after a bounded attempt; passing this request through without a checkpoint (${inputTokens} tokens) until its route or summary configuration changes`)
      } else {
        const prune = (ctx.get('agentPresets')?.serviceFor(agent, 'toolResultPruner') as ToolResultPruner | undefined)
          ?? ctx.get('toolResultPruner')
        if (prune !== undefined) {
          try {
            prune.pruneSession(agent.session)
            inputTokens = measure()
          } catch {
            // Pruning is an optional saving: its failure must not cost the step.
          }
        }
        if (inputTokens >= threshold) {
          try {
            await engine.compactIfNeeded(agent, 'context-overflow', signal)
          } catch (error) {
            signal.throwIfAborted()
            if (member === undefined || !member.takeSummaryFailure(agent)) throw error
            // Bounded: the engine tried the step's route and one alternative.
            passedThrough = true
            ctx.logger.warn(`agent-team: summarization failed for ${request.provider}/${request.model} (${error instanceof Error ? error.message : String(error)}); passing this request through without a checkpoint and stopping further attempts for this route`)
          }
          signal.throwIfAborted()
          inputTokens = measure()
        }
      }
      if (!passedThrough && inputTokens >= threshold) {
        throw new Error(`agent-team: context still exceeds the Member budget after compaction (${inputTokens} >= ${threshold}); shorten the input or increase memberCompaction.tokens`)
      }
    }
    if (window === undefined) return request
    const requested = request.maxTokens ?? info?.defaultMaxTokens
    const outputTokens = memberOutputTokens(inputTokens, window, requested)
    if (requested === undefined || outputTokens < requested) {
      preparedClamp = { provider: request.provider, model: request.model, applied: outputTokens, requested: request.maxTokens }
      return { ...request, maxTokens: outputTokens }
    }
    return request
  }

  ctx.on('agent/request', async ({ signal }, next) => {
    const proposed = await next()
    const offered = pending
    const claimedNow = claimed
    pending = []
    claimed = []
    try {
      return await prepareBudget(proposed, offered, signal)
    } catch (error) {
      // A cancel or dispose owns its own inbox semantics; never resurrect input.
      if (!signal.aborted && !retiring() && claimedNow.length > 0) {
        agent.inbox.splice('next-turn', 0, 0, [...claimedNow])
      }
      throw error
    }
  }, { prepend: true })
}
