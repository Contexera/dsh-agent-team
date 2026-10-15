import { apply as applyAgentTeamTools } from '@contexera/dsh-agent-team/tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'

export const name = 'test-team-tools'
export const inject = ['tools']

export function apply(scope) {
  applyAgentTeamTools(scope)
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
