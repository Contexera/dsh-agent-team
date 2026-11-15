import { apply as applyAgentTeamTools } from '@contexera/dsh-agent-team/tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { AGENT_TEAM_TOOL_NAMES } from '@contexera/dsh-agent-team/host'

/**
 * The shipped `team-member` tools row as this spec's copy of it: the real tools
 * plugin narrowed to the exact Member surface, plus two distinguishable
 * ordinary tools an allow-list case can name. A preset declares its own tools
 * because the model's visible list is read from the registering scope's
 * schemas, so the two read-only manager tools are absent here — the manager
 * preset declares them, and this one does not. The Member names come from the
 * Host's own list rather than a second copy here.
 */
const MEMBER_TEAM_TOOLS = [...AGENT_TEAM_TOOL_NAMES]

export const name = 'test-team-tools'
export const inject = ['tools']

export function apply(scope, config) {
  applyAgentTeamTools(scope, config ?? { only: MEMBER_TEAM_TOOLS })
  scope.tools.register(defineContentToolFixture({
    name: 'ordinary_tool',
    description: 'ordinary',
    parameters: {},
    execute: async () => [{ type: 'text', text: 'ordinary ok' }],
  }))
  scope.tools.register(defineContentToolFixture({
    name: 'spare_tool',
    description: 'spare',
    parameters: {},
    execute: async () => [{ type: 'text', text: 'spare ok' }],
  }))
}
