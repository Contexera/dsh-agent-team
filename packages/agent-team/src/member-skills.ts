/**
 * Team-owned skill discovery. An isolated preset registry admits only this router;
 * the router selects the exact Agent's bundled-plus-private filesystem provider.
 * @module @contexera/dsh-agent-team/member-skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type { SkillCandidate, SkillProvider, SkillProviderControl, SkillProviderObservation, SkillRegistry, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'contexera-agent-team-member-skills'
export const inject = ['skills']

/** The registry is shared even when the preset and Host activate separate module graphs. */
const skillRouterKey = Symbol.for('@contexera/dsh-agent-team/skill-router')
type RoutedSkillRegistry = SkillRegistry & { [skillRouterKey]?: TeamSkillRouter }

/** Mount the router into the preset's isolated registry, never the Host-global one. */
export function apply(ctx: Context): void {
  const registry = ctx.skills as RoutedSkillRegistry
  if (registry[skillRouterKey] !== undefined) throw new Error('Team skill routing is already mounted in this registry')
  let router!: TeamSkillRouter
  registry.registerProvider(control => {
    router = new TeamSkillRouter(control)
    return router
  })
  Object.defineProperty(registry, skillRouterKey, { configurable: true, value: router })
  ctx.effect(() => () => {
    if (registry[skillRouterKey] === router) Reflect.deleteProperty(registry, skillRouterKey)
    router.dispose()
  }, 'agent-team.skill-router')
}

/** Handle to one mounted Agent skill provider: the selection swap and the disposer. */
export interface MemberSkillProviderMount {
  /** Swaps the live selection filter and drops cached catalogs; `undefined` loads every discovered skill. */
  readonly swap: (allow: readonly string[] | undefined) => void
  /** Unregister the provider. */
  readonly dispose: () => void
}

/** Per-Agent provider configuration; the private directory is provisioned before mounting. */
export interface MemberSkillsConfig {
  /** The Agent's private skills directory; the writable self-install root. */
  readonly skillsDirectory: string
  /** Read-only bundled skills shipped with the plugin for this Team role. */
  readonly bundledSkillsDirectory: string | undefined
  /** The selection this Agent's provider starts with; `undefined` loads every discovered skill. */
  readonly initialSelection: readonly string[] | undefined
}

/**
 * Mount one Agent's private roots behind its preset router. No Team preset router
 * means no private catalog; in particular, do not fall back to the Host registry.
 */
export function mountMemberSkillProvider(agentCtx: Context, config: MemberSkillsConfig): MemberSkillProviderMount | undefined {
  const registry = agentCtx.get('agentPresets')?.serviceFor({ ctx: agentCtx }, 'skills') as RoutedSkillRegistry | undefined
  return registry?.[skillRouterKey]?.mount(agentCtx, config)
}

interface MountedPrivateSkills {
  readonly provider: MemberPrivateSkillProvider
  readonly lifecycle: AbortController
}

interface RoutedSkillLocator {
  readonly candidate: SkillCandidate
}

/** One isolated registry provider that forwards to the exact viewing Agent. */
class TeamSkillRouter implements SkillProvider {
  readonly name = 'agent-team-private'
  private readonly mounted = new Map<Context, MountedPrivateSkills>()

  constructor(private readonly control: SkillProviderControl) {}

  mount(agentCtx: Context, config: MemberSkillsConfig): MemberSkillProviderMount {
    this.unmount(agentCtx)
    const lifecycle = new AbortController()
    const provider = new MemberPrivateSkillProvider(agentCtx, {
      signal: lifecycle.signal,
      invalidate: this.control.invalidate,
    }, config)
    const mounted = { provider, lifecycle }
    this.mounted.set(agentCtx, mounted)
    this.control.invalidate()
    return {
      swap: allow => {
        if (this.mounted.get(agentCtx) === mounted) provider.select(allow)
      },
      dispose: () => this.unmount(agentCtx, mounted),
    }
  }

  async list(options: Parameters<SkillProvider['list']>[0]): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    const provider = this.providerFor(options)
    if (provider === undefined) return []
    const output = await provider.list(options)
    if (!('candidates' in output)) return output.map(candidate => this.route(candidate))
    return { candidates: output.candidates.map(candidate => this.route(candidate)), complete: output.complete }
  }

  async get(candidate: SkillCandidate, options: Parameters<SkillProvider['get']>[1]): Promise<Awaited<ReturnType<SkillProvider['get']>>> {
    const provider = this.providerFor(options)
    const original = (candidate.locator as RoutedSkillLocator).candidate
    if (provider === undefined || original.provider !== provider.name) return undefined
    return provider.get(original, options)
  }

  private route(candidate: SkillCandidate): SkillCandidate {
    return { ...candidate, provider: this.name, locator: { candidate } satisfies RoutedSkillLocator }
  }

  dispose(): void {
    for (const agentCtx of this.mounted.keys()) this.unmount(agentCtx)
  }

  private providerFor(options: Parameters<SkillProvider['list']>[0]): MemberPrivateSkillProvider | undefined {
    const scope = (options as SkillViewOptions).scope as { readonly ctx?: Context } | undefined
    return scope?.ctx === undefined ? undefined : this.mounted.get(scope.ctx)?.provider
  }

  private unmount(agentCtx: Context, expected?: MountedPrivateSkills): void {
    const mounted = this.mounted.get(agentCtx)
    if (mounted === undefined || expected !== undefined && mounted !== expected) return
    this.mounted.delete(agentCtx)
    mounted.lifecycle.abort(new Error(`Team skill provider "${mounted.provider.name}" disposed`))
    this.control.invalidate()
  }
}

/** One Agent's bundled-plus-private skill roots wrapped as a filtered provider. */
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
    // Bundled read-only core skills first, then the Agent's private directory; both share the custom rank and discovery keeps the first root's same-name candidate, so bundled skills stay stable across upgrades.
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

  /** Filters the wrapped discovery to the Agent's selection. `list()` output only: the directory is still scanned and watched, so this is not a security boundary. */
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
