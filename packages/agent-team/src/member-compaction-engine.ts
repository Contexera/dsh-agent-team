import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'
import type {} from './index.ts'

/** One provider/model route a summarization call can go to. */
export interface MemberSummaryRoute {
  readonly provider: string
  readonly model: string
}

/** The step's fixed route, captured from `agent/pre-step`. */
export interface MemberStepRoute extends MemberSummaryRoute {
  readonly step: number
}

type SummaryInput = {
  readonly messages: readonly Message[]
  readonly tools?: readonly ToolSchema[]
}

type SummaryDecision =
  | { readonly kind: 'committed' }
  | { readonly kind: 'route'; readonly route: MemberSummaryRoute }

export default class MemberCompactionEngine extends BasicCompactionEngine {
  private stepRoute: MemberStepRoute | undefined
  private alternativeSpent = false
  private readonly manualAgents = new WeakSet<Agent>()
  private readonly summaryFailures = new WeakSet<Agent>()
  private readonly degradedRoutes = new WeakMap<Agent, MemberSummaryRoute>()

  override compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null> {
    if (trigger === 'pressure' && this.ctx.get('agentTeam')?.config.memberCompaction.get().enabled === true) {
      return Promise.resolve(null)
    }
    return super.compactIfNeeded(agent, trigger, signal)
  }

  /** Bind the step's fixed route, or clear it at that step's end. */
  useStepRoute(route: MemberStepRoute | undefined): void {
    this.stepRoute = route
    if (route !== undefined) this.alternativeSpent = false
  }

  /** Whether a bounded failure opened the circuit for this route. */
  degraded(agent: Agent, route: MemberSummaryRoute): boolean {
    const recorded = this.degradedRoutes.get(agent)
    return recorded !== undefined && recorded.provider === route.provider && recorded.model === route.model
  }

  /** Whether the last automatic attempt failed for a reason other than cancellation. */
  takeSummaryFailure(agent: Agent): boolean {
    const failed = this.summaryFailures.has(agent)
    if (failed) this.summaryFailures.delete(agent)
    return failed
  }

  override async compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null> {
    // An explicit request from the Human is how the circuit is cleared, so it
    // always gets its attempt.
    this.manualAgents.add(agent)
    try {
      const result = await super.compactNow(agent, signal, sourceCommandId)
      if (result !== null) this.degradedRoutes.delete(agent)
      return result
    } finally {
      this.manualAgents.delete(agent)
    }
  }

  protected override async summarize(
    input: SummaryInput,
    agent: Agent,
    signal?: AbortSignal,
  ) {
    const decision = await this.summaryDecision(agent, input, signal)
    const route = decision.kind === 'route' ? decision.route : agent.session.requestHeader()?.config
    // A route that already cost its summaries is not called again; /compact is the way out.
    if (!this.manualAgents.has(agent) && route !== undefined && this.degraded(agent, route)) {
      throw new Error(`agent-team: summarization is paused for ${route.provider}/${route.model} after a bounded failure`)
    }
    try {
      return await this.attemptSummary(input, agent, decision, signal)
    } catch (error) {
      // Cancellation opens nothing.
      if (signal?.aborted === true) throw error
      if (decision.kind !== 'route' || this.alternativeSpent) {
        this.recordFailure(agent, route)
        throw error
      }
      // One further route, once per step: no rotation, no second alternative.
      this.alternativeSpent = true
      if (route !== undefined) this.degradedRoutes.delete(agent)
      try {
        return await super.summarize(input, agent, signal)
      } catch (alternativeError) {
        this.recordFailure(agent, route)
        throw alternativeError
      }
    }
  }

  private attemptSummary(input: SummaryInput, agent: Agent, decision: SummaryDecision, signal?: AbortSignal) {
    return decision.kind === 'route'
      ? super.summarize(input, this.routedView(agent, decision.route), signal)
      : super.summarize(input, agent, signal)
  }

  private recordFailure(agent: Agent, route: MemberSummaryRoute | undefined): void {
    if (route === undefined) return
    this.summaryFailures.add(agent)
    this.degradedRoutes.set(agent, { provider: route.provider, model: route.model })
  }

  private async summaryDecision(agent: Agent, input: SummaryInput, signal?: AbortSignal): Promise<SummaryDecision> {
    const committed = agent.session.requestHeader()?.config
    const step = this.stepRoute
    if (committed === undefined || step === undefined) return { kind: 'committed' }
    const stepRoute = { provider: step.provider, model: step.model }
    // The shipped resolution for the committed route already reaches a global
    // target and one configured for that route, so only a target configured for
    // the step's own route needs the routed view.
    if (this.config.summarizationProvider !== '' || this.explicitSummaryTarget(committed)) return { kind: 'committed' }
    if (stepRoute.provider === committed.provider && stepRoute.model === committed.model) return { kind: 'committed' }
    // A target on the step's policy needs no branch: the routed view resolves it, and
    // precedence here would be dead — the shipped switch check runs first.
    if (!await this.canHoldSummary(agent, input, stepRoute, signal)) return { kind: 'committed' }
    return { kind: 'route', route: stepRoute }
  }

  /** Whether `route` can hold this call's input plus its cap; equality refuses, and the call's own input is priced rather than the surface. */
  async canHoldSummary(agent: Agent, input: { readonly messages: readonly Message[] }, route: MemberSummaryRoute, signal?: AbortSignal): Promise<boolean> {
    const llm = this.ctx.get('llm')
    const meter = this.ctx.get('tokenMeter')
    if (llm === undefined || meter === undefined) return false
    let window: number | undefined
    try {
      window = (await llm.resolveModelInfo(route.provider, route.model, signal)).context?.contextWindow
    } catch {
      return false
    }
    if (window === undefined) return false
    const transcript = input.messages.reduce((sum, message) => sum + meter.estimateMessage(message), 0)
    return transcript + estimateToolsTokens(agent.session.requestHeader()) + this.summaryCap(route) < window
  }

  /** A configured summary target outranks the step's route. */
  private explicitSummaryTarget(route: MemberSummaryRoute): boolean {
    return (this.policyFor(route)?.summarizationProvider ?? this.config.summarizationProvider) !== ''
  }

  /** The cap this route resolves to: its own override, else the shared default. */
  private summaryCap(route: MemberSummaryRoute): number {
    return this.policyFor(route)?.maxTokens ?? this.config.maxTokens
  }

  private policyFor(route: MemberSummaryRoute) {
    return this.config.modelPolicies.find(policy => policy.provider === route.provider && policy.model === route.model)
  }

  /** The agent the shipped summarizer reads: one route supplied, the rest forwarded, real session methods bound. */
  private routedView(agent: Agent, route: MemberSummaryRoute): Agent {
    const session = agent.session
    const header = session.requestHeader()
    const view = Object.create(agent) as Agent
    Object.defineProperty(view, 'session', {
      value: {
        id: session.id,
        requestHeader: () => (header === undefined ? undefined : { ...header, config: { ...header.config, ...route } }),
        toolHistory: () => session.toolHistory(),
      },
    })
    return view
  }
}
