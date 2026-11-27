import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  AgentTeamAgentMember,
  AgentTeamCapabilityWarning,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
} from './types.ts'
import { sanitizeExtraToolGrants } from './member-tool-grants.ts'
import { MANAGER_TOOL_NAMES } from './manager-tool-policy.ts'

/** The one Team tool a Host switch can withdraw from a Member's declared surface. */
const WORKER_TOOL_NAME = 'team_worker'

/** Model-facing capabilities every Team-enabled preset must publish. */
export const AGENT_TEAM_TOOL_NAMES = Object.freeze([
  'team_inbox',
  'team_thread',
  'team_attention',
  'team_message',
  'team_dm',
  'team_task',
  'team_view',
  'team_subscription',
  'team_reminder',
  'team_worker',
] as const)

/** The DSH tool names that hand a Member an arbitrary shell on the Host. */
export const SHELL_TOOL_NAMES = Object.freeze(['bash', 'pwsh'] as const)

/** The DSH tool names that hand a Member arbitrary file reads on the Host: the file readers, plus the shells that can read anything. */
export const FILE_READ_TOOL_NAMES = Object.freeze(['read', 'read_image', ...SHELL_TOOL_NAMES] as const)

/** One Member's durable policy intent at the instant its next turn opens. */
interface MemberToolPolicySnapshot {
  readonly member: AgentTeamAgentMember
  readonly workerEnabled: boolean
  readonly grants: readonly string[]
}

/** Read the current intent synchronously: this runs from `session/event`, which cannot await. */
type MemberToolPolicyReader = () => MemberToolPolicySnapshot

/** Team-owned tools and the shared directory control are never extra grants. */
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([...AGENT_TEAM_TOOL_NAMES, ...MANAGER_TOOL_NAMES, 'working_directory'])

/** DSH's tree-local task board overlaps Team's ledger-owned Tasks and is not a Member grant surface. */
const DSH_TASK_BOARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
])

/** Whether one tool name is Team-owned or shared and cannot be reopened by a profile grant. */
function isReservedToolName(name: string): boolean {
  return RESERVED_TOOL_NAMES.has(name)
}

/** Whether the settings catalog may offer this registered name as an extra grant. */
export function isExtraToolGrantCandidate(name: string): boolean {
  return !isReservedToolName(name) && !DSH_TASK_BOARD_TOOL_NAMES.has(name)
}

interface MemberToolState {
  bindings?: ReadonlyMap<string, ToolDefinition>
  disposeRestriction?: () => void
  enforcedAllow?: ReadonlySet<string>
  turnGrants?: ReadonlySet<string>
  turnFailure?: string
  lastIntent?: Pick<MemberToolPolicySnapshot, 'member' | 'workerEnabled'>
  // An applied empty overlay is not an unknown live surface.
  applied?: { readonly capabilities: AgentTeamMemberCapabilities | undefined }
  warnings?: readonly AgentTeamCapabilityWarning[]
}

export class MemberToolPolicy {
  private readonly members = new Map<AgentTeamMemberId, MemberToolState>()

  constructor(private readonly deps: {
    readonly ctx: Context
    readonly liveMemberContext: (memberId: AgentTeamMemberId) => Context
  }) {}

  private stateFor(memberId: AgentTeamMemberId): MemberToolState {
    let state = this.members.get(memberId)
    if (state === undefined) {
      state = {}
      this.members.set(memberId, state)
    }
    return state
  }

  /** Tool names supplied by activated Member presets, rather than discovered foreign registrations. */
  baselineToolNames(): ReadonlySet<string> {
    const names = new Set<string>()
    for (const { bindings } of this.members.values()) {
      if (bindings !== undefined) for (const name of bindings.keys()) names.add(name)
    }
    return names
  }

  /** Whether the restriction enforced for this Member admits a shell tool; a Member with no installed restriction has none. */
  enforcesShellTool(memberId: AgentTeamMemberId): boolean {
    const allow = this.members.get(memberId)?.enforcedAllow
    return allow !== undefined && SHELL_TOOL_NAMES.some(name => allow.has(name))
  }

  /** Whether the restriction enforced for this Member admits a file-reading tool; a Member with no installed restriction has none. */
  enforcesFileReadTool(memberId: AgentTeamMemberId): boolean {
    const allow = this.members.get(memberId)?.enforcedAllow
    return allow !== undefined && FILE_READ_TOOL_NAMES.some(name => allow.has(name))
  }

