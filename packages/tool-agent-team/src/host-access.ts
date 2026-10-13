/**
 * Shared Host accessors for every Team tool module. `agent.ctx.get` is the
 * one resolution path a tool row has — the preset mounts these tools beside
 * the Host, so a missing service or an inactive Member is a model-visible
 * rejection rather than a silent no-op. Both messages are user-facing text.
 */

import AgentTeam from '@contexera/dsh-agent-team/host'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { recoveryFor } from '@contexera/dsh-agent-team/recovery-hints'

/** The Agent shape every Team tool receives. */
export type TeamToolAgent = NonNullable<Parameters<AgentTeam['memberForAgent']>[0]>

/** Resolve the Team Host service, or reject the tool call. */
export function service(agent: TeamToolAgent): AgentTeam {
  const host = agent.ctx.get('agentTeam') as AgentTeam | undefined
  if (host === undefined) throw new Error('Agent Team Host is unavailable')
  return host
}

/** Resolve the calling Team Member, or reject the tool call. */
export function member(agent: TeamToolAgent) {
  const current = service(agent).memberForAgent(agent)
  if (current === undefined) throw new Error('team tool requires an active Team Member')
  return current
}

/** A collaboration address, never a cwd or Session switch. */
export const workspaceParam = {
  type: 'string' as const,
  description: 'Target Workspace id exactly as listed in your participation context or team_view. A unique prefix of at least 6 hex characters also resolves. Required when you participate in more than one Workspace; only a sole participation can be inferred. This does not change your Session cwd.',
}

/**
 * Shortest accepted Workspace-id abbreviation, and the same tolerance the
 * branded Team refs already have. A Member that echoes a prefix it was shown
 * must not be rejected for the very form the choices list invited it to copy.
 */
const MIN_WORKSPACE_PREFIX = 6

/**
 * Resolve the routing Workspace, or reject with the fix.
 *
 * An exact id wins; a unique prefix of at least {@link MIN_WORKSPACE_PREFIX}
 * hex characters resolves like a branded ref does. Every refusal names the
 * participated Workspaces and states which form is expected — the same
 * contract the ledger applies to Task/Thread/Message/Claim refs, so no
 * parameter family can invite a form it then rejects.
 */
export function workspaceOf(args: { workspace?: string | undefined }, agent: TeamToolAgent): WorkspaceId {
  const workspaces = service(agent).workspacesForAgent(agent)
  const choices = workspaces.map(workspace => workspace.workspaceId).join(', ')
  if (args.workspace === undefined) {
    if (workspaces.length !== 1) throw new Error(recoveryFor('workspace_required').sentence({ refused: choices }))
    return workspaces[0]!.workspaceId
  }
  const requested = args.workspace
  const exact = workspaces.find(workspace => workspace.workspaceId === requested)
  if (exact !== undefined) return exact.workspaceId
  // Only a well-formed, long-enough hex tail may abbreviate; anything else is
  // an unknown id, never a silently shortened match. The brand prefix is not
  // part of the tail, so `workspace:1a2b3c4d` abbreviates the same UUID the
  // branded refs do.
  const tail = requested.slice(requested.indexOf(':') + 1).replaceAll('-', '').toLowerCase()
  const isAbbreviation = tail.length >= MIN_WORKSPACE_PREFIX && /^[0-9a-f]+$/.test(tail)
  if (isAbbreviation) {
    const matches = workspaces.filter(workspace => workspace.workspaceId.slice(workspace.workspaceId.indexOf(':') + 1).replaceAll('-', '').toLowerCase().startsWith(tail))
    if (matches.length === 1) return matches[0]!.workspaceId
    if (matches.length > 1) throw new Error(recoveryFor('workspace_ambiguous').sentence({ refused: `${requested} matches ${matches.map(workspace => `'${workspace.workspaceId}'`).join(', ')}` }))
  }
  throw new Error(recoveryFor('workspace_not_participating').sentence({ refused: `'${requested}'. Choose: ${choices}` }))
}
