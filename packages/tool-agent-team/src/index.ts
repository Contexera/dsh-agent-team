import type { Context } from '@deepseek-ai/cordis'
import { teamSubscription } from './subscription.ts'
import { teamAttention, teamDm, teamInbox, teamMessage, teamReminder, teamTask, teamThread, teamView } from './member-tools.ts'
import { memberCreate, memberState, memberUpdate, memberWorkspace, projectCreate, projectOwner, projectUpdate, teamModels, teamOverview } from './manager-tools.ts'
import { teamWorker } from './worker-tool.ts'

export const name = 'contexera-agent-team-tools'

export const inject = ['tools']

export interface Config {
  /** Exact tool names to declare; omitted declares all tools. */
  only?: readonly string[]
}

export function apply(ctx: Context, config: Config = {}): void {
  const tools = [
    teamInbox, teamReminder, teamThread, teamAttention, teamMessage, teamDm,
    teamTask, teamView, teamOverview, teamModels, teamSubscription, teamWorker,
    memberCreate, projectCreate, projectOwner, projectUpdate, memberUpdate, memberState, memberWorkspace,
  ]
  if (config.only === undefined) {
    for (const tool of tools) ctx.tools.register(tool)
    return
  }
  const selected = new Set(config.only)
  // The model sees the scope's registered schemas, so validate the entire selection before registering any.
  for (const name of selected) {
    if (!tools.some(tool => tool.name === name)) {
      throw new Error(`team-tools config names an unknown Team tool: ${name}`)
    }
  }
  for (const tool of tools) {
    if (selected.has(tool.name)) ctx.tools.register(tool)
  }
}
