/**
 * The Team Host row's profile-wide extra tool-name grants.
 *
 * A grant names a tool exactly as DSH registers it. It is not a plugin origin,
 * a registration instance, or a wildcard; both Host and Client use this rule.
 * @module @contexera/dsh-agent-team/member-tool-grants
 */

import z from '@deepseek-ai/schemastery'

/** The row field holding the exact, case-sensitive names. */
export const EXTRA_TOOL_GRANTS_FIELD = 'extraToolGrants'

/** Structural only: settings reconstructs and serializes this schema before the browser reads it. */
export const EXTRA_TOOL_GRANTS_VALUE_SCHEMA = z.array(z.string().min(1))

/**
 * Validate and copy one stored or submitted list. Duplicates collapse in first
 * occurrence order; case is never folded, because DSH resolves tool names
 * exactly. Normalization belongs to the consumer, not a serialized transform.
 * @param names - the candidate list.
 * @returns one owned list of exact names.
 */
export function sanitizeExtraToolGrants(names: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(EXTRA_TOOL_GRANTS_VALUE_SCHEMA([...names]))])
}

/**
 * Read an untrusted settings value without inventing an empty list. `undefined`
 * means the value is absent or invalid, which a caller must treat as a failed
 * read rather than permission to overwrite it.
 * @param value - the settings layer value.
 * @returns the sanitized list, or `undefined` when the value is not a usable list.
 */
export function extraToolGrantsFrom(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  try {
    return sanitizeExtraToolGrants(value)
  } catch {
    return undefined
  }
}
