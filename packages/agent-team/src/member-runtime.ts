/**
 * Per-Member runtime state split out of the Host service: the maps and methods that must dispose together across activation, edit, suspend, and removal (tool-policy restriction, private skill mounts, capability warnings, private-memory provisioning). Host-side by design: the turn-boundary wait subscribes to Host-level agent events. The service keeps orchestration (ledger, handles, notifications, recovery).
 * @module @contexera/dsh-agent-team/member-runtime
 */

import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {
  AgentTeamAgentMember,
  AgentTeamCapabilityWarning,
  AgentTeamMemberCapabilities,
  AgentTeamMemberId,
} from './types.ts'
import * as memberSkills from './member-skills.ts'
import type { MemberSkillProviderMount } from './member-skills.ts'

/** Result of waiting for a turn boundary: `waited` if a running turn had to finish first, `idle` if the Member was already between turns. */
export type TurnBoundary = 'waited' | 'idle'

/** Read-only core skills shipped beside the preset (meta skill first: its description routes skill-management work to itself), resolved from this module's emitted location so it follows the installed plugin. */
const BUNDLED_SKILLS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '../core-skills')

/** Model-facing capabilities every Team-enabled preset must publish. */
export const AGENT_TEAM_TOOL_NAMES = Object.freeze([
  'team_inbox',
  'team_thread',
  'team_attention',
  'team_message',
  'team_dm',
  'team_claim',
  'team_view',
] as const)

/** Copy a Remote-supplied capability overlay into owned frozen storage. */
export function deepCopyCapabilities(capabilities: AgentTeamMemberCapabilities): AgentTeamMemberCapabilities {
  const copyAllow = (allow: readonly string[] | undefined): { allow?: readonly string[] } =>
    allow === undefined ? {} : { allow: [...allow] }
  return {
    ...(capabilities.tools === undefined ? {} : { tools: copyAllow(capabilities.tools.allow) }),
    ...(capabilities.skills === undefined ? {} : { skills: copyAllow(capabilities.skills.allow) }),
  }
}

/** Directory segment for a Member's private memory. The `member:<uuid>` ref must never appear in a path: Windows rejects `:` in a path segment (NTFS reads it as an Alternate Data Stream separator). */
export function memberMemoryDirectoryName(memberId: AgentTeamMemberId): string {
  return memberId.replaceAll(':', '-')
}

/** The sanitized absolute private-memory path for one Member, regardless of what the ledger recorded. */
export function memberMemoryDirectoryPath(member: Pick<AgentTeamAgentMember, 'memberId' | 'privateMemoryPath'>): string {
  // Only the recorded final segment can carry the ledger's member-identity colon, so only it is rewritten. A Windows drive-letter colon is not an identity and must survive: a colon-free final segment keeps the recorded path verbatim.
  const separator = Math.max(member.privateMemoryPath.lastIndexOf('/'), member.privateMemoryPath.lastIndexOf('\\'))
  const finalSegment = separator === -1 ? member.privateMemoryPath : member.privateMemoryPath.slice(separator + 1)
  if (!finalSegment.includes(':')) return member.privateMemoryPath
  const prefix = separator === -1 ? '' : member.privateMemoryPath.slice(0, separator + 1)
  return prefix + memberMemoryDirectoryName(member.memberId)
}

/** Everything the runtime needs from its owning Host service. */
export interface MemberRuntimeDeps {
  /** Host context for agent events, tool schemas, and the workspace registry. */
  readonly ctx: Context
  /** Resolve one Member's live agent context, or throw when it has none. */
  readonly liveMemberContext: (memberId: AgentTeamMemberId) => Context
  /** Agent ids with a turn in flight; shared by reference with the service. */
  readonly runningAgents: ReadonlySet<SessionId>
}

/** Per-Member runtime state: every map here is keyed by Member and released together with that Member. */
export class MemberRuntime {
  /** Per-Member tool restriction disposers: activation registers, disposal releases, edits swap at a turn boundary. */
  private readonly memberRestrictions = new Map<AgentTeamMemberId, () => void>()
  /** The allow-list enforced behind `memberRestrictions`: the rollback source when a swap fails, so a failed apply never leaves the Member less restricted. */
  private readonly enforcedToolAllow = new Map<AgentTeamMemberId, readonly string[]>()
  private readonly memberToolBindings = new Map<AgentTeamMemberId, ReadonlyMap<string, ToolDefinition>>()
  /** Capability intent the live surface is known to reflect: presence is the proof, a stored `undefined` means applied with no capabilities. Never persisted; absent when unprovable, so an unknown surface re-applies. */
  private readonly appliedCapabilities = new Map<AgentTeamMemberId, AgentTeamMemberCapabilities | undefined>()
  /** Capability warnings, recomputed at every activation and never persisted: stored ones would lie after a Host restart or a Harness upgrade that renames tools. */
  private readonly capabilityWarnings = new Map<AgentTeamMemberId, readonly AgentTeamCapabilityWarning[]>()
  /** Per-Member skill provider mounts. One entry holds the selection swap and the disposer, so a catalog re-filter and the unmount never disagree about which provider is live. */
  private readonly skillProviderMounts = new Map<AgentTeamMemberId, MemberSkillProviderMount>()

