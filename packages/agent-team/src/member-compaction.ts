import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CONTEXT_WINDOW_EXCEEDED_CODE, createSystemMessage, LlmError, type LlmCallConfig, type LlmFailure, type LlmResolvedModelInfo, type Message, type ToolSchema, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type EpochHeader } from '@deepseek-ai/dsh-session'
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { renderPrompt, type PromptPresentation } from '@deepseek-ai/dsh-system-prompt'
import MemberCompactionEngine, { type MemberStepRoute } from './member-compaction-engine.ts'

export interface MemberCompactionConfig {
  readonly enabled: boolean
  readonly tokens: number
}

export const MEMBER_COMPACT_TOKENS = 256_000
/** Consecutive provider-overflow refusals while the route's summaries are paused that the Host escalates to the operator. */
export const MEMBER_UNREACHABLE_OVERFLOW_LIMIT = 3
const MEMBER_WINDOW_RATIO = 0.8
const MEMBER_CONTEXT_RESERVE = 16_384
const MEMBER_OUTPUT_RESERVE = 4_096
export const MEMBER_SUMMARY_TOKENS = 32_768
/** Conservative price of the instruction the shipped summarizer appends after the replayed region. */
export const MEMBER_SUMMARY_INSTRUCTION_TOKENS = 2_048

export const DEFAULT_MEMBER_COMPACTION: MemberCompactionConfig = Object.freeze({
  enabled: true,
  tokens: MEMBER_COMPACT_TOKENS,
})

export function memberCompactionThreshold(tokens: number, contextWindow: number | undefined): number | undefined {
  if (contextWindow === undefined) return tokens
  if (contextWindow < MEMBER_CONTEXT_RESERVE + MEMBER_OUTPUT_RESERVE) return undefined
  return Math.floor(Math.min(tokens, contextWindow * MEMBER_WINDOW_RATIO, contextWindow - MEMBER_CONTEXT_RESERVE))
}

export function memberOutputTokens(inputTokens: number, contextWindow: number, requestedTokens: number | undefined): number {
  const available = Math.floor(contextWindow - inputTokens - MEMBER_OUTPUT_RESERVE)
  if (available < 1) throw new Error('agent-team: context leaves no safe output space after compaction')
  return Math.min(requestedTokens ?? available, available)
}

/**
 * The header the newest provider count belongs to: the `request/header` in force
 * when the last usage-bearing `assistant/message` settled. A failed, aborted, or
 * still-streaming attempt logs a header and no usage, so the latest header is
 * not necessarily that one.
 */
function anchorHeaderOf(session: Agent['session']): EpochHeader | undefined {
  let settled = false
  for (let seq = Number(session.seq) - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) continue
    if (!settled) {
      if (event.type === 'assistant/message' && event.data.usage !== undefined) settled = true
      continue
    }
    if (event.type === 'request/header') return event.data.header
  }
  return undefined
}

export function measureMemberInput(ctx: Context, agent: Agent, config: LlmCallConfig, pending: readonly Message[], assembly?: PromptPresentation, stepTools?: readonly ToolSchema[]): number {
  const meter = ctx.get('tokenMeter')
  if (meter === undefined) throw new Error('agent-team: token meter unavailable')
  const header = agent.session.requestHeader()
  // The header names the previous request's tools; a captured step replaces them with the set the next request will actually declare.
  const stepHeader: EpochHeader | undefined = header !== undefined && assembly !== undefined && stepTools !== undefined
    ? { ...header, tools: [...stepTools] }
    : header
  // Clamp changes spoil a header match, so price the settled request under its original header.
  const anchor = anchorHeaderOf(agent.session)
  const comparable = anchor !== undefined
    && anchor.config.provider === config.provider && anchor.config.model === config.model
  const anchored = comparable ? meter.measure(agent.session, anchor) : undefined
  // Never discount a provider count for tools that are no longer declared.
  const measurement = anchored !== undefined && anchored.baseline?.kind === 'usage'
    ? { totalTokens: anchored.totalTokens + Math.max(0, estimateToolsTokens(stepHeader) - estimateToolsTokens(anchor)) }
    : meter.measure(agent.session, {
      ...header,
      config,
      ...(assembly !== undefined && stepTools !== undefined ? { tools: [...stepTools] } : {}),
    })
  let inputTokens = measurement.totalTokens + pending.reduce((sum, message) => sum + meter.estimateMessage(message), 0)
  if (assembly !== undefined) {
    const head = agent.session.surface.nodes[0]
    const event = head === undefined ? undefined : agent.session.eventAt(head)
    const previous = event?.type === 'system/message' ? meter.estimateMessage(event.data.message) : 0
    inputTokens += Math.max(0, meter.estimateMessage(createSystemMessage(renderPrompt({ ...assembly, tools: [] }))) - previous)
  }
  return inputTokens
}

