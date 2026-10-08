// Real module behind the member-tool-policy spec's preset row.
//
// rc.1 preset health resolves every row from disk, so the spec's composition
// points here with a file: URL. This file lives beside the spec, where its
// package imports resolve through the repository's node_modules.
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
