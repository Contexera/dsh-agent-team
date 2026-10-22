/** The one local environment check: how the running DSH compares to the line this bundle declares. */

import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { bundleVersionOf, readInstalledManifest } from './installed-manifest.ts'
import type { AgentTeamEnvironmentSupportRange, AgentTeamEnvironmentVerdict } from './types.ts'

/** What the settings page needs; unlike the wire `AgentTeamEnvironmentResult`, `bundleVersion` is required because the checker always knows it. */
export interface EnvironmentReport {
  readonly verdict: AgentTeamEnvironmentVerdict
  /** Host-side diagnostic for an `undetermined` verdict; never rendered as user copy. */
  readonly reason?: string | undefined
  /** Version of the bundle this Host runs from, or `'unknown'` when its manifest is unreadable. */
  readonly bundleVersion: string
/** The running DSH version; omitted when unreadable. Distinct from `certifiedDshVersion`, the line this bundle declares. */
  readonly dshVersion?: string | undefined
  /** Lower bound of the declared support range: the certified, actually-tested DSH line. */
  readonly certifiedDshVersion?: string | undefined
  readonly supportRange?: AgentTeamEnvironmentSupportRange | undefined
}

/** Prefix of every peer that sits on the DSH version line; the bare scope is not one. */
const DSH_PEER_PREFIX = '@deepseek-ai/dsh-'

/** The `>=lower <upper>` shape every DSH peer carries; a comparator series, not a single version. */
const SUPPORT_RANGE_SHAPE = /^>=(\S+)\s+<(\S+)$/u

/** Support line from the installed manifest's DSH peers; `undefined` unless every peer carries the same `>=lower <upper>` range (`scripts/check-version-consistency.mjs` holds the same shape). */
export function supportRangeOf(manifest: object): AgentTeamEnvironmentSupportRange | undefined {
  const fields = manifest as { readonly peerDependencies?: unknown }
  if (typeof fields.peerDependencies !== 'object' || fields.peerDependencies === null) return undefined
  const ranges = new Set<string>()
  for (const [name, range] of Object.entries(fields.peerDependencies as Record<string, unknown>)) {
    if (!name.startsWith(DSH_PEER_PREFIX)) continue
    if (typeof range !== 'string') return undefined
    ranges.add(range)
  }
  const distinct = [...ranges]
  if (distinct.length !== 1) return undefined
  const shape = SUPPORT_RANGE_SHAPE.exec(distinct[0]!)
  if (shape === null) return undefined
  return Object.freeze({ lower: shape[1]!, upper: shape[2]! })
}

/** Judges one resolved triple with the Harness's `evaluatePluginCompatibility`, the plugin manager's own installability check (it orders prereleases correctly). */
export function evaluateEnvironment(
  manifest: object,
  runtimeVersion: string,
  bundleVersion: string,
  unavailable?: string,
): EnvironmentReport {
  const range = supportRangeOf(manifest)
  const base = {
    bundleVersion,
    ...(range === undefined ? {} : { certifiedDshVersion: range.lower, supportRange: range }),
  }
  if (runtimeVersion === 'unknown') {
    return Object.freeze({ ...base, verdict: 'undetermined', reason: unavailable ?? 'the running dsh version is unavailable' })
  }
  const running = { ...base, dshVersion: runtimeVersion }
  const verdict = verdictFor({ manifest, runtimeVersion, range })
  return Object.freeze(verdict.verdict === 'undetermined' ? { ...base, ...verdict } : { ...running, ...verdict })
}

/** Verdict for a known running version, plus the reason when none can be stated. A real violation is never downgraded to `undetermined`, even when no single range can be stated. */
function verdictFor(input: {
  readonly manifest: object
  readonly runtimeVersion: string
  readonly range: AgentTeamEnvironmentSupportRange | undefined
}): { readonly verdict: AgentTeamEnvironmentVerdict; readonly reason?: string | undefined } {
  if (evaluatePluginCompatibility(input.manifest, {}, input.runtimeVersion) !== undefined) return { verdict: 'out-of-range' }
  if (input.range === undefined) return { verdict: 'undetermined', reason: 'the declared dsh support range is unreadable or drifted' }
  return { verdict: 'ok' }
}

/** Reads this Host's environment. The certified DSH version is the range's lower bound, not the newest tested cut (`docs/dsh-release-compatibility.md` §4). */
export function reportEnvironment(): EnvironmentReport {
  const manifest = readInstalledManifest() ?? {}
  const bundleVersion = bundleVersionOf(manifest)
  let runtime: string
  try {
    runtime = getDshRuntimeVersion()
  } catch (error) {
    return evaluateEnvironment(manifest, 'unknown', bundleVersion, error instanceof Error ? error.message : String(error))
  }
  return evaluateEnvironment(manifest, runtime, bundleVersion)
}