/** How the Host learns an unreachable-compaction episode opened or closed; `clear` is idempotent. */
export interface MemberUnreachableCompaction {
  readonly escalate: (failure: LlmFailure) => void
  readonly clear: () => void
}

interface OutputClamp {
  readonly provider: string
  readonly model: string
  readonly applied: number
  readonly requested: number | undefined
}

async function requestModelInfo(ctx: Context, request: LlmCallConfig, signal: AbortSignal): Promise<LlmResolvedModelInfo | undefined> {
  const llm = ctx.get('llm')
  if (llm === undefined) throw new Error('agent-team: LLM runtime unavailable')
  try {
    return await llm.resolveModelInfo(request.provider, request.model, signal)
  } catch (error) {
    // Middleware can serve a virtual route that has no adapter in the directory.
    if (!(error instanceof LlmError) || error.code !== 'NO_ADAPTER') throw error
    return undefined
  }
}

function pruneMemberInput(ctx: Context, agent: Agent, measure: () => number, measured: number): number {
  const prune = (ctx.get('agentPresets')?.serviceFor(agent, 'toolResultPruner') as ToolResultPruner | undefined)
    ?? ctx.get('toolResultPruner')
  if (prune === undefined) return measured
  try {
    prune.pruneSession(agent.session)
    return measure()
  } catch {
    // A failed best-effort prune still leaves the summary path available.
    return measured
  }
}

async function compactMemberInput({
  ctx, agent, request, signal, engineFor, threshold, measure, measured,
}: {
  readonly ctx: Context
  readonly agent: Agent
  readonly request: LlmCallConfig
  readonly signal: AbortSignal
  readonly engineFor: () => CompactionEngine | undefined
  readonly threshold: number
  readonly measure: () => number
  readonly measured: number
}): Promise<number> {
  const engine = engineFor()
  if (engine === undefined) throw new Error('agent-team: Member reached its context budget without a compaction engine')
  const member = memberEngineFor(engineFor)
  // A paused summary route still has to pass the request's output-space check.
  if (member !== undefined && member.degraded(agent, request)) {
    ctx.logger.warn(`agent-team: ${request.provider}/${request.model} summarized nothing after a bounded attempt; passing this request through without a checkpoint (${measured} tokens) until its route or summary configuration changes`)
    return measured
  }

  let inputTokens = pruneMemberInput(ctx, agent, measure, measured)
  if (!(inputTokens >= threshold)) return inputTokens
  let summaryFailed = false
  try {
    await engine.compactIfNeeded(agent, 'context-overflow', signal)
  } catch (error) {
    signal.throwIfAborted()
    if (member === undefined || !member.takeSummaryFailure(agent)) throw error
    summaryFailed = true
    ctx.logger.warn(`agent-team: summarization failed for ${request.provider}/${request.model} (${error instanceof Error ? error.message : String(error)}); passing this request through without a checkpoint and stopping further attempts for this route`)
  }
  signal.throwIfAborted()
  inputTokens = measure()
  if (!summaryFailed && inputTokens >= threshold) {
    throw new Error(`agent-team: context still exceeds the Member budget after compaction (${inputTokens} >= ${threshold}); shorten the input or increase memberCompaction.tokens`)
  }
  return inputTokens
}

function memberEngineFor(engineFor: () => CompactionEngine | undefined): MemberCompactionEngine | undefined {
  // Structural, not instanceof: a preset isolate loads the engine module with
  // its own identity, so the shipped composition fails a class test while the
  // object is still the Member engine.
  const engine = engineFor() as MemberCompactionEngine | undefined
  return engine !== undefined && typeof engine.degraded === 'function' ? engine : undefined
}

