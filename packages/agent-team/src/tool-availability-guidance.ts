/**
 * Guidance for foreign Agent-scope registrations that the current Harness
 * restriction API cannot remove from the model schema.
 * @module @contexera/dsh-agent-team/tool-availability-guidance
 */

/** Section name; the Host evaluates its names again at every prompt assembly. */
export const TOOL_AVAILABILITY_SECTION = 'team:tool-availability'

/** Warn about exactly the visible names the Member execution guard still denies. */
export function toolAvailabilityGuidance(toolNames: readonly string[]): string {
  if (toolNames.length === 0) return ''
  const names = toolNames.map(name => `\`${name}\``).join(', ')
  return `# Tool availability\n\nThe following tools are registered in this Agent's own scope and remain visible in the model schema, but Team has not granted their execution: ${names}. Do not invoke them while they are ungranted. Schema visibility is not execution permission. A profile extra-tool grant applies from the next turn; if execution is denied, leave that tool to the user instead of repeating the attempt or substituting another tool.`
}
