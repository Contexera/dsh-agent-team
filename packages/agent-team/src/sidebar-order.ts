/**
 * The Human's personal Team sidebar row order, as a Host setting.
 *
 * Presentation only: it is written by the Human's own drag on the sidebar and
 * read by no Agent tool, so it lives on the Team Host row (beside the Human's
 * name and avatar) rather than in the Team ledger, which records shared facts.
 * One versioned map keeps both lists of every Workspace: `<workspaceId>|projects`
 * and `<workspaceId>|agents` to the refs in the order the Human put them.
 * @module @contexera/dsh-agent-team/sidebar-order
 */

import z from '@deepseek-ai/schemastery'

/** The two sidebar lists a Human can reorder; a new list is a new kind, never a guessed key. */
export const SIDEBAR_ORDER_KINDS = ['projects', 'agents'] as const

export type TeamSidebarListKind = typeof SIDEBAR_ORDER_KINDS[number]

/** Shape version of the stored map; a future change must migrate, not reinterpret. */
export const SIDEBAR_ORDER_VERSION = 1

/** Bounds on one stored list, so a broken client cannot grow the settings document without limit. */
export const SIDEBAR_ORDER_MAX_REFS = 500
export const SIDEBAR_ORDER_MAX_REF_LENGTH = 200
/** Longest Workspace id part of a key; UUIDs are 36 characters. */
const SIDEBAR_ORDER_MAX_WORKSPACE_PART = 128

export interface SidebarOrderConfig {
  readonly version: number
  readonly lists: Readonly<Record<string, readonly string[]>>
}

export const DEFAULT_SIDEBAR_ORDER: SidebarOrderConfig = Object.freeze({
  version: SIDEBAR_ORDER_VERSION,
  lists: Object.freeze({}),
})

const SIDEBAR_ORDER_VALUE = z.object({
  version: z.number().default(SIDEBAR_ORDER_VERSION),
  lists: z.dict(z.array(z.string())).default({}),
})

/** The value form the migration validates a carried group with: a partial group arrives complete. */
export const SIDEBAR_ORDER_VALUE_SCHEMA = SIDEBAR_ORDER_VALUE.default({})

/** The settings form derives one volatile group, and a write to it reaches the running Host without a remount. */
export const SIDEBAR_ORDER_SETTINGS_SCHEMA = SIDEBAR_ORDER_VALUE.default({}).volatile()

/** The one key form both the Host write and the Client read agree on. */
export function sidebarOrderKey(workspaceId: string, kind: TeamSidebarListKind): string {
  return `${workspaceId}|${kind}`
}

/** Why a stored list key is unusable, or `undefined` when it names one Workspace's one list. */
export function sidebarOrderKeyProblem(key: unknown): string | undefined {
  if (typeof key !== 'string') return 'a sidebar order key must be a string'
  const separator = key.lastIndexOf('|')
  if (separator <= 0) return `sidebar order key '${key}' must be '<workspaceId>|<list kind>'`
  const workspacePart = key.slice(0, separator)
  const kind = key.slice(separator + 1)
  if (!(SIDEBAR_ORDER_KINDS as readonly string[]).includes(kind)) return `sidebar order key '${key}' names an unknown list kind`
  if (workspacePart.length > SIDEBAR_ORDER_MAX_WORKSPACE_PART) return `sidebar order key '${key}' names an over-long Workspace id`
  if (workspacePart.trim() !== workspacePart || workspacePart === '' || /[\s\u0000-\u001f]/u.test(workspacePart)) {
    return `sidebar order key '${key}' names an unusable Workspace id`
  }
  return undefined
}

/** The refs a Client asked to store, or a thrown refusal: an array of short non-empty strings, bounded in count. */
export function sanitizeSidebarOrderRefs(refs: unknown): readonly string[] {
  if (!Array.isArray(refs)) throw new Error('sidebar order refs must be an array')
  if (refs.length > SIDEBAR_ORDER_MAX_REFS) throw new Error(`a sidebar order list may hold at most ${SIDEBAR_ORDER_MAX_REFS} refs`)
  const seen = new Set<string>()
  const clean: string[] = []
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref === '') throw new Error('a sidebar order ref must be a non-empty string')
    if (ref.length > SIDEBAR_ORDER_MAX_REF_LENGTH) throw new Error('a sidebar order ref is too long')
    if (/[\s\u0000-\u001f]/u.test(ref)) throw new Error('a sidebar order ref must not contain whitespace or control characters')
    if (seen.has(ref)) continue
    seen.add(ref)
    clean.push(ref)
  }
  return clean
}

/**
 * The lists the Client may read: stored entries whose key names one Workspace's
 * one list. A hand-edited settings document cannot smuggle an unexpected key
 * into the Client, and an unusable entry is dropped rather than failing the read.
 */
export function readableSidebarOrders(lists: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
  const clean: Record<string, readonly string[]> = {}
  for (const [key, refs] of Object.entries(lists)) {
    if (sidebarOrderKeyProblem(key) !== undefined) continue
    try {
      clean[key] = sanitizeSidebarOrderRefs(refs)
    } catch {
      continue
    }
  }
  return Object.freeze(clean)
}
