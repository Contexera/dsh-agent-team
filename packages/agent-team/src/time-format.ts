/**
 * The one agent-facing Team timestamp formatter.
 *
 * Ledger storage keeps UTC ISO instants (`occurredAt` on every operation);
 * rendering converts them into the fixed Team coordination zone UTC+8 with
 * an explicit offset (`2026-09-08T17:00:00+08:00`). The conversion is a
 * fixed offset with no daylight-saving component, so the same stored instant
 * renders byte-identically on every reread path — the context-cache
 * invariant. The Web Client keeps its own browser-local rendering and never
 * passes through this module; a future configuration layer may make the
 * zone configurable, but the render must stay a single deterministic
 * formatter per stored instant.
 * @module @contexera/dsh-agent-team/time-format
 */

/** The fixed Team coordination offset from UTC, in minutes. */
const TEAM_ZONE_OFFSET_MINUTES = 8 * 60

/** Rendered offset text, e.g. `+08:00`. */
const OFFSET_TEXT = '+08:00'

/**
 * Format one stored UTC ISO instant as the agent-facing Team timestamp.
 * @param occurredAt - stored UTC ISO 8601 instant (ledger `occurredAt`).
 * @returns the fixed-offset UTC+8 rendering, or the input unchanged when it
 * cannot be parsed (never a fabricated time).
 */
export function formatTeamTimestamp(occurredAt: string): string {
  const instant = Date.parse(occurredAt)
  if (!Number.isFinite(instant)) return occurredAt
  const shifted = new Date(instant + TEAM_ZONE_OFFSET_MINUTES * 60_000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${OFFSET_TEXT}`
}

/**
 * Format a non-negative elapsed millisecond count as compact whole-second
 * units (`2d 3h 12m 8s`), mirroring the shipped harness time-context
 * vocabulary so both clock families read the same way.
 */
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
