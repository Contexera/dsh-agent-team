/**
 * Per-Member private skill provider: wraps the Harness filesystem provider so one Member discovers only the plugin's bundled read-only core skills plus its private `skills/` directory (default roots excluded), filtered by that Member's selection.
 * @module @contexera/dsh-agent-team/member-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillProvider, SkillProviderControl, SkillProviderObservation, SkillRegistry } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

/** Handle to one mounted Member skill provider: the selection swap and the disposer. */
export interface MemberSkillProviderMount {
  /** Swaps the live selection filter and drops cached catalogs; `undefined` loads every discovered skill. */
  readonly swap: (allow: readonly string[] | undefined) => void
  /** Unregister the provider. */
  readonly dispose: () => void
}

/** Per-Member provider configuration; the private directory is provisioned before mounting. */
export interface MemberSkillsConfig {
  /** The Member's private skills directory; the writable self-install root. */
  readonly skillsDirectory: string
  /** Read-only bundled skills shipped with the plugin (e.g. the meta skill). */
  readonly bundledSkillsDirectory: string | undefined
  /** The selection this Member's provider starts with; `undefined` loads every discovered skill. */
  readonly initialSelection: readonly string[] | undefined
}

/**
 * Registers the Member-private skill provider on one Member's agent scope and returns its disposer; no sibling Member or ordinary session sees the catalog.
 *
 * Registration goes through the traceable service resolved from the agent context (like `tools.restrict()`), never a plugin mount: a mount from Host activation lands on the Host's trace fiber instead of the agent scope, and a plugin `inject` would hold Member activation open. Without a skill registry the Member has no private catalog.
 */
export function mountMemberSkillProvider(agentCtx: Context, config: MemberSkillsConfig): MemberSkillProviderMount | undefined {
  const skills = agentCtx.get('skills') as SkillRegistry | undefined
  // No registry: return no handle, since a no-op handle would pretend a filter exists.
  if (skills === undefined) return undefined
  let mounted: MemberPrivateSkillProvider | undefined
  const dispose = skills.registerProvider(control => {
    mounted = new MemberPrivateSkillProvider(agentCtx, control, config)
    return mounted
  })
  return {
    swap: (allow: readonly string[] | undefined) => mounted?.select(allow),
    dispose,
  }
}

/** One Member's bundled-plus-private skill roots wrapped as a filtered registry provider. */
class MemberPrivateSkillProvider implements SkillProvider {
  readonly name: string
  private readonly wrapped: FileSystemSkillProvider
  private readonly control: SkillProviderControl
  /** `undefined` loads every discovered skill. */
  private allow: readonly string[] | undefined

  constructor(
    ctx: Context,
    control: SkillProviderControl,
    config: MemberSkillsConfig,
  ) {
    this.control = control
    this.allow = config.initialSelection
    this.name = `member-private:${config.skillsDirectory}`
    // Bundled read-only core skills first, then the Member's private directory; both share the custom rank and discovery keeps the first root's same-name candidate, so bundled skills stay stable across upgrades.
    const customSkillDirs = config.bundledSkillsDirectory === undefined
      ? [config.skillsDirectory]
      : [config.bundledSkillsDirectory, config.skillsDirectory]
    this.wrapped = new FileSystemSkillProvider(ctx, control, {
      providerName: this.name,
      includeDefaultRoots: false,
      customSkillDirs,
    })
  }

  /** Replace the live filter and drop cached catalogs, so the next query sees it. */
  select(allow: readonly string[] | undefined): void {
    this.allow = allow
    this.control.invalidate()
  }

  /** Filters the wrapped discovery to the Member's selection. `list()` output only: the directory is still scanned and watched, so this is not a security boundary. */
  async list(options: Parameters<SkillProvider['list']>[0]): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    const output = await this.wrapped.list(options)
    const allow = this.allow
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
