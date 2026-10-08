/**
 * Per-Member private skill provider: the Team-owned wrapper around the
 * Harness filesystem provider that scopes one Member's skill discovery to
 * exactly the plugin's bundled read-only core skills plus that Member's
 * private `skills/` directory (default roots excluded), and filters `list()`
 * output by that Member's selection ref.
 *
 * Deliberate interface reservation: this per-Member provider seam is the
 * primitive future Runtime Revision manifests orchestrate — do not remove
 * during cleanup.
 *
 * @module @contexera/dsh-agent-team/member-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillProvider, SkillProviderControl, SkillProviderObservation, SkillRegistry } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

/** Live selection state shared with the Host: `undefined` loads every discovered skill. */
export type MemberSkillSelectionRef = {
  current: readonly string[] | undefined
  /** Set by the provider; swaps the selection and invalidates the catalog cache. */
  swap: (allow: readonly string[] | undefined) => void
}

/** Per-Member provider configuration; the private directory is provisioned before mounting. */
export interface MemberSkillsConfig {
  /** The Member's private skills directory; the writable self-install root. */
  readonly skillsDirectory: string
  /** Read-only bundled skills shipped with the plugin (e.g. the meta skill). */
  readonly bundledSkillsDirectory: string | undefined
  /** Live selection ref; an edit swaps the array and invalidates the catalog. */
  readonly selection: MemberSkillSelectionRef
}

/**
 * Register the Member-private skill provider on one Member's agent scope and
 * return its disposer. The provider files into that agent's exact layer, so
 * no sibling Member or ordinary session can observe the catalog; discovery,
 * watching, and invalidation flow through the same Harness provider below.
 *
 * Registration goes through the traceable service resolved FROM the agent
 * context (the same shape as `tools.restrict()`), never through a plugin
 * mount: a plugin mounted from Host activation code lands on the Host's
 * async-trace fiber instead of the agent scope, and a plugin `inject` would
 * hold Member activation open while the Host is still starting. A deployment
 * without the skill registry keeps its Members; they simply carry no private
 * skill catalog.
 */
export function mountMemberSkillProvider(agentCtx: Context, config: MemberSkillsConfig): () => void {
  const selection = config.selection
  // A no-op swap stands in for deployments without the skill registry, so
  // the Host's edit path never sees a half-initialized ref.
  selection.swap = () => {}
  const skills = agentCtx.get('skills') as SkillRegistry | undefined
  if (skills === undefined) return () => {}
  return skills.registerProvider(control => {
    const provider = new MemberPrivateSkillProvider(agentCtx, control, config, selection)
    // The ref swap updates the live filter and drops cached catalogs through
    // the provider's own registration, so the next catalog query (and the
    // next step's durable replacement catalog) sees the new selection.
    selection.swap = (allow: readonly string[] | undefined) => {
      selection.current = allow
      control.invalidate()
    }
    return provider
  })
}

/** One Member's bundled-plus-private skill roots wrapped as a filtered registry provider. */
class MemberPrivateSkillProvider implements SkillProvider {
  readonly name: string
  private readonly wrapped: FileSystemSkillProvider

  constructor(
    ctx: Context,
    control: SkillProviderControl,
    config: MemberSkillsConfig,
    private readonly selection: MemberSkillSelectionRef,
  ) {
    this.name = `member-private:${config.skillsDirectory}`
    // Two Team-owned roots, no project/user/global leakage: the bundled
    // read-only core skills first, then the Member's writable private
    // directory. Within one provider both roots share the custom rank, and
    // discovery keeps the first root's same-name candidate, so a bundled
    // skill stays stable across plugin upgrades while a Member installs
    // its own additions under their own names.
    const customSkillDirs = config.bundledSkillsDirectory === undefined
      ? [config.skillsDirectory]
      : [config.bundledSkillsDirectory, config.skillsDirectory]
    this.wrapped = new FileSystemSkillProvider(ctx, control, {
      providerName: this.name,
      includeDefaultRoots: false,
      customSkillDirs,
    })
  }

  /**
   * Filter the wrapped discovery to the Member's selection. Filtering is
   * list()-output only — the directory is still scanned and watched, so this
   * is a performance/visibility semantic, not a security boundary.
   */
  async list(options: Parameters<SkillProvider['list']>[0]): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    const output = await this.wrapped.list(options)
    const allow = this.selection.current
    if (allow === undefined) return output
    const allowed = new Set(allow)
    return filterObservation(output, candidate => allowed.has(candidate.name))
  }

  async get(candidate: SkillCandidate, options: Parameters<SkillProvider['get']>[1]): Promise<Awaited<ReturnType<SkillProvider['get']>>> {
    return this.wrapped.get(candidate, options)
  }
}

/** Apply one name filter to either provider observation shape. */
function filterObservation(
  output: readonly SkillCandidate[] | SkillProviderObservation,
  keep: (candidate: SkillCandidate) => boolean,
): readonly SkillCandidate[] | SkillProviderObservation {
  if (!('candidates' in output)) return output.filter(keep)
  return { candidates: output.candidates.filter(keep), complete: output.complete }
}
