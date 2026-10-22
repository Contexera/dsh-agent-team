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
  const fields = section as Record<string, unknown>
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
