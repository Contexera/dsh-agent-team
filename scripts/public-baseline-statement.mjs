// The certified-baseline token one public surface states: the first inline-code span of the marker's
// own clause, on the marker's own line. The marker is the whole phrase that qualifies the baseline, so
// prose after it is free while words inserted inside it stop the match; anchoring on the declaration
// keeps a sentence that also names retired baselines from reporting one of them.

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
