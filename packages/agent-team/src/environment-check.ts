/** The one local environment check: how the running DSH compares to the line this bundle declares. */

import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { bundleVersionOf, readInstalledManifest } from './installed-manifest.ts'
import type { AgentTeamEnvironmentSupportRange, AgentTeamEnvironmentVerdict } from './types.ts'

/**
 * What the settings page needs to state the environment.
 *
 * Deliberately not the wire type (`AgentTeamEnvironmentResult`): that one states
 * every fact as optional, because a Transport may withhold any of them, while
 * this is what the checker itself guarantees. `bundleVersion` is therefore
 * required here and optional there, and the seam in `index.ts` is where the two
 * meet.
 */
export interface EnvironmentReport {
  readonly verdict: AgentTeamEnvironmentVerdict
  /** Host-side diagnostic for an `undetermined` verdict; never rendered as user copy. */
  readonly reason?: string | undefined
  /** Version of the bundle this Host runs from, or `'unknown'` when its manifest is unreadable. */
  readonly bundleVersion: string
  /**
   * The running DSH version — what the page states it is running. Omitted, not
   * guessed, when it could not be read; it is a different fact from
   * `certifiedDshVersion`, which is the line this bundle declares support for.
   */
  readonly dshVersion?: string | undefined
  /** Lower bound of the declared support range: the certified, actually-tested DSH line. */
  readonly certifiedDshVersion?: string | undefined
  readonly supportRange?: AgentTeamEnvironmentSupportRange | undefined
}

/** Prefix of every peer that sits on the DSH version line; the bare scope is not one. */
const DSH_PEER_PREFIX = '@deepseek-ai/dsh-'

/** The `>=lower <upper>` shape every DSH peer carries; a comparator series, not a single version. */
const SUPPORT_RANGE_SHAPE = /^>=(\S+)\s+<(\S+)$/u

/**
 * Read the support line from the installed manifest's DSH peers, or nothing.
 *
 * Every `@deepseek-ai/dsh-*` peer must carry exactly the same range, and it must
 * be a `>=<lower> <upper>` series: the version line is the manifest's own claim
 * and a partially drifted manifest cannot state one. `scripts/check-version-consistency.mjs`
 * holds the same shape to the certified baseline, so a run of this bundle
 * states the same line its README does. Returns `undefined` when the peers
 * disagree or the shape is unreadable.
 */
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

/**
 * Judge one already-resolved triple, so every branch is testable without an
 * environment. The verdict comes from the Harness's own
 * `evaluatePluginCompatibility` — the plugin manager decides installability with
 * that same function, and prerelease ordering is exactly what a hand-written
 * comparison gets wrong.
 *
 * @param manifest - the installed bundle's parsed manifest, the source of the declared support line.
 * @param runtimeVersion - the running DSH version, or `'unknown'` when it could not be read.
 * @param bundleVersion - the installed bundle version, or `'unknown'`.
 * @param unavailable - why the running version is not known, recorded when it is `'unknown'`.
 * @returns the report the settings page renders.
 */
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

/**
 * The verdict for a known running version, and the reason when there is no
 * verdict to state.
 *
 * One evaluation covers every dsh peer in the manifest, and `range` is derived
 * from exactly those peers: re-judging the range this prints could not change
 * the answer. A real violation is answered first, and it is never downgraded to
 * `undetermined` — a peer that drifted to a range of its own is a genuine "not
 * satisfied" even though no single range can then be stated for the page. Only
 * when nothing is violated does the question become whether the declared line
 * can be stated at all.
 */
function verdictFor(input: {
  readonly manifest: object
  readonly runtimeVersion: string
  readonly range: AgentTeamEnvironmentSupportRange | undefined
}): { readonly verdict: AgentTeamEnvironmentVerdict; readonly reason?: string | undefined } {
  if (evaluatePluginCompatibility(input.manifest, {}, input.runtimeVersion) !== undefined) return { verdict: 'out-of-range' }
  if (input.range === undefined) return { verdict: 'undetermined', reason: 'the declared dsh support range is unreadable or drifted' }
  return { verdict: 'ok' }
}

/**
 * Read this Host's own environment: the installed bundle version, the declared
 * support line, and how the running DSH compares to it.
 *
 * The certified DSH version is the range's lower bound, never the newest cut
 * tested against it: `docs/dsh-release-compatibility.md` §4 records a baseline
 * inside the declared range without moving the peers, so every version spot
 * keeps naming the bound. Reading it from anywhere else would reintroduce the
 * hand-maintained constant this check exists to remove.
 *
 * @returns the report, with `verdict: 'undetermined'` for any fact not established.
 */
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