  /** Own-scope registrations can stay visible despite the execution guard. */
  visibleDeniedToolNames(agentCtx: Context, memberId: AgentTeamMemberId): readonly string[] {
    const scope = scopeOf(agentCtx)
    if (scope === undefined) throw new Error('Member tool guidance requires a mounted Agent scope')
    const state = this.members.get(memberId)
    const grants = state?.turnGrants
    const bindings = state?.bindings
    return this.deps.ctx.tools.schemas(scope)
      .map(tool => tool.name)
      .filter(name => {
        if (grants?.has(name) && !isReservedToolName(name)) return false
        return bindings === undefined || this.baselineToolDenial(memberId, scope, name, bindings) !== undefined
      })
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  }

  /** One Member's live capability warnings, if any; runtime-derived, never persisted. */
  capabilityWarningsFor(memberId: AgentTeamMemberId): readonly AgentTeamCapabilityWarning[] | undefined {
    return this.members.get(memberId)?.warnings
  }

  /**
   * Restrict every Member to its preset tools plus the profile's exact name
   * grants. The stored Member allow-list narrows the baseline; an explicit
   * non-reserved grant can reopen a baseline name. `workerEnabled` stays the
   * Host's own switch: while it is off, `team_worker` is not declared at all,
   * so a grant cannot recreate a tool the Host would refuse.
   */
  applyMemberToolPolicy(
    agentCtx: Context,
    member: AgentTeamAgentMember,
    workerEnabled: boolean,
    grants: readonly string[] = [],
  ): void {
    const bindings = this.members.get(member.memberId)?.bindings ?? this.mountMemberToolBindings(agentCtx, member.memberId)
    this.installMemberToolPolicy(agentCtx, member, workerEnabled, grants, bindings)
  }