export function installMemberCompaction(
  ctx: Context,
  agent: Agent,
  config: () => MemberCompactionConfig,
  engineFor: () => CompactionEngine | undefined,
  retiring: () => boolean,
  unreachableCompaction?: MemberUnreachableCompaction,
): void {
  let pending: readonly Message[] = []
  let claimed: readonly UserMessage[] = []
  let assembly: PromptPresentation | undefined
  let stepTools: readonly ToolSchema[] | undefined
  let loggedClamp: OutputClamp | undefined
  let preparedClamp: OutputClamp | undefined
  let stepRoute: MemberStepRoute | undefined
  // `stepRoute` clears at every step end, so it cannot witness a route change:
  // the last route a step actually bound survives across steps for the compare.
  let lastBoundStepRoute: MemberStepRoute | undefined
  /** Provider overflows in a row while the route's summaries are paused, and whether the operator was already told. */
  const unreachable = { overflows: 0, reported: false }

  const bindStepRoute = (route: MemberStepRoute | undefined): void => {
    stepRoute = route
    memberEngineFor(engineFor)?.useStepRoute(agent, route)
    if (route === undefined) return
    // The step's route changing is the same moment the circuit forgets a paused
    // route: an escalation pinned to it no longer names this generation.
    if (lastBoundStepRoute !== undefined
      && (lastBoundStepRoute.provider !== route.provider || lastBoundStepRoute.model !== route.model)) {
      unreachable.overflows = 0
      unreachable.reported = false
      unreachableCompaction?.clear()
    }
    lastBoundStepRoute = route
  }

  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'step/end') {
      bindStepRoute(undefined)
      return
    }
    // A response that landed proves the route still fits; the unreachable-overflow
    // count tracks only the sequence since the last one, and a settled reply also
    // retires an open escalation so the Member does not stay in error after the
    // outage that caused it ended.
    if (event.type === 'assistant/message') {
      unreachable.overflows = 0
      if (unreachable.reported) unreachableCompaction?.clear()
      unreachable.reported = false
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
    // Price the admitted tool set through the same schema projection as the request.
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
    const info = await requestModelInfo(ctx, request, signal)
    signal.throwIfAborted()
    const window = info?.context?.contextWindow
    const threshold = memberCompactionThreshold(settings.tokens, window)
    // Windows smaller than the reserves stay under the Agent's upstream policy.
    if (threshold === undefined) return request
    const measure = (): number => measureMemberInput(ctx, agent, request, offered, assembly, stepTools)
    const measured = measure()
    const inputTokens = measured >= threshold
      ? await compactMemberInput({ ctx, agent, request, signal, engineFor, threshold, measure, measured }) : measured
    if (window === undefined) return request
    const requested = request.maxTokens ?? info?.defaultMaxTokens
    const outputTokens = memberOutputTokens(inputTokens, window, requested)
    if (requested === undefined || outputTokens < requested) {
      preparedClamp = { provider: request.provider, model: request.model, applied: outputTokens, requested: request.maxTokens }
      return { ...request, maxTokens: outputTokens }
    }
    return request
  }

  // Count provider overflows on a route whose summaries are paused: each real
  // 413 is proof the dead zone is not self-healing, and the third in a row hands
  // the Member to the operator instead of spending turns on retries that cannot
  // write a checkpoint. A route the circuit no longer names — a switch, a cleared
  // failure — starts over, matching the circuit's own reset. This observes only;
  // the waterfall's action stays with the compaction engine.
  ctx.on('agent/request-error', ({ failure }, next) => {
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()
    const route = agent.session.requestHeader()?.config
    const member = memberEngineFor(engineFor)
    if (route === undefined || member === undefined || !member.degraded(agent, route)) {
      unreachable.overflows = 0
      unreachable.reported = false
      return next()
    }
    unreachable.overflows += 1
    if (unreachable.overflows >= MEMBER_UNREACHABLE_OVERFLOW_LIMIT && !unreachable.reported) {
      unreachable.reported = true
      unreachableCompaction?.escalate(failure)
    }
    return next()
  })

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
