import z from '@deepseek-ai/schemastery'
import { parse } from 'yaml'
import { bundleVersionOf, readInstalledManifest } from './installed-manifest.ts'

/** Fallback display name before any user override is stored. */
export const HUMAN_PROFILE_DEFAULT_NAME = 'human'

/** Repository home for the version footnote link. */
export const HUMAN_PROFILE_REPO_URL = 'https://github.com/Contexera/dsh-agent-team'

/**
 * Bundle version shown in the settings footnote, and the current side of the
 * update check: the version of the package THIS Host runs from — the installed
 * manifest's, read once at load through `./installed-manifest.ts`, so a `link:`
 * checkout under the development profile and a registry tarball under stable
 * each state their own truth. It is not a hand-maintained string: the 0.1.14
 * bundle shipped with `0.1.13` written in it, which made the footnote name the
 * previous release and the update check offer the release the user already had.
 *
 * An unreadable or malformed manifest degrades to `'unknown'`: the Remote's
 * `version: string` contract holds and the update comparison simply compares
 * nothing. The footnote is informational only and never gates behavior.
 */
export const HUMAN_PROFILE_VERSION = bundleVersionOf(readInstalledManifest())

/**
 * Schemastery schema of the Human profile: the Team Host row's Config. Both
 * fields are volatile, which is what lets an edit reach the running Host
 * without remounting it — and what makes the settings service derive a form
 * from this schema at all.
 */
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

/**
 * The retired settings section this profile's facts lived in before rc.1.
 * rc.1 derives every settings form from a plugin's Config, and its legacy
 * `settings.yaml` importer maps a section to a composition entry id through a
 * closed built-in list — this third-party section matches nothing there, so
 * the import rejects it and the values survive only in the renamed document.
 * This Host owns the section, so adopting what is left belongs here.
 */
export const LEGACY_HUMAN_PROFILE_SECTION = 'agent-team-human'

/** Fields recoverable from the legacy section; either may be absent. */
export interface LegacyHumanProfileFields {
  readonly name?: string
  readonly avatarRef?: string
}

/**
 * Read the legacy section out of one legacy settings document. An
 * unparsable document or a missing section means "nothing to adopt" rather
 * than an error — the file is retired input, not an authority — and each
 * field is validated independently so one bad field never costs the other.
 */
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

/**
 * Decide what adoption may write: nothing unless the stored profile is still
 * the pristine default, so a value the Human re-entered after the upgrade
 * always wins, and never the legacy default name itself. The returned fields
 * are exactly the ops the profile page would have written; byte existence for
 * `avatarRef` is the caller's I/O and must already hold.
 */
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
