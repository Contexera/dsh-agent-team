import z from '@deepseek-ai/schemastery'
import { parse } from 'yaml'
import { bundleVersionOf, readInstalledManifest } from './installed-manifest.ts'

/** Fallback display name before any user override is stored. */
export const HUMAN_PROFILE_DEFAULT_NAME = 'human'

/** Repository home for the version footnote link. */
export const HUMAN_PROFILE_REPO_URL = 'https://github.com/Contexera/dsh-agent-team'

/** Bundle version of the package this Host runs from, read once from the installed manifest; `'unknown'` when the manifest is unreadable or malformed. Informational only. */
export const HUMAN_PROFILE_VERSION = bundleVersionOf(readInstalledManifest())

/** Schemastery schema of the Human profile (the Team Host row's Config). Both fields are volatile so edits reach the running Host without remounting. */
export const HUMAN_PROFILE_SETTINGS_SCHEMA = z.object({
  name: z.string().default(HUMAN_PROFILE_DEFAULT_NAME).volatile(),
  // Schemastery fields are optional unless `.required()`: a missing avatarRef
  // simply resolves absent, which the profile reads as "no custom avatar".
  avatarRef: z.string().volatile(),
})

/** Normalize one candidate display name the way Member handles normalize. */
export function normalizeHumanName(raw: string): string {
  return raw.normalize('NFKC').trim()
}

export function assertValidHumanName(raw: string): string {
  const name = normalizeHumanName(raw)
  if (name === '') throw new Error('human name must not be empty')
  return name
}

/** Retired settings section. The Harness `settings.yaml` importer rejects it, so its values survive only in the renamed document; this Host adopts them. */
export const LEGACY_HUMAN_PROFILE_SECTION = 'agent-team-human'

/** Fields recoverable from the legacy section; either may be absent. */
export interface LegacyHumanProfileFields {
  readonly name?: string
  readonly avatarRef?: string
}

/** Reads the legacy section from a legacy settings document. An unparsable document or missing section means nothing to adopt; each field is validated independently. */
export function parseLegacyHumanProfile(yamlText: string): LegacyHumanProfileFields | undefined {
  let document: unknown
  try {
    document = parse(yamlText)
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null) return undefined
  const section = (document as Record<string, unknown>)[LEGACY_HUMAN_PROFILE_SECTION]
  if (typeof section !== 'object' || section === null) return undefined
  return readProfileFields(section as Record<string, unknown>)
}

/** Decides what adoption may write: nothing unless the stored profile is still the pristine default, and never the legacy default name. `avatarRef` byte existence is the caller's check. */
export function planLegacyAdoption(
  current: { readonly name: string; readonly avatarRef?: string },
  legacy: LegacyHumanProfileFields,
): { readonly name?: string; readonly avatarRef?: string } | undefined {
  if (current.name !== HUMAN_PROFILE_DEFAULT_NAME || current.avatarRef !== undefined) return undefined
  const name = legacy.name !== undefined && legacy.name !== HUMAN_PROFILE_DEFAULT_NAME ? legacy.name : undefined
  const avatarRef = legacy.avatarRef
  if (name === undefined && avatarRef === undefined) return undefined
  return { ...(name === undefined ? {} : { name }), ...(avatarRef === undefined ? {} : { avatarRef }) }
}

/**
 * Reads the Human profile fields a profile patch document stores under one row
 * id. The pre-rename Host row kept the name and avatar reference as that row's
 * `config`, and after the rename no loader entry answers to the old id any
 * more — the patch is skipped at composition time — so the document itself is
 * the only place the values still exist.
 *
 * A missing document, a non-array patch, a duplicate id, or a malformed field
 * all read as absent: this is a recovery path, and a half-understood document
 * must not overwrite a profile.
 */
export function parseRowHumanProfile(yamlText: string, rowId: string): LegacyHumanProfileFields | undefined {
  let document: unknown
  try {
    document = parse(yamlText)
  } catch {
    return undefined
  }
  if (!Array.isArray(document)) return undefined
  const rows = document.filter(row => typeof row === 'object' && row !== null && (row as Record<string, unknown>).id === rowId)
  // Two rows for one id would make "the stored value" ambiguous; the loader
  // would apply them in order, but a recovery must not guess which one won.
  if (rows.length !== 1) return undefined
  const config = (rows[0] as Record<string, unknown>).config
  if (typeof config !== 'object' || config === null) return undefined
  return readProfileFields(config as Record<string, unknown>)
}

/** Reads the Human profile fields out of a settings namespace's user layer, tolerating either field being absent or unusable. */
export function readProfileFields(fields: Record<string, unknown>): LegacyHumanProfileFields | undefined {
  let name: string | undefined
  if (typeof fields.name === 'string') {
    try {
      name = assertValidHumanName(fields.name)
    } catch {
      name = undefined
    }
  }
  const avatarRef = typeof fields.avatarRef === 'string' && fields.avatarRef.trim() !== ''
    ? fields.avatarRef.trim()
    : undefined
  if (name === undefined && avatarRef === undefined) return undefined
  return { ...(name === undefined ? {} : { name }), ...(avatarRef === undefined ? {} : { avatarRef }) }
}

/**
 * Decides what the namespace move may write: the pre-rename values, but only
 * for fields the new namespace stores no value for. `stored` is that
 * namespace's own user layer, so a Human who already edited the profile after
 * the upgrade keeps every field they set — the migration fills gaps and never
 * overwrites, even when their value happens to equal the schema default.
 */
export function planNamespaceMigration(
  stored: { readonly name?: unknown; readonly avatarRef?: unknown },
  legacy: LegacyHumanProfileFields,
): { readonly name?: string; readonly avatarRef?: string } | undefined {
  const name = stored.name === undefined && legacy.name !== undefined && legacy.name !== HUMAN_PROFILE_DEFAULT_NAME
    ? legacy.name
    : undefined
  const avatarRef = stored.avatarRef === undefined ? legacy.avatarRef : undefined
  if (name === undefined && avatarRef === undefined) return undefined
  return { ...(name === undefined ? {} : { name }), ...(avatarRef === undefined ? {} : { avatarRef }) }
}