  constructor(private readonly deps: MemberRuntimeDeps) {}

  /** One Member's live capability warnings, if any; runtime-derived, never persisted. */
  capabilityWarningsFor(memberId: AgentTeamMemberId): readonly AgentTeamCapabilityWarning[] | undefined {
    return this.capabilityWarnings.get(memberId)
  }

  /** Restrict every Member to its preset tools; a stored allow-list can only narrow them, retaining Team tools and `working_directory`. */
  applyMemberToolPolicy(agentCtx: Context, member: AgentTeamAgentMember): void {
    const bindings = this.memberToolBindings.get(member.memberId) ?? this.mountMemberToolBindings(agentCtx, member.memberId)
    const configured = member.capabilities?.tools?.allow
    // Drop unknown names instead of failing activation: a Harness upgrade renaming a tool must not make the Member unavailable. The warning carries the known-name digest for diagnosing drift.
    const known = [...bindings.keys()]
    const knownSet = new Set(known)
    const dropped = (configured ?? []).filter(name => !knownSet.has(name))
    this.setCapabilityWarnings(member.memberId, dropped.map(name => ({ name, knownNames: known })))
    const allow = [...new Set([
      ...(configured ?? known).filter(name => knownSet.has(name)),
      ...AGENT_TEAM_TOOL_NAMES,
      // An allow-list narrows capability, not the checkout the Member works in, so `working_directory` survives like the Team tools.
      ...knownSet.has('working_directory') ? ['working_directory'] : [],
    ])]
    // `tools.restrict()` requires a scoped context and rejects names outside the inherited surface; either error fails only this Member's activation.
    const dispose = agentCtx.tools.restrict({ allow })
    this.memberRestrictions.set(member.memberId, dispose)
    this.enforcedToolAllow.set(member.memberId, Object.freeze([...allow]))
  }

