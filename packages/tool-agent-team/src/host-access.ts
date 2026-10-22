
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

const MIN_WORKSPACE_PREFIX = 6

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
    // Only a well-formed hex tail of at least 6 characters may abbreviate, never a silently shortened match; the brand prefix is not part of the tail.
  const tail = requested.slice(requested.indexOf(':') + 1).replaceAll('-', '').toLowerCase()
  const isAbbreviation = tail.length >= MIN_WORKSPACE_PREFIX && /^[0-9a-f]+$/.test(tail)
  if (isAbbreviation) {
    const matches = workspaces.filter(workspace => workspace.workspaceId.slice(workspace.workspaceId.indexOf(':') + 1).replaceAll('-', '').toLowerCase().startsWith(tail))
    if (matches.length === 1) return matches[0]!.workspaceId
    if (matches.length > 1) throw new Error(recoveryFor('workspace_ambiguous').sentence({ refused: `${requested} matches ${matches.map(workspace => `'${workspace.workspaceId}'`).join(', ')}` }))
  }
  throw new Error(recoveryFor('workspace_not_participating').sentence({ refused: `'${requested}'. Choose: ${choices}` }))
}
