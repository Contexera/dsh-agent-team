import type { AgentTeamMemberId } from './types/entities.ts'

/** One addressable name in a Message body: the Member's stable id plus the handle authors write. The Human uses the same shape. */
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

/**
 * A call starts at an `@` that is not inside an ASCII word, so an address like
 * `mail@host.example` stays prose. CJK prose separates no words with spaces, so
 * the text itself is a boundary there: `请@Reeve` calls. Handles end on the same
 * ASCII word rule, and the Client's composer opens its picker on it too.
 */
const CALL_BOUNDARY_START = '(?<![\\w@])'
const CALL_BOUNDARY_END = '(?=$|[^\\w])'

/** Whether an `@` at `at` would start a call, so the composer opens its picker exactly where delivery reads one. */
export function startsMentionAt(body: string, at: number): boolean {
  return !/[\w@]/u.test(body.slice(at - 1, at))
}

const ALL_MARKER = new RegExp(`${CALL_BOUNDARY_START}@all${CALL_BOUNDARY_END}`, 'iu')

/** Whether one body carries the `@all` marker outside code. */
export function hasAllMarker(body: string): boolean {
  const excluded = codeRanges(body)
  const marker = ALL_MARKER.exec(body)
  return marker !== null && !excluded.some(([start, end]) => marker.index >= start && marker.index < end)
}

/** Every `@Handle` occurrence naming one of `handles`: case-insensitive, on the ASCII word boundaries `CALL_BOUNDARY_START`/`CALL_BOUNDARY_END` define, longest first, outside code. The `@` is required. This is the single definition of an authored mention, shared by Host delivery and Client chip rendering. */
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
    `${CALL_BOUNDARY_START}@(?:${ordered.map(handle => escapeRegExp(handle)).join('|')})${CALL_BOUNDARY_END}`,
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

/** Resolves `@Handle` mentions authored in a Message body. Callers pass the candidates reachable in the Project; other handles stay prose. `sender` is excluded, so the result works as a recipient set. */
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
