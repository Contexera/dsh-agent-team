/**
 * Manager-only tool policy. Unlike Member policy, this path has no Member id,
 * ledger lookup, profile grants, Worker switch, Member context, or rollover
 * authority. It captures the isolated preset's definitions and admits only
 * those exact definitions (plus the shared `working_directory`) while the
 * execution belongs to the exact current manager Agent.
 * @module @contexera/dsh-agent-team/manager-tool-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { scopeOf, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Team tools declared only by the manager preset; they are never Member grant candidates. */
export const MANAGER_TOOL_NAMES = Object.freeze([
  'team_overview',
  'team_models',
  'member_create',
  'project_create',
  'project_owner',
  'project_update',
  'member_update',
  'member_state',
  'member_workspace',
] as const)

/** The isolated preset mounted for the Host-managed manager Session. */
export const MANAGER_SESSION_PRESET_ID = 'team-manager'

/**
 * The one preset a Member may compose. The Host's Member-creation guard and the
 * manager's model list both read this, so "which presets can a Member use" has
 * exactly one answer. The manager's own preset is deliberately absent from it:
 * it is Host-owned, never member-selectable.
 */
export const MEMBER_SESSION_PRESET_ID = 'team-member'

/** The default manager Session title. It is cosmetic and only set when no title exists. */
export const MANAGER_SESSION_TITLE = '团队管理'

/** What the guard resolves at execution time from the owning runtime. */
export interface ManagerToolPolicyDeps {
  readonly ctx: Context
  readonly isCurrentAgent: (agent: Agent) => boolean
  readonly pointerSessionId: () => SessionId | undefined
  readonly isArchived: (sessionId: SessionId) => boolean
}

/** The installed restriction and its exact-definition guard. */
export interface ManagerToolPolicy {
  /** Lift the restriction and guard. */
  dispose(): void
}

/**
 * Install the manager restriction and guard on one Agent scope. Names the
 * preset contributes at its ancestor scope, plus `working_directory`, become
 * the inherited allowance. Other definitions are denied, including tools
 * registered later in the Agent's own scope.
 */
export function installManagerToolPolicy(
  agentCtx: Context,
  agent: Agent,
  deps: ManagerToolPolicyDeps,
): ManagerToolPolicy {
  const scope = scopeOf(agentCtx)
  if (scope === undefined) throw new Error('Manager tool policy requires a scoped Agent context')
  const presetScope = scopeParentOf(scope)
  if (presetScope === undefined) throw new Error('Manager tool policy requires a mounted preset scope')
  const inherited = capturePresetDefinitions(deps.ctx, presetScope)

  const authorize = (subject: Agent): boolean => {
    if (subject !== agent || !deps.isCurrentAgent(agent)) return false
    try {
      if (deps.pointerSessionId() !== agent.id || deps.isArchived(agent.id)) return false
    } catch {
      return false
    }
    try {
      return deps.ctx.agentPresets.composedPreset(agent.ctx) === MANAGER_SESSION_PRESET_ID
    } catch {
      return false
    }
  }

  const disposeRestriction = agentCtx.tools.restrict({ allow: [...inherited.keys()] })
  const disposeGuard = agentCtx.tools.guard(execution => {
    if (execution.agent !== agent) return undefined
    if (!authorize(agent)) return 'Team manager Session is not authorized'
    const name = execution.name
    const captured = inherited.get(name)
    if (captured === undefined) return `Tool "${name}" is not declared for the Team manager`
    if (deps.ctx.tools.get(name, scope) !== captured) return `Team manager tool replaced: ${name}`
    return undefined
  })

  let disposed = false
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      disposeGuard()
      disposeRestriction()
    },
  }
}

/**
 * Capture the preset's own tool definitions plus the shared working-directory
 * tool. The preset scope also inherits Host globals; those are deliberately
 * excluded and become restricted away.
 */
function capturePresetDefinitions(ctx: Context, presetScope: ScopeKey): ReadonlyMap<string, ToolDefinition> {
  const captured = new Map<string, ToolDefinition>()
  for (const { name } of ctx.tools.schemas(presetScope)) {
    const definition = ctx.tools.get(name, presetScope)
    if (definition === undefined) continue
    if (name === 'working_directory' || definition !== ctx.tools.get(name)) captured.set(name, definition)
  }
  return captured
}