  /**
   * Install the per-turn restriction synchronously from `turn/start`. The
   * session event itself is observe-only (the Harness contains its exceptions
   * and does not await it), so failure is recorded here and rejected later by
   * `agent/pre-step`; it must never be mistaken for asynchronous turn blocking.
   */
  observeMemberToolPolicyTurns(
    agentCtx: Context,
    agent: Agent,
    memberId: AgentTeamMemberId,
    readPolicy: MemberToolPolicyReader,
  ): void {
    agentCtx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'turn/start') {
        this.freezeMemberToolPolicyForTurn(agentCtx, memberId, readPolicy)
      }
    })
  }

  /**
   * Whether this turn's policy installation or per-step refresh failed.
   * `agent/pre-step` uses it only to refuse the step and spend no model
   * request; it never selects tools.
   */
  turnToolPolicyFailure(memberId: AgentTeamMemberId): string | undefined {
    return this.members.get(memberId)?.turnFailure
  }

  private freezeMemberToolPolicyForTurn(
    agentCtx: Context,
    memberId: AgentTeamMemberId,
    readPolicy: MemberToolPolicyReader,
  ): void {
    let snapshot: MemberToolPolicySnapshot
    try {
      snapshot = readPolicy()
      this.stateFor(memberId).lastIntent = { member: snapshot.member, workerEnabled: snapshot.workerEnabled }
    } catch (error) {
      // A settings read cannot be replaced with an invented list. The last
      // accepted Member intent is still enough to establish the no-grants
      // baseline; only a failed baseline closes the turn.
      const previous = this.members.get(memberId)?.lastIntent
      if (previous === undefined) {
        // No confirmed baseline exists to install. Drop any older surface so a
        // stale grant-bearing allow-list cannot become the fallback authority;
        // the pre-step rejection still prevents a model request.
        this.release(memberId)
        this.failTurn(memberId, `could not read the Member tool policy: ${errorMessage(error)}`)
        return
      }
      snapshot = { ...previous, grants: [] }
    }
    const bindings = this.members.get(memberId)?.bindings
    if (bindings === undefined) {
      this.release(memberId)
      this.failTurn(memberId, 'Member tool bindings are unavailable at the turn boundary')
      return
    }
    try {
      this.installMemberToolPolicy(agentCtx, snapshot.member, snapshot.workerEnabled, snapshot.grants, bindings)
    } catch (error) {
      this.failTurn(memberId, `could not establish the Member tool baseline: ${errorMessage(error)}`)
    }
  }

  /**
   * Re-materialize the current turn's restriction against the tool names that
   * exist now. `tools.restrict()` snapshots global names when installed, so a
   * selected name first registered after turn start would otherwise stay hidden.
   * This runs from `agent/pre-step`, after the Harness resolved this step's
   * tools but before it can send the model request: the current step keeps its
   * assembly, a successful refresh serves the following step, and a failed
   * baseline is still visible to the existing pre-step failure gate.
   */
  refreshMemberToolPolicyForStep(agentCtx: Context, memberId: AgentTeamMemberId): void {
    const state = this.members.get(memberId)
    const grants = state?.turnGrants
    const accepted = state?.lastIntent
    if (grants === undefined || grants.size === 0 || accepted === undefined) return
    const bindings = state?.bindings
    if (bindings === undefined) {
      this.failTurn(memberId, 'Member tool bindings are unavailable at the step boundary')
      return
    }
    try {
      this.installMemberToolPolicy(
        agentCtx,
        accepted.member,
        accepted.workerEnabled,
        [...grants],
        bindings,
      )
    } catch (error) {
      this.failTurn(memberId, `could not refresh the Member tool baseline: ${errorMessage(error)}`)
    }
  }

  private failTurn(memberId: AgentTeamMemberId, detail: string): void {
    const state = this.stateFor(memberId)
    state.turnGrants = new Set()
    state.turnFailure = detail
  }

  /**
   * Derive and install one complete restriction. A failed grant-bearing apply
   * tightens to the current Member baseline, never to the previous restriction
   * which may still contain a revoked grant. A failed baseline leaves no
   * old-grant restore behind.
   */
  private installMemberToolPolicy(
    agentCtx: Context,
    member: AgentTeamAgentMember,
    workerEnabled: boolean,
    grants: readonly string[],
    bindings: ReadonlyMap<string, ToolDefinition>,
  ): void {
    const configured = member.capabilities?.tools?.allow
    // Drop unknown names instead of failing activation: a Harness upgrade renaming a tool must not make the Member unavailable. The warning carries the known-name digest for diagnosing drift.
    const known = [...bindings.keys()]
    const knownSet = new Set(known)
    const dropped = (configured ?? []).filter(name => !knownSet.has(name))
    const state = this.stateFor(member.memberId)
    if (dropped.length === 0) delete state.warnings
    else state.warnings = Object.freeze(dropped.map(name => ({ name, knownNames: known })))
    const baseline = [...new Set([
      ...(configured ?? known).filter(name => knownSet.has(name) && (workerEnabled || name !== WORKER_TOOL_NAME)),
      ...AGENT_TEAM_TOOL_NAMES.filter(name => workerEnabled || name !== WORKER_TOOL_NAME),
      // An allow-list narrows capability, not the checkout the Member works in, so `working_directory` survives like the Team tools.
      ...knownSet.has('working_directory') ? ['working_directory'] : [],
    ])]
    const inherited = this.inheritedToolNames(agentCtx)
    const grantNames = sanitizeExtraToolGrants(grants)
      .filter(name => !isReservedToolName(name))
    const desired = [...new Set([
      ...baseline,
      ...grantNames.filter(name => inherited.has(name)),
    ])]
    state.lastIntent = Object.freeze({ member, workerEnabled })
    try {
      this.installRestriction(agentCtx, member.memberId, desired, grantNames)
      return
    } catch (error) {
      // Only a grant-bearing surface has a no-grant fallback. A failed baseline
      // apply keeps the prior surface and surfaces the failure as before.
      if (!desired.some(name => !baseline.includes(name))) throw error
      // A grant-bearing replacement may leave the old grant surface installed
      // when it fails. Remove it before tightening, so a revoked grant cannot
      // survive by rolling back to that old restriction.
      this.dropRestriction(state)
      let fallbackError: unknown
      try {
        this.installRestriction(agentCtx, member.memberId, baseline, [])
      } catch (next) {
        fallbackError = next
      }
      if (fallbackError !== undefined) {
        this.dropRestriction(state)
        state.turnGrants = new Set()
        throw new AggregateError(
          [error, fallbackError],
          `failed to establish the Team Member tool baseline for '${member.memberId}'`,
        )
      }
      const message = `extra tool policy failed and was tightened to the Member baseline: ${errorMessage(error)}`
      this.deps.ctx.logger.warn(`agent-team: member '${member.memberId}' ${message}`)
    }
  }

  private dropRestriction(state: MemberToolState): void {
    state.disposeRestriction?.()
    delete state.disposeRestriction
    delete state.enforcedAllow
  }

  private installRestriction(
    agentCtx: Context,
    memberId: AgentTeamMemberId,
    allow: readonly string[],
    grants: readonly string[],
  ): void {
    // `tools.restrict()` requires a scoped context and rejects names outside the
    // inherited surface; either error fails this installation, never widens it.
    const dispose = agentCtx.tools.restrict({ allow })
    const state = this.stateFor(memberId)
    const previous = state.disposeRestriction
    state.disposeRestriction = dispose
    state.enforcedAllow = new Set(allow)
    state.turnGrants = new Set(grants)
    delete state.turnFailure
    previous?.()
  }

  /** The names `tools.restrict()` can mask: inherited global and ancestor registrations. */
  private inheritedToolNames(agentCtx: Context): ReadonlySet<string> {
    const scope = scopeOf(agentCtx)
    const presetScope = scope === undefined ? undefined : scopeParentOf(scope)
    if (presetScope === undefined) throw new Error('Member tool policy requires a mounted preset scope')
    return new Set(this.deps.ctx.tools.schemas(presetScope).map(tool => tool.name))
  }

  private mountMemberToolBindings(agentCtx: Context, memberId: AgentTeamMemberId): ReadonlyMap<string, ToolDefinition> {
    const scope = scopeOf(agentCtx)
    if (scope === undefined) throw new Error('Member tool policy requires a mounted Agent scope')
    const presetScope = scopeParentOf(scope)
    if (presetScope === undefined) throw new Error('Member tool policy requires a mounted preset scope')
    const tools = this.deps.ctx.tools
    const bindings = new Map<string, ToolDefinition>()
    for (const { name } of tools.schemas(presetScope)) {
      const definition = tools.get(name, presetScope)
      // The preset view also inherits Host tools. Only its own definitions and
      // the explicitly shared directory tool belong to the Member's baseline.
      if (definition !== undefined && (name === 'working_directory' || definition !== tools.get(name))) {
        bindings.set(name, definition)
      }
    }
    this.stateFor(memberId).bindings = bindings
    agentCtx.tools.guard(execution => {
      if (execution.agent !== scope) return undefined
      const name = execution.name
      const grants = this.members.get(memberId)?.turnGrants
      if (grants?.has(name) && !isReservedToolName(name)) {
        // Grant execution follows exactly the registration DSH admitted for this
        // Member and step. It never compares definition identity or infers origin.
        if (execution.toolSet === undefined) return `Tool "${name}" requires step admission for this Team Member`
        return execution.toolSet.view(scope).get(name) === undefined
          ? `Tool "${name}" is not admitted for this Team Member`
          : undefined
      }
      const denial = this.baselineToolDenial(memberId, scope, name, bindings)
      if (denial === 'not-declared') return `Tool "${execution.name}" is not declared for this Team Member`
      if (denial === 'replaced') return `Team Member tool replaced: ${name}`
      return undefined
    })
    return bindings
  }

  /** The execution guard for a name outside the current turn's grant set; prompt guidance reports the same denial. */
  private baselineToolDenial(
    memberId: AgentTeamMemberId,
    scope: ScopeKey,
    name: string,
    bindings: ReadonlyMap<string, ToolDefinition>,
  ): 'not-declared' | 'replaced' | undefined {
    if (!this.members.get(memberId)?.enforcedAllow?.has(name)) return 'not-declared'
    const binding = bindings.get(name)
    return binding === undefined || this.deps.ctx.tools.get(name, scope) !== binding ? 'replaced' : undefined
  }

  /** Whether the live surface is known to reflect exactly this capability intent; an absent record never matches. */
  appliedCapabilitiesMatch(memberId: AgentTeamMemberId, capabilities: AgentTeamMemberCapabilities | undefined): boolean {
    const applied = this.members.get(memberId)?.applied
    return applied !== undefined && isDeepStrictEqual(applied.capabilities, capabilities)
  }

  /** Record the capability intent the live surface now reflects; callers invoke it only after every effect of the apply succeeded. */
  recordAppliedCapabilities(memberId: AgentTeamMemberId, capabilities: AgentTeamMemberCapabilities | undefined): void {
    this.stateFor(memberId).applied = { capabilities }
  }

  reapplyMemberToolPolicy(member: AgentTeamAgentMember, workerEnabled: boolean, grants: readonly string[] = []): void {
    const agentCtx = this.deps.liveMemberContext(member.memberId)
    this.applyMemberToolPolicy(agentCtx, member, workerEnabled, grants)
  }

  private release(memberId: AgentTeamMemberId): void {
    const state = this.members.get(memberId)
    if (state === undefined) return
    const dispose = state.disposeRestriction
    delete state.disposeRestriction
    dispose?.()
    // The captured bindings belong to the Agent and survive a failed turn.
    this.members.set(memberId, state.bindings === undefined ? {} : { bindings: state.bindings })
  }

  memberIds(): Iterable<AgentTeamMemberId> {
    return this.members.keys()
  }

  forgetMember(memberId: AgentTeamMemberId): void {
    this.release(memberId)
    this.members.delete(memberId)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
