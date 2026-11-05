import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, LlmError, type LlmCallConfig, type LlmResolvedModelInfo, type Message, type ToolSchema, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { renderPrompt, type PromptPresentation } from '@deepseek-ai/dsh-system-prompt'

export interface MemberCompactionConfig {
  readonly enabled: boolean
  readonly tokens: number
}

export const MEMBER_COMPACT_TOKENS = 256_000
const MEMBER_WINDOW_RATIO = 0.8
const MEMBER_CONTEXT_RESERVE = 16_384
const MEMBER_OUTPUT_RESERVE = 4_096
export const MEMBER_SUMMARY_TOKENS = 16_384

export const DEFAULT_MEMBER_COMPACTION: MemberCompactionConfig = Object.freeze({
  enabled: true,
  tokens: MEMBER_COMPACT_TOKENS,
})

export function memberCompactionThreshold(tokens: number, contextWindow: number | undefined): number | undefined {
  if (contextWindow === undefined) return tokens
  // A window this small cannot hold the fixed context reserve plus a minimal
  // output allowance: the trigger would fire on every request while no request
  // could fit, so the route is left to the Agent's own limits instead.
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

  ctx.on('session/event', (session, event) => {
    if (session !== agent.session || event.type !== 'request/header') return
    const actual = event.data.header.config
    // An adapter may clamp further than the prepared value; adopt whatever was
    // logged so the next request can still restore the original allowance.
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
    const decision = await next()
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
    // A window that cannot hold the fixed reserve leaves this policy no room to
    // act; the Agent's own upstream limits still apply to the request.
    if (threshold === undefined) return request
    const measure = (): number => measureMemberInput(ctx, agent, request, offered, assembly, stepTools)
    let inputTokens = measure()
    if (inputTokens >= threshold) {
      const engine = engineFor()
      if (engine === undefined) throw new Error('agent-team: Member reached its context budget without a compaction engine')
      const prune = (ctx.get('agentPresets')?.serviceFor(agent, 'toolResultPruner') as ToolResultPruner | undefined)
        ?? ctx.get('toolResultPruner')
      if (prune !== undefined) {
        try {
          prune.pruneSession(agent.session)
          inputTokens = measure()
        } catch {
          // Pruning is an optional saving, not a prerequisite: a failure must not
          // cost the step when the engine can still reduce the context itself.
        }
      }
      if (inputTokens >= threshold) {
        await engine.compactIfNeeded(agent, 'context-overflow', signal)
        signal.throwIfAborted()
        inputTokens = measure()
      }
      if (inputTokens >= threshold) {
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
      // Restore only when this policy refused the step; a cancel or dispose owns
      // its own inbox semantics and must not have input resurrected.
      if (!signal.aborted && !retiring() && claimedNow.length > 0) {
        agent.inbox.splice('next-turn', 0, 0, [...claimedNow])
      }
      throw error
    }
  }, { prepend: true })
}
