// The certified-baseline token one public surface states, read as the first
// inline-code span of the marker's own clause, on the marker's own line.
//
// This is the anchor rule the baseline gates apply to the same README sentences,
// stated once here: the marker is the WHOLE phrase that qualifies the baseline,
// so prose after it is free while wording inserted inside the marker phrase
// stops the match. Anchoring on the declaration — rather than searching the line
// for anything version-shaped — is what keeps a sentence that also names retired
// baselines ("On DSH `0.1.7-rc.2`, stay on ...") from reporting one of them.

/**
 * The baseline stated after `marker` on the marker's own line, or `undefined`
 * when no marker line carries a following inline-code span. A caller treats
 * `undefined` as a FAILURE, never a skip: an unparseable surface has dropped out
 * of coverage.
 */
export function baselineStatement(text, marker) {
  const line = text.split('\n').find(candidate => candidate.toLowerCase().includes(marker.toLowerCase()))
  if (line === undefined) return undefined
  const afterMarker = line.slice(line.toLowerCase().indexOf(marker.toLowerCase()) + marker.length)
  return /`([^`]+)`/.exec(afterMarker)?.[1]
}
