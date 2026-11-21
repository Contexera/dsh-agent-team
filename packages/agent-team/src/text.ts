/**
 * One home for counting and cutting characters: every Team ceiling counts code points, and anything that
 * shortens a string has to cut on the same boundary it counted on.
 * @module @contexera/dsh-agent-team/text
 */

/** Code-point length, which is what the contract's character ceilings count. */
export function characterLength(value: string): number {
  return [...value].length
}

/**
 * At most `limit` code points, cut where no astral character straddles the edge: `slice` counts UTF-16 code
 * units, so it can end the result between the halves of one and leave a lone surrogate behind.
 */
export function truncateToCharacters(value: string, limit: number): string {
  const characters = [...value]
  return characters.length <= limit ? value : characters.slice(0, limit).join('')
}

/**
 * The longest head of UTF-8 `raw` within `maxBytes` that ends on a line boundary, so a byte budget shows
 * whole lines; a first line longer than the budget is cut on a code-point boundary instead. A newline byte
 * never occurs inside a multi-byte sequence, so cutting after one cannot split a character.
 */
export function utf8HeadOnLineBoundary(raw: Uint8Array, maxBytes: number): string {
  const decode = (end: number): string => Buffer.from(raw.buffer, raw.byteOffset, end).toString('utf8')
  if (raw.byteLength <= maxBytes) return decode(raw.byteLength)
  const newline = raw.subarray(0, maxBytes).lastIndexOf(0x0a)
  if (newline !== -1) return decode(newline + 1)
  let end = maxBytes
  // A continuation byte (10xxxxxx) at the cut means the cut falls inside one character.
  while (end > 0 && (raw[end]! & 0xc0) === 0x80) end -= 1
  return decode(end)
}
