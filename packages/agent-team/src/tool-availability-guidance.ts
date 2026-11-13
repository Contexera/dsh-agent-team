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
  const names = JSON.stringify(toolNames)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
  return `# Tool availability\n\nThe following tools are visible in this Member's schema, but Team does not admit their execution for the current turn: ${names}. These strings are exact tool names. Do not invoke them. Schema visibility is not execution permission. A profile extra-tool grant applies from the next turn; if execution is denied, leave that tool to the user instead of repeating the attempt or substituting another tool.`
}
