/**
 * The private memory index one session keeps outside its Workspace: the context
 * budget, the usage gauge, the over-budget warning, framing escape, and the
 * baseline/update distinction. A Member and the Team manager share these
 * mechanics and own only their wording, so the budget cannot drift between two
 * copies of the same rule.
 * @module @contexera/dsh-agent-team/private-memory
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** The context budget for one private memory index; past it the body is not injected at all. */
export const PRIVATE_MEMORY_MAX_BYTES = 16 * 1024

/** What one read of `memory.md` found; the three cases render differently on purpose. */
export type PrivateMemoryState =
  | { readonly kind: 'index'; readonly raw: Buffer }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable' }

/** Read `<root>/memory.md`; absence and an unreadable file stay distinct so a damaged index is never called empty. */
export async function readPrivateMemoryIndex(root: string): Promise<PrivateMemoryState> {
  try {
    return { kind: 'index', raw: await readFile(`${root}/memory.md`) }
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable' }
  }
}

/**
 * The identity of what was injected. A digest of the bytes lets a later step
 * tell an unchanged index from a rewritten one without re-reading the text.
 */
export function privateMemoryDigest(memory: PrivateMemoryState): string {
  return memory.kind === 'index' ? createHash('sha256').update(memory.raw).digest('hex') : memory.kind
}

/** Whether the index is small enough to inject its body; the gauge and warning still render when it is not. */
export function privateMemoryAvailable(memory: PrivateMemoryState): boolean {
  return memory.kind === 'index' && memory.raw.byteLength <= PRIVATE_MEMORY_MAX_BYTES
}

/** The gauge line, rendered at every size so the reader sees the budget before it is exceeded. */
export function privateMemoryUsage(memory: PrivateMemoryState): string {
  if (memory.kind !== 'index') return ''
  const usedKiB = (memory.raw.byteLength / 1024).toFixed(1)
  const percent = Math.round((memory.raw.byteLength / PRIVATE_MEMORY_MAX_BYTES) * 100)
  return `Private memory index: ${usedKiB} KiB / ${PRIVATE_MEMORY_MAX_BYTES / 1024} KiB (${percent}%).`
}

/**
 * The one maintenance sentence per abnormal state, or '' when the index is
 * ordinary. An over-budget index is reported, never trimmed: deleting or
 * summarizing the file automatically would destroy what the reader wrote.
 */
export function privateMemoryAnomaly(memory: PrivateMemoryState): string {
  if (memory.kind === 'absent') return 'memory.md is absent; the private memory index is empty.'
  if (memory.kind === 'unreadable') return 'memory.md is currently unreadable; do not use any earlier private memory context.'
  if (memory.raw.byteLength > PRIVATE_MEMORY_MAX_BYTES) {
    const usedKiB = (memory.raw.byteLength / 1024).toFixed(1)
    const percent = Math.round((memory.raw.byteLength / PRIVATE_MEMORY_MAX_BYTES) * 100)
    return `memory.md at ${memory.raw.byteLength} B (${usedKiB} KiB, ${percent}%) exceeds the ${PRIVATE_MEMORY_MAX_BYTES / 1024} KiB context budget. Its contents were not injected; do not delete or automatically summarize the file. Maintain a smaller index explicitly.`
  }
  return ''
}

/** The index body, or '' when it is over budget and therefore withheld. */
export function privateMemoryBody(memory: PrivateMemoryState): string {
  return memory.kind === 'index' && privateMemoryAvailable(memory) ? memory.raw.toString('utf8') : ''
}

/** The four private paths plus the caller's own sentence about where they sit relative to the cwd. */
export function privateMemoryPathsBlock(root: string, locationSentence: string): string {
  return `Private memory directory: ${root}\nMemory index: ${root}/memory.md\nNotes directory: ${root}/notes\nPrivate skills directory: ${root}/skills\n${locationSentence}`
}

/**
 * Escape the framing markers inside the index body. The block must stay the
 * only place its own delimiters appear, or a memory file could close the block
 * early and have the rest read as instructions.
 */
export function escapePrivateMemoryFraming(value: string, markers: { readonly begin: string; readonly end: string }): string {
  return value.replaceAll(markers.begin, '[escaped begin marker]').replaceAll(markers.end, '[escaped end marker]')
}

/** The tag one injected private-memory block carries; a replay reads it to tell what the surface already holds. */
export interface PrivateMemoryTag {
  readonly category: 'memory'
  readonly variant: 'baseline' | 'update' | 'unavailable'
  readonly digest: string
  readonly textDigest: string
}

/**
 * Whether a visible block is still the text its tag was written with. A
 * projection can rewrite or prune content while leaving the source tag in
 * place, so a block whose text no longer hashes to its tag can neither stand in
 * for a complete baseline nor vouch for an update digest.
 */
export function privateMemoryTextMatches(tag: PrivateMemoryTag, text: string): boolean {
  return createHash('sha256').update(text).digest('hex') === tag.textDigest
}
