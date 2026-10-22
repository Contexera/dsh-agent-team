/**
 * The installed bundle's own manifest, read once for both facts taken from it.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Root of the installed bundle. `packages/agent-team/{src,lib}` sits three
 * levels down in both a `link:` checkout and a registry tarball, so a
 * development install and a published one each resolve their own root.
 */
function installedPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
}

/**
 * Parsed manifest of the installed bundle, or `undefined` when it cannot be
 * read. An unreadable or malformed manifest is a broken install, not a failure
 * of whatever asked: every caller degrades to `'unknown'` or withholds the line
 * it would have stated, so reading this can never fail the Host boot.
 */
export function readInstalledManifest(): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(installedPackageRoot(), 'package.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** Version of the manifest this package installed from, or `'unknown'`. */
export function bundleVersionOf(manifest: Record<string, unknown> | undefined): string {
  const version = manifest?.version
  return typeof version === 'string' && version !== '' ? version : 'unknown'
}
