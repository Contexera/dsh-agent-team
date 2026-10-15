import type { AgentTeamMemberId } from './types/entities.ts'

/**
 * One addressable name in a Message body: the Member's stable id plus the
 * handle authors are expected to write. The Human is included through the
 * same shape so a body-level mention needs no special case at the call site.
 */
export interface AgentTeamBodyMentionCandidate {
  readonly memberId: AgentTeamMemberId
  readonly handle: string
}

/** Outcome of scanning one Message body for authored mentions. */
export interface AgentTeamBodyMentionResolution {
  /** Candidate Member ids named in the body, in candidate order; never the caller's own id. */
  readonly memberIds: readonly AgentTeamMemberId[]
  /** The body carried an `@all` marker, so the caller decides how wide that reaches. */
  readonly all: boolean
}

/** One `@Handle` occurrence the delivery scan reads as a call, in body order. */
export interface AgentTeamBodyHandleMatch {
  /** The candidate handle, in its canonical spelling rather than the authored casing. */
  readonly handle: string
  readonly start: number
  readonly end: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function codeRanges(body: string): readonly (readonly [number, number])[] {
  const ranges: [number, number][] = []
  for (const match of body.matchAll(/```[\s\S]*?```|`[^`\n]*`/g)) {
    const start = match.index ?? 0
    ranges.push([start, start + match[0].length])
  }
  return ranges
}

const ALL_MARKER = /(?<![\p{L}\p{N}_@])@all(?=$|[^\p{L}\p{N}_])/iu

/** Whether one body carries the `@all` marker outside code. */
export function hasAllMarker(body: string): boolean {
  const excluded = codeRanges(body)
  const marker = ALL_MARKER.exec(body)
  return marker !== null && !excluded.some(([start, end]) => marker.index >= start && marker.index < end)
}

/**
 * Every `@Handle` occurrence in one body that names one of `handles`:
 * case-insensitive, on Unicode word boundaries, longest handle first, outside
 * code. Writing `@` is required: bare handles are ordinary words. This is the
 * single definition of an authored mention — the Host delivery resolution and
 * the Client's chip rendering and draft preview all read through it, so a name
 * that renders as a chip is the same name that delivers a notification.
 */
export function scanBodyHandles(body: string, handles: readonly string[]): readonly AgentTeamBodyHandleMatch[] {
  const seen = new Set<string>()
  const usable: string[] = []
  for (const handle of handles) {
    const key = handle.toLowerCase()
    if (handle.trim() === '' || seen.has(key)) continue
    seen.add(key)
    usable.push(handle)
  }
  if (usable.length === 0) return Object.freeze([])
  const excluded = codeRanges(body)
  const ordered = [...usable].sort((left, right) => right.length - left.length)
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_@])@(?:${ordered.map(handle => escapeRegExp(handle)).join('|')})(?=$|[^\\p{L}\\p{N}_])`,
    'giu',
  )
  const matches: AgentTeamBodyHandleMatch[] = []
  for (const match of body.matchAll(pattern)) {
    const start = match.index ?? 0
    if (excluded.some(([rangeStart, rangeEnd]) => start >= rangeStart && start < rangeEnd)) continue
    const written = match[0].slice(1).toLowerCase()
    const hit = ordered.find(handle => handle.toLowerCase() === written)
    if (hit === undefined) continue
    matches.push(Object.freeze({ handle: hit, start, end: start + match[0].length }))
  }
  return Object.freeze(matches)
}

/**
 * Resolve the `@Handle` mentions authored in one Message body.
 *
 * Callers pass the candidates reachable in the Message's Channel, so a name
 * that resolves here is already an addressable target; handles the Channel
 * cannot reach simply stay prose.
 *
 * `sender` is excluded because a Message never mentions its own author, which
 * also keeps the result usable as a recipient set without further filtering.
 */
export function resolveBodyMentions(
  body: string,
  candidates: readonly AgentTeamBodyMentionCandidate[],
  sender: AgentTeamMemberId,
): AgentTeamBodyMentionResolution {
  const usable = candidates.filter(candidate => candidate.memberId !== sender && candidate.handle.trim() !== '')
  const all = hasAllMarker(body)
  if (usable.length === 0) return { memberIds: Object.freeze([]), all }
  const matched = new Set(scanBodyHandles(body, usable.map(candidate => candidate.handle)).map(match => match.handle.toLowerCase()))
  return { memberIds: Object.freeze(usable.filter(candidate => matched.has(candidate.handle.toLowerCase())).map(candidate => candidate.memberId)), all }
}
