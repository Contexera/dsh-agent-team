/**
 * The agent-facing Team timestamp formatter. Ledger storage keeps UTC ISO instants; rendering converts them to the fixed Team zone UTC+8 with an explicit offset (`2026-09-08T17:00:00+08:00`). A fixed offset has no daylight-saving component, so a stored instant renders byte-identically on every reread (context-cache invariant). The Web Client renders browser-local time and never uses this module.
 * @module @contexera/dsh-agent-team/time-format
 */

/** The fixed Team coordination offset from UTC, in minutes. */
const TEAM_ZONE_OFFSET_MINUTES = 8 * 60

/** Rendered offset text, e.g. `+08:00`. */
const OFFSET_TEXT = '+08:00'

/** Formats a stored UTC ISO instant as UTC+8 with explicit offset; returns the input unchanged when unparsable, never a fabricated time. */
export function formatTeamTimestamp(occurredAt: string): string {
  const instant = Date.parse(occurredAt)
  if (!Number.isFinite(instant)) return occurredAt
  const shifted = new Date(instant + TEAM_ZONE_OFFSET_MINUTES * 60_000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${OFFSET_TEXT}`
}

/** Formats a non-negative elapsed millisecond count as whole-second units (`2d 3h 12m 8s`), matching the harness time-context vocabulary. */
export function formatTeamDuration(elapsedMs: number): string {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}
