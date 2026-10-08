/**
 * Shared Host accessors for every Team tool module. `agent.ctx.get` is the
 * one resolution path a tool row has — the preset mounts these tools beside
 * the Host, so a missing service or an inactive Member is a model-visible
 * rejection rather than a silent no-op. Both messages are user-facing text.
 */

import AgentTeam from '@contexera/dsh-agent-team/host'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'

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
  description: 'Target Workspace id exactly as listed in your participation context or team_view. Required when you participate in more than one Workspace; only a sole participation can be inferred. This does not change your Session cwd.',
}

/** Reject ambiguous routing before a tool reads facts or attempts a mutation. */
export function workspaceOf(args: { workspace?: string | undefined }, agent: TeamToolAgent): WorkspaceId {
  const workspaces = service(agent).workspacesForAgent(agent)
  const choices = workspaces.map(workspace => workspace.workspaceId).join(', ')
  if (args.workspace === undefined) {
    if (workspaces.length !== 1) throw new Error(`workspace is required when participating in multiple Workspaces. Choose: ${choices}`)
    return workspaces[0]!.workspaceId
  }
  const selected = workspaces.find(workspace => workspace.workspaceId === args.workspace)
  if (selected === undefined) throw new Error(`Not participating in Workspace '${args.workspace}'. Choose: ${choices}`)
  return selected.workspaceId
}
