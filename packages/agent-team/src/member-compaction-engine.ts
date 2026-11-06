import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
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

  /** Bind the step's fixed route, or clear it when that step ends. */
  useStepRoute(route: MemberStepRoute | undefined): void {
    this.stepRoute = route
    if (route !== undefined) this.alternativeSpent = false
  }

  /** Whether a bounded failure opened the circuit for this route; another route starts clean. */
  degraded(agent: Agent, route: MemberSummaryRoute): boolean {
    const recorded = this.degradedRoutes.get(agent)
    return recorded !== undefined && recorded.provider === route.provider && recorded.model === route.model
  }

  /** Whether the last summary attempt failed for a reason other than cancellation; consumed on read. */
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
    const target = await this.summaryTarget(agent, signal)
    const route = target ?? agent.session.requestHeader()?.config
    // An automatic path that already cost this route its summaries does not
    // call the model again; the explicit /compact below is the way out.
    if (!this.manualAgents.has(agent) && route !== undefined && this.degraded(agent, route)) {
      throw new Error(`agent-team: summarization is paused for ${route.provider}/${route.model} after a bounded failure`)
    }
    try {
      if (target === undefined) return await super.summarize(input, agent, signal)
      try {
        return await super.summarize(input, this.routedView(agent, target), signal)
      } catch (error) {
        // One known-good route, once per step: no model rotation.
        if (signal?.aborted === true || this.alternativeSpent) throw error
        this.alternativeSpent = true
      }
      return await super.summarize(input, agent, signal)
    } catch (error) {
      if (signal?.aborted !== true && route !== undefined) {
        // The failure is recorded here, where every entry point passes through,
        // so a model switch that keeps failing stops paying for it too.
        this.summaryFailures.add(agent)
        this.degradedRoutes.set(agent, { provider: route.provider, model: route.model })
      }
      throw error
    }
  }

  /** The step's route when it differs, nothing explicit outranks it, and its window can hold this summary. */
  private async summaryTarget(agent: Agent, signal?: AbortSignal): Promise<MemberSummaryRoute | undefined> {
    const step = this.stepRoute
    const committed = agent.session.requestHeader()?.config
    if (step === undefined || committed === undefined) return undefined
    if (step.provider === committed.provider && step.model === committed.model) return undefined
    if (this.explicitSummaryTarget(step)) return undefined
    const llm = this.ctx.get('llm')
    const meter = this.ctx.get('tokenMeter')
    if (llm === undefined || meter === undefined) return undefined
    let window: number | undefined
    try {
      window = (await llm.resolveModelInfo(step.provider, step.model, signal)).context?.contextWindow
    } catch {
      return undefined
    }
    // Equality leaves no room for the reply; the cap is this route's, never a constant.
    if (window === undefined
      || meter.measure(agent.session).totalTokens + this.summaryCap(step) >= window) return undefined
    return { provider: step.provider, model: step.model }
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