  private mountMemberToolBindings(agentCtx: Context, memberId: AgentTeamMemberId): ReadonlyMap<string, ToolDefinition> {
    const scope = scopeOf(agentCtx)
    const presetScope = scope === undefined ? undefined : scopeParentOf(scope)
    if (presetScope === undefined) throw new Error('Member tool policy requires a mounted preset scope')
    const tools = this.deps.ctx.tools
    const bindings = new Map<string, ToolDefinition>()
    for (const { name } of tools.schemas(presetScope)) {
      const definition = tools.get(name, presetScope)
      // The preset view also inherits Host tools. Only its own definitions and
      // the explicitly shared directory tool belong to the Member's baseline.
      if (definition !== undefined && (name === 'working_directory' || definition !== tools.get(name))) {
        bindings.set(name, definition)
      }
    }
    this.memberToolBindings.set(memberId, bindings)
    agentCtx.tools.guard(execution => {
      if (execution.agent !== scope) return undefined
      if (!this.enforcedToolAllow.get(memberId)?.includes(execution.name)) {
        return `Tool "${execution.name}" is not declared for this Team Member`
      }
      if (tools.get(execution.name, scope) !== bindings.get(execution.name)) {
        return `Team Member tool replaced: ${execution.name}`
      }
      return undefined
    })
    agentCtx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.scope !== scope) return next()
      const assembly = await next()
      const allow = new Set(this.enforcedToolAllow.get(memberId))
      for (const name of allow) {
        if (tools.get(name, scope) !== bindings.get(name)) throw new Error(`Team Member tool replaced: ${name}`)
      }
      const schemas = new Map(tools.schemas(scope).map(schema => [schema.name, schema]))
      return {
        ...assembly,
        tools: assembly.tools.filter(schema => allow.has(schema.name)).map(schema => {
          const declared = schemas.get(schema.name)
          if (declared === undefined) throw new Error(`Team Member tool unavailable: ${schema.name}`)
          return declared
        }),
      }
    })
    return bindings
  }

  /** Whether the live surface is known to reflect exactly this capability intent; an absent record never matches. */
  appliedCapabilitiesMatch(memberId: AgentTeamMemberId, capabilities: AgentTeamMemberCapabilities | undefined): boolean {
    if (!this.appliedCapabilities.has(memberId)) return false
    return isDeepStrictEqual(this.appliedCapabilities.get(memberId), capabilities)
  }

  /** Record the capability intent the live surface now reflects; callers invoke it only after every effect of the apply succeeded. */
  recordAppliedCapabilities(memberId: AgentTeamMemberId, capabilities: AgentTeamMemberCapabilities | undefined): void {
    this.appliedCapabilities.set(memberId, capabilities)
  }

  /** Swaps a live Member's tool policy at a turn boundary: disposes the old restriction, applies the new one, and on failure restores the previous allow-list before rethrowing. */
  reapplyMemberToolPolicy(member: AgentTeamAgentMember): void {
    const agentCtx = this.deps.liveMemberContext(member.memberId)
    const previousAllow = this.enforcedToolAllow.get(member.memberId)
    this.releaseMemberToolPolicy(member.memberId)
    try {
      this.applyMemberToolPolicy(agentCtx, member)
    } catch (error) {
      if (previousAllow !== undefined) this.restoreEnforcedToolAllow(member, agentCtx, previousAllow)
      throw error
    }
  }

  /** Puts the previous allow-list back after a failed swap. Warnings are deliberately not restored: they describe the stored configuration's divergence, and the accepted edit is stored even though its apply failed. If the failure precedes derivation (schemas throws), warnings stay empty; the next apply or activation re-derives them. */
  private restoreEnforcedToolAllow(member: AgentTeamAgentMember, agentCtx: Context, previousAllow: readonly string[]): void {
    try {
      const dispose = agentCtx.tools.restrict({ allow: [...previousAllow] })
      this.memberRestrictions.set(member.memberId, dispose)
      this.enforcedToolAllow.set(member.memberId, previousAllow)
    } catch (restore) {
      this.deps.ctx.logger.warn(`agent-team: failed to restore the previous tool restriction for member '${member.memberId}' after a failed apply: ${restore instanceof Error ? restore.message : String(restore)}`)
    }
  }

  /** Release one Member's restriction disposer and warning state; safe to call twice. */
  releaseMemberToolPolicy(memberId: AgentTeamMemberId): void {
    const dispose = this.memberRestrictions.get(memberId)
    if (dispose !== undefined) {
      this.memberRestrictions.delete(memberId)
      dispose()
    }
    this.enforcedToolAllow.delete(memberId)
    this.capabilityWarnings.delete(memberId)
    this.appliedCapabilities.delete(memberId)
  }

  private setCapabilityWarnings(memberId: AgentTeamMemberId, warnings: readonly AgentTeamCapabilityWarning[]): void {
    if (warnings.length === 0) this.capabilityWarnings.delete(memberId)
    else this.capabilityWarnings.set(memberId, Object.freeze([...warnings]))
  }

  /** Outstanding boundary waits, held so Host shutdown can release them all. */
  private readonly turnWaitResolvers = new Set<() => void>()

  /** Waits until a live Member's current turn ends or its Session is disposed; returns whether a running turn had to be awaited. The running turn keeps its schemas and catalog; the swap happens once idle so the next step sees the new restriction and skill selection on the same Session. Suspend/remove resolves the wait (the disposed handle already released the restriction); Host shutdown resolves every wait through `releaseTurnWaits`. */
  async awaitTurnBoundary(active: AgentHandle): Promise<TurnBoundary> {
    if (!this.deps.runningAgents.has(active.agent.id)) return 'idle'
    await new Promise<void>(resolve => {
      const disposers: Array<() => void> = []
      const settle = (): void => {
        this.turnWaitResolvers.delete(settle)
        for (const dispose of disposers.splice(0)) dispose()
        resolve()
      }
      this.turnWaitResolvers.add(settle)
      disposers.push(
        this.deps.ctx.on('agent/status', (payload: { agent: Agent; status: string }) => {
          if (payload.agent !== active.agent) return
          // A turn ending, cleanly or by error, is the boundary.
          if (payload.status !== 'running') settle()
        }),
        // Disposal resolves the wait: the restriction went with the disposed scope, leaving only the ledger intent for the next activation.
        this.deps.ctx.on('session/disposed', (session: { id: SessionId }) => {
          if (session.id === active.agent.session.id) settle()
        }),
      )
    })
    return 'waited'
  }

  /** Host-shutdown exit: resolves every boundary wait so the Member's lifecycle chain drains; `settle` removes each wait's listeners, so nothing survives shutdown. */
  releaseTurnWaits(): void {
    // Snapshot: every `settle` removes its own entry from the set.
    for (const settle of Array.from(this.turnWaitResolvers)) settle()
  }

  /** Registers the Member-private skill provider on the created agent's exact scope layer (the traceable-service seam, like the tool restriction): bundled core skills plus the Member's private directory. Without a skill registry nothing is registered. The sanitized directory is authoritative; activateMember migrates any legacy colon directory onto it first. */
  mountMemberSkillProvider(
    member: AgentTeamAgentMember,
    agentCtx: Context,
    initialSelection: readonly string[] | undefined,
  ): void {
    const mount = memberSkills.mountMemberSkillProvider(agentCtx, {
      skillsDirectory: join(memberMemoryDirectoryPath(member), 'skills'),
      bundledSkillsDirectory: BUNDLED_SKILLS_DIRECTORY,
      initialSelection,
    })
    if (mount === undefined) return
    this.skillProviderMounts.set(member.memberId, mount)
  }

  /** Live-apply a capability edit to a mounted provider; a no-op when this Member has none. */
  swapSkillSelection(memberId: AgentTeamMemberId, allow: readonly string[] | undefined): void {
    this.skillProviderMounts.get(memberId)?.swap(allow)
  }

  /**
   * Provisions a Member's private memory namespace: notes/, skills/, and a first-run memory.md scaffold. The per-Member skill provider scans exactly this root.
   *
   * `privateMemoryPath` is a durable Member fact that cannot be rewritten, so a legacy colon directory recorded in the ledger is renamed onto the sanitized path once (same-parent, atomic) rather than orphaning existing memory. A recorded path in a different DSH home is never acted on (see `migrateLegacyMemoryDirectory`).
   *
   * A colon-form twin directory is merged too: the branded `member:<uuid>` ref shown by every Team tool result leads Members to hand-assemble colon paths, which Linux accepts silently (two directories for one Member) and Windows rejects. `memory.md` cannot merge, so the sanitized copy wins and twin-only notes/skills move in without overwriting.
   */
  async initializePrivateMemory(path: string, legacyPath?: string): Promise<void> {
    if (legacyPath !== undefined && legacyPath !== path) {
      const migration = await migrateLegacyMemoryDirectory(legacyPath, path)
            // A refusal means the record names a directory in another DSH home: provision fresh here rather than take that directory out of its home.
      if (migration === 'refused-foreign-home') this.deps.ctx.logger.warn(`agent-team: refused to migrate the recorded Member private memory '${legacyPath}' into '${path}': they are not in the same directory, so the recorded directory names a different DSH home and is left untouched`)
    }
    const twinPath = twinMemoryDirectoryPath(path)
    if (twinPath !== undefined) await mergeTwinMemoryDirectory(twinPath, path)
    await mkdir(join(path, 'notes'), { recursive: true })
    await mkdir(join(path, 'skills'), { recursive: true })
    try {
      await writeFile(join(path, 'memory.md'), '# Member memory\n\nBounded routing index. Writing, compaction, and demotion rules: the bundled `member-memory-manager` skill.\n\n## Identity and role\n- <scope>\n\n## Durable rules\n- <rule>\n\n## In hand\n- <work in hand>\n\n## Notes index\n- <cluster>: `notes/<cluster>/README.md`\n', { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  /** Irreversibly remove one Member: archive its Session and delete its private namespace. */
  async cleanupRemovedMember(member: AgentTeamAgentMember): Promise<void> {
        // The ledger path may still name the legacy colon directory: remove both spellings (rm tolerates the missing one). Every target must sit inside this process's members root: the recorded path is a durable absolute fact, and a process resolving another DSH home would otherwise delete the real Member's private memory.
    const sanitized = memberMemoryDirectoryPath(member)
    const targets = sanitized === member.privateMemoryPath ? [sanitized] : [sanitized, member.privateMemoryPath]
    const owned = targets.filter(target => isInsideMembersRoot(target))
    const refused = targets.filter(target => !isInsideMembersRoot(target))
    if (refused.length > 0) this.deps.ctx.logger.warn(`agent-team: refused to delete recorded Member private memory outside this DSH home: ${refused.map(target => `'${target}'`).join(', ')}`)
    const results = await Promise.allSettled([
      this.deps.ctx.workspaceRegistry.archiveSession(member.sessionId),
      ...owned.map(target => rm(target, { recursive: true, force: true })),
    ])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, `failed to clean up removed Member '${member.memberId}'`)
  }

  /** Drop one Member's transient selection/disposer state after its handle is gone; safe to call twice. */
  forgetMember(memberId: AgentTeamMemberId): void {
    const mount = this.skillProviderMounts.get(memberId)
    if (mount !== undefined) {
      this.skillProviderMounts.delete(memberId)
      mount.dispose()
    }
    this.releaseMemberToolPolicy(memberId)
    this.memberToolBindings.delete(memberId)
  }

    /** Every Member id any per-Member map holds, so a release path cannot miss one only a single map knows. */
  private trackedMemberIds(): readonly AgentTeamMemberId[] {
    return [...new Set([
      ...this.memberRestrictions.keys(),
      ...this.enforcedToolAllow.keys(),
      ...this.memberToolBindings.keys(),
      ...this.appliedCapabilities.keys(),
      ...this.capabilityWarnings.keys(),
      ...this.skillProviderMounts.keys(),
    ])]
  }

  /** Dispose every registered per-Member seam; service shutdown only. */
  disposeAll(): void {
    for (const memberId of this.trackedMemberIds()) this.forgetMember(memberId)
  }
}

/**
 * One-time in-place migration of a colon-named private memory directory onto its sanitized path. An existing sanitized target wins (idempotent across restarts); a missing legacy source is the fresh-install case.
 *
 * The rename is confined to one parent directory: a process resolving a different DSH home (isolated test home, second instance) holds a sanitized target in its own tree while the record names the real one, and renaming across trees would silently take a Member's private memory out of its home. Such a source is left in place and only that refusal is reported.
 */
async function migrateLegacyMemoryDirectory(legacyPath: string, path: string): Promise<'refused-foreign-home' | undefined> {
  let legacy: Awaited<ReturnType<typeof stat>>
  try {
    legacy = await stat(legacyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!legacy.isDirectory()) throw new Error(`legacy Member memory path '${legacyPath}' exists but is not a directory`)
  if (dirname(legacyPath) !== dirname(path)) return 'refused-foreign-home'
  try {
    await stat(path)
    return undefined // Sanitized directory already present: migration already done or a new install.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await rename(legacyPath, path)
  return undefined
}

/** Whether an absolute path names a Member directory inside this process's members root; only such a path is this process's to delete. */
function isInsideMembersRoot(candidate: string): boolean {
  const fromRoot = relative(dshHomePath('agent-team', 'members'), resolve(candidate))
  // '' is the members root itself and '..' escapes it: only a real descendant is authorized.
  return fromRoot.length > 0 && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
}

/** The colon-form twin path of one sanitized Member memory directory, when the segment form admits one. */
function twinMemoryDirectoryPath(sanitizedPath: string): string | undefined {
  const separator = Math.max(sanitizedPath.lastIndexOf('/'), sanitizedPath.lastIndexOf('\\'))
  const prefix = separator === -1 ? '' : sanitizedPath.slice(0, separator + 1)
  const finalSegment = separator === -1 ? sanitizedPath : sanitizedPath.slice(separator + 1)
    // Only the exact sanitized identity segment (`member-<uuid>`) has a colon twin (`member:<uuid>`).
  if (!/^member-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(finalSegment)) return undefined
  return `${prefix}member:${finalSegment.slice('member-'.length)}`
}

/** The colon-twin trace name for one conflicting file: `note.md` → `note.colon-twin.md`. */
function colonTwinTraceName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? `${name}.colon-twin` : `${name.slice(0, dot)}.colon-twin${name.slice(dot)}`
}

/** Merges a hand-created colon-form twin into the sanitized Member memory directory. Unlike the legacy migration this is a merge: the sanitized directory is the live root, so on conflict its copy wins and the twin's copy is kept beside it under a `.colon-twin` name. Twin-only files move in under their own names, then the emptied twin is removed. */
async function mergeTwinMemoryDirectory(twinPath: string, path: string): Promise<void> {
  let twin: Awaited<ReturnType<typeof stat>>
  try {
    twin = await stat(twinPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return
  }
  if (!twin.isDirectory()) return
  await mergeDirectoryContents(twinPath, path)
  await rm(twinPath, { recursive: true, force: true })
}

/** Recursively move every twin file into the live root; an existing live file wins, its twin copy traced beside it. */
async function mergeDirectoryContents(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (entry.isDirectory()) {
      await mergeDirectoryContents(sourcePath, targetPath)
    } else if (entry.isFile()) {
            // rename(2) silently replaces an existing target on POSIX (EEXIST exists only on Windows, where the twin cannot exist), so probe first. Activation is the single serialized writer, so the probe-to-rename window has no race.
      let liveFilePresent = true
      try {
        await stat(targetPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        liveFilePresent = false
      }
            // The live root stays authoritative; the twin's losing copy stays traceable beside it.
      await rename(sourcePath, liveFilePresent ? join(target, colonTwinTraceName(entry.name)) : targetPath)
    }
  }
}
